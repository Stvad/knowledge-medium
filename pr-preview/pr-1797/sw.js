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
		buildId: "c62996ae7cd0-e5a1865d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1797/\":\"84f96a190ca2febc\",\"/knowledge-medium/pr-preview/pr-1797/index.html\":\"84f96a190ca2febc\",\"/knowledge-medium/pr-preview/pr-1797/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1797/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1797/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1797/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1797/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1797/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1797/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1797/assets/FacadeVFS-BYGRmRKn.js\":\"8878b1b989703c48\",\"/knowledge-medium/pr-preview/pr-1797/assets/OPFSCoopSyncVFS-CRu4zSFb.js\":\"119d49e065b0f43c\",\"/knowledge-medium/pr-preview/pr-1797/assets/OPFSWriteAheadVFS-DQBX_2wD.js\":\"8cbb37c9752c5c25\",\"/knowledge-medium/pr-preview/pr-1797/assets/wa-sqlite-CE5SB71b.js\":\"46d662971f972681\",\"/knowledge-medium/pr-preview/pr-1797/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1797/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1797/assets/wa-sqlite-async-ekIxmZlx.js\":\"50861e9aebbddeda\",\"/knowledge-medium/pr-preview/pr-1797/assets/worker-nFzYTQDV.js\":\"4ba7a800bd636564\",\"/knowledge-medium/pr-preview/pr-1797/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1797/chunks/app-CE-MaSO-.js\":\"fe69318bca605ee6\",\"/knowledge-medium/pr-preview/pr-1797/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1797/index.js\":\"98ed9ea6c3bab53b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1797/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1797/assets/AccessHandlePoolVFS-MCXit50w.js\":\"d2d88a24f8bb7adc\",\"/knowledge-medium/pr-preview/pr-1797/assets/IDBBatchAtomicVFS-gZJyYWnD.js\":\"0fd39c9300baece8\",\"/knowledge-medium/pr-preview/pr-1797/assets/MemoryVFS-Bv7K6CEM.js\":\"c96474d72679e668\",\"/knowledge-medium/pr-preview/pr-1797/assets/mc-wa-sqlite-CHL0mPNg.js\":\"67d2803e79d27571\",\"/knowledge-medium/pr-preview/pr-1797/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1797/assets/mc-wa-sqlite-async-Byqc6seM.js\":\"e161dfeb062660a1\",\"/knowledge-medium/pr-preview/pr-1797/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1797/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1797/chunks/AccessHandlePoolVFS-CZPby1hn.js\":\"e3204f120ed9dd44\",\"/knowledge-medium/pr-preview/pr-1797/chunks/FacadeVFS-BVypFCAu.js\":\"4ce31e7e32ae21cf\",\"/knowledge-medium/pr-preview/pr-1797/chunks/IDBBatchAtomicVFS-Ct21HAVV.js\":\"345bc44f6d173c50\",\"/knowledge-medium/pr-preview/pr-1797/chunks/MemoryVFS-DbBrMqRe.js\":\"0e8657718eb7a39e\",\"/knowledge-medium/pr-preview/pr-1797/chunks/OPFSCoopSyncVFS-Chu2Xl7y.js\":\"c18a1bd00deca31f\",\"/knowledge-medium/pr-preview/pr-1797/chunks/OPFSWriteAheadVFS-Du7oHV-J.js\":\"5502a136f9fbf897\",\"/knowledge-medium/pr-preview/pr-1797/chunks/Preview-CrsUnYXO.js\":\"c3df1933ed43df44\",\"/knowledge-medium/pr-preview/pr-1797/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1797/chunks/card-BQr2nD1B.js\":\"669738e6159487bf\",\"/knowledge-medium/pr-preview/pr-1797/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1797/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1797/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1797/chunks/dist-D2IrHGUB.js\":\"fd4e066065e23870\",\"/knowledge-medium/pr-preview/pr-1797/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1797/chunks/mc-wa-sqlite-DHyyEYMI.js\":\"61c019e73660e97c\",\"/knowledge-medium/pr-preview/pr-1797/chunks/mc-wa-sqlite-async-BS5cY8NA.js\":\"81cc944c4c0b26f3\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-BOJs0cMW.js\":\"cbc673f7e331da54\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-BycQFhh4.js\":\"745760f8a6ff4790\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-C3ohgJe3.js\":\"2fe2ca9475df2c59\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-CFQvuXLk.js\":\"4615707ca574d51c\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-CHBwzU61.js\":\"59b78ae877cd3cb0\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-CpzUMt5e.js\":\"4bab6b7205a9c200\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-EQbzlrFU.js\":\"d90d1d053fc0b387\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-YU4FLKUS.js\":\"37442b90bc81eea8\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-dom-server-legacy.browser.production-DfqJ8k_i.js\":\"304d7ac91da2064e\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-dom-server.browser.production-cvFFr6bf.js\":\"6c506478db02e1ff\",\"/knowledge-medium/pr-preview/pr-1797/chunks/react-dom-server.edge.production-VqG8dyf7.js\":\"a28de39880e7bd35\",\"/knowledge-medium/pr-preview/pr-1797/chunks/server.browser-CZVuw0dx.js\":\"59171480c03bb267\",\"/knowledge-medium/pr-preview/pr-1797/chunks/textarea-Di7wSnaO.js\":\"84561bfaa3ffaa7f\",\"/knowledge-medium/pr-preview/pr-1797/chunks/ui-j7z7nn_D.js\":\"14570675265a95fd\",\"/knowledge-medium/pr-preview/pr-1797/chunks/wa-sqlite-CGuEPHY9.js\":\"a5b8d872cf9a245c\",\"/knowledge-medium/pr-preview/pr-1797/chunks/wa-sqlite-async-DvQC6ckB.js\":\"28eff19da0d23083\",\"/knowledge-medium/pr-preview/pr-1797/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1797/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1797/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1797/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1797/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1797/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1797/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1797/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1797/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1797/src/App.js\":\"6ca096c346862879\",\"/knowledge-medium/pr-preview/pr-1797/src/appUpdate.js\":\"8a4b82b09af414e3\",\"/knowledge-medium/pr-preview/pr-1797/src/appVersion.js\":\"56c002175f4dec65\",\"/knowledge-medium/pr-preview/pr-1797/src/bootstrap/initialLayout.js\":\"7d8f0bdddc7d2054\",\"/knowledge-medium/pr-preview/pr-1797/src/bootstrap/openWorkspaceData.js\":\"a6a7c85416a22a88\",\"/knowledge-medium/pr-preview/pr-1797/src/bootstrap/resolveWorkspace.js\":\"439f610af94366c3\",\"/knowledge-medium/pr-preview/pr-1797/src/bootstrap/workspaceBootstrap.js\":\"2781ff43ebf61568\",\"/knowledge-medium/pr-preview/pr-1797/src/components/BlockComponent.js\":\"f26a98587c8f117c\",\"/knowledge-medium/pr-preview/pr-1797/src/components/BlockCrumbs.js\":\"ba7d1c4678256475\",\"/knowledge-medium/pr-preview/pr-1797/src/components/BlockEditor.js\":\"71b2a89c886ccdb2\",\"/knowledge-medium/pr-preview/pr-1797/src/components/BlockLoadingPlaceholder.js\":\"e1a7fc5a9bf2d6a5\",\"/knowledge-medium/pr-preview/pr-1797/src/components/BlockProperties.js\":\"af362e51c7d78cd4\",\"/knowledge-medium/pr-preview/pr-1797/src/components/BlockSearchPicker.js\":\"c1d041195cfef7f3\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ConfirmBulkDeleteDialog.js\":\"bee138042e68fc18\",\"/knowledge-medium/pr-preview/pr-1797/src/components/DividerHandle.js\":\"7b1fcd018811f0e9\",\"/knowledge-medium/pr-preview/pr-1797/src/components/DraftEditor.js\":\"6b54e6b5f2ede2c1\",\"/knowledge-medium/pr-preview/pr-1797/src/components/GutterPill.js\":\"b4cd999a159c4945\",\"/knowledge-medium/pr-preview/pr-1797/src/components/Header.js\":\"887927bf19bd4789\",\"/knowledge-medium/pr-preview/pr-1797/src/components/LazyBlockComponent.js\":\"ac50e56bab43b708\",\"/knowledge-medium/pr-preview/pr-1797/src/components/Login.js\":\"e7c24993db8a35b2\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ZoomableSurface.js\":\"33ed26a247ac2a1a\",\"/knowledge-medium/pr-preview/pr-1797/src/components/editModeKeepalive.js\":\"d39ba7ecbf7bd9d7\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyDisplay/PropertyDisplayScope.js\":\"af855641f2d72345\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"18bda904ddab25b8\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyEditors/RefPropertyEditor.js\":\"b67a04f0989993be\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyEditors/RefTargetTypePicker.js\":\"c66892c52864d7c1\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyEditors/SelectPropertyEditor.js\":\"8cc25fe9c606dbbb\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyEditors/TypesPropertyEditor.js\":\"bdf4dec26c443dd8\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyEditors/defaults.js\":\"754840480858d459\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyEditors/kernelValuePresets.js\":\"1eff75a39eadc1e3\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyEditors/selectablePresets.js\":\"cde9354314fea07b\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyEditors/typesPropertyUi.js\":\"963d9c118f2303b3\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/AddPropertyForm.js\":\"7dca84521a82ecf5\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/PropertyPicker.js\":\"74cf1d746ada4983\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/PropertyRow.js\":\"b3f6369c9cbd7ffc\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/Rows.js\":\"97d3657a6e0aabcc\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/actions.js\":\"cc9ccdfd6dfe6713\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/declarationOnly.js\":\"f083ddacddd219e4\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/layout.js\":\"01963a72831080a8\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/model.js\":\"2708fe0f63921fdb\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/shapeUi.js\":\"cb0eabc21faef3a1\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/shapes.js\":\"076c9c4b1d44ed1f\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4280d5827f1bb065\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanel/visibility.js\":\"5f7f8e52518546db\",\"/knowledge-medium/pr-preview/pr-1797/src/components/propertyPanelSections.js\":\"be79e0f823014a7d\",\"/knowledge-medium/pr-preview/pr-1797/src/components/references/BlockEmbed.js\":\"234af024ccd25ea4\",\"/knowledge-medium/pr-preview/pr-1797/src/components/references/BlockLink.js\":\"c1d540de4d3a049d\",\"/knowledge-medium/pr-preview/pr-1797/src/components/references/BlockRef.js\":\"aec7f495e5bc331b\",\"/knowledge-medium/pr-preview/pr-1797/src/components/references/ReferenceLink.js\":\"0fd5751b80c89bec\",\"/knowledge-medium/pr-preview/pr-1797/src/components/references/cycleGuard.js\":\"dd45b1079fce19a2\",\"/knowledge-medium/pr-preview/pr-1797/src/components/references/cycleGuardContext.js\":\"abf2c4f06beda308\",\"/knowledge-medium/pr-preview/pr-1797/src/components/references/linkInteraction.js\":\"b7a9d1558193c120\",\"/knowledge-medium/pr-preview/pr-1797/src/components/references/referenceLayout.js\":\"513fd63560743a63\",\"/knowledge-medium/pr-preview/pr-1797/src/components/references/useBlockRefAncestors.js\":\"31ad5d47defc35cd\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/BlockGutter.js\":\"93aba412012910ec\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/BlockInfoDialog.js\":\"0ad2746f04ce197d\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/BlockTypeBlockRenderer.js\":\"e823625c369481cf\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/BulletHoverCard.js\":\"52ad85643f73df75\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/CodeMirrorContentRenderer.js\":\"f130fd47d0703385\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d23f2423a3c65081\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/ColumnResizeHandles.js\":\"ee93908ddb42286b\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"079b91cdf14c0dbc\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/DefaultBlockRenderer.js\":\"a779d951446e571e\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/LayoutRenderer.js\":\"a0349a3f1603bc27\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/MarkdownContentRenderer.js\":\"93bc64377008ab8c\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/MissingDataRenderer.js\":\"953c24c285828920\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/PanelRenderer.js\":\"dba38d813457abc7\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/PropertySchemaBlockRenderer.js\":\"743b438e28ebff1d\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/TopLevelRenderer.js\":\"e7fd56f2eca36329\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/blockGutterMode.js\":\"58b6a23b244a0e45\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/blockTitleText.js\":\"df9adfbf67ed8b6c\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/fieldCreationKeydown.js\":\"aa17eb6333ec4401\",\"/knowledge-medium/pr-preview/pr-1797/src/components/renderer/layoutRootContext.js\":\"b40d21f9368f118a\",\"/knowledge-medium/pr-preview/pr-1797/src/components/typeChip/TypeChip.js\":\"f3b575b258042f50\",\"/knowledge-medium/pr-preview/pr-1797/src/components/typeChip/chipStyle.js\":\"b3f38b27c1ad3d77\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/anchored-floating.js\":\"4f214ee578a2f903\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/button.js\":\"9454ca86f1e79950\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/card.js\":\"b3a9dfdd789e554e\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/checkbox.js\":\"c095e9b64579a0cd\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/collapsible.js\":\"24af0924103a7f06\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/command.js\":\"2cde54f2b926b89c\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/context-menu.js\":\"c4b8563efa0d92e1\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/dialog.js\":\"aa5808de7da191a2\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/dropdown-menu.js\":\"405f3016f7e2e2ba\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/floating-listbox.js\":\"e4ddc4d68e932b9e\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/index.js\":\"d18e3923600032b3\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/input.js\":\"6adfcd4723443b7b\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/kbd.js\":\"31cc97bb3bcfa248\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/label.js\":\"d8b459345f8dec77\",\"/knowledge-medium/pr-preview/pr-1797/src/components/ui/textarea.js\":\"296bf2322051d734\",\"/knowledge-medium/pr-preview/pr-1797/src/components/useEditModeYieldKeepalive.js\":\"3d60f65c431cc845\",\"/knowledge-medium/pr-preview/pr-1797/src/components/util/BootFallback.js\":\"15b07bf266b3ef84\",\"/knowledge-medium/pr-preview/pr-1797/src/components/util/FocusedRowLazyMount.js\":\"99757ab79758338c\",\"/knowledge-medium/pr-preview/pr-1797/src/components/util/LazyViewportMount.js\":\"57686d5b33aae58d\",\"/knowledge-medium/pr-preview/pr-1797/src/components/util/LocalDbCorruptionFallback.js\":\"bd167e6acbd33e42\",\"/knowledge-medium/pr-preview/pr-1797/src/components/util/error.js\":\"ca4a0095a1e6c7c5\",\"/knowledge-medium/pr-preview/pr-1797/src/components/util/lazyMountRegistry.js\":\"b8293f9be112897a\",\"/knowledge-medium/pr-preview/pr-1797/src/components/util/suspense.js\":\"82989a420439856a\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/CreateWorkspaceDialog.js\":\"de49a40fbb906536\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/PendingInvitations.js\":\"03040f7b5ed8fbe8\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/SyncProgress.js\":\"d5811d862842a078\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/UnlockProgress.js\":\"f0c6e9b733d1694e\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/WorkspaceKeyGate.js\":\"2534df8da8eb6c83\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/WorkspaceSettingsDialog.js\":\"1cb61ce1387943c0\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/WorkspaceSwitcher.js\":\"6b224b4bfa7878f0\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/WorkspaceSyncGate.js\":\"641368cb212f805d\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/conversion/ConversionFlow.js\":\"88567ed77a70dbb1\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/conversion/ConversionFlowHost.js\":\"ddd3623e9ffcffcc\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/conversion/EncryptionSection.js\":\"5cc3f0a38bb82744\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/conversion/attachmentPrompts.js\":\"b1a15e22ce34e6ad\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ebf3c427773d70d3\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/conversion/conversionFlowDeps.js\":\"7163d37554fa2dd3\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/conversion/conversionFlowStore.js\":\"edb10eee83ed7e24\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/conversion/flowUi.js\":\"4c80bfbad90729da\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/conversion/useConversionRun.js\":\"1ed8ea239192cbaf\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/keyUi.js\":\"ddf3fdec02cbb429\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/useCloseOnKeyLoss.js\":\"24d8419130adeed5\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/useCloseOnServerE2ee.js\":\"eb9fe29f91a11659\",\"/knowledge-medium/pr-preview/pr-1797/src/components/workspace/workspaceUnlocked.js\":\"21c620332b666c56\",\"/knowledge-medium/pr-preview/pr-1797/src/context/backgroundSubtree.js\":\"06d1f33ddb57aaaa\",\"/knowledge-medium/pr-preview/pr-1797/src/context/block.js\":\"e8d98f5cf3a4ac9a\",\"/knowledge-medium/pr-preview/pr-1797/src/context/layoutWsContext.js\":\"d131ae21c794b861\",\"/knowledge-medium/pr-preview/pr-1797/src/context/propertyDisplay.js\":\"f2df52c3d2cab9d2\",\"/knowledge-medium/pr-preview/pr-1797/src/context/repo.js\":\"4acdfa6b7079e5c6\",\"/knowledge-medium/pr-preview/pr-1797/src/data/aliasClaim.js\":\"c287c8daf0dcf445\",\"/knowledge-medium/pr-preview/pr-1797/src/data/aliasSeatNamespace.js\":\"3eafed7bd9df0421\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/blockData.js\":\"293a1e4c8c946e28\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/blockType.js\":\"28152d861f6d38f9\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/changeScope.js\":\"299f9f1694e842e0\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/codecs.js\":\"ba8e8752d6c3ec3f\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/derivedData.js\":\"7cb6247e745a206e\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/errors.js\":\"a7056706e2b56efe\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/events.js\":\"746bd2e6373d002d\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/handle.js\":\"3520c62c32c57cda\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/index.js\":\"f861c51edb5de1b4\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/mutator.js\":\"b88ba4575de3a393\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/processor.js\":\"7e2bfd72caa8f5dc\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/propertySchema.js\":\"340dca713fd75c4d\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/query.js\":\"2355e5750be4e608\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/sameTxProcessor.js\":\"05eb65021bc0fc3e\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/schema.js\":\"3520c62c32c57cda\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/tx.js\":\"3520c62c32c57cda\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/typedBlockQuery.js\":\"41a7a20d95d1c3d1\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/user.js\":\"506ac0d8863cfea1\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/valuePresetCore.js\":\"8ca59ce1b6d0dd50\",\"/knowledge-medium/pr-preview/pr-1797/src/data/api/valuePresets.js\":\"338a7f05446ba85c\",\"/knowledge-medium/pr-preview/pr-1797/src/data/attachmentCleanerIOVerb.js\":\"ac3b4918cf24128c\",\"/knowledge-medium/pr-preview/pr-1797/src/data/block.js\":\"41530b1a9e0b2f80\",\"/knowledge-medium/pr-preview/pr-1797/src/data/blockCache.js\":\"e107d724eb3b09fe\",\"/knowledge-medium/pr-preview/pr-1797/src/data/blockId.js\":\"72a9dc09ea258870\",\"/knowledge-medium/pr-preview/pr-1797/src/data/blockLiveness.js\":\"b4098941aca24fcb\",\"/knowledge-medium/pr-preview/pr-1797/src/data/blockMerge.js\":\"093c783a84e274dc\",\"/knowledge-medium/pr-preview/pr-1797/src/data/blockSchema.js\":\"8877721b9ded14f5\",\"/knowledge-medium/pr-preview/pr-1797/src/data/blockTypes.js\":\"c7b5b97c8235bf52\",\"/knowledge-medium/pr-preview/pr-1797/src/data/clientContext.js\":\"b30418fe6e8d2478\",\"/knowledge-medium/pr-preview/pr-1797/src/data/dbFileSiblings.js\":\"e015d2557e8ffd2c\",\"/knowledge-medium/pr-preview/pr-1797/src/data/definitionSeeds.js\":\"c7584795494cb3d0\",\"/knowledge-medium/pr-preview/pr-1797/src/data/derivedIds.js\":\"1586bc015d6d6eb9\",\"/knowledge-medium/pr-preview/pr-1797/src/data/drawnSubtree.js\":\"5f8e5e342fa6c615\",\"/knowledge-medium/pr-preview/pr-1797/src/data/facetBridge.js\":\"2fb20c2ca9763ad0\",\"/knowledge-medium/pr-preview/pr-1797/src/data/facets.js\":\"4cec917a546419e6\",\"/knowledge-medium/pr-preview/pr-1797/src/data/globalState.js\":\"47b49ef2e4fb4bd2\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/aliasClaimRederiveProcessor.js\":\"cd2c7a6ddfab0902\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/ancestorBatch.js\":\"dc677b3675ab8c46\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/blockTypeTypeifyProcessor.js\":\"76fba11d1d03a412\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/clientSchema.js\":\"4fd904e68c42b85a\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/commitPipeline.js\":\"244782e8d058e0a1\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/devAssertions.js\":\"73d2535973910cfa\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/firstSync.js\":\"a03e736e5a7bbaec\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/freshInitialLoad.js\":\"11f8fcc782094760\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/graphBackfillClaim.js\":\"610aeffa3a47771c\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/handleStore.js\":\"4854c776aa4fc236\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/idleMarkerJobs.js\":\"aa2c1a80b5998ac4\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/initialDownload.js\":\"840d33b8123090ea\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/initializeClientDatabase.js\":\"d87f40bde80d3b48\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/jsonCanonical.js\":\"e88707083042831a\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/kernelInvalidation.js\":\"412e7c1752163017\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/kernelProcessors.js\":\"1ebf447cf682b60c\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/kernelQueries.js\":\"6d81e451f5fea3b0\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/mergeTypeMembershipProcessor.js\":\"0ce3160f6202c170\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/normalizeReferencesProcessor.js\":\"2a45ac16aa55b2bb\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/poolInstrumentation.js\":\"fe70d1c0ebb0c717\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/processorRunner.js\":\"3989518069197211\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/propertyCellBackfill.js\":\"1b44c9b9b1f9e832\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/propertyChildMint.js\":\"81ab0d4b4e50bb30\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/propertyChildrenProcessor.js\":\"e1a1c0f790d79215\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7bf1e05f78762a02\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/propertyDefinitionSynthesis.js\":\"c53cf7bc7074e12d\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/propertyKeyScan.js\":\"a958e870dd28be32\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/propertySchemaResolution.js\":\"8affbdd557570615\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/propertyValueEdits.js\":\"5c17e15efad0125f\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/raiseProtocol.js\":\"78de138f61f91b8e\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/readBatch.js\":\"ac764c8801bb83f8\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/refProjection.js\":\"80728aca01900bdd\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/referenceTargetLookups.js\":\"9065a7cc0eff27cf\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/referenceTargetProcessor.js\":\"221a609445b91415\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/replayMerge.js\":\"29c00d949576209f\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/sqlBinds.js\":\"7dbb21204d27aa07\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"cfc216c3d93614c3\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/syncObserver/arrivalProcessors.js\":\"3d6b332e191fb0a7\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/syncObserver/invalidate.js\":\"33630f33e71b0358\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/syncObserver/materialize.js\":\"3f20750321c4583c\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/syncObserver/observer.js\":\"921477bd77ca217c\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/syncObserver/reconcile.js\":\"6e29fe36941c964a\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/timingMetrics.js\":\"ee0d6aeab0c29361\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/treeQueries.js\":\"7fa56ba37acb6c58\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/txEngine.js\":\"a558425da68f7caa\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/txSnapshots.js\":\"3ac68063fd5c14e9\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/typedBlockQuery.js\":\"adcfd5fc76ac9081\",\"/knowledge-medium/pr-preview/pr-1797/src/data/internals/undoManager.js\":\"0410bb4f93e81fbe\",\"/knowledge-medium/pr-preview/pr-1797/src/data/invalidation.js\":\"e7cc7d74e2516162\",\"/knowledge-medium/pr-preview/pr-1797/src/data/kernelDataExtension.js\":\"168d453501317da2\",\"/knowledge-medium/pr-preview/pr-1797/src/data/kernelPage.js\":\"deffe8fb71be9d43\",\"/knowledge-medium/pr-preview/pr-1797/src/data/kernelValuePresetCores.js\":\"457ad8baa8fc790a\",\"/knowledge-medium/pr-preview/pr-1797/src/data/localDbCorruptionSignal.js\":\"d4527898fbcbc559\",\"/knowledge-medium/pr-preview/pr-1797/src/data/localDbStorage.js\":\"3ef8160d2bb9f65f\",\"/knowledge-medium/pr-preview/pr-1797/src/data/localDbVfs.js\":\"a24f3387022a6852\",\"/knowledge-medium/pr-preview/pr-1797/src/data/localSchema.js\":\"810791891159f4f0\",\"/knowledge-medium/pr-preview/pr-1797/src/data/maintenance.js\":\"ef20ff2f45adc8ee\",\"/knowledge-medium/pr-preview/pr-1797/src/data/mergeProperties.js\":\"0ac67bd1eedefd88\",\"/knowledge-medium/pr-preview/pr-1797/src/data/metricsConsoleHook.js\":\"ac34807288c6c999\",\"/knowledge-medium/pr-preview/pr-1797/src/data/migrationsPage.js\":\"3c551842412f74c9\",\"/knowledge-medium/pr-preview/pr-1797/src/data/mutators.js\":\"38506364c31a5645\",\"/knowledge-medium/pr-preview/pr-1797/src/data/orderKey.js\":\"442a925204beea29\",\"/knowledge-medium/pr-preview/pr-1797/src/data/orderKeyPlacement.js\":\"5c79cff2018a870b\",\"/knowledge-medium/pr-preview/pr-1797/src/data/outlineSurface.js\":\"9abb70671aaf1ff9\",\"/knowledge-medium/pr-preview/pr-1797/src/data/pendingEditorContent.js\":\"221a02d8413748f6\",\"/knowledge-medium/pr-preview/pr-1797/src/data/pendingUploadsSql.js\":\"0e68e66b83552fdf\",\"/knowledge-medium/pr-preview/pr-1797/src/data/pluginStateExtensions.js\":\"8cec6548484b81b1\",\"/knowledge-medium/pr-preview/pr-1797/src/data/powerSyncLogger.js\":\"112165507c56cd2a\",\"/knowledge-medium/pr-preview/pr-1797/src/data/projectorRuntime.js\":\"38acd45013c8c176\",\"/knowledge-medium/pr-preview/pr-1797/src/data/properties.js\":\"6d5fd975ea0a7ccb\",\"/knowledge-medium/pr-preview/pr-1797/src/data/propertiesPage.js\":\"6e90279e3f075429\",\"/knowledge-medium/pr-preview/pr-1797/src/data/propertyChildren.js\":\"beedd9b19f56c442\",\"/knowledge-medium/pr-preview/pr-1797/src/data/propertyDefinitionFanout.js\":\"d115556ba8b4c881\",\"/knowledge-medium/pr-preview/pr-1797/src/data/propertyDefinitionMetadata.js\":\"73442839d8449345\",\"/knowledge-medium/pr-preview/pr-1797/src/data/propertyDefinitionRegistry.js\":\"206d8adfd6c5a1a5\",\"/knowledge-medium/pr-preview/pr-1797/src/data/propertyDisplayMode.js\":\"b3d41eb4662ac708\",\"/knowledge-medium/pr-preview/pr-1797/src/data/propertyRowCreation.js\":\"655866a12e728de5\",\"/knowledge-medium/pr-preview/pr-1797/src/data/propertySchemaCreation.js\":\"9c78d2ae4913ff31\",\"/knowledge-medium/pr-preview/pr-1797/src/data/propertySeeds.js\":\"63be80d98ce4cf25\",\"/knowledge-medium/pr-preview/pr-1797/src/data/recentsPage.js\":\"b0cd43d0dde416a7\",\"/knowledge-medium/pr-preview/pr-1797/src/data/referenceBlock.js\":\"ca4076be94cc87eb\",\"/knowledge-medium/pr-preview/pr-1797/src/data/releasePowerSyncConnection.js\":\"9d2d61ee58cc7c24\",\"/knowledge-medium/pr-preview/pr-1797/src/data/repo.js\":\"e490845ba27d51fd\",\"/knowledge-medium/pr-preview/pr-1797/src/data/repoProvider.js\":\"d047ca788454d752\",\"/knowledge-medium/pr-preview/pr-1797/src/data/rowProperty.js\":\"af3ab24472733e88\",\"/knowledge-medium/pr-preview/pr-1797/src/data/searchFilter.js\":\"5416c61c2b3de25e\",\"/knowledge-medium/pr-preview/pr-1797/src/data/seedIdentityLedger.js\":\"816734a3ac2a3c50\",\"/knowledge-medium/pr-preview/pr-1797/src/data/stateBlocks.js\":\"8df093401544ad1a\",\"/knowledge-medium/pr-preview/pr-1797/src/data/structuralEditPolicy.js\":\"247f0747ad94a8ec\",\"/knowledge-medium/pr-preview/pr-1797/src/data/subtreeDelete.js\":\"4c1b4ec5e98f83c9\",\"/knowledge-medium/pr-preview/pr-1797/src/data/syncStreamLock.js\":\"8fa785263d37488b\",\"/knowledge-medium/pr-preview/pr-1797/src/data/syncedTableSqlRecognizer.js\":\"4c797686c3036f06\",\"/knowledge-medium/pr-preview/pr-1797/src/data/syncedTableWriteGuard.js\":\"0c01d2efedb50c3d\",\"/knowledge-medium/pr-preview/pr-1797/src/data/targets.js\":\"0e43199086c9e900\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typeColors.js\":\"425a2860b130f265\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typeDefinitionMetadata.js\":\"700eafba835d7d75\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typeDefinitionRegistry.js\":\"c35b5d3fb95951ff\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typeExtraction.js\":\"4e137e8e1ebb0065\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typeInitialValues.js\":\"275e9d3d3aad0f12\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typePropertyGroups.js\":\"dadd932ee3127674\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typeSeeds.js\":\"67df3e8c113cd907\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typeTagger.js\":\"2ecff0b4ae7b8e76\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typedRecords.js\":\"261e21ebfd315556\",\"/knowledge-medium/pr-preview/pr-1797/src/data/typesPage.js\":\"ad556688f5cef731\",\"/knowledge-medium/pr-preview/pr-1797/src/data/userPrefs.js\":\"450da1a075e565f6\",\"/knowledge-medium/pr-preview/pr-1797/src/data/userSchemasService.js\":\"3729017a971a44a6\",\"/knowledge-medium/pr-preview/pr-1797/src/data/userTypesService.js\":\"3bd8e5353ddd6db0\",\"/knowledge-medium/pr-preview/pr-1797/src/data/valuePresetRegistry.js\":\"c28b40bbae557f9a\",\"/knowledge-medium/pr-preview/pr-1797/src/data/visibleChildren.js\":\"dbb9b42e14fa74ed\",\"/knowledge-medium/pr-preview/pr-1797/src/data/workspaceConversion.js\":\"a83f643421e7159a\",\"/knowledge-medium/pr-preview/pr-1797/src/data/workspaceFirstSync.js\":\"f4d2c5c1641a7c9c\",\"/knowledge-medium/pr-preview/pr-1797/src/data/workspaceIdNamespace.js\":\"ec5c673f1d2eb653\",\"/knowledge-medium/pr-preview/pr-1797/src/data/workspaceSchema.js\":\"ecde490faa9c2438\",\"/knowledge-medium/pr-preview/pr-1797/src/data/workspaces.js\":\"2a83a372cf314181\",\"/knowledge-medium/pr-preview/pr-1797/src/data/writeAheadLog.js\":\"aee58470baea6e92\",\"/knowledge-medium/pr-preview/pr-1797/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/BlockPasteShellDecorator.js\":\"58bfa8ddd418c03c\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/atTrigger.js\":\"bcfdd4c403890f2b\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/autocomplete.js\":\"c3dc47003738181f\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/codeMirrorExtensions.js\":\"d68f02eb19cb6429\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/contentFlush.js\":\"6b16d96ad9ce2ee9\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/defaultInteractions.js\":\"b0c9f06bab9b6aa2\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/editSettleSignal.js\":\"fcf9a467dcea35fa\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/insertImage.js\":\"3c805ba00ecc75aa\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/referenceCompletionRange.js\":\"74303e480c55754c\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/referenceTargetTypes.js\":\"3c33d0a066d28157\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/syntaxContext.js\":\"fde073606fef5e9c\",\"/knowledge-medium/pr-preview/pr-1797/src/editor/triggerMatch.js\":\"9b9a2bf9ddd969d3\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/AppRuntimeProvider.js\":\"8b1a1b04387f4920\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/BlockFocusShellDecorator.js\":\"4701f0016f17c00f\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/ExtensionRenderBoundary.js\":\"4fb6a10a80c5241e\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/PanelContentRecovery.js\":\"ce9908e3b794933f\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/apiCatalog.js\":\"07977927c14047e5\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/approveExtensionHere.js\":\"c0288abf333393e7\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/armedCutAppMount.js\":\"86fee6beb72cc687\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/batchableKeyedStore.js\":\"e97af1f2f3d946f0\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/blockInteraction.js\":\"b9592685720aa6a1\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/blockSelectionAction.js\":\"14afb0e324994298\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/compileExtensionModule.js\":\"cce87e558bb2579e\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/compiledModuleCache.js\":\"c140de3c815b1746\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/continuousGestures.js\":\"61f386d27d586071\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/core.js\":\"62c597dcbf02a7ed\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/defaultRenderers.js\":\"a66f171fce81959c\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/definitionFanoutAppMount.js\":\"d8c585f69d1cba5a\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/dialogAppMount.js\":\"93c553dc457c767f\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/dynamicExtensionSeeds.js\":\"73855678c7d2e3ef\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/dynamicExtensions.js\":\"1d8931f5841bc7b2\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/exampleExtensions.js\":\"a9545df5941fe9a8\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/extensionApprovalStatus.js\":\"fe71ca4db0ccc6b5\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/extensionLoadErrorToast.js\":\"5e3585f49fcfde69\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/extensionLoadErrors.js\":\"9011d293403aa07f\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/extensionLookup.js\":\"76d01c3451c4ab7c\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/extensionToggles.js\":\"d3c21ba464402933\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/extensionUtilitiesCss.js\":\"a63b8fc65f69a937\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/kernelPageDeletionGuard.js\":\"4269e7f164f5100a\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/liveRuntime.js\":\"7225eb331bdc2234\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/openExtensionsSettings.js\":\"6e6d26595c1aaa17\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/overridesCache.js\":\"a7a3a131434b2b6d\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/pluginIds.js\":\"f3595b9ab13e3606\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/processorRejectionToast.js\":\"5d545119d5782015\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/runtimeActions.js\":\"6c74b574751570dd\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/runtimeContext.js\":\"e45a6269876230a0\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/staticAppExtensions.js\":\"346b395d45622ad8\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/staticDataExtensions.js\":\"79d14f051599785b\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/toastAppMount.js\":\"49f35551c04deb71\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/useOverrides.js\":\"e73e7ac23f0dd92c\",\"/knowledge-medium/pr-preview/pr-1797/src/extensions/useShortcutSurfaceActivations.js\":\"e095021e77f3efd7\",\"/knowledge-medium/pr-preview/pr-1797/src/facets/discoverToggleTree.js\":\"13e0fc5c372d8f69\",\"/knowledge-medium/pr-preview/pr-1797/src/facets/facet.js\":\"2d3c52e1124e7ec0\",\"/knowledge-medium/pr-preview/pr-1797/src/facets/resolveAppRuntime.js\":\"75542343a000dc06\",\"/knowledge-medium/pr-preview/pr-1797/src/facets/runtimeEvents.js\":\"e93f1ac751b49643\",\"/knowledge-medium/pr-preview/pr-1797/src/facets/togglable.js\":\"120304f68801ff24\",\"/knowledge-medium/pr-preview/pr-1797/src/facets/variantFacet.js\":\"6e4ab8d419ed0d04\",\"/knowledge-medium/pr-preview/pr-1797/src/facets/verbFacet.js\":\"e8a4b432ef5112b5\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/block.js\":\"64ac201d02be28f2\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/focusedChild.js\":\"392db3cc78467269\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/propertySchemas.js\":\"167b1feb7e18139f\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/typeRegistry.js\":\"f8e197f03b9db06a\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useAncestorCrumbs.js\":\"94032a008508fc56\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useAutocompleteListbox.js\":\"e013f9ae07417572\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useDebouncedSearch.js\":\"d4eff462efd248d6\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useDebouncedValue.js\":\"2e121b15171da6c4\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useIsFocalRender.js\":\"b1f71734366819c6\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useIsReadOnly.js\":\"6567f9bfb9d6de21\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useMaterializeBacklog.js\":\"189f24e2d10e8056\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useMinuteClock.js\":\"b4a4555416e789da\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/usePanelLayoutProjection.js\":\"6480e5210d05abfd\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/usePendingInvitations.js\":\"352c61242029c580\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useRendererRegistry.js\":\"30fef2f0a020d2d6\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useRetainedFieldRows.js\":\"8bbc9b3a074be464\",\"/knowledge-medium/pr-preview/pr-1797/src/hooks/useWorkspaces.js\":\"a4cf41c3933b0765\",\"/knowledge-medium/pr-preview/pr-1797/src/lib/utils.js\":\"730728fbebfddfbc\",\"/knowledge-medium/pr-preview/pr-1797/src/main.js\":\"b9cf9fc297b01c1f\",\"/knowledge-medium/pr-preview/pr-1797/src/markdown/MarkdownImage.js\":\"dae06d9656651928\",\"/knowledge-medium/pr-preview/pr-1797/src/markdown/blockSeparators.js\":\"5aecbb72c2006531\",\"/knowledge-medium/pr-preview/pr-1797/src/markdown/context.js\":\"2ed040522bd671ed\",\"/knowledge-medium/pr-preview/pr-1797/src/markdown/defaultMarkdownExtension.js\":\"a886b186a84076aa\",\"/knowledge-medium/pr-preview/pr-1797/src/markdown/extensions.js\":\"feac81c14a0931a3\",\"/knowledge-medium/pr-preview/pr-1797/src/markdown/renderMarkdownHtml.js\":\"aa43aa19acb14cd3\",\"/knowledge-medium/pr-preview/pr-1797/src/minimal-editor.js\":\"fa13e7743e5f183d\",\"/knowledge-medium/pr-preview/pr-1797/src/paste/armedCut.js\":\"87ce7633d2f6cd9f\",\"/knowledge-medium/pr-preview/pr-1797/src/paste/captureMediaVerb.js\":\"9ef3d9c679567f3f\",\"/knowledge-medium/pr-preview/pr-1797/src/paste/clipboard.js\":\"5b3e1ffe1cd17802\",\"/knowledge-medium/pr-preview/pr-1797/src/paste/decision.js\":\"ca1d019f86fea90f\",\"/knowledge-medium/pr-preview/pr-1797/src/paste/operations.js\":\"0019d151fd7b02ec\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/account-header/AccountHeaderItem.js\":\"6a0ff782f7d06959\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/account-header/index.js\":\"16dd2f2c10823b06\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5275602c55a76418\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-dispatch-companion/askAgent.js\":\"4a7495eda2c0ba22\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-dispatch-companion/askedStore.js\":\"6a127388073b7277\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6ee17f6a0d1fcc5f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-dispatch-companion/chipState.js\":\"6b06c40508b7436e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c378e5104f162c45\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-dispatch-companion/index.js\":\"80050a622b5eec24\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e87a418b2ac8193f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-dispatch-companion/schema.js\":\"f36629e76cd0dd73\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/AgentTokensDialog.js\":\"555fb8a7328e462a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e5c2d52c7099794a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/addMedia.js\":\"2ffcea6c0f630bee\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e244a62edd1a8d74\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/block.js\":\"18b27bc371a64881\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/context.js\":\"a6e8c753d7d83948\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3d5487542a2e80df\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/index.js\":\"3cdd9e8bc23a2163\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/outline.js\":\"52d0307cb5226e61\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/properties.js\":\"fb79ae3476831471\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/refs.js\":\"65102d8b350954ca\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"089b5fc8da730446\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/search.js\":\"066d057f5432f511\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/shared.js\":\"0852fdc466273ab4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"105c12b1ca513b08\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentViews/text.js\":\"2e394b58b02559ca\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/agentWrites.js\":\"96025abf7b66596e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/authoringCatalog.js\":\"663e0047f0a28a08\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/blockRefTargets.js\":\"60ec0e4c52be530a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/bridge.js\":\"b823a4d279707bef\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/bridgeLoop.js\":\"02c3143314c857b5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/changeHistory.js\":\"e126eb66173c525a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/commands.js\":\"79b62563476baa6f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/commentsCommands.js\":\"6427e278674f280e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/dataExtension.js\":\"1eb76806302a0a89\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/dataModelGuide.js\":\"7a332428320408d4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/describeRuntime.js\":\"55a98294fb036563\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/extensionLint.js\":\"25a57cfbfac18435\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/grainAudit.js\":\"4ec33ffab151d3ce\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/healthCommand.js\":\"dcc8154a3cae50fb\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/index.js\":\"aab2c1d9fc9b0223\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/presetIdentity.js\":\"a5dc25b7d7986700\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"863960c1ae1eee90\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/readMedia.js\":\"46068309e0db2365\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/schema.js\":\"ced00df0e490b81c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/serialization.js\":\"56adb1870ed2505e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/targets.js\":\"536f79c277c875bb\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/tokens.js\":\"6c0256565757cfb2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/watchEvents.js\":\"0f285748f6a5bdef\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/workspaceGuard.js\":\"4563a36e163c516a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/agent-runtime/writeCommands.js\":\"8c29647a0d83553b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/alias/AliasCollisionToast.js\":\"0aaaf3a84f6d4fbf\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/alias/DuplicateNameBanner.js\":\"f898f606647d6e6e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/alias/collisionMerge.js\":\"ce5901761df9f75f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/alias/dataExtension.js\":\"58df6659701e2157\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/alias/index.js\":\"460a0a4da6bd21f1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/alias/mergeCollisionAction.js\":\"e0e82f60ddfe9b2b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/alias/pageStyling.js\":\"9fbf58144e3b9860\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/alias/rejectionToast.js\":\"ea190e5ccb3d320e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/alias/syncProcessor.js\":\"b365d6ab7f11fcff\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/actions.js\":\"1771b3285a129f5f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/addComment.js\":\"f8230a7ae31d020d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/anchor.js\":\"c1717251843af5a7\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/anchorState.js\":\"3af3d1b4f406ad52\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/commentLinks.js\":\"bf02c4c04425a0d3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/confirmThreadDeletion.js\":\"ca7da6426828d61e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/container.js\":\"3d027ac58ddcbba3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/dataExtension.js\":\"67175cc0fe5f8c08\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/deleteComment.js\":\"8b3b94f7b80c6a0f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/highlights.js\":\"f380d56183ef66f4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/index.js\":\"d7397e5ac4069021\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/linkedCommentsPill.js\":\"1cc963ea9c0a1c50\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/margin.js\":\"07e4f15001338758\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/marginSchema.js\":\"0fe82b0e539ba41b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/newComment.js\":\"306904cfcb051eb4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/ownThreadPicker.js\":\"f5510624994334e5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/placement.js\":\"1d4b012aa8b78ec3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/queries.js\":\"0b34a5bcd814585c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/quotePosition.js\":\"ccb5444237f07de9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/quotedIn.js\":\"bee0594abd911202\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/quotedRange.js\":\"337ed22dacfdf044\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/rangeRefs.js\":\"0ac3fee91d368ec2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/readHighlights.js\":\"4ddbbecae7c3ddce\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/readSelection.js\":\"b84a3e539f88e742\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/readSelectionUi.js\":\"be3f978f27aed5d8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/reanchor.js\":\"8b1b8dae5db4f36c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/schema.js\":\"87f64056e5cd61aa\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/scope.js\":\"be8032e9080f4ba7\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/scopeThreads.js\":\"2ca5f8f1bbf7c23f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/splitRetarget.js\":\"9e1593a23322ea81\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/suggestionCard.js\":\"525a4873b1f2c654\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/suggestions.js\":\"fb1b3d621d7bfc47\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/summaries.js\":\"ce1c098bd33a7cc6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/summaryBatch.js\":\"5d545bdb72eedd1c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/surface.js\":\"ffaafa4019a70ba3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/threadNavigation.js\":\"a43a8effcc7b49e2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/threads.js\":\"3c27a56338d25077\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/ui.js\":\"8fe0c6b48bc70d38\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/annotations/uiStore.js\":\"3e45a44658adebab\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/app-intents/appIntents.js\":\"6a191530c4e3aef6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/app-intents/index.js\":\"cc88bb52a3df421a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/app-update-prompt/index.js\":\"04de50733993370a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/app-update-prompt/status.js\":\"215091f4fcb53557\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f23db7b7024d234f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/MediaBlockRenderer.js\":\"31860a52b53cf98a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/MediaDownLaneReplicator.js\":\"3b29c9fe2320ccec\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/MediaUploadReconciler.js\":\"08170dc7764f4c1d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/assetDownLane.js\":\"95a0b1ddf2d4f652\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/assetResolver.js\":\"3822e7f7c76a9719\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/assetUpload.js\":\"88a6e09f31c2083f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/attachmentCleanerIO.js\":\"e44a0a7aab8269ff\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/audit/supabaseAuditIO.js\":\"63923d92ae83a33e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/blobStore.js\":\"3c0b3b1ee14bea3f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/byteStore.js\":\"0b08474f19e007e1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/cleanerIO.js\":\"28696a7454bd0fdc\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/cleanupAttachments.js\":\"96d98255f162295f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/dataExtension.js\":\"89bf1e2635bca2f1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/downLane.js\":\"88751851f5103a23\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/index.js\":\"c6a2a242f6592e05\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/insertImageContribution.js\":\"ecc04fdb8ab77111\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/laneArming.js\":\"ce4cb7f0d865480b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/laneLock.js\":\"cc8c06ccbb24cbdc\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/mediaBlock.js\":\"c3fb24d8373384cb\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/mediaCapture.js\":\"1dce29ed26cd6497\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/mediaViewers.js\":\"7c4d49479c9f6384\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/mediaViewersFacet.js\":\"f2d6d0bbbc7d1078\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/pasteCapture.js\":\"ccb97500c6de6252\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/resolver.js\":\"aa75a3c0a34651c6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/retryUploadsAction.js\":\"14e3d7c01612065d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/storagePaths.js\":\"6dc8135c5f236675\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/uploadDrain.js\":\"950a544681e85f55\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/uploadLaneStatus.js\":\"3105e8803688483f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/uploadReconcile.js\":\"5b52a0658ab7e929\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/uploadRecovery.js\":\"89f84cddb9aed87a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/uploadStore.js\":\"0243ee0cf34905b4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/attachments/useAssetObjectUrl.js\":\"e90327213af2346a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f0ca64187e71b6a6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5dd28d9c40f666b0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks-view/facet.js\":\"18348abc563d549a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks-view/index.js\":\"95f91f63ccf01478\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks-view/prop.js\":\"70abe12fd5f72faf\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/BacklinkFilters.js\":\"7ddec4c2cf722445\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"822eedd5be88c61e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/BlockEntry.js\":\"0fc3d6f8e4fe95d6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/LinkedReferences.js\":\"5cfc48ca18c90226\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"70c173a00f1edb16\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/dailyNoteDefaults.js\":\"afa441edbdc7b3df\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/dataExtension.js\":\"ad10d635d915c02b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/edgeExclusions.js\":\"f0883c95ba7341eb\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/filterProperty.js\":\"34ae955c878e7187\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/index.js\":\"b38bebf6b65239ce\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"16ce9af2a7c47a7f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/inline-counts/applies.js\":\"26d47aef625dde12\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/inline-counts/countQuery.js\":\"aecfcf70e676d505\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d8373f52887e6c8e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/inline-counts/index.js\":\"a3a6e9ae4af7daa8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1fb9cb8cd4772cc6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/presentationInvalidation.js\":\"9c45200473d5b85c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/propertyEditorOverride.js\":\"b41798a00418d60b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/propertyFilter.js\":\"9c1f43c26a215d92\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/query.js\":\"45a641851d41a185\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/resolveFilter.js\":\"f1a201056e6cb7e0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/sourceBatch.js\":\"0375a85cb9715004\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/sources.js\":\"5a57ff2945afe4ff\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/useBacklinks.js\":\"cd54a55c5f088f97\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"75d62a3b2d4de53f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/birthday/BirthdayCelebration.js\":\"0fad4e40c06faecc\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/birthday/BirthdayOverlay.js\":\"e1920c296f9b585e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/birthday/gate.js\":\"27149b08ede975e7\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/birthday/index.js\":\"88adb8b7967ead4b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/birthday/wolfTheme.js\":\"ef348e083907e5a4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-drag/BlockDragLayer.js\":\"b3235f8109ca7c43\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-drag/dragController.js\":\"62d1adfcee031640\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-drag/dropTarget.js\":\"90a3b9fde05d37f9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-drag/index.js\":\"15974414eba9c131\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-drag/projection.js\":\"edfc916940e71eab\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-info/BlockMetaCard.js\":\"ea749fb8c087e527\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-info/index.js\":\"f7308a5e35cff6cd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-tagging/AddTagDialog.js\":\"f054fd5623d9f42d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e91250db769f84a1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-tagging/TagNameIssueHint.js\":\"2c7d50ce6a35c149\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-tagging/addTagAction.js\":\"6b514cf9c3935be5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-tagging/appendTag.js\":\"5e83c4f6b6502d1d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-tagging/config.js\":\"9ba3d40299245d2c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-tagging/dataExtension.js\":\"4d02863589b78df1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-tagging/index.js\":\"9d10d12bbc43d1b3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/block-tagging/propertyEditorOverride.js\":\"484511e7f5af4686\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/breadcrumbs/BreadcrumbList.js\":\"013c58742452ba78\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a1090b663bbee250\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/breadcrumbs/Breadcrumbs.js\":\"94ec9e897101c0b5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7382cec9d516153d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b205f818a9ef465f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/breadcrumbs/index.js\":\"a886fb2acf191337\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"dafb186f201db9b1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/CharacterCountItem.js\":\"c0f85717a41a4a7a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c9fab7e8a4047772\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/actions.js\":\"a462dfd273298937\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/blockType.js\":\"def5973394ab5ba5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/charCount.js\":\"94b773596e09258d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/dataExtension.js\":\"67ca5a43392609f8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/index.js\":\"524f16a30ca782d0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/profiles.js\":\"bece2f16bef142c9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/properties.js\":\"c3f12732fa02d16c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/character-counter/textCounts.js\":\"13b8589302e7df6b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/colemak-keybindings/index.js\":\"f2d4f395d1d3d539\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/command-palette/CommandPalette.js\":\"039a1cd8ebc52cd9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/command-palette/HeaderItem.js\":\"fdf966e07191b4a9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/command-palette/context.js\":\"1468a41e724b9b3e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/command-palette/index.js\":\"b015c77999160a9e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/command-palette/selection.js\":\"e042e3f9fb42e569\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/command-palette/toggleStore.js\":\"07b100a75d2cce51\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/command-palette/useCommandPaletteActions.js\":\"44b2e5444186c0e0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/ContributorBadges.js\":\"ab29cc37daf2b1d1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/author.js\":\"71295f61dbdf1238\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/codeMirrorExtensions.js\":\"c69d3ba47110d0b6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/dataExtension.js\":\"5dbe41d4c0797633\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/index.js\":\"69a67824482ae814\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/mentionAutocomplete.js\":\"aac2d0c19e04be63\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/processor.js\":\"2f35ae9d2eef95d2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/profiles.js\":\"7ce19b2d64a1888d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/queries.js\":\"030747daeee60e8d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/contributors/schema.js\":\"12c82f0076988beb\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"34bb06aaf856225b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e09fa43fe933b3f6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/cursor-follows-scroll/index.js\":\"9d00a23d8f5a9188\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2f5162d5a3e8275c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9a63c89d8ea0280c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/CalendarGrid.js\":\"405a8a6f6381b4b0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/DailyNotePicker.js\":\"fd8fbb77f11b91cf\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"de264f1d5c0f88d3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/DateNavDecorator.js\":\"6cee534ae16fe9c0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/DateScrubOverlay.js\":\"c2f2bb12e07e9b58\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/HeaderItem.js\":\"6237e11f69778684\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/ReschedulePicker.js\":\"1c25363465f28ec3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d02392c53a7b004d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/actions.js\":\"a11d353510cd9f8b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/blockDateAdapter.js\":\"2935f74ab9b0354c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/calendar.js\":\"f7599e558d392d58\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/dailyNotes.js\":\"a54de582a6bbb79d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/dataExtension.js\":\"9b1c487f68e042a9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/dateScrubActions.js\":\"5e158925fbc4abad\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/dateScrubGesture.js\":\"bc2e644d5deb9e86\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6e7be8eb234e6b70\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/dateScrubRecognizer.js\":\"50b869cd9e197bd8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/deletionGuard.js\":\"fc102c3c0b9513dc\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/dueQuery.js\":\"31fd2398d883d5ec\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/index.js\":\"b289eec4faad28a3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/landing.js\":\"1546537c05532a9c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/localSchema.js\":\"28a0e710eb95bc8d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/referenceDateAdapter.js\":\"7fe09713c186f8d1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/rescheduleAction.js\":\"6c8ad0b57a346f3e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/schema.js\":\"e609823d1595598a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/spreadBlockDates.js\":\"3628dcd0e8e71f0f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/spreadDatesAction.js\":\"92d1957719f656d5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/today.js\":\"4d4f96dec08b4cab\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e0f151db6ae4014d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a2f874f10810eb2b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/audit.js\":\"e4de776560fad023\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/auditAction.js\":\"00f616f53a5afd6b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/auditRanges.js\":\"e91d83ffca1a0789\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/diagnosticsSource.js\":\"d4ff50379705a10c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/divergenceScan.js\":\"c7424457ce1ec022\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/index.js\":\"962fff123f657785\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d6bbf8f4bc8f25d3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/referencesMirror.js\":\"9f76917963def0fb\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/rowJson.js\":\"7c6cc9a111751405\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/schedule.js\":\"1fddd227db9305dd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/data-integrity/store.js\":\"d456b1fa95443ee4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-maintenance/action.js\":\"a38595343ac78831\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-maintenance/index.js\":\"4c151ef6774caf47\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-maintenance/plugin.js\":\"fb3b0d355f497047\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e76c141997f0b4a6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/actions.js\":\"c5fd239927a5d135\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/changeMarker.js\":\"219ffcb526acdd4c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/diagnostics.js\":\"06c9bd5f77f9e5e9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/fileSystemAccess.js\":\"8758e30b61f02591\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/filenames.js\":\"81c43472183bcb0c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/index.js\":\"f3dfb1ad1a972ede\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/mirror.js\":\"c9d3ae44e63310a1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/runLock.js\":\"8365e1778b75d5b5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/runtimeHealth.js\":\"77a3694d342cd4fd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/schedule.js\":\"7bd35a480e0ecfdb\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/db-mirror/store.js\":\"31f22f0ba323688e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/default-themes/index.js\":\"e435d5fa95652492\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/default-themes/themes.js\":\"e1c77f7035e419ae\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/diagnostics/facet.js\":\"8e05fb951432498b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/diagnostics/useDiagnostics.js\":\"6ffb1393cc08cfbd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extension-prompts/dismissals.js\":\"1f191fc4bbb07e07\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extension-prompts/index.js\":\"f7dc8ba8e0d8a6e9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extension-prompts/status.js\":\"ae8f1a429a7344bd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extension-prompts/store.js\":\"5c712ba0991421f8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e6faf3b68ced136b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extensions-settings/ExtensionsSettings.js\":\"dc9eda77184447a7\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extensions-settings/actions.js\":\"582e5c986ab67daa\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extensions-settings/config.js\":\"f971a8736ba13648\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extensions-settings/dataExtension.js\":\"42668520cf764ad8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extensions-settings/effect.js\":\"9d25d394f54b7f8e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extensions-settings/index.js\":\"05f29fccb3aee3fd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ce6461f2c339ffc6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extensions-settings/useToggleTree.js\":\"4659e0c93769bb20\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extract-type/ExtractTypeDialog.js\":\"0293762221490ebe\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c8a0b212194d03a8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extract-type/PropertyShapePicker.js\":\"e9cc6a9d6b8a3514\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extract-type/action.js\":\"989ee861166ff8d3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/extract-type/index.js\":\"33679ee5478a9c28\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/find-replace/FindReplaceDialog.js\":\"89062a6c574f5942\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/find-replace/HeaderItem.js\":\"775a215b0f9befb4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/find-replace/dataExtension.js\":\"5a040aef024efa61\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/find-replace/index.js\":\"882472bbde36259e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/find-replace/search.js\":\"8ecace66efa75c72\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/find-replace/toggleStore.js\":\"40e9c0c3858054c3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/LocationPropertyEditor.js\":\"ee9d202cb3275396\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/MapView.js\":\"b8c78f608a61a227\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/blockTypes.js\":\"05317bf48f10122f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/codeMirrorExtensions.js\":\"061a94ff3d7373b2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/createOrFindPlace.js\":\"27cb2996496af793\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/currentLocation.js\":\"7bf3d03530d7e75f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/dataExtension.js\":\"c2cadbfe79584f32\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/geoContentDecorator.js\":\"2106832275bd1b5a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/googlePlacesClient.js\":\"499227170d10028f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/index.js\":\"dfdfba56d99d44c0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/locationsPage.js\":\"0823268386241f42\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/mapViewport.js\":\"53cdb2050c673d84\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/pickCurrentLocation.js\":\"4bf6e11255697df0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/placeAutocomplete.js\":\"bc66c28629c13aa1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/placeNameCollision.js\":\"cad07d30014b85bf\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/properties.js\":\"4cda018371fc01d5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/propertyEditorOverrides.js\":\"fc281a69365dceb0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/query.js\":\"32e59fb9ace0bda5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/geo/usePlaceSearch.js\":\"499e15b71411bff8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"74b383fd8f51de4b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"8c617bf5eca8c1e0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"02734b0449abeccc\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/config.js\":\"225dd4a72a2723ae\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/dataExtension.js\":\"8cb42f9281a10f65\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/facet.js\":\"794e2c3a1344b788\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/grouping.js\":\"9bec2088c6bc8f21\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/index.js\":\"b995531209822274\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"90164bafb896b076\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/query.js\":\"a08cfbaa553458b1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/resolveConfig.js\":\"f7de945895d94a62\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"eaf70ea3acfdc38a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a0f7a8b16a3e5eb3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/HtmlDocumentContent.js\":\"2f3c52ceb293540e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/HtmlFrame.js\":\"2617a9a65fafa909\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/actions.js\":\"904cb196dde239a8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/blockType.js\":\"a3b0395e7a9caf44\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/confirmRunScripts.js\":\"84c98328c40fc341\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/dataExtension.js\":\"a368df416fe575e1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/frameAnnotations.js\":\"3ed6cefcec3e498d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/frameDocument.js\":\"3431e54eef2a0e6e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/frameTheme.js\":\"a76e8db418b89e23\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/index.js\":\"d5a2f296d366dd16\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/scriptConsent.js\":\"55ef12ff48e2641a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/sourceMap.js\":\"d71ee8d3bf919b0f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/html-document/useDocumentScripts.js\":\"6c57348a01dbcf90\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/interaction-metrics/index.js\":\"ab55cd2c940f5a74\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/interaction-metrics/record.js\":\"916637aeca8a3f9e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/interaction-metrics/recordStore.js\":\"0abef3c9ef1f389c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/interaction-metrics/responsiveness.js\":\"13b173b105c83a16\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/interaction-metrics/schedule.js\":\"80c9297bf045a842\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/interaction-metrics/sessionContext.js\":\"a0cd1c2cd6fcd9e5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ff1d63d70ecc7bb0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c5db9b7111ea0e58\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/actions.js\":\"d965a2ee6113e636\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/config.js\":\"74a36a0966bcd251\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/dataExtension.js\":\"c7e8c7b08f7b8e1f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/effect.js\":\"1b78cd5e75e34989\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/index.js\":\"c18358d0cde7a1ca\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/keyCapture.js\":\"3c941dedb032a08b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/overrideStore.js\":\"7824227c073868b8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b00c4ea1c0dd7621\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/left-sidebar/HeaderItem.js\":\"4c5d8da2385684aa\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/left-sidebar/LeftSidebar.js\":\"8c1ab603a9ccbfcc\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/left-sidebar/actions.js\":\"b5a8f405e450c6b1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/left-sidebar/facet.js\":\"4b8426fdcea561e3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/left-sidebar/index.js\":\"14af3221d2bbfcb0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/left-sidebar/shortcuts.js\":\"a1906405ad35b55e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/left-sidebar/toggleStore.js\":\"61c1e9c50fb6199d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/merge-blocks/MergePicker.js\":\"49292334e56d4734\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/merge-blocks/index.js\":\"10fec0932b8a2cb6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/merge-blocks/mergeAction.js\":\"dfae5aed8c21db20\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/merge-blocks/strategy.js\":\"b577a2f66667a3b8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-bottom-nav/Button.js\":\"fcd92e5a09b674d2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0806f421a55bb508\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-bottom-nav/defaultItems.js\":\"62e3a96acbfaab67\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-bottom-nav/facet.js\":\"8bdb8ca19e66d4e3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-bottom-nav/index.js\":\"1a91e975aa4f5e4b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8637ab366cfd52f3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0409b55cfac7fe36\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6de79afd2571f4c9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-keyboard-toolbar/facet.js\":\"29ad680992fb238a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/mobile-keyboard-toolbar/index.js\":\"91298691060e693b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/move-blocks/MoveDestinationPicker.js\":\"8d93f06428ca8772\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9978c96db418cabe\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/move-blocks/contextMenuItem.js\":\"0d9ddd9d7c12487d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/move-blocks/index.js\":\"85561727ea24ce2f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/move-blocks/moveAction.js\":\"69aa8d56f79e64db\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/move-blocks/moveBlocks.js\":\"d1d04411e7938d24\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/move-blocks/selectionAfterMove.js\":\"432b4555dba9e161\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/onboarding/TutorialBanner.js\":\"664c21794b4d94bb\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/onboarding/action.js\":\"54d851c5e7b67a02\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/onboarding/bannerDismissal.js\":\"de8d2b06fab7486e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/onboarding/documents/cheatSheet.js\":\"6218ef6a9f5d9db1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/onboarding/index.js\":\"cbe72f6cd46a74a1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/onboarding/keys.js\":\"30136f4a28286f68\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/onboarding/landing.js\":\"9b24ce818c504952\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/onboarding/outline.js\":\"989f75e44e18400e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/onboarding/seed.js\":\"b49fa46fd802e3ef\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/PerfTrendDialog.js\":\"61ab5b346b80b685\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/analyze.js\":\"51e4e1c3c2c867e8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/diagnosticsSource.js\":\"2912690c65bc78be\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/index.js\":\"4d66806ff1171cec\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/load.js\":\"e907c37f8d696fcd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/monitorRun.js\":\"79378177f8e0c008\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/schedule.js\":\"71503bb954b66622\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/series.js\":\"10fa559e16997806\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/store.js\":\"1a0498e8dcd9928a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/trendAction.js\":\"8dd790d7bc30f3ee\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/perf-monitor/verdict.js\":\"43d579677b44c23d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/plain-outliner/clickToEditAction.js\":\"a93ae1a743607e70\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/plain-outliner/index.js\":\"4102c226890c42b8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/plain-outliner/interactions.js\":\"22d5c34e1df96a2f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"543cb5332238e3fc\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/properties-migration/MigrationGate.js\":\"a607c590a0f4fea9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/properties-migration/MigrationGateDialog.js\":\"0fb39975259b9bb3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/properties-migration/action.js\":\"0e9bebc4f447ae3b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/properties-migration/index.js\":\"aede61092975506f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/properties-migration/localRunMessage.js\":\"fb312f49e41446f3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/properties-migration/plugin.js\":\"7f80798d2ca0e6bf\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/properties-migration/progressReport.js\":\"49f9101e2359af30\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/properties-migration/sweepProgress.js\":\"f5a0f60c4cc1092f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/property-rows/FieldRowRenderer.js\":\"5b10c7bf8b58fb94\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/property-rows/ValueRowRenderer.js\":\"ba2b91ba58d62983\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/property-rows/actions.js\":\"674992fff9730ad1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/property-rows/autocomplete.js\":\"8765d25efca756e3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/property-rows/fieldRow.js\":\"2524beed7f6d374f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/property-rows/index.js\":\"80a749a6f9792f87\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/property-rows/referenceWarning.js\":\"3ad723569d76fa22\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/property-rows/valueAutocomplete.js\":\"e834f2d893769b01\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/property-rows/valueSchema.js\":\"6346e838c38fdf05\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/quick-find/HeaderItem.js\":\"76d5e103f389e2df\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/quick-find/QuickFind.js\":\"19dbb3ca19ab5340\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/quick-find/index.js\":\"2f4994ee8d285728\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/quick-find/recents.js\":\"1941194b038643db\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/quick-find/resultItems.js\":\"f932682caf6a4146\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/quick-find/selection.js\":\"416041b72fe98bcd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/quick-find/toggleStore.js\":\"8ca8bdf7ee3ab50a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/recents/HeaderItem.js\":\"242a9cc8536c52ad\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2af60e54f07b9884\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/recents/grouping.js\":\"93fd068d55a9a793\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/recents/index.js\":\"f63e5cc57adb3695\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/recents/target.js\":\"b830fa3dbabdc4bd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/codeMirrorExtensions.js\":\"a00a2205f14c60e9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/contentPrefill.js\":\"c82f1ecd0f3bccb4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/dataExtension.js\":\"5e78ffdef0e512bf\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/index.js\":\"0ebdc711a6654acb\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e619a556911c3a7b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/invalidation.js\":\"b80f84404a2114a1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/localSchema.js\":\"594f52fbe1e217d9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/markdown/blockrefs/index.js\":\"dbf6d806c08dfbcf\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b9417a8e997bf1d5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/markdown/index.js\":\"a28282ef6e929471\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/markdown/referenceNode.js\":\"a227b5b80699b5d2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ea35887a963ff355\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"df897861b88985a1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/markdown/wikilinks/index.js\":\"c9b03b9881c95a9d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7c6ab283e4c955e4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"206c626fe323fb58\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/mergeRetargetProcessor.js\":\"e252ca70258170b3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/parseFence.js\":\"591417f311483ee8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/referenceParser.js\":\"90706798e90505db\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/referenceProjection.js\":\"959f5b2381660308\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/referencesProcessor.js\":\"a9fc2aae437869e8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/renameProcessor.js\":\"e89052c6ce5ffc1c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/references/spanReplacement.js\":\"96f075d47ae012a2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/rich-paste/htmlToOutline.js\":\"a153080a84a90dd7\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/rich-paste/index.js\":\"d7d4be5879046244\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b17b9367c73889b7\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/rich-paste/pasteDecision.js\":\"95de53b0f5489b73\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/action.js\":\"ad2cad4993f40e24\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/blockIds.js\":\"7a83a5a08caac2f3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/content.js\":\"edfe420215429b2f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/effect.js\":\"75410263d3552dae\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/ids.js\":\"6284c41ad9426393\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/import.js\":\"897e16322bbbebec\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/index.js\":\"95787bf08ec43cf0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/plan.js\":\"4ad207ec541eec1d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/plugin.js\":\"6e93c275c6b4fde9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/promotion.js\":\"bd68b089f788b40a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/properties.js\":\"be5b342afb5ae075\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/references.js\":\"b37ca13aaf65c529\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/report.js\":\"56e1292553df04f0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/roamMemo.js\":\"1040902277861987\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/runtime.js\":\"6c4e57f4e11e3f15\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/schemaReconciliation.js\":\"60763ef31ecf4819\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/srsMarkers.js\":\"8c10a4f30dcd37f5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/todo.js\":\"4e82d3115ef83d87\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/typeCandidates.js\":\"60c7b83f0007c4d9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/roam-import/types.js\":\"1af9b5bd28fb56d4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/search-health/index.js\":\"a300e84af71d65a1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/search-health/store.js\":\"cd3c85dbf9746e84\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/shortcut-help/HeaderItem.js\":\"859c0a04c7e9cf4c\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"819dc21ac3ea6fe7\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/shortcut-help/index.js\":\"d5bd813b7e907c1d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/shortcut-help/model.js\":\"c0936fb25e3a8967\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/shortcut-help/toggleStore.js\":\"1ebfecfef55a50b6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/shortcut-help/useKeyInspector.js\":\"f8c0b3f5b191a488\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4397921d6dff4a8f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/spatial-navigation/ShellDecorator.js\":\"d03427c20aaa9b9d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/spatial-navigation/actions.js\":\"78b71071db3f2db8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a2400f0da85805c7\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/spatial-navigation/index.js\":\"27cb9dec1eff0995\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/spatial-navigation/shell.js\":\"653d1a157820a5ec\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/spatial-navigation/surface.js\":\"9cb83290a8e71db8\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/spatial-navigation/walker.js\":\"86d65d81a1c6ee19\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8e17f3dd01dbdb81\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/dataExtension.js\":\"b380a26df909ea69\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/index.js\":\"bdaa50a8d5c20e36\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/indicator.js\":\"b778cdb14efc5ced\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/moveSrsState.js\":\"03b5a5cd804b2823\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b6d2004baf5b06e4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/scheduler.js\":\"0a1c819e779c166b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/schema.js\":\"b9c68527d7d34b65\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c8533c24913e75d0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/srsClipboard.js\":\"60ca54fee7cc943f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b7e5f552573becce\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e96f266e0f7e9b7b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/DeckPicker.js\":\"ba991910c5344e52\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/ReviewControls.js\":\"41bd7120f8158473\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7214d5cc6ca19c4a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/ReviewSession.js\":\"b80aee80dca9ad4d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/actions.js\":\"74fec8bd8c2e961a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/archive.js\":\"1a212d619b7c5b34\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/dataExtension.js\":\"a1239a1a3a0f5790\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/deck.js\":\"d28c91264c60a5e9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/dueQuery.js\":\"9e1070b53d2dc64d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/gradeDecision.js\":\"2ca10d69d7c469d0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/index.js\":\"0980714a255c5dd0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/keyHints.js\":\"1c71d1a9a9402de3\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/reviewCardLayout.js\":\"e4002b9f91d0e71d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/reviewProgress.js\":\"fb06d1f4f1e2866f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/schema.js\":\"115163586e00d270\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/srs-review/useDueCards.js\":\"09f55b39c82750e1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/startup-metrics/index.js\":\"871c61ea3e19c3e2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/startup-metrics/record.js\":\"06a242da6b2f568d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/storage-persistence/index.js\":\"aacec1f35620433d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/storage-persistence/persistenceStatus.js\":\"7a3d337269eb029b\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/storage-persistence/requestAction.js\":\"6921ae6752226819\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/supertags/TypeChipsDecorator.js\":\"36d13dfcf8d111e2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/supertags/codeMirrorExtensions.js\":\"0081a03d0481f1dc\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/supertags/index.js\":\"118a94e66cf3cbe2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/supertags/typeAutocomplete.js\":\"63d54694902e89b6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"cceb2e89b1fff7b0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/swipe-quick-actions/actions.js\":\"4322645ea299b31a\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/swipe-quick-actions/anchor.js\":\"fc620c4f1eef0d44\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/swipe-quick-actions/events.js\":\"b7db73e2f94c3229\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/swipe-quick-actions/gestureActions.js\":\"1b173a5f8242aacf\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/swipe-quick-actions/index.js\":\"ab528eb3dc62e32e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"38aec4770a1f9aea\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/sync-metrics/collect.js\":\"efed3af798da89ef\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/sync-metrics/index.js\":\"4d16e6d4b7cabdd9\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/sync-metrics/record.js\":\"d172941b5f7a8301\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/system-status/RejectionDialog.js\":\"3477766189f3a407\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3d389083c47af3be\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/system-status/index.js\":\"9d47179ce90402f2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/system-status/model.js\":\"1e463a51334410ad\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/system-status/queueCounts.js\":\"530eaa65d66cf946\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/system-status/rejectedHelpers.js\":\"62f10848d0654149\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/system-status/rematerializeAction.js\":\"e631eaa32c3eab37\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/system-status/useHysteresis.js\":\"d9a5bdbe1fb1a113\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/theme-toggle/effect.js\":\"e0540dbdeeb065be\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/theme-toggle/index.js\":\"9498f39b6022cac4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/theme-toggle/theme.js\":\"8762ea65e7befbfd\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/todo/actions.js\":\"5c2bcde58a38c249\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/todo/dataExtension.js\":\"2f2ba0a92330eef2\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/todo/index.js\":\"3c5633949a4b4370\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/todo/schema.js\":\"2b59376d9999d83f\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0af7120bfd89043d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/touch-selection/actions.js\":\"cece43667dd9458d\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/touch-selection/defaultItems.js\":\"95c18c1cf06673a1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/touch-selection/facet.js\":\"e197a228c44521d0\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/touch-selection/holdRecognizer.js\":\"e0c0158e95cf0e86\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/touch-selection/index.js\":\"723815e423f6d2e4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/update-indicator/UpdateIndicator.js\":\"ed8cb3717005e3b6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/update-indicator/index.js\":\"bc1cd9911ca25003\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/update-indicator/loadTimes.js\":\"89356b8aea6e5db4\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/VideoNotesRenderer.js\":\"3ec947e7cd104327\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/VideoPlayerRenderer.js\":\"38bb2861ec9c06a5\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/VideoTimeStamp.js\":\"16f474f9b0a85777\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/actions.js\":\"fc0610e099bd1e49\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/index.js\":\"5a12068b50af8e24\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/markdown.js\":\"cfd986f30ea51c0e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/notes.js\":\"0480867603a3fea1\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/registry.js\":\"3b6b1f2f7557fb95\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/remark-timestamps.js\":\"c4d3f7b270109674\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/video-player/view.js\":\"8a2765a05badcd78\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/vim-link-hints/LinkHints.js\":\"e003bc2b7bde2bd6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/vim-link-hints/index.js\":\"80a2538c33180594\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/vim-link-hints/model.js\":\"eab61d9c22c0df24\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/vim-link-hints/settings.js\":\"e928af0a90d61867\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/vim-normal-mode/actions.js\":\"d1d30262cc1033e6\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/vim-normal-mode/index.js\":\"bf1eb800d63f2bfa\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/vim-normal-mode/interactions.js\":\"df68a8a17b22400e\",\"/knowledge-medium/pr-preview/pr-1797/src/plugins/workspace-header/index.js\":\"de558e4169d57600\",\"/knowledge-medium/pr-preview/pr-1797/src/registerServiceWorker.js\":\"cd39d9ea1cf032bb\",\"/knowledge-medium/pr-preview/pr-1797/src/requestPersistentStorage.js\":\"d9f2d5062ee87f79\",\"/knowledge-medium/pr-preview/pr-1797/src/services/authRequestDeadline.js\":\"5d701562f87e4f3c\",\"/knowledge-medium/pr-preview/pr-1797/src/services/authStorage.js\":\"3ce428f5cf249f0c\",\"/knowledge-medium/pr-preview/pr-1797/src/services/powersync.js\":\"692649a1e59b2db8\",\"/knowledge-medium/pr-preview/pr-1797/src/services/supabase.js\":\"2ffd4e6763e18ab4\",\"/knowledge-medium/pr-preview/pr-1797/src/services/uploadErrorClassifier.js\":\"9989beab29f7f234\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/ActiveContexts.js\":\"77b790db96ae206d\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/HotkeyReconciler.js\":\"8a487e259a197fa2\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/WipeLocalDataDialog.js\":\"274aa4e7c3018568\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/actionDispatch.js\":\"d63992cae20c29cf\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/actionRefItems.js\":\"b68056ab34d96ac5\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/applyKeybindingOverrides.js\":\"bcdb7024c954e00c\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/blockActions.js\":\"f7d9ebfb1472cd21\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/canonicalizeChord.js\":\"1ca0be852a624f33\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/defaultContexts.js\":\"c51f44b0667440f6\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/defaultShortcuts.js\":\"636812f6d8b8e261\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/effectiveActions.js\":\"9455af696866ac7d\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/gestureAction.js\":\"d5510a5320f503bc\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/gestureBinding.js\":\"b4beabb601d1e4f6\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/holdRegistry.js\":\"f213f4f9c18a777e\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/keybindingConflicts.js\":\"01554f24552d3c97\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/keybindingOverrides.js\":\"a2161c8c8af7016c\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/pointerAction.js\":\"3ab5b82e4f017297\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/resolve.js\":\"27841aad59777c17\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/runAction.js\":\"4b43ccd1d83ffc0b\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/sequenceMatcher.js\":\"a7daa640696fe0c3\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/types.js\":\"7112184cb53593ea\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/useActionContext.js\":\"92c3c854283516bd\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/useActionDiscovery.js\":\"224e61b9a05f354c\",\"/knowledge-medium/pr-preview/pr-1797/src/shortcuts/utils.js\":\"e1732441be31792d\",\"/knowledge-medium/pr-preview/pr-1797/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1797/src/sw/bootStore.js\":\"e66c7d9540a838d4\",\"/knowledge-medium/pr-preview/pr-1797/src/sw/previewDatabases.js\":\"de001531fdc2053d\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/byteTransform.js\":\"6aa06cb4f64d0b50\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/attachmentCleaner.js\":\"50d3ddad9b17f2bd\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/bundle/attachmentParts.js\":\"fb48f6fdbd34efec\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/bundle/bundleParts.js\":\"5145ba44f50b46f6\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/bundle/bundleRecord.js\":\"bf8ec76c35eaff68\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/bundle/manifest.js\":\"f87d20256c971f63\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/bundle/takeBundle.js\":\"a82bf816b5186648\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/bundle/verifyBundle.js\":\"cfed7c3091b9ffbe\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/cleaningStage.js\":\"1a680053c73e2261\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/conversionKey.js\":\"2a87579796f325ab\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/conversionServer.js\":\"563878e406e21da4\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/flip.js\":\"f9887b91d8e53974\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/flipAttempts.js\":\"c23d1ad3ccbb5dc3\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/pages.js\":\"a3e5cab851a81f50\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/preflight.js\":\"4aa6e761679607f5\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/reseal.js\":\"8ffd9a14934000ec\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/runConversion.js\":\"952e9e161f5669ca\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/runLock.js\":\"d7775716abfbc1d9\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/sealing.js\":\"afda025daed2063d\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/sealingStage.js\":\"5fe4a30e3f554863\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/stage.js\":\"7d5505095f1f842a\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/conversion/verifyReseal.js\":\"ecc30524ff026cf3\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/aad.js\":\"a3a9fec76efb2906\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/aead.js\":\"329428334072f7f2\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/base32.js\":\"1c162096013fc171\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/base64url.js\":\"42d49eada917f580\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/binaryEnvelope.js\":\"a0056d89e6612bec\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/byteAead.js\":\"54cf302c8b98f400\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/canary.js\":\"96634e09dc69ff0a\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/contentHash.js\":\"1161d86c53c607b3\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/contentKey.js\":\"cb9db79b65b62f5d\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/derivedIdNamespace.js\":\"837054728a9bb7db\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/envelope.js\":\"64f541c260cc68d0\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/hex.js\":\"439e6ad7094dc8cd\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/sha256Hex.js\":\"3bb5520ecbdc25f9\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/crypto/workspaceKey.js\":\"4d503b6c2ed923d1\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/conversionState.js\":\"288b3476390ae5cd\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5c8659c8d6a43d8b\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/flows/pastedKey.js\":\"94b16a39e02e4dfc\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4589cc75990be39a\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0778faac51399c87\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/keyStore.js\":\"b565e60588aa7222\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/mintWorkspaceKey.js\":\"7efa4e6aab692f40\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/modePin.js\":\"0d998e7df95b4cb6\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/openWorkspaceKeys.js\":\"3f710ad3461aa828\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/resolveWorkspaceEntry.js\":\"4d180700dba78e09\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/resolver.js\":\"5b4a45894c4b63a1\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/keys/workspaceAccess.js\":\"9a7cf498714fbc35\",\"/knowledge-medium/pr-preview/pr-1797/src/sync/transform.js\":\"54920d8d61d53286\",\"/knowledge-medium/pr-preview/pr-1797/src/themeBootDefaults.js\":\"7336f1888126ce1e\",\"/knowledge-medium/pr-preview/pr-1797/src/types.js\":\"696ffe381afca4d9\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/ClientLocalSettings.js\":\"2bdd3bd98af7f311\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/abortableSleep.js\":\"80b15409d8846a8a\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/array.js\":\"f96f3bddc7f04a60\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/backlinkAutocomplete.js\":\"00ea3cd7cb15d981\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/blockCrumbs.js\":\"f4a03b7b7e3a9f3f\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/blockrefAutocomplete.js\":\"2f382bcce593901d\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/cadencedIdleJob.js\":\"c898c73b87a17e60\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/callbackSet.js\":\"b5063d8fba3ce32f\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/clientId.js\":\"91f1418fda968ac7\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/codemirror.js\":\"95899980322063b5\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/codemirrorCompletion.js\":\"0e9c09b5f8211cc1\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/copy.js\":\"0e62e86d9eb95647\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/dailyPage.js\":\"91c56896e0ef28fd\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/dbForensics.js\":\"3e6eeb27217b3f63\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/dbForensicsHooks.js\":\"88f6565dc5e91429\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/deleteBlockThroughUi.js\":\"60e7eeb7e3d68734\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/dialogs.js\":\"c969f539ff0013ce\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/dom.js\":\"cb950f6aeac63ec1\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/downloadBlob.js\":\"9fee22ac8e260d09\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/exportSqliteDb.js\":\"094109ddaf6ad5ff\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/fileSystemAccess.js\":\"4d630f26758b52a6\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/flipSlide.js\":\"e1785f66d597ae99\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/fnv1a.js\":\"85dddd784146aa8b\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/formatBytes.js\":\"b3e91950fe41d1fa\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/fuzzyRank.js\":\"5f992765e0130e34\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/idbKeyedStore.js\":\"7c831da89f57ca1b\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/idleCallbackPolyfill.js\":\"0930f69ad6dc1ac0\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/keyboardAwareScroll.js\":\"af9202f1543634a7\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/keyboardViewport.js\":\"c8c64a61b9cd9768\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/lastWorkspace.js\":\"cf377dd220f4183e\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/layoutColumns.js\":\"fb432016760d1cd3\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/layoutSessionDom.js\":\"4ad936d44e51a0d7\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/layoutSessionId.js\":\"7d55e78424c810cd\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/linkClickGestures.js\":\"459611ba5b44dde8\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/linkTargetAutocomplete.js\":\"0106da3b91cfa411\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/localDbCorruption.js\":\"97845bf66e5150a1\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/localDbRecovery.js\":\"e97bdfee654e0e38\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/markdownParser.js\":\"d99f9e0961efbea1\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/memoize.js\":\"e372518dfa2aa8f5\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/nameFieldCommit.js\":\"08d63910ea01c4c8\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/nameList.js\":\"1bcbea6140401dc4\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/navigation.js\":\"754334391aa94874\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/omnilinerNamespace.js\":\"601f49b8972febaa\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/opfsPageScan.js\":\"2c7932b9d59002c6\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/panelClearance.js\":\"0bb5bf956575e19b\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/panelHistory.js\":\"1b8577465640d15b\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/panelLanes.js\":\"f98748e18f69e00d\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/panelLayoutProjection.js\":\"587d9c24e2298dc8\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/panelScrollAnchor.js\":\"eb6242d4817a6a0f\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/panelUrlFlags.js\":\"8c104aa0ce7c96ff\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/platform.js\":\"a9ac9d468d41e9ad\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/pluralize.js\":\"559fc43c9893d2a7\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/propertyCreation.js\":\"f1080895e8d6a8b6\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/propertyNavigation.js\":\"b1688b220a66cef8\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/propertyValueContext.js\":\"b25b3ab1365f9b83\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/react.js\":\"cc07a5a5b28a71fb\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/relativeDate.js\":\"fa5d6a861b66fb5d\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/relativeTime.js\":\"33bef5f47bd84be4\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/renderScope.js\":\"f427298178aa8ea0\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/resolvedThenable.js\":\"b0fc79b0ef36dfed\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/routing.js\":\"76d82db5c00a2a37\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/safeMode.js\":\"ae56f209054724b8\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/scheduleIdle.js\":\"5f27d6e45ae40210\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/screenWakeLock.js\":\"0dda9aaf63b28804\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/selection.js\":\"8e5b7d83e84efc01\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/softKeyboardGrab.js\":\"74d4ec6f6e5a8e11\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/startupTimeline.js\":\"7df510e6e948798e\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/state.js\":\"d03710e22e6220df\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/string.js\":\"3878dda7a0c40b77\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/surfaceZoom.js\":\"04d6987b270282e0\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/time.js\":\"34aa8ecb52b368f0\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/toast.js\":\"4f0bfd589d095e8e\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/toggleStore.js\":\"d046845495de1de5\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/untilStopped.js\":\"0d81b5b349c77611\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/userActivity.js\":\"74df1d08b4077454\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/viewTransition.js\":\"595df00470fadb4c\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/viewport.js\":\"667d13a1d8c38657\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/webLock.js\":\"8068c920a3bbd7b9\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/workspaceRecovery.js\":\"ea7cfd0cbec1a8bb\",\"/knowledge-medium/pr-preview/pr-1797/src/utils/workspaceSnapshotStore.js\":\"ce54e383f2d8072d\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-compiler-runtime.js\":\"465d49c5a56bf397\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-dom-client.js\":\"971635e2c61cd6fe\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-dom-server-edge.js\":\"30269090cb4e9a11\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-dom-server.js\":\"09a23c781defadf8\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-dom-static-edge.js\":\"10917c1b3685dd3a\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-dom-static.js\":\"63fed213c44e4fbb\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-dom-test-utils.js\":\"48177c3a341e2038\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-dom.js\":\"20a5132c82616d6c\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react-jsx-runtime.js\":\"5f05c8892573a48b\",\"/knowledge-medium/pr-preview/pr-1797/src/vendor/react.js\":\"5c1087db0aac114f\",\"/knowledge-medium/pr-preview/pr-1797/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1797/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1797/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
