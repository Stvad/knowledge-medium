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
		buildId: "996f565f0bcc-c6157ce3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/\":\"a9e95c3a94a3bcdb\",\"/knowledge-medium/pr-preview/pr-1835/index.html\":\"a9e95c3a94a3bcdb\",\"/knowledge-medium/pr-preview/pr-1835/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1835/assets/FacadeVFS-BoZeKy0e.js\":\"5fccdc39e3e9d0d2\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSCoopSyncVFS-C554CYtm.js\":\"89d0cdd720b1e1c8\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSWriteAheadVFS-D-ARDwTp.js\":\"111b65c452559013\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CfFcOy3a.js\":\"ccb0717c96dc86f3\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-ecAwXFSi.js\":\"36e79fd0a2bc2403\",\"/knowledge-medium/pr-preview/pr-1835/assets/worker-BVuoIuZy.js\":\"442140cd1ac040b4\",\"/knowledge-medium/pr-preview/pr-1835/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1835/chunks/app-DRS2ZlKP.js\":\"892ee955c29de586\",\"/knowledge-medium/pr-preview/pr-1835/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1835/index.js\":\"9dae5a8b7df340ed\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1835/assets/AccessHandlePoolVFS-BJe-RLwr.js\":\"acbe336f23eaac43\",\"/knowledge-medium/pr-preview/pr-1835/assets/IDBBatchAtomicVFS-DdaWcIgF.js\":\"7d3c7ee66c8bb727\",\"/knowledge-medium/pr-preview/pr-1835/assets/MemoryVFS-CduzpJx0.js\":\"c354dfd2ef37f7b1\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Q_Tx3yzG.js\":\"8a033b0c1634f22b\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-D1J0A38Y.js\":\"0bcebdc41467f094\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1835/chunks/AccessHandlePoolVFS-DCmwgJpE.js\":\"84d21805e9bc2f9c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/FacadeVFS-BPuvCSsB.js\":\"8cf0a4dc9d48a29d\",\"/knowledge-medium/pr-preview/pr-1835/chunks/IDBBatchAtomicVFS-CWzWdfXN.js\":\"bd251b1f8f98111e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/MemoryVFS-Du88GgXG.js\":\"dc0b57d88ba27134\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSCoopSyncVFS-DMDoJbb-.js\":\"ccd18acbd2b73bca\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSWriteAheadVFS-4YAwEqQN.js\":\"6847dcf40fe5d1b1\",\"/knowledge-medium/pr-preview/pr-1835/chunks/Preview-CQTsQ2Gf.js\":\"fcb9471a782ba5f5\",\"/knowledge-medium/pr-preview/pr-1835/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/card-CvQIF2HN.js\":\"3eecaffede7a899f\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-8QGX9nIv.js\":\"26ccd6963831533a\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-async-B9hR_7Lk.js\":\"bbd850c55cebc0df\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-cAgv7Ezj.js\":\"3a0d779a46aa8844\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-B-ALbPq_.js\":\"08f3614f9c691fc0\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-B9_QbEQh.js\":\"12c22f615c98c54a\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-Bm4NSuqk.js\":\"1a84f393a01374e0\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-BtrOn4mL.js\":\"989c8e652051453c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-C7W_sHw1.js\":\"707af6c53eb05fa4\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CHMCQfOD.js\":\"1cc1f6f21cac555d\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CXGx4eB1.js\":\"cdd5961f2477c432\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-DeQ0bmtD.js\":\"63b2de9a01ea1bbd\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server-legacy.browser.production-ID4xLsPO.js\":\"2cde90e4a4a95ef9\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.browser.production-BDDZ-X3t.js\":\"113c14ca022b4ed0\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.edge.production-DwqtBW0Z.js\":\"998e4787f84c303e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/server.browser-WG3D70mk.js\":\"8e58e744f1ebd2f6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/textarea-DFoELU0_.js\":\"fdba556599c7ad08\",\"/knowledge-medium/pr-preview/pr-1835/chunks/ui-CLFu0s9k.js\":\"aedc67022db3f977\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite--mV--lEA.js\":\"338ae570feb00b83\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite-async-BSfHuVYl.js\":\"63adf8c77ad564c6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1835/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/src/App.js\":\"1c878b005bd78c5c\",\"/knowledge-medium/pr-preview/pr-1835/src/appUpdate.js\":\"6396186b436f2c55\",\"/knowledge-medium/pr-preview/pr-1835/src/appVersion.js\":\"1d4ab7536969f12f\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/initialLayout.js\":\"0e3668135f390c63\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/openWorkspaceData.js\":\"ef9cdb702ecf2cff\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/resolveWorkspace.js\":\"f102355bc3585ca1\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/workspaceBootstrap.js\":\"f1e7ed7f9b612f53\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockComponent.js\":\"d66a76f702211b4b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockCrumbs.js\":\"50c35d4761410805\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockEditor.js\":\"0c3a81c8bcf3d28f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockLoadingPlaceholder.js\":\"2944e71f427cf591\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockProperties.js\":\"214985d5a35f1a38\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockSearchPicker.js\":\"359f0009ef487864\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ConfirmBulkDeleteDialog.js\":\"465dd901c1085692\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DividerHandle.js\":\"ea9b4295049c400f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DraftEditor.js\":\"8cb28ff02fb609ab\",\"/knowledge-medium/pr-preview/pr-1835/src/components/GutterPill.js\":\"177bc2f05db01fd2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Header.js\":\"42420eae508cbf4b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/LazyBlockComponent.js\":\"45e16701d8696ef5\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Login.js\":\"966a96e40c9b61c6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ZoomableSurface.js\":\"a27a5efbcd35df8e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/editModeKeepalive.js\":\"141a438f8006872b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyDisplay/PropertyDisplayScope.js\":\"373a996e18fcabae\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"05f6472909264227\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefPropertyEditor.js\":\"e07b289fb597279b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefTargetTypePicker.js\":\"0a6ccfd6858c40c9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/SelectPropertyEditor.js\":\"050e613e5cba0919\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/TypesPropertyEditor.js\":\"1f52125b0bd03396\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/defaults.js\":\"b061dc362c11b265\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/kernelValuePresets.js\":\"7744f94b0cdc20aa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/selectablePresets.js\":\"e4ac554474d040f2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/typesPropertyUi.js\":\"7492f760c7da7ac3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/AddPropertyForm.js\":\"acd47131f0c94f08\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyPicker.js\":\"8a43cbb1ab706a3c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyRow.js\":\"549dd042c8e48045\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/Rows.js\":\"800bf3377d6017ba\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/actions.js\":\"629bb531fa1b3d41\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/declarationOnly.js\":\"0892a7862cf1744d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/layout.js\":\"36fb363f2538d3fc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/model.js\":\"c250a870d5d18874\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapeUi.js\":\"069560c94689148b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapes.js\":\"e5b58c35d84633d9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d0fbf85bbf747593\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/visibility.js\":\"bf84bcd10d2bd41e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanelSections.js\":\"997d3ab75cec7674\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockEmbed.js\":\"295db719f8824756\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockLink.js\":\"334bbacca829ba1a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockRef.js\":\"c92fa7278d79a62b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/ReferenceLink.js\":\"ddcbf202f0777ba1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuard.js\":\"2126c00d62a3993e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuardContext.js\":\"842cb14b95e04be4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/linkInteraction.js\":\"96cabd1faf40ea29\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/referenceLayout.js\":\"25658806958f58de\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/useBlockRefAncestors.js\":\"e93d3b86aee604eb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockGutter.js\":\"99a3ba154552ac8d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockInfoDialog.js\":\"30a13fd1d647de42\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockTypeBlockRenderer.js\":\"07309532c65491db\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BulletHoverCard.js\":\"6057f82e64e11466\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorContentRenderer.js\":\"0c458f5dc5857c0c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ec8ac547a73c0909\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ColumnResizeHandles.js\":\"c5af8af797cce5dc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0e8ef15c35b60988\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/DefaultBlockRenderer.js\":\"3e2b2a03a840d939\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/LayoutRenderer.js\":\"ae79950aa53bb32d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MarkdownContentRenderer.js\":\"ce67b5a237299cd4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MissingDataRenderer.js\":\"e0d7175d90351b25\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PanelRenderer.js\":\"d48a3cd223588b31\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PropertySchemaBlockRenderer.js\":\"065559a12070d8ad\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/TopLevelRenderer.js\":\"a57859394b5d1aa0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockGutterMode.js\":\"5f98f58ebe3abfcc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockTitleText.js\":\"7e0fd0f5cb65b8ce\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/fieldCreationKeydown.js\":\"1fbe002dbac48f44\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/layoutRootContext.js\":\"c64545cb24bb4bae\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/TypeChip.js\":\"bd2573f9ac2eb8cf\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/chipStyle.js\":\"135efd7f34fd350c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/anchored-floating.js\":\"ab5ead95d0c381ef\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/button.js\":\"97d0a728650ccf84\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/card.js\":\"2ebeea8448ca21bf\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/checkbox.js\":\"e881d077a3d8d43b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/collapsible.js\":\"505bdc8be339e9f0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/command.js\":\"0df521a3791b0936\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/context-menu.js\":\"7024c65ef672f852\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dialog.js\":\"c067d190dcdc73b0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dropdown-menu.js\":\"f2c3633b08a04058\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/floating-listbox.js\":\"b7eeba49aaea686f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/index.js\":\"eb907e895b874380\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/input.js\":\"82b4b69be4d66062\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/kbd.js\":\"59b4c72dc4de451a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/label.js\":\"6069963358746db9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/textarea.js\":\"84203ea62acb3edf\",\"/knowledge-medium/pr-preview/pr-1835/src/components/useEditModeYieldKeepalive.js\":\"7fbf0785cbe7b501\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/BootFallback.js\":\"38a1c0dc132f0096\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/FocusedRowLazyMount.js\":\"a261ec3b314f4fde\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LazyViewportMount.js\":\"8ae6fc7c33ebbf91\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LocalDbCorruptionFallback.js\":\"00f40a0b6eede59d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/error.js\":\"216d314b6d6b90ae\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/lazyMountRegistry.js\":\"cce36adfccfb4b8e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/suspense.js\":\"04b10ef6b76d4595\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/CreateWorkspaceDialog.js\":\"44850365004304ae\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/PendingInvitations.js\":\"af0a382acdb992d6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/SyncProgress.js\":\"01c0a657c1c460fc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/UnlockProgress.js\":\"a8e807117ae7b401\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceKeyGate.js\":\"243209d0ba357ab6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSettingsDialog.js\":\"fa08759ff4321533\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSwitcher.js\":\"cab7c3c737c44902\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSyncGate.js\":\"5b641c5fbe3eb91e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlow.js\":\"0121fdeb44c9d418\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlowHost.js\":\"993e0f50bfeac488\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/EncryptionSection.js\":\"8dc7e3be2f8972d3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/attachmentPrompts.js\":\"06b4fa6611604c72\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6756c7bc7c2b69fb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowDeps.js\":\"0108fd2d4b262c81\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowStore.js\":\"ca9d5b5bef0cc567\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/flowUi.js\":\"e69270920367d1fe\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/useConversionRun.js\":\"a75529da696cb5ef\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/keyUi.js\":\"88fab5fde916480a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnKeyLoss.js\":\"30dcac1ad9e0ea0a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnServerE2ee.js\":\"5f9c668f6a040a3a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/workspaceUnlocked.js\":\"8297d2361b807ee7\",\"/knowledge-medium/pr-preview/pr-1835/src/context/backgroundSubtree.js\":\"c0d2203353811afb\",\"/knowledge-medium/pr-preview/pr-1835/src/context/block.js\":\"8be229af79fed6ee\",\"/knowledge-medium/pr-preview/pr-1835/src/context/layoutWsContext.js\":\"4fbe4b462ed48ebc\",\"/knowledge-medium/pr-preview/pr-1835/src/context/propertyDisplay.js\":\"49b81bcb7f411925\",\"/knowledge-medium/pr-preview/pr-1835/src/context/repo.js\":\"c09088993467b6b3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasClaim.js\":\"8cbf7ab5a1311cd0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasSeatNamespace.js\":\"32883087122c6352\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockData.js\":\"8187854ea7bcc5c8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockType.js\":\"4f16afe3e1d734e4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/changeScope.js\":\"4edb79288092604e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/codecs.js\":\"64375ff7d53539b6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/derivedData.js\":\"3eb3e9991bff6913\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/errors.js\":\"e850363f88b482c3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/events.js\":\"2ea640d91b42f36a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/handle.js\":\"4b96c1c91e29967e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/index.js\":\"45ce4c2c646e854c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/mutator.js\":\"a35eaf028a438227\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/processor.js\":\"2aabc0379664b13c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/propertySchema.js\":\"fad86428084cfa78\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/query.js\":\"02d29eba9768eb6e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/sameTxProcessor.js\":\"6e7d05cc4d73d921\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/schema.js\":\"4b96c1c91e29967e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/tx.js\":\"4b96c1c91e29967e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/typedBlockQuery.js\":\"f86ace9b701d453a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/user.js\":\"243143ff0abda9a2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresetCore.js\":\"120baf865f71c345\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresets.js\":\"0384e89ce5d9dcc0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/attachmentCleanerIOVerb.js\":\"81614bbbfa012aac\",\"/knowledge-medium/pr-preview/pr-1835/src/data/block.js\":\"a96083378d8e7ca9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockCache.js\":\"dcb648de297e1194\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockId.js\":\"7ed345d7e09c57c7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockLiveness.js\":\"e38e6cac2c3d56e1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockMerge.js\":\"c8b133c91bf36367\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockSchema.js\":\"3aae6658e7b367e9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypeLookup.js\":\"cfc7ad0c88b33ab9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypes.js\":\"b8c0c6f304721b21\",\"/knowledge-medium/pr-preview/pr-1835/src/data/clientContext.js\":\"b4882230dc62e909\",\"/knowledge-medium/pr-preview/pr-1835/src/data/dbFileSiblings.js\":\"b1ea3aab1d3c52bb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/definitionSeeds.js\":\"c7960dcd1574b9b0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/derivedIds.js\":\"6f453cec6122fc59\",\"/knowledge-medium/pr-preview/pr-1835/src/data/drawnSubtree.js\":\"23813de29fbda86c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facetBridge.js\":\"e9cf892de5a4dd53\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facets.js\":\"3b2bf031f2302d11\",\"/knowledge-medium/pr-preview/pr-1835/src/data/globalState.js\":\"ef303804f84d64c3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/aliasClaimRederiveProcessor.js\":\"0ca61293d4e32e49\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/ancestorBatch.js\":\"caef01f1988ccb35\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/blockTypeTypeifyProcessor.js\":\"be63e0553e8a7687\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/clientSchema.js\":\"003a2bfebffc4232\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/commitPipeline.js\":\"88657f1090a0374d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/devAssertions.js\":\"c961472f17d69a88\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/firstSync.js\":\"d5cfe7e7fe9e705c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/freshInitialLoad.js\":\"91ff360cfdb0cf5f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/graphBackfillClaim.js\":\"175d17008471350e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/handleStore.js\":\"9950d781e4f9900c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/idleMarkerJobs.js\":\"10f2ad80c3d798e7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initialDownload.js\":\"0b70c4af2003f0a6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initializeClientDatabase.js\":\"a4a56a0f9066ea42\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/jsonCanonical.js\":\"08860e3480a75bdf\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelInvalidation.js\":\"52d639755933a78d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelProcessors.js\":\"414347476cf58934\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelQueries.js\":\"2a2748fbb29f0cc7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/mergeTypeMembershipProcessor.js\":\"dd6d47f964719f83\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/normalizeReferencesProcessor.js\":\"426a6e6719313b65\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/poolInstrumentation.js\":\"485cf5f6f5d30dcd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/processorRunner.js\":\"66ad6e1e0cf6fe91\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyCellBackfill.js\":\"069736aff0292e5f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildMint.js\":\"be6014716ba21f9a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildrenProcessor.js\":\"935e09aa7bc428f7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e63629ef54225565\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionSynthesis.js\":\"b8cd709d227b9f5d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyKeyScan.js\":\"12ded282429a92b0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertySchemaResolution.js\":\"c1ec15f3395c1be0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyValueEdits.js\":\"9e36b667756507b3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/raiseProtocol.js\":\"fb5d4dcb91060154\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/readBatch.js\":\"8201fee4f57c4e5a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/refProjection.js\":\"0a0e3f339c4288a7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetLookups.js\":\"ef7fc2eb9515ae1f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetProcessor.js\":\"c572ca3762ad347c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/replayMerge.js\":\"16cab8aee72eb26b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/sqlBinds.js\":\"b3d3618bc5e862b5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7ef7b06c0064fab2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/arrivalProcessors.js\":\"8d9c0e65016d9f5c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/invalidate.js\":\"95dd66110a39b0e7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/materialize.js\":\"a4dfa912dfdecc04\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/observer.js\":\"01ce199072f5d22a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/reconcile.js\":\"9f4fb71667e9bc28\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/timingMetrics.js\":\"15926556a82625d3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/treeQueries.js\":\"a2e591c66463791d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txEngine.js\":\"5100830f5689bc7c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txSnapshots.js\":\"8381f0f6a9ffe7b2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/typedBlockQuery.js\":\"23f5f51f3f3816eb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/undoManager.js\":\"250052f65a81cfe0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/invalidation.js\":\"efb5c84475217f53\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelDataExtension.js\":\"1081021d3f29d4b7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelPage.js\":\"eb68acb8ec303c6c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelValuePresetCores.js\":\"f292bce262e6ec8f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbCorruptionSignal.js\":\"5b1304cdc67f52df\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbStorage.js\":\"ed99a036e8cd0d5c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbVfs.js\":\"04945e7f99634d50\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localSchema.js\":\"ae916cc26f47b619\",\"/knowledge-medium/pr-preview/pr-1835/src/data/maintenance.js\":\"c7bff98ea334ecb6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mergeProperties.js\":\"40065b5f31203e7f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/metricsConsoleHook.js\":\"0e389a68c7f95bcb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/migrationsPage.js\":\"74bdf6ae4785373a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mutators.js\":\"46c7969c87d34226\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKey.js\":\"37e7918c7f8baa57\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKeyPlacement.js\":\"2d92e916fc34dfc2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/outlineSurface.js\":\"3ddc91a9dc2c5a10\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingEditorContent.js\":\"95b670551fd445e8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingUploadsSql.js\":\"5d4c7536d951fcdb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pluginStateExtensions.js\":\"5b8e9a6b3cbec819\",\"/knowledge-medium/pr-preview/pr-1835/src/data/powerSyncLogger.js\":\"ca2877932f595909\",\"/knowledge-medium/pr-preview/pr-1835/src/data/projectorRuntime.js\":\"c0eed4c68fa2dd0b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/properties.js\":\"85341a801f440f08\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertiesPage.js\":\"9c847ad15a84435d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyChildren.js\":\"8c5efd8f1b69a3e4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionFanout.js\":\"fd279a4f2d8e4b18\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionMetadata.js\":\"06471591e53c90a9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionRegistry.js\":\"b323a96701d9c73e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDisplayMode.js\":\"765663d082345d1f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyRowCreation.js\":\"f106b179f3d04b5a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySchemaCreation.js\":\"4dbf0b9eaef79a7c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySeeds.js\":\"abaef66dcd05a09f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/recentsPage.js\":\"fcaafa73ae211fd5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/referenceBlock.js\":\"08270edf83b7317a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rejectedUploads.js\":\"ff5646aa39b6bfdb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/releasePowerSyncConnection.js\":\"d5a61095a252d7fa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repo.js\":\"13f07df97b918b6e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repoProvider.js\":\"4194738407c5a7fa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rowProperty.js\":\"64de06969323dc1c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/searchFilter.js\":\"33dc8c07f47be575\",\"/knowledge-medium/pr-preview/pr-1835/src/data/seedIdentityLedger.js\":\"e5e1811aeaaf6791\",\"/knowledge-medium/pr-preview/pr-1835/src/data/stateBlocks.js\":\"3afabd9620f4c919\",\"/knowledge-medium/pr-preview/pr-1835/src/data/structuralEditPolicy.js\":\"e46a6f1c63ff7899\",\"/knowledge-medium/pr-preview/pr-1835/src/data/subtreeDelete.js\":\"4c854701771a926a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncStreamLock.js\":\"bce0b9d494ff4ba3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableSqlRecognizer.js\":\"a35ec6c0a82c4e7c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableWriteGuard.js\":\"d383ef390ead9140\",\"/knowledge-medium/pr-preview/pr-1835/src/data/targets.js\":\"5daf7da0b0a933df\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeColors.js\":\"09ce77a27639f5b4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionMetadata.js\":\"87b21822fa02ac7d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionRegistry.js\":\"dbf91303f05a5b9e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeExtraction.js\":\"03ff7219dc9c5bb2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeInitialValues.js\":\"0bfebf992088cd2a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typePropertyGroups.js\":\"09e286f48cb8490c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeSeeds.js\":\"43377cc58948174e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeTagger.js\":\"32c04f031cc604f2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typedRecords.js\":\"c41ec921dbdf2ec8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typesPage.js\":\"2e6052f523428f5d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userPrefs.js\":\"add4ba3237d4fadd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userSchemasService.js\":\"08e63d9c5a2dce7e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userTypesService.js\":\"8f0a2e6318380ca5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/valuePresetRegistry.js\":\"6fda7f401a4f53d1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/visibleChildren.js\":\"66d68539feedfb44\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceConversion.js\":\"47c23acd6379cf61\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceFirstSync.js\":\"6c1d05cd9a1e08f4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceIdNamespace.js\":\"3177f5216aabe65a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceSchema.js\":\"1868f593df3b0f9e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaces.js\":\"6d154d5f8935d757\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadLog.js\":\"8da6a377d3adbec0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/BlockPasteShellDecorator.js\":\"d8febffd31fd6b69\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/atTrigger.js\":\"610ee9ebcfbc56fd\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/autocomplete.js\":\"8953e4222db5cfeb\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/codeMirrorExtensions.js\":\"b2d1cfe09f77225f\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/contentFlush.js\":\"e3a614a08aebec93\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/defaultInteractions.js\":\"7f089f9592bfb2fc\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/editSettleSignal.js\":\"9e81cc57e211ac6f\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/insertImage.js\":\"37219e4cdbb5997c\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceCompletionRange.js\":\"36f9618e7aab3ad6\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceTargetTypes.js\":\"0d13c1316ca815d2\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/syntaxContext.js\":\"026d0499f1131986\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/triggerMatch.js\":\"261c684629a6fd74\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/AppRuntimeProvider.js\":\"8602c5c5c65fd156\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/BlockFocusShellDecorator.js\":\"87f7b85f51a16eaf\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/ExtensionRenderBoundary.js\":\"30d8bf873fd673fa\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/PanelContentRecovery.js\":\"db72577b88a2481b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/apiCatalog.js\":\"0c7126313e0f0787\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/approveExtensionHere.js\":\"c02dd15d5db021f5\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/armedCutAppMount.js\":\"b456c8eb8805fdf5\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/batchableKeyedStore.js\":\"8d9314ea419d60af\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockInteraction.js\":\"fe5dcb1271fe617a\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockSelectionAction.js\":\"d407f22aefc80383\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compileExtensionModule.js\":\"41ea65698664265f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compiledModuleCache.js\":\"76d84966fceed7f2\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/continuousGestures.js\":\"a86c047baf538fe2\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/core.js\":\"ee8191cd9ce9c58b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/defaultRenderers.js\":\"d6612bb56ff72b05\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/definitionFanoutAppMount.js\":\"6eadc6e2438ddfd4\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dialogAppMount.js\":\"f7aaf96eec74069c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensionSeeds.js\":\"4416968997f6acd6\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensions.js\":\"6c011da1fff06dac\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/exampleExtensions.js\":\"c7beedf61c29060c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionApprovalStatus.js\":\"b773099e79ff90ff\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrorToast.js\":\"f5bea622bacc3c6c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrors.js\":\"70d702ed064d1ce6\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLookup.js\":\"0ed7a7bdca560e8e\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionToggles.js\":\"ebb7075e4208282f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionUtilitiesCss.js\":\"884bf47a54d7bd15\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/kernelPageDeletionGuard.js\":\"ec3a4de136b24470\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/liveRuntime.js\":\"f7ae5a453dcac470\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/openExtensionsSettings.js\":\"069359135fb75c14\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/overridesCache.js\":\"a872a0a02d7713b0\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/pluginIds.js\":\"616cf4226b7e0e9d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/processorRejectionToast.js\":\"fc1ffcfe99f351c1\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeActions.js\":\"a5f1fa1cd707f6e0\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeContext.js\":\"3b63c254ad63fae0\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticAppExtensions.js\":\"b339c504a7887b0c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticDataExtensions.js\":\"12e68f7b7bae5022\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/toastAppMount.js\":\"a95a402d7a461f83\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useOverrides.js\":\"45e6e336a45c3b34\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useShortcutSurfaceActivations.js\":\"158452ed9ab59dca\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/discoverToggleTree.js\":\"ec3c5ccd1f90497c\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/facet.js\":\"8f40f33dc09e94cb\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/resolveAppRuntime.js\":\"591f3f782fe0d9ba\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/runtimeEvents.js\":\"1a5d6611343523a0\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/togglable.js\":\"60c245b204041c12\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/variantFacet.js\":\"a09c48948c71d461\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/verbFacet.js\":\"772634305f5ca9b8\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/block.js\":\"1c6bb19ce7e83615\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/focusedChild.js\":\"0c269b192169999e\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/propertySchemas.js\":\"3213000833a9339f\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/typeRegistry.js\":\"d3447920047f9739\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAncestorCrumbs.js\":\"111d640fe91840ff\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAutocompleteListbox.js\":\"d6855dd1da716ae1\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedSearch.js\":\"ba79df1d054100ed\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedValue.js\":\"210e4df28c76703c\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsFocalRender.js\":\"a0a21c1bed8870fd\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsReadOnly.js\":\"446d5e4145304d3f\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMaterializeBacklog.js\":\"c1fde04f8b0e0c35\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMinuteClock.js\":\"db203d2769c74a35\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePanelLayoutProjection.js\":\"2f0a666b66b5419f\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePendingInvitations.js\":\"5da62eac9ede9d91\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRendererRegistry.js\":\"8e6cc65bff70ec3b\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRetainedFieldRows.js\":\"57dc92383c18087b\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useWorkspaces.js\":\"7b49abdf85c25002\",\"/knowledge-medium/pr-preview/pr-1835/src/lib/utils.js\":\"1b4f3cc7fedcd5ef\",\"/knowledge-medium/pr-preview/pr-1835/src/main.js\":\"4a8116aaa7b9536f\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/MarkdownImage.js\":\"f3a81da6149d7d13\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/blockSeparators.js\":\"f65315a49101de5d\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/context.js\":\"0dd0b961283c2fa3\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/defaultMarkdownExtension.js\":\"bf4d47e131a7553a\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/extensions.js\":\"210e787d01ef4aab\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/renderMarkdownHtml.js\":\"c13417a48f32434e\",\"/knowledge-medium/pr-preview/pr-1835/src/minimal-editor.js\":\"c90081ab94c06307\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/armedCut.js\":\"ff1d2c6fc5b3cde6\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/captureMediaVerb.js\":\"f32002bee9ce8343\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/clipboard.js\":\"d06cd41dff44d805\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/decision.js\":\"7e95d740ba655a6d\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/operations.js\":\"06f4716ae5a5908e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/AccountHeaderItem.js\":\"1fd2941857a2e421\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/index.js\":\"c774ff5a04905590\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"badee8f0945ac7fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askAgent.js\":\"915b7a2a4abc2e3b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askedStore.js\":\"a85b6b8e5922f966\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0e44c3a4f1452801\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/chipState.js\":\"2cab80b564eb5ba0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c7941bf551685545\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/index.js\":\"ceb472e542fc6c87\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"150b03e492423be5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/schema.js\":\"9e7ed1fff9b4264b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/AgentTokensDialog.js\":\"06fd273bf561efd1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/BridgePairingDialog.js\":\"83577b7722665c12\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/addMedia.js\":\"4528a7b8979b4084\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/backlinks.js\":\"52ceb2185797d34a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/block.js\":\"7d74730d81b54d0d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/context.js\":\"2a7288455a3e032a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1acff8213f3e0687\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/index.js\":\"96d000e62116ca64\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/outline.js\":\"8ff591125af8db3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/properties.js\":\"5dcaf1a943bfef3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/refs.js\":\"5bd0d65809fbf060\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"4f206c5cfae9559f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/search.js\":\"3ba06275c71d580e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/shared.js\":\"9406f9e5f51e4f75\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"84a9992e59a48e44\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/text.js\":\"cfdd282c873f94b7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentWrites.js\":\"840746ab00c0236c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/authoringCatalog.js\":\"82bb2d8d1dd708d7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/blockRefTargets.js\":\"0599f27574ef2984\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridge.js\":\"55be0ba5d11827a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridgeLoop.js\":\"04865fd585d39d0a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/changeHistory.js\":\"1ee90310389242c3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commands.js\":\"5621995e7a81929c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commentsCommands.js\":\"0ba2d1797a13de85\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataExtension.js\":\"8b805f3730c75554\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataModelGuide.js\":\"b60877d5a46425d4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/describeRuntime.js\":\"1a142e30f8f3ed32\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/extensionLint.js\":\"659dd969b6e66caa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/grainAudit.js\":\"45fe8e6c04c48181\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/healthCommand.js\":\"c69dfefba59862b8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/index.js\":\"ab6a30907165165b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/presetIdentity.js\":\"6b4ac2f2f0ec7b76\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"dd6a9dfcff719149\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/readMedia.js\":\"47c71b0b656e18f5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/schema.js\":\"345681e8babcf6d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/serialization.js\":\"b308320d49cecec9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/targets.js\":\"ef67f8a9b804c89e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/tokens.js\":\"c0bc057e7602cc20\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/watchEvents.js\":\"ad2b1e29196d7fb4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/workspaceGuard.js\":\"7ebaa1373dc0d9e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/writeCommands.js\":\"bd45a0afd1899957\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/AliasCollisionToast.js\":\"24d98a06d4082ad9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/DuplicateNameBanner.js\":\"5c2f2aa297544a48\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/collisionMerge.js\":\"e286526d1eefdfe0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/dataExtension.js\":\"fbdf5338d0f5cdae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/index.js\":\"fd4dbba118e5ee6b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/mergeCollisionAction.js\":\"11ccb84967cb5e12\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/pageStyling.js\":\"3c35ccbeb1f1ba27\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/rejectionToast.js\":\"20c9d70ee5243be2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/syncProcessor.js\":\"17342ad5972723af\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/actions.js\":\"9f4aaa81d884aa0c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/addComment.js\":\"20f217c72b91c4eb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchor.js\":\"6ca90a6d10c82b61\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchorState.js\":\"18cfbfb8ca3da0bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/commentLinks.js\":\"839e2b002ed8eb58\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/confirmThreadDeletion.js\":\"1da8b6a15f7bf4b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/container.js\":\"93e3c1a6f0b37982\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/dataExtension.js\":\"e4fa91d6ffe3739f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/deleteComment.js\":\"279aac2def2d943c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/highlights.js\":\"240c918b637b4c58\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/index.js\":\"1352c355ef4703b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/linkedCommentsPill.js\":\"10da8cf6b4ba147b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/margin.js\":\"4fbb41333a848e7f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/marginSchema.js\":\"dab88c3d1fd82f28\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/newComment.js\":\"ad2503d4d88fa63b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ownThreadPicker.js\":\"aba86bff992bc1f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/placement.js\":\"74d4168b02289d0b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/queries.js\":\"2771e615c69bab51\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotePosition.js\":\"04f5fa3255ecbc9e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedIn.js\":\"e725f53b35b7b2ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedRange.js\":\"0bda98615149575f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/rangeRefs.js\":\"67c0857e3c4c1b41\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readHighlights.js\":\"7e3730ee229cb028\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelection.js\":\"7a31a8752254f23b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelectionUi.js\":\"a02521a458753830\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/reanchor.js\":\"5e6f11e42d5c6764\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/schema.js\":\"ad6fb13d30b20235\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scope.js\":\"d869dc29eaef27fd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scopeThreads.js\":\"04080d07a555435d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/splitRetarget.js\":\"005f4d7d58193fd9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestionCard.js\":\"3ceffcae7963d0c1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestions.js\":\"9fb38481af3c9422\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaries.js\":\"49668fd67daad79a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaryBatch.js\":\"6fb777eee6101652\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/surface.js\":\"c98a316384e10b8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threadNavigation.js\":\"a12f2ce1af2ce89b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threads.js\":\"0fd7456a0f261371\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ui.js\":\"7fdc786d8083ea85\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/uiStore.js\":\"bd8bad77de71223a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/appIntents.js\":\"c33b955845db6129\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/index.js\":\"938adc983ae78ec0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/index.js\":\"02b14ee4083001aa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/status.js\":\"eb471c47fc84fafe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e8476f62f141734f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaBlockRenderer.js\":\"ce2c98f70c783a77\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaDownLaneReplicator.js\":\"671423ad1905e0cd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaUploadReconciler.js\":\"60c1e860cb5a9d98\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetDownLane.js\":\"9398fd4ddc4c6079\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetResolver.js\":\"4a544a5f20f81d0a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetUpload.js\":\"e0f3e5ea5c555faf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/attachmentCleanerIO.js\":\"194ce149e8c95b40\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4d4b5ecd341cc973\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/blobStore.js\":\"1eb33831c624be4e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/byteStore.js\":\"1698de44332c8bee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanerIO.js\":\"e06a9fda9a5eacbf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanupAttachments.js\":\"ef40672eca5414e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/dataExtension.js\":\"0a9c6b175225b888\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/downLane.js\":\"4116e543734e16d1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/index.js\":\"e52c675f4e1192a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/insertImageContribution.js\":\"920008a5500cf1e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneArming.js\":\"ee75245791e7663c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneLock.js\":\"4090264451ad7cf9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaBlock.js\":\"1a7b259a0d0ea1ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaCapture.js\":\"9f7058766fcc4a70\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewers.js\":\"4cb6eb5b942ce054\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewersFacet.js\":\"4ecc1b48e2b88961\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/pasteCapture.js\":\"014389bbebdbdc16\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/resolver.js\":\"a424fee1c1064a07\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/retryUploadsAction.js\":\"3a753d04b31eaf11\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/storagePaths.js\":\"952c7ce57eb5e95b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadDrain.js\":\"98aaa8f8ad9d87cc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadLaneStatus.js\":\"fc3664e93f6792b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadReconcile.js\":\"c11f44e028c85431\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadRecovery.js\":\"795de16a6628655f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadStore.js\":\"641dcee9012de693\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/useAssetObjectUrl.js\":\"2898e8498ede8008\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"da0bb55204e25909\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ee0c8ba0322267a5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/facet.js\":\"1add4306cda9122a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/index.js\":\"6b8ec88afe206098\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/prop.js\":\"054b527ed7449ee7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinkFilters.js\":\"a33d16a69808d1c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"fe584a397eba8588\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BlockEntry.js\":\"5ba505d62292a16c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/LinkedReferences.js\":\"b824a26ada5666f2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"1f447ab0c44f5823\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dailyNoteDefaults.js\":\"0f8116e6e2fc16fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dataExtension.js\":\"23e40b40b66557ca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/edgeExclusions.js\":\"257c240783db9717\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/filterProperty.js\":\"a2cad8e824076f43\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/index.js\":\"dd3f6478e752a393\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7a0582ae52a5beed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/applies.js\":\"cfed812d1e2f0896\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/countQuery.js\":\"361115aceef8393a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1cb63008c416f40f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/index.js\":\"d31ca74d66d81c3b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"eb2dc9e038028317\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/presentationInvalidation.js\":\"796e6ad47a945ee3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyEditorOverride.js\":\"584377ecb309ed00\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyFilter.js\":\"aa197427b1056e2d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/query.js\":\"b4c04ade0ab27921\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/resolveFilter.js\":\"be2aea2bbb76a21c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sourceBatch.js\":\"b8832817826dca04\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sources.js\":\"0de0cfa2510c81cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useBacklinks.js\":\"cce3a8db4824d1ee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"935e4fe1b03c91f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayCelebration.js\":\"87e0168674f8a09a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayOverlay.js\":\"debf8bdf7235d2d2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/gate.js\":\"979e16fbdec619dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/index.js\":\"2b1c37471fc76b1a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/wolfTheme.js\":\"2b2cf04c02e4076c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/BlockDragLayer.js\":\"b025e94a9da06554\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dragController.js\":\"23bebe98c0434626\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dropTarget.js\":\"2d4dc72f0eb133b6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/index.js\":\"a6b626c341a3083b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/projection.js\":\"36b41a8affd56632\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/BlockMetaCard.js\":\"69e998a831b30dee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/index.js\":\"379bdf85344f1ab3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/AddTagDialog.js\":\"7ab405d3663d603b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"379a0412360bf07e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/TagNameIssueHint.js\":\"5c2a4a973706e5b8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/addTagAction.js\":\"afc10113f63f90b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/appendTag.js\":\"82c3e1674647c56e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/config.js\":\"48d145c543e9dd44\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/dataExtension.js\":\"0c11545d78e4cf3d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/index.js\":\"228154cd18cb35c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/propertyEditorOverride.js\":\"4e4fbc0b9c828630\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d48dc331c0daf1d2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"15294c3395d6d841\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/Breadcrumbs.js\":\"37d233edfaf7ec1f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"89ec5746c7155824\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8cea75c6248e179d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/index.js\":\"9de54be9bcfba1d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b59f38e6844677a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/CharacterCountItem.js\":\"c0b4c6b8ae82e760\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/ProfilePropertyEditor.js\":\"637d5d34f764b404\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/actions.js\":\"0085082ddcea21b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/blockType.js\":\"f3d76568ffcfc074\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/charCount.js\":\"19aa179a356c823d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/dataExtension.js\":\"60efb90e093ffc04\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/index.js\":\"ff36f2ac66f13ab2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/profiles.js\":\"3472ed50b0ca0d8d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/properties.js\":\"d828d192c7d171f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/textCounts.js\":\"9123059f560c7d94\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/colemak-keybindings/index.js\":\"31ade634252b3573\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/CommandPalette.js\":\"06f79378e8b8dcdc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/HeaderItem.js\":\"bb127a1b88ff205e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/context.js\":\"9fd80d261af31a36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/index.js\":\"2a8ade08a160658c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/selection.js\":\"2674664f056f998f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/toggleStore.js\":\"ee6e9836a1cb5fe4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/useCommandPaletteActions.js\":\"cfc127b21919511e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/ContributorBadges.js\":\"0cdab7c814608a7f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/author.js\":\"23fb9898270ebbc0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/codeMirrorExtensions.js\":\"67f01eb8ca289d9f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/dataExtension.js\":\"55db5d5c5f3c483a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/index.js\":\"cbbc88bd004e8d43\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/mentionAutocomplete.js\":\"e211a3af1e0de2bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/processor.js\":\"cf9d620d36b15113\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/profiles.js\":\"a68196812703a0b9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/queries.js\":\"db18dd26c5d9d4cd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/schema.js\":\"dbb810d796ef2d22\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"f1153a28e2780290\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c24057b872d7c2ba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/index.js\":\"b1f1b25a5d307288\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"35b2471b72baa928\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"87b57f3c0ebcb20c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/CalendarGrid.js\":\"bd6b16b749e84d0f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DailyNotePicker.js\":\"12aa913c91bc8bf0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e4f47da7df80f6df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateNavDecorator.js\":\"bdd0d990bef90e53\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateScrubOverlay.js\":\"859805ceee91ada1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/HeaderItem.js\":\"3c980950185b908a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/ReschedulePicker.js\":\"5cd44d8502ee7685\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/SpreadDatesDialog.js\":\"374a1c1b2ccff606\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/actions.js\":\"e817c4411ed4259c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/blockDateAdapter.js\":\"32e88099ca00b39d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/calendar.js\":\"fff0844ead235b04\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dailyNotes.js\":\"dc18bda15ad7042c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dataExtension.js\":\"b89dd9a77ed6482e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubActions.js\":\"d034e98b7cabfbc9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGesture.js\":\"81a43157fb2bcd20\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b15eed6e308f7c58\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubRecognizer.js\":\"5a2c7e267c304164\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/deletionGuard.js\":\"7f05c83856359f0b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dueQuery.js\":\"43f763385aa3bf4e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/index.js\":\"018b4fc19d7bd80b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/landing.js\":\"40bbc1e8327bfc3c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/localSchema.js\":\"7b8863e81b54b2bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/referenceDateAdapter.js\":\"4ce5c37e5ea9cb0a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/rescheduleAction.js\":\"7ae9bdbad13b26f5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/schema.js\":\"7cf727357bb1d530\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadBlockDates.js\":\"8a556a426db36647\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadDatesAction.js\":\"96084afb4375617b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/today.js\":\"7b366c76a546d7dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"1a7c7950f4a4c0ba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4fe4551d2378df3a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/audit.js\":\"8b2edee786294c96\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditAction.js\":\"51c44bbeb1f96628\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditRanges.js\":\"346189a78ab0a940\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/diagnosticsSource.js\":\"be4e816c64638ad6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/divergenceScan.js\":\"b950e99ef4c71cc6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/index.js\":\"857bd139ecddff31\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/propertyChildrenChecks.js\":\"43c34481ac9feb2d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/referencesMirror.js\":\"0908f629d10bcbcf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/rowJson.js\":\"f048036f5c105eb2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/schedule.js\":\"0dddf8a62aef2480\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/store.js\":\"19ea5294f62bb370\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/action.js\":\"3e830877dc49ae8c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/index.js\":\"63f795e71a8e1632\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/plugin.js\":\"20cbce84b8b11ed2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0af79a9265e2ef3a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/actions.js\":\"ae93025d0244555d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/changeMarker.js\":\"d5a367b04d79e737\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/diagnostics.js\":\"1f34117e74d77a70\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/fileSystemAccess.js\":\"61a225c919a65263\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/filenames.js\":\"0479425ff312392c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/index.js\":\"6e451a60fb56967c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/mirror.js\":\"4eda3d43bb421c85\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runLock.js\":\"70bf697064bb0113\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runtimeHealth.js\":\"137e314d84954de3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/schedule.js\":\"d802d012bc5c5677\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/store.js\":\"38d9a6767842cf4d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/index.js\":\"1aec19fdc4a9db8d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/themes.js\":\"0174b93eea026254\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/facet.js\":\"afeb655ecd072da4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/useDiagnostics.js\":\"f05dc928881aa6de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/dismissals.js\":\"38fb71496580fd40\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/index.js\":\"31e6c54ae148279e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/status.js\":\"0e921c6bab4d5760\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/store.js\":\"ab45a9ebc6a34b44\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5618f064b27dc13c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3515a741754d3e2e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/actions.js\":\"647fd87fff4a38f2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/config.js\":\"42b1e98e0aa0aaf3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/dataExtension.js\":\"40978338f0179dd1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/effect.js\":\"bb8f586b3f56cd6c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/index.js\":\"f617d123b979a2b9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/propertyEditorOverride.js\":\"b973a20bdb980321\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/useToggleTree.js\":\"b8ad541208de07a1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/ExtractTypeDialog.js\":\"ad1236844cef375a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"851b3a0fd4e96cb0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/PropertyShapePicker.js\":\"3470b721be2feca9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/action.js\":\"b62bad8d8367d6e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/index.js\":\"62d7f50a6e09b35b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/FindReplaceDialog.js\":\"1f38c561694ed96d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/HeaderItem.js\":\"f99bdf1919a5032c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/dataExtension.js\":\"68d67492a382889d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/index.js\":\"b4b9a758aaa813c6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/search.js\":\"466932216bf1e6e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/toggleStore.js\":\"a0ca6ce6ad2a3586\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/LocationPropertyEditor.js\":\"6094d59e2096cbc9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/MapView.js\":\"ab91a6d33b2c688d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/blockTypes.js\":\"2dfdffca87d63320\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/codeMirrorExtensions.js\":\"9691e9055262682c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/createOrFindPlace.js\":\"c066922f953f0fce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/currentLocation.js\":\"2b55006a2904d44b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/dataExtension.js\":\"998e7a6b21ece738\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/geoContentDecorator.js\":\"d53c3ae67e49e034\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/googlePlacesClient.js\":\"484ece0e0e72e65d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/index.js\":\"cd3fc0b14fe6f5df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/locationsPage.js\":\"e702511ef9ff9df2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/mapViewport.js\":\"530eaa6d09d6b49a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/pickCurrentLocation.js\":\"29ed314b4ec95d07\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeAutocomplete.js\":\"50ec0bbe9dbe5b65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeNameCollision.js\":\"5cad140fceef0296\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/properties.js\":\"26e9dc2c3f8a0c1d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/propertyEditorOverrides.js\":\"84d72c9be644da6d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/query.js\":\"7a846c035c35f408\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/usePlaceSearch.js\":\"3ea598bf563ce8ba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e5aa75249cae262c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d6b2af31959b102e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ba27fff6f5b571db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/config.js\":\"d98ebbd5443e783b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/dataExtension.js\":\"b225ce5498b06c3f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/facet.js\":\"de29c34208a123e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/grouping.js\":\"b1b55560fd839da0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/index.js\":\"01605f373691d2b0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2a312c43956843a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/query.js\":\"9a2fa4a566471b29\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/resolveConfig.js\":\"f4bf1c69145dff90\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f6ed742487aea8f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"fd1e843dd54da9ee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlDocumentContent.js\":\"6bc5e94a42f690d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlFrame.js\":\"f05863035171d116\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/actions.js\":\"67d20d601f44e8dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/blockType.js\":\"9ce79d823db61f8f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/confirmRunScripts.js\":\"fbf153f5452022c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/dataExtension.js\":\"b8bbeed712ac6d86\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameAnnotations.js\":\"2fc178c9ef707b05\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameDocument.js\":\"9b316eba801fa164\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameTheme.js\":\"92a10c6260a7edab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/index.js\":\"234baf1dcac4934c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/scriptConsent.js\":\"539600b6622d9982\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/sourceMap.js\":\"2f86f510b7455052\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/useDocumentScripts.js\":\"817f5af4ad1d5019\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/index.js\":\"a34fa09309bba095\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/record.js\":\"51509c256533c811\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/recordStore.js\":\"9ec346ab1aa0aab4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/responsiveness.js\":\"fc11911ad62ac658\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/schedule.js\":\"40b449c9e832fc9a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/sessionContext.js\":\"d6d8c9cc133d235e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"458ab5cb0213b4fe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"aca7fd45b5992df5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/actions.js\":\"00a032bc8d0dbb9f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/config.js\":\"221a137b728f1f10\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/dataExtension.js\":\"9feee7a80f327107\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/effect.js\":\"d420a3a1570ffc5b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/index.js\":\"e1224ffbfdc5f475\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/keyCapture.js\":\"f073a2def1870d56\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/overrideStore.js\":\"39bfb80818f52f02\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"2b23aec8b709910f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/HeaderItem.js\":\"2a2fc1d0015c30d4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/LeftSidebar.js\":\"922fe7e21613e608\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/actions.js\":\"87661361436a3ccc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/facet.js\":\"7249f8050a229815\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/index.js\":\"336dfa196f43851c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/shortcuts.js\":\"bc839b1139939678\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/toggleStore.js\":\"0440b57baddb0747\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/MergePicker.js\":\"ce1efc08d13ecdd3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/index.js\":\"cf526c1e36267ef4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/mergeAction.js\":\"cdbff277d7520c4b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/strategy.js\":\"5a9084f44bfacde9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/Button.js\":\"5057ac138e4c04f7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"de0adc0def00a589\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/defaultItems.js\":\"feb428f8f6e90fa8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/facet.js\":\"61bb9198822f09a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/index.js\":\"ab5e02d6f2eb1c04\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"384811a10d66b040\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/actions.js\":\"eda217744d0e9e20\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b9bbfb7bc36a4494\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9e8c99ca39d900f2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/index.js\":\"abc1e833b47add83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a5d11091aa8a6592\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/blockSubtreeMembership.js\":\"48a7912d4b25a1fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/contextMenuItem.js\":\"2c82e1d855636c26\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/index.js\":\"173805a2151833a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveAction.js\":\"06debcc3032177d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveBlocks.js\":\"974d6d5a89236dd5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/selectionAfterMove.js\":\"2e617204ddad2b53\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/TutorialBanner.js\":\"59f40685c917ea52\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/action.js\":\"2fc7ccdbc74c1cd6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/bannerDismissal.js\":\"0aee2f4974ade980\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/documents/cheatSheet.js\":\"0a7b4f05b607afbe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/index.js\":\"d10d72b750d23eff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/keys.js\":\"f09e349b67e5fb80\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/landing.js\":\"d4dd5f5b7dc3f796\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/outline.js\":\"4487a45647b57496\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/seed.js\":\"78336bb4b1968204\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/PerfTrendDialog.js\":\"15bce4e4f7c985d1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/analyze.js\":\"cd96eb857131e92a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/diagnosticsSource.js\":\"ab5aa5013dcb38ee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/index.js\":\"64b8a089a9a43a2a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/load.js\":\"8c3e1805f5d66052\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/monitorRun.js\":\"340ef487c3c3228f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/schedule.js\":\"8e4cc8b5ba4281f2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/series.js\":\"bf2e64d067a12f5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/store.js\":\"e106a95c07b380ee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/trendAction.js\":\"6e1b5886d602b3e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/verdict.js\":\"14f4ff380a1a9b82\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/clickToEditAction.js\":\"db1030cf7e279ef0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/index.js\":\"9bcd29f69946faab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/interactions.js\":\"f871038638f3cf07\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8cdfe1b76dbca9b9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGate.js\":\"1cf277c4654a5d78\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGateDialog.js\":\"9c5fe1ba43dbd728\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/action.js\":\"9bb84fc9a7dd98ba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/index.js\":\"1ca3798283c05715\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/localRunMessage.js\":\"60e3c2e60a7803b0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/plugin.js\":\"a21e26664c1d0c0c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/progressReport.js\":\"f8212067acd1f4db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/sweepProgress.js\":\"7664169ff3a15965\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/FieldRowRenderer.js\":\"648426a37262d9db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/ValueRowRenderer.js\":\"612fdfb864af4fe1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/actions.js\":\"f75da86fba4485ea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/autocomplete.js\":\"8870cc9a7460a288\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/fieldRow.js\":\"55e94bab21503e05\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/index.js\":\"95b1f837ac1ce212\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/referenceWarning.js\":\"83a7123d781d513c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueAutocomplete.js\":\"2c117e1fd94e00d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueSchema.js\":\"d21166a8e0cc0a50\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/HeaderItem.js\":\"d7cf44cc8365263b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/QuickFind.js\":\"49349ef2acc8eb11\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/index.js\":\"af235e6054045a33\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/recents.js\":\"5b770d927f961e46\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/resultItems.js\":\"58646bfc0a9760d7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/selection.js\":\"70f9a488e8ec46ee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/toggleStore.js\":\"9790ee4bdeb6f0f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/HeaderItem.js\":\"481dd911b2726f8e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/RecentsPageBlockRenderer.js\":\"06cc2fed8c7b3377\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/grouping.js\":\"bc68b1049f72fafb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/index.js\":\"9fdfe8c73d5cf93e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/target.js\":\"e48f11a98d007fe0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/codeMirrorExtensions.js\":\"9cc33ef5c27f0e08\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/contentPrefill.js\":\"6d0471ec49ec14f7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/dataExtension.js\":\"77515231b6c2f4a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/index.js\":\"e90b1cf8a4aba33d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"55a730df9ebfeea3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/invalidation.js\":\"0dfc2dfe7486c08d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/localSchema.js\":\"6c378c82449055d3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/index.js\":\"663868219585576a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"369a05a8a6bdce8f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/index.js\":\"e80989c7b804ed10\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/referenceNode.js\":\"555625a3c38c0498\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/remark-reference-occurrences.js\":\"dec5371570404c9a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5e70558eafd4fc1b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/index.js\":\"065866a4a189ac58\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"72258a0353786353\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"de1e686fe9c613e2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/mergeRetargetProcessor.js\":\"63bdc2b2d204f1ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/parseFence.js\":\"ccea2d737f27a0ac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceParser.js\":\"79c3f29a4b346982\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceProjection.js\":\"6d809ec7be5bdc07\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referencesProcessor.js\":\"266106a01450543f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/renameProcessor.js\":\"599d0b88698b734f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/spanReplacement.js\":\"9214b12c9a777332\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/htmlToOutline.js\":\"6eb5b2162f945986\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/index.js\":\"cd4a363200393f40\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/normalizeClipboardDom.js\":\"882979711d932bdf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/pasteDecision.js\":\"d4eb29c6da518839\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/action.js\":\"648659a7597272e0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/blockIds.js\":\"750c767cd8a27b8a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/content.js\":\"262e9b9ca9d8228c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/effect.js\":\"2a16f8605e539793\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/ids.js\":\"fc0f5bcdbd155086\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/import.js\":\"6d090c8dc4911269\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/index.js\":\"b62bbf838e822ad8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plan.js\":\"f30ddf918a6161d0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plugin.js\":\"cf71ca4ff7c60c24\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/promotion.js\":\"bf07607c84f74379\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/properties.js\":\"d83beb5a31cf9ee1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/references.js\":\"49c86f1f83bb4cf7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/report.js\":\"3f058654ed44a4ab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/roamMemo.js\":\"2dac2b2dbb27e97f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/runtime.js\":\"94b7995210a381ab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/schemaReconciliation.js\":\"67bffde492069668\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/srsMarkers.js\":\"f18fb730c9bc6c51\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/todo.js\":\"f2e90530d579b58f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/typeCandidates.js\":\"cadfbab7281f2da2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/types.js\":\"fb04c9a891dd5c2a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/index.js\":\"bc7a075a803ed267\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/store.js\":\"64de88e0844ac248\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/HeaderItem.js\":\"7774c9cdcb89ab16\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ed058152e72f3a6e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/index.js\":\"ce958a3e982e50fd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/model.js\":\"ed3a14327221aa69\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/toggleStore.js\":\"23cc7c5afee69a0f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/useKeyInspector.js\":\"0e5fa5076bc14dd9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"468ae5e0fcac2aa1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/ShellDecorator.js\":\"86d727023cd972f6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/actions.js\":\"15923470903bf764\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/exclusionsFacet.js\":\"7cd4c96a75412a0d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/index.js\":\"50e03cfdaa70eba8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/shell.js\":\"4065718eafdc90b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/surface.js\":\"b8520816ebb7a41c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/walker.js\":\"0deb550350897441\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4e7381b297c68606\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/dataExtension.js\":\"9eac8cabef3f3acf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/index.js\":\"b3fbd3ee3889bad7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/indicator.js\":\"f7053fa0460cd19a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/moveSrsState.js\":\"df69915578b5ad66\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0260283ad582ec13\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/scheduler.js\":\"1cda7ed9f05c4f67\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/schema.js\":\"d4e85c30099296ef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ebb375370784f738\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsClipboard.js\":\"705080bcd7068e36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"0773e87425e88616\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3d0bf019a1197e33\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DeckPicker.js\":\"713258592e03c119\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewControls.js\":\"3dbace5c250095fb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9e848548c0a5903d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewSession.js\":\"250b9f7f8bbf7135\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/actions.js\":\"2a60538570ab9a96\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/archive.js\":\"1eaaa7a829c38b31\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dataExtension.js\":\"afc9f7d7f1e16e88\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/deck.js\":\"c2c144e637d786d1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dueQuery.js\":\"c5ace16e2fbac7db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/gradeDecision.js\":\"0ed5e71a5006e9e0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/index.js\":\"f04c489b9ac0a273\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/keyHints.js\":\"d9af35f4ade49276\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewCardLayout.js\":\"e64664f54243deb8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewProgress.js\":\"fc5d342e0cf25dbe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/schema.js\":\"8591b852e8c42f64\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/useDueCards.js\":\"9109d35ed4209eae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/index.js\":\"09f98e51e3c6f61c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/record.js\":\"46a02b0294bb5f01\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/index.js\":\"ced87db1fec7c6e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/persistenceStatus.js\":\"bf01d645406b7a8f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/requestAction.js\":\"fa030084892c4dae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/TypeChipsDecorator.js\":\"8a0747ad772691e2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/codeMirrorExtensions.js\":\"30445ef4c2f4d9b4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/index.js\":\"378fb1ff30b981dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/typeAutocomplete.js\":\"5f6198f6b6279761\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f08186205b816538\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/actions.js\":\"bff11d84e10cd7bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/anchor.js\":\"277526151183fcfb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/events.js\":\"1811989f7a69665e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/gestureActions.js\":\"e4e2acc92e89b991\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/index.js\":\"d36324a0a186a2f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"da3d6543d8cc6fbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/collect.js\":\"769394b0b4a9bfd5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/index.js\":\"f74a21ff37a192ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/record.js\":\"6b23277b3a22c8c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/RejectionDialog.js\":\"f3840373682a28bc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/SystemStatusHeaderItem.js\":\"33da2d7c7fe29375\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/index.js\":\"be580d629941cc5a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/model.js\":\"f74b53fa71da3920\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/queueCounts.js\":\"1f2dc6cf00c9b273\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rejectedHelpers.js\":\"4506b855b1c65bea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rematerializeAction.js\":\"fa120f47c9b0aa50\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/useHysteresis.js\":\"f99486309fc87983\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/ColumnHeaders.js\":\"119880ef4519ca64\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/TableLayout.js\":\"71ab44d6a75af137\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/actions.js\":\"cef62da62da360fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/cellEdits.js\":\"62a224ae040b8888\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/columns.js\":\"85163dce71f3e425\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/controller.js\":\"2cd6d6e7fe7e0667\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/convert.js\":\"a8f1e4514439cb7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/dataExtension.js\":\"c8dbaf922191880e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/index.js\":\"712c8bfb91a98249\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/keys.js\":\"a40655e26b81b2cc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/model.js\":\"afa98788358f5bd6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/format.js\":\"2f8dae6e3971c9a4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/parse.js\":\"987496af51c2d394\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/registry.js\":\"f13bd6a96e2cb4e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/schema.js\":\"d3daecd919f7d1bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/effect.js\":\"98859d7fca6b8f95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/index.js\":\"6b05465827b8bf28\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/theme.js\":\"997bdfba7e36a4a0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/actions.js\":\"be766885ddd45026\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/dataExtension.js\":\"1e28d1c0618a3969\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/index.js\":\"7686fa400f0cb043\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/schema.js\":\"b112a0cc190b910e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4884d707e03a95a0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/actions.js\":\"e247183e66983c6b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/defaultItems.js\":\"714f2afa7ca8aea4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/facet.js\":\"65679381f5252f68\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/holdRecognizer.js\":\"d70dccb369e03e46\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/index.js\":\"31661ee25356f14f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/UpdateIndicator.js\":\"723cde15c63ae3ce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/index.js\":\"1e99c73dfc7155ea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/loadTimes.js\":\"4d200bb4b66d695c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoNotesRenderer.js\":\"68ae95ff373c1f91\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoPlayerRenderer.js\":\"bcb359cab14337e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoTimeStamp.js\":\"c6199ae9fd1c16b9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/actions.js\":\"3cae08e99fce3a65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/index.js\":\"9e3dd8f15de710a4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/markdown.js\":\"93a3befb85237025\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/notes.js\":\"44fc551dea717643\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/registry.js\":\"9665f8dd13f2ec5e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/remark-timestamps.js\":\"62e2a999bfc639b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/view.js\":\"b59ca8d43f59701c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/LinkHints.js\":\"edc7bd3bd5ba8411\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/index.js\":\"2d969baa87b91e50\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/model.js\":\"4a80266e81900265\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/settings.js\":\"8cdb27f287ce4a56\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/actions.js\":\"e0a6cc3aadc84a5c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/index.js\":\"6e26aea65ea6cb2f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/interactions.js\":\"0231add7d7773128\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/workspace-header/index.js\":\"1611ff8def5c51b0\",\"/knowledge-medium/pr-preview/pr-1835/src/registerServiceWorker.js\":\"3a338767c5750a15\",\"/knowledge-medium/pr-preview/pr-1835/src/requestPersistentStorage.js\":\"e8f704d846c71819\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authRequestDeadline.js\":\"8de6271de759e65a\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authStorage.js\":\"18781178cfdca9c6\",\"/knowledge-medium/pr-preview/pr-1835/src/services/powersync.js\":\"92d1ca3fb651fc7e\",\"/knowledge-medium/pr-preview/pr-1835/src/services/supabase.js\":\"25e9e622fd8cfff9\",\"/knowledge-medium/pr-preview/pr-1835/src/services/uploadErrorClassifier.js\":\"110c60db80457246\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/ActiveContexts.js\":\"310f7f9ee4946672\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/HotkeyReconciler.js\":\"e653683c32a58988\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/WipeLocalDataDialog.js\":\"8aa47822f729eca5\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionDispatch.js\":\"81360cd0a3c68ca6\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionRefItems.js\":\"587da2569199ecfb\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/applyKeybindingOverrides.js\":\"240a2ac7a97c32f4\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/blockActions.js\":\"c773243a48706550\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/canonicalizeChord.js\":\"e560a5735900b43a\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultContexts.js\":\"66712fb3694477eb\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultShortcuts.js\":\"5a3a09b33e277093\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/effectiveActions.js\":\"7a4449a1ad803091\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureAction.js\":\"71f8269ac673b2f1\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureBinding.js\":\"252b8b2b61facf46\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/holdRegistry.js\":\"fd410d96293e6dc8\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingConflicts.js\":\"bb1bdd5acedb5feb\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingOverrides.js\":\"18ca5d28a32a3dac\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/pointerAction.js\":\"4e2207cf454a45bc\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/resolve.js\":\"e361e41dbc3cc671\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/runAction.js\":\"f894decd768b2933\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/sequenceMatcher.js\":\"5a454d4f27546ab7\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/types.js\":\"af68e29259bd4529\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionContext.js\":\"72204ea094764109\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionDiscovery.js\":\"9b156e7a4c739007\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/utils.js\":\"1a71546e7411ed5f\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/bootStore.js\":\"696795ad1771ee1d\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/previewDatabases.js\":\"dbffa1b195197886\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/byteTransform.js\":\"9392fea763ef0987\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/attachmentCleaner.js\":\"919b72806e96972e\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/attachmentParts.js\":\"e23cdfa02da0d0a9\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleParts.js\":\"374fa9a6cf019c16\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleRecord.js\":\"7dcedcf7f285601e\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/manifest.js\":\"b97a388dfeb0425f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/takeBundle.js\":\"f881222d091b0ad1\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/verifyBundle.js\":\"9336c6a876cebeb0\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/cleaningStage.js\":\"58586f5cd64dde78\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionKey.js\":\"03bc41be570ba9dc\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionServer.js\":\"fb492f98c6e0272f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flip.js\":\"d42ed5418087cca9\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flipAttempts.js\":\"5d2cf02f9b0cc009\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/pages.js\":\"65e1ed87159df9bf\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/preflight.js\":\"408b6f21d29911be\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/reseal.js\":\"1a35fa265b7c4f40\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runConversion.js\":\"1cdc54a5aa9ac2b2\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runLock.js\":\"81913ae8efa9e410\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealing.js\":\"8e73cc277cdfc584\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealingStage.js\":\"377e4658f704a638\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/stage.js\":\"aa5d9179e3a31dc6\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/verifyReseal.js\":\"a58181927efe9abe\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aad.js\":\"27a2276c60745c00\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aead.js\":\"4bb0238ed7400086\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base32.js\":\"6a973f7a54da28f7\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base64url.js\":\"a61086dafdc0916b\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/binaryEnvelope.js\":\"f737170fd5781a58\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/byteAead.js\":\"abee30708785067c\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/canary.js\":\"5b0f28f3acf62104\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentHash.js\":\"c44a4fc3f067dbfa\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentKey.js\":\"7810048e9b1642bb\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/derivedIdNamespace.js\":\"74c400319a9eb66f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/envelope.js\":\"afd6343b6f681c0e\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/hex.js\":\"0ddf7aa26c1cb501\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/sha256Hex.js\":\"1e00c4e0bdb914f0\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/workspaceKey.js\":\"e3cb8936de22cd1f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/conversionState.js\":\"7795fbcef2e88438\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/createEncryptedWorkspace.js\":\"cf9bbd6552198111\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/pastedKey.js\":\"b3b258b86a92d3fc\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6f8d90dbbe2fc328\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/upgradeWorkspacePin.js\":\"daabdf02bd11395a\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/keyStore.js\":\"f8dd2ee97c8e9b71\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/mintWorkspaceKey.js\":\"df0595523b524c91\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/modePin.js\":\"bb4b6f5d4abebbfd\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/openWorkspaceKeys.js\":\"c76c0833936d5670\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolveWorkspaceEntry.js\":\"245730b4cfd7e626\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolver.js\":\"fa44ea37edfd2fee\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/workspaceAccess.js\":\"3c8233ee8d1e6ec9\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/transform.js\":\"9f417b8302f92e72\",\"/knowledge-medium/pr-preview/pr-1835/src/themeBootDefaults.js\":\"fa0e527886ab2a10\",\"/knowledge-medium/pr-preview/pr-1835/src/types.js\":\"68d9afe287e79913\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/ClientLocalSettings.js\":\"2d707933463e0721\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/abortableSleep.js\":\"5b8abca906ff8294\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/array.js\":\"cfbdc0e45717af19\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/backlinkAutocomplete.js\":\"5e6e32a9d2c12c7b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockCrumbs.js\":\"0651f3efaa275138\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockrefAutocomplete.js\":\"a9bc36e21f616f21\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/cadencedIdleJob.js\":\"e2ec7003e6e055e1\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/callbackSet.js\":\"75cb8e2d3ac18f7c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/clientId.js\":\"1b21980c55361415\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirror.js\":\"c7a68c7eee41ea28\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirrorCompletion.js\":\"04bd606f836f0773\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/copy.js\":\"2527cbd93c25f8f6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dailyPage.js\":\"2c88197bc3edab0c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensics.js\":\"6d8257f3a4b1a7b3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensicsHooks.js\":\"bfea4a604cc51fc4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/deleteBlockThroughUi.js\":\"7005364595204ab2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dialogs.js\":\"345302d15c61cf41\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dom.js\":\"0018a5c031ecbfca\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/downloadBlob.js\":\"68f3fcd4fdbed567\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/exportSqliteDb.js\":\"27285b6e77501212\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fileSystemAccess.js\":\"fc1659cb27ec93d0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/flipSlide.js\":\"2b296d8b31684beb\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fnv1a.js\":\"7d9820f1e7e0a60c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/formatBytes.js\":\"97dbd4719a1a019d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fuzzyRank.js\":\"93891f68dcbc89eb\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idbKeyedStore.js\":\"ae2d72073ab895c3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idleCallbackPolyfill.js\":\"de7a6598723f278e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardAwareScroll.js\":\"9026100725b2a2db\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardViewport.js\":\"41fe8d8f624bcccb\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/lastWorkspace.js\":\"f520e8749044e692\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutColumns.js\":\"2dea4f442846d136\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionDom.js\":\"5339d7b877c4d2c6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionId.js\":\"8e6df4a112368047\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkClickGestures.js\":\"f0075bedb5446869\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkTargetAutocomplete.js\":\"609507918e6068b6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbCorruption.js\":\"538528ab9788bcec\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbRecovery.js\":\"5d68d7b475859e64\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/markdownParser.js\":\"fb0fca9cd1b2f083\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/memoize.js\":\"ff803c3382082b04\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameFieldCommit.js\":\"7cc07ab89bc44924\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameList.js\":\"f6e9a2758a82903b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/navigation.js\":\"c7c53846970659fd\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/omnilinerNamespace.js\":\"95053f273746e9a4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/opfsPageScan.js\":\"4a4dc7803bf86a2b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelClearance.js\":\"dd34c2d75b721de6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelHistory.js\":\"e45623fbbc550242\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLanes.js\":\"a28b896d5f999bf6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLayoutProjection.js\":\"d64313254f9e0af4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelScrollAnchor.js\":\"13357b8c1b2cd439\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelUrlFlags.js\":\"e5150ec2fe106a26\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/platform.js\":\"3fd4919daf9cf74b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/pluralize.js\":\"971746e7e5749ff9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyCreation.js\":\"8afdcce9eb5eb725\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyNavigation.js\":\"b2dc9087e07bba6e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyValueContext.js\":\"a1b8eebd7b2a0cf9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/react.js\":\"9b8aa40642d27d3f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeDate.js\":\"dd26f9d122f12984\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeTime.js\":\"7a21cd27b839b5a2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/renderScope.js\":\"04f8ea82c9391fe7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/resolvedThenable.js\":\"65f19bf97add607f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/routing.js\":\"267e13840d93450c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/safeMode.js\":\"0503fe3ab9d394eb\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/scheduleIdle.js\":\"d66b59f33fb529ea\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/screenWakeLock.js\":\"43abbc45c331477b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/selection.js\":\"0e2fad18726a4bae\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/softKeyboardGrab.js\":\"8a36cd22edd376ca\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/startupTimeline.js\":\"5e34d00c8a88160d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/state.js\":\"a2846c802b49c363\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/string.js\":\"f24f85a0d943bd4c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/surfaceZoom.js\":\"a860d80d8eecd8c7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/time.js\":\"c0a0a21555dcf4c1\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toast.js\":\"0da9d424f693b951\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toggleStore.js\":\"69b8c361a46462b6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/untilStopped.js\":\"b6495bd948732365\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/userActivity.js\":\"b3830fbf83bc9dc9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewTransition.js\":\"7539562f0d180135\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewport.js\":\"f0d962799bca967b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/webLock.js\":\"b870e671a6683af3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceRecovery.js\":\"142e02a9bdff63a8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceSnapshotStore.js\":\"7ddaaecd3c5a05b9\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-compiler-runtime.js\":\"d89ea76b28393283\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-client.js\":\"8e4d99dbc4ffa6e1\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server-edge.js\":\"760a5f4eae2f4c9f\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server.js\":\"7dfb47489e1f1728\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static-edge.js\":\"880f5a08414d50e4\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static.js\":\"be7de46ca38f38f9\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-test-utils.js\":\"93a4172f1a3bc91d\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom.js\":\"e707afdd41b4e60a\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-runtime.js\":\"cccab76af9f1bc4c\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react.js\":\"abc92fd81ec48f8a\",\"/knowledge-medium/pr-preview/pr-1835/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
