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
		buildId: "67459e19067e-33007530",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1833/\":\"3f763c845fa6db56\",\"/knowledge-medium/pr-preview/pr-1833/index.html\":\"3f763c845fa6db56\",\"/knowledge-medium/pr-preview/pr-1833/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1833/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1833/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1833/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1833/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1833/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1833/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1833/assets/FacadeVFS-Cy6NV650.js\":\"5c235461412ddeff\",\"/knowledge-medium/pr-preview/pr-1833/assets/OPFSCoopSyncVFS-e2Cr5cjo.js\":\"988b967e8cf54219\",\"/knowledge-medium/pr-preview/pr-1833/assets/OPFSWriteAheadVFS-DYuqi9Vz.js\":\"31cc522d037d8a43\",\"/knowledge-medium/pr-preview/pr-1833/assets/wa-sqlite-BebPuM88.js\":\"4ab7a0e74d2ddfe4\",\"/knowledge-medium/pr-preview/pr-1833/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1833/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1833/assets/wa-sqlite-async-T0rg4MvB.js\":\"6df1d770840b980c\",\"/knowledge-medium/pr-preview/pr-1833/assets/worker-DfYZPYDS.js\":\"009015aed78a4f38\",\"/knowledge-medium/pr-preview/pr-1833/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1833/chunks/app-BKvgOJ9b.js\":\"8eb56910c1cf4281\",\"/knowledge-medium/pr-preview/pr-1833/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1833/index.js\":\"faa7f3f30e469fe0\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1833/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1833/assets/AccessHandlePoolVFS-DwH_GV7a.js\":\"90c8a33f49084922\",\"/knowledge-medium/pr-preview/pr-1833/assets/IDBBatchAtomicVFS-DLu-VbNT.js\":\"dda0d0c2f06f4872\",\"/knowledge-medium/pr-preview/pr-1833/assets/MemoryVFS-DTNKysUw.js\":\"ca56e0ad803fbfc7\",\"/knowledge-medium/pr-preview/pr-1833/assets/mc-wa-sqlite-CTPLIJAk.js\":\"0f3c1e202329f2d2\",\"/knowledge-medium/pr-preview/pr-1833/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1833/assets/mc-wa-sqlite-async-DgVI5R1_.js\":\"f3517d4145fd4b9f\",\"/knowledge-medium/pr-preview/pr-1833/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1833/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1833/chunks/AccessHandlePoolVFS-DEjTpbfY.js\":\"b49100ac972d9f08\",\"/knowledge-medium/pr-preview/pr-1833/chunks/FacadeVFS-BDkSX9Wh.js\":\"8b2a7d8e2da443b1\",\"/knowledge-medium/pr-preview/pr-1833/chunks/IDBBatchAtomicVFS-BJmU0OBD.js\":\"1a707299ac03c262\",\"/knowledge-medium/pr-preview/pr-1833/chunks/MemoryVFS-IT9FiLfR.js\":\"0acfebd9966e5676\",\"/knowledge-medium/pr-preview/pr-1833/chunks/OPFSCoopSyncVFS-Cgt6xb7V.js\":\"8bca014f2705fee3\",\"/knowledge-medium/pr-preview/pr-1833/chunks/OPFSWriteAheadVFS-CFTjl06D.js\":\"f094d1ad3f38fa14\",\"/knowledge-medium/pr-preview/pr-1833/chunks/Preview-UcNOD7KI.js\":\"c60bba06c81228cb\",\"/knowledge-medium/pr-preview/pr-1833/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1833/chunks/card-Cg1dklUc.js\":\"44150ef6279f3b66\",\"/knowledge-medium/pr-preview/pr-1833/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1833/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1833/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1833/chunks/dist-fdAa4pEs.js\":\"f473219931388b55\",\"/knowledge-medium/pr-preview/pr-1833/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1833/chunks/mc-wa-sqlite-async-BZGJCIjC.js\":\"b4368ff208cdeef2\",\"/knowledge-medium/pr-preview/pr-1833/chunks/mc-wa-sqlite-xWRITJux.js\":\"8065f514a24f42fc\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-0B4j90nu.js\":\"1f20ba194b0734dd\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-B11Y2iFb.js\":\"044f8682c7030ea2\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-BPB2F7Bi.js\":\"f62a6d081e5e5214\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-C7GmKVmB.js\":\"c97fa04133b77679\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-DjANFQwH.js\":\"7ee5e0e03f2a867e\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-DkAQf1q6.js\":\"dfee4324d87d8071\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-DlxKfZKr.js\":\"d2d5db90a8b14394\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-N8_UldAD.js\":\"19675d649a3742b9\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-dom-server-legacy.browser.production-Dkuc8IDK.js\":\"1cd30cd88c7d43e4\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-dom-server.browser.production-BvYaSZpq.js\":\"f285d255202f9514\",\"/knowledge-medium/pr-preview/pr-1833/chunks/react-dom-server.edge.production-BAnQSAOa.js\":\"bdc105b196585a60\",\"/knowledge-medium/pr-preview/pr-1833/chunks/server.browser-D8zK9TtT.js\":\"6090a95a4f529aac\",\"/knowledge-medium/pr-preview/pr-1833/chunks/textarea-C-nI4LO9.js\":\"aa64866364c52d6e\",\"/knowledge-medium/pr-preview/pr-1833/chunks/ui-CCG197rK.js\":\"a16fe46c5211f5c0\",\"/knowledge-medium/pr-preview/pr-1833/chunks/wa-sqlite-async-BZYkzS6A.js\":\"fbe5c2c812799c76\",\"/knowledge-medium/pr-preview/pr-1833/chunks/wa-sqlite-jk4_c3fa.js\":\"e70d19ca698fcf89\",\"/knowledge-medium/pr-preview/pr-1833/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1833/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1833/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1833/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1833/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1833/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1833/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1833/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1833/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1833/src/App.js\":\"8c214c0a779620e4\",\"/knowledge-medium/pr-preview/pr-1833/src/appUpdate.js\":\"648c37302ebcf2d6\",\"/knowledge-medium/pr-preview/pr-1833/src/appVersion.js\":\"cd9d8f5a704ce33a\",\"/knowledge-medium/pr-preview/pr-1833/src/bootstrap/initialLayout.js\":\"ce826c2f7dc44d6e\",\"/knowledge-medium/pr-preview/pr-1833/src/bootstrap/openWorkspaceData.js\":\"8094d6cb778e50b0\",\"/knowledge-medium/pr-preview/pr-1833/src/bootstrap/resolveWorkspace.js\":\"febb5294d12198c9\",\"/knowledge-medium/pr-preview/pr-1833/src/bootstrap/workspaceBootstrap.js\":\"f56541f39e6f108d\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockComponent.js\":\"945cb63734643c9c\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockCrumbs.js\":\"54171956de7e1713\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockEditor.js\":\"cad3f1446a9fdc29\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockLoadingPlaceholder.js\":\"a564fd34e02f0fdb\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockProperties.js\":\"07f95f90998518c8\",\"/knowledge-medium/pr-preview/pr-1833/src/components/BlockSearchPicker.js\":\"50160b4712e74dbe\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ConfirmBulkDeleteDialog.js\":\"3b936f8fb930d378\",\"/knowledge-medium/pr-preview/pr-1833/src/components/DividerHandle.js\":\"8279f73ccb7b6563\",\"/knowledge-medium/pr-preview/pr-1833/src/components/DraftEditor.js\":\"1a5840c83fbbb49e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/GutterPill.js\":\"cf07e78564e57250\",\"/knowledge-medium/pr-preview/pr-1833/src/components/Header.js\":\"043cd8aa48c1b37d\",\"/knowledge-medium/pr-preview/pr-1833/src/components/LazyBlockComponent.js\":\"a96b2a51e40b08b7\",\"/knowledge-medium/pr-preview/pr-1833/src/components/Login.js\":\"5ef30132bfa635dd\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ZoomableSurface.js\":\"ef992301095e6073\",\"/knowledge-medium/pr-preview/pr-1833/src/components/editModeKeepalive.js\":\"9608217d5c5020a4\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0dcb82038cfad78f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"aefc0598be198f6b\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/RefPropertyEditor.js\":\"9f133b373c78f816\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/RefTargetTypePicker.js\":\"ef1a057dae112060\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/SelectPropertyEditor.js\":\"128941ad654e5918\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/TypesPropertyEditor.js\":\"14aca99e2c31cd52\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/defaults.js\":\"9d1a9797e7aba841\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/kernelValuePresets.js\":\"c98f9e7884ed8f63\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/selectablePresets.js\":\"7f577283fefbc6cc\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyEditors/typesPropertyUi.js\":\"4a5f2896842d2f57\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/AddPropertyForm.js\":\"617825d72e21b15a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/PropertyPicker.js\":\"7da6afafa6a0d550\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/PropertyRow.js\":\"e3156cdc53896498\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/Rows.js\":\"3b3116cf4f1850e8\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/actions.js\":\"ee5c9c830cf2f5a4\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/declarationOnly.js\":\"7423088d3b897cb8\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/layout.js\":\"892e0b1b29891008\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/model.js\":\"dde39acba176322a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/shapeUi.js\":\"cb0aa0c4f150e704\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/shapes.js\":\"69844d381de14e7e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/usePropertyEditingActivation.js\":\"409a37784f4d7fa8\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanel/visibility.js\":\"681fbb6cf94d3947\",\"/knowledge-medium/pr-preview/pr-1833/src/components/propertyPanelSections.js\":\"e54ed37e572a0392\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/BlockEmbed.js\":\"b3de21bf66c4834e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/BlockLink.js\":\"d0ec54407d032c3b\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/BlockRef.js\":\"8cc1ba1891cb5114\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/ReferenceLink.js\":\"d12eacab8826a7ba\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/cycleGuard.js\":\"e9873b9dc04dea90\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/cycleGuardContext.js\":\"ac69cd2871d1eb0a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/linkInteraction.js\":\"e963b162d3798fb8\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/referenceLayout.js\":\"255f1d39ffdb51bd\",\"/knowledge-medium/pr-preview/pr-1833/src/components/references/useBlockRefAncestors.js\":\"99ce7bb2eda19020\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/BlockGutter.js\":\"a625cc5360273a55\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/BlockInfoDialog.js\":\"406bcec9d44fccee\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/BlockTypeBlockRenderer.js\":\"84fc54562d5e546e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/BulletHoverCard.js\":\"967b340c91e90611\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/CodeMirrorContentRenderer.js\":\"8e91137c750ad7d7\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fd251fca7cbf1cd2\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/ColumnResizeHandles.js\":\"242303f152249cc0\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f00b506bcb001349\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/DefaultBlockRenderer.js\":\"5230462ed6a6fa9b\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/LayoutRenderer.js\":\"6bd3b0b90d4d40ee\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/MarkdownContentRenderer.js\":\"2f5f7bf111cb792c\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/MissingDataRenderer.js\":\"b67f6db9deb14bbc\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/PanelRenderer.js\":\"80a864dc899d1478\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c65bc06c7c4551c4\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/TopLevelRenderer.js\":\"27fa8cccd6d892d3\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/blockGutterMode.js\":\"dfa60adc02429a6f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/blockTitleText.js\":\"0e3b19c3b39dce79\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/fieldCreationKeydown.js\":\"0489777dd82667be\",\"/knowledge-medium/pr-preview/pr-1833/src/components/renderer/layoutRootContext.js\":\"a4f8eaedba19bf5f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/typeChip/TypeChip.js\":\"bd693db245022157\",\"/knowledge-medium/pr-preview/pr-1833/src/components/typeChip/chipStyle.js\":\"63e0760221a1eeec\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/anchored-floating.js\":\"d0e2d168faa5c77b\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/button.js\":\"d6b8e26dcf01a68a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/card.js\":\"078215e110ae0e2b\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/checkbox.js\":\"b814e21efe29494d\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/collapsible.js\":\"e39807999958a620\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/command.js\":\"4345e889242c3547\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/context-menu.js\":\"2bbf9a93c0b0e401\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/dialog.js\":\"e52fbe4ae1cdf828\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/dropdown-menu.js\":\"ac68a28da1854a3a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/floating-listbox.js\":\"3caa4b40b13eaebd\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/index.js\":\"176766f95608c9ae\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/input.js\":\"9f16780aba3ac80f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/kbd.js\":\"9d7ed7e43541ca0d\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/label.js\":\"ab536818f69de91c\",\"/knowledge-medium/pr-preview/pr-1833/src/components/ui/textarea.js\":\"adf0dd52df509980\",\"/knowledge-medium/pr-preview/pr-1833/src/components/useEditModeYieldKeepalive.js\":\"6b7b4402346d6f1b\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/BootFallback.js\":\"92145b28061d2691\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/FocusedRowLazyMount.js\":\"8d7166c8dbb0973f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/LazyViewportMount.js\":\"826c6362f19e2809\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/LocalDbCorruptionFallback.js\":\"b3dbeed1adab8491\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/error.js\":\"c0fdcdeff2a2f4a0\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/lazyMountRegistry.js\":\"0e249d028e64f84e\",\"/knowledge-medium/pr-preview/pr-1833/src/components/util/suspense.js\":\"b7c03e1afbb2aa26\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/CreateWorkspaceDialog.js\":\"59dc7f6410a2f1b5\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/PendingInvitations.js\":\"269eef145bafa410\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/SyncProgress.js\":\"59976011ff736d78\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/UnlockProgress.js\":\"b980d2f315e8b11f\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/WorkspaceKeyGate.js\":\"b1a8c725e5d3c0c5\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/WorkspaceSettingsDialog.js\":\"4a5ed26591b781c3\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/WorkspaceSwitcher.js\":\"1f61bc58d611b330\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/WorkspaceSyncGate.js\":\"98d76cccdf2915fc\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/ConversionFlow.js\":\"58bf70b3b3b439a3\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/ConversionFlowHost.js\":\"51a2560904b32119\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/EncryptionSection.js\":\"39d45cd5303ac59a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/attachmentPrompts.js\":\"b490daa8fba6ac58\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/bundleFolderPrompts.js\":\"af79ae6a1bc00092\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/conversionFlowDeps.js\":\"b5d8c7dc23d9bdc8\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/conversionFlowStore.js\":\"049749797940342a\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/flowUi.js\":\"b2c1d94eb56ed518\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/conversion/useConversionRun.js\":\"40de5d97a58b8b26\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/keyUi.js\":\"4338f9db2e6ee7f5\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/useCloseOnKeyLoss.js\":\"8645623d698dfe41\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/useCloseOnServerE2ee.js\":\"3f6006675f97fc4c\",\"/knowledge-medium/pr-preview/pr-1833/src/components/workspace/workspaceUnlocked.js\":\"000d04ab9ba5105e\",\"/knowledge-medium/pr-preview/pr-1833/src/context/backgroundSubtree.js\":\"eb52a45a75894f6d\",\"/knowledge-medium/pr-preview/pr-1833/src/context/block.js\":\"7d6b12f66dcf7857\",\"/knowledge-medium/pr-preview/pr-1833/src/context/layoutWsContext.js\":\"0ce4f4a0b522b903\",\"/knowledge-medium/pr-preview/pr-1833/src/context/propertyDisplay.js\":\"740e4a2cf9eeb8a6\",\"/knowledge-medium/pr-preview/pr-1833/src/context/repo.js\":\"f8b43f86d7a529b8\",\"/knowledge-medium/pr-preview/pr-1833/src/data/aliasClaim.js\":\"0cd85260c12657b9\",\"/knowledge-medium/pr-preview/pr-1833/src/data/aliasSeatNamespace.js\":\"49a1f9e375c29c3b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/blockData.js\":\"cf41f944f6369266\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/blockType.js\":\"439bab8b85ce1d79\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/changeScope.js\":\"4db99538dffdd16f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/codecs.js\":\"e6951baa16b6c0bf\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/derivedData.js\":\"6fedb7e4725bee6d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/errors.js\":\"5b568b23e0ce6545\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/events.js\":\"fe8468558b1d389b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/handle.js\":\"ae169b3a102edfb1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/index.js\":\"628485c09a13712d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/mutator.js\":\"8e938aebb7a1d26e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/processor.js\":\"ea25d2b06d56c2b0\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/propertySchema.js\":\"3fd8766f9b052b0d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/query.js\":\"fd0277f39f93776e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/sameTxProcessor.js\":\"7fbce7a0fa5a2040\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/schema.js\":\"ae169b3a102edfb1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/tx.js\":\"ae169b3a102edfb1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/typedBlockQuery.js\":\"8b3b3ed269272646\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/user.js\":\"97a29e5500a629d4\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/valuePresetCore.js\":\"bfe50c2424fd4d48\",\"/knowledge-medium/pr-preview/pr-1833/src/data/api/valuePresets.js\":\"c9d20bdd4910d0b4\",\"/knowledge-medium/pr-preview/pr-1833/src/data/attachmentCleanerIOVerb.js\":\"2049bc8316dbadce\",\"/knowledge-medium/pr-preview/pr-1833/src/data/block.js\":\"37348b1b6caa0d80\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockCache.js\":\"9ebab26baeabc0b6\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockId.js\":\"fb40684601c38eef\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockLiveness.js\":\"ce938064e212fb05\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockMerge.js\":\"823e9c78e998a6c6\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockSchema.js\":\"b61e1060292ec7c5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockTypeLookup.js\":\"aa4d4aa7acd19dc2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/blockTypes.js\":\"305b447c6a83e8e3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/clientContext.js\":\"9d26ed463759ee36\",\"/knowledge-medium/pr-preview/pr-1833/src/data/dbFileSiblings.js\":\"21a9e8ed7df58047\",\"/knowledge-medium/pr-preview/pr-1833/src/data/definitionSeeds.js\":\"aa0d3db7cc6a8d31\",\"/knowledge-medium/pr-preview/pr-1833/src/data/derivedIds.js\":\"bcabf073927d73a9\",\"/knowledge-medium/pr-preview/pr-1833/src/data/drawnSubtree.js\":\"0b4d972b1d922732\",\"/knowledge-medium/pr-preview/pr-1833/src/data/facetBridge.js\":\"c48f7e3a1642e299\",\"/knowledge-medium/pr-preview/pr-1833/src/data/facets.js\":\"96fdf3fc172c5709\",\"/knowledge-medium/pr-preview/pr-1833/src/data/globalState.js\":\"50c81957c5f2d07d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/aliasClaimRederiveProcessor.js\":\"175d1a265195b47a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/ancestorBatch.js\":\"bf25b157b5cbe043\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/blockTypeTypeifyProcessor.js\":\"67a73aec2424b2c2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/clientSchema.js\":\"c2a50530a794530e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/commitPipeline.js\":\"8629a4a136d4a80b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/devAssertions.js\":\"4159d04c1a577dd9\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/firstSync.js\":\"d92905d3b9c71b2a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/freshInitialLoad.js\":\"2eb4538e807847cd\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/graphBackfillClaim.js\":\"a49736f6f24ce42f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/handleStore.js\":\"6bf325db78fc34f3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/idleMarkerJobs.js\":\"79858d192923d3f5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/initialDownload.js\":\"eeceb56555d0f4ac\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/initializeClientDatabase.js\":\"76212e2f02dd6b03\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/jsonCanonical.js\":\"3a4b064e6bfa0245\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/kernelInvalidation.js\":\"f52c24508adedfa4\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/kernelProcessors.js\":\"59a3b7b534fa1e77\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/kernelQueries.js\":\"fd8495ac951e60e5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/mergeTypeMembershipProcessor.js\":\"23382d23eda272c7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/normalizeReferencesProcessor.js\":\"8bb3fe3e94fbe78d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/poolInstrumentation.js\":\"1a5ae831ed4c8c62\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/processorRunner.js\":\"5903926169d968d7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyCellBackfill.js\":\"61925dfdc99e4317\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyChildMint.js\":\"b453a12d2a1368cf\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyChildrenProcessor.js\":\"27be356754d31655\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyDefinitionChangeProcessor.js\":\"ce7f9e029b86afa1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyDefinitionSynthesis.js\":\"aa7feaa93dd39c36\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyKeyScan.js\":\"79df14324bee4807\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertySchemaResolution.js\":\"a6578247483a6fad\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/propertyValueEdits.js\":\"8759fe0dcc251e4d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/raiseProtocol.js\":\"a3a8565c008c782e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/readBatch.js\":\"8f413595f27c82af\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/refProjection.js\":\"8e76a4e7a4f8b0d0\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/referenceTargetLookups.js\":\"764deaed50e7489b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/referenceTargetProcessor.js\":\"a812cfddbc7a600b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/replayMerge.js\":\"699d0cd0a9da6909\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/sqlBinds.js\":\"d9be835f9bb7a96a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"26a15923a8d1a0f3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/arrivalProcessors.js\":\"5ac49f999d73a03b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/invalidate.js\":\"f70dee4d3f6afccc\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/materialize.js\":\"ebde0f54b095b8ed\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/observer.js\":\"750e205ccc55b66f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/syncObserver/reconcile.js\":\"202293f084526af7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/timingMetrics.js\":\"a61b21a11781fdcd\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/treeQueries.js\":\"150671e400e18573\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/txEngine.js\":\"a01cc01cc2a1c378\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/txSnapshots.js\":\"53f35a48673ad1f1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/typedBlockQuery.js\":\"76ea476a5a75d141\",\"/knowledge-medium/pr-preview/pr-1833/src/data/internals/undoManager.js\":\"b5b740bb17858774\",\"/knowledge-medium/pr-preview/pr-1833/src/data/invalidation.js\":\"87af77aef08a499f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/kernelDataExtension.js\":\"cb29ceb547909a4e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/kernelPage.js\":\"b647f4e391735b81\",\"/knowledge-medium/pr-preview/pr-1833/src/data/kernelValuePresetCores.js\":\"a7c3e9a8cd8e4d94\",\"/knowledge-medium/pr-preview/pr-1833/src/data/localDbCorruptionSignal.js\":\"e036e2074c36d6f3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/localDbStorage.js\":\"33998b6bcd4568d5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/localDbVfs.js\":\"0fa0099fef269db6\",\"/knowledge-medium/pr-preview/pr-1833/src/data/localSchema.js\":\"81ff964cea6e1b54\",\"/knowledge-medium/pr-preview/pr-1833/src/data/maintenance.js\":\"45b21109a98acad7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/mergeProperties.js\":\"8b0e8132c0cdf36f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/metricsConsoleHook.js\":\"d2c03342f1e60eae\",\"/knowledge-medium/pr-preview/pr-1833/src/data/migrationsPage.js\":\"4e85b928c5c0c182\",\"/knowledge-medium/pr-preview/pr-1833/src/data/mutators.js\":\"d3238e8cb47b1191\",\"/knowledge-medium/pr-preview/pr-1833/src/data/orderKey.js\":\"cd354c5ec58414d3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/orderKeyPlacement.js\":\"3d74728fba45bf52\",\"/knowledge-medium/pr-preview/pr-1833/src/data/outlineSurface.js\":\"12b951a8650d1143\",\"/knowledge-medium/pr-preview/pr-1833/src/data/pendingEditorContent.js\":\"5138561237113bf9\",\"/knowledge-medium/pr-preview/pr-1833/src/data/pendingUploadsSql.js\":\"d80c7d0cc77da2f2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/pluginStateExtensions.js\":\"47da09089edb42df\",\"/knowledge-medium/pr-preview/pr-1833/src/data/powerSyncLogger.js\":\"caace03af0f19af5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/projectorRuntime.js\":\"68d57300e35c60ff\",\"/knowledge-medium/pr-preview/pr-1833/src/data/properties.js\":\"9e329cd1e538bd6f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertiesPage.js\":\"5459d84f38cb4ae6\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyChildren.js\":\"e8a2845732a8488e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyDefinitionFanout.js\":\"ac1cd9680b634cdf\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyDefinitionMetadata.js\":\"0c361f6b22c1e43f\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyDefinitionRegistry.js\":\"f63283e3f33f66b7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyDisplayMode.js\":\"b6f772768e90769e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertyRowCreation.js\":\"5b59b61f7a46ba32\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertySchemaCreation.js\":\"9ad10a5a92d0f396\",\"/knowledge-medium/pr-preview/pr-1833/src/data/propertySeeds.js\":\"06b417eaabe4a0a7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/recentsPage.js\":\"568f16f834ef4164\",\"/knowledge-medium/pr-preview/pr-1833/src/data/referenceBlock.js\":\"4d38045ecb1db5b7\",\"/knowledge-medium/pr-preview/pr-1833/src/data/rejectedUploads.js\":\"83cebf38d3ba0d40\",\"/knowledge-medium/pr-preview/pr-1833/src/data/releasePowerSyncConnection.js\":\"a1bf668d8a30583c\",\"/knowledge-medium/pr-preview/pr-1833/src/data/repo.js\":\"0f8f107297eed569\",\"/knowledge-medium/pr-preview/pr-1833/src/data/repoProvider.js\":\"01d4eec025b85890\",\"/knowledge-medium/pr-preview/pr-1833/src/data/rowProperty.js\":\"aae108aa333a0658\",\"/knowledge-medium/pr-preview/pr-1833/src/data/searchFilter.js\":\"efae90cc14e694dd\",\"/knowledge-medium/pr-preview/pr-1833/src/data/seedIdentityLedger.js\":\"ed5b8e61637e8833\",\"/knowledge-medium/pr-preview/pr-1833/src/data/stateBlocks.js\":\"59c98a7c5a69d8e2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/structuralEditPolicy.js\":\"44fa4ef6df65507a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/subtreeDelete.js\":\"283398da8cc7d8f3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/syncStreamLock.js\":\"ef420e973e068c46\",\"/knowledge-medium/pr-preview/pr-1833/src/data/syncedTableSqlRecognizer.js\":\"e05ae383b299369e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/syncedTableWriteGuard.js\":\"279b0e8d9ca60ed8\",\"/knowledge-medium/pr-preview/pr-1833/src/data/targets.js\":\"df5e4d9de3b2ede2\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeColors.js\":\"b57d67b6e46ca2ad\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeDefinitionMetadata.js\":\"0de20a52cc91cf0b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeDefinitionRegistry.js\":\"42e0ee9d5786fe46\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeExtraction.js\":\"63dad9a3bf8c1d88\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeInitialValues.js\":\"e54c69fe6f64f6ae\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typePropertyGroups.js\":\"1abaea1ec7005bc4\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeSeeds.js\":\"b0ad79e1ec92e0e9\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typeTagger.js\":\"0d11fc008e6fae5e\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typedRecords.js\":\"8b5f4b2c12eed0d6\",\"/knowledge-medium/pr-preview/pr-1833/src/data/typesPage.js\":\"78b683e313db5945\",\"/knowledge-medium/pr-preview/pr-1833/src/data/userPrefs.js\":\"eabe5411a5383cc1\",\"/knowledge-medium/pr-preview/pr-1833/src/data/userSchemasService.js\":\"2ced5d4572f3a386\",\"/knowledge-medium/pr-preview/pr-1833/src/data/userTypesService.js\":\"6ca5d9d31fa99622\",\"/knowledge-medium/pr-preview/pr-1833/src/data/valuePresetRegistry.js\":\"69ba122bae2547c5\",\"/knowledge-medium/pr-preview/pr-1833/src/data/visibleChildren.js\":\"09809b5e9b56822b\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaceConversion.js\":\"bb83f80ffc3f50fb\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaceFirstSync.js\":\"ed5f3501b58819e3\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaceIdNamespace.js\":\"fac6be7579461e2a\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaceSchema.js\":\"d2d2ae6bf93b034d\",\"/knowledge-medium/pr-preview/pr-1833/src/data/workspaces.js\":\"5eb21df14ea89d13\",\"/knowledge-medium/pr-preview/pr-1833/src/data/writeAheadLog.js\":\"8109754d61ee10e0\",\"/knowledge-medium/pr-preview/pr-1833/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/BlockPasteShellDecorator.js\":\"b3ed491ed1fe141a\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/atTrigger.js\":\"4362d67838a9b639\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/autocomplete.js\":\"d22862fb9c8c0d65\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/codeMirrorExtensions.js\":\"10530928cf67b83f\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/contentFlush.js\":\"e36e856c8d7fd2b8\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/defaultInteractions.js\":\"c85e20ab1e1f1249\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/editSettleSignal.js\":\"3430bfa5f2223b8b\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/insertImage.js\":\"aee4245ffd7ec5c4\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/referenceCompletionRange.js\":\"854346b56ac71e4b\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/referenceTargetTypes.js\":\"5f101ce5727d4741\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/syntaxContext.js\":\"10317ec4dc4d2cbb\",\"/knowledge-medium/pr-preview/pr-1833/src/editor/triggerMatch.js\":\"36b65ee451716b43\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/AppRuntimeProvider.js\":\"3d17a340d730b614\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/BlockFocusShellDecorator.js\":\"f30ed1d098d713cd\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/ExtensionRenderBoundary.js\":\"75db1b4111cd5e13\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/PanelContentRecovery.js\":\"60a9c92583b64162\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/apiCatalog.js\":\"d523016bfc0ea860\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/approveExtensionHere.js\":\"797318e37b9c4ae6\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/armedCutAppMount.js\":\"58841c21ad6c6282\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/batchableKeyedStore.js\":\"78f0e1d7497e45b0\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/blockInteraction.js\":\"3a062bc10adb9619\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/blockSelectionAction.js\":\"137b130e268a2f43\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/compileExtensionModule.js\":\"20ef6967a9ceb663\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/compiledModuleCache.js\":\"d6907fe11000d067\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/continuousGestures.js\":\"deeb7ff313a1b94e\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/core.js\":\"f6f96f070d689b31\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/defaultRenderers.js\":\"7386379cd5d94953\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/definitionFanoutAppMount.js\":\"321d3878b68587af\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/dialogAppMount.js\":\"f3a127de5d8abed5\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/dynamicExtensionSeeds.js\":\"4b4025d97c4ae412\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/dynamicExtensions.js\":\"81af8810c6105179\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/exampleExtensions.js\":\"563e1e671d2d263f\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionApprovalStatus.js\":\"b6689a032332e96a\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionLoadErrorToast.js\":\"d58af3bf81feb805\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionLoadErrors.js\":\"f12cd6af2559b050\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionLookup.js\":\"df2a46ee0c119623\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionToggles.js\":\"ce891e0a2b8b8770\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/extensionUtilitiesCss.js\":\"0dacb618934b7a93\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/kernelPageDeletionGuard.js\":\"a05a61db58f54e1c\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/liveRuntime.js\":\"f57b708b7b905ad5\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/openExtensionsSettings.js\":\"2742648941f79470\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/overridesCache.js\":\"7360c08e66991e83\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/pluginIds.js\":\"2f54027a0776e762\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/processorRejectionToast.js\":\"facff694cc990eb0\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/runtimeActions.js\":\"f24cf13db038966e\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/runtimeContext.js\":\"f552e869624d3076\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/staticAppExtensions.js\":\"6ae71f123ffa9656\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/staticDataExtensions.js\":\"14b4ba32ee49bdc8\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/toastAppMount.js\":\"c488858719cfceac\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/useOverrides.js\":\"17c12d05008f2f78\",\"/knowledge-medium/pr-preview/pr-1833/src/extensions/useShortcutSurfaceActivations.js\":\"933d5a855bac1f33\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/discoverToggleTree.js\":\"561ef241d6f41b3a\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/facet.js\":\"6e2eefe84b854980\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/resolveAppRuntime.js\":\"d35c149ca422f71f\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/runtimeEvents.js\":\"8041d765c76f71c3\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/togglable.js\":\"8a9be661f3edc2e0\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/variantFacet.js\":\"358fa0fd620076c0\",\"/knowledge-medium/pr-preview/pr-1833/src/facets/verbFacet.js\":\"674e9fe9dc9db3f6\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/block.js\":\"29f6aae977746a5f\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/focusedChild.js\":\"23298bc64fd899a3\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/propertySchemas.js\":\"765f5968c6b24fa9\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/typeRegistry.js\":\"d0b4188de8b8a54c\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useAncestorCrumbs.js\":\"ccfacc3cce2c6202\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useAutocompleteListbox.js\":\"a3ff5991b321c270\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useDebouncedSearch.js\":\"553da355012a54a7\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useDebouncedValue.js\":\"f10f364fe0a3fb0e\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useIsFocalRender.js\":\"192208e8459bfed7\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useIsReadOnly.js\":\"b1c0a5fbb1cbf534\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useMaterializeBacklog.js\":\"fc3f1082275e270e\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useMinuteClock.js\":\"23f06847003b85d1\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/usePanelLayoutProjection.js\":\"e4b61181b1339aa6\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/usePendingInvitations.js\":\"4c5bd8f63695a19d\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useRendererRegistry.js\":\"32c186c9139a4e34\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useRetainedFieldRows.js\":\"4b24a8baba836b6d\",\"/knowledge-medium/pr-preview/pr-1833/src/hooks/useWorkspaces.js\":\"3fe90e0d359589c1\",\"/knowledge-medium/pr-preview/pr-1833/src/lib/utils.js\":\"1e51ec777c91095e\",\"/knowledge-medium/pr-preview/pr-1833/src/main.js\":\"b8493bee8fdbd636\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/MarkdownImage.js\":\"50c03939203b832c\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/blockSeparators.js\":\"378a9d875b067da0\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/context.js\":\"eefa563e532b3eda\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/defaultMarkdownExtension.js\":\"04ba3dc3c7ee2988\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/extensions.js\":\"23a77bfa9755755e\",\"/knowledge-medium/pr-preview/pr-1833/src/markdown/renderMarkdownHtml.js\":\"e7ebf2632329985f\",\"/knowledge-medium/pr-preview/pr-1833/src/minimal-editor.js\":\"68ed616b6284c70e\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/armedCut.js\":\"424b69914f8efddf\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/captureMediaVerb.js\":\"f01ef3923179f166\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/clipboard.js\":\"cb57a7e8b34a3787\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/decision.js\":\"d536c57f8cfe1bc5\",\"/knowledge-medium/pr-preview/pr-1833/src/paste/operations.js\":\"767decbc673d4028\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/account-header/AccountHeaderItem.js\":\"ae13fbbc43f65617\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/account-header/index.js\":\"c5da36d7d0748dc1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4bce3d4f0bcbebe9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/askAgent.js\":\"4099bbadfaee2551\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/askedStore.js\":\"08fcf4cd037d3b6a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"705da5fb7885f283\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/chipState.js\":\"9354567717fc8da1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ec59289b8ce61956\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/index.js\":\"ca043aadb9ccb784\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b4e20a7f9a986997\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-dispatch-companion/schema.js\":\"2b1981071c51f7af\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3214fe637f7004f6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/BridgePairingDialog.js\":\"870e56af6ea906a3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/addMedia.js\":\"5cae522bdef16690\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e41ddf22273645cc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/block.js\":\"b2fedadcadb77803\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/context.js\":\"9a241236cabd24e9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/displayIds.js\":\"dec75eff3111c892\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/index.js\":\"690b92d253bd978d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/outline.js\":\"ccfddd5e18f1565a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/properties.js\":\"7f32a996bf4f2cc2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/refs.js\":\"a98d03930865b89a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ef69f996df6920cf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/search.js\":\"5fb67f74ad2d95be\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/shared.js\":\"1e66e2bf4cb6ec2d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"fe110e15cdc74ae6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentViews/text.js\":\"340224be88973103\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/agentWrites.js\":\"a11d5d1aed5303e7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/authoringCatalog.js\":\"6e2d5145c9d8d807\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/blockRefTargets.js\":\"39330fd1a2e6ddb1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/bridge.js\":\"1f930aea4bc3859c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/bridgeLoop.js\":\"0b87e34485a54fd1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/changeHistory.js\":\"d3122f7b1f342631\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/commands.js\":\"79a31f7a13e308f8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/commentsCommands.js\":\"d2b28c5e1241132d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/dataExtension.js\":\"2b90ddb74ed2fe4b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/dataModelGuide.js\":\"bcc74e3e84e88bee\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/describeRuntime.js\":\"614d1e158769e669\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/extensionLint.js\":\"3354fb9f8e2d8300\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/grainAudit.js\":\"421f2efa4d646156\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/healthCommand.js\":\"41ba58f63c2aa9d3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/index.js\":\"2e572f11df4455b7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/presetIdentity.js\":\"a51210786bfcb9eb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a39dc9233bcccc8c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/readMedia.js\":\"23d43409c2fb903d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/schema.js\":\"eb6374b0a5a51ad4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/serialization.js\":\"baafd83ea82a3467\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/targets.js\":\"c243907d37c0d138\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/tokens.js\":\"a79066b09cd931b6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/watchEvents.js\":\"b7a835df8e8984b9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/workspaceGuard.js\":\"05e953d8b19e0849\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/agent-runtime/writeCommands.js\":\"52bf32a6ed1e9181\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/AliasCollisionToast.js\":\"a208d377fc19c283\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/DuplicateNameBanner.js\":\"8e1115d6d44fbfd5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/collisionMerge.js\":\"706c336a551c4ffc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/dataExtension.js\":\"699b929c7e8170d5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/index.js\":\"e2f78dc1605f7bb3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/mergeCollisionAction.js\":\"1a9ac2af7931598b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/pageStyling.js\":\"d717bba32d89d532\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/rejectionToast.js\":\"60c51541ff70d31d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/alias/syncProcessor.js\":\"2197fd35a1197fd7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/actions.js\":\"bd11e85680554a56\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/addComment.js\":\"dce8c8c2fd498a7c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/anchor.js\":\"6c6a4549ce230633\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/anchorState.js\":\"a1a90789259d3a0d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/commentLinks.js\":\"053abab2ac1255fa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/confirmThreadDeletion.js\":\"b5f24c5737ae6c15\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/container.js\":\"eecf927e78b12bb4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/dataExtension.js\":\"6f68915969557998\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/deleteComment.js\":\"47e4e447cfb525b1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/highlights.js\":\"a3cda9e9ee452f22\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/index.js\":\"085092aa95985295\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/linkedCommentsPill.js\":\"fa8d4ec086b18be5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/margin.js\":\"187e30257062d5c1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/marginSchema.js\":\"9e94e5378649d5fe\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/newComment.js\":\"f5606449e8287af9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/ownThreadPicker.js\":\"ec73a756330b9476\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/placement.js\":\"9808d2dd016b3488\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/queries.js\":\"7e261eeab66569a4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/quotePosition.js\":\"1f90cb77123fd2a9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/quotedIn.js\":\"90341dc4be7d0edc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/quotedRange.js\":\"6baf78a8a50e949b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/rangeRefs.js\":\"f4b8e5a91155b568\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/readHighlights.js\":\"5373987856850f10\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/readSelection.js\":\"c46b5eece5880827\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/readSelectionUi.js\":\"b2e0863e6bdad9ac\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/reanchor.js\":\"0e207be0ced5dfa7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/schema.js\":\"8e46e6f24abeccd2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/scope.js\":\"9a514cb868cd184b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/scopeThreads.js\":\"05af9a637cef3e65\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/splitRetarget.js\":\"d94b1dfc008a2cbb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/suggestionCard.js\":\"f6e732753ce52e51\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/suggestions.js\":\"5fcd6324c09ae904\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/summaries.js\":\"90529fb20548bca0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/summaryBatch.js\":\"84075858170c4aa6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/surface.js\":\"1350410b14f3feec\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/threadNavigation.js\":\"d347cb5d367f9e57\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/threads.js\":\"ef53a2d4e43edb35\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/ui.js\":\"ddcfb287abe4dbcd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/annotations/uiStore.js\":\"9d0fc221199d7049\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/app-intents/appIntents.js\":\"10728b11cd0370a4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/app-intents/index.js\":\"d5e850651fba9d93\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/app-update-prompt/index.js\":\"f0a18fbd559d71bf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/app-update-prompt/status.js\":\"de6985f050d8ff3c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"739281d84fa5232d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/MediaBlockRenderer.js\":\"0b11a9366c74cf3f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/MediaDownLaneReplicator.js\":\"eaa6a1aa8886407c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/MediaUploadReconciler.js\":\"d7b7eeed233151a3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/assetDownLane.js\":\"744b5bd9a706ff3a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/assetResolver.js\":\"f462bb360083e5d5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/assetUpload.js\":\"461f7d9a7fd3d808\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/attachmentCleanerIO.js\":\"cf1f260857602a49\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/supabaseAuditIO.js\":\"294039a585be4f8a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/blobStore.js\":\"291849b8310330b5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/byteStore.js\":\"e0c7ba9e0603190d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/cleanerIO.js\":\"c87abb57cf62a2fc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/cleanupAttachments.js\":\"5cd987dd5ab01bfc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/dataExtension.js\":\"9ee8edf7e518c8bf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/downLane.js\":\"029118672e04ce43\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/index.js\":\"0b8bf1b18bda74d6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/insertImageContribution.js\":\"f7be3c64474c5e43\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/laneArming.js\":\"e47a9acd4ad8b6a5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/laneLock.js\":\"a20bd9d882ce0058\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/mediaBlock.js\":\"769bf6177eda08fe\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/mediaCapture.js\":\"48111bb0d44cc766\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/mediaViewers.js\":\"0f24aa574a960dd1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/mediaViewersFacet.js\":\"798beea7473fadbf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/pasteCapture.js\":\"06fdd68b58611821\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/resolver.js\":\"c7be8b73e986e0e6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/retryUploadsAction.js\":\"2f4bfb56aa21b76b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/storagePaths.js\":\"a8a51d71cbcf0ca5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadDrain.js\":\"a5a08d21448bc13d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadLaneStatus.js\":\"102b27983b92cfcc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadReconcile.js\":\"8b760a016d4d5ffb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadRecovery.js\":\"cd29b5cce92a0933\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/uploadStore.js\":\"44a1b2d0cee7082e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/attachments/useAssetObjectUrl.js\":\"e0cc5eada376027f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"dbb6ad9942a590a5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/BacklinksViewSection.js\":\"8c31c30f68f6deff\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/facet.js\":\"ce36adba0f70361b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/index.js\":\"19c412f95392b54c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks-view/prop.js\":\"6693518ed788c85f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/BacklinkFilters.js\":\"9477c72c23dfc29a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"27ab7186593f9295\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/BlockEntry.js\":\"2c447252938c1632\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/LinkedReferences.js\":\"ea35897b5fe2f8c7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a982e250bfe2ca55\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/dailyNoteDefaults.js\":\"22f5015886764893\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/dataExtension.js\":\"8198c4ae38e50b61\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/edgeExclusions.js\":\"96dd015832d0880b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/filterProperty.js\":\"22964876510b87dc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/index.js\":\"17f8bf6fd7c8271d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"745b93d6d709da1f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/applies.js\":\"1356db687b326827\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/countQuery.js\":\"05f8141b490dc981\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7803d7e4bd28ada0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/index.js\":\"c6759f5b4ff31c65\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f6ea958fc8d297b8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/presentationInvalidation.js\":\"e20cc19b2fa5c2a0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/propertyEditorOverride.js\":\"21c4cd1a6ec57695\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/propertyFilter.js\":\"1b82dc59b3ae9b9a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/query.js\":\"77d9477e93f554a7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/resolveFilter.js\":\"4817838487d891ca\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/sourceBatch.js\":\"66da3db25bb4d26c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/sources.js\":\"e71ab27f9e2d799f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/useBacklinks.js\":\"c5c496dd082498bc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6018bc91f5b12d2d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/BirthdayCelebration.js\":\"2999cea7181b9850\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/BirthdayOverlay.js\":\"c1d58eaf4aab29ec\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/gate.js\":\"79337cc3c90863b7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/index.js\":\"d002aeafb08bcfa0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/birthday/wolfTheme.js\":\"c43eab45daa94c43\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/BlockDragLayer.js\":\"ea8a5762b116e7e7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/dragController.js\":\"fccaf875159b8157\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/dropTarget.js\":\"f21a2159a300aa89\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/index.js\":\"68d884ea9fa84757\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-drag/projection.js\":\"5eb7d7883f897611\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-info/BlockMetaCard.js\":\"c2d89f3a1ad8f4f4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-info/index.js\":\"21daf8758997d094\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/AddTagDialog.js\":\"ee2dd0c3667f96c4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d5cd318316d49906\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/TagNameIssueHint.js\":\"4cdcead22d0c7441\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/addTagAction.js\":\"072d61cb8e0bee05\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/appendTag.js\":\"f8480debddf24274\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/config.js\":\"e53013be1a476c97\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/dataExtension.js\":\"7ce8f075860a8462\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/index.js\":\"8e62a6643faf52f9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/block-tagging/propertyEditorOverride.js\":\"743a71dd4eae2a36\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a4a24b10dabe3766\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"71622514c0656242\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5932bb20e55fcbcd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"16873def46095ff0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ba9e6e2eec0e78ff\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/index.js\":\"0424761a3a50211a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"3c47d13fb4bae335\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/CharacterCountItem.js\":\"4a3fdc22ee6f9395\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/ProfilePropertyEditor.js\":\"577b630cea3570f8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/actions.js\":\"dc161b763826ecae\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/blockType.js\":\"ec5f72ba17242e91\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/charCount.js\":\"f00f90ad4e1be691\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/dataExtension.js\":\"96121d49095f1129\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/index.js\":\"5d390af44e70f9a9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/profiles.js\":\"fc050f5f2a521764\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/properties.js\":\"51ba52b589796bc8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/character-counter/textCounts.js\":\"477feaaebb098ec2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/colemak-keybindings/index.js\":\"54490166b33d946a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/CommandPalette.js\":\"3ad5a85c780d0794\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/HeaderItem.js\":\"b6776f345b552382\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/context.js\":\"64a2c0997df81817\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/index.js\":\"72369236eda566e3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/selection.js\":\"2e60f8d560cb8ce8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/toggleStore.js\":\"00e9fa24abf014f9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/command-palette/useCommandPaletteActions.js\":\"d569755a7301dd1c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/ContributorBadges.js\":\"b2f4016d2ca92a80\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/author.js\":\"9e715491aca40b56\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/codeMirrorExtensions.js\":\"45eb1d4264534c11\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/dataExtension.js\":\"c0cbdffb4dcc04b0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/index.js\":\"c3601172afd01ff8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/mentionAutocomplete.js\":\"cbc834a4b1cd9480\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/processor.js\":\"358af429cda48743\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/profiles.js\":\"6471f88e486608e6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/queries.js\":\"85ffb31151aa99b3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/contributors/schema.js\":\"1d19233cdbac46e5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d7d14871e49499ce\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ef891b1a288bd1f1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/index.js\":\"94d5b33b036549a4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a6b6a1ebc7e32388\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c476138cc65876b0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/CalendarGrid.js\":\"17458d6155f4f6c6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/DailyNotePicker.js\":\"33b9a0e299f1c350\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"520e76d37c09f405\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/DateNavDecorator.js\":\"b487197dfde47605\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/DateScrubOverlay.js\":\"3d2676b3ea09e35a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/HeaderItem.js\":\"61eff0ac2fcbc34e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/ReschedulePicker.js\":\"3ab96a3cd22b3195\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/SpreadDatesDialog.js\":\"12cc4169248568e7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/actions.js\":\"38585fec045fe12b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/blockDateAdapter.js\":\"be12ea0b2f5becd7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/calendar.js\":\"e91b420b7c5f7730\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dailyNotes.js\":\"a7feb4664968c993\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dataExtension.js\":\"06eb5c43dd9a35e8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dateScrubActions.js\":\"31fdfc447f01c439\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dateScrubGesture.js\":\"38db09f4523a5d7c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dateScrubGestureActions.js\":\"db1011a6faf0e75b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3688206f5afcc083\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/deletionGuard.js\":\"0a0c40328da61e39\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/dueQuery.js\":\"ba49b97b20cadd1b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/index.js\":\"58205bc4e59eb6a4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/landing.js\":\"577aae9d6e975f6b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/localSchema.js\":\"2d7433b6af1831e5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/referenceDateAdapter.js\":\"74446c81fdbfdd90\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/rescheduleAction.js\":\"4fd69d010afbde6c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/schema.js\":\"e9c56fc8b0cd1c78\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/spreadBlockDates.js\":\"bc7bbccb97d6b1e1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/spreadDatesAction.js\":\"29ab2ef965252bd5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/today.js\":\"556ad8d83d248d75\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b6c4514c5d9f4463\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6938a55a135bb989\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/audit.js\":\"6e0e14dea97b7246\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/auditAction.js\":\"94ea238305faf0b9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/auditRanges.js\":\"8d8e8d22523b66e9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/diagnosticsSource.js\":\"042025411a53c734\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/divergenceScan.js\":\"2340b1bcc0ead645\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/index.js\":\"f9c1e55301ee7def\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4c4000bd127dd893\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/referencesMirror.js\":\"0b28627916dca096\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/rowJson.js\":\"a6d4c89d9bfb7bcd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/schedule.js\":\"950b0a42cc4b1549\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/data-integrity/store.js\":\"c163ba3112dee17f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-maintenance/action.js\":\"1626c8073c059182\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-maintenance/index.js\":\"447e912fbf210456\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-maintenance/plugin.js\":\"6574dfdca9328a7a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"72722c238292f1b2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/actions.js\":\"ff06dcb09858848c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/changeMarker.js\":\"4130f63ce0b072bb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/diagnostics.js\":\"c95b8839256cd191\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/fileSystemAccess.js\":\"b3cf906167166d24\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/filenames.js\":\"29fd6a11153b6199\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/index.js\":\"616ac8a1c50f1c04\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/mirror.js\":\"af32368638482dad\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/runLock.js\":\"a42815779c997229\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/runtimeHealth.js\":\"dfa965062a43ed26\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/schedule.js\":\"320c1f67bc82ec9d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/db-mirror/store.js\":\"900dcf741f35d06f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/default-themes/index.js\":\"4a9ced6e142dd4dc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/default-themes/themes.js\":\"1964c4cf8e3bfeb4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/diagnostics/facet.js\":\"327ac16b0eb78933\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/diagnostics/useDiagnostics.js\":\"dbcb83e108ddbe3d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extension-prompts/dismissals.js\":\"1b00e06aeb7bf3ed\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extension-prompts/index.js\":\"6c9fc1170e823dd1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extension-prompts/status.js\":\"09f14f5114677b4b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extension-prompts/store.js\":\"90396ce2b96ac2bf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b1c42490a5c3c865\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a6ef46b0a523e1ee\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/actions.js\":\"ec4206722a255926\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/config.js\":\"0eae7e62689d6ca2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/dataExtension.js\":\"a0530ff1fb855d99\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/effect.js\":\"43561fb5340477b9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/index.js\":\"5e6530190c61a789\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7d6d9811697d957c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extensions-settings/useToggleTree.js\":\"4aa9580f35b15129\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/ExtractTypeDialog.js\":\"cffb35df274b020f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"896bc462d79ff81d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/PropertyShapePicker.js\":\"c9923489626938e1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/action.js\":\"80b52337a51cb900\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/extract-type/index.js\":\"e41cbe88d91331c7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/FindReplaceDialog.js\":\"f77966b3ee0eb614\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/HeaderItem.js\":\"1c144d2051deda20\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/dataExtension.js\":\"6187d39a23e81987\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/index.js\":\"6177645c8703505c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/search.js\":\"0886a070af809397\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/toggleStore.js\":\"c0b679fd098b2da3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/LocationPropertyEditor.js\":\"6b62b0cfffa2bfc5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/MapView.js\":\"80959906cceee017\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/blockTypes.js\":\"7a630a670f73981c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/codeMirrorExtensions.js\":\"118874855ecf0d7c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/createOrFindPlace.js\":\"d5a69c73167c978e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/currentLocation.js\":\"a58c0610ea7dd585\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/dataExtension.js\":\"1bc1624b4eced1c3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/geoContentDecorator.js\":\"cb252f3bb2832a1f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/googlePlacesClient.js\":\"a29f73b8a736421f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/index.js\":\"4e705804cfe91d83\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/locationsPage.js\":\"923289f8fd5432f2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/mapViewport.js\":\"6a8b8def5912398f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/pickCurrentLocation.js\":\"b5be48e3614ce2d4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/placeAutocomplete.js\":\"cc18f270ba77b8e5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/placeNameCollision.js\":\"7d0c346000f62724\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/properties.js\":\"f5b4f07adecc8d56\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/propertyEditorOverrides.js\":\"3ba911bd7305d12b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/query.js\":\"07e74a7ff8581884\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/geo/usePlaceSearch.js\":\"3677d037fe674c36\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"63297f1f004eb56f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a24f3d4f7aee5869\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6bfd054ea08619f4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/config.js\":\"5dcc5562562daa45\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/dataExtension.js\":\"440f1a3870302456\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/facet.js\":\"225e1c1ecc56e1d0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/grouping.js\":\"5e8e486b6f0a1815\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/index.js\":\"5919a85fef7f6775\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"29204dff983aa671\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/query.js\":\"f2e886bee096aff2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/resolveConfig.js\":\"a70e6ea9179cea9c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f2fcef68d8712ebf\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"80162c04dd1918eb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/HtmlDocumentContent.js\":\"a2cc767c05473825\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/HtmlFrame.js\":\"6c3be8c62fd57172\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/actions.js\":\"2e504c03557b6f58\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/blockType.js\":\"23e37c9041a096b9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/confirmRunScripts.js\":\"a8611758f0ddaff8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/dataExtension.js\":\"e714f7a2f9d5a8ca\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/frameAnnotations.js\":\"e1f13ee7a2167351\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/frameDocument.js\":\"1bca01ff34cebc92\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/frameTheme.js\":\"10a9f1e2728a2437\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/index.js\":\"b640873035ca8135\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/scriptConsent.js\":\"057fce646f5d23d6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/sourceMap.js\":\"253b72c1986a8838\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/html-document/useDocumentScripts.js\":\"ccc505dadb2dbfa5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/index.js\":\"5d6fdbeeaa0e891b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/record.js\":\"2fe05b32ab7a8619\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/recordStore.js\":\"490081d13fca970b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/responsiveness.js\":\"2f7e368b445bbd5c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/schedule.js\":\"29ea3a03b8ab15be\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/interaction-metrics/sessionContext.js\":\"feca7dfa37d65c6b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"18b9f6ba258837c4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"bfc4c75e66c60197\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/actions.js\":\"a0a4bc7c4519dd80\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/config.js\":\"63553e08fe4b5c2e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/dataExtension.js\":\"adb13531b55608ba\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/effect.js\":\"2a8a7e515892b435\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/index.js\":\"4077a9443c96e52d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/keyCapture.js\":\"fdb531aa58756f4e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/overrideStore.js\":\"ba61d4c7c30045ef\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dbbd5458577f0cd5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/HeaderItem.js\":\"b6adc4979c5b3e51\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/LeftSidebar.js\":\"4a994da095017a84\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/actions.js\":\"ed6c497b501e8e84\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/facet.js\":\"979416c6df7d3435\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/index.js\":\"00663bec2618d2d7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/shortcuts.js\":\"5f767cffc84dc79f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/left-sidebar/toggleStore.js\":\"8a8c2048620de209\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/merge-blocks/MergePicker.js\":\"546512a308eb2996\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/merge-blocks/index.js\":\"bb8afb3f7dca48e3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/merge-blocks/mergeAction.js\":\"d95549c9ca8b3a92\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/merge-blocks/strategy.js\":\"d56c29098377a0e0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/Button.js\":\"48e9f4f28efa442d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"bac1ae8fba61ccaa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b4d94fa7cf82f7cd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/facet.js\":\"783eb567b916b96c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-bottom-nav/index.js\":\"124ceeb0bcaac48b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6686bc6744e7e96f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6d5aeb46f346e810\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"01f5f9fd5d99b9eb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2a7152132cb27c80\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/mobile-keyboard-toolbar/index.js\":\"7c07e3d8d14d1c0c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/MoveDestinationPicker.js\":\"aa4de205c72e1899\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0e349429052c701f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/contextMenuItem.js\":\"a1c0427b0d686876\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/index.js\":\"4304ce026cb2bcc0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/moveAction.js\":\"6e988645e1d8adb0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/moveBlocks.js\":\"fc87de3b66f274ca\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/move-blocks/selectionAfterMove.js\":\"50816e38e2f1e84a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/TutorialBanner.js\":\"73a023ed3ce2e80a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/action.js\":\"954459a7e21a619d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/bannerDismissal.js\":\"92060f1bd0b3fd1d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/documents/cheatSheet.js\":\"73ac25eb3ca8d94f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/index.js\":\"2e566408bd82fa54\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/keys.js\":\"f94dee0b498485af\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/landing.js\":\"86cf06d39f1b9081\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/outline.js\":\"5c6e6b559748f2a0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/onboarding/seed.js\":\"efb26c5228d3f954\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ce30d2a64e2bf9a0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/analyze.js\":\"c71a228ab48b66bc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/diagnosticsSource.js\":\"b8132afa01c5fb9f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/index.js\":\"7ea6e931ae857cdd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/load.js\":\"77b004eac96a38cc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/monitorRun.js\":\"6e2de54c15ec381c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/schedule.js\":\"cda641316b6a0118\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/series.js\":\"de2b57501827d80c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/store.js\":\"3678845d140b2f7b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/trendAction.js\":\"a8bc4deea8aff587\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/perf-monitor/verdict.js\":\"460aca858d2d8f99\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/plain-outliner/clickToEditAction.js\":\"68f8cda52125ad92\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/plain-outliner/index.js\":\"4c8ad23669f4a001\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/plain-outliner/interactions.js\":\"7e776a6d5cf31bee\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8a02355d3d8d1f2a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/MigrationGate.js\":\"ece067a7de3a610a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/MigrationGateDialog.js\":\"ec466d9d7ceb6716\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/action.js\":\"6b8ee8b5aaece332\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/index.js\":\"b97aa2e788691656\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/localRunMessage.js\":\"2abafd0495980dda\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/plugin.js\":\"6021f17dbc7c4c1d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/progressReport.js\":\"3a89c8c00f040ff6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/properties-migration/sweepProgress.js\":\"65ee3055244e92d4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/FieldRowRenderer.js\":\"ed62c5b228487cce\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/ValueRowRenderer.js\":\"f887eec66a5e41fe\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/actions.js\":\"051bdef23e59eb5d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/autocomplete.js\":\"568b1d248f34a6af\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/fieldRow.js\":\"4564250dac01c2fe\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/index.js\":\"16e6e84887af2363\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/referenceWarning.js\":\"29a3fb498d433800\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/valueAutocomplete.js\":\"366d5d6b73e56bbd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/property-rows/valueSchema.js\":\"4e8e8c8d2d457a88\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/HeaderItem.js\":\"558aa31b6e5b652e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/QuickFind.js\":\"0090bcd9c436b36b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/index.js\":\"57928b498ee6e963\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/recents.js\":\"5cb407c7c7fa5f75\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/resultItems.js\":\"539d8016361eb451\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/selection.js\":\"e285d2e3767e9da0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/quick-find/toggleStore.js\":\"45c0e8b7d2f1c734\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/HeaderItem.js\":\"4bd07c97333b6d9d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9dac59984656528c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/grouping.js\":\"c47f277f4aec8f8e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/index.js\":\"40c238555d8beeb8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/recents/target.js\":\"4c09454b16d7a52f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/codeMirrorExtensions.js\":\"c758e04ccd3c71f8\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/contentPrefill.js\":\"7a504e08a34fab4a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/dataExtension.js\":\"8bb80bbcf3dcb3a3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/index.js\":\"7129227549afe27b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"83cd409f04a59857\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/invalidation.js\":\"60d00b592ea7b196\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/localSchema.js\":\"fd4e0c0a2868d152\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/blockrefs/index.js\":\"f6b2c02722c07512\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2d45d9e2528f482a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/index.js\":\"704cb4713af647f7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/referenceNode.js\":\"b97e4bcbe606f992\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2daf86fd725b1434\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b00b451e412cea92\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/wikilinks/index.js\":\"eb042c2da60a4791\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4ac16cabc3aa3b64\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d400f325004b9851\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/mergeRetargetProcessor.js\":\"7cfe1765503a4f3c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/parseFence.js\":\"980a0fff621e091b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/referenceParser.js\":\"a35008cf4fb548b0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/referenceProjection.js\":\"da6e548bc2c455af\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/referencesProcessor.js\":\"742f272598020e5e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/renameProcessor.js\":\"63aae68783319a90\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/references/spanReplacement.js\":\"2c270748de6a1afc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/rich-paste/htmlToOutline.js\":\"3f0eac0bde2ad454\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/rich-paste/index.js\":\"f183b4d395f96fb4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ccb272d46b01ee2d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/rich-paste/pasteDecision.js\":\"a3200abaee82eb05\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/action.js\":\"fe361c19229e7cfb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/blockIds.js\":\"5fc3dfed34721de6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/content.js\":\"330495e0d6c8b2ed\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/effect.js\":\"06801c54574f7559\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/ids.js\":\"6a3bd80562925fbb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/import.js\":\"0e76a462d2413323\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/index.js\":\"65c3e37e9672d287\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/plan.js\":\"8062f3d7fbcad9d5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/plugin.js\":\"46cd4afc31a432b2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/promotion.js\":\"9582554e07ed3202\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/properties.js\":\"9536c24c9b215db0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/references.js\":\"f32736a975fe0c7b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/report.js\":\"d15406388c08456d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/roamMemo.js\":\"d85b6fa125958ad6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/runtime.js\":\"76ae8b910bf84147\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/schemaReconciliation.js\":\"62f7c4286c1fd234\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/srsMarkers.js\":\"20a7faff324ec98c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/todo.js\":\"781c84c1f85a266c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/typeCandidates.js\":\"86b599866ac4327e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/roam-import/types.js\":\"3b08afe7542bbe60\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/search-health/index.js\":\"7f738a1680a32343\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/search-health/store.js\":\"d2a04b53a1a70500\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/HeaderItem.js\":\"46a8f9707741ee38\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e939d27981807b74\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/index.js\":\"45f764b5c29981dc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/model.js\":\"fff406503411b9e5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/toggleStore.js\":\"30b97d735aeae293\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/shortcut-help/useKeyInspector.js\":\"257107ef8d8e6d4c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3ae97407ddf8680b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/ShellDecorator.js\":\"849b6679d09991dd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/actions.js\":\"46c700ff30deafc3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5c803724983d4a60\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/index.js\":\"e633601b33a9abc0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/shell.js\":\"413a1e1eb13c93d3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/surface.js\":\"979b6405a2ddfcec\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/spatial-navigation/walker.js\":\"f352c295364a8d70\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d1d7ac555f36266e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/dataExtension.js\":\"7575c3fdb5ed9d78\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/index.js\":\"229d00eded1c40d9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/indicator.js\":\"a84f80956fb39537\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/moveSrsState.js\":\"9499458f0950ceb5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"693a73a6e6daa47d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/scheduler.js\":\"34a824e7f521731f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/schema.js\":\"35c826cf496215bc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"7937fb8420f41f06\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/srsClipboard.js\":\"27afc4536ddb499b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"97be60b32c095399\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6fa70e6ff57706f3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/DeckPicker.js\":\"a585222f63a3986b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/ReviewControls.js\":\"82c9d60632619719\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/ReviewDeckRenderer.js\":\"feb64cd129bc2454\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/ReviewSession.js\":\"9f4db2ae4d6d076f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/actions.js\":\"a6991ef6a9ac444d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/archive.js\":\"41196f647958784a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/dataExtension.js\":\"497b53c127c2a3d9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/deck.js\":\"1d0c6a3e9e0aa9b6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/dueQuery.js\":\"636e50782a8e3a14\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/gradeDecision.js\":\"394f33627697e45a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/index.js\":\"a8d68e158c369bc1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/keyHints.js\":\"081048fb2e2bbeb6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/reviewCardLayout.js\":\"2e93dd01391fa7ce\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/reviewProgress.js\":\"e99a459c7628a043\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/schema.js\":\"1029e2da81722d6d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/srs-review/useDueCards.js\":\"babf1eb3cd28e400\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/startup-metrics/index.js\":\"9115cf9c37dec93d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/startup-metrics/record.js\":\"ae96b52ffc3b5695\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/storage-persistence/index.js\":\"79953edde307a795\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/storage-persistence/persistenceStatus.js\":\"2ece0eb2aa5c5402\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/storage-persistence/requestAction.js\":\"a25b9b7a499a493c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/supertags/TypeChipsDecorator.js\":\"a49ae881ca795f1e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/supertags/codeMirrorExtensions.js\":\"9e86acd56a980a92\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/supertags/index.js\":\"5c5af1cd02de32d6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/supertags/typeAutocomplete.js\":\"b9e27bafafcd0190\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9da97fd061d328df\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/actions.js\":\"f0dbf331815a42f0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/anchor.js\":\"2be09b5853be2938\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/events.js\":\"26d1521daac02fab\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/gestureActions.js\":\"b42ff6bf37853525\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/index.js\":\"a6b8b47d28e4ff2d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"508b6c9c4c19843e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/sync-metrics/collect.js\":\"e93632f7363a750c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/sync-metrics/index.js\":\"c4f34a14173c52dd\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/sync-metrics/record.js\":\"bba478439edc650d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/RejectionDialog.js\":\"fbfa43f6e07af671\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/SystemStatusHeaderItem.js\":\"eaa8c34028e4843e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/index.js\":\"c06d2d87547b737b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/model.js\":\"0234365af8ff9813\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/queueCounts.js\":\"5e0fd8be97b7dec3\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/rejectedHelpers.js\":\"6ca996de2872083b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/rematerializeAction.js\":\"de1e31c6f6f124ae\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/system-status/useHysteresis.js\":\"516582f9e3feaa8c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/ColumnHeaders.js\":\"927fb88105cc6ec6\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/TableLayout.js\":\"efdf22b624d6d5be\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/actions.js\":\"25b3905df7ebd99d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/cellEdits.js\":\"05995fbd86259b30\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/columns.js\":\"c2ad5ca3314c3af5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/controller.js\":\"ae2182dbe38b67c4\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/convert.js\":\"7e5bc1513d59d070\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/dataExtension.js\":\"812b1522a96df800\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/index.js\":\"178dba1dd8b76b6f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/keys.js\":\"e55b285d6240895f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/model.js\":\"dd0ba00792d83fd0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/registry.js\":\"bc965c76f2e41797\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/tables/schema.js\":\"c2bc54bb27b7f8cb\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/theme-toggle/effect.js\":\"34897ed84cff5196\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/theme-toggle/index.js\":\"6ef3f01640d9e37a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/theme-toggle/theme.js\":\"41d75b92c8e98aaa\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/todo/actions.js\":\"a6eba786589657fc\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/todo/dataExtension.js\":\"17ddda4befe3e21c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/todo/index.js\":\"8263c76274ed0111\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/todo/schema.js\":\"b827c60cd540fcef\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1e345b12bf8d9ea2\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/actions.js\":\"f480f42594187d8c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/defaultItems.js\":\"c312755a11e2f8e9\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/facet.js\":\"98ddd67bc8f3c08c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/holdRecognizer.js\":\"656ccc1d8df8ccb1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/touch-selection/index.js\":\"dd82b1dd2ee78611\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/update-indicator/UpdateIndicator.js\":\"837d37f08f000f67\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/update-indicator/index.js\":\"88fb5c6d5147b5e0\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/update-indicator/loadTimes.js\":\"f0faabfe2d30acba\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/VideoNotesRenderer.js\":\"18701f9a60439a2c\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/VideoPlayerRenderer.js\":\"1fbbaed460027fd7\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/VideoTimeStamp.js\":\"769e015cfc940c8f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/actions.js\":\"454a633b8e24eb3d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/index.js\":\"7bb0175cb8b6b9c1\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/markdown.js\":\"5dd1520013a5d28f\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/notes.js\":\"fb9a90797836d85e\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/registry.js\":\"2da5f7873555a2ae\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/remark-timestamps.js\":\"4b1acd6f146ee05a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/video-player/view.js\":\"04ce3229224f314b\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-link-hints/LinkHints.js\":\"2c4b96b7e2fb08fe\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-link-hints/index.js\":\"60a1867c94fcb37a\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-link-hints/model.js\":\"c08d2a128a00eb35\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-link-hints/settings.js\":\"14cc70350e134e6d\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-normal-mode/actions.js\":\"da33189ac6858c06\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-normal-mode/index.js\":\"5bbfbb9464d3f8c5\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/vim-normal-mode/interactions.js\":\"401109fd59b1d569\",\"/knowledge-medium/pr-preview/pr-1833/src/plugins/workspace-header/index.js\":\"b471486c4ef4a0e2\",\"/knowledge-medium/pr-preview/pr-1833/src/registerServiceWorker.js\":\"12253e81b474da1b\",\"/knowledge-medium/pr-preview/pr-1833/src/requestPersistentStorage.js\":\"81a47b7fee43f55d\",\"/knowledge-medium/pr-preview/pr-1833/src/services/authRequestDeadline.js\":\"7b1f3d2c4835ade5\",\"/knowledge-medium/pr-preview/pr-1833/src/services/authStorage.js\":\"c397920e47a0d841\",\"/knowledge-medium/pr-preview/pr-1833/src/services/powersync.js\":\"b0d944539436ba8a\",\"/knowledge-medium/pr-preview/pr-1833/src/services/supabase.js\":\"db35dc270fcc80b3\",\"/knowledge-medium/pr-preview/pr-1833/src/services/uploadErrorClassifier.js\":\"f5fa864fa89ef273\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/ActiveContexts.js\":\"a12434464b1c0293\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/HotkeyReconciler.js\":\"b6de027ddec0d4c8\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/WipeLocalDataDialog.js\":\"a9054cece2c0a76a\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/actionDispatch.js\":\"ac87bfc087155b78\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/actionRefItems.js\":\"26cf8039b7f87359\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/applyKeybindingOverrides.js\":\"9bdd87f3cd0ea201\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/blockActions.js\":\"39d1b66f69c07bb5\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/canonicalizeChord.js\":\"00524181982ee423\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/defaultContexts.js\":\"f41a736336b5b0f3\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/defaultShortcuts.js\":\"472e43aa5cbeeada\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/effectiveActions.js\":\"ee55f347616248ec\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/gestureAction.js\":\"4cdffbbd3c219ff4\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/gestureBinding.js\":\"ad38f683ccce3b9c\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/holdRegistry.js\":\"eff898976c3d76ec\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/keybindingConflicts.js\":\"37cc845dcc8cbe98\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/keybindingOverrides.js\":\"57cccbfe13666b8c\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/pointerAction.js\":\"7bcaa4f465d785d4\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/resolve.js\":\"f8113769a3abb088\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/runAction.js\":\"7341e4506b2cf795\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/sequenceMatcher.js\":\"3f0ccaf2968cd86f\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/types.js\":\"4ba2b286e9245b23\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/useActionContext.js\":\"48af0911f15aa1d7\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/useActionDiscovery.js\":\"d4b718a98dcb29a1\",\"/knowledge-medium/pr-preview/pr-1833/src/shortcuts/utils.js\":\"c5fa12397b9d4151\",\"/knowledge-medium/pr-preview/pr-1833/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1833/src/sw/bootStore.js\":\"9df33a1a6596e6fc\",\"/knowledge-medium/pr-preview/pr-1833/src/sw/previewDatabases.js\":\"c10085f53275dd66\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/byteTransform.js\":\"0b0557a722857a62\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/attachmentCleaner.js\":\"3acf900c4d55b113\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/attachmentParts.js\":\"e479b36f06410aa2\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/bundleParts.js\":\"117968416310245b\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/bundleRecord.js\":\"c368fbdfc3cc4b83\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/manifest.js\":\"17fd9659c19a699f\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/takeBundle.js\":\"75c3f3652c9b7756\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/bundle/verifyBundle.js\":\"9fd6726a42be3ec9\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/cleaningStage.js\":\"5d4ccef9a33ab343\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/conversionKey.js\":\"bf497eddbd97383e\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/conversionServer.js\":\"a21e814d71436266\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/flip.js\":\"7fc8d021190e1471\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/flipAttempts.js\":\"f309f8dd438b5561\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/pages.js\":\"bb85e93496f5150f\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/preflight.js\":\"7b01905080cf8973\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/reseal.js\":\"971563500f5c1a9f\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/runConversion.js\":\"4297037347438814\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/runLock.js\":\"ee7849f4b20294fd\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/sealing.js\":\"57b5a613138af23f\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/sealingStage.js\":\"e1877e4560e1af13\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/stage.js\":\"8a757a381e593b05\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/conversion/verifyReseal.js\":\"6195c284f164cdb2\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/aad.js\":\"8479cdee6120eba2\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/aead.js\":\"9ce9527d536f1384\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/base32.js\":\"99008d241ee94283\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/base64url.js\":\"8d3cd24f8c552385\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/binaryEnvelope.js\":\"cf8a22ada9cf4472\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/byteAead.js\":\"523c06401ce46a4c\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/canary.js\":\"88a2f6987ef4830a\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/contentHash.js\":\"3c7ce98768c2a686\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/contentKey.js\":\"19c8787e697cc2d7\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/derivedIdNamespace.js\":\"ddcf31246338abc6\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/envelope.js\":\"a62b3a7e08ac4e8c\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/hex.js\":\"d0b82b60713c523d\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/sha256Hex.js\":\"5ee05b981c08c464\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/crypto/workspaceKey.js\":\"0938087dc21df002\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/conversionState.js\":\"fe4578815d4ff272\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b721c6527c9d9553\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/flows/pastedKey.js\":\"62ae2dea4d587309\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c1d1d50ee1cd786c\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/flows/upgradeWorkspacePin.js\":\"84319ca47cd0c244\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/keyStore.js\":\"544fcd470e0e85e8\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/mintWorkspaceKey.js\":\"744f83fd89151d9f\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/modePin.js\":\"1d925c43d2788f2b\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/openWorkspaceKeys.js\":\"9eaaaeacef570473\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/resolveWorkspaceEntry.js\":\"873a1e38e44107cf\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/resolver.js\":\"c5a88fc845d0807e\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/keys/workspaceAccess.js\":\"e166a81468f7d2fa\",\"/knowledge-medium/pr-preview/pr-1833/src/sync/transform.js\":\"8029157cb55f40e3\",\"/knowledge-medium/pr-preview/pr-1833/src/themeBootDefaults.js\":\"69f37bf18522b70d\",\"/knowledge-medium/pr-preview/pr-1833/src/types.js\":\"1a193cc368dfb6b1\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/ClientLocalSettings.js\":\"c6453b38fde08639\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/abortableSleep.js\":\"69c2ff2886a3c9cc\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/array.js\":\"7702365bbeaf436a\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/backlinkAutocomplete.js\":\"0420a2f8aab20ce0\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/blockCrumbs.js\":\"e2e8a3519ce222b3\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/blockrefAutocomplete.js\":\"32b82b43c3961186\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/cadencedIdleJob.js\":\"ee09f7369d72d9dc\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/callbackSet.js\":\"2a0c3ffc66d468d9\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/clientId.js\":\"85ed389064a8fab2\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/codemirror.js\":\"4bc7847c3769be2e\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/codemirrorCompletion.js\":\"24c48c19c05cb26f\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/copy.js\":\"addffd1891a418e5\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dailyPage.js\":\"733e097e0f677910\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dbForensics.js\":\"bfdb7e55dbce5e10\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dbForensicsHooks.js\":\"ff3f16b15e2dd92c\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/deleteBlockThroughUi.js\":\"b3643277253c378e\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dialogs.js\":\"5d9110b624537972\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/dom.js\":\"090f6093e6e3a61c\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/downloadBlob.js\":\"602cebda041535da\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/exportSqliteDb.js\":\"55c00aeaf0f78e84\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/fileSystemAccess.js\":\"eb2f0e440351b255\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/flipSlide.js\":\"abbcf88448c040e7\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/fnv1a.js\":\"32b38e2b4047eaa6\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/formatBytes.js\":\"e82aabb24fbd5005\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/fuzzyRank.js\":\"4b68a115896dff41\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/idbKeyedStore.js\":\"db9df9de98438d2c\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/idleCallbackPolyfill.js\":\"561c4d47c38174db\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/keyboardAwareScroll.js\":\"362795beae83f1fc\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/keyboardViewport.js\":\"18a5aee0ab40c68c\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/lastWorkspace.js\":\"d536ba113005dc99\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/layoutColumns.js\":\"45a16fb71ba27438\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/layoutSessionDom.js\":\"9baf95f9fa0141b9\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/layoutSessionId.js\":\"763a90c571a64f6a\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/linkClickGestures.js\":\"84724849c8e7efe8\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/linkTargetAutocomplete.js\":\"dab4c52f9be323f3\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/localDbCorruption.js\":\"4664b3b8653ed631\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/localDbRecovery.js\":\"e494f6b6c0e651d4\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/markdownParser.js\":\"d4768b1b97e2a8bd\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/memoize.js\":\"3ca0a8bb1584b91d\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/nameFieldCommit.js\":\"15d6b387b564d962\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/nameList.js\":\"14673ac9cd0eb61b\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/navigation.js\":\"fe7c7a8f1e0d37a5\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/omnilinerNamespace.js\":\"ed25ac876f802266\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/opfsPageScan.js\":\"635e670fe21eda4d\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelClearance.js\":\"fced51dc1c626bc6\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelHistory.js\":\"adf5eb8cf2c36eb1\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelLanes.js\":\"9385e89cf37c7c11\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelLayoutProjection.js\":\"e39bcbbc0502f37a\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelScrollAnchor.js\":\"a82297c1c7afacdc\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/panelUrlFlags.js\":\"9a8448a9edf21046\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/platform.js\":\"cf14ed15ee9fd279\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/pluralize.js\":\"4ab3e788fe5bca4a\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/propertyCreation.js\":\"91c3885c925a3526\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/propertyNavigation.js\":\"b8eec33cd8247436\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/propertyValueContext.js\":\"89f6df86f536fc5d\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/react.js\":\"1b7029ce51e6dc5b\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/relativeDate.js\":\"409022136b3de182\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/relativeTime.js\":\"00d09671dfb9ca97\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/renderScope.js\":\"a9a57f7758774c13\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/resolvedThenable.js\":\"17f9bdcd5774b078\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/routing.js\":\"3908c4cb86e4bc2c\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/safeMode.js\":\"590dea676d4f1c95\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/scheduleIdle.js\":\"6b49e3732f9346a4\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/screenWakeLock.js\":\"7dea5337f1b4b281\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/selection.js\":\"6ef6bbd10c479b8e\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/softKeyboardGrab.js\":\"3d964777c57d4f66\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/startupTimeline.js\":\"9ee41a5a6d10171a\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/state.js\":\"5838033510916ab0\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/string.js\":\"0035ee19a70ac569\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/surfaceZoom.js\":\"08e48943ae0fa434\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/time.js\":\"225115d42b9383de\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/toast.js\":\"2fbc4679f7c2d48c\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/toggleStore.js\":\"235660855fdceab4\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/untilStopped.js\":\"4f8a7ceacde1c287\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/userActivity.js\":\"3e83f6a7ba26dbae\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/viewTransition.js\":\"a5d8595862b9ffb9\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/viewport.js\":\"45fd2e579a8e2318\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/webLock.js\":\"bcdf794a83cf21e6\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/workspaceRecovery.js\":\"a686b12514c5b9fc\",\"/knowledge-medium/pr-preview/pr-1833/src/utils/workspaceSnapshotStore.js\":\"dd3f02b6bb200364\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-compiler-runtime.js\":\"624fd53391d4e031\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-client.js\":\"0b51559d96d8136d\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-server-edge.js\":\"ffe86dbbf61be0ef\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-server.js\":\"e47d1751a2a7ab35\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-static-edge.js\":\"4ea9fa6f25d9014a\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-static.js\":\"1ad372882a3dce10\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom-test-utils.js\":\"462b414c5d2c1fac\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-dom.js\":\"9545658b4556f4a8\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react-jsx-runtime.js\":\"8a276ddf40acc80a\",\"/knowledge-medium/pr-preview/pr-1833/src/vendor/react.js\":\"601619d83d2a26a9\",\"/knowledge-medium/pr-preview/pr-1833/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1833/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1833/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
