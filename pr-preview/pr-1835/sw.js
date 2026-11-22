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
		buildId: "bd97373330db-5b8a3bba",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/\":\"50395c1f03b6a6fa\",\"/knowledge-medium/pr-preview/pr-1835/index.html\":\"50395c1f03b6a6fa\",\"/knowledge-medium/pr-preview/pr-1835/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1835/assets/FacadeVFS-BoZeKy0e.js\":\"5fccdc39e3e9d0d2\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSCoopSyncVFS-C554CYtm.js\":\"89d0cdd720b1e1c8\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSWriteAheadVFS-D-ARDwTp.js\":\"111b65c452559013\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CfFcOy3a.js\":\"ccb0717c96dc86f3\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-ecAwXFSi.js\":\"36e79fd0a2bc2403\",\"/knowledge-medium/pr-preview/pr-1835/assets/worker-BVuoIuZy.js\":\"442140cd1ac040b4\",\"/knowledge-medium/pr-preview/pr-1835/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1835/chunks/app-B66-HSlB.js\":\"096135888e07f8e4\",\"/knowledge-medium/pr-preview/pr-1835/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1835/index.js\":\"f3ecad720a617b26\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1835/assets/AccessHandlePoolVFS-BJe-RLwr.js\":\"acbe336f23eaac43\",\"/knowledge-medium/pr-preview/pr-1835/assets/IDBBatchAtomicVFS-DdaWcIgF.js\":\"7d3c7ee66c8bb727\",\"/knowledge-medium/pr-preview/pr-1835/assets/MemoryVFS-CduzpJx0.js\":\"c354dfd2ef37f7b1\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Q_Tx3yzG.js\":\"8a033b0c1634f22b\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-D1J0A38Y.js\":\"0bcebdc41467f094\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1835/chunks/AccessHandlePoolVFS-tupgdHwu.js\":\"7cce162187e75118\",\"/knowledge-medium/pr-preview/pr-1835/chunks/FacadeVFS-THfSdPLH.js\":\"ac021f22d96ccf6f\",\"/knowledge-medium/pr-preview/pr-1835/chunks/IDBBatchAtomicVFS-DIlKJgBP.js\":\"30783a124501ff46\",\"/knowledge-medium/pr-preview/pr-1835/chunks/MemoryVFS-IoZPNzfA.js\":\"682b808a065f4e39\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSCoopSyncVFS-BVKDNiVf.js\":\"b62cf1ace37b9eea\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSWriteAheadVFS-BaYb6pF2.js\":\"4fe63a70165d582b\",\"/knowledge-medium/pr-preview/pr-1835/chunks/Preview-6KJRNwRe.js\":\"9ea27d1b3b6fcbea\",\"/knowledge-medium/pr-preview/pr-1835/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/card-CSZKIcNT.js\":\"7a373304ce91f117\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-CBcakUaH.js\":\"1210b9df91ecec66\",\"/knowledge-medium/pr-preview/pr-1835/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-async-B9hR_7Lk.js\":\"bbd850c55cebc0df\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-cAgv7Ezj.js\":\"3a0d779a46aa8844\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-8s7oUEKU.js\":\"dfd678be62c85d68\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-BizO461l.js\":\"1d1183be708e9d61\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-C1fVJ4sd.js\":\"65ceed35122622ce\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CYHh420k.js\":\"d6c7e279d0be38f6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-ClPoVRqU.js\":\"0e8da9fac89ea4cc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-T7VsEAXp.js\":\"2a2ca7a66e9322cd\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server-legacy.browser.production-iSkd08MP.js\":\"2404ebfc9fde1473\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.browser.production-7Mx-AzIT.js\":\"9da2fce15548cf93\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.edge.production-DAJpGXos.js\":\"fedc46d6809043d0\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-qCqgkIoR.js\":\"938d4ba7579885a1\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-tjF6QB5X.js\":\"ba2609426ae894db\",\"/knowledge-medium/pr-preview/pr-1835/chunks/server.browser-Wyko0Lcq.js\":\"ece742e18970d872\",\"/knowledge-medium/pr-preview/pr-1835/chunks/textarea-DbnD_SkA.js\":\"59cd886974468622\",\"/knowledge-medium/pr-preview/pr-1835/chunks/ui-Eldm4OgC.js\":\"10c75a18b9dbd08b\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite--mV--lEA.js\":\"338ae570feb00b83\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite-async-BSfHuVYl.js\":\"63adf8c77ad564c6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1835/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/src/App.js\":\"97f4b2ba063f045c\",\"/knowledge-medium/pr-preview/pr-1835/src/appUpdate.js\":\"b20743a1c57cbb72\",\"/knowledge-medium/pr-preview/pr-1835/src/appVersion.js\":\"edafed932c5ac087\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/initialLayout.js\":\"919548ebe2113272\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/openWorkspaceData.js\":\"25ff27ac3bc3495c\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/resolveWorkspace.js\":\"d851399bf6926724\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/workspaceBootstrap.js\":\"5c9a55af3f3bde44\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockComponent.js\":\"70ff75ecce1eb4e8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockCrumbs.js\":\"5b4c7d144a9caf14\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockEditor.js\":\"111bd84d82c848fb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockLoadingPlaceholder.js\":\"2e96b9f8dd0872eb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockProperties.js\":\"e713ca8b2e3a0b22\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockSearchPicker.js\":\"5306c7578a0a635a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ConfirmBulkDeleteDialog.js\":\"ccd16757c1eb15d8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DividerHandle.js\":\"b6daf24df3fd531c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DraftEditor.js\":\"2543ed8e91dcf2c1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/GutterPill.js\":\"a6ae3bec031ce300\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Header.js\":\"c7d6110250960173\",\"/knowledge-medium/pr-preview/pr-1835/src/components/LazyBlockComponent.js\":\"35bfd9a630328ba7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Login.js\":\"c3a70c5b349fe54c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ZoomableSurface.js\":\"bbdcabde4e6e11bf\",\"/knowledge-medium/pr-preview/pr-1835/src/components/editModeKeepalive.js\":\"8eb9f9f5eaf98826\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8e9747d0f76759d0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"9c17b131d64f4cd2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefPropertyEditor.js\":\"f3587eb787690a68\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefTargetTypePicker.js\":\"7eb467ebcfdc770e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/SelectPropertyEditor.js\":\"845184b952ccc7c2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/TypesPropertyEditor.js\":\"dc3f659960d6cdbc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/defaults.js\":\"b1e49af92f91d14f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/kernelValuePresets.js\":\"f4118866aa902774\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/selectablePresets.js\":\"6a22da0980817233\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/typesPropertyUi.js\":\"d5246f281a76cb61\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/AddPropertyForm.js\":\"30c98dd3fc4a8945\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyPicker.js\":\"49b280a7b33b3cad\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyRow.js\":\"aa4b66ac7253e17d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/Rows.js\":\"64da4e530a4c334f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/actions.js\":\"f9f88bda6d109bba\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/declarationOnly.js\":\"aea6df6b4f946faf\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/layout.js\":\"81f5fcb994178261\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/model.js\":\"889b2960067288e1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapeUi.js\":\"952f0eed99ac0ae2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapes.js\":\"e4b7ab5248e0c5d2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/usePropertyEditingActivation.js\":\"936e6276cfa11cc4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/visibility.js\":\"adf190c70fa1b029\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanelSections.js\":\"8da34721716e773c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockEmbed.js\":\"11399f748a3b7e26\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockLink.js\":\"7ef4959f71db1370\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockRef.js\":\"9852ba15f45b455a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/ReferenceLink.js\":\"9f7be7185cf82cbb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuard.js\":\"bf70c1e71e0afdae\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuardContext.js\":\"ffaa7457f5d1b037\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/linkInteraction.js\":\"c4db823c3024f2f2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/referenceLayout.js\":\"bf190cb25f612573\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/useBlockRefAncestors.js\":\"3b162d6cf9454938\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockGutter.js\":\"1f3bf6f607dc29de\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockInfoDialog.js\":\"99ba9ec9373e85ab\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockTypeBlockRenderer.js\":\"750f5be2797ca82b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BulletHoverCard.js\":\"6b93e1d702d43c36\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorContentRenderer.js\":\"4c958f9be1ea740c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"707717088d03c4df\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ColumnResizeHandles.js\":\"4db42606ce3c2814\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"384da4bdc3e382a7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/DefaultBlockRenderer.js\":\"c5e3d7ba134c9580\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/LayoutRenderer.js\":\"9de4dec396871701\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MarkdownContentRenderer.js\":\"3b991c96e275d4d9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MissingDataRenderer.js\":\"bbe29fb6300e4088\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PanelRenderer.js\":\"17a1e55d84adabf1\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d10e871c7396de3a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/TopLevelRenderer.js\":\"18bcc190fc7ec228\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockGutterMode.js\":\"31255368ddf00827\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockTitleText.js\":\"42f39b143de5539e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/fieldCreationKeydown.js\":\"78fb47f2742b57aa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/layoutRootContext.js\":\"32e9613174f6128f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/TypeChip.js\":\"c04dcd4d9fc4b1fc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/chipStyle.js\":\"ef6719ce0deadbb5\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/anchored-floating.js\":\"c78421e60a34e210\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/button.js\":\"2cdf7f6390917792\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/card.js\":\"846f5647152c6149\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/checkbox.js\":\"21240cc6f75171c6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/collapsible.js\":\"e53ab85418fb8fbc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/command.js\":\"d11caf4ee804fd67\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/context-menu.js\":\"a9bb9af07491c071\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dialog.js\":\"d2e8334ae803c639\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dropdown-menu.js\":\"6db7d3a16cea91dd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/floating-listbox.js\":\"f4a7245dc2b7392a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/index.js\":\"67a38c8950802b30\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/input.js\":\"009a6cbefe043757\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/kbd.js\":\"7e3a271557f05a3d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/label.js\":\"4019bac0fbed8605\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/textarea.js\":\"b9babfc15f6a7776\",\"/knowledge-medium/pr-preview/pr-1835/src/components/useEditModeYieldKeepalive.js\":\"74bad99c4978e006\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/BootFallback.js\":\"5acdc5abc4f72a04\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/FocusedRowLazyMount.js\":\"225750064f79719a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LazyViewportMount.js\":\"a9b331f5c8dd638e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LocalDbCorruptionFallback.js\":\"debd948c76af7c45\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/error.js\":\"73833a40716ddf91\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/lazyMountRegistry.js\":\"1f7d40be3bcca032\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/suspense.js\":\"792194ca4e334a8f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/CreateWorkspaceDialog.js\":\"1f316df0b524923c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/PendingInvitations.js\":\"98e0821f69408c6f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/SyncProgress.js\":\"2f064e6bbb8384ca\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/UnlockProgress.js\":\"b10c2b9cabf66da9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceKeyGate.js\":\"7031136b1bf28cbe\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSettingsDialog.js\":\"8089c1d3485958ac\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSwitcher.js\":\"a05d52c40d162560\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSyncGate.js\":\"10bbff69d4e59c01\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlow.js\":\"1decdfe6acf0c6b6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlowHost.js\":\"2fe7c5367b43614b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/EncryptionSection.js\":\"7a7366ab6a3f82d3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/attachmentPrompts.js\":\"2449509788dc8534\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a6f7f9134e4b8acb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowDeps.js\":\"703f5c2494d13923\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowStore.js\":\"96b570813902b44f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/flowUi.js\":\"a02bfe1df44f9da4\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/useConversionRun.js\":\"4a6757e4258bd32d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/keyUi.js\":\"bc85ff279ccf7aa2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnKeyLoss.js\":\"3afcbc4c50483a22\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnServerE2ee.js\":\"7e1f6bef617f684b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/workspaceUnlocked.js\":\"2dee00ae58a54b09\",\"/knowledge-medium/pr-preview/pr-1835/src/context/backgroundSubtree.js\":\"80f94badf99a1b51\",\"/knowledge-medium/pr-preview/pr-1835/src/context/block.js\":\"617fa225ca985b45\",\"/knowledge-medium/pr-preview/pr-1835/src/context/layoutWsContext.js\":\"37f5c389d4af7106\",\"/knowledge-medium/pr-preview/pr-1835/src/context/propertyDisplay.js\":\"ea5fe3ab7799e1e9\",\"/knowledge-medium/pr-preview/pr-1835/src/context/repo.js\":\"6b81787a5935da94\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasClaim.js\":\"0d803581e303bd04\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasSeatNamespace.js\":\"b0987318b7d8d188\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockData.js\":\"2543938bf9e8a655\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockType.js\":\"d78fa24a9550765a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/changeScope.js\":\"3d700f7ae5fdf997\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/codecs.js\":\"5387f738bcf72d0b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/derivedData.js\":\"9f142b4ba68ce557\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/errors.js\":\"c97983e60a2d94f1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/events.js\":\"74aa6aafa1ca128f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/handle.js\":\"35e00efb4ade12fa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/index.js\":\"ecd12072fa2ec7e5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/mutator.js\":\"7c8645ee2ca9cbb3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/processor.js\":\"013d73cf1f493f10\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/propertySchema.js\":\"81f98bc3d567c51b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/query.js\":\"232c1f66fba7293f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/sameTxProcessor.js\":\"68205736d94926a0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/schema.js\":\"35e00efb4ade12fa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/tx.js\":\"35e00efb4ade12fa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/typedBlockQuery.js\":\"1cded63fa2afd381\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/user.js\":\"93c73f948a832282\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresetCore.js\":\"b36171a2a8518d61\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresets.js\":\"d5a53beba74d1bc2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/attachmentCleanerIOVerb.js\":\"e933ecd6d77d1711\",\"/knowledge-medium/pr-preview/pr-1835/src/data/block.js\":\"39e8d9e79b25455f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockCache.js\":\"aedcef1769e613dc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockId.js\":\"00bd83b4c4548b1a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockLiveness.js\":\"e616285dcb756baf\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockMerge.js\":\"2c4c87ac6de5e5d7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockSchema.js\":\"7453a93589e0e0b5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypeLookup.js\":\"f637cbb1aaa930fa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypes.js\":\"a04197946918d4cb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/clientContext.js\":\"0a6674640f4dd5d8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/dbFileSiblings.js\":\"5c92c942d991a06e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/definitionSeeds.js\":\"ed75209f4bb2da69\",\"/knowledge-medium/pr-preview/pr-1835/src/data/derivedIds.js\":\"8be44b4ef587f0c9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/drawnSubtree.js\":\"ee14530e41144aed\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facetBridge.js\":\"aa64d7a97617ecb4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facets.js\":\"654d32c665748121\",\"/knowledge-medium/pr-preview/pr-1835/src/data/globalState.js\":\"48e63f21d37450a6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/aliasClaimRederiveProcessor.js\":\"3184cafd18a196fe\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/ancestorBatch.js\":\"9eda5d5404b5a4f6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/blockTypeTypeifyProcessor.js\":\"6539fa302cb3bb9a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/clientSchema.js\":\"d2997c8087a699d8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/commitPipeline.js\":\"06c73d1af16a6173\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/devAssertions.js\":\"bdd2eff889893e41\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/firstSync.js\":\"8be55217eea806c2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/freshInitialLoad.js\":\"4cec2e36a2cb0598\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/graphBackfillClaim.js\":\"94dbb788cf633343\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/handleStore.js\":\"e6aaa91dcad17562\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/idleMarkerJobs.js\":\"4aea780b14bd716c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initialDownload.js\":\"e3b47295f563af26\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initializeClientDatabase.js\":\"313baca9f6740de8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/jsonCanonical.js\":\"3fbbbfe0cad12de3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelInvalidation.js\":\"c316b4a88432cc91\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelProcessors.js\":\"04493719eddeba4e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelQueries.js\":\"b85ce3da1b212ec4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/mergeTypeMembershipProcessor.js\":\"b97fd66eae48c897\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/normalizeReferencesProcessor.js\":\"5fdb6fe60272f5f8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/poolInstrumentation.js\":\"650c0a40f8ab34bd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/processorRunner.js\":\"a9aa048334700ffd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyCellBackfill.js\":\"be3fb9ac52aee5f0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildMint.js\":\"03277b5d6c180201\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildrenProcessor.js\":\"711e36341e75e184\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f153a0b784e8347e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionSynthesis.js\":\"ad5bc32eea777b35\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyKeyScan.js\":\"f3253c38ff6439bf\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertySchemaResolution.js\":\"94785b05670e5649\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyValueEdits.js\":\"88b6bc0113f5d5ed\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/raiseProtocol.js\":\"96682f4c22b0a395\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/readBatch.js\":\"8c942d7c6883f2b9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/refProjection.js\":\"b1bcfde340253b2f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetLookups.js\":\"5a3fc040a269eb34\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetProcessor.js\":\"57045ed65b260a6d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/replayMerge.js\":\"b5badc9d51330723\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/sqlBinds.js\":\"d2c1345cd82ee3a8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a27e47938be89b52\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/arrivalProcessors.js\":\"5296abc74ee71c6a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/invalidate.js\":\"10856e0ec179e727\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/materialize.js\":\"ba246393757eb0dc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/observer.js\":\"d05ed78b47bec5ec\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/reconcile.js\":\"86b11b40c4fadf15\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/timingMetrics.js\":\"2f0b42758e6f9b6a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/treeQueries.js\":\"d3865b72147f3fba\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txEngine.js\":\"972ca81ee236cc41\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txSnapshots.js\":\"991dcaf5cb720130\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/typedBlockQuery.js\":\"86c5c7f6329fc1ec\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/undoManager.js\":\"d125c0fea4104009\",\"/knowledge-medium/pr-preview/pr-1835/src/data/invalidation.js\":\"265c78c7a87b4342\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelDataExtension.js\":\"1db5c5c1dd043c9b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelPage.js\":\"7042a8abe8169a0f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelValuePresetCores.js\":\"63be6178d4706b41\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbCorruptionSignal.js\":\"2d4b760c51c91d00\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbStorage.js\":\"11dbd708c4a1545e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbVfs.js\":\"32e9b6a5b87708aa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localSchema.js\":\"cca87e1e22de11e2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/maintenance.js\":\"dfa5b2b6a4e45d24\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mergeProperties.js\":\"5e4922ab1d6c3892\",\"/knowledge-medium/pr-preview/pr-1835/src/data/metricsConsoleHook.js\":\"3ee760c41fcb14da\",\"/knowledge-medium/pr-preview/pr-1835/src/data/migrationsPage.js\":\"d3d14f552ad095c7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mutators.js\":\"dd6c4e8a6726be1d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKey.js\":\"9ce7bfd09455dfb3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKeyPlacement.js\":\"40325597f56d4f72\",\"/knowledge-medium/pr-preview/pr-1835/src/data/outlineSurface.js\":\"25069e6210a14e7e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingEditorContent.js\":\"362f4be3f55a0d75\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingUploadsSql.js\":\"cb5816ed683aa41d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pluginStateExtensions.js\":\"94c2e24150cadf74\",\"/knowledge-medium/pr-preview/pr-1835/src/data/powerSyncLogger.js\":\"c52ae4cff26f2628\",\"/knowledge-medium/pr-preview/pr-1835/src/data/projectorRuntime.js\":\"4f826063979d5eef\",\"/knowledge-medium/pr-preview/pr-1835/src/data/properties.js\":\"cc8358e95feaa6ad\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertiesPage.js\":\"f56f52a338a62fa3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyChildren.js\":\"e132e04b20faa1ce\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionFanout.js\":\"5532c8390e45af27\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionMetadata.js\":\"b9eadf30883dfd50\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionRegistry.js\":\"6cb8f321b8a1abc7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDisplayMode.js\":\"4c2d0c5aacf1a0e1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyRowCreation.js\":\"78974d98c280947b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySchemaCreation.js\":\"02ed0f9c11fe3d73\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySeeds.js\":\"036d897a9b957e1c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/recentsPage.js\":\"b3785b0f0bf0d229\",\"/knowledge-medium/pr-preview/pr-1835/src/data/referenceBlock.js\":\"8aec6c1ce8600296\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rejectedUploads.js\":\"3e667c5290cb1dfa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/releasePowerSyncConnection.js\":\"767dceabe8d3c128\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repo.js\":\"94875d6aa6e73d49\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repoProvider.js\":\"d5a17ce138c56570\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rowProperty.js\":\"cf16714c933ef28b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/searchFilter.js\":\"d61e1f8802dddea5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/seedIdentityLedger.js\":\"2cb7027343359d24\",\"/knowledge-medium/pr-preview/pr-1835/src/data/stateBlocks.js\":\"c247163c2460c7ac\",\"/knowledge-medium/pr-preview/pr-1835/src/data/structuralEditPolicy.js\":\"ed8685e9b9f57016\",\"/knowledge-medium/pr-preview/pr-1835/src/data/subtreeDelete.js\":\"3852ac25b66af771\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncStreamLock.js\":\"d3a1e98c2fed2433\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableSqlRecognizer.js\":\"b50d207abee2d2b6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableWriteGuard.js\":\"1ede4661956c2a32\",\"/knowledge-medium/pr-preview/pr-1835/src/data/targets.js\":\"4a7f14ca2d101f3f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeColors.js\":\"907b3696c360db70\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionMetadata.js\":\"0fb98a338a0549b5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionRegistry.js\":\"2ccef35219679aed\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeExtraction.js\":\"6a54c64d07da68a5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeInitialValues.js\":\"aea682d2db038df9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typePropertyGroups.js\":\"052d5a62ccd1ff05\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeSeeds.js\":\"e646cf75a3bbfc98\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeTagger.js\":\"830c89a81a299b7b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typedRecords.js\":\"06248e5291a9612f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typesPage.js\":\"ac9bcd892aa416e8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userPrefs.js\":\"07dfc47ae39a3a40\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userSchemasService.js\":\"3bbd7b127ba555a6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userTypesService.js\":\"d0173c7c88708d19\",\"/knowledge-medium/pr-preview/pr-1835/src/data/valuePresetRegistry.js\":\"1b2995f1b6299f11\",\"/knowledge-medium/pr-preview/pr-1835/src/data/visibleChildren.js\":\"c2a8b8e4d4424799\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceConversion.js\":\"f16df744fa0d5e90\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceFirstSync.js\":\"c113daf776db4ea1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceIdNamespace.js\":\"a8584935d35f87f8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceSchema.js\":\"0c4e57a457e85c25\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaces.js\":\"ee4557660cb584e4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadLog.js\":\"3a8747d75fc78e9a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/BlockPasteShellDecorator.js\":\"290344da2b96d74d\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/atTrigger.js\":\"653dbcf45494868d\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/autocomplete.js\":\"92e52c03e8b5ede5\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/codeMirrorExtensions.js\":\"7f49f7ac32616a8f\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/contentFlush.js\":\"0df28ae08aca41de\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/defaultInteractions.js\":\"a07f1cf8655c232d\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/editSettleSignal.js\":\"5ba5626f32ac0e03\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/insertImage.js\":\"048c6b175c555773\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceCompletionRange.js\":\"a989ed9619bb5071\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceTargetTypes.js\":\"2fcb308d0999a6f4\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/syntaxContext.js\":\"35494cd55cff64f0\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/triggerMatch.js\":\"ceaae661832d6419\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/AppRuntimeProvider.js\":\"fbfa7b348b3ad16a\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/BlockFocusShellDecorator.js\":\"9c49613178253602\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/ExtensionRenderBoundary.js\":\"dd5493fabac15763\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/PanelContentRecovery.js\":\"b7f5e098ca5a8811\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/apiCatalog.js\":\"4be34407ce32d3e4\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/approveExtensionHere.js\":\"d608ff0f3ead0410\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/armedCutAppMount.js\":\"4bfb0d17cad83497\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/batchableKeyedStore.js\":\"afdf046eaf19afef\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockInteraction.js\":\"b9487f124e7ec9e6\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockSelectionAction.js\":\"0436ffdba25e334c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compileExtensionModule.js\":\"683c8ace89efb2d5\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compiledModuleCache.js\":\"c7d1737c33ef71b8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/continuousGestures.js\":\"2089872c67d9a51a\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/core.js\":\"10dacb4e5fc6af38\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/defaultRenderers.js\":\"9cf55465df3fa662\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/definitionFanoutAppMount.js\":\"fc549dfda48c9eb8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dialogAppMount.js\":\"1a69fdff14c2b61a\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensionSeeds.js\":\"555651ea1d96fc8e\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensions.js\":\"10a7c2e19738122f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/exampleExtensions.js\":\"6047bea37fbff9b7\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionApprovalStatus.js\":\"cdd592ca329e0f3c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrorToast.js\":\"d2d84dd254372b65\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrors.js\":\"42be876e0f55bf48\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLookup.js\":\"3340062e50c1c7ff\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionToggles.js\":\"4944154c55c4333c\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionUtilitiesCss.js\":\"143c59055a9536f4\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/kernelPageDeletionGuard.js\":\"39efc47d9811accb\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/liveRuntime.js\":\"2189ec26a04dcc1b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/openExtensionsSettings.js\":\"a37f44fdb6978c57\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/overridesCache.js\":\"7d8c142408197b94\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/pluginIds.js\":\"a8dd3930840fea34\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/processorRejectionToast.js\":\"c3283d4e9a586934\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeActions.js\":\"804750d0aef0130d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeContext.js\":\"5fd30a1642d92788\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticAppExtensions.js\":\"486d27e1a533af75\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticDataExtensions.js\":\"49fe85da7c2c42c5\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/toastAppMount.js\":\"88406e68f5186d84\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useOverrides.js\":\"67e9e804b5f679f7\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useShortcutSurfaceActivations.js\":\"4e85fefc601d72fa\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/discoverToggleTree.js\":\"48d8294e2e715677\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/facet.js\":\"2ce62593ead05f39\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/resolveAppRuntime.js\":\"4f67565aca171343\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/runtimeEvents.js\":\"72028f246322b0ca\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/togglable.js\":\"166249f5b21034e4\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/variantFacet.js\":\"554b06c26267005e\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/verbFacet.js\":\"1f67514c11460390\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/block.js\":\"4e32a75f66742b8e\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/focusedChild.js\":\"ad1cb44709b6a509\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/propertySchemas.js\":\"1c2c73786762493a\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/typeRegistry.js\":\"e177ee39839b594b\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAncestorCrumbs.js\":\"029b21da4fe6e488\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAutocompleteListbox.js\":\"a3f5c73105cb559c\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedSearch.js\":\"3919242ed6980e49\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedValue.js\":\"b173562a28536c63\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsFocalRender.js\":\"062bcdad8fdd11a6\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsReadOnly.js\":\"eb32b1234c49d103\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMaterializeBacklog.js\":\"4ee377c8e85c0b96\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMinuteClock.js\":\"1212b105e8910bef\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePanelLayoutProjection.js\":\"0dc5567ea8cca89a\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePendingInvitations.js\":\"6ca2d97cd24a89c9\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRendererRegistry.js\":\"ed2834b4fe620149\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRetainedFieldRows.js\":\"1bd84fcea05e3125\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useWorkspaces.js\":\"44458f70af830d37\",\"/knowledge-medium/pr-preview/pr-1835/src/lib/utils.js\":\"e34125fe37500775\",\"/knowledge-medium/pr-preview/pr-1835/src/main.js\":\"760fce1193db10d6\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/MarkdownImage.js\":\"bca085c374856fad\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/blockSeparators.js\":\"36caec323d8aa1bb\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/context.js\":\"14dda38fab380611\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/defaultMarkdownExtension.js\":\"b858b668e64a3ad2\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/extensions.js\":\"76ec3060e5f4d034\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/renderMarkdownHtml.js\":\"85ad1164463ae6b9\",\"/knowledge-medium/pr-preview/pr-1835/src/minimal-editor.js\":\"f97fe26871e14c25\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/armedCut.js\":\"3fc19b6974242b0b\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/captureMediaVerb.js\":\"6bde172b173e8d31\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/clipboard.js\":\"0676f5827fc632dd\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/decision.js\":\"22fca71881791321\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/operations.js\":\"676b214c04fb48c5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/AccountHeaderItem.js\":\"24fd954a3fa537c5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/index.js\":\"859f19d18756111f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a75ccfd22ff30cd6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askAgent.js\":\"a5829837bb34eb6c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askedStore.js\":\"3fe6f6bcf0bfd994\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"30bf1fa9dc5ee064\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/chipState.js\":\"4f9791a5a534dc65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/dataExtension.js\":\"57a6a6e76c6c4fe6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/index.js\":\"7373f35ab3525554\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"963b2f8c7bbdad77\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/schema.js\":\"e00760631e325dab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/AgentTokensDialog.js\":\"4c04d4d80922589f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/BridgePairingDialog.js\":\"27960857a4ceb5ea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/addMedia.js\":\"3e1773797284338a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/backlinks.js\":\"58c86601a5efdb90\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/block.js\":\"69cdc88f831d4a9d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/context.js\":\"949c4bd6167d6326\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/displayIds.js\":\"fe668ad493361478\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/index.js\":\"a1b1c7948fb92b5e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/outline.js\":\"8d936e038d811e0b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/properties.js\":\"5b57fb4ed33d0c8a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/refs.js\":\"54564fcf359f73a3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b96e93e16fb9017e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/search.js\":\"ec8664594095bb96\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/shared.js\":\"0771e6e8f790e199\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"76c7c1d55e2459ee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/text.js\":\"c43bf36a976c3eb5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentWrites.js\":\"7b0784926ee9754d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/authoringCatalog.js\":\"ffd13dcb46d8f456\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/blockRefTargets.js\":\"3ad5dc44f0ebf01d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridge.js\":\"1221b4f1462f6a82\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridgeLoop.js\":\"243b90f6454f1036\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/changeHistory.js\":\"1dc27339b8e1bf33\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commands.js\":\"9d365d1229b58e99\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commentsCommands.js\":\"fa088f1173325ffa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataExtension.js\":\"32f5847206bf3dfc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataModelGuide.js\":\"9c64c301da67c551\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/describeRuntime.js\":\"78c4dcf9c516b30c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/extensionLint.js\":\"341831ee5ef720a2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/grainAudit.js\":\"b54a4f2b375842bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/healthCommand.js\":\"99939e6f20098725\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/index.js\":\"de3c80a628d16cb4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/presetIdentity.js\":\"3ce543890f412740\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c6fdd7631466d225\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/readMedia.js\":\"c250ecf57a0e9b16\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/schema.js\":\"06cfe6be1ccd435c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/serialization.js\":\"a4579ffe8cda3057\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/targets.js\":\"a1794d61170900b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/tokens.js\":\"a30735b6903aa903\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/watchEvents.js\":\"55a8c60eb96a321a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/workspaceGuard.js\":\"53dff39cd56a40b0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/writeCommands.js\":\"6ed9ed849d69c77d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/AliasCollisionToast.js\":\"c66c2890c8a1417e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/DuplicateNameBanner.js\":\"26c1610b277168db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/collisionMerge.js\":\"a1a55e831ca32055\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/dataExtension.js\":\"33867bbb82596a64\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/index.js\":\"71339a5670b3f29a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/mergeCollisionAction.js\":\"8ca49c7e268f02c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/pageStyling.js\":\"3ee21c66dddd01bc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/rejectionToast.js\":\"14ff149af902bc5e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/syncProcessor.js\":\"6eb40d517fde4671\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/actions.js\":\"276abf3d500811d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/addComment.js\":\"7f560973deb2eb8f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchor.js\":\"bc4f12679713c6ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchorState.js\":\"9f3b8efda35a2a29\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/commentLinks.js\":\"36c081fc299cf8f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/confirmThreadDeletion.js\":\"f49fc9584e024b34\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/container.js\":\"013e074de1a4b735\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/dataExtension.js\":\"a30fe831db55eeab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/deleteComment.js\":\"362dc55ac91e933f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/highlights.js\":\"172a513ef6d9001d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/index.js\":\"ced5ee47dbcbf570\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/linkedCommentsPill.js\":\"a7cb9f9d2536dca4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/margin.js\":\"257ed024cb1cc75c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/marginSchema.js\":\"61ba4cb2cbfaaa4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/newComment.js\":\"79dd530c4ef6b0c1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ownThreadPicker.js\":\"3c0233cf99983d4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/placement.js\":\"4ff639f11ab51aa1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/queries.js\":\"917e55ea89d7a598\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotePosition.js\":\"bfa92fbf99c9afa4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedIn.js\":\"09dfd838db731d90\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedRange.js\":\"8022d6859e8be661\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/rangeRefs.js\":\"06336706f732becb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readHighlights.js\":\"f3f4c7095b720add\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelection.js\":\"8ed7324d1c7d777f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelectionUi.js\":\"3b3594543cffa1e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/reanchor.js\":\"454bf7ae25949119\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/schema.js\":\"85d990be53ac9b70\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scope.js\":\"64307409c91b7eeb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scopeThreads.js\":\"8717dc6cb2674fbe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/splitRetarget.js\":\"6f518e218502a721\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestionCard.js\":\"c212c5b2202ac030\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestions.js\":\"233bd0bf3100ffaf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaries.js\":\"6d1b46162049fb55\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaryBatch.js\":\"c547b10f21b15f98\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/surface.js\":\"988a2badd275631c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threadNavigation.js\":\"a8e236a2d2d607a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threads.js\":\"e7236983e70706b0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ui.js\":\"16df2c8b3b7b5d5e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/uiStore.js\":\"f719b1d21994778a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/appIntents.js\":\"2d6b4749f37a73a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/index.js\":\"25b686a59a3372ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/index.js\":\"ab15a589e8f0a8e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/status.js\":\"7a094b4989fc2c57\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9dc12b3d7fdd6bcb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaBlockRenderer.js\":\"e3c34341a03767d8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c6c725d5be9e0707\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaUploadReconciler.js\":\"54770db978dd5cb1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetDownLane.js\":\"fcf67eb7c48d721d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetResolver.js\":\"d401eb5bc1f3c153\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetUpload.js\":\"35c5b4e08e1e1c3f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/attachmentCleanerIO.js\":\"ade48bb064dfcde9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6f6350a4119baad5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/blobStore.js\":\"ff410afdc411d196\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/byteStore.js\":\"205326fe359cd1fe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanerIO.js\":\"40e29f68e03b4b3d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanupAttachments.js\":\"1fc384e4870af9a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/dataExtension.js\":\"20d2a4e0d4204b28\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/downLane.js\":\"0842dca4bdfb58d6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/index.js\":\"19391cf2a29a51e4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/insertImageContribution.js\":\"e75209629d413af9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneArming.js\":\"3c7d2f2e298c5fa8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneLock.js\":\"c02bed00690118c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaBlock.js\":\"659d075af9819452\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaCapture.js\":\"17111945263cc3ad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewers.js\":\"97125eab229e9cc8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewersFacet.js\":\"269f8af5aba082c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/pasteCapture.js\":\"5267671a2ea1a677\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/resolver.js\":\"bb7e92ea3573e266\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/retryUploadsAction.js\":\"cbf9a0f398acdf58\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/storagePaths.js\":\"6b0281c5027e72cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadDrain.js\":\"59f88fda09587272\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadLaneStatus.js\":\"7231ae8ad6158534\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadReconcile.js\":\"6cf8c9509d4ebadb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadRecovery.js\":\"b992dd0e156f1bcb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadStore.js\":\"88efd8fb6ceebe6f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/useAssetObjectUrl.js\":\"f64a13c17dec5262\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b536ef53a02c5a32\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksViewSection.js\":\"cb33553dfc933a47\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/facet.js\":\"be2fa872d41598aa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/index.js\":\"09a7c1f92e02a2de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/prop.js\":\"891d94c8265ead62\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinkFilters.js\":\"156e9fea512b0c98\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1893cfb47fc8b51f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BlockEntry.js\":\"084b4991b1fb8980\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/LinkedReferences.js\":\"d4904af93c0d0373\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"bda39669d0eb0978\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dailyNoteDefaults.js\":\"32647124d68e1906\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dataExtension.js\":\"28f25a0f4fb673b4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/edgeExclusions.js\":\"322b6139d2512b48\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/filterProperty.js\":\"a04441e0ae60a589\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/index.js\":\"0354a08ff87c91b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"409aadbe6f7a834c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/applies.js\":\"f235969112c1d011\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/countQuery.js\":\"dfa522af6b95a5a1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/expansionStore.js\":\"114149603688c262\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/index.js\":\"5d389608ab3439b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"85f14131180dd9c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/presentationInvalidation.js\":\"48dde1e941bc15c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyEditorOverride.js\":\"45eba8d325fa75bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyFilter.js\":\"667978c82337f118\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/query.js\":\"2c25101b7cd785b4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/resolveFilter.js\":\"f3ffc2a61de8afbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sourceBatch.js\":\"24a7ea1f8759dbf4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sources.js\":\"8687459763dbc226\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useBacklinks.js\":\"1e2d6402a91ab358\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"1a3b9f59109f58f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayCelebration.js\":\"0913eb4571e86aac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayOverlay.js\":\"5bac980c5c767ff5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/gate.js\":\"f7febc46abbbadf5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/index.js\":\"bfd84b67b1bef62f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/wolfTheme.js\":\"e7cf3256de2751e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/BlockDragLayer.js\":\"bcc222dabf64f542\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dragController.js\":\"58b2ed3a71bc33fe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dropTarget.js\":\"ddc4a788c5e28dc4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/index.js\":\"f180df3624f4953a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/projection.js\":\"2b22f04c8bd70b38\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/BlockMetaCard.js\":\"21450f2d1ddb6e12\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/index.js\":\"2a665a94fc1dc739\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/AddTagDialog.js\":\"a96f8305d8e0a851\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1d92a620a1a37701\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/TagNameIssueHint.js\":\"bfc4b99c43fcb25d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/addTagAction.js\":\"e703d6f673b0fd9d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/appendTag.js\":\"d3d4362253486087\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/config.js\":\"c5cdc87a87d5ff3a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/dataExtension.js\":\"8139403490f20f75\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/index.js\":\"e5afe12e7c059da2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/propertyEditorOverride.js\":\"d380b9fe89ce02ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbList.js\":\"3aba07ad309e07a0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4456dcc3c0558a53\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4619c79c63f3d688\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b531f719bec38ccf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1b31c1e64853670c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/index.js\":\"cdc57be348a288d4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"60fddbe06c7e985c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/CharacterCountItem.js\":\"6e01fbcb7fd2434b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ee5c6760dccb8fbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/actions.js\":\"ad5d39d92085ff0f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/blockType.js\":\"846ece0581aaa410\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/charCount.js\":\"9e84da3fa46d4fa6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/dataExtension.js\":\"b23ed0918bc8bcde\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/index.js\":\"8812507bd9814988\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/profiles.js\":\"c9eb3ac19af512e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/properties.js\":\"b5add9a75f63ce9e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/textCounts.js\":\"3ad7c2cac331673b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/colemak-keybindings/index.js\":\"36066d9efbf9123b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/CommandPalette.js\":\"eff99bdb6db14b85\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/HeaderItem.js\":\"dafaae7b58f2a509\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/context.js\":\"0ba7c28ec1cf6060\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/index.js\":\"f0f80e6eb30d8529\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/selection.js\":\"8bae95b94d3e6de7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/toggleStore.js\":\"cd4b99478a16e9f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/useCommandPaletteActions.js\":\"5c6cd1473bee473b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/ContributorBadges.js\":\"b8b63f84088e1d6e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/author.js\":\"3c7bc2cf7a7ceecc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/codeMirrorExtensions.js\":\"402d668afed5cc61\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/dataExtension.js\":\"9204f28abeec3399\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/index.js\":\"1cee023a19ffca32\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/mentionAutocomplete.js\":\"be5af9f9cc348214\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/processor.js\":\"342edd9a7e8acfb2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/profiles.js\":\"1648191b011177cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/queries.js\":\"be4a4200fb30439d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/schema.js\":\"55d0a38f5deb97a0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"2227d0c6ec685e30\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7985e9680f0fedc1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/index.js\":\"ff3a30280a7b9f62\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c8f54bc80f645ea2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6b10478d101ba11c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/CalendarGrid.js\":\"e0c681dcb2497fff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DailyNotePicker.js\":\"aa31901c83be47b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"da932c8ecaffc83f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateNavDecorator.js\":\"696cf57df7893b24\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateScrubOverlay.js\":\"df4647bea61d7f63\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/HeaderItem.js\":\"54647b7c4dfe8ca7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/ReschedulePicker.js\":\"9d92f18945a1c989\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4792ce79ba779105\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/actions.js\":\"93ecc170acb74f34\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/blockDateAdapter.js\":\"792dd4983e98b090\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/calendar.js\":\"60d59782b4ec5482\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dailyNotes.js\":\"9d3300cb55ff9985\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dataExtension.js\":\"a0df0db4266c4fee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubActions.js\":\"2478b94e5da68060\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGesture.js\":\"32d2096be0ca2342\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGestureActions.js\":\"2fd6faf0528da45b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9141de670dae09f7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/deletionGuard.js\":\"061279d1660b92ba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dueQuery.js\":\"19140960a76fd47f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/index.js\":\"80dfc642a7edf8af\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/landing.js\":\"6fcd1cba73e0608a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/localSchema.js\":\"9e1482a50bf0f6b8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/referenceDateAdapter.js\":\"4d2a824f3bfe123a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/rescheduleAction.js\":\"f7d1fb61ee8ed29c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/schema.js\":\"8f334ddbc83badf4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadBlockDates.js\":\"a10796d580f1953e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadDatesAction.js\":\"ccd83b4e0e073b5c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/today.js\":\"d4850a7ff18cb078\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ac461b7e57f7137e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"bcabda31f69458a1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/audit.js\":\"1c393fe13becc299\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditAction.js\":\"ea2e04a67290fc0d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditRanges.js\":\"2e877a55d2e475f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/diagnosticsSource.js\":\"5bd2d1e3608c5f36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/divergenceScan.js\":\"12021d9d24d0758b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/index.js\":\"6352d20e27ddc50d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/propertyChildrenChecks.js\":\"23f4bc001148b783\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/referencesMirror.js\":\"5b1ca9e0a1cc1490\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/rowJson.js\":\"c13e477600962c9c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/schedule.js\":\"70e3792c21751181\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/store.js\":\"57d4e685398634e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/action.js\":\"ce31d67911da8432\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/index.js\":\"c1884cbeb29e01fe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/plugin.js\":\"54e0b09fafe6ae4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"df8ab12aafff524a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/actions.js\":\"60f19ed3dbb4633c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/changeMarker.js\":\"8e577bfec283b00c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/diagnostics.js\":\"3648f701fc950dda\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/fileSystemAccess.js\":\"4863b9bb5b9d34ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/filenames.js\":\"bc0d2aff9ab79cc9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/index.js\":\"12f248add1829ddf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/mirror.js\":\"53a69e529cf63fcf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runLock.js\":\"bfa5cb997c9cbd91\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runtimeHealth.js\":\"afa5b9995ee68e3b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/schedule.js\":\"0382a6e87875a51b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/store.js\":\"e23a981eca591aa3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/index.js\":\"7cec8c789b52e610\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/themes.js\":\"fda3c0432f86bc68\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/facet.js\":\"2638db98c1f4b6db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/useDiagnostics.js\":\"721de22c223be6d0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/dismissals.js\":\"6ba0ca1d6d84dbe2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/index.js\":\"f6fabff56ffc5d30\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/status.js\":\"0d1b2dc112879932\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/store.js\":\"400de773386d932e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c656d1f640cbbc21\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ad0e66e5ce1275c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/actions.js\":\"3539ef7cd4a4c538\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/config.js\":\"ea88573f44731923\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/dataExtension.js\":\"abf0762ceb6824b7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/effect.js\":\"e39e425a87ce4a89\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/index.js\":\"01934d1a48238d5c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/propertyEditorOverride.js\":\"4bcb243c7f89c319\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/useToggleTree.js\":\"7483576b7e17d4cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/ExtractTypeDialog.js\":\"69b05ae013bfa660\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"aca36347b55fbb89\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/PropertyShapePicker.js\":\"bc8da51d62dfb4dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/action.js\":\"bf8b75ea09f37548\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/index.js\":\"a9420fa49578a014\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/FindReplaceDialog.js\":\"889e4c5c9c0d95ef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/HeaderItem.js\":\"0fbe2f7bc9e0b95b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/dataExtension.js\":\"959d6f8411997784\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/index.js\":\"5060d586bd6a1dff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/search.js\":\"49f9e93879c49c80\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/toggleStore.js\":\"940629a5ac4a6d4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/LocationPropertyEditor.js\":\"572c55aff7d67031\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/MapView.js\":\"9627b9542ef71e35\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/blockTypes.js\":\"d4a9b66e92034f0e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/codeMirrorExtensions.js\":\"b8a05e756c0dc580\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/createOrFindPlace.js\":\"6f1e6c973a8a5959\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/currentLocation.js\":\"f9e147b445ec2174\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/dataExtension.js\":\"42f04a18f582b785\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/geoContentDecorator.js\":\"57cc76b34c095482\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/googlePlacesClient.js\":\"656358b188007516\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/index.js\":\"7bf08ca56dd6f0f2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/locationsPage.js\":\"a92801bacc56732f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/mapViewport.js\":\"806e54625a210a21\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/pickCurrentLocation.js\":\"f51f9a5634aa3e9a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeAutocomplete.js\":\"77b5758a302d9cdb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeNameCollision.js\":\"58433073581fe955\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/properties.js\":\"2b6a37e9666bbcb7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/propertyEditorOverrides.js\":\"260683274d223a2f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/query.js\":\"aa6f7b87fb7c6e85\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/usePlaceSearch.js\":\"264b4c87e73eccbe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c32f193dd0c14f20\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"6876783b203acde1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"bddfa9f4be7abe98\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/config.js\":\"fe340ced99af8448\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/dataExtension.js\":\"6749db18202dae74\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/facet.js\":\"706d6e478d363694\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/grouping.js\":\"633fbdf61b23419d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/index.js\":\"5c52a4cc7b92cd4e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6a870ac8a99f74b6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/query.js\":\"199e12e5abbcb334\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/resolveConfig.js\":\"6c98eac9a0aac205\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e55b658fe0d0ca98\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"86975c114b56db83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlDocumentContent.js\":\"badf76642a307c13\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlFrame.js\":\"8011e92e7484eaf3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/actions.js\":\"cebb876f089d441a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/blockType.js\":\"946590b0b4d46aaa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/confirmRunScripts.js\":\"b4fc3facf06b5f7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/dataExtension.js\":\"ac2891e29c4e4012\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameAnnotations.js\":\"56b41a47d0c3b0c3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameDocument.js\":\"c22b26753460226f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameTheme.js\":\"d3301b3a45a1d67e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/index.js\":\"a58aa5ff19f1c57f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/scriptConsent.js\":\"e59d6d15c28e1fbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/sourceMap.js\":\"cd8ecc310816661a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/useDocumentScripts.js\":\"46a9879af5ff8d51\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/index.js\":\"bc4286a37b850745\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/record.js\":\"74b82e28b16fd106\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/recordStore.js\":\"00f3a4d16b891f78\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/responsiveness.js\":\"67f8433f53bc0558\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/schedule.js\":\"105f4f641ee217e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/sessionContext.js\":\"f1c49e2a14fa372f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"716c5d53441ae35b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6c53a2d3d4087062\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/actions.js\":\"9717e03a6da09aec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/config.js\":\"a1e37810c552ae16\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/dataExtension.js\":\"fa452fbed199de01\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/effect.js\":\"63a20ebc7f4d09e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/index.js\":\"9e772da65768cf0a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/keyCapture.js\":\"d93a7188cecb5f75\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/overrideStore.js\":\"e74465554c7eabec\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"66e0c579f7aafcbb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/HeaderItem.js\":\"5867011a9a4b49c5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/LeftSidebar.js\":\"810d21158844e83a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/actions.js\":\"e3e2cacd286ef993\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/facet.js\":\"4db50c7e65f39926\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/index.js\":\"e394f00acbd7e763\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/shortcuts.js\":\"dbc67ae4afd1c8a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/toggleStore.js\":\"d78e1d8a4f30b5b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/MergePicker.js\":\"3a1485c6c761a7b6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/index.js\":\"a70e0b292af5be59\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/mergeAction.js\":\"1481d2a886e4b11b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/strategy.js\":\"25762e592a765455\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/Button.js\":\"8c5d40143fcd8119\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0cb728826e756f70\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/defaultItems.js\":\"fed22120d08cb778\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/facet.js\":\"674f902e5fc6cca9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/index.js\":\"198ecaad1428fa00\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"dcafe5a285588ab0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8fef89e7b553b638\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1e25b1af57c5f46e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ac9028fbde4230b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/index.js\":\"b4cd4034fae9b62e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2bfc60c78c5f8df7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/blockSubtreeMembership.js\":\"db9c10c431ceb0e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/contextMenuItem.js\":\"6be7d78028b80427\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/index.js\":\"ce72cbfe30e62bac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveAction.js\":\"dbd710b3477e822c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveBlocks.js\":\"ca905bec8ca4666f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/selectionAfterMove.js\":\"9175b1e290655704\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/TutorialBanner.js\":\"afec798cb28c00fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/action.js\":\"15f888aa088b4c7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/bannerDismissal.js\":\"2adfdf44b657e358\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/documents/cheatSheet.js\":\"bd64586a41e421b7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/index.js\":\"a4ccb2b2e9d644a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/keys.js\":\"044aa2393922e09f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/landing.js\":\"9627c4dafa471174\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/outline.js\":\"cdca5c31caec9e40\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/seed.js\":\"47a611ad85cdd829\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/PerfTrendDialog.js\":\"20524b0ac6660cc9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/analyze.js\":\"74bfa954606582dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/diagnosticsSource.js\":\"d6d3dea318f38760\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/index.js\":\"c76934e7df398c8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/load.js\":\"1104044d9ea8cf33\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/monitorRun.js\":\"2ab7adcc4e0899d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/schedule.js\":\"8d3ab90d4bade83f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/series.js\":\"f09f295425019b31\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/store.js\":\"f4f478e6aa315eaf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/trendAction.js\":\"dc7a717044bb2094\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/verdict.js\":\"7e30b014c972a752\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/clickToEditAction.js\":\"46a673fce05e78a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/index.js\":\"c4864a1ecf8779c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/interactions.js\":\"d408baad6a7768e0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"fa143c898935187b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGate.js\":\"d676380019e291c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGateDialog.js\":\"f1f9f89c7f67cca5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/action.js\":\"e03520bb2e855906\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/index.js\":\"9a4cd720a4c9d9a0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/localRunMessage.js\":\"26ac9f0d2d8fbaf8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/plugin.js\":\"38cfe23b023217e8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/progressReport.js\":\"4b08b82efc30067a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/sweepProgress.js\":\"099d561b69b1fb2b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/FieldRowRenderer.js\":\"35eced3aaa54cf07\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/ValueRowRenderer.js\":\"e2abb428a27fea06\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/actions.js\":\"fa8d5df1cb880d35\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/autocomplete.js\":\"02f223642a41dfb9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/fieldRow.js\":\"953823ddeca1eb5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/index.js\":\"691d77e462488417\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/referenceWarning.js\":\"818e12ba8148dfa1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueAutocomplete.js\":\"f75e1000cb383f7a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueSchema.js\":\"7e23e71b5094b556\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/HeaderItem.js\":\"896900913cd174a1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/QuickFind.js\":\"d6401bba2d3475a9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/index.js\":\"a6dfbd8030a45cc7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/recents.js\":\"0df518d229bff3df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/resultItems.js\":\"f0186e5195e970f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/selection.js\":\"b1139b7a6ee88bd4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/toggleStore.js\":\"d0399489d7c1a20f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/HeaderItem.js\":\"5815eedded2f0bc4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/RecentsPageBlockRenderer.js\":\"06223168a90e3073\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/grouping.js\":\"c7224b6b5d5d1895\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/index.js\":\"1b49fc6ae3a2405a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/target.js\":\"ff4eafe1c7a8a027\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/codeMirrorExtensions.js\":\"e9da5287f3ff5ab3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/contentPrefill.js\":\"1239fa0799a867d8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/dataExtension.js\":\"bf0fc18eeea17ef9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/index.js\":\"31968702f3b19e87\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b27e713de42989fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/invalidation.js\":\"159fa1c0c5244348\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/localSchema.js\":\"8502d23d0c6f6847\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/index.js\":\"9122cabb8f22b273\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"bbcdb0ea7e2e10f8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/index.js\":\"12d7aee07687daf9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/referenceNode.js\":\"8e8ccecceab55ad8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e41a925ecdcc4501\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"05bfc5e29b68512c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/index.js\":\"32ddc948ba9e910a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2774bd1b2a80606a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7c43580721dfcee7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/mergeRetargetProcessor.js\":\"814aa189525f5742\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/parseFence.js\":\"8577ebf61149ffa9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceParser.js\":\"22cf468fcc71716e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceProjection.js\":\"1857b97ab7da4c99\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referencesProcessor.js\":\"fa954eb259e866cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/renameProcessor.js\":\"9f05cb9e87d6d9fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/spanReplacement.js\":\"cc8411d55e9beaff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/htmlToOutline.js\":\"4039be769342debe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/index.js\":\"6e1adc4bcc94d090\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e8f03bc7565b2b8f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/pasteDecision.js\":\"ac26d1adf169638c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/action.js\":\"c1824d436d2d5139\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/blockIds.js\":\"8b0311d9734a28a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/content.js\":\"e06c69270d585e82\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/effect.js\":\"f8ae251dd9364864\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/ids.js\":\"587f477a8ac940d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/import.js\":\"69bf337b7fe09c43\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/index.js\":\"afb8e2f3965debbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plan.js\":\"773f2fcbce5711de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plugin.js\":\"55b489b8f0ad7877\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/promotion.js\":\"72365f82b69f1ff1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/properties.js\":\"14327889202c7944\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/references.js\":\"cabb3c0a26d0a94f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/report.js\":\"ff5fe1b0e3c8189a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/roamMemo.js\":\"dd9758e33ef48369\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/runtime.js\":\"8aec8bc538946b36\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/schemaReconciliation.js\":\"dd95ac6c12c2dd71\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/srsMarkers.js\":\"1c6697f4e945c41c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/todo.js\":\"5ea8be2aa81864bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/typeCandidates.js\":\"b28ab8761f4ce78b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/types.js\":\"5a3b6b7a493146ce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/index.js\":\"a813fd35bba8c9ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/store.js\":\"be43eb2ea9e5a6b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/HeaderItem.js\":\"727a45ba52692aca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"aacc23ed331c851a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/index.js\":\"cc228aa532754c11\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/model.js\":\"c6046575d20dc555\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/toggleStore.js\":\"60d4a8ec2878ce9e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/useKeyInspector.js\":\"24be44b4a23f7fe8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9afdf8a9ec32e03c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/ShellDecorator.js\":\"97ec157271e302b7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/actions.js\":\"a2fdc12aa3bfa19c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/exclusionsFacet.js\":\"42d123f8729373f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/index.js\":\"2471cbd0a0f6751d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/shell.js\":\"b4e7848bc9725f91\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/surface.js\":\"ce9cfd9fe2aac504\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/walker.js\":\"a68e4036e4e787b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/RescheduleToast.js\":\"90fa1bf72e456f10\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/dataExtension.js\":\"40f45d3ee6936e5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/index.js\":\"ef211338f1913817\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/indicator.js\":\"232bedc6d924c5f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/moveSrsState.js\":\"c70d0e6eb971581d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"cc593d3cf72d37a0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/scheduler.js\":\"3347945ae36fa2e4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/schema.js\":\"8d9949039fc91773\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"5304d860d7d9b3df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsClipboard.js\":\"b81a29d7523c1a0e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e436b3c5399fb918\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DailyNoteReviewHint.js\":\"121d462ee536ca46\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DeckPicker.js\":\"05d8b45dc9a93d59\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewControls.js\":\"aa4ddffb03fc5c7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6ee052b6a22e013d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewSession.js\":\"30e72fd8d213c7e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/actions.js\":\"6356ab27209758b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/archive.js\":\"3077df9211b14d01\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dataExtension.js\":\"33a4a8366df78fe7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/deck.js\":\"e8999b6495891de4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dueQuery.js\":\"5256a7d93cd9f602\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/gradeDecision.js\":\"394599824df3240f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/index.js\":\"d141738d2b2d7d9b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/keyHints.js\":\"4f4705d93d48c0d8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewCardLayout.js\":\"a014b584d4dd84bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewProgress.js\":\"332928c81b8692e8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/schema.js\":\"14023ba667baa69f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/useDueCards.js\":\"7ac9f8c25bab6926\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/index.js\":\"97858cf5361be1a4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/record.js\":\"66cf059bfda2ca34\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/index.js\":\"537d9b5a48a9e285\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/persistenceStatus.js\":\"9dde05947a4a3f3c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/requestAction.js\":\"9d327f8e73c5c5e0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/TypeChipsDecorator.js\":\"698c40942af6ee4f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/codeMirrorExtensions.js\":\"9aa640a719d4b4c5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/index.js\":\"e39dd29ed8ec8049\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/typeAutocomplete.js\":\"64c3f0cb07512202\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f7c8f36b1570a5e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/actions.js\":\"542750ede845e664\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/anchor.js\":\"d47374ff7a2bc77e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/events.js\":\"e1ec03e8a7b8ccbf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/gestureActions.js\":\"b08166d6931a9730\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/index.js\":\"0df0fc6ed64e664e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3b27a901c23b534a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/collect.js\":\"0f366721ea194005\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/index.js\":\"2495361ee1cbea8d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/record.js\":\"13d70e9c0156b0d4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/RejectionDialog.js\":\"6d3e1f8f55f088c7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/SystemStatusHeaderItem.js\":\"8b0b8a049b3ed93a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/index.js\":\"9494fc5c021745ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/model.js\":\"d6a939fb91251295\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/queueCounts.js\":\"c0b7314e654b8909\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rejectedHelpers.js\":\"14a61903ff51d958\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rematerializeAction.js\":\"d949735d74c21288\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/useHysteresis.js\":\"f810af7763f55581\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/ColumnHeaders.js\":\"49ec73ae9acc11f7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/TableLayout.js\":\"a50938a56ef46dac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/actions.js\":\"97e7d08a4d4a141c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/cellEdits.js\":\"546ca519d03b1b59\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/columns.js\":\"89dd86e079b49677\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/controller.js\":\"f494d219f8cbd993\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/convert.js\":\"a5a63fdea1f8de66\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/dataExtension.js\":\"130822db7ab5554f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/index.js\":\"bddb3a02f4316e56\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/keys.js\":\"1927e5b03fd32aaf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/model.js\":\"235239738e34dfe7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/format.js\":\"2f8dae6e3971c9a4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/parse.js\":\"0ea54b61ca9ef628\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/registry.js\":\"fa488a507cbf44b9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/schema.js\":\"93fc04d66e61de7b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/effect.js\":\"a703b6a35a34dddd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/index.js\":\"d83188e98eb1fdbb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/theme.js\":\"8c6620cb67747536\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/actions.js\":\"91e788724b281045\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/dataExtension.js\":\"58e7db1ebd60a902\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/index.js\":\"03b8fa4f91f84d69\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/schema.js\":\"e4ff5ce3bb64ab9a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/TouchSelectionLayer.js\":\"26fb48a4cd5a9022\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/actions.js\":\"5c7c4813d2d5a970\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/defaultItems.js\":\"5e3686fad6e8ba54\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/facet.js\":\"ddeeeae487911f67\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/holdRecognizer.js\":\"174c52ea1fff088f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/index.js\":\"004732520fb8f979\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/UpdateIndicator.js\":\"50c78c64a8c45666\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/index.js\":\"a2b290d969ecde07\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/loadTimes.js\":\"7f88712d81ea3cbe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoNotesRenderer.js\":\"949849e53413e177\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoPlayerRenderer.js\":\"1bb3015fdfcbc0e2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoTimeStamp.js\":\"637fc35338d5f362\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/actions.js\":\"d9640ba1489a3102\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/index.js\":\"676d33471600aec2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/markdown.js\":\"d25426a43be0908c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/notes.js\":\"b96694ae954d093c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/registry.js\":\"772192e4d1ea1cdc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/remark-timestamps.js\":\"fe9d8361f651f372\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/view.js\":\"5d836125af403546\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/LinkHints.js\":\"ca0ef23c8517aad8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/index.js\":\"8975e529f286ab90\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/model.js\":\"7b57e972dcceaa11\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/settings.js\":\"55c348073a4bfca1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/actions.js\":\"7fe05507ee2e369a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/index.js\":\"ab865b35e3c2abd8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/interactions.js\":\"ae120e07a1615e8f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/workspace-header/index.js\":\"b5bc1bddaf4e4db5\",\"/knowledge-medium/pr-preview/pr-1835/src/registerServiceWorker.js\":\"db69669f1b7f68bb\",\"/knowledge-medium/pr-preview/pr-1835/src/requestPersistentStorage.js\":\"bc175eb983b7b4e9\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authRequestDeadline.js\":\"22873ddb98e18bf5\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authStorage.js\":\"8a3296d9af110c31\",\"/knowledge-medium/pr-preview/pr-1835/src/services/powersync.js\":\"070095602cb25aa8\",\"/knowledge-medium/pr-preview/pr-1835/src/services/supabase.js\":\"6b146e2c0c1e4b53\",\"/knowledge-medium/pr-preview/pr-1835/src/services/uploadErrorClassifier.js\":\"a9872c7149f4dc29\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/ActiveContexts.js\":\"884d46a8d4e1b335\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/HotkeyReconciler.js\":\"c40569f3237a2a06\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/WipeLocalDataDialog.js\":\"865dac95a8c646eb\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionDispatch.js\":\"fadb7cfedadf5982\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionRefItems.js\":\"2fa5665e44c48378\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/applyKeybindingOverrides.js\":\"a125d446b743249b\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/blockActions.js\":\"53e540cf143624ca\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/canonicalizeChord.js\":\"e198d0bda2c50b2a\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultContexts.js\":\"11440cdef2ec45f2\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultShortcuts.js\":\"50efa4004ddc20ca\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/effectiveActions.js\":\"e707b28f572163a9\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureAction.js\":\"6d371692ed9b8dab\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureBinding.js\":\"5772b6e3da25189d\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/holdRegistry.js\":\"7e69e687ae234984\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingConflicts.js\":\"9c70e86fe8f66411\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingOverrides.js\":\"dada9b7449eae24e\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/pointerAction.js\":\"858f9127785c6407\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/resolve.js\":\"fb24b41fc5eda82b\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/runAction.js\":\"a9b85538ed9ecf70\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/sequenceMatcher.js\":\"b9c50bcff8c6c351\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/types.js\":\"239a7f0645f23468\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionContext.js\":\"bed2f502a25a81ee\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionDiscovery.js\":\"77c22ef75c7f3063\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/utils.js\":\"36507e6f57359474\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/bootStore.js\":\"2ec6821a2ca55bd1\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/previewDatabases.js\":\"911172a05189b700\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/byteTransform.js\":\"3b987430ed433c26\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/attachmentCleaner.js\":\"95d0bbbeed5624ee\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/attachmentParts.js\":\"fd154044396deef1\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleParts.js\":\"af875da980534fd9\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleRecord.js\":\"13a0d84d0737844e\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/manifest.js\":\"38b78b367217bff2\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/takeBundle.js\":\"c53f7026d00f68be\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/verifyBundle.js\":\"236982b1ac6cbcfe\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/cleaningStage.js\":\"7460ad15b307bd5f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionKey.js\":\"7084ee693b6033a5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionServer.js\":\"18cc38a7e73b5f50\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flip.js\":\"60fcde32b1ff5141\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flipAttempts.js\":\"3110b98f7b86c862\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/pages.js\":\"8c0e484ac80da06d\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/preflight.js\":\"54e8a7d75a29f822\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/reseal.js\":\"c61d4e3b18ff563b\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runConversion.js\":\"29428685c94ce055\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runLock.js\":\"47231e651ad0e525\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealing.js\":\"5f5ecf81dd2ef974\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealingStage.js\":\"e9c5b163adf020d4\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/stage.js\":\"bd6e84c93f3c2947\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/verifyReseal.js\":\"c2d861bfc30b9dcc\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aad.js\":\"68ba9e043d8addbb\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aead.js\":\"43e539e1581a8414\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base32.js\":\"8f28432ef7fe720d\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base64url.js\":\"d2b8bad87b6f0e27\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/binaryEnvelope.js\":\"fcc24a1da50815c6\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/byteAead.js\":\"75bd327887b48131\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/canary.js\":\"524d1a68b15472e2\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentHash.js\":\"6883bb1e25dce5b4\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentKey.js\":\"fcd212c70fc0f95c\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/derivedIdNamespace.js\":\"9f5ac3da5c1cd468\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/envelope.js\":\"a8ecab805916551b\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/hex.js\":\"6a1a97f42d5f3be7\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/sha256Hex.js\":\"40ebb709c4eaa4b0\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/workspaceKey.js\":\"15ddb41f874b5404\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/conversionState.js\":\"4fb880bc7ed73dca\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3978b27519d39502\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/pastedKey.js\":\"79edee490ab6e1e1\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ef528105b8e33def\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/upgradeWorkspacePin.js\":\"80a984af678e4755\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/keyStore.js\":\"aad67b8cb59c6215\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/mintWorkspaceKey.js\":\"5c88244bb8e69dc7\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/modePin.js\":\"26793cbcd3efb542\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/openWorkspaceKeys.js\":\"93e4abc1d148de5a\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolveWorkspaceEntry.js\":\"bcd9d4dfbb51e333\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolver.js\":\"4b1e4bf344654461\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/workspaceAccess.js\":\"73dc6bda8f1ea902\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/transform.js\":\"be2fcbb3b5cf64cd\",\"/knowledge-medium/pr-preview/pr-1835/src/themeBootDefaults.js\":\"57b483a9a5a3f712\",\"/knowledge-medium/pr-preview/pr-1835/src/types.js\":\"5eb19f70d863dfb0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/ClientLocalSettings.js\":\"1a85ae4c4085a161\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/abortableSleep.js\":\"501c4ffb8423860d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/array.js\":\"31bb4736a494a3ed\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/backlinkAutocomplete.js\":\"d82fb3efe9dc2c7a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockCrumbs.js\":\"a4b8538d1018b58a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockrefAutocomplete.js\":\"f2ea5c1e55b84900\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/cadencedIdleJob.js\":\"40c12a944d4070f9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/callbackSet.js\":\"2196194d959cbada\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/clientId.js\":\"f25cf226e3e9be5a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirror.js\":\"836279d197d6b59d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirrorCompletion.js\":\"c9453fc30f21f735\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/copy.js\":\"e4cd1b6559dd59a3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dailyPage.js\":\"04495a822989eca2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensics.js\":\"5228830a171cfb3c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensicsHooks.js\":\"d7a025501f99a351\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/deleteBlockThroughUi.js\":\"68208012d209308a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dialogs.js\":\"f8428334fe5a4610\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dom.js\":\"74f77775cb2ac14f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/downloadBlob.js\":\"e6fe912c8d2c34f9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/exportSqliteDb.js\":\"5e4c223fd8922443\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fileSystemAccess.js\":\"8345875a7e0b270f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/flipSlide.js\":\"30f0114d135680cf\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fnv1a.js\":\"e080e1228961e9e8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/formatBytes.js\":\"ce500a65e8527360\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fuzzyRank.js\":\"28f28863bd6eb381\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idbKeyedStore.js\":\"18984bfc50a25b49\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idleCallbackPolyfill.js\":\"fa284b11b935b6be\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardAwareScroll.js\":\"c331d7f8d9d5c929\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardViewport.js\":\"5dd42a698f6251c2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/lastWorkspace.js\":\"5c1c9d71b329e73e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutColumns.js\":\"8b6c6b8f5ff0a76f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionDom.js\":\"b96a798cd9141286\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionId.js\":\"f0c6763883742be9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkClickGestures.js\":\"b6939b01592da5d7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkTargetAutocomplete.js\":\"f7379ddbf9f9c4cd\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbCorruption.js\":\"fb83ce1ccc93605d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbRecovery.js\":\"d175da350a1a48b5\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/markdownParser.js\":\"5bebecfd914a9e78\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/memoize.js\":\"dbbf901b58ed07ce\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameFieldCommit.js\":\"35bc5bba60d1eac4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameList.js\":\"494d308f5dbe6abc\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/navigation.js\":\"35652e28469ec5d6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/omnilinerNamespace.js\":\"6e1f32b322d76935\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/opfsPageScan.js\":\"edc88af44af4a9f0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelClearance.js\":\"356a1d03a74a4135\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelHistory.js\":\"3eba2214d0b7292d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLanes.js\":\"8729777d0f61a1a9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLayoutProjection.js\":\"8b41ffdcd963200b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelScrollAnchor.js\":\"36658222c234fc87\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelUrlFlags.js\":\"e568fa08a56b54e4\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/platform.js\":\"eb73e217e2af7e27\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/pluralize.js\":\"3e433f12424d9cea\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyCreation.js\":\"47929d864866a137\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyNavigation.js\":\"24e59fd61c5727f8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyValueContext.js\":\"5f3e6c7219bd1a54\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/react.js\":\"08db676f3eaaedac\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeDate.js\":\"5746935968411617\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeTime.js\":\"3e15f6df1af6d8ce\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/renderScope.js\":\"72e65e3ec8a59b4c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/resolvedThenable.js\":\"fb35acd5980850dc\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/routing.js\":\"b2b8e6b4967e2c47\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/safeMode.js\":\"4cd9ce33eeefabb9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/scheduleIdle.js\":\"4ee676eca1241d8e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/screenWakeLock.js\":\"745d2684e9f40aa3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/selection.js\":\"aa345ff1f8d73296\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/softKeyboardGrab.js\":\"af402cc3e3e0cae6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/startupTimeline.js\":\"ca051055c66c9781\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/state.js\":\"690c51cf22259813\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/string.js\":\"9521aea67f513ba7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/surfaceZoom.js\":\"04568252425f6334\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/time.js\":\"0c1ecff5c7c36991\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toast.js\":\"5f3fc727e1f8fa4e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toggleStore.js\":\"377032d7535b003a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/untilStopped.js\":\"2e833b6c66874e4f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/userActivity.js\":\"43c1d57d2fc3b3ac\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewTransition.js\":\"5e110537e137f460\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewport.js\":\"facbbf4a2508dff9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/webLock.js\":\"c53bf07f99010f1a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceRecovery.js\":\"4ad1d52ebb432d92\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceSnapshotStore.js\":\"09dcbdd3c20503d8\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-compiler-runtime.js\":\"6e2e893d6fd57d87\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-client.js\":\"8aa4d43a96968a95\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server-edge.js\":\"26febfc7d1123c13\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server.js\":\"96b7ee7d5481be4a\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static-edge.js\":\"98b13acd40fcd5b8\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static.js\":\"e8c99038960945f6\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-test-utils.js\":\"7c077f0fd36df9b7\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom.js\":\"0001c9dfa555281c\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-runtime.js\":\"09e5f6c0872512ba\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react.js\":\"e199a61c356b3392\",\"/knowledge-medium/pr-preview/pr-1835/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
