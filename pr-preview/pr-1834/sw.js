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
		buildId: "f7d77f9cf4bc-5b77f1c9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1834/\":\"5e9b1ffbaa4c3ff6\",\"/knowledge-medium/pr-preview/pr-1834/index.html\":\"5e9b1ffbaa4c3ff6\",\"/knowledge-medium/pr-preview/pr-1834/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1834/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1834/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1834/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1834/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1834/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1834/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1834/assets/FacadeVFS-BbMTrHoD.js\":\"1e075e4f3ef26c66\",\"/knowledge-medium/pr-preview/pr-1834/assets/OPFSCoopSyncVFS-DDQd3ZAp.js\":\"032d4b4f442d444f\",\"/knowledge-medium/pr-preview/pr-1834/assets/OPFSWriteAheadVFS-ChUt6bYY.js\":\"acd5a0c5defcd08e\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-BOtHaabN.js\":\"87696b79606932d3\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-async-Bv_U1qeC.js\":\"114b1d83fa7291d4\",\"/knowledge-medium/pr-preview/pr-1834/assets/worker-rXhnQYLa.js\":\"b14d0a6d6d1d1fd9\",\"/knowledge-medium/pr-preview/pr-1834/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1834/chunks/app-CvP2wfaf.js\":\"330f40d01c6361a8\",\"/knowledge-medium/pr-preview/pr-1834/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1834/index.js\":\"8cd71e60fa0259ea\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1834/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1834/assets/AccessHandlePoolVFS-CTX513ie.js\":\"318e88602d09ec1c\",\"/knowledge-medium/pr-preview/pr-1834/assets/IDBBatchAtomicVFS-B_2klZLe.js\":\"685945e3881749d7\",\"/knowledge-medium/pr-preview/pr-1834/assets/MemoryVFS-D2MCNKhC.js\":\"d475acc0b2b3cc96\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-async-C3jmRr2B.js\":\"8f7c9fae220719bf\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-lSV33sU-.js\":\"72f04048ec7b7158\",\"/knowledge-medium/pr-preview/pr-1834/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1834/chunks/AccessHandlePoolVFS--TRMReQj.js\":\"acb1163338771d46\",\"/knowledge-medium/pr-preview/pr-1834/chunks/FacadeVFS-CfOHQYlj.js\":\"37be05765ffa1885\",\"/knowledge-medium/pr-preview/pr-1834/chunks/IDBBatchAtomicVFS-Bz11S-CU.js\":\"eb344544337d330c\",\"/knowledge-medium/pr-preview/pr-1834/chunks/MemoryVFS-B--nHN1c.js\":\"cdd0fb5317aa1826\",\"/knowledge-medium/pr-preview/pr-1834/chunks/OPFSCoopSyncVFS-DoqwPYSS.js\":\"9a0920cfc716ef27\",\"/knowledge-medium/pr-preview/pr-1834/chunks/OPFSWriteAheadVFS-D_LExUpO.js\":\"3978037a327cd7f9\",\"/knowledge-medium/pr-preview/pr-1834/chunks/Preview-BN-lGG3y.js\":\"c6833db6bd599cae\",\"/knowledge-medium/pr-preview/pr-1834/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1834/chunks/card-GRam-eRt.js\":\"5398503591fe2f06\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dist-BfY7JmWt.js\":\"fa7b794c1ef349f7\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1834/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1834/chunks/mc-wa-sqlite-async-r3dPhsMf.js\":\"6269305a9e59a875\",\"/knowledge-medium/pr-preview/pr-1834/chunks/mc-wa-sqlite-cttdgm2h.js\":\"cb989467cd14fcc8\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-08iB08kM.js\":\"8912ef393195bd4a\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-BiWZq6cY.js\":\"208b765d5d02f5e1\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-BvomfaBM.js\":\"f8d67695a3716cfc\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-Cae6jkoE.js\":\"c86e697668565d00\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-Ufoir6MT.js\":\"9ac0cdbf9ef77b9c\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-baHFWelA.js\":\"c9ba0b1934e35b4f\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-dom-server-legacy.browser.production-BFuSw0VL.js\":\"e18dde75c895a305\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-dom-server.browser.production-yNvmjTOE.js\":\"ac6e795a5cc09498\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-dom-server.edge.production-CuFwDanZ.js\":\"d81976294a78ca98\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-loHzKKPv.js\":\"44e98ebdb7f7821e\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-r6D6jS2T.js\":\"acc5eb45bd7e7357\",\"/knowledge-medium/pr-preview/pr-1834/chunks/server.browser-CgeHaRST.js\":\"9a58f7c0d1b45b89\",\"/knowledge-medium/pr-preview/pr-1834/chunks/textarea-MWkGntPh.js\":\"4b4d87d3d423695d\",\"/knowledge-medium/pr-preview/pr-1834/chunks/ui-BfHk8fgv.js\":\"a3ff913fc5a173bd\",\"/knowledge-medium/pr-preview/pr-1834/chunks/wa-sqlite-BjV-gq26.js\":\"7f1929dd24b3b79d\",\"/knowledge-medium/pr-preview/pr-1834/chunks/wa-sqlite-async-CnCHQiSe.js\":\"87c5086cd7de6d8f\",\"/knowledge-medium/pr-preview/pr-1834/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1834/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1834/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1834/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1834/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1834/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1834/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1834/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1834/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1834/src/App.js\":\"8f99f760a50144d5\",\"/knowledge-medium/pr-preview/pr-1834/src/appUpdate.js\":\"8e7ec8338a036264\",\"/knowledge-medium/pr-preview/pr-1834/src/appVersion.js\":\"3d6673547ffc335f\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/initialLayout.js\":\"af7146db70707098\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/openWorkspaceData.js\":\"c87cb035d7eee2ea\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/resolveWorkspace.js\":\"1d4908c58de2c82d\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/workspaceBootstrap.js\":\"ed8d3c1891cf1aba\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockComponent.js\":\"4b8918947713f2b6\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockCrumbs.js\":\"e82c723a505f115b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockEditor.js\":\"ab46b062420c1b64\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockLoadingPlaceholder.js\":\"a154b97b20cdc907\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockProperties.js\":\"d09b03198e6694a8\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockSearchPicker.js\":\"c91604ddc23aaedc\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ConfirmBulkDeleteDialog.js\":\"ff60e40c08279eb9\",\"/knowledge-medium/pr-preview/pr-1834/src/components/DividerHandle.js\":\"f9836d5f1b88041f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/DraftEditor.js\":\"e6627f53953cb712\",\"/knowledge-medium/pr-preview/pr-1834/src/components/GutterPill.js\":\"ad28a24835b1b1b7\",\"/knowledge-medium/pr-preview/pr-1834/src/components/Header.js\":\"344b6f084ff7453f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/LazyBlockComponent.js\":\"2d5fe9e367f90b07\",\"/knowledge-medium/pr-preview/pr-1834/src/components/Login.js\":\"bef69d9f9c6c928f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ZoomableSurface.js\":\"bd921500467a10c3\",\"/knowledge-medium/pr-preview/pr-1834/src/components/editModeKeepalive.js\":\"aa106bfc5c904fca\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b88d87cae30531eb\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"efd00fe0e1b763ba\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/RefPropertyEditor.js\":\"e665c2aa3ff1fd07\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/RefTargetTypePicker.js\":\"f05831cca16f8244\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/SelectPropertyEditor.js\":\"76d69802d45db991\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/TypesPropertyEditor.js\":\"76c95119912d1d0b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/defaults.js\":\"85bdab3ed9984abb\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/kernelValuePresets.js\":\"c45840605db3b00f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/selectablePresets.js\":\"a182f1bf27d6a8c5\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/typesPropertyUi.js\":\"19cdb5eb3e95e952\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/AddPropertyForm.js\":\"aed0495e006d60a5\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/PropertyPicker.js\":\"be772ebb6d4b547a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/PropertyRow.js\":\"320943a5f8c4db4e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/Rows.js\":\"347e2cad3ff307ae\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/actions.js\":\"03156d10f02c968d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/declarationOnly.js\":\"d6558b2b5260fc76\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/layout.js\":\"ced13073b1a98fa7\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/model.js\":\"c3de681ef70338a4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/shapeUi.js\":\"7f764f10c701c1b6\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/shapes.js\":\"6543e802c67a6fca\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/usePropertyEditingActivation.js\":\"dce9aca7c2996265\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/visibility.js\":\"6e55bbb6528e785d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanelSections.js\":\"61575722d850d793\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/BlockEmbed.js\":\"8366c5aa3a35b7b7\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/BlockLink.js\":\"0ecce3acfee8f5eb\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/BlockRef.js\":\"c6b6907be2315564\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/ReferenceLink.js\":\"7d5341cff0ae60c4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/cycleGuard.js\":\"0c972691c188b36f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/cycleGuardContext.js\":\"660c94c10325f90a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/linkInteraction.js\":\"830b031389741464\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/referenceLayout.js\":\"be7d64dd1cdeb162\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/useBlockRefAncestors.js\":\"b6b7441c78604627\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BlockGutter.js\":\"1011632230d7f603\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BlockInfoDialog.js\":\"fb52e118ae2c4d7d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BlockTypeBlockRenderer.js\":\"ea7ec74b488f7a62\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BulletHoverCard.js\":\"79198e536ab19df4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/CodeMirrorContentRenderer.js\":\"2ec33caf10468d6f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"045539d2fbd22e0f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/ColumnResizeHandles.js\":\"c5c81b9a774ee9f0\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4f62af013bafd977\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/DefaultBlockRenderer.js\":\"c7a53fe2bfba237a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/LayoutRenderer.js\":\"1ca32ae19c22a2b3\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/MarkdownContentRenderer.js\":\"c07c5326eea4ab05\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/MissingDataRenderer.js\":\"b2b1a83eddf16a1c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/PanelRenderer.js\":\"0c190c2931eaf9bf\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d2429f18595f0979\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/TopLevelRenderer.js\":\"3248dc7286dda2d4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/blockGutterMode.js\":\"b30b507dc70c37e1\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/blockTitleText.js\":\"45948ef7194e0cf4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/fieldCreationKeydown.js\":\"29f69313c4b2848f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/layoutRootContext.js\":\"4095e27522696dd4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/typeChip/TypeChip.js\":\"4643c57e67a22030\",\"/knowledge-medium/pr-preview/pr-1834/src/components/typeChip/chipStyle.js\":\"dd2959d76ab89533\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/anchored-floating.js\":\"d143f4dd3623ca06\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/button.js\":\"2ff49c464da31460\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/card.js\":\"62c33c87b8457e20\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/checkbox.js\":\"2235f944500e8cf6\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/collapsible.js\":\"5e3e9f5ec902933d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/command.js\":\"fdd87c87d0cd3aa1\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/context-menu.js\":\"22c98282ddf42b1c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/dialog.js\":\"f250822e7de7fa5e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/dropdown-menu.js\":\"70b4e721dc32e3dc\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/floating-listbox.js\":\"e538187ee50496bb\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/index.js\":\"77b2f7f9b77c67db\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/input.js\":\"dd7155e9a6b6d9a8\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/kbd.js\":\"e5e7eed60eebf856\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/label.js\":\"5cae5369a8002d9a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/textarea.js\":\"af8ec48baf2fdb7e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/useEditModeYieldKeepalive.js\":\"cbdea5f6f05c1587\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/BootFallback.js\":\"dbd749099ddd4609\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/FocusedRowLazyMount.js\":\"dcafe8239d998971\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/LazyViewportMount.js\":\"58a9aa81bb10b7d6\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/LocalDbCorruptionFallback.js\":\"ba7b86b12ce00b30\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/error.js\":\"e187d5ec36005615\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/lazyMountRegistry.js\":\"e4fbfa40cf9419cb\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/suspense.js\":\"c29865e80071895f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/CreateWorkspaceDialog.js\":\"4e67d81267898024\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/PendingInvitations.js\":\"fea8f78540250f4f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/SyncProgress.js\":\"dceb91dc299ef5f7\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/UnlockProgress.js\":\"4c4a4ff0668cc23f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceKeyGate.js\":\"17065d0d9c8cb521\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceSettingsDialog.js\":\"e84e973d2bdeaa49\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceSwitcher.js\":\"fb28d9bfac89b3c8\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceSyncGate.js\":\"a151916b04b0fec3\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/ConversionFlow.js\":\"c0627171ca7a5e19\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/ConversionFlowHost.js\":\"e3cc2709eb9634cb\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/EncryptionSection.js\":\"f4a16f645da8436d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/attachmentPrompts.js\":\"4d7257ca5c119ba2\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1af782f76693a3c3\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/conversionFlowDeps.js\":\"14b657792da95124\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/conversionFlowStore.js\":\"9f0f5883090c03ee\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/flowUi.js\":\"487fb0d0d9a66681\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/useConversionRun.js\":\"4519765547b492f8\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/keyUi.js\":\"e3a80db2d503ec4d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/useCloseOnKeyLoss.js\":\"5fbd218e3de81556\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/useCloseOnServerE2ee.js\":\"f90ae1d68945d143\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/workspaceUnlocked.js\":\"2e7273a32b8fc6f1\",\"/knowledge-medium/pr-preview/pr-1834/src/context/backgroundSubtree.js\":\"5fff69ea84c99e0c\",\"/knowledge-medium/pr-preview/pr-1834/src/context/block.js\":\"842cc4fd8218f26c\",\"/knowledge-medium/pr-preview/pr-1834/src/context/layoutWsContext.js\":\"ff055376a203ffc6\",\"/knowledge-medium/pr-preview/pr-1834/src/context/propertyDisplay.js\":\"edeeac8ecac94c54\",\"/knowledge-medium/pr-preview/pr-1834/src/context/repo.js\":\"baf5d05dbe528ac5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/aliasClaim.js\":\"ab8cd0b3c0430fb7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/aliasSeatNamespace.js\":\"3a1ce73e7f7b78a9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/blockData.js\":\"020acc83b4e4eecf\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/blockType.js\":\"e5f59006d33e95e9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/changeScope.js\":\"2610824e89af9b0c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/codecs.js\":\"e009db1758491661\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/derivedData.js\":\"dae52e03baf83aa4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/errors.js\":\"f972d5fac587f0ff\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/events.js\":\"6e0f90a61b90389e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/handle.js\":\"5dea0e1df36798fc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/index.js\":\"3362f6f50a68e019\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/mutator.js\":\"8cfc367cdef7208a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/processor.js\":\"29715a99c8d3df9c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/propertySchema.js\":\"3df4156a8f80b7dd\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/query.js\":\"ecf2f1292493053b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/sameTxProcessor.js\":\"809908213c9113f9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/schema.js\":\"5dea0e1df36798fc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/tx.js\":\"5dea0e1df36798fc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/typedBlockQuery.js\":\"e4c455868bd2296a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/user.js\":\"306a15ba6eedeed9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/valuePresetCore.js\":\"140a2abb22e15e81\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/valuePresets.js\":\"7d145232eece1898\",\"/knowledge-medium/pr-preview/pr-1834/src/data/attachmentCleanerIOVerb.js\":\"a2debd85195bc5f1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/block.js\":\"8a40f65b2a377de7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockCache.js\":\"213994e09a84a6ec\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockId.js\":\"f5b90716bebf39be\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockLiveness.js\":\"e29519cfef64c371\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockMerge.js\":\"781f81751b042896\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockSchema.js\":\"2a94cdc0ff88336b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockTypeLookup.js\":\"64a1b654c2fdcb34\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockTypes.js\":\"596c885c0a364354\",\"/knowledge-medium/pr-preview/pr-1834/src/data/clientContext.js\":\"819cadc21accb72b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/dbFileSiblings.js\":\"cb771fce65b4398c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/definitionSeeds.js\":\"db4568815a4da532\",\"/knowledge-medium/pr-preview/pr-1834/src/data/derivedIds.js\":\"e772c96e5290c183\",\"/knowledge-medium/pr-preview/pr-1834/src/data/drawnSubtree.js\":\"593ed378af98ae35\",\"/knowledge-medium/pr-preview/pr-1834/src/data/facetBridge.js\":\"ddea3a8e221ec435\",\"/knowledge-medium/pr-preview/pr-1834/src/data/facets.js\":\"90b5cb619775e009\",\"/knowledge-medium/pr-preview/pr-1834/src/data/globalState.js\":\"449300873d01c614\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/aliasClaimRederiveProcessor.js\":\"03b2f410ba614aa5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/ancestorBatch.js\":\"e16684c4dda4bbce\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/blockTypeTypeifyProcessor.js\":\"86c5ae94f7cddf9c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/clientSchema.js\":\"a84e0fb07228fa30\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/commitPipeline.js\":\"5107c2951253d479\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/devAssertions.js\":\"2211010115a7d131\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/firstSync.js\":\"6d816b1cb99644f8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/freshInitialLoad.js\":\"9abe9eb12e266404\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/graphBackfillClaim.js\":\"2f0eb1eaefc802e8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/handleStore.js\":\"27d825dba9296ee6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/idleMarkerJobs.js\":\"e5a55bc192b37ed2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/initialDownload.js\":\"1d7046f3db33b6ab\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/initializeClientDatabase.js\":\"be2db80ac0bdd15e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/jsonCanonical.js\":\"bb202ce8333cc439\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/kernelInvalidation.js\":\"1e0af302edcff721\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/kernelProcessors.js\":\"371e4c08a9304b05\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/kernelQueries.js\":\"3e981a5500122f30\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/mergeTypeMembershipProcessor.js\":\"4c554bcc6dae70d7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/normalizeReferencesProcessor.js\":\"ad954bff72a2c78c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/poolInstrumentation.js\":\"c79e439313162339\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/processorRunner.js\":\"541c2fb7f72b39f7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyCellBackfill.js\":\"102dd917ff4e5281\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyChildMint.js\":\"5de07d645347fbc2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyChildrenProcessor.js\":\"b65328ccfdf862eb\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyDefinitionChangeProcessor.js\":\"cbf297d2ce0106d5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyDefinitionSynthesis.js\":\"d8e9945d2e6c9bc8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyKeyScan.js\":\"2cf76a8fc680a432\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertySchemaResolution.js\":\"5a80d9e8e039c226\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyValueEdits.js\":\"81c7910caf055f1d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/raiseProtocol.js\":\"412a47ec7abba15b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/readBatch.js\":\"f3d42c075e5f3fbe\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/refProjection.js\":\"0fa21b609fa35550\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/referenceTargetLookups.js\":\"e057ac46e15066a9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/referenceTargetProcessor.js\":\"4435f1d68e7d7ad3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/replayMerge.js\":\"20f1b652eb3f3727\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/sqlBinds.js\":\"0bd75bd6f73f4c69\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"087cfbcee3b89942\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/arrivalProcessors.js\":\"10ff9f6e73f4ea3b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/invalidate.js\":\"2a65472dc39daf98\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/materialize.js\":\"e224fc066b233b11\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/observer.js\":\"02d0768a691e8fed\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/reconcile.js\":\"9f1364bd4bda18b1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/timingMetrics.js\":\"a800d3b570bc080e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/treeQueries.js\":\"8ecc8c0610fe1b38\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/txEngine.js\":\"32eb74745915edfb\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/txSnapshots.js\":\"0c0618c34e145a83\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/typedBlockQuery.js\":\"44b9e658f8f44868\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/undoManager.js\":\"a476b2b0499cbb75\",\"/knowledge-medium/pr-preview/pr-1834/src/data/invalidation.js\":\"a7b2b505a75cbce4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/kernelDataExtension.js\":\"d3d016e4873ac30e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/kernelPage.js\":\"47844c0d402ce67b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/kernelValuePresetCores.js\":\"7fe5428e3dcc00ee\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localDbCorruptionSignal.js\":\"88710c7a40ffb4bc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localDbStorage.js\":\"1e0b3a0fd85325f6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localDbVfs.js\":\"d52ed91a45a3e456\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localSchema.js\":\"1d410721262ce421\",\"/knowledge-medium/pr-preview/pr-1834/src/data/maintenance.js\":\"f9663045b6787319\",\"/knowledge-medium/pr-preview/pr-1834/src/data/mergeProperties.js\":\"19e29386ac593906\",\"/knowledge-medium/pr-preview/pr-1834/src/data/metricsConsoleHook.js\":\"f34f34ee25fa8715\",\"/knowledge-medium/pr-preview/pr-1834/src/data/migrationsPage.js\":\"abb3ac27bdcff558\",\"/knowledge-medium/pr-preview/pr-1834/src/data/mutators.js\":\"5701a46b5c2d0e2b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/orderKey.js\":\"95663968b04ff9a1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/orderKeyPlacement.js\":\"14fa8741dd73db8a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/outlineSurface.js\":\"14534ae7c1bfd785\",\"/knowledge-medium/pr-preview/pr-1834/src/data/pendingEditorContent.js\":\"04989e41282536fd\",\"/knowledge-medium/pr-preview/pr-1834/src/data/pendingUploadsSql.js\":\"0b712e266713d553\",\"/knowledge-medium/pr-preview/pr-1834/src/data/pluginStateExtensions.js\":\"6cb7ce7fbdbf1440\",\"/knowledge-medium/pr-preview/pr-1834/src/data/powerSyncLogger.js\":\"fba48ceecaacaa27\",\"/knowledge-medium/pr-preview/pr-1834/src/data/projectorRuntime.js\":\"1d68804aa82673c8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/properties.js\":\"1e6c7233bdd97a95\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertiesPage.js\":\"b245b58dae149ed4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyChildren.js\":\"37416b01c4d4b566\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDefinitionFanout.js\":\"ebf3bb2c69cf0efc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDefinitionMetadata.js\":\"0e64368f6370b115\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDefinitionRegistry.js\":\"b3b0f870f8d3fa96\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDisplayMode.js\":\"afab53834c886fab\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyRowCreation.js\":\"d729e44a6e09aa93\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertySchemaCreation.js\":\"a8bd8478ffcb8fce\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertySeeds.js\":\"8adde4fd7680a26b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/recentsPage.js\":\"72d7e11e16de4d0f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/referenceBlock.js\":\"841cb13038b93780\",\"/knowledge-medium/pr-preview/pr-1834/src/data/rejectedUploads.js\":\"55d73624f88881b8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/releasePowerSyncConnection.js\":\"2f09e584b66b325c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/repo.js\":\"558259a19d14967f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/repoProvider.js\":\"7e579f534e237f02\",\"/knowledge-medium/pr-preview/pr-1834/src/data/rowProperty.js\":\"13f4f7ac3f83ed42\",\"/knowledge-medium/pr-preview/pr-1834/src/data/searchFilter.js\":\"30aa9203c31d0024\",\"/knowledge-medium/pr-preview/pr-1834/src/data/seedIdentityLedger.js\":\"edcbcded7dcdc298\",\"/knowledge-medium/pr-preview/pr-1834/src/data/stateBlocks.js\":\"7c98d4da946c5f08\",\"/knowledge-medium/pr-preview/pr-1834/src/data/structuralEditPolicy.js\":\"f5db759c2afe2f4e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/subtreeDelete.js\":\"65d071b614d08dc6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/syncStreamLock.js\":\"e75746b2689edd6e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/syncedTableSqlRecognizer.js\":\"ad73cedda13164cc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/syncedTableWriteGuard.js\":\"4bd84f9c2125a868\",\"/knowledge-medium/pr-preview/pr-1834/src/data/targets.js\":\"3e1604c7d1633106\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeColors.js\":\"1deffa285166fd9b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeDefinitionMetadata.js\":\"2732b7c0f96b6d96\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeDefinitionRegistry.js\":\"c76c0ee43e13d49a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeExtraction.js\":\"92da50b5b6a208db\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeInitialValues.js\":\"34a6f61e18e55c3b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typePropertyGroups.js\":\"e090cfc2ca7c7276\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeSeeds.js\":\"30d895424417586c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeTagger.js\":\"dbc9061015ec049a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typedRecords.js\":\"fb2f00ca754815ae\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typesPage.js\":\"42ff31678802d528\",\"/knowledge-medium/pr-preview/pr-1834/src/data/userPrefs.js\":\"155c6a3ebf076373\",\"/knowledge-medium/pr-preview/pr-1834/src/data/userSchemasService.js\":\"f38d326dbca8c4a4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/userTypesService.js\":\"3c311d51c551023b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/valuePresetRegistry.js\":\"0b0f1aaec91b851e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/visibleChildren.js\":\"f38c38f51b8ab139\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceConversion.js\":\"0bc2cd62913f1463\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceFirstSync.js\":\"9ff986cca74c97d3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceIdNamespace.js\":\"f5501efeeecf400a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceSchema.js\":\"b306cce82196f00e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaces.js\":\"50049a44d767ada4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/writeAheadLog.js\":\"e9f52f464df56b6d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/BlockPasteShellDecorator.js\":\"d7ca3f1a48fc336a\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/atTrigger.js\":\"de49331f7de3cbcf\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/autocomplete.js\":\"1b891eea2faa7541\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/codeMirrorExtensions.js\":\"0c26d8d2fd5c965c\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/contentFlush.js\":\"e62db4598bbc0ff2\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/defaultInteractions.js\":\"92fc1e60395dbf2d\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/editSettleSignal.js\":\"a981b3675c7bbfea\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/insertImage.js\":\"4317e5ecc638187d\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/referenceCompletionRange.js\":\"790075db4c1cc816\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/referenceTargetTypes.js\":\"a41008d1fad09a9b\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/syntaxContext.js\":\"49b88d84c8ad0dee\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/triggerMatch.js\":\"9aef94bd365f1fac\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/AppRuntimeProvider.js\":\"6847a12d62c7fc33\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/BlockFocusShellDecorator.js\":\"2280345135cdbb2c\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/ExtensionRenderBoundary.js\":\"2f817c981341a774\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/PanelContentRecovery.js\":\"e9f6df02cb370e74\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/apiCatalog.js\":\"28c8a316ee43603d\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/approveExtensionHere.js\":\"4796d07bd6550ca9\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/armedCutAppMount.js\":\"9a70eb82150b3b15\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/batchableKeyedStore.js\":\"ceb3f8e5cb8d6cb7\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/blockInteraction.js\":\"01ca08bbb7ea154b\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/blockSelectionAction.js\":\"88aa4824afe2981e\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/compileExtensionModule.js\":\"8111252dd7ec262f\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/compiledModuleCache.js\":\"971af778ddd17de1\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/continuousGestures.js\":\"ec26e139616419d6\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/core.js\":\"a593a0052650b332\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/defaultRenderers.js\":\"0a17dfe5684448fe\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/definitionFanoutAppMount.js\":\"7959170d735b8b1a\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/dialogAppMount.js\":\"84477714c3eb933b\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/dynamicExtensionSeeds.js\":\"9493dff8711f82e6\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/dynamicExtensions.js\":\"48b22ec3f1c6ae5b\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/exampleExtensions.js\":\"ff95ede40a53f0db\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionApprovalStatus.js\":\"44f7c2182ff3e652\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionLoadErrorToast.js\":\"1c8566cbc59d0503\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionLoadErrors.js\":\"e75ac6682004532c\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionLookup.js\":\"c8219f96af3d2990\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionToggles.js\":\"fa8b53865e0c13ef\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionUtilitiesCss.js\":\"00e3a1b72ba0f876\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/kernelPageDeletionGuard.js\":\"d0fe35f05c3e6652\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/liveRuntime.js\":\"8e1940fd8269f6a3\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/openExtensionsSettings.js\":\"141e56d6d70a8ff1\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/overridesCache.js\":\"cc02cfb2d0617a0b\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/pluginIds.js\":\"c4431f18101f7643\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/processorRejectionToast.js\":\"d5acca6750437f53\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/runtimeActions.js\":\"703b171e1d999e21\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/runtimeContext.js\":\"6dce81750fbb75f2\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/staticAppExtensions.js\":\"b3a2adb7a5d3012e\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/staticDataExtensions.js\":\"4aa3e7def4590381\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/toastAppMount.js\":\"d6fef6f2a8c1adb1\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/useOverrides.js\":\"84c27368e30de2d6\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/useShortcutSurfaceActivations.js\":\"4dc21c68b1141bcc\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/discoverToggleTree.js\":\"03cc66ae3fb1d9fd\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/facet.js\":\"6eaf4ab9eb182588\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/resolveAppRuntime.js\":\"f395568f3d9324f8\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/runtimeEvents.js\":\"f924eaf75db1dd6f\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/togglable.js\":\"1271c5a38ff7f8ec\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/variantFacet.js\":\"0c263e86145e2104\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/verbFacet.js\":\"73108d5f9b6b241c\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/block.js\":\"4dc5e995e8504e7f\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/focusedChild.js\":\"f1c676d033a94b4d\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/propertySchemas.js\":\"422303a6ed146927\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/typeRegistry.js\":\"32e66576d2082a6f\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useAncestorCrumbs.js\":\"a700ce3146836f01\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useAutocompleteListbox.js\":\"e30d669cb773de27\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useDebouncedSearch.js\":\"c784a5b3b517e51e\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useDebouncedValue.js\":\"876dd132f81787ba\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useIsFocalRender.js\":\"4916150ea165a99d\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useIsReadOnly.js\":\"089436544892502f\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useMaterializeBacklog.js\":\"bbdcff836cc9c172\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useMinuteClock.js\":\"8c63dff1762dd239\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/usePanelLayoutProjection.js\":\"914ddd251792bdbc\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/usePendingInvitations.js\":\"34fa35295406ea4b\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useRendererRegistry.js\":\"5e590bee7c29d270\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useRetainedFieldRows.js\":\"a6e9ce6aa9da93e3\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useWorkspaces.js\":\"f18f82cd982f0195\",\"/knowledge-medium/pr-preview/pr-1834/src/lib/utils.js\":\"1a1d7209b7478dc5\",\"/knowledge-medium/pr-preview/pr-1834/src/main.js\":\"a36feb36ac493d38\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/MarkdownImage.js\":\"e2f2bbfe83c1bf2b\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/blockSeparators.js\":\"60c33992c9ee374c\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/context.js\":\"f51533363d0b640a\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/defaultMarkdownExtension.js\":\"c87db183b6bc5eee\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/extensions.js\":\"601facf57272bff6\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/renderMarkdownHtml.js\":\"7a41129481a7237d\",\"/knowledge-medium/pr-preview/pr-1834/src/minimal-editor.js\":\"47cfa991e7fe21a2\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/armedCut.js\":\"9fbf78aa8867004c\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/captureMediaVerb.js\":\"d093a775b9459a42\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/clipboard.js\":\"dd18c53b778b7178\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/decision.js\":\"646ea8265744d087\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/operations.js\":\"28d3a84c93dfb952\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/account-header/AccountHeaderItem.js\":\"bd9f811567a62ac6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/account-header/index.js\":\"3f11e074c9b60784\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5022e9a1de1aa164\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/askAgent.js\":\"8004a80ba142c5f6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/askedStore.js\":\"3ccc16312d13a4ed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ed50b311116606b0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/chipState.js\":\"1f5d24ba3410ec8d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/dataExtension.js\":\"362d4f39f2315a40\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/index.js\":\"c42686d0f7d55d3d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"14ac5564eba7985d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/schema.js\":\"553486ec65543578\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/AgentTokensDialog.js\":\"411a1133dec56ee1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b3486a4bc8564d35\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/addMedia.js\":\"497e14f578fcedb6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6a2a372d4461bb33\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/block.js\":\"f19dff5b39e8c6ca\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/context.js\":\"d681313eb599c3ff\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/displayIds.js\":\"78cc6e1b9137f2e7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/index.js\":\"96c0cc990df07c9f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/outline.js\":\"064c3fe49afa64e8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/properties.js\":\"cecb54f31035860f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/refs.js\":\"16c72e805f81b3d4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"25758cd64fd3c66f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/search.js\":\"e57ebc61c65c1d49\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/shared.js\":\"0b43f444d0609a40\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"92c858ccc84df685\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/text.js\":\"c9eb13df70142875\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentWrites.js\":\"4447aeb699addc06\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/authoringCatalog.js\":\"6d171042112c76a3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/blockRefTargets.js\":\"451c205eb3dc2f3c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/bridge.js\":\"3ad1c1f13efdf8cb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/bridgeLoop.js\":\"b0536fefd2e961c7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/changeHistory.js\":\"8d422b37e4c8bac0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/commands.js\":\"5a86e74c7d905c7a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/commentsCommands.js\":\"25a25edf5fb43685\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/dataExtension.js\":\"bef383f699badc17\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/dataModelGuide.js\":\"a7def5cdfb7fa295\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/describeRuntime.js\":\"a9b15f36bd018d7a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/extensionLint.js\":\"2bd3f993936a02ee\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/grainAudit.js\":\"5487e70c6c00d823\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/healthCommand.js\":\"aa85ba40b8865af4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/index.js\":\"f5d4065b52f49ba6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/presetIdentity.js\":\"3ea022b7cf032b59\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"016077cbeac7ac2a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/readMedia.js\":\"3c298e80e8a0ccaa\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/schema.js\":\"68ab3419044410a6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/serialization.js\":\"cc7745bf7baa9537\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/targets.js\":\"f94bb20bda952063\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/tokens.js\":\"5ca088cdc0eedb9d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/watchEvents.js\":\"9378e7e42c4d2a5f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/workspaceGuard.js\":\"c558b40ba87c92a9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/writeCommands.js\":\"4e84827b2b963ba0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/AliasCollisionToast.js\":\"c8a45367acaf0bd9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/DuplicateNameBanner.js\":\"68c83695068e5662\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/collisionMerge.js\":\"ddd57c87ad4cb3be\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/dataExtension.js\":\"bd03f046b32bf29a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/index.js\":\"c836dbfdad0ab2e7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/mergeCollisionAction.js\":\"70c53891fc4712d0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/pageStyling.js\":\"512a733002b0435d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/rejectionToast.js\":\"8b6601046db34335\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/syncProcessor.js\":\"aea969228e21405e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/actions.js\":\"84d388dc4db5fb56\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/addComment.js\":\"2cce8f595a08121b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/anchor.js\":\"6fe052da7ced217b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/anchorState.js\":\"8af84ae329d065ad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/commentLinks.js\":\"5bebcbf06f1dc243\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/confirmThreadDeletion.js\":\"6399ce432991c705\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/container.js\":\"0eebba39bdaa8710\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/dataExtension.js\":\"bc18296e685d756e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/deleteComment.js\":\"30b02e123c45db1f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/highlights.js\":\"83d46c8a8cab9bd2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/index.js\":\"73480f2bf959b595\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/linkedCommentsPill.js\":\"0cd84820870cb927\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/margin.js\":\"caa515fc343fd620\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/marginSchema.js\":\"727e6dc127c9d134\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/newComment.js\":\"ae91184ca7e98a5c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/ownThreadPicker.js\":\"0db3769295625e23\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/placement.js\":\"3bb7b9661585deb0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/queries.js\":\"ebfdb18f219f40a0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/quotePosition.js\":\"97b4cd40e32e8d2a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/quotedIn.js\":\"eed3b61090a3aad6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/quotedRange.js\":\"84de47a92af453b2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/rangeRefs.js\":\"0c463d78d7764ca4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/readHighlights.js\":\"0202da1ad5340947\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/readSelection.js\":\"fb7aae3697558190\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/readSelectionUi.js\":\"1a0d3157ad961460\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/reanchor.js\":\"77a8db0af9a9dd1f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/schema.js\":\"c17af41c0192232b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/scope.js\":\"4fe0c90c96f4ae26\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/scopeThreads.js\":\"973c1712f20324ae\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/splitRetarget.js\":\"65244f92fe577995\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/suggestionCard.js\":\"c9961046fbdbc580\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/suggestions.js\":\"56dffe3b0815fd61\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/summaries.js\":\"577dff67866600ff\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/summaryBatch.js\":\"a1eb8351907da496\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/surface.js\":\"8579b08464369a7b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/threadNavigation.js\":\"9e5223f7f7b6f799\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/threads.js\":\"ccf8bab1b083d60a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/ui.js\":\"c9def029e008d8e2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/uiStore.js\":\"5d6c4e4b978b7648\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-intents/appIntents.js\":\"aa00e3aea31d39f5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-intents/index.js\":\"4d4f3e5394faf509\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-update-prompt/index.js\":\"f90f82e1dd32cc9c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-update-prompt/status.js\":\"b36513d6bcd97b24\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a7a78343c712b995\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/MediaBlockRenderer.js\":\"2a378766afbccf0b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/MediaDownLaneReplicator.js\":\"da05e0c91a010886\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/MediaUploadReconciler.js\":\"1dbc3e485ccd2237\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/assetDownLane.js\":\"c59932b420a6d875\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/assetResolver.js\":\"1a147586f0d18a38\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/assetUpload.js\":\"bd55f2a5b654aac8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/attachmentCleanerIO.js\":\"5013ccd3a23bc273\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0deb1ec696e94710\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/blobStore.js\":\"7c64dfe0bde260c5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/byteStore.js\":\"34283a8236c29dd5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/cleanerIO.js\":\"9d3fa5ca8704880b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/cleanupAttachments.js\":\"ae331f8498d37128\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/dataExtension.js\":\"e2673da57897f8a3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/downLane.js\":\"d5710bd92fe71aaf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/index.js\":\"52429b5de2e9e7c4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/insertImageContribution.js\":\"a10657cfabe60997\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/laneArming.js\":\"3d9d2e3d418311e6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/laneLock.js\":\"ef934f1c26e87262\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaBlock.js\":\"4e774de65228b94e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaCapture.js\":\"6c117a0f0a76b29b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaViewers.js\":\"df514f7bd73ca8d8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaViewersFacet.js\":\"d14947403d6219f5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/pasteCapture.js\":\"159cb4bb702003fc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/resolver.js\":\"d7af2e6ac605a9ae\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/retryUploadsAction.js\":\"41106e74daab884e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/storagePaths.js\":\"4807ad04658b5e7e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadDrain.js\":\"b0e0c097ae91f79f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadLaneStatus.js\":\"30c89c37b41c1398\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadReconcile.js\":\"927f04f337be7b04\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadRecovery.js\":\"797e3cbc4684866f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadStore.js\":\"817eec6da28b2792\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/useAssetObjectUrl.js\":\"669d7b8142562ad0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5d473c8c2eff5839\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/BacklinksViewSection.js\":\"29760cf47a2716d3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/facet.js\":\"200ea45c3078d740\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/index.js\":\"3a72edb264c5b9a2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/prop.js\":\"1e74d18ca0237ab5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/BacklinkFilters.js\":\"bd24ae714466acc1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c6a2a04dd8573b41\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/BlockEntry.js\":\"4cc7c17f002155bb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/LinkedReferences.js\":\"734ce3498864fdeb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b603747c301b93d9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/dailyNoteDefaults.js\":\"f1d9fa1765c96075\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/dataExtension.js\":\"1f086535c86506f2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/edgeExclusions.js\":\"41fd6b2c9c706259\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/filterProperty.js\":\"89a9ac45a380a2df\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/index.js\":\"01137da1ea431aa3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ae04ac015f31443e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/applies.js\":\"808a69137cdf3e8b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/countQuery.js\":\"383e8b48c5d40eea\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/expansionStore.js\":\"59380b12627f7e27\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/index.js\":\"6a8de82efd61aa42\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1a7b668fdcc2b80b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/presentationInvalidation.js\":\"7d6b64d690fb0ea1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/propertyEditorOverride.js\":\"c9fdc6d9772c5d89\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/propertyFilter.js\":\"457288ffc03ad200\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/query.js\":\"e5e40510b367bfe3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/resolveFilter.js\":\"578430348d63b1cb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/sourceBatch.js\":\"50d2c47b594cbf62\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/sources.js\":\"0cb52d643a06f519\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/useBacklinks.js\":\"8c5e87f960c1e789\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"90871b421ac19b94\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/BirthdayCelebration.js\":\"8fb89108f118e06e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/BirthdayOverlay.js\":\"0472de5ef664f792\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/gate.js\":\"ff8d1c51a18e1e66\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/index.js\":\"4a031d6d3bb2b871\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/wolfTheme.js\":\"6901f736a1c108af\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/BlockDragLayer.js\":\"05d3ee748a9ea53c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/dragController.js\":\"2a93200d37d25eaf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/dropTarget.js\":\"d784c29eecc109bb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/index.js\":\"448087ae3a4d5987\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/projection.js\":\"083db56570fcf1af\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-info/BlockMetaCard.js\":\"3f87134d40416672\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-info/index.js\":\"7cf1b64601caf01c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/AddTagDialog.js\":\"1b9fc246687f6246\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a2c89118e0ef3ff5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/TagNameIssueHint.js\":\"bf9d5cdb7d65d604\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/addTagAction.js\":\"167868aa6a53a99e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/appendTag.js\":\"0b7d43b103132134\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/config.js\":\"a60a1b6749b8def3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/dataExtension.js\":\"7cd6dab7e2f29ec9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/index.js\":\"46f843dcc265bc4c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/propertyEditorOverride.js\":\"2227601d31a5843a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/BreadcrumbList.js\":\"66d0a4f586ccbbaa\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6bd0c78b068c88e3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ee2ea9d0b19061de\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"73eecfb41ec3c2d0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"80d2d4fd9248fa2d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/index.js\":\"d50bfd7da2dcc74a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"65895c9634897a3d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/CharacterCountItem.js\":\"bba9c43fd3828dd4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6f90863f216b539a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/actions.js\":\"264c0570fcdad825\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/blockType.js\":\"6d89f76f8abac905\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/charCount.js\":\"7488bb7eaa51ccc4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/dataExtension.js\":\"a214d62888c8315f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/index.js\":\"49773306a6d75d00\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/profiles.js\":\"7733313e6824385d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/properties.js\":\"034b3394aae8adf2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/textCounts.js\":\"96bbf63e89a0f547\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/colemak-keybindings/index.js\":\"5052c6ef201ea2c3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/CommandPalette.js\":\"d73edc9bcc13925b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/HeaderItem.js\":\"844fc37f72aef18d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/context.js\":\"35ca5bc0cbc188ab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/index.js\":\"0558720a0518ef25\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/selection.js\":\"d74044fc54033198\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/toggleStore.js\":\"cc3de316cb202594\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/useCommandPaletteActions.js\":\"ec4475c0db4508a0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/ContributorBadges.js\":\"0b76977637631e47\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/author.js\":\"0f82b7c8b156324b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/codeMirrorExtensions.js\":\"79354a7f13a38f8a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/dataExtension.js\":\"4c2b5afb32d49373\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/index.js\":\"758d99358b62b30b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/mentionAutocomplete.js\":\"ddc24c99a88357ae\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/processor.js\":\"8425a121184bd742\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/profiles.js\":\"7010594a241d375c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/queries.js\":\"bf3c33339f915239\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/schema.js\":\"0d4c617199151209\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"93c54e8a38ac841d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4cc1138bae2b6f02\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/index.js\":\"97c8c6b51ce11f69\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"8203de5e7e894e25\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"dd77da31e5a6b703\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/CalendarGrid.js\":\"78fcd7483ecc5603\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DailyNotePicker.js\":\"d488dc91a747337e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"af6dc080d987c813\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DateNavDecorator.js\":\"ad625f6e18676c02\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DateScrubOverlay.js\":\"eaebbbc83bf1af54\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/HeaderItem.js\":\"ca5d30690e5ecff7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/ReschedulePicker.js\":\"69f9dcfcc74461f0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d70c309190902c03\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/actions.js\":\"79e7c8ed518fbfe9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/blockDateAdapter.js\":\"a5c4c1e60bdaff1f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/calendar.js\":\"deb69e3818706856\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dailyNotes.js\":\"3d96534f76d330ba\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dataExtension.js\":\"6056e640999f7a89\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubActions.js\":\"586b02d853c6dbb8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubGesture.js\":\"3f5005ab2a07a200\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubGestureActions.js\":\"18b29f635c53ec57\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c84e1a578e17b453\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/deletionGuard.js\":\"cea676c65748d2c6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dueQuery.js\":\"37b0e52e7f4769be\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/index.js\":\"7c63b91f33ba0d8d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/landing.js\":\"d649685fc2133ef4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/localSchema.js\":\"e5ab422ee5e136f6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/referenceDateAdapter.js\":\"da4b7e65afab9894\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/rescheduleAction.js\":\"2824be2cbc205f94\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/schema.js\":\"e720d333a412157c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/spreadBlockDates.js\":\"c0f06dc4d2b739b0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/spreadDatesAction.js\":\"a5c5bb52f56718fc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/today.js\":\"85966b0c18cca63f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"506e0d21f9c15d6a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"68f13cacaaa77ece\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/audit.js\":\"361f5e77238e7fc2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/auditAction.js\":\"fe57c9e4d6806445\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/auditRanges.js\":\"92a618462ef29f9a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/diagnosticsSource.js\":\"1d4ebf0a5e4b8277\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/divergenceScan.js\":\"5d6283ee9adcefa7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/index.js\":\"fc2fe0bf5d82e24a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a3295a7e9d0ba3a7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/referencesMirror.js\":\"665f5350f5c21207\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/rowJson.js\":\"0fd102b1ead65aa4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/schedule.js\":\"e34f761ba139b58b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/store.js\":\"7e16f16d86cc81bb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-maintenance/action.js\":\"769bfbcd8939cf95\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-maintenance/index.js\":\"db7dbce0e587ffd3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-maintenance/plugin.js\":\"ed10fe02c24e5ee2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0efb7a46d5f345e9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/actions.js\":\"53ef5777f71761aa\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/changeMarker.js\":\"24dfbf6f210e434b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/diagnostics.js\":\"056c9690cf392502\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/fileSystemAccess.js\":\"6a402138adc1e1e6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/filenames.js\":\"5a67ca23a0f88e2c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/index.js\":\"7d8ce00bb60e6c12\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/mirror.js\":\"fb963d3a0477665e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/runLock.js\":\"ff8ed05dd9751d09\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/runtimeHealth.js\":\"d5ff86c9207d4e6b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/schedule.js\":\"11d8a7c35c7a4d23\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/store.js\":\"a9ca4b5d56dc672e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/default-themes/index.js\":\"d844ce4c358bf43d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/default-themes/themes.js\":\"d41d089f08b8160b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/diagnostics/facet.js\":\"39828270c9cf192b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/diagnostics/useDiagnostics.js\":\"e4951acd3922c85f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/dismissals.js\":\"01d09b811cb4bd57\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/index.js\":\"1f08d7b7d82f8b25\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/status.js\":\"035e32f15e0a52da\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/store.js\":\"2c9f3cca1aa42fb2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d2765958d50ca98f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c7a7c096d34479a0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/actions.js\":\"fa31841114f37374\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/config.js\":\"f4ec3636a5d7f1c2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/dataExtension.js\":\"e651d20101d83324\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/effect.js\":\"1ce2c6b756aeff0f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/index.js\":\"a596ccf41a933950\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7e95dde9509d99b5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/useToggleTree.js\":\"bf60f38b073dec88\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/ExtractTypeDialog.js\":\"9e73105cbc692faf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"37a67692eb39489f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/PropertyShapePicker.js\":\"09536c6d8811055f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/action.js\":\"8016a5edf57147e7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/index.js\":\"f751e213bcd905af\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/FindReplaceDialog.js\":\"851e3bd72ae143ea\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/HeaderItem.js\":\"dacaf7b4969cb616\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/dataExtension.js\":\"9d67aeb08572d1d0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/index.js\":\"0e1e8ae7f9068314\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/search.js\":\"f2673940db43aa7f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/toggleStore.js\":\"3b9b2ea243da3650\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/LocationPropertyEditor.js\":\"a64097a32dbd03e5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/MapView.js\":\"943b4ebc01833ed5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/blockTypes.js\":\"c12e6f03b27ee95d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/codeMirrorExtensions.js\":\"416415ee6cbbd17c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/createOrFindPlace.js\":\"7e4c336491ff8362\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/currentLocation.js\":\"392e62c93fc5f07d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/dataExtension.js\":\"a32a9dcf7acf8165\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/geoContentDecorator.js\":\"a1e703ab0a6de759\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/googlePlacesClient.js\":\"9c2a1d8a6fb4f5f9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/index.js\":\"20d9f98ec3a2cff2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/locationsPage.js\":\"b3dc3c7267aa792f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/mapViewport.js\":\"707af348b24d6a0a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/pickCurrentLocation.js\":\"ad299f99fae23240\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/placeAutocomplete.js\":\"3648dcecf4aaa090\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/placeNameCollision.js\":\"c029442bc2cc2bcb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/properties.js\":\"01f1a8df8bd0b9c9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/propertyEditorOverrides.js\":\"21e3913c1df7fae1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/query.js\":\"a29cd4adb044b697\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/usePlaceSearch.js\":\"9e520efa756cc618\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"218475798b459127\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4f5bde679bfc59ef\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"24f882b211fe0a2c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/config.js\":\"e613b4ddf7436a1e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/dataExtension.js\":\"b3d67d572a8d8b89\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/facet.js\":\"19af817ccf80193f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/grouping.js\":\"d7b471354bb0917c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/index.js\":\"643efd3fbae5c107\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"645ea5c0bfbc9490\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/query.js\":\"0182ac2f8550ffff\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/resolveConfig.js\":\"8d3c6a8aae64cd1e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"eef735a6aa4881ac\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"554ca903ed89ff02\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/HtmlDocumentContent.js\":\"ab08956b93a2da12\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/HtmlFrame.js\":\"777d50786b1ce965\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/actions.js\":\"a6f07fc2d0af4a26\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/blockType.js\":\"b45a6aa3dee27779\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/confirmRunScripts.js\":\"5cabb2a30a4a3e4f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/dataExtension.js\":\"2e481b57a9c926c6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/frameAnnotations.js\":\"a9032b21d0940d34\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/frameDocument.js\":\"74df8341ed5f2f1f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/frameTheme.js\":\"5f9ac3fc8490e1b7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/index.js\":\"60efd8720428ac0a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/scriptConsent.js\":\"9030a099dd3ee9ed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/sourceMap.js\":\"d4124ea12ccc27d2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/useDocumentScripts.js\":\"1bde2278fc0f47c2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/index.js\":\"4e5de5244c166352\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/record.js\":\"e18ba6502a328b9c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/recordStore.js\":\"f8ed8d72576c4521\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/responsiveness.js\":\"3727cc2509171fd5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/schedule.js\":\"cd9cbabe2c2b99f9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/sessionContext.js\":\"7681354ec5e47dea\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9cb4ec8c03cd341b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ded9699978d50830\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/actions.js\":\"2e714f6e3b6d3a3c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/config.js\":\"c0e232e48005487d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/dataExtension.js\":\"f32d51926e805262\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/effect.js\":\"4b0e5181384e973a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/index.js\":\"3c3012ce14205fa2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/keyCapture.js\":\"fadb1085805fe246\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/overrideStore.js\":\"bdcad6736fb63c55\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"455e0a4246737772\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/HeaderItem.js\":\"96163d3ca6beb6d6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/LeftSidebar.js\":\"ce1071067eb263a2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/actions.js\":\"82f109c94afb6913\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/facet.js\":\"385c9b44d0a6398d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/index.js\":\"cbb31717cba28f67\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/shortcuts.js\":\"703662aac2057724\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/toggleStore.js\":\"51174997cd5b25ce\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/MergePicker.js\":\"aaf62e037d6ce81a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/index.js\":\"b90513693ef7f2e6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/mergeAction.js\":\"6bd8865924b17399\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/strategy.js\":\"1f1555423d6d47de\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/Button.js\":\"5ded7db5aca3792d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"47a40f3b5499da27\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f2d84a933e810e1c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/facet.js\":\"6137ec545ba70332\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/index.js\":\"6c812bc880cfa4f9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c51d5266debf2274\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/actions.js\":\"36eb88bbd5d491c0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"727aba15a693af74\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ba79e179ff91556f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/index.js\":\"ccbebd398b1a358b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b49e8f2bf054da0b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/blockSubtreeMembership.js\":\"93458d5250c6b6b0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/contextMenuItem.js\":\"5a204d3ddf7c1024\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/index.js\":\"e992ac5707009055\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/moveAction.js\":\"bea1aacb97beb790\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/moveBlocks.js\":\"fee951e7e21d9188\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/selectionAfterMove.js\":\"b6a20ea44871f6e2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/TutorialBanner.js\":\"7a8fac99d14b64e4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/action.js\":\"c9a9767cc860c08b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/bannerDismissal.js\":\"806ba89e11ceb046\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/documents/cheatSheet.js\":\"ba9b5f6c5c6153b6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/index.js\":\"3cb50c8b345900ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/keys.js\":\"b46a0807f54fb505\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/landing.js\":\"889f5bbdd23eb3a8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/outline.js\":\"54202c21a0577511\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/seed.js\":\"b4dd777f8b560554\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5d735c8f23d29066\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/analyze.js\":\"b76c40a6cccf9306\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/diagnosticsSource.js\":\"82284cae3502aa6a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/index.js\":\"f31d94ff10bd2361\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/load.js\":\"a5abc13d8c271373\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/monitorRun.js\":\"712def0a4569c94b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/schedule.js\":\"74872697d8557358\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/series.js\":\"d58abaad3c2b6bda\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/store.js\":\"f6c65dbdfeb33a40\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/trendAction.js\":\"557775f186dbcdbc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/verdict.js\":\"9f9c56ed7e46e470\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/plain-outliner/clickToEditAction.js\":\"7983e13d0b63721c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/plain-outliner/index.js\":\"6cc5e490f2d91f2d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/plain-outliner/interactions.js\":\"987f40a56451eae0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"82145b15dbb1b7ab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/MigrationGate.js\":\"18ce7ff2e6f090b3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/MigrationGateDialog.js\":\"0cf8415f91fd0900\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/action.js\":\"eaa259f896153e7d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/index.js\":\"d79beb1a3b26b998\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/localRunMessage.js\":\"a247cff4d0d57745\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/plugin.js\":\"0150cf46c5473ef6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/progressReport.js\":\"015dc6819a776f5a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/sweepProgress.js\":\"445393e95cfb8694\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/FieldRowRenderer.js\":\"436311bd1cd1c614\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/ValueRowRenderer.js\":\"5f9963b1ffd52ddd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/actions.js\":\"90e76560a3c7883c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/autocomplete.js\":\"0e6cec577670963c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/fieldRow.js\":\"09eaa34fb71ff97b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/index.js\":\"3e81bc64232901f1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/referenceWarning.js\":\"40305b613adae619\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/valueAutocomplete.js\":\"18970e71cbfda996\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/valueSchema.js\":\"b55056c70e91518d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/HeaderItem.js\":\"bed2bfda06f7780b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/QuickFind.js\":\"f0cc05f667bbbc57\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/index.js\":\"fb4cc29237cf8a3d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/recents.js\":\"7ce7c3927a7d65ba\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/resultItems.js\":\"8f0cdb5057b4c771\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/selection.js\":\"a60913abccee12f2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/toggleStore.js\":\"ccf96fb769d0109b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/HeaderItem.js\":\"bc70fb882bbfea7e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0bc1cd0e73f5c83e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/grouping.js\":\"20a02601ad513a22\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/index.js\":\"dcb58d23897d101e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/target.js\":\"5e7e6fa7a14c77ed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/codeMirrorExtensions.js\":\"5b2a0d96bfd87e62\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/contentPrefill.js\":\"fab7234afba5cdf2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/dataExtension.js\":\"b07eae8a6314480d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/index.js\":\"7c1c56d8b737c422\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2a19c64c7c814c9c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/invalidation.js\":\"7a3fa797c6451616\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/localSchema.js\":\"cf2294794b6f7699\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/blockrefs/index.js\":\"67c6c42b6e5dd881\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c91b9b8f4f03e298\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/index.js\":\"dd5709d8faa044d6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/referenceNode.js\":\"ee20da39be94b3d8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fed331b103544c75\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"fd205a8874a5290b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/index.js\":\"90cec71257a54240\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8c75129158e6608b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1c1f38bd16361ed1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/mergeRetargetProcessor.js\":\"0a538c301a84378a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/parseFence.js\":\"2b3ef75aa3280ae0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/referenceParser.js\":\"7d0c1f7299a8c386\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/referenceProjection.js\":\"d0b4c21725b485c1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/referencesProcessor.js\":\"becf19d5b5d9c5f1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/renameProcessor.js\":\"3670f410a1bcaf7e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/spanReplacement.js\":\"7d0bfde3eb3fe479\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/htmlToOutline.js\":\"642137ba477147c3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/index.js\":\"78f561b11a4caf58\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c5f8c90c37604755\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/pasteDecision.js\":\"81da6ba249d37acd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/action.js\":\"63f5d2d8cd6a00ba\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/blockIds.js\":\"ff0518727175552e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/content.js\":\"fcf8bf68a9897e10\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/effect.js\":\"6bae2d2d57dddc2d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/ids.js\":\"d3d1aaf7cc693d35\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/import.js\":\"1951b849146fb04c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/index.js\":\"ce6ee98a359ee44d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/plan.js\":\"3192f44fd117b53c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/plugin.js\":\"c22e8e280a6823b3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/promotion.js\":\"1547346a785babd1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/properties.js\":\"c20270001d870e95\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/references.js\":\"9130bb295c5740a3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/report.js\":\"84df00b563a974cf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/roamMemo.js\":\"b150a5abb3d46932\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/runtime.js\":\"3f11cdd7d8b861b3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/schemaReconciliation.js\":\"d00728faf391f94b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/srsMarkers.js\":\"8f2d454a5e82f397\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/todo.js\":\"fe5295fc64a20dfe\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/typeCandidates.js\":\"275f979496497405\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/types.js\":\"0dc328c69ab66203\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/search-health/index.js\":\"5a778fc2b296b4ee\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/search-health/store.js\":\"4c8a99e327873b1a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/HeaderItem.js\":\"6e77a7cf78e57bb6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9cdf989bd771c028\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/index.js\":\"c5ae2c6b7b2d8a40\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/model.js\":\"e39699ac4443eae6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/toggleStore.js\":\"40ebf4e351c9ce06\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/useKeyInspector.js\":\"3effcfd4f6dc198d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5bf8fb3380a1eaa2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/ShellDecorator.js\":\"3a00ef003a570a76\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/actions.js\":\"7c0690c943e153da\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5ae41f3d7551b764\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/index.js\":\"f74cfc679a88fca4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/shell.js\":\"b554368009d6e2e3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/surface.js\":\"95fcaaf4d9cbdb5e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/walker.js\":\"a5a118ff5b6fd344\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/RescheduleToast.js\":\"29e58a92302a40a0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/dataExtension.js\":\"052246ddc3a81d85\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/index.js\":\"9ebf4ae30bdcb07a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/indicator.js\":\"85d9d92a73ca38f6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/moveSrsState.js\":\"5937027b7d73e081\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"233af3214dcfdf5d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/scheduler.js\":\"18bc580efeceaa48\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/schema.js\":\"7d4ab084cba279b1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"856ad6404be670d8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/srsClipboard.js\":\"2269397dd45a9b01\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"3f840d4b92777589\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a7a8658444e72e7e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/DeckPicker.js\":\"63d0ff1602d42ab9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/ReviewControls.js\":\"49c0ba68fe75f32a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f6c2133c610faa86\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/ReviewSession.js\":\"c396b4a825174944\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/actions.js\":\"22ddfff144531af5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/archive.js\":\"3dc7b9704bd9ac2a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/dataExtension.js\":\"fb37ada7c2a0d003\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/deck.js\":\"b5a58c1a89022e9c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/dueQuery.js\":\"4251e4141cb4b46f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/gradeDecision.js\":\"0b5b65a2a1353f88\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/index.js\":\"25f057c9367a02fc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/keyHints.js\":\"7bd6ee778490f28c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/reviewCardLayout.js\":\"ab534221e614d978\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/reviewProgress.js\":\"c179c4c9cfb40ad0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/schema.js\":\"3b689add8c7417cc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/useDueCards.js\":\"22a5755184b1a335\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/startup-metrics/index.js\":\"414daa961c8442a1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/startup-metrics/record.js\":\"e65415c9a11fbe30\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/storage-persistence/index.js\":\"c57997a96bbce377\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/storage-persistence/persistenceStatus.js\":\"d451a28415b0cb1a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/storage-persistence/requestAction.js\":\"03cc01435892e90b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/TypeChipsDecorator.js\":\"e7ff384040e7208d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/codeMirrorExtensions.js\":\"2bd368129a816374\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/index.js\":\"ad33bdfbf80a7f55\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/typeAutocomplete.js\":\"009e651f8333081b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"14e2c9a2a42e8394\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/actions.js\":\"7e355d3b63625586\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/anchor.js\":\"6995e7efb48ca4e2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/events.js\":\"46d6e6b2c0ac1aca\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/gestureActions.js\":\"f91ccd0184739159\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/index.js\":\"5a8fd9d3bbc135a8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"61a9c8b4b595436e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/sync-metrics/collect.js\":\"3558624990dea20e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/sync-metrics/index.js\":\"1f183bb9b58cd7a1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/sync-metrics/record.js\":\"5ae59ca0476241b0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/RejectionDialog.js\":\"682c2e187f292513\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/SystemStatusHeaderItem.js\":\"54ed04d828b75d6f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/index.js\":\"bc411197ae7133fa\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/model.js\":\"6edcdd9b130d373b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/queueCounts.js\":\"78cb0b8b71cb6e2b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/rejectedHelpers.js\":\"8449878987d0cd74\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/rematerializeAction.js\":\"5e940b892ce00fff\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/useHysteresis.js\":\"c31f09aa41fdce56\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/ColumnHeaders.js\":\"18686835fd34839a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/TableLayout.js\":\"1f16aa27a4ab873b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/actions.js\":\"a46b2fc0346ef7a3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/cellEdits.js\":\"e9ad2b8943c3c3c2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/columns.js\":\"0ee71e0e6da53664\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/controller.js\":\"1b46a734b2be09fb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/convert.js\":\"6c54d6c04fafbe2c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/dataExtension.js\":\"460ef845cbdbf78b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/index.js\":\"b5ee429da38967b7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/keys.js\":\"9f0d73cb9c83a47b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/model.js\":\"0296960de2938391\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/registry.js\":\"5a79133b7e2ba063\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/schema.js\":\"b00b5369812ff205\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/theme-toggle/effect.js\":\"69dc751b313270a5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/theme-toggle/index.js\":\"91a0a46b0fb574d6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/theme-toggle/theme.js\":\"b65d9e727ec10243\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/actions.js\":\"7d552472573ea41b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/dataExtension.js\":\"8a2224703c2c794d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/index.js\":\"81af090c28a96e9a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/schema.js\":\"682daa603625d6a2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/TouchSelectionLayer.js\":\"37ea4d5e644c7327\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/actions.js\":\"5a2243152c85cf3d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/defaultItems.js\":\"15c4d1442dd7494e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/facet.js\":\"35932db61eef72f4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/holdRecognizer.js\":\"0cd00e6ae8b7bc73\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/index.js\":\"c0a93b5a6e16b48c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/update-indicator/UpdateIndicator.js\":\"75ed73425f2e892e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/update-indicator/index.js\":\"467d2e9c7e2a0eb4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/update-indicator/loadTimes.js\":\"a88c371acf483818\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/VideoNotesRenderer.js\":\"96e2abac8d76599c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/VideoPlayerRenderer.js\":\"7539f027bd53282b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/VideoTimeStamp.js\":\"514aa842b8adac52\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/actions.js\":\"3e3baba324be8468\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/index.js\":\"b86d654464a2a745\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/markdown.js\":\"8676099532b3599d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/notes.js\":\"8382a55d28190301\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/registry.js\":\"7d024e86dd4d0066\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/remark-timestamps.js\":\"7ccb93df95f480b8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/view.js\":\"e38c9c444c70795c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/LinkHints.js\":\"1a1df95dece1e168\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/index.js\":\"71409882a8194f2c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/model.js\":\"3c513e2a716be0c8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/settings.js\":\"f15c3c7e4dccc102\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-normal-mode/actions.js\":\"0442934e4d342fed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-normal-mode/index.js\":\"43212c016c625195\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-normal-mode/interactions.js\":\"4a3000c7487398ae\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/workspace-header/index.js\":\"5aa7133e6cf0b5b9\",\"/knowledge-medium/pr-preview/pr-1834/src/registerServiceWorker.js\":\"32ae9817b7f95dfd\",\"/knowledge-medium/pr-preview/pr-1834/src/requestPersistentStorage.js\":\"f9ea5d77f22c4fc1\",\"/knowledge-medium/pr-preview/pr-1834/src/services/authRequestDeadline.js\":\"ab861833c787dd8d\",\"/knowledge-medium/pr-preview/pr-1834/src/services/authStorage.js\":\"3a80cb1ce3b10e4d\",\"/knowledge-medium/pr-preview/pr-1834/src/services/powersync.js\":\"4f305823dcaddb79\",\"/knowledge-medium/pr-preview/pr-1834/src/services/supabase.js\":\"bd1dbe4be4f35fce\",\"/knowledge-medium/pr-preview/pr-1834/src/services/uploadErrorClassifier.js\":\"3a7e2fcd9f9b4606\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/ActiveContexts.js\":\"71110ef10cdcd738\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/HotkeyReconciler.js\":\"e419e1ad7fbf86ea\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/WipeLocalDataDialog.js\":\"1c442dac663d847f\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/actionDispatch.js\":\"aeab00209f00818e\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/actionRefItems.js\":\"5498b5fd8c09c305\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/applyKeybindingOverrides.js\":\"0487a86dc19cbfba\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/blockActions.js\":\"75fc8bf4f2dd6719\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/canonicalizeChord.js\":\"0058338ea80da371\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/defaultContexts.js\":\"b3a4d367980db8f0\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/defaultShortcuts.js\":\"f7a36c0244e1f96a\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/effectiveActions.js\":\"aa8b164b26f00a65\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/gestureAction.js\":\"af4256f66715bb9c\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/gestureBinding.js\":\"4096be3770bf147d\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/holdRegistry.js\":\"b98e36664961bd2f\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/keybindingConflicts.js\":\"725962993b29722a\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/keybindingOverrides.js\":\"2ad668e92c7462d4\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/pointerAction.js\":\"2bcc2ba3d2cd8179\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/resolve.js\":\"feaaef2f19392f25\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/runAction.js\":\"080bf2e4b27abfd0\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/sequenceMatcher.js\":\"e98c0478f43ebb96\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/types.js\":\"ab2672d8d49079b7\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/useActionContext.js\":\"da1806b536babd35\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/useActionDiscovery.js\":\"3fd881956fc3296a\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/utils.js\":\"3718eac40c060ab1\",\"/knowledge-medium/pr-preview/pr-1834/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1834/src/sw/bootStore.js\":\"f56cddd9c6fb85b2\",\"/knowledge-medium/pr-preview/pr-1834/src/sw/previewDatabases.js\":\"311180f5484fc54e\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/byteTransform.js\":\"9a32c04ad1434cc4\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/attachmentCleaner.js\":\"0cdb400eeb441e98\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/attachmentParts.js\":\"660fbf0cdfa953f0\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/bundleParts.js\":\"eabe68689970bf93\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/bundleRecord.js\":\"fa35adcaa96fb2cb\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/manifest.js\":\"f500066d74b641db\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/takeBundle.js\":\"c56f43b858ea3917\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/verifyBundle.js\":\"ed492cf5924d1266\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/cleaningStage.js\":\"91b2f2360b1b1dd7\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/conversionKey.js\":\"7454440d89b7583c\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/conversionServer.js\":\"a3f32974dae5f399\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/flip.js\":\"72b313e760192fa6\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/flipAttempts.js\":\"f5be72bbd936f902\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/pages.js\":\"8e5e8de0a1752b94\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/preflight.js\":\"3e9d497d8cb9f0cd\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/reseal.js\":\"32da43cd675a2457\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/runConversion.js\":\"ba85c8efd9a376f3\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/runLock.js\":\"c9056f363a08e3f2\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/sealing.js\":\"50adffc498d71c6b\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/sealingStage.js\":\"cac179dc8ec30d05\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/stage.js\":\"8a07a34614bc550a\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/verifyReseal.js\":\"bcd74576976632de\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/aad.js\":\"4b7f911dcc843ae4\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/aead.js\":\"c2cd109267e4cfb3\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/base32.js\":\"b9021c4a4d7c6af4\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/base64url.js\":\"c2faeb694a18d043\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/binaryEnvelope.js\":\"d4fda57661252c5c\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/byteAead.js\":\"bea845fa6a4293ea\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/canary.js\":\"dbaf6785437116a4\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/contentHash.js\":\"57fd71642b0754e3\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/contentKey.js\":\"11a17ec644701ffc\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/derivedIdNamespace.js\":\"e0dfd2e5338ad2ff\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/envelope.js\":\"b27aab85b7a20a82\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/hex.js\":\"5ad5f17c91025a02\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/sha256Hex.js\":\"b8cdb847fca1808d\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/workspaceKey.js\":\"55b68b65184a2474\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/conversionState.js\":\"029c23a1784c2d60\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d44e9770462dde4a\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/pastedKey.js\":\"72cd49619f968d04\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"d98f208edffbe8c6\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7de3d86c1a3c62b7\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/keyStore.js\":\"aa24cfff4f57ee65\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/mintWorkspaceKey.js\":\"bffd57ddf99e9238\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/modePin.js\":\"5b5ab0144b710cbb\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/openWorkspaceKeys.js\":\"a05f1318177f5509\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/resolveWorkspaceEntry.js\":\"eb8494e922463381\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/resolver.js\":\"9a2b744788f2e3d7\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/workspaceAccess.js\":\"bbe2c73c14396027\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/transform.js\":\"add2b2cdcbace838\",\"/knowledge-medium/pr-preview/pr-1834/src/themeBootDefaults.js\":\"ec64f306e20c95a3\",\"/knowledge-medium/pr-preview/pr-1834/src/types.js\":\"6c7aab5e7df611d9\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/ClientLocalSettings.js\":\"dca9d0b1bf89d85f\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/abortableSleep.js\":\"7c9e8bf836b6b112\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/array.js\":\"277f242c7b0243aa\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/backlinkAutocomplete.js\":\"2caa3ff0fd9a6a61\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/blockCrumbs.js\":\"fcd2de4a3f7e044e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/blockrefAutocomplete.js\":\"6255fc6b85c95eef\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/cadencedIdleJob.js\":\"6d4f2e8d12f2d387\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/callbackSet.js\":\"e6c9581cec6566ce\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/clientId.js\":\"ab2d4e47742ff888\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/codemirror.js\":\"e93e8789b138c5bb\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/codemirrorCompletion.js\":\"1e74a7c4483f3fe4\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/copy.js\":\"1e5217f37a692104\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dailyPage.js\":\"f7acbc4af4b64e85\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dbForensics.js\":\"78a11a864fecdd45\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dbForensicsHooks.js\":\"12e5449a2215e517\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/deleteBlockThroughUi.js\":\"733eec68daa70359\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dialogs.js\":\"8cf5423cf8f69154\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dom.js\":\"290944a88e67f297\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/downloadBlob.js\":\"f77557ffe2cd6ac2\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/exportSqliteDb.js\":\"5eecd555dc0301f9\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/fileSystemAccess.js\":\"2203e7409d8d6f2e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/flipSlide.js\":\"4ec75be0497b8bc2\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/fnv1a.js\":\"93f25efd2ee20185\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/formatBytes.js\":\"dd4efd97ee377a6c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/fuzzyRank.js\":\"4a3954e8dea4bba2\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/idbKeyedStore.js\":\"6330249f81d8624f\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/idleCallbackPolyfill.js\":\"0a6e8141c7218591\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/keyboardAwareScroll.js\":\"334007a73613aa3f\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/keyboardViewport.js\":\"e8110c20a30a8357\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/lastWorkspace.js\":\"b6d906ca4c55d99e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/layoutColumns.js\":\"d5ba4844357a0199\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/layoutSessionDom.js\":\"8232f5288d2bca67\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/layoutSessionId.js\":\"726a1009a9410e3d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/linkClickGestures.js\":\"bc0ba95d9cdbc319\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/linkTargetAutocomplete.js\":\"2741aee69b65c6c7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/localDbCorruption.js\":\"cbc4793c514bff8a\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/localDbRecovery.js\":\"060cbb67626b48bb\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/markdownParser.js\":\"a627b93dc4c0eda9\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/memoize.js\":\"0e461652848a4ed1\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/nameFieldCommit.js\":\"1bad3b4a6dcdd589\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/nameList.js\":\"054504ab2f7671b1\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/navigation.js\":\"c091501ece97205f\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/omnilinerNamespace.js\":\"884d2576150b3270\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/opfsPageScan.js\":\"7826a02dfe5ad8ee\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelClearance.js\":\"7284c7bb632717ac\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelHistory.js\":\"1baa2408739dc7c0\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelLanes.js\":\"0fdde06ed2b452a1\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelLayoutProjection.js\":\"dd016789d546811d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelScrollAnchor.js\":\"f9c0b25de71e2457\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelUrlFlags.js\":\"cac5990b30907a8e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/platform.js\":\"16fd16dfd24a2972\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/pluralize.js\":\"11bbc16a63914b29\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/propertyCreation.js\":\"204023619932543b\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/propertyNavigation.js\":\"f808900b4c2e9553\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/propertyValueContext.js\":\"fd1a45534c33e969\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/react.js\":\"d0b97b0dd25f9205\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/relativeDate.js\":\"97c99348ae02bfac\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/relativeTime.js\":\"b62c9fa08c11777f\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/renderScope.js\":\"fed0e9e40d351ddc\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/resolvedThenable.js\":\"2230db9dd8121f62\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/routing.js\":\"376cf4049051657d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/safeMode.js\":\"664bc7b8de440658\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/scheduleIdle.js\":\"68a53170462e61b5\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/screenWakeLock.js\":\"5acde5aa540e33af\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/selection.js\":\"df2b095779763442\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/softKeyboardGrab.js\":\"ed545a2f499c6642\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/startupTimeline.js\":\"39d9c04ddfe347d0\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/state.js\":\"917b9b3a955971f2\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/string.js\":\"9f22504630727fbb\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/surfaceZoom.js\":\"1c9dcf22e312636d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/time.js\":\"f5f5bebf08f0db39\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/toast.js\":\"4037f2a6ce30f8ad\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/toggleStore.js\":\"3e8eaf3cded310f5\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/untilStopped.js\":\"327c3e5d1d50e590\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/userActivity.js\":\"6f2e3b1171675599\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/viewTransition.js\":\"1a2645c58af154ef\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/viewport.js\":\"13fe522546559186\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/webLock.js\":\"8a82142ccea0b09d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/workspaceRecovery.js\":\"2ecc85f13828f544\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/workspaceSnapshotStore.js\":\"9a9d468c6393ddcd\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-compiler-runtime.js\":\"73ee31dffd8ca095\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-client.js\":\"edd5cc406469bf99\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-server-edge.js\":\"b3b580eb90cda5dc\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-server.js\":\"0c22fc0ace4cd722\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-static-edge.js\":\"1055503c8a591346\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-static.js\":\"935ac113f6c69f08\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-test-utils.js\":\"da90adae34a1c465\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom.js\":\"99e41d08cd417303\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-jsx-runtime.js\":\"336d7700e2c0e6f7\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react.js\":\"351914cbdc3aa54c\",\"/knowledge-medium/pr-preview/pr-1834/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1834/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1834/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
