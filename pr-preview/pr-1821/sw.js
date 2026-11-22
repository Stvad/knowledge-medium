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
		buildId: "3546f171ef7c-4a3d2b84",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1821/\":\"ef7363d215dc2ef4\",\"/knowledge-medium/pr-preview/pr-1821/index.html\":\"ef7363d215dc2ef4\",\"/knowledge-medium/pr-preview/pr-1821/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1821/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1821/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1821/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1821/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1821/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1821/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1821/assets/FacadeVFS-CJpPlsvJ.js\":\"5805e6932cc10e68\",\"/knowledge-medium/pr-preview/pr-1821/assets/OPFSCoopSyncVFS-B6FncMiP.js\":\"3356047a4e73cfa2\",\"/knowledge-medium/pr-preview/pr-1821/assets/OPFSWriteAheadVFS-BXqb8Hyv.js\":\"82e73590b9f7abbf\",\"/knowledge-medium/pr-preview/pr-1821/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1821/assets/wa-sqlite-DaVhmALF.js\":\"b201a95bca2d74e8\",\"/knowledge-medium/pr-preview/pr-1821/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1821/assets/wa-sqlite-async-BdBemvZb.js\":\"a36bf928a65a8b41\",\"/knowledge-medium/pr-preview/pr-1821/assets/worker-Bvv52WTy.js\":\"f35a203ec32e8c15\",\"/knowledge-medium/pr-preview/pr-1821/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1821/chunks/app-C1xECUnF.js\":\"4e05540e1ddce1cd\",\"/knowledge-medium/pr-preview/pr-1821/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1821/index.js\":\"740bd8a1097d2a84\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1821/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1821/assets/AccessHandlePoolVFS-BocHtMxq.js\":\"a02fb3e13bd59d10\",\"/knowledge-medium/pr-preview/pr-1821/assets/IDBBatchAtomicVFS-D0LPDz7y.js\":\"f46041cc84c46033\",\"/knowledge-medium/pr-preview/pr-1821/assets/MemoryVFS-gwfNEcxj.js\":\"211071f7b8ee06d1\",\"/knowledge-medium/pr-preview/pr-1821/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1821/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1821/assets/mc-wa-sqlite-async-fh0Yd4KI.js\":\"e076c53b6db0205d\",\"/knowledge-medium/pr-preview/pr-1821/assets/mc-wa-sqlite-rcGPDIGD.js\":\"3597937d891e84f6\",\"/knowledge-medium/pr-preview/pr-1821/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1821/chunks/AccessHandlePoolVFS-KvELo7_K.js\":\"96cc85fe319e3da9\",\"/knowledge-medium/pr-preview/pr-1821/chunks/FacadeVFS-2sSAgreQ.js\":\"ed978fc61de51469\",\"/knowledge-medium/pr-preview/pr-1821/chunks/IDBBatchAtomicVFS-CoKDMVhY.js\":\"b57af8675189962d\",\"/knowledge-medium/pr-preview/pr-1821/chunks/MemoryVFS-C145I5nD.js\":\"555bb665a2f2589b\",\"/knowledge-medium/pr-preview/pr-1821/chunks/OPFSCoopSyncVFS-Cw2hzieW.js\":\"0378dd693516cc0c\",\"/knowledge-medium/pr-preview/pr-1821/chunks/OPFSWriteAheadVFS-DpjvyU6q.js\":\"5d167c407baa3314\",\"/knowledge-medium/pr-preview/pr-1821/chunks/Preview-kQcO9em_.js\":\"68ac5a2b9a9aabac\",\"/knowledge-medium/pr-preview/pr-1821/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1821/chunks/card-DoK7xzdF.js\":\"d6932dece238c3ed\",\"/knowledge-medium/pr-preview/pr-1821/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1821/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1821/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1821/chunks/dist-CXyNbyx8.js\":\"6946d7aba08449dc\",\"/knowledge-medium/pr-preview/pr-1821/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1821/chunks/mc-wa-sqlite-DcyOyW1H.js\":\"4b4d9c64a7eeca52\",\"/knowledge-medium/pr-preview/pr-1821/chunks/mc-wa-sqlite-async-DqmY1bBS.js\":\"35034070547195b7\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-BWBsaI8h.js\":\"df7fa75c79e2db49\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-Bt0FiGmr.js\":\"579595699b2e93d5\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-BuUL1zCL.js\":\"af7208d39a5fc53a\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-BxbDMDPq.js\":\"0b119110f429100a\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-CCRO3oE2.js\":\"b16f97517708ca57\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-CHCd8FYQ.js\":\"e5229032a00ba31d\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-CqzaEnn3.js\":\"b7c8796ef98bc610\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-cgjoBI8A.js\":\"534481e538e45813\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-dom-server-legacy.browser.production-BD3buzRM.js\":\"38b5935cb25d0237\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-dom-server.browser.production-DsKn9Bk7.js\":\"9972cb508fa6392b\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-dom-server.edge.production-BdxSVrP9.js\":\"7a417b9e6754702e\",\"/knowledge-medium/pr-preview/pr-1821/chunks/server.browser-CWbJfbsV.js\":\"582c6c14b01dca96\",\"/knowledge-medium/pr-preview/pr-1821/chunks/textarea-BflRtYAY.js\":\"fb42c1f55255f2d2\",\"/knowledge-medium/pr-preview/pr-1821/chunks/ui-C5ZIFSHS.js\":\"d115b301ff6207e4\",\"/knowledge-medium/pr-preview/pr-1821/chunks/wa-sqlite-C_HUXBAy.js\":\"e41a4fa0d9959e0b\",\"/knowledge-medium/pr-preview/pr-1821/chunks/wa-sqlite-async-aCCrnOKi.js\":\"d233a0cfda64960e\",\"/knowledge-medium/pr-preview/pr-1821/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1821/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1821/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1821/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1821/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1821/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1821/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1821/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1821/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1821/src/App.js\":\"f53a4c4fbe6710a2\",\"/knowledge-medium/pr-preview/pr-1821/src/appUpdate.js\":\"3e815117b111107e\",\"/knowledge-medium/pr-preview/pr-1821/src/appVersion.js\":\"56c27d1b480bc0ef\",\"/knowledge-medium/pr-preview/pr-1821/src/bootstrap/initialLayout.js\":\"df9e722a4d5a68ab\",\"/knowledge-medium/pr-preview/pr-1821/src/bootstrap/openWorkspaceData.js\":\"88089aa89b1d33ea\",\"/knowledge-medium/pr-preview/pr-1821/src/bootstrap/resolveWorkspace.js\":\"eff15f5e851daf79\",\"/knowledge-medium/pr-preview/pr-1821/src/bootstrap/workspaceBootstrap.js\":\"d21bc991e4238238\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockComponent.js\":\"69689d04e23457d0\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockCrumbs.js\":\"1a5cdce9797ab24e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockEditor.js\":\"85f06f937d5a0812\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockLoadingPlaceholder.js\":\"67c2a9ea03eac86a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockProperties.js\":\"119c10b8caea1b84\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockSearchPicker.js\":\"6179ec66b1f7fa86\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ConfirmBulkDeleteDialog.js\":\"08e96adadb0af4a2\",\"/knowledge-medium/pr-preview/pr-1821/src/components/DividerHandle.js\":\"0d99bde6f219819e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/DraftEditor.js\":\"24b76eb90ae55501\",\"/knowledge-medium/pr-preview/pr-1821/src/components/GutterPill.js\":\"f5d5288162f19242\",\"/knowledge-medium/pr-preview/pr-1821/src/components/Header.js\":\"e67247c8550a5a70\",\"/knowledge-medium/pr-preview/pr-1821/src/components/LazyBlockComponent.js\":\"55f4f2ce33754d67\",\"/knowledge-medium/pr-preview/pr-1821/src/components/Login.js\":\"ab1377ad6ccb7b83\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ZoomableSurface.js\":\"04f6c4405c4432f3\",\"/knowledge-medium/pr-preview/pr-1821/src/components/editModeKeepalive.js\":\"a283370dfdb1166b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f337ba0f5a224ad7\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"71d5fe149fe57eb8\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/RefPropertyEditor.js\":\"4cffac32d2c3d831\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/RefTargetTypePicker.js\":\"a2326919b1f761b7\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/SelectPropertyEditor.js\":\"8c214f64928c195c\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/TypesPropertyEditor.js\":\"8f318dffe23613d9\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/defaults.js\":\"25c38539d5416531\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/kernelValuePresets.js\":\"cd66ac0fe1e35edf\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/selectablePresets.js\":\"f38abf3dc99715c5\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/typesPropertyUi.js\":\"6f19fcd426cf672d\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/AddPropertyForm.js\":\"ddd1e15cd7022f2a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/PropertyPicker.js\":\"a0509ff141d3c31f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/PropertyRow.js\":\"2e3d76e1d8d71f4d\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/Rows.js\":\"08ab229f3a24d797\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/actions.js\":\"69b4f84e637f7feb\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/declarationOnly.js\":\"9c2194a34a07eda7\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/layout.js\":\"8bc2aaaf7a909650\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/model.js\":\"6b7aa445bf829696\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/shapeUi.js\":\"4d95818ec5ac04db\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/shapes.js\":\"7cf32be07f20e057\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c283a835466dc424\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/visibility.js\":\"b1936b0242796102\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanelSections.js\":\"3be33d9e58e8a274\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/BlockEmbed.js\":\"32c708960343c140\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/BlockLink.js\":\"3b9363b55ac9eb9a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/BlockRef.js\":\"1252c89be781d45f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/ReferenceLink.js\":\"966131b9123f9bfd\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/cycleGuard.js\":\"ab89bd7dd1422524\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/cycleGuardContext.js\":\"478fbc374db97ca8\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/linkInteraction.js\":\"89f59edb2a9176d0\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/referenceLayout.js\":\"ea4c46f1aeb0fa21\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/useBlockRefAncestors.js\":\"bb9f3611021c5cba\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/BlockGutter.js\":\"44edc6f524809601\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/BlockInfoDialog.js\":\"29aaf2348cf99b34\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/BlockTypeBlockRenderer.js\":\"dc441cef56c95182\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/BulletHoverCard.js\":\"2c18a46617a0f254\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/CodeMirrorContentRenderer.js\":\"03fcb28db5ccf4a8\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"856f3dc6d34c2f82\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/ColumnResizeHandles.js\":\"a102b9807a44c472\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c3f99ad91341b74f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/DefaultBlockRenderer.js\":\"63be187a16c05934\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/LayoutRenderer.js\":\"efe9bfc3009f64f5\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/MarkdownContentRenderer.js\":\"92b34c4f2175de90\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/MissingDataRenderer.js\":\"7eed23c50bbfc02b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/PanelRenderer.js\":\"a1e808d4781ee412\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b96a84e840003f9b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/TopLevelRenderer.js\":\"3d376c77dac634ad\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/blockGutterMode.js\":\"e3fb0da3f8c94cc7\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/blockTitleText.js\":\"22222c89c856bc3a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/fieldCreationKeydown.js\":\"5ce5deea7ba5d8d3\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/layoutRootContext.js\":\"395e371d4bca3bd4\",\"/knowledge-medium/pr-preview/pr-1821/src/components/typeChip/TypeChip.js\":\"47e48b2834d3c1a2\",\"/knowledge-medium/pr-preview/pr-1821/src/components/typeChip/chipStyle.js\":\"d0c052f71ff02187\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/anchored-floating.js\":\"f5047e63340e87ca\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/button.js\":\"77be7c6d180425ef\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/card.js\":\"5d040504d4322740\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/checkbox.js\":\"6a8069412221b28e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/collapsible.js\":\"98ab19d78801e5e5\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/command.js\":\"07fa15864a14b6f9\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/context-menu.js\":\"e6b08840c8036746\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/dialog.js\":\"9d9136cc5a22f510\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/dropdown-menu.js\":\"ace2c10a5f340e9f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/floating-listbox.js\":\"8b07f16202f91fa0\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/index.js\":\"099e4de8f5826585\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/input.js\":\"0e8e548f8688c954\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/kbd.js\":\"984f995a3b7c279e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/label.js\":\"ba311c047c83a9da\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/textarea.js\":\"8a411ad1f0682473\",\"/knowledge-medium/pr-preview/pr-1821/src/components/useEditModeYieldKeepalive.js\":\"8301d2cb209dcf01\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/BootFallback.js\":\"4c00f2fbfde6e78d\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/FocusedRowLazyMount.js\":\"f11faab4cf13a869\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/LazyViewportMount.js\":\"c70bf6aeb1fbf4ad\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/LocalDbCorruptionFallback.js\":\"ef98dcfc4fb006fc\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/error.js\":\"b321f43c7c7f27e4\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/lazyMountRegistry.js\":\"68088b9b8b52b1a3\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/suspense.js\":\"67059bd481e8b956\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/CreateWorkspaceDialog.js\":\"93167ff77a628ab3\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/PendingInvitations.js\":\"a7bdcddcc7a7a64c\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/SyncProgress.js\":\"c0292ad150061504\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/UnlockProgress.js\":\"9c65c133378770e0\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/WorkspaceKeyGate.js\":\"4bc81fe49a9823c5\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/WorkspaceSettingsDialog.js\":\"140fedb56cb09929\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/WorkspaceSwitcher.js\":\"4172d31e1b8b1704\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/WorkspaceSyncGate.js\":\"c104822d4207f4ce\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/ConversionFlow.js\":\"748e648bb79ba9de\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/ConversionFlowHost.js\":\"06a85bffa39103cd\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/EncryptionSection.js\":\"8cf5226d9f947a32\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/attachmentPrompts.js\":\"cf664483da045b60\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f58f10db2c4ce6e1\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/conversionFlowDeps.js\":\"1c68c72feb9c43c5\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/conversionFlowStore.js\":\"17aca8985c6ee3fa\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/flowUi.js\":\"c0ec01c6360e4f0a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/useConversionRun.js\":\"00a9e0b8b93f53a8\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/keyUi.js\":\"1c522dabbe9e7d0e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/useCloseOnKeyLoss.js\":\"0a28e5eb46312c0f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/useCloseOnServerE2ee.js\":\"7e6e697f70480bc1\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/workspaceUnlocked.js\":\"023c5f5e6dd8b610\",\"/knowledge-medium/pr-preview/pr-1821/src/context/backgroundSubtree.js\":\"86316afd24c38b03\",\"/knowledge-medium/pr-preview/pr-1821/src/context/block.js\":\"420917702ab2de70\",\"/knowledge-medium/pr-preview/pr-1821/src/context/layoutWsContext.js\":\"1c15d2838aadef63\",\"/knowledge-medium/pr-preview/pr-1821/src/context/propertyDisplay.js\":\"5376d934308d1397\",\"/knowledge-medium/pr-preview/pr-1821/src/context/repo.js\":\"9bfaf24d573328ca\",\"/knowledge-medium/pr-preview/pr-1821/src/data/aliasClaim.js\":\"00b73821a6f25863\",\"/knowledge-medium/pr-preview/pr-1821/src/data/aliasSeatNamespace.js\":\"92428a8b2c150c41\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/blockData.js\":\"7ab746112a67fbd0\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/blockType.js\":\"5f60f5920b410458\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/changeScope.js\":\"14a4e90d07c106cd\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/codecs.js\":\"51831a532e4f303e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/derivedData.js\":\"75a807bb023a3a35\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/errors.js\":\"875bac08f64133bd\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/events.js\":\"abe08356116f2a8d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/handle.js\":\"4917ee22ff4a9d7b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/index.js\":\"92f4ac936fed89e6\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/mutator.js\":\"0d85ee796418d0ea\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/processor.js\":\"8f11cad40244095f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/propertySchema.js\":\"2092ce7d9d3a4ab0\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/query.js\":\"5ff263a0b028dfe3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/sameTxProcessor.js\":\"c49b80a455a8321f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/schema.js\":\"4917ee22ff4a9d7b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/tx.js\":\"4917ee22ff4a9d7b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/typedBlockQuery.js\":\"c5ee35a88feb2ddb\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/user.js\":\"bf24ecb2fd86cac1\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/valuePresetCore.js\":\"2b3665ca03bafece\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/valuePresets.js\":\"dd8026b3f8b08ac9\",\"/knowledge-medium/pr-preview/pr-1821/src/data/attachmentCleanerIOVerb.js\":\"b2c2ca1785919a09\",\"/knowledge-medium/pr-preview/pr-1821/src/data/block.js\":\"84926fc425411a22\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockCache.js\":\"93a558deee5e21c6\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockId.js\":\"5c4622a3cd44fa47\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockLiveness.js\":\"69aad09ffa5387eb\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockMerge.js\":\"925b72b3f6838fa9\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockSchema.js\":\"a285957e2ea41467\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockTypes.js\":\"4a4280e524a7ef9e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/clientContext.js\":\"4021a2bf8e88d7d5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/dbFileSiblings.js\":\"a27038f2e9e5de76\",\"/knowledge-medium/pr-preview/pr-1821/src/data/definitionSeeds.js\":\"be957e00ff7a8cc8\",\"/knowledge-medium/pr-preview/pr-1821/src/data/derivedIds.js\":\"c0b72bff028e95c3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/drawnSubtree.js\":\"82e0454ead473622\",\"/knowledge-medium/pr-preview/pr-1821/src/data/facetBridge.js\":\"c69beb05ec99542e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/facets.js\":\"37796163f6b1bce1\",\"/knowledge-medium/pr-preview/pr-1821/src/data/globalState.js\":\"aeab4de8f7db173b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/aliasClaimRederiveProcessor.js\":\"7eefb7c1b2fea861\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/ancestorBatch.js\":\"a71d7136a34140f4\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/blockTypeTypeifyProcessor.js\":\"8dc89e09a461dc82\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/clientSchema.js\":\"05fc8a6bb2936685\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/commitPipeline.js\":\"d3a901bd1790e1b2\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/devAssertions.js\":\"07ba1708d8b7f515\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/firstSync.js\":\"0959d3e0d1be8995\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/freshInitialLoad.js\":\"3370ad0412dc5f0e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/graphBackfillClaim.js\":\"876789dd440edb6e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/handleStore.js\":\"f25f4e946146858c\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/idleMarkerJobs.js\":\"29c0627179209859\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/initialDownload.js\":\"e96acd01b64853b7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/initializeClientDatabase.js\":\"ef699524204eefb0\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/jsonCanonical.js\":\"16f230d6fb84fadd\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/kernelInvalidation.js\":\"6dbb8f2e9ceea788\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/kernelProcessors.js\":\"ab1024808264309d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/kernelQueries.js\":\"44d560c79fcdc70f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/mergeTypeMembershipProcessor.js\":\"21f23441c14fef5b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/normalizeReferencesProcessor.js\":\"33ca5c3b0c5b7f53\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/poolInstrumentation.js\":\"1885200d0ddbb1c7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/processorRunner.js\":\"a9adf9ef6dc5699d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyCellBackfill.js\":\"a0082bc0fc7cbac7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyChildMint.js\":\"a80914a6beb89d96\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyChildrenProcessor.js\":\"af71e9f1c62f05dc\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyDefinitionChangeProcessor.js\":\"af12ffc2ed5e2543\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyDefinitionSynthesis.js\":\"a62490c60c973623\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyKeyScan.js\":\"cd30c8a205561cad\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertySchemaResolution.js\":\"67ae7f03e36829ff\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyValueEdits.js\":\"e416cc35a9c60eac\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/raiseProtocol.js\":\"8bf7e33b662a3627\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/readBatch.js\":\"c5c76c0d5e464164\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/refProjection.js\":\"967e0071e0c04bed\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/referenceTargetLookups.js\":\"53dfad9cea3fb89a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/referenceTargetProcessor.js\":\"ae40b368ae28ba9a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/replayMerge.js\":\"17621e324fd5ac8c\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/sqlBinds.js\":\"d943e6df40a337fd\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"41267051f8401a67\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/arrivalProcessors.js\":\"41aa094eb9e156e7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/invalidate.js\":\"d81d309cd517cf68\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/materialize.js\":\"65c3358058b567c2\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/observer.js\":\"c3597919bb52b53b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/reconcile.js\":\"46967a719d19b5f3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/timingMetrics.js\":\"ebddad4e836d4a87\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/treeQueries.js\":\"fde75ef15dffa6ad\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/txEngine.js\":\"765ee7de53649582\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/txSnapshots.js\":\"27211842dd76e651\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/typedBlockQuery.js\":\"3524dd2dc2ba10f2\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/undoManager.js\":\"1f8850f3152a2cca\",\"/knowledge-medium/pr-preview/pr-1821/src/data/invalidation.js\":\"5eea4fbd8287de81\",\"/knowledge-medium/pr-preview/pr-1821/src/data/kernelDataExtension.js\":\"3045fcb563ea67d6\",\"/knowledge-medium/pr-preview/pr-1821/src/data/kernelPage.js\":\"79b4414fb7955aa9\",\"/knowledge-medium/pr-preview/pr-1821/src/data/kernelValuePresetCores.js\":\"1f03bbe682b04d1b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/localDbCorruptionSignal.js\":\"c4ccd81454121a17\",\"/knowledge-medium/pr-preview/pr-1821/src/data/localDbStorage.js\":\"c4d060a5f1870fc4\",\"/knowledge-medium/pr-preview/pr-1821/src/data/localDbVfs.js\":\"b099a4be237862c3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/localSchema.js\":\"388539dbdd457e30\",\"/knowledge-medium/pr-preview/pr-1821/src/data/maintenance.js\":\"b2cbeee834204811\",\"/knowledge-medium/pr-preview/pr-1821/src/data/mergeProperties.js\":\"bfc884a2f09c766c\",\"/knowledge-medium/pr-preview/pr-1821/src/data/metricsConsoleHook.js\":\"08dcb53e3dee2362\",\"/knowledge-medium/pr-preview/pr-1821/src/data/migrationsPage.js\":\"55eb85ae4ac1556b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/mutators.js\":\"29990ab88d7dc276\",\"/knowledge-medium/pr-preview/pr-1821/src/data/orderKey.js\":\"788aab543d8ef566\",\"/knowledge-medium/pr-preview/pr-1821/src/data/orderKeyPlacement.js\":\"d05466b95fd6140f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/outlineSurface.js\":\"4c2956f2b519edb7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/pendingEditorContent.js\":\"d2b98a926cc83d63\",\"/knowledge-medium/pr-preview/pr-1821/src/data/pendingUploadsSql.js\":\"57b1425e466b0721\",\"/knowledge-medium/pr-preview/pr-1821/src/data/pluginStateExtensions.js\":\"1ab56e4dcae87e3a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/powerSyncLogger.js\":\"2b9cc681447846b3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/projectorRuntime.js\":\"d3e592ba4c78f8e0\",\"/knowledge-medium/pr-preview/pr-1821/src/data/properties.js\":\"5b97c22f23e8fd2f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertiesPage.js\":\"3aae467bcead465f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyChildren.js\":\"c00799231ea91381\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyDefinitionFanout.js\":\"c05afab4265fd194\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyDefinitionMetadata.js\":\"e76cae500355fed5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyDefinitionRegistry.js\":\"2db1dbdb48edcbeb\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyDisplayMode.js\":\"16ec7858aa293d03\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyRowCreation.js\":\"fc63c5767bc43c58\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertySchemaCreation.js\":\"0029ddf2b8933991\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertySeeds.js\":\"56ee00b5a86754af\",\"/knowledge-medium/pr-preview/pr-1821/src/data/recentsPage.js\":\"defb5787231d5b1a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/referenceBlock.js\":\"201ccfad7a3c7224\",\"/knowledge-medium/pr-preview/pr-1821/src/data/rejectedUploads.js\":\"b1eb64e8f8bc2514\",\"/knowledge-medium/pr-preview/pr-1821/src/data/releasePowerSyncConnection.js\":\"e02081fc57e6e972\",\"/knowledge-medium/pr-preview/pr-1821/src/data/repo.js\":\"82b5b4f3a1b82aba\",\"/knowledge-medium/pr-preview/pr-1821/src/data/repoProvider.js\":\"8e9c8d096fd1a50f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/rowProperty.js\":\"7111927e800d656f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/searchFilter.js\":\"2611b380d8c7a3b3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/seedIdentityLedger.js\":\"3eedd746d60eb67d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/stateBlocks.js\":\"6d3bc702dc76fe42\",\"/knowledge-medium/pr-preview/pr-1821/src/data/structuralEditPolicy.js\":\"77892da83fcb593d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/subtreeDelete.js\":\"d9cc106966908281\",\"/knowledge-medium/pr-preview/pr-1821/src/data/syncStreamLock.js\":\"b225c1d75c495bf7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/syncedTableSqlRecognizer.js\":\"0200d7f248ecd740\",\"/knowledge-medium/pr-preview/pr-1821/src/data/syncedTableWriteGuard.js\":\"53d677b031183b1b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/targets.js\":\"149d29baaade9f34\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeColors.js\":\"057007658b97ff98\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeDefinitionMetadata.js\":\"4d8692d0bd242165\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeDefinitionRegistry.js\":\"7697cbd571ba1de9\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeExtraction.js\":\"e395d85f653def3e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeInitialValues.js\":\"4368c4a0f355416e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typePropertyGroups.js\":\"b2cb6e5badb8c093\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeSeeds.js\":\"6f11b05228c49c38\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeTagger.js\":\"089e4cc8fc8911ea\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typedRecords.js\":\"3767a230bec1259b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typesPage.js\":\"25f96dd90278bdb3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/userPrefs.js\":\"4cd8a5c35e969e10\",\"/knowledge-medium/pr-preview/pr-1821/src/data/userSchemasService.js\":\"bee8bc5b21dfb04e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/userTypesService.js\":\"ff1bfc4381ce7f66\",\"/knowledge-medium/pr-preview/pr-1821/src/data/valuePresetRegistry.js\":\"7e306000aefdf7bd\",\"/knowledge-medium/pr-preview/pr-1821/src/data/visibleChildren.js\":\"5d129175dbb51c33\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaceConversion.js\":\"82ef323942d334b8\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaceFirstSync.js\":\"16c573a82ffbeed2\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaceIdNamespace.js\":\"3b77d470ea06e033\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaceSchema.js\":\"4834030ea4ba69e0\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaces.js\":\"8c11147bc0a1ab2f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/writeAheadLog.js\":\"eb5691d109a6756d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/BlockPasteShellDecorator.js\":\"15a1a79f2937d59f\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/atTrigger.js\":\"90f5afdc2dc3e075\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/autocomplete.js\":\"a0eadafe29d57128\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/codeMirrorExtensions.js\":\"de4cf87708c06a05\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/contentFlush.js\":\"c1f019b7254f217b\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/defaultInteractions.js\":\"e7da8c6f9e108c77\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/editSettleSignal.js\":\"64d92dd9e01ee47d\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/insertImage.js\":\"6cac938e75215e8e\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/referenceCompletionRange.js\":\"c57c2484ac0d98cc\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/referenceTargetTypes.js\":\"fb0b97db8ef102da\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/syntaxContext.js\":\"26e59b1f642e9e26\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/triggerMatch.js\":\"e34500cd1b2e8ddb\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/AppRuntimeProvider.js\":\"71163422d53c2930\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/BlockFocusShellDecorator.js\":\"fa0f21d48222c518\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/ExtensionRenderBoundary.js\":\"2209a9d1b621df13\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/PanelContentRecovery.js\":\"be870e6c94277e19\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/apiCatalog.js\":\"4b50082d7bc20d0d\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/approveExtensionHere.js\":\"7ccf190bcc3a38c3\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/armedCutAppMount.js\":\"020f2241cfc19156\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/batchableKeyedStore.js\":\"ffdaa5e87e32a6c5\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/blockInteraction.js\":\"7b885a93043018e1\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/blockSelectionAction.js\":\"15850488ec5c24df\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/compileExtensionModule.js\":\"19130ee15d577dd2\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/compiledModuleCache.js\":\"4822e6968ae051f9\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/continuousGestures.js\":\"8c359026bc0cd38e\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/core.js\":\"d0972d80ddfb06ca\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/defaultRenderers.js\":\"4c18ef12b5801d31\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/definitionFanoutAppMount.js\":\"aa4fa8df42e83062\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/dialogAppMount.js\":\"67d96f8b01e43bc0\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/dynamicExtensionSeeds.js\":\"61d1b93bf5fb18f2\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/dynamicExtensions.js\":\"de5a9be811b71ac6\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/exampleExtensions.js\":\"909dabe746e8c115\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionApprovalStatus.js\":\"a4bd448139f5bfea\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionLoadErrorToast.js\":\"d1aabb39730ea664\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionLoadErrors.js\":\"2c0407c3a3c34703\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionLookup.js\":\"0f71cc96801b7ed7\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionToggles.js\":\"dea2f190172f5003\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionUtilitiesCss.js\":\"227616e24d9de8b0\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/kernelPageDeletionGuard.js\":\"bd29b687a3f63fbd\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/liveRuntime.js\":\"453e8f3fec512f52\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/openExtensionsSettings.js\":\"35d822264abab37c\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/overridesCache.js\":\"9cdcc9b64a677cc7\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/pluginIds.js\":\"33fb3a4c46336d42\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/processorRejectionToast.js\":\"6238cda0a2b1da22\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/runtimeActions.js\":\"3e7492950197e795\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/runtimeContext.js\":\"afaecc8825928d3d\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/staticAppExtensions.js\":\"02b34a61d7575c69\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/staticDataExtensions.js\":\"b9cd9f93e7c7d1c5\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/toastAppMount.js\":\"b1894854ee55a87c\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/useOverrides.js\":\"3f56d1231440630e\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/useShortcutSurfaceActivations.js\":\"3cd467f728e6ce39\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/discoverToggleTree.js\":\"1b01ef5c0e0f6b4a\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/facet.js\":\"8114b043cdb0f89d\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/resolveAppRuntime.js\":\"ed60d8d6d2577a86\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/runtimeEvents.js\":\"6e86d789a49e3cd7\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/togglable.js\":\"bab22203e6b3f4f9\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/variantFacet.js\":\"4d5b8548b0716f53\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/verbFacet.js\":\"eb9a087c23490fa6\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/block.js\":\"4247a0107cc8bd53\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/focusedChild.js\":\"17065d3f90134370\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/propertySchemas.js\":\"0760fb390a6f3afe\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/typeRegistry.js\":\"258424a32a8fd150\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useAncestorCrumbs.js\":\"55050a7380412331\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useAutocompleteListbox.js\":\"ebbf30c71e3ac9b7\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useDebouncedSearch.js\":\"2333e070b629ac7a\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useDebouncedValue.js\":\"4ec0f24c55583693\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useIsFocalRender.js\":\"e9bb2758750b8ecb\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useIsReadOnly.js\":\"4778069b743decdb\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useMaterializeBacklog.js\":\"295183fe40a872ae\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useMinuteClock.js\":\"abda4caefa1b0096\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/usePanelLayoutProjection.js\":\"2066f0a9e23c00ec\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/usePendingInvitations.js\":\"25cfbf8f1ef92be8\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useRendererRegistry.js\":\"1cd60d97b88b8f53\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useRetainedFieldRows.js\":\"cd7ce475e0f1920b\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useWorkspaces.js\":\"ac5d4025bfe905bc\",\"/knowledge-medium/pr-preview/pr-1821/src/lib/utils.js\":\"bf4b162b94343e54\",\"/knowledge-medium/pr-preview/pr-1821/src/main.js\":\"a3dc624fa74f4567\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/MarkdownImage.js\":\"0d99f4dc111ec216\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/blockSeparators.js\":\"b8d84ebf4fbd3be5\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/context.js\":\"9d9ec59733d17f16\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/defaultMarkdownExtension.js\":\"15fec256f70e9b4a\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/extensions.js\":\"a8422311fe9f5fe1\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/renderMarkdownHtml.js\":\"ab172a74b8cf4307\",\"/knowledge-medium/pr-preview/pr-1821/src/minimal-editor.js\":\"41d80dafe5454d86\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/armedCut.js\":\"6e0b52efae6be218\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/captureMediaVerb.js\":\"86dcb12b366fde64\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/clipboard.js\":\"47719a02a787b336\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/decision.js\":\"e2f716bce113d75f\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/operations.js\":\"2e9065802612fa73\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/account-header/AccountHeaderItem.js\":\"aaa6480d9b07d1b5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/account-header/index.js\":\"56b59f07ca7d7cd1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1138a38b44c3c9b7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/askAgent.js\":\"0978b209967cd88c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/askedStore.js\":\"11c508563011f3dc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"369374c98fcf2f86\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/chipState.js\":\"a2799b14a71b8a8f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/dataExtension.js\":\"faf69ff261255be8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/index.js\":\"9efddc0772d759b1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"498b98591822c4b0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/schema.js\":\"730751a8bea8b7c2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2ef24a788fce87b0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5ef688de20c44aae\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/addMedia.js\":\"5ea2b4426a80cf20\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/backlinks.js\":\"cf8157a9fc19ab68\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/block.js\":\"e220075b47a7cd80\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/context.js\":\"bd70df6b67f260e5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/displayIds.js\":\"984d1a7d9c99478e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/index.js\":\"d70aef7af860faf9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/outline.js\":\"95485cea39aef9ed\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/properties.js\":\"500b0f5c25ff7917\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/refs.js\":\"807a6732bff34c03\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f5e5330b8f55bdbe\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/search.js\":\"5785a73f66a78204\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/shared.js\":\"facc4a374e17a44f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4424999c0b9da845\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/text.js\":\"249d95c7b1e813d4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentWrites.js\":\"2d3205afda6fdd06\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/authoringCatalog.js\":\"7d24083490452c41\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/blockRefTargets.js\":\"375418c31052063d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/bridge.js\":\"8910db13c01e066e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/bridgeLoop.js\":\"c11c228a3f29ec56\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/changeHistory.js\":\"e9bbd6a9b9de91e8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/commands.js\":\"6214354632cbfa8c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/commentsCommands.js\":\"e941661644a9d788\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/dataExtension.js\":\"ec10576d0edf5efd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/dataModelGuide.js\":\"0e0f4e9ede83c392\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/describeRuntime.js\":\"fd71015074d7f706\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/extensionLint.js\":\"45626e4c18b1eeef\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/grainAudit.js\":\"e55db13a3edecbaf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/healthCommand.js\":\"8e061b9bea62faab\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/index.js\":\"4c5a905f28b06005\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/presetIdentity.js\":\"8893303079c1f895\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e7c66b963e38969d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/readMedia.js\":\"23b763ca15cb6a0c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/schema.js\":\"efbfaa282b4a873b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/serialization.js\":\"de349b00bf8ed042\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/targets.js\":\"0fd0bbd46fdaec18\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/tokens.js\":\"2cce87ac623e6401\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/watchEvents.js\":\"b434580254a09a7a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/workspaceGuard.js\":\"08cf1245a1847f04\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/writeCommands.js\":\"42d119ef66ae1a4e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/AliasCollisionToast.js\":\"a9a42efdf8235bce\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/DuplicateNameBanner.js\":\"1d9a9497bd7c10e0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/collisionMerge.js\":\"8c89419ff352a1e0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/dataExtension.js\":\"51c4a730dd1ae93c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/index.js\":\"5f496329bafa3e85\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/mergeCollisionAction.js\":\"1ac5392aba8a821b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/pageStyling.js\":\"345aa7f73908d9e0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/rejectionToast.js\":\"a74c720a964dca61\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/syncProcessor.js\":\"a8e6f96ecb8ea00c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/actions.js\":\"f51d8929b1bddd83\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/addComment.js\":\"528942972839da9a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/anchor.js\":\"86f29d6adc58c482\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/anchorState.js\":\"55cfbf0106d322ad\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/commentLinks.js\":\"81ba1af77f97f77f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/confirmThreadDeletion.js\":\"73331fd01cc40361\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/container.js\":\"5e877f03accc17d7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/dataExtension.js\":\"96474f4729d0ec81\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/deleteComment.js\":\"6ccb2645a9791318\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/highlights.js\":\"6ae36ee1f2407f01\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/index.js\":\"a64a8d9abeb43e51\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/linkedCommentsPill.js\":\"f3e3ab8ad9b7d8c3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/margin.js\":\"e67dd282cc5fa622\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/marginSchema.js\":\"c8f251971ac6dd7e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/newComment.js\":\"ec1b78608a8564e9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/ownThreadPicker.js\":\"e20043891b0519ea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/placement.js\":\"1c7bb281d213da4d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/queries.js\":\"e4d9291dc55d9e44\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/quotePosition.js\":\"feb957f6b71906bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/quotedIn.js\":\"b6a736c5a3357730\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/quotedRange.js\":\"02f356d4c284dbd8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/rangeRefs.js\":\"38d6bdf7a29a5f2d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/readHighlights.js\":\"f99b7dc085e3f9ab\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/readSelection.js\":\"8c4fab3d324b9518\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/readSelectionUi.js\":\"d6063e85b14ef43f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/reanchor.js\":\"6e968b04d8f7afcf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/schema.js\":\"b64ac9ffa96d481b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/scope.js\":\"5c891e33a927f1d1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/scopeThreads.js\":\"a04f0d3ca06c0a61\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/splitRetarget.js\":\"5ea2dd8b29a00734\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/suggestionCard.js\":\"edd8ebc62e8bb1e2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/suggestions.js\":\"4778eb5ae0cd4961\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/summaries.js\":\"6a440a823c639a04\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/summaryBatch.js\":\"5a4f0dbb97720ca4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/surface.js\":\"61ed31633b7ad8fb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/threadNavigation.js\":\"ee4fb31a0587a5b5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/threads.js\":\"9088db35febb2560\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/ui.js\":\"e0fc8741ea530a9b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/uiStore.js\":\"889acdb947c89fc4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/app-intents/appIntents.js\":\"ee2dccfa05cea0d6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/app-intents/index.js\":\"03bdc7a564a44be3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/app-update-prompt/index.js\":\"76fdada3a07905e4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/app-update-prompt/status.js\":\"2ed7d0e8a59a372e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5a4b622b2f168251\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/MediaBlockRenderer.js\":\"32b3107e5d196f42\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6be04dafc52fb098\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/MediaUploadReconciler.js\":\"178eefd9389ff0e4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/assetDownLane.js\":\"395d6924b6e37bdc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/assetResolver.js\":\"6f7d765fb2c5d232\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/assetUpload.js\":\"5d48ed7c7262dc57\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/attachmentCleanerIO.js\":\"41221ac523f078f8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/supabaseAuditIO.js\":\"233fe1d62274dff2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/blobStore.js\":\"083e3b2b7a4ae5dc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/byteStore.js\":\"b0fd22ef3512bfb0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/cleanerIO.js\":\"0ad6cdddd4e0b9e5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/cleanupAttachments.js\":\"10154d0bcd66e792\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/dataExtension.js\":\"e43c9117d4ad369a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/downLane.js\":\"a92df35257de03b5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/index.js\":\"91c34f541fa8f3bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/insertImageContribution.js\":\"2b902dc74d9e80f2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/laneArming.js\":\"dd3b3b5930f3ec31\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/laneLock.js\":\"8ceeed73b8efea74\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/mediaBlock.js\":\"3742be3d1d957963\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/mediaCapture.js\":\"798e50a370de9c6d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/mediaViewers.js\":\"c43f9af3e8764d81\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/mediaViewersFacet.js\":\"21fc641c98ddd553\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/pasteCapture.js\":\"dcc45117e2959adc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/resolver.js\":\"4e0bd8363ccae8ca\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/retryUploadsAction.js\":\"67745e33dbe09989\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/storagePaths.js\":\"44a28a5ebea983bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadDrain.js\":\"980326bdfbee0ee4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadLaneStatus.js\":\"34af15c385170a7c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadReconcile.js\":\"2fab24c681677510\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadRecovery.js\":\"fb2dbe5c15472faf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadStore.js\":\"385d8712016d729f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/useAssetObjectUrl.js\":\"2a41a00a38f38c88\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"27b997b9fac74871\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fa09aae316206e70\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/facet.js\":\"5ef9f3e2dddb8a3f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/index.js\":\"25fedd81ea07e87e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/prop.js\":\"4f9437dfce967eea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/BacklinkFilters.js\":\"fa443f0d50d64299\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7d839a705dc9af9e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/BlockEntry.js\":\"466990349cb99b5c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/LinkedReferences.js\":\"a0977f3c12b6f125\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0fcefdf85ff15205\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/dailyNoteDefaults.js\":\"add05a039ec9429c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/dataExtension.js\":\"8cea2a5b99595f80\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/edgeExclusions.js\":\"691046a47c0dac10\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/filterProperty.js\":\"306c7231125758d9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/index.js\":\"d15f0109af07340f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"12868101e3801222\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/applies.js\":\"9a90ce132e5d1fdc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/countQuery.js\":\"8f17b2fe16160040\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f571e81de9dd4eeb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/index.js\":\"264620ae2801b133\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bbc621ac69e250c8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/presentationInvalidation.js\":\"f0f0361f12ab8fb8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/propertyEditorOverride.js\":\"e84220f9b8c2ae75\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/propertyFilter.js\":\"a1fff13ee3a424e3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/query.js\":\"16f3e7b2ce0da623\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/resolveFilter.js\":\"8db9b46937d04d25\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/sourceBatch.js\":\"b9f4af9766c5f390\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/sources.js\":\"3314fd868b0e4994\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/useBacklinks.js\":\"88696dd504b0e232\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7c8cc948e05588c3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/BirthdayCelebration.js\":\"e61707e5c23866ef\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/BirthdayOverlay.js\":\"1508f9d905bbb702\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/gate.js\":\"c75583b5d7105a85\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/index.js\":\"6f8fc373e3545229\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/wolfTheme.js\":\"0a49e53b33d1b866\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/BlockDragLayer.js\":\"370004a6e9cbf49d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/dragController.js\":\"8523a5d4c8fd53dd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/dropTarget.js\":\"f2d22d201b93b685\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/index.js\":\"88c5817ffa021868\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/projection.js\":\"0ef941db81207913\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-info/BlockMetaCard.js\":\"cf608ebf0bdf0790\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-info/index.js\":\"012b5024b81f031e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/AddTagDialog.js\":\"b44e79053ae80dd7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"edb019ed6e8098a6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/TagNameIssueHint.js\":\"daeaf4834efc662b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/addTagAction.js\":\"cfdda38d82ae2567\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/appendTag.js\":\"0015757c38e2ac23\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/config.js\":\"c9787dd1b67742a0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/dataExtension.js\":\"20ae049cb7ecfe33\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/index.js\":\"45154025f280bcf8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/propertyEditorOverride.js\":\"71ca0a8ebae19424\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5fe8455daf461d28\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"903ce9d5ae098036\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ae34fd8f85876c44\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7770a8c597ea192d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"22fb25c5e930b55e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/index.js\":\"3be26617da6b1372\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"500e00b83ed69be1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/CharacterCountItem.js\":\"ae114115c0fa741a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/ProfilePropertyEditor.js\":\"21627adbae3cd3df\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/actions.js\":\"50940caa1d6941ca\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/blockType.js\":\"d2fc9dff30e8c86c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/charCount.js\":\"b2804bbf23469eaa\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/dataExtension.js\":\"55f83f84505a3b26\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/index.js\":\"136e4b65c1365e8e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/profiles.js\":\"99a7a518a63d6bb2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/properties.js\":\"d92d8d1641f2da64\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/textCounts.js\":\"f1631c34ec405df1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/colemak-keybindings/index.js\":\"8c12658fa218cdae\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/CommandPalette.js\":\"e3d88ed2b0c0d7b1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/HeaderItem.js\":\"a486b7451af1a333\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/context.js\":\"c8b591b12ffa74e6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/index.js\":\"ae43b4f95199af5f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/selection.js\":\"35956e991c066492\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/toggleStore.js\":\"de7f0dc8175f0026\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/useCommandPaletteActions.js\":\"6fe51e3d6388f4c8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/ContributorBadges.js\":\"ce5ae96a8bd08d8c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/author.js\":\"71c460dbff2f3523\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/codeMirrorExtensions.js\":\"9c771a436daa0e60\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/dataExtension.js\":\"09c6b5c2fe604ac9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/index.js\":\"2facc0344853b6e3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/mentionAutocomplete.js\":\"5039862ac7e36ed7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/processor.js\":\"e3eeea992385ce55\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/profiles.js\":\"c01c50f32f819ac9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/queries.js\":\"767d693924029441\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/schema.js\":\"833814c555a81ecb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7e37ba59f0ad2564\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/followOrigin.js\":\"11c2f48ad53de368\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/index.js\":\"ce58f30c508df2ff\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a0354f92fb7597a5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c769f62fbec1240f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/CalendarGrid.js\":\"b3d58162c2b8bf38\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/DailyNotePicker.js\":\"0c95a0a4c6929027\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9a8ae413198c5c83\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/DateNavDecorator.js\":\"bd4568ff99867134\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/DateScrubOverlay.js\":\"ebb6afd8346f009b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/HeaderItem.js\":\"ea4cd4df01afbc7f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/ReschedulePicker.js\":\"f390f521896c415d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2e3c61c5a1206ed4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/actions.js\":\"7cfbdbe11fc6d033\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/blockDateAdapter.js\":\"ab8c4c537d4df6fc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/calendar.js\":\"3bc9445fc61cff62\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dailyNotes.js\":\"4af7b041014992a9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dataExtension.js\":\"1f582f9fe868a1ab\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dateScrubActions.js\":\"b414a2601502a66e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dateScrubGesture.js\":\"f15b1b3af52bef5d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f4ef01408084ab4f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d87fdc8aa9145a8d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/deletionGuard.js\":\"84699f5e9a50b007\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dueQuery.js\":\"047a620f8827a3b5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/index.js\":\"e90bd695666006dc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/landing.js\":\"f9f849a0707e941e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/localSchema.js\":\"baa8771df4679268\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/referenceDateAdapter.js\":\"6519e7c0f3f1d11b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/rescheduleAction.js\":\"a93f582726c3eb2d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/schema.js\":\"afc77ea906efaafb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/spreadBlockDates.js\":\"0995ee2929e76883\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/spreadDatesAction.js\":\"6c3479a287ed8073\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/today.js\":\"74cd4263b284b71e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"70873a360843e491\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1cb6156dc39fc08f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/audit.js\":\"519bd2a4a5237be4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/auditAction.js\":\"c67c4f77664fd83b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/auditRanges.js\":\"e43d4e6339d32d56\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/diagnosticsSource.js\":\"53d212352f0ae114\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/divergenceScan.js\":\"607aedb5a676d7a8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/index.js\":\"28c4055cc3906eb8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/propertyChildrenChecks.js\":\"df508ec140b86fe9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/referencesMirror.js\":\"90cbefb59017d879\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/rowJson.js\":\"c487622f670cfe57\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/schedule.js\":\"11aceb1843bcf0d2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/store.js\":\"2cd0d4468f18cb6b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-maintenance/action.js\":\"6a3fbfc993dcfc2d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-maintenance/index.js\":\"03db84f6c411d34e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-maintenance/plugin.js\":\"0306aacac89834b1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ab0f093e9a4e1c8a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/actions.js\":\"a5e9ea9589155abf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/changeMarker.js\":\"214bf2dcb318a8f2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/diagnostics.js\":\"cdb03e276bc6997c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/fileSystemAccess.js\":\"e009383f6845c637\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/filenames.js\":\"961f6b9d230d4ee7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/index.js\":\"078d17665b52ae30\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/mirror.js\":\"8a5dc73d50ca2f03\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/runLock.js\":\"94e43798499e7cf3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/runtimeHealth.js\":\"1d8582c2b333e5ce\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/schedule.js\":\"aa86c2e6ccd8f82e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/store.js\":\"2d1125c856824671\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/default-themes/index.js\":\"2117b20e5c8973b5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/default-themes/themes.js\":\"0fa0cf165682619b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/diagnostics/facet.js\":\"bc45d5c685d4f9ec\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/diagnostics/useDiagnostics.js\":\"69e212ec53b79239\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extension-prompts/dismissals.js\":\"57ba1b0686a738cc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extension-prompts/index.js\":\"76db5c7dfe9b922a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extension-prompts/status.js\":\"43d17149b98d5f65\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extension-prompts/store.js\":\"2ef9ac81e9dc5e02\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0d3b878f1f2f1c19\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/ExtensionsSettings.js\":\"72ba858bf76f686a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/actions.js\":\"de1c7da11377fb84\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/config.js\":\"649f366b4cbfde83\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/dataExtension.js\":\"a051bbd4d6803d9d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/effect.js\":\"7d8aafb3f79a14e5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/index.js\":\"a007077861fbddaf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/propertyEditorOverride.js\":\"4285372424c6423b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/useToggleTree.js\":\"b79ee899bcda08f5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/ExtractTypeDialog.js\":\"e368032162fb954d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"2614f07edb6d2974\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/PropertyShapePicker.js\":\"14fd2e0aface700c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/action.js\":\"2af6c343018ac852\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/index.js\":\"33ed1e4ba0449591\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/FindReplaceDialog.js\":\"8946806887234172\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/HeaderItem.js\":\"1100be13986d30a2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/dataExtension.js\":\"9b65d9789c9cf312\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/index.js\":\"2fffac2519ba1202\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/search.js\":\"3bc02de1e0d43f02\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/toggleStore.js\":\"1c842692ee670668\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/LocationPropertyEditor.js\":\"95c501a7e2d502e4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/MapView.js\":\"767f82b8c3109465\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/blockTypes.js\":\"b0e4189fa0fdd697\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/codeMirrorExtensions.js\":\"10ae19c3bbf18bea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/createOrFindPlace.js\":\"8580ee28f924094d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/currentLocation.js\":\"9f1cb6c8e523f665\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/dataExtension.js\":\"0e2ce43e3b4bb7f0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/geoContentDecorator.js\":\"9f977cd7b5202ee3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/googlePlacesClient.js\":\"4a5326be215f38a5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/index.js\":\"05fe7f808186980b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/locationsPage.js\":\"fcc1e7e9b3ab2bba\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/mapViewport.js\":\"60495cf5dd1e9f25\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/pickCurrentLocation.js\":\"981f9e3cec5feffb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/placeAutocomplete.js\":\"193a9e78f7f3fd79\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/placeNameCollision.js\":\"dd6006cf01bc7253\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/properties.js\":\"1c51218eb457389f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/propertyEditorOverrides.js\":\"78783dbe3979cf32\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/query.js\":\"ec386dbcc6f3613e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/usePlaceSearch.js\":\"f9f7133bab1c276c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a8d09d2c2d5b3b2a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"826ef1407a2f8a31\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"418a8318412f93ad\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/config.js\":\"996ce7402a93ba8d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/dataExtension.js\":\"d6db019b4577a9c9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/facet.js\":\"64645d5cecfbf999\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/grouping.js\":\"d3ffdfe85b519ef6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/index.js\":\"a8fd5a879bc98107\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"3e6757ccfe9818f9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/query.js\":\"1d89d26d9b12f9de\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/resolveConfig.js\":\"fb4bf6bcdaabdccc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4c924a8e96c52f09\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d8032f0d76e6427e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/HtmlDocumentContent.js\":\"fb84671f7d40ecde\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/HtmlFrame.js\":\"38b1ca069a647135\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/actions.js\":\"8c4a842a96991056\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/blockType.js\":\"7fb2cf27ba6f462b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/confirmRunScripts.js\":\"2d34880079e43fe1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/dataExtension.js\":\"c9364b733492e9d4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/frameAnnotations.js\":\"947e7e21257661a1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/frameDocument.js\":\"afbf20d70182f9bc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/frameTheme.js\":\"90571961badc3db8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/index.js\":\"9cce796949cc9aa3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/scriptConsent.js\":\"543906a2ba818c6a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/sourceMap.js\":\"3d56a8f9d6ab5663\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/useDocumentScripts.js\":\"2c89773412e7f3ff\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/index.js\":\"c870af96bdb15074\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/record.js\":\"cf6eafaf305d302f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/recordStore.js\":\"5ebed61ed8e8f951\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/responsiveness.js\":\"1bcdec5efd7a03e6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/schedule.js\":\"efe4c2907a7f09ba\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/sessionContext.js\":\"15a52235785950d7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b23bd39e5c008c3b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"bed201b3170a7026\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/actions.js\":\"c9c9aac13f1fdf09\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/config.js\":\"67f5a2a565193e23\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/dataExtension.js\":\"13d6ac46361eb05f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/effect.js\":\"688eb51ef665fcf0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/index.js\":\"5cccdcec00634b73\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/keyCapture.js\":\"a73c6dbcfd6ce27f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/overrideStore.js\":\"c077ecbaa7208af5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"7ebc1a643a46a36e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/HeaderItem.js\":\"cfc8eb9f34d8f00d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/LeftSidebar.js\":\"780c07719292608e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/actions.js\":\"e77d3861d7fd5b11\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/facet.js\":\"401ac6870f1e6533\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/index.js\":\"046875326b8aa839\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/shortcuts.js\":\"1ea656add1322915\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/toggleStore.js\":\"cf3f908aeffc2750\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/merge-blocks/MergePicker.js\":\"ccadb3db5636ae14\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/merge-blocks/index.js\":\"34db6dcc5fec8bf0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/merge-blocks/mergeAction.js\":\"e023e4603e0d78de\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/merge-blocks/strategy.js\":\"661fda4bed39e760\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/Button.js\":\"f74a8fb6bf586fe1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f53c3360abb9199c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/defaultItems.js\":\"27fbe378075fd922\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/facet.js\":\"afe6161a9b516fdd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/index.js\":\"82f109321c20cfde\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f76a0bc5b6aad890\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c2b33f866e9eabb8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d4fee4b62c46c905\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/facet.js\":\"688dfd7adfb13449\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/index.js\":\"ab28ea0c4eab1456\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a7e22dc2c5d4520c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f48ca6696b6d58bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/contextMenuItem.js\":\"65639c1fef21439d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/index.js\":\"14b0669153e318a0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/moveAction.js\":\"83de44f7954b5cae\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/moveBlocks.js\":\"cc2d580c0df72a6d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/selectionAfterMove.js\":\"6a936de943e7eb37\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/TutorialBanner.js\":\"cc0a4c360f0b8d03\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/action.js\":\"e2edf9a2e9cb7183\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/bannerDismissal.js\":\"444d80162f06f1fb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/documents/cheatSheet.js\":\"1a333750d739430d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/index.js\":\"18d1eaee672230db\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/keys.js\":\"30a6a850362708b3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/landing.js\":\"9ad45ff994dbd056\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/outline.js\":\"4f7f4b5f1f163af7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/seed.js\":\"3d6b745d96d000db\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/PerfTrendDialog.js\":\"40a0b3cd928f866c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/analyze.js\":\"421f348027258f06\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/diagnosticsSource.js\":\"ae520cd911811d6b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/index.js\":\"ccb1328fdfa0ca90\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/load.js\":\"877af4d68012a90c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/monitorRun.js\":\"4722930260152025\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/schedule.js\":\"bb688d1c8261138c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/series.js\":\"2ada8b2b02ad111b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/store.js\":\"1de612e87fbb673f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/trendAction.js\":\"154805b699f2ca0d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/verdict.js\":\"64e499b56f779380\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/plain-outliner/clickToEditAction.js\":\"9d33e74466572947\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/plain-outliner/index.js\":\"9861a78917745ce8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/plain-outliner/interactions.js\":\"d6c417dadcc7b204\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8d4f28222e0dc894\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/MigrationGate.js\":\"b2d1f05ed417efa3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/MigrationGateDialog.js\":\"70a06a201bfd8756\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/action.js\":\"8976e3c9a2239738\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/index.js\":\"1decf1c974878437\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/localRunMessage.js\":\"fc45617e3a718cc5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/plugin.js\":\"aa3714d936e2b43f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/progressReport.js\":\"d1505fb3d2d01619\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/sweepProgress.js\":\"140d525ff13a26bd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/FieldRowRenderer.js\":\"92b7238950816785\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/ValueRowRenderer.js\":\"3ef3e2f03a329620\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/actions.js\":\"7caea3ae92ec934d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/autocomplete.js\":\"2823f0f17a5145e9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/fieldRow.js\":\"47ea964008d330d7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/index.js\":\"9533fe34843daab6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/referenceWarning.js\":\"bc552db8544114da\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/valueAutocomplete.js\":\"59ce93707393f4a0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/valueSchema.js\":\"6dedb8c8ad860832\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/HeaderItem.js\":\"8946351df1e0eaa2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/QuickFind.js\":\"f27d66f4121ac6b5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/index.js\":\"7a9e4012b52bd18a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/recents.js\":\"694dc8212ec29511\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/resultItems.js\":\"4db414474ef8d5fa\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/selection.js\":\"1c36b244bc76add1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/toggleStore.js\":\"34e7f40629ec7208\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/HeaderItem.js\":\"a27551b405746f8d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c3531c82d4fe5898\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/grouping.js\":\"f669b234a04c0d9f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/index.js\":\"72e1af67b012c2ea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/target.js\":\"492b00339410c1a6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/codeMirrorExtensions.js\":\"eaa66bad7fb6c4fc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/contentPrefill.js\":\"3eaf456fdba80697\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/dataExtension.js\":\"5efad62612ec22da\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/index.js\":\"f973075bc0947e1b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"af3f4725843b3f4c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/invalidation.js\":\"d112cd828e612fd0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/localSchema.js\":\"fd01b99cfd533bce\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/blockrefs/index.js\":\"18ca1ebd699cfa9b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"376049381f78db77\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/index.js\":\"2efd016d0d3a106b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/referenceNode.js\":\"f2c1c2dd30cf535b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e0393311244663c0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"863d83675a22ecec\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/wikilinks/index.js\":\"33ac586997337f43\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"06fac76ae8c8ba2c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7c400d3491f34d4d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/mergeRetargetProcessor.js\":\"d2a0d8a2e7443eb1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/parseFence.js\":\"5abbb6af88ff6545\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/referenceParser.js\":\"891f015dbda265a7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/referenceProjection.js\":\"59ee4a91f4835ae7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/referencesProcessor.js\":\"25cf9d1486b43e1d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/renameProcessor.js\":\"152460131587aa10\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/spanReplacement.js\":\"6c21629a76f9ecca\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/rich-paste/htmlToOutline.js\":\"952ca3e4163dcb75\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/rich-paste/index.js\":\"54c7c0ff98427498\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6dd7444e0105d2c6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/rich-paste/pasteDecision.js\":\"d9aea7698327d040\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/action.js\":\"b81fd7d27638ef22\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/blockIds.js\":\"beafb597c11a2351\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/content.js\":\"5a6e42f2b4f7e97d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/effect.js\":\"fbd7fc40a2581424\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/ids.js\":\"f062a3c26fc7bde4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/import.js\":\"f1ab2acdbceef95d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/index.js\":\"8ad88b6d7215d98e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/plan.js\":\"a237491a72b57613\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/plugin.js\":\"20ba184a4e8d5879\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/promotion.js\":\"54e84f861358fc97\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/properties.js\":\"dc3b57d4ca873adf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/references.js\":\"9890f590a7593c3d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/report.js\":\"9a17e8f1fb5fdf28\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/roamMemo.js\":\"46436d9529ad2ecc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/runtime.js\":\"7ca5d49ca10b3732\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/schemaReconciliation.js\":\"590cf14204e7a143\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/srsMarkers.js\":\"7f93e422c06f6a58\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/todo.js\":\"fc0ed8ea985761a4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/typeCandidates.js\":\"4f977728474affe0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/types.js\":\"9916f7301d019a50\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/search-health/index.js\":\"052416028c3bddc8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/search-health/store.js\":\"2ef86583ba406bf8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/HeaderItem.js\":\"6411eb5640e4a70a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"163d37b10f0518f9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/index.js\":\"547db48fb85891ae\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/model.js\":\"62c01c43d67a5c54\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/toggleStore.js\":\"72381705bcaa0563\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/useKeyInspector.js\":\"3e58c3c322d3e198\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"12bdfa51a1dfc2ba\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/ShellDecorator.js\":\"cf09fdc6c9540213\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/actions.js\":\"cc5163e648b60c9b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8445f6e89f1dc100\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/index.js\":\"3ce5a02c03d47c60\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/shell.js\":\"8e34a7f6c3b9ed0a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/surface.js\":\"bdec5abc0d38e8e7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/walker.js\":\"8c0457233cbd9fb3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/RescheduleToast.js\":\"10dfca2844ac613b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/dataExtension.js\":\"45f742f9826d3eac\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/index.js\":\"cd39a3e81a048233\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/indicator.js\":\"2a51f4e994274053\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/moveSrsState.js\":\"443674a05aa3c8fa\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8096478b7de29805\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/scheduler.js\":\"263f458ca12253b6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/schema.js\":\"0ab612d5ad38e8be\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"24b7bcfc07dfecf4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/srsClipboard.js\":\"b3aeecc7e26b3951\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e97afb10b11379ae\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/DailyNoteReviewHint.js\":\"972e219aef809a60\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/DeckPicker.js\":\"126d106ddfb77ae1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/ReviewControls.js\":\"2ca2ba13f9676184\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/ReviewDeckRenderer.js\":\"709ef30f0f23ade4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/ReviewSession.js\":\"f236aac9eb89cca0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/actions.js\":\"8002123d5e198359\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/archive.js\":\"82a268ab6fdd68f7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/dataExtension.js\":\"632681c2a121bebd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/deck.js\":\"0d221571b268b528\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/dueQuery.js\":\"e0a3d6934fbaaa42\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/gradeDecision.js\":\"5e89a4128f1f6533\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/index.js\":\"1ca19d6271ceb772\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/keyHints.js\":\"5c7482756269df33\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/reviewCardLayout.js\":\"4cffbe7bac0d43bd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/reviewProgress.js\":\"b3262ceffc2c0279\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/schema.js\":\"340db52751df94e1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/useDueCards.js\":\"85b3ae226c4df268\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/startup-metrics/index.js\":\"1dcc97b48e2c621a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/startup-metrics/record.js\":\"e6973284561f389e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/storage-persistence/index.js\":\"af913412205b9e8c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/storage-persistence/persistenceStatus.js\":\"7828115537e4ed85\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/storage-persistence/requestAction.js\":\"bd32a17a32b338d1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/supertags/TypeChipsDecorator.js\":\"ab352fd6f8712fa3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/supertags/codeMirrorExtensions.js\":\"9fedc699810b4a51\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/supertags/index.js\":\"a3cbeabde2ff9543\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/supertags/typeAutocomplete.js\":\"40fcba296bf8c55c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"589d616dfcb62c30\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/actions.js\":\"2a4ae0e69ea56420\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/anchor.js\":\"490d9e9bb9789ec7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/events.js\":\"e0559ea0ce712c00\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/gestureActions.js\":\"8e4781b9f40833ea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/index.js\":\"2c421e2b6bdc250f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"69a99222b66cddd9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/sync-metrics/collect.js\":\"b94ddc938d0d28ef\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/sync-metrics/index.js\":\"6ad1c053cedb23d6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/sync-metrics/record.js\":\"2d491db739ec5cc8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/RejectionDialog.js\":\"f8070abbc85839f4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/SystemStatusHeaderItem.js\":\"667ea5b62766b363\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/index.js\":\"b37e4871145fb710\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/model.js\":\"1539120c5d693eb4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/queueCounts.js\":\"c35bc124d8e67ed7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/rejectedHelpers.js\":\"5de45016d979467b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/rematerializeAction.js\":\"a6951924c0545e81\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/useHysteresis.js\":\"2f6b015f85da1556\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/TableLayout.js\":\"c9b845cd5de87aad\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/actions.js\":\"4d65b42e17d29d58\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/cellEdits.js\":\"6d88204be4d68f55\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/controller.js\":\"e43d0eee406b09c9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/convert.js\":\"3c6fed11ebe326c8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/dataExtension.js\":\"4364f4cd90784528\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/index.js\":\"72ab512f8fa18556\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/keys.js\":\"9a26b65cf826da9a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/model.js\":\"eb81e7347b1b3249\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/registry.js\":\"77b2cb4c6c0aa641\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/schema.js\":\"36e998fdc118ad32\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/theme-toggle/effect.js\":\"78dc66ec612d4d21\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/theme-toggle/index.js\":\"b66e504197396ffb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/theme-toggle/theme.js\":\"5f02e5d59245a294\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/todo/actions.js\":\"56da7d32565265a2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/todo/dataExtension.js\":\"eb76d2fa00713dcd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/todo/index.js\":\"cb66109299a68f39\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/todo/schema.js\":\"b6fbff536d95663d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e0cc0a2357ccd140\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/actions.js\":\"bccec6325fedbe2c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/defaultItems.js\":\"e5fd8cd8d5c173d5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/facet.js\":\"389f747fdc20cec1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/holdRecognizer.js\":\"3ed891937c80f562\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/index.js\":\"7bc0f18894eed1fd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/update-indicator/UpdateIndicator.js\":\"b0e0473889fe54eb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/update-indicator/index.js\":\"fce85f7e15fbf04d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/update-indicator/loadTimes.js\":\"22722cda5dd8cf8e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/VideoNotesRenderer.js\":\"a532f344bbf8203a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/VideoPlayerRenderer.js\":\"41ae2b0823355f99\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/VideoTimeStamp.js\":\"1be1262feda4baec\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/actions.js\":\"8fb0079c73d10cba\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/index.js\":\"bf1f90df243325cc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/markdown.js\":\"6f06241a3fcf770d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/notes.js\":\"54babfcf445c0068\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/registry.js\":\"1a86494c0d395c63\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/remark-timestamps.js\":\"f09bda7bd801cef8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/view.js\":\"f79f2da8d2e0de32\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-link-hints/LinkHints.js\":\"b503ad1943fa83b6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-link-hints/index.js\":\"a86390d8dd6605ba\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-link-hints/model.js\":\"64d3777f1fd28ebd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-link-hints/settings.js\":\"28d6d07a0f536694\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-normal-mode/actions.js\":\"4fdf3620d8dc3b11\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-normal-mode/index.js\":\"6252b7e1a514d101\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-normal-mode/interactions.js\":\"ab71414664cd1076\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/workspace-header/index.js\":\"a9bf82291d5b16ad\",\"/knowledge-medium/pr-preview/pr-1821/src/registerServiceWorker.js\":\"49f45f07e19af736\",\"/knowledge-medium/pr-preview/pr-1821/src/requestPersistentStorage.js\":\"01fa31f8cc3f3cc5\",\"/knowledge-medium/pr-preview/pr-1821/src/services/authRequestDeadline.js\":\"0768e910f75131a3\",\"/knowledge-medium/pr-preview/pr-1821/src/services/authStorage.js\":\"71a4e3df5e140de4\",\"/knowledge-medium/pr-preview/pr-1821/src/services/powersync.js\":\"ae4d7d5e641aad24\",\"/knowledge-medium/pr-preview/pr-1821/src/services/supabase.js\":\"87e1dc127b9814a9\",\"/knowledge-medium/pr-preview/pr-1821/src/services/uploadErrorClassifier.js\":\"b4e7e1ffd51de7d1\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/ActiveContexts.js\":\"4dd9598c765f91a5\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/HotkeyReconciler.js\":\"fbf451720714e809\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/WipeLocalDataDialog.js\":\"5360d1dcabdf6e9a\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/actionDispatch.js\":\"7fbd100ed160eba7\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/actionRefItems.js\":\"49e8df6319551645\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/applyKeybindingOverrides.js\":\"fc5b9f39fa07e3e4\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/blockActions.js\":\"4aee590caa48218d\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/canonicalizeChord.js\":\"ecd78d911cc2c920\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/defaultContexts.js\":\"273ffdb0ded5ba2e\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/defaultShortcuts.js\":\"e1696446a83b90f1\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/effectiveActions.js\":\"8422fb3dd440ad6c\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/gestureAction.js\":\"e959b09e95749afd\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/gestureBinding.js\":\"ea2fef50b4b8e19c\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/holdRegistry.js\":\"c8b798a1c0ff2bb5\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/keybindingConflicts.js\":\"422d69866204a584\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/keybindingOverrides.js\":\"54e76e02a66feca3\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/pointerAction.js\":\"6d27df8d583397d3\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/resolve.js\":\"c9a0155313364d3c\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/runAction.js\":\"926ac39135fbfafd\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/sequenceMatcher.js\":\"c57517a2cb00800b\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/types.js\":\"ce92b3c42c70204d\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/useActionContext.js\":\"af1c78711acf071f\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/useActionDiscovery.js\":\"822ff27c1c877291\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/utils.js\":\"efa504d27854844e\",\"/knowledge-medium/pr-preview/pr-1821/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1821/src/sw/bootStore.js\":\"60b3273123385d20\",\"/knowledge-medium/pr-preview/pr-1821/src/sw/previewDatabases.js\":\"f8a0b9db01967e38\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/byteTransform.js\":\"a23307808c216066\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/attachmentCleaner.js\":\"105454b54c3a6655\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/attachmentParts.js\":\"1c1801caa607a0d7\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/bundleParts.js\":\"fbc7cb17f7111863\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/bundleRecord.js\":\"b7a1f31f23c6972f\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/manifest.js\":\"47e718da6cccb9d9\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/takeBundle.js\":\"9c3fd0e2835d6629\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/verifyBundle.js\":\"cec5cc00914e04c1\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/cleaningStage.js\":\"3312ddbe1ffdcb6d\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/conversionKey.js\":\"db6bb5e44d1ce90d\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/conversionServer.js\":\"3cf1da3ae0df7063\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/flip.js\":\"e95d5fc719c47132\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/flipAttempts.js\":\"14fc56dd3a72e06f\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/pages.js\":\"a6303fd6a89ccc33\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/preflight.js\":\"40507fb11a34325f\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/reseal.js\":\"156686bc5ee0a0e3\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/runConversion.js\":\"f67c0b933ae988f7\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/runLock.js\":\"a8466a86b8999656\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/sealing.js\":\"9e84801da2f6b026\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/sealingStage.js\":\"40ea989efb0884b4\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/stage.js\":\"ffa46095662c59f6\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/verifyReseal.js\":\"1dc59530bd109b5b\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/aad.js\":\"c3358fbcdbec86b0\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/aead.js\":\"81adc4c4ee47df5a\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/base32.js\":\"68237663c425549c\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/base64url.js\":\"03ec5c2af151c3ea\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/binaryEnvelope.js\":\"e6f1d61fcbb9eee4\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/byteAead.js\":\"3a500315ab89ff08\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/canary.js\":\"a750435259209e0f\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/contentHash.js\":\"868adb815688b510\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/contentKey.js\":\"1fe6589f87f717cf\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/derivedIdNamespace.js\":\"12abf4e2382a14d5\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/envelope.js\":\"ff9a45f0d9b6ff28\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/hex.js\":\"859408b907b28e38\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/sha256Hex.js\":\"80a4303b6326dc58\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/workspaceKey.js\":\"d5c27a639d0bfbf6\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/conversionState.js\":\"528a85d1528bb72e\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9859f4a88d7b4e54\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/flows/pastedKey.js\":\"ff2a7905d00f58bb\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ea537fd20e5cbd31\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/flows/upgradeWorkspacePin.js\":\"cc8e87bd12a21c2b\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/keyStore.js\":\"39ad0f7d639e7164\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/mintWorkspaceKey.js\":\"422b27b6292a6fe3\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/modePin.js\":\"426167f07088ac38\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/openWorkspaceKeys.js\":\"1616b05fdeb1dcf3\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/resolveWorkspaceEntry.js\":\"28ed8c728410f523\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/resolver.js\":\"76842527c4045752\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/workspaceAccess.js\":\"0c9e61b05f68d571\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/transform.js\":\"e72aeb3f2af4adfb\",\"/knowledge-medium/pr-preview/pr-1821/src/themeBootDefaults.js\":\"30d2019401dd5ec2\",\"/knowledge-medium/pr-preview/pr-1821/src/types.js\":\"7103088e68bcf9b1\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/ClientLocalSettings.js\":\"daa7a3e3e4f63d5f\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/abortableSleep.js\":\"bb959d91d8439d85\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/array.js\":\"e386a8217753356c\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/backlinkAutocomplete.js\":\"b8edbba5db0553e0\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/blockCrumbs.js\":\"9a2b3ef8c841e4d9\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/blockrefAutocomplete.js\":\"5c0a649bc5f409b0\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/cadencedIdleJob.js\":\"a5fb453718abebed\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/callbackSet.js\":\"60476108104296d3\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/clientId.js\":\"6dbc5d624cdd0bcd\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/codemirror.js\":\"4b800b4480df2fd3\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/codemirrorCompletion.js\":\"754a3fe50c7d4936\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/copy.js\":\"0dcdba1094194b57\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dailyPage.js\":\"4bc17155e554a083\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dbForensics.js\":\"7c88a671e44ab7e4\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dbForensicsHooks.js\":\"5668de3217f03798\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/deleteBlockThroughUi.js\":\"cc6e4cc0d9e45050\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dialogs.js\":\"e58c7e3e3c2a8292\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dom.js\":\"cfcab6042cb97359\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/downloadBlob.js\":\"b9fa689f4141be49\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/exportSqliteDb.js\":\"16aa56a084b9098b\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/fileSystemAccess.js\":\"e58c271adc8f50c3\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/flipSlide.js\":\"12e0f5d19ef595d2\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/fnv1a.js\":\"7c70f57c299d4589\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/formatBytes.js\":\"9c8f80c26f8c8e3e\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/fuzzyRank.js\":\"40c877ff5f6d73f3\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/idbKeyedStore.js\":\"fda6c3cc8a98ffb1\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/idleCallbackPolyfill.js\":\"a1ac67deac5933c6\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/keyboardAwareScroll.js\":\"5467d705e0676bee\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/keyboardViewport.js\":\"7080b035e290b584\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/lastWorkspace.js\":\"407b20022c50db1f\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/layoutColumns.js\":\"092c2d61a035c394\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/layoutSessionDom.js\":\"a6942cd9830166b8\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/layoutSessionId.js\":\"6d121716d04450b8\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/linkClickGestures.js\":\"1d4690a612b57335\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/linkTargetAutocomplete.js\":\"daa9592bded306f2\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/localDbCorruption.js\":\"369bab6090b685cf\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/localDbRecovery.js\":\"7f71b78a4ec67288\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/markdownParser.js\":\"be5a86dcfbac1b0c\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/memoize.js\":\"42f8b4ee4e2a45b6\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/nameFieldCommit.js\":\"8cb60f60c2bd6f8f\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/nameList.js\":\"4f3cc63ab8945928\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/navigation.js\":\"689ef71b92273a14\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/omnilinerNamespace.js\":\"d1c4c13c96b28a85\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/opfsPageScan.js\":\"758e140526e7e005\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelClearance.js\":\"cf85e901c9801273\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelHistory.js\":\"a5ead52fb0b47cc9\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelLanes.js\":\"e52a6b8ec4271b6e\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelLayoutProjection.js\":\"badb8e2062c8e8ab\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelScrollAnchor.js\":\"424f5245b2135e29\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelUrlFlags.js\":\"22d76b80b0968275\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/platform.js\":\"c34e5f6b530e5265\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/pluralize.js\":\"10680cbba61879f8\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/propertyCreation.js\":\"419439c9c4810236\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/propertyNavigation.js\":\"e9adf8729893bbe8\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/propertyValueContext.js\":\"ccbfc22c68ed3a73\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/react.js\":\"6e55bf4fd0b511c7\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/relativeDate.js\":\"5aafc92c8922e719\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/relativeTime.js\":\"f477317a96028c70\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/renderScope.js\":\"02bdd1f2124069d7\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/resolvedThenable.js\":\"9e9ee57d7a83f193\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/routing.js\":\"a6e36829efb5c35d\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/safeMode.js\":\"581067a9dca21229\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/scheduleIdle.js\":\"2bde217bac8502c7\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/screenWakeLock.js\":\"a24d94f2b780cc46\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/selection.js\":\"7f3186f9ae963d30\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/softKeyboardGrab.js\":\"b8d51df4ae54ca54\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/startupTimeline.js\":\"70bd78ecd9c2c37e\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/state.js\":\"9070dc4e52c0649c\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/string.js\":\"fcf88764f4176cbb\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/surfaceZoom.js\":\"5b562cd980c7d6c0\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/time.js\":\"f392c82d7488552c\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/toast.js\":\"64c92931fb4e7fc2\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/toggleStore.js\":\"f1e89b28a8b507ca\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/untilStopped.js\":\"739d929df81e3c45\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/userActivity.js\":\"d180d038130b3eab\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/viewTransition.js\":\"d6a893c096c821f6\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/viewport.js\":\"287b642200c16d41\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/webLock.js\":\"e9ba1a44d75cccaa\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/workspaceRecovery.js\":\"75b858a5554dca3c\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/workspaceSnapshotStore.js\":\"b2b7513c0b9ce609\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-compiler-runtime.js\":\"45d89b69a6b9b63d\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-client.js\":\"ae77170fcdc88847\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-server-edge.js\":\"c8521782799a6a1c\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-server.js\":\"e85a9c5a8fe5f7d6\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-static-edge.js\":\"047ba13b3139ed91\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-static.js\":\"6e67ffec672e4a6e\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-test-utils.js\":\"9cc364c8c4d98258\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom.js\":\"b4299776fcd100a8\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-jsx-runtime.js\":\"519f581ece29ac4b\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react.js\":\"b7ccd101dfac1a7e\",\"/knowledge-medium/pr-preview/pr-1821/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1821/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1821/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
