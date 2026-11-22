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
		buildId: "b11d79983bb1-f1945085",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/\":\"9dc0482ad6f92dce\",\"/knowledge-medium/pr-preview/pr-1835/index.html\":\"9dc0482ad6f92dce\",\"/knowledge-medium/pr-preview/pr-1835/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1835/assets/FacadeVFS-BoZeKy0e.js\":\"5fccdc39e3e9d0d2\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSCoopSyncVFS-C554CYtm.js\":\"89d0cdd720b1e1c8\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSWriteAheadVFS-D-ARDwTp.js\":\"111b65c452559013\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CfFcOy3a.js\":\"ccb0717c96dc86f3\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-ecAwXFSi.js\":\"36e79fd0a2bc2403\",\"/knowledge-medium/pr-preview/pr-1835/assets/worker-BVuoIuZy.js\":\"442140cd1ac040b4\",\"/knowledge-medium/pr-preview/pr-1835/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1835/chunks/app-CwA-1EMf.js\":\"c9023acf2aceedd7\",\"/knowledge-medium/pr-preview/pr-1835/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1835/index.js\":\"be3806205c840d93\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1835/assets/AccessHandlePoolVFS-BJe-RLwr.js\":\"acbe336f23eaac43\",\"/knowledge-medium/pr-preview/pr-1835/assets/IDBBatchAtomicVFS-DdaWcIgF.js\":\"7d3c7ee66c8bb727\",\"/knowledge-medium/pr-preview/pr-1835/assets/MemoryVFS-CduzpJx0.js\":\"c354dfd2ef37f7b1\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Q_Tx3yzG.js\":\"8a033b0c1634f22b\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-D1J0A38Y.js\":\"0bcebdc41467f094\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1835/chunks/AccessHandlePoolVFS-B97UPhEA.js\":\"7e812d766e1cc802\",\"/knowledge-medium/pr-preview/pr-1835/chunks/FacadeVFS-BXnTEQhE.js\":\"9e9614b5fec9607e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/IDBBatchAtomicVFS-DNtmUBaj.js\":\"2cea946d63aceeff\",\"/knowledge-medium/pr-preview/pr-1835/chunks/MemoryVFS-DMd30p0W.js\":\"77938a2620d2e9e9\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSCoopSyncVFS-CYtttdPU.js\":\"4c5a6efdd8b4e552\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSWriteAheadVFS-Y8foEyUh.js\":\"4c422167095cef7b\",\"/knowledge-medium/pr-preview/pr-1835/chunks/Preview-BqhkLAJ_.js\":\"7e44ecbe1ecac7a2\",\"/knowledge-medium/pr-preview/pr-1835/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/card-DbdqX1aa.js\":\"67d63fcfd218a3c0\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-DYq6CwM4.js\":\"580fc4f5fa98983c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-async-B9hR_7Lk.js\":\"bbd850c55cebc0df\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-cAgv7Ezj.js\":\"3a0d779a46aa8844\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-4B5IuH-5.js\":\"e4ec89f111791b74\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-BSRpUP0N.js\":\"719f20516cdb3c27\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-BWWV292E.js\":\"1e501aae81337bae\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-C0i85QjE.js\":\"174ce2fbdf9ac52d\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CMkGr_ma.js\":\"74d4f8e6644b7ef5\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CPEN-wP6.js\":\"fd9ec39f59144049\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-D46XlT7G.js\":\"38485b92849725df\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server-legacy.browser.production-Dui6n92K.js\":\"bf99b8136ecac579\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.browser.production-USfJDyWJ.js\":\"dbcf898450504058\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.edge.production-CzYwpvUd.js\":\"1060ab63b0ced50d\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-mmb_6jWM.js\":\"25bb1bf06a8a7869\",\"/knowledge-medium/pr-preview/pr-1835/chunks/server.browser-D4gZkvYd.js\":\"8d1672fa075eadd1\",\"/knowledge-medium/pr-preview/pr-1835/chunks/textarea-CmhvBIYz.js\":\"5e825205fefb70ce\",\"/knowledge-medium/pr-preview/pr-1835/chunks/ui-DzPyt9bV.js\":\"7cefb75e7da5069b\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite--mV--lEA.js\":\"338ae570feb00b83\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite-async-BSfHuVYl.js\":\"63adf8c77ad564c6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1835/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/src/App.js\":\"69eba540526f3aea\",\"/knowledge-medium/pr-preview/pr-1835/src/appUpdate.js\":\"ed248941d2b4235c\",\"/knowledge-medium/pr-preview/pr-1835/src/appVersion.js\":\"df55065747229b6c\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/initialLayout.js\":\"36a5be645614ca30\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/openWorkspaceData.js\":\"1d1a12f6a8218fbc\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/resolveWorkspace.js\":\"4bfb507b3f22ad70\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/workspaceBootstrap.js\":\"6c36f1a23e5c6e63\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockComponent.js\":\"774cbfdc51e72dab\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockCrumbs.js\":\"b390f990b0a71b16\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockEditor.js\":\"6a9b12d6dd81bfa6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockLoadingPlaceholder.js\":\"e27c79e10ffc51a5\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockProperties.js\":\"3464848c74d47df0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockSearchPicker.js\":\"c356459a28a890e4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ConfirmBulkDeleteDialog.js\":\"b54d1ba596f195f3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DividerHandle.js\":\"510e5851316ab4ea\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DraftEditor.js\":\"27f89a6ab85cb766\",\"/knowledge-medium/pr-preview/pr-1835/src/components/GutterPill.js\":\"ecf0dd8d0009a308\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Header.js\":\"fc1f1595541f1b54\",\"/knowledge-medium/pr-preview/pr-1835/src/components/LazyBlockComponent.js\":\"a911814d80cf745f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Login.js\":\"960474ff07787db7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ZoomableSurface.js\":\"81d0faaa3387b29b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/editModeKeepalive.js\":\"8bba331be0e951ea\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9ce383ddd65523a5\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3f955f1508382538\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefPropertyEditor.js\":\"dee7e4925887e017\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefTargetTypePicker.js\":\"8e10ff3f821d7516\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/SelectPropertyEditor.js\":\"a9208ed9e6380350\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/TypesPropertyEditor.js\":\"fd3b7bb4a4870d34\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/defaults.js\":\"f9c16e714d40c66e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/kernelValuePresets.js\":\"3669c516d494944f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/selectablePresets.js\":\"4bba64bb27232c79\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/typesPropertyUi.js\":\"ca946e9cce400f13\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/AddPropertyForm.js\":\"959d7252ba70a6f7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyPicker.js\":\"089c0c793523eb36\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyRow.js\":\"1f21bfa311ca6a91\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/Rows.js\":\"ac82c3f2248c2100\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/actions.js\":\"35b6e6ba83119bac\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/declarationOnly.js\":\"6865e8e8da7d717a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/layout.js\":\"d29bbefe3bf37689\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/model.js\":\"bc9e090e57f0352e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapeUi.js\":\"9ba76c28d45e06cd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapes.js\":\"ea65fc4336f0dd89\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5b70ecf5526be871\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/visibility.js\":\"923ad72d071612a2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanelSections.js\":\"ecd127aa605f44b3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockEmbed.js\":\"cf2e92e97fa6d16c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockLink.js\":\"fef06a0e3bc28efa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockRef.js\":\"49005a18fddc1ddc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/ReferenceLink.js\":\"2169a0798a1320ba\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuard.js\":\"a1c500cb51955ea4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuardContext.js\":\"f8eedfab5cd2b5ef\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/linkInteraction.js\":\"138c47a6c61c31c3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/referenceLayout.js\":\"dea6ccd176b237be\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/useBlockRefAncestors.js\":\"52ba539a26d2d413\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockGutter.js\":\"fab1ce0abb9959ae\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockInfoDialog.js\":\"661944d18d66af13\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockTypeBlockRenderer.js\":\"02b1a2dfdf821547\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BulletHoverCard.js\":\"5a9d50073a698f0d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorContentRenderer.js\":\"c054bae35ceafea3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fdc217475e629f79\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ColumnResizeHandles.js\":\"4f5e32876d426942\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0239ef371b57f164\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/DefaultBlockRenderer.js\":\"0743697eb366ab9d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/LayoutRenderer.js\":\"1b273826de444258\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MarkdownContentRenderer.js\":\"e21f28a23ebbf88a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MissingDataRenderer.js\":\"4eaeb384eaa20ee4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PanelRenderer.js\":\"0d842b492326f31f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f8a57649d8e6b111\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/TopLevelRenderer.js\":\"96706aca30dc8b7f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockGutterMode.js\":\"2b8b9ba2753ed1d2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockTitleText.js\":\"2965343f29c38d5e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/fieldCreationKeydown.js\":\"c524c4aa110144e5\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/layoutRootContext.js\":\"c94328c5ac216512\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/TypeChip.js\":\"80e4f1d34a46480f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/chipStyle.js\":\"149a3f0466550544\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/anchored-floating.js\":\"988d7927b6f05772\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/button.js\":\"eecdd8ffc0ae7903\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/card.js\":\"638b68c0a3a76467\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/checkbox.js\":\"36f95226f0861b4f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/collapsible.js\":\"c06e5b76df720d5c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/command.js\":\"52a66b9aad6f6ecd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/context-menu.js\":\"8c08f565e23ad849\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dialog.js\":\"22eacabb1fe5c269\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dropdown-menu.js\":\"1edf901e97e3a037\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/floating-listbox.js\":\"d427aa22e949bb7a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/index.js\":\"4c28492d1f58176c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/input.js\":\"a0e96878c668742f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/kbd.js\":\"750ccea82e5e1436\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/label.js\":\"bb7e63ac4dfb070f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/textarea.js\":\"7780c48e04816493\",\"/knowledge-medium/pr-preview/pr-1835/src/components/useEditModeYieldKeepalive.js\":\"4dfd2a0ce996fa17\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/BootFallback.js\":\"80137dca2d618273\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/FocusedRowLazyMount.js\":\"8be7da0eebf464ea\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LazyViewportMount.js\":\"f757bc8675e824c0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LocalDbCorruptionFallback.js\":\"25155f52b18eb692\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/error.js\":\"6e641a028952a884\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/lazyMountRegistry.js\":\"23ec4a9ea557f3e7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/suspense.js\":\"e21ad559dd4431b7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/CreateWorkspaceDialog.js\":\"f906c1d9c586ca97\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/PendingInvitations.js\":\"b4ce903eaa122447\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/SyncProgress.js\":\"9d16c53af917767e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/UnlockProgress.js\":\"bb845a0aa01b5330\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceKeyGate.js\":\"487fb36b36d1a161\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSettingsDialog.js\":\"84f5621678bff752\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSwitcher.js\":\"6df6151ef79cebf4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSyncGate.js\":\"3a7c29e0362f1b81\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlow.js\":\"45f73c0f6c950f3a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlowHost.js\":\"649ae5ec59a4b82d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/EncryptionSection.js\":\"9afcf8793719b894\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/attachmentPrompts.js\":\"9cdbf8208c56dc67\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d820e6ac502c544e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowDeps.js\":\"2b94456a88185568\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowStore.js\":\"1d46cdde9cadc6c0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/flowUi.js\":\"7f6f807bb3642050\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/useConversionRun.js\":\"85c04dd2e74a6f01\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/keyUi.js\":\"76e25494d1b48542\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnKeyLoss.js\":\"42fde265ccee6f6b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnServerE2ee.js\":\"09c9619387fabc96\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/workspaceUnlocked.js\":\"bee2350495071cca\",\"/knowledge-medium/pr-preview/pr-1835/src/context/backgroundSubtree.js\":\"e7965878190024b9\",\"/knowledge-medium/pr-preview/pr-1835/src/context/block.js\":\"ae10f43cc8a0a457\",\"/knowledge-medium/pr-preview/pr-1835/src/context/layoutWsContext.js\":\"40148e7172c6136d\",\"/knowledge-medium/pr-preview/pr-1835/src/context/propertyDisplay.js\":\"a4353303ceffeb5c\",\"/knowledge-medium/pr-preview/pr-1835/src/context/repo.js\":\"1c879956e21f074b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasClaim.js\":\"2f92219559fb22c4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasSeatNamespace.js\":\"5a91e6a676663b2a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockData.js\":\"c4c24f5bfa763a26\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockType.js\":\"54a3455b9a4a3b1b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/changeScope.js\":\"52814721d89b4212\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/codecs.js\":\"2478de060e874a07\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/derivedData.js\":\"78573aa2c42410e5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/errors.js\":\"7b6e20ff0c30d93c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/events.js\":\"12b7023a6e3944c9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/handle.js\":\"332b25f9309b9a4d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/index.js\":\"1f8df77a6065a167\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/mutator.js\":\"90bf55cac6bba68a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/processor.js\":\"cb94918dcd84f3c1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/propertySchema.js\":\"faf597ff62cfdabf\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/query.js\":\"5c9d65f3a177d5f7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/sameTxProcessor.js\":\"10107d36224f05bc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/schema.js\":\"332b25f9309b9a4d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/tx.js\":\"332b25f9309b9a4d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/typedBlockQuery.js\":\"9b81306646e1f5f5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/user.js\":\"770bc9773d696b56\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresetCore.js\":\"31f84f41d2dd73c4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresets.js\":\"5c1f4099447a2abd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/attachmentCleanerIOVerb.js\":\"387133d0325643ee\",\"/knowledge-medium/pr-preview/pr-1835/src/data/block.js\":\"d85a9670987850f7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockCache.js\":\"f9d79abdd8688c2c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockId.js\":\"7b57dc0ad63a4995\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockLiveness.js\":\"d3227b55a4864e68\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockMerge.js\":\"68bdee5f26431258\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockSchema.js\":\"622778654987fab3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypeLookup.js\":\"f03a383d598be321\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypes.js\":\"385aa98af3231764\",\"/knowledge-medium/pr-preview/pr-1835/src/data/clientContext.js\":\"d959bb84701fb556\",\"/knowledge-medium/pr-preview/pr-1835/src/data/dbFileSiblings.js\":\"e1e7359396a24e9e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/definitionSeeds.js\":\"c8aaf602f45072a9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/derivedIds.js\":\"84c89cdd18b20648\",\"/knowledge-medium/pr-preview/pr-1835/src/data/drawnSubtree.js\":\"deced57dd5f8ebca\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facetBridge.js\":\"fb6d8df0fbb6f592\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facets.js\":\"a02a5b351acb55ea\",\"/knowledge-medium/pr-preview/pr-1835/src/data/globalState.js\":\"1ffcd6350f529d24\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/aliasClaimRederiveProcessor.js\":\"4f7993bffee31ce2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/ancestorBatch.js\":\"9284c42ba368541c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/blockTypeTypeifyProcessor.js\":\"4ba876a13a1d87e5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/clientSchema.js\":\"000a9d6bbd0ac175\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/commitPipeline.js\":\"d8264a5b9b946a3e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/devAssertions.js\":\"40b1b11dfebce02b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/firstSync.js\":\"0e9a4b28c54a5756\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/freshInitialLoad.js\":\"e95bc74f593b2754\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/graphBackfillClaim.js\":\"4b031a356223d9f6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/handleStore.js\":\"541e098c9156a7dd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/idleMarkerJobs.js\":\"b0d53c5909207b36\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initialDownload.js\":\"d5968c8f8c7aad90\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initializeClientDatabase.js\":\"00580cfb9caaa8b2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/jsonCanonical.js\":\"d34d724809097eba\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelInvalidation.js\":\"6db7b461625f090b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelProcessors.js\":\"c0f3d70eb560912b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelQueries.js\":\"27db9c6a09679ca9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/mergeTypeMembershipProcessor.js\":\"1f583634ef80314e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/normalizeReferencesProcessor.js\":\"f5990ba94fa1180b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/poolInstrumentation.js\":\"e802bf1b962f7c1b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/processorRunner.js\":\"42b5721cb3bf1fd3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyCellBackfill.js\":\"353e504c2acc4abb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildMint.js\":\"1fe94a5cb23010d5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildrenProcessor.js\":\"751bde1f78dd902b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d1d4f9c2d8b1d533\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionSynthesis.js\":\"f4231a17c5275755\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyKeyScan.js\":\"e0f46a27e375cf9f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertySchemaResolution.js\":\"45c9d9d14a238a01\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyValueEdits.js\":\"d92db995530c3cca\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/raiseProtocol.js\":\"ccaed0ca73525a06\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/readBatch.js\":\"604f05c48dcbd499\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/refProjection.js\":\"c39b846407f6f9e7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetLookups.js\":\"aa9e6fbcf0b5bf1d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetProcessor.js\":\"42654a7f96dba4e7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/replayMerge.js\":\"fbc6282c38239a45\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/sqlBinds.js\":\"aefd0cd54937ba4f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"88b1f2438071dcb3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/arrivalProcessors.js\":\"02b00fda8435f319\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/invalidate.js\":\"31f03226f61a12cb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/materialize.js\":\"d2759ce8d6bcc897\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/observer.js\":\"306e896c17599efd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/reconcile.js\":\"788c1df4aa976052\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/timingMetrics.js\":\"0af220503bdc7754\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/treeQueries.js\":\"82ec265616b73606\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txEngine.js\":\"54dcaa441bf8c4fc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txSnapshots.js\":\"5cff66d10452cf3b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/typedBlockQuery.js\":\"d0946754c9ec0c85\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/undoManager.js\":\"edcb7aa719840054\",\"/knowledge-medium/pr-preview/pr-1835/src/data/invalidation.js\":\"d306d6199f9b48f4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelDataExtension.js\":\"62683f269f834283\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelPage.js\":\"9968a259480c3e21\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelValuePresetCores.js\":\"ce76d82d2b979c7d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbCorruptionSignal.js\":\"fa93dace56f64f7e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbStorage.js\":\"858195f7bb97553d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbVfs.js\":\"7cf9ef4e66f0e76f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localSchema.js\":\"3bc560ccb09f0a98\",\"/knowledge-medium/pr-preview/pr-1835/src/data/maintenance.js\":\"6b728b1aa3204cf4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mergeProperties.js\":\"b06aa33fd7928268\",\"/knowledge-medium/pr-preview/pr-1835/src/data/metricsConsoleHook.js\":\"17f361f24db81355\",\"/knowledge-medium/pr-preview/pr-1835/src/data/migrationsPage.js\":\"c20fb7cf08e3a9a0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mutators.js\":\"05846a7d9b3e8a1e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKey.js\":\"467bed02d2c3ebbf\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKeyPlacement.js\":\"03386c8325e9f08b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/outlineSurface.js\":\"29cb29a1e7c62e7e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingEditorContent.js\":\"c850a052b3939d37\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingUploadsSql.js\":\"698e9ee7b65743c4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pluginStateExtensions.js\":\"d7e229320f752aad\",\"/knowledge-medium/pr-preview/pr-1835/src/data/powerSyncLogger.js\":\"c28e7e5b2e702937\",\"/knowledge-medium/pr-preview/pr-1835/src/data/projectorRuntime.js\":\"622d97dc43d97e01\",\"/knowledge-medium/pr-preview/pr-1835/src/data/properties.js\":\"5edc49e3b3397b55\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertiesPage.js\":\"ef903327d90b1ec8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyChildren.js\":\"c1f0132f4a4bb3df\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionFanout.js\":\"b8836187d5fcf54a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionMetadata.js\":\"c899ed47e5414c41\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionRegistry.js\":\"188fd02e966ca8eb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDisplayMode.js\":\"2888586d8c48e990\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyRowCreation.js\":\"337693c53d16fdf1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySchemaCreation.js\":\"358f492af1f8444b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySeeds.js\":\"069c28d51e064f3b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/recentsPage.js\":\"976ac9373fe35004\",\"/knowledge-medium/pr-preview/pr-1835/src/data/referenceBlock.js\":\"8aa17c498f27f011\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rejectedUploads.js\":\"e033f82ebc49277d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/releasePowerSyncConnection.js\":\"026b681acc065c99\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repo.js\":\"653811e0b4c3ccca\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repoProvider.js\":\"855a76f834dc8d9d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rowProperty.js\":\"d3c9f0df783d85b4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/searchFilter.js\":\"bd2a68d316170c8b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/seedIdentityLedger.js\":\"b8c6a5c1b9843e80\",\"/knowledge-medium/pr-preview/pr-1835/src/data/stateBlocks.js\":\"bb4c563aa245c1cc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/structuralEditPolicy.js\":\"78dea71118c842df\",\"/knowledge-medium/pr-preview/pr-1835/src/data/subtreeDelete.js\":\"6fe3f6c77cd3342d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncStreamLock.js\":\"361c3d95b91ba0c4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableSqlRecognizer.js\":\"7d618915f477afe9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableWriteGuard.js\":\"41674de5a1be4f86\",\"/knowledge-medium/pr-preview/pr-1835/src/data/targets.js\":\"b8c4a20340dbd52d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeColors.js\":\"05b34ed56dbf6ab0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionMetadata.js\":\"6badeb88eb41b12f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionRegistry.js\":\"77effba211032f8b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeExtraction.js\":\"15917c0c503bf9e6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeInitialValues.js\":\"64acda633680311b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typePropertyGroups.js\":\"dc23548172a70f93\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeSeeds.js\":\"7d5d39a79f9701e0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeTagger.js\":\"5d91e3a0b516b3b5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typedRecords.js\":\"fbe3afe7b4278b4b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typesPage.js\":\"3912c3945aca035a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userPrefs.js\":\"e466ccdac4712279\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userSchemasService.js\":\"ce79c7d8effe41f3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userTypesService.js\":\"15a0200457b5c94e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/valuePresetRegistry.js\":\"85d25bdad6ad5008\",\"/knowledge-medium/pr-preview/pr-1835/src/data/visibleChildren.js\":\"6de96ae00ba7ba35\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceConversion.js\":\"d64ee7a43413e304\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceFirstSync.js\":\"a9bc045039e4fcef\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceIdNamespace.js\":\"be61e0adfb22630a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceSchema.js\":\"a4b6a5283369220b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaces.js\":\"b0dd87c54f27e3a0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadLog.js\":\"09c3352f58311b6b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/BlockPasteShellDecorator.js\":\"271e05f3b10ba28e\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/atTrigger.js\":\"aad6297ed0105dd5\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/autocomplete.js\":\"a22e26ee2407ce13\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/codeMirrorExtensions.js\":\"adbfd1b5c769a8d0\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/contentFlush.js\":\"beb074a781e60451\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/defaultInteractions.js\":\"fbd2488cfe8ce320\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/editSettleSignal.js\":\"3ae92ca7615dfa19\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/insertImage.js\":\"b311b644d141bc41\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceCompletionRange.js\":\"c33f58056f44829e\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceTargetTypes.js\":\"9321c4cc3a8b4dc9\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/syntaxContext.js\":\"42f77e04737ac4ec\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/triggerMatch.js\":\"edc15b484b05275f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/AppRuntimeProvider.js\":\"c6e218d25ca5da4b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/BlockFocusShellDecorator.js\":\"3817d9aaf378e197\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/ExtensionRenderBoundary.js\":\"6bd81a5e37008801\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/PanelContentRecovery.js\":\"738fe0a83d0db2b5\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/apiCatalog.js\":\"c3ade94044bdea0f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/approveExtensionHere.js\":\"fdcc2bfa24158bd8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/armedCutAppMount.js\":\"dbb73523350fd114\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/batchableKeyedStore.js\":\"d892fd260020657f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockInteraction.js\":\"c6ae124bf9364b73\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockSelectionAction.js\":\"40422b71e2ac5163\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compileExtensionModule.js\":\"8080c7d43e7b7795\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compiledModuleCache.js\":\"a3f572acf71f781b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/continuousGestures.js\":\"2994edea438dc7f4\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/core.js\":\"9c8ab7f44e808027\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/defaultRenderers.js\":\"ff6ece07d3c9f73f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/definitionFanoutAppMount.js\":\"c93d68a2274642a8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dialogAppMount.js\":\"84097393caa1a54f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensionSeeds.js\":\"e8cc8d069ad0e428\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensions.js\":\"86555aa4e0eb62ce\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/exampleExtensions.js\":\"cd0caadcf23b243d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionApprovalStatus.js\":\"eeaa369180ea1db5\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrorToast.js\":\"1f756a8b6667322c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrors.js\":\"a5e4696ef5609b0c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLookup.js\":\"fb8398fb93f3fbda\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionToggles.js\":\"7fd15c633dce3daa\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionUtilitiesCss.js\":\"7335e9d903d6b9c9\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/kernelPageDeletionGuard.js\":\"9b1ad638343a9bbc\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/liveRuntime.js\":\"66a4456205897f28\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/openExtensionsSettings.js\":\"a99c932aa883bd93\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/overridesCache.js\":\"6387f35f7f4eeb59\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/pluginIds.js\":\"570f615c9a2147a7\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/processorRejectionToast.js\":\"b4986ea71d36c445\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeActions.js\":\"420407cdbd2f9c71\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeContext.js\":\"4cc40ea63fe2f748\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticAppExtensions.js\":\"a7095de23e2e3993\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticDataExtensions.js\":\"2a351edc2a3ed943\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/toastAppMount.js\":\"8c6ee285fd8d7a9d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useOverrides.js\":\"45af39848cc43336\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useShortcutSurfaceActivations.js\":\"eadd0c43fa66947d\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/discoverToggleTree.js\":\"5a4c6108905269b9\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/facet.js\":\"2e07828a6d4474a7\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/resolveAppRuntime.js\":\"40e4e2981370eab7\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/runtimeEvents.js\":\"3b69179b9d37f801\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/togglable.js\":\"42c9aeaaa7d235d9\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/variantFacet.js\":\"28e21e07242a1c51\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/verbFacet.js\":\"04b8bd8df46ce8a6\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/block.js\":\"132cf69dedb9d70d\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/focusedChild.js\":\"71a671c6446bcc3f\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/propertySchemas.js\":\"46c57bf3c0cf9f0f\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/typeRegistry.js\":\"229b650e4999b3f7\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAncestorCrumbs.js\":\"fa761cebe5715428\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAutocompleteListbox.js\":\"eacc4bfc152a6999\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedSearch.js\":\"32324ed581490cca\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedValue.js\":\"8717477c592da56a\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsFocalRender.js\":\"d6396bde2955a2d6\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsReadOnly.js\":\"b739ebb075dc8456\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMaterializeBacklog.js\":\"d11f522c2a26492b\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMinuteClock.js\":\"f1dfb32c9f5159c2\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePanelLayoutProjection.js\":\"29569e20c6567efb\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePendingInvitations.js\":\"b879e5288aefa82c\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRendererRegistry.js\":\"c984959efa7d8ad4\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRetainedFieldRows.js\":\"c9b7e60c4f237944\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useWorkspaces.js\":\"d366597b7b5acbda\",\"/knowledge-medium/pr-preview/pr-1835/src/lib/utils.js\":\"ac226ed9d2e422f7\",\"/knowledge-medium/pr-preview/pr-1835/src/main.js\":\"d8d9ee034f767e76\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/MarkdownImage.js\":\"d829d5ecd2165526\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/blockSeparators.js\":\"27ee1ca72686ce45\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/context.js\":\"3b0f5f2830134b5e\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/defaultMarkdownExtension.js\":\"ddbc9e6b8359dac6\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/extensions.js\":\"a909fa681c37d1b7\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/renderMarkdownHtml.js\":\"ad626c3d9e054225\",\"/knowledge-medium/pr-preview/pr-1835/src/minimal-editor.js\":\"a52f0d9d2dae698a\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/armedCut.js\":\"f89ab7fd6835bf4e\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/captureMediaVerb.js\":\"0e115ad9bf5af850\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/clipboard.js\":\"223bd612ad26ef7c\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/decision.js\":\"e6aa0b7ccecd330a\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/operations.js\":\"ab3dfa95375363a3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/AccountHeaderItem.js\":\"0ba6ded4cb781eef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/index.js\":\"4bb42f3dd7a740e8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"715ebcdd6b21673b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askAgent.js\":\"6175d0449b8217cc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askedStore.js\":\"120ed707a7e56f66\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"4a366f50bac87a33\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/chipState.js\":\"8b5a7d6bd5e0872e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fbfeaa66eab6e453\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/index.js\":\"d2c13268d74947c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c2aeb2888ba2636a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/schema.js\":\"449099ca3dcc61d6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/AgentTokensDialog.js\":\"27ea1ce9616d3124\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/BridgePairingDialog.js\":\"14b126442d6d1eb0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/addMedia.js\":\"6731e4293cace166\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e27ca0a78b1b8e94\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/block.js\":\"f30401a69e3475c6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/context.js\":\"7de36ddc05806aec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a001d83fa5b9de91\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/index.js\":\"4e610fdeff3a2c7d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/outline.js\":\"782c9925bf2e1d04\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/properties.js\":\"56d53b2b21db4275\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/refs.js\":\"4a5a5e8292dc3a36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"304ce9c2f6468a4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/search.js\":\"c5e96d0e7001f3df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/shared.js\":\"3cc8021fc0d4a422\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"bdf50f50684f5b7f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/text.js\":\"6cfab5bbc96af410\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentWrites.js\":\"518f379a03c35c71\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/authoringCatalog.js\":\"eb27cdf806eb0ef4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/blockRefTargets.js\":\"a9440371b2dcf556\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridge.js\":\"aafc6fa1e108b094\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridgeLoop.js\":\"4406ddb995445833\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/changeHistory.js\":\"c2561972881eec3b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commands.js\":\"6d56f965565af39b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commentsCommands.js\":\"78d2dc34946ee5e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataExtension.js\":\"56335879a1a4eebb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataModelGuide.js\":\"c50203b34f5bc0be\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/describeRuntime.js\":\"e4f5ce49c5ac0f45\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/extensionLint.js\":\"9e9f7e676973d406\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/grainAudit.js\":\"7610cbd5b2f400c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/healthCommand.js\":\"28b509e3bf9a9e1b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/index.js\":\"d78d7d53dbc26194\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/presetIdentity.js\":\"cdd1e13cebe93ccd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"bccb5ab07f5d1c8c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/readMedia.js\":\"daed14325c0843ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/schema.js\":\"118b33d3c8ec6051\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/serialization.js\":\"2d97ad1710b3f31a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/targets.js\":\"d19c4af75a576bb6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/tokens.js\":\"8f287bca8c48bf10\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/watchEvents.js\":\"42022414ae5d0b13\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/workspaceGuard.js\":\"dfd81a6657f0f243\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/writeCommands.js\":\"08519a5514dca2b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/AliasCollisionToast.js\":\"fd9b9473aaecf31a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/DuplicateNameBanner.js\":\"ed0ceee18789b6f9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/collisionMerge.js\":\"27d2cbe758b841ea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/dataExtension.js\":\"f1b66fc112b44b55\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/index.js\":\"56f5a98c554471fb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/mergeCollisionAction.js\":\"9a581cd394fe13de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/pageStyling.js\":\"f288e6f189f8a62e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/rejectionToast.js\":\"54f19432c18545e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/syncProcessor.js\":\"ebb3122f67549260\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/actions.js\":\"e00248342e782fa9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/addComment.js\":\"4e41d097d2eceeaf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchor.js\":\"7509e99b1a597ca5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchorState.js\":\"7f041cb83005cb2a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/commentLinks.js\":\"72b154d77d6f4e8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/confirmThreadDeletion.js\":\"ef614c7715b779da\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/container.js\":\"a484477a7f07a98b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/dataExtension.js\":\"00432da3c67073f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/deleteComment.js\":\"1fc4b83134e002c9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/highlights.js\":\"40ca326b84e61d9b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/index.js\":\"0ae6e438fe49b9bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/linkedCommentsPill.js\":\"ccda683facc85458\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/margin.js\":\"7452ea3ad75e06d6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/marginSchema.js\":\"8050fba11a9addfb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/newComment.js\":\"a1e6c648861ef0e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ownThreadPicker.js\":\"4fbde3f64eb56e92\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/placement.js\":\"e64cee1076a25e8a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/queries.js\":\"a25b063b96db4533\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotePosition.js\":\"90700d39cb83412d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedIn.js\":\"fb728a2c379f654e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedRange.js\":\"46ddcc6db1098976\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/rangeRefs.js\":\"3a5ed705a00b842c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readHighlights.js\":\"1b69fc283bad7f3f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelection.js\":\"927db9bf1f4e1c54\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelectionUi.js\":\"1bc17a60ada3feca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/reanchor.js\":\"f16602a76e55ecd4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/schema.js\":\"89ad07a620afd413\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scope.js\":\"32e89660d489bf30\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scopeThreads.js\":\"1a67c15ef577c7a2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/splitRetarget.js\":\"e85ac2704dd2df1c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestionCard.js\":\"7bc6003d50258f2c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestions.js\":\"9ac6ef894dba62c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaries.js\":\"a2f35944374deb73\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaryBatch.js\":\"0f819b0bc5f82f51\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/surface.js\":\"e86eb01ca156bc39\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threadNavigation.js\":\"18d8bc5febfe2f57\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threads.js\":\"ed97513793bcfa96\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ui.js\":\"bc16177bc77a531a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/uiStore.js\":\"23609eb0cbd8c04e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/appIntents.js\":\"fd046ac9ab8c9190\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/index.js\":\"e7e74fbecfebaea0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/index.js\":\"2949964e20f1ec49\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/status.js\":\"2af85590fa06db74\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"323e8853d0bae7a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaBlockRenderer.js\":\"e2a7d23c72e9026d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaDownLaneReplicator.js\":\"3fb1b790d85e28f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaUploadReconciler.js\":\"0a1b5b717b3e56fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetDownLane.js\":\"ac0b8475e71d855c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetResolver.js\":\"fef70e7b065d794f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetUpload.js\":\"b1980c0015810e06\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/attachmentCleanerIO.js\":\"363cc3bf8d42143f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/supabaseAuditIO.js\":\"063c7bd6904d1324\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/blobStore.js\":\"9e2ca16bb3c9f075\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/byteStore.js\":\"067e36a4ff4e6cdb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanerIO.js\":\"598a619b45582995\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanupAttachments.js\":\"0a7b0c0b04705aae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/dataExtension.js\":\"bd110f8cd5af78dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/downLane.js\":\"9d5d4c73259ed6ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/index.js\":\"f453bebe6c48995d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/insertImageContribution.js\":\"6695fd38687d8362\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneArming.js\":\"2b1512701b1c6a0a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneLock.js\":\"6a829623c2fd6ffb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaBlock.js\":\"742fcc70a2fd64cd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaCapture.js\":\"22351853a6a94653\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewers.js\":\"9d7469d5f3b728c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewersFacet.js\":\"e76aef996cb0ec4d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/pasteCapture.js\":\"15321f987752fe6a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/resolver.js\":\"62d0a944fd8bdd95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/retryUploadsAction.js\":\"7121dc339559ad06\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/storagePaths.js\":\"a1a7764e19edaed4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadDrain.js\":\"73cca04455514e83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadLaneStatus.js\":\"0bac694217bf2bd8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadReconcile.js\":\"af74e0144667ff02\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadRecovery.js\":\"0c25dd55bdbec8e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadStore.js\":\"b03bfbbf7a54e71d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/useAssetObjectUrl.js\":\"c11dc1a201b47bf1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"fd828fc0be7997b8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksViewSection.js\":\"7ad7121d95c4db6d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/facet.js\":\"4d7742688f312645\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/index.js\":\"fdeaff9a21aa2350\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/prop.js\":\"52d7cac63bf5659d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinkFilters.js\":\"14b44726a63979b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"21d328c129250558\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BlockEntry.js\":\"1e3ab79705395771\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/LinkedReferences.js\":\"040a286d97d1f1d4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"523ec80fabc86ae8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dailyNoteDefaults.js\":\"572c4ce58bb5dd58\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dataExtension.js\":\"e725508ec659be5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/edgeExclusions.js\":\"58ccad75f964e121\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/filterProperty.js\":\"ff6ffb069f48a179\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/index.js\":\"d0ec6e5fef9b61f2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"017b72947ee32933\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/applies.js\":\"0d5b66c0e420fea0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/countQuery.js\":\"7671538e0700ff14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/expansionStore.js\":\"309c6a529f04827e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/index.js\":\"d408a74c54b16578\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"60ed0fb2603d7fde\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/presentationInvalidation.js\":\"3ad521aa735f6363\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyEditorOverride.js\":\"2bc1701ff0cb8abb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyFilter.js\":\"417497b8275b16fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/query.js\":\"82f8b440d49fe923\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/resolveFilter.js\":\"98d2ce8aa1490bbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sourceBatch.js\":\"2ee4b11f9fca1161\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sources.js\":\"7aa6ca333175fe4d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useBacklinks.js\":\"131f0080d2deba4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2128f6e397c3d12c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayCelebration.js\":\"73cd417c92dcf38f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayOverlay.js\":\"3156fb28fb7a8ded\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/gate.js\":\"bf7526c1b4c321a4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/index.js\":\"15ce85e7cd6c7b4a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/wolfTheme.js\":\"0f66dad04fc91331\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/BlockDragLayer.js\":\"bf3ed6bbbc3c6001\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dragController.js\":\"df9ca7b2d565fe93\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dropTarget.js\":\"8b9b4b0f5b81ae93\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/index.js\":\"c7e23054f04a0725\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/projection.js\":\"296f5f68e4d8db2f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/BlockMetaCard.js\":\"e492c152a0310c1b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/index.js\":\"4874c1e0ca8d7e22\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/AddTagDialog.js\":\"ea801f53c8b9d8cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4767d836b3aa9007\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/TagNameIssueHint.js\":\"806e04b196aa74a0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/addTagAction.js\":\"18b07893645af86b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/appendTag.js\":\"176ebc0e504e0f2a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/config.js\":\"151764ef64c79065\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/dataExtension.js\":\"2fed356091d545f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/index.js\":\"065b185928213dd0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/propertyEditorOverride.js\":\"4da4f7f2c3434ff3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c7420b05ceb94287\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b244246c52faab00\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/Breadcrumbs.js\":\"944d22d19ed4ca98\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"f36ffae95afcdb7e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8770ead01f7dd036\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/index.js\":\"f42d807097074c89\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"85feac393f522ef6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/CharacterCountItem.js\":\"24ef691f361b64aa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d92e70ec8b06eeb3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/actions.js\":\"9c43f05441cf22cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/blockType.js\":\"0bbc0dc6354d6e45\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/charCount.js\":\"51b3ee8da4eea3f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/dataExtension.js\":\"5d93c8db7ee14741\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/index.js\":\"b9cb21f3906d1520\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/profiles.js\":\"743dd0bf226a7e23\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/properties.js\":\"5d329130429ab567\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/textCounts.js\":\"ef7bfcac0e58cb3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/colemak-keybindings/index.js\":\"470e6e79829ee664\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/CommandPalette.js\":\"8e738943835cfcc8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/HeaderItem.js\":\"b628b344245c04a3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/context.js\":\"1e254a38c216a537\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/index.js\":\"125484699b0c637c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/selection.js\":\"cee687b6d7c86db2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/toggleStore.js\":\"51ff369e4973a5c5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/useCommandPaletteActions.js\":\"514dab604c5e8a14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/ContributorBadges.js\":\"cb3f8fc02f24639f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/author.js\":\"e551930fa8578beb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/codeMirrorExtensions.js\":\"c3212ad2280b9f41\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/dataExtension.js\":\"7a45c720e13d6bee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/index.js\":\"10ab3b5eddf0a4ad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/mentionAutocomplete.js\":\"815788504db0081d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/processor.js\":\"0cbed1624b8dc102\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/profiles.js\":\"4a2fd7ab6768cfb0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/queries.js\":\"d06badd9ef767196\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/schema.js\":\"7f37f03d21318ac9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"54041498092fac39\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/followOrigin.js\":\"02259eaf74762f9f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/index.js\":\"74f4484159d964a3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"10c9a42fec122abb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c939c072618b8fd8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/CalendarGrid.js\":\"e8ed99fe813fcbed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DailyNotePicker.js\":\"c884530f52f34a6d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f556ab6e94638bca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateNavDecorator.js\":\"f58bd28ac39e2bda\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateScrubOverlay.js\":\"478849bcc5f5bdd2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/HeaderItem.js\":\"fdec80b4707b7d7a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/ReschedulePicker.js\":\"832b0de8cca84ac2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1f8ef890a970ba04\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/actions.js\":\"454ea43e87bec815\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/blockDateAdapter.js\":\"ad648f88fe7b7949\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/calendar.js\":\"38d51d0506bc4df7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dailyNotes.js\":\"9305a7b671a37bba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dataExtension.js\":\"0ab53870d1e05cc9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubActions.js\":\"66e12570faae4b2b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGesture.js\":\"a043964aee34a695\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6894d5cf27570135\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3c196062b0581731\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/deletionGuard.js\":\"c04e0ed4de5f26f7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dueQuery.js\":\"9b233803cc3d87cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/index.js\":\"7ad7c0ed365b5dda\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/landing.js\":\"1e729bb7c17fb260\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/localSchema.js\":\"bd64180329149725\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/referenceDateAdapter.js\":\"85c9e6f5ba9b94fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/rescheduleAction.js\":\"cd25ef225dae0d48\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/schema.js\":\"bc00afaf5b9e38df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadBlockDates.js\":\"551df1cb431b2114\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadDatesAction.js\":\"2e2d56285ef3244a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/today.js\":\"6647b64d138a701d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3d919204e445c713\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"cebaaad6fd6b8f20\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/audit.js\":\"7771c7921f8e5b85\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditAction.js\":\"adc8827177fcd941\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditRanges.js\":\"56c1453c8dea521c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/diagnosticsSource.js\":\"5c7317494ed64cf0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/divergenceScan.js\":\"fe7bc6783539e138\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/index.js\":\"1e3c9c328fd57e8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/propertyChildrenChecks.js\":\"20970a0b996a940a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/referencesMirror.js\":\"a1eba239aa7ed4af\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/rowJson.js\":\"eb93b5b0258fed7d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/schedule.js\":\"e77be52b2cf5acca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/store.js\":\"771b5ad1b3e13c97\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/action.js\":\"e1ab8e3d6f7f3ad5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/index.js\":\"5d35c84271301492\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/plugin.js\":\"26af7e064fd01ebc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a22ce1adf64c804e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/actions.js\":\"9020b5e2eaf6a7bd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/changeMarker.js\":\"0dcccce58fb45fcb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/diagnostics.js\":\"83c1344cf018184b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/fileSystemAccess.js\":\"cda82678dd59bd7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/filenames.js\":\"0cfd91c77a3851e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/index.js\":\"9adc0840a22c6ac0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/mirror.js\":\"b00940f7baccdb70\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runLock.js\":\"4c0952ee83ca150e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runtimeHealth.js\":\"24d8d54d4512c936\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/schedule.js\":\"ce66141929ee50e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/store.js\":\"b26b23bd60ed2c12\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/index.js\":\"cc4d89b830c105a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/themes.js\":\"f13b19106d411396\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/facet.js\":\"01d22c3308b30630\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/useDiagnostics.js\":\"595148b868b9ea82\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/dismissals.js\":\"63c3fcba903fbbe3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/index.js\":\"727e304d91957241\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/status.js\":\"d438360c791708c5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/store.js\":\"3bc5ac695bda80be\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"740151632a049425\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9a310df689e37372\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/actions.js\":\"9792d3db297200de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/config.js\":\"0d4205deff69eba6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/dataExtension.js\":\"ca56ae6638eed571\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/effect.js\":\"8bafe6cdcd347217\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/index.js\":\"c5f8654dcde25a50\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/propertyEditorOverride.js\":\"34720dfb69a806db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/useToggleTree.js\":\"ae61445d71ff7a9b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/ExtractTypeDialog.js\":\"cc775657b3d1e33e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"50d0923a22c37036\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/PropertyShapePicker.js\":\"8fdb56809c9c5709\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/action.js\":\"f2f0476b72872295\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/index.js\":\"3db1055a10ab41a0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/FindReplaceDialog.js\":\"032b57d36d08db2c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/HeaderItem.js\":\"d39dc9371ea828c1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/dataExtension.js\":\"aa1ad851952c5bac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/index.js\":\"11fb7093f1e4b6c3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/search.js\":\"731fdd4d964dcfba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/toggleStore.js\":\"15d11499681fe563\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/LocationPropertyEditor.js\":\"f6057fb7304c7b84\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/MapView.js\":\"121b2a3359aa2fac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/blockTypes.js\":\"d6e635467068cee6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/codeMirrorExtensions.js\":\"cd67a0aeb21482a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/createOrFindPlace.js\":\"c8fddd39ed9bd5ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/currentLocation.js\":\"2e5becb10a5ca2ab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/dataExtension.js\":\"e2fc14349a45551d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/geoContentDecorator.js\":\"6f58d68006940116\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/googlePlacesClient.js\":\"703ec95cf854261b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/index.js\":\"0a9e33bbe1be5d02\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/locationsPage.js\":\"8119782765b23d1d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/mapViewport.js\":\"35df739dc28bfcb1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/pickCurrentLocation.js\":\"e5f4bafcbd27e17b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeAutocomplete.js\":\"07b8cafba2fbf6bd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeNameCollision.js\":\"e0365ddc7f764ef1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/properties.js\":\"5323ee0e4864d5a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/propertyEditorOverrides.js\":\"86c69be3991b92ab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/query.js\":\"dd69fe33fbbbce76\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/usePlaceSearch.js\":\"89558ec5ae3a1d7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"48329ce590e2fe4e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"24ce9c7008a74b7c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d0c9f128fd7cd5db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/config.js\":\"1aad5580168f8494\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/dataExtension.js\":\"c2d77f2bfec24148\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/facet.js\":\"b11e04a9528002d6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/grouping.js\":\"d2f94afc68e1fda2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/index.js\":\"0e87dad37dbdf5f3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1a574fabadcb2e9c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/query.js\":\"ac5ecdcf986b1161\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/resolveConfig.js\":\"112974e49ebb40ec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"794a2ee48ffdc541\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1f1cf9886030a899\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlDocumentContent.js\":\"3073b7f3fbdc9c5b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlFrame.js\":\"3b3fb830b33fd213\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/actions.js\":\"1e7d6c0e2c5d50eb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/blockType.js\":\"4d04271fcdb6782f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/confirmRunScripts.js\":\"b60b8197c225dddf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/dataExtension.js\":\"37cd1f170533538b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameAnnotations.js\":\"c5e116a7be7ce200\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameDocument.js\":\"dbb91741d4c69f3a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameTheme.js\":\"ad5437628050822d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/index.js\":\"ae9d2694ce9c9551\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/scriptConsent.js\":\"ca879ff83887d523\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/sourceMap.js\":\"1bc9f31c69484876\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/useDocumentScripts.js\":\"8cfeb47833726417\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/index.js\":\"f2c1a259e4e50ccc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/record.js\":\"c074edd2d64c6c7a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/recordStore.js\":\"f27e78db60ee5b24\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/responsiveness.js\":\"25fe180a8ff402ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/schedule.js\":\"22e791c1f5837d13\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/sessionContext.js\":\"a055b284c43436b9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"bd216080df637f80\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"174113d01cc947ce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/actions.js\":\"d828af54e7f09957\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/config.js\":\"d8e9006e7553b0e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/dataExtension.js\":\"a1f37b2a52a8265d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/effect.js\":\"118e649f5432327b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/index.js\":\"ce13cc7f259f4201\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/keyCapture.js\":\"09bf68e83d2141dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/overrideStore.js\":\"01da4f85f954b7d2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d3cb4cf86e0a1879\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/HeaderItem.js\":\"ac12b1e737e88c8d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/LeftSidebar.js\":\"21acfd9eb0b98221\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/actions.js\":\"699c5aec6ff25a52\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/facet.js\":\"853efa7eb2dc7329\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/index.js\":\"bf8861205f0198f5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/shortcuts.js\":\"801dcab700dd2a5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/toggleStore.js\":\"a29ee19d91ffc686\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/MergePicker.js\":\"66590faa4f00d17b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/index.js\":\"6a0cf878e2d5899b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/mergeAction.js\":\"648f9629e874d873\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/strategy.js\":\"2a57516e5320eca8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/Button.js\":\"33b1f6ec72622b54\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"4d96396ddb806431\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/defaultItems.js\":\"dbec85cb175acabf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/facet.js\":\"3f9d213566bd3ac9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/index.js\":\"7330deef9ee14ee4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0ae8feb6fb1454c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/actions.js\":\"de8adfa3e864c949\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b45f6d2e6123f085\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/facet.js\":\"861d57ac8a349aa7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/index.js\":\"312b8709695694e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9a2b6d36a1019a04\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/blockSubtreeMembership.js\":\"cbe8d061a28407f2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/contextMenuItem.js\":\"b4b600646354c66e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/index.js\":\"ac9755cf26504640\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveAction.js\":\"da51da5f4606b65e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveBlocks.js\":\"95a36436637a64bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/selectionAfterMove.js\":\"1b0de3a2fc414e55\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/TutorialBanner.js\":\"57ac792d2585b0b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/action.js\":\"ee0e508fe1de16bd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/bannerDismissal.js\":\"d5717aa78b3d557c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/documents/cheatSheet.js\":\"82f409322aae2b32\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/index.js\":\"3de7ce768c707994\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/keys.js\":\"6b8398066fe2cb5e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/landing.js\":\"db931135b3bb010f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/outline.js\":\"1d7740ed211de3f7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/seed.js\":\"5151475a51106260\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/PerfTrendDialog.js\":\"54824b1655d2bda7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/analyze.js\":\"1611ab131ce22580\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/diagnosticsSource.js\":\"af2edff0b48dcdd8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/index.js\":\"0fadd00888563baf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/load.js\":\"4b14fcdf4bc2c111\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/monitorRun.js\":\"0285edb6d45ffdef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/schedule.js\":\"24ce8189944e5b29\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/series.js\":\"bd278cc787d88390\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/store.js\":\"703ad2378c67140e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/trendAction.js\":\"492986e8ef533ada\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/verdict.js\":\"5bc85cc48d852baf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/clickToEditAction.js\":\"de207383d130b1d8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/index.js\":\"f97e68ab360c75a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/interactions.js\":\"39d67c6cee5f9105\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ce9e38de87a80a7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGate.js\":\"9d362b3e0b14cb3b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGateDialog.js\":\"1d2292057cb60d30\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/action.js\":\"6492e3af8fdcc0c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/index.js\":\"27c0f45de89b3b4a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/localRunMessage.js\":\"58423a1ab6a8792e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/plugin.js\":\"4b5240431eeb9d7d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/progressReport.js\":\"8fe1a5e118c86a4c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/sweepProgress.js\":\"258ea24827756799\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/FieldRowRenderer.js\":\"4218548d8422eb48\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/ValueRowRenderer.js\":\"9a7fff5d5c250fb3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/actions.js\":\"ca78f1512731fe60\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/autocomplete.js\":\"4ed4e57411f85685\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/fieldRow.js\":\"c4542fa4cb9a5c2d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/index.js\":\"d5938e1d90b8057d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/referenceWarning.js\":\"9c483880a3a73ebd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueAutocomplete.js\":\"181dd22c6646d356\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueSchema.js\":\"cff675002c1a2238\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/HeaderItem.js\":\"00e557398de5e2b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/QuickFind.js\":\"d7c3eb91cac91b4b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/index.js\":\"15afe8f9dc5010e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/recents.js\":\"746bf176f73b101c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/resultItems.js\":\"2bbe2c1444fcee48\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/selection.js\":\"c99c1e094c9c1f57\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/toggleStore.js\":\"bfb61cdc4db32829\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/HeaderItem.js\":\"00082c011107c322\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5904e68638b55a91\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/grouping.js\":\"a5799a0c1462cb1d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/index.js\":\"72acca7e74bf4d9a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/target.js\":\"a551d65beaf7ac83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/codeMirrorExtensions.js\":\"95e6d6841078557f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/contentPrefill.js\":\"1cfe8294fe86065b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/dataExtension.js\":\"0494e3713e76a9ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/index.js\":\"c4d9dafe516f2d75\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8bfb46d24031f15a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/invalidation.js\":\"0e6521073a210692\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/localSchema.js\":\"07527056085da533\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/index.js\":\"adfafe96b303b90f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1bebbd200079a9fb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/index.js\":\"10ad8fcc3ce00b93\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/referenceNode.js\":\"681d3a2fed273f24\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/remark-reference-occurrences.js\":\"88c27023b0a2983a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b51a65e3cc10e520\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/index.js\":\"e109861f72c670b4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ca12b1fad7bec384\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"85fb67e4533e240d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/mergeRetargetProcessor.js\":\"7df71162dd468ea8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/parseFence.js\":\"b6d1464c3a8a50a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceParser.js\":\"5cfff852300d31ec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceProjection.js\":\"d3993539d5adc1e0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referencesProcessor.js\":\"2cd3c314afd09377\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/renameProcessor.js\":\"8b71a3ebccdc0ae3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/spanReplacement.js\":\"eae312397662d229\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/htmlToOutline.js\":\"f0126736921d1038\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/index.js\":\"eb410152aaae5df5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/normalizeClipboardDom.js\":\"372f75a9f26bc306\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/pasteDecision.js\":\"fb57c66f6175211c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/action.js\":\"33f9e92db41704cd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/blockIds.js\":\"68ba1457e0a2ee9c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/content.js\":\"1dff08d2d8de1593\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/effect.js\":\"240a77ea14ff497c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/ids.js\":\"7ebdf99c30e6be9d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/import.js\":\"ecf8adc8e3e0a16a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/index.js\":\"b6a62543f678bbe8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plan.js\":\"810f6c5e8fb80a5c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plugin.js\":\"a9a29caa5d901e43\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/promotion.js\":\"9f13b5c34a7f1d1f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/properties.js\":\"dfb4898d4f61b72c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/references.js\":\"0eee6e5b1edd7c2d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/report.js\":\"4b54e187369c5029\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/roamMemo.js\":\"f888fde5e709f4a5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/runtime.js\":\"0822b4f5750920bc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/schemaReconciliation.js\":\"7a3402bb3cd7022f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/srsMarkers.js\":\"3bfdb30e2ba7a57b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/todo.js\":\"cf6bc9e6cecea87e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/typeCandidates.js\":\"592ecece3cc00c5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/types.js\":\"8b59e446d702ce62\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/index.js\":\"a6d542688c17f840\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/store.js\":\"20101393c81331ac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/HeaderItem.js\":\"7cd5761a1b528d05\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2ff274d8f7ec8059\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/index.js\":\"f06211344aaac32f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/model.js\":\"edc8561eaad8a449\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/toggleStore.js\":\"e93d7a9e2728586d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/useKeyInspector.js\":\"5d07741c2994286a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4ae9f1f88ed98356\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/ShellDecorator.js\":\"fc8049dacf53bfb8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/actions.js\":\"7a0052fdeec99d6e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ed4a71ec9acb2104\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/index.js\":\"c02c2a403eac4fe8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/shell.js\":\"1e48ddd94ff944fd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/surface.js\":\"abb261033454b2f3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/walker.js\":\"f425d1fe2282fa36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f8c123abe5f32139\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/dataExtension.js\":\"ebce0c4c05801a28\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/index.js\":\"2dec22a4c49ff98c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/indicator.js\":\"7bd6b9adc52554ca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/moveSrsState.js\":\"ec9a07fb4aad4f55\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d3e76c2a681cfa45\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/scheduler.js\":\"b7a05e6fb7f782a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/schema.js\":\"001a0c4d8a2ca044\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"1af7035c2fd9750f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsClipboard.js\":\"4308575c8e832b4b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5f8bc2350f5b9fd1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DailyNoteReviewHint.js\":\"fd034763c6332a3d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DeckPicker.js\":\"b5255f6f17880c6e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewControls.js\":\"9adab169e07a7d57\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewDeckRenderer.js\":\"53742e703385eefa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewSession.js\":\"dbb602de4a32048b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/actions.js\":\"7fd4dff5dcbfa631\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/archive.js\":\"f7d0cddc1d95534f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dataExtension.js\":\"0b5ba5d6e6466000\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/deck.js\":\"336a1af87b227b38\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dueQuery.js\":\"c1a562ae13e65af9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/gradeDecision.js\":\"bcfe7de42f3806e4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/index.js\":\"7a58c80e4a66c4c6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/keyHints.js\":\"4635db3a5f239856\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewCardLayout.js\":\"c69457a5c52c44cc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewProgress.js\":\"e75775ae5eb53e6c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/schema.js\":\"40f03b9f3d263014\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/useDueCards.js\":\"073c7f6ff88f2956\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/index.js\":\"f174001fc2ddb6fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/record.js\":\"2be6809338f556e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/index.js\":\"e6e719f26b4700d1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/persistenceStatus.js\":\"1671ad6cc431e74b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/requestAction.js\":\"2bdb2a16c9898668\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/TypeChipsDecorator.js\":\"5576fb317cc0c0dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/codeMirrorExtensions.js\":\"014b01b01a13c571\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/index.js\":\"ca339b6dc55eb163\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/typeAutocomplete.js\":\"01a018fb46240a59\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d412de6ad740c1b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/actions.js\":\"b9f5c27997192b3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/anchor.js\":\"2ea596eea0ce7ec3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/events.js\":\"38bfd391eede30a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/gestureActions.js\":\"ad28d1cf00d0e42d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/index.js\":\"327ff8c4d3593713\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8a5e48052b14f7d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/collect.js\":\"83093eb49be50b46\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/index.js\":\"067e04315ad1d3bd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/record.js\":\"821ed9ad0a468882\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/RejectionDialog.js\":\"23771d9860019578\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/SystemStatusHeaderItem.js\":\"53beed429e483a30\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/index.js\":\"d7de9017982eb6b4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/model.js\":\"f82374232e88175e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/queueCounts.js\":\"f6d1e9a9af0824db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rejectedHelpers.js\":\"ff107fe78270e55a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rematerializeAction.js\":\"683db6d5fdc79bde\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/useHysteresis.js\":\"11510ed7b0268472\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/ColumnHeaders.js\":\"606367d20631af0e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/TableLayout.js\":\"68dcdcadaf57452c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/actions.js\":\"73d61ce9935763e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/cellEdits.js\":\"e8f9983cabc5e911\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/columns.js\":\"5a8930e48ad02109\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/controller.js\":\"a0db695f8c017e83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/convert.js\":\"9b0e0fb7b8722bb3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/dataExtension.js\":\"76d58c0d4b0817dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/index.js\":\"f5ba2cca5cc585d7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/keys.js\":\"25b23f7d3fd222ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/model.js\":\"82dc5861572f1c5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/format.js\":\"a45e9ee0a62b5345\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/parse.js\":\"9568f106ebedceb0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/registry.js\":\"d65bd458ac264e36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/schema.js\":\"db26d539d7bf22c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/effect.js\":\"6f304beb3c657dbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/index.js\":\"41b4a0dddf5c6541\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/theme.js\":\"95929c05b81639f9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/actions.js\":\"39aa3714877b0205\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/dataExtension.js\":\"3c3ecea1deb55c83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/index.js\":\"295d973678a24e92\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/schema.js\":\"1ef6642c34297cc9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8b0d952c6667222c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/actions.js\":\"0bd3ccfdd0039323\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/defaultItems.js\":\"14d26ec4944aed41\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/facet.js\":\"982371d32f951c28\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/holdRecognizer.js\":\"6f0c8b9c70be9428\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/index.js\":\"94d428b1ef4afa94\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/UpdateIndicator.js\":\"5ad23ec393bd5efa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/index.js\":\"559c66ae5cd846ec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/loadTimes.js\":\"ae49f4ccef3374e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoNotesRenderer.js\":\"f20731eeceb115c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoPlayerRenderer.js\":\"275533e3adec0812\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoTimeStamp.js\":\"b896391f2d58c123\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/actions.js\":\"0ca80f0ab4681e37\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/index.js\":\"d3b9b773f06e9c4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/markdown.js\":\"1f4fa526a1a1499a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/notes.js\":\"daea94b987e6bb76\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/registry.js\":\"33ff1992c1751bd0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/remark-timestamps.js\":\"c86ccd76379fb3a5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/view.js\":\"0d5aa7095b405019\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/LinkHints.js\":\"3ac6d0e44a93e5ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/index.js\":\"5c5f15fa94f5de2a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/model.js\":\"8bf77ce7e6fdaaa3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/settings.js\":\"225d422b9644f641\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/actions.js\":\"d9d59f731ac3420f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/index.js\":\"2aaa86c3b1daa8f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/interactions.js\":\"9a26e1d728db8e60\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/workspace-header/index.js\":\"f4b02ee5d4803307\",\"/knowledge-medium/pr-preview/pr-1835/src/registerServiceWorker.js\":\"41ac53798db0fc13\",\"/knowledge-medium/pr-preview/pr-1835/src/requestPersistentStorage.js\":\"83872c1e9425703f\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authRequestDeadline.js\":\"37108dbe8e29d9a5\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authStorage.js\":\"ef80fc5c56020bcf\",\"/knowledge-medium/pr-preview/pr-1835/src/services/powersync.js\":\"101054ec57632474\",\"/knowledge-medium/pr-preview/pr-1835/src/services/supabase.js\":\"4e69c25320e27841\",\"/knowledge-medium/pr-preview/pr-1835/src/services/uploadErrorClassifier.js\":\"fadd2834d376d07a\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/ActiveContexts.js\":\"25568bc5d2f27cd1\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/HotkeyReconciler.js\":\"5d206eae3d1b44f3\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/WipeLocalDataDialog.js\":\"1f20b57d714a3fd4\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionDispatch.js\":\"a28035788f67d2bc\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionRefItems.js\":\"8bbe9dffe08d70b7\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/applyKeybindingOverrides.js\":\"f6d7fffd9b4a80f9\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/blockActions.js\":\"70fc150fd299d4cc\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/canonicalizeChord.js\":\"e0adf990d6127ca6\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultContexts.js\":\"eb3580f63098b379\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultShortcuts.js\":\"c3c11c4d9a1d956f\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/effectiveActions.js\":\"6c51a69afe607890\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureAction.js\":\"56a8eff07d26c136\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureBinding.js\":\"8b0edf052db487e8\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/holdRegistry.js\":\"f51166cf4ae2c44b\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingConflicts.js\":\"49a2a7c31fc6d052\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingOverrides.js\":\"d7de40720a267476\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/pointerAction.js\":\"3dcfbfd8d29c3f88\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/resolve.js\":\"c71b06cab771a879\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/runAction.js\":\"2411052ad4581d41\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/sequenceMatcher.js\":\"cf501da100b8d7aa\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/types.js\":\"02f1d0f546c2f836\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionContext.js\":\"42d09ed5d20a68d4\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionDiscovery.js\":\"867a58c5c56ed0c1\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/utils.js\":\"1fd983cfcac068b3\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/bootStore.js\":\"18bddbd6bb2abd24\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/previewDatabases.js\":\"2af7844c2d71d6d2\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/byteTransform.js\":\"1a75bf464fcdfd89\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/attachmentCleaner.js\":\"703f1263e8b3e6bb\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/attachmentParts.js\":\"b7990c3d735c8ede\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleParts.js\":\"64c7b91b6c0387b8\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleRecord.js\":\"b1f1ff9a609c28d9\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/manifest.js\":\"c2ea6ffd8d67dfe0\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/takeBundle.js\":\"94180e2a4b2a1d64\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/verifyBundle.js\":\"a7e74ef7d9d92f09\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/cleaningStage.js\":\"762e8be03864fbe5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionKey.js\":\"a30bdbde2d195242\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionServer.js\":\"3121dc3b9dda8d41\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flip.js\":\"c0cb6e2ffdfc3c55\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flipAttempts.js\":\"47ed020e3668c019\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/pages.js\":\"578fdf27d6399bed\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/preflight.js\":\"d14090e0faebdb3a\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/reseal.js\":\"3713f96e6c19d3aa\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runConversion.js\":\"daac45b979111967\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runLock.js\":\"c970ee690e6c639d\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealing.js\":\"9d5b7f6a45337d12\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealingStage.js\":\"5608ec7c3eb5c3a8\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/stage.js\":\"05471965fdd588c5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/verifyReseal.js\":\"76852c2bdcfb82ba\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aad.js\":\"266ae4b265eea340\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aead.js\":\"3b4ac88e8067c5de\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base32.js\":\"0a858e712fe9bf0d\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base64url.js\":\"fb80939defb265cc\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/binaryEnvelope.js\":\"94af695b8c42bdcd\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/byteAead.js\":\"e2045e317d16ae60\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/canary.js\":\"c8e7d118fc443dd9\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentHash.js\":\"67d47ca4493bed8f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentKey.js\":\"df63eec8fdcdc1d8\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/derivedIdNamespace.js\":\"70aa448408a79a8b\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/envelope.js\":\"0bc735e5c3da80ea\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/hex.js\":\"436e101f3eeb0f78\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/sha256Hex.js\":\"a0fbf88cdd50f0d4\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/workspaceKey.js\":\"12e002b80a9789ad\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/conversionState.js\":\"31940797cd077965\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/createEncryptedWorkspace.js\":\"8bf8e177e9cb39bb\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/pastedKey.js\":\"3c2d623c50a2462c\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a6de5ce20ab50cf5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/upgradeWorkspacePin.js\":\"cccb0830549c4ef5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/keyStore.js\":\"a493be740f487158\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/mintWorkspaceKey.js\":\"4f9f5a862a7b1593\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/modePin.js\":\"95cabbfe6be359d6\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/openWorkspaceKeys.js\":\"8fd64799286398f1\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolveWorkspaceEntry.js\":\"4e52a4172043a337\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolver.js\":\"e788e93435c47133\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/workspaceAccess.js\":\"2514c85100e77d81\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/transform.js\":\"c65dad5b90550e50\",\"/knowledge-medium/pr-preview/pr-1835/src/themeBootDefaults.js\":\"60648cda2eed3088\",\"/knowledge-medium/pr-preview/pr-1835/src/types.js\":\"1aaa923b646d02bc\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/ClientLocalSettings.js\":\"18fada749b57416e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/abortableSleep.js\":\"597576330d8117d8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/array.js\":\"ce4f230cc54972d4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/backlinkAutocomplete.js\":\"3410753d676e75be\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockCrumbs.js\":\"4b4da2f099a9e18b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockrefAutocomplete.js\":\"7ab89d29a2bdb526\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/cadencedIdleJob.js\":\"d6a6eaafafd2025a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/callbackSet.js\":\"ec6a071526698093\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/clientId.js\":\"a3dc40748fd3e0dd\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirror.js\":\"2d35a040e43d7855\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirrorCompletion.js\":\"5ac6973379e2743e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/copy.js\":\"3da17ddd56325a48\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dailyPage.js\":\"9305d845844a17c2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensics.js\":\"7d3b9887499ef6c4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensicsHooks.js\":\"f6934e453c7a717d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/deleteBlockThroughUi.js\":\"258b83c2094254d2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dialogs.js\":\"ecff291f4f2f504f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dom.js\":\"3b4bb51f2a2af1ba\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/downloadBlob.js\":\"7ef0f8ec48e72d31\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/exportSqliteDb.js\":\"f87ff02066fbfb1d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fileSystemAccess.js\":\"e02524c9d9611ac0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/flipSlide.js\":\"d3b3662967ff641c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fnv1a.js\":\"0990cfaadb581387\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/formatBytes.js\":\"4b113c73edfe50c1\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fuzzyRank.js\":\"aa700f316a2c07ba\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idbKeyedStore.js\":\"12ea58717296a753\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idleCallbackPolyfill.js\":\"da87e885b59053fc\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardAwareScroll.js\":\"eb13983d9bd1703f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardViewport.js\":\"160ffa25b81a0bfd\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/lastWorkspace.js\":\"3a376b38cd5c9021\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutColumns.js\":\"2fd7b731407f081f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionDom.js\":\"43be2b412438541e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionId.js\":\"f2793a64eb1e97c4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkClickGestures.js\":\"5088a4847c58e306\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkTargetAutocomplete.js\":\"76dce5747bcb916c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbCorruption.js\":\"ed55529d84a7f78b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbRecovery.js\":\"6255b7e4f26c32fa\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/markdownParser.js\":\"6ac947ea65252111\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/memoize.js\":\"ec3c2f50c2b1aa66\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameFieldCommit.js\":\"246098f61d5fa859\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameList.js\":\"96a1c071fcebecaa\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/navigation.js\":\"fbf859eb23a1e497\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/omnilinerNamespace.js\":\"fa2c25bffe147703\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/opfsPageScan.js\":\"9a05c11ccc6bd12f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelClearance.js\":\"802d68779f0fe5c6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelHistory.js\":\"7d2b0832035bb97a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLanes.js\":\"f2626b9f89d6b541\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLayoutProjection.js\":\"fd493d202aae9a7f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelScrollAnchor.js\":\"d205cc11083c687a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelUrlFlags.js\":\"7952d235f5e90a28\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/platform.js\":\"6d2d2032fc5ed883\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/pluralize.js\":\"a7e18d3857e3543d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyCreation.js\":\"e6f7244f260fe790\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyNavigation.js\":\"42d1f494ec6ffb4a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyValueContext.js\":\"ab0f742186f88afa\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/react.js\":\"2b76b30788d9eccf\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeDate.js\":\"467adc8b2ecbfae7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeTime.js\":\"3b0726395646f459\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/renderScope.js\":\"50b97c7ba79cbac6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/resolvedThenable.js\":\"5204a3be111d8aab\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/routing.js\":\"c920fe8f82c76a35\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/safeMode.js\":\"a790573ab7cbd05c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/scheduleIdle.js\":\"26428f78f01a2c60\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/screenWakeLock.js\":\"7717b24ddc13d231\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/selection.js\":\"117393b713305fc6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/softKeyboardGrab.js\":\"fc3759ec845de315\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/startupTimeline.js\":\"5f7e96a55c0be559\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/state.js\":\"55299a325b2ba5ea\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/string.js\":\"26a55d9a91d46e62\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/surfaceZoom.js\":\"59edcef9de0b9720\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/time.js\":\"c542ec29a1d3da25\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toast.js\":\"556df1f6c4702679\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toggleStore.js\":\"8874f71fa92d3a75\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/untilStopped.js\":\"214991278297acd5\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/userActivity.js\":\"72e5405a1bd39832\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewTransition.js\":\"e80e4c4a4523cfa6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewport.js\":\"9d877ce545389591\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/webLock.js\":\"3a2c0fbae9810d09\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceRecovery.js\":\"d90dc4dbb61fcccb\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceSnapshotStore.js\":\"530827fc959c367c\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-compiler-runtime.js\":\"11efa58315091bc0\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-client.js\":\"f217bb7f68463019\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server-edge.js\":\"6a3d22e41801d6f7\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server.js\":\"6e76e560d49f2ba9\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static-edge.js\":\"7e78dc5979e1ef1d\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static.js\":\"cef60c0632a6596a\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-test-utils.js\":\"7c53cd028d24a8d2\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom.js\":\"15a92c2ee0e3fbb6\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-runtime.js\":\"dca6965dcbcd46d8\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react.js\":\"cb6c17dff3caa3a0\",\"/knowledge-medium/pr-preview/pr-1835/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
