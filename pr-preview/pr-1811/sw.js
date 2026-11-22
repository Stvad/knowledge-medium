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
		buildId: "6955d3e46e52-6df57f3c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1811/\":\"e74d0cdf0de80900\",\"/knowledge-medium/pr-preview/pr-1811/index.html\":\"e74d0cdf0de80900\",\"/knowledge-medium/pr-preview/pr-1811/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1811/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1811/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1811/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1811/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1811/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1811/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1811/assets/FacadeVFS-Cb2izhVs.js\":\"804e75a17ceaf053\",\"/knowledge-medium/pr-preview/pr-1811/assets/OPFSCoopSyncVFS-DVSka-Dy.js\":\"fe92fd2ecfe140f5\",\"/knowledge-medium/pr-preview/pr-1811/assets/OPFSWriteAheadVFS-BTIgEPsI.js\":\"2106ec835c25f984\",\"/knowledge-medium/pr-preview/pr-1811/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1811/assets/wa-sqlite-DB2-IOWY.js\":\"2fc5aa399f988b33\",\"/knowledge-medium/pr-preview/pr-1811/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1811/assets/wa-sqlite-async-oKEFhR-W.js\":\"447507a71e90145f\",\"/knowledge-medium/pr-preview/pr-1811/assets/worker-bVIcL_Ne.js\":\"988d08abc98f33c0\",\"/knowledge-medium/pr-preview/pr-1811/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1811/chunks/app-CD_XDRX4.js\":\"28c830e94f54073a\",\"/knowledge-medium/pr-preview/pr-1811/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1811/index.js\":\"8c335eabaa5593b6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1811/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1811/assets/AccessHandlePoolVFS-CxlbizAF.js\":\"afa726852f692800\",\"/knowledge-medium/pr-preview/pr-1811/assets/IDBBatchAtomicVFS-Bv4IcB6H.js\":\"370bfacd1369e418\",\"/knowledge-medium/pr-preview/pr-1811/assets/MemoryVFS-De6NEtq_.js\":\"bdc4dbd628c3576c\",\"/knowledge-medium/pr-preview/pr-1811/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1811/assets/mc-wa-sqlite-DKyih3eo.js\":\"440630ab696170a8\",\"/knowledge-medium/pr-preview/pr-1811/assets/mc-wa-sqlite-async-C07TJoW9.js\":\"7334227c37e037c2\",\"/knowledge-medium/pr-preview/pr-1811/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1811/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1811/chunks/AccessHandlePoolVFS-RMBYZOzB.js\":\"441effaa7eb224a3\",\"/knowledge-medium/pr-preview/pr-1811/chunks/FacadeVFS-BtpC3AmI.js\":\"943dc4f130eb359e\",\"/knowledge-medium/pr-preview/pr-1811/chunks/IDBBatchAtomicVFS-oSc1Izcl.js\":\"77ffa85ca40b90a7\",\"/knowledge-medium/pr-preview/pr-1811/chunks/MemoryVFS-CRo0mwHY.js\":\"bfa42b1489bb9c73\",\"/knowledge-medium/pr-preview/pr-1811/chunks/OPFSCoopSyncVFS-B-KPvNVk.js\":\"283264a41c24797e\",\"/knowledge-medium/pr-preview/pr-1811/chunks/OPFSWriteAheadVFS-D3DE9Ajn.js\":\"78cb400c5e43f48d\",\"/knowledge-medium/pr-preview/pr-1811/chunks/Preview-CKFB9nj5.js\":\"2f6009dc6643615e\",\"/knowledge-medium/pr-preview/pr-1811/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1811/chunks/card-DKcXmVnG.js\":\"5971fb0d3304ed2d\",\"/knowledge-medium/pr-preview/pr-1811/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1811/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1811/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1811/chunks/dist-C8jcRWrW.js\":\"468078d73317746d\",\"/knowledge-medium/pr-preview/pr-1811/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1811/chunks/mc-wa-sqlite-1_bDCtIR.js\":\"3908877d3ef79db5\",\"/knowledge-medium/pr-preview/pr-1811/chunks/mc-wa-sqlite-async-Da7g4t27.js\":\"9c38f221908aa2e2\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-17TyY4Ya.js\":\"bf951b33763f9bbf\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-BBlLBQLn.js\":\"1a788e58aa15e33d\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-BZOeCQHE.js\":\"f70b0a209f922260\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-C1umT-_v.js\":\"801c4ce0cf05d6b2\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-C98du5eJ.js\":\"eab86f2da8c88737\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-CdpvdQ9m.js\":\"525f7c22f99167a6\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-DP084c0w.js\":\"d9c4b3c09df8e50c\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-Dowbp9Kn.js\":\"da3d4262178d8dab\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-dom-server-legacy.browser.production-CVVVyTWs.js\":\"eb4b6972c0b5136b\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-dom-server.browser.production-DkqqDUHY.js\":\"a213137a35f7b337\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-dom-server.edge.production-CN2llx2J.js\":\"2f0416deb0e8f1f6\",\"/knowledge-medium/pr-preview/pr-1811/chunks/server.browser-COYV9ECM.js\":\"43324c88f24725f1\",\"/knowledge-medium/pr-preview/pr-1811/chunks/textarea-DpxvNQJi.js\":\"84b54c69a85731b1\",\"/knowledge-medium/pr-preview/pr-1811/chunks/ui-CGLjX9Mb.js\":\"aa316398a8912bec\",\"/knowledge-medium/pr-preview/pr-1811/chunks/wa-sqlite-CuRZpTlk.js\":\"b4ec2c4ebdfe1275\",\"/knowledge-medium/pr-preview/pr-1811/chunks/wa-sqlite-async-BemxED7h.js\":\"f0e15de719d58e84\",\"/knowledge-medium/pr-preview/pr-1811/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1811/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1811/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1811/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1811/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1811/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1811/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1811/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1811/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1811/src/App.js\":\"e78a892604b75c18\",\"/knowledge-medium/pr-preview/pr-1811/src/appUpdate.js\":\"8566c01af18cab77\",\"/knowledge-medium/pr-preview/pr-1811/src/appVersion.js\":\"72aafb3054721360\",\"/knowledge-medium/pr-preview/pr-1811/src/bootstrap/initialLayout.js\":\"1ea92859629112da\",\"/knowledge-medium/pr-preview/pr-1811/src/bootstrap/openWorkspaceData.js\":\"acd61624f61bd074\",\"/knowledge-medium/pr-preview/pr-1811/src/bootstrap/resolveWorkspace.js\":\"67e6b434b5f05375\",\"/knowledge-medium/pr-preview/pr-1811/src/bootstrap/workspaceBootstrap.js\":\"b4e3d03102308bcf\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockComponent.js\":\"cac5265ac209fb99\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockCrumbs.js\":\"0d211a92fbbaea93\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockEditor.js\":\"2f23952ab17e905e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockLoadingPlaceholder.js\":\"54a7af996b8a5535\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockProperties.js\":\"f0138210c1ef2b7e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockSearchPicker.js\":\"01977baf03f57830\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ConfirmBulkDeleteDialog.js\":\"97770c98f6385641\",\"/knowledge-medium/pr-preview/pr-1811/src/components/DividerHandle.js\":\"f174b02d6400ae2d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/DraftEditor.js\":\"3240f3391a9582be\",\"/knowledge-medium/pr-preview/pr-1811/src/components/GutterPill.js\":\"49a727615cc13a8f\",\"/knowledge-medium/pr-preview/pr-1811/src/components/Header.js\":\"bb90812ab27ed938\",\"/knowledge-medium/pr-preview/pr-1811/src/components/LazyBlockComponent.js\":\"5d52088395c40c5a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/Login.js\":\"ab9d87a7c5f5a306\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ZoomableSurface.js\":\"7d53c92226814a10\",\"/knowledge-medium/pr-preview/pr-1811/src/components/editModeKeepalive.js\":\"cec789a672a08d76\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b309118275ed9762\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"76bda61673ea06d3\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/RefPropertyEditor.js\":\"1a0c66b6c8163b63\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/RefTargetTypePicker.js\":\"fd2955d43bed2c92\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/SelectPropertyEditor.js\":\"d0e6585f97c98f6e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/TypesPropertyEditor.js\":\"acc366d2521e9955\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/defaults.js\":\"98964022939e55b3\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/kernelValuePresets.js\":\"586f0a0eab1da22d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/selectablePresets.js\":\"aa58fe08758c9789\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/typesPropertyUi.js\":\"d14da4372b718f79\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/AddPropertyForm.js\":\"3252c6aa3f51773d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/PropertyPicker.js\":\"db76a8c14d2ca47e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/PropertyRow.js\":\"a88764b5b1a46dab\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/Rows.js\":\"da6f0bde85f44dae\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/actions.js\":\"2c0eb2a106c7bac5\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/declarationOnly.js\":\"5bbbed40dd27aefd\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/layout.js\":\"1ba232fe91322e21\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/model.js\":\"af2bdbd4e7724f06\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/shapeUi.js\":\"724f3ee653fd976f\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/shapes.js\":\"bcca5987953e7595\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/usePropertyEditingActivation.js\":\"eaf88a023e9b6f33\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/visibility.js\":\"904a8cea7277f27b\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanelSections.js\":\"22f6e1c5e199df17\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/BlockEmbed.js\":\"8b34d79175aa906f\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/BlockLink.js\":\"ec6a9b3e71ce9054\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/BlockRef.js\":\"9faaff0de00396a3\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/ReferenceLink.js\":\"5ca1e576600b57ad\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/cycleGuard.js\":\"a622aae9087a7ef5\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/cycleGuardContext.js\":\"bd31c8386e080d1b\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/linkInteraction.js\":\"4d8ff252487f1123\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/referenceLayout.js\":\"e90e9ce07a228ff4\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/useBlockRefAncestors.js\":\"ade235db1683fbbd\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/BlockGutter.js\":\"c33d43a5ffc8c956\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/BlockInfoDialog.js\":\"6a9642a25bb2ec3c\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/BlockTypeBlockRenderer.js\":\"f005b3b3de823939\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/BulletHoverCard.js\":\"554c00876d0d92cb\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/CodeMirrorContentRenderer.js\":\"2163c29c75d93b98\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"489a5af210c837ac\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/ColumnResizeHandles.js\":\"1f73455852bb04dd\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bcd8dbaaa0bf5131\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/DefaultBlockRenderer.js\":\"69898c5d2c3a0cd8\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/LayoutRenderer.js\":\"e4d4235576685141\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/MarkdownContentRenderer.js\":\"e4033d4e82f13461\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/MissingDataRenderer.js\":\"fc5c87c4f7654bdb\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/PanelRenderer.js\":\"fd3edd35cf659803\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/PropertySchemaBlockRenderer.js\":\"fcdae623d504148a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/TopLevelRenderer.js\":\"e43e80038645b8f8\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/blockGutterMode.js\":\"dd79560d6aa11bb2\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/blockTitleText.js\":\"fd8c9aeaad8308bc\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/fieldCreationKeydown.js\":\"200fec3dcfad1d4b\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/layoutRootContext.js\":\"af481141560f47de\",\"/knowledge-medium/pr-preview/pr-1811/src/components/typeChip/TypeChip.js\":\"a15f4737bfa82dab\",\"/knowledge-medium/pr-preview/pr-1811/src/components/typeChip/chipStyle.js\":\"f2f4d29f78e7584c\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/anchored-floating.js\":\"3e2750ba34a8af33\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/button.js\":\"e26eb2b934394525\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/card.js\":\"c5ae3ddc1658621d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/checkbox.js\":\"444524b7947b4b05\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/collapsible.js\":\"5b75db01d2c24d1e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/command.js\":\"857793bcffd03c4d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/context-menu.js\":\"422579aab4b7033d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/dialog.js\":\"3206cb896b5531ea\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/dropdown-menu.js\":\"d5cf1f1242e39ea3\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/floating-listbox.js\":\"48e651680e951844\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/index.js\":\"dfc2448cafe9418f\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/input.js\":\"083bec83513e37d1\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/kbd.js\":\"2e6c0d2e544d4209\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/label.js\":\"299561fff715521b\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/textarea.js\":\"fc0d5262ea040e2f\",\"/knowledge-medium/pr-preview/pr-1811/src/components/useEditModeYieldKeepalive.js\":\"5921954b7a0dd4d4\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/BootFallback.js\":\"8fbbc0457c4ea3bc\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/FocusedRowLazyMount.js\":\"cf36fadf4096a2ed\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/LazyViewportMount.js\":\"35d0f499ee6ac024\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/LocalDbCorruptionFallback.js\":\"e1ade8554a930f71\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/error.js\":\"6bf9d6b4d4d47175\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/lazyMountRegistry.js\":\"8a59eb8593ea9d62\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/suspense.js\":\"500c8fdc1351f79d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/CreateWorkspaceDialog.js\":\"2c31f2782a7b98ca\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/PendingInvitations.js\":\"e69a04cfafd327a7\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/SyncProgress.js\":\"71e755e8d9a02f8d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/UnlockProgress.js\":\"a1800700822cf6bd\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/WorkspaceKeyGate.js\":\"40f7a10d38dd634a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/WorkspaceSettingsDialog.js\":\"8cd6b233ccf623eb\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/WorkspaceSwitcher.js\":\"ff1eb5ab1db59c04\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/WorkspaceSyncGate.js\":\"2aaee7561dd5de37\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/ConversionFlow.js\":\"b5e460cd92aef6d4\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/ConversionFlowHost.js\":\"e1356558a779f7e6\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/EncryptionSection.js\":\"167452e97405c4ef\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/attachmentPrompts.js\":\"6122bf2173c1c0c9\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/bundleFolderPrompts.js\":\"71ec961a537f40c5\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/conversionFlowDeps.js\":\"51b5846628302391\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/conversionFlowStore.js\":\"1f859086a07fdf7e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/flowUi.js\":\"2b16d11ce810bcf8\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/useConversionRun.js\":\"628cf6bda5e4f015\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/keyUi.js\":\"e13fb32b059d6743\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/useCloseOnKeyLoss.js\":\"97e80dd55d97fb02\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/useCloseOnServerE2ee.js\":\"163a35f46a5bc6ac\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/workspaceUnlocked.js\":\"d4bf2c399745ddad\",\"/knowledge-medium/pr-preview/pr-1811/src/context/backgroundSubtree.js\":\"c3dcede6755ff6ff\",\"/knowledge-medium/pr-preview/pr-1811/src/context/block.js\":\"f17daf59d08c4402\",\"/knowledge-medium/pr-preview/pr-1811/src/context/layoutWsContext.js\":\"6952f8c05c01e9c4\",\"/knowledge-medium/pr-preview/pr-1811/src/context/propertyDisplay.js\":\"87746dc37d394e98\",\"/knowledge-medium/pr-preview/pr-1811/src/context/repo.js\":\"09b54b8eb785462e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/aliasClaim.js\":\"5add7a1ab7a06b48\",\"/knowledge-medium/pr-preview/pr-1811/src/data/aliasSeatNamespace.js\":\"8ad77f2448cb3f48\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/blockData.js\":\"ce6bed61c2a6ff01\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/blockType.js\":\"3f67424a48446fea\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/changeScope.js\":\"85acb0c17ac986f3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/codecs.js\":\"440d1fbe9696d9cf\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/derivedData.js\":\"2abb334fb679f462\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/errors.js\":\"23f1681239b17804\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/events.js\":\"9b41ad23e5afe26e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/handle.js\":\"76453cd0d03f62c3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/index.js\":\"5d24a34f2fb1bda8\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/mutator.js\":\"a92f7f5416a2710a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/processor.js\":\"af1b489f9efc9a01\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/propertySchema.js\":\"b2e06cae7c656952\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/query.js\":\"f023c0c5a105f6d9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/sameTxProcessor.js\":\"49ac257472a8abe0\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/schema.js\":\"76453cd0d03f62c3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/tx.js\":\"76453cd0d03f62c3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/typedBlockQuery.js\":\"c77836397bcf56f9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/user.js\":\"b65db2c0d362d965\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/valuePresetCore.js\":\"00fe0b0a37044837\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/valuePresets.js\":\"b3dd834ec42f7377\",\"/knowledge-medium/pr-preview/pr-1811/src/data/attachmentCleanerIOVerb.js\":\"cfe4407338da417f\",\"/knowledge-medium/pr-preview/pr-1811/src/data/block.js\":\"1a0e87bcb0dad0e2\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockCache.js\":\"90774e63b03a5eaf\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockId.js\":\"18962a93ce301209\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockLiveness.js\":\"2e267a149ae814fe\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockMerge.js\":\"81f3a65f3a7dc023\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockSchema.js\":\"ac85695c57b22f24\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockTypes.js\":\"d3ec1443309907ea\",\"/knowledge-medium/pr-preview/pr-1811/src/data/clientContext.js\":\"8fc0b17fea45b7dc\",\"/knowledge-medium/pr-preview/pr-1811/src/data/dbFileSiblings.js\":\"d474bd5a4186e481\",\"/knowledge-medium/pr-preview/pr-1811/src/data/definitionSeeds.js\":\"55edeb9ec95cb4ab\",\"/knowledge-medium/pr-preview/pr-1811/src/data/derivedIds.js\":\"5c3b1e72260f382a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/drawnSubtree.js\":\"3a9bec19ca3760b0\",\"/knowledge-medium/pr-preview/pr-1811/src/data/facetBridge.js\":\"7b5ae300270bdfc9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/facets.js\":\"49b2017b36d95ef5\",\"/knowledge-medium/pr-preview/pr-1811/src/data/globalState.js\":\"e12aa2b211f45271\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/aliasClaimRederiveProcessor.js\":\"20832f5477fed0e2\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/ancestorBatch.js\":\"5049e51cc2956278\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/blockTypeTypeifyProcessor.js\":\"bc8074b88efa70ca\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/clientSchema.js\":\"cc34b15a43265249\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/commitPipeline.js\":\"61c6811a93f2678a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/devAssertions.js\":\"1b91727b900a0c6f\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/firstSync.js\":\"b6d779ee0176e5cd\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/freshInitialLoad.js\":\"ea40b9de3a601a96\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/graphBackfillClaim.js\":\"ddd07c014983b312\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/handleStore.js\":\"5e8105deabb56295\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/idleMarkerJobs.js\":\"c1a49e918e615293\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/initialDownload.js\":\"7d615e8cde004ca2\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/initializeClientDatabase.js\":\"0e24c7a9c73dae0e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/jsonCanonical.js\":\"4e86e198ea7e029c\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/kernelInvalidation.js\":\"35dc11bb10a9d0c9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/kernelProcessors.js\":\"b53bf593f68d912e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/kernelQueries.js\":\"5cbda8009ca9c18e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/mergeTypeMembershipProcessor.js\":\"02846146cb37834c\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/normalizeReferencesProcessor.js\":\"fe6a534380591013\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/poolInstrumentation.js\":\"e38f386feec8b098\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/processorRunner.js\":\"1795091e50fe551b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyCellBackfill.js\":\"7e5881f14b26195e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyChildMint.js\":\"83b6d228c5f45153\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyChildrenProcessor.js\":\"4bb170580c2c9ffe\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyDefinitionChangeProcessor.js\":\"ff2121c32abc80b2\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyDefinitionSynthesis.js\":\"193e4c4e9be08117\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyKeyScan.js\":\"12c40eda27d7aaa5\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertySchemaResolution.js\":\"a605a0b844f3eda3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyValueEdits.js\":\"8d89da193abd1f16\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/raiseProtocol.js\":\"fb440c02b1b1da89\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/readBatch.js\":\"5ce687209d3593c6\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/refProjection.js\":\"11b2bf22f9ccca72\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/referenceTargetLookups.js\":\"708aaa4af9e40cd3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/referenceTargetProcessor.js\":\"7ce3569a22fd81c3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/replayMerge.js\":\"63e8a12cb4208374\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/sqlBinds.js\":\"8763603e5806e8b3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6e9ee8398ed9bb67\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/arrivalProcessors.js\":\"d5a45fe3b5435058\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/invalidate.js\":\"d19d6c03bffd0a4e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/materialize.js\":\"b33eddc943750872\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/observer.js\":\"1f579be8670c7c6c\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/reconcile.js\":\"4ef3779ca1a88631\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/timingMetrics.js\":\"9e65e7d0c759b887\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/treeQueries.js\":\"73a8fba20b9ac491\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/txEngine.js\":\"0b6f2272175bac59\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/txSnapshots.js\":\"99813a73a1220f86\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/typedBlockQuery.js\":\"337c778541af0c53\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/undoManager.js\":\"704ece48c2b4d2d6\",\"/knowledge-medium/pr-preview/pr-1811/src/data/invalidation.js\":\"7ba7576e1625166b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/kernelDataExtension.js\":\"753af9983dbdcc21\",\"/knowledge-medium/pr-preview/pr-1811/src/data/kernelPage.js\":\"7c5962a46fca05d1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/kernelValuePresetCores.js\":\"00838c05dd8977d4\",\"/knowledge-medium/pr-preview/pr-1811/src/data/localDbCorruptionSignal.js\":\"31ad3f265c7d741a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/localDbStorage.js\":\"b735115a1c24bb3b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/localDbVfs.js\":\"8de2b78722c9a8cb\",\"/knowledge-medium/pr-preview/pr-1811/src/data/localSchema.js\":\"31cffdb2f9bd09df\",\"/knowledge-medium/pr-preview/pr-1811/src/data/maintenance.js\":\"9ff73adac1c184b2\",\"/knowledge-medium/pr-preview/pr-1811/src/data/mergeProperties.js\":\"07b6368857c13197\",\"/knowledge-medium/pr-preview/pr-1811/src/data/metricsConsoleHook.js\":\"a94df3c600606ebd\",\"/knowledge-medium/pr-preview/pr-1811/src/data/migrationsPage.js\":\"36a5289729f3f9d9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/mutators.js\":\"6adae8520f27c9ad\",\"/knowledge-medium/pr-preview/pr-1811/src/data/orderKey.js\":\"c473a6f4f709814f\",\"/knowledge-medium/pr-preview/pr-1811/src/data/orderKeyPlacement.js\":\"df316e1a05f3acb8\",\"/knowledge-medium/pr-preview/pr-1811/src/data/outlineSurface.js\":\"d52c269e500105a8\",\"/knowledge-medium/pr-preview/pr-1811/src/data/pendingEditorContent.js\":\"53fdc1aae66493ab\",\"/knowledge-medium/pr-preview/pr-1811/src/data/pendingUploadsSql.js\":\"23a94af9b0281d53\",\"/knowledge-medium/pr-preview/pr-1811/src/data/pluginStateExtensions.js\":\"d4dbe74af2feb1fd\",\"/knowledge-medium/pr-preview/pr-1811/src/data/powerSyncLogger.js\":\"766f09e1c9f40f97\",\"/knowledge-medium/pr-preview/pr-1811/src/data/projectorRuntime.js\":\"9714f90b4d8439e0\",\"/knowledge-medium/pr-preview/pr-1811/src/data/properties.js\":\"4dc28bb825299e59\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertiesPage.js\":\"1fbf564c1d680db6\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyChildren.js\":\"e69135bf773c39b1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyDefinitionFanout.js\":\"16b9908741237d4e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyDefinitionMetadata.js\":\"9b6f6fbb64b7fc51\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyDefinitionRegistry.js\":\"023b199a227830b3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyDisplayMode.js\":\"6a7f628a80704343\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyRowCreation.js\":\"61cd76a38330142d\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertySchemaCreation.js\":\"0dec4e23cd98bf41\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertySeeds.js\":\"fe5b4a869948f653\",\"/knowledge-medium/pr-preview/pr-1811/src/data/recentsPage.js\":\"241727ecd54ebfca\",\"/knowledge-medium/pr-preview/pr-1811/src/data/referenceBlock.js\":\"8a079b0f4d173688\",\"/knowledge-medium/pr-preview/pr-1811/src/data/rejectedUploads.js\":\"250f4c9441aa52bd\",\"/knowledge-medium/pr-preview/pr-1811/src/data/releasePowerSyncConnection.js\":\"6d0a3a92842721ae\",\"/knowledge-medium/pr-preview/pr-1811/src/data/repo.js\":\"13ab0c82fd345b0a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/repoProvider.js\":\"dec7f901256c981f\",\"/knowledge-medium/pr-preview/pr-1811/src/data/rowProperty.js\":\"e52dacc817f06c68\",\"/knowledge-medium/pr-preview/pr-1811/src/data/searchFilter.js\":\"56e533feb4dec430\",\"/knowledge-medium/pr-preview/pr-1811/src/data/seedIdentityLedger.js\":\"bf9eee588fc63a7b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/stateBlocks.js\":\"a0b59238767f7ef5\",\"/knowledge-medium/pr-preview/pr-1811/src/data/structuralEditPolicy.js\":\"88fa42e182e90c95\",\"/knowledge-medium/pr-preview/pr-1811/src/data/subtreeDelete.js\":\"f7d8aaa9fb53d7a9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/syncStreamLock.js\":\"e33a3c0fdbb6063d\",\"/knowledge-medium/pr-preview/pr-1811/src/data/syncedTableSqlRecognizer.js\":\"c965c19606a2e277\",\"/knowledge-medium/pr-preview/pr-1811/src/data/syncedTableWriteGuard.js\":\"a6c0dcaa392c906c\",\"/knowledge-medium/pr-preview/pr-1811/src/data/targets.js\":\"d311d52c4b8f0edc\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeColors.js\":\"313a6ea1803866d4\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeDefinitionMetadata.js\":\"1ecc097a071894b1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeDefinitionRegistry.js\":\"74143fc333bebde9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeExtraction.js\":\"adb12b9f7ef284fc\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeInitialValues.js\":\"02f68a420eea44aa\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typePropertyGroups.js\":\"1530c07b2e8397bf\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeSeeds.js\":\"8a94358587d53bc2\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeTagger.js\":\"85e58ce5c5fa60b0\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typedRecords.js\":\"798a5cf05093ad65\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typesPage.js\":\"44a9fde8c5c13ad1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/userPrefs.js\":\"7fa64a9134272969\",\"/knowledge-medium/pr-preview/pr-1811/src/data/userSchemasService.js\":\"7452148fd778fb04\",\"/knowledge-medium/pr-preview/pr-1811/src/data/userTypesService.js\":\"41982ac838e39507\",\"/knowledge-medium/pr-preview/pr-1811/src/data/valuePresetRegistry.js\":\"fb9a76872e9c520e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/visibleChildren.js\":\"3a7d27557b970ba1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaceConversion.js\":\"68ade7515d46bc36\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaceFirstSync.js\":\"f70219ff1785a1b9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaceIdNamespace.js\":\"ad2b662b73f5aa3d\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaceSchema.js\":\"14e8b6d076126b0c\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaces.js\":\"8d04ffd1db601d85\",\"/knowledge-medium/pr-preview/pr-1811/src/data/writeAheadLog.js\":\"0b03b873a1dbf7b8\",\"/knowledge-medium/pr-preview/pr-1811/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/BlockPasteShellDecorator.js\":\"0fb044ba07eb774f\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/atTrigger.js\":\"c87fcc9d77e4a589\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/autocomplete.js\":\"02a9e9dd0d35a93e\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/codeMirrorExtensions.js\":\"c7d4ffec3e8b1da3\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/contentFlush.js\":\"3628d5e5ab1f8b4c\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/defaultInteractions.js\":\"3c0056299b63eb47\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/editSettleSignal.js\":\"1c76358d15671cf7\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/insertImage.js\":\"275a64d5194363be\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/referenceCompletionRange.js\":\"bf9ebf0b887e491d\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/referenceTargetTypes.js\":\"e9f9fdeeb33518c4\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/syntaxContext.js\":\"241c91bd0daa0f5e\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/triggerMatch.js\":\"be9ee8658f1df10d\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/AppRuntimeProvider.js\":\"b1e8a4e78f7833a1\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/BlockFocusShellDecorator.js\":\"47aaa857b04ab180\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/ExtensionRenderBoundary.js\":\"803eca4abb46acb2\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/PanelContentRecovery.js\":\"0f82fe4e79cfe97e\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/apiCatalog.js\":\"8462432084a9e1bb\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/approveExtensionHere.js\":\"2316d413e2044832\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/armedCutAppMount.js\":\"078994dffe809ee2\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/batchableKeyedStore.js\":\"ab25a87e2938d6c0\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/blockInteraction.js\":\"828858a075b19096\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/blockSelectionAction.js\":\"c7c63dfb03060eca\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/compileExtensionModule.js\":\"3ba2062b05ac3d6b\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/compiledModuleCache.js\":\"c17ef4268018e590\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/continuousGestures.js\":\"5873c21c7dd66064\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/core.js\":\"36a9fafa5c80bd76\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/defaultRenderers.js\":\"cfacc507504bb9f3\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/definitionFanoutAppMount.js\":\"8381989c2327c481\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/dialogAppMount.js\":\"d2119e598ad3c4d5\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/dynamicExtensionSeeds.js\":\"08b0163a0d73e830\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/dynamicExtensions.js\":\"22583200dbd8f374\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/exampleExtensions.js\":\"7a9ea0a0616cacaa\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionApprovalStatus.js\":\"930483e85c74ecbe\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionLoadErrorToast.js\":\"b58db4a6988b9bda\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionLoadErrors.js\":\"06db50db62409cee\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionLookup.js\":\"ad779180277ac9cb\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionToggles.js\":\"7fadf8433e2fd9a6\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionUtilitiesCss.js\":\"0021492c5a0c8a0f\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/kernelPageDeletionGuard.js\":\"0be341caf763505b\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/liveRuntime.js\":\"0ec46b3d1eb9d990\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/openExtensionsSettings.js\":\"e5cdd4923d23b62e\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/overridesCache.js\":\"d99969fbdb5e494d\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/pluginIds.js\":\"6aa449df00cd799c\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/processorRejectionToast.js\":\"99efc765a814c57f\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/runtimeActions.js\":\"60728e2807a8220e\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/runtimeContext.js\":\"dd2fcbb8a2846c99\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/staticAppExtensions.js\":\"d6e37b2c398f4366\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/staticDataExtensions.js\":\"9d865529fdff56a9\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/toastAppMount.js\":\"9e5b57f0641908fc\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/useOverrides.js\":\"930018614d6f542a\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/useShortcutSurfaceActivations.js\":\"6440cb497d717043\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/discoverToggleTree.js\":\"199ddfebc333b0cd\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/facet.js\":\"28ffa55eac069091\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/resolveAppRuntime.js\":\"a627c5f384afa039\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/runtimeEvents.js\":\"2d4fa1f5a26b1ccf\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/togglable.js\":\"9e2b89cf9c152c99\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/variantFacet.js\":\"ec465121dd841bc0\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/verbFacet.js\":\"d2001fbadaaca048\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/block.js\":\"e2688999d9252bc5\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/focusedChild.js\":\"7a55d2c42ca3da89\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/propertySchemas.js\":\"04aa44f7cd79018c\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/typeRegistry.js\":\"5413854031fac833\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useAncestorCrumbs.js\":\"96f61e978bc81348\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useAutocompleteListbox.js\":\"f299c20d02514c3d\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useDebouncedSearch.js\":\"fa0c146ef21d691c\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useDebouncedValue.js\":\"b493687231318084\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useIsFocalRender.js\":\"1f9fd61edc50c11f\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useIsReadOnly.js\":\"85543fb8f93647ce\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useMaterializeBacklog.js\":\"f864df97fd0a0fdc\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useMinuteClock.js\":\"a6edc0200ff79282\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/usePanelLayoutProjection.js\":\"71e354f5d7e7c15c\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/usePendingInvitations.js\":\"33f7b7002a993193\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useRendererRegistry.js\":\"87adff1fc2bca579\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useRetainedFieldRows.js\":\"c188435b519d359f\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useWorkspaces.js\":\"16976b33a29a5b79\",\"/knowledge-medium/pr-preview/pr-1811/src/lib/utils.js\":\"61882a9a727cd64c\",\"/knowledge-medium/pr-preview/pr-1811/src/main.js\":\"2ba8b654745dfe05\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/MarkdownImage.js\":\"8bc701748b495f61\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/blockSeparators.js\":\"9bf251036b8b6ae8\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/context.js\":\"d4ede8dfd149df9f\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/defaultMarkdownExtension.js\":\"4aa67bb0b1f6800d\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/extensions.js\":\"ed05c0e29a3055a4\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/renderMarkdownHtml.js\":\"b866c5f949c078d2\",\"/knowledge-medium/pr-preview/pr-1811/src/minimal-editor.js\":\"013be2fd245e665e\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/armedCut.js\":\"a44116b3e5f30e88\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/captureMediaVerb.js\":\"7252d4fc1ffcf637\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/clipboard.js\":\"4b4a187d3e686a1a\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/decision.js\":\"25ade6a5667d72e6\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/operations.js\":\"c50fab2ff395731b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/account-header/AccountHeaderItem.js\":\"e41b77addfe037af\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/account-header/index.js\":\"9b0ebf3f8196a60d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9427b1e0b781ae98\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/askAgent.js\":\"896c30e7b2bd3422\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/askedStore.js\":\"ee95ea5160168874\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fa3af3e22116badf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/chipState.js\":\"7627b8fc95b859d3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c0bd32a08f5815d4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/index.js\":\"7da29178bb978d91\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e732ede472ca75a2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/schema.js\":\"6781bdfce95fecc2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/AgentTokensDialog.js\":\"cae45c5bd5b30ad0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/BridgePairingDialog.js\":\"05d80cea3a577cf2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/addMedia.js\":\"0c20484060dc4fbd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/backlinks.js\":\"97c6ba0b06f47e1f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/block.js\":\"e7536f7827cc112e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/context.js\":\"e4257cb40300e448\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/displayIds.js\":\"fabf200de3b68493\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/index.js\":\"99b08b9f2c34a71d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/outline.js\":\"53c84611177eee05\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/properties.js\":\"7b86b60fd7766eb2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/refs.js\":\"fd7a1b324f6bad72\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"922afd5fcf6d74a5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/search.js\":\"b41e1784fa7560c3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/shared.js\":\"1d750fab28af2533\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e6362da804bee667\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/text.js\":\"785a5e4de4f79ef9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentWrites.js\":\"6d84058a1d34273d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/authoringCatalog.js\":\"1723c830db409f48\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/blockRefTargets.js\":\"45191c303b5fa79d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/bridge.js\":\"44d1ccf82b4e6d39\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/bridgeLoop.js\":\"2ec8be598ea2c9b2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/changeHistory.js\":\"797600c42366d211\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/commands.js\":\"37463fd1839be50e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/commentsCommands.js\":\"22947f0a408c04ad\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/dataExtension.js\":\"3788b7fbe6451246\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/dataModelGuide.js\":\"a8e4964d906dd122\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/describeRuntime.js\":\"7a573e29bc90e5c5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/extensionLint.js\":\"a0c63b93e8c1d49f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/grainAudit.js\":\"0e9e3673a790e75e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/healthCommand.js\":\"03011fda8411bb58\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/index.js\":\"b87bdeb309c0d0f7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/presetIdentity.js\":\"6ccc19fa5384936d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3faefe05aa0994bc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/readMedia.js\":\"d61e16d59760b753\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/schema.js\":\"6a1135b7d331b2b8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/serialization.js\":\"02e3612265710021\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/targets.js\":\"e110a99009a5c52c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/tokens.js\":\"e013571944e1c059\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/watchEvents.js\":\"48a7d73e8491b08a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/workspaceGuard.js\":\"70a9ebc3a11d7aa6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/writeCommands.js\":\"3a47d8163e07c200\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/AliasCollisionToast.js\":\"8bee79ae57c77023\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/DuplicateNameBanner.js\":\"db34eb45f05bdcd7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/collisionMerge.js\":\"13e983a92eba707f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/dataExtension.js\":\"6f3d612e78844b85\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/index.js\":\"d0f924412883c7a8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/mergeCollisionAction.js\":\"ec6601196671762b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/pageStyling.js\":\"f6a881b516ff7866\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/rejectionToast.js\":\"b01e3e4206a5af2e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/syncProcessor.js\":\"e269724c87d41aec\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/actions.js\":\"a029b91f84df3cea\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/addComment.js\":\"c89e3109d328b301\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/anchor.js\":\"c1c0dd6e63db9ed0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/anchorState.js\":\"91a28f8f8901cac9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/commentLinks.js\":\"f5983129abcaa284\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/confirmThreadDeletion.js\":\"be47d284e1dd82db\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/container.js\":\"8a5d02bd37e8dffb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/dataExtension.js\":\"8e233a26c7a104b6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/deleteComment.js\":\"e8aab6116ce26c88\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/highlights.js\":\"4a5b373e86ab8eeb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/index.js\":\"fc023d724102bd3a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/linkedCommentsPill.js\":\"0e0dd002428d1e4c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/margin.js\":\"7240ed0b865d6940\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/marginSchema.js\":\"3f35f9a0e02cd8d4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/newComment.js\":\"1ea811c149d16020\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/ownThreadPicker.js\":\"f9fb22986db3c3d3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/placement.js\":\"fdd59c08519ddc3e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/queries.js\":\"f2a72152e20a8946\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/quotePosition.js\":\"0d8cf68e6c388d7e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/quotedIn.js\":\"d7eff4830707c178\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/quotedRange.js\":\"1c838617605a5bc7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/rangeRefs.js\":\"d8d587993f1c6cde\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/readHighlights.js\":\"16c76c29989e2b66\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/readSelection.js\":\"7e286744b5316b9e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/readSelectionUi.js\":\"6bf2034171887881\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/reanchor.js\":\"d23c4793bb26971f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/schema.js\":\"9813814fdbe51485\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/scope.js\":\"6563338cef46dbd4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/scopeThreads.js\":\"e854f9a7dfb6d733\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/splitRetarget.js\":\"e8ee33fe16120d73\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/suggestionCard.js\":\"108f19e8fcbe71ac\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/suggestions.js\":\"c4a294b160f9cd0b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/summaries.js\":\"7d1964ecebe24209\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/summaryBatch.js\":\"b76abcd70cc52151\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/surface.js\":\"6516412c9650af14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/threadNavigation.js\":\"24722050c94ddcd5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/threads.js\":\"5d4d9420e3ebc147\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/ui.js\":\"ee8e615b4f53bd5a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/uiStore.js\":\"af7bf6815b73e591\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/app-intents/appIntents.js\":\"77d6275c4c299266\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/app-intents/index.js\":\"5e47aa9ad3b63c27\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/app-update-prompt/index.js\":\"fa9bec17928c03e0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/app-update-prompt/status.js\":\"e2351146d260691f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"dd1b804961efee3b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/MediaBlockRenderer.js\":\"5a6baa287c6e700a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/MediaDownLaneReplicator.js\":\"02c6099b2a5357c2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/MediaUploadReconciler.js\":\"763212e1d25c8f9d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/assetDownLane.js\":\"292dfaf1b1ec337d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/assetResolver.js\":\"b9b904a7b84ba6f0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/assetUpload.js\":\"8868dc99ebbcc286\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/attachmentCleanerIO.js\":\"72eeeb071ef0a1d5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/supabaseAuditIO.js\":\"ccf15d25f934a5b9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/blobStore.js\":\"c39f0b6ac7b8fce9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/byteStore.js\":\"c186d498535f6945\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/cleanerIO.js\":\"feaadc290700a4e9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/cleanupAttachments.js\":\"3679c9e62a624e41\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/dataExtension.js\":\"fbf9f6872cc70db1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/downLane.js\":\"b154f2ebe77c3f5f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/index.js\":\"7b1ba8b8b12d1804\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/insertImageContribution.js\":\"3fc47445abddfda9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/laneArming.js\":\"6fbc8f211ed9101d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/laneLock.js\":\"4841f3b3017dd89f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/mediaBlock.js\":\"cb8b379e90a83897\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/mediaCapture.js\":\"f20009d290ec395c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/mediaViewers.js\":\"24b9bee0c1a8d252\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/mediaViewersFacet.js\":\"106835a4f72c208d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/pasteCapture.js\":\"be59044d6bf82ad3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/resolver.js\":\"aead53908cd6c900\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/retryUploadsAction.js\":\"c3222d3a9b8de20c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/storagePaths.js\":\"fa3de1ac35518b91\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadDrain.js\":\"907d0b040878df04\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadLaneStatus.js\":\"bd3f1727eb89d46d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadReconcile.js\":\"cec7742fe3a2802a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadRecovery.js\":\"f960716d85543b64\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadStore.js\":\"a8cd16a0a57f8ace\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/useAssetObjectUrl.js\":\"4b6674309d1e7748\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"aecf8e39280126a6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ab1677a0b03010b6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/facet.js\":\"2f3a6f494bdc0408\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/index.js\":\"11d7f335f3e9e4bf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/prop.js\":\"401224e1abdd37c2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/BacklinkFilters.js\":\"5eee23480dd7631a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d51e1d53a2fe4916\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/BlockEntry.js\":\"002780339a4eb94f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/LinkedReferences.js\":\"baced94e961bd8b8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5ddb07c74835e09f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/dailyNoteDefaults.js\":\"5bffbedcf0a5c5b0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/dataExtension.js\":\"653e427324c180a7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/edgeExclusions.js\":\"be86f84bceda692e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/filterProperty.js\":\"eefa53e72a993916\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/index.js\":\"53e0d0d6b28e8adc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e10c5f2ae880d6c9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/applies.js\":\"1995ec56b6a93b78\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/countQuery.js\":\"da3dc3bc3f32a7e8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f10b11230ef2edd2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/index.js\":\"352a4365fb0e169b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d007772bc367e1be\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/presentationInvalidation.js\":\"f8d1f0ea9931f450\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/propertyEditorOverride.js\":\"72802ad4e8d5a013\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/propertyFilter.js\":\"258c5d2372a1e436\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/query.js\":\"7a4761f185d50661\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/resolveFilter.js\":\"9b4f8488a9952e9c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/sourceBatch.js\":\"08f96c6a5f07c529\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/sources.js\":\"7399f888a24d7dfb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/useBacklinks.js\":\"9204c481597d8489\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5d811825215138d3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/BirthdayCelebration.js\":\"00df6e43c6f73d5a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/BirthdayOverlay.js\":\"02646428d88d8dc8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/gate.js\":\"3eb7ba74a403f338\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/index.js\":\"c9130dddc2445cf9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/wolfTheme.js\":\"e17542627d302b46\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/BlockDragLayer.js\":\"95acbdb2fc931852\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/dragController.js\":\"176692dc89e8c0aa\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/dropTarget.js\":\"cd0b98df582ceb2d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/index.js\":\"9a9688652726f8f8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/projection.js\":\"1da2e25bd037bd9e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-info/BlockMetaCard.js\":\"94385459085fb8b1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-info/index.js\":\"42606b6032000b2a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/AddTagDialog.js\":\"40312851537819e4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4024f50bbb4c3eec\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/TagNameIssueHint.js\":\"cad7ecaa5ce4e0b3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/addTagAction.js\":\"d2c040d3988aa554\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/appendTag.js\":\"7f412031bceb19cd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/config.js\":\"96c8f026a93d4f36\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/dataExtension.js\":\"7868e49e93d819f4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/index.js\":\"81019f78d66a716c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/propertyEditorOverride.js\":\"7a6512f8bd876ab9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8194a4e26b3ae560\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3ec1f302f593bae7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/Breadcrumbs.js\":\"02ef1c82ca28e177\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"5e894174bcfe9581\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"892fa35fdf3a38a7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/index.js\":\"53c3618d9873a047\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ad1806255bcdee12\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/CharacterCountItem.js\":\"b770422b67d43890\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5f38ef0c65c1e136\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/actions.js\":\"5e7b5bf122772758\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/blockType.js\":\"c39e4ca003a20617\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/charCount.js\":\"47e79f6d7261a402\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/dataExtension.js\":\"a834b9a0f39e40bd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/index.js\":\"2a4bf1479a382ca4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/profiles.js\":\"2774b025c699237f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/properties.js\":\"49827f81fc7ded98\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/textCounts.js\":\"20a3ff055c21f1b1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/colemak-keybindings/index.js\":\"ec1ee2504d5f1118\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/CommandPalette.js\":\"66437eb6415130af\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/HeaderItem.js\":\"9ccba82df3a31c18\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/context.js\":\"8af30c58b8a0e096\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/index.js\":\"ce786f2f203c3838\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/selection.js\":\"02ec618410d44489\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/toggleStore.js\":\"5520e6228a0aca72\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/useCommandPaletteActions.js\":\"c30e78f47fd99355\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/ContributorBadges.js\":\"010df508b54ea844\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/author.js\":\"c114b95d68a156b8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/codeMirrorExtensions.js\":\"449c298d9148eb37\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/dataExtension.js\":\"aa44ed7a36676a4d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/index.js\":\"444fd05d31e93063\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/mentionAutocomplete.js\":\"aaf795f09564be24\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/processor.js\":\"d8f92e92ad7d74cb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/profiles.js\":\"328ea72a2e023127\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/queries.js\":\"d2f4731e2691d726\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/schema.js\":\"176d862fe82eb306\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"79073c69babf667f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c90a4f41bbde0c34\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/index.js\":\"c01ad4eaea708113\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"39bdb090babfce40\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9d4e282cbb0c04ba\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/CalendarGrid.js\":\"f41d563aeb38dc69\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/DailyNotePicker.js\":\"68d3ebd6cda98e3b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9a1b43a90024aa01\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/DateNavDecorator.js\":\"6b78427e1bcf9e08\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/DateScrubOverlay.js\":\"10edbcd34190a5dc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/HeaderItem.js\":\"ceb807f4975f60a2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/ReschedulePicker.js\":\"bde085011520bae5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1c94b997b1eb6196\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/actions.js\":\"3980245100ab299d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/blockDateAdapter.js\":\"75a2917a64b7b867\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/calendar.js\":\"3cbc396e152324bf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dailyNotes.js\":\"bc3d3c15d6a6a618\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dataExtension.js\":\"722075f9cfa175fc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dateScrubActions.js\":\"53b3eb0493d25aac\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dateScrubGesture.js\":\"63b713166dda3ba6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6deae5d0b2e89c64\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ed04263f2f2e46b0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/deletionGuard.js\":\"49295c4023e056e9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dueQuery.js\":\"01fa75b9e6f75749\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/index.js\":\"47b1b02a994ed482\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/landing.js\":\"613a02d454502e2e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/localSchema.js\":\"557304fb06c00922\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/referenceDateAdapter.js\":\"71405f7aaf1bea89\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/rescheduleAction.js\":\"8e01f846bb5996bc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/schema.js\":\"4a04734bd1f3c07e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/spreadBlockDates.js\":\"a658bc5a59932f22\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/spreadDatesAction.js\":\"0a68ba1abc6bf858\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/today.js\":\"34944ae29519b8e0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a6cb1b7ecec2d4c4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"825edf39c44fed61\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/audit.js\":\"a7fb86dabad65c2d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/auditAction.js\":\"7b670b6ee9836616\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/auditRanges.js\":\"9f39e9b9e35896ad\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/diagnosticsSource.js\":\"1e5556b27e6b5117\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/divergenceScan.js\":\"100a5183f9df1fd9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/index.js\":\"2d1398b92ef5a2c8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/propertyChildrenChecks.js\":\"be97a561572ffbd3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/referencesMirror.js\":\"940121810158c0f2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/rowJson.js\":\"bba5fcb06917e69d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/schedule.js\":\"25c89c36bc4c3d77\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/store.js\":\"dd9a47c457836743\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-maintenance/action.js\":\"107f6a0990124c47\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-maintenance/index.js\":\"8d082bdd40eb53a2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-maintenance/plugin.js\":\"c0e190a4ed40bb3a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a32d3a2804731831\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/actions.js\":\"5bd35b440d2ade50\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/changeMarker.js\":\"50aa8b698da89711\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/diagnostics.js\":\"9156e525cc2891b3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/fileSystemAccess.js\":\"ef22f8e6ac567f79\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/filenames.js\":\"f32febeb5be43708\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/index.js\":\"f84bd6687b58c04c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/mirror.js\":\"9169febf7707471e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/runLock.js\":\"7e45d0dd28c4a4e2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/runtimeHealth.js\":\"12c9786e5e2b75e3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/schedule.js\":\"1c24046dc9cf113a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/store.js\":\"2472314a6c9d87df\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/default-themes/index.js\":\"168f58be8897371a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/default-themes/themes.js\":\"fd12b8f6e4b4caa3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/diagnostics/facet.js\":\"9adddc078835b957\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/diagnostics/useDiagnostics.js\":\"c5bf9d08f5e7f036\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extension-prompts/dismissals.js\":\"5c6e94692f73e40a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extension-prompts/index.js\":\"cea36a01d29287a3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extension-prompts/status.js\":\"96e74f468a16c5b6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extension-prompts/store.js\":\"e6a406659b94bae6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"397965589fa0c85c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fcc8c14cc2c21877\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/actions.js\":\"48c3c1029bd75968\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/config.js\":\"c8e58c1a0705e8e2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/dataExtension.js\":\"3e5a8af8b976ca44\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/effect.js\":\"1f88e9fb34e8748f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/index.js\":\"a9cb4c6e1b182f8b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f918ebad4c2bab8a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/useToggleTree.js\":\"99925f540b722e84\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/ExtractTypeDialog.js\":\"d175d197d7de22d5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6268bc354443a173\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/PropertyShapePicker.js\":\"bb8ab4063be54cca\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/action.js\":\"9bbd06898f84a5f2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/index.js\":\"68f1636f3c44c685\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/FindReplaceDialog.js\":\"8006f27f47f78fd4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/HeaderItem.js\":\"1d56d778c8f98a19\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/dataExtension.js\":\"aa9c6febd27da8e2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/index.js\":\"8de8cb0eb8199e6e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/search.js\":\"b21b91a9ab5001f1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/toggleStore.js\":\"af322ee1b7cf5637\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/LocationPropertyEditor.js\":\"fd9a4966740058a1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/MapView.js\":\"8139e9ab9b4bbf45\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/blockTypes.js\":\"33bfadc6cc98f0a2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/codeMirrorExtensions.js\":\"a38f5e3c6c08da05\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/createOrFindPlace.js\":\"0a95312cc1808ef5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/currentLocation.js\":\"80ad4c9f17598fc4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/dataExtension.js\":\"cd60097d80055818\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/geoContentDecorator.js\":\"6f59cb83aa4a6a48\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/googlePlacesClient.js\":\"630fc66f4d44db7f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/index.js\":\"907747e82dd2f82c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/locationsPage.js\":\"14326d1d8883e9db\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/mapViewport.js\":\"02f18e3fc1cae8eb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/pickCurrentLocation.js\":\"70947f81442b27be\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/placeAutocomplete.js\":\"7deaa9fe9b1313e5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/placeNameCollision.js\":\"a9ba81cd8fbe1d42\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/properties.js\":\"514c46fb60267b71\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/propertyEditorOverrides.js\":\"5e52f5a7efa6c947\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/query.js\":\"6b52df8eddb49bb5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/usePlaceSearch.js\":\"b76a830df0f2193e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5c2a69308c489e1b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7e2d34f9e5b97325\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3f234ade19509ea1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/config.js\":\"781c4ed6b7fe8525\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/dataExtension.js\":\"13e6fc07b42e0eeb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/facet.js\":\"99229b95b5f29665\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/grouping.js\":\"753be936d0cba7cf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/index.js\":\"aa5b5bc45a541d3f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5d354f5f15bc641c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/query.js\":\"1f67ea06e98978f9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/resolveConfig.js\":\"6ea62bbc8d91c612\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3876a40663c8fff8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"21bd72b6a1a90e68\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/HtmlDocumentContent.js\":\"fb4327e8cc3224e9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/HtmlFrame.js\":\"fc8ed74e88e42899\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/actions.js\":\"e6a67c319af60add\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/blockType.js\":\"0aa96e0f1e874ce7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/confirmRunScripts.js\":\"8923a2aff0b35d06\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/dataExtension.js\":\"37f25013f4937825\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/frameAnnotations.js\":\"1cdde909ef1f4d4a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/frameDocument.js\":\"c79a76bc65611ced\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/frameTheme.js\":\"1cd7ce945d7150fb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/index.js\":\"b46707d410fbd6f1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/scriptConsent.js\":\"ab4ae34f5a42b006\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/sourceMap.js\":\"d0f713d61f7b2664\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/useDocumentScripts.js\":\"ec7f753bf255eece\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/index.js\":\"2084eea98bff8f80\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/record.js\":\"c4f36f61b6c239f1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/recordStore.js\":\"20d8a96bd6f200df\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/responsiveness.js\":\"92badccad4fdda24\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/schedule.js\":\"617ffd6eb5e0d542\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/sessionContext.js\":\"270bbea5109a1282\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5e95eb8a4e7e8ef2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7f5b3ae4173a5f0e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/actions.js\":\"0d21b79eee3e8099\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/config.js\":\"7d5c84eca494b916\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/dataExtension.js\":\"6cb618003e910970\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/effect.js\":\"46e682ef6a85788b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/index.js\":\"f601d466be65d7a7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/keyCapture.js\":\"4d1b5fbd078a0136\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/overrideStore.js\":\"42049f2193d15792\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"cfbd0eb2b689ca4b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/HeaderItem.js\":\"d422b7eba451a9e7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/LeftSidebar.js\":\"4c03c103ca66a1f3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/actions.js\":\"24cc335bf16980e7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/facet.js\":\"b0e8eed4fc292186\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/index.js\":\"e4fae4d2b817a1fc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/shortcuts.js\":\"230d5d6e46e437e6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/toggleStore.js\":\"2f3feabc4c7b78d6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/merge-blocks/MergePicker.js\":\"d49e7cb0cfd208f9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/merge-blocks/index.js\":\"1674f1f778829e5c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/merge-blocks/mergeAction.js\":\"56f392edc0eb5ce9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/merge-blocks/strategy.js\":\"1c75c0511857767c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/Button.js\":\"504f15814d614d42\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d538a7d2e33205f1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/defaultItems.js\":\"55089e5a2856ef50\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/facet.js\":\"d3e5d8d2355aab76\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/index.js\":\"c2b26649e9682592\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"130bfd45d452757b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/actions.js\":\"05976ba1ee380c08\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1e1970efdb44578d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b6c59260e5d86322\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/index.js\":\"f3a23478f6e4e747\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f26409c87b40e270\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d91c8efad5dfd2ed\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/contextMenuItem.js\":\"e33283a70fdf9b98\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/index.js\":\"200a557b87fe7c76\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/moveAction.js\":\"11d9b343be17f2ea\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/moveBlocks.js\":\"7946c8000af7f601\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/selectionAfterMove.js\":\"b5508249ac8c1477\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/TutorialBanner.js\":\"6d861dc55445f03c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/action.js\":\"b5408c7b67c266f8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/bannerDismissal.js\":\"b7bdd3c1dd657076\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/documents/cheatSheet.js\":\"5d7070316119b6ef\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/index.js\":\"30c21f70eb3ffb20\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/keys.js\":\"1bd91d26f08cba84\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/landing.js\":\"4989aaf217a4f860\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/outline.js\":\"ea567f387229eec9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/seed.js\":\"40623a8fa52e9ee7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b3bee0610d061e66\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/analyze.js\":\"17c2455aca0fbd75\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/diagnosticsSource.js\":\"c74af2e4ab91ea44\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/index.js\":\"5305e22e83310b8b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/load.js\":\"56ae558b2791da40\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/monitorRun.js\":\"08092b8f142ab576\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/schedule.js\":\"95173f62b91f3db0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/series.js\":\"174334a095c4efaf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/store.js\":\"cc5f0e898d2d46d8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/trendAction.js\":\"c5fdd192b6d54f57\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/verdict.js\":\"817715455e181634\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/plain-outliner/clickToEditAction.js\":\"feff0c090b88dafa\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/plain-outliner/index.js\":\"b9faf4784413ebe5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/plain-outliner/interactions.js\":\"eff7e409f2cd9f73\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7d0e05febcb4303f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/MigrationGate.js\":\"bbaafecefe44cdfd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/MigrationGateDialog.js\":\"1ae42895efae7701\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/action.js\":\"ef803b972acab069\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/index.js\":\"1c8eb24011783365\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/localRunMessage.js\":\"9d29a1dad57c12b1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/plugin.js\":\"689e2792fd85ff9c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/progressReport.js\":\"59ac34880a07ecbf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/sweepProgress.js\":\"ac7bdd1216ee9cd6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/FieldRowRenderer.js\":\"de1784692b0b5215\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/ValueRowRenderer.js\":\"6b42f2a4b958f01e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/actions.js\":\"92d57a94b1e05d75\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/autocomplete.js\":\"5257c931023a0605\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/fieldRow.js\":\"793d3e37f04a9a6f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/index.js\":\"ba2c7688751fc6a5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/referenceWarning.js\":\"1867c55f0bf6162d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/valueAutocomplete.js\":\"052b75603aeb429d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/valueSchema.js\":\"1e3e081f3849ac0e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/HeaderItem.js\":\"420ff42beb75d14d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/QuickFind.js\":\"510b324a0bfd19a9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/index.js\":\"1a5779d91171a2cb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/recents.js\":\"12f27a98ef386e91\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/resultItems.js\":\"9ca7a179d0087bb8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/selection.js\":\"a0b62e5a783613a8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/toggleStore.js\":\"837fb63ca0bb3036\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/HeaderItem.js\":\"d54b477ab58cf226\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5039b11e1cbf0448\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/grouping.js\":\"17bb6794bc7f89af\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/index.js\":\"fa098feae4fc2bc2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/target.js\":\"f4e903cf8210ed85\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/codeMirrorExtensions.js\":\"b763abc6d2b73825\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/contentPrefill.js\":\"cb07e7221fd29ee9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/dataExtension.js\":\"b710dffff16aa4a8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/index.js\":\"47cf19d51ee5d4ae\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b7aa1e39378e7984\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/invalidation.js\":\"e6271f83db12e43b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/localSchema.js\":\"629e8e5c65f13782\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/blockrefs/index.js\":\"d7d17663f026a66b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"477a60b92b208aa8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/index.js\":\"68be7a8a0fc83c92\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/referenceNode.js\":\"d665707b9dd683b1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e345bc4bb767b0dd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"4ee640b95c9b4a11\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/wikilinks/index.js\":\"2628e3bcdc1f191f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3cc26c0fa9a0b537\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"434dd513909add09\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/mergeRetargetProcessor.js\":\"d2e971ddb74f2a76\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/parseFence.js\":\"489de2c263fd7bc2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/referenceParser.js\":\"894e4b768d34a55b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/referenceProjection.js\":\"823bfd9118e24a5c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/referencesProcessor.js\":\"79071ff667475143\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/renameProcessor.js\":\"e418629ee650280e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/spanReplacement.js\":\"842d6ed1e2a631e9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/rich-paste/htmlToOutline.js\":\"9b40522053776ccc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/rich-paste/index.js\":\"b9613b774b9f31cf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b19965a30c3c5b2a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/rich-paste/pasteDecision.js\":\"74733b391e0e63b6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/action.js\":\"8b161e17b85f9244\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/blockIds.js\":\"6d5aa0cf8fcbe3a7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/content.js\":\"1d3491ac78e4b40d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/effect.js\":\"0a766e89551a52ef\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/ids.js\":\"7253b8db6ae3936b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/import.js\":\"9827b0ee99be6637\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/index.js\":\"7057236c241e1e90\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/plan.js\":\"4323201427ac9b07\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/plugin.js\":\"b67e0672966f6b5e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/promotion.js\":\"2e398c09926782a5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/properties.js\":\"9ff1491601a0f06c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/references.js\":\"402fb0046fbfcbd8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/report.js\":\"fd4c9e71f8dd73eb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/roamMemo.js\":\"da80ecb7834ba184\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/runtime.js\":\"824c985e259121b7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/schemaReconciliation.js\":\"f67268aedef41a2d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/srsMarkers.js\":\"b3e7c0844a48b83a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/todo.js\":\"d824d9bbff7eb081\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/typeCandidates.js\":\"d57005f71c8d7fd3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/types.js\":\"73ed51b87c7f5b49\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/search-health/index.js\":\"3d41ce82c29d5923\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/search-health/store.js\":\"f9b78766ebc80cc0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/HeaderItem.js\":\"b413ab70905d1e09\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"246d6f62fe06e42e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/index.js\":\"62fc58e8feae1608\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/model.js\":\"528fbaeaa867ebab\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/toggleStore.js\":\"c0032e4d358636b9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/useKeyInspector.js\":\"7b18212807d0fa98\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e8af676908dda9a4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/ShellDecorator.js\":\"55de7fc897b784af\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/actions.js\":\"d68a94ecfb3b17e8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/exclusionsFacet.js\":\"89f5566d23cc1b34\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/index.js\":\"01ce75bb3ec8ebec\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/shell.js\":\"8a43ef211fff5cdb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/surface.js\":\"d0660d849b8f5d72\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/walker.js\":\"8c93b1b4e2d15031\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e422eb8be073b607\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/dataExtension.js\":\"114932bba584e79c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/index.js\":\"7cd94cb9bdb014c2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/indicator.js\":\"3e2c5fd95b76bb62\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/moveSrsState.js\":\"42d04321cd52a3f2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"fb1ed45108fda11d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/scheduler.js\":\"650446b48ba3ed58\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/schema.js\":\"07a700123bd63466\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a8465af5a89dca31\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/srsClipboard.js\":\"d53e7e4964cb32cd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"0ace0c6453d579d5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/DailyNoteReviewHint.js\":\"eb2ff7280f8fd7c1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/DeckPicker.js\":\"673cb0063a99142b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/ReviewControls.js\":\"171810a4976d64ee\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/ReviewDeckRenderer.js\":\"33dc8d08cd1f614a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/ReviewSession.js\":\"74575cf3e30dadd1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/actions.js\":\"2dc3eb39f9f15043\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/archive.js\":\"654b82d5eea6f080\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/dataExtension.js\":\"8352d51c37930204\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/deck.js\":\"9a0f3aee91a4bdad\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/dueQuery.js\":\"81ad6bac974165cf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/gradeDecision.js\":\"3d4dc6a3a501b456\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/index.js\":\"8ea040a29a3a31e5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/keyHints.js\":\"10136166f9582779\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/reviewCardLayout.js\":\"ef370ca2fa442cf2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/reviewProgress.js\":\"5536590069217c3c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/schema.js\":\"fa28eebb64825964\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/useDueCards.js\":\"80df2fb4a1fb827a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/startup-metrics/index.js\":\"b7729db0df6bdb89\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/startup-metrics/record.js\":\"b1c3256e10042a71\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/storage-persistence/index.js\":\"29097dfe040db499\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/storage-persistence/persistenceStatus.js\":\"100a3fdf5aedfe14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/storage-persistence/requestAction.js\":\"31a40181768b0053\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/supertags/TypeChipsDecorator.js\":\"d1aff0fc2ba6d12e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/supertags/codeMirrorExtensions.js\":\"d47fd3b14df96ece\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/supertags/index.js\":\"4ae03d17477687f2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/supertags/typeAutocomplete.js\":\"6991d234fb530c91\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e86ea3967c09fe25\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/actions.js\":\"6f621ba9532b196f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/anchor.js\":\"a56ddfcd273eb985\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/events.js\":\"52df5aaf47794a0e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/gestureActions.js\":\"51e1eb1090558ee1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/index.js\":\"6575df070a6b7c67\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9198daa8b0b3d46d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/sync-metrics/collect.js\":\"68a21d69bdc78d34\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/sync-metrics/index.js\":\"dd2c61d5ed90a116\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/sync-metrics/record.js\":\"114f0e60b93c2ac9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/RejectionDialog.js\":\"a312750c08cf7fe9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9d19095ead49a1f7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/index.js\":\"37e19c7a63486fde\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/model.js\":\"a7f485a9e0f33544\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/queueCounts.js\":\"6281384203fe1d5f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/rejectedHelpers.js\":\"17d40280c6018da5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/rematerializeAction.js\":\"e6dfcc52ab57c14f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/useHysteresis.js\":\"79a712e4ec6c416c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/theme-toggle/effect.js\":\"834a3a746b5427ae\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/theme-toggle/index.js\":\"c7337594d6113751\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/theme-toggle/theme.js\":\"7e33996f9cd9dbfe\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/todo/actions.js\":\"15908daece6846d9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/todo/dataExtension.js\":\"45411a7e77f231d7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/todo/index.js\":\"5ba700c70740ebc9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/todo/schema.js\":\"50ded5d0ada9a8ae\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/TouchSelectionLayer.js\":\"db8851094b1a63c5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/actions.js\":\"be8f2e512c097b5b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/defaultItems.js\":\"b46de0aefb9ab3f5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/facet.js\":\"31467118828af0ad\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/holdRecognizer.js\":\"db284fbc48cd1fb2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/index.js\":\"b412991cee2f6a3a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/update-indicator/UpdateIndicator.js\":\"e9dfcd2bfff4d3c3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/update-indicator/index.js\":\"1c476ac7fc01a672\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/update-indicator/loadTimes.js\":\"5e28ee98e4e736ac\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/VideoNotesRenderer.js\":\"4c7f8f7d2a92ac9c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/VideoPlayerRenderer.js\":\"aaf169cd5852f4b2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/VideoTimeStamp.js\":\"7fedebd6f88cfec4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/actions.js\":\"60fb22a064f973a2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/index.js\":\"af467a87e8fae769\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/markdown.js\":\"2136fbfb941b7761\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/notes.js\":\"1cf9029c3ee2988d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/registry.js\":\"c33b437b728961af\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/remark-timestamps.js\":\"cdfb4bc3028bfa7e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/view.js\":\"4b8e49654db6bf76\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-link-hints/LinkHints.js\":\"95846da2602adb90\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-link-hints/index.js\":\"4c8f752f8ae32faa\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-link-hints/model.js\":\"ccff3bfa656857cf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-link-hints/settings.js\":\"c8271bf8e14103fb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-normal-mode/actions.js\":\"55bf9245cdbfbae2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-normal-mode/index.js\":\"44a681248baed56d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-normal-mode/interactions.js\":\"825dd11edb62f717\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/workspace-header/index.js\":\"00b7fdb491c66ba3\",\"/knowledge-medium/pr-preview/pr-1811/src/registerServiceWorker.js\":\"9e7a395c77591dca\",\"/knowledge-medium/pr-preview/pr-1811/src/requestPersistentStorage.js\":\"24c458d095162b95\",\"/knowledge-medium/pr-preview/pr-1811/src/services/authRequestDeadline.js\":\"14d0c23bab5be5e8\",\"/knowledge-medium/pr-preview/pr-1811/src/services/authStorage.js\":\"11e3aedfbd40a0a3\",\"/knowledge-medium/pr-preview/pr-1811/src/services/powersync.js\":\"7d5caf6c5fe3451a\",\"/knowledge-medium/pr-preview/pr-1811/src/services/supabase.js\":\"c41384ea741f927b\",\"/knowledge-medium/pr-preview/pr-1811/src/services/uploadErrorClassifier.js\":\"ec1fef7796487fc2\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/ActiveContexts.js\":\"1a1c2446db706bbf\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/HotkeyReconciler.js\":\"b002a3dfe633e275\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/WipeLocalDataDialog.js\":\"87a8d6f1185912a4\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/actionDispatch.js\":\"01e7373c68709169\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/actionRefItems.js\":\"2a1f19a3997b5585\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/applyKeybindingOverrides.js\":\"5d5e6d9101878c2d\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/blockActions.js\":\"c9e40ef131d06b57\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/canonicalizeChord.js\":\"bc6594da44d67195\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/defaultContexts.js\":\"b3865349a8aab14b\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/defaultShortcuts.js\":\"400afd6968822c75\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/effectiveActions.js\":\"0534980aec939e0e\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/gestureAction.js\":\"431e80b3406157b1\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/gestureBinding.js\":\"22946397f962cfea\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/holdRegistry.js\":\"d1ba58c7a0971539\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/keybindingConflicts.js\":\"d553d8fb12a1b40b\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/keybindingOverrides.js\":\"a57300a6bad72c2f\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/pointerAction.js\":\"07ee607347de6f1b\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/resolve.js\":\"b6d1bd1b5874b615\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/runAction.js\":\"9e8f964645e5f995\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/sequenceMatcher.js\":\"e9e8966c3d0b0da7\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/types.js\":\"76d79e6e17cc971b\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/useActionContext.js\":\"0cdc4e794548c392\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/useActionDiscovery.js\":\"0808947af0df1fd7\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/utils.js\":\"95f9ee84e09c11f2\",\"/knowledge-medium/pr-preview/pr-1811/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1811/src/sw/bootStore.js\":\"81a3fad4a8f55417\",\"/knowledge-medium/pr-preview/pr-1811/src/sw/previewDatabases.js\":\"ec3f3999e56dcffa\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/byteTransform.js\":\"99d7c425a08d311b\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/attachmentCleaner.js\":\"07d6fe25a131395b\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/attachmentParts.js\":\"08e7ed42bfda897e\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/bundleParts.js\":\"748de3f80e4b6e92\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/bundleRecord.js\":\"ef1f0e6f420734b8\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/manifest.js\":\"b181999f9d4d6b91\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/takeBundle.js\":\"c7c0a0d3bc85ce3e\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/verifyBundle.js\":\"2325410dffe848ab\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/cleaningStage.js\":\"4a04d698cd536660\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/conversionKey.js\":\"2f168753b9dcb245\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/conversionServer.js\":\"b434548823043a76\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/flip.js\":\"5c96d37a126ac346\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/flipAttempts.js\":\"d1fda2d26a842de1\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/pages.js\":\"8b35fc57a335acaf\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/preflight.js\":\"58795ff036b53f26\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/reseal.js\":\"3b262edbafe716ec\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/runConversion.js\":\"0b6591eeeaa608a6\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/runLock.js\":\"ff30af5a51f9d5e4\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/sealing.js\":\"8e91f1b9ad2db890\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/sealingStage.js\":\"a6041d58768607e8\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/stage.js\":\"729f89f1ed773fe2\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/verifyReseal.js\":\"6bbbcd3cf8d1384b\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/aad.js\":\"c5848623f1b17aed\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/aead.js\":\"6d1109f28f51a44c\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/base32.js\":\"ca0fc78ae5244770\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/base64url.js\":\"b40c4df93a7fc673\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/binaryEnvelope.js\":\"ab7549a63f971075\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/byteAead.js\":\"7e6bfe65798f8432\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/canary.js\":\"af51680f3a594516\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/contentHash.js\":\"557aebca8b4f8248\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/contentKey.js\":\"c78a889a02c1769f\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/derivedIdNamespace.js\":\"0aa033ef0618d97a\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/envelope.js\":\"ea8ac09360143128\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/hex.js\":\"3d02138ecf930c79\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/sha256Hex.js\":\"b5d33fbfae56d90d\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/workspaceKey.js\":\"678017cac70d19c4\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/conversionState.js\":\"107a85b71c9e7919\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a5083666eefdd98b\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/flows/pastedKey.js\":\"77267babe09268fd\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"86059a77f48f3329\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8233a8849fb22d95\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/keyStore.js\":\"8717d4a1bac06a9b\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/mintWorkspaceKey.js\":\"65b384594580256e\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/modePin.js\":\"38696b0c7a4e424c\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/openWorkspaceKeys.js\":\"1284815dee00eef8\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/resolveWorkspaceEntry.js\":\"e8c6aacb67577db9\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/resolver.js\":\"cc5487ac389baadf\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/workspaceAccess.js\":\"5be3c64500abc594\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/transform.js\":\"134c39cac40268cc\",\"/knowledge-medium/pr-preview/pr-1811/src/themeBootDefaults.js\":\"4b6a49f050f85544\",\"/knowledge-medium/pr-preview/pr-1811/src/types.js\":\"76a52289ebd2eb08\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/ClientLocalSettings.js\":\"f9a75639324c5d34\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/abortableSleep.js\":\"c915cbbad0ed0c57\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/array.js\":\"c572a2b3e5d6b2c8\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/backlinkAutocomplete.js\":\"8490458803d348b6\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/blockCrumbs.js\":\"655e8ee07ddf606b\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/blockrefAutocomplete.js\":\"409318bdc9ab428b\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/cadencedIdleJob.js\":\"4968dbead02029f7\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/callbackSet.js\":\"828eae033090df2d\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/clientId.js\":\"b9ca3c19efbf01a2\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/codemirror.js\":\"ee738ebe76aafae0\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/codemirrorCompletion.js\":\"63eae99392100b49\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/copy.js\":\"5877ff6fbf632f50\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dailyPage.js\":\"71b98553cb094c0b\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dbForensics.js\":\"cdcf3b89dc326476\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dbForensicsHooks.js\":\"cc6e343870bab1df\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/deleteBlockThroughUi.js\":\"19b664e5422ef460\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dialogs.js\":\"b013c8525ca93179\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dom.js\":\"65a5d24f1254c036\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/downloadBlob.js\":\"a409b8e7da3bc419\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/exportSqliteDb.js\":\"6ff73705bcc734c1\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/fileSystemAccess.js\":\"f1ab1d993aa916fa\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/flipSlide.js\":\"c64e996f77961fcf\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/fnv1a.js\":\"e28038305daefce1\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/formatBytes.js\":\"ddcd26c53fc9845f\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/fuzzyRank.js\":\"5e0a00b8cc321e90\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/idbKeyedStore.js\":\"18d8c3a105d06fdd\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/idleCallbackPolyfill.js\":\"ae2b8b1e3e21ba43\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/keyboardAwareScroll.js\":\"fe3dcb6a492a0b31\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/keyboardViewport.js\":\"ac4b9eda9d8827df\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/lastWorkspace.js\":\"0076b4322f6914d5\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/layoutColumns.js\":\"8de24bc9925699d5\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/layoutSessionDom.js\":\"3de06df7799dd3b0\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/layoutSessionId.js\":\"f3563ac85279408c\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/linkClickGestures.js\":\"c69236b47ed794f2\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/linkTargetAutocomplete.js\":\"038a75184e447ea4\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/localDbCorruption.js\":\"1a69bd0557138dcb\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/localDbRecovery.js\":\"9af86c439ea162d4\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/markdownParser.js\":\"00d580b4d9e1d92a\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/memoize.js\":\"8a4ecc92c428bad7\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/nameFieldCommit.js\":\"011a120f49c0cd9f\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/nameList.js\":\"f56ea13f322fcd40\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/navigation.js\":\"48802a72c971bff6\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/omnilinerNamespace.js\":\"3359d368e6c464d5\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/opfsPageScan.js\":\"8cc72c90c5c8e4dd\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelClearance.js\":\"e763e64f0dbf4a8f\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelHistory.js\":\"5222f50344cecf27\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelLanes.js\":\"ed02a7097359f3c7\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelLayoutProjection.js\":\"c2d4f0250bbfbd95\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelScrollAnchor.js\":\"0c5e696a1f717cff\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelUrlFlags.js\":\"9e2d863614d3b8f5\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/platform.js\":\"606d3d743b06d43e\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/pluralize.js\":\"06521112cee15987\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/propertyCreation.js\":\"36539445729f9ad3\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/propertyNavigation.js\":\"29cc0a9fc48498ed\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/propertyValueContext.js\":\"8c991be219083340\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/react.js\":\"23dbf2b9b6ca6251\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/relativeDate.js\":\"b743e981e8397477\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/relativeTime.js\":\"8dfe12aa2c4dcf85\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/renderScope.js\":\"fd4e759c84cadb8b\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/resolvedThenable.js\":\"93a02da79a6257ca\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/routing.js\":\"e1ed7ae3e28dea3c\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/safeMode.js\":\"11ccc243a78d11d2\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/scheduleIdle.js\":\"c86ddd32cddadc89\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/screenWakeLock.js\":\"0f4b53ac1670cd05\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/selection.js\":\"6ed192371be344c2\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/softKeyboardGrab.js\":\"04a66e19aa3b9214\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/startupTimeline.js\":\"1f167e1b91b1e446\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/state.js\":\"35c056c8fb1f6124\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/string.js\":\"26c20839c870902a\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/surfaceZoom.js\":\"fa3cb31357272d5b\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/time.js\":\"cec6956166e15b59\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/toast.js\":\"d060c482c1deec50\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/toggleStore.js\":\"ab9de82e73cfd1e3\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/untilStopped.js\":\"2584a9014d880368\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/userActivity.js\":\"1ddcc72275ba747e\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/viewTransition.js\":\"4a62a5df9823bf02\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/viewport.js\":\"ad5b1507daa84db5\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/webLock.js\":\"9b3d41324651a4ac\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/workspaceRecovery.js\":\"27e33dc691017e81\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/workspaceSnapshotStore.js\":\"d2d69373c216271c\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-compiler-runtime.js\":\"703a58e76a4e8426\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-client.js\":\"c4b1d898a40afed1\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-server-edge.js\":\"5bfb1003071e0388\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-server.js\":\"6f78ddfe7f4f574d\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-static-edge.js\":\"24c89949e0278b8d\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-static.js\":\"016b2016692c0d1b\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-test-utils.js\":\"b06f7091a0033e44\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom.js\":\"ffd9e87fea7d57ce\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-jsx-runtime.js\":\"987fe57c84571904\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react.js\":\"0a293fa2efa56e1d\",\"/knowledge-medium/pr-preview/pr-1811/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1811/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1811/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
