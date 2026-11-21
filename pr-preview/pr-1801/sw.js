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
		buildId: "a78a60d28eba-04729732",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1801/\":\"612cbb7b66f868a6\",\"/knowledge-medium/pr-preview/pr-1801/index.html\":\"612cbb7b66f868a6\",\"/knowledge-medium/pr-preview/pr-1801/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1801/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1801/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1801/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1801/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1801/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1801/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1801/assets/FacadeVFS-iMnHFbOb.js\":\"850a0c319adefc92\",\"/knowledge-medium/pr-preview/pr-1801/assets/OPFSCoopSyncVFS-COOEbX4w.js\":\"d988ec60d5179808\",\"/knowledge-medium/pr-preview/pr-1801/assets/OPFSWriteAheadVFS-CvU06Lmm.js\":\"41b113f9be27a4f7\",\"/knowledge-medium/pr-preview/pr-1801/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1801/assets/wa-sqlite-Cg2DqiVc.js\":\"84cd495aa53b2c51\",\"/knowledge-medium/pr-preview/pr-1801/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1801/assets/wa-sqlite-async-B94Iew2u.js\":\"34babb918cf387d5\",\"/knowledge-medium/pr-preview/pr-1801/assets/worker--TMiamu8.js\":\"58b7c268e3816ed0\",\"/knowledge-medium/pr-preview/pr-1801/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1801/chunks/app-B0EseEM3.js\":\"f7e2d6b733125f18\",\"/knowledge-medium/pr-preview/pr-1801/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1801/index.js\":\"ca633dd88ae27429\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1801/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1801/assets/AccessHandlePoolVFS-D30Z9g0F.js\":\"631d5cc021b5d241\",\"/knowledge-medium/pr-preview/pr-1801/assets/IDBBatchAtomicVFS-T7FsqZWj.js\":\"a26ac1fcc3db0ebe\",\"/knowledge-medium/pr-preview/pr-1801/assets/MemoryVFS-Cd2sukfz.js\":\"5b1226fa9c292363\",\"/knowledge-medium/pr-preview/pr-1801/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1801/assets/mc-wa-sqlite-DOJcXwqm.js\":\"d84c030e693d087d\",\"/knowledge-medium/pr-preview/pr-1801/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1801/assets/mc-wa-sqlite-async-z3QRvHLP.js\":\"77793730756ebdf2\",\"/knowledge-medium/pr-preview/pr-1801/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1801/chunks/AccessHandlePoolVFS-Drr5RC3Z.js\":\"cc5791496a3df35f\",\"/knowledge-medium/pr-preview/pr-1801/chunks/FacadeVFS-B5ntu9VS.js\":\"0b998a07b0bbd0e8\",\"/knowledge-medium/pr-preview/pr-1801/chunks/IDBBatchAtomicVFS-CrzvScxp.js\":\"f91fb5374574d1d6\",\"/knowledge-medium/pr-preview/pr-1801/chunks/MemoryVFS-DDfdMfCx.js\":\"6c28c54c08decabe\",\"/knowledge-medium/pr-preview/pr-1801/chunks/OPFSCoopSyncVFS-DNvpGv5w.js\":\"88f2f4eb6cfbdd05\",\"/knowledge-medium/pr-preview/pr-1801/chunks/OPFSWriteAheadVFS-Bmm7EMU5.js\":\"300b8101a4e464c1\",\"/knowledge-medium/pr-preview/pr-1801/chunks/Preview-1HnK0Jcz.js\":\"ea3403191c624e45\",\"/knowledge-medium/pr-preview/pr-1801/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1801/chunks/card-CgjuCgqP.js\":\"50ebcf256a4e4346\",\"/knowledge-medium/pr-preview/pr-1801/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1801/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1801/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1801/chunks/dist-Cyn4-pfM.js\":\"560997f1c426737a\",\"/knowledge-medium/pr-preview/pr-1801/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1801/chunks/mc-wa-sqlite-CYvKn71h.js\":\"33bf08edaa71e640\",\"/knowledge-medium/pr-preview/pr-1801/chunks/mc-wa-sqlite-async-HF2hvG33.js\":\"fd5984e15311d8bb\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-BquLgzp2.js\":\"337b3c1005a09542\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-BvPIlE-x.js\":\"8cfee77abedd6f9d\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-CLZ6x9Y4.js\":\"88c3558b42d84a18\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-COcToNRw.js\":\"84378ed0fe54b029\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-CqgCPWA4.js\":\"55c26a49dc357abf\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-DZP947b5.js\":\"6c4658b5f9b99ad9\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-Dm75qQDG.js\":\"7789d2aff2e85009\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-DuGNt-Qu.js\":\"8e5e4f85eb3cc3c9\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-dom-server-legacy.browser.production-L-A2BY88.js\":\"74f064beb96a0329\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-dom-server.browser.production-Dw2K1ZZf.js\":\"ede590e338914d1b\",\"/knowledge-medium/pr-preview/pr-1801/chunks/react-dom-server.edge.production-CxoUphOS.js\":\"9c7f2aa9a462d2cd\",\"/knowledge-medium/pr-preview/pr-1801/chunks/server.browser-v7-W-OdZ.js\":\"005ceec8ecc4beeb\",\"/knowledge-medium/pr-preview/pr-1801/chunks/textarea-D3N1QUfa.js\":\"d48a1f4fe6bc3394\",\"/knowledge-medium/pr-preview/pr-1801/chunks/ui-Czo7VETQ.js\":\"3942876a6de00d3c\",\"/knowledge-medium/pr-preview/pr-1801/chunks/wa-sqlite-CzTARoWm.js\":\"b56a3fd6526f556e\",\"/knowledge-medium/pr-preview/pr-1801/chunks/wa-sqlite-async-Cq4RHvF1.js\":\"4087f3e0146e3fb4\",\"/knowledge-medium/pr-preview/pr-1801/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1801/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1801/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1801/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1801/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1801/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1801/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1801/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1801/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1801/src/App.js\":\"9831f7c896caa447\",\"/knowledge-medium/pr-preview/pr-1801/src/appUpdate.js\":\"69cb673eb1fdb28e\",\"/knowledge-medium/pr-preview/pr-1801/src/appVersion.js\":\"2624b49c56ddc7d9\",\"/knowledge-medium/pr-preview/pr-1801/src/bootstrap/initialLayout.js\":\"8a108b3305b1c509\",\"/knowledge-medium/pr-preview/pr-1801/src/bootstrap/openWorkspaceData.js\":\"ed2dfa62f3c81f55\",\"/knowledge-medium/pr-preview/pr-1801/src/bootstrap/resolveWorkspace.js\":\"5dbccecf3238d3ad\",\"/knowledge-medium/pr-preview/pr-1801/src/bootstrap/workspaceBootstrap.js\":\"49cb2947e64c4761\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockComponent.js\":\"5f8ce91bcc974c32\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockCrumbs.js\":\"a40cfe9b31b446ae\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockEditor.js\":\"dda324c69fdaf34f\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockLoadingPlaceholder.js\":\"b27dae8e6d9ca1e3\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockProperties.js\":\"9efd431bca138f0a\",\"/knowledge-medium/pr-preview/pr-1801/src/components/BlockSearchPicker.js\":\"9da04f4914a420c1\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ConfirmBulkDeleteDialog.js\":\"e96184dd0e1246ea\",\"/knowledge-medium/pr-preview/pr-1801/src/components/DividerHandle.js\":\"6e94b030783411ac\",\"/knowledge-medium/pr-preview/pr-1801/src/components/DraftEditor.js\":\"b5b62261f69dc404\",\"/knowledge-medium/pr-preview/pr-1801/src/components/GutterPill.js\":\"070fd347bffb47db\",\"/knowledge-medium/pr-preview/pr-1801/src/components/Header.js\":\"d9c3105ad656d057\",\"/knowledge-medium/pr-preview/pr-1801/src/components/LazyBlockComponent.js\":\"9d528917d57e96a5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/Login.js\":\"083aab605beb851b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ZoomableSurface.js\":\"5149a51d3da83645\",\"/knowledge-medium/pr-preview/pr-1801/src/components/editModeKeepalive.js\":\"394560d676d6d820\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyDisplay/PropertyDisplayScope.js\":\"227a9bcfa27120c0\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5ee7f7ce4d7ddf34\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/RefPropertyEditor.js\":\"85a7d602763f55b6\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/RefTargetTypePicker.js\":\"39cc7ea80c6e3322\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/SelectPropertyEditor.js\":\"8dc32d89eb2ba15b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/TypesPropertyEditor.js\":\"f1648476b29bc152\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/defaults.js\":\"c24c17c2796bcdd4\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/kernelValuePresets.js\":\"7831dad31a18592b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/selectablePresets.js\":\"d763998b5fd86f64\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyEditors/typesPropertyUi.js\":\"5eed9e6ed048e71b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/AddPropertyForm.js\":\"51c609d6688145bb\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/PropertyPicker.js\":\"ffbb8c4f687a7605\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/PropertyRow.js\":\"af79ff293471e588\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/Rows.js\":\"da1dd2acf91a1db5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/actions.js\":\"7b567c9b3980874b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/declarationOnly.js\":\"098e6614265407fd\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/layout.js\":\"4ba00100d214a538\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/model.js\":\"ee6fea820d7f8c17\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/shapeUi.js\":\"14020cf65a52c64c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/shapes.js\":\"880092f45ff7949e\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b9752b22f1b21179\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanel/visibility.js\":\"419e57abb45f6dfa\",\"/knowledge-medium/pr-preview/pr-1801/src/components/propertyPanelSections.js\":\"81abda729d4df7d9\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/BlockEmbed.js\":\"a7a86587bab89a48\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/BlockLink.js\":\"eda14c89cfb89253\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/BlockRef.js\":\"2222157987102d65\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/ReferenceLink.js\":\"9a1f4ed348f4a9d6\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/cycleGuard.js\":\"c6f93150d5f7e1a7\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/cycleGuardContext.js\":\"7c3af800b49ef202\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/linkInteraction.js\":\"98edee4f088b5ebf\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/referenceLayout.js\":\"04a9036ec32483b7\",\"/knowledge-medium/pr-preview/pr-1801/src/components/references/useBlockRefAncestors.js\":\"17f5fedb1ad3668e\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/BlockGutter.js\":\"7d6d5484117e29f7\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/BlockInfoDialog.js\":\"6475657a6d1725d7\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/BlockTypeBlockRenderer.js\":\"de04c1934ada4596\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/BulletHoverCard.js\":\"7837569215f0d700\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/CodeMirrorContentRenderer.js\":\"611301e69e60dc9d\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"65390a0472baa40d\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/ColumnResizeHandles.js\":\"b5681ece2efc8d12\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"92eb188ee80edf07\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/DefaultBlockRenderer.js\":\"68271ccda57d44c8\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/LayoutRenderer.js\":\"d2264610de782b68\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/MarkdownContentRenderer.js\":\"b550d93c05c38c06\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/MissingDataRenderer.js\":\"83ab2b5aff7c1bc8\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/PanelRenderer.js\":\"87c3c645632e6ff0\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/PropertySchemaBlockRenderer.js\":\"9051a13f354b7b11\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/TopLevelRenderer.js\":\"c7e22bfa4dacccbc\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/blockGutterMode.js\":\"763880724317c730\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/blockTitleText.js\":\"e78f90ec39624ca9\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/fieldCreationKeydown.js\":\"e0fd221de0a4da32\",\"/knowledge-medium/pr-preview/pr-1801/src/components/renderer/layoutRootContext.js\":\"55c006285e7b3318\",\"/knowledge-medium/pr-preview/pr-1801/src/components/typeChip/TypeChip.js\":\"04d02a0496331702\",\"/knowledge-medium/pr-preview/pr-1801/src/components/typeChip/chipStyle.js\":\"e69343b37623cd2a\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/anchored-floating.js\":\"e295a4567e192227\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/button.js\":\"329bcbfaeeafe035\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/card.js\":\"843d5b4a98d129e3\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/checkbox.js\":\"4e34c8602f70c15f\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/collapsible.js\":\"3dc93ca6416b583f\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/command.js\":\"c671cbb00aabb86d\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/context-menu.js\":\"9b59c7aa0c15cd52\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/dialog.js\":\"a7ca2ac17aaf9e95\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/dropdown-menu.js\":\"970ea9a2b71540ec\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/floating-listbox.js\":\"331721bd23e719aa\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/index.js\":\"6b25a3eb947add9a\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/input.js\":\"f598119eca23fdbe\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/kbd.js\":\"c080a64a6c0d2422\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/label.js\":\"1416c7c5ce46276c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/ui/textarea.js\":\"5fd0b43f1d2cee4b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/useEditModeYieldKeepalive.js\":\"1ee64967e056505c\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/BootFallback.js\":\"f610826a298b43b2\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/FocusedRowLazyMount.js\":\"3ff31ab0cc93ed23\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/LazyViewportMount.js\":\"5aa2b3a616e1c557\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/LocalDbCorruptionFallback.js\":\"740c721171a93b48\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/error.js\":\"c12f635ed63bb230\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/lazyMountRegistry.js\":\"b560167dcc5c1164\",\"/knowledge-medium/pr-preview/pr-1801/src/components/util/suspense.js\":\"2600f038d227f4aa\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/CreateWorkspaceDialog.js\":\"1d8d84077ebe59e5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/PendingInvitations.js\":\"aa30a60aed089010\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/SyncProgress.js\":\"e7fe79d4a2f59d4b\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/UnlockProgress.js\":\"93c27dfa4ee1535a\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/WorkspaceKeyGate.js\":\"cc647382facc1a07\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/WorkspaceSettingsDialog.js\":\"a978364001319f31\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/WorkspaceSwitcher.js\":\"bdf2ecbfb3514081\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/WorkspaceSyncGate.js\":\"5fc718caf151f887\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/ConversionFlow.js\":\"1aa689010048e58e\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/ConversionFlowHost.js\":\"d46fd73385c85015\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/EncryptionSection.js\":\"f9134fa9897996fc\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/attachmentPrompts.js\":\"1aab8f1b5196a6f5\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8f1265d8bd8af95d\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/conversionFlowDeps.js\":\"3f69941274f37b08\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/conversionFlowStore.js\":\"8c83e7706f083489\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/flowUi.js\":\"8638de17f41dd136\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/conversion/useConversionRun.js\":\"47b71b662fa33291\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/keyUi.js\":\"27fc2eb3934697f7\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/useCloseOnKeyLoss.js\":\"554b8822b7ff9ff3\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/useCloseOnServerE2ee.js\":\"e0dcdd6a847f4942\",\"/knowledge-medium/pr-preview/pr-1801/src/components/workspace/workspaceUnlocked.js\":\"20c24cf5a9101cfb\",\"/knowledge-medium/pr-preview/pr-1801/src/context/backgroundSubtree.js\":\"cb79a030f9c52eb1\",\"/knowledge-medium/pr-preview/pr-1801/src/context/block.js\":\"f27a1a5e8dc7e0df\",\"/knowledge-medium/pr-preview/pr-1801/src/context/layoutWsContext.js\":\"22b5956ee79f60ce\",\"/knowledge-medium/pr-preview/pr-1801/src/context/propertyDisplay.js\":\"3c2f58f9acd3ae96\",\"/knowledge-medium/pr-preview/pr-1801/src/context/repo.js\":\"3c4abe39d2901162\",\"/knowledge-medium/pr-preview/pr-1801/src/data/aliasClaim.js\":\"d74adce0fcb35bb1\",\"/knowledge-medium/pr-preview/pr-1801/src/data/aliasSeatNamespace.js\":\"1fdbfea61500e8aa\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/blockData.js\":\"87b274f0b3584501\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/blockType.js\":\"e32033e1bdd1a8ed\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/changeScope.js\":\"53e982414851ce6a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/codecs.js\":\"4212c49a291b0fd3\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/derivedData.js\":\"141fb3c7ffd4f1b6\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/errors.js\":\"ef62e4db1f999d4b\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/events.js\":\"c3e7f705f3037f74\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/handle.js\":\"6b6a7b87c69cf766\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/index.js\":\"a7d88a7efa726de6\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/mutator.js\":\"854f2d2826c95540\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/processor.js\":\"2ba269d119a0d67e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/propertySchema.js\":\"51abf8a19062ec8e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/query.js\":\"6c3c59a0efdd3e68\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/sameTxProcessor.js\":\"7a979d86b5e0f7e3\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/schema.js\":\"6b6a7b87c69cf766\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/tx.js\":\"6b6a7b87c69cf766\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/typedBlockQuery.js\":\"34f7a260bb64ed25\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/user.js\":\"1f86551b4d270341\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/valuePresetCore.js\":\"7e85359f64996e7c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/api/valuePresets.js\":\"ae1208dbf942b854\",\"/knowledge-medium/pr-preview/pr-1801/src/data/attachmentCleanerIOVerb.js\":\"a697ced5d2e26995\",\"/knowledge-medium/pr-preview/pr-1801/src/data/block.js\":\"7d822135b49f245c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockCache.js\":\"021b7250d0b5b7c4\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockId.js\":\"680e7242c4262e11\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockLiveness.js\":\"3c614250db663729\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockMerge.js\":\"81d0a1ae1b246a90\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockSchema.js\":\"55077099c89700ec\",\"/knowledge-medium/pr-preview/pr-1801/src/data/blockTypes.js\":\"fd2a95090f1fe298\",\"/knowledge-medium/pr-preview/pr-1801/src/data/clientContext.js\":\"64597226c1e8d0cb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/dbFileSiblings.js\":\"1a6cc745d85cb7c0\",\"/knowledge-medium/pr-preview/pr-1801/src/data/definitionSeeds.js\":\"fa7c7234e62ed112\",\"/knowledge-medium/pr-preview/pr-1801/src/data/derivedIds.js\":\"55e679cda5928b2a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/drawnSubtree.js\":\"6b8e92a1245b6705\",\"/knowledge-medium/pr-preview/pr-1801/src/data/facetBridge.js\":\"0af04c5a700d16e5\",\"/knowledge-medium/pr-preview/pr-1801/src/data/facets.js\":\"b9bec79bdeef1dce\",\"/knowledge-medium/pr-preview/pr-1801/src/data/globalState.js\":\"a73038af03d84870\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/aliasClaimRederiveProcessor.js\":\"de2b3c7b1685adec\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/ancestorBatch.js\":\"57850d9c3dae06d4\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/blockTypeTypeifyProcessor.js\":\"d749e6067e056768\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/clientSchema.js\":\"18402c91200ee6c9\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/commitPipeline.js\":\"2e80b1a507407feb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/devAssertions.js\":\"3cf7ae98278d4b93\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/firstSync.js\":\"83d3c68ce27207f9\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/freshInitialLoad.js\":\"4cd38f8e98bd061f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/graphBackfillClaim.js\":\"4c66591d5c57528a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/handleStore.js\":\"c87864678555865c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/idleMarkerJobs.js\":\"c19b4536be1bd7e8\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/initialDownload.js\":\"ff2f5e44dfbcfedb\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/initializeClientDatabase.js\":\"c83a2cff1fe3817a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/jsonCanonical.js\":\"25ffb3a106a9df02\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/kernelInvalidation.js\":\"b7223aeda70cfcef\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/kernelProcessors.js\":\"8675989fb876ed0d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/kernelQueries.js\":\"93f78aea560febc7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/mergeTypeMembershipProcessor.js\":\"dcdfd4ed7eded9ea\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/normalizeReferencesProcessor.js\":\"04bdec01460b8a7d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/poolInstrumentation.js\":\"3b47c5c89f70119a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/processorRunner.js\":\"ea651ed2a01cdbcc\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyCellBackfill.js\":\"893d7033416a4ec5\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyChildMint.js\":\"caeb2da3c5ee646d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyChildrenProcessor.js\":\"fe9129af18380274\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f84fc332e04e6f9f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyDefinitionSynthesis.js\":\"61647c6b580c4515\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyKeyScan.js\":\"ea9e9ad4988d556d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertySchemaResolution.js\":\"29126739663d726f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/propertyValueEdits.js\":\"5d54d652c1591e39\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/raiseProtocol.js\":\"cb2cdb7c22c50651\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/readBatch.js\":\"6f94ae67fc2a30d6\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/refProjection.js\":\"e6d2532562c73119\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/referenceTargetLookups.js\":\"add717b2da378243\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/referenceTargetProcessor.js\":\"d751f5366321b523\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/replayMerge.js\":\"1da3f60e29ff4941\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/sqlBinds.js\":\"aa2f00e7cf180106\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"33d394f80f16ca2c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/arrivalProcessors.js\":\"26872cad495b8e9d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/invalidate.js\":\"d44002b170d3ec84\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/materialize.js\":\"2589cec14b7131a9\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/observer.js\":\"5b33e53758b6f516\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/syncObserver/reconcile.js\":\"567edcc91495136a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/timingMetrics.js\":\"51e5ff1816ade505\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/treeQueries.js\":\"63d5197be5be6b9a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/txEngine.js\":\"66149c3c0fc5fbf1\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/txSnapshots.js\":\"15137892061d8a45\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/typedBlockQuery.js\":\"5385cf00afc88868\",\"/knowledge-medium/pr-preview/pr-1801/src/data/internals/undoManager.js\":\"cff9b48b3fed000f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/invalidation.js\":\"c5cb1c5eee73996b\",\"/knowledge-medium/pr-preview/pr-1801/src/data/kernelDataExtension.js\":\"b5ebfe4c80c960ea\",\"/knowledge-medium/pr-preview/pr-1801/src/data/kernelPage.js\":\"14e40782dd91d019\",\"/knowledge-medium/pr-preview/pr-1801/src/data/kernelValuePresetCores.js\":\"babb62afbc69e071\",\"/knowledge-medium/pr-preview/pr-1801/src/data/localDbCorruptionSignal.js\":\"863420906cd05f9e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/localDbStorage.js\":\"c843419f5b4d513e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/localDbVfs.js\":\"d4b8ad6894a01a33\",\"/knowledge-medium/pr-preview/pr-1801/src/data/localSchema.js\":\"346fbcd83ebc2d46\",\"/knowledge-medium/pr-preview/pr-1801/src/data/maintenance.js\":\"a8a67332d6aae227\",\"/knowledge-medium/pr-preview/pr-1801/src/data/mergeProperties.js\":\"acfd80bf9d6c178b\",\"/knowledge-medium/pr-preview/pr-1801/src/data/metricsConsoleHook.js\":\"f5aad9ba7bf525b8\",\"/knowledge-medium/pr-preview/pr-1801/src/data/migrationsPage.js\":\"8834c1f12d7199b5\",\"/knowledge-medium/pr-preview/pr-1801/src/data/mutators.js\":\"e8aeeed10c22f731\",\"/knowledge-medium/pr-preview/pr-1801/src/data/orderKey.js\":\"c599760cadfeb85e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/orderKeyPlacement.js\":\"26faf0b0e188e27e\",\"/knowledge-medium/pr-preview/pr-1801/src/data/outlineSurface.js\":\"881c521598371b65\",\"/knowledge-medium/pr-preview/pr-1801/src/data/pendingEditorContent.js\":\"b275dda8e123aa4c\",\"/knowledge-medium/pr-preview/pr-1801/src/data/pendingUploadsSql.js\":\"21d8f2fa38557dff\",\"/knowledge-medium/pr-preview/pr-1801/src/data/pluginStateExtensions.js\":\"bdc1191d2302d321\",\"/knowledge-medium/pr-preview/pr-1801/src/data/powerSyncLogger.js\":\"dc0f790437e97470\",\"/knowledge-medium/pr-preview/pr-1801/src/data/projectorRuntime.js\":\"c0e43fc230aac37d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/properties.js\":\"f01da87a73b66789\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertiesPage.js\":\"e8c24461d8a67c90\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyChildren.js\":\"2172046a0d47e08f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyDefinitionFanout.js\":\"1dfb31f402fbe842\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyDefinitionMetadata.js\":\"f73a0d4f0365c30a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyDefinitionRegistry.js\":\"e9961c6bf7cb04d9\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyDisplayMode.js\":\"3095bfb5631c2ba7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertyRowCreation.js\":\"8d3d000668fdc66a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertySchemaCreation.js\":\"1a81d7e55dabc24a\",\"/knowledge-medium/pr-preview/pr-1801/src/data/propertySeeds.js\":\"a3e5a724d84e69c6\",\"/knowledge-medium/pr-preview/pr-1801/src/data/recentsPage.js\":\"f759cc1b48fed69d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/referenceBlock.js\":\"7a7d11a510cd1a57\",\"/knowledge-medium/pr-preview/pr-1801/src/data/releasePowerSyncConnection.js\":\"5d75c41e68b7cfa2\",\"/knowledge-medium/pr-preview/pr-1801/src/data/repo.js\":\"6ff261619553f902\",\"/knowledge-medium/pr-preview/pr-1801/src/data/repoProvider.js\":\"57f73e1ff0d54712\",\"/knowledge-medium/pr-preview/pr-1801/src/data/rowProperty.js\":\"3266fd5054f42971\",\"/knowledge-medium/pr-preview/pr-1801/src/data/searchFilter.js\":\"d4fe809a7679d2a1\",\"/knowledge-medium/pr-preview/pr-1801/src/data/seedIdentityLedger.js\":\"a066fbd71b7bed24\",\"/knowledge-medium/pr-preview/pr-1801/src/data/stateBlocks.js\":\"4735bd6e49b07783\",\"/knowledge-medium/pr-preview/pr-1801/src/data/structuralEditPolicy.js\":\"eaa16355e00704f1\",\"/knowledge-medium/pr-preview/pr-1801/src/data/subtreeDelete.js\":\"220f7854efd799aa\",\"/knowledge-medium/pr-preview/pr-1801/src/data/syncStreamLock.js\":\"94d7b48fed4378c0\",\"/knowledge-medium/pr-preview/pr-1801/src/data/syncedTableSqlRecognizer.js\":\"91db33e1cf6a33e4\",\"/knowledge-medium/pr-preview/pr-1801/src/data/syncedTableWriteGuard.js\":\"8c4919e33de824ad\",\"/knowledge-medium/pr-preview/pr-1801/src/data/targets.js\":\"fcd0fa7c3b30ee45\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeColors.js\":\"9a6ee9d8b6671014\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeDefinitionMetadata.js\":\"dea1a26743ecb330\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeDefinitionRegistry.js\":\"1c0ea0a674d8e016\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeExtraction.js\":\"8854048c5eedac69\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeInitialValues.js\":\"648435ecc744475f\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typePropertyGroups.js\":\"77927d9eae5c8b17\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeSeeds.js\":\"76ca30e8e246a11d\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typeTagger.js\":\"07c7dab473636195\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typedRecords.js\":\"6b5ca61af6c998d7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/typesPage.js\":\"133f38611da7d7b7\",\"/knowledge-medium/pr-preview/pr-1801/src/data/userPrefs.js\":\"0fd9cadaf28b35f0\",\"/knowledge-medium/pr-preview/pr-1801/src/data/userSchemasService.js\":\"7b19971224a0b0c9\",\"/knowledge-medium/pr-preview/pr-1801/src/data/userTypesService.js\":\"8e51c70cce151d27\",\"/knowledge-medium/pr-preview/pr-1801/src/data/valuePresetRegistry.js\":\"6d89616760c8204b\",\"/knowledge-medium/pr-preview/pr-1801/src/data/visibleChildren.js\":\"d9aabdbf31043a40\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaceConversion.js\":\"356ad58a0ae3e548\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaceFirstSync.js\":\"72e5fe21d30b1d89\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaceIdNamespace.js\":\"8dfa42983a583b8b\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaceSchema.js\":\"30a33837c3a19507\",\"/knowledge-medium/pr-preview/pr-1801/src/data/workspaces.js\":\"ab151552e4892094\",\"/knowledge-medium/pr-preview/pr-1801/src/data/writeAheadLog.js\":\"c6a3db50eb7fe757\",\"/knowledge-medium/pr-preview/pr-1801/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/BlockPasteShellDecorator.js\":\"e46ea28327a2d9ef\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/atTrigger.js\":\"455c89ec3544858f\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/autocomplete.js\":\"9079e549be240195\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/codeMirrorExtensions.js\":\"d73193db068fed0c\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/contentFlush.js\":\"cf62354ff2309b2e\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/defaultInteractions.js\":\"2219dcb3481d659a\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/editSettleSignal.js\":\"9a641e3510a6cf12\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/insertImage.js\":\"0f153a19096e3a0e\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/referenceCompletionRange.js\":\"bcfa5528916f9738\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/referenceTargetTypes.js\":\"cbcd1cbf56eba33c\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/syntaxContext.js\":\"13fa55c740e1c491\",\"/knowledge-medium/pr-preview/pr-1801/src/editor/triggerMatch.js\":\"7e41aac83ee1e938\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/AppRuntimeProvider.js\":\"9f400f53e8766757\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/BlockFocusShellDecorator.js\":\"8d26cef02387a2d4\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/ExtensionRenderBoundary.js\":\"1f12c6befb0873ca\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/PanelContentRecovery.js\":\"580d65341e4f69c2\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/apiCatalog.js\":\"c430ba4a2866353f\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/approveExtensionHere.js\":\"6329ae24d82b7a69\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/armedCutAppMount.js\":\"673b361aa79efd15\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/batchableKeyedStore.js\":\"c9c8746a232f6ba2\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/blockInteraction.js\":\"c02800abea9171de\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/blockSelectionAction.js\":\"ddd1daca2950d0d4\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/compileExtensionModule.js\":\"e89319426dad032e\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/compiledModuleCache.js\":\"95847d8ca74d3bba\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/continuousGestures.js\":\"1a4a918b02463cde\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/core.js\":\"68dc5ffbaab935c3\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/defaultRenderers.js\":\"9d996da875d84d37\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/definitionFanoutAppMount.js\":\"7a45cae27f691c0e\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/dialogAppMount.js\":\"8098a97b3cf93140\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/dynamicExtensionSeeds.js\":\"12ad68bd31891b55\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/dynamicExtensions.js\":\"de5603cc4a0cdf12\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/exampleExtensions.js\":\"ac88442846be98fd\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionApprovalStatus.js\":\"e07e813234f1f94c\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionLoadErrorToast.js\":\"9f7df738d9b10d08\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionLoadErrors.js\":\"5a3cf8f0dbf2daa6\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionLookup.js\":\"7ee613247e82da21\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionToggles.js\":\"9ceb186b524aaff4\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/extensionUtilitiesCss.js\":\"8d19166a467d157f\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/kernelPageDeletionGuard.js\":\"f514b41182ca1651\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/liveRuntime.js\":\"8a4185c0ff5c98c0\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/openExtensionsSettings.js\":\"f8ed3e089644b104\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/overridesCache.js\":\"aeb60b216e9d2b23\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/pluginIds.js\":\"95240aa69604e1b5\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/processorRejectionToast.js\":\"a01851d1ee58aec3\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/runtimeActions.js\":\"cd2d6c165172339f\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/runtimeContext.js\":\"501941b42b30b0f7\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/staticAppExtensions.js\":\"2a964b1ed2713cdb\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/staticDataExtensions.js\":\"9636d80965f6b555\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/toastAppMount.js\":\"00caa68906fdbac3\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/useOverrides.js\":\"0cd8d86dd3c73655\",\"/knowledge-medium/pr-preview/pr-1801/src/extensions/useShortcutSurfaceActivations.js\":\"9a84f6120482bba6\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/discoverToggleTree.js\":\"8cb20afa86270c45\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/facet.js\":\"86e8fc8aa0940171\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/resolveAppRuntime.js\":\"768370c88bc8a7ca\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/runtimeEvents.js\":\"d017c576b2be413c\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/togglable.js\":\"8204e3588bd62c4c\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/variantFacet.js\":\"b022d4f1790e1fc4\",\"/knowledge-medium/pr-preview/pr-1801/src/facets/verbFacet.js\":\"3e718fbe013f7132\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/block.js\":\"9936ec639ff88b35\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/focusedChild.js\":\"79eb909565da74b4\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/propertySchemas.js\":\"05b8de8471cde575\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/typeRegistry.js\":\"c48c28794d89fc82\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useAncestorCrumbs.js\":\"eb0cfbca171641ab\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useAutocompleteListbox.js\":\"2cd94bcfc746c38c\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useDebouncedSearch.js\":\"9dcd96eea919da0d\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useDebouncedValue.js\":\"1f89c76956f7a0de\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useIsFocalRender.js\":\"2a88ef6a6153c1c1\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useIsReadOnly.js\":\"f2b97a0291860f76\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useMaterializeBacklog.js\":\"5dbe3f3a8952e780\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useMinuteClock.js\":\"c71519d88c4f77a8\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/usePanelLayoutProjection.js\":\"4ff9de4e6cf1d22e\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/usePendingInvitations.js\":\"e5067e6b1f50ec13\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useRendererRegistry.js\":\"f18e6c43a1260a14\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useRetainedFieldRows.js\":\"c009561a2ebd43b8\",\"/knowledge-medium/pr-preview/pr-1801/src/hooks/useWorkspaces.js\":\"e07d8fe9ee31b38b\",\"/knowledge-medium/pr-preview/pr-1801/src/lib/utils.js\":\"13b96cca04dcb321\",\"/knowledge-medium/pr-preview/pr-1801/src/main.js\":\"6dbc4f7b578790cf\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/MarkdownImage.js\":\"d2863aeb7a2fb6c3\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/blockSeparators.js\":\"be92ae3c7e490da6\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/context.js\":\"0dae4c611ea283b9\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/defaultMarkdownExtension.js\":\"7fa52514e3c63c7a\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/extensions.js\":\"18bd3ad9a3d61b5c\",\"/knowledge-medium/pr-preview/pr-1801/src/markdown/renderMarkdownHtml.js\":\"41d387fc17e96af9\",\"/knowledge-medium/pr-preview/pr-1801/src/minimal-editor.js\":\"345cf27e371bf890\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/armedCut.js\":\"ad29f6f08f747137\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/captureMediaVerb.js\":\"9cb016331b4d3bdd\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/clipboard.js\":\"6875fe2a7e5e4b6a\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/decision.js\":\"f5d377e59e29c5d9\",\"/knowledge-medium/pr-preview/pr-1801/src/paste/operations.js\":\"61933e3cf60ecd08\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/account-header/AccountHeaderItem.js\":\"f55b087b59373d08\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/account-header/index.js\":\"10a055d2fdc19e6f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ffd247f56ec66e01\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/askAgent.js\":\"ef18895384acf4c1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/askedStore.js\":\"c17f83eabe8b8498\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"213e52414174c154\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/chipState.js\":\"4bfd9466324992f8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/dataExtension.js\":\"47359dc58efe0c2e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/index.js\":\"323ed6773dae155b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b091e42e9023f6ab\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-dispatch-companion/schema.js\":\"76793adaf6bace71\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/AgentTokensDialog.js\":\"cecafa88e7a73af2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/BridgePairingDialog.js\":\"fc42f858646f1b95\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/addMedia.js\":\"b677557ef85d0e2d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/backlinks.js\":\"bf4491893d160d23\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/block.js\":\"b5342d68e0597fce\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/context.js\":\"cec1207913b09592\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d8eebc8f4a2eacfd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/index.js\":\"9440235a5668f6c1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/outline.js\":\"a2cc7e2a2262e784\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/properties.js\":\"f8a268eccbbb4736\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/refs.js\":\"3604064b147ad984\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"181b3635247ebdea\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/search.js\":\"a343305011540764\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/shared.js\":\"8baa89608dd38be3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e8c7c04fa30e1b15\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentViews/text.js\":\"280e5134e719c2ef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/agentWrites.js\":\"5148bcd55126bb09\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/authoringCatalog.js\":\"a64dcd0044da22d2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/blockRefTargets.js\":\"016d8487b16c53f0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/bridge.js\":\"ec02e53059cba55c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/bridgeLoop.js\":\"328f52907ceef1c8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/changeHistory.js\":\"75b046ee42324ec1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/commands.js\":\"d66d8a4b0a5497fb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/commentsCommands.js\":\"7260689f23ec46d5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/dataExtension.js\":\"dd265bb48bdaa866\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/dataModelGuide.js\":\"388682dee93f2a41\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/describeRuntime.js\":\"c477edd798e4c1c9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/extensionLint.js\":\"a8305d157d246b3a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/grainAudit.js\":\"63ee5c5f13beca23\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/healthCommand.js\":\"8bd9bb44854e7b93\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/index.js\":\"e91f0b2cc215d038\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/presetIdentity.js\":\"e4cdd880f00a027d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1b52cbbc8dac16ad\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/readMedia.js\":\"ba51851fba132b18\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/schema.js\":\"b3b6377df0bf9dea\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/serialization.js\":\"bd8821b7feb2ef16\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/targets.js\":\"5d22a488d8cbf4c5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/tokens.js\":\"0d4ff280025db3ff\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/watchEvents.js\":\"c2536a64e9c09d98\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/workspaceGuard.js\":\"e3bccb92453ceedf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/agent-runtime/writeCommands.js\":\"85a5c65eb4906a15\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/AliasCollisionToast.js\":\"3f4652b957b72b50\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/DuplicateNameBanner.js\":\"b3967716daa23a99\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/collisionMerge.js\":\"8a40d52bdffc6e13\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/dataExtension.js\":\"e72409ac2d6b2bcf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/index.js\":\"ab69fc94131a6a79\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/mergeCollisionAction.js\":\"776cb9237de7c6da\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/pageStyling.js\":\"c0c1db26e47ce58b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/rejectionToast.js\":\"e76e5c3ebeec3fbd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/alias/syncProcessor.js\":\"39d8aa7a3a859967\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/actions.js\":\"b94c7efd9bb4a92c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/addComment.js\":\"9533bbe3243f93fa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/anchor.js\":\"9e178af7147d71fa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/anchorState.js\":\"0aa8bad3ab473c49\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/commentLinks.js\":\"2cd7b75bb0fdba20\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/confirmThreadDeletion.js\":\"54270c519542a19d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/container.js\":\"7e9aeb9958a38e16\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/dataExtension.js\":\"28c127badbcda439\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/deleteComment.js\":\"5d0a8ff67302b55c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/highlights.js\":\"2c0717cef9e7372e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/index.js\":\"fc1a5d977a885616\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/linkedCommentsPill.js\":\"e2115816c25feb14\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/margin.js\":\"249aea7879bce2b1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/marginSchema.js\":\"338678190b3dd409\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/newComment.js\":\"2d15e1f4d6652dee\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/ownThreadPicker.js\":\"e1b16d1067629bce\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/placement.js\":\"2da897b6a7ae07c4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/queries.js\":\"3817eb55be23b4fd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/quotePosition.js\":\"e223ae41980aaf06\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/quotedIn.js\":\"61ad401d1bd07a68\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/quotedRange.js\":\"50742d3a561261bc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/rangeRefs.js\":\"de8d46d53490f60b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/readHighlights.js\":\"81504c43d3069f5b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/readSelection.js\":\"b28ecdd1576810d8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/readSelectionUi.js\":\"b25aad81a0649e7b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/reanchor.js\":\"f7f4503392bb2cfc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/schema.js\":\"e45b176d79fd0524\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/scope.js\":\"32fee03360472f17\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/scopeThreads.js\":\"d45127ce9184d6f6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/splitRetarget.js\":\"fda77729318bfc2f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/suggestionCard.js\":\"bf4b23eda1de8d3c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/suggestions.js\":\"9040e804f6374460\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/summaries.js\":\"3bfaf233774bbd06\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/summaryBatch.js\":\"6a0690507fbdb50b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/surface.js\":\"a2b24787ed1076f4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/threadNavigation.js\":\"6ac932a55facc47a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/threads.js\":\"e7b28dee66a0860c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/ui.js\":\"1e0b2caf5ed128f5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/annotations/uiStore.js\":\"a0800b8b9a4cd0f9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/app-intents/appIntents.js\":\"4ea9bb1bbb59ab50\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/app-intents/index.js\":\"06a061c6be0e637a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/app-update-prompt/index.js\":\"8ad7e74ade54cb63\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/app-update-prompt/status.js\":\"d650fdf290c78c7f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b9f9814d200f8aa6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/MediaBlockRenderer.js\":\"f37b132d85c9661a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ed264df7f461e808\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/MediaUploadReconciler.js\":\"4e2d5e05035bb265\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/assetDownLane.js\":\"75337ab522470928\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/assetResolver.js\":\"90499611373d7828\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/assetUpload.js\":\"f611a2f347582efd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/attachmentCleanerIO.js\":\"76d6bd207e138aa3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/supabaseAuditIO.js\":\"cdb9b36672b2382f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/blobStore.js\":\"a45f9e8638bae32d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/byteStore.js\":\"c104b355f4308453\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/cleanerIO.js\":\"d5cf579a6bf85c96\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/cleanupAttachments.js\":\"54f287769beed172\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/dataExtension.js\":\"b5a6f2fdf7be9f5b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/downLane.js\":\"33b34a598b86564c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/index.js\":\"c2aab3aad5361e79\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/insertImageContribution.js\":\"ba74c1a85dc46899\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/laneArming.js\":\"d51d85b04c87809d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/laneLock.js\":\"d317c515ea38a515\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/mediaBlock.js\":\"f967f05c4acb4839\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/mediaCapture.js\":\"5ec08de346978c44\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/mediaViewers.js\":\"e38893bb559f1355\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/mediaViewersFacet.js\":\"6bf2cc57ef194363\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/pasteCapture.js\":\"01ffefb1d494a668\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/resolver.js\":\"5862d58a0084e57c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/retryUploadsAction.js\":\"15046206fdefd177\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/storagePaths.js\":\"611100f27ed45c9e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadDrain.js\":\"cc55f5f445ddf332\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadLaneStatus.js\":\"bd63f55d2b6d6b90\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadReconcile.js\":\"b50ab9d0eca654dd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadRecovery.js\":\"4c64534cc78bc5ef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/uploadStore.js\":\"829617f3f29e6a98\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/attachments/useAssetObjectUrl.js\":\"d0f0d3e57d0e142b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"70cb33ce71c0ce54\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fb9ed1ae72e76022\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/facet.js\":\"2a451c8416718241\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/index.js\":\"f4c06596bbd26a96\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks-view/prop.js\":\"1c4da362ac1845b0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/BacklinkFilters.js\":\"8fa794615fa7d2e0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"da6aaf94944b87ab\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/BlockEntry.js\":\"fd2aae41a567069b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/LinkedReferences.js\":\"c86d7b5cfe09af80\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"d7bd5d0a24257a4d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/dailyNoteDefaults.js\":\"f49b7e2023eb6924\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/dataExtension.js\":\"cdcc51b1b5f6d3ac\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/edgeExclusions.js\":\"ae3d04ab6c97fd9d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/filterProperty.js\":\"e93bf749da1fd3e9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/index.js\":\"0a0fad96497bca2e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7c0f153be1d15bfd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/applies.js\":\"2c87088a18e759aa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/countQuery.js\":\"2d9450edf9600f16\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/expansionStore.js\":\"98e6fc04140735fd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/index.js\":\"3849762c0439a770\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"624c9643ed14065b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/presentationInvalidation.js\":\"79c21ba106514bef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/propertyEditorOverride.js\":\"8574bd2788d5ebb5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/propertyFilter.js\":\"d66aa6ab080e1bdf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/query.js\":\"1c6b126164d64d64\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/resolveFilter.js\":\"61342266588addd0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/sourceBatch.js\":\"a35fe66f76d05fa0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/sources.js\":\"39b4abf6781a4278\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/useBacklinks.js\":\"fa93f6fd7b0d8d8b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f1428b1466212c1c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/BirthdayCelebration.js\":\"6f450fbbfd5baf01\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/BirthdayOverlay.js\":\"acecfb3d52a82dc9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/gate.js\":\"a1a14d5444d78f31\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/index.js\":\"afac439960f2069d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/birthday/wolfTheme.js\":\"ae2f87b48684aa34\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/BlockDragLayer.js\":\"5291da5145b7b081\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/dragController.js\":\"308aa3f1fc38b6f5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/dropTarget.js\":\"5ab2042d04ae9ee1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/index.js\":\"b4fef9b65f89808e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-drag/projection.js\":\"ff33324754e75212\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-info/BlockMetaCard.js\":\"b8f6879f76367d90\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-info/index.js\":\"4b3d586d198b31f6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/AddTagDialog.js\":\"83969c11df9edc76\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b20126305b176c3e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/TagNameIssueHint.js\":\"bf4eab4bfdb4ef68\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/addTagAction.js\":\"1f546bd4557b9f15\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/appendTag.js\":\"6aecaf628bfa0d4c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/config.js\":\"9b36a32092c03ecd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/dataExtension.js\":\"bd0aef36ed1e7ed2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/index.js\":\"5670996818d0ee5f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/block-tagging/propertyEditorOverride.js\":\"8aa867406c36cf0e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b6c252303dc5095e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d96ca34f6d0d2655\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c1f0ba5b0115b97d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"d33dd4161cfb6379\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8f59888d849ca729\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/index.js\":\"156c6294b5555b4b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d579098a78d168c7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/CharacterCountItem.js\":\"2d6d3d7a1c2caa88\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/ProfilePropertyEditor.js\":\"935418cf5803b440\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/actions.js\":\"cb11b703ef8d83b1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/blockType.js\":\"753d6c411c0aa68c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/charCount.js\":\"d5f35f1b16ce1181\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/dataExtension.js\":\"90da877009013ba6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/index.js\":\"7ee8744634865958\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/profiles.js\":\"a918c4a17fe8e15d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/properties.js\":\"6c6194b7ad2313be\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/character-counter/textCounts.js\":\"ce05d1370e1529e3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/colemak-keybindings/index.js\":\"d9605c60bf1c09f0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/CommandPalette.js\":\"fd4c56559d626e10\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/HeaderItem.js\":\"5d4c60c4ae5236cf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/context.js\":\"17a1063bac075dc4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/index.js\":\"2f978412695c783b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/selection.js\":\"b1a2780caf7c3a6d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/toggleStore.js\":\"6f55e6b8fa582e73\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/command-palette/useCommandPaletteActions.js\":\"4f26259be33a2991\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/ContributorBadges.js\":\"871ca48cf5299ead\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/author.js\":\"84ab1505ecc13a7b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/codeMirrorExtensions.js\":\"3d8d6ca5ce87a464\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/dataExtension.js\":\"d4fc706b57931824\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/index.js\":\"ac82ec820532157c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/mentionAutocomplete.js\":\"811c91bc656ecf49\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/processor.js\":\"2a56ffbbbd80873c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/profiles.js\":\"39093bdbe75b9016\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/queries.js\":\"997be34279121a66\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/contributors/schema.js\":\"1b0075342678596b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"98292d615ae547c3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8e9b4828a2929bcc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/index.js\":\"058f361f3d5840b6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d05a773b19bb76c7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d980de50d1fc3b3b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/CalendarGrid.js\":\"7e4aaa003f02797e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/DailyNotePicker.js\":\"508580b9274eddeb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"45a45158fafc1ef0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/DateNavDecorator.js\":\"accbc3cd35b50d49\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/DateScrubOverlay.js\":\"f952017956c9b5c7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/HeaderItem.js\":\"058ebda08932ac19\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/ReschedulePicker.js\":\"47e52ad89913ca5b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/SpreadDatesDialog.js\":\"98c0f64360d8f86a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/actions.js\":\"21f8e6eca8af8378\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/blockDateAdapter.js\":\"5a3fa54777f056ca\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/calendar.js\":\"0937b59a01a78961\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dailyNotes.js\":\"11624aeda2ffa728\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dataExtension.js\":\"4eaf44d6de67cd73\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dateScrubActions.js\":\"2f5947761f6cb851\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dateScrubGesture.js\":\"cb6393584d8baa16\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b7652268e632dae5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dateScrubRecognizer.js\":\"664a12099563187b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/deletionGuard.js\":\"7cb854e75ce5eda7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/dueQuery.js\":\"504b09d2ca2ba3e0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/index.js\":\"29f7feac693bb442\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/landing.js\":\"b2e6c25596406d45\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/localSchema.js\":\"18c938a0fd0d34c3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/referenceDateAdapter.js\":\"b7b51dd411024e46\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/rescheduleAction.js\":\"a044a330d3be8639\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/schema.js\":\"7fc833ada39bfbdc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/spreadBlockDates.js\":\"1ea75dfc12d2e180\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/spreadDatesAction.js\":\"4d5bc9556be66ce4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/today.js\":\"2098694ac50984bc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"fab08848a2b2459d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"57af467316f9f407\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/audit.js\":\"10fe2c527beab2e5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/auditAction.js\":\"09eb15abcb1736b0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/auditRanges.js\":\"a44fb97be5b14e26\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/diagnosticsSource.js\":\"e88f3bf45a351fca\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/divergenceScan.js\":\"2a7143854fdd96fe\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/index.js\":\"65934ad02e5a1431\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8a01d9b0323d1785\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/referencesMirror.js\":\"4e26ee4f33f3fd94\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/rowJson.js\":\"93a11f3df606ac8c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/schedule.js\":\"9384b205415f64d6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/data-integrity/store.js\":\"36d8edab958b4c65\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-maintenance/action.js\":\"6a41cf37180e1097\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-maintenance/index.js\":\"155283303b1c9a29\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-maintenance/plugin.js\":\"720a17441a494055\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"dbf898841522eade\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/actions.js\":\"a92dc113f5b0b110\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/changeMarker.js\":\"a76afdf3098146e0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/diagnostics.js\":\"e198ee1e7fa1be96\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/fileSystemAccess.js\":\"4bac3612088e6184\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/filenames.js\":\"122f3c2bf928b008\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/index.js\":\"a1298366687571ec\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/mirror.js\":\"6f8675fed06e8eb8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/runLock.js\":\"8bb45fb887264912\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/runtimeHealth.js\":\"8544e21f40ab44b0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/schedule.js\":\"ac7ddc06d52a4105\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/db-mirror/store.js\":\"1be41bbe52a0d7bc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/default-themes/index.js\":\"cd5caebf19752b2f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/default-themes/themes.js\":\"3cd0b64e593c8da8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/diagnostics/facet.js\":\"8b18445363cd5b16\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/diagnostics/useDiagnostics.js\":\"8dfa00d98bfc8e3d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extension-prompts/dismissals.js\":\"6c38e0170a8e323b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extension-prompts/index.js\":\"98a13580ee2c0fab\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extension-prompts/status.js\":\"e16a935bc5a78e23\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extension-prompts/store.js\":\"9ce42326fe8baf02\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c00a7047b3fcdfd1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3a92bb2b051548e5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/actions.js\":\"c516706da236cade\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/config.js\":\"3617b443e6ac4945\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/dataExtension.js\":\"2836159b87e90077\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/effect.js\":\"2af888f0fb8fd5e4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/index.js\":\"81d267206d11f4ef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f2a93275e74481b8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extensions-settings/useToggleTree.js\":\"354a6571f51dd08b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/ExtractTypeDialog.js\":\"edc75da3948c6550\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c3d5c190745063ae\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/PropertyShapePicker.js\":\"6ee91078b47a730d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/action.js\":\"d220a59b46ef0f89\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/extract-type/index.js\":\"59b14391bc2d8250\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/FindReplaceDialog.js\":\"6e07836b66c6c6c6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/HeaderItem.js\":\"b91cf1514ecd0269\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/dataExtension.js\":\"0e6eb30a6661a696\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/index.js\":\"4920fdf06077dd9a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/search.js\":\"f0468a82a47eaac9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/toggleStore.js\":\"07f5fde236a13fe8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/LocationPropertyEditor.js\":\"74f19841d2f7d47d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/MapView.js\":\"daf62b54d3642790\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/blockTypes.js\":\"35209de655af7926\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/codeMirrorExtensions.js\":\"486ddf61cf915002\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/createOrFindPlace.js\":\"904878df107b4fe3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/currentLocation.js\":\"1a5df6343fbb67f5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/dataExtension.js\":\"8677a4364dfd1aee\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/geoContentDecorator.js\":\"86f157e1a142600d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/googlePlacesClient.js\":\"88093b371100fed2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/index.js\":\"7fdbc78d3c64bd5b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/locationsPage.js\":\"d13c0bfd7b6d272b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/mapViewport.js\":\"2a81e0366674a472\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/pickCurrentLocation.js\":\"f2f1002870701e1d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/placeAutocomplete.js\":\"24e2817d6da9d073\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/placeNameCollision.js\":\"b38c486a57601910\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/properties.js\":\"52838e02d49680c3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/propertyEditorOverrides.js\":\"a6733e8ade266c14\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/query.js\":\"1c0886ab204a8066\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/geo/usePlaceSearch.js\":\"9b67f28bc4646cef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"cd73bd981270a435\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"f35d5849aa627d03\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6334e568b9a3686f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/config.js\":\"53d1fa00443fb8b9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/dataExtension.js\":\"19a83f4eb2d9b6eb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/facet.js\":\"99e89c45ea7c7727\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/grouping.js\":\"1756a82fc8c71f7c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/index.js\":\"482a149bf50d7956\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7c499342d570968a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/query.js\":\"aa24d493f8c0a116\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/resolveConfig.js\":\"153ac38a20b3373f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"de37b902d2b81eed\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f0fa3963936b8ab7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/HtmlDocumentContent.js\":\"6b5dacddee95b48f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/HtmlFrame.js\":\"7c4dcedfd427dd8b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/actions.js\":\"6d482dee1cee9469\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/blockType.js\":\"5eccbe2a93284dc5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/confirmRunScripts.js\":\"692b98230f48852f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/dataExtension.js\":\"4cb74e552d4a26c3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/frameAnnotations.js\":\"08e8a315ac8041f7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/frameDocument.js\":\"dcf198a92f079d2d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/frameTheme.js\":\"136d1f955751247c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/index.js\":\"52f236924b04381e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/scriptConsent.js\":\"a5fe2277a3e881e1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/sourceMap.js\":\"67c8eccdb24b465f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/html-document/useDocumentScripts.js\":\"880ef13af7d6cb60\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/index.js\":\"56aba89dfb1ee31a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/record.js\":\"c5497c33d4ce9017\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/recordStore.js\":\"76e3c5b39868bd19\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/responsiveness.js\":\"7791b9ebb95352dc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/schedule.js\":\"5418b2263488c4c3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/interaction-metrics/sessionContext.js\":\"0ddeaad91bc7ce82\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"7a72308a42be3b44\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2c8cbf0c8ee9117e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/actions.js\":\"e81d2e58559fa180\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/config.js\":\"05f9cd04c81afb69\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/dataExtension.js\":\"c9bc3db56aa034aa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/effect.js\":\"08be6a9745333b03\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/index.js\":\"d5446b8a6c7df0d3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/keyCapture.js\":\"f51223d4edb85b8d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/overrideStore.js\":\"71ac6f5917122466\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"cb2dc394feb21a34\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/HeaderItem.js\":\"d8840f9327d02ea2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/LeftSidebar.js\":\"b5c5978c4923dc66\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/actions.js\":\"d00299ea27601ad3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/facet.js\":\"06cb7f77af3d30f9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/index.js\":\"d453576576b54b55\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/shortcuts.js\":\"ff14739634091329\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/left-sidebar/toggleStore.js\":\"fc8d3f2777412036\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/merge-blocks/MergePicker.js\":\"dddf3200f57fcae2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/merge-blocks/index.js\":\"9f24296c4af7cf7a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/merge-blocks/mergeAction.js\":\"464de3ca95e0bbed\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/merge-blocks/strategy.js\":\"6e128a4e7b739821\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/Button.js\":\"ea9f6f03ae48f469\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"3ba65a8f28a08a51\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d5639f72c770985e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/facet.js\":\"526a155448a71306\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-bottom-nav/index.js\":\"6860e95e58c88c9b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4dc9158bc32e132d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d8b9972205a720cc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3c2f85bc0e324ca0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/facet.js\":\"561f3cce688a529b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/mobile-keyboard-toolbar/index.js\":\"f03eddd1b821bc83\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ba500faf8dc4dbc7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2bcf3c9bebecbb2e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/contextMenuItem.js\":\"b72c278a277bf852\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/index.js\":\"751dec5116df3bdc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/moveAction.js\":\"b2cb63a4c1dac34a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/moveBlocks.js\":\"36ebd9a6fc1865d4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/move-blocks/selectionAfterMove.js\":\"1ee87c06ffaa6ddd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/TutorialBanner.js\":\"d2bfd25dd3a8d846\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/action.js\":\"4bd6f172307c604f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/bannerDismissal.js\":\"2c95c3e1f8d2202d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/documents/cheatSheet.js\":\"40bfc6b15fcbdffb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/index.js\":\"bcbbc8ccb753afc0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/keys.js\":\"3da9c730aac39b63\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/landing.js\":\"8e740d0fe8f33f75\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/outline.js\":\"7a2aa98647f97385\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/onboarding/seed.js\":\"d530043caf22518f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/PerfTrendDialog.js\":\"bfe0704a142a71f2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/analyze.js\":\"4d50a90307a9a77b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/diagnosticsSource.js\":\"96c72e45fcddf31c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/index.js\":\"7d982aee3cf99df5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/load.js\":\"2dce2bdd1d956462\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/monitorRun.js\":\"ac4128cc063367ea\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/schedule.js\":\"05e4507ec3be8e91\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/series.js\":\"380ba565d0c7c84f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/store.js\":\"58f8070b5c198355\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/trendAction.js\":\"089d0cfc5105507a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/perf-monitor/verdict.js\":\"0345b711b558864e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/plain-outliner/clickToEditAction.js\":\"de29bd5c84ddf14f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/plain-outliner/index.js\":\"f95f5041a48cdb10\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/plain-outliner/interactions.js\":\"f6cd072834e4d335\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0a558139b64dd13b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/MigrationGate.js\":\"1d14147b39dfb22b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/MigrationGateDialog.js\":\"2e8607a0aab4bbf2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/action.js\":\"dbde29491c7b698d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/index.js\":\"5dca3972d93dd479\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/localRunMessage.js\":\"73c4ccd2d8499601\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/plugin.js\":\"fb19857862175e82\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/progressReport.js\":\"28c4d340bef0128d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/properties-migration/sweepProgress.js\":\"1f46d5519d30f58b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/FieldRowRenderer.js\":\"f7281147a1b54cdb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/ValueRowRenderer.js\":\"eb0e87e3eb024017\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/actions.js\":\"9f9ee81c613db0cc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/autocomplete.js\":\"dcf83a1abe624b69\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/fieldRow.js\":\"8dba85166112061f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/index.js\":\"fffd566c4c79e8f5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/referenceWarning.js\":\"8eaf8d5f53648f84\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/valueAutocomplete.js\":\"cc8f751118f1bc5b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/property-rows/valueSchema.js\":\"85c4bafa78ee90d3\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/HeaderItem.js\":\"f664121c4a60348d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/QuickFind.js\":\"2ab14e44758223dd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/index.js\":\"d8245a5d20f367d9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/recents.js\":\"c2843d82e594d6cb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/resultItems.js\":\"1fd5c92de042990c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/selection.js\":\"82b4f13bcd86119c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/quick-find/toggleStore.js\":\"52e28ab1766de5bd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/HeaderItem.js\":\"bc89bff49bbb2894\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/RecentsPageBlockRenderer.js\":\"cadecb245b68a82c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/grouping.js\":\"64abc3598b54cf81\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/index.js\":\"ec3860ad40bd079e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/recents/target.js\":\"e4b875a1a31a94aa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/codeMirrorExtensions.js\":\"b08c8d11be07be89\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/contentPrefill.js\":\"f5d982238421d34a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/dataExtension.js\":\"96a70e5926aa6a3a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/index.js\":\"c8698e7605daad67\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"35df2a8b5e83b70f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/invalidation.js\":\"d8d588b93f1a6750\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/localSchema.js\":\"0a387acbe3879226\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/blockrefs/index.js\":\"0fdf2b46ada1d898\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"497e973c5c9c2edf\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/index.js\":\"4cd89b4f20c2f4a5\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/referenceNode.js\":\"e6012e3e750b061d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b63446f3e6b7a5b7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7d245b6c6ba61c77\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/wikilinks/index.js\":\"83de0bd6b18d5e10\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8a4f88847f06ea88\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"76ef9488a098a5a6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/mergeRetargetProcessor.js\":\"33ea97bec168e886\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/parseFence.js\":\"50c9c7685af52321\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/referenceParser.js\":\"e5654acc6400990e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/referenceProjection.js\":\"f5a1d419e3837669\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/referencesProcessor.js\":\"6edd3e7ea7de1640\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/renameProcessor.js\":\"d4010d654f089bcc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/references/spanReplacement.js\":\"df76e3175eaeccaa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/rich-paste/htmlToOutline.js\":\"6de58dd5cc8a26e1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/rich-paste/index.js\":\"7680a5b99360305f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b838d1b02a012d3e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/rich-paste/pasteDecision.js\":\"a1619660a7595c8c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/action.js\":\"f90c71eebad16a4d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/blockIds.js\":\"194ed246774ae0fa\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/content.js\":\"a990938913fc2867\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/effect.js\":\"b499527e8e2c22cc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/ids.js\":\"6a30659161ed56a0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/import.js\":\"0a6858b22decdf95\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/index.js\":\"6b8cc585058c1aee\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/plan.js\":\"5cef291d28c886b4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/plugin.js\":\"2af7cbba054d2ca6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/promotion.js\":\"2128a1368f0ea82e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/properties.js\":\"9243af822854ea0a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/references.js\":\"cf6a48b0cf51b13a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/report.js\":\"798edafbc3b45f05\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/roamMemo.js\":\"7545886c4f28d3f2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/runtime.js\":\"5a2c231742e492f4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/schemaReconciliation.js\":\"652aaade4519ecfb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/srsMarkers.js\":\"5795d2afa593f548\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/todo.js\":\"f2c7b44f72a5f9c6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/typeCandidates.js\":\"90110efca5a70dfc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/roam-import/types.js\":\"3407d0dd16a32c6b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/search-health/index.js\":\"da30e2528ce05a56\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/search-health/store.js\":\"3ffe79925f864bb0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/HeaderItem.js\":\"65879c39d98900b1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"112515b9bab8a26b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/index.js\":\"f96f0c74d078f28a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/model.js\":\"346ab4b8acf53368\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/toggleStore.js\":\"b57e5be0413f00ae\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/shortcut-help/useKeyInspector.js\":\"934c01a59f6355dd\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e3cb33c47a4b26ef\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/ShellDecorator.js\":\"987d018e6f9bc996\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/actions.js\":\"24d93dd9285e5535\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d710815fa2deb4ec\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/index.js\":\"5a0e78c343189b40\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/shell.js\":\"7405ae6df209beff\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/surface.js\":\"2e20b01de518155a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/spatial-navigation/walker.js\":\"699fb890a3e18f13\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/RescheduleToast.js\":\"686a854e7c566203\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/dataExtension.js\":\"e37f99adf027fd7a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/index.js\":\"e742a4defa3af603\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/indicator.js\":\"58e4bc66cf93bc6f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/moveSrsState.js\":\"b2ad2ac5c24f042d\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f4eae20b08a4b063\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/scheduler.js\":\"cbf9a195e06cba1e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/schema.js\":\"4197816e5848ff88\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"aefed5f25524146b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/srsClipboard.js\":\"77b4a49f078c0c16\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"3bee6d8398a38162\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/DailyNoteReviewHint.js\":\"8c10b8ee2cdfe931\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/DeckPicker.js\":\"5f6638676dd662f4\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/ReviewControls.js\":\"547be7436267415a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f0777b66902530b8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/ReviewSession.js\":\"382780b10a15150f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/actions.js\":\"06ab40ea86e14710\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/archive.js\":\"12ec7b0f27ef70d6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/dataExtension.js\":\"533dbbdb2599ca8e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/deck.js\":\"28feb1d8a6365087\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/dueQuery.js\":\"100e66c75c24a7a0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/gradeDecision.js\":\"b3666cb5514d13c1\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/index.js\":\"32f246c883024cce\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/keyHints.js\":\"3e18294b5d465864\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/reviewCardLayout.js\":\"6bd478669ae826c2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/reviewProgress.js\":\"d5c19956b9ac3574\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/schema.js\":\"fc84831d575dd697\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/srs-review/useDueCards.js\":\"1a22ee92c7f1b338\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/startup-metrics/index.js\":\"f2b47c46221a26b6\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/startup-metrics/record.js\":\"c562709190c75d81\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/storage-persistence/index.js\":\"a202a1436e88ca66\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/storage-persistence/persistenceStatus.js\":\"3db2fd37205283d9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/storage-persistence/requestAction.js\":\"b85f2aba5703829c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/supertags/TypeChipsDecorator.js\":\"000c80cf26f9691b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/supertags/codeMirrorExtensions.js\":\"047dfcb1e9d38d0b\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/supertags/index.js\":\"f99d20b96b93e01c\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/supertags/typeAutocomplete.js\":\"9466bbee61f946ec\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"76ade3ac6eb12edb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/actions.js\":\"298ec76dd5b6d797\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/anchor.js\":\"c6098fb18710450e\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/events.js\":\"ff422616b335628a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/gestureActions.js\":\"adc1d7d5790bd828\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/index.js\":\"4fe8ebfb230f8f17\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"57dd864c728310bb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/sync-metrics/collect.js\":\"ba9051d1cde4ef6a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/sync-metrics/index.js\":\"8473df3cb33978d7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/sync-metrics/record.js\":\"2135d6b7fef5bacc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/RejectionDialog.js\":\"94f171a0a81a19b2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0f50d84c5739b964\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/index.js\":\"c5510793bf1e1fab\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/model.js\":\"353bb83dc5f9cbb0\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/queueCounts.js\":\"36f616dbaabacd71\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/rejectedHelpers.js\":\"fb09fdc1294d2f18\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/rematerializeAction.js\":\"9debcdaffbefea49\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/system-status/useHysteresis.js\":\"4ae60f510c908b96\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/theme-toggle/effect.js\":\"2df22bea841a9bd8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/theme-toggle/index.js\":\"61540d473f1e6744\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/theme-toggle/theme.js\":\"bf8224d922df4dc2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/todo/actions.js\":\"eaf53bf63a156f96\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/todo/dataExtension.js\":\"d4bf74ddc170be34\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/todo/index.js\":\"7eef99631be575ad\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/todo/schema.js\":\"34c7b3404d07451a\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d4b4ebd27377b95f\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/actions.js\":\"b970fdddd9f85903\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/defaultItems.js\":\"3a1a7d8454ce6502\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/facet.js\":\"905582c073f199f7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/holdRecognizer.js\":\"09ec2d130a24f1dc\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/touch-selection/index.js\":\"1b41673beadc3c73\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/update-indicator/UpdateIndicator.js\":\"4a348d55d4ac71b8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/update-indicator/index.js\":\"51d808dca34783ac\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/update-indicator/loadTimes.js\":\"5f0f84207c301434\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/VideoNotesRenderer.js\":\"aa7f8682dd359dcb\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/VideoPlayerRenderer.js\":\"28af45ef6fc8acb2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/VideoTimeStamp.js\":\"c0defd7eca200dd8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/actions.js\":\"fa2d64aeea417139\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/index.js\":\"4b81129c580498a2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/markdown.js\":\"fad45d4abba5f4d9\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/notes.js\":\"c465eda19e895366\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/registry.js\":\"5e667e561f5410d7\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/remark-timestamps.js\":\"a4c122972093ed79\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/video-player/view.js\":\"5a384b2580e3b388\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-link-hints/LinkHints.js\":\"eb2a06fa8ee45ae8\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-link-hints/index.js\":\"24947f3742b16610\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-link-hints/model.js\":\"710386aad1cd9e82\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-link-hints/settings.js\":\"42cff5c50c05aac2\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-normal-mode/actions.js\":\"37ccd2ded1cbd961\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-normal-mode/index.js\":\"f7e7983ac756f841\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/vim-normal-mode/interactions.js\":\"232ce59dba82d326\",\"/knowledge-medium/pr-preview/pr-1801/src/plugins/workspace-header/index.js\":\"e75e8a2c56d08f4f\",\"/knowledge-medium/pr-preview/pr-1801/src/registerServiceWorker.js\":\"6bde0b08b2d6013b\",\"/knowledge-medium/pr-preview/pr-1801/src/requestPersistentStorage.js\":\"85898467b31a809a\",\"/knowledge-medium/pr-preview/pr-1801/src/services/authRequestDeadline.js\":\"6f0a3257b8657ed8\",\"/knowledge-medium/pr-preview/pr-1801/src/services/authStorage.js\":\"1b2cf04223d2a9bd\",\"/knowledge-medium/pr-preview/pr-1801/src/services/powersync.js\":\"adf1268cfacda702\",\"/knowledge-medium/pr-preview/pr-1801/src/services/supabase.js\":\"7a31356c5e984243\",\"/knowledge-medium/pr-preview/pr-1801/src/services/uploadErrorClassifier.js\":\"739d761415d988ba\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/ActiveContexts.js\":\"a6f08090abdb61b9\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/HotkeyReconciler.js\":\"4b6b8c74f8414b98\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/WipeLocalDataDialog.js\":\"5b42db86b869a424\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/actionDispatch.js\":\"f06e61d6c74059b9\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/actionRefItems.js\":\"26332ea34ebd8f36\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/applyKeybindingOverrides.js\":\"09421b8a8f115d0a\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/blockActions.js\":\"7589613d2421eff4\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/canonicalizeChord.js\":\"064d567ac6228129\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/defaultContexts.js\":\"2c0dcb8bd162443b\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/defaultShortcuts.js\":\"4aa76c802f46f8ed\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/effectiveActions.js\":\"0d1f61dab592e839\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/gestureAction.js\":\"5dfb583617a56a8f\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/gestureBinding.js\":\"c6548dd41a3f38da\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/holdRegistry.js\":\"039f925bfaca8420\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/keybindingConflicts.js\":\"ebeaf2a50db6d7e2\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/keybindingOverrides.js\":\"d6290d0373042662\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/pointerAction.js\":\"62ebd4aafc423d7b\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/resolve.js\":\"b737b9dae1f17860\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/runAction.js\":\"42f58bf76a7158b6\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/sequenceMatcher.js\":\"abce64bb5fe2bc70\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/types.js\":\"2d2aaa69da19c6f1\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/useActionContext.js\":\"7bc040f61dacb7c2\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/useActionDiscovery.js\":\"5e7fac01532c9dcc\",\"/knowledge-medium/pr-preview/pr-1801/src/shortcuts/utils.js\":\"c03fb5e483e115ab\",\"/knowledge-medium/pr-preview/pr-1801/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1801/src/sw/bootStore.js\":\"51a14f5d02069ce6\",\"/knowledge-medium/pr-preview/pr-1801/src/sw/previewDatabases.js\":\"3c358c489a49e57d\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/byteTransform.js\":\"de84fa4431fec18a\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/attachmentCleaner.js\":\"e3c08dd0abb4fedb\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/attachmentParts.js\":\"60a08c95cfdf7f3e\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/bundleParts.js\":\"6052c01f75b4eb11\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/bundleRecord.js\":\"ece06d498e341c29\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/manifest.js\":\"7d5c794f6a37491c\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/takeBundle.js\":\"2063d4c52f044f94\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/bundle/verifyBundle.js\":\"a9867e572ba865d2\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/cleaningStage.js\":\"0154737be4e7323b\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/conversionKey.js\":\"36efc93ebe0a5105\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/conversionServer.js\":\"ac3da1b332967e5c\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/flip.js\":\"8a5593141d70ae36\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/flipAttempts.js\":\"b27b1d3607745239\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/pages.js\":\"25b718ff162127fb\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/preflight.js\":\"44cd7306753b42b0\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/reseal.js\":\"3baa14da5cd43f76\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/runConversion.js\":\"944c7f93b8856632\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/runLock.js\":\"24c42f0e6839bd25\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/sealing.js\":\"e922df857cc4b69b\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/sealingStage.js\":\"6f60fe8e19bc2532\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/stage.js\":\"f72d101355b08ba1\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/conversion/verifyReseal.js\":\"2b075fe1f1a1df36\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/aad.js\":\"b9cf8bbe02f16209\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/aead.js\":\"804a5dab210a0f91\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/base32.js\":\"f73022e4d1728829\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/base64url.js\":\"b71330a5eca08081\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/binaryEnvelope.js\":\"cce7b7a0b0fa8d45\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/byteAead.js\":\"47493b5639eb1e6c\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/canary.js\":\"abe95d158fd8a00d\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/contentHash.js\":\"d814686868a2b466\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/contentKey.js\":\"1e3f71c60ffdaf28\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/derivedIdNamespace.js\":\"dee6945b0700dff4\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/envelope.js\":\"80f0458df53a8f6c\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/hex.js\":\"793462b8d6360791\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/sha256Hex.js\":\"ef37f95a3a82b3af\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/crypto/workspaceKey.js\":\"bdc1df2065c8d611\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/conversionState.js\":\"0b934ba80c20b9df\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/flows/createEncryptedWorkspace.js\":\"717373d700543326\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/flows/pastedKey.js\":\"a0f7d420fba1bb08\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"de9d9dc3e56473ac\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/flows/upgradeWorkspacePin.js\":\"dffbaca4000a4888\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/keyStore.js\":\"f11363a6cf3b8906\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/mintWorkspaceKey.js\":\"7a0ea098cb86bb52\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/modePin.js\":\"a28338bd8c35468f\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/openWorkspaceKeys.js\":\"5e726183bd9d29f4\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/resolveWorkspaceEntry.js\":\"4542ea26fdcffdc0\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/resolver.js\":\"cbc8a1b74b016992\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/keys/workspaceAccess.js\":\"840bccf6880c3dfe\",\"/knowledge-medium/pr-preview/pr-1801/src/sync/transform.js\":\"2624ec78e6b1d6d5\",\"/knowledge-medium/pr-preview/pr-1801/src/themeBootDefaults.js\":\"0b2c7399a8a07b70\",\"/knowledge-medium/pr-preview/pr-1801/src/types.js\":\"1bffaf1423fee90b\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/ClientLocalSettings.js\":\"efba6c9034e61fac\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/abortableSleep.js\":\"8491dacfb46d02a6\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/array.js\":\"2165190ab3d81ab7\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/backlinkAutocomplete.js\":\"619fd85b811200bf\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/blockCrumbs.js\":\"f4a8dcd4cd6fc996\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/blockrefAutocomplete.js\":\"6fdb8496a2f407f7\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/cadencedIdleJob.js\":\"0ac3ff86f0795b43\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/callbackSet.js\":\"5289b0321530d0e6\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/clientId.js\":\"c237ac0464062402\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/codemirror.js\":\"14f0dcf286085811\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/codemirrorCompletion.js\":\"07f1c9190f0557c7\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/copy.js\":\"bfd9ff210e41b5c6\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dailyPage.js\":\"e1ca04c46e01c7ae\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dbForensics.js\":\"71d774732f412de8\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dbForensicsHooks.js\":\"2c2bd68f538b35b5\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/deleteBlockThroughUi.js\":\"1898f9a86bb0f726\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dialogs.js\":\"720ebab3ae6e0a10\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/dom.js\":\"cf41d6948770ef8d\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/downloadBlob.js\":\"1d0b4921a04fa3a7\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/exportSqliteDb.js\":\"6afd6cb73a83c8a6\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/fileSystemAccess.js\":\"f8bda87e3d0c767a\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/flipSlide.js\":\"abbd4b2da5ee1526\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/fnv1a.js\":\"4c2867bd34c7aab5\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/formatBytes.js\":\"faa41bc0ed71855a\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/fuzzyRank.js\":\"82d90e908e4df759\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/idbKeyedStore.js\":\"8829b5fc54d250bc\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/idleCallbackPolyfill.js\":\"feaf975a6fe5e744\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/keyboardAwareScroll.js\":\"92ea2d816afc5c18\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/keyboardViewport.js\":\"d0f9c8d21741bb17\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/lastWorkspace.js\":\"a14fcf5b9e5ff92d\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/layoutColumns.js\":\"0b0dde0d6ea2aa76\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/layoutSessionDom.js\":\"9961abbaf31672c8\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/layoutSessionId.js\":\"ec438ed769dd9a5c\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/linkClickGestures.js\":\"3cce86f492c31186\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/linkTargetAutocomplete.js\":\"9713451cacb557f0\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/localDbCorruption.js\":\"fcdf9048e49b0802\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/localDbRecovery.js\":\"58d889a0d374a7c4\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/markdownParser.js\":\"83a0b381269538de\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/memoize.js\":\"210f8b9ee5d8511c\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/nameFieldCommit.js\":\"21755ad0a523e330\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/nameList.js\":\"f6a75d8cd8c59e5c\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/navigation.js\":\"00c3b831acb8d66f\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/omnilinerNamespace.js\":\"51859b70b0bfcdc1\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/opfsPageScan.js\":\"b41d07f39372a560\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelClearance.js\":\"8956e2744c19cee7\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelHistory.js\":\"1b05e0f8f0926ec2\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelLanes.js\":\"25f261341dbb0940\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelLayoutProjection.js\":\"9a33a9cb41a28db0\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelScrollAnchor.js\":\"e35dff2fc2ae1350\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/panelUrlFlags.js\":\"e5baea722de68391\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/platform.js\":\"aa37cb078319b653\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/pluralize.js\":\"0a302bed8164c279\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/propertyCreation.js\":\"e4d30ece923fbef1\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/propertyNavigation.js\":\"a90f1e08c160d9a3\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/propertyValueContext.js\":\"077b927e53f54be5\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/react.js\":\"a48b10dc567563fa\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/relativeDate.js\":\"89b29a76d5edfb92\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/relativeTime.js\":\"eb26839924b42686\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/renderScope.js\":\"fded7a96e6addffb\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/resolvedThenable.js\":\"c2d3fc65f708f2eb\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/routing.js\":\"a6cfa5412c136bd5\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/safeMode.js\":\"7579fa15b5509895\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/scheduleIdle.js\":\"3fc7022f6a244ea8\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/screenWakeLock.js\":\"b6ace6d0dd765bc2\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/selection.js\":\"1541021c917fe1ef\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/softKeyboardGrab.js\":\"0e8412490b9c85f1\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/startupTimeline.js\":\"3d6e8c089528601b\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/state.js\":\"7306b6f55ec8f6c5\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/string.js\":\"3baed6baeb8e9d8a\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/surfaceZoom.js\":\"729ff6ba170afa13\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/time.js\":\"adff1f28a362870a\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/toast.js\":\"00a73df401f36584\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/toggleStore.js\":\"58cc81674395e842\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/untilStopped.js\":\"815bb0410f2bb614\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/userActivity.js\":\"777de22ac01da0cd\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/viewTransition.js\":\"3bef75ae908bf01a\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/viewport.js\":\"03dca6a5bb48e2c9\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/webLock.js\":\"a3c00ddae0d607ac\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/workspaceRecovery.js\":\"911436f95ee357f9\",\"/knowledge-medium/pr-preview/pr-1801/src/utils/workspaceSnapshotStore.js\":\"55474bd235f54fb3\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-compiler-runtime.js\":\"49e91b54858bf76d\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-client.js\":\"0a7ad2bb9e2ad4fb\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-server-edge.js\":\"f7e77795501e22b7\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-server.js\":\"4ada20afaed171a0\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-static-edge.js\":\"6c35200d154f5ebb\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-static.js\":\"ccec7d4bd9367d71\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom-test-utils.js\":\"f3bb59e9f66f8db8\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-dom.js\":\"6996a0d300474c0d\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react-jsx-runtime.js\":\"7781e78ff24298f0\",\"/knowledge-medium/pr-preview/pr-1801/src/vendor/react.js\":\"f8d349f8e1840b94\",\"/knowledge-medium/pr-preview/pr-1801/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1801/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1801/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
