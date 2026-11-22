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
		buildId: "20efb9ef59c8-d52d269a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1821/\":\"351151d8167766a7\",\"/knowledge-medium/pr-preview/pr-1821/index.html\":\"351151d8167766a7\",\"/knowledge-medium/pr-preview/pr-1821/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1821/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1821/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1821/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1821/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1821/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1821/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1821/assets/FacadeVFS-CJpPlsvJ.js\":\"5805e6932cc10e68\",\"/knowledge-medium/pr-preview/pr-1821/assets/OPFSCoopSyncVFS-B6FncMiP.js\":\"3356047a4e73cfa2\",\"/knowledge-medium/pr-preview/pr-1821/assets/OPFSWriteAheadVFS-BXqb8Hyv.js\":\"82e73590b9f7abbf\",\"/knowledge-medium/pr-preview/pr-1821/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1821/assets/wa-sqlite-DaVhmALF.js\":\"b201a95bca2d74e8\",\"/knowledge-medium/pr-preview/pr-1821/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1821/assets/wa-sqlite-async-BdBemvZb.js\":\"a36bf928a65a8b41\",\"/knowledge-medium/pr-preview/pr-1821/assets/worker-Bvv52WTy.js\":\"f35a203ec32e8c15\",\"/knowledge-medium/pr-preview/pr-1821/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1821/chunks/app-CLmWkfm9.js\":\"9f04ca3000f24858\",\"/knowledge-medium/pr-preview/pr-1821/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1821/index.js\":\"9c14e85444c56ebf\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1821/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1821/assets/AccessHandlePoolVFS-BocHtMxq.js\":\"a02fb3e13bd59d10\",\"/knowledge-medium/pr-preview/pr-1821/assets/IDBBatchAtomicVFS-D0LPDz7y.js\":\"f46041cc84c46033\",\"/knowledge-medium/pr-preview/pr-1821/assets/MemoryVFS-gwfNEcxj.js\":\"211071f7b8ee06d1\",\"/knowledge-medium/pr-preview/pr-1821/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1821/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1821/assets/mc-wa-sqlite-async-fh0Yd4KI.js\":\"e076c53b6db0205d\",\"/knowledge-medium/pr-preview/pr-1821/assets/mc-wa-sqlite-rcGPDIGD.js\":\"3597937d891e84f6\",\"/knowledge-medium/pr-preview/pr-1821/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1821/chunks/AccessHandlePoolVFS-BGkm7-bn.js\":\"ff95e78916ef97c8\",\"/knowledge-medium/pr-preview/pr-1821/chunks/FacadeVFS-CD6VFsDa.js\":\"563c73c9da73445d\",\"/knowledge-medium/pr-preview/pr-1821/chunks/IDBBatchAtomicVFS-Ca1N4not.js\":\"c48da11fc94a4ed6\",\"/knowledge-medium/pr-preview/pr-1821/chunks/MemoryVFS-CTjbG6Cg.js\":\"e512df3b56a7731c\",\"/knowledge-medium/pr-preview/pr-1821/chunks/OPFSCoopSyncVFS-BwAykThh.js\":\"0c1b7020429c5483\",\"/knowledge-medium/pr-preview/pr-1821/chunks/OPFSWriteAheadVFS-BUr515h1.js\":\"dc80a065988f1763\",\"/knowledge-medium/pr-preview/pr-1821/chunks/Preview-D9i0hGKU.js\":\"b5fb24cceba8ac7f\",\"/knowledge-medium/pr-preview/pr-1821/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1821/chunks/card-Bae4FdTR.js\":\"afcc6b3dd9018b33\",\"/knowledge-medium/pr-preview/pr-1821/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1821/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1821/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1821/chunks/dist-widh3qNd.js\":\"cadef5d7252e5711\",\"/knowledge-medium/pr-preview/pr-1821/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1821/chunks/mc-wa-sqlite-DcyOyW1H.js\":\"4b4d9c64a7eeca52\",\"/knowledge-medium/pr-preview/pr-1821/chunks/mc-wa-sqlite-async-DqmY1bBS.js\":\"35034070547195b7\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-B9m6hA93.js\":\"85f5ede0caf4bb84\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-BHj2N9Ku.js\":\"e4cbaaef15637681\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-C8DnrcY4.js\":\"e7705d4bc605863c\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-CQHfsk0P.js\":\"e5b340fb7d92fe33\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-D1vOIU5W.js\":\"fcfa8d00ded3d7b8\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-D2eBCKDe.js\":\"400f8a6d332c48d9\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-D9tLJAC4.js\":\"ee8a3c7139870e54\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-DSrsG1l8.js\":\"a5ff63cff5444bdc\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-dom-server-legacy.browser.production-bT9vCBfS.js\":\"cecd327be064a1c6\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-dom-server.browser.production-BEgiCC9u.js\":\"e1eebfbff3763e15\",\"/knowledge-medium/pr-preview/pr-1821/chunks/react-dom-server.edge.production-BqWNiJNt.js\":\"874cfd3b31e18a66\",\"/knowledge-medium/pr-preview/pr-1821/chunks/server.browser-mISGJ4nk.js\":\"b7de7676bd1759dd\",\"/knowledge-medium/pr-preview/pr-1821/chunks/textarea-CVvO5FW1.js\":\"e1c8e7e526b9dbd5\",\"/knowledge-medium/pr-preview/pr-1821/chunks/ui-24n9udsN.js\":\"94f802e438422f99\",\"/knowledge-medium/pr-preview/pr-1821/chunks/wa-sqlite-C_HUXBAy.js\":\"e41a4fa0d9959e0b\",\"/knowledge-medium/pr-preview/pr-1821/chunks/wa-sqlite-async-aCCrnOKi.js\":\"d233a0cfda64960e\",\"/knowledge-medium/pr-preview/pr-1821/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1821/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1821/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1821/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1821/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1821/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1821/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1821/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1821/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1821/src/App.js\":\"c31c270cd4b7c560\",\"/knowledge-medium/pr-preview/pr-1821/src/appUpdate.js\":\"7c536a5514d61f2d\",\"/knowledge-medium/pr-preview/pr-1821/src/appVersion.js\":\"1d4ae84a31f16706\",\"/knowledge-medium/pr-preview/pr-1821/src/bootstrap/initialLayout.js\":\"c2ce2daf896c9881\",\"/knowledge-medium/pr-preview/pr-1821/src/bootstrap/openWorkspaceData.js\":\"3ed361f0d4d22c0e\",\"/knowledge-medium/pr-preview/pr-1821/src/bootstrap/resolveWorkspace.js\":\"49d22e406f0caf62\",\"/knowledge-medium/pr-preview/pr-1821/src/bootstrap/workspaceBootstrap.js\":\"d7d2bcef5aefae51\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockComponent.js\":\"80777ac18d50fb6e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockCrumbs.js\":\"66a04e926090d7d1\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockEditor.js\":\"529111984fcdbcd1\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockLoadingPlaceholder.js\":\"1657faa11b48df77\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockProperties.js\":\"b054dbc24efe3b80\",\"/knowledge-medium/pr-preview/pr-1821/src/components/BlockSearchPicker.js\":\"471e6978cc4c0a8d\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ConfirmBulkDeleteDialog.js\":\"640177eda10ce411\",\"/knowledge-medium/pr-preview/pr-1821/src/components/DividerHandle.js\":\"879f6e8810057458\",\"/knowledge-medium/pr-preview/pr-1821/src/components/DraftEditor.js\":\"ad6db6c9cb3f2235\",\"/knowledge-medium/pr-preview/pr-1821/src/components/GutterPill.js\":\"d716a0d013f926b5\",\"/knowledge-medium/pr-preview/pr-1821/src/components/Header.js\":\"2b675eb48c6ceb0e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/LazyBlockComponent.js\":\"003a67f8eb6fe53c\",\"/knowledge-medium/pr-preview/pr-1821/src/components/Login.js\":\"b777754d87eed743\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ZoomableSurface.js\":\"5bbe8d0e53515219\",\"/knowledge-medium/pr-preview/pr-1821/src/components/editModeKeepalive.js\":\"12cd6a34b456375a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d367dd2b7e36c7cd\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0a05dc9c1500324f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/RefPropertyEditor.js\":\"01cf205eb8b2202a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/RefTargetTypePicker.js\":\"976b0ea212367baf\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/SelectPropertyEditor.js\":\"895586fa17ed466d\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/TypesPropertyEditor.js\":\"78be7cb103730b45\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/defaults.js\":\"02b443db2f250d93\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/kernelValuePresets.js\":\"c7dc997d7ecdbd6b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/selectablePresets.js\":\"cda1b97372540e73\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyEditors/typesPropertyUi.js\":\"445f8fa292b91f89\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/AddPropertyForm.js\":\"a902b9ffd8b439fa\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/PropertyPicker.js\":\"6fdb937293ab240b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/PropertyRow.js\":\"4207fec69f6666a4\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/Rows.js\":\"e8d58213d75b6214\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/actions.js\":\"5ed6f4c7ccc6c8dc\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/declarationOnly.js\":\"d7fceb0410494788\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/layout.js\":\"44510ab876061c44\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/model.js\":\"cf611f43284db46d\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/shapeUi.js\":\"409a358e4993761f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/shapes.js\":\"a71cfde94e59d71a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b02fca0a4a26355f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanel/visibility.js\":\"091d6426f23fc093\",\"/knowledge-medium/pr-preview/pr-1821/src/components/propertyPanelSections.js\":\"afa59793664b4b3a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/BlockEmbed.js\":\"dc108fe502d25789\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/BlockLink.js\":\"dae3c3ebeeab2162\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/BlockRef.js\":\"94b4b713734a5ab9\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/ReferenceLink.js\":\"12bf5ecf70633201\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/cycleGuard.js\":\"c71a618db989fb95\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/cycleGuardContext.js\":\"41b194fdbd40ea6a\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/linkInteraction.js\":\"c2533f79594064c1\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/referenceLayout.js\":\"1480fbf51d4cc356\",\"/knowledge-medium/pr-preview/pr-1821/src/components/references/useBlockRefAncestors.js\":\"b4deb51a44f951e8\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/BlockGutter.js\":\"1f0d61d3e2e32671\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/BlockInfoDialog.js\":\"b54d312fd6acd2dc\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/BlockTypeBlockRenderer.js\":\"bcbf59840e7fb02b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/BulletHoverCard.js\":\"26aeab6798981129\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/CodeMirrorContentRenderer.js\":\"4697e32597465a2f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"98a72d1858beaec8\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/ColumnResizeHandles.js\":\"7dd634ab0ead509b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e5b7c363444ade16\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/DefaultBlockRenderer.js\":\"1a6becd03b600291\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/LayoutRenderer.js\":\"14a93ea350909d44\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/MarkdownContentRenderer.js\":\"ef5170bc5822b5b3\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/MissingDataRenderer.js\":\"3cda71d2a020146e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/PanelRenderer.js\":\"9b6e22cd65353a34\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f42a9c2f921138b9\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/TopLevelRenderer.js\":\"f4a5baf3079d5940\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/blockGutterMode.js\":\"1cbba08a53e10d94\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/blockTitleText.js\":\"22731ce45126e135\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/fieldCreationKeydown.js\":\"3fa57f922cfb1293\",\"/knowledge-medium/pr-preview/pr-1821/src/components/renderer/layoutRootContext.js\":\"cb4437e9af7b9b96\",\"/knowledge-medium/pr-preview/pr-1821/src/components/typeChip/TypeChip.js\":\"a147983334813268\",\"/knowledge-medium/pr-preview/pr-1821/src/components/typeChip/chipStyle.js\":\"ddb196b5665c81ea\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/anchored-floating.js\":\"639ce2a9faee4552\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/button.js\":\"19cc1fe8cb46922f\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/card.js\":\"ff9e6423621893ba\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/checkbox.js\":\"ab4a571b19043df2\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/collapsible.js\":\"d7e309958ac488ad\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/command.js\":\"0f176340beb25ebe\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/context-menu.js\":\"ad0483e7ef901d68\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/dialog.js\":\"236ea9c09dc947a2\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/dropdown-menu.js\":\"bc3cfaf3775bcd3e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/floating-listbox.js\":\"dd4092536986292d\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/index.js\":\"a699f058a59e3adf\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/input.js\":\"8ec83640b533c0ef\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/kbd.js\":\"f17268c46d70b835\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/label.js\":\"05fd0e93b9f67397\",\"/knowledge-medium/pr-preview/pr-1821/src/components/ui/textarea.js\":\"c2fcfd88a547e394\",\"/knowledge-medium/pr-preview/pr-1821/src/components/useEditModeYieldKeepalive.js\":\"e553277665fe2992\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/BootFallback.js\":\"1940261c985e288b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/FocusedRowLazyMount.js\":\"8645c03adc28a9c1\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/LazyViewportMount.js\":\"b5048ef34bff98bc\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/LocalDbCorruptionFallback.js\":\"393683aa04ac61f5\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/error.js\":\"aee4b0d48ee90b9b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/lazyMountRegistry.js\":\"30ac02c784a3d8ec\",\"/knowledge-medium/pr-preview/pr-1821/src/components/util/suspense.js\":\"8a1ac115c89df899\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/CreateWorkspaceDialog.js\":\"133b5cdc21f766a8\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/PendingInvitations.js\":\"c5612348cc0bc93c\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/SyncProgress.js\":\"f3a5faac600557f8\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/UnlockProgress.js\":\"302ff5275cb4149e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/WorkspaceKeyGate.js\":\"719dee324aa13597\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/WorkspaceSettingsDialog.js\":\"ebf865601fd3e05c\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/WorkspaceSwitcher.js\":\"12dc4e34d3a817d1\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/WorkspaceSyncGate.js\":\"166ebfb90a12df02\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/ConversionFlow.js\":\"9f0cfbf6690fcb04\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/ConversionFlowHost.js\":\"70182c8a17eabc36\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/EncryptionSection.js\":\"e69579f5e112f93e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/attachmentPrompts.js\":\"eb0c2e814bf732c2\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/bundleFolderPrompts.js\":\"809c455ac059e914\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/conversionFlowDeps.js\":\"03ea1dbf7c1dc99e\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/conversionFlowStore.js\":\"5fbf4c91dd0d9b1b\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/flowUi.js\":\"8f99dabfb6e958c9\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/conversion/useConversionRun.js\":\"dd131a31edf87451\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/keyUi.js\":\"fb04d08f5a1f28f1\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/useCloseOnKeyLoss.js\":\"02df13fe5e30fd0d\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/useCloseOnServerE2ee.js\":\"5d1ed128ff45f5c8\",\"/knowledge-medium/pr-preview/pr-1821/src/components/workspace/workspaceUnlocked.js\":\"88df1fff65356de2\",\"/knowledge-medium/pr-preview/pr-1821/src/context/backgroundSubtree.js\":\"95a976390c1af63c\",\"/knowledge-medium/pr-preview/pr-1821/src/context/block.js\":\"6ba72074823df8e4\",\"/knowledge-medium/pr-preview/pr-1821/src/context/layoutWsContext.js\":\"1c1dcefb93f1340c\",\"/knowledge-medium/pr-preview/pr-1821/src/context/propertyDisplay.js\":\"e88c5e0b4bdede1a\",\"/knowledge-medium/pr-preview/pr-1821/src/context/repo.js\":\"c3fe1fd69a12b8fd\",\"/knowledge-medium/pr-preview/pr-1821/src/data/aliasClaim.js\":\"3b8c9b6fe83c1bcc\",\"/knowledge-medium/pr-preview/pr-1821/src/data/aliasSeatNamespace.js\":\"28ee648117fb1c49\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/blockData.js\":\"50e8c6d7e7c572c5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/blockType.js\":\"31a776a5ccaf10ec\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/changeScope.js\":\"db945ad27d11c062\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/codecs.js\":\"b4b2a9c53ca8ee68\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/derivedData.js\":\"a28353d16bd830ac\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/errors.js\":\"1b6c1b8f0660ea7e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/events.js\":\"d97e59324e713c85\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/handle.js\":\"18713580a8756376\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/index.js\":\"617ce8f6d1f8375e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/mutator.js\":\"8e7b1e71d00c1199\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/processor.js\":\"0451efbeaf248173\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/propertySchema.js\":\"83a3de61c3c83a66\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/query.js\":\"c3335f7a90a5dc9f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/sameTxProcessor.js\":\"44d0fbf4c00f677b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/schema.js\":\"18713580a8756376\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/tx.js\":\"18713580a8756376\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/typedBlockQuery.js\":\"95d005d27c0166dc\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/user.js\":\"a717a9ec2236393e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/valuePresetCore.js\":\"2182762fe9805fac\",\"/knowledge-medium/pr-preview/pr-1821/src/data/api/valuePresets.js\":\"0912cb2ab9c9af31\",\"/knowledge-medium/pr-preview/pr-1821/src/data/attachmentCleanerIOVerb.js\":\"74ec7588e4cde8c5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/block.js\":\"1123691b3c6e922f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockCache.js\":\"6cd356272eaaaa8e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockId.js\":\"694b7c7a623c989b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockLiveness.js\":\"09c54d0f1b212ea7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockMerge.js\":\"b7620d7e4bd411dc\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockSchema.js\":\"ad3fbdeb43d40375\",\"/knowledge-medium/pr-preview/pr-1821/src/data/blockTypes.js\":\"1b73ad48266d89d7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/clientContext.js\":\"c1e384cf9870b8fe\",\"/knowledge-medium/pr-preview/pr-1821/src/data/dbFileSiblings.js\":\"4d10c1c9cf5d926c\",\"/knowledge-medium/pr-preview/pr-1821/src/data/definitionSeeds.js\":\"5a041d98989673e6\",\"/knowledge-medium/pr-preview/pr-1821/src/data/derivedIds.js\":\"1c0bb23efa39fb3a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/drawnSubtree.js\":\"99d06b24db3da89b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/facetBridge.js\":\"87d99b5abab9ee53\",\"/knowledge-medium/pr-preview/pr-1821/src/data/facets.js\":\"2e461b07bbd231be\",\"/knowledge-medium/pr-preview/pr-1821/src/data/globalState.js\":\"44dbfa5eebccc9d8\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/aliasClaimRederiveProcessor.js\":\"503daa24a5158f20\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/ancestorBatch.js\":\"cd2242581e0ef2f3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/blockTypeTypeifyProcessor.js\":\"d566f499e3f5a685\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/clientSchema.js\":\"fa5644a6dc086155\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/commitPipeline.js\":\"2195c83af2f8f0bb\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/devAssertions.js\":\"c4dde3a5e4dc5551\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/firstSync.js\":\"aabf0d16de9eee3e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/freshInitialLoad.js\":\"50fe822f57793a3b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/graphBackfillClaim.js\":\"6438dd08e95db78a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/handleStore.js\":\"77c27d677942a037\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/idleMarkerJobs.js\":\"55076547401eaf39\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/initialDownload.js\":\"0ce181367bf174d2\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/initializeClientDatabase.js\":\"6fbe765186986413\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/jsonCanonical.js\":\"4275eb5b5bd82197\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/kernelInvalidation.js\":\"3219c759d78edf3b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/kernelProcessors.js\":\"a17a4ad850d56552\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/kernelQueries.js\":\"59d0bf3f674b422c\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/mergeTypeMembershipProcessor.js\":\"30762815ece1229a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/normalizeReferencesProcessor.js\":\"b24957598cbecba7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/poolInstrumentation.js\":\"7b88e1a7c8491af9\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/processorRunner.js\":\"649ee116d24c53df\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyCellBackfill.js\":\"a8581e5aa91026a5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyChildMint.js\":\"bce2c7acfa93bf00\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyChildrenProcessor.js\":\"4d209588c3c0f75b\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bd24a8ed4010c542\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyDefinitionSynthesis.js\":\"ebdb9ddf7ba3e787\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyKeyScan.js\":\"1d8b1531aa027f63\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertySchemaResolution.js\":\"44bf4064a1ed6b93\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/propertyValueEdits.js\":\"f4488ab9148a993e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/raiseProtocol.js\":\"0cee7734c152bfbb\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/readBatch.js\":\"b3351253ff7c65ca\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/refProjection.js\":\"49377af9bf9f6737\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/referenceTargetLookups.js\":\"6d358ccffef396c9\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/referenceTargetProcessor.js\":\"2087f05945976180\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/replayMerge.js\":\"0f9b25972db2e6c2\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/sqlBinds.js\":\"918127f5bab70566\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e23216b314f3ec7a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/arrivalProcessors.js\":\"a56026fe73b89810\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/invalidate.js\":\"29e7592d111dde0d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/materialize.js\":\"14f16e3cf3f6dd5d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/observer.js\":\"3a4b1cef7758cd37\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/syncObserver/reconcile.js\":\"c12a94bcace072b6\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/timingMetrics.js\":\"303058a8871de4fb\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/treeQueries.js\":\"5c460b2f1d59e0a4\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/txEngine.js\":\"1a43a02ad74ea42a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/txSnapshots.js\":\"7d39e09a480ab6f7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/typedBlockQuery.js\":\"aa3e80f7af70fc44\",\"/knowledge-medium/pr-preview/pr-1821/src/data/internals/undoManager.js\":\"c025ae77ea864f7d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/invalidation.js\":\"0dabab665b137156\",\"/knowledge-medium/pr-preview/pr-1821/src/data/kernelDataExtension.js\":\"d25b8302a4d7bd61\",\"/knowledge-medium/pr-preview/pr-1821/src/data/kernelPage.js\":\"a5cce8afca347578\",\"/knowledge-medium/pr-preview/pr-1821/src/data/kernelValuePresetCores.js\":\"f1c2a6224fcbb3e1\",\"/knowledge-medium/pr-preview/pr-1821/src/data/localDbCorruptionSignal.js\":\"21b79376e7c3a632\",\"/knowledge-medium/pr-preview/pr-1821/src/data/localDbStorage.js\":\"ef6f0f834434d942\",\"/knowledge-medium/pr-preview/pr-1821/src/data/localDbVfs.js\":\"b3f4f1624494d3fb\",\"/knowledge-medium/pr-preview/pr-1821/src/data/localSchema.js\":\"90faafefebd85362\",\"/knowledge-medium/pr-preview/pr-1821/src/data/maintenance.js\":\"e437bd5367d26c2a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/mergeProperties.js\":\"47cbd4e5e5216ab7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/metricsConsoleHook.js\":\"99b82c3ad7e8a0a5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/migrationsPage.js\":\"1e802ec37e0b86e1\",\"/knowledge-medium/pr-preview/pr-1821/src/data/mutators.js\":\"37e4ae1e4c6c9e9e\",\"/knowledge-medium/pr-preview/pr-1821/src/data/orderKey.js\":\"329aafdc252ecce7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/orderKeyPlacement.js\":\"082e758815e5c78f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/outlineSurface.js\":\"10c2654f01e13ced\",\"/knowledge-medium/pr-preview/pr-1821/src/data/pendingEditorContent.js\":\"e47607d2ebeee282\",\"/knowledge-medium/pr-preview/pr-1821/src/data/pendingUploadsSql.js\":\"144802ef2b7458b5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/pluginStateExtensions.js\":\"1da5cb35bb4171be\",\"/knowledge-medium/pr-preview/pr-1821/src/data/powerSyncLogger.js\":\"311332410cc49162\",\"/knowledge-medium/pr-preview/pr-1821/src/data/projectorRuntime.js\":\"5c914d54d87ef5e2\",\"/knowledge-medium/pr-preview/pr-1821/src/data/properties.js\":\"3ce1db75ef484503\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertiesPage.js\":\"695e2eccf5c94e51\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyChildren.js\":\"3799ec12178df14f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyDefinitionFanout.js\":\"eccf380aca5038f3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyDefinitionMetadata.js\":\"b327f2e112f8b522\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyDefinitionRegistry.js\":\"80661730ea68fc62\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyDisplayMode.js\":\"afbd7dc599ca678a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertyRowCreation.js\":\"a1638d734e8c6aa9\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertySchemaCreation.js\":\"4d46a0564947bae5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/propertySeeds.js\":\"e237ca6d048e1f4a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/recentsPage.js\":\"2a7558c884126fe6\",\"/knowledge-medium/pr-preview/pr-1821/src/data/referenceBlock.js\":\"a030cfe2979d8dc0\",\"/knowledge-medium/pr-preview/pr-1821/src/data/rejectedUploads.js\":\"2d0ea0d6e86df296\",\"/knowledge-medium/pr-preview/pr-1821/src/data/releasePowerSyncConnection.js\":\"316fccc874be06f5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/repo.js\":\"1481f7bffa65b1e0\",\"/knowledge-medium/pr-preview/pr-1821/src/data/repoProvider.js\":\"67d1fcb0d43f5980\",\"/knowledge-medium/pr-preview/pr-1821/src/data/rowProperty.js\":\"2d094a0a2000c027\",\"/knowledge-medium/pr-preview/pr-1821/src/data/searchFilter.js\":\"b118ad99d53cee8a\",\"/knowledge-medium/pr-preview/pr-1821/src/data/seedIdentityLedger.js\":\"341b1f1095ec1f40\",\"/knowledge-medium/pr-preview/pr-1821/src/data/stateBlocks.js\":\"d1de2c51c8a08d08\",\"/knowledge-medium/pr-preview/pr-1821/src/data/structuralEditPolicy.js\":\"dc2294ed4c191fd3\",\"/knowledge-medium/pr-preview/pr-1821/src/data/subtreeDelete.js\":\"7ef2ae4cfbb691ed\",\"/knowledge-medium/pr-preview/pr-1821/src/data/syncStreamLock.js\":\"830201a1cbf9c318\",\"/knowledge-medium/pr-preview/pr-1821/src/data/syncedTableSqlRecognizer.js\":\"f3834edadeb1af4f\",\"/knowledge-medium/pr-preview/pr-1821/src/data/syncedTableWriteGuard.js\":\"0a488a62d70ec556\",\"/knowledge-medium/pr-preview/pr-1821/src/data/targets.js\":\"ac31fd8bdf24d663\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeColors.js\":\"b4c6959ef9dff2b4\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeDefinitionMetadata.js\":\"ea0e01380f71a945\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeDefinitionRegistry.js\":\"45bc11abbd159879\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeExtraction.js\":\"069ee4b966fe51d0\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeInitialValues.js\":\"aaa9aca0541da59d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typePropertyGroups.js\":\"5f9fd85ea09df2c0\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeSeeds.js\":\"872944982794117d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typeTagger.js\":\"b63b57d25f5ed84d\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typedRecords.js\":\"3c74892a3f2f9b69\",\"/knowledge-medium/pr-preview/pr-1821/src/data/typesPage.js\":\"2edafd2e475f81cb\",\"/knowledge-medium/pr-preview/pr-1821/src/data/userPrefs.js\":\"2a01e99cf3cbdccb\",\"/knowledge-medium/pr-preview/pr-1821/src/data/userSchemasService.js\":\"5592cdb1ab212779\",\"/knowledge-medium/pr-preview/pr-1821/src/data/userTypesService.js\":\"188be90de350ee14\",\"/knowledge-medium/pr-preview/pr-1821/src/data/valuePresetRegistry.js\":\"bbad6a1f2e2045a7\",\"/knowledge-medium/pr-preview/pr-1821/src/data/visibleChildren.js\":\"5e97482da10554e9\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaceConversion.js\":\"fae6c15827397a4c\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaceFirstSync.js\":\"3f560882474c4a62\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaceIdNamespace.js\":\"dec5a23cccd9cce6\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaceSchema.js\":\"df633efcec71ebba\",\"/knowledge-medium/pr-preview/pr-1821/src/data/workspaces.js\":\"31bb74820c09d88c\",\"/knowledge-medium/pr-preview/pr-1821/src/data/writeAheadLog.js\":\"e616858d1c76eab5\",\"/knowledge-medium/pr-preview/pr-1821/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/BlockPasteShellDecorator.js\":\"447c3cbb07647f0e\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/atTrigger.js\":\"2d50cbee4a800d2f\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/autocomplete.js\":\"313687f82a819477\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/codeMirrorExtensions.js\":\"be3191dfb6aac5bb\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/contentFlush.js\":\"e51855a75693b4f7\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/defaultInteractions.js\":\"b5baab9cf125c796\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/editSettleSignal.js\":\"ee2041348f557ed2\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/insertImage.js\":\"1ca45f8a01ad8f03\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/referenceCompletionRange.js\":\"6809abd6dfbf185f\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/referenceTargetTypes.js\":\"81e9fa65601385f3\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/syntaxContext.js\":\"e4b28bf722c1b27d\",\"/knowledge-medium/pr-preview/pr-1821/src/editor/triggerMatch.js\":\"3853102e580e8a25\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/AppRuntimeProvider.js\":\"55c2ff14b6e26b43\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/BlockFocusShellDecorator.js\":\"e2c098adf183d418\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/ExtensionRenderBoundary.js\":\"8acec0c0f9e61a66\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/PanelContentRecovery.js\":\"a5021be896a33341\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/apiCatalog.js\":\"da2753dff8253d32\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/approveExtensionHere.js\":\"855ecd87661088b7\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/armedCutAppMount.js\":\"a218e764b8288f25\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/batchableKeyedStore.js\":\"7e545df05432dc75\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/blockInteraction.js\":\"ddbc10749c8cee45\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/blockSelectionAction.js\":\"baaefd64a3990ae8\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/compileExtensionModule.js\":\"fca915ed6d33399b\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/compiledModuleCache.js\":\"4eb5b08772e266c5\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/continuousGestures.js\":\"28420e86ba8c672d\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/core.js\":\"68450991e2b91c4e\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/defaultRenderers.js\":\"a4b76c3d0c1f0a5a\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/definitionFanoutAppMount.js\":\"f7e93235a3ac4d78\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/dialogAppMount.js\":\"8b788da6159d1b9f\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/dynamicExtensionSeeds.js\":\"b96b582e2c71a101\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/dynamicExtensions.js\":\"78724df2a486ab73\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/exampleExtensions.js\":\"f779f62dc9bd745f\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionApprovalStatus.js\":\"c4f94b02e8377b48\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionLoadErrorToast.js\":\"24f2f988594bc6b9\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionLoadErrors.js\":\"e0b456db27e35625\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionLookup.js\":\"432e9cc14a49424f\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionToggles.js\":\"cc0d6a65a072f1f1\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/extensionUtilitiesCss.js\":\"6b8f30118def3513\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/kernelPageDeletionGuard.js\":\"ea5d82160105254e\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/liveRuntime.js\":\"96dfd3e1d6126318\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/openExtensionsSettings.js\":\"efd80ea9627ae556\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/overridesCache.js\":\"cc431d03e90694be\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/pluginIds.js\":\"90b6fc5ec8e26cae\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/processorRejectionToast.js\":\"c8277216401d51e2\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/runtimeActions.js\":\"db310028a6dbb7b0\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/runtimeContext.js\":\"8a2d6440a3045e0d\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/staticAppExtensions.js\":\"1c67d3757d23ba16\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/staticDataExtensions.js\":\"ac8c03ddb6675bb9\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/toastAppMount.js\":\"276fd1ba81212808\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/useOverrides.js\":\"6bfed17c0fe9785c\",\"/knowledge-medium/pr-preview/pr-1821/src/extensions/useShortcutSurfaceActivations.js\":\"59f2a40e395111a2\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/discoverToggleTree.js\":\"33e3ab74cc67eef8\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/facet.js\":\"e6f683980154e000\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/resolveAppRuntime.js\":\"76eaa27b81c3812c\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/runtimeEvents.js\":\"0746c9879299f797\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/togglable.js\":\"11c712f57d914c4a\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/variantFacet.js\":\"64210e62140cc8ea\",\"/knowledge-medium/pr-preview/pr-1821/src/facets/verbFacet.js\":\"18a5fc54f17068cc\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/block.js\":\"5f3f568a7882f1c3\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/focusedChild.js\":\"90566ba86a7c42bb\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/propertySchemas.js\":\"9bdec85603815616\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/typeRegistry.js\":\"bece2c5a3455c1f6\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useAncestorCrumbs.js\":\"e8d2a3717d1fa86f\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useAutocompleteListbox.js\":\"b91771e6508c7623\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useDebouncedSearch.js\":\"d4d7858d8e7e46af\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useDebouncedValue.js\":\"7eb2cba5d7c701a8\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useIsFocalRender.js\":\"95975f6522ebfb60\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useIsReadOnly.js\":\"b8919a7e903f5297\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useMaterializeBacklog.js\":\"c8b93f74c3216088\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useMinuteClock.js\":\"2176b8a7444cde92\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/usePanelLayoutProjection.js\":\"a3db2cdbddd6ca1d\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/usePendingInvitations.js\":\"5e7b56523691f94c\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useRendererRegistry.js\":\"33e82cc3956f7064\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useRetainedFieldRows.js\":\"14d75b8f5f1543d7\",\"/knowledge-medium/pr-preview/pr-1821/src/hooks/useWorkspaces.js\":\"5b1a2b03fab6d0da\",\"/knowledge-medium/pr-preview/pr-1821/src/lib/utils.js\":\"077de18a7aabac88\",\"/knowledge-medium/pr-preview/pr-1821/src/main.js\":\"72a142f6a9ff1d23\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/MarkdownImage.js\":\"380b50116e933ae8\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/blockSeparators.js\":\"0323afa6d4911266\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/context.js\":\"87de1131e810e24d\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/defaultMarkdownExtension.js\":\"1665e0fd4b40b971\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/extensions.js\":\"feaf5756afce2cc1\",\"/knowledge-medium/pr-preview/pr-1821/src/markdown/renderMarkdownHtml.js\":\"89df59f6407fa956\",\"/knowledge-medium/pr-preview/pr-1821/src/minimal-editor.js\":\"d50f866c179cacd2\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/armedCut.js\":\"87807c254861999b\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/captureMediaVerb.js\":\"4d2e591ad356c52e\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/clipboard.js\":\"a739f4d07df9978c\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/decision.js\":\"b2e84d97d11f4165\",\"/knowledge-medium/pr-preview/pr-1821/src/paste/operations.js\":\"ab0701bd70271e78\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/account-header/AccountHeaderItem.js\":\"25466060f52a8a11\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/account-header/index.js\":\"5886cefbe5108186\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"06978569a55154f6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/askAgent.js\":\"1aa943ca02713d4a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/askedStore.js\":\"87df519839d08e4c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"66217d0aadead3d0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/chipState.js\":\"a2d9e373cf36db06\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ae76dc62498b95ce\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/index.js\":\"e1377e3a149dd26d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ea8d81bbb84644f8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-dispatch-companion/schema.js\":\"0b94d558dc17b57a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f15b155c467858a3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e582967a57b695e5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/addMedia.js\":\"949512fc475b1dd9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/backlinks.js\":\"05cf066e314b457d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/block.js\":\"a5cc1b0805381cf2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/context.js\":\"f71e1b5738844132\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/displayIds.js\":\"004d2d38a0174866\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/index.js\":\"c3843e4e97e4bbb1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/outline.js\":\"cd1026d28f3c21bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/properties.js\":\"601555f91d99c424\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/refs.js\":\"fcd5fcb286788163\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"beeba1dbef42e850\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/search.js\":\"41b10e6fa1574df8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/shared.js\":\"9e7fa647c80ae778\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8554a585da384e21\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentViews/text.js\":\"3018a68553ef2704\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/agentWrites.js\":\"38acb9e34417598f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/authoringCatalog.js\":\"8555892996d94e8b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/blockRefTargets.js\":\"2fb9714ac9a4cb41\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/bridge.js\":\"c20a7564b3517fb0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/bridgeLoop.js\":\"5d98dc4e82301a08\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/changeHistory.js\":\"b9263961207d1b4d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/commands.js\":\"1789cf5db23bbcbf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/commentsCommands.js\":\"2a4c283c86b0b394\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/dataExtension.js\":\"ccc8e0e2ea58e97a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/dataModelGuide.js\":\"4622d2dfbcf5abe6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/describeRuntime.js\":\"504d9e319db93159\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/extensionLint.js\":\"b97c1d768bf97f07\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/grainAudit.js\":\"648f84c9cc3b3114\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/healthCommand.js\":\"7f7c3601de78f71f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/index.js\":\"c83a8983ac2e7258\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/presetIdentity.js\":\"f8c55c0fc28122b2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a58d893a27a5ffe1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/readMedia.js\":\"f31acd842e6ddca5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/schema.js\":\"89abdb5b9b031330\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/serialization.js\":\"cf1d5cc0636af379\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/targets.js\":\"d1ab01b379dc0227\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/tokens.js\":\"565966964e81c608\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/watchEvents.js\":\"742077fc601ce6a4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/workspaceGuard.js\":\"87272d5870445f5d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/agent-runtime/writeCommands.js\":\"5c9c4fee64f21996\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/AliasCollisionToast.js\":\"924c3dd0bed8f6b0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/DuplicateNameBanner.js\":\"bb90e2a016ae719f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/collisionMerge.js\":\"618bfbad527bbb6e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/dataExtension.js\":\"429fb9c4926ab463\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/index.js\":\"d24ae4b008f03fe1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/mergeCollisionAction.js\":\"eef1c5922ab4d3d4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/pageStyling.js\":\"800bf6d2eb954649\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/rejectionToast.js\":\"d1a54f10b208824a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/alias/syncProcessor.js\":\"389632387d219a9d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/actions.js\":\"f0bbf1734e08a128\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/addComment.js\":\"07faf94318710f95\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/anchor.js\":\"099bb2acef0a064a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/anchorState.js\":\"9567770ae77469c9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/commentLinks.js\":\"76ab77e47ea025bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/confirmThreadDeletion.js\":\"c6905f723e361097\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/container.js\":\"9ef164eb058fcc7e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/dataExtension.js\":\"9bb15ba9dfc33169\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/deleteComment.js\":\"cfd3816d9e119670\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/highlights.js\":\"f07e2ebd6c8f9cf6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/index.js\":\"017f7f8f7e194f33\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/linkedCommentsPill.js\":\"4855665329110681\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/margin.js\":\"ada128443a5211e3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/marginSchema.js\":\"68677fe4b194052c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/newComment.js\":\"08f6808d94b3431d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/ownThreadPicker.js\":\"6505a2dbcfed2fcd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/placement.js\":\"d806d1281df237cf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/queries.js\":\"cb87aff57ac1311a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/quotePosition.js\":\"80363458e0044d0b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/quotedIn.js\":\"973bd8ce81646424\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/quotedRange.js\":\"2f8ce1d06b53f401\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/rangeRefs.js\":\"6ea9f99a753d4eb7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/readHighlights.js\":\"9f12e550763fa507\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/readSelection.js\":\"205d115309ea7e5a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/readSelectionUi.js\":\"935696dcae4a00e9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/reanchor.js\":\"9954014ea58f6e0f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/schema.js\":\"fedb0cdb61bdf715\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/scope.js\":\"9267229bcd3774df\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/scopeThreads.js\":\"73d809c2d59e36f5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/splitRetarget.js\":\"58f77898bf0d19b4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/suggestionCard.js\":\"a6436cadfe59c4c5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/suggestions.js\":\"a4a43c40c1c15ed8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/summaries.js\":\"15ca74343dd1ad81\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/summaryBatch.js\":\"c03be1e938b781ad\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/surface.js\":\"0aceaec13d8c9c66\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/threadNavigation.js\":\"2108fa1ac57748d5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/threads.js\":\"d915b4f0070d95d7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/ui.js\":\"04669efcc9817b79\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/annotations/uiStore.js\":\"399d8add0e9b7669\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/app-intents/appIntents.js\":\"395d930bfc24c465\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/app-intents/index.js\":\"48aa4e9971032ef5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/app-update-prompt/index.js\":\"00a2f6eb962532d4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/app-update-prompt/status.js\":\"58f9e3a9e11f732f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"43936b4260e466fe\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/MediaBlockRenderer.js\":\"48301ff667f9f22c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/MediaDownLaneReplicator.js\":\"217d65d24659c92a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/MediaUploadReconciler.js\":\"a3eabb135a2db45e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/assetDownLane.js\":\"8d404105e698effa\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/assetResolver.js\":\"24bf6daa80137f94\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/assetUpload.js\":\"6ce78f520aad61a3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/attachmentCleanerIO.js\":\"d5bb1c56ca4f3af9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e8a4eeabf210303b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/blobStore.js\":\"c23a472ccce65ea4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/byteStore.js\":\"d67c874fcc484f12\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/cleanerIO.js\":\"eb50c01e8cba4942\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/cleanupAttachments.js\":\"812f5a74c54356cb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/dataExtension.js\":\"c3cfb4736955a8ae\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/downLane.js\":\"eea5c003f5813921\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/index.js\":\"87c76bc396e14783\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/insertImageContribution.js\":\"911f438e7580b95a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/laneArming.js\":\"dea6a8d6fed320f9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/laneLock.js\":\"d4aac32168a3b8ed\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/mediaBlock.js\":\"3b5e9f7574fb6799\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/mediaCapture.js\":\"7ae1218266075f1e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/mediaViewers.js\":\"5ed8e3f725eca0f3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/mediaViewersFacet.js\":\"a7a7b48289793f0b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/pasteCapture.js\":\"f45d541654e30f85\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/resolver.js\":\"084b9ad5dd4ebcde\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/retryUploadsAction.js\":\"45e40d04a2c12e3e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/storagePaths.js\":\"36cb56efbbed530c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadDrain.js\":\"80a7144eefc1684a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadLaneStatus.js\":\"c887bca51864122e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadReconcile.js\":\"75dac63d6a64280b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadRecovery.js\":\"e863644eda4c9431\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/uploadStore.js\":\"b2d379dfad12c184\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/attachments/useAssetObjectUrl.js\":\"caafe31329615f19\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f5573b2d76deb07f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/BacklinksViewSection.js\":\"1e2a55e664f04a81\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/facet.js\":\"759a4ad1c9e6b00a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/index.js\":\"282bf46b53a7deda\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks-view/prop.js\":\"e53a942172d7bf04\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/BacklinkFilters.js\":\"c9f82a2b8ca1f74b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"de356ec87a244ca1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/BlockEntry.js\":\"15c1f5a6184c4f8b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/LinkedReferences.js\":\"633a935c3229d7af\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"1fc9c649cb41d724\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/dailyNoteDefaults.js\":\"08380a11f6cd0546\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/dataExtension.js\":\"26275b1660677a20\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/edgeExclusions.js\":\"be01fbc710ca71b9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/filterProperty.js\":\"8c646c77f622bc94\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/index.js\":\"359d8dff5d9e3073\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"284b6e5d6bea6215\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/applies.js\":\"6131ed3e0d3e9080\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/countQuery.js\":\"98dae34d242c826f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ac399e5c81782592\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/index.js\":\"0afdccc1458bdeb6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"533407a1bd06e265\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/presentationInvalidation.js\":\"e877a5bb7c6a2329\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/propertyEditorOverride.js\":\"8adf677fedade5b5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/propertyFilter.js\":\"edd19f53fa8ad26f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/query.js\":\"a0e17e5e9a098940\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/resolveFilter.js\":\"849131796baf5959\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/sourceBatch.js\":\"30896f3ba31f4211\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/sources.js\":\"42d5b8570f1d9c05\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/useBacklinks.js\":\"b00765592be4c85c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"66101a84353a2a8b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/BirthdayCelebration.js\":\"0c64373b1a2c5aa3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/BirthdayOverlay.js\":\"3b21f168ec65d3ba\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/gate.js\":\"66c38cab9a7d2774\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/index.js\":\"d78b0a55176630b0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/birthday/wolfTheme.js\":\"5ef46536822fb7f3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/BlockDragLayer.js\":\"a2cbfdc0a0edbae8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/dragController.js\":\"9e203d5c58cecb1e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/dropTarget.js\":\"e33bd41d3df6b9ca\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/index.js\":\"e74ff7801a60a6bd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-drag/projection.js\":\"2c18d439157818b3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-info/BlockMetaCard.js\":\"0fd14ebc0bfc1cd7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-info/index.js\":\"a631765f637d5d9e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/AddTagDialog.js\":\"96330fa8a1616633\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2744bc3d5f4c030d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/TagNameIssueHint.js\":\"fabe59c9e76cd53c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/addTagAction.js\":\"4109cea3ed903a89\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/appendTag.js\":\"1b3f17eee2c27405\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/config.js\":\"5cabcf2d699dcaf0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/dataExtension.js\":\"52dbcc26c007e291\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/index.js\":\"cd52409cdbcc97e6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/block-tagging/propertyEditorOverride.js\":\"6ccb5266751f73c2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e411f75e3ca8bf39\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6d04091251c1f052\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e68982d4c7c01211\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b029304d3ccdcd66\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a4aead27648d6879\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/index.js\":\"60c32d5584748d51\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7fe92fc91bae7b7d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/CharacterCountItem.js\":\"12ad3259cf2968e2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9ad598e8c4b08a55\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/actions.js\":\"1baaf8a09fdc48c8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/blockType.js\":\"7781a5dd98daff38\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/charCount.js\":\"864cd74202957670\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/dataExtension.js\":\"456ee100ac019df7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/index.js\":\"d5463b4663c3170c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/profiles.js\":\"c08eb8f8f9b945ea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/properties.js\":\"2e7bdc58efa2a0c9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/character-counter/textCounts.js\":\"6a012c798e8afb79\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/colemak-keybindings/index.js\":\"07cb46e1f927fbaf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/CommandPalette.js\":\"c6d3c0f1f715648a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/HeaderItem.js\":\"082e31a905ef310d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/context.js\":\"777b32d3e4467ecb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/index.js\":\"20d7d5caae8074d6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/selection.js\":\"8ef0e0cda9eb3704\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/toggleStore.js\":\"6b2dc96de5fe6119\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/command-palette/useCommandPaletteActions.js\":\"8ed909a9707a255d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/ContributorBadges.js\":\"fb28550d83c88867\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/author.js\":\"45816cc66470512d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/codeMirrorExtensions.js\":\"1ad2461829605ae9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/dataExtension.js\":\"76b1da855949fbb7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/index.js\":\"c1256c646375c89a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/mentionAutocomplete.js\":\"dcd7f12ed34d9f4f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/processor.js\":\"c6c5da42d43f3117\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/profiles.js\":\"9a0244dda2a6012e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/queries.js\":\"6e3ea646b4a67a48\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/contributors/schema.js\":\"108710b77410c2e1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8e464f591d8f14f9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/followOrigin.js\":\"65e67cdc54a7bedf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/index.js\":\"a3cb285b4d4280c8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1e646c6e831bbad6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c079fc1f36f5daa3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/CalendarGrid.js\":\"618d643c056ead74\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/DailyNotePicker.js\":\"30d0dfcfa8f45922\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"36112439144a9658\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/DateNavDecorator.js\":\"128ad3d9fdd5dd8b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/DateScrubOverlay.js\":\"d5e72366ce4746b4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/HeaderItem.js\":\"1b2903cf5597a36b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/ReschedulePicker.js\":\"ca11c11cacd09412\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/SpreadDatesDialog.js\":\"27646c8e87d02409\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/actions.js\":\"2cbcccab137e6301\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/blockDateAdapter.js\":\"b63d004f481c929e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/calendar.js\":\"9afc832ebc5b56a1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dailyNotes.js\":\"9428fd903dec0e95\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dataExtension.js\":\"2780b0ca9a6844e1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dateScrubActions.js\":\"85c2fa6affbd2bd0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dateScrubGesture.js\":\"161ccebd9ae67446\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dateScrubGestureActions.js\":\"94834d373e91921a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a1d56e9a44c68d57\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/deletionGuard.js\":\"4d65cc350319d7ba\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/dueQuery.js\":\"277e694dde2590cb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/index.js\":\"21e3449caa295927\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/landing.js\":\"e6d09340c1a7f72e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/localSchema.js\":\"41f9cf8f6b06a3c5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/referenceDateAdapter.js\":\"96458fd25c7dbe99\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/rescheduleAction.js\":\"464eb1b41b64f3c3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/schema.js\":\"7e432e93bff3681f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/spreadBlockDates.js\":\"d8573a2339a7208a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/spreadDatesAction.js\":\"d1f36aebd9ca90c1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/today.js\":\"f4af36c2027194b9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"24df73c3875970c2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"090a4e9a6c245a38\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/audit.js\":\"8cee6d707afae2ee\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/auditAction.js\":\"1ffba51374059a1b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/auditRanges.js\":\"cff23206e8f3dbbe\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/diagnosticsSource.js\":\"4b862ecdbcd970b9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/divergenceScan.js\":\"9141ee7bf3ca53e8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/index.js\":\"329da3fdf6558e6c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/propertyChildrenChecks.js\":\"34f44b8dc6027134\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/referencesMirror.js\":\"b126851e1f957f02\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/rowJson.js\":\"f3d346b09ec512c1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/schedule.js\":\"1053f2441227988c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/data-integrity/store.js\":\"ce15f6421a44de08\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-maintenance/action.js\":\"671e44a33db09139\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-maintenance/index.js\":\"d61abd70ab58ace9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-maintenance/plugin.js\":\"714fb4fec13c8061\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e5f1fb17e4b46fa1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/actions.js\":\"1d12338c3750a78e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/changeMarker.js\":\"8993e621057c45b9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/diagnostics.js\":\"d4dc2e2b9cf77227\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/fileSystemAccess.js\":\"4112f1bf2f5e636f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/filenames.js\":\"59205476f85b18c2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/index.js\":\"0c3f830a2999acf7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/mirror.js\":\"26880d3c6becf85f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/runLock.js\":\"0dcb4ed05eb5dd91\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/runtimeHealth.js\":\"4922c06675165b67\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/schedule.js\":\"8617d9821a515d53\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/db-mirror/store.js\":\"e5905682d4d82a29\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/default-themes/index.js\":\"d396119061d5c203\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/default-themes/themes.js\":\"f63c36c569a782c5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/diagnostics/facet.js\":\"5bf0519adbf8b355\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/diagnostics/useDiagnostics.js\":\"2f44b5ae63f936a9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extension-prompts/dismissals.js\":\"ba2525fc8a3ddf74\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extension-prompts/index.js\":\"78c2a3256d782522\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extension-prompts/status.js\":\"d9e4cdb82935dd26\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extension-prompts/store.js\":\"416552f2c23eac10\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1e16970033c10c39\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/ExtensionsSettings.js\":\"6b8e03eefd9848d1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/actions.js\":\"579855f8299ea854\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/config.js\":\"b60187af25497880\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/dataExtension.js\":\"a8149490ad34b7a3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/effect.js\":\"6faa0a782ad5881c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/index.js\":\"5f75fcd16c340244\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a69baf21d71c52c2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extensions-settings/useToggleTree.js\":\"270ad9c5e0c6c406\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/ExtractTypeDialog.js\":\"a83e806ae88103ce\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"57253961419a7c41\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/PropertyShapePicker.js\":\"d094fe8e2f86cee8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/action.js\":\"c98b406a108fc3cf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/extract-type/index.js\":\"4335bdb71061420d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/FindReplaceDialog.js\":\"2186bc0b780e6d6c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/HeaderItem.js\":\"c3d3fca8774d3624\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/dataExtension.js\":\"9160bf52efe50cb2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/index.js\":\"04e09e2e5e3fdf8f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/search.js\":\"787372b1c91607d7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/toggleStore.js\":\"492110ddee1f54f7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/LocationPropertyEditor.js\":\"81fa29962a992afd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/MapView.js\":\"9bdc1fc6da2a3d90\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/blockTypes.js\":\"6990541d08db4498\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/codeMirrorExtensions.js\":\"b16a9915890fa87a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/createOrFindPlace.js\":\"368135bd111880d0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/currentLocation.js\":\"cf90bd159f8f5e82\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/dataExtension.js\":\"1084cf503b7e6c3b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/geoContentDecorator.js\":\"fe018ec3bc5073d9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/googlePlacesClient.js\":\"a0d52dc361c5b2b4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/index.js\":\"824a04dbfa4120bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/locationsPage.js\":\"a523ce9379b0b455\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/mapViewport.js\":\"3363a4281ca4e0cb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/pickCurrentLocation.js\":\"496b3efeaec97ad3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/placeAutocomplete.js\":\"6d4c2e861ea065cc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/placeNameCollision.js\":\"c2608b3f7dd51936\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/properties.js\":\"d6687ee252736f70\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/propertyEditorOverrides.js\":\"7e9d9043d840e018\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/query.js\":\"1bf22c8a6107987a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/geo/usePlaceSearch.js\":\"6b0f35370e71c2e4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"faf9df268a886d7d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"44bea7e0d1fc20bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"017a664bbac4c4c3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/config.js\":\"992eced079151b50\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/dataExtension.js\":\"5c6012018483f2f1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/facet.js\":\"9e28585d1e919474\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/grouping.js\":\"31397a7622434b3a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/index.js\":\"8e86ba240aa021d4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b41d4960a4022dcc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/query.js\":\"5ff1d0247da972d9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/resolveConfig.js\":\"71af674b6c934b30\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"aba309f34b7684c5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"97ac7f59e3aea8c4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/HtmlDocumentContent.js\":\"55e7eea2a364b754\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/HtmlFrame.js\":\"1671a0e6b73192b3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/actions.js\":\"07fa882678a916b7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/blockType.js\":\"abda1086d7b93c0e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/confirmRunScripts.js\":\"9d8f0d038871d514\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/dataExtension.js\":\"af2165e4d9c89712\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/frameAnnotations.js\":\"de2cb51a1ad11dc5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/frameDocument.js\":\"1f2e1a13aa056ec1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/frameTheme.js\":\"d29b07423e244341\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/index.js\":\"d3a3666855b29ac1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/scriptConsent.js\":\"6f38ae067f57ddb6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/sourceMap.js\":\"2493488d1e62b1c2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/html-document/useDocumentScripts.js\":\"bf66b27ebffead72\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/index.js\":\"9be5ebe54317481c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/record.js\":\"8c46113dfaf9cb66\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/recordStore.js\":\"8daf53080926de6a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/responsiveness.js\":\"a0c636ca0fe78049\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/schedule.js\":\"78d13d2254f94818\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/interaction-metrics/sessionContext.js\":\"b54228994ec8a7bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"dc63a1e92e022f8e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d0371b956803dd1e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/actions.js\":\"f699b3cfb1bab015\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/config.js\":\"05e288184ed67e7d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/dataExtension.js\":\"db81bbf0c306d88a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/effect.js\":\"0ebbce6891a5551e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/index.js\":\"1afc5d335e55c555\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/keyCapture.js\":\"d4774ab235cf80fb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/overrideStore.js\":\"050804cb3b127aa9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"46fa2feaf9bb0ea6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/HeaderItem.js\":\"4c2abf2bf6c8cfa0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/LeftSidebar.js\":\"ba414437ebd031ba\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/actions.js\":\"87d5c4df10385539\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/facet.js\":\"3881e0e2e652926c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/index.js\":\"ef03f026d9984fa8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/shortcuts.js\":\"d6688115982850e7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/left-sidebar/toggleStore.js\":\"468d137dbac92a18\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/merge-blocks/MergePicker.js\":\"30cc8f4e8ae15e9f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/merge-blocks/index.js\":\"0e51d3748cadbe28\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/merge-blocks/mergeAction.js\":\"2ceebe5dd15a4104\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/merge-blocks/strategy.js\":\"8d75a0e7dbc8033f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/Button.js\":\"9c22745eb7023d06\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b94e9fad8e91e62a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f86d6f5631fa6a98\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/facet.js\":\"358bc06f2abc5b58\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-bottom-nav/index.js\":\"fc425d04c38ca177\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a267a5ab5c3f5678\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2e44e2b9811ecf33\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1785165d4539c288\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/facet.js\":\"49bafd2b6f438652\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/mobile-keyboard-toolbar/index.js\":\"931197d8b289f316\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2bbceb32d3bc030b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5bb8050842017422\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/contextMenuItem.js\":\"2aeb512805bcaa66\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/index.js\":\"c6314076e4ea892a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/moveAction.js\":\"5da271123e9e75dd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/moveBlocks.js\":\"debf9d27427f89ae\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/move-blocks/selectionAfterMove.js\":\"0ab04a853ae2b992\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/TutorialBanner.js\":\"dfe15acf7ab500d9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/action.js\":\"f269727bc2431ac0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/bannerDismissal.js\":\"23fa256faa7a5478\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/documents/cheatSheet.js\":\"8a9310a78b3ddc4d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/index.js\":\"43e49de0205cf17f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/keys.js\":\"2de233d1b80c4327\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/landing.js\":\"73a9cbfd45fc86dd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/outline.js\":\"8c90fc0052f4dfee\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/onboarding/seed.js\":\"04a8a563c9daebca\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c3bae6d847b7914d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/analyze.js\":\"d40630e290570717\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/diagnosticsSource.js\":\"0545b0de7d211fcf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/index.js\":\"50a7701653ece035\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/load.js\":\"96b14a7120f022f3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/monitorRun.js\":\"5194a3f48aac6bf2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/schedule.js\":\"fedb98296c3daa6c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/series.js\":\"29e72607f46e4572\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/store.js\":\"e19664a9ab86e34f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/trendAction.js\":\"fdae92cd7aee050d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/perf-monitor/verdict.js\":\"0d51f956e808e4bc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/plain-outliner/clickToEditAction.js\":\"29a3fc7ebe40468b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/plain-outliner/index.js\":\"c5887ac9d2ba48cd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/plain-outliner/interactions.js\":\"4f5fb37ddb1315ec\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"fa9533643ab4a2d7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/MigrationGate.js\":\"fb270816440a11f7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/MigrationGateDialog.js\":\"b3b8be910776aa82\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/action.js\":\"157405958dc042ab\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/index.js\":\"e5939b15e140d5f1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/localRunMessage.js\":\"b13ba147b4c3663d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/plugin.js\":\"4ab1be39d9ce5af1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/progressReport.js\":\"f7a8045e240adf69\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/properties-migration/sweepProgress.js\":\"f6deb024ab6c5620\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/FieldRowRenderer.js\":\"eb48049eb6972577\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/ValueRowRenderer.js\":\"384634d43ce6b64a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/actions.js\":\"0a7c9e22366b6916\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/autocomplete.js\":\"96d0b3ad9d961f94\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/fieldRow.js\":\"41584f585be361f4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/index.js\":\"85b261742240b124\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/referenceWarning.js\":\"368a364cb686dfa5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/valueAutocomplete.js\":\"7276288d4b1759de\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/property-rows/valueSchema.js\":\"c83ab68bc0adc385\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/HeaderItem.js\":\"8616bbcc6153b96b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/QuickFind.js\":\"46f5b392cf569219\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/index.js\":\"f2828fa5f86c7ab5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/recents.js\":\"f1f8d83983dd8538\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/resultItems.js\":\"de1057182d8e72b4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/selection.js\":\"49b421257a459601\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/quick-find/toggleStore.js\":\"eaad3fe05085243a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/HeaderItem.js\":\"3b6f83cb01741608\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a2cbaafb3689ced8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/grouping.js\":\"71b1a433fd1ad86c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/index.js\":\"6a9d99f1c23278ea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/recents/target.js\":\"a75a0bf5038646c6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/codeMirrorExtensions.js\":\"2f8eac756db991a3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/contentPrefill.js\":\"ac30af80c1b9a46d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/dataExtension.js\":\"c1cc932877f78465\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/index.js\":\"6d58fb5ab6815083\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"40d2489d96072001\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/invalidation.js\":\"87b446bc147fa019\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/localSchema.js\":\"5dc73b98b061469c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/blockrefs/index.js\":\"ee398d5614216085\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f29346b28ed75975\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/index.js\":\"e182e4e9e9b27f64\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/referenceNode.js\":\"0d7b18eb0ab3cbbe\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/remark-reference-occurrences.js\":\"435b508f1251142f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"705c3c37bf766d6c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/wikilinks/index.js\":\"ade1b650a9e6e55c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c6b4513fc3537718\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ace409cdea875b38\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/mergeRetargetProcessor.js\":\"1f3e5ddd3c6096db\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/parseFence.js\":\"d8df32c01fafee6a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/referenceParser.js\":\"d171c3c29e64299c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/referenceProjection.js\":\"0242e186010ebe62\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/referencesProcessor.js\":\"679804ad4f063f36\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/renameProcessor.js\":\"08a21e0f74b75e84\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/references/spanReplacement.js\":\"b9978e1fa1d4f8ff\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/rich-paste/htmlToOutline.js\":\"57188556d68b8518\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/rich-paste/index.js\":\"473f9525e943594b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b41a5f47edbe4979\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/rich-paste/pasteDecision.js\":\"69e9339d1a2fe705\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/action.js\":\"ad18805f431399f9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/blockIds.js\":\"c4226c42d7e811d9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/content.js\":\"e123d1891ba6c8f9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/effect.js\":\"2183fe899f424d8c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/ids.js\":\"79ef548b51d064d1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/import.js\":\"7f4d0c5fd7df40db\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/index.js\":\"9f5c9abcf6332773\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/plan.js\":\"feb7615b6fb1b137\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/plugin.js\":\"c73254796e578ce2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/promotion.js\":\"e63bf21e8c40efac\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/properties.js\":\"5cafbc7c3431446e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/references.js\":\"73f91f45af3a3b99\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/report.js\":\"a9fb75b8de792101\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/roamMemo.js\":\"2665079de06e1aa6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/runtime.js\":\"7efe7abfc3041f56\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/schemaReconciliation.js\":\"06e9b6e2d6395c68\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/srsMarkers.js\":\"fb7739e7fe178f56\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/todo.js\":\"f220095f1c2701f3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/typeCandidates.js\":\"5fec4effaafe62d9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/roam-import/types.js\":\"828e338729cf4380\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/search-health/index.js\":\"ed91e30111673de0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/search-health/store.js\":\"8d20336a2bbf31a7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/HeaderItem.js\":\"3bb6e9a912be82b0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7cd81be3711fc08c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/index.js\":\"82f0c5105760efe3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/model.js\":\"a7a5713f09cf98c5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/toggleStore.js\":\"1ff03873072dc0ea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/shortcut-help/useKeyInspector.js\":\"999b7797803e4165\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"38aa52f155144647\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/ShellDecorator.js\":\"ded0f314ab45c9aa\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/actions.js\":\"d63995c91e564e76\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/exclusionsFacet.js\":\"614c7fa519840917\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/index.js\":\"3b9673f8e014e9d3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/shell.js\":\"96b4dca9d8024211\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/surface.js\":\"5ca6318de4305a25\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/spatial-navigation/walker.js\":\"c8a6e95246b04486\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/RescheduleToast.js\":\"32c743e3a30acf8d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/dataExtension.js\":\"a445e6e281925720\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/index.js\":\"2ff23d3aade6c084\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/indicator.js\":\"fa0567a51f4e993b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/moveSrsState.js\":\"0a435d7988b4206b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"18fc762a462ceef9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/scheduler.js\":\"a9a72d4ce5e556bb\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/schema.js\":\"b20a248145a8a0cd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e5a565c31192a94b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/srsClipboard.js\":\"fa040eb42a9f7561\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"07bfddeb1767a465\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/DailyNoteReviewHint.js\":\"df9de8c4457d9cea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/DeckPicker.js\":\"6bb4108f90a9de29\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/ReviewControls.js\":\"2b78378f7e922c6a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/ReviewDeckRenderer.js\":\"46468b46d89f30e1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/ReviewSession.js\":\"0c993aa7b5468e81\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/actions.js\":\"39f64f609d0f507b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/archive.js\":\"259ded682fbe0835\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/dataExtension.js\":\"3039c7bbab66a17a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/deck.js\":\"ee4dd7d8d7e45b91\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/dueQuery.js\":\"6059eeca9f1c844b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/gradeDecision.js\":\"99719fb2636920ed\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/index.js\":\"1a37928c47b7ecf8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/keyHints.js\":\"0c0ed2ed75dea066\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/reviewCardLayout.js\":\"028b0166bd9e9bcf\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/reviewProgress.js\":\"472401778d9b75c7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/schema.js\":\"34ebbf683953794c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/srs-review/useDueCards.js\":\"a06e135ea69f0eea\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/startup-metrics/index.js\":\"0e01aa40daad1378\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/startup-metrics/record.js\":\"8f347dd8f0dc8fe3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/storage-persistence/index.js\":\"79748b52024394fc\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/storage-persistence/persistenceStatus.js\":\"c85299db517fc933\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/storage-persistence/requestAction.js\":\"fabf336c31961b0b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/supertags/TypeChipsDecorator.js\":\"ea7903c0306d80f9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/supertags/codeMirrorExtensions.js\":\"293a770e8f7a2700\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/supertags/index.js\":\"c0dd3962539fff18\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/supertags/typeAutocomplete.js\":\"49487032509d8048\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"200155985e0a8579\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/actions.js\":\"2b824823cf83937c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/anchor.js\":\"c609b09be1229e51\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/events.js\":\"71ec7082611040e2\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/gestureActions.js\":\"c67eb92ed134c2fe\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/index.js\":\"d7e53728ae7485ec\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9083de114d3f45f3\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/sync-metrics/collect.js\":\"cd826ad1e7b9c656\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/sync-metrics/index.js\":\"0fda91e6685d0fd8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/sync-metrics/record.js\":\"540ef3e8057897f1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/RejectionDialog.js\":\"797b5e43bbbded98\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1aae932cc949c019\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/index.js\":\"4a60b09e249ce72a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/model.js\":\"4590b05c676eb8f7\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/queueCounts.js\":\"f67f6d6e54d0e169\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/rejectedHelpers.js\":\"971eba7ddf5f6a62\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/rematerializeAction.js\":\"c8ca492d8a45346d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/system-status/useHysteresis.js\":\"5125c6ef5a91c399\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/TableLayout.js\":\"8b48c2a8706c4908\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/actions.js\":\"7bb29158c271cd74\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/cellEdits.js\":\"4c61ed732136db7e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/controller.js\":\"cf94c68897139fde\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/convert.js\":\"aff451871a827085\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/dataExtension.js\":\"7920d8fdba237f2d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/index.js\":\"bbc12817226be1b8\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/keys.js\":\"05c78e1dc8d42684\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/model.js\":\"6ff7f3f1f2da1430\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/registry.js\":\"bdd307a270f92b3a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/tables/schema.js\":\"00ee95570d1ce49f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/theme-toggle/effect.js\":\"1bf514d198be6281\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/theme-toggle/index.js\":\"f3a2809206208534\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/theme-toggle/theme.js\":\"c054baaf9897db92\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/todo/actions.js\":\"798a1797cbd3f4f9\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/todo/dataExtension.js\":\"0a5f59bdb3796267\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/todo/index.js\":\"f735d75ea222e565\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/todo/schema.js\":\"a1994ccf9318d7e4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8997a4c78c8e9615\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/actions.js\":\"38c06ad9f2f652dd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/defaultItems.js\":\"1745525c48397ff5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/facet.js\":\"53075ab7e156bcec\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/holdRecognizer.js\":\"46dc0b4e93645aef\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/touch-selection/index.js\":\"52b6ffc5a8bf505b\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/update-indicator/UpdateIndicator.js\":\"96560266d72afea6\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/update-indicator/index.js\":\"4929b9608241d264\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/update-indicator/loadTimes.js\":\"cad82e6164374399\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/VideoNotesRenderer.js\":\"2e031b678033526e\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/VideoPlayerRenderer.js\":\"5616f3e5865bc61f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/VideoTimeStamp.js\":\"97af71d4af356fb5\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/actions.js\":\"b8d4b29b653d5355\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/index.js\":\"1a1bc635f127c3dd\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/markdown.js\":\"25489062a373388d\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/notes.js\":\"2565a716cc9a7d06\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/registry.js\":\"da0fc4556f4a542a\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/remark-timestamps.js\":\"de39295bf6b976f1\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/video-player/view.js\":\"b0d2d99eedf05b5f\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-link-hints/LinkHints.js\":\"ea3c97decda752a0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-link-hints/index.js\":\"3b6cc8f211be2d4c\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-link-hints/model.js\":\"b58c42b31cdc5c04\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-link-hints/settings.js\":\"8f1e0c5cffe52989\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-normal-mode/actions.js\":\"55e1482184cf3c53\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-normal-mode/index.js\":\"721e6eb2172440e4\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/vim-normal-mode/interactions.js\":\"eb98bdd171a024e0\",\"/knowledge-medium/pr-preview/pr-1821/src/plugins/workspace-header/index.js\":\"177a7ebe180183d7\",\"/knowledge-medium/pr-preview/pr-1821/src/registerServiceWorker.js\":\"107ac7df26704bae\",\"/knowledge-medium/pr-preview/pr-1821/src/requestPersistentStorage.js\":\"d5cb35e0f04ac249\",\"/knowledge-medium/pr-preview/pr-1821/src/services/authRequestDeadline.js\":\"c968a62264de159b\",\"/knowledge-medium/pr-preview/pr-1821/src/services/authStorage.js\":\"5395ecc3c8874007\",\"/knowledge-medium/pr-preview/pr-1821/src/services/powersync.js\":\"5e862ac21354efa8\",\"/knowledge-medium/pr-preview/pr-1821/src/services/supabase.js\":\"a57199f7920f6edd\",\"/knowledge-medium/pr-preview/pr-1821/src/services/uploadErrorClassifier.js\":\"dfa12ae2fd9fb905\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/ActiveContexts.js\":\"4066452e7aac2bb9\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/HotkeyReconciler.js\":\"93a2983feb1fe6d1\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/WipeLocalDataDialog.js\":\"f50344c29b360439\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/actionDispatch.js\":\"65d2303e36436a5c\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/actionRefItems.js\":\"da81747d620f4b5a\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/applyKeybindingOverrides.js\":\"f641f7b517bfbb85\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/blockActions.js\":\"c576439fffa0bc94\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/canonicalizeChord.js\":\"7df0e9559b9ccf5a\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/defaultContexts.js\":\"ed00d2feeeb020ee\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/defaultShortcuts.js\":\"f268890639ee5ba2\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/effectiveActions.js\":\"282e25be01cdc7ce\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/gestureAction.js\":\"547325ad7ffc3330\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/gestureBinding.js\":\"526097c1372aa489\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/holdRegistry.js\":\"3959241c74576d60\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/keybindingConflicts.js\":\"b93f276639210708\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/keybindingOverrides.js\":\"7073e1cfd10816b7\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/pointerAction.js\":\"1f254ce2e4d14239\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/resolve.js\":\"dd8f973b882bf588\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/runAction.js\":\"ad50776d7d45794e\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/sequenceMatcher.js\":\"6de8b7a0e0b5fce3\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/types.js\":\"68251a0f77afc98a\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/useActionContext.js\":\"72534eebb585626a\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/useActionDiscovery.js\":\"1ab377d5c02b1b79\",\"/knowledge-medium/pr-preview/pr-1821/src/shortcuts/utils.js\":\"962fe8c7a27d4707\",\"/knowledge-medium/pr-preview/pr-1821/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1821/src/sw/bootStore.js\":\"aeaf13652d9690e2\",\"/knowledge-medium/pr-preview/pr-1821/src/sw/previewDatabases.js\":\"2154dd1348a82c99\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/byteTransform.js\":\"068b2f1d9a8b5345\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/attachmentCleaner.js\":\"9c015dabfd6f7dc0\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/attachmentParts.js\":\"c526e54bd697c40c\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/bundleParts.js\":\"98463ade102e8c85\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/bundleRecord.js\":\"a7610b8b22fc064c\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/manifest.js\":\"492742be07887cf9\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/takeBundle.js\":\"89630b987be68584\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/bundle/verifyBundle.js\":\"7700123c6ba72e2a\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/cleaningStage.js\":\"c15eba1597c9b047\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/conversionKey.js\":\"3469c50757157277\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/conversionServer.js\":\"25362903ac7098c3\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/flip.js\":\"9cb19ff47929f05a\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/flipAttempts.js\":\"ff625887702f5bfb\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/pages.js\":\"81a147b921829453\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/preflight.js\":\"c157a5bfd9914494\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/reseal.js\":\"2a97caa027674f49\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/runConversion.js\":\"a8366c43bcd5b15d\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/runLock.js\":\"45bfd4b0f0b848c1\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/sealing.js\":\"5614cb9a05feda67\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/sealingStage.js\":\"dbd6070e88f1ff40\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/stage.js\":\"af21310a5711e631\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/conversion/verifyReseal.js\":\"5d5b52fa68bd81ba\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/aad.js\":\"2691414c5379b3d5\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/aead.js\":\"2e94ef9b66b90c33\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/base32.js\":\"6ccafe580140ce5a\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/base64url.js\":\"6a068f827626bbed\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/binaryEnvelope.js\":\"b4a487a792fc4199\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/byteAead.js\":\"0e92776514428e35\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/canary.js\":\"e1aaf5ecca4069af\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/contentHash.js\":\"dcef3288243f93cd\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/contentKey.js\":\"425126cdd8216ac4\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/derivedIdNamespace.js\":\"603a9d298b65e777\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/envelope.js\":\"0791f6df101a90ee\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/hex.js\":\"b449149fef3bb4eb\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/sha256Hex.js\":\"22d047e206f0e55e\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/crypto/workspaceKey.js\":\"802001c98b384561\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/conversionState.js\":\"50f3eb8368cdc62b\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/flows/createEncryptedWorkspace.js\":\"8d5342793dc9b7c8\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/flows/pastedKey.js\":\"f824fa91f7515b80\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"caddc081433975fd\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0c261077a8ee2911\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/keyStore.js\":\"46a34d914042c7a8\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/mintWorkspaceKey.js\":\"4f0fd9edd97f8a91\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/modePin.js\":\"55ab0a7f7b23168e\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/openWorkspaceKeys.js\":\"a5662579690874e6\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/resolveWorkspaceEntry.js\":\"080a06a640c6c0b8\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/resolver.js\":\"db442610cc3b13c2\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/keys/workspaceAccess.js\":\"01b479a991ee9de7\",\"/knowledge-medium/pr-preview/pr-1821/src/sync/transform.js\":\"b371474f6051c46e\",\"/knowledge-medium/pr-preview/pr-1821/src/themeBootDefaults.js\":\"c46949abe3479173\",\"/knowledge-medium/pr-preview/pr-1821/src/types.js\":\"8fab510d28bc9678\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/ClientLocalSettings.js\":\"f24a2e242a49dc1a\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/abortableSleep.js\":\"fd8ee557c91bef24\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/array.js\":\"ca7b7de14109a4f6\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/backlinkAutocomplete.js\":\"823d1a625a0e4b85\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/blockCrumbs.js\":\"bf040ae2ef14e4e8\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/blockrefAutocomplete.js\":\"751c15610b981cb1\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/cadencedIdleJob.js\":\"6218fcd0660fb046\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/callbackSet.js\":\"75111dde4b652250\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/clientId.js\":\"5c6fd55fe22f8398\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/codemirror.js\":\"d4c80369c52397c2\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/codemirrorCompletion.js\":\"cfdb8ccc1709cfb1\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/copy.js\":\"e6aa20ab624f2770\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dailyPage.js\":\"ee5b97938f1ee3a0\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dbForensics.js\":\"29ebc3bb94d5cfbc\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dbForensicsHooks.js\":\"a5131d2023e95a0b\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/deleteBlockThroughUi.js\":\"f4760c0db7bd4831\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dialogs.js\":\"938bc93a7674e088\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/dom.js\":\"db429fafa71dbdf3\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/downloadBlob.js\":\"4102d2c49e85d23e\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/exportSqliteDb.js\":\"b59345855d4d32c2\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/fileSystemAccess.js\":\"fb01bf1708f65df6\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/flipSlide.js\":\"66b84110edbe05b4\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/fnv1a.js\":\"0ebcf7e821a1b7d3\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/formatBytes.js\":\"38673cf951ba365c\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/fuzzyRank.js\":\"71aea8be92f862bd\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/idbKeyedStore.js\":\"fb52c151729dc8ab\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/idleCallbackPolyfill.js\":\"307f546d76477e66\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/keyboardAwareScroll.js\":\"1950d0c453b2320a\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/keyboardViewport.js\":\"3f47c6b05e96d323\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/lastWorkspace.js\":\"0f27fff16b2528af\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/layoutColumns.js\":\"a2dcaf6a8e3d9d26\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/layoutSessionDom.js\":\"f4ca4b86cd2e422c\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/layoutSessionId.js\":\"edad8b0032fddc88\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/linkClickGestures.js\":\"ef8f09aac8490af2\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/linkTargetAutocomplete.js\":\"51992ffb49f0336f\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/localDbCorruption.js\":\"1617d4d18aa87331\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/localDbRecovery.js\":\"823bd6d43c5c5e36\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/markdownParser.js\":\"b5ca708081b7e934\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/memoize.js\":\"90925bd795751821\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/nameFieldCommit.js\":\"ad04affd613ac67c\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/nameList.js\":\"d0a51f17764aa669\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/navigation.js\":\"2e7856acdd816de4\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/omnilinerNamespace.js\":\"37ef31522a917bf3\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/opfsPageScan.js\":\"f14aa4c6aad6e722\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelClearance.js\":\"9a7bdfc6d58a7f44\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelHistory.js\":\"113cba06511990a6\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelLanes.js\":\"43dd2c65cf19d4d3\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelLayoutProjection.js\":\"1a72158f9afc2ff9\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelScrollAnchor.js\":\"ce87733e70679cda\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/panelUrlFlags.js\":\"2b19599602d76d0e\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/platform.js\":\"271bbfda8b7eeb67\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/pluralize.js\":\"65b13ad5b5757b9f\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/propertyCreation.js\":\"6fff5a6ba29f564a\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/propertyNavigation.js\":\"3f72f68646a8efaf\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/propertyValueContext.js\":\"a4aca8095b301b47\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/react.js\":\"2a2520fc38ae2964\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/relativeDate.js\":\"5925ed92b94486d9\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/relativeTime.js\":\"cbc295c4fafe2450\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/renderScope.js\":\"6c9b89e5416c7fc2\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/resolvedThenable.js\":\"93913ee00d0ecae1\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/routing.js\":\"bdbbe27568f67084\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/safeMode.js\":\"c5b28f0409e02b2a\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/scheduleIdle.js\":\"d6db864d82631a16\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/screenWakeLock.js\":\"636b60852fe67acf\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/selection.js\":\"fde001b48ce36df7\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/softKeyboardGrab.js\":\"51e47947da0b51fa\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/startupTimeline.js\":\"e0adc8527551e958\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/state.js\":\"9e53f79cdc707f28\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/string.js\":\"3206d368aebdba19\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/surfaceZoom.js\":\"b11d3b217fd54445\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/time.js\":\"67db96ad80ed67c8\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/toast.js\":\"2f20d9b5471abb59\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/toggleStore.js\":\"741513207a9792f2\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/untilStopped.js\":\"aff820014161831f\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/userActivity.js\":\"2a9dc5ad6846e163\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/viewTransition.js\":\"f54aa38b3085c150\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/viewport.js\":\"722f14a59347ff28\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/webLock.js\":\"f10d4c4dafe3e27d\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/workspaceRecovery.js\":\"34c50da0fa4d633a\",\"/knowledge-medium/pr-preview/pr-1821/src/utils/workspaceSnapshotStore.js\":\"1024cb86dacec69c\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-compiler-runtime.js\":\"801a5c2d0eb9ca2e\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-client.js\":\"fac6c13a380369e8\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-server-edge.js\":\"f7553ab27848a576\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-server.js\":\"72fea947666c70df\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-static-edge.js\":\"e108ea7ac34bffde\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-static.js\":\"f2d6bd3d7bed0d32\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom-test-utils.js\":\"48fefdba77c821d4\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-dom.js\":\"adbe46aaa28a64af\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react-jsx-runtime.js\":\"680e2e98961ceb4f\",\"/knowledge-medium/pr-preview/pr-1821/src/vendor/react.js\":\"b5a318ac242c1e81\",\"/knowledge-medium/pr-preview/pr-1821/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1821/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1821/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
