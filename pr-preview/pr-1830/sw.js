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
		buildId: "fed309c5fd06-8988ef0a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1830/\":\"3b7fd009f9020972\",\"/knowledge-medium/pr-preview/pr-1830/index.html\":\"3b7fd009f9020972\",\"/knowledge-medium/pr-preview/pr-1830/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1830/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1830/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1830/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1830/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1830/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1830/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1830/assets/FacadeVFS-lXAdo3mj.js\":\"8f47ab05b48196be\",\"/knowledge-medium/pr-preview/pr-1830/assets/OPFSCoopSyncVFS-k_pqLFUx.js\":\"8c12a91281dc5c6b\",\"/knowledge-medium/pr-preview/pr-1830/assets/OPFSWriteAheadVFS-1W68GdY1.js\":\"4e715c778e8e69c8\",\"/knowledge-medium/pr-preview/pr-1830/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1830/assets/wa-sqlite-XeQHwO4S.js\":\"4b379a3aa3f6ee31\",\"/knowledge-medium/pr-preview/pr-1830/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1830/assets/wa-sqlite-async-DyRRJ1OS.js\":\"df4f84609c5aeb02\",\"/knowledge-medium/pr-preview/pr-1830/assets/worker-Cu_pE7Tt.js\":\"f687f445d275d748\",\"/knowledge-medium/pr-preview/pr-1830/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1830/chunks/app-73APFI-e.js\":\"700a8f2592c7b2f0\",\"/knowledge-medium/pr-preview/pr-1830/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1830/index.js\":\"c3fba673c12df350\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1830/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1830/assets/AccessHandlePoolVFS-D4_29QoR.js\":\"db415b83e89e53a2\",\"/knowledge-medium/pr-preview/pr-1830/assets/IDBBatchAtomicVFS-CSdkyuOh.js\":\"05218ed38bed125b\",\"/knowledge-medium/pr-preview/pr-1830/assets/MemoryVFS-Bi4VOFWq.js\":\"efa0107f13f0340f\",\"/knowledge-medium/pr-preview/pr-1830/assets/mc-wa-sqlite-B9Jwm51W.js\":\"31258118db1063f1\",\"/knowledge-medium/pr-preview/pr-1830/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1830/assets/mc-wa-sqlite-async-DT0Jup25.js\":\"e2024ddf8f58b9fd\",\"/knowledge-medium/pr-preview/pr-1830/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1830/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1830/chunks/AccessHandlePoolVFS-QhroZC7V.js\":\"960241a8b36a8d28\",\"/knowledge-medium/pr-preview/pr-1830/chunks/FacadeVFS-CAJn4meE.js\":\"49a6d43ef036f946\",\"/knowledge-medium/pr-preview/pr-1830/chunks/IDBBatchAtomicVFS-BUtU3mG5.js\":\"f5c7f15576f5ac5a\",\"/knowledge-medium/pr-preview/pr-1830/chunks/MemoryVFS-DvedIWTV.js\":\"345d2ed55ab9d604\",\"/knowledge-medium/pr-preview/pr-1830/chunks/OPFSCoopSyncVFS-iEC4Aaui.js\":\"bf6e919a914d1eef\",\"/knowledge-medium/pr-preview/pr-1830/chunks/OPFSWriteAheadVFS-CB2sJOY9.js\":\"d46655bae324361a\",\"/knowledge-medium/pr-preview/pr-1830/chunks/Preview-D6SX8Y4b.js\":\"01cc125b2c43b845\",\"/knowledge-medium/pr-preview/pr-1830/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1830/chunks/card-C6zHJ67_.js\":\"896f612c4287e76e\",\"/knowledge-medium/pr-preview/pr-1830/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1830/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1830/chunks/dist-BlTE7fD-.js\":\"7fb612f1c660534a\",\"/knowledge-medium/pr-preview/pr-1830/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1830/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1830/chunks/mc-wa-sqlite-BIUSPnHF.js\":\"8622e535cea3535b\",\"/knowledge-medium/pr-preview/pr-1830/chunks/mc-wa-sqlite-async-BkpVEvqj.js\":\"793d6951c811870e\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-Ct5uMDk3.js\":\"8070253d478f1c35\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-DdUd33c6.js\":\"db63babc562c7d08\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-DkXjSQol.js\":\"0867bcf7478bfdd1\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-Dp1Z9Cm5.js\":\"0e50da6646e67dc1\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-DqJTif97.js\":\"44c3fa03aef453c8\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-FpEbXy8l.js\":\"b3c82c8645ae192e\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-aW6gFwJO.js\":\"76255e86ae86f87d\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-dom-server-legacy.browser.production-BoZo9uR7.js\":\"91a054281940e17b\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-dom-server.browser.production-GMJvb95t.js\":\"b215aa8df74c6bff\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-dom-server.edge.production-CoOdo7Vu.js\":\"349f7755838cf290\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-umo7k_3K.js\":\"f46a3d608e48a077\",\"/knowledge-medium/pr-preview/pr-1830/chunks/server.browser-DhRLuwaa.js\":\"7478a380c6fe1d56\",\"/knowledge-medium/pr-preview/pr-1830/chunks/textarea-Bu2-X-W3.js\":\"b5a2de43a79b01dd\",\"/knowledge-medium/pr-preview/pr-1830/chunks/ui-Da_uYeyX.js\":\"a45e789c98a6a56f\",\"/knowledge-medium/pr-preview/pr-1830/chunks/wa-sqlite-CWQQ97lK.js\":\"d73857693c584e1b\",\"/knowledge-medium/pr-preview/pr-1830/chunks/wa-sqlite-async-CPeLtpFW.js\":\"338e0ad8b7c4edef\",\"/knowledge-medium/pr-preview/pr-1830/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1830/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1830/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1830/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1830/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1830/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1830/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1830/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1830/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1830/src/App.js\":\"58b254010db29729\",\"/knowledge-medium/pr-preview/pr-1830/src/appUpdate.js\":\"9795897666d96a7f\",\"/knowledge-medium/pr-preview/pr-1830/src/appVersion.js\":\"96db45e28593c0d8\",\"/knowledge-medium/pr-preview/pr-1830/src/bootstrap/initialLayout.js\":\"b85a3b29283e2a7b\",\"/knowledge-medium/pr-preview/pr-1830/src/bootstrap/openWorkspaceData.js\":\"f99e29dd797d0ffc\",\"/knowledge-medium/pr-preview/pr-1830/src/bootstrap/resolveWorkspace.js\":\"b49b25f1cc68336a\",\"/knowledge-medium/pr-preview/pr-1830/src/bootstrap/workspaceBootstrap.js\":\"35ebebfec1308f09\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockComponent.js\":\"a96af27f0c768601\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockCrumbs.js\":\"a248ff9825d8c7c8\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockEditor.js\":\"f9c191e57e4b9115\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockLoadingPlaceholder.js\":\"562aa3f540c77c4a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockProperties.js\":\"3d254d3319bcf646\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockSearchPicker.js\":\"62e1ce6e1128813c\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ConfirmBulkDeleteDialog.js\":\"c484149848f1abd8\",\"/knowledge-medium/pr-preview/pr-1830/src/components/DividerHandle.js\":\"f4dd990709c28c1f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/DraftEditor.js\":\"4d08732d52891700\",\"/knowledge-medium/pr-preview/pr-1830/src/components/GutterPill.js\":\"95a92283bfa18279\",\"/knowledge-medium/pr-preview/pr-1830/src/components/Header.js\":\"5b210c6e7f3beea8\",\"/knowledge-medium/pr-preview/pr-1830/src/components/LazyBlockComponent.js\":\"8a15ccf0250927ef\",\"/knowledge-medium/pr-preview/pr-1830/src/components/Login.js\":\"344030fd48d5d07e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ZoomableSurface.js\":\"ef160172442efdcc\",\"/knowledge-medium/pr-preview/pr-1830/src/components/editModeKeepalive.js\":\"0a37dd8e15d299c4\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyDisplay/PropertyDisplayScope.js\":\"60886efd8a09005a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7820ce6e0b857a97\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/RefPropertyEditor.js\":\"ee66c821371cb8d6\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/RefTargetTypePicker.js\":\"6ed89f421b77ffe4\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/SelectPropertyEditor.js\":\"3295f0ac91e6a2a9\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/TypesPropertyEditor.js\":\"f3ab8872244bf64c\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/defaults.js\":\"b9c051ca4368591a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/kernelValuePresets.js\":\"40ae6392cba8d105\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/selectablePresets.js\":\"057bd41edbd149dd\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/typesPropertyUi.js\":\"2d0503c7a518cc84\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/AddPropertyForm.js\":\"a9ac823114ee47b4\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/PropertyPicker.js\":\"2a4d22981f0199b7\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/PropertyRow.js\":\"33df08258052a157\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/Rows.js\":\"3ee017df76d17c5d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/actions.js\":\"ee039f755a6358ed\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/declarationOnly.js\":\"c65d13a25137694e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/layout.js\":\"c8810bad8154fc24\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/model.js\":\"80bb310617e7dc00\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/shapeUi.js\":\"f436faab1b15fb91\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/shapes.js\":\"aa40ead10376402a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/usePropertyEditingActivation.js\":\"eada6987675f824f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/visibility.js\":\"2be1da4adbcd703f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanelSections.js\":\"6d4240386277a88f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/BlockEmbed.js\":\"44626c91fd6ec842\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/BlockLink.js\":\"c52ccf80c9ee0538\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/BlockRef.js\":\"71d16e7a9ee00199\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/ReferenceLink.js\":\"ad839ad8d1aaa200\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/cycleGuard.js\":\"1eb9b8329f95bf86\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/cycleGuardContext.js\":\"345f67d2c9ba3153\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/linkInteraction.js\":\"695848be460f0a8a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/referenceLayout.js\":\"356858cc5a60ab73\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/useBlockRefAncestors.js\":\"d09eb731502cdcac\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/BlockGutter.js\":\"17b35ac2f709d7dc\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/BlockInfoDialog.js\":\"42c5b1620596cde6\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/BlockTypeBlockRenderer.js\":\"c753ed68a1af7722\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/BulletHoverCard.js\":\"bb9b11c6e7b9dbb9\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/CodeMirrorContentRenderer.js\":\"44a7643f6e4b896f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7d6fd66430338c12\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/ColumnResizeHandles.js\":\"0349d1db647e2ff6\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a05587a625e6848d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/DefaultBlockRenderer.js\":\"a18cdbc7002dfb85\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/LayoutRenderer.js\":\"4a52d43aee02bcf0\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/MarkdownContentRenderer.js\":\"9c8649fb1b65a1c3\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/MissingDataRenderer.js\":\"25361eff90870c1c\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/PanelRenderer.js\":\"f5053e8e98c09be3\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ea7909bd07a1e1b3\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/TopLevelRenderer.js\":\"621e285350a33e3e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/blockGutterMode.js\":\"2900e65e564719c9\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/blockTitleText.js\":\"9f5f5a4b7dc67b8a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/fieldCreationKeydown.js\":\"187f6c6795e33591\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/layoutRootContext.js\":\"a2fad0699eca2d51\",\"/knowledge-medium/pr-preview/pr-1830/src/components/typeChip/TypeChip.js\":\"66d20cd43e980f91\",\"/knowledge-medium/pr-preview/pr-1830/src/components/typeChip/chipStyle.js\":\"4e042d75a657fc29\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/anchored-floating.js\":\"5c4a67eca5657b0a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/button.js\":\"5fca51d7e4913fa8\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/card.js\":\"eb8355af6f44159a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/checkbox.js\":\"d1e5085459f896e9\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/collapsible.js\":\"875b2a33b599ff42\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/command.js\":\"e1eb46044ad4dad0\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/context-menu.js\":\"10782123f1baf51e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/dialog.js\":\"88b7203c0f4b0310\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/dropdown-menu.js\":\"492b0ba4b06051bf\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/floating-listbox.js\":\"6f08d552b4eb8c22\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/index.js\":\"39a81fcffe65d91c\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/input.js\":\"ee27c77a06067aff\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/kbd.js\":\"6def92db1613738b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/label.js\":\"99ed9cb0445f711f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/textarea.js\":\"986e07756f5e5f67\",\"/knowledge-medium/pr-preview/pr-1830/src/components/useEditModeYieldKeepalive.js\":\"4f3e5f55e0fce231\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/BootFallback.js\":\"302eebcdc97450b8\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/FocusedRowLazyMount.js\":\"a786cf21394861d4\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/LazyViewportMount.js\":\"e9af04a7f920e92e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/LocalDbCorruptionFallback.js\":\"a222714e69c537bb\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/error.js\":\"34b7928e552bf2cd\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/lazyMountRegistry.js\":\"ffebe53bb31cb555\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/suspense.js\":\"10702c79437a7a9b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/CreateWorkspaceDialog.js\":\"f24622b2d11e30bf\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/PendingInvitations.js\":\"0f39596b316aaf93\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/SyncProgress.js\":\"3e5d97b922af8691\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/UnlockProgress.js\":\"2666ed016d99ba8a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/WorkspaceKeyGate.js\":\"01af164b4eb231ba\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/WorkspaceSettingsDialog.js\":\"9dcc6e2eb9f3d489\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/WorkspaceSwitcher.js\":\"2ed73fc6472047c2\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/WorkspaceSyncGate.js\":\"ebdc6b7a7990a2b7\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/ConversionFlow.js\":\"53331a148506fdd7\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/ConversionFlowHost.js\":\"e9c42a86c874f17b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/EncryptionSection.js\":\"f62d60e9505d8d35\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/attachmentPrompts.js\":\"69773bd4982ea4e2\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/bundleFolderPrompts.js\":\"02218c4fec394aee\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/conversionFlowDeps.js\":\"e99bf32a684ebff6\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/conversionFlowStore.js\":\"4ac02dca4df90d0a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/flowUi.js\":\"7d2a8023371820ea\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/useConversionRun.js\":\"204a44665e9e40cc\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/keyUi.js\":\"ada7976673ee9bd3\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/useCloseOnKeyLoss.js\":\"57620d077e980259\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/useCloseOnServerE2ee.js\":\"1bc0518ba9b061bb\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/workspaceUnlocked.js\":\"1089c3a68ef34c03\",\"/knowledge-medium/pr-preview/pr-1830/src/context/backgroundSubtree.js\":\"ca4298e9416d680d\",\"/knowledge-medium/pr-preview/pr-1830/src/context/block.js\":\"eecd6ff469b98717\",\"/knowledge-medium/pr-preview/pr-1830/src/context/layoutWsContext.js\":\"885c4048a94a8758\",\"/knowledge-medium/pr-preview/pr-1830/src/context/propertyDisplay.js\":\"9a91ba38f5633493\",\"/knowledge-medium/pr-preview/pr-1830/src/context/repo.js\":\"1d33cc04ca8bdcba\",\"/knowledge-medium/pr-preview/pr-1830/src/data/aliasClaim.js\":\"92897ab399738851\",\"/knowledge-medium/pr-preview/pr-1830/src/data/aliasSeatNamespace.js\":\"5f8e567eb22607e6\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/blockData.js\":\"dc744bc987837e01\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/blockType.js\":\"02e3f357b9dca9fb\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/changeScope.js\":\"06b64db80b8c0206\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/codecs.js\":\"5af2394816cf9b33\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/derivedData.js\":\"596873d5d3ce9eca\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/errors.js\":\"470d93a09776d7d7\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/events.js\":\"47273d420c1853cb\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/handle.js\":\"2b78c7941465dee1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/index.js\":\"351c92749ae180e8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/mutator.js\":\"d52420c83b541392\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/processor.js\":\"6a363cd2c1083537\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/propertySchema.js\":\"205ae495731f0984\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/query.js\":\"24d8b1cd522df2b9\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/sameTxProcessor.js\":\"6528d58822582de9\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/schema.js\":\"2b78c7941465dee1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/tx.js\":\"2b78c7941465dee1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/typedBlockQuery.js\":\"40bb5d3b8f4edd1f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/user.js\":\"64679f9fe565eb2c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/valuePresetCore.js\":\"ecfc8aecaa61a7d0\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/valuePresets.js\":\"43ef59b2e64c06f5\",\"/knowledge-medium/pr-preview/pr-1830/src/data/attachmentCleanerIOVerb.js\":\"c6b8b18df022b908\",\"/knowledge-medium/pr-preview/pr-1830/src/data/block.js\":\"b0d74a03f6725c6c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockCache.js\":\"c0545e56f71f2566\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockId.js\":\"f4b9665ca4468bc2\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockLiveness.js\":\"7f7dec5c02967cc4\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockMerge.js\":\"be1efabc845f6494\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockSchema.js\":\"29b82b3e7c40edc8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockTypeLookup.js\":\"2a9d049731bfbedf\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockTypes.js\":\"fcae0cb7b811c005\",\"/knowledge-medium/pr-preview/pr-1830/src/data/clientContext.js\":\"18bc09f5bd0ee2b1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/dbFileSiblings.js\":\"a018933fb78f86f8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/definitionSeeds.js\":\"9843198790012e48\",\"/knowledge-medium/pr-preview/pr-1830/src/data/derivedIds.js\":\"991d15a68b8acac5\",\"/knowledge-medium/pr-preview/pr-1830/src/data/drawnSubtree.js\":\"9a0c1bf75d2534dd\",\"/knowledge-medium/pr-preview/pr-1830/src/data/facetBridge.js\":\"70dd07e776c8cc05\",\"/knowledge-medium/pr-preview/pr-1830/src/data/facets.js\":\"86e31e00f1b9d046\",\"/knowledge-medium/pr-preview/pr-1830/src/data/globalState.js\":\"3756764f3add06bb\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/aliasClaimRederiveProcessor.js\":\"5e81b83f77449ed8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/ancestorBatch.js\":\"e6d4cd062b81a2e1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/blockTypeTypeifyProcessor.js\":\"73014f3feb25da89\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/clientSchema.js\":\"1a47d9a181898e0b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/commitPipeline.js\":\"af638f318406bade\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/devAssertions.js\":\"ed1b6aaa6710c12a\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/firstSync.js\":\"296bd9b228115b32\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/freshInitialLoad.js\":\"f17e1a52ca7f0050\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/graphBackfillClaim.js\":\"6ee6308b1d2e2fcf\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/handleStore.js\":\"e5e24de9c04a7397\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/idleMarkerJobs.js\":\"be36878ca4eedbc1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/initialDownload.js\":\"1f2a3e82ba658194\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/initializeClientDatabase.js\":\"ffd0f755e2a7e758\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/jsonCanonical.js\":\"f5b479d797794c2b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/kernelInvalidation.js\":\"7b12ac79513e9a58\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/kernelProcessors.js\":\"61f55a95fbd54120\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/kernelQueries.js\":\"d041597e9108d870\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/mergeTypeMembershipProcessor.js\":\"6ab99f047077afc3\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/normalizeReferencesProcessor.js\":\"41d3dc655e4cf8bb\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/poolInstrumentation.js\":\"c99555d33bb54ba7\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/processorRunner.js\":\"cf04f2fd991b6419\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyCellBackfill.js\":\"584a1b69d9537523\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyChildMint.js\":\"5018853b29e723b7\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyChildrenProcessor.js\":\"89022ecafc311952\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7b92b93c548d59ba\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyDefinitionSynthesis.js\":\"5e274cf25f214f84\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyKeyScan.js\":\"5f19c8980a647680\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertySchemaResolution.js\":\"da7afd7a302fe46f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyValueEdits.js\":\"9546ad5274ee143c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/raiseProtocol.js\":\"a6a8d386a04c9a14\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/readBatch.js\":\"8446065e366f2fb9\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/refProjection.js\":\"a5d718542ac0bbd0\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/referenceTargetLookups.js\":\"3752b90ea95ee2fe\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/referenceTargetProcessor.js\":\"5d1f07af33c82181\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/replayMerge.js\":\"f3f2eb11d5b8f0eb\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/sqlBinds.js\":\"8b4d94fc194740ad\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"89adedcbc0af4a7b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/arrivalProcessors.js\":\"26be8dddb296c6cd\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/invalidate.js\":\"30d20f7e51a38e69\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/materialize.js\":\"fc23693ede2b60f8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/observer.js\":\"62f681d5c66f38bc\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/reconcile.js\":\"ef720749d18dde79\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/timingMetrics.js\":\"7f355efeb7084c93\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/treeQueries.js\":\"f62e9ea753e33878\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/txEngine.js\":\"1c5f119a31c7aef4\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/txSnapshots.js\":\"8adef789adedadf6\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/typedBlockQuery.js\":\"eb26875aa47d8352\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/undoManager.js\":\"23e9773adcb15214\",\"/knowledge-medium/pr-preview/pr-1830/src/data/invalidation.js\":\"177a8e6210e4c3a1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/kernelDataExtension.js\":\"e93d28e4a2f7d59f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/kernelPage.js\":\"1c3544f6a69d8325\",\"/knowledge-medium/pr-preview/pr-1830/src/data/kernelValuePresetCores.js\":\"febd8eb38d5abbf3\",\"/knowledge-medium/pr-preview/pr-1830/src/data/localDbCorruptionSignal.js\":\"997b61d46e3fcef8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/localDbStorage.js\":\"88108f2d8e6188d4\",\"/knowledge-medium/pr-preview/pr-1830/src/data/localDbVfs.js\":\"bbd249a886d1610f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/localSchema.js\":\"df68e93cad3d0699\",\"/knowledge-medium/pr-preview/pr-1830/src/data/maintenance.js\":\"2bbdf77e0c114efa\",\"/knowledge-medium/pr-preview/pr-1830/src/data/mergeProperties.js\":\"03aaf155916e88b2\",\"/knowledge-medium/pr-preview/pr-1830/src/data/metricsConsoleHook.js\":\"9df6ecda8d74c8d3\",\"/knowledge-medium/pr-preview/pr-1830/src/data/migrationsPage.js\":\"016ea897e259b041\",\"/knowledge-medium/pr-preview/pr-1830/src/data/mutators.js\":\"ee76c5980f09b57b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/orderKey.js\":\"556ca4a6b52ad529\",\"/knowledge-medium/pr-preview/pr-1830/src/data/orderKeyPlacement.js\":\"b813066a8ea63a3b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/outlineSurface.js\":\"c33f5ecd7675f6d2\",\"/knowledge-medium/pr-preview/pr-1830/src/data/pendingEditorContent.js\":\"9c68943a28e006ba\",\"/knowledge-medium/pr-preview/pr-1830/src/data/pendingUploadsSql.js\":\"074d080a509ad760\",\"/knowledge-medium/pr-preview/pr-1830/src/data/pluginStateExtensions.js\":\"c1a8ecff1c4400d1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/powerSyncLogger.js\":\"00938ef1a37e5a2c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/projectorRuntime.js\":\"c9ba90d69ed89717\",\"/knowledge-medium/pr-preview/pr-1830/src/data/properties.js\":\"f170f4557e1b98f6\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertiesPage.js\":\"c4d1869c15105678\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyChildren.js\":\"7bd6facf3e22e418\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyDefinitionFanout.js\":\"1cc77b3ce7dca424\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyDefinitionMetadata.js\":\"6d1a56e19825cc2c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyDefinitionRegistry.js\":\"2d10e3b0a55d9574\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyDisplayMode.js\":\"355468788cd150bd\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyRowCreation.js\":\"8fa03fd5fca7a646\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertySchemaCreation.js\":\"72d90aa0af3fe73f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertySeeds.js\":\"9c335f3fc1aaccb7\",\"/knowledge-medium/pr-preview/pr-1830/src/data/recentsPage.js\":\"dc809c477a20cc7e\",\"/knowledge-medium/pr-preview/pr-1830/src/data/referenceBlock.js\":\"bc50f1998b12af89\",\"/knowledge-medium/pr-preview/pr-1830/src/data/rejectedUploads.js\":\"b727bf7d9cf6bb4b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/releasePowerSyncConnection.js\":\"0c16910a2257b2d2\",\"/knowledge-medium/pr-preview/pr-1830/src/data/repo.js\":\"8bbe6d06e06051d3\",\"/knowledge-medium/pr-preview/pr-1830/src/data/repoProvider.js\":\"6152e7a93d9d9a7a\",\"/knowledge-medium/pr-preview/pr-1830/src/data/rowProperty.js\":\"30cc3793c6924ad8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/searchFilter.js\":\"0bf444dd1dd4db13\",\"/knowledge-medium/pr-preview/pr-1830/src/data/seedIdentityLedger.js\":\"fe8b91421091717d\",\"/knowledge-medium/pr-preview/pr-1830/src/data/stateBlocks.js\":\"a566ebaaa03f7b6c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/structuralEditPolicy.js\":\"931adf3ec042e12c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/subtreeDelete.js\":\"c3714c577cb31171\",\"/knowledge-medium/pr-preview/pr-1830/src/data/syncStreamLock.js\":\"22190a1e0c5897ac\",\"/knowledge-medium/pr-preview/pr-1830/src/data/syncedTableSqlRecognizer.js\":\"4440bba60d964657\",\"/knowledge-medium/pr-preview/pr-1830/src/data/syncedTableWriteGuard.js\":\"e95157d95c667b7c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/targets.js\":\"564b87647b44ef75\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeColors.js\":\"487cc1ab9e49d178\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeDefinitionMetadata.js\":\"1793a6441706b418\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeDefinitionRegistry.js\":\"75027ddf0a9db24d\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeExtraction.js\":\"6e75fc6dd7bdbe38\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeInitialValues.js\":\"6d504e0eb3d2bc99\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typePropertyGroups.js\":\"e22d8722f4e8b8d6\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeSeeds.js\":\"92f12f8b21f595f0\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeTagger.js\":\"c8287b0cbd6bbe31\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typedRecords.js\":\"aa08236373f8071c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typesPage.js\":\"93befcbb87b91413\",\"/knowledge-medium/pr-preview/pr-1830/src/data/userPrefs.js\":\"d8f5effa4c0ac7d1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/userSchemasService.js\":\"a2b8481037b97dbd\",\"/knowledge-medium/pr-preview/pr-1830/src/data/userTypesService.js\":\"7d5902eafbd4e231\",\"/knowledge-medium/pr-preview/pr-1830/src/data/valuePresetRegistry.js\":\"97620b31e4f9e916\",\"/knowledge-medium/pr-preview/pr-1830/src/data/visibleChildren.js\":\"8967e44db02c85ff\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaceConversion.js\":\"b7a4110ea5c475ce\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaceFirstSync.js\":\"491d40a6247fae02\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaceIdNamespace.js\":\"a408f9ae223dc132\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaceSchema.js\":\"277e96777be648d1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaces.js\":\"119f8dfc173b59f6\",\"/knowledge-medium/pr-preview/pr-1830/src/data/writeAheadLog.js\":\"9be6b7880ad2bed1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/BlockPasteShellDecorator.js\":\"3bd03b97acd71147\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/atTrigger.js\":\"83a71838344de27c\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/autocomplete.js\":\"b7691165ebc16942\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/codeMirrorExtensions.js\":\"e9f2b720a745fb9b\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/contentFlush.js\":\"523467043611cbb6\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/defaultInteractions.js\":\"95b739d638c54710\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/editSettleSignal.js\":\"4c76c434702e25b3\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/insertImage.js\":\"701e7e8d9defe1fa\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/referenceCompletionRange.js\":\"72cae9235e0c9979\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/referenceTargetTypes.js\":\"14571c8085d2a75d\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/syntaxContext.js\":\"d97b8f8066fa2ce8\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/triggerMatch.js\":\"d8f5eacd205b58fc\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/AppRuntimeProvider.js\":\"b8b3ac78cb932706\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/BlockFocusShellDecorator.js\":\"3848288a2d7bf6fd\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/ExtensionRenderBoundary.js\":\"7b8938c80bc5042a\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/PanelContentRecovery.js\":\"7cefdcb0753ceff3\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/apiCatalog.js\":\"262494198fa271e6\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/approveExtensionHere.js\":\"077a6c41ad4144f8\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/armedCutAppMount.js\":\"4a8a8cf0df7c9b17\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/batchableKeyedStore.js\":\"e887addb2a094599\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/blockInteraction.js\":\"ae64f73f3f3e6d61\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/blockSelectionAction.js\":\"7360e812a45feffd\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/compileExtensionModule.js\":\"7b81941ce6aedb0f\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/compiledModuleCache.js\":\"a43d67a0c8a88925\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/continuousGestures.js\":\"217690de19ae3e34\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/core.js\":\"7db15ed54987d7a7\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/defaultRenderers.js\":\"14180d52f67fe3b1\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/definitionFanoutAppMount.js\":\"b88acf658e8120d3\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/dialogAppMount.js\":\"aae3e02c654726ad\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/dynamicExtensionSeeds.js\":\"f24d4a0b32eede96\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/dynamicExtensions.js\":\"0d0367f3c91f63d8\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/exampleExtensions.js\":\"17b906ac47e7263d\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionApprovalStatus.js\":\"1fe29a1169762aef\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionLoadErrorToast.js\":\"9361eefc10e30769\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionLoadErrors.js\":\"8563b54db2635dc8\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionLookup.js\":\"c4c17169e9ec4b61\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionToggles.js\":\"0f8db045cc747ebe\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionUtilitiesCss.js\":\"e6b13ef79222f787\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/kernelPageDeletionGuard.js\":\"36567fdc8b9872fe\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/liveRuntime.js\":\"254f17a633f5a06f\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/openExtensionsSettings.js\":\"669ac614b40bbae7\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/overridesCache.js\":\"bd134f8d8e7db6bf\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/pluginIds.js\":\"8f1ee0e66a88f66f\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/processorRejectionToast.js\":\"5de0b4c7764583dc\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/runtimeActions.js\":\"30c510b618ae50c7\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/runtimeContext.js\":\"5d5a15582b2ed137\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/staticAppExtensions.js\":\"69e7062eeb23d810\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/staticDataExtensions.js\":\"9afe884d201f0841\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/toastAppMount.js\":\"7ebcf5f435feb4e6\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/useOverrides.js\":\"837de69ac5d99326\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/useShortcutSurfaceActivations.js\":\"f48b1f73c25532ab\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/discoverToggleTree.js\":\"0d47529da7db9781\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/facet.js\":\"9f7973d932f2e2a1\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/resolveAppRuntime.js\":\"f56af0eff9c49179\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/runtimeEvents.js\":\"9a3f442bc7cb89c5\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/togglable.js\":\"b816b03efedfd81f\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/variantFacet.js\":\"467c287820c171b4\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/verbFacet.js\":\"851452c1a70b68ca\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/block.js\":\"25b7c7858007bb47\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/focusedChild.js\":\"40f5e2c5bcb92e16\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/propertySchemas.js\":\"534155537b246b9f\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/typeRegistry.js\":\"5c87032c60faa8bc\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useAncestorCrumbs.js\":\"856cb765af49d934\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useAutocompleteListbox.js\":\"552c2cde5cf324ee\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useDebouncedSearch.js\":\"a03ef1293b14fcf0\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useDebouncedValue.js\":\"2d96af7126292f95\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useIsFocalRender.js\":\"e3bd1444b845cabd\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useIsReadOnly.js\":\"0ba34971369a24d9\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useMaterializeBacklog.js\":\"9bd390b545afe76a\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useMinuteClock.js\":\"43ea15635ba63cd2\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/usePanelLayoutProjection.js\":\"c1d99a2c9834c205\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/usePendingInvitations.js\":\"52b8c533a9f316c5\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useRendererRegistry.js\":\"7718a9655bc98075\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useRetainedFieldRows.js\":\"fa06e91c0c524eb1\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useWorkspaces.js\":\"1d3453b62335e0e3\",\"/knowledge-medium/pr-preview/pr-1830/src/lib/utils.js\":\"86e6753d941622c3\",\"/knowledge-medium/pr-preview/pr-1830/src/main.js\":\"1c80809fe74d04c1\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/MarkdownImage.js\":\"d1ffc1bf7bfa6e4e\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/blockSeparators.js\":\"1098b518d80c60e6\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/context.js\":\"1f4d6ce1b35a0bb1\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/defaultMarkdownExtension.js\":\"0f65eea3ded6c18e\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/extensions.js\":\"470736b46101df35\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/renderMarkdownHtml.js\":\"ef73a600c1c34896\",\"/knowledge-medium/pr-preview/pr-1830/src/minimal-editor.js\":\"8d835e97f0856934\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/armedCut.js\":\"c7257913bc49df85\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/captureMediaVerb.js\":\"c03f0c9b62a5d3f3\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/clipboard.js\":\"b45800317d0dd8a4\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/decision.js\":\"c5b373ba6ca6d5ef\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/operations.js\":\"c8df673e1128dc79\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/account-header/AccountHeaderItem.js\":\"81f22b254649ffc9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/account-header/index.js\":\"ffe28c1406d65043\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a35c11057164355f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/askAgent.js\":\"ae97b6899762db81\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/askedStore.js\":\"f5b6d9da64ff73f9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fc996bfee1d85ee1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/chipState.js\":\"15bb291b7f88626d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5296aef6a727484c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/index.js\":\"d25cc8287042c3c7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"af1fb03cfa176305\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/schema.js\":\"e09124d4ff96a54c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/AgentTokensDialog.js\":\"004a24af3aeb884c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2ab3a9e3a9fb2a72\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/addMedia.js\":\"2325b064235037fd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/backlinks.js\":\"560274fe79db95da\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/block.js\":\"32abb1e65aa76a7c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/context.js\":\"8b2722dffb01a1a0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/displayIds.js\":\"086c4b03edccf038\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/index.js\":\"4cb956b9251ca77a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/outline.js\":\"c6718e0d82e61085\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/properties.js\":\"3aa9894efeca5779\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/refs.js\":\"c2b6a755dbb1b187\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e8406f9ddeb45694\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/search.js\":\"c1a52fccf8be8ca7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/shared.js\":\"7a0ad485f5144899\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a239748871f8e7cf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/text.js\":\"7f02a18ce2a79b76\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentWrites.js\":\"cde3d92c4e87e4c3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/authoringCatalog.js\":\"aec2cb33b06aa64d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/blockRefTargets.js\":\"8d36838ae5d3fe78\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/bridge.js\":\"34f77f1b6745702a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/bridgeLoop.js\":\"0b2aef32d79d64d4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/changeHistory.js\":\"a70bcd01f1a0f373\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/commands.js\":\"57c3fabf493a0e53\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/commentsCommands.js\":\"bad768efb67bde28\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/dataExtension.js\":\"e834948fd638555f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/dataModelGuide.js\":\"ac241b40e88cea48\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/describeRuntime.js\":\"2dec9762dcc9a5ab\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/extensionLint.js\":\"a428b87219bf4ed2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/grainAudit.js\":\"b82f7d2393e29805\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/healthCommand.js\":\"33336a99296fb742\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/index.js\":\"8db7cb5ba02e9410\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/presetIdentity.js\":\"9f457062d4dd0197\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2ef5f57761af4b92\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/readMedia.js\":\"829378f449d017c1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/schema.js\":\"64c2f064571cfa00\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/serialization.js\":\"488ce0d73159680d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/targets.js\":\"4fc675cf04835f36\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/tokens.js\":\"9d87cfe1c2d501c7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/watchEvents.js\":\"4953bddbcf7bf04a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/workspaceGuard.js\":\"6f19f5ee65688a8f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/writeCommands.js\":\"dd2b657ef050287b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/AliasCollisionToast.js\":\"40dd702b02607ed5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/DuplicateNameBanner.js\":\"5ab99c49e0265432\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/collisionMerge.js\":\"1b06dd063e0563fe\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/dataExtension.js\":\"5fbaf335856196a6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/index.js\":\"68c8ddf0dd5d199c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/mergeCollisionAction.js\":\"0f3ac8ee338e7037\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/pageStyling.js\":\"9f140efa6aed780e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/rejectionToast.js\":\"da24f9f4049bf9fa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/syncProcessor.js\":\"20fbbb737fc1a5e4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/actions.js\":\"345257b47e931a8e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/addComment.js\":\"28a248e2b26e4c39\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/anchor.js\":\"73ae3507260bdfa2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/anchorState.js\":\"aa92aff49330c8d5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/commentLinks.js\":\"77634c1f9b6295e2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/confirmThreadDeletion.js\":\"d4637b753d23fdce\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/container.js\":\"7321e4000fd14071\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/dataExtension.js\":\"5202d2f743f86c90\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/deleteComment.js\":\"6ab0dc2fadaf397e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/highlights.js\":\"5cb7d0d6e425a50b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/index.js\":\"763d34d2586e4654\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/linkedCommentsPill.js\":\"a682a401f1100177\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/margin.js\":\"f231a9fe9dcc90ea\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/marginSchema.js\":\"4d743a48e4ceceb5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/newComment.js\":\"5645d8a096fcc46a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/ownThreadPicker.js\":\"a42b5964f432d29d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/placement.js\":\"03af2e9ac14c5002\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/queries.js\":\"beba6f35e1575031\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/quotePosition.js\":\"f7028edb30d688b6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/quotedIn.js\":\"623da15501fd6e0c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/quotedRange.js\":\"bab80132a6c89717\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/rangeRefs.js\":\"552c87304ff9e4a0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/readHighlights.js\":\"a366d38dc530a8ac\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/readSelection.js\":\"2dfb80173640106f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/readSelectionUi.js\":\"215c29412b45091f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/reanchor.js\":\"d96e266cb2ea2257\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/schema.js\":\"95647ac00e277a6d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/scope.js\":\"7752aeacfd8c9e9b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/scopeThreads.js\":\"53be9954e99dc321\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/splitRetarget.js\":\"fd3c3fc953f5772e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/suggestionCard.js\":\"f881e026de713769\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/suggestions.js\":\"af85959649d8ab55\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/summaries.js\":\"b58461ee7031a390\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/summaryBatch.js\":\"8f09fc96bbc49c1f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/surface.js\":\"c0118d093a805d2d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/threadNavigation.js\":\"4643bd9c37c6e69d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/threads.js\":\"d1fa33e072b9e424\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/ui.js\":\"83f1c5b4c983c921\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/uiStore.js\":\"1735418701a67d51\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/app-intents/appIntents.js\":\"4498a61ffadb952a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/app-intents/index.js\":\"745b11bff8821f54\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/app-update-prompt/index.js\":\"38c8fb3463788d4e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/app-update-prompt/status.js\":\"8ab7898897ee8c2a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"aa85bc9cbd694495\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/MediaBlockRenderer.js\":\"45770293dcef3187\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b3e01d73fedb29a0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/MediaUploadReconciler.js\":\"f8e102ea20a8dce6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/assetDownLane.js\":\"54781aa6cd38a97c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/assetResolver.js\":\"4fd32eed19661613\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/assetUpload.js\":\"2876b40ca20fc6ef\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/attachmentCleanerIO.js\":\"0ee7a47279b4ee99\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/supabaseAuditIO.js\":\"ca364c62e378bb3d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/blobStore.js\":\"2aa11fbb00c9dd2e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/byteStore.js\":\"2422ac0e921e3bd3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/cleanerIO.js\":\"95a3ea1587bb8430\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/cleanupAttachments.js\":\"16d0c8e6af844e96\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/dataExtension.js\":\"cbd52ffc62659bdb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/downLane.js\":\"3ad61f35fd0fdb4e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/index.js\":\"37f91fa47674107f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/insertImageContribution.js\":\"76db5647dbf8c465\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/laneArming.js\":\"4074cced71121ede\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/laneLock.js\":\"25c2692e083f6ace\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/mediaBlock.js\":\"07b62088c3c6597b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/mediaCapture.js\":\"1d7472a47057bbdd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/mediaViewers.js\":\"1da613a70f3f80aa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/mediaViewersFacet.js\":\"1aa524d5b0518dd4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/pasteCapture.js\":\"1970395259582772\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/resolver.js\":\"40227f7dc70178c6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/retryUploadsAction.js\":\"da8785d03b1f1937\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/storagePaths.js\":\"2fb7101345b55964\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadDrain.js\":\"5d346129968aa932\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadLaneStatus.js\":\"41771173db59fd20\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadReconcile.js\":\"0bbbaa89e1b4e213\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadRecovery.js\":\"d86efe79404be850\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadStore.js\":\"590b369f0a1aae27\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/useAssetObjectUrl.js\":\"661e7449138acf69\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cecb2976871f2dcc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fc07c7459a350123\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/facet.js\":\"cefb4234ce44363f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/index.js\":\"d1ba90d2cb5c2672\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/prop.js\":\"46c81d7513cc19ae\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/BacklinkFilters.js\":\"6fcd7af3747e4089\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"3589dc2b622efa3b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/BlockEntry.js\":\"41fc276361c113cd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/LinkedReferences.js\":\"1311e7c89727bc0f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"846e7579f2796585\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/dailyNoteDefaults.js\":\"6dc028dfde88b7bc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/dataExtension.js\":\"172acd7b12a655fd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/edgeExclusions.js\":\"52956244a2b2f462\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/filterProperty.js\":\"0fefec090fd5ef38\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/index.js\":\"b21039fdd4c9ab49\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"545f46eff90ab571\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/applies.js\":\"29125b6787b15039\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/countQuery.js\":\"bdb893fc32db928f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4a11434c9cf31533\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/index.js\":\"54e2d8a158253a94\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ad2ae4775e38716f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/presentationInvalidation.js\":\"ec3c7e0b2e95ed60\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/propertyEditorOverride.js\":\"7b8c4d33af3651a2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/propertyFilter.js\":\"9caa2dad60a50a22\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/query.js\":\"4650a87bb79fbc4c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/resolveFilter.js\":\"395b2157c4026ccd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/sourceBatch.js\":\"eff4d2b92e0e97ac\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/sources.js\":\"75a8c77c0c0f4572\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/useBacklinks.js\":\"0ff993fa058afddd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7510512baf715de7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/BirthdayCelebration.js\":\"d86a87254db4e265\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/BirthdayOverlay.js\":\"7c1363b40335ea1c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/gate.js\":\"aa51093fb3ce2039\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/index.js\":\"732eb86eac737ab0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/wolfTheme.js\":\"0fb5dfda1680f15d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/BlockDragLayer.js\":\"519001f6864e671c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/dragController.js\":\"32839a4825e091d9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/dropTarget.js\":\"cc20217f4af3617b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/index.js\":\"ebd1a2da601fd320\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/projection.js\":\"c0e072c1c23c263d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-info/BlockMetaCard.js\":\"ad7cb962f7bf9910\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-info/index.js\":\"519b39bf6e4f0bec\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/AddTagDialog.js\":\"e560340af75bde09\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"36238b541e1d62d9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/TagNameIssueHint.js\":\"a323a44b7ef6e8ce\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/addTagAction.js\":\"77e762556f09ddd1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/appendTag.js\":\"a31b04c677e00ff3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/config.js\":\"d3e1306f0cb04602\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/dataExtension.js\":\"5364326fa8831b24\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/index.js\":\"c4d83297fc1614c1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/propertyEditorOverride.js\":\"ad3a87ae37cf9c84\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9ccd2e4233a23368\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f0576ae074abf6ff\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/Breadcrumbs.js\":\"028e8dae5588d425\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"331a469f7049ed95\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b76a182a03329475\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/index.js\":\"59e5e730e706a855\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d430fafd8e4fd788\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/CharacterCountItem.js\":\"14300034cb100598\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e6fe4aeee508cce7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/actions.js\":\"96d79be15f8aa70f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/blockType.js\":\"0088da81662a3569\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/charCount.js\":\"4875eb4d92db7e74\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/dataExtension.js\":\"d88d0e5bba44e809\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/index.js\":\"36f49c018650ed2f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/profiles.js\":\"643455b7a420ae16\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/properties.js\":\"8f8ccd9591fb0f0a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/textCounts.js\":\"dee93af409d6e2f2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/colemak-keybindings/index.js\":\"576138347f0a5fb6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/CommandPalette.js\":\"6a901ebfb0265f3a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/HeaderItem.js\":\"9b6e7cf1031614d5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/context.js\":\"c9f972f0375f8d1e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/index.js\":\"4836b9006a6aeee4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/selection.js\":\"89edf94c9e71e4a8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/toggleStore.js\":\"d32c5d2cb49cffeb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/useCommandPaletteActions.js\":\"be8cee66edf3d93f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/ContributorBadges.js\":\"d0064ad6d8fa526a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/author.js\":\"6de90ce566ad6018\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/codeMirrorExtensions.js\":\"7b0442d8e2869286\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/dataExtension.js\":\"e72235edf49fcd87\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/index.js\":\"6d2d87ef7216e036\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/mentionAutocomplete.js\":\"e876974c828f63d4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/processor.js\":\"70da8553d5aefa1d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/profiles.js\":\"55e27d702009f7d5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/queries.js\":\"3623174e93a137ef\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/schema.js\":\"1e214c017fbe10c9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"dfdb10b5e11f1f79\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f3680aab26cb2e65\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/index.js\":\"c033f992a9d64846\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1f3b4435739338bf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b2e6bd5354217026\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/CalendarGrid.js\":\"98ca98918fb8d02d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/DailyNotePicker.js\":\"2d510206e02198c7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"715089089e90a9c9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/DateNavDecorator.js\":\"53d9a2b5b1841831\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/DateScrubOverlay.js\":\"76a388e2a4c08ddd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/HeaderItem.js\":\"ffb5131e6606e5b5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/ReschedulePicker.js\":\"692328f5db846ae7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0728b40a454e6492\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/actions.js\":\"19fbbbf477fd3b3c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/blockDateAdapter.js\":\"b259224b2b994c8e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/calendar.js\":\"4981388fc224b9fc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dailyNotes.js\":\"de915e7b109398c8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dataExtension.js\":\"23547c9a3bc83049\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dateScrubActions.js\":\"796867bacfad58f4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dateScrubGesture.js\":\"62da58a07d564a46\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e235163bfead2a7e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3b91ddf5326e5fc1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/deletionGuard.js\":\"4042da56bff8efaa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dueQuery.js\":\"7f14793ab8ce32eb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/index.js\":\"4a12ab428d6fa2cd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/landing.js\":\"9759c1a8bff28529\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/localSchema.js\":\"99cf57eee09cf7cd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/referenceDateAdapter.js\":\"4abc210f2d53fafc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/rescheduleAction.js\":\"bd5edfe2af032c16\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/schema.js\":\"c52e9c330d2901e5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/spreadBlockDates.js\":\"a7c3a2f1ec52a755\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/spreadDatesAction.js\":\"e6791aab536bfa96\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/today.js\":\"4f992bf4bfeaa5d8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7a9a11ed3954dbce\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"88f9906b61996ea5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/audit.js\":\"7d5b1e4e788f6efa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/auditAction.js\":\"431b444cf17e00c4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/auditRanges.js\":\"161a2b1f9449cffa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/diagnosticsSource.js\":\"84e55cb350e0b8ea\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/divergenceScan.js\":\"c60f3514ed5b292e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/index.js\":\"58a929cc893f1cda\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/propertyChildrenChecks.js\":\"de507e58d9c589f0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/referencesMirror.js\":\"c897a0f1e2968e36\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/rowJson.js\":\"229194b8555f5186\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/schedule.js\":\"5cb44b039108c05b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/store.js\":\"2a63502e5c17dd43\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-maintenance/action.js\":\"c8c553eb0e6187d1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-maintenance/index.js\":\"ae38b6f2f8c4d063\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-maintenance/plugin.js\":\"9ec76b77c533ea9b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"44ca252e2c98d286\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/actions.js\":\"fbfc9ef8f73c16bf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/changeMarker.js\":\"52ea121c9f927cac\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/diagnostics.js\":\"b55e7644c1cad4b2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/fileSystemAccess.js\":\"c8b3cb0089e9bbc7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/filenames.js\":\"00ac35a220bcc923\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/index.js\":\"01fc490aff947736\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/mirror.js\":\"57147043278e7604\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/runLock.js\":\"7f98cbdcc80184ea\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/runtimeHealth.js\":\"ef7b4f7e6dc139b4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/schedule.js\":\"1b3c43b08b7ed3e1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/store.js\":\"51b560f08e058263\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/default-themes/index.js\":\"4b15367d9e047485\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/default-themes/themes.js\":\"9e22a04593637f0c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/diagnostics/facet.js\":\"82084647ed1128a0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/diagnostics/useDiagnostics.js\":\"f7fe9ed130de61e4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extension-prompts/dismissals.js\":\"b49f6b20a2f4092e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extension-prompts/index.js\":\"cb3df4f0ec5453d1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extension-prompts/status.js\":\"bf3e3e61017914bd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extension-prompts/store.js\":\"976dec3d276ed7d9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"03405f6bf0a578bd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/ExtensionsSettings.js\":\"98071b17bb29bf36\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/actions.js\":\"2e346446c8ff8558\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/config.js\":\"399c8523c1a5613e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/dataExtension.js\":\"35db704fe2d92c52\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/effect.js\":\"b3631150280d4699\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/index.js\":\"d516c5563249858e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/propertyEditorOverride.js\":\"35f1abb271a8d27f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/useToggleTree.js\":\"3b548b01e169d006\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/ExtractTypeDialog.js\":\"5b4843acce424d96\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"2f30227946e4deab\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/PropertyShapePicker.js\":\"d067e4ea5b252258\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/action.js\":\"3302e8e9c6f96f3f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/index.js\":\"9d4ed222f71b2348\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/FindReplaceDialog.js\":\"90bcc8274986caef\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/HeaderItem.js\":\"a9f1763312b7fefd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/dataExtension.js\":\"105d1390fd77da08\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/index.js\":\"1cbbc2862eaad794\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/search.js\":\"015700d64fe7e5cd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/toggleStore.js\":\"beff9f107e521037\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/LocationPropertyEditor.js\":\"ecccdae49f8f26e6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/MapView.js\":\"3aab17bfd0ef6191\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/blockTypes.js\":\"84d2c2d108ef81b4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/codeMirrorExtensions.js\":\"bd176d6c81106146\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/createOrFindPlace.js\":\"66603090606e32cf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/currentLocation.js\":\"9426c575f97bd70f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/dataExtension.js\":\"d56ed901db2c605f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/geoContentDecorator.js\":\"c5b43728af3d0343\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/googlePlacesClient.js\":\"fd168dc274fc6f6a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/index.js\":\"1fc2b9a1489dd9b1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/locationsPage.js\":\"07501d6a1498c561\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/mapViewport.js\":\"8541807f68bcd9f5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/pickCurrentLocation.js\":\"5c4f4144e6b07207\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/placeAutocomplete.js\":\"4f15f7e4f53d3d34\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/placeNameCollision.js\":\"c1f34da635bb40c2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/properties.js\":\"9b15045607da295a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/propertyEditorOverrides.js\":\"badef47105f43da4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/query.js\":\"a0f7b90f3576106a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/usePlaceSearch.js\":\"4ffff57609f825e7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ef98254033f6b53d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a2ca9ca942871760\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4fd2757b6d6839e8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/config.js\":\"042c888e123ff12e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/dataExtension.js\":\"4ec165df7578ce46\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/facet.js\":\"5bec63f27f81ca29\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/grouping.js\":\"afc0eb73afbdf6b2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/index.js\":\"66618d19865c5b60\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a0be33ad67118a35\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/query.js\":\"d99e18f07842fd52\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/resolveConfig.js\":\"9e344e1cb64e9d73\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ab194be414f20d67\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d6f6a09caabaf693\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/HtmlDocumentContent.js\":\"2cec4a434acf45a0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/HtmlFrame.js\":\"1b3078da153b33b6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/actions.js\":\"5a9ba7fb2774b20d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/blockType.js\":\"24ff64b1a1006188\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/confirmRunScripts.js\":\"315b3bb0d7f9215f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/dataExtension.js\":\"bec730174a285bcd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/frameAnnotations.js\":\"9876bd881e43d46f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/frameDocument.js\":\"1c12a17a5b3b3fa8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/frameTheme.js\":\"6bcd33da0f64e86d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/index.js\":\"798ad34394040636\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/scriptConsent.js\":\"ea7bd511f15e1aac\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/sourceMap.js\":\"7377529160839167\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/useDocumentScripts.js\":\"6bf193acb81c2843\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/index.js\":\"c77f642f414bba22\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/record.js\":\"37612df00ae25dbf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/recordStore.js\":\"cccb7ca84c481e3b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/responsiveness.js\":\"41074e5735de7410\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/schedule.js\":\"b5c0f2dec45e1565\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/sessionContext.js\":\"9e5409f63929e6bd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fc90b52c5048b01e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"33f8f01bd2073e6c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/actions.js\":\"bb9bd970c7c7f640\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/config.js\":\"6ecac6eb4ddf6c74\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/dataExtension.js\":\"e3633e0c96b1d07d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/effect.js\":\"33eb562dd3de6f13\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/index.js\":\"650eeb2b245539e0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/keyCapture.js\":\"437bd5260f39f4a8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/overrideStore.js\":\"02d22a1706d8078b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4aa4d7206a8a2676\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/HeaderItem.js\":\"8a8ef10b1324821d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/LeftSidebar.js\":\"4c9159f362a5dcc0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/actions.js\":\"75a0c9db1fa38849\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/facet.js\":\"7a58208ba4995c0b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/index.js\":\"f78a49d8bee2d4e6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/shortcuts.js\":\"abf42536857f21a6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/toggleStore.js\":\"e9ed020839dc64fb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/merge-blocks/MergePicker.js\":\"98383103709961ef\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/merge-blocks/index.js\":\"507cbab30e8b097b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/merge-blocks/mergeAction.js\":\"fd7d5c20ce4d25dc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/merge-blocks/strategy.js\":\"cc2e52b8e2297e48\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/Button.js\":\"870fb8c54d6772e7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e648d3a3d0b9fefe\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a6245cee3d339b28\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/facet.js\":\"1862ad2146e8561b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/index.js\":\"377ea37c0caf4469\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"dbee21ca52ca8349\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/actions.js\":\"54a3a1512a4b5f75\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"32699f3374e2610e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/facet.js\":\"429afdd472e7406e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/index.js\":\"d0605661b82e0d8f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4c08b82584221059\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ff079603d42c77f6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/contextMenuItem.js\":\"b93929b03e48f482\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/index.js\":\"bd2419d9564f5757\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/moveAction.js\":\"872c9fea9fd01b7e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/moveBlocks.js\":\"eb299e4e5f138e79\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/selectionAfterMove.js\":\"a1304a8de9691fd3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/TutorialBanner.js\":\"e054497c6650d69d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/action.js\":\"78638e68b8d8c6f8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/bannerDismissal.js\":\"31ad581bbce3cdd8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/documents/cheatSheet.js\":\"96a67f9cc008b287\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/index.js\":\"dbcfa71ca58d8418\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/keys.js\":\"a27d00ac6cebc5fb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/landing.js\":\"d25f746c7ea3f1ce\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/outline.js\":\"67abf185930feafb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/seed.js\":\"b4157b8f47f25fe9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/PerfTrendDialog.js\":\"2963dc0db667f865\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/analyze.js\":\"a4d6e87d688a8de8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/diagnosticsSource.js\":\"fe2f90613b3415b9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/index.js\":\"1dbd7e4eb9bc0b78\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/load.js\":\"59325ac2ca004c3b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/monitorRun.js\":\"f53b71059392a759\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/schedule.js\":\"aef5df4c8188afdf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/series.js\":\"ca909bd6f7bc45e5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/store.js\":\"083d4042cc764f1c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/trendAction.js\":\"1586e4460d5012d9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/verdict.js\":\"3da88ef1fa3f76f1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/plain-outliner/clickToEditAction.js\":\"b4f5d0dc9faf05a8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/plain-outliner/index.js\":\"2214f41fd7cb1817\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/plain-outliner/interactions.js\":\"64b6969b6aeafa29\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5e55618ddd8724d3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/MigrationGate.js\":\"46f1d84d0630b3f9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/MigrationGateDialog.js\":\"4ecb7420f823aa8d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/action.js\":\"6e0746f51f23c39c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/index.js\":\"e1ed526a1aff14cf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/localRunMessage.js\":\"850b689bbd7be0be\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/plugin.js\":\"7039b950af9f29fb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/progressReport.js\":\"27c9660223774df4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/sweepProgress.js\":\"a8fbe2937e9083c1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/FieldRowRenderer.js\":\"9c45c7da47289495\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/ValueRowRenderer.js\":\"0700e41816384662\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/actions.js\":\"ef3e24cfe1e7dccc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/autocomplete.js\":\"2893ed8fe2952d38\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/fieldRow.js\":\"9404f98cc976d43e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/index.js\":\"398a212b77e9f535\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/referenceWarning.js\":\"a78b341fae7769c0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/valueAutocomplete.js\":\"b4e047254bb5821d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/valueSchema.js\":\"c5fd8cfdee87fa3c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/HeaderItem.js\":\"885fb2ccc7ceceaf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/QuickFind.js\":\"8391c04433f7d1b7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/index.js\":\"085d3809c91d9492\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/recents.js\":\"fc0ece36ce928cc9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/resultItems.js\":\"7029de57c14b0316\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/selection.js\":\"899509a96e2da579\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/toggleStore.js\":\"53f8f0fbff0972c6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/HeaderItem.js\":\"4f80abcfeee77cdb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/RecentsPageBlockRenderer.js\":\"bc61172fb9150ea9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/grouping.js\":\"fbc64d250e67d694\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/index.js\":\"cc9ee496fc9c021b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/target.js\":\"c89249309d4cfbd5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/codeMirrorExtensions.js\":\"5d3aa13d3cdbae4c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/contentPrefill.js\":\"e39524e883c1d97c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/dataExtension.js\":\"72a18f61dad8a7ac\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/index.js\":\"a3205a3e19ec3e36\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c126d706a9a540ce\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/invalidation.js\":\"bc86faf4b69d149e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/localSchema.js\":\"dcb5c0116d481132\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/blockrefs/index.js\":\"3b7247768536811d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4c207126fb13b61a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/index.js\":\"68de100e62385bb3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/referenceNode.js\":\"4bfdec6dc6d674be\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cdb9f109201cc34a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"cb61b928b183c50d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/wikilinks/index.js\":\"efe80405dce9dbbf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d37ee2fe441aeb77\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7b93f3304bc9f5cf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/mergeRetargetProcessor.js\":\"0f07d7b88fad98d1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/parseFence.js\":\"ee746099677c3580\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/referenceParser.js\":\"16a7f84ec4ac3e66\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/referenceProjection.js\":\"e2fb54495f258d31\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/referencesProcessor.js\":\"fff3e4643fc04e94\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/renameProcessor.js\":\"e54576a2965c0727\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/spanReplacement.js\":\"6abc76f349581c72\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/rich-paste/htmlToOutline.js\":\"54b6a94f066bdb06\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/rich-paste/index.js\":\"57a84a0f576167a3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/rich-paste/normalizeClipboardDom.js\":\"202ce955e5d41014\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/rich-paste/pasteDecision.js\":\"02a62dc7906e2972\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/action.js\":\"649df02807d2e268\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/blockIds.js\":\"745af0fd9a8aec53\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/content.js\":\"01fa1e9ffd3f3475\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/effect.js\":\"582547783b8e3e77\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/ids.js\":\"62926e2e803aa391\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/import.js\":\"098d0df717e3739f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/index.js\":\"8a41b7ac72579861\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/plan.js\":\"142c7af6fa5164d2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/plugin.js\":\"72ce6034d6b09347\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/promotion.js\":\"5731b084af1c4323\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/properties.js\":\"490ef8c580533988\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/references.js\":\"870e31278fdb3490\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/report.js\":\"e67cb45fb5f507fb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/roamMemo.js\":\"823d2153f23722b2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/runtime.js\":\"712c9311a7fdfd21\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/schemaReconciliation.js\":\"e1129814587c5822\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/srsMarkers.js\":\"009954321341337c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/todo.js\":\"f3c7efd8c3c0e005\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/typeCandidates.js\":\"663fffd583b862b4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/types.js\":\"432c3ac466c5f524\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/search-health/index.js\":\"5701c5e9d7d7b271\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/search-health/store.js\":\"76cc86148046eaa0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/HeaderItem.js\":\"5333cd7fe84bd338\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"55c33d86be90f070\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/index.js\":\"9c91c73b2f2c21df\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/model.js\":\"d99645e37c68c91a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/toggleStore.js\":\"9ee8b3358706dd36\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/useKeyInspector.js\":\"21137355b0dedc3a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c78e6b5eabbf4698\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/ShellDecorator.js\":\"f4e1ba8d8e2b6009\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/actions.js\":\"ee4eb0093d5fac54\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b167a4e93442ba4b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/index.js\":\"eb1fbc669b866b23\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/shell.js\":\"fe4f856caa89ae1e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/surface.js\":\"abc2dfbda9bd8c11\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/walker.js\":\"4aa92c9668b87fe2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a2a16937094f2103\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/dataExtension.js\":\"b207007d21d786ef\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/index.js\":\"ca2a7cd1b58bbbdf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/indicator.js\":\"f29805f7920bfd3f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/moveSrsState.js\":\"7a1c1ef0b01eb444\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f5b44830d33df9c4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/scheduler.js\":\"19a9f73a9204c315\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/schema.js\":\"183d9a9ca7105464\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ff21e562b458cf8b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/srsClipboard.js\":\"df6f7715c4ed8675\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e0ab78e6132a116c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4bf347d1f9b9185b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/DeckPicker.js\":\"a6c393c26760adff\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/ReviewControls.js\":\"2ae77529084fc5f9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3a3839285f2e56bb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/ReviewSession.js\":\"ed573754481b8fc8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/actions.js\":\"f7b280db8f1fa33f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/archive.js\":\"ffb276aacf004d13\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/dataExtension.js\":\"d7603f5e6313fa3d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/deck.js\":\"5a63032b02a5dd0e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/dueQuery.js\":\"b85cca6f2499a315\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/gradeDecision.js\":\"710215046861168b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/index.js\":\"1ee53e9fc7ea2dff\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/keyHints.js\":\"b05709689f33b9d8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/reviewCardLayout.js\":\"7e172001430c4ddf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/reviewProgress.js\":\"36f8d406f9a63e39\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/schema.js\":\"980384eac0459428\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/useDueCards.js\":\"edd37e167e8d10e7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/startup-metrics/index.js\":\"cdf74832101efac8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/startup-metrics/record.js\":\"c2a4781151876643\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/storage-persistence/index.js\":\"9dd2739abec80bfe\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/storage-persistence/persistenceStatus.js\":\"413891dd4f541154\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/storage-persistence/requestAction.js\":\"c5d2d4c0006697a5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/supertags/TypeChipsDecorator.js\":\"fd413637850cd2af\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/supertags/codeMirrorExtensions.js\":\"b021258b01a07e02\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/supertags/index.js\":\"d4d0d40adf108fc3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/supertags/typeAutocomplete.js\":\"8a9bdceaed2938fb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e6e25ed7a536b0df\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/actions.js\":\"a0da3a7d15f9d9a6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/anchor.js\":\"e97a3196a5aa9946\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/events.js\":\"150108e4eb78530c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/gestureActions.js\":\"6d5e38d9c396522f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/index.js\":\"f638c2ff98348b56\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b077214de4da1ee5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/sync-metrics/collect.js\":\"62d2b3251a40d7bd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/sync-metrics/index.js\":\"23f7f88532fc3eb2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/sync-metrics/record.js\":\"3178e4f522942a51\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/RejectionDialog.js\":\"928e42f88c5249be\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/SystemStatusHeaderItem.js\":\"cf2b4c7cdc97bb6c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/index.js\":\"0a1886053e1b7d42\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/model.js\":\"03b18b8fff6a0273\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/queueCounts.js\":\"71d805afbc7a89f1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/rejectedHelpers.js\":\"4e839824ec9dbccb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/rematerializeAction.js\":\"b41cf645e02034c1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/useHysteresis.js\":\"d5bae4d1e74d9dc7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/ColumnHeaders.js\":\"d1e892b1ff3e07d4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/TableLayout.js\":\"377c66bb90485e63\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/actions.js\":\"debc27e69ed1a85d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/cellEdits.js\":\"df1d92b1ecd73faf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/columns.js\":\"75592b0d9f4a22d5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/controller.js\":\"3dce44905aa8fe69\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/convert.js\":\"a854cb1fdf3cbc2d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/dataExtension.js\":\"3b4e5ccc6549654a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/index.js\":\"932a567ddab32840\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/keys.js\":\"ede973b258fbf996\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/model.js\":\"0e0dc2d8be9282d7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/registry.js\":\"14a7d659cd45d1c2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/schema.js\":\"bdff5b871106038f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/theme-toggle/effect.js\":\"30be762e36a2de82\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/theme-toggle/index.js\":\"30b7fc9bff006d12\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/theme-toggle/theme.js\":\"c44be2be8b7a93b4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/todo/actions.js\":\"2db3f559893d3b38\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/todo/dataExtension.js\":\"e6630562508b28e0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/todo/index.js\":\"d51b572d78732863\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/todo/schema.js\":\"dfdab068132b5530\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/TouchSelectionLayer.js\":\"014a25b8c28583fa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/actions.js\":\"6244ab3d13549b40\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/defaultItems.js\":\"b97341288431dc9e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/facet.js\":\"84676b1433872b3f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/holdRecognizer.js\":\"f9251b7c6c51c433\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/index.js\":\"6ddf4db6f45175a3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/update-indicator/UpdateIndicator.js\":\"bfddc6253ac70885\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/update-indicator/index.js\":\"d6fe20367e2127bf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/update-indicator/loadTimes.js\":\"ff8266983d81c5c4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/VideoNotesRenderer.js\":\"cedab2c43ede62a2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/VideoPlayerRenderer.js\":\"e439dc4c1824422f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/VideoTimeStamp.js\":\"0d97e2f7e6c3450b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/actions.js\":\"a00b9cc60bc1b571\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/index.js\":\"9c130b7eb7790b39\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/markdown.js\":\"c5521ab6a4489751\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/notes.js\":\"812655db8c0acde3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/registry.js\":\"1315029d588e93e4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/remark-timestamps.js\":\"3496085f64334ddd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/view.js\":\"6937108a92a56f08\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-link-hints/LinkHints.js\":\"c761cf3ba9ff6ef3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-link-hints/index.js\":\"7cd341c2281b004d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-link-hints/model.js\":\"a7a0692cd837f7d1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-link-hints/settings.js\":\"958597bb316b46a1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-normal-mode/actions.js\":\"9991c1fcae0f11e4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-normal-mode/index.js\":\"5a808dafbde88556\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-normal-mode/interactions.js\":\"3532240e504fe077\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/workspace-header/index.js\":\"b4cdcdf5ac5990eb\",\"/knowledge-medium/pr-preview/pr-1830/src/registerServiceWorker.js\":\"781c8fe8f74c4794\",\"/knowledge-medium/pr-preview/pr-1830/src/requestPersistentStorage.js\":\"c7c948d7371e9820\",\"/knowledge-medium/pr-preview/pr-1830/src/services/authRequestDeadline.js\":\"53cd0d3ca9b3599d\",\"/knowledge-medium/pr-preview/pr-1830/src/services/authStorage.js\":\"8c754e573bd7e10e\",\"/knowledge-medium/pr-preview/pr-1830/src/services/powersync.js\":\"65c62d4873db1af8\",\"/knowledge-medium/pr-preview/pr-1830/src/services/supabase.js\":\"83e06c86073f75ed\",\"/knowledge-medium/pr-preview/pr-1830/src/services/uploadErrorClassifier.js\":\"996f5ae750aa1136\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/ActiveContexts.js\":\"ccbaa103c4053288\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/HotkeyReconciler.js\":\"a48834023fe96848\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/WipeLocalDataDialog.js\":\"1e6722fc319f081f\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/actionDispatch.js\":\"98d628a2aa01965c\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/actionRefItems.js\":\"d4c5be1f30140b68\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/applyKeybindingOverrides.js\":\"9a8bb94f8fa216ae\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/blockActions.js\":\"04bbb0b516473257\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/canonicalizeChord.js\":\"bf4120c0de6f8ab1\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/defaultContexts.js\":\"90bcddb3f8c46be9\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/defaultShortcuts.js\":\"ca39c977710ea5ed\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/effectiveActions.js\":\"bebd69490893f5af\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/gestureAction.js\":\"2b3c38f7bde74455\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/gestureBinding.js\":\"7f4c394772961e94\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/holdRegistry.js\":\"17215d24894a44df\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/keybindingConflicts.js\":\"f2d9e48bfa213025\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/keybindingOverrides.js\":\"f352f53213756dfa\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/pointerAction.js\":\"575e4f0eff324351\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/resolve.js\":\"b0f74d02501c8bbd\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/runAction.js\":\"007cdfdef38858ac\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/sequenceMatcher.js\":\"b4e34f9b5a5357d4\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/types.js\":\"d5831a764e17cd8b\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/useActionContext.js\":\"f5947492f9b1f7f1\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/useActionDiscovery.js\":\"e80c3ab9aa6d5881\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/utils.js\":\"d648e287d593c457\",\"/knowledge-medium/pr-preview/pr-1830/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1830/src/sw/bootStore.js\":\"65730c92920725a5\",\"/knowledge-medium/pr-preview/pr-1830/src/sw/previewDatabases.js\":\"8025f6c95cfc7543\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/byteTransform.js\":\"6231dbd10df16807\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/attachmentCleaner.js\":\"cf3263b230c59c7c\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/attachmentParts.js\":\"32c368dea1fec2bb\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/bundleParts.js\":\"46850d0458366a74\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/bundleRecord.js\":\"eb090b3acbc86f43\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/manifest.js\":\"fddac4e26ce76812\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/takeBundle.js\":\"ce13ef03499973ce\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/verifyBundle.js\":\"0242472b5211ad78\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/cleaningStage.js\":\"e07bcb635e74faa7\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/conversionKey.js\":\"e11b80faf644f631\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/conversionServer.js\":\"22586a4283dd2e6f\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/flip.js\":\"e521ffb7febd0725\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/flipAttempts.js\":\"0bbc710481511880\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/pages.js\":\"2700296b08b228e2\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/preflight.js\":\"af4b88abb31c89cb\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/reseal.js\":\"14c0734b9982b36d\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/runConversion.js\":\"d4d8f38a6c7e858e\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/runLock.js\":\"2fd99fb1b20b0d27\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/sealing.js\":\"71d9fe5dfdac7f3f\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/sealingStage.js\":\"e5c17322c676d389\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/stage.js\":\"95628b08c0a947f1\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/verifyReseal.js\":\"babce36b4e4761a5\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/aad.js\":\"7d46eb25cf041c10\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/aead.js\":\"2e89c6e16ae48de2\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/base32.js\":\"62d72a8d2803aaef\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/base64url.js\":\"1a64f35c9e1e3dc8\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/binaryEnvelope.js\":\"a10ad5007594fe3c\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/byteAead.js\":\"f8481904b28ccf19\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/canary.js\":\"c5f0370043cb8ded\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/contentHash.js\":\"4ef2873543af2bc2\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/contentKey.js\":\"12f9b5efc23e2d0d\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/derivedIdNamespace.js\":\"1bab714ef1819eb2\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/envelope.js\":\"265c618044bce48a\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/hex.js\":\"a221f0240bcc60c1\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/sha256Hex.js\":\"bbd2fe2c31d83f65\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/workspaceKey.js\":\"75c1053185e25e5b\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/conversionState.js\":\"2dbe4b1490dedf25\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/flows/createEncryptedWorkspace.js\":\"45174528652df2b1\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/flows/pastedKey.js\":\"0cf83ba2295cc1a3\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"0a2dc302583a6260\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7e4b59f241aaa5f6\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/keyStore.js\":\"9c6b3f00fa3cd979\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/mintWorkspaceKey.js\":\"3df16937aadd123a\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/modePin.js\":\"88ce675cd468913c\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/openWorkspaceKeys.js\":\"068a29ad9e95f1dc\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/resolveWorkspaceEntry.js\":\"43d5c71cceb44dbd\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/resolver.js\":\"0347c21c944a6c46\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/workspaceAccess.js\":\"874d917c447e3ab4\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/transform.js\":\"eff8391dcf195983\",\"/knowledge-medium/pr-preview/pr-1830/src/themeBootDefaults.js\":\"adb4329ea19a7022\",\"/knowledge-medium/pr-preview/pr-1830/src/types.js\":\"b2d24e057a9d059c\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/ClientLocalSettings.js\":\"f822eb656c0b99b7\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/abortableSleep.js\":\"81903d6a9f947166\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/array.js\":\"4cdeec2e150361d0\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/backlinkAutocomplete.js\":\"ae0f4761431d1855\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/blockCrumbs.js\":\"90b6920769bdc4b1\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/blockrefAutocomplete.js\":\"cb8eef02393133f1\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/cadencedIdleJob.js\":\"cde238c2a07a127e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/callbackSet.js\":\"1d9b14e937b7f7b7\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/clientId.js\":\"c53ba4ee715e760f\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/codemirror.js\":\"4939b54205b1d089\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/codemirrorCompletion.js\":\"74e8bca5cd566135\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/copy.js\":\"143a0d3727df0902\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dailyPage.js\":\"cd620230155c0dfd\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dbForensics.js\":\"0afc476607f9c5fa\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dbForensicsHooks.js\":\"cc51b2f699bc7ed7\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/deleteBlockThroughUi.js\":\"538d6983a2037cdb\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dialogs.js\":\"2e475e9aacc88a94\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dom.js\":\"bcd1b33bd74be81b\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/downloadBlob.js\":\"520556367c0084f2\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/exportSqliteDb.js\":\"bc3bee25b1706546\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/fileSystemAccess.js\":\"898fde677b7ca575\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/flipSlide.js\":\"d2eac01bb4af66fd\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/fnv1a.js\":\"5253d53ff335c1ac\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/formatBytes.js\":\"b9300d4928846d48\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/fuzzyRank.js\":\"cb2ab8a9108dc6d4\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/idbKeyedStore.js\":\"11340305715f428a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/idleCallbackPolyfill.js\":\"cf626b37d65ae2cc\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/keyboardAwareScroll.js\":\"7972b381cc407767\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/keyboardViewport.js\":\"190aec734320bea0\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/lastWorkspace.js\":\"8d05f56ce48f0856\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/layoutColumns.js\":\"28285b97ed2448be\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/layoutSessionDom.js\":\"542357eb1985c320\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/layoutSessionId.js\":\"99cc8c86e3ffe4fb\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/linkClickGestures.js\":\"9674e3ea0cca8e12\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/linkTargetAutocomplete.js\":\"44eb2ec3e4fcbe84\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/localDbCorruption.js\":\"00f183b92f354978\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/localDbRecovery.js\":\"698d20c5ac2e9308\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/markdownParser.js\":\"c4185277334f5d58\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/memoize.js\":\"2273cc0141f020e7\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/nameFieldCommit.js\":\"95c8292a2f62675d\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/nameList.js\":\"8d6413db1948bcf6\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/navigation.js\":\"2afc90978bb3e422\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/omnilinerNamespace.js\":\"b87de3d5e4901f06\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/opfsPageScan.js\":\"3d540c9e7d2775db\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelClearance.js\":\"ccab61ea06a6e97a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelHistory.js\":\"1a88a1eabb67c30f\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelLanes.js\":\"035b2357806661c6\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelLayoutProjection.js\":\"707968f66c297c64\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelScrollAnchor.js\":\"d93aedf13b918342\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelUrlFlags.js\":\"5ff6601629cfcfbd\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/platform.js\":\"234f19a4198a1935\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/pluralize.js\":\"22f3e8022a08010d\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/propertyCreation.js\":\"c9a7b54310ed8cad\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/propertyNavigation.js\":\"ea9f30c53ac86908\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/propertyValueContext.js\":\"f36ee05824f9c8c6\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/react.js\":\"0a5dea25c249bd3a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/relativeDate.js\":\"41cf0f69bd0c7353\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/relativeTime.js\":\"5916ccd7b6d67f34\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/renderScope.js\":\"1c3b2aaf963cdb46\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/resolvedThenable.js\":\"e83fd1056d6bcd8e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/routing.js\":\"89047967ecb7483b\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/safeMode.js\":\"8b3c09a8c472b1d4\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/scheduleIdle.js\":\"f870ee04e5c688df\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/screenWakeLock.js\":\"be17cd03459a0534\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/selection.js\":\"b4f557aa89769a4a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/softKeyboardGrab.js\":\"d07e224c9b012554\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/startupTimeline.js\":\"d8db78f920d6bb11\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/state.js\":\"7c4ba886ba0a72de\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/string.js\":\"9788130c390fc22f\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/surfaceZoom.js\":\"5a74767717d0ef3e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/time.js\":\"e811acb9a9586aa5\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/toast.js\":\"2191aa6991601634\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/toggleStore.js\":\"d21a062be7f77c9d\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/untilStopped.js\":\"b79681f6d44052f8\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/userActivity.js\":\"f7902d49564a11e6\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/viewTransition.js\":\"33bad8ab0a8a8815\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/viewport.js\":\"52d0b5f07c43e752\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/webLock.js\":\"bccd6a608a14c70f\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/workspaceRecovery.js\":\"2f54e1307dc78f6e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/workspaceSnapshotStore.js\":\"7c65a2ff005219c5\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-compiler-runtime.js\":\"558051747a676281\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-client.js\":\"2b520d549a0990a5\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-server-edge.js\":\"8bad5d2a97f8cbb3\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-server.js\":\"364ff76d3b67ad36\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-static-edge.js\":\"2b8e2396b12b3b2a\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-static.js\":\"ae3b859cacd1ecb0\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-test-utils.js\":\"d2df15e14ebd0d5c\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom.js\":\"64b72f542a5f9112\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-jsx-runtime.js\":\"f92c252a2cc5c905\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react.js\":\"07345d98c58496d8\",\"/knowledge-medium/pr-preview/pr-1830/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1830/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1830/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
