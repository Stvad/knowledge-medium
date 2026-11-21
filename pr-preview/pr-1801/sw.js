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
		buildId: "b59e03c806b0-bcb361a2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1801/\":\"3e2d034435c71d18\",\"/knowledge-medium/pr-preview/pr-1801/index.html\":\"3e2d034435c71d18\",\"/knowledge-medium/pr-preview/pr-1801/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1801/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1801/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1801/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1801/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1801/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1801/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1801/assets/FacadeVFS-iMnHFbOb.js\":\"850a0c319adefc92\",\"/knowledge-medium/pr-preview/pr-1801/assets/OPFSCoopSyncVFS-COOEbX4w.js\":\"d988ec60d5179808\",\"/knowledge-medium/pr-preview/pr-1801/assets/OPFSWriteAheadVFS-CvU06Lmm.js\":\"41b113f9be27a4f7\",\"/knowledge-medium/pr-preview/pr-1801/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1801/assets/wa-sqlite-Cg2DqiVc.js\":\"84cd495aa53b2c51\",\"/knowledge-medium/pr-preview/pr-1801/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1801/assets/wa-sqlite-async-B94Iew2u.js\":\"34babb918cf387d5\",\"/knowledge-medium/pr-preview/pr-1801/assets/worker--TMiamu8.js\":\"58b7c268e3816ed0\",\"/knowledge-medium/pr-preview/pr-1801/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1801/chunks/app-p-m7NlcZ.js\":\"929e642215442821\",\"/knowledge-medium/pr-preview/pr-1801/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1801/index.js\":\"f8757c96597ab0b0\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1801/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1801/assets/AccessHandlePoolVFS-D30Z9g0F.js\":\"631d5cc021b5d241\",\"/knowledge-medium/pr-preview/pr-1801/assets/IDBBatchAtomicVFS-T7FsqZWj.js\":\"a26ac1fcc3db0ebe\",\"/knowledge-medium/pr-preview/pr-1801/assets/MemoryVFS-Cd2sukfz.js\":\"5b1226fa9c292363\",\"/knowledge-medium/pr-preview/pr-1801/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1801/assets/mc-wa-sqlite-DOJcXwqm.js\":\"d84c030e693d087d\",\"/knowledge-medium/pr-preview/pr-1801/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1801/assets/mc-wa-sqlite-async-z3QRvHLP.js\":\"77793730756ebdf2\",\"/knowledge-medium/pr-preview/pr-1801/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1801/chunks/AccessHandlePoolVFS-C35p5MyT.js\":\"bdf91c9cbb8127a7\",\"/knowledge-medium/pr-preview/pr-1801/chunks/FacadeVFS-BHWQNV-2.js\":\"f3521c934b7e5c29\",\"/knowledge-medium/pr-preview/pr-1801/chunks/IDBBatchAtomicVFS-DzbFfl6_.js\":\"faa7446f96d0d849\",\"/knowledge-medium/pr-preview/pr-1801/chunks/MemoryVFS-Dwt7X8DE.js\":\"32069c309292ce7b\",\"/knowledge-medium/pr-preview/pr-1801/chunks/OPFSCoopSyncVFS-D8wqaCGr.js\":\"7faed9183d52d266\",\"/knowledge-medium/pr-preview/pr-1801/chunks/OPFSWriteAheadVFS-DOsls_vQ.js\":\"4d3e16137902a481\",\"/knowledge-medium/pr-preview/pr-1801/chunks/Preview-C_l6jh9r.js\":\"868e2ed2ea048f52\",\"/knowledge-medium/pr-preview/pr-1801/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1801/chunks/card-CjvA6ADW.js\":\"333cdfc49c7e9791\",\"/knowledge-medium/pr-preview/pr-1801/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1801/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1801/chunks/dist-Bl8CwhHR.js\":\"a36d73426526692a\",\"/knowledge-medium/pr-preview/pr-1801/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1801/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1801/chunks/mc-wa-sqlite-CYvKn71h.js\":\"33bf08edaa71e640\",\"/knowledge-medium/pr-preview/pr-1801/chunks/mc-wa-sqlite-async-HF2hvG33.js\":\"fd5984e15311d8bb\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-5Z3vL660.js\":\"c244542140b45348\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-BUTLuSGy.js\":\"30aadc49d99644ba\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-BoG1mOLj.js\":\"9f95e44fffc6259d\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-CsE4lSQ4.js\":\"da0c43ddca1f074a\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-D5hsRx-E.js\":\"b053ae3b631d91b3\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-DCuFhERa.js\":\"d78b46fc34d67a42\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-DIaftvSw.js\":\"9d1718724ce73619\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-DTPygYCT.js\":\"ae972e7283750c20\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-dom-server-legacy.browser.production-CsxvxVN4.js\":\"177082038455f3dc\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-dom-server.browser.production-Bb0YpAq-.js\":\"511711df5950fd65\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-dom-server.edge.production-CMfSUugw.js\":\"387e016672cd3dec\",\"/knowledge-medium/pr-preview/pr-1801/chunks/server.browser-COcfRY0e.js\":\"b4ab35b5955d2f62\",\"/knowledge-medium/pr-preview/pr-1801/chunks/textarea-CsRX3keW.js\":\"5e1df9176b0d9e13\",\"/knowledge-medium/pr-preview/pr-1801/chunks/ui-C9Q6KIo6.js\":\"0a3c5aa1b4a6611c\",\"/knowledge-medium/pr-preview/pr-1801/chunks/wa-sqlite-CzTARoWm.js\":\"b56a3fd6526f556e\",\"/knowledge-medium/pr-preview/pr-1801/chunks/wa-sqlite-async-Cq4RHvF1.js\":\"4087f3e0146e3fb4\",\"/knowledge-medium/pr-preview/pr-1801/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1801/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1801/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1801/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1801/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1801/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1801/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1801/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1801/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1801/src/App.js\":\"99555047da8c4103\",\"/knowledge-medium/pr-preview/pr-1801/src/appUpdate.js\":\"91041d6997171505\",\"/knowledge-medium/pr-preview/pr-1801/src/appVersion.js\":\"f7704b8c751fad48\",\"/knowledge-medium/pr-preview/pr-1801/src/bootstrap/initialLayout.js\":\"191a892d18b32c79\",\"/knowledge-medium/pr-preview/pr-1801/src/bootstrap/openWorkspaceData.js\":\"bf08831373c072d5\",\"/knowledge-medium/pr-preview/pr-1801/src/bootstrap/resolveWorkspace.js\":\"fde528906cdb3891\",\"/knowledge-medium/pr-preview/pr-1801/src/bootstrap/workspaceBootstrap.js\":\"1e12572b8763f526\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockComponent.js\":\"d17a41e913d2f04b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockCrumbs.js\":\"3da6409465570113\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockEditor.js\":\"77d4c2c60fa62e7c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockLoadingPlaceholder.js\":\"899b57ed79e0e979\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockProperties.js\":\"596c192694400bea\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockSearchPicker.js\":\"6aff8f1fa7f63d1e\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ConfirmBulkDeleteDialog.js\":\"bbbd3259ed8d02f4\",\"/knowledge-medium/pr-preview/pr-1801/src/components/DividerHandle.js\":\"985a7269db775582\",\"/knowledge-medium/pr-preview/pr-1801/src/components/DraftEditor.js\":\"f10f197f6b71aa16\",\"/knowledge-medium/pr-preview/pr-1801/src/components/GutterPill.js\":\"7e64f192edd49d43\",\"/knowledge-medium/pr-preview/pr-1801/src/components/Header.js\":\"a665b3b94681724d\",\"/knowledge-medium/pr-preview/pr-1801/src/components/LazyBlockComponent.js\":\"c81196534640390e\",\"/knowledge-medium/pr-preview/pr-1801/src/components/Login.js\":\"0a3e8aa8bd95642b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ZoomableSurface.js\":\"8f74e7f59e512bad\",\"/knowledge-medium/pr-preview/pr-1801/src/components/editModeKeepalive.js\":\"e28868b270b97d6b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f24be48ed56c746e\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"fbeb16ac6d64fd7c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/RefPropertyEditor.js\":\"d7935bfff061a62a\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/RefTargetTypePicker.js\":\"4773bbd37a49b5b5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/SelectPropertyEditor.js\":\"8c9e88c8cdf66f88\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/TypesPropertyEditor.js\":\"1c117821b5d4f034\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/defaults.js\":\"503a6d83c0e01c36\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/kernelValuePresets.js\":\"c9f557c23bdf41c3\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/selectablePresets.js\":\"5220f4c3aab53e96\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/typesPropertyUi.js\":\"e03d8a5be602f736\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/AddPropertyForm.js\":\"637e93f033f1991e\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/PropertyPicker.js\":\"559aa73c8d2d4b66\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/PropertyRow.js\":\"894bbcf7cb14a07d\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/Rows.js\":\"bdb89f46156e9844\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/actions.js\":\"b0ee6008c3470af5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/declarationOnly.js\":\"32cb0b3807b672e4\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/layout.js\":\"fb8aeac1067e6b72\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/model.js\":\"31d1eb3ca77c958f\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/shapeUi.js\":\"a2eb8fd884de40eb\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/shapes.js\":\"e59298a96eba2485\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4d19b504b7bc38e4\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/visibility.js\":\"cf1e86aa141ec860\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanelSections.js\":\"390d606d09da5396\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/BlockEmbed.js\":\"0e9956a177a7e2bc\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/BlockLink.js\":\"389fc7cd94cf931d\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/BlockRef.js\":\"dbd89767d92f53de\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/ReferenceLink.js\":\"08b0601be562834f\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/cycleGuard.js\":\"de701233dfdfb3ba\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/cycleGuardContext.js\":\"cdaeaef22a3b5b06\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/linkInteraction.js\":\"172d70a60f48a3a4\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/referenceLayout.js\":\"696f76929c30400b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/useBlockRefAncestors.js\":\"9b756913308eed5a\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/BlockGutter.js\":\"ad2c0c87088d4f05\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/BlockInfoDialog.js\":\"329078a784597a07\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/BlockTypeBlockRenderer.js\":\"a5eb4488ec865a65\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/BulletHoverCard.js\":\"f3041ce79e952395\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/CodeMirrorContentRenderer.js\":\"51a1ef799354c756\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6b5c39e682f231ed\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/ColumnResizeHandles.js\":\"689b582ff520fd79\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9666db26be142c88\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/DefaultBlockRenderer.js\":\"b3594ef7e76fbe9c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/LayoutRenderer.js\":\"ea874671375827d9\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/MarkdownContentRenderer.js\":\"84e3df3bbd351259\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/MissingDataRenderer.js\":\"eb42dba5bea7c2f3\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/PanelRenderer.js\":\"6e20268f9dbf8fe6\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f87d4c7fa1f8d9a4\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/TopLevelRenderer.js\":\"191b55e0bfde8064\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/blockGutterMode.js\":\"462c6a1d3b7fbdf6\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/blockTitleText.js\":\"ff5bfcf0ba55a3eb\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/fieldCreationKeydown.js\":\"d541952117e290ba\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/layoutRootContext.js\":\"51d56436628c0c4d\",\"/knowledge-medium/pr-preview/pr-1801/src/components/typeChip/TypeChip.js\":\"cdae260d95668f10\",\"/knowledge-medium/pr-preview/pr-1801/src/components/typeChip/chipStyle.js\":\"3cad62d1c703a60b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/anchored-floating.js\":\"a10ab98ed20c323f\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/button.js\":\"f66a8b005cd190e7\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/card.js\":\"f894398a7e4a790a\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/checkbox.js\":\"22da6817a1d13f62\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/collapsible.js\":\"f304fd314a511da1\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/command.js\":\"7bb7834ad8436ff6\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/context-menu.js\":\"c7b0826cbff8ac1c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/dialog.js\":\"4dfedb2f2a2f7c96\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/dropdown-menu.js\":\"cc38cf3058d7c83f\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/floating-listbox.js\":\"c4c13aa81bb23f83\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/index.js\":\"7e5392310b7e5cdb\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/input.js\":\"f171af534032ba39\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/kbd.js\":\"531e2dc42b911f38\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/label.js\":\"8550d9957ead9872\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/textarea.js\":\"6b3b6638d1b1b6d5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/useEditModeYieldKeepalive.js\":\"500cf25f021457f1\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/BootFallback.js\":\"12f41882190bb918\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/FocusedRowLazyMount.js\":\"b2da057d4e099bc2\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/LazyViewportMount.js\":\"7507ec15b139894a\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/LocalDbCorruptionFallback.js\":\"5eb5f142ddd924f5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/error.js\":\"84bb4c7e0ec27456\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/lazyMountRegistry.js\":\"78e3c1561348fe45\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/suspense.js\":\"82a2e4416bf1b9e5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/CreateWorkspaceDialog.js\":\"7f9d95c98c4c8af1\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/PendingInvitations.js\":\"2c0953ea3f23323c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/SyncProgress.js\":\"9e3af78c4e8a3385\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/UnlockProgress.js\":\"511016ab0aa80312\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/WorkspaceKeyGate.js\":\"b34680b6dcafe609\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/WorkspaceSettingsDialog.js\":\"092e81fd81f48f8f\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/WorkspaceSwitcher.js\":\"b2385474a99a5100\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/WorkspaceSyncGate.js\":\"87222b6e44b6b185\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/ConversionFlow.js\":\"df3d525c5a41e74c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/ConversionFlowHost.js\":\"e77584dcfe3fd0c8\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/EncryptionSection.js\":\"00f82caf78b0edb0\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/attachmentPrompts.js\":\"cc598b38d276307e\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/bundleFolderPrompts.js\":\"706e79241f44de11\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/conversionFlowDeps.js\":\"812957d5851d8ad5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/conversionFlowStore.js\":\"b2c5c53c78c8cda8\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/flowUi.js\":\"7f0186c26dc2c914\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/useConversionRun.js\":\"bdc860267e47f5ea\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/keyUi.js\":\"18c4dfc0f467499a\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/useCloseOnKeyLoss.js\":\"1da57491b48c2e7c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/useCloseOnServerE2ee.js\":\"a4a711181b840222\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/workspaceUnlocked.js\":\"d5cf2559ff0a06df\",\"/knowledge-medium/pr-preview/pr-1801/src/context/backgroundSubtree.js\":\"59e4c21a1f2fd6a9\",\"/knowledge-medium/pr-preview/pr-1801/src/context/block.js\":\"c9b78374ad4b6c11\",\"/knowledge-medium/pr-preview/pr-1801/src/context/layoutWsContext.js\":\"6ba207fc53e3d16e\",\"/knowledge-medium/pr-preview/pr-1801/src/context/propertyDisplay.js\":\"a77844fe924ea2fd\",\"/knowledge-medium/pr-preview/pr-1801/src/context/repo.js\":\"be69f28d5bcd0d9d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/aliasClaim.js\":\"3541cdec32e0d85a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/aliasSeatNamespace.js\":\"ef8b1d8178f1c7ad\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/blockData.js\":\"086b2a0ec2e1706f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/blockType.js\":\"23f20688fd8ff5e5\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/changeScope.js\":\"ca1484ffb6085a9e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/codecs.js\":\"83ec2d7681c65dbd\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/derivedData.js\":\"e45541673e9331f9\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/errors.js\":\"e7a0fa3c37730a21\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/events.js\":\"2e757e76f01965c2\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/handle.js\":\"6ad634712fe457cb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/index.js\":\"2b937f5a037989f6\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/mutator.js\":\"cecc238bd8fc85e8\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/processor.js\":\"dde7a6ac362e649a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/propertySchema.js\":\"41667b5ece750604\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/query.js\":\"bd896516e68e0ee3\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/sameTxProcessor.js\":\"a3d6dade99fcb274\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/schema.js\":\"6ad634712fe457cb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/tx.js\":\"6ad634712fe457cb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/typedBlockQuery.js\":\"f4db5d43a9c19a54\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/user.js\":\"70df198851849bf6\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/valuePresetCore.js\":\"57e54675107198d7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/valuePresets.js\":\"705cbaa9ceab3c44\",\"/knowledge-medium/pr-preview/pr-1801/src/data/attachmentCleanerIOVerb.js\":\"b952f874a5682ea7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/block.js\":\"30a933f3594bce43\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockCache.js\":\"040dfed918d6d74a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockId.js\":\"6b4840e418356aa8\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockLiveness.js\":\"585a89e8d876dc49\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockMerge.js\":\"92d2a43f18dc4e7f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockSchema.js\":\"ba24098ffe7f5f31\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockTypes.js\":\"332e50b46a219f47\",\"/knowledge-medium/pr-preview/pr-1801/src/data/clientContext.js\":\"b1a68fe3098bdc20\",\"/knowledge-medium/pr-preview/pr-1801/src/data/dbFileSiblings.js\":\"50c4cd55cd9c56b0\",\"/knowledge-medium/pr-preview/pr-1801/src/data/definitionSeeds.js\":\"c03949c73eff46e4\",\"/knowledge-medium/pr-preview/pr-1801/src/data/derivedIds.js\":\"08b83cbb2eb3b25a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/drawnSubtree.js\":\"86eb8601ad83822f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/facetBridge.js\":\"db2b45ff02ee715c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/facets.js\":\"f8d2be5d369b0f10\",\"/knowledge-medium/pr-preview/pr-1801/src/data/globalState.js\":\"cbd784ff434506aa\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/aliasClaimRederiveProcessor.js\":\"ac1f41fa5e6c57fc\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/ancestorBatch.js\":\"41d69696fe96d055\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/blockTypeTypeifyProcessor.js\":\"a43bc89a1337cdbc\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/clientSchema.js\":\"10ef383160ae06d4\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/commitPipeline.js\":\"3addc11a4bf79113\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/devAssertions.js\":\"3ef23a63003ea597\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/firstSync.js\":\"04453a1c3ccdcd30\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/freshInitialLoad.js\":\"56c4526e2b37754b\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/graphBackfillClaim.js\":\"03e2642da0c8c5c5\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/handleStore.js\":\"8961929882c94885\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/idleMarkerJobs.js\":\"cc04655773ce57b1\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/initialDownload.js\":\"53006a51c6b8420f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/initializeClientDatabase.js\":\"b6a305cda2003017\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/jsonCanonical.js\":\"f05e69ea18daff0c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/kernelInvalidation.js\":\"da162ef2a2c3b34c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/kernelProcessors.js\":\"a99c96a60bcf6266\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/kernelQueries.js\":\"7fea071f1c4ac22c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/mergeTypeMembershipProcessor.js\":\"6226915b102c06f0\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/normalizeReferencesProcessor.js\":\"d117e720564f7cc8\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/poolInstrumentation.js\":\"bf8e2a90539da1b9\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/processorRunner.js\":\"6cfe6766dae0ecd1\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyCellBackfill.js\":\"41ec99a3398f043c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyChildMint.js\":\"d46b509cbe471a17\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyChildrenProcessor.js\":\"b841cbfd25a122a1\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9fa43ff508f2b72b\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyDefinitionSynthesis.js\":\"1a79bf83ec944488\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyKeyScan.js\":\"eb608237afdac92a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertySchemaResolution.js\":\"6d1441c9f5f63a29\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyValueEdits.js\":\"779ac2c5a6d59f69\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/raiseProtocol.js\":\"8e1745d93c9c7f2d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/readBatch.js\":\"f9aa011ea076414a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/refProjection.js\":\"d22f1ac1643f707c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/referenceTargetLookups.js\":\"4c355d6e53b7c458\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/referenceTargetProcessor.js\":\"0f20b22f073f3fb5\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/replayMerge.js\":\"aedd74bfdb218fe3\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/sqlBinds.js\":\"a8d6e90f4dcba526\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e766fe006f8f9b04\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/arrivalProcessors.js\":\"fe886e9ca350acd7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/invalidate.js\":\"60df31b8ad0f5757\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/materialize.js\":\"cd6a401a074a2bc9\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/observer.js\":\"8048658f86d7559a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/reconcile.js\":\"da3f9a0446d48aa0\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/timingMetrics.js\":\"3a9af921bad89b51\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/treeQueries.js\":\"2792c99b4b9b5f36\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/txEngine.js\":\"c259290c295ea924\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/txSnapshots.js\":\"89404f4f35490872\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/typedBlockQuery.js\":\"4c02b7bf115039b3\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/undoManager.js\":\"9e86f41bd0054e8e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/invalidation.js\":\"c866d3f926efbe65\",\"/knowledge-medium/pr-preview/pr-1801/src/data/kernelDataExtension.js\":\"98cbabb02d2bc6c7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/kernelPage.js\":\"47ebd724a8b82a57\",\"/knowledge-medium/pr-preview/pr-1801/src/data/kernelValuePresetCores.js\":\"d9015ae0b9b5713f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/localDbCorruptionSignal.js\":\"71aa35dc81e635a5\",\"/knowledge-medium/pr-preview/pr-1801/src/data/localDbStorage.js\":\"a59ddc8e355b47f6\",\"/knowledge-medium/pr-preview/pr-1801/src/data/localDbVfs.js\":\"3fe819d7f69073cc\",\"/knowledge-medium/pr-preview/pr-1801/src/data/localSchema.js\":\"abd5270014d6cdfb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/maintenance.js\":\"f77e1b953bdf7fd8\",\"/knowledge-medium/pr-preview/pr-1801/src/data/mergeProperties.js\":\"71ee1836dc919f98\",\"/knowledge-medium/pr-preview/pr-1801/src/data/metricsConsoleHook.js\":\"3de6f6089b2386e7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/migrationsPage.js\":\"286bc8b1ae8eec3e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/mutators.js\":\"9b9f8033c84c64d1\",\"/knowledge-medium/pr-preview/pr-1801/src/data/orderKey.js\":\"88fe86c92cefe8fa\",\"/knowledge-medium/pr-preview/pr-1801/src/data/orderKeyPlacement.js\":\"042e59d604a3c89b\",\"/knowledge-medium/pr-preview/pr-1801/src/data/outlineSurface.js\":\"fa02c31a2ecf6819\",\"/knowledge-medium/pr-preview/pr-1801/src/data/pendingEditorContent.js\":\"deedb15df829be82\",\"/knowledge-medium/pr-preview/pr-1801/src/data/pendingUploadsSql.js\":\"30a5d7e98052d59e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/pluginStateExtensions.js\":\"72f3f378138c24fa\",\"/knowledge-medium/pr-preview/pr-1801/src/data/powerSyncLogger.js\":\"ea3cd045ae8795a8\",\"/knowledge-medium/pr-preview/pr-1801/src/data/projectorRuntime.js\":\"41b70bae7b9997c2\",\"/knowledge-medium/pr-preview/pr-1801/src/data/properties.js\":\"bc249ee82e815af7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertiesPage.js\":\"9775a689e7ba9d01\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyChildren.js\":\"a4dc205163143a49\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyDefinitionFanout.js\":\"aaa49487c64b0f53\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyDefinitionMetadata.js\":\"9495f8e47d5fdfce\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyDefinitionRegistry.js\":\"f32cd203ca0a8f03\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyDisplayMode.js\":\"687ddf34e00dc6a7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyRowCreation.js\":\"8ba01f1ef7085f34\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertySchemaCreation.js\":\"3b9e34245ad0cab7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertySeeds.js\":\"60aca302d7045c71\",\"/knowledge-medium/pr-preview/pr-1801/src/data/recentsPage.js\":\"d98e5a1ae9d854f2\",\"/knowledge-medium/pr-preview/pr-1801/src/data/referenceBlock.js\":\"0b3065434ebe0c0c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/releasePowerSyncConnection.js\":\"9bdda22b97733b40\",\"/knowledge-medium/pr-preview/pr-1801/src/data/repo.js\":\"424ce4a2597db852\",\"/knowledge-medium/pr-preview/pr-1801/src/data/repoProvider.js\":\"3cec985dde88686c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/rowProperty.js\":\"94fd45f290324528\",\"/knowledge-medium/pr-preview/pr-1801/src/data/searchFilter.js\":\"824f046990fce99f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/seedIdentityLedger.js\":\"eca11150a502d3b6\",\"/knowledge-medium/pr-preview/pr-1801/src/data/stateBlocks.js\":\"59cef20233b2e07b\",\"/knowledge-medium/pr-preview/pr-1801/src/data/structuralEditPolicy.js\":\"d2b170f53aa04981\",\"/knowledge-medium/pr-preview/pr-1801/src/data/subtreeDelete.js\":\"95b0a230c523cfec\",\"/knowledge-medium/pr-preview/pr-1801/src/data/syncStreamLock.js\":\"2fd626a7c2f3f48a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/syncedTableSqlRecognizer.js\":\"3e11b83406a92475\",\"/knowledge-medium/pr-preview/pr-1801/src/data/syncedTableWriteGuard.js\":\"a622b915f98aafc0\",\"/knowledge-medium/pr-preview/pr-1801/src/data/targets.js\":\"2ca057fdb20607fb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeColors.js\":\"473c5c8b5cc2577a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeDefinitionMetadata.js\":\"b56bc038148a0aac\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeDefinitionRegistry.js\":\"cec415ab102739a8\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeExtraction.js\":\"9b9bf8f92d403f94\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeInitialValues.js\":\"56d2513c9e9b4dac\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typePropertyGroups.js\":\"f36224842b2f0eef\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeSeeds.js\":\"00e08f953a45af05\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeTagger.js\":\"99a75a82f50d480e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typedRecords.js\":\"80e0d93e16cde42f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typesPage.js\":\"55d010b37f916c9f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/userPrefs.js\":\"5887cf97bb61d509\",\"/knowledge-medium/pr-preview/pr-1801/src/data/userSchemasService.js\":\"3d29e650a2606045\",\"/knowledge-medium/pr-preview/pr-1801/src/data/userTypesService.js\":\"bc80e7b2ce393492\",\"/knowledge-medium/pr-preview/pr-1801/src/data/valuePresetRegistry.js\":\"9cb6640d4fbb1213\",\"/knowledge-medium/pr-preview/pr-1801/src/data/visibleChildren.js\":\"b453f1aafb64b7ae\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaceConversion.js\":\"3e3143dccf6b9c80\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaceFirstSync.js\":\"180cd2bfdbe163fb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaceIdNamespace.js\":\"d153b4c22ea06ad4\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaceSchema.js\":\"0c72715fadd835cb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaces.js\":\"41e4b4ddfef01e5f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/writeAheadLog.js\":\"f6ad8440fef9a288\",\"/knowledge-medium/pr-preview/pr-1801/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/BlockPasteShellDecorator.js\":\"653b0ca6904ecf56\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/atTrigger.js\":\"d090fcb1a691bd8a\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/autocomplete.js\":\"37782a200bd4f716\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/codeMirrorExtensions.js\":\"fc086040687dc5d1\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/contentFlush.js\":\"14b4de5020409372\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/defaultInteractions.js\":\"4f132f02956d0bf5\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/editSettleSignal.js\":\"caa52ca9d3caa358\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/insertImage.js\":\"8cb63c4b090650b1\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/referenceCompletionRange.js\":\"c186f82620a402e3\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/referenceTargetTypes.js\":\"ae9097a1b0fce66d\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/syntaxContext.js\":\"4ee548c33b14c242\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/triggerMatch.js\":\"989ac3ac368f33c7\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/AppRuntimeProvider.js\":\"f2ab264aa21b17cf\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/BlockFocusShellDecorator.js\":\"d6f67afe144654aa\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/ExtensionRenderBoundary.js\":\"b63c219596632463\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/PanelContentRecovery.js\":\"62b43cb48c0515bf\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/apiCatalog.js\":\"09ac3f3571d0fec8\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/approveExtensionHere.js\":\"f607fde59b4cf859\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/armedCutAppMount.js\":\"ce36964abb3c41e7\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/batchableKeyedStore.js\":\"651ba319119b5530\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/blockInteraction.js\":\"a5fc71448de4c9ea\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/blockSelectionAction.js\":\"723d17540449c767\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/compileExtensionModule.js\":\"fa1dd361d4189199\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/compiledModuleCache.js\":\"3340e2cc0c37ca35\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/continuousGestures.js\":\"ec4e4b4f850f46b5\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/core.js\":\"62bba0fa8ec6d537\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/defaultRenderers.js\":\"a31e23c506889d80\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/definitionFanoutAppMount.js\":\"5b60eb57b9716671\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/dialogAppMount.js\":\"52df7636de351ece\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/dynamicExtensionSeeds.js\":\"11b350a91c084537\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/dynamicExtensions.js\":\"1d25504f105f71a1\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/exampleExtensions.js\":\"3a7b625c58443840\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionApprovalStatus.js\":\"68f4a039b8b2e3ca\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionLoadErrorToast.js\":\"2d94e6604f173e6f\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionLoadErrors.js\":\"2394ee96400c48a1\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionLookup.js\":\"068862488651c0bb\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionToggles.js\":\"692ecbee78575685\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionUtilitiesCss.js\":\"6cdac933e29d7848\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/kernelPageDeletionGuard.js\":\"267dc63cf9f112b9\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/liveRuntime.js\":\"1b7a8ddc3f0a2b3b\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/openExtensionsSettings.js\":\"c7ce0c483715ac5b\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/overridesCache.js\":\"11726cb7422e362a\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/pluginIds.js\":\"5531c2fded00f8c9\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/processorRejectionToast.js\":\"9c7196617044c737\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/runtimeActions.js\":\"80d8a780f9671c2f\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/runtimeContext.js\":\"ecb65531efa66051\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/staticAppExtensions.js\":\"8776066f689f6bbe\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/staticDataExtensions.js\":\"dc0be739c1e9fe86\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/toastAppMount.js\":\"4af807cfd6ba0543\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/useOverrides.js\":\"73e823656784ef29\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/useShortcutSurfaceActivations.js\":\"c3e9cf68aec27778\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/discoverToggleTree.js\":\"909d2e272f10db5e\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/facet.js\":\"75ad36fc21785dc4\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/resolveAppRuntime.js\":\"7304b47b1b8fb67f\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/runtimeEvents.js\":\"90161cf6cea41c74\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/togglable.js\":\"5265604b3f989955\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/variantFacet.js\":\"4c178dcf9d9e674b\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/verbFacet.js\":\"66ff59d23214702a\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/block.js\":\"5301711773dbc5c9\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/focusedChild.js\":\"64bd83d51056a49f\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/propertySchemas.js\":\"9164a3a0220a202c\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/typeRegistry.js\":\"c69477a33c774bb3\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useAncestorCrumbs.js\":\"7e50033710e0b1fe\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useAutocompleteListbox.js\":\"028f99d5b680b023\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useDebouncedSearch.js\":\"bda4097a1681fc3e\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useDebouncedValue.js\":\"132750aeb5656157\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useIsFocalRender.js\":\"a3ca9eb449f4cac4\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useIsReadOnly.js\":\"04b87925d4ed4dbf\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useMaterializeBacklog.js\":\"afe6c00ce80a2564\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useMinuteClock.js\":\"395a6a9285ae0106\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/usePanelLayoutProjection.js\":\"b8d644bf25a416ad\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/usePendingInvitations.js\":\"bf3eca20f05baff3\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useRendererRegistry.js\":\"6868721877966a19\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useRetainedFieldRows.js\":\"fce422c2bcfb4220\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useWorkspaces.js\":\"69b8e3c6d379cd21\",\"/knowledge-medium/pr-preview/pr-1801/src/lib/utils.js\":\"17f1443b9b88f214\",\"/knowledge-medium/pr-preview/pr-1801/src/main.js\":\"e0c3363bf5c4e385\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/MarkdownImage.js\":\"f50c51ab518df0e4\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/blockSeparators.js\":\"974373a91c8d4dd1\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/context.js\":\"0547f8ee45a8fff8\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/defaultMarkdownExtension.js\":\"09a4152ddedb0612\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/extensions.js\":\"fa06b7bc23d4c520\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/renderMarkdownHtml.js\":\"f120d0e459b14c59\",\"/knowledge-medium/pr-preview/pr-1801/src/minimal-editor.js\":\"5d96c83587a7d4c4\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/armedCut.js\":\"32296ec06e721a5b\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/captureMediaVerb.js\":\"9ba7b6792431daaf\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/clipboard.js\":\"eff0b958c39b755a\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/decision.js\":\"131f2f8f3bf2d424\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/operations.js\":\"83f941a867ebd499\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/account-header/AccountHeaderItem.js\":\"8e532c6009b19a0e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/account-header/index.js\":\"9d98024921cc0262\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"320e6ff482b4f134\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/askAgent.js\":\"9ce35d15a67ab411\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/askedStore.js\":\"d73da761c78844b3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f486251f0c873add\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/chipState.js\":\"90be683ca88d365b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a41481782f5a1c06\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/index.js\":\"31077d8f6d74216e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"0eeece8b48ef921b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/schema.js\":\"00566fc8d36d1009\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/AgentTokensDialog.js\":\"16b27452df1b8d1b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ba7530d18082d958\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/addMedia.js\":\"7e217606709cd2de\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e341e4c087a351b4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/block.js\":\"1027aa6417241a0b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/context.js\":\"fa0a19e8da71940d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f6a4e7784b597eb9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/index.js\":\"ed87a390e37337d7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/outline.js\":\"628f06a2ab83dbae\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/properties.js\":\"2cfc5243041bd76a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/refs.js\":\"9aa4b885fffff6d3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"aa97e84bf0d486af\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/search.js\":\"c2355aab93533871\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/shared.js\":\"694b6523264cde93\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8f89b54544a16596\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/text.js\":\"990fb9e7a94d7b7c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentWrites.js\":\"e47aaf2f0bb50b11\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/authoringCatalog.js\":\"558a8d63f352bc8e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/blockRefTargets.js\":\"5716aad1f087c633\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/bridge.js\":\"a9a43197f19c9df3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/bridgeLoop.js\":\"ce08f3308a54ef02\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/changeHistory.js\":\"6ac98a21212e6ac1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/commands.js\":\"bd80ca1f79b1cf7a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/commentsCommands.js\":\"f7ee81cc33ccd164\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/dataExtension.js\":\"fdbee71e412df491\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/dataModelGuide.js\":\"2e919f685d92d379\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/describeRuntime.js\":\"4adaee2246de5f62\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/extensionLint.js\":\"61bd0ec2eaaac82b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/grainAudit.js\":\"b478d9921fc97286\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/healthCommand.js\":\"8b419e79a4807b9c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/index.js\":\"dfebf1d0f27570c9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/presetIdentity.js\":\"91c3aa9140157066\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e61215f701245fcf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/readMedia.js\":\"6aa18e68349471c3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/schema.js\":\"100608aacbd53c60\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/serialization.js\":\"5d0387bc6b8bea07\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/targets.js\":\"163ac8a27bdaa2fc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/tokens.js\":\"e034b49cb5945d5a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/watchEvents.js\":\"c235022dee8b2fcb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/workspaceGuard.js\":\"a4ebe73ed2e41af5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/writeCommands.js\":\"78304cf77d0724bc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/AliasCollisionToast.js\":\"08a05575a833446a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/DuplicateNameBanner.js\":\"3dbacb00cfe3041e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/collisionMerge.js\":\"6b1ba691ca17f302\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/dataExtension.js\":\"f9782c1970a98368\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/index.js\":\"abe52f0477414ece\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/mergeCollisionAction.js\":\"72b3327e8271274f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/pageStyling.js\":\"c51cd5e631375660\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/rejectionToast.js\":\"5468ac0dba5bd5da\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/syncProcessor.js\":\"74d1e78c2e3aba12\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/actions.js\":\"a016a2285641bcdd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/addComment.js\":\"0865c1c22d846366\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/anchor.js\":\"93ad79be1bb4f98a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/anchorState.js\":\"225efbc977f1ead8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/commentLinks.js\":\"a8592a427997b012\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/confirmThreadDeletion.js\":\"e5e67bed1fcaf3d3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/container.js\":\"c09096fd9cc63b51\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/dataExtension.js\":\"a9e0f5ae40995283\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/deleteComment.js\":\"4df2a6bd6737591b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/highlights.js\":\"837b4ee8da5a52c4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/index.js\":\"b9dd6a0f9c054e34\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/linkedCommentsPill.js\":\"71a874c993f1f8e0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/margin.js\":\"fbd2979530e31dab\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/marginSchema.js\":\"5c0ae5b8548a1500\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/newComment.js\":\"b6f97e62d9234aca\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/ownThreadPicker.js\":\"f796c3f5403ebe07\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/placement.js\":\"cece84c389a71bc2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/queries.js\":\"287d8c03fbdf5af1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/quotePosition.js\":\"3473ab3194b05956\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/quotedIn.js\":\"6606881bab8b437f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/quotedRange.js\":\"a2af2e799f8d0cd1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/rangeRefs.js\":\"0837387832683437\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/readHighlights.js\":\"08923a75649be5fa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/readSelection.js\":\"a9b5ac1818c2bd0f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/readSelectionUi.js\":\"3907a51fb4df9d65\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/reanchor.js\":\"a23db2331daf57cf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/schema.js\":\"bffc10411af78457\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/scope.js\":\"4764ff68ca7eb830\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/scopeThreads.js\":\"fe0b80b8a9f6d08b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/splitRetarget.js\":\"60a381604bea5089\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/suggestionCard.js\":\"f6b9e6656611212a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/suggestions.js\":\"ecc6613e498089de\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/summaries.js\":\"5ad5148b87631d80\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/summaryBatch.js\":\"f408082d5c2b4b72\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/surface.js\":\"ffb4347cdc011bf0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/threadNavigation.js\":\"626dc3b1aaf2c25b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/threads.js\":\"28e971ee163640b5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/ui.js\":\"2f0d393c7d47698b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/uiStore.js\":\"b54f4936dcc881a3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/app-intents/appIntents.js\":\"8d6e1806ca7deb93\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/app-intents/index.js\":\"77f57f1c295de623\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/app-update-prompt/index.js\":\"517755ce21d2c5dd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/app-update-prompt/status.js\":\"ada7dc1ade968cf7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"8e6cbafb8196aee6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/MediaBlockRenderer.js\":\"98dd5ba0ba943c7a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f9d7502bd9f10f00\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/MediaUploadReconciler.js\":\"67a915683dad77d0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/assetDownLane.js\":\"13928c7955187248\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/assetResolver.js\":\"524bd6b1436a5ced\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/assetUpload.js\":\"1985c5332758a634\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/attachmentCleanerIO.js\":\"7e90c5acb92246a9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c339ced067c9ebff\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/blobStore.js\":\"ecc0a59229ee972b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/byteStore.js\":\"bddc05e3432624cd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/cleanerIO.js\":\"87a17c80048d7955\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/cleanupAttachments.js\":\"2f556e9646f41796\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/dataExtension.js\":\"2c2ab59e2527fdb2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/downLane.js\":\"6bbc620c47d49206\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/index.js\":\"b1808dcd2df68320\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/insertImageContribution.js\":\"24ee77f6827eb9c6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/laneArming.js\":\"b4de46765ee531a8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/laneLock.js\":\"ca5b70c0aa984c1f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/mediaBlock.js\":\"41e8c3b87b9eecc5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/mediaCapture.js\":\"720987128d262240\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/mediaViewers.js\":\"54aa9ac17cc4affe\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/mediaViewersFacet.js\":\"1cf50d9af2ca10ac\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/pasteCapture.js\":\"51d1ec7302485d44\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/resolver.js\":\"69ed8d6f1ebcc6ad\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/retryUploadsAction.js\":\"c26fe01b110bd7f0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/storagePaths.js\":\"d2b3714dfb890d73\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadDrain.js\":\"adb64d725faf75ab\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadLaneStatus.js\":\"3c6c6451886d2cae\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadReconcile.js\":\"ef647d75ae3236ef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadRecovery.js\":\"9c1cab48d99c15ca\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadStore.js\":\"d1ae8635fed76883\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/useAssetObjectUrl.js\":\"ed846c84e6bd84d4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6beb4e2276c3f6e4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/BacklinksViewSection.js\":\"20b3f44c4670106b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/facet.js\":\"6447bd20b5d2ed37\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/index.js\":\"a8a35ebb7ef181c7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/prop.js\":\"f19b588fabdb95a8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/BacklinkFilters.js\":\"f9083fa722618cc0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f3817f0fd9ac8f52\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/BlockEntry.js\":\"e968a1f8b5c96a42\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/LinkedReferences.js\":\"8d271830b463bcff\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b62fc5e694bc3c90\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/dailyNoteDefaults.js\":\"eb085e1b8c5f6e79\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/dataExtension.js\":\"187e823d7a690691\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/edgeExclusions.js\":\"0f80619a5631f9b5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/filterProperty.js\":\"32bae05ce92d9877\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/index.js\":\"27c305211c527ee5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3126acee200f81be\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/applies.js\":\"7505c4ac68b6c7aa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/countQuery.js\":\"0a8b03bc42ce3a72\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ede7b7172502048f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/index.js\":\"c20459dccde3c6b1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a1a6e433931a4adb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/presentationInvalidation.js\":\"ac9fbe2751f3bb69\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/propertyEditorOverride.js\":\"43726498e39e5371\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/propertyFilter.js\":\"64679248d83c297c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/query.js\":\"b8654878e3da6f3d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/resolveFilter.js\":\"72155fe86974a60d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/sourceBatch.js\":\"77498d4e41d9e5b4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/sources.js\":\"2001b09bf2cdef88\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/useBacklinks.js\":\"fef5101a2f9ab57d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4c6b798474790c10\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/BirthdayCelebration.js\":\"fa9d99cc0dac3275\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/BirthdayOverlay.js\":\"eeb85677b9e18510\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/gate.js\":\"52937c8fa8ce5bf4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/index.js\":\"d983cdbf419f40ee\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/wolfTheme.js\":\"49a215134e8890be\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/BlockDragLayer.js\":\"0c65533691022eb2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/dragController.js\":\"2b72d832f3c6a7f7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/dropTarget.js\":\"d59bf5f2678db5d6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/index.js\":\"f3a2c3edaf7b77e1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/projection.js\":\"c0c270c65cd8df96\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-info/BlockMetaCard.js\":\"b3e720cbec855cef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-info/index.js\":\"d30df5c00a57703a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/AddTagDialog.js\":\"601624b66cdf46ef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c85dd22d577b1912\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/TagNameIssueHint.js\":\"78fe2aa14d607366\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/addTagAction.js\":\"70e4f13aa4214f45\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/appendTag.js\":\"093d074c9a65db2f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/config.js\":\"3ec02b4d52fb34d1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/dataExtension.js\":\"9eab35d3a200b62c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/index.js\":\"2aa654c94b61155e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/propertyEditorOverride.js\":\"92ad5ba936fda5cd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/BreadcrumbList.js\":\"704304e94b550a7c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"be28cc640c529c04\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5e5b61c02bdb2e67\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0de69d13c46a2f20\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2cef647bf8d61251\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/index.js\":\"971998fb46f098e1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"8513dfaa3ccad5a1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/CharacterCountItem.js\":\"b30ae846fba0455b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/ProfilePropertyEditor.js\":\"177e1335514520ca\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/actions.js\":\"8b0e27511d9f2770\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/blockType.js\":\"13815658f4614433\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/charCount.js\":\"5685cd93a7ef8525\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/dataExtension.js\":\"d4953b8bb2136aba\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/index.js\":\"be5ca0029cb37d62\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/profiles.js\":\"c59cd6a011f7148d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/properties.js\":\"3569a75530f7f51b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/textCounts.js\":\"a99e27469cd055e5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/colemak-keybindings/index.js\":\"c9ef6936b143633b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/CommandPalette.js\":\"78cff4ed7119b7a1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/HeaderItem.js\":\"ed98ebeae39905a5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/context.js\":\"8d941a33d7e07b4e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/index.js\":\"de516e7211e5301c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/selection.js\":\"1c67a7f3d82b9f30\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/toggleStore.js\":\"bed31f9474848b08\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/useCommandPaletteActions.js\":\"8a67cbed3c6eaaa3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/ContributorBadges.js\":\"f1fcd60fa3e839c6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/author.js\":\"58b7d5a85f1b1a28\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/codeMirrorExtensions.js\":\"7b8c110b31840764\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/dataExtension.js\":\"dabad135d02a8d8c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/index.js\":\"bb06ab5868d74e6d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/mentionAutocomplete.js\":\"a2872a5beecbe7d0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/processor.js\":\"45b14d789026e4e3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/profiles.js\":\"f5a62217adb7df7c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/queries.js\":\"5e7afe715e5671c4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/schema.js\":\"e4ed90f21c070954\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"99ee1c7e6164ec28\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3bc666454d08fc9f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/index.js\":\"56900c59d39789e9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1a89cd4c370cbe5f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"36f4631ea6480df1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/CalendarGrid.js\":\"7a760594064af8bb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/DailyNotePicker.js\":\"adea8826ef02aa7b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"49af6afc27adefbb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/DateNavDecorator.js\":\"e5655c87e6241cec\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/DateScrubOverlay.js\":\"bb2f96ed5239b9f3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/HeaderItem.js\":\"46c038020c96786d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/ReschedulePicker.js\":\"b0bd88bf88fed9c6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/SpreadDatesDialog.js\":\"894c3f122a153317\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/actions.js\":\"d043ae03440628fb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/blockDateAdapter.js\":\"d1f9127cb4026d76\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/calendar.js\":\"29fae89f3d1e7971\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dailyNotes.js\":\"03c493f586692e6f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dataExtension.js\":\"005a09f84763acb2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dateScrubActions.js\":\"790587777d7c5e3a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dateScrubGesture.js\":\"e806e782e8450084\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dateScrubGestureActions.js\":\"2a31673363c7ddaa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d646fe72f5a48150\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/deletionGuard.js\":\"fbcf883a07f44e04\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dueQuery.js\":\"940fb5d498539690\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/index.js\":\"7d8a9aec6328767c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/landing.js\":\"2b88dfd117e399d7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/localSchema.js\":\"850cad1fc067d7f6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/referenceDateAdapter.js\":\"97724bad8dc7bed5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/rescheduleAction.js\":\"12af02568853f743\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/schema.js\":\"088f381e8151444a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/spreadBlockDates.js\":\"88d3a2d48536bcc4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/spreadDatesAction.js\":\"edc35177180dd297\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/today.js\":\"bd5c8593e3744ed2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3e0f838c1f6b2bb5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d62dae5c5bf2b261\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/audit.js\":\"ae67ecf8aea88480\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/auditAction.js\":\"59dec63acbc5faea\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/auditRanges.js\":\"325379c3978aa435\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/diagnosticsSource.js\":\"e79ad19313f4a4f8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/divergenceScan.js\":\"929b2e627ca67b40\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/index.js\":\"34de81267acb0c1b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d0ce3d3ad59fe613\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/referencesMirror.js\":\"587a10b8dc1210c6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/rowJson.js\":\"7df26a76e8138403\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/schedule.js\":\"4ecb2d329089cc7a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/store.js\":\"ad2f21eeb0cdf84e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-maintenance/action.js\":\"f7b47c551863f336\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-maintenance/index.js\":\"b71bff768c80d8f3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-maintenance/plugin.js\":\"c38f485744b86d6c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c4e7aef3833abe18\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/actions.js\":\"d22694b86eae54d1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/changeMarker.js\":\"0eca929fa559280f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/diagnostics.js\":\"0d1988b3c06c6270\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/fileSystemAccess.js\":\"ad46c51fcf4bd017\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/filenames.js\":\"1a18c4eca2834a09\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/index.js\":\"ebc6bbbd9a2b2968\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/mirror.js\":\"63d3b3fc096c298b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/runLock.js\":\"020cd5423717f0a0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/runtimeHealth.js\":\"1474b6adf666ac44\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/schedule.js\":\"5cd3715fe6b375d7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/store.js\":\"9d4a9c6337efd22d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/default-themes/index.js\":\"22c74e0306f0a6e9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/default-themes/themes.js\":\"97aceeda58785fff\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/diagnostics/facet.js\":\"5275ed06df491a5e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/diagnostics/useDiagnostics.js\":\"dd42c386cf1cc27a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extension-prompts/dismissals.js\":\"7e8423fe96c7f1da\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extension-prompts/index.js\":\"18a776e58e0f489e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extension-prompts/status.js\":\"f51e48e00c9a80d0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extension-prompts/store.js\":\"610e090984addac2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"8d7811fac2960a48\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/ExtensionsSettings.js\":\"cf66e9c6902a22ac\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/actions.js\":\"f95d723cb6d23547\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/config.js\":\"93205190361ab93a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/dataExtension.js\":\"d2156d34c8e63bc1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/effect.js\":\"dab22e0761f64e50\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/index.js\":\"ed6ca65fe3e10637\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1a7373353e40132a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/useToggleTree.js\":\"e0f13829016e5e64\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/ExtractTypeDialog.js\":\"87189d029090f2b6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"71c9718370882b26\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/PropertyShapePicker.js\":\"dfc060fe60a35b7b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/action.js\":\"5f84226a08d5b470\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/index.js\":\"ee86475723a38574\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/FindReplaceDialog.js\":\"0bc63313dc1481ca\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/HeaderItem.js\":\"ecd7da5de8bc5602\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/dataExtension.js\":\"efe34353b8f165dd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/index.js\":\"32e47edf46844b2f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/search.js\":\"18b66a8868209dae\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/toggleStore.js\":\"eb616ec822cd28c9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/LocationPropertyEditor.js\":\"4fb51c00b059d6a3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/MapView.js\":\"7cdccc7c3fe3fc04\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/blockTypes.js\":\"7346912a10803417\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/codeMirrorExtensions.js\":\"6749dab2a57cd9b7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/createOrFindPlace.js\":\"f3c761579a105abe\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/currentLocation.js\":\"b299a94c87a1af2f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/dataExtension.js\":\"4561dab666247fb4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/geoContentDecorator.js\":\"a2f5e1e73ee06d75\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/googlePlacesClient.js\":\"e6aeca56d4e00df7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/index.js\":\"37c2b1d710723f7a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/locationsPage.js\":\"87a5b2628ddbac19\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/mapViewport.js\":\"c4a2c1daaf0ea259\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/pickCurrentLocation.js\":\"fb58545c8f2c26d0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/placeAutocomplete.js\":\"53969c05f3f1869a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/placeNameCollision.js\":\"f21627e87cffd8be\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/properties.js\":\"3a84afca158d46b7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/propertyEditorOverrides.js\":\"a8c534461b8e393a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/query.js\":\"bf2c84ecd92228da\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/usePlaceSearch.js\":\"33d15f0a222017cb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d8d43f1c3bcee49c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"43eed1884a120ef9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"73764e682c955b0d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/config.js\":\"5dea853f2a4e27ee\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/dataExtension.js\":\"b345a0c6658a1995\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/facet.js\":\"2880a9e95ecf6a38\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/grouping.js\":\"bc8a51562e9693f7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/index.js\":\"76ec0f508f57df9f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"aaa67de11cfa8fc4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/query.js\":\"39abccfddbc60046\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/resolveConfig.js\":\"69a9570cabbe4a83\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0db5e491cb07563c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6de132a60bdc4b2e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/HtmlDocumentContent.js\":\"f330da4a46b6edaa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/HtmlFrame.js\":\"55facb407e76f487\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/actions.js\":\"eb1df67ff07c30eb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/blockType.js\":\"55c4a0f1c45933d2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/confirmRunScripts.js\":\"890aaa626cec0f67\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/dataExtension.js\":\"cce234313e3ad142\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/frameAnnotations.js\":\"71e535fcb305ec1d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/frameDocument.js\":\"8c22d2a1bcae7ef4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/frameTheme.js\":\"680c35c63e5c1249\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/index.js\":\"e43187875ee21e31\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/scriptConsent.js\":\"5d7cff00b1a45ceb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/sourceMap.js\":\"c1bd8dc5728782b0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/useDocumentScripts.js\":\"ac976a1e788d2138\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/index.js\":\"f9dd2961d451a15e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/record.js\":\"f493b851017f0048\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/recordStore.js\":\"ece32371b97553e9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/responsiveness.js\":\"f6d9cb3aa05948e0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/schedule.js\":\"9efab2678acfd13a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/sessionContext.js\":\"b1cca1980cf57fe8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e1f19142f35aa70d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"98d502c59abfa0d9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/actions.js\":\"55dea77ec09966cb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/config.js\":\"6ad1bb979b7bb6e9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/dataExtension.js\":\"92b43ebbe69e7aa6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/effect.js\":\"83614e6b288afdca\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/index.js\":\"7b9540310a2484be\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/keyCapture.js\":\"a2a116a565143c68\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/overrideStore.js\":\"84e0ac9a8a3fe59d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"408b4ece2a738247\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/HeaderItem.js\":\"7e8e3a56ff90670e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/LeftSidebar.js\":\"8dea3159f6c26744\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/actions.js\":\"df7dd754431b88ff\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/facet.js\":\"06221406645e5831\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/index.js\":\"0c6a75013a43589b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/shortcuts.js\":\"35f02c831d994929\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/toggleStore.js\":\"862b6e13258beece\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/merge-blocks/MergePicker.js\":\"bf9d47c7e7c2a2bd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/merge-blocks/index.js\":\"f535fcb6f5375cd7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/merge-blocks/mergeAction.js\":\"f955f70b368dac51\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/merge-blocks/strategy.js\":\"4d340a19dc10da4b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/Button.js\":\"e34952efb02242ff\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0954a5f5530b922f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f177a796cc65137d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/facet.js\":\"88648cf19784871e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/index.js\":\"e7267c2a04ed4a5b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"9f2736f8b6856064\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9568eceea3ca4f76\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"4aef7d42228d89aa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/facet.js\":\"dd04b483888fb76f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/index.js\":\"1254cc95b6f832fe\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f89de6ffe15f1aac\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/blockSubtreeMembership.js\":\"7313ce83d83bc056\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/contextMenuItem.js\":\"a9e946c814935cda\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/index.js\":\"430050ffe72be11e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/moveAction.js\":\"99bbe97a2ddcb7ae\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/moveBlocks.js\":\"da3cb34f63125175\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/selectionAfterMove.js\":\"5a05b9a5f00a2ff3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/TutorialBanner.js\":\"870a57d2fc2e85a7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/action.js\":\"6910c8c2c8ca22ff\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/bannerDismissal.js\":\"aa015dc74427fbc6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/documents/cheatSheet.js\":\"122b030d31b9d305\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/index.js\":\"432d6ef8396edb53\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/keys.js\":\"83d1585b7f612988\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/landing.js\":\"f70bc62af0cbffb3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/outline.js\":\"43438ed7caeeecb3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/seed.js\":\"9d390cd857a31d00\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/PerfTrendDialog.js\":\"474abeea146fb7df\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/analyze.js\":\"0ff9380027c7315e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/diagnosticsSource.js\":\"cf5cc2d88d346700\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/index.js\":\"80bda98eada50172\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/load.js\":\"09f1a321ed93dbd0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/monitorRun.js\":\"57dd035afbe1e3dd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/schedule.js\":\"9bdd1d3481514e18\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/series.js\":\"514166454021d03f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/store.js\":\"a0b41d2a8065198d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/trendAction.js\":\"d8e60d94a2779887\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/verdict.js\":\"4debc979c6fc7f29\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/plain-outliner/clickToEditAction.js\":\"5b44783521cef0f9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/plain-outliner/index.js\":\"00653d05034e47bc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/plain-outliner/interactions.js\":\"27f9aba452620592\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"e9f953d3e366f4d3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/MigrationGate.js\":\"0cb3fa4ff4257452\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/MigrationGateDialog.js\":\"8bcf7001d72666c5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/action.js\":\"de325c3d8006b380\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/index.js\":\"507a8b419bc4bc53\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/localRunMessage.js\":\"faffa6e01aa8e564\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/plugin.js\":\"82e519a20b93ade4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/progressReport.js\":\"7f273fab8ba637a8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/sweepProgress.js\":\"e2f9efeae614babb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/FieldRowRenderer.js\":\"51a42ce98af7d278\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/ValueRowRenderer.js\":\"bb0452837401962b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/actions.js\":\"4e93f4232b798a0a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/autocomplete.js\":\"296cb53e4e5c4421\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/fieldRow.js\":\"7268a70a6c506eed\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/index.js\":\"8a55f7a444296cd3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/referenceWarning.js\":\"0c6e759b484195f9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/valueAutocomplete.js\":\"361733dd8be82397\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/valueSchema.js\":\"94775a08c0e89fcf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/HeaderItem.js\":\"396ad6d7ed3c3e8f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/QuickFind.js\":\"11fe935129d406ea\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/index.js\":\"81f16b6ece95eca5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/recents.js\":\"ea680836eaf0a10e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/resultItems.js\":\"dc13c18ce206ff07\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/selection.js\":\"0d4fbefaa706251c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/toggleStore.js\":\"b7ac332b8d26bd71\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/HeaderItem.js\":\"6b87b613cb60270a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5edbdfa0ac192e96\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/grouping.js\":\"b8c95223592bdb12\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/index.js\":\"eea597b2ede074d3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/target.js\":\"6de67462633f92f2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/codeMirrorExtensions.js\":\"ea6920ad7ca89207\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/contentPrefill.js\":\"28fe9536bda173bb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/dataExtension.js\":\"1fc0666809a27168\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/index.js\":\"920409a13eeafc22\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"58f35be03323a093\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/invalidation.js\":\"2130a5fbae92c62b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/localSchema.js\":\"df38158c15e1c881\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/blockrefs/index.js\":\"4072f0952bfc7eb0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"09d139c631fa3656\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/index.js\":\"90ec83ce0d2740a1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/referenceNode.js\":\"ade2e3f2465af8c3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cf26e5a03b90a8cd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a43c67c58afecfd6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/wikilinks/index.js\":\"37396ae957593497\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"26f6ea8e2fef1624\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"f6eb75b9140b40bf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/mergeRetargetProcessor.js\":\"2c5decfeba3f1e7c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/parseFence.js\":\"41bf9fdc17a0fce9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/referenceParser.js\":\"ed361484deacc240\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/referenceProjection.js\":\"cd4080b35788ceef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/referencesProcessor.js\":\"f8077761eca5cfbf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/renameProcessor.js\":\"376beddd95ca55df\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/spanReplacement.js\":\"84d2085506e8e4a2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/rich-paste/htmlToOutline.js\":\"492c74e3a5178c4c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/rich-paste/index.js\":\"76892af83e598955\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/rich-paste/normalizeClipboardDom.js\":\"aee690d2950ba47b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/rich-paste/pasteDecision.js\":\"7c66ff35d514df8f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/action.js\":\"89ac68adfba4fdcd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/blockIds.js\":\"07521305ec96e01e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/content.js\":\"19bb11a781777b3b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/effect.js\":\"bbe1a61427bcc3ab\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/ids.js\":\"c081984ae47c5976\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/import.js\":\"dab43636347bdf3a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/index.js\":\"b567635723d400b3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/plan.js\":\"ffdd91a242ba1073\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/plugin.js\":\"4345831147674a25\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/promotion.js\":\"189aa899eb302b81\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/properties.js\":\"084c4fa030ac0bbf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/references.js\":\"349296b76450617f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/report.js\":\"5f99d531cd155ebe\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/roamMemo.js\":\"71d48fce644774f3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/runtime.js\":\"ec1093cd7c438642\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/schemaReconciliation.js\":\"27e2c41d180470da\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/srsMarkers.js\":\"fd0161ff6694c1c3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/todo.js\":\"deda08ec157032b0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/typeCandidates.js\":\"3b1799f25e32eb10\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/types.js\":\"a5e44b90ce232e3e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/search-health/index.js\":\"2b681737fba08277\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/search-health/store.js\":\"1cac0adb2a3ff89a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/HeaderItem.js\":\"2c9ba88c8df13e85\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"96d44b5cf63e446a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/index.js\":\"0eae6ebe62370c57\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/model.js\":\"e35c9a0669489da0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/toggleStore.js\":\"0a1b1376d6316415\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/useKeyInspector.js\":\"bd3b0d44f5874fd0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e3b0e1e9092070e0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/ShellDecorator.js\":\"05fe4a094912ebbc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/actions.js\":\"89a198192c2ebfe5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/exclusionsFacet.js\":\"098c4f465de4ecb7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/index.js\":\"8241399eba86f256\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/shell.js\":\"5967970e68911a14\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/surface.js\":\"29df3ed9a1d1cb05\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/walker.js\":\"0aac84eb24446a7e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/RescheduleToast.js\":\"10732e7946423448\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/dataExtension.js\":\"f5740085ceaa1d39\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/index.js\":\"f0ad541ee6d6c5b7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/indicator.js\":\"0c8cabd119f5c05f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/moveSrsState.js\":\"77b4f7417555c888\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0a5ea173f2de726d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/scheduler.js\":\"5d63565f2afcd2e3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/schema.js\":\"a31c65648a05ab74\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"cd78149a6307c906\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/srsClipboard.js\":\"6baede28c1d19471\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f82239033d75c34c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/DailyNoteReviewHint.js\":\"8805e26002a60922\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/DeckPicker.js\":\"7330127dbc1d24c8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/ReviewControls.js\":\"d2103a77b5e03751\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c945382ec9ddacfc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/ReviewSession.js\":\"d3f7e4a6dd2ce935\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/actions.js\":\"69825a3d29309153\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/archive.js\":\"f8d9e4d09f2149d7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/dataExtension.js\":\"35909fbfd6d9eb11\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/deck.js\":\"5729fd58a0ebc3a0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/dueQuery.js\":\"37c4aeaac52390d5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/gradeDecision.js\":\"6a772220d63277e4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/index.js\":\"c77eec07b39a7def\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/keyHints.js\":\"d213c6e2fff77974\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/reviewCardLayout.js\":\"fb6cd7cd43d7d89b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/reviewProgress.js\":\"7fb108303bd64679\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/schema.js\":\"c843037c1a15a982\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/useDueCards.js\":\"53f1baccb4debf0a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/startup-metrics/index.js\":\"a8cc22b85c5b0873\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/startup-metrics/record.js\":\"62e86adf07643a8e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/storage-persistence/index.js\":\"ba396331518e354d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/storage-persistence/persistenceStatus.js\":\"3ccc26b9939770bc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/storage-persistence/requestAction.js\":\"c67b2b1be209f3c7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/supertags/TypeChipsDecorator.js\":\"f6b271e40aabd508\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/supertags/codeMirrorExtensions.js\":\"d136d774b948a275\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/supertags/index.js\":\"34c85b3c220eb192\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/supertags/typeAutocomplete.js\":\"57db2dfa70929ff5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"168be5b94880098f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/actions.js\":\"b8a04d61f5d67e37\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/anchor.js\":\"728969c6ae0ea241\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/events.js\":\"1bc7ab27b2cf5061\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/gestureActions.js\":\"d991c8bb29912559\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/index.js\":\"4b9a1a0c1586c65e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"fdcf74f90746d4ec\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/sync-metrics/collect.js\":\"2db97edd86ccee2c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/sync-metrics/index.js\":\"d78e939c0e2c5d00\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/sync-metrics/record.js\":\"ae334451a43426de\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/RejectionDialog.js\":\"07260c3521e08a40\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6a1598acd7b93db8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/index.js\":\"88d2bd3b26fb4d68\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/model.js\":\"448703d42dc25e1d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/queueCounts.js\":\"145dee38d53c41b0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/rejectedHelpers.js\":\"3008da7bdb15ca30\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/rematerializeAction.js\":\"b1ff3ddd54de7490\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/useHysteresis.js\":\"914d1ec38dcb431e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/theme-toggle/effect.js\":\"98cb4ad42af5294a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/theme-toggle/index.js\":\"d358876825ab7fa7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/theme-toggle/theme.js\":\"6583c20174d09864\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/todo/actions.js\":\"d5cb0d4e88a31316\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/todo/dataExtension.js\":\"5fa0c5f4bd9c42c2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/todo/index.js\":\"8d03b7101ea779b8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/todo/schema.js\":\"b193ab7f30f15a8a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/TouchSelectionLayer.js\":\"511322331d50daf9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/actions.js\":\"df97b8fb99d89854\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/defaultItems.js\":\"fe95527ed2ea8349\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/facet.js\":\"d4880ef058215404\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/holdRecognizer.js\":\"ac1bec8a58901737\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/index.js\":\"37577d5dbcded5d1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/update-indicator/UpdateIndicator.js\":\"0118f5ae0f3bff4d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/update-indicator/index.js\":\"394db889960ad61b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/update-indicator/loadTimes.js\":\"1b148ab8ee648c73\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/VideoNotesRenderer.js\":\"c73f029a8ce72cde\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/VideoPlayerRenderer.js\":\"274af7e0a388dda8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/VideoTimeStamp.js\":\"d7f10eae03096e72\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/actions.js\":\"e89945ff5ebd8379\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/index.js\":\"48beea8dfa9453cf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/markdown.js\":\"3f59aaacd13db778\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/notes.js\":\"d38020b2139f6d2c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/registry.js\":\"58cde12d503ed6a5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/remark-timestamps.js\":\"fea9e1f346d5be6b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/view.js\":\"21832222e033891c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-link-hints/LinkHints.js\":\"84ec631f18972e55\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-link-hints/index.js\":\"5b87b9a7f7886670\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-link-hints/model.js\":\"6d926c73a88f4d96\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-link-hints/settings.js\":\"aa6813c11e52842c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-normal-mode/actions.js\":\"3b7a27da26f81682\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-normal-mode/index.js\":\"917dea06b9402618\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-normal-mode/interactions.js\":\"95388f39aeecefdd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/workspace-header/index.js\":\"0a8f691b0a313a6b\",\"/knowledge-medium/pr-preview/pr-1801/src/registerServiceWorker.js\":\"5e6a69b24d2cc79d\",\"/knowledge-medium/pr-preview/pr-1801/src/requestPersistentStorage.js\":\"78da423670baeb07\",\"/knowledge-medium/pr-preview/pr-1801/src/services/authRequestDeadline.js\":\"5ff9e96c2ff3524b\",\"/knowledge-medium/pr-preview/pr-1801/src/services/authStorage.js\":\"1df1941befc4f961\",\"/knowledge-medium/pr-preview/pr-1801/src/services/powersync.js\":\"26a3e4c48ad73617\",\"/knowledge-medium/pr-preview/pr-1801/src/services/supabase.js\":\"56249cde48a22903\",\"/knowledge-medium/pr-preview/pr-1801/src/services/uploadErrorClassifier.js\":\"950ae02c43001986\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/ActiveContexts.js\":\"010f429a54392c5f\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/HotkeyReconciler.js\":\"f95e9ab986cf5a1f\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/WipeLocalDataDialog.js\":\"fc32a1ab04036c52\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/actionDispatch.js\":\"87454bafd1c9ce69\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/actionRefItems.js\":\"ed8b1959c9d5accd\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/applyKeybindingOverrides.js\":\"327c383bba14e2d4\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/blockActions.js\":\"dd5ab5f32918eefe\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/canonicalizeChord.js\":\"250b6da5c985f00d\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/defaultContexts.js\":\"cade79d7d0b11e92\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/defaultShortcuts.js\":\"284d1af84ba27f26\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/effectiveActions.js\":\"239b13ea7818d1c4\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/gestureAction.js\":\"d610e81c26dd0414\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/gestureBinding.js\":\"2fd801dada2dfd4b\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/holdRegistry.js\":\"81c7833b77fbf792\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/keybindingConflicts.js\":\"3cecce5220ea3cb6\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/keybindingOverrides.js\":\"c35c084a4eb79587\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/pointerAction.js\":\"ed91ac309aae7969\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/resolve.js\":\"3dc4ef4da219fbf6\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/runAction.js\":\"44468511c891c2ae\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/sequenceMatcher.js\":\"3485eef24e491cab\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/types.js\":\"5453aa07461ca264\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/useActionContext.js\":\"19d018c90436d2b5\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/useActionDiscovery.js\":\"8a30b1e68f152c9f\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/utils.js\":\"23ab2efb4117255d\",\"/knowledge-medium/pr-preview/pr-1801/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1801/src/sw/bootStore.js\":\"d5a77e7da7d193ba\",\"/knowledge-medium/pr-preview/pr-1801/src/sw/previewDatabases.js\":\"943aa50acb209770\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/byteTransform.js\":\"4891984adadaca12\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/attachmentCleaner.js\":\"5ec65f47c763ffa9\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/attachmentParts.js\":\"fe80cf6a006575e0\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/bundleParts.js\":\"59f844de3f8f01ed\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/bundleRecord.js\":\"479aa71c17682a2c\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/manifest.js\":\"75dc875f15dc2263\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/takeBundle.js\":\"3aa089ebe7d67902\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/verifyBundle.js\":\"1ad3e8d9b4d2de8c\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/cleaningStage.js\":\"f959e725d8564d5c\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/conversionKey.js\":\"63034feac76a92e9\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/conversionServer.js\":\"8cf1140c93d44515\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/flip.js\":\"8050748957681506\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/flipAttempts.js\":\"c0572d225ea36d66\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/pages.js\":\"941c30561393e538\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/preflight.js\":\"15bc4ba1f50c2535\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/reseal.js\":\"5acd05e54a46eab3\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/runConversion.js\":\"afdf20fdd238b266\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/runLock.js\":\"ac9f82068b4b0258\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/sealing.js\":\"c54da0f2658b5b5c\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/sealingStage.js\":\"f4d7a3af7a10342b\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/stage.js\":\"36e18b754ef3d049\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/verifyReseal.js\":\"283436ad200de8dc\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/aad.js\":\"9ccb1d030b0b4e56\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/aead.js\":\"74bf7fd6b157a446\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/base32.js\":\"dd32e9acc7bf9518\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/base64url.js\":\"f95d732a027684c2\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/binaryEnvelope.js\":\"7b94dd781b81543f\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/byteAead.js\":\"bdfa0e25dbd5895d\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/canary.js\":\"009a2b42d51b1b96\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/contentHash.js\":\"6e6273f3a4ad8c52\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/contentKey.js\":\"06fdc13fefe1ea60\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/derivedIdNamespace.js\":\"00524b5dd8bf0ec8\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/envelope.js\":\"7d81cb3a7a84de7d\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/hex.js\":\"354c32cf2413aa44\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/sha256Hex.js\":\"75a8ce5a08023f45\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/workspaceKey.js\":\"715ad54f303dc7aa\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/conversionState.js\":\"3f68041e521b4ec2\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7f3e734414bfc1e5\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/flows/pastedKey.js\":\"e98c30f8d4c12c0f\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4853b6b5efd1cef5\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ee509c0eb89c7619\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/keyStore.js\":\"a0344d0847635376\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/mintWorkspaceKey.js\":\"53ff2f4b405b5275\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/modePin.js\":\"a2c4ba93fc334f03\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/openWorkspaceKeys.js\":\"610082e35ba94b6e\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/resolveWorkspaceEntry.js\":\"5cb90b6ee5273b29\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/resolver.js\":\"f8a087cb67ecfa66\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/workspaceAccess.js\":\"ac9a65827abe313f\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/transform.js\":\"245ef9b2f968f5c1\",\"/knowledge-medium/pr-preview/pr-1801/src/themeBootDefaults.js\":\"0f83accc16e45f47\",\"/knowledge-medium/pr-preview/pr-1801/src/types.js\":\"4263b73c7a90f783\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/ClientLocalSettings.js\":\"14d4218f814c5c0e\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/abortableSleep.js\":\"51bc47bbd4f1c4c7\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/array.js\":\"ca10226eec234355\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/backlinkAutocomplete.js\":\"9e914fb68063c556\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/blockCrumbs.js\":\"e0875958034efcfd\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/blockrefAutocomplete.js\":\"44260838367a99d0\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/cadencedIdleJob.js\":\"3ffe439b5cdd7798\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/callbackSet.js\":\"8f2f24f488bdf03e\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/clientId.js\":\"6793146b1c735d17\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/codemirror.js\":\"d6a7c19c4e3305a5\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/codemirrorCompletion.js\":\"41e3591e6b0c6d60\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/copy.js\":\"f982cb2196b34f46\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dailyPage.js\":\"08a1e7cce77d4275\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dbForensics.js\":\"552d7db0887e3eaa\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dbForensicsHooks.js\":\"84fd36b5606f2657\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/deleteBlockThroughUi.js\":\"6888693bc430b78e\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dialogs.js\":\"f43754a43074a27e\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dom.js\":\"81caf235c22a1520\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/downloadBlob.js\":\"e32e84835c671c6d\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/exportSqliteDb.js\":\"8c112a503f5cc6d0\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/fileSystemAccess.js\":\"d04c46c708e8a7f1\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/flipSlide.js\":\"1234baf6855b6253\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/fnv1a.js\":\"8a9cdb5f152b93a3\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/formatBytes.js\":\"213b44143ff307e6\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/fuzzyRank.js\":\"200abd89e31fccfc\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/idbKeyedStore.js\":\"04b22813ee80063d\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/idleCallbackPolyfill.js\":\"eef65845e0f7a7e8\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/keyboardAwareScroll.js\":\"84c4f93803073be0\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/keyboardViewport.js\":\"f54cc67b8dcfb7ed\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/lastWorkspace.js\":\"758e713e2c413e9b\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/layoutColumns.js\":\"6708004c1251dce4\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/layoutSessionDom.js\":\"79b1e20471fd0a2e\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/layoutSessionId.js\":\"b9e63121bb033b70\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/linkClickGestures.js\":\"cecdd8caeed188ab\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/linkTargetAutocomplete.js\":\"ff78c87d2f1a4eb5\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/localDbCorruption.js\":\"a0e4f33a02933982\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/localDbRecovery.js\":\"52a7e83369d7b389\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/markdownParser.js\":\"81d7c9baf371c38a\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/memoize.js\":\"a10041c32c93f591\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/nameFieldCommit.js\":\"30d6795d32801bf4\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/nameList.js\":\"839118dd0c9a1e89\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/navigation.js\":\"34b80018d5f2cf5d\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/omnilinerNamespace.js\":\"d924c0ab9e11fb59\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/opfsPageScan.js\":\"c89b74660f801f88\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelClearance.js\":\"a16f8c496db39b1c\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelHistory.js\":\"42927f085037ac60\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelLanes.js\":\"86a05d5aed57dcc9\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelLayoutProjection.js\":\"c179894b7a7ca117\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelScrollAnchor.js\":\"71117f3ae0cc2969\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelUrlFlags.js\":\"0c3c508854a1cd07\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/platform.js\":\"fd863a342554ab6a\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/pluralize.js\":\"8899446d98ea7e39\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/propertyCreation.js\":\"186a2ba4e4f50c36\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/propertyNavigation.js\":\"2b70b07fadcab23f\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/propertyValueContext.js\":\"d9fce43a53439601\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/react.js\":\"67966276c05930eb\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/relativeDate.js\":\"fe1c603df766df04\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/relativeTime.js\":\"39b197502d76b8d3\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/renderScope.js\":\"6512e6a7e0a454d8\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/resolvedThenable.js\":\"d694c19893f1c6ec\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/routing.js\":\"91f4236a3b527fe8\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/safeMode.js\":\"6a191d4091c7e3e3\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/scheduleIdle.js\":\"41476a45da3b6155\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/screenWakeLock.js\":\"620cf7a72fffe3e3\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/selection.js\":\"a218954a5376a9c9\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/softKeyboardGrab.js\":\"5c8551b84916517b\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/startupTimeline.js\":\"c1649af0da6c5538\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/state.js\":\"49aa7e520486c4de\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/string.js\":\"797760f23752c377\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/surfaceZoom.js\":\"4fb3ec48ecdf6606\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/time.js\":\"1aef2c9700fd575a\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/toast.js\":\"3b5417c1d16ce1f1\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/toggleStore.js\":\"f9eb32dbeab89bc2\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/untilStopped.js\":\"280541055f7e1481\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/userActivity.js\":\"d780e5607d550fa9\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/viewTransition.js\":\"4604e523828fe2ff\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/viewport.js\":\"91c49a2bd2faa34b\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/webLock.js\":\"68035c2425a494a9\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/workspaceRecovery.js\":\"5ea2bc77e0ff0d91\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/workspaceSnapshotStore.js\":\"437cd7f671f037e9\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-compiler-runtime.js\":\"7e19b09e14a011f1\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-client.js\":\"8f0b6b7332f39121\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-server-edge.js\":\"58a8950856db25f3\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-server.js\":\"f74bbdde34a9d829\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-static-edge.js\":\"7dcc01fc8b9e2bcd\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-static.js\":\"456f9bddb0d47689\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-test-utils.js\":\"30c1471e3fb055a9\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom.js\":\"5ddd4809e4d36318\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-jsx-runtime.js\":\"c85d1922b481f064\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react.js\":\"ebec31ec379962c1\",\"/knowledge-medium/pr-preview/pr-1801/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1801/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1801/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
