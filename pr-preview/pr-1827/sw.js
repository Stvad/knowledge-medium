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
		buildId: "c6d6d7a54ac1-3857a5d0",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/\":\"92352bf6d32ffbb3\",\"/knowledge-medium/pr-preview/pr-1827/index.html\":\"92352bf6d32ffbb3\",\"/knowledge-medium/pr-preview/pr-1827/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1827/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1827/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1827/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1827/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/pr-preview/pr-1827/assets/FacadeVFS-BJx3qSue.js\":\"e4faefc34ad4450a\",\"/knowledge-medium/pr-preview/pr-1827/assets/OPFSCoopSyncVFS-CSztcgph.js\":\"d8dcabbc9f0a116c\",\"/knowledge-medium/pr-preview/pr-1827/assets/OPFSWriteAheadVFS-BfkTHPB_.js\":\"c3252f3cea6ba914\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-DNbaKFj4.js\":\"832b433367836062\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1827/assets/wa-sqlite-async-Bw-0QdLq.js\":\"650da3f9e67dc548\",\"/knowledge-medium/pr-preview/pr-1827/assets/worker-BnKVn6lq.js\":\"c343a7aef62e9304\",\"/knowledge-medium/pr-preview/pr-1827/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1827/chunks/app-BhUmt56C.js\":\"de0887bd55a69335\",\"/knowledge-medium/pr-preview/pr-1827/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1827/index.js\":\"81727eabdcee1699\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1827/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1827/assets/AccessHandlePoolVFS-DGxTHCVK.js\":\"d342dce131272a43\",\"/knowledge-medium/pr-preview/pr-1827/assets/IDBBatchAtomicVFS-BSnXcsyy.js\":\"60da7224f460233d\",\"/knowledge-medium/pr-preview/pr-1827/assets/MemoryVFS-vr-ei-Lw.js\":\"6f684304e78b6658\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-CCl87bFe.js\":\"10fb1f38f4f68918\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-async-BQc4o316.js\":\"c4f0a3e0cbd30cec\",\"/knowledge-medium/pr-preview/pr-1827/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1827/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1827/chunks/AccessHandlePoolVFS-DbS1gj3-.js\":\"ff75b36bbbb40159\",\"/knowledge-medium/pr-preview/pr-1827/chunks/FacadeVFS-R0VKeXk3.js\":\"316b97d552513f6e\",\"/knowledge-medium/pr-preview/pr-1827/chunks/IDBBatchAtomicVFS-CHGof9OP.js\":\"cdd4513866c5b7e9\",\"/knowledge-medium/pr-preview/pr-1827/chunks/MemoryVFS-D3jX0obp.js\":\"f641ffea919e688f\",\"/knowledge-medium/pr-preview/pr-1827/chunks/OPFSCoopSyncVFS-CkdmcCyz.js\":\"7fc555ff7e779e20\",\"/knowledge-medium/pr-preview/pr-1827/chunks/OPFSWriteAheadVFS-Bnv4yYPD.js\":\"23dff9f6b466bfa9\",\"/knowledge-medium/pr-preview/pr-1827/chunks/Preview-orlBeB-g.js\":\"a2f4485bcc34920d\",\"/knowledge-medium/pr-preview/pr-1827/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1827/chunks/card-Bl30h_Si.js\":\"d2167a2a964293f4\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1827/chunks/dist-CsUBFBPY.js\":\"52c2b86ad429b1ff\",\"/knowledge-medium/pr-preview/pr-1827/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1827/chunks/mc-wa-sqlite-DClNF4lE.js\":\"4dde8e37b0eda770\",\"/knowledge-medium/pr-preview/pr-1827/chunks/mc-wa-sqlite-async-BWLQWMGv.js\":\"a7c1ff5844e3d6fa\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-C1uuBEOk.js\":\"0bafbb44caee18d2\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CHP2LpzS.js\":\"209deb381f796069\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-CxfyaMQq.js\":\"556c5ee561d01dd6\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-D8poxM23.js\":\"709ef1069a4a37a7\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-DqcnJ3vY.js\":\"b0b836f51af92114\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-ObSB3-mz.js\":\"736e0a8c79c01c20\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-SSPz1W6f.js\":\"e87c82ee624e3097\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server-legacy.browser.production-B8Ujn-Cc.js\":\"78dfee152ee89638\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server.browser.production-BNR2zzZP.js\":\"bf3279762732e878\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-dom-server.edge.production-6-wC7_Hi.js\":\"edef2ebc8210b9b4\",\"/knowledge-medium/pr-preview/pr-1827/chunks/react-hS8p6Qo8.js\":\"2fc52c871325ee32\",\"/knowledge-medium/pr-preview/pr-1827/chunks/server.browser-Bn8fmQvQ.js\":\"23410f413c12d1cc\",\"/knowledge-medium/pr-preview/pr-1827/chunks/textarea-B4uXnHnY.js\":\"f3075f2e722f2107\",\"/knowledge-medium/pr-preview/pr-1827/chunks/ui-wX4VqUSw.js\":\"17ad2b30089c8ee5\",\"/knowledge-medium/pr-preview/pr-1827/chunks/wa-sqlite-BFnCwE4u.js\":\"cb7d5e6019e54a0d\",\"/knowledge-medium/pr-preview/pr-1827/chunks/wa-sqlite-async-DnyFY4tg.js\":\"3ffc1601f3e9c7c1\",\"/knowledge-medium/pr-preview/pr-1827/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1827/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/pr-preview/pr-1827/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1827/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1827/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1827/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1827/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1827/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1827/src/App.js\":\"f07eca0d1dfdde97\",\"/knowledge-medium/pr-preview/pr-1827/src/appUpdate.js\":\"132bfac4ba0f82bf\",\"/knowledge-medium/pr-preview/pr-1827/src/appVersion.js\":\"51ebf551401476f0\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/initialLayout.js\":\"e1dd686ac1fa615d\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/openWorkspaceData.js\":\"e5fc1a18e6410e5c\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/resolveWorkspace.js\":\"be66ad20949b9b14\",\"/knowledge-medium/pr-preview/pr-1827/src/bootstrap/workspaceBootstrap.js\":\"da26b9fa00e206f7\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockComponent.js\":\"2177239fb47d8441\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockCrumbs.js\":\"885ba3077e252bef\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockEditor.js\":\"416f306cc272e6ec\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockLoadingPlaceholder.js\":\"6274f6cbd3bcda01\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockProperties.js\":\"f72e61258f587aab\",\"/knowledge-medium/pr-preview/pr-1827/src/components/BlockSearchPicker.js\":\"99171dde4d9b8e42\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ConfirmBulkDeleteDialog.js\":\"0102e356c36fdbfc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/DividerHandle.js\":\"ee28edc2c66459fe\",\"/knowledge-medium/pr-preview/pr-1827/src/components/DraftEditor.js\":\"5dea225f591b1abc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/GutterPill.js\":\"50450e1fc1fb78ed\",\"/knowledge-medium/pr-preview/pr-1827/src/components/Header.js\":\"80781266a15f1544\",\"/knowledge-medium/pr-preview/pr-1827/src/components/LazyBlockComponent.js\":\"2a2ac19ce2a3b4b1\",\"/knowledge-medium/pr-preview/pr-1827/src/components/Login.js\":\"060c80d3df43bf7e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ZoomableSurface.js\":\"1e7c7f7f0294e18e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/editModeKeepalive.js\":\"c0fd7ee9521b82ac\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fcd3ea01b1e6b523\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f7e1988a79553761\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/RefPropertyEditor.js\":\"6a3f486077b2c307\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/RefTargetTypePicker.js\":\"dea5d5363769aa89\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/SelectPropertyEditor.js\":\"d84d8e66a840f000\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/TypesPropertyEditor.js\":\"378eec221d0f1649\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/defaults.js\":\"84cb2b9f699f1887\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/kernelValuePresets.js\":\"7eb813744483e118\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/selectablePresets.js\":\"da110ab4a34ee2a7\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyEditors/typesPropertyUi.js\":\"f7927ee1a933f5cf\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/AddPropertyForm.js\":\"204b45878b8eb96c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/PropertyPicker.js\":\"ccea7bcb02ae9322\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/PropertyRow.js\":\"fba02262adffec6f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/Rows.js\":\"2b4278b7c5e8b481\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/actions.js\":\"ef10e7888b65c22d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/declarationOnly.js\":\"856b8d4480b6a407\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/layout.js\":\"588fb1de90bca2fa\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/model.js\":\"f8de54b5df5b648c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/shapeUi.js\":\"bf9e492301657a62\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/shapes.js\":\"d6e3f3f7c9d62b6c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/usePropertyEditingActivation.js\":\"eed50700591a178d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanel/visibility.js\":\"8f4909dd8600b558\",\"/knowledge-medium/pr-preview/pr-1827/src/components/propertyPanelSections.js\":\"f1eda1d7ebef414b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockEmbed.js\":\"b3411f189026fbe3\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockLink.js\":\"ccb29a837e0b8bf0\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/BlockRef.js\":\"c6183aaa24009f5d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/ReferenceLink.js\":\"a02975cc07358b29\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/cycleGuard.js\":\"2f956f002f8c6dd1\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/cycleGuardContext.js\":\"19adebdf5b4be047\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/linkInteraction.js\":\"18ac27f6e3a5dfb4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/referenceLayout.js\":\"0084ab349b722054\",\"/knowledge-medium/pr-preview/pr-1827/src/components/references/useBlockRefAncestors.js\":\"685acabd3bc8e4bf\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockGutter.js\":\"d1744601aa3c12c6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockInfoDialog.js\":\"49be9beb87c4602c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BlockTypeBlockRenderer.js\":\"487c7429a4963dcc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/BulletHoverCard.js\":\"bb00423ff32a1e5a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/CodeMirrorContentRenderer.js\":\"abaa03cc13f955f4\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f52191853b600a5f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/ColumnResizeHandles.js\":\"a8355e7869bbfe89\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"2f48bbc1a59e9609\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/DefaultBlockRenderer.js\":\"1595d10318584e1e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/LayoutRenderer.js\":\"3f3590266bcac810\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/MarkdownContentRenderer.js\":\"2269a5245aa71f2b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/MissingDataRenderer.js\":\"06a824e77a43ba99\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/PanelRenderer.js\":\"d9bbe76a54689488\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6f2f3055b80ba331\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/TopLevelRenderer.js\":\"841f903e01d1f6aa\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/blockGutterMode.js\":\"924856748814e599\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/blockTitleText.js\":\"92a460886c93ad4d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/fieldCreationKeydown.js\":\"03f41dc389701372\",\"/knowledge-medium/pr-preview/pr-1827/src/components/renderer/layoutRootContext.js\":\"330bc8e9b5a298b8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/typeChip/TypeChip.js\":\"75b1cb707e6074a6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/typeChip/chipStyle.js\":\"24173107484818d5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/anchored-floating.js\":\"1df4613b86651e60\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/button.js\":\"1e45fee7154e1c3f\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/card.js\":\"34d0da6125362e02\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/checkbox.js\":\"e38aaf9074271046\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/collapsible.js\":\"9e6d59dce730f7de\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/command.js\":\"e77da79f9a8b6134\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/context-menu.js\":\"151368a54f186d66\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/dialog.js\":\"e793107c9d973654\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/dropdown-menu.js\":\"58d09f306dba1bc5\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/floating-listbox.js\":\"ec97f1183654283b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/index.js\":\"c25a4d12c6cd973c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/input.js\":\"9b3f8e566361a962\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/kbd.js\":\"068abcae74b24040\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/label.js\":\"9e5cb8cbdf3d71ff\",\"/knowledge-medium/pr-preview/pr-1827/src/components/ui/textarea.js\":\"6cd03e123f23ae86\",\"/knowledge-medium/pr-preview/pr-1827/src/components/useEditModeYieldKeepalive.js\":\"9a9373876a815696\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/BootFallback.js\":\"b87e03ad1724f2d7\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/FocusedRowLazyMount.js\":\"a7355fc645de4f38\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/LazyViewportMount.js\":\"8b45d35ccb5d06dc\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/LocalDbCorruptionFallback.js\":\"aa8c02a22d58bf7a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/error.js\":\"85d234bc4577b56b\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/lazyMountRegistry.js\":\"bc2764154b4872ff\",\"/knowledge-medium/pr-preview/pr-1827/src/components/util/suspense.js\":\"c278e56fcbc7e0c6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/CreateWorkspaceDialog.js\":\"cd9cc31a122478db\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/PendingInvitations.js\":\"4adb631267e400a7\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/SyncProgress.js\":\"1909632f431887e6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/UnlockProgress.js\":\"d01ce79d2dba9b5a\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceKeyGate.js\":\"1cc00dddf6083d1c\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSettingsDialog.js\":\"9028052cb7baac7d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSwitcher.js\":\"5533855f5debf86d\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/WorkspaceSyncGate.js\":\"4935ab0fab5c9a84\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/ConversionFlow.js\":\"4f3843c44149c0f7\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/ConversionFlowHost.js\":\"093662c3465b48a0\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/EncryptionSection.js\":\"d70d59aa5b4f38ba\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/attachmentPrompts.js\":\"aee6e92c7adc5f61\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/bundleFolderPrompts.js\":\"40fab7a80a203dd6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/conversionFlowDeps.js\":\"c71f9426ec85dc95\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/conversionFlowStore.js\":\"39b833899ff470e6\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/flowUi.js\":\"282b145bb2279079\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/conversion/useConversionRun.js\":\"331c4ecd0ef4370e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/keyUi.js\":\"469ac5bcce673b3e\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/useCloseOnKeyLoss.js\":\"4265f46d44ced8a2\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/useCloseOnServerE2ee.js\":\"97811ba824f3fcd8\",\"/knowledge-medium/pr-preview/pr-1827/src/components/workspace/workspaceUnlocked.js\":\"a84c93ad40c07e58\",\"/knowledge-medium/pr-preview/pr-1827/src/context/backgroundSubtree.js\":\"f754186944c1d613\",\"/knowledge-medium/pr-preview/pr-1827/src/context/block.js\":\"e7f11c4a4656ddac\",\"/knowledge-medium/pr-preview/pr-1827/src/context/layoutWsContext.js\":\"0781f51bb6d4a475\",\"/knowledge-medium/pr-preview/pr-1827/src/context/propertyDisplay.js\":\"f2671407e57a1c0e\",\"/knowledge-medium/pr-preview/pr-1827/src/context/repo.js\":\"236833f6593886be\",\"/knowledge-medium/pr-preview/pr-1827/src/data/aliasClaim.js\":\"46df73f4a89d86f0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/aliasSeatNamespace.js\":\"13bc706de7b1fa25\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/blockData.js\":\"0a4eb1091d7bde33\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/blockType.js\":\"d2221514f5114c42\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/changeScope.js\":\"5d8df795dfbc6a77\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/codecs.js\":\"5fb26adceae93f5e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/derivedData.js\":\"6f49b5197452f299\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/errors.js\":\"dc3b0f433f045231\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/events.js\":\"be9028467b2feed2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/handle.js\":\"e1904412a1c88fa3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/index.js\":\"fab9edf336c8fbdc\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/mutator.js\":\"6eae844f0cd30675\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/processor.js\":\"ac46ec61da31f593\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/propertySchema.js\":\"76e15687665f9aad\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/query.js\":\"81b8ad7e54d24052\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/sameTxProcessor.js\":\"b20377520c6dc0dd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/schema.js\":\"e1904412a1c88fa3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/tx.js\":\"e1904412a1c88fa3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/typedBlockQuery.js\":\"74b4cffe547fbbba\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/user.js\":\"86b46e1ad697fc6d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/valuePresetCore.js\":\"d7ba7b5822a364aa\",\"/knowledge-medium/pr-preview/pr-1827/src/data/api/valuePresets.js\":\"cea7f0583cc741db\",\"/knowledge-medium/pr-preview/pr-1827/src/data/attachmentCleanerIOVerb.js\":\"32a25624ef36f57e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/block.js\":\"e7d089be2aa183df\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockCache.js\":\"24fdcee1a203259e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockId.js\":\"7d9ea7f481e1fa49\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockLiveness.js\":\"5cd90f74d5139fbd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockMerge.js\":\"3b27ed13e90d3509\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockSchema.js\":\"0b6b79120217eeb1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/blockTypes.js\":\"85935b770f55572c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/clientContext.js\":\"cab05dca30bad3a2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/dbFileSiblings.js\":\"15115a89c0ae4aa9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/definitionSeeds.js\":\"a318a3c29cfeecc5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/derivedIds.js\":\"3f91ee0248097d09\",\"/knowledge-medium/pr-preview/pr-1827/src/data/drawnSubtree.js\":\"b141840ca899a052\",\"/knowledge-medium/pr-preview/pr-1827/src/data/facetBridge.js\":\"e78f6d9bb878065c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/facets.js\":\"209efad8f1c543e0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/globalState.js\":\"91f0f6fa92d13698\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/aliasClaimRederiveProcessor.js\":\"7f434a45af9abdf4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/ancestorBatch.js\":\"bb1a4fba1170fb43\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/blockTypeTypeifyProcessor.js\":\"a949fcee0bf4bdb0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/clientSchema.js\":\"fc1fd7d7e80e0999\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/commitPipeline.js\":\"a128bffbfe5e3c43\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/devAssertions.js\":\"c38d52922b26c925\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/firstSync.js\":\"142eeaf2cbbec468\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/freshInitialLoad.js\":\"2b8f9fa35b4404e1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/graphBackfillClaim.js\":\"d3638b9fc4dc0e19\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/handleStore.js\":\"bc954c2466345423\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/idleMarkerJobs.js\":\"6ef8974cf774ba0b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/initialDownload.js\":\"0baef39270a4f6e2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/initializeClientDatabase.js\":\"aa9eb8955f244385\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/jsonCanonical.js\":\"1813fb6546f55eb5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelInvalidation.js\":\"fbd14d76dfa3d57f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelProcessors.js\":\"9a4d3e86a00ed30c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/kernelQueries.js\":\"ef7131511582bcae\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/mergeTypeMembershipProcessor.js\":\"1b1b68da81ef96f4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/normalizeReferencesProcessor.js\":\"0d6db84496bb3101\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/poolInstrumentation.js\":\"b945bdc256d0bf7f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/processorRunner.js\":\"4b90168eb8dd4173\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyCellBackfill.js\":\"256fac3e7ba9afcb\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyChildMint.js\":\"0e02a6ce5cb0df9c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyChildrenProcessor.js\":\"ebb1e4e8fcdd7fac\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyDefinitionChangeProcessor.js\":\"01a53b5904b57039\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyDefinitionSynthesis.js\":\"88827d340edc5443\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyKeyScan.js\":\"2ed8990b0d87f872\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertySchemaResolution.js\":\"cef78075dde977a5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/propertyValueEdits.js\":\"d2a818f36887a6a4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/raiseProtocol.js\":\"e86f59339f5edc0e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/readBatch.js\":\"4239ca9d883d1a68\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/refProjection.js\":\"48ef2ba17878ecbf\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/referenceTargetLookups.js\":\"4d8098b8442a753f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/referenceTargetProcessor.js\":\"83255b17717668c0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/replayMerge.js\":\"02f90da6833c7a28\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/sqlBinds.js\":\"e8783302206de29d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"103a5dcd6566ff2b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/arrivalProcessors.js\":\"b4e7734d160d601a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/invalidate.js\":\"6b52dc6471c295db\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/materialize.js\":\"9d9dd9579507f20d\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/observer.js\":\"b426b644377b76a3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/syncObserver/reconcile.js\":\"ac1ec7d215606521\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/timingMetrics.js\":\"f75fbde19ba5b9c4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/treeQueries.js\":\"7f536081c6c63d99\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/txEngine.js\":\"a52737284151b841\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/txSnapshots.js\":\"3a149e21bc48674b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/typedBlockQuery.js\":\"e9486634847b4543\",\"/knowledge-medium/pr-preview/pr-1827/src/data/internals/undoManager.js\":\"b4bfe1961302eb19\",\"/knowledge-medium/pr-preview/pr-1827/src/data/invalidation.js\":\"45ac63d606b77ec8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelDataExtension.js\":\"0b9b784cfe07ad33\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelPage.js\":\"2f6a45f7a689d965\",\"/knowledge-medium/pr-preview/pr-1827/src/data/kernelValuePresetCores.js\":\"003eb32b7cddf3b6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbCorruptionSignal.js\":\"eb885cada45bf1d0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbStorage.js\":\"1afa08ce9f456275\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localDbVfs.js\":\"f1764eb739a0035e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/localSchema.js\":\"2689c38a6fe26a9e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/maintenance.js\":\"0094b160e304eb49\",\"/knowledge-medium/pr-preview/pr-1827/src/data/mergeProperties.js\":\"429d6c85c7f1237c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/metricsConsoleHook.js\":\"2af0b958651e8df6\",\"/knowledge-medium/pr-preview/pr-1827/src/data/migrationsPage.js\":\"3987a23cd9ddd9ea\",\"/knowledge-medium/pr-preview/pr-1827/src/data/mutators.js\":\"53f094c77be6aaf5\",\"/knowledge-medium/pr-preview/pr-1827/src/data/orderKey.js\":\"1d87bf6f1f4d216c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/orderKeyPlacement.js\":\"0dbb24e12df7d5a8\",\"/knowledge-medium/pr-preview/pr-1827/src/data/outlineSurface.js\":\"d6d68a16bf7862a1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pendingEditorContent.js\":\"12aef0bcf6802a25\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pendingUploadsSql.js\":\"020387a27108d8b0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/pluginStateExtensions.js\":\"526f2123729b4fe9\",\"/knowledge-medium/pr-preview/pr-1827/src/data/powerSyncLogger.js\":\"f52a7172fb70bb5a\",\"/knowledge-medium/pr-preview/pr-1827/src/data/projectorRuntime.js\":\"e032ede23ad0b93f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/properties.js\":\"37353ab898b6b381\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertiesPage.js\":\"88db8ebe2eec97dc\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyChildren.js\":\"aba2a20f9f27fcd3\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionFanout.js\":\"6b73ddb1e1b2a0d0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionMetadata.js\":\"1aa0c685c0067577\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDefinitionRegistry.js\":\"ea0fcfddc9960872\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyDisplayMode.js\":\"5cbda1404d7af4df\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertyRowCreation.js\":\"b76e2931a9dfc86c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertySchemaCreation.js\":\"cd7da57457161cfd\",\"/knowledge-medium/pr-preview/pr-1827/src/data/propertySeeds.js\":\"15fdc6067a434adf\",\"/knowledge-medium/pr-preview/pr-1827/src/data/recentsPage.js\":\"e340b984ce5a2c61\",\"/knowledge-medium/pr-preview/pr-1827/src/data/referenceBlock.js\":\"0d24c5d93d5b70c1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/rejectedUploads.js\":\"8c061afa57dd1aa1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/releasePowerSyncConnection.js\":\"c4e69405b7d7f909\",\"/knowledge-medium/pr-preview/pr-1827/src/data/repo.js\":\"5953f7a18dbd1744\",\"/knowledge-medium/pr-preview/pr-1827/src/data/repoProvider.js\":\"dbd3f69dd8420876\",\"/knowledge-medium/pr-preview/pr-1827/src/data/rowProperty.js\":\"db820ed4c672eb9b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/searchFilter.js\":\"1d6dad7b4dc6e95f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/seedIdentityLedger.js\":\"d4489d3765240255\",\"/knowledge-medium/pr-preview/pr-1827/src/data/stateBlocks.js\":\"2e8b549db114cd54\",\"/knowledge-medium/pr-preview/pr-1827/src/data/structuralEditPolicy.js\":\"7c09b57fc5607906\",\"/knowledge-medium/pr-preview/pr-1827/src/data/subtreeDelete.js\":\"40ed211cf458b2d2\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncStreamLock.js\":\"7e986f2388fb40eb\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncedTableSqlRecognizer.js\":\"b372af204391929f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/syncedTableWriteGuard.js\":\"38c2cd80fe403861\",\"/knowledge-medium/pr-preview/pr-1827/src/data/targets.js\":\"b3198587454acf5c\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeColors.js\":\"460cfab230603372\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeDefinitionMetadata.js\":\"ac1eda5fcf405fc0\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeDefinitionRegistry.js\":\"ca9ca92b5a904e39\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeExtraction.js\":\"319a25f2e29aeaaf\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeInitialValues.js\":\"a0d8bb8af9c121c1\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typePropertyGroups.js\":\"cb6f3c5d18f3a734\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeSeeds.js\":\"daa84358d43c2757\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typeTagger.js\":\"dbcab33d3f762c0b\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typedRecords.js\":\"ca2db41da3bd647e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/typesPage.js\":\"95ea74a78c21c336\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userPrefs.js\":\"d8e203256a50e63e\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userSchemasService.js\":\"c283d6b5dbef2006\",\"/knowledge-medium/pr-preview/pr-1827/src/data/userTypesService.js\":\"51d854616d44be9f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/valuePresetRegistry.js\":\"67af992a7e62a817\",\"/knowledge-medium/pr-preview/pr-1827/src/data/visibleChildren.js\":\"20552f9aaaaee5f4\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceConversion.js\":\"44a31263225defbe\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceFirstSync.js\":\"530b6e85ad62674f\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceIdNamespace.js\":\"c17de6d39eeb9e03\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaceSchema.js\":\"e3fc8c2cf8077252\",\"/knowledge-medium/pr-preview/pr-1827/src/data/workspaces.js\":\"29522b59da755644\",\"/knowledge-medium/pr-preview/pr-1827/src/data/writeAheadLog.js\":\"c979d0f4470b0b58\",\"/knowledge-medium/pr-preview/pr-1827/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/BlockPasteShellDecorator.js\":\"8b49f2ee4106dd03\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/atTrigger.js\":\"44634e9d1d3c2379\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/autocomplete.js\":\"8e0bf48c39fe2c71\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/codeMirrorExtensions.js\":\"2493347f888567b3\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/contentFlush.js\":\"9b60102c77a8cf93\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/defaultInteractions.js\":\"0abf80c22735f14b\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/editSettleSignal.js\":\"5baa0714e1be37c8\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/insertImage.js\":\"f107e67092dee155\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/referenceCompletionRange.js\":\"1ff268eb226d2079\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/referenceTargetTypes.js\":\"76063809f83787f2\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/syntaxContext.js\":\"6142d8bfcefb7fdb\",\"/knowledge-medium/pr-preview/pr-1827/src/editor/triggerMatch.js\":\"3b68e158610738a7\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/AppRuntimeProvider.js\":\"ef0972526be47df9\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/BlockFocusShellDecorator.js\":\"c9f45016eb07a95f\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/ExtensionRenderBoundary.js\":\"24e4376f928429b5\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/PanelContentRecovery.js\":\"576c1dbb50c4dd4b\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/apiCatalog.js\":\"d7583149b38745d2\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/approveExtensionHere.js\":\"cbacba02e1de1aab\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/armedCutAppMount.js\":\"328bb97fde50e12b\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/batchableKeyedStore.js\":\"1f5ff5eff5392fd9\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/blockInteraction.js\":\"9663e48b765f3136\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/blockSelectionAction.js\":\"6329204d482bcdce\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/compileExtensionModule.js\":\"29d17bc0d1dcc0b0\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/compiledModuleCache.js\":\"ccc81f166ebeb065\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/continuousGestures.js\":\"c19ca337570e4f67\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/core.js\":\"c94e6eb2c7db7bc0\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/defaultRenderers.js\":\"4ba227fd81bc2ab4\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/definitionFanoutAppMount.js\":\"fc22a12293ec8465\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dialogAppMount.js\":\"3796e035f8662230\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dynamicExtensionSeeds.js\":\"416ee9b5290d8aeb\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/dynamicExtensions.js\":\"8b2a8f61d0201b58\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/exampleExtensions.js\":\"bf436a3dd8f1b783\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionApprovalStatus.js\":\"267a3d4dbdee7485\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLoadErrorToast.js\":\"ce59e037afdd5725\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLoadErrors.js\":\"26d505109bc3fcc9\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionLookup.js\":\"4b5337ba43453943\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionToggles.js\":\"f35f9b4e116d514d\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/extensionUtilitiesCss.js\":\"aebd4fd37c87a138\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/kernelPageDeletionGuard.js\":\"8120a2b75f9fa015\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/liveRuntime.js\":\"186ba2b01ab8b9aa\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/openExtensionsSettings.js\":\"3812abbc28f50cb3\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/overridesCache.js\":\"937dbd5160f4dcb3\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/pluginIds.js\":\"d392c4371dd42e7a\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/processorRejectionToast.js\":\"f717395d7e7aac79\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/runtimeActions.js\":\"88e1d6f61c01e37d\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/runtimeContext.js\":\"27498adf82b10c8d\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/staticAppExtensions.js\":\"7da0d25c8af3f711\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/staticDataExtensions.js\":\"5cb5b52a57553625\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/toastAppMount.js\":\"0109a13ee9649207\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/useOverrides.js\":\"0f90e77b3e7f7e7d\",\"/knowledge-medium/pr-preview/pr-1827/src/extensions/useShortcutSurfaceActivations.js\":\"edd4ff901a803421\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/discoverToggleTree.js\":\"b304cd33b6609d94\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/facet.js\":\"905f3e42d832caa0\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/resolveAppRuntime.js\":\"05fef64590d9aad9\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/runtimeEvents.js\":\"5843765651993514\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/togglable.js\":\"e7edb16d03adb36b\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/variantFacet.js\":\"c7a8bc2735e03d36\",\"/knowledge-medium/pr-preview/pr-1827/src/facets/verbFacet.js\":\"43e810742f8de225\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/block.js\":\"7c72966de5a4bd24\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/focusedChild.js\":\"d9d241bb9d560f66\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/propertySchemas.js\":\"34f77e290042b3d4\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/typeRegistry.js\":\"817df9527a648d8a\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useAncestorCrumbs.js\":\"76aad078f0b57330\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useAutocompleteListbox.js\":\"a17131245b27a1b5\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useDebouncedSearch.js\":\"4a6f186907839ad6\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useDebouncedValue.js\":\"05c4880e2ecbbbc1\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useIsFocalRender.js\":\"2e161644fc3d2e4b\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useIsReadOnly.js\":\"afc7820242724bef\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useMaterializeBacklog.js\":\"10cc86045e35d810\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useMinuteClock.js\":\"b5426821a4eeb0f4\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/usePanelLayoutProjection.js\":\"e5e6b86b1604bc48\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/usePendingInvitations.js\":\"368084d7f09aed2b\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useRendererRegistry.js\":\"ece779d7a08d2949\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useRetainedFieldRows.js\":\"d430dc0a6eb4c439\",\"/knowledge-medium/pr-preview/pr-1827/src/hooks/useWorkspaces.js\":\"27ad1060c0092132\",\"/knowledge-medium/pr-preview/pr-1827/src/lib/utils.js\":\"2d0e746cd59774c0\",\"/knowledge-medium/pr-preview/pr-1827/src/main.js\":\"eba6e9ebce1b09b0\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/MarkdownImage.js\":\"5405713d6fa32d04\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/blockSeparators.js\":\"b40aeffba066cd4a\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/context.js\":\"8c7ac512b140463a\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/defaultMarkdownExtension.js\":\"8ba706798dc30759\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/extensions.js\":\"36adf7328ef5357d\",\"/knowledge-medium/pr-preview/pr-1827/src/markdown/renderMarkdownHtml.js\":\"7bdc5b076e7e26ed\",\"/knowledge-medium/pr-preview/pr-1827/src/minimal-editor.js\":\"2ae487c5639ba2cc\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/armedCut.js\":\"e96219a3e33b54a2\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/captureMediaVerb.js\":\"906bd80013dc3263\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/clipboard.js\":\"b0067e2f549428b3\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/decision.js\":\"465e9e4c5bb7d9ec\",\"/knowledge-medium/pr-preview/pr-1827/src/paste/operations.js\":\"240dd85d18efb54f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/account-header/AccountHeaderItem.js\":\"ee1ce5aa8fd20554\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/account-header/index.js\":\"69a306e3baaad2f0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"781de424d4e4eaee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/askAgent.js\":\"683337401f70e90f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/askedStore.js\":\"3d1de4628873f479\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"202219004928b39a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/chipState.js\":\"91a5fa508013334e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c9bf5635d5a4c22c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/index.js\":\"55f6ba1810fc29d3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"489a92b51a1ac0b0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-dispatch-companion/schema.js\":\"52e3d64d4b6c42dc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/AgentTokensDialog.js\":\"23a138a92b0a5d5e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c59ddbb0286e5e84\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/addMedia.js\":\"1beedbd66dc658b5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/backlinks.js\":\"605bbd730808c06d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/block.js\":\"1200c74c32626cdd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/context.js\":\"7b1c85a0a2950105\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9f4091fc7db3998b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/index.js\":\"ba57636f13b47247\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/outline.js\":\"e818600fcabfa85b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/properties.js\":\"314761d73001dcd8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/refs.js\":\"d9646be8ffc0c7b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8dad193a370c7aa2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/search.js\":\"cc122f5ef675b365\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/shared.js\":\"72f583f406e827d1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ccae15eb46c1f26c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentViews/text.js\":\"793263f60d9134e6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/agentWrites.js\":\"b0e0bae8df6244ef\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/authoringCatalog.js\":\"bc038eea19908778\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/blockRefTargets.js\":\"eb831645e4fc379d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/bridge.js\":\"c8994ebf671d4d8f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/bridgeLoop.js\":\"8fb224f6c1360ded\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/changeHistory.js\":\"6bca47144c9756b6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/commands.js\":\"c0c6a198affa462d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/commentsCommands.js\":\"a279a647364ca169\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/dataExtension.js\":\"b0b882041f2eb960\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/dataModelGuide.js\":\"f54de418a34da80b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/describeRuntime.js\":\"ab1689857261fe6c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/extensionLint.js\":\"4b542f728bb91923\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/grainAudit.js\":\"9668715361f8bec7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/healthCommand.js\":\"0659ba63280b2db8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/index.js\":\"887a01243ab0e520\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/presetIdentity.js\":\"e77701fb3a2a0188\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"73b5639d56e25ac0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/readMedia.js\":\"39ef45e5b8bd4382\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/schema.js\":\"2bfbbec3df73b266\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/serialization.js\":\"7effbdd81c6a0900\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/targets.js\":\"a84890243b5fb928\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/tokens.js\":\"e1db68de5bc92e46\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/watchEvents.js\":\"f2bc6e1884c3bf6a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/workspaceGuard.js\":\"3b6f1a8e8cc6ad5a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/agent-runtime/writeCommands.js\":\"557c8a2f70390823\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/AliasCollisionToast.js\":\"77a9a6375d3da0c8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/DuplicateNameBanner.js\":\"538dab45515d12a3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/collisionMerge.js\":\"70b20c5afa616e08\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/dataExtension.js\":\"8755aae53b3f6ac5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/index.js\":\"df307a786e18bb43\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/mergeCollisionAction.js\":\"c0e824b331a5daa9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/pageStyling.js\":\"9538a12e34bed5dd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/rejectionToast.js\":\"bb3e14f2503b4443\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/alias/syncProcessor.js\":\"b6c25c915de6c9f6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/actions.js\":\"28d05ae6f552c571\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/addComment.js\":\"604ca689071b5368\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/anchor.js\":\"61de65c1f264e972\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/anchorState.js\":\"e697f631ccdd1f23\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/commentLinks.js\":\"b2243489f101fd16\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/confirmThreadDeletion.js\":\"1566e7927eb82344\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/container.js\":\"8ffbf032c32756cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/dataExtension.js\":\"47cb777f3e41cc07\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/deleteComment.js\":\"32de0465a3b682cb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/highlights.js\":\"601da6a1dc80ec9a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/index.js\":\"5140f13325a084a1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/linkedCommentsPill.js\":\"d0ffe2f9333424f9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/margin.js\":\"3607db97c47c8f8d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/marginSchema.js\":\"3cb5588e491173b6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/newComment.js\":\"5e72e6b607874162\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/ownThreadPicker.js\":\"bc8399a12c69235b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/placement.js\":\"43619ea55709721c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/queries.js\":\"d7e0dd26ffc76aee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotePosition.js\":\"c528df56fb51664b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotedIn.js\":\"9d65898c48eec6cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/quotedRange.js\":\"44b775b2bbea694b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/rangeRefs.js\":\"83511714a11a4515\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readHighlights.js\":\"74c7a5a6048f051d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readSelection.js\":\"e9298c2eb528035b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/readSelectionUi.js\":\"2e9fd188c30b876d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/reanchor.js\":\"fe1a8114e44ab847\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/schema.js\":\"57eb079163527a0b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/scope.js\":\"cb4cffbc8ccfd3b6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/scopeThreads.js\":\"f1436c43fbe2f2f6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/splitRetarget.js\":\"3daaf3f86e2185cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/suggestionCard.js\":\"dc1baa433555fddd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/suggestions.js\":\"7ee3a47ff0ff37be\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/summaries.js\":\"ba092d4591135866\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/summaryBatch.js\":\"71663782c8593710\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/surface.js\":\"9942f5248b4000a7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/threadNavigation.js\":\"9a2765930b2ef654\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/threads.js\":\"9bb9f4fde79dfd2b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/ui.js\":\"e886d6725b6f0ef7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/annotations/uiStore.js\":\"de0a03090afed6ae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-intents/appIntents.js\":\"f2c1753195cdcfd9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-intents/index.js\":\"c2ec7e75ebc3c6ae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-update-prompt/index.js\":\"cbdb740d419763de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/app-update-prompt/status.js\":\"03f3d3470dbbebd5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"13b20a87248c2401\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaBlockRenderer.js\":\"86be422b993ca728\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaDownLaneReplicator.js\":\"293172a7fc41af86\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/MediaUploadReconciler.js\":\"ea406c5683a3e398\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetDownLane.js\":\"1d2a890f7756fd75\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetResolver.js\":\"1be5c753fd13b2d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/assetUpload.js\":\"c71eab2b90f4a712\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/attachmentCleanerIO.js\":\"d50d5a31af289ac3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d543075b3a60da04\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/blobStore.js\":\"36ff178c42af9fd2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/byteStore.js\":\"f4347a10c6e54706\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/cleanerIO.js\":\"a24de8bbd7f640cb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/cleanupAttachments.js\":\"3706eed243952e87\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/dataExtension.js\":\"4c24e9b04962471e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/downLane.js\":\"9ff96ce8f0872cf6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/index.js\":\"8bd31ff7e8bac86b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/insertImageContribution.js\":\"1fa12473401187a2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/laneArming.js\":\"5593d1a085c7af11\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/laneLock.js\":\"e728e2a6be5de0d6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaBlock.js\":\"983819fe04ae3351\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaCapture.js\":\"cfd728e22b1bd240\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaViewers.js\":\"aa918af2611438ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/mediaViewersFacet.js\":\"2c67c9754b6ec94e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/pasteCapture.js\":\"6fa8021bce010335\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/resolver.js\":\"3ebfdb03056e6677\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/retryUploadsAction.js\":\"dbadd253165527c8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/storagePaths.js\":\"108172a0f694d242\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadDrain.js\":\"56701296959e511b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadLaneStatus.js\":\"392fcd203118f6b3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadReconcile.js\":\"c4558c83a0bb3511\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadRecovery.js\":\"d60ee89e0f4a53b4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/uploadStore.js\":\"b2cf75f50771f72c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/attachments/useAssetObjectUrl.js\":\"cfc058a3278340d6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b1612abc18b62c66\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d4ef3295f4fff14a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/facet.js\":\"122370e03233713d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/index.js\":\"c9c87a7afbe7586a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks-view/prop.js\":\"fa14943b59a8f175\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BacklinkFilters.js\":\"e0996b17f866ef35\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f41b98755fe8a978\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/BlockEntry.js\":\"cf2bb28893022a52\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/LinkedReferences.js\":\"b26e9d66f9515944\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"f1935f5593693043\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/dailyNoteDefaults.js\":\"893ed1ff7ce35cdc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/dataExtension.js\":\"b5607d497231dd76\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/edgeExclusions.js\":\"05085adf8f480265\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/filterProperty.js\":\"3381f5f9e6cdd9c7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/index.js\":\"51fea1b46389a4ac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e871e726c704b606\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/applies.js\":\"02a19329871bc131\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/countQuery.js\":\"ab49252ab9b00e77\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a226da0615bd3412\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/index.js\":\"6c695c1baf3c8913\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0b6a3e63fa1dc460\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/presentationInvalidation.js\":\"7134ae9745591927\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/propertyEditorOverride.js\":\"8059ff3f0290f588\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/propertyFilter.js\":\"58c43bd6aec9e124\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/query.js\":\"9e87fdea463bb987\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/resolveFilter.js\":\"dbbc23b3cb8adfac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/sourceBatch.js\":\"073c0288bd82de19\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/sources.js\":\"9a1ce883a45ceaee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/useBacklinks.js\":\"60bd7c831b26b2d9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2076a39b170f4ee6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/BirthdayCelebration.js\":\"c9fa02f3032d50fd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/BirthdayOverlay.js\":\"8496e37e2f9dcdae\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/gate.js\":\"d274f04c58d72e90\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/index.js\":\"c5559747e98be92b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/birthday/wolfTheme.js\":\"ff91f541a1505049\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/BlockDragLayer.js\":\"6a5984396b7fd78b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/dragController.js\":\"37dfba51b89fd74b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/dropTarget.js\":\"2032b6dea483ac44\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/index.js\":\"3de02861d772e9a5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-drag/projection.js\":\"e433e4da1a740128\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-info/BlockMetaCard.js\":\"0ea285a466918a76\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-info/index.js\":\"aff26dc2c76bc52a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/AddTagDialog.js\":\"13048e6033b52fc6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"56663b64f8c9e185\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/TagNameIssueHint.js\":\"dfbab69b6f058e58\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/addTagAction.js\":\"4a8cd3438c3723b8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/appendTag.js\":\"d6b53a96d867f7ce\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/config.js\":\"fdd46738c8712b48\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/dataExtension.js\":\"f85158446d3f666f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/index.js\":\"4172fe13d5662f88\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/block-tagging/propertyEditorOverride.js\":\"d8f574652c0af28e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/BreadcrumbList.js\":\"24c167c0476ef95f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a34e1d91f343d925\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f3950a4e12e749af\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0d53a380c727e2a4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"381ffe909507893b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/index.js\":\"c09edc740a277a56\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7d88049a9d06dc8a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/CharacterCountItem.js\":\"2e96e7d2ef257a72\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3677a5b15f66534d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/actions.js\":\"183188fb5b8ec3d9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/blockType.js\":\"db0fa4e3b47192b4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/charCount.js\":\"7ec570fbf0fb00cc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/dataExtension.js\":\"e896a1f464637066\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/index.js\":\"d1617b008334c8f0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/profiles.js\":\"ea53171d04aa5f64\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/properties.js\":\"25772741f7484c71\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/character-counter/textCounts.js\":\"d958dfd778873f9c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/colemak-keybindings/index.js\":\"bc8a60ca2f8064f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/CommandPalette.js\":\"edd525167526153b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/HeaderItem.js\":\"02bd4535938a48f8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/context.js\":\"fd47885f66f4c94a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/index.js\":\"f7e6c3e0fe7112c2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/selection.js\":\"bad0eedd1edd8be5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/toggleStore.js\":\"d9f8d87cf2dd22e6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/command-palette/useCommandPaletteActions.js\":\"33cc2d3f65791a85\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/ContributorBadges.js\":\"360267cfb56219db\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/author.js\":\"a3bf43fb3561d65a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/codeMirrorExtensions.js\":\"4d5cf70b18b7822c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/dataExtension.js\":\"79e8161601144112\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/index.js\":\"11bfa4105614855d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/mentionAutocomplete.js\":\"7b466d6911b409fc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/processor.js\":\"2515b81fb7321632\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/profiles.js\":\"258a6d051603bf0e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/queries.js\":\"e17367f0db3fd6c8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/contributors/schema.js\":\"d59f76dd788c4eea\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1bce731a45b8e332\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/followOrigin.js\":\"1669b378cdc0d8c5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/index.js\":\"7d0a747e29a56494\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b52614325b53abc9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"43100d7603e68809\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/CalendarGrid.js\":\"e9869370d7b5a7ec\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DailyNotePicker.js\":\"fbbe17ada0690722\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"53b0c4e11681afb2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateNavDecorator.js\":\"779dcf47f73a3119\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/DateScrubOverlay.js\":\"733ce7434b67a1c0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/HeaderItem.js\":\"843d432e63c20648\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/ReschedulePicker.js\":\"b7289c9e6868f78e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/SpreadDatesDialog.js\":\"3293b97d4b7558ac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/actions.js\":\"459c2376eed97ffa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/blockDateAdapter.js\":\"57ef8eeae58a277d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/calendar.js\":\"67c37db8cfc21474\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dailyNotes.js\":\"c9327a51e61f027d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dataExtension.js\":\"b5a6370923324342\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubActions.js\":\"017a486482f2518e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubGesture.js\":\"4d31026577335f1e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1bef09f94b871694\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a69a1233c6d2ee5a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/deletionGuard.js\":\"aa890a14fdc4397d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/dueQuery.js\":\"158fc980092d7115\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/index.js\":\"f79bcee7e075bcd6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/landing.js\":\"6a3e4a8bd7740011\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/localSchema.js\":\"80c37920f755575c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/referenceDateAdapter.js\":\"f432db01da28c12f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/rescheduleAction.js\":\"424e3b69df826143\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/schema.js\":\"228f546ced5f0d08\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/spreadBlockDates.js\":\"70cec3da10c1fa8a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/spreadDatesAction.js\":\"4f8e8314ff49c9c6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/today.js\":\"f8026e34a34ad7ff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2ab80bd1e3befeca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"86e1b4c43aec68cc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/audit.js\":\"6bcd97a2bec032ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/auditAction.js\":\"9b70c08eeb8e24d4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/auditRanges.js\":\"437e8f77654bf648\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/diagnosticsSource.js\":\"5101168327876b4a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/divergenceScan.js\":\"d43e5b2b05dabf21\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/index.js\":\"d011528430375c59\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/propertyChildrenChecks.js\":\"bf2f91464b3f66e6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/referencesMirror.js\":\"106632ad1cf54183\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/rowJson.js\":\"49c0220cd4a02636\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/schedule.js\":\"bffe80aa75da75cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/data-integrity/store.js\":\"d0c602a3ff669310\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/action.js\":\"ff1d203e0f9cfef9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/index.js\":\"c610634f42ae4a13\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-maintenance/plugin.js\":\"402da7e525038816\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"939379388d44bcb1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/actions.js\":\"8f68dcad5858daf7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/changeMarker.js\":\"751f27dee6e90056\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/diagnostics.js\":\"68e553bb3f173119\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/fileSystemAccess.js\":\"afbafe71eb0ddf57\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/filenames.js\":\"e1bd9305e0b82837\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/index.js\":\"42b206340643c19f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/mirror.js\":\"af2d684a58933964\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/runLock.js\":\"5073395b452bd4b9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/runtimeHealth.js\":\"2435eab848808008\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/schedule.js\":\"a4c8968e7ead6dcf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/db-mirror/store.js\":\"3fbeab8fdbc7f3b4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/default-themes/index.js\":\"b0010f9b7c7d663b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/default-themes/themes.js\":\"7290edd505ef4feb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/diagnostics/facet.js\":\"0bf25e8e7842dac6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/diagnostics/useDiagnostics.js\":\"5690ecea77468e71\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/dismissals.js\":\"f7c24b938cbf3993\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/index.js\":\"e338c351df0658c5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/status.js\":\"3def02fc4dfd2555\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extension-prompts/store.js\":\"77292832ce1a0e7d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5ad725e497ba3b2e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/ExtensionsSettings.js\":\"dcde45bc3a20f772\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/actions.js\":\"382aaac4a92b2095\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/config.js\":\"3307cc7f3bcb0de2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/dataExtension.js\":\"dcedd4e5ad68aaee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/effect.js\":\"079f4bbc6697f811\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/index.js\":\"91933b0f3eb1fa4f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ec63c5e1fc2efade\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extensions-settings/useToggleTree.js\":\"ac34e38395c77801\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/ExtractTypeDialog.js\":\"ff6f7fef8df1d56e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"34d49356e7c7903f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/PropertyShapePicker.js\":\"42a51babbd84122e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/action.js\":\"06d8b948586378c6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/extract-type/index.js\":\"6fb8a7bd1a2f69ee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/FindReplaceDialog.js\":\"0625b896bcb0321b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/HeaderItem.js\":\"8db8a5c1943ea593\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/dataExtension.js\":\"4f27c4fb763600ef\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/index.js\":\"002ed4f5ed4f9872\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/search.js\":\"2bafd0458249bb47\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/toggleStore.js\":\"286ec4289c0bdb00\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/LocationPropertyEditor.js\":\"e3d1d9503b14490f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/MapView.js\":\"9bca7f02ff6987e5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/blockTypes.js\":\"96a996d0e6187069\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/codeMirrorExtensions.js\":\"3dace805b211965c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/createOrFindPlace.js\":\"2b427da8dd3c5564\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/currentLocation.js\":\"28ed6f591c7d2162\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/dataExtension.js\":\"6b81d52079334e17\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/geoContentDecorator.js\":\"6344e1c71f870360\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/googlePlacesClient.js\":\"33aac8b5b69b2e48\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/index.js\":\"0999f48661ef197f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/locationsPage.js\":\"c971d053aa97dad9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/mapViewport.js\":\"7456d245ac792803\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/pickCurrentLocation.js\":\"47b9e28350758471\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/placeAutocomplete.js\":\"3bee8f394e1ffaf7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/placeNameCollision.js\":\"47c51e496d965ea8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/properties.js\":\"dc08d0624b0a2ac0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/propertyEditorOverrides.js\":\"81f8ddae42d46329\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/query.js\":\"704e9f9435ac90d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/geo/usePlaceSearch.js\":\"1ba103ab57fd47d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"98f447d418bcde71\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"99b01056e0ad7e7f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"517f3e424da8cffe\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/config.js\":\"4ca579950362adf6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/dataExtension.js\":\"d3f9bb75aaca48c0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/facet.js\":\"78b685b73b7999a7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/grouping.js\":\"2babd82677c69cf0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/index.js\":\"2eb53f77bc664a94\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a8b5677274908ed6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/query.js\":\"14790c46fdfb2221\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/resolveConfig.js\":\"769e2b491a041a3c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9edaf6ecbf6104d4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"cef7ae6bb222be7e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/HtmlDocumentContent.js\":\"48055d489d5d6a19\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/HtmlFrame.js\":\"e0eaccab83674363\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/actions.js\":\"4b8c09c0ba3d38e0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/blockType.js\":\"6dd5bd25b25cf717\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/confirmRunScripts.js\":\"85658b191b0af573\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/dataExtension.js\":\"0e785ff7d054e507\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameAnnotations.js\":\"2613bd137b8ba50b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameDocument.js\":\"14736b957889f03a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/frameTheme.js\":\"86294332b51a8c96\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/index.js\":\"34c15da5434edd20\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/scriptConsent.js\":\"d49d4b47f90281a8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/sourceMap.js\":\"acae2cc4ff4aa11c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/html-document/useDocumentScripts.js\":\"78fdf8283348529e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/index.js\":\"8d45bfd1469d7dba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/record.js\":\"3a8150cde30bf82a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/recordStore.js\":\"9dec72ee0d2cbffa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/responsiveness.js\":\"0124b94934732718\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/schedule.js\":\"76636875327b782d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/interaction-metrics/sessionContext.js\":\"55056e96202259bd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5cf9769e08f35056\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d0649f2bf3cc6bf4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/actions.js\":\"5065ad7646081cab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/config.js\":\"c28ba120c1637b56\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/dataExtension.js\":\"2f48fe327738836b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/effect.js\":\"21d08223ee030734\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/index.js\":\"9bc2c362c3264b4a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/keyCapture.js\":\"87059d54f2291300\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/overrideStore.js\":\"11abf52a333eafee\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b134d9fe01fd364b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/HeaderItem.js\":\"8849d9b9454c1847\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/LeftSidebar.js\":\"f0e7dfd6cd7a10df\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/actions.js\":\"616ff1cb53973f54\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/facet.js\":\"ea784e6e41bb561f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/index.js\":\"f254987349c902bf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/shortcuts.js\":\"f81c3be764378fc7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/left-sidebar/toggleStore.js\":\"4c814cd098108736\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/MergePicker.js\":\"d80f2b45eff94ce0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/index.js\":\"769da8c342dec460\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/mergeAction.js\":\"d227f9371a9c619a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/merge-blocks/strategy.js\":\"ba82cfa2ea3be7e3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/Button.js\":\"60a866f2c77e480e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"758c5b751aad2529\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/defaultItems.js\":\"17b056f31876db15\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/facet.js\":\"60951f401a5ffe67\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-bottom-nav/index.js\":\"a152a9d51697ee47\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ea8a803a63f1c289\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/actions.js\":\"30efd34b8a772f59\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"366cfa1c8f46b674\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/facet.js\":\"09b267222161fc4f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/mobile-keyboard-toolbar/index.js\":\"06a6bea7e94066e2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/MoveDestinationPicker.js\":\"979d03c69be68f4d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/blockSubtreeMembership.js\":\"49b30f2edfad4e69\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/contextMenuItem.js\":\"39c7dbc4b280a924\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/index.js\":\"a8d60627d65b9f98\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/moveAction.js\":\"832f973363fdbacf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/moveBlocks.js\":\"e10209d35c277c1b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/move-blocks/selectionAfterMove.js\":\"7ecbb44db152ec27\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/TutorialBanner.js\":\"9d81d7bc1e60a0c8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/action.js\":\"54237570eb089be6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/bannerDismissal.js\":\"18613e6b5eeaf3b5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/documents/cheatSheet.js\":\"d69a2e3e7d1a65ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/index.js\":\"a6f3db658a35264d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/keys.js\":\"ad9d5c0a36661a52\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/landing.js\":\"c1f8af60c607f4f7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/outline.js\":\"9c3bb8df95cc1d3f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/onboarding/seed.js\":\"823dec441b2bbdfc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/PerfTrendDialog.js\":\"93b120286739b055\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/analyze.js\":\"d1e0d409b4c94c51\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/diagnosticsSource.js\":\"9fa6b2e5ac746a95\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/index.js\":\"0a8e283d3215229b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/load.js\":\"65d1db618205da28\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/monitorRun.js\":\"87c58982fc2cea10\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/schedule.js\":\"78bbbd7885735700\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/series.js\":\"09edf1a7eaeb337e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/store.js\":\"936046ac58b47f7d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/trendAction.js\":\"b6afcf213db1b2c1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/perf-monitor/verdict.js\":\"b3da5510fbafaad4\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/clickToEditAction.js\":\"f159ca36ab0ae66d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/index.js\":\"0cf7645f71a64c89\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/plain-outliner/interactions.js\":\"6d42e694b0a9f9ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5996851ff6121e0c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/MigrationGate.js\":\"8a20ec1a7af6f6e8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/MigrationGateDialog.js\":\"4a821d300732311c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/action.js\":\"2d939ea8d6bd8bfb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/index.js\":\"91acf65882b528fd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/localRunMessage.js\":\"df4c118e7758d999\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/plugin.js\":\"9880f25db6aa03f7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/progressReport.js\":\"968148488465d0f3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/properties-migration/sweepProgress.js\":\"2a9d936b57945402\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/FieldRowRenderer.js\":\"d12e8996d645231c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/ValueRowRenderer.js\":\"b252f785c07f5329\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/actions.js\":\"da4fc4c2f9b8e88c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/autocomplete.js\":\"c681313b05a55f89\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/fieldRow.js\":\"e3857165c0e47785\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/index.js\":\"d20e8b6b9c517c37\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/referenceWarning.js\":\"67dd503f69341b36\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/valueAutocomplete.js\":\"8ac82d04d2dc3e5f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/property-rows/valueSchema.js\":\"fda840a846000d48\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/HeaderItem.js\":\"8ba6d71317edfa9b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/QuickFind.js\":\"1da7e18cb99f6379\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/index.js\":\"c59247b0a99ab98e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/recents.js\":\"55296211d41e73cf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/resultItems.js\":\"fdb643fee66b79d9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/selection.js\":\"d4cf14ddbff42fa7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/quick-find/toggleStore.js\":\"474ba2e4038b44c2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/HeaderItem.js\":\"39aead6181a9072c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/RecentsPageBlockRenderer.js\":\"bf2510c883246fef\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/grouping.js\":\"6ceefc2efd3b3f34\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/index.js\":\"6fa84ba1fcd94339\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/recents/target.js\":\"77b96ddc06f78e1a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/codeMirrorExtensions.js\":\"a9d6a77ca4e5f96a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/contentPrefill.js\":\"93338e374555603a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/dataExtension.js\":\"8436cfbe222f0068\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/index.js\":\"fe60b8b5a01f3d76\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"38fd64448c4fa874\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/invalidation.js\":\"efc7932c6652c39d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/localSchema.js\":\"0a6e7ad28d35afe9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/blockrefs/index.js\":\"6e1a703d38da1c3b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"302307c8810d6023\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/index.js\":\"dffb3d57c84e36a0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/referenceNode.js\":\"7f89d4465fce63ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c479602227d741ab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"57b864b84681ecdd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/index.js\":\"8e96c6ff71a4b29f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"de9aad03224a93a3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"794fb5d531b0b6ca\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/mergeRetargetProcessor.js\":\"6bf1eadacc59ef3a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/parseFence.js\":\"a377bf834593190b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referenceParser.js\":\"0362256969970656\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referenceProjection.js\":\"54bc2a7958b956c6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/referencesProcessor.js\":\"d2859c2a41064a50\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/renameProcessor.js\":\"42175535523a8595\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/references/spanReplacement.js\":\"92a0af2b3a71fd8c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/htmlToOutline.js\":\"d438b090258bb07c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/index.js\":\"e55e8157f3c578fb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2dc3ccd088b91fb1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/rich-paste/pasteDecision.js\":\"66730ffc68fccdfd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/action.js\":\"e08e222e5c339b40\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/blockIds.js\":\"1e07920ebffee394\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/content.js\":\"b14d021b9748804d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/effect.js\":\"6f8785d4f61b2e4c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/ids.js\":\"00d59aefcf17d922\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/import.js\":\"5c9da1aecfd68306\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/index.js\":\"f3818eec4a7b2373\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/plan.js\":\"96924ea24c7091b5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/plugin.js\":\"81bd645968dacc48\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/promotion.js\":\"a63ff1e3c88140d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/properties.js\":\"e75e88d8eb709785\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/references.js\":\"4a3f41d1144650cd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/report.js\":\"fc6e414359ef088f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/roamMemo.js\":\"3e7fbb74cb909ec0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/runtime.js\":\"193a20b7a1972e35\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/schemaReconciliation.js\":\"d77cbbfc1ceb5482\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/srsMarkers.js\":\"7b36994d8ff25c8c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/todo.js\":\"ca5e1448d956dcdc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/typeCandidates.js\":\"2799bb5e3e3a2b5e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/roam-import/types.js\":\"bd2db49af83600ba\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/search-health/index.js\":\"f4bca67be69dfdf2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/search-health/store.js\":\"7fdb9fac2a0a9287\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/HeaderItem.js\":\"f5b045044f8596cb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4b0289523653010a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/index.js\":\"537f0a7b6694d625\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/model.js\":\"bc1dbaaa36440038\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/toggleStore.js\":\"e39887f228f4b423\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/shortcut-help/useKeyInspector.js\":\"6c66a6aabd421585\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"bcb2807124a2f602\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/ShellDecorator.js\":\"5bf4a24c305a50e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/actions.js\":\"5a8581fb70f26481\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3381646243bdf7fc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/index.js\":\"42e93192fc58de42\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/shell.js\":\"0ff4e9d565b96dd9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/surface.js\":\"c3716c355c62e4b6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/spatial-navigation/walker.js\":\"11d7ecbce3e1aa93\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/RescheduleToast.js\":\"9102514eb58c41bf\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/dataExtension.js\":\"b4d077e10fca2e6f\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/index.js\":\"e8ae1b29dd03d918\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/indicator.js\":\"ab176ef12bbeec82\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/moveSrsState.js\":\"865461efdef34983\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bd6e42267e608ea5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/scheduler.js\":\"633e79eeb627c486\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/schema.js\":\"b94a84e5857577cc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e6c3a8b99af18c71\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/srsClipboard.js\":\"ea1ae4d1f0335d0d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2980197066997d47\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/DailyNoteReviewHint.js\":\"61d550532ff19c56\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/DeckPicker.js\":\"0178368d3f2b2e16\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewControls.js\":\"dd1ecf32db3e1a2c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d674e44db79dd62b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/ReviewSession.js\":\"25e44f3f02df216c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/actions.js\":\"62451c3f0c3f712e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/archive.js\":\"c0fb24f18b5609f5\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/dataExtension.js\":\"7c53bff13f9f4ff0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/deck.js\":\"14d871e9b1cbb8a1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/dueQuery.js\":\"5fb27b383f6adf34\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/gradeDecision.js\":\"6da4863796ff37ff\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/index.js\":\"3167af74a838e2de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/keyHints.js\":\"5f85f760a30e1082\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/reviewCardLayout.js\":\"cbb7152ca4bc3715\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/reviewProgress.js\":\"8b7ace30737ab08b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/schema.js\":\"e45cf3ab020e729a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/srs-review/useDueCards.js\":\"dcd2c1b853729f04\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/startup-metrics/index.js\":\"05490949380b9a75\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/startup-metrics/record.js\":\"3fabb1a9d2acb70e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/index.js\":\"8de7cff2f691bc6e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/persistenceStatus.js\":\"1da54a29d593fdd3\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/storage-persistence/requestAction.js\":\"8adc628f4275fed1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/TypeChipsDecorator.js\":\"a0bf7a4c5f599cb9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/codeMirrorExtensions.js\":\"fe4bec792b67ed5b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/index.js\":\"6618aac5c05c4f9b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/supertags/typeAutocomplete.js\":\"f331ceec99975c38\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"3812cc3ba4c942fe\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/actions.js\":\"a7dbeac8bea02b03\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/anchor.js\":\"81e44dcb94f98fad\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/events.js\":\"f30f2bff02c3e586\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/gestureActions.js\":\"52b15edeea00809d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/index.js\":\"236a67d61747d028\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"507057ad67a7d93b\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/collect.js\":\"cd72720933730531\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/index.js\":\"9e123c72a70a8234\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/sync-metrics/record.js\":\"a6c7c1b0dc3922a2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/RejectionDialog.js\":\"19abb17d5ca82285\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3dee9b71e349674c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/index.js\":\"d7b5b95bdfd570e6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/model.js\":\"15fb1e44e9921258\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/queueCounts.js\":\"8a768ef24e8dbf9e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/rejectedHelpers.js\":\"aad985a84f095bcd\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/rematerializeAction.js\":\"a763acdc69f416c6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/system-status/useHysteresis.js\":\"cfc6948d9c340cc7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/TableLayout.js\":\"ba32885725b17631\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/actions.js\":\"4f7b2a716980af3e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/cellEdits.js\":\"f2a55514b07f891a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/controller.js\":\"d18ab4f641ad8b13\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/convert.js\":\"7e1d8e6713f23005\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/dataExtension.js\":\"4ba9c80b9d8c0012\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/index.js\":\"800fc9e0b8bf8bb7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/keys.js\":\"27d934ec36c09cac\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/model.js\":\"0706237a407a0cab\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/registry.js\":\"9e2d4c545e298b36\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/tables/schema.js\":\"4ef195d380921b40\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/effect.js\":\"30203814a8552400\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/index.js\":\"2d57563080bea995\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/theme-toggle/theme.js\":\"fa08b33b521953e7\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/actions.js\":\"cfaf38eb19d4f299\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/dataExtension.js\":\"e4b0133b391cabc6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/index.js\":\"a4199df61cf7e4d8\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/todo/schema.js\":\"e72fadbb377c57ec\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/TouchSelectionLayer.js\":\"afb87d5bdba89d77\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/actions.js\":\"7ed0f82205ea9413\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/defaultItems.js\":\"73673b2f84d1e656\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/facet.js\":\"01deba39c6ca94db\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/holdRecognizer.js\":\"10f2d7caa6cef1dc\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/touch-selection/index.js\":\"c2e4a2f3368d7c66\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/UpdateIndicator.js\":\"323c671a37a8c0cb\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/index.js\":\"dbdcc77e774d519c\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/update-indicator/loadTimes.js\":\"8ca7e228ed5847fa\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoNotesRenderer.js\":\"15cbf553ba85da20\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoPlayerRenderer.js\":\"7881da9af2b1cdb0\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/VideoTimeStamp.js\":\"e80c56207903a5d6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/actions.js\":\"788c5c48ca9a372a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/index.js\":\"f4e72f149c0b1510\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/markdown.js\":\"76069f20cbe422e9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/notes.js\":\"5bdaebaae186d045\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/registry.js\":\"91f257167dc4776d\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/remark-timestamps.js\":\"9ca53c286d548ee2\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/video-player/view.js\":\"cb6ba730519346de\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/LinkHints.js\":\"e36a101af4f1593a\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/index.js\":\"972cbc1d9a1a986e\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/model.js\":\"ef5fe5f532e8d430\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-link-hints/settings.js\":\"80c6ac643677cac9\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/actions.js\":\"f30888a9cf2964c6\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/index.js\":\"93a0e04aeb283097\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/vim-normal-mode/interactions.js\":\"8b38e372d99d54e1\",\"/knowledge-medium/pr-preview/pr-1827/src/plugins/workspace-header/index.js\":\"73dec70c847704b0\",\"/knowledge-medium/pr-preview/pr-1827/src/registerServiceWorker.js\":\"c6bac7126e91a710\",\"/knowledge-medium/pr-preview/pr-1827/src/requestPersistentStorage.js\":\"ff05af23b783faf5\",\"/knowledge-medium/pr-preview/pr-1827/src/services/authRequestDeadline.js\":\"ee3de2d5cf775098\",\"/knowledge-medium/pr-preview/pr-1827/src/services/authStorage.js\":\"63aae20404bc43e2\",\"/knowledge-medium/pr-preview/pr-1827/src/services/powersync.js\":\"4edcfd16742f812a\",\"/knowledge-medium/pr-preview/pr-1827/src/services/supabase.js\":\"5df13b2cd8d555e3\",\"/knowledge-medium/pr-preview/pr-1827/src/services/uploadErrorClassifier.js\":\"dac425c747f28123\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/ActiveContexts.js\":\"8ca96ebe716c3045\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/HotkeyReconciler.js\":\"01ae494fe3c9f5c9\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/WipeLocalDataDialog.js\":\"8f6dc700e5bb5f95\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/actionDispatch.js\":\"f7b0454a8381cc89\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/actionRefItems.js\":\"ef44a70ad93c02f8\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/applyKeybindingOverrides.js\":\"cfbabab75c273ba4\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/blockActions.js\":\"7b66613bc6413bce\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/canonicalizeChord.js\":\"db58b0f324cce757\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/defaultContexts.js\":\"d4e0c8bbef3dc289\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/defaultShortcuts.js\":\"22b462debd6bb3d3\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/effectiveActions.js\":\"c51594e6df9ea9b1\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/gestureAction.js\":\"a6ce7e8a7526993e\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/gestureBinding.js\":\"fb8fc44bc5d9ddf2\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/holdRegistry.js\":\"3314dc179f214e6b\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/keybindingConflicts.js\":\"ab4fbba2af2114d6\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/keybindingOverrides.js\":\"f26fd594091809b3\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/pointerAction.js\":\"f7d5a7809778620e\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/resolve.js\":\"e626618f6a63491f\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/runAction.js\":\"88da3fcc1099df26\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/sequenceMatcher.js\":\"48ec7c0752a6bebc\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/types.js\":\"e6f801c9875d86a5\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/useActionContext.js\":\"a84f5c44a0f47fca\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/useActionDiscovery.js\":\"2281e29461dd7080\",\"/knowledge-medium/pr-preview/pr-1827/src/shortcuts/utils.js\":\"994e86df107a680c\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/bootStore.js\":\"83e9975d843520f2\",\"/knowledge-medium/pr-preview/pr-1827/src/sw/previewDatabases.js\":\"a6902a61fac1c3f8\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/byteTransform.js\":\"334a0c302d14f5c9\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/attachmentCleaner.js\":\"667e58744263dd63\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/attachmentParts.js\":\"c087fde8237e32ea\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/bundleParts.js\":\"cfe6acf3fb3be3a2\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/bundleRecord.js\":\"e79d30b3e2f9a63f\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/manifest.js\":\"cfdc51a9e0bb8243\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/takeBundle.js\":\"b2d5d9095a4d41e7\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/bundle/verifyBundle.js\":\"9a94b78827dd9483\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/cleaningStage.js\":\"20aeedd2e60eedf4\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionKey.js\":\"0c9702041d36996f\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/conversionServer.js\":\"6b2cad4507f11ca0\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/flip.js\":\"bf794738bf8c0e1e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/flipAttempts.js\":\"c1ced65282a59e14\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/pages.js\":\"b248e4d5db015ccb\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/preflight.js\":\"db02791c3a0e6990\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/reseal.js\":\"013764037daddda9\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/runConversion.js\":\"912bdba9331de64c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/runLock.js\":\"14e28d94d43f9f12\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/sealing.js\":\"50dbd7182b314427\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/sealingStage.js\":\"8052e05285543898\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/stage.js\":\"44001b5ec1e25557\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/conversion/verifyReseal.js\":\"8b7b2697233b8a46\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/aad.js\":\"1de4410f11613cd2\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/aead.js\":\"d90f95f0a3a941ba\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/base32.js\":\"f6db07634ab42f5e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/base64url.js\":\"773e997a922fb316\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/binaryEnvelope.js\":\"c13b2a7466604e90\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/byteAead.js\":\"c84ff75374c1301e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/canary.js\":\"cc559c090556a2a4\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/contentHash.js\":\"b960ffad5e709f6c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/contentKey.js\":\"2ed00d228b30ef3c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/derivedIdNamespace.js\":\"879c198bea51cf3d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/envelope.js\":\"6bec0d708a627f4d\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/hex.js\":\"bda37c0d887fa644\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/sha256Hex.js\":\"1a2c34ef3c09a83f\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/crypto/workspaceKey.js\":\"58abaa7020cb535f\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/conversionState.js\":\"9c11245000dec1a1\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6c6b6b3a5e04993c\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/pastedKey.js\":\"edcab30bba44bbfe\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"622cad5592be25bd\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f64267ee02f5a65e\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/keyStore.js\":\"9ac398abfe2cef6f\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/mintWorkspaceKey.js\":\"25ac5e4ef7d06fad\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/modePin.js\":\"8ead6ac6dcbe0eef\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/openWorkspaceKeys.js\":\"31e8cb419292eaae\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/resolveWorkspaceEntry.js\":\"bf3118ee4856ef6b\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/resolver.js\":\"9d81ceadb42d37a1\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/keys/workspaceAccess.js\":\"af8cba7b04671614\",\"/knowledge-medium/pr-preview/pr-1827/src/sync/transform.js\":\"67ddbf159b078cae\",\"/knowledge-medium/pr-preview/pr-1827/src/themeBootDefaults.js\":\"ee92da95b4aec882\",\"/knowledge-medium/pr-preview/pr-1827/src/types.js\":\"76f94efbd59f6c87\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/ClientLocalSettings.js\":\"76c320796945d83c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/abortableSleep.js\":\"4009d9e4efe1d46f\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/array.js\":\"cad854f68e547123\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/backlinkAutocomplete.js\":\"6013c548ce244bff\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/blockCrumbs.js\":\"a758257f74fe45c9\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/blockrefAutocomplete.js\":\"1de38ef09e10d5bd\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/cadencedIdleJob.js\":\"d4daa166c14f8af2\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/callbackSet.js\":\"80ca882782f48e77\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/clientId.js\":\"88bfdd8f7914366c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/codemirror.js\":\"e850dec33e58904d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/codemirrorCompletion.js\":\"4e0451275aa961c9\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/copy.js\":\"46eb943e5d27f9ec\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dailyPage.js\":\"30dfcf8605114689\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dbForensics.js\":\"019ca2e5a68bc53e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dbForensicsHooks.js\":\"ff059982f3eabed2\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/deleteBlockThroughUi.js\":\"35d2369dedf82512\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dialogs.js\":\"ccf8d5c8214fe6b9\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/dom.js\":\"b5c9bf1d19119a93\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/downloadBlob.js\":\"72baef074e023deb\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/exportSqliteDb.js\":\"cb8ba4983f7f6c59\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fileSystemAccess.js\":\"ce5a357adaf6dd08\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/flipSlide.js\":\"161678ea0517cb03\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fnv1a.js\":\"7392c8a3cd93dd5e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/formatBytes.js\":\"f2ecccc5bd18f563\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/fuzzyRank.js\":\"604e8bb8e5f5c222\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/idbKeyedStore.js\":\"f30cda57537e6ea8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/idleCallbackPolyfill.js\":\"43d7e4902f672fa3\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/keyboardAwareScroll.js\":\"46c09410bba35796\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/keyboardViewport.js\":\"fe9fc1c527674927\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/lastWorkspace.js\":\"a1a818ae421f5973\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutColumns.js\":\"b4a676df356c40a7\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutSessionDom.js\":\"365cbf0c5f9b2eac\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/layoutSessionId.js\":\"9af2f8276b84e6ce\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/linkClickGestures.js\":\"47fc6f5209732900\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/linkTargetAutocomplete.js\":\"a07526d5d5a6ccc6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/localDbCorruption.js\":\"bbfeadca11d825a8\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/localDbRecovery.js\":\"58e712ea05926c6a\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/markdownParser.js\":\"bd6f599415414738\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/memoize.js\":\"a8218af9d70b3a7e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/nameFieldCommit.js\":\"c58251b2bbf00925\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/nameList.js\":\"377d79f32a028392\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/navigation.js\":\"6ad9e6c66e99f6d4\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/omnilinerNamespace.js\":\"5d3f6859d01a05cc\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/opfsPageScan.js\":\"157b208114286bd0\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelClearance.js\":\"1b33a97b8ef248ba\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelHistory.js\":\"04c659292859a916\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelLanes.js\":\"ed84e9ea9d6f5e9d\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelLayoutProjection.js\":\"c232d05fe85b74a3\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelScrollAnchor.js\":\"828ff9a87b74a34a\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/panelUrlFlags.js\":\"69d041c4524b1d90\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/platform.js\":\"7a830e490c9cfb00\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/pluralize.js\":\"aa74164079c5f601\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyCreation.js\":\"c03cabd64b86d236\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyNavigation.js\":\"f42397ee38cea1bc\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/propertyValueContext.js\":\"2b876d279e1e861b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/react.js\":\"d5ce856d251313ed\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/relativeDate.js\":\"29423423b8f17fcd\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/relativeTime.js\":\"fb7cb1d776f70d3e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/renderScope.js\":\"e3772ea1b17d3bdc\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/resolvedThenable.js\":\"ebbb9d1ae4984f36\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/routing.js\":\"d541c76af605b092\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/safeMode.js\":\"8942c606daa84799\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/scheduleIdle.js\":\"a2ace7846a28d68e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/screenWakeLock.js\":\"4f1235fe26ee5d33\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/selection.js\":\"1b7e8e525d6bc04a\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/softKeyboardGrab.js\":\"3ee7453d87965c5c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/startupTimeline.js\":\"83e09eafba59d575\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/state.js\":\"cdc34126b012737c\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/string.js\":\"493693f36ffc1db3\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/surfaceZoom.js\":\"1d8db3bb22d6a420\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/time.js\":\"cad1325842019b19\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/toast.js\":\"8af7093a8ab571d1\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/toggleStore.js\":\"1eed0413c287c911\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/untilStopped.js\":\"ce67e2302e65d309\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/userActivity.js\":\"2fa0a2a6abf01f04\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/viewTransition.js\":\"d5e18d28b03d4002\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/viewport.js\":\"91acc3d026e99f1b\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/webLock.js\":\"c113656218c8f288\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/workspaceRecovery.js\":\"661ada73847ac11e\",\"/knowledge-medium/pr-preview/pr-1827/src/utils/workspaceSnapshotStore.js\":\"b0a59a0913a7af16\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-compiler-runtime.js\":\"94d46d2e5d9a3896\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-client.js\":\"9c35f508afe0e9a9\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-server-edge.js\":\"aa353f8b03d66d0c\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-server.js\":\"1219f4bcc569a0d1\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-static-edge.js\":\"370022362f4c2e7b\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-static.js\":\"3e83fa817319d3f8\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom-test-utils.js\":\"6ee3c0ca87ed35e0\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-dom.js\":\"3d2927285380c418\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react-jsx-runtime.js\":\"e587794b60160524\",\"/knowledge-medium/pr-preview/pr-1827/src/vendor/react.js\":\"80bc412461d6ff52\",\"/knowledge-medium/pr-preview/pr-1827/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1827/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1827/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
