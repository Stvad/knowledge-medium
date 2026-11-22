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
		buildId: "9bc05990f30b-870872c6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/\":\"787b1a6416b64f00\",\"/knowledge-medium/pr-preview/pr-1827/index.html\":\"787b1a6416b64f00\",\"/knowledge-medium/pr-preview/pr-1827/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1827/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1827/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1827/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1827/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1827/assets/FacadeVFS-BJx3qSue.js\":\"e4faefc34ad4450a\",\"/knowledge-medium/pr-preview/pr-1827/assets/OPFSCoopSyncVFS-CSztcgph.js\":\"d8dcabbc9f0a116c\",\"/knowledge-medium/pr-preview/pr-1827/assets/OPFSWriteAheadVFS-BfkTHPB_.js\":\"c3252f3cea6ba914\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-DNbaKFj4.js\":\"832b433367836062\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-async-Bw-0QdLq.js\":\"650da3f9e67dc548\",\"/knowledge-medium/pr-preview/pr-1827/assets/worker-BnKVn6lq.js\":\"c343a7aef62e9304\",\"/knowledge-medium/pr-preview/pr-1827/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1827/chunks/app-Bc0aU2WA.js\":\"c4fc0093fa787117\",\"/knowledge-medium/pr-preview/pr-1827/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1827/index.js\":\"e6bf0176d3fbad66\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1827/assets/AccessHandlePoolVFS-DGxTHCVK.js\":\"d342dce131272a43\",\"/knowledge-medium/pr-preview/pr-1827/assets/IDBBatchAtomicVFS-BSnXcsyy.js\":\"60da7224f460233d\",\"/knowledge-medium/pr-preview/pr-1827/assets/MemoryVFS-vr-ei-Lw.js\":\"6f684304e78b6658\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-CCl87bFe.js\":\"10fb1f38f4f68918\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-async-BQc4o316.js\":\"c4f0a3e0cbd30cec\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1827/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1827/chunks/AccessHandlePoolVFS-BnbG5OyN.js\":\"f46c86bc54cf8570\",\"/knowledge-medium/pr-preview/pr-1827/chunks/FacadeVFS-Cceh3HBd.js\":\"660a0b9cb2d42886\",\"/knowledge-medium/pr-preview/pr-1827/chunks/IDBBatchAtomicVFS-C3h9L7rj.js\":\"503f31cf776ebdcb\",\"/knowledge-medium/pr-preview/pr-1827/chunks/MemoryVFS-Dpg4pgP1.js\":\"e37fd9a37bbf4ed9\",\"/knowledge-medium/pr-preview/pr-1827/chunks/OPFSCoopSyncVFS-CgCQJq4W.js\":\"3ad930c1df19dc21\",\"/knowledge-medium/pr-preview/pr-1827/chunks/OPFSWriteAheadVFS-CIO0JyLj.js\":\"c206413f7f6ca174\",\"/knowledge-medium/pr-preview/pr-1827/chunks/Preview-Cm-82uo8.js\":\"be27908c88c7b541\",\"/knowledge-medium/pr-preview/pr-1827/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1827/chunks/card-Bmeg8TKf.js\":\"59670579bc7d491f\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-DUCvg5hK.js\":\"479110d51ec2e6bb\",\"/knowledge-medium/pr-preview/pr-1827/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1827/chunks/mc-wa-sqlite-DClNF4lE.js\":\"4dde8e37b0eda770\",\"/knowledge-medium/pr-preview/pr-1827/chunks/mc-wa-sqlite-async-BWLQWMGv.js\":\"a7c1ff5844e3d6fa\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-BwqqhMIh.js\":\"7676fbdc3238cc59\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CQMNsV3H.js\":\"ccdc1257f605ac61\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CbStLxxs.js\":\"8944a1c3df3ca1f4\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CceDAzA0.js\":\"b96ab479768b3950\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-Cf6OLVPl.js\":\"524bedb36422c959\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-D-j2b66n.js\":\"e229b58ad5ce3f57\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-D8r4mSUa.js\":\"a55f7fafcb45bd8b\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-DuXdJy12.js\":\"42ee7deb94ec248e\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server-legacy.browser.production-Cyy54UKi.js\":\"6a84326f49f683d1\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server.browser.production-Cg0kU4D5.js\":\"495ccfbfaf05e061\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server.edge.production-CJnpQPPA.js\":\"7a614108f564a0b8\",\"/knowledge-medium/pr-preview/pr-1827/chunks/server.browser-C1JLe3jO.js\":\"5e477c95c4993106\",\"/knowledge-medium/pr-preview/pr-1827/chunks/textarea-BzGHqDxU.js\":\"64be0b1ca5bb8cf9\",\"/knowledge-medium/pr-preview/pr-1827/chunks/ui-CnzxVnbT.js\":\"825bdd33f05fde50\",\"/knowledge-medium/pr-preview/pr-1827/chunks/wa-sqlite-BFnCwE4u.js\":\"cb7d5e6019e54a0d\",\"/knowledge-medium/pr-preview/pr-1827/chunks/wa-sqlite-async-DnyFY4tg.js\":\"3ffc1601f3e9c7c1\",\"/knowledge-medium/pr-preview/pr-1827/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1827/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1827/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1827/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1827/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1827/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1827/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1827/src/App.js\":\"67462d1a9ea93418\",\"/knowledge-medium/pr-preview/pr-1827/src/appUpdate.js\":\"ce3e2d10d4ecd537\",\"/knowledge-medium/pr-preview/pr-1827/src/appVersion.js\":\"5e4dea408375bdf3\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/initialLayout.js\":\"3045b5a6466187f5\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/openWorkspaceData.js\":\"a5e2e535cbf14bbb\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/resolveWorkspace.js\":\"9aa755cf095eff5f\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/workspaceBootstrap.js\":\"488595f7b7bfe7cc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockComponent.js\":\"670aa1509d000e78\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockCrumbs.js\":\"e540ebe8961f1cd8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockEditor.js\":\"6c1439149bb671ca\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockLoadingPlaceholder.js\":\"08a65e1b4e9af1ff\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockProperties.js\":\"9d852b6bb696b1b1\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockSearchPicker.js\":\"d5c3667e57b0f83e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ConfirmBulkDeleteDialog.js\":\"b147ec29c4483aa5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/DividerHandle.js\":\"26c4079578dec465\",\"/knowledge-medium/pr-preview/pr-1827/src/components/DraftEditor.js\":\"cb060feb82ce616d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/GutterPill.js\":\"b9cab95e60649115\",\"/knowledge-medium/pr-preview/pr-1827/src/components/Header.js\":\"d82134ead6f432cf\",\"/knowledge-medium/pr-preview/pr-1827/src/components/LazyBlockComponent.js\":\"b2915061f011dd73\",\"/knowledge-medium/pr-preview/pr-1827/src/components/Login.js\":\"ebfaa9f2cc7cb68f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ZoomableSurface.js\":\"cb6376007e612e5f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/editModeKeepalive.js\":\"2e5edddf21bc602b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8d5df1596e3a42e6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a3e49becfac7afe6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/RefPropertyEditor.js\":\"f9b5b48eb6f5430e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/RefTargetTypePicker.js\":\"86f6728c012f9e2e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/SelectPropertyEditor.js\":\"a16ee3d2dcda8222\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/TypesPropertyEditor.js\":\"09d607c7505e521a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/defaults.js\":\"fcc3d3aae09b7ed9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/kernelValuePresets.js\":\"1bf8a7446792e854\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/selectablePresets.js\":\"c4c3865ef2136771\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/typesPropertyUi.js\":\"8cb6894458304e28\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/AddPropertyForm.js\":\"42a73ecea7e97657\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/PropertyPicker.js\":\"07691caad9dba5c4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/PropertyRow.js\":\"d5897a96b6d41e64\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/Rows.js\":\"c6259dbbad93ee57\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/actions.js\":\"22c089f984cda4b9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/declarationOnly.js\":\"e6040baf064235e8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/layout.js\":\"acce924271872bb5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/model.js\":\"7b3de290ea052d5b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/shapeUi.js\":\"46e12ced47833616\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/shapes.js\":\"b44661daeb44784d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/usePropertyEditingActivation.js\":\"82fd120a9f559f9b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/visibility.js\":\"dcf441596c6493ec\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanelSections.js\":\"e016eae0a5af1ec0\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockEmbed.js\":\"12abc7f4c34c150a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockLink.js\":\"605383b5b7964ca4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockRef.js\":\"b2522e2597b4ecfc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/ReferenceLink.js\":\"483f2d6d12b061e9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/cycleGuard.js\":\"b53b8d6661c08476\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/cycleGuardContext.js\":\"88d7b5e4da1ac400\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/linkInteraction.js\":\"630ff25c0f6f5c70\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/referenceLayout.js\":\"df61dc94e2b24da6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/useBlockRefAncestors.js\":\"29a537c24103ea5a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockGutter.js\":\"ddae2b5443d01c83\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockInfoDialog.js\":\"4587c8ebe1dac583\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockTypeBlockRenderer.js\":\"80a4a9cd4b23b9ca\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BulletHoverCard.js\":\"756be0e1679a5e6b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/CodeMirrorContentRenderer.js\":\"951269ecf4ee9a2e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1976e5827f1e931f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/ColumnResizeHandles.js\":\"6224b6325bcece22\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"209845befbd0b44d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/DefaultBlockRenderer.js\":\"8cff7fd1703d5f0f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/LayoutRenderer.js\":\"854e4e1bc9a4a515\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/MarkdownContentRenderer.js\":\"11247a6b97df552e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/MissingDataRenderer.js\":\"2beab1c3892854d6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/PanelRenderer.js\":\"c2c771a8fb3f2437\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/PropertySchemaBlockRenderer.js\":\"4151685a0ab69f62\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/TopLevelRenderer.js\":\"c4610ab96b3d24ca\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/blockGutterMode.js\":\"e9c7e8e78d2bd38d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/blockTitleText.js\":\"d7edfc9f386f4661\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/fieldCreationKeydown.js\":\"423205edced34b34\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/layoutRootContext.js\":\"68af7332fac0fcf6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/typeChip/TypeChip.js\":\"722e7440bed4adbb\",\"/knowledge-medium/pr-preview/pr-1827/src/components/typeChip/chipStyle.js\":\"59585935c3a969b4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/anchored-floating.js\":\"19a490a88fae8441\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/button.js\":\"892778f672670416\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/card.js\":\"e202990746a648fb\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/checkbox.js\":\"037b0014f632e2fe\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/collapsible.js\":\"1a5cdfd7a6ae260e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/command.js\":\"12b0ff06f20f6fa1\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/context-menu.js\":\"195f3dfb26cc31d9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/dialog.js\":\"1d6213fce67be527\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/dropdown-menu.js\":\"84161ba10174ccb9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/floating-listbox.js\":\"c731419078aee1fe\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/index.js\":\"077670a4fd17854e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/input.js\":\"692e2faafc7915c0\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/kbd.js\":\"1b875bcb30bfaaeb\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/label.js\":\"8f7a911518edcf26\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/textarea.js\":\"79c5acddee43b61e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/useEditModeYieldKeepalive.js\":\"74f21ce7d7c02951\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/BootFallback.js\":\"7abdd3f606d25a5a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/FocusedRowLazyMount.js\":\"48ada7c43637752d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/LazyViewportMount.js\":\"dcdcb30652d0e70a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/LocalDbCorruptionFallback.js\":\"0db074c0deb7ccac\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/error.js\":\"6003be09d4b3b5a4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/lazyMountRegistry.js\":\"5cf65849d2f0d210\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/suspense.js\":\"0acffea9e0138dd5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/CreateWorkspaceDialog.js\":\"d57f51a3db09e980\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/PendingInvitations.js\":\"7b57b0fe600da250\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/SyncProgress.js\":\"5e257c8794349f30\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/UnlockProgress.js\":\"ec1036fc72ea67a6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceKeyGate.js\":\"b57e7d9c92757546\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSettingsDialog.js\":\"67bd591ff9866dda\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSwitcher.js\":\"4ce19eeefaa54f55\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSyncGate.js\":\"080eae805539587f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/ConversionFlow.js\":\"dc47f4c411177d2a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/ConversionFlowHost.js\":\"345096bbfc863ed2\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/EncryptionSection.js\":\"577e71bb74434681\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/attachmentPrompts.js\":\"e719f7bdd5a251fd\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/bundleFolderPrompts.js\":\"59a440a6a534af43\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/conversionFlowDeps.js\":\"051bc31d0b5ccb72\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/conversionFlowStore.js\":\"d5947edf61d4e317\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/flowUi.js\":\"845cd12f0c8cfa21\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/useConversionRun.js\":\"734800df30a158b5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/keyUi.js\":\"13319a0414ec951a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/useCloseOnKeyLoss.js\":\"121188e0921dadc9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/useCloseOnServerE2ee.js\":\"2f0951add2de4da5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/workspaceUnlocked.js\":\"cbf57bc64c4e7eb2\",\"/knowledge-medium/pr-preview/pr-1827/src/context/backgroundSubtree.js\":\"f072e9e289c59406\",\"/knowledge-medium/pr-preview/pr-1827/src/context/block.js\":\"f43deaa61fe24b0d\",\"/knowledge-medium/pr-preview/pr-1827/src/context/layoutWsContext.js\":\"5faa0a7c3770d154\",\"/knowledge-medium/pr-preview/pr-1827/src/context/propertyDisplay.js\":\"1e9892bcde45d8ef\",\"/knowledge-medium/pr-preview/pr-1827/src/context/repo.js\":\"792fd020ffc3429a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/aliasClaim.js\":\"c2ed286ac77951e7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/aliasSeatNamespace.js\":\"d2689801c2eaf907\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/blockData.js\":\"c0d51acbc3d98f7a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/blockType.js\":\"460ecd834b000839\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/changeScope.js\":\"d10faa4e60af960a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/codecs.js\":\"5791f71f4058e3da\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/derivedData.js\":\"40a310e0a5ceb4b3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/errors.js\":\"4d98c0b3842fff53\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/events.js\":\"1ca203e952c45a71\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/handle.js\":\"a5f6253c788ed5df\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/index.js\":\"1154f8f587b840cf\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/mutator.js\":\"8915ed18f2089a76\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/processor.js\":\"c9b8afb535acc7a3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/propertySchema.js\":\"ff6d152880d4efff\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/query.js\":\"05e7e87956e7aaa5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/sameTxProcessor.js\":\"aa6e90b1a22cc975\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/schema.js\":\"a5f6253c788ed5df\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/tx.js\":\"a5f6253c788ed5df\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/typedBlockQuery.js\":\"985827400e4977fd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/user.js\":\"95d320c6052f22f0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/valuePresetCore.js\":\"1f11ef26dd469df5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/valuePresets.js\":\"d9281e730d0f4a8c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/attachmentCleanerIOVerb.js\":\"46f0a381c884a79a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/block.js\":\"607b3bd11101aafc\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockCache.js\":\"f590c797eea42df7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockId.js\":\"c81379d7f8c39849\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockLiveness.js\":\"44ffbc96e76808fb\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockMerge.js\":\"9e037504a80a1187\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockSchema.js\":\"61acb1a313aa1b44\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockTypes.js\":\"84cb0aaaa96c0f18\",\"/knowledge-medium/pr-preview/pr-1827/src/data/clientContext.js\":\"2af657b09e8bc1be\",\"/knowledge-medium/pr-preview/pr-1827/src/data/dbFileSiblings.js\":\"f6d7f684d7cb190b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/definitionSeeds.js\":\"38be5aa3482ba4f7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/derivedIds.js\":\"e3c2fb9c2e9d74cc\",\"/knowledge-medium/pr-preview/pr-1827/src/data/drawnSubtree.js\":\"8dc82fb9255b71c5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/facetBridge.js\":\"ec74918e0cf08f35\",\"/knowledge-medium/pr-preview/pr-1827/src/data/facets.js\":\"024281ffd73260db\",\"/knowledge-medium/pr-preview/pr-1827/src/data/globalState.js\":\"99c37ef676e280a9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/aliasClaimRederiveProcessor.js\":\"f7261ff47e998f4f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/ancestorBatch.js\":\"d3d5f7fa9a0d07aa\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/blockTypeTypeifyProcessor.js\":\"69f8efd4cf564a30\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/clientSchema.js\":\"c5b8a10ed13f1fba\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/commitPipeline.js\":\"0f2e692fa4442d18\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/devAssertions.js\":\"d03536d2139056c4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/firstSync.js\":\"58e892faff71198b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/freshInitialLoad.js\":\"b43337e91c58f05c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/graphBackfillClaim.js\":\"3783a37f960aa984\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/handleStore.js\":\"102efd8e204645b6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/idleMarkerJobs.js\":\"e81216dd86e0c78c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/initialDownload.js\":\"ac1c8c312767d404\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/initializeClientDatabase.js\":\"c769b80a65d18aed\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/jsonCanonical.js\":\"6cd37608694a370e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelInvalidation.js\":\"03cb72b5da5bd29b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelProcessors.js\":\"159f76363d482c01\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelQueries.js\":\"44b351ef38c35eab\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/mergeTypeMembershipProcessor.js\":\"b259777e723c2fe1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/normalizeReferencesProcessor.js\":\"5318b3f076739312\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/poolInstrumentation.js\":\"088724b1df3c7696\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/processorRunner.js\":\"d9c719d4cf3394b1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyCellBackfill.js\":\"2534fa7dad3df9df\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyChildMint.js\":\"18e61765fac2462d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyChildrenProcessor.js\":\"fd7e51f18bb00bd6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyDefinitionChangeProcessor.js\":\"35dc3cd1474bcef5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyDefinitionSynthesis.js\":\"fb6250aad7f734c1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyKeyScan.js\":\"386eaa3845d00387\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertySchemaResolution.js\":\"ca27abfc4b70871f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyValueEdits.js\":\"a39a47f36da352ee\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/raiseProtocol.js\":\"2462cf6166ce6404\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/readBatch.js\":\"f603a1293964e1ac\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/refProjection.js\":\"6e0e70a9b0187da0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/referenceTargetLookups.js\":\"3ad853ecbcd28c0e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/referenceTargetProcessor.js\":\"62b8f605d3ce66e0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/replayMerge.js\":\"ecfe81b00463b701\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/sqlBinds.js\":\"4d7671b629a4eee8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"23b0a7f6f07c14e0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/arrivalProcessors.js\":\"15760b779a966070\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/invalidate.js\":\"d8c8d6dd3ac9b9b8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/materialize.js\":\"c20fa9a669f9fcbd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/observer.js\":\"1ff1c874e4fdbe1a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/reconcile.js\":\"9d4da2e26638a8f1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/timingMetrics.js\":\"2067cfdebd0dacfc\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/treeQueries.js\":\"bd4a4b446d36bbe7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/txEngine.js\":\"a700c307f50df0b3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/txSnapshots.js\":\"15d4c551b1de4a53\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/typedBlockQuery.js\":\"de640a9dc13158b0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/undoManager.js\":\"c59f0ddd6689c0aa\",\"/knowledge-medium/pr-preview/pr-1827/src/data/invalidation.js\":\"bdaf5046eb47e1d2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelDataExtension.js\":\"61dddaa1e93787da\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelPage.js\":\"7d93cbb9a99e4095\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelValuePresetCores.js\":\"0d526d0d76feb82f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbCorruptionSignal.js\":\"dd6e8dd5a5d70caa\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbStorage.js\":\"b92d43fb20650fa4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbVfs.js\":\"dac39195141d3945\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localSchema.js\":\"e1ebd135adda4b04\",\"/knowledge-medium/pr-preview/pr-1827/src/data/maintenance.js\":\"3ea0f8acd2a922f1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/mergeProperties.js\":\"564a7c0dcddcaf13\",\"/knowledge-medium/pr-preview/pr-1827/src/data/metricsConsoleHook.js\":\"129e8264de15fa28\",\"/knowledge-medium/pr-preview/pr-1827/src/data/migrationsPage.js\":\"c5b25602c4037a7b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/mutators.js\":\"9197bca14c0285ce\",\"/knowledge-medium/pr-preview/pr-1827/src/data/orderKey.js\":\"26eb29c126d0253d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/orderKeyPlacement.js\":\"aab5145ed6687bb4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/outlineSurface.js\":\"858ee82293d0b3bd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pendingEditorContent.js\":\"c3c8be5e4894e56f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pendingUploadsSql.js\":\"5f2c7cbabe1ce8a4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pluginStateExtensions.js\":\"8b3185a27f0571cb\",\"/knowledge-medium/pr-preview/pr-1827/src/data/powerSyncLogger.js\":\"1f3b05000d42e1d8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/projectorRuntime.js\":\"c55db3e98b1aea6b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/properties.js\":\"b94f45adfc26ed5f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertiesPage.js\":\"6867990f94b147ed\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyChildren.js\":\"8403ca66a060a545\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionFanout.js\":\"c40d3634542d21c0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionMetadata.js\":\"61735968e5ebcf84\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionRegistry.js\":\"36f98032730a044d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDisplayMode.js\":\"ec55b68f17c01b7f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyRowCreation.js\":\"8dec14d46fb8ca10\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertySchemaCreation.js\":\"2ccfb9dc201588c0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertySeeds.js\":\"de1a7a6628bcae47\",\"/knowledge-medium/pr-preview/pr-1827/src/data/recentsPage.js\":\"e3caf8152622f859\",\"/knowledge-medium/pr-preview/pr-1827/src/data/referenceBlock.js\":\"72144b52596f9da5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/rejectedUploads.js\":\"29e64b25f53e8101\",\"/knowledge-medium/pr-preview/pr-1827/src/data/releasePowerSyncConnection.js\":\"ef7dc1eac292d7a2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/repo.js\":\"b659dabf612ba20b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/repoProvider.js\":\"5175725f07a96015\",\"/knowledge-medium/pr-preview/pr-1827/src/data/rowProperty.js\":\"2cb772f7f573614e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/searchFilter.js\":\"1b005103c21e9016\",\"/knowledge-medium/pr-preview/pr-1827/src/data/seedIdentityLedger.js\":\"5f38090e5b4e04be\",\"/knowledge-medium/pr-preview/pr-1827/src/data/stateBlocks.js\":\"649095d0dffcfbad\",\"/knowledge-medium/pr-preview/pr-1827/src/data/structuralEditPolicy.js\":\"6d109d35b9243649\",\"/knowledge-medium/pr-preview/pr-1827/src/data/subtreeDelete.js\":\"3fc7fae3305db35a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncStreamLock.js\":\"b6ce0019e6c219b4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncedTableSqlRecognizer.js\":\"bdc75cc1f8c0a56b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncedTableWriteGuard.js\":\"1f6f0c48993323b3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/targets.js\":\"ce84dfb49c050806\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeColors.js\":\"4867f9a0f85175c8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeDefinitionMetadata.js\":\"802333d5d58b5fec\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeDefinitionRegistry.js\":\"98e7fa7cfb51cefa\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeExtraction.js\":\"3bc43138bcf1a3e9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeInitialValues.js\":\"7e14b791eedeeef6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typePropertyGroups.js\":\"7a1c8e8b5b0ab552\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeSeeds.js\":\"e8c77bbdfe178cd4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeTagger.js\":\"c0132daed76e4e6d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typedRecords.js\":\"30a105345d48db24\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typesPage.js\":\"3f60b99e388656ff\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userPrefs.js\":\"8146c6a38fac58ef\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userSchemasService.js\":\"08f3f629f76827bf\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userTypesService.js\":\"719463456c60b743\",\"/knowledge-medium/pr-preview/pr-1827/src/data/valuePresetRegistry.js\":\"1b02496d3cb83af4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/visibleChildren.js\":\"73f85af2dfe65516\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceConversion.js\":\"e6201a00e4027f4e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceFirstSync.js\":\"e8d5f32df255803a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceIdNamespace.js\":\"7c019abbe8f81fc6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceSchema.js\":\"ecbdca1de108c278\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaces.js\":\"a003557bddc00f8d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/writeAheadLog.js\":\"47642804fd9cca78\",\"/knowledge-medium/pr-preview/pr-1827/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/BlockPasteShellDecorator.js\":\"53737766193b279e\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/atTrigger.js\":\"97b16857b9e9029e\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/autocomplete.js\":\"6126c9b7bef8f713\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/codeMirrorExtensions.js\":\"f51009a65b591986\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/contentFlush.js\":\"d80fa88f8bac7ddf\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/defaultInteractions.js\":\"54bb2f90cd6724f0\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/editSettleSignal.js\":\"259f7f2e3cab5a78\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/insertImage.js\":\"378c793ed80f5bff\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/referenceCompletionRange.js\":\"9c5853db7e23b685\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/referenceTargetTypes.js\":\"8e43283b79aed028\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/syntaxContext.js\":\"a81182b00ccfff7d\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/triggerMatch.js\":\"beb74f0768b4a8f5\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/AppRuntimeProvider.js\":\"b913f7d162cf1e54\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/BlockFocusShellDecorator.js\":\"e9f98d617d13e27e\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/ExtensionRenderBoundary.js\":\"83bfec5ee62fc645\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/PanelContentRecovery.js\":\"3abdfa6e7b006640\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/apiCatalog.js\":\"4e3477adff66cf75\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/approveExtensionHere.js\":\"5509a88138a36bea\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/armedCutAppMount.js\":\"8eefadded15971d6\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/batchableKeyedStore.js\":\"0ad0cdd413ab5c95\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/blockInteraction.js\":\"2876e23632bd9d7b\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/blockSelectionAction.js\":\"d42e7eeff772735e\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/compileExtensionModule.js\":\"7fd96a18456c260d\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/compiledModuleCache.js\":\"493d3bbf38389072\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/continuousGestures.js\":\"7a323888ae8e243f\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/core.js\":\"74870e513b1b9603\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/defaultRenderers.js\":\"ac7a1d802abd8fc1\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/definitionFanoutAppMount.js\":\"41cfb8a6b1d03078\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dialogAppMount.js\":\"a21e1d86e7826729\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dynamicExtensionSeeds.js\":\"a040d54b7bd08c0a\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dynamicExtensions.js\":\"53cc8e9bf28702a0\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/exampleExtensions.js\":\"896620d1af0857c2\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionApprovalStatus.js\":\"33cd27eedd064d8b\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLoadErrorToast.js\":\"c12cad469c65f906\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLoadErrors.js\":\"a6546892c58f3467\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLookup.js\":\"034ce39881f6aae3\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionToggles.js\":\"f7e596338e5bd474\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionUtilitiesCss.js\":\"2b604dde1b875b82\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/kernelPageDeletionGuard.js\":\"867a4ffc3368acab\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/liveRuntime.js\":\"3177eee0f2719a35\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/openExtensionsSettings.js\":\"576d2a095b01cbc3\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/overridesCache.js\":\"f6d7450fdd09ea2b\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/pluginIds.js\":\"6ca69f68f6d4f54f\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/processorRejectionToast.js\":\"62e2af63591b9957\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/runtimeActions.js\":\"a96881d66ddbe0f1\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/runtimeContext.js\":\"cbff8b1ed49b16c0\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/staticAppExtensions.js\":\"c00647603d1c50b5\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/staticDataExtensions.js\":\"457ec89d742f81c4\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/toastAppMount.js\":\"008e3dcc90e184d3\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/useOverrides.js\":\"9d00adb8ddde1cf8\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/useShortcutSurfaceActivations.js\":\"6fa30fbb85adf9c6\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/discoverToggleTree.js\":\"70e6f9298525ce58\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/facet.js\":\"02215722ea62758f\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/resolveAppRuntime.js\":\"9ee39769b6bda38e\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/runtimeEvents.js\":\"96330f741fb99abe\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/togglable.js\":\"7b416c5073842b10\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/variantFacet.js\":\"c681ed91c71d0f18\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/verbFacet.js\":\"7e8ceb71284c85f4\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/block.js\":\"24e4543b47b4399c\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/focusedChild.js\":\"6476e47a0c02463f\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/propertySchemas.js\":\"e3fd261504b076c2\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/typeRegistry.js\":\"c4bec27643ebecef\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useAncestorCrumbs.js\":\"0ceb312daaa08cc5\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useAutocompleteListbox.js\":\"181e5cbce54613bd\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useDebouncedSearch.js\":\"2167b828fb5cdf4f\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useDebouncedValue.js\":\"d25e910fce0cd0c3\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useIsFocalRender.js\":\"8892de04e987c042\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useIsReadOnly.js\":\"ea876dc6f94f0811\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useMaterializeBacklog.js\":\"2b51f4ec296215ca\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useMinuteClock.js\":\"9914401290c5e967\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/usePanelLayoutProjection.js\":\"5ba6cdf04b2f9f07\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/usePendingInvitations.js\":\"7e803e52d4a1c9f3\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useRendererRegistry.js\":\"7d8be642d2dbf4b7\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useRetainedFieldRows.js\":\"c52da6e2a0713ad6\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useWorkspaces.js\":\"866b6f1e110546f7\",\"/knowledge-medium/pr-preview/pr-1827/src/lib/utils.js\":\"dc8324815ba28fa8\",\"/knowledge-medium/pr-preview/pr-1827/src/main.js\":\"898dd93ab809ff48\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/MarkdownImage.js\":\"3f958e884039dbad\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/blockSeparators.js\":\"6ec3cbf11b963569\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/context.js\":\"ed01b1379e717f99\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/defaultMarkdownExtension.js\":\"767a916a1706890c\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/extensions.js\":\"92f8f31adb934714\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/renderMarkdownHtml.js\":\"7c4e6cf358c67dd1\",\"/knowledge-medium/pr-preview/pr-1827/src/minimal-editor.js\":\"3756f29d98be01a1\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/armedCut.js\":\"11a23f8a358b2d33\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/captureMediaVerb.js\":\"451b25e800f1c532\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/clipboard.js\":\"297c4864eb95fa94\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/decision.js\":\"389541c9979d44ff\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/operations.js\":\"89914d9fd9da2677\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/account-header/AccountHeaderItem.js\":\"42ed60dc4f256a73\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/account-header/index.js\":\"00b93815fc0d4d8c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7b3cab99a2575f17\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/askAgent.js\":\"d2a2a640ffb2ae61\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/askedStore.js\":\"6592e2ce6189ad94\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0f425ef331f841ab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/chipState.js\":\"e2e1c731a97b4259\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3c3d876b0cb5e30c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/index.js\":\"cf48ea007218d549\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c99b868b34a79d1f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/schema.js\":\"c77274540d4e102a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/AgentTokensDialog.js\":\"cc7caffcc17c97ed\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2516da1b369d6d5f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/addMedia.js\":\"a60378e0cbf57026\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/backlinks.js\":\"967316cd9a3613e9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/block.js\":\"70894ed292b59819\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/context.js\":\"c3a91e399ce9af4d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/displayIds.js\":\"bf6832d5a98bfa59\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/index.js\":\"a87389f350514942\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/outline.js\":\"f640c4631d17c27e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/properties.js\":\"53e019984ddbc6f6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/refs.js\":\"5d04bdaa251225df\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a04df52a3871c99f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/search.js\":\"9f24241123c96239\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/shared.js\":\"0d3933c913371505\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"860db99c55b4d3ee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/text.js\":\"1cbdfa9fa1ce315d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentWrites.js\":\"2b7749ad6607de38\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/authoringCatalog.js\":\"04e21162cde3e4f9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/blockRefTargets.js\":\"7fe54b0bacfce8a5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/bridge.js\":\"637e3eec9f41f2cb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/bridgeLoop.js\":\"99d2f8c77f7282d7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/changeHistory.js\":\"f06d6bbe4b5e5029\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/commands.js\":\"b25138fda7c28a6f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/commentsCommands.js\":\"cf66b91c64705661\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/dataExtension.js\":\"77c32bad8384384b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/dataModelGuide.js\":\"11cb4764e6f0f57b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/describeRuntime.js\":\"f9d0285db24056ed\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/extensionLint.js\":\"e81e2e44729d94db\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/grainAudit.js\":\"262a8764cd79b459\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/healthCommand.js\":\"d6d013913380eee7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/index.js\":\"f2f2c60223033b1b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/presetIdentity.js\":\"ff3530ce92b07370\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e9b2f74aa906187d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/readMedia.js\":\"11d87003de7d41ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/schema.js\":\"dfef3627135f2608\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/serialization.js\":\"06eb488c5171332b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/targets.js\":\"bd12cd8ea29473f6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/tokens.js\":\"4fcd826a61134c2c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/watchEvents.js\":\"922870e76698ed70\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/workspaceGuard.js\":\"a32ed77b209b6b35\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/writeCommands.js\":\"dfbce0eb0a5f571b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/AliasCollisionToast.js\":\"fbf733b4e11c975b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/DuplicateNameBanner.js\":\"1ba778de34a6e367\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/collisionMerge.js\":\"60067e2d87f018d5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/dataExtension.js\":\"8135a09e4062a8d3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/index.js\":\"211611f347b60e6e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/mergeCollisionAction.js\":\"ca10040d4cc14565\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/pageStyling.js\":\"0afe34f7b5590a5b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/rejectionToast.js\":\"352d2a8339140552\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/syncProcessor.js\":\"36038f3fdb160760\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/actions.js\":\"43871ccb58e1fed6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/addComment.js\":\"a996cb09af28e5a2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/anchor.js\":\"c63e8852102bf214\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/anchorState.js\":\"349fdd61dae402ee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/commentLinks.js\":\"6bf6e2fb4be265f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/confirmThreadDeletion.js\":\"b64c6fa4828d674a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/container.js\":\"c115750546d52b89\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/dataExtension.js\":\"417f76cec832db94\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/deleteComment.js\":\"0409c4a02b561e14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/highlights.js\":\"648eb7c6c731f9fa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/index.js\":\"dabde5952100043d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/linkedCommentsPill.js\":\"9602de88f5fe1b49\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/margin.js\":\"25265c45a17ecfb6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/marginSchema.js\":\"6f25b45841610b0e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/newComment.js\":\"661ce127ba230550\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/ownThreadPicker.js\":\"bb3120f33a03ef58\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/placement.js\":\"95f14f6438bd56d7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/queries.js\":\"30f25b91fc72e983\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotePosition.js\":\"3834ae51c9df7326\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotedIn.js\":\"84a8188ab8c2aa8f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotedRange.js\":\"ccecd89dfc9c62d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/rangeRefs.js\":\"7bddf5693413b8c1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readHighlights.js\":\"be785b86641cf3a4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readSelection.js\":\"2b59a13d5291db1d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readSelectionUi.js\":\"443d7667fbae1261\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/reanchor.js\":\"a600c9b8a49ae01e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/schema.js\":\"791471fd753d321f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/scope.js\":\"c5753ea2ec1294c6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/scopeThreads.js\":\"9e568b34a4c4c9e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/splitRetarget.js\":\"b279f271d8cecb56\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/suggestionCard.js\":\"b36e3c19e31a2587\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/suggestions.js\":\"68b025f2b7440055\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/summaries.js\":\"24fe1457238d2d75\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/summaryBatch.js\":\"8f42d209da522b64\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/surface.js\":\"8eac9493645897e0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/threadNavigation.js\":\"1691fda5cbd75236\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/threads.js\":\"72791767972bad5b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/ui.js\":\"374dceef587297ef\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/uiStore.js\":\"c69891a030fb5d61\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-intents/appIntents.js\":\"a0121ee3a6345d65\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-intents/index.js\":\"93b551911e5018e7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-update-prompt/index.js\":\"1dcb51d8d99db4ea\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-update-prompt/status.js\":\"617608b9154ea41b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f25e9e2b6308df6d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaBlockRenderer.js\":\"7013b948ae82120e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaDownLaneReplicator.js\":\"36a3c27a2e88b5cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaUploadReconciler.js\":\"3590b7e1c0b195d4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetDownLane.js\":\"4c7e21c336fe6d7d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetResolver.js\":\"4be2c12773028c10\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetUpload.js\":\"36c04594aa5ef834\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/attachmentCleanerIO.js\":\"8f84535fd2d74ed1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/supabaseAuditIO.js\":\"82a5be4954305a90\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/blobStore.js\":\"983c1f32e659a2b4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/byteStore.js\":\"2ee9f831dc58b58d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/cleanerIO.js\":\"aa91f519bca04fd5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/cleanupAttachments.js\":\"e10ceecbeaa1324f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/dataExtension.js\":\"0ca32a79ad782fde\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/downLane.js\":\"22bf1a51ad2ae54c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/index.js\":\"6d45fff6c318aac8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/insertImageContribution.js\":\"b40eca50854dba37\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/laneArming.js\":\"1a536870440bf83a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/laneLock.js\":\"f55dae41de56047e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaBlock.js\":\"d34edd0daa5d0467\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaCapture.js\":\"90318ba6838f5c93\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaViewers.js\":\"d3166d22c25f2a8d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaViewersFacet.js\":\"bfe97b2ff6f28544\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/pasteCapture.js\":\"17de8fac5d730272\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/resolver.js\":\"2c8cb539e60eb0bf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/retryUploadsAction.js\":\"ec3be3e73936907b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/storagePaths.js\":\"ff5eb161797351b5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadDrain.js\":\"dc791a2542037c45\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadLaneStatus.js\":\"506771ecb65570e7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadReconcile.js\":\"3d7efaea44303a66\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadRecovery.js\":\"d2c345ee166f91b6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadStore.js\":\"e53fe80e61bba73f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/useAssetObjectUrl.js\":\"50e61526c9c4b2e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e03ab208a7b79e72\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ba1af43195bb5fdf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/facet.js\":\"ad1e63e9ae5beeb6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/index.js\":\"02cd281ad23dec05\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/prop.js\":\"d1b45958cd52fbf9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BacklinkFilters.js\":\"5b482b12a846575a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c7fca108b0ade459\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BlockEntry.js\":\"9b0e30c49d0c440f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/LinkedReferences.js\":\"3a24eb354226d0db\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"68cd21517aa65483\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/dailyNoteDefaults.js\":\"ce9e9387fd920c64\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/dataExtension.js\":\"4044dcc7509ff268\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/edgeExclusions.js\":\"7ec9716a2566705a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/filterProperty.js\":\"ee2685a4a41e2397\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/index.js\":\"097b4717c3e45e14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ed1963c6b462e1f7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/applies.js\":\"6b8fceffa4246fbc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/countQuery.js\":\"3a762dcbd98ee597\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/expansionStore.js\":\"361cd89eeaa6811c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/index.js\":\"e0054adcef23628e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"32aae89fc14c5893\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/presentationInvalidation.js\":\"a84596c480ecf386\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/propertyEditorOverride.js\":\"7168ecba6ca4be83\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/propertyFilter.js\":\"b1dd708f2ff5c557\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/query.js\":\"8fc090f3f1f6db85\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/resolveFilter.js\":\"de64843b4c252c83\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/sourceBatch.js\":\"eb950949232f3cfa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/sources.js\":\"b89b7f9b82886e16\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/useBacklinks.js\":\"fcb2b58131b15cf1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f5bba363f1050eba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/BirthdayCelebration.js\":\"c25c246708c2f9b6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/BirthdayOverlay.js\":\"93dc3a67c4cf1f07\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/gate.js\":\"0818ee3decb249bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/index.js\":\"b0ebf9f1c61a88d6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/wolfTheme.js\":\"3d493c128336294f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/BlockDragLayer.js\":\"436ea8c61e586c7b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/dragController.js\":\"ea2f2a82f4240905\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/dropTarget.js\":\"d779b13532e1f0c7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/index.js\":\"0c6803cf144915fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/projection.js\":\"0117ea7c4888c769\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-info/BlockMetaCard.js\":\"f01c39c206267ff7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-info/index.js\":\"89355982833c8bff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/AddTagDialog.js\":\"2c7f99af8c87b415\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"faa4294ab3a1a85f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/TagNameIssueHint.js\":\"17b3b26300fcb556\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/addTagAction.js\":\"67add284e1fdb462\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/appendTag.js\":\"05a82c621f1ffa67\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/config.js\":\"622a5d2b01cd91b5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/dataExtension.js\":\"20344da4e8bc3918\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/index.js\":\"754a8ca61c75675c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/propertyEditorOverride.js\":\"b38845a280596bef\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e7abd356463edb54\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"0b3997ef42c73d93\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/Breadcrumbs.js\":\"25121f9f011895ee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"530ed0c3e2b0222d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a33d5e38f3f08b62\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/index.js\":\"1634b391909f92ed\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1c8ea4c8980cded0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/CharacterCountItem.js\":\"ee7a2117d239db31\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2249182590740e4d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/actions.js\":\"d06943533a9f83b0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/blockType.js\":\"4ff3f9cd0a2cdc03\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/charCount.js\":\"f10ff19931a290fe\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/dataExtension.js\":\"4cce8cc9742625e3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/index.js\":\"e9d6918bef5a5559\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/profiles.js\":\"230209bfe6a41a9b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/properties.js\":\"d260afa6ffb02ca1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/textCounts.js\":\"ffe133682c159e10\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/colemak-keybindings/index.js\":\"9ce45c88bd77b612\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/CommandPalette.js\":\"1653b1399279bb13\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/HeaderItem.js\":\"0bc76b1219cc7d3f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/context.js\":\"a119cce8b85399bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/index.js\":\"c47681f49eb9f606\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/selection.js\":\"d1298a6f7bab3525\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/toggleStore.js\":\"3dbdee82a85551e6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/useCommandPaletteActions.js\":\"e62a5b75945168d1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/ContributorBadges.js\":\"7cd95f9fd0cd96e6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/author.js\":\"622571f8ec558f56\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/codeMirrorExtensions.js\":\"42bba0a9f06be97e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/dataExtension.js\":\"66e51c0cee192967\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/index.js\":\"9d1ef977c6698314\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/mentionAutocomplete.js\":\"ac42d05b0b345e9a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/processor.js\":\"1107319f694a822c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/profiles.js\":\"9edf49d9aca0fb12\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/queries.js\":\"d29ed9ac461646ac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/schema.js\":\"f5149c7e8b10f749\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a5901e0d0e96446b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e99b222ffddf6cd5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/index.js\":\"a14152235c6ea9ab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1902da50adfeba14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d690568821eb093b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/CalendarGrid.js\":\"e5bf247a3aaf4463\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DailyNotePicker.js\":\"938baa8551a4f55a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c0a16e98315a3900\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateNavDecorator.js\":\"6b2cd51918b53fb6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateScrubOverlay.js\":\"d622c8523971dd1d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/HeaderItem.js\":\"6986acd8e7b34f20\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/ReschedulePicker.js\":\"da89de307b6fe046\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ac311dd80f7afd19\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/actions.js\":\"c2e888e9c9124a4a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/blockDateAdapter.js\":\"3ec4839c243b3f64\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/calendar.js\":\"aaa0948528f79b67\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dailyNotes.js\":\"d203e8fdbf718b65\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dataExtension.js\":\"eef301b81ce70cd8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubActions.js\":\"ba411019b9204f7d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubGesture.js\":\"864325226c3b7bf7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubGestureActions.js\":\"764b9501dd7a49bf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubRecognizer.js\":\"fc812c45f0185ee3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/deletionGuard.js\":\"a42ab09e14dde6cc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dueQuery.js\":\"c99fa7d948061086\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/index.js\":\"794e4ef9171bcad6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/landing.js\":\"65adc08b8dc476c3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/localSchema.js\":\"811669ffe93e39f7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/referenceDateAdapter.js\":\"3054f579b5482e75\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/rescheduleAction.js\":\"0fa98f108ba0dbcc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/schema.js\":\"294e62b18c3c1da0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/spreadBlockDates.js\":\"1b18ac93ee68cf68\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/spreadDatesAction.js\":\"c43fd7fb8608f334\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/today.js\":\"1a166175acca76f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0b5eb48e1ebd140b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b7be502e68af13fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/audit.js\":\"7c204a732711c8a6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/auditAction.js\":\"1abae5ca2c0a62c8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/auditRanges.js\":\"967c7aa049ae3c99\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/diagnosticsSource.js\":\"340aa85d091e75e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/divergenceScan.js\":\"90de984a22c4024c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/index.js\":\"3be858929fb47aaa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8ef23064e0a22ac9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/referencesMirror.js\":\"e04dd4a101eaca88\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/rowJson.js\":\"068694892fbf28cc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/schedule.js\":\"3aa012d2917d030d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/store.js\":\"10aa350ebe2ac0c5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/action.js\":\"8399e49f44e38c13\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/index.js\":\"1b634fcd5327e437\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/plugin.js\":\"92fce6935eddff97\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8f4544dba5d19e7f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/actions.js\":\"e183523fd3b06c92\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/changeMarker.js\":\"33f15f4cabae8ed9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/diagnostics.js\":\"60fb10626403f691\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/fileSystemAccess.js\":\"1a6355ea56e0ca79\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/filenames.js\":\"29cd52cc754523ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/index.js\":\"86cdace203b631be\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/mirror.js\":\"2d80741e2100a654\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/runLock.js\":\"bb8f27d47c399aaa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/runtimeHealth.js\":\"c96c24842ada5c11\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/schedule.js\":\"310fff1dcaea533f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/store.js\":\"a193346c52e615dd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/default-themes/index.js\":\"3c334eef7fb87db8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/default-themes/themes.js\":\"4749173a493bb864\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/diagnostics/facet.js\":\"68a4e85d76151e02\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/diagnostics/useDiagnostics.js\":\"c1a10268ef5eaf3f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/dismissals.js\":\"09ae24d1fcfe7501\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/index.js\":\"2532f2b7b0378b28\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/status.js\":\"d13a2ae1b6032f41\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/store.js\":\"e251401217a885fa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9650d2af575cc36b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c35328de1d2e2265\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/actions.js\":\"e00fc73aa09dd67d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/config.js\":\"56a2ba2c2b146a40\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/dataExtension.js\":\"94e5e721f4b5dee8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/effect.js\":\"7d9b9b3a681d2e1d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/index.js\":\"93e845c33ec4b72c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/propertyEditorOverride.js\":\"536da11b42de2c52\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/useToggleTree.js\":\"fd5803b8f8092782\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/ExtractTypeDialog.js\":\"9ed27d2840f6556e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"acc413ac9474a806\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/PropertyShapePicker.js\":\"96b222e001ae4b53\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/action.js\":\"ef9b6570d6dc0182\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/index.js\":\"a3789772fcc60d05\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/FindReplaceDialog.js\":\"23e5fb5f0965594e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/HeaderItem.js\":\"8e35df1ac70e502f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/dataExtension.js\":\"db9b8d834574f091\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/index.js\":\"013f72591585f69f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/search.js\":\"704af4792fe02e33\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/toggleStore.js\":\"008e8e59dd9dd1c2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/LocationPropertyEditor.js\":\"0c1fa1054a68e194\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/MapView.js\":\"af02c8ec971a3905\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/blockTypes.js\":\"b84e72ae8ca28c9d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/codeMirrorExtensions.js\":\"c3d7a17af421a695\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/createOrFindPlace.js\":\"48bd086564b6e3b5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/currentLocation.js\":\"6fbadd84e8240ac1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/dataExtension.js\":\"3e511123bdf5dab0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/geoContentDecorator.js\":\"d0e081aca8ac7db9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/googlePlacesClient.js\":\"7c690fb6be793b60\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/index.js\":\"096e1a40190b5c93\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/locationsPage.js\":\"9612342f8d3ebf39\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/mapViewport.js\":\"65e641e4e26c7e3f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/pickCurrentLocation.js\":\"0a3dc4f541fab00c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/placeAutocomplete.js\":\"83981ae70f8c72a1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/placeNameCollision.js\":\"36e8625611659ca7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/properties.js\":\"985c2f41da9e9bff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/propertyEditorOverrides.js\":\"57aa4eb148d9415a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/query.js\":\"5142cad4059332ae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/usePlaceSearch.js\":\"88a652419d8a0ba9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c9178c754513442d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d9d49ec83509d1de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"cf333714149dd5fe\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/config.js\":\"84c005dd9f1b1986\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/dataExtension.js\":\"68b074091e3c6e7d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/facet.js\":\"3bf74710986d0e2c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/grouping.js\":\"e1efbc4ab835582d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/index.js\":\"39ea0723f615dd21\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"766611e2968b0346\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/query.js\":\"73051fb99ffa62e6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/resolveConfig.js\":\"ca489516ae9f9024\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a8a054b40630d1aa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"963527da11c0254a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/HtmlDocumentContent.js\":\"4c47e27f3e2aa08e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/HtmlFrame.js\":\"7cb759cb8f662535\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/actions.js\":\"7cda76e5af7f9508\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/blockType.js\":\"21dc26c12c82653c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/confirmRunScripts.js\":\"6c820a4ef4870102\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/dataExtension.js\":\"ec26012f3fef849f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameAnnotations.js\":\"e6ba45ec9ab340e4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameDocument.js\":\"a4e44d845cce46f1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameTheme.js\":\"2cd2de3444616efc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/index.js\":\"b81ec92d35b26081\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/scriptConsent.js\":\"5d4fb068756af075\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/sourceMap.js\":\"7c646dd1b94764d5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/useDocumentScripts.js\":\"25ad77c52cf0fea6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/index.js\":\"337997f32d425494\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/record.js\":\"a4492a71e5c0bd71\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/recordStore.js\":\"e2d6823afbdf1427\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/responsiveness.js\":\"2083fa5202d4ead0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/schedule.js\":\"59a761c51d2773c5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/sessionContext.js\":\"7789fe0e9f6526e0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a3ab0f6fea73661a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5e9b5f7f0b8cc073\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/actions.js\":\"0c9bef1ae0b732ac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/config.js\":\"fa77477c04194ee0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/dataExtension.js\":\"ceffc953d4da056e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/effect.js\":\"57fd99ffeb2c61a4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/index.js\":\"92563afdbe0fabf8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/keyCapture.js\":\"ec509f1f5c0ccb77\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/overrideStore.js\":\"75b92d8ff42355cd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d49d17749b2bc878\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/HeaderItem.js\":\"11d0ac635792d5f2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/LeftSidebar.js\":\"12627f5dd34f9834\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/actions.js\":\"dfeb26e831e319bb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/facet.js\":\"6e9bd1955a09ba53\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/index.js\":\"98b03024392d0ea3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/shortcuts.js\":\"b9254d85e2abe7bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/toggleStore.js\":\"2428861c9f4f9a4a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/MergePicker.js\":\"16d638c0cf8742ee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/index.js\":\"e248e132234cdf0b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/mergeAction.js\":\"7ad795a001e799ed\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/strategy.js\":\"c9e3bfb5c44a3500\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/Button.js\":\"ef5a8dc7bde2a7ff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9c29cdcb4c1e7eff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/defaultItems.js\":\"baab7b1fa5dec03c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/facet.js\":\"7273ec87040be115\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/index.js\":\"3214fa1db55d89c4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ec581580476862f0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2a8d2f2373f7dd9d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ce1b39a808c3f37f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/facet.js\":\"05b4214a47018b4a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/index.js\":\"fb5c42dc6ed3ae65\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2d973f0b3f058a8d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/blockSubtreeMembership.js\":\"bce7527b6fd4ebe3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/contextMenuItem.js\":\"45a10ccde3fcaa57\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/index.js\":\"8b3e809b22c7fd0c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/moveAction.js\":\"7cffb386b6deccec\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/moveBlocks.js\":\"18f396b034b97773\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/selectionAfterMove.js\":\"ce2cd9af797f0804\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/TutorialBanner.js\":\"d8f4e6c5d38af673\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/action.js\":\"086153d4529ad27c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/bannerDismissal.js\":\"e13e02990de36136\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/documents/cheatSheet.js\":\"9158637da63c456d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/index.js\":\"5a92d57c514eabdc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/keys.js\":\"693d952253ce4354\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/landing.js\":\"b45f7f155a393e16\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/outline.js\":\"fc31bd8557d483a5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/seed.js\":\"feca66e36ad8575f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e931e9219754b74a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/analyze.js\":\"a667d0c1e8b27386\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/diagnosticsSource.js\":\"353f0b8f485f70a8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/index.js\":\"0ec6bac148f925e9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/load.js\":\"51156bb396251cc0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/monitorRun.js\":\"599b4a52b650d780\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/schedule.js\":\"0471864c36d52aae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/series.js\":\"d65e22da2f773c1e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/store.js\":\"fcfa843b110daac5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/trendAction.js\":\"925a756402f76f59\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/verdict.js\":\"897ae1cbed154fa8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/clickToEditAction.js\":\"9a1d3c912f7d995e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/index.js\":\"f7f69e6c01d36b6c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/interactions.js\":\"111195c8893a6a96\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1e6c244afd3f1cd9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/MigrationGate.js\":\"5908979642eca522\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/MigrationGateDialog.js\":\"90dc85ef4ef8aff2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/action.js\":\"edda236de1bbc2fc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/index.js\":\"0d6e529bc9e95dd1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/localRunMessage.js\":\"3ff72cc46840b50b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/plugin.js\":\"ba171592f56b1d6c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/progressReport.js\":\"61a84f319df422c7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/sweepProgress.js\":\"e1ff40b81d8ab083\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/FieldRowRenderer.js\":\"136183abe8c948ff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/ValueRowRenderer.js\":\"527b38338fd689e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/actions.js\":\"aaaf506c42f23bb8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/autocomplete.js\":\"2399e669f3d7ea6d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/fieldRow.js\":\"cb1cbc8bf05dc6f1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/index.js\":\"2837e7ceed870c1b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/referenceWarning.js\":\"a02cf582af0d72ff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/valueAutocomplete.js\":\"667eb6c2b4523b3a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/valueSchema.js\":\"b82761861dbf3983\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/HeaderItem.js\":\"3b5d6f3161809b3e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/QuickFind.js\":\"2b1fb39719ce2739\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/index.js\":\"646f860249361f96\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/recents.js\":\"9faaedde6bbe7c50\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/resultItems.js\":\"1859b2f2b19f0ace\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/selection.js\":\"6e97a4e54ab385cd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/toggleStore.js\":\"5554fb37ce982683\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/HeaderItem.js\":\"93fe46d3c1f052a2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f3db539c5071bbdd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/grouping.js\":\"08b2c0e59a19d627\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/index.js\":\"82b22cd586172290\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/target.js\":\"9e466278d72bab97\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/codeMirrorExtensions.js\":\"3bb540262c5a9ec4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/contentPrefill.js\":\"e52c65038f19be69\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/dataExtension.js\":\"b7d2edf9c3e54861\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/index.js\":\"5f7e2cdb4330381c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f780d9dee2e020fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/invalidation.js\":\"7ec4a89a44303fa9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/localSchema.js\":\"4e0fcbe8fb2583b0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/blockrefs/index.js\":\"d83e9f3364b73d5c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"34c960c209bdb6cd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/index.js\":\"f5aac4bc0f1bcea0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/referenceNode.js\":\"fc24f4f03a4c526e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7b4774ae96c77769\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c5a80132bb2e012b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/index.js\":\"12b8b77c51987c7b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"db7ee7ba8297d5e5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1f704c71f165eeba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/mergeRetargetProcessor.js\":\"7a3d5cb1b2e23e4f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/parseFence.js\":\"ff24cae939c0f7d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referenceParser.js\":\"88dcce17901f2325\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referenceProjection.js\":\"399a9be368e6a8eb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referencesProcessor.js\":\"bfdf3e5bdde8d8f1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/renameProcessor.js\":\"92f6c19d3b28992a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/spanReplacement.js\":\"ccf6f0e6da36526c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/htmlToOutline.js\":\"160a6c23902a6af4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/index.js\":\"d91de1cd33c0d4c9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f11c177ea62187c5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/pasteDecision.js\":\"24169a6cc776b90f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/action.js\":\"a8b074aa5879fe2c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/blockIds.js\":\"f6f7c24a8277e9ee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/content.js\":\"737033cc6630332a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/effect.js\":\"2003dd4cddf5bd76\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/ids.js\":\"8750cfe9a659e53b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/import.js\":\"d6ee6761f31a6d5b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/index.js\":\"daf057578f42f036\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/plan.js\":\"7faa7c789dc1fff8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/plugin.js\":\"936b6a84d5d3ed02\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/promotion.js\":\"980da35a260cd107\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/properties.js\":\"955b8b05f4925e01\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/references.js\":\"db85a5ba41a541e2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/report.js\":\"373f102411d79c20\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/roamMemo.js\":\"d1f262e1b2de8cd5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/runtime.js\":\"ef18f53ad208ee3c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/schemaReconciliation.js\":\"cd2c4a3f0a73f0c8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/srsMarkers.js\":\"fc82307284c70764\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/todo.js\":\"575ddfd9a567f394\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/typeCandidates.js\":\"bdfee59ade9521d2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/types.js\":\"68cf135edae8d77d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/search-health/index.js\":\"4a20ca543900e2f3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/search-health/store.js\":\"5fe57a1b4752066e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/HeaderItem.js\":\"55a63e4da6d923ac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"1fcdbd94ede9edb4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/index.js\":\"dcc80616312038ed\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/model.js\":\"b922ba4cef11d259\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/toggleStore.js\":\"8a6a018b38a73127\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/useKeyInspector.js\":\"7ac5367d7fd25fcd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"eee628cd08690a95\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/ShellDecorator.js\":\"8dd5b369e39c2feb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/actions.js\":\"f3348a10d168900a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5141302b62e31aac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/index.js\":\"b1b0eb92496f7dd1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/shell.js\":\"7dbd0666b2732922\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/surface.js\":\"36a590dd28d11486\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/walker.js\":\"84e21ea78f5786d4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ee472b9e27b17beb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/dataExtension.js\":\"0e599b495e6d7001\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/index.js\":\"13bb4daf5f00a9c1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/indicator.js\":\"c237cb206e956b96\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/moveSrsState.js\":\"23a4ffc880fdb9c2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3ab82ff6de88fe51\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/scheduler.js\":\"43d765f8662d8358\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/schema.js\":\"18beba16bf80f72a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9b442f0d6a31c9fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/srsClipboard.js\":\"dcd69f9d73a2e1cb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"54898c467ec84011\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2e41775477cb3166\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/DeckPicker.js\":\"4fd342a535a0951f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewControls.js\":\"48f33ed6867d60af\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6073e32c268ccf49\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewSession.js\":\"21758977b4dc8cda\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/actions.js\":\"51a3202e76269f57\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/archive.js\":\"619625884a475feb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/dataExtension.js\":\"486a0c2af1ccf0b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/deck.js\":\"3800806b0b018900\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/dueQuery.js\":\"492517b2a96d37e4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/gradeDecision.js\":\"f30275ba3fc4fb93\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/index.js\":\"617b54e29dc35e6a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/keyHints.js\":\"c3665f4e9bc3cce0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/reviewCardLayout.js\":\"441db527be9409e3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/reviewProgress.js\":\"24cf88ce3d4c49c0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/schema.js\":\"4b7756a372693a52\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/useDueCards.js\":\"7303fec952a5c173\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/startup-metrics/index.js\":\"6a9e0f7f96ed387e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/startup-metrics/record.js\":\"9b2d6e211f5a8bf1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/index.js\":\"73be30aeacce4c31\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/persistenceStatus.js\":\"65e1609ffe7a91b3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/requestAction.js\":\"8da4a3ed74b3810e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/TypeChipsDecorator.js\":\"024e6c17feb12030\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/codeMirrorExtensions.js\":\"9a526c9f56ccf208\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/index.js\":\"19cc958f2bbd6fb3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/typeAutocomplete.js\":\"733159b1e4e24753\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2b44d2ad9e997350\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/actions.js\":\"a98c852cb376c9a9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/anchor.js\":\"c0f2f7c98d501674\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/events.js\":\"c4a87f5a53c5f8c1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/gestureActions.js\":\"209951485ebba0e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/index.js\":\"766b2cb3bfb7295a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"001fe8ea4f24bb11\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/collect.js\":\"62fc77f9057425e5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/index.js\":\"d9ea421d5b6bc4ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/record.js\":\"5d47a9e5367844d6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/RejectionDialog.js\":\"f6a5f001fead3b84\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b9c5f976ff017405\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/index.js\":\"ecb28051a640355c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/model.js\":\"cc8aee0994a8bbad\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/queueCounts.js\":\"e5fef8993d2722bf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/rejectedHelpers.js\":\"a4877ec4e098e631\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/rematerializeAction.js\":\"369c34425b044a47\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/useHysteresis.js\":\"ef56920df50d3396\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/TableLayout.js\":\"70add4fd36cc42bf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/actions.js\":\"06389f0e3a50fca7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/cellEdits.js\":\"31c842ab3eb6e033\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/controller.js\":\"d66727c6c2089d5c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/convert.js\":\"158b816c920f21ab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/dataExtension.js\":\"841577e0c827e59a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/index.js\":\"e4b128c16fb3d6c7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/keys.js\":\"e33c46ba1acdb90a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/model.js\":\"a737477b47b54474\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/registry.js\":\"ae21b601113c0808\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/schema.js\":\"3ef9e4f0f66ebd1b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/effect.js\":\"25758dcfbfae2cf0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/index.js\":\"0f453c9acb79474a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/theme.js\":\"879cae330e9cfb39\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/actions.js\":\"49e1bd26a22615ea\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/dataExtension.js\":\"cec6ae5f1579d84b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/index.js\":\"092e045affea5f97\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/schema.js\":\"f5a711baf3010ec1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/TouchSelectionLayer.js\":\"08230d4a84af793b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/actions.js\":\"1b727c1f49b5b66f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/defaultItems.js\":\"a606aa1f7d4d44a1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/facet.js\":\"50d7671d8b90b5a8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/holdRecognizer.js\":\"40cf05715fc9cdb0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/index.js\":\"ad734c431c540ce6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/UpdateIndicator.js\":\"072c7241eb8a6ff6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/index.js\":\"1e18fa17528c1d92\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/loadTimes.js\":\"a672f42d9310610c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoNotesRenderer.js\":\"4899161a67c25000\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoPlayerRenderer.js\":\"d371b472f9ced27e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoTimeStamp.js\":\"74c7c18972247f88\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/actions.js\":\"d814c5fae9c54d33\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/index.js\":\"ce9f92b3bcdf7690\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/markdown.js\":\"ea56393e7078b06d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/notes.js\":\"7e22d3ecb575ff27\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/registry.js\":\"35c2a0645c47125c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/remark-timestamps.js\":\"98ad40881b7c7a9f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/view.js\":\"607470d96114eb85\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/LinkHints.js\":\"7686e6abf30efafa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/index.js\":\"de625a7bb472eac1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/model.js\":\"ece109b98a205312\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/settings.js\":\"22198a3445ea8410\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/actions.js\":\"158aa93bc3f91a41\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/index.js\":\"c1f600e12c09b2a7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/interactions.js\":\"45148453d13e69a9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/workspace-header/index.js\":\"acae9b22ba154691\",\"/knowledge-medium/pr-preview/pr-1827/src/registerServiceWorker.js\":\"4886a742c8da1bdd\",\"/knowledge-medium/pr-preview/pr-1827/src/requestPersistentStorage.js\":\"fc7ae8fde8997dc8\",\"/knowledge-medium/pr-preview/pr-1827/src/services/authRequestDeadline.js\":\"d028f47a8ab0703a\",\"/knowledge-medium/pr-preview/pr-1827/src/services/authStorage.js\":\"b41b1fd34cfed216\",\"/knowledge-medium/pr-preview/pr-1827/src/services/powersync.js\":\"be25bc9834199f9c\",\"/knowledge-medium/pr-preview/pr-1827/src/services/supabase.js\":\"ba0e22d090db4a94\",\"/knowledge-medium/pr-preview/pr-1827/src/services/uploadErrorClassifier.js\":\"505c6ce5e697e18f\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/ActiveContexts.js\":\"8f061fc0b14f5636\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/HotkeyReconciler.js\":\"665a763a050286fd\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/WipeLocalDataDialog.js\":\"b59e3bd64dba5198\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/actionDispatch.js\":\"73287bce3e20ecd6\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/actionRefItems.js\":\"cbc680f85a4a0028\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/applyKeybindingOverrides.js\":\"92b7f79fb66fafc9\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/blockActions.js\":\"d384b7211e048bc3\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/canonicalizeChord.js\":\"df8c0b9203883cdd\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/defaultContexts.js\":\"6c6fffdb3d261510\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/defaultShortcuts.js\":\"d2824e91d55c91e6\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/effectiveActions.js\":\"b36d13393be0a9e5\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/gestureAction.js\":\"216362d5b5054cc6\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/gestureBinding.js\":\"8faca4616b8edb91\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/holdRegistry.js\":\"5165780368653f7c\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/keybindingConflicts.js\":\"b0dfd4328510dcd0\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/keybindingOverrides.js\":\"e06e981fac5de688\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/pointerAction.js\":\"9afede80783e3558\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/resolve.js\":\"328b83298a5d556d\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/runAction.js\":\"8a934b2190401516\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/sequenceMatcher.js\":\"d639547ca333e77f\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/types.js\":\"285f239fce6b6ead\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/useActionContext.js\":\"ec2bd33c5e7d3700\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/useActionDiscovery.js\":\"2789c0419670f7cc\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/utils.js\":\"aacda61ec4abc937\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/bootStore.js\":\"c1d15c14a7663d77\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/previewDatabases.js\":\"9e8a405744105d80\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/byteTransform.js\":\"939ca648ada8dc73\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/attachmentCleaner.js\":\"acd0152fdcb9947d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/attachmentParts.js\":\"63bbf772b49fd7fd\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/bundleParts.js\":\"f6754f450b1bd215\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/bundleRecord.js\":\"7bd686b055bc7fdd\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/manifest.js\":\"4932576c99bf93b5\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/takeBundle.js\":\"c7a2d3331c07c6e8\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/verifyBundle.js\":\"ccc6bbce070abe35\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/cleaningStage.js\":\"085ef8ed2385f25e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionKey.js\":\"6987effc240f3906\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionServer.js\":\"017306a67e3537a0\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/flip.js\":\"5bbd9cd5fd0bcb6d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/flipAttempts.js\":\"f0a8091676b2feb2\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/pages.js\":\"a9772fd8050d5121\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/preflight.js\":\"f479f1043ecfe9d5\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/reseal.js\":\"800e5e8896dab0e3\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/runConversion.js\":\"0f3fa0411ba7065e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/runLock.js\":\"8c2a2fd0c1e5ca9e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/sealing.js\":\"10e15a19244cc05c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/sealingStage.js\":\"d30901edf0e08059\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/stage.js\":\"03f52c687c58d702\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/verifyReseal.js\":\"fcd2df042bdcf376\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/aad.js\":\"f54b473e5e136ee0\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/aead.js\":\"3faa2ea2d42cdf3e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/base32.js\":\"4cab658f389e0f92\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/base64url.js\":\"7277672425430327\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/binaryEnvelope.js\":\"ad49b37c5366228d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/byteAead.js\":\"f474a110530eee80\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/canary.js\":\"a918724c11983d9b\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/contentHash.js\":\"3ca443479f695f06\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/contentKey.js\":\"4e3694f144960367\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/derivedIdNamespace.js\":\"fc560101aabaf997\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/envelope.js\":\"b53c6414601cace1\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/hex.js\":\"4e2cd139dc0061e9\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/sha256Hex.js\":\"c172715ce2468d91\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/workspaceKey.js\":\"9f61365e0513d2bc\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/conversionState.js\":\"de9dd19ed332cd1a\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/createEncryptedWorkspace.js\":\"fcff18489c8b7c45\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/pastedKey.js\":\"849565ab46fb8d8f\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"51688c7629cfa618\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d5404937f45908f8\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/keyStore.js\":\"abcc01dd7c452271\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/mintWorkspaceKey.js\":\"64dda08cba5bc53c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/modePin.js\":\"7617df6741d35a79\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/openWorkspaceKeys.js\":\"07ae7f1beba2bbf1\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/resolveWorkspaceEntry.js\":\"f0bf3ad8776e2f97\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/resolver.js\":\"5f51c8f58948c088\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/workspaceAccess.js\":\"f520e8d166194b07\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/transform.js\":\"4f15876d26aa60c3\",\"/knowledge-medium/pr-preview/pr-1827/src/themeBootDefaults.js\":\"0759a3e38514905a\",\"/knowledge-medium/pr-preview/pr-1827/src/types.js\":\"8dbdc1a65dc56823\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/ClientLocalSettings.js\":\"4703aa601d308c5e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/abortableSleep.js\":\"4b940c59e94fe8f8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/array.js\":\"02941e5cd7f45df6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/backlinkAutocomplete.js\":\"df64f247b26b9003\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/blockCrumbs.js\":\"a5994e6334803aba\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/blockrefAutocomplete.js\":\"862eb83c1b00074c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/cadencedIdleJob.js\":\"b7567b0f91f5211c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/callbackSet.js\":\"310a0878748a0fba\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/clientId.js\":\"59cdbb8e0274f187\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/codemirror.js\":\"5d9fbe4c685bfab9\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/codemirrorCompletion.js\":\"1525b5460df58634\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/copy.js\":\"35f3c8e0c7f583bf\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dailyPage.js\":\"ebce1eb7e690527e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dbForensics.js\":\"55718fa6e86e23ad\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dbForensicsHooks.js\":\"c0275e692de82cce\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/deleteBlockThroughUi.js\":\"25387c681d159b8a\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dialogs.js\":\"343631e70b7f8311\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dom.js\":\"2bff4bb456d626d3\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/downloadBlob.js\":\"09dd99241104db45\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/exportSqliteDb.js\":\"504e5e30fe23329d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fileSystemAccess.js\":\"53eb418ee3498552\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/flipSlide.js\":\"2c01cb18e7170d09\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fnv1a.js\":\"6b10eb0727062f8c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/formatBytes.js\":\"74dbcbc0a798eb38\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fuzzyRank.js\":\"6c27ec25a0af6d47\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/idbKeyedStore.js\":\"d4471b082be32cc5\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/idleCallbackPolyfill.js\":\"d90b4e49fd9c575b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/keyboardAwareScroll.js\":\"66f89b0620130ab8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/keyboardViewport.js\":\"3ff019cbac01a3ea\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/lastWorkspace.js\":\"1bb84913da69cba6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutColumns.js\":\"bc42ad7be2d9a85d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutSessionDom.js\":\"4446827f2851b1ac\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutSessionId.js\":\"aa696983fff8c5bc\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/linkClickGestures.js\":\"8a264a80372dbae4\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/linkTargetAutocomplete.js\":\"a7380635eae9fa9e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/localDbCorruption.js\":\"151030d71536aab0\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/localDbRecovery.js\":\"648ba3c5d10a8ab5\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/markdownParser.js\":\"4ce20d1d656d01e9\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/memoize.js\":\"5a8a2f9f4cba11b5\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/nameFieldCommit.js\":\"c79203a69c3613d5\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/nameList.js\":\"4c17714391871e5f\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/navigation.js\":\"7f4c8d0dca628a66\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/omnilinerNamespace.js\":\"7bae0703b040e925\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/opfsPageScan.js\":\"79432e7e248d5ecb\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelClearance.js\":\"c87361230d408090\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelHistory.js\":\"1158cd159044bd0b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelLanes.js\":\"765e98a4250fe6fe\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelLayoutProjection.js\":\"476b05ba1abebb2b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelScrollAnchor.js\":\"3118360996df5535\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelUrlFlags.js\":\"24faf1b1b94bb3bb\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/platform.js\":\"67dff1e3ef88ee2b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/pluralize.js\":\"417bbeb50e788453\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyCreation.js\":\"5ded4c70d14081b6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyNavigation.js\":\"973c444a3592c24a\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyValueContext.js\":\"f4f61b8c8864a9e2\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/react.js\":\"fae4e6bd493dfaf8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/relativeDate.js\":\"5c68baf19f53b8fa\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/relativeTime.js\":\"825016f4cfbd9c09\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/renderScope.js\":\"2829ba7d6c7ce6a8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/resolvedThenable.js\":\"9104ce47cb730a76\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/routing.js\":\"8bb6aebd5dab38fe\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/safeMode.js\":\"cc42172e8f8e9e93\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/scheduleIdle.js\":\"838a9b1f355d920b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/screenWakeLock.js\":\"950bfedfa216f262\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/selection.js\":\"c4220152f060f583\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/softKeyboardGrab.js\":\"45340be07ab58f9b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/startupTimeline.js\":\"4e9e18f1d5e4d5c8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/state.js\":\"6c424214cb7bb006\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/string.js\":\"d2effa0962f20311\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/surfaceZoom.js\":\"79e33feab3a51a37\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/time.js\":\"0e22a1fa4c71ad68\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/toast.js\":\"16a5452e0eb50b15\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/toggleStore.js\":\"261d63b5ac4be88c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/untilStopped.js\":\"d492f22e0dad4c6d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/userActivity.js\":\"84c80c690b493728\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/viewTransition.js\":\"9d1ebc364566c539\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/viewport.js\":\"7e400f9dae122814\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/webLock.js\":\"668de5b25320c6f1\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/workspaceRecovery.js\":\"94ec00621dd816d8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/workspaceSnapshotStore.js\":\"aa2ec587755f8b52\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-compiler-runtime.js\":\"a546b43e472acf64\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-client.js\":\"aacea0459fc4b8fd\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-server-edge.js\":\"7452f30cb99acdd8\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-server.js\":\"e185c232e677c408\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-static-edge.js\":\"685b5d233c2a37f1\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-static.js\":\"7905947fffea0f99\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-test-utils.js\":\"4b17484c63cad1e2\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom.js\":\"c42f35e969656aad\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-jsx-runtime.js\":\"545175eab42f6646\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react.js\":\"ae5445af6375b0e7\",\"/knowledge-medium/pr-preview/pr-1827/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1827/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1827/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
