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
		buildId: "1e454fdb40d8-c035f9d4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1833/\":\"d610713cb6c14922\",\"/knowledge-medium/pr-preview/pr-1833/index.html\":\"d610713cb6c14922\",\"/knowledge-medium/pr-preview/pr-1833/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1833/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1833/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1833/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1833/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1833/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1833/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1833/assets/FacadeVFS-Cy6NV650.js\":\"5c235461412ddeff\",\"/knowledge-medium/pr-preview/pr-1833/assets/OPFSCoopSyncVFS-e2Cr5cjo.js\":\"988b967e8cf54219\",\"/knowledge-medium/pr-preview/pr-1833/assets/OPFSWriteAheadVFS-DYuqi9Vz.js\":\"31cc522d037d8a43\",\"/knowledge-medium/pr-preview/pr-1833/assets/wa-sqlite-BebPuM88.js\":\"4ab7a0e74d2ddfe4\",\"/knowledge-medium/pr-preview/pr-1833/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1833/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1833/assets/wa-sqlite-async-T0rg4MvB.js\":\"6df1d770840b980c\",\"/knowledge-medium/pr-preview/pr-1833/assets/worker-DfYZPYDS.js\":\"009015aed78a4f38\",\"/knowledge-medium/pr-preview/pr-1833/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1833/chunks/app-T4CWas5t.js\":\"9a11ab03eef15f67\",\"/knowledge-medium/pr-preview/pr-1833/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1833/index.js\":\"12c3f2a3518d7f0b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1833/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1833/assets/AccessHandlePoolVFS-DwH_GV7a.js\":\"90c8a33f49084922\",\"/knowledge-medium/pr-preview/pr-1833/assets/IDBBatchAtomicVFS-DLu-VbNT.js\":\"dda0d0c2f06f4872\",\"/knowledge-medium/pr-preview/pr-1833/assets/MemoryVFS-DTNKysUw.js\":\"ca56e0ad803fbfc7\",\"/knowledge-medium/pr-preview/pr-1833/assets/mc-wa-sqlite-CTPLIJAk.js\":\"0f3c1e202329f2d2\",\"/knowledge-medium/pr-preview/pr-1833/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1833/assets/mc-wa-sqlite-async-DgVI5R1_.js\":\"f3517d4145fd4b9f\",\"/knowledge-medium/pr-preview/pr-1833/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1833/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1833/chunks/AccessHandlePoolVFS-DfvCQUnI.js\":\"fd3fd180c46d1de4\",\"/knowledge-medium/pr-preview/pr-1833/chunks/FacadeVFS-iz69mZUK.js\":\"288be1552922f00c\",\"/knowledge-medium/pr-preview/pr-1833/chunks/IDBBatchAtomicVFS-BBa4JF-w.js\":\"04272ad04cbadf32\",\"/knowledge-medium/pr-preview/pr-1833/chunks/MemoryVFS-Dny_1n2T.js\":\"a963549396d3e0c0\",\"/knowledge-medium/pr-preview/pr-1833/chunks/OPFSCoopSyncVFS-Dkb6ru6Z.js\":\"79be0dc99cff0614\",\"/knowledge-medium/pr-preview/pr-1833/chunks/OPFSWriteAheadVFS-BoeE-LCk.js\":\"a712df6f97955404\",\"/knowledge-medium/pr-preview/pr-1833/chunks/Preview-Ch4UCXgo.js\":\"b4a4781d97f6c518\",\"/knowledge-medium/pr-preview/pr-1833/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1833/chunks/card-EUcRM9Tg.js\":\"cfe71683e822994d\",\"/knowledge-medium/pr-preview/pr-1833/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1833/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1833/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1833/chunks/dist-DAqd1WjQ.js\":\"bd5593094c10f3f8\",\"/knowledge-medium/pr-preview/pr-1833/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1833/chunks/mc-wa-sqlite-async-BZGJCIjC.js\":\"b4368ff208cdeef2\",\"/knowledge-medium/pr-preview/pr-1833/chunks/mc-wa-sqlite-xWRITJux.js\":\"8065f514a24f42fc\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-B0oOGybh.js\":\"ecad224109a3bb05\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-BTIzMVUK.js\":\"2fbb73630f7de66f\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-Bom2TGAT.js\":\"3d6cf103e226db15\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-C43jYixc.js\":\"e537350ca03af4ee\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-D8j5R3xH.js\":\"3b4a704a77fa7fd1\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-DXo6PBkW.js\":\"48903093a9627b2c\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-dom-server-legacy.browser.production-DxEUie2e.js\":\"66f9f0c24b856aad\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-dom-server.browser.production-Cck0kpmK.js\":\"5f7d8c52960d5369\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-dom-server.edge.production-zhV55w6H.js\":\"ca05f8b2f8e65f91\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-mOsYzdAJ.js\":\"aa90a098575f8d2b\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-megAijb4.js\":\"a110ccdb74068b73\",\"/knowledge-medium/pr-preview/pr-1833/chunks/server.browser-5MkzOTAy.js\":\"e5d3041cf1b8200c\",\"/knowledge-medium/pr-preview/pr-1833/chunks/textarea-C4D-2Jp4.js\":\"fbee470f4b00a875\",\"/knowledge-medium/pr-preview/pr-1833/chunks/ui-Du10eZTz.js\":\"8e39b9845521a0ec\",\"/knowledge-medium/pr-preview/pr-1833/chunks/wa-sqlite-async-BZYkzS6A.js\":\"fbe5c2c812799c76\",\"/knowledge-medium/pr-preview/pr-1833/chunks/wa-sqlite-jk4_c3fa.js\":\"e70d19ca698fcf89\",\"/knowledge-medium/pr-preview/pr-1833/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1833/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1833/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1833/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1833/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1833/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1833/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1833/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1833/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1833/src/App.js\":\"a5549623a08257cd\",\"/knowledge-medium/pr-preview/pr-1833/src/appUpdate.js\":\"cfbc1fb8bb23121e\",\"/knowledge-medium/pr-preview/pr-1833/src/appVersion.js\":\"a5b759381e71eceb\",\"/knowledge-medium/pr-preview/pr-1833/src/bootstrap/initialLayout.js\":\"4b2a4b2e1094f486\",\"/knowledge-medium/pr-preview/pr-1833/src/bootstrap/openWorkspaceData.js\":\"990c8d06a2424efb\",\"/knowledge-medium/pr-preview/pr-1833/src/bootstrap/resolveWorkspace.js\":\"60e3c33481e24b43\",\"/knowledge-medium/pr-preview/pr-1833/src/bootstrap/workspaceBootstrap.js\":\"eeb1357c3a34cc77\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockComponent.js\":\"113769157cbfae63\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockCrumbs.js\":\"56ee1b9652b03947\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockEditor.js\":\"c0149477e60a06f6\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockLoadingPlaceholder.js\":\"7f346c3d53917b6a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockProperties.js\":\"177ef120771379de\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockSearchPicker.js\":\"5e9381940c86aa09\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ConfirmBulkDeleteDialog.js\":\"0474b48859fc82c7\",\"/knowledge-medium/pr-preview/pr-1833/src/components/DividerHandle.js\":\"8629f534fd989c0e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/DraftEditor.js\":\"ffd81c611dc94540\",\"/knowledge-medium/pr-preview/pr-1833/src/components/GutterPill.js\":\"89d2d1768a861ec7\",\"/knowledge-medium/pr-preview/pr-1833/src/components/Header.js\":\"7ca9a92cd9570314\",\"/knowledge-medium/pr-preview/pr-1833/src/components/LazyBlockComponent.js\":\"007c41a8687fe10d\",\"/knowledge-medium/pr-preview/pr-1833/src/components/Login.js\":\"f6a540ad4e1259c8\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ZoomableSurface.js\":\"7a0bd368817dc366\",\"/knowledge-medium/pr-preview/pr-1833/src/components/editModeKeepalive.js\":\"bba8f8cf4d84f34d\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyDisplay/PropertyDisplayScope.js\":\"080d4d35a8d8ee7b\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5d0c5efadafeb191\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/RefPropertyEditor.js\":\"54a190bfd2ce0be6\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/RefTargetTypePicker.js\":\"6c37f584a5b5b740\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/SelectPropertyEditor.js\":\"37798302b0b2d86c\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/TypesPropertyEditor.js\":\"d909567ea1c818dc\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/defaults.js\":\"84077fcf6905dc5e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/kernelValuePresets.js\":\"2b6f11303acbd63d\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/selectablePresets.js\":\"ae54ecf07b194236\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/typesPropertyUi.js\":\"c21a647e6f958af1\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/AddPropertyForm.js\":\"7f52f2ca8cecd639\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/PropertyPicker.js\":\"2e536793ba791fc4\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/PropertyRow.js\":\"a3ab82caaf9a82ba\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/Rows.js\":\"dda90892d03df602\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/actions.js\":\"43a3268a90512530\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/declarationOnly.js\":\"d1267de53a719893\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/layout.js\":\"48956dcdf4759f2c\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/model.js\":\"fd766c7ee6b17093\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/shapeUi.js\":\"5ee3dd8433f117d7\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/shapes.js\":\"43b841529ae392ef\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/usePropertyEditingActivation.js\":\"44d4655ad99fdc7e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/visibility.js\":\"0d6f0db9ca671c39\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanelSections.js\":\"aecd230c3af67ce3\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/BlockEmbed.js\":\"078e639151c49a5d\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/BlockLink.js\":\"1ab97d13463532c6\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/BlockRef.js\":\"76cb2385bc7e3151\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/ReferenceLink.js\":\"77d966d09d9eb9a5\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/cycleGuard.js\":\"278c228258c818c3\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/cycleGuardContext.js\":\"6100323415f03b5f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/linkInteraction.js\":\"f69d9bda50b00c09\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/referenceLayout.js\":\"890e2329c07829bc\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/useBlockRefAncestors.js\":\"5861ecb6f8294c43\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/BlockGutter.js\":\"c0b6cb62b4463542\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/BlockInfoDialog.js\":\"d58da0f066faf072\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/BlockTypeBlockRenderer.js\":\"abede7cca58b33fd\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/BulletHoverCard.js\":\"4bc29f237135fb1a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/CodeMirrorContentRenderer.js\":\"73360546dd6e5df2\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fc97eb8d8243dfda\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/ColumnResizeHandles.js\":\"b742f70733e53ec9\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4526f65cdc7233d0\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/DefaultBlockRenderer.js\":\"c4291061b2b198cb\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/LayoutRenderer.js\":\"35ec557e14d9fab2\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/MarkdownContentRenderer.js\":\"36dad4b510a484e7\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/MissingDataRenderer.js\":\"585871de864d5e1a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/PanelRenderer.js\":\"6c7f1dc3f58c9069\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/PropertySchemaBlockRenderer.js\":\"111287f05277c079\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/TopLevelRenderer.js\":\"c683988943766802\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/blockGutterMode.js\":\"3f24b791d8a55753\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/blockTitleText.js\":\"bdb48de753d3eee1\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/fieldCreationKeydown.js\":\"d4c1f3c88f2b30a9\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/layoutRootContext.js\":\"98f0ca24a80ba89f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/typeChip/TypeChip.js\":\"5765b8681b0273cc\",\"/knowledge-medium/pr-preview/pr-1833/src/components/typeChip/chipStyle.js\":\"9687e395740f1fb7\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/anchored-floating.js\":\"831ca9f532273497\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/button.js\":\"c12222105a405baa\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/card.js\":\"06ca6d62ecc33112\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/checkbox.js\":\"a5f817dc250cfc3c\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/collapsible.js\":\"a4000c6f41879662\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/command.js\":\"fc2cd38ac5964a03\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/context-menu.js\":\"46b221d27d54b5c3\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/dialog.js\":\"749b73b49d48d4b5\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/dropdown-menu.js\":\"171826abf8d25ccb\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/floating-listbox.js\":\"2eb476de92e9698a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/index.js\":\"c2cea644515affb8\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/input.js\":\"75daec31eee3ae37\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/kbd.js\":\"b07ee73fdda46303\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/label.js\":\"85e49b214ea2ac9e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/textarea.js\":\"3e61648cdc5d82e4\",\"/knowledge-medium/pr-preview/pr-1833/src/components/useEditModeYieldKeepalive.js\":\"6cf4a24d03eb4a7b\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/BootFallback.js\":\"d71a8da402038e3d\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/FocusedRowLazyMount.js\":\"987f30343f39867f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/LazyViewportMount.js\":\"54902e2415c8ee49\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/LocalDbCorruptionFallback.js\":\"62f379756ec03302\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/error.js\":\"d911054cb7beacba\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/lazyMountRegistry.js\":\"87a5ac7c8f354654\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/suspense.js\":\"5e60f25aa702d592\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/CreateWorkspaceDialog.js\":\"7017ed7ed8ae4c82\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/PendingInvitations.js\":\"88873fa4cb5d8b9e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/SyncProgress.js\":\"1742b3ad977bb3ef\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/UnlockProgress.js\":\"6561b9bd1f0a355e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/WorkspaceKeyGate.js\":\"9140615f3a2ee8b1\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/WorkspaceSettingsDialog.js\":\"3e3f3decc7cf9067\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/WorkspaceSwitcher.js\":\"95194e008814b68c\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/WorkspaceSyncGate.js\":\"0be478bf05399dba\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/ConversionFlow.js\":\"bf6cb45ab003173f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/ConversionFlowHost.js\":\"dfc97cc6a8ccf8c9\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/EncryptionSection.js\":\"0f7f7d0c87fcdb55\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/attachmentPrompts.js\":\"32ddfbae2dddb2f8\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9f7ba6740dd81cd2\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/conversionFlowDeps.js\":\"74356bd2e0b0940a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/conversionFlowStore.js\":\"d9bac7eeff18611f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/flowUi.js\":\"6894c1fa718950b7\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/useConversionRun.js\":\"b6a9e919767687da\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/keyUi.js\":\"fa6f7cb208fb05d5\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/useCloseOnKeyLoss.js\":\"2745cffff80273f4\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/useCloseOnServerE2ee.js\":\"7ba20552d9f8887e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/workspaceUnlocked.js\":\"e3b55c0d6c1f1af8\",\"/knowledge-medium/pr-preview/pr-1833/src/context/backgroundSubtree.js\":\"741833d45aacce62\",\"/knowledge-medium/pr-preview/pr-1833/src/context/block.js\":\"7f087a08df43817b\",\"/knowledge-medium/pr-preview/pr-1833/src/context/layoutWsContext.js\":\"9d46a21761b4d30b\",\"/knowledge-medium/pr-preview/pr-1833/src/context/propertyDisplay.js\":\"0ff0e3efeb925111\",\"/knowledge-medium/pr-preview/pr-1833/src/context/repo.js\":\"d17de17784e2f5d9\",\"/knowledge-medium/pr-preview/pr-1833/src/data/aliasClaim.js\":\"c924354d09bd9fe6\",\"/knowledge-medium/pr-preview/pr-1833/src/data/aliasSeatNamespace.js\":\"8f8eb39094994941\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/blockData.js\":\"7956c5fc630db189\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/blockType.js\":\"73e9ac5f227d15bb\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/changeScope.js\":\"180d1fe3c40c30fd\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/codecs.js\":\"859d73472ab80e11\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/derivedData.js\":\"70ec8eb85e31ff59\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/errors.js\":\"21b5fbb2d46b6dac\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/events.js\":\"9d81bb490cf33aac\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/handle.js\":\"a9be7f4a05947545\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/index.js\":\"022d98426929d8a0\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/mutator.js\":\"f24af1edc9657b3d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/processor.js\":\"c2ef4f2393df7837\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/propertySchema.js\":\"eec20cbae7b09a49\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/query.js\":\"e3f971d82e1a127f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/sameTxProcessor.js\":\"898e78174ae9fe8b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/schema.js\":\"a9be7f4a05947545\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/tx.js\":\"a9be7f4a05947545\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/typedBlockQuery.js\":\"5ad66ca197a46990\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/user.js\":\"a0889250bddfdccf\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/valuePresetCore.js\":\"603bb9b44ad1fc5f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/valuePresets.js\":\"12dcab5fb31c5854\",\"/knowledge-medium/pr-preview/pr-1833/src/data/attachmentCleanerIOVerb.js\":\"f6cea9e5db4f1724\",\"/knowledge-medium/pr-preview/pr-1833/src/data/block.js\":\"e7e5914ca721e6f1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockCache.js\":\"59669156ac7729c1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockId.js\":\"a6595dea76fe056b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockLiveness.js\":\"1f2ecebf455d5a2a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockMerge.js\":\"9c196c5b31f19e58\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockSchema.js\":\"ecdf006de7677b53\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockTypeLookup.js\":\"ac8127ec691eb6b7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockTypes.js\":\"e8b915b09b4b8942\",\"/knowledge-medium/pr-preview/pr-1833/src/data/clientContext.js\":\"b7c951b60a73b7de\",\"/knowledge-medium/pr-preview/pr-1833/src/data/dbFileSiblings.js\":\"f7bccf67f332f914\",\"/knowledge-medium/pr-preview/pr-1833/src/data/definitionSeeds.js\":\"6d3bfa541fb9671a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/derivedIds.js\":\"df7ed46d8e090b87\",\"/knowledge-medium/pr-preview/pr-1833/src/data/drawnSubtree.js\":\"2c1873b0d48e45e2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/facetBridge.js\":\"112549458f13874d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/facets.js\":\"fb242ce2ea348573\",\"/knowledge-medium/pr-preview/pr-1833/src/data/globalState.js\":\"65e54befdf23aa6d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/aliasClaimRederiveProcessor.js\":\"b2c61e7def5e81f8\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/ancestorBatch.js\":\"8c00c237d57381ae\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/blockTypeTypeifyProcessor.js\":\"835a62a8220dc394\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/clientSchema.js\":\"9db350a99a6115a8\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/commitPipeline.js\":\"3c3c6040d61e6343\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/devAssertions.js\":\"070dd21fe99312b5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/firstSync.js\":\"6dc4fa906598ba73\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/freshInitialLoad.js\":\"7aacb292f2d53e95\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/graphBackfillClaim.js\":\"678c0cad3b5c8677\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/handleStore.js\":\"d654c53c267aa3e7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/idleMarkerJobs.js\":\"ba82e17949073d0c\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/initialDownload.js\":\"b8cb36a253d61755\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/initializeClientDatabase.js\":\"86dd647856dc626c\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/jsonCanonical.js\":\"eeea458d1fcc9e75\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/kernelInvalidation.js\":\"14bdb560f0214755\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/kernelProcessors.js\":\"4103959c0987a4f3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/kernelQueries.js\":\"8d5a83e6112feb67\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/mergeTypeMembershipProcessor.js\":\"7a0db266ac7f8624\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/normalizeReferencesProcessor.js\":\"bc2b3f5c09554a62\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/poolInstrumentation.js\":\"5e31d5b96010539d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/processorRunner.js\":\"3bca11fcfa7fe9db\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyCellBackfill.js\":\"f4d0eca6025a3dd6\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyChildMint.js\":\"5bdcba6d77ee1af3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyChildrenProcessor.js\":\"86dd708fca32c5e4\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8f32dfe3d68271ff\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyDefinitionSynthesis.js\":\"1f2605ee1556a2dd\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyKeyScan.js\":\"074d347a02bea715\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertySchemaResolution.js\":\"e82229cef3bbb950\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyValueEdits.js\":\"e432c127a7065ab4\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/raiseProtocol.js\":\"286689049760a0ba\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/readBatch.js\":\"5f5cfa58d0d605b2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/refProjection.js\":\"cca3058dff94292e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/referenceTargetLookups.js\":\"bf03eb43613a7a05\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/referenceTargetProcessor.js\":\"daab6065c79ee6e3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/replayMerge.js\":\"8e2df35d928b00ab\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/sqlBinds.js\":\"f73eb5840143cff6\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"966ad74204f4b0cf\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/arrivalProcessors.js\":\"ba8ccfccb4e8d77a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/invalidate.js\":\"3797151672b322f3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/materialize.js\":\"d1f510f1c3ac1454\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/observer.js\":\"3d084a270650ec38\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/reconcile.js\":\"78428db0539eb0dd\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/timingMetrics.js\":\"e777dbc2d61128a3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/treeQueries.js\":\"26633887ef5dcfdd\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/txEngine.js\":\"e9fbb276bb302ded\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/txSnapshots.js\":\"842a151dd5c6b615\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/typedBlockQuery.js\":\"9d75263235f8253c\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/undoManager.js\":\"7ddb28b181045465\",\"/knowledge-medium/pr-preview/pr-1833/src/data/invalidation.js\":\"af402fdd8ac23768\",\"/knowledge-medium/pr-preview/pr-1833/src/data/kernelDataExtension.js\":\"aa406110ce59054d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/kernelPage.js\":\"93338bab670b6c8b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/kernelValuePresetCores.js\":\"58791ab984978bd1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/localDbCorruptionSignal.js\":\"a611a27dcbfa4f20\",\"/knowledge-medium/pr-preview/pr-1833/src/data/localDbStorage.js\":\"4695485f7d87dc0e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/localDbVfs.js\":\"8af9718a37aa7b2e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/localSchema.js\":\"598e588243068b74\",\"/knowledge-medium/pr-preview/pr-1833/src/data/maintenance.js\":\"9ddc31b86e96febe\",\"/knowledge-medium/pr-preview/pr-1833/src/data/mergeProperties.js\":\"9b457204cf9521e7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/metricsConsoleHook.js\":\"c744319286f06535\",\"/knowledge-medium/pr-preview/pr-1833/src/data/migrationsPage.js\":\"2d19ab869c6095b9\",\"/knowledge-medium/pr-preview/pr-1833/src/data/mutators.js\":\"804d8a2386efdc74\",\"/knowledge-medium/pr-preview/pr-1833/src/data/orderKey.js\":\"843da4ac58944998\",\"/knowledge-medium/pr-preview/pr-1833/src/data/orderKeyPlacement.js\":\"d0c431dec50ffcb2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/outlineSurface.js\":\"91494d372ffe0efe\",\"/knowledge-medium/pr-preview/pr-1833/src/data/pendingEditorContent.js\":\"b4e7c3a5950b5feb\",\"/knowledge-medium/pr-preview/pr-1833/src/data/pendingUploadsSql.js\":\"04351ad7fc9de74a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/pluginStateExtensions.js\":\"cc62b7f2c45ce48a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/powerSyncLogger.js\":\"52caa6e1edfffe63\",\"/knowledge-medium/pr-preview/pr-1833/src/data/projectorRuntime.js\":\"a9e07c68e1c026aa\",\"/knowledge-medium/pr-preview/pr-1833/src/data/properties.js\":\"7f095efc51684d6b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertiesPage.js\":\"081009032626d68a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyChildren.js\":\"43678df90c1e6c74\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyDefinitionFanout.js\":\"d851d43846d777d5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyDefinitionMetadata.js\":\"c88a49c7a48ef450\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyDefinitionRegistry.js\":\"199cbf708981518f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyDisplayMode.js\":\"95e15a4e368d24b5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyRowCreation.js\":\"7e98910b4c121394\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertySchemaCreation.js\":\"9a1af290471758c0\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertySeeds.js\":\"5f85ff5bc9a1fc48\",\"/knowledge-medium/pr-preview/pr-1833/src/data/recentsPage.js\":\"ee66f6233c3d2bd2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/referenceBlock.js\":\"daf855dfd6509bc5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/rejectedUploads.js\":\"919fef12b7889f10\",\"/knowledge-medium/pr-preview/pr-1833/src/data/releasePowerSyncConnection.js\":\"7b54df9ca5b21d0a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/repo.js\":\"c0e5c6b773ac1209\",\"/knowledge-medium/pr-preview/pr-1833/src/data/repoProvider.js\":\"23c21c776e3d4724\",\"/knowledge-medium/pr-preview/pr-1833/src/data/rowProperty.js\":\"588e5fe39d6c6615\",\"/knowledge-medium/pr-preview/pr-1833/src/data/searchFilter.js\":\"4a696dc5836e1036\",\"/knowledge-medium/pr-preview/pr-1833/src/data/seedIdentityLedger.js\":\"920866edcc95e203\",\"/knowledge-medium/pr-preview/pr-1833/src/data/stateBlocks.js\":\"392b48cb39d83058\",\"/knowledge-medium/pr-preview/pr-1833/src/data/structuralEditPolicy.js\":\"6d8ce1e193be6797\",\"/knowledge-medium/pr-preview/pr-1833/src/data/subtreeDelete.js\":\"8103f9e6d901d25e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/syncStreamLock.js\":\"9af8156a250dcf88\",\"/knowledge-medium/pr-preview/pr-1833/src/data/syncedTableSqlRecognizer.js\":\"c85d788e551a6b48\",\"/knowledge-medium/pr-preview/pr-1833/src/data/syncedTableWriteGuard.js\":\"332cb5c09641c966\",\"/knowledge-medium/pr-preview/pr-1833/src/data/targets.js\":\"8fe90ac0b5cc7eb2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeColors.js\":\"d4d085fe7dc69f9b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeDefinitionMetadata.js\":\"d7d567adb7c30b4b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeDefinitionRegistry.js\":\"be9ea75c50009956\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeExtraction.js\":\"047d47c418e10043\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeInitialValues.js\":\"f63c63001e2a4dd5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typePropertyGroups.js\":\"c2d2df454eaa2c7f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeSeeds.js\":\"5deee6589e2dbe9d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeTagger.js\":\"425a2665dc27e008\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typedRecords.js\":\"e6eb4558e114b3bc\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typesPage.js\":\"793e2a8ed56a0aab\",\"/knowledge-medium/pr-preview/pr-1833/src/data/userPrefs.js\":\"28cecb17a2f10c41\",\"/knowledge-medium/pr-preview/pr-1833/src/data/userSchemasService.js\":\"5cca055f3d7359fc\",\"/knowledge-medium/pr-preview/pr-1833/src/data/userTypesService.js\":\"6de6d145d2da335d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/valuePresetRegistry.js\":\"c358c175496ed7ed\",\"/knowledge-medium/pr-preview/pr-1833/src/data/visibleChildren.js\":\"aa089e3a07b018b9\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaceConversion.js\":\"9f36a67422e484b1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaceFirstSync.js\":\"8220edd048b0bd33\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaceIdNamespace.js\":\"86b3886a26c20a47\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaceSchema.js\":\"622be6754297a4b3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaces.js\":\"03e80f3f323fb42f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/writeAheadLog.js\":\"cd88286b1dbca703\",\"/knowledge-medium/pr-preview/pr-1833/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/BlockPasteShellDecorator.js\":\"5559893f58afea8a\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/atTrigger.js\":\"5d53e751600cde75\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/autocomplete.js\":\"4d2274d37ba1fa99\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/codeMirrorExtensions.js\":\"8beb2c60c3ee9620\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/contentFlush.js\":\"bbfc4b59b23fd8e5\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/defaultInteractions.js\":\"a63d045fb7363632\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/editSettleSignal.js\":\"5ef99b4e051df6f1\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/insertImage.js\":\"3b96a7931dc8b627\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/referenceCompletionRange.js\":\"6e7a03372d26d3ed\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/referenceTargetTypes.js\":\"28a8c6fa7db68826\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/syntaxContext.js\":\"891841be9568cfa7\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/triggerMatch.js\":\"ac925d308d109c3e\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/AppRuntimeProvider.js\":\"1d99441cdd09dcf9\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/BlockFocusShellDecorator.js\":\"7d407e0200f8e7c7\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/ExtensionRenderBoundary.js\":\"73b7a2af0eb73ad3\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/PanelContentRecovery.js\":\"763f1dcd189d23a3\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/apiCatalog.js\":\"74013019c4b2ba5d\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/approveExtensionHere.js\":\"960a8edb80af9ff5\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/armedCutAppMount.js\":\"717f750f5a767baa\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/batchableKeyedStore.js\":\"3204cffda82078c6\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/blockInteraction.js\":\"78382fbb25cb32af\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/blockSelectionAction.js\":\"40c8f9f6a74e75c6\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/compileExtensionModule.js\":\"f0d489f7fac93809\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/compiledModuleCache.js\":\"1a49ae4d57ceaf88\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/continuousGestures.js\":\"1eeb78b1c1335f51\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/core.js\":\"0a19e204fdceb9c9\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/defaultRenderers.js\":\"530f9720b614390c\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/definitionFanoutAppMount.js\":\"a129c8badc0680dc\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/dialogAppMount.js\":\"e948a2ce0e80c576\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/dynamicExtensionSeeds.js\":\"5e1c466034482eaa\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/dynamicExtensions.js\":\"acda5858609e0a89\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/exampleExtensions.js\":\"8fd40478e08fc2ff\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionApprovalStatus.js\":\"0bfb58f9f8c4ef24\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionLoadErrorToast.js\":\"bf68a1954cfca58a\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionLoadErrors.js\":\"ba630640dace2be9\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionLookup.js\":\"4b70c589fe2de6d0\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionToggles.js\":\"477b441fcf5f1446\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionUtilitiesCss.js\":\"452a2df3a488bf45\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/kernelPageDeletionGuard.js\":\"f6ea9ef32d4a2bf5\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/liveRuntime.js\":\"bf48b8bac81230ba\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/openExtensionsSettings.js\":\"22f3976a34f60f9f\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/overridesCache.js\":\"02f931f24966aee7\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/pluginIds.js\":\"e917645a857e24d9\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/processorRejectionToast.js\":\"6ae902726b3c520b\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/runtimeActions.js\":\"a235c307b908546d\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/runtimeContext.js\":\"e176ff61579aae21\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/staticAppExtensions.js\":\"8b85320ba2101db9\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/staticDataExtensions.js\":\"0fd11b66634f5724\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/toastAppMount.js\":\"c754309515d59171\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/useOverrides.js\":\"dc355cf163cd4c53\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/useShortcutSurfaceActivations.js\":\"360702a4f1773383\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/discoverToggleTree.js\":\"56d52600884e7b05\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/facet.js\":\"82260185db631a71\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/resolveAppRuntime.js\":\"9fb29337d310924c\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/runtimeEvents.js\":\"eb08395aa61f30d2\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/togglable.js\":\"3b8ffc5645d2d90a\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/variantFacet.js\":\"9ecd50876ab1d40c\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/verbFacet.js\":\"ef5973d9ee9fcdc4\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/block.js\":\"97e783954350f841\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/focusedChild.js\":\"7d5e733195d8e2e7\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/propertySchemas.js\":\"0b5fe033003141cc\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/typeRegistry.js\":\"baaf6d3b2ea41015\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useAncestorCrumbs.js\":\"28611c5a9980bf48\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useAutocompleteListbox.js\":\"46633ad2b60978c7\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useDebouncedSearch.js\":\"9f3cf72ca1b399f5\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useDebouncedValue.js\":\"fd2f3d2c9fe59261\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useIsFocalRender.js\":\"bc862e434525796c\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useIsReadOnly.js\":\"dd938540f31649a0\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useMaterializeBacklog.js\":\"e4825c929991b3eb\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useMinuteClock.js\":\"e44fa9273a4478df\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/usePanelLayoutProjection.js\":\"609a404a47a15ee5\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/usePendingInvitations.js\":\"461d49b1c835d375\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useRendererRegistry.js\":\"a6cb67dab8a0d6bd\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useRetainedFieldRows.js\":\"f8ce92e99bbf506f\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useWorkspaces.js\":\"72b8de2cf47a26b6\",\"/knowledge-medium/pr-preview/pr-1833/src/lib/utils.js\":\"8f63426cca34709b\",\"/knowledge-medium/pr-preview/pr-1833/src/main.js\":\"81c39cde2a3d1d12\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/MarkdownImage.js\":\"4f9a78e1ec7f25bf\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/blockSeparators.js\":\"0218273a879ed88b\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/context.js\":\"a625486a4944e286\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/defaultMarkdownExtension.js\":\"3cc81adc4bb0b2ad\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/extensions.js\":\"469765f7d63d5b86\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/renderMarkdownHtml.js\":\"d3106ed58a7f2a7e\",\"/knowledge-medium/pr-preview/pr-1833/src/minimal-editor.js\":\"0fedd45da726ad24\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/armedCut.js\":\"fe2c5318b3ea818a\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/captureMediaVerb.js\":\"c1b45f11991aabbb\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/clipboard.js\":\"3f8471c3852fe36f\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/decision.js\":\"9acd739679adf568\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/operations.js\":\"5b6682be476f324c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/account-header/AccountHeaderItem.js\":\"67c02b8fc5b67775\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/account-header/index.js\":\"cc854eff2a2ba3ab\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"aaad0c4e55425564\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/askAgent.js\":\"eec263d5ee2054bb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/askedStore.js\":\"805034cf8e8f6842\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ff0c6a8cb3605481\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/chipState.js\":\"e83e903c01209d45\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2ec0e7e33b08e55a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/index.js\":\"30aeabb81637fe82\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"790584c61ebafec6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/schema.js\":\"4cca0c736af254df\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1a1ec1d1268982d3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/BridgePairingDialog.js\":\"42c317b6765b228c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/addMedia.js\":\"c0c3c3b366f70579\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c030d47306c360ff\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/block.js\":\"c24c9ac4cfbef853\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/context.js\":\"8fdc36158b6be8f1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/displayIds.js\":\"29b546eb7c22b12e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/index.js\":\"cf4e2da01bc04ebd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/outline.js\":\"e79e41f78a581740\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/properties.js\":\"c3de08ce4f292038\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/refs.js\":\"3dbca5122582c8d1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a921f80c14f42a6c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/search.js\":\"20e28bbc57dce749\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/shared.js\":\"1789cb2c2a791efa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"38fc4b52bb68337b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/text.js\":\"de6f5fa986f95f89\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentWrites.js\":\"d3e1b9ad3452da5b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/authoringCatalog.js\":\"3446b0e2b6cb7b4a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/blockRefTargets.js\":\"02bd520b25879a5e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/bridge.js\":\"05eb229ad81b565e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/bridgeLoop.js\":\"2b25282ac2bc7d50\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/changeHistory.js\":\"7babdd420b805567\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/commands.js\":\"aae221aa73828d1a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/commentsCommands.js\":\"a7c24829d0923717\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/dataExtension.js\":\"4138f54fce58fdbc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/dataModelGuide.js\":\"1c9873187a8fad8a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/describeRuntime.js\":\"b61e12ef78744e56\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/extensionLint.js\":\"13a7b17845f9a0b3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/grainAudit.js\":\"72014636aedcfc6b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/healthCommand.js\":\"01d781b1daaab6f4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/index.js\":\"b067485fb43d9495\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/presetIdentity.js\":\"4acd6a46ddd667d7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3c7b57fe792ff976\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/readMedia.js\":\"08eed503e6152e4d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/schema.js\":\"305efbc6b58f8510\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/serialization.js\":\"05834043185b64bf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/targets.js\":\"b605f828c00f810e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/tokens.js\":\"f3f89df9bffaa98f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/watchEvents.js\":\"0e798f0bfc385e2c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/workspaceGuard.js\":\"a19092baaecc187b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/writeCommands.js\":\"e4c849c31be8226e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/AliasCollisionToast.js\":\"d5be6674860d3342\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/DuplicateNameBanner.js\":\"4304c744df01941f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/collisionMerge.js\":\"57e2e554d091d7bb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/dataExtension.js\":\"17529e7e56c9e2f8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/index.js\":\"6106a1d222a79c38\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/mergeCollisionAction.js\":\"9cf76a2c4bd6d339\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/pageStyling.js\":\"3a4aeef3632c35df\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/rejectionToast.js\":\"d98a2639859df512\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/syncProcessor.js\":\"cc1c44aaf69cb6a8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/actions.js\":\"75a33de324efabba\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/addComment.js\":\"8383012b6f056911\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/anchor.js\":\"587dd0f6fa352f91\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/anchorState.js\":\"b1e3d3badaf331f4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/commentLinks.js\":\"a461d0e0b6154fe5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/confirmThreadDeletion.js\":\"f3dd0e4afc860a5f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/container.js\":\"194536a887bbe2d4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/dataExtension.js\":\"e8e3577abf202d97\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/deleteComment.js\":\"df83153482bb80b0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/highlights.js\":\"25d19ade297645a1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/index.js\":\"e4aaf954f57fd726\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/linkedCommentsPill.js\":\"69d6a930c74049f3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/margin.js\":\"67e8fbf6fb52e49c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/marginSchema.js\":\"2a5c44480bdc39cb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/newComment.js\":\"3e256da34ec99787\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/ownThreadPicker.js\":\"2d85eaf43215a576\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/placement.js\":\"1f755738e6483100\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/queries.js\":\"13ce6fce2a3087db\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/quotePosition.js\":\"e2d824fb7524330f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/quotedIn.js\":\"2f114c6e43d52c62\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/quotedRange.js\":\"6ca8b0a7222ac88d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/rangeRefs.js\":\"564f1e7fcc721016\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/readHighlights.js\":\"a60eb05022e43fca\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/readSelection.js\":\"51d18c584956ad7a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/readSelectionUi.js\":\"9665270ef0d779d6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/reanchor.js\":\"77b9f3de75f75786\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/schema.js\":\"35a4c8cb5ad08d78\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/scope.js\":\"4d428e7df4dba940\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/scopeThreads.js\":\"0c993380882076ca\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/splitRetarget.js\":\"d7fe3d48ee860fbb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/suggestionCard.js\":\"a58ca92a4c6a8ba5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/suggestions.js\":\"e177ae1f401331d7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/summaries.js\":\"88daeaf58190a7d4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/summaryBatch.js\":\"5f8c85ca299a325b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/surface.js\":\"80d01d5ec44ab4a1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/threadNavigation.js\":\"d8ddf4220f101652\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/threads.js\":\"b3da88ff16af35c2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/ui.js\":\"b221cf7e6dc3e3fa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/uiStore.js\":\"67870620bcf182b3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/app-intents/appIntents.js\":\"17feffe031942877\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/app-intents/index.js\":\"8cc98627135c629e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/app-update-prompt/index.js\":\"e0a71d2a4f31b396\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/app-update-prompt/status.js\":\"9c84798aefedd04c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5909483f0b48999d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/MediaBlockRenderer.js\":\"6ef837739fb55d47\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/MediaDownLaneReplicator.js\":\"86062a083e08f8be\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/MediaUploadReconciler.js\":\"f032d82af35ce3ca\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/assetDownLane.js\":\"95e7d5e7e1f18bbf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/assetResolver.js\":\"95dee2a454ed6827\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/assetUpload.js\":\"6e18ceb795217cc1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/attachmentCleanerIO.js\":\"dc152c4a9b96210b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/supabaseAuditIO.js\":\"dcd8a48e3735185d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/blobStore.js\":\"ef6b37db466faa2d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/byteStore.js\":\"4a93e646208bbbb5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/cleanerIO.js\":\"cbe6cc59b3435a0c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/cleanupAttachments.js\":\"6987ac7fcb9b0d8e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/dataExtension.js\":\"12c85805c6dcb0cc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/downLane.js\":\"d4efd43b4d9423a8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/index.js\":\"d464b267f5d9fd34\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/insertImageContribution.js\":\"6f35f17a28f4fa3f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/laneArming.js\":\"8d21b44027413baa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/laneLock.js\":\"d4cfce10f5f7a314\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/mediaBlock.js\":\"b9cc340731f192ec\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/mediaCapture.js\":\"8ad6f05efcd7a012\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/mediaViewers.js\":\"6d48f97720b2f9b6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/mediaViewersFacet.js\":\"33337cc8512f6ece\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/pasteCapture.js\":\"95372574f3be6ffc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/resolver.js\":\"96909e458da950c1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/retryUploadsAction.js\":\"39a92110d7a35694\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/storagePaths.js\":\"daaf3b06a0a9d560\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadDrain.js\":\"3815205b929583e3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadLaneStatus.js\":\"475887d127805bcf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadReconcile.js\":\"1490ae7ef172a857\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadRecovery.js\":\"6c194e244a7fec31\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadStore.js\":\"30c87dc7ff5a930d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/useAssetObjectUrl.js\":\"e8938ed7f43fc2cb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ef969873db377d93\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/BacklinksViewSection.js\":\"848fbc7c21b260fc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/facet.js\":\"e88b01840075bb5a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/index.js\":\"a76168159ce71c5d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/prop.js\":\"8f5cc3050b12b035\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/BacklinkFilters.js\":\"e14148b89ac87834\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"daf167ba0af325d1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/BlockEntry.js\":\"1e3ef542d9e5284c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/LinkedReferences.js\":\"ce1fd2ebf46c7ffa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"889cedd6b3b59e69\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/dailyNoteDefaults.js\":\"69ae12ed198f3cf2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/dataExtension.js\":\"611d8921a75ec2cf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/edgeExclusions.js\":\"9171b9f24706e581\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/filterProperty.js\":\"ac496057199a092e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/index.js\":\"46437183830a9cf2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7b9bc4f40c60679e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/applies.js\":\"2a0b6674b215512e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/countQuery.js\":\"f87eb2bee685e494\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/expansionStore.js\":\"931e8873dc868b5d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/index.js\":\"7dcaa5c0baf458a9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"36894c2eb747c867\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/presentationInvalidation.js\":\"42dd870572b04077\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/propertyEditorOverride.js\":\"890111bf3f272a82\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/propertyFilter.js\":\"0af87df322927676\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/query.js\":\"a976b73a6b67ec73\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/resolveFilter.js\":\"462baea3f427549f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/sourceBatch.js\":\"2092093feec4f929\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/sources.js\":\"856e5b015ead3551\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/useBacklinks.js\":\"0db9865d9485ec52\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c0bb93924998cc38\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/BirthdayCelebration.js\":\"14eac52a72aef39a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/BirthdayOverlay.js\":\"cb2706dc95cd1ec2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/gate.js\":\"6a111bb1f96217c5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/index.js\":\"b1c31d1001bf1665\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/wolfTheme.js\":\"667baf574951f9a5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/BlockDragLayer.js\":\"5eeae21892840011\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/dragController.js\":\"9dcb0ea1fc2b1e34\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/dropTarget.js\":\"760c8d986107ca94\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/index.js\":\"746b8cc3a1d746b0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/projection.js\":\"6c2268e6d5e26fb1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-info/BlockMetaCard.js\":\"27f0bf853e773a80\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-info/index.js\":\"286f77d842e13229\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/AddTagDialog.js\":\"4403263e310ab539\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a2f9bd5dfa34ed22\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/TagNameIssueHint.js\":\"a66ef3dfa99bf1f8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/addTagAction.js\":\"89c6001a7e49511a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/appendTag.js\":\"749184c5de4f3a61\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/config.js\":\"c74ec31397a3180c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/dataExtension.js\":\"b3ae1f09aade7968\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/index.js\":\"530c42254c718c8a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/propertyEditorOverride.js\":\"97ae4b0d7cdf6054\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5c97b3d54ae075b7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"26e3f03dba5e3652\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/Breadcrumbs.js\":\"723a89e4cfc879da\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"aafd5ac5af544ffd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"86d8464dec27d550\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/index.js\":\"7056d2113afba1bd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d0b59d7a907a921d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/CharacterCountItem.js\":\"4cf3418fb2a0aba5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/ProfilePropertyEditor.js\":\"258e181beea1d1c5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/actions.js\":\"33557b247a5af7c6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/blockType.js\":\"c82f25445104c855\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/charCount.js\":\"2ef71ae0d7391f78\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/dataExtension.js\":\"24fb7ef414394e6c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/index.js\":\"616440947885758b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/profiles.js\":\"38b9e9f649515376\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/properties.js\":\"ee0c82ec94a7ff8b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/textCounts.js\":\"8236fc32ba6eb63e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/colemak-keybindings/index.js\":\"7ac37258e08dc47a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/CommandPalette.js\":\"a705eecd1970f13c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/HeaderItem.js\":\"aac7805a762ac554\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/context.js\":\"4b3d3864a2495e34\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/index.js\":\"d5133335bdf07e02\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/selection.js\":\"70c2e22f4e079596\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/toggleStore.js\":\"1518c50e9f3c00c1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/useCommandPaletteActions.js\":\"e3ee7bd35ce36248\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/ContributorBadges.js\":\"c53bc2455f36d1ed\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/author.js\":\"06aecb4a08bcb730\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/codeMirrorExtensions.js\":\"2a7c5e08613bc4d9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/dataExtension.js\":\"79527beb3933a925\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/index.js\":\"1f220596457b97fd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/mentionAutocomplete.js\":\"6ed3750858a48567\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/processor.js\":\"a12bc267c6ebe15c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/profiles.js\":\"f67086888733f49b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/queries.js\":\"a8d116db6fee8cfb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/schema.js\":\"f53ea9163d850b3f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c9fe870866bdf225\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f12c0cdec5800dda\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/index.js\":\"5bdf5b048afad8aa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6de72227ce2f3f12\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d1b08525ca18d39e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/CalendarGrid.js\":\"d39612523f21d1e5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/DailyNotePicker.js\":\"1366814e2f0da353\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"fe84f6455a6f5b2d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/DateNavDecorator.js\":\"cd2889367842b94e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/DateScrubOverlay.js\":\"a6f8d5441eeb1b86\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/HeaderItem.js\":\"ce22c6a21c760b82\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/ReschedulePicker.js\":\"90f316e3d4d27eb4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/SpreadDatesDialog.js\":\"686b59e1b9513f78\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/actions.js\":\"9db6fa22c2f2ede7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/blockDateAdapter.js\":\"f3aa2c616cec4e5f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/calendar.js\":\"78f2564f84ba3b6a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dailyNotes.js\":\"f5fe64c9b202f507\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dataExtension.js\":\"777ce50cc1dacba3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dateScrubActions.js\":\"67c4e76701b6952d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dateScrubGesture.js\":\"c93520c2f58849d9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c23c256b19770a6c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dateScrubRecognizer.js\":\"70c1ea9b69482578\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/deletionGuard.js\":\"4e1bd5965d4c4a76\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dueQuery.js\":\"d8434867e23d3f3a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/index.js\":\"c204066680fb860d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/landing.js\":\"47e790b80f155135\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/localSchema.js\":\"487ef31182d22718\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/referenceDateAdapter.js\":\"876db6a78fe9529c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/rescheduleAction.js\":\"7231069fa446032e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/schema.js\":\"8491f39fb2c417ad\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/spreadBlockDates.js\":\"184dcf4ac2804141\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/spreadDatesAction.js\":\"e8a968de08ebf977\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/today.js\":\"4dcd65b8746d7484\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5aa860e77504843e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"2ea3c82e6ef4ecec\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/audit.js\":\"7d7c391379e7e314\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/auditAction.js\":\"95f333f5e63e7915\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/auditRanges.js\":\"76baebf10fd1d445\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/diagnosticsSource.js\":\"36630e10de29539e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/divergenceScan.js\":\"a03bca2209d51632\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/index.js\":\"cabccb5a4a52d4a3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3ddb9237ddbc8d61\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/referencesMirror.js\":\"49035e10ca6548b2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/rowJson.js\":\"fa9e35206f988f8a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/schedule.js\":\"fb1ffdde9c44bba2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/store.js\":\"306e1c504852c043\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-maintenance/action.js\":\"6b8aa8034baf36d2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-maintenance/index.js\":\"2743d4e10530578d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-maintenance/plugin.js\":\"f7ca2e1b407ceef6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0e981dbda6ba8244\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/actions.js\":\"f5d44ce1b023b5e7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/changeMarker.js\":\"27054a5871557b97\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/diagnostics.js\":\"033f640258772570\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/fileSystemAccess.js\":\"98162b9a9375455c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/filenames.js\":\"a09904061328646b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/index.js\":\"d51f5c5a34acbf14\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/mirror.js\":\"dfcc79d69a6a8d38\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/runLock.js\":\"980cd1eda7ed61c1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/runtimeHealth.js\":\"1856ff506cafba96\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/schedule.js\":\"e70ac8958283a393\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/store.js\":\"a84da888fad18a68\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/default-themes/index.js\":\"2cead932e2af010c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/default-themes/themes.js\":\"2aa3cdb2f3a17a03\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/diagnostics/facet.js\":\"acd493463a81878e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/diagnostics/useDiagnostics.js\":\"70236ebbcb0980af\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extension-prompts/dismissals.js\":\"d2ff3be0dfbc4cd1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extension-prompts/index.js\":\"fdaef355fcf948f7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extension-prompts/status.js\":\"f9e2ea17ddac19f8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extension-prompts/store.js\":\"fa103fd587b78d9e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"064250995b21c6eb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/ExtensionsSettings.js\":\"121cbb90a74f9cf3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/actions.js\":\"93310c646deea6d8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/config.js\":\"78467008e85aa19a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/dataExtension.js\":\"9b5685a6f5a12fe7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/effect.js\":\"96200b6ca5cdbff8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/index.js\":\"9993e1138ed6e753\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a7fbf78f0c5e4997\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/useToggleTree.js\":\"13fd51e1110bf835\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/ExtractTypeDialog.js\":\"c340e509a3a2315d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5a21b03ff82a381d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/PropertyShapePicker.js\":\"4ccda498ec7e67db\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/action.js\":\"7a65e68300e48078\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/index.js\":\"2b35369eb7733226\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/FindReplaceDialog.js\":\"b2efa7d9d608e052\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/HeaderItem.js\":\"26f677ddc74cedfe\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/dataExtension.js\":\"4198919fb32997d9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/index.js\":\"773d16bed8bb42cb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/search.js\":\"83eec4dd81ae4bb6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/toggleStore.js\":\"7fadeff797381470\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/LocationPropertyEditor.js\":\"f3b48cadfd125914\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/MapView.js\":\"d9f308f6eb70c558\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/blockTypes.js\":\"c773290378051fc4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/codeMirrorExtensions.js\":\"2eec87bb3175f361\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/createOrFindPlace.js\":\"310bd5779c9fdcef\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/currentLocation.js\":\"5cb04acab4bbc9c9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/dataExtension.js\":\"09551275ebbf2ba6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/geoContentDecorator.js\":\"0d92004757be6d8c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/googlePlacesClient.js\":\"e55152e2307a5054\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/index.js\":\"cfc69c5cbe3ed490\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/locationsPage.js\":\"5dd779c2503663c9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/mapViewport.js\":\"0b1dbe63feeac7da\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/pickCurrentLocation.js\":\"0b01706ecae06dc1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/placeAutocomplete.js\":\"39f91c460c1381d5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/placeNameCollision.js\":\"f17d697a48a1eb14\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/properties.js\":\"fdbe87220f7bf003\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/propertyEditorOverrides.js\":\"54de0654f59236fe\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/query.js\":\"7e2e02105f9dbabe\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/usePlaceSearch.js\":\"5f90fee6ae90ad99\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"60ee88862c523ad8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9eb3d14ba1b7c260\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"616ae82f9aefde68\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/config.js\":\"4fd7d4052cfed8eb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/dataExtension.js\":\"bfceddabaf232547\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/facet.js\":\"e10318dcf14bdb4d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/grouping.js\":\"7d3cd7031d5725af\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/index.js\":\"1a816557819a26c0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f1e13ce3ca427e20\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/query.js\":\"79e361eab07c61f4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/resolveConfig.js\":\"1c65e539db73ea45\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"eaeb0abc083aa8a0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d7dfbe140e51c46e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/HtmlDocumentContent.js\":\"ff3f090e2419c0ec\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/HtmlFrame.js\":\"aada6c5c458d130a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/actions.js\":\"9a2a364cba4c14b5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/blockType.js\":\"5124bc3bbb526466\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/confirmRunScripts.js\":\"ff2bcb999802262c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/dataExtension.js\":\"dedc6a72f58318ac\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/frameAnnotations.js\":\"bcddc586fb94043a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/frameDocument.js\":\"4454546ee6ac75d8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/frameTheme.js\":\"4edcec20a252cc51\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/index.js\":\"770404df8cf75cf7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/scriptConsent.js\":\"4644527d7ab96652\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/sourceMap.js\":\"ee96c41ec3320cee\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/useDocumentScripts.js\":\"761ca09c0a033b11\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/index.js\":\"26f0c1de68018ee2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/record.js\":\"5d165d2fdd2addd4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/recordStore.js\":\"9f1cfa7253467d87\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/responsiveness.js\":\"9f6090fb58494614\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/schedule.js\":\"e7433ee8a5d4ac9c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/sessionContext.js\":\"9b891dcfcefec25e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f25e450a6924535d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8fb8f64c17e418da\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/actions.js\":\"eb4440452be25931\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/config.js\":\"92da93e474441877\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/dataExtension.js\":\"5fb7e9fb020e12e2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/effect.js\":\"e65d5d20451187dc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/index.js\":\"9d95dcb042813b6a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/keyCapture.js\":\"97da12ebe294f9f7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/overrideStore.js\":\"e44257ed703a4538\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"20f4447a7f59862f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/HeaderItem.js\":\"85c1e6b3bec9caff\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/LeftSidebar.js\":\"7e06e0781f7a43bb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/actions.js\":\"da12554a216b6312\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/facet.js\":\"0cfa676954ee15b7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/index.js\":\"b8f699ded5a79eed\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/shortcuts.js\":\"32b21e1368894eb8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/toggleStore.js\":\"0c9acb807f1cde7a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/merge-blocks/MergePicker.js\":\"343511d69794a89a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/merge-blocks/index.js\":\"090666834180c398\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/merge-blocks/mergeAction.js\":\"fc5ae2f24b7ef658\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/merge-blocks/strategy.js\":\"21b5e8402925ed19\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/Button.js\":\"d254ebd37184266d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"71ac4f1be5f07ca8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7795a8471bd83023\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/facet.js\":\"2929e4d24b760d01\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/index.js\":\"7dac3606adb99865\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"20343bdb06ce11b7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/actions.js\":\"97341d28b41734af\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"59d55d442a41ba81\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c7ec041c087ab065\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/index.js\":\"83f9ab62e7b2485e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9472078de8e575a3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c30b4ef12cc5270b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/contextMenuItem.js\":\"daf2fc72a5343d85\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/index.js\":\"3f3e2e5d923e3da2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/moveAction.js\":\"6c78e05c75af3669\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/moveBlocks.js\":\"40364bafb72a2403\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/selectionAfterMove.js\":\"6eab873c63df2efa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/TutorialBanner.js\":\"fc13b934ecb5f2d6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/action.js\":\"03b12c9f8aed19cb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/bannerDismissal.js\":\"65bd71019580e46b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/documents/cheatSheet.js\":\"c9881eaad10bf8f4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/index.js\":\"6b6e3304403e03b8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/keys.js\":\"f67614df816d75f7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/landing.js\":\"b40cd83cd64cd377\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/outline.js\":\"7e06ebf92ca4fd42\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/seed.js\":\"4377eddbea75e862\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/PerfTrendDialog.js\":\"18c8539c68f5e106\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/analyze.js\":\"0f676f3647837faa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/diagnosticsSource.js\":\"a86882476c1e1992\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/index.js\":\"17bc4621364f5056\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/load.js\":\"a67d2ed5e1ecb284\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/monitorRun.js\":\"edbc022745e370ee\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/schedule.js\":\"23f71fc660900d06\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/series.js\":\"ba0d8f72534e8998\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/store.js\":\"fbd813d915ab3756\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/trendAction.js\":\"9254f4a79d8046df\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/verdict.js\":\"ec3da5b3e442159b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/plain-outliner/clickToEditAction.js\":\"ce4e0cadf16358e2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/plain-outliner/index.js\":\"435d7dc504aee08f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/plain-outliner/interactions.js\":\"3fedeb5323b2eefd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3b76cd0d65ce350a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/MigrationGate.js\":\"5d1e15602b416a32\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/MigrationGateDialog.js\":\"2c268813533f5f5e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/action.js\":\"45c7f6e16e51dd7b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/index.js\":\"8be3b881d561b51c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/localRunMessage.js\":\"4e9dbaef9d8612e2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/plugin.js\":\"10dc823ee3611978\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/progressReport.js\":\"3f1e59e5cfeade87\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/sweepProgress.js\":\"ae1e10fe5756f34d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/FieldRowRenderer.js\":\"845a0674cccc7c31\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/ValueRowRenderer.js\":\"4a0696141beb2a0e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/actions.js\":\"b3135131ad4f5334\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/autocomplete.js\":\"25860f805e8b7212\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/fieldRow.js\":\"f2cc32186aa6edf8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/index.js\":\"9c4b0b57884ee2f1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/referenceWarning.js\":\"747196a705d5e7e3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/valueAutocomplete.js\":\"c0459e488101e7c0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/valueSchema.js\":\"1b605feca68afaf9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/HeaderItem.js\":\"65161429c24c0472\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/QuickFind.js\":\"ff359cc8afa9ec18\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/index.js\":\"580424bd97ed59ee\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/recents.js\":\"016f53c7ddbb8215\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/resultItems.js\":\"504ffdb570f49289\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/selection.js\":\"a2541fb322134dbd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/toggleStore.js\":\"56339d8451713f98\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/HeaderItem.js\":\"5191ae8ae2afd375\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b03dd402b04017d6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/grouping.js\":\"54cae37648caa0cc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/index.js\":\"e6816adfd709e480\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/target.js\":\"c638ef55ad64ef24\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/codeMirrorExtensions.js\":\"1af5787924fcd09b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/contentPrefill.js\":\"c41075c1fc61710f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/dataExtension.js\":\"3cdd5672363974b7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/index.js\":\"90057733e4b5b5b9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"bb26481f7590d713\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/invalidation.js\":\"7f46868132dbdd51\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/localSchema.js\":\"0bc5424e715fdc54\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/blockrefs/index.js\":\"52406c659803636e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"73338e72c531f844\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/index.js\":\"bc8b6b552205e30a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/referenceNode.js\":\"0e1063445012dc0c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cd35a74a0f3d2aec\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a6a06ee6f393aa05\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/wikilinks/index.js\":\"fa3b97e4049f43ae\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8368a4a787dec11c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ecafaad98f36dce0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/mergeRetargetProcessor.js\":\"15b51cefac59ee2a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/parseFence.js\":\"b9dbcd517dc9e4cb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/referenceParser.js\":\"3ae997d710f966c8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/referenceProjection.js\":\"272a7602ffd35e88\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/referencesProcessor.js\":\"1641f459e64c8699\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/renameProcessor.js\":\"6c465d023d146a18\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/spanReplacement.js\":\"9e5122c62fb7bb2d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/rich-paste/htmlToOutline.js\":\"f3f5b14089a1ff65\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/rich-paste/index.js\":\"57b0984713f608c9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/rich-paste/normalizeClipboardDom.js\":\"01f78dbe3df6e9a6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/rich-paste/pasteDecision.js\":\"057039ec551ba451\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/action.js\":\"ec0161fc2d1c4f6f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/blockIds.js\":\"5b28986b4f0f763a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/content.js\":\"4166e9d0f586cbd0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/effect.js\":\"eec37cf31322b279\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/ids.js\":\"eb435b53615c2dbb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/import.js\":\"012a16381f985185\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/index.js\":\"ebd6040be45a1993\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/plan.js\":\"189827c82cac8440\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/plugin.js\":\"1b30477b49e094f8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/promotion.js\":\"5f61a46a949e9663\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/properties.js\":\"151d5e4f19ebbef6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/references.js\":\"55fb1cf91de09ab4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/report.js\":\"cf4099a9078d9ddd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/roamMemo.js\":\"595c77b715f1c46d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/runtime.js\":\"03c00ed89514a38c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/schemaReconciliation.js\":\"a67da055e9754cc9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/srsMarkers.js\":\"3fe6ecbbeddc8efa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/todo.js\":\"30d68308965d06c3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/typeCandidates.js\":\"3534e555210eb6be\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/types.js\":\"465ff5fda3be5efd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/search-health/index.js\":\"17070d0c5a263b07\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/search-health/store.js\":\"1468b80ea9b56f06\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/HeaderItem.js\":\"1b3029f0ad9e31a3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9f4b2ccd98981dab\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/index.js\":\"8794923ebea44f69\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/model.js\":\"f2f4091d8c19393a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/toggleStore.js\":\"695e77742c1d968a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/useKeyInspector.js\":\"2ec15ded8398d4b3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e9c6a8e37dfac3a9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/ShellDecorator.js\":\"3c0cf278813ec541\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/actions.js\":\"69d37eda7661c9a9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/exclusionsFacet.js\":\"987d43dfd3a804e5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/index.js\":\"eeef9029f431cab5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/shell.js\":\"8183f982f2dbc73d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/surface.js\":\"64cdf55a77cc5ced\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/walker.js\":\"772ea6f529823411\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ef1fc7568213b0b1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/dataExtension.js\":\"524b5c619b2c386f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/index.js\":\"28e5e3c7d45fe63b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/indicator.js\":\"70e9fbee38896647\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/moveSrsState.js\":\"178ccc8876ad772e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f689121a6babc373\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/scheduler.js\":\"acbab76c77bbb696\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/schema.js\":\"24a4ef4027562b43\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d300ac2a9d0d0391\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/srsClipboard.js\":\"d533c164b167606d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"46bb7f6d7c11f749\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7db6ccc7b5dac509\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/DeckPicker.js\":\"90d1187d7afd03ab\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/ReviewControls.js\":\"c3dfec81b40f1feb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3d0e7ac774290f29\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/ReviewSession.js\":\"a5ae4d60c5e32829\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/actions.js\":\"92723ccd53f1c00a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/archive.js\":\"cba664f1434bf3e7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/dataExtension.js\":\"d93b6f272abbb303\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/deck.js\":\"191cd4cbdfea133c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/dueQuery.js\":\"bc60af5246cce835\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/gradeDecision.js\":\"eb6cbfbf8b949c23\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/index.js\":\"ef5c565c81ebb11a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/keyHints.js\":\"d998c4f9cba785f0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/reviewCardLayout.js\":\"7b31cb9ce3076236\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/reviewProgress.js\":\"7ecc7b1b4e49158a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/schema.js\":\"b229d66f586147d4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/useDueCards.js\":\"1332b4f5f4ab97c4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/startup-metrics/index.js\":\"d78581d4ab83aefc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/startup-metrics/record.js\":\"847dda0a1b7687cb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/storage-persistence/index.js\":\"0ade95cf73eb0e7e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/storage-persistence/persistenceStatus.js\":\"b6170d51eaeca108\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/storage-persistence/requestAction.js\":\"adcc977fbd792519\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/supertags/TypeChipsDecorator.js\":\"9e61e6543aaa9fa4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/supertags/codeMirrorExtensions.js\":\"dbffb96dbda3b8b5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/supertags/index.js\":\"9afb04aa7a243aa6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/supertags/typeAutocomplete.js\":\"4fc08801f6cb7e3b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c0216f09f4511eb1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/actions.js\":\"7229869b4d316925\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/anchor.js\":\"77edb45bc9cad3d0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/events.js\":\"117785031c7b8153\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/gestureActions.js\":\"abaa64a7222fffe6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/index.js\":\"503c9c9192cc1174\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1d309d5c8ee1afb2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/sync-metrics/collect.js\":\"9949715ad65e6929\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/sync-metrics/index.js\":\"5d2f56ddfcc40cc3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/sync-metrics/record.js\":\"34fee4c1707d10c6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/RejectionDialog.js\":\"d1d877d42924d714\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f7c76736a3ce3b58\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/index.js\":\"e08228a5409ddf86\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/model.js\":\"6d273363498553dc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/queueCounts.js\":\"7d495be1dca92844\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/rejectedHelpers.js\":\"8d6667e9dc694efc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/rematerializeAction.js\":\"853b0b0d9cc2671c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/useHysteresis.js\":\"19f21eea3c8919ec\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/ColumnHeaders.js\":\"3b3e9f7a771d0cf3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/TableLayout.js\":\"e5bae4c62a68776c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/actions.js\":\"1b5d00c4d93ec72d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/cellEdits.js\":\"89329a19d6173fcc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/columns.js\":\"27ff6769d7952fcf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/controller.js\":\"c5a31463ac661f4e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/convert.js\":\"130697c689d70c53\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/dataExtension.js\":\"100de50367fb7675\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/index.js\":\"9b82bbdac9e8dae4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/keys.js\":\"1fc18eaf537ae684\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/model.js\":\"10240fed033b1302\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/registry.js\":\"bfc46554b76abb98\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/schema.js\":\"a470c79e6948b197\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/theme-toggle/effect.js\":\"6cb34ebaa29d8b89\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/theme-toggle/index.js\":\"f42267526d1e95d5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/theme-toggle/theme.js\":\"d96d2566bd672813\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/todo/actions.js\":\"f7032fddd04c3395\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/todo/dataExtension.js\":\"bcbe64872de950b8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/todo/index.js\":\"d2137caaddb80eed\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/todo/schema.js\":\"e016c7045c95eebc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c6d901841ab8a630\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/actions.js\":\"fd80aed30cd70b7a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/defaultItems.js\":\"58779486d2232242\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/facet.js\":\"52347defdbf45a2a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/holdRecognizer.js\":\"b15b6fd23940162d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/index.js\":\"0f306421ffe7bbf9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/update-indicator/UpdateIndicator.js\":\"131e123b766c0d4f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/update-indicator/index.js\":\"d29807e3324639b8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/update-indicator/loadTimes.js\":\"7c8eff3d8269c4cd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/VideoNotesRenderer.js\":\"087dbd6d01fceb83\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/VideoPlayerRenderer.js\":\"1256af122c8e910c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/VideoTimeStamp.js\":\"2343db5b8e06c95f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/actions.js\":\"52b21abaabba9f90\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/index.js\":\"5710c03b6b43fc74\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/markdown.js\":\"a364feeb41c8e3a4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/notes.js\":\"be3ead3327dd081d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/registry.js\":\"bf32ca2668a7910a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/remark-timestamps.js\":\"590d168235a9440f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/view.js\":\"94e745d6e1cdeb50\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-link-hints/LinkHints.js\":\"cacac86f7f30fec5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-link-hints/index.js\":\"50d935e6935f5a73\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-link-hints/model.js\":\"86e099478639b65f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-link-hints/settings.js\":\"180395cf50a91b50\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-normal-mode/actions.js\":\"61c88764f52a8663\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-normal-mode/index.js\":\"887b1904238dee45\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-normal-mode/interactions.js\":\"9f8ba88efc694444\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/workspace-header/index.js\":\"ddc7677e73507aaf\",\"/knowledge-medium/pr-preview/pr-1833/src/registerServiceWorker.js\":\"fe2a9cce21b524e0\",\"/knowledge-medium/pr-preview/pr-1833/src/requestPersistentStorage.js\":\"19e919a712ff4c93\",\"/knowledge-medium/pr-preview/pr-1833/src/services/authRequestDeadline.js\":\"87e5423f19d73255\",\"/knowledge-medium/pr-preview/pr-1833/src/services/authStorage.js\":\"b1888b640198cc0c\",\"/knowledge-medium/pr-preview/pr-1833/src/services/powersync.js\":\"dd61c455458ed3eb\",\"/knowledge-medium/pr-preview/pr-1833/src/services/supabase.js\":\"5f146f328e762d5b\",\"/knowledge-medium/pr-preview/pr-1833/src/services/uploadErrorClassifier.js\":\"57c18a9a1aa70168\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/ActiveContexts.js\":\"dfa9222a57e261ce\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/HotkeyReconciler.js\":\"fbe78134043fe2f4\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/WipeLocalDataDialog.js\":\"5c6c587c0fb05452\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/actionDispatch.js\":\"a436f1e49ebd0b85\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/actionRefItems.js\":\"494b56aa84d8fa9f\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/applyKeybindingOverrides.js\":\"ed0837dc8b67a59d\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/blockActions.js\":\"6f056eb030411d98\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/canonicalizeChord.js\":\"d6d4774cf3d6cf48\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/defaultContexts.js\":\"a9d5109225b938df\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/defaultShortcuts.js\":\"979b8306fc048512\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/effectiveActions.js\":\"57bbfeb3d1950f1e\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/gestureAction.js\":\"a60c9be47ffbf0e2\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/gestureBinding.js\":\"c27d5a9bfcf81c58\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/holdRegistry.js\":\"7fde1dbcb2ebb8ff\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/keybindingConflicts.js\":\"3829a559bce13a6f\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/keybindingOverrides.js\":\"5b4c0e6fa6f8c316\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/pointerAction.js\":\"eeadfb49e73a0fd0\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/resolve.js\":\"d0ec83e96813a0c0\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/runAction.js\":\"2bb9040bc112ac68\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/sequenceMatcher.js\":\"9c561b99510f54b4\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/types.js\":\"c908a259af6aa80b\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/useActionContext.js\":\"c79a2168d966178f\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/useActionDiscovery.js\":\"b000e026a4c8601a\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/utils.js\":\"a5f8e6b822795c7f\",\"/knowledge-medium/pr-preview/pr-1833/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1833/src/sw/bootStore.js\":\"36af663da0f028b8\",\"/knowledge-medium/pr-preview/pr-1833/src/sw/previewDatabases.js\":\"4b295eaa2b4e7c9f\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/byteTransform.js\":\"e7137e29af4eede7\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/attachmentCleaner.js\":\"958d0f49ec82388c\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/attachmentParts.js\":\"853546c8301417db\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/bundleParts.js\":\"f7432e9bc24259dd\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/bundleRecord.js\":\"ddfd93260bfcda91\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/manifest.js\":\"e647cf89891069e8\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/takeBundle.js\":\"68e9f04f80538cac\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/verifyBundle.js\":\"63223b40b877cdf9\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/cleaningStage.js\":\"367d7448e49d97e5\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/conversionKey.js\":\"b76356f7c67aaec6\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/conversionServer.js\":\"1485b2774405e1b0\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/flip.js\":\"780505fc48b488c2\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/flipAttempts.js\":\"f957e0610dbe51b7\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/pages.js\":\"0963f69696f76ada\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/preflight.js\":\"318022c845543f18\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/reseal.js\":\"14da2f27436bb723\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/runConversion.js\":\"0ed825e231f25819\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/runLock.js\":\"f9a118b771426501\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/sealing.js\":\"2eb57836e3ae68b5\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/sealingStage.js\":\"b2741edee3f76905\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/stage.js\":\"295b346720a74d87\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/verifyReseal.js\":\"d494f1cf3fd3f0a1\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/aad.js\":\"a17ab2d14f448f94\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/aead.js\":\"6ffd3068c627c69a\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/base32.js\":\"d1c6fd0253261d3d\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/base64url.js\":\"f10413c005b241f1\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/binaryEnvelope.js\":\"a320dcf96a43aec2\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/byteAead.js\":\"9be7d6478536126f\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/canary.js\":\"188ab924e83ec209\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/contentHash.js\":\"168ce93640233b95\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/contentKey.js\":\"a6010660154ff12e\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/derivedIdNamespace.js\":\"f7020139458cc3f7\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/envelope.js\":\"5d697fecc03d27a7\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/hex.js\":\"08ab90013ef92c3f\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/sha256Hex.js\":\"93daa33f4b950705\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/workspaceKey.js\":\"e9bedb8f0abb71c2\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/conversionState.js\":\"ed1908517f4684a5\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9377c7725c631e1d\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/flows/pastedKey.js\":\"0652aa90bf853813\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ba70dca4a4b9fe24\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b65368f464067575\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/keyStore.js\":\"0b8b20d053e9872a\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/mintWorkspaceKey.js\":\"f82e832d24b43e33\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/modePin.js\":\"717fcdfaec1d3585\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/openWorkspaceKeys.js\":\"f1a34009cb88b960\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/resolveWorkspaceEntry.js\":\"30831e22cb20d4d4\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/resolver.js\":\"74f9b3d7f81a198c\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/workspaceAccess.js\":\"0e6d8b0081c2778c\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/transform.js\":\"045fbab949cc9e46\",\"/knowledge-medium/pr-preview/pr-1833/src/themeBootDefaults.js\":\"3fccc4e4b8897d83\",\"/knowledge-medium/pr-preview/pr-1833/src/types.js\":\"45e7648d6c023f91\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/ClientLocalSettings.js\":\"32c79fe13594e6bb\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/abortableSleep.js\":\"7aa2841cb59e4991\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/array.js\":\"f3716cf198718480\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/backlinkAutocomplete.js\":\"714b579d71d2eb10\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/blockCrumbs.js\":\"b47f68bb2e857239\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/blockrefAutocomplete.js\":\"232a07eae743ff04\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/cadencedIdleJob.js\":\"f406cff69298f31f\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/callbackSet.js\":\"650cb551a6826213\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/clientId.js\":\"ae4278502bfdb2e4\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/codemirror.js\":\"8a49fb17ee9161ff\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/codemirrorCompletion.js\":\"77cac930e4f09839\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/copy.js\":\"615a66c393266adc\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dailyPage.js\":\"d3119e2409dd4086\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dbForensics.js\":\"f54573b7d2dff74f\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dbForensicsHooks.js\":\"7d8685632340cc31\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/deleteBlockThroughUi.js\":\"75911715550b1580\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dialogs.js\":\"22d782318937e16f\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dom.js\":\"932ce5993d3dc87b\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/downloadBlob.js\":\"eec437714f98add4\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/exportSqliteDb.js\":\"2a4df7f4ffd63660\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/fileSystemAccess.js\":\"2efaf31baf772c69\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/flipSlide.js\":\"00ec82682355bb80\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/fnv1a.js\":\"415f7f308ddc1965\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/formatBytes.js\":\"9e5608c90a36ba0d\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/fuzzyRank.js\":\"cfdcf0fed84c8685\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/idbKeyedStore.js\":\"8dadeda694fd979c\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/idleCallbackPolyfill.js\":\"b71766e39166ee4a\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/keyboardAwareScroll.js\":\"f6e938f8b9da3d01\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/keyboardViewport.js\":\"04500cfe528ad09f\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/lastWorkspace.js\":\"97f05b742a4ce369\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/layoutColumns.js\":\"8146aeb4e4556fde\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/layoutSessionDom.js\":\"cc652f43df01edad\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/layoutSessionId.js\":\"e4f090666ae58557\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/linkClickGestures.js\":\"d544ed5fa0e214ce\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/linkTargetAutocomplete.js\":\"5e455a92ba7f25bf\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/localDbCorruption.js\":\"72bb8d98622c0f50\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/localDbRecovery.js\":\"24a54709569642c7\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/markdownParser.js\":\"f1c163a805928b54\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/memoize.js\":\"8b6209b7e873e05f\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/nameFieldCommit.js\":\"c81ccc189c499fa9\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/nameList.js\":\"747f85c42a925725\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/navigation.js\":\"c757612760ade2f0\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/omnilinerNamespace.js\":\"d1e8efd20b1fe5e6\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/opfsPageScan.js\":\"6d3f665edf8e041b\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelClearance.js\":\"4cc7ad8ef5502d1e\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelHistory.js\":\"8fff35b3680936f8\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelLanes.js\":\"6d87da6f7e8cfa76\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelLayoutProjection.js\":\"6f1552ce7988bff2\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelScrollAnchor.js\":\"ab734b73301b29b3\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelUrlFlags.js\":\"8ee3fdbb9f8fedbf\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/platform.js\":\"d628828451c43eb1\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/pluralize.js\":\"def8e90725388cff\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/propertyCreation.js\":\"ab9b209a63deb976\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/propertyNavigation.js\":\"9a8c5ce106f37078\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/propertyValueContext.js\":\"f6921e7a7def5a61\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/react.js\":\"e92863604ec58a27\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/relativeDate.js\":\"ae95f67e30fe1d6c\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/relativeTime.js\":\"d3fc81e772f81be6\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/renderScope.js\":\"1b7d8c65d77388ba\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/resolvedThenable.js\":\"98c2d7e19cb2f22b\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/routing.js\":\"e764478f2c274421\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/safeMode.js\":\"11ab58dcd38f8d29\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/scheduleIdle.js\":\"d36e715934fc1b26\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/screenWakeLock.js\":\"66070c46331ef849\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/selection.js\":\"fe11d39956474d68\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/softKeyboardGrab.js\":\"3a10dad513f08b41\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/startupTimeline.js\":\"d54c40a2005aad39\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/state.js\":\"ea30840c5abd206b\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/string.js\":\"a39afd48eb520e25\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/surfaceZoom.js\":\"ffa5eddfdf8eaf11\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/time.js\":\"8248d63d65bfa0fd\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/toast.js\":\"ef41fccb7459f726\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/toggleStore.js\":\"f7976bb04856a598\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/untilStopped.js\":\"5cf1eb28983690a3\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/userActivity.js\":\"ab188d761bd26474\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/viewTransition.js\":\"c6c6af6e323e0cd0\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/viewport.js\":\"e02482f6dbf03d04\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/webLock.js\":\"f39591efa596eb5f\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/workspaceRecovery.js\":\"c42e49355ac20d6a\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/workspaceSnapshotStore.js\":\"76da1b41d16f5a6a\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-compiler-runtime.js\":\"9bc4792f12e22fb4\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-client.js\":\"834dc20374b1fa62\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-server-edge.js\":\"982b7882f993e73f\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-server.js\":\"91a902a05140dd36\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-static-edge.js\":\"a0863be60e985a46\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-static.js\":\"377c5f5409df873d\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-test-utils.js\":\"fa57ceb95e450504\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom.js\":\"37bacd77f8f41f4c\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-jsx-runtime.js\":\"e9210762ac5a6a36\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react.js\":\"91452cdf34bdaca8\",\"/knowledge-medium/pr-preview/pr-1833/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1833/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1833/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
