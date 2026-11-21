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
		buildId: "d7ec2bdabaaf-28c7efcf",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1810/\":\"d405c27d438d3138\",\"/knowledge-medium/pr-preview/pr-1810/index.html\":\"d405c27d438d3138\",\"/knowledge-medium/pr-preview/pr-1810/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1810/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1810/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1810/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1810/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1810/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1810/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1810/assets/FacadeVFS-pR7Q6P1g.js\":\"7461c216adfeda3f\",\"/knowledge-medium/pr-preview/pr-1810/assets/OPFSCoopSyncVFS-BkRnMbJr.js\":\"f1b069c54a204ad4\",\"/knowledge-medium/pr-preview/pr-1810/assets/OPFSWriteAheadVFS-Cw7FrPYQ.js\":\"8e3adefa2edbb5e6\",\"/knowledge-medium/pr-preview/pr-1810/assets/wa-sqlite-BGWSSsfc.js\":\"7ad860637f218916\",\"/knowledge-medium/pr-preview/pr-1810/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1810/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1810/assets/wa-sqlite-async-Cr4E0DD6.js\":\"3c5c097d70c43e95\",\"/knowledge-medium/pr-preview/pr-1810/assets/worker-D0yAp7Dg.js\":\"6503ec5cbdf646d2\",\"/knowledge-medium/pr-preview/pr-1810/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1810/chunks/app-YvTluj8A.js\":\"7e9216e0520b65f4\",\"/knowledge-medium/pr-preview/pr-1810/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1810/index.js\":\"99868611ecc3b0f8\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1810/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1810/assets/AccessHandlePoolVFS-Bs_OIXY6.js\":\"12a382c9c1930aa7\",\"/knowledge-medium/pr-preview/pr-1810/assets/IDBBatchAtomicVFS-CF1EluSs.js\":\"adb2e117d5dabad0\",\"/knowledge-medium/pr-preview/pr-1810/assets/MemoryVFS-DqSeJjH9.js\":\"b64eb29fb1470341\",\"/knowledge-medium/pr-preview/pr-1810/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1810/assets/mc-wa-sqlite-D5g6JITs.js\":\"4399effc371324bc\",\"/knowledge-medium/pr-preview/pr-1810/assets/mc-wa-sqlite-async-BTfKEUJK.js\":\"917d2f9574d4e286\",\"/knowledge-medium/pr-preview/pr-1810/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1810/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1810/chunks/AccessHandlePoolVFS-DB0hMKOY.js\":\"fba8bae2307f1329\",\"/knowledge-medium/pr-preview/pr-1810/chunks/FacadeVFS-CtLM1YWm.js\":\"73115541dc3fb4b7\",\"/knowledge-medium/pr-preview/pr-1810/chunks/IDBBatchAtomicVFS-BWLZFZYR.js\":\"f364b765af0fbd78\",\"/knowledge-medium/pr-preview/pr-1810/chunks/MemoryVFS-CWGP9FJr.js\":\"bd9b89a48a78a9c8\",\"/knowledge-medium/pr-preview/pr-1810/chunks/OPFSCoopSyncVFS-BQn1iGeU.js\":\"c7c5925e7ecb346f\",\"/knowledge-medium/pr-preview/pr-1810/chunks/OPFSWriteAheadVFS-6xpB1qFA.js\":\"864e6f53e6276523\",\"/knowledge-medium/pr-preview/pr-1810/chunks/Preview-DRiuvMqz.js\":\"0629b41dcc95d103\",\"/knowledge-medium/pr-preview/pr-1810/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1810/chunks/card-C4RGhJ53.js\":\"c285db65d4418193\",\"/knowledge-medium/pr-preview/pr-1810/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1810/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1810/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1810/chunks/dist-pyE8-OWS.js\":\"8ad47d0ed912275f\",\"/knowledge-medium/pr-preview/pr-1810/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1810/chunks/mc-wa-sqlite-C_F9HzUR.js\":\"4d47c86ac54fffe5\",\"/knowledge-medium/pr-preview/pr-1810/chunks/mc-wa-sqlite-async-D7D7SHQ7.js\":\"995118520fa60bd1\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-B-CvTvJi.js\":\"40a86c5430ba2928\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-B_-1LJ0Q.js\":\"84777173c9fb3757\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-BiXko822.js\":\"27479bc4018c688f\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-BikGnGL4.js\":\"e7179beea3f1e609\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-D6cfyiG5.js\":\"0cb033b1a38a030e\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-DNn7xLuM.js\":\"5e9c966f4824db54\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-DnaFHQXX.js\":\"4b1c7d426e31a7b3\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-KyPsg45i.js\":\"5f63eb0105b0d50e\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-dom-server-legacy.browser.production-MsP-86Ot.js\":\"3cf166a34bb0d7ea\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-dom-server.browser.production-tV-blXcu.js\":\"83e9cd8a30aaf9dd\",\"/knowledge-medium/pr-preview/pr-1810/chunks/react-dom-server.edge.production-lJCV__gk.js\":\"5cadcad9089db11b\",\"/knowledge-medium/pr-preview/pr-1810/chunks/server.browser-CjqWohyN.js\":\"f8885bddd875400b\",\"/knowledge-medium/pr-preview/pr-1810/chunks/textarea-S2b3PSXs.js\":\"819c63ddfbd5a39e\",\"/knowledge-medium/pr-preview/pr-1810/chunks/ui-B1B3SxO_.js\":\"860c36dea75e21e8\",\"/knowledge-medium/pr-preview/pr-1810/chunks/wa-sqlite-BlhQOUYo.js\":\"3ed5153ed475e738\",\"/knowledge-medium/pr-preview/pr-1810/chunks/wa-sqlite-async-CD_pvUXS.js\":\"24b71a3366231917\",\"/knowledge-medium/pr-preview/pr-1810/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1810/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1810/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1810/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1810/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1810/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1810/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1810/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1810/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1810/src/App.js\":\"6d74ce5b272ecb15\",\"/knowledge-medium/pr-preview/pr-1810/src/appUpdate.js\":\"206a47b87b36ae32\",\"/knowledge-medium/pr-preview/pr-1810/src/appVersion.js\":\"75cfd05e6006265d\",\"/knowledge-medium/pr-preview/pr-1810/src/bootstrap/initialLayout.js\":\"6ace4e21cb1ac0ee\",\"/knowledge-medium/pr-preview/pr-1810/src/bootstrap/openWorkspaceData.js\":\"212228534e8f2667\",\"/knowledge-medium/pr-preview/pr-1810/src/bootstrap/resolveWorkspace.js\":\"577679f0dd33ed08\",\"/knowledge-medium/pr-preview/pr-1810/src/bootstrap/workspaceBootstrap.js\":\"f008d8621910b7c5\",\"/knowledge-medium/pr-preview/pr-1810/src/components/BlockComponent.js\":\"0734e001d55451ec\",\"/knowledge-medium/pr-preview/pr-1810/src/components/BlockCrumbs.js\":\"a548cd5e4710c981\",\"/knowledge-medium/pr-preview/pr-1810/src/components/BlockEditor.js\":\"06158075abaf458e\",\"/knowledge-medium/pr-preview/pr-1810/src/components/BlockLoadingPlaceholder.js\":\"59b499a76080b0a2\",\"/knowledge-medium/pr-preview/pr-1810/src/components/BlockProperties.js\":\"2dd7a29cc188f9cd\",\"/knowledge-medium/pr-preview/pr-1810/src/components/BlockSearchPicker.js\":\"d44ccc9a20feee93\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ConfirmBulkDeleteDialog.js\":\"26d4edd64c709923\",\"/knowledge-medium/pr-preview/pr-1810/src/components/DividerHandle.js\":\"b233c07378e14d4a\",\"/knowledge-medium/pr-preview/pr-1810/src/components/DraftEditor.js\":\"078939011f4c50ae\",\"/knowledge-medium/pr-preview/pr-1810/src/components/GutterPill.js\":\"3a83161f1ae2c09b\",\"/knowledge-medium/pr-preview/pr-1810/src/components/Header.js\":\"afce43517a3d7910\",\"/knowledge-medium/pr-preview/pr-1810/src/components/LazyBlockComponent.js\":\"94ac884296259842\",\"/knowledge-medium/pr-preview/pr-1810/src/components/Login.js\":\"9ea4fa70de31f9eb\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ZoomableSurface.js\":\"e0677effeee69932\",\"/knowledge-medium/pr-preview/pr-1810/src/components/editModeKeepalive.js\":\"067f09ad226d30cf\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b5741424e15e5b8c\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0d77c47ad05a5a17\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyEditors/RefPropertyEditor.js\":\"aa5af819c42a71df\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyEditors/RefTargetTypePicker.js\":\"635446eaf689c888\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyEditors/SelectPropertyEditor.js\":\"a8d645fc1b9d6e85\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyEditors/TypesPropertyEditor.js\":\"d32615afe4b56f84\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyEditors/defaults.js\":\"2883c3c75dc187df\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyEditors/kernelValuePresets.js\":\"5752efcb1d27d0c5\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyEditors/selectablePresets.js\":\"6ccf6588e3439629\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyEditors/typesPropertyUi.js\":\"df6a0927db294328\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/AddPropertyForm.js\":\"0ea0096e43f49d48\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/PropertyPicker.js\":\"49214b41eae638f3\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/PropertyRow.js\":\"d3d382a0d1da8f8d\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/Rows.js\":\"9be09b542b70bdd8\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/actions.js\":\"b993eaf54d1e7d0a\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/declarationOnly.js\":\"c6805b52c4f9e89b\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/layout.js\":\"0e7680e3335eedf6\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/model.js\":\"bbea79683e4071ee\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/shapeUi.js\":\"7a8cb63bf97a780b\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/shapes.js\":\"536f897c4d0c0a4f\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/usePropertyEditingActivation.js\":\"49d9d508ba7582e9\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanel/visibility.js\":\"08c1006bff36f2c8\",\"/knowledge-medium/pr-preview/pr-1810/src/components/propertyPanelSections.js\":\"f1e0597ca53b0e80\",\"/knowledge-medium/pr-preview/pr-1810/src/components/references/BlockEmbed.js\":\"c78f186f49ddf7dd\",\"/knowledge-medium/pr-preview/pr-1810/src/components/references/BlockLink.js\":\"97c36939a6c76e44\",\"/knowledge-medium/pr-preview/pr-1810/src/components/references/BlockRef.js\":\"c47934c432ca2911\",\"/knowledge-medium/pr-preview/pr-1810/src/components/references/ReferenceLink.js\":\"dbbecc827e981037\",\"/knowledge-medium/pr-preview/pr-1810/src/components/references/cycleGuard.js\":\"fd8c64c5abcda35f\",\"/knowledge-medium/pr-preview/pr-1810/src/components/references/cycleGuardContext.js\":\"00cd6dcf06ecfc5b\",\"/knowledge-medium/pr-preview/pr-1810/src/components/references/linkInteraction.js\":\"6012f4958a5447da\",\"/knowledge-medium/pr-preview/pr-1810/src/components/references/referenceLayout.js\":\"fcb9a4c274a24119\",\"/knowledge-medium/pr-preview/pr-1810/src/components/references/useBlockRefAncestors.js\":\"b14a59c1c5f2aa66\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/BlockGutter.js\":\"3a2985ebf818b97a\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/BlockInfoDialog.js\":\"88be0f665daabf3d\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/BlockTypeBlockRenderer.js\":\"df169984215c52a3\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/BulletHoverCard.js\":\"39212fda74da7a38\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/CodeMirrorContentRenderer.js\":\"c0d351c960da8eb4\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1598c618f4647bf0\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/ColumnResizeHandles.js\":\"e181b57091a508fa\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"dfe0e3daa48a0c43\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/DefaultBlockRenderer.js\":\"c7d30f5b77f99818\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/LayoutRenderer.js\":\"c1502571a9b5bbca\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/MarkdownContentRenderer.js\":\"b31c2e7b6589a673\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/MissingDataRenderer.js\":\"5ce5f16eef7a21e8\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/PanelRenderer.js\":\"f71865f469256089\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e00ee2294330765e\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/TopLevelRenderer.js\":\"b9da1e9497a1749f\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/blockGutterMode.js\":\"c87305568f5b1cb7\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/blockTitleText.js\":\"391ba315ed2b7bb1\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/fieldCreationKeydown.js\":\"847b8b7a6062ab6e\",\"/knowledge-medium/pr-preview/pr-1810/src/components/renderer/layoutRootContext.js\":\"1237745b61b06776\",\"/knowledge-medium/pr-preview/pr-1810/src/components/typeChip/TypeChip.js\":\"1bde6a747f9ad3b1\",\"/knowledge-medium/pr-preview/pr-1810/src/components/typeChip/chipStyle.js\":\"630ca3bf93568966\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/anchored-floating.js\":\"8d1abecc90880a8f\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/button.js\":\"c48f16585a11eafd\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/card.js\":\"63f1963616d97ea3\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/checkbox.js\":\"51d6db9626b57917\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/collapsible.js\":\"731e2bc64a52465e\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/command.js\":\"f18ae9da02c3b55b\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/context-menu.js\":\"5bc2b886565707ed\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/dialog.js\":\"cfbc277c45a909d0\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/dropdown-menu.js\":\"c54c355625a94818\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/floating-listbox.js\":\"54dc09f135f653e0\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/index.js\":\"0fa453761e24eb19\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/input.js\":\"2ae6abd4790abea0\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/kbd.js\":\"356b788902ae2244\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/label.js\":\"0940abe82fc14741\",\"/knowledge-medium/pr-preview/pr-1810/src/components/ui/textarea.js\":\"7882713070af6229\",\"/knowledge-medium/pr-preview/pr-1810/src/components/useEditModeYieldKeepalive.js\":\"52d01efaca8ec7a0\",\"/knowledge-medium/pr-preview/pr-1810/src/components/util/BootFallback.js\":\"253a46103253335c\",\"/knowledge-medium/pr-preview/pr-1810/src/components/util/FocusedRowLazyMount.js\":\"859b40cef4908f29\",\"/knowledge-medium/pr-preview/pr-1810/src/components/util/LazyViewportMount.js\":\"893a457d082215ca\",\"/knowledge-medium/pr-preview/pr-1810/src/components/util/LocalDbCorruptionFallback.js\":\"0c367a2a6dc64175\",\"/knowledge-medium/pr-preview/pr-1810/src/components/util/error.js\":\"faeb86e11dd7c97f\",\"/knowledge-medium/pr-preview/pr-1810/src/components/util/lazyMountRegistry.js\":\"ac6dc29a1d687f5a\",\"/knowledge-medium/pr-preview/pr-1810/src/components/util/suspense.js\":\"6a5382f295b4aaff\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/CreateWorkspaceDialog.js\":\"db1106dd41d6ba2e\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/PendingInvitations.js\":\"1bd5289193351015\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/SyncProgress.js\":\"2e2073156e20ae72\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/UnlockProgress.js\":\"d334ee1f4de1ad0d\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/WorkspaceKeyGate.js\":\"64f914faffc7efc3\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/WorkspaceSettingsDialog.js\":\"9a266fc8b8b7d28b\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/WorkspaceSwitcher.js\":\"cb490cf6286e6aec\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/WorkspaceSyncGate.js\":\"9d99e53b39d6a3cb\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/conversion/ConversionFlow.js\":\"230cff6b6dde029c\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/conversion/ConversionFlowHost.js\":\"d62c3bfbdf84e7a8\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/conversion/EncryptionSection.js\":\"2924d1e1108b2cc1\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/conversion/attachmentPrompts.js\":\"7fd87713ee6c8b51\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d14e94f6f68960fd\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/conversion/conversionFlowDeps.js\":\"49a0d7133be9f9b8\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/conversion/conversionFlowStore.js\":\"2dec4bea5e364ca6\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/conversion/flowUi.js\":\"68f086824bf3f3d3\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/conversion/useConversionRun.js\":\"81590226a52ff314\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/keyUi.js\":\"69824bc2f279e9c7\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/useCloseOnKeyLoss.js\":\"8ad44798be615d41\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/useCloseOnServerE2ee.js\":\"82a5029d8dcd0db9\",\"/knowledge-medium/pr-preview/pr-1810/src/components/workspace/workspaceUnlocked.js\":\"5110640dce75e491\",\"/knowledge-medium/pr-preview/pr-1810/src/context/backgroundSubtree.js\":\"75e7c89861eef9ae\",\"/knowledge-medium/pr-preview/pr-1810/src/context/block.js\":\"8154171bd7218204\",\"/knowledge-medium/pr-preview/pr-1810/src/context/layoutWsContext.js\":\"6e412651f4afa236\",\"/knowledge-medium/pr-preview/pr-1810/src/context/propertyDisplay.js\":\"4c533b04463281a8\",\"/knowledge-medium/pr-preview/pr-1810/src/context/repo.js\":\"3e7a3c85d6381ad1\",\"/knowledge-medium/pr-preview/pr-1810/src/data/aliasClaim.js\":\"95a3795c5c9be0f9\",\"/knowledge-medium/pr-preview/pr-1810/src/data/aliasSeatNamespace.js\":\"c22e69ca5f96ab3f\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/blockData.js\":\"207d47fede0527a8\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/blockType.js\":\"39c5bcdb9ffdd77d\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/changeScope.js\":\"4344678154b15c33\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/codecs.js\":\"4414c6a0c762d555\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/derivedData.js\":\"61af242aec6980d9\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/errors.js\":\"50579dbd9ac2da59\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/events.js\":\"da6203a9afafc4bf\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/handle.js\":\"9200546ad24d7a86\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/index.js\":\"d4cb8a67308e06e6\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/mutator.js\":\"ba599f03d6c7a5c3\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/processor.js\":\"cfb5dddfd4a6f937\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/propertySchema.js\":\"4b02205fed441e4d\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/query.js\":\"334a82c28fc020d0\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/sameTxProcessor.js\":\"33beaf1d4f4b1501\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/schema.js\":\"9200546ad24d7a86\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/tx.js\":\"9200546ad24d7a86\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/typedBlockQuery.js\":\"559c32210c91f313\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/user.js\":\"515171aa1747a77c\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/valuePresetCore.js\":\"c0c5112f9023c613\",\"/knowledge-medium/pr-preview/pr-1810/src/data/api/valuePresets.js\":\"cf5af73ad7e4851c\",\"/knowledge-medium/pr-preview/pr-1810/src/data/attachmentCleanerIOVerb.js\":\"6d15b717a88f777b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/block.js\":\"912faa601e52b79c\",\"/knowledge-medium/pr-preview/pr-1810/src/data/blockCache.js\":\"44d173411abbc518\",\"/knowledge-medium/pr-preview/pr-1810/src/data/blockId.js\":\"768353a9e2f7fc66\",\"/knowledge-medium/pr-preview/pr-1810/src/data/blockLiveness.js\":\"167c8ba74afbc2ac\",\"/knowledge-medium/pr-preview/pr-1810/src/data/blockMerge.js\":\"11036e98e8f1b31b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/blockSchema.js\":\"7ad7c10ba21f74ab\",\"/knowledge-medium/pr-preview/pr-1810/src/data/blockTypes.js\":\"532d03424bd14684\",\"/knowledge-medium/pr-preview/pr-1810/src/data/clientContext.js\":\"9900e2d7ade06cbe\",\"/knowledge-medium/pr-preview/pr-1810/src/data/dbFileSiblings.js\":\"1ed6b6e1a6c77446\",\"/knowledge-medium/pr-preview/pr-1810/src/data/definitionSeeds.js\":\"f2a31b1010140a16\",\"/knowledge-medium/pr-preview/pr-1810/src/data/derivedIds.js\":\"f78f682bce21fd3f\",\"/knowledge-medium/pr-preview/pr-1810/src/data/drawnSubtree.js\":\"afbdaf827b903725\",\"/knowledge-medium/pr-preview/pr-1810/src/data/facetBridge.js\":\"a84c6d9d13a9b8f1\",\"/knowledge-medium/pr-preview/pr-1810/src/data/facets.js\":\"1de7dc874bf11164\",\"/knowledge-medium/pr-preview/pr-1810/src/data/globalState.js\":\"fb4039adcc4865d1\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/aliasClaimRederiveProcessor.js\":\"dcad76e9df25b581\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/ancestorBatch.js\":\"08eb4843214ee355\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/blockTypeTypeifyProcessor.js\":\"b27ff184ea477e4a\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/clientSchema.js\":\"353e0c244d57d755\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/commitPipeline.js\":\"61670aeade9182b4\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/devAssertions.js\":\"216e4ed40e329df8\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/firstSync.js\":\"46726f2ccb51ee24\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/freshInitialLoad.js\":\"2aa3081cfa7bfd47\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/graphBackfillClaim.js\":\"0d3e8610c93797a2\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/handleStore.js\":\"07d080e7a9a5adb7\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/idleMarkerJobs.js\":\"11d326b0d8860b06\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/initialDownload.js\":\"b2be47054c73a2ef\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/initializeClientDatabase.js\":\"4ba07ccfa21393a6\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/jsonCanonical.js\":\"183ae18d42b9615b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/kernelInvalidation.js\":\"ff2735cc690ccde4\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/kernelProcessors.js\":\"baf4dbbad56725bf\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/kernelQueries.js\":\"ede99096e1ff9fea\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/mergeTypeMembershipProcessor.js\":\"a13dcd13a051276b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/normalizeReferencesProcessor.js\":\"713a7f5dd90b1679\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/poolInstrumentation.js\":\"abca8a40197b4754\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/processorRunner.js\":\"2e84f95b1f8066b5\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/propertyCellBackfill.js\":\"53424c3c98c17aeb\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/propertyChildMint.js\":\"7a2f9c1b6166b86f\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/propertyChildrenProcessor.js\":\"2d86ce7b402869fa\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/propertyDefinitionChangeProcessor.js\":\"76a6e506d642ee21\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/propertyDefinitionSynthesis.js\":\"4f61ebd8a92da067\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/propertyKeyScan.js\":\"c00a5a167952812b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/propertySchemaResolution.js\":\"45dd65b37926f86a\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/propertyValueEdits.js\":\"7257da77109a75e3\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/raiseProtocol.js\":\"d95521b8e7b975fc\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/readBatch.js\":\"adacac3130659513\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/refProjection.js\":\"e7eaaacddebb5bbe\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/referenceTargetLookups.js\":\"01215ef1b12ba397\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/referenceTargetProcessor.js\":\"12113121183bff23\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/replayMerge.js\":\"fd9f922f0465afa5\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/sqlBinds.js\":\"bb729ec5c81f9b7e\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"45a571518b6ada8f\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/syncObserver/arrivalProcessors.js\":\"6ff61515203e340b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/syncObserver/invalidate.js\":\"b4c8213ce8337c88\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/syncObserver/materialize.js\":\"b128fbff8795296b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/syncObserver/observer.js\":\"fa6e7bcfae043a6c\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/syncObserver/reconcile.js\":\"cb0b24e4540f838d\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/timingMetrics.js\":\"c7b8f0d8bf2feb5a\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/treeQueries.js\":\"9d8a6346fe4ec77a\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/txEngine.js\":\"309fef7892f36c3b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/txSnapshots.js\":\"ec1d998bd0f5a473\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/typedBlockQuery.js\":\"7c430e89ea2fbbce\",\"/knowledge-medium/pr-preview/pr-1810/src/data/internals/undoManager.js\":\"6ebe6ff12a1e7d5e\",\"/knowledge-medium/pr-preview/pr-1810/src/data/invalidation.js\":\"5210cff5b49a0ff2\",\"/knowledge-medium/pr-preview/pr-1810/src/data/kernelDataExtension.js\":\"c37b75f22b2afdf2\",\"/knowledge-medium/pr-preview/pr-1810/src/data/kernelPage.js\":\"580fe25157037d50\",\"/knowledge-medium/pr-preview/pr-1810/src/data/kernelValuePresetCores.js\":\"1f99ea0e3cf060e5\",\"/knowledge-medium/pr-preview/pr-1810/src/data/localDbCorruptionSignal.js\":\"87b43105647e5121\",\"/knowledge-medium/pr-preview/pr-1810/src/data/localDbStorage.js\":\"dc6d869380419630\",\"/knowledge-medium/pr-preview/pr-1810/src/data/localDbVfs.js\":\"0c28ae3b4bcf145a\",\"/knowledge-medium/pr-preview/pr-1810/src/data/localSchema.js\":\"15e55e9db81a3c56\",\"/knowledge-medium/pr-preview/pr-1810/src/data/maintenance.js\":\"be079ce57c71510e\",\"/knowledge-medium/pr-preview/pr-1810/src/data/mergeProperties.js\":\"cf8f0ba22381fbce\",\"/knowledge-medium/pr-preview/pr-1810/src/data/metricsConsoleHook.js\":\"ca428824a41c0a64\",\"/knowledge-medium/pr-preview/pr-1810/src/data/migrationsPage.js\":\"f320f8c8331e77df\",\"/knowledge-medium/pr-preview/pr-1810/src/data/mutators.js\":\"cb86b037edf514a2\",\"/knowledge-medium/pr-preview/pr-1810/src/data/orderKey.js\":\"505affea1662f7cc\",\"/knowledge-medium/pr-preview/pr-1810/src/data/orderKeyPlacement.js\":\"948e3f7e80228b97\",\"/knowledge-medium/pr-preview/pr-1810/src/data/outlineSurface.js\":\"22ffacb46739ec4c\",\"/knowledge-medium/pr-preview/pr-1810/src/data/pendingEditorContent.js\":\"b870ab7bc1bfcf12\",\"/knowledge-medium/pr-preview/pr-1810/src/data/pendingUploadsSql.js\":\"f587338b1ab993fc\",\"/knowledge-medium/pr-preview/pr-1810/src/data/pluginStateExtensions.js\":\"589d1455ec4bc7b2\",\"/knowledge-medium/pr-preview/pr-1810/src/data/powerSyncLogger.js\":\"abfc5e21fa9c4ba7\",\"/knowledge-medium/pr-preview/pr-1810/src/data/projectorRuntime.js\":\"a44d26e9215abec6\",\"/knowledge-medium/pr-preview/pr-1810/src/data/properties.js\":\"722c2e98817b98e4\",\"/knowledge-medium/pr-preview/pr-1810/src/data/propertiesPage.js\":\"ab6727c5c4be03d1\",\"/knowledge-medium/pr-preview/pr-1810/src/data/propertyChildren.js\":\"d9222d72241b3a8c\",\"/knowledge-medium/pr-preview/pr-1810/src/data/propertyDefinitionFanout.js\":\"f33d511b337a2683\",\"/knowledge-medium/pr-preview/pr-1810/src/data/propertyDefinitionMetadata.js\":\"229b57ceaec980f2\",\"/knowledge-medium/pr-preview/pr-1810/src/data/propertyDefinitionRegistry.js\":\"1340d8bf2e35f2e7\",\"/knowledge-medium/pr-preview/pr-1810/src/data/propertyDisplayMode.js\":\"9b18ff7f0186fdd8\",\"/knowledge-medium/pr-preview/pr-1810/src/data/propertyRowCreation.js\":\"ef2b8d337cace58a\",\"/knowledge-medium/pr-preview/pr-1810/src/data/propertySchemaCreation.js\":\"e05cdd793236f65a\",\"/knowledge-medium/pr-preview/pr-1810/src/data/propertySeeds.js\":\"cc9b427e07027cbf\",\"/knowledge-medium/pr-preview/pr-1810/src/data/recentsPage.js\":\"49113f71f9a1bb33\",\"/knowledge-medium/pr-preview/pr-1810/src/data/referenceBlock.js\":\"5fff15bcbb249fca\",\"/knowledge-medium/pr-preview/pr-1810/src/data/releasePowerSyncConnection.js\":\"f72ecd31f6f5b2aa\",\"/knowledge-medium/pr-preview/pr-1810/src/data/repo.js\":\"dd08e08a39f4cdc3\",\"/knowledge-medium/pr-preview/pr-1810/src/data/repoProvider.js\":\"6ef11b2c2866cd5b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/rowProperty.js\":\"84baee4740bda6ea\",\"/knowledge-medium/pr-preview/pr-1810/src/data/searchFilter.js\":\"2f9206e9c80d960f\",\"/knowledge-medium/pr-preview/pr-1810/src/data/seedIdentityLedger.js\":\"3e418d992593a4c0\",\"/knowledge-medium/pr-preview/pr-1810/src/data/stateBlocks.js\":\"0cc045b89fdee2d3\",\"/knowledge-medium/pr-preview/pr-1810/src/data/structuralEditPolicy.js\":\"4ec89aa74376718e\",\"/knowledge-medium/pr-preview/pr-1810/src/data/subtreeDelete.js\":\"00137922f595dc7b\",\"/knowledge-medium/pr-preview/pr-1810/src/data/syncStreamLock.js\":\"c48b5f7a393b278f\",\"/knowledge-medium/pr-preview/pr-1810/src/data/syncedTableSqlRecognizer.js\":\"ab5eaea586d037fa\",\"/knowledge-medium/pr-preview/pr-1810/src/data/syncedTableWriteGuard.js\":\"0a49c299716c0c92\",\"/knowledge-medium/pr-preview/pr-1810/src/data/targets.js\":\"aa7224cddf8468c5\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typeColors.js\":\"da6eb4d40e7850f6\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typeDefinitionMetadata.js\":\"31732400c1f5abd5\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typeDefinitionRegistry.js\":\"86bc7810244724de\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typeExtraction.js\":\"62ee8dda67670515\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typeInitialValues.js\":\"9bf783af2bd7ef2a\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typePropertyGroups.js\":\"08d9bf947f6f5917\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typeSeeds.js\":\"8bf4357793d9c35f\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typeTagger.js\":\"623b5855204a1580\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typedRecords.js\":\"b35f2d68663279a8\",\"/knowledge-medium/pr-preview/pr-1810/src/data/typesPage.js\":\"170a89348fefc419\",\"/knowledge-medium/pr-preview/pr-1810/src/data/userPrefs.js\":\"564fa304f69f804f\",\"/knowledge-medium/pr-preview/pr-1810/src/data/userSchemasService.js\":\"ade5b02323178866\",\"/knowledge-medium/pr-preview/pr-1810/src/data/userTypesService.js\":\"9d63b4052c2367fd\",\"/knowledge-medium/pr-preview/pr-1810/src/data/valuePresetRegistry.js\":\"261b9bf3d6340128\",\"/knowledge-medium/pr-preview/pr-1810/src/data/visibleChildren.js\":\"67106a5198487a91\",\"/knowledge-medium/pr-preview/pr-1810/src/data/workspaceConversion.js\":\"c1c47ba06046bb00\",\"/knowledge-medium/pr-preview/pr-1810/src/data/workspaceFirstSync.js\":\"211a8a8f50a322c9\",\"/knowledge-medium/pr-preview/pr-1810/src/data/workspaceIdNamespace.js\":\"48134ed001ab498f\",\"/knowledge-medium/pr-preview/pr-1810/src/data/workspaceSchema.js\":\"9430a437c24119d2\",\"/knowledge-medium/pr-preview/pr-1810/src/data/workspaces.js\":\"a9ea298bad8feb12\",\"/knowledge-medium/pr-preview/pr-1810/src/data/writeAheadLog.js\":\"fa91c371cf022acc\",\"/knowledge-medium/pr-preview/pr-1810/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/BlockPasteShellDecorator.js\":\"4ed68b80b48c5b3b\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/atTrigger.js\":\"157b0eacefeb322c\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/autocomplete.js\":\"07c96cec93dcdd97\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/codeMirrorExtensions.js\":\"0f284ba005759f98\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/contentFlush.js\":\"94929557acf19e30\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/defaultInteractions.js\":\"78fe384bd23e2e88\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/editSettleSignal.js\":\"7ab60999a842050e\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/insertImage.js\":\"3ade88ef84cb5f7e\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/referenceCompletionRange.js\":\"18b71828a3c58be6\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/referenceTargetTypes.js\":\"6ce7a479416d62ab\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/syntaxContext.js\":\"9eea2575a71fdf94\",\"/knowledge-medium/pr-preview/pr-1810/src/editor/triggerMatch.js\":\"d709c9da0080e028\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/AppRuntimeProvider.js\":\"9451ff252456d65f\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/BlockFocusShellDecorator.js\":\"131c9bc4889865a8\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/ExtensionRenderBoundary.js\":\"260370f1684a6f6a\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/PanelContentRecovery.js\":\"12df39a24fd51b50\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/apiCatalog.js\":\"7f7c5b4e6bf72e42\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/approveExtensionHere.js\":\"487f5cd8deec42ca\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/armedCutAppMount.js\":\"84ad4377ad3123af\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/batchableKeyedStore.js\":\"b391ca21395e929a\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/blockInteraction.js\":\"ac0dbd7f0e64fdfe\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/blockSelectionAction.js\":\"240c5e65864378ee\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/compileExtensionModule.js\":\"e60cb5dec9328ea4\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/compiledModuleCache.js\":\"3803a6d419b74a5b\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/continuousGestures.js\":\"a49ffb61a98d08d3\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/core.js\":\"3491ff488ba224c0\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/defaultRenderers.js\":\"5d78e91f9b13e321\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/definitionFanoutAppMount.js\":\"34164d0a72770b24\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/dialogAppMount.js\":\"7deb923917f9b79e\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/dynamicExtensionSeeds.js\":\"4a2e66e7e59a8c2b\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/dynamicExtensions.js\":\"d7c492a819a66cae\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/exampleExtensions.js\":\"32e26663358e16c8\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/extensionApprovalStatus.js\":\"eab9223a456431c0\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/extensionLoadErrorToast.js\":\"ac587814ad1844a3\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/extensionLoadErrors.js\":\"03cc3db58f426866\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/extensionLookup.js\":\"cb2001d2d5ee13b0\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/extensionToggles.js\":\"70f8196883c3bda8\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/extensionUtilitiesCss.js\":\"03c86f3d4808b1db\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/kernelPageDeletionGuard.js\":\"9f26fd7baafce422\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/liveRuntime.js\":\"d322266dbd0b1ecb\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/openExtensionsSettings.js\":\"80be7f51a319fb5c\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/overridesCache.js\":\"db643cd7b0ff7c47\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/pluginIds.js\":\"89ffe1550780e3ef\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/processorRejectionToast.js\":\"78dafffc4e6a88db\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/runtimeActions.js\":\"e6b5279ff7d20f91\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/runtimeContext.js\":\"619430480f372aed\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/staticAppExtensions.js\":\"f1739fbad0a4c25d\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/staticDataExtensions.js\":\"c579096e8120f558\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/toastAppMount.js\":\"af71f64a26116727\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/useOverrides.js\":\"ad96cc3fcb81e137\",\"/knowledge-medium/pr-preview/pr-1810/src/extensions/useShortcutSurfaceActivations.js\":\"89da1bd568815adf\",\"/knowledge-medium/pr-preview/pr-1810/src/facets/discoverToggleTree.js\":\"d0ab5ddb5f5e77fc\",\"/knowledge-medium/pr-preview/pr-1810/src/facets/facet.js\":\"aca53befc1678bc7\",\"/knowledge-medium/pr-preview/pr-1810/src/facets/resolveAppRuntime.js\":\"179924cae72efac3\",\"/knowledge-medium/pr-preview/pr-1810/src/facets/runtimeEvents.js\":\"2616009047353fd1\",\"/knowledge-medium/pr-preview/pr-1810/src/facets/togglable.js\":\"e467c3108d0da03b\",\"/knowledge-medium/pr-preview/pr-1810/src/facets/variantFacet.js\":\"3f78a8af885458d6\",\"/knowledge-medium/pr-preview/pr-1810/src/facets/verbFacet.js\":\"22a00444993dd028\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/block.js\":\"df94690eb793ddc8\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/focusedChild.js\":\"82121133636f0718\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/propertySchemas.js\":\"8c9801e8fe7494b8\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/typeRegistry.js\":\"009b010cde064f0c\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useAncestorCrumbs.js\":\"2556579af0ea00fb\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useAutocompleteListbox.js\":\"82e466fe1f097395\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useDebouncedSearch.js\":\"cdc19f376bb3e9d4\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useDebouncedValue.js\":\"28cf00381759323b\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useIsFocalRender.js\":\"056e5cf5660e0b7a\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useIsReadOnly.js\":\"f679a7481d7c322f\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useMaterializeBacklog.js\":\"71f1576d6ec81bb9\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useMinuteClock.js\":\"ddbd98cc93e20b74\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/usePanelLayoutProjection.js\":\"849455268dcca58d\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/usePendingInvitations.js\":\"53144facd5921dec\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useRendererRegistry.js\":\"b26f160a2483285a\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useRetainedFieldRows.js\":\"e25577f388b75f43\",\"/knowledge-medium/pr-preview/pr-1810/src/hooks/useWorkspaces.js\":\"46b5f75e565dd345\",\"/knowledge-medium/pr-preview/pr-1810/src/lib/utils.js\":\"1f4fdf4fe09da477\",\"/knowledge-medium/pr-preview/pr-1810/src/main.js\":\"3fe30c57c11fedda\",\"/knowledge-medium/pr-preview/pr-1810/src/markdown/MarkdownImage.js\":\"2135b85c4c28b1a6\",\"/knowledge-medium/pr-preview/pr-1810/src/markdown/blockSeparators.js\":\"03c9d566cb6b197a\",\"/knowledge-medium/pr-preview/pr-1810/src/markdown/context.js\":\"d8933409e7bc0f32\",\"/knowledge-medium/pr-preview/pr-1810/src/markdown/defaultMarkdownExtension.js\":\"66ede96b6adbee8a\",\"/knowledge-medium/pr-preview/pr-1810/src/markdown/extensions.js\":\"e8e63a76dbee0c01\",\"/knowledge-medium/pr-preview/pr-1810/src/markdown/renderMarkdownHtml.js\":\"8235578db540982c\",\"/knowledge-medium/pr-preview/pr-1810/src/minimal-editor.js\":\"90393ffffb1bb739\",\"/knowledge-medium/pr-preview/pr-1810/src/paste/armedCut.js\":\"a82d39b5d4310a87\",\"/knowledge-medium/pr-preview/pr-1810/src/paste/captureMediaVerb.js\":\"226ae21c019a6b68\",\"/knowledge-medium/pr-preview/pr-1810/src/paste/clipboard.js\":\"7e332de60bbb47f4\",\"/knowledge-medium/pr-preview/pr-1810/src/paste/decision.js\":\"d47c2bea2a0ebeac\",\"/knowledge-medium/pr-preview/pr-1810/src/paste/operations.js\":\"ade6a2bd90515a65\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/account-header/AccountHeaderItem.js\":\"26f677377d45277e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/account-header/index.js\":\"9dabf66fc6dd3ec2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b5b509e6ba4e66b9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-dispatch-companion/askAgent.js\":\"c0f8a5dd8d7a40a7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-dispatch-companion/askedStore.js\":\"7e100a5c7652b49a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b4d13f4e8ba0bdda\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-dispatch-companion/chipState.js\":\"1c209a99667cb0ec\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-dispatch-companion/dataExtension.js\":\"18cde6f4eeeffdbd\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-dispatch-companion/index.js\":\"3ef11657e2c773fb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"735b0d10db8f6d0b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-dispatch-companion/schema.js\":\"7f549b92081e2857\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2383eebd4277eca7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/BridgePairingDialog.js\":\"80009f5d67bc8471\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/addMedia.js\":\"f86f72b263219d07\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0383a3cb78994b60\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/block.js\":\"20ef30ea9e62b6c3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/context.js\":\"5bab9709236ec74f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/displayIds.js\":\"04e39528c8bf90bf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/index.js\":\"478add7d406387e2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/outline.js\":\"f18ef176dcb6aa52\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/properties.js\":\"f0a18604d7a0750c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/refs.js\":\"88cd5a6986e9c3c4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"be8b14232158b241\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/search.js\":\"9c1f9ab815f0f9bf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/shared.js\":\"fccd3e1219bf8814\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1bdebcb37c2cc778\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentViews/text.js\":\"b3cf7bd0f5a6a3c9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/agentWrites.js\":\"ae1651cb4029f23c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/authoringCatalog.js\":\"0923ade09ecfec53\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/blockRefTargets.js\":\"f2329693fafd8762\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/bridge.js\":\"3c645d7097bdf2a1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/bridgeLoop.js\":\"bf8ce387f7db05d0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/changeHistory.js\":\"3c48277633543085\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/commands.js\":\"704911ab0526c41e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/commentsCommands.js\":\"2ed1e1dd632dbdab\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/dataExtension.js\":\"e4ab889a0bcd8c53\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/dataModelGuide.js\":\"e1e0f6ec9ab724f5\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/describeRuntime.js\":\"cf4f77c4131a226d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/extensionLint.js\":\"df1de80ce2c75606\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/grainAudit.js\":\"0ec56c4b8786907d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/healthCommand.js\":\"3696859b4c0570be\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/index.js\":\"88974f78a99456ec\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/presetIdentity.js\":\"ae2663d17dbfffdc\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"abdc7f84d8fbbdd0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/readMedia.js\":\"caf27ae1f3532a08\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/schema.js\":\"fb45615b214d7394\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/serialization.js\":\"12c077a63b0cea66\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/targets.js\":\"ab97fd6bb683b26d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/tokens.js\":\"3512a013dc8cb040\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/watchEvents.js\":\"e71602efbb581806\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/workspaceGuard.js\":\"8c39c9c33d4657e3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/agent-runtime/writeCommands.js\":\"e8c91ce9a77a10dc\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/alias/AliasCollisionToast.js\":\"f160dff7f48c0d17\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/alias/DuplicateNameBanner.js\":\"57b93f7d2234c843\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/alias/collisionMerge.js\":\"f746462ceca09192\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/alias/dataExtension.js\":\"223250647254303e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/alias/index.js\":\"0ab486c9aa98c77a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/alias/mergeCollisionAction.js\":\"69a1710c12b9120f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/alias/pageStyling.js\":\"94599d0a8e18d7e1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/alias/rejectionToast.js\":\"de50147d4af324cf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/alias/syncProcessor.js\":\"cd0c95393d2d8268\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/actions.js\":\"c21a6804f4feafa7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/addComment.js\":\"a16c86ece7d832d7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/anchor.js\":\"c78e887cb98e9c2f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/anchorState.js\":\"d8c33ff8c5d9070d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/commentLinks.js\":\"532ff11d6dd63f37\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/confirmThreadDeletion.js\":\"d60c79610450e7bf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/container.js\":\"425921caa3be9da7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/dataExtension.js\":\"7da83b9a094aa74d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/deleteComment.js\":\"9d76a95c4442c8a7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/highlights.js\":\"dad44c9c98604e66\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/index.js\":\"29e01432df719745\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/linkedCommentsPill.js\":\"24edebb80fe7872e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/margin.js\":\"79e5e51b12727268\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/marginSchema.js\":\"c8514f6f20767c6f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/newComment.js\":\"791a3c4cc8261cbf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/ownThreadPicker.js\":\"db5a24824ee17ea7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/placement.js\":\"4092748cc695f790\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/queries.js\":\"76f8ea0b27764981\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/quotePosition.js\":\"84e7f0e692b7eeee\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/quotedIn.js\":\"db2468048367dd8e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/quotedRange.js\":\"4e39d8492911a340\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/rangeRefs.js\":\"5bad4d0238cc9301\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/readHighlights.js\":\"5c3dab6566ef4cf6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/readSelection.js\":\"74c51dd43004eb91\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/readSelectionUi.js\":\"ac6b57cd6c17c735\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/reanchor.js\":\"f500f51e2dcc5bb5\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/schema.js\":\"e6354d8ca387ad7b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/scope.js\":\"71a066fd775c8c0f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/scopeThreads.js\":\"550505576b15aaac\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/splitRetarget.js\":\"c68e3b1cbdc39cea\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/suggestionCard.js\":\"bb831196722173b6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/suggestions.js\":\"7c840fd068d2ddf7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/summaries.js\":\"95c3983170a58b12\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/summaryBatch.js\":\"66908e3f34ab07fa\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/surface.js\":\"58ff5cd51e73186e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/threadNavigation.js\":\"379f66a4479a494a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/threads.js\":\"adb9015b26a02666\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/ui.js\":\"9d25001e4b95100e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/annotations/uiStore.js\":\"2c7faefd5e0cb981\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/app-intents/appIntents.js\":\"5281f634bd613172\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/app-intents/index.js\":\"cf80b0d71174ac01\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/app-update-prompt/index.js\":\"24c170f9e451ab66\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/app-update-prompt/status.js\":\"a144c0c7966d3420\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"72d0472c891827a3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/MediaBlockRenderer.js\":\"e979395f70e34880\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7c834d9ac5fa30e0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/MediaUploadReconciler.js\":\"fe5ad4c4010dcadc\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/assetDownLane.js\":\"0b96c0242ebb14a9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/assetResolver.js\":\"1e3c1395db3305bd\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/assetUpload.js\":\"752a74bca60a31d9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/attachmentCleanerIO.js\":\"de131efe5692d2ae\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/audit/supabaseAuditIO.js\":\"9f3bb8c921f697ec\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/blobStore.js\":\"a857deebff3bfb69\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/byteStore.js\":\"4cfc0306287ea084\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/cleanerIO.js\":\"81dfae77c2009711\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/cleanupAttachments.js\":\"2f896a6c37d8aebb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/dataExtension.js\":\"18c64109df5e0aaa\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/downLane.js\":\"9049914989841d77\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/index.js\":\"d527a06a2fb8d2f6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/insertImageContribution.js\":\"5763e43b4f6dfdbe\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/laneArming.js\":\"cb9d8f6e020bfd20\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/laneLock.js\":\"bd5d608e844e307c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/mediaBlock.js\":\"407513bd0fb4136a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/mediaCapture.js\":\"514f3eac4a202830\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/mediaViewers.js\":\"5ddc1b6c3a870e84\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/mediaViewersFacet.js\":\"7c796b5661a747ab\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/pasteCapture.js\":\"42bb413b09c99d49\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/resolver.js\":\"a84697d13367b8f5\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/retryUploadsAction.js\":\"c379381072cb3281\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/storagePaths.js\":\"da4d243153e08b3e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/uploadDrain.js\":\"16bdb033d944dfef\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/uploadLaneStatus.js\":\"2714ed01eeddb94d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/uploadReconcile.js\":\"cbb557a3e79b5122\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/uploadRecovery.js\":\"3fc299d4adee395d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/uploadStore.js\":\"14b12e7386b303c6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/attachments/useAssetObjectUrl.js\":\"1f57f9b6002d813a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"60206ca6f253e3ee\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks-view/BacklinksViewSection.js\":\"32261a043f3bf231\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks-view/facet.js\":\"039738fcc7413bfb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks-view/index.js\":\"897d9356b3b308be\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks-view/prop.js\":\"d514266003509db3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/BacklinkFilters.js\":\"3c89c78af89a9555\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"92b62fcd7adb66de\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/BlockEntry.js\":\"14890b1184ea80ff\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/LinkedReferences.js\":\"a59a095565ba21cf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"437703865d57da48\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/dailyNoteDefaults.js\":\"ff16e96aee1fc45a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/dataExtension.js\":\"2a3265b4de7a98c2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/edgeExclusions.js\":\"33c466fe5f51ad29\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/filterProperty.js\":\"0790a074df112cfe\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/index.js\":\"7a373df9236af31e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"18531d5eca4eafb4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/inline-counts/applies.js\":\"5b8cb4a7412f105e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/inline-counts/countQuery.js\":\"b103bca41401614d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/inline-counts/expansionStore.js\":\"27d2874fc51f5847\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/inline-counts/index.js\":\"73a19069d73fe00b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"221ed631d5a2a212\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/presentationInvalidation.js\":\"de7fb2e222e1b049\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/propertyEditorOverride.js\":\"be30f11acdcca3a6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/propertyFilter.js\":\"c02ebace848efff9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/query.js\":\"70a8de7345e049b3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/resolveFilter.js\":\"9c35fd80a8492fb9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/sourceBatch.js\":\"7ccfc35546b0b1ba\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/sources.js\":\"49adf386a2abe227\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/useBacklinks.js\":\"c59172058c40bd28\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b8be8a7ca5803e39\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/birthday/BirthdayCelebration.js\":\"c246a3259e8b91c8\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/birthday/BirthdayOverlay.js\":\"4872a446d11c3ea2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/birthday/gate.js\":\"ea3b821a60f54087\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/birthday/index.js\":\"7bf57da08221068b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/birthday/wolfTheme.js\":\"a50420dd33c194c5\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-drag/BlockDragLayer.js\":\"5703daf56b854805\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-drag/dragController.js\":\"cf32acf7028aa479\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-drag/dropTarget.js\":\"10bc06ca3c47c240\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-drag/index.js\":\"d34dd8447b68f4c9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-drag/projection.js\":\"c1925119fc069fc5\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-info/BlockMetaCard.js\":\"79257074b4a9ddcb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-info/index.js\":\"91c0c931402ad258\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-tagging/AddTagDialog.js\":\"e59b120fb64e481f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"bf40284597bae5ea\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-tagging/TagNameIssueHint.js\":\"5219600676c87553\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-tagging/addTagAction.js\":\"ec1be34b9452f518\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-tagging/appendTag.js\":\"907310a70f017ede\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-tagging/config.js\":\"16e4815f5ef2a5eb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-tagging/dataExtension.js\":\"a08732894c08e8d4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-tagging/index.js\":\"3c9f47ded74b657e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/block-tagging/propertyEditorOverride.js\":\"954117a2e621c73a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ff93fd6a73804aa0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a9adf871b60af4ce\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3c2ee12f09f6a41e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"985347de813d0756\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d0f57e04d000d75b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/breadcrumbs/index.js\":\"c98c8a0a8d61bef6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7df518d684f8e85c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/CharacterCountItem.js\":\"e923b59abeb090ea\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/ProfilePropertyEditor.js\":\"8dfba06cacb9e24c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/actions.js\":\"223fe38f00973873\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/blockType.js\":\"9501e25efaf07c60\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/charCount.js\":\"60faa939f42e5c0f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/dataExtension.js\":\"615f9e948320bfd1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/index.js\":\"6c62082f02a8ce5f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/profiles.js\":\"5aea584720a546d4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/properties.js\":\"ac5e0fd3d3a1dbab\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/character-counter/textCounts.js\":\"25e322fcc8f6c08b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/colemak-keybindings/index.js\":\"1d123fc42f42738c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/command-palette/CommandPalette.js\":\"cf3881d09ab24fb4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/command-palette/HeaderItem.js\":\"f5fed5b43f433c1b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/command-palette/context.js\":\"55fa7bdbc63091c6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/command-palette/index.js\":\"5b039ea3b856a896\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/command-palette/selection.js\":\"7d77342fbcf239b9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/command-palette/toggleStore.js\":\"deb98504536251ca\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/command-palette/useCommandPaletteActions.js\":\"f1549ecc6d78809f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/ContributorBadges.js\":\"99ff05dd2be16227\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/author.js\":\"13bc1be201438ea6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/codeMirrorExtensions.js\":\"2b6e51569367c275\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/dataExtension.js\":\"c0b64e9cd4dda426\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/index.js\":\"29a06517a151d7a1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/mentionAutocomplete.js\":\"10fe92b794f93bde\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/processor.js\":\"0f33d438ce2e4ce1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/profiles.js\":\"89976ea9e2d040a3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/queries.js\":\"16ca872543ea7c7a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/contributors/schema.js\":\"9e8d171b5ed77bb7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4bfc5fec9c6e04d9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7272eaff8e37fcd7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/cursor-follows-scroll/index.js\":\"457a8258323b4261\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a2b49867024196b0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"cc1d08e20666a08e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/CalendarGrid.js\":\"1ebf17da2a9933d3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/DailyNotePicker.js\":\"0373664490fd43b9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"fbe77a13a5d1a2e9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/DateNavDecorator.js\":\"fabe08662340ef40\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/DateScrubOverlay.js\":\"5c472fd074da36cd\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/HeaderItem.js\":\"24b793263bd0bea3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/ReschedulePicker.js\":\"26f82713d1442756\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/SpreadDatesDialog.js\":\"3b76998e382d3b20\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/actions.js\":\"eeb3499a88a8fe08\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/blockDateAdapter.js\":\"864fc04c23353cbe\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/calendar.js\":\"b11510d93fede87b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/dailyNotes.js\":\"71e694887000ab0e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/dataExtension.js\":\"5fa31bcf309361b3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/dateScrubActions.js\":\"c6fcaff62b4c4be8\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/dateScrubGesture.js\":\"f2378d310dede202\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5584dfce32cff133\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b75c57e047c84d8b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/deletionGuard.js\":\"da7f025523ad3186\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/dueQuery.js\":\"c542e471840da5dc\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/index.js\":\"86e8f9c4164c2aa2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/landing.js\":\"76a71e4b6847ca70\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/localSchema.js\":\"d2eab0c024380ab3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/referenceDateAdapter.js\":\"ddc844a48aed1105\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/rescheduleAction.js\":\"4d269d9973203a1e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/schema.js\":\"0c07d9b81904e2fd\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/spreadBlockDates.js\":\"4e63072ed868eeb0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/spreadDatesAction.js\":\"42b9a18b989a695b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/today.js\":\"32f2c8977fbd6a83\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"30a70caed2f82695\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1d8a5ae9b76db1e9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/audit.js\":\"65bc901a96b80092\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/auditAction.js\":\"236da83dd9659044\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/auditRanges.js\":\"095dbf0f54e52a13\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/diagnosticsSource.js\":\"a9c7bbe87caecf8e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/divergenceScan.js\":\"644300d806b66658\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/index.js\":\"5381587a5bfe22f3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8183e434223ef930\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/referencesMirror.js\":\"20b4ca5540433f72\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/rowJson.js\":\"390ef43e74698bcf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/schedule.js\":\"30e42ed5cf96f27e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/data-integrity/store.js\":\"f3380ede2035cba1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-maintenance/action.js\":\"4cb4b35dd5ac9d41\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-maintenance/index.js\":\"b8a089063017b8f5\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-maintenance/plugin.js\":\"2d28523b57358565\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c4897ca070dbac6d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/actions.js\":\"b3ccd05d97b1a549\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/changeMarker.js\":\"372b8c444f7056ad\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/diagnostics.js\":\"8c341a173841c31c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/fileSystemAccess.js\":\"621f69203df992ad\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/filenames.js\":\"ac477703c481332c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/index.js\":\"535e8d99d9feea4e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/mirror.js\":\"bf30ea84c0f2507a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/runLock.js\":\"50f48a881b10151d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/runtimeHealth.js\":\"ea585928ee424b8d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/schedule.js\":\"67cddade4bf32954\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/db-mirror/store.js\":\"407ddac517c201df\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/default-themes/index.js\":\"9e1966727604427f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/default-themes/themes.js\":\"dc11c653df5e6816\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/diagnostics/facet.js\":\"4e595a19ddc91bbe\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/diagnostics/useDiagnostics.js\":\"d03af6682b1fde51\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extension-prompts/dismissals.js\":\"7af34800829cc117\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extension-prompts/index.js\":\"3eb0a881a312ad1c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extension-prompts/status.js\":\"6e4b43d358729cca\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extension-prompts/store.js\":\"1ddb4341afb763e7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ea5c67d606d7d201\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extensions-settings/ExtensionsSettings.js\":\"50433a561164a027\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extensions-settings/actions.js\":\"ea1c2dad724cd849\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extensions-settings/config.js\":\"73160cad7cdbddb3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extensions-settings/dataExtension.js\":\"8d14d09fc8f4166e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extensions-settings/effect.js\":\"44888cc37dc2ce04\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extensions-settings/index.js\":\"20ad7143c5564362\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8bedbaeed467649d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extensions-settings/useToggleTree.js\":\"87318600d60879e3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extract-type/ExtractTypeDialog.js\":\"c6ace476397c4bae\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"cd877e13c560dc8f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extract-type/PropertyShapePicker.js\":\"45a933353a9266b1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extract-type/action.js\":\"4a749e1d981c1780\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/extract-type/index.js\":\"3e3884b37ba7c92e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/find-replace/FindReplaceDialog.js\":\"19cc0f54ef58af1b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/find-replace/HeaderItem.js\":\"821d8b94c2c40537\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/find-replace/dataExtension.js\":\"4b32bcc6ea29ad5a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/find-replace/index.js\":\"a84fe3f31d803820\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/find-replace/search.js\":\"3e3f1ce7a13bb69d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/find-replace/toggleStore.js\":\"2ca34800f65777f9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/LocationPropertyEditor.js\":\"7339b72c1a57972b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/MapView.js\":\"5353abef5f64d83f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/blockTypes.js\":\"f92866bbe3d1adea\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/codeMirrorExtensions.js\":\"3ff72a28b14d84cd\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/createOrFindPlace.js\":\"d94eef4f9782fdeb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/currentLocation.js\":\"d9258affabee8ab6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/dataExtension.js\":\"e4fb342235b17e77\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/geoContentDecorator.js\":\"27a7962f3b626337\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/googlePlacesClient.js\":\"00837402057d8fb2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/index.js\":\"8ad3d3eaea5f8886\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/locationsPage.js\":\"8aa402b18c2adfb7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/mapViewport.js\":\"836e235f87caebf1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/pickCurrentLocation.js\":\"91b10673b42e4ecb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/placeAutocomplete.js\":\"a5ea65b57c6aa9da\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/placeNameCollision.js\":\"62d2d1d19f39e797\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/properties.js\":\"37ce46d637d773db\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/propertyEditorOverrides.js\":\"ec1e1f3b0bba8cbf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/query.js\":\"ef1f64c90e9f1024\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/geo/usePlaceSearch.js\":\"698b12323ed8b413\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9b53683758d40006\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a3bd6064f59de52f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a471a7fbaf1e0554\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/config.js\":\"c6e1a360d1ce70e9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/dataExtension.js\":\"5f14797ea3cd2603\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/facet.js\":\"fc84433f1d53cfd1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/grouping.js\":\"1ad7c8c942090a27\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/index.js\":\"220453f2706ba184\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"94d6e6eda15b8ca4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/query.js\":\"69a6eb647283b980\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/resolveConfig.js\":\"de00556a462bbc9d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7d9d85fb00964112\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"04931ff4f4f8a32d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/HtmlDocumentContent.js\":\"3eedd0994fed0573\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/HtmlFrame.js\":\"f727fd96e8a80ca2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/actions.js\":\"236308ae388343e4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/blockType.js\":\"05330dd79aa7751e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/confirmRunScripts.js\":\"000a44afb8c3ccd3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/dataExtension.js\":\"8ff865cdfd80a4f9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/frameAnnotations.js\":\"888094515bb74b6c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/frameDocument.js\":\"3324cdf432ef3fdd\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/frameTheme.js\":\"f2d832fc97268425\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/index.js\":\"c0a07ea834d35313\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/scriptConsent.js\":\"0fc0d5592dbdfe10\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/sourceMap.js\":\"8a204312230313af\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/html-document/useDocumentScripts.js\":\"d857bdcad3c92ba9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/interaction-metrics/index.js\":\"e5de9ea9dc10ce75\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/interaction-metrics/record.js\":\"85d631bc2676cbe2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/interaction-metrics/recordStore.js\":\"db52ea077579cfa0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/interaction-metrics/responsiveness.js\":\"1ed809f75bbc705b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/interaction-metrics/schedule.js\":\"aef5c7a9db827f67\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/interaction-metrics/sessionContext.js\":\"5252e311150a7475\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"558d46a6fbe609f2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"82bca3c354f2d41d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/actions.js\":\"8d73af1b36a76c05\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/config.js\":\"b3b58eff07a5f1fb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/dataExtension.js\":\"6b4601f9b413d02f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/effect.js\":\"4ca99b773d4553de\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/index.js\":\"6396fcbb548e26f2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/keyCapture.js\":\"669e22f0d2c630d7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/overrideStore.js\":\"475b7b3d520d55da\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bd6042663ab75ae6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/left-sidebar/HeaderItem.js\":\"93ceb31d59e33a82\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/left-sidebar/LeftSidebar.js\":\"94034c332604df9f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/left-sidebar/actions.js\":\"139d3faf383b6250\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/left-sidebar/facet.js\":\"a28cfd3357361e95\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/left-sidebar/index.js\":\"36398ba09c7b3b2d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/left-sidebar/shortcuts.js\":\"25d4a4c44ad1acbc\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/left-sidebar/toggleStore.js\":\"2d947577e2549efa\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/merge-blocks/MergePicker.js\":\"dfaa86d810aa9acf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/merge-blocks/index.js\":\"385418a53d6dab3f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/merge-blocks/mergeAction.js\":\"499ccc1fed406720\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/merge-blocks/strategy.js\":\"d9689319728e322a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-bottom-nav/Button.js\":\"f706f54fcf6e1c08\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"706b65ce9702497c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-bottom-nav/defaultItems.js\":\"67ccaacee33097f6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-bottom-nav/facet.js\":\"c3b615b68ecd083b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-bottom-nav/index.js\":\"2eddfa5d3e462977\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1113fb25f2638db3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-keyboard-toolbar/actions.js\":\"922b6697584e59b9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c8d5ea5a904fdbef\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-keyboard-toolbar/facet.js\":\"435000f7e4f38bee\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/mobile-keyboard-toolbar/index.js\":\"d8ae0384d45a8301\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e68bd55f836bd165\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c7a8f7591d9f9102\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/move-blocks/contextMenuItem.js\":\"22edbd81ef6d9ce9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/move-blocks/index.js\":\"2c3280d96940f70d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/move-blocks/moveAction.js\":\"f1bfeebc2dc781ed\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/move-blocks/moveBlocks.js\":\"8ac4bbe6c3f85156\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/move-blocks/selectionAfterMove.js\":\"e5ddda6827f7b2df\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/onboarding/TutorialBanner.js\":\"23be4388b4c3c711\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/onboarding/action.js\":\"6625695ed2100d5d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/onboarding/bannerDismissal.js\":\"25eee152e09a5023\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/onboarding/documents/cheatSheet.js\":\"b08d38dadff99008\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/onboarding/index.js\":\"358461525be1e948\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/onboarding/keys.js\":\"d9a405d51cd1eb3f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/onboarding/landing.js\":\"ad8f7e4c450455d2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/onboarding/outline.js\":\"7da5af96197bc5d9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/onboarding/seed.js\":\"ed3e5860c03bbfb8\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/PerfTrendDialog.js\":\"57cbd8a876ed9d60\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/analyze.js\":\"8a2d9208303b82bd\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/diagnosticsSource.js\":\"8bf2ba66cdd726f6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/index.js\":\"19ffa3dc36836ff7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/load.js\":\"a804eb799af4839b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/monitorRun.js\":\"3146cdd89476c8f6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/schedule.js\":\"2e17cee4a1f2a89c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/series.js\":\"4f86982966f98d7f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/store.js\":\"bcecf92713236300\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/trendAction.js\":\"88f160fbbcc12457\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/perf-monitor/verdict.js\":\"7dce509365371b6b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/plain-outliner/clickToEditAction.js\":\"b8e06feb91aad54f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/plain-outliner/index.js\":\"d0e8e8700d92632d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/plain-outliner/interactions.js\":\"49927096d0292be4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"05b6e8962af6cb1c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/properties-migration/MigrationGate.js\":\"abe1b38baecca436\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/properties-migration/MigrationGateDialog.js\":\"e3d9d93e342be7a1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/properties-migration/action.js\":\"4d51a2250541e6b2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/properties-migration/index.js\":\"f6445509eddba535\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/properties-migration/localRunMessage.js\":\"c3ffa70773ea91a9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/properties-migration/plugin.js\":\"05abf63dfdf78442\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/properties-migration/progressReport.js\":\"9d78844a3cd9061f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/properties-migration/sweepProgress.js\":\"b627121ad4bc76dc\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/property-rows/FieldRowRenderer.js\":\"de85bdb68605cfa9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/property-rows/ValueRowRenderer.js\":\"95eb2a90fad81d54\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/property-rows/actions.js\":\"c7dbcabfe98f9423\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/property-rows/autocomplete.js\":\"1b3e0df4e449886b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/property-rows/fieldRow.js\":\"ee5cab0d19acdbb2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/property-rows/index.js\":\"7b0cb6978e95a93f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/property-rows/referenceWarning.js\":\"3163462932b792bf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/property-rows/valueAutocomplete.js\":\"41b2ee9a785cd3b5\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/property-rows/valueSchema.js\":\"7a4cfa4148278dc0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/quick-find/HeaderItem.js\":\"3e337b6757538672\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/quick-find/QuickFind.js\":\"2ed33a85c940b96a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/quick-find/index.js\":\"e727a0d69af4eeb9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/quick-find/recents.js\":\"29d76335cec3c67f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/quick-find/resultItems.js\":\"b8ad28c6ec8c0561\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/quick-find/selection.js\":\"7c20a181882f358d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/quick-find/toggleStore.js\":\"cb8b91829f676b3d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/recents/HeaderItem.js\":\"a2d03cf3db939e55\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/recents/RecentsPageBlockRenderer.js\":\"3166b89a5f5dbffa\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/recents/grouping.js\":\"da583f0f42615307\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/recents/index.js\":\"9425eb5e221d3422\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/recents/target.js\":\"52fd02fe8e35f5d6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/codeMirrorExtensions.js\":\"44fa2ee00fa7b71a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/contentPrefill.js\":\"549b740f75ac370e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/dataExtension.js\":\"2fe9cb3ce79db566\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/index.js\":\"844e2f65342c8a8e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"6fc08ccf74aeb797\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/invalidation.js\":\"c6fc5a070ad8cf26\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/localSchema.js\":\"9d54c761678ed70a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/markdown/blockrefs/index.js\":\"74621cb461e8ae6a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"74d7c79598642908\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/markdown/index.js\":\"f876d847b337817d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/markdown/referenceNode.js\":\"dffd8169556582f4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/markdown/remark-reference-occurrences.js\":\"484153648a62b911\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f0f8a76ba107c6fb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/markdown/wikilinks/index.js\":\"ed4c08415722f671\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"adeddb7aaeb25549\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"9b71f706fda83a7a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/mergeRetargetProcessor.js\":\"b2443f9c94b88299\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/parseFence.js\":\"59e21b381fd812dc\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/referenceParser.js\":\"dd3d6df0a50d6054\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/referenceProjection.js\":\"d5ef1eb3cacb2862\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/referencesProcessor.js\":\"5c7487e3d6af66ac\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/renameProcessor.js\":\"4e4baefa74ca032a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/references/spanReplacement.js\":\"28f1210be410b513\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/rich-paste/htmlToOutline.js\":\"d2a3bc844f3d64bf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/rich-paste/index.js\":\"656714e09541198b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/rich-paste/normalizeClipboardDom.js\":\"db99d8854c0de703\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/rich-paste/pasteDecision.js\":\"39c256dfc74270a8\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/action.js\":\"da92d44368d5f4d9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/blockIds.js\":\"e24310d5b52aa062\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/content.js\":\"1518338790df667e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/effect.js\":\"b309e1c783b99e36\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/ids.js\":\"7f3aa13b0b998b78\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/import.js\":\"3a42192013d0d895\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/index.js\":\"90fc1435015b965f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/plan.js\":\"59844a090aac2bb4\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/plugin.js\":\"e676dbde6548d13e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/promotion.js\":\"159ba44c0b4e1106\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/properties.js\":\"1a1558b6e201ea0e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/references.js\":\"fb1e0abc8958e000\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/report.js\":\"efb7eae350f34b63\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/roamMemo.js\":\"8ab55328dd732c47\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/runtime.js\":\"92f5e5acd43b0b0a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/schemaReconciliation.js\":\"a16fdbbfa1b10c82\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/srsMarkers.js\":\"cb4ea5f236bfd01c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/todo.js\":\"c0d9982900492efd\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/typeCandidates.js\":\"64844d362dd73388\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/roam-import/types.js\":\"2472cd42e8ba5baa\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/search-health/index.js\":\"1a4af78590d54180\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/search-health/store.js\":\"9df5e10342583963\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/shortcut-help/HeaderItem.js\":\"ae48061d01fb84d7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"cd670a9e3db8e9ac\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/shortcut-help/index.js\":\"ff74902369f5e227\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/shortcut-help/model.js\":\"d3441f8faf2488c7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/shortcut-help/toggleStore.js\":\"40ca1b2475dac83b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/shortcut-help/useKeyInspector.js\":\"1ef9ada5d5880531\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d976d5961f9e178d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/spatial-navigation/ShellDecorator.js\":\"9e7a049cddd4cd1f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/spatial-navigation/actions.js\":\"ef213dcf99b2dffe\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/spatial-navigation/exclusionsFacet.js\":\"171bd9ede36afe24\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/spatial-navigation/index.js\":\"dada91487b919490\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/spatial-navigation/shell.js\":\"3967b7674a61f48a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/spatial-navigation/surface.js\":\"8ccdb897669611ef\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/spatial-navigation/walker.js\":\"7dfe0331d6c1998d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/RescheduleToast.js\":\"57d28bbc6ed991b3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/dataExtension.js\":\"2dfe538add8fe79f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/index.js\":\"920742902577fd43\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/indicator.js\":\"7788660b5144f203\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/moveSrsState.js\":\"3113cdfb9937b2ae\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bab5f9914fa9dcde\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/scheduler.js\":\"fa62da5a7495d66e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/schema.js\":\"6fe224c2440d773d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"22681ed62913134e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/srsClipboard.js\":\"9554c3beb16077ad\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"50afe9729c7bbaa3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/DailyNoteReviewHint.js\":\"86e716b9b3ae97bf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/DeckPicker.js\":\"29c07e74b8643180\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/ReviewControls.js\":\"af38126d7de0d0d7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/ReviewDeckRenderer.js\":\"04b5aaef83a9824a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/ReviewSession.js\":\"53733eade659f707\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/actions.js\":\"a190d64e0ba155f5\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/archive.js\":\"cf052421ef5401a3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/dataExtension.js\":\"2f0892927e13b8c2\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/deck.js\":\"be6d9f62d9958b06\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/dueQuery.js\":\"5d238127847e17e7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/gradeDecision.js\":\"1095a472c614c817\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/index.js\":\"c0b5894f76b3eb25\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/keyHints.js\":\"0f1d780a980f00d5\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/reviewCardLayout.js\":\"1e45f985dde5cb6e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/reviewProgress.js\":\"5bc30474e4f9a2b1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/schema.js\":\"73d40311e17c9df1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/srs-review/useDueCards.js\":\"4dddcf00444744de\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/startup-metrics/index.js\":\"398b739f10f495ea\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/startup-metrics/record.js\":\"dfb8fb9cb584e172\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/storage-persistence/index.js\":\"068dbb34cbf75ca7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/storage-persistence/persistenceStatus.js\":\"e7e454af0844c1c3\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/storage-persistence/requestAction.js\":\"4e5cd3e8a9879016\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/supertags/TypeChipsDecorator.js\":\"bc3c54cffaa26085\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/supertags/codeMirrorExtensions.js\":\"c1fbd46c923ff66d\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/supertags/index.js\":\"c959de353b63aee7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/supertags/typeAutocomplete.js\":\"541eff7a86e255c1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"137c44f89f5fbbed\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/swipe-quick-actions/actions.js\":\"491bdebf7f42d065\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/swipe-quick-actions/anchor.js\":\"0048fac4d002ea12\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/swipe-quick-actions/events.js\":\"4911d04a8a58935f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/swipe-quick-actions/gestureActions.js\":\"8347d26276bcd449\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/swipe-quick-actions/index.js\":\"51c14cb37051709c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9145a4ca4d7cc7a9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/sync-metrics/collect.js\":\"aeb46e23bdb00042\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/sync-metrics/index.js\":\"bd4c625ec872a0f1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/sync-metrics/record.js\":\"775f5add83e9ee71\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/system-status/RejectionDialog.js\":\"8f7ccac3a52940aa\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c235a5cf7df1a917\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/system-status/index.js\":\"0b939e464c4b75d6\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/system-status/model.js\":\"0df6bed1bde344f1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/system-status/queueCounts.js\":\"b94fac57b68747a0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/system-status/rejectedHelpers.js\":\"a180650f3e975b8a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/system-status/rematerializeAction.js\":\"09505b7eafa9126f\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/system-status/useHysteresis.js\":\"ac4f64308cf03e07\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/theme-toggle/effect.js\":\"8b2d6c37bface53a\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/theme-toggle/index.js\":\"64896542ac29f545\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/theme-toggle/theme.js\":\"825cc94d60f229bc\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/todo/actions.js\":\"d12f5a27e17b8dac\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/todo/dataExtension.js\":\"e3026cc610acb623\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/todo/index.js\":\"06b61b6eb61596d1\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/todo/schema.js\":\"2dc3d83b3da7f5eb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/touch-selection/TouchSelectionLayer.js\":\"84102a7abade99b0\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/touch-selection/actions.js\":\"015b2104e079871c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/touch-selection/defaultItems.js\":\"ebf19ac7e656d63e\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/touch-selection/facet.js\":\"5e78b2878ae6f984\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/touch-selection/holdRecognizer.js\":\"df1d5bc3db285abf\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/touch-selection/index.js\":\"02ed5b37382f4ebb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/update-indicator/UpdateIndicator.js\":\"e2ef86b719474907\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/update-indicator/index.js\":\"75f1c057765b2fae\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/update-indicator/loadTimes.js\":\"86660cb531377815\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/VideoNotesRenderer.js\":\"82573b4ab9c75cd9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/VideoPlayerRenderer.js\":\"8c7bb5ec5296b9a7\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/VideoTimeStamp.js\":\"92a12dfc685dfceb\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/actions.js\":\"dc9bd59a2f0661e9\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/index.js\":\"788721a75aa08c80\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/markdown.js\":\"b4ca4e151ed724dd\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/notes.js\":\"b2f6ce2cabccc21b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/registry.js\":\"5b3718c327999b09\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/remark-timestamps.js\":\"87780eae6b8c6382\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/video-player/view.js\":\"7cfde99e24be68ae\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/vim-link-hints/LinkHints.js\":\"7467b9a874854adc\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/vim-link-hints/index.js\":\"d4a994cd14696dc8\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/vim-link-hints/model.js\":\"4c91b91f24ad1277\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/vim-link-hints/settings.js\":\"1b8637032a1f205b\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/vim-normal-mode/actions.js\":\"45f73b65d1398b5c\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/vim-normal-mode/index.js\":\"ac37acb965028b50\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/vim-normal-mode/interactions.js\":\"1747a9dce3d91fac\",\"/knowledge-medium/pr-preview/pr-1810/src/plugins/workspace-header/index.js\":\"e23cc6066bd50e8d\",\"/knowledge-medium/pr-preview/pr-1810/src/registerServiceWorker.js\":\"656bfb6e7afe2d02\",\"/knowledge-medium/pr-preview/pr-1810/src/requestPersistentStorage.js\":\"1960a7b72088d487\",\"/knowledge-medium/pr-preview/pr-1810/src/services/authRequestDeadline.js\":\"2c4fad05c4c61923\",\"/knowledge-medium/pr-preview/pr-1810/src/services/authStorage.js\":\"700d9e76b2395e15\",\"/knowledge-medium/pr-preview/pr-1810/src/services/powersync.js\":\"da3a6d7f168a2644\",\"/knowledge-medium/pr-preview/pr-1810/src/services/supabase.js\":\"32d0adceaf7e017d\",\"/knowledge-medium/pr-preview/pr-1810/src/services/uploadErrorClassifier.js\":\"e3e41eaef332b5f8\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/ActiveContexts.js\":\"76f5c70108e11f09\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/HotkeyReconciler.js\":\"2d14941bb2cce94f\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/WipeLocalDataDialog.js\":\"35acb0362de50e06\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/actionDispatch.js\":\"b52a534c5bb97708\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/actionRefItems.js\":\"85fcec50cb96ad9b\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/applyKeybindingOverrides.js\":\"fdda61ba3b99566c\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/blockActions.js\":\"85e26782cc05a2a4\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/canonicalizeChord.js\":\"fbef03d645b8c6cb\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/defaultContexts.js\":\"4e09c2ee7742688e\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/defaultShortcuts.js\":\"e4b073ab8863cc04\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/effectiveActions.js\":\"67c0cbfe9d6dedb5\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/gestureAction.js\":\"cf0b713d5d6fd484\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/gestureBinding.js\":\"37c7d746a9bcbe48\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/holdRegistry.js\":\"eef27f39bc635411\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/keybindingConflicts.js\":\"f4e5d98c4792cef0\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/keybindingOverrides.js\":\"4b392b260ff2bea3\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/pointerAction.js\":\"e06756f0ccf03f13\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/resolve.js\":\"0aa239ba57bb6743\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/runAction.js\":\"46bec3ac1a322fd1\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/sequenceMatcher.js\":\"2754e3e912e6b760\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/types.js\":\"41b674d2e46e19d1\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/useActionContext.js\":\"b13b88bb06d66e4b\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/useActionDiscovery.js\":\"435d50908b279295\",\"/knowledge-medium/pr-preview/pr-1810/src/shortcuts/utils.js\":\"e2cb99fbadcd7190\",\"/knowledge-medium/pr-preview/pr-1810/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1810/src/sw/bootStore.js\":\"c8cd08e4e100c189\",\"/knowledge-medium/pr-preview/pr-1810/src/sw/previewDatabases.js\":\"79eb646391784aab\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/byteTransform.js\":\"314c634f98f6038b\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/attachmentCleaner.js\":\"b306df390ac4fbbc\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/bundle/attachmentParts.js\":\"6b816df972963891\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/bundle/bundleParts.js\":\"c07053defe61edd1\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/bundle/bundleRecord.js\":\"53d9bb2394ea08de\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/bundle/manifest.js\":\"7b9038a66e48347c\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/bundle/takeBundle.js\":\"ac56637fe6bc983f\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/bundle/verifyBundle.js\":\"d064cbae770c5a5c\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/cleaningStage.js\":\"b27cedac6e5cac4b\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/conversionKey.js\":\"50ad79bc30a013d0\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/conversionServer.js\":\"985b0192d27f81f4\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/flip.js\":\"3f4744a1426c22c3\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/flipAttempts.js\":\"d5a8594e66e15e39\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/pages.js\":\"55ffdb1a66bcdfb0\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/preflight.js\":\"3eacd92647a39d5a\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/reseal.js\":\"76d6544343422931\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/runConversion.js\":\"509ecc7a520cd246\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/runLock.js\":\"143c35844bf8c81c\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/sealing.js\":\"340a6375a029109f\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/sealingStage.js\":\"125e4f278fd2faa5\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/stage.js\":\"33f28c366e7357ca\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/conversion/verifyReseal.js\":\"fbb41c40161a7857\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/aad.js\":\"453f871fdcce4e9b\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/aead.js\":\"c15163edeb91065a\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/base32.js\":\"6e02d79850299333\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/base64url.js\":\"2ff14c19b0243ae7\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/binaryEnvelope.js\":\"2c4ecf234d79806f\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/byteAead.js\":\"1666116c40c6b848\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/canary.js\":\"1101febdf0d0bcd8\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/contentHash.js\":\"2b0c5de28973e03c\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/contentKey.js\":\"4a4ee5123a25070a\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/derivedIdNamespace.js\":\"86274ef06bcd4d20\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/envelope.js\":\"29a3eb202e3eeb4d\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/hex.js\":\"94b820e6d120e9c8\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/sha256Hex.js\":\"1657b1e6d1f886c4\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/crypto/workspaceKey.js\":\"0abee47215c049db\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/conversionState.js\":\"ddb32bb044ca5601\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d3a63bbf7f44e2d2\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/flows/pastedKey.js\":\"0d78fc289358d6e0\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c7797eae505b3c80\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f8d4caa859cff013\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/keyStore.js\":\"d75f530fbd4f4927\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/mintWorkspaceKey.js\":\"3cbe675ba184d71c\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/modePin.js\":\"902c58483ef1c114\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/openWorkspaceKeys.js\":\"4dc30c9d98e5e7a7\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/resolveWorkspaceEntry.js\":\"7603668110b881c7\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/resolver.js\":\"498b8fd41609f533\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/keys/workspaceAccess.js\":\"1ee28355aecf9a02\",\"/knowledge-medium/pr-preview/pr-1810/src/sync/transform.js\":\"65aaf3fb3bd80e70\",\"/knowledge-medium/pr-preview/pr-1810/src/themeBootDefaults.js\":\"7a5acd0e0df46e4b\",\"/knowledge-medium/pr-preview/pr-1810/src/types.js\":\"c9b221ff073374be\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/ClientLocalSettings.js\":\"f5a89e6a631b3a5a\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/abortableSleep.js\":\"a7df2b3f93b140a4\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/array.js\":\"4849d6f46b7dd088\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/backlinkAutocomplete.js\":\"b7c122430f304dca\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/blockCrumbs.js\":\"069c2e3d88f7c363\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/blockrefAutocomplete.js\":\"4b1338f74415f484\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/cadencedIdleJob.js\":\"7f0c3d24e3f787f2\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/callbackSet.js\":\"8d37559cde7ad874\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/clientId.js\":\"502063258b0a11da\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/codemirror.js\":\"fd17046c749ad135\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/codemirrorCompletion.js\":\"75a26e61347cd0a4\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/copy.js\":\"8eed089034bc9fd0\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/dailyPage.js\":\"035e31d53f4107c7\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/dbForensics.js\":\"f1634950568c24e5\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/dbForensicsHooks.js\":\"525ec4c566d05aeb\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/deleteBlockThroughUi.js\":\"58be3ec243ca0110\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/dialogs.js\":\"13dfc52bb38618f3\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/dom.js\":\"fd1250a4f42b26bd\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/downloadBlob.js\":\"be1d1a6f2b211707\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/exportSqliteDb.js\":\"9a940c09e822882f\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/fileSystemAccess.js\":\"027024cd896ff034\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/flipSlide.js\":\"ac4cdf314505270b\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/fnv1a.js\":\"86eb03435b94b3f9\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/formatBytes.js\":\"b594cc2390261269\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/fuzzyRank.js\":\"c4a2d417cfe7e464\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/idbKeyedStore.js\":\"064db7f177333c48\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/idleCallbackPolyfill.js\":\"42f2cfefd9189425\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/keyboardAwareScroll.js\":\"015f14623b92f917\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/keyboardViewport.js\":\"52b5369addbfe175\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/lastWorkspace.js\":\"c503fff19407eea4\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/layoutColumns.js\":\"3b309707dc5a0fa4\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/layoutSessionDom.js\":\"c26c70f2a9f15557\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/layoutSessionId.js\":\"b28a96c18ffea85e\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/linkClickGestures.js\":\"2f4347cd006ed6e8\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/linkTargetAutocomplete.js\":\"9fca99aa6a985083\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/localDbCorruption.js\":\"29c02de254c6020b\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/localDbRecovery.js\":\"64ce1f59bf2e69ec\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/markdownParser.js\":\"dd508a97a2a32af1\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/memoize.js\":\"505089eb647e5256\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/nameFieldCommit.js\":\"5a40af571a10359a\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/nameList.js\":\"d476288df1597528\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/navigation.js\":\"bfb2ffcb0c58cd4b\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/omnilinerNamespace.js\":\"0abbfe346b79e093\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/opfsPageScan.js\":\"84c361ed3099e914\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/panelClearance.js\":\"38f2618c55173e54\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/panelHistory.js\":\"31f95ab5778bb5ad\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/panelLanes.js\":\"43bf28ca2816526e\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/panelLayoutProjection.js\":\"06fb53e99eb6efb6\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/panelScrollAnchor.js\":\"e7f0dcd1a784e094\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/panelUrlFlags.js\":\"3a5cf602dd2ae59c\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/platform.js\":\"4b9c812d8c2baf72\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/pluralize.js\":\"2efdb89eedc68de4\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/propertyCreation.js\":\"2aa32a5eefb2207c\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/propertyNavigation.js\":\"2367a75e33ddfb4e\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/propertyValueContext.js\":\"3a75af22dcab19c2\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/react.js\":\"b94cfffaa855a51d\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/relativeDate.js\":\"31a5590751f19864\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/relativeTime.js\":\"887caf9c1583fe8d\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/renderScope.js\":\"c9c540715f537319\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/resolvedThenable.js\":\"1df2bda51673c9d0\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/routing.js\":\"f7d52cb413493d9b\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/safeMode.js\":\"1bf8b2c867bda5c1\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/scheduleIdle.js\":\"29ce322b67096ea9\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/screenWakeLock.js\":\"09651055c52860c8\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/selection.js\":\"f60e516203c96262\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/softKeyboardGrab.js\":\"11e12e9d375d4111\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/startupTimeline.js\":\"42f73679ea96b974\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/state.js\":\"b9821e87ef6acc7f\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/string.js\":\"7f03a3988b703e83\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/surfaceZoom.js\":\"a8a197bae3c6493f\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/time.js\":\"a67a2d193a22bb83\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/toast.js\":\"ec40664a5ec03853\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/toggleStore.js\":\"e4e767bb202ab198\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/untilStopped.js\":\"930e12bd86271b68\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/userActivity.js\":\"47b922cc8a45fdff\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/viewTransition.js\":\"b85f95c961904128\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/viewport.js\":\"7d2b8f63e3dc3004\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/webLock.js\":\"01c53ec0d4b4c066\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/workspaceRecovery.js\":\"f22149b6feda2d12\",\"/knowledge-medium/pr-preview/pr-1810/src/utils/workspaceSnapshotStore.js\":\"505de5bc05c48715\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-compiler-runtime.js\":\"0c15d4cf47bd2009\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-dom-client.js\":\"611f6159ffd1c00e\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-dom-server-edge.js\":\"5a40419dd22317ee\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-dom-server.js\":\"cefff4df93da1e5b\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-dom-static-edge.js\":\"5b9302dd07256fc0\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-dom-static.js\":\"23f4a4b7ae901df0\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-dom-test-utils.js\":\"60aa92fb6df8adb5\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-dom.js\":\"6388c3f6a6d37e6d\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react-jsx-runtime.js\":\"74205bcf710cd13d\",\"/knowledge-medium/pr-preview/pr-1810/src/vendor/react.js\":\"aa2dbc93039319e1\",\"/knowledge-medium/pr-preview/pr-1810/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1810/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1810/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
