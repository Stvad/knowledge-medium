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
		buildId: "f82073efa25a-df976683",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1823/\":\"52a550061b1986bd\",\"/knowledge-medium/pr-preview/pr-1823/index.html\":\"52a550061b1986bd\",\"/knowledge-medium/pr-preview/pr-1823/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1823/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1823/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1823/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1823/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1823/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1823/app.css\":\"214bb21065d2d442\",\"/knowledge-medium/pr-preview/pr-1823/assets/FacadeVFS-Btz-6p8i.js\":\"a0c583371d48a175\",\"/knowledge-medium/pr-preview/pr-1823/assets/OPFSCoopSyncVFS-DUw0y-UP.js\":\"25f864219763d3b6\",\"/knowledge-medium/pr-preview/pr-1823/assets/OPFSWriteAheadVFS-BtupVR7y.js\":\"6dc95b117430c41f\",\"/knowledge-medium/pr-preview/pr-1823/assets/wa-sqlite-C19BIbSC.js\":\"225fe3a51a00780f\",\"/knowledge-medium/pr-preview/pr-1823/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1823/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1823/assets/wa-sqlite-async-N7tb8pvV.js\":\"5c76380783025b16\",\"/knowledge-medium/pr-preview/pr-1823/assets/worker-BpLIrH31.js\":\"d87fa0010f4686f3\",\"/knowledge-medium/pr-preview/pr-1823/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1823/chunks/app-aHEj679w.js\":\"75772ec107a5d9c0\",\"/knowledge-medium/pr-preview/pr-1823/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1823/index.js\":\"52d4a067893a3c6a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1823/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1823/assets/AccessHandlePoolVFS-Uoc1kUdw.js\":\"192935f15f63beb1\",\"/knowledge-medium/pr-preview/pr-1823/assets/IDBBatchAtomicVFS-DUXl34Gw.js\":\"4403a5742901879f\",\"/knowledge-medium/pr-preview/pr-1823/assets/MemoryVFS-BrJIxMSW.js\":\"add2d1e266895373\",\"/knowledge-medium/pr-preview/pr-1823/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1823/assets/mc-wa-sqlite-async-Cre0aYEf.js\":\"ca79e25c17bde29e\",\"/knowledge-medium/pr-preview/pr-1823/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1823/assets/mc-wa-sqlite-crlruqqX.js\":\"067901cc43e09add\",\"/knowledge-medium/pr-preview/pr-1823/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1823/chunks/AccessHandlePoolVFS-CU0KuiS3.js\":\"0bb59fb13c697ade\",\"/knowledge-medium/pr-preview/pr-1823/chunks/FacadeVFS-Cu3EkuB_.js\":\"af4b4b807b7bdb7b\",\"/knowledge-medium/pr-preview/pr-1823/chunks/IDBBatchAtomicVFS-DwxPZGaS.js\":\"68227818a7f34334\",\"/knowledge-medium/pr-preview/pr-1823/chunks/MemoryVFS-BrTJ1K0G.js\":\"35f04859089dfc5d\",\"/knowledge-medium/pr-preview/pr-1823/chunks/OPFSCoopSyncVFS-DtETzwGN.js\":\"85590f661fe6d0b5\",\"/knowledge-medium/pr-preview/pr-1823/chunks/OPFSWriteAheadVFS-CJFbm532.js\":\"8170987331381313\",\"/knowledge-medium/pr-preview/pr-1823/chunks/Preview-DF2w8UXB.js\":\"8c9444ce70e119ab\",\"/knowledge-medium/pr-preview/pr-1823/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1823/chunks/card-DvLfbrUQ.js\":\"ddad6678487c57f8\",\"/knowledge-medium/pr-preview/pr-1823/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1823/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1823/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1823/chunks/dist-CxLrOvwn.js\":\"e678fb97e6e16479\",\"/knowledge-medium/pr-preview/pr-1823/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1823/chunks/mc-wa-sqlite-async-BTVjfCX8.js\":\"03e6c916dccf615b\",\"/knowledge-medium/pr-preview/pr-1823/chunks/mc-wa-sqlite-q09ZdOVX.js\":\"1039f0edafd92f1e\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-BE2ZSC2-.js\":\"2e7452a303814138\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-BKyBdSGy.js\":\"0bf50a62dfa92fb1\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-CEXshiqX.js\":\"39d3d6bf5ba5ea2a\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-CN57QdRk.js\":\"bd35afb6ac9a8d6e\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-CY9wbTQH.js\":\"46d2e57e6cde70ed\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-CnT9Fq8a.js\":\"46b28d37c6d8db17\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-DWUDe-Iw.js\":\"a3a0eb0b0f825523\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-T_mIOvpf.js\":\"3ebfa0c4e83fd8b5\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-dom-server-legacy.browser.production-C-nyA5-5.js\":\"07dc7d92d0f18f38\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-dom-server.browser.production-B75TwoJu.js\":\"f66a6892cf961c88\",\"/knowledge-medium/pr-preview/pr-1823/chunks/react-dom-server.edge.production-B9-DVf_K.js\":\"8c6e960ebc459392\",\"/knowledge-medium/pr-preview/pr-1823/chunks/server.browser-BVH2U_E4.js\":\"25c37094fa832d0b\",\"/knowledge-medium/pr-preview/pr-1823/chunks/textarea-QXMqiubq.js\":\"5f839333ed485e69\",\"/knowledge-medium/pr-preview/pr-1823/chunks/ui-c8ZTUKcp.js\":\"6b75babb456f04c1\",\"/knowledge-medium/pr-preview/pr-1823/chunks/wa-sqlite-DJJnvzDG.js\":\"96f58726b58333e5\",\"/knowledge-medium/pr-preview/pr-1823/chunks/wa-sqlite-async-BPnE8rRT.js\":\"c2a944475e3e8d6e\",\"/knowledge-medium/pr-preview/pr-1823/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1823/extension-utilities.css\":\"b10454a07c895a97\",\"/knowledge-medium/pr-preview/pr-1823/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1823/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1823/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1823/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1823/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1823/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1823/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1823/src/App.js\":\"6d67bc8a3aa657c0\",\"/knowledge-medium/pr-preview/pr-1823/src/appUpdate.js\":\"19f2a233e0e2407e\",\"/knowledge-medium/pr-preview/pr-1823/src/appVersion.js\":\"0538c908fdea7bd8\",\"/knowledge-medium/pr-preview/pr-1823/src/bootstrap/initialLayout.js\":\"bbaa52c76795e997\",\"/knowledge-medium/pr-preview/pr-1823/src/bootstrap/openWorkspaceData.js\":\"089abf9e63a634df\",\"/knowledge-medium/pr-preview/pr-1823/src/bootstrap/resolveWorkspace.js\":\"85dbfa84384da482\",\"/knowledge-medium/pr-preview/pr-1823/src/bootstrap/workspaceBootstrap.js\":\"849a6d912f423123\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockComponent.js\":\"565570771227220d\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockCrumbs.js\":\"d39d9ed5cd5fd916\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockEditor.js\":\"db4611c19d025f1c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockLoadingPlaceholder.js\":\"629829d4bb4b6183\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockProperties.js\":\"48d69aca7c0901af\",\"/knowledge-medium/pr-preview/pr-1823/src/components/BlockSearchPicker.js\":\"36db2c44511e154b\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ConfirmBulkDeleteDialog.js\":\"87d700e97487ea05\",\"/knowledge-medium/pr-preview/pr-1823/src/components/DividerHandle.js\":\"c51ebc1fb73c4f7c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/DraftEditor.js\":\"41762c82a1497ab9\",\"/knowledge-medium/pr-preview/pr-1823/src/components/GutterPill.js\":\"345d36a458505f76\",\"/knowledge-medium/pr-preview/pr-1823/src/components/Header.js\":\"5c3ad96cc48903ed\",\"/knowledge-medium/pr-preview/pr-1823/src/components/LazyBlockComponent.js\":\"fc1845ecaa9e79f4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/Login.js\":\"47c1f02068ed9760\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ZoomableSurface.js\":\"cf23d58e6169a29f\",\"/knowledge-medium/pr-preview/pr-1823/src/components/editModeKeepalive.js\":\"4107627cf0865b74\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyDisplay/PropertyDisplayScope.js\":\"bddcc55e152e8d3a\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e9922cd16353d1ac\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/RefPropertyEditor.js\":\"50b38137b5dadf9b\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/RefTargetTypePicker.js\":\"1e22e8bf8adac5f7\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/SelectPropertyEditor.js\":\"a87c6679df6a5d2e\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/TypesPropertyEditor.js\":\"3a486340a8ca544c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/defaults.js\":\"c5739c4038ed8c27\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/kernelValuePresets.js\":\"d93ad4f61509e52a\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/selectablePresets.js\":\"d9626bd5eb7259fa\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyEditors/typesPropertyUi.js\":\"71152f5ccf0f9a3b\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/AddPropertyForm.js\":\"e60d9032c7e5a7ec\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/PropertyPicker.js\":\"4b43fa3c0cf2d75e\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/PropertyRow.js\":\"9a2133f0df7174f9\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/Rows.js\":\"ea5ff6dcaeb113e7\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/actions.js\":\"53f6d3db74dc616c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/declarationOnly.js\":\"c471507cdd92d00e\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/layout.js\":\"ce12226d4ba23f54\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/model.js\":\"4ccd07bba57f1690\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/shapeUi.js\":\"bd14d00a504a1841\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/shapes.js\":\"94f5c92e4b601aa6\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/usePropertyEditingActivation.js\":\"f5f1ec0f202f3521\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanel/visibility.js\":\"b861aed8ba6a0267\",\"/knowledge-medium/pr-preview/pr-1823/src/components/propertyPanelSections.js\":\"b6af1b5ef18f8e9e\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/BlockEmbed.js\":\"056e9eedda1eac05\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/BlockLink.js\":\"5eb96c50747c90cd\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/BlockRef.js\":\"45bd4736f7da888d\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/ReferenceLink.js\":\"65fcbe70dca2390a\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/cycleGuard.js\":\"a2537bc854fdd039\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/cycleGuardContext.js\":\"e9a140d628f7f2c7\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/linkInteraction.js\":\"087714712424dcc4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/referenceLayout.js\":\"51615b7aacee7328\",\"/knowledge-medium/pr-preview/pr-1823/src/components/references/useBlockRefAncestors.js\":\"e6775b0fc05411fc\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/BlockGutter.js\":\"7c158413ff8afbda\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/BlockInfoDialog.js\":\"dd259e1cc5bbbb8c\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/BlockTypeBlockRenderer.js\":\"abdbe5b8e082ff0e\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/BulletHoverCard.js\":\"61af163ebf5b61ee\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/CodeMirrorContentRenderer.js\":\"2d377fac9d54e670\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"05939897fe16ac3b\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/ColumnResizeHandles.js\":\"a2cfcb417bcd2f76\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e5ea4ce74aa2e265\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/DefaultBlockRenderer.js\":\"7f919243718130d4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/LayoutRenderer.js\":\"53827746ffc08b90\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/MarkdownContentRenderer.js\":\"17ca31e5d3e89ea4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/MissingDataRenderer.js\":\"c3de9f321e9145ba\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/PanelRenderer.js\":\"a38475591adc6b82\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/PropertySchemaBlockRenderer.js\":\"762cf1ffde87f0fc\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/TopLevelRenderer.js\":\"22074ff6253f2e59\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/blockGutterMode.js\":\"7b3736f53e683266\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/blockTitleText.js\":\"e9bfe92dfe8aa199\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/fieldCreationKeydown.js\":\"cd80e0f919a82773\",\"/knowledge-medium/pr-preview/pr-1823/src/components/renderer/layoutRootContext.js\":\"06820b3fe208fff5\",\"/knowledge-medium/pr-preview/pr-1823/src/components/typeChip/TypeChip.js\":\"d1ba8ed267a28ecb\",\"/knowledge-medium/pr-preview/pr-1823/src/components/typeChip/chipStyle.js\":\"afbdef3d7b8072d6\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/anchored-floating.js\":\"498659e26f8fc265\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/button.js\":\"392bd3c6d7a8cdc7\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/card.js\":\"d169329f46a86ad4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/checkbox.js\":\"0929a527f8cbb100\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/collapsible.js\":\"7537a23f7d9b57c5\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/command.js\":\"339ecf7bcc459be7\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/context-menu.js\":\"3c87c07190ab37e4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/dialog.js\":\"5aa60844827e85f3\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/dropdown-menu.js\":\"df1547443ae7edb4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/floating-listbox.js\":\"3768543e207246e3\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/index.js\":\"e8cb6d3dad03b7dd\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/input.js\":\"5459c4642e5207dd\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/kbd.js\":\"c4b1b7cabc17f074\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/label.js\":\"f8b15339786435cd\",\"/knowledge-medium/pr-preview/pr-1823/src/components/ui/textarea.js\":\"b8a7000890746815\",\"/knowledge-medium/pr-preview/pr-1823/src/components/useEditModeYieldKeepalive.js\":\"2a2fd3027030c345\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/BootFallback.js\":\"5d207f6a1adaade6\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/FocusedRowLazyMount.js\":\"406b5f4576177f2e\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/LazyViewportMount.js\":\"216bb18c85f6f560\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/LocalDbCorruptionFallback.js\":\"8aecf66138267808\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/error.js\":\"f763c1b6c3a12a14\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/lazyMountRegistry.js\":\"2dc9269001542dc4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/util/suspense.js\":\"242332f00d8717f1\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/CreateWorkspaceDialog.js\":\"0b57dab83ffd91ae\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/PendingInvitations.js\":\"f51254f2ef4f47ea\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/SyncProgress.js\":\"6a734a8140027d64\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/UnlockProgress.js\":\"b2478f25c9e70085\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/WorkspaceKeyGate.js\":\"ae6aa7413a8f1ecd\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/WorkspaceSettingsDialog.js\":\"556b6d249c54d5d7\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/WorkspaceSwitcher.js\":\"9a87f7aaecbbb6b1\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/WorkspaceSyncGate.js\":\"6db521fa02ff2253\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/ConversionFlow.js\":\"6936517774962304\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/ConversionFlowHost.js\":\"454f86fc79bacdf8\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/EncryptionSection.js\":\"909e37c1e23e60b6\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/attachmentPrompts.js\":\"1b3f32f5cf46c8f9\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/bundleFolderPrompts.js\":\"652523e8a81c25d2\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/conversionFlowDeps.js\":\"e98b3facd24b74df\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/conversionFlowStore.js\":\"9757ec0744c2c207\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/flowUi.js\":\"6a59dbd063515b00\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/conversion/useConversionRun.js\":\"51ebe050631b4da4\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/keyUi.js\":\"b94eb1f6fa349e27\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/useCloseOnKeyLoss.js\":\"802fdd6c4385f235\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/useCloseOnServerE2ee.js\":\"c08a0cfef116a6c0\",\"/knowledge-medium/pr-preview/pr-1823/src/components/workspace/workspaceUnlocked.js\":\"00b1ddda0f791551\",\"/knowledge-medium/pr-preview/pr-1823/src/context/backgroundSubtree.js\":\"c7bc83d3e726e7d7\",\"/knowledge-medium/pr-preview/pr-1823/src/context/block.js\":\"2933115c731abd61\",\"/knowledge-medium/pr-preview/pr-1823/src/context/layoutWsContext.js\":\"a9a06c19bb377428\",\"/knowledge-medium/pr-preview/pr-1823/src/context/propertyDisplay.js\":\"e6f0037b49f78138\",\"/knowledge-medium/pr-preview/pr-1823/src/context/repo.js\":\"c33d1bb2ebca336c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/aliasClaim.js\":\"5b6e4effcc903e72\",\"/knowledge-medium/pr-preview/pr-1823/src/data/aliasSeatNamespace.js\":\"58bc67c7d22b7254\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/blockData.js\":\"50810311170f06aa\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/blockType.js\":\"1fef0b7184563779\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/changeScope.js\":\"c1fd3bc7a62026fa\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/codecs.js\":\"f91bdccf2f482fbd\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/derivedData.js\":\"7adf0bbff93eb263\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/errors.js\":\"cb0d9fd277701672\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/events.js\":\"37da515c5bcc87fb\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/handle.js\":\"38c3139f198d85a1\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/index.js\":\"3ffe31f8e5634690\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/mutator.js\":\"3742d6ddaf3d99b3\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/processor.js\":\"e4a3b78f5f78b35a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/propertySchema.js\":\"d4481704dc31f496\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/query.js\":\"c34e923d0d32db80\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/sameTxProcessor.js\":\"0ad595b73f28a45b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/schema.js\":\"38c3139f198d85a1\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/tx.js\":\"38c3139f198d85a1\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/typedBlockQuery.js\":\"7ba7d899b6b8ccab\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/user.js\":\"88274fec3be64843\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/valuePresetCore.js\":\"c8e668c6bf2b0326\",\"/knowledge-medium/pr-preview/pr-1823/src/data/api/valuePresets.js\":\"9687bda7d837c10d\",\"/knowledge-medium/pr-preview/pr-1823/src/data/attachmentCleanerIOVerb.js\":\"1620881e0baa8cb0\",\"/knowledge-medium/pr-preview/pr-1823/src/data/block.js\":\"153ea4f640eb5e47\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockCache.js\":\"ed4915da2f80d812\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockId.js\":\"700a758072665cb1\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockLiveness.js\":\"9e5134d8d6a451b3\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockMerge.js\":\"b477cf0222c153c9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockSchema.js\":\"17708f5f4640296b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/blockTypes.js\":\"d8ed0ae82d1121a7\",\"/knowledge-medium/pr-preview/pr-1823/src/data/clientContext.js\":\"a7e9f18811ec2420\",\"/knowledge-medium/pr-preview/pr-1823/src/data/dbFileSiblings.js\":\"ab6c7c85c3ac9282\",\"/knowledge-medium/pr-preview/pr-1823/src/data/definitionSeeds.js\":\"fea33a378943b7ac\",\"/knowledge-medium/pr-preview/pr-1823/src/data/derivedIds.js\":\"8e578b5ce261c79b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/drawnSubtree.js\":\"a79a4106a199b0e3\",\"/knowledge-medium/pr-preview/pr-1823/src/data/facetBridge.js\":\"6cd2b27a0c8112b6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/facets.js\":\"1ee27db34112b7c0\",\"/knowledge-medium/pr-preview/pr-1823/src/data/globalState.js\":\"1cb887192401b0b6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/aliasClaimRederiveProcessor.js\":\"f85a91c86ae66ced\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/ancestorBatch.js\":\"3eba623d1a0b9173\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/blockTypeTypeifyProcessor.js\":\"ab157411a4c8c105\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/clientSchema.js\":\"98ef934a451d7b36\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/commitPipeline.js\":\"8d372cfe9c1e8804\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/devAssertions.js\":\"38070ec96ddb7e36\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/firstSync.js\":\"3d807ec7ef2b65db\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/freshInitialLoad.js\":\"df29e0df3c1aae2d\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/graphBackfillClaim.js\":\"c8dd69fe41830d6a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/handleStore.js\":\"0782b15acb2adafc\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/idleMarkerJobs.js\":\"4f8ba8d5cca26b49\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/initialDownload.js\":\"c0b5ee49c4ba018b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/initializeClientDatabase.js\":\"c519e451d7571d22\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/jsonCanonical.js\":\"4f915afb07fefc26\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/kernelInvalidation.js\":\"77098b44eb6613ad\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/kernelProcessors.js\":\"7b8d570a57967471\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/kernelQueries.js\":\"57eac5bab0ce6be7\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/mergeTypeMembershipProcessor.js\":\"0c5d2460242db24a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/normalizeReferencesProcessor.js\":\"7e2960ec5409caae\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/poolInstrumentation.js\":\"af4d1002a6e278a9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/processorRunner.js\":\"6534ac12a7573720\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyCellBackfill.js\":\"97ebdffbf16f7721\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyChildMint.js\":\"6c42277cdb0cb83e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyChildrenProcessor.js\":\"7a2b636f205edc9c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0c01cd9310ae465f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyDefinitionSynthesis.js\":\"6ec0b70ee30a600e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyKeyScan.js\":\"6194ea579b8f88d4\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertySchemaResolution.js\":\"d0bc03ac93fc80ee\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/propertyValueEdits.js\":\"fb7a6ae387a12bac\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/raiseProtocol.js\":\"8bcf30b8543c125e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/readBatch.js\":\"37c225fb5540845b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/refProjection.js\":\"5f0a82189b3fe0ae\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/referenceTargetLookups.js\":\"d3f1e2b0de856b87\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/referenceTargetProcessor.js\":\"f4c351c8873c14e9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/replayMerge.js\":\"1ee7fcf39cdbd5da\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/sqlBinds.js\":\"7e6a791f85188e23\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3df170856daa7f35\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/arrivalProcessors.js\":\"a590ce97cce2fc94\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/invalidate.js\":\"cbfeed59ec489ae8\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/materialize.js\":\"cde59cb167bd3dc7\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/observer.js\":\"0bb7059621c67441\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/syncObserver/reconcile.js\":\"876e02d97b65559e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/timingMetrics.js\":\"e3397ad34bba0fec\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/treeQueries.js\":\"2b6bc7635776b9d6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/txEngine.js\":\"42b4ad5c1c273d58\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/txSnapshots.js\":\"3c9da3cb3642af26\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/typedBlockQuery.js\":\"2475860086a1d327\",\"/knowledge-medium/pr-preview/pr-1823/src/data/internals/undoManager.js\":\"6d5ec724c0e7798c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/invalidation.js\":\"4f215d33a2acfd5e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/kernelDataExtension.js\":\"d1cdb33bfe2b9ad2\",\"/knowledge-medium/pr-preview/pr-1823/src/data/kernelPage.js\":\"76c51d281b16bba8\",\"/knowledge-medium/pr-preview/pr-1823/src/data/kernelValuePresetCores.js\":\"f5d2d498fe579d56\",\"/knowledge-medium/pr-preview/pr-1823/src/data/localDbCorruptionSignal.js\":\"cad81504b9401bae\",\"/knowledge-medium/pr-preview/pr-1823/src/data/localDbStorage.js\":\"42ef18c27f84ef31\",\"/knowledge-medium/pr-preview/pr-1823/src/data/localDbVfs.js\":\"68a017290c2fd4fd\",\"/knowledge-medium/pr-preview/pr-1823/src/data/localSchema.js\":\"270441386f280048\",\"/knowledge-medium/pr-preview/pr-1823/src/data/maintenance.js\":\"ab9319810f1789df\",\"/knowledge-medium/pr-preview/pr-1823/src/data/mergeProperties.js\":\"c5203daa9aa8bbea\",\"/knowledge-medium/pr-preview/pr-1823/src/data/metricsConsoleHook.js\":\"d17d6c4d25e6c54e\",\"/knowledge-medium/pr-preview/pr-1823/src/data/migrationsPage.js\":\"66c9b27bb7d459af\",\"/knowledge-medium/pr-preview/pr-1823/src/data/mutators.js\":\"bbee8b2ff595e72f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/orderKey.js\":\"77d33ca9bde1016a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/orderKeyPlacement.js\":\"a3fe376ffed1dfac\",\"/knowledge-medium/pr-preview/pr-1823/src/data/outlineSurface.js\":\"45f29ace879898d6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/pendingEditorContent.js\":\"8d2afa138e6ed5d1\",\"/knowledge-medium/pr-preview/pr-1823/src/data/pendingUploadsSql.js\":\"41bc1e508387101d\",\"/knowledge-medium/pr-preview/pr-1823/src/data/pluginStateExtensions.js\":\"7e9daaa9b3fe0fc9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/powerSyncLogger.js\":\"a06c1722f37f18b3\",\"/knowledge-medium/pr-preview/pr-1823/src/data/projectorRuntime.js\":\"f1346f0dc2ac06c8\",\"/knowledge-medium/pr-preview/pr-1823/src/data/properties.js\":\"2c5fcebc66117b0a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertiesPage.js\":\"5cff1c858b67920d\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyChildren.js\":\"b2fb94a55e5461ac\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyDefinitionFanout.js\":\"dc0dd58d8cd52fc5\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyDefinitionMetadata.js\":\"75223c6c73ba53cf\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyDefinitionRegistry.js\":\"72ddf51ac24e2615\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyDisplayMode.js\":\"372598a90de52192\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertyRowCreation.js\":\"ee426b785e9687d9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertySchemaCreation.js\":\"4d20e7fdb992fda1\",\"/knowledge-medium/pr-preview/pr-1823/src/data/propertySeeds.js\":\"6f3076439bc754e6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/recentsPage.js\":\"769330d298886faf\",\"/knowledge-medium/pr-preview/pr-1823/src/data/referenceBlock.js\":\"d405442b62b7107c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/rejectedUploads.js\":\"e4daf0440cbb7ec2\",\"/knowledge-medium/pr-preview/pr-1823/src/data/releasePowerSyncConnection.js\":\"9147cf45720a4265\",\"/knowledge-medium/pr-preview/pr-1823/src/data/repo.js\":\"a48c48200e796cfa\",\"/knowledge-medium/pr-preview/pr-1823/src/data/repoProvider.js\":\"fb7a0c5204c7b5e6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/rowProperty.js\":\"6df1f997718e4d93\",\"/knowledge-medium/pr-preview/pr-1823/src/data/searchFilter.js\":\"696e39f2ddcb0654\",\"/knowledge-medium/pr-preview/pr-1823/src/data/seedIdentityLedger.js\":\"1a18cc6d2ec116f9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/stateBlocks.js\":\"187ed45c35045ed9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/structuralEditPolicy.js\":\"5bffce4cee55a5a0\",\"/knowledge-medium/pr-preview/pr-1823/src/data/subtreeDelete.js\":\"5759a3aa7024d237\",\"/knowledge-medium/pr-preview/pr-1823/src/data/syncStreamLock.js\":\"7146ebdd1fcf9645\",\"/knowledge-medium/pr-preview/pr-1823/src/data/syncedTableSqlRecognizer.js\":\"d1e2d3c28981a97d\",\"/knowledge-medium/pr-preview/pr-1823/src/data/syncedTableWriteGuard.js\":\"bdf5bf24406b7ab7\",\"/knowledge-medium/pr-preview/pr-1823/src/data/targets.js\":\"b2b032be14e66f30\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeColors.js\":\"cb7692a24622147d\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeDefinitionMetadata.js\":\"ca81848ead5e77c9\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeDefinitionRegistry.js\":\"f7dce1d8d843a600\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeExtraction.js\":\"4b89f32baa2fdec6\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeInitialValues.js\":\"489e42c8c39b1def\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typePropertyGroups.js\":\"6a6a20741bc9f84f\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeSeeds.js\":\"5a170886f9c26980\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typeTagger.js\":\"3ff54352637afea7\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typedRecords.js\":\"5a14e99a82aca8e8\",\"/knowledge-medium/pr-preview/pr-1823/src/data/typesPage.js\":\"bfd2f265183c8d8d\",\"/knowledge-medium/pr-preview/pr-1823/src/data/userPrefs.js\":\"088486360eac640a\",\"/knowledge-medium/pr-preview/pr-1823/src/data/userSchemasService.js\":\"d11cafeb3cddce8b\",\"/knowledge-medium/pr-preview/pr-1823/src/data/userTypesService.js\":\"bb11d77297fd781d\",\"/knowledge-medium/pr-preview/pr-1823/src/data/valuePresetRegistry.js\":\"276972d53b1b3509\",\"/knowledge-medium/pr-preview/pr-1823/src/data/visibleChildren.js\":\"e5843364123533e5\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaceConversion.js\":\"62101777624f7919\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaceFirstSync.js\":\"19c9ca38b8b31cf1\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaceIdNamespace.js\":\"5e58d64796623715\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaceSchema.js\":\"f127a50b1dd5cd07\",\"/knowledge-medium/pr-preview/pr-1823/src/data/workspaces.js\":\"669d5ba6f23dbd5c\",\"/knowledge-medium/pr-preview/pr-1823/src/data/writeAheadLog.js\":\"c8df1764b1b57c73\",\"/knowledge-medium/pr-preview/pr-1823/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/BlockPasteShellDecorator.js\":\"64347b3949295e59\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/atTrigger.js\":\"53d281e6aac56b86\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/autocomplete.js\":\"3988cd69bb9c9f59\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/codeMirrorExtensions.js\":\"8c4bc1a39dd175ab\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/contentFlush.js\":\"67d851e3c94b8466\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/defaultInteractions.js\":\"c8c42b04f6cf7a5c\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/editSettleSignal.js\":\"499d77baf8c20998\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/insertImage.js\":\"336c8b1ea156b5c2\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/referenceCompletionRange.js\":\"89e052223c2b35bf\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/referenceTargetTypes.js\":\"3b62781bb899fdf9\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/syntaxContext.js\":\"cdc0f12bb891ac5f\",\"/knowledge-medium/pr-preview/pr-1823/src/editor/triggerMatch.js\":\"eb2b219cf57773ef\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/AppRuntimeProvider.js\":\"2cc4361a72892518\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/BlockFocusShellDecorator.js\":\"ee980a5c53a4670a\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/ExtensionRenderBoundary.js\":\"414fc6822962f98d\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/PanelContentRecovery.js\":\"7ce6c66727f4d4aa\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/apiCatalog.js\":\"16a416e8c905b231\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/approveExtensionHere.js\":\"d7ca800d775c102a\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/armedCutAppMount.js\":\"0775b4d919d45f1a\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/batchableKeyedStore.js\":\"dc03b3dcf9968181\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/blockInteraction.js\":\"b70ce4debbbf51f1\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/blockSelectionAction.js\":\"7ac8aa04e35ecab1\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/compileExtensionModule.js\":\"3114e716dd0b895e\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/compiledModuleCache.js\":\"7d11ff5f296caa86\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/continuousGestures.js\":\"eea1b5e6ae5860de\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/core.js\":\"15dcda0af764fae7\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/defaultRenderers.js\":\"796da4b486aa6d86\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/definitionFanoutAppMount.js\":\"8b05a99ebfa0e744\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/dialogAppMount.js\":\"24c566cd87b11916\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/dynamicExtensionSeeds.js\":\"c5e8fbc9f385d652\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/dynamicExtensions.js\":\"929b4d2f2caa5d3a\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/exampleExtensions.js\":\"e5da7a40ce3365ef\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionApprovalStatus.js\":\"d56b1d5e9d971d18\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionLoadErrorToast.js\":\"8b887e6c5a686083\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionLoadErrors.js\":\"c23b34fbf20888cc\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionLookup.js\":\"2ea7ba1a50797358\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionToggles.js\":\"17370e5f3d4cfdbc\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/extensionUtilitiesCss.js\":\"4dd9a144de59b7fa\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/kernelPageDeletionGuard.js\":\"ae38a52279947c60\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/liveRuntime.js\":\"b6dc6e19f10a7530\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/openExtensionsSettings.js\":\"4a4830bcbfedb5c8\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/overridesCache.js\":\"8e67670c8c2b6a4f\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/pluginIds.js\":\"31cdfe31d2f04106\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/processorRejectionToast.js\":\"90d15726754a4908\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/runtimeActions.js\":\"bb1f2b6a92b480cd\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/runtimeContext.js\":\"ba147864bf130557\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/staticAppExtensions.js\":\"54267c76564c84e7\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/staticDataExtensions.js\":\"7baae8c0cac6c817\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/toastAppMount.js\":\"10642aaa394661c5\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/useOverrides.js\":\"df27df27a4bbc27f\",\"/knowledge-medium/pr-preview/pr-1823/src/extensions/useShortcutSurfaceActivations.js\":\"86d966cfea42107f\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/discoverToggleTree.js\":\"ae0b13ea762e4229\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/facet.js\":\"e6639d39d1e5e98f\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/resolveAppRuntime.js\":\"f91fda1a1519cff0\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/runtimeEvents.js\":\"afe2d76850dffeea\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/togglable.js\":\"6070c3e29ce5066d\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/variantFacet.js\":\"03f2df92d4b67074\",\"/knowledge-medium/pr-preview/pr-1823/src/facets/verbFacet.js\":\"c05144eb89a6e1e8\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/block.js\":\"94e6937758b69099\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/focusedChild.js\":\"b5a6cd3c0a0997be\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/propertySchemas.js\":\"0371806a49aa8f5d\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/typeRegistry.js\":\"b0d52b3fbb103b1e\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useAncestorCrumbs.js\":\"a37a474d4e7ce178\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useAutocompleteListbox.js\":\"1bf4ebee9404f83e\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useDebouncedSearch.js\":\"69d78607646dd8f2\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useDebouncedValue.js\":\"0118f0b5a1775342\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useIsFocalRender.js\":\"cf8d76e2a013b1b6\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useIsReadOnly.js\":\"15289413ab883205\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useMaterializeBacklog.js\":\"9176e96746e4fe9f\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useMinuteClock.js\":\"a7c951d84131b50b\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/usePanelLayoutProjection.js\":\"7bc58aefd0217eff\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/usePendingInvitations.js\":\"73b085be5247517f\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useRendererRegistry.js\":\"2c1cae5a97bc5280\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useRetainedFieldRows.js\":\"dc7c56ae05c0c226\",\"/knowledge-medium/pr-preview/pr-1823/src/hooks/useWorkspaces.js\":\"ff892eea3465c268\",\"/knowledge-medium/pr-preview/pr-1823/src/lib/utils.js\":\"8c9e6e19ffda84bf\",\"/knowledge-medium/pr-preview/pr-1823/src/main.js\":\"28fbb0fd2856535e\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/MarkdownImage.js\":\"15401bcdf770b298\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/blockSeparators.js\":\"f7eff0ff677d5650\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/context.js\":\"6afb2d782edaa09f\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/defaultMarkdownExtension.js\":\"5a71513fe5054cb9\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/extensions.js\":\"70254d73f8d57f04\",\"/knowledge-medium/pr-preview/pr-1823/src/markdown/renderMarkdownHtml.js\":\"306bbf58f73da2f7\",\"/knowledge-medium/pr-preview/pr-1823/src/minimal-editor.js\":\"bfbef10c2b730a95\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/armedCut.js\":\"309abe54b6676ba4\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/captureMediaVerb.js\":\"d7c663c737a84fb3\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/clipboard.js\":\"25c5965b102c34c2\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/decision.js\":\"9b701f4e2b14840f\",\"/knowledge-medium/pr-preview/pr-1823/src/paste/operations.js\":\"1fe692141e5998cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/account-header/AccountHeaderItem.js\":\"6e42709605388ffc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/account-header/index.js\":\"c66f1c934dca06a4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1e414b9fecdf7898\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/askAgent.js\":\"401a20a1d4de3216\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/askedStore.js\":\"bbcb65f68803157c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8fbc9007d7cd6ece\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/chipState.js\":\"4aa0817afedc6203\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6125a3486c3e761a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/index.js\":\"4ab7457e6a31fbf2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"45c6e740353b8c4a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-dispatch-companion/schema.js\":\"6d44647cd56bc020\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/AgentTokensDialog.js\":\"657a5ba3c9c38408\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/BridgePairingDialog.js\":\"89bae386d162ecd7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/addMedia.js\":\"7b24533e610630af\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/backlinks.js\":\"da7fcd4e6fba1e04\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/block.js\":\"acf5de41c0b35bef\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/context.js\":\"90f5c28bd2a441d4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/displayIds.js\":\"47f8ba590805fd31\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/index.js\":\"8e0a8421e53dd970\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/outline.js\":\"ad8434173c001635\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/properties.js\":\"3845a049e5310aaa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/refs.js\":\"fedebd6d0912c199\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"28e80349e52dcefd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/search.js\":\"7f0095895c335693\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/shared.js\":\"82b13bd4b7ff27c7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"460b8a5bf62ba5ff\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentViews/text.js\":\"eadf4d66054d1741\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/agentWrites.js\":\"c649b07a31a7a9bb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/authoringCatalog.js\":\"8fdaaeb2aed5e06a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/blockRefTargets.js\":\"72d7202da3a81294\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/bridge.js\":\"a53b8ff1c74bd44c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/bridgeLoop.js\":\"bbd751127ef54426\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/changeHistory.js\":\"08b71ab29112bded\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/commands.js\":\"a0c1efd2cf9b88d4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/commentsCommands.js\":\"e377f32a9e876421\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/dataExtension.js\":\"e6d17600630c31d9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/dataModelGuide.js\":\"60d5e1b233ca3c63\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/describeRuntime.js\":\"edcea9a0b59e9cdf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/extensionLint.js\":\"b032e174c03418e5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/grainAudit.js\":\"238993ab0a73e296\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/healthCommand.js\":\"32e3928f63eabccd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/index.js\":\"9329575038013cac\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/presetIdentity.js\":\"dcf3e2b04be44956\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8742c2bc7dcd7777\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/readMedia.js\":\"7b2c88ff1ef1718b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/schema.js\":\"fc742a8d165d1fa3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/serialization.js\":\"0bd247441a434141\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/targets.js\":\"c52ebac5618751a0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/tokens.js\":\"f008c205bf31f87c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/watchEvents.js\":\"bf85ba1b06c982cf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/workspaceGuard.js\":\"8aa87ffee0162582\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/agent-runtime/writeCommands.js\":\"08d0d4b6e62374a7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/AliasCollisionToast.js\":\"202d1cc0bcfb07ea\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/DuplicateNameBanner.js\":\"07b6284ae8d8f2aa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/collisionMerge.js\":\"aec46b309f8dff7b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/dataExtension.js\":\"9c46dbe241318b43\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/index.js\":\"c9c254b7bdda50fb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/mergeCollisionAction.js\":\"8cd5cc0508f67440\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/pageStyling.js\":\"fee2b9b3b203231f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/rejectionToast.js\":\"d890b92d9a884fd8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/alias/syncProcessor.js\":\"9cd226cb04e9a612\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/actions.js\":\"55e53ad6f1279e51\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/addComment.js\":\"cc9c92dc3179a499\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/anchor.js\":\"c7a9acd7f5b191c2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/anchorState.js\":\"308e9b8ee8f200b1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/commentLinks.js\":\"6498f3fef660cc7c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/confirmThreadDeletion.js\":\"80a0d5a5aa68bc0a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/container.js\":\"8b5774ac4edbaaa3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/dataExtension.js\":\"f867111c3fd20d81\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/deleteComment.js\":\"5e933182a97282c5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/highlights.js\":\"2e66cef77c29f0c5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/index.js\":\"38ce9a1c3cba5e25\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/linkedCommentsPill.js\":\"78d3f7de8c9bc049\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/margin.js\":\"600d843285b70973\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/marginSchema.js\":\"7ae5a96db6bbe270\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/newComment.js\":\"10db7b6c4a72e8ed\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/ownThreadPicker.js\":\"9f1fcc1caaefb6f4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/placement.js\":\"0e0170144703d8cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/queries.js\":\"cd4e94fc8655af04\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/quotePosition.js\":\"66cb3f87345e0f27\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/quotedIn.js\":\"b249a73deff41529\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/quotedRange.js\":\"b308c45ce8b54212\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/rangeRefs.js\":\"7f014c14175de417\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/readHighlights.js\":\"cb04b649ce818b76\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/readSelection.js\":\"7c42bcbfb4ae585b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/readSelectionUi.js\":\"be1e419ea944f0d8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/reanchor.js\":\"133a53c33594fb84\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/schema.js\":\"fac67ca2121b163a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/scope.js\":\"9556969a96c70c6d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/scopeThreads.js\":\"40ff78763e4baf21\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/splitRetarget.js\":\"e5b0b4be26407a54\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/suggestionCard.js\":\"323ef8a83cc4d872\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/suggestions.js\":\"e72e52213d580b18\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/summaries.js\":\"f618bff78df02f6a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/summaryBatch.js\":\"a1b92e341f2469b6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/surface.js\":\"cf16f0d9981d99bb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/threadNavigation.js\":\"727dabc8287824a3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/threads.js\":\"4fa3dfd675d58966\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/ui.js\":\"aff5e89ce04593d2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/annotations/uiStore.js\":\"620a5ee4a8347865\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/app-intents/appIntents.js\":\"9b912d926e2a4c35\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/app-intents/index.js\":\"0937b6e89bb7c84a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/app-update-prompt/index.js\":\"5b1d6ebfac716fd3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/app-update-prompt/status.js\":\"39d4abed2b970f00\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3a72eaa40cabc5f2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/MediaBlockRenderer.js\":\"872e1d64fce6a28f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a169a30e0562df7c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/MediaUploadReconciler.js\":\"8ef398256c53bdf8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/assetDownLane.js\":\"18c45c53ce850c72\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/assetResolver.js\":\"04c13d54357d7b9e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/assetUpload.js\":\"93335f8af0db310c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/attachmentCleanerIO.js\":\"9681104ce4c6d2d7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/supabaseAuditIO.js\":\"348e5ebb20d176c7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/blobStore.js\":\"64724fc15b0b2aed\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/byteStore.js\":\"93e7d29392601abc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/cleanerIO.js\":\"164e6c84ebdf1e6e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/cleanupAttachments.js\":\"5c1af0a021eb3415\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/dataExtension.js\":\"dee3c7eede663074\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/downLane.js\":\"b6c2b614e4324530\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/index.js\":\"a119c633caf8f103\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/insertImageContribution.js\":\"0a8d09be62a81566\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/laneArming.js\":\"606f4afe90eca01f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/laneLock.js\":\"a581386e64df0843\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/mediaBlock.js\":\"aff254fdffbcf3cb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/mediaCapture.js\":\"ac2d63e05c73e9a7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/mediaViewers.js\":\"70a0f5bc997f0eb8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/mediaViewersFacet.js\":\"2a170a9b64145cca\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/pasteCapture.js\":\"f273227859e398f6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/resolver.js\":\"6426f278d5f96792\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/retryUploadsAction.js\":\"a8f684c275a49bd6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/storagePaths.js\":\"d73f663ca2c12285\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadDrain.js\":\"706b0625dd4945a5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadLaneStatus.js\":\"85724bdf14a95dee\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadReconcile.js\":\"0e8d75c8e46be001\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadRecovery.js\":\"a30ba81ee3af26fc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/uploadStore.js\":\"d5b2c6a2f708cf5d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/attachments/useAssetObjectUrl.js\":\"b4c48ba306fbfc67\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"64122d39cbbb0142\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3ac450acea1a0925\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/facet.js\":\"48f2d66c0532c5e5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/index.js\":\"db7c7818b5e38d3b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks-view/prop.js\":\"28b8f4caef711123\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/BacklinkFilters.js\":\"9e2b9fe91e35c071\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"cf07b3d10210a79c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/BlockEntry.js\":\"079488cb6d228a14\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/LinkedReferences.js\":\"462b50c33e16aa59\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"031323fa54ff4e64\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/dailyNoteDefaults.js\":\"a59aadd77b29798c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/dataExtension.js\":\"f37c69f2f3627bfa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/edgeExclusions.js\":\"50c385795cb7ff7e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/filterProperty.js\":\"01bc71f5b3e01e9e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/index.js\":\"1dde3a6a9fe8db76\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bf1853786dc75169\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/applies.js\":\"58a2112c41dd904a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/countQuery.js\":\"70eed0b73d220bcd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/expansionStore.js\":\"07c1fef170cffb29\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/index.js\":\"9b9bb13e79503a99\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8dac9e6078e0a079\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/presentationInvalidation.js\":\"f6e4da127b1dd138\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/propertyEditorOverride.js\":\"9da30f0cea013a58\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/propertyFilter.js\":\"786849b189a06151\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/query.js\":\"7b2d859f0d37ec8f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/resolveFilter.js\":\"b75b59ecf179b87b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/sourceBatch.js\":\"7fe1be6ab869b4be\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/sources.js\":\"50d41364b18ec9c8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/useBacklinks.js\":\"3756d261b68f054c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"790a7b487041ceed\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/BirthdayCelebration.js\":\"2b501bbf00bfe617\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/BirthdayOverlay.js\":\"2b4e2bc124153dfc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/gate.js\":\"b6527b1c5d817393\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/index.js\":\"c225a48d3b482874\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/birthday/wolfTheme.js\":\"1fdb9e6695e06095\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/BlockDragLayer.js\":\"dd98c6b7ca96b084\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/dragController.js\":\"e5a1b8184552075d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/dropTarget.js\":\"2eae3d1a16237cb7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/index.js\":\"03e8b3669e9ac67e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-drag/projection.js\":\"f844ad3430979139\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-info/BlockMetaCard.js\":\"ee21e58fe2cdb23b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-info/index.js\":\"fc81895bc5812c70\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/AddTagDialog.js\":\"2d030df7252c7dd7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1cc9fcde0c93d694\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/TagNameIssueHint.js\":\"4f7de3969b100051\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/addTagAction.js\":\"753fa26a433579f1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/appendTag.js\":\"a19d039ef12e601e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/config.js\":\"5af2c52699eeb43d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/dataExtension.js\":\"44f66858312750ec\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/index.js\":\"4a59bb7574e22c7b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/block-tagging/propertyEditorOverride.js\":\"e3c4b27314ef5a43\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0baf24d9e6b0c87f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1fa135cab9344481\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9756961e69202028\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"15b656a6c4c6d4e2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"dce790e38f4d324e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/index.js\":\"22327fd1e74eb4b7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c6424edeb709ca93\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/CharacterCountItem.js\":\"1c89d389e970694f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9cdbd15fa1b5dbef\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/actions.js\":\"374c571cd0300aa6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/blockType.js\":\"07ef1b8b1620daf3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/charCount.js\":\"24ad49715fdfc868\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/dataExtension.js\":\"a69782d16873a43e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/index.js\":\"bbf66f2af843b0f0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/profiles.js\":\"e3c719c809a8e3af\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/properties.js\":\"48e05072b9ffe4da\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/character-counter/textCounts.js\":\"e7573a0ec2fc8792\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/colemak-keybindings/index.js\":\"991f6895f9b32002\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/CommandPalette.js\":\"073d3b07c014253d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/HeaderItem.js\":\"ebacd7fa4a30295a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/context.js\":\"97a82b2121c15747\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/index.js\":\"8950cace3c1abe6c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/selection.js\":\"84bf6df2cdb80bac\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/toggleStore.js\":\"e290d103280eb2e5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/command-palette/useCommandPaletteActions.js\":\"51efa319aefc93cd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/ContributorBadges.js\":\"2ffba94628173ec4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/author.js\":\"9fdd53bcad70a45e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/codeMirrorExtensions.js\":\"85e0aad05a0c9dd4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/dataExtension.js\":\"d609af23047587d0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/index.js\":\"6a89f7fae248746f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/mentionAutocomplete.js\":\"7af3eb998afabfe1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/processor.js\":\"5f30a9076d7523aa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/profiles.js\":\"18612aef69dbfb2d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/queries.js\":\"4bf2f6d4b8e8ca13\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/contributors/schema.js\":\"5c598fd6fa39dbc2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"2762a44c4afa0271\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a5e85ae9107614ce\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/index.js\":\"8f6b1982058d34ef\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7762ab5b3dd0e4e3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"11d845b413ce1939\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/CalendarGrid.js\":\"d512104a7811fd22\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/DailyNotePicker.js\":\"db398ede0b673723\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"88f5f6852a1fceff\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/DateNavDecorator.js\":\"cdf9b5088fb510fa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/DateScrubOverlay.js\":\"ec138c605b3777fa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/HeaderItem.js\":\"951a6c214d8ed09e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/ReschedulePicker.js\":\"61097346b9ddcfa9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6ef97360325bd7e9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/actions.js\":\"2f19d6d0baa5173e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/blockDateAdapter.js\":\"5894b12fc2ceb15f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/calendar.js\":\"a1c4f91cff4de668\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dailyNotes.js\":\"d3d7aa719eeef1ff\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dataExtension.js\":\"4ff986a0aa7c3984\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dateScrubActions.js\":\"8795b53f87432874\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dateScrubGesture.js\":\"549515b94e7767b8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c3726d2355e1a7a1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ec98dd879ba072ac\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/deletionGuard.js\":\"e095ba847d09519e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/dueQuery.js\":\"9469f5bf59f9cda3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/index.js\":\"35db45dd5617a43a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/landing.js\":\"31a12c0def9feb92\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/localSchema.js\":\"34fb63e60b4fbb29\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/referenceDateAdapter.js\":\"f4d16cf12260bc51\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/rescheduleAction.js\":\"7c2ed0a04259b0f8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/schema.js\":\"cbcde01c50bc9c29\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/spreadBlockDates.js\":\"52b8e9483fc7c84d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/spreadDatesAction.js\":\"611130c9cb33dde4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/today.js\":\"d68cacd479f812a9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b7d9c16442cedd78\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ef9fdb1c70fd559e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/audit.js\":\"32723734c3d4599a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/auditAction.js\":\"e97a217a3385ec4d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/auditRanges.js\":\"84d50cdc2510c795\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/diagnosticsSource.js\":\"345f1622750cd33f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/divergenceScan.js\":\"fbc1c530ee1e94cd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/index.js\":\"f326cdd2b86dc33a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4a387d9034907719\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/referencesMirror.js\":\"70df785bb8bbe8c8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/rowJson.js\":\"74d4d669760b1679\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/schedule.js\":\"c92a2031b7f37b54\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/data-integrity/store.js\":\"6e09aa9705018b78\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-maintenance/action.js\":\"068f44d6ea302ab9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-maintenance/index.js\":\"2f008c1a9413364f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-maintenance/plugin.js\":\"ccc521f3081b3755\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"fdb8ebaef5d5ce4f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/actions.js\":\"64e1da8a0d361219\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/changeMarker.js\":\"1d3c4c5f4f629e6b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/diagnostics.js\":\"4bc82be9ffe171e3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/fileSystemAccess.js\":\"274380ef92828689\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/filenames.js\":\"0c5718b5640ebf1d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/index.js\":\"d144cbf3b279beae\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/mirror.js\":\"def63f33d32f9917\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/runLock.js\":\"7a55601c20aad345\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/runtimeHealth.js\":\"b8935e2c51166f04\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/schedule.js\":\"cf838cb448dbfee7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/db-mirror/store.js\":\"9f05de43aff61733\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/default-themes/index.js\":\"1004521f03e47bb1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/default-themes/themes.js\":\"54528f161fc6e18c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/diagnostics/facet.js\":\"88c6ee156a8969b2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/diagnostics/useDiagnostics.js\":\"cde0715e2b7066cb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extension-prompts/dismissals.js\":\"aee2949a7d61564f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extension-prompts/index.js\":\"053ee698a440a966\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extension-prompts/status.js\":\"538b424060f47a5f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extension-prompts/store.js\":\"f56ffc38c10cfc13\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"bd9209cece711bfb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/ExtensionsSettings.js\":\"03a1e190b4d81f17\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/actions.js\":\"d9ed23c96b16e1d3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/config.js\":\"9b36a13cbf487910\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/dataExtension.js\":\"3aa5397919f22f11\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/effect.js\":\"ad8e7403154f4ed3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/index.js\":\"d1b8538ac7b7d0cf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/propertyEditorOverride.js\":\"2d10152d6a79a2c8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extensions-settings/useToggleTree.js\":\"b50a6ea918020687\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/ExtractTypeDialog.js\":\"ae3a32464fca5481\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c92100b0be6d74da\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/PropertyShapePicker.js\":\"9e8b0a6095b47a72\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/action.js\":\"3499c004f6aac42d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/extract-type/index.js\":\"bf5fd591b846ccb6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/FindReplaceDialog.js\":\"3bc446f134075d42\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/HeaderItem.js\":\"5aaa04a6cd99d8da\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/dataExtension.js\":\"9b0855b33ed2c1fe\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/index.js\":\"261e2b48f12a52cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/search.js\":\"22bcebc0eff55628\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/toggleStore.js\":\"117fabf01f4bf61e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/LocationPropertyEditor.js\":\"1800b785e0fa4f09\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/MapView.js\":\"bfe1158251beaf1f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/blockTypes.js\":\"b7375292014b82ec\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/codeMirrorExtensions.js\":\"d6245fe2445589cd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/createOrFindPlace.js\":\"39c4b7a48070fe80\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/currentLocation.js\":\"bdbd0927c0bb51d5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/dataExtension.js\":\"fbb6775bd35ed686\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/geoContentDecorator.js\":\"7f926556f3ce05fb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/googlePlacesClient.js\":\"590284a5787cf905\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/index.js\":\"33c7f965fe3718d8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/locationsPage.js\":\"841f472706e589d7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/mapViewport.js\":\"daaeadb4b07e7223\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/pickCurrentLocation.js\":\"41c54b82d6815472\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/placeAutocomplete.js\":\"d296263aa3a79261\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/placeNameCollision.js\":\"3644f1d7d990b60d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/properties.js\":\"b98aad5e16971865\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/propertyEditorOverrides.js\":\"1556c06644fa530e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/query.js\":\"393e8b87b971bd64\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/geo/usePlaceSearch.js\":\"5ad510bc3ea7a6af\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2eb4080818a09095\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0a3b611c94d70659\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a69866901e7102f0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/config.js\":\"238234732935548a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/dataExtension.js\":\"a94c6e898edaf491\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/facet.js\":\"89ebb3f14c82d976\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/grouping.js\":\"f6d4971f08d12a0f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/index.js\":\"9a11bb9b3b2ca233\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1510f5c4ec344881\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/query.js\":\"a0612724cb41249b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/resolveConfig.js\":\"54cd33a314084e06\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1876a3396672a4f1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e1e00fb9090da180\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/HtmlDocumentContent.js\":\"dd079a5071827697\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/HtmlFrame.js\":\"19439536c0a2a158\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/actions.js\":\"4f5c12f11c226de2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/blockType.js\":\"a934ee58f39b00eb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/confirmRunScripts.js\":\"025463d555c57ad2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/dataExtension.js\":\"023dd5d292193ff7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/frameAnnotations.js\":\"00a5a1e954657f02\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/frameDocument.js\":\"c0ba865f64a0e3cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/frameTheme.js\":\"dcfc732e514e5cd7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/index.js\":\"17c6dc0f1364b8dc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/scriptConsent.js\":\"b3d60341dc8541e2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/sourceMap.js\":\"261dd92c4bd52dad\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/html-document/useDocumentScripts.js\":\"3211fecc537f9b1d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/index.js\":\"91fa73724053cb46\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/record.js\":\"4a2fe547adb88a21\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/recordStore.js\":\"96d21ea901e0c7eb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/responsiveness.js\":\"fe9fd0e75a77b35d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/schedule.js\":\"cfc53db8cd8a1655\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/interaction-metrics/sessionContext.js\":\"cd0d4906512a3c4e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d97f3cc167322663\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8be566299351445a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/actions.js\":\"97e9adb2905417e8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/config.js\":\"46c337175915ba98\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/dataExtension.js\":\"bd199c61232ec9bb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/effect.js\":\"c052eda25838d6a7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/index.js\":\"74e06c1c2b60b633\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/keyCapture.js\":\"9b1364b7081fbe2a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/overrideStore.js\":\"2a22da36e31809a2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e40027808488e6fa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/HeaderItem.js\":\"c56846fcb5c80964\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/LeftSidebar.js\":\"a7b290ff855b05c7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/actions.js\":\"067de16ac48b5bd7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/facet.js\":\"09a84965feb0bada\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/index.js\":\"39c2139777dc06df\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/shortcuts.js\":\"44945d4b3d0bcc8a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/left-sidebar/toggleStore.js\":\"606b56ec4748d5c2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/merge-blocks/MergePicker.js\":\"0928fb9fb54bfcdb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/merge-blocks/index.js\":\"ca3771784fbea774\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/merge-blocks/mergeAction.js\":\"2127982adabdf170\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/merge-blocks/strategy.js\":\"5622a3178ef58232\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/Button.js\":\"33ba184d161c4385\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e1c00ca3fdd0e3a0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e34b301d4991997c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/facet.js\":\"21b16c5451b60bc4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-bottom-nav/index.js\":\"46051c0ded207f87\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"864d4fc16dd780cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c65ffdfebadf23e1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"048421d53e983919\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f4d250157c3f4617\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/mobile-keyboard-toolbar/index.js\":\"85613a23dcca96e8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ee87295830e3639c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/blockSubtreeMembership.js\":\"24f448a4315a216e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/contextMenuItem.js\":\"d592bf5813280b23\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/index.js\":\"804fc9732d1dde5d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/moveAction.js\":\"1cce2f4b6778cfb6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/moveBlocks.js\":\"a23bd696d52e1550\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/move-blocks/selectionAfterMove.js\":\"0dc00e1c616e1cdf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/TutorialBanner.js\":\"d12bebff8f3bbce1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/action.js\":\"35dc08211a187fa7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/bannerDismissal.js\":\"19b9787e09a895b5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/documents/cheatSheet.js\":\"db76fbf1936c781b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/index.js\":\"87e2dbbc43b47c6a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/keys.js\":\"c8692eba67a93190\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/landing.js\":\"62220a6a2f41f8b2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/outline.js\":\"5f23760805ff039f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/onboarding/seed.js\":\"5fb690fef5112e6a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/PerfTrendDialog.js\":\"96d74c101f99bb7f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/analyze.js\":\"326b087b111a2b2c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/diagnosticsSource.js\":\"81d97cd3e777929d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/index.js\":\"387fc68f1aaa6d4a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/load.js\":\"2864f88d9e46d843\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/monitorRun.js\":\"ed4f8b6c48fdbb32\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/schedule.js\":\"e39c90e69b3ba2e1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/series.js\":\"0b9dfd1f34abb5bb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/store.js\":\"8e85a1a238d52583\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/trendAction.js\":\"9429f556500fa242\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/perf-monitor/verdict.js\":\"8007eabdc47fe3ab\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/plain-outliner/clickToEditAction.js\":\"33a90bf23df4dda6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/plain-outliner/index.js\":\"d2bfed412d440140\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/plain-outliner/interactions.js\":\"63b15e9dce43d6bc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5c766f63a699c758\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/MigrationGate.js\":\"d435ed40e9079344\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/MigrationGateDialog.js\":\"2e9164005512c9f8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/action.js\":\"5397af592ad71841\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/index.js\":\"a9bc92e373f494e2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/localRunMessage.js\":\"390e89504f64ab0d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/plugin.js\":\"73bb8c200e593917\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/progressReport.js\":\"1aede0b2553dd32d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/properties-migration/sweepProgress.js\":\"bf0230d0bdb26efc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/FieldRowRenderer.js\":\"9eb99578085c9a08\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/ValueRowRenderer.js\":\"d7b4678f7826ae68\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/actions.js\":\"0f0565c8590d0355\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/autocomplete.js\":\"0238174701b79280\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/fieldRow.js\":\"1738179f82850416\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/index.js\":\"5eec7c910dc085f8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/referenceWarning.js\":\"c9d8bb37d9f7bed4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/valueAutocomplete.js\":\"7cdeae59a04f61cd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/property-rows/valueSchema.js\":\"016613102984b92f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/HeaderItem.js\":\"c68fabb113809790\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/QuickFind.js\":\"104030a9659d22cc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/index.js\":\"7af34e018fa7be49\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/recents.js\":\"05279eb19e18b3fb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/resultItems.js\":\"d8d1ac8a7ade9681\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/selection.js\":\"cfd67882a48da8b8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/quick-find/toggleStore.js\":\"9da1b107fae811bc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/HeaderItem.js\":\"85b03b694a071eee\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/RecentsPageBlockRenderer.js\":\"51db6cf8c081d091\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/grouping.js\":\"497e79d69f64220b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/index.js\":\"1a68b9b64a9d273c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/recents/target.js\":\"a890cd46481e59f4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/codeMirrorExtensions.js\":\"9320417f831016ec\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/contentPrefill.js\":\"18215560d5c49b1c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/dataExtension.js\":\"c35182d2c1a8f0ee\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/index.js\":\"4455b268eeb8de15\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b3cd6adaea27eb7e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/invalidation.js\":\"80837d55189a751e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/localSchema.js\":\"c69b2ad16632e4e0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/blockrefs/index.js\":\"87ab9e849ca6a55c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8e28cd933790d0c0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/index.js\":\"92db82d4af57cda5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/referenceNode.js\":\"0e29192780fa0d1d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/remark-reference-occurrences.js\":\"31bd936ac73d12dd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"62a0715d4d673fd1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/wikilinks/index.js\":\"f5ed9f024a747d62\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d3f0207f2ba054ff\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d871095b6dd7042b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/mergeRetargetProcessor.js\":\"10704be7915c0521\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/parseFence.js\":\"d07d1dc560678c6d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/referenceParser.js\":\"d2dc4c2299cbcdd9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/referenceProjection.js\":\"6ff7e0b99da3d49c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/referencesProcessor.js\":\"af4201d2d1b5b8c2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/renameProcessor.js\":\"862cfd855d573f11\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/references/spanReplacement.js\":\"27bd234c620cb732\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/rich-paste/htmlToOutline.js\":\"de82f576b3a48889\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/rich-paste/index.js\":\"18516b2383f99dd3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/rich-paste/normalizeClipboardDom.js\":\"67c6b9773d0579cd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/rich-paste/pasteDecision.js\":\"c37cf4c683d5ea0b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/action.js\":\"a8336ed1d55c892d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/blockIds.js\":\"b202debfd4b7653c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/content.js\":\"80beadd37c7cb646\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/effect.js\":\"a226d878cd097530\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/ids.js\":\"5aa65bb3016debe1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/import.js\":\"f926ac8bbefd0887\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/index.js\":\"185b09f8d07a7a4d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/plan.js\":\"cb687c508f410617\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/plugin.js\":\"592632260dfeccf1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/promotion.js\":\"77fc2eb6afbc8154\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/properties.js\":\"4c5db029eaa2a55a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/references.js\":\"94787d3018c8eac4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/report.js\":\"55206e64955b49c8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/roamMemo.js\":\"88300662cfa62efa\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/runtime.js\":\"bbe4ae635d25e50c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/schemaReconciliation.js\":\"a926739f11462032\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/srsMarkers.js\":\"66ca1927cbb99e9f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/todo.js\":\"05c7fbc6a655d0f6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/typeCandidates.js\":\"d26b7b4744b13475\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/roam-import/types.js\":\"5ceaf95b611b6cc6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/search-health/index.js\":\"6b631c7eef2fbd48\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/search-health/store.js\":\"cc0c81c9d7827d40\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/HeaderItem.js\":\"157e4e98d4263609\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7bdba6018acde777\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/index.js\":\"c9faa394a045ae52\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/model.js\":\"0d1be3e94f1e43bd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/toggleStore.js\":\"e26ffd987ba3eab3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/shortcut-help/useKeyInspector.js\":\"220ae89bde377fb7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"717cbf54d27329e8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/ShellDecorator.js\":\"fdbd32af4d64a7b4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/actions.js\":\"e804882c88afd703\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/exclusionsFacet.js\":\"6251d914559abc36\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/index.js\":\"9d0ffce63605306b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/shell.js\":\"1253eb49036ff7d1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/surface.js\":\"ff7e083ea6fe240f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/spatial-navigation/walker.js\":\"dbc4296437df7166\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1b57e8050b46bf3a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/dataExtension.js\":\"3d467abfd401e6a7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/index.js\":\"80bb1cfdf23935b6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/indicator.js\":\"b7aad28fed4d2dc4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/moveSrsState.js\":\"8b2fb14d0dc4a3a5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"187670de177d7193\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/scheduler.js\":\"72174988e20b31e1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/schema.js\":\"a81e7c8efbb14cd2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"44eca3e674d30c10\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/srsClipboard.js\":\"d49e618a1b8e7e19\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"dc4ee7e33d712194\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f200edd93e259669\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/DeckPicker.js\":\"988f5234cc69e15b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/ReviewControls.js\":\"a5f33d46a730685c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/ReviewDeckRenderer.js\":\"dc5c9e97058e6545\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/ReviewSession.js\":\"45eb43c9aa7554b4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/actions.js\":\"34abcf7df12d5591\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/archive.js\":\"ec9d580906d2f126\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/dataExtension.js\":\"20382317bb1e55ac\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/deck.js\":\"da7caf13232a09b7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/dueQuery.js\":\"816d7fa3afe046a8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/gradeDecision.js\":\"7b85b48657387283\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/index.js\":\"048d5ec7b483bff0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/keyHints.js\":\"c31bf3c5900a6fd2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/reviewCardLayout.js\":\"7cdf8f0813307017\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/reviewProgress.js\":\"715fdf9c28a5d4b7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/schema.js\":\"6996c6f309e7ff61\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/srs-review/useDueCards.js\":\"71a7fbb5c35b30f8\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/startup-metrics/index.js\":\"1e8c1a22757d224a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/startup-metrics/record.js\":\"a46fb3f3ed7103d6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/storage-persistence/index.js\":\"77060686f57ec1f1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/storage-persistence/persistenceStatus.js\":\"cee3cc018a5dba1c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/storage-persistence/requestAction.js\":\"a8e52bddf1b3a717\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/supertags/TypeChipsDecorator.js\":\"066187993606d2c4\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/supertags/codeMirrorExtensions.js\":\"3a80edb7d5724803\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/supertags/index.js\":\"ae03cf926fa347ee\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/supertags/typeAutocomplete.js\":\"08239a731ad9a1be\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d9dc7b57a25996ad\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/actions.js\":\"c566afc6bfef39ad\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/anchor.js\":\"3f3f7b8eac4b4afc\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/events.js\":\"88e393e2d02e4e36\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/gestureActions.js\":\"5dd0f2ec96b21399\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/index.js\":\"8b7a8022b92ed925\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3d69e3d098cfa28f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/sync-metrics/collect.js\":\"101428048dce67fb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/sync-metrics/index.js\":\"5cb6b2eddaa8f5b6\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/sync-metrics/record.js\":\"02414a1d2fff1863\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/RejectionDialog.js\":\"58c99f4f433de115\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/SystemStatusHeaderItem.js\":\"df9452c7a145c803\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/index.js\":\"0e8cf20c95fd5370\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/model.js\":\"e14e3d3c5be25480\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/queueCounts.js\":\"9359042ccde65026\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/rejectedHelpers.js\":\"4981e97490e8d958\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/rematerializeAction.js\":\"dcac591aabac0e5a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/system-status/useHysteresis.js\":\"640269f7b493ce51\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/ColumnHeaders.js\":\"1df0b13f74f749f3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/TableLayout.js\":\"18aba9168d199523\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/actions.js\":\"57dc5dc51ed25726\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/cellEdits.js\":\"4f5a1231ef498889\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/columns.js\":\"7518f6c3e914244c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/controller.js\":\"df63b8c03efaea57\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/convert.js\":\"c2c0a5922f91bfd2\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/dataExtension.js\":\"f07fd696c3c17f34\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/index.js\":\"a662f3b393c063c9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/keys.js\":\"b1b0bb3a358d29d7\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/model.js\":\"76d5fe7308304474\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/registry.js\":\"2026c9ef3cd9a5c1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/tables/schema.js\":\"5ab7121425f6d0b5\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/theme-toggle/effect.js\":\"b9bab277715cdde9\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/theme-toggle/index.js\":\"ebd6f42983e72bdf\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/theme-toggle/theme.js\":\"ba75564526c7a265\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/todo/actions.js\":\"e1c4c808c59fc921\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/todo/dataExtension.js\":\"d2d9af08e6b86a59\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/todo/index.js\":\"59985c66bd520b8a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/todo/schema.js\":\"e4e9548bc9de5af1\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d7b96f6161309dd3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/actions.js\":\"1b4c103a6f850d62\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/defaultItems.js\":\"628f5834202363fe\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/facet.js\":\"df229c43f1dbae8a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/holdRecognizer.js\":\"ec01a04c5e22122c\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/touch-selection/index.js\":\"4d48d85eae78c4d0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/update-indicator/UpdateIndicator.js\":\"d8cf08e484df17d0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/update-indicator/index.js\":\"7a99be505af5c850\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/update-indicator/loadTimes.js\":\"44ad3ad756586e2b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/VideoNotesRenderer.js\":\"8426e4a07012d957\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/VideoPlayerRenderer.js\":\"9527d80990ec26ac\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/VideoTimeStamp.js\":\"7862d7555bda7363\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/actions.js\":\"5ecb7d898108aa09\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/index.js\":\"d563cc37dbb0032f\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/markdown.js\":\"7ddba97f463db1e0\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/notes.js\":\"1facca52a0a36955\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/registry.js\":\"d362592c90f3cd8d\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/remark-timestamps.js\":\"7915716334294c11\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/video-player/view.js\":\"ea602a54e67b132b\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-link-hints/LinkHints.js\":\"383f318a2af82dfd\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-link-hints/index.js\":\"5a27005a55224a5e\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-link-hints/model.js\":\"cd259c93e8a5a9ae\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-link-hints/settings.js\":\"cc8a3974a6bd00e3\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-normal-mode/actions.js\":\"840eb7f9e9ddc705\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-normal-mode/index.js\":\"cf0db9d5e9f1f5eb\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/vim-normal-mode/interactions.js\":\"cbec9ba6af5eda2a\",\"/knowledge-medium/pr-preview/pr-1823/src/plugins/workspace-header/index.js\":\"4b0830ff62067af5\",\"/knowledge-medium/pr-preview/pr-1823/src/registerServiceWorker.js\":\"f4721417d62a842a\",\"/knowledge-medium/pr-preview/pr-1823/src/requestPersistentStorage.js\":\"4e4c413ae414aa69\",\"/knowledge-medium/pr-preview/pr-1823/src/services/authRequestDeadline.js\":\"4293b40066786887\",\"/knowledge-medium/pr-preview/pr-1823/src/services/authStorage.js\":\"69afe44398d1afc0\",\"/knowledge-medium/pr-preview/pr-1823/src/services/powersync.js\":\"0d3a08c9efe040ec\",\"/knowledge-medium/pr-preview/pr-1823/src/services/supabase.js\":\"3607658311593998\",\"/knowledge-medium/pr-preview/pr-1823/src/services/uploadErrorClassifier.js\":\"91b73c61c1c65d3e\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/ActiveContexts.js\":\"9be88c2d6a9d6038\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/HotkeyReconciler.js\":\"f1c11f9e53df1104\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/WipeLocalDataDialog.js\":\"83354eeb83131e72\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/actionDispatch.js\":\"e90e77bef05a1051\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/actionRefItems.js\":\"bfa26968bba66beb\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/applyKeybindingOverrides.js\":\"5d341ad5f5f6e6e2\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/blockActions.js\":\"d3c788b1e619a916\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/canonicalizeChord.js\":\"9b54547db0745a47\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/defaultContexts.js\":\"bc9b44d1d4ae8a41\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/defaultShortcuts.js\":\"a5cc0e9946f47586\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/effectiveActions.js\":\"19132af918dbdee1\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/gestureAction.js\":\"2c92dd103269666a\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/gestureBinding.js\":\"9bee04761c0d7cc9\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/holdRegistry.js\":\"f189a1276fbaee6f\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/keybindingConflicts.js\":\"c318b4b092804701\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/keybindingOverrides.js\":\"9d206388640bb158\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/pointerAction.js\":\"37899663e0fd54b7\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/resolve.js\":\"4cc3594ebe9afda8\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/runAction.js\":\"f4afaedc09fa2906\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/sequenceMatcher.js\":\"dc1c43044cfab169\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/types.js\":\"509f366a937bebd9\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/useActionContext.js\":\"0fb52242ca858b65\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/useActionDiscovery.js\":\"da8d1cad0abf940e\",\"/knowledge-medium/pr-preview/pr-1823/src/shortcuts/utils.js\":\"87ae83e4aa41d206\",\"/knowledge-medium/pr-preview/pr-1823/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1823/src/sw/bootStore.js\":\"e5edfc3a39c2f83b\",\"/knowledge-medium/pr-preview/pr-1823/src/sw/previewDatabases.js\":\"b67b8c594e2b0e9e\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/byteTransform.js\":\"2e62d00f2badcf14\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/attachmentCleaner.js\":\"97b803aaba6370ca\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/attachmentParts.js\":\"bc6cf8ce4b3098bb\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/bundleParts.js\":\"73bf62696ac83a63\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/bundleRecord.js\":\"00008a9b32ba1a6a\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/manifest.js\":\"3938a7292f9cc7fe\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/takeBundle.js\":\"4cbe0d17b10907e8\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/bundle/verifyBundle.js\":\"22d29d40caa609d4\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/cleaningStage.js\":\"d07055be41008199\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/conversionKey.js\":\"a1bf13645d3f06e5\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/conversionServer.js\":\"48af673a7928295a\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/flip.js\":\"535227491f27070c\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/flipAttempts.js\":\"26b81130c2c16356\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/pages.js\":\"ad46fc49188f47f0\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/preflight.js\":\"29349fd055bfbde1\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/reseal.js\":\"d300d0c4c59136db\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/runConversion.js\":\"940f5b2dd372a20b\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/runLock.js\":\"81f37fa3e529bd9b\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/sealing.js\":\"86cf64d5fcd9b306\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/sealingStage.js\":\"4e6de42729df9cf4\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/stage.js\":\"2320baf4036ac2be\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/conversion/verifyReseal.js\":\"2e263ac7a147b714\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/aad.js\":\"ed28f777ca322826\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/aead.js\":\"3424b350a545c890\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/base32.js\":\"56292bc3b453407c\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/base64url.js\":\"abe697a43b3af4b7\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/binaryEnvelope.js\":\"42ed7e4a3e50125e\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/byteAead.js\":\"0f741c5a8f1c01a4\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/canary.js\":\"a4ac073bc791d533\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/contentHash.js\":\"7cde710ab712d6e9\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/contentKey.js\":\"dec47923a73d56b5\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/derivedIdNamespace.js\":\"116c518b52c83e23\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/envelope.js\":\"b7d2677dc26b52e1\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/hex.js\":\"b124e72a29005c34\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/sha256Hex.js\":\"0551de7a816ea9f1\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/crypto/workspaceKey.js\":\"e404fbd4f7e4d2ed\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/conversionState.js\":\"a1900b1e9ee5c628\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ed0ca4f3cd0f7290\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/flows/pastedKey.js\":\"7bc8a81df8b5c7f9\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bf82f1bd2fa5c549\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e78a21bec2049a5e\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/keyStore.js\":\"3c7e33b3d7ee9d55\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/mintWorkspaceKey.js\":\"7aef3ebbe3cbaea3\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/modePin.js\":\"9264666b5c04be63\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/openWorkspaceKeys.js\":\"b21095741967749a\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/resolveWorkspaceEntry.js\":\"21d3d7fbe2210ab2\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/resolver.js\":\"5e908fb81224cc37\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/keys/workspaceAccess.js\":\"4a1490c62277164b\",\"/knowledge-medium/pr-preview/pr-1823/src/sync/transform.js\":\"484de256d80a3728\",\"/knowledge-medium/pr-preview/pr-1823/src/themeBootDefaults.js\":\"058b6dc1fecd1af8\",\"/knowledge-medium/pr-preview/pr-1823/src/types.js\":\"d994f15ab8bf84fc\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/ClientLocalSettings.js\":\"c9be09327fe54c12\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/abortableSleep.js\":\"76bafb22700f9731\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/array.js\":\"8f16f3c6acd66e8f\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/backlinkAutocomplete.js\":\"5a86947cee2e12c3\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/blockCrumbs.js\":\"64ea423453527de5\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/blockrefAutocomplete.js\":\"79a6f8bcdcb773ca\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/cadencedIdleJob.js\":\"e0f5f0b0a712d184\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/callbackSet.js\":\"9c124fbbdb34a1e1\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/clientId.js\":\"bddf2606f1dc2bbb\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/codemirror.js\":\"a8183d4f070da835\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/codemirrorCompletion.js\":\"39b562d79e121611\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/copy.js\":\"b0ba3baa43189d0c\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dailyPage.js\":\"22cdebf9f7da4fc0\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dbForensics.js\":\"457a7a76642faa7b\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dbForensicsHooks.js\":\"407001e3bae0b594\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/deleteBlockThroughUi.js\":\"b627e981cb86fc63\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dialogs.js\":\"b991ac6c57fe94a2\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/dom.js\":\"9a919a71e5599baf\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/downloadBlob.js\":\"b3d879ee07fb3edc\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/exportSqliteDb.js\":\"ec5440889d566a23\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/fileSystemAccess.js\":\"c20fa685359c7983\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/flipSlide.js\":\"d4a6adbcf7bcd98b\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/fnv1a.js\":\"c677d444f3effc2c\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/formatBytes.js\":\"1c820d49dbc157b7\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/fuzzyRank.js\":\"5d263f9efcd5a595\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/idbKeyedStore.js\":\"59e57b20e9eb3cf1\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/idleCallbackPolyfill.js\":\"0514b1e4ff580726\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/keyboardAwareScroll.js\":\"068ce7a6853c4c00\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/keyboardViewport.js\":\"b305a0e06dcf2151\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/lastWorkspace.js\":\"65fd3bc5f758c9c9\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/layoutColumns.js\":\"9ff3673bb1c1d480\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/layoutSessionDom.js\":\"1336aa995457d03e\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/layoutSessionId.js\":\"cd92589b9af0961a\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/linkClickGestures.js\":\"ce54293432dd1fb9\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/linkTargetAutocomplete.js\":\"3be020a3476fad0f\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/localDbCorruption.js\":\"a073edb0f175532f\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/localDbRecovery.js\":\"9abffb7cce07c8e4\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/markdownParser.js\":\"0e0e5d58946a5f22\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/memoize.js\":\"7412b5f4ce21cdd4\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/nameFieldCommit.js\":\"4cd21ab876e21324\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/nameList.js\":\"f51e0cc4ad670c07\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/navigation.js\":\"7003ae71fac9bedd\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/omnilinerNamespace.js\":\"ea4d8dc79d642673\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/opfsPageScan.js\":\"b294f4f3b723a092\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelClearance.js\":\"43e9df2e7d5cbb9f\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelHistory.js\":\"3a44a267858ac7a0\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelLanes.js\":\"5dff71ac5c2d3e57\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelLayoutProjection.js\":\"63e5d3897b55cbbc\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelScrollAnchor.js\":\"d549f3b5b7fd473b\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/panelUrlFlags.js\":\"4d63553f6c1675aa\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/platform.js\":\"b8537798d875b03e\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/pluralize.js\":\"31ff03458c388a9d\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/propertyCreation.js\":\"e7d2a8ef1ef0ec5e\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/propertyNavigation.js\":\"4ce99c8f764d59f3\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/propertyValueContext.js\":\"58b10ee581475384\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/react.js\":\"69eb1f7e27f2e3c3\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/relativeDate.js\":\"507b918d3ad4e95a\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/relativeTime.js\":\"ef4bb2f3d6c3f7d6\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/renderScope.js\":\"452e731998fa5999\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/resolvedThenable.js\":\"73a9702defb37123\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/routing.js\":\"8d8848bfee4027e3\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/safeMode.js\":\"e67053298146bffb\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/scheduleIdle.js\":\"6c40bad51be25eba\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/screenWakeLock.js\":\"e372f3ad2cdffdfd\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/selection.js\":\"502db9d93216a846\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/softKeyboardGrab.js\":\"fc14a88d0d467b93\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/startupTimeline.js\":\"e67d5f90c37a3022\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/state.js\":\"620ff92955fdccb4\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/string.js\":\"c0ad7fe6b0db3ff5\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/surfaceZoom.js\":\"85b0b0f001c73946\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/time.js\":\"4510b3d9ffb6e1b7\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/toast.js\":\"10627b3ac479cb3b\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/toggleStore.js\":\"0d789cd1f4d8f74b\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/untilStopped.js\":\"bf2910d5bdcc918e\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/userActivity.js\":\"2558d41df0fbac3c\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/viewTransition.js\":\"b86aba8513a9d319\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/viewport.js\":\"fabe7b0d9860ff18\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/webLock.js\":\"3fbd5ee7ea1e02b8\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/workspaceRecovery.js\":\"db50f432925070f4\",\"/knowledge-medium/pr-preview/pr-1823/src/utils/workspaceSnapshotStore.js\":\"42f78ae8a759520b\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-compiler-runtime.js\":\"8d4a6266962c57a3\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-client.js\":\"0782e3dcb8287e12\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-server-edge.js\":\"e4d0da6b916f70b5\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-server.js\":\"283831e668ca3f7e\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-static-edge.js\":\"02cffea474d801be\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-static.js\":\"1d4b9291c5518644\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom-test-utils.js\":\"18da1a3f5eedc244\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-dom.js\":\"0c5122b7ab32abce\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react-jsx-runtime.js\":\"079d7559cb850542\",\"/knowledge-medium/pr-preview/pr-1823/src/vendor/react.js\":\"c8fcda317004b35e\",\"/knowledge-medium/pr-preview/pr-1823/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1823/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1823/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
