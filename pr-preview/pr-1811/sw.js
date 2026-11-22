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
		buildId: "4056d6cd9845-8e865bef",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1811/\":\"ae7a356cff7b9ae7\",\"/knowledge-medium/pr-preview/pr-1811/index.html\":\"ae7a356cff7b9ae7\",\"/knowledge-medium/pr-preview/pr-1811/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1811/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1811/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1811/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1811/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1811/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1811/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1811/assets/FacadeVFS-Cb2izhVs.js\":\"804e75a17ceaf053\",\"/knowledge-medium/pr-preview/pr-1811/assets/OPFSCoopSyncVFS-DVSka-Dy.js\":\"fe92fd2ecfe140f5\",\"/knowledge-medium/pr-preview/pr-1811/assets/OPFSWriteAheadVFS-BTIgEPsI.js\":\"2106ec835c25f984\",\"/knowledge-medium/pr-preview/pr-1811/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1811/assets/wa-sqlite-DB2-IOWY.js\":\"2fc5aa399f988b33\",\"/knowledge-medium/pr-preview/pr-1811/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1811/assets/wa-sqlite-async-oKEFhR-W.js\":\"447507a71e90145f\",\"/knowledge-medium/pr-preview/pr-1811/assets/worker-bVIcL_Ne.js\":\"988d08abc98f33c0\",\"/knowledge-medium/pr-preview/pr-1811/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1811/chunks/app-C76FqX8A.js\":\"941565ef326a984c\",\"/knowledge-medium/pr-preview/pr-1811/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1811/index.js\":\"f55c5d76a28b2a4b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1811/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1811/assets/AccessHandlePoolVFS-CxlbizAF.js\":\"afa726852f692800\",\"/knowledge-medium/pr-preview/pr-1811/assets/IDBBatchAtomicVFS-Bv4IcB6H.js\":\"370bfacd1369e418\",\"/knowledge-medium/pr-preview/pr-1811/assets/MemoryVFS-De6NEtq_.js\":\"bdc4dbd628c3576c\",\"/knowledge-medium/pr-preview/pr-1811/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1811/assets/mc-wa-sqlite-DKyih3eo.js\":\"440630ab696170a8\",\"/knowledge-medium/pr-preview/pr-1811/assets/mc-wa-sqlite-async-C07TJoW9.js\":\"7334227c37e037c2\",\"/knowledge-medium/pr-preview/pr-1811/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1811/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1811/chunks/AccessHandlePoolVFS-7r6_OUX2.js\":\"bb133df556e34b19\",\"/knowledge-medium/pr-preview/pr-1811/chunks/FacadeVFS-CwZ2O6NF.js\":\"c5701b98f76d4711\",\"/knowledge-medium/pr-preview/pr-1811/chunks/IDBBatchAtomicVFS-CmPUr1qp.js\":\"1cefa71b5d83f769\",\"/knowledge-medium/pr-preview/pr-1811/chunks/MemoryVFS-CWzfWPxO.js\":\"44965f9bbe0307b7\",\"/knowledge-medium/pr-preview/pr-1811/chunks/OPFSCoopSyncVFS-BnKoskzt.js\":\"e8be6fffa3d81b63\",\"/knowledge-medium/pr-preview/pr-1811/chunks/OPFSWriteAheadVFS-De-YeHCV.js\":\"94c2c656b5f6ab45\",\"/knowledge-medium/pr-preview/pr-1811/chunks/Preview-CEVSqgDB.js\":\"2761ae22c206b71a\",\"/knowledge-medium/pr-preview/pr-1811/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1811/chunks/card-B8dIL16B.js\":\"0e49255a762fea53\",\"/knowledge-medium/pr-preview/pr-1811/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1811/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1811/chunks/dist-BmSgonRr.js\":\"41f7f9b581917ce6\",\"/knowledge-medium/pr-preview/pr-1811/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1811/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1811/chunks/mc-wa-sqlite-1_bDCtIR.js\":\"3908877d3ef79db5\",\"/knowledge-medium/pr-preview/pr-1811/chunks/mc-wa-sqlite-async-Da7g4t27.js\":\"9c38f221908aa2e2\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-8e5k5WxX.js\":\"c235eedc804cc41a\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-BZJP60IP.js\":\"ebf685ebb80cec2e\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-BoQds6ud.js\":\"7a8a796dda55d6c5\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-CNZeUc-q.js\":\"4c5cb0c2c2506aa0\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-D3uS118b.js\":\"665fa49b07d78943\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-DBmR8xTQ.js\":\"92d3f43da9143e1c\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-DGxdGHiD.js\":\"006b85c468796bb6\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-Dv-_4ePY.js\":\"e5c28f9df3474ebf\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-dom-server-legacy.browser.production--Kkz191M.js\":\"976c07ceae4a6549\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-dom-server.browser.production-TKVUNKJt.js\":\"8d6e7c095cfd40fa\",\"/knowledge-medium/pr-preview/pr-1811/chunks/react-dom-server.edge.production-BDLkO8vV.js\":\"d22d7c3459015691\",\"/knowledge-medium/pr-preview/pr-1811/chunks/server.browser-BX1tNltf.js\":\"581c7f1d17b935e9\",\"/knowledge-medium/pr-preview/pr-1811/chunks/textarea-DMfrr4uf.js\":\"42bbb9797a46717e\",\"/knowledge-medium/pr-preview/pr-1811/chunks/ui-DBxrY3sj.js\":\"21c3fc7ad31b621c\",\"/knowledge-medium/pr-preview/pr-1811/chunks/wa-sqlite-CuRZpTlk.js\":\"b4ec2c4ebdfe1275\",\"/knowledge-medium/pr-preview/pr-1811/chunks/wa-sqlite-async-BemxED7h.js\":\"f0e15de719d58e84\",\"/knowledge-medium/pr-preview/pr-1811/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1811/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1811/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1811/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1811/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1811/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1811/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1811/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1811/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1811/src/App.js\":\"e9668b76446b7d04\",\"/knowledge-medium/pr-preview/pr-1811/src/appUpdate.js\":\"9f0cc127d223f156\",\"/knowledge-medium/pr-preview/pr-1811/src/appVersion.js\":\"dcff94a1e28bc62a\",\"/knowledge-medium/pr-preview/pr-1811/src/bootstrap/initialLayout.js\":\"5f46ec400bdf8584\",\"/knowledge-medium/pr-preview/pr-1811/src/bootstrap/openWorkspaceData.js\":\"bc172ad34d43e655\",\"/knowledge-medium/pr-preview/pr-1811/src/bootstrap/resolveWorkspace.js\":\"7f798659ad76df76\",\"/knowledge-medium/pr-preview/pr-1811/src/bootstrap/workspaceBootstrap.js\":\"c37bf3ef9f6006ee\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockComponent.js\":\"1587eda351df75b8\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockCrumbs.js\":\"7def2287f65035ea\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockEditor.js\":\"cd14befe45a206da\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockLoadingPlaceholder.js\":\"da90ecf9d2e30074\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockProperties.js\":\"47ccea002ef52635\",\"/knowledge-medium/pr-preview/pr-1811/src/components/BlockSearchPicker.js\":\"a5660a928e982210\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ConfirmBulkDeleteDialog.js\":\"9b3e712443e49c57\",\"/knowledge-medium/pr-preview/pr-1811/src/components/DividerHandle.js\":\"cf23cf2a340e6f4f\",\"/knowledge-medium/pr-preview/pr-1811/src/components/DraftEditor.js\":\"4f8e5ff4adc56680\",\"/knowledge-medium/pr-preview/pr-1811/src/components/GutterPill.js\":\"d26d297b1edc8dcc\",\"/knowledge-medium/pr-preview/pr-1811/src/components/Header.js\":\"f385f17d40e188c7\",\"/knowledge-medium/pr-preview/pr-1811/src/components/LazyBlockComponent.js\":\"1f8b1b0461c7bd73\",\"/knowledge-medium/pr-preview/pr-1811/src/components/Login.js\":\"35d22da91c191fd9\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ZoomableSurface.js\":\"f4a257d7fc0896bd\",\"/knowledge-medium/pr-preview/pr-1811/src/components/editModeKeepalive.js\":\"a6f3baabf812c05d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8d2975f2051e1f93\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"452b9d6852686f5a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/RefPropertyEditor.js\":\"2d2021adb3ab0741\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/RefTargetTypePicker.js\":\"895fd8c682390c5f\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/SelectPropertyEditor.js\":\"8f22fa9359e5af03\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/TypesPropertyEditor.js\":\"705f612a65307564\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/defaults.js\":\"610e35a7d1f97550\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/kernelValuePresets.js\":\"470515d418292944\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/selectablePresets.js\":\"aca617b66b6d50b5\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyEditors/typesPropertyUi.js\":\"66f56bd57e0b1f3b\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/AddPropertyForm.js\":\"2e840ba285a7c2f2\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/PropertyPicker.js\":\"d29a4ac74aaaf343\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/PropertyRow.js\":\"3f2355dd738b75ce\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/Rows.js\":\"c0001a96a34cb366\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/actions.js\":\"9136d143a4a58c87\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/declarationOnly.js\":\"fdaba68b608ecccf\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/layout.js\":\"2ddd398e0d2fce83\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/model.js\":\"2f1bdee063ec6ca2\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/shapeUi.js\":\"0db40f2a7b154c91\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/shapes.js\":\"067f875f89925db9\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/usePropertyEditingActivation.js\":\"15d35656542ff3be\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanel/visibility.js\":\"7f0d0e395a6ee65a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/propertyPanelSections.js\":\"06ac6967481dd3d3\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/BlockEmbed.js\":\"8cc96450eafca6bd\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/BlockLink.js\":\"4b5bda76b50f0be8\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/BlockRef.js\":\"eefcd4d01e85261e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/ReferenceLink.js\":\"22d7f0a54b25fca3\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/cycleGuard.js\":\"fddd1951f276cd1a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/cycleGuardContext.js\":\"070e8dc65dede2d4\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/linkInteraction.js\":\"f821c6835a9d2faf\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/referenceLayout.js\":\"02b51912b334b0f1\",\"/knowledge-medium/pr-preview/pr-1811/src/components/references/useBlockRefAncestors.js\":\"8dad72c79a605bf5\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/BlockGutter.js\":\"e381680362ca6b60\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/BlockInfoDialog.js\":\"e9069c3f71afef3c\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/BlockTypeBlockRenderer.js\":\"8a10e195ae3da075\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/BulletHoverCard.js\":\"d50c5d0b285bb283\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/CodeMirrorContentRenderer.js\":\"fa4e1599a4eb9948\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"50b0abcfc8446d80\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/ColumnResizeHandles.js\":\"518610901b247a88\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0a58a4327ce7cccd\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/DefaultBlockRenderer.js\":\"bac54b54467c7439\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/LayoutRenderer.js\":\"99ace96ec0f056bc\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/MarkdownContentRenderer.js\":\"b5f46373b3368dc8\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/MissingDataRenderer.js\":\"89a8271ed5c9d62a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/PanelRenderer.js\":\"77d7983ca62c1723\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/PropertySchemaBlockRenderer.js\":\"27bcbadcab91af4f\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/TopLevelRenderer.js\":\"9f5abc7e6e5ef215\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/blockGutterMode.js\":\"c36e41e70f70833e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/blockTitleText.js\":\"43ab757c6ba5eda9\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/fieldCreationKeydown.js\":\"6fa5de4af62befd8\",\"/knowledge-medium/pr-preview/pr-1811/src/components/renderer/layoutRootContext.js\":\"dc9cdf63c76912dd\",\"/knowledge-medium/pr-preview/pr-1811/src/components/typeChip/TypeChip.js\":\"74f2687bd433eb9a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/typeChip/chipStyle.js\":\"ed53a2043ff11a02\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/anchored-floating.js\":\"628d90315bfdb1d1\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/button.js\":\"e40db5cf7482454d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/card.js\":\"a2fba9585a2d0f66\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/checkbox.js\":\"9b043e93744c16de\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/collapsible.js\":\"5bf016a455a73c1a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/command.js\":\"9a6ab13be9256d9b\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/context-menu.js\":\"b6753f8de0d00d80\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/dialog.js\":\"3a11bf5a33dbf0d8\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/dropdown-menu.js\":\"601d24e16f958344\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/floating-listbox.js\":\"f33ef7868699fe33\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/index.js\":\"4fa5a6011ac8841c\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/input.js\":\"00354e16f5d29afc\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/kbd.js\":\"871fb5e10584a97c\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/label.js\":\"e7414ee8217d3ac9\",\"/knowledge-medium/pr-preview/pr-1811/src/components/ui/textarea.js\":\"d2e49a5a9bd14f16\",\"/knowledge-medium/pr-preview/pr-1811/src/components/useEditModeYieldKeepalive.js\":\"e8ad12fd624468fd\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/BootFallback.js\":\"c24a8d898b7fdf21\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/FocusedRowLazyMount.js\":\"2e0b28c263465681\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/LazyViewportMount.js\":\"4828bd0a8e406fe6\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/LocalDbCorruptionFallback.js\":\"7d56c0500deedc66\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/error.js\":\"8065c2398d9e8bd1\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/lazyMountRegistry.js\":\"a37f2b45242ff4cf\",\"/knowledge-medium/pr-preview/pr-1811/src/components/util/suspense.js\":\"63db499982315355\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/CreateWorkspaceDialog.js\":\"e967155e27f1ac7b\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/PendingInvitations.js\":\"245efdc0e0f440aa\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/SyncProgress.js\":\"dfe54ecd9e9468f0\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/UnlockProgress.js\":\"a0980c0693e2455f\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/WorkspaceKeyGate.js\":\"e3c453c5fcf3c814\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/WorkspaceSettingsDialog.js\":\"68386fdae508ced1\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/WorkspaceSwitcher.js\":\"99bcf7e442eec5b2\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/WorkspaceSyncGate.js\":\"3858d6ee8e2b100b\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/ConversionFlow.js\":\"5da28a13d6cb112e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/ConversionFlowHost.js\":\"b9e6c187d6d9e977\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/EncryptionSection.js\":\"53203bfd7bb9167c\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/attachmentPrompts.js\":\"a7008aaf9ca36ca3\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a16ef9d473b3b66e\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/conversionFlowDeps.js\":\"95216107c8d345c4\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/conversionFlowStore.js\":\"d244a9fa542a4e52\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/flowUi.js\":\"426aa29fa080d64d\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/conversion/useConversionRun.js\":\"607f113f16e1cef3\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/keyUi.js\":\"3d6d2b0296faa1be\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/useCloseOnKeyLoss.js\":\"15b6ee82df91403a\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/useCloseOnServerE2ee.js\":\"9278444deaff6691\",\"/knowledge-medium/pr-preview/pr-1811/src/components/workspace/workspaceUnlocked.js\":\"54ba45a6d716a7b3\",\"/knowledge-medium/pr-preview/pr-1811/src/context/backgroundSubtree.js\":\"d1665a6495f38bed\",\"/knowledge-medium/pr-preview/pr-1811/src/context/block.js\":\"ee88bbf00f86fb7e\",\"/knowledge-medium/pr-preview/pr-1811/src/context/layoutWsContext.js\":\"0168ca0aa3e15542\",\"/knowledge-medium/pr-preview/pr-1811/src/context/propertyDisplay.js\":\"22f5d2f8e82c393a\",\"/knowledge-medium/pr-preview/pr-1811/src/context/repo.js\":\"284ba9cdd76c0458\",\"/knowledge-medium/pr-preview/pr-1811/src/data/aliasClaim.js\":\"69ac3ca574ddb08c\",\"/knowledge-medium/pr-preview/pr-1811/src/data/aliasSeatNamespace.js\":\"938f303ab1509fe5\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/blockData.js\":\"e48ef9e082cda776\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/blockType.js\":\"4d29bfd9b934b1c5\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/changeScope.js\":\"402102be8b7cd212\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/codecs.js\":\"e5ae2f88fcf7ea48\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/derivedData.js\":\"583ca17c176eb353\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/errors.js\":\"be22ef1fc0f1dc64\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/events.js\":\"ca2cf4324ec6c859\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/handle.js\":\"fdfac5c75b6e2738\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/index.js\":\"2785a9be9c0549bd\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/mutator.js\":\"828bf8842d364bd8\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/processor.js\":\"5bcbaf45f2dfcd35\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/propertySchema.js\":\"ed082e50e8585c7e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/query.js\":\"0585f1cdb64b050b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/sameTxProcessor.js\":\"865e74973efd0c6e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/schema.js\":\"fdfac5c75b6e2738\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/tx.js\":\"fdfac5c75b6e2738\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/typedBlockQuery.js\":\"82250c646f4d6e28\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/user.js\":\"a1f01bc4c7f07485\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/valuePresetCore.js\":\"2afa8195ba59dab1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/api/valuePresets.js\":\"fe7d04470e30eeb7\",\"/knowledge-medium/pr-preview/pr-1811/src/data/attachmentCleanerIOVerb.js\":\"2c90a45f19b06d81\",\"/knowledge-medium/pr-preview/pr-1811/src/data/block.js\":\"960e72c1ee998d83\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockCache.js\":\"c60da7298208330a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockId.js\":\"e51f830c9a01c865\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockLiveness.js\":\"8f57cb993eece52b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockMerge.js\":\"42f6cdb527133b36\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockSchema.js\":\"b8e23d79a686d81d\",\"/knowledge-medium/pr-preview/pr-1811/src/data/blockTypes.js\":\"9cb5272a13134480\",\"/knowledge-medium/pr-preview/pr-1811/src/data/clientContext.js\":\"9322964a0e08454e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/dbFileSiblings.js\":\"fc8922f7f0a72cd1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/definitionSeeds.js\":\"6c88f6022156b5d0\",\"/knowledge-medium/pr-preview/pr-1811/src/data/derivedIds.js\":\"2d3a0593563e0051\",\"/knowledge-medium/pr-preview/pr-1811/src/data/drawnSubtree.js\":\"5ab028faf95e72a1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/facetBridge.js\":\"d86a7a5de1d95b8a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/facets.js\":\"77df8308d61b9191\",\"/knowledge-medium/pr-preview/pr-1811/src/data/globalState.js\":\"166b20d0991aa1e5\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/aliasClaimRederiveProcessor.js\":\"1bfb0e4347e0f3e7\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/ancestorBatch.js\":\"81bc5a4d832b434b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/blockTypeTypeifyProcessor.js\":\"1e50ca5bbb4e8b8e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/clientSchema.js\":\"856a1c55e3d2a9ea\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/commitPipeline.js\":\"8e35ab4f2ccef532\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/devAssertions.js\":\"d21a626a9ad345a0\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/firstSync.js\":\"d15290df95767d71\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/freshInitialLoad.js\":\"1eee847e54c2d5cf\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/graphBackfillClaim.js\":\"5b8af2828ebbcd78\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/handleStore.js\":\"c8ee9e0e51ccc50b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/idleMarkerJobs.js\":\"69a1252fa1e3b33a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/initialDownload.js\":\"16c737115a52f8c2\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/initializeClientDatabase.js\":\"6ca52781dcbc2ea8\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/jsonCanonical.js\":\"0c23064963dbc3d8\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/kernelInvalidation.js\":\"2d0840cca1fb9124\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/kernelProcessors.js\":\"5d12770b444acb20\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/kernelQueries.js\":\"977b0474b581f7e9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/mergeTypeMembershipProcessor.js\":\"f378789d1a2edbb1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/normalizeReferencesProcessor.js\":\"36c4f3b40430a83d\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/poolInstrumentation.js\":\"3a5cfcdcfa014271\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/processorRunner.js\":\"d87655a00994f44e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyCellBackfill.js\":\"687d7a47dcfc73ad\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyChildMint.js\":\"642a4c9a112a5187\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyChildrenProcessor.js\":\"02e478d596b95d5d\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1cc42c18689ffafa\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyDefinitionSynthesis.js\":\"d4337fd4412ed584\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyKeyScan.js\":\"d197b307bb1b7af0\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertySchemaResolution.js\":\"a27e8d0829ee6123\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/propertyValueEdits.js\":\"f96c607eafa7e137\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/raiseProtocol.js\":\"e4d85ff370a2fcad\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/readBatch.js\":\"59e498fa5ac7ef53\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/refProjection.js\":\"b17e049c7f209936\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/referenceTargetLookups.js\":\"0be962ba67275f60\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/referenceTargetProcessor.js\":\"156b9962ed670607\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/replayMerge.js\":\"708a9cbeb1f2df62\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/sqlBinds.js\":\"f87bddbd273c62d9\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c52e64030b24d2a5\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/arrivalProcessors.js\":\"77b897c0f60a849a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/invalidate.js\":\"00d2a96444d46272\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/materialize.js\":\"459797a203c54f44\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/observer.js\":\"0be2f781f67872cb\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/syncObserver/reconcile.js\":\"8d36c98440e3dab6\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/timingMetrics.js\":\"aca92582c93987a1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/treeQueries.js\":\"e3997f5fdce42f4b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/txEngine.js\":\"10eb2f5ea9cb4837\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/txSnapshots.js\":\"205f12a1b7385d2c\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/typedBlockQuery.js\":\"a3a721b474cea229\",\"/knowledge-medium/pr-preview/pr-1811/src/data/internals/undoManager.js\":\"4d98369c436ec4c8\",\"/knowledge-medium/pr-preview/pr-1811/src/data/invalidation.js\":\"25d1b14fdfe0beaf\",\"/knowledge-medium/pr-preview/pr-1811/src/data/kernelDataExtension.js\":\"4d398a3c09339fa4\",\"/knowledge-medium/pr-preview/pr-1811/src/data/kernelPage.js\":\"4da473c733b2aed0\",\"/knowledge-medium/pr-preview/pr-1811/src/data/kernelValuePresetCores.js\":\"c54269c990eb6f79\",\"/knowledge-medium/pr-preview/pr-1811/src/data/localDbCorruptionSignal.js\":\"f74167d03f7eb851\",\"/knowledge-medium/pr-preview/pr-1811/src/data/localDbStorage.js\":\"c379b51562948e9e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/localDbVfs.js\":\"e988516b53a21ae3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/localSchema.js\":\"0a70659e26cd2f02\",\"/knowledge-medium/pr-preview/pr-1811/src/data/maintenance.js\":\"d52236aff4af0815\",\"/knowledge-medium/pr-preview/pr-1811/src/data/mergeProperties.js\":\"1e9c547277e2838e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/metricsConsoleHook.js\":\"0c686a33abb80da1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/migrationsPage.js\":\"7b4b93ef5f6a84bf\",\"/knowledge-medium/pr-preview/pr-1811/src/data/mutators.js\":\"30f4a18cf8c8039d\",\"/knowledge-medium/pr-preview/pr-1811/src/data/orderKey.js\":\"a682d89f8ec3b2fb\",\"/knowledge-medium/pr-preview/pr-1811/src/data/orderKeyPlacement.js\":\"525fd7093543e559\",\"/knowledge-medium/pr-preview/pr-1811/src/data/outlineSurface.js\":\"25e83c2a9d99e262\",\"/knowledge-medium/pr-preview/pr-1811/src/data/pendingEditorContent.js\":\"081ce1ad341c186e\",\"/knowledge-medium/pr-preview/pr-1811/src/data/pendingUploadsSql.js\":\"400fae3d2b915818\",\"/knowledge-medium/pr-preview/pr-1811/src/data/pluginStateExtensions.js\":\"6cd48d7bda30fb0a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/powerSyncLogger.js\":\"16bac461697f0def\",\"/knowledge-medium/pr-preview/pr-1811/src/data/projectorRuntime.js\":\"533a2a3968c4e7ab\",\"/knowledge-medium/pr-preview/pr-1811/src/data/properties.js\":\"216f2e8470dc5a67\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertiesPage.js\":\"8638703ec929dff5\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyChildren.js\":\"7b70c2abd99c8945\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyDefinitionFanout.js\":\"8f4dc260be87782b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyDefinitionMetadata.js\":\"b94e053865454a4d\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyDefinitionRegistry.js\":\"20dd0c5a66eca18a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyDisplayMode.js\":\"9801d922b1c40bcb\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertyRowCreation.js\":\"1ba9df956b54490b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertySchemaCreation.js\":\"7b2d59e78d128fbb\",\"/knowledge-medium/pr-preview/pr-1811/src/data/propertySeeds.js\":\"be0cdf913e70dbda\",\"/knowledge-medium/pr-preview/pr-1811/src/data/recentsPage.js\":\"1e7d24b0128db742\",\"/knowledge-medium/pr-preview/pr-1811/src/data/referenceBlock.js\":\"b56e34dbf327e57a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/rejectedUploads.js\":\"09c19813de02b7c7\",\"/knowledge-medium/pr-preview/pr-1811/src/data/releasePowerSyncConnection.js\":\"a4eb7f3df6a40dba\",\"/knowledge-medium/pr-preview/pr-1811/src/data/repo.js\":\"322299d305bf1b3c\",\"/knowledge-medium/pr-preview/pr-1811/src/data/repoProvider.js\":\"9c6c704b071213d3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/rowProperty.js\":\"88de33b101a297ee\",\"/knowledge-medium/pr-preview/pr-1811/src/data/searchFilter.js\":\"9de4e2846a5f4f59\",\"/knowledge-medium/pr-preview/pr-1811/src/data/seedIdentityLedger.js\":\"821b4fd26f1ffba1\",\"/knowledge-medium/pr-preview/pr-1811/src/data/stateBlocks.js\":\"312ee330636200b3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/structuralEditPolicy.js\":\"9a84e839578157b3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/subtreeDelete.js\":\"27cb30a81920e894\",\"/knowledge-medium/pr-preview/pr-1811/src/data/syncStreamLock.js\":\"3c450fa39b5a0955\",\"/knowledge-medium/pr-preview/pr-1811/src/data/syncedTableSqlRecognizer.js\":\"ac3b715e31435801\",\"/knowledge-medium/pr-preview/pr-1811/src/data/syncedTableWriteGuard.js\":\"fc840a9b39e1ddcc\",\"/knowledge-medium/pr-preview/pr-1811/src/data/targets.js\":\"fb00fb667b4e3777\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeColors.js\":\"730fe8f47a487cca\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeDefinitionMetadata.js\":\"b42e2dc34f68859f\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeDefinitionRegistry.js\":\"aa144c519bf509a6\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeExtraction.js\":\"216e3d71286fa036\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeInitialValues.js\":\"fdcb367a7f23a3ca\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typePropertyGroups.js\":\"87746f5207c65154\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeSeeds.js\":\"46a2e6f28b6eb72b\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typeTagger.js\":\"756068eb4eef7100\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typedRecords.js\":\"ed58e978d1346df5\",\"/knowledge-medium/pr-preview/pr-1811/src/data/typesPage.js\":\"9a8f57bbcf7dc852\",\"/knowledge-medium/pr-preview/pr-1811/src/data/userPrefs.js\":\"92036c929c9642af\",\"/knowledge-medium/pr-preview/pr-1811/src/data/userSchemasService.js\":\"c82e98db7d5e7c60\",\"/knowledge-medium/pr-preview/pr-1811/src/data/userTypesService.js\":\"ddc66d43cd3898de\",\"/knowledge-medium/pr-preview/pr-1811/src/data/valuePresetRegistry.js\":\"e45b15edb4ff6364\",\"/knowledge-medium/pr-preview/pr-1811/src/data/visibleChildren.js\":\"576e6fcd709c9682\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaceConversion.js\":\"41ed383fc70106ef\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaceFirstSync.js\":\"2f050b31b98574ad\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaceIdNamespace.js\":\"2797abf5af7fe98a\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaceSchema.js\":\"4a81d4833d9f8364\",\"/knowledge-medium/pr-preview/pr-1811/src/data/workspaces.js\":\"4eaeea6269386fde\",\"/knowledge-medium/pr-preview/pr-1811/src/data/writeAheadLog.js\":\"46f92f0d5441dcc3\",\"/knowledge-medium/pr-preview/pr-1811/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/BlockPasteShellDecorator.js\":\"445f0fee8e89428b\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/atTrigger.js\":\"5b4b0163d6b6998c\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/autocomplete.js\":\"1dbfdc9c12911b3b\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/codeMirrorExtensions.js\":\"01f644066410b39e\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/contentFlush.js\":\"541650d03e86e3ce\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/defaultInteractions.js\":\"f82262cbf4aee702\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/editSettleSignal.js\":\"d60df204c3708f15\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/insertImage.js\":\"8e6063107fc2e0a3\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/referenceCompletionRange.js\":\"d81894a0db27a445\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/referenceTargetTypes.js\":\"a34a773ff432aed4\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/syntaxContext.js\":\"869c2ff26aaa28e1\",\"/knowledge-medium/pr-preview/pr-1811/src/editor/triggerMatch.js\":\"a847a5b87aba2602\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/AppRuntimeProvider.js\":\"1bf726538df86548\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/BlockFocusShellDecorator.js\":\"e8884655fa45ec21\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/ExtensionRenderBoundary.js\":\"33d268fa9a2b6e53\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/PanelContentRecovery.js\":\"98f2b36363fc89d3\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/apiCatalog.js\":\"fed961164adcefad\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/approveExtensionHere.js\":\"422d92aa3b66745d\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/armedCutAppMount.js\":\"07e1f02113cb71e8\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/batchableKeyedStore.js\":\"187a22a732b93a53\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/blockInteraction.js\":\"6c453b26456bb6b8\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/blockSelectionAction.js\":\"5408bc623f525787\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/compileExtensionModule.js\":\"bd072f7e31bb7584\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/compiledModuleCache.js\":\"b5e9920cf043c680\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/continuousGestures.js\":\"abaee3cad1a9743f\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/core.js\":\"f99582be921723f9\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/defaultRenderers.js\":\"e9025e4ef8f53a68\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/definitionFanoutAppMount.js\":\"b6aae8a9a2dd49e2\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/dialogAppMount.js\":\"c9f6c7b9aded7dcf\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/dynamicExtensionSeeds.js\":\"6fb4ef2b375567b9\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/dynamicExtensions.js\":\"50cc13d7c277d5dc\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/exampleExtensions.js\":\"cea48f1e5dacc9d8\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionApprovalStatus.js\":\"f29b201f73bea8cd\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionLoadErrorToast.js\":\"fd3e3aca1eb77f7d\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionLoadErrors.js\":\"e3927b95ca444e16\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionLookup.js\":\"2f762ff1b00bbf35\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionToggles.js\":\"3381f79d2764dafc\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/extensionUtilitiesCss.js\":\"56c97ab8c2d20baa\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/kernelPageDeletionGuard.js\":\"6af42169be046034\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/liveRuntime.js\":\"44f90ca755ef5c4e\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/openExtensionsSettings.js\":\"da45d6f97266646d\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/overridesCache.js\":\"5b9d63ab10cc2f2c\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/pluginIds.js\":\"68bc025df8c7fa73\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/processorRejectionToast.js\":\"fa28f18e9ef0fccb\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/runtimeActions.js\":\"044ad3fafdf4263e\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/runtimeContext.js\":\"1de5247ff2ff3a7b\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/staticAppExtensions.js\":\"36e94c9e7c49adb1\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/staticDataExtensions.js\":\"dfab41137baf811c\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/toastAppMount.js\":\"de4d725737da7133\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/useOverrides.js\":\"4761c54d40a1f584\",\"/knowledge-medium/pr-preview/pr-1811/src/extensions/useShortcutSurfaceActivations.js\":\"ca65be0901c21217\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/discoverToggleTree.js\":\"6318d985db6f0788\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/facet.js\":\"83ee2c6b5599c314\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/resolveAppRuntime.js\":\"64d8d6a62b6feaf9\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/runtimeEvents.js\":\"a47710303ecb2c9e\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/togglable.js\":\"8a59fa0d50f9e154\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/variantFacet.js\":\"9a0d4cc95e63a8cf\",\"/knowledge-medium/pr-preview/pr-1811/src/facets/verbFacet.js\":\"a8b627c9c751a108\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/block.js\":\"4634e032fa5e6888\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/focusedChild.js\":\"21bd0af29fbd3745\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/propertySchemas.js\":\"ff7b3bbb44186e44\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/typeRegistry.js\":\"34052dd998f5dcfe\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useAncestorCrumbs.js\":\"1cc4f8cf2a3f5ba1\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useAutocompleteListbox.js\":\"41377b1c0cc8ea17\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useDebouncedSearch.js\":\"cc616336671bb112\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useDebouncedValue.js\":\"af01c31d4bbecb53\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useIsFocalRender.js\":\"bfca4452c116c66b\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useIsReadOnly.js\":\"1eefd15ef083bac7\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useMaterializeBacklog.js\":\"69ac8f6e447b8baa\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useMinuteClock.js\":\"5073ea274e985838\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/usePanelLayoutProjection.js\":\"2611542e7ad4eb00\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/usePendingInvitations.js\":\"a2bf5695c8dc38a9\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useRendererRegistry.js\":\"39a39f6577ded6af\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useRetainedFieldRows.js\":\"24df9067882310c1\",\"/knowledge-medium/pr-preview/pr-1811/src/hooks/useWorkspaces.js\":\"a35fc94e1e385840\",\"/knowledge-medium/pr-preview/pr-1811/src/lib/utils.js\":\"8e945729f885363c\",\"/knowledge-medium/pr-preview/pr-1811/src/main.js\":\"f797ffb80df82e03\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/MarkdownImage.js\":\"e9f7a2cff73db0a6\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/blockSeparators.js\":\"9ec7ba3dbdca88d2\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/context.js\":\"e1b8ec42f4bd5d0c\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/defaultMarkdownExtension.js\":\"fd1b3e9df1449cd4\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/extensions.js\":\"772fab68b63d6dc7\",\"/knowledge-medium/pr-preview/pr-1811/src/markdown/renderMarkdownHtml.js\":\"79393ba3851f0ac8\",\"/knowledge-medium/pr-preview/pr-1811/src/minimal-editor.js\":\"e84c52cd190bab2d\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/armedCut.js\":\"84384208e2a171a5\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/captureMediaVerb.js\":\"751b8cca4e6268cd\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/clipboard.js\":\"337e59aeabfa4540\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/decision.js\":\"510d916e63290acc\",\"/knowledge-medium/pr-preview/pr-1811/src/paste/operations.js\":\"fe704e2e403ce202\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/account-header/AccountHeaderItem.js\":\"6b525330d068eb00\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/account-header/index.js\":\"fa09814b7733807a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8730e2b830544316\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/askAgent.js\":\"a832aceab0b938c1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/askedStore.js\":\"4953fd5c624f4c04\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1ba5bffb8a18945e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/chipState.js\":\"6a565ffb3c77996c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/dataExtension.js\":\"60338ab7778f6080\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/index.js\":\"81843df1f4e25e71\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"cf384c09010b3fd2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-dispatch-companion/schema.js\":\"8441e6be5d06d94c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/AgentTokensDialog.js\":\"55332e6c682fa9f5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bbf55671275561bf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/addMedia.js\":\"35368c4c4873cebf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/backlinks.js\":\"38ca359f4fe29d92\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/block.js\":\"db815c4f4b6bf2ff\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/context.js\":\"752e7518e5f90f13\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e7bda854e4e971c4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/index.js\":\"ccc1a406d0531f88\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/outline.js\":\"77a85b465e620cc3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/properties.js\":\"81009ac82e7a4737\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/refs.js\":\"5baf444b0001afd3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6ca20a789fb6b774\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/search.js\":\"3d62196b34b5f657\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/shared.js\":\"274f54cb1b938f41\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c9999b2d1c29a9e6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentViews/text.js\":\"8ee0c3c88147aa45\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/agentWrites.js\":\"65e7aabc37f680e2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/authoringCatalog.js\":\"e1a940b8ed5e07ca\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/blockRefTargets.js\":\"1f6478c4fa3c8980\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/bridge.js\":\"aed2203fe42f3030\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/bridgeLoop.js\":\"11ba133875990437\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/changeHistory.js\":\"6ae6d411039570dd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/commands.js\":\"4c5144afd6728b5a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/commentsCommands.js\":\"748bc7890f870b1f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/dataExtension.js\":\"7b4f533792521abe\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/dataModelGuide.js\":\"c6709a64a16e1596\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/describeRuntime.js\":\"5b14c8c8c21e6262\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/extensionLint.js\":\"f41b07b335b43d3f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/grainAudit.js\":\"6561edcc0339ccb1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/healthCommand.js\":\"d0cd1dd8d0dd81bb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/index.js\":\"14ce8a00544bc21f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/presetIdentity.js\":\"ee492bdb15ed6060\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"df93193eadc739ae\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/readMedia.js\":\"4ee07056782996a1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/schema.js\":\"04ee4bd75b63e911\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/serialization.js\":\"5da7b5a9d6b75c09\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/targets.js\":\"58cc2d6ebf223a51\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/tokens.js\":\"2748fd36feb243d1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/watchEvents.js\":\"910d8a91e0046361\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/workspaceGuard.js\":\"b1a8887954c2af03\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/agent-runtime/writeCommands.js\":\"079319994ec61a53\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/AliasCollisionToast.js\":\"08ccc36c6bcc680a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/DuplicateNameBanner.js\":\"698c1d139dc7ef50\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/collisionMerge.js\":\"2990efdb2f66091a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/dataExtension.js\":\"481dfbbf79839e81\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/index.js\":\"e13a893c831061d8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/mergeCollisionAction.js\":\"9e06745fa6c9e62f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/pageStyling.js\":\"b8570207d05706ab\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/rejectionToast.js\":\"8de0dd3da5073c65\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/alias/syncProcessor.js\":\"39ee8d2deb249683\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/actions.js\":\"41716c08e07644c8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/addComment.js\":\"8b0dc5b0b79210c1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/anchor.js\":\"7d80b7fe3f483fc4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/anchorState.js\":\"0a027de93f201d27\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/commentLinks.js\":\"355446a0f41669a9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/confirmThreadDeletion.js\":\"4facc2164cd67b0f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/container.js\":\"759e0a67e15a4d2b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/dataExtension.js\":\"62ac96ac585a2c11\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/deleteComment.js\":\"03aaa01aefb36e99\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/highlights.js\":\"e4546bd090571989\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/index.js\":\"b520dc9a23b4fe9f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/linkedCommentsPill.js\":\"6a54c41fd0b778fc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/margin.js\":\"2c3300e776d11607\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/marginSchema.js\":\"fe167efc5b10e81c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/newComment.js\":\"b5dca5056ffb7854\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/ownThreadPicker.js\":\"6baaed475659e17e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/placement.js\":\"69766393a1ebaec6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/queries.js\":\"56455e39c5e8559a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/quotePosition.js\":\"b2945d79d4c60354\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/quotedIn.js\":\"f9bc984b04b4e99c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/quotedRange.js\":\"43d422910c5d6ccd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/rangeRefs.js\":\"fb11305ebb7871b6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/readHighlights.js\":\"b99ba2365f49220f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/readSelection.js\":\"39db0548137102b3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/readSelectionUi.js\":\"872b03fca48222bd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/reanchor.js\":\"9a38a3146d4ced98\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/schema.js\":\"046e7d6b0a534cfc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/scope.js\":\"c48a914200a26a14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/scopeThreads.js\":\"dbdd455b2c51fb01\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/splitRetarget.js\":\"e55158c3d1b2d27b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/suggestionCard.js\":\"52f5b5e3c18a3336\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/suggestions.js\":\"170dae080e48b60e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/summaries.js\":\"1c37081a10faee2e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/summaryBatch.js\":\"d0d9b4e21cbfcf1d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/surface.js\":\"bbed95c30ed66c31\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/threadNavigation.js\":\"0fbde58d6c9aaf7a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/threads.js\":\"74b7615ade1b54d4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/ui.js\":\"66ea6901f53d15b8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/annotations/uiStore.js\":\"00c200e1e31e26f0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/app-intents/appIntents.js\":\"26f25f1f5193d867\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/app-intents/index.js\":\"41047b9471d92919\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/app-update-prompt/index.js\":\"ee13a2911f9af27c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/app-update-prompt/status.js\":\"dfdb9f59b065d0c6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4a6b942898080cd6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/MediaBlockRenderer.js\":\"a938146a2396018a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a3f7bf3a4628f230\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/MediaUploadReconciler.js\":\"8776f8116a1deea7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/assetDownLane.js\":\"244f8fe9a35ff561\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/assetResolver.js\":\"44076b673655e756\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/assetUpload.js\":\"96440b4f2dee4d89\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/attachmentCleanerIO.js\":\"0f6ef2a4ea8c8068\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2cbe76c4190a3a77\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/blobStore.js\":\"e37dccc664df6941\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/byteStore.js\":\"5cf9e19f186c205c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/cleanerIO.js\":\"5166b83cfc67f03d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/cleanupAttachments.js\":\"1eba5103a1366882\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/dataExtension.js\":\"638cecf202816b5d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/downLane.js\":\"6fe082068c24935b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/index.js\":\"008c01be09fcb46a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/insertImageContribution.js\":\"ba7273ac6ad70a32\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/laneArming.js\":\"5b7f222afa0b8087\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/laneLock.js\":\"861a87bd9359030d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/mediaBlock.js\":\"0096c4c89e0b6e62\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/mediaCapture.js\":\"31db487859975fc1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/mediaViewers.js\":\"61425dd9a04d767b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/mediaViewersFacet.js\":\"5ec45e62123a2cea\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/pasteCapture.js\":\"be679b793cf48896\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/resolver.js\":\"2f81b15adaf83dc7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/retryUploadsAction.js\":\"2856c14b29caca01\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/storagePaths.js\":\"ba52189e0830d194\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadDrain.js\":\"ac78d372ab9ef64a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadLaneStatus.js\":\"e7702a76c013cdd9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadReconcile.js\":\"715946d10f4d9fa3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadRecovery.js\":\"357ebbbb6d260c2a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/uploadStore.js\":\"afd1844c0332c957\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/attachments/useAssetObjectUrl.js\":\"669f1ba155ee3b30\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"680c6f523338754e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/BacklinksViewSection.js\":\"8e446a93ece8203b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/facet.js\":\"fdb0ccb272bfa6ff\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/index.js\":\"558cd8c50848e7ee\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks-view/prop.js\":\"d90099079880bb0a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/BacklinkFilters.js\":\"52dad3edccb2c43a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d45f5d0ac742927e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/BlockEntry.js\":\"aa843a29071b8beb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/LinkedReferences.js\":\"d077c71f9fafc0a0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"34c458b7bb255c83\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/dailyNoteDefaults.js\":\"ee1434efd858b82e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/dataExtension.js\":\"1cdfe93d6661c5f0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/edgeExclusions.js\":\"ede4597a84336798\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/filterProperty.js\":\"820230d414482dc3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/index.js\":\"a0efa594dacf811c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0d5c0fb5e4fc57b5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/applies.js\":\"be73d4a111c12e18\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/countQuery.js\":\"50f0618111c7d833\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8679821176b15027\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/index.js\":\"97c044d1cce592fd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e88886087cf257ed\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/presentationInvalidation.js\":\"7844bdaa4906e651\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/propertyEditorOverride.js\":\"3524a67908739e17\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/propertyFilter.js\":\"2ad1f9274fc83a68\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/query.js\":\"24127e3e1e69e3e4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/resolveFilter.js\":\"66bc98b53d1b7480\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/sourceBatch.js\":\"b1a2b853ed866071\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/sources.js\":\"dd51236a5c8be382\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/useBacklinks.js\":\"6961f8fbfc66ce07\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5d1e5339752393c9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/BirthdayCelebration.js\":\"8b28121c273e7af4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/BirthdayOverlay.js\":\"51150404c9652c3e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/gate.js\":\"bca1f3063a50219e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/index.js\":\"d31cc3d8f6c3cfb2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/birthday/wolfTheme.js\":\"52de4eecf3e7d91d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/BlockDragLayer.js\":\"2c3520e4581056a9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/dragController.js\":\"57a47df442eca05f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/dropTarget.js\":\"99b29f575b97952b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/index.js\":\"a9a4ece1f430a89d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-drag/projection.js\":\"0c8d5864f0e61dba\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-info/BlockMetaCard.js\":\"65b1ec38039d9bee\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-info/index.js\":\"b29b4008af4d80f3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/AddTagDialog.js\":\"7f53a8f0a35ea60a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2fdce1c4b51c75bb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/TagNameIssueHint.js\":\"c8b096a229251406\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/addTagAction.js\":\"e635f36bc729a05c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/appendTag.js\":\"e2c3a0ce1621ad98\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/config.js\":\"64cb976d9dd9cd6b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/dataExtension.js\":\"4609b4adf100cba4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/index.js\":\"0f03e0358c4850a3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/block-tagging/propertyEditorOverride.js\":\"6e6af52865b0c634\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/BreadcrumbList.js\":\"294ca1bbd46c6951\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"822a5d13b6b01a6d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/Breadcrumbs.js\":\"737afda6497d3e26\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ee2da6dc79230db3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1ac0e24e595509c1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/index.js\":\"29acda3cdd0354d5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6e86f66ac571488e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/CharacterCountItem.js\":\"39cbe3f082f6d2dc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/ProfilePropertyEditor.js\":\"cad72474c4a23c4e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/actions.js\":\"01e20b9ce2ffd468\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/blockType.js\":\"b9d43bcefe7ee29c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/charCount.js\":\"611188a4a09118d3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/dataExtension.js\":\"b4d29400953f8eae\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/index.js\":\"c5e795d5ed5874da\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/profiles.js\":\"e6c616d1734ba062\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/properties.js\":\"66360aafa4f4d9cc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/character-counter/textCounts.js\":\"6004dfd6dfcc6430\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/colemak-keybindings/index.js\":\"d54d62eed153fdf3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/CommandPalette.js\":\"33ba547fc8859010\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/HeaderItem.js\":\"1590f9052dfd2089\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/context.js\":\"e8b3e133b8baae29\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/index.js\":\"9d8c17ff835feb65\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/selection.js\":\"68658eb2dd9a411a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/toggleStore.js\":\"39bbdcd72f4d4b76\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/command-palette/useCommandPaletteActions.js\":\"9dbf8e952f3529c5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/ContributorBadges.js\":\"abce5e6fa943d1f0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/author.js\":\"45da3ed098cee4a9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/codeMirrorExtensions.js\":\"5dd005f15a1a8bb6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/dataExtension.js\":\"8228d143b6e2d807\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/index.js\":\"c53630eb681b07fa\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/mentionAutocomplete.js\":\"63395d13603064af\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/processor.js\":\"6af5c286133d0fc5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/profiles.js\":\"e853706d1ed8205a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/queries.js\":\"dcf57b34fec551d9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/contributors/schema.js\":\"bb7e451d3c6944ed\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d4ddcc0462c8c288\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/followOrigin.js\":\"96d683193206a97a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/index.js\":\"4403b59d6006e191\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b54f6f955c7d8c9c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"671229bf241559ee\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/CalendarGrid.js\":\"96ec37f9d1316d69\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/DailyNotePicker.js\":\"a1a89e4f4b857775\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4c330061731c8c4c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/DateNavDecorator.js\":\"baf71be96193366b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/DateScrubOverlay.js\":\"7d7b7e6328fad351\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/HeaderItem.js\":\"19f86a49b6e50811\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/ReschedulePicker.js\":\"1cc23f4003e3cb56\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/SpreadDatesDialog.js\":\"76beed5f5982a2fd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/actions.js\":\"366b51dbc5c16a7a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/blockDateAdapter.js\":\"ffdbb5dc4e28a94d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/calendar.js\":\"9597cda46954348f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dailyNotes.js\":\"850b96d7f4644446\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dataExtension.js\":\"8c867f901f24e8e5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dateScrubActions.js\":\"4ef42f8f69cce2da\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dateScrubGesture.js\":\"2e69165f01cba850\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fbd02445b2c2067e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1b2833c7e1d8620c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/deletionGuard.js\":\"a327333d27e0816b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/dueQuery.js\":\"cb52ae2291b5f7c6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/index.js\":\"bfc99f2cffbd4a95\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/landing.js\":\"67f3c2763276845c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/localSchema.js\":\"630ac516bc10b5cd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/referenceDateAdapter.js\":\"f22393cdb0bfb939\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/rescheduleAction.js\":\"9ae1cb98b1a35290\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/schema.js\":\"1fad7612649c3f24\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/spreadBlockDates.js\":\"7f8c27fcc8112e89\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/spreadDatesAction.js\":\"40d4bfb83cf06e94\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/today.js\":\"d43046d9220a706d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"192a54b90659e3ea\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ac87199190efe65d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/audit.js\":\"763314103e9d27da\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/auditAction.js\":\"2863711257d2f314\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/auditRanges.js\":\"a89cf8747336441b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/diagnosticsSource.js\":\"d19d7108c047899b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/divergenceScan.js\":\"a3da486a923c9926\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/index.js\":\"ee5f46c19a660b34\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/propertyChildrenChecks.js\":\"fb91b29bc8b965f2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/referencesMirror.js\":\"532aee3bce186c27\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/rowJson.js\":\"85c247f654112784\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/schedule.js\":\"ad8583e2c4e593c0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/data-integrity/store.js\":\"f99dc5d0763a477c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-maintenance/action.js\":\"dfd3da748c3c6ae9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-maintenance/index.js\":\"25276674fcd553c5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-maintenance/plugin.js\":\"6349d593a3e507d0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"658ac0a68265d0c8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/actions.js\":\"cdac0a5e587a76d0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/changeMarker.js\":\"051273a1c469ac6e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/diagnostics.js\":\"cfff66964a5cb7ff\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/fileSystemAccess.js\":\"aafd59039b54bafe\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/filenames.js\":\"b6e74c92bc196f45\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/index.js\":\"00a6efc1cc8af278\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/mirror.js\":\"fac6f90a15569a1f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/runLock.js\":\"423f069c76470e49\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/runtimeHealth.js\":\"cf4a8ba90ffab982\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/schedule.js\":\"86266e5d11a94dfc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/db-mirror/store.js\":\"68f90e335c93321b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/default-themes/index.js\":\"af3256f5d35b4a0b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/default-themes/themes.js\":\"1bc2aa91f8b1393c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/diagnostics/facet.js\":\"d288664330d38c74\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/diagnostics/useDiagnostics.js\":\"80536391073b5ea8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extension-prompts/dismissals.js\":\"3f154e1353cbcb1d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extension-prompts/index.js\":\"76f1d69614434364\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extension-prompts/status.js\":\"e44838aad004c151\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extension-prompts/store.js\":\"93563c3399470aae\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2cb9d8b6bc75bd5f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/ExtensionsSettings.js\":\"24cdd6e4f5f2b626\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/actions.js\":\"6c6ebd09906c1255\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/config.js\":\"2f48905ae4a1f55f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/dataExtension.js\":\"8a2936e2d5b7f699\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/effect.js\":\"03b2687e17009c05\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/index.js\":\"65dda17f737106da\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/propertyEditorOverride.js\":\"fe0db4855442a74e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extensions-settings/useToggleTree.js\":\"cda112059f844b4f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/ExtractTypeDialog.js\":\"13157b18fd612a1e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"717fa0bba9e2e354\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/PropertyShapePicker.js\":\"351b931d7c2f709a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/action.js\":\"0b956ccd5b39779d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/extract-type/index.js\":\"f4094a90c5a1425c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/FindReplaceDialog.js\":\"aad69debee1a4957\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/HeaderItem.js\":\"f88f7c1d9451e35e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/dataExtension.js\":\"5071848931d64d7e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/index.js\":\"37eda02631252acd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/search.js\":\"4c316456b21950aa\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/toggleStore.js\":\"bde8c66688164f3d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/LocationPropertyEditor.js\":\"d1c92d4fba81a3d8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/MapView.js\":\"8f6a1222ab3f48ab\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/blockTypes.js\":\"94d27f50d6cd0d28\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/codeMirrorExtensions.js\":\"0873aa75d48d4011\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/createOrFindPlace.js\":\"ce80bd4591b6a0d6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/currentLocation.js\":\"ba5e8ed011f40a81\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/dataExtension.js\":\"2d23f4ba923e0a86\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/geoContentDecorator.js\":\"ede10b3158b407da\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/googlePlacesClient.js\":\"3fc5d005f5094f62\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/index.js\":\"0eb0bea62c84efdd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/locationsPage.js\":\"c33f9f7a0d63f973\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/mapViewport.js\":\"133944b7d0fddb5a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/pickCurrentLocation.js\":\"e6f9f83f5b5722af\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/placeAutocomplete.js\":\"31c950849bd8a888\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/placeNameCollision.js\":\"2e6fa71dcfad87e0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/properties.js\":\"415e45ff476237f7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/propertyEditorOverrides.js\":\"ea46b3b30876d40c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/query.js\":\"6bbc018b37e07655\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/geo/usePlaceSearch.js\":\"4942fdd9c8f0e7bb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9999130d09b5e494\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"58c8ebc06dbb28a7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"30f6acfad3b28376\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/config.js\":\"59e4ef22f0a721b4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/dataExtension.js\":\"e1cf3109c0fb2fc7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/facet.js\":\"d4e4dc7fd4e66ee4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/grouping.js\":\"25bc36279acff18a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/index.js\":\"5007bb8c6dec422e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"45ffbb0fe0925be0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/query.js\":\"cee9896417f0763c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/resolveConfig.js\":\"6409ff7a60ae2b6c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"54f10e4092b77fde\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9b5a4e6a2777a038\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/HtmlDocumentContent.js\":\"61634cc37ca42682\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/HtmlFrame.js\":\"3cd8e0393d62d834\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/actions.js\":\"75af61286b941a28\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/blockType.js\":\"7085d213ec1eccbe\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/confirmRunScripts.js\":\"b389fd6f191642d9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/dataExtension.js\":\"93ab5458e0408b8e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/frameAnnotations.js\":\"e3e489a5f9eb2c5c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/frameDocument.js\":\"d5f517342a0e93c4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/frameTheme.js\":\"c74911762310d905\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/index.js\":\"c5ef977d08872a82\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/scriptConsent.js\":\"b11c03832dd3773b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/sourceMap.js\":\"a913c93c7554e914\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/html-document/useDocumentScripts.js\":\"6b6f920990d617c3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/index.js\":\"1f652d5638df8f01\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/record.js\":\"01e9af08ad2b2a63\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/recordStore.js\":\"c25727cec8c5f699\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/responsiveness.js\":\"9455b1ed849ab6b6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/schedule.js\":\"6824e15d3de72ac4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/interaction-metrics/sessionContext.js\":\"96fa4265243fb78c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a009fb440e2a89e3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e41aef5903ba86b7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/actions.js\":\"5242dcdccda86208\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/config.js\":\"c331354a64da3829\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/dataExtension.js\":\"729080ca967cf4f0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/effect.js\":\"5464fb85c3148796\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/index.js\":\"3bd7e25b742a03e5\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/keyCapture.js\":\"932cf985f31f593d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/overrideStore.js\":\"1bfe7a2b089d1b9d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"7c960d4652c04ee3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/HeaderItem.js\":\"f4df9663e40f2974\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/LeftSidebar.js\":\"5d9e2d2c6f4ed8f6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/actions.js\":\"d590680f7ce2c29f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/facet.js\":\"5f06c7d804efb58f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/index.js\":\"c53b32e1f6f2ceab\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/shortcuts.js\":\"32edbb97ab50aea3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/left-sidebar/toggleStore.js\":\"f01d972fd5306e07\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/merge-blocks/MergePicker.js\":\"0f8c3cc665cd32c4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/merge-blocks/index.js\":\"362689379c640f0e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/merge-blocks/mergeAction.js\":\"f45f6eeec763123b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/merge-blocks/strategy.js\":\"751f19cfc6bb5517\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/Button.js\":\"c997d72adeec99db\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2eeccd0c24fca89b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/defaultItems.js\":\"65e136564c040238\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/facet.js\":\"caa1c210051e4733\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-bottom-nav/index.js\":\"32d9eb47b0f237cc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"64675e56140e3fa9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5d581f46b7ef3d1b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8c134f970cab272d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/facet.js\":\"5f0cf2bf756f3207\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/mobile-keyboard-toolbar/index.js\":\"a0ff728bc64d2a47\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2a684a7e2ec220a6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/blockSubtreeMembership.js\":\"cb0520b93d010d43\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/contextMenuItem.js\":\"2a5ef682cf5eb777\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/index.js\":\"a71883f39a3f85a2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/moveAction.js\":\"385ee3864c28235e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/moveBlocks.js\":\"4cc7c8220b0fae7d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/move-blocks/selectionAfterMove.js\":\"438b3a9cecf646e3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/TutorialBanner.js\":\"9df25992784ef872\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/action.js\":\"df71716982821e0f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/bannerDismissal.js\":\"28663c3f20129add\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/documents/cheatSheet.js\":\"435b2ccaf628f234\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/index.js\":\"24e903553eb815c4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/keys.js\":\"a7a1b15adabfa273\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/landing.js\":\"4e28e342f7e5e315\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/outline.js\":\"34ad230445c4d97a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/onboarding/seed.js\":\"9deeb504f616dbac\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/PerfTrendDialog.js\":\"614a9a6e8514ab86\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/analyze.js\":\"d66c4831028a2d3c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/diagnosticsSource.js\":\"ae5fdb9d52bb9bf3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/index.js\":\"b4f1b775af067221\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/load.js\":\"2c5200847163e770\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/monitorRun.js\":\"15047bc334a75f48\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/schedule.js\":\"e361698c8b4c4182\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/series.js\":\"88c3ec0bbbb17669\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/store.js\":\"6ec788af00011006\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/trendAction.js\":\"8e2e95921d421aa3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/perf-monitor/verdict.js\":\"e63306ef5798dec1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/plain-outliner/clickToEditAction.js\":\"1ec0479e61032a95\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/plain-outliner/index.js\":\"1821f40db1d23594\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/plain-outliner/interactions.js\":\"fcd1a07b72d55ae9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d810ea5f9efc0244\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/MigrationGate.js\":\"a1ba1f10d9193ff4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/MigrationGateDialog.js\":\"a362f48de151803c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/action.js\":\"f3a61359d45804c8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/index.js\":\"b4b3a89ee8944b75\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/localRunMessage.js\":\"222aa330ddcd7e7f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/plugin.js\":\"a1a2c2caa4133497\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/progressReport.js\":\"184af2ab9d7c5cea\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/properties-migration/sweepProgress.js\":\"37f273a8ccd3413a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/FieldRowRenderer.js\":\"c48f32ca5e601fc0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/ValueRowRenderer.js\":\"d5c4587b764a5f9c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/actions.js\":\"9282c8563e090ad4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/autocomplete.js\":\"539e51c020a7134f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/fieldRow.js\":\"15317fbf1f956b1b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/index.js\":\"9f7bbd1de8fc9096\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/referenceWarning.js\":\"25d038a2d20db9e6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/valueAutocomplete.js\":\"f05bc13d8fe2787b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/property-rows/valueSchema.js\":\"d556fa96baebbbe2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/HeaderItem.js\":\"7928d9b0dc7aaadd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/QuickFind.js\":\"21a3f6a739b6aba7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/index.js\":\"639f9275c83f6747\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/recents.js\":\"f0972018207ab9ee\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/resultItems.js\":\"116b32e77062f0b3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/selection.js\":\"f59b310b71b7d925\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/quick-find/toggleStore.js\":\"1bb37ee9c0f9c1dd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/HeaderItem.js\":\"526b9aed2f6d3ad2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ae3794220a1f8fcd\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/grouping.js\":\"8be3c253c9e702e9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/index.js\":\"e83949349cd79c68\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/recents/target.js\":\"dd34545e9a70456f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/codeMirrorExtensions.js\":\"535acbfc14352c6e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/contentPrefill.js\":\"015fcc23bc2efc8d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/dataExtension.js\":\"798f3d25575fda52\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/index.js\":\"210eea51d91f9ca3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"661a426b20b13893\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/invalidation.js\":\"00a4677d42e8ffd2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/localSchema.js\":\"99d8e2aeb756f52f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/blockrefs/index.js\":\"cba26f23c418d541\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8da6f5bd31a72680\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/index.js\":\"e6a6be37f07d3869\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/referenceNode.js\":\"845857de078d9b14\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/remark-reference-occurrences.js\":\"dcdc6e175b279b5a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"818f4142d36a77ac\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/wikilinks/index.js\":\"bc0aaeeddda65fa8\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7034ace4fb68efb6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"71b791b4ba4ebac6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/mergeRetargetProcessor.js\":\"1e3598e494626a23\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/parseFence.js\":\"f8b7d6e03086af70\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/referenceParser.js\":\"6734476df12b5f72\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/referenceProjection.js\":\"7978950650fe10a0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/referencesProcessor.js\":\"c9da90cc4bf5859e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/renameProcessor.js\":\"ce8ab1095ca6a326\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/references/spanReplacement.js\":\"6868582295b81f2c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/rich-paste/htmlToOutline.js\":\"a29e985bb0becf74\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/rich-paste/index.js\":\"c121ade68d3de4af\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2545ea9b3865abcb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/rich-paste/pasteDecision.js\":\"bfd022569ee99dbf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/action.js\":\"2cdd33d29a3c5337\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/blockIds.js\":\"a87798cbc454ba10\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/content.js\":\"f91c7d2f62079dfe\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/effect.js\":\"706f096abbe2f2f7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/ids.js\":\"8b1a33da5d166a82\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/import.js\":\"0fda39b4f4e8ec6a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/index.js\":\"93722e466652c0cf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/plan.js\":\"6cefcf3c9482f4b6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/plugin.js\":\"3b6e6229e71e1f3f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/promotion.js\":\"39236eb74b8a1236\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/properties.js\":\"08a2085bedaa01bf\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/references.js\":\"1c8f48a69e446605\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/report.js\":\"59865a386bb897d0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/roamMemo.js\":\"d4f03c71b425c69a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/runtime.js\":\"868919ed18b410b6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/schemaReconciliation.js\":\"ef91134ccdb5ba82\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/srsMarkers.js\":\"476dca794425e46e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/todo.js\":\"b6e9d374fcaf6219\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/typeCandidates.js\":\"c2a7a3afc6360aec\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/roam-import/types.js\":\"34269799db605ada\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/search-health/index.js\":\"c57e04c216b969af\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/search-health/store.js\":\"f517a6e574d5d503\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/HeaderItem.js\":\"9db30842728a5250\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5119db6feb41ee01\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/index.js\":\"cb929c20772904f4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/model.js\":\"9a1be30892d53cfb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/toggleStore.js\":\"f56171f753c0d086\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/shortcut-help/useKeyInspector.js\":\"5e6a20723e0e46e7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0342869b0dced72d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/ShellDecorator.js\":\"b09902deea6b179c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/actions.js\":\"c6f645cb81f14044\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/exclusionsFacet.js\":\"26bb13b439b29b2d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/index.js\":\"32d73ebb532f0efc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/shell.js\":\"7e64236bbdf7a604\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/surface.js\":\"c4d4846204e11d9f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/spatial-navigation/walker.js\":\"203620e75cf18d6b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f8680cc8def0e8aa\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/dataExtension.js\":\"b7fd709e399a83b1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/index.js\":\"99ec05e9157d5468\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/indicator.js\":\"5b0b4a80db8c4e02\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/moveSrsState.js\":\"a65f40bd4b81c9c2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8a8a4258e950aced\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/scheduler.js\":\"d0a9127a1571d5a9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/schema.js\":\"8ed922cba69afab7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c67b929dee11b10a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/srsClipboard.js\":\"5622bef5869c3ee3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"695e31598fa3eb23\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/DailyNoteReviewHint.js\":\"51b0d382bebbc06b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/DeckPicker.js\":\"92ed0de6410208ed\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/ReviewControls.js\":\"045d688bbcf827fb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1523ee670de6f02d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/ReviewSession.js\":\"85cf55aff64a992a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/actions.js\":\"333809c249b5b193\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/archive.js\":\"e94744894437e7b7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/dataExtension.js\":\"02eca26c7113dd52\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/deck.js\":\"5ab9437eb5d99861\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/dueQuery.js\":\"f64771e577b01bb3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/gradeDecision.js\":\"924c290cbd4c7cf7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/index.js\":\"f53f98fd0600c485\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/keyHints.js\":\"a8b7c73ed80f2e3a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/reviewCardLayout.js\":\"a62615ef0063b757\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/reviewProgress.js\":\"c662439a693bd922\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/schema.js\":\"1d8b77a217ff5f30\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/srs-review/useDueCards.js\":\"084c354f80aa6687\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/startup-metrics/index.js\":\"820a3503bb308da0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/startup-metrics/record.js\":\"d5f757fb7b58a926\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/storage-persistence/index.js\":\"cc78e06d32b1dcd0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/storage-persistence/persistenceStatus.js\":\"9ac8ac461c30f4df\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/storage-persistence/requestAction.js\":\"6d948709ea0be63d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/supertags/TypeChipsDecorator.js\":\"f49bdf785795c373\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/supertags/codeMirrorExtensions.js\":\"8924973d8ee49882\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/supertags/index.js\":\"4987661e9b635f0a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/supertags/typeAutocomplete.js\":\"a4de882b406b6baa\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"33b8c5ff3cf677bc\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/actions.js\":\"7d5ef902a6915920\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/anchor.js\":\"c9a373cb580ff47b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/events.js\":\"f1830c2468536444\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/gestureActions.js\":\"27dd17cb044f835e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/index.js\":\"c546bd51b49f200e\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f7bc97a08030e3ef\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/sync-metrics/collect.js\":\"2c80b233c91745c4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/sync-metrics/index.js\":\"eed50cf7d30dcde6\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/sync-metrics/record.js\":\"059be08a4ee728ad\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/RejectionDialog.js\":\"2655d365b777e449\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0cffa60f25c457d7\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/index.js\":\"bf874ad514cf5841\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/model.js\":\"53674a4e1e583e8f\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/queueCounts.js\":\"754f9dbd808c5509\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/rejectedHelpers.js\":\"82e4eb8a5323bf06\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/rematerializeAction.js\":\"6c566c18057c38fb\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/system-status/useHysteresis.js\":\"372d21108713c80c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/theme-toggle/effect.js\":\"901e198826027fc3\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/theme-toggle/index.js\":\"c48f4be2b7abc189\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/theme-toggle/theme.js\":\"e4873be2be60862d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/todo/actions.js\":\"8535eb8cf6cd1e7d\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/todo/dataExtension.js\":\"e5ad163f86d15b17\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/todo/index.js\":\"add5c4f8f79ac443\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/todo/schema.js\":\"94e35bf784e9de81\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/TouchSelectionLayer.js\":\"83beed50c2bc1557\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/actions.js\":\"d0c10110dd358548\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/defaultItems.js\":\"bf6ea82983b502f1\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/facet.js\":\"2e975b988ca69199\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/holdRecognizer.js\":\"76ab034f8eaec806\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/touch-selection/index.js\":\"1b79673b37360a54\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/update-indicator/UpdateIndicator.js\":\"a2d4e036923378d0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/update-indicator/index.js\":\"90a4ec411cdc2ef4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/update-indicator/loadTimes.js\":\"f537503adf90ce1b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/VideoNotesRenderer.js\":\"c07f03c8321a5c3b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/VideoPlayerRenderer.js\":\"c6c3a59b8d24bcd9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/VideoTimeStamp.js\":\"02ee5ba95e0c7580\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/actions.js\":\"22c0387667811533\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/index.js\":\"14c78760490802e9\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/markdown.js\":\"1e8b0c1b002fa847\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/notes.js\":\"9566da96985f7472\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/registry.js\":\"95288740bc7609f0\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/remark-timestamps.js\":\"263980d168e274b4\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/video-player/view.js\":\"f2dc8ccf9ad96b6b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-link-hints/LinkHints.js\":\"aa4f57a198677686\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-link-hints/index.js\":\"b9627b5fc8d8cb71\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-link-hints/model.js\":\"a529e615b637aae2\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-link-hints/settings.js\":\"334e26f11adc746a\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-normal-mode/actions.js\":\"85b5350c9f1a86fe\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-normal-mode/index.js\":\"24a3add4e7697b0b\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/vim-normal-mode/interactions.js\":\"62c1e6b4fbc01f6c\",\"/knowledge-medium/pr-preview/pr-1811/src/plugins/workspace-header/index.js\":\"f1ad1a5a9502599d\",\"/knowledge-medium/pr-preview/pr-1811/src/registerServiceWorker.js\":\"702a2ab5e8e14963\",\"/knowledge-medium/pr-preview/pr-1811/src/requestPersistentStorage.js\":\"ba4c8c9d12a02721\",\"/knowledge-medium/pr-preview/pr-1811/src/services/authRequestDeadline.js\":\"283ac2b7121bb005\",\"/knowledge-medium/pr-preview/pr-1811/src/services/authStorage.js\":\"4468b08034157900\",\"/knowledge-medium/pr-preview/pr-1811/src/services/powersync.js\":\"67f6f89fd32cb58f\",\"/knowledge-medium/pr-preview/pr-1811/src/services/supabase.js\":\"82b30a76429d230c\",\"/knowledge-medium/pr-preview/pr-1811/src/services/uploadErrorClassifier.js\":\"66e7ed716343906c\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/ActiveContexts.js\":\"687e8f0114382419\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/HotkeyReconciler.js\":\"a41794abd822693d\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/WipeLocalDataDialog.js\":\"1a9c259cf25bf942\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/actionDispatch.js\":\"20ce81b53995831a\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/actionRefItems.js\":\"0c51d745592df430\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/applyKeybindingOverrides.js\":\"7325ce0b9d5cbe99\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/blockActions.js\":\"31cda0fffed2f568\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/canonicalizeChord.js\":\"ef49661b8b97a823\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/defaultContexts.js\":\"b26e13e183a66918\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/defaultShortcuts.js\":\"6e0244fe0d9aef85\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/effectiveActions.js\":\"cbc5cf9c3d6c48ac\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/gestureAction.js\":\"9426141b339d228a\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/gestureBinding.js\":\"a8a2b5653c5e9a9e\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/holdRegistry.js\":\"59ba289d44af60e1\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/keybindingConflicts.js\":\"e98d7f1715e7b3c2\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/keybindingOverrides.js\":\"2244927b085ffd72\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/pointerAction.js\":\"35b9e2028935bfc2\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/resolve.js\":\"a05d92bee64383b8\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/runAction.js\":\"7f98993601c8c6cf\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/sequenceMatcher.js\":\"a5b7f7a7a1d4a519\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/types.js\":\"40043b0637a0138c\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/useActionContext.js\":\"c4ab25d16fecab6d\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/useActionDiscovery.js\":\"0d6e0b33cd7a753f\",\"/knowledge-medium/pr-preview/pr-1811/src/shortcuts/utils.js\":\"9787a2bb3589f899\",\"/knowledge-medium/pr-preview/pr-1811/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1811/src/sw/bootStore.js\":\"42ddce24687d273c\",\"/knowledge-medium/pr-preview/pr-1811/src/sw/previewDatabases.js\":\"2442c1dd996c542f\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/byteTransform.js\":\"d469e232c9f1fff6\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/attachmentCleaner.js\":\"eba906fd1702e3d4\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/attachmentParts.js\":\"e3933c39633d0f06\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/bundleParts.js\":\"7f29a5c71c406a9e\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/bundleRecord.js\":\"9fc45977367efdf9\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/manifest.js\":\"57c8872a2e175174\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/takeBundle.js\":\"a33bb9f8d68f5a51\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/bundle/verifyBundle.js\":\"7f4b7b5514d944f1\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/cleaningStage.js\":\"a5ba83dfffd0ed85\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/conversionKey.js\":\"efb2f7085159566e\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/conversionServer.js\":\"4b55b1a75d49d312\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/flip.js\":\"0a62719e6b05ae2d\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/flipAttempts.js\":\"f0ff640a4643b72b\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/pages.js\":\"6dd7378706c4af5b\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/preflight.js\":\"1e16a70e9c6c9279\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/reseal.js\":\"b0581db393ffcca2\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/runConversion.js\":\"75396b5dc8ea5bfa\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/runLock.js\":\"50d488a69e8d0371\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/sealing.js\":\"0a679c2a9bb327cf\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/sealingStage.js\":\"ccaaeba18bac53bb\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/stage.js\":\"4e26134ca242a40b\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/conversion/verifyReseal.js\":\"d85d415ffd43fa11\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/aad.js\":\"775c06ad06144ae3\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/aead.js\":\"bbfb848bf4a98b2e\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/base32.js\":\"16e434ee9859b546\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/base64url.js\":\"7b7d710b61d39944\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/binaryEnvelope.js\":\"042c9a6d4a585bc1\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/byteAead.js\":\"ddb2e0d19b899963\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/canary.js\":\"d98312426cb3c0c2\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/contentHash.js\":\"cbd0a827f8a859d9\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/contentKey.js\":\"47a04292dbacbb7d\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/derivedIdNamespace.js\":\"6e5b18a164fb2b53\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/envelope.js\":\"0fa619ac4954d057\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/hex.js\":\"d1da5cdd89f271c0\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/sha256Hex.js\":\"ba7c5873da2d7542\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/crypto/workspaceKey.js\":\"924e5c4c0d13e681\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/conversionState.js\":\"2e0150c43cc1663e\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6ff0641ed522d5fb\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/flows/pastedKey.js\":\"b450a14c186bc4ec\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"918cc4d0402e42bf\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/flows/upgradeWorkspacePin.js\":\"63585636b5d41d14\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/keyStore.js\":\"7e69f5aa4ee84b84\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/mintWorkspaceKey.js\":\"40f7330272af2dfb\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/modePin.js\":\"8d1abcac62dc2181\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/openWorkspaceKeys.js\":\"3357708b06995619\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/resolveWorkspaceEntry.js\":\"520c6186e8a67874\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/resolver.js\":\"b18e80407c38ac48\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/keys/workspaceAccess.js\":\"49eaad212d046163\",\"/knowledge-medium/pr-preview/pr-1811/src/sync/transform.js\":\"be047e4389bc4d73\",\"/knowledge-medium/pr-preview/pr-1811/src/themeBootDefaults.js\":\"de8e0fdc0c4e4a01\",\"/knowledge-medium/pr-preview/pr-1811/src/types.js\":\"f449ab6a42509bee\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/ClientLocalSettings.js\":\"483caddc1c8ae3d7\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/abortableSleep.js\":\"2a3d80465a0fdd0c\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/array.js\":\"6dfe8b14fa7901fa\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/backlinkAutocomplete.js\":\"1d5243bf1ca53ce4\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/blockCrumbs.js\":\"5bcfb1d34c2492c6\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/blockrefAutocomplete.js\":\"d6b879468f314a56\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/cadencedIdleJob.js\":\"c092f15ae2f66428\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/callbackSet.js\":\"ec7f83c26065ca9a\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/clientId.js\":\"bfaa33b8de92ab6f\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/codemirror.js\":\"75f723283dd6ade6\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/codemirrorCompletion.js\":\"8e456806ad584845\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/copy.js\":\"b2ef187bbd296f02\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dailyPage.js\":\"4c3d3f1f12e529d4\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dbForensics.js\":\"068aea3f2d33c710\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dbForensicsHooks.js\":\"0bfb78e5458a0db1\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/deleteBlockThroughUi.js\":\"f8fddafa1ea1a3ea\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dialogs.js\":\"fef8fcb96e9ff449\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/dom.js\":\"2a5937e86258418e\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/downloadBlob.js\":\"ac79ad32731dee90\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/exportSqliteDb.js\":\"90fa9e260e0bb208\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/fileSystemAccess.js\":\"0fd00562a92057a9\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/flipSlide.js\":\"8bc5b03aaa4007a4\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/fnv1a.js\":\"07286ad2e7412875\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/formatBytes.js\":\"4f65a242c0bffb4e\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/fuzzyRank.js\":\"19df602045f5ad2f\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/idbKeyedStore.js\":\"95335bd32c8c9531\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/idleCallbackPolyfill.js\":\"8578e5837966a69f\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/keyboardAwareScroll.js\":\"11b553884242a7f7\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/keyboardViewport.js\":\"9a98cddc2522c434\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/lastWorkspace.js\":\"9cba5db2772a3a0a\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/layoutColumns.js\":\"d1cade781b7432ab\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/layoutSessionDom.js\":\"3bb6f4c930c866e6\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/layoutSessionId.js\":\"543cab74e3860f9a\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/linkClickGestures.js\":\"2be18ebf1d31d993\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/linkTargetAutocomplete.js\":\"ab297c49add08219\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/localDbCorruption.js\":\"f4aff58f015dd660\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/localDbRecovery.js\":\"20192dee30d851da\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/markdownParser.js\":\"7bf7129e6ce69d95\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/memoize.js\":\"6b4e88e7f8b5a580\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/nameFieldCommit.js\":\"ef4d8bd38475627a\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/nameList.js\":\"4440aab7504c4d01\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/navigation.js\":\"30cf4f720b6c9692\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/omnilinerNamespace.js\":\"74de5531ee3f08c4\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/opfsPageScan.js\":\"8e6e48201324b532\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelClearance.js\":\"3e4b7fe2b0139fd9\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelHistory.js\":\"f12934238d64f662\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelLanes.js\":\"cff29e724b6ba783\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelLayoutProjection.js\":\"ec3d916f9e20b1fe\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelScrollAnchor.js\":\"d83c88b73aaf710a\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/panelUrlFlags.js\":\"90047c7d74046d0a\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/platform.js\":\"022a924084f2e348\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/pluralize.js\":\"dd23fe98fa1919e2\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/propertyCreation.js\":\"7a3bbea4792090de\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/propertyNavigation.js\":\"e8c4d93ad323f296\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/propertyValueContext.js\":\"3a0e6787a98fbff3\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/react.js\":\"247be428c5bfc914\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/relativeDate.js\":\"e1af4d1a541bcb8e\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/relativeTime.js\":\"ab486b7f936de037\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/renderScope.js\":\"479a442b14b44f80\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/resolvedThenable.js\":\"54f47c528e562d37\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/routing.js\":\"152959f30e09f84d\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/safeMode.js\":\"b33a7a5c0ca6a9c5\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/scheduleIdle.js\":\"03534d10b6270c2a\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/screenWakeLock.js\":\"de93e23718ef3ec4\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/selection.js\":\"fc7174d538a1afc4\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/softKeyboardGrab.js\":\"ad8c118193084b39\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/startupTimeline.js\":\"e075218bf99b8e1d\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/state.js\":\"5624647b46878709\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/string.js\":\"fadafbc4e8685bf2\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/surfaceZoom.js\":\"816de601ce901220\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/time.js\":\"784c38ec9faf1bb9\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/toast.js\":\"9cc1a52891014e81\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/toggleStore.js\":\"a9cf2062612931c9\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/untilStopped.js\":\"a47f9ef77fc899fe\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/userActivity.js\":\"51ef9b06a4fbd9f6\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/viewTransition.js\":\"6931a3ea7a36c69b\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/viewport.js\":\"1bc8b9955f55c774\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/webLock.js\":\"b37fa55350dd1cdd\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/workspaceRecovery.js\":\"8beedb97aa706c97\",\"/knowledge-medium/pr-preview/pr-1811/src/utils/workspaceSnapshotStore.js\":\"0ccb2718b4381734\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-compiler-runtime.js\":\"7b56287aa1692fea\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-client.js\":\"e9eaf8dd3097e786\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-server-edge.js\":\"c15010fb5a7754e9\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-server.js\":\"f08d2a05a7691ce8\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-static-edge.js\":\"ede123996fde2bf9\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-static.js\":\"3ed01a61d9900434\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom-test-utils.js\":\"d961d2b3549c24c4\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-dom.js\":\"ffcce213b4934a70\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react-jsx-runtime.js\":\"cb0bf308702fc82c\",\"/knowledge-medium/pr-preview/pr-1811/src/vendor/react.js\":\"2496f968437ca8d5\",\"/knowledge-medium/pr-preview/pr-1811/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1811/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1811/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
