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
		buildId: "a95cfe2f7e13-f5e1cf43",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1814/\":\"32c7c882097643df\",\"/knowledge-medium/pr-preview/pr-1814/index.html\":\"32c7c882097643df\",\"/knowledge-medium/pr-preview/pr-1814/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1814/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1814/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1814/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1814/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1814/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1814/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/pr-preview/pr-1814/assets/FacadeVFS-WJTVywqf.js\":\"9c67f09492eb5eff\",\"/knowledge-medium/pr-preview/pr-1814/assets/OPFSCoopSyncVFS-B3IQnsB9.js\":\"9d2d7574c8fb9d01\",\"/knowledge-medium/pr-preview/pr-1814/assets/OPFSWriteAheadVFS-C1Ahe5QL.js\":\"73f278f8782e2c8e\",\"/knowledge-medium/pr-preview/pr-1814/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1814/assets/wa-sqlite-D8u59xrN.js\":\"77af35b990f651fc\",\"/knowledge-medium/pr-preview/pr-1814/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1814/assets/wa-sqlite-async-DfewSGUr.js\":\"bc726110148e8201\",\"/knowledge-medium/pr-preview/pr-1814/assets/worker-D0Ludvbq.js\":\"67fae6c68f30fb77\",\"/knowledge-medium/pr-preview/pr-1814/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1814/chunks/app-BAV3GX84.js\":\"f6ff252d508d8ba9\",\"/knowledge-medium/pr-preview/pr-1814/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1814/index.js\":\"9e7d51a31f47c384\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1814/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1814/assets/AccessHandlePoolVFS-DmaGyEtu.js\":\"392b0c1759fbc5b4\",\"/knowledge-medium/pr-preview/pr-1814/assets/IDBBatchAtomicVFS-D714kHQE.js\":\"dccf0be0996bedf5\",\"/knowledge-medium/pr-preview/pr-1814/assets/MemoryVFS-DMo-mwIW.js\":\"5972fec003c3dec1\",\"/knowledge-medium/pr-preview/pr-1814/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1814/assets/mc-wa-sqlite-M96RhO1Z.js\":\"8e135128aaccb50a\",\"/knowledge-medium/pr-preview/pr-1814/assets/mc-wa-sqlite-async-BPPr9Rhi.js\":\"a32de73ad168bce0\",\"/knowledge-medium/pr-preview/pr-1814/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1814/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1814/chunks/AccessHandlePoolVFS-CaiI_pPb.js\":\"dbf794fd020698d8\",\"/knowledge-medium/pr-preview/pr-1814/chunks/FacadeVFS-CMHElweH.js\":\"08692f841422d979\",\"/knowledge-medium/pr-preview/pr-1814/chunks/IDBBatchAtomicVFS-CHtIH2Hk.js\":\"a37cd9bece05fc96\",\"/knowledge-medium/pr-preview/pr-1814/chunks/MemoryVFS-r_iyU5G9.js\":\"9d689c42e0674281\",\"/knowledge-medium/pr-preview/pr-1814/chunks/OPFSCoopSyncVFS-CpKbTkWL.js\":\"4d55e1530f0e64b1\",\"/knowledge-medium/pr-preview/pr-1814/chunks/OPFSWriteAheadVFS-BxRhUIY6.js\":\"1e1c66a5a91015d5\",\"/knowledge-medium/pr-preview/pr-1814/chunks/Preview-Dka2Gw_L.js\":\"c2fc6e7f4916bf1a\",\"/knowledge-medium/pr-preview/pr-1814/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1814/chunks/card-WMptgUjV.js\":\"5ba4430086868f06\",\"/knowledge-medium/pr-preview/pr-1814/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1814/chunks/dist-B7b00LgB.js\":\"db46c4e8d733ab8e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1814/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1814/chunks/mc-wa-sqlite-DhazoRwm.js\":\"24cbb20ff31871ed\",\"/knowledge-medium/pr-preview/pr-1814/chunks/mc-wa-sqlite-async-CQqb0Ltm.js\":\"405002cd6449ac09\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react--jvdjLq5.js\":\"d92b2aa40f866167\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-5vsGT067.js\":\"716e60d870cc3e3a\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-9_gLdsnv.js\":\"74ec1c0b5045e60e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-BcbnCuFg.js\":\"a0bdb93df7d81e97\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-CF8LzTgX.js\":\"79a5a228b919816e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-CZZmwM_x.js\":\"8477dcc0b4d5055f\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-DK0gQZQS.js\":\"7d26e88b8b99d5b2\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-ZPCUzZl_.js\":\"339f28849cea7a65\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-dom-server-legacy.browser.production-CDldzgh0.js\":\"bc43833a2b0c476b\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-dom-server.browser.production-DS8_wPjm.js\":\"9cdb60dd34d40735\",\"/knowledge-medium/pr-preview/pr-1814/chunks/react-dom-server.edge.production-CiiJSglP.js\":\"0dfc71dd3efedc1c\",\"/knowledge-medium/pr-preview/pr-1814/chunks/server.browser-CLnjYDAQ.js\":\"4c53c36f73612e94\",\"/knowledge-medium/pr-preview/pr-1814/chunks/textarea-BiBKG3K6.js\":\"3a9a3e1d987a3543\",\"/knowledge-medium/pr-preview/pr-1814/chunks/ui-BrDiyP5_.js\":\"221541bc96f6146e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/wa-sqlite-Dnmop_9-.js\":\"1314d57aa9fec41e\",\"/knowledge-medium/pr-preview/pr-1814/chunks/wa-sqlite-async-DsYCQsup.js\":\"e4391951e61e658f\",\"/knowledge-medium/pr-preview/pr-1814/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1814/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/pr-preview/pr-1814/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1814/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1814/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1814/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1814/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1814/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1814/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1814/src/App.js\":\"af8e10e38bb59dcc\",\"/knowledge-medium/pr-preview/pr-1814/src/appUpdate.js\":\"6f662535a888f745\",\"/knowledge-medium/pr-preview/pr-1814/src/appVersion.js\":\"30715022eeb8c9ef\",\"/knowledge-medium/pr-preview/pr-1814/src/bootstrap/initialLayout.js\":\"d154a34eed580589\",\"/knowledge-medium/pr-preview/pr-1814/src/bootstrap/openWorkspaceData.js\":\"919accec6533aab2\",\"/knowledge-medium/pr-preview/pr-1814/src/bootstrap/resolveWorkspace.js\":\"fadd20ed53a2cbd4\",\"/knowledge-medium/pr-preview/pr-1814/src/bootstrap/workspaceBootstrap.js\":\"bf92116c5f67c113\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockComponent.js\":\"b324e7fcadc50787\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockCrumbs.js\":\"4004af8fe22a6ab2\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockEditor.js\":\"0916e1d5f9d67fbf\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockLoadingPlaceholder.js\":\"a34f4ca873a9a675\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockProperties.js\":\"b73de4f280549121\",\"/knowledge-medium/pr-preview/pr-1814/src/components/BlockSearchPicker.js\":\"8f1ce9c5327b3f7d\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ConfirmBulkDeleteDialog.js\":\"872e2a2aab1ee981\",\"/knowledge-medium/pr-preview/pr-1814/src/components/DividerHandle.js\":\"9decb0272c503424\",\"/knowledge-medium/pr-preview/pr-1814/src/components/DraftEditor.js\":\"5d66152b094cb4e4\",\"/knowledge-medium/pr-preview/pr-1814/src/components/GutterPill.js\":\"5d9ae42a456c3ef0\",\"/knowledge-medium/pr-preview/pr-1814/src/components/Header.js\":\"40377e89a3106b3d\",\"/knowledge-medium/pr-preview/pr-1814/src/components/LazyBlockComponent.js\":\"86651cd169d5a4d4\",\"/knowledge-medium/pr-preview/pr-1814/src/components/Login.js\":\"6a8801f04815a36c\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ZoomableSurface.js\":\"f86a3b3f41b81583\",\"/knowledge-medium/pr-preview/pr-1814/src/components/editModeKeepalive.js\":\"7dde331a29f17f32\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyDisplay/PropertyDisplayScope.js\":\"badfc73e39431b33\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"07a296039dc7e46b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/RefPropertyEditor.js\":\"787efc3c03c51dec\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/RefTargetTypePicker.js\":\"ec1727af302bbf89\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/SelectPropertyEditor.js\":\"04d45ea8151d24c8\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/TypesPropertyEditor.js\":\"fdfebb8d57d5bfe0\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/defaults.js\":\"104501421704df90\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/kernelValuePresets.js\":\"d14a3481b200f1c9\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/selectablePresets.js\":\"3efd38004f3c49d7\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyEditors/typesPropertyUi.js\":\"0abcdd03858c8987\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/AddPropertyForm.js\":\"62d7569ecaf154cc\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/PropertyPicker.js\":\"1be2a6eed4cfdfb8\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/PropertyRow.js\":\"5b3a737450c8867e\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/Rows.js\":\"e802734059517389\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/actions.js\":\"c2d7145568e1981f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/declarationOnly.js\":\"5b598b3f4fc6cd23\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/layout.js\":\"65416126b3150792\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/model.js\":\"d8d5c8fd2f008dca\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/shapeUi.js\":\"c98cc894f86b3d93\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/shapes.js\":\"f178c4dda0db7947\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ac582b173413b24f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanel/visibility.js\":\"b6cfe08d31e20c75\",\"/knowledge-medium/pr-preview/pr-1814/src/components/propertyPanelSections.js\":\"dc29f242acc6c26c\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/BlockEmbed.js\":\"cf48fafc1eeca9b4\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/BlockLink.js\":\"19c7cf842dbc86e7\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/BlockRef.js\":\"a81cc8b7832f9a2b\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/ReferenceLink.js\":\"71d12c7b04ef6726\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/cycleGuard.js\":\"04f5cd6461550b29\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/cycleGuardContext.js\":\"8c0e8df7f2a7f1a9\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/linkInteraction.js\":\"68d4b29d7e8ec264\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/referenceLayout.js\":\"8efe6c53153d5513\",\"/knowledge-medium/pr-preview/pr-1814/src/components/references/useBlockRefAncestors.js\":\"40649651ab3f7d89\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/BlockGutter.js\":\"e4a715181882036e\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/BlockInfoDialog.js\":\"dff7af9eb04f4614\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/BlockTypeBlockRenderer.js\":\"b7e18e13739ae07f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/BulletHoverCard.js\":\"c8533f8e5af0f424\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/CodeMirrorContentRenderer.js\":\"23cdbfd2b4751afa\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7f160f3c7f0999d9\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/ColumnResizeHandles.js\":\"8099604c28a01107\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d0527d521315a683\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/DefaultBlockRenderer.js\":\"fbd4a29d4056e86f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/LayoutRenderer.js\":\"5a0806a8e6189a4f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/MarkdownContentRenderer.js\":\"8a6777100dd099f1\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/MissingDataRenderer.js\":\"077e010256bc98d1\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/PanelRenderer.js\":\"5ed7d86b85ffc0dd\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/PropertySchemaBlockRenderer.js\":\"5616c6bfc6cd4e13\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/TopLevelRenderer.js\":\"992b0a0482c4b9a3\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/blockGutterMode.js\":\"5f24fd744f4289aa\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/blockTitleText.js\":\"6a0bcb419b372e9c\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/fieldCreationKeydown.js\":\"e6ec564069afd8d6\",\"/knowledge-medium/pr-preview/pr-1814/src/components/renderer/layoutRootContext.js\":\"1af324f79e329aea\",\"/knowledge-medium/pr-preview/pr-1814/src/components/typeChip/TypeChip.js\":\"a37c955fcf6f6f5f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/typeChip/chipStyle.js\":\"770e9a10b70ab909\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/anchored-floating.js\":\"15135dd6f0d88fc7\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/button.js\":\"9fc4227dc482fbbd\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/card.js\":\"c4c1d39d1b2cba3f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/checkbox.js\":\"608ad951e2945ff6\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/collapsible.js\":\"2e85ac8f68253e62\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/command.js\":\"5045c9bb610df5d5\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/context-menu.js\":\"b283659fd1dba56c\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/dialog.js\":\"6ac369e99f21c122\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/dropdown-menu.js\":\"809db4da7c05fffa\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/floating-listbox.js\":\"729885f5a4f07dd9\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/index.js\":\"a9c5b17e6db50eca\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/input.js\":\"e4ffa16711093342\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/kbd.js\":\"c84c028eda10f6c9\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/label.js\":\"6537b95433889f41\",\"/knowledge-medium/pr-preview/pr-1814/src/components/ui/textarea.js\":\"567fc9d86b25b726\",\"/knowledge-medium/pr-preview/pr-1814/src/components/useEditModeYieldKeepalive.js\":\"932ecd1b5415fa48\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/BootFallback.js\":\"5cc393b366ff8860\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/FocusedRowLazyMount.js\":\"5627852a5449b872\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/LazyViewportMount.js\":\"04932613b4d7f628\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/LocalDbCorruptionFallback.js\":\"0f7a44c510e7e2d1\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/error.js\":\"df0601fa610206b4\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/lazyMountRegistry.js\":\"ac59e69a0f04a5ca\",\"/knowledge-medium/pr-preview/pr-1814/src/components/util/suspense.js\":\"d45d85c5b98c7025\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/CreateWorkspaceDialog.js\":\"20a9626ad33cbdda\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/PendingInvitations.js\":\"d231e164b8963c57\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/SyncProgress.js\":\"c4766fd40be39ab4\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/UnlockProgress.js\":\"acafff3efbf4a55a\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/WorkspaceKeyGate.js\":\"8e6f93d970f6946f\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/WorkspaceSettingsDialog.js\":\"958849514ece5728\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/WorkspaceSwitcher.js\":\"33548481b09c1269\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/WorkspaceSyncGate.js\":\"32b209dd6ee34cc9\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/ConversionFlow.js\":\"ea92858e2026338a\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/ConversionFlowHost.js\":\"35c40db2c5d07431\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/EncryptionSection.js\":\"7431b7f74192e6df\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/attachmentPrompts.js\":\"583d06f461571f56\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a3ef572037534c93\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/conversionFlowDeps.js\":\"c5dd25f98b13b4d6\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/conversionFlowStore.js\":\"782b45c364c86ab2\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/flowUi.js\":\"70bd1d8003a19dcc\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/conversion/useConversionRun.js\":\"15d7ace3d3eec354\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/keyUi.js\":\"84c853cb8cb04f87\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/useCloseOnKeyLoss.js\":\"68d40d77a77c59ee\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/useCloseOnServerE2ee.js\":\"d1f730eabc6e1987\",\"/knowledge-medium/pr-preview/pr-1814/src/components/workspace/workspaceUnlocked.js\":\"bd5e7414096d8ba0\",\"/knowledge-medium/pr-preview/pr-1814/src/context/backgroundSubtree.js\":\"dd0f07006e9b0d3a\",\"/knowledge-medium/pr-preview/pr-1814/src/context/block.js\":\"15a9b5431c799da6\",\"/knowledge-medium/pr-preview/pr-1814/src/context/layoutWsContext.js\":\"48c4c8a5ed14a46a\",\"/knowledge-medium/pr-preview/pr-1814/src/context/propertyDisplay.js\":\"a86f7e91775cbc12\",\"/knowledge-medium/pr-preview/pr-1814/src/context/repo.js\":\"df556903e17b6f7b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/aliasClaim.js\":\"e8344aa6bfe530b3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/aliasSeatNamespace.js\":\"b8803dbc9cb47745\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/blockData.js\":\"9ccae5d505ed9257\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/blockType.js\":\"1e1215cf18824048\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/changeScope.js\":\"433b2b149798030c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/codecs.js\":\"ce09750acf8ec5f4\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/derivedData.js\":\"fbc32d7c44f04708\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/errors.js\":\"64b1eba630492ce5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/events.js\":\"1349d9b1114721c9\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/handle.js\":\"f8ab9ae274cefe78\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/index.js\":\"2d0ffb81122d95b2\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/mutator.js\":\"f8372c9f6840ecf1\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/processor.js\":\"7e9088bc1a53c866\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/propertySchema.js\":\"f4bdb4e1048da968\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/query.js\":\"afd2f9ab2c998956\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/sameTxProcessor.js\":\"751a3bf2e16fb312\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/schema.js\":\"f8ab9ae274cefe78\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/tx.js\":\"f8ab9ae274cefe78\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/typedBlockQuery.js\":\"48d88cc3ff37555d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/user.js\":\"da677b662a5f147c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/valuePresetCore.js\":\"8634b6f8124cec49\",\"/knowledge-medium/pr-preview/pr-1814/src/data/api/valuePresets.js\":\"c0f636e34701685b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/attachmentCleanerIOVerb.js\":\"a1afb7afa054f048\",\"/knowledge-medium/pr-preview/pr-1814/src/data/block.js\":\"51bd087eeaef3961\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockCache.js\":\"cd8957e80be48208\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockId.js\":\"539a0680dfcfc068\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockLiveness.js\":\"c4028ae026209e0f\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockMerge.js\":\"39df7d4d538adcb0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockSchema.js\":\"0a5306a66a2e4a5c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/blockTypes.js\":\"27d7b41ee2adf736\",\"/knowledge-medium/pr-preview/pr-1814/src/data/clientContext.js\":\"7a58194a67e3e1ed\",\"/knowledge-medium/pr-preview/pr-1814/src/data/dbFileSiblings.js\":\"ee955cd3cb98ac4a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/definitionSeeds.js\":\"1bda9656637b28ff\",\"/knowledge-medium/pr-preview/pr-1814/src/data/derivedIds.js\":\"d6dd29b84f1f5792\",\"/knowledge-medium/pr-preview/pr-1814/src/data/drawnSubtree.js\":\"6c1dad71bf84df0b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/facetBridge.js\":\"a9bab375aa22649b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/facets.js\":\"22162f39bacca5f8\",\"/knowledge-medium/pr-preview/pr-1814/src/data/globalState.js\":\"37103411c7caa192\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/aliasClaimRederiveProcessor.js\":\"9173b113c7c33b56\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/ancestorBatch.js\":\"79853dfe61b21f01\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/blockTypeTypeifyProcessor.js\":\"f33cb040ae812719\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/clientSchema.js\":\"02f3cd9c814cc54d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/commitPipeline.js\":\"1dec65c9b8b0b716\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/devAssertions.js\":\"cdfcad74282c3be0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/firstSync.js\":\"6f2d1968b131ef5e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/freshInitialLoad.js\":\"0c9d873e1cd9683b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/graphBackfillClaim.js\":\"d43acd0ae2a58848\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/handleStore.js\":\"15bb92c129bc74c0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/idleMarkerJobs.js\":\"5873abdb74b043f1\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/initialDownload.js\":\"f2e4715d1e2497ea\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/initializeClientDatabase.js\":\"8726b1a1dfc804de\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/jsonCanonical.js\":\"bdd54af392a3e02d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/kernelInvalidation.js\":\"f1a33f16622cafce\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/kernelProcessors.js\":\"2af411532b0aec4f\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/kernelQueries.js\":\"9677a42c1a4b33ac\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/mergeTypeMembershipProcessor.js\":\"af7afc3367269eef\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/normalizeReferencesProcessor.js\":\"4e6f8b231dfdfc87\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/poolInstrumentation.js\":\"48c8eccc7fe62792\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/processorRunner.js\":\"4c7d9e1d536bbcd3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyCellBackfill.js\":\"a2bc43e64be36526\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyChildMint.js\":\"9b198c3becd55a5c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyChildrenProcessor.js\":\"55703f6c8a799ae5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyDefinitionChangeProcessor.js\":\"af17c4b784c63539\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyDefinitionSynthesis.js\":\"f643426c505bdc42\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyKeyScan.js\":\"9c6c844653cd5653\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertySchemaResolution.js\":\"1ad85c001553e7ad\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/propertyValueEdits.js\":\"3f01fdd94acab5ec\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/raiseProtocol.js\":\"416b31cd7805cdc7\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/readBatch.js\":\"15ac56e406969de6\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/refProjection.js\":\"ecc3060ac94ec910\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/referenceTargetLookups.js\":\"8b58a64c36667a5d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/referenceTargetProcessor.js\":\"5db48bbf9837413c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/replayMerge.js\":\"533578db34e136d2\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/sqlBinds.js\":\"a0e7a87928d9f501\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"235c83bba802f19d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/arrivalProcessors.js\":\"57abad9c8cc0f2a6\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/invalidate.js\":\"166f33173b220e46\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/materialize.js\":\"bf5bfc49ad4ee5ce\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/observer.js\":\"7c04d8f750b42773\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/syncObserver/reconcile.js\":\"d36064fa8e7fa4d5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/timingMetrics.js\":\"55414aeb4aa1c287\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/treeQueries.js\":\"c7827b726445a4e1\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/txEngine.js\":\"ab2aabda8ae08551\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/txSnapshots.js\":\"eaa333b5ca0ab821\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/typedBlockQuery.js\":\"77488d548655c68c\",\"/knowledge-medium/pr-preview/pr-1814/src/data/internals/undoManager.js\":\"fae2aed2697c8e90\",\"/knowledge-medium/pr-preview/pr-1814/src/data/invalidation.js\":\"22a878ec92c7b36e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/kernelDataExtension.js\":\"762c5343fd77907e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/kernelPage.js\":\"81f26a09c8e69271\",\"/knowledge-medium/pr-preview/pr-1814/src/data/kernelValuePresetCores.js\":\"67f7d7d41edf8eea\",\"/knowledge-medium/pr-preview/pr-1814/src/data/localDbCorruptionSignal.js\":\"ab8a0d7ef055a6b3\",\"/knowledge-medium/pr-preview/pr-1814/src/data/localDbStorage.js\":\"b094c6708d71bb03\",\"/knowledge-medium/pr-preview/pr-1814/src/data/localDbVfs.js\":\"aacada0904403560\",\"/knowledge-medium/pr-preview/pr-1814/src/data/localSchema.js\":\"964c11d0f557fd9b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/maintenance.js\":\"0d05e9fa002661da\",\"/knowledge-medium/pr-preview/pr-1814/src/data/mergeProperties.js\":\"0137ada85fda257f\",\"/knowledge-medium/pr-preview/pr-1814/src/data/metricsConsoleHook.js\":\"e713da534450e302\",\"/knowledge-medium/pr-preview/pr-1814/src/data/migrationsPage.js\":\"d9a70eda09fd550a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/mutators.js\":\"25d2a7df809d88ab\",\"/knowledge-medium/pr-preview/pr-1814/src/data/orderKey.js\":\"b6bd5e186e3ae278\",\"/knowledge-medium/pr-preview/pr-1814/src/data/orderKeyPlacement.js\":\"3c1e8d9d76146d19\",\"/knowledge-medium/pr-preview/pr-1814/src/data/outlineSurface.js\":\"68096ab33dc6f7de\",\"/knowledge-medium/pr-preview/pr-1814/src/data/pendingEditorContent.js\":\"79563ef330f25655\",\"/knowledge-medium/pr-preview/pr-1814/src/data/pendingUploadsSql.js\":\"3387eb75835f7c79\",\"/knowledge-medium/pr-preview/pr-1814/src/data/pluginStateExtensions.js\":\"250635069b3666ac\",\"/knowledge-medium/pr-preview/pr-1814/src/data/powerSyncLogger.js\":\"1acc165f3a29de0d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/projectorRuntime.js\":\"15c71c40cd7cdb54\",\"/knowledge-medium/pr-preview/pr-1814/src/data/properties.js\":\"ad61565322a31641\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertiesPage.js\":\"defd869e27d9344a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyChildren.js\":\"c5d591564087ccb7\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyDefinitionFanout.js\":\"593f60ceda4c5bbc\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyDefinitionMetadata.js\":\"9726852951b36e49\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyDefinitionRegistry.js\":\"95a329bbaa189f5e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyDisplayMode.js\":\"e801ad84bcfbedaa\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertyRowCreation.js\":\"9a99b2eaa0c22696\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertySchemaCreation.js\":\"9f4c4e5b98a783ee\",\"/knowledge-medium/pr-preview/pr-1814/src/data/propertySeeds.js\":\"ab222ef72c3f48d9\",\"/knowledge-medium/pr-preview/pr-1814/src/data/recentsPage.js\":\"cc516167333177b9\",\"/knowledge-medium/pr-preview/pr-1814/src/data/referenceBlock.js\":\"c312055308916239\",\"/knowledge-medium/pr-preview/pr-1814/src/data/rejectedUploads.js\":\"e61e6d82adc41ca7\",\"/knowledge-medium/pr-preview/pr-1814/src/data/releasePowerSyncConnection.js\":\"ed6f5c0da22076d0\",\"/knowledge-medium/pr-preview/pr-1814/src/data/repo.js\":\"75ce1e77b809afa5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/repoProvider.js\":\"43b90c7982156ff5\",\"/knowledge-medium/pr-preview/pr-1814/src/data/rowProperty.js\":\"5221214ba5af4fda\",\"/knowledge-medium/pr-preview/pr-1814/src/data/searchFilter.js\":\"1561c84bdca287aa\",\"/knowledge-medium/pr-preview/pr-1814/src/data/seedIdentityLedger.js\":\"a67dd2c9cf2f8168\",\"/knowledge-medium/pr-preview/pr-1814/src/data/stateBlocks.js\":\"4076d9265ec6388b\",\"/knowledge-medium/pr-preview/pr-1814/src/data/structuralEditPolicy.js\":\"218de796ea4d39da\",\"/knowledge-medium/pr-preview/pr-1814/src/data/subtreeDelete.js\":\"925201f020e5fb78\",\"/knowledge-medium/pr-preview/pr-1814/src/data/syncStreamLock.js\":\"cc4e5863bdbd8188\",\"/knowledge-medium/pr-preview/pr-1814/src/data/syncedTableSqlRecognizer.js\":\"0e4b87ff3e51a848\",\"/knowledge-medium/pr-preview/pr-1814/src/data/syncedTableWriteGuard.js\":\"44c274ff0cf84311\",\"/knowledge-medium/pr-preview/pr-1814/src/data/targets.js\":\"5bb5e469591095f2\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeColors.js\":\"a271adf0c83e9942\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeDefinitionMetadata.js\":\"7df1ef64f6c510e9\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeDefinitionRegistry.js\":\"c30b8a9fab080599\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeExtraction.js\":\"2715f535f4e51f64\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeInitialValues.js\":\"32dc6cff7ed45b55\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typePropertyGroups.js\":\"cd747b4988182bef\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeSeeds.js\":\"e9f10f8ccbdb4c4d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typeTagger.js\":\"c3eb8dc4abea5393\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typedRecords.js\":\"b1c9276faaa4be3d\",\"/knowledge-medium/pr-preview/pr-1814/src/data/typesPage.js\":\"22c21224c144fbd8\",\"/knowledge-medium/pr-preview/pr-1814/src/data/userPrefs.js\":\"59621825ecb387c4\",\"/knowledge-medium/pr-preview/pr-1814/src/data/userSchemasService.js\":\"b4987ed20f960f7a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/userTypesService.js\":\"9aea482bca80e156\",\"/knowledge-medium/pr-preview/pr-1814/src/data/valuePresetRegistry.js\":\"d1cb71a27fa1e4ec\",\"/knowledge-medium/pr-preview/pr-1814/src/data/visibleChildren.js\":\"15741c088e3b4500\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaceConversion.js\":\"a551eebf7361abec\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaceFirstSync.js\":\"b91bce4aa7a9f620\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaceIdNamespace.js\":\"76b844078fdc14ea\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaceSchema.js\":\"02b6d587549e816e\",\"/knowledge-medium/pr-preview/pr-1814/src/data/workspaces.js\":\"f4d2a99f07b13ef6\",\"/knowledge-medium/pr-preview/pr-1814/src/data/writeAheadLog.js\":\"885ae377b752cd1a\",\"/knowledge-medium/pr-preview/pr-1814/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/BlockPasteShellDecorator.js\":\"a182f00e40040d9e\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/atTrigger.js\":\"3bd532b6ffa878df\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/autocomplete.js\":\"722be86d8fabcde6\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/codeMirrorExtensions.js\":\"5584c583b9f92226\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/contentFlush.js\":\"8d2a72b1ead0cec4\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/defaultInteractions.js\":\"d080047eb9eaf8e3\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/editSettleSignal.js\":\"f43be41fa6f2f779\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/insertImage.js\":\"9fcf05d83508d083\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/referenceCompletionRange.js\":\"9af426fb017451a4\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/referenceTargetTypes.js\":\"d731442689969c9d\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/syntaxContext.js\":\"451b3a34cf7381a8\",\"/knowledge-medium/pr-preview/pr-1814/src/editor/triggerMatch.js\":\"16461050a54c7a4e\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/AppRuntimeProvider.js\":\"4265d1c54c50d9ca\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/BlockFocusShellDecorator.js\":\"474bf12046efb833\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/ExtensionRenderBoundary.js\":\"94fc2832f64ea408\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/PanelContentRecovery.js\":\"e1e935104f2edba3\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/apiCatalog.js\":\"e70ab3fb15a2430c\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/approveExtensionHere.js\":\"22a536dce6783b65\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/armedCutAppMount.js\":\"e8d424ec23edbb29\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/batchableKeyedStore.js\":\"789a8f78919031e5\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/blockInteraction.js\":\"c17c3936a6d44f80\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/blockSelectionAction.js\":\"00143fec39bef767\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/compileExtensionModule.js\":\"5afaa8b9b70c7f96\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/compiledModuleCache.js\":\"e4f96cc3c981ac72\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/continuousGestures.js\":\"93ac885ec2d7f83e\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/core.js\":\"87e596ef5d9d8abc\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/defaultRenderers.js\":\"2962eadac248f965\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/definitionFanoutAppMount.js\":\"031984b1ca2ea977\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/dialogAppMount.js\":\"3245478dcffc849d\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/dynamicExtensionSeeds.js\":\"8cf3f7394d650957\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/dynamicExtensions.js\":\"ee8d6f60389cf5f9\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/exampleExtensions.js\":\"06166af04dd51f1b\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionApprovalStatus.js\":\"5a8c3271c6d9b6c1\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionLoadErrorToast.js\":\"89b01ee46b27d96d\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionLoadErrors.js\":\"dad44d5f854b1641\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionLookup.js\":\"30795641218bffbc\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionToggles.js\":\"698b197bd4d956c2\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/extensionUtilitiesCss.js\":\"f6d1dc6dff40a544\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/kernelPageDeletionGuard.js\":\"80e8f24dc67a8a7e\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/liveRuntime.js\":\"c70f5c2e5adc3243\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/openExtensionsSettings.js\":\"afe992675901b8b6\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/overridesCache.js\":\"d5331eec6312574d\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/pluginIds.js\":\"1d81828c3235e2bf\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/processorRejectionToast.js\":\"1df38fd938aacd92\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/runtimeActions.js\":\"abd218265f17ba61\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/runtimeContext.js\":\"18f0efbf1e0afd92\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/staticAppExtensions.js\":\"67e3d12d1d7f205a\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/staticDataExtensions.js\":\"ed81d71ea6f73834\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/toastAppMount.js\":\"0abe00ad1d48c312\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/useOverrides.js\":\"557126165908447a\",\"/knowledge-medium/pr-preview/pr-1814/src/extensions/useShortcutSurfaceActivations.js\":\"72b9f35f67563240\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/discoverToggleTree.js\":\"9248a655af7498c7\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/facet.js\":\"a66d639a39301a6f\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/resolveAppRuntime.js\":\"4f575b372f6d1ce1\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/runtimeEvents.js\":\"7341f7eadf91329b\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/togglable.js\":\"67b7691201e7a3f9\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/variantFacet.js\":\"5fac4135e3c6fdd3\",\"/knowledge-medium/pr-preview/pr-1814/src/facets/verbFacet.js\":\"d9ba067d065d4675\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/block.js\":\"f802180cbb6a0db4\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/focusedChild.js\":\"c019f47225a44cdf\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/propertySchemas.js\":\"3645197a00fc7b87\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/typeRegistry.js\":\"aabf7f324382dd15\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useAncestorCrumbs.js\":\"4a02f1c1944803f3\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useAutocompleteListbox.js\":\"076e0328311904b1\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useDebouncedSearch.js\":\"f71afd00171e9269\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useDebouncedValue.js\":\"d6a68221f91477dc\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useIsFocalRender.js\":\"0d5fc01812050b06\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useIsReadOnly.js\":\"7433bee04b0afa72\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useMaterializeBacklog.js\":\"759df5a2df78ec9a\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useMinuteClock.js\":\"7272a8149d8753a8\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/usePanelLayoutProjection.js\":\"5b1e79c9771c964c\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/usePendingInvitations.js\":\"5b6b6b64d24c38e5\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useRendererRegistry.js\":\"296a8a3cf3ac0df3\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useRetainedFieldRows.js\":\"e224663847645cd5\",\"/knowledge-medium/pr-preview/pr-1814/src/hooks/useWorkspaces.js\":\"108b45811d2f9405\",\"/knowledge-medium/pr-preview/pr-1814/src/lib/utils.js\":\"d0d69bf30d6febe1\",\"/knowledge-medium/pr-preview/pr-1814/src/main.js\":\"b1bce5e994c479ec\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/MarkdownImage.js\":\"dd03b89374f57678\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/blockSeparators.js\":\"77a449852a2ce3fd\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/context.js\":\"3398050a7894f96b\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/defaultMarkdownExtension.js\":\"c63d9fd92afeaffa\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/extensions.js\":\"589b670c6cea416d\",\"/knowledge-medium/pr-preview/pr-1814/src/markdown/renderMarkdownHtml.js\":\"c6e6239ff11f4c15\",\"/knowledge-medium/pr-preview/pr-1814/src/minimal-editor.js\":\"8e3779f98b0c4e04\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/armedCut.js\":\"aaad37833485e7e9\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/captureMediaVerb.js\":\"bfa942c3ecbbd655\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/clipboard.js\":\"e9a45078c8cbe5c3\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/decision.js\":\"cbeb2a17b8fa014f\",\"/knowledge-medium/pr-preview/pr-1814/src/paste/operations.js\":\"461ae89c9a0b85e5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/account-header/AccountHeaderItem.js\":\"83166521b5f27cc1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/account-header/index.js\":\"4b7d37ff9bdfeb43\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"678193bf4d18983e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/askAgent.js\":\"62423496854d9799\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/askedStore.js\":\"f3f25a1c60ff5869\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"e38df781c1388a07\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/chipState.js\":\"7f864d6f28ebe01d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ce2c01d30e159aa8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/index.js\":\"4e19c88fb8b51509\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c7f746cb7c2fa07e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-dispatch-companion/schema.js\":\"1daa0588a27571da\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/AgentTokensDialog.js\":\"984af8e49856a744\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0fcf67e968ba245f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/addMedia.js\":\"d5d0554f64bcbc26\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9fcf1688090bc01c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/block.js\":\"74073343a8d31fc9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/context.js\":\"b6118d44ef198c87\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/displayIds.js\":\"4986caa6f6f6dd52\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/index.js\":\"196fc43085262638\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/outline.js\":\"6cfeac1a7205fe2d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/properties.js\":\"d2ef294528699aa4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/refs.js\":\"ba25f7420db582ea\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"90828a87dbd394cc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/search.js\":\"7c856a7df70e90f0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/shared.js\":\"a61ed731855e1367\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"b529122b7191b0f0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentViews/text.js\":\"14b7041f042ec75d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/agentWrites.js\":\"22ec2376b898d94c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/authoringCatalog.js\":\"af83ee130a5154da\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/blockRefTargets.js\":\"5d8ae1cbc3a25b52\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/bridge.js\":\"e08e4e783b0b33ac\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/bridgeLoop.js\":\"3095d7d1a2f20a1c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/changeHistory.js\":\"8f8a3da2fc3aeea3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/commands.js\":\"7ffaeea5e46c3be5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/commentsCommands.js\":\"3db8fcb2cc1062c0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/dataExtension.js\":\"740b14c46fd7c12e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/dataModelGuide.js\":\"108967964a35faf6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/describeRuntime.js\":\"a38daf566cdcbb08\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/extensionLint.js\":\"cd2b72fe184ff402\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/grainAudit.js\":\"7afc6c9d113a233f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/healthCommand.js\":\"2966e79b3acfe396\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/index.js\":\"565d93955da51283\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/presetIdentity.js\":\"c02f6cea70d0a0db\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"640cb0a380667b07\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/readMedia.js\":\"f428df518f0518be\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/schema.js\":\"9a82890748da8af6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/serialization.js\":\"336bf8bb1411125a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/targets.js\":\"2dc249ac7425bf16\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/tokens.js\":\"d97fd402e4c8bc2a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/watchEvents.js\":\"0b5f5a41b97b1a2d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/workspaceGuard.js\":\"1b560f67f48a253b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/agent-runtime/writeCommands.js\":\"b2dcd51744db552d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/AliasCollisionToast.js\":\"5941fc1d7353b8a8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/DuplicateNameBanner.js\":\"c1704ed19dd23092\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/collisionMerge.js\":\"418b1e7604423cda\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/dataExtension.js\":\"38c248f6ff8555e0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/index.js\":\"edf2a913324a42e6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/mergeCollisionAction.js\":\"3b7785e642352d20\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/pageStyling.js\":\"9d35be70e67879b2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/rejectionToast.js\":\"f8dc0d1322dc4368\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/alias/syncProcessor.js\":\"53d9c2a8533e2606\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/actions.js\":\"b7a20c9776f517ce\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/addComment.js\":\"5077cf3e4f1ed231\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/anchor.js\":\"38ef30a25e31a2cb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/anchorState.js\":\"31bd290f6dba4f54\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/commentLinks.js\":\"557f7f9ced94c4e8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/confirmThreadDeletion.js\":\"e84480c6c8522f32\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/container.js\":\"0c49325f1b88a021\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/dataExtension.js\":\"8328307bf4c71627\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/deleteComment.js\":\"662b098c886b74c2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/highlights.js\":\"a97707910a099c23\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/index.js\":\"d884318b38b52dc3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/linkedCommentsPill.js\":\"58d411b831d18e56\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/margin.js\":\"c5a46ebd80d020a1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/marginSchema.js\":\"49f58f3d7bd72a46\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/newComment.js\":\"32ac39dc32a45718\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/ownThreadPicker.js\":\"887a96e46350cce4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/placement.js\":\"6110b2e8e63e66cf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/queries.js\":\"79dc904a2a14fcd9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/quotePosition.js\":\"8baf6f250c8c90e5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/quotedIn.js\":\"d4d6c0dfe76b0d72\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/quotedRange.js\":\"21eabd30dde44ba3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/rangeRefs.js\":\"144f424876e8f975\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/readHighlights.js\":\"81ace3ff62edd09c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/readSelection.js\":\"3e1b19ea84ef2b70\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/readSelectionUi.js\":\"8e68e7452935a3c5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/reanchor.js\":\"55653b330ec3c388\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/schema.js\":\"5fdc175df73a0bb1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/scope.js\":\"afa24148fb465a29\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/scopeThreads.js\":\"20bacf884a87d3d2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/splitRetarget.js\":\"bdb5d86284d8e7d0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/suggestionCard.js\":\"14efdc9054b90b76\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/suggestions.js\":\"84b6e2a45fce857a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/summaries.js\":\"aff85dcf160492e4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/summaryBatch.js\":\"26d2d26b813ef1a6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/surface.js\":\"6f765e1c330096f8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/threadNavigation.js\":\"6b259d4d91442951\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/threads.js\":\"cd9e74099ef54eb9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/ui.js\":\"888c18dc8d48c89c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/annotations/uiStore.js\":\"21b08b113bd5b2c8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/app-intents/appIntents.js\":\"07f19c23e5b6968d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/app-intents/index.js\":\"250b930ddf9b0dac\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/app-update-prompt/index.js\":\"5fe1d194b7bcc2b5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/app-update-prompt/status.js\":\"8ba48fd39f9a5404\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6facfdcf8b17c099\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/MediaBlockRenderer.js\":\"9cae40a1cb5f67c0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0bfa6d2c8a070738\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/MediaUploadReconciler.js\":\"8a2a00bfcfc11da6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/assetDownLane.js\":\"e7087501f81727aa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/assetResolver.js\":\"a4e49258ee284f95\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/assetUpload.js\":\"1a4ca29acf3efc12\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/attachmentCleanerIO.js\":\"54008ed96176a533\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4db3b50086181078\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/blobStore.js\":\"ea3a5e19552937b6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/byteStore.js\":\"e45eba7ecbfdcea1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/cleanerIO.js\":\"a13437e8778a35d3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/cleanupAttachments.js\":\"c38044c7c86b2d60\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/dataExtension.js\":\"0ae5efa57267d25f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/downLane.js\":\"bc321dccb9683e2f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/index.js\":\"2ff9494cf973f2f7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/insertImageContribution.js\":\"32dbef208807899b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/laneArming.js\":\"4db0942f96642511\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/laneLock.js\":\"d20a66a8bf2eacc0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/mediaBlock.js\":\"6a905b6094dcffa2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/mediaCapture.js\":\"c506d70fa40e6241\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/mediaViewers.js\":\"41aee309fb5725d4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/mediaViewersFacet.js\":\"7a35410c6f452031\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/pasteCapture.js\":\"101187b26f3db21f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/resolver.js\":\"3f764b8809baa658\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/retryUploadsAction.js\":\"9178e2e2eef405bc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/storagePaths.js\":\"c21da8b82635dd52\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadDrain.js\":\"d1eb6f87dd58b5ba\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadLaneStatus.js\":\"3299a58bc5a04293\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadReconcile.js\":\"0be1f931d902a32d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadRecovery.js\":\"dcef1e7c2efd6c50\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/uploadStore.js\":\"ee775fca917f7410\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/attachments/useAssetObjectUrl.js\":\"e23a2cafdaed0672\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8d2b23c041b71644\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/BacklinksViewSection.js\":\"034d1b5031801fa0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/facet.js\":\"d6d2d33c2ae0c2af\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/index.js\":\"26121cd47295baca\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks-view/prop.js\":\"3548ce53c1f410e9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/BacklinkFilters.js\":\"1dd356d2be782c17\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"17fb4beaa7fcc623\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/BlockEntry.js\":\"782d6d6492a52a27\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/LinkedReferences.js\":\"8ff50349c76bc855\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"320a58c0a375341b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/dailyNoteDefaults.js\":\"d5e582c8c5c5857e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/dataExtension.js\":\"b3744205654ac31a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/edgeExclusions.js\":\"0b07d2f7a6c816e1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/filterProperty.js\":\"ff1fdb81178efd18\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/index.js\":\"0b06174939aeb0ce\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5ceb731d458d9041\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/applies.js\":\"bd6aa142cfec0d57\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/countQuery.js\":\"072af71cfc648e48\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e647766830647966\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/index.js\":\"d8e127f1507b5c22\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a805722d771d3bb2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/presentationInvalidation.js\":\"1aa1f81cfa8af647\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/propertyEditorOverride.js\":\"e33fab9ddfebb678\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/propertyFilter.js\":\"c4bdbe5c0ef0e9da\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/query.js\":\"8a259951d636fb52\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/resolveFilter.js\":\"99f3fb1db12aba7f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/sourceBatch.js\":\"fa8acff5e298e034\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/sources.js\":\"816dad1a5c9cdbed\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/useBacklinks.js\":\"04495438dd9bcbd4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5517ba94ec7c4107\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/BirthdayCelebration.js\":\"c91d256e1f526ce2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/BirthdayOverlay.js\":\"5767bd5355e1c374\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/gate.js\":\"509521751f40aa21\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/index.js\":\"45112b03ad99bb7e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/birthday/wolfTheme.js\":\"fa79598431069631\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/BlockDragLayer.js\":\"21e0024e4d6e9616\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/dragController.js\":\"48089211726332c6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/dropTarget.js\":\"1de368b8cf655ea9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/index.js\":\"3eb0b1e5bac215de\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-drag/projection.js\":\"a69551444a8c94ad\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-info/BlockMetaCard.js\":\"04fb67d3d199ad86\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-info/index.js\":\"b2ccdddb23fc617b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/AddTagDialog.js\":\"5bcaa5486c52b874\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2aacacb032f5a45c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/TagNameIssueHint.js\":\"da965f787d83198a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/addTagAction.js\":\"8949587e217b570b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/appendTag.js\":\"e71ba0f9c7186165\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/config.js\":\"6d69781e01207bd2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/dataExtension.js\":\"e8d9732ddd549fa4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/index.js\":\"915003db303af2b4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/block-tagging/propertyEditorOverride.js\":\"0f0ebe5c3f8cf9ec\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9feeca0061271ad9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"0f7217acbcbc485b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/Breadcrumbs.js\":\"225a5dd0327e0460\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"401f9cd3bb96b414\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"220b58e929440847\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/index.js\":\"d84385ea0dee231a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"18a9cb289b11eaa4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/CharacterCountItem.js\":\"42373848a36dd3bf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c5b76f881f747e86\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/actions.js\":\"66c39c2490ae3ce5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/blockType.js\":\"c92ba601fa46abeb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/charCount.js\":\"739b6ae0e7c08a81\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/dataExtension.js\":\"5d31b18c81dfa916\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/index.js\":\"8a5663b5d020fdbc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/profiles.js\":\"24cc1e52c8221a1c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/properties.js\":\"9c60de6331c766c2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/character-counter/textCounts.js\":\"dff737cf29bf73d6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/colemak-keybindings/index.js\":\"2e4909c4d9239587\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/CommandPalette.js\":\"50d88f84edb12221\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/HeaderItem.js\":\"19cfa13e0419fd2e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/context.js\":\"ad7a530769f22cb5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/index.js\":\"57b0916477735e07\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/selection.js\":\"ed192b6a7adb123f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/toggleStore.js\":\"bdc1b7cabcb956e1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/command-palette/useCommandPaletteActions.js\":\"f5e914a92856cb49\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/ContributorBadges.js\":\"1d4b8589efec2e5a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/author.js\":\"853ce25c93a82d1e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/codeMirrorExtensions.js\":\"3479587098a721b1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/dataExtension.js\":\"f8746fe2a6dfac1f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/index.js\":\"a46d5bbc540eeaff\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/mentionAutocomplete.js\":\"32e2962d75806b44\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/processor.js\":\"436b7409d73453d7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/profiles.js\":\"b69f058db40c52e1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/queries.js\":\"63e2af1045a37448\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/contributors/schema.js\":\"07d749c74b7f27e6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"83b14648c63b0ca6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/followOrigin.js\":\"79e95553d1afcefc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/index.js\":\"459716ea1dbfee46\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6cae0d7b0a85c85a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"2c78a0fe7657fac5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/CalendarGrid.js\":\"fd095d008075b879\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/DailyNotePicker.js\":\"379046abccdd9605\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"00bfa5984f40a12b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/DateNavDecorator.js\":\"577cfd5654cda3a2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/DateScrubOverlay.js\":\"231fd0fbce6cd539\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/HeaderItem.js\":\"287c6c7df9a99259\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/ReschedulePicker.js\":\"75f1fbed8e0cda36\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9e61a7ac284ec2d4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/actions.js\":\"35d24badee7f3b30\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/blockDateAdapter.js\":\"c31b4de7ce0b0260\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/calendar.js\":\"99aef1159c824800\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dailyNotes.js\":\"49a31058c913d550\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dataExtension.js\":\"6b1a72a9e5e1084b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dateScrubActions.js\":\"2a20ebfd441cebff\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dateScrubGesture.js\":\"29e228b3e915cd9d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dateScrubGestureActions.js\":\"83847b7a0d20b539\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ad3b5b04f96e0a16\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/deletionGuard.js\":\"bc8b0460098f3f1e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/dueQuery.js\":\"99eecaf24a7f1423\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/index.js\":\"4770d0cbbc22e484\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/landing.js\":\"7ea2a273a789db91\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/localSchema.js\":\"c6c6c16bcdcaed44\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/referenceDateAdapter.js\":\"619f0bb8f7969535\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/rescheduleAction.js\":\"d47c555b1d9738a1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/schema.js\":\"e4f17d086957926e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/spreadBlockDates.js\":\"f3ae79aac0fd11d1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/spreadDatesAction.js\":\"edfd3f624e0aeb70\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/today.js\":\"424f10babb1d08bc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e51632a53bbf13ef\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"75d6f6e5a5c9817c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/audit.js\":\"b17b16fcc4764321\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/auditAction.js\":\"c91522dcf1e52624\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/auditRanges.js\":\"df8b120ee9b3d306\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/diagnosticsSource.js\":\"6dcfc899579ea749\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/divergenceScan.js\":\"7c865abe12993d38\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/index.js\":\"933da7cb3b1160b0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/propertyChildrenChecks.js\":\"cca9854f53a8feb1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/referencesMirror.js\":\"5864e19e905f9399\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/rowJson.js\":\"5b27b4589bdaf9d8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/schedule.js\":\"d97de460f902c020\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/data-integrity/store.js\":\"87d441cbe5e61476\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-maintenance/action.js\":\"c9d851e982acda6a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-maintenance/index.js\":\"ec4c5d3b006b2b61\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-maintenance/plugin.js\":\"8a05dcf8a7ebad68\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"59c1ac77910023c2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/actions.js\":\"c7f36d0e8e6604d7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/changeMarker.js\":\"6b16ab3ca34fff55\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/diagnostics.js\":\"95c0b2493f1a076d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/fileSystemAccess.js\":\"bb98273521557af2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/filenames.js\":\"2d0d595473e19924\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/index.js\":\"51ac05fca438787d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/mirror.js\":\"f90d86f02a3dfefe\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/runLock.js\":\"3315bd38d55ec5b1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/runtimeHealth.js\":\"83d3e9937b63ea07\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/schedule.js\":\"42ffb325e07f327c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/db-mirror/store.js\":\"557a35ec3f29397b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/default-themes/index.js\":\"e42ac66f54084364\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/default-themes/themes.js\":\"2ed27cab1d9045fd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/diagnostics/facet.js\":\"4c2ceafdd9c72283\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/diagnostics/useDiagnostics.js\":\"72c39cdb9652e7aa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extension-prompts/dismissals.js\":\"9f1e224d1cd074d4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extension-prompts/index.js\":\"f9d7a7ff41c2f5e3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extension-prompts/status.js\":\"e9e849b3484431a2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extension-prompts/store.js\":\"de68b8f68ddfc7da\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d7eb99f0f8e0d561\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/ExtensionsSettings.js\":\"df13b74066384491\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/actions.js\":\"b273115fcc75887b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/config.js\":\"2a7976d028d7874d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/dataExtension.js\":\"c4cc7ac19a029fcf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/effect.js\":\"b18b55f6c1ce25c8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/index.js\":\"718ff6bc4900b3fe\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1c605ed99de568eb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extensions-settings/useToggleTree.js\":\"8eb8fe104d9c38ed\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/ExtractTypeDialog.js\":\"acfd7d8580bd37d8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"9c0ff59cbd44a10e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/PropertyShapePicker.js\":\"0709483495cee09b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/action.js\":\"5f1d223bc69a9a4e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/extract-type/index.js\":\"013a7f599291a21a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/FindReplaceDialog.js\":\"8acb493dc3b93d91\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/HeaderItem.js\":\"ec2b3663168e371e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/dataExtension.js\":\"20232bf574b9d720\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/index.js\":\"51e632524705e454\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/search.js\":\"3d48c0ba64c04795\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/toggleStore.js\":\"75aa8128441e4f42\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/LocationPropertyEditor.js\":\"489e805abec5b669\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/MapView.js\":\"f69c9b7c05338bb8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/blockTypes.js\":\"7b1a7829b4bdc12c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/codeMirrorExtensions.js\":\"cd06a43ec2ceb0d5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/createOrFindPlace.js\":\"765a7eee98028a01\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/currentLocation.js\":\"92f7fea81269334e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/dataExtension.js\":\"0b49c6430de443c2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/geoContentDecorator.js\":\"4a9853220af215d3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/googlePlacesClient.js\":\"938e1df36e491ea9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/index.js\":\"4452e8b7302fe170\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/locationsPage.js\":\"d1d830937e2ec1f8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/mapViewport.js\":\"b9c47fb7879561ef\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/pickCurrentLocation.js\":\"fc6fb88f365526db\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/placeAutocomplete.js\":\"486b08906069aaed\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/placeNameCollision.js\":\"ee3b670d5303c287\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/properties.js\":\"a2a521cf6a59aea5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/propertyEditorOverrides.js\":\"b1ed65471663e93d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/query.js\":\"872df1d254d7dc61\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/geo/usePlaceSearch.js\":\"95263efd2b7672d2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b9efb723cbb456b9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"af34b69cb98a0661\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"704028241259bc36\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/config.js\":\"78e2523d03858e04\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/dataExtension.js\":\"fbdfd0d5f4f2f110\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/facet.js\":\"73c19ca0ae660d16\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/grouping.js\":\"5491b301a549d423\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/index.js\":\"a48455d9c6afa316\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"cfbbb8f1ed5ebd5e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/query.js\":\"27bf6e60aa507112\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/resolveConfig.js\":\"8f348e77906cf9fe\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"96ac89307107f682\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"312599f71bf2198c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/HtmlDocumentContent.js\":\"200441ee1385a18d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/HtmlFrame.js\":\"f4096cef093ac64e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/actions.js\":\"5756b720329d6fa6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/blockType.js\":\"ab30a3c59fd702d5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/confirmRunScripts.js\":\"defef382e97e35f5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/dataExtension.js\":\"bf8d8ab598fb7136\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/frameAnnotations.js\":\"01b5f2120c99c3e4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/frameDocument.js\":\"1628c3c59e936986\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/frameTheme.js\":\"fd372ab03ecba7e4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/index.js\":\"7459c3166571f855\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/scriptConsent.js\":\"df4594967979a608\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/sourceMap.js\":\"9e2f8692a4328c1f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/html-document/useDocumentScripts.js\":\"8e6e9d014059d3e1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/index.js\":\"5b814259191aafe2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/record.js\":\"8d0f21652c58efd2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/recordStore.js\":\"7df2b9f77af4c61c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/responsiveness.js\":\"d804445098f1c5ad\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/schedule.js\":\"d74037f121c577b5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/interaction-metrics/sessionContext.js\":\"c84b0e9fa7e0a804\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fdef5c195a273df8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"724a90c6d43ec9b4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/actions.js\":\"92780baa7130d4c2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/config.js\":\"24ad31adc7d2f2ee\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/dataExtension.js\":\"8e382f78bc48ce38\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/effect.js\":\"ca0fa878ab4b177e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/index.js\":\"09ebb63aa6b71537\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/keyCapture.js\":\"a6b1e77e09163d55\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/overrideStore.js\":\"2f8792db5dd06af4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4d69fd1a4b6714f9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/HeaderItem.js\":\"9bbe8e312d5ff9e8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/LeftSidebar.js\":\"c41e26215091a672\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/actions.js\":\"9a10ded6a42007e8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/facet.js\":\"07c702360a096ed8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/index.js\":\"32263d17a7e586b7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/shortcuts.js\":\"16e819b8e96728ee\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/left-sidebar/toggleStore.js\":\"1129bd9df68d15d7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/merge-blocks/MergePicker.js\":\"c824349d011c5240\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/merge-blocks/index.js\":\"8fa4788c2b010b50\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/merge-blocks/mergeAction.js\":\"375fe14832ffb09c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/merge-blocks/strategy.js\":\"adac28073d4ea5e0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/Button.js\":\"c5c397e36469d434\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6d293d8c3ee76972\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/defaultItems.js\":\"c1b121ad30f843ba\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/facet.js\":\"d0b6dc1bb821daad\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-bottom-nav/index.js\":\"89973e12294d218f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0ef25e79e2cc53bf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/actions.js\":\"cdf23a99be5ba0fa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8b02d97b08c86c42\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/facet.js\":\"18d1b111f882981b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/mobile-keyboard-toolbar/index.js\":\"36edc0bf18979bd3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c6dfda9d1e6acf90\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2cdd2762de51ddf8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/contextMenuItem.js\":\"3b89f07bcac61571\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/index.js\":\"04c103d71d71a679\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/moveAction.js\":\"6db81e0fe6471204\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/moveBlocks.js\":\"63dadb9d2aadb640\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/move-blocks/selectionAfterMove.js\":\"5f69c44174dfa694\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/TutorialBanner.js\":\"c9c2c39afdffd4ff\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/action.js\":\"59a05fda54c19365\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/bannerDismissal.js\":\"2eba379a1d17d846\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/documents/cheatSheet.js\":\"83044e7199bc849f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/index.js\":\"c6eb013742982267\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/keys.js\":\"05413c3d5de42aac\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/landing.js\":\"c9229c07b7a6a9b8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/outline.js\":\"87f3495612e7e109\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/onboarding/seed.js\":\"bef72806f927b6af\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/PerfTrendDialog.js\":\"422f222833986e3f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/analyze.js\":\"5697e8d93a48ad64\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/diagnosticsSource.js\":\"1399a1b018419d67\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/index.js\":\"a79d45a0c15073db\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/load.js\":\"f660888f578e9b2a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/monitorRun.js\":\"4439ec070c9846d6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/schedule.js\":\"e9a5c14b69dc09bf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/series.js\":\"80224f0a320b18f8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/store.js\":\"cd67f5aa0f1f30d9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/trendAction.js\":\"5504114dbcc0fed0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/perf-monitor/verdict.js\":\"c4a2afdfd87fb2a6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/plain-outliner/clickToEditAction.js\":\"72ee52822f39bcb8\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/plain-outliner/index.js\":\"e47819a1534a88fe\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/plain-outliner/interactions.js\":\"369e7ade07bb9b16\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"63fbbb7dc02682aa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/MigrationGate.js\":\"47f45cb0ef36c38b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/MigrationGateDialog.js\":\"9ed6f8fefac5a6f7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/action.js\":\"5c6969c6e226438a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/index.js\":\"b0a47343c1848016\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/localRunMessage.js\":\"c497f2622024c4b7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/plugin.js\":\"c7e0e825e1bdf691\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/progressReport.js\":\"9024fe0ba969c556\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/properties-migration/sweepProgress.js\":\"6f923dcd2846b8fc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/FieldRowRenderer.js\":\"9d219caa7fcfcc84\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/ValueRowRenderer.js\":\"43d59a0e68007b11\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/actions.js\":\"4bc3515b21835a5e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/autocomplete.js\":\"72cc88e1d85e2d2e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/fieldRow.js\":\"1f459b6439f1f3ef\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/index.js\":\"fb17d585fd5d54a1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/referenceWarning.js\":\"945a3296646a04af\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/valueAutocomplete.js\":\"abcf7bcc681355b2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/property-rows/valueSchema.js\":\"b7cf69a98a0b483b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/HeaderItem.js\":\"f0222ee87338f7d0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/QuickFind.js\":\"a90a23829a1cd295\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/index.js\":\"245fb566ed215bde\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/recents.js\":\"01e3250e6575236d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/resultItems.js\":\"cf81c8ec4e30ecc4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/selection.js\":\"7976e044e91cf7db\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/quick-find/toggleStore.js\":\"4d83a9861443e874\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/HeaderItem.js\":\"7cade0c3f29abce5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f4f19266a009c9a7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/grouping.js\":\"f61debdaa8079073\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/index.js\":\"84cf47bcf7588ad4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/recents/target.js\":\"b4e7934575bb0d2b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/codeMirrorExtensions.js\":\"ba059fa362635a59\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/contentPrefill.js\":\"4dab42f1718c9a43\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/dataExtension.js\":\"3232dad9dceebdfb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/index.js\":\"f10acbb200e33a40\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0a61d33af866e18d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/invalidation.js\":\"34c2d178e1fd15a4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/localSchema.js\":\"c981020a1328193e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/blockrefs/index.js\":\"7f55a94aa4a0023f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"44be5435ea5ad9b5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/index.js\":\"b5cc03f938721bb0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/referenceNode.js\":\"f5c1801e83ce6b33\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7b5e701d2158f9c2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c1960a7f60f39fca\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/wikilinks/index.js\":\"1783be0e9ef3a296\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"52abc71ac5be834a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"543cfa5ad88d0af1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/mergeRetargetProcessor.js\":\"2b6e2b5240a68cf9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/parseFence.js\":\"f00121dc2aac0452\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/referenceParser.js\":\"78073876014b87ff\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/referenceProjection.js\":\"cfad69953fb4a25b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/referencesProcessor.js\":\"11f64f3d426822ea\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/renameProcessor.js\":\"9a745f66f9732148\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/references/spanReplacement.js\":\"a4240a539086bb23\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/rich-paste/htmlToOutline.js\":\"0799d5eb171956df\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/rich-paste/index.js\":\"c8e5a1fe6e263e2c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6e528c2d84b7331e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/rich-paste/pasteDecision.js\":\"c77ac0a107b209b2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/action.js\":\"75faa1e305e98083\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/blockIds.js\":\"680a15be4077fcaf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/content.js\":\"fa08e95b13807b30\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/effect.js\":\"88e8dbda31f8938e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/ids.js\":\"98fb41624a3aec92\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/import.js\":\"286bb860612e353a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/index.js\":\"7af3813af164413b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/plan.js\":\"21555d252a79b131\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/plugin.js\":\"2b806ff13df2a928\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/promotion.js\":\"dba8d7a277140c8f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/properties.js\":\"9abffea15daf126d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/references.js\":\"3755169cfdf41141\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/report.js\":\"23dc9ba30e59196f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/roamMemo.js\":\"95425b5dbe09f60b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/runtime.js\":\"e0d77a2dde86f18e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/schemaReconciliation.js\":\"1dae8818eeac7810\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/srsMarkers.js\":\"ad546b08ddb92557\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/todo.js\":\"4ba05a62ef1b668f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/typeCandidates.js\":\"cfbfe1eea449fb5b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/roam-import/types.js\":\"a44fab07312f31ca\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/search-health/index.js\":\"610aefd5f38da540\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/search-health/store.js\":\"c2066f1cecc13f8f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/HeaderItem.js\":\"dc273c7b415b8220\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"fff6f1842d62673b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/index.js\":\"79e50c39b7d370ef\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/model.js\":\"3ea2b36cff6e5a1c\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/toggleStore.js\":\"8d75fd3fae4212cb\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/shortcut-help/useKeyInspector.js\":\"54eac1cf8ca3d21b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"fabd1fab7afa4888\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/ShellDecorator.js\":\"3e74dc1b05ca0083\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/actions.js\":\"f2afb79f33e58fc2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/exclusionsFacet.js\":\"aaefb599cab5b054\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/index.js\":\"4be2524643a713c7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/shell.js\":\"a951cc2f03e3caf2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/surface.js\":\"5c28e8efc7db38db\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/spatial-navigation/walker.js\":\"afddd47040be0174\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d88762a92c00d42f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/dataExtension.js\":\"b3d39eeb82f25abc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/index.js\":\"7d830b8d793ec978\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/indicator.js\":\"5c6f74dc40d181dd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/moveSrsState.js\":\"af9cfb02c09997c7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"10b7d9107e8247bc\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/scheduler.js\":\"b0a99a8f8e62b018\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/schema.js\":\"70ea6e44c298b36a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e0d90ca94e145875\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/srsClipboard.js\":\"05bc528443f622c6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4456a68888a562bf\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9dd0e1c482e6fad3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/DeckPicker.js\":\"a09087bea23f4641\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/ReviewControls.js\":\"e20c873a0a477314\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/ReviewDeckRenderer.js\":\"72a89f2235529f26\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/ReviewSession.js\":\"483e0b0f16dcd226\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/actions.js\":\"f0dcb51196eee887\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/archive.js\":\"7e31a0b2e26dc085\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/dataExtension.js\":\"dfb39027aa581084\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/deck.js\":\"89cd005d083156a2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/dueQuery.js\":\"79c567445a248b43\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/gradeDecision.js\":\"f52b5d50faa9932f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/index.js\":\"16e6333e2548d827\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/keyHints.js\":\"0f6d87785f448088\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/reviewCardLayout.js\":\"0fc5221bf83d2fb2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/reviewProgress.js\":\"8ca0c3d500a8b922\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/schema.js\":\"2fba4c265003f3dd\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/srs-review/useDueCards.js\":\"7b0415ebe46d9cb1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/startup-metrics/index.js\":\"ad3c5a89de9ecb67\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/startup-metrics/record.js\":\"785349cff44d6b70\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/storage-persistence/index.js\":\"62b87c0833c41552\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/storage-persistence/persistenceStatus.js\":\"137b471f5cfd8285\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/storage-persistence/requestAction.js\":\"4c8567b2b68b5f97\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/supertags/TypeChipsDecorator.js\":\"d98c20de4bd21407\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/supertags/codeMirrorExtensions.js\":\"e95c2cd2fa079153\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/supertags/index.js\":\"7d401ed341da14aa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/supertags/typeAutocomplete.js\":\"55b388651700ce2a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"aa590169436e1bc2\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/actions.js\":\"c57f9540ba5bf9d5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/anchor.js\":\"c906c9dac0100a5f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/events.js\":\"86ce9d0bb0d16db7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/gestureActions.js\":\"b013a677c775f7fa\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/index.js\":\"387bd3fc5d8d1001\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"25b519e3a27de88b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/sync-metrics/collect.js\":\"971681e03370eac5\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/sync-metrics/index.js\":\"71dbc5794c2c9135\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/sync-metrics/record.js\":\"796ceceb5ab35250\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/RejectionDialog.js\":\"596448761424c7b0\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/SystemStatusHeaderItem.js\":\"17cd2a3616511250\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/index.js\":\"114b35a42c937b98\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/model.js\":\"5978636c972f92a9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/queueCounts.js\":\"79134f6b38956b18\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/rejectedHelpers.js\":\"58aff2ea3faa053b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/rematerializeAction.js\":\"222df0f4bac35f41\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/system-status/useHysteresis.js\":\"b16c89af6b69fd23\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/theme-toggle/effect.js\":\"d7dbf95c620ab8ab\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/theme-toggle/index.js\":\"e33b9e6d7ebb3c3b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/theme-toggle/theme.js\":\"4a654506063b4b42\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/todo/actions.js\":\"a2f5de2fa6d6e752\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/todo/dataExtension.js\":\"3be13a00272692f3\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/todo/index.js\":\"8f8dae2d3bb81bef\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/todo/schema.js\":\"1ebbae502d62b46a\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/TouchSelectionLayer.js\":\"19aa63ba41322b02\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/actions.js\":\"f208890b5d0b4149\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/defaultItems.js\":\"6c7b0158a06b560f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/facet.js\":\"f6cdb27f587658b4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/holdRecognizer.js\":\"512a655640f047ae\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/touch-selection/index.js\":\"1b989650629d3496\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/update-indicator/UpdateIndicator.js\":\"afe51a5aa4d43cb4\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/update-indicator/index.js\":\"7a64d1e691ad5b9d\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/update-indicator/loadTimes.js\":\"ed741f6fe62b0d41\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/VideoNotesRenderer.js\":\"0a5bf58ce95d4823\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/VideoPlayerRenderer.js\":\"578463fbae21e887\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/VideoTimeStamp.js\":\"59bb119f304e79ca\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/actions.js\":\"ac894364f3ee981e\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/index.js\":\"914b149c2a4bd032\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/markdown.js\":\"d25f2792588d45af\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/notes.js\":\"94a2e2524f14b02f\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/registry.js\":\"7e44e4305ddf82c6\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/remark-timestamps.js\":\"32f605ff2198f7f9\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/video-player/view.js\":\"04c1ffd0ee8c9517\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-link-hints/LinkHints.js\":\"1344164aeda2a1d7\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-link-hints/index.js\":\"ae220d4a41e3f6de\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-link-hints/model.js\":\"97a2a5ceb608f358\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-link-hints/settings.js\":\"cd45ebe97a3ab1e1\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-normal-mode/actions.js\":\"be7feab239f1bc41\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-normal-mode/index.js\":\"ba29db8a40082d5b\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/vim-normal-mode/interactions.js\":\"0f37f36ca8d47c46\",\"/knowledge-medium/pr-preview/pr-1814/src/plugins/workspace-header/index.js\":\"d23d933ea79d5551\",\"/knowledge-medium/pr-preview/pr-1814/src/registerServiceWorker.js\":\"503183b3c0943a9f\",\"/knowledge-medium/pr-preview/pr-1814/src/requestPersistentStorage.js\":\"b4788d8c473be210\",\"/knowledge-medium/pr-preview/pr-1814/src/services/authRequestDeadline.js\":\"777fd24fab525cd4\",\"/knowledge-medium/pr-preview/pr-1814/src/services/authStorage.js\":\"10cd0bf4fc02f3f7\",\"/knowledge-medium/pr-preview/pr-1814/src/services/powersync.js\":\"588ad14acaf494cd\",\"/knowledge-medium/pr-preview/pr-1814/src/services/supabase.js\":\"7cb8405488752852\",\"/knowledge-medium/pr-preview/pr-1814/src/services/uploadErrorClassifier.js\":\"baf9d0ca80d789ab\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/ActiveContexts.js\":\"5f50bf0fa8f257a0\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/HotkeyReconciler.js\":\"69e59d5450789321\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/WipeLocalDataDialog.js\":\"edc7861c08de1457\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/actionDispatch.js\":\"08f2a4cdcc8ce2cf\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/actionRefItems.js\":\"05e8693e3a10d56a\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/applyKeybindingOverrides.js\":\"a040673c6ff96aea\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/blockActions.js\":\"b4c080b8f48ce2ac\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/canonicalizeChord.js\":\"bd022c09b3cc3e53\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/defaultContexts.js\":\"2f706e7a22074929\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/defaultShortcuts.js\":\"03c02c008f2f2e39\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/effectiveActions.js\":\"d41b7060509d8205\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/gestureAction.js\":\"672caca65c9d754a\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/gestureBinding.js\":\"fb6094e5216c4477\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/holdRegistry.js\":\"3bf6837a5e4fdc0b\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/keybindingConflicts.js\":\"84e0b3f2f2ea9f9d\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/keybindingOverrides.js\":\"46676c344456f1f3\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/pointerAction.js\":\"f4ecd4a992d9e191\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/resolve.js\":\"aebfdb1c8ca611f8\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/runAction.js\":\"a6fe59924e507954\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/sequenceMatcher.js\":\"ec89b27520d57b7f\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/types.js\":\"5d8d0a9dbb7a6840\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/useActionContext.js\":\"ab46db6c92440b0b\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/useActionDiscovery.js\":\"5a273e6ef97e4605\",\"/knowledge-medium/pr-preview/pr-1814/src/shortcuts/utils.js\":\"36dd88d697dc05d8\",\"/knowledge-medium/pr-preview/pr-1814/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1814/src/sw/bootStore.js\":\"9b73ce007fd35669\",\"/knowledge-medium/pr-preview/pr-1814/src/sw/previewDatabases.js\":\"ca02add3293819e6\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/byteTransform.js\":\"cba41e939b8777a0\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/attachmentCleaner.js\":\"050774fef86ef8c6\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/attachmentParts.js\":\"aede3ae6fd07c640\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/bundleParts.js\":\"2ddc76b099cdde9f\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/bundleRecord.js\":\"c7ac4b0122997d0b\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/manifest.js\":\"5b84f7424f860f9e\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/takeBundle.js\":\"2db66c56fefe3f01\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/bundle/verifyBundle.js\":\"064c97dd99986d05\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/cleaningStage.js\":\"286cce55d6b26fc8\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/conversionKey.js\":\"0cb89acf90ccee77\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/conversionServer.js\":\"100b1cf2f3e38b10\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/flip.js\":\"111dc33b0b704f2d\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/flipAttempts.js\":\"c3b7b5ed695680dc\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/pages.js\":\"7181864a6792aa8c\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/preflight.js\":\"e2b2f6dab2fc5328\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/reseal.js\":\"c8c98be343219d97\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/runConversion.js\":\"710bf60439f79c09\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/runLock.js\":\"1732b2df7b1fc83c\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/sealing.js\":\"a444a14d4a1e8554\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/sealingStage.js\":\"23c348d6a259e08a\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/stage.js\":\"d2a386eecb2ced25\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/conversion/verifyReseal.js\":\"c72259c5b8086ed0\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/aad.js\":\"48f630c7f63d709d\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/aead.js\":\"d8f495a5433b5ce3\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/base32.js\":\"7aaa16c47446efd3\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/base64url.js\":\"9385f26d4f2e52d0\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/binaryEnvelope.js\":\"cd867afd25f87043\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/byteAead.js\":\"4e708e7825b606d6\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/canary.js\":\"8203fafa512237de\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/contentHash.js\":\"659ae42053e5b932\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/contentKey.js\":\"17e8e3cc0721b7ed\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/derivedIdNamespace.js\":\"f6859a12deeb1b39\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/envelope.js\":\"61c87a71463017b9\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/hex.js\":\"a3279071a4a5a53f\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/sha256Hex.js\":\"f9bf3950e09b2887\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/crypto/workspaceKey.js\":\"7bb768c9ebeeab05\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/conversionState.js\":\"9dde94e07dd44afd\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/flows/createEncryptedWorkspace.js\":\"90978d4ba8dc3d33\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/flows/pastedKey.js\":\"e4003e91bc1689d7\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5cec55ddcbdcb11d\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/flows/upgradeWorkspacePin.js\":\"561365dfb6f8c2db\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/keyStore.js\":\"a65cc6c93561365b\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/mintWorkspaceKey.js\":\"87518e117fc22701\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/modePin.js\":\"a1ec1019566176d1\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/openWorkspaceKeys.js\":\"78325de1715ececd\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/resolveWorkspaceEntry.js\":\"4172cfcccc8c1315\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/resolver.js\":\"b4623d46ed79fb4b\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/keys/workspaceAccess.js\":\"9307edfbd81a4204\",\"/knowledge-medium/pr-preview/pr-1814/src/sync/transform.js\":\"c6c268f8ee020214\",\"/knowledge-medium/pr-preview/pr-1814/src/themeBootDefaults.js\":\"4ac569e7cc013ffc\",\"/knowledge-medium/pr-preview/pr-1814/src/types.js\":\"2dc47e0817f46396\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/ClientLocalSettings.js\":\"3afa95cd4e485826\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/abortableSleep.js\":\"ea952664df84f575\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/array.js\":\"878e51f0e1f3eabb\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/backlinkAutocomplete.js\":\"7dc9864b8d334c96\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/blockCrumbs.js\":\"efb86f73fdcf3b4f\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/blockrefAutocomplete.js\":\"29cad67b88100a29\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/cadencedIdleJob.js\":\"d9d77da84f8aad9f\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/callbackSet.js\":\"5480686d3a0648a8\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/clientId.js\":\"b5123f1ccc9c0e5b\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/codemirror.js\":\"d392cb35cd9f783a\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/codemirrorCompletion.js\":\"93aa429130b9ab8c\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/copy.js\":\"5997d93421c75c51\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dailyPage.js\":\"4046ff382eda1672\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dbForensics.js\":\"209d1b682eb9e3e9\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dbForensicsHooks.js\":\"40110d62b76016ee\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/deleteBlockThroughUi.js\":\"6e55aec79bced101\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dialogs.js\":\"d287aaa22523c5d1\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/dom.js\":\"8e2a610b86b1f791\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/downloadBlob.js\":\"97c0f125ae872672\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/exportSqliteDb.js\":\"48e7cbf51f35438b\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/fileSystemAccess.js\":\"a3ae0cdee55c3c37\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/flipSlide.js\":\"bb8d9f2ce328c422\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/fnv1a.js\":\"7d956652fa65c275\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/formatBytes.js\":\"1d34628a64a36233\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/fuzzyRank.js\":\"6b8791bdddb729a8\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/idbKeyedStore.js\":\"60846dd248cda888\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/idleCallbackPolyfill.js\":\"8592f45111007bd0\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/keyboardAwareScroll.js\":\"eb9b9cfc8a5f5724\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/keyboardViewport.js\":\"f803962c93ec3b99\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/lastWorkspace.js\":\"b50880b8736f8a51\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/layoutColumns.js\":\"2aabb3c596218e67\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/layoutSessionDom.js\":\"62f51be7ed81e2ea\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/layoutSessionId.js\":\"dc467eb0ee39f75f\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/linkClickGestures.js\":\"675d134d1553bbf1\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/linkTargetAutocomplete.js\":\"72d558d8820e099a\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/localDbCorruption.js\":\"2372f6a96bd2aac1\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/localDbRecovery.js\":\"3cc47b4abd51a717\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/markdownParser.js\":\"572f6edbd4ff89cc\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/memoize.js\":\"34064d5dcfd7bf89\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/nameFieldCommit.js\":\"f01f46fd815a7eb0\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/nameList.js\":\"a1c977b5df726db0\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/navigation.js\":\"d8c873e6422fc3d5\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/omnilinerNamespace.js\":\"6f5ac411f7ca3e8a\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/opfsPageScan.js\":\"9b83a220c344723b\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelClearance.js\":\"c8b3e335c4d6c2fc\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelHistory.js\":\"c3b42ca0322e0757\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelLanes.js\":\"ed8c9400149dfee5\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelLayoutProjection.js\":\"a74c905955a02fe4\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelScrollAnchor.js\":\"836b12d2461a5fcd\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/panelUrlFlags.js\":\"000ddfae9915de72\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/platform.js\":\"07aec153f0973df0\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/pluralize.js\":\"c66926de9c7d82a8\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/propertyCreation.js\":\"341f75f107f3ed1e\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/propertyNavigation.js\":\"234f8c3d6d03bed9\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/propertyValueContext.js\":\"af42c7b8c37dd769\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/react.js\":\"9ff9279e2c79b7b1\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/relativeDate.js\":\"4c8864c4903c4b7f\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/relativeTime.js\":\"528d5f3316612422\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/renderScope.js\":\"5f3cc03c71a723dc\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/resolvedThenable.js\":\"df8d267cef0bcfe2\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/routing.js\":\"e878f5d3481df07a\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/safeMode.js\":\"1ca20a35c20fd356\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/scheduleIdle.js\":\"f622bdddc98d94fb\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/screenWakeLock.js\":\"a420288db6ad07ba\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/selection.js\":\"ed3fc94aa2d9e1c6\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/softKeyboardGrab.js\":\"ecc6ccf76e23df7b\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/startupTimeline.js\":\"770023c2ede86b05\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/state.js\":\"f5c45fb1082b896f\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/string.js\":\"de1bf4b6c1147ae1\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/surfaceZoom.js\":\"0284a6dd2ddcdee3\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/time.js\":\"2cd94cba681770b8\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/toast.js\":\"7c21e8436c044581\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/toggleStore.js\":\"f463d50bb37ab63f\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/untilStopped.js\":\"195c3ff3de0b14d3\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/userActivity.js\":\"db4d8677a362ec2e\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/viewTransition.js\":\"2239ee8f7e1971d3\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/viewport.js\":\"0b1a0eee027438c2\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/webLock.js\":\"f26fa163823723c6\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/workspaceRecovery.js\":\"fb40ef1da6af2745\",\"/knowledge-medium/pr-preview/pr-1814/src/utils/workspaceSnapshotStore.js\":\"c7fc32a192745bd7\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-compiler-runtime.js\":\"1fbdd34d90bc6ae2\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-client.js\":\"4eb357f06a717d1a\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-server-edge.js\":\"6d05278e18570afa\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-server.js\":\"37aff45ece2bf8d8\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-static-edge.js\":\"f810e57788e2e21a\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-static.js\":\"5f883734903ae229\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom-test-utils.js\":\"fefe1bae86514824\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-dom.js\":\"73f53e4f485cbcec\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react-jsx-runtime.js\":\"26bb1c49f53f4307\",\"/knowledge-medium/pr-preview/pr-1814/src/vendor/react.js\":\"6d34fac442fd98ca\",\"/knowledge-medium/pr-preview/pr-1814/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1814/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1814/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
