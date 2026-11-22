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
		buildId: "bf3044c0e1fb-6afe52d8",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1824/\":\"7d385d4db39eae0a\",\"/knowledge-medium/pr-preview/pr-1824/index.html\":\"7d385d4db39eae0a\",\"/knowledge-medium/pr-preview/pr-1824/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1824/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1824/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1824/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1824/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1824/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1824/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1824/assets/FacadeVFS-GSLI7geU.js\":\"153d99ba14473fca\",\"/knowledge-medium/pr-preview/pr-1824/assets/OPFSCoopSyncVFS-DKGUL5TC.js\":\"0dab2ef6730e12a5\",\"/knowledge-medium/pr-preview/pr-1824/assets/OPFSWriteAheadVFS-Dy7L0R-a.js\":\"cd10466662d4f63b\",\"/knowledge-medium/pr-preview/pr-1824/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1824/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1824/assets/wa-sqlite-async-Cs-GEafE.js\":\"4c5569f1037cbc51\",\"/knowledge-medium/pr-preview/pr-1824/assets/wa-sqlite-uCPb-WrG.js\":\"4c1de337fde614c5\",\"/knowledge-medium/pr-preview/pr-1824/assets/worker-N5piqha4.js\":\"22e15a6afbf9c1c6\",\"/knowledge-medium/pr-preview/pr-1824/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1824/chunks/app-dBKQiDIh.js\":\"e8e1df082bf823ad\",\"/knowledge-medium/pr-preview/pr-1824/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1824/index.js\":\"16f98de3b324a8ab\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1824/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1824/assets/AccessHandlePoolVFS-BcUDhLc2.js\":\"8a4a57819c18ba36\",\"/knowledge-medium/pr-preview/pr-1824/assets/IDBBatchAtomicVFS-DKs0UQj1.js\":\"c3f51ef60ab7c951\",\"/knowledge-medium/pr-preview/pr-1824/assets/MemoryVFS-B0T3B7ou.js\":\"210d01ae52415bee\",\"/knowledge-medium/pr-preview/pr-1824/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1824/assets/mc-wa-sqlite-Dilk3C6N.js\":\"1be512772161cc84\",\"/knowledge-medium/pr-preview/pr-1824/assets/mc-wa-sqlite-async-BFsow399.js\":\"37dace6dbbda40c6\",\"/knowledge-medium/pr-preview/pr-1824/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1824/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1824/chunks/AccessHandlePoolVFS-ByYUnvxI.js\":\"03481adabc560474\",\"/knowledge-medium/pr-preview/pr-1824/chunks/FacadeVFS-BYwvRXUN.js\":\"f4478be2165002df\",\"/knowledge-medium/pr-preview/pr-1824/chunks/IDBBatchAtomicVFS-2SVPoTWK.js\":\"18b11d42b852e866\",\"/knowledge-medium/pr-preview/pr-1824/chunks/MemoryVFS-agZBOipS.js\":\"fa11ceb7b7a5dc23\",\"/knowledge-medium/pr-preview/pr-1824/chunks/OPFSCoopSyncVFS-3PaImnkY.js\":\"36c1969dc37e2786\",\"/knowledge-medium/pr-preview/pr-1824/chunks/OPFSWriteAheadVFS-Dg7w1EAQ.js\":\"d9ddcfefd90d6547\",\"/knowledge-medium/pr-preview/pr-1824/chunks/Preview-Bc24q9Ym.js\":\"34bee8ce49f58695\",\"/knowledge-medium/pr-preview/pr-1824/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1824/chunks/card-DKorZyMU.js\":\"d826bffca9a92fbb\",\"/knowledge-medium/pr-preview/pr-1824/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1824/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1824/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1824/chunks/dist-CVc1RIhP.js\":\"67c3a17cc80c7d8d\",\"/knowledge-medium/pr-preview/pr-1824/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1824/chunks/mc-wa-sqlite-Dr8PffAg.js\":\"3234fb1c44eddf36\",\"/knowledge-medium/pr-preview/pr-1824/chunks/mc-wa-sqlite-async-Ba5c_Xli.js\":\"6f9270ec4f05c9e7\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-BDFjf27K.js\":\"b66de61b3e5464ba\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-Bta0fuSe.js\":\"e85d15e295a269b7\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-CLnS9YsQ.js\":\"bf554afae2e44d55\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-Cg9d5WJZ.js\":\"1113c1f3a40b8e29\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-CzYoZDBc.js\":\"c78d188c650b2100\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-D6GGTppu.js\":\"05a9f7b5ce042627\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-DelpJTUL.js\":\"c7a4e1f84f49b920\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-Xz8i-QM7.js\":\"ebad13159f1271d3\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-dom-server-legacy.browser.production-C8DCo3oo.js\":\"290c488efeabe88a\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-dom-server.browser.production-BV1crqSz.js\":\"471daafc21f0fe73\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-dom-server.edge.production-Ce0kZjP9.js\":\"f833360e9c99be44\",\"/knowledge-medium/pr-preview/pr-1824/chunks/server.browser-CZ2dtWZ9.js\":\"6ba94ebf256b808b\",\"/knowledge-medium/pr-preview/pr-1824/chunks/textarea-CciNx_UM.js\":\"f7c64fd387c86d3b\",\"/knowledge-medium/pr-preview/pr-1824/chunks/ui-CbiHqKJE.js\":\"b130acdc54bcd5d3\",\"/knowledge-medium/pr-preview/pr-1824/chunks/wa-sqlite-CeuwJCgd.js\":\"81479d4d583a1e04\",\"/knowledge-medium/pr-preview/pr-1824/chunks/wa-sqlite-async-DeMsmWQ_.js\":\"328334b4eabf1edd\",\"/knowledge-medium/pr-preview/pr-1824/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1824/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1824/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1824/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1824/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1824/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1824/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1824/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1824/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1824/src/App.js\":\"3fe7312691988439\",\"/knowledge-medium/pr-preview/pr-1824/src/appUpdate.js\":\"6c54f200987eb23b\",\"/knowledge-medium/pr-preview/pr-1824/src/appVersion.js\":\"7286678527a782ec\",\"/knowledge-medium/pr-preview/pr-1824/src/bootstrap/initialLayout.js\":\"76c0da436e55f368\",\"/knowledge-medium/pr-preview/pr-1824/src/bootstrap/openWorkspaceData.js\":\"361f3417c5a763a3\",\"/knowledge-medium/pr-preview/pr-1824/src/bootstrap/resolveWorkspace.js\":\"c7b97f135c6bb1c3\",\"/knowledge-medium/pr-preview/pr-1824/src/bootstrap/workspaceBootstrap.js\":\"4c5ecc982c53da8c\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockComponent.js\":\"5a2c48870b6f8e3b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockCrumbs.js\":\"0c48013a5914f1c6\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockEditor.js\":\"ae3e909dc9688901\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockLoadingPlaceholder.js\":\"8a7a8a62569ecda4\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockProperties.js\":\"0d4deb015bde9f9f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockSearchPicker.js\":\"01a0d194e0776361\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ConfirmBulkDeleteDialog.js\":\"aa42fa979a77e9ae\",\"/knowledge-medium/pr-preview/pr-1824/src/components/DividerHandle.js\":\"a13ad986211fb0e3\",\"/knowledge-medium/pr-preview/pr-1824/src/components/DraftEditor.js\":\"c698b1d4af26b1e9\",\"/knowledge-medium/pr-preview/pr-1824/src/components/GutterPill.js\":\"adfe47990f108270\",\"/knowledge-medium/pr-preview/pr-1824/src/components/Header.js\":\"1b84e77f44fe843e\",\"/knowledge-medium/pr-preview/pr-1824/src/components/LazyBlockComponent.js\":\"8ad59c1746a24076\",\"/knowledge-medium/pr-preview/pr-1824/src/components/Login.js\":\"63d3f6107571bba7\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ZoomableSurface.js\":\"e3534e43e4707ba7\",\"/knowledge-medium/pr-preview/pr-1824/src/components/editModeKeepalive.js\":\"3abcdb253ab10dd3\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fd8afb3eb56967c9\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6d62088d0028d6b3\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/RefPropertyEditor.js\":\"6afdce0d5f4cbb97\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/RefTargetTypePicker.js\":\"fc57a4231a64e282\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/SelectPropertyEditor.js\":\"31b0e5aeeb7b8a9e\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/TypesPropertyEditor.js\":\"a31da5c2de704a6a\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/defaults.js\":\"529f67de603e808a\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/kernelValuePresets.js\":\"85f57f452f10ac4f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/selectablePresets.js\":\"b64673655db16522\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/typesPropertyUi.js\":\"67797a9e2fa1c583\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/AddPropertyForm.js\":\"d9931d8df19a037f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/PropertyPicker.js\":\"7b8a85cf35969a0e\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/PropertyRow.js\":\"d105b4083a44a57f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/Rows.js\":\"7f0b5a8d073c2f32\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/actions.js\":\"4fb2be3567acbbe0\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/declarationOnly.js\":\"27b3cff18d140b3b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/layout.js\":\"dd86655ca1826141\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/model.js\":\"51fb0c99af9327cf\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/shapeUi.js\":\"ca8a1520efbabe19\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/shapes.js\":\"d3156dda6c97a6c2\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9ab99cf69557a8eb\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/visibility.js\":\"7eef7f77045a1700\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanelSections.js\":\"e33a7144780ada02\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/BlockEmbed.js\":\"6815d362e69c7489\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/BlockLink.js\":\"040701ace2719f02\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/BlockRef.js\":\"2adec782a56fb5cb\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/ReferenceLink.js\":\"10874804cdb9092b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/cycleGuard.js\":\"b919c089639b21c7\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/cycleGuardContext.js\":\"4e99e152e8d1a3df\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/linkInteraction.js\":\"39f24208756d2f9e\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/referenceLayout.js\":\"a8d33472d1003772\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/useBlockRefAncestors.js\":\"234ca43d8964e00c\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/BlockGutter.js\":\"fd26567a6bf3dd43\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/BlockInfoDialog.js\":\"c06a5f6f39cf2b92\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/BlockTypeBlockRenderer.js\":\"5346cf0526020374\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/BulletHoverCard.js\":\"12af9d05e69a2813\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/CodeMirrorContentRenderer.js\":\"4b3adf91e9daabc6\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f1e6e2ef5e022e67\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/ColumnResizeHandles.js\":\"278960c42c158d7b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f8c30918192ccb15\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/DefaultBlockRenderer.js\":\"51b341c6f907cee8\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/LayoutRenderer.js\":\"c0328bf3fb2d0d80\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/MarkdownContentRenderer.js\":\"26eb50be61ba6299\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/MissingDataRenderer.js\":\"2fd861a1d32d5673\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/PanelRenderer.js\":\"4d2664cc6a26add3\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/PropertySchemaBlockRenderer.js\":\"03c0d490603a1205\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/TopLevelRenderer.js\":\"0851464238e0c707\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/blockGutterMode.js\":\"f748ef67b45bb5e2\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/blockTitleText.js\":\"f781586ca7c12b93\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/fieldCreationKeydown.js\":\"bbed64b0eafd47fe\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/layoutRootContext.js\":\"0908ffa5e843def2\",\"/knowledge-medium/pr-preview/pr-1824/src/components/typeChip/TypeChip.js\":\"7d94e88a4bed36de\",\"/knowledge-medium/pr-preview/pr-1824/src/components/typeChip/chipStyle.js\":\"256ff91d186fc670\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/anchored-floating.js\":\"38163f27f24ce87e\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/button.js\":\"b2cf8789b207cfaf\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/card.js\":\"f37daa2abbbfb36d\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/checkbox.js\":\"d041f669b49f445d\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/collapsible.js\":\"43dac32d4af3ebfe\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/command.js\":\"dc04e25f07df7d9d\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/context-menu.js\":\"7dcd8fcf6c349595\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/dialog.js\":\"24a0b94ac35f4152\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/dropdown-menu.js\":\"cfd5722b6684ad5f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/floating-listbox.js\":\"51ce272721e1125c\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/index.js\":\"0bb3eb48e4e09e7d\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/input.js\":\"013fb68b5ab278fa\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/kbd.js\":\"ed599f7d37d69450\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/label.js\":\"6983d1b981d271e1\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/textarea.js\":\"c832b194427858b0\",\"/knowledge-medium/pr-preview/pr-1824/src/components/useEditModeYieldKeepalive.js\":\"5c6c48ad3fe7ca4d\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/BootFallback.js\":\"77feb94e0fd6800f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/FocusedRowLazyMount.js\":\"dbc3eaa5e9cbfe5b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/LazyViewportMount.js\":\"44316f6feb39fedf\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/LocalDbCorruptionFallback.js\":\"05662d6909657108\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/error.js\":\"b4acc50aeba7fc9e\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/lazyMountRegistry.js\":\"3d80b055681c26de\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/suspense.js\":\"998a6bdd1a9fc228\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/CreateWorkspaceDialog.js\":\"000d0e66ff9640ae\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/PendingInvitations.js\":\"b750df94cd2cae3f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/SyncProgress.js\":\"3d916e83374a8f2e\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/UnlockProgress.js\":\"6b9f87999bbcbff0\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/WorkspaceKeyGate.js\":\"4900c8b36773f319\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/WorkspaceSettingsDialog.js\":\"99f8e76a2ce97179\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/WorkspaceSwitcher.js\":\"807f75a010c23546\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/WorkspaceSyncGate.js\":\"b2c683f0f13b277b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/ConversionFlow.js\":\"db01152e57200c8f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/ConversionFlowHost.js\":\"065ac6d1ad7d9b11\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/EncryptionSection.js\":\"198b9bcbc78c8913\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/attachmentPrompts.js\":\"d2c89a60e3950cf6\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3e2bb65f4b83db21\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/conversionFlowDeps.js\":\"6c343bf918776f9c\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/conversionFlowStore.js\":\"d3b1109dcc40b82e\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/flowUi.js\":\"cf4df423582cb203\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/useConversionRun.js\":\"9c5140d38ede33e0\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/keyUi.js\":\"f265f6cf899ba06b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/useCloseOnKeyLoss.js\":\"4b0d04d62aa2a0b2\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/useCloseOnServerE2ee.js\":\"04c2b0dde2999bba\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/workspaceUnlocked.js\":\"60fbac81a5595319\",\"/knowledge-medium/pr-preview/pr-1824/src/context/backgroundSubtree.js\":\"b607cee5c87d9582\",\"/knowledge-medium/pr-preview/pr-1824/src/context/block.js\":\"16c0e46f8d7e2e82\",\"/knowledge-medium/pr-preview/pr-1824/src/context/layoutWsContext.js\":\"0418f86181060010\",\"/knowledge-medium/pr-preview/pr-1824/src/context/propertyDisplay.js\":\"ab0a00e575ebb9fd\",\"/knowledge-medium/pr-preview/pr-1824/src/context/repo.js\":\"b10c4d09f40b3baf\",\"/knowledge-medium/pr-preview/pr-1824/src/data/aliasClaim.js\":\"8fc4f93d4f133df3\",\"/knowledge-medium/pr-preview/pr-1824/src/data/aliasSeatNamespace.js\":\"9131f02bdc2b6026\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/blockData.js\":\"bd83d2c611dd8524\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/blockType.js\":\"ec518b23f02f0502\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/changeScope.js\":\"1fbc54bdb92e47f3\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/codecs.js\":\"f8e865d0ab6ed18e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/derivedData.js\":\"a81b97027f1688a2\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/errors.js\":\"970bfb38a6851b09\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/events.js\":\"6e67c7a8b56c961e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/handle.js\":\"59ff27e947f66661\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/index.js\":\"3f9fe50170cf3673\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/mutator.js\":\"431961f072ee1953\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/processor.js\":\"bc4f93789ccb4e70\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/propertySchema.js\":\"86f5676307e78817\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/query.js\":\"f3828ee3aea95e21\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/sameTxProcessor.js\":\"357b3252cf8f3f3d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/schema.js\":\"59ff27e947f66661\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/tx.js\":\"59ff27e947f66661\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/typedBlockQuery.js\":\"cc04725fcbe1eb5b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/user.js\":\"5123872d86e239c5\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/valuePresetCore.js\":\"a011fd042d554221\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/valuePresets.js\":\"b1a19e013fbd9282\",\"/knowledge-medium/pr-preview/pr-1824/src/data/attachmentCleanerIOVerb.js\":\"048a79f8b51ded42\",\"/knowledge-medium/pr-preview/pr-1824/src/data/block.js\":\"313b490bfe48b28b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockCache.js\":\"bd755ac98c7c9e67\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockId.js\":\"02594b942a6c180e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockLiveness.js\":\"4f3f62d707371661\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockMerge.js\":\"4b5df9d5280be79a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockSchema.js\":\"82d20a7f0bb5ef99\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockTypes.js\":\"e105c098a6406aa1\",\"/knowledge-medium/pr-preview/pr-1824/src/data/clientContext.js\":\"be19b82e701f9987\",\"/knowledge-medium/pr-preview/pr-1824/src/data/dbFileSiblings.js\":\"240d97f48cc1cf68\",\"/knowledge-medium/pr-preview/pr-1824/src/data/definitionSeeds.js\":\"6627d8a9e3cb5e82\",\"/knowledge-medium/pr-preview/pr-1824/src/data/derivedIds.js\":\"ebd90d28fe978355\",\"/knowledge-medium/pr-preview/pr-1824/src/data/drawnSubtree.js\":\"1f1ed582493af55d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/facetBridge.js\":\"c9b563f1903ec50f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/facets.js\":\"2ff9314c36abc11a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/globalState.js\":\"e5f3a8e70e6a6d77\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/aliasClaimRederiveProcessor.js\":\"7b6b5526bddc0960\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/ancestorBatch.js\":\"26f5b42a39219a53\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/blockTypeTypeifyProcessor.js\":\"1f1d38efdb4794ba\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/clientSchema.js\":\"bd75522bdf339bdd\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/commitPipeline.js\":\"5ae15be4f8e769e0\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/devAssertions.js\":\"782c690134cd623d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/firstSync.js\":\"befffe1a6b3122ca\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/freshInitialLoad.js\":\"0127a8df572ba014\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/graphBackfillClaim.js\":\"b3dd87a66da92bee\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/handleStore.js\":\"d3097923e319de3d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/idleMarkerJobs.js\":\"ae272870d623fd2b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/initialDownload.js\":\"d565dc7fcea31eb3\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/initializeClientDatabase.js\":\"6971135300f643e2\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/jsonCanonical.js\":\"9e007e86d6afa639\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/kernelInvalidation.js\":\"90764f6e5b72f81e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/kernelProcessors.js\":\"4810ae8f3f9dd1f8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/kernelQueries.js\":\"9f98c3b4d278e9e2\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/mergeTypeMembershipProcessor.js\":\"b37b72c7165ad11f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/normalizeReferencesProcessor.js\":\"e5937f59399f0022\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/poolInstrumentation.js\":\"8c27d32e229789ad\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/processorRunner.js\":\"7ac2d98cb0a1149f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyCellBackfill.js\":\"c1844e5d2fd9f0f6\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyChildMint.js\":\"cc1df9289a8d319c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyChildrenProcessor.js\":\"8fbe3ad100dc018c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyDefinitionChangeProcessor.js\":\"67666ca19027c9bb\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyDefinitionSynthesis.js\":\"2471b9b843a6f307\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyKeyScan.js\":\"0199c6b537a0502c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertySchemaResolution.js\":\"9cc1fda8d23f60d4\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyValueEdits.js\":\"c359a01650ce99ac\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/raiseProtocol.js\":\"276beaf8430d6d6f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/readBatch.js\":\"1fc0fef3b359fdf9\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/refProjection.js\":\"19cae6debfd2901d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/referenceTargetLookups.js\":\"eff18f41d024e239\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/referenceTargetProcessor.js\":\"8d0e5a02a4795ab8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/replayMerge.js\":\"f6bcc3699aa40458\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/sqlBinds.js\":\"a6f236aebb8d57f2\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9760877e3bfff2d3\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/arrivalProcessors.js\":\"0992f4d72fd3c19a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/invalidate.js\":\"ff0ab86281e74756\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/materialize.js\":\"d30b7da737477240\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/observer.js\":\"6497d68c258faa0b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/reconcile.js\":\"c8a36c79b2ec70c1\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/timingMetrics.js\":\"6b8ed03928105d20\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/treeQueries.js\":\"84f7d768c8619f7c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/txEngine.js\":\"f156e30f013e276c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/txSnapshots.js\":\"38a0584da72e2e16\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/typedBlockQuery.js\":\"1f5a36f575a0511f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/undoManager.js\":\"aa3eb0429518d960\",\"/knowledge-medium/pr-preview/pr-1824/src/data/invalidation.js\":\"0a7fcd426fca506c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/kernelDataExtension.js\":\"7cc553a85574de43\",\"/knowledge-medium/pr-preview/pr-1824/src/data/kernelPage.js\":\"506084cd52d62aa8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/kernelValuePresetCores.js\":\"fca2ec72d8a2f28e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/localDbCorruptionSignal.js\":\"6f60f8a26517cad7\",\"/knowledge-medium/pr-preview/pr-1824/src/data/localDbStorage.js\":\"b1d45968941b26d0\",\"/knowledge-medium/pr-preview/pr-1824/src/data/localDbVfs.js\":\"72092ca5b64c3ed5\",\"/knowledge-medium/pr-preview/pr-1824/src/data/localSchema.js\":\"68c1b94e168cf1dd\",\"/knowledge-medium/pr-preview/pr-1824/src/data/maintenance.js\":\"06312da8441e3cb8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/mergeProperties.js\":\"c808a97f9ebbe5a8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/metricsConsoleHook.js\":\"8a144e5dbb69dea4\",\"/knowledge-medium/pr-preview/pr-1824/src/data/migrationsPage.js\":\"0cc32e3a9a749726\",\"/knowledge-medium/pr-preview/pr-1824/src/data/mutators.js\":\"8a8bce6113d78cd9\",\"/knowledge-medium/pr-preview/pr-1824/src/data/orderKey.js\":\"155b2f9a9150e02d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/orderKeyPlacement.js\":\"af160cc1a390f9ca\",\"/knowledge-medium/pr-preview/pr-1824/src/data/outlineSurface.js\":\"dab91ff7af1d9c4f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/pendingEditorContent.js\":\"0e8e394d22635c2f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/pendingUploadsSql.js\":\"1e4fc84312df81a3\",\"/knowledge-medium/pr-preview/pr-1824/src/data/pluginStateExtensions.js\":\"407f35cc15c22134\",\"/knowledge-medium/pr-preview/pr-1824/src/data/powerSyncLogger.js\":\"f5b5ecdd7b6684ff\",\"/knowledge-medium/pr-preview/pr-1824/src/data/projectorRuntime.js\":\"bb8b336d6dc6c3b4\",\"/knowledge-medium/pr-preview/pr-1824/src/data/properties.js\":\"ad6ad440f669a705\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertiesPage.js\":\"ad7f3b4c5c1f939b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyChildren.js\":\"fc316b4a1bdca712\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyDefinitionFanout.js\":\"378ee1de0bb0ec3c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyDefinitionMetadata.js\":\"6120e2350ba71231\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyDefinitionRegistry.js\":\"77e0a39579185f02\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyDisplayMode.js\":\"a41ed5e44e4a24ec\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyRowCreation.js\":\"319258bbf772461f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertySchemaCreation.js\":\"467dff2b5eda77a0\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertySeeds.js\":\"b33901efbf938926\",\"/knowledge-medium/pr-preview/pr-1824/src/data/recentsPage.js\":\"251b5123a1c07080\",\"/knowledge-medium/pr-preview/pr-1824/src/data/referenceBlock.js\":\"f13061c945e52c62\",\"/knowledge-medium/pr-preview/pr-1824/src/data/rejectedUploads.js\":\"6116c7b874b74952\",\"/knowledge-medium/pr-preview/pr-1824/src/data/releasePowerSyncConnection.js\":\"6a1467409f78045c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/repo.js\":\"4543de76eeecbc59\",\"/knowledge-medium/pr-preview/pr-1824/src/data/repoProvider.js\":\"1355d3078dd61034\",\"/knowledge-medium/pr-preview/pr-1824/src/data/rowProperty.js\":\"fa3f3633661a873a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/searchFilter.js\":\"d775e73961e1f4db\",\"/knowledge-medium/pr-preview/pr-1824/src/data/seedIdentityLedger.js\":\"0f63e626d720213b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/stateBlocks.js\":\"6e7e1a88a21d5478\",\"/knowledge-medium/pr-preview/pr-1824/src/data/structuralEditPolicy.js\":\"306938afae8c3297\",\"/knowledge-medium/pr-preview/pr-1824/src/data/subtreeDelete.js\":\"b9dc3131139f7037\",\"/knowledge-medium/pr-preview/pr-1824/src/data/syncStreamLock.js\":\"3a2caf7dc7e1082e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/syncedTableSqlRecognizer.js\":\"d1ea1738a620d65b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/syncedTableWriteGuard.js\":\"f5c42971bcde1b2f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/targets.js\":\"9735a82dc1f0cfff\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeColors.js\":\"2c21e9d023b252b2\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeDefinitionMetadata.js\":\"b356c2fd59474609\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeDefinitionRegistry.js\":\"c63e428551fbf043\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeExtraction.js\":\"5ec295ed25eb899a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeInitialValues.js\":\"14149bb5cc0e4366\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typePropertyGroups.js\":\"ab3c22d96ed6af40\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeSeeds.js\":\"2294bcb1e4332213\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeTagger.js\":\"f6cd11fbf7ed55c8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typedRecords.js\":\"3d2bd7de9f80ebee\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typesPage.js\":\"5899dc5c561f58ef\",\"/knowledge-medium/pr-preview/pr-1824/src/data/userPrefs.js\":\"bd6aa63165e4456a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/userSchemasService.js\":\"d587759d96c7d0a5\",\"/knowledge-medium/pr-preview/pr-1824/src/data/userTypesService.js\":\"08d03bbe9310f70b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/valuePresetRegistry.js\":\"23b8f79dccc10543\",\"/knowledge-medium/pr-preview/pr-1824/src/data/visibleChildren.js\":\"b241a3d01db8e146\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaceConversion.js\":\"80226885ad36f6ca\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaceFirstSync.js\":\"0bb01c26734a30a7\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaceIdNamespace.js\":\"d44304f0a82f3492\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaceSchema.js\":\"fcee6505c5a55acb\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaces.js\":\"d803ed4301ef1633\",\"/knowledge-medium/pr-preview/pr-1824/src/data/writeAheadLog.js\":\"f2ea7239f66a5450\",\"/knowledge-medium/pr-preview/pr-1824/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/BlockPasteShellDecorator.js\":\"4e5fffdfa62fea05\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/atTrigger.js\":\"6c91ff6920405b76\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/autocomplete.js\":\"0d0e5e0a0ed597b7\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/codeMirrorExtensions.js\":\"d737821d4720d333\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/contentFlush.js\":\"bb11a84a61e5abe1\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/defaultInteractions.js\":\"3d1c7b42c5ff3a00\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/editSettleSignal.js\":\"90f039ccf5c1a7bc\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/insertImage.js\":\"5b8cb2e797e65527\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/referenceCompletionRange.js\":\"152710a29297359c\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/referenceTargetTypes.js\":\"583e8673a8724f82\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/syntaxContext.js\":\"79c0aec466040f85\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/triggerMatch.js\":\"ba1ecb927943c78f\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/AppRuntimeProvider.js\":\"fca085fbb13085d1\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/BlockFocusShellDecorator.js\":\"74515279bb87c28b\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/ExtensionRenderBoundary.js\":\"e7c4fbae538e33d3\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/PanelContentRecovery.js\":\"4865bece48ea2111\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/apiCatalog.js\":\"a2b058bbb2daea11\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/approveExtensionHere.js\":\"727a97ed22bbbd45\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/armedCutAppMount.js\":\"91c5b001b7d47c4b\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/batchableKeyedStore.js\":\"67f12703c55dfede\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/blockInteraction.js\":\"1cdf4faf375b723a\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/blockSelectionAction.js\":\"e3dceb513b412c4f\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/compileExtensionModule.js\":\"1e36adb2a74447c6\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/compiledModuleCache.js\":\"09f4a60961340307\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/continuousGestures.js\":\"4ca970f4c9762305\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/core.js\":\"83f4ea4cde47aa1f\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/defaultRenderers.js\":\"785d665b398aa342\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/definitionFanoutAppMount.js\":\"63508292bc8907ee\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/dialogAppMount.js\":\"b71b149625d51a43\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/dynamicExtensionSeeds.js\":\"b2d9467649b626ae\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/dynamicExtensions.js\":\"de6e921d4536853f\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/exampleExtensions.js\":\"359546393acee40c\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionApprovalStatus.js\":\"a0016451d11b7ac6\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionLoadErrorToast.js\":\"406a1192b12b20e1\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionLoadErrors.js\":\"771ee3c9ac2bb470\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionLookup.js\":\"fc335fbdf40538a4\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionToggles.js\":\"45d3177c5e0cd249\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionUtilitiesCss.js\":\"9a816fa143c1ed58\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/kernelPageDeletionGuard.js\":\"f371355cbb0f70cb\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/liveRuntime.js\":\"04d070220576b4ff\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/openExtensionsSettings.js\":\"bead5563226b7477\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/overridesCache.js\":\"e3b0fb5c5ea08940\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/pluginIds.js\":\"71f7e014b646ff50\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/processorRejectionToast.js\":\"b5db3a9300e4e3f1\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/runtimeActions.js\":\"5533723c70d740b9\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/runtimeContext.js\":\"cfddca2146f8edc7\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/staticAppExtensions.js\":\"650625535ee6a3df\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/staticDataExtensions.js\":\"c3d48484846c3496\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/toastAppMount.js\":\"1bb9ed465a61038a\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/useOverrides.js\":\"16f3b5560a140caf\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/useShortcutSurfaceActivations.js\":\"32007f4badcc4620\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/discoverToggleTree.js\":\"ce11402e1b22b09b\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/facet.js\":\"5d8abd10225420ba\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/resolveAppRuntime.js\":\"ec3804fb506338fd\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/runtimeEvents.js\":\"64e5f5a801a5d8c9\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/togglable.js\":\"a62a1e6606546de7\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/variantFacet.js\":\"fc45f74d3047697b\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/verbFacet.js\":\"e4a04d7ae14acb59\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/block.js\":\"963413e1544bace5\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/focusedChild.js\":\"e12d84ca28248c58\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/propertySchemas.js\":\"81cd55b7a17d9867\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/typeRegistry.js\":\"73af612b3bb1006d\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useAncestorCrumbs.js\":\"c7209b42698efe47\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useAutocompleteListbox.js\":\"f3ba6bdb36458784\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useDebouncedSearch.js\":\"dde1019986e75a76\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useDebouncedValue.js\":\"99ad53e57d2d9815\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useIsFocalRender.js\":\"9371f9cbd667904d\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useIsReadOnly.js\":\"cd9f93d43687eaf5\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useMaterializeBacklog.js\":\"38e5d75e76e34f2d\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useMinuteClock.js\":\"101680e2c752bfd7\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/usePanelLayoutProjection.js\":\"001c1b6ee1428d01\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/usePendingInvitations.js\":\"fcab46d9c5802d54\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useRendererRegistry.js\":\"9b5d563ee6bd1564\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useRetainedFieldRows.js\":\"ea9b365692cd17b6\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useWorkspaces.js\":\"d8eaeb9766ba8358\",\"/knowledge-medium/pr-preview/pr-1824/src/lib/utils.js\":\"1c4a0cf774e7703d\",\"/knowledge-medium/pr-preview/pr-1824/src/main.js\":\"064a69eb96d938db\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/MarkdownImage.js\":\"40c40c38c3266022\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/blockSeparators.js\":\"915d4f707925a2c3\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/context.js\":\"fbc064f7790934b9\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/defaultMarkdownExtension.js\":\"7fdf9a67ef590ab8\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/extensions.js\":\"6fa2ffa7e18ff5e4\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/renderMarkdownHtml.js\":\"7a452102253bd952\",\"/knowledge-medium/pr-preview/pr-1824/src/minimal-editor.js\":\"9ba69353b637be1d\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/armedCut.js\":\"967088cd57ea8205\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/captureMediaVerb.js\":\"590a5a97cc14a5b0\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/clipboard.js\":\"515c3291fd891231\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/decision.js\":\"ff47acefca0444fd\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/operations.js\":\"1f1e64b28be9cc94\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/account-header/AccountHeaderItem.js\":\"d99b118d79ac034e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/account-header/index.js\":\"7062a39911fa8001\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"989e3f58077dbda1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/askAgent.js\":\"48e67f0a734236a1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/askedStore.js\":\"7f4aa389ef909242\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1be4ce98134ffb0e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/chipState.js\":\"dc37c153dcd38035\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a59549dd8c9467d2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/index.js\":\"f7abb608c396ac49\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"111cd119fc8795d1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/schema.js\":\"3a10364a103c5c83\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b727ed9206a96515\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ea4a3524939a5717\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/addMedia.js\":\"c6dd32adad142639\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a9c172b40b733189\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/block.js\":\"eba1fdbf12337c95\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/context.js\":\"92407122ea101e60\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9302d2888c162218\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/index.js\":\"43be240b5c021e83\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/outline.js\":\"6ea09edf3f6f8e02\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/properties.js\":\"5b266caba231580f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/refs.js\":\"d0bcb7525fe04842\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5b237a58d2bdb5c8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/search.js\":\"01fc807f083b038b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/shared.js\":\"fff0c8194cb5a60e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"32a102e95422fa48\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/text.js\":\"fa8e37277041edbe\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentWrites.js\":\"35fc0b91b0c35e20\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/authoringCatalog.js\":\"bf6e326fbff5f036\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/blockRefTargets.js\":\"fdf0121d45162529\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/bridge.js\":\"117fe1f2ca046c3b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/bridgeLoop.js\":\"1435537fe05641b7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/changeHistory.js\":\"9aa66d6299decc9c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/commands.js\":\"07ee05f17ca400c2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/commentsCommands.js\":\"76190826eedf8a31\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/dataExtension.js\":\"7b1572bc2caf57de\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/dataModelGuide.js\":\"879662738826fff8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/describeRuntime.js\":\"50145749e548c02e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/extensionLint.js\":\"4f7716556c8d63ea\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/grainAudit.js\":\"2bda9a2c8dd15a28\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/healthCommand.js\":\"b43bd667e72278bc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/index.js\":\"dae247bd6f70b7d7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/presetIdentity.js\":\"dc65393f59753728\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0ae29aa51c89aaea\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/readMedia.js\":\"cf2afc1f6832ecb8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/schema.js\":\"8e71fd5e1d8c09c7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/serialization.js\":\"bda40599bd165f61\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/targets.js\":\"c626c9b76397f535\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/tokens.js\":\"381dea7aa731828e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/watchEvents.js\":\"71cece50995476bd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/workspaceGuard.js\":\"7898139af591b0a8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/writeCommands.js\":\"c5420199467c4747\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/AliasCollisionToast.js\":\"8e3551c9dad6027e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/DuplicateNameBanner.js\":\"82397a866a8ece79\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/collisionMerge.js\":\"d210d5ffab58ba2c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/dataExtension.js\":\"b40c1e93d79c6058\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/index.js\":\"ddbfeebddf307752\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/mergeCollisionAction.js\":\"61e45ccf753ea571\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/pageStyling.js\":\"8c31938c9c163821\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/rejectionToast.js\":\"d1a5f2813a0add42\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/syncProcessor.js\":\"bf4f41b67c448249\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/actions.js\":\"dede659f67034182\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/addComment.js\":\"3365fff565d97f76\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/anchor.js\":\"1d0da9f8b8a988ca\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/anchorState.js\":\"8746a84027492c11\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/commentLinks.js\":\"2cfe4d9df4dc7a10\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/confirmThreadDeletion.js\":\"a11c4b54c6a48687\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/container.js\":\"1fb924d19768d0dc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/dataExtension.js\":\"14c731a39e490367\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/deleteComment.js\":\"f93ac6c7a2864f40\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/highlights.js\":\"99a20e6b7b2ee244\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/index.js\":\"6d21627ae82f160f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/linkedCommentsPill.js\":\"fae94be709f1d3da\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/margin.js\":\"3cae865153a225ca\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/marginSchema.js\":\"38976d05aeb667ef\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/newComment.js\":\"58aed668edaf1094\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/ownThreadPicker.js\":\"f2fd69b54b58b162\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/placement.js\":\"106861234afc59f6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/queries.js\":\"b73bf619cd674e1c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/quotePosition.js\":\"dbc920a6564cc31c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/quotedIn.js\":\"aeb7394a4dea0c64\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/quotedRange.js\":\"2b01f0010c5e45a2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/rangeRefs.js\":\"43aeab6e4b34881c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/readHighlights.js\":\"8f4e34b6daf8334f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/readSelection.js\":\"63f132fc054dce08\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/readSelectionUi.js\":\"0501beebee87416b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/reanchor.js\":\"7179a28421bd328d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/schema.js\":\"fb123168f3d6ab9c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/scope.js\":\"8a14a0fd9e52f498\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/scopeThreads.js\":\"a7ea3269ba85583c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/splitRetarget.js\":\"9da2e302159e9822\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/suggestionCard.js\":\"4063600c0b18e072\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/suggestions.js\":\"47feafdc51c16345\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/summaries.js\":\"d9f45e07c9528d17\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/summaryBatch.js\":\"f59e87109356fcc2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/surface.js\":\"aed0ce1397a67cf2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/threadNavigation.js\":\"4e7156de6b8bca8e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/threads.js\":\"b830e79d835d5ed1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/ui.js\":\"bbc49933801ae09a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/uiStore.js\":\"4033392734dcca61\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/app-intents/appIntents.js\":\"10d287ef839cd6ba\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/app-intents/index.js\":\"2df970d9765d440e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/app-update-prompt/index.js\":\"7739bb76d39a124d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/app-update-prompt/status.js\":\"cec865bdc8b9340e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"1dd59814ec249648\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/MediaBlockRenderer.js\":\"64c0f316498909d0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ec78251ce0c2723d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/MediaUploadReconciler.js\":\"4ffa0b6db452d113\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/assetDownLane.js\":\"e8b85b0a8b225f8d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/assetResolver.js\":\"9d1be6d23cb2d7d0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/assetUpload.js\":\"c1a4d60d6aff56af\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/attachmentCleanerIO.js\":\"22e22c990ebedc29\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/supabaseAuditIO.js\":\"84c84cbae82f0039\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/blobStore.js\":\"41db24297c732b3b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/byteStore.js\":\"15b045ff905f51d0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/cleanerIO.js\":\"9fbb0468ec1243cf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/cleanupAttachments.js\":\"998dde1d37a1981f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/dataExtension.js\":\"0353274c8509d430\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/downLane.js\":\"bf898002abb6db11\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/index.js\":\"561db4d978a31cd6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/insertImageContribution.js\":\"c13f8a843342f248\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/laneArming.js\":\"146749a3b186c93f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/laneLock.js\":\"ddc92dc7deac1bca\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/mediaBlock.js\":\"52d1b766ac826080\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/mediaCapture.js\":\"eef1b39a68310d8f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/mediaViewers.js\":\"bd47f2442011edde\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/mediaViewersFacet.js\":\"2f2f6145c437f3df\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/pasteCapture.js\":\"367ee04441d6145d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/resolver.js\":\"83afcb958a6735e8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/retryUploadsAction.js\":\"4841614dccfac04d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/storagePaths.js\":\"51e2b1988d84aae9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadDrain.js\":\"66a9c28029ba28f4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadLaneStatus.js\":\"5894c6b4938bc5f8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadReconcile.js\":\"4896f2d764340524\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadRecovery.js\":\"0e0ea242f2383a16\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadStore.js\":\"fa8af8dad16046e5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/useAssetObjectUrl.js\":\"d398c4339c33e9e8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0145d1d29b58d72a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/BacklinksViewSection.js\":\"1f6fafe4756b88ca\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/facet.js\":\"b57259942e07e886\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/index.js\":\"e03afb619cd3a67e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/prop.js\":\"40d7083f2ead31be\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/BacklinkFilters.js\":\"f067d6fe0075d381\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"81e998c4869a2282\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/BlockEntry.js\":\"2e503888d6458b65\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/LinkedReferences.js\":\"3dcc69e84d258a1d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e08b67a7aded6f40\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/dailyNoteDefaults.js\":\"febda63d8bd2deb4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/dataExtension.js\":\"909f1ecd3656d352\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/edgeExclusions.js\":\"0696e291a713dd1e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/filterProperty.js\":\"b1a817be217a33f0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/index.js\":\"e310613904e123f3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0f41f89fc6aab29f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/applies.js\":\"85d40a28a27375a2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/countQuery.js\":\"598230a8705e4c71\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/expansionStore.js\":\"121b70babe5dfb03\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/index.js\":\"71e7f01ff77e70bd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5a5f71d94d95b733\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/presentationInvalidation.js\":\"5e4732c4e41788c3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/propertyEditorOverride.js\":\"964a8284754473d7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/propertyFilter.js\":\"aa95de0db91a45e0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/query.js\":\"c3c0ddae2fc7096b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/resolveFilter.js\":\"f865bfcbb2c1dd82\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/sourceBatch.js\":\"3e2f9abf6c2a4d47\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/sources.js\":\"005e0fc2a2492741\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/useBacklinks.js\":\"c94dd4f3b1d22be4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"3740880eec6cd248\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/BirthdayCelebration.js\":\"f84762e25116fdcd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/BirthdayOverlay.js\":\"721c7da50223c3a7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/gate.js\":\"953b716c7bbc18f7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/index.js\":\"e258d1b6820a3090\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/wolfTheme.js\":\"daf5d9864129dc13\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/BlockDragLayer.js\":\"c5b31e4ea2b71357\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/dragController.js\":\"c2ccf38389484e85\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/dropTarget.js\":\"98207ab0c1985aed\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/index.js\":\"217cf82e90e2af52\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/projection.js\":\"2a5d31577d353ec1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-info/BlockMetaCard.js\":\"fba4930da147aae7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-info/index.js\":\"0e2126607bc769db\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/AddTagDialog.js\":\"c682370f7bf4eb44\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"cfaf7f824469158e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/TagNameIssueHint.js\":\"c1d479731b82e103\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/addTagAction.js\":\"b60add8df25b0b6c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/appendTag.js\":\"c035901cbe93120d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/config.js\":\"a01d949b9d61f5df\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/dataExtension.js\":\"4c14134a413d2086\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/index.js\":\"f9fc0f99d8fa033e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/propertyEditorOverride.js\":\"3066cd91b1aa09bf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/BreadcrumbList.js\":\"163a3a762773ec61\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cd1fe096596bc1ba\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/Breadcrumbs.js\":\"807d9e0b6f54f1ec\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"057736c026e7709f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"18ad28969bf4957d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/index.js\":\"26f54fdc2811f3cf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"10207b9b4b0974fc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/CharacterCountItem.js\":\"9181f475f057342f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1e3f0f6b57588a6b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/actions.js\":\"4cb8737a8372debc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/blockType.js\":\"99e0dccbe19769f1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/charCount.js\":\"5612fadddccd1f5b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/dataExtension.js\":\"77f3a48c640d1581\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/index.js\":\"8ca4396ba587a17a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/profiles.js\":\"a55b5b03133a9dd3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/properties.js\":\"0f53ea69a72b41b9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/textCounts.js\":\"9a8a22a45b5f6627\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/colemak-keybindings/index.js\":\"1dd0fafce8326072\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/CommandPalette.js\":\"40758a74aea0ce00\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/HeaderItem.js\":\"cce5b93557acb85e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/context.js\":\"6f3a7ee906b797bd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/index.js\":\"3a71c073bb672db4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/selection.js\":\"ae40b261d5502300\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/toggleStore.js\":\"83d470e9034c0986\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/useCommandPaletteActions.js\":\"26a8fdc1854b8050\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/ContributorBadges.js\":\"762c98f390210f87\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/author.js\":\"cfb6b80f84d3ead0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/codeMirrorExtensions.js\":\"eef5030162d0b48b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/dataExtension.js\":\"159b8e26f1eb9205\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/index.js\":\"e6da783b2839f8ef\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/mentionAutocomplete.js\":\"9486f5bcd23b8cea\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/processor.js\":\"39282b6128c8f164\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/profiles.js\":\"cc855bea5d55bf3f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/queries.js\":\"160596ff917f6b55\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/schema.js\":\"36f6b3b72b372e96\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"fb6e5fbc88c40d24\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6c3c6c82ea50272c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/index.js\":\"baf2173a0c8c831a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f0d583b5900ff292\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9059ecebde43c112\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/CalendarGrid.js\":\"fcaa837f90071add\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/DailyNotePicker.js\":\"8d796839863ea67d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7accf8b34d792f02\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/DateNavDecorator.js\":\"82edf3cbeeddc94c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/DateScrubOverlay.js\":\"b83f68e04b27c382\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/HeaderItem.js\":\"e31caea957c89ede\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/ReschedulePicker.js\":\"9b23b757a8c0af44\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bda3ba113dc3d950\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/actions.js\":\"777bcc24496e52a2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/blockDateAdapter.js\":\"9aad85b40e4f164c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/calendar.js\":\"1138fc50b958a7d0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dailyNotes.js\":\"142855cc7f5b7cea\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dataExtension.js\":\"b809ed33e11c348a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dateScrubActions.js\":\"a769f29d767bb1f8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dateScrubGesture.js\":\"fa8edeed877b1e87\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1f52913dc38e1792\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dateScrubRecognizer.js\":\"96ccc42db2384125\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/deletionGuard.js\":\"a72c8090ea4988c7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dueQuery.js\":\"a37496e089249307\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/index.js\":\"569a22acc42fc963\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/landing.js\":\"2156a243913a4991\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/localSchema.js\":\"2c6df299061f61e6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/referenceDateAdapter.js\":\"03689cbeb86d631f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/rescheduleAction.js\":\"92af9fb392a6ef9b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/schema.js\":\"37b2844b6d16da9a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/spreadBlockDates.js\":\"acf1a5f68d105e13\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/spreadDatesAction.js\":\"5bb7e2c8ddafb235\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/today.js\":\"d3f51eb07bf69f28\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"1d385e4578fec30c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6aab4f2679d63b1b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/audit.js\":\"6fa07fad4d24b80f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/auditAction.js\":\"4c1ebb53a2fe1689\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/auditRanges.js\":\"811dcd3ceaa5ec64\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/diagnosticsSource.js\":\"746ae40476cda4c1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/divergenceScan.js\":\"153fad2ef38b9b18\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/index.js\":\"16bd8bd0c79f49e2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b7c4f5f9d3803bc3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/referencesMirror.js\":\"04135b6de7f28881\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/rowJson.js\":\"4f19ae9b63833353\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/schedule.js\":\"57cea8e39a733e06\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/store.js\":\"5c02ee917b318246\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-maintenance/action.js\":\"8b523dce8fa26df9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-maintenance/index.js\":\"7606d3b662bde58a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-maintenance/plugin.js\":\"0aa518e8376ba1b8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"984b55567be134bd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/actions.js\":\"f7e0f665678cedb5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/changeMarker.js\":\"941e4a9fbe08de0b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/diagnostics.js\":\"3731f37dec160d37\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/fileSystemAccess.js\":\"5ceb5d825354fae0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/filenames.js\":\"241a01bc355042e8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/index.js\":\"8407f4a11d142ffb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/mirror.js\":\"a7e3e9c7419e5aa6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/runLock.js\":\"631f240e3e622ad8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/runtimeHealth.js\":\"c844c093485ee521\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/schedule.js\":\"d8eb78c53906d573\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/store.js\":\"7c63d64c561cfe18\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/default-themes/index.js\":\"e376e512f889a50e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/default-themes/themes.js\":\"b4f1949a4938bda1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/diagnostics/facet.js\":\"f98c2e11cf17c701\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/diagnostics/useDiagnostics.js\":\"8ee7f3916d13f5ae\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extension-prompts/dismissals.js\":\"cbb731c094ebdda9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extension-prompts/index.js\":\"9d4f5f0248fbc008\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extension-prompts/status.js\":\"9ebf19c8ceb5087a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extension-prompts/store.js\":\"b042eed0d4bcf57a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"713d11eb0525ae30\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/ExtensionsSettings.js\":\"94e5c38b95c77cfb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/actions.js\":\"add601212f217c6f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/config.js\":\"90150a335878de6b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/dataExtension.js\":\"6e49c3e4b594073f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/effect.js\":\"709c201a3bfa4465\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/index.js\":\"0c97c0d72c706ac2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a8954cb3959215c6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/useToggleTree.js\":\"665169734dce3fae\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/ExtractTypeDialog.js\":\"b382752d3352d480\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"faa9af6baf5d5d02\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/PropertyShapePicker.js\":\"1106ce091f2c8e49\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/action.js\":\"c4d8d71d25d21866\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/index.js\":\"6608c49a82fc5abc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/FindReplaceDialog.js\":\"8e15bacb5e61e041\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/HeaderItem.js\":\"7d69477370deee3b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/dataExtension.js\":\"e8c885d8946d8073\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/index.js\":\"c7efa91c4fa1ddcb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/search.js\":\"5724733fcdf00448\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/toggleStore.js\":\"1403fd4bf341a84f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/LocationPropertyEditor.js\":\"462fab9c5cc71d46\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/MapView.js\":\"54b8900cdb4ba73e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/blockTypes.js\":\"b04473cab4a39676\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/codeMirrorExtensions.js\":\"35c8f6f40ea23dbc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/createOrFindPlace.js\":\"2899cc139789fb3c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/currentLocation.js\":\"87ffc91d702e65b1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/dataExtension.js\":\"3a1997a568c86386\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/geoContentDecorator.js\":\"d96059632ef50696\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/googlePlacesClient.js\":\"2ee4f3b9c1a91655\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/index.js\":\"f54c6b393704e335\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/locationsPage.js\":\"5237f713ff44ac32\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/mapViewport.js\":\"383b8c5c522b35be\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/pickCurrentLocation.js\":\"98bd553ee6de1728\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/placeAutocomplete.js\":\"c3e93aa9db46c1a3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/placeNameCollision.js\":\"936fa5c93c67806a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/properties.js\":\"72a8968ac7dcf19c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/propertyEditorOverrides.js\":\"f09397b756f3ad42\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/query.js\":\"46bad275cbd732ee\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/usePlaceSearch.js\":\"0dda17820681545c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f2a8399c8eff835a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"fdaa805335f64276\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"cea159b87737c1ac\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/config.js\":\"d14e9a8b4c80d48f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/dataExtension.js\":\"617701f3ac1a55e7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/facet.js\":\"15b50f28df6f0d72\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/grouping.js\":\"5593c16971ce0255\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/index.js\":\"ab674bac283b5ffa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"27c9c7fc18db0181\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/query.js\":\"306f2ad5ca9965f8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/resolveConfig.js\":\"5697814c57535ff5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5bae52757fe71201\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a81e508fc32f4b40\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/HtmlDocumentContent.js\":\"b1a3484a8d7721b9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/HtmlFrame.js\":\"f11aa7cd802f1b29\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/actions.js\":\"72ab13ed35e23ca9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/blockType.js\":\"6e6c0439811130b4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/confirmRunScripts.js\":\"6623843a72edc1d5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/dataExtension.js\":\"110a412ef504786c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/frameAnnotations.js\":\"71b73afbb5b607dc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/frameDocument.js\":\"697c87866f607f78\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/frameTheme.js\":\"ab44defddb21e4d5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/index.js\":\"d2895acb6ddbb327\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/scriptConsent.js\":\"9857a90197d31a44\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/sourceMap.js\":\"ba617a94f0762595\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/useDocumentScripts.js\":\"dbad253f77f5f7a6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/index.js\":\"583107816fcb70a3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/record.js\":\"277ea93a1e29b1e0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/recordStore.js\":\"5c5622e07e3c8193\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/responsiveness.js\":\"964c1e402e2276ed\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/schedule.js\":\"017e207440b19e96\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/sessionContext.js\":\"63d0fc968ebca9b0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"20af317044ac73e7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"92afac634453b1da\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/actions.js\":\"e1066f9b0ddf637a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/config.js\":\"a3b779d6abfec114\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/dataExtension.js\":\"aa58bd5fddd2aaae\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/effect.js\":\"6fa2b9cf63677c1a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/index.js\":\"802f643047aa8da8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/keyCapture.js\":\"b063c99d11a61298\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/overrideStore.js\":\"a9d54706931d50d9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"babbf9af5f60a096\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/HeaderItem.js\":\"87d55bf1a308cfbc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/LeftSidebar.js\":\"1f515a4524713a75\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/actions.js\":\"cd295c498c6e382e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/facet.js\":\"c75097b5dc914f20\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/index.js\":\"89b36ce768777741\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/shortcuts.js\":\"b854de73546aa28b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/toggleStore.js\":\"fb200be7ce779478\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/merge-blocks/MergePicker.js\":\"7c07642ab8711781\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/merge-blocks/index.js\":\"68ce92d02577dc27\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/merge-blocks/mergeAction.js\":\"e6735a9088d956de\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/merge-blocks/strategy.js\":\"cb8d640ea24c2b30\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/Button.js\":\"9d687b417234f31b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9f8162776b157901\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/defaultItems.js\":\"2958f85886e54ccf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/facet.js\":\"db577f9477564eaa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/index.js\":\"2ad9253f3edb2aae\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b361927f502c6b5c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/actions.js\":\"37283e7b264ced87\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"edcc39c2d2ca876f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2356aa3f1bc456d0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/index.js\":\"d4305c2595721c4e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b6669b5b13bab32f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c97a1b8a4a7018b3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/contextMenuItem.js\":\"e3761b5e6cd31d66\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/index.js\":\"841326575fcd014f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/moveAction.js\":\"eb7b1190020bf4a7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/moveBlocks.js\":\"957811a15eef4c00\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/selectionAfterMove.js\":\"053aa113d76c6355\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/TutorialBanner.js\":\"1c84d75a41d6ba50\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/action.js\":\"3c941d04481d95ad\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/bannerDismissal.js\":\"7c99302cea62dd98\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/documents/cheatSheet.js\":\"0c63e92c1e50217a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/index.js\":\"aa81d91471f4bd5a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/keys.js\":\"4fd42ee477b4447c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/landing.js\":\"34bbbf9766b463c6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/outline.js\":\"81f2043431c6866f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/seed.js\":\"db43235dda68d23c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6c853e3a8e6c1e82\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/analyze.js\":\"5d7e6d397f3def19\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/diagnosticsSource.js\":\"2e558f789a15136d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/index.js\":\"11d24700bfdc80ad\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/load.js\":\"6af42bfc9feef850\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/monitorRun.js\":\"52d0ff5b137fb74a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/schedule.js\":\"c4ff09af5ce4be89\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/series.js\":\"5c83817b2e9f8323\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/store.js\":\"a07bab69eb82e88f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/trendAction.js\":\"686f7f76d96c9420\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/verdict.js\":\"f51a122fc852fc5b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/plain-outliner/clickToEditAction.js\":\"acf3ca836ef63615\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/plain-outliner/index.js\":\"1fb4709b91ce3bdd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/plain-outliner/interactions.js\":\"61143ddce2e151fb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"862d039dac52f069\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/MigrationGate.js\":\"0263e2edcb42dca0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/MigrationGateDialog.js\":\"23a78881f6ad41bc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/action.js\":\"4593dbf660d8c8eb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/index.js\":\"f78cdf8772d0cd57\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/localRunMessage.js\":\"0f5532ae2e3e0302\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/plugin.js\":\"19aa75b301e2fadc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/progressReport.js\":\"15c27798ac555559\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/sweepProgress.js\":\"866f8c386de56ea3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/FieldRowRenderer.js\":\"2c58595d010fd340\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/ValueRowRenderer.js\":\"fbed053cde9b67cb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/actions.js\":\"dfbd9ffa621aa60c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/autocomplete.js\":\"a8d3d01c54ab7805\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/fieldRow.js\":\"e7e1b0fa1112fd94\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/index.js\":\"2b84f4bdc27ecfce\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/referenceWarning.js\":\"1ed61c2647991e67\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/valueAutocomplete.js\":\"2ce4c30d7088082c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/valueSchema.js\":\"ee6a7737db816379\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/HeaderItem.js\":\"3d601a266d235267\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/QuickFind.js\":\"1519bfd65c90af08\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/index.js\":\"945c262d2eab3c4e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/recents.js\":\"ee10152770fb4221\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/resultItems.js\":\"9f479cc64726fb8f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/selection.js\":\"e174c3502505556f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/toggleStore.js\":\"261f222d86328784\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/HeaderItem.js\":\"52851e7ef93f31aa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/RecentsPageBlockRenderer.js\":\"dfb7b7054a1ae8aa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/grouping.js\":\"c38230852fa25a8e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/index.js\":\"d9626cff63d7d292\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/target.js\":\"9e470c2cf572b81f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/codeMirrorExtensions.js\":\"142c5444fd1502e8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/contentPrefill.js\":\"e48504dcb558f347\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/dataExtension.js\":\"76b0174c80012cbb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/index.js\":\"e3c06e22ba75e1d3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"01017104340e775e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/invalidation.js\":\"7297938812ba4ac3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/localSchema.js\":\"e9d79f6d80523d04\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/blockrefs/index.js\":\"8fe8b791d347d8f3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b03704877ba6fa93\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/index.js\":\"78b15be18398f7d7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/referenceNode.js\":\"918cb4f57881f2ef\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/remark-reference-occurrences.js\":\"360beef17af1e226\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b514ba2b0d411c4a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/wikilinks/index.js\":\"bc5d852e921f38ad\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4493f8ddcbcf691d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ae44a61277523667\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/mergeRetargetProcessor.js\":\"464a246cfd1ee329\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/parseFence.js\":\"b4f16e5274b3f714\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/referenceParser.js\":\"20478668af78e8f7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/referenceProjection.js\":\"fd5be4d0a1b109a9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/referencesProcessor.js\":\"09ed0da14a6a72b1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/renameProcessor.js\":\"a67c8e585d91d884\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/spanReplacement.js\":\"26e7cec2118f0537\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/rich-paste/htmlToOutline.js\":\"d8315a218d99c86c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/rich-paste/index.js\":\"1d571764e4cefdf3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/rich-paste/normalizeClipboardDom.js\":\"753853d40c6c140d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/rich-paste/pasteDecision.js\":\"177d966b5cfd74f7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/action.js\":\"93e0bc0ca968c4ea\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/blockIds.js\":\"49a4fcadb3f790a8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/content.js\":\"1c7567ea39527902\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/effect.js\":\"d012257369530a4e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/ids.js\":\"6ded868c5936bb61\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/import.js\":\"47e1b257d09487c5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/index.js\":\"207274ea60a8dd44\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/plan.js\":\"1d07d67e17f2264c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/plugin.js\":\"eee65f93ed9228a6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/promotion.js\":\"21110032e7184003\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/properties.js\":\"e94a5a5edf93f0f3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/references.js\":\"035543dcc0aa388b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/report.js\":\"10577eff6b4110e8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/roamMemo.js\":\"ded7c1042cc2a529\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/runtime.js\":\"03beb74b32f2a7b3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/schemaReconciliation.js\":\"2067cbabc6885d37\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/srsMarkers.js\":\"188a102f6b16915c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/todo.js\":\"40babfa26ffb770e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/typeCandidates.js\":\"5bca84e702485841\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/types.js\":\"bc5ea7ef27c27435\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/search-health/index.js\":\"42b0926ade59d4ce\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/search-health/store.js\":\"05aafef1fe13425b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/HeaderItem.js\":\"1b69aaa27075e0a4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"998be1f822307e9d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/index.js\":\"4fcc4ad2dca553fd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/model.js\":\"0d199579698e5622\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/toggleStore.js\":\"b8f58497b67195c5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/useKeyInspector.js\":\"f20d871a2166191e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"acd1ee38d92ffa5a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/ShellDecorator.js\":\"9f1a8ac9feb3e8b3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/actions.js\":\"9a9a4adb1a6890d8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/exclusionsFacet.js\":\"fea2994bc65f3501\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/index.js\":\"8737edd8ce9103ee\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/shell.js\":\"8e0e0a5980add306\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/surface.js\":\"2c94b8ce992180f4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/walker.js\":\"3f94495782106816\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/RescheduleToast.js\":\"967276ad1058e953\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/dataExtension.js\":\"8efa0a7c88617106\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/index.js\":\"fac616197be0213c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/indicator.js\":\"1f4ccf823464ec96\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/moveSrsState.js\":\"07591c2577975608\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b17a571b150135f1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/scheduler.js\":\"cc995671f721a671\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/schema.js\":\"264898d7c810bdc7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0ba6896d3d6322e2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/srsClipboard.js\":\"10ad9ed15ae9c62e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"0ef77357a242ad0c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1ffbf97c86e34f67\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/DeckPicker.js\":\"a4293797a155299d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/ReviewControls.js\":\"3d1a72b2c9341a82\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/ReviewDeckRenderer.js\":\"216b6d8f7596177a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/ReviewSession.js\":\"b13967ccd6bac500\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/actions.js\":\"1f33be63df177668\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/archive.js\":\"39c9ca3d848e9478\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/dataExtension.js\":\"837ca824a3466430\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/deck.js\":\"e5ffad9c7f3017f3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/dueQuery.js\":\"fc30a55a1529b857\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/gradeDecision.js\":\"3bc5b2ef6e026354\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/index.js\":\"a59aa5952722a974\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/keyHints.js\":\"e537586758f0c11b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/reviewCardLayout.js\":\"310884664e34b369\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/reviewProgress.js\":\"47c93fe497d12e83\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/schema.js\":\"e0c4cc6cfbd98d4d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/useDueCards.js\":\"f64b1f83bad2ecc5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/startup-metrics/index.js\":\"ae5da4ba236af41d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/startup-metrics/record.js\":\"8597e3e776eabde4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/storage-persistence/index.js\":\"ae9502d1554a80d2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/storage-persistence/persistenceStatus.js\":\"3ee06bb10e1da3ce\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/storage-persistence/requestAction.js\":\"7f3b336021a2cc1b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/supertags/TypeChipsDecorator.js\":\"bf96d79dbeb4e9dc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/supertags/codeMirrorExtensions.js\":\"f0f2b7819487a27e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/supertags/index.js\":\"46c36f1aebc869fb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/supertags/typeAutocomplete.js\":\"ceebb929a1ada66b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0a7c15879b2eb53e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/actions.js\":\"233e242e449ed1c6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/anchor.js\":\"6a8e00d4b9d30b7e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/events.js\":\"71f9869f0c10ca8e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/gestureActions.js\":\"c885098334dc4c49\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/index.js\":\"2d48c4ac5340d567\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"767971939daf2566\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/sync-metrics/collect.js\":\"e267abf37ae53a2d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/sync-metrics/index.js\":\"ac3e9fd45f6eae2b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/sync-metrics/record.js\":\"d4708258db7e644d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/RejectionDialog.js\":\"869d6e32c0996e71\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/SystemStatusHeaderItem.js\":\"10109cf89464b657\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/index.js\":\"027da4907bdb766a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/model.js\":\"b5477ace176ddddb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/queueCounts.js\":\"6a79af262a166fa7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/rejectedHelpers.js\":\"772b82b568cf804f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/rematerializeAction.js\":\"39777ff4a1739d48\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/useHysteresis.js\":\"69f99d3d965be6c4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/TableLayout.js\":\"5cbf39eb5432fae4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/actions.js\":\"648f464d02150b3f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/cellEdits.js\":\"ad183548b237b6d5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/controller.js\":\"ec551a28173dd009\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/convert.js\":\"2c1cc504a8feb54e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/dataExtension.js\":\"04aaf885a7740c54\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/index.js\":\"d448c891c7d821e6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/keys.js\":\"b8cbb6b3128635ec\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/model.js\":\"80e98d50accc54a4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/registry.js\":\"666a84e6bd618c55\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/schema.js\":\"9d342839fce6a404\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/theme-toggle/effect.js\":\"9578ab13d4b322a1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/theme-toggle/index.js\":\"04493a1239342109\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/theme-toggle/theme.js\":\"d0d7479f96f90691\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/todo/actions.js\":\"af01e6b7ac35e490\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/todo/dataExtension.js\":\"cfcf5f18aca4b73c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/todo/index.js\":\"2510d6284bfa523b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/todo/schema.js\":\"9326e6169e94fbdc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7740e227323a2563\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/actions.js\":\"3681ee4e8497c605\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/defaultItems.js\":\"8e5e42949d6796ff\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/facet.js\":\"3b6655a1b8d842d2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/holdRecognizer.js\":\"e9f3318379ac0627\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/index.js\":\"3394b932e20f38b6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/update-indicator/UpdateIndicator.js\":\"9c48a89186bf829e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/update-indicator/index.js\":\"ec09edf8b8e6cbd5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/update-indicator/loadTimes.js\":\"d5bd613575fca739\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/VideoNotesRenderer.js\":\"79e538a12b876b9d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/VideoPlayerRenderer.js\":\"d98647eaeea79baf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/VideoTimeStamp.js\":\"cab97e22819e97e6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/actions.js\":\"10f19a9bba68a0cd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/index.js\":\"a2797b240fef4dec\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/markdown.js\":\"116547b6ecea106e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/notes.js\":\"848d15a69ec6c6d3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/registry.js\":\"b8bc734b0467c13b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/remark-timestamps.js\":\"ef922c2e225dad2e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/view.js\":\"2e2e1e8812d8dba4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-link-hints/LinkHints.js\":\"6b43f3553cfd0e94\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-link-hints/index.js\":\"d3be1bab549939e4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-link-hints/model.js\":\"d0141cfe5abdedd6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-link-hints/settings.js\":\"33f985d4ac1fe05e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-normal-mode/actions.js\":\"8b700d66f7dd2305\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-normal-mode/index.js\":\"4751b048c5fa5c67\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-normal-mode/interactions.js\":\"2ba139b760540ac8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/workspace-header/index.js\":\"157c48f58851fe87\",\"/knowledge-medium/pr-preview/pr-1824/src/registerServiceWorker.js\":\"091f55f0ba6df1bd\",\"/knowledge-medium/pr-preview/pr-1824/src/requestPersistentStorage.js\":\"ebd3ab79b4153b6c\",\"/knowledge-medium/pr-preview/pr-1824/src/services/authRequestDeadline.js\":\"ac12d811bc70ca3e\",\"/knowledge-medium/pr-preview/pr-1824/src/services/authStorage.js\":\"be7be68e14502039\",\"/knowledge-medium/pr-preview/pr-1824/src/services/powersync.js\":\"3f41de2b1a49b846\",\"/knowledge-medium/pr-preview/pr-1824/src/services/supabase.js\":\"6f8d462f4e8c203b\",\"/knowledge-medium/pr-preview/pr-1824/src/services/uploadErrorClassifier.js\":\"0da73c6e6f08605e\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/ActiveContexts.js\":\"3163625694abdd95\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/HotkeyReconciler.js\":\"4f9215c51fbef93b\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/WipeLocalDataDialog.js\":\"1f5c0a1c3a3fe556\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/actionDispatch.js\":\"1233f436abc9d656\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/actionRefItems.js\":\"aa134abd8df58741\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/applyKeybindingOverrides.js\":\"e3ea16f20eec0cd1\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/blockActions.js\":\"e55e0a8929d0307b\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/canonicalizeChord.js\":\"40f51bbfd49f21cf\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/defaultContexts.js\":\"967899d09554d616\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/defaultShortcuts.js\":\"2a9e93d5024cd4b2\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/effectiveActions.js\":\"ea2a7841d83a1f61\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/gestureAction.js\":\"2b7b4477bdcc6aa5\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/gestureBinding.js\":\"cbed52ea7cfec512\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/holdRegistry.js\":\"fe25d2f75bd7ac4e\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/keybindingConflicts.js\":\"b155c836ffe7d31f\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/keybindingOverrides.js\":\"59dd1f3402d2c8b7\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/pointerAction.js\":\"d7c187b29a3ccbea\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/resolve.js\":\"a16f6b2cb2ff020d\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/runAction.js\":\"8f684ee9c9d3f2db\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/sequenceMatcher.js\":\"a4a945e6685e6e4b\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/types.js\":\"1aef93eefc6d5fa2\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/useActionContext.js\":\"fe3b77301bbf86af\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/useActionDiscovery.js\":\"f2d24e282326ad55\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/utils.js\":\"d019da5a33775a24\",\"/knowledge-medium/pr-preview/pr-1824/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1824/src/sw/bootStore.js\":\"92cfa3ecc828193e\",\"/knowledge-medium/pr-preview/pr-1824/src/sw/previewDatabases.js\":\"a1fdd94948d38252\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/byteTransform.js\":\"c89263b9a70c4eea\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/attachmentCleaner.js\":\"33721a6a7dbb3476\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/attachmentParts.js\":\"637bebd0b510d25d\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/bundleParts.js\":\"d099f272fdda32d5\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/bundleRecord.js\":\"92eea5bc2d9121cb\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/manifest.js\":\"274b99aff84b0cae\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/takeBundle.js\":\"5d41164385292b34\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/verifyBundle.js\":\"ad413197eb63e755\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/cleaningStage.js\":\"7db0ab27aa9e9372\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/conversionKey.js\":\"58229c219d16512e\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/conversionServer.js\":\"7e0d5cd5d00397bd\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/flip.js\":\"32cf3a95488539cb\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/flipAttempts.js\":\"295a8ac40098aec3\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/pages.js\":\"79bdbb7b1dfd2ec0\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/preflight.js\":\"a904e5d50d7d6cd1\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/reseal.js\":\"82021020917162d2\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/runConversion.js\":\"c2c45dbf1edd41ce\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/runLock.js\":\"4cd64f48a331c629\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/sealing.js\":\"fbf8df924429db11\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/sealingStage.js\":\"66705f225aabc5f2\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/stage.js\":\"57792f867e1b932a\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/verifyReseal.js\":\"79973aac494bf783\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/aad.js\":\"77616cab681e0cbd\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/aead.js\":\"e2e00c681cee0826\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/base32.js\":\"31ea004e36362e3b\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/base64url.js\":\"dca8d89c657ddcce\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/binaryEnvelope.js\":\"c519c7220505e6e2\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/byteAead.js\":\"94c8abc6f1bb2195\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/canary.js\":\"98f119775d1b2115\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/contentHash.js\":\"26c9803e6b43be79\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/contentKey.js\":\"7daf92f69b3fa8d2\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/derivedIdNamespace.js\":\"f9d42e06091164ae\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/envelope.js\":\"002cbd4f55a46272\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/hex.js\":\"0d04a456227943a1\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/sha256Hex.js\":\"0bdbffc16ee45c00\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/workspaceKey.js\":\"676faac6ba09a35e\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/conversionState.js\":\"9abab6573cc1bf0e\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/flows/createEncryptedWorkspace.js\":\"14e967bf9b23181d\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/flows/pastedKey.js\":\"43dd3c87fe085c11\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"d1619894bf92a369\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/flows/upgradeWorkspacePin.js\":\"43d4088b6387f614\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/keyStore.js\":\"3b7a61c1b9dcf01d\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/mintWorkspaceKey.js\":\"cec6cafe164c819f\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/modePin.js\":\"18afa306c6a25cd1\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/openWorkspaceKeys.js\":\"76c3b11211fd9f07\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/resolveWorkspaceEntry.js\":\"0a3b1fec1656e755\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/resolver.js\":\"4589881167922493\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/workspaceAccess.js\":\"2371ef1242b527ef\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/transform.js\":\"758506508d77afa7\",\"/knowledge-medium/pr-preview/pr-1824/src/themeBootDefaults.js\":\"ad401fa563cc785b\",\"/knowledge-medium/pr-preview/pr-1824/src/types.js\":\"f5ced98a21b304ba\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/ClientLocalSettings.js\":\"7c9c9b252fd04b96\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/abortableSleep.js\":\"98bf2139ac1cb086\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/array.js\":\"9ee99b258a64a1d3\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/backlinkAutocomplete.js\":\"4e80b883570f66d0\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/blockCrumbs.js\":\"852f7e62ff252da7\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/blockrefAutocomplete.js\":\"4751e5799e1c7991\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/cadencedIdleJob.js\":\"1b01e37a849c3ef8\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/callbackSet.js\":\"dd1439a41a39bf8e\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/clientId.js\":\"1d0edfa8651c219d\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/codemirror.js\":\"ea7894035456b70f\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/codemirrorCompletion.js\":\"9aaad8931674641a\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/copy.js\":\"e73df7aeb8bb5c71\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dailyPage.js\":\"3c954b711127a711\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dbForensics.js\":\"9149a14be34e4967\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dbForensicsHooks.js\":\"f3e3954238f8a136\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/deleteBlockThroughUi.js\":\"7a23ff02d75de6e7\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dialogs.js\":\"bdd61da39f29e0d6\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dom.js\":\"15821d1d4179b1f3\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/downloadBlob.js\":\"18583c3066768d85\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/exportSqliteDb.js\":\"45a6fabc57323796\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/fileSystemAccess.js\":\"d76b6ce64bdf20ba\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/flipSlide.js\":\"3bedb92ca61973ff\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/fnv1a.js\":\"fc4c21068ac74db0\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/formatBytes.js\":\"6f9db43e8e2addc8\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/fuzzyRank.js\":\"66ad2954663281c1\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/idbKeyedStore.js\":\"702fa6fe128e1c5c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/idleCallbackPolyfill.js\":\"d2822a879119ca89\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/keyboardAwareScroll.js\":\"233b9034ea42cc92\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/keyboardViewport.js\":\"a83ce2ecfd486ab0\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/lastWorkspace.js\":\"7087bcc0888d8c30\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/layoutColumns.js\":\"abcdf4bf374fb52b\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/layoutSessionDom.js\":\"39a9732518d34d46\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/layoutSessionId.js\":\"f2e0ca32d024185a\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/linkClickGestures.js\":\"70491429d79eebcd\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/linkTargetAutocomplete.js\":\"241cde2884ebff02\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/localDbCorruption.js\":\"960b29e8c3bf4785\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/localDbRecovery.js\":\"8d5eae6e9fa5ce4b\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/markdownParser.js\":\"ee20ffdc153a57b1\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/memoize.js\":\"f74723cd7135014c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/nameFieldCommit.js\":\"7841f2971a5ba61c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/nameList.js\":\"2c05eefe247be51a\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/navigation.js\":\"a60b516f480e60b0\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/omnilinerNamespace.js\":\"8e0154670f6543f4\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/opfsPageScan.js\":\"054ad41846b271e8\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelClearance.js\":\"4334820e34348195\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelHistory.js\":\"c9ada5c907c953dd\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelLanes.js\":\"62ca93618de9fef1\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelLayoutProjection.js\":\"22a44db0af660111\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelScrollAnchor.js\":\"ae96ef6b8d681092\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelUrlFlags.js\":\"d5ba9474f66f8a43\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/platform.js\":\"a003823ed298ac8d\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/pluralize.js\":\"467de9835ac9c632\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/propertyCreation.js\":\"7fe0379234683d24\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/propertyNavigation.js\":\"1978b06e023c2e36\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/propertyValueContext.js\":\"afc39b2b678d85a1\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/react.js\":\"b8ddbd813e51befc\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/relativeDate.js\":\"445372723955a6b5\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/relativeTime.js\":\"a9ac9bddbb75ec45\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/renderScope.js\":\"cfca8898854b1500\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/resolvedThenable.js\":\"9e2af4aa7bc4fff2\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/routing.js\":\"4ff1da4964e8456a\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/safeMode.js\":\"c65694ee3b23378f\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/scheduleIdle.js\":\"90a5fc2db42ffd8f\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/screenWakeLock.js\":\"7a3648f2969a76dc\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/selection.js\":\"5c7ab07894beaa0d\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/softKeyboardGrab.js\":\"0484be6bbcbb2a0a\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/startupTimeline.js\":\"f6b19250c0b9da81\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/state.js\":\"eae55ec871d09331\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/string.js\":\"5faa8a843d9d37c1\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/surfaceZoom.js\":\"410321a22be6fd1c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/time.js\":\"bd28df5be20cd863\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/toast.js\":\"b857a359a8f46804\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/toggleStore.js\":\"d4f56bf0a49e6124\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/untilStopped.js\":\"f774548dec2b8bdc\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/userActivity.js\":\"d6bbc67daab942d1\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/viewTransition.js\":\"f0ed01331d99946b\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/viewport.js\":\"cf9703dcf8a02eef\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/webLock.js\":\"7d337bd3a433c448\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/workspaceRecovery.js\":\"b9b71aba1924620c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/workspaceSnapshotStore.js\":\"54134e2590f521c8\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-compiler-runtime.js\":\"85535e3f404b3bc1\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-client.js\":\"fea7527da437887a\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-server-edge.js\":\"49abee295886ed4f\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-server.js\":\"9e72e109e994a42e\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-static-edge.js\":\"fad45f826dfbb34d\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-static.js\":\"6cd1b65eb2e39fe0\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-test-utils.js\":\"5b42ad0743710a8f\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom.js\":\"ec61262bb81fac22\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-jsx-runtime.js\":\"2dbe1b52a76879a9\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react.js\":\"0c5fb7eb2ce78a5e\",\"/knowledge-medium/pr-preview/pr-1824/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1824/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1824/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
