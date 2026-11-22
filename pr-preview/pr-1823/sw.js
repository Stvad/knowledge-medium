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
		buildId: "dc80efb396dc-9f63ac70",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1823/\":\"e9c85aafb768cc2f\",\"/knowledge-medium/pr-preview/pr-1823/index.html\":\"e9c85aafb768cc2f\",\"/knowledge-medium/pr-preview/pr-1823/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1823/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1823/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1823/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1823/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1823/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1823/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1823/assets/FacadeVFS-Btz-6p8i.js\":\"a0c583371d48a175\",\"/knowledge-medium/pr-preview/pr-1823/assets/OPFSCoopSyncVFS-DUw0y-UP.js\":\"25f864219763d3b6\",\"/knowledge-medium/pr-preview/pr-1823/assets/OPFSWriteAheadVFS-BtupVR7y.js\":\"6dc95b117430c41f\",\"/knowledge-medium/pr-preview/pr-1823/assets/wa-sqlite-C19BIbSC.js\":\"225fe3a51a00780f\",\"/knowledge-medium/pr-preview/pr-1823/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1823/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1823/assets/wa-sqlite-async-N7tb8pvV.js\":\"5c76380783025b16\",\"/knowledge-medium/pr-preview/pr-1823/assets/worker-BpLIrH31.js\":\"d87fa0010f4686f3\",\"/knowledge-medium/pr-preview/pr-1823/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1823/chunks/app-BKQtxhN5.js\":\"37ab9cd37f5ffcb2\",\"/knowledge-medium/pr-preview/pr-1823/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1823/index.js\":\"b22c9c3e9838b2a3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1823/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1823/assets/AccessHandlePoolVFS-Uoc1kUdw.js\":\"192935f15f63beb1\",\"/knowledge-medium/pr-preview/pr-1823/assets/IDBBatchAtomicVFS-DUXl34Gw.js\":\"4403a5742901879f\",\"/knowledge-medium/pr-preview/pr-1823/assets/MemoryVFS-BrJIxMSW.js\":\"add2d1e266895373\",\"/knowledge-medium/pr-preview/pr-1823/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1823/assets/mc-wa-sqlite-async-Cre0aYEf.js\":\"ca79e25c17bde29e\",\"/knowledge-medium/pr-preview/pr-1823/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1823/assets/mc-wa-sqlite-crlruqqX.js\":\"067901cc43e09add\",\"/knowledge-medium/pr-preview/pr-1823/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1823/chunks/AccessHandlePoolVFS-D-f9-GsW.js\":\"71a4d99073708f80\",\"/knowledge-medium/pr-preview/pr-1823/chunks/FacadeVFS-y8ov-IQT.js\":\"b8b5a835c05fba96\",\"/knowledge-medium/pr-preview/pr-1823/chunks/IDBBatchAtomicVFS-goUKgcRp.js\":\"7adce8f61b6dfd8a\",\"/knowledge-medium/pr-preview/pr-1823/chunks/MemoryVFS-Bj5lQwVc.js\":\"438a9694aae17c4c\",\"/knowledge-medium/pr-preview/pr-1823/chunks/OPFSCoopSyncVFS-D8m748Q3.js\":\"6f57e6e9cd788aef\",\"/knowledge-medium/pr-preview/pr-1823/chunks/OPFSWriteAheadVFS-CE1BgrXn.js\":\"d5926335d4c86ebb\",\"/knowledge-medium/pr-preview/pr-1823/chunks/Preview-DBBfAs4S.js\":\"8de417add32408ed\",\"/knowledge-medium/pr-preview/pr-1823/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1823/chunks/card-DIRvECU7.js\":\"e627a2f668c5d8ba\",\"/knowledge-medium/pr-preview/pr-1823/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1823/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1823/chunks/dist-BSOaQhgb.js\":\"08c26648cecb8da6\",\"/knowledge-medium/pr-preview/pr-1823/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1823/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1823/chunks/mc-wa-sqlite-async-BTVjfCX8.js\":\"03e6c916dccf615b\",\"/knowledge-medium/pr-preview/pr-1823/chunks/mc-wa-sqlite-q09ZdOVX.js\":\"1039f0edafd92f1e\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-9QC0p7aF.js\":\"012f292264a56896\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-B9jhgjXN.js\":\"72bf46ba38434a85\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-C9Szh5Bj.js\":\"a1df40ff387f3305\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-CH79q7PB.js\":\"55a0541e0de88fc4\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-DTPEW8H_.js\":\"be6d25a1f9c498c9\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-DbFhOyhu.js\":\"b226c52ccf765590\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-dom-server-legacy.browser.production-dnpY0VWa.js\":\"57ffc5cee10f8dee\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-dom-server.browser.production-qDNWPo-G.js\":\"ca3fe1320264ee2e\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-dom-server.edge.production-B2asS2c2.js\":\"f47f864f184ca16f\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-r5TBWBqT.js\":\"6468dd0ee277e8a3\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-vCtSftKj.js\":\"634a620d3bf45095\",\"/knowledge-medium/pr-preview/pr-1823/chunks/server.browser-Ba51VRUv.js\":\"3b857cb07b462936\",\"/knowledge-medium/pr-preview/pr-1823/chunks/textarea-l8QijCru.js\":\"eb51b0194db8fbcf\",\"/knowledge-medium/pr-preview/pr-1823/chunks/ui-DTymrVwl.js\":\"8a4533ab3cc00777\",\"/knowledge-medium/pr-preview/pr-1823/chunks/wa-sqlite-DJJnvzDG.js\":\"96f58726b58333e5\",\"/knowledge-medium/pr-preview/pr-1823/chunks/wa-sqlite-async-BPnE8rRT.js\":\"c2a944475e3e8d6e\",\"/knowledge-medium/pr-preview/pr-1823/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1823/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1823/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1823/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1823/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1823/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1823/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1823/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1823/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1823/src/App.js\":\"4a6e958670d33101\",\"/knowledge-medium/pr-preview/pr-1823/src/appUpdate.js\":\"26fef0f61cf34dfc\",\"/knowledge-medium/pr-preview/pr-1823/src/appVersion.js\":\"9146aa0ec02af948\",\"/knowledge-medium/pr-preview/pr-1823/src/bootstrap/initialLayout.js\":\"06134ee5ce808836\",\"/knowledge-medium/pr-preview/pr-1823/src/bootstrap/openWorkspaceData.js\":\"53c8160ec06cdf1b\",\"/knowledge-medium/pr-preview/pr-1823/src/bootstrap/resolveWorkspace.js\":\"24f5ee3f55fbaec9\",\"/knowledge-medium/pr-preview/pr-1823/src/bootstrap/workspaceBootstrap.js\":\"f90ea0f2011ab375\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockComponent.js\":\"8dd7a3e359f1d7b0\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockCrumbs.js\":\"ba9a1409d50bb454\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockEditor.js\":\"f9f9c8a29689dde8\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockLoadingPlaceholder.js\":\"9e8d02b8ba498f7c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockProperties.js\":\"82cbf09fa8aaaed0\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockSearchPicker.js\":\"dddc2b19152c9369\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ConfirmBulkDeleteDialog.js\":\"5a02d68814c8a280\",\"/knowledge-medium/pr-preview/pr-1823/src/components/DividerHandle.js\":\"602d209ab96599fe\",\"/knowledge-medium/pr-preview/pr-1823/src/components/DraftEditor.js\":\"9c89c4993591fcf5\",\"/knowledge-medium/pr-preview/pr-1823/src/components/GutterPill.js\":\"e77995af8d6bf1f9\",\"/knowledge-medium/pr-preview/pr-1823/src/components/Header.js\":\"4bcee1cf875abd73\",\"/knowledge-medium/pr-preview/pr-1823/src/components/LazyBlockComponent.js\":\"6a73d2de7a175fc5\",\"/knowledge-medium/pr-preview/pr-1823/src/components/Login.js\":\"e9bff921c7eb6cb4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ZoomableSurface.js\":\"253472ebe83cb449\",\"/knowledge-medium/pr-preview/pr-1823/src/components/editModeKeepalive.js\":\"b0fc4ea6d9987e41\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyDisplay/PropertyDisplayScope.js\":\"202659720ac64250\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"55f56a94e891dbf9\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/RefPropertyEditor.js\":\"33097c2c01e820f0\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/RefTargetTypePicker.js\":\"f0a6c436a7e977c6\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/SelectPropertyEditor.js\":\"098a1e3334278c26\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/TypesPropertyEditor.js\":\"a533bc60f88054c3\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/defaults.js\":\"945eb0cc6179f259\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/kernelValuePresets.js\":\"28e61b433617b5cf\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/selectablePresets.js\":\"1de9a6fed0185625\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/typesPropertyUi.js\":\"6a31b4d0026afed5\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/AddPropertyForm.js\":\"0e8b45a3909b4a21\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/PropertyPicker.js\":\"34383d8eaf0611d3\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/PropertyRow.js\":\"a195bee2f288e9ec\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/Rows.js\":\"6d9b86319c2db2b6\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/actions.js\":\"3a1546e1ad449f88\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/declarationOnly.js\":\"e734357d740b4005\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/layout.js\":\"8e53a43117d75b1a\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/model.js\":\"b4b902a09489af49\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/shapeUi.js\":\"488096b21c204251\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/shapes.js\":\"5979fe8ea1347cf0\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/usePropertyEditingActivation.js\":\"bf919db94cacd029\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/visibility.js\":\"ec7372be0124cc97\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanelSections.js\":\"b72063ffda6de071\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/BlockEmbed.js\":\"954628742bba930a\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/BlockLink.js\":\"2793ae0e916144b0\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/BlockRef.js\":\"0354beef789d82d3\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/ReferenceLink.js\":\"a16e3289142df25d\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/cycleGuard.js\":\"5cd4f5f251637ba7\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/cycleGuardContext.js\":\"cede44e0b8f935f2\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/linkInteraction.js\":\"2172dab3ccf3b4f2\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/referenceLayout.js\":\"3f8c3b6d2ecd619f\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/useBlockRefAncestors.js\":\"508fe686dc05662f\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/BlockGutter.js\":\"ebc5704f2fec855f\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/BlockInfoDialog.js\":\"0bfa246a1d71c049\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/BlockTypeBlockRenderer.js\":\"c45fcb59e2811b8b\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/BulletHoverCard.js\":\"c0eef27d28a5cc33\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/CodeMirrorContentRenderer.js\":\"03c8d8620d55fb14\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"73e3efe1194fac6b\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/ColumnResizeHandles.js\":\"7c0c62b9b8c3d0f2\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4caa48c1b05ae4bb\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/DefaultBlockRenderer.js\":\"25ed20d8be96fa22\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/LayoutRenderer.js\":\"0b708d7e6ae389ab\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/MarkdownContentRenderer.js\":\"eb65c2fd81102ba3\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/MissingDataRenderer.js\":\"1a96903caa727dc6\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/PanelRenderer.js\":\"324012efb064f52a\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/PropertySchemaBlockRenderer.js\":\"cdc2012d4f938297\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/TopLevelRenderer.js\":\"94b6a32855df6389\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/blockGutterMode.js\":\"d196d5140d3c4f7b\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/blockTitleText.js\":\"85672557df1f3abe\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/fieldCreationKeydown.js\":\"1052182ccfdab765\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/layoutRootContext.js\":\"11a4a1681b2ccf91\",\"/knowledge-medium/pr-preview/pr-1823/src/components/typeChip/TypeChip.js\":\"1140869a9178af1d\",\"/knowledge-medium/pr-preview/pr-1823/src/components/typeChip/chipStyle.js\":\"dbd8f82321a130b7\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/anchored-floating.js\":\"5351734695177eaa\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/button.js\":\"762ae9960f2d8b67\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/card.js\":\"c6545d8d518a5d98\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/checkbox.js\":\"07518bfa6fb457e6\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/collapsible.js\":\"a8ee3d80d3c91daf\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/command.js\":\"91689f75f319a10f\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/context-menu.js\":\"e8c61b67ca61b7b2\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/dialog.js\":\"9294f4bd7db718f2\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/dropdown-menu.js\":\"5704586b967977a2\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/floating-listbox.js\":\"887b1e986de8288e\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/index.js\":\"d834ad4740ed450b\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/input.js\":\"b8bf2ad659e7b58f\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/kbd.js\":\"34ab2d17a1244658\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/label.js\":\"401eae8e732ba811\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/textarea.js\":\"310657c2eff1ba85\",\"/knowledge-medium/pr-preview/pr-1823/src/components/useEditModeYieldKeepalive.js\":\"1110a0e21bace12a\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/BootFallback.js\":\"b67fef90252853bf\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/FocusedRowLazyMount.js\":\"2ccd20529d1b58c7\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/LazyViewportMount.js\":\"cef7667f6af1bdd9\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/LocalDbCorruptionFallback.js\":\"68320ab2ce6ccbf8\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/error.js\":\"eabdaa271393688c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/lazyMountRegistry.js\":\"42f9e2060f24e041\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/suspense.js\":\"810dddefb7be45fc\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/CreateWorkspaceDialog.js\":\"741507ba78f7095f\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/PendingInvitations.js\":\"5fc2732deb9c5af0\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/SyncProgress.js\":\"5cd8a5779e8db453\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/UnlockProgress.js\":\"860d86cb350d5b8f\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/WorkspaceKeyGate.js\":\"456e9c5dc9ae871d\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/WorkspaceSettingsDialog.js\":\"3f3081b4d5545c1b\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/WorkspaceSwitcher.js\":\"6f7ca326141d68f5\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/WorkspaceSyncGate.js\":\"3021436e5561f235\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/ConversionFlow.js\":\"c3ced32c71e18c62\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/ConversionFlowHost.js\":\"ef7c9534d5b0bff8\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/EncryptionSection.js\":\"19abc865576cb88d\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/attachmentPrompts.js\":\"e377786d336961d0\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/bundleFolderPrompts.js\":\"36a77ce9732e8007\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/conversionFlowDeps.js\":\"c76a4e39096a157c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/conversionFlowStore.js\":\"81ac1797e0540b85\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/flowUi.js\":\"13442cbc66f8e1ce\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/useConversionRun.js\":\"ca832da35fab68a8\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/keyUi.js\":\"8737e5e5e7ab786c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/useCloseOnKeyLoss.js\":\"ef77262ea498aa8c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/useCloseOnServerE2ee.js\":\"79ada711144582b8\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/workspaceUnlocked.js\":\"b90517e4066e6c39\",\"/knowledge-medium/pr-preview/pr-1823/src/context/backgroundSubtree.js\":\"65bbaa31a70d5bae\",\"/knowledge-medium/pr-preview/pr-1823/src/context/block.js\":\"557f53dc0b3fda4c\",\"/knowledge-medium/pr-preview/pr-1823/src/context/layoutWsContext.js\":\"010c795ef0c68eb9\",\"/knowledge-medium/pr-preview/pr-1823/src/context/propertyDisplay.js\":\"ebc9faf37f77e58d\",\"/knowledge-medium/pr-preview/pr-1823/src/context/repo.js\":\"dd239a05ef757241\",\"/knowledge-medium/pr-preview/pr-1823/src/data/aliasClaim.js\":\"b36b9e953f2d9709\",\"/knowledge-medium/pr-preview/pr-1823/src/data/aliasSeatNamespace.js\":\"c6857824109dd03c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/blockData.js\":\"a60e7174916cbaa4\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/blockType.js\":\"564bbe410e104cc1\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/changeScope.js\":\"2a39bc4dd8e85e24\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/codecs.js\":\"befc2f28f6b5dd56\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/derivedData.js\":\"461bb21b2d794119\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/errors.js\":\"7805b9d5c7c7625f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/events.js\":\"6de6f9729c858c72\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/handle.js\":\"5722f5795017bbbc\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/index.js\":\"ccf0b7317dae2f3f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/mutator.js\":\"e285720efd8ae902\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/processor.js\":\"7607b39a0efce7ff\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/propertySchema.js\":\"0017deba02e77cc7\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/query.js\":\"377aad20ec1623e6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/sameTxProcessor.js\":\"fea06c04f07cf64a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/schema.js\":\"5722f5795017bbbc\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/tx.js\":\"5722f5795017bbbc\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/typedBlockQuery.js\":\"b1146e021f2ebcc5\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/user.js\":\"68c6d1eca3f5db3e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/valuePresetCore.js\":\"e1646139b4ef0fc0\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/valuePresets.js\":\"4882aa82d57fadba\",\"/knowledge-medium/pr-preview/pr-1823/src/data/attachmentCleanerIOVerb.js\":\"6cf128a84ab03428\",\"/knowledge-medium/pr-preview/pr-1823/src/data/block.js\":\"976d576607f092c2\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockCache.js\":\"1d57aedc3a2a1e54\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockId.js\":\"e017e85e1d527b9f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockLiveness.js\":\"3b05890630c760b3\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockMerge.js\":\"082043c2e1f64549\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockSchema.js\":\"d8a9ba40dbdb5056\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockTypeLookup.js\":\"fa0daad525a4c639\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockTypes.js\":\"cbd15b57fe1e890c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/clientContext.js\":\"a8b2ed85b71ff75b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/dbFileSiblings.js\":\"b345b69961147402\",\"/knowledge-medium/pr-preview/pr-1823/src/data/definitionSeeds.js\":\"60e556dbeeaca5cb\",\"/knowledge-medium/pr-preview/pr-1823/src/data/derivedIds.js\":\"537d610ed98992ee\",\"/knowledge-medium/pr-preview/pr-1823/src/data/drawnSubtree.js\":\"bab0dc70b8995478\",\"/knowledge-medium/pr-preview/pr-1823/src/data/facetBridge.js\":\"4e729c2d7696cf20\",\"/knowledge-medium/pr-preview/pr-1823/src/data/facets.js\":\"a4377b0da3e62681\",\"/knowledge-medium/pr-preview/pr-1823/src/data/globalState.js\":\"350fcf0525aa8524\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/aliasClaimRederiveProcessor.js\":\"91332da75a25fb2c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/ancestorBatch.js\":\"d91dc338fef539b6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/blockTypeTypeifyProcessor.js\":\"e5cfd77ea677dfe8\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/clientSchema.js\":\"16162ac4303798f6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/commitPipeline.js\":\"425b4d5637d0b971\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/devAssertions.js\":\"d5ed6e87fe5e1c58\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/firstSync.js\":\"3a8ad80d0d237a0a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/freshInitialLoad.js\":\"80adf41b2793838b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/graphBackfillClaim.js\":\"1bad4b9f948223c9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/handleStore.js\":\"ebb24d9162857266\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/idleMarkerJobs.js\":\"e55337147175ad8a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/initialDownload.js\":\"3ca711a168c82406\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/initializeClientDatabase.js\":\"ce589f3154c5e701\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/jsonCanonical.js\":\"8d3f1353db737ad4\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/kernelInvalidation.js\":\"b9707b04f6948f62\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/kernelProcessors.js\":\"e16654ee653adef0\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/kernelQueries.js\":\"e7d93e4b0a62b114\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/mergeTypeMembershipProcessor.js\":\"99c96f3592cc54da\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/normalizeReferencesProcessor.js\":\"39676df2464035cf\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/poolInstrumentation.js\":\"4874b7dec3797827\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/processorRunner.js\":\"bad9a0d5f36eafab\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyCellBackfill.js\":\"edf4bcfcd53d2df1\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyChildMint.js\":\"37f6eafb1ebf132a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyChildrenProcessor.js\":\"ce403126d16b9cd6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1da7bad60d7ef592\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyDefinitionSynthesis.js\":\"be185df9fcf8da6e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyKeyScan.js\":\"f492639aeb6be3cb\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertySchemaResolution.js\":\"1c406259471ac388\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyValueEdits.js\":\"4098426a37acb5dd\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/raiseProtocol.js\":\"8d4ef96c467ba607\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/readBatch.js\":\"a16628e92a15b6e6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/refProjection.js\":\"578884ee68c2172e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/referenceTargetLookups.js\":\"7603a32771811a5b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/referenceTargetProcessor.js\":\"ca0bcba9a63963ce\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/replayMerge.js\":\"d636b7675973be7b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/sqlBinds.js\":\"fd8e3d5f9be4fa5e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"92c5a3f1af4cd0a0\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/arrivalProcessors.js\":\"ebbe427b99fad779\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/invalidate.js\":\"dcf9f100f9dc57bb\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/materialize.js\":\"6330db3b30dc795c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/observer.js\":\"194152805050e7d4\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/reconcile.js\":\"97797b2efc7dd1ef\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/timingMetrics.js\":\"2185b2889adf7471\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/treeQueries.js\":\"87f97068dd7c8249\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/txEngine.js\":\"c46985c8b2f823b7\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/txSnapshots.js\":\"0d4570bf74d33e0e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/typedBlockQuery.js\":\"a6ae7ceb679201a9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/undoManager.js\":\"120d6be1749dbf8e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/invalidation.js\":\"4ad2b19f88150215\",\"/knowledge-medium/pr-preview/pr-1823/src/data/kernelDataExtension.js\":\"133b35a78ff5c9b4\",\"/knowledge-medium/pr-preview/pr-1823/src/data/kernelPage.js\":\"c290022f03ee41aa\",\"/knowledge-medium/pr-preview/pr-1823/src/data/kernelValuePresetCores.js\":\"1bc0e3dabe362087\",\"/knowledge-medium/pr-preview/pr-1823/src/data/localDbCorruptionSignal.js\":\"c42b2a663a9c00b0\",\"/knowledge-medium/pr-preview/pr-1823/src/data/localDbStorage.js\":\"eedd4b7a4b3d4f1c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/localDbVfs.js\":\"bf0a2d0bb31ac80a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/localSchema.js\":\"2bd18556de66d37f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/maintenance.js\":\"ac47cad7776427c6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/mergeProperties.js\":\"6aec2e842f5aa597\",\"/knowledge-medium/pr-preview/pr-1823/src/data/metricsConsoleHook.js\":\"9ae3c24d52bc053e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/migrationsPage.js\":\"99f4257c081faeb8\",\"/knowledge-medium/pr-preview/pr-1823/src/data/mutators.js\":\"2195bfcb1e22040f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/orderKey.js\":\"fcce6e6ae4c0dc89\",\"/knowledge-medium/pr-preview/pr-1823/src/data/orderKeyPlacement.js\":\"56a93424f597d838\",\"/knowledge-medium/pr-preview/pr-1823/src/data/outlineSurface.js\":\"85b6c888ca8cfc55\",\"/knowledge-medium/pr-preview/pr-1823/src/data/pendingEditorContent.js\":\"c58b6a9773902875\",\"/knowledge-medium/pr-preview/pr-1823/src/data/pendingUploadsSql.js\":\"724d8873c02ac32e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/pluginStateExtensions.js\":\"caa2ab546fbf4e3b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/powerSyncLogger.js\":\"1043b5e27334a409\",\"/knowledge-medium/pr-preview/pr-1823/src/data/projectorRuntime.js\":\"fcb9b193de7ee1f9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/properties.js\":\"1f48f36e1d4fa4ff\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertiesPage.js\":\"14bfed2a676c3bfb\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyChildren.js\":\"cb68917c3371892f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyDefinitionFanout.js\":\"e5855071c3bb77f9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyDefinitionMetadata.js\":\"89c66061016fd532\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyDefinitionRegistry.js\":\"89f4f49ba628c087\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyDisplayMode.js\":\"d90e3fdd6fae8681\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyRowCreation.js\":\"05fbf117afcf44cb\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertySchemaCreation.js\":\"45fcda91fbace11d\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertySeeds.js\":\"587045d22026c0e4\",\"/knowledge-medium/pr-preview/pr-1823/src/data/recentsPage.js\":\"fc46a75be042eb46\",\"/knowledge-medium/pr-preview/pr-1823/src/data/referenceBlock.js\":\"de59947471e38997\",\"/knowledge-medium/pr-preview/pr-1823/src/data/rejectedUploads.js\":\"4b8669862768dcf3\",\"/knowledge-medium/pr-preview/pr-1823/src/data/releasePowerSyncConnection.js\":\"d834e3f631d7c345\",\"/knowledge-medium/pr-preview/pr-1823/src/data/repo.js\":\"05b0eed2d849cedb\",\"/knowledge-medium/pr-preview/pr-1823/src/data/repoProvider.js\":\"b79b4bc04797c55a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/rowProperty.js\":\"aaed07411fec5523\",\"/knowledge-medium/pr-preview/pr-1823/src/data/searchFilter.js\":\"5bf5194c377264f8\",\"/knowledge-medium/pr-preview/pr-1823/src/data/seedIdentityLedger.js\":\"1a1545a188cc1e3a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/stateBlocks.js\":\"e0218aa82fdff5cd\",\"/knowledge-medium/pr-preview/pr-1823/src/data/structuralEditPolicy.js\":\"e6800484ded58217\",\"/knowledge-medium/pr-preview/pr-1823/src/data/subtreeDelete.js\":\"1507837beca95295\",\"/knowledge-medium/pr-preview/pr-1823/src/data/syncStreamLock.js\":\"c18c3e11e123fb10\",\"/knowledge-medium/pr-preview/pr-1823/src/data/syncedTableSqlRecognizer.js\":\"793e1ea02cee8e9e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/syncedTableWriteGuard.js\":\"073f97dddc21a08b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/targets.js\":\"0df2000d71faa9ac\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeColors.js\":\"5994914fa73add2f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeDefinitionMetadata.js\":\"70dd723b66ecbf22\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeDefinitionRegistry.js\":\"a571341fac6bca46\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeExtraction.js\":\"971b08ca73559059\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeInitialValues.js\":\"7e53404eb5a0eded\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typePropertyGroups.js\":\"991d3c7ac7d46687\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeSeeds.js\":\"b669819f8ccbb7c3\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeTagger.js\":\"50c4d20e3856ee3e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typedRecords.js\":\"c9093a7ccfe871e0\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typesPage.js\":\"871bda0c3d87f9d8\",\"/knowledge-medium/pr-preview/pr-1823/src/data/userPrefs.js\":\"a5dea20c2c5d6788\",\"/knowledge-medium/pr-preview/pr-1823/src/data/userSchemasService.js\":\"b2fa0658f1947013\",\"/knowledge-medium/pr-preview/pr-1823/src/data/userTypesService.js\":\"9a7c766f4bee590f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/valuePresetRegistry.js\":\"c9d9eef725cba0bd\",\"/knowledge-medium/pr-preview/pr-1823/src/data/visibleChildren.js\":\"4e38ca30c1771aa6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaceConversion.js\":\"491b67e990299a4b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaceFirstSync.js\":\"05f8c4d4a80c4ce7\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaceIdNamespace.js\":\"f153437399f21cda\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaceSchema.js\":\"7d72b9c05f799cfc\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaces.js\":\"32acf61f3cbc0c48\",\"/knowledge-medium/pr-preview/pr-1823/src/data/writeAheadLog.js\":\"5922e75099b9ffbe\",\"/knowledge-medium/pr-preview/pr-1823/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/BlockPasteShellDecorator.js\":\"a7e43c83f3dcd456\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/atTrigger.js\":\"394f21293eef6d71\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/autocomplete.js\":\"6b04170d6bdb2ebd\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/codeMirrorExtensions.js\":\"91d70a6e47097f9f\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/contentFlush.js\":\"26b0fa98868d1877\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/defaultInteractions.js\":\"6cda67c8a39488d1\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/editSettleSignal.js\":\"17de8b4f86785327\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/insertImage.js\":\"59ad850966234c8e\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/referenceCompletionRange.js\":\"3e921f3b909fbf81\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/referenceTargetTypes.js\":\"dd2919661d4abd61\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/syntaxContext.js\":\"f18bfe32431e2fff\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/triggerMatch.js\":\"fddfa4ac0731e74c\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/AppRuntimeProvider.js\":\"c7fdb0c3279b9f28\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/BlockFocusShellDecorator.js\":\"23deebe0f8d99659\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/ExtensionRenderBoundary.js\":\"03a6d2554901db68\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/PanelContentRecovery.js\":\"d3f3fbac9bbfc26d\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/apiCatalog.js\":\"36bd655e8b28f6aa\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/approveExtensionHere.js\":\"f28dca36dd49b4bd\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/armedCutAppMount.js\":\"0af2e2afedae65c1\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/batchableKeyedStore.js\":\"f972901f82d3d7f2\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/blockInteraction.js\":\"ab3d6e73f0418e16\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/blockSelectionAction.js\":\"9028ef1a9dafb52f\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/compileExtensionModule.js\":\"6ea5b9b470641a50\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/compiledModuleCache.js\":\"15bf436ebaad0c8a\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/continuousGestures.js\":\"15b8d5a66489a7cf\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/core.js\":\"86c93adb3fb83434\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/defaultRenderers.js\":\"bd22ca26c453c5cc\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/definitionFanoutAppMount.js\":\"5608492c8ed7f0ee\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/dialogAppMount.js\":\"24dca531005e276c\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/dynamicExtensionSeeds.js\":\"4669d8b9dd735e96\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/dynamicExtensions.js\":\"2f86bb6e8e82774a\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/exampleExtensions.js\":\"5a29e3d4103606f1\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionApprovalStatus.js\":\"f71618fc42977944\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionLoadErrorToast.js\":\"917df2615a43c414\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionLoadErrors.js\":\"b180921909404dfc\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionLookup.js\":\"e01682fc4d658491\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionToggles.js\":\"5a8bc4713e18ed57\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionUtilitiesCss.js\":\"71af1bd06649abf6\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/kernelPageDeletionGuard.js\":\"332aad3670721e02\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/liveRuntime.js\":\"a7a76edba42644fd\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/openExtensionsSettings.js\":\"ad5376baa13b850c\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/overridesCache.js\":\"b10d449543dcdef1\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/pluginIds.js\":\"a0e50c855d3f029f\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/processorRejectionToast.js\":\"1ac255ebd7ba7b41\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/runtimeActions.js\":\"be15fa6ac38c7c89\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/runtimeContext.js\":\"fc42f7edf4c7271c\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/staticAppExtensions.js\":\"98d5879becd7a700\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/staticDataExtensions.js\":\"638c395dfafd50c7\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/toastAppMount.js\":\"706aba2e4c933425\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/useOverrides.js\":\"87209545f97237f5\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/useShortcutSurfaceActivations.js\":\"25af03b99c869b2e\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/discoverToggleTree.js\":\"e71cd6a146050e5b\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/facet.js\":\"b92336d8a3578e2a\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/resolveAppRuntime.js\":\"d5d4254a5eb38842\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/runtimeEvents.js\":\"d4a8fb760fb95a57\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/togglable.js\":\"933c5ea98ffbcc5e\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/variantFacet.js\":\"b26d717a3725890e\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/verbFacet.js\":\"5377fe1b367c7558\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/block.js\":\"5da666bb1741b68a\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/focusedChild.js\":\"c5f02452885c0426\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/propertySchemas.js\":\"ab3506923e2c9bee\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/typeRegistry.js\":\"f3a5530a13e5e376\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useAncestorCrumbs.js\":\"0262a92bbbdd55f4\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useAutocompleteListbox.js\":\"93469c74c75c2513\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useDebouncedSearch.js\":\"5be61fd0264e8058\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useDebouncedValue.js\":\"f16dd7477e2448d9\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useIsFocalRender.js\":\"cf73860a2c4cd495\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useIsReadOnly.js\":\"a69e40329e796b88\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useMaterializeBacklog.js\":\"9928576117c49cc9\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useMinuteClock.js\":\"6f33453e9c041772\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/usePanelLayoutProjection.js\":\"3c52e11f84771b97\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/usePendingInvitations.js\":\"2f1ccbbaa4304f36\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useRendererRegistry.js\":\"dc440c96f769e7a6\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useRetainedFieldRows.js\":\"f067c2dfe8f06346\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useWorkspaces.js\":\"0d798225b1325e8d\",\"/knowledge-medium/pr-preview/pr-1823/src/lib/utils.js\":\"83d23f132483bd85\",\"/knowledge-medium/pr-preview/pr-1823/src/main.js\":\"50db99cda44293b5\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/MarkdownImage.js\":\"90ce7dcbba99d930\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/blockSeparators.js\":\"b6cb43a6fac54b87\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/context.js\":\"3b4f4da4eff7c6ad\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/defaultMarkdownExtension.js\":\"25a013b06b056f7f\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/extensions.js\":\"7a8a0a1d803cace9\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/renderMarkdownHtml.js\":\"359f381c5d1c0071\",\"/knowledge-medium/pr-preview/pr-1823/src/minimal-editor.js\":\"c13f716f76b4ec0f\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/armedCut.js\":\"9401b7c97cc88a5d\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/captureMediaVerb.js\":\"31ee01b98771d04a\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/clipboard.js\":\"a1fe5e99620d0b59\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/decision.js\":\"2b06b47cc14a9f13\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/operations.js\":\"780b73c90e3755bc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/account-header/AccountHeaderItem.js\":\"0379f48b037f5e2e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/account-header/index.js\":\"a7540ab996738e8e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"42b1e319e32de5d5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/askAgent.js\":\"fd53585c8841ae38\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/askedStore.js\":\"25205024d836202d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"51d20723caeac6df\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/chipState.js\":\"54514714c5f49d90\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/dataExtension.js\":\"24ee64f1db9ce2a7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/index.js\":\"8f0058029ecb1bf9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7c0bc61d691b322e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/schema.js\":\"5685e67118e70b3b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/AgentTokensDialog.js\":\"bffb62d0204441db\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a481ef339146d686\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/addMedia.js\":\"2f0356a529430434\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/backlinks.js\":\"23bba35dddce9bcc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/block.js\":\"e41a78d97e5f95ee\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/context.js\":\"efd596fa4ee2d680\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/displayIds.js\":\"026e703ba46483ef\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/index.js\":\"f53f899e31a64282\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/outline.js\":\"77ec99a531f40312\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/properties.js\":\"4dbe8923698a4f3e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/refs.js\":\"61ab85600fa8f9aa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f3a6779787e4d5cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/search.js\":\"90a7df4978c06469\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/shared.js\":\"94e7f6d42c978902\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f1b9205499f2e749\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/text.js\":\"90f7c24a0aed7443\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentWrites.js\":\"2ad0c537f7c7cfb1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/authoringCatalog.js\":\"cb46e86c2b7858e4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/blockRefTargets.js\":\"3c4f2bcdc78bb6b3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/bridge.js\":\"3e3f8e8967f62e84\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/bridgeLoop.js\":\"83e14dd616ef169c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/changeHistory.js\":\"8b305f72f2bdf6ed\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/commands.js\":\"84d49f485417d529\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/commentsCommands.js\":\"0c4d7b2f7a827b91\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/dataExtension.js\":\"a88114224651ed44\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/dataModelGuide.js\":\"ffacb9575831ff57\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/describeRuntime.js\":\"65d6f45293e26dce\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/extensionLint.js\":\"b7bd8f11c1d1a615\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/grainAudit.js\":\"4ccd144dad25c7fc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/healthCommand.js\":\"6e24c116cbd97994\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/index.js\":\"455a46336e01877b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/presetIdentity.js\":\"83e12e36322cf1b5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f0cb647e58d12c4b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/readMedia.js\":\"7c6fc796c79b79af\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/schema.js\":\"52473b8dd93dd122\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/serialization.js\":\"64f036b47bcef13c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/targets.js\":\"79b99d6551fd2c87\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/tokens.js\":\"0ac660b13cc59529\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/watchEvents.js\":\"9b55b59c65122a86\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/workspaceGuard.js\":\"34004990b6bc6f3c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/writeCommands.js\":\"5fbea3efb8a836c9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/AliasCollisionToast.js\":\"dccae6bc418dbd01\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/DuplicateNameBanner.js\":\"3261f3c8df173fbc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/collisionMerge.js\":\"1838289402bfd5c4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/dataExtension.js\":\"84e65f502730b323\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/index.js\":\"5043e6733c779d3c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/mergeCollisionAction.js\":\"bed781d298dbae8e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/pageStyling.js\":\"0f5aba14d2bacf45\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/rejectionToast.js\":\"27a3a39222670826\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/syncProcessor.js\":\"f11d11e5fcc9ba45\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/actions.js\":\"7ac165e45bcb122b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/addComment.js\":\"4b779515d6292789\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/anchor.js\":\"62fc05e66b259b44\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/anchorState.js\":\"8fcd902d77c7a4cb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/commentLinks.js\":\"d9a9278490cf15f5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/confirmThreadDeletion.js\":\"24330a24ab487901\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/container.js\":\"34f89afdb85e3f9f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/dataExtension.js\":\"f315a489c90a7621\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/deleteComment.js\":\"3cd2ac726ea93541\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/highlights.js\":\"d137852d5ca6d9fe\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/index.js\":\"565433eab65d9c8a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/linkedCommentsPill.js\":\"e47be607a6cffb4c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/margin.js\":\"2a4d035c6728b5ae\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/marginSchema.js\":\"84a17ba831ae7e59\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/newComment.js\":\"7a7d9b783c75ba00\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/ownThreadPicker.js\":\"625341d468a74309\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/placement.js\":\"f392fa60d1098c33\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/queries.js\":\"ffb9b9a108aac490\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/quotePosition.js\":\"337c4316bde2b0df\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/quotedIn.js\":\"5336f0bb3eabe14e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/quotedRange.js\":\"e0b8688a321f9377\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/rangeRefs.js\":\"76926269a5f3cfbb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/readHighlights.js\":\"7da05e7678605f58\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/readSelection.js\":\"5819ca414143c08d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/readSelectionUi.js\":\"dbacbf9e7dfa70e1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/reanchor.js\":\"da697ef699b2a5d7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/schema.js\":\"145f367b29e4d67d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/scope.js\":\"0d3f52e54d42372f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/scopeThreads.js\":\"77aba2323e9986c2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/splitRetarget.js\":\"1e45adef2e386b38\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/suggestionCard.js\":\"b1704cad1ecc7c49\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/suggestions.js\":\"944088efaa8f4bb5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/summaries.js\":\"4d158fed6890e835\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/summaryBatch.js\":\"b0a37c047400e171\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/surface.js\":\"a6591b00339cbf43\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/threadNavigation.js\":\"1171503c1a77706d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/threads.js\":\"7e4221218cdf3267\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/ui.js\":\"dd36f35603b1d3a7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/uiStore.js\":\"6467995716dd3b00\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/app-intents/appIntents.js\":\"b49163391ffc7dad\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/app-intents/index.js\":\"12fdb29418c0b493\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/app-update-prompt/index.js\":\"d67d7838ba679db5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/app-update-prompt/status.js\":\"0179a127463d5334\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"86b3da8089cdcd65\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/MediaBlockRenderer.js\":\"5d5408bac29aa721\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c164c173e3441199\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/MediaUploadReconciler.js\":\"7a6431275673e798\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/assetDownLane.js\":\"e689c2be4b4d3c2f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/assetResolver.js\":\"14a5ee8d1ed50941\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/assetUpload.js\":\"2a76c6196d9a2458\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/attachmentCleanerIO.js\":\"966dbde7c7c39785\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/supabaseAuditIO.js\":\"fd425bcda67f63dc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/blobStore.js\":\"fea65fc251537227\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/byteStore.js\":\"01d1e7b0f9ebcd32\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/cleanerIO.js\":\"3394e71e9dfa1cbe\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/cleanupAttachments.js\":\"a7c55077e98a6b9b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/dataExtension.js\":\"4ab956b4adc0eb72\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/downLane.js\":\"e41a96873db23bf7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/index.js\":\"b289d5404db07827\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/insertImageContribution.js\":\"3d91bb1f77188c73\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/laneArming.js\":\"ad25e18144dd946b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/laneLock.js\":\"b819f9b358378fe0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/mediaBlock.js\":\"82d2ff15694ae9c4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/mediaCapture.js\":\"604485735f413790\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/mediaViewers.js\":\"529ec922566a6789\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/mediaViewersFacet.js\":\"bcc8ea680207e14a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/pasteCapture.js\":\"ddb8552ce1fde4e6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/resolver.js\":\"dc71393e2da4239b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/retryUploadsAction.js\":\"22874122b70fc389\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/storagePaths.js\":\"21a02ff2971a5135\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadDrain.js\":\"1fdc40ee87640393\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadLaneStatus.js\":\"465e183271901ade\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadReconcile.js\":\"fe05aecb56b26bd1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadRecovery.js\":\"1cbbd5caa060e4d4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadStore.js\":\"9674e777f4d5ef87\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/useAssetObjectUrl.js\":\"c02f2d1d34814c34\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"83008b5b7d6f75e6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/BacklinksViewSection.js\":\"bfc8bfe253c146c0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/facet.js\":\"0fc0fb8d098879cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/index.js\":\"5ceffddd1dc896e6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/prop.js\":\"4e8bf0aa0bb61f7e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/BacklinkFilters.js\":\"1740ce8625641750\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9e0d2de11e7de964\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/BlockEntry.js\":\"46d39fcb534d7c12\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/LinkedReferences.js\":\"fb611f40a058a6de\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7e823acc71a7d18e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/dailyNoteDefaults.js\":\"96431e1b84bb87df\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/dataExtension.js\":\"61576a24d33e3b9e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/edgeExclusions.js\":\"9e5a4292d5e24fc3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/filterProperty.js\":\"9f6b809c964d3151\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/index.js\":\"15410c28d460d0ae\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"39fe03a9f7e0903e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/applies.js\":\"0b327a4b04ceccf4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/countQuery.js\":\"afc787e4bc42e8f4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/expansionStore.js\":\"0a7a77637ae52a54\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/index.js\":\"b696e41a84151135\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"82a8d4cae52be662\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/presentationInvalidation.js\":\"104625eec1e56c7d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/propertyEditorOverride.js\":\"10d6cfa8cd053e97\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/propertyFilter.js\":\"f9b0fab9a1badd48\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/query.js\":\"63f05880d3a1ce0c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/resolveFilter.js\":\"ce8a04d2e48075fc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/sourceBatch.js\":\"c14f1ee20cf2def5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/sources.js\":\"e2276cf282cee1a0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/useBacklinks.js\":\"862e254342d04909\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ca5b0d05128edd4c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/BirthdayCelebration.js\":\"864db8ea14ed5f26\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/BirthdayOverlay.js\":\"1e654b00bb6382ca\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/gate.js\":\"8f133f9948f2c54e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/index.js\":\"0540a8b2c27ee413\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/wolfTheme.js\":\"7c8408f020b52c89\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/BlockDragLayer.js\":\"d09ea8842db0a34c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/dragController.js\":\"80c163c1208836f0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/dropTarget.js\":\"84fd50f31fe3eb2a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/index.js\":\"a7ae55ea1e4fdf41\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/projection.js\":\"78d7bc1ef5dea4da\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-info/BlockMetaCard.js\":\"fd7bb7650e4b3252\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-info/index.js\":\"214758aceae32a6b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/AddTagDialog.js\":\"86cd403cb530ec90\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"fbe3e1b47e1e7ad2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/TagNameIssueHint.js\":\"6f83d951b1241d79\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/addTagAction.js\":\"2af89b181af06d57\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/appendTag.js\":\"bafa47b21278b6b7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/config.js\":\"325564d89a0470b3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/dataExtension.js\":\"2e4a995b63fabb57\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/index.js\":\"505ec2835b5fc7b5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/propertyEditorOverride.js\":\"506fe8e6ddbe475e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9d05a6fa90ab9188\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"592ac41f0b3e0058\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/Breadcrumbs.js\":\"bc016ea11b0fb1a4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4e93144b3c5d7c67\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"38fb2559c665f339\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/index.js\":\"689a18d475db6662\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d42f84fad0acc8a9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/CharacterCountItem.js\":\"b57bf5d16f87c029\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/ProfilePropertyEditor.js\":\"96a4f0dea368d95f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/actions.js\":\"38bf37cfa9f10612\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/blockType.js\":\"fb5d9c3e763af5b0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/charCount.js\":\"a04478b636fb89c2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/dataExtension.js\":\"93da28fa286dc67f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/index.js\":\"7b6e38df531e75f9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/profiles.js\":\"05af98cc54914c2c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/properties.js\":\"841f08a9536fa662\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/textCounts.js\":\"cf1ecfa50ce9ee4e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/colemak-keybindings/index.js\":\"f09a46cc16aad087\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/CommandPalette.js\":\"4f9ca04e2d25e59d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/HeaderItem.js\":\"8b1ccfd93b74788d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/context.js\":\"1341873526d1bb61\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/index.js\":\"55eb84bebd0035dd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/selection.js\":\"0691dd0626f67f1d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/toggleStore.js\":\"dcab903c85e811b8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/useCommandPaletteActions.js\":\"5ab80e1ffdeef4ed\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/ContributorBadges.js\":\"5d7416484cca7a3c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/author.js\":\"67d8910804915772\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/codeMirrorExtensions.js\":\"93c62cbe74be6f9c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/dataExtension.js\":\"ccee79b362b97bf1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/index.js\":\"1a19529a6dd73887\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/mentionAutocomplete.js\":\"6d11821e438f1be7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/processor.js\":\"b8a6e741ac3c2d06\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/profiles.js\":\"58aed911f224fa00\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/queries.js\":\"2a846eda095efcfb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/schema.js\":\"f4dd98764f596b8f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"cbdae7240900acbe\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c3bd5c1e1a1b5b04\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/index.js\":\"8e66ab6eada3061a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6870b3d314731ada\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"233a6adbb62ab6b3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/CalendarGrid.js\":\"af968142c2970705\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/DailyNotePicker.js\":\"981b82dec550376a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"12eecb1d00f6912d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/DateNavDecorator.js\":\"a5fa662a1fdec9b5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/DateScrubOverlay.js\":\"0a9a7b85d11172d9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/HeaderItem.js\":\"12e5d06dcf772e74\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/ReschedulePicker.js\":\"7f34fa92d749c4ec\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/SpreadDatesDialog.js\":\"17357edbefd84742\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/actions.js\":\"f970bc2fd1ef88d8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/blockDateAdapter.js\":\"ee726b5c24964cf7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/calendar.js\":\"e91ae78e210cc54a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dailyNotes.js\":\"7fc564cf4127f431\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dataExtension.js\":\"f8ac513b4cace5c8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dateScrubActions.js\":\"e40d317432e1fb90\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dateScrubGesture.js\":\"72389329228b2ed7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dateScrubGestureActions.js\":\"723863ce5f423888\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dateScrubRecognizer.js\":\"192ea3b18d2d9c87\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/deletionGuard.js\":\"1b8c4e2cf5e5d647\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dueQuery.js\":\"a96fa14fb78448d6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/index.js\":\"6bbd96cc76de91df\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/landing.js\":\"c122391c1953e182\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/localSchema.js\":\"28a4647d2875dbac\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/referenceDateAdapter.js\":\"8a8b464958cf15f0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/rescheduleAction.js\":\"0c906ff0076ed120\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/schema.js\":\"98ce51271a68bdcc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/spreadBlockDates.js\":\"891f3f6e74186b8b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/spreadDatesAction.js\":\"c58a6a8dc63e86db\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/today.js\":\"9ad437cd15c3ca80\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f24908e97996eecf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f46a0f17264559d3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/audit.js\":\"58db43686f202394\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/auditAction.js\":\"a0a32fed7916f039\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/auditRanges.js\":\"0d9262368ac50ee5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/diagnosticsSource.js\":\"e41bc8368b6dc500\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/divergenceScan.js\":\"876397e2ddc56051\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/index.js\":\"24c87ffd0954d311\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b2fda836640b5629\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/referencesMirror.js\":\"288b9d5824de3618\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/rowJson.js\":\"971937abd757fe65\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/schedule.js\":\"2a7a31ddd1426091\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/store.js\":\"3ad307415576e292\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-maintenance/action.js\":\"599c60cba176939b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-maintenance/index.js\":\"dc029772b434005f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-maintenance/plugin.js\":\"dffc872e2b818a84\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c46d07bc4bf5bd80\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/actions.js\":\"4ea3210a9e701d6c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/changeMarker.js\":\"68a08fcdfbd33db5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/diagnostics.js\":\"a076d1d7893d98f7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/fileSystemAccess.js\":\"ec0f4d060988b9e0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/filenames.js\":\"93e7a3e2bb155ed7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/index.js\":\"3d0b26558df9f60f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/mirror.js\":\"4540038d5a318f3a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/runLock.js\":\"d5ce8e58a9e4d89c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/runtimeHealth.js\":\"f1ecb5723987d609\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/schedule.js\":\"dbc8c82467144106\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/store.js\":\"d6653e927a8f7ecb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/default-themes/index.js\":\"66c8884179fdd04b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/default-themes/themes.js\":\"c2af943c77243170\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/diagnostics/facet.js\":\"e1979824c4203474\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/diagnostics/useDiagnostics.js\":\"3389262299795692\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extension-prompts/dismissals.js\":\"e105eab7e434fbed\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extension-prompts/index.js\":\"c66732b104320bd4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extension-prompts/status.js\":\"c1c04ff3dff666dd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extension-prompts/store.js\":\"d2ef20ef77e91d69\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a2c9db7ee4487e18\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fbc82e3d4f720abd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/actions.js\":\"4642b784faf68d36\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/config.js\":\"6aae114fcd53f239\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/dataExtension.js\":\"56005344e19a8271\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/effect.js\":\"ed61b09f4ed66dfc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/index.js\":\"3f1966d79d053820\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f7cebd4a8d4ec344\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/useToggleTree.js\":\"806fa4ec976d17de\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/ExtractTypeDialog.js\":\"390144f17ab737d1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"fe5da87399afd28a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/PropertyShapePicker.js\":\"2e66b9ed1b39d2db\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/action.js\":\"7eb1d0fff20f120f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/index.js\":\"b4ef357e30af2fc0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/FindReplaceDialog.js\":\"17ae27942897ad70\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/HeaderItem.js\":\"edb0a5f410b91c0a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/dataExtension.js\":\"6f6903a9ea02e7b9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/index.js\":\"5ed39fc2600515cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/search.js\":\"96b405c317e6f9d8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/toggleStore.js\":\"039b13411cd6226c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/LocationPropertyEditor.js\":\"ee11d24d81c39c91\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/MapView.js\":\"4eb3bdd6b20f70ce\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/blockTypes.js\":\"91647a4e67e495d7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/codeMirrorExtensions.js\":\"30c7a6b10e851ab7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/createOrFindPlace.js\":\"a643177059b38622\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/currentLocation.js\":\"82f12a05287374bd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/dataExtension.js\":\"536fc94e3046f990\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/geoContentDecorator.js\":\"898a0ad2b1556f5f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/googlePlacesClient.js\":\"955fa699acada43e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/index.js\":\"1d6d2b981d92c0f6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/locationsPage.js\":\"e4d807cf1f99bb41\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/mapViewport.js\":\"87853c9fe4bf2a59\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/pickCurrentLocation.js\":\"c32bfcf24e636049\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/placeAutocomplete.js\":\"60dbc3743fc6d735\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/placeNameCollision.js\":\"f17f74cdd2709e47\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/properties.js\":\"14d551e6c1549a10\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/propertyEditorOverrides.js\":\"33ecfe94a1e82ccf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/query.js\":\"f3288a81adb5d97b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/usePlaceSearch.js\":\"a8ccfd07272e58c6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"aab81a287f4733fd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"56d3e898fb529d8d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"bde821b82e9abc51\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/config.js\":\"2e4dc6539d66739f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/dataExtension.js\":\"de3aa793f6568fed\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/facet.js\":\"216d3f2befafdeb4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/grouping.js\":\"766576c79861f7ae\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/index.js\":\"55de35fe0769159a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"bd21d2fe5ea7cfc2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/query.js\":\"9c7b07f89414b3a8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/resolveConfig.js\":\"e22e35ae4229b097\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0f42be2c13b56dc2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5163b2fac1bfc824\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/HtmlDocumentContent.js\":\"603c89f9bc9ca99c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/HtmlFrame.js\":\"a8a3afb806d9c111\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/actions.js\":\"5b22f2eb93c7a5c3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/blockType.js\":\"e7e985a6cef0047c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/confirmRunScripts.js\":\"49f4e8447d0212d6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/dataExtension.js\":\"5ef9fb596ae87c8a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/frameAnnotations.js\":\"199cde7b97c59f03\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/frameDocument.js\":\"ea50057e37d35897\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/frameTheme.js\":\"1f24846c4599ae4c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/index.js\":\"ec835582df0d36e2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/scriptConsent.js\":\"583ce85e26ed4eee\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/sourceMap.js\":\"9fbbe9383c0d7ec8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/useDocumentScripts.js\":\"62e01dfb1c28a546\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/index.js\":\"3365f44ccc8f7876\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/record.js\":\"de1a3d8d59f60171\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/recordStore.js\":\"1d0b15cfabdce0eb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/responsiveness.js\":\"a8516fda699862e8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/schedule.js\":\"bfe1dd47eed77ab5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/sessionContext.js\":\"1a0eef4ab556a083\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6f863d314d2a3529\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"24d77a277700b094\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/actions.js\":\"086f01d05def32a1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/config.js\":\"0c8068c9baf760ac\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/dataExtension.js\":\"3a508598bbcc913e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/effect.js\":\"615d0bcfe6ad5124\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/index.js\":\"a9a0a9c185700d2c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/keyCapture.js\":\"66d437facf35e49e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/overrideStore.js\":\"673994c0cb5f73e1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bc7d2e6de1b2a276\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/HeaderItem.js\":\"5c492539ddfedd11\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/LeftSidebar.js\":\"61611021c133368f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/actions.js\":\"f64857f5ecd7e6f9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/facet.js\":\"5675a54e6cd5bf57\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/index.js\":\"9dee4bb841f64f50\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/shortcuts.js\":\"b520466d175f09a6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/toggleStore.js\":\"9b5c74d233db1615\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/merge-blocks/MergePicker.js\":\"0e69d89c54d50c2f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/merge-blocks/index.js\":\"9c4a922d11ed1f82\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/merge-blocks/mergeAction.js\":\"2806ff8e99239a89\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/merge-blocks/strategy.js\":\"e6fed7e513929b9a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/Button.js\":\"a1fac88ef8b6fcc8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e6ce0a0b7d7827a9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d0367bc4aa12f4b5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/facet.js\":\"d305ef69d035dc74\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/index.js\":\"1382c5c9adfdec49\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"90b25d778e65d51c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/actions.js\":\"bf71fc0580fba3bf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"90b84d26c41daae6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/facet.js\":\"5607673adb7d498a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/index.js\":\"a420bfc25620e70e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/MoveDestinationPicker.js\":\"bf42feb77b1c2fd8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/blockSubtreeMembership.js\":\"715495cc52608535\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/contextMenuItem.js\":\"71c2d3b9a11879f8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/index.js\":\"ada3a02e3db2b2cd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/moveAction.js\":\"6195e94c3e166a52\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/moveBlocks.js\":\"af19737415f92419\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/selectionAfterMove.js\":\"be9eeb85fc886d51\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/TutorialBanner.js\":\"25b4397630652168\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/action.js\":\"4fdac6f9746efaec\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/bannerDismissal.js\":\"da0d69b7ee42d3ea\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/documents/cheatSheet.js\":\"33b56d7995265c9d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/index.js\":\"e42218d48938ea40\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/keys.js\":\"60cb40c90606668c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/landing.js\":\"1de34e9c25ed3efc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/outline.js\":\"f4a0d52dd025a26d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/seed.js\":\"c89096be7753161f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3d99128345920a45\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/analyze.js\":\"58504c6318e2a2e4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/diagnosticsSource.js\":\"bf7f1ef0114602fc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/index.js\":\"815d8815305050da\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/load.js\":\"0ce42d73a2f11e37\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/monitorRun.js\":\"153b5e70fc10744e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/schedule.js\":\"2d723265239d775c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/series.js\":\"806987e5b437b084\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/store.js\":\"86905252c3b15f5b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/trendAction.js\":\"1ba94cc431607f6e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/verdict.js\":\"f3b6995c579f01fa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/plain-outliner/clickToEditAction.js\":\"06ff3d895ed37ff3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/plain-outliner/index.js\":\"6de4e0b7b6c7abdf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/plain-outliner/interactions.js\":\"af91eb8c482b15ff\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"e2bc5f51ac0d4ba0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/MigrationGate.js\":\"6b0320c6223336cb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/MigrationGateDialog.js\":\"62236d064b13f687\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/action.js\":\"7e9a9bc5feaa3315\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/index.js\":\"8869a2ed54bdcfc7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/localRunMessage.js\":\"b2302cba286bc1b9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/plugin.js\":\"2e3a929f3007b30a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/progressReport.js\":\"9cd0fc3dec6f3407\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/sweepProgress.js\":\"2d7c3626156a196f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/FieldRowRenderer.js\":\"5911328b41ab0a50\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/ValueRowRenderer.js\":\"0b1e4abc97826f8d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/actions.js\":\"58ac35ef44a1a3e5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/autocomplete.js\":\"930137c18c372bd3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/fieldRow.js\":\"6206fc39fd09c9b1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/index.js\":\"4c393771f9aecb32\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/referenceWarning.js\":\"8018a03bfc3a336e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/valueAutocomplete.js\":\"8c5c8b668c34eb30\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/valueSchema.js\":\"eb93d9f1cba41c81\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/HeaderItem.js\":\"e7bf94930676ff1c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/QuickFind.js\":\"d9eff2896d4dac92\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/index.js\":\"509b528695756b70\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/recents.js\":\"937750d7afac9a1a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/resultItems.js\":\"0db73213fdfebfa2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/selection.js\":\"9bbaf780ef7ff1a2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/toggleStore.js\":\"4aca80d802100f17\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/HeaderItem.js\":\"351ab63709dfa63d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/RecentsPageBlockRenderer.js\":\"74b0fb0d5421b04f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/grouping.js\":\"7df2e9739d311bfb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/index.js\":\"4afaf20467559c7b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/target.js\":\"e1964dfe359752ad\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/codeMirrorExtensions.js\":\"602f791be4301df3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/contentPrefill.js\":\"c70e1ad6e9455a4a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/dataExtension.js\":\"9f8f9183b2f9b6a9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/index.js\":\"6facd04c7afebd5a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"94441173da5f063b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/invalidation.js\":\"e93185ecd5b0e69f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/localSchema.js\":\"84ccd7b565427884\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/blockrefs/index.js\":\"f0ff8ec0914fafc8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"abe62cc5395e0fe3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/index.js\":\"0be4d8781b328165\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/referenceNode.js\":\"fe2feab9299f735c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cce4baca7fb8f068\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"30326de7f62effae\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/wikilinks/index.js\":\"b6cccb8399e3e31c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8cc263cc0f30e89a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a51aa53d132357a7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/mergeRetargetProcessor.js\":\"6c3ad60642334db3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/parseFence.js\":\"bb90163c6fff66d0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/referenceParser.js\":\"623f5b8e3b25b8bc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/referenceProjection.js\":\"bdbc68910047d7b0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/referencesProcessor.js\":\"3bbd8ffd1f5574eb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/renameProcessor.js\":\"9d1abf72cb983bed\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/spanReplacement.js\":\"4d5122fbffa13365\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/rich-paste/htmlToOutline.js\":\"a55addbeec6a5b09\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/rich-paste/index.js\":\"d426eb1b51c96568\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1da81b2d0f837ebb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/rich-paste/pasteDecision.js\":\"a75211462906241f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/action.js\":\"ff997876ae0cb0fa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/blockIds.js\":\"57228e7abe9e54a7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/content.js\":\"d3ce664c0d9b1792\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/effect.js\":\"4e99fa2a918492e5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/ids.js\":\"0b3a43fc3b8419e7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/import.js\":\"9b1488a14209e86a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/index.js\":\"ff8f14f69d238049\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/plan.js\":\"cba6ff18cc85ea26\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/plugin.js\":\"879410aa018c9f6f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/promotion.js\":\"404ecbfab6373562\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/properties.js\":\"7597ad3c57329a90\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/references.js\":\"081d305df9a3837f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/report.js\":\"0c9b488d7e59d132\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/roamMemo.js\":\"e2db0e78876a3ef0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/runtime.js\":\"cebd8bcfe09b258e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/schemaReconciliation.js\":\"6d96f8fbc27a5039\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/srsMarkers.js\":\"c46215834554a8f4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/todo.js\":\"bb563764517c8b19\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/typeCandidates.js\":\"9ed57110d41b63cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/types.js\":\"61561e583bf39147\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/search-health/index.js\":\"60e9f39d00b6a2f1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/search-health/store.js\":\"fe7e2a61dbf2c006\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/HeaderItem.js\":\"1a5849769002b204\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"54a9a9f45e28e9fc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/index.js\":\"0174c558bb289f6d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/model.js\":\"aef39ec7d7bd2e48\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/toggleStore.js\":\"f262e4e1044e3f31\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/useKeyInspector.js\":\"31f01f41ae3b2f0c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a5cf0922f89a91cf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/ShellDecorator.js\":\"b1a18c54b6b379f7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/actions.js\":\"24ba05aa15f0bc4d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/exclusionsFacet.js\":\"066febbb67f06b5a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/index.js\":\"75091e0096520ccd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/shell.js\":\"ba973657f679f702\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/surface.js\":\"2588c2921d7d4cbe\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/walker.js\":\"6598448d87528200\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5e7661bac52aae4c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/dataExtension.js\":\"644d42dbded7e231\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/index.js\":\"147a36ae4bdcb526\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/indicator.js\":\"bdd616c7330b3e24\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/moveSrsState.js\":\"de3b4368e1ee06e0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e1f10776f04c924d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/scheduler.js\":\"07cbca97959fda1b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/schema.js\":\"8317861040d74f10\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d8ec331c0c794365\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/srsClipboard.js\":\"3800dad3f1a12dad\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"770a3f2575c297bd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6bab66d6330a6a25\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/DeckPicker.js\":\"36ef75aa0624230b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/ReviewControls.js\":\"5e304096212230f6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/ReviewDeckRenderer.js\":\"dae4572b6a2a8195\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/ReviewSession.js\":\"c8e7a2d90f4ee129\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/actions.js\":\"623aa1c7d5bab5a6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/archive.js\":\"175bcf32b3b11e89\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/dataExtension.js\":\"1950a55a87983b4e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/deck.js\":\"cd9984a13ba1172d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/dueQuery.js\":\"649fcd03e1a4465f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/gradeDecision.js\":\"9ba6fdb77f4ce6e8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/index.js\":\"85ee24cc87b190f7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/keyHints.js\":\"e3fd66e235e124af\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/reviewCardLayout.js\":\"60369f3a37f4f7ee\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/reviewProgress.js\":\"da4c9b023ba140df\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/schema.js\":\"d24c3980e441348e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/useDueCards.js\":\"0c80f881e5415c39\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/startup-metrics/index.js\":\"cd68ebd38aa7dc4a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/startup-metrics/record.js\":\"8a5f247ce56e1926\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/storage-persistence/index.js\":\"0b16829cd9d4d83a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/storage-persistence/persistenceStatus.js\":\"304b8b5de9c303af\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/storage-persistence/requestAction.js\":\"6e006a8ef08d3e02\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/supertags/TypeChipsDecorator.js\":\"8c37f76d7a7aa9f4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/supertags/codeMirrorExtensions.js\":\"2df5158ca820651f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/supertags/index.js\":\"0527b39b3348416c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/supertags/typeAutocomplete.js\":\"14384dcf26eaf8db\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a55bdc93093fa4aa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/actions.js\":\"ca0f66478402e08b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/anchor.js\":\"b356e16757ffbd2c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/events.js\":\"74099347cbf2eeb7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/gestureActions.js\":\"74146461c0962b7c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/index.js\":\"065dc1873b54d4dc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"7623cf7311516831\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/sync-metrics/collect.js\":\"a6c72b64c2bd1200\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/sync-metrics/index.js\":\"1dfa51ffefee16b4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/sync-metrics/record.js\":\"6374d02a2f8aa3af\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/RejectionDialog.js\":\"1458176642e87669\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/SystemStatusHeaderItem.js\":\"206ae93f737a8cf4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/index.js\":\"6c2217d4fb5a8bc4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/model.js\":\"f5680a71154c3853\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/queueCounts.js\":\"eda51dd6ceb11960\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/rejectedHelpers.js\":\"97709e5dcebd7014\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/rematerializeAction.js\":\"13eba41664afc5b4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/useHysteresis.js\":\"cccd78a98bb9d03b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/ColumnHeaders.js\":\"9de6c478b1241fca\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/TableLayout.js\":\"0ccd8600996b2b4d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/actions.js\":\"7b87e156db448c8b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/cellEdits.js\":\"7add02b2e8885dff\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/columns.js\":\"330a09bd37c58451\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/controller.js\":\"b54b6083d07a5e95\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/convert.js\":\"369df7d7ae214c91\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/dataExtension.js\":\"c312688e9c5ed550\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/index.js\":\"b3becd955480609e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/keys.js\":\"81e50fa374c6a9e8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/model.js\":\"a253d6ea530650d0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/registry.js\":\"c0ea334e6f99e60d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/schema.js\":\"14669965591ec301\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/theme-toggle/effect.js\":\"d738e2d60c10cfcf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/theme-toggle/index.js\":\"9195a19fe48a00dc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/theme-toggle/theme.js\":\"019d360fc9adb572\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/todo/actions.js\":\"6e24782fd86b8954\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/todo/dataExtension.js\":\"1eb49cc5be738b3f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/todo/index.js\":\"16003a663430aab7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/todo/schema.js\":\"ebd7859a0bf182b8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/TouchSelectionLayer.js\":\"250f1201146a147a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/actions.js\":\"94f91a51d9d719b6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/defaultItems.js\":\"8d7be70ca3774c88\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/facet.js\":\"5bdd01f9d3906abb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/holdRecognizer.js\":\"77103e3cf84ad4cb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/index.js\":\"ef04df9145f8f9b5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/update-indicator/UpdateIndicator.js\":\"7aa8b559fa2d2c6b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/update-indicator/index.js\":\"ca05b4fac534df9f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/update-indicator/loadTimes.js\":\"1ce5e0db3adc3a30\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/VideoNotesRenderer.js\":\"3cd8dde369abaa39\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/VideoPlayerRenderer.js\":\"4f09cb1da6ac398a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/VideoTimeStamp.js\":\"a143770044909ef6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/actions.js\":\"4519288fc9765e36\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/index.js\":\"5585e5e9037d0dfa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/markdown.js\":\"1f9abb843c7c726d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/notes.js\":\"56134036d5f1f562\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/registry.js\":\"12879bdf27d5ae76\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/remark-timestamps.js\":\"92b7f57df949daf5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/view.js\":\"07d10e3e45d151d8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-link-hints/LinkHints.js\":\"69807de376f6df6a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-link-hints/index.js\":\"067256516f030165\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-link-hints/model.js\":\"353df14beb21917e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-link-hints/settings.js\":\"cbe805093365752d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-normal-mode/actions.js\":\"584cfe1763bb3f78\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-normal-mode/index.js\":\"4b58b1fc7f99da77\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-normal-mode/interactions.js\":\"716c611a7e09a8fc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/workspace-header/index.js\":\"8fde1f348dcbb97d\",\"/knowledge-medium/pr-preview/pr-1823/src/registerServiceWorker.js\":\"b6266aebf19a8504\",\"/knowledge-medium/pr-preview/pr-1823/src/requestPersistentStorage.js\":\"2845fc94e2a722f2\",\"/knowledge-medium/pr-preview/pr-1823/src/services/authRequestDeadline.js\":\"19f7dc1601b9a559\",\"/knowledge-medium/pr-preview/pr-1823/src/services/authStorage.js\":\"4a87f2c597855aad\",\"/knowledge-medium/pr-preview/pr-1823/src/services/powersync.js\":\"cca021e89f05ff1a\",\"/knowledge-medium/pr-preview/pr-1823/src/services/supabase.js\":\"1d2c1c98313bc551\",\"/knowledge-medium/pr-preview/pr-1823/src/services/uploadErrorClassifier.js\":\"a44fb6794c899eef\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/ActiveContexts.js\":\"cfc9c0ea20129125\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/HotkeyReconciler.js\":\"e2a1365d10de4c88\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/WipeLocalDataDialog.js\":\"18dcbe4586bad84c\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/actionDispatch.js\":\"92489b812c4e3998\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/actionRefItems.js\":\"bc26cd364db634ee\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/applyKeybindingOverrides.js\":\"82215d52ce63ac5d\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/blockActions.js\":\"d48eea251ebb65c1\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/canonicalizeChord.js\":\"f71dbcdcfe09adff\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/defaultContexts.js\":\"3d83ee347f0b6fa4\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/defaultShortcuts.js\":\"f4684c843c3e8eb5\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/effectiveActions.js\":\"68ec910a8146da42\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/gestureAction.js\":\"47d22019bde02087\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/gestureBinding.js\":\"5546712e60114445\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/holdRegistry.js\":\"27c71bd28256f667\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/keybindingConflicts.js\":\"1022f101e2637e83\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/keybindingOverrides.js\":\"66814ca263683177\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/pointerAction.js\":\"d49cc1c51ffa95f1\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/resolve.js\":\"f67b0eab06379ca3\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/runAction.js\":\"a902d1e087d1fbf7\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/sequenceMatcher.js\":\"580448b2791f5fec\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/types.js\":\"9f06cd0c925bbe3f\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/useActionContext.js\":\"a88bf49e736f0836\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/useActionDiscovery.js\":\"a4d692d4522327cf\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/utils.js\":\"6183998e21ce5978\",\"/knowledge-medium/pr-preview/pr-1823/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1823/src/sw/bootStore.js\":\"d2b9108cc8984164\",\"/knowledge-medium/pr-preview/pr-1823/src/sw/previewDatabases.js\":\"dfee1f466d08663e\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/byteTransform.js\":\"52cfe95af434439f\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/attachmentCleaner.js\":\"d071e8f4db07b4af\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/attachmentParts.js\":\"20a4dc7fd469490c\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/bundleParts.js\":\"da6dc38bb826ae19\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/bundleRecord.js\":\"f48a5c078fb6fdd2\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/manifest.js\":\"2e7f7bb670eb8d5a\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/takeBundle.js\":\"c1f26078177fa5e3\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/verifyBundle.js\":\"ca2758d43fbd4a9d\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/cleaningStage.js\":\"47618b397ffcebbb\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/conversionKey.js\":\"91a2496515db607a\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/conversionServer.js\":\"758808782dff929d\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/flip.js\":\"961e5a97cce4ac43\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/flipAttempts.js\":\"fafc6c988bffaf44\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/pages.js\":\"84dca7529f46207f\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/preflight.js\":\"046cf07ab408c54e\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/reseal.js\":\"1416d567517ad454\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/runConversion.js\":\"99f48d3e2a9ff31b\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/runLock.js\":\"3d6e35ef02f0a06c\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/sealing.js\":\"e0866cafa7fa86fc\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/sealingStage.js\":\"8665fddf6d2f6fde\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/stage.js\":\"915eb408d68597d4\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/verifyReseal.js\":\"6e7cf903fe100b89\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/aad.js\":\"4b77fd10c112a349\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/aead.js\":\"25f34e61c8fd49f5\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/base32.js\":\"0a28f0bfa074e918\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/base64url.js\":\"5f600a86171ee687\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/binaryEnvelope.js\":\"6ab286900fc98303\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/byteAead.js\":\"bf85e3345b69c95c\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/canary.js\":\"a02ddfc9911ff71d\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/contentHash.js\":\"73c8abd44baf2dba\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/contentKey.js\":\"90627a5c9195c281\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/derivedIdNamespace.js\":\"9f746005f6ef20b1\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/envelope.js\":\"62ee686cb6510764\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/hex.js\":\"82a33c90e21c6186\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/sha256Hex.js\":\"6fff5b7df44aef6c\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/workspaceKey.js\":\"7de56315b2ba2580\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/conversionState.js\":\"1bb980c9522dab2b\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6e82d0906886b08e\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/flows/pastedKey.js\":\"4939c861a2a143c3\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ee333a7d05edae6f\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/flows/upgradeWorkspacePin.js\":\"fec90776ef2fafde\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/keyStore.js\":\"80e123879b685ea5\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/mintWorkspaceKey.js\":\"52c426a0bc55b45a\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/modePin.js\":\"008cc4e2fd9aea21\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/openWorkspaceKeys.js\":\"d8913152c7fb52f9\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/resolveWorkspaceEntry.js\":\"61d7d1c91c3bc160\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/resolver.js\":\"e567fbaf4b0ecdbf\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/workspaceAccess.js\":\"b72ea08de07e43ed\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/transform.js\":\"bac6078f2a265b92\",\"/knowledge-medium/pr-preview/pr-1823/src/themeBootDefaults.js\":\"4fbc7c82abfffc87\",\"/knowledge-medium/pr-preview/pr-1823/src/types.js\":\"d6fe6248d6daa5a7\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/ClientLocalSettings.js\":\"2855258bd4b98124\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/abortableSleep.js\":\"4549e40dfc115918\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/array.js\":\"bfb170dc82e17ae5\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/backlinkAutocomplete.js\":\"9d39cda027189ec5\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/blockCrumbs.js\":\"cf061baa90a264b3\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/blockrefAutocomplete.js\":\"5b50cdf49f20ebf5\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/cadencedIdleJob.js\":\"f59098b8e7d0391d\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/callbackSet.js\":\"25bb0ccacb99de78\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/clientId.js\":\"96b108c3d8fc3ce8\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/codemirror.js\":\"8aa8e989b596ab95\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/codemirrorCompletion.js\":\"9310aee9c1f69442\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/copy.js\":\"33bdee5cf8844e24\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dailyPage.js\":\"5678e5cc4c262376\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dbForensics.js\":\"b0a610d882cf810c\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dbForensicsHooks.js\":\"398b12548e700f84\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/deleteBlockThroughUi.js\":\"8a03d2f81a26bca5\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dialogs.js\":\"42455043fd930530\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dom.js\":\"4777f5fc7ab9c689\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/downloadBlob.js\":\"21c580f5df94d5df\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/exportSqliteDb.js\":\"0561b4fca59e439f\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/fileSystemAccess.js\":\"560ee2fcee990484\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/flipSlide.js\":\"9a3587013d92f78c\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/fnv1a.js\":\"2c755e43bd2928e8\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/formatBytes.js\":\"ca297f8adc96d9d5\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/fuzzyRank.js\":\"b71a0381fc1fe19f\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/idbKeyedStore.js\":\"8a6e84b58a9dc433\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/idleCallbackPolyfill.js\":\"2b71c1366be6c563\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/keyboardAwareScroll.js\":\"866c9607e917b6a0\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/keyboardViewport.js\":\"4ed0dae0577bec9e\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/lastWorkspace.js\":\"92e0063a11854915\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/layoutColumns.js\":\"37776e56f15ad1c6\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/layoutSessionDom.js\":\"1899e657084366f4\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/layoutSessionId.js\":\"149aa723e213e7cd\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/linkClickGestures.js\":\"12e4a2ff6b28b218\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/linkTargetAutocomplete.js\":\"d4f70dc9b7be15f3\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/localDbCorruption.js\":\"9fc56164accce92a\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/localDbRecovery.js\":\"784b5699802025fd\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/markdownParser.js\":\"53ff69de3bbc15df\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/memoize.js\":\"7184ebba5ddacd03\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/nameFieldCommit.js\":\"f5cc5d1251011adb\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/nameList.js\":\"d0a93d5ae7dc3bb9\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/navigation.js\":\"d27e97a7fbda0f8f\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/omnilinerNamespace.js\":\"61a8d70e37be73ab\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/opfsPageScan.js\":\"4d5defceea23a88d\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelClearance.js\":\"237e3f68c509360d\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelHistory.js\":\"1fe881614633a548\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelLanes.js\":\"311eb759a5e6ccda\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelLayoutProjection.js\":\"f3edfdf2426ab569\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelScrollAnchor.js\":\"5f118d5cfcc19528\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelUrlFlags.js\":\"e8fabd532064e1c4\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/platform.js\":\"2b6521b9e2dbfe8c\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/pluralize.js\":\"6bebdcc26ec65567\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/propertyCreation.js\":\"9097414ecd5beca8\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/propertyNavigation.js\":\"c0b05752d209e69e\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/propertyValueContext.js\":\"9b0de2c55aa1e53d\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/react.js\":\"eda227f03fdd38e3\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/relativeDate.js\":\"70c75fc65dccd8a9\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/relativeTime.js\":\"f51318e42b62823c\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/renderScope.js\":\"0d317a9c2b365231\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/resolvedThenable.js\":\"2431f1920a59f236\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/routing.js\":\"8ca68310ce0aeb9e\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/safeMode.js\":\"0ddb8bbe07eb3364\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/scheduleIdle.js\":\"9fbc304ac5050de7\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/screenWakeLock.js\":\"5ce35f002d0f05ba\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/selection.js\":\"2f668ccba31d6088\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/softKeyboardGrab.js\":\"923fbfbd67be8d8f\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/startupTimeline.js\":\"9f8aa818a75da800\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/state.js\":\"0e639bbfa8c45125\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/string.js\":\"fe21d2dc16c26878\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/surfaceZoom.js\":\"d38abd9d1fdf49c7\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/time.js\":\"d6acdc1b0dbaf00f\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/toast.js\":\"f46870e17a5b14d4\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/toggleStore.js\":\"f642c7a9c9105602\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/untilStopped.js\":\"2ac8313c194aba68\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/userActivity.js\":\"729784266df682e2\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/viewTransition.js\":\"8e05ba6e07a1b4b5\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/viewport.js\":\"16a2f2c1cdcb836e\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/webLock.js\":\"5073247e3758f2c6\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/workspaceRecovery.js\":\"6810bdb13d076f88\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/workspaceSnapshotStore.js\":\"ad35d15800c62128\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-compiler-runtime.js\":\"09622832ffdc636a\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-client.js\":\"03261b07ebe15f1e\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-server-edge.js\":\"e2674354d028b41a\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-server.js\":\"64e239dcc223a168\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-static-edge.js\":\"75a0aa58d0663b16\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-static.js\":\"ded329a0bb4b53d6\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-test-utils.js\":\"e8ee087eb0c23a65\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom.js\":\"20e3310d6d98ac9f\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-jsx-runtime.js\":\"ac8813784d7756c9\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react.js\":\"b77d681d73b66988\",\"/knowledge-medium/pr-preview/pr-1823/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1823/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1823/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
