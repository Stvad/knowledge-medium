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
		buildId: "11e95447860d-5453a769",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/\":\"dd27b1744b54fb2a\",\"/knowledge-medium/pr-preview/pr-1813/index.html\":\"dd27b1744b54fb2a\",\"/knowledge-medium/pr-preview/pr-1813/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1813/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1813/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1813/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1813/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1813/assets/FacadeVFS-DqptKQz2.js\":\"95f46b73b3729c5b\",\"/knowledge-medium/pr-preview/pr-1813/assets/OPFSCoopSyncVFS-DWrQVRCh.js\":\"9542765b2928a13b\",\"/knowledge-medium/pr-preview/pr-1813/assets/OPFSWriteAheadVFS-qXL0SDci.js\":\"7d9d7719001b805f\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-DkRWO3f5.js\":\"335a715425f8ac93\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-async-BNyZx3c-.js\":\"0f8d529e1425e26e\",\"/knowledge-medium/pr-preview/pr-1813/assets/worker-CpWaJyYn.js\":\"75ed195dfd8be54b\",\"/knowledge-medium/pr-preview/pr-1813/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1813/chunks/app-C8zDBlNi.js\":\"250519d412b3859a\",\"/knowledge-medium/pr-preview/pr-1813/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1813/index.js\":\"a94e7022d32fbaeb\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1813/assets/AccessHandlePoolVFS-BmzakT7G.js\":\"2f4735be59f7e1b3\",\"/knowledge-medium/pr-preview/pr-1813/assets/IDBBatchAtomicVFS-IxpsWMkg.js\":\"b487e505c571d029\",\"/knowledge-medium/pr-preview/pr-1813/assets/MemoryVFS-CbEWh_qs.js\":\"96500bbc1012a33c\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-Dxll-p-p.js\":\"4f2fba122ab9c924\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-async-CPZnHa44.js\":\"9165a68bdbe1573b\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1813/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1813/chunks/AccessHandlePoolVFS-CU2k5AnU.js\":\"b89404a87a4a6c1b\",\"/knowledge-medium/pr-preview/pr-1813/chunks/FacadeVFS-BAbQqRFI.js\":\"3fd3c29ec8d643ca\",\"/knowledge-medium/pr-preview/pr-1813/chunks/IDBBatchAtomicVFS-DM1sOQIU.js\":\"25606563e3e760b6\",\"/knowledge-medium/pr-preview/pr-1813/chunks/MemoryVFS-BmLh8GjJ.js\":\"9ac59a77bb6a8e58\",\"/knowledge-medium/pr-preview/pr-1813/chunks/OPFSCoopSyncVFS-DGY1GGDI.js\":\"ef4d2cf585331838\",\"/knowledge-medium/pr-preview/pr-1813/chunks/OPFSWriteAheadVFS-BRc59T0G.js\":\"9ba367cefe7051bc\",\"/knowledge-medium/pr-preview/pr-1813/chunks/Preview-B4DQKk6u.js\":\"be7f7476399bba18\",\"/knowledge-medium/pr-preview/pr-1813/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1813/chunks/card-BDaeWb1n.js\":\"880a1d5cff0c2b05\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-CRv4ubpT.js\":\"36d81d0e0c5c9d1a\",\"/knowledge-medium/pr-preview/pr-1813/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1813/chunks/mc-wa-sqlite-BmNj0rcl.js\":\"e690251c11187835\",\"/knowledge-medium/pr-preview/pr-1813/chunks/mc-wa-sqlite-async-Dk7WNHJg.js\":\"427abd5c49fe3ee0\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-BGtdI_Hc.js\":\"df50abd809b0f545\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-BLs5dXtE.js\":\"49821f94fa8c24d7\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-C4QzrAlc.js\":\"d968d6ff7e365e82\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-CCyep2Fr.js\":\"953e5832c2fbc5e4\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-CRhJKFlK.js\":\"fa3f43bfcbe39a68\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-CgzqA3ew.js\":\"73b9a58cbf279297\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-D7ZihFuJ.js\":\"6af9549d214d993d\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-Dr0A8D-f.js\":\"7400dd41d60b2c5a\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server-legacy.browser.production-DPIbsw1A.js\":\"209d815160cf13da\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server.browser.production-CgW1aQCv.js\":\"da93b0deb5ebf973\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server.edge.production-DJ_XXX-i.js\":\"2a60e63379c0bf5c\",\"/knowledge-medium/pr-preview/pr-1813/chunks/server.browser-BmY06_bC.js\":\"9e3ac5699ed8afa2\",\"/knowledge-medium/pr-preview/pr-1813/chunks/textarea-CtxpQsIn.js\":\"1db21730c64f8298\",\"/knowledge-medium/pr-preview/pr-1813/chunks/ui-OBMqvwZS.js\":\"1559814e0aac3142\",\"/knowledge-medium/pr-preview/pr-1813/chunks/wa-sqlite-CUTh2Sb_.js\":\"24b71e151d88d5ac\",\"/knowledge-medium/pr-preview/pr-1813/chunks/wa-sqlite-async-CSMaBvuG.js\":\"01187ce2443d7ce6\",\"/knowledge-medium/pr-preview/pr-1813/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1813/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1813/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1813/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1813/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1813/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1813/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1813/src/App.js\":\"17e101fc8db92819\",\"/knowledge-medium/pr-preview/pr-1813/src/appUpdate.js\":\"336699b10b2e6f93\",\"/knowledge-medium/pr-preview/pr-1813/src/appVersion.js\":\"6e0abcbb8d76a75c\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/initialLayout.js\":\"7798ae271c452d8d\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/openWorkspaceData.js\":\"db55bec9ae8d4812\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/resolveWorkspace.js\":\"8477da7f9a4709c2\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/workspaceBootstrap.js\":\"bd1be33f2e1bbbc5\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockComponent.js\":\"d47aa0f899277768\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockCrumbs.js\":\"a916a9eab1d0be91\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockEditor.js\":\"f60f9ab16ba5914e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockLoadingPlaceholder.js\":\"f1e43d7b59238602\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockProperties.js\":\"28adb900f848bf7f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockSearchPicker.js\":\"ddcf46b0038a7485\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ConfirmBulkDeleteDialog.js\":\"b61b4f17cf3bf283\",\"/knowledge-medium/pr-preview/pr-1813/src/components/DividerHandle.js\":\"c7b7e3a043ffd703\",\"/knowledge-medium/pr-preview/pr-1813/src/components/DraftEditor.js\":\"9459f17b0f71a758\",\"/knowledge-medium/pr-preview/pr-1813/src/components/GutterPill.js\":\"6730dd5f0987e3b6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/Header.js\":\"dc334c6931ea8104\",\"/knowledge-medium/pr-preview/pr-1813/src/components/LazyBlockComponent.js\":\"2760f18e281aba8e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/Login.js\":\"04020b8ef1240049\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ZoomableSurface.js\":\"0f637df6ec908dff\",\"/knowledge-medium/pr-preview/pr-1813/src/components/editModeKeepalive.js\":\"bbd0bba4a3f0af06\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3a6e36a2962fab99\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"94f784733b72fa42\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/RefPropertyEditor.js\":\"89e232857f73f0d8\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/RefTargetTypePicker.js\":\"96a15611f738d548\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/SelectPropertyEditor.js\":\"7ec8abc1bb6a16d3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/TypesPropertyEditor.js\":\"6b3c57e571aa0904\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/defaults.js\":\"dde436dad651edd5\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/kernelValuePresets.js\":\"383a080cf35b776a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/selectablePresets.js\":\"c891b51bc3fd4f8c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/typesPropertyUi.js\":\"39b3372f1ae501f1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/AddPropertyForm.js\":\"e2a586ee789f0285\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/PropertyPicker.js\":\"7d0216f524e7d609\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/PropertyRow.js\":\"10ea5e6563ccf4b2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/Rows.js\":\"40d61cdc8b69a8ee\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/actions.js\":\"4425477709a7ca6a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/declarationOnly.js\":\"62a716b061a01f85\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/layout.js\":\"1abbe071b9cce4a0\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/model.js\":\"83978cf12e52ea9e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/shapeUi.js\":\"4899923c5ff91ef8\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/shapes.js\":\"352651f49c0150b3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/usePropertyEditingActivation.js\":\"eb3a42ff4f1eed17\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/visibility.js\":\"2a407b4a64932da2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanelSections.js\":\"742a693aeeff71ff\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockEmbed.js\":\"abb9db5c1dc624e7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockLink.js\":\"2f900b884045deb9\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockRef.js\":\"3a0c02fab5279561\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/ReferenceLink.js\":\"576aca6a7b4d2cb2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/cycleGuard.js\":\"69a82f2a786b5f38\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/cycleGuardContext.js\":\"6c3766f76b40ccfa\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/linkInteraction.js\":\"fd238dc0f1b77072\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/referenceLayout.js\":\"a3a3871390b096c4\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/useBlockRefAncestors.js\":\"0c50d86ff31a4a04\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockGutter.js\":\"f03f5daefa0eb716\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockInfoDialog.js\":\"b2725b97be8ad6c3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockTypeBlockRenderer.js\":\"9c55ad18be312d62\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BulletHoverCard.js\":\"b7ae096fd3d39c12\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/CodeMirrorContentRenderer.js\":\"3bce31aa2a2890c0\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"15b2506ff8df1c6e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/ColumnResizeHandles.js\":\"abdc0961ba0ea7ce\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"8bcfef31dd976a55\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/DefaultBlockRenderer.js\":\"8693cdc89b9b234c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/LayoutRenderer.js\":\"0df685d0005b1785\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/MarkdownContentRenderer.js\":\"50a27e25a253e7ac\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/MissingDataRenderer.js\":\"801c57218d308664\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/PanelRenderer.js\":\"595a4779d901a59c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6fa2e222a73ad76d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/TopLevelRenderer.js\":\"9222768e221edc1b\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/blockGutterMode.js\":\"5ddd5c4ee1f9ce82\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/blockTitleText.js\":\"ac162b980e509622\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/fieldCreationKeydown.js\":\"0adf3db1d9b0f3f5\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/layoutRootContext.js\":\"2a20f51d99409d8c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/typeChip/TypeChip.js\":\"0b0b91aedfd691f7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/typeChip/chipStyle.js\":\"3ec4a379d04a65f3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/anchored-floating.js\":\"2b530d263b4eeb01\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/button.js\":\"8ab6f1039b54fea2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/card.js\":\"f99e53a4808f6f69\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/checkbox.js\":\"3dde8d8c75c9493f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/collapsible.js\":\"5296d77a388076f2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/command.js\":\"62dce14a526816fe\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/context-menu.js\":\"5c6d2b12fdf06d91\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/dialog.js\":\"e91ce02acb0a1b8f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/dropdown-menu.js\":\"2094772dcc6587bb\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/floating-listbox.js\":\"1348277ad1c9e159\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/index.js\":\"216e12e94f24ba67\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/input.js\":\"0f49a23c2fd14f76\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/kbd.js\":\"3e950cba115c6a01\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/label.js\":\"464bf02222fc7c14\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/textarea.js\":\"1edf7107256716cf\",\"/knowledge-medium/pr-preview/pr-1813/src/components/useEditModeYieldKeepalive.js\":\"b01f0ea178d83d24\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/BootFallback.js\":\"f5578c1553c60370\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/FocusedRowLazyMount.js\":\"887816b69cbb2b6a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/LazyViewportMount.js\":\"b84b60a1b1b6e8bc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/LocalDbCorruptionFallback.js\":\"22dc3d02b30df6b9\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/error.js\":\"310f7764364cebdc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/lazyMountRegistry.js\":\"6c2f5b8aa6e6d360\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/suspense.js\":\"501744cfa4850955\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/CreateWorkspaceDialog.js\":\"5af347a3c75c4d28\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/PendingInvitations.js\":\"187df3223f64197b\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/SyncProgress.js\":\"8f54165c68f65e41\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/UnlockProgress.js\":\"0823fc08e2d4550e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceKeyGate.js\":\"e33dfaca3e50db59\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSettingsDialog.js\":\"e951587a203fc3ad\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSwitcher.js\":\"862ad8c385b10055\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSyncGate.js\":\"d76593f7dc4c2c3c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/ConversionFlow.js\":\"478424dec3d5ba35\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/ConversionFlowHost.js\":\"304e6cbf443ef0d2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/EncryptionSection.js\":\"cdab1c14b6cf68a1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/attachmentPrompts.js\":\"41cbf13830f2222c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/bundleFolderPrompts.js\":\"45e36ab7963bfdbd\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/conversionFlowDeps.js\":\"4618b07433d2d5a2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/conversionFlowStore.js\":\"e26d8eb45f3c7c95\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/flowUi.js\":\"aeedd83d4111b9a1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/useConversionRun.js\":\"b6a21e74c121a2bc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/keyUi.js\":\"191e9b423bac66a6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/useCloseOnKeyLoss.js\":\"9d75330a31fb5516\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/useCloseOnServerE2ee.js\":\"137c5285db14090d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/workspaceUnlocked.js\":\"0a69baec37e44bb8\",\"/knowledge-medium/pr-preview/pr-1813/src/context/backgroundSubtree.js\":\"a08c67b7286198f1\",\"/knowledge-medium/pr-preview/pr-1813/src/context/block.js\":\"aaee2d31f3b9eef0\",\"/knowledge-medium/pr-preview/pr-1813/src/context/layoutWsContext.js\":\"5150b23064243694\",\"/knowledge-medium/pr-preview/pr-1813/src/context/propertyDisplay.js\":\"04890197f4324fcd\",\"/knowledge-medium/pr-preview/pr-1813/src/context/repo.js\":\"d7d07e9a1bd1c54a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/aliasClaim.js\":\"44fc1bac18c18c7f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/aliasSeatNamespace.js\":\"ab9d2e793181f8f5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/blockData.js\":\"b5eaa876a03bffe1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/blockType.js\":\"6f9299126d703c0e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/changeScope.js\":\"49add189ff9ed08c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/codecs.js\":\"e0e1133ba637678e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/derivedData.js\":\"e2c68d1275eee8c9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/errors.js\":\"f1c3d7a5c01ccfde\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/events.js\":\"7482eedde584ce7f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/handle.js\":\"5386ab9370d8ecab\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/index.js\":\"01c8b1e8f8bcc9c1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/mutator.js\":\"681a706a850148a6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/processor.js\":\"3ae46b1f91f4c413\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/propertySchema.js\":\"c620a84d3ef81cb1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/query.js\":\"a9197bad1fb7f86c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/sameTxProcessor.js\":\"fc6adb2c2a1c2320\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/schema.js\":\"5386ab9370d8ecab\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/tx.js\":\"5386ab9370d8ecab\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/typedBlockQuery.js\":\"267b96cff61e50dc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/user.js\":\"8afd982a6e0fcde2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/valuePresetCore.js\":\"e3526ec692b6559b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/valuePresets.js\":\"dbe9d4522e6393a8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/attachmentCleanerIOVerb.js\":\"949698de35810acb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/block.js\":\"e0cf89e8099767ac\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockCache.js\":\"a1c8fd3dbfb7f3a3\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockId.js\":\"3b142254bfc7aac9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockLiveness.js\":\"eb3f0b87c9d92618\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockMerge.js\":\"478c88d909abf948\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockSchema.js\":\"5b186b3c25cfcd5f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockTypes.js\":\"df50a9d397f7e94b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/clientContext.js\":\"af612e67d191ad38\",\"/knowledge-medium/pr-preview/pr-1813/src/data/dbFileSiblings.js\":\"ced2ab072e6f9641\",\"/knowledge-medium/pr-preview/pr-1813/src/data/definitionSeeds.js\":\"954a7cefc8de5754\",\"/knowledge-medium/pr-preview/pr-1813/src/data/derivedIds.js\":\"7c893344bdb05eda\",\"/knowledge-medium/pr-preview/pr-1813/src/data/drawnSubtree.js\":\"a52da2143075ccf0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/facetBridge.js\":\"85362c233a17608e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/facets.js\":\"dba4f697f660a0c6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/globalState.js\":\"a30866e0f1fa765e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/aliasClaimRederiveProcessor.js\":\"6af236f9512705f7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/ancestorBatch.js\":\"0ab834e0a286083c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/blockTypeTypeifyProcessor.js\":\"67a2c6058d4615a7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/clientSchema.js\":\"0be1dc8cb9521a51\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/commitPipeline.js\":\"8b7be60e98acec5a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/devAssertions.js\":\"726f2f4d0e75104d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/firstSync.js\":\"0e066a72faa20cf9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/freshInitialLoad.js\":\"c8b1722a2e3dfbb4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/graphBackfillClaim.js\":\"f0153c0bd8cacf55\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/handleStore.js\":\"3942b6fab251917e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/idleMarkerJobs.js\":\"1192f0fbce4dd2cb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/initialDownload.js\":\"4c497fc7b353b2f8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/initializeClientDatabase.js\":\"9e505319c8947139\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/jsonCanonical.js\":\"2377cbdfb6c0e061\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelInvalidation.js\":\"6a8c9db487a2cd0d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelProcessors.js\":\"42391e3a9647ad7e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelQueries.js\":\"77319b0188886a82\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/mergeTypeMembershipProcessor.js\":\"e63dd84fc151bc29\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/normalizeReferencesProcessor.js\":\"9565cf668759fe01\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/poolInstrumentation.js\":\"453a90a74af3ddf6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/processorRunner.js\":\"8d955e381b0b1a16\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyCellBackfill.js\":\"82d66c06bd11567f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyChildMint.js\":\"2da5b9e95575c87d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyChildrenProcessor.js\":\"21ce028ed3066a94\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyDefinitionChangeProcessor.js\":\"77cf7c645f20be42\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyDefinitionSynthesis.js\":\"826452428cd69884\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyKeyScan.js\":\"8bd1d16e0172f536\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertySchemaResolution.js\":\"8c3bf97d0e7792db\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyValueEdits.js\":\"5d3ac6e3be871f73\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/raiseProtocol.js\":\"5faea67bb1d2da4e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/readBatch.js\":\"7c6d6a786eb3da7b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/refProjection.js\":\"dc9853f20e5a8f22\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/referenceTargetLookups.js\":\"666e8c1e8cbfe1e5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/referenceTargetProcessor.js\":\"4dbdb88649547be2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/replayMerge.js\":\"2da355a68050ea4b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/sqlBinds.js\":\"518d8473670e3b09\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"285e66a3f0c30936\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/arrivalProcessors.js\":\"8190ffc2032fcd5e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/invalidate.js\":\"7ca1344e0d499791\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/materialize.js\":\"4d10b549560a61a2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/observer.js\":\"fc16f848d676c490\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/reconcile.js\":\"ca363db04ab24e66\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/timingMetrics.js\":\"e1d2c67fe66c5fa6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/treeQueries.js\":\"be540a790769a0cb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/txEngine.js\":\"99eeb891d99f5830\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/txSnapshots.js\":\"f9a5ce3f93919873\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/typedBlockQuery.js\":\"cbcaf0177eed64e6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/undoManager.js\":\"737d8dec6bdc3d69\",\"/knowledge-medium/pr-preview/pr-1813/src/data/invalidation.js\":\"46d6054adaeb58c5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelDataExtension.js\":\"968f64614347364f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelPage.js\":\"585aa900f5a55fe4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelValuePresetCores.js\":\"f25dbf58febf80bb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbCorruptionSignal.js\":\"2d53d083199cda2c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbStorage.js\":\"dacd1debd50efc79\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbVfs.js\":\"e686ab1c3f85bbcc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localSchema.js\":\"fbc593bb360446b8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/maintenance.js\":\"974adc9b51acc711\",\"/knowledge-medium/pr-preview/pr-1813/src/data/mergeProperties.js\":\"890662b5ba74576b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/metricsConsoleHook.js\":\"9a6f1d7b927ee31d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/migrationsPage.js\":\"c392bc6d510d295a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/mutators.js\":\"7efbd9c68c92dfba\",\"/knowledge-medium/pr-preview/pr-1813/src/data/orderKey.js\":\"24ecf2a5e63e575b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/orderKeyPlacement.js\":\"7e9410a8f58bc5e9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/outlineSurface.js\":\"7853f269de82086f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pendingEditorContent.js\":\"5f15f27e837feab2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pendingUploadsSql.js\":\"4c3540b3c1f35a14\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pluginStateExtensions.js\":\"b2c82f7821c74246\",\"/knowledge-medium/pr-preview/pr-1813/src/data/powerSyncLogger.js\":\"823265b35d378610\",\"/knowledge-medium/pr-preview/pr-1813/src/data/projectorRuntime.js\":\"89e4eb5663bc8718\",\"/knowledge-medium/pr-preview/pr-1813/src/data/properties.js\":\"45fff4439b6d69ca\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertiesPage.js\":\"899f38a09b048750\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyChildren.js\":\"6efec1532d9b1e11\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionFanout.js\":\"d28a5be4992125e4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionMetadata.js\":\"de2a410195204919\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionRegistry.js\":\"bd851bbf7b71f25a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDisplayMode.js\":\"7747e6be6ccaf65d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyRowCreation.js\":\"cd141044a573f8af\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertySchemaCreation.js\":\"36a7cadd8bef3821\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertySeeds.js\":\"e1d6d49fce771ce6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/recentsPage.js\":\"09f22ff008ab6209\",\"/knowledge-medium/pr-preview/pr-1813/src/data/referenceBlock.js\":\"0f23c12971bcea39\",\"/knowledge-medium/pr-preview/pr-1813/src/data/rejectedUploads.js\":\"6503564b096b0114\",\"/knowledge-medium/pr-preview/pr-1813/src/data/releasePowerSyncConnection.js\":\"a373dc6fc238dc9c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/repo.js\":\"c5820e8ef7c8ed4f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/repoProvider.js\":\"aafc3ce44fffe2cf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/rowProperty.js\":\"b07473f62b1c4c40\",\"/knowledge-medium/pr-preview/pr-1813/src/data/searchFilter.js\":\"620d29f6267059fe\",\"/knowledge-medium/pr-preview/pr-1813/src/data/seedIdentityLedger.js\":\"31ee27f60444fd29\",\"/knowledge-medium/pr-preview/pr-1813/src/data/stateBlocks.js\":\"f78f0ce8ce7b78dc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/structuralEditPolicy.js\":\"67b2ce24224bc826\",\"/knowledge-medium/pr-preview/pr-1813/src/data/subtreeDelete.js\":\"531acdcf020a4831\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncStreamLock.js\":\"f6b15f9f1a3474fa\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncedTableSqlRecognizer.js\":\"8c3d797291809e1e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncedTableWriteGuard.js\":\"5b5ce6008ed590dc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/targets.js\":\"4e747b6d8b18d97b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeColors.js\":\"6585214c618e96d5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeDefinitionMetadata.js\":\"2cfa815b667392e2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeDefinitionRegistry.js\":\"11f20f3454ca33d4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeExtraction.js\":\"1042db8e8e37bc1e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeInitialValues.js\":\"451ff3f3f94d7a8a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typePropertyGroups.js\":\"85408756c2adf8ca\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeSeeds.js\":\"6afa6b485aaf6d4d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeTagger.js\":\"36313c72355e7112\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typedRecords.js\":\"790457422fe35d02\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typesPage.js\":\"303c5c1adaea55cb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userPrefs.js\":\"612949dc10c26175\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userSchemasService.js\":\"a93f4c14d8cf9952\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userTypesService.js\":\"8a4c64e70b8e8d57\",\"/knowledge-medium/pr-preview/pr-1813/src/data/valuePresetRegistry.js\":\"992cb94417d1a8b2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/visibleChildren.js\":\"46bcc0a4f80551a4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceConversion.js\":\"5af5d321e12163d6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceFirstSync.js\":\"1e10a80eb8288495\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceIdNamespace.js\":\"3f7a861b495eeeb9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceSchema.js\":\"25eddf265e470061\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaces.js\":\"a42fb1134355f588\",\"/knowledge-medium/pr-preview/pr-1813/src/data/writeAheadLog.js\":\"8c1f8cdeb4517ae2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/BlockPasteShellDecorator.js\":\"d49b76e2372925f1\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/atTrigger.js\":\"6fb88759229ae0e3\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/autocomplete.js\":\"9948227057eca4b1\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/codeMirrorExtensions.js\":\"c57c865c18ab6f23\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/contentFlush.js\":\"63567322486fcd33\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/defaultInteractions.js\":\"ef9851b9c5ff817c\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/editSettleSignal.js\":\"0f97c19578682392\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/insertImage.js\":\"b36cd41bcebf9312\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/referenceCompletionRange.js\":\"e4cc4ebb66a42695\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/referenceTargetTypes.js\":\"6f8541af8a4d0f29\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/syntaxContext.js\":\"f571457b414ee9a0\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/triggerMatch.js\":\"c283be5b3a856ea9\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/AppRuntimeProvider.js\":\"696d0741af755615\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/BlockFocusShellDecorator.js\":\"e998c5bc1746b605\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/ExtensionRenderBoundary.js\":\"c0c995ca9b794a83\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/PanelContentRecovery.js\":\"ab6bc7a8cda1c7b7\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/apiCatalog.js\":\"565b8a7720c81303\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/approveExtensionHere.js\":\"cd977813b4123f77\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/armedCutAppMount.js\":\"d93feeb611c759ad\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/batchableKeyedStore.js\":\"016fbfdb23d35798\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/blockInteraction.js\":\"3309ae445381042a\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/blockSelectionAction.js\":\"62be7c51e01660a0\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/compileExtensionModule.js\":\"98f55b60fffae19a\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/compiledModuleCache.js\":\"6ebb1f1c35b552b2\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/continuousGestures.js\":\"a73af7fc2b0adf1c\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/core.js\":\"bc7bb5e5e3ca8d6c\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/defaultRenderers.js\":\"4a3f99acfc800bd5\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/definitionFanoutAppMount.js\":\"1e75b1d053ec3e3a\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dialogAppMount.js\":\"c3deb7607df8a812\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dynamicExtensionSeeds.js\":\"4bada7db7258c8d3\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dynamicExtensions.js\":\"57ef91573ce4b398\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/exampleExtensions.js\":\"7df447237eaa3920\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionApprovalStatus.js\":\"d7d2c0253d3ad6e4\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLoadErrorToast.js\":\"57f0530aa3f42995\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLoadErrors.js\":\"37c14ecd2007e1f8\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLookup.js\":\"a0f6c06084ad53b7\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionToggles.js\":\"e369122e320f281a\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionUtilitiesCss.js\":\"b5370f2187c68aac\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/kernelPageDeletionGuard.js\":\"a0d9426005f99691\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/liveRuntime.js\":\"84a3b3e30ea2ddf7\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/openExtensionsSettings.js\":\"d788f370e6e8ccbe\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/overridesCache.js\":\"af0ba4d69feaa0f8\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/pluginIds.js\":\"36e11e4451bfae79\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/processorRejectionToast.js\":\"0f13dbe34883a8ea\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/runtimeActions.js\":\"3ecd8b9ec651cc43\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/runtimeContext.js\":\"0457d9777ceb74a5\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/staticAppExtensions.js\":\"f8cbdc85494e8d4f\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/staticDataExtensions.js\":\"714a8ea57760109c\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/toastAppMount.js\":\"023372368053262a\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/useOverrides.js\":\"5d00ca12a51861e0\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/useShortcutSurfaceActivations.js\":\"22e2285266b52e76\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/discoverToggleTree.js\":\"59d5d236c1ae3b16\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/facet.js\":\"0dff491d18f57edc\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/resolveAppRuntime.js\":\"8656de90a46c8662\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/runtimeEvents.js\":\"c762c6fc7ba14437\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/togglable.js\":\"ef1ec194a3debdac\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/variantFacet.js\":\"f5da86b4a6c410c0\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/verbFacet.js\":\"4c80ea6c39b1965d\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/block.js\":\"dc41854a079bf378\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/focusedChild.js\":\"aa94f261356607b8\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/propertySchemas.js\":\"1cd878fbd830a22e\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/typeRegistry.js\":\"44acba96f9a44260\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useAncestorCrumbs.js\":\"2d8da3ed7f2dd377\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useAutocompleteListbox.js\":\"2db595ade2e0d0c9\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useDebouncedSearch.js\":\"4b97acffbf0c6df8\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useDebouncedValue.js\":\"ceceabf50da8634c\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useIsFocalRender.js\":\"7efee0a800ee8a16\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useIsReadOnly.js\":\"af5df4cde0bed86f\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useMaterializeBacklog.js\":\"628eee8336a31e92\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useMinuteClock.js\":\"a4862c964bac81fe\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/usePanelLayoutProjection.js\":\"712fa564255db1c3\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/usePendingInvitations.js\":\"1569e9ad37bec868\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useRendererRegistry.js\":\"17173bbe3f5437e5\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useRetainedFieldRows.js\":\"753bc43cd25aa8a5\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useWorkspaces.js\":\"b43b1a00e88ab3ee\",\"/knowledge-medium/pr-preview/pr-1813/src/lib/utils.js\":\"95558da77b0b333f\",\"/knowledge-medium/pr-preview/pr-1813/src/main.js\":\"0d4315296d842063\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/MarkdownImage.js\":\"6764a7a191c49811\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/blockSeparators.js\":\"4649b003de45bf44\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/context.js\":\"a468a33432aaca75\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/defaultMarkdownExtension.js\":\"760d38e6ca1aa557\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/extensions.js\":\"41e2de03ca2eff29\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/renderMarkdownHtml.js\":\"7ac6d15f7598a243\",\"/knowledge-medium/pr-preview/pr-1813/src/minimal-editor.js\":\"32ffcf4f1cde0d0b\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/armedCut.js\":\"2f05b78bca587720\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/captureMediaVerb.js\":\"e29a67485a9f8ac4\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/clipboard.js\":\"dba15e66733f5d96\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/decision.js\":\"b2a46bfb75be62f7\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/operations.js\":\"a68c0ef9abffe27f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/account-header/AccountHeaderItem.js\":\"112cdad17d2b2f4e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/account-header/index.js\":\"a919ec9cfba98767\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7514f3c796572345\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/askAgent.js\":\"154e34e0e0219733\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/askedStore.js\":\"c786d12378615e6b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2d4b79efa6ee4a6f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/chipState.js\":\"40516bddf2e61cb7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e2c1c4be536a7a34\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/index.js\":\"f36d27d311fed175\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e4338716a883c7d6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/schema.js\":\"5b4564d476ec2ddf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/AgentTokensDialog.js\":\"296f5855690195f6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d4a853d33582af63\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/addMedia.js\":\"1c94d3b4db57de01\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/backlinks.js\":\"888eb0eb997760c4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/block.js\":\"90b00a1595b80675\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/context.js\":\"587274d989e2db45\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f31d1afcbe3d5e6e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/index.js\":\"121938d93ebff984\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/outline.js\":\"625b4fb3031df911\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/properties.js\":\"8d65eb6af97c1c8a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/refs.js\":\"2fe9c4141249f79d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8a104241d25ff769\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/search.js\":\"ba64162747f3595c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/shared.js\":\"1df492668898f81d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8e1d931785bff3d7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/text.js\":\"6b99793a2f02dee7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentWrites.js\":\"68b8112ef765c5aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/authoringCatalog.js\":\"dc0d368029327797\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/blockRefTargets.js\":\"a040cf4a40560e8a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/bridge.js\":\"a66e956f5a9ebae7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/bridgeLoop.js\":\"52960e57264626fa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/changeHistory.js\":\"23741d5893ac5659\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/commands.js\":\"4082c54c6d8a9024\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/commentsCommands.js\":\"045d0fde95c00ab1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/dataExtension.js\":\"1ab3a4ed0ba697b3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/dataModelGuide.js\":\"992bdd56362f9126\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/describeRuntime.js\":\"825ef0b51d928b53\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/extensionLint.js\":\"2a54199aafce00c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/grainAudit.js\":\"d0db41340d7ffd95\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/healthCommand.js\":\"fa846f7e4c0569e5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/index.js\":\"cacb68fb8ddeb2fd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/presetIdentity.js\":\"a4832058e4153409\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4833c98f035a9034\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/readMedia.js\":\"7562bb018212c0c4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/schema.js\":\"62e7725ba1944c6b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/serialization.js\":\"c15f78428ad19235\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/targets.js\":\"afecd65979ea465c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/tokens.js\":\"e09bcbda546fdeab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/watchEvents.js\":\"5707e3fa96f428ed\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/workspaceGuard.js\":\"9efd01677dadf352\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/writeCommands.js\":\"4b4a62e251be7717\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/AliasCollisionToast.js\":\"c7e4611683391b97\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/DuplicateNameBanner.js\":\"3b53218a90c89b91\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/collisionMerge.js\":\"e07c78f3d7dc42f8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/dataExtension.js\":\"ef0713fc66d5ad14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/index.js\":\"26262dda73d04c6a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/mergeCollisionAction.js\":\"95552eb11570de33\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/pageStyling.js\":\"80f9e5717096b5d0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/rejectionToast.js\":\"64773cb0f3ac4e73\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/syncProcessor.js\":\"63a05c8dd3c0bd02\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/actions.js\":\"2fb144fd13658083\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/addComment.js\":\"ba318d72b6272d6c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/anchor.js\":\"920e490ffcd1506f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/anchorState.js\":\"c7c79d03623680ff\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/commentLinks.js\":\"0629b701e85e943d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/confirmThreadDeletion.js\":\"eae9d3240501cdfb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/container.js\":\"fbc9f4f0e42d8b0d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/dataExtension.js\":\"23e974ef293d671d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/deleteComment.js\":\"4748f7c801c7c5bf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/highlights.js\":\"ea0f2dc70b35248c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/index.js\":\"6dbbbea32229c185\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/linkedCommentsPill.js\":\"0abcf3ae5adcae41\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/margin.js\":\"c395efe68ce9e6d3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/marginSchema.js\":\"d620a411ad42a62a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/newComment.js\":\"eadbdef3ba5d61b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/ownThreadPicker.js\":\"df00809e68dc98c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/placement.js\":\"c9d8d360f34e6caf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/queries.js\":\"4251711339067834\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotePosition.js\":\"87040ecddeff8204\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotedIn.js\":\"51d5b8a936033d2f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotedRange.js\":\"ec648cc518494831\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/rangeRefs.js\":\"810709bcf06e9329\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readHighlights.js\":\"a8656bd74e40431f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readSelection.js\":\"638d2053dc79f096\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readSelectionUi.js\":\"34be68c5b5526d22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/reanchor.js\":\"faf711d63204444d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/schema.js\":\"bdca9f8ea897c72f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/scope.js\":\"786a8748169baac3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/scopeThreads.js\":\"7ac4f55e20e0f243\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/splitRetarget.js\":\"40570069fb720954\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/suggestionCard.js\":\"7ecd46ff13ce5301\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/suggestions.js\":\"510dc5cda24ea2ac\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/summaries.js\":\"2ab5af37a21dd501\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/summaryBatch.js\":\"92881d7b38073a63\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/surface.js\":\"c630ab08248ff60e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/threadNavigation.js\":\"95eef24fecea241c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/threads.js\":\"2b54299861973ead\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/ui.js\":\"6455fefd288a34dc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/uiStore.js\":\"fa3458abc78ff9c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-intents/appIntents.js\":\"24b0c0601190b531\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-intents/index.js\":\"a6377857b0fb5f12\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-update-prompt/index.js\":\"41df4e8d98f82eaa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-update-prompt/status.js\":\"63ad619c8bc81627\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"84f7c4f49bea362b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaBlockRenderer.js\":\"705fecb684f847a8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaDownLaneReplicator.js\":\"89ec5daf073e2d30\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaUploadReconciler.js\":\"1c125e976700c974\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetDownLane.js\":\"7d4a8186a1b24dc1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetResolver.js\":\"4e411dd2f2103754\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetUpload.js\":\"7ece382d0ebc6adf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/attachmentCleanerIO.js\":\"db194006d2bb6985\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c313dfc07b495374\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/blobStore.js\":\"4fcedf2464fee181\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/byteStore.js\":\"ebd42b761d0c751b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/cleanerIO.js\":\"4ed2366df8a1030d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/cleanupAttachments.js\":\"81b3508a5ae0f0f0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/dataExtension.js\":\"f162ec63742e157b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/downLane.js\":\"17b9e8697f97846e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/index.js\":\"2326491ddd1f3705\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/insertImageContribution.js\":\"ad10ac912e61ca90\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/laneArming.js\":\"e8be324482185c08\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/laneLock.js\":\"606d727cb401caed\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaBlock.js\":\"f3dd8c7c70cf89d8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaCapture.js\":\"2d93994d5abb289b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaViewers.js\":\"ddfde28b2ebe6016\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaViewersFacet.js\":\"e3c55e12270aed3c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/pasteCapture.js\":\"1c0e334f637dfc95\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/resolver.js\":\"50e37533ebcd3a4d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/retryUploadsAction.js\":\"e2c1c04f9810ad79\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/storagePaths.js\":\"235753b50f4fa03d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadDrain.js\":\"ee8dcf8dae422190\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadLaneStatus.js\":\"c0cd6143aeffc2da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadReconcile.js\":\"df30f94acfb946dc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadRecovery.js\":\"11064840d6ed03a2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadStore.js\":\"d6935c46da503635\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/useAssetObjectUrl.js\":\"22c017ce1254b1af\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"22252ed1faa0d9c2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/BacklinksViewSection.js\":\"19473149f35b9645\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/facet.js\":\"5e9017f483222142\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/index.js\":\"e483c7af6de3678b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/prop.js\":\"d51e45dde689a5e2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BacklinkFilters.js\":\"8239ab9528e79314\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"92689224ec211ba6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BlockEntry.js\":\"2620134fd4b8d738\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/LinkedReferences.js\":\"f8e055d6d7c5a297\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7854f9963487192b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/dailyNoteDefaults.js\":\"aca51dbdf50c79b4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/dataExtension.js\":\"14de17be40841c79\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/edgeExclusions.js\":\"a2694409a1702125\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/filterProperty.js\":\"dba7caf4620dafb1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/index.js\":\"bd0411d4ed09a443\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e0a5871bc880e498\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/applies.js\":\"4749ab34b6570f2c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/countQuery.js\":\"407996c2d6e5522c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c4765aefea45230a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/index.js\":\"767c34cdb4c568e2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"eafc902338761bf1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/presentationInvalidation.js\":\"89b1ffd42d37ccf3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/propertyEditorOverride.js\":\"329e0d6c31ee262e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/propertyFilter.js\":\"192b1719425e797a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/query.js\":\"e9fea8375e7500a3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/resolveFilter.js\":\"cf995d8cb40eb9e6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/sourceBatch.js\":\"8c4835dc2de0c2f1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/sources.js\":\"654e729c8eaf4b9e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/useBacklinks.js\":\"af87be4f0cdb173e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"eb15caa6f972d3eb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/BirthdayCelebration.js\":\"527df1d4523de90e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/BirthdayOverlay.js\":\"86bd2c52c6e497b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/gate.js\":\"859dbc264febdd09\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/index.js\":\"1c1048bb92d133e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/wolfTheme.js\":\"1e7638c229b1840e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/BlockDragLayer.js\":\"a082401de4b2a739\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/dragController.js\":\"0c2f8a4d3ed17b67\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/dropTarget.js\":\"c5a1b61774b51f5d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/index.js\":\"226c415b83c838c7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/projection.js\":\"0488a897d90ceb40\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-info/BlockMetaCard.js\":\"eaa930e523002f0c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-info/index.js\":\"61640902d0fb7e5d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/AddTagDialog.js\":\"c0e0a44a255f97d0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1307046d8749df47\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/TagNameIssueHint.js\":\"c04ce6a613f6fc2b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/addTagAction.js\":\"8289c174836e0455\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/appendTag.js\":\"4c1ebdd5c0a44053\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/config.js\":\"c4b3cc02b7653110\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/dataExtension.js\":\"66f5133eadeb306a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/index.js\":\"e6178bae4ac59dba\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/propertyEditorOverride.js\":\"30061a9a48db9986\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/BreadcrumbList.js\":\"da4cc4c39d48da00\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"dae1552ae1d6055b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6b482da69f27aea2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8a52c81441efda1c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1d6c847b14c2d4f6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/index.js\":\"cbe49e42a573aee4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1619fbb19903a640\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/CharacterCountItem.js\":\"b869127a8a74e9ea\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b6427fdb92b18366\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/actions.js\":\"b181d1ed3669220b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/blockType.js\":\"43ab98299e6da131\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/charCount.js\":\"b891270394cc504f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/dataExtension.js\":\"2aed054c57066e63\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/index.js\":\"813b1336dca88344\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/profiles.js\":\"71edaac70744f8f5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/properties.js\":\"2a4211b5c84a889a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/textCounts.js\":\"21fc344a1611a7d6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/colemak-keybindings/index.js\":\"8390fb3052b5026f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/CommandPalette.js\":\"508ab6f63354fc2e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/HeaderItem.js\":\"c85bb30a7a6b1b4b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/context.js\":\"0c0d6afc90abf441\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/index.js\":\"c8140d57504fcc12\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/selection.js\":\"da6c683b61228838\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/toggleStore.js\":\"9ac89f0f80507c2f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/useCommandPaletteActions.js\":\"ed6a363d62c38232\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/ContributorBadges.js\":\"9bd8a3a5c2bbff94\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/author.js\":\"8753afc4df8ad765\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/codeMirrorExtensions.js\":\"e967e1c94420559d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/dataExtension.js\":\"550556256547a87d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/index.js\":\"84dec97a4d45ad43\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/mentionAutocomplete.js\":\"5e8e95dd06f9a011\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/processor.js\":\"3e3ed2e93bd9705d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/profiles.js\":\"fed4caa7fe6306d2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/queries.js\":\"aac6ff8144a1230e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/schema.js\":\"11ad30d5aad4acfd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"de6eeb192f30c3db\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7eddc0e6f5283a7d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/index.js\":\"269c1c7c77d4ba75\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3e75505d3168f64a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"db3116b612f96ff1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/CalendarGrid.js\":\"093ec9c25c04c584\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DailyNotePicker.js\":\"4fd0ee8d2c9bde04\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a2387bbb388d4541\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateNavDecorator.js\":\"dc03af1fe5c2ef4a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateScrubOverlay.js\":\"4fe95209de1ac1c5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/HeaderItem.js\":\"30433454520ce8b9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/ReschedulePicker.js\":\"517e2663962f06e6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9fe466e2f87906b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/actions.js\":\"6f1bfaa067f37e25\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/blockDateAdapter.js\":\"5e5d36acb3632b5c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/calendar.js\":\"fb703ac95873ae8c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dailyNotes.js\":\"b6328405b47fe42c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dataExtension.js\":\"3bcc18ebad2fda44\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubActions.js\":\"a56e9b56beb1471f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubGesture.js\":\"67f038bbbf7429f1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubGestureActions.js\":\"279bce64abc1b37f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubRecognizer.js\":\"17a468b97f3aa8ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/deletionGuard.js\":\"c13f05162b7c75f6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dueQuery.js\":\"ee6ad872ccbf9687\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/index.js\":\"86f579b3123cb8b5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/landing.js\":\"117253b662f91584\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/localSchema.js\":\"f531900c65d8b94c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/referenceDateAdapter.js\":\"85863cc237474a92\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/rescheduleAction.js\":\"96933cc641d7862e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/schema.js\":\"3b063968d78db0aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/spreadBlockDates.js\":\"7b1b5d9578e34de6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/spreadDatesAction.js\":\"2ba9e20c098d2f27\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/today.js\":\"4b0411552e5cc4cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"10f744bb4b668895\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a0cb8a72f7a13f16\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/audit.js\":\"d025d4053565e2b4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/auditAction.js\":\"64d2da91b9090788\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/auditRanges.js\":\"1468426c9edba308\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/diagnosticsSource.js\":\"f4ad70f5568d2cc6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/divergenceScan.js\":\"0e3354f54d757b91\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/index.js\":\"f3ce269a18544605\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/propertyChildrenChecks.js\":\"1e65552ec92b4356\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/referencesMirror.js\":\"474864de472d71d2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/rowJson.js\":\"a82b8ea1c9ff14c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/schedule.js\":\"e8f2ff75b9d919f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/store.js\":\"baed29b45b0cf885\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/action.js\":\"5970d1b790cbb92c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/index.js\":\"3fae38450e5e6d7f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/plugin.js\":\"0cb47bdc1c2b1abd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6a26de8c0ce7d151\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/actions.js\":\"ab23231affcb7275\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/changeMarker.js\":\"1bcd117a1d3ab353\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/diagnostics.js\":\"5b75f9e6305268db\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/fileSystemAccess.js\":\"04b6127c7729ddc4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/filenames.js\":\"1cd12dde21a44969\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/index.js\":\"53828ece06e464a5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/mirror.js\":\"db6168768146a512\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/runLock.js\":\"b0aa0febc60fc2e4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/runtimeHealth.js\":\"263e3babeadd5089\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/schedule.js\":\"c3c1f6df58f28c18\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/store.js\":\"bbdd1fc963bad346\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/default-themes/index.js\":\"67f2f3578dcd487f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/default-themes/themes.js\":\"44d38f3154352ef5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/diagnostics/facet.js\":\"21633ef221a474b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/diagnostics/useDiagnostics.js\":\"e8165febae5ff045\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/dismissals.js\":\"90a9eff640ee24de\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/index.js\":\"bf8c6c2b3cd5b225\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/status.js\":\"d5aa7859e2e64683\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/store.js\":\"978b43fa3b1f1bec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3b93090378341f1e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/ExtensionsSettings.js\":\"1ede7abc5e7303af\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/actions.js\":\"8e61cca4bd9dc121\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/config.js\":\"33dbe2c67acd73d3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/dataExtension.js\":\"a358fa0bca044d6a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/effect.js\":\"4c070e9a212fa236\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/index.js\":\"51bdba80098d36aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/propertyEditorOverride.js\":\"dc2a23a117e6c51e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/useToggleTree.js\":\"6db01994e2c81f4f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/ExtractTypeDialog.js\":\"4de244025cf61e2e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4d446e9941b84eff\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/PropertyShapePicker.js\":\"4aa3f45bb25f2097\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/action.js\":\"9c14dafa4a453df9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/index.js\":\"c148ef1e252d2bad\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/FindReplaceDialog.js\":\"af6d84a32733129d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/HeaderItem.js\":\"80195c979eabd4ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/dataExtension.js\":\"3c0637a2e510db78\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/index.js\":\"6661261e9162a672\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/search.js\":\"f91aa4bde0b7f33f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/toggleStore.js\":\"30d1caa57d328cdd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/LocationPropertyEditor.js\":\"ca2ec5598bff11bd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/MapView.js\":\"65c4f8d84b251b32\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/blockTypes.js\":\"4e753515e359c181\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/codeMirrorExtensions.js\":\"7d4f9eeb9ce8f5ac\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/createOrFindPlace.js\":\"fc579fd7ef58b946\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/currentLocation.js\":\"20734aacac50391f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/dataExtension.js\":\"d3286beae9bbec59\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/geoContentDecorator.js\":\"e3091d5cabd3f75d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/googlePlacesClient.js\":\"bc78890a69dc5f87\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/index.js\":\"383fb4c35049d102\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/locationsPage.js\":\"8c65fe256ece0183\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/mapViewport.js\":\"17d85ef96f79c5b2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/pickCurrentLocation.js\":\"1ceaadfb78712908\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/placeAutocomplete.js\":\"df3801596957adbe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/placeNameCollision.js\":\"4abf5711a49d53e8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/properties.js\":\"97589d1b9341eb53\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/propertyEditorOverrides.js\":\"d754f0c31d319bbf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/query.js\":\"5506fbbca8fa2296\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/usePlaceSearch.js\":\"b267f8085b5ba8ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1d6b99e97397c151\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ab1137f1fbf5135c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7a7ce7785b109009\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/config.js\":\"395c47e75aa0e267\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/dataExtension.js\":\"1a55894631a9a9f0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/facet.js\":\"a4d9cfd1c9d18632\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/grouping.js\":\"0b0b316b8b7bf2ec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/index.js\":\"b1fd529933c6063b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"813300be8f59cfa7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/query.js\":\"f3171fa169eca0c7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/resolveConfig.js\":\"bdc31a9381992c05\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"84a1ad059f5eb1e3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"bdfe45d6f0e170db\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/HtmlDocumentContent.js\":\"9aa876976b7ec521\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/HtmlFrame.js\":\"40f7ba18aa20fcde\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/actions.js\":\"4dc165927cf41ac1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/blockType.js\":\"20ce38350eb31754\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/confirmRunScripts.js\":\"197bd09cf222ab27\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/dataExtension.js\":\"cf88c5a61e0fbea7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameAnnotations.js\":\"c89ad9a190381a37\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameDocument.js\":\"310b76cfbae82c87\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameTheme.js\":\"b9a86d526436af6c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/index.js\":\"a86b5d1394707c3c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/scriptConsent.js\":\"764cfde37e7cd896\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/sourceMap.js\":\"90af40d02f806bc3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/useDocumentScripts.js\":\"0d3c6cb2c6602104\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/index.js\":\"106c0422527efcac\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/record.js\":\"7ecd8b141d734efb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/recordStore.js\":\"8309eeb7932d0e34\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/responsiveness.js\":\"4f0e9a3084f05025\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/schedule.js\":\"07acb96fc1410429\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/sessionContext.js\":\"4e858c4f5fdb897d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9c1e4a86aca0d449\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4cf257aa91b7c604\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/actions.js\":\"060800026fe545d2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/config.js\":\"a413e4cab60b315c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/dataExtension.js\":\"f62fc99a272aaa84\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/effect.js\":\"cf1e4718b2db8c00\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/index.js\":\"84a0439f55104cfa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/keyCapture.js\":\"62587013427ce8c3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/overrideStore.js\":\"2d66f1cad5550de3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"da95d62635a498bd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/HeaderItem.js\":\"58305e4aa2f8aa02\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/LeftSidebar.js\":\"ca4de4f63b085071\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/actions.js\":\"0326183d62234761\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/facet.js\":\"6abfd309f21ad3ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/index.js\":\"535bd3c4833c3c0f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/shortcuts.js\":\"773969c2683db551\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/toggleStore.js\":\"2fdba71711b754ff\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/MergePicker.js\":\"ff0ba9ce9764a747\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/index.js\":\"d0788694dd78ec90\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/mergeAction.js\":\"7b63a33ab16eb721\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/strategy.js\":\"c52d8b9bb0f558e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/Button.js\":\"6ffb747d3ffd312f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"01b5346c7386ef66\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/defaultItems.js\":\"707a4e8ad1b84ff3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/facet.js\":\"e8eda0bd8f358203\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/index.js\":\"eb800115c210d525\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"207041c387537f4a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f17bd180b10547c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3abf2ff2c510da1c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/facet.js\":\"78b2da54e2374448\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/index.js\":\"4a0d0f606418179b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/MoveDestinationPicker.js\":\"44c85ce272110950\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/blockSubtreeMembership.js\":\"41f6d53ae28a8fa8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/contextMenuItem.js\":\"dcb70a1fc611c0c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/index.js\":\"25741033f959827d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/moveAction.js\":\"c886274169df6f40\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/moveBlocks.js\":\"57654c52ed96a9eb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/selectionAfterMove.js\":\"d34fe60233a6a453\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/TutorialBanner.js\":\"6189521931227abb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/action.js\":\"26f68effa8760208\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/bannerDismissal.js\":\"2112db66399e6a9a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/documents/cheatSheet.js\":\"aa0cb603aa6cb865\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/index.js\":\"283a8466ef86d4f7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/keys.js\":\"8e952704c1fadad6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/landing.js\":\"42e2d284c02c80cd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/outline.js\":\"6bd96b3d6764bb8a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/seed.js\":\"0013982cf852eb05\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/PerfTrendDialog.js\":\"9bb74b92464afd7b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/analyze.js\":\"ee7b106fb2b945fa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/diagnosticsSource.js\":\"cf9d3258b7d2846b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/index.js\":\"d8ea83bfdcf4c6f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/load.js\":\"117c25db1f806e23\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/monitorRun.js\":\"5daa11f3128bdaeb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/schedule.js\":\"3e798b3fbf52f4de\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/series.js\":\"ff81d84bc85d2a1c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/store.js\":\"8febe047b0189a72\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/trendAction.js\":\"dd52c0f9d7f7b519\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/verdict.js\":\"3a12ab9a03ea5109\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/clickToEditAction.js\":\"9d447ef95b7ca36c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/index.js\":\"fdd041f36c396191\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/interactions.js\":\"115b5cf31daa32c3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"e563fd5b39f05bbd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/MigrationGate.js\":\"05a9f1743ab68b0f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/MigrationGateDialog.js\":\"01a890cf9ca5aab3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/action.js\":\"8ddc9e762d03db27\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/index.js\":\"bced2b8be6eb6227\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/localRunMessage.js\":\"f031ca82f724cbb8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/plugin.js\":\"5e8579a50d112834\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/progressReport.js\":\"95b73ef355eb1a7c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/sweepProgress.js\":\"0158120589fdc666\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/FieldRowRenderer.js\":\"24b184dcf959702c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/ValueRowRenderer.js\":\"c4588f2292b46da1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/actions.js\":\"120d43fe852b9f93\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/autocomplete.js\":\"d0c0fd5a91e171e4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/fieldRow.js\":\"1e94cd2a723a0e26\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/index.js\":\"a82d9c6b29cc9b8d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/referenceWarning.js\":\"47a7ea91e8331f06\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/valueAutocomplete.js\":\"09b65c885557ae94\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/valueSchema.js\":\"69e5d630a9c7bbd9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/HeaderItem.js\":\"20f9185a0aed0f17\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/QuickFind.js\":\"aac5654d28ffaea7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/index.js\":\"70d42a4daa74ebe3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/recents.js\":\"02225af849bc112a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/resultItems.js\":\"f781cbcfac9f9759\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/selection.js\":\"9c3f4bb97433c5a6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/toggleStore.js\":\"a7a1805b6107d118\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/HeaderItem.js\":\"318db5df6ea7f53f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a6ed4a5ca2b09b42\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/grouping.js\":\"7c67eb2e80651e2d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/index.js\":\"a27789872bdb7cd7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/target.js\":\"538aabf177186637\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/codeMirrorExtensions.js\":\"989c0acfa43a3c99\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/contentPrefill.js\":\"d4b8179ee72b4467\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/dataExtension.js\":\"a2b747e1854fa3d5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/index.js\":\"5e8bf6cfa2e360c5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c58c530d5ea32019\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/invalidation.js\":\"05c39aefb935ebba\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/localSchema.js\":\"b9b0abed7572e5ca\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/blockrefs/index.js\":\"3847e2b693afcb8a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b0ea6ef02bec6a0b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/index.js\":\"ae52c6d419ca19fb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/referenceNode.js\":\"025a059bad4441e4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/remark-reference-occurrences.js\":\"1091a77ed7b7f82d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"da8c04554674da53\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/index.js\":\"b09c784095484216\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"155585eecc7ae9ba\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8da967cb6a5b2205\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/mergeRetargetProcessor.js\":\"b61b3e26f444da94\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/parseFence.js\":\"7f28b91a38e11428\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referenceParser.js\":\"bae6136a231c1f21\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referenceProjection.js\":\"c8043536898622a6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referencesProcessor.js\":\"91bb8516ed1888da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/renameProcessor.js\":\"e7599a0e40c5d692\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/spanReplacement.js\":\"a36bce0751056df7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/htmlToOutline.js\":\"0d536532f935e7cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/index.js\":\"63e29e76f74cbe45\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/normalizeClipboardDom.js\":\"9707d1864304cc32\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/pasteDecision.js\":\"97243b5b6d35a935\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/action.js\":\"e50ac695cdf5f1c5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/blockIds.js\":\"40dd2a9a3654867b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/content.js\":\"035e04b221813415\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/effect.js\":\"474db0c42a737816\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/ids.js\":\"0275630b8378adc8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/import.js\":\"4b4365887962c617\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/index.js\":\"d2e14af7ffa74fc0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/plan.js\":\"896488dac92b745c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/plugin.js\":\"fef9c05c4d4f691a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/promotion.js\":\"c24c35a80c87788a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/properties.js\":\"ce6c8e070d10db18\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/references.js\":\"563db8cd24bd3ac8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/report.js\":\"ae0101d44756b02f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/roamMemo.js\":\"d9a30d8d0a8fa8e8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/runtime.js\":\"67592a4b97594e22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/schemaReconciliation.js\":\"59156c8349b6a966\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/srsMarkers.js\":\"d3bddbc5735a1ada\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/todo.js\":\"11868b85b11532ea\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/typeCandidates.js\":\"71ea4519d532467f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/types.js\":\"3a9ffeb6446bd226\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/search-health/index.js\":\"c8bf86e27a7fa15b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/search-health/store.js\":\"9c6e247aab7e06ba\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/HeaderItem.js\":\"1ab33c9624536852\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"193a91e0c9820390\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/index.js\":\"a739a70a16313d22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/model.js\":\"c7677ba057d310aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/toggleStore.js\":\"0f57b93075ea7f04\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/useKeyInspector.js\":\"aeb448fe2cfedc4b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"2c20590874ba61a7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/ShellDecorator.js\":\"3d21adf506f3c1d0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/actions.js\":\"9fb9f7988f900d17\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/exclusionsFacet.js\":\"584958f974217ce9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/index.js\":\"76a5883b7968e2ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/shell.js\":\"b12276d83778d710\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/surface.js\":\"8857fadf1567b6cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/walker.js\":\"bc0f166587a20e8b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7e251971126463e5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/dataExtension.js\":\"c1d6a4531821fb53\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/index.js\":\"53763f8a88371f69\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/indicator.js\":\"766942d50d8999f7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/moveSrsState.js\":\"5491842c8a4b4530\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"815613671c074c8f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/scheduler.js\":\"7711d632e8d5fe5f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/schema.js\":\"22c2328115fcc695\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6168c57147d943ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/srsClipboard.js\":\"4b219b1921826ddf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"226afd1d051ee46c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/DailyNoteReviewHint.js\":\"09737e1e96c31b53\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/DeckPicker.js\":\"dc418801f1c1ac64\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewControls.js\":\"4876843f35b6dccd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewDeckRenderer.js\":\"477eff89e65febb6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewSession.js\":\"b8615a1dd0350d21\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/actions.js\":\"4718d2d84de85346\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/archive.js\":\"f13288d7a4cd7bd6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/dataExtension.js\":\"b9185298e4b5c250\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/deck.js\":\"bcef13ed50946819\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/dueQuery.js\":\"d98cbce085093701\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/gradeDecision.js\":\"6b83051dd896995c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/index.js\":\"b1374a48a0e2ec00\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/keyHints.js\":\"eca67bed87170ffc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/reviewCardLayout.js\":\"53db103032802459\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/reviewProgress.js\":\"9c039b33a50697d1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/schema.js\":\"af6a1311d057f24d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/useDueCards.js\":\"f635f315def6ae49\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/startup-metrics/index.js\":\"16651d4a0c4064f2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/startup-metrics/record.js\":\"160e7a9b2dcae711\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/index.js\":\"d0a9bffa56aab5dc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/persistenceStatus.js\":\"0558b1827f7f801a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/requestAction.js\":\"b0464b51eabc442b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/TypeChipsDecorator.js\":\"d7f0ddd3f1002a9f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/codeMirrorExtensions.js\":\"35295b460be76028\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/index.js\":\"e3b0704f1e3ca60b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/typeAutocomplete.js\":\"2e2aacd6e8af127a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"28b2e59d64e42235\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/actions.js\":\"8312e24f015d3620\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/anchor.js\":\"161f4648a6ae285a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/events.js\":\"271a3320c258d51e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/gestureActions.js\":\"0114a38bd8b30369\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/index.js\":\"36c92c9ac04bf4b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"fcbe7812dd4b18b6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/collect.js\":\"2df3386682ea8dcf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/index.js\":\"6407c1cba7e2d490\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/record.js\":\"a4c90584375be1bd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/RejectionDialog.js\":\"ccf1bbe933e962da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d21e686c74308ac0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/index.js\":\"8a754f0cdf8a0099\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/model.js\":\"e6a834e81d654a37\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/queueCounts.js\":\"4a94108a5d522c7a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/rejectedHelpers.js\":\"56207df4cce0283d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/rematerializeAction.js\":\"e50100a764dc6465\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/useHysteresis.js\":\"19a4cbfcab7e40c4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/TableLayout.js\":\"956b1be833a01342\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/actions.js\":\"a79e46d5768f08de\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/cellEdits.js\":\"318e68d16e7c3d29\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/controller.js\":\"e6b15c597b2eebab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/convert.js\":\"c22121beae841701\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/dataExtension.js\":\"0bff50e570437b0a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/index.js\":\"f52f74e27b190741\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/keys.js\":\"59610aca6896d522\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/model.js\":\"cd77e74976ad2b7b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/registry.js\":\"d59d17ccb73f8a47\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/schema.js\":\"a2e9811eb2f48b29\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/effect.js\":\"05e31124efa8ec6e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/index.js\":\"40d4ee799694fb08\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/theme.js\":\"c28ce0cc84e5e9f6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/actions.js\":\"5be807ec122e8652\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/dataExtension.js\":\"4659105ee41f9eb6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/index.js\":\"ba8cfaa6ad43e727\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/schema.js\":\"99ec454d92bdb53a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/TouchSelectionLayer.js\":\"75bcad03fda5cce0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/actions.js\":\"f8f6d63e768fec1c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/defaultItems.js\":\"bca37050aa179517\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/facet.js\":\"aadd4b28020f17a5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/holdRecognizer.js\":\"931e82152bc2a480\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/index.js\":\"3a4010152833d757\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/UpdateIndicator.js\":\"2914b875beb0e965\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/index.js\":\"c4c3d51692b3c918\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/loadTimes.js\":\"6aa80af2cc83310f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoNotesRenderer.js\":\"96a287727b375aab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoPlayerRenderer.js\":\"cbdd06ed1430ca69\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoTimeStamp.js\":\"dd1b376d4ee24107\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/actions.js\":\"f8cd7ad0fb1fd05e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/index.js\":\"1383f46ef4a59450\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/markdown.js\":\"52e16dc16a94ab75\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/notes.js\":\"bd4061c002067d31\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/registry.js\":\"6c01448ec3385146\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/remark-timestamps.js\":\"639b7964818a63e7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/view.js\":\"b1bb5f3919918a78\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/LinkHints.js\":\"245d635c75ab4af2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/index.js\":\"14e8fd3806b1088e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/model.js\":\"bbc76f37c33ea3c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/settings.js\":\"d53acda37c35ef02\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/actions.js\":\"9334bc1c135d8c22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/index.js\":\"94d78194094928c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/interactions.js\":\"633a1d27cfe1f3b8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/workspace-header/index.js\":\"6de45bcd7c72f3c8\",\"/knowledge-medium/pr-preview/pr-1813/src/registerServiceWorker.js\":\"93f07f34b88b2340\",\"/knowledge-medium/pr-preview/pr-1813/src/requestPersistentStorage.js\":\"a9fea0d53387c6a0\",\"/knowledge-medium/pr-preview/pr-1813/src/services/authRequestDeadline.js\":\"c1406647d276bbec\",\"/knowledge-medium/pr-preview/pr-1813/src/services/authStorage.js\":\"3a477012061e6ea0\",\"/knowledge-medium/pr-preview/pr-1813/src/services/powersync.js\":\"1f1dc2beec8aefa2\",\"/knowledge-medium/pr-preview/pr-1813/src/services/supabase.js\":\"b152787cebb0916c\",\"/knowledge-medium/pr-preview/pr-1813/src/services/uploadErrorClassifier.js\":\"8cd2decd7c17baa3\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/ActiveContexts.js\":\"25a74740b15e3a4c\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/HotkeyReconciler.js\":\"40036e806a430eff\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/WipeLocalDataDialog.js\":\"a6046f086bc92a84\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/actionDispatch.js\":\"8f1d87fad47abc90\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/actionRefItems.js\":\"33d96f5de782dbc5\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/applyKeybindingOverrides.js\":\"cb3390ce98b6581b\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/blockActions.js\":\"e692e1aeff801358\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/canonicalizeChord.js\":\"170cac01a3b5b5dc\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/defaultContexts.js\":\"85b039d85c1b2997\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/defaultShortcuts.js\":\"4b46cc93cd74389d\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/effectiveActions.js\":\"19ca493fa1a30876\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/gestureAction.js\":\"99133674de431c59\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/gestureBinding.js\":\"930787072c273363\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/holdRegistry.js\":\"ce0bca8a09f1816d\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/keybindingConflicts.js\":\"c80f2ea02a6aba62\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/keybindingOverrides.js\":\"c3496de76a671863\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/pointerAction.js\":\"5d35a31bda227260\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/resolve.js\":\"cadfedd8f274927e\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/runAction.js\":\"948342308e55be60\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/sequenceMatcher.js\":\"72876b67a24d6b7a\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/types.js\":\"dee2b15a4e1d3a2a\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/useActionContext.js\":\"6c36513aa2f419aa\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/useActionDiscovery.js\":\"694067b34cb28213\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/utils.js\":\"9fa17a80c36e0d8a\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/bootStore.js\":\"e84bd630ffa2060c\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/previewDatabases.js\":\"e7438fbcc7113acc\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/byteTransform.js\":\"1cdd3cd512c9a657\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/attachmentCleaner.js\":\"b584e36473f2e93e\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/attachmentParts.js\":\"43c9a58db69637a9\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/bundleParts.js\":\"12e4102f7b934521\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/bundleRecord.js\":\"942472f251d193bb\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/manifest.js\":\"515e9c7496b181c7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/takeBundle.js\":\"5719d09ccdda7837\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/verifyBundle.js\":\"38aa145a188a55e3\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/cleaningStage.js\":\"b24349c64cb92c98\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionKey.js\":\"8f1528112fa9ee84\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionServer.js\":\"135b23e40349dbe6\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/flip.js\":\"de34fc5647aac9f1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/flipAttempts.js\":\"99fd663e2e6d184f\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/pages.js\":\"2618387152ac6962\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/preflight.js\":\"38b6274777df9844\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/reseal.js\":\"baab2171b33f1674\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/runConversion.js\":\"88923efa240a9330\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/runLock.js\":\"c4c8acdb4f846900\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/sealing.js\":\"ae3f915518f419e7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/sealingStage.js\":\"838310beb1f81a06\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/stage.js\":\"d34dc2e2dfa4e332\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/verifyReseal.js\":\"859168d33d34bc47\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/aad.js\":\"b72b7a6a2fb46f22\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/aead.js\":\"81a4bcf4eb39e8da\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/base32.js\":\"b2fc9718b46783b6\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/base64url.js\":\"8b3880733ab92da7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/binaryEnvelope.js\":\"b14d7d66060f042b\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/byteAead.js\":\"499d59bc9e4175e2\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/canary.js\":\"31edc74b57497bc3\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/contentHash.js\":\"0195d9229781ffce\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/contentKey.js\":\"a099c447fc0be021\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/derivedIdNamespace.js\":\"1302f5288042c3b3\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/envelope.js\":\"13a770a58305905b\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/hex.js\":\"7ac6e3f999f943b0\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/sha256Hex.js\":\"386b24d8ae2b1b43\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/workspaceKey.js\":\"c39a09907f3f3505\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/conversionState.js\":\"db44c9ff124048da\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/createEncryptedWorkspace.js\":\"80da326e597fc1c1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/pastedKey.js\":\"8fb6fe5e10160fd9\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8e9965261963d627\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/upgradeWorkspacePin.js\":\"937b35089fdb6569\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/keyStore.js\":\"5b976309a3b35509\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/mintWorkspaceKey.js\":\"fe27fb629c8fd74d\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/modePin.js\":\"4c9746e7c077fd45\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/openWorkspaceKeys.js\":\"bcf9d0701c96fb57\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/resolveWorkspaceEntry.js\":\"88e870e86e93c699\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/resolver.js\":\"4490426604e14c65\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/workspaceAccess.js\":\"0d22e22040c06a06\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/transform.js\":\"46e135d46f79a848\",\"/knowledge-medium/pr-preview/pr-1813/src/themeBootDefaults.js\":\"be1e7c1d4c68246c\",\"/knowledge-medium/pr-preview/pr-1813/src/types.js\":\"0bb77a182578991c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/ClientLocalSettings.js\":\"42d0d4107b3e360a\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/abortableSleep.js\":\"d0d990631f2e0780\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/array.js\":\"8d5ffdb43d9c7d82\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/backlinkAutocomplete.js\":\"2a47748b0d28be6c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/blockCrumbs.js\":\"64246060e7b55e30\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/blockrefAutocomplete.js\":\"d578bb49077b21e0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/cadencedIdleJob.js\":\"47619d27bae1933c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/callbackSet.js\":\"230c21e10c31d602\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/clientId.js\":\"f20565e64f4550f9\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/codemirror.js\":\"59885f8775e81f73\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/codemirrorCompletion.js\":\"fd894bb0ea34ec74\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/copy.js\":\"5d70b7a90de1138e\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dailyPage.js\":\"a0d020ad3e5c1378\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dbForensics.js\":\"9d168df241b11b64\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dbForensicsHooks.js\":\"248499cd174c45d2\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/deleteBlockThroughUi.js\":\"d3e2d9bff9fc7369\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dialogs.js\":\"e86261b15c449933\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dom.js\":\"2526e6db6c7ee9b1\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/downloadBlob.js\":\"4b5163324f00d02f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/exportSqliteDb.js\":\"c8252d44748b93a7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fileSystemAccess.js\":\"d9c9d95c4f36e889\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/flipSlide.js\":\"3194d5e5b35df797\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fnv1a.js\":\"d28482d380725276\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/formatBytes.js\":\"b979eb4b8bee6bfd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fuzzyRank.js\":\"bc84f97a7ffef2eb\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/idbKeyedStore.js\":\"bb8876da56199191\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/idleCallbackPolyfill.js\":\"2d5921f16433d6ca\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/keyboardAwareScroll.js\":\"6bbeb9d43fc326f2\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/keyboardViewport.js\":\"cc18b3d6d0d5be5c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/lastWorkspace.js\":\"4905905f2d4b450c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutColumns.js\":\"2c32b7c3160b99e6\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutSessionDom.js\":\"b02648cf1c93745f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutSessionId.js\":\"5d045607bb47a7aa\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/linkClickGestures.js\":\"412abbf6641fc357\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/linkTargetAutocomplete.js\":\"c84cd76f133a9bf8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/localDbCorruption.js\":\"dd081665763a266a\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/localDbRecovery.js\":\"c70ed2a3338f8e39\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/markdownParser.js\":\"aa91717a6f0510bd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/memoize.js\":\"34465eec77ef1a5e\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/nameFieldCommit.js\":\"daf5e8ab1d5e7459\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/nameList.js\":\"7d6f621c71a83ab3\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/navigation.js\":\"58beae3c863a3750\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/omnilinerNamespace.js\":\"d49e44c0a849097d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/opfsPageScan.js\":\"4a4ef6fd14baa70d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelClearance.js\":\"dbaafa28cdf494dd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelHistory.js\":\"5605c61e4b8026fa\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelLanes.js\":\"2fe9d530e2c9f80f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelLayoutProjection.js\":\"282b10085d693d8f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelScrollAnchor.js\":\"27ce15485921dbe3\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelUrlFlags.js\":\"59f53c700f92e589\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/platform.js\":\"9d51a0c09ff6ba40\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/pluralize.js\":\"573c1f233698ffa7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyCreation.js\":\"4563378b42b48362\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyNavigation.js\":\"101c6c74fb76ea23\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyValueContext.js\":\"f127b5589dd4e476\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/react.js\":\"d1588f2dc2d0e41f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/relativeDate.js\":\"2d2cb331a8b37ea0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/relativeTime.js\":\"f806b59ea7fa8b85\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/renderScope.js\":\"0326cd126cafb19f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/resolvedThenable.js\":\"cbb099ac243768d0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/routing.js\":\"e2a4965e1b6c29b4\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/safeMode.js\":\"2bf8e5afa43500cd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/scheduleIdle.js\":\"4d32a1de93fb36c7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/screenWakeLock.js\":\"118bf8c3a8d81680\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/selection.js\":\"4392145f783b5f07\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/softKeyboardGrab.js\":\"3457ee0a95b57cdc\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/startupTimeline.js\":\"d13d0e66ad4d5f41\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/state.js\":\"d2cd690919a25c33\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/string.js\":\"b1765cf7553874eb\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/surfaceZoom.js\":\"6429c74a3c7dd107\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/time.js\":\"3085c50c11f32883\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/toast.js\":\"88a21795843d77f0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/toggleStore.js\":\"33196194a735ec2b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/untilStopped.js\":\"3ef95a1c71376817\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/userActivity.js\":\"ad4b0fad1e22fd7d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/viewTransition.js\":\"8dfcd97332c708c8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/viewport.js\":\"ae1d564f96ea5419\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/webLock.js\":\"1e427ccbc6a62d2d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/workspaceRecovery.js\":\"08910dbced22ae6d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/workspaceSnapshotStore.js\":\"8088a4c12374ca44\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-compiler-runtime.js\":\"8b2acfb5a16cb5bf\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-client.js\":\"79c5515e96911cf0\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-server-edge.js\":\"76cbe1f7d7a149f2\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-server.js\":\"74cbc036ad67d4bf\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-static-edge.js\":\"46ccfa87782d4799\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-static.js\":\"78d080a7691e73dc\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-test-utils.js\":\"39d76d955fae3b42\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom.js\":\"a197bb97e0c38beb\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-jsx-runtime.js\":\"dde1901a3f03f57b\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react.js\":\"612ffd42b9633155\",\"/knowledge-medium/pr-preview/pr-1813/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1813/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1813/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
