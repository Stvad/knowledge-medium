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
		buildId: "b458ccacb051-89dd4c47",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/\":\"52714cac632a1732\",\"/knowledge-medium/pr-preview/pr-1827/index.html\":\"52714cac632a1732\",\"/knowledge-medium/pr-preview/pr-1827/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1827/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1827/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1827/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1827/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1827/assets/FacadeVFS-BJx3qSue.js\":\"e4faefc34ad4450a\",\"/knowledge-medium/pr-preview/pr-1827/assets/OPFSCoopSyncVFS-CSztcgph.js\":\"d8dcabbc9f0a116c\",\"/knowledge-medium/pr-preview/pr-1827/assets/OPFSWriteAheadVFS-BfkTHPB_.js\":\"c3252f3cea6ba914\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-DNbaKFj4.js\":\"832b433367836062\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-async-Bw-0QdLq.js\":\"650da3f9e67dc548\",\"/knowledge-medium/pr-preview/pr-1827/assets/worker-BnKVn6lq.js\":\"c343a7aef62e9304\",\"/knowledge-medium/pr-preview/pr-1827/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1827/chunks/app-CCQxzGq5.js\":\"90508b387f6c8be7\",\"/knowledge-medium/pr-preview/pr-1827/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1827/index.js\":\"94646a9537b8015f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1827/assets/AccessHandlePoolVFS-DGxTHCVK.js\":\"d342dce131272a43\",\"/knowledge-medium/pr-preview/pr-1827/assets/IDBBatchAtomicVFS-BSnXcsyy.js\":\"60da7224f460233d\",\"/knowledge-medium/pr-preview/pr-1827/assets/MemoryVFS-vr-ei-Lw.js\":\"6f684304e78b6658\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-CCl87bFe.js\":\"10fb1f38f4f68918\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-async-BQc4o316.js\":\"c4f0a3e0cbd30cec\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1827/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1827/chunks/AccessHandlePoolVFS-7agX8K7S.js\":\"6a92b18b2eaacebd\",\"/knowledge-medium/pr-preview/pr-1827/chunks/FacadeVFS-CH1bsIsJ.js\":\"b791dc005e546f53\",\"/knowledge-medium/pr-preview/pr-1827/chunks/IDBBatchAtomicVFS-CdObJVGR.js\":\"26a37fbf940cdc4e\",\"/knowledge-medium/pr-preview/pr-1827/chunks/MemoryVFS-Cdm4K_1E.js\":\"f4ca76b50f718a42\",\"/knowledge-medium/pr-preview/pr-1827/chunks/OPFSCoopSyncVFS-BrXBwo8V.js\":\"2820e330190a3f6d\",\"/knowledge-medium/pr-preview/pr-1827/chunks/OPFSWriteAheadVFS-BTaN6cgb.js\":\"1363a4c59bae68fa\",\"/knowledge-medium/pr-preview/pr-1827/chunks/Preview-StDnFFtj.js\":\"ba42ec8cc2c6f1d0\",\"/knowledge-medium/pr-preview/pr-1827/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1827/chunks/card-CMNpzzZX.js\":\"fc43266802bbebec\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-C6UcPq1F.js\":\"f2c790e05e4dd2f2\",\"/knowledge-medium/pr-preview/pr-1827/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1827/chunks/mc-wa-sqlite-DClNF4lE.js\":\"4dde8e37b0eda770\",\"/knowledge-medium/pr-preview/pr-1827/chunks/mc-wa-sqlite-async-BWLQWMGv.js\":\"a7c1ff5844e3d6fa\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-ATRRC63b.js\":\"49d09d9bcebe33cb\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CkcVmKNF.js\":\"1a3f4efb22680f3b\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CvHdkH-7.js\":\"faabf7f0168a625a\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CxY6tQHm.js\":\"520233b961c1f106\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-D8sfzPcQ.js\":\"4a42a9e27215d646\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-DwB389RX.js\":\"0bf303b451520947\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-MND_8Mzp.js\":\"0af36a2f2732e13d\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server-legacy.browser.production-BQqTQkSG.js\":\"1c7713c8d3085482\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server.browser.production-QPg46chu.js\":\"b7db6cbf7d0625df\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server.edge.production-CX4ihXla.js\":\"022f2882451aa3d7\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-oUF9af3M.js\":\"6c933c5be7494a3d\",\"/knowledge-medium/pr-preview/pr-1827/chunks/server.browser-csFpyNH0.js\":\"f372d8f5d675bc03\",\"/knowledge-medium/pr-preview/pr-1827/chunks/textarea-Z-PuDro0.js\":\"27ae01dc6cc42f97\",\"/knowledge-medium/pr-preview/pr-1827/chunks/ui--05rRryN.js\":\"3fc8f0ceb3c77846\",\"/knowledge-medium/pr-preview/pr-1827/chunks/wa-sqlite-BFnCwE4u.js\":\"cb7d5e6019e54a0d\",\"/knowledge-medium/pr-preview/pr-1827/chunks/wa-sqlite-async-DnyFY4tg.js\":\"3ffc1601f3e9c7c1\",\"/knowledge-medium/pr-preview/pr-1827/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1827/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1827/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1827/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1827/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1827/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1827/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1827/src/App.js\":\"2edcae4969721daa\",\"/knowledge-medium/pr-preview/pr-1827/src/appUpdate.js\":\"589668a2a7982341\",\"/knowledge-medium/pr-preview/pr-1827/src/appVersion.js\":\"7551daa4ccdd8df9\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/initialLayout.js\":\"e6ed240aad2c7b13\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/openWorkspaceData.js\":\"60736c577f79f9bb\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/resolveWorkspace.js\":\"0ca695bba92b004d\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/workspaceBootstrap.js\":\"3e28aa003803e928\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockComponent.js\":\"72890e21bba2f3bc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockCrumbs.js\":\"c72264c50ce35ce5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockEditor.js\":\"910d53b595404b04\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockLoadingPlaceholder.js\":\"5458216750ef91c4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockProperties.js\":\"fa4229850803552e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockSearchPicker.js\":\"70af962c6372ce21\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ConfirmBulkDeleteDialog.js\":\"e484f54b31364985\",\"/knowledge-medium/pr-preview/pr-1827/src/components/DividerHandle.js\":\"aeb35d7435333589\",\"/knowledge-medium/pr-preview/pr-1827/src/components/DraftEditor.js\":\"b9ff96bcdca23251\",\"/knowledge-medium/pr-preview/pr-1827/src/components/GutterPill.js\":\"d19ed075f1487436\",\"/knowledge-medium/pr-preview/pr-1827/src/components/Header.js\":\"b64b3c3a207164da\",\"/knowledge-medium/pr-preview/pr-1827/src/components/LazyBlockComponent.js\":\"c15eb17732b46fcf\",\"/knowledge-medium/pr-preview/pr-1827/src/components/Login.js\":\"8fc55163390e2e23\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ZoomableSurface.js\":\"52a59b8d1154fd21\",\"/knowledge-medium/pr-preview/pr-1827/src/components/editModeKeepalive.js\":\"b64ece428401378d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyDisplay/PropertyDisplayScope.js\":\"97e7f1f55275c61e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e58e2227e5d09c86\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/RefPropertyEditor.js\":\"ae7bf6edb4e80022\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/RefTargetTypePicker.js\":\"2b6369ec3e9edc27\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/SelectPropertyEditor.js\":\"85206e3cf5c2d37e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/TypesPropertyEditor.js\":\"acc0c7c231f8ad7d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/defaults.js\":\"a9361c6be5514110\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/kernelValuePresets.js\":\"34561b3bffb32213\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/selectablePresets.js\":\"3ae066472322aa13\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/typesPropertyUi.js\":\"b3e0fbbc2f9b6681\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/AddPropertyForm.js\":\"cc3cc3ba73cf1334\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/PropertyPicker.js\":\"41c11cd5dbd2c66c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/PropertyRow.js\":\"f52ee3778579e402\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/Rows.js\":\"631a1e1ae758c0ed\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/actions.js\":\"a32f5a4317f3eb57\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/declarationOnly.js\":\"f4ebe682fa6ffdef\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/layout.js\":\"22b77bbb0b1fce26\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/model.js\":\"acd701af1d37da1a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/shapeUi.js\":\"5290adeccaa28e2d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/shapes.js\":\"a357554b8bb6ab58\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/usePropertyEditingActivation.js\":\"775d553df487a8e0\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/visibility.js\":\"691f1f0fa80e7842\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanelSections.js\":\"87f3ee7511009377\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockEmbed.js\":\"014485f7689a6160\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockLink.js\":\"58df307e70aa12b4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockRef.js\":\"925f53ba3cbfb2bd\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/ReferenceLink.js\":\"8fce214646c0df53\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/cycleGuard.js\":\"c08b546e7198fb8e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/cycleGuardContext.js\":\"79a4069175d1fcdf\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/linkInteraction.js\":\"5bbbf341666b949c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/referenceLayout.js\":\"bb8b2760f909b367\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/useBlockRefAncestors.js\":\"8600178aa7ed2aa4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockGutter.js\":\"8d1ed6df67957bf8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockInfoDialog.js\":\"9c5958d2922f28cc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockTypeBlockRenderer.js\":\"e61b2bdd9e778c04\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BulletHoverCard.js\":\"35544b30a143c8f3\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/CodeMirrorContentRenderer.js\":\"9de8de235adf2f1d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5e4207aaa3d69caf\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/ColumnResizeHandles.js\":\"530aa046cc7846cc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"804cf01ada5f94ae\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/DefaultBlockRenderer.js\":\"36b2e60d9d501fbf\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/LayoutRenderer.js\":\"33fee0c72ac32e29\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/MarkdownContentRenderer.js\":\"d2596a18bd16299e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/MissingDataRenderer.js\":\"d34b0fbe3f5db5a8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/PanelRenderer.js\":\"c7d76cc4d0c3979c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/PropertySchemaBlockRenderer.js\":\"023a6db0602ee898\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/TopLevelRenderer.js\":\"01c5fb07c62f38c0\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/blockGutterMode.js\":\"6240fd76b2f8ad29\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/blockTitleText.js\":\"657e4a2a4fa63b9a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/fieldCreationKeydown.js\":\"b78607e47691fe01\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/layoutRootContext.js\":\"fda9a09efdb3d7c3\",\"/knowledge-medium/pr-preview/pr-1827/src/components/typeChip/TypeChip.js\":\"d2ce97e96e9953c2\",\"/knowledge-medium/pr-preview/pr-1827/src/components/typeChip/chipStyle.js\":\"e28e6ea17c60b629\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/anchored-floating.js\":\"550a68713466e13d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/button.js\":\"b2b7557a717f6dbd\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/card.js\":\"881c8ebc67e17e82\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/checkbox.js\":\"05ef2290ac9b7b91\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/collapsible.js\":\"b413ff7e424069ba\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/command.js\":\"f32cdd646724f676\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/context-menu.js\":\"348351440e2376b3\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/dialog.js\":\"a6111e7075354239\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/dropdown-menu.js\":\"5f0abab9996674fb\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/floating-listbox.js\":\"04159d134e531bc8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/index.js\":\"d5b8ccc2577d7f48\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/input.js\":\"160e6dd4b8f6e47d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/kbd.js\":\"2b3c9132b5dbddc6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/label.js\":\"af2af3432049b756\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/textarea.js\":\"0078b624ca627b46\",\"/knowledge-medium/pr-preview/pr-1827/src/components/useEditModeYieldKeepalive.js\":\"bc15bfd9ea76ed11\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/BootFallback.js\":\"fd5a39b06b6b3b34\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/FocusedRowLazyMount.js\":\"d45d561629b550c6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/LazyViewportMount.js\":\"bb7f0df08f54a509\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/LocalDbCorruptionFallback.js\":\"e1c18eb39bebb291\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/error.js\":\"2c7a6ab03a62a171\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/lazyMountRegistry.js\":\"79a3e34f3fe7272d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/suspense.js\":\"7b2016ae949254fa\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/CreateWorkspaceDialog.js\":\"2dbcc8b2fe24ceb8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/PendingInvitations.js\":\"e6af1791d20c8492\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/SyncProgress.js\":\"30264772cb5d5595\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/UnlockProgress.js\":\"08a948af8ef9ec80\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceKeyGate.js\":\"959db3d0cf07ae2f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSettingsDialog.js\":\"709d80d8c39b9d49\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSwitcher.js\":\"0d5a0a408716aae7\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSyncGate.js\":\"f4ab2055beec8c3a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/ConversionFlow.js\":\"c877b154fa2ae3af\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/ConversionFlowHost.js\":\"abdbec7bc4c2205a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/EncryptionSection.js\":\"f5e50cbc804f8bbe\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/attachmentPrompts.js\":\"503406729e6d0ad9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4f40d2edd7440f8d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/conversionFlowDeps.js\":\"7293fd8ec2eb55a9\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/conversionFlowStore.js\":\"7585196e124dc410\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/flowUi.js\":\"3b9e706de21c2fac\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/useConversionRun.js\":\"d56db105a04f3175\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/keyUi.js\":\"808085e687a49784\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/useCloseOnKeyLoss.js\":\"83a4fec887f7d013\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/useCloseOnServerE2ee.js\":\"369f81bcc52156c8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/workspaceUnlocked.js\":\"c1296120596d891a\",\"/knowledge-medium/pr-preview/pr-1827/src/context/backgroundSubtree.js\":\"c336734a31098276\",\"/knowledge-medium/pr-preview/pr-1827/src/context/block.js\":\"0223cf23286442cd\",\"/knowledge-medium/pr-preview/pr-1827/src/context/layoutWsContext.js\":\"3743a1b43f0fa4c9\",\"/knowledge-medium/pr-preview/pr-1827/src/context/propertyDisplay.js\":\"5d7ad1e8e6bce448\",\"/knowledge-medium/pr-preview/pr-1827/src/context/repo.js\":\"7706dd8d4dfe2c68\",\"/knowledge-medium/pr-preview/pr-1827/src/data/aliasClaim.js\":\"e3fe93d3ee017285\",\"/knowledge-medium/pr-preview/pr-1827/src/data/aliasSeatNamespace.js\":\"11b4520c6c5abedd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/blockData.js\":\"b94aa6e73a5273d9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/blockType.js\":\"55b317488f6085f6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/changeScope.js\":\"a65207cd719685a2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/codecs.js\":\"27f15857c9e207e1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/derivedData.js\":\"fea2c3faf0de4856\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/errors.js\":\"26daceb8ec9f598a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/events.js\":\"9c99a74b77a1d212\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/handle.js\":\"0db6e18f7c9a56f9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/index.js\":\"7472dd15109a20f5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/mutator.js\":\"8577f140e66d4a6a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/processor.js\":\"38ffe2ba0598d5b0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/propertySchema.js\":\"c73fd08ce8fcf295\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/query.js\":\"118affad17f4ec53\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/sameTxProcessor.js\":\"1146096e6ce97150\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/schema.js\":\"0db6e18f7c9a56f9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/tx.js\":\"0db6e18f7c9a56f9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/typedBlockQuery.js\":\"9596f035a2173daa\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/user.js\":\"b3debc98c08ee2f3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/valuePresetCore.js\":\"4a6fbfe11e31ffca\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/valuePresets.js\":\"a1b2c5863eae6145\",\"/knowledge-medium/pr-preview/pr-1827/src/data/attachmentCleanerIOVerb.js\":\"80b05154c8b8313a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/block.js\":\"15db37d003ad4702\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockCache.js\":\"a61a5ea3621fb622\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockId.js\":\"98faf5eabb138298\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockLiveness.js\":\"f0b4125f53d8774b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockMerge.js\":\"a09399bc2ab206b7\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockSchema.js\":\"7023972c7ad33114\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockTypeLookup.js\":\"50d4555a1137bcf6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockTypes.js\":\"be61ba678ae3fb79\",\"/knowledge-medium/pr-preview/pr-1827/src/data/clientContext.js\":\"9081f63bf81aa42c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/dbFileSiblings.js\":\"40c3f96a616a0d6a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/definitionSeeds.js\":\"c6a8f54ef088af72\",\"/knowledge-medium/pr-preview/pr-1827/src/data/derivedIds.js\":\"f7bb5065808dc12b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/drawnSubtree.js\":\"dc86c64fe57e540f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/facetBridge.js\":\"0fe21acc6e90c0d3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/facets.js\":\"566c45b7e99b103f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/globalState.js\":\"b6a56e1e558a409b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/aliasClaimRederiveProcessor.js\":\"6e4d7e570d224ee9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/ancestorBatch.js\":\"6903c67f3ab9dd9b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/blockTypeTypeifyProcessor.js\":\"409b6eaeee54cbf2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/clientSchema.js\":\"948697f5a6ea1964\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/commitPipeline.js\":\"f814414f97198c2f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/devAssertions.js\":\"e4d8288052e885fc\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/firstSync.js\":\"1a41e3fcca12fa03\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/freshInitialLoad.js\":\"1e1665553caf3c73\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/graphBackfillClaim.js\":\"6fd196cec77c4753\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/handleStore.js\":\"94af9b90a86bae9c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/idleMarkerJobs.js\":\"dd8dfb10fe6e0980\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/initialDownload.js\":\"113b7e7e6b33aca4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/initializeClientDatabase.js\":\"b4696dcc1a75f6d9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/jsonCanonical.js\":\"6f3bbdbbcf7d392a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelInvalidation.js\":\"af1bae2dee1b3d51\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelProcessors.js\":\"629e877b3b64186e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelQueries.js\":\"64f06764b35b38fa\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/mergeTypeMembershipProcessor.js\":\"7450f84d9d3e43b9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/normalizeReferencesProcessor.js\":\"d850ee3a73e874b2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/poolInstrumentation.js\":\"684e0db38b65c664\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/processorRunner.js\":\"a3219ea67d64b997\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyCellBackfill.js\":\"20e0dfc75d46a0c9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyChildMint.js\":\"bc1c7236f5d9fb53\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyChildrenProcessor.js\":\"aa5f172b772c2e36\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f25109ca58f9ae62\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyDefinitionSynthesis.js\":\"7f0f30c186afcaa3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyKeyScan.js\":\"912093c535e09443\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertySchemaResolution.js\":\"08130036e036cd53\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyValueEdits.js\":\"f4d39ec53b6a21ac\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/raiseProtocol.js\":\"9fc00de54b0f065c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/readBatch.js\":\"ad41e94ec3a60348\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/refProjection.js\":\"15cc07593bca1ad1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/referenceTargetLookups.js\":\"823e738a67337c05\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/referenceTargetProcessor.js\":\"1dcdbe369f707181\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/replayMerge.js\":\"c3c9fe2fefba1323\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/sqlBinds.js\":\"a139073c0ce1fe6b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"be262225d57a795b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/arrivalProcessors.js\":\"1b33e853f46aa91e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/invalidate.js\":\"5a44815e21d0f924\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/materialize.js\":\"5a14b49cdbd36f71\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/observer.js\":\"763dc8864170a5fa\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/reconcile.js\":\"9e9e174d32a9d519\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/timingMetrics.js\":\"a587c2124928456b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/treeQueries.js\":\"3a5972486b2e0d5d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/txEngine.js\":\"c268afe2bbe32aeb\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/txSnapshots.js\":\"84453e79b9703380\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/typedBlockQuery.js\":\"34f1d7d75644cde6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/undoManager.js\":\"104fb05717e34e81\",\"/knowledge-medium/pr-preview/pr-1827/src/data/invalidation.js\":\"56c412d88f77e1be\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelDataExtension.js\":\"b5aad9acdbf01e95\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelPage.js\":\"d3d3a29318dbcd74\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelValuePresetCores.js\":\"c6a2be6a84f86fa1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbCorruptionSignal.js\":\"cbe261d1734e9be3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbStorage.js\":\"a7f985d40c2bd233\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbVfs.js\":\"e31051abd780836a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localSchema.js\":\"e131ab78dfbfd654\",\"/knowledge-medium/pr-preview/pr-1827/src/data/maintenance.js\":\"37215fb46d1df974\",\"/knowledge-medium/pr-preview/pr-1827/src/data/mergeProperties.js\":\"aeebde4cba2ddbbe\",\"/knowledge-medium/pr-preview/pr-1827/src/data/metricsConsoleHook.js\":\"bb7bb25b425214a3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/migrationsPage.js\":\"7e93a8063b591cff\",\"/knowledge-medium/pr-preview/pr-1827/src/data/mutators.js\":\"84942241bee0f94e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/orderKey.js\":\"1695db8f572e98ee\",\"/knowledge-medium/pr-preview/pr-1827/src/data/orderKeyPlacement.js\":\"2ae495d4d1366192\",\"/knowledge-medium/pr-preview/pr-1827/src/data/outlineSurface.js\":\"40915b3952e9e71e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pendingEditorContent.js\":\"a2a61e5c4a8eb7a4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pendingUploadsSql.js\":\"04cf015131816e74\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pluginStateExtensions.js\":\"051cce90db850bc6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/powerSyncLogger.js\":\"942703fc406cfa71\",\"/knowledge-medium/pr-preview/pr-1827/src/data/projectorRuntime.js\":\"e85de59ba202581c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/properties.js\":\"b5a2e1547957c56b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertiesPage.js\":\"c87c10eb74a8cbe3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyChildren.js\":\"0333b0b7d3e93309\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionFanout.js\":\"f18b828e097cc225\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionMetadata.js\":\"b86a4854cd43c79f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionRegistry.js\":\"7bb758ca02911530\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDisplayMode.js\":\"4185e9d1c88eee7b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyRowCreation.js\":\"f92ba057a0cc4846\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertySchemaCreation.js\":\"8a848a0e484fb257\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertySeeds.js\":\"0b811521a99241b8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/recentsPage.js\":\"2e42167338bff19b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/referenceBlock.js\":\"c1322191275b8206\",\"/knowledge-medium/pr-preview/pr-1827/src/data/rejectedUploads.js\":\"eaebd367d44b24df\",\"/knowledge-medium/pr-preview/pr-1827/src/data/releasePowerSyncConnection.js\":\"733bb8b7af3a82a0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/repo.js\":\"6249fd8824ac8c69\",\"/knowledge-medium/pr-preview/pr-1827/src/data/repoProvider.js\":\"888c69794e2b0ac6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/rowProperty.js\":\"263bfa452602ca2a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/searchFilter.js\":\"cf66240286cb30e9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/seedIdentityLedger.js\":\"ead0c74af8e5e482\",\"/knowledge-medium/pr-preview/pr-1827/src/data/stateBlocks.js\":\"f6d619bf0917a547\",\"/knowledge-medium/pr-preview/pr-1827/src/data/structuralEditPolicy.js\":\"6791ab872741e263\",\"/knowledge-medium/pr-preview/pr-1827/src/data/subtreeDelete.js\":\"b00492a9c7008f48\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncStreamLock.js\":\"a60bb4a453e3686c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncedTableSqlRecognizer.js\":\"1d19fa9b970a28e2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncedTableWriteGuard.js\":\"eaade6916bf6f974\",\"/knowledge-medium/pr-preview/pr-1827/src/data/targets.js\":\"3965a2219bd6b1cd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeColors.js\":\"2df14162fcaa0955\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeDefinitionMetadata.js\":\"9a38b5c02c0e60e8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeDefinitionRegistry.js\":\"0da7e89283509109\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeExtraction.js\":\"59d94a5ff2d66ec1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeInitialValues.js\":\"4126cee0e969e60f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typePropertyGroups.js\":\"6226877c8da0cd03\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeSeeds.js\":\"c274e424e632ebc9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeTagger.js\":\"56feaa7121afb848\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typedRecords.js\":\"e9ae273b04872310\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typesPage.js\":\"25d620327ce761c3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userPrefs.js\":\"f8c3ef8bbf8d6589\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userSchemasService.js\":\"42c663104b0ef3af\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userTypesService.js\":\"ad17547bfade9a27\",\"/knowledge-medium/pr-preview/pr-1827/src/data/valuePresetRegistry.js\":\"94c148e977f5176c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/visibleChildren.js\":\"99c4d2705417cbd6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceConversion.js\":\"7ad896cc1fc4ee99\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceFirstSync.js\":\"961c8bed0d985ad1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceIdNamespace.js\":\"8c02ce7a47525257\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceSchema.js\":\"47a09e90785fd378\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaces.js\":\"f28b6306c09eb38a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/writeAheadLog.js\":\"532b652ae73ae66c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/BlockPasteShellDecorator.js\":\"2943ca9c120f57ac\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/atTrigger.js\":\"512b733e731210eb\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/autocomplete.js\":\"87d15fb8b265e7f1\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/codeMirrorExtensions.js\":\"9b206c60342176f6\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/contentFlush.js\":\"49c0acca5ffe61db\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/defaultInteractions.js\":\"0d66ab658dd86293\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/editSettleSignal.js\":\"5dee12f9288ac134\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/insertImage.js\":\"8068a150fc0ff2cf\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/referenceCompletionRange.js\":\"f447ee55bd0a2c13\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/referenceTargetTypes.js\":\"44a0b62013417b9e\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/syntaxContext.js\":\"8eeb70408947786b\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/triggerMatch.js\":\"d2d6d0285e18d0c9\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/AppRuntimeProvider.js\":\"474be11c23e9f7c3\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/BlockFocusShellDecorator.js\":\"bacb17342653472a\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/ExtensionRenderBoundary.js\":\"abc2e168c1b59694\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/PanelContentRecovery.js\":\"31a9398432e2a6b1\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/apiCatalog.js\":\"5f66acc64940c6b2\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/approveExtensionHere.js\":\"3e5e2f0d74483eff\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/armedCutAppMount.js\":\"3694d44ed0f4c6f7\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/batchableKeyedStore.js\":\"098babe290b8ebdd\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/blockInteraction.js\":\"7beb905fdb4414b3\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/blockSelectionAction.js\":\"c63763d793bc97b8\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/compileExtensionModule.js\":\"d6890d403b895f7a\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/compiledModuleCache.js\":\"e9116a79cafadc72\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/continuousGestures.js\":\"be682fcd9d6efc09\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/core.js\":\"a4bbcb1db953851c\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/defaultRenderers.js\":\"daaff194c434e150\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/definitionFanoutAppMount.js\":\"7472d9516f60cb98\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dialogAppMount.js\":\"fb39686420ac8824\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dynamicExtensionSeeds.js\":\"aef6cab68b9f2df4\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dynamicExtensions.js\":\"82f0e6e71e129c4b\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/exampleExtensions.js\":\"492ff2499f2afc95\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionApprovalStatus.js\":\"fc5caacc9464951f\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLoadErrorToast.js\":\"766ba476de327c40\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLoadErrors.js\":\"b386cb1fcc4699a6\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLookup.js\":\"4261ae7a4bf6dda8\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionToggles.js\":\"9aea13966d862850\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionUtilitiesCss.js\":\"17102e0572aade09\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/kernelPageDeletionGuard.js\":\"871976d4a6200a53\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/liveRuntime.js\":\"1756e12b4d94c739\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/openExtensionsSettings.js\":\"376bddc2798936ea\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/overridesCache.js\":\"fa9a1cac79931cb3\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/pluginIds.js\":\"7b1dd12410e8dccc\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/processorRejectionToast.js\":\"fb628172b4b4a523\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/runtimeActions.js\":\"d0b040cb7802c5c7\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/runtimeContext.js\":\"36dde7c09113c9f5\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/staticAppExtensions.js\":\"d73ece6dd873d0b1\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/staticDataExtensions.js\":\"d821d0bbb26bac78\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/toastAppMount.js\":\"6fd756cd527c74ad\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/useOverrides.js\":\"fe51e9a1bb5d6450\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/useShortcutSurfaceActivations.js\":\"919fb75011102e40\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/discoverToggleTree.js\":\"6abeefba5f23ae8e\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/facet.js\":\"a652dbfda8b16abe\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/resolveAppRuntime.js\":\"9fda1592f29e3da7\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/runtimeEvents.js\":\"b7400cae924760a5\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/togglable.js\":\"4df6c21d4be69d84\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/variantFacet.js\":\"684c89b1a8e40c8a\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/verbFacet.js\":\"31caf8c0b1aca4b9\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/block.js\":\"c6d5ab7546f1fb4b\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/focusedChild.js\":\"c1fbb9cc914cfd25\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/propertySchemas.js\":\"7b66050fe25b3f61\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/typeRegistry.js\":\"12bf7a60b06eb12d\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useAncestorCrumbs.js\":\"51818fc20d88bb07\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useAutocompleteListbox.js\":\"fd8dd2d93d7df59c\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useDebouncedSearch.js\":\"a7472f12b87b0447\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useDebouncedValue.js\":\"186aee066e9f89a2\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useIsFocalRender.js\":\"7b5f27eea2d3cf77\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useIsReadOnly.js\":\"7d63f31e729ea35d\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useMaterializeBacklog.js\":\"872cee321fcbedd3\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useMinuteClock.js\":\"ddd9f55453b14eeb\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/usePanelLayoutProjection.js\":\"5fff4ce51664d876\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/usePendingInvitations.js\":\"e7af10e91e1fbe3a\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useRendererRegistry.js\":\"602e7c8061961ab0\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useRetainedFieldRows.js\":\"f31be39ca66e35f8\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useWorkspaces.js\":\"effbc1fcf2dd51d9\",\"/knowledge-medium/pr-preview/pr-1827/src/lib/utils.js\":\"ad6564205a7a8f71\",\"/knowledge-medium/pr-preview/pr-1827/src/main.js\":\"d06f8a625303bdfd\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/MarkdownImage.js\":\"e08b0e4bb4bda048\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/blockSeparators.js\":\"5b759ada7194924e\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/context.js\":\"aeb4275310b87f42\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/defaultMarkdownExtension.js\":\"773f70ee82243d5f\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/extensions.js\":\"02813130f64aa8e3\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/renderMarkdownHtml.js\":\"b84f07a93e23e5ef\",\"/knowledge-medium/pr-preview/pr-1827/src/minimal-editor.js\":\"a796021363b759a0\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/armedCut.js\":\"cfb237b6e725dace\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/captureMediaVerb.js\":\"f54a473e66a16e6b\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/clipboard.js\":\"da23b0fe74ba6de4\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/decision.js\":\"7f83a890860b64a1\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/operations.js\":\"fc042528d8ad2a27\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/account-header/AccountHeaderItem.js\":\"d4254a68bacec5b6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/account-header/index.js\":\"fedaf65c8cff74a5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f8e29a251cdbff84\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/askAgent.js\":\"933557d2fd9051b4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/askedStore.js\":\"5061d0789347142a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9b9e581b3287907c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/chipState.js\":\"11cf359802963718\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/dataExtension.js\":\"05c8097a34c6a104\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/index.js\":\"d7e2f8b7a1727253\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"2150e2a0a62cc4f6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/schema.js\":\"02847aba7494e617\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/AgentTokensDialog.js\":\"da8e84b44c831359\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9ecd0099178e82de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/addMedia.js\":\"68cc0b610742783f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/backlinks.js\":\"74f290572bf65ff2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/block.js\":\"ab8be433c01bc1a0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/context.js\":\"453f17099151e2c1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a80fd077449e1ab5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/index.js\":\"43947eca0eecd107\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/outline.js\":\"83cb8f40f9e3f377\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/properties.js\":\"4a0be565bf21bf2d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/refs.js\":\"811c3e65394b85cd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"c706dab7e869c99e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/search.js\":\"77598e7304d7f97a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/shared.js\":\"65959b727c6c2c15\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"dfe177af442365b0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/text.js\":\"c0c7bec6c76370b3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentWrites.js\":\"90dac11100016927\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/authoringCatalog.js\":\"33aa44eae1d73f4d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/blockRefTargets.js\":\"c1c0a7b3a0a9ec26\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/bridge.js\":\"f65ab68c6c30da7c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/bridgeLoop.js\":\"7fde919721926138\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/changeHistory.js\":\"79b8a04a3050a72f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/commands.js\":\"693859b336b4ff4d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/commentsCommands.js\":\"6900f171235b89a1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/dataExtension.js\":\"904ab2f700fa6e69\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/dataModelGuide.js\":\"0df30db978e1f70a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/describeRuntime.js\":\"54d0c5f327632cc4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/extensionLint.js\":\"799738f888d878b4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/grainAudit.js\":\"fad214038cc06988\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/healthCommand.js\":\"261ca725469a5f9e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/index.js\":\"22b66f4d9d8176c9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/presetIdentity.js\":\"7e11f045e4f880cc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a3f157fb08cfa327\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/readMedia.js\":\"0157db58fae76574\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/schema.js\":\"70db538ac4d58ac2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/serialization.js\":\"7b326d5a2d5cd837\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/targets.js\":\"904d9564b62d31e5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/tokens.js\":\"3069f4281191dcf0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/watchEvents.js\":\"1b2e35063200cb4a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/workspaceGuard.js\":\"bab0377c423c3731\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/writeCommands.js\":\"8edac42d3ffaafad\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/AliasCollisionToast.js\":\"0cebcd671ded1da7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/DuplicateNameBanner.js\":\"4a432d15ec9c3117\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/collisionMerge.js\":\"0d12dc281ee23089\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/dataExtension.js\":\"7f2db951f749c024\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/index.js\":\"50c502eb82d9f4db\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/mergeCollisionAction.js\":\"b5e61aeaffb3f8d7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/pageStyling.js\":\"21bdb7c99b18b21a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/rejectionToast.js\":\"b03aa0b397e99270\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/syncProcessor.js\":\"3b646a1613732464\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/actions.js\":\"31b16d177672d6bf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/addComment.js\":\"c0de63c13d258378\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/anchor.js\":\"099e18ede1d50da9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/anchorState.js\":\"3193cadc267ff186\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/commentLinks.js\":\"843d49fae7a783f3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/confirmThreadDeletion.js\":\"381c64a221da30d0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/container.js\":\"78b41b594766bd0f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/dataExtension.js\":\"3cc93b64b8037be7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/deleteComment.js\":\"8b37d3b43a8d1f84\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/highlights.js\":\"66f6b9855aacc9d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/index.js\":\"fc239b6be9dd0b94\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/linkedCommentsPill.js\":\"603f90df8a889c22\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/margin.js\":\"e8a70a0c46793bee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/marginSchema.js\":\"8f8f384c0e93f735\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/newComment.js\":\"e70ed47af717995d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/ownThreadPicker.js\":\"bbbe9915db5f0ff8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/placement.js\":\"69374e9be39e8530\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/queries.js\":\"6c303fff3a7a366b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotePosition.js\":\"3e702081a38508e2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotedIn.js\":\"f0a641745cead3b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotedRange.js\":\"5d6660c1f77b6851\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/rangeRefs.js\":\"014173d289037882\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readHighlights.js\":\"d8319372fa0eec4f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readSelection.js\":\"29e6965cce0f3e09\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readSelectionUi.js\":\"84a1193b729bc029\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/reanchor.js\":\"e43cb0d70d7876b8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/schema.js\":\"03495e4a6498f8cc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/scope.js\":\"7a7d78fa620ed271\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/scopeThreads.js\":\"76d28461a1d27ebe\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/splitRetarget.js\":\"9ce596788028d886\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/suggestionCard.js\":\"0b982370d31b510d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/suggestions.js\":\"93727b2f3a9b272c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/summaries.js\":\"3ad7d702909a7701\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/summaryBatch.js\":\"5478ce7c24e9d1f9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/surface.js\":\"778d18365ab3888c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/threadNavigation.js\":\"ad93b6754816e3d9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/threads.js\":\"1ad419602ff77761\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/ui.js\":\"302bc72f75153439\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/uiStore.js\":\"c132dbe0c0d289ab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-intents/appIntents.js\":\"7b250b83fb3fbcf7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-intents/index.js\":\"bdd94eed23c2f765\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-update-prompt/index.js\":\"e84720fb190f6064\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-update-prompt/status.js\":\"90f4630bbfb4eec1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"38ed5b822ca33393\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaBlockRenderer.js\":\"5687351134199085\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaDownLaneReplicator.js\":\"82910e6729c59531\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaUploadReconciler.js\":\"dc980016d13752fc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetDownLane.js\":\"876cf1a759998576\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetResolver.js\":\"b21c8ce6b257d616\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetUpload.js\":\"fec3a6cf7d31c19f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/attachmentCleanerIO.js\":\"5fce7e2a451e7383\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/supabaseAuditIO.js\":\"723452d1dffe0c9d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/blobStore.js\":\"03340867b0dc73dd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/byteStore.js\":\"a6bb51209bd5ca7b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/cleanerIO.js\":\"6452f943453ea206\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/cleanupAttachments.js\":\"accafe570f34e388\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/dataExtension.js\":\"386138ae03483051\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/downLane.js\":\"496aeb39a6406edb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/index.js\":\"2f9ac8513237f516\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/insertImageContribution.js\":\"4d3420caeec21351\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/laneArming.js\":\"dccd58a036b0cecd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/laneLock.js\":\"33026aaadcc08c69\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaBlock.js\":\"a69bc133ffe30a68\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaCapture.js\":\"4d013911c77506ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaViewers.js\":\"6e7d1f9e60ed5484\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaViewersFacet.js\":\"d437837ea47e48fa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/pasteCapture.js\":\"1738fb791e231d7b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/resolver.js\":\"8585ce8b23ce96b8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/retryUploadsAction.js\":\"e8b90fdba82e6dbc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/storagePaths.js\":\"6a581cba02264b5f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadDrain.js\":\"d6f8464b6c0cdd39\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadLaneStatus.js\":\"1081967b6cb27fcd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadReconcile.js\":\"4de4714cfaf3ba80\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadRecovery.js\":\"ea0e0cc3c551eaf7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadStore.js\":\"d61095634cb435e0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/useAssetObjectUrl.js\":\"9ef38bf2743b8078\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5583f494fe03b488\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e03bc81b157f44f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/facet.js\":\"3441e9ace9fba05d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/index.js\":\"d40c790ef6446016\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/prop.js\":\"2c974fd79133588e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BacklinkFilters.js\":\"c5abd958836a48ff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"58926e1c5a05e8ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BlockEntry.js\":\"f7a16cc3bb30e3d5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/LinkedReferences.js\":\"8967975835b5c163\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"51dbe184b8d89278\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/dailyNoteDefaults.js\":\"9a9bde1eaacad82d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/dataExtension.js\":\"98f326387a1fae97\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/edgeExclusions.js\":\"2f9ec0c4eea0b811\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/filterProperty.js\":\"b84e97743d2c7193\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/index.js\":\"a19490c39f76e9f8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0958cca55845f466\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/applies.js\":\"a382567c2ee79fe3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/countQuery.js\":\"b86a36b1e1720876\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/expansionStore.js\":\"53f0325db123cdb1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/index.js\":\"796a5d0cd3dc13e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3d3c0b4de252b1cc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/presentationInvalidation.js\":\"4d22b4c2417383c0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/propertyEditorOverride.js\":\"594fbc6d722920ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/propertyFilter.js\":\"1525d70df3494131\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/query.js\":\"0d80b93e4755794d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/resolveFilter.js\":\"7632e54da3a0ddbd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/sourceBatch.js\":\"aed7ef4630af8d4a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/sources.js\":\"6bbf7c25cb9adb45\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/useBacklinks.js\":\"422c3e2b89488067\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"12a383c6ccf60913\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/BirthdayCelebration.js\":\"1b2fbe593c959a68\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/BirthdayOverlay.js\":\"acf8bdb1c710b513\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/gate.js\":\"744d2c6802d10aa4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/index.js\":\"8345276458c7ae29\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/wolfTheme.js\":\"68bdb6243941f2d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/BlockDragLayer.js\":\"385515b25b5b533a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/dragController.js\":\"4490d7b8e8ab1076\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/dropTarget.js\":\"dba177d0cd54c83a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/index.js\":\"5bf6fa55fd479724\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/projection.js\":\"b9b8058bbf34ce54\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-info/BlockMetaCard.js\":\"9029b01bb90ced31\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-info/index.js\":\"97e6a3425b8d33fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/AddTagDialog.js\":\"43dc78319a38a410\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6bf955e550c587aa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/TagNameIssueHint.js\":\"9330d84d2231a8ad\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/addTagAction.js\":\"7f950ee741d23abb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/appendTag.js\":\"d5ac33216c1b67d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/config.js\":\"7e5391fed8caf9d1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/dataExtension.js\":\"45ec0a94f2e92d5f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/index.js\":\"0e2e50bf3960db44\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/propertyEditorOverride.js\":\"6d643aff7f313f7c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8877d09b42b06eb9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6409e6e88bb99c5b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/Breadcrumbs.js\":\"13d14f79288d5920\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"97a96c29fef6078a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"72d97a10853e06bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/index.js\":\"b111c7cb028df277\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"8a533641cadcacad\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/CharacterCountItem.js\":\"00a1e0556b89ccab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/ProfilePropertyEditor.js\":\"315b0194180f7399\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/actions.js\":\"806dc6bbe077471c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/blockType.js\":\"d1484019ff404c03\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/charCount.js\":\"fabaad320b95c98c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/dataExtension.js\":\"84ec06e7ef09f00a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/index.js\":\"583631177e1957b7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/profiles.js\":\"8621ab2fa8757b40\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/properties.js\":\"fc0eda710a0f84b6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/textCounts.js\":\"749da192e7a5eb53\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/colemak-keybindings/index.js\":\"82b9103746e8753d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/CommandPalette.js\":\"65bc0ce9aeee6bb9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/HeaderItem.js\":\"fc4246ff6b738549\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/context.js\":\"1f484d9baac507c0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/index.js\":\"25fa4106039f4774\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/selection.js\":\"7ada403919e1228c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/toggleStore.js\":\"a43ccf0db6a53777\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/useCommandPaletteActions.js\":\"9797de6176656fca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/ContributorBadges.js\":\"6cbcc25d4d499359\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/author.js\":\"bcda252990b4f100\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/codeMirrorExtensions.js\":\"5e5f8c7f26a43826\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/dataExtension.js\":\"a27035094c066b92\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/index.js\":\"1e2cafc4b420da89\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/mentionAutocomplete.js\":\"0cd7d13f5377da8b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/processor.js\":\"99a9fab3b415a92c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/profiles.js\":\"49e24094e903a085\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/queries.js\":\"6a51e15784524b71\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/schema.js\":\"ee0f68679e083bb9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b5c1526668005c0f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4a0043118fce0a51\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/index.js\":\"2a89eaaedb76b6ac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4cbde29b824d9163\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0883e35b127075f9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/CalendarGrid.js\":\"133f8353dc59dcff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DailyNotePicker.js\":\"51b6638d1a0612bc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"00a2d7a1838fe395\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateNavDecorator.js\":\"8983600e627c79fa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateScrubOverlay.js\":\"e534ab7f14cf9494\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/HeaderItem.js\":\"3d39e1b7b12bf7b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/ReschedulePicker.js\":\"bc3dd0441e2e6a05\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/SpreadDatesDialog.js\":\"da842b1f2b9a60a9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/actions.js\":\"1e6015a6735470c4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/blockDateAdapter.js\":\"3c221ba0029d82b0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/calendar.js\":\"254fe5a8975ede01\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dailyNotes.js\":\"03623fa6bbf60bb4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dataExtension.js\":\"cb987d92736a5b76\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubActions.js\":\"4b089ce87675d8ab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubGesture.js\":\"9b1913dc9aca8d7b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1fd5cd402320d58e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubRecognizer.js\":\"012b09cf463c1295\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/deletionGuard.js\":\"6a67cf20c1e17004\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dueQuery.js\":\"c00d4825fde5434f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/index.js\":\"86113dc9b274caab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/landing.js\":\"2c92b958a6997608\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/localSchema.js\":\"2202949338599626\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/referenceDateAdapter.js\":\"5678932cb7c3b518\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/rescheduleAction.js\":\"94e15c1ef08eb257\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/schema.js\":\"5339a31c2925eb64\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/spreadBlockDates.js\":\"524f727a1c3d4ae4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/spreadDatesAction.js\":\"ecdcdb0212a164a0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/today.js\":\"057038c559e20f45\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"cd91fad5e516c42a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1d276845698b5e62\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/audit.js\":\"4f18a7081cdf3074\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/auditAction.js\":\"cc417e8492a9bb2e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/auditRanges.js\":\"7092de03885a551f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/diagnosticsSource.js\":\"771f2a614aa9cc90\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/divergenceScan.js\":\"4e24a722f95894be\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/index.js\":\"9ad61b4469c06702\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/propertyChildrenChecks.js\":\"eb2abb9adaf38d06\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/referencesMirror.js\":\"b3f3a3981a2a8b77\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/rowJson.js\":\"a40863a31a6833b8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/schedule.js\":\"acf0f059c22b702e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/store.js\":\"839159286a805991\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/action.js\":\"9d53fffc65e8ce98\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/index.js\":\"956f7af0ce4eed98\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/plugin.js\":\"d5421d049e0f0baf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c3f2d79ced82be2c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/actions.js\":\"cb3e8f78f44f223a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/changeMarker.js\":\"9efd94c243d88644\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/diagnostics.js\":\"e557a716bef6e64c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/fileSystemAccess.js\":\"fa7e204d087634d5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/filenames.js\":\"43d005a98673b86c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/index.js\":\"88a172b6fbc4b081\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/mirror.js\":\"be5e8d75215cdfdd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/runLock.js\":\"b98849ad9fb25070\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/runtimeHealth.js\":\"970eb7d7f121b38a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/schedule.js\":\"7cb1371cab75dd65\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/store.js\":\"80aab4183f49301c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/default-themes/index.js\":\"f977dcec8fba7339\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/default-themes/themes.js\":\"0f9d04442d105329\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/diagnostics/facet.js\":\"dcb2509939819c42\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/diagnostics/useDiagnostics.js\":\"e0e506ee7c9514d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/dismissals.js\":\"8f1003162f7c9d45\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/index.js\":\"ccef6b330177bd67\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/status.js\":\"437e160efeb95891\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/store.js\":\"1514243db30e93c9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"18d3bdc7da7e4aa3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0a81316e91cf698a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/actions.js\":\"5392b0359965b312\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/config.js\":\"4d88c9e13f7ccfa7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/dataExtension.js\":\"6b504be0ecb745bb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/effect.js\":\"1c690bbee57e8023\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/index.js\":\"05830c5209dd63c5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/propertyEditorOverride.js\":\"c5c83aaf09e6c1dc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/useToggleTree.js\":\"cb0cf2fb675727d9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/ExtractTypeDialog.js\":\"743ba3ed39de1f5f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"58eaa4af22865e6e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/PropertyShapePicker.js\":\"4da8391084da18f9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/action.js\":\"413be1c9d832d8a3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/index.js\":\"9738a14326fa8727\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/FindReplaceDialog.js\":\"b37c1bd70af8f680\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/HeaderItem.js\":\"89ab5e87b1fa8487\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/dataExtension.js\":\"b5427a40ae899ac7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/index.js\":\"cbd159a0203ed004\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/search.js\":\"be0b8c70c3fcfa07\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/toggleStore.js\":\"8a1c7c81ddd4eb51\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/LocationPropertyEditor.js\":\"448b32df4eebb0eb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/MapView.js\":\"c9b34bf7de98c583\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/blockTypes.js\":\"1049cc0dd6d611c4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/codeMirrorExtensions.js\":\"7f358af5283011cd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/createOrFindPlace.js\":\"c8600a65e634a4f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/currentLocation.js\":\"f0a859ceb2c437e6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/dataExtension.js\":\"57a50a6359b795a9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/geoContentDecorator.js\":\"83bec071918f3ba2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/googlePlacesClient.js\":\"28b2c6359718d6e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/index.js\":\"050bc44729d88583\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/locationsPage.js\":\"4281ec5366f5fd45\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/mapViewport.js\":\"ac8d7976d0e5ce0a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/pickCurrentLocation.js\":\"15dd1b58180bde23\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/placeAutocomplete.js\":\"57753688cf91abfe\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/placeNameCollision.js\":\"d39fd4f9756a84ad\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/properties.js\":\"9ddc3beee2ec8392\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/propertyEditorOverrides.js\":\"6935a2cf8fd49bb7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/query.js\":\"158f053861361f01\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/usePlaceSearch.js\":\"60c0f3734c24b77c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a5fb644db977f7b2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"f65620a87d532d8f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"2961049a451294a0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/config.js\":\"5cb9a8b6538fd244\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/dataExtension.js\":\"a2d8be4cb23a87c5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/facet.js\":\"d87b0d7b6a3faa9c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/grouping.js\":\"cb2c49f913886a29\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/index.js\":\"8756be0ef793bc0f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"36d1bc4e2c3383be\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/query.js\":\"d494758f20ab309d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/resolveConfig.js\":\"90659d05928440a2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f735f3db9ceff299\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9e4728afe74f05e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/HtmlDocumentContent.js\":\"915310a206351bfc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/HtmlFrame.js\":\"ea1c4aabd71c665a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/actions.js\":\"2a3516cc2585bb6f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/blockType.js\":\"c2e514e1cdb98d30\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/confirmRunScripts.js\":\"348a4df593f39d9b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/dataExtension.js\":\"b710227e8ba1d084\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameAnnotations.js\":\"84c455ee99c2754d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameDocument.js\":\"c32527199d5fbd11\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameTheme.js\":\"1163fe5e0c0a0867\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/index.js\":\"f24019f619d222a5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/scriptConsent.js\":\"b45dfa620199d871\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/sourceMap.js\":\"dde9c14045e3692a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/useDocumentScripts.js\":\"3328273ec113f72d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/index.js\":\"671687a40ae744d1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/record.js\":\"4aa7e9c665438a0e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/recordStore.js\":\"0709120aaa4f2472\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/responsiveness.js\":\"839b9c6553e8a6ad\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/schedule.js\":\"4ab1543429e6fd90\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/sessionContext.js\":\"b2fa535f94cd8ece\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2fdd2dac2558e688\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"06e4659f2e0c87de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/actions.js\":\"390c23fec94150aa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/config.js\":\"9641c471b4911099\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/dataExtension.js\":\"bd5ed3b9b2498447\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/effect.js\":\"2a77e726803e68eb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/index.js\":\"de0b4c6326572c3c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/keyCapture.js\":\"2a73735e18482292\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/overrideStore.js\":\"7103cdad891050de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ec8ee909b1dc924e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/HeaderItem.js\":\"9a11d8f9cda180cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/LeftSidebar.js\":\"2c4d78ad87358b32\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/actions.js\":\"faf647fccc93d17a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/facet.js\":\"a0c2b85189b80b04\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/index.js\":\"370b0e73cf7c77f7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/shortcuts.js\":\"3beb444431e223b4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/toggleStore.js\":\"8684a8194f9258de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/MergePicker.js\":\"9f5c65726b6a0e5e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/index.js\":\"89a31af1850fdec0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/mergeAction.js\":\"a2b4188c68f87827\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/strategy.js\":\"36269d07bb019e58\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/Button.js\":\"71c6eab1faacab75\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"081b498e7051d7a9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/defaultItems.js\":\"770cb55184ce1a79\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/facet.js\":\"787492c605943aef\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/index.js\":\"2f2aa3eb0f753407\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"946f2d85621665ad\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/actions.js\":\"3d1ea7df39c132ac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0049f11ccee1c05f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a36c857bbac4863f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/index.js\":\"b7898b570b31f46e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f01326352fd1ea09\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b284b8b7130ab3b5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/contextMenuItem.js\":\"f0989d229be6319d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/index.js\":\"8988ba974b178f24\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/moveAction.js\":\"fc2203c90fb8d4e7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/moveBlocks.js\":\"565484fb5832d530\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/selectionAfterMove.js\":\"042636f9772e002c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/TutorialBanner.js\":\"af5e87197fb5468f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/action.js\":\"ec91e74420eb26f7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/bannerDismissal.js\":\"96307df7a6354bca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/documents/cheatSheet.js\":\"c065301f48336b61\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/index.js\":\"f50d1db5fbdbd78a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/keys.js\":\"be9c99ccf6784e55\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/landing.js\":\"a79991e55cf3738d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/outline.js\":\"548560a85d8d22d9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/seed.js\":\"aef3ebe1832642fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/PerfTrendDialog.js\":\"bcc8dc7475f6799d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/analyze.js\":\"f971ce0c4bf26f03\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/diagnosticsSource.js\":\"21cf1ba54d916f84\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/index.js\":\"37a6a060a10ca809\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/load.js\":\"166f1b2bc7cea497\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/monitorRun.js\":\"6f90dac02e91bce7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/schedule.js\":\"66862b79b6170388\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/series.js\":\"1e2d6b16b9f41a33\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/store.js\":\"7ff7e52b7ecbddd9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/trendAction.js\":\"2ab8c91ce4fe6a9a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/verdict.js\":\"629616042eaf2782\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/clickToEditAction.js\":\"9a5fe8f8860c4c64\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/index.js\":\"2b2d07da0550faa7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/interactions.js\":\"0d080ab3ee28bf78\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"71bd53736cbc2163\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/MigrationGate.js\":\"204f2781a5b76b87\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/MigrationGateDialog.js\":\"9f7787c99044c983\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/action.js\":\"a4512cba78090f83\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/index.js\":\"50fa45cb1653f437\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/localRunMessage.js\":\"6450a2b93a60cac0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/plugin.js\":\"9e9bf9aae25914df\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/progressReport.js\":\"a81f98078e2a5673\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/sweepProgress.js\":\"f56ab83b85c3fac1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/FieldRowRenderer.js\":\"78f6e77527d13353\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/ValueRowRenderer.js\":\"f5a7400eecced4fd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/actions.js\":\"2e4cfa78134c0cfd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/autocomplete.js\":\"c727227217132bfe\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/fieldRow.js\":\"b6e7312cf4303251\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/index.js\":\"07c4f68e5e515c30\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/referenceWarning.js\":\"7031e6fcdaaebcbc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/valueAutocomplete.js\":\"7d01a0c7a0b7fd74\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/valueSchema.js\":\"a8bc95f310b049f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/HeaderItem.js\":\"68d1ded9c4d34b3f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/QuickFind.js\":\"8e57c74e8c27d342\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/index.js\":\"77e942256f41900d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/recents.js\":\"1684db763b3af812\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/resultItems.js\":\"cbc3653a163fa3cc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/selection.js\":\"b52ed90250abd0bb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/toggleStore.js\":\"6bbf599eb72415ae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/HeaderItem.js\":\"d1457c79783c6e9a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/RecentsPageBlockRenderer.js\":\"3e651ae6b9f17b72\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/grouping.js\":\"597cd368f28e6701\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/index.js\":\"655e0e01ec3ae78d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/target.js\":\"259a2ccad3ce44a2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/codeMirrorExtensions.js\":\"0fe0d6af5a42fd4f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/contentPrefill.js\":\"6a5aea038e997299\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/dataExtension.js\":\"1ed62352fdb7a5a1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/index.js\":\"2b24d0f4476348c2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"3821ff1cd99e2f29\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/invalidation.js\":\"f55a5453db613d6c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/localSchema.js\":\"7cbd908b7896c04b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/blockrefs/index.js\":\"a13797771eba14d4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1e7e8aab29fb2f9c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/index.js\":\"b5a90c9239d52f7b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/referenceNode.js\":\"773536060c3ff1a4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8cddf99ca5525f45\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5f01a730de5d79ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/index.js\":\"21ecf09472d2151a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ca46a887be6c489f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"934cc45925b3c7bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/mergeRetargetProcessor.js\":\"0bf7e3487438ee32\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/parseFence.js\":\"34638819ba53f2a5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referenceParser.js\":\"46b60cbbde3e8e60\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referenceProjection.js\":\"8ec4273f69ad2000\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referencesProcessor.js\":\"8b265c89284ff7ab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/renameProcessor.js\":\"4e34dacb530dbd54\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/spanReplacement.js\":\"b989949da610ceb2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/htmlToOutline.js\":\"9c5c25a43b0962e9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/index.js\":\"62a5c04d044ba443\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1192ae6d04e11527\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/pasteDecision.js\":\"cd427d21e7918613\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/action.js\":\"a3067b3b3ba26bc5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/blockIds.js\":\"517aa6655c76b121\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/content.js\":\"4c1cfdfe89fad5f9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/effect.js\":\"f4ae47f41e0cce7d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/ids.js\":\"fef35156537111c1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/import.js\":\"6a47f95fa000986c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/index.js\":\"26fca9ed7babbbef\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/plan.js\":\"64b21d9284289c52\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/plugin.js\":\"8f1cd2077605a786\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/promotion.js\":\"f6aa29455ba5a3c3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/properties.js\":\"cfbc973957fcfd3a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/references.js\":\"12239693024bdbf4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/report.js\":\"889046f84a85f5ed\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/roamMemo.js\":\"a0d611006d9e5096\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/runtime.js\":\"5bb2af4258a0a5a1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/schemaReconciliation.js\":\"6b44f81473a46778\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/srsMarkers.js\":\"d06bfcd25b9dbdec\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/todo.js\":\"8df27753fc58e93b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/typeCandidates.js\":\"81123e7091bb25fd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/types.js\":\"f6a37f8d750a7174\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/search-health/index.js\":\"ebac120616a1950f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/search-health/store.js\":\"c26de721719ae3e2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/HeaderItem.js\":\"64ca8a47d82ff3ac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0bd630b006e47070\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/index.js\":\"df175db5eb2f13e2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/model.js\":\"f745a919cb528c52\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/toggleStore.js\":\"0998772d9d0545ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/useKeyInspector.js\":\"deee89019302e571\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e3251734281ad8ea\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/ShellDecorator.js\":\"8065fb699e7df43d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/actions.js\":\"36f009827d53a9c7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e7d9b51d56cf9fea\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/index.js\":\"acb58214d920b4bf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/shell.js\":\"59b99aac055e9bb0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/surface.js\":\"1d733c2211392109\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/walker.js\":\"1e9f712b87c5edac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/RescheduleToast.js\":\"291a289d01220730\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/dataExtension.js\":\"ff9a4a319f980ec0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/index.js\":\"b8431b2289e05386\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/indicator.js\":\"5efb3351415c2a8e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/moveSrsState.js\":\"f86bb9b2136bf0f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f11a268b8737fa11\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/scheduler.js\":\"0099616ea830c578\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/schema.js\":\"403d460e8e38926d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"5a02e5a8427380c4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/srsClipboard.js\":\"76718f0d4c1819e0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"76e39a85f05231b3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/DailyNoteReviewHint.js\":\"88338da20fa315ec\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/DeckPicker.js\":\"960df98a34425115\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewControls.js\":\"926f08f7b42898b4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0e5d4fc4bc63990d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewSession.js\":\"d20f93d1e2390f4d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/actions.js\":\"cfcbef4978b4568f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/archive.js\":\"119ae668a0804ee8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/dataExtension.js\":\"b309d94efa6301d9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/deck.js\":\"bf269b6b0d2d3d20\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/dueQuery.js\":\"e3070186a0e9dd82\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/gradeDecision.js\":\"2b721f053066c92f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/index.js\":\"1bea557877260eff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/keyHints.js\":\"62b60c0d30fb7d9f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/reviewCardLayout.js\":\"e82b49fea78a44ff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/reviewProgress.js\":\"190ebddc2027ec70\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/schema.js\":\"c6e15485ddd4ee2b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/useDueCards.js\":\"706b73abda194fa9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/startup-metrics/index.js\":\"0bfabaafe54c412c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/startup-metrics/record.js\":\"8c3f8683b74ffd61\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/index.js\":\"f0c88edada76eb49\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/persistenceStatus.js\":\"af836f6dac8f91ee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/requestAction.js\":\"7b60ccb144d96494\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/TypeChipsDecorator.js\":\"65da5d99759e3d3c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/codeMirrorExtensions.js\":\"fc69f7665a5f5101\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/index.js\":\"e9d4aa25b78378c3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/typeAutocomplete.js\":\"f972f0c445e51589\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"804ce4c7fa72f596\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/actions.js\":\"4d8102d06f83e2cd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/anchor.js\":\"4dfbd4c7b5588e8a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/events.js\":\"f89c7b0316d5cb59\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/gestureActions.js\":\"551c63411efb39fd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/index.js\":\"8e7b398579b14ef9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1b3748ce2b24df0e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/collect.js\":\"d9157a12cb0b07cb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/index.js\":\"acff49a804a4df52\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/record.js\":\"ae602e764404fd62\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/RejectionDialog.js\":\"21edcf72bc84f43e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ef31820d8021e81a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/index.js\":\"b3cb2be165856bbb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/model.js\":\"03faa707af54cf7c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/queueCounts.js\":\"c4db00c7cc735f2e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/rejectedHelpers.js\":\"99a36f573aa5e400\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/rematerializeAction.js\":\"c6691d500b657aaf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/useHysteresis.js\":\"d03b3deb6d678f4e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/ColumnHeaders.js\":\"68ce58df07fffda2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/TableLayout.js\":\"3d78c70434e78ce9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/actions.js\":\"c0728ea9d29d1319\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/cellEdits.js\":\"465adbff0bbde3f8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/columns.js\":\"0fd85f56cf659080\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/controller.js\":\"6b4cd55e69086406\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/convert.js\":\"51c87cafac5717d5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/dataExtension.js\":\"f84fd4c17ee25cee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/index.js\":\"b4f9d3bdfe2b04ce\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/keys.js\":\"7c2257e2acda37d0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/model.js\":\"ac3b19323c13eb5d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/registry.js\":\"a026057d0e2b620b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/schema.js\":\"5170181c227397ab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/effect.js\":\"ebb14ce3a639cba7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/index.js\":\"50b02331e06cddd5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/theme.js\":\"d10d3cd58c1673ae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/actions.js\":\"86adf41ba69d67df\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/dataExtension.js\":\"7e814b7d85217008\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/index.js\":\"1e18e6285349f183\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/schema.js\":\"8f3ea2c25a0c0592\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/TouchSelectionLayer.js\":\"576af7dbce4fec68\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/actions.js\":\"c4594ca857518fb7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/defaultItems.js\":\"3ffc0eb19d69935f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/facet.js\":\"476d4cacf680ebce\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/holdRecognizer.js\":\"908288da25dcb077\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/index.js\":\"d4b378f225227bd5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/UpdateIndicator.js\":\"4cbcd6dcd101bd60\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/index.js\":\"92434d3e0596a26d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/loadTimes.js\":\"899a541a017ecd79\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoNotesRenderer.js\":\"492f32973ef71982\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoPlayerRenderer.js\":\"0e7871dd75ddc93d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoTimeStamp.js\":\"0b97732f5eb01cf5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/actions.js\":\"63dbb80876ffaa65\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/index.js\":\"eeb5889715787352\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/markdown.js\":\"bed6b60179cf32c6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/notes.js\":\"66749705d57a616e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/registry.js\":\"b4e101326823a4b1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/remark-timestamps.js\":\"dc7be93939133817\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/view.js\":\"532974d947046a3a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/LinkHints.js\":\"1fdc366c85f82a74\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/index.js\":\"42d5fe425611573d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/model.js\":\"c261547a399fa1b8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/settings.js\":\"0d5948bf1199d964\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/actions.js\":\"5de7a3b0f9190394\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/index.js\":\"ede80c6bc5fefd09\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/interactions.js\":\"a67ddf245ab4245b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/workspace-header/index.js\":\"e1bc2a09d9ed59a5\",\"/knowledge-medium/pr-preview/pr-1827/src/registerServiceWorker.js\":\"ab468e90d6ae196f\",\"/knowledge-medium/pr-preview/pr-1827/src/requestPersistentStorage.js\":\"63da4fd97683cb2d\",\"/knowledge-medium/pr-preview/pr-1827/src/services/authRequestDeadline.js\":\"20c827a0fe60ffad\",\"/knowledge-medium/pr-preview/pr-1827/src/services/authStorage.js\":\"7701338f18f42dfa\",\"/knowledge-medium/pr-preview/pr-1827/src/services/powersync.js\":\"69f9c57f198aadb0\",\"/knowledge-medium/pr-preview/pr-1827/src/services/supabase.js\":\"0af7206d882d49a9\",\"/knowledge-medium/pr-preview/pr-1827/src/services/uploadErrorClassifier.js\":\"5240b0c1658a154a\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/ActiveContexts.js\":\"e09d4dfb23eb91d2\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/HotkeyReconciler.js\":\"3f17552cafd2533e\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/WipeLocalDataDialog.js\":\"2b585e3249b07135\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/actionDispatch.js\":\"d641d9ca5e386638\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/actionRefItems.js\":\"1b09ac84da0b4e28\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/applyKeybindingOverrides.js\":\"b4ffd3c846598677\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/blockActions.js\":\"075c7d8506f27017\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/canonicalizeChord.js\":\"1191afa23b4bd408\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/defaultContexts.js\":\"17e2606097fbc97b\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/defaultShortcuts.js\":\"edd15274a9edabb4\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/effectiveActions.js\":\"d4a2a73e06d12b35\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/gestureAction.js\":\"639764e8751f21ed\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/gestureBinding.js\":\"25104850b83c6c2d\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/holdRegistry.js\":\"2d7849b8fdcd9a46\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/keybindingConflicts.js\":\"e20dc62d64237534\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/keybindingOverrides.js\":\"8190b7471c15f3e6\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/pointerAction.js\":\"44539022d0571ea0\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/resolve.js\":\"8e73256eeea189c2\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/runAction.js\":\"28d3e435d3c5f86b\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/sequenceMatcher.js\":\"e1dec8f0711939c5\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/types.js\":\"1b79630540e1b4c1\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/useActionContext.js\":\"066390d8585ccff9\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/useActionDiscovery.js\":\"f30510c38ed220f9\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/utils.js\":\"b8fd69880c337c8b\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/bootStore.js\":\"8d0afb80b280ddbb\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/previewDatabases.js\":\"460d1adac3d44ef6\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/byteTransform.js\":\"da6f26ccc19a902d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/attachmentCleaner.js\":\"30c2b75f7bdad329\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/attachmentParts.js\":\"d4e1c91caee16bd5\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/bundleParts.js\":\"0624218f036689e8\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/bundleRecord.js\":\"3ada6e89168966ed\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/manifest.js\":\"32c362182f0c242a\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/takeBundle.js\":\"3cde9402f5f8cbbb\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/verifyBundle.js\":\"2b6248165cefccf1\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/cleaningStage.js\":\"6afa5528aa6fd360\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionKey.js\":\"16bd57778fcf85cd\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionServer.js\":\"0a16709ccc229c58\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/flip.js\":\"b35154b4301120f9\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/flipAttempts.js\":\"949f93dfe2b26b11\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/pages.js\":\"cd6cb9f189d6ee3a\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/preflight.js\":\"7c1a62475c4d7a79\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/reseal.js\":\"ac1cd571494ea659\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/runConversion.js\":\"03cbd8e244879d6d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/runLock.js\":\"edad5fca1ebb10b3\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/sealing.js\":\"8df9a6e6abd60745\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/sealingStage.js\":\"df75ae12b8c93737\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/stage.js\":\"ffd20193b706a48d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/verifyReseal.js\":\"53dae3eb5c26af21\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/aad.js\":\"3e9f917d0a535d7e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/aead.js\":\"e96e101ecbb0353b\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/base32.js\":\"c7b94dc372bbf538\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/base64url.js\":\"0da8eda1c63aa0c4\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/binaryEnvelope.js\":\"57297018267cd2aa\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/byteAead.js\":\"823f88aa02adc1b4\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/canary.js\":\"d09fa2d7bac157e1\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/contentHash.js\":\"b13850abf1579ea9\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/contentKey.js\":\"74b72cf01b5c2c79\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/derivedIdNamespace.js\":\"b51b5c7c7cfdb862\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/envelope.js\":\"1c8ea772af8c11dc\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/hex.js\":\"de45c0d61c97e884\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/sha256Hex.js\":\"28811b33f16d3a92\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/workspaceKey.js\":\"2382e68ad1bd4b40\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/conversionState.js\":\"88361beba90eaad1\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/createEncryptedWorkspace.js\":\"46ba24dd6c06c1fb\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/pastedKey.js\":\"621f681dac683b70\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bb6378bf1409289c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ad17696a19aea176\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/keyStore.js\":\"7f4d5ff930fcfebd\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/mintWorkspaceKey.js\":\"dcb207d1bc352b11\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/modePin.js\":\"c2b6fb6dbc5baa3b\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/openWorkspaceKeys.js\":\"e02161507be73ca9\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/resolveWorkspaceEntry.js\":\"4b157c4215719469\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/resolver.js\":\"5a0cf9551b3e574d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/workspaceAccess.js\":\"cda5156b82dbfd60\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/transform.js\":\"06e8b4bb751e1621\",\"/knowledge-medium/pr-preview/pr-1827/src/themeBootDefaults.js\":\"6a6ce5a79ebb1444\",\"/knowledge-medium/pr-preview/pr-1827/src/types.js\":\"9fa4d64eb63d141e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/ClientLocalSettings.js\":\"68560a0b7482d2a8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/abortableSleep.js\":\"9ef19a891b991377\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/array.js\":\"5819e07db40ec0b6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/backlinkAutocomplete.js\":\"94764d08f25abc04\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/blockCrumbs.js\":\"2f176355545ae8cc\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/blockrefAutocomplete.js\":\"0f7574e5313a3a2e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/cadencedIdleJob.js\":\"a807128f05a90caa\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/callbackSet.js\":\"97933bf00201c8ea\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/clientId.js\":\"a53741ed479ca467\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/codemirror.js\":\"4820a8cd2f424cf7\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/codemirrorCompletion.js\":\"1892007053df6f7a\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/copy.js\":\"feb4a1a5a67fb602\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dailyPage.js\":\"e8a34633e40f7520\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dbForensics.js\":\"0c77816217951f4c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dbForensicsHooks.js\":\"3978759b93f51dad\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/deleteBlockThroughUi.js\":\"4391c241dab23dc3\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dialogs.js\":\"2380a1b913959820\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dom.js\":\"6da054ec6e26dc35\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/downloadBlob.js\":\"6cd1fe6782f89411\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/exportSqliteDb.js\":\"5d5f6411f5a7cac2\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fileSystemAccess.js\":\"ad13561f5d6327c1\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/flipSlide.js\":\"effa0857326a90c6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fnv1a.js\":\"afa619aa2a45b300\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/formatBytes.js\":\"e542af3dea9bc0e6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fuzzyRank.js\":\"cfaed4105719fa6f\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/idbKeyedStore.js\":\"850a2a10869db5ef\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/idleCallbackPolyfill.js\":\"ceda0e2e3aaa1f21\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/keyboardAwareScroll.js\":\"7fb267b0ee7a80c4\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/keyboardViewport.js\":\"d061ce14e4b901ad\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/lastWorkspace.js\":\"9bd000c8a27d8145\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutColumns.js\":\"3c2d41060d8f9042\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutSessionDom.js\":\"4762f79a9b1bfa14\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutSessionId.js\":\"1bd33328686f8d48\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/linkClickGestures.js\":\"18adf687a888d9bd\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/linkTargetAutocomplete.js\":\"e2351eef5fe29423\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/localDbCorruption.js\":\"21dc2ea0c1c75cd7\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/localDbRecovery.js\":\"af1fb348757a2b41\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/markdownParser.js\":\"7188d73f53ae05c4\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/memoize.js\":\"3895fae313b38ff9\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/nameFieldCommit.js\":\"0da21144646c719b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/nameList.js\":\"8bc9e703cde58379\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/navigation.js\":\"73bbab99e7d13161\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/omnilinerNamespace.js\":\"08f304f2dab4c61d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/opfsPageScan.js\":\"c1deb0926b11120c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelClearance.js\":\"2c4b0321d80ea12b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelHistory.js\":\"1286d8a914686f76\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelLanes.js\":\"9f6554a549f5f967\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelLayoutProjection.js\":\"3c0a938bdc1c009d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelScrollAnchor.js\":\"36cafba18fda8dbf\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelUrlFlags.js\":\"e7cab675047563fa\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/platform.js\":\"44f86615b88b1bb8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/pluralize.js\":\"0f7c49aee68e5711\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyCreation.js\":\"62498119a6e10618\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyNavigation.js\":\"cf7b845dab10f726\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyValueContext.js\":\"074ec49f723f78ec\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/react.js\":\"d44e9bc659501a96\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/relativeDate.js\":\"94df24f4ae03403f\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/relativeTime.js\":\"b8c3e13e7e66f323\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/renderScope.js\":\"db5a4c46328f97dd\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/resolvedThenable.js\":\"67fb233bd3d3e547\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/routing.js\":\"38b10096ed1ad1a6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/safeMode.js\":\"ef96a029ef8c9d70\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/scheduleIdle.js\":\"72a4bb5efa88d8db\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/screenWakeLock.js\":\"7161a97388b3cffb\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/selection.js\":\"1a980e4f94968175\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/softKeyboardGrab.js\":\"d05fe16d51ff17a2\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/startupTimeline.js\":\"09f1ceee453bbcec\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/state.js\":\"309c99f7a945515f\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/string.js\":\"06653998fcd40cf2\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/surfaceZoom.js\":\"cd443db4ac4acb23\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/time.js\":\"3b22d07ad6c514e1\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/toast.js\":\"f1015e58f80ff609\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/toggleStore.js\":\"2e4d8c8dd9e499aa\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/untilStopped.js\":\"6b541c53711b1171\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/userActivity.js\":\"cc4ba8f838b368c1\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/viewTransition.js\":\"0638da31d8b13ed7\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/viewport.js\":\"1668b477204cd7c4\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/webLock.js\":\"75b95811441f6e89\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/workspaceRecovery.js\":\"0b2ea01a8b2e3c55\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/workspaceSnapshotStore.js\":\"41e59f20b16109d6\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-compiler-runtime.js\":\"6c59bda3f849baa3\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-client.js\":\"554fd260ec15c5f9\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-server-edge.js\":\"95fe45ccef4c2fb0\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-server.js\":\"92bd257cff2c2bfb\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-static-edge.js\":\"39d2b9898e5c3d74\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-static.js\":\"0f5dab00b948fe75\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-test-utils.js\":\"4e34de601d4b622d\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom.js\":\"dcc39e3c02b3b7f5\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-jsx-runtime.js\":\"831f39b815601115\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react.js\":\"18b7d57ac18cb181\",\"/knowledge-medium/pr-preview/pr-1827/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1827/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1827/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
