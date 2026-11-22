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
		buildId: "a1780884738e-d1574af9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/\":\"7a88761c14b76286\",\"/knowledge-medium/pr-preview/pr-1813/index.html\":\"7a88761c14b76286\",\"/knowledge-medium/pr-preview/pr-1813/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1813/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1813/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1813/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1813/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1813/assets/FacadeVFS-DqptKQz2.js\":\"95f46b73b3729c5b\",\"/knowledge-medium/pr-preview/pr-1813/assets/OPFSCoopSyncVFS-DWrQVRCh.js\":\"9542765b2928a13b\",\"/knowledge-medium/pr-preview/pr-1813/assets/OPFSWriteAheadVFS-qXL0SDci.js\":\"7d9d7719001b805f\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-DkRWO3f5.js\":\"335a715425f8ac93\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-async-BNyZx3c-.js\":\"0f8d529e1425e26e\",\"/knowledge-medium/pr-preview/pr-1813/assets/worker-CpWaJyYn.js\":\"75ed195dfd8be54b\",\"/knowledge-medium/pr-preview/pr-1813/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1813/chunks/app-DpIf-VCN.js\":\"c48ac359c4081d36\",\"/knowledge-medium/pr-preview/pr-1813/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1813/index.js\":\"a9d7a119987e10ae\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1813/assets/AccessHandlePoolVFS-BmzakT7G.js\":\"2f4735be59f7e1b3\",\"/knowledge-medium/pr-preview/pr-1813/assets/IDBBatchAtomicVFS-IxpsWMkg.js\":\"b487e505c571d029\",\"/knowledge-medium/pr-preview/pr-1813/assets/MemoryVFS-CbEWh_qs.js\":\"96500bbc1012a33c\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-Dxll-p-p.js\":\"4f2fba122ab9c924\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-async-CPZnHa44.js\":\"9165a68bdbe1573b\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1813/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1813/chunks/AccessHandlePoolVFS-BUmjniDT.js\":\"73f5a6e3e70f6745\",\"/knowledge-medium/pr-preview/pr-1813/chunks/FacadeVFS-hHdbGJYq.js\":\"fba8aee147db601f\",\"/knowledge-medium/pr-preview/pr-1813/chunks/IDBBatchAtomicVFS-DzpZWTwM.js\":\"da2209a4a617f219\",\"/knowledge-medium/pr-preview/pr-1813/chunks/MemoryVFS-Dq-wEFO_.js\":\"44f120c77adced66\",\"/knowledge-medium/pr-preview/pr-1813/chunks/OPFSCoopSyncVFS-DKhgOARV.js\":\"49a6a46899b78292\",\"/knowledge-medium/pr-preview/pr-1813/chunks/OPFSWriteAheadVFS-CXDs2F1v.js\":\"ab2399e2fbff677a\",\"/knowledge-medium/pr-preview/pr-1813/chunks/Preview-CSaysBSi.js\":\"8d6f014e2952cba1\",\"/knowledge-medium/pr-preview/pr-1813/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1813/chunks/card-BMjf6foh.js\":\"f328f37715f92c6f\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-DlPgfzsF.js\":\"ef1ea6e27a0e8c68\",\"/knowledge-medium/pr-preview/pr-1813/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1813/chunks/mc-wa-sqlite-BmNj0rcl.js\":\"e690251c11187835\",\"/knowledge-medium/pr-preview/pr-1813/chunks/mc-wa-sqlite-async-Dk7WNHJg.js\":\"427abd5c49fe3ee0\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-4n7hCi0a.js\":\"f114ba33447c7954\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-BI5a6IOh.js\":\"6bf40bb6f46ee4dc\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-C4w5TrKB.js\":\"f4fedb4b53e6ab11\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-Ci7OCwia.js\":\"f2334cbcf996abdb\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-DS1RNJTp.js\":\"51a2344ab46ff0dc\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-DYaoCQY6.js\":\"65e49cc47d8dfea8\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-DnRKXaKU.js\":\"d7c35f9b66d65c5e\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server-legacy.browser.production-BXiy2LEq.js\":\"432b1c180639d671\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server.browser.production-Bae0nm1C.js\":\"efaeb47352bc5917\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server.edge.production-DPnb5Mwj.js\":\"4f26c47c680e897e\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-laDkFPsY.js\":\"faf6f740b6a12674\",\"/knowledge-medium/pr-preview/pr-1813/chunks/server.browser-C85nsbBi.js\":\"cb5998b237ad0c16\",\"/knowledge-medium/pr-preview/pr-1813/chunks/textarea-8VtKHb8q.js\":\"51a67990a3010508\",\"/knowledge-medium/pr-preview/pr-1813/chunks/ui-BSFMF9PX.js\":\"7d4ac933d6b35c48\",\"/knowledge-medium/pr-preview/pr-1813/chunks/wa-sqlite-CUTh2Sb_.js\":\"24b71e151d88d5ac\",\"/knowledge-medium/pr-preview/pr-1813/chunks/wa-sqlite-async-CSMaBvuG.js\":\"01187ce2443d7ce6\",\"/knowledge-medium/pr-preview/pr-1813/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1813/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1813/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1813/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1813/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1813/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1813/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1813/src/App.js\":\"cb894305c2c2f677\",\"/knowledge-medium/pr-preview/pr-1813/src/appUpdate.js\":\"87f1bcfcf74c7ea1\",\"/knowledge-medium/pr-preview/pr-1813/src/appVersion.js\":\"c9cc50b2fa107d49\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/initialLayout.js\":\"e93efe41fe94f47e\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/openWorkspaceData.js\":\"2cdf4234b4d53bfa\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/resolveWorkspace.js\":\"1909b653159a09ab\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/workspaceBootstrap.js\":\"9f682ae89a817202\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockComponent.js\":\"2499e77cd6f223a7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockCrumbs.js\":\"8decf0aa8c03f7f9\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockEditor.js\":\"7387bc6dcce00d74\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockLoadingPlaceholder.js\":\"4fc45c6ac6cdbfb3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockProperties.js\":\"27a6ddc9625dd024\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockSearchPicker.js\":\"a1cd94730b45517b\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ConfirmBulkDeleteDialog.js\":\"d97572deb8fe6e67\",\"/knowledge-medium/pr-preview/pr-1813/src/components/DividerHandle.js\":\"7f6e156e0ac712c3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/DraftEditor.js\":\"2d7325bb0581c789\",\"/knowledge-medium/pr-preview/pr-1813/src/components/GutterPill.js\":\"616271c260da77ca\",\"/knowledge-medium/pr-preview/pr-1813/src/components/Header.js\":\"1d665716acb1ef37\",\"/knowledge-medium/pr-preview/pr-1813/src/components/LazyBlockComponent.js\":\"c589a95e3a1510e3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/Login.js\":\"bc9f358d23dd2291\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ZoomableSurface.js\":\"3e876c58086616bf\",\"/knowledge-medium/pr-preview/pr-1813/src/components/editModeKeepalive.js\":\"8ea4cbbbe853f712\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyDisplay/PropertyDisplayScope.js\":\"57fbf1463d1078b0\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6ed32a4be430c605\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/RefPropertyEditor.js\":\"579e2136b53230c2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/RefTargetTypePicker.js\":\"6f75144799472a50\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/SelectPropertyEditor.js\":\"83f44bdce02dd650\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/TypesPropertyEditor.js\":\"c974e1bac4c62dbc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/defaults.js\":\"6f7ede55d096ef17\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/kernelValuePresets.js\":\"b6d26c0f6fc5523e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/selectablePresets.js\":\"33906f6761fede34\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/typesPropertyUi.js\":\"b1ad23ce4134a7c8\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/AddPropertyForm.js\":\"daae7ed0169502d6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/PropertyPicker.js\":\"0282ee606ff5bf92\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/PropertyRow.js\":\"02b50c56c24c806e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/Rows.js\":\"58acbb65536ddcf4\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/actions.js\":\"25704f831070c403\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/declarationOnly.js\":\"2777c862927e5287\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/layout.js\":\"8f7f55bf7f830650\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/model.js\":\"5832e8b83ba51e8e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/shapeUi.js\":\"3c9bcd4b1064da80\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/shapes.js\":\"d5bb613477723c84\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2093b18654638b0c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/visibility.js\":\"34e2e32709cc03c3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanelSections.js\":\"b3fffc5db8945b1a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockEmbed.js\":\"d5f4063c19038c13\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockLink.js\":\"d952a6594ce6cd4b\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockRef.js\":\"27b4c8a421ae2907\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/ReferenceLink.js\":\"55f48b25e4038020\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/cycleGuard.js\":\"f49fde63f4312e2a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/cycleGuardContext.js\":\"9126defd96ec218a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/linkInteraction.js\":\"89866dd9a69338e1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/referenceLayout.js\":\"fb25a990722811eb\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/useBlockRefAncestors.js\":\"012bb681e6a4118d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockGutter.js\":\"72620d9104a7c3e7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockInfoDialog.js\":\"a1bf3bb54dfcf009\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockTypeBlockRenderer.js\":\"75a23b8fd4018ef7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BulletHoverCard.js\":\"2a741507e82a6f9d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/CodeMirrorContentRenderer.js\":\"071e55a3d275a6b4\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2dc612512f020b97\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/ColumnResizeHandles.js\":\"b1f122b192270699\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a7d8aa01f6a00d0e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/DefaultBlockRenderer.js\":\"9b8440fba13d2751\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/LayoutRenderer.js\":\"094fd35e3d1271b6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/MarkdownContentRenderer.js\":\"78aca962d113d7b9\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/MissingDataRenderer.js\":\"3fdc4e5bf1ed7f05\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/PanelRenderer.js\":\"5bb1359f735d3532\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e1926f7729890dca\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/TopLevelRenderer.js\":\"9596dc9fe1a64b47\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/blockGutterMode.js\":\"1c805b354e528171\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/blockTitleText.js\":\"67d65787216a5a70\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/fieldCreationKeydown.js\":\"fdaf237c5ba40b07\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/layoutRootContext.js\":\"60267d3cccd424f3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/typeChip/TypeChip.js\":\"76f921b5f5a6a5ea\",\"/knowledge-medium/pr-preview/pr-1813/src/components/typeChip/chipStyle.js\":\"94c9f8110bdd6f83\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/anchored-floating.js\":\"13921d1452b1fab3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/button.js\":\"f8b89a887a9e71bd\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/card.js\":\"eceb2cde72809335\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/checkbox.js\":\"f694ad27181d354e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/collapsible.js\":\"3a11e21fe7d2d67a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/command.js\":\"13e4c384ead05242\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/context-menu.js\":\"f190a4d972ce34e3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/dialog.js\":\"6fd17a28fe140e20\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/dropdown-menu.js\":\"f175e62553ecbb31\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/floating-listbox.js\":\"fc03aeb6783f0e65\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/index.js\":\"5a0b70fe5e5bf7cb\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/input.js\":\"29f49b2fe8c20515\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/kbd.js\":\"9ad5ea6ea01f9612\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/label.js\":\"cadb83e1ab7d93f6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/textarea.js\":\"54f334f0ce822923\",\"/knowledge-medium/pr-preview/pr-1813/src/components/useEditModeYieldKeepalive.js\":\"b7a081bd3afd642f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/BootFallback.js\":\"8a81cae584365d67\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/FocusedRowLazyMount.js\":\"7ed30af3787dd5d2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/LazyViewportMount.js\":\"48c75a3308a32eca\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/LocalDbCorruptionFallback.js\":\"465d76891f5061bc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/error.js\":\"4639e69bd992cc31\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/lazyMountRegistry.js\":\"3b841bc5904d5fb2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/suspense.js\":\"7f34cbac05b38512\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/CreateWorkspaceDialog.js\":\"dd5a743fb4deec53\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/PendingInvitations.js\":\"5ee30046c0321667\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/SyncProgress.js\":\"6d595a072992beb8\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/UnlockProgress.js\":\"826c14e0b84535bf\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceKeyGate.js\":\"020d2677fd11f81c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSettingsDialog.js\":\"7aabeefd80754407\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSwitcher.js\":\"5950a340a26cb6d6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSyncGate.js\":\"3e5130d263fe2439\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/ConversionFlow.js\":\"92c97e6c9473c2e0\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/ConversionFlowHost.js\":\"9acc8fd51d74b943\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/EncryptionSection.js\":\"48733e87414ae878\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/attachmentPrompts.js\":\"cf86e375805b36c1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9fbf631fb81b0d1a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/conversionFlowDeps.js\":\"e8d4fcd02fe047a7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/conversionFlowStore.js\":\"fa5baa6eef79c1b4\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/flowUi.js\":\"a7e2a6db06bacf07\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/useConversionRun.js\":\"068e7a49653dcad7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/keyUi.js\":\"65279bc65ada2585\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/useCloseOnKeyLoss.js\":\"2476eb82909496ba\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/useCloseOnServerE2ee.js\":\"c944deed11c9afe3\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/workspaceUnlocked.js\":\"20dd540d1acca70c\",\"/knowledge-medium/pr-preview/pr-1813/src/context/backgroundSubtree.js\":\"bfe08e827ca62f67\",\"/knowledge-medium/pr-preview/pr-1813/src/context/block.js\":\"b9b409b269b56aa9\",\"/knowledge-medium/pr-preview/pr-1813/src/context/layoutWsContext.js\":\"6941cef996e3d55f\",\"/knowledge-medium/pr-preview/pr-1813/src/context/propertyDisplay.js\":\"59e96c88565ac8e6\",\"/knowledge-medium/pr-preview/pr-1813/src/context/repo.js\":\"8fc6c329d6a9a1c9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/aliasClaim.js\":\"81bd477b71f5c39c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/aliasSeatNamespace.js\":\"f459fb43a19c0a70\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/blockData.js\":\"284ca5c2e48279ed\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/blockType.js\":\"2d114cbd7db71eb8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/changeScope.js\":\"b95fd195e424ee7d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/codecs.js\":\"62c0362dc4328ba0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/derivedData.js\":\"be1043c7519f37a6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/errors.js\":\"1eee12f634e8ecc3\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/events.js\":\"c17063622ac7491a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/handle.js\":\"3c09254172f4cabf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/index.js\":\"4f28ee3420220a06\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/mutator.js\":\"301470e0db224c26\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/processor.js\":\"dc4bccfa2fa9c38b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/propertySchema.js\":\"d7c0e798a842c870\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/query.js\":\"17e8762d57fc4451\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/sameTxProcessor.js\":\"3b7f622b30fb2b3c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/schema.js\":\"3c09254172f4cabf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/tx.js\":\"3c09254172f4cabf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/typedBlockQuery.js\":\"e34f65ce07046982\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/user.js\":\"83beea885639b986\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/valuePresetCore.js\":\"6c00fc0a5c5d4a95\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/valuePresets.js\":\"e7731e25821e5cc5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/attachmentCleanerIOVerb.js\":\"6f62fcc5034a2213\",\"/knowledge-medium/pr-preview/pr-1813/src/data/block.js\":\"e1516a5d22ed8450\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockCache.js\":\"fbb484f0654340cb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockId.js\":\"2d8dbdd8ea992e19\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockLiveness.js\":\"0fb89c9d8c0084c6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockMerge.js\":\"1dde9083dffbedc4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockSchema.js\":\"156c5f3f47be4f89\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockTypes.js\":\"ab08b5de16302b62\",\"/knowledge-medium/pr-preview/pr-1813/src/data/clientContext.js\":\"4d7b7b24e0d8f581\",\"/knowledge-medium/pr-preview/pr-1813/src/data/dbFileSiblings.js\":\"daa3126bd50b22c0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/definitionSeeds.js\":\"beac5f1f2a09fdef\",\"/knowledge-medium/pr-preview/pr-1813/src/data/derivedIds.js\":\"22e2ff6afa2a710c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/drawnSubtree.js\":\"d3e48da15b2d5d6c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/facetBridge.js\":\"33addba06536a4b0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/facets.js\":\"f8b49a1597cae84d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/globalState.js\":\"a4a798e92de71dde\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/aliasClaimRederiveProcessor.js\":\"a154ca536888f4e3\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/ancestorBatch.js\":\"f3856e763d439681\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/blockTypeTypeifyProcessor.js\":\"7b584baac9c6a916\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/clientSchema.js\":\"254b2dfb1a863546\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/commitPipeline.js\":\"8bb71a854e26b2ad\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/devAssertions.js\":\"69feda31602bdb64\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/firstSync.js\":\"65f42f744f39bc83\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/freshInitialLoad.js\":\"3d02b692a74dc871\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/graphBackfillClaim.js\":\"c253d8cb2759445c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/handleStore.js\":\"eeea0a9bef126fe6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/idleMarkerJobs.js\":\"dfc3969926f0ced1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/initialDownload.js\":\"2896b7b99baf4fde\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/initializeClientDatabase.js\":\"e0ac22b5e56aea35\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/jsonCanonical.js\":\"11983e51d37faab9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelInvalidation.js\":\"5d4cb6ba75247556\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelProcessors.js\":\"ffec2e185d44ca2e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelQueries.js\":\"47e3006f8741f240\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/mergeTypeMembershipProcessor.js\":\"c37203b5ccfb0cab\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/normalizeReferencesProcessor.js\":\"02ab411df431d564\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/poolInstrumentation.js\":\"0d49c8fdba99ab60\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/processorRunner.js\":\"7e937da92b117699\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyCellBackfill.js\":\"a1dcd1a730dd539a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyChildMint.js\":\"94fae3e29da9d9c1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyChildrenProcessor.js\":\"2984f098c3591b6a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bc845341c5ac7ab4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyDefinitionSynthesis.js\":\"828a4679fb02e96d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyKeyScan.js\":\"16e08e0cbe729581\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertySchemaResolution.js\":\"3a47217173de9d6c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyValueEdits.js\":\"e70a3d4ee544bfca\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/raiseProtocol.js\":\"a1aec792c6126ebe\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/readBatch.js\":\"b027be7d68ef9fbd\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/refProjection.js\":\"61fce4b7e6bac86a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/referenceTargetLookups.js\":\"7779cb7d0df8163e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/referenceTargetProcessor.js\":\"2cb2ba9509a976e6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/replayMerge.js\":\"8bffd95ac19df345\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/sqlBinds.js\":\"3f56870f888e2514\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"fd4274e11ef49add\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/arrivalProcessors.js\":\"dad151af8047bb5f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/invalidate.js\":\"3821fdab8dccc0d8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/materialize.js\":\"13b4cb6fe29cc1aa\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/observer.js\":\"9dc004d43a2798cf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/reconcile.js\":\"90a9d6fcee2b0f42\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/timingMetrics.js\":\"bb2c81d33931fed4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/treeQueries.js\":\"015c5764a8bfd9b2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/txEngine.js\":\"60d763eb9296cd21\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/txSnapshots.js\":\"47376c5adac2fe7b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/typedBlockQuery.js\":\"eb88cbcad29ae28c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/undoManager.js\":\"4582e66d571b5d7c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/invalidation.js\":\"f0f9719fb11f210b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelDataExtension.js\":\"8544b5dcfb4297a8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelPage.js\":\"2364e616d9ee4d09\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelValuePresetCores.js\":\"6bb3da8f52a798b3\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbCorruptionSignal.js\":\"31603dd6dda430e6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbStorage.js\":\"eab29575464962be\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbVfs.js\":\"8df5fa561ba42014\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localSchema.js\":\"5597492bfbb7ff53\",\"/knowledge-medium/pr-preview/pr-1813/src/data/maintenance.js\":\"20dc1bee22a6ddff\",\"/knowledge-medium/pr-preview/pr-1813/src/data/mergeProperties.js\":\"9d07b9a271439c22\",\"/knowledge-medium/pr-preview/pr-1813/src/data/metricsConsoleHook.js\":\"5e7a5b8405c0c2f7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/migrationsPage.js\":\"ed72e1943cd8bc2f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/mutators.js\":\"494f2ef96849a333\",\"/knowledge-medium/pr-preview/pr-1813/src/data/orderKey.js\":\"d7522d55106138b0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/orderKeyPlacement.js\":\"d46813ed00349ecc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/outlineSurface.js\":\"3ca21492d9ac27e2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pendingEditorContent.js\":\"7316576c5b8be0ed\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pendingUploadsSql.js\":\"978a6a9d3b11fd62\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pluginStateExtensions.js\":\"9b97b7a50e5fec03\",\"/knowledge-medium/pr-preview/pr-1813/src/data/powerSyncLogger.js\":\"8c0dfc5191dbcf27\",\"/knowledge-medium/pr-preview/pr-1813/src/data/projectorRuntime.js\":\"0c6e2fc72aebeb63\",\"/knowledge-medium/pr-preview/pr-1813/src/data/properties.js\":\"a86c4de9a72a1ad8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertiesPage.js\":\"c955faee796015bd\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyChildren.js\":\"94f0fa4c38c2722d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionFanout.js\":\"fb2bfbc16cff1645\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionMetadata.js\":\"c0afcf6f2f7a3c36\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionRegistry.js\":\"b5ecfb0ceed89f3e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDisplayMode.js\":\"4d658ee07f0b1c74\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyRowCreation.js\":\"23bd9cfc088ef246\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertySchemaCreation.js\":\"6a43350a2b167688\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertySeeds.js\":\"eb36b9238ae8c7d1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/recentsPage.js\":\"633fcdbe1b2faefc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/referenceBlock.js\":\"29ae538018b3fc7e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/rejectedUploads.js\":\"3f847056e990c473\",\"/knowledge-medium/pr-preview/pr-1813/src/data/releasePowerSyncConnection.js\":\"7e46b4356bdae54a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/repo.js\":\"9edf95206055224d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/repoProvider.js\":\"18a18fc60245f469\",\"/knowledge-medium/pr-preview/pr-1813/src/data/rowProperty.js\":\"cab5b7ddf3cfe6ad\",\"/knowledge-medium/pr-preview/pr-1813/src/data/searchFilter.js\":\"f79c041a267bd1f2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/seedIdentityLedger.js\":\"d8cc897abc5469b7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/stateBlocks.js\":\"cb0a1df19b6fe29f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/structuralEditPolicy.js\":\"349f16596da08060\",\"/knowledge-medium/pr-preview/pr-1813/src/data/subtreeDelete.js\":\"ac7ae4e9e0c10fec\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncStreamLock.js\":\"ec833df04cfcb31a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncedTableSqlRecognizer.js\":\"72b3d950b15a2ec3\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncedTableWriteGuard.js\":\"f350c5296c81b792\",\"/knowledge-medium/pr-preview/pr-1813/src/data/targets.js\":\"c5153c4313c3fdec\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeColors.js\":\"d463ac8b8eacf4b1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeDefinitionMetadata.js\":\"12503d9610e8600f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeDefinitionRegistry.js\":\"b5cc8a0ea7d167cf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeExtraction.js\":\"1e58d451c58dca84\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeInitialValues.js\":\"b14d3c7bde73fba1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typePropertyGroups.js\":\"ff6dd2f7f5c507d9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeSeeds.js\":\"3719a03574a5860c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeTagger.js\":\"d0bdd99f6060a7fa\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typedRecords.js\":\"1f058faadebf960d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typesPage.js\":\"9e635aa6e77f4d60\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userPrefs.js\":\"23477fbb2d7a8fd0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userSchemasService.js\":\"00564c207b608a27\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userTypesService.js\":\"17fb2de6ad1db5a1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/valuePresetRegistry.js\":\"2142cb766a3a3a59\",\"/knowledge-medium/pr-preview/pr-1813/src/data/visibleChildren.js\":\"31539f3cad4ef787\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceConversion.js\":\"27948b17cb443348\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceFirstSync.js\":\"6b7e2ca7621d5ccf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceIdNamespace.js\":\"59f05221cead2672\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceSchema.js\":\"9540040cf21ee8c9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaces.js\":\"c7c09a0a3c740f57\",\"/knowledge-medium/pr-preview/pr-1813/src/data/writeAheadLog.js\":\"b846c332b7906511\",\"/knowledge-medium/pr-preview/pr-1813/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/BlockPasteShellDecorator.js\":\"1fca2e3addff7f8d\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/atTrigger.js\":\"d484e93d1c5c78b6\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/autocomplete.js\":\"2510342e0f80cca7\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/codeMirrorExtensions.js\":\"38c1e972ace73b87\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/contentFlush.js\":\"cf590ae503e64499\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/defaultInteractions.js\":\"1478a9b681a56f0e\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/editSettleSignal.js\":\"aa75527dddf8ea4f\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/insertImage.js\":\"ff10c6d7e818f68c\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/referenceCompletionRange.js\":\"36b4ca261d7d67aa\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/referenceTargetTypes.js\":\"5ad7eabf0a608d54\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/syntaxContext.js\":\"085f33ba402bef4d\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/triggerMatch.js\":\"13ecab6a488b661c\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/AppRuntimeProvider.js\":\"6348d40aaba81d3a\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/BlockFocusShellDecorator.js\":\"0e51b44afd22f2d9\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/ExtensionRenderBoundary.js\":\"c6e4d2864683c458\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/PanelContentRecovery.js\":\"b4b7e94fda121b38\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/apiCatalog.js\":\"c215b3da1066ba39\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/approveExtensionHere.js\":\"4b9c9574a2ef369e\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/armedCutAppMount.js\":\"a82a6809bc96077c\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/batchableKeyedStore.js\":\"bf19f52895fcf4fa\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/blockInteraction.js\":\"621456011d679b45\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/blockSelectionAction.js\":\"f3d3320b2a0fbbd0\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/compileExtensionModule.js\":\"68d3c1d02eebeee3\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/compiledModuleCache.js\":\"5365d50ee90c939f\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/continuousGestures.js\":\"e1de73e67f8078d9\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/core.js\":\"a74985a7c3446323\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/defaultRenderers.js\":\"00c775d6cdefaa5b\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/definitionFanoutAppMount.js\":\"3ae020971233fdd5\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dialogAppMount.js\":\"97fc799175a429a2\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dynamicExtensionSeeds.js\":\"68a286364d4ee57b\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dynamicExtensions.js\":\"43cb2f5a577fb763\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/exampleExtensions.js\":\"eb0f89b97a57e37b\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionApprovalStatus.js\":\"59135e058d9c61b4\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLoadErrorToast.js\":\"7021b96aa0ed5464\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLoadErrors.js\":\"43d0c5f1ae3c0a30\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLookup.js\":\"09d1df0fded55496\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionToggles.js\":\"6065a1547571f8ef\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionUtilitiesCss.js\":\"7b4cac481ae66bf0\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/kernelPageDeletionGuard.js\":\"989b5f563e8ba47f\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/liveRuntime.js\":\"035add1f0740d73e\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/openExtensionsSettings.js\":\"a6375083edf8822f\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/overridesCache.js\":\"dc0739c8864a7fd9\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/pluginIds.js\":\"49306e67e8322bfd\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/processorRejectionToast.js\":\"f6c0de7442bab478\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/runtimeActions.js\":\"c0d98cc2cc1bcd00\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/runtimeContext.js\":\"b2de2c412faec0ff\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/staticAppExtensions.js\":\"bb9c2986f66d47a9\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/staticDataExtensions.js\":\"4bd7a4561b287cb7\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/toastAppMount.js\":\"e5e743cace926306\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/useOverrides.js\":\"f059636190e68951\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/useShortcutSurfaceActivations.js\":\"c6df0ebc407b2136\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/discoverToggleTree.js\":\"4ae06757886ac094\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/facet.js\":\"b4d2452b2943c282\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/resolveAppRuntime.js\":\"815349e7da3b580d\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/runtimeEvents.js\":\"049d922f7d573157\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/togglable.js\":\"73a78aee7d489b72\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/variantFacet.js\":\"7a43caf95b894702\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/verbFacet.js\":\"cefb062d33002a25\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/block.js\":\"2b346254cb37dfac\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/focusedChild.js\":\"c1790deaddb47fa3\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/propertySchemas.js\":\"552812a1fb2b6502\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/typeRegistry.js\":\"ea414626395a896d\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useAncestorCrumbs.js\":\"23d319ec03ccdd96\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useAutocompleteListbox.js\":\"2fa59c0bc4eb8444\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useDebouncedSearch.js\":\"e1e573cab093a921\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useDebouncedValue.js\":\"2bcd8b61bd1a7c56\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useIsFocalRender.js\":\"0a42f36d793fb26b\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useIsReadOnly.js\":\"a223cb3c68378ebe\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useMaterializeBacklog.js\":\"b6af869fdc47554c\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useMinuteClock.js\":\"eefc27e82630e422\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/usePanelLayoutProjection.js\":\"ca6c550cddc8e6b2\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/usePendingInvitations.js\":\"785142401eb76e20\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useRendererRegistry.js\":\"a7289be6da5d9b9c\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useRetainedFieldRows.js\":\"20fb600fe7d87126\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useWorkspaces.js\":\"3bc7b979639372b9\",\"/knowledge-medium/pr-preview/pr-1813/src/lib/utils.js\":\"2436bd50ce135314\",\"/knowledge-medium/pr-preview/pr-1813/src/main.js\":\"665da620ee481445\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/MarkdownImage.js\":\"f7012e0c3343957d\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/blockSeparators.js\":\"92620f7ad4c38a8c\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/context.js\":\"fcce0b9aac87e748\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/defaultMarkdownExtension.js\":\"f18374b8d6dc6a2b\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/extensions.js\":\"a2250b3241e52361\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/renderMarkdownHtml.js\":\"ca968d2dc965b16d\",\"/knowledge-medium/pr-preview/pr-1813/src/minimal-editor.js\":\"7f6b615d5ecd9882\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/armedCut.js\":\"1df014734f1a99ae\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/captureMediaVerb.js\":\"e3c3a0a227ffa34f\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/clipboard.js\":\"d2b39ed593a3619e\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/decision.js\":\"5145e0200c6caffa\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/operations.js\":\"2de0f05849293381\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/account-header/AccountHeaderItem.js\":\"aaa5443bf6164abf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/account-header/index.js\":\"3b7df1da8a2bd385\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9d45c56cbf8098f2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/askAgent.js\":\"7877e73cd0e67af2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/askedStore.js\":\"db493048ea8b52e6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5dee24317be6e9f2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/chipState.js\":\"3bd297b1a259a1a9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/dataExtension.js\":\"679b214249cd52b6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/index.js\":\"96388885348fecc2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"2a929bb811b203a2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/schema.js\":\"4cf096a01b7c893d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/AgentTokensDialog.js\":\"167ed99fc96a9192\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0a968273639c0f33\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/addMedia.js\":\"af2c4acc91aef712\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/backlinks.js\":\"dc8fabaa208076ef\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/block.js\":\"84f7b84d5702e1e4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/context.js\":\"737dad9243b30589\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/displayIds.js\":\"52617d135af72c2e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/index.js\":\"71d50c3786f820fc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/outline.js\":\"43c9e62d5fccbeec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/properties.js\":\"f7d84f1c442ef2ef\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/refs.js\":\"37a08b4960f2a614\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"860ca4b3a668ab76\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/search.js\":\"eca4178d38e1a0cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/shared.js\":\"cb40dab4c315afac\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"b7afa418ca2c34f0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/text.js\":\"8b5c832e9889d6fc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentWrites.js\":\"0652b29eb6ee28ad\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/authoringCatalog.js\":\"a04bc3f4291146fc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/blockRefTargets.js\":\"add15e3d6f73dded\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/bridge.js\":\"4e977ade1df4af75\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/bridgeLoop.js\":\"bd1ee8c10d012dad\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/changeHistory.js\":\"90f1eccd7167f3a9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/commands.js\":\"db9c37ca302223a2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/commentsCommands.js\":\"64902d9d194300f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/dataExtension.js\":\"f851214d1ec4587d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/dataModelGuide.js\":\"19d7770b4dc7a9c0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/describeRuntime.js\":\"2f01a29015cd2d05\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/extensionLint.js\":\"74909cc7a82090eb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/grainAudit.js\":\"670ef9d8e37857c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/healthCommand.js\":\"9975578223665ae4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/index.js\":\"50e34ae0a4b7c13e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/presetIdentity.js\":\"bb3ac2284e98323e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"91e7277a1958e1e9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/readMedia.js\":\"da2bd978ae2890b4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/schema.js\":\"70b8539bea86da22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/serialization.js\":\"d68b30b3814f0500\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/targets.js\":\"52040eb76f6d9a5d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/tokens.js\":\"43d9642eff0a71c1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/watchEvents.js\":\"0e9927ee03246cb7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/workspaceGuard.js\":\"f9c979143d58d4a7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/writeCommands.js\":\"d25938eecd66813c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/AliasCollisionToast.js\":\"bf35b387793bbe05\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/DuplicateNameBanner.js\":\"3bc93aa2a20d823b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/collisionMerge.js\":\"cf39e2e8ce670455\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/dataExtension.js\":\"b81dcd40e53e1d2b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/index.js\":\"aea24f7ab31c21e2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/mergeCollisionAction.js\":\"0195394317680ab4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/pageStyling.js\":\"88b81cd9253c4ae3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/rejectionToast.js\":\"185570525f3f3264\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/syncProcessor.js\":\"8ec34b3a109f0acf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/actions.js\":\"fc33b60e2c59a57f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/addComment.js\":\"b4c20ac597e041ee\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/anchor.js\":\"e0805ed21315d9a4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/anchorState.js\":\"39fe6706e0d7261e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/commentLinks.js\":\"517f906a7d004205\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/confirmThreadDeletion.js\":\"4ef8c6780d1bee6b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/container.js\":\"044a04a7e3bc40f0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/dataExtension.js\":\"66573d16f719c9eb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/deleteComment.js\":\"77c14cb97d862c63\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/highlights.js\":\"bf8605e94e32ca52\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/index.js\":\"4a3ddb5ac358e50d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/linkedCommentsPill.js\":\"f9acbb06f4ccc4cf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/margin.js\":\"f8d16237ec372f1c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/marginSchema.js\":\"60c5604cc58882d8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/newComment.js\":\"61dda19b9abc70c6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/ownThreadPicker.js\":\"db9c67b21a664e7a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/placement.js\":\"1408c1489b4e6387\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/queries.js\":\"d5c698b924228cae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotePosition.js\":\"4c97485b1f70c6cf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotedIn.js\":\"ce4eb3c47b28aae7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotedRange.js\":\"6c235e8a461832d3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/rangeRefs.js\":\"32859e0720054782\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readHighlights.js\":\"d96db794797af6d4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readSelection.js\":\"fb940a3e02a13a12\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readSelectionUi.js\":\"a555266707a5ccba\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/reanchor.js\":\"adb254c08d316c43\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/schema.js\":\"d0f11a19bf570771\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/scope.js\":\"c623ebdbf4cdb1ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/scopeThreads.js\":\"53c40484d737e3c2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/splitRetarget.js\":\"332669c058ef9f59\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/suggestionCard.js\":\"d7374755ba6c6500\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/suggestions.js\":\"2f550d98dea9f20c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/summaries.js\":\"394db72646c96e4f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/summaryBatch.js\":\"1b85c15e5f50481e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/surface.js\":\"a44c34959a5a0710\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/threadNavigation.js\":\"5d22c4e89467fd7c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/threads.js\":\"201dc96ef8f01c25\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/ui.js\":\"f6127c23169ee972\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/uiStore.js\":\"22940c02cd5d2017\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-intents/appIntents.js\":\"1657025204e76a78\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-intents/index.js\":\"941ffd0feb5a652a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-update-prompt/index.js\":\"a437d0cd555af7ea\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-update-prompt/status.js\":\"34afa94efe9775fe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e259bc1c343323cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaBlockRenderer.js\":\"b0a5de5052ea1d2d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaDownLaneReplicator.js\":\"63e884a57fd9fe9b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaUploadReconciler.js\":\"3b1fdc75a2e155e8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetDownLane.js\":\"d9cc32aaa541b8dd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetResolver.js\":\"3b4e8a9530923e82\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetUpload.js\":\"ac36d31f1bceb284\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/attachmentCleanerIO.js\":\"b66a166479770823\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/supabaseAuditIO.js\":\"ecff0730ac2f13da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/blobStore.js\":\"e38888824d7095d6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/byteStore.js\":\"54220ec9093da475\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/cleanerIO.js\":\"75a7709a283f3212\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/cleanupAttachments.js\":\"7283725953225a8f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/dataExtension.js\":\"bcbba14a2573f0d9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/downLane.js\":\"b9c981a58c4f0dd6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/index.js\":\"4dfa3f3da5aeaeef\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/insertImageContribution.js\":\"8d5f605387168cc3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/laneArming.js\":\"b9f21d6b80225548\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/laneLock.js\":\"17246b7172043536\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaBlock.js\":\"40ffe660b1a28a2f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaCapture.js\":\"13459d57d60ae725\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaViewers.js\":\"b8bb4d3c2c176155\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaViewersFacet.js\":\"42daea72826b0d91\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/pasteCapture.js\":\"49e252d69f832c65\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/resolver.js\":\"a1e0091570c6ffb5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/retryUploadsAction.js\":\"c68e84fbb4e6774a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/storagePaths.js\":\"0b965cd2ce81f59f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadDrain.js\":\"9bc9388ae0bb50c6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadLaneStatus.js\":\"7892c0ed991ee8e1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadReconcile.js\":\"038eab7a331c3165\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadRecovery.js\":\"542429c8fe341823\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadStore.js\":\"ea8f7ef49c449c33\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/useAssetObjectUrl.js\":\"fd5bacb5c96765ee\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"66539585e0019cee\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0bea460884576cd8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/facet.js\":\"035e385c6cf664b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/index.js\":\"7028d3d680586cc4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/prop.js\":\"d44c3aa5af2cbd6a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BacklinkFilters.js\":\"b2a8d99e037bf0ac\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"28821ab21207f2ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BlockEntry.js\":\"90e609dba11f4b64\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/LinkedReferences.js\":\"62302b33677a7691\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"d15503bcbf50e042\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/dailyNoteDefaults.js\":\"2c82602785de658e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/dataExtension.js\":\"9d4d82418de7c7bb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/edgeExclusions.js\":\"feb64ae629c94c8f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/filterProperty.js\":\"e07e27b41f8fdd3b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/index.js\":\"a5957f69157e743d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"df00e1adc3da5d3d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/applies.js\":\"b8e9b89bbf9dd63f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/countQuery.js\":\"d11a903d79349802\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c64382a8270af386\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/index.js\":\"43a4cbbcb4c75de7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9a01b74e2a6222e4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/presentationInvalidation.js\":\"b461ccdc332be67e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/propertyEditorOverride.js\":\"4ee991ab95da93f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/propertyFilter.js\":\"50649e3b525429c1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/query.js\":\"e4c8a3b6918dfe11\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/resolveFilter.js\":\"f549b2663cc0aa40\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/sourceBatch.js\":\"279c276262fae9fe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/sources.js\":\"c23e0cc05869eb3b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/useBacklinks.js\":\"28fa8e45ad303f6f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"191849bbe28071cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/BirthdayCelebration.js\":\"432d03a11d937adc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/BirthdayOverlay.js\":\"cf84292c3a7dd75b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/gate.js\":\"a4d8195b654b5c77\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/index.js\":\"c80274edff1a6ea6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/wolfTheme.js\":\"d8bacdbf20e37fac\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/BlockDragLayer.js\":\"2c0a755bed6827ef\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/dragController.js\":\"fbebdc668fe213fa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/dropTarget.js\":\"cf5eff44e96fbf8a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/index.js\":\"0c661dd0f5d688e7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/projection.js\":\"5bc6d8a71ff35d41\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-info/BlockMetaCard.js\":\"c8e0320241713cf3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-info/index.js\":\"b840a41dd40fadee\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/AddTagDialog.js\":\"c7e71dedab47faa8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"26793670e1db2b1a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/TagNameIssueHint.js\":\"53be2644845d82ec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/addTagAction.js\":\"cb8c62713f45ac4d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/appendTag.js\":\"052ec16e8d923ea5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/config.js\":\"f7f625f6da9c640f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/dataExtension.js\":\"0a2f2fe11eec65a8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/index.js\":\"14124455527f19cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/propertyEditorOverride.js\":\"bda86b8cb190dad7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0c934a6ac0c6aacc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"7cf7dfcdb17c8890\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/Breadcrumbs.js\":\"347b4fdc70c14a05\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9ddb6f4540f4a9e2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0337d3518b2f2323\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/index.js\":\"90a012ec883594f6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ec1b5046a75ce396\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/CharacterCountItem.js\":\"07c4ced440e27b52\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3dfed6e8922b4a11\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/actions.js\":\"9678a8868f07ce2b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/blockType.js\":\"0e867ec302c7040c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/charCount.js\":\"f07abc3a8f381e76\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/dataExtension.js\":\"b259fd156aa06b7e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/index.js\":\"7e7dd8d473bd5544\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/profiles.js\":\"0582cdc5563b06dd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/properties.js\":\"419b1cdbaffaf7e6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/textCounts.js\":\"4731f60e93bccbe6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/colemak-keybindings/index.js\":\"5fa72e167b7ed5b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/CommandPalette.js\":\"794ba74834e270e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/HeaderItem.js\":\"88dacdcf03378cb9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/context.js\":\"f441ca58ce07dc3c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/index.js\":\"4819137352f824a6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/selection.js\":\"31d99506238b797b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/toggleStore.js\":\"f79f88e551277aa7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/useCommandPaletteActions.js\":\"7d314ae510c12b7d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/ContributorBadges.js\":\"97da9936e1ab7af9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/author.js\":\"b456b461f30e0c80\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/codeMirrorExtensions.js\":\"9caeabac25329f84\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/dataExtension.js\":\"fb6b8fd1ab4f1963\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/index.js\":\"f484032844d6fc2d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/mentionAutocomplete.js\":\"0222708aedc84529\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/processor.js\":\"4c86c01ede383750\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/profiles.js\":\"4cfa085b7e95ac1c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/queries.js\":\"090ff7cd4969bb09\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/schema.js\":\"a3317ec0f3e6e383\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1f634877164000b9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/followOrigin.js\":\"90ab9c67fcbea977\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/index.js\":\"74a3aa9bcc50718e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3725ea931881ac53\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"121ffd6c05e03eda\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/CalendarGrid.js\":\"d82433e6df81138b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DailyNotePicker.js\":\"7335c254877f62a8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"aca96c6540e4863b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateNavDecorator.js\":\"c64e142f8bd30c40\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateScrubOverlay.js\":\"57cc8dc0452c2a53\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/HeaderItem.js\":\"c35cee505e36db97\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/ReschedulePicker.js\":\"92e46df54037bae0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/SpreadDatesDialog.js\":\"3befd991fc0dd6fa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/actions.js\":\"e3196572a99bb7ec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/blockDateAdapter.js\":\"dc13cf7ecd8e79b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/calendar.js\":\"150172cc1f397ca0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dailyNotes.js\":\"dfd00f82c293098b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dataExtension.js\":\"aa83a646f43b44c1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubActions.js\":\"8b0b14e6a38bbd2b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubGesture.js\":\"eb26cf9eb911d39a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubGestureActions.js\":\"22f538c1f4f79b8e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubRecognizer.js\":\"96bebe3082163d11\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/deletionGuard.js\":\"f1e3859a94037fcc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dueQuery.js\":\"3f6f6e59ba82d053\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/index.js\":\"3666daa0217c6a37\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/landing.js\":\"81e9edcea541cba3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/localSchema.js\":\"ff3dc8e484f46033\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/referenceDateAdapter.js\":\"7eba22788e78adf8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/rescheduleAction.js\":\"a1c3c067b86146be\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/schema.js\":\"5a97df1162a990ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/spreadBlockDates.js\":\"9b189a109d6fbc22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/spreadDatesAction.js\":\"f226fbb7d80aadf2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/today.js\":\"441b3b5895c1e805\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"68519adb7c8fc002\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7e0d3a124e18797a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/audit.js\":\"0a558c1c99a3a225\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/auditAction.js\":\"fbb6470a1e1c2e44\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/auditRanges.js\":\"c5a1b755cae275c1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/diagnosticsSource.js\":\"134ea7a3b0f9c34f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/divergenceScan.js\":\"72ffa055356439a5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/index.js\":\"e2f56d5e19bb8657\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/propertyChildrenChecks.js\":\"95e6fd46dad9a607\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/referencesMirror.js\":\"e26e28df7640ad97\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/rowJson.js\":\"adc331c31f4df41d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/schedule.js\":\"73134f489d7aa612\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/store.js\":\"8f4e7c478d3a5590\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/action.js\":\"95bb86c1548b416d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/index.js\":\"5c538116ca3e6cf2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/plugin.js\":\"5bc1715c5c03ca02\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"47423673e82fa35e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/actions.js\":\"cc523988a10453cf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/changeMarker.js\":\"a5834098644603c1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/diagnostics.js\":\"9099ea62bc0b4811\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/fileSystemAccess.js\":\"ae88cfc0287b52ed\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/filenames.js\":\"f8cd4863bd31c944\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/index.js\":\"301b703969c582a9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/mirror.js\":\"25fb2eb435667d9a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/runLock.js\":\"0c4fca0942195775\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/runtimeHealth.js\":\"4acbffc0e5f9e2fe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/schedule.js\":\"6e8054d122e6367e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/store.js\":\"0f184a545c550fac\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/default-themes/index.js\":\"0143e606544f9425\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/default-themes/themes.js\":\"d30dd03b0764e815\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/diagnostics/facet.js\":\"f05f1cc1ae15b0c3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/diagnostics/useDiagnostics.js\":\"d9b78a57be661ea6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/dismissals.js\":\"1024539d07b017cf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/index.js\":\"d190749b8c3e963d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/status.js\":\"1b276408da650b44\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/store.js\":\"51f7632ebd3bc0a5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"018a1f273a10b18c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2a596ec164adcceb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/actions.js\":\"3f89e6855b499576\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/config.js\":\"1df2c91602eab919\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/dataExtension.js\":\"6fa7fe6204c74d57\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/effect.js\":\"150d9a5215818bbf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/index.js\":\"a4d6d0c3ab6f67be\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9036071a87781384\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/useToggleTree.js\":\"01e7126d8f24d7f8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/ExtractTypeDialog.js\":\"387ce6f6a88f3c62\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"38817e4a9a43bfcd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/PropertyShapePicker.js\":\"350d18a4247d8c4a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/action.js\":\"81eb3964dc1d56bd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/index.js\":\"aeccb2a4fed32a06\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/FindReplaceDialog.js\":\"c4f75e8b5e19394c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/HeaderItem.js\":\"2a06198b32dcdd93\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/dataExtension.js\":\"032662c09cdfd004\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/index.js\":\"1c3a3deeda6f0263\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/search.js\":\"1bce8810d2e704b0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/toggleStore.js\":\"9aeee522c74c8f70\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/LocationPropertyEditor.js\":\"320305820bbeac54\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/MapView.js\":\"e94fdb485d9b001e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/blockTypes.js\":\"d8d87af876fcc292\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/codeMirrorExtensions.js\":\"8a7cc1397d04541b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/createOrFindPlace.js\":\"1c69a10a640c7f19\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/currentLocation.js\":\"a1d87f194620c63d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/dataExtension.js\":\"2d5ac01f61e2ca5c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/geoContentDecorator.js\":\"8f8bbafcc140b1cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/googlePlacesClient.js\":\"52fd73fef1036f44\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/index.js\":\"5f44a58528b5a3f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/locationsPage.js\":\"27aa4c8fe3683dbb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/mapViewport.js\":\"7031ad9b4916fe0f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/pickCurrentLocation.js\":\"58bc0a2523153d56\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/placeAutocomplete.js\":\"40d6a2d8e81253cd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/placeNameCollision.js\":\"6c4c786897766806\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/properties.js\":\"50e792b78a277ba7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/propertyEditorOverrides.js\":\"4d7ab168ac2597ff\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/query.js\":\"add4676f52dfbb67\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/usePlaceSearch.js\":\"dd8e23bc1bf2559b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"cd53a448665479bb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"212b8444ddc8f6b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"019ae424886208f8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/config.js\":\"53ced5560ad08185\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/dataExtension.js\":\"4989b6436ee5ec2f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/facet.js\":\"5dd8b66aedf1da28\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/grouping.js\":\"7c155182b4156ae8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/index.js\":\"63085c3ea6dd9e35\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e7d0e3f8440da45d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/query.js\":\"632eed49796cc785\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/resolveConfig.js\":\"867cf1b90730881d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ce5bd930c40a7933\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"281e4aaa7951416e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/HtmlDocumentContent.js\":\"fa4c1394728d5f39\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/HtmlFrame.js\":\"b6b90d6c142cbd46\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/actions.js\":\"c0713c71ecd1507c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/blockType.js\":\"983d66abc21cbea2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/confirmRunScripts.js\":\"f694c58ebbb4dc79\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/dataExtension.js\":\"dce5c3f8df005fc3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameAnnotations.js\":\"a2217bd42e5d121f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameDocument.js\":\"4612874810eaa97f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameTheme.js\":\"b1a6b19d1234ea39\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/index.js\":\"a28a0ef3901df273\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/scriptConsent.js\":\"e5893142ad2715ca\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/sourceMap.js\":\"cb94c43999182722\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/useDocumentScripts.js\":\"ae98c0e3df47d846\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/index.js\":\"f15fa8b9166ea7dc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/record.js\":\"c3d9cd5128cbf662\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/recordStore.js\":\"05e647fb1c885727\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/responsiveness.js\":\"6dc6c53adff37e7e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/schedule.js\":\"dd8af15fe123cdc0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/sessionContext.js\":\"347de86a034e28c2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"dc55696adb0e6f71\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a1fb1481eab18dfe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/actions.js\":\"6c3af3c1fcbbb6b0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/config.js\":\"b20f0278cb87d95a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/dataExtension.js\":\"447b3ab0225e9d95\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/effect.js\":\"c7aae7bc4544e842\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/index.js\":\"c0eb13257655664f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/keyCapture.js\":\"05351d685d6a7cd8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/overrideStore.js\":\"99d8a17851e6dcef\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"82d3fece5faf4846\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/HeaderItem.js\":\"840a55b84e3f97a8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/LeftSidebar.js\":\"fc62e00f8647c07c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/actions.js\":\"c2b52d5feae32a8d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/facet.js\":\"0a9e9dc1b4ffcbe7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/index.js\":\"d9820f44400b9cc3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/shortcuts.js\":\"31c7fee7330a1552\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/toggleStore.js\":\"3ad49d3f61c8dad7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/MergePicker.js\":\"205e4fa736aeb55e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/index.js\":\"bc93ad78b87ffdb0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/mergeAction.js\":\"73b48c50e7aabf2e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/strategy.js\":\"83cfe9b22ce6da3b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/Button.js\":\"8bd3c8272144397e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d52054c07b724538\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/defaultItems.js\":\"42db631e7050b0b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/facet.js\":\"2d67c5c2b73a802d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/index.js\":\"4f9983c96e9c7df7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b4b495e16d70046e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/actions.js\":\"bcb276ae032dc785\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d0f77be599ae6f37\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4a0948f396144b61\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/index.js\":\"18bf136317193f20\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9c2b3d33f1ce1da6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d3b3d365d0511df4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/contextMenuItem.js\":\"add0b24a0faffb54\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/index.js\":\"c514a0e45bc5c750\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/moveAction.js\":\"d8c2acc5ceb04569\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/moveBlocks.js\":\"6e9dbcde1c12aeb3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/selectionAfterMove.js\":\"0fe5b904000b91a2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/TutorialBanner.js\":\"9479376108cde27c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/action.js\":\"ff9307773a68c49f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/bannerDismissal.js\":\"8314688a19cad40d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/documents/cheatSheet.js\":\"8a944254857b0b0d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/index.js\":\"ec7a26e5644aeaec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/keys.js\":\"813dd95b53a59a78\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/landing.js\":\"47d2a7ab0c4d0768\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/outline.js\":\"fe5363c56b4ac873\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/seed.js\":\"1285580fc90baf86\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/PerfTrendDialog.js\":\"d5a28d30dea018cf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/analyze.js\":\"3554135d021d9d93\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/diagnosticsSource.js\":\"d7fe7a9dc05af70e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/index.js\":\"ae2564034b19e992\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/load.js\":\"6ca0b8aa2374ab9d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/monitorRun.js\":\"a86beba2a02123ea\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/schedule.js\":\"6221284776b2ac75\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/series.js\":\"9b3496e5b664267f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/store.js\":\"9bc91ccc0798cbda\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/trendAction.js\":\"a6fa61734110e3a4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/verdict.js\":\"76ff696dc4f646b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/clickToEditAction.js\":\"97738c99a3068bd3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/index.js\":\"30328ed6adbe6647\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/interactions.js\":\"70a33bb3e36b4147\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d20e204cc13b863a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/MigrationGate.js\":\"316c382077d45890\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/MigrationGateDialog.js\":\"3c9e5bd532173642\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/action.js\":\"765283785e15729f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/index.js\":\"81934b4f9af03fe9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/localRunMessage.js\":\"84580cea1599a18e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/plugin.js\":\"652030c31998385a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/progressReport.js\":\"584ea5a7a3d9f77c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/sweepProgress.js\":\"47b590875be550bb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/FieldRowRenderer.js\":\"412c6321d1d07a65\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/ValueRowRenderer.js\":\"451617bc4edb5b71\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/actions.js\":\"b1e0aa3e727827ff\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/autocomplete.js\":\"4c2e5cdf32b40c6a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/fieldRow.js\":\"fc1d67304de69041\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/index.js\":\"738e0a5ee859e49e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/referenceWarning.js\":\"3fb0bd0292baa4b9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/valueAutocomplete.js\":\"e4be0ea2d90d4af8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/valueSchema.js\":\"4983f6643c3e3635\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/HeaderItem.js\":\"675d6c00dde80a3e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/QuickFind.js\":\"f02270997bb10452\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/index.js\":\"48f7ecb7126ffa05\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/recents.js\":\"0412183d9135738c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/resultItems.js\":\"8b6a48260c363b3f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/selection.js\":\"f396a6d629e8be1b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/toggleStore.js\":\"02e530642fb8ea39\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/HeaderItem.js\":\"81dd2adfcfd061c0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/RecentsPageBlockRenderer.js\":\"afd779cdf8efaa94\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/grouping.js\":\"5b0f03dd2c04e905\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/index.js\":\"917dfdb551f438cd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/target.js\":\"1a5b22ba2ea6a24d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/codeMirrorExtensions.js\":\"2c5c2a62d915ef6f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/contentPrefill.js\":\"1f1763c2a49b8145\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/dataExtension.js\":\"78f184cfc0bd304d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/index.js\":\"3e2c1bcc168e6fc1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"985a5f9ef4062398\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/invalidation.js\":\"952c6ce77548993c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/localSchema.js\":\"ecb20c9cd03d8c7f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/blockrefs/index.js\":\"5d92dcec73391b0e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8f1fb92a46bf4462\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/index.js\":\"836ef5d6acfd5119\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/referenceNode.js\":\"cd7730e3fc1e9bd7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/remark-reference-occurrences.js\":\"99c7f65ecebda562\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"37b878c7d2e55059\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/index.js\":\"62db90637509513a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ce6ec72ca7826dca\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e0d0da7989ccee34\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/mergeRetargetProcessor.js\":\"a0430839995f89cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/parseFence.js\":\"f21173962aac41d4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referenceParser.js\":\"3542004b0f528e9d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referenceProjection.js\":\"3f341d1bc939f4d8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referencesProcessor.js\":\"b08450231fa3e350\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/renameProcessor.js\":\"874505ee10853bea\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/spanReplacement.js\":\"59d127daa3d9205b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/htmlToOutline.js\":\"578561526e76a4df\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/index.js\":\"ee0a1f2fa803f6e6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e47116f016251abf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/pasteDecision.js\":\"bc78c4f2de650a5d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/action.js\":\"f9c6a33c84e48467\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/blockIds.js\":\"665c46c3a2e7f845\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/content.js\":\"60923354a413ccd6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/effect.js\":\"2e0ad19faae265c9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/ids.js\":\"34d2250283459515\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/import.js\":\"3ce352fa7da8e2fc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/index.js\":\"ae45f401e12db1a8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/plan.js\":\"c9d80efda4a96a68\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/plugin.js\":\"dd91c67672b2f5e2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/promotion.js\":\"fbd3d44f324c2006\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/properties.js\":\"dbc232997694428d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/references.js\":\"fd477347a7c8cf47\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/report.js\":\"e865767f90cef543\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/roamMemo.js\":\"ce56d20576505166\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/runtime.js\":\"da8c5c9a627388fa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/schemaReconciliation.js\":\"aeca02bf5040f2cd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/srsMarkers.js\":\"8ba2301876b0bea9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/todo.js\":\"9f046b581c14435c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/typeCandidates.js\":\"1dcc30c9b5bc84fa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/types.js\":\"3438e1d82fab01fc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/search-health/index.js\":\"802d262a735d114a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/search-health/store.js\":\"b9641915b6f01c7d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/HeaderItem.js\":\"c716f3ad8792adae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"26aa90f94f3a1c10\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/index.js\":\"b8afa2fb16a78527\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/model.js\":\"a227287495d02164\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/toggleStore.js\":\"c3f4b690a790809f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/useKeyInspector.js\":\"e015d741cf5e96e4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8d84c835a7436cd2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/ShellDecorator.js\":\"70c248cc067736c6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/actions.js\":\"59b51d416ad17670\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/exclusionsFacet.js\":\"93cd69c33e178404\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/index.js\":\"2de81e67c18822bb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/shell.js\":\"5d71f57245e0d5f3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/surface.js\":\"1803e9443bdf53d3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/walker.js\":\"ea34ee091f8972ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f3ab520aa66645e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/dataExtension.js\":\"a616f3917775e5e8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/index.js\":\"47e5806f866c29a9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/indicator.js\":\"4e0cf9b086ffe650\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/moveSrsState.js\":\"8863af3c268c1775\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9b3e22ec48c2b6e7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/scheduler.js\":\"469a003caeb5dfd3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/schema.js\":\"6d49819e7ac077e3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d0f759974fb5af17\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/srsClipboard.js\":\"060b4f4051d1c1b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1d28e75859520b58\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7b8023fe4044ac33\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/DeckPicker.js\":\"43103ed83a977866\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewControls.js\":\"6c820c5092a80854\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewDeckRenderer.js\":\"30e703e6ba891df5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewSession.js\":\"bccc9835c502be09\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/actions.js\":\"176a65c4bf69200b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/archive.js\":\"d61b7e926213a953\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/dataExtension.js\":\"0f5362ad2bbca9da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/deck.js\":\"928da0fd89a8fa02\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/dueQuery.js\":\"021862d101e99cbe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/gradeDecision.js\":\"7a318dd51ec1faff\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/index.js\":\"01a3b4b65efb62bc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/keyHints.js\":\"02a350b4f1e0d424\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/reviewCardLayout.js\":\"6ba156230bb4e1f7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/reviewProgress.js\":\"abcc4d9fc88f4151\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/schema.js\":\"6de3364fa7f228b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/useDueCards.js\":\"82729dc29c4ffa29\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/startup-metrics/index.js\":\"9dcb58161065ab67\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/startup-metrics/record.js\":\"9a8e437a9edf6c34\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/index.js\":\"dc572896afdb6d0c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/persistenceStatus.js\":\"ed2cc6aeadf3d0b0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/requestAction.js\":\"82af0827b5c39d60\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/TypeChipsDecorator.js\":\"8339e3c64a95cd5a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/codeMirrorExtensions.js\":\"1e835ed6befdbbcf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/index.js\":\"8b525db5b6c60896\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/typeAutocomplete.js\":\"a7070a25e615915a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6e2e2e9f0a02f3c7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/actions.js\":\"7efaa721e3814b36\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/anchor.js\":\"142ab4840b3caa99\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/events.js\":\"23a9beac4f83c10f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/gestureActions.js\":\"c45ec256d4ba4b36\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/index.js\":\"ec53b2873725ebd2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b602e2efd300c29a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/collect.js\":\"0aa6107db820ab92\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/index.js\":\"b6f57743e2a7f099\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/record.js\":\"6c2e3dabd8c19586\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/RejectionDialog.js\":\"373c0c48ae3834a8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/SystemStatusHeaderItem.js\":\"39d2b04e33cbc8ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/index.js\":\"6b536f8b6c22e7bf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/model.js\":\"8dd942e6d6d1d989\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/queueCounts.js\":\"450b764d7db8b016\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/rejectedHelpers.js\":\"07b3a17b4f4366e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/rematerializeAction.js\":\"c6de45edf9860bc1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/useHysteresis.js\":\"4d7eaaf43554592e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/TableLayout.js\":\"c676b678b76f51da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/actions.js\":\"c0ed6e019aac3804\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/cellEdits.js\":\"b97db6d5e0c7fa77\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/controller.js\":\"33a54e34d25a2f09\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/convert.js\":\"6a2ab9794668d5df\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/dataExtension.js\":\"bc41c57740dbdaac\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/index.js\":\"9e9f55f387e4fd04\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/keys.js\":\"acbaa90c801ae319\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/model.js\":\"ec281d2eb5b9df2b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/registry.js\":\"483e30a1128ded99\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/schema.js\":\"f3c5e1ec016e9222\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/effect.js\":\"c977d68d147d6ae4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/index.js\":\"58f82a53510691f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/theme.js\":\"99e625ee4d3ff57b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/actions.js\":\"b857563cdd3256b2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/dataExtension.js\":\"798a2460850adc89\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/index.js\":\"ab76b9da99d7ef03\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/schema.js\":\"8be1dda61ccad17a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/TouchSelectionLayer.js\":\"87ae3ce7a8b5fb6f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/actions.js\":\"c1eb29689f4447a0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/defaultItems.js\":\"8f59ba729a19d52b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/facet.js\":\"cf84b5afa5124e84\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/holdRecognizer.js\":\"7d7eebcb873850ba\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/index.js\":\"b2b579be6d3f0e04\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/UpdateIndicator.js\":\"4406ebd559fbdcdd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/index.js\":\"d37ae963d6933ae0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/loadTimes.js\":\"2553097f319752f6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoNotesRenderer.js\":\"376a9321ab2cc15a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoPlayerRenderer.js\":\"f287e9c05bdb67a2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoTimeStamp.js\":\"28471ca702d41bcd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/actions.js\":\"922b68a90b94b0e3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/index.js\":\"7f6c17dbab78b43d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/markdown.js\":\"d96bdbb73629fe22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/notes.js\":\"3de5cb81b1962013\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/registry.js\":\"ea45443264f84387\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/remark-timestamps.js\":\"95e47244a13c56c5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/view.js\":\"bd01e2715f3a9b5b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/LinkHints.js\":\"320d6039b4f076db\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/index.js\":\"28357213b7819edc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/model.js\":\"218f87d8c4d57bdf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/settings.js\":\"cf5bfc5d85318186\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/actions.js\":\"0af44ff422fc736a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/index.js\":\"2599e9e239f19610\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/interactions.js\":\"57ab706d04557db0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/workspace-header/index.js\":\"716cf6e36faeafcd\",\"/knowledge-medium/pr-preview/pr-1813/src/registerServiceWorker.js\":\"9925285c135fc117\",\"/knowledge-medium/pr-preview/pr-1813/src/requestPersistentStorage.js\":\"5c265768778e6239\",\"/knowledge-medium/pr-preview/pr-1813/src/services/authRequestDeadline.js\":\"b889fdba6f95a5cf\",\"/knowledge-medium/pr-preview/pr-1813/src/services/authStorage.js\":\"06b677e52a455934\",\"/knowledge-medium/pr-preview/pr-1813/src/services/powersync.js\":\"4cf7a6783a99fcad\",\"/knowledge-medium/pr-preview/pr-1813/src/services/supabase.js\":\"f74e6e8f7117935b\",\"/knowledge-medium/pr-preview/pr-1813/src/services/uploadErrorClassifier.js\":\"1e21e3d6ce49338d\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/ActiveContexts.js\":\"28ec7473c759be40\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/HotkeyReconciler.js\":\"9f2d7e80f5238ea4\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/WipeLocalDataDialog.js\":\"be83b28343f6b918\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/actionDispatch.js\":\"08961a3b1e893482\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/actionRefItems.js\":\"60f2489d904ca748\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/applyKeybindingOverrides.js\":\"7adc2696128948e5\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/blockActions.js\":\"1b7689725828dffc\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/canonicalizeChord.js\":\"802cb1d49c31ba4f\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/defaultContexts.js\":\"488259802875ea65\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/defaultShortcuts.js\":\"2ec545b4bf9945bb\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/effectiveActions.js\":\"f1347735e8173160\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/gestureAction.js\":\"58afa73b70516be2\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/gestureBinding.js\":\"f56c6ad6b08e8862\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/holdRegistry.js\":\"fa54bb2c4a17e817\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/keybindingConflicts.js\":\"d1de768b2210d8b9\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/keybindingOverrides.js\":\"cae8652ba4e4a723\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/pointerAction.js\":\"26a9f9b371280179\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/resolve.js\":\"4335e2b1f92095e5\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/runAction.js\":\"51ba360fd0246be4\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/sequenceMatcher.js\":\"a3e0ea430f3acce7\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/types.js\":\"9c4771dbd24ad863\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/useActionContext.js\":\"7dd909ff309cb3bb\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/useActionDiscovery.js\":\"d8c38d27796d0b16\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/utils.js\":\"38029aa00d9e681e\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/bootStore.js\":\"1bb8c71ec435c7f3\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/previewDatabases.js\":\"b31c855c74209099\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/byteTransform.js\":\"972d38d455efa8e2\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/attachmentCleaner.js\":\"db874f2b12561ec0\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/attachmentParts.js\":\"fa6bad027872cf58\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/bundleParts.js\":\"ae4ef23e2244b796\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/bundleRecord.js\":\"0301fad822a357d0\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/manifest.js\":\"caad7e5b509491cf\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/takeBundle.js\":\"78c4f87387c5fa18\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/verifyBundle.js\":\"d86d554d19d4dfd7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/cleaningStage.js\":\"34a0c9ca225a56fe\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionKey.js\":\"1e41884694802381\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionServer.js\":\"a6be06cc477f6932\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/flip.js\":\"0024a336c8ea102c\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/flipAttempts.js\":\"bd6da8445ece44c7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/pages.js\":\"fd2f47677a4b9776\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/preflight.js\":\"093cfb3aaf6605a7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/reseal.js\":\"181022e4c4d85d19\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/runConversion.js\":\"ef0ba8724d94d250\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/runLock.js\":\"a8f648d85ea30da9\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/sealing.js\":\"7a460abada006911\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/sealingStage.js\":\"22407e2741bf4771\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/stage.js\":\"096119a0233d944b\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/verifyReseal.js\":\"ceb0bb949b53b78f\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/aad.js\":\"403a948ed1b67aa3\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/aead.js\":\"4692725c7facb7b8\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/base32.js\":\"aec525fbc6918e6a\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/base64url.js\":\"b0e52a49b5068b6b\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/binaryEnvelope.js\":\"3ff19267f6d7cc20\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/byteAead.js\":\"ea05aadd858dbefa\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/canary.js\":\"6419ac65d57e6748\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/contentHash.js\":\"75027ee79518444a\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/contentKey.js\":\"2df6ee39a9db70e0\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/derivedIdNamespace.js\":\"d28091b4b1307e9a\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/envelope.js\":\"09a020ae2e28b348\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/hex.js\":\"606fd05fec3c76ad\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/sha256Hex.js\":\"492ef8b4aaff6309\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/workspaceKey.js\":\"cd2ce255c1c31e75\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/conversionState.js\":\"68977de17c18b225\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/createEncryptedWorkspace.js\":\"fc5bcd6be7e2ec10\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/pastedKey.js\":\"e2a17c1aa8c6b28d\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e27354a295002940\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8907afbdc340dd60\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/keyStore.js\":\"3d621c8e9ec211ff\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/mintWorkspaceKey.js\":\"f4347fffd1275ba1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/modePin.js\":\"cbd9c0eed40633ff\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/openWorkspaceKeys.js\":\"abea1756c1e49c88\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/resolveWorkspaceEntry.js\":\"0e46ceaf3216070c\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/resolver.js\":\"ae5cc59dd38fdf87\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/workspaceAccess.js\":\"c8d6aa69d340c4e4\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/transform.js\":\"86092d7d3dacf695\",\"/knowledge-medium/pr-preview/pr-1813/src/themeBootDefaults.js\":\"47233793655dd80a\",\"/knowledge-medium/pr-preview/pr-1813/src/types.js\":\"7b0e5b3bb870e10d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/ClientLocalSettings.js\":\"d2f824ff69ea1fe9\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/abortableSleep.js\":\"da031838ed15c082\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/array.js\":\"80daa231a7c3af7a\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/backlinkAutocomplete.js\":\"ea431e0ef4906d95\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/blockCrumbs.js\":\"a408fb59eecaa49f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/blockrefAutocomplete.js\":\"0bbf2083eed5c1d5\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/cadencedIdleJob.js\":\"7fd03563d2bf3735\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/callbackSet.js\":\"1ecfa5672a08fb4c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/clientId.js\":\"5de52e469983e6af\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/codemirror.js\":\"f20c7f52fcf2a5ae\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/codemirrorCompletion.js\":\"d9361c80403bc9c4\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/copy.js\":\"b3f22a094a105fcb\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dailyPage.js\":\"b18f227495e2e57f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dbForensics.js\":\"9d346e4256c98003\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dbForensicsHooks.js\":\"07aa1fd276161af2\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/deleteBlockThroughUi.js\":\"f1d56e794914c04e\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dialogs.js\":\"182f0d5ad24575d0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dom.js\":\"777ebcce7f6c72f7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/downloadBlob.js\":\"42f331cf16340d80\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/exportSqliteDb.js\":\"66a0450ce339813a\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fileSystemAccess.js\":\"0f6050cbb2740af7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/flipSlide.js\":\"de80355e223df870\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fnv1a.js\":\"add4eeedc3306e27\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/formatBytes.js\":\"f10e3523941341c8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fuzzyRank.js\":\"4a74a3b65b7d2313\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/idbKeyedStore.js\":\"9bbb501c7bf611d0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/idleCallbackPolyfill.js\":\"d06e9c1b19aed738\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/keyboardAwareScroll.js\":\"17e64b2417d57c35\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/keyboardViewport.js\":\"77d078776a74005f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/lastWorkspace.js\":\"7b5d446f47a99299\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutColumns.js\":\"54ec2d4819c168f7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutSessionDom.js\":\"4e45e9fb65dd6a34\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutSessionId.js\":\"1d0f0870a6dd6c0b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/linkClickGestures.js\":\"e5a05a19ef96cff8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/linkTargetAutocomplete.js\":\"3211dccdccc1bbbd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/localDbCorruption.js\":\"2163902f86f10048\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/localDbRecovery.js\":\"2352c881fc625683\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/markdownParser.js\":\"7a4f0700d9883168\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/memoize.js\":\"3a8377380450f5cb\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/nameFieldCommit.js\":\"76e8b62eb7ac25a1\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/nameList.js\":\"6275fe9cc6f8fd8b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/navigation.js\":\"12ab8bc84f6ed716\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/omnilinerNamespace.js\":\"97d15d69168fcd9d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/opfsPageScan.js\":\"ec58fd1ce96da415\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelClearance.js\":\"528ea3ce9d6fc80d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelHistory.js\":\"ffb58148e689ac26\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelLanes.js\":\"3ef1dfbdc5cde4d1\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelLayoutProjection.js\":\"ab78e4324ba94a33\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelScrollAnchor.js\":\"3bdb68cd224b6473\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelUrlFlags.js\":\"b5fa19917c1c9249\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/platform.js\":\"f1f2696268e92e05\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/pluralize.js\":\"641230755569b8d9\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyCreation.js\":\"5ef3124776a4f1b1\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyNavigation.js\":\"4382a6156f2dcd38\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyValueContext.js\":\"77bd4ee75b1f48f9\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/react.js\":\"9946a20e0ac7fe67\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/relativeDate.js\":\"6995306ac2db8f70\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/relativeTime.js\":\"f9bb6233726f75dd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/renderScope.js\":\"e7b05726c7c603f9\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/resolvedThenable.js\":\"af0da80e08ca8942\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/routing.js\":\"dc4ce0c1c9fa570f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/safeMode.js\":\"eb41f55ad97a4b8b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/scheduleIdle.js\":\"55278290033124b0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/screenWakeLock.js\":\"2cb98ed43cdc2dbd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/selection.js\":\"5b7bddda7112d9cc\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/softKeyboardGrab.js\":\"437ca95c951e8f4d\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/startupTimeline.js\":\"2ba8e1dc67c303db\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/state.js\":\"8f838aa3a17b21c8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/string.js\":\"d15db057e807dd29\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/surfaceZoom.js\":\"8bd25fb3ba244736\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/time.js\":\"7405de595cc64f67\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/toast.js\":\"c12c0ae28c54ed62\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/toggleStore.js\":\"4f5019b6a00b28c1\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/untilStopped.js\":\"df8d2e6745a140d4\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/userActivity.js\":\"c0b489f5ea5aaee2\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/viewTransition.js\":\"962ab23b9042d35b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/viewport.js\":\"adcec5baa4431d30\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/webLock.js\":\"c2aedffa0a602fc0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/workspaceRecovery.js\":\"f22a5966de771d2c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/workspaceSnapshotStore.js\":\"5627d69ac90a93e7\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-compiler-runtime.js\":\"6ed69bab438540c3\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-client.js\":\"60842addbe918964\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-server-edge.js\":\"455990a854bac710\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-server.js\":\"955d4d54fc7ef180\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-static-edge.js\":\"d99e5a77dd4285ba\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-static.js\":\"84d71c610275931d\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-test-utils.js\":\"3ccc52e986452071\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom.js\":\"99b975a5433a0fab\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-jsx-runtime.js\":\"0aff71f93a3bc453\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react.js\":\"10604ac7fa70077a\",\"/knowledge-medium/pr-preview/pr-1813/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1813/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1813/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
