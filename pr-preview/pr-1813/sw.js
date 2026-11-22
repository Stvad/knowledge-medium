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
		buildId: "3b930a56e33e-fc5e4192",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/\":\"b75f3e64769f3bc3\",\"/knowledge-medium/pr-preview/pr-1813/index.html\":\"b75f3e64769f3bc3\",\"/knowledge-medium/pr-preview/pr-1813/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1813/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1813/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1813/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1813/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1813/assets/FacadeVFS-DqptKQz2.js\":\"95f46b73b3729c5b\",\"/knowledge-medium/pr-preview/pr-1813/assets/OPFSCoopSyncVFS-DWrQVRCh.js\":\"9542765b2928a13b\",\"/knowledge-medium/pr-preview/pr-1813/assets/OPFSWriteAheadVFS-qXL0SDci.js\":\"7d9d7719001b805f\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-DkRWO3f5.js\":\"335a715425f8ac93\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1813/assets/wa-sqlite-async-BNyZx3c-.js\":\"0f8d529e1425e26e\",\"/knowledge-medium/pr-preview/pr-1813/assets/worker-CpWaJyYn.js\":\"75ed195dfd8be54b\",\"/knowledge-medium/pr-preview/pr-1813/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1813/chunks/app-B1afHoXo.js\":\"5e039f037978e780\",\"/knowledge-medium/pr-preview/pr-1813/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1813/index.js\":\"7d32ba1b22cf6576\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1813/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1813/assets/AccessHandlePoolVFS-BmzakT7G.js\":\"2f4735be59f7e1b3\",\"/knowledge-medium/pr-preview/pr-1813/assets/IDBBatchAtomicVFS-IxpsWMkg.js\":\"b487e505c571d029\",\"/knowledge-medium/pr-preview/pr-1813/assets/MemoryVFS-CbEWh_qs.js\":\"96500bbc1012a33c\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-Dxll-p-p.js\":\"4f2fba122ab9c924\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-async-CPZnHa44.js\":\"9165a68bdbe1573b\",\"/knowledge-medium/pr-preview/pr-1813/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1813/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1813/chunks/AccessHandlePoolVFS-CMZPAoco.js\":\"607cf6685e4b9313\",\"/knowledge-medium/pr-preview/pr-1813/chunks/FacadeVFS-ChSlzvfv.js\":\"b3b516a050a6e7a6\",\"/knowledge-medium/pr-preview/pr-1813/chunks/IDBBatchAtomicVFS-Cy6-9K91.js\":\"2a13f90b6d7a8a7a\",\"/knowledge-medium/pr-preview/pr-1813/chunks/MemoryVFS-BWIm_lY3.js\":\"1159d39765f98bb5\",\"/knowledge-medium/pr-preview/pr-1813/chunks/OPFSCoopSyncVFS-Dd2Lflt8.js\":\"56df764a8ed7a3b2\",\"/knowledge-medium/pr-preview/pr-1813/chunks/OPFSWriteAheadVFS-DRNwNbNj.js\":\"fcc02ae8275a6a30\",\"/knowledge-medium/pr-preview/pr-1813/chunks/Preview-Cu6laJtw.js\":\"7ba46422cca177e0\",\"/knowledge-medium/pr-preview/pr-1813/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1813/chunks/card-C1lKckSp.js\":\"46222d7590a3213d\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-B47A18NM.js\":\"c66b1af93d879f33\",\"/knowledge-medium/pr-preview/pr-1813/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1813/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1813/chunks/mc-wa-sqlite-BmNj0rcl.js\":\"e690251c11187835\",\"/knowledge-medium/pr-preview/pr-1813/chunks/mc-wa-sqlite-async-Dk7WNHJg.js\":\"427abd5c49fe3ee0\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-B3ZJkBTo.js\":\"e5118686242cc8ad\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-BCDww6O2.js\":\"2a05ca999c02ed5c\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-BUq44YSS.js\":\"15a605ab1c1da9fd\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-Bfn4_63E.js\":\"48bbe81fa28fbd88\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-BjnO7Dhh.js\":\"bd49bd28f81e89da\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-C1ZLKOil.js\":\"4feea297a176b8db\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-DQ4lImdG.js\":\"0ec420f4ef747755\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-DsDQ74UD.js\":\"ffe18e189ad90092\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server-legacy.browser.production-BPpzcu75.js\":\"125d06381c48dcdf\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server.browser.production-CkBiIjwe.js\":\"1e676853b15b2f52\",\"/knowledge-medium/pr-preview/pr-1813/chunks/react-dom-server.edge.production-DdFd1IXq.js\":\"1abe96b6346dc82b\",\"/knowledge-medium/pr-preview/pr-1813/chunks/server.browser-BrzsOm9N.js\":\"239b22a618a876e0\",\"/knowledge-medium/pr-preview/pr-1813/chunks/textarea-DHtrWcg8.js\":\"152e52c89005bdd1\",\"/knowledge-medium/pr-preview/pr-1813/chunks/ui-DjgaPd2Q.js\":\"4c963c5c6a74e9e0\",\"/knowledge-medium/pr-preview/pr-1813/chunks/wa-sqlite-CUTh2Sb_.js\":\"24b71e151d88d5ac\",\"/knowledge-medium/pr-preview/pr-1813/chunks/wa-sqlite-async-CSMaBvuG.js\":\"01187ce2443d7ce6\",\"/knowledge-medium/pr-preview/pr-1813/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1813/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1813/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1813/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1813/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1813/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1813/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1813/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1813/src/App.js\":\"742713bdae4066af\",\"/knowledge-medium/pr-preview/pr-1813/src/appUpdate.js\":\"751e91ecba126670\",\"/knowledge-medium/pr-preview/pr-1813/src/appVersion.js\":\"8f710e144e964af6\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/initialLayout.js\":\"d05a7424c1cc4498\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/openWorkspaceData.js\":\"3116e23ffb1dd974\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/resolveWorkspace.js\":\"5b947b31b48d9b44\",\"/knowledge-medium/pr-preview/pr-1813/src/bootstrap/workspaceBootstrap.js\":\"6b0e9cb9d5fd2735\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockComponent.js\":\"9360bb674aa3ce73\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockCrumbs.js\":\"24807839c7a7dd80\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockEditor.js\":\"40e08626f2abb294\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockLoadingPlaceholder.js\":\"9fb3e8279d4501e9\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockProperties.js\":\"a832357daa94e522\",\"/knowledge-medium/pr-preview/pr-1813/src/components/BlockSearchPicker.js\":\"519b4a10159132c5\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ConfirmBulkDeleteDialog.js\":\"a74812dfa05d9fb6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/DividerHandle.js\":\"07156bacf41d7b1f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/DraftEditor.js\":\"53fbfe31cd5ba147\",\"/knowledge-medium/pr-preview/pr-1813/src/components/GutterPill.js\":\"f16a52876b63999e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/Header.js\":\"ed2a8f81d75ff904\",\"/knowledge-medium/pr-preview/pr-1813/src/components/LazyBlockComponent.js\":\"fe66064367030416\",\"/knowledge-medium/pr-preview/pr-1813/src/components/Login.js\":\"240d5297ac99bb87\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ZoomableSurface.js\":\"d993b57f8908c9be\",\"/knowledge-medium/pr-preview/pr-1813/src/components/editModeKeepalive.js\":\"db9f1d44c7ad7b0f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyDisplay/PropertyDisplayScope.js\":\"54b55b289f2ea595\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ebf71dcdf7c6c3de\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/RefPropertyEditor.js\":\"cabbd9a40699d51f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/RefTargetTypePicker.js\":\"69b3320da76e4828\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/SelectPropertyEditor.js\":\"b7333216e45bf82f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/TypesPropertyEditor.js\":\"515a4f0a364a4766\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/defaults.js\":\"af80324808bf0d48\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/kernelValuePresets.js\":\"d3149c610bd464e0\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/selectablePresets.js\":\"245d67eb0a7af961\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyEditors/typesPropertyUi.js\":\"ab2d423ea3ff58d9\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/AddPropertyForm.js\":\"6e321c83b25ac521\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/PropertyPicker.js\":\"9d385eddbbc74108\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/PropertyRow.js\":\"956e591dde2d351f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/Rows.js\":\"e051b7d849490a7c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/actions.js\":\"923ab191cb981a59\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/declarationOnly.js\":\"1df12e8e3ea65aff\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/layout.js\":\"87fc41f5566cc58e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/model.js\":\"58bdc7955cb08c11\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/shapeUi.js\":\"be4bb88433670617\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/shapes.js\":\"d9c974d52fae93fd\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0930623db52f76f6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanel/visibility.js\":\"0207a78e13ef67b0\",\"/knowledge-medium/pr-preview/pr-1813/src/components/propertyPanelSections.js\":\"3ab967b0d8ede4a8\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockEmbed.js\":\"06c873621856e78a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockLink.js\":\"ab70ffdaa53c3ca6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/BlockRef.js\":\"40de4e86b291d223\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/ReferenceLink.js\":\"912007c0b03e72b5\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/cycleGuard.js\":\"5050e62efba27850\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/cycleGuardContext.js\":\"4d6fe8e240a38ea6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/linkInteraction.js\":\"b5bdac22c9741f66\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/referenceLayout.js\":\"70eab359167df3bf\",\"/knowledge-medium/pr-preview/pr-1813/src/components/references/useBlockRefAncestors.js\":\"118b444892662aa7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockGutter.js\":\"784beb4db616a99a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockInfoDialog.js\":\"dce58210c0b30288\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BlockTypeBlockRenderer.js\":\"24eedece20285fae\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/BulletHoverCard.js\":\"8c3e0e608a616451\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/CodeMirrorContentRenderer.js\":\"cf138425e27033eb\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6b45111bd0be9592\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/ColumnResizeHandles.js\":\"4a2b0a0f5441acd1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"470778724d169d88\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/DefaultBlockRenderer.js\":\"096c5f1e2ad57778\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/LayoutRenderer.js\":\"fd0cc1de579db7be\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/MarkdownContentRenderer.js\":\"6ba8787512f6000c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/MissingDataRenderer.js\":\"df09f9fb427ca2b1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/PanelRenderer.js\":\"79cb4750d24a3185\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/PropertySchemaBlockRenderer.js\":\"5d4cecbda87e2753\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/TopLevelRenderer.js\":\"6e0f3b85ce9274fb\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/blockGutterMode.js\":\"e1091d3b47faa824\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/blockTitleText.js\":\"103036b40e27e606\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/fieldCreationKeydown.js\":\"8adabaa209fab4b7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/renderer/layoutRootContext.js\":\"487dd9e9c8570e14\",\"/knowledge-medium/pr-preview/pr-1813/src/components/typeChip/TypeChip.js\":\"3d51578b74ff2de1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/typeChip/chipStyle.js\":\"fba8e7a95c56137e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/anchored-floating.js\":\"2a12e91f1090d685\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/button.js\":\"7e2bcd789276d3bb\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/card.js\":\"a2e775cb47a69a45\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/checkbox.js\":\"3c6d11742f349190\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/collapsible.js\":\"21129e04b6187085\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/command.js\":\"636f159fc6f7ab23\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/context-menu.js\":\"3f4f5f958358f7ac\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/dialog.js\":\"21d7c8210938026b\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/dropdown-menu.js\":\"d96d592e177e94f7\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/floating-listbox.js\":\"9d9da1caf011d9bc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/index.js\":\"bfd18000a8769610\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/input.js\":\"3adc6a1924080e93\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/kbd.js\":\"f5c262de5a05ba87\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/label.js\":\"8ccd9342fd413b2a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/ui/textarea.js\":\"14f3e37ea9fcf9fc\",\"/knowledge-medium/pr-preview/pr-1813/src/components/useEditModeYieldKeepalive.js\":\"c5120c9fb3059a5c\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/BootFallback.js\":\"474ede074e857a95\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/FocusedRowLazyMount.js\":\"3bdef90b483b0da0\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/LazyViewportMount.js\":\"760b26d823cf1c5b\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/LocalDbCorruptionFallback.js\":\"3ce7581b468195ac\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/error.js\":\"3933ffe4d350b66a\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/lazyMountRegistry.js\":\"9bf4bf5c3f3e2acd\",\"/knowledge-medium/pr-preview/pr-1813/src/components/util/suspense.js\":\"e534508c7abaabda\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/CreateWorkspaceDialog.js\":\"409f59124eb6721d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/PendingInvitations.js\":\"8bd4626dd212ffb5\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/SyncProgress.js\":\"876e74522bcf8481\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/UnlockProgress.js\":\"bfdc11f8a2f0ff92\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceKeyGate.js\":\"1c13ed9c3e54736f\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSettingsDialog.js\":\"86f195de7aa4d588\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSwitcher.js\":\"4ab01dc1c344d68e\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/WorkspaceSyncGate.js\":\"e119650852b230a5\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/ConversionFlow.js\":\"8335d83e86c1f137\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/ConversionFlowHost.js\":\"71f56120c5c2a9f2\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/EncryptionSection.js\":\"179f6a64b7fa2af6\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/attachmentPrompts.js\":\"664d393a3ca88274\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/bundleFolderPrompts.js\":\"fc7998c11c9d3bc8\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/conversionFlowDeps.js\":\"83b640ca68309c2d\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/conversionFlowStore.js\":\"eddc52a9746a0fe1\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/flowUi.js\":\"1a9197b57ee48637\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/conversion/useConversionRun.js\":\"3f76e364586663ee\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/keyUi.js\":\"d7a4c18cd9e14bac\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/useCloseOnKeyLoss.js\":\"adb3b89841c36035\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/useCloseOnServerE2ee.js\":\"7c34707c9d34fff5\",\"/knowledge-medium/pr-preview/pr-1813/src/components/workspace/workspaceUnlocked.js\":\"54dcbe699d8b35d4\",\"/knowledge-medium/pr-preview/pr-1813/src/context/backgroundSubtree.js\":\"efdc03fbad77162e\",\"/knowledge-medium/pr-preview/pr-1813/src/context/block.js\":\"f39c3a5d06d47df2\",\"/knowledge-medium/pr-preview/pr-1813/src/context/layoutWsContext.js\":\"9565a02184a468b2\",\"/knowledge-medium/pr-preview/pr-1813/src/context/propertyDisplay.js\":\"707b6a40ef831392\",\"/knowledge-medium/pr-preview/pr-1813/src/context/repo.js\":\"f8cb134e3a39309f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/aliasClaim.js\":\"1c8f856034701973\",\"/knowledge-medium/pr-preview/pr-1813/src/data/aliasSeatNamespace.js\":\"25b853981b48aa62\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/blockData.js\":\"aed4354bf5e30114\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/blockType.js\":\"42a0d89b3946e70e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/changeScope.js\":\"20996d33f249aa2b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/codecs.js\":\"ebe2d9595685c008\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/derivedData.js\":\"4aca31b82f86b2ff\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/errors.js\":\"55338b28c691e013\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/events.js\":\"d4b8a8807931ee48\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/handle.js\":\"07a0c4f1e6e61943\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/index.js\":\"62e7943428d248d3\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/mutator.js\":\"31eb22e3265a6f9b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/processor.js\":\"b3cb424bed2e96a5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/propertySchema.js\":\"d6775eb8ddf6d0b5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/query.js\":\"e2ecc93b904d2f3d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/sameTxProcessor.js\":\"4d2703f50ce72110\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/schema.js\":\"07a0c4f1e6e61943\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/tx.js\":\"07a0c4f1e6e61943\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/typedBlockQuery.js\":\"34423ecbd3b23b33\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/user.js\":\"a5a8ca43d729a1d1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/valuePresetCore.js\":\"a762fb548734ab8e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/api/valuePresets.js\":\"14436a948bc5527f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/attachmentCleanerIOVerb.js\":\"382be5c8470f1cc6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/block.js\":\"9de66a6ced81053b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockCache.js\":\"129ad766d76e4e4c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockId.js\":\"ebb20d519353234c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockLiveness.js\":\"943c0b75e887565e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockMerge.js\":\"b30e143f62cd77a5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockSchema.js\":\"c912a435f1d8758e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/blockTypes.js\":\"3e1a32d2431a0113\",\"/knowledge-medium/pr-preview/pr-1813/src/data/clientContext.js\":\"a7d274664a5d29b0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/dbFileSiblings.js\":\"e1d840fc38be4e55\",\"/knowledge-medium/pr-preview/pr-1813/src/data/definitionSeeds.js\":\"0ac40f1958b5d7a2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/derivedIds.js\":\"8eb76600afd1c4ca\",\"/knowledge-medium/pr-preview/pr-1813/src/data/drawnSubtree.js\":\"0a0287c5100a47a6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/facetBridge.js\":\"6c03e8a9fe7ff7cb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/facets.js\":\"98edb09c38e9da78\",\"/knowledge-medium/pr-preview/pr-1813/src/data/globalState.js\":\"7b1c7bba5ddc8a0f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/aliasClaimRederiveProcessor.js\":\"f991a4348a07e5a7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/ancestorBatch.js\":\"2018402d31d9afa2\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/blockTypeTypeifyProcessor.js\":\"b32265000553e54c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/clientSchema.js\":\"7fcfb9b1e15d7433\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/commitPipeline.js\":\"ca09b048ad73f63e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/devAssertions.js\":\"527d56486b6e11b0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/firstSync.js\":\"20d98aef2850830c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/freshInitialLoad.js\":\"2ae5ad766a979405\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/graphBackfillClaim.js\":\"ce2553de9f4433c9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/handleStore.js\":\"84d4270631244ead\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/idleMarkerJobs.js\":\"5ee2d37940f47d67\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/initialDownload.js\":\"832b518089eb12f4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/initializeClientDatabase.js\":\"0e6ef93784ee170e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/jsonCanonical.js\":\"0a3c04837bd9a18f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelInvalidation.js\":\"11750da2beead568\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelProcessors.js\":\"5acd3003d18d99f8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/kernelQueries.js\":\"c2941de24543cc1f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/mergeTypeMembershipProcessor.js\":\"1b43b63858607761\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/normalizeReferencesProcessor.js\":\"d431872099eac541\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/poolInstrumentation.js\":\"c4120edd8614b734\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/processorRunner.js\":\"b24d85423257319d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyCellBackfill.js\":\"7279f6d4989c93dc\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyChildMint.js\":\"b595deea29a086cb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyChildrenProcessor.js\":\"9863273c19e450af\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0ee7bb09a38c02bf\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyDefinitionSynthesis.js\":\"fd7a9715d26075d6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyKeyScan.js\":\"330717a5c4f4ab2a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertySchemaResolution.js\":\"03b36ee1c8861eca\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/propertyValueEdits.js\":\"168e4c37e628cec6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/raiseProtocol.js\":\"0c20b56a60f14a36\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/readBatch.js\":\"b7be99c3b45c12d3\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/refProjection.js\":\"7006073372026f5a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/referenceTargetLookups.js\":\"a319d42ed99f7814\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/referenceTargetProcessor.js\":\"6bc24b16c6c29802\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/replayMerge.js\":\"28f21a2c1636ef32\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/sqlBinds.js\":\"dcbb637e150004be\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8aa8644ab6463cc8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/arrivalProcessors.js\":\"58fa62ef4e70fbea\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/invalidate.js\":\"8d0fcbc4443be497\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/materialize.js\":\"fc93f41d712e62db\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/observer.js\":\"2eb8da8387dbd70b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/syncObserver/reconcile.js\":\"028da5e20cba2b5e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/timingMetrics.js\":\"509ec89bba3acc3c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/treeQueries.js\":\"d5b501990d4724f9\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/txEngine.js\":\"2653786c5ab5b647\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/txSnapshots.js\":\"e044113e8a855c69\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/typedBlockQuery.js\":\"ed0ea9a8df7ed915\",\"/knowledge-medium/pr-preview/pr-1813/src/data/internals/undoManager.js\":\"f00bdb37c229e853\",\"/knowledge-medium/pr-preview/pr-1813/src/data/invalidation.js\":\"9ce93107d86b6f0e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelDataExtension.js\":\"4a31ed6921636bab\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelPage.js\":\"401668ae00704627\",\"/knowledge-medium/pr-preview/pr-1813/src/data/kernelValuePresetCores.js\":\"6768dfbb1f13209c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbCorruptionSignal.js\":\"d4f340e74a07bf9e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbStorage.js\":\"9657cbd2e2148309\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localDbVfs.js\":\"165a50d698e56510\",\"/knowledge-medium/pr-preview/pr-1813/src/data/localSchema.js\":\"8b8415c0972d722b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/maintenance.js\":\"0261d8e347ff406c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/mergeProperties.js\":\"e81e893cacb1dddd\",\"/knowledge-medium/pr-preview/pr-1813/src/data/metricsConsoleHook.js\":\"110b6e6c147cfdfb\",\"/knowledge-medium/pr-preview/pr-1813/src/data/migrationsPage.js\":\"5af96e37cc9790a4\",\"/knowledge-medium/pr-preview/pr-1813/src/data/mutators.js\":\"146acb0fffcea47b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/orderKey.js\":\"b88945e500953b1b\",\"/knowledge-medium/pr-preview/pr-1813/src/data/orderKeyPlacement.js\":\"301c5dcdaa9b8388\",\"/knowledge-medium/pr-preview/pr-1813/src/data/outlineSurface.js\":\"17dbbdad32671f2d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pendingEditorContent.js\":\"6b3339941c621cf0\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pendingUploadsSql.js\":\"3a2f36a8abc44ca5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/pluginStateExtensions.js\":\"864061b109c52c3a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/powerSyncLogger.js\":\"7450d9daca77b535\",\"/knowledge-medium/pr-preview/pr-1813/src/data/projectorRuntime.js\":\"d13b5ac3cf530959\",\"/knowledge-medium/pr-preview/pr-1813/src/data/properties.js\":\"0ab512138956b10d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertiesPage.js\":\"916a673cd774a0ed\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyChildren.js\":\"3ae17bfc04ef7178\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionFanout.js\":\"b48fda3ccc012242\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionMetadata.js\":\"d6ca57d88b22ec68\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDefinitionRegistry.js\":\"9edc282dd3cdca67\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyDisplayMode.js\":\"c1edc3138d900ee6\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertyRowCreation.js\":\"d709e8c2ed194a5c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertySchemaCreation.js\":\"cc9d1440614cced1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/propertySeeds.js\":\"5e7aaa5b0d3a8724\",\"/knowledge-medium/pr-preview/pr-1813/src/data/recentsPage.js\":\"f6c21e6eed3ea962\",\"/knowledge-medium/pr-preview/pr-1813/src/data/referenceBlock.js\":\"6450cca4e16c3332\",\"/knowledge-medium/pr-preview/pr-1813/src/data/rejectedUploads.js\":\"227cec83f6098920\",\"/knowledge-medium/pr-preview/pr-1813/src/data/releasePowerSyncConnection.js\":\"f1dff85755ced7df\",\"/knowledge-medium/pr-preview/pr-1813/src/data/repo.js\":\"2b8141a34e844d37\",\"/knowledge-medium/pr-preview/pr-1813/src/data/repoProvider.js\":\"29f0c68002c67536\",\"/knowledge-medium/pr-preview/pr-1813/src/data/rowProperty.js\":\"174ac672b3e4c9b8\",\"/knowledge-medium/pr-preview/pr-1813/src/data/searchFilter.js\":\"de02f9fbad685dda\",\"/knowledge-medium/pr-preview/pr-1813/src/data/seedIdentityLedger.js\":\"4e3a9e749f4bdf3d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/stateBlocks.js\":\"f93aaf9cf56f8ab7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/structuralEditPolicy.js\":\"3d6a7ae34bf80afe\",\"/knowledge-medium/pr-preview/pr-1813/src/data/subtreeDelete.js\":\"2a7cbe7253fd95f3\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncStreamLock.js\":\"f36d8bfc5b5a1c2a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncedTableSqlRecognizer.js\":\"f7f02284779fca27\",\"/knowledge-medium/pr-preview/pr-1813/src/data/syncedTableWriteGuard.js\":\"f1d798ca1e1b497e\",\"/knowledge-medium/pr-preview/pr-1813/src/data/targets.js\":\"4c25334526b67527\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeColors.js\":\"ac6bf6532eba0f85\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeDefinitionMetadata.js\":\"72d87460aed98335\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeDefinitionRegistry.js\":\"d875621ef8459c13\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeExtraction.js\":\"a70f2eec948ce877\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeInitialValues.js\":\"ec6d5e5a0ba76f64\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typePropertyGroups.js\":\"d5f145c2bfafd2a5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeSeeds.js\":\"d34393ed411b3019\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typeTagger.js\":\"238efca566708e96\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typedRecords.js\":\"602604cc20fc4f32\",\"/knowledge-medium/pr-preview/pr-1813/src/data/typesPage.js\":\"8bac38fd24f75c83\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userPrefs.js\":\"234a5f1ebc1e70d7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userSchemasService.js\":\"22304adb6ba62dd7\",\"/knowledge-medium/pr-preview/pr-1813/src/data/userTypesService.js\":\"5f4a18c016b39079\",\"/knowledge-medium/pr-preview/pr-1813/src/data/valuePresetRegistry.js\":\"f69bc9b2e4e44a9f\",\"/knowledge-medium/pr-preview/pr-1813/src/data/visibleChildren.js\":\"46ef3eb2c56477a1\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceConversion.js\":\"124ade1e04ac076a\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceFirstSync.js\":\"cb1bba96bdd22c98\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceIdNamespace.js\":\"5cb5d6b540929e6c\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaceSchema.js\":\"2d15aaeca44bf0a5\",\"/knowledge-medium/pr-preview/pr-1813/src/data/workspaces.js\":\"02d37f1d0540c54d\",\"/knowledge-medium/pr-preview/pr-1813/src/data/writeAheadLog.js\":\"8991ef4b0bdc7573\",\"/knowledge-medium/pr-preview/pr-1813/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/BlockPasteShellDecorator.js\":\"79457c06cf6edec0\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/atTrigger.js\":\"41a69f8ea4b44353\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/autocomplete.js\":\"41424c6338c38634\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/codeMirrorExtensions.js\":\"5b4acd6b9d81b287\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/contentFlush.js\":\"8d66992982e50440\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/defaultInteractions.js\":\"5945ee5bf82728e9\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/editSettleSignal.js\":\"6972e50dc13e0b52\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/insertImage.js\":\"a3cbab70ada34764\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/referenceCompletionRange.js\":\"30c9b925d697850c\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/referenceTargetTypes.js\":\"5703ceed1523a16e\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/syntaxContext.js\":\"c3db6777f6485a4b\",\"/knowledge-medium/pr-preview/pr-1813/src/editor/triggerMatch.js\":\"bd690d23c19d26ba\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/AppRuntimeProvider.js\":\"fdd68baf69713cbf\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/BlockFocusShellDecorator.js\":\"61aff4bcfe152087\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/ExtensionRenderBoundary.js\":\"1da0f64332dd2597\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/PanelContentRecovery.js\":\"2ea48e396bf06a88\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/apiCatalog.js\":\"dccdb5a7ac98d889\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/approveExtensionHere.js\":\"5a2a903297011516\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/armedCutAppMount.js\":\"35828d8b0bcb948d\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/batchableKeyedStore.js\":\"89211a2261eae215\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/blockInteraction.js\":\"2494353bfb045894\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/blockSelectionAction.js\":\"d0c893bce568ca00\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/compileExtensionModule.js\":\"db312acc0b998143\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/compiledModuleCache.js\":\"f77be8f08f61d7fd\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/continuousGestures.js\":\"5d4b464c65830efd\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/core.js\":\"ed7cbe8141f868eb\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/defaultRenderers.js\":\"617f6864bd35edf2\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/definitionFanoutAppMount.js\":\"0720e8f7f1bd933b\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dialogAppMount.js\":\"89c588f0e8fd797b\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dynamicExtensionSeeds.js\":\"b9be2287c77b034e\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/dynamicExtensions.js\":\"8b21254aeed7bbf7\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/exampleExtensions.js\":\"9d9dd827425303bd\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionApprovalStatus.js\":\"0b176d051bbdb5b9\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLoadErrorToast.js\":\"e87b58deefe49f25\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLoadErrors.js\":\"6aa2ef6cc669cbdf\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionLookup.js\":\"e4056cfaff1f53d3\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionToggles.js\":\"dda5eb884dc82170\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/extensionUtilitiesCss.js\":\"459dd9b1306269f8\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/kernelPageDeletionGuard.js\":\"9c5989bc9883766d\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/liveRuntime.js\":\"18d073ff12cc05f6\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/openExtensionsSettings.js\":\"f0f4ac0d0ba56ea6\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/overridesCache.js\":\"9f03a06f61765b0e\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/pluginIds.js\":\"7caa81f8360c79f9\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/processorRejectionToast.js\":\"d059db2c382f8119\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/runtimeActions.js\":\"4b56f9d533d4046a\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/runtimeContext.js\":\"8c24365213bb5283\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/staticAppExtensions.js\":\"1dfac98eb1e6bb84\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/staticDataExtensions.js\":\"084b9f532b5a6594\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/toastAppMount.js\":\"398cd7827949128d\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/useOverrides.js\":\"00031b2914e9c367\",\"/knowledge-medium/pr-preview/pr-1813/src/extensions/useShortcutSurfaceActivations.js\":\"07f3ab9c14a1d463\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/discoverToggleTree.js\":\"6477b440ac1c664c\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/facet.js\":\"584c128994af9f1f\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/resolveAppRuntime.js\":\"ab653f97eeaa5f41\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/runtimeEvents.js\":\"a636dd42fc9d595c\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/togglable.js\":\"001bf515ce5d6c72\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/variantFacet.js\":\"1d2bc63ff13c0063\",\"/knowledge-medium/pr-preview/pr-1813/src/facets/verbFacet.js\":\"06a234458bfe1dfd\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/block.js\":\"09d22c0010cd7e27\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/focusedChild.js\":\"ed7dbb7d2577938f\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/propertySchemas.js\":\"44df622a9eec0db6\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/typeRegistry.js\":\"b6a2d9d217f93e25\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useAncestorCrumbs.js\":\"d513f14afd26ae7a\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useAutocompleteListbox.js\":\"ef362088d67e29ae\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useDebouncedSearch.js\":\"f281eaf18edc2bde\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useDebouncedValue.js\":\"4342c2cd8104c9cd\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useIsFocalRender.js\":\"c259bbf27d594101\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useIsReadOnly.js\":\"6bdc9b35c7729001\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useMaterializeBacklog.js\":\"5bb1352559083af8\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useMinuteClock.js\":\"42ff366353c5b576\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/usePanelLayoutProjection.js\":\"9e0f8ab5f0fec641\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/usePendingInvitations.js\":\"7b1464e2fec0368e\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useRendererRegistry.js\":\"cbd728e52ff56a2f\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useRetainedFieldRows.js\":\"ba6f311c3ac77ef4\",\"/knowledge-medium/pr-preview/pr-1813/src/hooks/useWorkspaces.js\":\"84e59fe89b819409\",\"/knowledge-medium/pr-preview/pr-1813/src/lib/utils.js\":\"85041c705519d1b3\",\"/knowledge-medium/pr-preview/pr-1813/src/main.js\":\"317173a6553542b6\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/MarkdownImage.js\":\"338da967b515bdcc\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/blockSeparators.js\":\"d6bc050e86834d8d\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/context.js\":\"cfe80c2a1306e387\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/defaultMarkdownExtension.js\":\"c7e51c0f925f3af5\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/extensions.js\":\"cb68bfc14b3fe9de\",\"/knowledge-medium/pr-preview/pr-1813/src/markdown/renderMarkdownHtml.js\":\"633cfcfc4f2ee4b4\",\"/knowledge-medium/pr-preview/pr-1813/src/minimal-editor.js\":\"c7fb2523dacd32a1\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/armedCut.js\":\"cc05029d699de2ca\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/captureMediaVerb.js\":\"73f057a769dbc879\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/clipboard.js\":\"cbc89e5b36ecc649\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/decision.js\":\"c1d1b200044bc794\",\"/knowledge-medium/pr-preview/pr-1813/src/paste/operations.js\":\"52ec63b9ea8bb31d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/account-header/AccountHeaderItem.js\":\"e7c7713aeae7ffea\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/account-header/index.js\":\"7d0849c1a9ee8671\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"478c6475d7544f2c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/askAgent.js\":\"b1275676ed08261e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/askedStore.js\":\"0f70fa90b946693a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"458aaedc38c34dbf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/chipState.js\":\"bddab09476ef82c6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/dataExtension.js\":\"bbcad88d1ef57623\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/index.js\":\"d9c484ee535eefb5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6ef19296662b3c48\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-dispatch-companion/schema.js\":\"82343f95cd5f9700\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9d301e60e1ee9bad\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8c3ee06da173a421\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/addMedia.js\":\"e64a165e79bd5a1e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/backlinks.js\":\"2223c1fc3ddce778\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/block.js\":\"8a81f3eed6177636\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/context.js\":\"ed7fba99f73051f3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/displayIds.js\":\"8d7e69c85683fcf2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/index.js\":\"17052c3c164dccab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/outline.js\":\"b53a9cb4f4cf7fcf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/properties.js\":\"5571823a1d9840fd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/refs.js\":\"dc0e0a7f7deed4b2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8855bac253734bf1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/search.js\":\"76a06da6ff3b4578\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/shared.js\":\"3ed8cd50c6483600\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"b32e448e4a3b73b3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentViews/text.js\":\"77fda94a99802434\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/agentWrites.js\":\"791cba585693b886\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/authoringCatalog.js\":\"930ef54504f85580\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/blockRefTargets.js\":\"0157eb7c81abe4d8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/bridge.js\":\"d4e11d1a0e401bb3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/bridgeLoop.js\":\"e816e2c3a8d8781f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/changeHistory.js\":\"2fdf57fe37bc86b6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/commands.js\":\"e065d968bb0c2561\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/commentsCommands.js\":\"96a1bd73128efae5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/dataExtension.js\":\"ee97086c8256326e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/dataModelGuide.js\":\"0a820c9528d60f56\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/describeRuntime.js\":\"076cde9eac77b435\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/extensionLint.js\":\"f4057ff4b0c05770\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/grainAudit.js\":\"2ae7b0f26281886e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/healthCommand.js\":\"9e4d6d7365a5e29f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/index.js\":\"7eb4e16ecbf531da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/presetIdentity.js\":\"1564e56ca2bd2ef8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ddb24375df5b26fb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/readMedia.js\":\"ba9ab4c4b21e91cd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/schema.js\":\"c23387fef1e6c4ef\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/serialization.js\":\"7870f2ee4f95777c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/targets.js\":\"366ce516f1c4b625\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/tokens.js\":\"ecde713ffe24e936\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/watchEvents.js\":\"b07508a56b2d1292\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/workspaceGuard.js\":\"20253d255ea9d1b0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/agent-runtime/writeCommands.js\":\"133d6c3c9810edb9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/AliasCollisionToast.js\":\"59187a56fb26e94d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/DuplicateNameBanner.js\":\"6888f9ee0127e049\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/collisionMerge.js\":\"021986cc723d1225\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/dataExtension.js\":\"fa01220b1b909d81\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/index.js\":\"55446509f4b2c2fb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/mergeCollisionAction.js\":\"0aa41770a377a970\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/pageStyling.js\":\"e439e6969daacb74\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/rejectionToast.js\":\"a7d2b78edfb5b195\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/alias/syncProcessor.js\":\"f079bf8507ffa058\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/actions.js\":\"12867ffc63116fa9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/addComment.js\":\"8ab239b8be4cdd11\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/anchor.js\":\"6e26003dc6d1944b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/anchorState.js\":\"339550e62e13d12d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/commentLinks.js\":\"37907075e21593a9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/confirmThreadDeletion.js\":\"7c71855ff97d7a54\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/container.js\":\"44695a35b4160295\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/dataExtension.js\":\"a2390138cc2e23af\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/deleteComment.js\":\"97138c9dcce4d45f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/highlights.js\":\"6be7f2ada0c45bd4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/index.js\":\"aae67301401fa5b2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/linkedCommentsPill.js\":\"f171db4ff7deafcb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/margin.js\":\"6d8f734c0563867b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/marginSchema.js\":\"eacedfd2080d16b5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/newComment.js\":\"e9e574bc922d0bdc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/ownThreadPicker.js\":\"f273cf82fc8e806c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/placement.js\":\"a10a872d3ba0c0df\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/queries.js\":\"5f3b95e6a6a71963\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotePosition.js\":\"2c5262f406536020\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotedIn.js\":\"d109de4d5e7df79b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/quotedRange.js\":\"65843f4a17fea149\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/rangeRefs.js\":\"725454e537a546ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readHighlights.js\":\"3604148a5e6cd9cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readSelection.js\":\"7c43106d5b7a7245\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/readSelectionUi.js\":\"959588e0c5f708bd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/reanchor.js\":\"c517c3163eb06f4b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/schema.js\":\"61cf461c16ec3af8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/scope.js\":\"ec8da12a6522453e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/scopeThreads.js\":\"6bcee8f8023cf431\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/splitRetarget.js\":\"fbfeaa336fca8b84\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/suggestionCard.js\":\"8041442a99f23511\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/suggestions.js\":\"36c383218772e9b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/summaries.js\":\"a4a38a29b5372a49\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/summaryBatch.js\":\"d2dca2cc45c396ad\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/surface.js\":\"f1a72d87c1943a16\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/threadNavigation.js\":\"4e79541ec400cd9d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/threads.js\":\"8e2bc9561654d09b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/ui.js\":\"c69d5c2e61a6b89f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/annotations/uiStore.js\":\"b1bfee44b4192b03\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-intents/appIntents.js\":\"b7924c17d790e76e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-intents/index.js\":\"f755d360e16585cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-update-prompt/index.js\":\"731f0a84a7930e5f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/app-update-prompt/status.js\":\"9ba159c2bfd59265\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e028e9724ad9c013\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaBlockRenderer.js\":\"280ebb8633b9168f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4a1256c1246f2f6b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/MediaUploadReconciler.js\":\"33ccccfc917ee58e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetDownLane.js\":\"c54d342c5a80ce04\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetResolver.js\":\"b1a53ff60052b039\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/assetUpload.js\":\"c57f5f1f71f02295\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/attachmentCleanerIO.js\":\"d1432d823f20e2f8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b7320a4693c5ec9a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/blobStore.js\":\"a3338444e09feab4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/byteStore.js\":\"96a8b5579d82ba9a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/cleanerIO.js\":\"08811d4d5dd521b0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/cleanupAttachments.js\":\"4333bca38237237b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/dataExtension.js\":\"aba294acef97db19\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/downLane.js\":\"33e712452960322b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/index.js\":\"4af9d7eea5c84a01\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/insertImageContribution.js\":\"73375aaa91d389b9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/laneArming.js\":\"f1f455f2e2ed2856\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/laneLock.js\":\"b2c17de7dde6655e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaBlock.js\":\"7992244bade8e102\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaCapture.js\":\"a6080b1120519790\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaViewers.js\":\"9c515e643a4ea8a5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/mediaViewersFacet.js\":\"ac5912a6cab87c2c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/pasteCapture.js\":\"0a117f0bbef4dc6c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/resolver.js\":\"196ca93455fb5b22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/retryUploadsAction.js\":\"9f23c762ead805ee\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/storagePaths.js\":\"19115dd7457ff239\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadDrain.js\":\"9bc1475bf907576f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadLaneStatus.js\":\"33a28c775d13021d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadReconcile.js\":\"101f474c6c07d512\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadRecovery.js\":\"4e878b4d3d9a1dfe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/uploadStore.js\":\"0b7d9b53afed3d2e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/attachments/useAssetObjectUrl.js\":\"883b9eb71cf06624\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"15a45edf14d21031\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b66e9f98c28df074\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/facet.js\":\"e164d890ef499463\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/index.js\":\"475f2a30f32d1035\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks-view/prop.js\":\"bcaa4b05af6ca507\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BacklinkFilters.js\":\"e3f3be54c1969a90\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"be048f9d2af8ba91\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/BlockEntry.js\":\"35ce1f09c2239a4e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/LinkedReferences.js\":\"ec927a3cbcbdf1f1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ec8874afe4b02a97\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/dailyNoteDefaults.js\":\"733f07a1e615da84\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/dataExtension.js\":\"dbda1245a96de8ef\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/edgeExclusions.js\":\"73f05e003db53b00\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/filterProperty.js\":\"01fb5ea185874d87\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/index.js\":\"c3f55d10009bc703\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a1eaf7df46900434\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/applies.js\":\"f462f2c337aea935\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/countQuery.js\":\"8a0d9c1331511322\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/expansionStore.js\":\"434b73be0b4b59d6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/index.js\":\"463fb5225debe1cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"663f6fc346c7b274\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/presentationInvalidation.js\":\"7c71b5574ef95dfd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/propertyEditorOverride.js\":\"077b4237ebe8d1b4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/propertyFilter.js\":\"16846d167a9c7241\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/query.js\":\"408a5bacd49a0929\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/resolveFilter.js\":\"edea50e75e3f8752\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/sourceBatch.js\":\"fd252122983a77ba\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/sources.js\":\"efd5f76cce00bd50\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/useBacklinks.js\":\"9872bd151169fcd2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c171189f7ea5e63e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/BirthdayCelebration.js\":\"cb5bfd1f37fb40b7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/BirthdayOverlay.js\":\"76debf5892639e28\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/gate.js\":\"df4b7a4c20a96152\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/index.js\":\"23bc7fbd3ff88b0c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/birthday/wolfTheme.js\":\"84473b3f9b826a46\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/BlockDragLayer.js\":\"1f01b539852ab0f5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/dragController.js\":\"3b39d01ac30389f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/dropTarget.js\":\"bfce3d98c07f0afa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/index.js\":\"b95125ba48a4c104\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-drag/projection.js\":\"69e5d7fea43a082b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-info/BlockMetaCard.js\":\"856a5496a4337f07\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-info/index.js\":\"a6d3e0f0631f3427\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/AddTagDialog.js\":\"ae80f2c34690fb55\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"05786d045d79506f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/TagNameIssueHint.js\":\"9bc01983da6370ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/addTagAction.js\":\"acd775582528b163\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/appendTag.js\":\"5df4bc01ca4a647d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/config.js\":\"f7c51b269ce93ac6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/dataExtension.js\":\"c120107dc325110d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/index.js\":\"56a8900e21c4a4d0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/block-tagging/propertyEditorOverride.js\":\"af6c88783d1b791a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e28974eeb9f19f2b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fbfab4269c29a437\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/Breadcrumbs.js\":\"02d2cc623dc4bb3e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b27c643b84c1e97e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"17abd218a349bf88\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/index.js\":\"87733f601b29be6c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fbdf5ccfa3c035b2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/CharacterCountItem.js\":\"4e3f58ca039ab460\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/ProfilePropertyEditor.js\":\"318e73ccbaba8815\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/actions.js\":\"f806d9ba72cac8e8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/blockType.js\":\"1d5f5d358aa412d4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/charCount.js\":\"062d2c564faaaa87\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/dataExtension.js\":\"85ee0469e13e015f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/index.js\":\"62aea40025c998e9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/profiles.js\":\"54f5ac29d31eaec7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/properties.js\":\"955bf5c561bbcb40\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/character-counter/textCounts.js\":\"02d2e0303a449a40\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/colemak-keybindings/index.js\":\"8b1d632c793a96d6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/CommandPalette.js\":\"c4077b7794e1843d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/HeaderItem.js\":\"21781206f662352d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/context.js\":\"912a5beb7dd7c409\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/index.js\":\"784622753ed3d394\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/selection.js\":\"2e855893674ecae3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/toggleStore.js\":\"2ef542fa6b93c6c3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/command-palette/useCommandPaletteActions.js\":\"a140aa079b87c863\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/ContributorBadges.js\":\"09e85ef657cf1d4d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/author.js\":\"4df680290e30176b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/codeMirrorExtensions.js\":\"9d42806cf662c2c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/dataExtension.js\":\"571db28d70253dd0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/index.js\":\"56bd49d40039e5ce\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/mentionAutocomplete.js\":\"a26433f31ea249fc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/processor.js\":\"d68e176918737c75\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/profiles.js\":\"0bf367e19c0419e9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/queries.js\":\"3db72d9598a761d2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/contributors/schema.js\":\"01c7efc519102d67\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9b888c784444d07f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2141d2cc26212d06\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/index.js\":\"652c4b14d3fef5c3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1d546445a489477b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"03a03081adb3d29b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/CalendarGrid.js\":\"ab4a458525309789\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DailyNotePicker.js\":\"a38d07151fdf30a0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"1d31f1fd07ad2f04\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateNavDecorator.js\":\"c07f8d8a2b437e55\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/DateScrubOverlay.js\":\"79883731b6e5348d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/HeaderItem.js\":\"8307704da4821b7c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/ReschedulePicker.js\":\"c8f63a27674c7ba6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/SpreadDatesDialog.js\":\"740d89fb66866914\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/actions.js\":\"26f4d02029e2bc01\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/blockDateAdapter.js\":\"1c70de3a09a90f7a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/calendar.js\":\"47e04d1dabd6bbc1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dailyNotes.js\":\"bc006b3f161ddcbb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dataExtension.js\":\"acd24b78a5a48db5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubActions.js\":\"de2fb2c99b7f1f98\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubGesture.js\":\"eb1265dad2a2c398\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e8128e5260f2ff66\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0a7535f8fd27104b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/deletionGuard.js\":\"3753c7023a3f196e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/dueQuery.js\":\"8189ed81e0154953\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/index.js\":\"fd48d95de8363309\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/landing.js\":\"bdfc1acf8ae8c1aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/localSchema.js\":\"a1983bc7b1dcb7d6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/referenceDateAdapter.js\":\"18f575ba93bb8f80\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/rescheduleAction.js\":\"8a8802190817abf6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/schema.js\":\"9bab888602933f4a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/spreadBlockDates.js\":\"9a4a3ed733017d98\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/spreadDatesAction.js\":\"43d292e889291e00\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/today.js\":\"b796371f33a4e8bc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0d8159b6b56ef03d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f8b5b0216ada1b36\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/audit.js\":\"d7225cf6d8d4447f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/auditAction.js\":\"89fad4c67edd267f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/auditRanges.js\":\"4ceda813491068d6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/diagnosticsSource.js\":\"3845d2d039effdf6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/divergenceScan.js\":\"abe30400072cf665\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/index.js\":\"71ffaccbe95bff86\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7ed8d9b13c7d7d16\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/referencesMirror.js\":\"9dfadc3a58b03920\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/rowJson.js\":\"14bf6a6cd23319b6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/schedule.js\":\"4b30bfc204343a2b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/data-integrity/store.js\":\"f97a3acee89e1d3e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/action.js\":\"04e24b1db4cb72ea\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/index.js\":\"72c00fa11d94835a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-maintenance/plugin.js\":\"83c51e357fd99019\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"282ba2fda504990c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/actions.js\":\"77f11875cf82b6bd\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/changeMarker.js\":\"228bf2705a1528a2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/diagnostics.js\":\"19116c75de24aec0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/fileSystemAccess.js\":\"6c7370a237c9eb5b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/filenames.js\":\"0ab5cbfce94bb95d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/index.js\":\"ed03ecf31e78f3d4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/mirror.js\":\"29eef442437e11d3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/runLock.js\":\"964c59abc849f404\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/runtimeHealth.js\":\"b23ed40037d05ec8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/schedule.js\":\"635006d0fa722ae4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/db-mirror/store.js\":\"58dd7631c4394b1d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/default-themes/index.js\":\"3f1d3291ab002987\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/default-themes/themes.js\":\"fa431ae5ad50c6d4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/diagnostics/facet.js\":\"098ce3cb2271f03e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/diagnostics/useDiagnostics.js\":\"a7b47aa40263516a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/dismissals.js\":\"e1d5b3f9ae5adc66\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/index.js\":\"beee3097b4af636f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/status.js\":\"59a98c0653a36108\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extension-prompts/store.js\":\"a14d88dfbd98efc3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"301cf261f277ea2e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bc2779020f24d3eb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/actions.js\":\"99a97aacf41745f7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/config.js\":\"800240f0dba76932\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/dataExtension.js\":\"a14d51fc45381b6b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/effect.js\":\"7414e48956aba36e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/index.js\":\"ed9c35a3c4cf2d00\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/propertyEditorOverride.js\":\"28f71cc86c4dccb8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extensions-settings/useToggleTree.js\":\"80f1c3b19733d162\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/ExtractTypeDialog.js\":\"fd829b9e67f856c9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"17931d9483509d42\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/PropertyShapePicker.js\":\"8185b5e61a5d51a4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/action.js\":\"ea08fccb2420bda2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/extract-type/index.js\":\"c9ce2a3855a93d48\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/FindReplaceDialog.js\":\"7032e08d92e5e0dc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/HeaderItem.js\":\"0ce76a55824e7164\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/dataExtension.js\":\"4aca47d65702c4f8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/index.js\":\"24ad6e6e6ee2e9ec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/search.js\":\"ff787bbabad836cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/toggleStore.js\":\"96827f9733bb4db3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/LocationPropertyEditor.js\":\"d3dbbf7af278c64f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/MapView.js\":\"42cf258d93f3ac66\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/blockTypes.js\":\"a0cc634590c52509\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/codeMirrorExtensions.js\":\"8781ecdf17ba5e09\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/createOrFindPlace.js\":\"2049bcf4cbd43e3a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/currentLocation.js\":\"715a2a9a2307abc4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/dataExtension.js\":\"70b591c0e47648fb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/geoContentDecorator.js\":\"381f3369cb7575e9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/googlePlacesClient.js\":\"f6552efa2af3e384\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/index.js\":\"b921991fbb40a967\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/locationsPage.js\":\"e9bd2f0fed0cd120\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/mapViewport.js\":\"62ceafee038c4147\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/pickCurrentLocation.js\":\"b252101fbdd8aa98\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/placeAutocomplete.js\":\"3407682b570573a1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/placeNameCollision.js\":\"3c19e21d42c1e444\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/properties.js\":\"9224fe4cabc9b971\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/propertyEditorOverrides.js\":\"9761970172aaf4f3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/query.js\":\"80ea8e01878b9859\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/geo/usePlaceSearch.js\":\"bc2f4a709774cc2e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"90cc916b4780be2d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ef28f8aa58dcdddc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ef2b23961deb4800\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/config.js\":\"f108a095a7641ef2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/dataExtension.js\":\"fac15724f30ee3e8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/facet.js\":\"1bcd894b579c07cc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/grouping.js\":\"0f18d4b2fd650860\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/index.js\":\"e215688a46752ea7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"21f125f666d61619\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/query.js\":\"92aa30c0a177d4d2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/resolveConfig.js\":\"1f284299728fe38d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0c2a60abbc53ab2d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"851e333aa18f5e9a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/HtmlDocumentContent.js\":\"f576d060a7535f52\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/HtmlFrame.js\":\"2744b49a6d48152b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/actions.js\":\"27443a6c3d440482\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/blockType.js\":\"ba509ec3e4c8ff5b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/confirmRunScripts.js\":\"514a3b601618c644\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/dataExtension.js\":\"56e971f6b885b78f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameAnnotations.js\":\"c083522adef32d56\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameDocument.js\":\"fd6890b2ebdf76b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/frameTheme.js\":\"72e4cab544c87b7e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/index.js\":\"83df38e33e8b1b88\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/scriptConsent.js\":\"7e42bd2865d521dc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/sourceMap.js\":\"ae609481991fe4a3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/html-document/useDocumentScripts.js\":\"a451eef63852d90b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/index.js\":\"7c1e6d32b8a51726\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/record.js\":\"464da4660a5bf51d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/recordStore.js\":\"f52821717a09b9da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/responsiveness.js\":\"3c3d806793d1ba11\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/schedule.js\":\"2577a91935e569b4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/interaction-metrics/sessionContext.js\":\"ca521c78abd3f0c1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"bec84be6bf5193d0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0564815c4b3ead84\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/actions.js\":\"9b0de7b7e3040deb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/config.js\":\"a41fa5ff14f520ee\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/dataExtension.js\":\"cdbc4b857c1fe358\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/effect.js\":\"5d4052e8a5e5d4f1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/index.js\":\"6a1a72117a240b9f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/keyCapture.js\":\"4e61bd33e54f07ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/overrideStore.js\":\"892a637ea33ed5f7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ff84ab41e1eeaf0d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/HeaderItem.js\":\"2449e58dda7ce216\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/LeftSidebar.js\":\"44ec2e2583b57c86\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/actions.js\":\"a25f88a571827c52\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/facet.js\":\"1b16b597e958959a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/index.js\":\"d598b09a72b46ec8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/shortcuts.js\":\"948ca9cedd9ccbbe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/left-sidebar/toggleStore.js\":\"fe97b50c6dc25045\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/MergePicker.js\":\"4cc7d4e773091f96\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/index.js\":\"3196c280fbdce2f6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/mergeAction.js\":\"cb2b53cdc0a0eb42\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/merge-blocks/strategy.js\":\"c891b94ba0d92634\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/Button.js\":\"f97332c811254898\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"88cb50710f36bb58\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/defaultItems.js\":\"18942ea2d9ad108e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/facet.js\":\"89f947679d010334\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-bottom-nav/index.js\":\"804e8f233e5c98f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"16fbc7eb52c59348\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/actions.js\":\"502de829d2158c4a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8f9bd57a2405d495\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/facet.js\":\"aff0e8015a8b9433\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/mobile-keyboard-toolbar/index.js\":\"a492bc4877bb9f23\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5c44eaeaff5f09f3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e1aedd0000aa4bd9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/contextMenuItem.js\":\"04bde9af26fdefb2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/index.js\":\"494175708545dc8e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/moveAction.js\":\"dee01cd83ddbb35d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/moveBlocks.js\":\"15ed0a1f0255e5ae\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/move-blocks/selectionAfterMove.js\":\"6acec18ff36f76b6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/TutorialBanner.js\":\"0860536098734712\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/action.js\":\"52d5255bf120fc4c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/bannerDismissal.js\":\"fa5947aaec03988f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/documents/cheatSheet.js\":\"872d66ee769dd2eb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/index.js\":\"ce9bc67dc1ac584e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/keys.js\":\"5236236d53d33e83\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/landing.js\":\"4f2cb16d0df4843e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/outline.js\":\"1e4caaffd2914ff5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/onboarding/seed.js\":\"0ec2286880aae91a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/PerfTrendDialog.js\":\"81a2a1105ec8e7c0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/analyze.js\":\"35cd4328d9ffc475\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/diagnosticsSource.js\":\"c334112b2e5c4a0e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/index.js\":\"e4782513e0c617fc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/load.js\":\"2356780f6e594f9f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/monitorRun.js\":\"e95bde2f5911e7c8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/schedule.js\":\"04af7c2564a1c605\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/series.js\":\"03588e7540d3bc4c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/store.js\":\"ea27269b4d85aa3d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/trendAction.js\":\"04423168a9a53314\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/perf-monitor/verdict.js\":\"2d98c6a44e66f0bc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/clickToEditAction.js\":\"fb049deca928d952\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/index.js\":\"13482345d7a83961\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/plain-outliner/interactions.js\":\"526594b58d259d8e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c7b9d21fe4696a61\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/MigrationGate.js\":\"0bdce90c19595ec5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/MigrationGateDialog.js\":\"0d9d63938de3678a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/action.js\":\"de9f0beb67e79ac6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/index.js\":\"ffa4e0f2991dacf5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/localRunMessage.js\":\"bdec5b7d10228e1b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/plugin.js\":\"9fb7e5161f487139\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/progressReport.js\":\"b774878cd8f5aa46\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/properties-migration/sweepProgress.js\":\"024e338031e50997\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/FieldRowRenderer.js\":\"9b3bca3512fc81cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/ValueRowRenderer.js\":\"f06e98545db4d3a0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/actions.js\":\"ff1127dd30e2eb19\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/autocomplete.js\":\"2729233679859eca\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/fieldRow.js\":\"4e3483391fb80b59\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/index.js\":\"eebacdfdab57e0c5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/referenceWarning.js\":\"b2cb1a8cb0794bf8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/valueAutocomplete.js\":\"b2919ad262e33cf8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/property-rows/valueSchema.js\":\"0783299bb73991b5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/HeaderItem.js\":\"374f14ec5a556cb3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/QuickFind.js\":\"06ca2223bfbb58ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/index.js\":\"14c7919883251b94\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/recents.js\":\"dd7334bff2bc24c9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/resultItems.js\":\"1e065904cc18e135\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/selection.js\":\"01fc34ec7bef6f34\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/quick-find/toggleStore.js\":\"478da678dd55faf2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/HeaderItem.js\":\"e545dd6771fa3702\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/RecentsPageBlockRenderer.js\":\"11010f349ef16ae4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/grouping.js\":\"45d3ea2d7f26a4e4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/index.js\":\"4a1628c131f6877d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/recents/target.js\":\"e47f886d38c618ec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/codeMirrorExtensions.js\":\"0f88b17a642e8159\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/contentPrefill.js\":\"67dc3468b95986ab\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/dataExtension.js\":\"75cb0f4850e2624b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/index.js\":\"0984fcaf0a87f509\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"722ddf371ced9fc6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/invalidation.js\":\"c90ddd00b89f4b67\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/localSchema.js\":\"c4c3d5d02cb0726e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/blockrefs/index.js\":\"fbc08ee691492b75\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"443cfccf1c83d819\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/index.js\":\"1240938f3b71d9d1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/referenceNode.js\":\"39b4bad27d724ac5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2427c075e2e3fbc7\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7978fcd353b24027\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/index.js\":\"fdaecfd9a51d15a1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8b774fd3e655b4da\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ff5cdb314bdb19fe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/mergeRetargetProcessor.js\":\"0b37740923479402\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/parseFence.js\":\"c5320cf46ae15174\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referenceParser.js\":\"c5d522fe6a773b60\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referenceProjection.js\":\"53b722d11be175e6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/referencesProcessor.js\":\"68fe07790befd8d1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/renameProcessor.js\":\"d7ef7f3ef2bf2fbf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/references/spanReplacement.js\":\"e00ed3b918eeda78\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/htmlToOutline.js\":\"802784643e66fd81\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/index.js\":\"66162a87f703b6de\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d4c5eab46568fb95\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/rich-paste/pasteDecision.js\":\"0464342f526b2cb4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/action.js\":\"fcf323b0f76529e2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/blockIds.js\":\"08e96a03928078ea\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/content.js\":\"76fc0b550f86647b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/effect.js\":\"d01e4c91a4236f04\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/ids.js\":\"d5fabc3b45bf2cd8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/import.js\":\"62cd9b7a8bd99ed2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/index.js\":\"cedd22f870bab6aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/plan.js\":\"c7ef6baa47cdcc1a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/plugin.js\":\"8e847f527a24b8b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/promotion.js\":\"c8222bd29cbf136d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/properties.js\":\"866a566274acf92b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/references.js\":\"dd92d7c547ddbf23\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/report.js\":\"4ef7199db71abc09\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/roamMemo.js\":\"fb94f78fe149ee6b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/runtime.js\":\"afbc795b72531f6a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/schemaReconciliation.js\":\"0623145460981e2c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/srsMarkers.js\":\"d44017ffb6fc2093\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/todo.js\":\"38d7f454a3fc4447\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/typeCandidates.js\":\"84875c592f0553dc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/roam-import/types.js\":\"6141de79937922f8\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/search-health/index.js\":\"4bb18010f43b1937\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/search-health/store.js\":\"cf26ed7c18881644\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/HeaderItem.js\":\"16495cccd6a78909\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5c528cd153cbc936\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/index.js\":\"05cbf74e367938f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/model.js\":\"06336c7e0056b228\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/toggleStore.js\":\"e2539a64849bdd6f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/shortcut-help/useKeyInspector.js\":\"dbb8530ec13651f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"6bc6592b785b066e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/ShellDecorator.js\":\"47175bf8ca4f24af\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/actions.js\":\"59d7da0241a6956b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/exclusionsFacet.js\":\"531600770dfb71cb\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/index.js\":\"df035c383cfedc7a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/shell.js\":\"5de4149e25ae7bfa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/surface.js\":\"950ae4af4cd60b15\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/spatial-navigation/walker.js\":\"502a95df1595b7b1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/RescheduleToast.js\":\"02b242ced87813c0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/dataExtension.js\":\"93da0e3b5fe9f0aa\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/index.js\":\"9b51084b95af7c6d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/indicator.js\":\"22bea7b6f6d1c4df\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/moveSrsState.js\":\"3f403abfe0d0d642\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6cde9affdfc8199d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/scheduler.js\":\"319ab4fffd88420b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/schema.js\":\"96e4c6adf8a30b24\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3268dd80d8cf9e2f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/srsClipboard.js\":\"5273b3c6a545b9b5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e75896fa3aae2b0b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/DailyNoteReviewHint.js\":\"21cd34ac274fbeec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/DeckPicker.js\":\"ccefbaca433e3636\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewControls.js\":\"9b8a64c6d1ee513f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewDeckRenderer.js\":\"90aff7d34c39f86d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/ReviewSession.js\":\"7c8d97ae01143d43\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/actions.js\":\"a61dab76a6e58ff5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/archive.js\":\"75edeff6e581abdf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/dataExtension.js\":\"93506dfb73e0d94c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/deck.js\":\"2c9977510f42e6fe\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/dueQuery.js\":\"58d21d16ba29d763\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/gradeDecision.js\":\"c8ff276eecf45a1e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/index.js\":\"d6bc0b022888e5cf\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/keyHints.js\":\"f47a39037cf9bfde\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/reviewCardLayout.js\":\"116148ff27e2de53\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/reviewProgress.js\":\"8d893c5868cbafd5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/schema.js\":\"92495bd34dad0343\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/srs-review/useDueCards.js\":\"2f998b250eca7c2f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/startup-metrics/index.js\":\"cb3405661cde31c5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/startup-metrics/record.js\":\"587368bbca1244e2\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/index.js\":\"0edbe993e8729b8a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/persistenceStatus.js\":\"4b3f3ef887161e5a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/storage-persistence/requestAction.js\":\"34832e3972dd0bb3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/TypeChipsDecorator.js\":\"6c0ce7d5dac427c5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/codeMirrorExtensions.js\":\"118cdde106e6b6d9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/index.js\":\"55f69934614557bc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/supertags/typeAutocomplete.js\":\"28590abf38299dde\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e512dfc6eab47468\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/actions.js\":\"5e70bb62657ed210\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/anchor.js\":\"c004e73933dcb0d4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/events.js\":\"6b781e1a95f9223a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/gestureActions.js\":\"32d4bb2af63e67af\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/index.js\":\"da75680bebe94a78\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2842d3daad8334a5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/collect.js\":\"431cd05ce1be4e01\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/index.js\":\"6bcbce9dd4008582\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/sync-metrics/record.js\":\"1277394bfc981346\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/RejectionDialog.js\":\"9166d057bef8ff30\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d38daa844a6bbb96\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/index.js\":\"46a31b57530f91d6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/model.js\":\"6db6fd5681301436\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/queueCounts.js\":\"b25b237ab57e8002\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/rejectedHelpers.js\":\"ea5320b0df407ca9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/rematerializeAction.js\":\"b8398a46a9f5a62b\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/system-status/useHysteresis.js\":\"135df29a46470954\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/TableLayout.js\":\"f4630289e7aaa466\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/actions.js\":\"e0509faaf4213b47\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/cellEdits.js\":\"d6d0dddf9700da5c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/controller.js\":\"2c255bfe92654d46\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/convert.js\":\"720b188f3991a8b0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/dataExtension.js\":\"abfb337e5e61580d\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/index.js\":\"da0599b0d9e25899\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/keys.js\":\"158d1ce7c576627e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/model.js\":\"499db64011d5f3b5\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/registry.js\":\"04ce3d6b77049383\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/tables/schema.js\":\"ab11e8ecc3b74b22\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/effect.js\":\"08040b05523a2f23\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/index.js\":\"5aa6c6c91da9fe63\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/theme-toggle/theme.js\":\"4fa10d4c5adf9871\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/actions.js\":\"ac624f7a9a9839b4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/dataExtension.js\":\"9da7226aeee4aa72\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/index.js\":\"fb3aeb7c3152d75a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/todo/schema.js\":\"7477cc8b242984be\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e9fa724f380bc666\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/actions.js\":\"ee9447822dffbfec\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/defaultItems.js\":\"2481bc6e886e7555\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/facet.js\":\"1544912323889ef0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/holdRecognizer.js\":\"8fe8afd09466c1c4\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/touch-selection/index.js\":\"58ede9898808a290\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/UpdateIndicator.js\":\"f8fb9e89a3a2975c\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/index.js\":\"2e46690b83a7b7d1\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/update-indicator/loadTimes.js\":\"20266228bb3dde13\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoNotesRenderer.js\":\"ea4f540d6a76687f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoPlayerRenderer.js\":\"ef1536c67ab94ddc\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/VideoTimeStamp.js\":\"365e7759303d692e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/actions.js\":\"ffb5fde172359d90\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/index.js\":\"5e687f136f07db3f\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/markdown.js\":\"6138f275cb216389\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/notes.js\":\"a2b44beb899670b3\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/registry.js\":\"fe52db9a6bbe305a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/remark-timestamps.js\":\"1cf9d49ca259b4c0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/video-player/view.js\":\"9c7035c2d31c653a\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/LinkHints.js\":\"01a13d926134d4e0\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/index.js\":\"b45ed8cc8b8092f9\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/model.js\":\"0c99fc95bf47b02e\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-link-hints/settings.js\":\"b327e6b326db7143\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/actions.js\":\"2edb78c0f1943f08\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/index.js\":\"a7d7fdde681929d6\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/vim-normal-mode/interactions.js\":\"2bc57657e8732583\",\"/knowledge-medium/pr-preview/pr-1813/src/plugins/workspace-header/index.js\":\"a90bf51b52547436\",\"/knowledge-medium/pr-preview/pr-1813/src/registerServiceWorker.js\":\"263a57f86c050005\",\"/knowledge-medium/pr-preview/pr-1813/src/requestPersistentStorage.js\":\"958bb8411b1b405d\",\"/knowledge-medium/pr-preview/pr-1813/src/services/authRequestDeadline.js\":\"d4453b058b243a25\",\"/knowledge-medium/pr-preview/pr-1813/src/services/authStorage.js\":\"25eb880e85b828d5\",\"/knowledge-medium/pr-preview/pr-1813/src/services/powersync.js\":\"e5cfb389e708128b\",\"/knowledge-medium/pr-preview/pr-1813/src/services/supabase.js\":\"13825639d889712b\",\"/knowledge-medium/pr-preview/pr-1813/src/services/uploadErrorClassifier.js\":\"25c09912f8b12601\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/ActiveContexts.js\":\"5210dda0e454bc89\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/HotkeyReconciler.js\":\"2598d19f3bae9240\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/WipeLocalDataDialog.js\":\"25b6a29060bb4d94\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/actionDispatch.js\":\"84fadb09ea71247b\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/actionRefItems.js\":\"e5b47eb6e7085539\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/applyKeybindingOverrides.js\":\"398cb804d029b86f\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/blockActions.js\":\"e117b1650c828110\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/canonicalizeChord.js\":\"ef21014a4b17a241\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/defaultContexts.js\":\"b931cee9375e1364\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/defaultShortcuts.js\":\"a513300da468ef82\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/effectiveActions.js\":\"5df0af91454af2b8\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/gestureAction.js\":\"f87e936e6aa8d09e\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/gestureBinding.js\":\"c6655ad777b4adac\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/holdRegistry.js\":\"189e56f6d7b9ae08\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/keybindingConflicts.js\":\"89a209c7be090071\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/keybindingOverrides.js\":\"76e97b155e2ad2bc\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/pointerAction.js\":\"23103ac869062924\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/resolve.js\":\"fd03754afd619a2f\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/runAction.js\":\"7de2ee95015ad2e7\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/sequenceMatcher.js\":\"9e19a99d6d9da52b\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/types.js\":\"2fb5d9bf0ac0ea33\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/useActionContext.js\":\"5613755aa0c8944c\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/useActionDiscovery.js\":\"31b937ea35076654\",\"/knowledge-medium/pr-preview/pr-1813/src/shortcuts/utils.js\":\"be058fe5c097d22f\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/bootStore.js\":\"6ae013b0df4f32ed\",\"/knowledge-medium/pr-preview/pr-1813/src/sw/previewDatabases.js\":\"05fdb5ec88858501\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/byteTransform.js\":\"31a77ce83a4f4c90\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/attachmentCleaner.js\":\"e009ddca2f0e5f6e\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/attachmentParts.js\":\"060319a0c2b220dd\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/bundleParts.js\":\"33fcb3f6c99e5b66\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/bundleRecord.js\":\"d6ec989be136e8d0\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/manifest.js\":\"c93cc82de1b0b8af\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/takeBundle.js\":\"2e98a4eebd1801ce\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/bundle/verifyBundle.js\":\"c2263a0fc5a5e418\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/cleaningStage.js\":\"6157f2d15d1c5cc1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionKey.js\":\"73c31d5e33870fe1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/conversionServer.js\":\"3de15445f7200fac\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/flip.js\":\"70b3ff76a81b6b5a\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/flipAttempts.js\":\"49f6578dea4ddaba\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/pages.js\":\"e84f7a0f2d458a1a\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/preflight.js\":\"9be6ae042c8151e6\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/reseal.js\":\"69bae02a2cd9a40f\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/runConversion.js\":\"deb7dc00b2a4213b\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/runLock.js\":\"b5226220f824b7be\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/sealing.js\":\"56990959e48aeab7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/sealingStage.js\":\"c1da7abc5429c656\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/stage.js\":\"c86d5671d9234ea1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/conversion/verifyReseal.js\":\"29b568b0e64c22b7\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/aad.js\":\"c55b4b67063c610e\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/aead.js\":\"f2a3fc7cc82e9020\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/base32.js\":\"f6403d681b2c40fe\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/base64url.js\":\"9cbab31df86e3473\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/binaryEnvelope.js\":\"bd401d463030ba8a\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/byteAead.js\":\"7f73f41d1f38fccc\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/canary.js\":\"af975a94e6e4de98\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/contentHash.js\":\"107b461235cbd40c\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/contentKey.js\":\"b7ae104747ab45ad\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/derivedIdNamespace.js\":\"dde4f2a9acab6f89\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/envelope.js\":\"4b3f7de41df40de5\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/hex.js\":\"8b3958ee46fe98f4\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/sha256Hex.js\":\"fecddd4f1d202faf\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/crypto/workspaceKey.js\":\"5318b98f95f7862c\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/conversionState.js\":\"76d4fc625967df41\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/createEncryptedWorkspace.js\":\"aa376c929d8e6bec\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/pastedKey.js\":\"d8f5f02827c3ed39\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6316083e2fd77420\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/flows/upgradeWorkspacePin.js\":\"38adf688c9d3e6b4\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/keyStore.js\":\"a3f8d483a14edf97\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/mintWorkspaceKey.js\":\"e474cb9666b48131\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/modePin.js\":\"d5996d903f958724\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/openWorkspaceKeys.js\":\"44717efb9f6a934e\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/resolveWorkspaceEntry.js\":\"d9df3e081957d312\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/resolver.js\":\"a40a78def4189ab0\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/keys/workspaceAccess.js\":\"2bd2a2c84c9d6ac1\",\"/knowledge-medium/pr-preview/pr-1813/src/sync/transform.js\":\"7f9d116b92c7a76b\",\"/knowledge-medium/pr-preview/pr-1813/src/themeBootDefaults.js\":\"b094202d5a7e60a3\",\"/knowledge-medium/pr-preview/pr-1813/src/types.js\":\"29b1643718f7ddc5\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/ClientLocalSettings.js\":\"7c9988536d2a1612\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/abortableSleep.js\":\"880ba2634e5b30bd\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/array.js\":\"6a28bd150d4904eb\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/backlinkAutocomplete.js\":\"bec76426367f04d0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/blockCrumbs.js\":\"80718d0ee15e9084\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/blockrefAutocomplete.js\":\"ed6202e84026e87b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/cadencedIdleJob.js\":\"45cb917dd332365a\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/callbackSet.js\":\"2b6103a1a303e843\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/clientId.js\":\"8ded8cbcef351ed8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/codemirror.js\":\"914a05726c4d6152\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/codemirrorCompletion.js\":\"e52459746f151d46\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/copy.js\":\"bc3aab4650d30caf\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dailyPage.js\":\"3c3619c9c08cd959\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dbForensics.js\":\"2428abf00d1eb9f9\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dbForensicsHooks.js\":\"bb970a949d57f753\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/deleteBlockThroughUi.js\":\"81b06e2c76808267\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dialogs.js\":\"3b57adc457c4ea01\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/dom.js\":\"02fafe8f9db06db9\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/downloadBlob.js\":\"959fe0a0e123f3e0\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/exportSqliteDb.js\":\"9b0bf290cfd19b9b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fileSystemAccess.js\":\"f035d915003c89e4\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/flipSlide.js\":\"a5107b9b17e94910\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fnv1a.js\":\"725aa057ce6acaa2\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/formatBytes.js\":\"b0bcb1645f2d951e\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/fuzzyRank.js\":\"4ca06f731ca927c7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/idbKeyedStore.js\":\"50cf0be043806051\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/idleCallbackPolyfill.js\":\"a828fe611cf3a5e8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/keyboardAwareScroll.js\":\"c1f878267ac1191c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/keyboardViewport.js\":\"035758fd7c1c7a11\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/lastWorkspace.js\":\"e27ad0d24352a097\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutColumns.js\":\"2e638b231cd26d63\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutSessionDom.js\":\"d9bec68282402b51\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/layoutSessionId.js\":\"941be6a4e2c60b43\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/linkClickGestures.js\":\"26011bb1d4cbe2f2\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/linkTargetAutocomplete.js\":\"6e3a46177f478af2\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/localDbCorruption.js\":\"61fcf7b214b182d8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/localDbRecovery.js\":\"dd1caea4267bf44f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/markdownParser.js\":\"5e26c3f8cb8bc5e8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/memoize.js\":\"5413b306a2b67092\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/nameFieldCommit.js\":\"49578416e30f334f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/nameList.js\":\"b6c9d884ddf82200\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/navigation.js\":\"3d3f90f733080dda\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/omnilinerNamespace.js\":\"e7775370106157c9\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/opfsPageScan.js\":\"5351a4291ff3eb68\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelClearance.js\":\"fc690aa414658a86\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelHistory.js\":\"26fab79cd8dd155b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelLanes.js\":\"1f401303b037f4f3\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelLayoutProjection.js\":\"fda330c98e7b6f04\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelScrollAnchor.js\":\"7ee35ab461495fda\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/panelUrlFlags.js\":\"66e69665fc493dbe\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/platform.js\":\"bd34209cd2d89b96\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/pluralize.js\":\"d210373a77be9ef8\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyCreation.js\":\"b9606f1695486192\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyNavigation.js\":\"fd79c908f80b327b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/propertyValueContext.js\":\"6aed8d933ad451aa\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/react.js\":\"948f148b2da4fe57\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/relativeDate.js\":\"e7c377fd626cf6a7\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/relativeTime.js\":\"16a67bd4277925a3\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/renderScope.js\":\"994880dc62a8cd22\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/resolvedThenable.js\":\"41752ec632cd0a23\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/routing.js\":\"406d4e8a8a7ac797\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/safeMode.js\":\"9f2c312b64bb8723\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/scheduleIdle.js\":\"18dd9a288b173641\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/screenWakeLock.js\":\"cf8e7043d72c018a\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/selection.js\":\"cebd4c20a57daf46\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/softKeyboardGrab.js\":\"a25802d63226ec14\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/startupTimeline.js\":\"d951ee7a57980091\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/state.js\":\"8002f2e1c73fc614\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/string.js\":\"4f97985d4e68b56f\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/surfaceZoom.js\":\"a21f7fe0d3a5cfbf\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/time.js\":\"008f98542695f0ad\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/toast.js\":\"9085fb097991313c\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/toggleStore.js\":\"37ece1663523a7ad\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/untilStopped.js\":\"e0be3b9f8b74a647\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/userActivity.js\":\"0415640e2dca1bfb\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/viewTransition.js\":\"90539eabfd96766b\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/viewport.js\":\"d709961109197ffb\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/webLock.js\":\"3a5b7cf6b62adeaf\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/workspaceRecovery.js\":\"a7270ea3e4164714\",\"/knowledge-medium/pr-preview/pr-1813/src/utils/workspaceSnapshotStore.js\":\"6aac94e762c7fe04\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-compiler-runtime.js\":\"7da989453ace5815\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-client.js\":\"de14991ca08b4446\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-server-edge.js\":\"9eb415ca8a51ed2d\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-server.js\":\"8c957753c4450d7a\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-static-edge.js\":\"0ffd56353bf37179\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-static.js\":\"cd1d2012decbd3d9\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom-test-utils.js\":\"98fcc01ddc04d450\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-dom.js\":\"801a672c20b57577\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react-jsx-runtime.js\":\"a7ff9ffc07e5173c\",\"/knowledge-medium/pr-preview/pr-1813/src/vendor/react.js\":\"3f92282fcea8ab49\",\"/knowledge-medium/pr-preview/pr-1813/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1813/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1813/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
