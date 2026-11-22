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
		buildId: "525ae8318a83-22d07e72",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1830/\":\"2989d84a020d573c\",\"/knowledge-medium/pr-preview/pr-1830/index.html\":\"2989d84a020d573c\",\"/knowledge-medium/pr-preview/pr-1830/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1830/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1830/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1830/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1830/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1830/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1830/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1830/assets/FacadeVFS-lXAdo3mj.js\":\"8f47ab05b48196be\",\"/knowledge-medium/pr-preview/pr-1830/assets/OPFSCoopSyncVFS-k_pqLFUx.js\":\"8c12a91281dc5c6b\",\"/knowledge-medium/pr-preview/pr-1830/assets/OPFSWriteAheadVFS-1W68GdY1.js\":\"4e715c778e8e69c8\",\"/knowledge-medium/pr-preview/pr-1830/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1830/assets/wa-sqlite-XeQHwO4S.js\":\"4b379a3aa3f6ee31\",\"/knowledge-medium/pr-preview/pr-1830/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1830/assets/wa-sqlite-async-DyRRJ1OS.js\":\"df4f84609c5aeb02\",\"/knowledge-medium/pr-preview/pr-1830/assets/worker-Cu_pE7Tt.js\":\"f687f445d275d748\",\"/knowledge-medium/pr-preview/pr-1830/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1830/chunks/app-nVeEnPIV.js\":\"7033f1dbf430a2d1\",\"/knowledge-medium/pr-preview/pr-1830/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1830/index.js\":\"43fcef8b656631c8\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1830/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1830/assets/AccessHandlePoolVFS-D4_29QoR.js\":\"db415b83e89e53a2\",\"/knowledge-medium/pr-preview/pr-1830/assets/IDBBatchAtomicVFS-CSdkyuOh.js\":\"05218ed38bed125b\",\"/knowledge-medium/pr-preview/pr-1830/assets/MemoryVFS-Bi4VOFWq.js\":\"efa0107f13f0340f\",\"/knowledge-medium/pr-preview/pr-1830/assets/mc-wa-sqlite-B9Jwm51W.js\":\"31258118db1063f1\",\"/knowledge-medium/pr-preview/pr-1830/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1830/assets/mc-wa-sqlite-async-DT0Jup25.js\":\"e2024ddf8f58b9fd\",\"/knowledge-medium/pr-preview/pr-1830/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1830/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1830/chunks/AccessHandlePoolVFS-B20MlkMU.js\":\"9c8ea045e6a89d67\",\"/knowledge-medium/pr-preview/pr-1830/chunks/FacadeVFS-wO5yN-Qt.js\":\"fca5d4e3b151b12f\",\"/knowledge-medium/pr-preview/pr-1830/chunks/IDBBatchAtomicVFS-a6gqAu_P.js\":\"7e4c463ea7f5043d\",\"/knowledge-medium/pr-preview/pr-1830/chunks/MemoryVFS-Chf0_j27.js\":\"ff437c8833bb93e2\",\"/knowledge-medium/pr-preview/pr-1830/chunks/OPFSCoopSyncVFS-DskwEf3e.js\":\"2d24f5c686435751\",\"/knowledge-medium/pr-preview/pr-1830/chunks/OPFSWriteAheadVFS-BOfb11YU.js\":\"793e79654a641c6c\",\"/knowledge-medium/pr-preview/pr-1830/chunks/Preview-CmI9vSrd.js\":\"66332f01f2d34d36\",\"/knowledge-medium/pr-preview/pr-1830/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1830/chunks/card-D3wrbgdW.js\":\"1b2dcad63848f8bd\",\"/knowledge-medium/pr-preview/pr-1830/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1830/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1830/chunks/dist-BezbX-2K.js\":\"b3feef27437cb193\",\"/knowledge-medium/pr-preview/pr-1830/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1830/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1830/chunks/mc-wa-sqlite-BIUSPnHF.js\":\"8622e535cea3535b\",\"/knowledge-medium/pr-preview/pr-1830/chunks/mc-wa-sqlite-async-BkpVEvqj.js\":\"793d6951c811870e\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-6wF3fiLz.js\":\"167fce4f714bc20c\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-AurYW7B5.js\":\"2ef34e42fb6c8e32\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-BXR0gOn-.js\":\"e9298d87ce576509\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-CJ7QjVzo.js\":\"28731d98ff1b6c78\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-CSSJ7qqP.js\":\"f0299f0d6eb9fa3d\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-CYcrP_o1.js\":\"edb8fc2c6159e5be\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-Cp_smwt_.js\":\"d94c3492a2b5c970\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-D8KjXAmh.js\":\"35f4599ea22118e5\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-dom-server-legacy.browser.production-Ch9xT1qN.js\":\"2177cc5d2d93fc4a\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-dom-server.browser.production-YSzsA56r.js\":\"ddd2b951508ccd36\",\"/knowledge-medium/pr-preview/pr-1830/chunks/react-dom-server.edge.production-Da3K798q.js\":\"92095ddd12336926\",\"/knowledge-medium/pr-preview/pr-1830/chunks/server.browser-BnmdPOJ8.js\":\"68ec2241987cceda\",\"/knowledge-medium/pr-preview/pr-1830/chunks/textarea-D0hQJT_P.js\":\"faf10d68955fff0f\",\"/knowledge-medium/pr-preview/pr-1830/chunks/ui-BPatiYV3.js\":\"f711ba65878e1e71\",\"/knowledge-medium/pr-preview/pr-1830/chunks/wa-sqlite-CWQQ97lK.js\":\"d73857693c584e1b\",\"/knowledge-medium/pr-preview/pr-1830/chunks/wa-sqlite-async-CPeLtpFW.js\":\"338e0ad8b7c4edef\",\"/knowledge-medium/pr-preview/pr-1830/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1830/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1830/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1830/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1830/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1830/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1830/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1830/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1830/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1830/src/App.js\":\"1bc3c3bac83b570c\",\"/knowledge-medium/pr-preview/pr-1830/src/appUpdate.js\":\"9f41fc2814a0b835\",\"/knowledge-medium/pr-preview/pr-1830/src/appVersion.js\":\"7673609123734989\",\"/knowledge-medium/pr-preview/pr-1830/src/bootstrap/initialLayout.js\":\"ae7337e3279019f4\",\"/knowledge-medium/pr-preview/pr-1830/src/bootstrap/openWorkspaceData.js\":\"ddb381a313f1b3b7\",\"/knowledge-medium/pr-preview/pr-1830/src/bootstrap/resolveWorkspace.js\":\"7cf42615282b5a60\",\"/knowledge-medium/pr-preview/pr-1830/src/bootstrap/workspaceBootstrap.js\":\"29567888f6ad924e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockComponent.js\":\"7962df9f692e0312\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockCrumbs.js\":\"e62ad413b503061d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockEditor.js\":\"853c01f26f00dd91\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockLoadingPlaceholder.js\":\"2b4aff63906ee72b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockProperties.js\":\"6f6794d26051f188\",\"/knowledge-medium/pr-preview/pr-1830/src/components/BlockSearchPicker.js\":\"b07189402e597915\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ConfirmBulkDeleteDialog.js\":\"233b941b8a01e8d9\",\"/knowledge-medium/pr-preview/pr-1830/src/components/DividerHandle.js\":\"90fdde1d5afd9504\",\"/knowledge-medium/pr-preview/pr-1830/src/components/DraftEditor.js\":\"c3d3b2fd02637e5d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/GutterPill.js\":\"344122832e121dd7\",\"/knowledge-medium/pr-preview/pr-1830/src/components/Header.js\":\"7b9fdc75e22a06ad\",\"/knowledge-medium/pr-preview/pr-1830/src/components/LazyBlockComponent.js\":\"b520ea04da058e93\",\"/knowledge-medium/pr-preview/pr-1830/src/components/Login.js\":\"29759d49dc8df130\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ZoomableSurface.js\":\"f3eaca1bf207ba94\",\"/knowledge-medium/pr-preview/pr-1830/src/components/editModeKeepalive.js\":\"37710dac0d27b639\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9a0fce7c049e59bc\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b9dd6ca02dbc47a0\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/RefPropertyEditor.js\":\"1445afc39e77b9a8\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/RefTargetTypePicker.js\":\"e1e19dfd7160523c\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/SelectPropertyEditor.js\":\"73002bf9642e2d4d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/TypesPropertyEditor.js\":\"8383ac98f90b153f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/defaults.js\":\"1dc76e9bfdaefe7b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/kernelValuePresets.js\":\"0925b749dbe038d4\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/selectablePresets.js\":\"d93362a0fa31cdfe\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyEditors/typesPropertyUi.js\":\"571f8fce6beaf792\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/AddPropertyForm.js\":\"ddfa0459d7a2de67\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/PropertyPicker.js\":\"e90749d10962ac50\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/PropertyRow.js\":\"d8a28b422e20ea30\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/Rows.js\":\"f75ca07cfbb29e8b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/actions.js\":\"ec7cfd7e5914d09b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/declarationOnly.js\":\"39cf4b885490107d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/layout.js\":\"d582ab081bfc32ee\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/model.js\":\"9eebb98e89742008\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/shapeUi.js\":\"c6d2b1c731a1fea0\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/shapes.js\":\"9a79a2fc32740761\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/usePropertyEditingActivation.js\":\"417e1a5fb1a8ce90\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanel/visibility.js\":\"2c59c94c41ece456\",\"/knowledge-medium/pr-preview/pr-1830/src/components/propertyPanelSections.js\":\"8edf3acd98a0fcf6\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/BlockEmbed.js\":\"1f5c2252e7386c5c\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/BlockLink.js\":\"d3a35da8efeca91e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/BlockRef.js\":\"707e7d3f0f756981\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/ReferenceLink.js\":\"3ff1263704ef60e5\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/cycleGuard.js\":\"0fd137aab0916b7d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/cycleGuardContext.js\":\"79eaac7a00852d19\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/linkInteraction.js\":\"bc6fd70e5ef8e09f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/referenceLayout.js\":\"b03ed855bfd04367\",\"/knowledge-medium/pr-preview/pr-1830/src/components/references/useBlockRefAncestors.js\":\"28464721baf46956\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/BlockGutter.js\":\"fc869d099e5dcbc3\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/BlockInfoDialog.js\":\"ae45dadcd65d8d04\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/BlockTypeBlockRenderer.js\":\"64b25aad9858e46b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/BulletHoverCard.js\":\"c950c76950f04145\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/CodeMirrorContentRenderer.js\":\"ab3a4a4a77a693b9\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"aa9fbcccbfe8cb8f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/ColumnResizeHandles.js\":\"7bbec6b61e447231\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"925f3cce4de898ba\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/DefaultBlockRenderer.js\":\"573372be39f81b9c\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/LayoutRenderer.js\":\"e15926d31a0eaf8e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/MarkdownContentRenderer.js\":\"ffad6657356cb704\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/MissingDataRenderer.js\":\"c963cacea5035a6a\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/PanelRenderer.js\":\"8d76dd67fbc8475f\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f65582c426e115dd\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/TopLevelRenderer.js\":\"5db29db030c3bea9\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/blockGutterMode.js\":\"864d21775395ec54\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/blockTitleText.js\":\"3812b2db45e9ea6d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/fieldCreationKeydown.js\":\"9ba4d5441244c94d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/renderer/layoutRootContext.js\":\"47f0c558f5f33e7e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/typeChip/TypeChip.js\":\"6134c74d571a6b15\",\"/knowledge-medium/pr-preview/pr-1830/src/components/typeChip/chipStyle.js\":\"69984a7fe223faca\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/anchored-floating.js\":\"e494e76711035e99\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/button.js\":\"99f9aa8eef125834\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/card.js\":\"72abbc47b38d6935\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/checkbox.js\":\"39ba2bc4f128e327\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/collapsible.js\":\"e7dde30df62aaa5d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/command.js\":\"3451bc2f73029b99\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/context-menu.js\":\"a0c87804075b5fca\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/dialog.js\":\"e93d3ac9a3d2594b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/dropdown-menu.js\":\"0c00f7fa6cf63c7d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/floating-listbox.js\":\"5d61f63378cfa2b4\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/index.js\":\"44492bbc79e4a654\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/input.js\":\"cdfc2b411c58071b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/kbd.js\":\"66f41ffa4d920a51\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/label.js\":\"93d6614ddf9cc8bf\",\"/knowledge-medium/pr-preview/pr-1830/src/components/ui/textarea.js\":\"582353e477a65129\",\"/knowledge-medium/pr-preview/pr-1830/src/components/useEditModeYieldKeepalive.js\":\"f4d0d1a39cca030e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/BootFallback.js\":\"27f462da7916e1c5\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/FocusedRowLazyMount.js\":\"eaa7b38c88601d06\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/LazyViewportMount.js\":\"c313b1009cbddc9e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/LocalDbCorruptionFallback.js\":\"a5cdd6e5c4de7152\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/error.js\":\"b665bf20ea580733\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/lazyMountRegistry.js\":\"9be22408b7899596\",\"/knowledge-medium/pr-preview/pr-1830/src/components/util/suspense.js\":\"1ae8e9d203cea9b3\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/CreateWorkspaceDialog.js\":\"b82f513c6056c5ff\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/PendingInvitations.js\":\"8984940680b9ee2b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/SyncProgress.js\":\"561209631402b18c\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/UnlockProgress.js\":\"7da3243696b5118e\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/WorkspaceKeyGate.js\":\"1c5012d4bcac4670\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/WorkspaceSettingsDialog.js\":\"45ddf0bd5532c459\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/WorkspaceSwitcher.js\":\"ff48535ec9b3066d\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/WorkspaceSyncGate.js\":\"539e2d031347832b\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/ConversionFlow.js\":\"0eeaf4ad3133d117\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/ConversionFlowHost.js\":\"d4ca58c5cef78d29\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/EncryptionSection.js\":\"96bdd21aa4d72967\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/attachmentPrompts.js\":\"619ab39c6ca29748\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/bundleFolderPrompts.js\":\"265719734ac81624\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/conversionFlowDeps.js\":\"2b4624e362e7f618\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/conversionFlowStore.js\":\"cf442ae56da5ffa2\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/flowUi.js\":\"cfc604ae131c98a1\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/conversion/useConversionRun.js\":\"5612a879e525affc\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/keyUi.js\":\"ca85a6a9cd8065b1\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/useCloseOnKeyLoss.js\":\"a7d9f58e2eab3304\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/useCloseOnServerE2ee.js\":\"eb3e179a5ede39f2\",\"/knowledge-medium/pr-preview/pr-1830/src/components/workspace/workspaceUnlocked.js\":\"f322c4bf810cea8f\",\"/knowledge-medium/pr-preview/pr-1830/src/context/backgroundSubtree.js\":\"2b5afd9202553945\",\"/knowledge-medium/pr-preview/pr-1830/src/context/block.js\":\"e6f70af568f4e873\",\"/knowledge-medium/pr-preview/pr-1830/src/context/layoutWsContext.js\":\"b21015199d325e31\",\"/knowledge-medium/pr-preview/pr-1830/src/context/propertyDisplay.js\":\"77b4c1c274a87ea3\",\"/knowledge-medium/pr-preview/pr-1830/src/context/repo.js\":\"842b1057ff871ccd\",\"/knowledge-medium/pr-preview/pr-1830/src/data/aliasClaim.js\":\"3c953e59c2a57211\",\"/knowledge-medium/pr-preview/pr-1830/src/data/aliasSeatNamespace.js\":\"05ce1fe4d0343e98\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/blockData.js\":\"38b5b84c63d4b346\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/blockType.js\":\"0f78a66331687122\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/changeScope.js\":\"f0686d4eb99dd7ab\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/codecs.js\":\"c1e5168da3e606f8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/derivedData.js\":\"d8479ab71354705c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/errors.js\":\"864cf01f68466439\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/events.js\":\"d2a6c43423e2c13c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/handle.js\":\"3ae353056145ccac\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/index.js\":\"350add272d555c0f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/mutator.js\":\"88d88dea008fb05c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/processor.js\":\"455520fe853663f2\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/propertySchema.js\":\"5a4f64f6f08c3f1f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/query.js\":\"68d75e43f43531a4\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/sameTxProcessor.js\":\"5d212825c39331c0\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/schema.js\":\"3ae353056145ccac\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/tx.js\":\"3ae353056145ccac\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/typedBlockQuery.js\":\"065ebaead5f30250\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/user.js\":\"40309bb2f0620726\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/valuePresetCore.js\":\"cb09a133be217176\",\"/knowledge-medium/pr-preview/pr-1830/src/data/api/valuePresets.js\":\"3ba036bb204edae7\",\"/knowledge-medium/pr-preview/pr-1830/src/data/attachmentCleanerIOVerb.js\":\"d9c56d541ab7446b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/block.js\":\"711b81dd083c04d8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockCache.js\":\"c96c813076e91e83\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockId.js\":\"17b2691d570e43e8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockLiveness.js\":\"7b63b6250331311c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockMerge.js\":\"7b3e09d800031ff1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockSchema.js\":\"5507ba130c42315e\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockTypeLookup.js\":\"29107ae2a18bd65a\",\"/knowledge-medium/pr-preview/pr-1830/src/data/blockTypes.js\":\"84b49e49f3e2902f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/clientContext.js\":\"f44c99453d833894\",\"/knowledge-medium/pr-preview/pr-1830/src/data/dbFileSiblings.js\":\"56a865e29974a3cf\",\"/knowledge-medium/pr-preview/pr-1830/src/data/definitionSeeds.js\":\"c4775e702a8fa36c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/derivedIds.js\":\"9c77439eb72c6fe8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/drawnSubtree.js\":\"898e4c6c173e1d66\",\"/knowledge-medium/pr-preview/pr-1830/src/data/facetBridge.js\":\"93c2add62a5a2a35\",\"/knowledge-medium/pr-preview/pr-1830/src/data/facets.js\":\"abe00e7431d1c8c0\",\"/knowledge-medium/pr-preview/pr-1830/src/data/globalState.js\":\"3f75bdb26d6c9381\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/aliasClaimRederiveProcessor.js\":\"b4f97ecd8f94ad7b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/ancestorBatch.js\":\"0cb6b0bcdfe366ac\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/blockTypeTypeifyProcessor.js\":\"7ae1119b3721dfa6\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/clientSchema.js\":\"4e3dd36cffc21fc3\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/commitPipeline.js\":\"9b57315f0a5befdb\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/devAssertions.js\":\"35fe990bc5a455a1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/firstSync.js\":\"d6074de9ffab810f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/freshInitialLoad.js\":\"e9e21db409414831\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/graphBackfillClaim.js\":\"61a70d148d42f086\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/handleStore.js\":\"eab3f2199ed08135\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/idleMarkerJobs.js\":\"39641616574aa25c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/initialDownload.js\":\"cedc950ab3fac356\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/initializeClientDatabase.js\":\"0e275a61f3d53a43\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/jsonCanonical.js\":\"c95d3c07e5f984c4\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/kernelInvalidation.js\":\"dc36203c47c8ba3d\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/kernelProcessors.js\":\"740148568af22a39\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/kernelQueries.js\":\"8974e37c9beac297\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/mergeTypeMembershipProcessor.js\":\"45cc9aac2ace4d15\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/normalizeReferencesProcessor.js\":\"361392711c3eba98\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/poolInstrumentation.js\":\"5293b592f7222f00\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/processorRunner.js\":\"0961bd0334deb944\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyCellBackfill.js\":\"15b1b713bfce96a8\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyChildMint.js\":\"ba0a924c07eec2c1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyChildrenProcessor.js\":\"b09857fd0cda22cd\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyDefinitionChangeProcessor.js\":\"30e4c05a2ba371d5\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyDefinitionSynthesis.js\":\"721468056282a125\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyKeyScan.js\":\"f14cad9f9d369317\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertySchemaResolution.js\":\"d2ae7b7a81c315ca\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/propertyValueEdits.js\":\"07aa16cd33f2e0ae\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/raiseProtocol.js\":\"0771f1d03028dd24\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/readBatch.js\":\"5bb7597545fc3046\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/refProjection.js\":\"93de440cc68ffc18\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/referenceTargetLookups.js\":\"01dfd9a28d4276bd\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/referenceTargetProcessor.js\":\"a9c2264ed4ef56e1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/replayMerge.js\":\"e1bcdc10361dfc78\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/sqlBinds.js\":\"ad36dc42c4f80a37\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8b293b7916208b4c\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/arrivalProcessors.js\":\"74607331269b1297\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/invalidate.js\":\"17c758e9ae91b66d\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/materialize.js\":\"2bd542f3174520d7\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/observer.js\":\"c6dede0470503873\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/syncObserver/reconcile.js\":\"dfd01a6d548d4aa5\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/timingMetrics.js\":\"47ce4c251f2352a3\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/treeQueries.js\":\"3a9a7c07e037ceb3\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/txEngine.js\":\"5fe6ed41ec739a06\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/txSnapshots.js\":\"6fd650329d20730a\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/typedBlockQuery.js\":\"39b641c7386f08c3\",\"/knowledge-medium/pr-preview/pr-1830/src/data/internals/undoManager.js\":\"4c3dc4794e22c7f9\",\"/knowledge-medium/pr-preview/pr-1830/src/data/invalidation.js\":\"1f8d3cb270a61380\",\"/knowledge-medium/pr-preview/pr-1830/src/data/kernelDataExtension.js\":\"384e166ff28e0a85\",\"/knowledge-medium/pr-preview/pr-1830/src/data/kernelPage.js\":\"9a5ebd903c2e134e\",\"/knowledge-medium/pr-preview/pr-1830/src/data/kernelValuePresetCores.js\":\"7ca16e3541206270\",\"/knowledge-medium/pr-preview/pr-1830/src/data/localDbCorruptionSignal.js\":\"6da465451383dfee\",\"/knowledge-medium/pr-preview/pr-1830/src/data/localDbStorage.js\":\"4f154c7ebf3561d1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/localDbVfs.js\":\"40e5d4bb9a525ff0\",\"/knowledge-medium/pr-preview/pr-1830/src/data/localSchema.js\":\"55fcf7abb267d462\",\"/knowledge-medium/pr-preview/pr-1830/src/data/maintenance.js\":\"81e5f2371ca575ae\",\"/knowledge-medium/pr-preview/pr-1830/src/data/mergeProperties.js\":\"ba5a145516d0a90b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/metricsConsoleHook.js\":\"cc05ad86c5879e73\",\"/knowledge-medium/pr-preview/pr-1830/src/data/migrationsPage.js\":\"a6a6b3bc68c5f71f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/mutators.js\":\"80b2e4beec9c5e34\",\"/knowledge-medium/pr-preview/pr-1830/src/data/orderKey.js\":\"36215f650b3e13a4\",\"/knowledge-medium/pr-preview/pr-1830/src/data/orderKeyPlacement.js\":\"9e7be382c57c5d68\",\"/knowledge-medium/pr-preview/pr-1830/src/data/outlineSurface.js\":\"f62c9bda1b433991\",\"/knowledge-medium/pr-preview/pr-1830/src/data/pendingEditorContent.js\":\"9cce7c5571409420\",\"/knowledge-medium/pr-preview/pr-1830/src/data/pendingUploadsSql.js\":\"3bd84384d25dff79\",\"/knowledge-medium/pr-preview/pr-1830/src/data/pluginStateExtensions.js\":\"bd13eab451ce2e6d\",\"/knowledge-medium/pr-preview/pr-1830/src/data/powerSyncLogger.js\":\"68db1d8258b5b600\",\"/knowledge-medium/pr-preview/pr-1830/src/data/projectorRuntime.js\":\"65100665c4734510\",\"/knowledge-medium/pr-preview/pr-1830/src/data/properties.js\":\"c1b15eb07ceee116\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertiesPage.js\":\"52a59804de1ca3d2\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyChildren.js\":\"6d58d73eefcf20f5\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyDefinitionFanout.js\":\"f841898d70287c8a\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyDefinitionMetadata.js\":\"41792468cb7e74c6\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyDefinitionRegistry.js\":\"edfa3d4aaba788d1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyDisplayMode.js\":\"26b912d93d40192a\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertyRowCreation.js\":\"d5259a0605f8ee79\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertySchemaCreation.js\":\"0791d9a1dfa9014d\",\"/knowledge-medium/pr-preview/pr-1830/src/data/propertySeeds.js\":\"9df1311477cb47f4\",\"/knowledge-medium/pr-preview/pr-1830/src/data/recentsPage.js\":\"c61c0c0c20949e03\",\"/knowledge-medium/pr-preview/pr-1830/src/data/referenceBlock.js\":\"dfae5943abffdbbf\",\"/knowledge-medium/pr-preview/pr-1830/src/data/rejectedUploads.js\":\"5d927e231d143742\",\"/knowledge-medium/pr-preview/pr-1830/src/data/releasePowerSyncConnection.js\":\"a97ded1066d48176\",\"/knowledge-medium/pr-preview/pr-1830/src/data/repo.js\":\"5515909cf047f985\",\"/knowledge-medium/pr-preview/pr-1830/src/data/repoProvider.js\":\"86fd2e6af9059298\",\"/knowledge-medium/pr-preview/pr-1830/src/data/rowProperty.js\":\"bea948a52527c194\",\"/knowledge-medium/pr-preview/pr-1830/src/data/searchFilter.js\":\"5062525dd07e966f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/seedIdentityLedger.js\":\"63abeac5fddb9381\",\"/knowledge-medium/pr-preview/pr-1830/src/data/stateBlocks.js\":\"886658bdaea74b26\",\"/knowledge-medium/pr-preview/pr-1830/src/data/structuralEditPolicy.js\":\"26e52080778578b3\",\"/knowledge-medium/pr-preview/pr-1830/src/data/subtreeDelete.js\":\"ccb10cc9a8444791\",\"/knowledge-medium/pr-preview/pr-1830/src/data/syncStreamLock.js\":\"83aef46ff8b00176\",\"/knowledge-medium/pr-preview/pr-1830/src/data/syncedTableSqlRecognizer.js\":\"b19ba69bc14dd08b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/syncedTableWriteGuard.js\":\"9c0b113d91c2b887\",\"/knowledge-medium/pr-preview/pr-1830/src/data/targets.js\":\"459ee64f5625a1b9\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeColors.js\":\"ab6fd3dfe2729f0e\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeDefinitionMetadata.js\":\"420e5e457bfae248\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeDefinitionRegistry.js\":\"1bfa1f78ab97c604\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeExtraction.js\":\"6ab0fffa17fb9351\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeInitialValues.js\":\"9ae8b6fcdf5606e2\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typePropertyGroups.js\":\"c242cf7a513a488b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeSeeds.js\":\"de1fe48ebfc077e6\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typeTagger.js\":\"03d2def9ddcb1864\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typedRecords.js\":\"8698c1a6a29a4018\",\"/knowledge-medium/pr-preview/pr-1830/src/data/typesPage.js\":\"ca8ac5ef3f1258ee\",\"/knowledge-medium/pr-preview/pr-1830/src/data/userPrefs.js\":\"24272e2902fc1e8b\",\"/knowledge-medium/pr-preview/pr-1830/src/data/userSchemasService.js\":\"04c088bf6388f4e5\",\"/knowledge-medium/pr-preview/pr-1830/src/data/userTypesService.js\":\"d4c3ff454a30421d\",\"/knowledge-medium/pr-preview/pr-1830/src/data/valuePresetRegistry.js\":\"fda2da3a4f3ffea1\",\"/knowledge-medium/pr-preview/pr-1830/src/data/visibleChildren.js\":\"e3352a83a7dcec49\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaceConversion.js\":\"0a80dfe8ccb27dc7\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaceFirstSync.js\":\"9bb1fa3f2c84680f\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaceIdNamespace.js\":\"4a26fe55c8134fd6\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaceSchema.js\":\"8122cb3e943ee9ec\",\"/knowledge-medium/pr-preview/pr-1830/src/data/workspaces.js\":\"891e669d60a9bf92\",\"/knowledge-medium/pr-preview/pr-1830/src/data/writeAheadLog.js\":\"35b979c4fb744226\",\"/knowledge-medium/pr-preview/pr-1830/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/BlockPasteShellDecorator.js\":\"fafcabb44f0655e5\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/atTrigger.js\":\"07a71c5dc5399a32\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/autocomplete.js\":\"42b59665a7742e56\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/codeMirrorExtensions.js\":\"7d7608c7b7ad37da\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/contentFlush.js\":\"c173a4998ccb1823\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/defaultInteractions.js\":\"de6a9e4e23214194\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/editSettleSignal.js\":\"b2503af5d226f44e\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/insertImage.js\":\"168e0f9a70941b97\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/referenceCompletionRange.js\":\"3029529cbc054fcd\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/referenceTargetTypes.js\":\"dbfc6a23b8d8554b\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/syntaxContext.js\":\"65528d6455fbf708\",\"/knowledge-medium/pr-preview/pr-1830/src/editor/triggerMatch.js\":\"f71610ea863d85cd\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/AppRuntimeProvider.js\":\"cb877970adcdd85f\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/BlockFocusShellDecorator.js\":\"2271e23f098c4da3\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/ExtensionRenderBoundary.js\":\"cbc52fb13a66a322\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/PanelContentRecovery.js\":\"6d707fdc6bd9584c\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/apiCatalog.js\":\"71bd2525ea90652b\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/approveExtensionHere.js\":\"59ef9e2443f7979d\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/armedCutAppMount.js\":\"c4cc2e4e6c54f736\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/batchableKeyedStore.js\":\"dbcdd2d9b0107ac7\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/blockInteraction.js\":\"6773cf066d001f20\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/blockSelectionAction.js\":\"b1dec71944016858\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/compileExtensionModule.js\":\"2aafe1f263cb6117\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/compiledModuleCache.js\":\"8ea3b5f41093867f\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/continuousGestures.js\":\"085e04b3ee6f9925\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/core.js\":\"f3e00934bd9fb3b1\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/defaultRenderers.js\":\"fb43b6c18a025e63\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/definitionFanoutAppMount.js\":\"e6e45828155a3a09\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/dialogAppMount.js\":\"8e4594feccafad91\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/dynamicExtensionSeeds.js\":\"f02d13a110cece8a\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/dynamicExtensions.js\":\"190e6e1a43cc8ff2\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/exampleExtensions.js\":\"214ba23777b1ab29\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionApprovalStatus.js\":\"44f68a5be86ff344\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionLoadErrorToast.js\":\"6893ad5738470f84\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionLoadErrors.js\":\"8f4befc614ac3bb0\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionLookup.js\":\"16a41127505f5112\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionToggles.js\":\"32c0b56739e13c11\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/extensionUtilitiesCss.js\":\"34ade4fe2c495b82\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/kernelPageDeletionGuard.js\":\"11f7fc0cea6530ef\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/liveRuntime.js\":\"2193ceb62e335616\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/openExtensionsSettings.js\":\"35b5603ff4145999\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/overridesCache.js\":\"ab889936b802e244\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/pluginIds.js\":\"b9e5d7e8ef40f41f\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/processorRejectionToast.js\":\"b6318a3b564e7ab9\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/runtimeActions.js\":\"ab2db2dffc904974\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/runtimeContext.js\":\"b3c5a598e0124987\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/staticAppExtensions.js\":\"90c17d7b3e969f2f\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/staticDataExtensions.js\":\"bb431301be356054\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/toastAppMount.js\":\"e548b99dbcc465ad\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/useOverrides.js\":\"9cad98a60d0c7a8f\",\"/knowledge-medium/pr-preview/pr-1830/src/extensions/useShortcutSurfaceActivations.js\":\"cdf2f923e858fd34\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/discoverToggleTree.js\":\"2cd30eb41d71b024\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/facet.js\":\"213e9b429c1b9f8a\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/resolveAppRuntime.js\":\"04280cb41c6ab143\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/runtimeEvents.js\":\"13edfab6b0b652c6\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/togglable.js\":\"f06d5e30fdddef4d\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/variantFacet.js\":\"1f405ef67b80d855\",\"/knowledge-medium/pr-preview/pr-1830/src/facets/verbFacet.js\":\"e6f0f14ebf1a140e\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/block.js\":\"095718d728208b72\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/focusedChild.js\":\"a20311b0aa2f5060\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/propertySchemas.js\":\"7c1030442c577f38\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/typeRegistry.js\":\"91f46d3a6c4da179\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useAncestorCrumbs.js\":\"0afe18ac68b4c2af\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useAutocompleteListbox.js\":\"df2399cf9b8bd17c\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useDebouncedSearch.js\":\"2cf11bfe49b128fd\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useDebouncedValue.js\":\"139dc2ea02c95a40\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useIsFocalRender.js\":\"99f5b5c3fd67e9a2\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useIsReadOnly.js\":\"98ff8bbe5c296563\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useMaterializeBacklog.js\":\"03489d4c1a73a819\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useMinuteClock.js\":\"53a388996d68aa05\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/usePanelLayoutProjection.js\":\"bc3d9425383837d2\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/usePendingInvitations.js\":\"9aa41d1f5ec679ef\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useRendererRegistry.js\":\"bc657a575c1a5332\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useRetainedFieldRows.js\":\"aa28966e6af26202\",\"/knowledge-medium/pr-preview/pr-1830/src/hooks/useWorkspaces.js\":\"cba4174314aad15a\",\"/knowledge-medium/pr-preview/pr-1830/src/lib/utils.js\":\"7269257907605682\",\"/knowledge-medium/pr-preview/pr-1830/src/main.js\":\"659d7fddfbcf2bc1\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/MarkdownImage.js\":\"6b8e5bd9cf770a8e\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/blockSeparators.js\":\"6e4cf67ecf4668f1\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/context.js\":\"b15c0b5b44ffa337\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/defaultMarkdownExtension.js\":\"17ed3f8c924dd59a\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/extensions.js\":\"d4820569fadc9069\",\"/knowledge-medium/pr-preview/pr-1830/src/markdown/renderMarkdownHtml.js\":\"2673f019da8d59b0\",\"/knowledge-medium/pr-preview/pr-1830/src/minimal-editor.js\":\"70fa8a33b48dbd5f\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/armedCut.js\":\"749874d0700f4b33\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/captureMediaVerb.js\":\"0d7a66d5ef39a7ac\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/clipboard.js\":\"758dcf4fb982e72b\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/decision.js\":\"ff4bf2608e01e29d\",\"/knowledge-medium/pr-preview/pr-1830/src/paste/operations.js\":\"a64bf48a46869dfa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/account-header/AccountHeaderItem.js\":\"633de0b259e99c80\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/account-header/index.js\":\"de961384b79e09e0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c822b1b17bffa798\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/askAgent.js\":\"3d341f35baeb6694\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/askedStore.js\":\"bc34aef0568a7623\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"99a856b75651d823\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/chipState.js\":\"d4b7e0152e27490f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3a2289569230adaf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/index.js\":\"6273acda0a5bd161\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1da0d2a774484cab\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-dispatch-companion/schema.js\":\"c0142f7f39a4d359\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1b70e23b48576a45\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/BridgePairingDialog.js\":\"1d1c568c931a9c05\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/addMedia.js\":\"51583a200d8e5905\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9f335d7391d7412e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/block.js\":\"1528cd1ca4d3c6b2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/context.js\":\"7e8be9a65d841cb9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/displayIds.js\":\"10e62316798830f6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/index.js\":\"eeebdabc2bf31861\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/outline.js\":\"38978054831b2481\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/properties.js\":\"4753927107b78968\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/refs.js\":\"c6e31b2352e7eb56\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ea0dcb6c574e2ca8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/search.js\":\"fbd67f4ca4ff3170\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/shared.js\":\"cde3c51957844df3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"85970fcda63b0601\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentViews/text.js\":\"a2a0479c76ceeaeb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/agentWrites.js\":\"c77deeec30c3d07b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/authoringCatalog.js\":\"5e874bfad854cd78\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/blockRefTargets.js\":\"7aab594844b22a7d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/bridge.js\":\"5e2db1a2203d62b7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/bridgeLoop.js\":\"1d8d2d19d036a7f3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/changeHistory.js\":\"9c19fc0b3edb7e8b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/commands.js\":\"5a8d3986a3f9c325\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/commentsCommands.js\":\"c83d622c76dc4186\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/dataExtension.js\":\"800617b1bcf91734\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/dataModelGuide.js\":\"a42021913c58a284\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/describeRuntime.js\":\"cd89b8ee9e98e1b5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/extensionLint.js\":\"c8bfbc0d292167d3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/grainAudit.js\":\"e487693f4e0d935d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/healthCommand.js\":\"346cbd84d1e412d3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/index.js\":\"dc1843a5a7a015bf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/presetIdentity.js\":\"644c11ed2c6216ae\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a9a2972d05711d89\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/readMedia.js\":\"35e89e209e01c940\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/schema.js\":\"5195f74ba0aeac44\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/serialization.js\":\"0836b77920852237\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/targets.js\":\"13a49d4d53aa2715\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/tokens.js\":\"f3298071b3104276\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/watchEvents.js\":\"19c8c9dc98edeebc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/workspaceGuard.js\":\"790836c8e4a9c0f6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/agent-runtime/writeCommands.js\":\"232453df35001dee\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/AliasCollisionToast.js\":\"1033ededb19bae4f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/DuplicateNameBanner.js\":\"1627c934da601a05\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/collisionMerge.js\":\"c22d289695f09eff\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/dataExtension.js\":\"837b9eeac70022c7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/index.js\":\"34f662fc93751f73\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/mergeCollisionAction.js\":\"2e2d6652318d6480\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/pageStyling.js\":\"6774d630947b6f1c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/rejectionToast.js\":\"3ffc9da6c2060eb4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/alias/syncProcessor.js\":\"c5633f6916d5250d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/actions.js\":\"ddee387efa3ffe20\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/addComment.js\":\"24381fb5e1ef27a8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/anchor.js\":\"c99e27f169643807\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/anchorState.js\":\"084c9407184f635b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/commentLinks.js\":\"eb00387c2aeeb854\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/confirmThreadDeletion.js\":\"859466ccb76e9005\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/container.js\":\"7a4c4ed5b0042328\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/dataExtension.js\":\"f1ca65d99201ee16\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/deleteComment.js\":\"f4f4c19a9cdbc561\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/highlights.js\":\"d25839f28598cb76\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/index.js\":\"a1512109138f420f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/linkedCommentsPill.js\":\"89f1742a4e9dac67\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/margin.js\":\"0c67e48dfbf36e8a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/marginSchema.js\":\"b83a2d712286fece\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/newComment.js\":\"b68f203a50879100\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/ownThreadPicker.js\":\"fbe449c7219394a8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/placement.js\":\"33c729f86859bbbe\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/queries.js\":\"6cd26688ece32ba9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/quotePosition.js\":\"7dfaabebaf2f69e9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/quotedIn.js\":\"b5d0fc601df90a3f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/quotedRange.js\":\"c0588ad1bdb43543\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/rangeRefs.js\":\"45da7f089a476c33\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/readHighlights.js\":\"c40047ed240c281f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/readSelection.js\":\"7fe4de227fb13767\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/readSelectionUi.js\":\"14f40c54815b8194\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/reanchor.js\":\"aab6934951ae367c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/schema.js\":\"f74ebc1168b2cea2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/scope.js\":\"96abbd8dd800cc32\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/scopeThreads.js\":\"6452f0621e395c0a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/splitRetarget.js\":\"67c278cdb271d35a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/suggestionCard.js\":\"97d00d23c32829e8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/suggestions.js\":\"672fbf33edbeeec0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/summaries.js\":\"4e0f3cd925f4d6bb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/summaryBatch.js\":\"da52500ea41954ce\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/surface.js\":\"459154030e70b233\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/threadNavigation.js\":\"0a7a1a8e82894782\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/threads.js\":\"aa49f7c298c5dff1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/ui.js\":\"47db1c41bfb5f78a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/annotations/uiStore.js\":\"30ee23c430fea8d7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/app-intents/appIntents.js\":\"8304c9c14115309d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/app-intents/index.js\":\"3850191db2890c6b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/app-update-prompt/index.js\":\"8934bcc697de9ffa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/app-update-prompt/status.js\":\"9f0e6b032469b54c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"da1fd7296f13651a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/MediaBlockRenderer.js\":\"c616a2fbb5ab69d0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4747fdd0e43bf291\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/MediaUploadReconciler.js\":\"7a536ded7ff7c853\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/assetDownLane.js\":\"71efcfbf6ea57f92\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/assetResolver.js\":\"cb7b8534d5f2e8c0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/assetUpload.js\":\"3edb900fbab476cf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/attachmentCleanerIO.js\":\"065408583aa92dac\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/supabaseAuditIO.js\":\"dc2606697ff2762b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/blobStore.js\":\"9288bbfb319c24bb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/byteStore.js\":\"184df2437f8a9196\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/cleanerIO.js\":\"cae8b6bdac0209e0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/cleanupAttachments.js\":\"2d850cb6f610a06a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/dataExtension.js\":\"a8fd5803baa264a2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/downLane.js\":\"21a2f6ff54e776d7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/index.js\":\"c5f5050f410e1c64\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/insertImageContribution.js\":\"380a30d0760fdcb2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/laneArming.js\":\"a3c66d768e58b488\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/laneLock.js\":\"e05352da38c69934\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/mediaBlock.js\":\"9c74274bfe275adb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/mediaCapture.js\":\"c8d4024da36bb5ef\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/mediaViewers.js\":\"9e602c935d1942f7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/mediaViewersFacet.js\":\"b8d47a07f1f637c5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/pasteCapture.js\":\"53c80e29ce74818a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/resolver.js\":\"0c4e207c8d8023f8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/retryUploadsAction.js\":\"83868863faa6c07e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/storagePaths.js\":\"f1b3af448ca95b05\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadDrain.js\":\"713b8455f6af2aa7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadLaneStatus.js\":\"d246b8893b68460d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadReconcile.js\":\"6d6dfdc074541e26\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadRecovery.js\":\"b874682f64ce48a1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/uploadStore.js\":\"aacf66ae55d0dfab\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/attachments/useAssetObjectUrl.js\":\"c93386c52e516d96\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ec71a932bb817bb5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e25adf749d3000e7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/facet.js\":\"96ae8e662062e301\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/index.js\":\"4832955e92fa9ca1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks-view/prop.js\":\"c5a7f7ada9136812\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/BacklinkFilters.js\":\"6ecaa475a2d08edf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"11da4b20ca418286\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/BlockEntry.js\":\"c51a4d49cea2cdd9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/LinkedReferences.js\":\"e5bbca7c9323519f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"17cea292b66b9c68\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/dailyNoteDefaults.js\":\"e612e8d9850f497d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/dataExtension.js\":\"3f895cfbeecb327b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/edgeExclusions.js\":\"60e0acda82620ca4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/filterProperty.js\":\"582c17db0c0c5bfc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/index.js\":\"7b0308a44cb18fe1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"142c37054b60e26e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/applies.js\":\"40d332ecaa970e92\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/countQuery.js\":\"7b8654ca7eeb15d5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/expansionStore.js\":\"08d8977399e52074\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/index.js\":\"b302a37639b40e4c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"6dbeb3f008731b5a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/presentationInvalidation.js\":\"f11d49e5ad2c8f13\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/propertyEditorOverride.js\":\"ae9f99b89fbfd6a8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/propertyFilter.js\":\"7041f4a610f69577\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/query.js\":\"defa9b04cabcd185\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/resolveFilter.js\":\"a4ad5026d2122d7e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/sourceBatch.js\":\"92a00357a95bc910\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/sources.js\":\"836ff8d0182cc2d1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/useBacklinks.js\":\"a60b64821dc1c0cd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f24033b85c63a9fb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/BirthdayCelebration.js\":\"1546e3ff41a6b359\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/BirthdayOverlay.js\":\"ce3ff43c1cac39dd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/gate.js\":\"5c95b55536e009cc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/index.js\":\"18b23b35cb1abcda\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/birthday/wolfTheme.js\":\"77a28863a2588a42\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/BlockDragLayer.js\":\"461d8054cd80f7ce\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/dragController.js\":\"0008c0818f010fd5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/dropTarget.js\":\"693d0b9acc1c08f6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/index.js\":\"4c8efc8a697f2c23\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-drag/projection.js\":\"436f2b79e30ccf1d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-info/BlockMetaCard.js\":\"ee9a2ca70e717361\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-info/index.js\":\"a5d03d3db256723a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/AddTagDialog.js\":\"a547e3d27a27819c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f1e0e15cb04826a5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/TagNameIssueHint.js\":\"58d4071609332cc7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/addTagAction.js\":\"cb457700e968d101\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/appendTag.js\":\"d47d8d3767b1ed37\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/config.js\":\"e7598e519d7744eb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/dataExtension.js\":\"56ef0986a83f1447\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/index.js\":\"6e566957e4b6f5d5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/block-tagging/propertyEditorOverride.js\":\"d81834d16c857564\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/BreadcrumbList.js\":\"eff507b2dd59cbc1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fb7ab87b9148d774\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/Breadcrumbs.js\":\"2df696d99732d36a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8932131c40a8c906\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0000ab8e678fd31e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/index.js\":\"a89d8c22250a01cc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b4d2ff5e3aca97a8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/CharacterCountItem.js\":\"505338b6a447db2d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1d0e5a84c657f5d2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/actions.js\":\"7bd0001bbe5851db\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/blockType.js\":\"0116d55eb1a5ffb0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/charCount.js\":\"f4f1c951270e8764\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/dataExtension.js\":\"22abb80fe3c4c5f6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/index.js\":\"b7235b8927f77236\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/profiles.js\":\"2dff4dc528e408e8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/properties.js\":\"bb0dcac3ee45ed5c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/character-counter/textCounts.js\":\"b761eacdccf02b99\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/colemak-keybindings/index.js\":\"48dfa351ba2195cb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/CommandPalette.js\":\"e69efc3ac373f34d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/HeaderItem.js\":\"14e92af386eb6649\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/context.js\":\"8e5c93b1ed92bc6c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/index.js\":\"081ffb575808521b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/selection.js\":\"91e6bea7c840f105\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/toggleStore.js\":\"febf68aa9a8d76a8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/command-palette/useCommandPaletteActions.js\":\"65aac26cfbd006b4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/ContributorBadges.js\":\"24341a67bc7c9e53\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/author.js\":\"b7a4a7524b6c26d6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/codeMirrorExtensions.js\":\"550be24c98fda1e0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/dataExtension.js\":\"6f15771127d4463c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/index.js\":\"d9658bf88aef57b6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/mentionAutocomplete.js\":\"9bece15f4f8e8aae\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/processor.js\":\"af72b72c2c1e39f2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/profiles.js\":\"68332665cb786f59\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/queries.js\":\"4b8a4e281bfe0c89\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/contributors/schema.js\":\"73c3a1bb596306bd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e4295e98f31763e9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4b5e628cc0812ed3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/index.js\":\"e6d39582ae90b1c0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2f52acfff1a34052\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"38af4ba3327f5f38\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/CalendarGrid.js\":\"3e376fa44432546d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/DailyNotePicker.js\":\"efc2f4788d5b3133\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c910199833fe5533\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/DateNavDecorator.js\":\"566015a9f4d2cbdc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/DateScrubOverlay.js\":\"b5ab15801bfd3610\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/HeaderItem.js\":\"1377e2fec9d7fec3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/ReschedulePicker.js\":\"b212f0a993aa284f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e20fd6207de84669\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/actions.js\":\"02d2d5759d8955b9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/blockDateAdapter.js\":\"c25793c687ae22de\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/calendar.js\":\"7547cbfdab5a2812\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dailyNotes.js\":\"7f30487b5f2df4a7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dataExtension.js\":\"aa701202b0af9f0b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dateScrubActions.js\":\"a624b92abaa5218e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dateScrubGesture.js\":\"16bbb258b67280e2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b6edbe1b547d9542\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dateScrubRecognizer.js\":\"5f8cedb38f27bd02\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/deletionGuard.js\":\"600874bb742e1bd1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/dueQuery.js\":\"ad42214a09e46702\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/index.js\":\"a3c2d825611ddec5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/landing.js\":\"61c2f82dbb6c2a9c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/localSchema.js\":\"d4cf5689eca543a4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/referenceDateAdapter.js\":\"5ce3cdfc15118618\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/rescheduleAction.js\":\"0b6263b2ebee2274\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/schema.js\":\"9f821763c0dcd02f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/spreadBlockDates.js\":\"0d64540f4ca44d5b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/spreadDatesAction.js\":\"51f3fb6139764f50\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/today.js\":\"78f0760b90318f59\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"36943fae7015f243\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"51307498a3a09c09\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/audit.js\":\"ab349ea86b1d2e6a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/auditAction.js\":\"1c11da8edbd3a7a3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/auditRanges.js\":\"3d49ff4fcef2b182\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/diagnosticsSource.js\":\"c92479b267e3d29f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/divergenceScan.js\":\"34720c624d3631ec\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/index.js\":\"a6562012f83a6538\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5d7f04538e4aa9d4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/referencesMirror.js\":\"31877ad0c8d12c80\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/rowJson.js\":\"dba2d3f6b5f126c0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/schedule.js\":\"d60998f5fa1f4555\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/data-integrity/store.js\":\"579a56e28488395d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-maintenance/action.js\":\"e3cd728eaee5172f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-maintenance/index.js\":\"768f2db9007f8066\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-maintenance/plugin.js\":\"b65c907802a260b9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e8a1ce63702c63c3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/actions.js\":\"b727d5b6553259e4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/changeMarker.js\":\"8e7d7a5354685bfd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/diagnostics.js\":\"adb9d92618abcbf5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/fileSystemAccess.js\":\"c828bc61c3c65715\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/filenames.js\":\"45e03431713a0941\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/index.js\":\"347093b9ae86bc16\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/mirror.js\":\"4117107040eed89b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/runLock.js\":\"60409a7e1fa9fd96\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/runtimeHealth.js\":\"2fbe591f5ec1f0cc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/schedule.js\":\"7bd52b6598b8608a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/db-mirror/store.js\":\"bd13b22e397e5db5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/default-themes/index.js\":\"43beb8f66320314a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/default-themes/themes.js\":\"e30361047aae1ab1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/diagnostics/facet.js\":\"752c627f1351c728\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/diagnostics/useDiagnostics.js\":\"37b79627479e2e1e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extension-prompts/dismissals.js\":\"5ae4b6dbb17b3255\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extension-prompts/index.js\":\"3f66c6bab7f65a17\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extension-prompts/status.js\":\"fc2bc5d81e84e5ea\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extension-prompts/store.js\":\"aef56a787c72a620\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a3d2d42da10ee8f8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/ExtensionsSettings.js\":\"94649108dab59386\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/actions.js\":\"8e6b754f2f1373b6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/config.js\":\"4bd836656107922b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/dataExtension.js\":\"0d40e332c9893e0c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/effect.js\":\"05164629a061a303\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/index.js\":\"ca1bc96128c53658\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/propertyEditorOverride.js\":\"10b86e6efb7272fe\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extensions-settings/useToggleTree.js\":\"15d671763904f547\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/ExtractTypeDialog.js\":\"befdeea24d623b4a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"3d1530ec4dfc27bd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/PropertyShapePicker.js\":\"5c52aedf7330ff69\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/action.js\":\"88733840872c6dd5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/extract-type/index.js\":\"108c40a77ece806d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/FindReplaceDialog.js\":\"1e925af0fcdd0ec3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/HeaderItem.js\":\"7a2ce5a26c0d7152\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/dataExtension.js\":\"3a1e3b711d37ff94\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/index.js\":\"c47ad834eaf2e57c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/search.js\":\"56b249820bc6189e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/toggleStore.js\":\"4c4ad22069d9d4d5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/LocationPropertyEditor.js\":\"02a306a728731e41\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/MapView.js\":\"0818101bd2b2355b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/blockTypes.js\":\"f7c7869d406ae06f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/codeMirrorExtensions.js\":\"23928f424b9697a0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/createOrFindPlace.js\":\"3392ebfedaaa9f14\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/currentLocation.js\":\"be2e44a40888475b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/dataExtension.js\":\"ddb746746a454842\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/geoContentDecorator.js\":\"34e1161bcb91303b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/googlePlacesClient.js\":\"a3f1e09cdf515190\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/index.js\":\"aeda2a15b11810bb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/locationsPage.js\":\"19e2963e4c8a1191\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/mapViewport.js\":\"1b05961f13a33b80\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/pickCurrentLocation.js\":\"1670ce15b4aa8f8a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/placeAutocomplete.js\":\"b9b8fd39fdb3bc92\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/placeNameCollision.js\":\"0a7fc4669e0aca57\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/properties.js\":\"2d49a237949150ed\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/propertyEditorOverrides.js\":\"81e555408c7a4504\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/query.js\":\"8c21f82b8ed29a92\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/geo/usePlaceSearch.js\":\"0413681659b5363d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c163f9f954e69927\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c6f82067ba19e12d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a2722e9682e5ac26\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/config.js\":\"1715a236aa2529f0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/dataExtension.js\":\"fd94d569bb255c35\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/facet.js\":\"9ddbd970f4b6a285\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/grouping.js\":\"e46e34c47e7b2f6f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/index.js\":\"6d12ce30b4e35415\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"315286d573d57c54\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/query.js\":\"61c5e7082293340d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/resolveConfig.js\":\"47988114bc38e1f4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"77c0bac6354a561e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7e984619e8450aac\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/HtmlDocumentContent.js\":\"46dc7949fcbd9151\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/HtmlFrame.js\":\"bbf8947b344a7493\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/actions.js\":\"a75b60731f5ce52c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/blockType.js\":\"33fcc743512983fd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/confirmRunScripts.js\":\"f84924c416955300\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/dataExtension.js\":\"4d0a75aae921160b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/frameAnnotations.js\":\"ee5909ac4619fc41\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/frameDocument.js\":\"11993e2e34ac06d2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/frameTheme.js\":\"6bb1565fee177fbd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/index.js\":\"8028db70ab71840c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/scriptConsent.js\":\"7d3ab8b62a470884\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/sourceMap.js\":\"e67add72d1f612a3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/html-document/useDocumentScripts.js\":\"8d9fc462ab83cb27\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/index.js\":\"ec57b03549bd993f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/record.js\":\"eaccc6bdc9aa692a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/recordStore.js\":\"9b2ebfc72884c0b8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/responsiveness.js\":\"d6118aa581ac451d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/schedule.js\":\"01af4331583bd6d1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/interaction-metrics/sessionContext.js\":\"20c8ca20f5bb7f38\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"74939944ca8b707c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"969de96a42787fdc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/actions.js\":\"b7170b98bf5b7c6f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/config.js\":\"1642aa9f9832bda0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/dataExtension.js\":\"a47ddfae9018a084\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/effect.js\":\"a379766652324d0d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/index.js\":\"9ae3bf177f61987b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/keyCapture.js\":\"82e59784f51e206a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/overrideStore.js\":\"933b501f60b41af3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"09331e7ed57c070a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/HeaderItem.js\":\"7d1adc28914728d4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/LeftSidebar.js\":\"d2bee5fe9c36ada1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/actions.js\":\"7fd767c694403421\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/facet.js\":\"74715db493cf8c1c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/index.js\":\"d997c8690075b275\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/shortcuts.js\":\"bb05a8b8049d45a2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/left-sidebar/toggleStore.js\":\"3080d987b4d69a05\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/merge-blocks/MergePicker.js\":\"e4dcbec518866df0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/merge-blocks/index.js\":\"6f5d7e5ebba491b3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/merge-blocks/mergeAction.js\":\"10937e2ee97855dc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/merge-blocks/strategy.js\":\"f7ca94c1f47b6be6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/Button.js\":\"d601a9a1b92bf0f5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f5b9bd9bdf905205\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/defaultItems.js\":\"1b92771c154b9801\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/facet.js\":\"9421d7d53827b48d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-bottom-nav/index.js\":\"ee644896b0367489\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ac92c50201be14ab\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/actions.js\":\"bee6f981ca7c625e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"31bfe45cbbacc425\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/facet.js\":\"33742a157d38d6cc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/mobile-keyboard-toolbar/index.js\":\"98f1d241e9d00f8f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/MoveDestinationPicker.js\":\"14b81127d10b39ef\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b00ab3f894425d4a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/contextMenuItem.js\":\"90c967c799c05faa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/index.js\":\"cc4b034ad516cd10\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/moveAction.js\":\"d18066fe5da0cf27\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/moveBlocks.js\":\"59b4925df4c42b48\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/move-blocks/selectionAfterMove.js\":\"bbb83ad2c360012f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/TutorialBanner.js\":\"8efb9af6476c9771\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/action.js\":\"334cdfb372a95708\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/bannerDismissal.js\":\"f3384bb9f503a38a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/documents/cheatSheet.js\":\"d68e553c45bf02fd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/index.js\":\"d837308702b3c2ee\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/keys.js\":\"3dc8712a915f9582\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/landing.js\":\"ac36cfc5c1096091\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/outline.js\":\"b15ac4694025c40f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/onboarding/seed.js\":\"c11daa4803c7a7a9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4dc9c2d478b33106\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/analyze.js\":\"2b60ae34e04b908d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/diagnosticsSource.js\":\"5478c4dee24cd0c9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/index.js\":\"59578f0f8dbe673c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/load.js\":\"0c99118104b0c111\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/monitorRun.js\":\"d73b072fc969399b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/schedule.js\":\"791490e2b380a459\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/series.js\":\"6bb841fb00ff8f8b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/store.js\":\"6e06d58b9028a84b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/trendAction.js\":\"f51c6b7aa53914a4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/perf-monitor/verdict.js\":\"50c1caadf58bd863\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/plain-outliner/clickToEditAction.js\":\"9a6e83cad1098e70\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/plain-outliner/index.js\":\"cbe318480bab2872\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/plain-outliner/interactions.js\":\"43aa7908a8dfc4d2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a8b1a83f79970b3e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/MigrationGate.js\":\"195d6a97eed8b450\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/MigrationGateDialog.js\":\"6330a502643c7627\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/action.js\":\"99f06a6584b96ee4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/index.js\":\"c7d5325eee842c8f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/localRunMessage.js\":\"5fa97a4b697f05cb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/plugin.js\":\"b918638b9257821c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/progressReport.js\":\"34d99712df6cb49e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/properties-migration/sweepProgress.js\":\"2b2538a69e2274a3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/FieldRowRenderer.js\":\"4e940cfb0b33206c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/ValueRowRenderer.js\":\"74e43f5559d5ddf2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/actions.js\":\"b38675940aa9ab38\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/autocomplete.js\":\"050e0ff68ef9d98f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/fieldRow.js\":\"3a4681f1950972c4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/index.js\":\"45d96cffe2c9e056\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/referenceWarning.js\":\"1bf4193b79346e3f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/valueAutocomplete.js\":\"992a28c440d6e733\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/property-rows/valueSchema.js\":\"dd20b7a3123ca19a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/HeaderItem.js\":\"3f17e0299be72919\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/QuickFind.js\":\"bc057d6d4800b263\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/index.js\":\"5f1391785680fb33\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/recents.js\":\"7a018cc23909b140\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/resultItems.js\":\"66b91bc3856365e3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/selection.js\":\"97fda68e00d989bf\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/quick-find/toggleStore.js\":\"ba7af86a83e5f9df\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/HeaderItem.js\":\"9e2fe9a89f2a9ffd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/RecentsPageBlockRenderer.js\":\"47749fafe8836cfe\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/grouping.js\":\"246bdbbd1add53aa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/index.js\":\"4833cf11b073f775\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/recents/target.js\":\"b18c0adedccf31e9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/codeMirrorExtensions.js\":\"f9e88c9532dd9d58\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/contentPrefill.js\":\"8f00c25212dff9e1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/dataExtension.js\":\"c1a2288c7d63df88\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/index.js\":\"6cf0c18521da085b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"fc23a6b28f88ae5f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/invalidation.js\":\"1bdcfe0c87604b71\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/localSchema.js\":\"bcfb4cc4e8d1ba7c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/blockrefs/index.js\":\"4045e4ade4d398c8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"9598252f81714545\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/index.js\":\"f5df2344af7b539d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/referenceNode.js\":\"eb52b5da63765f17\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/remark-reference-occurrences.js\":\"87501fecca95ef28\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"02ba209f7df8421f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/wikilinks/index.js\":\"855af61034d32e06\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7ac0efdb6179d91b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"78a9d752bcdefe06\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/mergeRetargetProcessor.js\":\"3091b55c9e084721\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/parseFence.js\":\"b5edfc7eb1e5652f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/referenceParser.js\":\"67265a1445a0b568\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/referenceProjection.js\":\"0d08a21b236ae2ad\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/referencesProcessor.js\":\"d02aab230af08682\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/renameProcessor.js\":\"d2154f17fc0e7ca9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/references/spanReplacement.js\":\"19cd720750568e51\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/rich-paste/htmlToOutline.js\":\"92459e028b6e7492\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/rich-paste/index.js\":\"67715708ef5a71cb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6a4fb3ea986d63e4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/rich-paste/pasteDecision.js\":\"af120937c9912f65\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/action.js\":\"cfe8a522f2eb32f3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/blockIds.js\":\"43d2e30480bb875c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/content.js\":\"3accdb903fa7477b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/effect.js\":\"a4baac0e16d81f44\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/ids.js\":\"78d916a4c4ef5ee4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/import.js\":\"af8681963ea3bc7f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/index.js\":\"2251d789e2e95708\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/plan.js\":\"2b6950bf019efab1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/plugin.js\":\"342ad40aee877bfb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/promotion.js\":\"96cbcd710a61c252\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/properties.js\":\"7c9afd49b456621a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/references.js\":\"523cf633879be0ca\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/report.js\":\"15e7e31772dbdf3c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/roamMemo.js\":\"5d2095886133035a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/runtime.js\":\"4f56422f2a4ceeb7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/schemaReconciliation.js\":\"5e93fe6d40c636d7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/srsMarkers.js\":\"ba044a54677ca746\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/todo.js\":\"36053c1574539bf7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/typeCandidates.js\":\"78280fea1c652846\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/roam-import/types.js\":\"21c9ca190dc898ab\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/search-health/index.js\":\"04a6179d695a23e2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/search-health/store.js\":\"9903995eccd72a50\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/HeaderItem.js\":\"6d838183536526d5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c9f45f9c49edcd47\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/index.js\":\"6b7406a735d85ff4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/model.js\":\"2076f02da2c52727\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/toggleStore.js\":\"b100a102cc5bb44b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/shortcut-help/useKeyInspector.js\":\"0425b5a0faf0fd54\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"487c2a55fc486994\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/ShellDecorator.js\":\"2ec48d4079e70836\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/actions.js\":\"8f86a19a02255fd9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a05e0136be9d423d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/index.js\":\"20cc3cdf05a3eff0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/shell.js\":\"298b1cd01c96dd11\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/surface.js\":\"d00191b4c54568ec\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/spatial-navigation/walker.js\":\"8a8420c9bad772eb\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/RescheduleToast.js\":\"dfd20a8be8c4379d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/dataExtension.js\":\"12f5bc6e08ada01c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/index.js\":\"33b672edc3314ea5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/indicator.js\":\"b8d1f55e016f4bd6\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/moveSrsState.js\":\"b8befa2a7623dd33\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d80bc84029c8bfdd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/scheduler.js\":\"6dc1341f185514e0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/schema.js\":\"6cac7903a06cc0ce\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ccfb2a373fe2e8fd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/srsClipboard.js\":\"c5fe52691e92ee56\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"912e5c24932a8297\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ffcf729a637de860\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/DeckPicker.js\":\"c096beb96070c75a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/ReviewControls.js\":\"5d68b38509310cc3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d2fc080dbcb92907\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/ReviewSession.js\":\"fa85c2a6fa41a68f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/actions.js\":\"c429b6f8eb095d62\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/archive.js\":\"206c0b1b33cc52c3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/dataExtension.js\":\"d976a5591acfb7c8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/deck.js\":\"fdad57cc3d13768c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/dueQuery.js\":\"240447199b9b6b99\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/gradeDecision.js\":\"e68083684409c898\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/index.js\":\"e5e1492c2ca50bfc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/keyHints.js\":\"7b8d010cebeff8a8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/reviewCardLayout.js\":\"61d8171af336cba7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/reviewProgress.js\":\"89bb69b79cb3a90b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/schema.js\":\"746e6d18916b8008\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/srs-review/useDueCards.js\":\"5ac46626ff196465\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/startup-metrics/index.js\":\"aa5b5272334c10b0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/startup-metrics/record.js\":\"9d3a76a706961774\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/storage-persistence/index.js\":\"a014cd19ea9b8272\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/storage-persistence/persistenceStatus.js\":\"050a83884436fbae\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/storage-persistence/requestAction.js\":\"1775f077676964b1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/supertags/TypeChipsDecorator.js\":\"56ad7fe471784afa\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/supertags/codeMirrorExtensions.js\":\"8f8ccb8fd1016021\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/supertags/index.js\":\"13e44607ef144222\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/supertags/typeAutocomplete.js\":\"2acc245369571329\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6dedd03871d328be\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/actions.js\":\"0990716f22246576\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/anchor.js\":\"a9a0c9350e52fd6a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/events.js\":\"b94a8ec8283a4fb5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/gestureActions.js\":\"bcb7c7eae71384fd\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/index.js\":\"c012b8cddb0e7947\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e8b0ab58a0e888e9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/sync-metrics/collect.js\":\"e64a20bd3363ac5c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/sync-metrics/index.js\":\"e895f8129a76ae10\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/sync-metrics/record.js\":\"06499c35f14713c1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/RejectionDialog.js\":\"010949b1b712d55a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/SystemStatusHeaderItem.js\":\"348cdf5de26b7a46\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/index.js\":\"fbaad3f032fbd006\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/model.js\":\"bb2f2b3db833c803\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/queueCounts.js\":\"8d4d1e624c4bdc98\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/rejectedHelpers.js\":\"93ae5f9c6f5c3023\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/rematerializeAction.js\":\"79e054d3d7e6149e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/system-status/useHysteresis.js\":\"7fbd4b6229ba9aec\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/ColumnHeaders.js\":\"bac77a68e3449cb5\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/TableLayout.js\":\"0c485b9d50a5adb1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/actions.js\":\"d0d1ec165aa51fdc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/cellEdits.js\":\"baa0fdb92ccea20e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/columns.js\":\"c58ea0699d651034\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/controller.js\":\"052b160fcf26377d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/convert.js\":\"3d953a202cc8533f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/dataExtension.js\":\"50df7c1b7c8d7cd3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/index.js\":\"144c08a431bbd063\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/keys.js\":\"799de7a3b13c46ee\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/model.js\":\"ff7c0f7e8e4f449c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/registry.js\":\"787e9205f5fd4a51\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/tables/schema.js\":\"ac95fefcf1b4ce5b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/theme-toggle/effect.js\":\"396f1aa5d067d97c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/theme-toggle/index.js\":\"674b5cc957c1cf59\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/theme-toggle/theme.js\":\"0a5ab7193f5a4f92\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/todo/actions.js\":\"4519ad5aaede529b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/todo/dataExtension.js\":\"a13d27e1d6a901e3\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/todo/index.js\":\"bac86926ed43a72a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/todo/schema.js\":\"6c78b2b44c25d847\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b84249e002748d5e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/actions.js\":\"c764aa05cf8bd9f8\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/defaultItems.js\":\"e1b92c5055ec2b8a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/facet.js\":\"edba45ae2f7196a7\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/holdRecognizer.js\":\"deb72c61347328f2\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/touch-selection/index.js\":\"14719f6881aafef4\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/update-indicator/UpdateIndicator.js\":\"b70c716036bcd21c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/update-indicator/index.js\":\"097b432e54f5f02f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/update-indicator/loadTimes.js\":\"7829f022497808e0\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/VideoNotesRenderer.js\":\"7b63faedf97a514d\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/VideoPlayerRenderer.js\":\"ed1a68da42e04f9a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/VideoTimeStamp.js\":\"f0d28ec0e7e28f33\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/actions.js\":\"58e21da6d2ac24c1\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/index.js\":\"7b5fac837ee3bc05\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/markdown.js\":\"5f9b3daa586b34fe\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/notes.js\":\"7f0bbb50e3ecff7a\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/registry.js\":\"e40a5fe0959cfc9f\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/remark-timestamps.js\":\"0e18572a4bf5354e\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/video-player/view.js\":\"fc7d0760d83b1079\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-link-hints/LinkHints.js\":\"49d578557171b48b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-link-hints/index.js\":\"c462e2623f049e1b\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-link-hints/model.js\":\"702e1dfd505556f9\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-link-hints/settings.js\":\"02d2c30a493eb336\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-normal-mode/actions.js\":\"9e243388fc64614c\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-normal-mode/index.js\":\"16ac70116d5af3dc\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/vim-normal-mode/interactions.js\":\"3e2ca502f36cb104\",\"/knowledge-medium/pr-preview/pr-1830/src/plugins/workspace-header/index.js\":\"2dd14515b5d27402\",\"/knowledge-medium/pr-preview/pr-1830/src/registerServiceWorker.js\":\"3408e443af05908a\",\"/knowledge-medium/pr-preview/pr-1830/src/requestPersistentStorage.js\":\"e7e3376eba77ccf7\",\"/knowledge-medium/pr-preview/pr-1830/src/services/authRequestDeadline.js\":\"b912d326cca678d4\",\"/knowledge-medium/pr-preview/pr-1830/src/services/authStorage.js\":\"230e7ba3b17e3293\",\"/knowledge-medium/pr-preview/pr-1830/src/services/powersync.js\":\"6ad844bd891026dc\",\"/knowledge-medium/pr-preview/pr-1830/src/services/supabase.js\":\"267a91df9f5e22df\",\"/knowledge-medium/pr-preview/pr-1830/src/services/uploadErrorClassifier.js\":\"c325b72e6caeb51d\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/ActiveContexts.js\":\"6ec54e4fc33443cf\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/HotkeyReconciler.js\":\"876e52642866abdb\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/WipeLocalDataDialog.js\":\"33fd54e7665c55a7\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/actionDispatch.js\":\"3d209082347b90f8\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/actionRefItems.js\":\"6cf3f44e6a4bb0da\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/applyKeybindingOverrides.js\":\"ddeb7f7e29a08c32\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/blockActions.js\":\"35fe16ae9d58b376\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/canonicalizeChord.js\":\"6bbede97df9de8ef\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/defaultContexts.js\":\"fd3e7f9679f1f3a2\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/defaultShortcuts.js\":\"ac511b469e412c62\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/effectiveActions.js\":\"0d9013f5a693f3d9\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/gestureAction.js\":\"062f3b3f481eb8d0\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/gestureBinding.js\":\"8986d68b1ef889fd\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/holdRegistry.js\":\"3018b66d2174020e\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/keybindingConflicts.js\":\"9b9c8e79cacf0cc4\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/keybindingOverrides.js\":\"e698ea94e3e8b29a\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/pointerAction.js\":\"fa2efd191db78650\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/resolve.js\":\"10ac8f8f5aead740\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/runAction.js\":\"7434a24564d0581c\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/sequenceMatcher.js\":\"8571a4b1a546356f\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/types.js\":\"855faabd6478bfb4\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/useActionContext.js\":\"402eca8f280c4a75\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/useActionDiscovery.js\":\"9e71443383b253f9\",\"/knowledge-medium/pr-preview/pr-1830/src/shortcuts/utils.js\":\"740153d4ca379421\",\"/knowledge-medium/pr-preview/pr-1830/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1830/src/sw/bootStore.js\":\"dfbdb3bc12b36347\",\"/knowledge-medium/pr-preview/pr-1830/src/sw/previewDatabases.js\":\"f9d33dbda1df70f2\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/byteTransform.js\":\"c3b64dcdf6297b4f\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/attachmentCleaner.js\":\"76cd5096d9b854e9\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/attachmentParts.js\":\"ddb72308a80052e4\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/bundleParts.js\":\"a66183c7fe91651d\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/bundleRecord.js\":\"d07a7f4b216c6e06\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/manifest.js\":\"5cc65da873558b0d\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/takeBundle.js\":\"4d99fe0d54dc01f7\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/bundle/verifyBundle.js\":\"b02aec4097857c23\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/cleaningStage.js\":\"4dbab0b29bb89d54\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/conversionKey.js\":\"763a373946af5549\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/conversionServer.js\":\"0a1d71d2d5dddb1e\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/flip.js\":\"08704ff3d020ce4c\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/flipAttempts.js\":\"d0e557055f6065be\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/pages.js\":\"a63673bdf76a9343\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/preflight.js\":\"b55b94c94270990d\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/reseal.js\":\"e231bfdf1900749d\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/runConversion.js\":\"9565782d83a26719\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/runLock.js\":\"46f68626f8c6c7cf\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/sealing.js\":\"1ccae2e13dc9c216\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/sealingStage.js\":\"bd9ee39f1ed03f13\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/stage.js\":\"a3780f86e677bc01\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/conversion/verifyReseal.js\":\"40b8e8c90eaa5602\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/aad.js\":\"20ece1af90e82db6\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/aead.js\":\"3899da93cb7dbdf3\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/base32.js\":\"713f20be90ced45b\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/base64url.js\":\"ac2074fb379686fb\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/binaryEnvelope.js\":\"1f010f21ce3d0ed6\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/byteAead.js\":\"6655c4852964ff07\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/canary.js\":\"d6176fee9fe8118a\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/contentHash.js\":\"8d278fdf7e0f92a9\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/contentKey.js\":\"747b67535991c49c\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/derivedIdNamespace.js\":\"fabdb96459b319f3\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/envelope.js\":\"57d20d0aeeae191e\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/hex.js\":\"9f4e8fcd5a4e18cf\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/sha256Hex.js\":\"d146aa728d094fbd\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/crypto/workspaceKey.js\":\"3ab9489171303d99\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/conversionState.js\":\"a1cdffaf15a7f45e\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/flows/createEncryptedWorkspace.js\":\"301d4ec9d351765f\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/flows/pastedKey.js\":\"8ad833d2ef0562d9\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9e371fa9ef0c1574\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/flows/upgradeWorkspacePin.js\":\"fd0fc230f3177eea\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/keyStore.js\":\"4e32038d8e781656\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/mintWorkspaceKey.js\":\"738e36435cd2c5d4\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/modePin.js\":\"547e33c5a10f340d\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/openWorkspaceKeys.js\":\"838d1210d27cc6a3\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/resolveWorkspaceEntry.js\":\"876402f150d5ac32\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/resolver.js\":\"807809668dff466a\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/keys/workspaceAccess.js\":\"edc8f2636b010099\",\"/knowledge-medium/pr-preview/pr-1830/src/sync/transform.js\":\"615c9f07a1931c8f\",\"/knowledge-medium/pr-preview/pr-1830/src/themeBootDefaults.js\":\"c1dccd3e09944bf1\",\"/knowledge-medium/pr-preview/pr-1830/src/types.js\":\"95611a4facccad9a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/ClientLocalSettings.js\":\"31dea4d9464c0178\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/abortableSleep.js\":\"9e1a798b4f3cd1cd\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/array.js\":\"6fa4909158043e1c\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/backlinkAutocomplete.js\":\"a78db2a07bbc19a5\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/blockCrumbs.js\":\"f2b8db2e1762bf4a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/blockrefAutocomplete.js\":\"38a0770368d25cd1\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/cadencedIdleJob.js\":\"f81b82f0bb49944e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/callbackSet.js\":\"bf81fe26ed4a8c85\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/clientId.js\":\"b47c9a48c58c3a93\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/codemirror.js\":\"bcf225a40b370ebc\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/codemirrorCompletion.js\":\"62b5dff3d874f618\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/copy.js\":\"16e7866c88ae538e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dailyPage.js\":\"12061c331e2e7a5f\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dbForensics.js\":\"e3112aa71bcc20ff\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dbForensicsHooks.js\":\"e59df4c175a8ff4e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/deleteBlockThroughUi.js\":\"fa7a22ef32a88eb3\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dialogs.js\":\"85b3c3604a04d018\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/dom.js\":\"d655b014d9f3035c\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/downloadBlob.js\":\"6ceba3c6b5b30d78\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/exportSqliteDb.js\":\"87b2e4b8105c1794\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/fileSystemAccess.js\":\"7a5dadd99dda3ed4\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/flipSlide.js\":\"885fd3b5be82e49a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/fnv1a.js\":\"4bf6f77ae8b9f5b5\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/formatBytes.js\":\"a0e50555f95f154a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/fuzzyRank.js\":\"7e60bf79f05098b1\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/idbKeyedStore.js\":\"c170c61ebc448f68\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/idleCallbackPolyfill.js\":\"edc3671f802a593c\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/keyboardAwareScroll.js\":\"0efdc7311f17eba1\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/keyboardViewport.js\":\"926464a154aa539e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/lastWorkspace.js\":\"d5e4ffac03b83f60\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/layoutColumns.js\":\"2421006e4c36006e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/layoutSessionDom.js\":\"4cfeaf2bdbadda10\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/layoutSessionId.js\":\"db0b97abfed44c1b\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/linkClickGestures.js\":\"b92fe95bec15cef9\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/linkTargetAutocomplete.js\":\"2b72dc35630b456a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/localDbCorruption.js\":\"22ae40bacfd0e68d\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/localDbRecovery.js\":\"0305a3fd53b2c13f\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/markdownParser.js\":\"b1ae710f35ee0aa5\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/memoize.js\":\"a062ac6b5f3d7b22\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/nameFieldCommit.js\":\"29d0821db4d3b507\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/nameList.js\":\"23e697b0bde6387f\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/navigation.js\":\"10ad00a07457fb62\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/omnilinerNamespace.js\":\"ce925013da13f1f3\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/opfsPageScan.js\":\"4aff8aa3335ca1ac\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelClearance.js\":\"325e1430396afa52\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelHistory.js\":\"d77d25582615e4fe\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelLanes.js\":\"9e6f0520e0d0a74e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelLayoutProjection.js\":\"40606e18e65b6465\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelScrollAnchor.js\":\"d822b91931c21e14\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/panelUrlFlags.js\":\"a56968344a610e70\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/platform.js\":\"8191936bcbddf274\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/pluralize.js\":\"ce2c32d21b6f03e2\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/propertyCreation.js\":\"84bacd7925ee03fd\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/propertyNavigation.js\":\"740cf3320cbe2f32\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/propertyValueContext.js\":\"0abfdcd6ec29d673\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/react.js\":\"bd68c116e7d045cb\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/relativeDate.js\":\"99a0b356f864cee4\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/relativeTime.js\":\"ad5907844068823e\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/renderScope.js\":\"ea932faadb1f3d84\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/resolvedThenable.js\":\"ee04d1cf10d74456\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/routing.js\":\"1f97be328fb1e303\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/safeMode.js\":\"cd314c8d766367ce\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/scheduleIdle.js\":\"4e9bbd3000391241\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/screenWakeLock.js\":\"0548846fb75bd006\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/selection.js\":\"f4612f9bc6c0d8c2\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/softKeyboardGrab.js\":\"a646a29bec33cef0\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/startupTimeline.js\":\"f1ab3c1f1e58926b\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/state.js\":\"4399214c298a19ed\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/string.js\":\"ba9614e8a8bec658\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/surfaceZoom.js\":\"1093a2e30ec9ba41\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/time.js\":\"c8d949f4c5bfbfe1\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/toast.js\":\"699bc8471f0b120a\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/toggleStore.js\":\"38e7915d1d595ff7\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/untilStopped.js\":\"4a0f08bcf9999399\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/userActivity.js\":\"6938a960cbe31dca\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/viewTransition.js\":\"9d51c1335c465193\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/viewport.js\":\"b862f51edbdad7d3\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/webLock.js\":\"7e85d7a9ba0166e9\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/workspaceRecovery.js\":\"f32d07ca80c4e2e9\",\"/knowledge-medium/pr-preview/pr-1830/src/utils/workspaceSnapshotStore.js\":\"0be29afd40af1ffc\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-compiler-runtime.js\":\"654cb23e827e318f\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-client.js\":\"a2f466337dc32569\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-server-edge.js\":\"6d9b2c00c0b70716\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-server.js\":\"20c4d44429c99f94\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-static-edge.js\":\"8be461b60f7e3d55\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-static.js\":\"a72a6dcf13259c4e\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom-test-utils.js\":\"7c53a44584f9b4a3\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-dom.js\":\"c2045af7b2899e3f\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react-jsx-runtime.js\":\"cc7189247e074648\",\"/knowledge-medium/pr-preview/pr-1830/src/vendor/react.js\":\"1de66e59362db493\",\"/knowledge-medium/pr-preview/pr-1830/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1830/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1830/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
