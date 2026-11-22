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
		buildId: "3b7c97bcbb21-90922dd9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/\":\"9ec860814a9b1004\",\"/knowledge-medium/pr-preview/pr-1835/index.html\":\"9ec860814a9b1004\",\"/knowledge-medium/pr-preview/pr-1835/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1835/assets/FacadeVFS-BoZeKy0e.js\":\"5fccdc39e3e9d0d2\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSCoopSyncVFS-C554CYtm.js\":\"89d0cdd720b1e1c8\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSWriteAheadVFS-D-ARDwTp.js\":\"111b65c452559013\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CfFcOy3a.js\":\"ccb0717c96dc86f3\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-ecAwXFSi.js\":\"36e79fd0a2bc2403\",\"/knowledge-medium/pr-preview/pr-1835/assets/worker-BVuoIuZy.js\":\"442140cd1ac040b4\",\"/knowledge-medium/pr-preview/pr-1835/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1835/chunks/app-81RuqYF5.js\":\"09a8e58d9d018814\",\"/knowledge-medium/pr-preview/pr-1835/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1835/index.js\":\"d65cdb11398f5087\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1835/assets/AccessHandlePoolVFS-BJe-RLwr.js\":\"acbe336f23eaac43\",\"/knowledge-medium/pr-preview/pr-1835/assets/IDBBatchAtomicVFS-DdaWcIgF.js\":\"7d3c7ee66c8bb727\",\"/knowledge-medium/pr-preview/pr-1835/assets/MemoryVFS-CduzpJx0.js\":\"c354dfd2ef37f7b1\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Q_Tx3yzG.js\":\"8a033b0c1634f22b\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-D1J0A38Y.js\":\"0bcebdc41467f094\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1835/chunks/AccessHandlePoolVFS-CnX7WtBw.js\":\"23d3fc9ad8fb74b0\",\"/knowledge-medium/pr-preview/pr-1835/chunks/FacadeVFS-HbAadU2f.js\":\"d12dcd307dede778\",\"/knowledge-medium/pr-preview/pr-1835/chunks/IDBBatchAtomicVFS-CyeIIrvQ.js\":\"f45cbb07d14aa1e7\",\"/knowledge-medium/pr-preview/pr-1835/chunks/MemoryVFS-B2hzwqJy.js\":\"efec28d57402b4bc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSCoopSyncVFS-BFoqMkcF.js\":\"31d7c338664a230e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSWriteAheadVFS-Bv06-WgQ.js\":\"e9bbefda9537755b\",\"/knowledge-medium/pr-preview/pr-1835/chunks/Preview-B46IKwbk.js\":\"c02d7479912027bf\",\"/knowledge-medium/pr-preview/pr-1835/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/card-C0znZ7Qo.js\":\"e3af290fe86f331d\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-Cso8W4nT.js\":\"ae7831eecc74f6dc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-async-B9hR_7Lk.js\":\"bbd850c55cebc0df\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-cAgv7Ezj.js\":\"3a0d779a46aa8844\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CGrnbezg.js\":\"2edffbfdd8083e87\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CKJVYvZ8.js\":\"0664dbc73389d277\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CkLHFYVJ.js\":\"421be9583a377b22\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-Cnj1jwlA.js\":\"1649cb1257127fe3\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CorT89n6.js\":\"fd644f2ef7383f8e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-DpnxCJd8.js\":\"c65234522f9c3622\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-NE0PBBnH.js\":\"617a4f5b396f5806\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server-legacy.browser.production-DQLpoZ-T.js\":\"8f7f2d707578e7e0\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.browser.production-BtYdb5sW.js\":\"3be3b30b62d2cad3\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.edge.production-Se1h23e8.js\":\"91472f6efec2f563\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-jBBRvIOJ.js\":\"e480c8c6b17f6ce0\",\"/knowledge-medium/pr-preview/pr-1835/chunks/server.browser-CCR0_zYj.js\":\"7e3da0ecbe2c4cc5\",\"/knowledge-medium/pr-preview/pr-1835/chunks/textarea-CWIVaO8r.js\":\"d706a693d5cdb5d6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/ui-5IPScajl.js\":\"43696054965a72d5\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite--mV--lEA.js\":\"338ae570feb00b83\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite-async-BSfHuVYl.js\":\"63adf8c77ad564c6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1835/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/src/App.js\":\"cd7e72992ed49cac\",\"/knowledge-medium/pr-preview/pr-1835/src/appUpdate.js\":\"33e8e775a92b1778\",\"/knowledge-medium/pr-preview/pr-1835/src/appVersion.js\":\"4346919c9333af3e\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/initialLayout.js\":\"07cc23ef2f84b9ae\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/openWorkspaceData.js\":\"491303a34787748a\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/resolveWorkspace.js\":\"e2216846ba18ecd9\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/workspaceBootstrap.js\":\"235da23a6a85d563\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockComponent.js\":\"f7c4231d694f789e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockCrumbs.js\":\"8b6547c377a54aa7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockEditor.js\":\"bdc2a9489b0e13e8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockLoadingPlaceholder.js\":\"508ab560e1e46da1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockProperties.js\":\"f72679a6a4289b0c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockSearchPicker.js\":\"ab8f757fedb3cec2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ConfirmBulkDeleteDialog.js\":\"1399d521d0b707a4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DividerHandle.js\":\"15d26360e3537f60\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DraftEditor.js\":\"a04718dd19398c89\",\"/knowledge-medium/pr-preview/pr-1835/src/components/GutterPill.js\":\"a5b16f1de993ef1a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Header.js\":\"0490a9d88fcfee60\",\"/knowledge-medium/pr-preview/pr-1835/src/components/LazyBlockComponent.js\":\"a9eca82c14bf4f5e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Login.js\":\"613c487191329206\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ZoomableSurface.js\":\"e81d1dea68c17d5e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/editModeKeepalive.js\":\"4bbfdad72c6470ca\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyDisplay/PropertyDisplayScope.js\":\"65f6781981d1fdc3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4e6a763a47a561e5\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefPropertyEditor.js\":\"5a15d95eb570566b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefTargetTypePicker.js\":\"567bfd244769d43f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/SelectPropertyEditor.js\":\"4d3efb4ce3f895bd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/TypesPropertyEditor.js\":\"17b90cc4280cc2b8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/defaults.js\":\"afc57c9c9135f6c9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/kernelValuePresets.js\":\"92717add7d825368\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/selectablePresets.js\":\"3fc5e201f6799110\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/typesPropertyUi.js\":\"b26a8ba955905290\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/AddPropertyForm.js\":\"35f2e9fb0da85c6f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyPicker.js\":\"568e5315aaa428d7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyRow.js\":\"c5f2cd6a7006fc8f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/Rows.js\":\"5a32efafd6ec9160\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/actions.js\":\"26d4066256976b1e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/declarationOnly.js\":\"f9d2c31f7a49304b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/layout.js\":\"fe22ffc6dea587b9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/model.js\":\"10359eb87d147eff\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapeUi.js\":\"63ff1cf1e9fae2ec\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapes.js\":\"e65129d4f28853f0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/usePropertyEditingActivation.js\":\"32ef674cf0d96132\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/visibility.js\":\"708ca90c1e8d179f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanelSections.js\":\"a69512b8c7b5cc3e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockEmbed.js\":\"6b03d4a917c06a43\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockLink.js\":\"8db0628bf8c4e6e6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockRef.js\":\"d207924c814a3fdd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/ReferenceLink.js\":\"d31bf71b888ba06b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuard.js\":\"e63ddec7c21c60f0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuardContext.js\":\"8a4e054b6a63fdfd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/linkInteraction.js\":\"36c0b9e9bffb5ec9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/referenceLayout.js\":\"71f83f18b06a4f4b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/useBlockRefAncestors.js\":\"21f732735e24cc18\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockGutter.js\":\"c2d1afc1507e1139\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockInfoDialog.js\":\"0f5596495e7ef4f3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockTypeBlockRenderer.js\":\"9e0a83ae98ff50d1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BulletHoverCard.js\":\"1410e4fb225aea31\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorContentRenderer.js\":\"ce6233e9ae7f4717\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"09d1aabc1a502bbd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ColumnResizeHandles.js\":\"0f0acfd7a472f4e6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"fa3701af8cb43023\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/DefaultBlockRenderer.js\":\"6b9d31288a20b409\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/LayoutRenderer.js\":\"eaeb24aa283ad19a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MarkdownContentRenderer.js\":\"caca3e38d5f843a4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MissingDataRenderer.js\":\"d8b01047e46e505a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PanelRenderer.js\":\"b245d043814feb66\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PropertySchemaBlockRenderer.js\":\"70da1c7e62303e0c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/TopLevelRenderer.js\":\"ab84bfd60a8350a6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockGutterMode.js\":\"61976f3de4ebb907\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockTitleText.js\":\"f0bee1d3f7bbc0ff\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/fieldCreationKeydown.js\":\"dbfb2ea7e4a69795\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/layoutRootContext.js\":\"b6b8d7d4600a3c0c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/TypeChip.js\":\"3b8c40a35b15af55\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/chipStyle.js\":\"b2ee2c725d6391dd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/anchored-floating.js\":\"88ebfd71a572c484\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/button.js\":\"aa6a8abcc542b208\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/card.js\":\"f394db0119448276\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/checkbox.js\":\"4130f0287d9e057c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/collapsible.js\":\"1992295ef30a8e56\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/command.js\":\"7a06242900e31b33\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/context-menu.js\":\"24d676da50508168\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dialog.js\":\"0c32c2cb710103ce\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dropdown-menu.js\":\"4046a4b8f68f30f9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/floating-listbox.js\":\"d186624966a59a22\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/index.js\":\"01ac7e58c61e0cbe\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/input.js\":\"99d03392a123b30f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/kbd.js\":\"d21961735aad15aa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/label.js\":\"1880ecf72e65487a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/textarea.js\":\"547bd02ff57394b0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/useEditModeYieldKeepalive.js\":\"4cd3c9d88d548299\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/BootFallback.js\":\"21605647cd33c697\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/FocusedRowLazyMount.js\":\"1501c30abf178533\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LazyViewportMount.js\":\"886608b3f3c2dad2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LocalDbCorruptionFallback.js\":\"69733f02077100f9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/error.js\":\"16556d0859bde061\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/lazyMountRegistry.js\":\"32b25c20fa851768\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/suspense.js\":\"214b55f6b13b68cb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/CreateWorkspaceDialog.js\":\"919151fe6ff9d3f4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/PendingInvitations.js\":\"7f12cbb19c9b06c9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/SyncProgress.js\":\"0edc405f4c5367d1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/UnlockProgress.js\":\"df375978680e1aa4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceKeyGate.js\":\"af5bd7c7cb85f5dd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSettingsDialog.js\":\"e1a4ba013b52194b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSwitcher.js\":\"8749f90b423ead01\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSyncGate.js\":\"f8cbab732416e29e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlow.js\":\"817350e797bf39a7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlowHost.js\":\"c204401cbb9f53c5\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/EncryptionSection.js\":\"cc5d0f99674cc13b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/attachmentPrompts.js\":\"fd875857e805b564\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9c26e97c0f5eff6a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowDeps.js\":\"109d550b1ea48228\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowStore.js\":\"3c919de20f2f9db0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/flowUi.js\":\"2b92d7c3fdda7651\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/useConversionRun.js\":\"176b12f957f62673\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/keyUi.js\":\"d1015b8b52b33f02\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnKeyLoss.js\":\"d258affb2582dbc9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnServerE2ee.js\":\"f3732d9370472a60\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/workspaceUnlocked.js\":\"7d33cf89142a37d2\",\"/knowledge-medium/pr-preview/pr-1835/src/context/backgroundSubtree.js\":\"3983267290b53e4d\",\"/knowledge-medium/pr-preview/pr-1835/src/context/block.js\":\"04ad646a33f6ee9b\",\"/knowledge-medium/pr-preview/pr-1835/src/context/layoutWsContext.js\":\"d0d92b78b0ea4699\",\"/knowledge-medium/pr-preview/pr-1835/src/context/propertyDisplay.js\":\"4dad213a0ca81175\",\"/knowledge-medium/pr-preview/pr-1835/src/context/repo.js\":\"0f30d760018d92f3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasClaim.js\":\"5d4653126eb966ef\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasSeatNamespace.js\":\"a0df586f959aeffc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockData.js\":\"364533948e56df1e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockType.js\":\"1d6ced544f15c6de\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/changeScope.js\":\"2185decb2a2a9c4e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/codecs.js\":\"cdd73cc68b29c44f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/derivedData.js\":\"3337c69cab25a066\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/errors.js\":\"a07cca205fec788f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/events.js\":\"1358ff61bae24b53\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/handle.js\":\"5bd6268e7eb21e17\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/index.js\":\"cbac1bcb50d66547\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/mutator.js\":\"412f36ab6f7b8504\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/processor.js\":\"698b2113474ed447\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/propertySchema.js\":\"77ba1d9a1ef3ac14\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/query.js\":\"117d106aa1abde29\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/sameTxProcessor.js\":\"ea5a402535f29ef2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/schema.js\":\"5bd6268e7eb21e17\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/tx.js\":\"5bd6268e7eb21e17\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/typedBlockQuery.js\":\"829cca09b0da575e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/user.js\":\"4d97e3da14310b90\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresetCore.js\":\"8272a0362886a20d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresets.js\":\"aaa66b6df3c963e9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/attachmentCleanerIOVerb.js\":\"2cda022a12998202\",\"/knowledge-medium/pr-preview/pr-1835/src/data/block.js\":\"06e1f22a96cf9379\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockCache.js\":\"f7317001f67a1454\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockId.js\":\"a1373804d476ac7e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockLiveness.js\":\"4576ce1f2f7d9603\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockMerge.js\":\"bf88bf8b63e3f16c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockSchema.js\":\"ed122d6f245499ce\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypeLookup.js\":\"0fdb992ad754f75c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypes.js\":\"26588e120e80ef35\",\"/knowledge-medium/pr-preview/pr-1835/src/data/clientContext.js\":\"74d04a0dc2393275\",\"/knowledge-medium/pr-preview/pr-1835/src/data/dbFileSiblings.js\":\"ad541b47250e36be\",\"/knowledge-medium/pr-preview/pr-1835/src/data/definitionSeeds.js\":\"14deb9ed0370df88\",\"/knowledge-medium/pr-preview/pr-1835/src/data/derivedIds.js\":\"a2c88f1a19f65062\",\"/knowledge-medium/pr-preview/pr-1835/src/data/drawnSubtree.js\":\"5f058769cd68f741\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facetBridge.js\":\"fd060dd2718b05bd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facets.js\":\"aae8ce0686383760\",\"/knowledge-medium/pr-preview/pr-1835/src/data/globalState.js\":\"b6e632e7326a0c02\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/aliasClaimRederiveProcessor.js\":\"ac3bff0307d40da9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/ancestorBatch.js\":\"b048147a993a8a23\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/blockTypeTypeifyProcessor.js\":\"6242f2fb14bd6c0a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/clientSchema.js\":\"842610a453612607\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/commitPipeline.js\":\"4d712909a2c826af\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/devAssertions.js\":\"aafa2e5f1bc4572c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/firstSync.js\":\"925ae989cf24f351\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/freshInitialLoad.js\":\"e70c2a9f7fe0c217\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/graphBackfillClaim.js\":\"628f68cb3a1d3ce2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/handleStore.js\":\"0c1db42ef3fea855\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/idleMarkerJobs.js\":\"b591d7f5e29a633c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initialDownload.js\":\"ca191ec42b48888e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initializeClientDatabase.js\":\"8e23108f80c7b76b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/jsonCanonical.js\":\"19c9bb5a7b25c524\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelInvalidation.js\":\"d00f0ec15338fa34\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelProcessors.js\":\"592f2cae6af9fccf\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelQueries.js\":\"fe797043dfed7f53\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/mergeTypeMembershipProcessor.js\":\"63683653922f636c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/normalizeReferencesProcessor.js\":\"5cdab52ad65f25f9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/poolInstrumentation.js\":\"2e999ecfece55b02\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/processorRunner.js\":\"97df3fe728e61379\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyCellBackfill.js\":\"71693ab96e47f727\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildMint.js\":\"1da7974cd7ec1453\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildrenProcessor.js\":\"9fa52f1b1675c7ef\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c4ec89326b598421\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionSynthesis.js\":\"f3730bcaa42f7f1c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyKeyScan.js\":\"08ace1ffee3ef71b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertySchemaResolution.js\":\"80f3e7ac84fbc390\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyValueEdits.js\":\"32aa4adc847e4368\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/raiseProtocol.js\":\"f85f4b132ceb7c8a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/readBatch.js\":\"483932e6d234c3f7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/refProjection.js\":\"019a7fdb1c9d357c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetLookups.js\":\"18c18e94543fe7ca\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetProcessor.js\":\"0cd20d60d1284931\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/replayMerge.js\":\"89bbd6f8c2dd57f5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/sqlBinds.js\":\"796a4775391e2c7f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7f4796296527bba6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/arrivalProcessors.js\":\"9ab8be1e5752321c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/invalidate.js\":\"fb1bf256a5e9ebf8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/materialize.js\":\"bb4ef5df7e45b88a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/observer.js\":\"db573841d66dddd2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/reconcile.js\":\"dbe58a30adae8e8c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/timingMetrics.js\":\"49237fcad6df4184\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/treeQueries.js\":\"6e8781a4aabe136d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txEngine.js\":\"570f9fb07afe0b2f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txSnapshots.js\":\"e45c21a55f4d6999\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/typedBlockQuery.js\":\"8b131ef7261ccd82\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/undoManager.js\":\"d265532aa969f900\",\"/knowledge-medium/pr-preview/pr-1835/src/data/invalidation.js\":\"3aa827fe59c17ab6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelDataExtension.js\":\"ece1ee09383393a7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelPage.js\":\"68b7e419b6301eb3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelValuePresetCores.js\":\"00d9a0f0495e4694\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbCorruptionSignal.js\":\"3e9f1616da3684b1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbStorage.js\":\"e04d10d3471d5f54\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbVfs.js\":\"6528e6ed440331ba\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localSchema.js\":\"9f2fb62605428c0e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/maintenance.js\":\"97d673c9af0bc119\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mergeProperties.js\":\"c733cd3076a05313\",\"/knowledge-medium/pr-preview/pr-1835/src/data/metricsConsoleHook.js\":\"406fdb91e449e452\",\"/knowledge-medium/pr-preview/pr-1835/src/data/migrationsPage.js\":\"008fd666f1340952\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mutators.js\":\"3c4c95a50f5820bc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKey.js\":\"0e0733962a86cf2b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKeyPlacement.js\":\"e1faf9e7b03f3ce9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/outlineSurface.js\":\"96fe1489ce6e31ca\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingEditorContent.js\":\"20fb2e9ad3e4d569\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingUploadsSql.js\":\"c65f3db49609f667\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pluginStateExtensions.js\":\"638e0d5ca4267e16\",\"/knowledge-medium/pr-preview/pr-1835/src/data/powerSyncLogger.js\":\"d1c1b8ec845c9eb1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/projectorRuntime.js\":\"33c53959c580c0dc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/properties.js\":\"e2bc493036ca4de0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertiesPage.js\":\"a68be103aa22d46d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyChildren.js\":\"7c79ab674a2840f9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionFanout.js\":\"75b032c216df8e9a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionMetadata.js\":\"9fb8ca3512d807d2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionRegistry.js\":\"4e40c814025d0f3b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDisplayMode.js\":\"408a06fcd9631dad\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyRowCreation.js\":\"78ef69c0d6eb44d1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySchemaCreation.js\":\"92a7e5bc6284d1bb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySeeds.js\":\"2648f814385215b8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/recentsPage.js\":\"efd7e90bd8e9f542\",\"/knowledge-medium/pr-preview/pr-1835/src/data/referenceBlock.js\":\"cf61171f86480f0b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rejectedUploads.js\":\"bba726a8147efb76\",\"/knowledge-medium/pr-preview/pr-1835/src/data/releasePowerSyncConnection.js\":\"246759af093c477b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repo.js\":\"30be81e69d8d4276\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repoProvider.js\":\"7ca6a897546a0104\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rowProperty.js\":\"d01bbc76c557d88f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/searchFilter.js\":\"c6c1b05d7e1e9101\",\"/knowledge-medium/pr-preview/pr-1835/src/data/seedIdentityLedger.js\":\"0c72751519f0abcc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/stateBlocks.js\":\"721bfbc072e3ff97\",\"/knowledge-medium/pr-preview/pr-1835/src/data/structuralEditPolicy.js\":\"bedc81d758c29474\",\"/knowledge-medium/pr-preview/pr-1835/src/data/subtreeDelete.js\":\"ea1b21f91c960238\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncStreamLock.js\":\"e5c98d13e79c02c7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableSqlRecognizer.js\":\"7bbcd637c383ce3c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableWriteGuard.js\":\"dac014d742cfec10\",\"/knowledge-medium/pr-preview/pr-1835/src/data/targets.js\":\"752a70575d7e7d8d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeColors.js\":\"e5d26587648cb7f4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionMetadata.js\":\"86993c33123b2cc8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionRegistry.js\":\"0b5d9a3a91dd9f37\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeExtraction.js\":\"895b956b938a58fc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeInitialValues.js\":\"f68bea3f60182a4d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typePropertyGroups.js\":\"51cf35e201637e00\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeSeeds.js\":\"148b7331534260e5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeTagger.js\":\"21954159553ce5b4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typedRecords.js\":\"8c79346afbba35c7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typesPage.js\":\"efb7841be2f91325\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userPrefs.js\":\"6049681fd6ccf402\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userSchemasService.js\":\"9d918540c445f558\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userTypesService.js\":\"69c6d01f3c527f71\",\"/knowledge-medium/pr-preview/pr-1835/src/data/valuePresetRegistry.js\":\"7764fa73dafec9b3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/visibleChildren.js\":\"2f1c7ede2033f089\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceConversion.js\":\"8a7d7e96f9c972ee\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceFirstSync.js\":\"1488cf3b69390611\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceIdNamespace.js\":\"ebc737563c542f17\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceSchema.js\":\"efbff9b8e0edf781\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaces.js\":\"c3e0996e8434b838\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadLog.js\":\"cdc1caf1dfc6f1b2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/BlockPasteShellDecorator.js\":\"b3760d4e2695a712\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/atTrigger.js\":\"648f1d0cb3ed9882\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/autocomplete.js\":\"e105bb6c355a904e\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/codeMirrorExtensions.js\":\"e4e8f762862f9d79\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/contentFlush.js\":\"5c41445f31bc46fa\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/defaultInteractions.js\":\"027fed816fc93535\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/editSettleSignal.js\":\"932d1c01a17e0122\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/insertImage.js\":\"17bbaaee5dda7822\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceCompletionRange.js\":\"72e8c78af72941ee\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceTargetTypes.js\":\"f182421efc31b001\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/syntaxContext.js\":\"7391f671b52f3654\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/triggerMatch.js\":\"6ff5d5956d21a8d6\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/AppRuntimeProvider.js\":\"0fadd44149a3ad02\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/BlockFocusShellDecorator.js\":\"4801e9796648b55f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/ExtensionRenderBoundary.js\":\"dd1177ce4dbc38aa\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/PanelContentRecovery.js\":\"6c4669be96d90f2a\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/apiCatalog.js\":\"7f84c1093b62d287\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/approveExtensionHere.js\":\"a9c16ee1f5ea19d4\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/armedCutAppMount.js\":\"6378b1f82eb6179c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/batchableKeyedStore.js\":\"04b8669fa286c8e4\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockInteraction.js\":\"114294eb8ce88c3f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockSelectionAction.js\":\"f0c6a4db401aa942\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compileExtensionModule.js\":\"55eb68ab0847803f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compiledModuleCache.js\":\"7fee73c95527a4ee\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/continuousGestures.js\":\"ef5c1c0756e34785\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/core.js\":\"139ad3c3c988beb7\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/defaultRenderers.js\":\"6f801270b4719d69\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/definitionFanoutAppMount.js\":\"4ca3ce287c288377\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dialogAppMount.js\":\"47dcf0a3efd0c8a3\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensionSeeds.js\":\"a7a7cc149da95039\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensions.js\":\"abb93c65751a8b53\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/exampleExtensions.js\":\"dac30b8ef16fdcca\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionApprovalStatus.js\":\"98b027cea1b8ca2d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrorToast.js\":\"5849908f0fca34d6\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrors.js\":\"b064ca85f7c2b0f0\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLookup.js\":\"a19230d43cea71f9\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionToggles.js\":\"eac94d9ec4bd6026\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionUtilitiesCss.js\":\"627fd9b56758a42b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/kernelPageDeletionGuard.js\":\"ebeecd2cc0a6cedb\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/liveRuntime.js\":\"84d27de0d5b42d49\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/openExtensionsSettings.js\":\"e57e8df66722bbf8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/overridesCache.js\":\"bea55fd60a32a9a9\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/pluginIds.js\":\"7a5e331c77c0a9d2\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/processorRejectionToast.js\":\"8f14cdaef266a9ba\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeActions.js\":\"9f898ed29f561443\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeContext.js\":\"bcbba551157dc9a9\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticAppExtensions.js\":\"ce88ef30c871571a\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticDataExtensions.js\":\"bed2b8e1fb564da5\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/toastAppMount.js\":\"e2118648ea876029\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useOverrides.js\":\"2933b733139a5e1e\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useShortcutSurfaceActivations.js\":\"f63859b20a206d9a\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/discoverToggleTree.js\":\"bffd12a085c1f781\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/facet.js\":\"3b366231f5694904\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/resolveAppRuntime.js\":\"8569a8a1cb35ba8a\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/runtimeEvents.js\":\"b3e1a2405665b8c0\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/togglable.js\":\"1a5ff697a2170a0d\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/variantFacet.js\":\"225db6c3f8e0ebb0\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/verbFacet.js\":\"0da1e64caa696c73\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/block.js\":\"7c8bb9032c03a4be\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/focusedChild.js\":\"f1116017f4c95918\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/propertySchemas.js\":\"2b2c4b4a89b0ed37\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/typeRegistry.js\":\"417b1535dc34866e\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAncestorCrumbs.js\":\"a948e810583a132d\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAutocompleteListbox.js\":\"19937bebc7b5ff7c\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedSearch.js\":\"f4d20602d6602864\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedValue.js\":\"bb6920531ffb4bb8\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsFocalRender.js\":\"b55e2034bde5f93b\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsReadOnly.js\":\"4cd073c58245410f\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMaterializeBacklog.js\":\"d3fac894a6f1ea3e\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMinuteClock.js\":\"f1a745ed4419c5a1\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePanelLayoutProjection.js\":\"f12f0943459e61b0\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePendingInvitations.js\":\"537dee52000db5d9\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRendererRegistry.js\":\"80c239fd2ed52e11\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRetainedFieldRows.js\":\"2d503a608a798399\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useWorkspaces.js\":\"474bfa5fdffbfaae\",\"/knowledge-medium/pr-preview/pr-1835/src/lib/utils.js\":\"e6d01a2e7afca2b9\",\"/knowledge-medium/pr-preview/pr-1835/src/main.js\":\"badf5ee23e31c36c\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/MarkdownImage.js\":\"c95a576884d35e0f\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/blockSeparators.js\":\"1b80d4a39ac017e7\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/context.js\":\"e107841d9363124d\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/defaultMarkdownExtension.js\":\"e699bb932b63d709\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/extensions.js\":\"9528eb6a8333d725\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/renderMarkdownHtml.js\":\"bb0b4e3c42043152\",\"/knowledge-medium/pr-preview/pr-1835/src/minimal-editor.js\":\"4ab3d7e3642d0288\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/armedCut.js\":\"09b5eb035ecb2e2d\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/captureMediaVerb.js\":\"43e6ccaeed06171c\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/clipboard.js\":\"073d50e4b58f3e30\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/decision.js\":\"373a6ecf8bf9dcab\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/operations.js\":\"9d3abb6adc8f049a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/AccountHeaderItem.js\":\"f29370eee8385b0e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/index.js\":\"37b5dbf21e951f8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c16fcdd6c5f3f36e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askAgent.js\":\"1ce68a6461303a95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askedStore.js\":\"b0b213f1e6c00dd1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9e788858884ff6c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/chipState.js\":\"0a1327143c8840cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/dataExtension.js\":\"30e65b47ce5eca92\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/index.js\":\"cf9b57695af42e82\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a77bd8490edb156b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/schema.js\":\"63522cba397abe98\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0376767698ceaf43\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6ec88bd0dbb7618e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/addMedia.js\":\"420dd6c95a3ee244\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9a74e8a2f7397a36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/block.js\":\"a503b28580efff4c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/context.js\":\"3f6f7324408b1258\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f83efb46d684aef5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/index.js\":\"b1907b2c29cd24c6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/outline.js\":\"6288fe7acca76c09\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/properties.js\":\"8345857faaec1d67\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/refs.js\":\"7c6e264906a1ba83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"65807001554b94ad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/search.js\":\"23513ba739225ccf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/shared.js\":\"b7e282cabe598540\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f0a01612aca882eb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/text.js\":\"b90ed0a58de53559\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentWrites.js\":\"29c69d1f947989d6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/authoringCatalog.js\":\"399da68b8785a126\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/blockRefTargets.js\":\"c174420fcaef7957\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridge.js\":\"eb8f63806d7be575\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridgeLoop.js\":\"7954dc415b168085\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/changeHistory.js\":\"872067c7ef1eb515\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commands.js\":\"1df0b97b76cc4512\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commentsCommands.js\":\"e3b112a92a4f08f5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataExtension.js\":\"71e64b4baf0061d8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataModelGuide.js\":\"eb0b7a127ebe2731\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/describeRuntime.js\":\"8490c3c49ce570bd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/extensionLint.js\":\"160b4bfa34f1de7f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/grainAudit.js\":\"3812b1cc6fdc8e18\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/healthCommand.js\":\"cf8c872fe5c0cd49\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/index.js\":\"5c9a805efa73ff62\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/presetIdentity.js\":\"54b7881146b7e3b7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"74a3935b271b5e7f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/readMedia.js\":\"fe71936a44ac0ef6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/schema.js\":\"fd469bf0becb0be1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/serialization.js\":\"7aa7be071c219c0b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/targets.js\":\"dd5473305f527c2a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/tokens.js\":\"ba8913ab74ec1358\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/watchEvents.js\":\"6ea832424e485ec4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/workspaceGuard.js\":\"9b760767323acc92\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/writeCommands.js\":\"c5ed70b29546b682\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/AliasCollisionToast.js\":\"e7d67924ab88a9ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/DuplicateNameBanner.js\":\"4c41634af3eb38a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/collisionMerge.js\":\"5141318be6705378\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/dataExtension.js\":\"043ba7adddb3b7bc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/index.js\":\"a25790ef5a917eb5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/mergeCollisionAction.js\":\"c430f02268de4e2f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/pageStyling.js\":\"997d515e92311e09\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/rejectionToast.js\":\"29c56a004f41458c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/syncProcessor.js\":\"d5269d9840be20de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/actions.js\":\"4437f39c0b7acd2e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/addComment.js\":\"2d492372ab4d43f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchor.js\":\"d2c246fd06530982\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchorState.js\":\"603e42d57d97107e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/commentLinks.js\":\"c5026d0e29a145b8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/confirmThreadDeletion.js\":\"985b07dc6055ff0e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/container.js\":\"11fe6163a4f6e8ef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/dataExtension.js\":\"7efbda2f4c75d07f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/deleteComment.js\":\"d25d19887a353edc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/highlights.js\":\"6110824a4e441671\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/index.js\":\"e87f56a020df0224\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/linkedCommentsPill.js\":\"80572c4a486a1cc8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/margin.js\":\"26062005372f8661\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/marginSchema.js\":\"f4c01579b46033aa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/newComment.js\":\"e044b2c447b2eea8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ownThreadPicker.js\":\"056c61ab60621b14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/placement.js\":\"84964a3f500245bc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/queries.js\":\"682f0deee8c739b6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotePosition.js\":\"958a3cfe8b407bf3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedIn.js\":\"14b0cd1782c35d26\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedRange.js\":\"d05fa9f23cc7167b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/rangeRefs.js\":\"b4b7e6a447234283\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readHighlights.js\":\"c0ba2bfe5b3e2bb4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelection.js\":\"623b4666306c65f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelectionUi.js\":\"f9a786238782f2ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/reanchor.js\":\"d6f0a5ca4e617005\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/schema.js\":\"3a63b3fa021368ce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scope.js\":\"ede3cb2eb6929519\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scopeThreads.js\":\"2ad3abc31d5fb6ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/splitRetarget.js\":\"b921997f4cd99168\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestionCard.js\":\"ebc04a1d4ac023aa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestions.js\":\"800837e1800fbb79\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaries.js\":\"90ee40346db22c58\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaryBatch.js\":\"15cbddf3676668f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/surface.js\":\"003777f90f133d93\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threadNavigation.js\":\"ea3d395cc7645803\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threads.js\":\"3d0094af138b8b71\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ui.js\":\"a07009d89d354ea2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/uiStore.js\":\"367223635dae0cec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/appIntents.js\":\"f82416306ed99055\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/index.js\":\"473a294e452928b6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/index.js\":\"1d707c4aac25972e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/status.js\":\"ad31bf3f9ecc76b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3e27ca90feb0cf56\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaBlockRenderer.js\":\"14d86f71468ddbe1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0d6785a2d4fd170b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaUploadReconciler.js\":\"6db8719649c17605\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetDownLane.js\":\"28acbad87101c520\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetResolver.js\":\"68acd0ab6dc574cd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetUpload.js\":\"c8930dc258f90182\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/attachmentCleanerIO.js\":\"29909958eecaed61\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f1b34ef16739243d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/blobStore.js\":\"98efcc16476b0c45\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/byteStore.js\":\"9615e8277b816e3b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanerIO.js\":\"bb8d4d45e441aed3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanupAttachments.js\":\"0b9d993e0596e72e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/dataExtension.js\":\"61d6995e4ba5f0ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/downLane.js\":\"399cff356bcb462d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/index.js\":\"5a5cd7a973e25c82\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/insertImageContribution.js\":\"74e219c1c32792c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneArming.js\":\"c79b73ab52b658b0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneLock.js\":\"2395ecad4c4108d0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaBlock.js\":\"2c59179746cafe7f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaCapture.js\":\"c4c513af9d920c37\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewers.js\":\"5b12130a989427f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewersFacet.js\":\"fa950657fba54bd5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/pasteCapture.js\":\"a5b96b3ad1759338\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/resolver.js\":\"d87cab955135dc7e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/retryUploadsAction.js\":\"3c7d9b10f4c192a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/storagePaths.js\":\"01157d565f9d35f9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadDrain.js\":\"01ae9568de76d455\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadLaneStatus.js\":\"c7ebea17f723088a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadReconcile.js\":\"bad0814bd1438775\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadRecovery.js\":\"b82f3814642ea0e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadStore.js\":\"9e302cc6edfac991\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/useAssetObjectUrl.js\":\"a1a79473694cd4cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5058938713dc74e0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksViewSection.js\":\"83fc5eb4da386bc3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/facet.js\":\"437125a96957eae0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/index.js\":\"7adf42feb890218c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/prop.js\":\"ea732c6628394f0d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinkFilters.js\":\"fc6f12cf1cac2b45\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"526157cdfbee09eb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BlockEntry.js\":\"b2eb93e37b4fef3f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/LinkedReferences.js\":\"be61d7d979e84154\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"df628b84273487cc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dailyNoteDefaults.js\":\"9def45236dc71969\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dataExtension.js\":\"296f1a4efffdcebe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/edgeExclusions.js\":\"e256cc37d95f1f53\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/filterProperty.js\":\"1e9c2078a9dc335a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/index.js\":\"4722166cef0d726e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d634d97400ade896\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/applies.js\":\"34141bc107561c8c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/countQuery.js\":\"73373588f160aa20\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/expansionStore.js\":\"94570e1859d5a182\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/index.js\":\"c199c82c3c176f32\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a80af28a0e4ec57f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/presentationInvalidation.js\":\"ec43f6d1f5cface3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyEditorOverride.js\":\"f1bec350fafe4b31\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyFilter.js\":\"1072df5acd699b77\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/query.js\":\"5f861106b7c10239\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/resolveFilter.js\":\"86a823db7dcd14ea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sourceBatch.js\":\"fb7ca8771df52fda\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sources.js\":\"9dfed5e20bde8a63\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useBacklinks.js\":\"cfd9b9ce324f8360\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5c5d27e2fdcb3bd3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayCelebration.js\":\"d177ee3d0e8cbadc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayOverlay.js\":\"bd8c0b8b9341efd3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/gate.js\":\"f9aa3cfd5bfe9323\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/index.js\":\"c4180d1a2c095c1e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/wolfTheme.js\":\"d25ce81f6be7d957\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/BlockDragLayer.js\":\"ca25fc876c426a8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dragController.js\":\"02b2db458f8489ba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dropTarget.js\":\"93c854b3bfe397a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/index.js\":\"4cb41c0addcb711b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/projection.js\":\"c24201f543b92fd6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/BlockMetaCard.js\":\"8f930085bf0f2e8a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/index.js\":\"c0339d60f997feb6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/AddTagDialog.js\":\"c91e16deb003d20a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ce04db01a4ec783f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/TagNameIssueHint.js\":\"528f71b02ba22c5e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/addTagAction.js\":\"166a7bc9c19d4d5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/appendTag.js\":\"301b186130dcf2d1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/config.js\":\"faf70d52be05e190\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/dataExtension.js\":\"4e1e96f77c2080f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/index.js\":\"a9ce12fea8d47a3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/propertyEditorOverride.js\":\"c56409380803338f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbList.js\":\"25f21c80c0b11137\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9755bb85e0085937\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/Breadcrumbs.js\":\"26c7c7aae9c3fb61\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"50c3cf4693e87f02\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"885d01172e3f6945\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/index.js\":\"e8d27a6b82dcc3e8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ed73ce549c0b70be\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/CharacterCountItem.js\":\"346da54d02c0c308\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3f19efed41856f60\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/actions.js\":\"ce456017dbe62724\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/blockType.js\":\"c03d714025bf94c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/charCount.js\":\"961e9aa4a98becff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/dataExtension.js\":\"3be39177c0c660c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/index.js\":\"17c847c902cf0ff4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/profiles.js\":\"baff1f017207a4c4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/properties.js\":\"ec24dd28befb400e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/textCounts.js\":\"5e1a628a9d7c58cc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/colemak-keybindings/index.js\":\"fa036cdecd2777c4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/CommandPalette.js\":\"99355964bf64649e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/HeaderItem.js\":\"8ff4f4aae9ea72ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/context.js\":\"81ab3068363a3ca6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/index.js\":\"8066dc809a6c8d06\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/selection.js\":\"5feeb3417806ad27\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/toggleStore.js\":\"9098cd4f9e665087\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/useCommandPaletteActions.js\":\"66753b6eae8a54da\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/ContributorBadges.js\":\"284f929c8c1505d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/author.js\":\"36d1c717271d4e78\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/codeMirrorExtensions.js\":\"ca6fb55f2e1bddf0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/dataExtension.js\":\"f3fce5ccda7113c3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/index.js\":\"b4b7f76519ea8f69\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/mentionAutocomplete.js\":\"65d8395de6df8c2c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/processor.js\":\"37352f44416cecc8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/profiles.js\":\"336881e9cf0efda9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/queries.js\":\"2799bf24730bee47\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/schema.js\":\"6bedd132906025ea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"60bb75f16f740fd5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/followOrigin.js\":\"25ba16f7fd15007c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/index.js\":\"6b2e821b6399e7ac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a23ddeb0de8c7c97\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6cfc177c1f7a11fb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/CalendarGrid.js\":\"11cb54c1c644cb31\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DailyNotePicker.js\":\"d24684330b1ed426\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9c93773e2f7a4aa7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateNavDecorator.js\":\"dbcf078c82975974\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateScrubOverlay.js\":\"c19ce6371f0619bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/HeaderItem.js\":\"1ae021ef4fdca3eb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/ReschedulePicker.js\":\"f7a81d1b7b955705\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d7e50cbffb521465\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/actions.js\":\"d00946d58f103421\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/blockDateAdapter.js\":\"b7e0cc4aa76775d4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/calendar.js\":\"61111f4b676a1563\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dailyNotes.js\":\"d6d78e3894ee2c95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dataExtension.js\":\"1cf43e531f667606\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubActions.js\":\"e82b50856a16b99f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGesture.js\":\"b49ee4f0f071b8eb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGestureActions.js\":\"763e25e1e01c54a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubRecognizer.js\":\"56b4f5cbc0f8bfc6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/deletionGuard.js\":\"e66ed649bcf80020\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dueQuery.js\":\"b09c44cec3d7c909\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/index.js\":\"6bc08491482882ad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/landing.js\":\"953231aca2a4dcad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/localSchema.js\":\"9ade72f96f018671\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/referenceDateAdapter.js\":\"18169a13ba2e60aa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/rescheduleAction.js\":\"e755d3de3b42e327\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/schema.js\":\"1e03d5f684420e13\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadBlockDates.js\":\"a5f54b48380fa235\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadDatesAction.js\":\"93f70431ed7209f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/today.js\":\"87128b57fd9125a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f73129cebb1a08e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c987fb01b08fa90c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/audit.js\":\"e0f0797521ae1ae1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditAction.js\":\"b8b2f70a0cc1e6f6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditRanges.js\":\"476a2e7e9032d9ce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/diagnosticsSource.js\":\"8b3401f717f4a2be\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/divergenceScan.js\":\"16a5ad01e4dce2d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/index.js\":\"2029710e008745e8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e11000b8e4c9f1eb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/referencesMirror.js\":\"330a06b3565cf63a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/rowJson.js\":\"d166f2b352c50cc5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/schedule.js\":\"5a96f8031a99fafd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/store.js\":\"774adb770cd18ae7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/action.js\":\"2a02517ed9bef297\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/index.js\":\"124a1e505c9a841b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/plugin.js\":\"8dc2a2375b47e29d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"513c61c1ea7aa9ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/actions.js\":\"aac48f5106696e2f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/changeMarker.js\":\"14ff843064776485\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/diagnostics.js\":\"099e4224d73eb1d8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/fileSystemAccess.js\":\"6ac3cbde3d7816e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/filenames.js\":\"f8f222fa330831b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/index.js\":\"06ab3e857160b165\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/mirror.js\":\"dc3fd92ccaebebe0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runLock.js\":\"4d381d5e75e29f1d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runtimeHealth.js\":\"bdf730815c6724de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/schedule.js\":\"e2e1f35dedd18f7e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/store.js\":\"7a1071d3f5425b65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/index.js\":\"932dd419b0ac2ac9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/themes.js\":\"79edc30a4fc8eff4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/facet.js\":\"5ba6842c96c54460\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/useDiagnostics.js\":\"83b8bcf2de742b77\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/dismissals.js\":\"d83a66cf0a7498fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/index.js\":\"adc7a3c150e4f29b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/status.js\":\"85f2ac4b4467abb8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/store.js\":\"9842268e1b63a082\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d2b47a3b22e37026\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a8c93cde0fcf93ce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/actions.js\":\"12881f7c44fd3d5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/config.js\":\"51c707cf629a81c3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/dataExtension.js\":\"1b3b0e106eb8aacd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/effect.js\":\"7f8bdf26e0272ac4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/index.js\":\"5353931c5f384fe7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3dc671b1bf8159d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/useToggleTree.js\":\"814a11c6e0a67151\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/ExtractTypeDialog.js\":\"ad91193a52e7ed68\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"78b3e5b87beb4076\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/PropertyShapePicker.js\":\"aa84b14484316a26\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/action.js\":\"855de1a3669807dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/index.js\":\"a94d8dc255680062\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/FindReplaceDialog.js\":\"015e972cc05ca953\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/HeaderItem.js\":\"2f7a3b314d95eed0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/dataExtension.js\":\"cd87fd03d0c76316\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/index.js\":\"050e8171f0bd8bb9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/search.js\":\"7a777383d6ed9eca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/toggleStore.js\":\"90c6fa14c8c164cc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/LocationPropertyEditor.js\":\"6844fbf78c05f3af\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/MapView.js\":\"5a0bcf45fb384958\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/blockTypes.js\":\"a4c6d28b94949825\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/codeMirrorExtensions.js\":\"e4546255b4a6496b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/createOrFindPlace.js\":\"9c510f3309cfeb56\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/currentLocation.js\":\"38b4e5374d78cfff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/dataExtension.js\":\"cc05dba24c75f21a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/geoContentDecorator.js\":\"c543e5fd5cf28493\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/googlePlacesClient.js\":\"00d89ecc9e166896\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/index.js\":\"aa5e53a56e99dcc7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/locationsPage.js\":\"a6f80e3ada9973dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/mapViewport.js\":\"9a48729589132621\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/pickCurrentLocation.js\":\"adffb9aa9b4798e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeAutocomplete.js\":\"194abdae0d363fb6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeNameCollision.js\":\"708c49c89b9d10eb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/properties.js\":\"3fa00735c6c1636b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/propertyEditorOverrides.js\":\"ec6cc84dc20fd59a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/query.js\":\"19cf43fa59de9e41\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/usePlaceSearch.js\":\"3abb43ab7ff7f64c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"bf31cb9af34fa6ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e14ce691ba2e640b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"878567c8141e6fd9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/config.js\":\"27e06e7cb5f4cbe3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/dataExtension.js\":\"de9ae9c6c893aefc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/facet.js\":\"b272b6a357319b21\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/grouping.js\":\"c1827348a723d265\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/index.js\":\"ad3c852ce31e6cf8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e163beae9e5ce0ee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/query.js\":\"c8898be3e2025119\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/resolveConfig.js\":\"4368f5457c4dd03e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3d0ddb6014f11b43\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b41bedd90309d48e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlDocumentContent.js\":\"e04c984e7fa4b83d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlFrame.js\":\"6303a00fa6783e54\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/actions.js\":\"ec16df605ed33353\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/blockType.js\":\"786d42a2b8717f8e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/confirmRunScripts.js\":\"d1ffa8e46fdf46fe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/dataExtension.js\":\"440cfd82e3d60735\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameAnnotations.js\":\"08b336cd63afeb67\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameDocument.js\":\"e30730b4c5ec6056\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameTheme.js\":\"e458c9dcd99c21e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/index.js\":\"d3d59ce80ed6ef6f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/scriptConsent.js\":\"9835e40e5fbf3a28\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/sourceMap.js\":\"d380f0615bfb1a8c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/useDocumentScripts.js\":\"c3592370a3b6db15\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/index.js\":\"ecd23c26acf74c8f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/record.js\":\"21200ca283dddbd0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/recordStore.js\":\"d3ea1d3c12a5e6f2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/responsiveness.js\":\"04a5d995996de981\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/schedule.js\":\"9ba07b89b309eb3d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/sessionContext.js\":\"aad6c80ae25654f6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6033a4080b2b801d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"71d86e79a2a9ecf8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/actions.js\":\"38efa57df29e581d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/config.js\":\"2bb81a308b2babca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/dataExtension.js\":\"567deef819361a7a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/effect.js\":\"ae0e6188a44bffc9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/index.js\":\"78dcb4970dbc3147\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/keyCapture.js\":\"5c04f6db4c3f1ef0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/overrideStore.js\":\"4f4cc5b5aa3cd27f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ae7aeda822c1c43a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/HeaderItem.js\":\"fad424332e0270ef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/LeftSidebar.js\":\"5caf1058cda2787c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/actions.js\":\"663f9e340a0f3408\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/facet.js\":\"1a2bb7fc38df551c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/index.js\":\"0ca24df1f4e562db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/shortcuts.js\":\"2056548b9d100a0c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/toggleStore.js\":\"561ef5c5b3d1e077\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/MergePicker.js\":\"d8a0f102c4c48a86\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/index.js\":\"ecf6823f0c78365d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/mergeAction.js\":\"eba5c4fe6c6213ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/strategy.js\":\"f9c45f8cdccac1c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/Button.js\":\"6bd84a9fb555fad0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b31f13588e39fc36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5bbb7e55d60e635a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/facet.js\":\"1769379df0965d45\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/index.js\":\"9122cde36e45f4e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"47e5804021c16f5c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/actions.js\":\"46d317de8a035275\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"800d3d192274769b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c4d9c24fab9c120d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/index.js\":\"b65ee59a5f6199fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e458e81c42112658\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/blockSubtreeMembership.js\":\"78571990d7751b2d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/contextMenuItem.js\":\"7089ea0e09dd056c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/index.js\":\"4cdfd5d94c1ade64\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveAction.js\":\"f523647c763f40b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveBlocks.js\":\"1eea0da8401ff23a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/selectionAfterMove.js\":\"67912eb1825cf8ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/TutorialBanner.js\":\"378c80e5692243b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/action.js\":\"985b6e5e0812eaf5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/bannerDismissal.js\":\"93c3cbf39536b5a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/documents/cheatSheet.js\":\"5eb278a73676809b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/index.js\":\"c01a85fb552ebc81\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/keys.js\":\"a45129be4fb4a2f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/landing.js\":\"8b4eb3a4f2048a9a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/outline.js\":\"ddda652f016dd9cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/seed.js\":\"34fd35bab8cff44c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/PerfTrendDialog.js\":\"41ea8609651a03d6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/analyze.js\":\"87a13d3c81bd0685\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/diagnosticsSource.js\":\"5487504bf2767c24\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/index.js\":\"8f6bf0db17a07e4d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/load.js\":\"08ac435fc7effb5c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/monitorRun.js\":\"8886291086798853\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/schedule.js\":\"f52c2f4503445bac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/series.js\":\"878148835edfe3ef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/store.js\":\"2b7461542229891d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/trendAction.js\":\"2e18d76c0926d05d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/verdict.js\":\"0a2c9beea8777c48\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/clickToEditAction.js\":\"835afc14727a2bcf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/index.js\":\"e459c198193e50cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/interactions.js\":\"0d8a1625ec40384b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ace0306c9325486b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGate.js\":\"ca5c52bcff4264d0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGateDialog.js\":\"b8e5763b9e283812\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/action.js\":\"c4e016871740bca0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/index.js\":\"89393ad263a640b7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/localRunMessage.js\":\"36555f4cc0a162a2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/plugin.js\":\"8fd776c1f43c279c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/progressReport.js\":\"cc83f2c9c48ca295\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/sweepProgress.js\":\"7119813f1c0fbff6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/FieldRowRenderer.js\":\"5bdbb1382b73047a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/ValueRowRenderer.js\":\"b83a04acaa6c7d2d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/actions.js\":\"14e27e52dcd0346f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/autocomplete.js\":\"88572b2a27035468\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/fieldRow.js\":\"0e5be5ea9f721676\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/index.js\":\"1a389cf997ca95bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/referenceWarning.js\":\"cb488fc84b225f34\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueAutocomplete.js\":\"ff743b6a7cc858bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueSchema.js\":\"8ef7883c53c6121b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/HeaderItem.js\":\"ca15d7bdae2396b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/QuickFind.js\":\"64633c6fcfba28a5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/index.js\":\"21c4fc09fb8d9790\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/recents.js\":\"70940c73713cde04\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/resultItems.js\":\"895ebacf079225e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/selection.js\":\"d97b4f9ece9a2d26\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/toggleStore.js\":\"9310ddd966eec58c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/HeaderItem.js\":\"7e70d94a72547b3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/RecentsPageBlockRenderer.js\":\"42aacd8e55628b6c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/grouping.js\":\"5be3683e12856772\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/index.js\":\"a4506a3a528c1ddd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/target.js\":\"587b271011eb8500\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/codeMirrorExtensions.js\":\"13d695cb18a04d96\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/contentPrefill.js\":\"655cc30db761f9b8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/dataExtension.js\":\"81a0de86143b7cd6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/index.js\":\"151e5017edc9868b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cd73b9a44d8401db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/invalidation.js\":\"b4989101cbdb1413\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/localSchema.js\":\"6ffea70edeebb8c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/index.js\":\"4ec4acc7ed4f7e78\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e0154e649cb2db45\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/index.js\":\"9bf0ec91a2394590\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/referenceNode.js\":\"1e38d300fb979173\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/remark-reference-occurrences.js\":\"712761f64e7621b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ac17995e31ae4aa8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/index.js\":\"6ca1a807df2bdb53\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"915364d39a12f537\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8af8d4a44415c738\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/mergeRetargetProcessor.js\":\"ef553c7809f4ed21\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/parseFence.js\":\"e3ffc8a0342aab88\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceParser.js\":\"eb6ebc45a1e2e055\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceProjection.js\":\"d184509f03155f8d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referencesProcessor.js\":\"9736b520d3c5f595\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/renameProcessor.js\":\"02744c903c3cdf87\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/spanReplacement.js\":\"e783288281838138\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/htmlToOutline.js\":\"d9a2ca3bec3222ec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/index.js\":\"28dbf358c7b92b89\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/normalizeClipboardDom.js\":\"da6693a0279ed05b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/pasteDecision.js\":\"d562bb17125d2362\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/action.js\":\"205efa66ead8afff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/blockIds.js\":\"3baff74cc457dfb8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/content.js\":\"404203e70fefa2a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/effect.js\":\"14d5037bf0cfdc00\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/ids.js\":\"74ef3b8f1bd602d1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/import.js\":\"ac2b182df1f72c82\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/index.js\":\"6cae3365c69458be\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plan.js\":\"f428d07a117130b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plugin.js\":\"e37e2c638fd500dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/promotion.js\":\"22b21feb192fae96\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/properties.js\":\"8f6c6f2995bb4f11\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/references.js\":\"e33092463a870812\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/report.js\":\"ee1ce6b1fc2b6f56\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/roamMemo.js\":\"ec14e278cd12da9b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/runtime.js\":\"ac144fe857a9df67\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/schemaReconciliation.js\":\"0102edbde859deee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/srsMarkers.js\":\"301346c6b09fb1f3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/todo.js\":\"a26d39da1a2984fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/typeCandidates.js\":\"61de2945faa5bdb6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/types.js\":\"dc163520259c6d05\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/index.js\":\"e4b422d01dbff3b6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/store.js\":\"813cd6e623062b01\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/HeaderItem.js\":\"567e7972970b3029\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"685a624a04e63556\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/index.js\":\"0362d0a7db55894e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/model.js\":\"765d107872e98b6e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/toggleStore.js\":\"047e6cee1e75ed42\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/useKeyInspector.js\":\"3bf5d928b6242b84\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d8d4a25cee1b93bc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/ShellDecorator.js\":\"32ebcf83b156fda7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/actions.js\":\"a289c995422e4e43\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8b0113e72a28cdcd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/index.js\":\"83249ebd2676b9e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/shell.js\":\"93def17bf21abe81\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/surface.js\":\"fddb6279c660b07c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/walker.js\":\"fbb47341765480f7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/RescheduleToast.js\":\"2006e5e9bf480e6e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/dataExtension.js\":\"a7d94d84749289b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/index.js\":\"5cab88aedceb06b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/indicator.js\":\"d855bd3b05b60c7d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/moveSrsState.js\":\"495adca4b9aca951\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"65910dae822e5711\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/scheduler.js\":\"52256520156af6e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/schema.js\":\"230c40421ff46121\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e06f974d0ff40e68\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsClipboard.js\":\"9e980507690ca33a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"fcafb5a3f8ba1b33\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2a5ee32ce5a124cc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DeckPicker.js\":\"5d03999656f8108b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewControls.js\":\"bbb2fc1d21aee2e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6a51caeea1f099d3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewSession.js\":\"f25b88fa887b8d7c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/actions.js\":\"327b7190d7a43245\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/archive.js\":\"156528dfe73c9bf5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dataExtension.js\":\"1bd2724c235e14ad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/deck.js\":\"967c759f17e00c3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dueQuery.js\":\"93d6aacd1d07c81e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/gradeDecision.js\":\"7afde4bb88a51246\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/index.js\":\"e06ecf6dede8aa9e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/keyHints.js\":\"d02817fc1c79a57f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewCardLayout.js\":\"a88968fd9b9cfb29\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewProgress.js\":\"3492cc25f760b443\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/schema.js\":\"839a3ca0a668fd16\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/useDueCards.js\":\"68f58ec173182078\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/index.js\":\"04d7b200436768cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/record.js\":\"1aa7ac1b23f319de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/index.js\":\"366afbad1be0748f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/persistenceStatus.js\":\"aa6b2d818241ae4e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/requestAction.js\":\"05beb674075c8ffb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/TypeChipsDecorator.js\":\"9cbe6e42d77a9dd8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/codeMirrorExtensions.js\":\"ac9f8cd4666cb6a2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/index.js\":\"024d52afdd94083f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/typeAutocomplete.js\":\"c1edfa7bff849b18\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a34a5317301aff25\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/actions.js\":\"6c39ee6b1c890850\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/anchor.js\":\"9da9ebef6a96fca9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/events.js\":\"d5987d4f2a9ab79d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/gestureActions.js\":\"566a68c34c3d48dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/index.js\":\"1f7600332a4d8663\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5dde4cee68d22ca8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/collect.js\":\"9dce4769d49561ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/index.js\":\"d4a4c47d78ba5f25\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/record.js\":\"070c783b349c71e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/RejectionDialog.js\":\"ed801ccce4602608\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/SystemStatusHeaderItem.js\":\"85cb269c8fc9b881\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/index.js\":\"b4cce06e80f6d841\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/model.js\":\"2112ea014aa19a60\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/queueCounts.js\":\"435a54342b5efd46\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rejectedHelpers.js\":\"1492d9671785f1c3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rematerializeAction.js\":\"9f8988a4a3bdf19b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/useHysteresis.js\":\"94498892408dd2f9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/ColumnHeaders.js\":\"337486da7e956660\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/TableLayout.js\":\"44a25b2c4154dcf8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/actions.js\":\"f78de6024bc9db2d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/cellEdits.js\":\"6670f595b8bface6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/columns.js\":\"2b7a3f2f4a9f23d3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/controller.js\":\"c31d13fb3b0738b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/convert.js\":\"61a819846cb3171c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/dataExtension.js\":\"de92f80798f00860\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/index.js\":\"39822e41f258fb8d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/keys.js\":\"f00cd33d4b143227\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/model.js\":\"6b3414a701b3c38b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/format.js\":\"2f8dae6e3971c9a4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/parse.js\":\"f2920cc9865f092b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/registry.js\":\"5f5f1174177c0182\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/schema.js\":\"a0d8e7e8efb92d84\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/effect.js\":\"3233c6dc49b4ec73\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/index.js\":\"d29323a38a147dcd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/theme.js\":\"09109cd418d1e8e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/actions.js\":\"aebbca71789257fd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/dataExtension.js\":\"2eb65d725cfd0bd2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/index.js\":\"660de69d8b18cec8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/schema.js\":\"3fc9fabc61cd6122\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8132bf736ef5bd18\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/actions.js\":\"b3e2dfb3a65570f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/defaultItems.js\":\"8f703c8597cf468f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/facet.js\":\"e37a461c607a662c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/holdRecognizer.js\":\"6cd567cb485bd2ac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/index.js\":\"8e699a1452e99909\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/UpdateIndicator.js\":\"ba5b551c5182fa54\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/index.js\":\"23d10377ec64194b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/loadTimes.js\":\"28e69b392bc980c5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoNotesRenderer.js\":\"5e2b12568e72ac4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoPlayerRenderer.js\":\"a4c97f25d177220b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoTimeStamp.js\":\"25d87ec925e1297b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/actions.js\":\"1d065b36ff1f5842\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/index.js\":\"20283e00132007b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/markdown.js\":\"cf44b301d5012fd7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/notes.js\":\"81b9eb6fb6546eb7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/registry.js\":\"fe9efe76333f7fbf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/remark-timestamps.js\":\"0db03e84b363a853\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/view.js\":\"efad792e655ab343\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/LinkHints.js\":\"793a1b9141b23d14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/index.js\":\"781bca309c627365\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/model.js\":\"fe88435e482109bd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/settings.js\":\"70945d443b00ea47\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/actions.js\":\"c9ad8b7489e4d675\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/index.js\":\"275e3e74b835619c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/interactions.js\":\"2101af57062421b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/workspace-header/index.js\":\"6e01f0869fa41441\",\"/knowledge-medium/pr-preview/pr-1835/src/registerServiceWorker.js\":\"039e434cec21f49a\",\"/knowledge-medium/pr-preview/pr-1835/src/requestPersistentStorage.js\":\"c30e7fff73475bfb\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authRequestDeadline.js\":\"3928cef0907dc279\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authStorage.js\":\"c15e4d3a783b4a0b\",\"/knowledge-medium/pr-preview/pr-1835/src/services/powersync.js\":\"ea8795e7be0ce410\",\"/knowledge-medium/pr-preview/pr-1835/src/services/supabase.js\":\"e23a450e58a1da25\",\"/knowledge-medium/pr-preview/pr-1835/src/services/uploadErrorClassifier.js\":\"b8b3e1b8d02b1e6d\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/ActiveContexts.js\":\"3cc97a4a900bfffe\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/HotkeyReconciler.js\":\"1f61a16d04b50edf\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/WipeLocalDataDialog.js\":\"d676ae45f9dcff7e\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionDispatch.js\":\"a1071b974c21a254\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionRefItems.js\":\"631676131f78d5a7\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/applyKeybindingOverrides.js\":\"63970df9c459d635\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/blockActions.js\":\"145c2d285b4c85eb\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/canonicalizeChord.js\":\"9f83ed116b6fa7c0\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultContexts.js\":\"81d8393cd305b53f\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultShortcuts.js\":\"6fe6130ca2d412c4\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/effectiveActions.js\":\"da7a08e7db3dd36e\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureAction.js\":\"fe206ac2a5e84637\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureBinding.js\":\"efcce700192d1df7\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/holdRegistry.js\":\"6c08a8b3d6d5ee2d\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingConflicts.js\":\"4ef8ff110955ea65\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingOverrides.js\":\"3e807a0e72be7ed0\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/pointerAction.js\":\"2523511e637d1b30\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/resolve.js\":\"8c09826361a4cc1f\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/runAction.js\":\"ab4c49206109b693\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/sequenceMatcher.js\":\"6ed06b1e57e2c5b3\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/types.js\":\"1c2369f9802ab15a\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionContext.js\":\"24829a7a3f816156\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionDiscovery.js\":\"14d34cb00f016073\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/utils.js\":\"df3f9cf42dc043f7\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/bootStore.js\":\"5a18ec2962a6258a\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/previewDatabases.js\":\"4faa2ffca77aea59\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/byteTransform.js\":\"eadb630243237585\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/attachmentCleaner.js\":\"6c04ecba39b8485a\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/attachmentParts.js\":\"845d960c6170feb3\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleParts.js\":\"c1e596d447c04cd4\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleRecord.js\":\"b1e11badc24602e5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/manifest.js\":\"906d7f93ece5c928\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/takeBundle.js\":\"2e05ff5086e91eb5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/verifyBundle.js\":\"f897b11a71081870\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/cleaningStage.js\":\"d367c6b9fe55613d\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionKey.js\":\"eaf137d07f5411f0\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionServer.js\":\"41ab315b814e0aa0\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flip.js\":\"419dc0f2835d34ae\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flipAttempts.js\":\"c5b877a97a1646d1\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/pages.js\":\"a5def905cf96d340\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/preflight.js\":\"c62912a56b1e8fbf\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/reseal.js\":\"4016972f9458d554\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runConversion.js\":\"8782f51a9ba0c18f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runLock.js\":\"f6a2741016b9ef5f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealing.js\":\"cb947485ccaf3ff3\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealingStage.js\":\"4e82e86ec3dc92ee\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/stage.js\":\"f3834a24f77e3f4f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/verifyReseal.js\":\"6039c8a3bae4624b\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aad.js\":\"b35dd6748768ae58\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aead.js\":\"ccea319fad696aa0\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base32.js\":\"d502a8d8918a73f1\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base64url.js\":\"e947562697774ee4\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/binaryEnvelope.js\":\"57502ccc0744c6f4\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/byteAead.js\":\"5b984550b04776af\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/canary.js\":\"ce216f1e7c846df6\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentHash.js\":\"a38b37fd23306e17\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentKey.js\":\"a38444be2fb5c337\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/derivedIdNamespace.js\":\"8a695673745ef438\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/envelope.js\":\"5f5e96426acbd0df\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/hex.js\":\"3a9f6a7919adb5ca\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/sha256Hex.js\":\"6a2330eb326d891d\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/workspaceKey.js\":\"5c19f796a338a460\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/conversionState.js\":\"f4e688f420f0a558\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bdf15163b430209e\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/pastedKey.js\":\"1879112476841cb0\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ad6fc6859496b0dc\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/upgradeWorkspacePin.js\":\"78037063ad5cd278\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/keyStore.js\":\"e8fe4092b3599c98\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/mintWorkspaceKey.js\":\"c0ec217416c16d93\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/modePin.js\":\"28a48ec15337f5d6\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/openWorkspaceKeys.js\":\"7421ac5d4bc62a82\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolveWorkspaceEntry.js\":\"01ad759306a47a35\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolver.js\":\"96728d5de4a2a155\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/workspaceAccess.js\":\"a0753f52079fdfba\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/transform.js\":\"162c295a595e7af1\",\"/knowledge-medium/pr-preview/pr-1835/src/themeBootDefaults.js\":\"3a5bde5ba4fafd12\",\"/knowledge-medium/pr-preview/pr-1835/src/types.js\":\"01e9b0ce61e1402b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/ClientLocalSettings.js\":\"29a2c4197a3c5d95\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/abortableSleep.js\":\"cd011ef5139417e8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/array.js\":\"6ec6ca115863b772\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/backlinkAutocomplete.js\":\"e86a7ded4588a186\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockCrumbs.js\":\"c956ce3ffcbc6b30\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockrefAutocomplete.js\":\"8fc2753845f71010\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/cadencedIdleJob.js\":\"0266f07177155caf\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/callbackSet.js\":\"0f3353a21cbcadea\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/clientId.js\":\"5f4e94d95eab0363\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirror.js\":\"cda579ef202b934a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirrorCompletion.js\":\"8e0292f31f03b058\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/copy.js\":\"4194254e14d60419\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dailyPage.js\":\"d61af76cfc270dba\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensics.js\":\"96bba20ef725118a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensicsHooks.js\":\"2e36a81e8c6ea3a4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/deleteBlockThroughUi.js\":\"d1ebede821740eb3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dialogs.js\":\"6ce60fb7d5ac249c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dom.js\":\"05138141ae6004ee\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/downloadBlob.js\":\"0e4f442cadd47944\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/exportSqliteDb.js\":\"5189920d6c0a9f5c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fileSystemAccess.js\":\"8b66a16e60c15048\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/flipSlide.js\":\"b7305209d694bd97\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fnv1a.js\":\"9112160c727503bf\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/formatBytes.js\":\"e964206e276ff0c4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fuzzyRank.js\":\"c18ad94f7add043d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idbKeyedStore.js\":\"7bec16d397eaf85b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idleCallbackPolyfill.js\":\"3857cb5e117b16e6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardAwareScroll.js\":\"f55605fd95574fb7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardViewport.js\":\"bad85829462842f0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/lastWorkspace.js\":\"99c84a1fedf997b6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutColumns.js\":\"bda15e873ddf98f4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionDom.js\":\"7193a5b8c2f0730c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionId.js\":\"577b7b1ca3c101ba\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkClickGestures.js\":\"2cd5e691fa83a3a3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkTargetAutocomplete.js\":\"a37a19f6a1dd3a92\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbCorruption.js\":\"7f62b350a9250456\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbRecovery.js\":\"d15a5ec38c3518ed\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/markdownParser.js\":\"a6d2fa9a6eb0c4ca\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/memoize.js\":\"9f0804d65f4f79f7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameFieldCommit.js\":\"e5e202d676df502b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameList.js\":\"b196a2571f9f95bb\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/navigation.js\":\"488cc411c20087d7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/omnilinerNamespace.js\":\"14a7356813bda860\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/opfsPageScan.js\":\"c18069b57063b1b1\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelClearance.js\":\"239fba6e3b65f4ba\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelHistory.js\":\"0d074e4fe1dddd25\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLanes.js\":\"d36d8bbf5c169a57\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLayoutProjection.js\":\"ae9e86fd33c409cc\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelScrollAnchor.js\":\"471136064a27a712\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelUrlFlags.js\":\"50831449d82163de\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/platform.js\":\"2cc9fd04235461d6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/pluralize.js\":\"439e51b4301033fe\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyCreation.js\":\"9a8ba3205776a71d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyNavigation.js\":\"e533ebc89b2df11b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyValueContext.js\":\"e9eadbf4ea00d727\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/react.js\":\"7958a4aeac317587\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeDate.js\":\"c7a3820065357464\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeTime.js\":\"5e07b1ca8d928743\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/renderScope.js\":\"cf494a4fb25a47e7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/resolvedThenable.js\":\"57a83c005f30430e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/routing.js\":\"b4a8699e25ca3ed3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/safeMode.js\":\"781b45a672d4bc59\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/scheduleIdle.js\":\"c3953b86f71d43b6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/screenWakeLock.js\":\"7765dca4153fc492\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/selection.js\":\"f3ca5d57e463488c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/softKeyboardGrab.js\":\"a6488dcaddb91210\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/startupTimeline.js\":\"8b806dc33b5ede03\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/state.js\":\"1f8cab0ac8ed1aca\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/string.js\":\"af0a22df98aa07f2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/surfaceZoom.js\":\"390e8da24e17757b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/time.js\":\"854bb3a919675292\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toast.js\":\"f0a7e7911e67f8a4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toggleStore.js\":\"3cd2ad505de64e1c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/untilStopped.js\":\"1455d9dd8af63313\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/userActivity.js\":\"c91956ea4b8dc548\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewTransition.js\":\"719adc0e0becbcaf\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewport.js\":\"3727c0ee45851256\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/webLock.js\":\"d3cd9d7d020a9f3b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceRecovery.js\":\"a9345f89123c1d60\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceSnapshotStore.js\":\"89091b58aa8e1b5f\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-compiler-runtime.js\":\"ee1de3022a6de12b\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-client.js\":\"d45719d611cb15d5\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server-edge.js\":\"c5e281aa55ced7fa\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server.js\":\"8345d42faa7a0196\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static-edge.js\":\"568eab209441b02d\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static.js\":\"f0830c39e37a0392\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-test-utils.js\":\"455d8f545b3914db\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom.js\":\"1df52ca468262bc1\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-runtime.js\":\"d2e3665a30d73ecc\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react.js\":\"7eea271bcf6341be\",\"/knowledge-medium/pr-preview/pr-1835/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
