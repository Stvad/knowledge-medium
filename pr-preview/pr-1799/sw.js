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
		buildId: "635833c7c152-bf45f3f6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1799/\":\"0360552b5a13a04c\",\"/knowledge-medium/pr-preview/pr-1799/index.html\":\"0360552b5a13a04c\",\"/knowledge-medium/pr-preview/pr-1799/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1799/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1799/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1799/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1799/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1799/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1799/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1799/assets/FacadeVFS-8Z1iX5Jd.js\":\"cc0895a4e2410ca8\",\"/knowledge-medium/pr-preview/pr-1799/assets/OPFSCoopSyncVFS-dSsxDyU5.js\":\"075ed0012726fbef\",\"/knowledge-medium/pr-preview/pr-1799/assets/OPFSWriteAheadVFS-AyxerhCa.js\":\"e32c4464f79cbcfd\",\"/knowledge-medium/pr-preview/pr-1799/assets/wa-sqlite-C70entQB.js\":\"b10a4e5cd1d5742d\",\"/knowledge-medium/pr-preview/pr-1799/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1799/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1799/assets/wa-sqlite-async-C1vz02qb.js\":\"4e9bb087b62c0c6d\",\"/knowledge-medium/pr-preview/pr-1799/assets/worker-BK6isXIa.js\":\"f2bcc0e69aa74d5d\",\"/knowledge-medium/pr-preview/pr-1799/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1799/chunks/app-D9Uavi2w.js\":\"65bdab1fd5987a6e\",\"/knowledge-medium/pr-preview/pr-1799/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1799/index.js\":\"69f26a933dae80af\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1799/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1799/assets/AccessHandlePoolVFS-BaRAzMjZ.js\":\"3c5a1911d9a328e6\",\"/knowledge-medium/pr-preview/pr-1799/assets/IDBBatchAtomicVFS-Dqqpj2_h.js\":\"f8bdfea819f47a0d\",\"/knowledge-medium/pr-preview/pr-1799/assets/MemoryVFS-Dlcj9nv1.js\":\"e3343bb07eb6667c\",\"/knowledge-medium/pr-preview/pr-1799/assets/mc-wa-sqlite-CX3npse8.js\":\"411fad2141329632\",\"/knowledge-medium/pr-preview/pr-1799/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1799/assets/mc-wa-sqlite-async-Bj3TVDgl.js\":\"4535cbd529ea7434\",\"/knowledge-medium/pr-preview/pr-1799/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1799/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1799/chunks/AccessHandlePoolVFS-DpAOZdQa.js\":\"731a52a1c17f22a1\",\"/knowledge-medium/pr-preview/pr-1799/chunks/FacadeVFS-Md1aJtRj.js\":\"6edc8c21417f88a9\",\"/knowledge-medium/pr-preview/pr-1799/chunks/IDBBatchAtomicVFS-BjnJOfbX.js\":\"2ddbe5c92f19e48f\",\"/knowledge-medium/pr-preview/pr-1799/chunks/MemoryVFS-BH4L4nIY.js\":\"6497465afa9381dd\",\"/knowledge-medium/pr-preview/pr-1799/chunks/OPFSCoopSyncVFS-BrqJT7MB.js\":\"7e9b2bfb50620ecb\",\"/knowledge-medium/pr-preview/pr-1799/chunks/OPFSWriteAheadVFS-BUdLj-s3.js\":\"006a7f5dd50304a2\",\"/knowledge-medium/pr-preview/pr-1799/chunks/Preview-CjomXdIP.js\":\"2789207629b9b655\",\"/knowledge-medium/pr-preview/pr-1799/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1799/chunks/card-Ru9uCOC9.js\":\"3e926bbee05c2670\",\"/knowledge-medium/pr-preview/pr-1799/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1799/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1799/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1799/chunks/dist-CPYdi5z_.js\":\"218f0b6bbfc03ff0\",\"/knowledge-medium/pr-preview/pr-1799/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1799/chunks/mc-wa-sqlite-CjWtpEMm.js\":\"aa3116f2c1194b80\",\"/knowledge-medium/pr-preview/pr-1799/chunks/mc-wa-sqlite-async-CShEazUX.js\":\"9f9b744b4eeed1fd\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-Bf3U9yG2.js\":\"fe15d8818555510a\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-CKjZoajP.js\":\"f2106409c5c0c0b2\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-CdoXYLRn.js\":\"8e56797ff1ab6351\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-CfgcvQ0m.js\":\"bbc374942dd853cc\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-ClmF3FUl.js\":\"87cdba6e0de99886\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-Di3S32Rf.js\":\"750c17c911985282\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-L2writt1.js\":\"7bf159240604208e\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-dom-server-legacy.browser.production-_nQcBhVI.js\":\"053fa78bc6f6bf1e\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-dom-server.browser.production-CCWq1Dwk.js\":\"1cc589dffdda7af7\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-dom-server.edge.production-B8Vpy1ow.js\":\"168328bf35c43377\",\"/knowledge-medium/pr-preview/pr-1799/chunks/react-eVwN5kch.js\":\"ad8301841ff8c271\",\"/knowledge-medium/pr-preview/pr-1799/chunks/server.browser-DXn3s6hh.js\":\"7788c0e1527d7fc2\",\"/knowledge-medium/pr-preview/pr-1799/chunks/textarea-Bf23ikbg.js\":\"e63f933147d96dc2\",\"/knowledge-medium/pr-preview/pr-1799/chunks/ui-3IEagSre.js\":\"d180fa4cda28ba28\",\"/knowledge-medium/pr-preview/pr-1799/chunks/wa-sqlite-Brek2Eqh.js\":\"b1e43c66af2c929e\",\"/knowledge-medium/pr-preview/pr-1799/chunks/wa-sqlite-async-D3kJQNXT.js\":\"d4e9b0753dfec16a\",\"/knowledge-medium/pr-preview/pr-1799/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1799/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1799/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1799/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1799/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1799/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1799/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1799/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1799/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1799/src/App.js\":\"4f3fd51d02fb2240\",\"/knowledge-medium/pr-preview/pr-1799/src/appUpdate.js\":\"2a888be409b73d3d\",\"/knowledge-medium/pr-preview/pr-1799/src/appVersion.js\":\"41128c87e9ee28c9\",\"/knowledge-medium/pr-preview/pr-1799/src/bootstrap/initialLayout.js\":\"e0a4b5673fbd9172\",\"/knowledge-medium/pr-preview/pr-1799/src/bootstrap/openWorkspaceData.js\":\"c4abaa7dc1bed382\",\"/knowledge-medium/pr-preview/pr-1799/src/bootstrap/resolveWorkspace.js\":\"0651c0dbaf2998de\",\"/knowledge-medium/pr-preview/pr-1799/src/bootstrap/workspaceBootstrap.js\":\"0485722461c63599\",\"/knowledge-medium/pr-preview/pr-1799/src/components/BlockComponent.js\":\"bbaae8629e8fc0a7\",\"/knowledge-medium/pr-preview/pr-1799/src/components/BlockCrumbs.js\":\"caaa597d61827b5e\",\"/knowledge-medium/pr-preview/pr-1799/src/components/BlockEditor.js\":\"c43577a545bd1e87\",\"/knowledge-medium/pr-preview/pr-1799/src/components/BlockLoadingPlaceholder.js\":\"22bc6d5c13482189\",\"/knowledge-medium/pr-preview/pr-1799/src/components/BlockProperties.js\":\"d1ccb926c8284f01\",\"/knowledge-medium/pr-preview/pr-1799/src/components/BlockSearchPicker.js\":\"250032358eedb774\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ConfirmBulkDeleteDialog.js\":\"becc462901ea26bf\",\"/knowledge-medium/pr-preview/pr-1799/src/components/DividerHandle.js\":\"26ffc29ccc188fda\",\"/knowledge-medium/pr-preview/pr-1799/src/components/DraftEditor.js\":\"1e1d09319215c720\",\"/knowledge-medium/pr-preview/pr-1799/src/components/GutterPill.js\":\"f0d8e1137726703a\",\"/knowledge-medium/pr-preview/pr-1799/src/components/Header.js\":\"d13fbbf84bce75d2\",\"/knowledge-medium/pr-preview/pr-1799/src/components/LazyBlockComponent.js\":\"cc2276fa81c5cea4\",\"/knowledge-medium/pr-preview/pr-1799/src/components/Login.js\":\"e72bdb10d0dca480\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ZoomableSurface.js\":\"ee773af0771b400b\",\"/knowledge-medium/pr-preview/pr-1799/src/components/editModeKeepalive.js\":\"400b71b8dfadaeb5\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyDisplay/PropertyDisplayScope.js\":\"579cb4cec721a9ed\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e185829210255937\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyEditors/RefPropertyEditor.js\":\"fa4d1c390b756a8f\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyEditors/RefTargetTypePicker.js\":\"f52e659ef3a09cca\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyEditors/SelectPropertyEditor.js\":\"7c11ea34ff567d21\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyEditors/TypesPropertyEditor.js\":\"c9d5d8cbfee6fc6b\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyEditors/defaults.js\":\"a4f64bf47f3e4882\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyEditors/kernelValuePresets.js\":\"d21672c9c5ec3e78\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyEditors/selectablePresets.js\":\"bbecee50b2df7b9e\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyEditors/typesPropertyUi.js\":\"2880ec5a47ebd626\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/AddPropertyForm.js\":\"84b92f8d9ffb7912\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/PropertyPicker.js\":\"eed940c722d9c94d\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/PropertyRow.js\":\"66d84fe2ffc3b5f0\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/Rows.js\":\"e025ac0a2e68118c\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/actions.js\":\"ac4f048f179ab396\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/declarationOnly.js\":\"b737406c27ca44e4\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/layout.js\":\"afc1a18cb1fc4b82\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/model.js\":\"ece49c8ac8802518\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/shapeUi.js\":\"f3a2ee78c0e4bbdc\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/shapes.js\":\"73a54baa48a2444a\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2eb7eda24cb6d77d\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanel/visibility.js\":\"45054c84e97aaed8\",\"/knowledge-medium/pr-preview/pr-1799/src/components/propertyPanelSections.js\":\"a803fe63ccc12e9c\",\"/knowledge-medium/pr-preview/pr-1799/src/components/references/BlockEmbed.js\":\"4a26f79f46a81c8c\",\"/knowledge-medium/pr-preview/pr-1799/src/components/references/BlockLink.js\":\"7b32c81e98d666c5\",\"/knowledge-medium/pr-preview/pr-1799/src/components/references/BlockRef.js\":\"797888ffd0723190\",\"/knowledge-medium/pr-preview/pr-1799/src/components/references/ReferenceLink.js\":\"eabf8965692ba507\",\"/knowledge-medium/pr-preview/pr-1799/src/components/references/cycleGuard.js\":\"6367ff0cede3ceae\",\"/knowledge-medium/pr-preview/pr-1799/src/components/references/cycleGuardContext.js\":\"e2383b82fe79d650\",\"/knowledge-medium/pr-preview/pr-1799/src/components/references/linkInteraction.js\":\"4b7fe2a082b4ef2f\",\"/knowledge-medium/pr-preview/pr-1799/src/components/references/referenceLayout.js\":\"6707f19354dad9c6\",\"/knowledge-medium/pr-preview/pr-1799/src/components/references/useBlockRefAncestors.js\":\"51c83261a1b1eb82\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/BlockGutter.js\":\"dc621cda5e47643b\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/BlockInfoDialog.js\":\"15c2142254b4b76d\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/BlockTypeBlockRenderer.js\":\"ee179aeb6d01bb97\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/BulletHoverCard.js\":\"2eb1870e3e450b49\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/CodeMirrorContentRenderer.js\":\"f4d8fda6743a804e\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d67960ce0aa681ed\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/ColumnResizeHandles.js\":\"87e71564adca25e3\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"8d876cde2f9af160\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/DefaultBlockRenderer.js\":\"e820570ebb03abb1\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/LayoutRenderer.js\":\"2f28017ce645737a\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/MarkdownContentRenderer.js\":\"21e94392e45418a4\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/MissingDataRenderer.js\":\"69be8770b5bacc0d\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/PanelRenderer.js\":\"e3a044db99f1b874\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3370808646ba1ffa\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/TopLevelRenderer.js\":\"3b9b7871ebc60d73\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/blockGutterMode.js\":\"6d73ab468dfcd78a\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/blockTitleText.js\":\"c23c79e9479b7910\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/fieldCreationKeydown.js\":\"b92253c2ed0ae282\",\"/knowledge-medium/pr-preview/pr-1799/src/components/renderer/layoutRootContext.js\":\"de216e355e7299b5\",\"/knowledge-medium/pr-preview/pr-1799/src/components/typeChip/TypeChip.js\":\"a9232eae97d70e3e\",\"/knowledge-medium/pr-preview/pr-1799/src/components/typeChip/chipStyle.js\":\"5d793f8d4506c218\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/anchored-floating.js\":\"50e6e6b01d00127a\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/button.js\":\"649f03940db98377\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/card.js\":\"bc61b3f4314d2e9a\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/checkbox.js\":\"fb3dda3c9364eb88\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/collapsible.js\":\"78dbfc653de6b646\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/command.js\":\"b21276f77cd49e45\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/context-menu.js\":\"5e3020285e3371cc\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/dialog.js\":\"d25c8455a8672b8d\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/dropdown-menu.js\":\"68677504c9a230d1\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/floating-listbox.js\":\"9df3a09b7dfb1328\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/index.js\":\"9e91400e9f62c5d4\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/input.js\":\"83fb856c1a4b5a0e\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/kbd.js\":\"e03f9284272f383b\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/label.js\":\"0cc0ca583b3d3a29\",\"/knowledge-medium/pr-preview/pr-1799/src/components/ui/textarea.js\":\"a60bd31b300028d6\",\"/knowledge-medium/pr-preview/pr-1799/src/components/useEditModeYieldKeepalive.js\":\"a5a210bad4643a17\",\"/knowledge-medium/pr-preview/pr-1799/src/components/util/BootFallback.js\":\"68bb38fd2ca5b02d\",\"/knowledge-medium/pr-preview/pr-1799/src/components/util/FocusedRowLazyMount.js\":\"7155575ca225e0e6\",\"/knowledge-medium/pr-preview/pr-1799/src/components/util/LazyViewportMount.js\":\"de7e4c35f0a1416d\",\"/knowledge-medium/pr-preview/pr-1799/src/components/util/LocalDbCorruptionFallback.js\":\"6c60398e555f39a5\",\"/knowledge-medium/pr-preview/pr-1799/src/components/util/error.js\":\"cc6d3ce28ea45433\",\"/knowledge-medium/pr-preview/pr-1799/src/components/util/lazyMountRegistry.js\":\"cab4fd80024e061a\",\"/knowledge-medium/pr-preview/pr-1799/src/components/util/suspense.js\":\"c55f0198aeccc008\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/CreateWorkspaceDialog.js\":\"555b07fb91c1c932\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/PendingInvitations.js\":\"e6343038a0ced011\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/SyncProgress.js\":\"e41200e82d803fc2\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/UnlockProgress.js\":\"85ff8217a3ef4052\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/WorkspaceKeyGate.js\":\"24c3295363124778\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/WorkspaceSettingsDialog.js\":\"7417bfc8a26017d0\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/WorkspaceSwitcher.js\":\"d0e9780e1681dddb\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/WorkspaceSyncGate.js\":\"0b6ba9f2549a9e06\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/conversion/ConversionFlow.js\":\"0b7e149691b6727c\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/conversion/ConversionFlowHost.js\":\"cdd1998f440c841c\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/conversion/EncryptionSection.js\":\"869dfed8dd901d0d\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/conversion/attachmentPrompts.js\":\"35b90830d15100fb\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f1bb2509d3a6c14a\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/conversion/conversionFlowDeps.js\":\"c9d69d317c282649\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/conversion/conversionFlowStore.js\":\"06070b7d2c1b3fe2\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/conversion/flowUi.js\":\"cdee0a97cb8e1edc\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/conversion/useConversionRun.js\":\"63c90a61bbb91a20\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/keyUi.js\":\"2985e18ed285b8c7\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/useCloseOnKeyLoss.js\":\"a7e701f3f043f0ff\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/useCloseOnServerE2ee.js\":\"46d143633963fc6d\",\"/knowledge-medium/pr-preview/pr-1799/src/components/workspace/workspaceUnlocked.js\":\"6a12c74c54f7a4e7\",\"/knowledge-medium/pr-preview/pr-1799/src/context/backgroundSubtree.js\":\"bbacd98827498d94\",\"/knowledge-medium/pr-preview/pr-1799/src/context/block.js\":\"69a15d25badace46\",\"/knowledge-medium/pr-preview/pr-1799/src/context/layoutWsContext.js\":\"72cf3438cf3fc7be\",\"/knowledge-medium/pr-preview/pr-1799/src/context/propertyDisplay.js\":\"db9daf34ee2e1af0\",\"/knowledge-medium/pr-preview/pr-1799/src/context/repo.js\":\"b2933052d556dd80\",\"/knowledge-medium/pr-preview/pr-1799/src/data/aliasClaim.js\":\"ef2b3afe554638e9\",\"/knowledge-medium/pr-preview/pr-1799/src/data/aliasSeatNamespace.js\":\"b8f0092333e187ec\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/blockData.js\":\"b0fb0bc806b81878\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/blockType.js\":\"32cf35cc8a29c93d\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/changeScope.js\":\"514b2828af44ce93\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/codecs.js\":\"585c40b81ae38294\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/derivedData.js\":\"29f90c00c671cdd5\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/errors.js\":\"04b7272f96992812\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/events.js\":\"a6a110bb94012051\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/handle.js\":\"3ca86ab448a02b3e\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/index.js\":\"3f84cb1ed5ead288\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/mutator.js\":\"0fb7629c963b546d\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/processor.js\":\"cede30927b20c68f\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/propertySchema.js\":\"7d1044c997bc6c9c\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/query.js\":\"93e0738c5601e404\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/sameTxProcessor.js\":\"8173e0e8042bd7a5\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/schema.js\":\"3ca86ab448a02b3e\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/tx.js\":\"3ca86ab448a02b3e\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/typedBlockQuery.js\":\"023cb2bcd51839af\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/user.js\":\"459ec6ca64ef35b1\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/valuePresetCore.js\":\"808f3b43a32db067\",\"/knowledge-medium/pr-preview/pr-1799/src/data/api/valuePresets.js\":\"00a8b22e29c09615\",\"/knowledge-medium/pr-preview/pr-1799/src/data/attachmentCleanerIOVerb.js\":\"281956b5b86e8c01\",\"/knowledge-medium/pr-preview/pr-1799/src/data/block.js\":\"61730cf722f0b42b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/blockCache.js\":\"d544866790ebad7d\",\"/knowledge-medium/pr-preview/pr-1799/src/data/blockId.js\":\"7a5e8e7d6f626ff8\",\"/knowledge-medium/pr-preview/pr-1799/src/data/blockLiveness.js\":\"391e832d021e3809\",\"/knowledge-medium/pr-preview/pr-1799/src/data/blockMerge.js\":\"d6ca9671fe65a757\",\"/knowledge-medium/pr-preview/pr-1799/src/data/blockSchema.js\":\"b55e923f4ca55f31\",\"/knowledge-medium/pr-preview/pr-1799/src/data/blockTypes.js\":\"45c6cfe19ece371b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/clientContext.js\":\"77ca59956c7846ca\",\"/knowledge-medium/pr-preview/pr-1799/src/data/dbFileSiblings.js\":\"5a5532e1611b8c66\",\"/knowledge-medium/pr-preview/pr-1799/src/data/definitionSeeds.js\":\"19158aa33c296eeb\",\"/knowledge-medium/pr-preview/pr-1799/src/data/derivedIds.js\":\"840c00cd76890549\",\"/knowledge-medium/pr-preview/pr-1799/src/data/drawnSubtree.js\":\"44c6e5568850c067\",\"/knowledge-medium/pr-preview/pr-1799/src/data/facetBridge.js\":\"2ce75c7e970bb30e\",\"/knowledge-medium/pr-preview/pr-1799/src/data/facets.js\":\"2330717f97664b50\",\"/knowledge-medium/pr-preview/pr-1799/src/data/globalState.js\":\"aff4405c3fd05dc5\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/aliasClaimRederiveProcessor.js\":\"83389c86e3499827\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/ancestorBatch.js\":\"37b7c81e507219dc\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/blockTypeTypeifyProcessor.js\":\"fb2816d160d63286\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/clientSchema.js\":\"ca75f94d140e9388\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/commitPipeline.js\":\"fa93d772e011cb44\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/devAssertions.js\":\"7d5c49ca7ce9e6d4\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/firstSync.js\":\"0687b51a92fb2493\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/freshInitialLoad.js\":\"740dc7e16e7c1a1b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/graphBackfillClaim.js\":\"25470d47d77e5813\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/handleStore.js\":\"7cfbd078e183dc84\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/idleMarkerJobs.js\":\"1ca4d0f785d16ccf\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/initialDownload.js\":\"d594f723d6d582a3\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/initializeClientDatabase.js\":\"a373053c1983084d\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/jsonCanonical.js\":\"fe9fd43c19ed232b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/kernelInvalidation.js\":\"2b3f0d7c9952d191\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/kernelProcessors.js\":\"62d8250a80de6071\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/kernelQueries.js\":\"fc1e6264ec4472c5\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/mergeTypeMembershipProcessor.js\":\"caf63af90a3e97ed\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/normalizeReferencesProcessor.js\":\"a986a18bb90a3d07\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/poolInstrumentation.js\":\"2282d1ce2016e329\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/processorRunner.js\":\"507c8985080de6df\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/propertyCellBackfill.js\":\"2e9ad91de5bd9e51\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/propertyChildMint.js\":\"d2b33c4807436d05\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/propertyChildrenProcessor.js\":\"8a3d838808f512fb\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4c8a8a3945282d6f\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/propertyDefinitionSynthesis.js\":\"87a6eac227da102a\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/propertyKeyScan.js\":\"4e73ee0fbd2d7ea9\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/propertySchemaResolution.js\":\"d4e3cf679b545d8b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/propertyValueEdits.js\":\"541ab6422d7db574\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/raiseProtocol.js\":\"593308f593c3c3b5\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/readBatch.js\":\"db83a4fabbeb3122\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/refProjection.js\":\"a2c5271f757be3b4\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/referenceTargetLookups.js\":\"c04aaa17dfa755e8\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/referenceTargetProcessor.js\":\"4e7b57e615dc7e76\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/replayMerge.js\":\"81927972dbafd0aa\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/sqlBinds.js\":\"4ed1de8573c7d946\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"255adcb036648a40\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/syncObserver/arrivalProcessors.js\":\"e70a1ca95bde9375\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/syncObserver/invalidate.js\":\"fbfc01ee608f9665\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/syncObserver/materialize.js\":\"9f7080e24c886e87\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/syncObserver/observer.js\":\"2a40275fcf718d85\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/syncObserver/reconcile.js\":\"f8e594d92b77dc93\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/timingMetrics.js\":\"a147112de74f4f7e\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/treeQueries.js\":\"af17e0c941e33343\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/txEngine.js\":\"d2ee8978d4c1f49c\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/txSnapshots.js\":\"559f45927898bfc5\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/typedBlockQuery.js\":\"f93b552df967e666\",\"/knowledge-medium/pr-preview/pr-1799/src/data/internals/undoManager.js\":\"278ea4dfb5fa5b2c\",\"/knowledge-medium/pr-preview/pr-1799/src/data/invalidation.js\":\"b88c8ecba7c4826c\",\"/knowledge-medium/pr-preview/pr-1799/src/data/kernelDataExtension.js\":\"5711db20e3ad2dbd\",\"/knowledge-medium/pr-preview/pr-1799/src/data/kernelPage.js\":\"1e3ae196e6274e53\",\"/knowledge-medium/pr-preview/pr-1799/src/data/kernelValuePresetCores.js\":\"cd3e4011d8568e12\",\"/knowledge-medium/pr-preview/pr-1799/src/data/localDbCorruptionSignal.js\":\"babbba96802f20bc\",\"/knowledge-medium/pr-preview/pr-1799/src/data/localDbStorage.js\":\"e2763a179e3855ab\",\"/knowledge-medium/pr-preview/pr-1799/src/data/localDbVfs.js\":\"45fee454fe0b6851\",\"/knowledge-medium/pr-preview/pr-1799/src/data/localSchema.js\":\"2dd259c480555b5b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/maintenance.js\":\"4757c94d6c50863f\",\"/knowledge-medium/pr-preview/pr-1799/src/data/mergeProperties.js\":\"cdedc64fd7c8bd11\",\"/knowledge-medium/pr-preview/pr-1799/src/data/metricsConsoleHook.js\":\"29d4b39d2de61521\",\"/knowledge-medium/pr-preview/pr-1799/src/data/migrationsPage.js\":\"42574d34272631f2\",\"/knowledge-medium/pr-preview/pr-1799/src/data/mutators.js\":\"f9e5f8b0ab099cae\",\"/knowledge-medium/pr-preview/pr-1799/src/data/orderKey.js\":\"98880d5291932506\",\"/knowledge-medium/pr-preview/pr-1799/src/data/orderKeyPlacement.js\":\"cd61202b5daa7c26\",\"/knowledge-medium/pr-preview/pr-1799/src/data/outlineSurface.js\":\"399129315741f912\",\"/knowledge-medium/pr-preview/pr-1799/src/data/pendingEditorContent.js\":\"dabdac05d7420b3e\",\"/knowledge-medium/pr-preview/pr-1799/src/data/pendingUploadsSql.js\":\"61d8ae419d2f2706\",\"/knowledge-medium/pr-preview/pr-1799/src/data/pluginStateExtensions.js\":\"e73beb2a9b9d94ea\",\"/knowledge-medium/pr-preview/pr-1799/src/data/powerSyncLogger.js\":\"693f04f95839e669\",\"/knowledge-medium/pr-preview/pr-1799/src/data/projectorRuntime.js\":\"0da376552d36ccd5\",\"/knowledge-medium/pr-preview/pr-1799/src/data/properties.js\":\"0aa08fd1311c469b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/propertiesPage.js\":\"9243cb9e88455ba8\",\"/knowledge-medium/pr-preview/pr-1799/src/data/propertyChildren.js\":\"c3c92ed2e68831f4\",\"/knowledge-medium/pr-preview/pr-1799/src/data/propertyDefinitionFanout.js\":\"56e19dae3982ccc9\",\"/knowledge-medium/pr-preview/pr-1799/src/data/propertyDefinitionMetadata.js\":\"877a74fc884c646f\",\"/knowledge-medium/pr-preview/pr-1799/src/data/propertyDefinitionRegistry.js\":\"95ad5a4553b04fae\",\"/knowledge-medium/pr-preview/pr-1799/src/data/propertyDisplayMode.js\":\"7f8868964cdf7e9c\",\"/knowledge-medium/pr-preview/pr-1799/src/data/propertyRowCreation.js\":\"f0dd9ab4802eea47\",\"/knowledge-medium/pr-preview/pr-1799/src/data/propertySchemaCreation.js\":\"422a38d43c49d651\",\"/knowledge-medium/pr-preview/pr-1799/src/data/propertySeeds.js\":\"da772c911ce301c2\",\"/knowledge-medium/pr-preview/pr-1799/src/data/recentsPage.js\":\"b256b675558c15af\",\"/knowledge-medium/pr-preview/pr-1799/src/data/referenceBlock.js\":\"ea64f125be59e536\",\"/knowledge-medium/pr-preview/pr-1799/src/data/rejectedUploads.js\":\"68d68cdd848c62b2\",\"/knowledge-medium/pr-preview/pr-1799/src/data/releasePowerSyncConnection.js\":\"eedd35b1bbcc99a4\",\"/knowledge-medium/pr-preview/pr-1799/src/data/repo.js\":\"fbe24a51214fb461\",\"/knowledge-medium/pr-preview/pr-1799/src/data/repoProvider.js\":\"35063ccfc69c208c\",\"/knowledge-medium/pr-preview/pr-1799/src/data/rowProperty.js\":\"a22f7c958f0c723b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/searchFilter.js\":\"ec17c236baf1be38\",\"/knowledge-medium/pr-preview/pr-1799/src/data/seedIdentityLedger.js\":\"229a625bc5a3ea60\",\"/knowledge-medium/pr-preview/pr-1799/src/data/stateBlocks.js\":\"f39c890616c30c69\",\"/knowledge-medium/pr-preview/pr-1799/src/data/structuralEditPolicy.js\":\"7363fc3ce2018d6e\",\"/knowledge-medium/pr-preview/pr-1799/src/data/subtreeDelete.js\":\"6bbf87e90e228c05\",\"/knowledge-medium/pr-preview/pr-1799/src/data/syncStreamLock.js\":\"7d131f841a933ab6\",\"/knowledge-medium/pr-preview/pr-1799/src/data/syncedTableSqlRecognizer.js\":\"10cd1a68d8ec5fd0\",\"/knowledge-medium/pr-preview/pr-1799/src/data/syncedTableWriteGuard.js\":\"577e59ab32b9bf48\",\"/knowledge-medium/pr-preview/pr-1799/src/data/targets.js\":\"ac091d24589d023d\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typeColors.js\":\"94b796469ed3ec8a\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typeDefinitionMetadata.js\":\"2528804b85ab7a8b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typeDefinitionRegistry.js\":\"56e5c23402bbdcbd\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typeExtraction.js\":\"09f8002224f3900a\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typeInitialValues.js\":\"7240be502e4c25da\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typePropertyGroups.js\":\"3d157a5dfc6766a5\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typeSeeds.js\":\"0769f5c8c98cd149\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typeTagger.js\":\"cd6d16241f0c256e\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typedRecords.js\":\"31571f610f6f7047\",\"/knowledge-medium/pr-preview/pr-1799/src/data/typesPage.js\":\"077a1e4a095e8c57\",\"/knowledge-medium/pr-preview/pr-1799/src/data/userPrefs.js\":\"50e476ad7143c5c2\",\"/knowledge-medium/pr-preview/pr-1799/src/data/userSchemasService.js\":\"847bea9cf549698b\",\"/knowledge-medium/pr-preview/pr-1799/src/data/userTypesService.js\":\"c0d6156df3f795c5\",\"/knowledge-medium/pr-preview/pr-1799/src/data/valuePresetRegistry.js\":\"69051119d8028876\",\"/knowledge-medium/pr-preview/pr-1799/src/data/visibleChildren.js\":\"e8d91041100c65cc\",\"/knowledge-medium/pr-preview/pr-1799/src/data/workspaceConversion.js\":\"020532263afc2633\",\"/knowledge-medium/pr-preview/pr-1799/src/data/workspaceFirstSync.js\":\"13f1bdc40ddbf6df\",\"/knowledge-medium/pr-preview/pr-1799/src/data/workspaceIdNamespace.js\":\"556197e4c5c66801\",\"/knowledge-medium/pr-preview/pr-1799/src/data/workspaceSchema.js\":\"b60c25e1e4606a35\",\"/knowledge-medium/pr-preview/pr-1799/src/data/workspaces.js\":\"9a02915ce2050bd7\",\"/knowledge-medium/pr-preview/pr-1799/src/data/writeAheadLog.js\":\"8c19afbebc77ca73\",\"/knowledge-medium/pr-preview/pr-1799/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/BlockPasteShellDecorator.js\":\"488cefb8062177ba\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/atTrigger.js\":\"bf8f8780e7d8e10d\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/autocomplete.js\":\"2ae47640d125396b\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/codeMirrorExtensions.js\":\"31a480dc2cbc0584\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/contentFlush.js\":\"8cb6bfb469a2166f\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/defaultInteractions.js\":\"f666cb4788759b88\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/editSettleSignal.js\":\"fd6dba42a1957d21\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/insertImage.js\":\"86bb1878aa24ee25\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/referenceCompletionRange.js\":\"27c83cf855ce178c\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/referenceTargetTypes.js\":\"e9e068a137a7f13b\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/syntaxContext.js\":\"d33867261c490195\",\"/knowledge-medium/pr-preview/pr-1799/src/editor/triggerMatch.js\":\"0bff3c7686162c6b\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/AppRuntimeProvider.js\":\"79b415f36a216192\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/BlockFocusShellDecorator.js\":\"0133a0239acee1d8\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/ExtensionRenderBoundary.js\":\"c2e69bf872a7cc49\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/PanelContentRecovery.js\":\"ec7746b37f6bae42\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/apiCatalog.js\":\"5c1b5f61220a4450\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/approveExtensionHere.js\":\"8cfa5d09e322405d\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/armedCutAppMount.js\":\"0958fd3998665e8b\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/batchableKeyedStore.js\":\"fcfd770106fa85f4\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/blockInteraction.js\":\"8537863e779ef00b\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/blockSelectionAction.js\":\"6af11f737c085b04\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/compileExtensionModule.js\":\"47673372b301abdf\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/compiledModuleCache.js\":\"8828c03d2ad59a91\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/continuousGestures.js\":\"e5ba241ed67f3c9a\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/core.js\":\"b7e52c28d34feed3\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/defaultRenderers.js\":\"5648d02c804783be\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/definitionFanoutAppMount.js\":\"aa8c9046950f1ded\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/dialogAppMount.js\":\"5f2bed917a292f54\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/dynamicExtensionSeeds.js\":\"3b912b353a35b82b\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/dynamicExtensions.js\":\"fa6e6f96163ba64c\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/exampleExtensions.js\":\"257b7d1483325c3e\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/extensionApprovalStatus.js\":\"a7e6953900677827\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/extensionLoadErrorToast.js\":\"e5732c0f20f43642\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/extensionLoadErrors.js\":\"ef87ff8cf5c6bc68\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/extensionLookup.js\":\"e57cdc855c7dda94\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/extensionToggles.js\":\"f029a48c876547e6\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/extensionUtilitiesCss.js\":\"2d645f1e52f663a2\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/kernelPageDeletionGuard.js\":\"b90b0c07a7698379\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/liveRuntime.js\":\"d676673e78ddd8be\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/openExtensionsSettings.js\":\"8b4b34d619d809f8\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/overridesCache.js\":\"b42c201e1afda9f0\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/pluginIds.js\":\"f2ca2622124836d8\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/processorRejectionToast.js\":\"5e2fe4f3f53dde4e\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/runtimeActions.js\":\"657d47ab81b07244\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/runtimeContext.js\":\"78e8c5369ef299ad\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/staticAppExtensions.js\":\"926540c8ef8f6540\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/staticDataExtensions.js\":\"df55cc7760c8c673\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/toastAppMount.js\":\"266866b82aed8070\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/useOverrides.js\":\"64c55c58fb228ee0\",\"/knowledge-medium/pr-preview/pr-1799/src/extensions/useShortcutSurfaceActivations.js\":\"16956496162317a4\",\"/knowledge-medium/pr-preview/pr-1799/src/facets/discoverToggleTree.js\":\"0b17805b09dfa7d6\",\"/knowledge-medium/pr-preview/pr-1799/src/facets/facet.js\":\"c6a306da11d627f6\",\"/knowledge-medium/pr-preview/pr-1799/src/facets/resolveAppRuntime.js\":\"96cb4dec6d52cf64\",\"/knowledge-medium/pr-preview/pr-1799/src/facets/runtimeEvents.js\":\"84798801570f9c71\",\"/knowledge-medium/pr-preview/pr-1799/src/facets/togglable.js\":\"dd1a60d7bf0ae7a9\",\"/knowledge-medium/pr-preview/pr-1799/src/facets/variantFacet.js\":\"649e24aca4efe915\",\"/knowledge-medium/pr-preview/pr-1799/src/facets/verbFacet.js\":\"d20cf664ecb20188\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/block.js\":\"ca7af7daafcb9bc2\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/focusedChild.js\":\"347ab074a89a88c5\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/propertySchemas.js\":\"7ae90e82cd992516\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/typeRegistry.js\":\"5593ca825eb600c5\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useAncestorCrumbs.js\":\"d34549b382ce6a39\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useAutocompleteListbox.js\":\"01de24f302234a97\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useDebouncedSearch.js\":\"ad42b733a389311d\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useDebouncedValue.js\":\"d3f3966a721431d4\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useIsFocalRender.js\":\"86ef7bd700a6c562\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useIsReadOnly.js\":\"aaf98154ed9ad599\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useMaterializeBacklog.js\":\"0dfdf33dbae0c28c\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useMinuteClock.js\":\"6fc10f485f114300\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/usePanelLayoutProjection.js\":\"b69a0268ad4c3fa2\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/usePendingInvitations.js\":\"ad1315bc26342095\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useRendererRegistry.js\":\"884777184a587b1d\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useRetainedFieldRows.js\":\"1c5738d16513b22a\",\"/knowledge-medium/pr-preview/pr-1799/src/hooks/useWorkspaces.js\":\"f82ddcd1f76a6256\",\"/knowledge-medium/pr-preview/pr-1799/src/lib/utils.js\":\"def963b80ed28bb9\",\"/knowledge-medium/pr-preview/pr-1799/src/main.js\":\"6129c8bdf7926c64\",\"/knowledge-medium/pr-preview/pr-1799/src/markdown/MarkdownImage.js\":\"03e2f2d6d19cbe15\",\"/knowledge-medium/pr-preview/pr-1799/src/markdown/blockSeparators.js\":\"fc4f86f7306133cf\",\"/knowledge-medium/pr-preview/pr-1799/src/markdown/context.js\":\"ddc7ceee6e3bfd52\",\"/knowledge-medium/pr-preview/pr-1799/src/markdown/defaultMarkdownExtension.js\":\"2faa89083710219c\",\"/knowledge-medium/pr-preview/pr-1799/src/markdown/extensions.js\":\"bd7f513e0cc91bb7\",\"/knowledge-medium/pr-preview/pr-1799/src/markdown/renderMarkdownHtml.js\":\"8450bdf18acbbb22\",\"/knowledge-medium/pr-preview/pr-1799/src/minimal-editor.js\":\"a34b8e13b735d1a9\",\"/knowledge-medium/pr-preview/pr-1799/src/paste/armedCut.js\":\"52b2539ee0c0da51\",\"/knowledge-medium/pr-preview/pr-1799/src/paste/captureMediaVerb.js\":\"e53ac22841f22a7f\",\"/knowledge-medium/pr-preview/pr-1799/src/paste/clipboard.js\":\"5f5879d5fa867b5b\",\"/knowledge-medium/pr-preview/pr-1799/src/paste/decision.js\":\"69c3dfb810a312cf\",\"/knowledge-medium/pr-preview/pr-1799/src/paste/operations.js\":\"ea29fbdb45ff7c95\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/account-header/AccountHeaderItem.js\":\"c876742bca80bc80\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/account-header/index.js\":\"1f2b41c2828bf951\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2bfe21dd4e4b5276\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-dispatch-companion/askAgent.js\":\"58d32aec76b43eb0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-dispatch-companion/askedStore.js\":\"e8519f23f52cdad5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f7c729a049668e40\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-dispatch-companion/chipState.js\":\"226a7206ebcf17be\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-dispatch-companion/dataExtension.js\":\"11c6f1c6a26f1bd1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-dispatch-companion/index.js\":\"0550eae184538499\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"3706500f6377a69e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-dispatch-companion/schema.js\":\"9361f6ba55075545\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/AgentTokensDialog.js\":\"51d641c6c9dbfc8d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5bfad442f70b0a71\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/addMedia.js\":\"be2ec63ab297ded5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/backlinks.js\":\"8c7ebe453f161938\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/block.js\":\"7edde1fe02184179\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/context.js\":\"82fe172709d06e0f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/displayIds.js\":\"4589bd2c4fc431be\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/index.js\":\"dfc192ceb15f98b2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/outline.js\":\"3a9bb6102d3365e1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/properties.js\":\"f604440675708a10\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/refs.js\":\"0a36fb8db98298a9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3e37c7d6b044b90d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/search.js\":\"f745e4a38bd4abe0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/shared.js\":\"84830abecde33995\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3de00cfc7777e98b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentViews/text.js\":\"437a30d88295c9c2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/agentWrites.js\":\"7afb14824c3ac676\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/authoringCatalog.js\":\"2952d353e44ea511\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/blockRefTargets.js\":\"6c039346fb8d0018\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/bridge.js\":\"6663b2dee08082e8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/bridgeLoop.js\":\"167e179268fb6ca0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/changeHistory.js\":\"e8c8554b6e56c066\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/commands.js\":\"5d329d3ae6f22d55\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/commentsCommands.js\":\"6cfb1e5f16a0b676\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/dataExtension.js\":\"f008028a88432c4f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/dataModelGuide.js\":\"7a5d6e77f59b3c81\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/describeRuntime.js\":\"4864bb4a3d625563\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/extensionLint.js\":\"fb82b15f8b3f67a5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/grainAudit.js\":\"1acb57b5f40bc1ab\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/healthCommand.js\":\"85be7c98922ea2ba\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/index.js\":\"c3f310aca6d8e4e1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/presetIdentity.js\":\"61b4fdf222aa83fe\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"35be6c3c33269274\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/readMedia.js\":\"00eca084b1d5a21a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/schema.js\":\"deb8fe6b4eed3909\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/serialization.js\":\"6229661e3d6b0357\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/targets.js\":\"ef9bbf5a5c5c581a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/tokens.js\":\"7f4875c647bb1280\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/watchEvents.js\":\"274746a006c72058\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/workspaceGuard.js\":\"676a3bbad7e8d163\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/agent-runtime/writeCommands.js\":\"623a3a861bb84d71\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/alias/AliasCollisionToast.js\":\"13db135d0beeb445\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/alias/DuplicateNameBanner.js\":\"7c1515aa0ad705e7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/alias/collisionMerge.js\":\"1efb23894f1eb9b8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/alias/dataExtension.js\":\"f114a60a39bab1bb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/alias/index.js\":\"5af0266c3fb90d6f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/alias/mergeCollisionAction.js\":\"273cd0d00decba97\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/alias/pageStyling.js\":\"80e76e964a435ae5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/alias/rejectionToast.js\":\"0b9802dc1b750096\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/alias/syncProcessor.js\":\"757aa14cd2442f2d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/actions.js\":\"29cea0c79294461c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/addComment.js\":\"40dbb509c76418b0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/anchor.js\":\"b14f873d4b4ed8dd\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/anchorState.js\":\"07d18ca1a5192dc6\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/commentLinks.js\":\"d5303a15e8405430\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/confirmThreadDeletion.js\":\"9a42586473f49907\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/container.js\":\"786759bfe96ca5ea\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/dataExtension.js\":\"e3cb3f61cd1f7bca\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/deleteComment.js\":\"6050e112cd651781\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/highlights.js\":\"c854c33d4bd21fc5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/index.js\":\"0521ecdc665ce024\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/linkedCommentsPill.js\":\"cc67ad1dd1fd70ff\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/margin.js\":\"21cdb6c512facec5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/marginSchema.js\":\"35e4f112ba5a24c0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/newComment.js\":\"6593740d2e170064\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/ownThreadPicker.js\":\"60e6574251a671cd\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/placement.js\":\"0b31961db1c207d4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/queries.js\":\"7eab89a833138f45\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/quotePosition.js\":\"33642fef9587b022\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/quotedIn.js\":\"bd3d97388ac0201f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/quotedRange.js\":\"d5f022fb0e1d61ad\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/rangeRefs.js\":\"6415ede43e4a52e3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/readHighlights.js\":\"b05837e3f0928d5a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/readSelection.js\":\"db1f99d6b15c32ee\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/readSelectionUi.js\":\"21fac6c369bbae72\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/reanchor.js\":\"edad4e7863a76587\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/schema.js\":\"634609ac980da76e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/scope.js\":\"b5814ea87b489e63\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/scopeThreads.js\":\"e55b28007e3bb07f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/splitRetarget.js\":\"9677c3e5458c1383\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/suggestionCard.js\":\"abf977d26614fdbe\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/suggestions.js\":\"d25a04fe35757a65\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/summaries.js\":\"78736b2d27d3535c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/summaryBatch.js\":\"a54b94f675948538\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/surface.js\":\"f2b39744b9a86c88\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/threadNavigation.js\":\"87a96b4d7c1ae58c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/threads.js\":\"8afbedf047db0365\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/ui.js\":\"312d7569e624c72d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/annotations/uiStore.js\":\"b00e84b925e08900\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/app-intents/appIntents.js\":\"a835a8fcdf0e2d5a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/app-intents/index.js\":\"629b28ff229efdf7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/app-update-prompt/index.js\":\"474eb6a635206acf\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/app-update-prompt/status.js\":\"51cbda88f5240197\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"aab5dcfd247f809f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/MediaBlockRenderer.js\":\"43e94e5abab5d419\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0d975d70305e9a8a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/MediaUploadReconciler.js\":\"94b17b40a150c0c4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/assetDownLane.js\":\"da0bdcd522792668\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/assetResolver.js\":\"b3800327aa713255\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/assetUpload.js\":\"b10a41c785e96001\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/attachmentCleanerIO.js\":\"406330e360d16784\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/audit/supabaseAuditIO.js\":\"98e1650a618d31a1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/blobStore.js\":\"4e6802939920a200\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/byteStore.js\":\"354123b303891bb4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/cleanerIO.js\":\"ba52ef6c27f98e01\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/cleanupAttachments.js\":\"057e563e4891fd0b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/dataExtension.js\":\"2e275bd1b3b4f78c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/downLane.js\":\"2499dcdd7449df06\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/index.js\":\"1d16c1128e7294ac\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/insertImageContribution.js\":\"92afb168c564057f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/laneArming.js\":\"3e47c42f4dbaad3d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/laneLock.js\":\"3aae826a2a94e2aa\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/mediaBlock.js\":\"c2b43e4ad2d5c593\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/mediaCapture.js\":\"6caa26c586d76579\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/mediaViewers.js\":\"1670783c770a0413\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/mediaViewersFacet.js\":\"fe69de5ddb29411c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/pasteCapture.js\":\"cea019e888ff2704\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/resolver.js\":\"bd391355db162684\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/retryUploadsAction.js\":\"28cec1dd5c36b749\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/storagePaths.js\":\"3938a012ca04130f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/uploadDrain.js\":\"9331a98fbb1142dc\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/uploadLaneStatus.js\":\"5b360aec294a57b0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/uploadReconcile.js\":\"dd1b3af75f389781\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/uploadRecovery.js\":\"2c4df1f25fcaf820\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/uploadStore.js\":\"1ccc0b60086a139e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/attachments/useAssetObjectUrl.js\":\"aedb203d43d5417a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"209c8b32a8b06e55\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks-view/BacklinksViewSection.js\":\"440621c8f67101be\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks-view/facet.js\":\"dd5a13773e413fde\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks-view/index.js\":\"3f51926da0536cb1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks-view/prop.js\":\"4dd985fb9ded0657\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/BacklinkFilters.js\":\"6711b445ffadfcd3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4cf105dc0604818d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/BlockEntry.js\":\"f7a4b5f48dd00a0b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/LinkedReferences.js\":\"842442c3c45f40f1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e491913a3617c49d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/dailyNoteDefaults.js\":\"92c04dd319600982\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/dataExtension.js\":\"397376deea0ec380\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/edgeExclusions.js\":\"827b126b65505501\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/filterProperty.js\":\"6c033182709adf4e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/index.js\":\"499680dc9ecd508d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f6a1cb41f773e4c3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/inline-counts/applies.js\":\"49bab3cda1cac22b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/inline-counts/countQuery.js\":\"58b7c11f24746f08\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5b76ecc121c61393\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/inline-counts/index.js\":\"5d23cc61dbfddfdb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d8e8b0cd5fd21f21\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/presentationInvalidation.js\":\"cb10ac12a1506566\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/propertyEditorOverride.js\":\"14d772a8bf97eea6\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/propertyFilter.js\":\"d49ee28e852b2b64\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/query.js\":\"fce75909cd245c9e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/resolveFilter.js\":\"9b30e4788d29077b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/sourceBatch.js\":\"f734a465d57d211a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/sources.js\":\"a4bf70135943dcf8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/useBacklinks.js\":\"2d6b3b82fd46d645\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"29610de6bab11a91\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/birthday/BirthdayCelebration.js\":\"dd62906a8ffc50a1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/birthday/BirthdayOverlay.js\":\"fff5c1a40994eb5a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/birthday/gate.js\":\"6db827791d458377\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/birthday/index.js\":\"c92894d691f2af66\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/birthday/wolfTheme.js\":\"f460cebb95bb84c8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-drag/BlockDragLayer.js\":\"697e485d7b8aa3ce\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-drag/dragController.js\":\"7cff31a5bece12e1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-drag/dropTarget.js\":\"50d5058e7c71b91d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-drag/index.js\":\"74efd8eb6f9de27c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-drag/projection.js\":\"cbb9711e6e2b1a5a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-info/BlockMetaCard.js\":\"086299e7c86b373d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-info/index.js\":\"f97ad99a5419997b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-tagging/AddTagDialog.js\":\"88a4e59464f51e80\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4ca572a35c28dfb4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-tagging/TagNameIssueHint.js\":\"a42ba3d100b048dd\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-tagging/addTagAction.js\":\"6253767c59681147\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-tagging/appendTag.js\":\"5d3ca39ee5ea160f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-tagging/config.js\":\"59d7dc3b5b4c9d99\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-tagging/dataExtension.js\":\"1e19fad0861c3142\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-tagging/index.js\":\"d0c2d6f685485dc4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/block-tagging/propertyEditorOverride.js\":\"6037590d1dac21da\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/breadcrumbs/BreadcrumbList.js\":\"44caa5c7edbca79e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4316bbef9ea5a25a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fb6f34ee7eaeafae\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"f703a6a051e788d8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"bf3f2e2ed10711fa\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/breadcrumbs/index.js\":\"be89a69ccaf0bce9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b20ba0807ad03235\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/CharacterCountItem.js\":\"edf50965279e478a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b22947be288fc459\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/actions.js\":\"5f34d985585fb83e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/blockType.js\":\"204ee4d4f8d7a0e8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/charCount.js\":\"a6d15bc45afd0b5b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/dataExtension.js\":\"5e507ee7b36f7456\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/index.js\":\"847ed94ed36ccaae\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/profiles.js\":\"ff5ae11f5ca75abd\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/properties.js\":\"d79876db29d25f3e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/character-counter/textCounts.js\":\"e5953af8b12198ff\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/colemak-keybindings/index.js\":\"c642ef9777cbd579\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/command-palette/CommandPalette.js\":\"a67e7383e4f0ee49\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/command-palette/HeaderItem.js\":\"7047756dd993e359\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/command-palette/context.js\":\"7b8b99b94d4351b9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/command-palette/index.js\":\"7e9dd8f3baf155cb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/command-palette/selection.js\":\"bd76434efaa56616\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/command-palette/toggleStore.js\":\"89d456eab7f2f673\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/command-palette/useCommandPaletteActions.js\":\"929b1e78601cc2e1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/ContributorBadges.js\":\"0509e566209f1e1f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/author.js\":\"0eb2a36dd43c586a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/codeMirrorExtensions.js\":\"a76bb35e3ec9a0c0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/dataExtension.js\":\"7b61a31b8f53d4ef\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/index.js\":\"85a159e60a6672fa\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/mentionAutocomplete.js\":\"ae47b987a1d97e7e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/processor.js\":\"409f7f682a9273cd\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/profiles.js\":\"90526abe22e0e173\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/queries.js\":\"76c386fe99663f0e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/contributors/schema.js\":\"a4b5cda87a2bbcf2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4911af8d55c3e005\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/cursor-follows-scroll/followOrigin.js\":\"fc771e7a7154383c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/cursor-follows-scroll/index.js\":\"bde96e24841d4ba8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"848d79edade524e6\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5e9779ba2519a945\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/CalendarGrid.js\":\"63fa80d7e792c9f1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/DailyNotePicker.js\":\"5b7929cb0d4bc04e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"028b4d4d707c9a92\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/DateNavDecorator.js\":\"c29a9f38d9bd645a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/DateScrubOverlay.js\":\"0a83198a60ac449b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/HeaderItem.js\":\"d4dfa8276156bdff\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/ReschedulePicker.js\":\"f9fb4f8273fe12ac\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/SpreadDatesDialog.js\":\"08650b0a77dd7346\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/actions.js\":\"19f20c301147aad6\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/blockDateAdapter.js\":\"c2eee6801f0051db\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/calendar.js\":\"cfb411000ec58e12\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/dailyNotes.js\":\"7aef8afaf37c92a2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/dataExtension.js\":\"f364ce656b6764d9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/dateScrubActions.js\":\"62a21830fedc9044\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/dateScrubGesture.js\":\"3237647a16720ec9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c3f5479c1cb2d039\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a34eb02ff1030741\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/deletionGuard.js\":\"a4c353fb9f394a24\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/dueQuery.js\":\"8c1110ff18ba8711\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/index.js\":\"bc2f2aa0bcc00544\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/landing.js\":\"219d33aef45faf44\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/localSchema.js\":\"5f937a18b7f038c2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/referenceDateAdapter.js\":\"5ea9db9f54a170b1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/rescheduleAction.js\":\"7ee442fd3a54fc18\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/schema.js\":\"a1095955ba224982\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/spreadBlockDates.js\":\"8b24ba0f82dad95c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/spreadDatesAction.js\":\"443863534873186a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/today.js\":\"a309712932520ed9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b88848b19c09074a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a5cd1e605cee8704\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/audit.js\":\"0b0d55d727476130\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/auditAction.js\":\"3a31ca15ea8c418f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/auditRanges.js\":\"665811b63ebbaace\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/diagnosticsSource.js\":\"bb416c28b6d116ec\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/divergenceScan.js\":\"5dd34eb8766e968e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/index.js\":\"949a25fc5ef2f870\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/propertyChildrenChecks.js\":\"98e0e8a016a04b9a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/referencesMirror.js\":\"3190c68a9c38aace\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/rowJson.js\":\"590e37e347f35450\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/schedule.js\":\"a25094226056773e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/data-integrity/store.js\":\"9f3a4e92b7f4a619\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-maintenance/action.js\":\"8219c812cf142b94\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-maintenance/index.js\":\"1ad7fc6fc94f94e7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-maintenance/plugin.js\":\"562ce78b2f2ea38f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9cd274c9ba43dea5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/actions.js\":\"d0ec68ec77f956a7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/changeMarker.js\":\"f015105f7401a19a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/diagnostics.js\":\"9e17f24fcc5adcbe\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/fileSystemAccess.js\":\"7e451775f27f7ac4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/filenames.js\":\"c1032b70c8847c1e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/index.js\":\"24a2e5adc060220b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/mirror.js\":\"8025dafc11ee7f09\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/runLock.js\":\"f66a0c1acefad9a8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/runtimeHealth.js\":\"49ac3d1c050a83b0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/schedule.js\":\"6c467f1f72772eda\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/db-mirror/store.js\":\"cbdbaa4b55aa34f9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/default-themes/index.js\":\"6184b102cad69c9f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/default-themes/themes.js\":\"261758af00c06321\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/diagnostics/facet.js\":\"881cda30e5d42a85\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/diagnostics/useDiagnostics.js\":\"209ce429e5813582\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extension-prompts/dismissals.js\":\"65da9140fe46119b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extension-prompts/index.js\":\"38649aee39ee1827\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extension-prompts/status.js\":\"aabf90b0312e9f45\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extension-prompts/store.js\":\"5de2ac90742c09a4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b451782f0a154aa1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extensions-settings/ExtensionsSettings.js\":\"280278d0b76d5537\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extensions-settings/actions.js\":\"f915d4b6701a5d3f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extensions-settings/config.js\":\"4edc902f18433913\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extensions-settings/dataExtension.js\":\"97556776eec7feb1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extensions-settings/effect.js\":\"44fc3f7953a0877e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extensions-settings/index.js\":\"fa26aa35f268bccb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bbabf0bc9428e80a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extensions-settings/useToggleTree.js\":\"bc17bf9c533e13ac\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extract-type/ExtractTypeDialog.js\":\"5d0a627f2aa554a5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4b4f2217c4758ac1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extract-type/PropertyShapePicker.js\":\"90a28bd13e12e23e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extract-type/action.js\":\"38f7b4bc904db2bb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/extract-type/index.js\":\"ec00abbd276a6f45\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/find-replace/FindReplaceDialog.js\":\"108563b6ecf1eb59\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/find-replace/HeaderItem.js\":\"0cc119dd11069d28\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/find-replace/dataExtension.js\":\"2840710451cd75d8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/find-replace/index.js\":\"cab627e509e5e4f1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/find-replace/search.js\":\"e108b77922eabc56\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/find-replace/toggleStore.js\":\"4ed53d5b08722d89\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/LocationPropertyEditor.js\":\"72370720ab562638\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/MapView.js\":\"31d6d6c1856c19ce\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/blockTypes.js\":\"35bcc97354ff9b04\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/codeMirrorExtensions.js\":\"834a977c4338ebfe\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/createOrFindPlace.js\":\"17b2a8566d45575d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/currentLocation.js\":\"f7edab0976c16717\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/dataExtension.js\":\"44179f82ecb07802\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/geoContentDecorator.js\":\"34f6faecec1246d1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/googlePlacesClient.js\":\"2e3dd034743aca3d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/index.js\":\"32a31916614caa1b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/locationsPage.js\":\"de64308440811ef4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/mapViewport.js\":\"199f13859829d222\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/pickCurrentLocation.js\":\"457f383b7bc8107b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/placeAutocomplete.js\":\"58ed06dc3b0c7a4e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/placeNameCollision.js\":\"380dc00346749ba5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/properties.js\":\"0fdd7db68a696aed\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/propertyEditorOverrides.js\":\"eb287470f04db440\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/query.js\":\"766342d75f57844c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/geo/usePlaceSearch.js\":\"01d5eb42848fe8a9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b2009f0701cc97ee\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"acf88e0621e17dcd\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e4d884992c1b6158\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/config.js\":\"a91dfeb0c6fe1d5f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/dataExtension.js\":\"efdd6170a6ebebd3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/facet.js\":\"c2627053350db58b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/grouping.js\":\"c06d14d1e041bedf\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/index.js\":\"54540a4dfa05f4b4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d1f2aa301e9b131f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/query.js\":\"732160506923839f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/resolveConfig.js\":\"7710b8c55c28ef58\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7bf505a7440bb6f2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"af43a2dcaf0b501b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/HtmlDocumentContent.js\":\"2193dc6396370492\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/HtmlFrame.js\":\"c86ba6d122bfbbeb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/actions.js\":\"22f1d2bde3a39087\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/blockType.js\":\"1e79647351753c32\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/confirmRunScripts.js\":\"eb11637eecc9d24a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/dataExtension.js\":\"71746e449896c6f0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/frameAnnotations.js\":\"98eb9149d69c8f33\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/frameDocument.js\":\"9e548afe7eb7eda5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/frameTheme.js\":\"72e4f7cb112e48f0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/index.js\":\"c576124bfa2e7244\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/scriptConsent.js\":\"fa68f622261d08e5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/sourceMap.js\":\"007e6aac0585ffec\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/html-document/useDocumentScripts.js\":\"f14cf0e8078597f0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/interaction-metrics/index.js\":\"63f002fff23c8c5c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/interaction-metrics/record.js\":\"ad1f5b194f2fd40b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/interaction-metrics/recordStore.js\":\"b5e8300eaa962be2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/interaction-metrics/responsiveness.js\":\"69719497fe3e1d75\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/interaction-metrics/schedule.js\":\"d5d5cd42f6f69675\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/interaction-metrics/sessionContext.js\":\"1d4569a9aa7861cf\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"bdb109d6bb9ab4d6\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8199eaf8de0ecdd1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/actions.js\":\"d15d3b7ca1d09c5c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/config.js\":\"89a185364ea970cf\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/dataExtension.js\":\"9d0c07d3aa14a9c6\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/effect.js\":\"cc0c6d773658ca62\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/index.js\":\"80045023e67d8b44\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/keyCapture.js\":\"ee70063a5a8711bc\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/overrideStore.js\":\"3222e56429e696f0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e271e7e462210edc\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/left-sidebar/HeaderItem.js\":\"3541bfdd0dfef021\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/left-sidebar/LeftSidebar.js\":\"d3c1f6d3436caf19\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/left-sidebar/actions.js\":\"3fef11eb5e082e08\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/left-sidebar/facet.js\":\"e755910e7a6707c7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/left-sidebar/index.js\":\"3183f868682b51d7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/left-sidebar/shortcuts.js\":\"240d0a864eefd6d2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/left-sidebar/toggleStore.js\":\"db158dccf217343b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/merge-blocks/MergePicker.js\":\"b5f82063911e6e99\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/merge-blocks/index.js\":\"48dcf4822480a65b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/merge-blocks/mergeAction.js\":\"5957b880df8702b1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/merge-blocks/strategy.js\":\"8e947c60834f4ec0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-bottom-nav/Button.js\":\"ab949bc608114c9d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9386d35fc181aece\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5dd7889830aac742\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-bottom-nav/facet.js\":\"618a18f4f9faa662\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-bottom-nav/index.js\":\"a44dc3bebf2b9d5e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"5a240aebe19b7d95\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9d475e925aa82644\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"aed099b44bc2b3ca\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-keyboard-toolbar/facet.js\":\"0bbc447716fa100c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/mobile-keyboard-toolbar/index.js\":\"47554619518c38c4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/move-blocks/MoveDestinationPicker.js\":\"dbf925c4ce005aad\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/move-blocks/blockSubtreeMembership.js\":\"bd67fca97db7f98b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/move-blocks/contextMenuItem.js\":\"d7b229e8bdc2e7d4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/move-blocks/index.js\":\"613c54ea3ae5f89a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/move-blocks/moveAction.js\":\"6b5ca25ea70d0032\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/move-blocks/moveBlocks.js\":\"7b0c22729520fa7c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/move-blocks/selectionAfterMove.js\":\"b3b1747189216745\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/onboarding/TutorialBanner.js\":\"2ad381e483b74257\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/onboarding/action.js\":\"d8e515f904cfeefb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/onboarding/bannerDismissal.js\":\"c3eb4c250565a3e5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/onboarding/documents/cheatSheet.js\":\"adf1bef048039184\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/onboarding/index.js\":\"290eb6f523c691f7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/onboarding/keys.js\":\"daad3060fb7cfa29\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/onboarding/landing.js\":\"52fb2aa0071aed00\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/onboarding/outline.js\":\"b5c71d527d5dbbd0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/onboarding/seed.js\":\"c57a6b04425d3538\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/PerfTrendDialog.js\":\"73de4f341d0c4367\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/analyze.js\":\"7d16caff8ec9054c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/diagnosticsSource.js\":\"23363909686eac8e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/index.js\":\"3f2bf35f3f28cdfa\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/load.js\":\"e930724af9308cbc\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/monitorRun.js\":\"f02c7a4ccd01f03c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/schedule.js\":\"1ef90d8fe1ea425e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/series.js\":\"89e3925b0f741756\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/store.js\":\"3f25b9eb97308f6e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/trendAction.js\":\"389d35a1c1fc2d88\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/perf-monitor/verdict.js\":\"ff5fbe980bd1c7f4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/plain-outliner/clickToEditAction.js\":\"8867bf94f464128b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/plain-outliner/index.js\":\"124b3e58d228c6f9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/plain-outliner/interactions.js\":\"4ea3c0b2682846f8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9ce6220bd46e4da7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/properties-migration/MigrationGate.js\":\"d0d736baca903943\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/properties-migration/MigrationGateDialog.js\":\"99500648e254e55d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/properties-migration/action.js\":\"f794457e712fa597\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/properties-migration/index.js\":\"0b293494b5473dbe\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/properties-migration/localRunMessage.js\":\"b75346992d06d099\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/properties-migration/plugin.js\":\"b41dba44b1c08bc5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/properties-migration/progressReport.js\":\"ebf9a61799f2c479\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/properties-migration/sweepProgress.js\":\"97d6f9bd1a2e60fb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/property-rows/FieldRowRenderer.js\":\"0719a8247eca93d3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/property-rows/ValueRowRenderer.js\":\"e12001b2da168881\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/property-rows/actions.js\":\"b58d671aa5319783\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/property-rows/autocomplete.js\":\"76f2ec4906a76537\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/property-rows/fieldRow.js\":\"1ecf0dcbafd2750c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/property-rows/index.js\":\"0e9ea59ffd2d0b43\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/property-rows/referenceWarning.js\":\"ddaad80aad629524\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/property-rows/valueAutocomplete.js\":\"5f3c67b29b172a09\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/property-rows/valueSchema.js\":\"7e3637f1682bc55a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/quick-find/HeaderItem.js\":\"6344f01cf5a411ce\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/quick-find/QuickFind.js\":\"8bdcba31d11f468b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/quick-find/index.js\":\"d1cd12fb6b8e3245\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/quick-find/recents.js\":\"9f32601edb08b215\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/quick-find/resultItems.js\":\"d850e6c06c2bec39\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/quick-find/selection.js\":\"e7afd78857482225\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/quick-find/toggleStore.js\":\"630d73c839d5b462\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/recents/HeaderItem.js\":\"eb0ccbdef1dcdd8b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7ddba4e57b560e43\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/recents/grouping.js\":\"0f4cc7da48b4b39b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/recents/index.js\":\"cd21914e05403240\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/recents/target.js\":\"8890e8ed11e56adb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/codeMirrorExtensions.js\":\"757b26be74eaf351\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/contentPrefill.js\":\"d2f4375b5a50aaa2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/dataExtension.js\":\"9f95046c2e696819\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/index.js\":\"e0eb9f10a5c23983\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"108a908f54b36ee4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/invalidation.js\":\"b8ea97f9438db82f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/localSchema.js\":\"248ff9f45416f2dc\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/markdown/blockrefs/index.js\":\"6e5d7514053c69f4\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"19f33c852412527b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/markdown/index.js\":\"327fd70478ce2483\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/markdown/referenceNode.js\":\"9a3c2ffeb9a56eef\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8594e13964c5f0d7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a1c1017c29306291\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/markdown/wikilinks/index.js\":\"93d3a1724e9ca245\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"973c0a7d06b15d28\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"13fc0ec850474946\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/mergeRetargetProcessor.js\":\"f4d60806f57ec7bd\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/parseFence.js\":\"451214f47a395a44\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/referenceParser.js\":\"1c2b2eef6c48eb4e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/referenceProjection.js\":\"cadfcf8d7bbc5e83\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/referencesProcessor.js\":\"0838bba39179eb24\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/renameProcessor.js\":\"a32b6d1eaa95ef06\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/references/spanReplacement.js\":\"e52433d79c7e8f8a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/rich-paste/htmlToOutline.js\":\"ac6f0d5696f06694\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/rich-paste/index.js\":\"0364eff3fde30844\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/rich-paste/normalizeClipboardDom.js\":\"97896531a2c5ed8d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/rich-paste/pasteDecision.js\":\"6adbbb721029f691\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/action.js\":\"99331f7bd98a5349\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/blockIds.js\":\"9b14e02ae83cdc28\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/content.js\":\"6f88db9a696eaf3f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/effect.js\":\"511104210dd3cefb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/ids.js\":\"a27133e3bd260130\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/import.js\":\"f84feb6aaab8ddce\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/index.js\":\"6155922bca8b94e3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/plan.js\":\"73c087b2ded29331\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/plugin.js\":\"61a611fcb11cab3b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/promotion.js\":\"03adf34c40ee58c3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/properties.js\":\"45d7698076eb52e8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/references.js\":\"6808126f369b9997\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/report.js\":\"b2451e16f3390328\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/roamMemo.js\":\"ce3649c52dad8c1c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/runtime.js\":\"6b3b1fffecf5d28e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/schemaReconciliation.js\":\"eedb0a07a76f457c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/srsMarkers.js\":\"69aa2677aac1155c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/todo.js\":\"4a99119594ab65e6\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/typeCandidates.js\":\"1d697516973d2f78\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/roam-import/types.js\":\"d26457f8d0c2f9c8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/search-health/index.js\":\"93b97518fb5f7481\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/search-health/store.js\":\"943f453a1ae4191b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/shortcut-help/HeaderItem.js\":\"ef28f0a9d38bab24\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9fab9b2b9fdb8a32\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/shortcut-help/index.js\":\"6e52d7298525a737\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/shortcut-help/model.js\":\"cdbb74b0532d0cab\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/shortcut-help/toggleStore.js\":\"c37ed1cfe19f12bc\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/shortcut-help/useKeyInspector.js\":\"fc31c02314638402\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"32353626c98c1263\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/spatial-navigation/ShellDecorator.js\":\"c7c06680fcfa745f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/spatial-navigation/actions.js\":\"06eb2b96a9a995a3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9f0b06db36271bae\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/spatial-navigation/index.js\":\"4030283533e037f9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/spatial-navigation/shell.js\":\"1729af5b1d3e7c01\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/spatial-navigation/surface.js\":\"e14b04aabc28041b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/spatial-navigation/walker.js\":\"4a93012b5e0fdb04\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1dbc725bcf53dd81\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/dataExtension.js\":\"1ec36639ba932c00\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/index.js\":\"469b74d2e9ec9625\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/indicator.js\":\"9c7e950e027ed5bb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/moveSrsState.js\":\"ec3d590a9d839251\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"348a507a89281f58\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/scheduler.js\":\"d92c064a179e117f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/schema.js\":\"70f67b8609cbefbf\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b32d29b5b2d47a8c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/srsClipboard.js\":\"b5dc8c0fe04e3865\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9a163a078617bb46\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0e781be8a4c7f408\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/DeckPicker.js\":\"38df5279c8a844ba\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/ReviewControls.js\":\"4a881145402ef8e5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/ReviewDeckRenderer.js\":\"08d53db41cfc497c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/ReviewSession.js\":\"5d54c0904d904fe6\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/actions.js\":\"1af263f366164e03\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/archive.js\":\"0c569a851f8020e3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/dataExtension.js\":\"90d66fe8f9e4e990\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/deck.js\":\"6b29854f8c3ef653\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/dueQuery.js\":\"dbf18e8649f5da4f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/gradeDecision.js\":\"45b9316ad5f77df0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/index.js\":\"aa244eff0285bdae\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/keyHints.js\":\"b8709b4c6da7fbaf\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/reviewCardLayout.js\":\"7807f36edf55a4f2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/reviewProgress.js\":\"77c740fadd16c8a0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/schema.js\":\"790306990d21e8f0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/srs-review/useDueCards.js\":\"ec8953368b68de3e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/startup-metrics/index.js\":\"5a9463ce6900d670\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/startup-metrics/record.js\":\"9a7ab91195e1e208\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/storage-persistence/index.js\":\"c39f18e9da37baa7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/storage-persistence/persistenceStatus.js\":\"427914360285c47d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/storage-persistence/requestAction.js\":\"cb48732db9f01717\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/supertags/TypeChipsDecorator.js\":\"fca18b587a7789f0\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/supertags/codeMirrorExtensions.js\":\"7e906e915009cf55\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/supertags/index.js\":\"37231751ed13efaf\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/supertags/typeAutocomplete.js\":\"3714c1cc0af21736\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"7e837d37ca07f6d3\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/swipe-quick-actions/actions.js\":\"d7a12e931d2971f9\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/swipe-quick-actions/anchor.js\":\"7698093212075808\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/swipe-quick-actions/events.js\":\"d47fbd5c75a3eb23\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/swipe-quick-actions/gestureActions.js\":\"0191db5820538313\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/swipe-quick-actions/index.js\":\"554998c2a4025e3f\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a6c3d00ae8992294\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/sync-metrics/collect.js\":\"60a335cbbc0ac73e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/sync-metrics/index.js\":\"de3a2e914a025257\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/sync-metrics/record.js\":\"fb53bb2a52ac7464\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/system-status/RejectionDialog.js\":\"899fb43948e5098a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/system-status/SystemStatusHeaderItem.js\":\"89e4dba261d98a21\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/system-status/index.js\":\"c867e5ec59f9c91d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/system-status/model.js\":\"e13452776e75a400\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/system-status/queueCounts.js\":\"42ef52b99b9829bb\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/system-status/rejectedHelpers.js\":\"a9448a1f8546f5ea\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/system-status/rematerializeAction.js\":\"73c5920f4fb3cd56\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/system-status/useHysteresis.js\":\"8fa3d515afe82855\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/theme-toggle/effect.js\":\"42af46d1ab5dfe52\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/theme-toggle/index.js\":\"4cbbfc64690f94ab\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/theme-toggle/theme.js\":\"efd4bc6402acfa63\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/todo/actions.js\":\"2b771e8b405c8fe7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/todo/dataExtension.js\":\"4bbe30352a567d7a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/todo/index.js\":\"5d09e28297602d26\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/todo/schema.js\":\"489f120d2da8400e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/touch-selection/TouchSelectionLayer.js\":\"cd8ce08641a25f4e\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/touch-selection/actions.js\":\"c7245241ab7dcc8a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/touch-selection/defaultItems.js\":\"acb12551b37cbf67\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/touch-selection/facet.js\":\"710a51274fef8ff1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/touch-selection/holdRecognizer.js\":\"f1f17150d2e348ab\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/touch-selection/index.js\":\"178313e69b94f0df\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/update-indicator/UpdateIndicator.js\":\"fb229e2472694f13\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/update-indicator/index.js\":\"b64ca9fc7065b84b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/update-indicator/loadTimes.js\":\"6f1645a23f8e5483\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/VideoNotesRenderer.js\":\"b5508ae2af8ab0a7\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/VideoPlayerRenderer.js\":\"7806588522907261\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/VideoTimeStamp.js\":\"f44f34e8f03058fa\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/actions.js\":\"d6d063c10c75efc5\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/index.js\":\"71fbcad875558075\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/markdown.js\":\"4742ed8e33c68289\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/notes.js\":\"cfa7605b883ef4a6\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/registry.js\":\"a337d43087437dc8\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/remark-timestamps.js\":\"9a4a642614058c1b\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/video-player/view.js\":\"c09961b0e69781a2\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/vim-link-hints/LinkHints.js\":\"6d8043b3ccff48ce\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/vim-link-hints/index.js\":\"d067e0bcb564de9d\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/vim-link-hints/model.js\":\"a9d6d86b3373225a\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/vim-link-hints/settings.js\":\"52c14efd64c5f03c\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/vim-normal-mode/actions.js\":\"6f2b12b5c6ec22c1\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/vim-normal-mode/index.js\":\"d71d2f6eee23ccbc\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/vim-normal-mode/interactions.js\":\"4a9f43e69df48506\",\"/knowledge-medium/pr-preview/pr-1799/src/plugins/workspace-header/index.js\":\"a33267a163c554c5\",\"/knowledge-medium/pr-preview/pr-1799/src/registerServiceWorker.js\":\"7a89bd704bb7d93e\",\"/knowledge-medium/pr-preview/pr-1799/src/requestPersistentStorage.js\":\"54f78344481e878b\",\"/knowledge-medium/pr-preview/pr-1799/src/services/authRequestDeadline.js\":\"0a7cfd9a40d83489\",\"/knowledge-medium/pr-preview/pr-1799/src/services/authStorage.js\":\"eb07a81c6173bc4f\",\"/knowledge-medium/pr-preview/pr-1799/src/services/powersync.js\":\"b60c2cf43ffe3501\",\"/knowledge-medium/pr-preview/pr-1799/src/services/supabase.js\":\"d67edb552e347c44\",\"/knowledge-medium/pr-preview/pr-1799/src/services/uploadErrorClassifier.js\":\"72479ef8b0ba1be2\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/ActiveContexts.js\":\"c0dc6aa6a386e7fc\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/HotkeyReconciler.js\":\"1de778a0de23a9e4\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/WipeLocalDataDialog.js\":\"82139c85583efab7\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/actionDispatch.js\":\"ffcfa93f96e7d935\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/actionRefItems.js\":\"03133fd2553f61ef\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/applyKeybindingOverrides.js\":\"a72d0c64f22c5edc\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/blockActions.js\":\"44da0829c33d68d1\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/canonicalizeChord.js\":\"d63b36922aa11b37\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/defaultContexts.js\":\"cc2d3424b7040b67\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/defaultShortcuts.js\":\"be3b061f2d50c504\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/effectiveActions.js\":\"b6e4510079dd95f0\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/gestureAction.js\":\"716f463910c411f8\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/gestureBinding.js\":\"55688a4bc74882e8\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/holdRegistry.js\":\"5e187266a0bf693a\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/keybindingConflicts.js\":\"7425b2201c40c66e\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/keybindingOverrides.js\":\"b9aa64c0d0fbd8eb\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/pointerAction.js\":\"7f3240bd65356bfa\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/resolve.js\":\"9e04c1ec50e4e923\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/runAction.js\":\"7f88aec88245e560\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/sequenceMatcher.js\":\"68dc2cf2849fea67\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/types.js\":\"cbab08ca0f4595b8\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/useActionContext.js\":\"8aa4172e096ccdf7\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/useActionDiscovery.js\":\"149ebc34b727c774\",\"/knowledge-medium/pr-preview/pr-1799/src/shortcuts/utils.js\":\"52402c2e4154b0e5\",\"/knowledge-medium/pr-preview/pr-1799/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1799/src/sw/bootStore.js\":\"2bd1be7de18d609a\",\"/knowledge-medium/pr-preview/pr-1799/src/sw/previewDatabases.js\":\"522b0cb14481ef27\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/byteTransform.js\":\"d3e6d974df15911d\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/attachmentCleaner.js\":\"c0479e0bacf032a9\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/bundle/attachmentParts.js\":\"6c5b2a6b73e68011\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/bundle/bundleParts.js\":\"8c6d42912841f02f\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/bundle/bundleRecord.js\":\"8216cabf9f7e8017\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/bundle/manifest.js\":\"310baa3b96d388da\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/bundle/takeBundle.js\":\"e2c817091501c229\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/bundle/verifyBundle.js\":\"4530e656e25de40a\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/cleaningStage.js\":\"392889e3f2e3c014\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/conversionKey.js\":\"46ccae60ecb7c1c4\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/conversionServer.js\":\"4f2596cef01d0060\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/flip.js\":\"bbc0c24c9ed74223\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/flipAttempts.js\":\"2e822328e7e7e477\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/pages.js\":\"82ad97ac35eb893b\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/preflight.js\":\"2d621032551e96a6\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/reseal.js\":\"0c14d0b67d4f504a\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/runConversion.js\":\"44bd800e15106ba9\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/runLock.js\":\"1a941dd6b6cd3ec1\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/sealing.js\":\"8dea9ccc7703bcb6\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/sealingStage.js\":\"ba376348488b9db7\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/stage.js\":\"aa6e4dcd9216d186\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/conversion/verifyReseal.js\":\"92f1785832b5fb91\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/aad.js\":\"f2091d7e4a2d122e\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/aead.js\":\"861e5b204d112c01\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/base32.js\":\"937f02d76940a726\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/base64url.js\":\"f341bdf8586bdf56\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/binaryEnvelope.js\":\"1ddb980387bce272\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/byteAead.js\":\"3e9fd17aa754e3dd\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/canary.js\":\"400a3d9fb514a199\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/contentHash.js\":\"25ac4e3ca74daaef\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/contentKey.js\":\"35c0825172e8e0b5\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/derivedIdNamespace.js\":\"9100bd8c4a062310\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/envelope.js\":\"ffe1235664f5d4f8\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/hex.js\":\"c89451ee16e03385\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/sha256Hex.js\":\"0fcdd3341cc4c087\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/crypto/workspaceKey.js\":\"95790c49e715ffc6\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/conversionState.js\":\"37bc46a9ed1982ad\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2dbfe3a0e9f21cec\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/flows/pastedKey.js\":\"bf30ad5718d631b3\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7923d31307f2e515\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0173a6b189c345b5\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/keyStore.js\":\"c0915b0cd593ba32\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/mintWorkspaceKey.js\":\"0baff185d0708de8\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/modePin.js\":\"fa6b264574697fa1\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/openWorkspaceKeys.js\":\"ca03e9553860c3cf\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/resolveWorkspaceEntry.js\":\"9b4e4caa9335b473\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/resolver.js\":\"cf39911ec242eb8c\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/keys/workspaceAccess.js\":\"41a61d6fdb27a67c\",\"/knowledge-medium/pr-preview/pr-1799/src/sync/transform.js\":\"ee11e9780fbe1424\",\"/knowledge-medium/pr-preview/pr-1799/src/themeBootDefaults.js\":\"f0714e566e0558e2\",\"/knowledge-medium/pr-preview/pr-1799/src/types.js\":\"86d22c84bf31e927\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/ClientLocalSettings.js\":\"b1fa531e061a9923\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/abortableSleep.js\":\"cc6dadd5779fe4d4\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/array.js\":\"3980779c2e74294c\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/backlinkAutocomplete.js\":\"8a8e83dedcd30ec2\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/blockCrumbs.js\":\"5a8bea96727bcc75\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/blockrefAutocomplete.js\":\"6f4b955ba3353907\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/cadencedIdleJob.js\":\"6ba7e505ad2404d2\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/callbackSet.js\":\"95f60dfc63184cd9\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/clientId.js\":\"7059ef4d635ff492\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/codemirror.js\":\"0005f372f979e822\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/codemirrorCompletion.js\":\"529c5a74ddef8419\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/copy.js\":\"b2da949402976cab\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/dailyPage.js\":\"d29a11b2d72ea16c\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/dbForensics.js\":\"9ea03a9be52efb97\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/dbForensicsHooks.js\":\"24a1fa4182b480d9\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/deleteBlockThroughUi.js\":\"193136761cc2d7ec\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/dialogs.js\":\"2bb88e55c00b93fc\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/dom.js\":\"2cade53161550cc7\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/downloadBlob.js\":\"4dec6c962e98c88a\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/exportSqliteDb.js\":\"920377ac244aa4aa\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/fileSystemAccess.js\":\"f727152febabe4e3\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/flipSlide.js\":\"3236d720cbbbfd1c\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/fnv1a.js\":\"40e84f8a32d2ce72\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/formatBytes.js\":\"3da9ec0b76db7afb\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/fuzzyRank.js\":\"12d04474789536f3\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/idbKeyedStore.js\":\"28b1407f5f0e305d\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/idleCallbackPolyfill.js\":\"e21f087f1149dace\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/keyboardAwareScroll.js\":\"96026175b6732ec9\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/keyboardViewport.js\":\"716f19451452a1d7\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/lastWorkspace.js\":\"30274cbdceb87dad\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/layoutColumns.js\":\"f42a9eb0537225cb\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/layoutSessionDom.js\":\"9bce47ed55d4b6fe\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/layoutSessionId.js\":\"df4d36ec6b51ea65\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/linkClickGestures.js\":\"7cce68156ebe6260\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/linkTargetAutocomplete.js\":\"f1a05b9b01850da3\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/localDbCorruption.js\":\"1046e7676955e34b\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/localDbRecovery.js\":\"3e00b05128cb9b4c\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/markdownParser.js\":\"b4ed4885c01c973e\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/memoize.js\":\"c6f2f82fa81c98ab\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/nameFieldCommit.js\":\"db3b546e1580f673\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/nameList.js\":\"7470e9784212b2cd\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/navigation.js\":\"c516c709a5f741c1\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/omnilinerNamespace.js\":\"2d71c623cfd932c2\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/opfsPageScan.js\":\"cead2537a3121226\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/panelClearance.js\":\"6f9feca2a6bc9e35\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/panelHistory.js\":\"70f22f1cb72c7552\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/panelLanes.js\":\"4030993d809b8994\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/panelLayoutProjection.js\":\"f1b1afdacb448aa5\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/panelScrollAnchor.js\":\"e505e57d165d0e99\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/panelUrlFlags.js\":\"e89720888cafaae4\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/platform.js\":\"5af8d0360e60837d\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/pluralize.js\":\"8c57094e9a69451d\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/propertyCreation.js\":\"9c27a481ae6f1fb4\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/propertyNavigation.js\":\"4c32b9dcf4b72429\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/propertyValueContext.js\":\"042d60fee3cfd6bf\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/react.js\":\"7b58203c5da888e4\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/relativeDate.js\":\"d78ebdfe99f25a99\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/relativeTime.js\":\"d317228520660575\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/renderScope.js\":\"debea4d1269975e6\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/resolvedThenable.js\":\"7da0b78e4db809dd\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/routing.js\":\"1f96e548729be5c6\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/safeMode.js\":\"e897b4d2fdf4bcd6\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/scheduleIdle.js\":\"136b88d23d96d03c\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/screenWakeLock.js\":\"0828db0b5a194e01\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/selection.js\":\"5379008641ddc410\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/softKeyboardGrab.js\":\"4003de0fbe43d222\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/startupTimeline.js\":\"f17eaef310f19c89\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/state.js\":\"89be136e05383a8e\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/string.js\":\"23b087fb615ad4fc\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/surfaceZoom.js\":\"af4bc8afc5eb3805\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/time.js\":\"34858839c76b03f0\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/toast.js\":\"aa03797a63e9f508\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/toggleStore.js\":\"a855f17a0e295a71\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/untilStopped.js\":\"f3b477f771df6ed3\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/userActivity.js\":\"3c2e05449ccc2edb\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/viewTransition.js\":\"af70577eb0a979d4\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/viewport.js\":\"8dce1470b2ed53f5\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/webLock.js\":\"3e65a79d4042426d\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/workspaceRecovery.js\":\"7a31bca312de9048\",\"/knowledge-medium/pr-preview/pr-1799/src/utils/workspaceSnapshotStore.js\":\"aef155d1cda54be5\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-compiler-runtime.js\":\"f4828da482513363\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-dom-client.js\":\"3e1fabc826df0a54\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-dom-server-edge.js\":\"8372bccbb8c6152c\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-dom-server.js\":\"0d78dc0379710e2f\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-dom-static-edge.js\":\"8ec22f38b646d1ab\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-dom-static.js\":\"4bbfa3604111cd9f\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-dom-test-utils.js\":\"25cd00999f37e683\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-dom.js\":\"568d6c430c6f99f7\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react-jsx-runtime.js\":\"4c49e7c51ff461ce\",\"/knowledge-medium/pr-preview/pr-1799/src/vendor/react.js\":\"3858bb5d1aaa0905\",\"/knowledge-medium/pr-preview/pr-1799/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1799/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1799/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
