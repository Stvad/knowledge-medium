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
		buildId: "4c89ef12252e-86fb4f55",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/\":\"eb16cf2b0f49b34c\",\"/knowledge-medium/pr-preview/pr-1827/index.html\":\"eb16cf2b0f49b34c\",\"/knowledge-medium/pr-preview/pr-1827/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1827/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1827/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1827/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1827/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1827/assets/FacadeVFS-BJx3qSue.js\":\"e4faefc34ad4450a\",\"/knowledge-medium/pr-preview/pr-1827/assets/OPFSCoopSyncVFS-CSztcgph.js\":\"d8dcabbc9f0a116c\",\"/knowledge-medium/pr-preview/pr-1827/assets/OPFSWriteAheadVFS-BfkTHPB_.js\":\"c3252f3cea6ba914\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-DNbaKFj4.js\":\"832b433367836062\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-async-Bw-0QdLq.js\":\"650da3f9e67dc548\",\"/knowledge-medium/pr-preview/pr-1827/assets/worker-BnKVn6lq.js\":\"c343a7aef62e9304\",\"/knowledge-medium/pr-preview/pr-1827/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1827/chunks/app-CLw8falt.js\":\"6c5aa9f99ebf9e2f\",\"/knowledge-medium/pr-preview/pr-1827/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1827/index.js\":\"16ba1b6a1f0f12b9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1827/assets/AccessHandlePoolVFS-DGxTHCVK.js\":\"d342dce131272a43\",\"/knowledge-medium/pr-preview/pr-1827/assets/IDBBatchAtomicVFS-BSnXcsyy.js\":\"60da7224f460233d\",\"/knowledge-medium/pr-preview/pr-1827/assets/MemoryVFS-vr-ei-Lw.js\":\"6f684304e78b6658\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-CCl87bFe.js\":\"10fb1f38f4f68918\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-async-BQc4o316.js\":\"c4f0a3e0cbd30cec\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1827/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1827/chunks/AccessHandlePoolVFS-B9yq0Hh0.js\":\"6e9eeb1aa3e8f412\",\"/knowledge-medium/pr-preview/pr-1827/chunks/FacadeVFS-D9tyH9-2.js\":\"5ee61a2f15d916cc\",\"/knowledge-medium/pr-preview/pr-1827/chunks/IDBBatchAtomicVFS-B_rBAKhP.js\":\"0641abc4033a9f07\",\"/knowledge-medium/pr-preview/pr-1827/chunks/MemoryVFS-DCSyMoo1.js\":\"7d704f1fb8f47ea8\",\"/knowledge-medium/pr-preview/pr-1827/chunks/OPFSCoopSyncVFS-CgUl_NOW.js\":\"b23599f22ea30968\",\"/knowledge-medium/pr-preview/pr-1827/chunks/OPFSWriteAheadVFS-H1BMpNeJ.js\":\"0a465e0e6d5551ce\",\"/knowledge-medium/pr-preview/pr-1827/chunks/Preview-seeaOH7A.js\":\"f6e918a0997706fc\",\"/knowledge-medium/pr-preview/pr-1827/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1827/chunks/card-hs-Bc6aK.js\":\"b9547b04c4dfdd24\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-CzyPXCKy.js\":\"67dbb4cc1e6768be\",\"/knowledge-medium/pr-preview/pr-1827/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1827/chunks/mc-wa-sqlite-DClNF4lE.js\":\"4dde8e37b0eda770\",\"/knowledge-medium/pr-preview/pr-1827/chunks/mc-wa-sqlite-async-BWLQWMGv.js\":\"a7c1ff5844e3d6fa\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-B7wEENNM.js\":\"5ae42df7d6aa3f74\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CT-sQuCj.js\":\"aec9f14f7606d3cb\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CqnloENA.js\":\"3650d4f0252010e8\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-Cr4h-jSp.js\":\"ae83d1bbd0567dc3\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-DsAW7I-7.js\":\"2f99a0eb87296897\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-DvNl-Bbr.js\":\"b3d8cf44a0db9bc8\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-Yz0B0VzK.js\":\"913182801b5fdc4e\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server-legacy.browser.production-DX9t3gYH.js\":\"6954678979be55bc\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server.browser.production-CiR1FBL_.js\":\"4be51f4a1a68c3c1\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server.edge.production-B5Ix_nuT.js\":\"214d67be9c76df4e\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-k_aNnO2q.js\":\"d78a006ecaef503b\",\"/knowledge-medium/pr-preview/pr-1827/chunks/server.browser-CbmNjofm.js\":\"02e96a40b2547423\",\"/knowledge-medium/pr-preview/pr-1827/chunks/textarea-BkwJErQb.js\":\"557228fd604f95e0\",\"/knowledge-medium/pr-preview/pr-1827/chunks/ui-CrDiscwg.js\":\"0e9fa6f2b5880ea0\",\"/knowledge-medium/pr-preview/pr-1827/chunks/wa-sqlite-BFnCwE4u.js\":\"cb7d5e6019e54a0d\",\"/knowledge-medium/pr-preview/pr-1827/chunks/wa-sqlite-async-DnyFY4tg.js\":\"3ffc1601f3e9c7c1\",\"/knowledge-medium/pr-preview/pr-1827/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1827/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1827/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1827/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1827/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1827/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1827/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1827/src/App.js\":\"e04442faa83e6b69\",\"/knowledge-medium/pr-preview/pr-1827/src/appUpdate.js\":\"c0364917494d3970\",\"/knowledge-medium/pr-preview/pr-1827/src/appVersion.js\":\"528859657e03d4b7\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/initialLayout.js\":\"c396734650905e0d\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/openWorkspaceData.js\":\"9d16c9fb966e47d4\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/resolveWorkspace.js\":\"ef7fd5b3ad4bb44c\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/workspaceBootstrap.js\":\"e6addb7675f6c36e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockComponent.js\":\"112c8f91faee5cb9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockCrumbs.js\":\"66b3abbff8e3587b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockEditor.js\":\"1346e210188d0693\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockLoadingPlaceholder.js\":\"b9faaa17a8d293d5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockProperties.js\":\"2a7ca2ba3325f4c7\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockSearchPicker.js\":\"3d039faa142ffe24\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ConfirmBulkDeleteDialog.js\":\"f7502f2224cc5d99\",\"/knowledge-medium/pr-preview/pr-1827/src/components/DividerHandle.js\":\"cbc2a6c274a00b62\",\"/knowledge-medium/pr-preview/pr-1827/src/components/DraftEditor.js\":\"5c6ad4ff24fda01b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/GutterPill.js\":\"488364c0023faf08\",\"/knowledge-medium/pr-preview/pr-1827/src/components/Header.js\":\"eace3aebbfd5f3fb\",\"/knowledge-medium/pr-preview/pr-1827/src/components/LazyBlockComponent.js\":\"18095aadccdfec9e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/Login.js\":\"6504ebbda0a1ad44\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ZoomableSurface.js\":\"651845dc3f2ad295\",\"/knowledge-medium/pr-preview/pr-1827/src/components/editModeKeepalive.js\":\"a0d078f274486995\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyDisplay/PropertyDisplayScope.js\":\"78c2a8e495bfbc3e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"9c254e8f681c1ecc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/RefPropertyEditor.js\":\"c57a632fc6f1e876\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/RefTargetTypePicker.js\":\"02337455ab506802\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/SelectPropertyEditor.js\":\"9e7a78925a8424fb\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/TypesPropertyEditor.js\":\"4a1aad49aa2034dc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/defaults.js\":\"8fc3bc41ba81800c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/kernelValuePresets.js\":\"45d0af30ac736fb8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/selectablePresets.js\":\"bb291878e889822f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/typesPropertyUi.js\":\"281ee5c50784c86d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/AddPropertyForm.js\":\"905732da2a255d64\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/PropertyPicker.js\":\"575d15d543cc5ae8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/PropertyRow.js\":\"9f3f603ecff1e771\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/Rows.js\":\"73bc5e535cc52375\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/actions.js\":\"7034a41b59c733e0\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/declarationOnly.js\":\"79b4d4802924aaf2\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/layout.js\":\"6695e812df507e87\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/model.js\":\"50a97d1cbec66e68\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/shapeUi.js\":\"702870696e3b9f6c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/shapes.js\":\"29ac396eda1966d4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/usePropertyEditingActivation.js\":\"455056cf6ad9ab6c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/visibility.js\":\"883fd38752735663\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanelSections.js\":\"88440829ee0df1d4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockEmbed.js\":\"e0ba7ed422d1cced\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockLink.js\":\"1a52c2182a008fc3\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockRef.js\":\"c9e50af37f372a6f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/ReferenceLink.js\":\"e6c8bb15aa330d6f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/cycleGuard.js\":\"4a6552f00b09a7ee\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/cycleGuardContext.js\":\"86e99d0666c219de\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/linkInteraction.js\":\"4a9d2b36b322059b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/referenceLayout.js\":\"5f60adf7f206402c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/useBlockRefAncestors.js\":\"d688e65dba5d0bb5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockGutter.js\":\"f8a40e697d3f468b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockInfoDialog.js\":\"8f4bbcf969836609\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockTypeBlockRenderer.js\":\"23eed51994966856\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BulletHoverCard.js\":\"342fd7dbcf632a62\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/CodeMirrorContentRenderer.js\":\"d9fba139dedd0952\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9235594ee54555bd\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/ColumnResizeHandles.js\":\"963e0d527a04717f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e9cef7ef85a6250c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/DefaultBlockRenderer.js\":\"b52a8530e8e04af0\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/LayoutRenderer.js\":\"d19f6470bb3646cc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/MarkdownContentRenderer.js\":\"3c398c01e6fc9ff8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/MissingDataRenderer.js\":\"cc77e5b7e4c3945f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/PanelRenderer.js\":\"d384bcb3e874cfb6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f06d8d8aee4f1e29\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/TopLevelRenderer.js\":\"3b610fc0bde104eb\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/blockGutterMode.js\":\"5a37899293cecc68\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/blockTitleText.js\":\"c1e70fa0ed151aee\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/fieldCreationKeydown.js\":\"4ce9c5919924897d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/layoutRootContext.js\":\"a38ea896f7f4d87d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/typeChip/TypeChip.js\":\"42c37191814b07a6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/typeChip/chipStyle.js\":\"c60efdcd2e9914da\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/anchored-floating.js\":\"2221d8f33e1bfa55\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/button.js\":\"d756f4fb576b33be\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/card.js\":\"84e4fb0365e4adc2\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/checkbox.js\":\"6b8f46dd4f472d93\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/collapsible.js\":\"2dbcb651aba31352\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/command.js\":\"4e73cef7ba1abc78\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/context-menu.js\":\"7df87a65634492df\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/dialog.js\":\"25bc25bdf79f2575\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/dropdown-menu.js\":\"b1c1feb1d1f623ad\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/floating-listbox.js\":\"806f922fc7fa9bf8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/index.js\":\"345e052b5638502e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/input.js\":\"37a3312723b13ce6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/kbd.js\":\"8dc61b3063b1f45a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/label.js\":\"bab5bfedbb9bacee\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/textarea.js\":\"4f2b608689794a82\",\"/knowledge-medium/pr-preview/pr-1827/src/components/useEditModeYieldKeepalive.js\":\"70b93104514777cb\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/BootFallback.js\":\"ebb79362b8a96b05\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/FocusedRowLazyMount.js\":\"9fe9ab8e0d7d8bff\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/LazyViewportMount.js\":\"fd70787748eb3361\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/LocalDbCorruptionFallback.js\":\"dbebaca9d7e6545d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/error.js\":\"dc0e2cb8dc85e438\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/lazyMountRegistry.js\":\"0505325c0e50ea85\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/suspense.js\":\"46241c3563cef598\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/CreateWorkspaceDialog.js\":\"6cf1b73ed701d34d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/PendingInvitations.js\":\"588f146c575190c8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/SyncProgress.js\":\"be5f5903204a8f42\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/UnlockProgress.js\":\"e5db3304c3f22091\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceKeyGate.js\":\"325b250ac6a582e2\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSettingsDialog.js\":\"74b087b0325bff24\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSwitcher.js\":\"dab953e170cc1e17\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSyncGate.js\":\"60ce67cd4a20f1a9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/ConversionFlow.js\":\"7b61fe23504d3e18\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/ConversionFlowHost.js\":\"663216774961e1c4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/EncryptionSection.js\":\"742e756ec73669d1\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/attachmentPrompts.js\":\"66287e1965abdcd7\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/bundleFolderPrompts.js\":\"13129c74ae0e67e5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/conversionFlowDeps.js\":\"c9b8a81298669f36\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/conversionFlowStore.js\":\"f52b7ba500a02c4d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/flowUi.js\":\"a40837021f343d23\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/useConversionRun.js\":\"dc24037b00cd1434\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/keyUi.js\":\"6f451fb378d0c929\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/useCloseOnKeyLoss.js\":\"9e83a87969828c87\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/useCloseOnServerE2ee.js\":\"c9f74a3035f27ff0\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/workspaceUnlocked.js\":\"c35e24a54915bd2d\",\"/knowledge-medium/pr-preview/pr-1827/src/context/backgroundSubtree.js\":\"08848ae2f85fa0b1\",\"/knowledge-medium/pr-preview/pr-1827/src/context/block.js\":\"abfdf64b8aa0946c\",\"/knowledge-medium/pr-preview/pr-1827/src/context/layoutWsContext.js\":\"4919b1fc7d8e0a51\",\"/knowledge-medium/pr-preview/pr-1827/src/context/propertyDisplay.js\":\"970f35ac09a63302\",\"/knowledge-medium/pr-preview/pr-1827/src/context/repo.js\":\"0ae644ce1811f565\",\"/knowledge-medium/pr-preview/pr-1827/src/data/aliasClaim.js\":\"047599769ebc1b89\",\"/knowledge-medium/pr-preview/pr-1827/src/data/aliasSeatNamespace.js\":\"bce72be5b126c184\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/blockData.js\":\"74784a52600eb3b5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/blockType.js\":\"c694ff4a5ccb1842\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/changeScope.js\":\"fc01628ff40314fe\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/codecs.js\":\"d2154b8a8c16bd74\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/derivedData.js\":\"b193eddae4dc25c8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/errors.js\":\"e1d39d84fa461ce3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/events.js\":\"8508e7ee506578b5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/handle.js\":\"d11dd090b0b86f84\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/index.js\":\"29cbd26afac171d7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/mutator.js\":\"06a134aa40a7cdcf\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/processor.js\":\"e121b3dd007c21f4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/propertySchema.js\":\"160dd42cf8f8b8ef\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/query.js\":\"e2fc93436f537dfb\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/sameTxProcessor.js\":\"2b7a286d1122a804\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/schema.js\":\"d11dd090b0b86f84\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/tx.js\":\"d11dd090b0b86f84\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/typedBlockQuery.js\":\"ec5747d61b899d13\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/user.js\":\"76e4ef998162d137\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/valuePresetCore.js\":\"d0d6f18a75d64873\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/valuePresets.js\":\"52e909bc2bcbbad5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/attachmentCleanerIOVerb.js\":\"f03281f00a84488d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/block.js\":\"f4f3624a764682c1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockCache.js\":\"c71d96e8243b74fd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockId.js\":\"c70938628366b7e4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockLiveness.js\":\"a928fdfacda95942\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockMerge.js\":\"46e4ad6e1e8e1ee4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockSchema.js\":\"016fdec19d77b0e3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockTypes.js\":\"38d2a631cf2d227d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/clientContext.js\":\"ca5fd28d2ba0e28f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/dbFileSiblings.js\":\"e8aa3e29e96d793f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/definitionSeeds.js\":\"1713ce25b8fad56c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/derivedIds.js\":\"12a69470f2fad605\",\"/knowledge-medium/pr-preview/pr-1827/src/data/drawnSubtree.js\":\"0027dad8d19442b3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/facetBridge.js\":\"ea383dbb8ecbfe57\",\"/knowledge-medium/pr-preview/pr-1827/src/data/facets.js\":\"67608886d61eaf6d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/globalState.js\":\"414a9e8f80ea8610\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/aliasClaimRederiveProcessor.js\":\"cf3a538b330a8f40\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/ancestorBatch.js\":\"98a0f576ca65c32e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/blockTypeTypeifyProcessor.js\":\"461c7aa808e2771d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/clientSchema.js\":\"afcc2cb40914ae59\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/commitPipeline.js\":\"d735d2db338f8abc\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/devAssertions.js\":\"1e4eab148363d1a7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/firstSync.js\":\"96b1712780451606\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/freshInitialLoad.js\":\"11bcc3a808429530\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/graphBackfillClaim.js\":\"c0291f4d97f1b399\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/handleStore.js\":\"d79a33d9d9f6b74d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/idleMarkerJobs.js\":\"417078346815252d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/initialDownload.js\":\"f830ac960c856ab0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/initializeClientDatabase.js\":\"663511ef3bcc6bd4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/jsonCanonical.js\":\"14d698c654167909\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelInvalidation.js\":\"942a1629b3e3d12c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelProcessors.js\":\"e4748dcb00161f9e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelQueries.js\":\"df7b789fc674830a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/mergeTypeMembershipProcessor.js\":\"549dddfb4b36c465\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/normalizeReferencesProcessor.js\":\"74abea176c128a00\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/poolInstrumentation.js\":\"77a6ab0bdcbfc01a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/processorRunner.js\":\"ccbb743dbb4d6cae\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyCellBackfill.js\":\"0e12dc13184e5dfa\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyChildMint.js\":\"5f5ad1bf3edb9ddc\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyChildrenProcessor.js\":\"ad06ba9e7dd52080\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4646a175107a8d55\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyDefinitionSynthesis.js\":\"524078a2b730833c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyKeyScan.js\":\"0171ef16d0f7a769\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertySchemaResolution.js\":\"2aa6f87d609228b2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyValueEdits.js\":\"1a577b094556062a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/raiseProtocol.js\":\"00900858c977b5de\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/readBatch.js\":\"99170ca0a9a8a70b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/refProjection.js\":\"84fc0b124c108550\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/referenceTargetLookups.js\":\"d2cea71e76b3629f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/referenceTargetProcessor.js\":\"bed2eb64301336df\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/replayMerge.js\":\"11269819d95a30e7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/sqlBinds.js\":\"81d83248dccd1be4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b3bfd0821c5ed850\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/arrivalProcessors.js\":\"779011d4249079f4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/invalidate.js\":\"17030c8c96041712\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/materialize.js\":\"57c5e21db6de4c60\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/observer.js\":\"7148b853203b5045\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/reconcile.js\":\"875d7c688d167854\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/timingMetrics.js\":\"31857251c6c32531\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/treeQueries.js\":\"149906f275be78af\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/txEngine.js\":\"771b0691e5d713e7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/txSnapshots.js\":\"33095066ecdbc983\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/typedBlockQuery.js\":\"22030bfa18eb792b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/undoManager.js\":\"e62f9c989b476351\",\"/knowledge-medium/pr-preview/pr-1827/src/data/invalidation.js\":\"8341c0e12f1e679b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelDataExtension.js\":\"f4c8772d4e366784\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelPage.js\":\"564b3d492d785cc7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelValuePresetCores.js\":\"2f38dc0d0f6e9de3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbCorruptionSignal.js\":\"699193bcf1b0893f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbStorage.js\":\"249691407e4d2893\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbVfs.js\":\"8f8c4543f6ac0dca\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localSchema.js\":\"532fb2441af1dde7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/maintenance.js\":\"45e8e062607dd5d6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/mergeProperties.js\":\"bbd2224a565cb042\",\"/knowledge-medium/pr-preview/pr-1827/src/data/metricsConsoleHook.js\":\"6c746da60c2071fd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/migrationsPage.js\":\"f9934e1cf8634244\",\"/knowledge-medium/pr-preview/pr-1827/src/data/mutators.js\":\"109d34f25b4a6b24\",\"/knowledge-medium/pr-preview/pr-1827/src/data/orderKey.js\":\"06ef2f86d84af352\",\"/knowledge-medium/pr-preview/pr-1827/src/data/orderKeyPlacement.js\":\"13311497cedbb7a4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/outlineSurface.js\":\"9818d74f8f408329\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pendingEditorContent.js\":\"8c3a23b5d527a5da\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pendingUploadsSql.js\":\"045ab0db69e1e665\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pluginStateExtensions.js\":\"9d78fba334327cd3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/powerSyncLogger.js\":\"2514d7c995982a33\",\"/knowledge-medium/pr-preview/pr-1827/src/data/projectorRuntime.js\":\"eea17d961fc1ca97\",\"/knowledge-medium/pr-preview/pr-1827/src/data/properties.js\":\"5f8884cd8218df1b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertiesPage.js\":\"3eda58bd8c1e3743\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyChildren.js\":\"b91b98d05b121095\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionFanout.js\":\"2c6fd548b7450a5c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionMetadata.js\":\"cd5386495a94e6d2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionRegistry.js\":\"8f354b195a53d186\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDisplayMode.js\":\"5f4c8455b21ba465\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyRowCreation.js\":\"b81ed57021ab6f9e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertySchemaCreation.js\":\"956eaae669bb7ec8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertySeeds.js\":\"c8c8d41333745ee9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/recentsPage.js\":\"907e6b2db54a8be3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/referenceBlock.js\":\"3473e9d494f68711\",\"/knowledge-medium/pr-preview/pr-1827/src/data/rejectedUploads.js\":\"3b731f608d264097\",\"/knowledge-medium/pr-preview/pr-1827/src/data/releasePowerSyncConnection.js\":\"85f5f7bfdf5d6ec6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/repo.js\":\"27aa84017b397b97\",\"/knowledge-medium/pr-preview/pr-1827/src/data/repoProvider.js\":\"1d2bfd120db7ff01\",\"/knowledge-medium/pr-preview/pr-1827/src/data/rowProperty.js\":\"02bf86a497ff5b2b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/searchFilter.js\":\"86aea8a3d71a4a51\",\"/knowledge-medium/pr-preview/pr-1827/src/data/seedIdentityLedger.js\":\"1523e3f2cd3d7101\",\"/knowledge-medium/pr-preview/pr-1827/src/data/stateBlocks.js\":\"2773d111fd7172ba\",\"/knowledge-medium/pr-preview/pr-1827/src/data/structuralEditPolicy.js\":\"b90a57f52dd53bc7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/subtreeDelete.js\":\"76476f235cd80bc7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncStreamLock.js\":\"2fa0d4f8718b3875\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncedTableSqlRecognizer.js\":\"291a40506aa5153e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncedTableWriteGuard.js\":\"be1bab384f98cefd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/targets.js\":\"27962c8fdf66d8dd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeColors.js\":\"fa407e3583c96262\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeDefinitionMetadata.js\":\"f947b25d51b52bdf\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeDefinitionRegistry.js\":\"14b6a16ba2ac627f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeExtraction.js\":\"3bd68260cab62556\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeInitialValues.js\":\"85a06d9bbb3b958b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typePropertyGroups.js\":\"6bf1bcc7e5995ac1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeSeeds.js\":\"ad2e583be29b80ee\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeTagger.js\":\"ff8cef0b59d91c24\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typedRecords.js\":\"45218331578173a7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typesPage.js\":\"4f70c21bb028adb3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userPrefs.js\":\"1041530b795877f5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userSchemasService.js\":\"d65ea73ffa935e81\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userTypesService.js\":\"7fdc40da4315f115\",\"/knowledge-medium/pr-preview/pr-1827/src/data/valuePresetRegistry.js\":\"8f647cb3f99e0b66\",\"/knowledge-medium/pr-preview/pr-1827/src/data/visibleChildren.js\":\"d398ef78295b3c90\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceConversion.js\":\"faa7e94f99996871\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceFirstSync.js\":\"170505ef5b82ed64\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceIdNamespace.js\":\"8e931c0f90930d88\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceSchema.js\":\"66c6347b9a6d499c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaces.js\":\"39bcd9cdc15fc568\",\"/knowledge-medium/pr-preview/pr-1827/src/data/writeAheadLog.js\":\"667289627922b677\",\"/knowledge-medium/pr-preview/pr-1827/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/BlockPasteShellDecorator.js\":\"b7943b3e986e32b6\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/atTrigger.js\":\"816c28971f430fcc\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/autocomplete.js\":\"65d400a61f0c1914\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/codeMirrorExtensions.js\":\"a41e05454ff6b63b\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/contentFlush.js\":\"01481e6dba389941\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/defaultInteractions.js\":\"e009f5c903abf846\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/editSettleSignal.js\":\"e9c32f8e1558d904\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/insertImage.js\":\"7c9644f9f4afce36\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/referenceCompletionRange.js\":\"3b847d93bb9a27fe\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/referenceTargetTypes.js\":\"2a64644970a4d2c9\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/syntaxContext.js\":\"433f03c521c8494b\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/triggerMatch.js\":\"a89a40b237201c79\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/AppRuntimeProvider.js\":\"1fb1c3afdbffcbe8\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/BlockFocusShellDecorator.js\":\"45085f24d39e40a3\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/ExtensionRenderBoundary.js\":\"b4975f0c0ef3bd6c\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/PanelContentRecovery.js\":\"aa09919f629ce3e7\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/apiCatalog.js\":\"f9f8b5a3289a2378\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/approveExtensionHere.js\":\"47e8d85b4cc44f03\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/armedCutAppMount.js\":\"815ef909fde258b6\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/batchableKeyedStore.js\":\"8d5980cecc757e9b\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/blockInteraction.js\":\"19dfccc3e9040d55\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/blockSelectionAction.js\":\"cd0d35f66c232486\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/compileExtensionModule.js\":\"447be52e08360d9a\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/compiledModuleCache.js\":\"43afbd44e3b1a2fc\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/continuousGestures.js\":\"c34738f618aa7347\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/core.js\":\"9da77f888756eefc\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/defaultRenderers.js\":\"480d82c536ad8946\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/definitionFanoutAppMount.js\":\"3385c1ea30ab4644\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dialogAppMount.js\":\"f7c197dac4e8682f\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dynamicExtensionSeeds.js\":\"118923b2c997ef23\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dynamicExtensions.js\":\"3922bcb2a36a92a8\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/exampleExtensions.js\":\"48b5809b61c06294\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionApprovalStatus.js\":\"62353eef8019974e\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLoadErrorToast.js\":\"0d3b51d4ee90fec1\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLoadErrors.js\":\"366704de36af5ad0\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLookup.js\":\"cef0c1d61ab54e52\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionToggles.js\":\"feceb71859cc62e1\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionUtilitiesCss.js\":\"fe2e146f1631bda9\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/kernelPageDeletionGuard.js\":\"40110e48e9c96d56\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/liveRuntime.js\":\"57e316cd1ec62e62\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/openExtensionsSettings.js\":\"565fece48ac0dae2\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/overridesCache.js\":\"563ab15fa93964ac\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/pluginIds.js\":\"b79048b3277aef45\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/processorRejectionToast.js\":\"ea3e409c6f1f7f60\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/runtimeActions.js\":\"135e057c24ab15c8\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/runtimeContext.js\":\"9657f6d6f09cf02c\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/staticAppExtensions.js\":\"9df95e86975eb98c\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/staticDataExtensions.js\":\"b6cead44651c96e9\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/toastAppMount.js\":\"95bf3afd7655e2f1\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/useOverrides.js\":\"0780486bc4398f27\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/useShortcutSurfaceActivations.js\":\"393e6bb2ad119492\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/discoverToggleTree.js\":\"bc024ede3b4a4526\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/facet.js\":\"17d0eb77b8f1dd59\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/resolveAppRuntime.js\":\"97e95f07c66a5520\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/runtimeEvents.js\":\"866c383135766121\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/togglable.js\":\"6e401648c92f9e11\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/variantFacet.js\":\"a4594ae2795bca91\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/verbFacet.js\":\"ec2e3257a63227dc\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/block.js\":\"b0f177ec1920d506\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/focusedChild.js\":\"0764a5980a46589b\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/propertySchemas.js\":\"d8265a6487ca345d\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/typeRegistry.js\":\"316a2baa6004865d\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useAncestorCrumbs.js\":\"460ca23e284de232\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useAutocompleteListbox.js\":\"b014fbc1688d0eaa\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useDebouncedSearch.js\":\"4ce42597d7c16999\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useDebouncedValue.js\":\"5cebfe591c61c17d\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useIsFocalRender.js\":\"f391bd86e8f7da6d\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useIsReadOnly.js\":\"fdc6c320364d6fce\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useMaterializeBacklog.js\":\"68b7baebf5635248\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useMinuteClock.js\":\"b5e84f0c4284404c\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/usePanelLayoutProjection.js\":\"75f6ca3b22ba7015\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/usePendingInvitations.js\":\"05fb36085b5cc6dd\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useRendererRegistry.js\":\"de84069f99e99f85\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useRetainedFieldRows.js\":\"9ba9e6d1d1c1f356\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useWorkspaces.js\":\"f105b35177e2358e\",\"/knowledge-medium/pr-preview/pr-1827/src/lib/utils.js\":\"de4d6ca27b36e813\",\"/knowledge-medium/pr-preview/pr-1827/src/main.js\":\"303ba003d2588886\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/MarkdownImage.js\":\"1fdebd444b6c5ba8\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/blockSeparators.js\":\"70d99c8228321f22\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/context.js\":\"d2e8f3948f18b5d5\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/defaultMarkdownExtension.js\":\"ab369b1ee1b885da\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/extensions.js\":\"2ee7724c1324f4a1\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/renderMarkdownHtml.js\":\"714ba1bcb5c05991\",\"/knowledge-medium/pr-preview/pr-1827/src/minimal-editor.js\":\"73d67601bc2b368d\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/armedCut.js\":\"c95c15b4eeb57209\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/captureMediaVerb.js\":\"03afb3557283ba39\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/clipboard.js\":\"b888d51bd2838b90\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/decision.js\":\"1ee86207a80886ea\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/operations.js\":\"97d8911b9f724744\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/account-header/AccountHeaderItem.js\":\"8c42d628194c7770\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/account-header/index.js\":\"f81479375892877e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"27bef6680930797b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/askAgent.js\":\"a9f83b4ada01f463\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/askedStore.js\":\"75d7134b90b320e3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6625582853c89df4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/chipState.js\":\"7ef94b0cc9726c18\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0215fee36ab8e667\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/index.js\":\"897b298e307b52a5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5e86ca48481a9502\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/schema.js\":\"df896e22e198aeaf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b3b911b19ed78f3a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/BridgePairingDialog.js\":\"08e27787ce37a66e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/addMedia.js\":\"25fbd89b1c0344f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3bfa4e6844e78fb9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/block.js\":\"eff30c640f9c572b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/context.js\":\"afbf27d0d72555e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3f381d6c8596be35\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/index.js\":\"192fc3d27756efe9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/outline.js\":\"781ef701305f38e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/properties.js\":\"947cf6c6ebf0cfd4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/refs.js\":\"93257f0385fa179f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ceec0a6982527340\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/search.js\":\"a4abb0dd789caf5d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/shared.js\":\"2edd19d02f497cf0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"82c28787a4de88b2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/text.js\":\"6861d1d08c4b3c9c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentWrites.js\":\"8e697c5b854a6621\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/authoringCatalog.js\":\"86e5b0bd6112b274\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/blockRefTargets.js\":\"48df352eba8e0cc4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/bridge.js\":\"acdaa218185c9dca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/bridgeLoop.js\":\"a370b493fee6c08d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/changeHistory.js\":\"4c335e034492bba3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/commands.js\":\"e9365a00e2ebf321\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/commentsCommands.js\":\"efa689a2404e872b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/dataExtension.js\":\"62ad48c83b5a730f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/dataModelGuide.js\":\"0bc1ba8477bb8117\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/describeRuntime.js\":\"3dce469d006e3589\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/extensionLint.js\":\"9bd11c86e70be3b8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/grainAudit.js\":\"e00f1b0324898320\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/healthCommand.js\":\"0ad60612d2b0092b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/index.js\":\"43b00975bfc64959\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/presetIdentity.js\":\"943a8c98f4a0c486\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b37a19ff81b7609e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/readMedia.js\":\"65512fd6b376bd3c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/schema.js\":\"2d21a6e9db32a971\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/serialization.js\":\"3cdeec0a706123bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/targets.js\":\"dc6cf7550f824ca4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/tokens.js\":\"1dc4f0c6cc6aafc2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/watchEvents.js\":\"6b6619c2aa19d3fe\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/workspaceGuard.js\":\"92d67a52ebbc246c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/writeCommands.js\":\"93aafbed24a0451f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/AliasCollisionToast.js\":\"2305c2f9a6dd29bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/DuplicateNameBanner.js\":\"67f003a2c68b4b01\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/collisionMerge.js\":\"7337701b274c064b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/dataExtension.js\":\"c3764e35c0eb7676\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/index.js\":\"ae1c706ba313d0b8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/mergeCollisionAction.js\":\"8789e40053e12512\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/pageStyling.js\":\"a0f7e2f691c59d2b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/rejectionToast.js\":\"d0e735e32a9450ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/syncProcessor.js\":\"6c3e44f07b0b09e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/actions.js\":\"e0a8d9d510f5b823\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/addComment.js\":\"a363203d81cf6097\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/anchor.js\":\"cf149b467a405070\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/anchorState.js\":\"aa341ac3caf3b341\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/commentLinks.js\":\"f3ab1b898295eee9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/confirmThreadDeletion.js\":\"39ebde27fb176a4a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/container.js\":\"12d796afaf3a8579\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/dataExtension.js\":\"2435d74d653592af\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/deleteComment.js\":\"d4c4337c229d6fec\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/highlights.js\":\"5e6d847b974294f2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/index.js\":\"cb82935f7d4909a9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/linkedCommentsPill.js\":\"796f156cb5321bcb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/margin.js\":\"85a4333cc9d1cbe6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/marginSchema.js\":\"6ca0bdbd0761b7f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/newComment.js\":\"6a0c1f5f632f8cfb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/ownThreadPicker.js\":\"80dfa4df3fa995fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/placement.js\":\"901ff88f3ceddbee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/queries.js\":\"e504e07135a6a9d3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotePosition.js\":\"81c269318a367a77\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotedIn.js\":\"7d8a99c697b56292\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotedRange.js\":\"fd19aff4f0df558f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/rangeRefs.js\":\"62d6ed71d4c2d55b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readHighlights.js\":\"07a8d32b92e2f802\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readSelection.js\":\"95c03c425f53dd3e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readSelectionUi.js\":\"78b3869172b1ed64\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/reanchor.js\":\"a7c593a55b84f96c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/schema.js\":\"cd8a2fb1bc6299eb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/scope.js\":\"4f5da411f2c7a9c1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/scopeThreads.js\":\"6f7f3c0979d26cd3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/splitRetarget.js\":\"29b9428e1b97351a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/suggestionCard.js\":\"9b3c212d8e915778\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/suggestions.js\":\"5d32fd549b1c1695\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/summaries.js\":\"8ef2e165b3bb94ce\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/summaryBatch.js\":\"6140bc435b269af9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/surface.js\":\"ddfd8046596ce3d7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/threadNavigation.js\":\"978ea2ab79dea493\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/threads.js\":\"5565878a9e82089e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/ui.js\":\"8efb6e8773ce0900\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/uiStore.js\":\"df1b3cdbf8919771\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-intents/appIntents.js\":\"09312f1c80a48420\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-intents/index.js\":\"4646c5650a3a4d0a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-update-prompt/index.js\":\"671b70efefff2f21\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-update-prompt/status.js\":\"0bc627cfe3077989\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"68c6f67ec901f507\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaBlockRenderer.js\":\"5cfb8082999f6f45\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaDownLaneReplicator.js\":\"53da5288a8b2c9de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaUploadReconciler.js\":\"73443121d535e03a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetDownLane.js\":\"44ef8fa90d1cad43\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetResolver.js\":\"319eaad3788c698e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetUpload.js\":\"d22f8831628bc25d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/attachmentCleanerIO.js\":\"38075fc1a821c944\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/supabaseAuditIO.js\":\"20f1b45987649ab4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/blobStore.js\":\"ff288bc6df1c50e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/byteStore.js\":\"44b17c04f19a86fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/cleanerIO.js\":\"5385a9501472b1d1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/cleanupAttachments.js\":\"2e30c415a3e8779f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/dataExtension.js\":\"11dde11879543bff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/downLane.js\":\"771415f7e8da785f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/index.js\":\"f92c66d72f468e79\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/insertImageContribution.js\":\"b3e86966a2c16e8e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/laneArming.js\":\"76b5c0c244033cca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/laneLock.js\":\"4cf28eaba876f64c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaBlock.js\":\"2386ba30c11a8830\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaCapture.js\":\"e207f49f79762c8e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaViewers.js\":\"8f0447d2e97cd897\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaViewersFacet.js\":\"f6ed7f4d81b3912d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/pasteCapture.js\":\"2b3a9b38ff82003c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/resolver.js\":\"2a2a8730b7dde60d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/retryUploadsAction.js\":\"8982043cdbb72476\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/storagePaths.js\":\"c2b38d4da89e22e2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadDrain.js\":\"d707ecd8690b6bc4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadLaneStatus.js\":\"e0268df70b4f20b1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadReconcile.js\":\"e00149cec55fe2d2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadRecovery.js\":\"7601d21659a6d550\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadStore.js\":\"78849bc93c79c7fd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/useAssetObjectUrl.js\":\"52641fd9f3d513e4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"522a907da5f60ac1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c6a575cbd8992056\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/facet.js\":\"a9bec54b64e03315\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/index.js\":\"47a27f698d6746cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/prop.js\":\"c8ccaa92ac907d48\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BacklinkFilters.js\":\"8a2cb9cb1a82e52e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e069cd00351157b2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BlockEntry.js\":\"c7bd8eb72b482921\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/LinkedReferences.js\":\"3dfb1fece22a4ba8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"78941eaabab35c4f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/dailyNoteDefaults.js\":\"1744d4419654963a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/dataExtension.js\":\"f9795ef33a9a019a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/edgeExclusions.js\":\"18045bbd96c2c41b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/filterProperty.js\":\"490d0b63c70882aa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/index.js\":\"93535af89f14bd03\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"69ec4239b8db703a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/applies.js\":\"5a280ecb37c94f1f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/countQuery.js\":\"e62fed63815be255\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2be0c1efde21dfb2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/index.js\":\"375c03ba9bed818f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e41fb7331cf5002a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/presentationInvalidation.js\":\"a0e43dcca55d1aec\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/propertyEditorOverride.js\":\"a62858e967b0fee5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/propertyFilter.js\":\"b51293ab24e18776\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/query.js\":\"5d703cedab22be61\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/resolveFilter.js\":\"f5898cf3021c2947\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/sourceBatch.js\":\"ff047e8c15020b22\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/sources.js\":\"18d8f737185806a5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/useBacklinks.js\":\"a94e64e1d20d1277\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"95787705cfb22bad\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/BirthdayCelebration.js\":\"f80d2d444a731ba7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/BirthdayOverlay.js\":\"5d7e33b30a82a4b3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/gate.js\":\"e0489fa196ef02ee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/index.js\":\"3fec64ea095f3d27\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/wolfTheme.js\":\"8c91f70edbd60f5b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/BlockDragLayer.js\":\"aa59c69603411066\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/dragController.js\":\"350be93316c0e97e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/dropTarget.js\":\"2ed0139a6054e9c3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/index.js\":\"38679fce38b2277f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/projection.js\":\"03cbaf3e7877465b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-info/BlockMetaCard.js\":\"9c03d914c03d5d8f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-info/index.js\":\"ecf6532d252d0537\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/AddTagDialog.js\":\"435d065f7cfe5d2f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8a7e8b1790540674\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/TagNameIssueHint.js\":\"595424e796ee29b8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/addTagAction.js\":\"79ac35379b1235a4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/appendTag.js\":\"a02fd9f30cc0a52e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/config.js\":\"20df390587c9e967\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/dataExtension.js\":\"7389f1e96fe4e7b2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/index.js\":\"ff9a3f7e3d6ec5ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/propertyEditorOverride.js\":\"85626345f408b519\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/BreadcrumbList.js\":\"afbc1c0f7fcfce53\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"604a3dd91178f726\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3b1b6940df982538\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"952a553e8754f699\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"978226a922421c06\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/index.js\":\"4474d2c82daf6f91\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"64b948f2e6c7a607\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/CharacterCountItem.js\":\"d523d53d07d65b32\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/ProfilePropertyEditor.js\":\"12cc9c2b95daf4d4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/actions.js\":\"2a61c2f7bd7e3bd5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/blockType.js\":\"260f4d5586207479\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/charCount.js\":\"9e6b0705229499eb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/dataExtension.js\":\"02c543b25216a4a0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/index.js\":\"1d3af8e6f871b4f9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/profiles.js\":\"83b88edd8e8b3b8c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/properties.js\":\"ffa8ec1d133dda7f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/textCounts.js\":\"f54bdb26dadd34e4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/colemak-keybindings/index.js\":\"49920055391724e4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/CommandPalette.js\":\"a7b5d0a0bdd146cd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/HeaderItem.js\":\"dbfbbf4d9557ad2a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/context.js\":\"1d014fc78f8b225b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/index.js\":\"ec385440f7812186\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/selection.js\":\"a04eefb1f5ce6976\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/toggleStore.js\":\"a8384e91875ca832\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/useCommandPaletteActions.js\":\"ce40d104ec060eff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/ContributorBadges.js\":\"914756a4b6f67acd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/author.js\":\"fabfa3cd68b853ae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/codeMirrorExtensions.js\":\"a3fb5f93d3c23217\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/dataExtension.js\":\"539b87d16d33a2b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/index.js\":\"e484854543ba022d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/mentionAutocomplete.js\":\"a19e1a9346591d46\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/processor.js\":\"c5df4591e3de40b7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/profiles.js\":\"e4ad39d75ee2e109\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/queries.js\":\"2d9321ec38aefdb9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/schema.js\":\"f66c6a115f6f2031\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"93763b5bfa15dc0c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/followOrigin.js\":\"27ae6d190112446a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/index.js\":\"59ff1381895cbde8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"626b2b1a4aa622af\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d9c9854aa09f01e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/CalendarGrid.js\":\"2c9f72b54030dfda\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DailyNotePicker.js\":\"388cdd63696218b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"cdb9d8374deffcae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateNavDecorator.js\":\"ddd774dc2cb50263\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateScrubOverlay.js\":\"f7ba3c56b60170a0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/HeaderItem.js\":\"7716196df697d89f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/ReschedulePicker.js\":\"53093a7f9f253937\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/SpreadDatesDialog.js\":\"311a20c1f54e269c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/actions.js\":\"120940a7b291ea3b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/blockDateAdapter.js\":\"57a5ba185ed25371\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/calendar.js\":\"78ef2f924223c16a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dailyNotes.js\":\"e230afdeaeb5dd24\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dataExtension.js\":\"5af3bb19596bf72e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubActions.js\":\"79c4f821ce448772\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubGesture.js\":\"b28ec85232de3043\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0ed7a0f5c8089337\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1e8a2686cd1a9f78\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/deletionGuard.js\":\"e294c073904b1467\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dueQuery.js\":\"1b7443da18da1b96\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/index.js\":\"1bbf650c2e35a760\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/landing.js\":\"471667912252ed2d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/localSchema.js\":\"a19c4170a65ae2b5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/referenceDateAdapter.js\":\"531954fc9036aa2b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/rescheduleAction.js\":\"8a618a4becfe4cec\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/schema.js\":\"476a66648b4ff513\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/spreadBlockDates.js\":\"a7d30b45b42d5f40\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/spreadDatesAction.js\":\"bc65906a4aae3041\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/today.js\":\"60e3e4912155b0a6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b533357b8978e7ab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1737e803cd0100c0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/audit.js\":\"187036f607becef6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/auditAction.js\":\"49f04b265003f69b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/auditRanges.js\":\"203f7f189671ae26\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/diagnosticsSource.js\":\"f935107139342654\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/divergenceScan.js\":\"98814cdbe03868bc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/index.js\":\"6817cd2ae07073ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6f5ae89660e8f655\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/referencesMirror.js\":\"70fd737f9876ce1f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/rowJson.js\":\"5f0e3ea87715cd72\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/schedule.js\":\"447afcddc91c9228\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/store.js\":\"0ff8c68589deda26\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/action.js\":\"71bd1355f970356b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/index.js\":\"a72f310fa87fa427\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/plugin.js\":\"e5d07844af626692\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d2aa09c51ac69c8a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/actions.js\":\"de644bac323747a4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/changeMarker.js\":\"2c227c02a616f17b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/diagnostics.js\":\"1a28e634db19b7f4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/fileSystemAccess.js\":\"325bc8cc6bb5cbf8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/filenames.js\":\"e5f3f056136d051a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/index.js\":\"0f0a73f8b61a39c4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/mirror.js\":\"03457cbc0e12c5c9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/runLock.js\":\"f1aed8eafb61eb3f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/runtimeHealth.js\":\"54830a0e651b9dee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/schedule.js\":\"ecf6384c5e54569f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/store.js\":\"230c0d30ebd71665\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/default-themes/index.js\":\"5d09d09c336e9e2d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/default-themes/themes.js\":\"493fb8a4f5a35bee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/diagnostics/facet.js\":\"4d6d9a7aa75a5134\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/diagnostics/useDiagnostics.js\":\"66f7d82419df0325\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/dismissals.js\":\"69709e9f79e9c997\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/index.js\":\"45f87430a9756611\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/status.js\":\"d7ffb115bcc419dd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/store.js\":\"ee6978c5d1d6cae4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6bd4520e9595100b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3c6fa2b8e7e8599c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/actions.js\":\"0a7ab907c249a52e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/config.js\":\"37be8297545c5625\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/dataExtension.js\":\"a99e53b9313b4f13\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/effect.js\":\"af10c5579ffd9be6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/index.js\":\"e7067965ded49247\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3a3a458fffa52c86\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/useToggleTree.js\":\"0650072ced3e22bf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/ExtractTypeDialog.js\":\"2a4e38f9e118b0b1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"674bb15e5867e492\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/PropertyShapePicker.js\":\"5e54a03004ef435e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/action.js\":\"804cdd35b8c40035\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/index.js\":\"f51e788f135c6122\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/FindReplaceDialog.js\":\"8f70be2bab7bbe46\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/HeaderItem.js\":\"98a231afab2146a7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/dataExtension.js\":\"69597179d48ad83b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/index.js\":\"09459c1da265f874\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/search.js\":\"ee212acda1bb1cd5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/toggleStore.js\":\"cf4c2f8c8de14a20\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/LocationPropertyEditor.js\":\"ae496777ffb3076c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/MapView.js\":\"0cc72733b2620c5c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/blockTypes.js\":\"8220166118a6cd18\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/codeMirrorExtensions.js\":\"48d009f1d1441475\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/createOrFindPlace.js\":\"f5682cd7c7863e76\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/currentLocation.js\":\"dd732ad2c8ca4b0f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/dataExtension.js\":\"51a5492105255045\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/geoContentDecorator.js\":\"a99f0b794fe0a9c6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/googlePlacesClient.js\":\"2705fc945806c19a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/index.js\":\"0178d30b4b72605d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/locationsPage.js\":\"71e8d13ecc6f203c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/mapViewport.js\":\"4a94035a5e1fe63e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/pickCurrentLocation.js\":\"e54fe826d3c34a29\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/placeAutocomplete.js\":\"8d96a18a0bb52ac6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/placeNameCollision.js\":\"b018599355090acc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/properties.js\":\"68e138c7ad7731e0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/propertyEditorOverrides.js\":\"91766cec094767fc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/query.js\":\"d67acace69d71ec4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/usePlaceSearch.js\":\"ed8bd7f38b092f18\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"43cf5d28a079e093\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"87b5ad1fb01ffb09\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a02e348aa61eeef1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/config.js\":\"c0eef4a35812b73d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/dataExtension.js\":\"3a4159856e6d5dd8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/facet.js\":\"ae615a06094c8178\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/grouping.js\":\"1d2fe1bea8b97f35\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/index.js\":\"bf68cf10203e4fb7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a2ba7f939ec846bc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/query.js\":\"de3cd263a430e6a3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/resolveConfig.js\":\"4d9c4401e72a8c4d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2d252334caa659ac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"fec8798627bbbea2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/HtmlDocumentContent.js\":\"09d5082ae60773fd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/HtmlFrame.js\":\"519b289a5e50889a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/actions.js\":\"2586ef97ca210137\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/blockType.js\":\"9e9b16864cc60a17\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/confirmRunScripts.js\":\"9022bf73c2e88aef\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/dataExtension.js\":\"e8e5a81deb15495b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameAnnotations.js\":\"4ff23a8c9b0c009c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameDocument.js\":\"4bfe4d515f117e26\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameTheme.js\":\"4de99c8dc0580084\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/index.js\":\"fd29cd7fe968e957\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/scriptConsent.js\":\"751a6006519e531f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/sourceMap.js\":\"aa27ec66a66c0dc8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/useDocumentScripts.js\":\"7ab10aa846126aab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/index.js\":\"23b9d1adb37ea6d5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/record.js\":\"ff13e6081625d2c0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/recordStore.js\":\"2ae495a3a4af2e34\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/responsiveness.js\":\"a3abd221ad78b4a9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/schedule.js\":\"3adfa8a142a68c8b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/sessionContext.js\":\"d2725a99ceddd859\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5d32ba22dbf0701b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8d6409014b5a652e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/actions.js\":\"c8e46d7cc0ef3bd4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/config.js\":\"cfd27be153b3315f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/dataExtension.js\":\"f701ffe8cba56629\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/effect.js\":\"fbb9e7f258a9a92b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/index.js\":\"2b70c5cb8d108a36\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/keyCapture.js\":\"5c2aa555875a60f3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/overrideStore.js\":\"805e65ca0c4bc844\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"61796bfed06a6489\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/HeaderItem.js\":\"a7297a2d70d85330\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/LeftSidebar.js\":\"73057a682c6c79cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/actions.js\":\"3e9166e298bfa174\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/facet.js\":\"7f4224ac2153eb76\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/index.js\":\"b9e7a262ee6576c3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/shortcuts.js\":\"1889bf9ba97e39dc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/toggleStore.js\":\"ef89c98ae74c67e3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/MergePicker.js\":\"2fa6a0cbed45caf4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/index.js\":\"81ca004a08f3fb7e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/mergeAction.js\":\"fabad1f4855d15ed\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/strategy.js\":\"ab264794c362a439\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/Button.js\":\"fb3cec75f68be5f6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a1eaf8abe078b4fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/defaultItems.js\":\"847790046a8b0fd7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/facet.js\":\"4b2f0c59f4035210\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/index.js\":\"cc8d7b239c4c9376\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"30d77eafc74dc78b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/actions.js\":\"402bf9a307298e3c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ddacc57e6ce57620\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1c8cab9eb06ba669\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/index.js\":\"97e7ad730c753cea\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5b4cf0204b7d796b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f0959b77a141a639\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/contextMenuItem.js\":\"5e31745da7053e59\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/index.js\":\"8e31f6e440a9f02d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/moveAction.js\":\"177faff06171012b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/moveBlocks.js\":\"c192e961600fd444\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/selectionAfterMove.js\":\"bb4e21cb308a3129\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/TutorialBanner.js\":\"7390dc90eb7314d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/action.js\":\"3bd84302976bd91a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/bannerDismissal.js\":\"b8be77d482d77adc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/documents/cheatSheet.js\":\"d1a61681904110fc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/index.js\":\"db1b1188ba590a0f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/keys.js\":\"6dcdf3c4f3bfe846\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/landing.js\":\"3d6ee9db352124cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/outline.js\":\"b566fa6d737fbc49\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/seed.js\":\"64a9a83a0f1b76ce\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/PerfTrendDialog.js\":\"10796d569932f612\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/analyze.js\":\"31d1c86091a860bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/diagnosticsSource.js\":\"63f3d4532fae874c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/index.js\":\"bf29ec81335f5a84\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/load.js\":\"33e6740cdf3e0160\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/monitorRun.js\":\"aeccd32df488e75a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/schedule.js\":\"97f9d609b6aa178a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/series.js\":\"8463018e96649eed\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/store.js\":\"3c9ff4508b15e91f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/trendAction.js\":\"3e5ff438741049f8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/verdict.js\":\"e46ee83080514c6b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/clickToEditAction.js\":\"70e08295180db381\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/index.js\":\"d0ab4808ae7f3892\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/interactions.js\":\"6f7c8e4861c1d81b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9955fd99486bec19\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/MigrationGate.js\":\"c3b792358f800fd4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/MigrationGateDialog.js\":\"6b5ab213e3922060\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/action.js\":\"de1b6d9c0cbf480f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/index.js\":\"3294d5cdf01cf8e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/localRunMessage.js\":\"4c9facad70d62546\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/plugin.js\":\"4c656b33aa14c6fd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/progressReport.js\":\"b76a0fbd2cf072f3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/sweepProgress.js\":\"c8ded0db5b79ae05\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/FieldRowRenderer.js\":\"8488cd6a7a79f057\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/ValueRowRenderer.js\":\"1fd22e3bcd152327\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/actions.js\":\"35fc7b8dd9cc89ae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/autocomplete.js\":\"11a6fa5de3b1a9e9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/fieldRow.js\":\"9ad02438abd42818\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/index.js\":\"c6198975e1f15b8c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/referenceWarning.js\":\"257478db4d2c645a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/valueAutocomplete.js\":\"bd8cc95d4886f4bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/valueSchema.js\":\"15392a896f32bf97\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/HeaderItem.js\":\"c4324258d5a6e388\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/QuickFind.js\":\"467b4b4101fce90c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/index.js\":\"4f2658043899be16\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/recents.js\":\"2796b78f03164d4f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/resultItems.js\":\"03f9f689627cdd42\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/selection.js\":\"71107fcf55d582ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/toggleStore.js\":\"9517d33f2abcbe4c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/HeaderItem.js\":\"9927fc27618995b5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/RecentsPageBlockRenderer.js\":\"12a2802bc24347d7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/grouping.js\":\"ec5d4d93bab1f6b2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/index.js\":\"f582a6bfee41d1a9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/target.js\":\"8886c1c312d0d07f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/codeMirrorExtensions.js\":\"fd31980ab52f6496\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/contentPrefill.js\":\"1900992a4d32ab8d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/dataExtension.js\":\"fb38cfff9e2a2416\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/index.js\":\"76c1891010912109\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"45d3c7da5cf0baed\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/invalidation.js\":\"3bcf8452628cadb6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/localSchema.js\":\"55f10a142fa39983\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/blockrefs/index.js\":\"a1b8ab9f0aa79e06\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2079a1758d030139\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/index.js\":\"371b73eedd37f0aa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/referenceNode.js\":\"d184e910f599e7db\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/remark-reference-occurrences.js\":\"9a03d56f9e0572de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d5bffe44cc01d52e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/index.js\":\"4a6d0847d03fa6f0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"31c45332a80570b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"538fb15fe99c0f15\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/mergeRetargetProcessor.js\":\"bd9557e9f139f6b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/parseFence.js\":\"950874c7a2d95e39\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referenceParser.js\":\"e5687540caf3cde3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referenceProjection.js\":\"571b96440536813c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referencesProcessor.js\":\"ff8ba9c4f97eb93d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/renameProcessor.js\":\"3ff7a0c4ff346f6f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/spanReplacement.js\":\"28057c932be12d7e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/htmlToOutline.js\":\"bb29a2119ab49d81\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/index.js\":\"210707719654f5b6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/normalizeClipboardDom.js\":\"05d41e01ab90c084\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/pasteDecision.js\":\"dc1847f1749ec878\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/action.js\":\"a53a9c8fa3de17b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/blockIds.js\":\"dd764829612a41f2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/content.js\":\"46f70bd0b5213bd7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/effect.js\":\"ca2d1a647a818e15\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/ids.js\":\"d4cda656b0c4f824\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/import.js\":\"1685dffed4aea534\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/index.js\":\"7ce57798ce352796\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/plan.js\":\"5a081578c6835434\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/plugin.js\":\"bf7d5bed71188806\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/promotion.js\":\"de9564a904835f5d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/properties.js\":\"dd80cabbdccaef59\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/references.js\":\"5dff64005dbf3fb5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/report.js\":\"2abdead850207904\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/roamMemo.js\":\"5519438634477ff9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/runtime.js\":\"80b0b032767834c3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/schemaReconciliation.js\":\"e6af10e0df038424\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/srsMarkers.js\":\"408ae7cd35bd786a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/todo.js\":\"4c029c573776e83b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/typeCandidates.js\":\"79949ee6c8a98edd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/types.js\":\"de6c3f887584c302\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/search-health/index.js\":\"7a392ef90cbb5148\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/search-health/store.js\":\"bed2ec79bc9a405a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/HeaderItem.js\":\"dc385df088dfbe27\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"1c8b6ab9f5e41860\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/index.js\":\"f881f4e382bf499e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/model.js\":\"2017a83b78a3529f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/toggleStore.js\":\"7b6f0ea57524e653\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/useKeyInspector.js\":\"ab792000f5d82c32\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a36982db05cbcda9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/ShellDecorator.js\":\"aa70487730112dae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/actions.js\":\"20fc03fa19f22430\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/exclusionsFacet.js\":\"162f4db86883eb66\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/index.js\":\"d80e39cf8aa07597\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/shell.js\":\"7c5bd0e377b2e457\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/surface.js\":\"3d85f9f78b20f4af\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/walker.js\":\"b2e8167b88dcfd46\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/RescheduleToast.js\":\"cd9f19045c9b2ac5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/dataExtension.js\":\"c2b2c63b7ee174cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/index.js\":\"e61727e3c3cfd214\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/indicator.js\":\"a3369967a0a2ba17\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/moveSrsState.js\":\"65d87e0895120c4e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"64a6f126610faf88\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/scheduler.js\":\"ae6e297979f489d5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/schema.js\":\"8f4bde6740cbf915\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9d9060eee3ecefa0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/srsClipboard.js\":\"bdb9e12548ba9aff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"36bb73230fab4fd1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c7cbb946e39f32d4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/DeckPicker.js\":\"c99cedb363b042c4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewControls.js\":\"6ca8afbe84fc951f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewDeckRenderer.js\":\"82e6df74e53f93c3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewSession.js\":\"458feb7e5baae758\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/actions.js\":\"01cf6525465c1a9e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/archive.js\":\"f6f2ecdd6a56b5f4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/dataExtension.js\":\"39a18e0145c366e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/deck.js\":\"b994abadc45a7269\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/dueQuery.js\":\"1eacf994a202f794\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/gradeDecision.js\":\"ab5eea273ea8bfa2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/index.js\":\"44dfbaf86e313951\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/keyHints.js\":\"b2e6d5e66ba4d553\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/reviewCardLayout.js\":\"620e5f811c43f6e3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/reviewProgress.js\":\"58e9ce3b902e760c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/schema.js\":\"39d834d560728140\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/useDueCards.js\":\"b90230721ea98bcf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/startup-metrics/index.js\":\"b61af43307714474\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/startup-metrics/record.js\":\"09ae709c681025c4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/index.js\":\"916c171da8501e21\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/persistenceStatus.js\":\"19a67ab3b6c736af\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/requestAction.js\":\"cae42afc8bb6046b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/TypeChipsDecorator.js\":\"124849fcadf506e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/codeMirrorExtensions.js\":\"6bc1171f81734997\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/index.js\":\"4aa839c2c97827ef\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/typeAutocomplete.js\":\"7b67d74df42ff39f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"43344a6b83b5396c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/actions.js\":\"1917d96270e2d035\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/anchor.js\":\"c5f73f39f2f88774\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/events.js\":\"8c8169376474cf58\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/gestureActions.js\":\"4a2d337e501d06e0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/index.js\":\"9627c8a90c83e332\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b095c7ead7295ed8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/collect.js\":\"c4b96b9842366093\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/index.js\":\"9e2e7620564e1026\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/record.js\":\"3490e8c2a27eb7a1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/RejectionDialog.js\":\"b9699c1101ef137b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/SystemStatusHeaderItem.js\":\"bb136f4b250415e4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/index.js\":\"5088b40fbe6f7ade\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/model.js\":\"a490d729723dd277\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/queueCounts.js\":\"24897b8c82671daf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/rejectedHelpers.js\":\"35b1d50e0908a46c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/rematerializeAction.js\":\"d1192680a8db4c80\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/useHysteresis.js\":\"47ab664cec728396\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/TableLayout.js\":\"f68aa44540b86177\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/actions.js\":\"748630ca1d1dcb67\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/cellEdits.js\":\"ab6a4bda2d7b6340\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/controller.js\":\"7aac5b3679fce1a8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/convert.js\":\"6c088a5a7304347a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/dataExtension.js\":\"963343fc0ae53d5f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/index.js\":\"dd759def8e7bfc45\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/keys.js\":\"b4de4f45d75ee6f0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/model.js\":\"c5fb08463816ac2a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/registry.js\":\"90492af136e85f87\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/schema.js\":\"378cc033f60e24b4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/effect.js\":\"7d03e20f34e79c46\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/index.js\":\"9b33ccf3ba05244f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/theme.js\":\"7b98ffbecb5790c0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/actions.js\":\"0ef14503e6154da4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/dataExtension.js\":\"49ac1346688d93ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/index.js\":\"93142d393740886a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/schema.js\":\"aebf38aa63ff1eba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/TouchSelectionLayer.js\":\"007c5aa1b724b062\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/actions.js\":\"ecbe37cb0b51ad59\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/defaultItems.js\":\"25f1a5e1e7947c72\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/facet.js\":\"6139bf2ea37b7925\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/holdRecognizer.js\":\"b870178f6aa1c46d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/index.js\":\"10f2d1be790c03a7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/UpdateIndicator.js\":\"42fc76b32ed3e414\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/index.js\":\"93f7242023973f03\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/loadTimes.js\":\"ce4f94b2011b6adc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoNotesRenderer.js\":\"f342ba30c141fbff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoPlayerRenderer.js\":\"17b67ca4dd51568e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoTimeStamp.js\":\"0dd6b7044bc79755\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/actions.js\":\"34a217dbe010aa3c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/index.js\":\"73258116ea81d580\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/markdown.js\":\"a861330a90912aa7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/notes.js\":\"3e4c3463509646db\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/registry.js\":\"3c80c0f25b9f5b03\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/remark-timestamps.js\":\"306ab6b99769926d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/view.js\":\"409f69bd52727a05\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/LinkHints.js\":\"cf6404afdd725648\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/index.js\":\"7df44352a91c1372\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/model.js\":\"3cdb199ae2385d14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/settings.js\":\"04fbd1ede5c7d4a3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/actions.js\":\"26efa2bb999709d1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/index.js\":\"3906ee15e7d61f13\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/interactions.js\":\"5b1eeca15e61343b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/workspace-header/index.js\":\"6cb7ee7111947c57\",\"/knowledge-medium/pr-preview/pr-1827/src/registerServiceWorker.js\":\"7a821e041cdae134\",\"/knowledge-medium/pr-preview/pr-1827/src/requestPersistentStorage.js\":\"b86c026a0333a3c4\",\"/knowledge-medium/pr-preview/pr-1827/src/services/authRequestDeadline.js\":\"192cc3f86530fe72\",\"/knowledge-medium/pr-preview/pr-1827/src/services/authStorage.js\":\"e67be3596734c4f3\",\"/knowledge-medium/pr-preview/pr-1827/src/services/powersync.js\":\"00587b14cf5fd85b\",\"/knowledge-medium/pr-preview/pr-1827/src/services/supabase.js\":\"6501cbdf3b42b097\",\"/knowledge-medium/pr-preview/pr-1827/src/services/uploadErrorClassifier.js\":\"c320b0194e593efa\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/ActiveContexts.js\":\"e336bc68c976f4b0\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/HotkeyReconciler.js\":\"1b0f12030dfdedab\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/WipeLocalDataDialog.js\":\"a240ee7e8e48278d\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/actionDispatch.js\":\"129fc1a1f04cdd5b\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/actionRefItems.js\":\"fa9f2dc053e6da12\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/applyKeybindingOverrides.js\":\"d0e53b23b1331486\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/blockActions.js\":\"8771e7646c6a9531\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/canonicalizeChord.js\":\"7152dc6b1f8182c4\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/defaultContexts.js\":\"f556990fd3299dbf\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/defaultShortcuts.js\":\"96cdc8ca6ecdb5a9\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/effectiveActions.js\":\"89f38e6965b1b509\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/gestureAction.js\":\"caf091297f2e0f37\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/gestureBinding.js\":\"698a4fb8d8b17ca2\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/holdRegistry.js\":\"6b4dce8108426100\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/keybindingConflicts.js\":\"5d8bf173ead4eab0\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/keybindingOverrides.js\":\"a23bddb7a7982c28\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/pointerAction.js\":\"0431af7fd2c7df37\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/resolve.js\":\"1d87ba45f3efcf60\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/runAction.js\":\"0cddb2632dd50106\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/sequenceMatcher.js\":\"63e3c68fa0896666\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/types.js\":\"49273f56d300f000\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/useActionContext.js\":\"ce99976f7e799afd\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/useActionDiscovery.js\":\"b9a0adbc906b1bde\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/utils.js\":\"9c8164db9dd8c525\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/bootStore.js\":\"8cb64a352a50e2d2\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/previewDatabases.js\":\"8067fa80d315c313\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/byteTransform.js\":\"980160f94708fb7d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/attachmentCleaner.js\":\"fb96e40b78a7dbea\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/attachmentParts.js\":\"f91c2a9d3a3fa43e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/bundleParts.js\":\"c1037d67b340d5c5\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/bundleRecord.js\":\"2e6f6f3edb78a23c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/manifest.js\":\"10eeb4649264fe6d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/takeBundle.js\":\"e305578496391cc3\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/verifyBundle.js\":\"f60bbedc9cb3c77d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/cleaningStage.js\":\"c76bb65cb788f51c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionKey.js\":\"7ebf1ffff912ec3d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionServer.js\":\"3da2eef6104a079a\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/flip.js\":\"25c988426331d218\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/flipAttempts.js\":\"c5a42a5312f6858c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/pages.js\":\"55f23654dac4db01\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/preflight.js\":\"69926847b6dde90a\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/reseal.js\":\"16229897030ef2b3\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/runConversion.js\":\"7151b4bf15adf2f0\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/runLock.js\":\"0350a09f8e910b6b\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/sealing.js\":\"a8955be47b5531c0\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/sealingStage.js\":\"e0cff1e44ec96d70\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/stage.js\":\"c7d0a453e762040d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/verifyReseal.js\":\"2b621912ddf46d87\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/aad.js\":\"9872826e00a7c2c5\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/aead.js\":\"703e52d2116c5f73\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/base32.js\":\"6fb626bc5f0bd886\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/base64url.js\":\"ef1c5d1827ed1fc5\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/binaryEnvelope.js\":\"5d234dc90b1254a1\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/byteAead.js\":\"21911ad4c0b0bf36\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/canary.js\":\"33ee7e14190a0b8a\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/contentHash.js\":\"0e61044436e008df\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/contentKey.js\":\"4e33d401bb238255\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/derivedIdNamespace.js\":\"6648ff5d0f32cb9e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/envelope.js\":\"57c43cd09ee8ee47\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/hex.js\":\"818977708bfeca9a\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/sha256Hex.js\":\"625270ca38e6455f\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/workspaceKey.js\":\"b32913eeec72d5d8\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/conversionState.js\":\"034c774340976bbb\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9fb167fb5ca0e786\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/pastedKey.js\":\"3579f6283ccbf3f7\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c5d7eb036e55f68c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8c2f2f0f899d5195\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/keyStore.js\":\"6e7724b0d7de27f5\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/mintWorkspaceKey.js\":\"9e9ed74d8bdff7db\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/modePin.js\":\"7ebd4c32591f63eb\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/openWorkspaceKeys.js\":\"dad16c69a7079231\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/resolveWorkspaceEntry.js\":\"bbb4d60b5a526dc2\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/resolver.js\":\"49d8100a18c1a329\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/workspaceAccess.js\":\"9a41fa615fe65a85\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/transform.js\":\"ae3a395517f31d80\",\"/knowledge-medium/pr-preview/pr-1827/src/themeBootDefaults.js\":\"9ae6b117464f0e0e\",\"/knowledge-medium/pr-preview/pr-1827/src/types.js\":\"a05eb68e42e14210\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/ClientLocalSettings.js\":\"790756a91106a84b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/abortableSleep.js\":\"e3becbd561d8fcdb\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/array.js\":\"38896b7cb235ea4d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/backlinkAutocomplete.js\":\"bdd4853fcec35b2b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/blockCrumbs.js\":\"27dd9d1996dba7df\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/blockrefAutocomplete.js\":\"702b0f7ddb1fb4b7\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/cadencedIdleJob.js\":\"d4e8435f99470382\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/callbackSet.js\":\"cf11c614ccb1f6fb\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/clientId.js\":\"5078d76d110e693d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/codemirror.js\":\"a2a0caf228cb228d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/codemirrorCompletion.js\":\"e558ae84c7f69b71\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/copy.js\":\"31e9b4a3773b4ce9\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dailyPage.js\":\"38b60bfa63d1f975\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dbForensics.js\":\"708842925c5a69e5\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dbForensicsHooks.js\":\"471ba499c0026c03\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/deleteBlockThroughUi.js\":\"8895a924c9d3b96d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dialogs.js\":\"51f51f26662637f2\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dom.js\":\"ee83b8cf23b017d8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/downloadBlob.js\":\"c94fd9c90671606d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/exportSqliteDb.js\":\"92cfa3bf19342e5e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fileSystemAccess.js\":\"856cc2ee117c8860\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/flipSlide.js\":\"cdfb0e807ac38f54\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fnv1a.js\":\"dd9e7e6bef6897fb\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/formatBytes.js\":\"f7269c5b225c0b51\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fuzzyRank.js\":\"a6ef1c6551bf0e85\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/idbKeyedStore.js\":\"d2d2e2a1edfbf469\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/idleCallbackPolyfill.js\":\"fc351d7c42cfd59f\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/keyboardAwareScroll.js\":\"26ae69c295ced2a8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/keyboardViewport.js\":\"236dcb5191cace70\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/lastWorkspace.js\":\"030f423a81547acd\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutColumns.js\":\"e6c26ad036cbfb4d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutSessionDom.js\":\"230f835d612be7a6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutSessionId.js\":\"f2f79e9cbd661a95\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/linkClickGestures.js\":\"dc150b4e8b98d622\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/linkTargetAutocomplete.js\":\"63fa5a35da5a8d07\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/localDbCorruption.js\":\"fa1e96423f912962\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/localDbRecovery.js\":\"74b3a675a600e4d9\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/markdownParser.js\":\"cbc441914b970aa0\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/memoize.js\":\"d0f3cec58c068747\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/nameFieldCommit.js\":\"97a245a0d87c1b31\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/nameList.js\":\"206a1f344c404e6b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/navigation.js\":\"0a23633887bd0766\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/omnilinerNamespace.js\":\"9c63c73215f8fd1a\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/opfsPageScan.js\":\"1caf0dd8bda3c674\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelClearance.js\":\"2c9dbe9ed2495358\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelHistory.js\":\"cba0624375719387\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelLanes.js\":\"811e1b18e8a0255b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelLayoutProjection.js\":\"c0afe1ea6b7f337e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelScrollAnchor.js\":\"9167f2cb8395b440\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelUrlFlags.js\":\"921fbf2d9d233207\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/platform.js\":\"fec0f2373d09920d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/pluralize.js\":\"0e77980162f1395b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyCreation.js\":\"87e9816dff7e9e40\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyNavigation.js\":\"73cfe904cd4a670e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyValueContext.js\":\"f5a8d600b4b84dcf\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/react.js\":\"b9fb30db9ac57d1e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/relativeDate.js\":\"e9323c9343242a37\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/relativeTime.js\":\"29619a4908934017\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/renderScope.js\":\"a6ce81b5ef74ebd2\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/resolvedThenable.js\":\"1c17a82983451dba\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/routing.js\":\"ddf8478feb179795\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/safeMode.js\":\"ed2b4ecce6ad0a6e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/scheduleIdle.js\":\"462d5099801fe39a\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/screenWakeLock.js\":\"d30961867d9c3e39\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/selection.js\":\"c1da48a03e54c8e6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/softKeyboardGrab.js\":\"d9221cca27d356cb\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/startupTimeline.js\":\"6fb9ced592f4d85f\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/state.js\":\"002f03e014703612\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/string.js\":\"b3eeca2bbfd40745\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/surfaceZoom.js\":\"84088d89b6157ef2\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/time.js\":\"194cd6bc501558bc\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/toast.js\":\"f06c354d20cef974\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/toggleStore.js\":\"a0cbd1a72f2601af\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/untilStopped.js\":\"d471c9b51d45a147\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/userActivity.js\":\"fb447c7482bf2a6d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/viewTransition.js\":\"483b5e19aa499ca7\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/viewport.js\":\"42da2f6194444a69\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/webLock.js\":\"b30cdb741c8809ae\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/workspaceRecovery.js\":\"6fede25942917c36\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/workspaceSnapshotStore.js\":\"ce6630549fd36e8a\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-compiler-runtime.js\":\"5ba59af1ec2b6b6c\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-client.js\":\"134bc20cd8347eec\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-server-edge.js\":\"818a3584cf213a15\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-server.js\":\"faafc0d8f23539da\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-static-edge.js\":\"0be097ef764869f7\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-static.js\":\"188454788050d2a9\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-test-utils.js\":\"c338984804accb33\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom.js\":\"9d496469f5ddb545\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-jsx-runtime.js\":\"3f7f69ff9859520c\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react.js\":\"1e7869ae02f9dc08\",\"/knowledge-medium/pr-preview/pr-1827/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1827/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1827/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
