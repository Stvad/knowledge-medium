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
		buildId: "ba8bec7e7bfd-08c62c9a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1834/\":\"9427041ea9f88f82\",\"/knowledge-medium/pr-preview/pr-1834/index.html\":\"9427041ea9f88f82\",\"/knowledge-medium/pr-preview/pr-1834/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1834/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1834/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1834/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1834/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1834/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1834/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1834/assets/FacadeVFS-BbMTrHoD.js\":\"1e075e4f3ef26c66\",\"/knowledge-medium/pr-preview/pr-1834/assets/OPFSCoopSyncVFS-DDQd3ZAp.js\":\"032d4b4f442d444f\",\"/knowledge-medium/pr-preview/pr-1834/assets/OPFSWriteAheadVFS-ChUt6bYY.js\":\"acd5a0c5defcd08e\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-BOtHaabN.js\":\"87696b79606932d3\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1834/assets/wa-sqlite-async-Bv_U1qeC.js\":\"114b1d83fa7291d4\",\"/knowledge-medium/pr-preview/pr-1834/assets/worker-rXhnQYLa.js\":\"b14d0a6d6d1d1fd9\",\"/knowledge-medium/pr-preview/pr-1834/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1834/chunks/app-cb0xGPW9.js\":\"15a38060c4917a0e\",\"/knowledge-medium/pr-preview/pr-1834/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1834/index.js\":\"4804e855ef2ca514\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1834/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1834/assets/AccessHandlePoolVFS-CTX513ie.js\":\"318e88602d09ec1c\",\"/knowledge-medium/pr-preview/pr-1834/assets/IDBBatchAtomicVFS-B_2klZLe.js\":\"685945e3881749d7\",\"/knowledge-medium/pr-preview/pr-1834/assets/MemoryVFS-D2MCNKhC.js\":\"d475acc0b2b3cc96\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-async-C3jmRr2B.js\":\"8f7c9fae220719bf\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1834/assets/mc-wa-sqlite-lSV33sU-.js\":\"72f04048ec7b7158\",\"/knowledge-medium/pr-preview/pr-1834/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1834/chunks/AccessHandlePoolVFS-Re0z3YZf.js\":\"a822dd6593ef2d82\",\"/knowledge-medium/pr-preview/pr-1834/chunks/FacadeVFS-DYLxo8Ab.js\":\"53804dfc2f173d94\",\"/knowledge-medium/pr-preview/pr-1834/chunks/IDBBatchAtomicVFS-BhaVKIQ_.js\":\"86e093d14837cc94\",\"/knowledge-medium/pr-preview/pr-1834/chunks/MemoryVFS-B1r7X1W6.js\":\"245a7616cc2e2664\",\"/knowledge-medium/pr-preview/pr-1834/chunks/OPFSCoopSyncVFS-Cs8QsVkT.js\":\"9e3bc033ac725d65\",\"/knowledge-medium/pr-preview/pr-1834/chunks/OPFSWriteAheadVFS-C07OrgmA.js\":\"f28f494e3611d31d\",\"/knowledge-medium/pr-preview/pr-1834/chunks/Preview-BVBiWSVI.js\":\"fcf9d44fa568f1ee\",\"/knowledge-medium/pr-preview/pr-1834/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1834/chunks/card-DafpjjG9.js\":\"20ef925a03b43ee6\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1834/chunks/dist-S6lSOEK0.js\":\"90bc8a73a5e987df\",\"/knowledge-medium/pr-preview/pr-1834/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1834/chunks/mc-wa-sqlite-async-r3dPhsMf.js\":\"6269305a9e59a875\",\"/knowledge-medium/pr-preview/pr-1834/chunks/mc-wa-sqlite-cttdgm2h.js\":\"cb989467cd14fcc8\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-BS4ibZm3.js\":\"4b9ae14947cc7f28\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-BUkjIvqg.js\":\"29765c897c8b2169\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-C5nxG-7h.js\":\"2e3b3b0a61f2a41e\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-CEPUN8hX.js\":\"aded1852da55faf1\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-CZ_fy23t.js\":\"04f88796ee42c249\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-CakAuXD2.js\":\"fa3d716415f81efd\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-CfPvzhXz.js\":\"3aff5a6d7cbf95d6\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-dom-server-legacy.browser.production-Co4H_OW0.js\":\"5d3233a8729e26fa\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-dom-server.browser.production-CUXnNyX1.js\":\"53162ece417b8877\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-dom-server.edge.production-Bc09Eu5B.js\":\"37a049454c00c139\",\"/knowledge-medium/pr-preview/pr-1834/chunks/react-vcr2D6PX.js\":\"6bc0b2aa7c77c6a2\",\"/knowledge-medium/pr-preview/pr-1834/chunks/server.browser-5XnqS9Kf.js\":\"f2a794c6c80cbb11\",\"/knowledge-medium/pr-preview/pr-1834/chunks/textarea-Ck1FQdT6.js\":\"1233cdcd9a95f7ea\",\"/knowledge-medium/pr-preview/pr-1834/chunks/ui-DZDC_NKM.js\":\"8aa5f6cc7a65bc5b\",\"/knowledge-medium/pr-preview/pr-1834/chunks/wa-sqlite-BjV-gq26.js\":\"7f1929dd24b3b79d\",\"/knowledge-medium/pr-preview/pr-1834/chunks/wa-sqlite-async-CnCHQiSe.js\":\"87c5086cd7de6d8f\",\"/knowledge-medium/pr-preview/pr-1834/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1834/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1834/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1834/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1834/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1834/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1834/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1834/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1834/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1834/src/App.js\":\"4964f8c9d8dde5fb\",\"/knowledge-medium/pr-preview/pr-1834/src/appUpdate.js\":\"03f5c5a19c15cc77\",\"/knowledge-medium/pr-preview/pr-1834/src/appVersion.js\":\"8167072996a54aff\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/initialLayout.js\":\"542fbbf3488ffdf4\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/openWorkspaceData.js\":\"3ca7c3539afc0237\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/resolveWorkspace.js\":\"d6a54ba435e595b5\",\"/knowledge-medium/pr-preview/pr-1834/src/bootstrap/workspaceBootstrap.js\":\"1cb830c2406e4969\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockComponent.js\":\"77ad8b60b306f770\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockCrumbs.js\":\"f1d737dd596a89e7\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockEditor.js\":\"6f68f29cc3e62aab\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockLoadingPlaceholder.js\":\"6e2b7cf297b7046c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockProperties.js\":\"1235e8d92eb76194\",\"/knowledge-medium/pr-preview/pr-1834/src/components/BlockSearchPicker.js\":\"ddd3b8e089f86e31\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ConfirmBulkDeleteDialog.js\":\"df4d979dddfe88ca\",\"/knowledge-medium/pr-preview/pr-1834/src/components/DividerHandle.js\":\"bd88d40a1429cd57\",\"/knowledge-medium/pr-preview/pr-1834/src/components/DraftEditor.js\":\"4ab033d62c1f3261\",\"/knowledge-medium/pr-preview/pr-1834/src/components/GutterPill.js\":\"4f301d93dfb6ac0e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/Header.js\":\"eee1b83fbc89126a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/LazyBlockComponent.js\":\"4879b1f5ad855e63\",\"/knowledge-medium/pr-preview/pr-1834/src/components/Login.js\":\"781f74d72b32b945\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ZoomableSurface.js\":\"77b44527c7587199\",\"/knowledge-medium/pr-preview/pr-1834/src/components/editModeKeepalive.js\":\"1ef5cdecadbe4edf\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9255a6296fd5f08c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"78c2f566524c8eca\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/RefPropertyEditor.js\":\"b20a07032de1c49b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/RefTargetTypePicker.js\":\"83872a0c79870844\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/SelectPropertyEditor.js\":\"0bf36803ef5df4b0\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/TypesPropertyEditor.js\":\"76dc0cdc497e4b5b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/defaults.js\":\"014a783a73da5c5b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/kernelValuePresets.js\":\"b1f2832b10491b8a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/selectablePresets.js\":\"26c0028bda3a414a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyEditors/typesPropertyUi.js\":\"91e6569f1866dc77\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/AddPropertyForm.js\":\"b272d5d9e75208f0\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/PropertyPicker.js\":\"da0e093be23a4688\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/PropertyRow.js\":\"a485901f714aa662\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/Rows.js\":\"a616691bec3c97ac\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/actions.js\":\"2aca7d752b6857fb\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/declarationOnly.js\":\"4970627c53b41bcb\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/layout.js\":\"b99ee55aeb06a137\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/model.js\":\"a6d466edc8a9c5a3\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/shapeUi.js\":\"d3a545d666170f98\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/shapes.js\":\"376efaa1bd2e3d4c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/usePropertyEditingActivation.js\":\"903612de87ad2bff\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanel/visibility.js\":\"438974e0f3201234\",\"/knowledge-medium/pr-preview/pr-1834/src/components/propertyPanelSections.js\":\"d3d74e08cda0cd4d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/BlockEmbed.js\":\"2a0bc8e85f97d19e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/BlockLink.js\":\"96f16e073804947b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/BlockRef.js\":\"dbbe645e269f8835\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/ReferenceLink.js\":\"7e191e2f151127a6\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/cycleGuard.js\":\"52dad98a1dba06da\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/cycleGuardContext.js\":\"bd2d3e86d73113a9\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/linkInteraction.js\":\"3673309ea31bd40c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/referenceLayout.js\":\"4100a3ae4894f711\",\"/knowledge-medium/pr-preview/pr-1834/src/components/references/useBlockRefAncestors.js\":\"fe5740c04f6e0b87\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BlockGutter.js\":\"cf1987e41795d34f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BlockInfoDialog.js\":\"a3026383523d305d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BlockTypeBlockRenderer.js\":\"630a1392a9c3cbfd\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/BulletHoverCard.js\":\"6afeb328f2b7e88e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/CodeMirrorContentRenderer.js\":\"c33501caa3f05019\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0aaa2adac80bf394\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/ColumnResizeHandles.js\":\"04ea6aea37ff5fdf\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a30f1abd0bf37194\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/DefaultBlockRenderer.js\":\"cedeb910616577cd\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/LayoutRenderer.js\":\"2bfcf0dc0ccc4f67\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/MarkdownContentRenderer.js\":\"9e53d7f18a34feac\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/MissingDataRenderer.js\":\"9ec1731d5821d505\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/PanelRenderer.js\":\"e1230ab43f32b786\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2c58db6368d6b198\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/TopLevelRenderer.js\":\"7205ee0b24ec950e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/blockGutterMode.js\":\"4068bc09cc1f4a3b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/blockTitleText.js\":\"28ce43863bbf4b2d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/fieldCreationKeydown.js\":\"ed0470246eab86ed\",\"/knowledge-medium/pr-preview/pr-1834/src/components/renderer/layoutRootContext.js\":\"321199a8b212f56b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/typeChip/TypeChip.js\":\"3070a655fa552e8c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/typeChip/chipStyle.js\":\"50246144a8bb3d22\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/anchored-floating.js\":\"d688a2e9071927dc\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/button.js\":\"1b320c5892b82309\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/card.js\":\"00501191f7f8e22f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/checkbox.js\":\"8495de82c88ec92b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/collapsible.js\":\"07fc93694b69fa7b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/command.js\":\"6e6d3ebd25afff5a\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/context-menu.js\":\"aaf2afb05d9affb5\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/dialog.js\":\"c703d53461c9ba0b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/dropdown-menu.js\":\"fd62a8aa5af1db6c\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/floating-listbox.js\":\"82ad480483ff610f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/index.js\":\"40bb2520c410ec73\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/input.js\":\"3c3698566fb509c2\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/kbd.js\":\"c4c53657c9b84629\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/label.js\":\"873407fcf8741617\",\"/knowledge-medium/pr-preview/pr-1834/src/components/ui/textarea.js\":\"f52d4ce0afea3f82\",\"/knowledge-medium/pr-preview/pr-1834/src/components/useEditModeYieldKeepalive.js\":\"7cd99dc09c1dfaa5\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/BootFallback.js\":\"ed56d9d425ef34f4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/FocusedRowLazyMount.js\":\"93f14564bc9283bf\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/LazyViewportMount.js\":\"1a17fee566109827\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/LocalDbCorruptionFallback.js\":\"9f340ca9503d1db9\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/error.js\":\"a8bf2ce2fbb90eef\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/lazyMountRegistry.js\":\"dc6650897e055e45\",\"/knowledge-medium/pr-preview/pr-1834/src/components/util/suspense.js\":\"e8ad52d21936a415\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/CreateWorkspaceDialog.js\":\"51c963ce881992a4\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/PendingInvitations.js\":\"6ae66e636c234b72\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/SyncProgress.js\":\"1fdf99bd7b81e981\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/UnlockProgress.js\":\"5648385f365b3635\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceKeyGate.js\":\"4c7699f604d1871b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceSettingsDialog.js\":\"68692ed7b890eeaf\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceSwitcher.js\":\"5a2e00c1c6450862\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/WorkspaceSyncGate.js\":\"5a0b6ab17b50e94f\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/ConversionFlow.js\":\"8117631463990e20\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/ConversionFlowHost.js\":\"aff6437b68c23862\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/EncryptionSection.js\":\"89bd635e61d382fc\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/attachmentPrompts.js\":\"0ea52fde7776eef5\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7a22addf16deb0ba\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/conversionFlowDeps.js\":\"db21b938fa820a27\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/conversionFlowStore.js\":\"7409a658d833fbe7\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/flowUi.js\":\"be5bdf01258f933e\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/conversion/useConversionRun.js\":\"4a775547d6cade5b\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/keyUi.js\":\"2f52f11460a956b0\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/useCloseOnKeyLoss.js\":\"04d0b1eb092c9d70\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/useCloseOnServerE2ee.js\":\"9145cfd05487b25d\",\"/knowledge-medium/pr-preview/pr-1834/src/components/workspace/workspaceUnlocked.js\":\"3e87aa7491ef16cc\",\"/knowledge-medium/pr-preview/pr-1834/src/context/backgroundSubtree.js\":\"cb6ecb1f89820ffb\",\"/knowledge-medium/pr-preview/pr-1834/src/context/block.js\":\"257bdb5418813fc4\",\"/knowledge-medium/pr-preview/pr-1834/src/context/layoutWsContext.js\":\"bb10c0e2774b68da\",\"/knowledge-medium/pr-preview/pr-1834/src/context/propertyDisplay.js\":\"0fbaba9803dbe5cc\",\"/knowledge-medium/pr-preview/pr-1834/src/context/repo.js\":\"a062425848c0cd0c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/aliasClaim.js\":\"25a3e77203a546a4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/aliasSeatNamespace.js\":\"f5e77c516b02a741\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/blockData.js\":\"420160883cdc2866\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/blockType.js\":\"c568692e9eb1cea3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/changeScope.js\":\"55f8ead89315b15f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/codecs.js\":\"350a01d96342e01d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/derivedData.js\":\"ed108d0cfa0287d7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/errors.js\":\"fc213b84f468f85f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/events.js\":\"637a3e6ee45d1524\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/handle.js\":\"ec6573de356589f3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/index.js\":\"67b636fef1be95d7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/mutator.js\":\"b090d0cd85b9d386\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/processor.js\":\"4a6d099f6519fda5\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/propertySchema.js\":\"1da1eb6f8798ae8a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/query.js\":\"1a2b9ae40792de58\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/sameTxProcessor.js\":\"83b8416310005ef2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/schema.js\":\"ec6573de356589f3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/tx.js\":\"ec6573de356589f3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/typedBlockQuery.js\":\"b78b863f320f947a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/user.js\":\"695e63782012e644\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/valuePresetCore.js\":\"5516c9d3fb8757b8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/api/valuePresets.js\":\"c6241cc58cbfc114\",\"/knowledge-medium/pr-preview/pr-1834/src/data/attachmentCleanerIOVerb.js\":\"0d693b8086bba41b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/block.js\":\"50efa3774b02dfd3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockCache.js\":\"969172c986092d74\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockId.js\":\"a2833823ce480e0e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockLiveness.js\":\"28f49b4eb884f752\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockMerge.js\":\"30b333eba7bd4f8c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockSchema.js\":\"ca7b0bd1db5c9ed2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockTypeLookup.js\":\"9fc521e17cbe0070\",\"/knowledge-medium/pr-preview/pr-1834/src/data/blockTypes.js\":\"14ebac84b9efb920\",\"/knowledge-medium/pr-preview/pr-1834/src/data/clientContext.js\":\"1ca73d9dcf593de1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/dbFileSiblings.js\":\"625555570adbc08f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/definitionSeeds.js\":\"f58c44025638b3c9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/derivedIds.js\":\"c52506b74cf72ff0\",\"/knowledge-medium/pr-preview/pr-1834/src/data/drawnSubtree.js\":\"8442798d41a73634\",\"/knowledge-medium/pr-preview/pr-1834/src/data/facetBridge.js\":\"07f944bee00749e4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/facets.js\":\"397fbbda9bf67e4b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/globalState.js\":\"8ff8f3fc44d21fb8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/aliasClaimRederiveProcessor.js\":\"03b2bf35e98e73ea\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/ancestorBatch.js\":\"f90f061cdae25d98\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/blockTypeTypeifyProcessor.js\":\"495c85201150199e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/clientSchema.js\":\"160611e96e7351fc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/commitPipeline.js\":\"2cce1b714b3a345a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/devAssertions.js\":\"c2a0f1998b773a04\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/firstSync.js\":\"ca6649451a914ece\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/freshInitialLoad.js\":\"3e118aa0be46d7d0\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/graphBackfillClaim.js\":\"d1a5137c0f7eb29e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/handleStore.js\":\"6e81b783dab77114\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/idleMarkerJobs.js\":\"5e71020893a5f6c9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/initialDownload.js\":\"a308724c723fdac1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/initializeClientDatabase.js\":\"8d4b6750a1487f50\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/jsonCanonical.js\":\"81a1d525856e4862\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/kernelInvalidation.js\":\"1eed78dee28b1182\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/kernelProcessors.js\":\"800028a6ba0e8a54\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/kernelQueries.js\":\"a323bc680f3e758d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/mergeTypeMembershipProcessor.js\":\"5e1c3838ec6c4336\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/normalizeReferencesProcessor.js\":\"da1e35550d9b6959\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/poolInstrumentation.js\":\"657839d356da763d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/processorRunner.js\":\"46ad47a90163c4eb\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyCellBackfill.js\":\"8321e1aa37ebf975\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyChildMint.js\":\"9136f1a87430593e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyChildrenProcessor.js\":\"3fdae29c33b5bfe7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyDefinitionChangeProcessor.js\":\"da8c4e24754e2c35\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyDefinitionSynthesis.js\":\"7a90ad8ae298e0c8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyKeyScan.js\":\"33614b6273e9b92e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertySchemaResolution.js\":\"d042c3a2ed416e1c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/propertyValueEdits.js\":\"46caea868500599a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/raiseProtocol.js\":\"4f98ae9484112841\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/readBatch.js\":\"a296cfc1e22947f3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/refProjection.js\":\"2441e23c51e9e4c3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/referenceTargetLookups.js\":\"903cd5284fee077f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/referenceTargetProcessor.js\":\"c56d7749889abe42\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/replayMerge.js\":\"e99a6e29ae0d5c9d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/sqlBinds.js\":\"e59dd724d74b7fbc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"baef8d21dbf0a066\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/arrivalProcessors.js\":\"f67ab275c6c0abf2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/invalidate.js\":\"784108ce835ea52e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/materialize.js\":\"50c19db4e33f2c84\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/observer.js\":\"994c696f9d58b9f4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/syncObserver/reconcile.js\":\"b4163caa6d960f40\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/timingMetrics.js\":\"c9c3dffad285dfd0\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/treeQueries.js\":\"8c2d863278902983\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/txEngine.js\":\"ff6e2205ac6e29bc\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/txSnapshots.js\":\"fd2aeebc137a23d7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/typedBlockQuery.js\":\"5cd3863047de4cc8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/internals/undoManager.js\":\"f26f1dd4b3a4aaf0\",\"/knowledge-medium/pr-preview/pr-1834/src/data/invalidation.js\":\"5f5d7367d80b1e03\",\"/knowledge-medium/pr-preview/pr-1834/src/data/kernelDataExtension.js\":\"2251a868aa9221b6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/kernelPage.js\":\"5706b070d07966a1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/kernelValuePresetCores.js\":\"fe1b28bb0d2a6426\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localDbCorruptionSignal.js\":\"642968e4723b2d49\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localDbStorage.js\":\"75379707771112c9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localDbVfs.js\":\"5cc39753305d440f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/localSchema.js\":\"18f5781663d68a8e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/maintenance.js\":\"6e50ea668b925d18\",\"/knowledge-medium/pr-preview/pr-1834/src/data/mergeProperties.js\":\"9062b87fceed21d4\",\"/knowledge-medium/pr-preview/pr-1834/src/data/metricsConsoleHook.js\":\"98da604ff7e813b7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/migrationsPage.js\":\"3ac4da301a413ea0\",\"/knowledge-medium/pr-preview/pr-1834/src/data/mutators.js\":\"f7c43f022dea2c4e\",\"/knowledge-medium/pr-preview/pr-1834/src/data/orderKey.js\":\"c0add11f0734e063\",\"/knowledge-medium/pr-preview/pr-1834/src/data/orderKeyPlacement.js\":\"ad43d498d8e0b842\",\"/knowledge-medium/pr-preview/pr-1834/src/data/outlineSurface.js\":\"8cfe6231823c1f2b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/pendingEditorContent.js\":\"8ac02440d4095432\",\"/knowledge-medium/pr-preview/pr-1834/src/data/pendingUploadsSql.js\":\"4c2c4c6cbc512166\",\"/knowledge-medium/pr-preview/pr-1834/src/data/pluginStateExtensions.js\":\"56848a32942ecff3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/powerSyncLogger.js\":\"47c2b9df2713e5e8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/projectorRuntime.js\":\"0aa0d7f919c8169b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/properties.js\":\"5870ae50bf0c45db\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertiesPage.js\":\"6cd3eb03a6094fa1\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyChildren.js\":\"6ececa9835394d4c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDefinitionFanout.js\":\"c2e9afc30add1158\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDefinitionMetadata.js\":\"c7d930236480f534\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDefinitionRegistry.js\":\"a9d8e268170e9325\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyDisplayMode.js\":\"4bc72c917d3723d9\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertyRowCreation.js\":\"f593fb802e9cdbae\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertySchemaCreation.js\":\"2937143a1beb0849\",\"/knowledge-medium/pr-preview/pr-1834/src/data/propertySeeds.js\":\"4bd724c4cd990aa8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/recentsPage.js\":\"c3e9f0b8f325f713\",\"/knowledge-medium/pr-preview/pr-1834/src/data/referenceBlock.js\":\"ce1d7d4581b48b9f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/rejectedUploads.js\":\"51563f1150baeb7b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/releasePowerSyncConnection.js\":\"becb21177268b385\",\"/knowledge-medium/pr-preview/pr-1834/src/data/repo.js\":\"bc3f6d5595dba7f3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/repoProvider.js\":\"f6888aa35af58b85\",\"/knowledge-medium/pr-preview/pr-1834/src/data/rowProperty.js\":\"d0eefbc6cfa06c21\",\"/knowledge-medium/pr-preview/pr-1834/src/data/searchFilter.js\":\"c4f8be91fe3ee6b3\",\"/knowledge-medium/pr-preview/pr-1834/src/data/seedIdentityLedger.js\":\"44ee47e16c7b138c\",\"/knowledge-medium/pr-preview/pr-1834/src/data/stateBlocks.js\":\"092cb02e70bd1ff6\",\"/knowledge-medium/pr-preview/pr-1834/src/data/structuralEditPolicy.js\":\"1a2cbaa75452cf85\",\"/knowledge-medium/pr-preview/pr-1834/src/data/subtreeDelete.js\":\"34e675d19b5bdb79\",\"/knowledge-medium/pr-preview/pr-1834/src/data/syncStreamLock.js\":\"81a363158512e495\",\"/knowledge-medium/pr-preview/pr-1834/src/data/syncedTableSqlRecognizer.js\":\"a9bb663f874b6586\",\"/knowledge-medium/pr-preview/pr-1834/src/data/syncedTableWriteGuard.js\":\"ced9128979c8df53\",\"/knowledge-medium/pr-preview/pr-1834/src/data/targets.js\":\"22d365aa8fa00302\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeColors.js\":\"4e2540e16bc73f21\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeDefinitionMetadata.js\":\"ae8070b8b86c23cf\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeDefinitionRegistry.js\":\"58be1c9a7690b288\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeExtraction.js\":\"faee210e3ca6c6c2\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeInitialValues.js\":\"0040b5ff090bcc55\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typePropertyGroups.js\":\"f425be32a4682a3f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeSeeds.js\":\"34ab202fde02988b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typeTagger.js\":\"ff4e4650249aa718\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typedRecords.js\":\"c6225455bc01fb3a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/typesPage.js\":\"3d585eecd8e5f710\",\"/knowledge-medium/pr-preview/pr-1834/src/data/userPrefs.js\":\"6f15a5e1d4e7bf58\",\"/knowledge-medium/pr-preview/pr-1834/src/data/userSchemasService.js\":\"0a2b9c2690246a94\",\"/knowledge-medium/pr-preview/pr-1834/src/data/userTypesService.js\":\"9697df07c74e2e6d\",\"/knowledge-medium/pr-preview/pr-1834/src/data/valuePresetRegistry.js\":\"b587a94ce79f136a\",\"/knowledge-medium/pr-preview/pr-1834/src/data/visibleChildren.js\":\"f980073622d4310b\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceConversion.js\":\"0b31a4180870ef74\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceFirstSync.js\":\"e632abd35ea4859f\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceIdNamespace.js\":\"9b4e702c30f44ff7\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaceSchema.js\":\"b32f1bc3873d02d8\",\"/knowledge-medium/pr-preview/pr-1834/src/data/workspaces.js\":\"fdc11d657a6fac19\",\"/knowledge-medium/pr-preview/pr-1834/src/data/writeAheadLog.js\":\"a1593491bed20fec\",\"/knowledge-medium/pr-preview/pr-1834/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/BlockPasteShellDecorator.js\":\"7427c75af4a28965\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/atTrigger.js\":\"eb10f55ece28894d\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/autocomplete.js\":\"2821d49c23a9501e\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/codeMirrorExtensions.js\":\"4542c6608fd15f16\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/contentFlush.js\":\"8687b9ecf40a6230\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/defaultInteractions.js\":\"a4cfd67ff157a351\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/editSettleSignal.js\":\"96dd2aa37da80eff\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/insertImage.js\":\"af68ce1c8783c949\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/referenceCompletionRange.js\":\"a25a8ed8eebf2dc1\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/referenceTargetTypes.js\":\"88dcb6b7e39c7b66\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/syntaxContext.js\":\"4c2fca8c99ec72d2\",\"/knowledge-medium/pr-preview/pr-1834/src/editor/triggerMatch.js\":\"80c1b4c91c822ec8\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/AppRuntimeProvider.js\":\"bee03dd68af8cdca\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/BlockFocusShellDecorator.js\":\"1f756e7a72156f46\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/ExtensionRenderBoundary.js\":\"05fe0d666e240b58\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/PanelContentRecovery.js\":\"326901e0c8ed7330\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/apiCatalog.js\":\"de7a0eba067c47a7\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/approveExtensionHere.js\":\"c5d0e97e72824cd0\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/armedCutAppMount.js\":\"8a982f7c1153d597\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/batchableKeyedStore.js\":\"212612e31754c8f9\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/blockInteraction.js\":\"fdac06a0e99cf4f4\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/blockSelectionAction.js\":\"87af77663ba26c8c\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/compileExtensionModule.js\":\"33c5f8571adf7d75\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/compiledModuleCache.js\":\"da46ef86cce79bdb\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/continuousGestures.js\":\"72487cd0aab5b1cf\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/core.js\":\"c023e06cfff88560\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/defaultRenderers.js\":\"d8e617f91f05f8b4\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/definitionFanoutAppMount.js\":\"88d0a1f7ec0efa54\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/dialogAppMount.js\":\"398898d5a052fb76\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/dynamicExtensionSeeds.js\":\"77fcb58bdb73ee45\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/dynamicExtensions.js\":\"cef7fadc2f2228be\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/exampleExtensions.js\":\"97c08285423b6f86\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionApprovalStatus.js\":\"49139173b26ee28d\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionLoadErrorToast.js\":\"cc0da98c83528dc8\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionLoadErrors.js\":\"13441828b8e13041\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionLookup.js\":\"b713cf61c7325048\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionToggles.js\":\"28a9afb73844b049\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/extensionUtilitiesCss.js\":\"f0dde75ceb951b35\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/kernelPageDeletionGuard.js\":\"e1cdbf2521ab0a4d\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/liveRuntime.js\":\"706156071fa787a6\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/openExtensionsSettings.js\":\"1560dc8b837eb14e\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/overridesCache.js\":\"47bf77a661533c70\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/pluginIds.js\":\"9b8d9c333c8557a7\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/processorRejectionToast.js\":\"c66f02e555b8fe3b\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/runtimeActions.js\":\"8c9637bb17ed8fb8\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/runtimeContext.js\":\"d88d88a0a6299d77\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/staticAppExtensions.js\":\"e27c73199ea305e9\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/staticDataExtensions.js\":\"d1a7ab2cf9416821\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/toastAppMount.js\":\"7ff4d4dfcc9fcf10\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/useOverrides.js\":\"f323b11aa3750476\",\"/knowledge-medium/pr-preview/pr-1834/src/extensions/useShortcutSurfaceActivations.js\":\"30106bf2a0ceb90d\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/discoverToggleTree.js\":\"9ade4160687c8397\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/facet.js\":\"9a4ba3cf30bc14e7\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/resolveAppRuntime.js\":\"6597538d07af9ff9\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/runtimeEvents.js\":\"4d8561da6b5a586e\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/togglable.js\":\"5692f6c09141c77b\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/variantFacet.js\":\"34b0734e963b88f4\",\"/knowledge-medium/pr-preview/pr-1834/src/facets/verbFacet.js\":\"3c4aacb0583b2dfd\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/block.js\":\"b3db56ef9a335b9e\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/focusedChild.js\":\"8d094bcd2d342ce1\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/propertySchemas.js\":\"8bb09039766b5ab2\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/typeRegistry.js\":\"c3984a032d676d87\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useAncestorCrumbs.js\":\"93c4bd73900b6602\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useAutocompleteListbox.js\":\"d102dcf7fa8317d6\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useDebouncedSearch.js\":\"f5f06e625c03ec54\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useDebouncedValue.js\":\"2798a5f9fc36ed47\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useIsFocalRender.js\":\"ebf49933728dd001\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useIsReadOnly.js\":\"7f90b9112392d1cb\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useMaterializeBacklog.js\":\"bb036acc28b393f9\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useMinuteClock.js\":\"bdcb61bc10d0a7ec\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/usePanelLayoutProjection.js\":\"2b4f7f46e4dd70e4\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/usePendingInvitations.js\":\"b540207f9cc6c270\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useRendererRegistry.js\":\"752f354fd302594c\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useRetainedFieldRows.js\":\"05cfcfab6be2556a\",\"/knowledge-medium/pr-preview/pr-1834/src/hooks/useWorkspaces.js\":\"f1bfc8dab4c906f7\",\"/knowledge-medium/pr-preview/pr-1834/src/lib/utils.js\":\"08243d8eb664ab6e\",\"/knowledge-medium/pr-preview/pr-1834/src/main.js\":\"4918655fd0c864c6\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/MarkdownImage.js\":\"914c13406dd58902\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/blockSeparators.js\":\"cff8529a8e3bb5b9\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/context.js\":\"3086d8dba5d6933f\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/defaultMarkdownExtension.js\":\"a1c8f2e9a2bcbbac\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/extensions.js\":\"856cc6f7f19ae45a\",\"/knowledge-medium/pr-preview/pr-1834/src/markdown/renderMarkdownHtml.js\":\"4aa556aaf3f4c518\",\"/knowledge-medium/pr-preview/pr-1834/src/minimal-editor.js\":\"53284d128f4b912a\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/armedCut.js\":\"a4c31001e62e4554\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/captureMediaVerb.js\":\"25628b564ab8bbbf\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/clipboard.js\":\"5a0e3d044f84ad0e\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/decision.js\":\"a9ec3ccd594cb079\",\"/knowledge-medium/pr-preview/pr-1834/src/paste/operations.js\":\"83d0aa8cfa25cb2d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/account-header/AccountHeaderItem.js\":\"0df6d30698bbbde3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/account-header/index.js\":\"c0804f68c0d6585f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f0459f6f7f24f927\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/askAgent.js\":\"fb1469353577be17\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/askedStore.js\":\"0ec12bcfca8a0f75\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"338879efda2df712\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/chipState.js\":\"5d98afef2b0b78d1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d497c73a28179e03\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/index.js\":\"14a2f3ce32de6dbb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"15af9bdde7d1c601\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-dispatch-companion/schema.js\":\"829177339f32db32\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/AgentTokensDialog.js\":\"79b5b662cbd91fa3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/BridgePairingDialog.js\":\"46cdb9ecb6dc74f6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/addMedia.js\":\"60514139294cd083\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4e3777be991a1ba4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/block.js\":\"66723e99b915de5e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/context.js\":\"f448a693040f71eb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/displayIds.js\":\"40940fbd2489b40f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/index.js\":\"350522bbbc4cffcf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/outline.js\":\"ab0b4b6a573d206f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/properties.js\":\"690917d4f92d5102\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/refs.js\":\"adadfefe899a465d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5c6a30801c71e499\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/search.js\":\"52f82858c9575a0e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/shared.js\":\"6135dfb255b5e63c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"db4bca58c6b15086\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentViews/text.js\":\"a07a4651bb91e5f4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/agentWrites.js\":\"2ffcd617fe542bf7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/authoringCatalog.js\":\"654ea3cac1572b10\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/blockRefTargets.js\":\"a5cdf4ddbf52081d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/bridge.js\":\"8ca2d6ab53583e30\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/bridgeLoop.js\":\"e70bd0a6068451c5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/changeHistory.js\":\"47b549b0ff4612b1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/commands.js\":\"870092b48379b36c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/commentsCommands.js\":\"7a1577d268a40d14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/dataExtension.js\":\"4f336a0592e20027\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/dataModelGuide.js\":\"d5c1464e1f654054\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/describeRuntime.js\":\"0d8b112613594935\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/extensionLint.js\":\"d387db881ab9c661\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/grainAudit.js\":\"69a3d381cbda923d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/healthCommand.js\":\"99718b65386e3333\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/index.js\":\"a1d8d48d3db897e7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/presetIdentity.js\":\"960e4b53c21110ae\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5a4e9e35133a6402\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/readMedia.js\":\"eb12f60c7022ff8d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/schema.js\":\"692a97154e2ac7a9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/serialization.js\":\"57731f4e796b365c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/targets.js\":\"b90fbcc4db09558d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/tokens.js\":\"3d77bc722aa4c8b5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/watchEvents.js\":\"d8c0341f060d7081\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/workspaceGuard.js\":\"49718563940968b9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/agent-runtime/writeCommands.js\":\"c42ff707c332d9f9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/AliasCollisionToast.js\":\"ec0e0306da432b64\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/DuplicateNameBanner.js\":\"25b2cd7180066db7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/collisionMerge.js\":\"b54fb0bbe0795481\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/dataExtension.js\":\"0a3d23cb3f021851\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/index.js\":\"b6bc2821cf6003e9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/mergeCollisionAction.js\":\"db8cd9549efd09cb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/pageStyling.js\":\"f3372198e77087fc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/rejectionToast.js\":\"f465f5a92d3bf673\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/alias/syncProcessor.js\":\"6eb7a2ed70c30b1a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/actions.js\":\"dd80176f9a9e7e19\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/addComment.js\":\"0858c07f98510d8a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/anchor.js\":\"5257b9be3d134342\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/anchorState.js\":\"90b7c6159fd54382\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/commentLinks.js\":\"4a0b33e74390d6ab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/confirmThreadDeletion.js\":\"fc8f7a0f4be97fdb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/container.js\":\"5fb7788064b2a348\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/dataExtension.js\":\"64137e43a0c17da2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/deleteComment.js\":\"e16985658b427994\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/highlights.js\":\"a2857cf0889b60d7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/index.js\":\"7026e2b28cf2b78c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/linkedCommentsPill.js\":\"0124e65c7c0cbe5a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/margin.js\":\"e91eace8fddaadc5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/marginSchema.js\":\"744e138dc3aacf6e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/newComment.js\":\"a0fbb8214bea1f72\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/ownThreadPicker.js\":\"05e0c67b9d116972\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/placement.js\":\"0090434827cc0713\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/queries.js\":\"8d741616fd24ad06\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/quotePosition.js\":\"dc47139c9fc0b1b8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/quotedIn.js\":\"de093b802d11e047\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/quotedRange.js\":\"2ecee0f1343b8b75\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/rangeRefs.js\":\"a7ff03d20ab40310\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/readHighlights.js\":\"5a17e49c54f9529f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/readSelection.js\":\"ee2fc687d2896045\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/readSelectionUi.js\":\"6bcc5e7688c38e9c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/reanchor.js\":\"03fc46a671c287f4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/schema.js\":\"c27708ffb0405cef\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/scope.js\":\"3cca6506b2881753\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/scopeThreads.js\":\"0bc7f2a8343a4546\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/splitRetarget.js\":\"53f743babcfc3f4c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/suggestionCard.js\":\"e74e44b8741bfe29\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/suggestions.js\":\"2a31cf54d6abbeae\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/summaries.js\":\"77ec95431f19a843\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/summaryBatch.js\":\"37c7600c2080a430\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/surface.js\":\"61bffd58ca131b59\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/threadNavigation.js\":\"8e2072ae73fe1426\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/threads.js\":\"966cc8b594af6248\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/ui.js\":\"a880e93c7d326b99\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/annotations/uiStore.js\":\"2c002fd9e0136df5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-intents/appIntents.js\":\"e09ab80176a575fc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-intents/index.js\":\"b0ee8f131e159575\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-update-prompt/index.js\":\"59c0a14ebbf4eaf5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/app-update-prompt/status.js\":\"6bb71457cc1347a8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"cb18fceb799d08fb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/MediaBlockRenderer.js\":\"d09bb9b94e22cab1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e08a1e1194823599\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/MediaUploadReconciler.js\":\"c2c6307ced283780\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/assetDownLane.js\":\"7c28d8111a25be65\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/assetResolver.js\":\"d7848db24b2c3e67\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/assetUpload.js\":\"34d380d7eaac6d76\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/attachmentCleanerIO.js\":\"742f6b6a137533e6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5d04487c8d76db5c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/blobStore.js\":\"fe77acdfb06db1de\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/byteStore.js\":\"9d0336830cbaa9c2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/cleanerIO.js\":\"fe5cad65d4890fdf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/cleanupAttachments.js\":\"1dfa993ef399d7bf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/dataExtension.js\":\"59a2bceedd91c365\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/downLane.js\":\"e26ea1d07b1b09ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/index.js\":\"25cbbae0944a4a9a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/insertImageContribution.js\":\"d835c2b1413153a0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/laneArming.js\":\"996ec680cd5fb2ed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/laneLock.js\":\"bdf651f4fffab59d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaBlock.js\":\"76d48cb814aa79b5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaCapture.js\":\"773426f36b2cb1a4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaViewers.js\":\"17521ef1f4b4950e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/mediaViewersFacet.js\":\"70b62fc6af1367ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/pasteCapture.js\":\"80be4b1d93a68249\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/resolver.js\":\"39105bdfcf59eb8c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/retryUploadsAction.js\":\"8700c100af17595e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/storagePaths.js\":\"825d95ebd70adf02\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadDrain.js\":\"7931a64a0f17cbab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadLaneStatus.js\":\"3605e5a93deba024\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadReconcile.js\":\"3b311bd30f32144d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadRecovery.js\":\"0321046e7a56ed69\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/uploadStore.js\":\"0c948ad4b8336ad0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/attachments/useAssetObjectUrl.js\":\"becee76f23a2ca5b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f03038f57ca29724\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d48cc0ebc0081d9d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/facet.js\":\"9fda7a70d0d585cf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/index.js\":\"72cf57b51ca06a05\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks-view/prop.js\":\"8bc9f28caae59952\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/BacklinkFilters.js\":\"45a831d83856b3dd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9e5bc3bb35652cdc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/BlockEntry.js\":\"de6606cadba4bc9d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/LinkedReferences.js\":\"6e162f11e69353e9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"51a7d112df84f1a1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/dailyNoteDefaults.js\":\"4a540e573b4f26d3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/dataExtension.js\":\"06e6b2177ac720fc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/edgeExclusions.js\":\"adba61680eb7a0c1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/filterProperty.js\":\"0e1d135b87bfc455\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/index.js\":\"b2d75c75eb71d38e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b3e3563620c87d5c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/applies.js\":\"c04e1095edeefe05\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/countQuery.js\":\"b4fbe4600fe96f21\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1fcddcc71a9d6066\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/index.js\":\"b3321b2b9f4308d4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9b922fd1691c761e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/presentationInvalidation.js\":\"1dec48f40e92c072\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/propertyEditorOverride.js\":\"c7d0e6929d8d225e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/propertyFilter.js\":\"2eecf9a4919692a8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/query.js\":\"16914f00d1964554\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/resolveFilter.js\":\"4a4ff9fac337aa5e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/sourceBatch.js\":\"7ec14ae1ebc066ad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/sources.js\":\"f118c465583d17a7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/useBacklinks.js\":\"7cbe4953f06425f5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fd5c871163e5a76b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/BirthdayCelebration.js\":\"ff2e9298df4f0937\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/BirthdayOverlay.js\":\"bf8b3f10f54b69ad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/gate.js\":\"c3f5a57116f61a9e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/index.js\":\"f8adaa04d9e5f88c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/birthday/wolfTheme.js\":\"11a1806de24f3086\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/BlockDragLayer.js\":\"3fa85b42942c4b06\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/dragController.js\":\"1d70901da04415ed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/dropTarget.js\":\"764a25b1cd83821a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/index.js\":\"4bb12fa1892e54ba\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-drag/projection.js\":\"fbcafea17141e394\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-info/BlockMetaCard.js\":\"64c0107528ee8ff4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-info/index.js\":\"2ade1d7f989bf560\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/AddTagDialog.js\":\"12255eb2cac6adaf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"acaf2685fe030ea9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/TagNameIssueHint.js\":\"a291b58ab729dea9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/addTagAction.js\":\"a808363e9968e3c3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/appendTag.js\":\"3acf4bd1ed6f2789\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/config.js\":\"01e08130ccf8e26f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/dataExtension.js\":\"76e536b7a6cc7b0e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/index.js\":\"02856b229462f709\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/block-tagging/propertyEditorOverride.js\":\"ebeca921f25433d9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/BreadcrumbList.js\":\"66d78022709c3121\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9ef9a40a3745c349\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c9ef77b5add81421\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"72f03a9191e6952f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e60102c63237ca45\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/index.js\":\"dba57913784177ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f59514eb9897ea45\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/CharacterCountItem.js\":\"0c8fa03473e79f48\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e65154a2f041bd56\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/actions.js\":\"4410d1ea7cd5c5bf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/blockType.js\":\"b318ed2eafd22b0e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/charCount.js\":\"0dd485a49549fe5f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/dataExtension.js\":\"d1ca0d80aa27f55c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/index.js\":\"2695375c02e27c7e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/profiles.js\":\"cd59b6060d185554\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/properties.js\":\"8cf3e9464f796cc9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/character-counter/textCounts.js\":\"4c58d4c547b2acb0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/colemak-keybindings/index.js\":\"a861befbe5ab7ee7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/CommandPalette.js\":\"d38bb2247e4bb3c4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/HeaderItem.js\":\"1f8381619c0d1c4f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/context.js\":\"6fcd89e744c604ed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/index.js\":\"2d889275557136b7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/selection.js\":\"2bc0a9e7f0b0b4b2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/toggleStore.js\":\"e5149a0c86c9f4b8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/command-palette/useCommandPaletteActions.js\":\"3c23e29981124e5b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/ContributorBadges.js\":\"e8a49ca9e830fe19\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/author.js\":\"16ece8d575014130\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/codeMirrorExtensions.js\":\"77f3462a46ad1ff4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/dataExtension.js\":\"ac841b5bf661d45a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/index.js\":\"faf61488b441b470\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/mentionAutocomplete.js\":\"2d0831c87daa615d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/processor.js\":\"1dcaa6af08551884\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/profiles.js\":\"c18eaac620063a79\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/queries.js\":\"61375a64f25dc0ee\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/contributors/schema.js\":\"fc578f7e45c2241b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8b1109068af0a523\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/followOrigin.js\":\"691778ca0c1d1b71\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/index.js\":\"506faf4def397aac\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"cb1cc5b8af75cc21\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f2de0e403b505591\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/CalendarGrid.js\":\"0efda73179d53e70\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DailyNotePicker.js\":\"8a276d2dc1b5094c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f5ca3af2b035a9da\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DateNavDecorator.js\":\"24a287d6d40a1298\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/DateScrubOverlay.js\":\"530e0fd0d2144f02\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/HeaderItem.js\":\"8af46c45e8bdba3c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/ReschedulePicker.js\":\"5e27fdcc4fca04db\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0e2eba7a0ea71e2d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/actions.js\":\"2089010219d6481f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/blockDateAdapter.js\":\"b445dffa2b0584a4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/calendar.js\":\"975d2fd22b7c41ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dailyNotes.js\":\"413ef0770f6b07f4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dataExtension.js\":\"db4ec90353a42bf8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubActions.js\":\"3381325cf01b8414\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubGesture.js\":\"a5cbfb907353c963\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubGestureActions.js\":\"610491544e0cd2ec\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ddd7138a06984447\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/deletionGuard.js\":\"5f6686c09c896df5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/dueQuery.js\":\"1f37966e2c16f129\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/index.js\":\"67b5bfb32a4db6dd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/landing.js\":\"273a990c4f8d5cf8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/localSchema.js\":\"d8eb94099e79ead0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/referenceDateAdapter.js\":\"88905124072e8fd2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/rescheduleAction.js\":\"0f4ec729154fc91a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/schema.js\":\"442f00d079a3cc10\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/spreadBlockDates.js\":\"2b309094603f27f0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/spreadDatesAction.js\":\"655c33ee1c148143\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/today.js\":\"fe4f00e13c433bdf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"18b3b75496feccd3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"33e538c8c2ea7755\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/audit.js\":\"64a7123264eade1a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/auditAction.js\":\"0f205dd36ee14ec2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/auditRanges.js\":\"f3cd7a33827c0f25\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/diagnosticsSource.js\":\"65394b0ec964b314\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/divergenceScan.js\":\"e8bb21a12bb8349f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/index.js\":\"cc1d6e8583c0b1c7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/propertyChildrenChecks.js\":\"220fa9be08cbc683\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/referencesMirror.js\":\"dad5a85191259a05\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/rowJson.js\":\"cb848f89d53fc49f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/schedule.js\":\"951f5e81be924bba\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/data-integrity/store.js\":\"e9a049f4903adc14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-maintenance/action.js\":\"da8a26370b71a1a8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-maintenance/index.js\":\"2fd10216459a423c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-maintenance/plugin.js\":\"c7076db8fbfc28e1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c402eb8558fe764a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/actions.js\":\"32f0a394050c8fcb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/changeMarker.js\":\"4f8031103f6b174c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/diagnostics.js\":\"2adc995e8f438ff3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/fileSystemAccess.js\":\"570b84d1afc8d15d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/filenames.js\":\"b5d7fb40e66277e4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/index.js\":\"3d14d76a81bc7144\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/mirror.js\":\"78f66c9fc63d22cf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/runLock.js\":\"8e97393b09d84152\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/runtimeHealth.js\":\"4ac44fca799c5531\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/schedule.js\":\"6809e0bfd671dc37\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/db-mirror/store.js\":\"4946e98899368204\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/default-themes/index.js\":\"4547e7de6a0cfc5e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/default-themes/themes.js\":\"8df9da32eaa9f8c6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/diagnostics/facet.js\":\"3acc5c2aa521502a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/diagnostics/useDiagnostics.js\":\"d4623d21a09bbd45\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/dismissals.js\":\"067845c50a9b8538\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/index.js\":\"b14479efe98b71ca\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/status.js\":\"bcb18e019288d1b0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extension-prompts/store.js\":\"4bb709ffc81bc57b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"43061f72896c7ea8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/ExtensionsSettings.js\":\"15d7971f66a43ff4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/actions.js\":\"552d876c6fcc076f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/config.js\":\"e30ef2b0253cb85f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/dataExtension.js\":\"32105a9d50113cb8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/effect.js\":\"15c56a890e51e7b5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/index.js\":\"7e5548c161de5179\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ef7a05566c390994\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extensions-settings/useToggleTree.js\":\"c6aeb81af7a9c615\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/ExtractTypeDialog.js\":\"e374dc93a740d0a6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4ec0a3396f834826\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/PropertyShapePicker.js\":\"07740b7e4cd9f534\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/action.js\":\"ab013f732b6f3f83\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/extract-type/index.js\":\"7329ec9e80ce6c17\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/FindReplaceDialog.js\":\"26031c973aba5d8d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/HeaderItem.js\":\"d68ff9b46f69ec94\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/dataExtension.js\":\"8389530807a2a94e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/index.js\":\"4454094c4a63791d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/search.js\":\"c512ccceadefae5c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/toggleStore.js\":\"2a85d7fff3c8de4b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/LocationPropertyEditor.js\":\"8699f8ea47bc5003\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/MapView.js\":\"7623c04947174262\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/blockTypes.js\":\"089aa14d4e0734ee\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/codeMirrorExtensions.js\":\"4cfcefcad0ed1069\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/createOrFindPlace.js\":\"b6aa47e567e035d1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/currentLocation.js\":\"0600589f1def3a5a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/dataExtension.js\":\"1dca6cc8e11dd3bd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/geoContentDecorator.js\":\"68e6aa4ce7ab24ac\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/googlePlacesClient.js\":\"09beba2ae297a404\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/index.js\":\"6dffdb2e303ecc80\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/locationsPage.js\":\"27f99f4fa46755e7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/mapViewport.js\":\"a3688d321836c7bf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/pickCurrentLocation.js\":\"b1b902163ccc3062\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/placeAutocomplete.js\":\"6f9adc6d41b6236a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/placeNameCollision.js\":\"eaec2a0a91d90c2d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/properties.js\":\"9096d978ed939212\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/propertyEditorOverrides.js\":\"8347f747c34dc4b4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/query.js\":\"c63ff08e67b7286d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/geo/usePlaceSearch.js\":\"24d78e8ffe757fbc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e9b0b6ea2d68bd75\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"969ebbd36769cf74\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c26659d160a5269e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/config.js\":\"05b547b02531a3b3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/dataExtension.js\":\"1e75084ac95c507e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/facet.js\":\"5171ad871a09ced4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/grouping.js\":\"b1e16160bb64c01b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/index.js\":\"805986755f15f171\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"ec5c889742d77b1f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/query.js\":\"04aed004cac19ff5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/resolveConfig.js\":\"6febbc9229858301\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4bbd74c0783a2399\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"25f43c53ed22e968\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/HtmlDocumentContent.js\":\"e330bf31e4dbcb47\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/HtmlFrame.js\":\"1e401511242df721\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/actions.js\":\"4ac9780808e78905\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/blockType.js\":\"c44ef39b53369b2c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/confirmRunScripts.js\":\"7cefdecd157da712\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/dataExtension.js\":\"d0aca4fb51cfaef6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/frameAnnotations.js\":\"1095137dd321f84f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/frameDocument.js\":\"56a05f58ad12d406\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/frameTheme.js\":\"d17be8fd1df8c5b4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/index.js\":\"f0e74b2a1a134596\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/scriptConsent.js\":\"5ff1219629634c89\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/sourceMap.js\":\"554a6e850c7d2f48\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/html-document/useDocumentScripts.js\":\"f3ded017e815e6c0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/index.js\":\"e479ae14ce958d9e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/record.js\":\"39b3137c9ddd815e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/recordStore.js\":\"5f2a73a8092e381a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/responsiveness.js\":\"aa73421e8fc35327\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/schedule.js\":\"cd17a690d93588b6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/interaction-metrics/sessionContext.js\":\"d978faed7ac51f83\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"45c84501c24321ac\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a29cb6211a142530\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/actions.js\":\"408e762d6b645b98\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/config.js\":\"c2d53a237458c679\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/dataExtension.js\":\"411b0120b2a875e2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/effect.js\":\"b7c1a7ff4cc6463f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/index.js\":\"4ec1651e6917c3a5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/keyCapture.js\":\"b1056e3fc3f12fe6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/overrideStore.js\":\"1071c57a74eba3cc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"da9cddf89f3117fb\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/HeaderItem.js\":\"8552620112a89d45\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/LeftSidebar.js\":\"434a657cf27e2c5b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/actions.js\":\"9d1fbed35acf27d5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/facet.js\":\"73d08abe010d6d6f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/index.js\":\"293b20c4cbbef8e4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/shortcuts.js\":\"0421b6d9a7a131e6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/left-sidebar/toggleStore.js\":\"4323e1a42cb6c925\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/MergePicker.js\":\"c9d3dd3c9ff09a14\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/index.js\":\"c92008f287133692\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/mergeAction.js\":\"36df480c05777140\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/merge-blocks/strategy.js\":\"e048c11c63d11fb0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/Button.js\":\"9c533d591b226b38\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e1ebb539987e2ea6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/defaultItems.js\":\"412565dc404eb635\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/facet.js\":\"3f6e46c7b157dd67\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-bottom-nav/index.js\":\"66796b42fe0370a1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"06bf5fdd137d9240\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/actions.js\":\"063fbd54f50e6920\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"68233cc5081914ab\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/facet.js\":\"434839d651de43c5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/mobile-keyboard-toolbar/index.js\":\"9aad8e9c60eebfd2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f2d6d283be644f73\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/blockSubtreeMembership.js\":\"63f893a48d178bc2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/contextMenuItem.js\":\"ecad0d227ce82817\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/index.js\":\"1c9b41f34b9a0841\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/moveAction.js\":\"420b664c9fa5d2d6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/moveBlocks.js\":\"ffe7611015ac065c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/move-blocks/selectionAfterMove.js\":\"3e9252f83cd2a2f8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/TutorialBanner.js\":\"56d76fb76091ada4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/action.js\":\"e6326f8a390693fc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/bannerDismissal.js\":\"6583eb6fc6ee849b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/documents/cheatSheet.js\":\"89e8fa6fd544f54e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/index.js\":\"701b0275778d7211\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/keys.js\":\"cb693b990ff4945a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/landing.js\":\"1ebd114189cc2aea\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/outline.js\":\"949ba07e4d6966f6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/onboarding/seed.js\":\"678e28943c1f9512\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/PerfTrendDialog.js\":\"81474e051c83c96a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/analyze.js\":\"9ae0ca014eac1771\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/diagnosticsSource.js\":\"006afe745aaa816a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/index.js\":\"8f9a147caad041f4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/load.js\":\"fa4edbe93c203d49\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/monitorRun.js\":\"d848c83a0eedb3be\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/schedule.js\":\"e562ea6b61acbe4c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/series.js\":\"fa789aab15fc9266\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/store.js\":\"75946d283ebbc7ed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/trendAction.js\":\"07abfc606e18e3a4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/perf-monitor/verdict.js\":\"7f04e9aea124a10d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/plain-outliner/clickToEditAction.js\":\"fed88a1aa4892e79\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/plain-outliner/index.js\":\"f09a4cfe64ca00ee\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/plain-outliner/interactions.js\":\"6be1ed08813d9eb4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4d0d8f4c42970805\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/MigrationGate.js\":\"6bd81bec49427dc2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/MigrationGateDialog.js\":\"e6f66aefb88083b2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/action.js\":\"3c6fc20e937969e8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/index.js\":\"ec52cde60c8dce0c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/localRunMessage.js\":\"ad86c8c1dd161c53\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/plugin.js\":\"ffdb9197b42ee64d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/progressReport.js\":\"d773e5c11293a702\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/properties-migration/sweepProgress.js\":\"0e5c1ee0e42ddb17\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/FieldRowRenderer.js\":\"d14160d9325708db\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/ValueRowRenderer.js\":\"6719069a23ebd435\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/actions.js\":\"bae9a000d2c65d24\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/autocomplete.js\":\"dcc6c86c6ea9375a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/fieldRow.js\":\"15262b6d52164362\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/index.js\":\"ed644cc3e3677218\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/referenceWarning.js\":\"a69010b3cd3777fa\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/valueAutocomplete.js\":\"59b7dc2799386dc2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/property-rows/valueSchema.js\":\"47a203dd7c78bb68\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/HeaderItem.js\":\"11453238cd2c3b59\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/QuickFind.js\":\"512ad35097f56817\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/index.js\":\"da8f70a1705075f3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/recents.js\":\"5ff43a9542d642b8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/resultItems.js\":\"db6b3626d05637c1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/selection.js\":\"72a1cd3f6a5a9193\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/quick-find/toggleStore.js\":\"6ad4f3c46a84735a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/HeaderItem.js\":\"79fa1cbff6c8fc31\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f4a02d8cafd56ded\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/grouping.js\":\"80c943af87f66253\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/index.js\":\"b5daab9761f85441\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/recents/target.js\":\"77a0ba5900728248\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/codeMirrorExtensions.js\":\"d3a7c5fee37a331b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/contentPrefill.js\":\"961e3721552356c1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/dataExtension.js\":\"708f908db9a4fa4a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/index.js\":\"ef48e6d529c4c931\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"564064d8bda4d9e1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/invalidation.js\":\"23026252f9bfbf36\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/localSchema.js\":\"ccaf7086073f547f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/blockrefs/index.js\":\"7ebaa176aa8c70d3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7e66179a1925040f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/index.js\":\"eb978c851e7e1959\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/referenceNode.js\":\"46c9b45bc6227f62\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/remark-reference-occurrences.js\":\"374072f2319d7c1d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ba888647cae3a355\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/index.js\":\"dccf2418f9583156\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0d9429b7a79df7f6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"290f8fc3e0b6a739\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/mergeRetargetProcessor.js\":\"0e16c4fea6f9ca26\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/parseFence.js\":\"ab187efabb8987ad\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/referenceParser.js\":\"1471e9906db939f2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/referenceProjection.js\":\"c9eb77bdd27ae7e1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/referencesProcessor.js\":\"789732598c2f8598\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/renameProcessor.js\":\"0d314eeab49f4afd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/references/spanReplacement.js\":\"5e54f3a160983514\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/htmlToOutline.js\":\"985288072c3f74ff\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/index.js\":\"3359ad2169ef12fc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d0243e26206f6207\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/rich-paste/pasteDecision.js\":\"a457b4aef8610bb3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/action.js\":\"d97e273c2abb0824\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/blockIds.js\":\"f0c00ebbd6e0520a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/content.js\":\"15e023bc752ebd2a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/effect.js\":\"99668e0f100aea0b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/ids.js\":\"75fbd07c5d72d17d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/import.js\":\"31f49333c9d5ef4f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/index.js\":\"d62126f1923aa7f3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/plan.js\":\"8325cb0100267a55\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/plugin.js\":\"5f9f8650146c98f0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/promotion.js\":\"13953cadc6baabb2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/properties.js\":\"e559ea06ffb3cf6e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/references.js\":\"b3ea8527348c7285\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/report.js\":\"21152dd8a06b27ff\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/roamMemo.js\":\"8795b38ff8f54eed\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/runtime.js\":\"f4bb15e10db47833\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/schemaReconciliation.js\":\"0a317adff045fcc3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/srsMarkers.js\":\"620843a48dc3c72f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/todo.js\":\"6341dbc7837a01cf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/typeCandidates.js\":\"0bce0ec8728e407f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/roam-import/types.js\":\"8064ced5a26985a2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/search-health/index.js\":\"113907120535ba85\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/search-health/store.js\":\"df1d4a43e1318c58\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/HeaderItem.js\":\"ac51ae702df579e2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6ce81c41a54494bd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/index.js\":\"25abc4682067b071\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/model.js\":\"af126d45d8efdd5a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/toggleStore.js\":\"09354d2b50893133\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/shortcut-help/useKeyInspector.js\":\"7f12188af4725f06\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a1177ae776219f20\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/ShellDecorator.js\":\"5623240d5b013499\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/actions.js\":\"e2cccc0790eadc43\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e55e66662fe1c97e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/index.js\":\"2d6e717a6e06fecf\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/shell.js\":\"ad363fffa73a7851\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/surface.js\":\"a81e2e29ea16720b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/spatial-navigation/walker.js\":\"30e0adfef8d2538f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a3989b0a3b5c0f0c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/dataExtension.js\":\"0321b2e133d06e0e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/index.js\":\"07bd3f013d232a72\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/indicator.js\":\"7ef96d1f1a597377\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/moveSrsState.js\":\"248713ec9aad3590\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"59b3432d8a4406b5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/scheduler.js\":\"66783ab02e0f6751\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/schema.js\":\"e76fbbaf026b0c8c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"caa132d98fd37267\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/srsClipboard.js\":\"56b7c6df55cda894\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"773e5d6786bee509\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/DailyNoteReviewHint.js\":\"227bedcad75c660c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/DeckPicker.js\":\"ff46fb3066d45009\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/ReviewControls.js\":\"5194bd145256fa74\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3fc9f20e3e3cd1a5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/ReviewSession.js\":\"38aff6eb86bfead7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/actions.js\":\"7f13f05a5ea9eac2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/archive.js\":\"5e44913a1137b149\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/dataExtension.js\":\"4606a92f76b9c102\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/deck.js\":\"84e14a493971c1c6\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/dueQuery.js\":\"d8808b2c08f25d07\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/gradeDecision.js\":\"3fcbce97d93c30d8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/index.js\":\"578ea5c18f2dae31\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/keyHints.js\":\"227bb164afdf6e4f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/reviewCardLayout.js\":\"51deb0c943834a77\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/reviewProgress.js\":\"b4353b1f445e7014\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/schema.js\":\"e5fb4fe19cbce880\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/srs-review/useDueCards.js\":\"0e057bca5d67eadd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/startup-metrics/index.js\":\"bcd2959386f6a6ac\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/startup-metrics/record.js\":\"42411ce3e2f18a79\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/storage-persistence/index.js\":\"a94d24048e5095e1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/storage-persistence/persistenceStatus.js\":\"8cc4984bf183ba98\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/storage-persistence/requestAction.js\":\"f6cda30d2abc1aca\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/TypeChipsDecorator.js\":\"81cf54e4d7608f6f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/codeMirrorExtensions.js\":\"5a625b9a0226a80e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/index.js\":\"97f2483e20ff86c0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/supertags/typeAutocomplete.js\":\"64c09b38f8442c27\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c3f4ed28d3226669\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/actions.js\":\"a8b6cc9536fe6731\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/anchor.js\":\"c799e17fe6767861\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/events.js\":\"a8cb93a823506a7a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/gestureActions.js\":\"c04d5c0a6c2eef5a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/index.js\":\"864de6347c8e6e77\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9eecfe2f4729a79b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/sync-metrics/collect.js\":\"2d1a68cc745095c7\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/sync-metrics/index.js\":\"db6398bb96a3c34a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/sync-metrics/record.js\":\"974592ea24128745\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/RejectionDialog.js\":\"74ccd7511e397d17\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d38ead2810f1df74\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/index.js\":\"73afc0589fa8f5a8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/model.js\":\"6cf8eddd27a7e4e1\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/queueCounts.js\":\"bcb71cad416a5203\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/rejectedHelpers.js\":\"3b4057a0b4d7ada9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/rematerializeAction.js\":\"be07e11015c951df\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/system-status/useHysteresis.js\":\"17e011ef6823fb7d\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/ColumnHeaders.js\":\"233a6cf66476a2f4\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/TableLayout.js\":\"b3c1dbc25ea8a2e8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/actions.js\":\"73789a0d2d366fa0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/cellEdits.js\":\"b1d86baa887d79e2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/columns.js\":\"105afdf4443847f0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/controller.js\":\"e99b1cc577650541\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/convert.js\":\"4386fa0f00b80b73\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/dataExtension.js\":\"514a83e7382ea3d9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/index.js\":\"2d54ec1fdc485c45\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/keys.js\":\"411e00b4a5dc3be3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/model.js\":\"785921f534d335cc\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/registry.js\":\"4abff71e311af9cd\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/tables/schema.js\":\"fd98cdc1249a18a5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/theme-toggle/effect.js\":\"32dcc167aea11ca5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/theme-toggle/index.js\":\"008cf51942061e92\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/theme-toggle/theme.js\":\"b1b06fbbf628390b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/actions.js\":\"2c38d7827a2db101\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/dataExtension.js\":\"2a41085f45ae8f8c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/index.js\":\"a19affdbf40ce9d0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/todo/schema.js\":\"613eff0da492063c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c3e2baf600a92b3f\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/actions.js\":\"90e0c2c09d382b4a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/defaultItems.js\":\"90c7e56bffdb6bd0\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/facet.js\":\"731a04d3b4c29070\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/holdRecognizer.js\":\"5a6a3162aaca4624\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/touch-selection/index.js\":\"30de29ba7cddc734\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/update-indicator/UpdateIndicator.js\":\"e39d3fbaff90d2d5\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/update-indicator/index.js\":\"983f5c1a1bb83f55\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/update-indicator/loadTimes.js\":\"4f7ba2e8a2d4a460\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/VideoNotesRenderer.js\":\"1d56a481915d7d46\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/VideoPlayerRenderer.js\":\"5d42379998392e79\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/VideoTimeStamp.js\":\"892c991b2e93c2a8\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/actions.js\":\"80846c1d03249f40\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/index.js\":\"e978d85d54cdd653\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/markdown.js\":\"504eca72f499ce7c\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/notes.js\":\"8931134344b0248e\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/registry.js\":\"c69b96b225d37253\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/remark-timestamps.js\":\"389eba4047301107\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/video-player/view.js\":\"74a5beae93ddd83b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/LinkHints.js\":\"da9f3005eae128d9\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/index.js\":\"706741bc45194303\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/model.js\":\"c5059aea6f6e767a\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-link-hints/settings.js\":\"12b1ea7d939b14c2\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-normal-mode/actions.js\":\"9497095bd8ba18ca\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-normal-mode/index.js\":\"666483844a26e46b\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/vim-normal-mode/interactions.js\":\"16a7645a766f2cc3\",\"/knowledge-medium/pr-preview/pr-1834/src/plugins/workspace-header/index.js\":\"c88714520bf5b842\",\"/knowledge-medium/pr-preview/pr-1834/src/registerServiceWorker.js\":\"d82dd8bcb2976e9a\",\"/knowledge-medium/pr-preview/pr-1834/src/requestPersistentStorage.js\":\"d1f35b25d6b4d0a7\",\"/knowledge-medium/pr-preview/pr-1834/src/services/authRequestDeadline.js\":\"fbcf686e60284541\",\"/knowledge-medium/pr-preview/pr-1834/src/services/authStorage.js\":\"bf0dcf9e3c5d1991\",\"/knowledge-medium/pr-preview/pr-1834/src/services/powersync.js\":\"ff2e3a9ef006b7d3\",\"/knowledge-medium/pr-preview/pr-1834/src/services/supabase.js\":\"134865d8162f825d\",\"/knowledge-medium/pr-preview/pr-1834/src/services/uploadErrorClassifier.js\":\"55bd17433eef2681\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/ActiveContexts.js\":\"eb889a1592fd37b3\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/HotkeyReconciler.js\":\"13002e201d91946d\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/WipeLocalDataDialog.js\":\"917195db3c07115a\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/actionDispatch.js\":\"81779392344afb76\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/actionRefItems.js\":\"35c2dd5dda00215b\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/applyKeybindingOverrides.js\":\"de445252ecf06fd0\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/blockActions.js\":\"53fc527ef82063d7\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/canonicalizeChord.js\":\"e52d02463934c473\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/defaultContexts.js\":\"b4368988bfe9e09e\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/defaultShortcuts.js\":\"518f2f603c46b1f3\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/effectiveActions.js\":\"e249ea6ac87e2614\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/gestureAction.js\":\"0ae5b98e8f9189fd\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/gestureBinding.js\":\"0e2ed772e5f2da55\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/holdRegistry.js\":\"b34a1b6ee89a1674\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/keybindingConflicts.js\":\"c8210d760e311a08\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/keybindingOverrides.js\":\"24d08a5e6343a753\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/pointerAction.js\":\"7b036f3ef1936731\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/resolve.js\":\"afcfc3bf2cfdd720\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/runAction.js\":\"c27f34533fb082d5\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/sequenceMatcher.js\":\"9521158e398b5d2d\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/types.js\":\"5270c156fd1d91f0\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/useActionContext.js\":\"1762d6b42920d711\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/useActionDiscovery.js\":\"b06860c65af2447e\",\"/knowledge-medium/pr-preview/pr-1834/src/shortcuts/utils.js\":\"c328c31347b84819\",\"/knowledge-medium/pr-preview/pr-1834/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1834/src/sw/bootStore.js\":\"35183f70aad9eaf1\",\"/knowledge-medium/pr-preview/pr-1834/src/sw/previewDatabases.js\":\"72d9bc70b517b195\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/byteTransform.js\":\"29aa1a0b823c5da0\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/attachmentCleaner.js\":\"23ffe67803426def\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/attachmentParts.js\":\"c173a0f4d9abaec0\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/bundleParts.js\":\"861eed7e1bb135e6\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/bundleRecord.js\":\"0c8b235b3e6ea621\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/manifest.js\":\"4c475ee1ed87335e\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/takeBundle.js\":\"6dedbee0c0ce23d9\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/bundle/verifyBundle.js\":\"dfaf014ae669a90f\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/cleaningStage.js\":\"8b3426fa7a46dcc3\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/conversionKey.js\":\"214326e34acaff31\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/conversionServer.js\":\"324cfbe05af3c971\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/flip.js\":\"25f6ba29fa5231a6\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/flipAttempts.js\":\"6e5c5996da915d95\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/pages.js\":\"0d7742d761319cf4\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/preflight.js\":\"cf469b2dbdb29b7c\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/reseal.js\":\"adbd89c7334a7135\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/runConversion.js\":\"f8726b00bc54eabf\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/runLock.js\":\"e93e2141b23f3893\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/sealing.js\":\"0869f1c31820b64e\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/sealingStage.js\":\"f22c2f85c18ad224\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/stage.js\":\"fba76846576ca432\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/conversion/verifyReseal.js\":\"713c0940f44ba685\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/aad.js\":\"ba07507ec8671f7c\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/aead.js\":\"e505d8859ea4c9af\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/base32.js\":\"70c0d01de3558565\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/base64url.js\":\"e62fc57cd1d7ae61\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/binaryEnvelope.js\":\"e2dd057de776e481\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/byteAead.js\":\"b9803e7198a83b99\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/canary.js\":\"3ff78301be245d36\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/contentHash.js\":\"fc9d035556056cfa\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/contentKey.js\":\"1937b35538f35cf9\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/derivedIdNamespace.js\":\"a3770223d404eabc\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/envelope.js\":\"03d03db21f15bb47\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/hex.js\":\"247911ada02f35ba\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/sha256Hex.js\":\"04ea5de12bce26cd\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/crypto/workspaceKey.js\":\"4900fb083230fd22\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/conversionState.js\":\"6243865765cc11fb\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3f45276920e07bf8\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/pastedKey.js\":\"08ba0787900181bb\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f6894d84d7abcd49\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/flows/upgradeWorkspacePin.js\":\"14e79e702b4f8d9d\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/keyStore.js\":\"08a60bc36285f02e\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/mintWorkspaceKey.js\":\"d8ee8ceb396d9d6c\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/modePin.js\":\"3f72482332f3df84\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/openWorkspaceKeys.js\":\"f2b01ad95f9b7e0c\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/resolveWorkspaceEntry.js\":\"7ace7067407fa0f6\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/resolver.js\":\"af9a8b6d04bce2b2\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/keys/workspaceAccess.js\":\"fccd35e32df302c0\",\"/knowledge-medium/pr-preview/pr-1834/src/sync/transform.js\":\"9d106ae3ed2bb288\",\"/knowledge-medium/pr-preview/pr-1834/src/themeBootDefaults.js\":\"34dae35692f17a61\",\"/knowledge-medium/pr-preview/pr-1834/src/types.js\":\"4827c35572a1ce94\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/ClientLocalSettings.js\":\"fb4c18c43f991ee3\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/abortableSleep.js\":\"b36b8abb03af1a26\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/array.js\":\"7bf3493da94a313c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/backlinkAutocomplete.js\":\"15f63d81e709a88b\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/blockCrumbs.js\":\"89b24451e47d813e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/blockrefAutocomplete.js\":\"562a4450cab2db99\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/cadencedIdleJob.js\":\"fa1e39aaccbff5fb\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/callbackSet.js\":\"e3eec8a9a76fe309\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/clientId.js\":\"4d2f2c0e2d89ce1e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/codemirror.js\":\"aa231e9e3c551f49\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/codemirrorCompletion.js\":\"cbae3fd58c980e4d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/copy.js\":\"3214591e7324d362\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dailyPage.js\":\"579af2d39eee9128\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dbForensics.js\":\"36627b40bfd41304\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dbForensicsHooks.js\":\"efd0c366d2247d24\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/deleteBlockThroughUi.js\":\"4f7edd62cf6b916c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dialogs.js\":\"f0a4c687fb97c076\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/dom.js\":\"0c05a8d1b9a698cf\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/downloadBlob.js\":\"721d92ca6736af93\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/exportSqliteDb.js\":\"26c58ce197ba9e1a\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/fileSystemAccess.js\":\"3aa90629b3558859\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/flipSlide.js\":\"40a88629ba01ddf9\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/fnv1a.js\":\"db6e2d9331b6c3e3\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/formatBytes.js\":\"5e805960166277a7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/fuzzyRank.js\":\"37a0ea7206e1d923\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/idbKeyedStore.js\":\"272aed2afb9632f7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/idleCallbackPolyfill.js\":\"c4fc0529a9523031\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/keyboardAwareScroll.js\":\"0fc500d0e486ea5c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/keyboardViewport.js\":\"aa914396ce2c4ff7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/lastWorkspace.js\":\"55b15ffbe4e434c8\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/layoutColumns.js\":\"ccc26cc70e56f5d7\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/layoutSessionDom.js\":\"d74f5385397bb163\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/layoutSessionId.js\":\"e0afc89e0ad3d447\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/linkClickGestures.js\":\"a2cac371c18c5360\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/linkTargetAutocomplete.js\":\"6cf015f03ec95bcc\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/localDbCorruption.js\":\"dd6696db5ae9222d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/localDbRecovery.js\":\"d26738b3f7a6ab95\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/markdownParser.js\":\"db6deed67061f762\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/memoize.js\":\"412168f713a5292c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/nameFieldCommit.js\":\"32c96bb7e534dd2c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/nameList.js\":\"dbe0ac82d41e5cb2\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/navigation.js\":\"bcfdb9c07fa69ca3\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/omnilinerNamespace.js\":\"4801f07b9c8b66c8\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/opfsPageScan.js\":\"89c67df290f1a7ac\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelClearance.js\":\"bbfdaf18eef849db\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelHistory.js\":\"b6438b884640ee2d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelLanes.js\":\"a46ab5348377df55\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelLayoutProjection.js\":\"da5c6469851ad597\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelScrollAnchor.js\":\"bd97de717dcd041d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/panelUrlFlags.js\":\"c7691e41b09e0d87\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/platform.js\":\"7f928e43eb9578c1\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/pluralize.js\":\"9658fb9c0b06c776\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/propertyCreation.js\":\"3f637baa62ad4c17\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/propertyNavigation.js\":\"53508bffc2c6f0d2\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/propertyValueContext.js\":\"e14d0189455b184e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/react.js\":\"d9d501c933476916\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/relativeDate.js\":\"bfc45b0201613742\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/relativeTime.js\":\"bc80f2a38bfe9810\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/renderScope.js\":\"9c2655ae7e23dfbd\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/resolvedThenable.js\":\"dfc694e41f1ba8b6\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/routing.js\":\"2e07162b77bc524a\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/safeMode.js\":\"fac0febf0359448d\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/scheduleIdle.js\":\"9b84fe1d901a1f95\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/screenWakeLock.js\":\"899b3b1a0e060209\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/selection.js\":\"2e9ed0274ad7935f\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/softKeyboardGrab.js\":\"4df0011135c58559\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/startupTimeline.js\":\"831c9a01290d6c73\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/state.js\":\"d6621235cd3a7530\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/string.js\":\"4471de07ed2de3d4\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/surfaceZoom.js\":\"e7e9fe51c677a561\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/time.js\":\"8334d18d5c9e5395\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/toast.js\":\"770815f58e5c6b2c\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/toggleStore.js\":\"eb8afe8f2d0d94b2\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/untilStopped.js\":\"098e45cae7068b41\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/userActivity.js\":\"9849ba822945f25e\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/viewTransition.js\":\"679d6c00cb0ac748\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/viewport.js\":\"70c0f47071e7fba9\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/webLock.js\":\"0f392a89ba35c1f6\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/workspaceRecovery.js\":\"d85c3df4b822862f\",\"/knowledge-medium/pr-preview/pr-1834/src/utils/workspaceSnapshotStore.js\":\"9b906f3c83259fcc\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-compiler-runtime.js\":\"53ebfd2b7191c7b1\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-client.js\":\"f617e90a0d373dc5\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-server-edge.js\":\"f68d7b9f081c1ea0\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-server.js\":\"a282b4efc1ce212b\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-static-edge.js\":\"b934c18439e6d99b\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-static.js\":\"f9d4b2571dc1958a\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom-test-utils.js\":\"a9e989032d8d9f79\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-dom.js\":\"de3315e22df07320\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react-jsx-runtime.js\":\"a1908b5dc43c761d\",\"/knowledge-medium/pr-preview/pr-1834/src/vendor/react.js\":\"50f3d91f50488821\",\"/knowledge-medium/pr-preview/pr-1834/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1834/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1834/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
