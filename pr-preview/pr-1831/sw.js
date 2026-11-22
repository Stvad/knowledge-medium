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
		buildId: "4d9b69382bbf-19953544",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1831/\":\"16a7e97c6c80c4f1\",\"/knowledge-medium/pr-preview/pr-1831/index.html\":\"16a7e97c6c80c4f1\",\"/knowledge-medium/pr-preview/pr-1831/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1831/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1831/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1831/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1831/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1831/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1831/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1831/assets/FacadeVFS-LKZJzDs_.js\":\"76109e3f361905e7\",\"/knowledge-medium/pr-preview/pr-1831/assets/OPFSCoopSyncVFS-CczT3vid.js\":\"e69f84bda1feaa3e\",\"/knowledge-medium/pr-preview/pr-1831/assets/OPFSWriteAheadVFS-B_Iqr7wW.js\":\"8e4f115ab72e3dc0\",\"/knowledge-medium/pr-preview/pr-1831/assets/wa-sqlite-BmeYeM79.js\":\"8895afa143dedf2f\",\"/knowledge-medium/pr-preview/pr-1831/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1831/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1831/assets/wa-sqlite-async-BmIDEBo6.js\":\"ae44ac5a3493e04b\",\"/knowledge-medium/pr-preview/pr-1831/assets/worker-CEkLJU_-.js\":\"8893278a9fd1f88d\",\"/knowledge-medium/pr-preview/pr-1831/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1831/chunks/app-BMgcLL_i.js\":\"28236d4ae9250cc9\",\"/knowledge-medium/pr-preview/pr-1831/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1831/index.js\":\"4664fec07b3893a3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1831/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1831/assets/AccessHandlePoolVFS-BtpspjWg.js\":\"61f0db493aa4e8b1\",\"/knowledge-medium/pr-preview/pr-1831/assets/IDBBatchAtomicVFS-BWoSxiph.js\":\"40c8af10b3405293\",\"/knowledge-medium/pr-preview/pr-1831/assets/MemoryVFS-P0F1r1lo.js\":\"5cbcb8328addbf08\",\"/knowledge-medium/pr-preview/pr-1831/assets/mc-wa-sqlite-ClchH67d.js\":\"7d754149e959f1f4\",\"/knowledge-medium/pr-preview/pr-1831/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1831/assets/mc-wa-sqlite-async-B0Obvni6.js\":\"40ac5e7cff7727f9\",\"/knowledge-medium/pr-preview/pr-1831/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1831/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1831/chunks/AccessHandlePoolVFS-C6BjK1tJ.js\":\"dfdd84197a873109\",\"/knowledge-medium/pr-preview/pr-1831/chunks/FacadeVFS-5s4Yg6GN.js\":\"f2a0ac915c555a26\",\"/knowledge-medium/pr-preview/pr-1831/chunks/IDBBatchAtomicVFS-BMhxT48v.js\":\"2525eda7e1443631\",\"/knowledge-medium/pr-preview/pr-1831/chunks/MemoryVFS-COpVbBku.js\":\"964b2c8cc89905d1\",\"/knowledge-medium/pr-preview/pr-1831/chunks/OPFSCoopSyncVFS-YwgwNJAY.js\":\"9e48110f516330cc\",\"/knowledge-medium/pr-preview/pr-1831/chunks/OPFSWriteAheadVFS-DAdhtiSd.js\":\"820c64121412a01f\",\"/knowledge-medium/pr-preview/pr-1831/chunks/Preview-N2TQge_v.js\":\"a2a60bc144bf41ce\",\"/knowledge-medium/pr-preview/pr-1831/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1831/chunks/card-Dvov8LlR.js\":\"c97e0c31ec87b548\",\"/knowledge-medium/pr-preview/pr-1831/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1831/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1831/chunks/dist-BkAauFU6.js\":\"280f483e7becce40\",\"/knowledge-medium/pr-preview/pr-1831/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1831/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1831/chunks/mc-wa-sqlite-CWfR-yzc.js\":\"49f2d133283c5841\",\"/knowledge-medium/pr-preview/pr-1831/chunks/mc-wa-sqlite-async-DkTYVY5z.js\":\"6e3d96dc859dd452\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-BfCMpByI.js\":\"65ae42a876097d02\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-CuXghNiv.js\":\"53591b1aabfcaf38\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-DAB1FTf3.js\":\"00525e29960fbc5f\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-DB_tshLK.js\":\"5976c6b26f0eee4e\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-DYFDCilL.js\":\"76b95ef3e4b29f4a\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-DqYU9_i2.js\":\"add64f12c81d976a\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-aBHR5PV6.js\":\"f0e06e06ca32de87\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-dom-server-legacy.browser.production-BrzXvK83.js\":\"63da721fb78240f3\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-dom-server.browser.production-Bd4ewOR9.js\":\"197ab171d7fcc012\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-dom-server.edge.production-BtLoIBBw.js\":\"18ce5daa4d4de0de\",\"/knowledge-medium/pr-preview/pr-1831/chunks/react-hK7RWFnW.js\":\"f277aa814987447b\",\"/knowledge-medium/pr-preview/pr-1831/chunks/server.browser-XbXwli1t.js\":\"2158e1996e78cfe5\",\"/knowledge-medium/pr-preview/pr-1831/chunks/textarea-BS1NAakY.js\":\"84f5f53c2493dfd3\",\"/knowledge-medium/pr-preview/pr-1831/chunks/ui-eWEVsatq.js\":\"7936409cf402f877\",\"/knowledge-medium/pr-preview/pr-1831/chunks/wa-sqlite-QHJqersF.js\":\"2f5b8f147132b01d\",\"/knowledge-medium/pr-preview/pr-1831/chunks/wa-sqlite-async-BNcnh35p.js\":\"8490bb791a43da51\",\"/knowledge-medium/pr-preview/pr-1831/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1831/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1831/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1831/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1831/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1831/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1831/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1831/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1831/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1831/src/App.js\":\"c6a61927178b5787\",\"/knowledge-medium/pr-preview/pr-1831/src/appUpdate.js\":\"6720c04bd1405f89\",\"/knowledge-medium/pr-preview/pr-1831/src/appVersion.js\":\"a8a38295a1e67bda\",\"/knowledge-medium/pr-preview/pr-1831/src/bootstrap/initialLayout.js\":\"0490a28218726ab8\",\"/knowledge-medium/pr-preview/pr-1831/src/bootstrap/openWorkspaceData.js\":\"bc31021dfc68d755\",\"/knowledge-medium/pr-preview/pr-1831/src/bootstrap/resolveWorkspace.js\":\"d5820f03e39a8af4\",\"/knowledge-medium/pr-preview/pr-1831/src/bootstrap/workspaceBootstrap.js\":\"652d1589bf6e3d40\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockComponent.js\":\"8521bf4ca82cbada\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockCrumbs.js\":\"72f294a4964969b8\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockEditor.js\":\"1c9207cf37db64d3\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockLoadingPlaceholder.js\":\"072af57c7db02e4f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockProperties.js\":\"888e1d668252b4a4\",\"/knowledge-medium/pr-preview/pr-1831/src/components/BlockSearchPicker.js\":\"1b2dd74144346309\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ConfirmBulkDeleteDialog.js\":\"889c291a003467e6\",\"/knowledge-medium/pr-preview/pr-1831/src/components/DividerHandle.js\":\"c43fd4e1c388924c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/DraftEditor.js\":\"d45d781b384f1ea3\",\"/knowledge-medium/pr-preview/pr-1831/src/components/GutterPill.js\":\"37e00d7aadfccdfb\",\"/knowledge-medium/pr-preview/pr-1831/src/components/Header.js\":\"03d2c59685fec893\",\"/knowledge-medium/pr-preview/pr-1831/src/components/LazyBlockComponent.js\":\"792c7eb2980c7594\",\"/knowledge-medium/pr-preview/pr-1831/src/components/Login.js\":\"de55f4a43cc07861\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ZoomableSurface.js\":\"aba337bc33e3c9a2\",\"/knowledge-medium/pr-preview/pr-1831/src/components/editModeKeepalive.js\":\"54a37d2a1030e4c2\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c76365224dcef502\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7cf1349563490060\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/RefPropertyEditor.js\":\"7f21fa38f2704d97\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/RefTargetTypePicker.js\":\"d4b32220af4c516d\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/SelectPropertyEditor.js\":\"12ca332239b72165\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/TypesPropertyEditor.js\":\"ecb936bb6bd5b62f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/defaults.js\":\"87a20203833ba9ef\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/kernelValuePresets.js\":\"fa592527ae8af6b8\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/selectablePresets.js\":\"a5bebd19d3c1762d\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyEditors/typesPropertyUi.js\":\"80c44274d8c4db9f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/AddPropertyForm.js\":\"dd2656c4efbb3fca\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/PropertyPicker.js\":\"0e19f545729ccf82\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/PropertyRow.js\":\"0f67af94dfa76e4c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/Rows.js\":\"54660e6ecdf05a82\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/actions.js\":\"04930f189b0cb6ae\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/declarationOnly.js\":\"20abd61f6b6e7a39\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/layout.js\":\"18219854ed764a34\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/model.js\":\"2101a16267f4543d\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/shapeUi.js\":\"1addc941ad188202\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/shapes.js\":\"96cbccaa82a32cc8\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2abbd6da6f128b93\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanel/visibility.js\":\"a5a25cabca4d040f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/propertyPanelSections.js\":\"307ec69de8cf25cc\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/BlockEmbed.js\":\"730abc4a63de9e5e\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/BlockLink.js\":\"4192095e1dc01576\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/BlockRef.js\":\"ea144b28d80501f7\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/ReferenceLink.js\":\"33817135604a057f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/cycleGuard.js\":\"1c5b64273e67cb5a\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/cycleGuardContext.js\":\"288bf5f4dd5b64f5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/linkInteraction.js\":\"6c1338d95cd453f9\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/referenceLayout.js\":\"72b7671ab095b369\",\"/knowledge-medium/pr-preview/pr-1831/src/components/references/useBlockRefAncestors.js\":\"ade4c3cc8d44f329\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/BlockGutter.js\":\"b3f3ed25b3514313\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/BlockInfoDialog.js\":\"74cabc90ee5f1446\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/BlockTypeBlockRenderer.js\":\"9d9dc4b16a113bf0\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/BulletHoverCard.js\":\"638df5cc19f9d3ed\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/CodeMirrorContentRenderer.js\":\"32127afa4513fe11\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5fa629b2c9904033\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/ColumnResizeHandles.js\":\"8d67e5c0fb555844\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"45614be735e83c55\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/DefaultBlockRenderer.js\":\"489196c583703d45\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/LayoutRenderer.js\":\"43adf1731a8da3d5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/MarkdownContentRenderer.js\":\"ae3bb1cd3d88a78a\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/MissingDataRenderer.js\":\"d4a5462e07656a12\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/PanelRenderer.js\":\"e5fde92fdd54f148\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8980e3df3366fc72\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/TopLevelRenderer.js\":\"1c558342c849ece5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/blockGutterMode.js\":\"04139b3b3cccd50c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/blockTitleText.js\":\"33a1f7956e5e9374\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/fieldCreationKeydown.js\":\"d65e3045e401ff8e\",\"/knowledge-medium/pr-preview/pr-1831/src/components/renderer/layoutRootContext.js\":\"d5a33d4096494f74\",\"/knowledge-medium/pr-preview/pr-1831/src/components/typeChip/TypeChip.js\":\"7630acddc36b88fb\",\"/knowledge-medium/pr-preview/pr-1831/src/components/typeChip/chipStyle.js\":\"59227b3d0be807d7\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/anchored-floating.js\":\"43fe1ed77e2d186e\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/button.js\":\"26ccf5d745616aee\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/card.js\":\"7db7dc82de804074\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/checkbox.js\":\"48b545e3916c2e30\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/collapsible.js\":\"ecb0764605511b26\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/command.js\":\"f3876e547eafb32c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/context-menu.js\":\"ceac22f7c6c47e6a\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/dialog.js\":\"f79ed32f68c60046\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/dropdown-menu.js\":\"9064e146fbb914c5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/floating-listbox.js\":\"fb653a53f1b5466a\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/index.js\":\"be9690cba05fffb4\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/input.js\":\"34e8982e5ac8e3c7\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/kbd.js\":\"e76806e3d6a2709c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/label.js\":\"6acac6e7bf25d989\",\"/knowledge-medium/pr-preview/pr-1831/src/components/ui/textarea.js\":\"019afc4e9910ff89\",\"/knowledge-medium/pr-preview/pr-1831/src/components/useEditModeYieldKeepalive.js\":\"609828a894eb031b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/BootFallback.js\":\"f98bbe40367be336\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/FocusedRowLazyMount.js\":\"12130d15aa326a9b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/LazyViewportMount.js\":\"bcbb84e1e89867ae\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/LocalDbCorruptionFallback.js\":\"159ba47e33ffbeac\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/error.js\":\"edc75c059d4ba281\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/lazyMountRegistry.js\":\"f1724878565aec8c\",\"/knowledge-medium/pr-preview/pr-1831/src/components/util/suspense.js\":\"bfc2cd6a742d473b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/CreateWorkspaceDialog.js\":\"75daff544062ebb5\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/PendingInvitations.js\":\"9256c18cddc6d040\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/SyncProgress.js\":\"856d4180530f5a0a\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/UnlockProgress.js\":\"2d9efa66b1a395cd\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/WorkspaceKeyGate.js\":\"ea15a83c1985def3\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/WorkspaceSettingsDialog.js\":\"15792158a7baf989\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/WorkspaceSwitcher.js\":\"a6c8c51584ae3f19\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/WorkspaceSyncGate.js\":\"6e3ad109e12360c3\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/ConversionFlow.js\":\"df209cad9fab75a6\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/ConversionFlowHost.js\":\"ac2bbd89b2a10237\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/EncryptionSection.js\":\"00348bdf6604c84b\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/attachmentPrompts.js\":\"3fb7d96004b6b4d4\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a51b2d59941b169f\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/conversionFlowDeps.js\":\"7c59b98e1bd21ffb\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/conversionFlowStore.js\":\"edaf8d0ea504b749\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/flowUi.js\":\"6f589ad9c10052a1\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/conversion/useConversionRun.js\":\"cb3a2097e55fb0ea\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/keyUi.js\":\"d9efac304c0adefc\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/useCloseOnKeyLoss.js\":\"646ffd4dda11ffab\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/useCloseOnServerE2ee.js\":\"d4e68f51a1228e11\",\"/knowledge-medium/pr-preview/pr-1831/src/components/workspace/workspaceUnlocked.js\":\"099973d4c3c193f3\",\"/knowledge-medium/pr-preview/pr-1831/src/context/backgroundSubtree.js\":\"f7605e4e134730e9\",\"/knowledge-medium/pr-preview/pr-1831/src/context/block.js\":\"9910b63303866c11\",\"/knowledge-medium/pr-preview/pr-1831/src/context/layoutWsContext.js\":\"d779b3a6befe51e6\",\"/knowledge-medium/pr-preview/pr-1831/src/context/propertyDisplay.js\":\"e12dcee36ee53935\",\"/knowledge-medium/pr-preview/pr-1831/src/context/repo.js\":\"9a9863a9d7365998\",\"/knowledge-medium/pr-preview/pr-1831/src/data/aliasClaim.js\":\"f755e4f2d57fcf4b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/aliasSeatNamespace.js\":\"528560d4f05467a9\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/blockData.js\":\"2e303a647112bfff\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/blockType.js\":\"6cf0c981f8c86268\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/changeScope.js\":\"05d2314a35de4d30\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/codecs.js\":\"5d8c81d6ec53ff13\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/derivedData.js\":\"cd4e5494a892fd29\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/errors.js\":\"a74ebf26d0676f15\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/events.js\":\"e2e595b3c65c26b8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/handle.js\":\"6a8a8b961e2356f5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/index.js\":\"e28e733e844f4f8c\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/mutator.js\":\"9c0db2731178d1c0\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/processor.js\":\"89c29f0d9f08f2d1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/propertySchema.js\":\"68224c566e21ee12\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/query.js\":\"1c7db2a2856cfbc5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/sameTxProcessor.js\":\"de0b9d4c8476aaf9\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/schema.js\":\"6a8a8b961e2356f5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/tx.js\":\"6a8a8b961e2356f5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/typedBlockQuery.js\":\"1e0a7652e3244d03\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/user.js\":\"f853fd98aa04077d\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/valuePresetCore.js\":\"7bf9e6430def7f51\",\"/knowledge-medium/pr-preview/pr-1831/src/data/api/valuePresets.js\":\"4488dcd119390467\",\"/knowledge-medium/pr-preview/pr-1831/src/data/attachmentCleanerIOVerb.js\":\"2d2c913e3633953f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/block.js\":\"4b2fb09d17bc2552\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockCache.js\":\"4b030dc68a837f66\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockId.js\":\"ef4df43ab8661b46\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockLiveness.js\":\"7253aefdf6338906\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockMerge.js\":\"d77e8a3c3e1b0d13\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockSchema.js\":\"b8bae4c24061bf4b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockTypeLookup.js\":\"f35a0eb630686b32\",\"/knowledge-medium/pr-preview/pr-1831/src/data/blockTypes.js\":\"55ce234605985dcc\",\"/knowledge-medium/pr-preview/pr-1831/src/data/clientContext.js\":\"7a94da3fa99d52e1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/dbFileSiblings.js\":\"9da0efd236cf4d50\",\"/knowledge-medium/pr-preview/pr-1831/src/data/definitionSeeds.js\":\"f4bc2ac1aa20c5b9\",\"/knowledge-medium/pr-preview/pr-1831/src/data/derivedIds.js\":\"c2722ae3e915f1b9\",\"/knowledge-medium/pr-preview/pr-1831/src/data/drawnSubtree.js\":\"22571e240a82300e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/facetBridge.js\":\"fa7b1d6a4db2edf3\",\"/knowledge-medium/pr-preview/pr-1831/src/data/facets.js\":\"e4e93cdcb0cc5721\",\"/knowledge-medium/pr-preview/pr-1831/src/data/globalState.js\":\"2217da7eb140843f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/aliasClaimRederiveProcessor.js\":\"34fa8b12ad1eba1c\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/ancestorBatch.js\":\"3fe4a6292f4fdcd1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/blockTypeTypeifyProcessor.js\":\"0c853f8b292023e3\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/clientSchema.js\":\"3bf5cc2741ccc524\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/commitPipeline.js\":\"9dc4a7126de02308\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/devAssertions.js\":\"edaa57b45e0327c1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/firstSync.js\":\"8f2963d9461f2910\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/freshInitialLoad.js\":\"f7a6c1e714892636\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/graphBackfillClaim.js\":\"f98df1fb12e148d3\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/handleStore.js\":\"2c532e046f9e12fc\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/idleMarkerJobs.js\":\"5bdb321a45cd9f5f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/initialDownload.js\":\"42486011ab4df535\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/initializeClientDatabase.js\":\"2a16b9eafc3b9484\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/jsonCanonical.js\":\"0ede008e9fbd1969\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/kernelInvalidation.js\":\"fba8c24a9dfbaf78\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/kernelProcessors.js\":\"2b0dc09558e64ce7\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/kernelQueries.js\":\"da8104691e6dd48c\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/mergeTypeMembershipProcessor.js\":\"15b6eb5c60d27ab4\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/normalizeReferencesProcessor.js\":\"ad2b40516befb660\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/poolInstrumentation.js\":\"6d51b75f0576d0cc\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/processorRunner.js\":\"b7eeb74037e116a4\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyCellBackfill.js\":\"c4bc3b89e5891e8e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyChildMint.js\":\"3bbe189a432d09f4\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyChildrenProcessor.js\":\"6cdcdb153c7eee59\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyDefinitionChangeProcessor.js\":\"57af3fc992701863\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyDefinitionSynthesis.js\":\"54474e867b51c80e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyKeyScan.js\":\"522c9288b1ccb685\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertySchemaResolution.js\":\"2b1b905fcd257e60\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/propertyValueEdits.js\":\"7a647ef4314c4ef4\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/raiseProtocol.js\":\"e9bce8c1086af64f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/readBatch.js\":\"0f36b0f6d1f38e5e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/refProjection.js\":\"342bcb70ebb6b887\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/referenceTargetLookups.js\":\"da52e3ab0a079b38\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/referenceTargetProcessor.js\":\"b20e2a90d512f7af\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/replayMerge.js\":\"389d2163fd491400\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/sqlBinds.js\":\"0bb4773aaa2e0cb8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e7b2df38e220b433\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/arrivalProcessors.js\":\"1b6af16f28a89f41\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/invalidate.js\":\"c153d19806595f5e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/materialize.js\":\"cc830553bab1cf54\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/observer.js\":\"34b4fbe89dd74d01\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/syncObserver/reconcile.js\":\"9ce6dfcde8ebfd62\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/timingMetrics.js\":\"b2bc5cd098b6c9f8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/treeQueries.js\":\"1b4dcdf939344295\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/txEngine.js\":\"000e1c67b974adf3\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/txSnapshots.js\":\"fdb1e27967181f48\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/typedBlockQuery.js\":\"679adc3c390d07f6\",\"/knowledge-medium/pr-preview/pr-1831/src/data/internals/undoManager.js\":\"800a8b6fc56447c1\",\"/knowledge-medium/pr-preview/pr-1831/src/data/invalidation.js\":\"c956428c2ff238b5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/kernelDataExtension.js\":\"073e08f77937b62a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/kernelPage.js\":\"d8088be5d5f31d04\",\"/knowledge-medium/pr-preview/pr-1831/src/data/kernelValuePresetCores.js\":\"38d95d0592753aaa\",\"/knowledge-medium/pr-preview/pr-1831/src/data/localDbCorruptionSignal.js\":\"8ad8e4d2c85d8713\",\"/knowledge-medium/pr-preview/pr-1831/src/data/localDbStorage.js\":\"0ae5f294a1e9fce9\",\"/knowledge-medium/pr-preview/pr-1831/src/data/localDbVfs.js\":\"f6a79ee642fa205b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/localSchema.js\":\"b76545937af9f81f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/maintenance.js\":\"374895972b8c6081\",\"/knowledge-medium/pr-preview/pr-1831/src/data/mergeProperties.js\":\"b01767ec9aa60aaa\",\"/knowledge-medium/pr-preview/pr-1831/src/data/metricsConsoleHook.js\":\"56119ad0ee383b42\",\"/knowledge-medium/pr-preview/pr-1831/src/data/migrationsPage.js\":\"7988fd05d839049e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/mutators.js\":\"1e34120bc2e8ca92\",\"/knowledge-medium/pr-preview/pr-1831/src/data/orderKey.js\":\"1c16935f4b644daf\",\"/knowledge-medium/pr-preview/pr-1831/src/data/orderKeyPlacement.js\":\"df529cf61c53db77\",\"/knowledge-medium/pr-preview/pr-1831/src/data/outlineSurface.js\":\"fb643befc519de4e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/pendingEditorContent.js\":\"6aa0a1310499c14c\",\"/knowledge-medium/pr-preview/pr-1831/src/data/pendingUploadsSql.js\":\"472f816fd07c1c01\",\"/knowledge-medium/pr-preview/pr-1831/src/data/pluginStateExtensions.js\":\"02a36c75c6a06ab0\",\"/knowledge-medium/pr-preview/pr-1831/src/data/powerSyncLogger.js\":\"f923df2e496bf1fd\",\"/knowledge-medium/pr-preview/pr-1831/src/data/projectorRuntime.js\":\"4abf194557bf5afa\",\"/knowledge-medium/pr-preview/pr-1831/src/data/properties.js\":\"b92c7723e3631546\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertiesPage.js\":\"44fa97a1d5c57e99\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyChildren.js\":\"c836ed938bd99614\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyDefinitionFanout.js\":\"36725ac8b425a1ac\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyDefinitionMetadata.js\":\"bcaa79f1e0df4d90\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyDefinitionRegistry.js\":\"46be48d854252f39\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyDisplayMode.js\":\"56b7cf4c4a14e034\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertyRowCreation.js\":\"34f782d4c65d4a1b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertySchemaCreation.js\":\"282c04b77bde3446\",\"/knowledge-medium/pr-preview/pr-1831/src/data/propertySeeds.js\":\"6b44f25f24e3bc40\",\"/knowledge-medium/pr-preview/pr-1831/src/data/recentsPage.js\":\"75c1ea12ef569cfd\",\"/knowledge-medium/pr-preview/pr-1831/src/data/referenceBlock.js\":\"a4da5715e9d09d98\",\"/knowledge-medium/pr-preview/pr-1831/src/data/rejectedUploads.js\":\"f9b1aae993480cf0\",\"/knowledge-medium/pr-preview/pr-1831/src/data/releasePowerSyncConnection.js\":\"cc151f9f91871ef2\",\"/knowledge-medium/pr-preview/pr-1831/src/data/repo.js\":\"43175c192a84cf2c\",\"/knowledge-medium/pr-preview/pr-1831/src/data/repoProvider.js\":\"a438b5764ea86a80\",\"/knowledge-medium/pr-preview/pr-1831/src/data/rowProperty.js\":\"06a650207e5c87c9\",\"/knowledge-medium/pr-preview/pr-1831/src/data/searchFilter.js\":\"0955445428eaa9d8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/seedIdentityLedger.js\":\"8a7eec9fedd31423\",\"/knowledge-medium/pr-preview/pr-1831/src/data/stateBlocks.js\":\"7efabb228d9d5cac\",\"/knowledge-medium/pr-preview/pr-1831/src/data/structuralEditPolicy.js\":\"670aeb48135bb37e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/subtreeDelete.js\":\"9ff1269d78327f66\",\"/knowledge-medium/pr-preview/pr-1831/src/data/syncStreamLock.js\":\"933442a97e9dd893\",\"/knowledge-medium/pr-preview/pr-1831/src/data/syncedTableSqlRecognizer.js\":\"ed40de68d9e87287\",\"/knowledge-medium/pr-preview/pr-1831/src/data/syncedTableWriteGuard.js\":\"eb19057293be177b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/targets.js\":\"ee0e8adf4749435a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeColors.js\":\"3183fbd3308bbb96\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeDefinitionMetadata.js\":\"cd157d7aa033ac63\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeDefinitionRegistry.js\":\"0eb671d4c8aa9140\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeExtraction.js\":\"412131d0cecf337b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeInitialValues.js\":\"312417e69731e3aa\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typePropertyGroups.js\":\"2652e6e6cbc066f8\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeSeeds.js\":\"451808d9692b62a5\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typeTagger.js\":\"70a408f42ba9bad3\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typedRecords.js\":\"a6a564f5e8f19b23\",\"/knowledge-medium/pr-preview/pr-1831/src/data/typesPage.js\":\"5218e1804d71e14b\",\"/knowledge-medium/pr-preview/pr-1831/src/data/userPrefs.js\":\"dc1a2feb2d6b4b57\",\"/knowledge-medium/pr-preview/pr-1831/src/data/userSchemasService.js\":\"0418b35d522a8a9f\",\"/knowledge-medium/pr-preview/pr-1831/src/data/userTypesService.js\":\"ea960afe8336e3cf\",\"/knowledge-medium/pr-preview/pr-1831/src/data/valuePresetRegistry.js\":\"091be893d6e32535\",\"/knowledge-medium/pr-preview/pr-1831/src/data/visibleChildren.js\":\"83ed03627b969e8a\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaceConversion.js\":\"6fa84fd58bf7a791\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaceFirstSync.js\":\"3e49b28bb4a95342\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaceIdNamespace.js\":\"ad532a02517ce271\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaceSchema.js\":\"06ba4245c4856516\",\"/knowledge-medium/pr-preview/pr-1831/src/data/workspaces.js\":\"6bda05812e7e9e66\",\"/knowledge-medium/pr-preview/pr-1831/src/data/writeAheadLog.js\":\"73c1a755a545ac0e\",\"/knowledge-medium/pr-preview/pr-1831/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/BlockPasteShellDecorator.js\":\"deb1280241f26360\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/atTrigger.js\":\"acf4a9763a619e8f\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/autocomplete.js\":\"f3dd197091264fee\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/codeMirrorExtensions.js\":\"53719634f51ce778\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/contentFlush.js\":\"3aaf65b72644bacd\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/defaultInteractions.js\":\"78d806af39ddcabc\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/editSettleSignal.js\":\"7eb96f2d2523bde5\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/insertImage.js\":\"e534ae2328e648b8\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/referenceCompletionRange.js\":\"2a037495652c7904\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/referenceTargetTypes.js\":\"673e0f126a8a3118\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/syntaxContext.js\":\"76a6b0e9430e3c56\",\"/knowledge-medium/pr-preview/pr-1831/src/editor/triggerMatch.js\":\"933ee759ad750db5\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/AppRuntimeProvider.js\":\"c0cabc4f9cc10d6a\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/BlockFocusShellDecorator.js\":\"1d7d44992d4ce24d\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/ExtensionRenderBoundary.js\":\"a42779b4dfeb4acb\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/PanelContentRecovery.js\":\"2e584b2ffff317d7\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/apiCatalog.js\":\"a25106191bc175a7\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/approveExtensionHere.js\":\"5520065030ea7b46\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/armedCutAppMount.js\":\"11fdcb4d6f0e3bb5\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/batchableKeyedStore.js\":\"09f8c0fd1ff7a35d\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/blockInteraction.js\":\"466d9dc342ba5af8\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/blockSelectionAction.js\":\"968d8cbe58797e59\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/compileExtensionModule.js\":\"dc2936f846d6fa31\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/compiledModuleCache.js\":\"47a2a3f1a4857ef2\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/continuousGestures.js\":\"2dd57c49733f441a\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/core.js\":\"9dd2c956f8ab2b78\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/defaultRenderers.js\":\"28f080b272354dba\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/definitionFanoutAppMount.js\":\"aa1a15ca3bbed511\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/dialogAppMount.js\":\"ff9e59c1a4b1bfa2\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/dynamicExtensionSeeds.js\":\"1b33ce94867392a3\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/dynamicExtensions.js\":\"e8bb72b408b39b87\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/exampleExtensions.js\":\"878514aa94f62186\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionApprovalStatus.js\":\"34c31a8f13bf1d74\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionLoadErrorToast.js\":\"c8947b873b1ad7a3\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionLoadErrors.js\":\"1b93431e203accdb\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionLookup.js\":\"e7ac4d3bb94aa67f\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionToggles.js\":\"ddb547d374fc0c57\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/extensionUtilitiesCss.js\":\"529e39cb40a805fc\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/kernelPageDeletionGuard.js\":\"7fa6db956d907b57\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/liveRuntime.js\":\"b2ebfb219b3bbb9c\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/openExtensionsSettings.js\":\"5e1c4044dbedc8bb\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/overridesCache.js\":\"f62ecda1a8affc68\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/pluginIds.js\":\"5532d3ff96351e22\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/processorRejectionToast.js\":\"1ce384111ad0283b\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/runtimeActions.js\":\"0ba5b8c4ed57191b\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/runtimeContext.js\":\"4e3574341a3100d8\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/staticAppExtensions.js\":\"42bbf34f280c70fa\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/staticDataExtensions.js\":\"c6bd43c2fb124c70\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/toastAppMount.js\":\"0f4b6a6918a2788b\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/useOverrides.js\":\"69f7c1553ef04597\",\"/knowledge-medium/pr-preview/pr-1831/src/extensions/useShortcutSurfaceActivations.js\":\"028351a0d68f341e\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/discoverToggleTree.js\":\"d4224617db6d8388\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/facet.js\":\"77da33bb8c7f3dd9\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/resolveAppRuntime.js\":\"0f786772ba552160\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/runtimeEvents.js\":\"d3c5a93f4600fc3a\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/togglable.js\":\"3013cfd8f8821a57\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/variantFacet.js\":\"b71364c96d95017c\",\"/knowledge-medium/pr-preview/pr-1831/src/facets/verbFacet.js\":\"1a33eda4e0fd06dd\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/block.js\":\"d568346a558fb7a9\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/focusedChild.js\":\"c1db717b73b1780d\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/propertySchemas.js\":\"e6dbb708896c5558\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/typeRegistry.js\":\"e72af60e719ce785\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useAncestorCrumbs.js\":\"9627e159c24fa46b\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useAutocompleteListbox.js\":\"af102d954d6f10f7\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useDebouncedSearch.js\":\"13e00a7028b52e84\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useDebouncedValue.js\":\"7d4e9e82382defd1\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useIsFocalRender.js\":\"819003873a1786f8\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useIsReadOnly.js\":\"61e5381b5f44bb85\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useMaterializeBacklog.js\":\"c0cbfb7d89402a9c\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useMinuteClock.js\":\"304b4b8433ed7efe\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/usePanelLayoutProjection.js\":\"8aa2e9f271f537ae\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/usePendingInvitations.js\":\"5e9c241d1b2501da\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useRendererRegistry.js\":\"ac97fdcf5736ef30\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useRetainedFieldRows.js\":\"4e33c56d0bd8a040\",\"/knowledge-medium/pr-preview/pr-1831/src/hooks/useWorkspaces.js\":\"9a7f6f9f1af21e77\",\"/knowledge-medium/pr-preview/pr-1831/src/lib/utils.js\":\"c8e1488de5542515\",\"/knowledge-medium/pr-preview/pr-1831/src/main.js\":\"4eb6fbfb4b85f1f2\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/MarkdownImage.js\":\"0853ae5c496f13a0\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/blockSeparators.js\":\"bfd4faf336e7d006\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/context.js\":\"d9649240458a78dd\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/defaultMarkdownExtension.js\":\"c08151e9661f4257\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/extensions.js\":\"0292ace7931b8eb6\",\"/knowledge-medium/pr-preview/pr-1831/src/markdown/renderMarkdownHtml.js\":\"6d9e6aefadb175af\",\"/knowledge-medium/pr-preview/pr-1831/src/minimal-editor.js\":\"c885efd5152c3c30\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/armedCut.js\":\"e4fda36fa2402d19\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/captureMediaVerb.js\":\"7ec684ce6e976ff0\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/clipboard.js\":\"093e9fffb7677386\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/decision.js\":\"3b1c467597998209\",\"/knowledge-medium/pr-preview/pr-1831/src/paste/operations.js\":\"3b68b5ef28c00c4b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/account-header/AccountHeaderItem.js\":\"faa554b6fc1b01e9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/account-header/index.js\":\"2efd329ce379acfd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e7c81790415a3912\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/askAgent.js\":\"002395495a7c190b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/askedStore.js\":\"12a89ed17d53c4d6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f27161d17633111f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/chipState.js\":\"95dc2eb46b54e607\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/dataExtension.js\":\"79950d3b38b6c772\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/index.js\":\"ede15a52332a8d23\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8e8997b5c003fcdb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-dispatch-companion/schema.js\":\"c60a7b781a8bb9ec\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/AgentTokensDialog.js\":\"46461a982dd3c62c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a90cdb3f2cd1087a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/addMedia.js\":\"e2d8e863c6c9b088\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/backlinks.js\":\"37fe4acf90844957\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/block.js\":\"debbf418a03de406\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/context.js\":\"a1e46aa8e36ffcba\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f92f1a54c247b952\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/index.js\":\"d033ba060b49710c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/outline.js\":\"8d673e9a6d34cf13\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/properties.js\":\"d1dfb9343f5a9186\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/refs.js\":\"e0adb4339774d5f1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"29e03fe9677dfb29\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/search.js\":\"aa15045aa486800b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/shared.js\":\"1d21c78b17c00c89\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"dae9461739949ee7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentViews/text.js\":\"52af373ccc0ef96c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/agentWrites.js\":\"da63bda33a893a54\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/authoringCatalog.js\":\"b762df4d071a51ec\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/blockRefTargets.js\":\"3a6a5219ca16f553\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/bridge.js\":\"bc745c06d1ef225e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/bridgeLoop.js\":\"29dca03bfc864c5d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/changeHistory.js\":\"c16f3d889a51e658\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/commands.js\":\"7116fc1684d8177b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/commentsCommands.js\":\"1550c29edb401cb4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/dataExtension.js\":\"662ad34d001d7ab6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/dataModelGuide.js\":\"46c14caff8541071\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/describeRuntime.js\":\"b92152e412af0e3e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/extensionLint.js\":\"9f4497b9ab8f8dbe\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/grainAudit.js\":\"946aa2d6bde594da\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/healthCommand.js\":\"ec7c12e04f06d7e5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/index.js\":\"708c61f259c4a645\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/presetIdentity.js\":\"5c858134aaac5d0d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"59f28670d714f7e2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/readMedia.js\":\"e252843b183c88dd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/schema.js\":\"795fc01bb802b5bf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/serialization.js\":\"06b065ffed336524\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/targets.js\":\"3f852aca14ce22a5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/tokens.js\":\"f9b2f38350cbb05e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/watchEvents.js\":\"33b31abf442a640f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/workspaceGuard.js\":\"4b72329cee3fe371\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/agent-runtime/writeCommands.js\":\"b3c53c4c836bbd02\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/AliasCollisionToast.js\":\"03e3ce4fe74a0e11\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/DuplicateNameBanner.js\":\"dc9237a2b38b7729\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/collisionMerge.js\":\"916d26f2934620d2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/dataExtension.js\":\"7157e1641a4ea025\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/index.js\":\"cd041f60902c7a95\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/mergeCollisionAction.js\":\"d3d69d0967912f01\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/pageStyling.js\":\"027f31c67854db2a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/rejectionToast.js\":\"80e15bd805bb1e2b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/alias/syncProcessor.js\":\"9a6b15194e7b284b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/actions.js\":\"5a400e4550326779\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/addComment.js\":\"f388de46fd7bb033\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/anchor.js\":\"e74a1421a895d93e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/anchorState.js\":\"e9075e19446081a6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/commentLinks.js\":\"5c39f5adc48e5450\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/confirmThreadDeletion.js\":\"8c89ee84a9851088\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/container.js\":\"89817915d0b38f70\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/dataExtension.js\":\"24d76403215d929b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/deleteComment.js\":\"41bac4ddec28915c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/highlights.js\":\"44b5d283f3c1cbc7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/index.js\":\"ddf875504c6cb061\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/linkedCommentsPill.js\":\"57425a97e19e85a3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/margin.js\":\"6af0f11939cd7d5c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/marginSchema.js\":\"ff66c3f1e0bae502\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/newComment.js\":\"7194dd30b0cc0e94\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/ownThreadPicker.js\":\"a22c7e892251b7b4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/placement.js\":\"4f489adfd647a8d8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/queries.js\":\"16c5eacbd65a60aa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/quotePosition.js\":\"acf3396a3a8b95ba\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/quotedIn.js\":\"d7744f1a6e760cde\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/quotedRange.js\":\"619dd601ee75ffe9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/rangeRefs.js\":\"889aff8e42c48f7f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/readHighlights.js\":\"d6ccaee61dcbab99\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/readSelection.js\":\"bd20707533200b9b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/readSelectionUi.js\":\"cd1b4b1445de18be\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/reanchor.js\":\"1b1d5562f4e160f1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/schema.js\":\"c5479f6f3666ebf7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/scope.js\":\"dce63b1f99656759\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/scopeThreads.js\":\"c5873e81e63c4253\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/splitRetarget.js\":\"169840c798384686\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/suggestionCard.js\":\"bbff3ab87952ffd8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/suggestions.js\":\"8b089cff7e0b8f3d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/summaries.js\":\"e6e824bf6220efb5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/summaryBatch.js\":\"62f0353a1ba6250f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/surface.js\":\"ee109735acb600c7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/threadNavigation.js\":\"4c279227bdf7fbe1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/threads.js\":\"01dbacab73a1299f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/ui.js\":\"ee448adc4271a046\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/annotations/uiStore.js\":\"a24859886067c417\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/app-intents/appIntents.js\":\"1696a591a2ca1235\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/app-intents/index.js\":\"019290797fba39e0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/app-update-prompt/index.js\":\"3767718ab0db88c8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/app-update-prompt/status.js\":\"44f633fccd001e87\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f3ff926bd81d2cc7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/MediaBlockRenderer.js\":\"51abf8f3a786e157\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2ca976a571522d08\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/MediaUploadReconciler.js\":\"f56b1a54fad24e39\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/assetDownLane.js\":\"820d725eb4077530\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/assetResolver.js\":\"6bfb0a2174bd5593\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/assetUpload.js\":\"3d506973e2f43a90\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/attachmentCleanerIO.js\":\"a525975212f3d2d8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5d51a849701d9572\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/blobStore.js\":\"d50d88fdf1473a1a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/byteStore.js\":\"92da35eb39f81589\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/cleanerIO.js\":\"a6a7952cc52ff9e2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/cleanupAttachments.js\":\"8e6ebbede2a3cb3a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/dataExtension.js\":\"bd0793e1f7d79bb5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/downLane.js\":\"f4978f1bae458d5c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/index.js\":\"b7c8f6edc427c627\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/insertImageContribution.js\":\"27cfe37a8739e407\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/laneArming.js\":\"eb30b772cdd373c5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/laneLock.js\":\"60e82421fb7189cd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/mediaBlock.js\":\"364da752c12d717f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/mediaCapture.js\":\"b9d23a46864c0c7b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/mediaViewers.js\":\"6c1090c81ec7a656\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/mediaViewersFacet.js\":\"b82ea58797faecd3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/pasteCapture.js\":\"b2fd331e5bb3fefb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/resolver.js\":\"9a564d03afb585f4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/retryUploadsAction.js\":\"c6476c49a2d59c9f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/storagePaths.js\":\"db60a4bf7bc6398a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadDrain.js\":\"c9084667319d91e1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadLaneStatus.js\":\"6112d9e64dd1c261\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadReconcile.js\":\"51fab08a5abded4f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadRecovery.js\":\"a1feb538086e5c6e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/uploadStore.js\":\"d2e8dd6683ca8c8d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/attachments/useAssetObjectUrl.js\":\"a035eb5608616b6d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"473589570ba50337\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a6f46eeed25325a7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/facet.js\":\"92b69604b0970d21\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/index.js\":\"da475ec1fde22645\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks-view/prop.js\":\"f5964dad01f30dd4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/BacklinkFilters.js\":\"febd95c01fa073be\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f381b9f6908a6af7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/BlockEntry.js\":\"0f80eb8408e724b2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/LinkedReferences.js\":\"22b5172b197ddea1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"f2d63cc119cef173\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/dailyNoteDefaults.js\":\"1c44f6316a44ed45\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/dataExtension.js\":\"79ed33683d61e11a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/edgeExclusions.js\":\"5c54f55760736d25\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/filterProperty.js\":\"7f0699518ca33b7d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/index.js\":\"0c019a610430377f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0f2f36fe0feb27c2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/applies.js\":\"a8de372f1e4e1af3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/countQuery.js\":\"7b752e37726e6352\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/expansionStore.js\":\"fe080863dedada24\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/index.js\":\"764bff0e15137720\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7309d208d28e9460\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/presentationInvalidation.js\":\"f74d9bda43f9d548\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/propertyEditorOverride.js\":\"8b2a70dfe54f7c49\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/propertyFilter.js\":\"754c4abcf4b6596c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/query.js\":\"1cbc1ee24b9d40da\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/resolveFilter.js\":\"9dadf2939667c760\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/sourceBatch.js\":\"7db43f4facbd3f44\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/sources.js\":\"79d0c2083eebe483\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/useBacklinks.js\":\"a1827a551a233970\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f97f7026cc713a96\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/BirthdayCelebration.js\":\"8752bffd43411ee5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/BirthdayOverlay.js\":\"7d00b1f57bd93491\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/gate.js\":\"2981d7d111a9ff33\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/index.js\":\"1b4f6c07db7c7b5e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/birthday/wolfTheme.js\":\"71f51a1900e269ee\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/BlockDragLayer.js\":\"e233f292b6e37349\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/dragController.js\":\"b0c681e84c151de8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/dropTarget.js\":\"c8fcf4f12ff356d2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/index.js\":\"9eac435528213f16\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-drag/projection.js\":\"9e057c43a2632641\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-info/BlockMetaCard.js\":\"0bf2d91e4c0e0bbc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-info/index.js\":\"3e139812f24a0601\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/AddTagDialog.js\":\"7bfd50e6a3ab6872\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6f5add001a1a62ee\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/TagNameIssueHint.js\":\"5ee5a8201a78702c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/addTagAction.js\":\"4e04393ae6a9fac3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/appendTag.js\":\"018c3cf0231791de\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/config.js\":\"23bed69cfb68edc0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/dataExtension.js\":\"406736dc3317fa88\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/index.js\":\"07825445932f9a1d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/block-tagging/propertyEditorOverride.js\":\"227b57e4cc95781a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/BreadcrumbList.js\":\"683a2b13315e0387\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5b766d5f2ff75baa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3a3d7bffe556da63\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e0a709631ee909fd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"74ec9c95d4771711\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/index.js\":\"ae5b4981c083386e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9911b18a7a854df5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/CharacterCountItem.js\":\"fd5c02546f182005\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0a291df52b6923ff\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/actions.js\":\"dcfdf05ec88bfa75\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/blockType.js\":\"ca5b29f546e17d72\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/charCount.js\":\"7f8b46d3040514b3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/dataExtension.js\":\"114c8d6285476b6a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/index.js\":\"d3a326d73344bef8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/profiles.js\":\"12696769195464bf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/properties.js\":\"9df8eb401184979f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/character-counter/textCounts.js\":\"1bdc673fc718db1d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/colemak-keybindings/index.js\":\"b7dae351be3cc04e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/CommandPalette.js\":\"b80cbcfd2b8d318d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/HeaderItem.js\":\"3dd40fc37fae0416\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/context.js\":\"8a1671cf67ee6076\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/index.js\":\"277ce83f77f5f482\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/selection.js\":\"ea85a365e3559518\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/toggleStore.js\":\"ad342e6fdfe7d93a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/command-palette/useCommandPaletteActions.js\":\"ec8e67ab848049a0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/ContributorBadges.js\":\"44761e048aa979fd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/author.js\":\"629f00c1e2951fc3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/codeMirrorExtensions.js\":\"fcf01cb2d0135274\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/dataExtension.js\":\"9f81e9481e8e0804\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/index.js\":\"88d5777b20f8cbb1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/mentionAutocomplete.js\":\"76524863aa9989bf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/processor.js\":\"b31096e036d4e5ac\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/profiles.js\":\"2e891fd3bbeca13c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/queries.js\":\"1b2f9c370b652706\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/contributors/schema.js\":\"56ce717e0edbe568\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d80a130066d3a6e4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/followOrigin.js\":\"46c94332dac9bf8d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/index.js\":\"70d93e17aca2baee\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ddf754b74a24f6c7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6a9ef9941d8edf4a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/CalendarGrid.js\":\"ae80cd8d6a40ff18\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/DailyNotePicker.js\":\"43994ce4cdc47e4d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"1eb84210bc5ff134\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/DateNavDecorator.js\":\"72ce0b371411a23c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/DateScrubOverlay.js\":\"f46a143f3f6cfb9b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/HeaderItem.js\":\"e67c0f0f364eb820\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/ReschedulePicker.js\":\"1087410283851942\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/SpreadDatesDialog.js\":\"7f4930209e3a08dd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/actions.js\":\"3949bb976d134363\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/blockDateAdapter.js\":\"fa00a38ef62629be\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/calendar.js\":\"8b8d6a9a724351da\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dailyNotes.js\":\"5ffd5438d3dea709\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dataExtension.js\":\"5d0fd37b17eb4b51\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dateScrubActions.js\":\"fc8a0a35895f841b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dateScrubGesture.js\":\"0393f584fbaeec9b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dateScrubGestureActions.js\":\"66af2c5ab252eae9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0e12b59d810d839e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/deletionGuard.js\":\"40b696642ec0d817\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/dueQuery.js\":\"21f885e648ca9395\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/index.js\":\"87465bbffd845c88\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/landing.js\":\"1c797ae694a5fb3b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/localSchema.js\":\"44648d4fcc5d1336\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/referenceDateAdapter.js\":\"94c56708dad85348\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/rescheduleAction.js\":\"0dc995728f799b69\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/schema.js\":\"51078c21b06356cf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/spreadBlockDates.js\":\"33eeab8dcaacc8fd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/spreadDatesAction.js\":\"45e63d213d7913d0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/today.js\":\"eadd7a8a8e353087\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"05bf447d98a005b8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1de6b7263f8ea172\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/audit.js\":\"d98e23c70ab88a5a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/auditAction.js\":\"0617fe19d2c73a81\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/auditRanges.js\":\"7a45beb8fbfd2fc9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/diagnosticsSource.js\":\"f800271c25590fe5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/divergenceScan.js\":\"4df67f71af15b420\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/index.js\":\"cfbaf77a6934052a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/propertyChildrenChecks.js\":\"002f415fd8cba7c2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/referencesMirror.js\":\"e1678cf2c7bc89ea\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/rowJson.js\":\"70185df556a49064\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/schedule.js\":\"1b8801ca863fa9e1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/data-integrity/store.js\":\"c09a29e747c08cee\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-maintenance/action.js\":\"34fcf5d1c6d4875b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-maintenance/index.js\":\"bdd49945cf1c4144\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-maintenance/plugin.js\":\"0973df517c1581f6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0d27f71352d0bba1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/actions.js\":\"477ec3b17ce51c75\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/changeMarker.js\":\"d488e3bb2371038e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/diagnostics.js\":\"4e493efc036a9cf6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/fileSystemAccess.js\":\"35a9cec15637a1fe\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/filenames.js\":\"370761c56dae0b15\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/index.js\":\"dfd6b9cb7e838ecc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/mirror.js\":\"0078a23b2f66fc32\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/runLock.js\":\"c3332111daefec73\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/runtimeHealth.js\":\"699f14f5825bc561\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/schedule.js\":\"65a2258e29f930fe\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/db-mirror/store.js\":\"200222717d0cb8ef\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/default-themes/index.js\":\"2de065a1673a371b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/default-themes/themes.js\":\"eaba9139c80957bc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/diagnostics/facet.js\":\"dfcfd9c3cbf6ad41\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/diagnostics/useDiagnostics.js\":\"edca49575ede68b9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extension-prompts/dismissals.js\":\"f08e3cf55539d06e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extension-prompts/index.js\":\"3cf6f45d94730396\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extension-prompts/status.js\":\"ca4c944d4b94ba46\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extension-prompts/store.js\":\"08936429b066e6c4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b69db2837f54c291\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ccb8eee96496e472\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/actions.js\":\"a1b99a10413c3904\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/config.js\":\"bd325d36285ddb92\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/dataExtension.js\":\"6dc4d7c4c70cf281\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/effect.js\":\"ea7f3ce15f47a0f5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/index.js\":\"4fec9e7b0eb1100b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/propertyEditorOverride.js\":\"73506d578bcba782\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extensions-settings/useToggleTree.js\":\"61a5a118afcb8cb7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/ExtractTypeDialog.js\":\"62fc42f05d00fedb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"9988d8df2a0d08dc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/PropertyShapePicker.js\":\"e575475743816f83\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/action.js\":\"3ebba3703a05ba45\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/extract-type/index.js\":\"b9a64b962c70485c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/FindReplaceDialog.js\":\"dfbe9245760ad9b2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/HeaderItem.js\":\"0f87a2ce55c2f95f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/dataExtension.js\":\"838372432dea57d5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/index.js\":\"fc8ddef0eb505a88\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/search.js\":\"ef983474f43bf9d2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/toggleStore.js\":\"a22f1c9383fe3932\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/LocationPropertyEditor.js\":\"957883fb08664223\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/MapView.js\":\"729576bcac5f158e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/blockTypes.js\":\"df4b99baacdc782e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/codeMirrorExtensions.js\":\"78f0fa6f2680f0e3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/createOrFindPlace.js\":\"b47c74c1d2e68862\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/currentLocation.js\":\"f12fc14731beb706\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/dataExtension.js\":\"9f3f96111ee54dba\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/geoContentDecorator.js\":\"9ced82866f3de9ca\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/googlePlacesClient.js\":\"1fbbf64a644d22dc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/index.js\":\"ae1046ce71d51775\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/locationsPage.js\":\"2cdec93633482969\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/mapViewport.js\":\"51984bb270733d63\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/pickCurrentLocation.js\":\"3ba945928cde5cfd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/placeAutocomplete.js\":\"c594aa1db959752c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/placeNameCollision.js\":\"d359b6bf2d6ca88f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/properties.js\":\"8636e35e79ed03f1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/propertyEditorOverrides.js\":\"40cbfe63ef1c41f8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/query.js\":\"1e81d4b4cbcc2bfc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/geo/usePlaceSearch.js\":\"dedf8f99697ca54d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0927cd31ded72f68\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"34ae99f15f846b4f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"bf41e649fbc92c78\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/config.js\":\"ac7c94158cf42f6b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/dataExtension.js\":\"a73a2251bbdb8091\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/facet.js\":\"c7ce216b99ae65ee\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/grouping.js\":\"67e9207f2927cfe6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/index.js\":\"ee48d38deff67ca6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"868983b2ca7f28c6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/query.js\":\"3ca3a86baf7c11a5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/resolveConfig.js\":\"b30f8d3c26868990\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c09f17c867028d4b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"12007ef96b2ef40d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/HtmlDocumentContent.js\":\"55991dafe3fdcf82\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/HtmlFrame.js\":\"4264019da9a46a9f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/actions.js\":\"4412dc1b99a4df28\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/blockType.js\":\"7e1e9926bf814604\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/confirmRunScripts.js\":\"b0e054a3a8ab1aa4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/dataExtension.js\":\"c683172bc0ff6aca\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/frameAnnotations.js\":\"cb5381aef433f394\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/frameDocument.js\":\"a2d8bad972a0d6ee\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/frameTheme.js\":\"24a2524e510488e9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/index.js\":\"5387fdc77884f254\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/scriptConsent.js\":\"1f11c12b82fc0969\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/sourceMap.js\":\"8cfae8685bf9e4ca\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/html-document/useDocumentScripts.js\":\"41125890e9ac1b3f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/index.js\":\"ef89820187953141\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/record.js\":\"c9505c3da30ce4bc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/recordStore.js\":\"925ae887147653f8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/responsiveness.js\":\"79f5baaa1343a493\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/schedule.js\":\"4bdbca321a94a723\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/interaction-metrics/sessionContext.js\":\"65255037758613da\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ffe4d19c7e5c7f3c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"94de44eab8af3190\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/actions.js\":\"15bfd7e2c675f03f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/config.js\":\"939a2b4caadde729\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/dataExtension.js\":\"e78d102898d3564c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/effect.js\":\"1758965d7cc64559\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/index.js\":\"69d8384a7534c727\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/keyCapture.js\":\"50ff3bcdeff5dfc7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/overrideStore.js\":\"cda0978adde0cb62\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"92d43e254e81a611\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/HeaderItem.js\":\"4507359000371e99\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/LeftSidebar.js\":\"e01599b9255adbfd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/actions.js\":\"056a7ab2261c3a70\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/facet.js\":\"1da1a28d565d7761\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/index.js\":\"c6e17f8af46afec9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/shortcuts.js\":\"9a1446972c0a1711\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/left-sidebar/toggleStore.js\":\"af01ae49c84359cb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/merge-blocks/MergePicker.js\":\"5069d16ad6fdd20d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/merge-blocks/index.js\":\"b0af113ad820b1a7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/merge-blocks/mergeAction.js\":\"171746aab2642fe8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/merge-blocks/strategy.js\":\"678ffbebd5ba6685\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/Button.js\":\"b76955d11864c48c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"8f2731ddac1a66e6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/defaultItems.js\":\"345a15a63577e93a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/facet.js\":\"26739134a286bc9e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-bottom-nav/index.js\":\"4b1c9282e391d119\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4d9eac14fbfe9ea2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/actions.js\":\"35280189c9b0e070\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3a5c92c357e16242\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8c525c0a51d95846\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/mobile-keyboard-toolbar/index.js\":\"e2c062de980e654c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/MoveDestinationPicker.js\":\"49a68c4f91cc35ea\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/blockSubtreeMembership.js\":\"034b8efd47a722a7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/contextMenuItem.js\":\"24c74d3945a0617b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/index.js\":\"64336fed3ea4c5d3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/moveAction.js\":\"21673c0fe5569759\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/moveBlocks.js\":\"ea2dc3450c70e6ab\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/move-blocks/selectionAfterMove.js\":\"fbac927c652cc928\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/TutorialBanner.js\":\"5f71f4a8d4b4b06a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/action.js\":\"0222cf237001cca6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/bannerDismissal.js\":\"1c7a6c6a59e679d9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/documents/cheatSheet.js\":\"05c6b69aa397be24\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/index.js\":\"8bb570a286a15f0b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/keys.js\":\"e490110405eda0a3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/landing.js\":\"f1d04e90684abb08\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/outline.js\":\"7cbfe4b0a262bb59\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/onboarding/seed.js\":\"29820c808d8de97a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a883b23ca89b41a9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/analyze.js\":\"05ede3ed17c0cf1a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/diagnosticsSource.js\":\"02c9b9b390e5e681\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/index.js\":\"ada5a3b5d8a2f198\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/load.js\":\"4f1f14c0a4940b06\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/monitorRun.js\":\"5d5e0661cf60b017\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/schedule.js\":\"79a0bc27db95f1ca\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/series.js\":\"6cd1672ff9b3a025\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/store.js\":\"40a6479cee68e3b0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/trendAction.js\":\"7f2e6a2d70eb333f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/perf-monitor/verdict.js\":\"007e1332564271e8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/plain-outliner/clickToEditAction.js\":\"5789caa1ef02669a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/plain-outliner/index.js\":\"2f85b33f22b4fe77\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/plain-outliner/interactions.js\":\"9d1fb524a90f3f0b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1213c5ff78050e45\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/MigrationGate.js\":\"f84f4ac3d62a3ad1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/MigrationGateDialog.js\":\"29d22b245257a059\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/action.js\":\"ead4c25c94a04d31\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/index.js\":\"7dc0d04e8024e41a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/localRunMessage.js\":\"543948092e2749c0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/plugin.js\":\"db2a3cb914a79a6c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/progressReport.js\":\"981f830243f05b83\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/properties-migration/sweepProgress.js\":\"f51b94eb434edc4b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/FieldRowRenderer.js\":\"87172f451d91f18a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/ValueRowRenderer.js\":\"90f0737322f68a99\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/actions.js\":\"f021a29f486ca88a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/autocomplete.js\":\"04994b39d9e3749b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/fieldRow.js\":\"d1dca7a69a7f6963\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/index.js\":\"c14c2eabee48dde0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/referenceWarning.js\":\"c8038dfaffff51c5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/valueAutocomplete.js\":\"93aabf32244ccbf3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/property-rows/valueSchema.js\":\"47a230fc8bcb48e4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/HeaderItem.js\":\"f51a726eb1dc5962\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/QuickFind.js\":\"9b117a70f01e99ca\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/index.js\":\"cb4a5c8784819ec5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/recents.js\":\"42216d5a0f9ead42\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/resultItems.js\":\"26143b5073363784\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/selection.js\":\"9036ac94e07870d4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/quick-find/toggleStore.js\":\"d3e7049899416107\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/HeaderItem.js\":\"0be8e4e7b0b36ca5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/RecentsPageBlockRenderer.js\":\"db74dab865a66a88\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/grouping.js\":\"6b1247ffb6f598a7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/index.js\":\"3371bdc973bc4e08\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/recents/target.js\":\"c702d7055728ead1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/codeMirrorExtensions.js\":\"2db48a5a4daf55f4\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/contentPrefill.js\":\"1657bf21c4280420\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/dataExtension.js\":\"7952734f4030deee\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/index.js\":\"cb368c3634057d25\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"03cc79215dd70b79\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/invalidation.js\":\"bfaa094689457d32\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/localSchema.js\":\"a27658d6667e912f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/blockrefs/index.js\":\"43466893100edbdd\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f2028046800df25e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/index.js\":\"d4b420d11e155915\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/referenceNode.js\":\"a1a9744e486361d9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/remark-reference-occurrences.js\":\"37202455a79e2794\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"aeb28ecac22d8678\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/wikilinks/index.js\":\"d998de5754760ca9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0213d3ce0cc0a481\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a21a9f38652ee28b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/mergeRetargetProcessor.js\":\"b9257c2f0592284d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/parseFence.js\":\"c9077f7af0025800\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/referenceParser.js\":\"8a6a555450812de5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/referenceProjection.js\":\"df3116754a419d4e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/referencesProcessor.js\":\"51aa2b8ad6371651\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/renameProcessor.js\":\"d2ea16f7a7db9cec\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/references/spanReplacement.js\":\"ef7f0b5ea835e7bb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/rich-paste/htmlToOutline.js\":\"9cad8abf71dec95f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/rich-paste/index.js\":\"8552a1e4dca23fbe\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ea841d165d00c479\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/rich-paste/pasteDecision.js\":\"9df97d9dd4a74b0a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/action.js\":\"74c23cba5b6dc358\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/blockIds.js\":\"e4ecdd06fb5de473\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/content.js\":\"5126e34d96ca91d9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/effect.js\":\"aa5fddfd41e56d8d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/ids.js\":\"a3b14ceb20950aec\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/import.js\":\"e1057d1be35d6ead\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/index.js\":\"bcc4fbbf39d1e8aa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/plan.js\":\"0e23260d3c6d5948\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/plugin.js\":\"69a2004459db02ad\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/promotion.js\":\"1cf25c3297fa61a9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/properties.js\":\"19668d4567119576\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/references.js\":\"4ea9a4af75da3fd6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/report.js\":\"d89911d52bc648f8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/roamMemo.js\":\"def7eb07116247f8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/runtime.js\":\"d8c429a91e2f2ffc\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/schemaReconciliation.js\":\"34d4f9133321407b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/srsMarkers.js\":\"48d061b410b594d2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/todo.js\":\"891c15ad023ce6ce\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/typeCandidates.js\":\"889e16c3bbbb575b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/roam-import/types.js\":\"9158307706670def\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/search-health/index.js\":\"83f31f32ec193f7d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/search-health/store.js\":\"95da6521c04f96db\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/HeaderItem.js\":\"b1dda77f80a3da60\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e8ab7803b666f536\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/index.js\":\"09dd0a15a446b5c7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/model.js\":\"4c0df16cf82cf9f7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/toggleStore.js\":\"4c35a93dab54c559\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/shortcut-help/useKeyInspector.js\":\"e056f2ead54cff03\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e72584f2cb92422a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/ShellDecorator.js\":\"f0cd51a7dca0dec0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/actions.js\":\"373e031ce1cb66a2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/exclusionsFacet.js\":\"05a2ec47e1c56403\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/index.js\":\"d78e3989846cf8b3\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/shell.js\":\"cfec9e41dd05bdfa\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/surface.js\":\"6dadad4d636f2208\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/spatial-navigation/walker.js\":\"65b0a90c736954f5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6e74cfe7da67b0a7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/dataExtension.js\":\"247668ab853e0649\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/index.js\":\"0a7a720bdf223432\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/indicator.js\":\"6fc6ee7dca8b5e9d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/moveSrsState.js\":\"b9ef8c3880cf954e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"57f2816b7a8dd501\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/scheduler.js\":\"7670914206dbbe6a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/schema.js\":\"8a630d00c4baa018\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"5ad16d365ae4c387\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/srsClipboard.js\":\"64b65ee970ae6771\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e6c0fe6f7a358025\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c4db025a0f803f8a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/DeckPicker.js\":\"1bd76f0c91f2b3ff\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/ReviewControls.js\":\"23403d171838a29d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7c738857c1d7acc2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/ReviewSession.js\":\"c3f0ec009920dd3e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/actions.js\":\"7247b21cd366dfe7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/archive.js\":\"e013e4ff2bb6a993\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/dataExtension.js\":\"78883c6235a7ad52\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/deck.js\":\"0cd8fabf67433592\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/dueQuery.js\":\"2111dfe3f7636c19\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/gradeDecision.js\":\"02e79882cc378b5b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/index.js\":\"5e281392a9970083\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/keyHints.js\":\"ef4111bd5732677a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/reviewCardLayout.js\":\"0e19fbe0609c10d6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/reviewProgress.js\":\"e776f3b5c808fa8b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/schema.js\":\"4ddd436999cd3fde\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/srs-review/useDueCards.js\":\"5a1ac25648143156\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/startup-metrics/index.js\":\"407625900677d2b2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/startup-metrics/record.js\":\"f182f645b677a64a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/storage-persistence/index.js\":\"af1947a18ff2976a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/storage-persistence/persistenceStatus.js\":\"1b13f4d2e982d260\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/storage-persistence/requestAction.js\":\"202dc2d7f19b00cf\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/supertags/TypeChipsDecorator.js\":\"10cc552862c12a84\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/supertags/codeMirrorExtensions.js\":\"657f5d19e3c219ff\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/supertags/index.js\":\"4d89e14570148bb2\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/supertags/typeAutocomplete.js\":\"065a914295a59db8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4b9d040d2f631c7f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/actions.js\":\"27b1b6a8c34f7a9b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/anchor.js\":\"91cba3bf5cfa5681\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/events.js\":\"58035c1bf1bfffc7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/gestureActions.js\":\"70663f420c6df8a1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/index.js\":\"7487a9fa3e94fbce\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"597042f3a180ec1d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/sync-metrics/collect.js\":\"5c9b068ea5b64d18\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/sync-metrics/index.js\":\"6159660cfef5b02d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/sync-metrics/record.js\":\"87f4f18c45f8dd0b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/RejectionDialog.js\":\"8c302e56f8cc18ee\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/SystemStatusHeaderItem.js\":\"86f466d9d5f2b7ee\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/index.js\":\"3f163346aff068ff\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/model.js\":\"88b6722be737c278\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/queueCounts.js\":\"09ffcf2261b4b152\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/rejectedHelpers.js\":\"76fa110a0bca8192\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/rematerializeAction.js\":\"b2126c1d3264612f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/system-status/useHysteresis.js\":\"3b4447b5c7dd4a05\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/ColumnHeaders.js\":\"725a129dcca76606\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/TableLayout.js\":\"d366010ea329bb4e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/actions.js\":\"2fb2c9931718c498\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/cellEdits.js\":\"58c63199fc5be0c9\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/columns.js\":\"9572e8e727b1cdb1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/controller.js\":\"cfa44097729674ec\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/convert.js\":\"f4eadbf0a9409fce\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/dataExtension.js\":\"5527f6463b2c27d5\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/index.js\":\"29c4b0fddeba808c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/keys.js\":\"00503e216408049d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/model.js\":\"26c6e243ca7be419\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/registry.js\":\"ecc891eeb04761e0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/tables/schema.js\":\"11ba584893e785c0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/theme-toggle/effect.js\":\"c9ff9a3d9d69eb91\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/theme-toggle/index.js\":\"b059f91b30b73e12\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/theme-toggle/theme.js\":\"b4bc3c5150ca51f6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/todo/actions.js\":\"101f364d82b5f36c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/todo/dataExtension.js\":\"f56f409af38c8a4d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/todo/index.js\":\"75416ee1726c17b8\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/todo/schema.js\":\"d2f89c90c858543a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/TouchSelectionLayer.js\":\"75179bab7f952888\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/actions.js\":\"cc9a86f40c0ad49e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/defaultItems.js\":\"b11ed7c57dadce6e\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/facet.js\":\"5d487da222339046\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/holdRecognizer.js\":\"9221cc826a82b9c1\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/touch-selection/index.js\":\"d0cd85579d7bae73\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/update-indicator/UpdateIndicator.js\":\"840be07a1cfd9e44\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/update-indicator/index.js\":\"a046ebdc73a0b768\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/update-indicator/loadTimes.js\":\"78866f26ff621e08\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/VideoNotesRenderer.js\":\"809058fae989a2bb\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/VideoPlayerRenderer.js\":\"23e637749c54efa0\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/VideoTimeStamp.js\":\"54b8b2b85d265867\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/actions.js\":\"7b8242633bf5c39c\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/index.js\":\"feedb8823712e3d7\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/markdown.js\":\"c134c73f284f6ef6\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/notes.js\":\"0afb1704010aa693\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/registry.js\":\"ec788f4ce64f4683\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/remark-timestamps.js\":\"01d4ae8ab6eac827\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/video-player/view.js\":\"3e7851f93424b609\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-link-hints/LinkHints.js\":\"ab67ca6ae63d137d\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-link-hints/index.js\":\"6fae3d90f1f9995a\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-link-hints/model.js\":\"aa694fb43f85aa2f\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-link-hints/settings.js\":\"d4c990a4b807ca86\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-normal-mode/actions.js\":\"64e58ab77137d23b\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-normal-mode/index.js\":\"597c3906bb349b53\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/vim-normal-mode/interactions.js\":\"5b390bba2b04ff62\",\"/knowledge-medium/pr-preview/pr-1831/src/plugins/workspace-header/index.js\":\"00023c493af21e72\",\"/knowledge-medium/pr-preview/pr-1831/src/registerServiceWorker.js\":\"5cb07eef04897bd1\",\"/knowledge-medium/pr-preview/pr-1831/src/requestPersistentStorage.js\":\"2fad10c3e03ece6b\",\"/knowledge-medium/pr-preview/pr-1831/src/services/authRequestDeadline.js\":\"569d267e0cc344e8\",\"/knowledge-medium/pr-preview/pr-1831/src/services/authStorage.js\":\"2217e64524eb4c74\",\"/knowledge-medium/pr-preview/pr-1831/src/services/powersync.js\":\"b160401a9755da64\",\"/knowledge-medium/pr-preview/pr-1831/src/services/supabase.js\":\"6aed0e33b124697c\",\"/knowledge-medium/pr-preview/pr-1831/src/services/uploadErrorClassifier.js\":\"0e3c635d69a817c9\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/ActiveContexts.js\":\"dcc01c63cf3c5f92\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/HotkeyReconciler.js\":\"326c0f5f639d6f86\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/WipeLocalDataDialog.js\":\"0297c19d3cb7a69a\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/actionDispatch.js\":\"0575c9f0fe13eee2\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/actionRefItems.js\":\"c3b41a560359c0f9\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/applyKeybindingOverrides.js\":\"9db818c3e7cacea3\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/blockActions.js\":\"9b1f07a8898c2e7d\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/canonicalizeChord.js\":\"1cd8453f5ec149fb\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/defaultContexts.js\":\"61fcbfdea2f31c12\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/defaultShortcuts.js\":\"3ce301dd41ebf481\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/effectiveActions.js\":\"a6995cb52e1535b1\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/gestureAction.js\":\"e9ab076b503328ed\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/gestureBinding.js\":\"d5fc092f05f59b9d\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/holdRegistry.js\":\"2513c72ad545433b\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/keybindingConflicts.js\":\"5c6bb41cb3460608\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/keybindingOverrides.js\":\"465e0ba4868e05fb\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/pointerAction.js\":\"afeb1180659d3a0d\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/resolve.js\":\"a1c21c007b4898c4\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/runAction.js\":\"d6460186f9dfc138\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/sequenceMatcher.js\":\"8ff836ccb03125c8\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/types.js\":\"2745fd519b3b88b8\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/useActionContext.js\":\"d12cd1b3006595d0\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/useActionDiscovery.js\":\"6db47374c575a55e\",\"/knowledge-medium/pr-preview/pr-1831/src/shortcuts/utils.js\":\"ba8b048ac88d8ccf\",\"/knowledge-medium/pr-preview/pr-1831/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1831/src/sw/bootStore.js\":\"2f3dbb1c48baded3\",\"/knowledge-medium/pr-preview/pr-1831/src/sw/previewDatabases.js\":\"a9a3bf6e6336fa7e\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/byteTransform.js\":\"30d215cda6fe3dad\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/attachmentCleaner.js\":\"f1f1ecf1272b67b8\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/attachmentParts.js\":\"f7aebb361641fce1\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/bundleParts.js\":\"3f206a5ca826afbb\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/bundleRecord.js\":\"9212bbc067945997\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/manifest.js\":\"c97b7c953145b32f\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/takeBundle.js\":\"3ff42a008e0173aa\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/bundle/verifyBundle.js\":\"f121257b7a59741f\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/cleaningStage.js\":\"28410649b11f996d\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/conversionKey.js\":\"d6df6467f155aafd\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/conversionServer.js\":\"9afeee40cd107d23\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/flip.js\":\"2a29d7ce6c76867d\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/flipAttempts.js\":\"678cce762a5e3350\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/pages.js\":\"b37c9c47f8283e0f\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/preflight.js\":\"6d4e2f83a12979ae\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/reseal.js\":\"4e8c02af57c3f9c4\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/runConversion.js\":\"418350b0cbfb20d2\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/runLock.js\":\"945845dedf84a0d2\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/sealing.js\":\"d13bda0f6c14d101\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/sealingStage.js\":\"2b143fe2e1e21123\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/stage.js\":\"45763136b4725ceb\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/conversion/verifyReseal.js\":\"5e71047fdc2a0df2\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/aad.js\":\"8703e92e0d90f2f2\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/aead.js\":\"3a37dc9145e5e105\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/base32.js\":\"9447ca1f06bdcb7c\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/base64url.js\":\"b068485b5bcbc0e9\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/binaryEnvelope.js\":\"eee88867a9df3394\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/byteAead.js\":\"35d1f6376cf86939\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/canary.js\":\"f78b919137db90ec\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/contentHash.js\":\"59370b0b210d17c6\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/contentKey.js\":\"39f1c4500d1de8f5\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/derivedIdNamespace.js\":\"6839cd53bc589de7\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/envelope.js\":\"f7af1151c2831631\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/hex.js\":\"c1dff428f7eeaada\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/sha256Hex.js\":\"d4ad33d683e6d453\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/crypto/workspaceKey.js\":\"291537b2d7cb4bd5\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/conversionState.js\":\"eaa3b539b0c66cf3\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f55e4d36fb84a2e2\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/flows/pastedKey.js\":\"480737ddc4b1f3ca\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bc07e94228ff9c79\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6b9202bd25fc0f52\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/keyStore.js\":\"23d28938afe2f294\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/mintWorkspaceKey.js\":\"8f7ab0d96bf71ebe\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/modePin.js\":\"01269d1bdf7fcb25\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/openWorkspaceKeys.js\":\"84505d58f4fccaa4\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/resolveWorkspaceEntry.js\":\"46c537eb56c31128\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/resolver.js\":\"c98d5d8236ca6d5d\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/keys/workspaceAccess.js\":\"324093018535a173\",\"/knowledge-medium/pr-preview/pr-1831/src/sync/transform.js\":\"189f3ec3499afcf3\",\"/knowledge-medium/pr-preview/pr-1831/src/themeBootDefaults.js\":\"d9b8f9bfcb126d70\",\"/knowledge-medium/pr-preview/pr-1831/src/types.js\":\"1dad7517eaa1c976\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/ClientLocalSettings.js\":\"25f9d644cc41ead5\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/abortableSleep.js\":\"99d44e0f21a5af64\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/array.js\":\"58472990800eebd9\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/backlinkAutocomplete.js\":\"e27676aa91e1cd99\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/blockCrumbs.js\":\"c0bc246a1f2ab826\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/blockrefAutocomplete.js\":\"c7bf626fcd3242cc\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/cadencedIdleJob.js\":\"e61e9ff2df544510\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/callbackSet.js\":\"24d768b57b93e8b0\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/clientId.js\":\"32377e6eebe2eb5b\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/codemirror.js\":\"97b264b335fc34c7\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/codemirrorCompletion.js\":\"95f2156b14367456\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/copy.js\":\"52451970f5e4b20b\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dailyPage.js\":\"b460b1550d996234\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dbForensics.js\":\"c053d5638639e368\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dbForensicsHooks.js\":\"5ab3056dca3a908a\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/deleteBlockThroughUi.js\":\"8f1be7be16524512\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dialogs.js\":\"8d46ab430f5ea9be\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/dom.js\":\"2fb923e698a6d58f\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/downloadBlob.js\":\"2d4a3c028f08506d\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/exportSqliteDb.js\":\"1104e58caff62994\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/fileSystemAccess.js\":\"318e18bb1b83aa35\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/flipSlide.js\":\"46d290a79cd6cb5d\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/fnv1a.js\":\"1afce84d510e9d20\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/formatBytes.js\":\"ab4642634310109e\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/fuzzyRank.js\":\"2229e12cf415ce95\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/idbKeyedStore.js\":\"5107b43412439538\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/idleCallbackPolyfill.js\":\"1ecf443f58a0dea8\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/keyboardAwareScroll.js\":\"53a1111c94dae2c9\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/keyboardViewport.js\":\"c3b8221f21251aae\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/lastWorkspace.js\":\"555d7d667fa9f8b9\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/layoutColumns.js\":\"5c4157f2ddab0129\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/layoutSessionDom.js\":\"b695c48efddea370\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/layoutSessionId.js\":\"b306d9ad28e655af\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/linkClickGestures.js\":\"ceea8056cedcfdf2\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/linkTargetAutocomplete.js\":\"1d8f12f0579f8af3\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/localDbCorruption.js\":\"4ea223d2454e1369\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/localDbRecovery.js\":\"8399df2b71a25e89\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/markdownParser.js\":\"3056bda0fd7a186c\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/memoize.js\":\"bdc4a23cd53e727d\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/nameFieldCommit.js\":\"4aa94cb52da484b6\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/nameList.js\":\"abf1e65af8ef11f5\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/navigation.js\":\"3c37236c3b11c3b8\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/omnilinerNamespace.js\":\"62622bbf647ffa16\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/opfsPageScan.js\":\"0983c71cbddbdc1e\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelClearance.js\":\"a168d2eba8d07ea0\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelHistory.js\":\"25566266acda7056\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelLanes.js\":\"474565bdfb42e683\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelLayoutProjection.js\":\"d6d910ac92d63e8f\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelScrollAnchor.js\":\"7644fb4218317c00\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/panelUrlFlags.js\":\"a53cc7c7469bab5a\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/platform.js\":\"aee64b964be49428\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/pluralize.js\":\"7d274b85b50d902a\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/propertyCreation.js\":\"08dfe2e7ee217254\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/propertyNavigation.js\":\"1020df2287c74c4c\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/propertyValueContext.js\":\"6a95f2d2d7420e80\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/react.js\":\"f94461ba4da0dcb0\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/relativeDate.js\":\"e3d35c565999c15d\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/relativeTime.js\":\"9f4c6990de5d8926\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/renderScope.js\":\"fa05019d1f583231\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/resolvedThenable.js\":\"b0e68230eae55b02\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/routing.js\":\"779d4bafca479398\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/safeMode.js\":\"a652094db393febb\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/scheduleIdle.js\":\"84364b3cd959b308\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/screenWakeLock.js\":\"b61eb57ad338f0e4\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/selection.js\":\"c431d7c1dbc67d88\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/softKeyboardGrab.js\":\"dd8a833d6b961940\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/startupTimeline.js\":\"143f0d42db431b94\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/state.js\":\"2ea78758a3f20f94\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/string.js\":\"ac332c3a74290949\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/surfaceZoom.js\":\"aa0d201423957a01\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/time.js\":\"ae56f64d4eb8a794\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/toast.js\":\"611f6d9e03402005\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/toggleStore.js\":\"ca10708a83642a40\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/untilStopped.js\":\"2e343cb9df434622\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/userActivity.js\":\"f9be59d1863c5a04\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/viewTransition.js\":\"fc4ed59714d1708e\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/viewport.js\":\"3fe1d3457e09780c\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/webLock.js\":\"26960266f4feed43\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/workspaceRecovery.js\":\"a6416f4a0876d072\",\"/knowledge-medium/pr-preview/pr-1831/src/utils/workspaceSnapshotStore.js\":\"51a2f8e2784eb1c8\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-compiler-runtime.js\":\"dcef7bec454cf974\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-client.js\":\"8bfad907224ae4b7\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-server-edge.js\":\"fbe40187c3a153dd\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-server.js\":\"1de9345c23db0165\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-static-edge.js\":\"807cdc4e86060ff6\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-static.js\":\"644cc0e307a44435\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom-test-utils.js\":\"82286f29a73e1e70\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-dom.js\":\"8312fffcbf3c9266\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react-jsx-runtime.js\":\"c956ae02074a090f\",\"/knowledge-medium/pr-preview/pr-1831/src/vendor/react.js\":\"7ac184a61d71c81c\",\"/knowledge-medium/pr-preview/pr-1831/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1831/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1831/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
