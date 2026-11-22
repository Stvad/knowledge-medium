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
		buildId: "6b3e0ea225ca-f1380c6f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1814/\":\"c7689ce8f254d01d\",\"/knowledge-medium/pr-preview/pr-1814/index.html\":\"c7689ce8f254d01d\",\"/knowledge-medium/pr-preview/pr-1814/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1814/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1814/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1814/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1814/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1814/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1814/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1814/assets/FacadeVFS-WJTVywqf.js\":\"9c67f09492eb5eff\",\"/knowledge-medium/pr-preview/pr-1814/assets/OPFSCoopSyncVFS-B3IQnsB9.js\":\"9d2d7574c8fb9d01\",\"/knowledge-medium/pr-preview/pr-1814/assets/OPFSWriteAheadVFS-C1Ahe5QL.js\":\"73f278f8782e2c8e\",\"/knowledge-medium/pr-preview/pr-1814/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1814/assets/wa-sqlite-D8u59xrN.js\":\"77af35b990f651fc\",\"/knowledge-medium/pr-preview/pr-1814/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1814/assets/wa-sqlite-async-DfewSGUr.js\":\"bc726110148e8201\",\"/knowledge-medium/pr-preview/pr-1814/assets/worker-D0Ludvbq.js\":\"67fae6c68f30fb77\",\"/knowledge-medium/pr-preview/pr-1814/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1814/chunks/app-Drjrxm7x.js\":\"6f28a8a69dc0d13e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1814/index.js\":\"37a5d4b8f7114818\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1814/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1814/assets/AccessHandlePoolVFS-DmaGyEtu.js\":\"392b0c1759fbc5b4\",\"/knowledge-medium/pr-preview/pr-1814/assets/IDBBatchAtomicVFS-D714kHQE.js\":\"dccf0be0996bedf5\",\"/knowledge-medium/pr-preview/pr-1814/assets/MemoryVFS-DMo-mwIW.js\":\"5972fec003c3dec1\",\"/knowledge-medium/pr-preview/pr-1814/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1814/assets/mc-wa-sqlite-M96RhO1Z.js\":\"8e135128aaccb50a\",\"/knowledge-medium/pr-preview/pr-1814/assets/mc-wa-sqlite-async-BPPr9Rhi.js\":\"a32de73ad168bce0\",\"/knowledge-medium/pr-preview/pr-1814/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1814/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1814/chunks/AccessHandlePoolVFS-U2K_szHe.js\":\"cd2c0017a99daf15\",\"/knowledge-medium/pr-preview/pr-1814/chunks/FacadeVFS-CLs-Xkzk.js\":\"c3fc6812427ec946\",\"/knowledge-medium/pr-preview/pr-1814/chunks/IDBBatchAtomicVFS-B4kr622d.js\":\"0204306a8e6720fa\",\"/knowledge-medium/pr-preview/pr-1814/chunks/MemoryVFS-ClX79pjE.js\":\"e3a597cad5a583ba\",\"/knowledge-medium/pr-preview/pr-1814/chunks/OPFSCoopSyncVFS-C_sblAMU.js\":\"daddc50a8b0329a2\",\"/knowledge-medium/pr-preview/pr-1814/chunks/OPFSWriteAheadVFS-svlcSuxv.js\":\"71b434f96c4d673c\",\"/knowledge-medium/pr-preview/pr-1814/chunks/Preview-CCzDSTwl.js\":\"43b3283004f149c5\",\"/knowledge-medium/pr-preview/pr-1814/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1814/chunks/card-yAvuipru.js\":\"51029af2be885a30\",\"/knowledge-medium/pr-preview/pr-1814/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1814/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1814/chunks/dist-CatfB1PB.js\":\"a0514fca73016e2e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1814/chunks/mc-wa-sqlite-DhazoRwm.js\":\"24cbb20ff31871ed\",\"/knowledge-medium/pr-preview/pr-1814/chunks/mc-wa-sqlite-async-CQqb0Ltm.js\":\"405002cd6449ac09\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-C9_yP7DK.js\":\"4a45487f279c8fe2\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-CKd-OtRL.js\":\"f1c3a39ac9b3b39b\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-DJ7rOOXm.js\":\"5af76b53c35ae07d\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-DYo3VODP.js\":\"3cdabd0770c531de\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-Du81r9Qs.js\":\"f8e7d36c16a903a1\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-NcsD_-vP.js\":\"daa05ea19820805b\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-cm3owBtZ.js\":\"7684cef7ceaa3e2e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-dom-server-legacy.browser.production-B1LVZ2x9.js\":\"281f1ccd4b87e112\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-dom-server.browser.production-CNWPTpYH.js\":\"93b0dae9d183ba69\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-dom-server.edge.production-BHLpxItF.js\":\"0d2f0537961d6215\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-vJR3PwAi.js\":\"eb5a65ca7e1e79ff\",\"/knowledge-medium/pr-preview/pr-1814/chunks/server.browser-tESvUaUR.js\":\"3eaaa65cca4a6b7b\",\"/knowledge-medium/pr-preview/pr-1814/chunks/textarea-BJWbcFKf.js\":\"82dba953a81d67f7\",\"/knowledge-medium/pr-preview/pr-1814/chunks/ui-BfQ8viiF.js\":\"b8195f94b55e75b1\",\"/knowledge-medium/pr-preview/pr-1814/chunks/wa-sqlite-Dnmop_9-.js\":\"1314d57aa9fec41e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/wa-sqlite-async-DsYCQsup.js\":\"e4391951e61e658f\",\"/knowledge-medium/pr-preview/pr-1814/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1814/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1814/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1814/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1814/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1814/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1814/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1814/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1814/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1814/src/App.js\":\"28b2c0beb2d72f62\",\"/knowledge-medium/pr-preview/pr-1814/src/appUpdate.js\":\"f334ce20ffd3a786\",\"/knowledge-medium/pr-preview/pr-1814/src/appVersion.js\":\"c09d6c81d3bf144c\",\"/knowledge-medium/pr-preview/pr-1814/src/bootstrap/initialLayout.js\":\"1ae1b82db58d0ed3\",\"/knowledge-medium/pr-preview/pr-1814/src/bootstrap/openWorkspaceData.js\":\"633d9e4aa927c138\",\"/knowledge-medium/pr-preview/pr-1814/src/bootstrap/resolveWorkspace.js\":\"64a2751020da7d18\",\"/knowledge-medium/pr-preview/pr-1814/src/bootstrap/workspaceBootstrap.js\":\"eb5e9667d22c9021\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockComponent.js\":\"3614a0f9670f3579\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockCrumbs.js\":\"a331922eabcc4854\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockEditor.js\":\"b958b26c6689734b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockLoadingPlaceholder.js\":\"ffbdee11b1db5943\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockProperties.js\":\"2300c04dee4b9615\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockSearchPicker.js\":\"1d0b5d2ac9dbf721\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ConfirmBulkDeleteDialog.js\":\"ec1919124ff61394\",\"/knowledge-medium/pr-preview/pr-1814/src/components/DividerHandle.js\":\"b256fb61966f1a9b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/DraftEditor.js\":\"9b6f9c4351a880b1\",\"/knowledge-medium/pr-preview/pr-1814/src/components/GutterPill.js\":\"fefe78ef6a22f0c4\",\"/knowledge-medium/pr-preview/pr-1814/src/components/Header.js\":\"3310dc23252ade22\",\"/knowledge-medium/pr-preview/pr-1814/src/components/LazyBlockComponent.js\":\"6528b18e60936517\",\"/knowledge-medium/pr-preview/pr-1814/src/components/Login.js\":\"4b91acf939e5620e\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ZoomableSurface.js\":\"1d3862fd0d0b1768\",\"/knowledge-medium/pr-preview/pr-1814/src/components/editModeKeepalive.js\":\"a4f1a937bb0e52f5\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyDisplay/PropertyDisplayScope.js\":\"20c7bde9b39529fb\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"876183cca329c86d\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/RefPropertyEditor.js\":\"d8a7f33f5c3089fb\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/RefTargetTypePicker.js\":\"8419a16d646ffeb4\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/SelectPropertyEditor.js\":\"3c1e2d5d594faec6\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/TypesPropertyEditor.js\":\"fb983d9ab3796905\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/defaults.js\":\"d248de81bae1d6c1\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/kernelValuePresets.js\":\"c60ca995357b1c9b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/selectablePresets.js\":\"f3739325b30eb059\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/typesPropertyUi.js\":\"8ff2aee0ff56ca9e\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/AddPropertyForm.js\":\"c8e57030ab7ac284\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/PropertyPicker.js\":\"c77e58f1e4ae16e7\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/PropertyRow.js\":\"ded6aeaa80561d4e\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/Rows.js\":\"f8ad5fbd29581037\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/actions.js\":\"b74bdc32e4b45176\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/declarationOnly.js\":\"0f798b4d89de6bec\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/layout.js\":\"d555412ab4b2d38b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/model.js\":\"9d696cd203ba5d03\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/shapeUi.js\":\"7a291fd936bacd6a\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/shapes.js\":\"6b2502b4be32f5c3\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4bb5b4a1a5c43b9a\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/visibility.js\":\"7c5907daaff977c7\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanelSections.js\":\"9c6ad92e28b8f54e\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/BlockEmbed.js\":\"ca84acc397bf909f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/BlockLink.js\":\"1b787914a6a2b68e\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/BlockRef.js\":\"a83ff94b608b6dde\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/ReferenceLink.js\":\"582a368185001507\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/cycleGuard.js\":\"b89afbcfb7f35ec7\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/cycleGuardContext.js\":\"8b42b634cde5421e\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/linkInteraction.js\":\"a74a2da5d6635254\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/referenceLayout.js\":\"66fb111b48b88c4d\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/useBlockRefAncestors.js\":\"5624475b5be65338\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/BlockGutter.js\":\"31ddc016a1eabe60\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/BlockInfoDialog.js\":\"dbb67f32289002cb\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/BlockTypeBlockRenderer.js\":\"51f9da81907158fb\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/BulletHoverCard.js\":\"4a15183e4f1e6193\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/CodeMirrorContentRenderer.js\":\"62523131e1aba87a\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"cbc93f011881d9d4\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/ColumnResizeHandles.js\":\"565294576955c357\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"fd9c5957d4300120\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/DefaultBlockRenderer.js\":\"41c301db062094e2\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/LayoutRenderer.js\":\"c16f4f78cb29b740\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/MarkdownContentRenderer.js\":\"281b0cd624ba66d3\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/MissingDataRenderer.js\":\"f5128c1ead51153b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/PanelRenderer.js\":\"14ede6e4e41d2f21\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a5eb7433cbb1043f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/TopLevelRenderer.js\":\"7d265dfc8dc1ea79\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/blockGutterMode.js\":\"3c8e222de480cee5\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/blockTitleText.js\":\"81026b8313d770ff\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/fieldCreationKeydown.js\":\"4c7c852896cb2ab9\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/layoutRootContext.js\":\"1591ef6d738b5c5e\",\"/knowledge-medium/pr-preview/pr-1814/src/components/typeChip/TypeChip.js\":\"61f0b6888e3b788c\",\"/knowledge-medium/pr-preview/pr-1814/src/components/typeChip/chipStyle.js\":\"c789bfb9f520b411\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/anchored-floating.js\":\"db6d6e07bca32a08\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/button.js\":\"bb10396c681d122b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/card.js\":\"10298aac3ef82dfb\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/checkbox.js\":\"237a48f3047d21c8\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/collapsible.js\":\"dbed1e1fd5c158d0\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/command.js\":\"2460628e30b401a1\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/context-menu.js\":\"7879806b7decdb70\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/dialog.js\":\"1fc2b555ce1b3a49\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/dropdown-menu.js\":\"9c0c505d08b9f41b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/floating-listbox.js\":\"a5066eb8b98a73f6\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/index.js\":\"38a52a049fd08327\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/input.js\":\"18bda11717d37a12\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/kbd.js\":\"70642f9948480f26\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/label.js\":\"0b2853924e3e0542\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/textarea.js\":\"71a2fbf5122e6411\",\"/knowledge-medium/pr-preview/pr-1814/src/components/useEditModeYieldKeepalive.js\":\"847813b8bc1a0fa6\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/BootFallback.js\":\"4d3bb9b1343640e8\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/FocusedRowLazyMount.js\":\"759331df07b0afde\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/LazyViewportMount.js\":\"82236f54920f70df\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/LocalDbCorruptionFallback.js\":\"fdb4b0346f694b63\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/error.js\":\"deb4aa6c947fc910\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/lazyMountRegistry.js\":\"d1743d88c128fa41\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/suspense.js\":\"9c6a12e3e715aef7\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/CreateWorkspaceDialog.js\":\"84541b04ab1e3571\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/PendingInvitations.js\":\"f9690adc70fe80df\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/SyncProgress.js\":\"27240d750a725d97\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/UnlockProgress.js\":\"a781bd73495d05a8\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/WorkspaceKeyGate.js\":\"00a1a894ebf6677b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/WorkspaceSettingsDialog.js\":\"5e5aca7a679d2bf3\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/WorkspaceSwitcher.js\":\"d2e0684e6224cd43\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/WorkspaceSyncGate.js\":\"f5ffd08b1c6053e8\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/ConversionFlow.js\":\"4e402da7df8a5887\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/ConversionFlowHost.js\":\"47025182f2a06eea\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/EncryptionSection.js\":\"4e88801959ad1e4d\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/attachmentPrompts.js\":\"18366a71b7413364\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9abdebf9a3722346\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/conversionFlowDeps.js\":\"703b5bdc9a562ae6\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/conversionFlowStore.js\":\"8c2d3d1348afd3b0\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/flowUi.js\":\"4391e5f1a758e1f6\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/useConversionRun.js\":\"658e8269126569f8\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/keyUi.js\":\"a9f30514286f57cf\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/useCloseOnKeyLoss.js\":\"3449a1078032dcdd\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/useCloseOnServerE2ee.js\":\"474f0dd1653430c2\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/workspaceUnlocked.js\":\"bbefcc69c3ac8205\",\"/knowledge-medium/pr-preview/pr-1814/src/context/backgroundSubtree.js\":\"aff1549eed9cd2ec\",\"/knowledge-medium/pr-preview/pr-1814/src/context/block.js\":\"7dd008368b5bc8b3\",\"/knowledge-medium/pr-preview/pr-1814/src/context/layoutWsContext.js\":\"01eff9723c2cb89a\",\"/knowledge-medium/pr-preview/pr-1814/src/context/propertyDisplay.js\":\"8c622b227a1590b6\",\"/knowledge-medium/pr-preview/pr-1814/src/context/repo.js\":\"1c4767060015f6de\",\"/knowledge-medium/pr-preview/pr-1814/src/data/aliasClaim.js\":\"c69456a9596766af\",\"/knowledge-medium/pr-preview/pr-1814/src/data/aliasSeatNamespace.js\":\"47eb9277faf487e1\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/blockData.js\":\"0973adf450206c54\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/blockType.js\":\"2c48c14169c06e3a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/changeScope.js\":\"d11739eafb0306f0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/codecs.js\":\"3b9f7323952bbada\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/derivedData.js\":\"8dd8d22c2a9aacd2\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/errors.js\":\"42f620ba7f6cdf36\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/events.js\":\"c68e19847ade7aec\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/handle.js\":\"293052474c0101b5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/index.js\":\"b0cbc488046d99a7\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/mutator.js\":\"c0ed212d04fe0863\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/processor.js\":\"561415d40efc113b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/propertySchema.js\":\"84a1611a5aeddd3c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/query.js\":\"3c61737aa2baf2da\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/sameTxProcessor.js\":\"4cff7562a93e97d2\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/schema.js\":\"293052474c0101b5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/tx.js\":\"293052474c0101b5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/typedBlockQuery.js\":\"fe41a0acc9de8ec1\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/user.js\":\"9e7c943c88e777da\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/valuePresetCore.js\":\"9a857888cca22db5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/valuePresets.js\":\"607aa40c48c39ab2\",\"/knowledge-medium/pr-preview/pr-1814/src/data/attachmentCleanerIOVerb.js\":\"1a140b9a7e0350d4\",\"/knowledge-medium/pr-preview/pr-1814/src/data/block.js\":\"c41d767403492097\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockCache.js\":\"a750143b1ab1ee3d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockId.js\":\"a46a4f424de5299e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockLiveness.js\":\"6eeb0ca2a45e9e92\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockMerge.js\":\"2b49b97e21b39d72\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockSchema.js\":\"88ac81b06345608f\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockTypes.js\":\"f84c0327c2e9d0a1\",\"/knowledge-medium/pr-preview/pr-1814/src/data/clientContext.js\":\"4b1cdb31b5645dc6\",\"/knowledge-medium/pr-preview/pr-1814/src/data/dbFileSiblings.js\":\"5150fa77e7664c70\",\"/knowledge-medium/pr-preview/pr-1814/src/data/definitionSeeds.js\":\"336c01438f8db663\",\"/knowledge-medium/pr-preview/pr-1814/src/data/derivedIds.js\":\"2500e66fff79e48a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/drawnSubtree.js\":\"7673b1a47ff1c1dd\",\"/knowledge-medium/pr-preview/pr-1814/src/data/facetBridge.js\":\"31a8ffdabf9aeb4b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/facets.js\":\"0d25e1629d728bc7\",\"/knowledge-medium/pr-preview/pr-1814/src/data/globalState.js\":\"e4b0cf3cf4cf1662\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/aliasClaimRederiveProcessor.js\":\"bead0b2a3ac9d803\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/ancestorBatch.js\":\"8f6bccf5db6b798b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/blockTypeTypeifyProcessor.js\":\"6a8743cdb726010b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/clientSchema.js\":\"edb7d7ee34eca9a4\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/commitPipeline.js\":\"85bde767976eb1f4\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/devAssertions.js\":\"20f01c64548e1db3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/firstSync.js\":\"f2f38cdd94d74f99\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/freshInitialLoad.js\":\"68ac294bb748bcf3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/graphBackfillClaim.js\":\"42b49ecfe0d3f0b6\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/handleStore.js\":\"4ca982229610cd58\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/idleMarkerJobs.js\":\"a05d2262159b413a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/initialDownload.js\":\"b7943c5b6ee89bef\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/initializeClientDatabase.js\":\"1008c9cc4529d394\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/jsonCanonical.js\":\"3a0da5823723bb05\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/kernelInvalidation.js\":\"166f374d38569bb1\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/kernelProcessors.js\":\"ab3a0442e6bcbcd3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/kernelQueries.js\":\"bea5e6f6da6b0a20\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/mergeTypeMembershipProcessor.js\":\"d3c0ded0999c13e3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/normalizeReferencesProcessor.js\":\"db7559b80b104ea5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/poolInstrumentation.js\":\"20a2f82bd60ba22b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/processorRunner.js\":\"b4dbbd7c0f181341\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyCellBackfill.js\":\"48da5e371c03b300\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyChildMint.js\":\"ef29f8e3d8cd5524\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyChildrenProcessor.js\":\"b5db678d759ebed0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4cbd115544711d8d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyDefinitionSynthesis.js\":\"aab7c3f103a8c7c1\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyKeyScan.js\":\"9eb07088ac6c1445\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertySchemaResolution.js\":\"7bfe84104f0e0faa\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyValueEdits.js\":\"25fc1911e54a76a8\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/raiseProtocol.js\":\"3aeb4e15fb31698d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/readBatch.js\":\"18aab25f9a4c882c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/refProjection.js\":\"947de3344146f1ee\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/referenceTargetLookups.js\":\"dda5dec4bc447b3f\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/referenceTargetProcessor.js\":\"e90f5bcface0e5a4\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/replayMerge.js\":\"7ff60addeac66c46\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/sqlBinds.js\":\"18c4e670f8f76754\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"220015e8feb124d3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/arrivalProcessors.js\":\"9c21e52d7b48d505\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/invalidate.js\":\"b4af34e5846f21ba\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/materialize.js\":\"c070ef68ae80c0aa\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/observer.js\":\"0ce3917923b4193a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/reconcile.js\":\"292ddf3a0d686bb0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/timingMetrics.js\":\"683ba5d48c1839d8\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/treeQueries.js\":\"518561d5c388dc26\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/txEngine.js\":\"2ad2e2fd036a008b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/txSnapshots.js\":\"7fc9afbe116e48d0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/typedBlockQuery.js\":\"abd0c1f07a299672\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/undoManager.js\":\"f78c92af859c515d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/invalidation.js\":\"755387ab82bb4629\",\"/knowledge-medium/pr-preview/pr-1814/src/data/kernelDataExtension.js\":\"7e2001c3f54dce7c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/kernelPage.js\":\"486daf8297358bb3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/kernelValuePresetCores.js\":\"905ee85fbb6f383c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/localDbCorruptionSignal.js\":\"48f57f3153caf5d3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/localDbStorage.js\":\"2e4d7889e6bd15e2\",\"/knowledge-medium/pr-preview/pr-1814/src/data/localDbVfs.js\":\"d51f811be867cbd4\",\"/knowledge-medium/pr-preview/pr-1814/src/data/localSchema.js\":\"736f24ca008bac8b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/maintenance.js\":\"8b1cc2eea3ffba37\",\"/knowledge-medium/pr-preview/pr-1814/src/data/mergeProperties.js\":\"f81063f9fd7432f4\",\"/knowledge-medium/pr-preview/pr-1814/src/data/metricsConsoleHook.js\":\"32d828bac123cb9a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/migrationsPage.js\":\"b379e403b2c8dc48\",\"/knowledge-medium/pr-preview/pr-1814/src/data/mutators.js\":\"2a4c32a8ab2b9185\",\"/knowledge-medium/pr-preview/pr-1814/src/data/orderKey.js\":\"113accfe1ac3ec35\",\"/knowledge-medium/pr-preview/pr-1814/src/data/orderKeyPlacement.js\":\"627035eb482b62de\",\"/knowledge-medium/pr-preview/pr-1814/src/data/outlineSurface.js\":\"f3193c672c51032e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/pendingEditorContent.js\":\"106ab9672ca6a8f3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/pendingUploadsSql.js\":\"abee76b2e3ed4894\",\"/knowledge-medium/pr-preview/pr-1814/src/data/pluginStateExtensions.js\":\"ec748508ea7344f5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/powerSyncLogger.js\":\"4a0e2b9db945c5a3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/projectorRuntime.js\":\"6b33afa1877b0220\",\"/knowledge-medium/pr-preview/pr-1814/src/data/properties.js\":\"f881c528d2c4afab\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertiesPage.js\":\"ae4d88f1a1a05723\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyChildren.js\":\"105bc4d163e2c971\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyDefinitionFanout.js\":\"c93fb9e7b4042a41\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyDefinitionMetadata.js\":\"1b1df630d26b5949\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyDefinitionRegistry.js\":\"3a83be7ae685af65\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyDisplayMode.js\":\"20b6a491f2430698\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyRowCreation.js\":\"30eea0d41d68d0ca\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertySchemaCreation.js\":\"9c9bff5ba1a55a51\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertySeeds.js\":\"eb979271a6d0dbdd\",\"/knowledge-medium/pr-preview/pr-1814/src/data/recentsPage.js\":\"92381f59186096ab\",\"/knowledge-medium/pr-preview/pr-1814/src/data/referenceBlock.js\":\"2ae2ca0425ea54aa\",\"/knowledge-medium/pr-preview/pr-1814/src/data/rejectedUploads.js\":\"8ce72a51a3bd2243\",\"/knowledge-medium/pr-preview/pr-1814/src/data/releasePowerSyncConnection.js\":\"80a60510be052d30\",\"/knowledge-medium/pr-preview/pr-1814/src/data/repo.js\":\"bee02cd01e16e2b2\",\"/knowledge-medium/pr-preview/pr-1814/src/data/repoProvider.js\":\"01b6e929691fca1c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/rowProperty.js\":\"c1e4f9f4b4c0461a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/searchFilter.js\":\"4ee2e27c0166f68f\",\"/knowledge-medium/pr-preview/pr-1814/src/data/seedIdentityLedger.js\":\"dec236c56b6772ae\",\"/knowledge-medium/pr-preview/pr-1814/src/data/stateBlocks.js\":\"61cde9588b4c0002\",\"/knowledge-medium/pr-preview/pr-1814/src/data/structuralEditPolicy.js\":\"1ae366a6fb8c1939\",\"/knowledge-medium/pr-preview/pr-1814/src/data/subtreeDelete.js\":\"90e70b6d9e85a3a4\",\"/knowledge-medium/pr-preview/pr-1814/src/data/syncStreamLock.js\":\"cd7580e9cf5b6496\",\"/knowledge-medium/pr-preview/pr-1814/src/data/syncedTableSqlRecognizer.js\":\"a877ac4f40e55f84\",\"/knowledge-medium/pr-preview/pr-1814/src/data/syncedTableWriteGuard.js\":\"73c18f837385156e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/targets.js\":\"efe937acfb4b0d5a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeColors.js\":\"a3c31f8527048d55\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeDefinitionMetadata.js\":\"0e26fdb7a0a7e30d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeDefinitionRegistry.js\":\"3998f003b8b15bb0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeExtraction.js\":\"7588f08b1a0459d5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeInitialValues.js\":\"0e6fbcd446020013\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typePropertyGroups.js\":\"748c66ab0613a1ae\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeSeeds.js\":\"527431be220732d0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeTagger.js\":\"cec89a3236f7e31e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typedRecords.js\":\"baae59bbfd3ed983\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typesPage.js\":\"1e061ac50f2df790\",\"/knowledge-medium/pr-preview/pr-1814/src/data/userPrefs.js\":\"4466a1161fe61b6d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/userSchemasService.js\":\"2b8f680b82c17202\",\"/knowledge-medium/pr-preview/pr-1814/src/data/userTypesService.js\":\"a115ef13b1e76ae1\",\"/knowledge-medium/pr-preview/pr-1814/src/data/valuePresetRegistry.js\":\"d7e67069e18310f7\",\"/knowledge-medium/pr-preview/pr-1814/src/data/visibleChildren.js\":\"6b3f97acbe915919\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaceConversion.js\":\"3515ce19fdf614d9\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaceFirstSync.js\":\"87d5f6262aedb39a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaceIdNamespace.js\":\"20fe4fc3f221cd67\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaceSchema.js\":\"c151d792bf04e27e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaces.js\":\"931dcc2993cc03f9\",\"/knowledge-medium/pr-preview/pr-1814/src/data/writeAheadLog.js\":\"c50fcaf91b7ea8b0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/BlockPasteShellDecorator.js\":\"f6453cb8f700aa91\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/atTrigger.js\":\"ecc091550dd8d15a\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/autocomplete.js\":\"a4eb6f976619fa23\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/codeMirrorExtensions.js\":\"9e020e3678805152\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/contentFlush.js\":\"596d27d13321204b\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/defaultInteractions.js\":\"04a61b87a5aa51f6\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/editSettleSignal.js\":\"a3b184fddc2f6229\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/insertImage.js\":\"a747e79ff002b4f1\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/referenceCompletionRange.js\":\"bf24d593c874f860\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/referenceTargetTypes.js\":\"b9b4b7d6aed504df\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/syntaxContext.js\":\"b5f2c9a019187cfb\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/triggerMatch.js\":\"a25b95ee847a03d4\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/AppRuntimeProvider.js\":\"cf8c2d8e4084bddb\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/BlockFocusShellDecorator.js\":\"f90305dc92b0ad49\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/ExtensionRenderBoundary.js\":\"eda49287aa7ab340\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/PanelContentRecovery.js\":\"cca4db20fabafcff\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/apiCatalog.js\":\"7f8671ffdd313156\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/approveExtensionHere.js\":\"723f6bd658bd4431\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/armedCutAppMount.js\":\"7371686b9e86ba5d\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/batchableKeyedStore.js\":\"31008d7769160e22\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/blockInteraction.js\":\"63158f12f9b5dc76\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/blockSelectionAction.js\":\"8e154da3647c7fe5\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/compileExtensionModule.js\":\"7cd804517c62f485\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/compiledModuleCache.js\":\"82756995a19a0c3c\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/continuousGestures.js\":\"92d20e1941c1ea89\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/core.js\":\"980d0166157f2100\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/defaultRenderers.js\":\"5de76db39c7c5d29\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/definitionFanoutAppMount.js\":\"9336b9aab4b88b5e\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/dialogAppMount.js\":\"4dd5952c35cd4fa0\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/dynamicExtensionSeeds.js\":\"6d6eb9c262c8504e\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/dynamicExtensions.js\":\"c9e8cd8ebdcfe2e4\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/exampleExtensions.js\":\"3f0a02e7e22d2b8a\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionApprovalStatus.js\":\"ace72ac1af2b9d43\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionLoadErrorToast.js\":\"e5b7574a4c6b697e\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionLoadErrors.js\":\"d9ab2bc229bf4bb5\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionLookup.js\":\"596bcda115e42e64\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionToggles.js\":\"4b44ad356624ef78\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionUtilitiesCss.js\":\"29776b72ca75b2d0\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/kernelPageDeletionGuard.js\":\"f9c217d4c5d50c2a\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/liveRuntime.js\":\"14d059e9f60cfee4\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/openExtensionsSettings.js\":\"8c405a5cdef272d9\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/overridesCache.js\":\"6853c08b926fda49\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/pluginIds.js\":\"3c301e37a8ede41f\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/processorRejectionToast.js\":\"e4aba9d866f96b64\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/runtimeActions.js\":\"05a44772ed5109de\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/runtimeContext.js\":\"dd9c665be8c13f74\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/staticAppExtensions.js\":\"a307dab567e61da2\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/staticDataExtensions.js\":\"4a9c4212597a14ac\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/toastAppMount.js\":\"afcff7d866dd2cd0\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/useOverrides.js\":\"81f48fb43f37f41d\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/useShortcutSurfaceActivations.js\":\"a1377c4676ab892e\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/discoverToggleTree.js\":\"00824b2ce1939b84\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/facet.js\":\"4ce8f0a9d90846fa\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/resolveAppRuntime.js\":\"878a2d44fc1619f5\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/runtimeEvents.js\":\"c7ba7968c8abeedc\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/togglable.js\":\"91d5bac8562de365\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/variantFacet.js\":\"011e66f37c25899e\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/verbFacet.js\":\"07b5c9c47bc3d851\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/block.js\":\"9fe10311cba4ec93\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/focusedChild.js\":\"fc6b82e4bca151a2\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/propertySchemas.js\":\"325bdb43d0c15819\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/typeRegistry.js\":\"a9a406dbde7f9297\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useAncestorCrumbs.js\":\"ceb917ae9de85a0a\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useAutocompleteListbox.js\":\"004602a2e7447fe3\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useDebouncedSearch.js\":\"4a68a59a9f9560aa\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useDebouncedValue.js\":\"4cc3b9fae003ebec\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useIsFocalRender.js\":\"ffaaada85f536f3c\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useIsReadOnly.js\":\"69c2f581d60be7d5\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useMaterializeBacklog.js\":\"c451fd37e5e99e09\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useMinuteClock.js\":\"ebed01128d36750e\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/usePanelLayoutProjection.js\":\"8573675e3c1d343b\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/usePendingInvitations.js\":\"280ecb407bfdf467\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useRendererRegistry.js\":\"e09f0964b0599a5e\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useRetainedFieldRows.js\":\"92d2dd3c07e0ba33\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useWorkspaces.js\":\"d5367b2fad2815f4\",\"/knowledge-medium/pr-preview/pr-1814/src/lib/utils.js\":\"13ebb3c5efaa1fa0\",\"/knowledge-medium/pr-preview/pr-1814/src/main.js\":\"9b0103a0ea084bbb\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/MarkdownImage.js\":\"8da7c3d6433afe99\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/blockSeparators.js\":\"6ff1124c53dad61b\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/context.js\":\"44b160341ba6a34a\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/defaultMarkdownExtension.js\":\"b96294a8c4d6fb18\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/extensions.js\":\"f847c76ffb6294f0\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/renderMarkdownHtml.js\":\"113ec46a47f05c74\",\"/knowledge-medium/pr-preview/pr-1814/src/minimal-editor.js\":\"4c56286609a956ce\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/armedCut.js\":\"3111068a7549113e\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/captureMediaVerb.js\":\"4a889a60b4e31a33\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/clipboard.js\":\"e6f2aa7cbae9108f\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/decision.js\":\"a607813bcc8cf3c6\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/operations.js\":\"52900da865ca4b23\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/account-header/AccountHeaderItem.js\":\"2986811a613e17fc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/account-header/index.js\":\"3a477a76d09fc04a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ced5c030a0234522\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/askAgent.js\":\"fe10b97d9097d9ab\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/askedStore.js\":\"867bcd84c20a17f8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"99e561183e747b28\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/chipState.js\":\"110e5f9f1e786cc7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/dataExtension.js\":\"976155c6986b16bf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/index.js\":\"32b794d4cd93a58e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"27e35dfb8ea29a38\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/schema.js\":\"ac35b87596a67664\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9169cd1a951a4e98\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2cb7597b7a22cba3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/addMedia.js\":\"502f7575a4ce59bd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c1d9460306d50e42\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/block.js\":\"3dfa0204c9d116e2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/context.js\":\"af4758eb5d4b7d38\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ce4c2e8bdabf8f2e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/index.js\":\"a003f0f277dd6d0c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/outline.js\":\"50b4d2c9662a84fa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/properties.js\":\"ed66c04b643a5b3e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/refs.js\":\"c6c3abf3e86a2750\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6d14fdb55d979453\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/search.js\":\"8c8a44de0256ad5c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/shared.js\":\"ada7185c91a819a2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2c291d6223abfce6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/text.js\":\"eabfffbca8bcc553\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentWrites.js\":\"21bb79ab7f89cd55\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/authoringCatalog.js\":\"f4f93b8b97ca18ba\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/blockRefTargets.js\":\"930165e3158a28f7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/bridge.js\":\"0ab64aec4efefbbc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/bridgeLoop.js\":\"8e53a241e1139aec\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/changeHistory.js\":\"af305636405bb589\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/commands.js\":\"297ff61d87b0f669\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/commentsCommands.js\":\"7e2a19e2863a46eb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/dataExtension.js\":\"7ebcfa8a05971dbd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/dataModelGuide.js\":\"966fd326d3c1408d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/describeRuntime.js\":\"f79c0eb62ef6c1de\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/extensionLint.js\":\"05777dd67f13d406\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/grainAudit.js\":\"1b54570bb389800e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/healthCommand.js\":\"5703ec9588ee355d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/index.js\":\"fb52f06fb5451f6a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/presetIdentity.js\":\"b6bad754ef8561a6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a58c99688506014a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/readMedia.js\":\"d5957e69405207b4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/schema.js\":\"709c67839ab147dd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/serialization.js\":\"9ae2a3aee78862b1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/targets.js\":\"7ba59d91afeb302a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/tokens.js\":\"2b7b5726fd07aeb8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/watchEvents.js\":\"3503c8278f6792f4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/workspaceGuard.js\":\"0e2bd0ec4323e628\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/writeCommands.js\":\"1ed67f88304ffb9d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/AliasCollisionToast.js\":\"e8c71f7cc76af3bc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/DuplicateNameBanner.js\":\"a8e486c913f500a3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/collisionMerge.js\":\"d24dbfcb5e32cf1e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/dataExtension.js\":\"578330ae12775706\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/index.js\":\"c872e168b033751c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/mergeCollisionAction.js\":\"2f3ab791f6e61ada\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/pageStyling.js\":\"f838526e8f6d1b3e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/rejectionToast.js\":\"e974fea2bffb7213\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/syncProcessor.js\":\"3c5481c382e3b1e6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/actions.js\":\"d9555206047e2dfc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/addComment.js\":\"84a06b194348ee61\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/anchor.js\":\"abca823f66313e72\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/anchorState.js\":\"290e884c609296d4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/commentLinks.js\":\"3219b477d5afdfb4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/confirmThreadDeletion.js\":\"921bb91f8a211125\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/container.js\":\"b013c661806cd04a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/dataExtension.js\":\"7c8a3ac6ad174ea9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/deleteComment.js\":\"2f849436508f7a93\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/highlights.js\":\"76dcd91bbf02182f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/index.js\":\"351a6380ab734a81\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/linkedCommentsPill.js\":\"2aef6fa3f385ab9b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/margin.js\":\"aad6da7004b0aadd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/marginSchema.js\":\"d9ae2b5c900b637f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/newComment.js\":\"da5bedc9f7cf1f49\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/ownThreadPicker.js\":\"5692d72f68f38216\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/placement.js\":\"e6106190d6067b51\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/queries.js\":\"cc57dcc3677e74db\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/quotePosition.js\":\"e3fcf1e6487f74a7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/quotedIn.js\":\"5741bcf08ad8e90a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/quotedRange.js\":\"425c2a257babe9a4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/rangeRefs.js\":\"35a47127d8c50090\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/readHighlights.js\":\"927905ab4938eac9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/readSelection.js\":\"66bc8814ccff0647\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/readSelectionUi.js\":\"9cc41c892085fa52\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/reanchor.js\":\"34bdf30953b1e8e9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/schema.js\":\"9038b6b0267898a5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/scope.js\":\"1072c8154b354744\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/scopeThreads.js\":\"4635f8837a083b87\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/splitRetarget.js\":\"4b01716cb526174a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/suggestionCard.js\":\"f2250dbac6fb0e6e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/suggestions.js\":\"9b39fa07eb548df3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/summaries.js\":\"55c4dbb49d95b4a6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/summaryBatch.js\":\"1b2f69f8933f11f2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/surface.js\":\"9d238bd05cb52f65\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/threadNavigation.js\":\"71ecd1808de048d1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/threads.js\":\"9f120b0410e45211\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/ui.js\":\"d26940dad79f8b84\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/uiStore.js\":\"e95114bc13cc16d9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/app-intents/appIntents.js\":\"d5f78365392dadea\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/app-intents/index.js\":\"fb6b3f60149d3c6b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/app-update-prompt/index.js\":\"57351cb2512feb6f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/app-update-prompt/status.js\":\"b3a74a8f75faefce\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ec8c42aa4393ba90\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/MediaBlockRenderer.js\":\"0ea3227ca2693b1a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c05b9922ec4b40dc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/MediaUploadReconciler.js\":\"5d78ee68bcfa62ec\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/assetDownLane.js\":\"339f9fe770cf727a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/assetResolver.js\":\"f9a1840322f5e0fa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/assetUpload.js\":\"82f9c6d33cdf4153\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/attachmentCleanerIO.js\":\"52033215976f1a24\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e534ff961258426d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/blobStore.js\":\"453cbd87cf064250\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/byteStore.js\":\"c0a4c039e4032f5b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/cleanerIO.js\":\"a0f3472cbea7f4dd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/cleanupAttachments.js\":\"a33305e3169a23cc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/dataExtension.js\":\"b6ecdb6c6305e94f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/downLane.js\":\"fa7bd62ba2dc4a6d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/index.js\":\"8fd467a4183521bf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/insertImageContribution.js\":\"0071a9ebd9e058ec\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/laneArming.js\":\"b9d0bbeb180d1f7a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/laneLock.js\":\"45f88faee4f7ea2d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/mediaBlock.js\":\"45ef8e459bacd09d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/mediaCapture.js\":\"4c55bdd9dae1cc62\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/mediaViewers.js\":\"c13bff218a31dfce\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/mediaViewersFacet.js\":\"aa11a4d2e4d56515\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/pasteCapture.js\":\"d5d0bea4a4cc5c64\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/resolver.js\":\"0fea69ed83a9e8c0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/retryUploadsAction.js\":\"06a62f8230f91b1f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/storagePaths.js\":\"09e053d99d781eed\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadDrain.js\":\"552ef317937ca421\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadLaneStatus.js\":\"22babc47ed02e6ee\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadReconcile.js\":\"e1c84c63b2097e7d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadRecovery.js\":\"d8efe22dfca11342\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadStore.js\":\"239946b89b67a66d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/useAssetObjectUrl.js\":\"c3933c9bdf2ef196\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"879e8bc9e17da35b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/BacklinksViewSection.js\":\"622dd01f327eff67\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/facet.js\":\"d1dfdcc6742011a7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/index.js\":\"05ede857d70aca26\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/prop.js\":\"0d562f75de7e672f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/BacklinkFilters.js\":\"ad89aa5374eafb9c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c265797bb71ee0bd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/BlockEntry.js\":\"fcf57b2d6008e73b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/LinkedReferences.js\":\"ec348a31da10bba9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0cc7232044783af2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/dailyNoteDefaults.js\":\"b6f5bacb418e9834\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/dataExtension.js\":\"ab8e9e55184d015c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/edgeExclusions.js\":\"bbabb1ddaf438007\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/filterProperty.js\":\"039a96b5dbcf9042\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/index.js\":\"9da97c81b36aa2fd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"49b1bf03ec426b7b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/applies.js\":\"53b00de6547d235a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/countQuery.js\":\"4194779dacfadf76\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6d1822e28c48cdcb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/index.js\":\"735cc27341eaf35e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"092fba9653754851\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/presentationInvalidation.js\":\"d5087e5f9eff52bd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/propertyEditorOverride.js\":\"03b2898e0b81338b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/propertyFilter.js\":\"974c906459b4f93c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/query.js\":\"21ad5f4b8f0377a0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/resolveFilter.js\":\"2291a4ce8f35a6a3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/sourceBatch.js\":\"4f552f3b87cba3ca\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/sources.js\":\"05a23c2838f9c2ab\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/useBacklinks.js\":\"6dc3ebf7703450c7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"74560b1a25528d68\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/BirthdayCelebration.js\":\"bad058e426223ef6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/BirthdayOverlay.js\":\"02b48ce696e4c97a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/gate.js\":\"3ecc5e0db915e450\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/index.js\":\"42a39aeafb65fb7f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/wolfTheme.js\":\"89f99b25a9238974\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/BlockDragLayer.js\":\"486b0c341883ea85\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/dragController.js\":\"442435f65a7c644f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/dropTarget.js\":\"38bff7208a189368\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/index.js\":\"a9516548b81de99f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/projection.js\":\"17a4e711e7d372cc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-info/BlockMetaCard.js\":\"ec6aeca2dd0d744a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-info/index.js\":\"9e9acf04f9710a49\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/AddTagDialog.js\":\"ee20274908b93d75\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6a9a551ba2298da3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/TagNameIssueHint.js\":\"09de4fb40618ad6f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/addTagAction.js\":\"e963e8dacf8b5168\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/appendTag.js\":\"8188afd3adf7051f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/config.js\":\"75a5a5e6b0d3b6bd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/dataExtension.js\":\"b5edde0aa06b7aa0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/index.js\":\"318b54e73bad6545\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/propertyEditorOverride.js\":\"afc09b9bb179b8ff\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2c8269abe7ebefe7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"729177caef464b6a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/Breadcrumbs.js\":\"7e8e56c03040961a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ace1b3895f040049\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1c47cf0cf0173601\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/index.js\":\"8e61e83a7ada4227\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"862c43205fefa114\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/CharacterCountItem.js\":\"a8b7163ed14bd566\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1b5b988e6abcad79\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/actions.js\":\"8563df9249430a7f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/blockType.js\":\"9dafed9991aaa2af\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/charCount.js\":\"82e5e2ebd2e345bd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/dataExtension.js\":\"400145d15787ca18\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/index.js\":\"d39396b7ab65e816\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/profiles.js\":\"759e953eaad3181b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/properties.js\":\"3a5488e541497266\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/textCounts.js\":\"f455d946204c837a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/colemak-keybindings/index.js\":\"049180da00ef8c49\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/CommandPalette.js\":\"889a0c85d1013c0c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/HeaderItem.js\":\"c43bcc3a17df1e0c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/context.js\":\"db460c12d2420f7f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/index.js\":\"4ec1e1bb04a1fe61\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/selection.js\":\"8b67290f90fec57c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/toggleStore.js\":\"2d69ab32c9a0d13b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/useCommandPaletteActions.js\":\"2698ecfdec289349\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/ContributorBadges.js\":\"1fadce5d87242dbc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/author.js\":\"e8c7a67aff310445\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/codeMirrorExtensions.js\":\"e63761acaf952ef3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/dataExtension.js\":\"4e1648c87e02b182\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/index.js\":\"d48e35ab60531a96\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/mentionAutocomplete.js\":\"b5ce9d2da49975fe\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/processor.js\":\"8aab2b7a42fde5d4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/profiles.js\":\"ec42fd1b0a54414c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/queries.js\":\"2e4dbf96acbf42f1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/schema.js\":\"44e182ff2e118829\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ad57f8a3126d2144\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c990447ec1c153dd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/index.js\":\"bc1ff5f3935f5014\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c9ea2868b8e8bf57\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"77f7d7cdc35835f9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/CalendarGrid.js\":\"a9ef1f4f7662e57f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/DailyNotePicker.js\":\"32b07f06e96c94aa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"308628ed0a9ae510\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/DateNavDecorator.js\":\"1498b8858099c877\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/DateScrubOverlay.js\":\"f2838d5cf078cecd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/HeaderItem.js\":\"77a1c552889be8a2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/ReschedulePicker.js\":\"8f10f15efc1b3321\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1f941843713ba3f5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/actions.js\":\"efb5fa75baf5dc27\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/blockDateAdapter.js\":\"88c88cd8432bd44a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/calendar.js\":\"577bb5f25c00de07\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dailyNotes.js\":\"b89586e6b44bce73\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dataExtension.js\":\"9e43c1eb309cf0eb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dateScrubActions.js\":\"18aa7a41c11c21e9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dateScrubGesture.js\":\"46267bce5c5ad38d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d163ab553def6cf5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3b0c6dd1e3807455\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/deletionGuard.js\":\"8fae712407ac1dfc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dueQuery.js\":\"e4e2710e3e32a4a4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/index.js\":\"a05615da491fec30\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/landing.js\":\"a33f64c0626419c7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/localSchema.js\":\"3fce724102fa9a3e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/referenceDateAdapter.js\":\"b586d93db11bce8a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/rescheduleAction.js\":\"c8168e1b5eb4f497\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/schema.js\":\"142043932c1d97ab\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/spreadBlockDates.js\":\"0602397c652c0ca1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/spreadDatesAction.js\":\"3ff90ff50cd8060e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/today.js\":\"4e7c2909fc4668ab\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3c557a7f58b55a03\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a36016fefc283662\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/audit.js\":\"65873bc5c3cc5064\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/auditAction.js\":\"1c5a3e54466ba6fa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/auditRanges.js\":\"211f3180d98ca4ae\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/diagnosticsSource.js\":\"22e454d38f030397\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/divergenceScan.js\":\"d37b5816aed933ca\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/index.js\":\"e584c9705929e654\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6b6a8dbae1529dc7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/referencesMirror.js\":\"3b83eb3e3bd5c367\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/rowJson.js\":\"e805cabdabf4837b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/schedule.js\":\"2b30da659c4826d3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/store.js\":\"675207c83c9faa3a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-maintenance/action.js\":\"ec11d28a9fb78842\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-maintenance/index.js\":\"4d237704bdf2db83\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-maintenance/plugin.js\":\"e657bc7db526de90\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"edd17b92be418a0f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/actions.js\":\"1a4868dd9a1738be\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/changeMarker.js\":\"764a90702241c27c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/diagnostics.js\":\"b64e3719b48ab429\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/fileSystemAccess.js\":\"2f4a3fae33b21158\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/filenames.js\":\"d9aec3c97e0c84fd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/index.js\":\"401623e61182b912\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/mirror.js\":\"bb26a756487475a2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/runLock.js\":\"8064758e5cc1cac5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/runtimeHealth.js\":\"584a6eb2b7a5907d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/schedule.js\":\"188cce9097ff9c18\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/store.js\":\"64aff938d69192fd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/default-themes/index.js\":\"49f8c8b1f0b53adc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/default-themes/themes.js\":\"d2938306ff7ae077\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/diagnostics/facet.js\":\"0997ed325df61d80\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/diagnostics/useDiagnostics.js\":\"002bbdfc91624812\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extension-prompts/dismissals.js\":\"52cb2c15c6bc81e8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extension-prompts/index.js\":\"f5be709e9774d464\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extension-prompts/status.js\":\"b397e34b188356bf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extension-prompts/store.js\":\"768f11b49513d1ef\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"69820d717cf66df3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/ExtensionsSettings.js\":\"6274e90ea4dfbc98\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/actions.js\":\"b9837132ec283920\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/config.js\":\"e81ec91cef8a2620\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/dataExtension.js\":\"48bb6ba6753532e7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/effect.js\":\"2658adb5be511790\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/index.js\":\"5965df8a6e6d5a40\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7914746759c7ff52\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/useToggleTree.js\":\"6495a251c6501f67\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/ExtractTypeDialog.js\":\"5788953377177e12\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"da0bc19d786c83a9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/PropertyShapePicker.js\":\"cb87f0559c129754\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/action.js\":\"c02f678ce223afa5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/index.js\":\"eff09972d067a4dd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/FindReplaceDialog.js\":\"cb0342c3e2f69309\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/HeaderItem.js\":\"421dc6a625319da8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/dataExtension.js\":\"146713f6255c025c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/index.js\":\"96c3604728005aef\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/search.js\":\"d9314f75ca4d292d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/toggleStore.js\":\"33dc22bdfe095862\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/LocationPropertyEditor.js\":\"0c70a274d1c47f37\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/MapView.js\":\"7d5e86b397ccdbd4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/blockTypes.js\":\"d332eb8de247c00c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/codeMirrorExtensions.js\":\"2a31164568d51f43\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/createOrFindPlace.js\":\"0bd8ae9b76ff8913\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/currentLocation.js\":\"546b7116dc7c7315\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/dataExtension.js\":\"191b12d099c90f66\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/geoContentDecorator.js\":\"9936ebaf29c31bb3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/googlePlacesClient.js\":\"0d962e87e2f74aae\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/index.js\":\"aec2e9d55a281259\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/locationsPage.js\":\"978e26dfae0569dc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/mapViewport.js\":\"b121ae6108860c1b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/pickCurrentLocation.js\":\"7361f1f0564b3de0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/placeAutocomplete.js\":\"b53b2959879c9a0a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/placeNameCollision.js\":\"e8fd1e18a4fa3f7e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/properties.js\":\"046835617bd549bb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/propertyEditorOverrides.js\":\"0d1f87f26e5b9822\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/query.js\":\"495463c9a2c9ebf2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/usePlaceSearch.js\":\"e973efe4d1c12083\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d14b7d2d5c5c3a00\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9a037c4b69858b3d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b43cf1f7228527bd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/config.js\":\"636e3d015f1d4cc4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/dataExtension.js\":\"71857c2ff717cd19\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/facet.js\":\"afa9ac5af3317368\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/grouping.js\":\"c20650394718da8f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/index.js\":\"cd90f146c1315fa0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"937f691a4030c9a3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/query.js\":\"1f7c6103ed3d15c2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/resolveConfig.js\":\"a70b8b9568c54013\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bae0737e5c0dad3a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"bd8589a6b8c9ea97\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/HtmlDocumentContent.js\":\"f6fa0b2425f06827\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/HtmlFrame.js\":\"29be4d32fcd62d71\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/actions.js\":\"853be380d24cbd8e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/blockType.js\":\"bdf14048d3c00daa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/confirmRunScripts.js\":\"25ee18ab5c6733bc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/dataExtension.js\":\"a11d93771f676663\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/frameAnnotations.js\":\"e774c0c320bfee49\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/frameDocument.js\":\"0a7595f432217fb8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/frameTheme.js\":\"9be999456c18170d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/index.js\":\"bf657c4aa5419556\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/scriptConsent.js\":\"79184f71fc67337c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/sourceMap.js\":\"55efd6524d8ae57b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/useDocumentScripts.js\":\"68420e5f38e33706\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/index.js\":\"c61cd5b43304b61a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/record.js\":\"8e46943c744d6ebf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/recordStore.js\":\"d11cf12637e26379\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/responsiveness.js\":\"8361f8373fe11491\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/schedule.js\":\"15c8d29f784a5fd9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/sessionContext.js\":\"16bcd0d4d43b0ae0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"da25bbe35eabed54\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e6f60b1205c0ea59\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/actions.js\":\"c4b58f74c4c20d30\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/config.js\":\"6813454ed0fcdb33\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/dataExtension.js\":\"d719f73df6c3223a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/effect.js\":\"391a16a114b103eb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/index.js\":\"0e18c9dbae07f3c4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/keyCapture.js\":\"3a53028c0731cb00\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/overrideStore.js\":\"a1f1fea405870b24\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e1ba88051f06d13e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/HeaderItem.js\":\"13789b22bb050121\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/LeftSidebar.js\":\"fce6e715fd32a52e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/actions.js\":\"adcfd1373fcc8592\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/facet.js\":\"0c6ca5c78e4eead1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/index.js\":\"4a81c6afa99d42d1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/shortcuts.js\":\"7ff7d7c655c6610a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/toggleStore.js\":\"a41dccb1c9604d66\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/merge-blocks/MergePicker.js\":\"965366569ddcae7f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/merge-blocks/index.js\":\"5d9dc02d37fab0d8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/merge-blocks/mergeAction.js\":\"ccb4d837e0ff2521\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/merge-blocks/strategy.js\":\"5e78b8b9ef662b96\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/Button.js\":\"30cf8bce6ea17f9c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5037458818291e50\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/defaultItems.js\":\"c719c9476b7cbac5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/facet.js\":\"b3fde7b3bc19ecd9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/index.js\":\"c47f51f52547fe8e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"953118cbf83dcb71\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ae27bdcc6cb23f04\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9f5e1c39a70302fe\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/facet.js\":\"40bec6baffe98cdd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/index.js\":\"e8c770093bbc7c6a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5e5500fe2a067020\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e6573e43965933b0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/contextMenuItem.js\":\"a26bb5f84f78eabd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/index.js\":\"7fe6abcb7322d549\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/moveAction.js\":\"12aaa54b0b4dd568\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/moveBlocks.js\":\"dcd8697e128949d0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/selectionAfterMove.js\":\"8fff4c5687e9e28b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/TutorialBanner.js\":\"c65573d99885cf43\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/action.js\":\"7acfa74889eaf2c2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/bannerDismissal.js\":\"316cbeec1da10892\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/documents/cheatSheet.js\":\"fa20e0c8a6f6d0dc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/index.js\":\"c91723a18dfe6844\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/keys.js\":\"797aad07f9d47e92\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/landing.js\":\"de4e452459c45e46\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/outline.js\":\"fdf5ce7af1c1f2a3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/seed.js\":\"73eafd2ccf17c68e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a60a1c3996132c61\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/analyze.js\":\"7550144e364bed04\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/diagnosticsSource.js\":\"ee5756d386087ef2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/index.js\":\"139b8c822cd527f9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/load.js\":\"7256d24ffac0862a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/monitorRun.js\":\"f3d3f54ac87ee26c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/schedule.js\":\"4fb1fe59f25a8522\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/series.js\":\"b9629efda5647443\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/store.js\":\"171383787a3f16d8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/trendAction.js\":\"9e61cb6f14678e5f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/verdict.js\":\"53d58d06f09b21a8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/plain-outliner/clickToEditAction.js\":\"30eac10570a74ec9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/plain-outliner/index.js\":\"f383200f1bb60620\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/plain-outliner/interactions.js\":\"7b8c73ba831dae63\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c8247b241466eab1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/MigrationGate.js\":\"fe94a7b4a6ddcae5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/MigrationGateDialog.js\":\"432186b35c509d5e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/action.js\":\"bd6a71264572f047\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/index.js\":\"501590a5b31196f2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/localRunMessage.js\":\"054b2f2022a17346\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/plugin.js\":\"b7ead2ebcb078b97\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/progressReport.js\":\"a8393f70a3e24132\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/sweepProgress.js\":\"2ae6efee992c25b0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/FieldRowRenderer.js\":\"27dd6f5e074aa85b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/ValueRowRenderer.js\":\"6912e2e7d88a535e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/actions.js\":\"cd973632a8bb1946\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/autocomplete.js\":\"76fdf645628d1400\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/fieldRow.js\":\"02e3557e36599c8d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/index.js\":\"66e3042abeb29800\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/referenceWarning.js\":\"bacf3f84d74a083a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/valueAutocomplete.js\":\"b59b57f0e66e7a00\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/valueSchema.js\":\"df9a70abe8882561\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/HeaderItem.js\":\"19392ed1f341cce5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/QuickFind.js\":\"4460dc0ce6092776\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/index.js\":\"4311bbad905ab3a4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/recents.js\":\"67a55f39557d5e29\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/resultItems.js\":\"f2496c470b657fbd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/selection.js\":\"ea28a1b01a878c95\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/toggleStore.js\":\"1fb8d8ed4cc54fda\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/HeaderItem.js\":\"2396ea486026cc9d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c7f38832c1ad1503\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/grouping.js\":\"b3d3980ff1212fdf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/index.js\":\"9a398d2bd6642189\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/target.js\":\"f2d2e6e8da1c7e2c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/codeMirrorExtensions.js\":\"dfe3836d1eb78ead\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/contentPrefill.js\":\"ec4e99668d6f6356\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/dataExtension.js\":\"a582aaffa81bbe1d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/index.js\":\"d149926c5610de9e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b01b897ff9f1acbb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/invalidation.js\":\"c8b3163172ba2a51\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/localSchema.js\":\"02b5d7baf8ae02d4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/blockrefs/index.js\":\"28f7c9cca9900c89\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"840efb73dad00a83\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/index.js\":\"dd326c8705527f2b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/referenceNode.js\":\"5ade3323caa40228\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ff9c07ab6e56cfc2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3e3c1a9b3ada80dd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/wikilinks/index.js\":\"d05f610192dfa455\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c7398963aeeeeb93\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"602041e973774d7c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/mergeRetargetProcessor.js\":\"5bb8f330f8567418\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/parseFence.js\":\"3f345d33c2cb43fb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/referenceParser.js\":\"05bd9f642abfdbc2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/referenceProjection.js\":\"4c7f513ccc0d09f0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/referencesProcessor.js\":\"fe7b16cebe58f01c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/renameProcessor.js\":\"9fa489d5e6a4350c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/spanReplacement.js\":\"2d91b9f2097dcbe9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/rich-paste/htmlToOutline.js\":\"69c581c701de8e21\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/rich-paste/index.js\":\"804ad02c2e7d57d7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/rich-paste/normalizeClipboardDom.js\":\"26959291eec8f12a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/rich-paste/pasteDecision.js\":\"bf820b3d43dffe55\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/action.js\":\"490b3016e764988b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/blockIds.js\":\"74e64c85c1f81f53\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/content.js\":\"7b0e8effaf895c66\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/effect.js\":\"d3728ccd7792b987\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/ids.js\":\"ebb3128dcd0c113f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/import.js\":\"de8489ab112bbd4b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/index.js\":\"ac58a9831ac67f13\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/plan.js\":\"99a805a4733e09a2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/plugin.js\":\"3dc5efefae56acf4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/promotion.js\":\"2d108c7e8a44ba1d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/properties.js\":\"2f1ec553843dfb65\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/references.js\":\"61c3c2ad29a5b24d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/report.js\":\"c15f7eb800c7f6ae\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/roamMemo.js\":\"aef97ff0d8f7414a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/runtime.js\":\"16d496f9cc63929a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/schemaReconciliation.js\":\"122b34c083429c52\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/srsMarkers.js\":\"3adc891209002540\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/todo.js\":\"233a5a9e20eb0b81\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/typeCandidates.js\":\"a22c89a895d3845c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/types.js\":\"f867908e28b020f7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/search-health/index.js\":\"a5ad9dcbb7e1d218\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/search-health/store.js\":\"e8e419102da76225\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/HeaderItem.js\":\"aa98bde4335ef171\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ed61a47f47ada069\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/index.js\":\"664fb01572093a84\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/model.js\":\"7ae5a8ee779e562a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/toggleStore.js\":\"4e764a51a1f74d5b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/useKeyInspector.js\":\"0680b66f8a81bcd0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c9485fb582987705\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/ShellDecorator.js\":\"a97e9e5c16e23fa2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/actions.js\":\"ab49306037ccd70b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5e8b3be92550ee5c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/index.js\":\"c3840decb9d507d5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/shell.js\":\"c2f10a08a7e0ccbc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/surface.js\":\"94afc509a1198266\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/walker.js\":\"aa1e36fe9176088d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b785015a230580ed\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/dataExtension.js\":\"6016bc766e41bec6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/index.js\":\"b9197588936972de\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/indicator.js\":\"74eca4c3eb8e8230\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/moveSrsState.js\":\"dcc398f630c6b642\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"874b433a4bc0ba24\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/scheduler.js\":\"859b73b39e026fee\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/schema.js\":\"2e11473a69b0b82e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0cbbd8bce71a8baa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/srsClipboard.js\":\"8e197938b330ccdb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4343b83a8aaeada0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d969556a74b7f0b0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/DeckPicker.js\":\"c4b26fc5c81c4233\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/ReviewControls.js\":\"eaad9ef46d7d8763\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f1e0862a49290e24\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/ReviewSession.js\":\"b27068ce32036aaf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/actions.js\":\"716de4cfad376e72\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/archive.js\":\"2d5bfca47810463f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/dataExtension.js\":\"f08ebcce360ea5bb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/deck.js\":\"4fb18a357e6c579e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/dueQuery.js\":\"7728b6ced5c29132\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/gradeDecision.js\":\"d117c0845b7ce3e9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/index.js\":\"5d73febb9239250c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/keyHints.js\":\"de14652f4c53009f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/reviewCardLayout.js\":\"585efe1b8a742430\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/reviewProgress.js\":\"4d5bce0ebe407f34\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/schema.js\":\"1e16bdffc19b2353\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/useDueCards.js\":\"6367b2a0d4769c70\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/startup-metrics/index.js\":\"68f11151e0b520eb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/startup-metrics/record.js\":\"47971168ec7d3dcf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/storage-persistence/index.js\":\"bc6d9ad617351e72\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/storage-persistence/persistenceStatus.js\":\"d9f87dc83252c790\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/storage-persistence/requestAction.js\":\"67d17d9fdd19579c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/supertags/TypeChipsDecorator.js\":\"f02abf99efde6068\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/supertags/codeMirrorExtensions.js\":\"22ecdd1907e035f7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/supertags/index.js\":\"68a3bc78203d84f4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/supertags/typeAutocomplete.js\":\"6c50f332fee1a905\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a22049554e801a69\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/actions.js\":\"c02af12e86e7a57e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/anchor.js\":\"11ceb89ecedc2ae1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/events.js\":\"788a5f7ae7de0075\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/gestureActions.js\":\"752ec61cfae858b9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/index.js\":\"89b74d11bad49dea\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"03d8a486a479ad5a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/sync-metrics/collect.js\":\"33dda71c290d2420\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/sync-metrics/index.js\":\"179e736cf35b5c3d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/sync-metrics/record.js\":\"7376f2883d44f6a2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/RejectionDialog.js\":\"cb43b7c416cc4a7d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/SystemStatusHeaderItem.js\":\"305aed1e8b1e0638\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/index.js\":\"69922002dd89e594\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/model.js\":\"be013f32af2b5853\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/queueCounts.js\":\"e8ab962c3d40fe02\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/rejectedHelpers.js\":\"199221950f54156b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/rematerializeAction.js\":\"c95ec6a7ee508a7c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/useHysteresis.js\":\"811c6cf20eb37614\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/theme-toggle/effect.js\":\"4f589b2e2dabcea3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/theme-toggle/index.js\":\"eae9f3d147195509\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/theme-toggle/theme.js\":\"a7c3e49796bc1b18\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/todo/actions.js\":\"a27199833064b87b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/todo/dataExtension.js\":\"bc8d1c310a890962\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/todo/index.js\":\"e1eb97684390dd90\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/todo/schema.js\":\"0dbaf0a52865efdd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d2fe942b0a058eec\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/actions.js\":\"b1aa3a6a43a1d237\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/defaultItems.js\":\"7ec9a6fc17ccf6dc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/facet.js\":\"6fe774fab6d68622\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/holdRecognizer.js\":\"7bf23430815d921f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/index.js\":\"4936c22e8e5983a0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/update-indicator/UpdateIndicator.js\":\"674840c17340ebfd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/update-indicator/index.js\":\"ca41467e35d00a5e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/update-indicator/loadTimes.js\":\"a012a89578409c1d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/VideoNotesRenderer.js\":\"18a78d675253a998\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/VideoPlayerRenderer.js\":\"a294c3797a105c06\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/VideoTimeStamp.js\":\"c20f31d44b006649\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/actions.js\":\"e39f0a200198ae2c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/index.js\":\"59e3d916d4216e68\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/markdown.js\":\"0b0aecfc11a86b95\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/notes.js\":\"16067d6b5e567974\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/registry.js\":\"ecf93c52317b6875\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/remark-timestamps.js\":\"1b16df81bc5df3d7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/view.js\":\"a5df8b195deba4e8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-link-hints/LinkHints.js\":\"eddf2035ded7fa3a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-link-hints/index.js\":\"66b848ac542ddd41\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-link-hints/model.js\":\"b4e87d83d91d7038\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-link-hints/settings.js\":\"d32659344dac2dd3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-normal-mode/actions.js\":\"e6ad6aa6a5c449cb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-normal-mode/index.js\":\"24398c98b1aaf8a5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-normal-mode/interactions.js\":\"9381483f57caee42\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/workspace-header/index.js\":\"3b7c2ccffce7c466\",\"/knowledge-medium/pr-preview/pr-1814/src/registerServiceWorker.js\":\"16480c9b4cf546ac\",\"/knowledge-medium/pr-preview/pr-1814/src/requestPersistentStorage.js\":\"2ecb7017244c1687\",\"/knowledge-medium/pr-preview/pr-1814/src/services/authRequestDeadline.js\":\"ba74f6ff77ac75c8\",\"/knowledge-medium/pr-preview/pr-1814/src/services/authStorage.js\":\"a665cb78aa63de06\",\"/knowledge-medium/pr-preview/pr-1814/src/services/powersync.js\":\"e31c0737b87cb87a\",\"/knowledge-medium/pr-preview/pr-1814/src/services/supabase.js\":\"b919460f66a8fbb4\",\"/knowledge-medium/pr-preview/pr-1814/src/services/uploadErrorClassifier.js\":\"03711573c701dc45\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/ActiveContexts.js\":\"d8e6c83c3a9d7467\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/HotkeyReconciler.js\":\"5578946a5f5b24e7\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/WipeLocalDataDialog.js\":\"fb0b2ebbf796223f\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/actionDispatch.js\":\"bd3d38601f286ea0\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/actionRefItems.js\":\"34ccca7a6bdae0b6\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/applyKeybindingOverrides.js\":\"4cacb887ee15a731\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/blockActions.js\":\"28ad150d4efd2c73\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/canonicalizeChord.js\":\"75cfa4a9dc42e128\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/defaultContexts.js\":\"8450b97af3508b7f\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/defaultShortcuts.js\":\"0cf724ea39a58c23\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/effectiveActions.js\":\"29b3e5e66c62c8e6\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/gestureAction.js\":\"0568b904ee1cd774\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/gestureBinding.js\":\"81c66e6ed8a865c6\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/holdRegistry.js\":\"45b32828dcbd7657\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/keybindingConflicts.js\":\"75e269353d1644d8\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/keybindingOverrides.js\":\"20778133527da907\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/pointerAction.js\":\"730764f32dadb500\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/resolve.js\":\"b6df05a147be230a\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/runAction.js\":\"a1b4ddf6e933b557\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/sequenceMatcher.js\":\"dd807f73e5a60931\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/types.js\":\"a82a8f4ba504d01a\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/useActionContext.js\":\"ba9576daeec8d803\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/useActionDiscovery.js\":\"4ea95f72c6c4cf9c\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/utils.js\":\"048b77a5245b7917\",\"/knowledge-medium/pr-preview/pr-1814/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1814/src/sw/bootStore.js\":\"663130d7b04bd56c\",\"/knowledge-medium/pr-preview/pr-1814/src/sw/previewDatabases.js\":\"e547688f4544e7f5\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/byteTransform.js\":\"05fd14874a0da977\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/attachmentCleaner.js\":\"b65fdcb98047f702\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/attachmentParts.js\":\"2af91702edf576f0\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/bundleParts.js\":\"f296ce8782485587\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/bundleRecord.js\":\"6b0c10639768a760\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/manifest.js\":\"2e084f9571f58b22\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/takeBundle.js\":\"89824c9c9e95e82e\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/verifyBundle.js\":\"622f5132ab8e6a56\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/cleaningStage.js\":\"b2feb56162d076ae\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/conversionKey.js\":\"d0d500068ce923e3\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/conversionServer.js\":\"d1bb2d9d617d07aa\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/flip.js\":\"b119b5e741e438a3\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/flipAttempts.js\":\"008a6901df05b9a1\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/pages.js\":\"3104c9cb95f65357\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/preflight.js\":\"74970276a18943cf\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/reseal.js\":\"968ae10c57df4a18\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/runConversion.js\":\"a820c90d13d7d064\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/runLock.js\":\"69fd47b63a374188\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/sealing.js\":\"953dc56bbaf65c1d\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/sealingStage.js\":\"18baed61878e73ba\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/stage.js\":\"3056c0b9b3d51aa1\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/verifyReseal.js\":\"36305a378bea7b2e\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/aad.js\":\"b6cabd71d9d3a054\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/aead.js\":\"c02e2c320f3c2738\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/base32.js\":\"749dc34418e884ad\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/base64url.js\":\"cd3544ecaeeb716b\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/binaryEnvelope.js\":\"8be753d9c416e8c1\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/byteAead.js\":\"cf9c5becf0ff44ed\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/canary.js\":\"cbef8a40951326c9\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/contentHash.js\":\"dce92bae94e56729\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/contentKey.js\":\"eeef67c97f68db2b\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/derivedIdNamespace.js\":\"eebcbcb03b770d70\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/envelope.js\":\"9e1b5ff4a1d33fb9\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/hex.js\":\"baf615c887d17dde\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/sha256Hex.js\":\"ace14888fb5b9f4e\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/workspaceKey.js\":\"6b8fcc37c5191183\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/conversionState.js\":\"c67663ee37b77ff1\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6178dc89b82702be\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/flows/pastedKey.js\":\"1174ac090a0fddc6\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"fffeecb2f9fad17f\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/flows/upgradeWorkspacePin.js\":\"5374e7dfce899a67\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/keyStore.js\":\"88d3db5fadb7d57c\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/mintWorkspaceKey.js\":\"27551262666f9c44\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/modePin.js\":\"f6fa1a4d8bbbe6de\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/openWorkspaceKeys.js\":\"6ec6de3f2d78ceea\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/resolveWorkspaceEntry.js\":\"f8ff044b8dce91b4\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/resolver.js\":\"ff31360693a5833c\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/workspaceAccess.js\":\"6e2ea9a19c071c22\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/transform.js\":\"03080ce6b51d3aa1\",\"/knowledge-medium/pr-preview/pr-1814/src/themeBootDefaults.js\":\"6887d8789eb9b67c\",\"/knowledge-medium/pr-preview/pr-1814/src/types.js\":\"b46fd1910732753b\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/ClientLocalSettings.js\":\"f05d0886dcfc7c0a\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/abortableSleep.js\":\"63d13052f82cb5ac\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/array.js\":\"61706306ae9cfce3\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/backlinkAutocomplete.js\":\"5edd49eca15ea0a4\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/blockCrumbs.js\":\"ee841cb814f1b104\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/blockrefAutocomplete.js\":\"c680ab47edcaac0f\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/cadencedIdleJob.js\":\"a37926a189db6aef\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/callbackSet.js\":\"e437d677b4561b81\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/clientId.js\":\"7750b36d27650357\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/codemirror.js\":\"6ee97874a60e6a9f\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/codemirrorCompletion.js\":\"68e22a2e9fee333d\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/copy.js\":\"977e3304dd94e352\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dailyPage.js\":\"176954db454dc0b4\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dbForensics.js\":\"c2a214ef5a934fd5\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dbForensicsHooks.js\":\"85ca58d2896942ec\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/deleteBlockThroughUi.js\":\"7f66341d90ce3f42\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dialogs.js\":\"2cbda464f4ee1432\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dom.js\":\"708a7b3ba6344441\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/downloadBlob.js\":\"0f74b832eaace7d1\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/exportSqliteDb.js\":\"1685f2846fbcf6f0\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/fileSystemAccess.js\":\"77670fcece40625a\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/flipSlide.js\":\"c9ee93ed0cd51900\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/fnv1a.js\":\"b74be2675d5eae86\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/formatBytes.js\":\"d4c54117019a996b\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/fuzzyRank.js\":\"e538d6f19a85d21b\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/idbKeyedStore.js\":\"ecb7099453d5fefe\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/idleCallbackPolyfill.js\":\"c112cfe3b591556d\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/keyboardAwareScroll.js\":\"a8598286bb0d890d\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/keyboardViewport.js\":\"b7c9b3da6382b31a\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/lastWorkspace.js\":\"3297a76c898e48f2\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/layoutColumns.js\":\"9e92b9a36662a891\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/layoutSessionDom.js\":\"8618a15cdade0c09\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/layoutSessionId.js\":\"975747bb4eea2f48\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/linkClickGestures.js\":\"160b2c9811541a6a\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/linkTargetAutocomplete.js\":\"7074830b331d3021\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/localDbCorruption.js\":\"7af68fb1fca73df6\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/localDbRecovery.js\":\"2859f275c26053c4\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/markdownParser.js\":\"128d0e70005fd099\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/memoize.js\":\"1d57b3cf50262364\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/nameFieldCommit.js\":\"692da8872ef71a04\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/nameList.js\":\"d0a53eb1155aa463\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/navigation.js\":\"a28fcebff1877bc2\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/omnilinerNamespace.js\":\"14dd32a933d299dc\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/opfsPageScan.js\":\"2a4fc316839bd3f6\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelClearance.js\":\"a88c4d2665f04525\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelHistory.js\":\"331c579ea7079c96\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelLanes.js\":\"a593e481baa33147\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelLayoutProjection.js\":\"48cfd5f71c8b0654\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelScrollAnchor.js\":\"80c85b8c13d57d43\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelUrlFlags.js\":\"5602d03a84ba0f63\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/platform.js\":\"1ae3801d45bd9f9e\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/pluralize.js\":\"0f90b7749898a50b\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/propertyCreation.js\":\"34c85d75e5c9c54a\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/propertyNavigation.js\":\"737bd80db932b69f\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/propertyValueContext.js\":\"44ee30d36ea399b7\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/react.js\":\"faf6b44be795be0e\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/relativeDate.js\":\"228493a76b116c26\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/relativeTime.js\":\"ccc3211c11fb20bd\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/renderScope.js\":\"4c26899dc42ca966\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/resolvedThenable.js\":\"18d7b2ba813ed77b\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/routing.js\":\"021de1fcc07312a3\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/safeMode.js\":\"f71d79c5228ba756\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/scheduleIdle.js\":\"b11d718deda55ff4\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/screenWakeLock.js\":\"218647b7652dbdbc\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/selection.js\":\"6de50a77dd0af500\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/softKeyboardGrab.js\":\"b42a5362c7b2a663\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/startupTimeline.js\":\"e93a6d0f91c69e09\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/state.js\":\"ef532655cb4cba67\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/string.js\":\"e19375c73bc6c3e0\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/surfaceZoom.js\":\"8e0b8f93badd5639\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/time.js\":\"1c34b82843b46964\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/toast.js\":\"5da27cc5b59edd83\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/toggleStore.js\":\"244f7f24825361eb\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/untilStopped.js\":\"ab26d9eadcc5c592\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/userActivity.js\":\"11c04204cb191008\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/viewTransition.js\":\"a69f0afefdbe8c95\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/viewport.js\":\"9b2b0f939ea67a63\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/webLock.js\":\"6b860bb5bde6706e\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/workspaceRecovery.js\":\"f424c44c1551b151\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/workspaceSnapshotStore.js\":\"ae39295b54c23621\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-compiler-runtime.js\":\"84e9cfce5bab2f94\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-client.js\":\"8f67376e07f7990b\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-server-edge.js\":\"e2c6e974ff520241\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-server.js\":\"4ce546b2944b782b\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-static-edge.js\":\"1b2a6050bb59619d\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-static.js\":\"b25315036164e58d\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-test-utils.js\":\"9a6b58092f7fe2a8\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom.js\":\"fcca3f046099986c\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-jsx-runtime.js\":\"e68704aa673573c4\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react.js\":\"924b1c059c97e5c6\",\"/knowledge-medium/pr-preview/pr-1814/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1814/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1814/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
