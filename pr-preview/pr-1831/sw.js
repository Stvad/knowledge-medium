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
		buildId: "bc2528dafbc4-7f76ec7f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1831/\":\"b20b3eca7d469449\",\"/knowledge-medium/pr-preview/pr-1831/index.html\":\"b20b3eca7d469449\",\"/knowledge-medium/pr-preview/pr-1831/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1831/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1831/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1831/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1831/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1831/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1831/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1831/assets/FacadeVFS-LKZJzDs_.js\":\"76109e3f361905e7\",\"/knowledge-medium/pr-preview/pr-1831/assets/OPFSCoopSyncVFS-CczT3vid.js\":\"e69f84bda1feaa3e\",\"/knowledge-medium/pr-preview/pr-1831/assets/OPFSWriteAheadVFS-B_Iqr7wW.js\":\"8e4f115ab72e3dc0\",\"/knowledge-medium/pr-preview/pr-1831/assets/wa-sqlite-BmeYeM79.js\":\"8895afa143dedf2f\",\"/knowledge-medium/pr-preview/pr-1831/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1831/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1831/assets/wa-sqlite-async-BmIDEBo6.js\":\"ae44ac5a3493e04b\",\"/knowledge-medium/pr-preview/pr-1831/assets/worker-CEkLJU_-.js\":\"8893278a9fd1f88d\",\"/knowledge-medium/pr-preview/pr-1831/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1831/chunks/app-BgZ1iJNB.js\":\"bbbee937d6ddbcf9\",\"/knowledge-medium/pr-preview/pr-1831/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1831/index.js\":\"ec9a3dffb8608898\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1831/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1831/assets/AccessHandlePoolVFS-BtpspjWg.js\":\"61f0db493aa4e8b1\",\"/knowledge-medium/pr-preview/pr-1831/assets/IDBBatchAtomicVFS-BWoSxiph.js\":\"40c8af10b3405293\",\"/knowledge-medium/pr-preview/pr-1831/assets/MemoryVFS-P0F1r1lo.js\":\"5cbcb8328addbf08\",\"/knowledge-medium/pr-preview/pr-1831/assets/mc-wa-sqlite-ClchH67d.js\":\"7d754149e959f1f4\",\"/knowledge-medium/pr-preview/pr-1831/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1831/assets/mc-wa-sqlite-async-B0Obvni6.js\":\"40ac5e7cff7727f9\",\"/knowledge-medium/pr-preview/pr-1831/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1831/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1831/chunks/AccessHandlePoolVFS-DMoKQGJO.js\":\"b9165b41d9356da3\",\"/knowledge-medium/pr-preview/pr-1831/chunks/FacadeVFS-CwSLZIpK.js\":\"c7688ba84ccf97fa\",\"/knowledge-medium/pr-preview/pr-1831/chunks/IDBBatchAtomicVFS-37bLFRE_.js\":\"93f81d8abb51df83\",\"/knowledge-medium/pr-preview/pr-1831/chunks/MemoryVFS-D7JbCaQK.js\":\"5ef65bd086d0b4e6\",\"/knowledge-medium/pr-preview/pr-1831/chunks/OPFSCoopSyncVFS-CxK8cjhe.js\":\"6c214a0a48feaa43\",\"/knowledge-medium/pr-preview/pr-1831/chunks/OPFSWriteAheadVFS-fiVIO-uV.js\":\"4efdb3b66212c30c\",\"/knowledge-medium/pr-preview/pr-1831/chunks/Preview-Cpecp31j.js\":\"8a2f0c0cb50f9f72\",\"/knowledge-medium/pr-preview/pr-1831/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1831/chunks/card-1DOHfClI.js\":\"b27ec82b2ed84cb3\",\"/knowledge-medium/pr-preview/pr-1831/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1831/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1831/chunks/dist-7rxPNzXb.js\":\"350090d8debdaa94\",\"/knowledge-medium/pr-preview/pr-1831/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1831/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1831/chunks/mc-wa-sqlite-CWfR-yzc.js\":\"49f2d133283c5841\",\"/knowledge-medium/pr-preview/pr-1831/chunks/mc-wa-sqlite-async-DkTYVY5z.js\":\"6e3d96dc859dd452\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-B71EdD2I.js\":\"999d5405d754c41d\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-BGgHxeA3.js\":\"45a9c6ed088f328e\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-BU1kQGLp.js\":\"803fe12ddab81c87\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-D3Np43GF.js\":\"81a495d6ced8e9ba\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-DC7itkPw.js\":\"7bd7bb6a9d87c0ca\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-DO1VmdLP.js\":\"fd4a468ca29889f8\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-LDeK-c02.js\":\"dd0dac24fba314cb\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-SbStmUn9.js\":\"1d78d88dd0e8cfb0\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-dom-server-legacy.browser.production-Db8Gi2pX.js\":\"f20b9002fb04987d\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-dom-server.browser.production-Cqj3JYqI.js\":\"5dccbe67fbe16e51\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-dom-server.edge.production-arHH59_Z.js\":\"3985058936e6ddc3\",\"/knowledge-medium/pr-preview/pr-1831/chunks/server.browser-CYagaa4E.js\":\"4ecdadc37fa5f283\",\"/knowledge-medium/pr-preview/pr-1831/chunks/textarea-D229ppQM.js\":\"10f7f4bc632c5f9a\",\"/knowledge-medium/pr-preview/pr-1831/chunks/ui-CSXgYRXp.js\":\"efe0bef515f2b320\",\"/knowledge-medium/pr-preview/pr-1831/chunks/wa-sqlite-QHJqersF.js\":\"2f5b8f147132b01d\",\"/knowledge-medium/pr-preview/pr-1831/chunks/wa-sqlite-async-BNcnh35p.js\":\"8490bb791a43da51\",\"/knowledge-medium/pr-preview/pr-1831/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1831/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1831/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1831/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1831/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1831/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1831/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1831/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1831/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1831/src/App.js\":\"420a6398e5dc8899\",\"/knowledge-medium/pr-preview/pr-1831/src/appUpdate.js\":\"e9c8e3ed0a467332\",\"/knowledge-medium/pr-preview/pr-1831/src/appVersion.js\":\"6177fa68ffd38e25\",\"/knowledge-medium/pr-preview/pr-1831/src/bootstrap/initialLayout.js\":\"a39106906bab8218\",\"/knowledge-medium/pr-preview/pr-1831/src/bootstrap/openWorkspaceData.js\":\"5806bf508eb7eff2\",\"/knowledge-medium/pr-preview/pr-1831/src/bootstrap/resolveWorkspace.js\":\"26fee682919410dc\",\"/knowledge-medium/pr-preview/pr-1831/src/bootstrap/workspaceBootstrap.js\":\"4722c5ea0d3119ad\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockComponent.js\":\"50521d15a377309b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockCrumbs.js\":\"de7dc702119eb950\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockEditor.js\":\"096ea5948f9811a5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockLoadingPlaceholder.js\":\"76842e67147d6b5c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockProperties.js\":\"474d31d50360e258\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockSearchPicker.js\":\"0cdde009632a5dc4\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ConfirmBulkDeleteDialog.js\":\"a8553fd7002d9d4d\",\"/knowledge-medium/pr-preview/pr-1831/src/components/DividerHandle.js\":\"53727d2153669470\",\"/knowledge-medium/pr-preview/pr-1831/src/components/DraftEditor.js\":\"36967aef7f73a66f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/GutterPill.js\":\"0b117fe3c0ab1837\",\"/knowledge-medium/pr-preview/pr-1831/src/components/Header.js\":\"ae670e9ca0cd130e\",\"/knowledge-medium/pr-preview/pr-1831/src/components/LazyBlockComponent.js\":\"37c1891ef2aeeb87\",\"/knowledge-medium/pr-preview/pr-1831/src/components/Login.js\":\"af4a1e048efe6fd1\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ZoomableSurface.js\":\"2e2e3bba979fcfff\",\"/knowledge-medium/pr-preview/pr-1831/src/components/editModeKeepalive.js\":\"6f7655e559a6a3a5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyDisplay/PropertyDisplayScope.js\":\"db03fc42e5879ac5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"19cb713e9197dfa8\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/RefPropertyEditor.js\":\"be12c2e245a6c8bb\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/RefTargetTypePicker.js\":\"80e0a3d49e2d9e7f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/SelectPropertyEditor.js\":\"1c8ce6aedd4e8877\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/TypesPropertyEditor.js\":\"4367ce122e3ea303\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/defaults.js\":\"b8619b62123d5527\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/kernelValuePresets.js\":\"95d87dcff47b5890\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/selectablePresets.js\":\"fc4cb9a897867303\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/typesPropertyUi.js\":\"d2cedd949df95761\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/AddPropertyForm.js\":\"d0502f8e71c63c27\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/PropertyPicker.js\":\"d1b2e51945d81b19\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/PropertyRow.js\":\"8cb9eb85100a6be3\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/Rows.js\":\"80885755d471e87b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/actions.js\":\"f011b532c6f7d3af\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/declarationOnly.js\":\"4dde95211dee5ead\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/layout.js\":\"7cd5ae495b27bd22\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/model.js\":\"8898fb1ea9893a73\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/shapeUi.js\":\"522372bf0c7accd4\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/shapes.js\":\"f5b7630c76e84afd\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/usePropertyEditingActivation.js\":\"abd71382c0735f5f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/visibility.js\":\"1813a8750181c5b5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanelSections.js\":\"8fca0f016850a28b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/BlockEmbed.js\":\"6579053441a09ff5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/BlockLink.js\":\"68e57662b9aa2a9c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/BlockRef.js\":\"fa4f6bf3d3d92f01\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/ReferenceLink.js\":\"c84a0fabea9242b6\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/cycleGuard.js\":\"74a8d535df5eb181\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/cycleGuardContext.js\":\"b0729a0a1b6c5e5e\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/linkInteraction.js\":\"e99f314636ebb311\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/referenceLayout.js\":\"a4ec62cc18c078d6\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/useBlockRefAncestors.js\":\"77b1060915db2919\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/BlockGutter.js\":\"f88036ae2931bb59\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/BlockInfoDialog.js\":\"94115cb0173fde82\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/BlockTypeBlockRenderer.js\":\"0263376099032e8b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/BulletHoverCard.js\":\"8c4ac2739cf271d9\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/CodeMirrorContentRenderer.js\":\"09598c6483c8967d\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ea1084becc3eff30\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/ColumnResizeHandles.js\":\"ebe1d9843f07c9dc\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d69f39d34d5905fe\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/DefaultBlockRenderer.js\":\"2ef8103607efb5ef\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/LayoutRenderer.js\":\"2bb1ddd4a9eca0f2\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/MarkdownContentRenderer.js\":\"54a59b14d2274d8f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/MissingDataRenderer.js\":\"14eda9abd5898d43\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/PanelRenderer.js\":\"e95df186ef7dc6f2\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e6d232816d38e73c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/TopLevelRenderer.js\":\"d268a0b4e30fac9d\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/blockGutterMode.js\":\"eea9f85973b41ccb\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/blockTitleText.js\":\"a04cc95b735d24a4\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/fieldCreationKeydown.js\":\"cab80c13c5875903\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/layoutRootContext.js\":\"7bc6a940d809a589\",\"/knowledge-medium/pr-preview/pr-1831/src/components/typeChip/TypeChip.js\":\"c7e716f63fbd6599\",\"/knowledge-medium/pr-preview/pr-1831/src/components/typeChip/chipStyle.js\":\"a6e2790213ee2f30\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/anchored-floating.js\":\"8a864f02dcc34768\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/button.js\":\"0bd14b43ac112f7c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/card.js\":\"2c4859c429fcf2a8\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/checkbox.js\":\"1a0aa6fd09350097\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/collapsible.js\":\"4a39c569e29e9690\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/command.js\":\"97cd6e66518def17\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/context-menu.js\":\"ef6e3579ce907dab\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/dialog.js\":\"7af25b1b84f80573\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/dropdown-menu.js\":\"6e645b2fbbc2b65c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/floating-listbox.js\":\"b995f6156fc2de71\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/index.js\":\"85e8b8c5875aeaa1\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/input.js\":\"2902b12e52b98531\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/kbd.js\":\"cc897b7fe82eeb23\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/label.js\":\"d49e4703ad0ecd3e\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/textarea.js\":\"428474b95e75d557\",\"/knowledge-medium/pr-preview/pr-1831/src/components/useEditModeYieldKeepalive.js\":\"fb0ecc6276aca2f9\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/BootFallback.js\":\"94c202835c6c33cb\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/FocusedRowLazyMount.js\":\"c35ba39e70188748\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/LazyViewportMount.js\":\"c150f47b7581c38b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/LocalDbCorruptionFallback.js\":\"aa78d136df23202b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/error.js\":\"c7cf4b7e881e49ce\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/lazyMountRegistry.js\":\"f0248611e24754a8\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/suspense.js\":\"6e9e7bc27a9457ff\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/CreateWorkspaceDialog.js\":\"e84db1c4fcd1a058\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/PendingInvitations.js\":\"1dc857485400014f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/SyncProgress.js\":\"27e3409baafe838e\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/UnlockProgress.js\":\"1da6667356638c40\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/WorkspaceKeyGate.js\":\"02cd167834801d06\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/WorkspaceSettingsDialog.js\":\"032baf1d48c8559c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/WorkspaceSwitcher.js\":\"7ad9ca06e02f80a6\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/WorkspaceSyncGate.js\":\"bfd6f0758fe0b43d\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/ConversionFlow.js\":\"3692049acf469722\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/ConversionFlowHost.js\":\"40a7dc397d462b07\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/EncryptionSection.js\":\"85d2310c02f6e259\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/attachmentPrompts.js\":\"886e0eefc98e588a\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9410fad6b4330302\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/conversionFlowDeps.js\":\"45521abdbccd80d0\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/conversionFlowStore.js\":\"962cba2a9da9f9af\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/flowUi.js\":\"7bd66a05286c7f7a\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/useConversionRun.js\":\"bd01c527719c32a3\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/keyUi.js\":\"a0535ce3e610f578\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/useCloseOnKeyLoss.js\":\"6b56c5675d2cef4b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/useCloseOnServerE2ee.js\":\"d1765299835e320b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/workspaceUnlocked.js\":\"a33a7ad5bd87982c\",\"/knowledge-medium/pr-preview/pr-1831/src/context/backgroundSubtree.js\":\"b2731d47304b7aae\",\"/knowledge-medium/pr-preview/pr-1831/src/context/block.js\":\"29406bb21269c1c6\",\"/knowledge-medium/pr-preview/pr-1831/src/context/layoutWsContext.js\":\"266d1cfe043e664d\",\"/knowledge-medium/pr-preview/pr-1831/src/context/propertyDisplay.js\":\"182091ca34f89058\",\"/knowledge-medium/pr-preview/pr-1831/src/context/repo.js\":\"df6aa6a210219618\",\"/knowledge-medium/pr-preview/pr-1831/src/data/aliasClaim.js\":\"f43212fcd53ea490\",\"/knowledge-medium/pr-preview/pr-1831/src/data/aliasSeatNamespace.js\":\"b917cd0b30a5e007\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/blockData.js\":\"1ccb3aef7f68489c\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/blockType.js\":\"540d90128deb5d07\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/changeScope.js\":\"9f3532a6b09ca010\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/codecs.js\":\"7633187cf337618f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/derivedData.js\":\"52284b9b78141297\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/errors.js\":\"7f359e7ff3ede76e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/events.js\":\"1e816303bc493d6e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/handle.js\":\"d9bfd89b3cbd2798\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/index.js\":\"ed586da5bbe5efe3\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/mutator.js\":\"6fc7f539153e943f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/processor.js\":\"353ab35b792bfec1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/propertySchema.js\":\"b506ac79d51ea74e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/query.js\":\"43c5643456d8dd00\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/sameTxProcessor.js\":\"51fa985c8cf40c7a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/schema.js\":\"d9bfd89b3cbd2798\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/tx.js\":\"d9bfd89b3cbd2798\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/typedBlockQuery.js\":\"cbd8b2caa16abf9b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/user.js\":\"b6ca72af9759c696\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/valuePresetCore.js\":\"074a296530221175\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/valuePresets.js\":\"ff342cd512fd3282\",\"/knowledge-medium/pr-preview/pr-1831/src/data/attachmentCleanerIOVerb.js\":\"497a212b0b89222f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/block.js\":\"433815c772d314cb\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockCache.js\":\"41f63308b06f7907\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockId.js\":\"73683f1ffd13755c\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockLiveness.js\":\"a0164e78b596abe8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockMerge.js\":\"f9e48f7ce8137ecf\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockSchema.js\":\"760cb41f8f4d382e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockTypeLookup.js\":\"160da9484eea58b6\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockTypes.js\":\"6632c08e703a01b5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/clientContext.js\":\"85f2c5e43cdcad1a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/dbFileSiblings.js\":\"6d255530178b0959\",\"/knowledge-medium/pr-preview/pr-1831/src/data/definitionSeeds.js\":\"3bc7cefe06105264\",\"/knowledge-medium/pr-preview/pr-1831/src/data/derivedIds.js\":\"f61378c095620539\",\"/knowledge-medium/pr-preview/pr-1831/src/data/drawnSubtree.js\":\"36b5b6c7838e2fc1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/facetBridge.js\":\"3102432905afb65d\",\"/knowledge-medium/pr-preview/pr-1831/src/data/facets.js\":\"141a859fef2b3f91\",\"/knowledge-medium/pr-preview/pr-1831/src/data/globalState.js\":\"3c29f76d243905db\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/aliasClaimRederiveProcessor.js\":\"fd88576cca0182b4\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/ancestorBatch.js\":\"d851de346b15dfa1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/blockTypeTypeifyProcessor.js\":\"de93772f93bb2066\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/clientSchema.js\":\"7b3e52d782202176\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/commitPipeline.js\":\"87f59885d9ac8039\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/devAssertions.js\":\"5e53b17b0b110b4a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/firstSync.js\":\"9b5494b08c711e2f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/freshInitialLoad.js\":\"2f40effcbd5d156f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/graphBackfillClaim.js\":\"2b60721562db6765\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/handleStore.js\":\"fa4db6372e9b2ed3\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/idleMarkerJobs.js\":\"4e66487cacabda15\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/initialDownload.js\":\"7bf34c62082e712d\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/initializeClientDatabase.js\":\"9e1ffa9b3a48f9e0\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/jsonCanonical.js\":\"15d984056284e181\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/kernelInvalidation.js\":\"00a031df21c5174e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/kernelProcessors.js\":\"4ab9f9a0091bc068\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/kernelQueries.js\":\"a05d1b0fb30b2220\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/mergeTypeMembershipProcessor.js\":\"aeb45715423d0824\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/normalizeReferencesProcessor.js\":\"23a81d608d1dd2aa\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/poolInstrumentation.js\":\"125b4cab861b1b0c\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/processorRunner.js\":\"6ba9a20f8370ab47\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyCellBackfill.js\":\"1d4ca3f6d9865d44\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyChildMint.js\":\"8f5226916ca97f39\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyChildrenProcessor.js\":\"a5710d21167dd508\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyDefinitionChangeProcessor.js\":\"15383287252a2d8f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyDefinitionSynthesis.js\":\"f02fe75c9fdc553a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyKeyScan.js\":\"f8564151dbf60c5e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertySchemaResolution.js\":\"906f7a761147b5b6\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyValueEdits.js\":\"f1034c0cdb2f8938\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/raiseProtocol.js\":\"b5776bf59e5e0436\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/readBatch.js\":\"f128214be1ed874b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/refProjection.js\":\"744795eae4cbf3df\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/referenceTargetLookups.js\":\"c88c46ca07061855\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/referenceTargetProcessor.js\":\"87f8fd8966e440eb\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/replayMerge.js\":\"96276769a183b69a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/sqlBinds.js\":\"0a134e8340b9abf4\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2653951d6c6dace8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/arrivalProcessors.js\":\"8dfb6b61ec6b3f6e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/invalidate.js\":\"108fcc40a49bd60e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/materialize.js\":\"f554fff17152db17\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/observer.js\":\"b8e8ab9aff8a3889\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/reconcile.js\":\"6ffe8c8c3b0c9c6f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/timingMetrics.js\":\"f31fb0faa45a1a94\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/treeQueries.js\":\"78dd620ab13a2983\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/txEngine.js\":\"e25a1d4ac98b1792\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/txSnapshots.js\":\"44659306a66ef9fd\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/typedBlockQuery.js\":\"c96885580f09811a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/undoManager.js\":\"d3e1ae385b139203\",\"/knowledge-medium/pr-preview/pr-1831/src/data/invalidation.js\":\"1a84ce2d32436a90\",\"/knowledge-medium/pr-preview/pr-1831/src/data/kernelDataExtension.js\":\"35c56325c2724158\",\"/knowledge-medium/pr-preview/pr-1831/src/data/kernelPage.js\":\"d172a037eacc42a1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/kernelValuePresetCores.js\":\"b0e75ea685b73185\",\"/knowledge-medium/pr-preview/pr-1831/src/data/localDbCorruptionSignal.js\":\"314b6e61068e5956\",\"/knowledge-medium/pr-preview/pr-1831/src/data/localDbStorage.js\":\"423c5ac375334afc\",\"/knowledge-medium/pr-preview/pr-1831/src/data/localDbVfs.js\":\"b459813e4581c880\",\"/knowledge-medium/pr-preview/pr-1831/src/data/localSchema.js\":\"fb0d0445c3bc4824\",\"/knowledge-medium/pr-preview/pr-1831/src/data/maintenance.js\":\"0dad21da209e91e8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/mergeProperties.js\":\"8f3685fc1aa06de1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/metricsConsoleHook.js\":\"c922b74c40988601\",\"/knowledge-medium/pr-preview/pr-1831/src/data/migrationsPage.js\":\"8e164dcc8a4176c7\",\"/knowledge-medium/pr-preview/pr-1831/src/data/mutators.js\":\"13aa8a03b01055b0\",\"/knowledge-medium/pr-preview/pr-1831/src/data/orderKey.js\":\"db3e1c6e118d55f8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/orderKeyPlacement.js\":\"0cef9bd36e24c969\",\"/knowledge-medium/pr-preview/pr-1831/src/data/outlineSurface.js\":\"5f1ca835d14d7557\",\"/knowledge-medium/pr-preview/pr-1831/src/data/pendingEditorContent.js\":\"ed51dafa02877616\",\"/knowledge-medium/pr-preview/pr-1831/src/data/pendingUploadsSql.js\":\"5afe2f98ed4a113d\",\"/knowledge-medium/pr-preview/pr-1831/src/data/pluginStateExtensions.js\":\"be66d9d89ceec76b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/powerSyncLogger.js\":\"19280e0ccbe1020b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/projectorRuntime.js\":\"fcacdafaf45522d0\",\"/knowledge-medium/pr-preview/pr-1831/src/data/properties.js\":\"39d39380f70e0fbb\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertiesPage.js\":\"3bb64c803fb361a4\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyChildren.js\":\"e9b52de597af6d7a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyDefinitionFanout.js\":\"4e9f3eb210b1e9cd\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyDefinitionMetadata.js\":\"e861944fbb992f3d\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyDefinitionRegistry.js\":\"edb0f3ed39e09298\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyDisplayMode.js\":\"36bb0f6f059d56b2\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyRowCreation.js\":\"868de067185719b5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertySchemaCreation.js\":\"8f8c74237e01e8c6\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertySeeds.js\":\"41431ad9bb389b1d\",\"/knowledge-medium/pr-preview/pr-1831/src/data/recentsPage.js\":\"09a2811b1ddbf38a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/referenceBlock.js\":\"2ca043a9fef14253\",\"/knowledge-medium/pr-preview/pr-1831/src/data/rejectedUploads.js\":\"de152250c660cac7\",\"/knowledge-medium/pr-preview/pr-1831/src/data/releasePowerSyncConnection.js\":\"86c6e45551c45048\",\"/knowledge-medium/pr-preview/pr-1831/src/data/repo.js\":\"11289e729f432391\",\"/knowledge-medium/pr-preview/pr-1831/src/data/repoProvider.js\":\"2a0b21fc7c92c9a6\",\"/knowledge-medium/pr-preview/pr-1831/src/data/rowProperty.js\":\"3685700927374cbd\",\"/knowledge-medium/pr-preview/pr-1831/src/data/searchFilter.js\":\"c68f609d1503b827\",\"/knowledge-medium/pr-preview/pr-1831/src/data/seedIdentityLedger.js\":\"9ec8dd4994a93f1f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/stateBlocks.js\":\"862ed3a65a52daf1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/structuralEditPolicy.js\":\"946c6299fbd82363\",\"/knowledge-medium/pr-preview/pr-1831/src/data/subtreeDelete.js\":\"8716ad0c965d2e5a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/syncStreamLock.js\":\"129b5ee14becbc1f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/syncedTableSqlRecognizer.js\":\"ea7fdb65b3620a9f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/syncedTableWriteGuard.js\":\"143af775181cafe4\",\"/knowledge-medium/pr-preview/pr-1831/src/data/targets.js\":\"bd069d662209fbee\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeColors.js\":\"2e4263aa6de8b6ba\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeDefinitionMetadata.js\":\"7ee5dfb782db8284\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeDefinitionRegistry.js\":\"62f7fe87a91b51f5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeExtraction.js\":\"0b1abc3e6155c89f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeInitialValues.js\":\"e54895b6f8404df0\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typePropertyGroups.js\":\"670333854bbe773c\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeSeeds.js\":\"fe9fc2c91cf2f571\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeTagger.js\":\"edea7dc954b335cb\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typedRecords.js\":\"6477e9caa257d0eb\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typesPage.js\":\"162ca84bc80b4cb1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/userPrefs.js\":\"b547b4468a59544f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/userSchemasService.js\":\"8bc3241338bbad2f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/userTypesService.js\":\"f6817a261b0e2eb5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/valuePresetRegistry.js\":\"b930aecb47037abc\",\"/knowledge-medium/pr-preview/pr-1831/src/data/visibleChildren.js\":\"8216dff93881eed8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaceConversion.js\":\"2fb4b313528de90d\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaceFirstSync.js\":\"eefe6eb49392a07d\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaceIdNamespace.js\":\"2ac55fb7178b190e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaceSchema.js\":\"2d0ef732729715a0\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaces.js\":\"ffa235c92f83d1da\",\"/knowledge-medium/pr-preview/pr-1831/src/data/writeAheadLog.js\":\"aac1eb4ec08889ea\",\"/knowledge-medium/pr-preview/pr-1831/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/BlockPasteShellDecorator.js\":\"860e38064d78c6bb\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/atTrigger.js\":\"197fbfa02968506d\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/autocomplete.js\":\"ef59ae75e08b85d6\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/codeMirrorExtensions.js\":\"dd88dcf15882e256\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/contentFlush.js\":\"c468b18e3bbb7b7a\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/defaultInteractions.js\":\"73497fcf29b9a76e\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/editSettleSignal.js\":\"750b6c0b60943302\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/insertImage.js\":\"cc3961c0dc43fb3a\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/referenceCompletionRange.js\":\"a5f64ad163bd1335\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/referenceTargetTypes.js\":\"1c5f8ebd4384510a\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/syntaxContext.js\":\"eb2bfd3adcfd0bc0\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/triggerMatch.js\":\"728209451e8056d5\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/AppRuntimeProvider.js\":\"c0e4984036f00aab\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/BlockFocusShellDecorator.js\":\"73a1183d8dc7cd1d\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/ExtensionRenderBoundary.js\":\"fc0151fa7905c150\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/PanelContentRecovery.js\":\"3e0c414be2157e7d\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/apiCatalog.js\":\"c4b0c2565d9a06d0\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/approveExtensionHere.js\":\"85c52937a58a3c90\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/armedCutAppMount.js\":\"1b935be6be730024\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/batchableKeyedStore.js\":\"a0ecdb7cb4292f26\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/blockInteraction.js\":\"710ad4c64cf95f2b\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/blockSelectionAction.js\":\"5fc047dcb76147c4\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/compileExtensionModule.js\":\"0fd51402fae2d863\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/compiledModuleCache.js\":\"5ed98b67a9f16544\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/continuousGestures.js\":\"45a54c0daa54b936\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/core.js\":\"ce2298411359b140\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/defaultRenderers.js\":\"3bc0d7cf307b9444\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/definitionFanoutAppMount.js\":\"f0b1a5e06c51e59b\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/dialogAppMount.js\":\"909477a25ed03d7b\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/dynamicExtensionSeeds.js\":\"76518d8d843caec9\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/dynamicExtensions.js\":\"bd5a162094c85bea\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/exampleExtensions.js\":\"1e72fea0704326db\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionApprovalStatus.js\":\"8fa299f91f9b4c32\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionLoadErrorToast.js\":\"fb42459c5b7a09ab\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionLoadErrors.js\":\"8c9d7f3af6c7bf7b\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionLookup.js\":\"a55ede6aebf1a19b\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionToggles.js\":\"9a23ed81fb567fa3\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionUtilitiesCss.js\":\"c79909ad81b84722\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/kernelPageDeletionGuard.js\":\"0f27865dc035dd38\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/liveRuntime.js\":\"0aac0e17669f8b93\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/openExtensionsSettings.js\":\"0b60d46d2d64b2e8\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/overridesCache.js\":\"60b21d07aac03914\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/pluginIds.js\":\"49d5f4927f75b8cb\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/processorRejectionToast.js\":\"49f4fa5d7ff47cc7\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/runtimeActions.js\":\"3ee502159a25b1f7\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/runtimeContext.js\":\"dce6c55e779bee52\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/staticAppExtensions.js\":\"97964d90141ea566\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/staticDataExtensions.js\":\"2cb77b5969eb311f\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/toastAppMount.js\":\"43e2b09474fb176f\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/useOverrides.js\":\"0bcd13eeb5a3208c\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/useShortcutSurfaceActivations.js\":\"f402688983c02a3c\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/discoverToggleTree.js\":\"8770d8c5dcd59208\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/facet.js\":\"9b10e584d0a54cc8\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/resolveAppRuntime.js\":\"35541f204df8a865\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/runtimeEvents.js\":\"6008afcc33475570\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/togglable.js\":\"ecc5904ffd035f05\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/variantFacet.js\":\"a14dfbe9316bc94c\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/verbFacet.js\":\"2a38bac643898455\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/block.js\":\"eb08204760d5b5d0\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/focusedChild.js\":\"dc3c63700aa7cba6\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/propertySchemas.js\":\"931458395995f483\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/typeRegistry.js\":\"0af70a4842fe4875\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useAncestorCrumbs.js\":\"5551d5b56fa86d3b\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useAutocompleteListbox.js\":\"b2e4d585a4696571\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useDebouncedSearch.js\":\"3ae9c17ff7b46bc6\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useDebouncedValue.js\":\"14633dcc9640aea9\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useIsFocalRender.js\":\"c47721b7fb961b74\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useIsReadOnly.js\":\"fe31514dc0d26110\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useMaterializeBacklog.js\":\"4dc9d80e3084ea73\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useMinuteClock.js\":\"cbc79042b7e92cd5\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/usePanelLayoutProjection.js\":\"6583ab671fdaf4e0\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/usePendingInvitations.js\":\"85881f30deaa76c7\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useRendererRegistry.js\":\"6c5ff6930c205627\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useRetainedFieldRows.js\":\"4f439cc406a663f1\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useWorkspaces.js\":\"05121322feb64125\",\"/knowledge-medium/pr-preview/pr-1831/src/lib/utils.js\":\"c5cfb935dc1ea260\",\"/knowledge-medium/pr-preview/pr-1831/src/main.js\":\"0c8345afb284dfc3\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/MarkdownImage.js\":\"e25d7222d5422769\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/blockSeparators.js\":\"70565914b86cff4c\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/context.js\":\"b671f1abe8af5e65\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/defaultMarkdownExtension.js\":\"176ada1bbcbb12ec\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/extensions.js\":\"ffeaa4c65ce04af0\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/renderMarkdownHtml.js\":\"218e61b1bf812b07\",\"/knowledge-medium/pr-preview/pr-1831/src/minimal-editor.js\":\"aadb124761af3e23\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/armedCut.js\":\"808a579d042842e4\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/captureMediaVerb.js\":\"a4d5747c357d2456\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/clipboard.js\":\"48e11e88603f05ee\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/decision.js\":\"330800f84b3d0239\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/operations.js\":\"f198c7f0b96646e1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/account-header/AccountHeaderItem.js\":\"9d2ca74cd449cec5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/account-header/index.js\":\"6e8300f5b20b85ed\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"85cadcc4ae2dc3d2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/askAgent.js\":\"3c0c1016ad4fb264\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/askedStore.js\":\"2ec2bcc383359aa8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"e2280e5b4e63b066\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/chipState.js\":\"1b14dc9bc015911d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6aeb5f1de93a183a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/index.js\":\"8667b5e752b7e709\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e24c4fd1c6aaa0a5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/schema.js\":\"e1d07d6e03bf492a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ca633b045eb681f2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/BridgePairingDialog.js\":\"661384f83e21574e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/addMedia.js\":\"263b9010a3a1b5a4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/backlinks.js\":\"05fd7449f5eea327\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/block.js\":\"a77f5baede776cf3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/context.js\":\"061a34f2422cae2b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7bcf3ed9d9367a71\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/index.js\":\"163a1a5d4693ee3e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/outline.js\":\"f4a0753921463eaa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/properties.js\":\"198fe877efacf81c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/refs.js\":\"7abcd7329c927355\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"242b547697bb0f2f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/search.js\":\"2fa2609e66b392fc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/shared.js\":\"aa333642a172ac6b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9e51469c2df9d2bc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/text.js\":\"72e87d6dbaab3879\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentWrites.js\":\"2c29729a682fd3b0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/authoringCatalog.js\":\"7bafba2431071601\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/blockRefTargets.js\":\"31b279426df986f3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/bridge.js\":\"27ffa14abade8566\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/bridgeLoop.js\":\"a581abea4a6b5b21\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/changeHistory.js\":\"d7822bb05de402d1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/commands.js\":\"10ca664fadd508b5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/commentsCommands.js\":\"347baa91b698bbfc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/dataExtension.js\":\"5a6c9182dbe09e37\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/dataModelGuide.js\":\"d409957ed92a612c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/describeRuntime.js\":\"8107ccfa7db75501\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/extensionLint.js\":\"0302fee42cc961e4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/grainAudit.js\":\"59b55f1b45a3843a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/healthCommand.js\":\"eeb25544c27f62fd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/index.js\":\"15fcc7f3e1b1d89c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/presetIdentity.js\":\"a441a0089441c2c0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"78f5e89a94f189f3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/readMedia.js\":\"df5573909993b27e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/schema.js\":\"b1b28d54d3031d5f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/serialization.js\":\"3da9fe856377c815\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/targets.js\":\"acdcd7f30afa4314\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/tokens.js\":\"e0611955f3068d9f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/watchEvents.js\":\"2e9ea49f3d713478\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/workspaceGuard.js\":\"991f28601a9a38ea\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/writeCommands.js\":\"ae19127f9a617ce6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/AliasCollisionToast.js\":\"e110e11064a73bfa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/DuplicateNameBanner.js\":\"396337a4bc425958\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/collisionMerge.js\":\"dc982986b91d6086\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/dataExtension.js\":\"1a88cdc953d6b64a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/index.js\":\"32166a471e600f48\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/mergeCollisionAction.js\":\"2360d23dda750bab\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/pageStyling.js\":\"245bfb6ade07f884\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/rejectionToast.js\":\"a027db8d52a73021\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/syncProcessor.js\":\"615d623b5ab04c02\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/actions.js\":\"e35ad59c58b6492f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/addComment.js\":\"3a88226e5bf8ab09\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/anchor.js\":\"9b54b03787c151a5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/anchorState.js\":\"1a96c8c782a2dfaf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/commentLinks.js\":\"2708432f30d07702\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/confirmThreadDeletion.js\":\"00189f5c33237772\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/container.js\":\"ef3472e6f1874065\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/dataExtension.js\":\"7c111ac5eb1977b7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/deleteComment.js\":\"e5173a439f0d2afd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/highlights.js\":\"45c2af5ecc336294\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/index.js\":\"5e119d2a32e3b7f4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/linkedCommentsPill.js\":\"ffcb777f2221f6b8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/margin.js\":\"02d24163dbc353e9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/marginSchema.js\":\"651da368aa024970\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/newComment.js\":\"6db1b6d7d112627a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/ownThreadPicker.js\":\"ec4b3f7274d981fe\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/placement.js\":\"71f15e070693c683\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/queries.js\":\"8be653434857be64\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/quotePosition.js\":\"b12a8e8ee55b324b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/quotedIn.js\":\"d2e8211ac04c6eea\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/quotedRange.js\":\"006fb6704ebe2d65\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/rangeRefs.js\":\"518ffe4935ec271e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/readHighlights.js\":\"31dd7b1a68e0f7dc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/readSelection.js\":\"96f231134e31c3c1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/readSelectionUi.js\":\"53bf367aae031df6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/reanchor.js\":\"8e96c1cf3f668ced\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/schema.js\":\"37f88e8ab7205ed9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/scope.js\":\"611de7903e365721\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/scopeThreads.js\":\"b0afb906a1014dfc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/splitRetarget.js\":\"91ca7e1429072911\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/suggestionCard.js\":\"c7ec53a74bb445c2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/suggestions.js\":\"5406f27f2aeea071\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/summaries.js\":\"96d2440c301539de\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/summaryBatch.js\":\"bca60c60d37738a1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/surface.js\":\"1cf5941b25aad16a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/threadNavigation.js\":\"74d1abc59cd46065\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/threads.js\":\"324b239567571798\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/ui.js\":\"66bb214cf9b096c0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/uiStore.js\":\"b627d6c2da5809bb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/app-intents/appIntents.js\":\"f097f69555fc5868\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/app-intents/index.js\":\"9d51db0c2751c951\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/app-update-prompt/index.js\":\"f7b4bc97a2c233ce\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/app-update-prompt/status.js\":\"a65225744a6c7e1a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"da8b037a0a8a3780\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/MediaBlockRenderer.js\":\"9f65a3885f1c21eb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/MediaDownLaneReplicator.js\":\"be1a03c7ec760c26\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/MediaUploadReconciler.js\":\"2506cbf43f098903\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/assetDownLane.js\":\"974efc5a648857c8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/assetResolver.js\":\"a7952e0919e7047e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/assetUpload.js\":\"28ed08d1eebb9732\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/attachmentCleanerIO.js\":\"e4f0b084b7a0ea28\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/supabaseAuditIO.js\":\"46f11f2466f2d8de\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/blobStore.js\":\"490b5995eb5c4ff7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/byteStore.js\":\"21e0c2d9c465802a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/cleanerIO.js\":\"f3e77fc7958012ad\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/cleanupAttachments.js\":\"849f8c3a4ec3752e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/dataExtension.js\":\"ebb5d32898db3f81\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/downLane.js\":\"db3a4397dab80718\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/index.js\":\"084447ae33587383\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/insertImageContribution.js\":\"1663d4346fbdf891\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/laneArming.js\":\"fcc7fc6b1c263fd7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/laneLock.js\":\"bd8151213c6034bf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/mediaBlock.js\":\"22c75ad5cd534e42\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/mediaCapture.js\":\"f3f360037f98b538\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/mediaViewers.js\":\"0275a53d517f8b8e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/mediaViewersFacet.js\":\"b5074411957888ea\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/pasteCapture.js\":\"de8fa05b1fb5e568\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/resolver.js\":\"f49a648343631a07\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/retryUploadsAction.js\":\"9f4ae320eeed4bf0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/storagePaths.js\":\"b631e3400cf674de\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadDrain.js\":\"1f251421d9f515b0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadLaneStatus.js\":\"78a59e2eb8ce284a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadReconcile.js\":\"1db538b81f9a57db\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadRecovery.js\":\"83030e87213b76b8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadStore.js\":\"c1b16eab76237315\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/useAssetObjectUrl.js\":\"8fa5e155f9a29aac\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"2142b9fc6d696b2d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/BacklinksViewSection.js\":\"66aa2649f68e6cc9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/facet.js\":\"093543d165db3bfc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/index.js\":\"8ca59ef5fc4bebf8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/prop.js\":\"ba561fb3fb0b7c29\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/BacklinkFilters.js\":\"4400665ddd665db6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"87765064aee4a995\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/BlockEntry.js\":\"6ccbf6545cf47d7e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/LinkedReferences.js\":\"93aff2b3ddfac97e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2224f50075e672b6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/dailyNoteDefaults.js\":\"96a65a0edf128301\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/dataExtension.js\":\"7b43fd6f900a3162\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/edgeExclusions.js\":\"522b251648a675b6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/filterProperty.js\":\"2128c03a3a5a4365\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/index.js\":\"1ef781b615ffd538\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ac00caa0c40be02d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/applies.js\":\"cfbcb3ff08604a40\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/countQuery.js\":\"87e788cb5e7e4b41\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/expansionStore.js\":\"dc6c95ce87b3ffea\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/index.js\":\"a06667754dfea2fa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"005812520bce66f1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/presentationInvalidation.js\":\"d85c6e2a7be4d2ab\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/propertyEditorOverride.js\":\"89198ace6e2339dc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/propertyFilter.js\":\"57beee8907f7abe5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/query.js\":\"2cb719a6b6211e74\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/resolveFilter.js\":\"64a58e88c0990afc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/sourceBatch.js\":\"990c36a92357b0c6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/sources.js\":\"2e64db3bd90c8bb1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/useBacklinks.js\":\"5afa60edc1515ea9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f5cd6c1b8faaaf33\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/BirthdayCelebration.js\":\"01aca430a301076a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/BirthdayOverlay.js\":\"660300640a60bcd3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/gate.js\":\"dade99f1d9a2d456\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/index.js\":\"f3303508fb89f170\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/wolfTheme.js\":\"7f9f47aa91aa167d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/BlockDragLayer.js\":\"a0b8fab6c7d3070a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/dragController.js\":\"124466e030f6c0a6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/dropTarget.js\":\"44006bbc23b3db67\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/index.js\":\"b9aa233d3a1f6dad\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/projection.js\":\"af1f68d6f22975f2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-info/BlockMetaCard.js\":\"437155ddc435b678\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-info/index.js\":\"b6cf02a1fffa24e7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/AddTagDialog.js\":\"f2f7b3e195fff04e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c721cf2b19282535\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/TagNameIssueHint.js\":\"cdcae3d1b0b2e0e7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/addTagAction.js\":\"0c8a0711a803619a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/appendTag.js\":\"d1da94d1488eeaae\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/config.js\":\"51dc61dc88e20657\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/dataExtension.js\":\"de6cd9852f7193c2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/index.js\":\"72f2c548bdcf0e3e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/propertyEditorOverride.js\":\"1e10a1467c2f70b4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/BreadcrumbList.js\":\"57187e353a5b40ae\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c0561d81f128c65b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c7be394ee08476aa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6f45e2dc8e548ea9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"74935bfc8c84a69d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/index.js\":\"c5bf8cafe02c90fb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"01a0210356f9375f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/CharacterCountItem.js\":\"06f4fc4ea5585476\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0d6192056c8b36be\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/actions.js\":\"66b17cd3fed2dfc4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/blockType.js\":\"71600fe73277a572\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/charCount.js\":\"05f1a59f0135512c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/dataExtension.js\":\"fbd6c3d3d6b93779\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/index.js\":\"bf16280499335570\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/profiles.js\":\"2f543a072c715a17\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/properties.js\":\"e5ee250e3ecc9649\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/textCounts.js\":\"3b2d9e6b30b9c663\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/colemak-keybindings/index.js\":\"a651f9cbe2fbf591\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/CommandPalette.js\":\"f577ba7f4bf64eda\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/HeaderItem.js\":\"927f0d1a559fd308\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/context.js\":\"f1367d9f8aa9cb35\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/index.js\":\"31abb0d3d81d70c4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/selection.js\":\"9b9b4961bd807d36\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/toggleStore.js\":\"e33876f646ae9d82\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/useCommandPaletteActions.js\":\"88560db086a4139a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/ContributorBadges.js\":\"ab8cda39e0434c56\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/author.js\":\"ca647bef05b209c3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/codeMirrorExtensions.js\":\"055d8628261e8a23\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/dataExtension.js\":\"ec550b28a512146a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/index.js\":\"2d54edb5edfc83a6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/mentionAutocomplete.js\":\"eca071f194e02cbe\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/processor.js\":\"bb0abb0b29a16f70\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/profiles.js\":\"5ea54a389ad2a8bc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/queries.js\":\"075935dc91978996\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/schema.js\":\"31522a6da68abdbe\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"23aeb2889452cb01\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/followOrigin.js\":\"561ee1343e710cf0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/index.js\":\"ebf621749785ffa9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"94c2250a86e5090e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7ef837fb11e84758\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/CalendarGrid.js\":\"59a1e4322c3b9d50\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/DailyNotePicker.js\":\"30d09ef25983f6f8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ea65cf3f59fd4ac5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/DateNavDecorator.js\":\"d617beaaa455f318\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/DateScrubOverlay.js\":\"7d178447cbe75979\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/HeaderItem.js\":\"441b6a6d2597b9c7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/ReschedulePicker.js\":\"f1fbc3705beda857\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d9d9282238a3711b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/actions.js\":\"b6106c73cb87d868\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/blockDateAdapter.js\":\"999025c3ced447da\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/calendar.js\":\"51a61bc5d13541d0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dailyNotes.js\":\"ac644ed34a921bd1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dataExtension.js\":\"4f5bac847f19c5a8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dateScrubActions.js\":\"3b209a16c0724095\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dateScrubGesture.js\":\"9b7effa7b707c7ec\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3991657fdc64ee00\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4b3d3f45aae63658\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/deletionGuard.js\":\"f163c00c3af2fffd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dueQuery.js\":\"9fb2498232183b34\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/index.js\":\"0d8e94c9e8b3f708\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/landing.js\":\"87e774501bf9e787\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/localSchema.js\":\"79183be400b8c35a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/referenceDateAdapter.js\":\"7a3ff7d2e412bc5a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/rescheduleAction.js\":\"efef978214ce1b6e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/schema.js\":\"d71d48ffcbdea539\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/spreadBlockDates.js\":\"f3197cb6a79b114c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/spreadDatesAction.js\":\"fcc2f37615ba9ad6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/today.js\":\"104c4ec1c3b6a54a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ddc3f1aa7c471219\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"19f94f035f1eba90\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/audit.js\":\"06df588527e93113\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/auditAction.js\":\"66cb4f6afc77847c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/auditRanges.js\":\"fc3dfbd4a484e498\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/diagnosticsSource.js\":\"ecda488753bc3d4d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/divergenceScan.js\":\"8de8817250383575\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/index.js\":\"cfa3ab2441b4af0f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a0c4147d51f64297\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/referencesMirror.js\":\"cda8f8a3aff62170\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/rowJson.js\":\"35427ce31abdcfd1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/schedule.js\":\"e9b4cee34eb65062\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/store.js\":\"30057b3e4f095dad\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-maintenance/action.js\":\"35efe407b0e7fa4c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-maintenance/index.js\":\"05204f046a23b033\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-maintenance/plugin.js\":\"b2ba00b12333b43d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ad60e86e6321f625\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/actions.js\":\"76f808e26ef9d36f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/changeMarker.js\":\"d26c7a125aa6dba7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/diagnostics.js\":\"fb05722b16e07ebc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/fileSystemAccess.js\":\"e3416911fa83b250\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/filenames.js\":\"b485ef8d937b4c8b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/index.js\":\"1f711651775cb2db\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/mirror.js\":\"5a7cdcfcc34970cb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/runLock.js\":\"0a9e340de4eb75df\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/runtimeHealth.js\":\"404d8353702065eb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/schedule.js\":\"af7119ea3feaaa6f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/store.js\":\"a91be25f623c08a7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/default-themes/index.js\":\"7dcdc75c06c0bfb7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/default-themes/themes.js\":\"937142d3ca832d99\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/diagnostics/facet.js\":\"d11bca4b311601b0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/diagnostics/useDiagnostics.js\":\"c757e99a2b8392b1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extension-prompts/dismissals.js\":\"b8fb1fa84f5aa7f1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extension-prompts/index.js\":\"5e932152b448d857\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extension-prompts/status.js\":\"71181f01d48d7eab\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extension-prompts/store.js\":\"2fd5c54bf1843753\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b9b35529d65a46a8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/ExtensionsSettings.js\":\"450579bed0f3b295\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/actions.js\":\"eaea8046ed508d5d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/config.js\":\"96e1a318723d059b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/dataExtension.js\":\"373e5e72bc5d3b17\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/effect.js\":\"b651796f97e110b9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/index.js\":\"ae0d5dd36b13c073\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/propertyEditorOverride.js\":\"909d13e64ddc326f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/useToggleTree.js\":\"a9564396a7fd79e4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/ExtractTypeDialog.js\":\"93765c5f4c89a5b1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6a70e68a6f5248ba\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/PropertyShapePicker.js\":\"a02665ef493f0eb5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/action.js\":\"f0b7baedd9f76aa6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/index.js\":\"d823e6f85617d2b1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/FindReplaceDialog.js\":\"da952b0890912b3c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/HeaderItem.js\":\"fa3c4b55e0496477\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/dataExtension.js\":\"87f1ec4993d06ba6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/index.js\":\"a92001964cc0de6d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/search.js\":\"372a5bf7a3f36dbb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/toggleStore.js\":\"b765e4acd80a4371\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/LocationPropertyEditor.js\":\"81d8cc67b6c36df6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/MapView.js\":\"61eb74911cf42704\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/blockTypes.js\":\"6e4fe39f39610512\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/codeMirrorExtensions.js\":\"6c0e6729b7e6376a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/createOrFindPlace.js\":\"388a3106b6aa68e5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/currentLocation.js\":\"04a9a219fe3f4eec\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/dataExtension.js\":\"3a7e4ffa5bc0d3b2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/geoContentDecorator.js\":\"acfc4ca24df20c50\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/googlePlacesClient.js\":\"785d643b6ab4050a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/index.js\":\"11f20db65b717456\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/locationsPage.js\":\"65caabb3e4008ec4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/mapViewport.js\":\"7a9f299e0926251d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/pickCurrentLocation.js\":\"a3af3e198ba72a28\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/placeAutocomplete.js\":\"f29b8bc9a55f1d6c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/placeNameCollision.js\":\"e299ebccc6d41c11\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/properties.js\":\"52291cb1af123aef\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/propertyEditorOverrides.js\":\"da0b2d8a6a2fe627\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/query.js\":\"352b6d9a4e12ae86\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/usePlaceSearch.js\":\"3773c634ec2dffc8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"774de4dfdcd29e14\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1c52591a8637004c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4a9c80c79eab169c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/config.js\":\"6886e0b32e915d3a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/dataExtension.js\":\"cabe69c07c8e5d0a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/facet.js\":\"2a8c26ffacdb862a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/grouping.js\":\"f37f6abcb6ccb6bb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/index.js\":\"720960c1bddac209\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"641028326aae2f85\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/query.js\":\"0f598b30a80804ef\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/resolveConfig.js\":\"69d26d6fdc2cf991\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a4f1ea37c0e33082\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9b84275bbee9e97f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/HtmlDocumentContent.js\":\"041a2e748a1c73d1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/HtmlFrame.js\":\"42aff8414ddcd56e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/actions.js\":\"eea881dee5e45647\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/blockType.js\":\"ea8398994728938e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/confirmRunScripts.js\":\"0e42647c1af39a90\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/dataExtension.js\":\"773a2a138c465016\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/frameAnnotations.js\":\"6313f7fad4355030\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/frameDocument.js\":\"21125d326903f646\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/frameTheme.js\":\"07ec28a54b695dc8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/index.js\":\"9d341c53ae67f9f8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/scriptConsent.js\":\"b9f7d9429f1ca032\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/sourceMap.js\":\"3d4eecef8b09a528\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/useDocumentScripts.js\":\"2c936d615bfeb29d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/index.js\":\"3febf40c6745b624\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/record.js\":\"997aec4423cab7b7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/recordStore.js\":\"49d6b4b63b5bc14d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/responsiveness.js\":\"064f39ac628575be\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/schedule.js\":\"1377b378487850c6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/sessionContext.js\":\"bed6e1e55b2b4ff3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e8c36818003e81ae\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"bd3e4c76bbaad769\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/actions.js\":\"aa90ef71012c0c69\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/config.js\":\"34cfcf030290e5c6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/dataExtension.js\":\"3c4b35608fdb32bf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/effect.js\":\"b69b69395746330f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/index.js\":\"ac985de56eea1f5d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/keyCapture.js\":\"402422ee2ba27761\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/overrideStore.js\":\"8f7da3357d07d019\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"2bf1f61fed088d8f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/HeaderItem.js\":\"567b67b9fe41b989\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/LeftSidebar.js\":\"acf9790f13753626\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/actions.js\":\"3bfc5b76c2ffd9e3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/facet.js\":\"2b69c852104976cd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/index.js\":\"a879dec9d86428bd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/shortcuts.js\":\"51b331cae57ab70e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/toggleStore.js\":\"15bd4cfcb8287ec7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/merge-blocks/MergePicker.js\":\"7538b2d7c1123dab\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/merge-blocks/index.js\":\"1e16b06205ae8c3c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/merge-blocks/mergeAction.js\":\"f5928babceb6eb54\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/merge-blocks/strategy.js\":\"332e0db63596420c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/Button.js\":\"2c66eb7202a3d233\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0d7846044aafc9a8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/defaultItems.js\":\"2108ddfd6e73926a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/facet.js\":\"f12f755792263ba8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/index.js\":\"5bccd909fa3ba9d8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e22bbb8aeede7b53\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/actions.js\":\"cf43c61e68150628\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d65e1a31c672bc97\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c7b8f372226277f1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/index.js\":\"82bf9474c84052c8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7a60b71ff44283aa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/blockSubtreeMembership.js\":\"22ab447d0274d085\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/contextMenuItem.js\":\"344c7a8532cfdc17\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/index.js\":\"e1eee00e71809e61\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/moveAction.js\":\"8d817cad67588902\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/moveBlocks.js\":\"bb896401c13df264\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/selectionAfterMove.js\":\"340a364313afd6c1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/TutorialBanner.js\":\"da2ff87dbe186059\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/action.js\":\"5d0c2b2a46fc6073\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/bannerDismissal.js\":\"7b60035729136db3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/documents/cheatSheet.js\":\"125d154f420633e8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/index.js\":\"feb0d47dec71690c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/keys.js\":\"d6683bebd70628d2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/landing.js\":\"0014b84a07951c6f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/outline.js\":\"0a7736066190629f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/seed.js\":\"da4d1e2f223b696a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3b7a837a996d3a93\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/analyze.js\":\"e555439f2980267f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/diagnosticsSource.js\":\"31722b32652513ea\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/index.js\":\"0483fe6031303ac3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/load.js\":\"54ccd1560777f2a7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/monitorRun.js\":\"22967afc30c50ff7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/schedule.js\":\"62b133d7b134032a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/series.js\":\"f2356b1974389b8f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/store.js\":\"a07ae67972e93271\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/trendAction.js\":\"707aee95ef52abdf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/verdict.js\":\"0a874e39ebec8eb3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/plain-outliner/clickToEditAction.js\":\"16b56780dd7b4cbd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/plain-outliner/index.js\":\"3164a30b354771f6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/plain-outliner/interactions.js\":\"8d5b88cbc2c043dd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9945567ba99ffeed\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/MigrationGate.js\":\"1c2a273d03675f8e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/MigrationGateDialog.js\":\"96ffe6804a3f426f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/action.js\":\"3ccc27541c3dae5e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/index.js\":\"d710e4b5e002c407\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/localRunMessage.js\":\"fa3914bb0370866e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/plugin.js\":\"eed5918a328c4682\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/progressReport.js\":\"3598a84d8081899d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/sweepProgress.js\":\"65fade36df510a3e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/FieldRowRenderer.js\":\"6b948ae41bca80f2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/ValueRowRenderer.js\":\"741649971d1db939\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/actions.js\":\"d3292841a9434f68\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/autocomplete.js\":\"e398d96fc319913d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/fieldRow.js\":\"a322146a00d0ecd0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/index.js\":\"428cab54d4b0b693\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/referenceWarning.js\":\"bcd9d2ee70cb1d46\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/valueAutocomplete.js\":\"3dea34f86b3ab57d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/valueSchema.js\":\"808668c1f515ee4c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/HeaderItem.js\":\"c7e3711cb531602a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/QuickFind.js\":\"571855d33706a7d8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/index.js\":\"a4a91b85ffb1d42b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/recents.js\":\"5bf7083717b47567\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/resultItems.js\":\"d501ad2e6702bdb3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/selection.js\":\"210ad16981e56182\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/toggleStore.js\":\"deb23ed36dd79326\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/HeaderItem.js\":\"c4eae78caf3687f4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c10b6c478fdb380a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/grouping.js\":\"00f20ecd98e42def\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/index.js\":\"96a1c527c6b99a5c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/target.js\":\"eb65a1abb910007d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/codeMirrorExtensions.js\":\"cda60fa983f010a9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/contentPrefill.js\":\"b0174ee044de0ff0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/dataExtension.js\":\"4f4730fd1434de4f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/index.js\":\"d2dfe81c6c1fcd96\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"57b281e0e888d706\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/invalidation.js\":\"693ba38b1f77d884\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/localSchema.js\":\"dc5c2c99f8a52ce4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/blockrefs/index.js\":\"f5ecaf52cc756b0c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"fc15618abb30ef71\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/index.js\":\"9df005d8e53264a7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/referenceNode.js\":\"3404f7dd94018179\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/remark-reference-occurrences.js\":\"41b38c24a602abf3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"22e2b97d937b9d58\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/wikilinks/index.js\":\"c201e55531e632e0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a2a51eb48337c3c4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"cf1d4502d3ab8452\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/mergeRetargetProcessor.js\":\"801d7a7b35d311d4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/parseFence.js\":\"e58d2d5cfa737fbd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/referenceParser.js\":\"11d2e583b91dc985\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/referenceProjection.js\":\"2dbabe5232d31399\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/referencesProcessor.js\":\"eedc31c497d0e824\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/renameProcessor.js\":\"ff6e690973812346\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/spanReplacement.js\":\"67711f4ed697928a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/rich-paste/htmlToOutline.js\":\"b293d7fdf0d0b0e1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/rich-paste/index.js\":\"c7b6be60d7dfca79\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e4fdc124a1eb18ba\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/rich-paste/pasteDecision.js\":\"f977ea05c9d99f16\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/action.js\":\"e452d013df6ca717\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/blockIds.js\":\"b2594cc71398d6c6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/content.js\":\"ed9c5b18145acdb7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/effect.js\":\"0fcf9e69b9837da3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/ids.js\":\"3bafee22997fe9a0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/import.js\":\"00044d4acaff474e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/index.js\":\"f21fd9185f8f6e43\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/plan.js\":\"c9d89ae3fab001a1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/plugin.js\":\"d8743397b9ee6b99\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/promotion.js\":\"cf9c8e2ef46dca88\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/properties.js\":\"65fe5d7cc294d344\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/references.js\":\"91627f223fe36c22\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/report.js\":\"458a28571c0ce853\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/roamMemo.js\":\"5c600bbc4c4646f9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/runtime.js\":\"5a9b170fc859d779\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/schemaReconciliation.js\":\"aa4df09c474aecf4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/srsMarkers.js\":\"2f12503e14e722b8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/todo.js\":\"b5efa8a0103ca052\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/typeCandidates.js\":\"bb1e3ec48a9a4d62\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/types.js\":\"f76dea4dd9cabefa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/search-health/index.js\":\"9c01a202e1c472f0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/search-health/store.js\":\"7357eda99aa9a1da\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/HeaderItem.js\":\"a384860235c67807\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"dfdc64ea6d49f36c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/index.js\":\"92247b9101dafaac\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/model.js\":\"dc0df32665b7bf3c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/toggleStore.js\":\"d1971cbbec0016d0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/useKeyInspector.js\":\"fd75272e05d8fa97\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f1a43e1c70687201\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/ShellDecorator.js\":\"1e50f8d3e36716bc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/actions.js\":\"52ecb55a320eb6ba\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/exclusionsFacet.js\":\"1b88bcf014070833\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/index.js\":\"94354e7275967292\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/shell.js\":\"dee160ea137ffee7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/surface.js\":\"e5d9b9b0428cedaa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/walker.js\":\"286ee1642028adc1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/RescheduleToast.js\":\"77ac2d2e20b1ed33\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/dataExtension.js\":\"c3f76626d189e4c2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/index.js\":\"bd577d1850b38814\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/indicator.js\":\"2c2be94fc330df86\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/moveSrsState.js\":\"08590f2d85a4049d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6545340840e3808f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/scheduler.js\":\"85ff51dbbd4f87ec\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/schema.js\":\"428c841b189b4ef7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"139a23c3d27528e7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/srsClipboard.js\":\"745a5b41181af299\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c8162b91ffc4e5e9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4f64fcc9d553b30b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/DeckPicker.js\":\"3fd6c8e1df3bdd0b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/ReviewControls.js\":\"8061272ec10a83b0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/ReviewDeckRenderer.js\":\"bea9450f472f0088\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/ReviewSession.js\":\"06a6f3eff88cae64\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/actions.js\":\"3fa87daca53ecc09\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/archive.js\":\"76cb48136334491a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/dataExtension.js\":\"88b931a58b0e5fb4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/deck.js\":\"6d0a658f57c141a5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/dueQuery.js\":\"0eff4f3f6ae5c3c2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/gradeDecision.js\":\"bd4b68162c578464\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/index.js\":\"74dc221c2cbdbb07\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/keyHints.js\":\"2c92e7045d57c5c0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/reviewCardLayout.js\":\"271d73b523ab9350\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/reviewProgress.js\":\"c43b19e1458955aa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/schema.js\":\"4f781ffb8f6e6df7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/useDueCards.js\":\"d8c74c7a09fb2d02\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/startup-metrics/index.js\":\"5359da1fd1b5c759\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/startup-metrics/record.js\":\"2141043cb212b058\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/storage-persistence/index.js\":\"65731da8655dcf7f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/storage-persistence/persistenceStatus.js\":\"a4778f1f44fef205\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/storage-persistence/requestAction.js\":\"fd47194e375c754c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/supertags/TypeChipsDecorator.js\":\"776dc5754ba1a9b7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/supertags/codeMirrorExtensions.js\":\"0852549f93a36475\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/supertags/index.js\":\"e270a445a3a981e8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/supertags/typeAutocomplete.js\":\"1774d790961d1916\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e60eea4c531d91d1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/actions.js\":\"7bce5a7e7ede253c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/anchor.js\":\"38be823d53b792d0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/events.js\":\"011ccaf8aecf7609\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/gestureActions.js\":\"dc444ab16ffc3e40\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/index.js\":\"d57d1467935a589a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"581582b6ed747f09\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/sync-metrics/collect.js\":\"fb87671d40d3c0ae\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/sync-metrics/index.js\":\"4ba33af813439a87\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/sync-metrics/record.js\":\"5634e9aea2356bd8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/RejectionDialog.js\":\"9d40c25e343e6b8b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c93a4aeacb52ba3e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/index.js\":\"ae048e06f4aaeca4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/model.js\":\"f977459b11aeebc3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/queueCounts.js\":\"cf3790485240749d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/rejectedHelpers.js\":\"82f90ef6ac8648de\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/rematerializeAction.js\":\"f61d80cd4f22428e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/useHysteresis.js\":\"5fcb889ec381a7c4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/ColumnHeaders.js\":\"6a981f5245d82d81\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/TableLayout.js\":\"37438ca579ec0de4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/actions.js\":\"dc3584c8f7afd393\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/cellEdits.js\":\"044fa92a90c98b94\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/columns.js\":\"3ac6ee1f745ea368\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/controller.js\":\"4e949615b91afa5f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/convert.js\":\"f6235dc75c9ce1ef\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/dataExtension.js\":\"940c1f4fd6e716e3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/index.js\":\"56cf6a3fe98047ab\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/keys.js\":\"66d16db17ef8aa61\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/model.js\":\"874d562155201a30\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/registry.js\":\"75452f7d12944bc7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/schema.js\":\"487f7500c808afa2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/theme-toggle/effect.js\":\"bb6678681bd0c8b0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/theme-toggle/index.js\":\"ab3ecfa15b4ca1bc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/theme-toggle/theme.js\":\"70d4970c22b2d4be\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/todo/actions.js\":\"1a7dec5bba4fdddb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/todo/dataExtension.js\":\"6517849923afcf71\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/todo/index.js\":\"449d680c2e4d1e77\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/todo/schema.js\":\"e5b20d550567af8b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ea445610ddee962f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/actions.js\":\"7104f269e54a1111\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/defaultItems.js\":\"f7efda2280aac561\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/facet.js\":\"83ae6ad38c175ffc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/holdRecognizer.js\":\"a3285291d8511553\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/index.js\":\"175ca9ac22e5bb7a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/update-indicator/UpdateIndicator.js\":\"6fbbd8baa7d72bd5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/update-indicator/index.js\":\"e40b18ba77212b43\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/update-indicator/loadTimes.js\":\"a7e83c647f22f9c6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/VideoNotesRenderer.js\":\"bfd1736b3f27275a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/VideoPlayerRenderer.js\":\"c5f1f850472d6cc6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/VideoTimeStamp.js\":\"dcb1df6a62fc959d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/actions.js\":\"2b0441c53b60df4a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/index.js\":\"bd449dfa3f2a6f46\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/markdown.js\":\"d3faea86aff3eb0f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/notes.js\":\"b758751c4b3f20e2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/registry.js\":\"7a622341cf8a585d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/remark-timestamps.js\":\"0cc6bd03bc711bb9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/view.js\":\"f202248e62f3c8b5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-link-hints/LinkHints.js\":\"35d6daadbba7d824\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-link-hints/index.js\":\"90386051afd1875e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-link-hints/model.js\":\"cbd3aad44d6d1037\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-link-hints/settings.js\":\"35fff29728a6af05\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-normal-mode/actions.js\":\"5f9a310f3f762766\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-normal-mode/index.js\":\"4a2bc4c4c41e98bf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-normal-mode/interactions.js\":\"f757329bf8f9eaa8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/workspace-header/index.js\":\"7c10c908c25a74db\",\"/knowledge-medium/pr-preview/pr-1831/src/registerServiceWorker.js\":\"b5585ba8a915755c\",\"/knowledge-medium/pr-preview/pr-1831/src/requestPersistentStorage.js\":\"596e1cd96abb19b7\",\"/knowledge-medium/pr-preview/pr-1831/src/services/authRequestDeadline.js\":\"fe1381e9e14dd4d7\",\"/knowledge-medium/pr-preview/pr-1831/src/services/authStorage.js\":\"a97989a5dd92949c\",\"/knowledge-medium/pr-preview/pr-1831/src/services/powersync.js\":\"e0d0bbf97355dabc\",\"/knowledge-medium/pr-preview/pr-1831/src/services/supabase.js\":\"de790966c38eb76b\",\"/knowledge-medium/pr-preview/pr-1831/src/services/uploadErrorClassifier.js\":\"4ad53ebfcfe6a2e7\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/ActiveContexts.js\":\"39b6cef5c4d8cb27\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/HotkeyReconciler.js\":\"26dc4ce8a5dc9f4a\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/WipeLocalDataDialog.js\":\"544c12ab15030164\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/actionDispatch.js\":\"80260f81d2268065\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/actionRefItems.js\":\"0978c7b3c804ca1d\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/applyKeybindingOverrides.js\":\"0b75159e70ea5767\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/blockActions.js\":\"a189a8eacd0abc5c\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/canonicalizeChord.js\":\"f4cad476965b3988\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/defaultContexts.js\":\"42da3e4463da982e\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/defaultShortcuts.js\":\"0bb6eed7b14efa12\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/effectiveActions.js\":\"4415a981b7d11290\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/gestureAction.js\":\"9fcef046dcbb929e\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/gestureBinding.js\":\"f283b24d1d58f1a9\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/holdRegistry.js\":\"8c2799c08dada1ad\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/keybindingConflicts.js\":\"284667671734fe39\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/keybindingOverrides.js\":\"db2adf31d25009d0\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/pointerAction.js\":\"f2ad44aa6dcb03a5\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/resolve.js\":\"dd275a80cfe55bb9\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/runAction.js\":\"d41ff45a2062244d\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/sequenceMatcher.js\":\"a0e3f7ebb9b0376b\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/types.js\":\"f998925a8dc6a944\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/useActionContext.js\":\"c167f24f7d2f548c\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/useActionDiscovery.js\":\"b661ec7df29cdc1c\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/utils.js\":\"fc3dab25c2871883\",\"/knowledge-medium/pr-preview/pr-1831/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1831/src/sw/bootStore.js\":\"f4ae529af811dced\",\"/knowledge-medium/pr-preview/pr-1831/src/sw/previewDatabases.js\":\"ccbc6781d61f0ce1\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/byteTransform.js\":\"5b24471d87b5bc28\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/attachmentCleaner.js\":\"e1efe8a6ec499432\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/attachmentParts.js\":\"89cb6c7c361a31a4\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/bundleParts.js\":\"defd7878cca5571e\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/bundleRecord.js\":\"dcb05e3bf6b66d03\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/manifest.js\":\"65a2185469b81df0\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/takeBundle.js\":\"6dd408460f44d44e\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/verifyBundle.js\":\"fbf95db01de67ce7\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/cleaningStage.js\":\"438ecd3a08128f30\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/conversionKey.js\":\"9b77c4f7a6baadbe\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/conversionServer.js\":\"97329061f6d47412\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/flip.js\":\"0a71bfd817fc0404\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/flipAttempts.js\":\"be8bb5408d566ab4\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/pages.js\":\"2c9222fffb2063da\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/preflight.js\":\"cebf4ab1cfa8f6e2\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/reseal.js\":\"5fcd21719558908e\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/runConversion.js\":\"a735cf18777ab08d\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/runLock.js\":\"710809be374a6b36\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/sealing.js\":\"06c4f152f134da98\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/sealingStage.js\":\"29b543344b2b3f63\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/stage.js\":\"60a591e4c73c3836\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/verifyReseal.js\":\"92da875123101584\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/aad.js\":\"40759601ff90d5bf\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/aead.js\":\"581c688de8772455\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/base32.js\":\"8a831c2bec65b21d\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/base64url.js\":\"f4fc65533e81bc3a\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/binaryEnvelope.js\":\"779253c87cdf3932\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/byteAead.js\":\"b39f1b96cd92f339\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/canary.js\":\"91146c83d4c87e88\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/contentHash.js\":\"b4b77fbcc664069a\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/contentKey.js\":\"5c882908edf9c4e6\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/derivedIdNamespace.js\":\"8e29911703fa5221\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/envelope.js\":\"6e1d8e155b5cd6f9\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/hex.js\":\"f7ea7f5c00b88c5b\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/sha256Hex.js\":\"6115902f541f56c2\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/workspaceKey.js\":\"18c5c1fd79924fb4\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/conversionState.js\":\"f58ee311ebd8364c\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bc8bb50258e98a8b\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/flows/pastedKey.js\":\"558965a9e7cb44dc\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8b1008e678e2197e\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b98f220bef394898\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/keyStore.js\":\"9d5016b01a09b2e2\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/mintWorkspaceKey.js\":\"f8f01765f6dfc916\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/modePin.js\":\"ad214a3a40660460\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/openWorkspaceKeys.js\":\"465807ba79917d7b\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/resolveWorkspaceEntry.js\":\"6fe09c466afc2617\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/resolver.js\":\"40edbe136247c702\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/workspaceAccess.js\":\"a17cf310b82c5e94\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/transform.js\":\"924b2ab3c3bdce75\",\"/knowledge-medium/pr-preview/pr-1831/src/themeBootDefaults.js\":\"568483bdee0a131e\",\"/knowledge-medium/pr-preview/pr-1831/src/types.js\":\"20dd97d39caaa019\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/ClientLocalSettings.js\":\"a902e1594604e06c\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/abortableSleep.js\":\"0ae1b893bd168e35\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/array.js\":\"dbe9f571fa68f5c6\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/backlinkAutocomplete.js\":\"507f0b0024e1f46a\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/blockCrumbs.js\":\"0ef808f3731b10b0\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/blockrefAutocomplete.js\":\"81c0fbbc89b09fa4\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/cadencedIdleJob.js\":\"56bc0fbe34f6b226\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/callbackSet.js\":\"8fcaf64765bca334\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/clientId.js\":\"81f57a726eec5e02\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/codemirror.js\":\"f12712b4d83c4e77\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/codemirrorCompletion.js\":\"350375d90695804d\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/copy.js\":\"495d5fcbafd3df09\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dailyPage.js\":\"fff4503f7aa869eb\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dbForensics.js\":\"ac11d27bf0903171\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dbForensicsHooks.js\":\"e79f139a36dc6c12\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/deleteBlockThroughUi.js\":\"8df5c16026d65981\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dialogs.js\":\"af220672192ca980\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dom.js\":\"cc04d7bd572b199f\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/downloadBlob.js\":\"13a61fb6ac16d4b6\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/exportSqliteDb.js\":\"f8ea602840240e83\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/fileSystemAccess.js\":\"13824a7bd2983827\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/flipSlide.js\":\"df8620f611254011\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/fnv1a.js\":\"cec3d7368fac9ed3\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/formatBytes.js\":\"1931904d039cfb6c\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/fuzzyRank.js\":\"1f6ca376c4d43dda\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/idbKeyedStore.js\":\"19725bdcd821f422\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/idleCallbackPolyfill.js\":\"b8a1ab70052c590f\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/keyboardAwareScroll.js\":\"fc29dce3cdc82259\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/keyboardViewport.js\":\"42bd5e4452e68f90\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/lastWorkspace.js\":\"58fb523c767f1e9c\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/layoutColumns.js\":\"c5337948c224435a\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/layoutSessionDom.js\":\"d75649d8d0831c7b\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/layoutSessionId.js\":\"669c5e4b17019c8a\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/linkClickGestures.js\":\"c9d93c244423cc15\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/linkTargetAutocomplete.js\":\"e9236aa9cfdeeebe\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/localDbCorruption.js\":\"4db3380c0fa09aab\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/localDbRecovery.js\":\"c02a317430ba0ddb\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/markdownParser.js\":\"2a756d29ab9173c5\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/memoize.js\":\"caa0eda41abf3be3\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/nameFieldCommit.js\":\"29de953296d9db6f\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/nameList.js\":\"e760507847a7fbd3\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/navigation.js\":\"ea55d5140ad5771a\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/omnilinerNamespace.js\":\"0a769eb47b2f45d5\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/opfsPageScan.js\":\"50be25ad7444a4e9\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelClearance.js\":\"410bf7f41d637482\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelHistory.js\":\"653cb75190babbc1\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelLanes.js\":\"c92f47e38de759d4\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelLayoutProjection.js\":\"15581a9a005fc669\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelScrollAnchor.js\":\"88da5bb8d8eb57c6\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelUrlFlags.js\":\"16022794098be2c4\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/platform.js\":\"4c18d864bd0dd1d5\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/pluralize.js\":\"b26e89a5730b85ef\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/propertyCreation.js\":\"84252d9d952a7bcd\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/propertyNavigation.js\":\"9829940c53620a30\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/propertyValueContext.js\":\"690e5f907097547b\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/react.js\":\"557ae7144c3f3302\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/relativeDate.js\":\"21ee8abcbc8df1fb\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/relativeTime.js\":\"4477b39960195859\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/renderScope.js\":\"fa64e8f84e01a067\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/resolvedThenable.js\":\"c3cc3cbc5aa74954\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/routing.js\":\"6fdc18cd879f34cb\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/safeMode.js\":\"1ac1f7d9f083b017\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/scheduleIdle.js\":\"8c4e5d8e5374d4b1\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/screenWakeLock.js\":\"58f65044c89d1ee1\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/selection.js\":\"2b33de26056edbc8\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/softKeyboardGrab.js\":\"d60d6c8abbcd1d7c\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/startupTimeline.js\":\"002f683bd5d579b2\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/state.js\":\"d8d9052e90649913\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/string.js\":\"550d9f5c306edfb4\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/surfaceZoom.js\":\"7a7f3b6d1f8d9f38\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/time.js\":\"c086e5e329ae7d5d\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/toast.js\":\"196726bd132b1014\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/toggleStore.js\":\"77ff3acf79c870fc\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/untilStopped.js\":\"493bf477d00822bf\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/userActivity.js\":\"705c2eafe75150b1\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/viewTransition.js\":\"084911fcbb96d54e\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/viewport.js\":\"2c5a2924e39a12f6\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/webLock.js\":\"0ac94b2fd112d3b8\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/workspaceRecovery.js\":\"da8656bcb4826ec6\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/workspaceSnapshotStore.js\":\"39396c16f2402751\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-compiler-runtime.js\":\"7ecba9e7b1f4c99b\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-client.js\":\"98bc1df1352632b8\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-server-edge.js\":\"10d30cc9bb1a623c\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-server.js\":\"d4bdf48f5db66a5d\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-static-edge.js\":\"193d0bc7a89aa2d9\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-static.js\":\"22b5b39f8ef4b69b\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-test-utils.js\":\"f5fcfcdf6f275fd1\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom.js\":\"70a30dbcbc2787b5\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-jsx-runtime.js\":\"ff9175ea4eb31651\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react.js\":\"1e7dad9ff06c10e4\",\"/knowledge-medium/pr-preview/pr-1831/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1831/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1831/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
