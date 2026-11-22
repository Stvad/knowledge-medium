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
		buildId: "7c4983f87b1a-61e91f5a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/\":\"0e9d9c231bd4da3f\",\"/knowledge-medium/pr-preview/pr-1835/index.html\":\"0e9d9c231bd4da3f\",\"/knowledge-medium/pr-preview/pr-1835/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1835/assets/FacadeVFS-BoZeKy0e.js\":\"5fccdc39e3e9d0d2\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSCoopSyncVFS-C554CYtm.js\":\"89d0cdd720b1e1c8\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSWriteAheadVFS-D-ARDwTp.js\":\"111b65c452559013\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CfFcOy3a.js\":\"ccb0717c96dc86f3\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-ecAwXFSi.js\":\"36e79fd0a2bc2403\",\"/knowledge-medium/pr-preview/pr-1835/assets/worker-BVuoIuZy.js\":\"442140cd1ac040b4\",\"/knowledge-medium/pr-preview/pr-1835/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1835/chunks/app-DgRnkyUD.js\":\"51b2278ee32c3322\",\"/knowledge-medium/pr-preview/pr-1835/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1835/index.js\":\"e70deca2a4a7f631\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1835/assets/AccessHandlePoolVFS-BJe-RLwr.js\":\"acbe336f23eaac43\",\"/knowledge-medium/pr-preview/pr-1835/assets/IDBBatchAtomicVFS-DdaWcIgF.js\":\"7d3c7ee66c8bb727\",\"/knowledge-medium/pr-preview/pr-1835/assets/MemoryVFS-CduzpJx0.js\":\"c354dfd2ef37f7b1\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Q_Tx3yzG.js\":\"8a033b0c1634f22b\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-D1J0A38Y.js\":\"0bcebdc41467f094\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1835/chunks/AccessHandlePoolVFS-Bk5ngQ5m.js\":\"b1723c118aba6c55\",\"/knowledge-medium/pr-preview/pr-1835/chunks/FacadeVFS-B4azFtas.js\":\"7d57aee843daccbf\",\"/knowledge-medium/pr-preview/pr-1835/chunks/IDBBatchAtomicVFS-Bx0B1FVo.js\":\"d6d5fd0078ad60cc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/MemoryVFS-C6FikXXI.js\":\"36bc4397588dc3f6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSCoopSyncVFS-KSEQC_Kd.js\":\"b2f26c9352f8475a\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSWriteAheadVFS-DMJVG2rg.js\":\"151ad4a1e7ce8de4\",\"/knowledge-medium/pr-preview/pr-1835/chunks/Preview-Bn2dqLfP.js\":\"0118d010248249de\",\"/knowledge-medium/pr-preview/pr-1835/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/card-B3lpZasF.js\":\"11616d202b427254\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-Ckb2hXuJ.js\":\"a8bdefd29c07a9f2\",\"/knowledge-medium/pr-preview/pr-1835/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-async-B9hR_7Lk.js\":\"bbd850c55cebc0df\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-cAgv7Ezj.js\":\"3a0d779a46aa8844\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-Au6lF5Ji.js\":\"5a0864f9ef2b0b54\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-BpeMZ2AQ.js\":\"3c5c33fec8c44f4b\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-C2KyHWlF.js\":\"8d5fd18b12b13e72\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-Cw1H2myy.js\":\"70bcd02c46112b44\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-DlXG7Hty.js\":\"746ffd5ee0476f85\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-bSk5G5Jn.js\":\"5d2ba4563f78c2cf\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dIxuffTo.js\":\"d6316526508193a4\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server-legacy.browser.production-CHknMdWz.js\":\"4ad00e639576c8e1\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.browser.production-DXbsTi8R.js\":\"5262332a60b9e29c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.edge.production-CZN5Ocz9.js\":\"4cc60629009ca139\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-iBpSbQBp.js\":\"74ab2a83d540264e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/server.browser-BmM91ggq.js\":\"9095e612997ebb9e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/textarea-DHcD7-gC.js\":\"ad209ab7fefc936e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/ui-BS1FazYX.js\":\"52f87b2d63e98038\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite--mV--lEA.js\":\"338ae570feb00b83\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite-async-BSfHuVYl.js\":\"63adf8c77ad564c6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1835/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/src/App.js\":\"2f91ecb030e0f55f\",\"/knowledge-medium/pr-preview/pr-1835/src/appUpdate.js\":\"da4ac68293cc045e\",\"/knowledge-medium/pr-preview/pr-1835/src/appVersion.js\":\"be08d83c23ebb862\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/initialLayout.js\":\"1b27fbf39792d946\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/openWorkspaceData.js\":\"b62ef4cd90f9e9bc\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/resolveWorkspace.js\":\"aff6a26ea78b50e8\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/workspaceBootstrap.js\":\"c792244cddc14804\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockComponent.js\":\"a57920637409e5b1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockCrumbs.js\":\"7c82056a3e1b8203\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockEditor.js\":\"350b84d095029922\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockLoadingPlaceholder.js\":\"9f46ffc933c88baa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockProperties.js\":\"010f8ff88b4b4961\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockSearchPicker.js\":\"bbd7e26b70f53aab\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ConfirmBulkDeleteDialog.js\":\"ec3b694c74864987\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DividerHandle.js\":\"5cc68a8953a4d17e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DraftEditor.js\":\"06d7fbf58ebb4c3e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/GutterPill.js\":\"b33b85cd716a917f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Header.js\":\"f94152f0491e0690\",\"/knowledge-medium/pr-preview/pr-1835/src/components/LazyBlockComponent.js\":\"766132fd91b1e408\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Login.js\":\"0b73be4fa43e5e17\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ZoomableSurface.js\":\"c4ace401766680d1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/editModeKeepalive.js\":\"492fb43a5f96f0aa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8eb404fe50fef6b7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3b5f862384c66b82\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefPropertyEditor.js\":\"cdc93efb400a7d09\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefTargetTypePicker.js\":\"34ff37f916a40e54\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/SelectPropertyEditor.js\":\"7ac97c01b9ad31c8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/TypesPropertyEditor.js\":\"915e909a319185e1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/defaults.js\":\"df1b80e32f0286c2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/kernelValuePresets.js\":\"f36b33652ae272d3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/selectablePresets.js\":\"ffbdb2d2fd4c934a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/typesPropertyUi.js\":\"8a56a5c43eb249b1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/AddPropertyForm.js\":\"e13512803d61f6b3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyPicker.js\":\"298b8152ba72818a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyRow.js\":\"ebbe14058023d310\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/Rows.js\":\"d96296133c2c3ed0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/actions.js\":\"2e72e236eeceffc9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/declarationOnly.js\":\"9cfc431a9d482ebc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/layout.js\":\"05b362627c723743\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/model.js\":\"b77b7a9af03c120b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapeUi.js\":\"7309a7c4323d9779\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapes.js\":\"4fbd677b46e4cd7b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d28a55085d110180\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/visibility.js\":\"cbbf4e54b42c6ce3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanelSections.js\":\"32997c543aa2e854\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockEmbed.js\":\"1386926a6c06bdf3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockLink.js\":\"1142e0291657d8fa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockRef.js\":\"5bc9de03ee454d5d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/ReferenceLink.js\":\"72a658477d9eed49\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuard.js\":\"f5720d8bac4796fb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuardContext.js\":\"173c9dd82f8a7106\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/linkInteraction.js\":\"8473d0d6b229ba70\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/referenceLayout.js\":\"264348061c6a10e3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/useBlockRefAncestors.js\":\"e8982997a41ae8c4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockGutter.js\":\"a12a75d2d41cc0b4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockInfoDialog.js\":\"3e512ff08e53cf3e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockTypeBlockRenderer.js\":\"3d5788e7cae5d31f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BulletHoverCard.js\":\"7fbd706b02939503\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorContentRenderer.js\":\"2ba0c3f699462c40\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6b77a66e09a61c70\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ColumnResizeHandles.js\":\"85ab4a8d38c234a5\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"cf6b7f1fb9c50ac0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/DefaultBlockRenderer.js\":\"a22b3e7f0832d1da\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/LayoutRenderer.js\":\"7552dd4d6abab42d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MarkdownContentRenderer.js\":\"9251b8a305e92c55\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MissingDataRenderer.js\":\"5040abec8262fc65\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PanelRenderer.js\":\"b94e46fd57a721fe\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PropertySchemaBlockRenderer.js\":\"66f161caf449e22f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/TopLevelRenderer.js\":\"fc9e1522821c9157\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockGutterMode.js\":\"7c91a46f034768bc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockTitleText.js\":\"b4cdd1f62f7dc900\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/fieldCreationKeydown.js\":\"671d82a04b0902fb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/layoutRootContext.js\":\"8797f08d0314c8fa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/TypeChip.js\":\"9e75fd307230ba3d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/chipStyle.js\":\"f676d6b6b530fdb3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/anchored-floating.js\":\"4f39fc06b831a944\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/button.js\":\"7ce7bb73e599a518\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/card.js\":\"ab7f88d90aa9bc87\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/checkbox.js\":\"a5218bc552e140b4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/collapsible.js\":\"3f685ce8d180be26\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/command.js\":\"3aea0a688f826296\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/context-menu.js\":\"f7e1193f5a4dd122\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dialog.js\":\"29c1ca4aaa79f417\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dropdown-menu.js\":\"6c2ad140ae5175e4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/floating-listbox.js\":\"a4a4f212b296ca3c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/index.js\":\"1e9f0c39b10a8ece\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/input.js\":\"67752306db945f6e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/kbd.js\":\"40608fd53253a75e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/label.js\":\"6a9fb4b4dee57585\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/textarea.js\":\"ea481c9ac06c6c44\",\"/knowledge-medium/pr-preview/pr-1835/src/components/useEditModeYieldKeepalive.js\":\"8465f2bc020ad7f5\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/BootFallback.js\":\"11e91966debf82c6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/FocusedRowLazyMount.js\":\"fbc9c26909c9a50a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LazyViewportMount.js\":\"16c64fa91843200f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LocalDbCorruptionFallback.js\":\"c71a04a0a5e25da8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/error.js\":\"8507a4d4c000d59e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/lazyMountRegistry.js\":\"a1289f13ec6721f3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/suspense.js\":\"1ba6029acae884ae\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/CreateWorkspaceDialog.js\":\"c3035588fc23d232\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/PendingInvitations.js\":\"212380f87742f7dd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/SyncProgress.js\":\"954c4e4f6330fc32\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/UnlockProgress.js\":\"ffcc5204ea6e4a35\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceKeyGate.js\":\"31d1d53e7ce30d31\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSettingsDialog.js\":\"193414019c6acc27\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSwitcher.js\":\"628efd61e910d80b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSyncGate.js\":\"064f607edcb22a7b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlow.js\":\"a30583085e7b7ef8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlowHost.js\":\"4eb8dc5e21999b75\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/EncryptionSection.js\":\"99de3640b3af3e29\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/attachmentPrompts.js\":\"db63a9f213cfbf0b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/bundleFolderPrompts.js\":\"db7b7b2eaf955295\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowDeps.js\":\"ede2aadbbb1f9dcc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowStore.js\":\"275e500cad459160\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/flowUi.js\":\"57d0551d25a71d1c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/useConversionRun.js\":\"07a09b06a3f17022\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/keyUi.js\":\"5d0a93b220c281b7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnKeyLoss.js\":\"d506b4a6ae1c028f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnServerE2ee.js\":\"eb60ed2ad60a1b75\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/workspaceUnlocked.js\":\"f1ffe13b29c69894\",\"/knowledge-medium/pr-preview/pr-1835/src/context/backgroundSubtree.js\":\"6319a65ac8a15837\",\"/knowledge-medium/pr-preview/pr-1835/src/context/block.js\":\"665107b903bfdac4\",\"/knowledge-medium/pr-preview/pr-1835/src/context/layoutWsContext.js\":\"96bd2fefcba52ce4\",\"/knowledge-medium/pr-preview/pr-1835/src/context/propertyDisplay.js\":\"887378847474ed27\",\"/knowledge-medium/pr-preview/pr-1835/src/context/repo.js\":\"d83a14ba2ca47879\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasClaim.js\":\"5727d889acf6e526\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasSeatNamespace.js\":\"41371e50fa4c4134\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockData.js\":\"cb345764c289fe7c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockType.js\":\"8c007ac328f5eb2b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/changeScope.js\":\"fa171b82915b6420\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/codecs.js\":\"385b97e4a4345cb0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/derivedData.js\":\"dccf07458cc83c18\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/errors.js\":\"82d5c2d152503a13\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/events.js\":\"ffffd53d72c0088a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/handle.js\":\"657924e68e719bcc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/index.js\":\"c01b39be9d4ea119\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/mutator.js\":\"64e8a404514fe810\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/processor.js\":\"bb16f8cabdb9e18c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/propertySchema.js\":\"f295cbb1e6d67f47\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/query.js\":\"6d270a06fb41caaa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/sameTxProcessor.js\":\"6a88093b727da7b6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/schema.js\":\"657924e68e719bcc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/tx.js\":\"657924e68e719bcc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/typedBlockQuery.js\":\"93d38c0af363f3e4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/user.js\":\"4dbe3efa2ec07d59\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresetCore.js\":\"1ad74cb7f0c2a44f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresets.js\":\"16b220e53a67567f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/attachmentCleanerIOVerb.js\":\"d5e6571c1aca09d3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/block.js\":\"2efc126c52f73c77\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockCache.js\":\"d126e7cb99b4f69e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockId.js\":\"6309f3d398251358\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockLiveness.js\":\"2a4b658de9ae8a82\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockMerge.js\":\"2332832035944b08\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockSchema.js\":\"36bc04c2fb38b217\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypeLookup.js\":\"e2f6ebf6f7b4fab5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypes.js\":\"067f01ba8a901196\",\"/knowledge-medium/pr-preview/pr-1835/src/data/clientContext.js\":\"db4549cee4a15224\",\"/knowledge-medium/pr-preview/pr-1835/src/data/dbFileSiblings.js\":\"187267e5c51a2f45\",\"/knowledge-medium/pr-preview/pr-1835/src/data/definitionSeeds.js\":\"cfb4b47fa5815d73\",\"/knowledge-medium/pr-preview/pr-1835/src/data/derivedIds.js\":\"ec62ef5e71212278\",\"/knowledge-medium/pr-preview/pr-1835/src/data/drawnSubtree.js\":\"546b238329f468c2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facetBridge.js\":\"4d7ecfd93d546eb7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facets.js\":\"8c71f5f61e176b84\",\"/knowledge-medium/pr-preview/pr-1835/src/data/globalState.js\":\"c51ec25ba704594a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/aliasClaimRederiveProcessor.js\":\"6ee18d8ab3c0e10e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/ancestorBatch.js\":\"98369c2c9537a723\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/blockTypeTypeifyProcessor.js\":\"a8b6d2515177ffa8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/clientSchema.js\":\"84c3249e2a3dbb66\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/commitPipeline.js\":\"3a453e1ab43c92df\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/devAssertions.js\":\"90b67becd8e97489\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/firstSync.js\":\"0a4217084378d91d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/freshInitialLoad.js\":\"00f260d359549933\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/graphBackfillClaim.js\":\"c19386de368cf643\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/handleStore.js\":\"9d72c0be9182f286\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/idleMarkerJobs.js\":\"23455014c66516e4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initialDownload.js\":\"75a25769b0e16103\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initializeClientDatabase.js\":\"4cd5c6f39b607759\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/jsonCanonical.js\":\"0ed5b9f8abcd8c29\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelInvalidation.js\":\"9c62cbde563ecd4b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelProcessors.js\":\"abe1f0b0b8e1b4b7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelQueries.js\":\"e87630f7b378f683\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/mergeTypeMembershipProcessor.js\":\"8890d42173965338\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/normalizeReferencesProcessor.js\":\"ae59e17fd5a4cb1c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/poolInstrumentation.js\":\"04ef0604c04cfc57\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/processorRunner.js\":\"1baf0f3b5ff3258f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyCellBackfill.js\":\"f22bdf438c1e0808\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildMint.js\":\"bce6ab0d08bd48e2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildrenProcessor.js\":\"d6e52e9a2d733782\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3d687908e71f543b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionSynthesis.js\":\"e75938e2555df43e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyKeyScan.js\":\"2cba8737f6e8320f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertySchemaResolution.js\":\"df0df5b73d0e5f05\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyValueEdits.js\":\"c1568433973aa54c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/raiseProtocol.js\":\"bb00f7671c1907bc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/readBatch.js\":\"f36674897c97e9cc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/refProjection.js\":\"85502f9786800a47\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetLookups.js\":\"d2f3a73a4e9d2b6e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetProcessor.js\":\"ab8e7989488fcd06\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/replayMerge.js\":\"cd84fa0628f1e39c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/sqlBinds.js\":\"158bccb242c999db\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4ff88b830e29bb38\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/arrivalProcessors.js\":\"b21ac3b220141696\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/invalidate.js\":\"2fbb903468bd31f3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/materialize.js\":\"375ce595795c976a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/observer.js\":\"87309d684a78a366\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/reconcile.js\":\"e6dc4db574f26709\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/timingMetrics.js\":\"188b742bfc6d57c7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/treeQueries.js\":\"0d8171a88163ecbf\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txEngine.js\":\"9620810ca69f303d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txSnapshots.js\":\"6764ce700f25f4ef\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/typedBlockQuery.js\":\"f5a852612228d89a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/undoManager.js\":\"f92bcb4955697187\",\"/knowledge-medium/pr-preview/pr-1835/src/data/invalidation.js\":\"46c1074a74163317\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelDataExtension.js\":\"c79bf31608bfc31a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelPage.js\":\"0d627581518af4ea\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelValuePresetCores.js\":\"14c282a08960d919\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbCorruptionSignal.js\":\"d153e55a37486c2b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbStorage.js\":\"52464b7d81bca23d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbVfs.js\":\"aba459a8833e97c9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localSchema.js\":\"c6bc4d9cef692957\",\"/knowledge-medium/pr-preview/pr-1835/src/data/maintenance.js\":\"6fc5b7356e3c728e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mergeProperties.js\":\"cd1f2ffe211f7af1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/metricsConsoleHook.js\":\"fae77b72a8dda26a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/migrationsPage.js\":\"91ab94cb0d1eb3a7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mutators.js\":\"1f49e0cc4a680323\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKey.js\":\"35f281e83a0249f8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKeyPlacement.js\":\"259490f967d0ac38\",\"/knowledge-medium/pr-preview/pr-1835/src/data/outlineSurface.js\":\"09f782c1ccbe22bd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingEditorContent.js\":\"7a08a0742c94bcd1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingUploadsSql.js\":\"e6d4fa187cb3e3d6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pluginStateExtensions.js\":\"ce1ef11320615af1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/powerSyncLogger.js\":\"b51521225082d7d2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/projectorRuntime.js\":\"f6d7426fcd374bee\",\"/knowledge-medium/pr-preview/pr-1835/src/data/properties.js\":\"060f51f34e4524bf\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertiesPage.js\":\"a8a434ae31fa72d8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyChildren.js\":\"710e45c33117a3be\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionFanout.js\":\"a59a6b2920a0105b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionMetadata.js\":\"fc0b92067652ddc6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionRegistry.js\":\"5d020a669e958dd9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDisplayMode.js\":\"6e9ffe2635d4ea83\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyRowCreation.js\":\"f509d2b3c94f06e9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySchemaCreation.js\":\"f248c52bc28b5524\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySeeds.js\":\"fb61fb0c64257a5a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/recentsPage.js\":\"6780cf9038501677\",\"/knowledge-medium/pr-preview/pr-1835/src/data/referenceBlock.js\":\"1df3b8dc5c138e3c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rejectedUploads.js\":\"8dd202f6b6cdec76\",\"/knowledge-medium/pr-preview/pr-1835/src/data/releasePowerSyncConnection.js\":\"6671e81f5db49a04\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repo.js\":\"2323056b1b4c3172\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repoProvider.js\":\"0c8c4c1ce8a75b03\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rowProperty.js\":\"5ab52e0f8eedc494\",\"/knowledge-medium/pr-preview/pr-1835/src/data/searchFilter.js\":\"f43b62d16e5419e0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/seedIdentityLedger.js\":\"adcc1a8b15b9e62c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/stateBlocks.js\":\"ea225edc3cc65cd1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/structuralEditPolicy.js\":\"3e097e0bf7e71891\",\"/knowledge-medium/pr-preview/pr-1835/src/data/subtreeDelete.js\":\"7c5db4742c564292\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncStreamLock.js\":\"cbe08638ce1ff90f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableSqlRecognizer.js\":\"0fc9aa244592ceb5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableWriteGuard.js\":\"fb05f05f8019dd58\",\"/knowledge-medium/pr-preview/pr-1835/src/data/targets.js\":\"82146e95c36ac952\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeColors.js\":\"671bf2d28a9870c1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionMetadata.js\":\"3dd9a28234a8c415\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionRegistry.js\":\"f2a9ab5d22498fde\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeExtraction.js\":\"8f6a856ea05cdae4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeInitialValues.js\":\"a072052988a683c4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typePropertyGroups.js\":\"c05638be538f2c59\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeSeeds.js\":\"33de69338136b914\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeTagger.js\":\"f2477cbac507d3cb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typedRecords.js\":\"5f56c92e9e13f5a2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typesPage.js\":\"43b9c78b01d71495\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userPrefs.js\":\"39e9a9368e552b56\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userSchemasService.js\":\"cc584ea7d6b1ac68\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userTypesService.js\":\"6551ae10e2f2547a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/valuePresetRegistry.js\":\"523b0aedc5263198\",\"/knowledge-medium/pr-preview/pr-1835/src/data/visibleChildren.js\":\"c0b4afac52244a99\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceConversion.js\":\"4abf2565405f830a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceFirstSync.js\":\"d4c5d1dbdf9dc2aa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceIdNamespace.js\":\"f7e7ca181b3e8f1d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceSchema.js\":\"5f59df8fbce41c58\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaces.js\":\"1c802fd801bc040a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadLog.js\":\"53b838bb5cd587fc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/BlockPasteShellDecorator.js\":\"8de2105521912db0\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/atTrigger.js\":\"fe5813ec1499a782\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/autocomplete.js\":\"04079f9429ce1c64\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/codeMirrorExtensions.js\":\"0d1de70db1d02bdb\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/contentFlush.js\":\"944728f48d20cedb\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/defaultInteractions.js\":\"8563a5bcb6fdb6db\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/editSettleSignal.js\":\"b21648f09ceff155\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/insertImage.js\":\"ce60288d3e6b447b\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceCompletionRange.js\":\"d7ac3f9a90c05135\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceTargetTypes.js\":\"8fdd09528d18c297\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/syntaxContext.js\":\"8756786c56b580f5\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/triggerMatch.js\":\"3b4298ec6906280d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/AppRuntimeProvider.js\":\"26fd2b3fdb7ca4bf\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/BlockFocusShellDecorator.js\":\"7db01c9f4d433c09\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/ExtensionRenderBoundary.js\":\"0ef23859d632d688\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/PanelContentRecovery.js\":\"897f14d2fdd6e028\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/apiCatalog.js\":\"d8981e270755f401\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/approveExtensionHere.js\":\"7b78bb0ad801d4c0\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/armedCutAppMount.js\":\"7127bc7190fee7b7\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/batchableKeyedStore.js\":\"ae706c1c75baf8f3\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockInteraction.js\":\"b3f085a1b5c6cddd\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockSelectionAction.js\":\"c57b1a732db88ec0\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compileExtensionModule.js\":\"17a9b7af5796daf4\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compiledModuleCache.js\":\"4f9d7a732fb92058\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/continuousGestures.js\":\"56f16a327a82e5da\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/core.js\":\"f1787b520cfa6219\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/defaultRenderers.js\":\"c9dda7310de65c2b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/definitionFanoutAppMount.js\":\"ef04646f91513598\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dialogAppMount.js\":\"3769b3ef000a9b9c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensionSeeds.js\":\"5d14fd237a097c37\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensions.js\":\"5dab4a85dc9fa686\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/exampleExtensions.js\":\"ccdd4c57cc0b9ba8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionApprovalStatus.js\":\"7c07c7e29b83112e\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrorToast.js\":\"cec445f7a135963c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrors.js\":\"f0a8753eb6bac48a\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLookup.js\":\"1e8ac8fd7d711d51\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionToggles.js\":\"35c7090c1e0e3afc\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionUtilitiesCss.js\":\"f0a20c48bded95e8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/kernelPageDeletionGuard.js\":\"2543fb5546b5d8d1\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/liveRuntime.js\":\"3e88f3762d822886\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/openExtensionsSettings.js\":\"fb43ac3977731c2b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/overridesCache.js\":\"2c7af3e8f9f8b26a\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/pluginIds.js\":\"a00bd82b01252bc5\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/processorRejectionToast.js\":\"1b6ed3a84ddc825c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeActions.js\":\"15831d407639d855\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeContext.js\":\"fed001c38ee3cb94\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticAppExtensions.js\":\"990d3ba9fd5fe1d8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticDataExtensions.js\":\"6a08bdbdb7baab15\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/toastAppMount.js\":\"d1e4e5007d4b3dd8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useOverrides.js\":\"99d8bac0b951428b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useShortcutSurfaceActivations.js\":\"60f073c4993e161a\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/discoverToggleTree.js\":\"3ab235ffd8a97267\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/facet.js\":\"edd83848ea9944f7\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/resolveAppRuntime.js\":\"bb42f574530a839b\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/runtimeEvents.js\":\"98db018a7f630277\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/togglable.js\":\"3b156a98ce455dc2\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/variantFacet.js\":\"6df7e6543b487624\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/verbFacet.js\":\"4170f42fce93500c\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/block.js\":\"e45b9abd7f904911\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/focusedChild.js\":\"feee8206f0d3475a\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/propertySchemas.js\":\"2d5e92ac8248e846\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/typeRegistry.js\":\"d618d8e7c1fd8d28\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAncestorCrumbs.js\":\"bd769efd750be3f1\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAutocompleteListbox.js\":\"f266f4d312c58c95\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedSearch.js\":\"fb0e4129e92097ca\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedValue.js\":\"4cf53d1f5761b3bb\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsFocalRender.js\":\"227199e805a7bda7\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsReadOnly.js\":\"867d01975876be1b\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMaterializeBacklog.js\":\"92da1e81b68eb6d5\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMinuteClock.js\":\"e5630b4bf9bc76ee\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePanelLayoutProjection.js\":\"16846e867b7c2f46\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePendingInvitations.js\":\"c1379095d44db6a0\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRendererRegistry.js\":\"2360fdc3a9053170\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRetainedFieldRows.js\":\"c6b84fdd8160449b\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useWorkspaces.js\":\"3172e17cb4a4633d\",\"/knowledge-medium/pr-preview/pr-1835/src/lib/utils.js\":\"16f892e7d11df120\",\"/knowledge-medium/pr-preview/pr-1835/src/main.js\":\"b5807afab18becd3\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/MarkdownImage.js\":\"446904e0b22a97ea\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/blockSeparators.js\":\"ea298c8d2e63780c\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/context.js\":\"1d8159fc3fbbe96f\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/defaultMarkdownExtension.js\":\"d1af459ad804bfba\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/extensions.js\":\"833c0fafd461d607\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/renderMarkdownHtml.js\":\"b9c2cd651448c26e\",\"/knowledge-medium/pr-preview/pr-1835/src/minimal-editor.js\":\"80a0667e57c479ff\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/armedCut.js\":\"9f23982c0e1e1b90\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/captureMediaVerb.js\":\"fd21fdf8215e8760\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/clipboard.js\":\"672a0b4095935858\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/decision.js\":\"2d4e02f6d81f73cb\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/operations.js\":\"6dff1bb80f05017a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/AccountHeaderItem.js\":\"0c8d76e4e9808e31\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/index.js\":\"7aae63fdddb58f0d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7b9a1605439eff1b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askAgent.js\":\"7078a8e861eaecd4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askedStore.js\":\"f3aefe64f31fe35f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a1d2f1ac1f5e5c7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/chipState.js\":\"a8acdd5df18d1dce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6a7bda4cfc0d0f53\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/index.js\":\"ae29743e7343caee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"0235ef94b816c579\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/schema.js\":\"6e872c808d63e598\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1726b2ec69a54d60\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/BridgePairingDialog.js\":\"62808a132f145e4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/addMedia.js\":\"f5d1b9ebe033dc76\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a4993a71a36f1b1e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/block.js\":\"b878eec288ecabab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/context.js\":\"4dc8c1f685ecede0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/displayIds.js\":\"16a4a1c1e7351aaa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/index.js\":\"11888611dcf77d55\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/outline.js\":\"aeaca8abac35529e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/properties.js\":\"7ea3b482c5edc090\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/refs.js\":\"d5f499c30f19c411\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"85303046087a22db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/search.js\":\"9f826f7b732f0eff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/shared.js\":\"da147b8ee57ba7cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ff6e8fc1e0c01aa5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/text.js\":\"5444a6186889c175\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentWrites.js\":\"16772359d76bfcda\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/authoringCatalog.js\":\"479bb680185a794d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/blockRefTargets.js\":\"c054d0c154434a39\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridge.js\":\"fbb673f7d38d6ebd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridgeLoop.js\":\"f4926a627fd7249d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/changeHistory.js\":\"fdac38b03b72a695\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commands.js\":\"2248099336f8d485\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commentsCommands.js\":\"ed57b4ec445f203b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataExtension.js\":\"1d035ebcd2cf3cea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataModelGuide.js\":\"2cada5970a741801\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/describeRuntime.js\":\"aece30251eadaf3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/extensionLint.js\":\"1c0df7d091b619ad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/grainAudit.js\":\"00245a59cf09eee2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/healthCommand.js\":\"4d5a78a82021acaf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/index.js\":\"dca1a4fc7cf6e1b8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/presetIdentity.js\":\"9b18925ac7c2a1e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"920828ba238e47a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/readMedia.js\":\"74ce9e064af913f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/schema.js\":\"2994f0c2017c1e0b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/serialization.js\":\"af5fb25eda676f48\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/targets.js\":\"2845c673d46c65d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/tokens.js\":\"bbfe061d8065e74f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/watchEvents.js\":\"024884984cbd566b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/workspaceGuard.js\":\"839d4685b5fb295d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/writeCommands.js\":\"eb8ad923456f526d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/AliasCollisionToast.js\":\"0c758024c2cac3b7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/DuplicateNameBanner.js\":\"36c520b67d53f02b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/collisionMerge.js\":\"5ad44898124be70c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/dataExtension.js\":\"6bac93371fbf63c9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/index.js\":\"649fb2c185174cfe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/mergeCollisionAction.js\":\"70235fd35b959b1e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/pageStyling.js\":\"4914842f46a4e7a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/rejectionToast.js\":\"72e55bc50dd39f33\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/syncProcessor.js\":\"157eaf3daec7c164\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/actions.js\":\"77f18d707083fd01\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/addComment.js\":\"e3cb9930e4c618b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchor.js\":\"379f9a78cfe2e308\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchorState.js\":\"7b1d863eda4a51ea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/commentLinks.js\":\"44c30fec8c2a98fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/confirmThreadDeletion.js\":\"b399c6d879247fa6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/container.js\":\"48fb4278c34e7d70\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/dataExtension.js\":\"6e86d01cd5ef161f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/deleteComment.js\":\"fc501f0f524459e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/highlights.js\":\"5c98613ed52ffdec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/index.js\":\"2ada9d4bb181a0d0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/linkedCommentsPill.js\":\"cb204b478191519a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/margin.js\":\"a3dfbc3b5e84c090\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/marginSchema.js\":\"241eea3ab3c5128f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/newComment.js\":\"a597a09f0b759947\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ownThreadPicker.js\":\"a3276765df1a71b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/placement.js\":\"05570708a15c6c5b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/queries.js\":\"381917f2b888f8ca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotePosition.js\":\"71add334f4b28e6d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedIn.js\":\"80c4ad95d6997f4d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedRange.js\":\"860fb3ce0babf5e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/rangeRefs.js\":\"a96961a640651916\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readHighlights.js\":\"9feaf9d71439ece4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelection.js\":\"f1d68629b418fe45\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelectionUi.js\":\"afd4908da397fc21\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/reanchor.js\":\"00f7de0428546ca8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/schema.js\":\"21d183a614d9a35a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scope.js\":\"f2dc6c68111ac233\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scopeThreads.js\":\"9f60d331fb7421f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/splitRetarget.js\":\"cb73b0b35e832ea2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestionCard.js\":\"ea1b5879d7b727d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestions.js\":\"34bf745d41ee8f75\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaries.js\":\"8e10120defd4f6ac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaryBatch.js\":\"7fbe9d1d9c24aa96\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/surface.js\":\"faf4bd2299d61609\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threadNavigation.js\":\"0ea82a1301006f1a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threads.js\":\"4e28d770c1bb73b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ui.js\":\"e81d818ad6db3672\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/uiStore.js\":\"f76101f147366cb2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/appIntents.js\":\"f1bb8f88db303ad1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/index.js\":\"6842bfb84b7fee95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/index.js\":\"156346180c69c904\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/status.js\":\"59a101c0e2c9421f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"189f5a963038ae4a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaBlockRenderer.js\":\"5e59f621e43886c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5ec641a374ef07f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaUploadReconciler.js\":\"3feba2b4d7850932\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetDownLane.js\":\"c03e2e5672c8ec96\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetResolver.js\":\"35040d1aec5e4dde\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetUpload.js\":\"c541602f21701952\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/attachmentCleanerIO.js\":\"3455f60658eca685\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/supabaseAuditIO.js\":\"27c1affd7ee21796\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/blobStore.js\":\"a88698c7e8bd9634\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/byteStore.js\":\"c27a0b1f44916740\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanerIO.js\":\"1225b7e430475f61\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanupAttachments.js\":\"cd7cee4b32fcc1a2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/dataExtension.js\":\"f09d0eea59bdc927\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/downLane.js\":\"026c143a12ef04dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/index.js\":\"0847528081478cdb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/insertImageContribution.js\":\"b875498c9e688bfe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneArming.js\":\"ccd6c239b30dacde\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneLock.js\":\"a93c3fd05dfb445a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaBlock.js\":\"fbd8a64c8b94cefb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaCapture.js\":\"7e36cf7f7bb64821\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewers.js\":\"bb1709b3508f1868\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewersFacet.js\":\"494a3ac5d1b90adb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/pasteCapture.js\":\"71fa21ec1b9d08ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/resolver.js\":\"581203649785e62d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/retryUploadsAction.js\":\"0ec656ffb55d0548\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/storagePaths.js\":\"baa5a9cf2779deb0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadDrain.js\":\"5cd0c85b239b9c30\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadLaneStatus.js\":\"02bd6707386c149b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadReconcile.js\":\"913da62def5893d0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadRecovery.js\":\"e865312b6fddd3ba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadStore.js\":\"935c5bdc7b90a7f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/useAssetObjectUrl.js\":\"ba26183b4476201e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cc612d965957bf50\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b33758de1d146977\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/facet.js\":\"65cff25d186686fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/index.js\":\"c3cbe6edb86e02a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/prop.js\":\"4e43ece3a757fb11\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinkFilters.js\":\"249bee566f4448aa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d9b76263bdb98f8e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BlockEntry.js\":\"11359f4e9641059f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/LinkedReferences.js\":\"3bf6e82c64ff136f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2b3d1bff4cef22fd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dailyNoteDefaults.js\":\"6ae68f1d0fa0df76\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dataExtension.js\":\"1036dff1c0dab13d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/edgeExclusions.js\":\"5e17a610cbb778c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/filterProperty.js\":\"acc72cf291dfb75e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/index.js\":\"173cf143f813ba0f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"59e8978905ea6437\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/applies.js\":\"a2c9d80dd22b56dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/countQuery.js\":\"248ed70e5fddf821\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4ee70b5d1e327bfd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/index.js\":\"5ba53a651db4ea6d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"887a97175a8c9c7a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/presentationInvalidation.js\":\"f7c0bdd43b526af9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyEditorOverride.js\":\"233edec3db9fdd18\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyFilter.js\":\"ab95f56258d0b7cd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/query.js\":\"caccee14d8497a14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/resolveFilter.js\":\"247f3a286ec82c97\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sourceBatch.js\":\"733a5de0db0f4342\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sources.js\":\"7865532f8ab2394e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useBacklinks.js\":\"ac95d28ab791bd69\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d2c22b48e06dc9d1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayCelebration.js\":\"1dda92cf73f9ee21\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayOverlay.js\":\"f932b557f977304b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/gate.js\":\"03bbf17baf9403d4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/index.js\":\"f15c4f15bfc157fe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/wolfTheme.js\":\"22e71ec0536f7500\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/BlockDragLayer.js\":\"b949aba554df7b38\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dragController.js\":\"2cc4edc02d533748\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dropTarget.js\":\"ddad7d2f5627b205\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/index.js\":\"4161e61b6959ac27\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/projection.js\":\"908cd8eb61579aca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/BlockMetaCard.js\":\"ab4fb3482d7ad97c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/index.js\":\"a7728638762fe38b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/AddTagDialog.js\":\"f15841c891169178\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1ad0db28a6bbfa39\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/TagNameIssueHint.js\":\"6e735b786b8d81f7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/addTagAction.js\":\"77313d6a4067b83d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/appendTag.js\":\"d320f00a663711df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/config.js\":\"c1229b36d3ee1b20\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/dataExtension.js\":\"a4cc440a85c31353\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/index.js\":\"360e633050a99a1c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/propertyEditorOverride.js\":\"5df9989d48e4d9a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbList.js\":\"683c33d69ba23965\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"da6868ba7304ed2b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/Breadcrumbs.js\":\"534b29be622e77b9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ce66bef393184c99\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"66c7cc88f7c13466\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/index.js\":\"84465d59c519f0ca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fae026e3d8971218\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/CharacterCountItem.js\":\"082558bef4a998d4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2bf1019a2863d38b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/actions.js\":\"57b371524f0b4212\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/blockType.js\":\"7ed7b0bae98d1a03\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/charCount.js\":\"397afa5df77d34fe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/dataExtension.js\":\"d3f8be97d1a3bc59\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/index.js\":\"10fd656accb33cc2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/profiles.js\":\"4bbe15ff6144adaa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/properties.js\":\"a804cd6f9a52fb06\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/textCounts.js\":\"2cb5d2a3061c9ea6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/colemak-keybindings/index.js\":\"5c1942bd8a76107c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/CommandPalette.js\":\"cf89269c16f00547\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/HeaderItem.js\":\"a8d000e972afc03a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/context.js\":\"fbb958a9d8de7679\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/index.js\":\"2ebb68c295e56b7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/selection.js\":\"c2872a638a88b38a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/toggleStore.js\":\"3fd16364ef17e16f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/useCommandPaletteActions.js\":\"7ab4dd848f4fec65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/ContributorBadges.js\":\"5a541ccba9f96aeb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/author.js\":\"eee1707fa0a21a38\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/codeMirrorExtensions.js\":\"c2927aff1e93fe51\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/dataExtension.js\":\"7c2e4fc4abfd8d5a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/index.js\":\"65fdf37d2c353c95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/mentionAutocomplete.js\":\"60224d3cdf7a38cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/processor.js\":\"8c02df2bc69c7e97\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/profiles.js\":\"613d996523041680\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/queries.js\":\"b10dab16e8550f51\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/schema.js\":\"8bc7d06f6d80d60f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"939b0b97712c9cbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f6697654dce1dd07\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/index.js\":\"91ca1c287357d8bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7614acb7ef61e8fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"8f3d4b61b8174b3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/CalendarGrid.js\":\"9f68849d5abc892c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DailyNotePicker.js\":\"83d1112f52709c5f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"35e213ba6b6cedf3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateNavDecorator.js\":\"04e82d36be285462\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateScrubOverlay.js\":\"2d0206f8671935e8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/HeaderItem.js\":\"c44ce1b8eed5a65e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/ReschedulePicker.js\":\"339a03de07ec5d18\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/SpreadDatesDialog.js\":\"83dd503db7148506\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/actions.js\":\"4fb53821397ac4e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/blockDateAdapter.js\":\"b4300ab83a996fd3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/calendar.js\":\"ccad8bcb0008bab3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dailyNotes.js\":\"755b392aaa879104\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dataExtension.js\":\"e151e22347e9f85b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubActions.js\":\"36ce404c112a6015\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGesture.js\":\"241a6d41c15c9304\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1f56a3a9629eee25\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubRecognizer.js\":\"bd294faf78f40926\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/deletionGuard.js\":\"554284c138333ef1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dueQuery.js\":\"1e754f91062f4605\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/index.js\":\"f4357862c4208579\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/landing.js\":\"fe73f781a8f65359\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/localSchema.js\":\"c316807cddb88bc8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/referenceDateAdapter.js\":\"54da76260931ba1a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/rescheduleAction.js\":\"a4ebba7c702c9d1c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/schema.js\":\"6ebc5c88e6332ed2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadBlockDates.js\":\"622ba8dd937479dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadDatesAction.js\":\"1ae01338ead1230d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/today.js\":\"af76fbd5f07a2d3d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a7752b220a1aef7e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"32250a1652cd0cca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/audit.js\":\"4f29739b3dea27ac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditAction.js\":\"9dad247f158079ca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditRanges.js\":\"a7f17d13cf1c84ac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/diagnosticsSource.js\":\"e6585a013a89c498\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/divergenceScan.js\":\"81d063a52ec43a06\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/index.js\":\"39fc457ea7d57dd5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/propertyChildrenChecks.js\":\"99e477d159899719\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/referencesMirror.js\":\"5c101334561f0a8c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/rowJson.js\":\"2a6fa63064367d71\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/schedule.js\":\"6117640b4cab1aed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/store.js\":\"8b76c2028e69a7b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/action.js\":\"f5c5f85c55c24c82\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/index.js\":\"6deac33e7078db85\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/plugin.js\":\"be0222d7d84f2dc7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"dd4255845dccf209\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/actions.js\":\"f4e53ffa4f62053e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/changeMarker.js\":\"669594534384e22e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/diagnostics.js\":\"c1bf6960040d0e9a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/fileSystemAccess.js\":\"29db852936b2608f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/filenames.js\":\"90564595b42c2a00\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/index.js\":\"f4f4854d4d00cc97\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/mirror.js\":\"09fd756227afcc1c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runLock.js\":\"75e9ce47c53cd193\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runtimeHealth.js\":\"3358868b22cb29f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/schedule.js\":\"aea4b3ae62bef5d7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/store.js\":\"5a8d675a0f61a1f9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/index.js\":\"0dbcd9c6caf9bf32\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/themes.js\":\"5f9c05e55c0e8cab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/facet.js\":\"936bceb756085976\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/useDiagnostics.js\":\"e7470a0c5bfec165\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/dismissals.js\":\"d86e0091de73ddd9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/index.js\":\"80bb7076ebfabcf1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/status.js\":\"9f580af89b011710\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/store.js\":\"38df5d34069adc50\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"260130b6c418d245\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsSettings.js\":\"663ff804a10e54f3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/actions.js\":\"a2d3ce4669179933\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/config.js\":\"8a5bcae03396e3c6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/dataExtension.js\":\"fdec84a3c2acc88d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/effect.js\":\"078755627dd824fb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/index.js\":\"22405778918a352f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0ce05b2e4afc0d2f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/useToggleTree.js\":\"62232d35bcf0b35a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/ExtractTypeDialog.js\":\"00303eccd8c6e988\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"a586dd2cf5f5b103\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/PropertyShapePicker.js\":\"68f1cbdc2dc4826b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/action.js\":\"5385eab467723ccb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/index.js\":\"e45d2eab05e0c127\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/FindReplaceDialog.js\":\"1f8aabb84a166176\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/HeaderItem.js\":\"eaf0fbcef075c61f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/dataExtension.js\":\"a0a96e43a98fd701\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/index.js\":\"856090d87c85fddc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/search.js\":\"4c2ed20d73cbc934\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/toggleStore.js\":\"da5ff4e70962151c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/LocationPropertyEditor.js\":\"130256ab2fb55685\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/MapView.js\":\"1806979a4ff45029\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/blockTypes.js\":\"63ad7786799b5e48\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/codeMirrorExtensions.js\":\"7c9f96e6c223894c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/createOrFindPlace.js\":\"81963893bdf60f76\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/currentLocation.js\":\"835f1206f98773d3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/dataExtension.js\":\"bb34d7da8b7e0d3f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/geoContentDecorator.js\":\"5068b77c207f7514\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/googlePlacesClient.js\":\"47e7097f85f49a0b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/index.js\":\"ade5a4e701250e59\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/locationsPage.js\":\"960703fb1a2fb49b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/mapViewport.js\":\"77577a7cff31a8b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/pickCurrentLocation.js\":\"6ff072f2b32f780c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeAutocomplete.js\":\"d1c6fe91e946e2f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeNameCollision.js\":\"5b0c5f1189815d95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/properties.js\":\"ad6d9741117794d6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/propertyEditorOverrides.js\":\"ecee71faaf350d58\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/query.js\":\"267ad1fe030be338\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/usePlaceSearch.js\":\"0543c0e481972402\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ce1f4dc551b452e2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d8d46a41d8f274b9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b17a645817a2abbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/config.js\":\"e731e1e527259867\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/dataExtension.js\":\"9554a0942926d89a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/facet.js\":\"c8d123927beca797\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/grouping.js\":\"12e676dc7c65257d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/index.js\":\"b718c8c42170b162\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"279a34528845a675\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/query.js\":\"05f64c0593382aeb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/resolveConfig.js\":\"3d8f1e7b831a9960\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5671e0afd93bb8b8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9d5306cf608bb1da\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlDocumentContent.js\":\"30bf89a58264fc63\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlFrame.js\":\"6a02d79ce33cdbc8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/actions.js\":\"583bafad237191fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/blockType.js\":\"f4d6142bf81e4f59\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/confirmRunScripts.js\":\"a5cf63c0b1db9ff3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/dataExtension.js\":\"b1a1b07a62297e2f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameAnnotations.js\":\"3a4c2a88bd8cfed5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameDocument.js\":\"e348653da7ee48c3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameTheme.js\":\"20c50272bafdf888\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/index.js\":\"62d4302305d1bb1f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/scriptConsent.js\":\"2dd8ffc021847806\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/sourceMap.js\":\"bfa75ae75f0d47e0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/useDocumentScripts.js\":\"f2055ecf5b74d8dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/index.js\":\"f4e332b465b72429\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/record.js\":\"cf11f5b30426c752\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/recordStore.js\":\"71f8e1d33377b580\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/responsiveness.js\":\"efba1b8b6a5821bc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/schedule.js\":\"70caa95839b64fd0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/sessionContext.js\":\"06e806b90bcdea8f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"541f99b6da5bd7ba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9d34c46da01bfda0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/actions.js\":\"ace0026e39900561\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/config.js\":\"852cc3aaa66430d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/dataExtension.js\":\"e79142b384dc951e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/effect.js\":\"591b1413caf8b25e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/index.js\":\"cfeb261799691347\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/keyCapture.js\":\"f03f5b1b0251aa5b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/overrideStore.js\":\"d44c3f22cf075831\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"58723dc992b6360d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/HeaderItem.js\":\"76481c29c174f7ca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/LeftSidebar.js\":\"f702dc15bd100310\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/actions.js\":\"cc68eb8ed88f8548\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/facet.js\":\"2e8b9c5582f4d91d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/index.js\":\"d47cef2282fc8b34\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/shortcuts.js\":\"c694a9c156b83533\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/toggleStore.js\":\"496da57fc6c3f438\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/MergePicker.js\":\"8ba8823dec6c9d99\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/index.js\":\"5b1798489f89abde\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/mergeAction.js\":\"769c30dcf5a09316\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/strategy.js\":\"57ad38ab2baad935\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/Button.js\":\"3e22ed5f56939cd7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e21a416964e2bf7c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ad72114bb2c684bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/facet.js\":\"c085ea9c69e0ff28\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/index.js\":\"c066270dd99b6307\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"85879ac5bb7a4bff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/actions.js\":\"80265987768e5641\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5fb7030613f63e1d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/facet.js\":\"fc74ca03ade6c726\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/index.js\":\"344cf173254b84cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/MoveDestinationPicker.js\":\"de8575bdea5c6047\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0e05e10c670f7826\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/contextMenuItem.js\":\"a7b0634313906d46\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/index.js\":\"74d7c2c9de200d13\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveAction.js\":\"f35272bb7a6e81bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveBlocks.js\":\"f23913e9ae81f27e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/selectionAfterMove.js\":\"aeac269ce9fd767e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/TutorialBanner.js\":\"543dce7cb7429f78\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/action.js\":\"9a407b201301d59e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/bannerDismissal.js\":\"f4f125e5ed9a3347\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/documents/cheatSheet.js\":\"6fb2468846963301\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/index.js\":\"43f33245cb943f13\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/keys.js\":\"439232d0c859da1e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/landing.js\":\"fb7dc056db560d62\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/outline.js\":\"f80e637a9bf49ef7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/seed.js\":\"3bd7faef969c9fc6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0c85df89517f1dc6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/analyze.js\":\"fe744490097d6b0d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/diagnosticsSource.js\":\"afec66ab4fb16e05\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/index.js\":\"f99cc91956460607\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/load.js\":\"6342cf65521b3047\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/monitorRun.js\":\"fb4022770e33599e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/schedule.js\":\"081a0d446835163a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/series.js\":\"cd49d94205cbea61\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/store.js\":\"3e3a7e338f1e276e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/trendAction.js\":\"a0a4d90a05b57828\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/verdict.js\":\"efeaf680c79c4809\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/clickToEditAction.js\":\"c1e8b8810821247f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/index.js\":\"7367c7630b9d13b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/interactions.js\":\"42810db52cc200f3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"6e901e1d0406b6ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGate.js\":\"738e3d41633e9d6f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGateDialog.js\":\"de5a435262ce241b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/action.js\":\"fedd3b4709bab80c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/index.js\":\"7f6fdca8fe23e3cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/localRunMessage.js\":\"63d5d09ce56ec93c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/plugin.js\":\"1846eab1a9615c72\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/progressReport.js\":\"d956a66cdfc06d14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/sweepProgress.js\":\"2ac66aa4450aa0fd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/FieldRowRenderer.js\":\"f8d40cde39ce56fe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/ValueRowRenderer.js\":\"0449644b3e30d2d2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/actions.js\":\"840a5fe02afa70ab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/autocomplete.js\":\"83f5d6fa6ccd9ee2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/fieldRow.js\":\"ca1a7e9e1b38247b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/index.js\":\"676bc00f7f8a3b57\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/referenceWarning.js\":\"89db1368447590f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueAutocomplete.js\":\"c67cafcde87e184f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueSchema.js\":\"9ea4843551e22096\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/HeaderItem.js\":\"2d1b6fd2a7819a41\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/QuickFind.js\":\"02820c72e8d76c00\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/index.js\":\"afa0ee65c0234d95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/recents.js\":\"fb92d5200e03f3e0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/resultItems.js\":\"10e64ec70c61c0e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/selection.js\":\"568e1533026b87dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/toggleStore.js\":\"17f41dbfcd9accec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/HeaderItem.js\":\"05786daa4db4aaa5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f06f3fe7c2fd7d36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/grouping.js\":\"17050df9e05521d8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/index.js\":\"5c07dd34913b5845\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/target.js\":\"94b37a2f21df1068\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/codeMirrorExtensions.js\":\"408ce655a84770e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/contentPrefill.js\":\"3247459f1b5b2412\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/dataExtension.js\":\"c2ea5fc95357a06e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/index.js\":\"3a97de7b84a97666\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0c81f9df40a1b839\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/invalidation.js\":\"6c6a1381e00f01c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/localSchema.js\":\"1a5a44954c14d7ab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/index.js\":\"5e1f527ee8c82511\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a4f805b09459844b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/index.js\":\"b4620db18f0b88ec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/referenceNode.js\":\"8be0d8932cc30298\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e581c840be616ef9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"63a169177da9c7d0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/index.js\":\"2aa446ddbc4dc93d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4c2b39235324e384\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7fc26cdb1a43a70d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/mergeRetargetProcessor.js\":\"62e237dbe581ac3f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/parseFence.js\":\"bcd0c40c959f8370\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceParser.js\":\"70147dbcc0cc0b97\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceProjection.js\":\"5126c4963e7be903\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referencesProcessor.js\":\"37961c309cb5d965\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/renameProcessor.js\":\"c6eef541ba0f00d3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/spanReplacement.js\":\"32fc44e796410d8d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/htmlToOutline.js\":\"de3b9a5e726b3c40\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/index.js\":\"75651e0dbfd79588\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1965e36aca7ef3ec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/pasteDecision.js\":\"7bba7892471d57ca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/action.js\":\"98a73b06ccfb1f07\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/blockIds.js\":\"23e4912dcf3019bd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/content.js\":\"e226e2f7bb47e86b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/effect.js\":\"11f9e6e14c8edb99\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/ids.js\":\"68d9ff7dfd247b11\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/import.js\":\"879cc345d6d795db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/index.js\":\"644a3de727482af4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plan.js\":\"3e8305b339bff6d6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plugin.js\":\"3fb2ca74091b40ce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/promotion.js\":\"b850a8bf6d56bf42\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/properties.js\":\"219b4d7ddfa2db9f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/references.js\":\"c272d9e591d8ebb8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/report.js\":\"a3c3c4d0c1c5001d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/roamMemo.js\":\"e2ec4dbf452b2213\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/runtime.js\":\"a8755168cf5dac55\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/schemaReconciliation.js\":\"11ba7ebec1d55439\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/srsMarkers.js\":\"64acbf255cd403a2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/todo.js\":\"5e6906f13f853e77\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/typeCandidates.js\":\"ee7c40254b4cb269\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/types.js\":\"ce74ac5f039a71ad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/index.js\":\"3dc8e1a6f0497d5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/store.js\":\"9e0cb73f88868857\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/HeaderItem.js\":\"c84c379d170af0de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4429ab044f78d9df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/index.js\":\"53c8eb7e96970c83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/model.js\":\"b563d6f589dd7f08\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/toggleStore.js\":\"6c9a3cf570600b49\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/useKeyInspector.js\":\"a1f76c3657953140\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"96df9a2ab4db520b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/ShellDecorator.js\":\"d69e51959e6e3ea3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/actions.js\":\"9400aa4267d25180\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/exclusionsFacet.js\":\"552261aa779e5cf0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/index.js\":\"5288204e25a0dab5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/shell.js\":\"ad5767098ffea451\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/surface.js\":\"bdc8d1e157e21c5b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/walker.js\":\"0fc464ff8ff876b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1e1a8966dba517d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/dataExtension.js\":\"389a8abf76b43552\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/index.js\":\"6be05a32d7526ce4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/indicator.js\":\"4f953466a2f07367\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/moveSrsState.js\":\"1ed57f4265c5f33a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"417e5ef27a82cede\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/scheduler.js\":\"5d703fe5ed90b06f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/schema.js\":\"36553a15dec38fae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"bf9afee30f16a69b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsClipboard.js\":\"e73c91e92175527e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"147e66d78b4e60a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DailyNoteReviewHint.js\":\"248f08232c00e3b7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DeckPicker.js\":\"4a48c3465a40e5fb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewControls.js\":\"ebd8a47dcf85c06d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewDeckRenderer.js\":\"35fc2ca6a6d1ebdb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewSession.js\":\"1c0f277b69f94a50\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/actions.js\":\"1a479445c0b31909\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/archive.js\":\"162148dc69c4901e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dataExtension.js\":\"06de5a7ce2931f52\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/deck.js\":\"7980c9df1174828d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dueQuery.js\":\"655b38beaee60bf0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/gradeDecision.js\":\"5473158f8b460d52\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/index.js\":\"6b6d4ad93316b7a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/keyHints.js\":\"1a3b41e97fc8114e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewCardLayout.js\":\"2a514043aaf35bda\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewProgress.js\":\"dd73d6d536c584b4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/schema.js\":\"aed5481447f5609c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/useDueCards.js\":\"15d212f3c285601c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/index.js\":\"75653c1ff03ae03a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/record.js\":\"cb11cdee905507e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/index.js\":\"9de8b194f848a6d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/persistenceStatus.js\":\"30d3bed2a3660fb5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/requestAction.js\":\"6649c261ef583876\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/TypeChipsDecorator.js\":\"836e270c2b04894e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/codeMirrorExtensions.js\":\"10244b94002a19cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/index.js\":\"b80050cbdc81a987\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/typeAutocomplete.js\":\"8d7a2a2c299899bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"126ce43c996566f5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/actions.js\":\"4a29c2cefb36bd8a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/anchor.js\":\"cd11db3ee3bacae2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/events.js\":\"01c337bb13108632\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/gestureActions.js\":\"4bd72af46886d81e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/index.js\":\"8ab5f332102746d7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c139129bb38020b6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/collect.js\":\"bc876e5c85cd1123\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/index.js\":\"e829883e4f4e0385\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/record.js\":\"591cc47d5c724b49\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/RejectionDialog.js\":\"a03f676da151bbf3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/SystemStatusHeaderItem.js\":\"8a95784eda983bef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/index.js\":\"1f6ced846086f7be\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/model.js\":\"125ec0b2a0602085\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/queueCounts.js\":\"8090767adfa57b56\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rejectedHelpers.js\":\"da422c24f0c627b8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rematerializeAction.js\":\"6b4293b168598795\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/useHysteresis.js\":\"77c704b82a8fd082\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/ColumnHeaders.js\":\"0c53967b74f9b35b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/TableLayout.js\":\"6a5938c561d7427a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/actions.js\":\"77bdd2b73edb3034\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/cellEdits.js\":\"a4e1736e125323df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/columns.js\":\"bb3e48e333d7e202\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/controller.js\":\"e5517052c7138bc0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/convert.js\":\"245cbd272820b98e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/dataExtension.js\":\"a170bc1d8cddfa18\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/index.js\":\"28fbd18a0fac8943\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/keys.js\":\"ae5bc0d41dfa38d7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/model.js\":\"ce6041c7f202acc5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/format.js\":\"21f633e7fd852d95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/parse.js\":\"21e20ef6fba64bad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/registry.js\":\"33d4fa9357ca2840\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/schema.js\":\"d70656076e11bc10\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/effect.js\":\"f3248bc362820fa9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/index.js\":\"5d7a2d9e9a11bb3f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/theme.js\":\"07ecaeda652cf054\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/actions.js\":\"3b0b13555cc43ed1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/dataExtension.js\":\"454f8ba8aa0052f2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/index.js\":\"bae93056de460d93\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/schema.js\":\"9618baa31d42ba75\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a2fbcb8af8246d29\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/actions.js\":\"ebee1d08b37fa754\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/defaultItems.js\":\"82e299d7d83bf2ce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/facet.js\":\"7e064201ad2fc750\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/holdRecognizer.js\":\"bad1801264e158bd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/index.js\":\"8e8eeda564f5c3d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/UpdateIndicator.js\":\"18f162554eb3089c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/index.js\":\"0ed9e3090cd62286\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/loadTimes.js\":\"aab8e0ebe7707f32\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoNotesRenderer.js\":\"8da12d23eb584ef7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoPlayerRenderer.js\":\"6a75388413405bda\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoTimeStamp.js\":\"f01f28df6e4529c9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/actions.js\":\"8e36f595ded36f9d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/index.js\":\"6a78da4654a2a684\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/markdown.js\":\"1df87c4bdd20d010\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/notes.js\":\"8227994c3e3820e4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/registry.js\":\"eb9fb477806f95b4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/remark-timestamps.js\":\"e1c7ba651a4556a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/view.js\":\"ca5b877ac3ed7b95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/LinkHints.js\":\"340313244710a83a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/index.js\":\"553a009f8c193d4c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/model.js\":\"bbc3ef5cb6cc74f6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/settings.js\":\"bc0b7d5ff04003dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/actions.js\":\"10e113beae19aba7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/index.js\":\"e95c232fc6771378\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/interactions.js\":\"001b34fe3cb4164c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/workspace-header/index.js\":\"ff9a683f57984eb9\",\"/knowledge-medium/pr-preview/pr-1835/src/registerServiceWorker.js\":\"b79e64bff9881727\",\"/knowledge-medium/pr-preview/pr-1835/src/requestPersistentStorage.js\":\"bee79e7be3b0d682\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authRequestDeadline.js\":\"9826eb6c62eca7a2\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authStorage.js\":\"39d3223705d8bc1a\",\"/knowledge-medium/pr-preview/pr-1835/src/services/powersync.js\":\"0634bcae7ad48db2\",\"/knowledge-medium/pr-preview/pr-1835/src/services/supabase.js\":\"9e4b0c125e4ac1dd\",\"/knowledge-medium/pr-preview/pr-1835/src/services/uploadErrorClassifier.js\":\"4a1960f93c5af32f\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/ActiveContexts.js\":\"7f79620e51f27d96\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/HotkeyReconciler.js\":\"e2f928bbffb76a32\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/WipeLocalDataDialog.js\":\"ab2256d7357e2ae2\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionDispatch.js\":\"4610f3eca82b2725\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionRefItems.js\":\"70158afd39fde2eb\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/applyKeybindingOverrides.js\":\"78f65a20a7f52d72\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/blockActions.js\":\"a0c6be314f56f392\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/canonicalizeChord.js\":\"905cc1f879b6115a\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultContexts.js\":\"632699ed204edf67\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultShortcuts.js\":\"87f80c2994d1e419\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/effectiveActions.js\":\"4215c9349faa3f3b\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureAction.js\":\"1667fad06383452b\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureBinding.js\":\"ca5bef16dc0f7443\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/holdRegistry.js\":\"87ad8acdfc086216\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingConflicts.js\":\"299177270a4a68bc\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingOverrides.js\":\"f42dd596e118a2b1\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/pointerAction.js\":\"b131ed7c6c3ec694\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/resolve.js\":\"089afb00c71ac736\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/runAction.js\":\"acf49b4da811f44b\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/sequenceMatcher.js\":\"f7bc0c714d97909a\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/types.js\":\"10c5b62b471495a0\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionContext.js\":\"f7ad251328feada9\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionDiscovery.js\":\"d692bbed8ac932f8\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/utils.js\":\"2d9b2425d135fb9d\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/bootStore.js\":\"ede34d424040f768\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/previewDatabases.js\":\"9849c277d6c085bb\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/byteTransform.js\":\"ecc1af63eee66c1a\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/attachmentCleaner.js\":\"dc7e028ac2a10301\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/attachmentParts.js\":\"9cdc607f0de94ef3\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleParts.js\":\"ef308fee2a7ceabb\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleRecord.js\":\"9cb4bb784d519c2a\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/manifest.js\":\"a746489306866939\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/takeBundle.js\":\"af1d54ffe3c841d6\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/verifyBundle.js\":\"80fcaed4986b6e79\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/cleaningStage.js\":\"5dfcc1a88f933dfb\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionKey.js\":\"e417421381d1ba8d\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionServer.js\":\"989c9d84d0f15482\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flip.js\":\"96b6eb015444f51e\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flipAttempts.js\":\"f12e6ae4bf0b680a\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/pages.js\":\"5420d92b7f740fa6\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/preflight.js\":\"62b99aa902d25a29\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/reseal.js\":\"ea1c5102795c65dc\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runConversion.js\":\"039bf56e0df47592\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runLock.js\":\"e29d666f4c3809cd\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealing.js\":\"369b04cf0af1361a\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealingStage.js\":\"e580f1932a0b14fc\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/stage.js\":\"20911263dc06b954\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/verifyReseal.js\":\"798ada79241d827f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aad.js\":\"123638f9c6bee0cc\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aead.js\":\"122ba26a444b48c8\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base32.js\":\"e62f42f1d0d6562a\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base64url.js\":\"6d8be165c715930e\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/binaryEnvelope.js\":\"aa9297729e6c2ffc\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/byteAead.js\":\"7794c7ec212484de\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/canary.js\":\"3ac78500fc2bdbb5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentHash.js\":\"c9d9da8974e5bdce\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentKey.js\":\"b95980b36c15b864\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/derivedIdNamespace.js\":\"830d88b730105048\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/envelope.js\":\"a06a08f97b63b394\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/hex.js\":\"4bf77b8e1e254526\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/sha256Hex.js\":\"be1a5d8bbfc195ef\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/workspaceKey.js\":\"8e5d2a04bfd00763\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/conversionState.js\":\"a2f3476991bb079e\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bb9402d0df71cfcf\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/pastedKey.js\":\"4bb57f4a928d3206\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4a3e1d24f42a0f39\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d9e7c6de25778541\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/keyStore.js\":\"f8344ceb0541f999\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/mintWorkspaceKey.js\":\"db33f6ecd0f45f68\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/modePin.js\":\"caa89f4ebc8d04bf\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/openWorkspaceKeys.js\":\"900d60f942d52514\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolveWorkspaceEntry.js\":\"141a38b54dd4efde\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolver.js\":\"a4fe0679638df376\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/workspaceAccess.js\":\"fc1d6ab3f521bf98\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/transform.js\":\"a319514b1e34cdcc\",\"/knowledge-medium/pr-preview/pr-1835/src/themeBootDefaults.js\":\"dc8deb0d1b156ecb\",\"/knowledge-medium/pr-preview/pr-1835/src/types.js\":\"069e806830045508\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/ClientLocalSettings.js\":\"cf48d86e385fcafc\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/abortableSleep.js\":\"2fc0125dbb9a4c52\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/array.js\":\"bf7859fd75567cc8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/backlinkAutocomplete.js\":\"2da2fb7b4ca47fa5\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockCrumbs.js\":\"a742db24a3365fe8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockrefAutocomplete.js\":\"383bb8f8572ff8d1\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/cadencedIdleJob.js\":\"302cc670873df199\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/callbackSet.js\":\"c527e2248bff253f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/clientId.js\":\"c45f76b6d8995286\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirror.js\":\"5a656d22bd0b5f86\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirrorCompletion.js\":\"925a61fbed6f51c0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/copy.js\":\"0b8277fb72697c75\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dailyPage.js\":\"625d15812a9bdc89\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensics.js\":\"e60caa0e29c8ce58\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensicsHooks.js\":\"465f773001b2a1c2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/deleteBlockThroughUi.js\":\"913f6085051930d7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dialogs.js\":\"d09cf9cf9dd935c3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dom.js\":\"a09b6316b38b5edc\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/downloadBlob.js\":\"0b565e3d9bfb9884\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/exportSqliteDb.js\":\"0175dd151d7a73dd\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fileSystemAccess.js\":\"b37f11eeaeb06c3a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/flipSlide.js\":\"d8f0197b043f33f7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fnv1a.js\":\"b318c83766ada37f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/formatBytes.js\":\"1cbc3f1fcb820a2a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fuzzyRank.js\":\"e3b05bd91e424db3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idbKeyedStore.js\":\"e43b6d72c51cc004\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idleCallbackPolyfill.js\":\"cee5ea9d97b7eea8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardAwareScroll.js\":\"383a31f7e477ca51\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardViewport.js\":\"4be5172220b25a35\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/lastWorkspace.js\":\"a2f1ce4cdf7f537a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutColumns.js\":\"5bb92f36cec6f4ad\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionDom.js\":\"d21258bed2a9fc34\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionId.js\":\"4bc5b586a5840963\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkClickGestures.js\":\"02b40541bd2c6f71\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkTargetAutocomplete.js\":\"98eb6c8ecdaa1a6d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbCorruption.js\":\"f9377e801ee0141b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbRecovery.js\":\"7ec7783430272720\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/markdownParser.js\":\"5cc70ef83f030fdd\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/memoize.js\":\"e02ae8e55a771aae\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameFieldCommit.js\":\"db6d1924909deeef\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameList.js\":\"d782f9ef9c740f37\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/navigation.js\":\"2849d5372f894b48\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/omnilinerNamespace.js\":\"39849aa2461cd334\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/opfsPageScan.js\":\"b7bf54165999c06b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelClearance.js\":\"1cf56d792f853db6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelHistory.js\":\"fe8df763a150eee9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLanes.js\":\"84e40d28e0ca08b8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLayoutProjection.js\":\"a1a109ad7d44d3c9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelScrollAnchor.js\":\"554cc8f0ad5fb2dc\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelUrlFlags.js\":\"acf5052c9d7fc975\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/platform.js\":\"47894ca534dcc0af\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/pluralize.js\":\"5966aa1af39b89c0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyCreation.js\":\"abbff47ab023b15c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyNavigation.js\":\"28b3fafd674e1eed\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyValueContext.js\":\"a5575314fecf8206\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/react.js\":\"add27bf243636485\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeDate.js\":\"fadb78da52254ff8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeTime.js\":\"38cf17996fad26ad\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/renderScope.js\":\"a8d4fe5df5f25124\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/resolvedThenable.js\":\"fcfdb1029512779b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/routing.js\":\"0ef6b4b20c9000bd\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/safeMode.js\":\"e3061f53ff0751ce\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/scheduleIdle.js\":\"5661f56a2877c6c0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/screenWakeLock.js\":\"73166237be09739d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/selection.js\":\"5a6436f12a925ab2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/softKeyboardGrab.js\":\"2a47c523b23f6e03\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/startupTimeline.js\":\"f997459381a9811e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/state.js\":\"6389d0aeac68d429\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/string.js\":\"8649bda1bf26fa3c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/surfaceZoom.js\":\"beacaeadf0ed4963\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/time.js\":\"ea4c93a3cb52be9a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toast.js\":\"e534225609f52f6a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toggleStore.js\":\"57fdcc5cf61ef3d3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/untilStopped.js\":\"8c956178b2f15d1e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/userActivity.js\":\"adbbe9b3a991f060\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewTransition.js\":\"d08013e9a5f5e1db\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewport.js\":\"d1bb53d69a0b8ab4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/webLock.js\":\"0d30a9e9d4165847\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceRecovery.js\":\"63f8a432b9fd81db\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceSnapshotStore.js\":\"2092c50796ceb7d1\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-compiler-runtime.js\":\"38e6ef210488ccb4\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-client.js\":\"e56c61a219c28500\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server-edge.js\":\"2e1c776c167ca3ac\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server.js\":\"e63b0f1927645b49\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static-edge.js\":\"4793f1b8ff476c93\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static.js\":\"8a9aca7ffba9ec14\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-test-utils.js\":\"37a774a6a432aac0\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom.js\":\"28c01b12d0275bca\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-runtime.js\":\"db29a77cef4cc048\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react.js\":\"cba3fd3c7e266796\",\"/knowledge-medium/pr-preview/pr-1835/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
