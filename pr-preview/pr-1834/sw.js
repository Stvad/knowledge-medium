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
		buildId: "8d34d716a144-bad98c76",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1834/\":\"4160384c6f4df0bb\",\"/knowledge-medium/pr-preview/pr-1834/index.html\":\"4160384c6f4df0bb\",\"/knowledge-medium/pr-preview/pr-1834/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1834/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1834/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1834/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1834/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1834/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1834/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1834/assets/FacadeVFS-BbMTrHoD.js\":\"1e075e4f3ef26c66\",\"/knowledge-medium/pr-preview/pr-1834/assets/OPFSCoopSyncVFS-DDQd3ZAp.js\":\"032d4b4f442d444f\",\"/knowledge-medium/pr-preview/pr-1834/assets/OPFSWriteAheadVFS-ChUt6bYY.js\":\"acd5a0c5defcd08e\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-BOtHaabN.js\":\"87696b79606932d3\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-async-Bv_U1qeC.js\":\"114b1d83fa7291d4\",\"/knowledge-medium/pr-preview/pr-1834/assets/worker-rXhnQYLa.js\":\"b14d0a6d6d1d1fd9\",\"/knowledge-medium/pr-preview/pr-1834/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1834/chunks/app-Bo4esYbx.js\":\"33d69eb4910a110b\",\"/knowledge-medium/pr-preview/pr-1834/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1834/index.js\":\"36c42973dea9164b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1834/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1834/assets/AccessHandlePoolVFS-CTX513ie.js\":\"318e88602d09ec1c\",\"/knowledge-medium/pr-preview/pr-1834/assets/IDBBatchAtomicVFS-B_2klZLe.js\":\"685945e3881749d7\",\"/knowledge-medium/pr-preview/pr-1834/assets/MemoryVFS-D2MCNKhC.js\":\"d475acc0b2b3cc96\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-async-C3jmRr2B.js\":\"8f7c9fae220719bf\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-lSV33sU-.js\":\"72f04048ec7b7158\",\"/knowledge-medium/pr-preview/pr-1834/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1834/chunks/AccessHandlePoolVFS-fucVbN3H.js\":\"34f93cca83e3865d\",\"/knowledge-medium/pr-preview/pr-1834/chunks/FacadeVFS-0tN7Vo8M.js\":\"a00e8eab1924256a\",\"/knowledge-medium/pr-preview/pr-1834/chunks/IDBBatchAtomicVFS-DIZT6LJv.js\":\"64336c600c1db516\",\"/knowledge-medium/pr-preview/pr-1834/chunks/MemoryVFS-DtnAmcqY.js\":\"f845c6f80640b195\",\"/knowledge-medium/pr-preview/pr-1834/chunks/OPFSCoopSyncVFS-Cp6XjOCI.js\":\"393ea2498a629644\",\"/knowledge-medium/pr-preview/pr-1834/chunks/OPFSWriteAheadVFS-DcUFxUIO.js\":\"34bb240193a1911f\",\"/knowledge-medium/pr-preview/pr-1834/chunks/Preview-CUZkQ1QA.js\":\"c36d83a259ef6998\",\"/knowledge-medium/pr-preview/pr-1834/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1834/chunks/card-BscZo3s5.js\":\"e6e829f5a66e6b89\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dist-iV5ABJnl.js\":\"afb9ea0c0c5e1e24\",\"/knowledge-medium/pr-preview/pr-1834/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1834/chunks/mc-wa-sqlite-async-r3dPhsMf.js\":\"6269305a9e59a875\",\"/knowledge-medium/pr-preview/pr-1834/chunks/mc-wa-sqlite-cttdgm2h.js\":\"cb989467cd14fcc8\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-41H_tgwd.js\":\"341f51a5e298b2e8\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-BAW_eTAh.js\":\"a4e665026f57e346\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-B_0V1CVM.js\":\"1ca059e0fe757698\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-CL9TLVyZ.js\":\"bb15c93d18e8490c\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-CchGvieb.js\":\"a79e3d66d3617de4\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-Ckuh9CLZ.js\":\"624603c763bd4707\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-DecoIOHe.js\":\"13516233dbef0475\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-QD1c9Ign.js\":\"9bbc51754b24bc2e\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-dom-server-legacy.browser.production-Cd-TVtCX.js\":\"7fd9a0bfdb24b603\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-dom-server.browser.production-eycM0_KT.js\":\"f5652a65af4bb3c2\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-dom-server.edge.production-1cfzUhLV.js\":\"4b83c685a879ff68\",\"/knowledge-medium/pr-preview/pr-1834/chunks/server.browser-CBYgiTvv.js\":\"efb79eab464a5c77\",\"/knowledge-medium/pr-preview/pr-1834/chunks/textarea-Bw6DQA0W.js\":\"4317290eb3f3fad6\",\"/knowledge-medium/pr-preview/pr-1834/chunks/ui-CcKycmkz.js\":\"bb871cf6b65af28d\",\"/knowledge-medium/pr-preview/pr-1834/chunks/wa-sqlite-BjV-gq26.js\":\"7f1929dd24b3b79d\",\"/knowledge-medium/pr-preview/pr-1834/chunks/wa-sqlite-async-CnCHQiSe.js\":\"87c5086cd7de6d8f\",\"/knowledge-medium/pr-preview/pr-1834/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1834/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1834/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1834/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1834/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1834/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1834/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1834/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1834/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1834/src/App.js\":\"846cd915d15fad5d\",\"/knowledge-medium/pr-preview/pr-1834/src/appUpdate.js\":\"8cd85f0dbbf254e3\",\"/knowledge-medium/pr-preview/pr-1834/src/appVersion.js\":\"9f172f54b46bc42d\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/initialLayout.js\":\"4133d8d60c0f7855\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/openWorkspaceData.js\":\"1fca04570ae1b2c4\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/resolveWorkspace.js\":\"c184dad16f4a8adb\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/workspaceBootstrap.js\":\"abdb8aa846252e29\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockComponent.js\":\"1535f5cf367a90bd\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockCrumbs.js\":\"748d9944d7bb8705\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockEditor.js\":\"bc597e6caf41659e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockLoadingPlaceholder.js\":\"c0c9bc17b8ac382a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockProperties.js\":\"33a0b13039bc7fd4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockSearchPicker.js\":\"9b151655a0a032ff\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ConfirmBulkDeleteDialog.js\":\"05128b52fc75f22a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/DividerHandle.js\":\"2d2f6313f57121be\",\"/knowledge-medium/pr-preview/pr-1834/src/components/DraftEditor.js\":\"bcf7cf266048cebe\",\"/knowledge-medium/pr-preview/pr-1834/src/components/GutterPill.js\":\"50e22c4438210a32\",\"/knowledge-medium/pr-preview/pr-1834/src/components/Header.js\":\"494548dd59c80668\",\"/knowledge-medium/pr-preview/pr-1834/src/components/LazyBlockComponent.js\":\"121f8d977258ffab\",\"/knowledge-medium/pr-preview/pr-1834/src/components/Login.js\":\"8099c251ca952ee6\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ZoomableSurface.js\":\"f1b954dfc26da767\",\"/knowledge-medium/pr-preview/pr-1834/src/components/editModeKeepalive.js\":\"b3198ea10430caf4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9020b80429be5d2a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b27b28ad79dec336\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/RefPropertyEditor.js\":\"fe7a9e91afabfa40\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/RefTargetTypePicker.js\":\"c191593bc18dd95d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/SelectPropertyEditor.js\":\"7896e07e3b0c900c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/TypesPropertyEditor.js\":\"cafcb264b8356485\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/defaults.js\":\"1fe2eaf6ed1a4e4a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/kernelValuePresets.js\":\"2f61300d079ecad0\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/selectablePresets.js\":\"c39a9fe8346becd1\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/typesPropertyUi.js\":\"391e73689374c5a1\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/AddPropertyForm.js\":\"d4cd074acc26ee57\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/PropertyPicker.js\":\"ffa7e7f055bb2650\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/PropertyRow.js\":\"dfc93670336e74fe\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/Rows.js\":\"859a560b2b15c14f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/actions.js\":\"064590d663095a73\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/declarationOnly.js\":\"48b8d6f2a973fc71\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/layout.js\":\"d24556b70eff0367\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/model.js\":\"d43461f0aaefdbd5\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/shapeUi.js\":\"ec7a4801cc5078f3\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/shapes.js\":\"6099454ed57c1689\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/usePropertyEditingActivation.js\":\"fdacc8f51beb663a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/visibility.js\":\"a8c77ccd9b09424a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanelSections.js\":\"08b56d9e1d8f3677\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/BlockEmbed.js\":\"971ca3bfff9065d8\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/BlockLink.js\":\"2015714e8a6f0828\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/BlockRef.js\":\"b037414a26a0224b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/ReferenceLink.js\":\"ddaa72a028e0212b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/cycleGuard.js\":\"91149abd320a723a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/cycleGuardContext.js\":\"715c137e6b7e5d72\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/linkInteraction.js\":\"2e0c07cc8e5ba9b1\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/referenceLayout.js\":\"21376758591a54d1\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/useBlockRefAncestors.js\":\"54ecd5d2715bcfc5\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BlockGutter.js\":\"2eda0838ba35600f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BlockInfoDialog.js\":\"8ebccab6d40fa9a7\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BlockTypeBlockRenderer.js\":\"50fd0255357c4f03\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BulletHoverCard.js\":\"0cb13602493d9b36\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/CodeMirrorContentRenderer.js\":\"0e0431297f687ccd\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"35723b5018984d50\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/ColumnResizeHandles.js\":\"916adb51b3c65815\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d3a7a73009ef03a0\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/DefaultBlockRenderer.js\":\"6094cba68f43d7e5\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/LayoutRenderer.js\":\"4638c7bf8408ffd8\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/MarkdownContentRenderer.js\":\"50ec990b0d6a8b5c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/MissingDataRenderer.js\":\"a06dbc4cbb292c9c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/PanelRenderer.js\":\"808a52890f475382\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0d9ccb5d83d3d66f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/TopLevelRenderer.js\":\"2b7d1f702a9b3bf7\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/blockGutterMode.js\":\"7a1460934d4e6958\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/blockTitleText.js\":\"529996d9f8986710\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/fieldCreationKeydown.js\":\"cf3d6f22d20838a6\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/layoutRootContext.js\":\"1862cfb3772b10da\",\"/knowledge-medium/pr-preview/pr-1834/src/components/typeChip/TypeChip.js\":\"4bce3ee4addf2242\",\"/knowledge-medium/pr-preview/pr-1834/src/components/typeChip/chipStyle.js\":\"2ce5c15aaf982a36\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/anchored-floating.js\":\"b6b63e95b5298a17\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/button.js\":\"bf77b55f2099be3d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/card.js\":\"84fc9d7cacaf29de\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/checkbox.js\":\"78981c909fd1c7c4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/collapsible.js\":\"712864d34d1d8af7\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/command.js\":\"9789b55b70237455\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/context-menu.js\":\"a7ed86fa414acd42\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/dialog.js\":\"49142c02bd34a9fa\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/dropdown-menu.js\":\"1179c62d0fbc51e9\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/floating-listbox.js\":\"07375ba93d641dea\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/index.js\":\"7230ee0fcd7cb1b9\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/input.js\":\"2e92ca939155731e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/kbd.js\":\"c37466f7845f0069\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/label.js\":\"fbc2b6b1e3055ca1\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/textarea.js\":\"e97d47c66805e50d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/useEditModeYieldKeepalive.js\":\"11b24fd2f31290fd\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/BootFallback.js\":\"35edd69f4121e062\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/FocusedRowLazyMount.js\":\"fdf401b951cde74f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/LazyViewportMount.js\":\"a6d5a1badd84b0b1\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/LocalDbCorruptionFallback.js\":\"e353c3d0d9726020\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/error.js\":\"0bd6078928d81480\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/lazyMountRegistry.js\":\"13b851a25ed9b18d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/suspense.js\":\"3e2291a60f39f850\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/CreateWorkspaceDialog.js\":\"6b876f585a168c75\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/PendingInvitations.js\":\"cc961c2a726ac719\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/SyncProgress.js\":\"917cdaaf995210b4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/UnlockProgress.js\":\"bb347c51d4c82a8a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceKeyGate.js\":\"5fc4aa37219c915a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceSettingsDialog.js\":\"ae2845c51a947224\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceSwitcher.js\":\"50a7e3c884a03458\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceSyncGate.js\":\"dbd095579e88858f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/ConversionFlow.js\":\"6c60a85a16c47dcd\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/ConversionFlowHost.js\":\"7fe85522444368ef\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/EncryptionSection.js\":\"6c8bdc58c52b0d68\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/attachmentPrompts.js\":\"efa0e841c24b2105\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d9e845362cfabeb6\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/conversionFlowDeps.js\":\"c3f09ea62fffcc4e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/conversionFlowStore.js\":\"909574710849cbf4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/flowUi.js\":\"e8294b9d0fae8270\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/useConversionRun.js\":\"914db504cc046649\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/keyUi.js\":\"c7c86e57733b43f8\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/useCloseOnKeyLoss.js\":\"34afa7fc77f43372\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/useCloseOnServerE2ee.js\":\"fc7e968854dae315\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/workspaceUnlocked.js\":\"2805adc47bbf1031\",\"/knowledge-medium/pr-preview/pr-1834/src/context/backgroundSubtree.js\":\"4e22d76b19a966c2\",\"/knowledge-medium/pr-preview/pr-1834/src/context/block.js\":\"c9d884deb523a313\",\"/knowledge-medium/pr-preview/pr-1834/src/context/layoutWsContext.js\":\"6e0cb81c25e530a0\",\"/knowledge-medium/pr-preview/pr-1834/src/context/propertyDisplay.js\":\"0b7eb2e8c0ef51fb\",\"/knowledge-medium/pr-preview/pr-1834/src/context/repo.js\":\"d80aebb22b49a3cc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/aliasClaim.js\":\"33587feba8071f18\",\"/knowledge-medium/pr-preview/pr-1834/src/data/aliasSeatNamespace.js\":\"99d60ec08f632cca\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/blockData.js\":\"3512bc893c62ed04\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/blockType.js\":\"2de0b036532235c4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/changeScope.js\":\"ecdb762f354d8038\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/codecs.js\":\"bcfb47f7a2b90d70\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/derivedData.js\":\"e0857d5c58f56e24\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/errors.js\":\"350ce5cfea95f1be\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/events.js\":\"1411c26367a74e5e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/handle.js\":\"f86f073fb6a84fb1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/index.js\":\"1391161169ce44f7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/mutator.js\":\"998b68504a285013\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/processor.js\":\"05ce4375751c8f4a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/propertySchema.js\":\"10d672b9f0535f03\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/query.js\":\"25025b59be4bcfce\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/sameTxProcessor.js\":\"395322f36ac8bce5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/schema.js\":\"f86f073fb6a84fb1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/tx.js\":\"f86f073fb6a84fb1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/typedBlockQuery.js\":\"ebe7012f45d93257\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/user.js\":\"639c69162f264c33\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/valuePresetCore.js\":\"c4c7fb5c26d1b2f8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/valuePresets.js\":\"2ca2ab7e80ebe0bc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/attachmentCleanerIOVerb.js\":\"0ba0dd965bacb646\",\"/knowledge-medium/pr-preview/pr-1834/src/data/block.js\":\"ea055a73fb631e0b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockCache.js\":\"a99200d800bdf316\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockId.js\":\"b56b17a3a696c801\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockLiveness.js\":\"600c1d22dd373a76\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockMerge.js\":\"9be2dcb1df4051dc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockSchema.js\":\"bb00579398b3f6f5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockTypeLookup.js\":\"6dc83ab385ac8c33\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockTypes.js\":\"91b4c6df10764213\",\"/knowledge-medium/pr-preview/pr-1834/src/data/clientContext.js\":\"d21a345a61911e4e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/dbFileSiblings.js\":\"49ac31fa91406e7a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/definitionSeeds.js\":\"a7105ec985b16c5a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/derivedIds.js\":\"ff421ab30e38349d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/drawnSubtree.js\":\"638cbdcb2fff0087\",\"/knowledge-medium/pr-preview/pr-1834/src/data/facetBridge.js\":\"6574538f506e0ee4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/facets.js\":\"39304a8383a34160\",\"/knowledge-medium/pr-preview/pr-1834/src/data/globalState.js\":\"2d90bd927e83bcf3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/aliasClaimRederiveProcessor.js\":\"6a6a6e71588f60aa\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/ancestorBatch.js\":\"a0618a2e5c163561\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/blockTypeTypeifyProcessor.js\":\"3b8297a67f12e7ca\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/clientSchema.js\":\"62c7fe8163936fa7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/commitPipeline.js\":\"676c77f8a61c1173\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/devAssertions.js\":\"ed0baa666f3d4cdf\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/firstSync.js\":\"d8947fe0e824cc47\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/freshInitialLoad.js\":\"a8b961a4bf213330\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/graphBackfillClaim.js\":\"254ee1c1ec0137aa\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/handleStore.js\":\"503f3498a6bac8fe\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/idleMarkerJobs.js\":\"45719be25bc3ce9f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/initialDownload.js\":\"73688508c92e85a6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/initializeClientDatabase.js\":\"d338ffbf15b83cd2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/jsonCanonical.js\":\"55ba015b68748aec\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/kernelInvalidation.js\":\"2234120c37396e92\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/kernelProcessors.js\":\"f5ea3a6e69b6315c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/kernelQueries.js\":\"0e18f2d12f13f6f3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/mergeTypeMembershipProcessor.js\":\"dab6e8f0b58e1230\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/normalizeReferencesProcessor.js\":\"d7f21293400aed5c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/poolInstrumentation.js\":\"04c3effe598a9c90\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/processorRunner.js\":\"d44640f9ab8fb7e2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyCellBackfill.js\":\"9a6bf9bd75ba21df\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyChildMint.js\":\"7823a96e3d3e03c6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyChildrenProcessor.js\":\"bba691cf01562378\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyDefinitionChangeProcessor.js\":\"848d00e9e18a0398\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyDefinitionSynthesis.js\":\"5c4c50cdcce476d4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyKeyScan.js\":\"6c5e5844d5178442\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertySchemaResolution.js\":\"cfab8631bc09dab6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyValueEdits.js\":\"f0ac399894831a2e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/raiseProtocol.js\":\"fbee60abe697437f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/readBatch.js\":\"371e15f16f0a57a6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/refProjection.js\":\"94b5b65285d8516a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/referenceTargetLookups.js\":\"df627bde6fd30478\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/referenceTargetProcessor.js\":\"7bc4f218c8c78576\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/replayMerge.js\":\"87a9295f7120d400\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/sqlBinds.js\":\"139bcf0ab38bc4f9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"158e902b03e6816e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/arrivalProcessors.js\":\"49d5833eac3fcb9c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/invalidate.js\":\"244cbeeb2d9640e5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/materialize.js\":\"e9be868c5de19519\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/observer.js\":\"5dd32937965f004c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/reconcile.js\":\"54de1e25aee35929\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/timingMetrics.js\":\"95aeb1859419d2e8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/treeQueries.js\":\"f5c87ba3e12b9dbe\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/txEngine.js\":\"5049a05e593335f1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/txSnapshots.js\":\"6f65748303dfb08d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/typedBlockQuery.js\":\"6d8685c9bffc8a96\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/undoManager.js\":\"fa006c1f498bd539\",\"/knowledge-medium/pr-preview/pr-1834/src/data/invalidation.js\":\"abc29f3801f65889\",\"/knowledge-medium/pr-preview/pr-1834/src/data/kernelDataExtension.js\":\"b1d7091379064821\",\"/knowledge-medium/pr-preview/pr-1834/src/data/kernelPage.js\":\"19df1c40c5344da9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/kernelValuePresetCores.js\":\"1077a1aff47bac31\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localDbCorruptionSignal.js\":\"e73bf5d8cf560b63\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localDbStorage.js\":\"440640e15711cfa9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localDbVfs.js\":\"ec5587cf527a8495\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localSchema.js\":\"a82f116f8446811d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/maintenance.js\":\"a629846bbea069a3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/mergeProperties.js\":\"45dcd261cc81b472\",\"/knowledge-medium/pr-preview/pr-1834/src/data/metricsConsoleHook.js\":\"93fb625f25710406\",\"/knowledge-medium/pr-preview/pr-1834/src/data/migrationsPage.js\":\"56f5166c796b7142\",\"/knowledge-medium/pr-preview/pr-1834/src/data/mutators.js\":\"6b4f76d8350f8dd6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/orderKey.js\":\"65e39d3e69ee9135\",\"/knowledge-medium/pr-preview/pr-1834/src/data/orderKeyPlacement.js\":\"b70f8bd8cd25a28f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/outlineSurface.js\":\"f3698810abd66e3c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/pendingEditorContent.js\":\"4f3ce0497005240b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/pendingUploadsSql.js\":\"b94e155fa96887af\",\"/knowledge-medium/pr-preview/pr-1834/src/data/pluginStateExtensions.js\":\"dcb08b0698bc5efb\",\"/knowledge-medium/pr-preview/pr-1834/src/data/powerSyncLogger.js\":\"43280eb809d80362\",\"/knowledge-medium/pr-preview/pr-1834/src/data/projectorRuntime.js\":\"f9c81551df135b20\",\"/knowledge-medium/pr-preview/pr-1834/src/data/properties.js\":\"e50a666f5370f0f6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertiesPage.js\":\"ac95a21f027f2bfc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyChildren.js\":\"3c28f00554f2a0c2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDefinitionFanout.js\":\"0e6c2130bb626f1f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDefinitionMetadata.js\":\"8796499b28acab78\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDefinitionRegistry.js\":\"69ff6630fe3f4695\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDisplayMode.js\":\"d75a3b44dd3acd84\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyRowCreation.js\":\"d3e5df19377acc47\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertySchemaCreation.js\":\"d0143c4552657e3e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertySeeds.js\":\"9f443897d6a321e9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/recentsPage.js\":\"697194f9e3b5f105\",\"/knowledge-medium/pr-preview/pr-1834/src/data/referenceBlock.js\":\"7ce34ab9158f8621\",\"/knowledge-medium/pr-preview/pr-1834/src/data/rejectedUploads.js\":\"cfa2f95be47ee46a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/releasePowerSyncConnection.js\":\"8248ba2dc3da2225\",\"/knowledge-medium/pr-preview/pr-1834/src/data/repo.js\":\"e558df0495b5f9ca\",\"/knowledge-medium/pr-preview/pr-1834/src/data/repoProvider.js\":\"34d97e6dee516685\",\"/knowledge-medium/pr-preview/pr-1834/src/data/rowProperty.js\":\"2dccecf60111d088\",\"/knowledge-medium/pr-preview/pr-1834/src/data/searchFilter.js\":\"f369157ebe4e6c91\",\"/knowledge-medium/pr-preview/pr-1834/src/data/seedIdentityLedger.js\":\"31ca76feee642ecb\",\"/knowledge-medium/pr-preview/pr-1834/src/data/stateBlocks.js\":\"b6127f34441bc5af\",\"/knowledge-medium/pr-preview/pr-1834/src/data/structuralEditPolicy.js\":\"80312850c370e499\",\"/knowledge-medium/pr-preview/pr-1834/src/data/subtreeDelete.js\":\"a4bf08407a35bd5d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/syncStreamLock.js\":\"a1694bff3b26a079\",\"/knowledge-medium/pr-preview/pr-1834/src/data/syncedTableSqlRecognizer.js\":\"2fc17d27f48997e5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/syncedTableWriteGuard.js\":\"4277006e19c36351\",\"/knowledge-medium/pr-preview/pr-1834/src/data/targets.js\":\"b8b6c42e5e1ae847\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeColors.js\":\"3ee87084efb8f3b5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeDefinitionMetadata.js\":\"1ec2ddb57f5605db\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeDefinitionRegistry.js\":\"a62ffcbe38fde7ca\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeExtraction.js\":\"34b15191c83c5e1d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeInitialValues.js\":\"6ee9accea68845b6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typePropertyGroups.js\":\"12ce03072c78c63e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeSeeds.js\":\"44bc6602d373b2d6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeTagger.js\":\"b413d2d991409d68\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typedRecords.js\":\"a7238c8198fb024c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typesPage.js\":\"53ab93e4290ffad4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/userPrefs.js\":\"01bf85bdf66cb0b2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/userSchemasService.js\":\"5a4f5e7df40e90fa\",\"/knowledge-medium/pr-preview/pr-1834/src/data/userTypesService.js\":\"f28e9c412050e658\",\"/knowledge-medium/pr-preview/pr-1834/src/data/valuePresetRegistry.js\":\"9d03cd43cbac67f5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/visibleChildren.js\":\"89ca28b6821052b9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceConversion.js\":\"e57de5d7cca80e48\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceFirstSync.js\":\"be2732508e27bb4d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceIdNamespace.js\":\"d789457b093820e3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceSchema.js\":\"1f22f2f442aa7cf1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaces.js\":\"0b0be18fcf617175\",\"/knowledge-medium/pr-preview/pr-1834/src/data/writeAheadLog.js\":\"504c858aa1f8248c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/BlockPasteShellDecorator.js\":\"dbb4226d7eb8f652\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/atTrigger.js\":\"979869da846ff041\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/autocomplete.js\":\"978465668b0f5df7\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/codeMirrorExtensions.js\":\"b99afe566e76fc44\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/contentFlush.js\":\"b48e9be75b1cc5f6\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/defaultInteractions.js\":\"ee0d5988cc070a72\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/editSettleSignal.js\":\"f26f68cddffceb32\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/insertImage.js\":\"f1feb3047e9d3422\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/referenceCompletionRange.js\":\"15af07384a4608e4\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/referenceTargetTypes.js\":\"a85ced2adab9df3c\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/syntaxContext.js\":\"e92f11a18ccbc005\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/triggerMatch.js\":\"54d5cf310a297c9d\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/AppRuntimeProvider.js\":\"d9a4fe9ed90d0a5e\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/BlockFocusShellDecorator.js\":\"826748be9548019a\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/ExtensionRenderBoundary.js\":\"193f08f34b92a22f\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/PanelContentRecovery.js\":\"c34867f77d922969\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/apiCatalog.js\":\"972d3662d1041ed3\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/approveExtensionHere.js\":\"3c89ffccee1da7b3\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/armedCutAppMount.js\":\"67742c6de0050b6a\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/batchableKeyedStore.js\":\"754157ddddf4e2be\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/blockInteraction.js\":\"e3a066ccd031b6ac\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/blockSelectionAction.js\":\"d28b7a586648f966\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/compileExtensionModule.js\":\"cc8cee127fa6b213\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/compiledModuleCache.js\":\"ce5681818fd7639c\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/continuousGestures.js\":\"bde169eca68466ab\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/core.js\":\"a3eb4a0ae15f6d29\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/defaultRenderers.js\":\"b8564dcf2d9abdfd\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/definitionFanoutAppMount.js\":\"1034da440bb14341\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/dialogAppMount.js\":\"76a227da16ec32e3\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/dynamicExtensionSeeds.js\":\"3636db1e663d6735\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/dynamicExtensions.js\":\"40d45f60edafac78\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/exampleExtensions.js\":\"16c36fe03efcb1e3\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionApprovalStatus.js\":\"e396b0f6457995ea\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionLoadErrorToast.js\":\"d37e3f6fa9199002\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionLoadErrors.js\":\"474dfb0a2eed5c35\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionLookup.js\":\"e6656bb241cae3e5\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionToggles.js\":\"050e70145081feca\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionUtilitiesCss.js\":\"401a94390c9f2f80\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/kernelPageDeletionGuard.js\":\"6f955a4c73ef36ee\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/liveRuntime.js\":\"881368f7bb55cbe8\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/openExtensionsSettings.js\":\"cf2064abf0f88892\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/overridesCache.js\":\"4f5378644f279c39\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/pluginIds.js\":\"b0d3b2b0260a4eb5\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/processorRejectionToast.js\":\"3e2ec480d8225ead\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/runtimeActions.js\":\"2736cba70fb4a80d\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/runtimeContext.js\":\"17e752b4413ae19c\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/staticAppExtensions.js\":\"074d692b0ad33353\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/staticDataExtensions.js\":\"497929eeb0789ccf\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/toastAppMount.js\":\"ea3f085ed0732c8f\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/useOverrides.js\":\"89ef24af2585e331\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/useShortcutSurfaceActivations.js\":\"93f5ec8b72d76bbd\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/discoverToggleTree.js\":\"fcd8546b666178c1\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/facet.js\":\"d13ad2807ae2b3e9\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/resolveAppRuntime.js\":\"cbac0f5c37f28b69\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/runtimeEvents.js\":\"f39a4120c1e713e5\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/togglable.js\":\"1937930fadcaf7a2\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/variantFacet.js\":\"e8ea97bfa32510d6\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/verbFacet.js\":\"748ac18128f70678\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/block.js\":\"aa142b2261715138\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/focusedChild.js\":\"1eaae9da0d940843\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/propertySchemas.js\":\"4e4bc6697072f038\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/typeRegistry.js\":\"8da22ea3a78f3fcc\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useAncestorCrumbs.js\":\"8123c35c6b4379d3\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useAutocompleteListbox.js\":\"b0ae305a845437fe\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useDebouncedSearch.js\":\"f29834e7b70df883\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useDebouncedValue.js\":\"023ddc398958d440\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useIsFocalRender.js\":\"1c9a442de291bd76\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useIsReadOnly.js\":\"c08794e48fcae3c7\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useMaterializeBacklog.js\":\"03542d2d24509579\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useMinuteClock.js\":\"461be46f0fcca10e\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/usePanelLayoutProjection.js\":\"958a40967d420dc7\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/usePendingInvitations.js\":\"372e8c2e414a6e34\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useRendererRegistry.js\":\"60b7ed9901acdd6c\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useRetainedFieldRows.js\":\"ccb2b8ca76ff8470\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useWorkspaces.js\":\"d11ff8b397691633\",\"/knowledge-medium/pr-preview/pr-1834/src/lib/utils.js\":\"4f7a27e80d6ef340\",\"/knowledge-medium/pr-preview/pr-1834/src/main.js\":\"1da5fd740a444460\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/MarkdownImage.js\":\"e1d211f7c83e7765\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/blockSeparators.js\":\"d8c307012b00bbfd\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/context.js\":\"39f3125b9f89dfbe\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/defaultMarkdownExtension.js\":\"b48f3247227b73b0\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/extensions.js\":\"60017cb5f0e59515\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/renderMarkdownHtml.js\":\"f9dd2028e06bd12b\",\"/knowledge-medium/pr-preview/pr-1834/src/minimal-editor.js\":\"a65ff12b8495e6e3\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/armedCut.js\":\"844be06a1ab9fe11\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/captureMediaVerb.js\":\"59f0dcd61b43e07f\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/clipboard.js\":\"1a69dc034b625605\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/decision.js\":\"18ef207dfc6986e1\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/operations.js\":\"eb06df98cfc6464f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/account-header/AccountHeaderItem.js\":\"70339021f8a81084\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/account-header/index.js\":\"77a13f373d5634b9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ceba7aaaeafc32a5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/askAgent.js\":\"2042bd8cf3ca030a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/askedStore.js\":\"0d073e1ce1572f86\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"e3a3a5a2411cafd2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/chipState.js\":\"2ce781ff60540387\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b0edf6db3926be19\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/index.js\":\"d2966c11d7d327be\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"860b1bf687dc84c3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/schema.js\":\"1d1de36ef4f5b7b7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/AgentTokensDialog.js\":\"474394c8d20d82ca\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8b062bff5e5f0256\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/addMedia.js\":\"8dc384f1d60e5dfd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/backlinks.js\":\"fbfdc0fa44525fc1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/block.js\":\"bcce3be50a5b15f0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/context.js\":\"4d7ac3e1febc8fd5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/displayIds.js\":\"335580ba5267e030\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/index.js\":\"c61ab2b7ad59be12\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/outline.js\":\"b37f982205448509\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/properties.js\":\"88f80a29c090254a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/refs.js\":\"c43c3ce3983dc949\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2457325cf282f67c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/search.js\":\"60834c50d4e23579\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/shared.js\":\"a837645105b30bd1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"df6510ee1166b5cc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/text.js\":\"520aea6444e70372\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentWrites.js\":\"4292f7fa44241dc2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/authoringCatalog.js\":\"1aea7a902ae5a828\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/blockRefTargets.js\":\"d507f3007381c95a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/bridge.js\":\"70dc145bd743bbe3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/bridgeLoop.js\":\"528f4a0cbc793325\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/changeHistory.js\":\"b1b0f6b162de49cf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/commands.js\":\"1f0fd277e0ee2b6a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/commentsCommands.js\":\"612469e3119a3eff\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/dataExtension.js\":\"578b7655b373afe0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/dataModelGuide.js\":\"bb48fe4d172bd111\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/describeRuntime.js\":\"74f26d67724d08a8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/extensionLint.js\":\"5728187a299d12fb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/grainAudit.js\":\"d4ed5efb634fe159\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/healthCommand.js\":\"089263d3a68125a0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/index.js\":\"92bea7008e18f1ee\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/presetIdentity.js\":\"f9efc8c7aae0b412\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"37164dd0a0533fde\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/readMedia.js\":\"1324ce94c79386a7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/schema.js\":\"242262ed491e03fb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/serialization.js\":\"581a4466c9c6e7e2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/targets.js\":\"a66941a85f03cb9c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/tokens.js\":\"33d2b8ef403b1472\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/watchEvents.js\":\"d5a66911f9bd8e1a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/workspaceGuard.js\":\"d386c8a634b91acd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/writeCommands.js\":\"12b311fb52c968aa\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/AliasCollisionToast.js\":\"015f2e8ee21293c1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/DuplicateNameBanner.js\":\"396927b9ca8a27da\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/collisionMerge.js\":\"ec7970fc678ba4c8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/dataExtension.js\":\"74bd952e953a66ad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/index.js\":\"908af01d1e163603\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/mergeCollisionAction.js\":\"6843393f1f4901ef\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/pageStyling.js\":\"68751cdfd1eca64c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/rejectionToast.js\":\"5abff3983f42d784\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/syncProcessor.js\":\"b4f6849181b7c47e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/actions.js\":\"5ca290aaa76524f7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/addComment.js\":\"8e057ae14e549587\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/anchor.js\":\"4a9093e445e9787e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/anchorState.js\":\"b08c75b191f35bf6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/commentLinks.js\":\"c6a9fd2dd19fa82e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/confirmThreadDeletion.js\":\"884a95857d615a6d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/container.js\":\"efb04a9a4d0732ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/dataExtension.js\":\"6b54c214ed4d2683\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/deleteComment.js\":\"77aa6afa003a4f8f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/highlights.js\":\"5619564984066bd7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/index.js\":\"2dc1eedaaf02d35f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/linkedCommentsPill.js\":\"3f0cb4826576f219\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/margin.js\":\"345cc02990f6c7c7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/marginSchema.js\":\"881cbb661a953ccc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/newComment.js\":\"ac5bd21755955560\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/ownThreadPicker.js\":\"4a1de4b0895afa90\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/placement.js\":\"ec6dc88eeace2896\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/queries.js\":\"fc455a80e4b09c98\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/quotePosition.js\":\"52e2546a493d39f5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/quotedIn.js\":\"ecc9ed7514b1ae12\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/quotedRange.js\":\"18a396077c53b1ac\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/rangeRefs.js\":\"4f31d67111cecfd9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/readHighlights.js\":\"f851e066f63ca9ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/readSelection.js\":\"9ad40f3de5e62d4b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/readSelectionUi.js\":\"9059ec630b88f22b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/reanchor.js\":\"43311c55a9e52d60\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/schema.js\":\"6b675040769b496c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/scope.js\":\"a6d58796a62eabb7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/scopeThreads.js\":\"c30fdab8a10397bf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/splitRetarget.js\":\"e53c3c10282138ad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/suggestionCard.js\":\"a29fb5544c7429f2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/suggestions.js\":\"36b79fd9b1e4b6bc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/summaries.js\":\"f2bf6b878c57df23\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/summaryBatch.js\":\"7cde19af82f77aea\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/surface.js\":\"729000e8065a7343\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/threadNavigation.js\":\"b368664ac22fadd2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/threads.js\":\"2ddf40d2b8ee550e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/ui.js\":\"925fd34d990fae0d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/uiStore.js\":\"20972cab763e36d7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-intents/appIntents.js\":\"82bb7da99b7ee14f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-intents/index.js\":\"4f75bf2bd5fab127\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-update-prompt/index.js\":\"3911831f36e7476f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-update-prompt/status.js\":\"bf31b18cb8976852\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b828bd36bccd6c5a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/MediaBlockRenderer.js\":\"2aa0a5edcdfd471a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/MediaDownLaneReplicator.js\":\"426d4e1feef66585\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/MediaUploadReconciler.js\":\"30790d52e293ecc3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/assetDownLane.js\":\"0db31b8df9469c6b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/assetResolver.js\":\"39584beb463daefd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/assetUpload.js\":\"3bc4645119fbdea5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/attachmentCleanerIO.js\":\"0eb9931b7fb01b32\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/supabaseAuditIO.js\":\"22d32665472616ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/blobStore.js\":\"bc83d6215a35168a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/byteStore.js\":\"c515866659dd0479\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/cleanerIO.js\":\"4dcd54147d2bd113\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/cleanupAttachments.js\":\"c0dcf8b8b390b19d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/dataExtension.js\":\"10afe77f28b820a5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/downLane.js\":\"afef1dca4df778b6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/index.js\":\"ff2a4c7ca364c573\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/insertImageContribution.js\":\"a865264df0db1420\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/laneArming.js\":\"14223c9b8fb085a0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/laneLock.js\":\"e0ad24e9f7627049\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaBlock.js\":\"a57947ecb7fae907\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaCapture.js\":\"e571c496cd0312ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaViewers.js\":\"47dce0030afa85ff\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaViewersFacet.js\":\"b76fb86160035e60\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/pasteCapture.js\":\"d717ae70e896ee37\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/resolver.js\":\"58a2153a539b3fe0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/retryUploadsAction.js\":\"1340c0eec931adc4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/storagePaths.js\":\"bfa68310a2477b3f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadDrain.js\":\"713835b7d0ee5ddf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadLaneStatus.js\":\"5c97058ada8866bf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadReconcile.js\":\"10bbd12b97000625\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadRecovery.js\":\"17454671cd4237a6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadStore.js\":\"9b757bde087223f8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/useAssetObjectUrl.js\":\"b8dbd93a7afc4e77\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"78a46c3454b1ef46\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d09fb80d198b85cf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/facet.js\":\"7eed93e7bf032208\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/index.js\":\"8be521fdd2d27df3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/prop.js\":\"ef679d3050130de1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/BacklinkFilters.js\":\"91a95df2f93ab39b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7c10f8324fa7af94\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/BlockEntry.js\":\"3050e6939ad53c15\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/LinkedReferences.js\":\"043fd12b46641703\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"930de80271fd8c97\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/dailyNoteDefaults.js\":\"144aaba6e97180b1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/dataExtension.js\":\"60b13d47a9ceaa96\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/edgeExclusions.js\":\"2282f239957a0177\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/filterProperty.js\":\"632f4e296383e6d9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/index.js\":\"4fbc44231b078b75\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bc1b4b7cc5ad57fb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/applies.js\":\"28b07dc606bcbda1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/countQuery.js\":\"db98cdc7cd178a0e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/expansionStore.js\":\"10eb28187646a57e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/index.js\":\"5f8f89fc2d8fb590\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"33630bb11abb1719\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/presentationInvalidation.js\":\"51526b58c6a5556f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/propertyEditorOverride.js\":\"05d19d9a9f957c11\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/propertyFilter.js\":\"ae19cc507c078958\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/query.js\":\"10624272df0009cd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/resolveFilter.js\":\"47db520c19e22858\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/sourceBatch.js\":\"08f168c34211abc1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/sources.js\":\"bd86382ff0b85420\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/useBacklinks.js\":\"44c10c19faf71811\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"48bba7674645f586\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/BirthdayCelebration.js\":\"e28c8dd5d7042624\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/BirthdayOverlay.js\":\"41938902402041e9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/gate.js\":\"07d3b26f9ae68c10\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/index.js\":\"90f6471f23317e8d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/wolfTheme.js\":\"7c786af7ca209686\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/BlockDragLayer.js\":\"1781c61a15ea8346\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/dragController.js\":\"90131da460ba4eb8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/dropTarget.js\":\"75689e91ea49b224\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/index.js\":\"9d3730801e39c086\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/projection.js\":\"2b2f514eaeed5113\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-info/BlockMetaCard.js\":\"320136ad0d99c5be\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-info/index.js\":\"95a146e5b3fc6dd7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/AddTagDialog.js\":\"4b9405c825943cad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ab09536c1298066f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/TagNameIssueHint.js\":\"2948b6dc6fd5e3f3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/addTagAction.js\":\"79e2c7998e8728ab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/appendTag.js\":\"d8cd8b708b436fad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/config.js\":\"3bfc8c8d0df34994\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/dataExtension.js\":\"5afe8df3e73015fe\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/index.js\":\"d6c0962522cfef08\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/propertyEditorOverride.js\":\"f05d4e8660d81411\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/BreadcrumbList.js\":\"44a3a373b0547b90\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b61008cc442d5287\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/Breadcrumbs.js\":\"bf5884976b304074\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"210a379a212b8d23\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2b867af93b1ac8be\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/index.js\":\"512bf8a69768d681\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"3a9f5e643f2b16f3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/CharacterCountItem.js\":\"7034bfa2ce0be04e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1089142163a3dea9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/actions.js\":\"f74b99e0cc545f18\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/blockType.js\":\"9db23d15c639695b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/charCount.js\":\"66b396ee6a3e9b9b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/dataExtension.js\":\"f68b718337bafada\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/index.js\":\"bb57637396eb5549\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/profiles.js\":\"c9e34c6504e2fc88\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/properties.js\":\"38393a32f435655d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/textCounts.js\":\"8e72019c12ac05be\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/colemak-keybindings/index.js\":\"4a19889e3f3235e2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/CommandPalette.js\":\"796ba3759dc62b33\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/HeaderItem.js\":\"bb7940bcb6fd1296\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/context.js\":\"2fb9dcd2239ca4ab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/index.js\":\"414fae168a9e3990\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/selection.js\":\"ce5a178e87371063\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/toggleStore.js\":\"b85d37256fdff4ef\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/useCommandPaletteActions.js\":\"181ee3ccb9783f2c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/ContributorBadges.js\":\"6edf332c7606fa9f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/author.js\":\"b82018a2522e6a14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/codeMirrorExtensions.js\":\"2039fe46c5721548\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/dataExtension.js\":\"5b5f60d34ed9c18b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/index.js\":\"b05fc518b33569a2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/mentionAutocomplete.js\":\"95da856d980be114\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/processor.js\":\"cffc0374cf5fcbeb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/profiles.js\":\"2c062218c55fa263\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/queries.js\":\"bf0b3ea1a11698d1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/schema.js\":\"58d184c1411daabe\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"2048a38285309b04\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/followOrigin.js\":\"26842ca5acc35532\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/index.js\":\"644fd22ddaa0381e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f05151b98c49d60e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c65a4bb9c5832ff2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/CalendarGrid.js\":\"f07cd36e45690a25\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DailyNotePicker.js\":\"39e446b0545744f2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"1e5f41c41edd53ff\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DateNavDecorator.js\":\"51f5ee578feee1a9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DateScrubOverlay.js\":\"acc01cd5ae6e3c30\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/HeaderItem.js\":\"69b392fd5fb981c0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/ReschedulePicker.js\":\"485e22ac82ef9918\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4b0e849d9877afa7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/actions.js\":\"602a86d901b8569c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/blockDateAdapter.js\":\"3e337067785e8d36\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/calendar.js\":\"20a0b3ccb4ae2064\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dailyNotes.js\":\"065f59df50b0878a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dataExtension.js\":\"991a692743b8d4d3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubActions.js\":\"35da26bd7dbe0451\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubGesture.js\":\"c2bf1b93c028ab9a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubGestureActions.js\":\"acadcf8e52e7c163\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1aad15d0567ef62a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/deletionGuard.js\":\"7069faa8dd33a686\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dueQuery.js\":\"bc09d6396ec5ee9a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/index.js\":\"44b4e10c2da94234\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/landing.js\":\"017534962d2301fa\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/localSchema.js\":\"a46638df74e5070e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/referenceDateAdapter.js\":\"e6fea6061baeb597\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/rescheduleAction.js\":\"9f35ee4b13452b73\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/schema.js\":\"f3ed2fdd63fe6930\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/spreadBlockDates.js\":\"9419a7ef745c344e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/spreadDatesAction.js\":\"9606e2a15b2f0f12\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/today.js\":\"18eac46736071b21\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"47815840b4b6e179\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"8b5dc2135c205f72\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/audit.js\":\"ce8000bd40a38406\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/auditAction.js\":\"5153131625ba05d1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/auditRanges.js\":\"df0c7fd481550f03\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/diagnosticsSource.js\":\"e9b95588001ef59c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/divergenceScan.js\":\"9bca904bad45b2b0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/index.js\":\"694812a072d91b0e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/propertyChildrenChecks.js\":\"dd7ef0b63debdfd7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/referencesMirror.js\":\"9e238fd13c9d8c76\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/rowJson.js\":\"5566fea384dfd4f0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/schedule.js\":\"7ae78718bed52f23\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/store.js\":\"14aba51d801a82e7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-maintenance/action.js\":\"6c6ca63df67dd002\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-maintenance/index.js\":\"ddc87ee8953c959e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-maintenance/plugin.js\":\"5746b5ad74ee9bd9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6167adce15e61d52\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/actions.js\":\"5e2d51060016a36a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/changeMarker.js\":\"adf7c5885b5e5975\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/diagnostics.js\":\"c19e2c0ced25c2fd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/fileSystemAccess.js\":\"65d18dbabaf123ee\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/filenames.js\":\"c58909a3d5af66db\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/index.js\":\"7705866ff57e94a1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/mirror.js\":\"01b8b0dddd71280a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/runLock.js\":\"d20c163b23208c09\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/runtimeHealth.js\":\"eb0d3dbd5a1e9b2e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/schedule.js\":\"45ca5f07b3096964\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/store.js\":\"32d748eea0326875\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/default-themes/index.js\":\"5de113eea26ce067\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/default-themes/themes.js\":\"10741c7ae99021c9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/diagnostics/facet.js\":\"14a313ba2aa20d4b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/diagnostics/useDiagnostics.js\":\"235e4e794897bd32\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/dismissals.js\":\"bac962fb36a5d464\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/index.js\":\"78e1ab9f33648c85\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/status.js\":\"60c1fe1cc53fa4ab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/store.js\":\"ac6299999c963dd2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6faf3ace5e7bf437\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/ExtensionsSettings.js\":\"216af4bd34e7adfc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/actions.js\":\"89fc64c720743ff9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/config.js\":\"128ad95227cba203\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/dataExtension.js\":\"5af2d4fd480ca953\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/effect.js\":\"8159124a9b7f0b10\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/index.js\":\"c8cad6b0345e05ab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/propertyEditorOverride.js\":\"11fbaa329172b7e4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/useToggleTree.js\":\"64f6a23c352e529c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/ExtractTypeDialog.js\":\"72ffc981e28f28d7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f5294c205b31d349\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/PropertyShapePicker.js\":\"698a2e0f37b4dd1d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/action.js\":\"6e1d95ab8bdebd7c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/index.js\":\"5435a56a3bcdac72\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/FindReplaceDialog.js\":\"931713d3240c0203\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/HeaderItem.js\":\"7c9a7321dbecb1bf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/dataExtension.js\":\"3be33a5174ca6f21\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/index.js\":\"6567c1f58ccec8ea\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/search.js\":\"76bc809dc5bd7fce\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/toggleStore.js\":\"beaae0227d5a65f4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/LocationPropertyEditor.js\":\"d9b7dd4cdb89cac2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/MapView.js\":\"a4aaa161fccec7a2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/blockTypes.js\":\"3dd66c2dd3fd8306\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/codeMirrorExtensions.js\":\"6476f4d54b9ea414\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/createOrFindPlace.js\":\"11e8fbc72289e8cb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/currentLocation.js\":\"00415e12c4b905ef\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/dataExtension.js\":\"c262fe59931f8470\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/geoContentDecorator.js\":\"3f80756c33cbe50e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/googlePlacesClient.js\":\"01b8e7ac5918e4eb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/index.js\":\"a02d21b170666223\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/locationsPage.js\":\"df87debaee4ab8cb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/mapViewport.js\":\"4f7ac633258cf82a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/pickCurrentLocation.js\":\"b2769b0257db4b63\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/placeAutocomplete.js\":\"a477e6f95f8e0ee2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/placeNameCollision.js\":\"b7e999f6afc4e8c7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/properties.js\":\"0c59fceffed48dab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/propertyEditorOverrides.js\":\"0e8ca3fedd0fd270\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/query.js\":\"8735ff71eac02544\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/usePlaceSearch.js\":\"22f90e7f3a7b12ae\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1a8b39c252f50aa4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9c8366973b7381b9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d877c15d7caa11b3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/config.js\":\"5b03b65f17f4a988\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/dataExtension.js\":\"f08620076e2602ac\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/facet.js\":\"8245de10610a1ba3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/grouping.js\":\"45a8bb2e2670ad72\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/index.js\":\"9775c6b7bc2830d9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"47e61f39d9ad7f51\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/query.js\":\"257ba36851926c24\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/resolveConfig.js\":\"3e77be0832b3fa39\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"326724882d076de6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b810e565446790e8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/HtmlDocumentContent.js\":\"72cd69049ae024f1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/HtmlFrame.js\":\"3d5ae1edb5463250\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/actions.js\":\"5019420844e571bd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/blockType.js\":\"2347f2d72b3dfc28\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/confirmRunScripts.js\":\"81d284eba0c1e47f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/dataExtension.js\":\"3b1d362a11abfffa\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/frameAnnotations.js\":\"8acfebd7891ef3a7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/frameDocument.js\":\"7fec95ea6984d747\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/frameTheme.js\":\"3a7daf8b4d3ab07a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/index.js\":\"05f08d8dd9500578\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/scriptConsent.js\":\"bcd0b0eebd318547\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/sourceMap.js\":\"5a508dcb5c1f5592\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/useDocumentScripts.js\":\"34f2501c577071af\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/index.js\":\"aad3ae1290660091\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/record.js\":\"447a051cfd736034\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/recordStore.js\":\"075a7ea78319819e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/responsiveness.js\":\"9f8bbccfb7b09323\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/schedule.js\":\"a570dc3e3ebc62d5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/sessionContext.js\":\"9de197ed8e30ce38\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"78d118d22cd65370\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"eab0004ac298e75f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/actions.js\":\"c1e4e2ea97ab2165\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/config.js\":\"bac69e5586bde340\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/dataExtension.js\":\"30deae01b9ec64fe\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/effect.js\":\"7e3f4893e7a98466\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/index.js\":\"b83dd2d6e1039df7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/keyCapture.js\":\"7d885480e3791ef0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/overrideStore.js\":\"283b3c99dbdde279\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"60fbfd731986d7d2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/HeaderItem.js\":\"5881d26b8c4fc53c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/LeftSidebar.js\":\"f71de1703eaaba49\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/actions.js\":\"0462aa035f4abe14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/facet.js\":\"17a41a6177557275\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/index.js\":\"fa54cd962c53a407\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/shortcuts.js\":\"01b4c0fb1184b3bc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/toggleStore.js\":\"5de61222acdc879e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/MergePicker.js\":\"caaf29f45e3461e6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/index.js\":\"cd9fe2ce6a10ff0e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/mergeAction.js\":\"0f5d062fa5c13b09\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/strategy.js\":\"bc9756d11bc9e8b6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/Button.js\":\"874672d4f3ed41a1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2a05e900b3c5a555\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/defaultItems.js\":\"2b681345a78d33f8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/facet.js\":\"696decb8292d0402\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/index.js\":\"6beaa1842b85f441\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"7e9a9608eba43323\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/actions.js\":\"35f31e2efee5de15\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f177af84e964ffcb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ad8a6cfe4aaabbf9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/index.js\":\"755975c87eaaf855\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d61b35f44a82d892\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/blockSubtreeMembership.js\":\"7636a8c87b9985b0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/contextMenuItem.js\":\"f5725e8b98ee5592\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/index.js\":\"b65065c150cf1bfb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/moveAction.js\":\"fa65572efc6e5f26\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/moveBlocks.js\":\"d09451459f270d24\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/selectionAfterMove.js\":\"71013c270edfca5b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/TutorialBanner.js\":\"7984de15dd42bfad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/action.js\":\"e274aba001812cfd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/bannerDismissal.js\":\"23293109ca257b4a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/documents/cheatSheet.js\":\"dbdfafeb3b07a78f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/index.js\":\"114cb38e564a8f4c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/keys.js\":\"3f428efe94d415c4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/landing.js\":\"1579ac523bfec354\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/outline.js\":\"144707d040bc709d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/seed.js\":\"5fcb9992864779f4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/PerfTrendDialog.js\":\"20d26d16735c9b7c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/analyze.js\":\"772906d2212e3e08\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/diagnosticsSource.js\":\"4985167ef9d75af2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/index.js\":\"d6a2d24a9b0d45ba\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/load.js\":\"032c59f55ff0975c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/monitorRun.js\":\"43dc04533744e3d8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/schedule.js\":\"f06bfd392f178c38\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/series.js\":\"5eb17bcf7a280ab8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/store.js\":\"003f80f50aac7b28\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/trendAction.js\":\"16a2d8a8ba4ceb10\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/verdict.js\":\"dd2a9824d518637d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/plain-outliner/clickToEditAction.js\":\"cde6a0b923dc34b5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/plain-outliner/index.js\":\"055cf3a742021e75\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/plain-outliner/interactions.js\":\"167b032a995f8090\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"19c8a158a42ea00a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/MigrationGate.js\":\"f381a83a478d6de7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/MigrationGateDialog.js\":\"81e886c4ca854c7f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/action.js\":\"48609e55db25384a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/index.js\":\"501eb1effa091aac\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/localRunMessage.js\":\"2e0e2160051b4275\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/plugin.js\":\"13d4cb2806a1517f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/progressReport.js\":\"6b7f80100f01c051\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/sweepProgress.js\":\"c14ce88dd61a6d7b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/FieldRowRenderer.js\":\"57450c66d8a71f42\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/ValueRowRenderer.js\":\"72a56811146171ea\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/actions.js\":\"db47d9de33aebacd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/autocomplete.js\":\"afcf15ec33753038\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/fieldRow.js\":\"b03752c93b2c3a6b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/index.js\":\"65e15a1c068d8a40\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/referenceWarning.js\":\"74e21bd9c436b06f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/valueAutocomplete.js\":\"53dafd9467ebfd70\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/valueSchema.js\":\"dfa5d70c97ab111f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/HeaderItem.js\":\"954801b8a9d9e2df\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/QuickFind.js\":\"cf7b4c1351a592e0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/index.js\":\"496d6236b62ffe70\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/recents.js\":\"ce661ad790fbb823\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/resultItems.js\":\"4f47b5637a14c8ce\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/selection.js\":\"fbf5ea82f93cc0ad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/toggleStore.js\":\"664986779bbeef1c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/HeaderItem.js\":\"95302923640ef367\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/RecentsPageBlockRenderer.js\":\"03027827b400b667\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/grouping.js\":\"3f86256a38104b5d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/index.js\":\"474eac4b83d9bae0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/target.js\":\"567290801fc6f7bd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/codeMirrorExtensions.js\":\"7b2ca9973abfbbf3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/contentPrefill.js\":\"8a53086aa897f3b8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/dataExtension.js\":\"cb39be8acbc9c4e5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/index.js\":\"a1a95f5384127328\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8b1ae69123d744d8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/invalidation.js\":\"ea48bd8473892f35\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/localSchema.js\":\"1163f618d0b3324a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/blockrefs/index.js\":\"a9896492a1053bd2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3e7030c999c728ce\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/index.js\":\"81221cc8e5e8c727\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/referenceNode.js\":\"f0ee15336d3f3cd4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/remark-reference-occurrences.js\":\"49c39157198c4e71\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"14f410a11a1a965f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/index.js\":\"ade2f1a8fc2ad750\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"9d7a8452326875dc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"9373109f94656bce\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/mergeRetargetProcessor.js\":\"4c9be138eea0c7d5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/parseFence.js\":\"f65c678c2c6dcdf0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/referenceParser.js\":\"de30e44bf19c95ad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/referenceProjection.js\":\"10269c0f45aa9522\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/referencesProcessor.js\":\"3488337259b1b3ad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/renameProcessor.js\":\"7051f1687f27bd96\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/spanReplacement.js\":\"fdc9607cff745324\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/htmlToOutline.js\":\"32e4f6736ad00827\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/index.js\":\"373b52eb0c6036cf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6582eaed20c839f7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/pasteDecision.js\":\"16883e2c9102e98e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/action.js\":\"799e1fbe4c7e6610\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/blockIds.js\":\"bdd88ab91a599281\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/content.js\":\"d7c2913d9819b532\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/effect.js\":\"80939dbcf66f57b8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/ids.js\":\"0d63573eaedcfb25\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/import.js\":\"27f923e47cf70ea4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/index.js\":\"58334a7dbd82a4a2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/plan.js\":\"422855f8f9ea436b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/plugin.js\":\"f25f8926c6e1c3e5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/promotion.js\":\"6ead39624672031c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/properties.js\":\"c03025035f7b61ca\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/references.js\":\"e781798367e6cbc2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/report.js\":\"f458027a5ac60f6e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/roamMemo.js\":\"a87355f52fc7a4c7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/runtime.js\":\"df2ea56178494f75\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/schemaReconciliation.js\":\"04418d05cf5b69ba\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/srsMarkers.js\":\"619d65e1a4ff5513\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/todo.js\":\"144a6c8bd80c0f0f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/typeCandidates.js\":\"f8fe34261f7ef606\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/types.js\":\"eaa337f95e7886c4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/search-health/index.js\":\"317a8972215fc5cb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/search-health/store.js\":\"8c61f355febb606e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/HeaderItem.js\":\"e95bbfdcbd9fbe6a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2e8a416f83d7c539\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/index.js\":\"1ab93c16d4838136\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/model.js\":\"562b4461cb97b2f7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/toggleStore.js\":\"4d33db9155a8f092\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/useKeyInspector.js\":\"a1366110206e836c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"880feada4a31f929\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/ShellDecorator.js\":\"e5ab05444e4a0b76\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/actions.js\":\"8c38cce853e965a2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/exclusionsFacet.js\":\"1c2538add431c3db\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/index.js\":\"2af12deec119f8b3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/shell.js\":\"1a74fd0b43580651\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/surface.js\":\"b396e86d0d8a5b98\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/walker.js\":\"744289742df18c9c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/RescheduleToast.js\":\"bb48b4615ff2f5a7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/dataExtension.js\":\"8d4b23b7fbe5bedc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/index.js\":\"3b8ca3c7f532c316\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/indicator.js\":\"a905291b00b13392\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/moveSrsState.js\":\"290af187f47979b5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"07822e2832bf11b2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/scheduler.js\":\"cc00494a583c73a4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/schema.js\":\"570dac99c5a0f2e5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"5e2fe1fb37f7bd7a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/srsClipboard.js\":\"60b4b10c0c6e4ea4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c584e3a2c9b8596e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b40f6188fb8c47e0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/DeckPicker.js\":\"365982d5556d5b37\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/ReviewControls.js\":\"f4b29367496eade4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0e888f6ee787853a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/ReviewSession.js\":\"f103301496a37ae9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/actions.js\":\"73194abd73bc4c25\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/archive.js\":\"7702db8edf5a673a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/dataExtension.js\":\"98264542b28ff9c9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/deck.js\":\"9210bbcb89110798\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/dueQuery.js\":\"e16c109dfbc6ce7c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/gradeDecision.js\":\"99d45a4eb1996eec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/index.js\":\"98efb2f3db167d10\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/keyHints.js\":\"1803ef15b781aa9e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/reviewCardLayout.js\":\"c94b498fd1b3ac24\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/reviewProgress.js\":\"8781d1db8e317e62\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/schema.js\":\"e3744d53b9e7de69\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/useDueCards.js\":\"59de3cad2e270d5d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/startup-metrics/index.js\":\"ae9dae246603940e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/startup-metrics/record.js\":\"1d9e9786b3045210\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/storage-persistence/index.js\":\"4c0a6b1b65b8b717\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/storage-persistence/persistenceStatus.js\":\"f755ebb277cb77d4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/storage-persistence/requestAction.js\":\"fed2632b9aa54068\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/TypeChipsDecorator.js\":\"f535c117f2f9888d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/codeMirrorExtensions.js\":\"dd51e1bd71519052\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/index.js\":\"700f7ebb4834166b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/typeAutocomplete.js\":\"a5cd1af10f6b7d67\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2d3254235f613e04\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/actions.js\":\"c9ffb4df4f5b0a91\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/anchor.js\":\"a3fb35c26bcc4a25\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/events.js\":\"3f22b901b95dd85a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/gestureActions.js\":\"bc4021d3141827c6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/index.js\":\"b6a2f563e9e88369\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a8667db73a52f631\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/sync-metrics/collect.js\":\"d4cdc2af52c328ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/sync-metrics/index.js\":\"fbefa62345cf6ee9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/sync-metrics/record.js\":\"f1b7ad33277839de\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/RejectionDialog.js\":\"db66f553799c079c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f32e3647ebc6db53\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/index.js\":\"fc0ecb50c7d6e1a4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/model.js\":\"d6c3f229e77f6e68\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/queueCounts.js\":\"0b636f841a7beee2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/rejectedHelpers.js\":\"5d03f54af24eb4fe\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/rematerializeAction.js\":\"8114f139bd8f2518\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/useHysteresis.js\":\"b80264b673369104\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/ColumnHeaders.js\":\"bc615ff64594b119\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/TableLayout.js\":\"ab8b7eab5a86f7f4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/actions.js\":\"15cd9da60a7dab61\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/cellEdits.js\":\"ace99f99c1cce7e1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/columns.js\":\"67a5fececdfb95b2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/controller.js\":\"d374d4cae7fcb6a0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/convert.js\":\"f1a5d9b3d3c52a4c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/dataExtension.js\":\"70704d0390f36af8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/index.js\":\"65cd24d75f9801ce\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/keys.js\":\"62b4c398256dae43\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/model.js\":\"c8b3943dfd32354b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/registry.js\":\"58b8d3c19f1a47de\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/schema.js\":\"4113ffdd14f51d5a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/theme-toggle/effect.js\":\"b68f913cd5ee1685\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/theme-toggle/index.js\":\"abd2e9023f815f8c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/theme-toggle/theme.js\":\"1ce88397a7d10219\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/actions.js\":\"8e52604e99e95783\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/dataExtension.js\":\"5c50e886782286fc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/index.js\":\"d3733ecb2a3688d3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/schema.js\":\"073e9bebb72713b9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c4a6d23437364e7b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/actions.js\":\"237b6f31a9c0b86a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/defaultItems.js\":\"600ba8a8cd3ae407\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/facet.js\":\"7afcc5cb620e85c0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/holdRecognizer.js\":\"842dbcf89e0f17b7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/index.js\":\"0235e646aa15ca66\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/update-indicator/UpdateIndicator.js\":\"3077ad1d97ff7de6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/update-indicator/index.js\":\"f0108798400ca0a8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/update-indicator/loadTimes.js\":\"b2940dfeab31a125\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/VideoNotesRenderer.js\":\"4b8a6af79b370087\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/VideoPlayerRenderer.js\":\"1ea043380c892a25\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/VideoTimeStamp.js\":\"dbc60de24a107364\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/actions.js\":\"ac537855eda52869\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/index.js\":\"133ebc32605ef698\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/markdown.js\":\"d2f5dab9283841d0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/notes.js\":\"f875fc75e5f77348\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/registry.js\":\"1411db5548669677\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/remark-timestamps.js\":\"cc5eae4546cd04ed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/view.js\":\"0f4d633d7e1aba65\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/LinkHints.js\":\"a7b09f5716563fdf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/index.js\":\"3f0de18f027c5f2b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/model.js\":\"5fdd7c73efd76e2a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/settings.js\":\"16962692cf59df33\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-normal-mode/actions.js\":\"ffd654a41212381b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-normal-mode/index.js\":\"8dce27a5409565ae\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-normal-mode/interactions.js\":\"0f3ae2e7eeccf770\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/workspace-header/index.js\":\"c4b586cd126a2f72\",\"/knowledge-medium/pr-preview/pr-1834/src/registerServiceWorker.js\":\"1bffb67122299d2c\",\"/knowledge-medium/pr-preview/pr-1834/src/requestPersistentStorage.js\":\"b3104784969c8988\",\"/knowledge-medium/pr-preview/pr-1834/src/services/authRequestDeadline.js\":\"afb5fb493d34ec53\",\"/knowledge-medium/pr-preview/pr-1834/src/services/authStorage.js\":\"35e33c240bbe012e\",\"/knowledge-medium/pr-preview/pr-1834/src/services/powersync.js\":\"a421fa7173e34f3f\",\"/knowledge-medium/pr-preview/pr-1834/src/services/supabase.js\":\"174db52db596b487\",\"/knowledge-medium/pr-preview/pr-1834/src/services/uploadErrorClassifier.js\":\"029a9f07c3ab3e48\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/ActiveContexts.js\":\"a42738c57fd05967\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/HotkeyReconciler.js\":\"79cc255695e4e003\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/WipeLocalDataDialog.js\":\"e429c21fb18bb012\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/actionDispatch.js\":\"c27a2cc6b7477eb1\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/actionRefItems.js\":\"bc8ad8eace1c7206\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/applyKeybindingOverrides.js\":\"1e67a0208e576332\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/blockActions.js\":\"9fe0edbb48b7c46a\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/canonicalizeChord.js\":\"5c719f0a11b5823d\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/defaultContexts.js\":\"034ec36f7842ed45\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/defaultShortcuts.js\":\"59fd4530b9e93df5\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/effectiveActions.js\":\"46d7d04a8d8c64d1\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/gestureAction.js\":\"8cedc09a989441ce\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/gestureBinding.js\":\"455f8c262acc78e9\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/holdRegistry.js\":\"7c56fc73c1fdbc38\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/keybindingConflicts.js\":\"42d86ea40f16b9d9\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/keybindingOverrides.js\":\"aec71d378114a8d2\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/pointerAction.js\":\"361c7934b0e76ad0\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/resolve.js\":\"d85f2cc243207bcf\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/runAction.js\":\"5ce5421dfae3ad71\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/sequenceMatcher.js\":\"9413b9b4db4caf43\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/types.js\":\"d423458fe2f600ec\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/useActionContext.js\":\"eadb7ad33044686b\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/useActionDiscovery.js\":\"6cd844aa43c1c53e\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/utils.js\":\"cdaa6b09c6e6bf93\",\"/knowledge-medium/pr-preview/pr-1834/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1834/src/sw/bootStore.js\":\"4f04dc8f62afaa69\",\"/knowledge-medium/pr-preview/pr-1834/src/sw/previewDatabases.js\":\"7cf846615fd5d911\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/byteTransform.js\":\"8a8cea282f3dabfb\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/attachmentCleaner.js\":\"cbefad67827db8a8\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/attachmentParts.js\":\"6171e2201cea0340\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/bundleParts.js\":\"3062c65d457bcd3d\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/bundleRecord.js\":\"f2c64ef3871b8c58\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/manifest.js\":\"2f4652ad990b2414\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/takeBundle.js\":\"ba88e47ac811d7aa\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/verifyBundle.js\":\"914ca636ccc969ca\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/cleaningStage.js\":\"a63e0ce65e612948\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/conversionKey.js\":\"1dfd2fc558888ee7\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/conversionServer.js\":\"53f6760380db15f7\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/flip.js\":\"f6f149db0b1394ae\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/flipAttempts.js\":\"79220e8e605be682\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/pages.js\":\"c010769b7989c8cb\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/preflight.js\":\"53be8bc2575ccf1d\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/reseal.js\":\"70e55dabefef2526\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/runConversion.js\":\"356bd4ba1c4ec0be\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/runLock.js\":\"ce53d6e045786098\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/sealing.js\":\"530dafd463626dea\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/sealingStage.js\":\"be63ec2d035151a2\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/stage.js\":\"7cb23858f289d9b5\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/verifyReseal.js\":\"12fcf86e96c549b9\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/aad.js\":\"2cdbade089875725\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/aead.js\":\"9d353010f31a23db\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/base32.js\":\"dfa2bdaf10a52fc7\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/base64url.js\":\"7c2a1e22e4849b38\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/binaryEnvelope.js\":\"9a7beaf0ff3698d3\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/byteAead.js\":\"986abdb1edcee803\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/canary.js\":\"adaa77d3a4a2d997\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/contentHash.js\":\"af58f3489d92ba93\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/contentKey.js\":\"44a2fdf3d592c156\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/derivedIdNamespace.js\":\"461391c3b0d3a4a9\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/envelope.js\":\"0feac02c7f31b474\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/hex.js\":\"4ceed640fcc9c44f\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/sha256Hex.js\":\"1195ce9fa8a55fa0\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/workspaceKey.js\":\"21fc18b4b2405c57\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/conversionState.js\":\"790204a2544a0e05\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/createEncryptedWorkspace.js\":\"973124980045319d\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/pastedKey.js\":\"325efa9642c726e3\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ec6b69b1549b7d89\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/upgradeWorkspacePin.js\":\"066d05cfb0aa0438\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/keyStore.js\":\"02f41422abceaeaf\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/mintWorkspaceKey.js\":\"83a65afa31da7263\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/modePin.js\":\"ce3c24206c53d0a9\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/openWorkspaceKeys.js\":\"4c2408ac6aadca51\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/resolveWorkspaceEntry.js\":\"3c8d2a0ef2d38c38\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/resolver.js\":\"e7d1dbe287743a74\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/workspaceAccess.js\":\"96664a847a7af1b3\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/transform.js\":\"f5085ec4e43499ea\",\"/knowledge-medium/pr-preview/pr-1834/src/themeBootDefaults.js\":\"38139b16055d27c8\",\"/knowledge-medium/pr-preview/pr-1834/src/types.js\":\"abcd3d0c867fb9aa\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/ClientLocalSettings.js\":\"7d31149276329a66\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/abortableSleep.js\":\"566e42b0ab8a517c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/array.js\":\"272c16eb2feb6eef\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/backlinkAutocomplete.js\":\"e115604a59916849\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/blockCrumbs.js\":\"eaeff099402048bc\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/blockrefAutocomplete.js\":\"83edc43d9758c159\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/cadencedIdleJob.js\":\"f82cdef4302102b1\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/callbackSet.js\":\"b41392b3c8046f5a\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/clientId.js\":\"534cd19ac412ea65\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/codemirror.js\":\"3955baeec8d216db\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/codemirrorCompletion.js\":\"95fcb40205f75a6e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/copy.js\":\"dd70f75c106a28e7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dailyPage.js\":\"eaf1a9ea21fcc020\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dbForensics.js\":\"77bb773f594c88b9\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dbForensicsHooks.js\":\"e8eb2d2522344ffe\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/deleteBlockThroughUi.js\":\"ba60ad25ad631038\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dialogs.js\":\"cdae91351ebd1a2d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dom.js\":\"b4208d868436b9c7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/downloadBlob.js\":\"c4df6c6c47b69687\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/exportSqliteDb.js\":\"a5d4ff8fb4b60bb3\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/fileSystemAccess.js\":\"5c563dfadc497e7a\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/flipSlide.js\":\"397f60e40efc702c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/fnv1a.js\":\"337fb9a1c1b2a616\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/formatBytes.js\":\"6144dc493d1b2c46\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/fuzzyRank.js\":\"d79dff878b1fd747\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/idbKeyedStore.js\":\"6cda4f42224fec8c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/idleCallbackPolyfill.js\":\"ee346424515d28c7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/keyboardAwareScroll.js\":\"ef9f01f1b4512d9c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/keyboardViewport.js\":\"cc4a93a6dfe46009\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/lastWorkspace.js\":\"db024f8602fd8c44\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/layoutColumns.js\":\"0252a362040d0d7c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/layoutSessionDom.js\":\"71d75b722edb2428\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/layoutSessionId.js\":\"0fd4673d001a4bd7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/linkClickGestures.js\":\"ee3d703626031195\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/linkTargetAutocomplete.js\":\"4357eaeb719efcb6\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/localDbCorruption.js\":\"ada83ce40319b787\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/localDbRecovery.js\":\"ef7303f264d5f7d3\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/markdownParser.js\":\"5d3f60c7e0286cfb\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/memoize.js\":\"a9bf32761bc7e80f\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/nameFieldCommit.js\":\"f2677632c62bcefd\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/nameList.js\":\"c86a05e2b96a952a\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/navigation.js\":\"d6a8d0feb0c866d7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/omnilinerNamespace.js\":\"6a34bd016e5567a9\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/opfsPageScan.js\":\"7221441b4233582b\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelClearance.js\":\"c3f8f92d45553e87\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelHistory.js\":\"2da5cc2572e83c41\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelLanes.js\":\"b126689afb75ac76\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelLayoutProjection.js\":\"7ea9df1007ab6909\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelScrollAnchor.js\":\"979a6548508791b9\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelUrlFlags.js\":\"8b55f9ee24969455\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/platform.js\":\"f5d19b494b855ce3\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/pluralize.js\":\"84b47e8023b68f77\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/propertyCreation.js\":\"a128f97246d084ec\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/propertyNavigation.js\":\"d65f18d7bf0d1726\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/propertyValueContext.js\":\"cad896e89e432a1c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/react.js\":\"220fed1bfc1e6d87\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/relativeDate.js\":\"df1bde45587e499b\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/relativeTime.js\":\"b8eebf0f477df0c9\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/renderScope.js\":\"884ef093f6a73ffd\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/resolvedThenable.js\":\"e62c6897a736c83b\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/routing.js\":\"2d6ff2847df386a8\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/safeMode.js\":\"06d6588446498adf\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/scheduleIdle.js\":\"9572c0df125f501e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/screenWakeLock.js\":\"35c7cb118937974b\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/selection.js\":\"4096c339e0dd3ee2\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/softKeyboardGrab.js\":\"2db2656f3993e609\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/startupTimeline.js\":\"d964f878d01ac9fd\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/state.js\":\"6362cd84c73d8639\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/string.js\":\"023c6733b2179304\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/surfaceZoom.js\":\"298b9ec656f9458e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/time.js\":\"3d1b3ff62e881740\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/toast.js\":\"9dafa5cb704cb404\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/toggleStore.js\":\"975cbcf506461ae4\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/untilStopped.js\":\"4ecdc2f2f999071e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/userActivity.js\":\"5f37321f92dddcf0\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/viewTransition.js\":\"cf466434e391d710\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/viewport.js\":\"0541afe45c150af0\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/webLock.js\":\"2b12be00dcb22651\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/workspaceRecovery.js\":\"e6857e3c3c0f375d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/workspaceSnapshotStore.js\":\"25bd4955060b51de\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-compiler-runtime.js\":\"4e507dbfb2592ad1\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-client.js\":\"821b0cda85b1f361\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-server-edge.js\":\"984e2b5a1d5f577d\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-server.js\":\"6bd3110c8f7a4f36\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-static-edge.js\":\"adc38ee54fef4042\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-static.js\":\"6343a8a12ded3c0b\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-test-utils.js\":\"c87435e7b75a71b3\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom.js\":\"4deae1ffa35473fb\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-jsx-runtime.js\":\"fd0fcf1980abc568\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react.js\":\"129782f054c4726a\",\"/knowledge-medium/pr-preview/pr-1834/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1834/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1834/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
