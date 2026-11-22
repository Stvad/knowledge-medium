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
		buildId: "4c07dad29db2-08ec4d9b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/\":\"0fea0a411ae06998\",\"/knowledge-medium/pr-preview/pr-1813/index.html\":\"0fea0a411ae06998\",\"/knowledge-medium/pr-preview/pr-1813/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1813/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1813/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1813/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1813/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1813/assets/FacadeVFS-DqptKQz2.js\":\"95f46b73b3729c5b\",\"/knowledge-medium/pr-preview/pr-1813/assets/OPFSCoopSyncVFS-DWrQVRCh.js\":\"9542765b2928a13b\",\"/knowledge-medium/pr-preview/pr-1813/assets/OPFSWriteAheadVFS-qXL0SDci.js\":\"7d9d7719001b805f\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-DkRWO3f5.js\":\"335a715425f8ac93\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-async-BNyZx3c-.js\":\"0f8d529e1425e26e\",\"/knowledge-medium/pr-preview/pr-1813/assets/worker-CpWaJyYn.js\":\"75ed195dfd8be54b\",\"/knowledge-medium/pr-preview/pr-1813/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1813/chunks/app-DhEn_mNe.js\":\"021d905e0b678e42\",\"/knowledge-medium/pr-preview/pr-1813/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1813/index.js\":\"b499294bbc30054a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1813/assets/AccessHandlePoolVFS-BmzakT7G.js\":\"2f4735be59f7e1b3\",\"/knowledge-medium/pr-preview/pr-1813/assets/IDBBatchAtomicVFS-IxpsWMkg.js\":\"b487e505c571d029\",\"/knowledge-medium/pr-preview/pr-1813/assets/MemoryVFS-CbEWh_qs.js\":\"96500bbc1012a33c\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-Dxll-p-p.js\":\"4f2fba122ab9c924\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-async-CPZnHa44.js\":\"9165a68bdbe1573b\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1813/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1813/chunks/AccessHandlePoolVFS-1ktDt-Hk.js\":\"67652e94384130fa\",\"/knowledge-medium/pr-preview/pr-1813/chunks/FacadeVFS-hQuUoQPX.js\":\"5a05e7e0c406cb10\",\"/knowledge-medium/pr-preview/pr-1813/chunks/IDBBatchAtomicVFS-exLiK-gP.js\":\"659e91db4fcf57ad\",\"/knowledge-medium/pr-preview/pr-1813/chunks/MemoryVFS-Byaf5dNH.js\":\"b88adb6e12cc700f\",\"/knowledge-medium/pr-preview/pr-1813/chunks/OPFSCoopSyncVFS-CILyeYgl.js\":\"0f3e160d919cb283\",\"/knowledge-medium/pr-preview/pr-1813/chunks/OPFSWriteAheadVFS-fpqltlok.js\":\"36f628b4ad58c179\",\"/knowledge-medium/pr-preview/pr-1813/chunks/Preview-CGWRHZJq.js\":\"b10ddac5f62fb1b9\",\"/knowledge-medium/pr-preview/pr-1813/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1813/chunks/card-DNGwNgm7.js\":\"ec70a315c2fddded\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-De2n_AZ8.js\":\"a81eda1346785201\",\"/knowledge-medium/pr-preview/pr-1813/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1813/chunks/mc-wa-sqlite-BmNj0rcl.js\":\"e690251c11187835\",\"/knowledge-medium/pr-preview/pr-1813/chunks/mc-wa-sqlite-async-Dk7WNHJg.js\":\"427abd5c49fe3ee0\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-1wVW3q_Q.js\":\"e6ce66981c81c50e\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-92PetSGH.js\":\"97ec4d399816e8ae\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-BIfVk27D.js\":\"54bcd768d0b48423\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-BUJiIRmN.js\":\"861a52def02f1953\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-CnFFnTbE.js\":\"7b0550bd6fae259a\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-Da-Bh92d.js\":\"b020d71307858313\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-DsCxUCIG.js\":\"e35bdfeac622aa52\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-Q6NTf_1o.js\":\"78143656a64b7e4c\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server-legacy.browser.production-CrF_6jEu.js\":\"33a60c010d3d9fbc\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server.browser.production-D8gMAwd2.js\":\"e382cb36dab2dae9\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server.edge.production-Bl-lJ3P_.js\":\"4a102fecf7e198ce\",\"/knowledge-medium/pr-preview/pr-1813/chunks/server.browser-Dy4sSKqv.js\":\"5ebdcc0f28250fdc\",\"/knowledge-medium/pr-preview/pr-1813/chunks/textarea-CV1LvT2y.js\":\"91e4343e976eb701\",\"/knowledge-medium/pr-preview/pr-1813/chunks/ui-DBILmKcH.js\":\"066dcd3fee7409d3\",\"/knowledge-medium/pr-preview/pr-1813/chunks/wa-sqlite-CUTh2Sb_.js\":\"24b71e151d88d5ac\",\"/knowledge-medium/pr-preview/pr-1813/chunks/wa-sqlite-async-CSMaBvuG.js\":\"01187ce2443d7ce6\",\"/knowledge-medium/pr-preview/pr-1813/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1813/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1813/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1813/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1813/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1813/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1813/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1813/src/App.js\":\"e9a6a24943b9380a\",\"/knowledge-medium/pr-preview/pr-1813/src/appUpdate.js\":\"3d0adb3729450b8b\",\"/knowledge-medium/pr-preview/pr-1813/src/appVersion.js\":\"469152fb4122999f\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/initialLayout.js\":\"53d122e819f9baab\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/openWorkspaceData.js\":\"71c204ed59e51ec9\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/resolveWorkspace.js\":\"6688a6c4189e31f4\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/workspaceBootstrap.js\":\"9ddcfb387efbe632\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockComponent.js\":\"60a03289654fcbfa\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockCrumbs.js\":\"498c8befb2a01119\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockEditor.js\":\"5c18b8398421c63d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockLoadingPlaceholder.js\":\"425c9c33d65f2599\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockProperties.js\":\"4119f3489675c4d2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockSearchPicker.js\":\"b5e362bda64daadc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ConfirmBulkDeleteDialog.js\":\"02390ef0e875bba1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/DividerHandle.js\":\"1f348ab8d143d60d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/DraftEditor.js\":\"da16a8c38ccbafe2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/GutterPill.js\":\"55086f701207a1ee\",\"/knowledge-medium/pr-preview/pr-1813/src/components/Header.js\":\"7d235a1a3fdc86df\",\"/knowledge-medium/pr-preview/pr-1813/src/components/LazyBlockComponent.js\":\"2440b3c132458a89\",\"/knowledge-medium/pr-preview/pr-1813/src/components/Login.js\":\"da03fc66632619b3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ZoomableSurface.js\":\"8e73ca7b7d15c253\",\"/knowledge-medium/pr-preview/pr-1813/src/components/editModeKeepalive.js\":\"340f5a2ec3fb205e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyDisplay/PropertyDisplayScope.js\":\"2fd40771c3189039\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"09392856fddfb3d4\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/RefPropertyEditor.js\":\"5363731f93114088\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/RefTargetTypePicker.js\":\"c568c1f7c279bbc4\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/SelectPropertyEditor.js\":\"42cc0763cf026471\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/TypesPropertyEditor.js\":\"a460d302c2e9d535\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/defaults.js\":\"9c48c45b403a277c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/kernelValuePresets.js\":\"11ee25561e8b5add\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/selectablePresets.js\":\"32ef6748e0c9d90a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/typesPropertyUi.js\":\"cb779328fe18f860\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/AddPropertyForm.js\":\"3b84db62f5983a58\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/PropertyPicker.js\":\"63612f8eba2e4720\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/PropertyRow.js\":\"78b203b1ef6caf8c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/Rows.js\":\"aba7198b144191c6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/actions.js\":\"cdd5e95f828872bb\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/declarationOnly.js\":\"1bc006bf8ddad18d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/layout.js\":\"bed9f2d96dbce523\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/model.js\":\"7cb7ad51e6610765\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/shapeUi.js\":\"e5d45d3a003c5b87\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/shapes.js\":\"6c05ef4acdba8260\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2753b8b06e5bc84e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/visibility.js\":\"5c7042877b34f3ea\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanelSections.js\":\"f185da354e84f227\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockEmbed.js\":\"ee5b2c912caa37be\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockLink.js\":\"25836100e5138ee3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockRef.js\":\"b22982269b0e24e1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/ReferenceLink.js\":\"39f83f9b7203eaa3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/cycleGuard.js\":\"92a1898c97699352\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/cycleGuardContext.js\":\"c372b2b51a18ba32\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/linkInteraction.js\":\"a3918b335f07aa27\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/referenceLayout.js\":\"e18ddd3590cd4f74\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/useBlockRefAncestors.js\":\"055423b41f0f182e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockGutter.js\":\"e1fba1423afd43d0\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockInfoDialog.js\":\"72a145d4440af816\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockTypeBlockRenderer.js\":\"864fbe2a6b543915\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BulletHoverCard.js\":\"3bce118ade456f34\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/CodeMirrorContentRenderer.js\":\"54f99e8fc60fd8f8\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6acc3d0293619e0d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/ColumnResizeHandles.js\":\"ed8548500b8df0b2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ea032e732588ae58\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/DefaultBlockRenderer.js\":\"b353c8bf3f33bc13\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/LayoutRenderer.js\":\"dbe17f33e5522645\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/MarkdownContentRenderer.js\":\"00de029d73bae897\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/MissingDataRenderer.js\":\"8f29a928cbb61848\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/PanelRenderer.js\":\"0a9c0db78c945db1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6f2f5708f9f4ee05\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/TopLevelRenderer.js\":\"7c9eb5dec010a616\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/blockGutterMode.js\":\"8273b3e81f287f49\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/blockTitleText.js\":\"b38397851dd182e8\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/fieldCreationKeydown.js\":\"9ae0ed701bcac1e5\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/layoutRootContext.js\":\"fe28df2c511ee9bc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/typeChip/TypeChip.js\":\"10ebb3e865f292b0\",\"/knowledge-medium/pr-preview/pr-1813/src/components/typeChip/chipStyle.js\":\"625c53546734f7e6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/anchored-floating.js\":\"46fea5bd06f9a5ef\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/button.js\":\"10c071b7983ac73d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/card.js\":\"9bb945ab4153018c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/checkbox.js\":\"aa4c34bead42b07e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/collapsible.js\":\"0b9266859e6e4e96\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/command.js\":\"4cf878f6c70fa4fe\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/context-menu.js\":\"d70ccdd9da65c3dd\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/dialog.js\":\"2ecd387cff958e50\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/dropdown-menu.js\":\"835d30ed25b6c640\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/floating-listbox.js\":\"76d0ad9b83cf6c4d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/index.js\":\"c7e8ab31de94623d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/input.js\":\"499f0efa92991a75\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/kbd.js\":\"41f4c91476ffcf29\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/label.js\":\"3667997567dc7508\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/textarea.js\":\"cc30a80b775c5b48\",\"/knowledge-medium/pr-preview/pr-1813/src/components/useEditModeYieldKeepalive.js\":\"9b3c58108ba17f12\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/BootFallback.js\":\"5ea9e1f55d3e6587\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/FocusedRowLazyMount.js\":\"086076bb2acb1e0d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/LazyViewportMount.js\":\"d2511b0fe1d91d96\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/LocalDbCorruptionFallback.js\":\"78035e1e592505d2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/error.js\":\"f099e8ca14cd2fa2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/lazyMountRegistry.js\":\"7030fd2c561d3d6d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/suspense.js\":\"1234765bc83a6ea3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/CreateWorkspaceDialog.js\":\"5e2949c97ef03545\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/PendingInvitations.js\":\"8d8ba6c4a9fbee4c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/SyncProgress.js\":\"db3f1953aeafcd31\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/UnlockProgress.js\":\"e7414ad13e3ca53d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceKeyGate.js\":\"e10523f26354c8dc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSettingsDialog.js\":\"83c4f841ddffd282\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSwitcher.js\":\"33d6851d6daaa1b2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSyncGate.js\":\"bdc848193e70c86c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/ConversionFlow.js\":\"13c85ff724d5767f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/ConversionFlowHost.js\":\"50952d1f5351f438\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/EncryptionSection.js\":\"5012c5aabe6d52de\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/attachmentPrompts.js\":\"99a39695aeeb743e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9274ff077be320ca\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/conversionFlowDeps.js\":\"1b19937b5223e5ab\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/conversionFlowStore.js\":\"02f1372a199cad65\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/flowUi.js\":\"8cfb2abb8cb2c57f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/useConversionRun.js\":\"8330eca731613651\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/keyUi.js\":\"cafc91ee455be17e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/useCloseOnKeyLoss.js\":\"3f7dbaee270a6231\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/useCloseOnServerE2ee.js\":\"7c9eb3ab746e6e25\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/workspaceUnlocked.js\":\"fcac519d245de52e\",\"/knowledge-medium/pr-preview/pr-1813/src/context/backgroundSubtree.js\":\"148ccec0a9154ce6\",\"/knowledge-medium/pr-preview/pr-1813/src/context/block.js\":\"d9c8d0b123aa7f5d\",\"/knowledge-medium/pr-preview/pr-1813/src/context/layoutWsContext.js\":\"79d320d45582b9cb\",\"/knowledge-medium/pr-preview/pr-1813/src/context/propertyDisplay.js\":\"47c5451e761fcba2\",\"/knowledge-medium/pr-preview/pr-1813/src/context/repo.js\":\"4328766d65a071fa\",\"/knowledge-medium/pr-preview/pr-1813/src/data/aliasClaim.js\":\"9943fde489a412af\",\"/knowledge-medium/pr-preview/pr-1813/src/data/aliasSeatNamespace.js\":\"14bfb6f287f1a086\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/blockData.js\":\"6d15abe958c8e7dc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/blockType.js\":\"fc29a82a72b9d68f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/changeScope.js\":\"83cab6aed9f69def\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/codecs.js\":\"054d42efb416214f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/derivedData.js\":\"a7c92e00c946da05\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/errors.js\":\"4868cdd588747890\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/events.js\":\"66f5adbac58a65ac\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/handle.js\":\"22434c3863e9e187\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/index.js\":\"14f8b31188047212\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/mutator.js\":\"588feb8ad8f50a82\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/processor.js\":\"e902777e36d4fd8e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/propertySchema.js\":\"18c0162a6d99ced8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/query.js\":\"bbdbb759532e3ebb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/sameTxProcessor.js\":\"84b6d8be85c97238\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/schema.js\":\"22434c3863e9e187\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/tx.js\":\"22434c3863e9e187\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/typedBlockQuery.js\":\"b82dbc4dd0310444\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/user.js\":\"3bac92456379c8c0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/valuePresetCore.js\":\"fa9ea6fda656859d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/valuePresets.js\":\"d06673e3ebcd04d8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/attachmentCleanerIOVerb.js\":\"4bf703a936d49f6b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/block.js\":\"8cbdc2ec7f8ca822\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockCache.js\":\"1ef181dcc61c84cf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockId.js\":\"b08b23330a7e4fa4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockLiveness.js\":\"5bd869672dd4d132\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockMerge.js\":\"0bab222343ab917e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockSchema.js\":\"7829b77dd7c3397d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockTypes.js\":\"45ec3c5ec0ef152c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/clientContext.js\":\"373d2b60f50b080a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/dbFileSiblings.js\":\"6a95941c0f9124ea\",\"/knowledge-medium/pr-preview/pr-1813/src/data/definitionSeeds.js\":\"47ea534242fcd1e2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/derivedIds.js\":\"7287a290d03e6a84\",\"/knowledge-medium/pr-preview/pr-1813/src/data/drawnSubtree.js\":\"c38653355842f2fe\",\"/knowledge-medium/pr-preview/pr-1813/src/data/facetBridge.js\":\"0d8779b2cb872656\",\"/knowledge-medium/pr-preview/pr-1813/src/data/facets.js\":\"e847e5baa0f8b327\",\"/knowledge-medium/pr-preview/pr-1813/src/data/globalState.js\":\"6a2565c2b58a262c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/aliasClaimRederiveProcessor.js\":\"2ddacec25672a191\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/ancestorBatch.js\":\"72acb892b0a84299\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/blockTypeTypeifyProcessor.js\":\"c658e5576e914637\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/clientSchema.js\":\"086685eb8c1a0222\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/commitPipeline.js\":\"6620dade78f646cd\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/devAssertions.js\":\"3c74fac814a36561\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/firstSync.js\":\"ed682afee678b825\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/freshInitialLoad.js\":\"d5564ff075ba59cd\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/graphBackfillClaim.js\":\"e8bccc7acbffd682\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/handleStore.js\":\"62d5d7cc0ed897c7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/idleMarkerJobs.js\":\"7b6aacec23a4bd72\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/initialDownload.js\":\"4232b867eed790dd\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/initializeClientDatabase.js\":\"e3f2dcc1ed233a68\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/jsonCanonical.js\":\"e25ef20ce6028366\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelInvalidation.js\":\"402bd473ddb0cc14\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelProcessors.js\":\"4d53f4c624bd675c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelQueries.js\":\"40eb461ca4a551be\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/mergeTypeMembershipProcessor.js\":\"8265e8e0e74cfc7f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/normalizeReferencesProcessor.js\":\"317dbb3593143de8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/poolInstrumentation.js\":\"9fa1d3b26dbac136\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/processorRunner.js\":\"d11f3d2d3ae34312\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyCellBackfill.js\":\"c2c569ef6e6a0ef6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyChildMint.js\":\"798d6df1a0a7826d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyChildrenProcessor.js\":\"72554644a0b581a6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6748037d836bab2f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyDefinitionSynthesis.js\":\"7079cbb46e8f660d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyKeyScan.js\":\"3daa8925172db3e6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertySchemaResolution.js\":\"204f404e498fef5d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyValueEdits.js\":\"81d525850ad2d0dc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/raiseProtocol.js\":\"fdcba89216ec42b2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/readBatch.js\":\"7ce4010598fc79d9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/refProjection.js\":\"34e844b92104f17c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/referenceTargetLookups.js\":\"fb913bc812097923\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/referenceTargetProcessor.js\":\"edd606064b5ab00c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/replayMerge.js\":\"d118e7f49a31bff2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/sqlBinds.js\":\"31bc3314a7384dd7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4a7a5386fd6b7585\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/arrivalProcessors.js\":\"1fb21da06ca9a693\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/invalidate.js\":\"e78701f352666d68\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/materialize.js\":\"369c125257d5009a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/observer.js\":\"5269e1529f394d45\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/reconcile.js\":\"297276a04c7a65ab\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/timingMetrics.js\":\"5279b64ef551abca\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/treeQueries.js\":\"9d492eb31a7b0519\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/txEngine.js\":\"913e74eb37ab709e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/txSnapshots.js\":\"6da54d64c17bc0a4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/typedBlockQuery.js\":\"354af05eb515a07f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/undoManager.js\":\"ec48b0e19031e69a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/invalidation.js\":\"0a14f852478f8097\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelDataExtension.js\":\"a3982ccf959521ce\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelPage.js\":\"0a7583a69ae73e5c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelValuePresetCores.js\":\"d0293af637b563e9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbCorruptionSignal.js\":\"0fe98cc24438dbd6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbStorage.js\":\"20c28cf0803eaaf1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbVfs.js\":\"c65e4ff199bf7775\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localSchema.js\":\"4c5dabd737305a78\",\"/knowledge-medium/pr-preview/pr-1813/src/data/maintenance.js\":\"bb1431d8439d0385\",\"/knowledge-medium/pr-preview/pr-1813/src/data/mergeProperties.js\":\"0f508cae3d77238a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/metricsConsoleHook.js\":\"3a7eafe3b1bc438c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/migrationsPage.js\":\"d29a7a3fd7c74667\",\"/knowledge-medium/pr-preview/pr-1813/src/data/mutators.js\":\"fa418fca55a2818a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/orderKey.js\":\"4e6c3b69d5256e55\",\"/knowledge-medium/pr-preview/pr-1813/src/data/orderKeyPlacement.js\":\"374c613ed7758881\",\"/knowledge-medium/pr-preview/pr-1813/src/data/outlineSurface.js\":\"8c15cce12fa31d30\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pendingEditorContent.js\":\"5b736219a76b7f2e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pendingUploadsSql.js\":\"a4307d25c40e9228\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pluginStateExtensions.js\":\"fd6cc4fef09b358f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/powerSyncLogger.js\":\"db1d40b5ede429f9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/projectorRuntime.js\":\"2215922596af6c72\",\"/knowledge-medium/pr-preview/pr-1813/src/data/properties.js\":\"767e4a66a589b763\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertiesPage.js\":\"2004aaf19f404d23\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyChildren.js\":\"d96c757c4aa500fb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionFanout.js\":\"e2debacab95f8762\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionMetadata.js\":\"954224e09a246272\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionRegistry.js\":\"e1b26a4e7f34c4a4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDisplayMode.js\":\"a044803030f5ef60\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyRowCreation.js\":\"1c7c9a805866d746\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertySchemaCreation.js\":\"c2fdc15205c7ef2f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertySeeds.js\":\"bd585724bf7d5e99\",\"/knowledge-medium/pr-preview/pr-1813/src/data/recentsPage.js\":\"e14944282779adf4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/referenceBlock.js\":\"d513acc2322fcf61\",\"/knowledge-medium/pr-preview/pr-1813/src/data/rejectedUploads.js\":\"76453736b190e84e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/releasePowerSyncConnection.js\":\"0e70dc44ed3acedf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/repo.js\":\"53f5e0c0755eedfd\",\"/knowledge-medium/pr-preview/pr-1813/src/data/repoProvider.js\":\"e39aee839f6cba2e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/rowProperty.js\":\"5ff84967924241bd\",\"/knowledge-medium/pr-preview/pr-1813/src/data/searchFilter.js\":\"73a94c9668cac579\",\"/knowledge-medium/pr-preview/pr-1813/src/data/seedIdentityLedger.js\":\"05d77eafbd7ca91f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/stateBlocks.js\":\"3add3fc9bdd2d45b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/structuralEditPolicy.js\":\"ef729b10ee6baa55\",\"/knowledge-medium/pr-preview/pr-1813/src/data/subtreeDelete.js\":\"1fa05ce655c132b1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncStreamLock.js\":\"0bdfb3a5fdb2fc66\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncedTableSqlRecognizer.js\":\"97c73e2e3e8c73d4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncedTableWriteGuard.js\":\"1e738c82345e8918\",\"/knowledge-medium/pr-preview/pr-1813/src/data/targets.js\":\"39bcb1480c7210d2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeColors.js\":\"28dea5c2837f134b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeDefinitionMetadata.js\":\"b23420915e30b9e4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeDefinitionRegistry.js\":\"a8da44917cd921c5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeExtraction.js\":\"24ee9410a175fbfc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeInitialValues.js\":\"876c54e6f9789287\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typePropertyGroups.js\":\"81b1e9c2cb98d746\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeSeeds.js\":\"d31457ad1dd8bc43\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeTagger.js\":\"1b617edd10d7a679\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typedRecords.js\":\"76c4d00892af880a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typesPage.js\":\"9d1e7a117eadc116\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userPrefs.js\":\"d149455f98a057b0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userSchemasService.js\":\"6bdae78545b8e006\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userTypesService.js\":\"7e861b0d8808af78\",\"/knowledge-medium/pr-preview/pr-1813/src/data/valuePresetRegistry.js\":\"2d0a7af46eb7a692\",\"/knowledge-medium/pr-preview/pr-1813/src/data/visibleChildren.js\":\"c6d71cc5c415420f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceConversion.js\":\"bfb97ca021f4ba37\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceFirstSync.js\":\"094108cfa16a67c9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceIdNamespace.js\":\"241addcfeb0f99fb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceSchema.js\":\"496244c8933e52c2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaces.js\":\"e00eb352f7fe74df\",\"/knowledge-medium/pr-preview/pr-1813/src/data/writeAheadLog.js\":\"63a01c06f06ff0b6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/BlockPasteShellDecorator.js\":\"72a246e42939d531\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/atTrigger.js\":\"e5cb49a0dd463c31\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/autocomplete.js\":\"d2de10e348cc74e9\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/codeMirrorExtensions.js\":\"104523941935578c\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/contentFlush.js\":\"e5641ead950c8e03\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/defaultInteractions.js\":\"35260616539802d9\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/editSettleSignal.js\":\"2997e6819153be9d\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/insertImage.js\":\"32e74beea07eb757\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/referenceCompletionRange.js\":\"ec016a473b50a15e\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/referenceTargetTypes.js\":\"ebf0e90a9c407127\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/syntaxContext.js\":\"5af3a529b496e674\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/triggerMatch.js\":\"e83cd51c342fff87\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/AppRuntimeProvider.js\":\"9b3b12a5bbf4332e\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/BlockFocusShellDecorator.js\":\"fc0f99e1e939a3a0\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/ExtensionRenderBoundary.js\":\"167dd1b9c8738a7b\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/PanelContentRecovery.js\":\"f144b7a6c07559fd\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/apiCatalog.js\":\"d0f2f8d3a7a7dd3a\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/approveExtensionHere.js\":\"1fa5856f88a273a8\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/armedCutAppMount.js\":\"800eb4d8cf09fa42\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/batchableKeyedStore.js\":\"092dd98e4e5fcce3\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/blockInteraction.js\":\"d5a38b3226dfe514\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/blockSelectionAction.js\":\"6c1210c2b2bb813d\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/compileExtensionModule.js\":\"4762fdebee59b215\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/compiledModuleCache.js\":\"149b54a2de4ef553\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/continuousGestures.js\":\"c2a92fb6efe79504\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/core.js\":\"7e9db92ced23666d\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/defaultRenderers.js\":\"2413e88967f5bef4\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/definitionFanoutAppMount.js\":\"0caba85c8b60c055\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dialogAppMount.js\":\"ed7b220a8f71c0eb\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dynamicExtensionSeeds.js\":\"7de6e70e3fcf57e4\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dynamicExtensions.js\":\"91dac96a12c8d02c\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/exampleExtensions.js\":\"acb1738d4503aeb5\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionApprovalStatus.js\":\"6318a8f1bf7878b0\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLoadErrorToast.js\":\"ff5c54749a4c9585\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLoadErrors.js\":\"9f2908474db7c6f5\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLookup.js\":\"2609c8261fbefd08\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionToggles.js\":\"10f8e6818fa83f09\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionUtilitiesCss.js\":\"de3711aeb5c46ab5\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/kernelPageDeletionGuard.js\":\"d42dc59b78b0d28c\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/liveRuntime.js\":\"766d0ab185d9a662\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/openExtensionsSettings.js\":\"908543ef69bea0fd\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/overridesCache.js\":\"29bb822649662ac9\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/pluginIds.js\":\"08840c8e140630b0\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/processorRejectionToast.js\":\"dd5659d66cf9e292\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/runtimeActions.js\":\"853f83c56317ba78\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/runtimeContext.js\":\"abaeaeaa5178a303\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/staticAppExtensions.js\":\"f651b5084cb2f07c\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/staticDataExtensions.js\":\"f3b2a149ea2c9445\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/toastAppMount.js\":\"457f609a76e860d4\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/useOverrides.js\":\"0ceb7ecc38ec9b03\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/useShortcutSurfaceActivations.js\":\"858615a305144c9f\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/discoverToggleTree.js\":\"420f4e85aa35a4ec\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/facet.js\":\"af66504b9d9fc8be\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/resolveAppRuntime.js\":\"6768fac479332bb1\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/runtimeEvents.js\":\"2c00da69692fc56b\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/togglable.js\":\"fb6b30ae94ac7f50\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/variantFacet.js\":\"bac86a59e1f07851\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/verbFacet.js\":\"d64019c0e9ff3027\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/block.js\":\"64a8f64487e954e7\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/focusedChild.js\":\"84e1482869267712\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/propertySchemas.js\":\"bf8007f743e87e4a\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/typeRegistry.js\":\"84d337380fb8f1ff\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useAncestorCrumbs.js\":\"0b58e86d1c8daac9\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useAutocompleteListbox.js\":\"ae5150278df72eba\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useDebouncedSearch.js\":\"c7527ff4c7ebabe9\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useDebouncedValue.js\":\"8b4edc0a110da0fc\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useIsFocalRender.js\":\"ad66a642301c1838\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useIsReadOnly.js\":\"8700914a9c1075e9\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useMaterializeBacklog.js\":\"bb9a1afb1f9322c3\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useMinuteClock.js\":\"dc54f9feea3b3e6d\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/usePanelLayoutProjection.js\":\"f4dd55ece32cdacb\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/usePendingInvitations.js\":\"ef483850758ea056\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useRendererRegistry.js\":\"072f0cd6e8cba6f1\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useRetainedFieldRows.js\":\"1d5ef6f0f4aa79e5\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useWorkspaces.js\":\"dd4f14bd75cc4a44\",\"/knowledge-medium/pr-preview/pr-1813/src/lib/utils.js\":\"a6848e12c5ff19c4\",\"/knowledge-medium/pr-preview/pr-1813/src/main.js\":\"5e071c697feed4fe\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/MarkdownImage.js\":\"53bb8a9a839153b2\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/blockSeparators.js\":\"d6bd80c3396a0a27\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/context.js\":\"de35588847496218\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/defaultMarkdownExtension.js\":\"145eb969390c96da\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/extensions.js\":\"ffd36e0400e47906\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/renderMarkdownHtml.js\":\"271296c1e38405f8\",\"/knowledge-medium/pr-preview/pr-1813/src/minimal-editor.js\":\"334ee7f766081c56\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/armedCut.js\":\"5d688d3bfc9aa044\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/captureMediaVerb.js\":\"7da16e87c8ec7ee5\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/clipboard.js\":\"524c0cf101a6add6\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/decision.js\":\"2987f34880a6e8e3\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/operations.js\":\"91eca6de72c25557\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/account-header/AccountHeaderItem.js\":\"10d64a43e87e3960\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/account-header/index.js\":\"d53ef35e0a0a4ac5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b3a2792d16c678a5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/askAgent.js\":\"1842ffccb1c83372\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/askedStore.js\":\"01c0069ec5daf5ce\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fa89617908b3b5d7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/chipState.js\":\"ef24b12d11088197\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/dataExtension.js\":\"23e7b54ac4c0dec3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/index.js\":\"c5bfbe237acb8949\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"3d4f0c6754fee762\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/schema.js\":\"55ef4c7771016e35\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c1c6db28a36d0291\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/BridgePairingDialog.js\":\"18d0948ce3edc7a7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/addMedia.js\":\"d46be9ae17f677c0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7544a102fd5ebfd8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/block.js\":\"200539bc88c9dc56\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/context.js\":\"9fb2045c3bc7593c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/displayIds.js\":\"40e39bf4bd41f5f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/index.js\":\"12909574a2618066\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/outline.js\":\"59f8394ca17b3be8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/properties.js\":\"b67e57b29850c880\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/refs.js\":\"02380b5e80fdc3e3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b37c216934bbb762\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/search.js\":\"8734b6d70df55756\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/shared.js\":\"24a6b65307152b7f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e498e935c66412e7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/text.js\":\"c9fd61a59aeb9517\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentWrites.js\":\"bbf824e01eade56a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/authoringCatalog.js\":\"431b349a01f4159f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/blockRefTargets.js\":\"1251504b40e94800\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/bridge.js\":\"e4af58b3056d247b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/bridgeLoop.js\":\"6091e3614712c9cd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/changeHistory.js\":\"e9120347ad44c855\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/commands.js\":\"498db6a4b0a2c3d7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/commentsCommands.js\":\"8bf1b39f5ab9c690\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/dataExtension.js\":\"2c0a3e4feb8268c1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/dataModelGuide.js\":\"d91c1692bfe32859\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/describeRuntime.js\":\"c0ff15b256db1d36\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/extensionLint.js\":\"c745c149a2cbc080\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/grainAudit.js\":\"27ba219d9ea65a96\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/healthCommand.js\":\"293f3793d3fb8c82\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/index.js\":\"1c2bbb6cc2675beb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/presetIdentity.js\":\"ce0c64aa5d0ef526\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ee2dceb0c50ae9cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/readMedia.js\":\"ef9db49fca6a4b25\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/schema.js\":\"661ca7fab149677c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/serialization.js\":\"791fb86d62dd433a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/targets.js\":\"ab9bdc17d2f14310\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/tokens.js\":\"d00d97046bdbe5ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/watchEvents.js\":\"9a27c4a6b22b4274\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/workspaceGuard.js\":\"ede9fd8eac2db569\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/writeCommands.js\":\"f3912ede731f1d3f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/AliasCollisionToast.js\":\"0562d0c9ff77a774\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/DuplicateNameBanner.js\":\"d4e4a8bcf0d63e12\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/collisionMerge.js\":\"9ca352d73f7145db\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/dataExtension.js\":\"3a2ed33a7261afec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/index.js\":\"f09adce7a22c2cdc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/mergeCollisionAction.js\":\"ead83a7db2094882\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/pageStyling.js\":\"192257f6bd1e6b20\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/rejectionToast.js\":\"a0ba65a9a072b89e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/syncProcessor.js\":\"83a25d2556c604e2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/actions.js\":\"88c925e1578c8622\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/addComment.js\":\"7ceed26a958f2053\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/anchor.js\":\"51eaec33181b021d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/anchorState.js\":\"624e75563bd6fc67\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/commentLinks.js\":\"3bfc9b4d433ba494\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/confirmThreadDeletion.js\":\"3a2ecf7327b2e440\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/container.js\":\"f2a524d94fdab514\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/dataExtension.js\":\"dcaabb21bbbe1008\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/deleteComment.js\":\"e6e888cbc8239491\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/highlights.js\":\"29f9e1f3c36c3625\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/index.js\":\"9e4c95bbc346e1b0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/linkedCommentsPill.js\":\"ca062b6b160f4d38\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/margin.js\":\"34acb1b215b45fb0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/marginSchema.js\":\"117720375ec93c8b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/newComment.js\":\"4b642d008e4dcd42\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/ownThreadPicker.js\":\"2b087edcd7340c89\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/placement.js\":\"0619f8a14e1b97e3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/queries.js\":\"ed7d26b75dd513bc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotePosition.js\":\"3bc43927bd25d7f7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotedIn.js\":\"f149b72c5f8e4622\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotedRange.js\":\"309def643ea9324c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/rangeRefs.js\":\"bd75ad7904df7a6b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readHighlights.js\":\"039b5c5b01a54a3f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readSelection.js\":\"1c8c68cc69a1559d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readSelectionUi.js\":\"95794e0b29d5ef54\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/reanchor.js\":\"921d6775d8c5e582\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/schema.js\":\"faf90996da606d99\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/scope.js\":\"2a3ba6bde6166678\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/scopeThreads.js\":\"2e9c52dee5a8f129\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/splitRetarget.js\":\"c93f0b3cf3ff0cd6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/suggestionCard.js\":\"6f84bc908cb20282\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/suggestions.js\":\"661d8cda5977a8a0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/summaries.js\":\"6d08bcde3148bc7c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/summaryBatch.js\":\"e30f5ba65efc8473\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/surface.js\":\"56a737c127476041\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/threadNavigation.js\":\"a10c69274017dbb6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/threads.js\":\"54bb994728e2fcae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/ui.js\":\"cc51bdfae2a33dcf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/uiStore.js\":\"e67780a7de1f21eb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-intents/appIntents.js\":\"dff9e0388f6838ec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-intents/index.js\":\"115c1a98846b5b89\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-update-prompt/index.js\":\"c239c88751d21f0d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-update-prompt/status.js\":\"91b344765ead6f09\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7ce0551d5daed1d0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaBlockRenderer.js\":\"ab9ceed70e603d66\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5841c437f127991c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaUploadReconciler.js\":\"9b391338812ef21e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetDownLane.js\":\"81cde2d88d0199c2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetResolver.js\":\"8db2f1886e33b7e7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetUpload.js\":\"8709192a494fc609\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/attachmentCleanerIO.js\":\"d9c04c1d10fdb93e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/supabaseAuditIO.js\":\"ffe6e6353652a387\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/blobStore.js\":\"ea69f95e75fa6a92\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/byteStore.js\":\"80289dc6f355352d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/cleanerIO.js\":\"c5d3846bec533a1a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/cleanupAttachments.js\":\"f69779ea152baebe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/dataExtension.js\":\"f4cd6d3c5e9e524c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/downLane.js\":\"264a8db4b470f99c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/index.js\":\"f5856a6fd1250a45\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/insertImageContribution.js\":\"4539e3b16c6b4616\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/laneArming.js\":\"dcdb1bd8f8d9f714\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/laneLock.js\":\"f1724bd855843635\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaBlock.js\":\"3ad8b353c8ec962d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaCapture.js\":\"8b8f4ff5c1cd95e4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaViewers.js\":\"612697bdf02d43c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaViewersFacet.js\":\"91443b2d15522fc8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/pasteCapture.js\":\"2204f0eda82eacac\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/resolver.js\":\"5aa249d6e3880332\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/retryUploadsAction.js\":\"1d5a6f72334cc8cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/storagePaths.js\":\"49404ac4f06f124a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadDrain.js\":\"2e4058b54534c740\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadLaneStatus.js\":\"200c6721aa020a32\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadReconcile.js\":\"3c2eecdd704d471e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadRecovery.js\":\"95e85112b3f818e3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadStore.js\":\"82b1f181f431754d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/useAssetObjectUrl.js\":\"64dcb645747cc2b9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"bb78d1bab2375426\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/BacklinksViewSection.js\":\"20a8cbf3523d1998\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/facet.js\":\"aa91493e54a38461\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/index.js\":\"931857af238ffae0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/prop.js\":\"94c1c2457e261f1a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BacklinkFilters.js\":\"17f3614318076f29\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9c58d44da120298d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BlockEntry.js\":\"4fb9c14911332c15\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/LinkedReferences.js\":\"0c6482fca40bf27f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a42f13c432f48c62\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/dailyNoteDefaults.js\":\"1836ae9e98bcb107\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/dataExtension.js\":\"ae7b58d1053dbc91\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/edgeExclusions.js\":\"8db9a164d6375d75\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/filterProperty.js\":\"3944631f3d0ce754\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/index.js\":\"891fe41cf1ea41df\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"53e08daa470fb1ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/applies.js\":\"f5f73a6b41f5388b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/countQuery.js\":\"58b94c95995fb2fd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a830f3e14f3f9362\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/index.js\":\"f8622a7bbb3a5a81\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"44abe474d3f13349\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/presentationInvalidation.js\":\"f880ecf4c1fe2aa2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/propertyEditorOverride.js\":\"4ffae1bb8efa0b7e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/propertyFilter.js\":\"d84769507bfe6bbb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/query.js\":\"84d2a6b0b53bb504\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/resolveFilter.js\":\"b058d1dde0b07a66\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/sourceBatch.js\":\"627181d493294613\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/sources.js\":\"8d24271dc06dd599\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/useBacklinks.js\":\"ef8d513bd9bd08b4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"884b95e1e86c253f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/BirthdayCelebration.js\":\"31c5cafb808a0b1d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/BirthdayOverlay.js\":\"afb97a8c893b775c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/gate.js\":\"68da8fe7bffda13e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/index.js\":\"1e249247501b9a82\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/wolfTheme.js\":\"adb3d1e05853ef1a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/BlockDragLayer.js\":\"c660d5dc015f3016\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/dragController.js\":\"ba8a4c02bf6927a4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/dropTarget.js\":\"83cd27e5064339f3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/index.js\":\"a4329bb6330559ec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/projection.js\":\"3669d119a9bdfe3c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-info/BlockMetaCard.js\":\"9d1d9e2d86f5687c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-info/index.js\":\"416ea26f1e635fe9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/AddTagDialog.js\":\"90feaef770b9e946\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"05b954e37d321d1a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/TagNameIssueHint.js\":\"eaccc8a917ff37d9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/addTagAction.js\":\"ad072ae666c7e632\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/appendTag.js\":\"70ad983f41ab3921\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/config.js\":\"0e774982b96be3c5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/dataExtension.js\":\"b6b9f718a4d0a4f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/index.js\":\"2f0ff2c8666d872e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/propertyEditorOverride.js\":\"a7b82624eb35314c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/BreadcrumbList.js\":\"3a93a7c282254386\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"150e260698a2aa80\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/Breadcrumbs.js\":\"65d3aa839c5c59ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"50277dffabee7b7d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"023639b7e9e43d71\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/index.js\":\"701de3b2cfbf1930\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7ada50dbb1896e5e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/CharacterCountItem.js\":\"2f762bd278993898\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f5c36b2aa8be87db\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/actions.js\":\"0d826a9ff96a0f5e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/blockType.js\":\"0e6c0e3392ca4acb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/charCount.js\":\"2f4a86aba1953a3e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/dataExtension.js\":\"5a08c9dceeb8896c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/index.js\":\"4fd48b754ca4db60\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/profiles.js\":\"2c3ae44657dc7052\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/properties.js\":\"b1f2ebb032007ad8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/textCounts.js\":\"e33cb0ad5ea6ce85\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/colemak-keybindings/index.js\":\"b97ad04ed219f0a0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/CommandPalette.js\":\"a4174ddac7d90f26\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/HeaderItem.js\":\"5484cf35b39205e9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/context.js\":\"7a0e3d3379f84326\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/index.js\":\"84a5d0b8bb659664\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/selection.js\":\"9925277d2083f2d5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/toggleStore.js\":\"004fd1d8f6a52e07\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/useCommandPaletteActions.js\":\"fdcaf074991fb8b0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/ContributorBadges.js\":\"c5051a34128fe39b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/author.js\":\"2cb3c07041e6b4b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/codeMirrorExtensions.js\":\"3350e9c83b19f17e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/dataExtension.js\":\"3057335f50fac614\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/index.js\":\"c93fabdb27d78280\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/mentionAutocomplete.js\":\"bdf5f6fe2dd02b9f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/processor.js\":\"89355933b913b4b8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/profiles.js\":\"d6a350ae83f7b5e7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/queries.js\":\"933106332322203e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/schema.js\":\"0bebe9017704f040\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"663a7d65ee192836\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d591480713c9e769\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/index.js\":\"6adeba56238ee075\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"87173a31adf83b8d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0314b52ec635a070\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/CalendarGrid.js\":\"ccc891a6d1386146\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DailyNotePicker.js\":\"14c7249b59674a74\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"881f1c32dcdf7abe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateNavDecorator.js\":\"7ab65806e1db33cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateScrubOverlay.js\":\"ad0f9e4dd87b8621\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/HeaderItem.js\":\"20bc72df29eaa06b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/ReschedulePicker.js\":\"a7403356ea22a4c2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c3fc534b5b6fbe15\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/actions.js\":\"1be660fd820b1d22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/blockDateAdapter.js\":\"6d599e604c9a3756\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/calendar.js\":\"62b13be2226ff0d2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dailyNotes.js\":\"28840c14aaf7b031\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dataExtension.js\":\"b20d038b163d0963\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubActions.js\":\"cd7a08976454e5aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubGesture.js\":\"080f7bd08cbdcecc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c9d8e114f99fc72b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubRecognizer.js\":\"be1e3882a2825322\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/deletionGuard.js\":\"25f576c0f8f0578c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dueQuery.js\":\"31a9b80b8543658a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/index.js\":\"84c2ece2a3b054cf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/landing.js\":\"4421c25a861acb68\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/localSchema.js\":\"01ef3667632a8db9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/referenceDateAdapter.js\":\"2c05bd26891cc293\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/rescheduleAction.js\":\"b047f47c00de9cfe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/schema.js\":\"3544d820fbd7e209\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/spreadBlockDates.js\":\"018555ec90f59d94\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/spreadDatesAction.js\":\"89f2106e75420eb8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/today.js\":\"48df64dc824e36ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3e02e6963c6b8236\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"604596904d972f1f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/audit.js\":\"e1a1a8c001e28170\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/auditAction.js\":\"32a3ce6a4d79916b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/auditRanges.js\":\"4709b7e78b481726\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/diagnosticsSource.js\":\"e6821bd129f92ee1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/divergenceScan.js\":\"c8be3def960fdaf4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/index.js\":\"84a6ac899839cbee\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/propertyChildrenChecks.js\":\"43d6d924770bd4e3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/referencesMirror.js\":\"ff0217b85762c4d3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/rowJson.js\":\"d57dc5235ae64057\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/schedule.js\":\"26b501788a21b75b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/store.js\":\"8c36ef011a8f5484\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/action.js\":\"e062c21c5a63ff2d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/index.js\":\"d68f3a6f91123234\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/plugin.js\":\"013478e4480c9654\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"881d88f5cc6c8770\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/actions.js\":\"f5e7b7d624e90b38\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/changeMarker.js\":\"3a0ef84dc0e37c55\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/diagnostics.js\":\"3db0bda476d1e384\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/fileSystemAccess.js\":\"63d9a6d127c050b4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/filenames.js\":\"c265f54737c5a665\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/index.js\":\"bdbb5b1b198b3505\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/mirror.js\":\"059180d78286f680\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/runLock.js\":\"dde4bd3956abf52c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/runtimeHealth.js\":\"336ce24cffa8698e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/schedule.js\":\"9c65c6c78959ad53\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/store.js\":\"093e40b82b8ebf02\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/default-themes/index.js\":\"d289b65967fe9673\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/default-themes/themes.js\":\"867f00b28e04e7d5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/diagnostics/facet.js\":\"4c69f9baa68bf469\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/diagnostics/useDiagnostics.js\":\"0ebf1c44678adf5c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/dismissals.js\":\"42a43fc49f5b6a29\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/index.js\":\"acc28fc257e65c4f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/status.js\":\"4624770b3f83060d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/store.js\":\"0ee026c647e13902\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d95fc3aa205e96c2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f266b4a382282d1e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/actions.js\":\"51bd5e2cd2d2a694\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/config.js\":\"89c5dbe23aa6b3c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/dataExtension.js\":\"6f02ad33189bdae9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/effect.js\":\"64b2104b994ea995\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/index.js\":\"79a90503143a8b0f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d09a012504edfe48\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/useToggleTree.js\":\"5ac5ff8b118db543\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/ExtractTypeDialog.js\":\"47c8519efc63b326\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"db1275c763988375\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/PropertyShapePicker.js\":\"fc54b755c5970e73\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/action.js\":\"df0d21bab329afde\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/index.js\":\"4bd124ac03c60200\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/FindReplaceDialog.js\":\"6796d7e3d8f1e8ad\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/HeaderItem.js\":\"d3c19cd157be0946\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/dataExtension.js\":\"d0538b12bbc55038\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/index.js\":\"cc6d3135f43ee3df\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/search.js\":\"ec99cdf56580e1a1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/toggleStore.js\":\"939d4b77bf4e8632\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/LocationPropertyEditor.js\":\"e23e9d2a6ab18df7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/MapView.js\":\"ab76af6c5ffb15fa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/blockTypes.js\":\"8b2357e4ee79d8f0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/codeMirrorExtensions.js\":\"73d858ecd94b7276\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/createOrFindPlace.js\":\"b1f97399830dc288\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/currentLocation.js\":\"d65c7d14d4514c8c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/dataExtension.js\":\"b18c208009982549\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/geoContentDecorator.js\":\"10eeadf1ff81e6fa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/googlePlacesClient.js\":\"b327bc36a57c9440\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/index.js\":\"4d8606f7ee44fccc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/locationsPage.js\":\"1230a827c7095b18\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/mapViewport.js\":\"f1d340315eccba5a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/pickCurrentLocation.js\":\"c9b51b5990bcf9c0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/placeAutocomplete.js\":\"ec1534c68c059c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/placeNameCollision.js\":\"b9040373dcc5c5dc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/properties.js\":\"6b25f851d92e9fe3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/propertyEditorOverrides.js\":\"874623f77af85b62\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/query.js\":\"75020166cd9be754\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/usePlaceSearch.js\":\"0970fed426cc0dc3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a7a8e31ccf8033e6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"dd9f680c5b4c9b21\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4f96ae09bb610aa1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/config.js\":\"8a86f7139db2b08f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/dataExtension.js\":\"b5256946a0b5a3cf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/facet.js\":\"fd9b8a1fe3f65cc3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/grouping.js\":\"1fb622ed2ade4413\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/index.js\":\"b8a82970c3b4f51c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"3d63304fd98a15b8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/query.js\":\"48d48385b055efd7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/resolveConfig.js\":\"ba609482d03d1e21\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"727051bfe2dfa6a3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"16ad5cef80b887e7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/HtmlDocumentContent.js\":\"9f268fa399aa8534\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/HtmlFrame.js\":\"eca5dcc018339dbe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/actions.js\":\"8e62e3df3c884ad8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/blockType.js\":\"644ed451e7dc9df4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/confirmRunScripts.js\":\"9354b2738ad922db\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/dataExtension.js\":\"9d48cb878f9671b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameAnnotations.js\":\"bec96f4088930535\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameDocument.js\":\"2967f10e57482f7a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameTheme.js\":\"9095d5bd98bf71c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/index.js\":\"1df102d481d38326\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/scriptConsent.js\":\"49b0b2da83eaa663\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/sourceMap.js\":\"04fb0220beb55804\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/useDocumentScripts.js\":\"528f975a5fc2c7b5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/index.js\":\"c0688e3fe909492a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/record.js\":\"51e45d738fbba6bd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/recordStore.js\":\"b7ae8b983b736d77\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/responsiveness.js\":\"bfe9e13b188b4069\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/schedule.js\":\"0f4974b6dbcefa3d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/sessionContext.js\":\"271aecfa3ad101c4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d148adebd0e953a2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ab09496f020e65f7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/actions.js\":\"d5356b3dc5395c79\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/config.js\":\"62ec221405f121ce\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/dataExtension.js\":\"d20ad1a037b9da37\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/effect.js\":\"1ebc3ce76f44503d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/index.js\":\"1eea4e71af04f893\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/keyCapture.js\":\"6eae871f60ed1bff\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/overrideStore.js\":\"de04d7f522d386b3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"2409eff1ebe3e315\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/HeaderItem.js\":\"494748053637a017\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/LeftSidebar.js\":\"218e591d8fe675d2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/actions.js\":\"2a7656f95b0913e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/facet.js\":\"9ea7202907ba91d8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/index.js\":\"5074dccb6122f648\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/shortcuts.js\":\"0dd2e87d3946c422\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/toggleStore.js\":\"ecb598e72c6ebaad\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/MergePicker.js\":\"240edc3c1cea00bc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/index.js\":\"72ece875bee1710c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/mergeAction.js\":\"a78bad158f3bf079\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/strategy.js\":\"314f93bab1aecf69\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/Button.js\":\"055141eb1eb5b194\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"911009f5bae2b01c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ae9db41e529ed806\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/facet.js\":\"4419dc0ed72e6322\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/index.js\":\"c83b931654ef36cd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e76e568f2060912d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e95724af327cdeba\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5e4c3e92ab41d6e4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/facet.js\":\"bed89eb0548357b0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/index.js\":\"b36fdd29f51b21b3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5c0251e29396b745\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a902066e11a213c1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/contextMenuItem.js\":\"207fb5a0ffe78c29\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/index.js\":\"1d29c876d280dc85\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/moveAction.js\":\"4b4f31ecec919736\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/moveBlocks.js\":\"894683dcb4d59441\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/selectionAfterMove.js\":\"f0d38c431f0c3157\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/TutorialBanner.js\":\"847a27417a960be3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/action.js\":\"33912b60692f0824\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/bannerDismissal.js\":\"1a892c2020b863cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/documents/cheatSheet.js\":\"a1cf4cc131dd45ed\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/index.js\":\"a65762b30837bb18\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/keys.js\":\"7e46904af66f1544\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/landing.js\":\"7ca21e052568da32\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/outline.js\":\"8e3034adb9fdad5b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/seed.js\":\"db5454e79326b79d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/PerfTrendDialog.js\":\"dbba0de5fedb1d81\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/analyze.js\":\"ed02a75ea7e3b044\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/diagnosticsSource.js\":\"6c2ab1c97307020c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/index.js\":\"f78dec46de8a3374\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/load.js\":\"408b9bbb3de27ed5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/monitorRun.js\":\"5e4c864db080879d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/schedule.js\":\"2735875a68398349\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/series.js\":\"27dfdbb309942a7f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/store.js\":\"9ba3990480bc92de\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/trendAction.js\":\"3dfa0b2c0ff0a48d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/verdict.js\":\"3457893d53532e76\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/clickToEditAction.js\":\"b4251f9547563685\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/index.js\":\"5d7c8b1b9cc8daf0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/interactions.js\":\"eeecc3f88abeed6c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f10517a5364e1d13\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/MigrationGate.js\":\"6365f0455b52e007\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/MigrationGateDialog.js\":\"686f5fa66b253b07\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/action.js\":\"78c408de96e4158a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/index.js\":\"403c52b047447ab9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/localRunMessage.js\":\"4d1f8358b677b323\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/plugin.js\":\"e4ea99e069167866\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/progressReport.js\":\"23b1cccdc8824807\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/sweepProgress.js\":\"89a932e183efcb95\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/FieldRowRenderer.js\":\"aab26eb2e31389f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/ValueRowRenderer.js\":\"1c98ad7352b58829\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/actions.js\":\"e2cf3ea89fcca83b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/autocomplete.js\":\"ba24c5d969dbda95\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/fieldRow.js\":\"bb66bb1dffd0c9a4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/index.js\":\"883fd51cc979486b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/referenceWarning.js\":\"11e981298986473a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/valueAutocomplete.js\":\"489d09212ca11006\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/valueSchema.js\":\"2740045e5f87dffd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/HeaderItem.js\":\"0217226209c27e18\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/QuickFind.js\":\"b420ae1da01d99aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/index.js\":\"9a9af9a3245aa589\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/recents.js\":\"7c45299759d3f9c5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/resultItems.js\":\"d1f453da5f6c9429\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/selection.js\":\"2b81d28d7e7b1494\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/toggleStore.js\":\"4bb0964d68724eaf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/HeaderItem.js\":\"61bc85979226a538\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6d0c4d08270728b3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/grouping.js\":\"b5843eda95bf82e9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/index.js\":\"dd490e3fea67c571\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/target.js\":\"a3c2d6664cb61c2c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/codeMirrorExtensions.js\":\"ed3467e4af15c5f4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/contentPrefill.js\":\"5e60b13af24a8fff\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/dataExtension.js\":\"da0e84ee82621183\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/index.js\":\"664fe0b5c4ff183c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"33618efd6c2347bc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/invalidation.js\":\"555987c89d5ecc2d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/localSchema.js\":\"d04eeb378da0fe7e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/blockrefs/index.js\":\"f5a65f74a8490c57\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"78a25720d6221bfa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/index.js\":\"8d64e72a07ded00f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/referenceNode.js\":\"e548da842f547a8e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/remark-reference-occurrences.js\":\"06bf6caf95a03302\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9b11d3b77e1f7ecd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/index.js\":\"f262d6055c994f44\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1366ac98ebbf82e1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c1f3e92e67e78b36\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/mergeRetargetProcessor.js\":\"32b0fd704d00a90e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/parseFence.js\":\"819b7f3db1ef70c2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referenceParser.js\":\"c647b231a6dcb6d4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referenceProjection.js\":\"93a3ca47a15466eb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referencesProcessor.js\":\"148ed32759ced7f7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/renameProcessor.js\":\"8f36f5f4bc94174c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/spanReplacement.js\":\"2d0a4454ecc084ea\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/htmlToOutline.js\":\"9b4c521b9d6f0324\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/index.js\":\"c0c86de72bb91020\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/normalizeClipboardDom.js\":\"775d78432018bd27\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/pasteDecision.js\":\"79d903a90839de19\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/action.js\":\"26cd16910059e100\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/blockIds.js\":\"ca9afa5197509169\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/content.js\":\"367fb6694fedd72e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/effect.js\":\"ff530f301df61d1f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/ids.js\":\"1fd2054abea3bac3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/import.js\":\"4cbfaf00e042d1fe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/index.js\":\"27a8077e4926a692\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/plan.js\":\"acc23c424ab3192f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/plugin.js\":\"dcf51774b789dc5f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/promotion.js\":\"fe8019d5ed20fc6e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/properties.js\":\"cefd2857fc0c86c3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/references.js\":\"b637165ee6a4bc1c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/report.js\":\"e9c53b94be464108\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/roamMemo.js\":\"4b4af15c75a8abfb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/runtime.js\":\"cfaf9aa388e9f84a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/schemaReconciliation.js\":\"e13aaad9304d6b75\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/srsMarkers.js\":\"e7167a062d39b479\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/todo.js\":\"965a75c5b1508b38\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/typeCandidates.js\":\"a17a7f37d82f2ba5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/types.js\":\"1121b2816edd3d37\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/search-health/index.js\":\"4a5aa71b3eef8feb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/search-health/store.js\":\"937564bf88d27bf0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/HeaderItem.js\":\"c3008a562615e50f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"1504e1770ba56b59\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/index.js\":\"47267ab10357092d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/model.js\":\"8fb2dd0ea095f75a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/toggleStore.js\":\"a8797d3aefc25018\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/useKeyInspector.js\":\"4e03034e501a6f81\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3612e9862475a0a6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/ShellDecorator.js\":\"7db7db90b065eea0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/actions.js\":\"d0a6f74423480052\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/exclusionsFacet.js\":\"05d6cc3b4b45ecbd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/index.js\":\"1f2a64c78bfb7cda\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/shell.js\":\"82299e2983485c0c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/surface.js\":\"5bb760860aff5e6d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/walker.js\":\"5b1d08e6c488e4ed\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/RescheduleToast.js\":\"77489ad5c421c1e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/dataExtension.js\":\"3a17d55cbaab167b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/index.js\":\"0f56145e8d09fe2d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/indicator.js\":\"e53dfa7263ccc453\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/moveSrsState.js\":\"906cd9ccead50572\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a9b34c73a6dcf906\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/scheduler.js\":\"9f56b82f8148b5d3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/schema.js\":\"627ebaffa0d758fe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e22510ffb288cd42\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/srsClipboard.js\":\"a95e3652d44d2690\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b38d3b09c887e81e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0da81aa2143a01a4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/DeckPicker.js\":\"908719b2993f5b88\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewControls.js\":\"ff6b1c9c23ecabb6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f35c2fd21297ab03\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewSession.js\":\"d0e823b5a102eac8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/actions.js\":\"bf9dfaaff824531e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/archive.js\":\"dbcb8ed5bdc206bd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/dataExtension.js\":\"7ae0ce779a187c47\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/deck.js\":\"ac0eb0797b4a25d8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/dueQuery.js\":\"bd14ebd36226b7cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/gradeDecision.js\":\"f243059fa98bade4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/index.js\":\"fe60263f7b71c1ad\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/keyHints.js\":\"a43c08b52ec6d5eb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/reviewCardLayout.js\":\"925d82cec852eeef\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/reviewProgress.js\":\"afa79eb8fd1127ca\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/schema.js\":\"1f847eca420a096b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/useDueCards.js\":\"6212c6257ba0cd6a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/startup-metrics/index.js\":\"9f37df235d2cfa20\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/startup-metrics/record.js\":\"7943d6df0da127a2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/index.js\":\"7a2bcadc23fd424d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/persistenceStatus.js\":\"dcc62831493e090a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/requestAction.js\":\"6fcc4208548cf411\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/TypeChipsDecorator.js\":\"0d61748dff3e2d55\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/codeMirrorExtensions.js\":\"024c3b6deb2cf7c9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/index.js\":\"8cfa8d6ecea734a2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/typeAutocomplete.js\":\"f464315d828d8128\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a3e8f58ca4f68293\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/actions.js\":\"ccbabbf0fddb4d1e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/anchor.js\":\"193d9440396e6e40\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/events.js\":\"71af475c7f9f6307\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/gestureActions.js\":\"0949109b7dd28740\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/index.js\":\"f4ea629c85ca6adb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"363680ab61158876\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/collect.js\":\"32619256f249daf5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/index.js\":\"c988da672a8f2b67\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/record.js\":\"b0a2a731934fe3f2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/RejectionDialog.js\":\"b40e76885ed050b5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/SystemStatusHeaderItem.js\":\"00a099534e0df3e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/index.js\":\"8605a8b3f9b67a25\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/model.js\":\"4a2f319e2b6cc7cd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/queueCounts.js\":\"f07f162a074c95b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/rejectedHelpers.js\":\"b1bcd949c95e99b9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/rematerializeAction.js\":\"cf6c3b49ce7423e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/useHysteresis.js\":\"1974fe299f2a590b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/TableLayout.js\":\"860698dd85a1d94e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/actions.js\":\"091e4fc78cbb5d44\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/cellEdits.js\":\"43c323d0345d895e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/controller.js\":\"b4bb076c4fc06922\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/convert.js\":\"3d5327eccd6ff1c7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/dataExtension.js\":\"66e70f29c4ad0019\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/index.js\":\"3a620b8403c58e2a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/keys.js\":\"0880371a88a05847\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/model.js\":\"be3b08efa962b58f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/registry.js\":\"43b662c1ab8a1c0a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/schema.js\":\"704e5650bbdb9cf3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/effect.js\":\"ce347d0f2aa361ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/index.js\":\"ca39d0faee32f5da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/theme.js\":\"0b772d8dc3d225d7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/actions.js\":\"95748b57023e1a18\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/dataExtension.js\":\"a811b5ac8fc18aa6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/index.js\":\"bdf6d7dbf7ded634\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/schema.js\":\"43c66a2b9fffe2ec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/TouchSelectionLayer.js\":\"6d84fbf4904be3f4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/actions.js\":\"d1e74ca848ae1f1a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/defaultItems.js\":\"7f5e0d5c506820f1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/facet.js\":\"f1cb21e8cb017f48\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/holdRecognizer.js\":\"b074d59f4c1cfdaf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/index.js\":\"f66ecd5ec6ef55aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/UpdateIndicator.js\":\"dacf27983aee0646\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/index.js\":\"a7d53a6504a9b817\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/loadTimes.js\":\"87198a307b03a489\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoNotesRenderer.js\":\"db7aec024cf2362c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoPlayerRenderer.js\":\"37fb0d0397bb2ec6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoTimeStamp.js\":\"98395a645209c908\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/actions.js\":\"cd56b5f86bba79c0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/index.js\":\"c600d81de67962b2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/markdown.js\":\"dad48f74038f7636\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/notes.js\":\"5bece61674a1106d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/registry.js\":\"77502b8a45b085a5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/remark-timestamps.js\":\"5f105e6cd63365f6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/view.js\":\"47daf7470ada7251\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/LinkHints.js\":\"bbdeba6aee7cb25d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/index.js\":\"f5f5c6b77b81f465\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/model.js\":\"d4b22abf889ad543\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/settings.js\":\"a6e62b32f337751f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/actions.js\":\"7829665f3e011b96\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/index.js\":\"dd73917b9e18fb1f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/interactions.js\":\"fd6d61693db5bc6d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/workspace-header/index.js\":\"22643c4860180513\",\"/knowledge-medium/pr-preview/pr-1813/src/registerServiceWorker.js\":\"bc69f50ed115efa9\",\"/knowledge-medium/pr-preview/pr-1813/src/requestPersistentStorage.js\":\"c9f559fbad22ab76\",\"/knowledge-medium/pr-preview/pr-1813/src/services/authRequestDeadline.js\":\"7fe73a3243c21921\",\"/knowledge-medium/pr-preview/pr-1813/src/services/authStorage.js\":\"e15db52430b09557\",\"/knowledge-medium/pr-preview/pr-1813/src/services/powersync.js\":\"61aaea07abc26939\",\"/knowledge-medium/pr-preview/pr-1813/src/services/supabase.js\":\"77273fa5b345b1be\",\"/knowledge-medium/pr-preview/pr-1813/src/services/uploadErrorClassifier.js\":\"d1d5773fd09d57cc\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/ActiveContexts.js\":\"8844d4bacefa19b2\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/HotkeyReconciler.js\":\"8150cf5eaddc1651\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/WipeLocalDataDialog.js\":\"0f52c8d986bd3bc8\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/actionDispatch.js\":\"3c80f32704c06cfe\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/actionRefItems.js\":\"a00f5fe95fee919a\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/applyKeybindingOverrides.js\":\"dfd15c0af98ad808\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/blockActions.js\":\"98cdcff99ed67c69\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/canonicalizeChord.js\":\"99c08b734bbb5f52\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/defaultContexts.js\":\"b1020950bfb5ee1d\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/defaultShortcuts.js\":\"03244b9a31f983b1\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/effectiveActions.js\":\"dce697cc2208ea79\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/gestureAction.js\":\"c21d490e10868519\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/gestureBinding.js\":\"51149fa6b5a7a2f4\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/holdRegistry.js\":\"200bdaa1a8ed8cf0\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/keybindingConflicts.js\":\"df7f8bd1de4b2c00\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/keybindingOverrides.js\":\"c232fc72f3ee2121\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/pointerAction.js\":\"32c2fee5a76d7d9b\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/resolve.js\":\"c74d21c3e4a5867f\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/runAction.js\":\"9e4fe933d8041741\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/sequenceMatcher.js\":\"bc5e930d111a3a42\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/types.js\":\"4e2934fedc690175\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/useActionContext.js\":\"900ae0a082ffc68c\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/useActionDiscovery.js\":\"24c992796d52dd8b\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/utils.js\":\"4d9e7cfdb2c8d5d0\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/bootStore.js\":\"3ea2779f85a91f5b\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/previewDatabases.js\":\"19e4c10527ea974a\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/byteTransform.js\":\"802a44fafa6cfe4e\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/attachmentCleaner.js\":\"f85847eacbe6f8c9\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/attachmentParts.js\":\"54f02a80c91f6ed1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/bundleParts.js\":\"26e96082f3c2ab40\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/bundleRecord.js\":\"cced5cdf8f4e00e9\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/manifest.js\":\"d4da7d08f35aa917\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/takeBundle.js\":\"b3eb0e382c562c5f\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/verifyBundle.js\":\"bdff22ca5da57ce3\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/cleaningStage.js\":\"df8388ebf3838dcb\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionKey.js\":\"411a8459e717bb84\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionServer.js\":\"d5a7f8bd5ee6c2d5\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/flip.js\":\"c39c549c71dbf71e\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/flipAttempts.js\":\"ec0be1b9ae8da78b\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/pages.js\":\"5ef6aa22ac800147\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/preflight.js\":\"f4a46fa067e979f3\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/reseal.js\":\"a83ada8f20cf345a\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/runConversion.js\":\"00738474b6855c32\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/runLock.js\":\"206b0a3c7425c215\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/sealing.js\":\"fdf2c26fb1926ed7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/sealingStage.js\":\"54ae7a3f3b862cf6\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/stage.js\":\"d05672cb5746ed87\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/verifyReseal.js\":\"79687b7d3b589244\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/aad.js\":\"534d2c05bdfcd879\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/aead.js\":\"bcc5efe45361ce30\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/base32.js\":\"87b9add4ccec8ac6\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/base64url.js\":\"c5b023c99a0433af\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/binaryEnvelope.js\":\"eb51ec6a4c43bcd1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/byteAead.js\":\"37604d1d826f91f9\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/canary.js\":\"d7599ffdda431803\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/contentHash.js\":\"296b14cb60f9ce64\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/contentKey.js\":\"d0d91894121a7878\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/derivedIdNamespace.js\":\"66c54145265e4b3c\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/envelope.js\":\"29880fe3b6a85206\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/hex.js\":\"12664999b904b3bd\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/sha256Hex.js\":\"739ab1dca5f2da91\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/workspaceKey.js\":\"a08f63d0185315dd\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/conversionState.js\":\"7790ce0a8a95660f\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/createEncryptedWorkspace.js\":\"82e6e0f868b70956\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/pastedKey.js\":\"0c33de20585c65f1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2e743cb368ef2538\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8de7074eb8aa7b62\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/keyStore.js\":\"d87d32770c988f1e\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/mintWorkspaceKey.js\":\"ff26d759faea51e1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/modePin.js\":\"2d007c742788b5c5\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/openWorkspaceKeys.js\":\"319dfee88ccb688e\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/resolveWorkspaceEntry.js\":\"6050a8db7b57b93b\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/resolver.js\":\"adc97bc73dbe18c7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/workspaceAccess.js\":\"110c4ee5131d9296\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/transform.js\":\"5a99d005839d0df7\",\"/knowledge-medium/pr-preview/pr-1813/src/themeBootDefaults.js\":\"239c058fa93d90f4\",\"/knowledge-medium/pr-preview/pr-1813/src/types.js\":\"14ce60c68babc45b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/ClientLocalSettings.js\":\"7f7a7be2db91eba5\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/abortableSleep.js\":\"c54a6696c4dad371\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/array.js\":\"b03191ca1a3ccdf5\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/backlinkAutocomplete.js\":\"c2530c72b78b114c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/blockCrumbs.js\":\"bec228fa47d8f56a\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/blockrefAutocomplete.js\":\"9d4b4a1dc8236fec\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/cadencedIdleJob.js\":\"d9ebbf16c90a473a\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/callbackSet.js\":\"deb65b2d4dc7ff36\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/clientId.js\":\"eecc82fdc124e9b2\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/codemirror.js\":\"d8268471114d1c12\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/codemirrorCompletion.js\":\"e286420ce261c61f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/copy.js\":\"ff31c1264672ea79\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dailyPage.js\":\"1dd51e92ae1eafc1\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dbForensics.js\":\"9558c03a09d281b9\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dbForensicsHooks.js\":\"c37acdb6cd5cf464\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/deleteBlockThroughUi.js\":\"aa39205427f58817\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dialogs.js\":\"e8353e1bcddf910f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dom.js\":\"18effb2bf4a57f03\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/downloadBlob.js\":\"9bc6595aae05b6f1\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/exportSqliteDb.js\":\"89e60341b11c8ca8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fileSystemAccess.js\":\"a52e9f074f9e6d65\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/flipSlide.js\":\"c86fc4628904942b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fnv1a.js\":\"904bf08e9de4d87d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/formatBytes.js\":\"131e7d50e4cab739\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fuzzyRank.js\":\"6dde0d65074663c6\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/idbKeyedStore.js\":\"f356f7aa2e009183\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/idleCallbackPolyfill.js\":\"4787b0a8abe4b811\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/keyboardAwareScroll.js\":\"c643c5619f9efd55\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/keyboardViewport.js\":\"1f3729289bc566ec\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/lastWorkspace.js\":\"5fafcdbcf1888e2d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutColumns.js\":\"198b1228487de9bd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutSessionDom.js\":\"c887fcdddefc78ca\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutSessionId.js\":\"08ee5002f0942cbb\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/linkClickGestures.js\":\"60e4cfd3c99f669d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/linkTargetAutocomplete.js\":\"6f28b347b21e0ecc\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/localDbCorruption.js\":\"63f62207e74c3c82\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/localDbRecovery.js\":\"14df7580a91f715e\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/markdownParser.js\":\"2af354667c82ceca\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/memoize.js\":\"83728f140f72ecb7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/nameFieldCommit.js\":\"e161737d8e37fa0e\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/nameList.js\":\"1a9c50bf2728add1\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/navigation.js\":\"593047f9f8500da8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/omnilinerNamespace.js\":\"795abab46ac2e8d3\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/opfsPageScan.js\":\"130f43f6842e82ac\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelClearance.js\":\"ad14661441e717c7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelHistory.js\":\"fed4dd192bc98a42\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelLanes.js\":\"3070b5037c65755b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelLayoutProjection.js\":\"3b624746724b5ae7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelScrollAnchor.js\":\"4b4e0580a8411468\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelUrlFlags.js\":\"54b202cfec9a8ac2\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/platform.js\":\"cb62b43eb0c11cd6\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/pluralize.js\":\"dfaa19c29255946d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyCreation.js\":\"263ecabea3bbf882\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyNavigation.js\":\"84a0e7047ff25044\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyValueContext.js\":\"cd9a404997172ece\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/react.js\":\"5b0a750a7bf3dd5a\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/relativeDate.js\":\"8de296963c8e260e\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/relativeTime.js\":\"d0e8037fd35a87d4\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/renderScope.js\":\"b7328e8f0889f3e6\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/resolvedThenable.js\":\"641f049d43a70b60\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/routing.js\":\"4d7ab7435f69c8ff\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/safeMode.js\":\"882cacff45607d1e\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/scheduleIdle.js\":\"6d1fc2a3d2b1ffd5\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/screenWakeLock.js\":\"9c25f865a0787db4\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/selection.js\":\"7846b525d0287699\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/softKeyboardGrab.js\":\"7e73a95fa1289510\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/startupTimeline.js\":\"f2f8c7e0729e2db3\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/state.js\":\"0d8fddf5f43320fd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/string.js\":\"6b3d886d78bc7ff7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/surfaceZoom.js\":\"a51ac9634f3170ee\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/time.js\":\"0d8c9c85e4f1d803\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/toast.js\":\"3fde347d767d142e\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/toggleStore.js\":\"e678be0dae83ec6b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/untilStopped.js\":\"a46cad2c70404565\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/userActivity.js\":\"ac467422d5908e29\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/viewTransition.js\":\"f79111c2c05762de\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/viewport.js\":\"44b51444ac116919\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/webLock.js\":\"7c5247180a47ab44\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/workspaceRecovery.js\":\"181ad0f90bc96c20\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/workspaceSnapshotStore.js\":\"34764f69f85e5886\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-compiler-runtime.js\":\"f4569ca724ae3f60\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-client.js\":\"6971bc87734acf66\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-server-edge.js\":\"dbfd58c660ec3488\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-server.js\":\"7f3de6c7889f93b3\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-static-edge.js\":\"06993416ad32dfbe\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-static.js\":\"87b1d00957a15dde\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-test-utils.js\":\"5013584c756b64b5\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom.js\":\"ce60d85112e64b45\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-jsx-runtime.js\":\"81b5066a20268f77\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react.js\":\"00f2faf47f41a509\",\"/knowledge-medium/pr-preview/pr-1813/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1813/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1813/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
