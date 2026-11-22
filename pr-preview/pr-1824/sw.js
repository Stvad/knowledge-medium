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
		buildId: "643f28a85770-c9aba7db",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1824/\":\"e3295efc91ba7d12\",\"/knowledge-medium/pr-preview/pr-1824/index.html\":\"e3295efc91ba7d12\",\"/knowledge-medium/pr-preview/pr-1824/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1824/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1824/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1824/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1824/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1824/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1824/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1824/assets/FacadeVFS-GSLI7geU.js\":\"153d99ba14473fca\",\"/knowledge-medium/pr-preview/pr-1824/assets/OPFSCoopSyncVFS-DKGUL5TC.js\":\"0dab2ef6730e12a5\",\"/knowledge-medium/pr-preview/pr-1824/assets/OPFSWriteAheadVFS-Dy7L0R-a.js\":\"cd10466662d4f63b\",\"/knowledge-medium/pr-preview/pr-1824/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1824/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1824/assets/wa-sqlite-async-Cs-GEafE.js\":\"4c5569f1037cbc51\",\"/knowledge-medium/pr-preview/pr-1824/assets/wa-sqlite-uCPb-WrG.js\":\"4c1de337fde614c5\",\"/knowledge-medium/pr-preview/pr-1824/assets/worker-N5piqha4.js\":\"22e15a6afbf9c1c6\",\"/knowledge-medium/pr-preview/pr-1824/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1824/chunks/app-BI3TRAy1.js\":\"bfda9e780dd44ded\",\"/knowledge-medium/pr-preview/pr-1824/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1824/index.js\":\"68cfa711825c123e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1824/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1824/assets/AccessHandlePoolVFS-BcUDhLc2.js\":\"8a4a57819c18ba36\",\"/knowledge-medium/pr-preview/pr-1824/assets/IDBBatchAtomicVFS-DKs0UQj1.js\":\"c3f51ef60ab7c951\",\"/knowledge-medium/pr-preview/pr-1824/assets/MemoryVFS-B0T3B7ou.js\":\"210d01ae52415bee\",\"/knowledge-medium/pr-preview/pr-1824/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1824/assets/mc-wa-sqlite-Dilk3C6N.js\":\"1be512772161cc84\",\"/knowledge-medium/pr-preview/pr-1824/assets/mc-wa-sqlite-async-BFsow399.js\":\"37dace6dbbda40c6\",\"/knowledge-medium/pr-preview/pr-1824/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1824/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1824/chunks/AccessHandlePoolVFS-CaIioeju.js\":\"22c407f961175cb3\",\"/knowledge-medium/pr-preview/pr-1824/chunks/FacadeVFS-RQw0LJKd.js\":\"366bd74d05f022d0\",\"/knowledge-medium/pr-preview/pr-1824/chunks/IDBBatchAtomicVFS-Bf1puknp.js\":\"87ca2c2b313c1475\",\"/knowledge-medium/pr-preview/pr-1824/chunks/MemoryVFS-B1NPtQQt.js\":\"73907d98db2d0568\",\"/knowledge-medium/pr-preview/pr-1824/chunks/OPFSCoopSyncVFS-CWywZD4x.js\":\"b01f6c88d7e7076e\",\"/knowledge-medium/pr-preview/pr-1824/chunks/OPFSWriteAheadVFS-Be4nUSEg.js\":\"5d41b4554e254566\",\"/knowledge-medium/pr-preview/pr-1824/chunks/Preview-UTToOSDI.js\":\"8a5980f99bb8b1f0\",\"/knowledge-medium/pr-preview/pr-1824/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1824/chunks/card-2NFOlHHf.js\":\"9532d24aee375d98\",\"/knowledge-medium/pr-preview/pr-1824/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1824/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1824/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1824/chunks/dist-DZiyvZI1.js\":\"d481954a20c58303\",\"/knowledge-medium/pr-preview/pr-1824/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1824/chunks/mc-wa-sqlite-Dr8PffAg.js\":\"3234fb1c44eddf36\",\"/knowledge-medium/pr-preview/pr-1824/chunks/mc-wa-sqlite-async-Ba5c_Xli.js\":\"6f9270ec4f05c9e7\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-B75gXc3z.js\":\"9ba12e87067fb873\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-BTST4NnT.js\":\"c38348f1bbe900fb\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-CSqyuFwJ.js\":\"078c046688ec1be2\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-CbhUQq0i.js\":\"1d4a30ddb0066048\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-CvKoDZpe.js\":\"9c413a7f477b93d0\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-Cw5mcLDg.js\":\"5d6fa6b56fb70f7f\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-NPMtxuTd.js\":\"7f6e3af4705439db\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-QXH1By6M.js\":\"98ff4d7ac8012b1e\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-dom-server-legacy.browser.production-DspYhH2i.js\":\"e45d557ce1821d25\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-dom-server.browser.production-DsNShDgl.js\":\"64cba780cdbd7c14\",\"/knowledge-medium/pr-preview/pr-1824/chunks/react-dom-server.edge.production-pSuP4pWn.js\":\"09f59df324c65f02\",\"/knowledge-medium/pr-preview/pr-1824/chunks/server.browser-D7qHetEa.js\":\"10df18d27ae56a4d\",\"/knowledge-medium/pr-preview/pr-1824/chunks/textarea-miWwlil3.js\":\"de3b4f541f35799d\",\"/knowledge-medium/pr-preview/pr-1824/chunks/ui-CUYTR2BY.js\":\"75c2baf5139d7a9c\",\"/knowledge-medium/pr-preview/pr-1824/chunks/wa-sqlite-CeuwJCgd.js\":\"81479d4d583a1e04\",\"/knowledge-medium/pr-preview/pr-1824/chunks/wa-sqlite-async-DeMsmWQ_.js\":\"328334b4eabf1edd\",\"/knowledge-medium/pr-preview/pr-1824/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1824/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1824/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1824/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1824/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1824/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1824/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1824/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1824/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1824/src/App.js\":\"ac856c9b50292403\",\"/knowledge-medium/pr-preview/pr-1824/src/appUpdate.js\":\"c233210030e3b12b\",\"/knowledge-medium/pr-preview/pr-1824/src/appVersion.js\":\"8270af87f72da2f9\",\"/knowledge-medium/pr-preview/pr-1824/src/bootstrap/initialLayout.js\":\"a781087100a9e2e6\",\"/knowledge-medium/pr-preview/pr-1824/src/bootstrap/openWorkspaceData.js\":\"640a0dc7e34c46dc\",\"/knowledge-medium/pr-preview/pr-1824/src/bootstrap/resolveWorkspace.js\":\"4b28e93ab55273ad\",\"/knowledge-medium/pr-preview/pr-1824/src/bootstrap/workspaceBootstrap.js\":\"525b87cd60bce047\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockComponent.js\":\"2617ff657d8993c7\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockCrumbs.js\":\"c7f9371df5e0ba9a\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockEditor.js\":\"7e7b5b203301650a\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockLoadingPlaceholder.js\":\"6bdace0199b7c652\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockProperties.js\":\"d6ef077baba8fbb5\",\"/knowledge-medium/pr-preview/pr-1824/src/components/BlockSearchPicker.js\":\"6cc132cf4b8da187\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ConfirmBulkDeleteDialog.js\":\"5c13a4ba52737554\",\"/knowledge-medium/pr-preview/pr-1824/src/components/DividerHandle.js\":\"b42ecd67ca96bde6\",\"/knowledge-medium/pr-preview/pr-1824/src/components/DraftEditor.js\":\"f4b059ae3bf238f4\",\"/knowledge-medium/pr-preview/pr-1824/src/components/GutterPill.js\":\"8ec409c7e6f5e625\",\"/knowledge-medium/pr-preview/pr-1824/src/components/Header.js\":\"262171a4689aaf5b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/LazyBlockComponent.js\":\"e64b3aa6e8ab76c4\",\"/knowledge-medium/pr-preview/pr-1824/src/components/Login.js\":\"94c8c83799c801f3\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ZoomableSurface.js\":\"e5c70e71f8bb1c6c\",\"/knowledge-medium/pr-preview/pr-1824/src/components/editModeKeepalive.js\":\"21287e23848a92a1\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyDisplay/PropertyDisplayScope.js\":\"202eb78ecfa38dfd\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4bd475da21587b3a\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/RefPropertyEditor.js\":\"038a6a1b4bfb0098\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/RefTargetTypePicker.js\":\"996bad34d9ae26bc\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/SelectPropertyEditor.js\":\"63c4aeb0079829d2\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/TypesPropertyEditor.js\":\"91a9413d014a09af\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/defaults.js\":\"5f10ec9bf3f73f82\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/kernelValuePresets.js\":\"b84a47e33d8af215\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/selectablePresets.js\":\"b47ac7e009ab97bf\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyEditors/typesPropertyUi.js\":\"c516a0221558f4e1\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/AddPropertyForm.js\":\"421b589cfb7d8f9b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/PropertyPicker.js\":\"ad0c6a5a40734ff2\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/PropertyRow.js\":\"2a1fd53df9602673\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/Rows.js\":\"b77de9aa37df59bc\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/actions.js\":\"c287c2e0c33074d6\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/declarationOnly.js\":\"f32e1a56ba78d6d1\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/layout.js\":\"7e5ec54bdd36284c\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/model.js\":\"7f2255f881f236d6\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/shapeUi.js\":\"e1b3647e85268b2d\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/shapes.js\":\"803d885c3399659c\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5fd4254c752ca801\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanel/visibility.js\":\"bdebbc1361e4fc3d\",\"/knowledge-medium/pr-preview/pr-1824/src/components/propertyPanelSections.js\":\"a876e8b4843382ca\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/BlockEmbed.js\":\"10e34578498261d4\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/BlockLink.js\":\"c3337cd18234a484\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/BlockRef.js\":\"0d72e4d14ea1455d\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/ReferenceLink.js\":\"0ecca74c014c2cf6\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/cycleGuard.js\":\"8d590a50542f6a62\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/cycleGuardContext.js\":\"b90bee9f6464f39b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/linkInteraction.js\":\"0e2e16fe0fb2752b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/referenceLayout.js\":\"6a7d283db4971d91\",\"/knowledge-medium/pr-preview/pr-1824/src/components/references/useBlockRefAncestors.js\":\"b487e66e044eb6b2\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/BlockGutter.js\":\"df28fcda6285bdcf\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/BlockInfoDialog.js\":\"b48756ba8544ef42\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/BlockTypeBlockRenderer.js\":\"493e45c37de33149\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/BulletHoverCard.js\":\"1cc9a169cd9c7815\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/CodeMirrorContentRenderer.js\":\"e11413563d1737f4\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c25794ed5af63013\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/ColumnResizeHandles.js\":\"1d93b971544472d1\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5f57c33c308b44a7\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/DefaultBlockRenderer.js\":\"8c73a64e585a25e9\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/LayoutRenderer.js\":\"49c629d82cad2999\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/MarkdownContentRenderer.js\":\"0806f3cb120cbba5\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/MissingDataRenderer.js\":\"32e70c2b39fd7759\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/PanelRenderer.js\":\"c84169cffcb375e7\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b9ce6c2f941fee83\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/TopLevelRenderer.js\":\"b3090019cdaa5357\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/blockGutterMode.js\":\"a95b96e1edecce65\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/blockTitleText.js\":\"91de0c2c7e251fee\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/fieldCreationKeydown.js\":\"bc91b1b95edfdf7e\",\"/knowledge-medium/pr-preview/pr-1824/src/components/renderer/layoutRootContext.js\":\"2db704e9a86c9a22\",\"/knowledge-medium/pr-preview/pr-1824/src/components/typeChip/TypeChip.js\":\"49b3f8902fffa9c0\",\"/knowledge-medium/pr-preview/pr-1824/src/components/typeChip/chipStyle.js\":\"0f0109ae26eac10f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/anchored-floating.js\":\"b8ed941f50e673b1\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/button.js\":\"0fead1924d1b13ff\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/card.js\":\"877cb68074abe9b6\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/checkbox.js\":\"5d970765bc91da51\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/collapsible.js\":\"4df8bb5559ce017a\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/command.js\":\"d149f51844c0930b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/context-menu.js\":\"7789021207ca1754\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/dialog.js\":\"dfc2d58370d6a77a\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/dropdown-menu.js\":\"562f9b87775cf4c0\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/floating-listbox.js\":\"5a511dd5910825f3\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/index.js\":\"51c038983037f290\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/input.js\":\"13b80ffab663f56a\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/kbd.js\":\"131cc7c8fcd5a2ae\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/label.js\":\"0bba1844cfdec9a0\",\"/knowledge-medium/pr-preview/pr-1824/src/components/ui/textarea.js\":\"fe75c732ff3ebb9b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/useEditModeYieldKeepalive.js\":\"ea0795ca0ef5425f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/BootFallback.js\":\"6c78536ccaeda88c\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/FocusedRowLazyMount.js\":\"c843d81843f4c585\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/LazyViewportMount.js\":\"71ea667a5dfd42ce\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/LocalDbCorruptionFallback.js\":\"6e9532ad29480ef3\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/error.js\":\"f55330c49949b0a3\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/lazyMountRegistry.js\":\"880ffbfaebecee3b\",\"/knowledge-medium/pr-preview/pr-1824/src/components/util/suspense.js\":\"75d87847671b744f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/CreateWorkspaceDialog.js\":\"96e6c5c381bb8cce\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/PendingInvitations.js\":\"7f13e8c7d92cce6f\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/SyncProgress.js\":\"db2fd27f91f777c0\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/UnlockProgress.js\":\"a95e1f1f55b305d7\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/WorkspaceKeyGate.js\":\"b6ba1b14141495ca\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/WorkspaceSettingsDialog.js\":\"f6611c3796f0abe8\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/WorkspaceSwitcher.js\":\"a2e1d2b880d19fcf\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/WorkspaceSyncGate.js\":\"33fc3f83aa1108fe\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/ConversionFlow.js\":\"1b0de35c89e348d7\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/ConversionFlowHost.js\":\"9961e08d4f9269ee\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/EncryptionSection.js\":\"39189464e43c6269\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/attachmentPrompts.js\":\"2894e93eb6582f97\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b66c3dc2ef0638b7\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/conversionFlowDeps.js\":\"6e4be0d80c9752af\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/conversionFlowStore.js\":\"151e4ec81ae8ee1a\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/flowUi.js\":\"171cb48f026b83df\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/conversion/useConversionRun.js\":\"e6f8212044d3c046\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/keyUi.js\":\"4bc51b24e2744375\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/useCloseOnKeyLoss.js\":\"1bea3a1d29fff017\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/useCloseOnServerE2ee.js\":\"c1c0b03ca9469830\",\"/knowledge-medium/pr-preview/pr-1824/src/components/workspace/workspaceUnlocked.js\":\"d8793e4c80786e65\",\"/knowledge-medium/pr-preview/pr-1824/src/context/backgroundSubtree.js\":\"1067ff3ee985671f\",\"/knowledge-medium/pr-preview/pr-1824/src/context/block.js\":\"e3845f1536dba695\",\"/knowledge-medium/pr-preview/pr-1824/src/context/layoutWsContext.js\":\"96695f534e3f8c41\",\"/knowledge-medium/pr-preview/pr-1824/src/context/propertyDisplay.js\":\"7f8a8b0f401ad367\",\"/knowledge-medium/pr-preview/pr-1824/src/context/repo.js\":\"595fc13ba0022563\",\"/knowledge-medium/pr-preview/pr-1824/src/data/aliasClaim.js\":\"424df49b9d38d409\",\"/knowledge-medium/pr-preview/pr-1824/src/data/aliasSeatNamespace.js\":\"a8a19d356a67488e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/blockData.js\":\"915879a1223721d0\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/blockType.js\":\"75b80bed83e34b1f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/changeScope.js\":\"c0da1bc475ea2808\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/codecs.js\":\"5d14947be899f69a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/derivedData.js\":\"465a57a15d341c3a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/errors.js\":\"8d12236f3f84464e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/events.js\":\"30f49d8956c76392\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/handle.js\":\"193b907d7bbd3520\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/index.js\":\"d539c8c8c31ce5c8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/mutator.js\":\"d4d3cfc8988d4844\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/processor.js\":\"1e98cb0eab93d42c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/propertySchema.js\":\"b2d5d1b8e53ec0d3\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/query.js\":\"0e56d09e2493e56c\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/sameTxProcessor.js\":\"b7719e3b2e06820e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/schema.js\":\"193b907d7bbd3520\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/tx.js\":\"193b907d7bbd3520\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/typedBlockQuery.js\":\"de51b1204f9a66c3\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/user.js\":\"40e50cd0ff8d48a0\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/valuePresetCore.js\":\"4bb373d8b5092f51\",\"/knowledge-medium/pr-preview/pr-1824/src/data/api/valuePresets.js\":\"ee713edb49da3a24\",\"/knowledge-medium/pr-preview/pr-1824/src/data/attachmentCleanerIOVerb.js\":\"56a3bca59a7c81da\",\"/knowledge-medium/pr-preview/pr-1824/src/data/block.js\":\"d54a5f42e3350307\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockCache.js\":\"29bf6048ed241e14\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockId.js\":\"afdbf21cf8549cfc\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockLiveness.js\":\"445d8851ecad452a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockMerge.js\":\"0a710516d7781ec3\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockSchema.js\":\"baa960e4a5b4ab3d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/blockTypes.js\":\"2e29d54781541e66\",\"/knowledge-medium/pr-preview/pr-1824/src/data/clientContext.js\":\"f642564c1cb30f6e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/dbFileSiblings.js\":\"f19677219365048d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/definitionSeeds.js\":\"94d740740c80e13a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/derivedIds.js\":\"92c46d4fb4c672a4\",\"/knowledge-medium/pr-preview/pr-1824/src/data/drawnSubtree.js\":\"5f2165038eb5299e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/facetBridge.js\":\"da8288c2673a07a5\",\"/knowledge-medium/pr-preview/pr-1824/src/data/facets.js\":\"460f4a6e23e737c4\",\"/knowledge-medium/pr-preview/pr-1824/src/data/globalState.js\":\"73307ced3b64888a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/aliasClaimRederiveProcessor.js\":\"cef262eb6117b277\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/ancestorBatch.js\":\"d960dc0e15216434\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/blockTypeTypeifyProcessor.js\":\"be5d4922230b1b3b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/clientSchema.js\":\"0f9ee50eb7ff7057\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/commitPipeline.js\":\"b9dda3ddf047253b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/devAssertions.js\":\"c09491c51b3d753b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/firstSync.js\":\"aba0ec7f76d7c9e6\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/freshInitialLoad.js\":\"8caeaca5a3fed769\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/graphBackfillClaim.js\":\"a27e1f160e59f435\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/handleStore.js\":\"3768bd5987573f2b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/idleMarkerJobs.js\":\"d68dd58cb7c1ab89\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/initialDownload.js\":\"62edaf964b90b220\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/initializeClientDatabase.js\":\"43ca4510bc2d6b1f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/jsonCanonical.js\":\"f1a8c6ab9c9541e6\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/kernelInvalidation.js\":\"7740dfec6be3b2cd\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/kernelProcessors.js\":\"294a33363dd82301\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/kernelQueries.js\":\"00f672477977414e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/mergeTypeMembershipProcessor.js\":\"f22180d313b14c80\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/normalizeReferencesProcessor.js\":\"b5f05e1a9769c5ed\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/poolInstrumentation.js\":\"07a3ab3fbab10576\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/processorRunner.js\":\"fe9fb10a5b2a98f6\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyCellBackfill.js\":\"3c7d4161d6c3ba98\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyChildMint.js\":\"04a718d4d12cc240\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyChildrenProcessor.js\":\"1ece2c5ff53060df\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyDefinitionChangeProcessor.js\":\"93a2dffa9232aa88\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyDefinitionSynthesis.js\":\"2f9bbf6d5a528186\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyKeyScan.js\":\"51293d1e8096e6d1\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertySchemaResolution.js\":\"c6feec8860cdd0b7\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/propertyValueEdits.js\":\"1f20b4778952182f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/raiseProtocol.js\":\"15ca314347b60906\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/readBatch.js\":\"eef3309e5029f941\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/refProjection.js\":\"1bfff661b4f8023e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/referenceTargetLookups.js\":\"368e658e625c4b27\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/referenceTargetProcessor.js\":\"58a1c78af3facc9e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/replayMerge.js\":\"b97f615a9fbde5c1\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/sqlBinds.js\":\"3135b47cc6ad6875\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2cab0b8e5a45fd7f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/arrivalProcessors.js\":\"57770ad18525c1a1\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/invalidate.js\":\"1ef5bb84ef5cc1e8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/materialize.js\":\"473532b3d5ea149a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/observer.js\":\"82e1c858ff8d4f66\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/syncObserver/reconcile.js\":\"f8e2ecb0e99407c0\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/timingMetrics.js\":\"8b57a55318ac67a4\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/treeQueries.js\":\"e3e48c127fd5d095\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/txEngine.js\":\"97f77322a26c99f8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/txSnapshots.js\":\"ec793c235a26521d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/typedBlockQuery.js\":\"f6f30cc933fc8ccd\",\"/knowledge-medium/pr-preview/pr-1824/src/data/internals/undoManager.js\":\"679f1a7b63fc3687\",\"/knowledge-medium/pr-preview/pr-1824/src/data/invalidation.js\":\"85a2d735de7a5986\",\"/knowledge-medium/pr-preview/pr-1824/src/data/kernelDataExtension.js\":\"dabf0b87876b0675\",\"/knowledge-medium/pr-preview/pr-1824/src/data/kernelPage.js\":\"88dcbf1962248143\",\"/knowledge-medium/pr-preview/pr-1824/src/data/kernelValuePresetCores.js\":\"e850954e845a3f21\",\"/knowledge-medium/pr-preview/pr-1824/src/data/localDbCorruptionSignal.js\":\"e6aa012a997e4a46\",\"/knowledge-medium/pr-preview/pr-1824/src/data/localDbStorage.js\":\"e5767ce59401bccd\",\"/knowledge-medium/pr-preview/pr-1824/src/data/localDbVfs.js\":\"1c42b55297ec2e62\",\"/knowledge-medium/pr-preview/pr-1824/src/data/localSchema.js\":\"a228ca86378cf002\",\"/knowledge-medium/pr-preview/pr-1824/src/data/maintenance.js\":\"76ab5efb44a352a7\",\"/knowledge-medium/pr-preview/pr-1824/src/data/mergeProperties.js\":\"6d715411d401ba77\",\"/knowledge-medium/pr-preview/pr-1824/src/data/metricsConsoleHook.js\":\"3624215f59be2c8d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/migrationsPage.js\":\"f07710737e1c54a8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/mutators.js\":\"0541131c8ac0f58a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/orderKey.js\":\"ed2e8ddff2b7ee8f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/orderKeyPlacement.js\":\"7dba00a5f41a6a90\",\"/knowledge-medium/pr-preview/pr-1824/src/data/outlineSurface.js\":\"ec39e2e1d8e043e5\",\"/knowledge-medium/pr-preview/pr-1824/src/data/pendingEditorContent.js\":\"12b934231ffcadf0\",\"/knowledge-medium/pr-preview/pr-1824/src/data/pendingUploadsSql.js\":\"f82cc2e951496105\",\"/knowledge-medium/pr-preview/pr-1824/src/data/pluginStateExtensions.js\":\"b4413a4a8fa16379\",\"/knowledge-medium/pr-preview/pr-1824/src/data/powerSyncLogger.js\":\"7ab7faf96d19a53b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/projectorRuntime.js\":\"cd48d962556c552e\",\"/knowledge-medium/pr-preview/pr-1824/src/data/properties.js\":\"81f32d903b781486\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertiesPage.js\":\"405136c90796a4dd\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyChildren.js\":\"b04d7b66605ef649\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyDefinitionFanout.js\":\"15aa86b143e22e97\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyDefinitionMetadata.js\":\"b2624d4083bd937a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyDefinitionRegistry.js\":\"8e4dc31d43d97c94\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyDisplayMode.js\":\"daccc8b88c54c583\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertyRowCreation.js\":\"a6d9d5daaa50160b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertySchemaCreation.js\":\"4737341121dbd750\",\"/knowledge-medium/pr-preview/pr-1824/src/data/propertySeeds.js\":\"d779649dd1238059\",\"/knowledge-medium/pr-preview/pr-1824/src/data/recentsPage.js\":\"c5d7cf56f53e07d5\",\"/knowledge-medium/pr-preview/pr-1824/src/data/referenceBlock.js\":\"eb5f9504b76814f6\",\"/knowledge-medium/pr-preview/pr-1824/src/data/rejectedUploads.js\":\"9e6d653137c5e3db\",\"/knowledge-medium/pr-preview/pr-1824/src/data/releasePowerSyncConnection.js\":\"ad1b3b7c9363c0cd\",\"/knowledge-medium/pr-preview/pr-1824/src/data/repo.js\":\"89c009ddcfe66347\",\"/knowledge-medium/pr-preview/pr-1824/src/data/repoProvider.js\":\"c60eac40535a4fd5\",\"/knowledge-medium/pr-preview/pr-1824/src/data/rowProperty.js\":\"9f235b007744348b\",\"/knowledge-medium/pr-preview/pr-1824/src/data/searchFilter.js\":\"cd8e4f83666bb0e2\",\"/knowledge-medium/pr-preview/pr-1824/src/data/seedIdentityLedger.js\":\"af807dae544d2bf2\",\"/knowledge-medium/pr-preview/pr-1824/src/data/stateBlocks.js\":\"008641765ef9cc40\",\"/knowledge-medium/pr-preview/pr-1824/src/data/structuralEditPolicy.js\":\"09c683fb871af3a8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/subtreeDelete.js\":\"4067be2ab319a367\",\"/knowledge-medium/pr-preview/pr-1824/src/data/syncStreamLock.js\":\"6bc52e8158c09a02\",\"/knowledge-medium/pr-preview/pr-1824/src/data/syncedTableSqlRecognizer.js\":\"298ff32ab63fb7f7\",\"/knowledge-medium/pr-preview/pr-1824/src/data/syncedTableWriteGuard.js\":\"8946e1ec6587de78\",\"/knowledge-medium/pr-preview/pr-1824/src/data/targets.js\":\"f13c799607b599c2\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeColors.js\":\"2e159ecbf5ad2461\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeDefinitionMetadata.js\":\"7d2bf38b476cedd2\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeDefinitionRegistry.js\":\"cbb5a36b7f0483cf\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeExtraction.js\":\"91cdbf610f94d519\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeInitialValues.js\":\"ac5575922ff12db9\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typePropertyGroups.js\":\"c9d68d62ecf4ed0d\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeSeeds.js\":\"6fee5f6a2c55d84a\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typeTagger.js\":\"50ef0d50dd752f7f\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typedRecords.js\":\"be97cfb1e7510805\",\"/knowledge-medium/pr-preview/pr-1824/src/data/typesPage.js\":\"850aa92b4875b793\",\"/knowledge-medium/pr-preview/pr-1824/src/data/userPrefs.js\":\"ed00642ca440f357\",\"/knowledge-medium/pr-preview/pr-1824/src/data/userSchemasService.js\":\"28e352c4b7753e23\",\"/knowledge-medium/pr-preview/pr-1824/src/data/userTypesService.js\":\"f3fc1306e82c15ab\",\"/knowledge-medium/pr-preview/pr-1824/src/data/valuePresetRegistry.js\":\"d6969e0d530a6c33\",\"/knowledge-medium/pr-preview/pr-1824/src/data/visibleChildren.js\":\"e3cd32cf29ba07f8\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaceConversion.js\":\"e03287961a6a0cfa\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaceFirstSync.js\":\"7a96b7342420e6ab\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaceIdNamespace.js\":\"17c09c91f88b9111\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaceSchema.js\":\"14da87919dc94c04\",\"/knowledge-medium/pr-preview/pr-1824/src/data/workspaces.js\":\"3767419d355b9725\",\"/knowledge-medium/pr-preview/pr-1824/src/data/writeAheadLog.js\":\"621f515f68fe50bf\",\"/knowledge-medium/pr-preview/pr-1824/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/BlockPasteShellDecorator.js\":\"40884992c5fd6099\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/atTrigger.js\":\"738d4d1916f36d8b\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/autocomplete.js\":\"93f21d0cadbf2604\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/codeMirrorExtensions.js\":\"c15450374d326a73\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/contentFlush.js\":\"12c4d5b95055e3ad\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/defaultInteractions.js\":\"abb8f84ad89145bc\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/editSettleSignal.js\":\"0083b852b21e300b\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/insertImage.js\":\"5061a20e8563730d\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/referenceCompletionRange.js\":\"113b42d6d004cb03\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/referenceTargetTypes.js\":\"f42e7d250e3f35fe\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/syntaxContext.js\":\"c3da3500215cd350\",\"/knowledge-medium/pr-preview/pr-1824/src/editor/triggerMatch.js\":\"f86aca1454cd720e\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/AppRuntimeProvider.js\":\"b2531123e2ac80ae\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/BlockFocusShellDecorator.js\":\"0bf54fbea5f21c0e\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/ExtensionRenderBoundary.js\":\"319b552eef0989d9\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/PanelContentRecovery.js\":\"50e973fa62e46ad0\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/apiCatalog.js\":\"c1b1b2eccd6e101a\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/approveExtensionHere.js\":\"ea1fda97fc61db34\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/armedCutAppMount.js\":\"183089456e3dd0a2\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/batchableKeyedStore.js\":\"ff8132a7958508e9\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/blockInteraction.js\":\"ddf3638132ffeb70\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/blockSelectionAction.js\":\"afd1548d62ca71d7\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/compileExtensionModule.js\":\"99c72fe22c83d4d4\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/compiledModuleCache.js\":\"7f6ed6909595e657\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/continuousGestures.js\":\"f8fbe779b15eab7a\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/core.js\":\"d420b5329ad5cb8a\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/defaultRenderers.js\":\"a1d5ead77be66809\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/definitionFanoutAppMount.js\":\"3e2f17d63ff6c1fe\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/dialogAppMount.js\":\"1c58ef24740bf6fa\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/dynamicExtensionSeeds.js\":\"cdb0cc0628b9fc19\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/dynamicExtensions.js\":\"fa9beeacc6210e87\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/exampleExtensions.js\":\"366cc90d783c2ef9\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionApprovalStatus.js\":\"ab8d58288fae9fba\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionLoadErrorToast.js\":\"d59f4aaa1693b156\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionLoadErrors.js\":\"471689f1259dbeff\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionLookup.js\":\"3c6bce81210d854f\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionToggles.js\":\"7566f7d7294939d7\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/extensionUtilitiesCss.js\":\"40274c2b5d7132fb\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/kernelPageDeletionGuard.js\":\"362953f8b100d4e0\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/liveRuntime.js\":\"b8e92b9ecca9cf3f\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/openExtensionsSettings.js\":\"5fc70fadb5236aec\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/overridesCache.js\":\"cbdbbfc3fea5e375\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/pluginIds.js\":\"be2b0073336b0cb7\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/processorRejectionToast.js\":\"0e752860956099cb\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/runtimeActions.js\":\"97f24f6f627faee4\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/runtimeContext.js\":\"28ca326355ba4ef1\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/staticAppExtensions.js\":\"7b9d8b4820a821bf\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/staticDataExtensions.js\":\"e819d9873f1236c7\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/toastAppMount.js\":\"34ee56b1abad0d3e\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/useOverrides.js\":\"1b981a073d2905fb\",\"/knowledge-medium/pr-preview/pr-1824/src/extensions/useShortcutSurfaceActivations.js\":\"a7043ad9f09768f3\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/discoverToggleTree.js\":\"ac414823eebd954b\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/facet.js\":\"0e41d846216df257\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/resolveAppRuntime.js\":\"0886a6af59c6fe21\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/runtimeEvents.js\":\"686f95b2514f4d18\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/togglable.js\":\"2cf4d1d42ed9ba24\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/variantFacet.js\":\"bf26d6ea7599110f\",\"/knowledge-medium/pr-preview/pr-1824/src/facets/verbFacet.js\":\"1174c56e2baf9074\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/block.js\":\"5ae43c71a9684f50\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/focusedChild.js\":\"ee7f59910413d89a\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/propertySchemas.js\":\"d86e14d9cb00a69a\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/typeRegistry.js\":\"59cbc2c363acf1b9\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useAncestorCrumbs.js\":\"e0c16e55d49b46a7\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useAutocompleteListbox.js\":\"1e9f2f182001ac1b\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useDebouncedSearch.js\":\"7b7e85cbef0d461d\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useDebouncedValue.js\":\"3da1db3e996f07e3\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useIsFocalRender.js\":\"ce02fd8c1415f720\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useIsReadOnly.js\":\"896b3681efc9baa4\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useMaterializeBacklog.js\":\"5944ec99a2f91f37\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useMinuteClock.js\":\"d2d12805ef299c9d\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/usePanelLayoutProjection.js\":\"c641ede0a8518e66\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/usePendingInvitations.js\":\"979e1bd2c320d738\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useRendererRegistry.js\":\"b25a3a4930efb5ba\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useRetainedFieldRows.js\":\"93bd264aef8f1d7c\",\"/knowledge-medium/pr-preview/pr-1824/src/hooks/useWorkspaces.js\":\"74818b3baf04dce6\",\"/knowledge-medium/pr-preview/pr-1824/src/lib/utils.js\":\"f05bee1e68c73e07\",\"/knowledge-medium/pr-preview/pr-1824/src/main.js\":\"32eb417ac1a66e4f\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/MarkdownImage.js\":\"4733fba6a11dc682\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/blockSeparators.js\":\"2fffc947fb58746b\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/context.js\":\"96687b16dd0e0077\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/defaultMarkdownExtension.js\":\"a1c3ed967f7fbe70\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/extensions.js\":\"5635efd2bc9dd240\",\"/knowledge-medium/pr-preview/pr-1824/src/markdown/renderMarkdownHtml.js\":\"72b12b057511ff54\",\"/knowledge-medium/pr-preview/pr-1824/src/minimal-editor.js\":\"e8f5d06e506b14fc\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/armedCut.js\":\"a46e48bce8633a2d\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/captureMediaVerb.js\":\"402ede0be9d5aa3b\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/clipboard.js\":\"69e284e3ad66634c\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/decision.js\":\"d5236f90ef775d98\",\"/knowledge-medium/pr-preview/pr-1824/src/paste/operations.js\":\"5a80bbfd51dd5563\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/account-header/AccountHeaderItem.js\":\"555debc174a15f5d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/account-header/index.js\":\"08dda40a9af091d7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"dbfb7bf9e901ccc2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/askAgent.js\":\"71712f8ac5a48488\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/askedStore.js\":\"0494201ca91a7dfe\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"4c69d6411cf47bcb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/chipState.js\":\"bea3cc987522a136\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8a7e8b7a4ab87cb6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/index.js\":\"bdd06eaf8dc5166c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"873b2099d55cbf65\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-dispatch-companion/schema.js\":\"7a408a1661ff40c0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/AgentTokensDialog.js\":\"72ce461a4e13e821\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e25245e213df5d78\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/addMedia.js\":\"493d6c1b643f1caf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/backlinks.js\":\"363b6ac26d96a491\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/block.js\":\"08dc6d53303dbc67\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/context.js\":\"8dead75d6a3fe153\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/displayIds.js\":\"090d618f4e2a4532\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/index.js\":\"65f79ccbd1f66fcb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/outline.js\":\"1c62b8c530945b96\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/properties.js\":\"51cf1a1b3dd3d44c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/refs.js\":\"ca4b332a710e7ea9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"10ee6348caf26c42\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/search.js\":\"fc65f098bbf56e0c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/shared.js\":\"62640701c3fef9a2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2cdd283f39def08a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentViews/text.js\":\"71e29a52159e7629\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/agentWrites.js\":\"d02c9d8dab49b507\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/authoringCatalog.js\":\"3fb70a3d388fbd80\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/blockRefTargets.js\":\"32b3051af27a405e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/bridge.js\":\"540e57792b6e89d2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/bridgeLoop.js\":\"5d080e908c309978\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/changeHistory.js\":\"26a35bb338c2fe0e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/commands.js\":\"a15aa4ecb9d83ef0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/commentsCommands.js\":\"3dd69c96b0d03ce8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/dataExtension.js\":\"b83fe5d35a10a8c9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/dataModelGuide.js\":\"ee88076436d9d5e9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/describeRuntime.js\":\"e8916a21688338f1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/extensionLint.js\":\"1d6ec8f07a09e494\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/grainAudit.js\":\"ffd2ed950fa59ac3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/healthCommand.js\":\"ee84088b657728d8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/index.js\":\"c9eb258e43ed0683\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/presetIdentity.js\":\"4e37dd4c4f512c2f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"543e1693f4d8f3b7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/readMedia.js\":\"c641a43e29a7b1c8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/schema.js\":\"3a150cf1f5d33514\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/serialization.js\":\"ff7a639c21685b5a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/targets.js\":\"e2b81338ccb6c3c1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/tokens.js\":\"360b25e671a01da4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/watchEvents.js\":\"decae8f09193e4b3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/workspaceGuard.js\":\"0d1dd9500a0bdd22\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/agent-runtime/writeCommands.js\":\"d1d29af5b3fb944b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/AliasCollisionToast.js\":\"0e21640bd7c57b00\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/DuplicateNameBanner.js\":\"8e1282c6d983a6a9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/collisionMerge.js\":\"2eea6c88e0ae430b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/dataExtension.js\":\"0577dc594bb5f3c9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/index.js\":\"f8b1c68315c3cea7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/mergeCollisionAction.js\":\"9efdb43194e5237a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/pageStyling.js\":\"d5ff0c533a0fb79d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/rejectionToast.js\":\"824cb9fc8fce09af\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/alias/syncProcessor.js\":\"e8d959b48c824aa1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/actions.js\":\"cbad823d72b56a94\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/addComment.js\":\"1b8668de29d1c609\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/anchor.js\":\"a866ab44cf77e367\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/anchorState.js\":\"b6c9192b1a74229c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/commentLinks.js\":\"0ba4a281fc2ca445\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/confirmThreadDeletion.js\":\"76b46c8785080327\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/container.js\":\"d01e6d3cf73dd8b8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/dataExtension.js\":\"0a2ef53ce3634c71\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/deleteComment.js\":\"6c002e98a96d0e41\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/highlights.js\":\"bc4e1b623cbf491c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/index.js\":\"897a3a153988ef0e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/linkedCommentsPill.js\":\"b3e5d4766d724a2f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/margin.js\":\"68763af0808a1071\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/marginSchema.js\":\"7e142370bbfbd6f1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/newComment.js\":\"7f2f8b76c3aa2f18\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/ownThreadPicker.js\":\"e65678029189bd58\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/placement.js\":\"ed3df045c1c8c320\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/queries.js\":\"000e98b94badacad\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/quotePosition.js\":\"63d9cdebb306da3a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/quotedIn.js\":\"f38ef0cd9f013e70\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/quotedRange.js\":\"7f9b87209fe787e7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/rangeRefs.js\":\"1a31baa51ff53d87\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/readHighlights.js\":\"9a9b3385d724562b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/readSelection.js\":\"d0491cd0893fbf12\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/readSelectionUi.js\":\"93e82a1c71122d16\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/reanchor.js\":\"e2ab670c54f5d021\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/schema.js\":\"11b8c4e92f8b8ac9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/scope.js\":\"87f415bfb3887496\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/scopeThreads.js\":\"52e2bd83bd7b5efc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/splitRetarget.js\":\"f335cc7790f611d8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/suggestionCard.js\":\"42a29581997005fa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/suggestions.js\":\"32d4a442ae47b98e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/summaries.js\":\"a1c804197d1175e7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/summaryBatch.js\":\"3c0daf4adaadc1af\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/surface.js\":\"7f5388641b31a242\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/threadNavigation.js\":\"7c85ab915b76b2e0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/threads.js\":\"48fe431e118ca393\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/ui.js\":\"aac417384b8b4c2c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/annotations/uiStore.js\":\"322e880e4eb4d3c1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/app-intents/appIntents.js\":\"4d8b91862efc1ac6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/app-intents/index.js\":\"52cce8287871c7a1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/app-update-prompt/index.js\":\"77b86ab6c22d56f1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/app-update-prompt/status.js\":\"8762ce5df4ae67ed\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fdf77e86b695d8e3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/MediaBlockRenderer.js\":\"6efe0b2b70b19067\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b797f6a65515fb9a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/MediaUploadReconciler.js\":\"bc3c636055f20665\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/assetDownLane.js\":\"048dfeed6019ee2f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/assetResolver.js\":\"d60952dd5fca439e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/assetUpload.js\":\"387d49ed2462011e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/attachmentCleanerIO.js\":\"d3172b5e7eb437ba\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/supabaseAuditIO.js\":\"9a632c0e830193c0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/blobStore.js\":\"b1e8c390184dc07a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/byteStore.js\":\"87f2a2dc07c35dc0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/cleanerIO.js\":\"2b30e9bd520ffe56\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/cleanupAttachments.js\":\"0855f63ffb2badbb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/dataExtension.js\":\"e1582d7081de810e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/downLane.js\":\"bf73d27c13aa13ba\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/index.js\":\"869ef15a0e510702\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/insertImageContribution.js\":\"2106ca05580c1c4f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/laneArming.js\":\"1367f17cb8f25ec1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/laneLock.js\":\"4486e3332d2fc45b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/mediaBlock.js\":\"a3a0df5beda4a0ec\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/mediaCapture.js\":\"dd3fbe36c4db0023\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/mediaViewers.js\":\"a2da4e74032e4865\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/mediaViewersFacet.js\":\"b263b3790620e499\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/pasteCapture.js\":\"75f889e32dc78743\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/resolver.js\":\"62d1a5d9f270feca\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/retryUploadsAction.js\":\"303b6a1e8cbfb47f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/storagePaths.js\":\"ea6e8ce29a59bbfe\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadDrain.js\":\"e12184f095700c69\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadLaneStatus.js\":\"3aabbf8cb45fd0a6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadReconcile.js\":\"1f4b5ae01a7fda4f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadRecovery.js\":\"b4447d5531606878\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/uploadStore.js\":\"7a12a7346f8600ec\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/attachments/useAssetObjectUrl.js\":\"1b401fca2d7b7645\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"386922cc08857040\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/BacklinksViewSection.js\":\"de42011e26d14960\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/facet.js\":\"71ecc38bad5ce212\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/index.js\":\"e6c6b3363106f0fa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks-view/prop.js\":\"e430de48dcdec1fa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/BacklinkFilters.js\":\"0731f80ea597ab7f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"588687039a776a8f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/BlockEntry.js\":\"6e3021809eb706ae\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/LinkedReferences.js\":\"0389ce8bc3332265\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e3faa9fd1dc7e5c6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/dailyNoteDefaults.js\":\"ffc822368fb890f2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/dataExtension.js\":\"29d6e8ee8cf994ba\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/edgeExclusions.js\":\"9a7374e6b730dd5b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/filterProperty.js\":\"e4c4279792494e7c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/index.js\":\"50a212fe95b865c1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a133b06860cbcc8e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/applies.js\":\"07874920094b26b8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/countQuery.js\":\"8c42ca88f22a3655\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c4fecd4e22997761\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/index.js\":\"51202d9fa66526d8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"70dde5df2c36078b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/presentationInvalidation.js\":\"6cc4b129f284eb77\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/propertyEditorOverride.js\":\"0c61fa1861740d01\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/propertyFilter.js\":\"60c7c1e9dbd607b3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/query.js\":\"5f98f5dbf5168a50\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/resolveFilter.js\":\"b637037817458c3e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/sourceBatch.js\":\"910be176ad2b3a07\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/sources.js\":\"16824078bd2bb1d8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/useBacklinks.js\":\"90aedf94eedab10a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"00d1f87b8f5b00d8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/BirthdayCelebration.js\":\"0e504baea473bc75\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/BirthdayOverlay.js\":\"60b8f7b3fc1f3531\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/gate.js\":\"d8eafc24904f5422\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/index.js\":\"2ae1822c26feed9f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/birthday/wolfTheme.js\":\"63b328d2b928c4a1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/BlockDragLayer.js\":\"ab4864b67aa48f74\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/dragController.js\":\"f97b532a6949549c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/dropTarget.js\":\"47b3e2047c05e174\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/index.js\":\"94fca4c09ff57fe5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-drag/projection.js\":\"114a575ea287ed61\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-info/BlockMetaCard.js\":\"596be1fa9869a591\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-info/index.js\":\"ba2e33c7436bde6a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/AddTagDialog.js\":\"5e641e453511c814\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d99319e7996a4072\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/TagNameIssueHint.js\":\"0bf5b228d5c1f90c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/addTagAction.js\":\"efce50446cc66459\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/appendTag.js\":\"d5e5119b5b314dbc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/config.js\":\"a7ee3aa35b1245dc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/dataExtension.js\":\"c463c1a9edeec688\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/index.js\":\"044bdd72b59999f9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/block-tagging/propertyEditorOverride.js\":\"99d16d5839f8207d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ee62362ef38e2d13\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5a50258f7bc91ae9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d8dd689a91d3bce9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"58ca561511f56a78\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d8097e51e828025d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/index.js\":\"50e659eed08788b7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4b44a41a35cb2d5c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/CharacterCountItem.js\":\"050f768fde2cd142\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/ProfilePropertyEditor.js\":\"97c504072236183c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/actions.js\":\"d471e873cff84732\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/blockType.js\":\"ac90d27405e8ecab\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/charCount.js\":\"c5fd88de33724525\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/dataExtension.js\":\"5d4e7bdba1fe4ea5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/index.js\":\"b1ddc8e6ae9fea61\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/profiles.js\":\"4634039dce12dd6d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/properties.js\":\"7132a8a945c9f7f2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/character-counter/textCounts.js\":\"15d4d6e2ecfc929d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/colemak-keybindings/index.js\":\"8e4f27eb6375e65f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/CommandPalette.js\":\"d68a0a1dc7391bee\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/HeaderItem.js\":\"6eedb627e263ef59\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/context.js\":\"e4b687b1e7421ed3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/index.js\":\"762fcae8b29cd134\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/selection.js\":\"c794e2c37eb8a72f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/toggleStore.js\":\"65e14114cbe7721e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/command-palette/useCommandPaletteActions.js\":\"64a589e74851152b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/ContributorBadges.js\":\"4185129adce9f938\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/author.js\":\"2a30ed2e1c8139d1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/codeMirrorExtensions.js\":\"2019dd06587bd750\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/dataExtension.js\":\"439e643e46ef048d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/index.js\":\"2b8c3a8e9488f6cc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/mentionAutocomplete.js\":\"0fa2ace66b9bec84\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/processor.js\":\"c8cbeb42d25d0e1b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/profiles.js\":\"64973d33bb09dda9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/queries.js\":\"b36014a9bcf42929\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/contributors/schema.js\":\"a91bfa2e19b1126d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"0ab52540c761bd06\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d26694538eb6d535\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/index.js\":\"ba877d2422f87181\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e9830844d73d2c29\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"20747e588c4ead9e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/CalendarGrid.js\":\"f987889c338d8d04\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/DailyNotePicker.js\":\"5ad55e37798f7547\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"fa72adaeb994a1fd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/DateNavDecorator.js\":\"b3b2e64afa5bd29c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/DateScrubOverlay.js\":\"cfec043ea547ee4b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/HeaderItem.js\":\"87ba1e3a22b1e9f5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/ReschedulePicker.js\":\"96e15b7a8340c799\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/SpreadDatesDialog.js\":\"aff5dfad938006b8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/actions.js\":\"c1e2d5a3d961334a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/blockDateAdapter.js\":\"9b106441b3532492\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/calendar.js\":\"19d72c09343485cb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dailyNotes.js\":\"7ee6d8a049d7b107\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dataExtension.js\":\"6610fbffd622f9d1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dateScrubActions.js\":\"c478b7a209503bf5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dateScrubGesture.js\":\"a914a1687ec86176\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dateScrubGestureActions.js\":\"2460142a0aa330b0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dateScrubRecognizer.js\":\"282d8e1b6ac69521\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/deletionGuard.js\":\"8dbfc5ff79649d7a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/dueQuery.js\":\"c0323594ebc354ab\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/index.js\":\"acf7b0d89354bb28\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/landing.js\":\"ed7aa480a341171f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/localSchema.js\":\"b3488f8c40051bb8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/referenceDateAdapter.js\":\"c975801c1bced11e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/rescheduleAction.js\":\"90d2ed8b145e8700\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/schema.js\":\"d9aaf341d4b0ad3a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/spreadBlockDates.js\":\"ae46bea18ab95acf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/spreadDatesAction.js\":\"d7a882ff4dbde279\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/today.js\":\"5a254ce1d79e09b3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2bfb6f456f729f90\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"599208714a046294\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/audit.js\":\"9fdf33a6198e9b3c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/auditAction.js\":\"886fd9ce3d4fcab1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/auditRanges.js\":\"426d6fb5c648b8dd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/diagnosticsSource.js\":\"8a70c7104ceddd16\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/divergenceScan.js\":\"2d2405f6aabb3cc8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/index.js\":\"7510aaeecd7166d9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3e812d1ad94b2cb8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/referencesMirror.js\":\"ef5eabc3d1c18f20\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/rowJson.js\":\"8eeabdbb3f83faba\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/schedule.js\":\"62b909130671c3eb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/data-integrity/store.js\":\"2c15e736bcfda720\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-maintenance/action.js\":\"771fb4316142c917\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-maintenance/index.js\":\"b00ac8d991ecbbd1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-maintenance/plugin.js\":\"f6ddc2174eca202a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"70415a87d0b7120c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/actions.js\":\"3987baa742dee5dd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/changeMarker.js\":\"0320a3a5b61cff32\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/diagnostics.js\":\"134f3985868f4548\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/fileSystemAccess.js\":\"09f776bd45a88ddf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/filenames.js\":\"30ec79910f7d95e3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/index.js\":\"1af6d49a431c8a22\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/mirror.js\":\"c5b4959e8eac6756\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/runLock.js\":\"2c40164a5840629b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/runtimeHealth.js\":\"ab483e422a8b8bb2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/schedule.js\":\"f1c97460023cb9b5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/db-mirror/store.js\":\"5a610d6967bc8748\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/default-themes/index.js\":\"efbbd0179377923e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/default-themes/themes.js\":\"3409dc253b75dac4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/diagnostics/facet.js\":\"cbf24ace2c1ee037\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/diagnostics/useDiagnostics.js\":\"c1152abcb08a44f1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extension-prompts/dismissals.js\":\"e251a84289b44694\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extension-prompts/index.js\":\"5c16cab3974930e4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extension-prompts/status.js\":\"0639b253db7d0f57\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extension-prompts/store.js\":\"aab1bab3af473a25\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"94b5fab1612a3ebf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ab76f41dcb848db0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/actions.js\":\"bac5623a3bcce4cc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/config.js\":\"23e90aa74ab77713\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/dataExtension.js\":\"bce23341656c20c5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/effect.js\":\"c7cfbb48dfb6554f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/index.js\":\"fd041ca20b13ae2e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/propertyEditorOverride.js\":\"cb64010385619925\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extensions-settings/useToggleTree.js\":\"f16dcff073b31364\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/ExtractTypeDialog.js\":\"4bf40ed144ad1064\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"aca94952858f10a0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/PropertyShapePicker.js\":\"8190f4840fe49a6f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/action.js\":\"f831ffc491b56f17\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/extract-type/index.js\":\"312f9bb0071e5504\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/FindReplaceDialog.js\":\"1fae0e74c5546af8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/HeaderItem.js\":\"081d947bf3453033\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/dataExtension.js\":\"9cdc4a4eeba2156d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/index.js\":\"bcb2347e9081b46b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/search.js\":\"628f0642a7c60620\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/toggleStore.js\":\"c88b6299c06c19f2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/LocationPropertyEditor.js\":\"c98845a29571003c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/MapView.js\":\"f9c44c423d68d417\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/blockTypes.js\":\"9ec63213eb5ff461\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/codeMirrorExtensions.js\":\"efaebc6227fb4983\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/createOrFindPlace.js\":\"d995f1b9ff648745\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/currentLocation.js\":\"7f78adc64546f3c7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/dataExtension.js\":\"636641bf53d56f3b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/geoContentDecorator.js\":\"9df2244ab9d9be61\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/googlePlacesClient.js\":\"52cd542e86725828\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/index.js\":\"1fee2e761ec36ee9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/locationsPage.js\":\"2501b80b59907b83\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/mapViewport.js\":\"3064e7ae598f7087\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/pickCurrentLocation.js\":\"7bc3111c4a997f1c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/placeAutocomplete.js\":\"92bc3646272aeb99\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/placeNameCollision.js\":\"30e08debcdf4d5be\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/properties.js\":\"8049931e4396555d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/propertyEditorOverrides.js\":\"21bdd16962df5a26\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/query.js\":\"ffa346bf5a6ec926\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/geo/usePlaceSearch.js\":\"0c4e5746e7b3da6c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5656b5e57b6a2663\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4cc15fa9928b7ddf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"de7a68f38203bce8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/config.js\":\"9b7b38c04b949cb3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/dataExtension.js\":\"4cdc6fe5c1774b6e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/facet.js\":\"b7a531aedf7dd2df\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/grouping.js\":\"5b236b7dd953e613\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/index.js\":\"361b47786cd4fce3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"69779ef7233f76c2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/query.js\":\"588875019ef5fd8b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/resolveConfig.js\":\"571b95993a83ee9d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b9493f5177d9470d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ecbaa1cf45c23244\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/HtmlDocumentContent.js\":\"a97d265c82e89585\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/HtmlFrame.js\":\"65c47b6b49f740fe\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/actions.js\":\"b95a9d8e71d0fd8d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/blockType.js\":\"5bfd72f74329aae6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/confirmRunScripts.js\":\"172f4280250c1826\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/dataExtension.js\":\"41c80008a0079104\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/frameAnnotations.js\":\"472e47b373f0ad55\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/frameDocument.js\":\"5434058b7b9190d9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/frameTheme.js\":\"e95071edae202e56\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/index.js\":\"581759a5b84ee780\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/scriptConsent.js\":\"196412bfb0fef399\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/sourceMap.js\":\"6922a64599c880c1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/html-document/useDocumentScripts.js\":\"e8be826c64fd60b3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/index.js\":\"bb0edb18b8dc7f38\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/record.js\":\"e7b4aa8a18ea3308\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/recordStore.js\":\"693bef0424981554\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/responsiveness.js\":\"7abb4ac983ea7ffa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/schedule.js\":\"03ce0541b0824dad\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/interaction-metrics/sessionContext.js\":\"bd8d9b23f3f525e0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9b9a3a944b6ce80f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7b3316de97b28996\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/actions.js\":\"dbb49783a05f4670\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/config.js\":\"4c2e91aa95489818\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/dataExtension.js\":\"cd32a5e79ac4054b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/effect.js\":\"54ee55ce0cb8cc84\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/index.js\":\"89ecf585aaea881f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/keyCapture.js\":\"d97235e48f913d3e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/overrideStore.js\":\"a8eab64f3c5201dd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"fd136bac76241a36\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/HeaderItem.js\":\"55cb531756a60e06\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/LeftSidebar.js\":\"7b855aa52fdb6b41\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/actions.js\":\"3a85cad8e1516afa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/facet.js\":\"4ca165d3ac8a6bb5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/index.js\":\"6a3815a1ef8c52c1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/shortcuts.js\":\"7e110a83de6506da\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/left-sidebar/toggleStore.js\":\"fa87b8066634abc5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/merge-blocks/MergePicker.js\":\"3e05964ad3b62bcb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/merge-blocks/index.js\":\"0ddb4e9e51b0d2bd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/merge-blocks/mergeAction.js\":\"9d0535f5f305b300\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/merge-blocks/strategy.js\":\"8ae288ed96080cff\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/Button.js\":\"e61ade2e27d5eb30\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6e7c5e567d0044f0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/defaultItems.js\":\"75dfb431a04dc1cf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/facet.js\":\"154949ff4e9f259e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-bottom-nav/index.js\":\"714d02bfecdc0c77\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0b7e775a7e651561\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9e80eb909b70dfb0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"dff997c8fef3645f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/facet.js\":\"5ebc57c43164c398\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/mobile-keyboard-toolbar/index.js\":\"2669cceb6ba1b5b4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/MoveDestinationPicker.js\":\"11789d90210fc1db\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4072c4e6c41d530d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/contextMenuItem.js\":\"925329452047f48d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/index.js\":\"182bbc34409c45f2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/moveAction.js\":\"ce0a476fbc313b01\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/moveBlocks.js\":\"6e880ac4e4d5ce1a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/move-blocks/selectionAfterMove.js\":\"070da7cc788c512d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/TutorialBanner.js\":\"70193af39b9813ba\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/action.js\":\"0a927b366c890211\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/bannerDismissal.js\":\"bfdfe5b6ad0ae396\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/documents/cheatSheet.js\":\"74e7b7f61fc5005d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/index.js\":\"9393979feb74ecff\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/keys.js\":\"18b53b455c5a2d87\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/landing.js\":\"9a91bca73797ecf0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/outline.js\":\"ee6ec2985a411f7c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/onboarding/seed.js\":\"1cb0cc6f1a65198e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c04e1510e6df2c63\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/analyze.js\":\"5dc3c0587c9336d9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/diagnosticsSource.js\":\"29d340e467754982\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/index.js\":\"0e76a7677125cdf3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/load.js\":\"bdfbaccc5184cd0e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/monitorRun.js\":\"7d536ab6dde8fbd2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/schedule.js\":\"1ae65743c0cefd6b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/series.js\":\"e02fc3d0f15fc6d4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/store.js\":\"e09a8394c4ff0be9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/trendAction.js\":\"2e781567d13538a3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/perf-monitor/verdict.js\":\"53fd947402f5ce32\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/plain-outliner/clickToEditAction.js\":\"a62987f7e39c1546\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/plain-outliner/index.js\":\"a9364306855d2f87\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/plain-outliner/interactions.js\":\"987d02e17445a72d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d4184e8e14784df0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/MigrationGate.js\":\"4f1e0bb7658cd771\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/MigrationGateDialog.js\":\"465107f95a379ec5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/action.js\":\"ba346eadddae0287\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/index.js\":\"d0baacddf7b14591\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/localRunMessage.js\":\"0dad8497e2f75e2a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/plugin.js\":\"b48fd05c10723386\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/progressReport.js\":\"4ece3341ffb50918\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/properties-migration/sweepProgress.js\":\"b7149109782a1072\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/FieldRowRenderer.js\":\"11046153292c5c5c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/ValueRowRenderer.js\":\"bf34f3f24d2e884f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/actions.js\":\"fbc6e91beef65ae0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/autocomplete.js\":\"013c0a3429dab77e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/fieldRow.js\":\"880c54f81c692aba\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/index.js\":\"f9fd146c3f580779\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/referenceWarning.js\":\"c2a5a57d474bc180\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/valueAutocomplete.js\":\"b8b36534ebf73a5b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/property-rows/valueSchema.js\":\"7f31acb07b49ea30\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/HeaderItem.js\":\"4d6c976c1d8e8b64\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/QuickFind.js\":\"218293fdb23217e1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/index.js\":\"6b5250f46c71820a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/recents.js\":\"0740b4b36a77979b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/resultItems.js\":\"cbaecae6ecdc5f3a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/selection.js\":\"d6372930b11f9931\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/quick-find/toggleStore.js\":\"2f1500dfbef7c1b9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/HeaderItem.js\":\"59b188953fda0252\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b8e58343b6a0908b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/grouping.js\":\"bcd57f3b0b94125b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/index.js\":\"41c6e361a7fe891c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/recents/target.js\":\"f650adc8f4b37002\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/codeMirrorExtensions.js\":\"a4ccc5f21d9dd827\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/contentPrefill.js\":\"68bd9b3d92eae197\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/dataExtension.js\":\"8b9977f150512963\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/index.js\":\"6513db971f50e3db\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"bc02ca43b2620bb4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/invalidation.js\":\"e787446ae17c43dd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/localSchema.js\":\"36d6afc0300172be\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/blockrefs/index.js\":\"5ad90c87c816da37\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"cc49cb45d1b44081\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/index.js\":\"eb60f8cc31b86dfa\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/referenceNode.js\":\"6834b3c1ea336b02\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8cecafe91c4f175f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d2c51d836bc30f64\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/wikilinks/index.js\":\"4dbb6a6a5a880085\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"df2a37c45e8233d2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"eab3c74236f7e2f7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/mergeRetargetProcessor.js\":\"af2bf4a901a0d1ef\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/parseFence.js\":\"9e3f5921ef6feb42\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/referenceParser.js\":\"df56621ee3b37cbb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/referenceProjection.js\":\"b14bbfa053232f52\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/referencesProcessor.js\":\"1196e66b9929df77\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/renameProcessor.js\":\"39c870f1dde6d3ba\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/references/spanReplacement.js\":\"c4e95f8dff0d5f71\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/rich-paste/htmlToOutline.js\":\"107a3a430707b831\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/rich-paste/index.js\":\"b291cb1ec0db2d71\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/rich-paste/normalizeClipboardDom.js\":\"678eaf9a23b5863b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/rich-paste/pasteDecision.js\":\"6096e7e79c5541ea\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/action.js\":\"c57cb65c5f152326\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/blockIds.js\":\"15536bacbd172cb4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/content.js\":\"990719da71047e57\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/effect.js\":\"da4e1823cbae44bd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/ids.js\":\"98a4bc264eba458b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/import.js\":\"6a2300a39eaedcdc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/index.js\":\"639a281b88ae1e94\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/plan.js\":\"d70b5cce1c55d056\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/plugin.js\":\"9257d82872374abf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/promotion.js\":\"920227b8c7589063\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/properties.js\":\"6b188116160c9dbc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/references.js\":\"cecbce91b7a1ffb9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/report.js\":\"081d36186844b2bb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/roamMemo.js\":\"d713e3004c15d1b0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/runtime.js\":\"daf500ee5e9598e7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/schemaReconciliation.js\":\"7e49031d08566d1c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/srsMarkers.js\":\"56600362faf7b962\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/todo.js\":\"ceec5222e349b463\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/typeCandidates.js\":\"499e69ea44b57d42\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/roam-import/types.js\":\"9dd3c2876059b85d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/search-health/index.js\":\"838be4dd08917fe5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/search-health/store.js\":\"4915a25a423f48f1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/HeaderItem.js\":\"02cfd3e9e3a29dc0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"67fa89132b38ee43\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/index.js\":\"3b18d0cb6e9ce243\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/model.js\":\"ba35cf0918c54b64\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/toggleStore.js\":\"bec9d05ef4407d64\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/shortcut-help/useKeyInspector.js\":\"f9dd137cdef137eb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"cffdb9cda21e6071\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/ShellDecorator.js\":\"466b176e8f4bf560\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/actions.js\":\"9aee029ac4e610b7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/exclusionsFacet.js\":\"dc308d3a703c6bc2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/index.js\":\"82752468d8cd8461\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/shell.js\":\"945aa6d38bc9a41f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/surface.js\":\"7992e2cd1abbb2d4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/spatial-navigation/walker.js\":\"6c63af232001d6e5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/RescheduleToast.js\":\"58a64bdd111e31c5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/dataExtension.js\":\"13b129bec9b60c35\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/index.js\":\"6430499f36acbb71\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/indicator.js\":\"718cd35a714bf528\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/moveSrsState.js\":\"a695273aa7a2aa6f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bd95bbaaf550c27e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/scheduler.js\":\"f543eab2d63da851\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/schema.js\":\"869998176e1f8dee\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f4cdcc0cd0bae47a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/srsClipboard.js\":\"5657c73e3a7201b3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c36df7e63a7efa99\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f5ea865cf3c2287e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/DeckPicker.js\":\"f2ab0b0abf1d01d2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/ReviewControls.js\":\"d2a0695af1bc2bfd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/ReviewDeckRenderer.js\":\"47e272d9f01b08dc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/ReviewSession.js\":\"87cfdca020231048\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/actions.js\":\"e2cd590d95d65c3a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/archive.js\":\"2a6545855bdb88a3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/dataExtension.js\":\"4b95ae7df6084fc1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/deck.js\":\"06fc75a4d15cb1ac\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/dueQuery.js\":\"606d496d050efd5e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/gradeDecision.js\":\"a9cebaf1a9ae5081\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/index.js\":\"0c170c1f9db599fd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/keyHints.js\":\"7114550a3ebe5437\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/reviewCardLayout.js\":\"28d868917661c03c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/reviewProgress.js\":\"7e1e55c5c15a8a86\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/schema.js\":\"91af2b42021a47d6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/srs-review/useDueCards.js\":\"4276e981ee2b8200\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/startup-metrics/index.js\":\"8b6ce67bdae4cffc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/startup-metrics/record.js\":\"6ad0a4a9177ee90a\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/storage-persistence/index.js\":\"899fa7befb2acfd1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/storage-persistence/persistenceStatus.js\":\"ae6ab9a46b71127d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/storage-persistence/requestAction.js\":\"a1cbee8d33377b92\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/supertags/TypeChipsDecorator.js\":\"de75c9b513118ac5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/supertags/codeMirrorExtensions.js\":\"0156245f2bd42cdd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/supertags/index.js\":\"422b49e0bfc142ea\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/supertags/typeAutocomplete.js\":\"c875e3d46595f2f9\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8acc9a0cd8f388f7\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/actions.js\":\"26759e9fd22cdd74\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/anchor.js\":\"b8e55cffda09413b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/events.js\":\"04078b42caa18581\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/gestureActions.js\":\"ee711899084e4a87\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/index.js\":\"251089d292f70bcf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e816d61204f0e223\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/sync-metrics/collect.js\":\"376a5585f8ad3f20\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/sync-metrics/index.js\":\"e57693b36b9bfc31\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/sync-metrics/record.js\":\"8ff355d61fdd58fb\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/RejectionDialog.js\":\"b031295b42105db8\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/SystemStatusHeaderItem.js\":\"86abc7156d8f8668\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/index.js\":\"147bd0ec4ec221a1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/model.js\":\"2def97aa1c59629b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/queueCounts.js\":\"e3d76b8d20eef0d2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/rejectedHelpers.js\":\"15eb2cb65ef132ff\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/rematerializeAction.js\":\"61dd3ccd4ba18fea\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/system-status/useHysteresis.js\":\"d250d408c602250c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/TableLayout.js\":\"4edf8efd3925f5f3\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/actions.js\":\"d3640964cf0b4ac4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/cellEdits.js\":\"6202c81ed3d83e18\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/controller.js\":\"74af0a72433f56d4\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/convert.js\":\"b7df850febf34ef6\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/dataExtension.js\":\"bd1bbe41f70a2b7d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/index.js\":\"e63a31dac5d0442c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/keys.js\":\"0d997e16106a443b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/model.js\":\"718f83e5785f40f2\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/registry.js\":\"36a3aeff0e493f7d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/tables/schema.js\":\"deff0a94bb448a0b\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/theme-toggle/effect.js\":\"d632791c5cf52f58\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/theme-toggle/index.js\":\"ce88dcfdf296f128\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/theme-toggle/theme.js\":\"976cea22297a9560\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/todo/actions.js\":\"594c5d4843ec444d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/todo/dataExtension.js\":\"0d18f1a77f6b367f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/todo/index.js\":\"636b396afd94916d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/todo/schema.js\":\"1410b3594db1ec41\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/TouchSelectionLayer.js\":\"640cec6be0550c53\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/actions.js\":\"8b1fba378b9a1f09\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/defaultItems.js\":\"cc1d3e78ea321765\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/facet.js\":\"6dca8bd0189a3cbd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/holdRecognizer.js\":\"ee220762661fafdd\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/touch-selection/index.js\":\"8691802a30a1dcb5\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/update-indicator/UpdateIndicator.js\":\"71136930d0310f94\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/update-indicator/index.js\":\"148e8d2377142c4e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/update-indicator/loadTimes.js\":\"e5c225ca5125ec4c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/VideoNotesRenderer.js\":\"5b1622a02afc77af\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/VideoPlayerRenderer.js\":\"92e73a556d30d9bc\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/VideoTimeStamp.js\":\"b52cf09b0726936e\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/actions.js\":\"80bcf7d39c17171f\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/index.js\":\"91fd18449f1a8a66\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/markdown.js\":\"fa1c4f3e8b0f2c5d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/notes.js\":\"41a079f2ac5815e1\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/registry.js\":\"b328f43ff24a6fa0\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/remark-timestamps.js\":\"93f020a6bd9b0d62\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/video-player/view.js\":\"cbfc8f3399ba22da\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-link-hints/LinkHints.js\":\"b9bdd6b54f2d8fea\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-link-hints/index.js\":\"b8408d4e59b451cf\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-link-hints/model.js\":\"953f4d5e5fd8c049\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-link-hints/settings.js\":\"6fa2029ebff3bd1c\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-normal-mode/actions.js\":\"58ed11341d955718\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-normal-mode/index.js\":\"ea62984d6733613d\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/vim-normal-mode/interactions.js\":\"2cb1c83c7fd8a613\",\"/knowledge-medium/pr-preview/pr-1824/src/plugins/workspace-header/index.js\":\"212e261f94246875\",\"/knowledge-medium/pr-preview/pr-1824/src/registerServiceWorker.js\":\"639901ac1594b334\",\"/knowledge-medium/pr-preview/pr-1824/src/requestPersistentStorage.js\":\"1ff9c5d7ae019145\",\"/knowledge-medium/pr-preview/pr-1824/src/services/authRequestDeadline.js\":\"6b975485263313e0\",\"/knowledge-medium/pr-preview/pr-1824/src/services/authStorage.js\":\"51ec1d661282fb3b\",\"/knowledge-medium/pr-preview/pr-1824/src/services/powersync.js\":\"2dee5dacc51b0e7e\",\"/knowledge-medium/pr-preview/pr-1824/src/services/supabase.js\":\"c72d018ff17ca731\",\"/knowledge-medium/pr-preview/pr-1824/src/services/uploadErrorClassifier.js\":\"39f0ec74d5d1b3db\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/ActiveContexts.js\":\"733b5125f439ceea\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/HotkeyReconciler.js\":\"b6c8ce1b136a12c9\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/WipeLocalDataDialog.js\":\"5c5afe01c1e99522\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/actionDispatch.js\":\"4acb57a07d14ca3a\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/actionRefItems.js\":\"c9deba4554ed8621\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/applyKeybindingOverrides.js\":\"8cd9c771ba071784\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/blockActions.js\":\"5f4acceaa3d4af0c\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/canonicalizeChord.js\":\"6f410d79588af52d\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/defaultContexts.js\":\"b006984e68aef4b5\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/defaultShortcuts.js\":\"e88520c5ac0b34fe\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/effectiveActions.js\":\"dfaffc44fb78685b\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/gestureAction.js\":\"2664732d8401a369\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/gestureBinding.js\":\"4ba34e426623da05\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/holdRegistry.js\":\"42abfa9ee6d82c0b\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/keybindingConflicts.js\":\"1b0afed5c10954d1\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/keybindingOverrides.js\":\"167d8ebcdeaafffc\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/pointerAction.js\":\"bfca7e75b866b66b\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/resolve.js\":\"8804b4feab1f7c0f\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/runAction.js\":\"d422e8fe146e2bbf\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/sequenceMatcher.js\":\"f039274e0e295672\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/types.js\":\"e64b9463e7a85dc4\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/useActionContext.js\":\"cf82a4594ad3425e\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/useActionDiscovery.js\":\"93bef3ff165bf603\",\"/knowledge-medium/pr-preview/pr-1824/src/shortcuts/utils.js\":\"605c4dcb68031f08\",\"/knowledge-medium/pr-preview/pr-1824/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1824/src/sw/bootStore.js\":\"785cf0cda78f4805\",\"/knowledge-medium/pr-preview/pr-1824/src/sw/previewDatabases.js\":\"241afe7ad85bf0b3\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/byteTransform.js\":\"b33ce2c7b0b4130a\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/attachmentCleaner.js\":\"d94504175f643924\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/attachmentParts.js\":\"ed0df100cd9a2595\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/bundleParts.js\":\"10219a4d1901a59f\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/bundleRecord.js\":\"09814e65f12caba9\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/manifest.js\":\"2994d42e9a735cfb\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/takeBundle.js\":\"9880853fb41818d9\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/bundle/verifyBundle.js\":\"f58dcc3b57b84671\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/cleaningStage.js\":\"11217a21d80c3172\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/conversionKey.js\":\"4e7c32c6251ad15b\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/conversionServer.js\":\"ce9d6b4209ca9464\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/flip.js\":\"de307c60cc7a8f5a\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/flipAttempts.js\":\"576f25feea0b5cfe\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/pages.js\":\"2f84438f7ed7a4d2\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/preflight.js\":\"55d0a719c1b83468\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/reseal.js\":\"1315afc203ac5a6d\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/runConversion.js\":\"cad6a14f1cd9e3a7\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/runLock.js\":\"c4abf85f8b451ace\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/sealing.js\":\"c21ef224919f5add\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/sealingStage.js\":\"786568b91bb1cf62\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/stage.js\":\"af9b69955469bf3a\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/conversion/verifyReseal.js\":\"523c4d0b06e36d78\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/aad.js\":\"3e135a6a5876cbde\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/aead.js\":\"b97767155ca14e92\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/base32.js\":\"5a07b4995c0cd15a\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/base64url.js\":\"fe5ae15afaf1575d\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/binaryEnvelope.js\":\"819c62c3aa67254d\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/byteAead.js\":\"cbdb9959849f18c0\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/canary.js\":\"f79a5d535eb1708e\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/contentHash.js\":\"b88ab1ba58007391\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/contentKey.js\":\"5f9a9fd13fbfbdce\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/derivedIdNamespace.js\":\"b591145f664dec4f\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/envelope.js\":\"7a715791d5ee2752\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/hex.js\":\"21853d0e749b5a1a\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/sha256Hex.js\":\"3752160e4e1f28db\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/crypto/workspaceKey.js\":\"8ca712cce5465aa4\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/conversionState.js\":\"5dcedb19bb71eed7\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7f8a725b51f52bb5\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/flows/pastedKey.js\":\"21fe925d2b4c282b\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"07b0fd9371648075\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/flows/upgradeWorkspacePin.js\":\"71c64e8620fc6a3b\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/keyStore.js\":\"048a0f694d118e4b\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/mintWorkspaceKey.js\":\"d4efeffee832cf8a\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/modePin.js\":\"26c89af106d6551d\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/openWorkspaceKeys.js\":\"6e465c34f08bafa4\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/resolveWorkspaceEntry.js\":\"c22a361cb7ee113a\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/resolver.js\":\"2f609dc5a56723b3\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/keys/workspaceAccess.js\":\"f525fc67ebf4d326\",\"/knowledge-medium/pr-preview/pr-1824/src/sync/transform.js\":\"d5dfa5e3e2175b2a\",\"/knowledge-medium/pr-preview/pr-1824/src/themeBootDefaults.js\":\"08e6230da29ba540\",\"/knowledge-medium/pr-preview/pr-1824/src/types.js\":\"577bedb2a200166b\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/ClientLocalSettings.js\":\"58750904f8300cbd\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/abortableSleep.js\":\"5e7cb5ccae964ceb\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/array.js\":\"684fa4be43507c2b\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/backlinkAutocomplete.js\":\"b5ab08e46e912e70\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/blockCrumbs.js\":\"4af3af5c4a698ebb\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/blockrefAutocomplete.js\":\"26efca65bcce06d7\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/cadencedIdleJob.js\":\"008246672873de1d\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/callbackSet.js\":\"1dde409eef03fe80\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/clientId.js\":\"8e9081757bb28c0a\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/codemirror.js\":\"5ff53b8e5f96baa8\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/codemirrorCompletion.js\":\"100ed87d5a8cacd9\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/copy.js\":\"cd6ef719bc18e6b5\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dailyPage.js\":\"b1c5e0ebbe7a874c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dbForensics.js\":\"a6836674db546b80\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dbForensicsHooks.js\":\"a7639014ae402a83\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/deleteBlockThroughUi.js\":\"b9644ef9b78a523a\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dialogs.js\":\"a1a85e5aaba3dbd9\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/dom.js\":\"3cdfaab6b7d6e0b3\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/downloadBlob.js\":\"be07ac49663a3ae9\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/exportSqliteDb.js\":\"4307f11921a0cf1b\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/fileSystemAccess.js\":\"7b19e1eed3f3c5e1\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/flipSlide.js\":\"4046c71ba51161a9\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/fnv1a.js\":\"06bf984d7d42d9e6\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/formatBytes.js\":\"c4b0ddc800186f93\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/fuzzyRank.js\":\"40332c5b89964bdb\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/idbKeyedStore.js\":\"fa91a8791db69042\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/idleCallbackPolyfill.js\":\"f04980129794475f\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/keyboardAwareScroll.js\":\"d0d623019ed94357\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/keyboardViewport.js\":\"d271ec4637466d35\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/lastWorkspace.js\":\"054b75452a2678eb\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/layoutColumns.js\":\"fc1667b3fcdf9117\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/layoutSessionDom.js\":\"0f262bddc23141d7\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/layoutSessionId.js\":\"0c44cd5ed82c2833\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/linkClickGestures.js\":\"0e15b69bde4cba06\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/linkTargetAutocomplete.js\":\"286f8c743b0a7bd2\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/localDbCorruption.js\":\"35238c3e9939e7d3\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/localDbRecovery.js\":\"0d68c29a9e515f12\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/markdownParser.js\":\"e0b846518fcf9687\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/memoize.js\":\"aeb6014d2a1bcf32\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/nameFieldCommit.js\":\"6b9e5ed8d079f61f\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/nameList.js\":\"7b97015fc60901bf\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/navigation.js\":\"dc42a5a5146b73a8\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/omnilinerNamespace.js\":\"2675ecf7306b5950\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/opfsPageScan.js\":\"6b1ba01fce240f0c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelClearance.js\":\"a794fb243000aad2\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelHistory.js\":\"00048becba68b135\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelLanes.js\":\"18b15cb7781d922b\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelLayoutProjection.js\":\"65dacfbfbcde8cef\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelScrollAnchor.js\":\"c145eaebc7c6e569\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/panelUrlFlags.js\":\"c2e2b78c9b2b18e3\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/platform.js\":\"ade456df22ac8ed3\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/pluralize.js\":\"fac23b37d5ffa06e\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/propertyCreation.js\":\"af7a7e99a15056cb\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/propertyNavigation.js\":\"f37b4854f89de5bb\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/propertyValueContext.js\":\"eda8a69687f72906\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/react.js\":\"817cff91f032d8f1\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/relativeDate.js\":\"00db74f43402f76c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/relativeTime.js\":\"1d098a856a0e0f6a\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/renderScope.js\":\"b741a919672b917c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/resolvedThenable.js\":\"ff48189b07b1b9cb\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/routing.js\":\"2697128d5103b686\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/safeMode.js\":\"f92631cec3e67e3d\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/scheduleIdle.js\":\"3f6d10df336a0bce\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/screenWakeLock.js\":\"93dd08304d5876de\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/selection.js\":\"7eb5fa3670a54347\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/softKeyboardGrab.js\":\"468976cd088d959d\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/startupTimeline.js\":\"3ed2005460fc8297\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/state.js\":\"591b14134e5b7edd\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/string.js\":\"a84a769768139340\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/surfaceZoom.js\":\"78f1768b68b1c3cd\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/time.js\":\"2e43a674de5a896d\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/toast.js\":\"d80381616fd5e838\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/toggleStore.js\":\"08e8e0902687305a\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/untilStopped.js\":\"ea2d2eb3189371d3\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/userActivity.js\":\"95293891fc792d21\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/viewTransition.js\":\"851ccf59884c7ba3\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/viewport.js\":\"135354536a262f9c\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/webLock.js\":\"d14f99acee987794\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/workspaceRecovery.js\":\"a1cadf10ba458a31\",\"/knowledge-medium/pr-preview/pr-1824/src/utils/workspaceSnapshotStore.js\":\"22fa2fe61fcbf41e\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-compiler-runtime.js\":\"63907d0aeff0ab46\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-client.js\":\"250c1a40361e3f26\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-server-edge.js\":\"ce141f7ab9c39313\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-server.js\":\"52896ae1739804b3\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-static-edge.js\":\"e6bc6915f531b092\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-static.js\":\"6a46c6849e160418\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom-test-utils.js\":\"0c53fbdb75171578\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-dom.js\":\"e22fa827b5b119bd\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react-jsx-runtime.js\":\"1520eed74b9d6ca2\",\"/knowledge-medium/pr-preview/pr-1824/src/vendor/react.js\":\"c76323bc723c2fe2\",\"/knowledge-medium/pr-preview/pr-1824/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1824/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1824/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
