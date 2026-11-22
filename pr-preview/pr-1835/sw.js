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
		buildId: "f279cb439d84-e3c00f87",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/\":\"2ec7504531f57c38\",\"/knowledge-medium/pr-preview/pr-1835/index.html\":\"2ec7504531f57c38\",\"/knowledge-medium/pr-preview/pr-1835/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1835/assets/FacadeVFS-BoZeKy0e.js\":\"5fccdc39e3e9d0d2\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSCoopSyncVFS-C554CYtm.js\":\"89d0cdd720b1e1c8\",\"/knowledge-medium/pr-preview/pr-1835/assets/OPFSWriteAheadVFS-D-ARDwTp.js\":\"111b65c452559013\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-CfFcOy3a.js\":\"ccb0717c96dc86f3\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/assets/wa-sqlite-async-ecAwXFSi.js\":\"36e79fd0a2bc2403\",\"/knowledge-medium/pr-preview/pr-1835/assets/worker-BVuoIuZy.js\":\"442140cd1ac040b4\",\"/knowledge-medium/pr-preview/pr-1835/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1835/chunks/app-Bip36c0I.js\":\"ee6691f573e5efb2\",\"/knowledge-medium/pr-preview/pr-1835/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1835/index.js\":\"2c54926e4772b3bf\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1835/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1835/assets/AccessHandlePoolVFS-BJe-RLwr.js\":\"acbe336f23eaac43\",\"/knowledge-medium/pr-preview/pr-1835/assets/IDBBatchAtomicVFS-DdaWcIgF.js\":\"7d3c7ee66c8bb727\",\"/knowledge-medium/pr-preview/pr-1835/assets/MemoryVFS-CduzpJx0.js\":\"c354dfd2ef37f7b1\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-Q_Tx3yzG.js\":\"8a033b0c1634f22b\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-D1J0A38Y.js\":\"0bcebdc41467f094\",\"/knowledge-medium/pr-preview/pr-1835/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1835/chunks/AccessHandlePoolVFS-B3IVueRy.js\":\"da355dfe9a467015\",\"/knowledge-medium/pr-preview/pr-1835/chunks/FacadeVFS-BRQLiE5h.js\":\"b8692a86d5222561\",\"/knowledge-medium/pr-preview/pr-1835/chunks/IDBBatchAtomicVFS-By4IC0TJ.js\":\"ec539b332bba6c4d\",\"/knowledge-medium/pr-preview/pr-1835/chunks/MemoryVFS-B3f1MeT-.js\":\"8c6b888b8dfe00d1\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSCoopSyncVFS-CDi9VZuC.js\":\"1b20bf982fe40a15\",\"/knowledge-medium/pr-preview/pr-1835/chunks/OPFSWriteAheadVFS-6FdwvdiR.js\":\"13dbfd3620855de3\",\"/knowledge-medium/pr-preview/pr-1835/chunks/Preview-ivFuSM9L.js\":\"4cf0b39ac14be400\",\"/knowledge-medium/pr-preview/pr-1835/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1835/chunks/card-taEeKDV2.js\":\"ebecb400c72f6bc0\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/dist-Bzz0724H.js\":\"ab18def92712cc72\",\"/knowledge-medium/pr-preview/pr-1835/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-async-B9hR_7Lk.js\":\"bbd850c55cebc0df\",\"/knowledge-medium/pr-preview/pr-1835/chunks/mc-wa-sqlite-cAgv7Ezj.js\":\"3a0d779a46aa8844\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-1mTf8Te_.js\":\"3140f487360b5e47\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CMaLyp_s.js\":\"c1afd7d47e1d0970\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CYPMgEni.js\":\"e4eee83316a18a88\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-CnfOheLR.js\":\"bf9d3bc6e461cc82\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-Cw4Q-d7E.js\":\"571c0570a1648e29\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-Dzuwi8qU.js\":\"a62f2ce928de5f33\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dSjT8yQ2.js\":\"952d20814618c4e8\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server-legacy.browser.production-BMWQr7QF.js\":\"2f09102b54683ba5\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.browser.production-CW31WBvR.js\":\"c4c2ae79ef60f857\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-dom-server.edge.production-DQ6a6gxH.js\":\"6cd6699c9ea3685e\",\"/knowledge-medium/pr-preview/pr-1835/chunks/react-mfEbPLIc.js\":\"1aa690cb3a9ad12a\",\"/knowledge-medium/pr-preview/pr-1835/chunks/server.browser-B5I_B0La.js\":\"9d9c37ab6372f7fc\",\"/knowledge-medium/pr-preview/pr-1835/chunks/textarea-By0c_5T7.js\":\"5ba648e8bc82c8ba\",\"/knowledge-medium/pr-preview/pr-1835/chunks/ui-HcnEhXQz.js\":\"2679d745e718898f\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite--mV--lEA.js\":\"338ae570feb00b83\",\"/knowledge-medium/pr-preview/pr-1835/chunks/wa-sqlite-async-BSfHuVYl.js\":\"63adf8c77ad564c6\",\"/knowledge-medium/pr-preview/pr-1835/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1835/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1835/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1835/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1835/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1835/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1835/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1835/src/App.js\":\"93bf176c30342229\",\"/knowledge-medium/pr-preview/pr-1835/src/appUpdate.js\":\"05aacb36edadf988\",\"/knowledge-medium/pr-preview/pr-1835/src/appVersion.js\":\"c6540481f45b4558\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/initialLayout.js\":\"12da85f83cef1906\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/openWorkspaceData.js\":\"3f3686ae45559b24\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/resolveWorkspace.js\":\"ec376462f655f4e6\",\"/knowledge-medium/pr-preview/pr-1835/src/bootstrap/workspaceBootstrap.js\":\"2efe9c11142524ba\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockComponent.js\":\"127f151040db1ce0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockCrumbs.js\":\"7621f2416fd9e882\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockEditor.js\":\"69f3f0a9451f2998\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockLoadingPlaceholder.js\":\"87be159d345fcfa8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockProperties.js\":\"524776e5323de94f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/BlockSearchPicker.js\":\"8ef37be26001a6b6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ConfirmBulkDeleteDialog.js\":\"671c2f545f4cf125\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DividerHandle.js\":\"7691326b7b0a3d2a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/DraftEditor.js\":\"f4c20cc6c47bdff2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/GutterPill.js\":\"76c44ac1a55857e6\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Header.js\":\"bb51e4bd0fc57f7b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/LazyBlockComponent.js\":\"2fc00a3e2fdf7748\",\"/knowledge-medium/pr-preview/pr-1835/src/components/Login.js\":\"9f6d9ca9c55cc19d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ZoomableSurface.js\":\"3de1bee3da6abf5c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/editModeKeepalive.js\":\"c54ff18abec1ccbb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyDisplay/PropertyDisplayScope.js\":\"1144b9d64efae04f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"db1ed53947331a22\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefPropertyEditor.js\":\"0fe88a0e5433f199\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/RefTargetTypePicker.js\":\"21f0ba2a774bc37c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/SelectPropertyEditor.js\":\"83c4b13a4ec6a1ff\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/TypesPropertyEditor.js\":\"d3a5916fc7b99fdf\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/defaults.js\":\"3b38db0978867548\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/kernelValuePresets.js\":\"e80ddfd45b339a0f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/selectablePresets.js\":\"2acb8d38ff778ffd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyEditors/typesPropertyUi.js\":\"a7ebb243932575f7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/AddPropertyForm.js\":\"79a21ef329e79f56\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyPicker.js\":\"9cb89c4e1cfec95b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/PropertyRow.js\":\"4d241052afa90869\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/Rows.js\":\"5ec759efd3f89a24\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/actions.js\":\"0d1513a73349fffb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/declarationOnly.js\":\"f565031002fa3947\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/layout.js\":\"38b41398db7d8855\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/model.js\":\"62afa7f00e4a6db0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapeUi.js\":\"f143c4ef2016e524\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/shapes.js\":\"7e5d1dfd332edc5d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9b1cb6e3b09d081a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanel/visibility.js\":\"5374d640cbe4ca14\",\"/knowledge-medium/pr-preview/pr-1835/src/components/propertyPanelSections.js\":\"a4dece4bbc94bebe\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockEmbed.js\":\"68ed674aac83de3b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockLink.js\":\"749c456e2962cdb7\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/BlockRef.js\":\"5369198e064c2551\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/ReferenceLink.js\":\"fc3a3133c211bc25\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuard.js\":\"bf9b524f1b8b9752\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/cycleGuardContext.js\":\"74f735e02fc992f9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/linkInteraction.js\":\"48fe5c494b041218\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/referenceLayout.js\":\"8b9f76b33fb25f82\",\"/knowledge-medium/pr-preview/pr-1835/src/components/references/useBlockRefAncestors.js\":\"63820a72250621ce\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockGutter.js\":\"d32bffd075d5c6d3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockInfoDialog.js\":\"72127f9f6c6724aa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BlockTypeBlockRenderer.js\":\"bac0e2f6a5650091\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/BulletHoverCard.js\":\"87301815af925d33\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorContentRenderer.js\":\"9fb175dbf0f0efa9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4ce1df4031c749f8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ColumnResizeHandles.js\":\"ca27827fff40077c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"8b60dc0d23e29b25\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/DefaultBlockRenderer.js\":\"ad8226ebd021b863\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/LayoutRenderer.js\":\"21b5c69140a33a56\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MarkdownContentRenderer.js\":\"98624b9fc8d6b7ae\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/MissingDataRenderer.js\":\"0ca35668e58f1e57\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PanelRenderer.js\":\"f4f579503f3ef947\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e492cabef5a8575d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/TopLevelRenderer.js\":\"59b2a6b2fafe2111\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockGutterMode.js\":\"a7610629c4641014\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/blockTitleText.js\":\"8aec463b35c200da\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/fieldCreationKeydown.js\":\"00eebb4c06d0f128\",\"/knowledge-medium/pr-preview/pr-1835/src/components/renderer/layoutRootContext.js\":\"5423e2ec9a260e0b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/TypeChip.js\":\"8060dc98482e0395\",\"/knowledge-medium/pr-preview/pr-1835/src/components/typeChip/chipStyle.js\":\"39a75ad3ee3e012b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/anchored-floating.js\":\"747842eec0127bcd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/button.js\":\"5182df2337b5c456\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/card.js\":\"f823df0991259fa9\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/checkbox.js\":\"4e6132716fc94d30\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/collapsible.js\":\"dbfa032001ccec7b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/command.js\":\"421b8da8a5e8cdba\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/context-menu.js\":\"99f9edacedf072ed\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dialog.js\":\"e2d84cfeadaedf1c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/dropdown-menu.js\":\"6c69ce3a2d5f143c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/floating-listbox.js\":\"8c535f6d06155041\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/index.js\":\"ea5c110bbc8dde58\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/input.js\":\"1fca4de42598349e\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/kbd.js\":\"918aa1fa80d99313\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/label.js\":\"7f93d2b84014eec8\",\"/knowledge-medium/pr-preview/pr-1835/src/components/ui/textarea.js\":\"be1ffb65b7c407cc\",\"/knowledge-medium/pr-preview/pr-1835/src/components/useEditModeYieldKeepalive.js\":\"7803af487e0c631d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/BootFallback.js\":\"577d4030b17d431c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/FocusedRowLazyMount.js\":\"e65f1a47c7de6219\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LazyViewportMount.js\":\"f199ada1582a6bdf\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/LocalDbCorruptionFallback.js\":\"9ad08586cf457fdb\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/error.js\":\"ef597d3b9fb857ff\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/lazyMountRegistry.js\":\"ae87bfed5a521e0b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/util/suspense.js\":\"b41433095bebd77f\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/CreateWorkspaceDialog.js\":\"781ffba5a3c3cc9a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/PendingInvitations.js\":\"8f119d7fdad73ed3\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/SyncProgress.js\":\"12a0b295f3b5c2ae\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/UnlockProgress.js\":\"5bada19635ff5534\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceKeyGate.js\":\"0df0de572392c04c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSettingsDialog.js\":\"7dbc46f6ea198946\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSwitcher.js\":\"dd6d82c8940c2caa\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/WorkspaceSyncGate.js\":\"008717730d07a5c0\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlow.js\":\"a3549ac045c595fd\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/ConversionFlowHost.js\":\"fb932c92266b675a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/EncryptionSection.js\":\"0633b5f3ee9bdd3d\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/attachmentPrompts.js\":\"9e6c06a9aa0c7473\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/bundleFolderPrompts.js\":\"673c8dda3d7ef35a\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowDeps.js\":\"5d2787a1d0297f91\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/conversionFlowStore.js\":\"302b78c63b77a93b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/flowUi.js\":\"dc6d1553cc636962\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/conversion/useConversionRun.js\":\"28f54de1ce52a68b\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/keyUi.js\":\"84a717a3dfdd868c\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnKeyLoss.js\":\"4182df216dbe4d26\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/useCloseOnServerE2ee.js\":\"2d924cdd73fb30a2\",\"/knowledge-medium/pr-preview/pr-1835/src/components/workspace/workspaceUnlocked.js\":\"a3ed7a0d902524f5\",\"/knowledge-medium/pr-preview/pr-1835/src/context/backgroundSubtree.js\":\"9cbf1991c93dcc6e\",\"/knowledge-medium/pr-preview/pr-1835/src/context/block.js\":\"34d969e0ef06a9bd\",\"/knowledge-medium/pr-preview/pr-1835/src/context/layoutWsContext.js\":\"8919907b6e1c85b9\",\"/knowledge-medium/pr-preview/pr-1835/src/context/propertyDisplay.js\":\"2d623db607cfb896\",\"/knowledge-medium/pr-preview/pr-1835/src/context/repo.js\":\"dc40ef73e2dd2f07\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasClaim.js\":\"637f0891d96a1548\",\"/knowledge-medium/pr-preview/pr-1835/src/data/aliasSeatNamespace.js\":\"9643656cb4aa6ed6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockData.js\":\"bcd28953bf60e94d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/blockType.js\":\"323f1d5adcfd2062\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/changeScope.js\":\"c20a294d93d30f84\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/codecs.js\":\"36313a643e11e1ee\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/derivedData.js\":\"9a9d1a41b763ec72\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/errors.js\":\"d64065372a9f835d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/events.js\":\"07af76a38818f4b8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/handle.js\":\"90a7ba65dde384ff\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/index.js\":\"a8035e2b7557d5eb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/mutator.js\":\"ddbba5895b1b5e1b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/processor.js\":\"ad4a51797d5769df\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/propertySchema.js\":\"130487956c92a92c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/query.js\":\"81599b475e01440a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/sameTxProcessor.js\":\"70928cacb198de89\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/schema.js\":\"90a7ba65dde384ff\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/tx.js\":\"90a7ba65dde384ff\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/typedBlockQuery.js\":\"2d4f9444aa7d72c4\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/user.js\":\"f16c6112c05a4f2f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresetCore.js\":\"003f6cf6347bf4fb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/api/valuePresets.js\":\"ec412f128fe7f7a8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/attachmentCleanerIOVerb.js\":\"2ad0570254dcbb84\",\"/knowledge-medium/pr-preview/pr-1835/src/data/block.js\":\"91b9deec7467295b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockCache.js\":\"1ab9dfb02a7b6a2e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockId.js\":\"dc32604a29543fc8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockLiveness.js\":\"ebaa8aeab7a43f01\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockMerge.js\":\"301deae302f4288e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockSchema.js\":\"69ed0c1d04789552\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypeLookup.js\":\"4d452b2023a36cfa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/blockTypes.js\":\"e1d03b353bb58f57\",\"/knowledge-medium/pr-preview/pr-1835/src/data/clientContext.js\":\"7fe4ff3ff1d1cb61\",\"/knowledge-medium/pr-preview/pr-1835/src/data/dbFileSiblings.js\":\"a17f50541db9955f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/definitionSeeds.js\":\"ddcc7845a914c3bb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/derivedIds.js\":\"4cfb03b8d1a5aa56\",\"/knowledge-medium/pr-preview/pr-1835/src/data/drawnSubtree.js\":\"d9bc324006cc4afd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facetBridge.js\":\"bc30a7e994e81c5e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/facets.js\":\"f9513bec5eab81ea\",\"/knowledge-medium/pr-preview/pr-1835/src/data/globalState.js\":\"955c6a9e3965ea38\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/aliasClaimRederiveProcessor.js\":\"077fe3d6f466e240\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/ancestorBatch.js\":\"8e9fe56db0bd641f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/blockTypeTypeifyProcessor.js\":\"1fe292344bb07207\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/clientSchema.js\":\"4b73d7d337e3c98f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/commitPipeline.js\":\"4845ddc473c3c897\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/devAssertions.js\":\"5e3b296ad3d9bb7e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/firstSync.js\":\"fb7fcfddbafa460f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/freshInitialLoad.js\":\"6eb0afc1bbe31101\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/graphBackfillClaim.js\":\"bd635c986ae16214\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/handleStore.js\":\"3e64fb8318362ddc\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/idleMarkerJobs.js\":\"9c38fdb93223e653\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initialDownload.js\":\"c3dea9cd1e8a101b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/initializeClientDatabase.js\":\"280108b8fb45a88b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/jsonCanonical.js\":\"e393e01f22e66db6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelInvalidation.js\":\"5f6085e7cc97116b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelProcessors.js\":\"5c4598f7ee041618\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/kernelQueries.js\":\"7ac70cf5907a0fef\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/mergeTypeMembershipProcessor.js\":\"72799c00f421262c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/normalizeReferencesProcessor.js\":\"2f76c46ec8c38a78\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/poolInstrumentation.js\":\"9217cfb002c069b1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/processorRunner.js\":\"babcc23b8f67ce72\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyCellBackfill.js\":\"95db9c145935b14d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildMint.js\":\"4e81bf0dabbe251c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyChildrenProcessor.js\":\"ca0739cd73ffb869\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2cebefca2843a070\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyDefinitionSynthesis.js\":\"f1f31099c15e1e1d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyKeyScan.js\":\"f1a1cdc32ed4226d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertySchemaResolution.js\":\"c8ed2895f777ccdb\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/propertyValueEdits.js\":\"9fe145273eee38ba\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/raiseProtocol.js\":\"68b022a9221c3e3b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/readBatch.js\":\"4a6856a2b72d312c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/refProjection.js\":\"935f41e5d678c759\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetLookups.js\":\"71b8e843277b06b2\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/referenceTargetProcessor.js\":\"2665651292109711\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/replayMerge.js\":\"266cff3492888240\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/sqlBinds.js\":\"63aacde7a8ce67a8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6f32ca811f11861d\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/arrivalProcessors.js\":\"2c6300f67394d69c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/invalidate.js\":\"8c724c15ef2ac24e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/materialize.js\":\"3adcb765cf76b989\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/observer.js\":\"eaff272b30396271\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/syncObserver/reconcile.js\":\"b5d881a62201e9be\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/timingMetrics.js\":\"2a0e8bfedf720c7e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/treeQueries.js\":\"00faea032d01c797\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txEngine.js\":\"3bc77d855c2fbe46\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/txSnapshots.js\":\"9006f477bf0370db\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/typedBlockQuery.js\":\"fb768e2f1726c263\",\"/knowledge-medium/pr-preview/pr-1835/src/data/internals/undoManager.js\":\"861937bbf5d461a1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/invalidation.js\":\"fa0b49ca1c329f4a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelDataExtension.js\":\"c01ecaab01a14410\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelPage.js\":\"1a01610b30195950\",\"/knowledge-medium/pr-preview/pr-1835/src/data/kernelValuePresetCores.js\":\"961765aea8e9715f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbCorruptionSignal.js\":\"2e23df4e72d2af09\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbStorage.js\":\"897033ea3274c54c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localDbVfs.js\":\"f200cab253ec980c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/localSchema.js\":\"5b6f4c792971dc45\",\"/knowledge-medium/pr-preview/pr-1835/src/data/maintenance.js\":\"a722fc51c850b91a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mergeProperties.js\":\"1b13bdc51e7cf656\",\"/knowledge-medium/pr-preview/pr-1835/src/data/metricsConsoleHook.js\":\"69a17c9ae3f98d20\",\"/knowledge-medium/pr-preview/pr-1835/src/data/migrationsPage.js\":\"fa5772afcf6072e6\",\"/knowledge-medium/pr-preview/pr-1835/src/data/mutators.js\":\"06661ffd7d44538f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKey.js\":\"298fe8f30cc3c343\",\"/knowledge-medium/pr-preview/pr-1835/src/data/orderKeyPlacement.js\":\"f0e2462b26b1f552\",\"/knowledge-medium/pr-preview/pr-1835/src/data/outlineSurface.js\":\"ce1e78d4cab65708\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingEditorContent.js\":\"c4488b005d3369e0\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pendingUploadsSql.js\":\"b67ec416c29f9491\",\"/knowledge-medium/pr-preview/pr-1835/src/data/pluginStateExtensions.js\":\"21680065530e238b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/powerSyncLogger.js\":\"9a63044ae75b7b9b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/projectorRuntime.js\":\"5baa3cb75b8d0db9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/properties.js\":\"1e932309400608d1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertiesPage.js\":\"902c985bed11c0fa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyChildren.js\":\"f72e7c1645a7aa6f\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionFanout.js\":\"bf292c55b7c1c0b8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionMetadata.js\":\"0967c2c21f6407c5\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDefinitionRegistry.js\":\"5bc6f171cb8e3eda\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyDisplayMode.js\":\"02a24fe9b800db57\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertyRowCreation.js\":\"438f58225db6f2a3\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySchemaCreation.js\":\"81edbe723d7c06ef\",\"/knowledge-medium/pr-preview/pr-1835/src/data/propertySeeds.js\":\"9f37d02ca803ad97\",\"/knowledge-medium/pr-preview/pr-1835/src/data/recentsPage.js\":\"92f7b7e867fb5554\",\"/knowledge-medium/pr-preview/pr-1835/src/data/referenceBlock.js\":\"0763e4b5769a77e9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rejectedUploads.js\":\"a96113e575da930e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/releasePowerSyncConnection.js\":\"bd83116e7cdbfd43\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repo.js\":\"24b34350d89bb137\",\"/knowledge-medium/pr-preview/pr-1835/src/data/repoProvider.js\":\"3bf2e4cb551de29a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/rowProperty.js\":\"5eb9799242798bdd\",\"/knowledge-medium/pr-preview/pr-1835/src/data/searchFilter.js\":\"2562897260b6f6ed\",\"/knowledge-medium/pr-preview/pr-1835/src/data/seedIdentityLedger.js\":\"281b28c1899a88f7\",\"/knowledge-medium/pr-preview/pr-1835/src/data/stateBlocks.js\":\"4a5412353ad8b8aa\",\"/knowledge-medium/pr-preview/pr-1835/src/data/structuralEditPolicy.js\":\"e3c7cc621559ff1a\",\"/knowledge-medium/pr-preview/pr-1835/src/data/subtreeDelete.js\":\"6b5c813a6186ae03\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncStreamLock.js\":\"16c6848a4fa99a1e\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableSqlRecognizer.js\":\"e9a73c13ff976209\",\"/knowledge-medium/pr-preview/pr-1835/src/data/syncedTableWriteGuard.js\":\"ad6235748be7f7e9\",\"/knowledge-medium/pr-preview/pr-1835/src/data/targets.js\":\"b84730cfd221502c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeColors.js\":\"d04addee6be9ba4c\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionMetadata.js\":\"6cfe17b1e1f6eaed\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeDefinitionRegistry.js\":\"a418452bb778ff93\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeExtraction.js\":\"75b89cae0a541456\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeInitialValues.js\":\"4cee3ba3741d5ec1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typePropertyGroups.js\":\"02f05eac766fb9f1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeSeeds.js\":\"794e07916c2f1300\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typeTagger.js\":\"9c32d6da62faf6cf\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typedRecords.js\":\"21b5990c547ba057\",\"/knowledge-medium/pr-preview/pr-1835/src/data/typesPage.js\":\"13ad344e9dc221b8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userPrefs.js\":\"b3202719c5b52bb1\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userSchemasService.js\":\"29a33465b82fc913\",\"/knowledge-medium/pr-preview/pr-1835/src/data/userTypesService.js\":\"b3208942873010ce\",\"/knowledge-medium/pr-preview/pr-1835/src/data/valuePresetRegistry.js\":\"646dd122e17edd4b\",\"/knowledge-medium/pr-preview/pr-1835/src/data/visibleChildren.js\":\"4407712af0e8ff17\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceConversion.js\":\"843b099c2948e341\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceFirstSync.js\":\"c198f8a39e5b7079\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceIdNamespace.js\":\"8b7bd47872678767\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaceSchema.js\":\"5a2028580dce5a47\",\"/knowledge-medium/pr-preview/pr-1835/src/data/workspaces.js\":\"2500fd1cd840a854\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadLog.js\":\"1c4264780469b0b8\",\"/knowledge-medium/pr-preview/pr-1835/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/BlockPasteShellDecorator.js\":\"46bed4a71019082a\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/atTrigger.js\":\"9d7458f9a2f3b0df\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/autocomplete.js\":\"25d11bbebe79d273\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/codeMirrorExtensions.js\":\"56276d9bd345592c\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/contentFlush.js\":\"fffccb8ef50ea20a\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/defaultInteractions.js\":\"5a40bbcae1245f6f\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/editSettleSignal.js\":\"b28251bb4d771c90\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/insertImage.js\":\"18c6f058100c0154\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceCompletionRange.js\":\"2a3b9a5e03c27856\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/referenceTargetTypes.js\":\"c6dab5772ed9c7d6\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/syntaxContext.js\":\"54ea4ae917ed3e86\",\"/knowledge-medium/pr-preview/pr-1835/src/editor/triggerMatch.js\":\"71b852182666d449\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/AppRuntimeProvider.js\":\"0c6857a1b4b2d167\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/BlockFocusShellDecorator.js\":\"261714085f4d7731\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/ExtensionRenderBoundary.js\":\"1f6a49fb638382a8\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/PanelContentRecovery.js\":\"d94e54d9565e98fc\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/apiCatalog.js\":\"a666190366dc3105\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/approveExtensionHere.js\":\"409792f7b44e4365\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/armedCutAppMount.js\":\"64554453d9c2ff71\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/batchableKeyedStore.js\":\"affd555228faed53\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockInteraction.js\":\"5fe5c14431993c88\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/blockSelectionAction.js\":\"7b1418df9771087d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compileExtensionModule.js\":\"7acac913361be64a\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/compiledModuleCache.js\":\"b71f0e3f37e4c388\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/continuousGestures.js\":\"e93c96399f1fc75e\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/core.js\":\"d407863654b05920\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/defaultRenderers.js\":\"455dd3e7536599e9\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/definitionFanoutAppMount.js\":\"db9ff346e04d2527\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dialogAppMount.js\":\"ae5e09f6242cbace\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensionSeeds.js\":\"ac7905d7998bd1de\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/dynamicExtensions.js\":\"b7c95f16ad7a16c1\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/exampleExtensions.js\":\"ddf140099d7860c3\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionApprovalStatus.js\":\"59e70c1e5d4042c7\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrorToast.js\":\"63a1b42b4016dfa4\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLoadErrors.js\":\"3a79e188608b0ffe\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionLookup.js\":\"de9d4fcf2c139653\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionToggles.js\":\"50865cc102a2e3f4\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/extensionUtilitiesCss.js\":\"6f20c7fa3308820d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/kernelPageDeletionGuard.js\":\"a64be2525854b41b\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/liveRuntime.js\":\"de34763e13754717\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/openExtensionsSettings.js\":\"9a0b95f39f3e2887\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/overridesCache.js\":\"af70b902f0ae8e04\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/pluginIds.js\":\"8b22f9cb144e4d5d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/processorRejectionToast.js\":\"ad3f490b1b64de2d\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeActions.js\":\"22fc9707dd513584\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/runtimeContext.js\":\"1acc1a716cf5f1c1\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticAppExtensions.js\":\"4bb784a576ec8d12\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/staticDataExtensions.js\":\"71119acc399d5d4f\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/toastAppMount.js\":\"3c723fd8646f8772\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useOverrides.js\":\"9397ffd23d717922\",\"/knowledge-medium/pr-preview/pr-1835/src/extensions/useShortcutSurfaceActivations.js\":\"324373d509f65902\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/discoverToggleTree.js\":\"1826d6e41152eb6a\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/facet.js\":\"750415799f30b5eb\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/resolveAppRuntime.js\":\"0e05ea36b17090d1\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/runtimeEvents.js\":\"06f13d4cb3c78dde\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/togglable.js\":\"c99bb3b40f383764\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/variantFacet.js\":\"ce47aab29f6d48c6\",\"/knowledge-medium/pr-preview/pr-1835/src/facets/verbFacet.js\":\"1d8e2bb443a50612\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/block.js\":\"ca4b6f5f57fcd775\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/focusedChild.js\":\"a7abab2b6ca31d84\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/propertySchemas.js\":\"8b2a0b3b1e0a4dd8\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/typeRegistry.js\":\"bc0e46d9e0d64719\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAncestorCrumbs.js\":\"84f5944ac5b0bfb6\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useAutocompleteListbox.js\":\"92fa5c3242fc7f72\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedSearch.js\":\"8ed7ce47b606be3a\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useDebouncedValue.js\":\"7184adc96ca47f59\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsFocalRender.js\":\"61fb5a13fe0c583c\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useIsReadOnly.js\":\"9d5c16758b2478dd\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMaterializeBacklog.js\":\"a0434139d40c74a8\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useMinuteClock.js\":\"7778f87e9c9af2e6\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePanelLayoutProjection.js\":\"2c84e4cf3b23c55b\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/usePendingInvitations.js\":\"27a27a6eed11c35e\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRendererRegistry.js\":\"1c4a51c0840c558e\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useRetainedFieldRows.js\":\"0f8dc79e8b047020\",\"/knowledge-medium/pr-preview/pr-1835/src/hooks/useWorkspaces.js\":\"e9faac2c6c59f3ea\",\"/knowledge-medium/pr-preview/pr-1835/src/lib/utils.js\":\"397cc8b8cc782106\",\"/knowledge-medium/pr-preview/pr-1835/src/main.js\":\"d861fb3f5281cd7f\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/MarkdownImage.js\":\"0594ee9344b4c9b5\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/blockSeparators.js\":\"1c1186de887c0437\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/context.js\":\"1b139c4af4c2a6c1\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/defaultMarkdownExtension.js\":\"4ffe49fa080644a7\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/extensions.js\":\"dce8579ed1f16f25\",\"/knowledge-medium/pr-preview/pr-1835/src/markdown/renderMarkdownHtml.js\":\"66bb8b9b99b31dcf\",\"/knowledge-medium/pr-preview/pr-1835/src/minimal-editor.js\":\"940cb7726983e68a\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/armedCut.js\":\"00efe851e1fe991b\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/captureMediaVerb.js\":\"f56827a85a3f007c\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/clipboard.js\":\"f3316d9aca062264\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/decision.js\":\"56dc2da6413c5918\",\"/knowledge-medium/pr-preview/pr-1835/src/paste/operations.js\":\"d81372d2f798cf33\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/AccountHeaderItem.js\":\"b0e2720d63fb8002\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/account-header/index.js\":\"c0e37c26e84f910c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c443c1505eb7a05b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askAgent.js\":\"1b51bd3c963b2bf8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/askedStore.js\":\"8a784a9dc1b9d7ab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1b514086dc1d529c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/chipState.js\":\"a9a78ce78b51ce7d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fe41146e11401dfd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/index.js\":\"611ea4043e0e1954\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"dbc55b33c9fc722b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-dispatch-companion/schema.js\":\"544788b9e8e509e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1f28125bfbc6f553\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ca735eb748cfcf93\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/addMedia.js\":\"2c84aedb698768e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/backlinks.js\":\"68741c62ed33715f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/block.js\":\"7a00a27a654ddc5d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/context.js\":\"1d31cc3d2aaee4ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/displayIds.js\":\"4ab787dfe97203b6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/index.js\":\"94981cdf8c69da1b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/outline.js\":\"956e7fc4847c41b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/properties.js\":\"3c6732679285e0c4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/refs.js\":\"35433d6ed144dcf4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a49e9b7eb4fe568c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/search.js\":\"bddb358b59bd9616\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/shared.js\":\"34a59fc63d4df243\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ce7bfbd040b1ced8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentViews/text.js\":\"b8ab8b4b6aa819ac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/agentWrites.js\":\"b4b7c451f4838feb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/authoringCatalog.js\":\"6b420c47df471d83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/blockRefTargets.js\":\"0911f46dd5620bdf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridge.js\":\"2692c71189035b84\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/bridgeLoop.js\":\"c1a537660f1e1aad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/changeHistory.js\":\"d2a82433935ec28b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commands.js\":\"47fe86dda255ac40\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/commentsCommands.js\":\"940935cae746b585\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataExtension.js\":\"9846781fbdb338d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/dataModelGuide.js\":\"9a1c04d5b6be78a1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/describeRuntime.js\":\"0a0b0d2f608988da\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/extensionLint.js\":\"4b5bb2951e6c9081\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/grainAudit.js\":\"d58f0bd2d77e84dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/healthCommand.js\":\"84e6939c55a48fdc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/index.js\":\"7843aedccd967ffb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/presetIdentity.js\":\"f7d5c75a7289daad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5f6f92d27c834d02\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/readMedia.js\":\"28d3c6d9dcb74c4c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/schema.js\":\"39977ab398e91b0a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/serialization.js\":\"7d563914589d751e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/targets.js\":\"30cd27f1ce2529ae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/tokens.js\":\"c8abcd23a1c006d4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/watchEvents.js\":\"842c05620c2860b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/workspaceGuard.js\":\"e5bce6c46764f690\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/agent-runtime/writeCommands.js\":\"f514feaa69206e68\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/AliasCollisionToast.js\":\"39d0aa91d243d5f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/DuplicateNameBanner.js\":\"c3ed6c67df959bd5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/collisionMerge.js\":\"68bea73e731353ea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/dataExtension.js\":\"a8c8907db67596e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/index.js\":\"486ad1b788657788\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/mergeCollisionAction.js\":\"ac1e90d55f732b29\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/pageStyling.js\":\"31dfca6a17a93dfa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/rejectionToast.js\":\"9a73a73313219caa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/alias/syncProcessor.js\":\"a6d10b2f133c35b6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/actions.js\":\"ad7de8022bead9c7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/addComment.js\":\"64af74393ef69e22\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchor.js\":\"3dd37e4058c11bfc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/anchorState.js\":\"9e2f9204807bdb38\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/commentLinks.js\":\"c77c4cdca3130ea9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/confirmThreadDeletion.js\":\"842b876559ef0799\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/container.js\":\"9d63c74e0206e931\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/dataExtension.js\":\"67ce2ab80e161508\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/deleteComment.js\":\"b00f1181105be48f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/highlights.js\":\"832d41229ab85d9f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/index.js\":\"63f63c6e5815a88f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/linkedCommentsPill.js\":\"4859a27c9ab75961\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/margin.js\":\"a42d2e587f768c6f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/marginSchema.js\":\"5f6385c5050d33f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/newComment.js\":\"116c37e651a62704\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ownThreadPicker.js\":\"c27214f3d81e9f35\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/placement.js\":\"5703d6b03dd45819\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/queries.js\":\"1cffaca18c0f04f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotePosition.js\":\"6ea363415c2a6374\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedIn.js\":\"3927f2d90843b2b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/quotedRange.js\":\"3d0329f30b888974\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/rangeRefs.js\":\"0f2effa6a94f69fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readHighlights.js\":\"77ff9719712969e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelection.js\":\"cba7fd2cb546a8bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/readSelectionUi.js\":\"e27c6261cef006db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/reanchor.js\":\"81d86565969981a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/schema.js\":\"00256706296e1e99\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scope.js\":\"3ba073c338478739\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/scopeThreads.js\":\"6667db53add64ddf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/splitRetarget.js\":\"7098cc79fcd9fa8a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestionCard.js\":\"6d0969a2ba800227\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/suggestions.js\":\"f628f7ac8e486cab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaries.js\":\"03d2bd12d7a1539a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/summaryBatch.js\":\"0209080e1623cdca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/surface.js\":\"232d75cc96b488c6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threadNavigation.js\":\"ba3f702607262403\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/threads.js\":\"a03955a2b2b82473\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/ui.js\":\"dfd24b9c816a3dae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/annotations/uiStore.js\":\"e4b6677f236b58bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/appIntents.js\":\"9b4b81cc6823fa7c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-intents/index.js\":\"24491ba84da106d9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/index.js\":\"e7734b1820b844cd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/app-update-prompt/status.js\":\"cfff8876be1f493f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f240f42ff4d2dce1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaBlockRenderer.js\":\"5bb7c2c3c7591711\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1198d24ac8638cdf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/MediaUploadReconciler.js\":\"941904e6ede498df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetDownLane.js\":\"0430f520b129ecce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetResolver.js\":\"60d3db705c529abe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/assetUpload.js\":\"d6a40081ca3a61db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/attachmentCleanerIO.js\":\"b328e7731c78d218\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/supabaseAuditIO.js\":\"aef2acd23a51e254\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/blobStore.js\":\"385d3c95bb985afa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/byteStore.js\":\"4d3d20a3f4e11a3d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanerIO.js\":\"05e9cc447547b6e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/cleanupAttachments.js\":\"3b8d1a19f0853223\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/dataExtension.js\":\"f28a0056e15446bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/downLane.js\":\"4f9a83989f6273f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/index.js\":\"0f58d7a8de75d7f3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/insertImageContribution.js\":\"73eaf3a216512912\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneArming.js\":\"bbcdc85c17c70eda\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/laneLock.js\":\"06d8ea2436d10335\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaBlock.js\":\"bd673d3bc169ec62\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaCapture.js\":\"0614488a9c736aac\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewers.js\":\"5f25e65d2c239406\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/mediaViewersFacet.js\":\"294361d9583b98db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/pasteCapture.js\":\"472aad80ed8f7bc2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/resolver.js\":\"e9af479a133b0e81\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/retryUploadsAction.js\":\"fdeee2d845bbf808\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/storagePaths.js\":\"bfd08884dca7c4a6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadDrain.js\":\"fea32eec8691e604\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadLaneStatus.js\":\"4029ed6f94dbeafc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadReconcile.js\":\"7fe70a1d822af1ed\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadRecovery.js\":\"bc8ce05986e97921\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/uploadStore.js\":\"6d5640b88927ba39\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/attachments/useAssetObjectUrl.js\":\"3fc33779930759b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d33809f2e2c57f52\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/BacklinksViewSection.js\":\"eee7c7e7804d4373\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/facet.js\":\"92e1f96033e5989e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/index.js\":\"a8450337bacbf77d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks-view/prop.js\":\"0502c5407fef0c13\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinkFilters.js\":\"62c8f7dcc33b2e35\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b906e2bf22d7f954\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/BlockEntry.js\":\"95bcd68a12429d40\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/LinkedReferences.js\":\"ddb8956867320aae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7218b1b5948cf45a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dailyNoteDefaults.js\":\"72bd0ad8b44aa9e2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/dataExtension.js\":\"9a5e060c75cea5c3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/edgeExclusions.js\":\"e74e8c5f96cf6fe2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/filterProperty.js\":\"ce72dfda4eb22452\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/index.js\":\"88ddd26687c20248\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e55c8b4e88bd211e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/applies.js\":\"e183212fd3a10166\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/countQuery.js\":\"7c71d0ec05e24e54\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/expansionStore.js\":\"fc239fa4074d561a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/index.js\":\"705d70315b215397\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7a66997e9d16f1dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/presentationInvalidation.js\":\"0d4a4716607a8fb1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyEditorOverride.js\":\"aa7129b0f0238e23\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/propertyFilter.js\":\"119af0e88fa0043c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/query.js\":\"de9f88dc93a930cb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/resolveFilter.js\":\"e165bbf91a5a4e2a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sourceBatch.js\":\"23d9b5c3bfd91acb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/sources.js\":\"af5f16535539b99b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useBacklinks.js\":\"1d296daa92f4220c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f754af07a143fbd4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayCelebration.js\":\"45a8e4bb39f9c296\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/BirthdayOverlay.js\":\"ec48bbb7ea5316b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/gate.js\":\"d46e6c1e643c1ee8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/index.js\":\"3b2271a5262b4303\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/birthday/wolfTheme.js\":\"5915ed1516049ba0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/BlockDragLayer.js\":\"e6c973dad5e6bd19\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dragController.js\":\"823fc26f0e097d37\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/dropTarget.js\":\"03da4bd408f2abb5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/index.js\":\"d27476b743ef67a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-drag/projection.js\":\"8957ef3f53c40810\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/BlockMetaCard.js\":\"e522611b6f87fb1b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-info/index.js\":\"1bd5a6d58203cd70\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/AddTagDialog.js\":\"9c1b93467d3e5ad9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"3ee490f930a231c0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/TagNameIssueHint.js\":\"08b75f74b3b18367\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/addTagAction.js\":\"d65c06a3e5c70c54\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/appendTag.js\":\"6fac81aa8788b764\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/config.js\":\"fcceab69e6010833\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/dataExtension.js\":\"ba04a4793761e887\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/index.js\":\"15c21cf3e56ded2e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/block-tagging/propertyEditorOverride.js\":\"1b5814378faaa489\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbList.js\":\"76fa638de689c442\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cc1ecb1f105353fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/Breadcrumbs.js\":\"310e60ebb4867c87\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"387a312960b0f15f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"41d618f799bf2bbc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/index.js\":\"030f7fc89803fdb3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5e6a69bc84ddf4c6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/CharacterCountItem.js\":\"f1d08ef26282b524\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/ProfilePropertyEditor.js\":\"8f9e671d9a91a9db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/actions.js\":\"0ae66efd0ff6ce7c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/blockType.js\":\"610481640d399ca3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/charCount.js\":\"ee259fdbe24d4f55\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/dataExtension.js\":\"fe097955e1654b83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/index.js\":\"3671bbac99a41796\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/profiles.js\":\"b30f550bcdc72c90\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/properties.js\":\"e973a21e3d5460b9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/character-counter/textCounts.js\":\"3a80f97cbb5bfe82\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/colemak-keybindings/index.js\":\"4ec28ddc59f1988d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/CommandPalette.js\":\"f97213e1c6545514\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/HeaderItem.js\":\"cec755db191b7765\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/context.js\":\"e27fe8f0d2430d24\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/index.js\":\"fb113c0b6d57fc26\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/selection.js\":\"385440a8b1117f50\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/toggleStore.js\":\"63d03acc99ce5e08\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/command-palette/useCommandPaletteActions.js\":\"20d95aad5728c374\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/ContributorBadges.js\":\"62c67cedd544b439\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/author.js\":\"d6be70eab6b64096\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/codeMirrorExtensions.js\":\"4417c678a2256cd1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/dataExtension.js\":\"6eabe2921f783db7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/index.js\":\"39c74a8aeeea9725\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/mentionAutocomplete.js\":\"b41a0e6815d86f66\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/processor.js\":\"55de5fbc404bb276\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/profiles.js\":\"7a15a3173541750c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/queries.js\":\"d9ff12330f65e41d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/contributors/schema.js\":\"d14e8ad91e9b5e4c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e1e540bd0bd36fc5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4796e6879e4fbc11\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/index.js\":\"16efbb3116eed812\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6cc00b9cf91e19f3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"8e239cbf1e40fd0b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/CalendarGrid.js\":\"0a0d59da6962cb37\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DailyNotePicker.js\":\"f52461a0a964a1dc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d8c679d52eef9439\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateNavDecorator.js\":\"9996fbdbacac9de8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/DateScrubOverlay.js\":\"e9e5c11d080b8525\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/HeaderItem.js\":\"bbb9cd8341af99db\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/ReschedulePicker.js\":\"91aa8c8f8427e2c9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c7b199a2e607c24d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/actions.js\":\"11208bad8fe46908\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/blockDateAdapter.js\":\"38d1b4011115f7e2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/calendar.js\":\"ef6457a03cf241b7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dailyNotes.js\":\"2b67635da8085ee2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dataExtension.js\":\"3a97a096af57fe96\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubActions.js\":\"e33a553f48c6502c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGesture.js\":\"7d51736db626f8e3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0969f277242c1d0a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dateScrubRecognizer.js\":\"800ba21a8faf9cef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/deletionGuard.js\":\"1530f49379599dea\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/dueQuery.js\":\"2a64085e7363dabc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/index.js\":\"834f690bfe18f9ca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/landing.js\":\"d81632824ad8df1a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/localSchema.js\":\"ee354e1b07c91d15\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/referenceDateAdapter.js\":\"159d20ad4d367f4c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/rescheduleAction.js\":\"ac206d3d3ed6e16d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/schema.js\":\"a62d0c411cf00757\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadBlockDates.js\":\"a3bba487d5ca7629\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/spreadDatesAction.js\":\"eb18bd826b427dcb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/today.js\":\"5655ffae0affb1b0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b9e45a1e26dd258b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4d7e153fca58b985\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/audit.js\":\"937e85e59f01fb45\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditAction.js\":\"9d765409e6acbf60\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/auditRanges.js\":\"cc2687722952d9e6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/diagnosticsSource.js\":\"ecb4c81247f1e0f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/divergenceScan.js\":\"cb036a0e45a80b22\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/index.js\":\"03c204bd77e5548c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/propertyChildrenChecks.js\":\"84e5ef4e698e2609\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/referencesMirror.js\":\"e3de5aa74741cec6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/rowJson.js\":\"9ee87273fec9579b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/schedule.js\":\"5118bc641d9f1ddf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/data-integrity/store.js\":\"02afe765014c9529\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/action.js\":\"14c476938748025c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/index.js\":\"8253bc58111d7d6a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-maintenance/plugin.js\":\"776a51230593defd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8f6cbf39c4ad8595\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/actions.js\":\"64cb6dcfbaa8bcd9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/changeMarker.js\":\"46cfd2ecd8fd135b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/diagnostics.js\":\"07ed985db6686035\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/fileSystemAccess.js\":\"9ff905e504eb7d74\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/filenames.js\":\"88c76d2c93d982fd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/index.js\":\"bb9b51e29ab619e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/mirror.js\":\"658bf30e8a7e6e19\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runLock.js\":\"f95ee3f4f214647b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/runtimeHealth.js\":\"0c653574fb76800b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/schedule.js\":\"8eace16bb981aac4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/db-mirror/store.js\":\"fa416b0931b84668\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/index.js\":\"a288a0a68e9db863\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/default-themes/themes.js\":\"978f88a5c2c203de\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/facet.js\":\"f7c8b4d13c5b0888\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/diagnostics/useDiagnostics.js\":\"8166d766b47d23df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/dismissals.js\":\"9faa343c71457ab1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/index.js\":\"ee432d73873aeaa4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/status.js\":\"0ec2b5748a06b197\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extension-prompts/store.js\":\"5458490ea48636fd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d84a9b3507283574\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c4bbddc70aefc9e7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/actions.js\":\"a853899c40c54b58\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/config.js\":\"c3408ca13c8bb885\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/dataExtension.js\":\"df511bf0e50a0b1c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/effect.js\":\"932e852c314d2bc3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/index.js\":\"f3cd2775a1dc385a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/propertyEditorOverride.js\":\"2f72e287858c0e71\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extensions-settings/useToggleTree.js\":\"c37447a5d3ad0b16\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/ExtractTypeDialog.js\":\"a1f05964b7528937\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"aa18def4943972a5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/PropertyShapePicker.js\":\"91ff6ffa40ae1c5f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/action.js\":\"78262852ba59dae0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/extract-type/index.js\":\"8cd1a2571f92125b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/FindReplaceDialog.js\":\"a2f696ee99a476b5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/HeaderItem.js\":\"dec711c10fae4f29\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/dataExtension.js\":\"b632cce54e239ec4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/index.js\":\"e261d10eb01e0c74\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/search.js\":\"a4a911ebbc2318da\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/toggleStore.js\":\"e9cc3c7aa065d9c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/LocationPropertyEditor.js\":\"9b91efa9df4e86df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/MapView.js\":\"1892330db02d7cb9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/blockTypes.js\":\"f3c3fea4143da155\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/codeMirrorExtensions.js\":\"9919dbe6903e9287\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/createOrFindPlace.js\":\"aba3147130077be2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/currentLocation.js\":\"3e21bc68692c4f8d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/dataExtension.js\":\"ffd112fcf7681e74\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/geoContentDecorator.js\":\"d39ef77e27c01023\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/googlePlacesClient.js\":\"4c168cef95d3054a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/index.js\":\"6d5566ddce492432\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/locationsPage.js\":\"e49e46bc9c69f9dd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/mapViewport.js\":\"01ee69582d3374b3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/pickCurrentLocation.js\":\"b566364f13381c67\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeAutocomplete.js\":\"5985f89320e82e3d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/placeNameCollision.js\":\"85381c25f8c96249\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/properties.js\":\"c16d10b9cae64d26\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/propertyEditorOverrides.js\":\"d4cf1758ede1fb88\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/query.js\":\"f29400c8291b85b2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/geo/usePlaceSearch.js\":\"de8986f5c1a1f2ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"06ee16bd008411a5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b0b74ce98587e100\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"aed5b81420725737\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/config.js\":\"fe1742d76540b2a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/dataExtension.js\":\"4ddce30affea1aa4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/facet.js\":\"88d3586c3dd58af1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/grouping.js\":\"86ca9d87d7560c80\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/index.js\":\"547704f83a015df0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"01d1adb5a23db55f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/query.js\":\"2faa577b30c5c497\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/resolveConfig.js\":\"380a153e14a4652f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"33f119bea34cbdd2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a29586e07178d207\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlDocumentContent.js\":\"fdffefb7d271193f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/HtmlFrame.js\":\"ab310610c7b7d47b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/actions.js\":\"54021e13c0ee890a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/blockType.js\":\"fa6864ce3cf8a545\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/confirmRunScripts.js\":\"c53ae547ed477bd4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/dataExtension.js\":\"f040fcb0f581e60b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameAnnotations.js\":\"8ea16043a3c3afd5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameDocument.js\":\"f5b910cb7acf8370\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/frameTheme.js\":\"7c8096a5c4bad47f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/index.js\":\"03ce357b272c4fae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/scriptConsent.js\":\"cd4fdeeadf7b9068\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/sourceMap.js\":\"864f477c17681afd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/html-document/useDocumentScripts.js\":\"3bb566368c6c0f3d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/index.js\":\"8efedc8928b58b89\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/record.js\":\"f6ac544f395dcfb7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/recordStore.js\":\"80600549a36675c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/responsiveness.js\":\"4631db21a4fd3ade\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/schedule.js\":\"165351903dbb9639\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/interaction-metrics/sessionContext.js\":\"b5962a9759ed15e9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c628b7c52312210e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2871df63faad0b93\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/actions.js\":\"cb250d56cfc732fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/config.js\":\"c09dcea38410e819\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/dataExtension.js\":\"237e6410cb2ed3a1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/effect.js\":\"31e2da0e636aa0c3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/index.js\":\"84349f8d7db85034\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/keyCapture.js\":\"13aec8b6d844d4ad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/overrideStore.js\":\"7baadd9eb89117d7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"65fca57a3b26c874\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/HeaderItem.js\":\"6e041f9e15bf4cba\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/LeftSidebar.js\":\"83f2e87cac68e39c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/actions.js\":\"8bf6f76a31424be4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/facet.js\":\"b159263e7f6454e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/index.js\":\"1f7001c4c88fe8a8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/shortcuts.js\":\"9c5282173785ea8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/left-sidebar/toggleStore.js\":\"866a69307699d961\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/MergePicker.js\":\"74b95fd181c3b995\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/index.js\":\"b5054f2827bac72b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/mergeAction.js\":\"798a9e7f7a9ad213\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/merge-blocks/strategy.js\":\"63fc100115a2c928\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/Button.js\":\"8bdbf1939ba5633d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"aa0431f5bc8db7e0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d868083d94622738\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/facet.js\":\"27fa21f00ae87608\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-bottom-nav/index.js\":\"5745c692454d1ace\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cf199ca501ab0076\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d62a6d54dd1aab8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a561faff8aa836bb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f7a0be87e748cc51\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/mobile-keyboard-toolbar/index.js\":\"31ffdcccb0b74c83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5cc8760cf7021e2a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2aa4f4b12504fbf7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/contextMenuItem.js\":\"04d780afdb4511bf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/index.js\":\"7b6a7c685e75307f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveAction.js\":\"b5367b8f8e8195c5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/moveBlocks.js\":\"9a2e12b6e267e603\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/move-blocks/selectionAfterMove.js\":\"edfa16f25bc9e45b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/TutorialBanner.js\":\"cc57a0b1e895bd75\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/action.js\":\"de6eaf70e933ce01\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/bannerDismissal.js\":\"398149ac40e655a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/documents/cheatSheet.js\":\"c67b5c12957748cf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/index.js\":\"feba868d091b834c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/keys.js\":\"e2cba7f6e10fc03d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/landing.js\":\"07a73d98240da44a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/outline.js\":\"9c77ef1591a710c2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/onboarding/seed.js\":\"ea7791d3a361ba0d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b0bd4ddde640a218\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/analyze.js\":\"f6b7b8874e63723b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/diagnosticsSource.js\":\"1949736094645004\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/index.js\":\"b51f044aabe9d6b1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/load.js\":\"4ede35daef4d6519\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/monitorRun.js\":\"583dec07f31b7c55\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/schedule.js\":\"dc0722d16786a746\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/series.js\":\"048ce2e7b6ddfd4a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/store.js\":\"d8b1470f2c8f5cfb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/trendAction.js\":\"32dfd44ab989cdc5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/perf-monitor/verdict.js\":\"671fefa7cf7459fe\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/clickToEditAction.js\":\"43945a4f8f8f5ebf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/index.js\":\"dbf27a2fd954395d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/plain-outliner/interactions.js\":\"2af42d71f61053a7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5cae42f6d51acb81\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGate.js\":\"ab9d1334f4fb6807\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/MigrationGateDialog.js\":\"6a9bf35644d4765b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/action.js\":\"72aa0831ab52d3cc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/index.js\":\"1570e743b025ccc8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/localRunMessage.js\":\"4c6b70338eda2ac6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/plugin.js\":\"dab9a3758fc7109d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/progressReport.js\":\"6313e460f6530f10\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/properties-migration/sweepProgress.js\":\"f6d70e6e7575a6a2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/FieldRowRenderer.js\":\"515b7733da328050\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/ValueRowRenderer.js\":\"b1c372e5f4cc8969\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/actions.js\":\"68b749b396587ef4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/autocomplete.js\":\"2a6ac1abf37ac15b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/fieldRow.js\":\"21d661792efec600\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/index.js\":\"88f3525c20cdf25c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/referenceWarning.js\":\"be4753377b37d784\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueAutocomplete.js\":\"cbd43c649384e916\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/property-rows/valueSchema.js\":\"a18543364ff4c0ff\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/HeaderItem.js\":\"f8fae7103feb5036\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/QuickFind.js\":\"82cf8ee46650b39d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/index.js\":\"9a769dc5c69e9a17\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/recents.js\":\"948cd8504ff7e8df\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/resultItems.js\":\"da3cfb20a50872e2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/selection.js\":\"431cc380f8ce4caa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/quick-find/toggleStore.js\":\"944914141ec5fe5e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/HeaderItem.js\":\"79811a858f0c1726\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a86a1bcd56587a13\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/grouping.js\":\"5bd1068e81ec967b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/index.js\":\"3268b9a81551913c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/recents/target.js\":\"fdb4e458a7f40feb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/codeMirrorExtensions.js\":\"a1e27f61eca34480\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/contentPrefill.js\":\"765f9dc84399e3ee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/dataExtension.js\":\"dff71e7f8a905744\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/index.js\":\"65a7cdab83789f3e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e0df7086d5f60538\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/invalidation.js\":\"5cb6fcb502c9cfee\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/localSchema.js\":\"f92e633f3b5e1fe5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/index.js\":\"5c33eb01b953dd16\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4ec4b046055bb90d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/index.js\":\"0c9a6084747ba8ab\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/referenceNode.js\":\"14b9ee1d78bacd73\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/remark-reference-occurrences.js\":\"470c0c9785f5287b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"62c5f8937aa034f1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/index.js\":\"7e61601de77dec71\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b3f5843696b17f5b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"694aab1c5f1f2c17\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/mergeRetargetProcessor.js\":\"5b20546e241c7d20\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/parseFence.js\":\"6fab36d7feb3261e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceParser.js\":\"713ad8c54812a8fa\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referenceProjection.js\":\"ed1baea53998402f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/referencesProcessor.js\":\"f5b74acf11821014\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/renameProcessor.js\":\"f2cb113e25d454e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/references/spanReplacement.js\":\"6c58c0ffb965e170\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/htmlToOutline.js\":\"526474a9363bece7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/index.js\":\"ec7887f5ae903296\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/normalizeClipboardDom.js\":\"111edca349c473c8\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/rich-paste/pasteDecision.js\":\"298c6c0c66eea35c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/action.js\":\"39e9af11844bb429\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/blockIds.js\":\"ec777c3c736f3f89\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/content.js\":\"59ef3d62dbfa3d8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/effect.js\":\"79d58555330f471b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/ids.js\":\"e9f60c6204b92537\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/import.js\":\"c8749b86d06bec73\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/index.js\":\"07c328fb43551de6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plan.js\":\"dedfc37800b13ab9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/plugin.js\":\"18aa5a08d3a0e358\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/promotion.js\":\"4cd059caea81c51c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/properties.js\":\"579550c9760bbb65\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/references.js\":\"f06313ea8b8a9046\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/report.js\":\"21a81e257cdec49d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/roamMemo.js\":\"ea0ecf88c2d382e5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/runtime.js\":\"a3123a544247b550\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/schemaReconciliation.js\":\"a5b36db9a9367f68\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/srsMarkers.js\":\"bf5704881c55275a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/todo.js\":\"3fed6295122a6c3a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/typeCandidates.js\":\"08373a16073a793c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/roam-import/types.js\":\"6ba1d969cd156d75\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/index.js\":\"cdc2d16302749bc9\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/search-health/store.js\":\"49c85d87c687d91c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/HeaderItem.js\":\"e181ae34c2522088\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"329d441a4215062e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/index.js\":\"5560b5a6f60c6848\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/model.js\":\"664f75eb8aa95f84\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/toggleStore.js\":\"ee812271f413dc59\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/shortcut-help/useKeyInspector.js\":\"fecfd4a8c41ba01a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"13bdc4bd8f85ac97\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/ShellDecorator.js\":\"3746aee11b14b734\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/actions.js\":\"841d2a1b06312e2f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ca2dc28f2357086b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/index.js\":\"6a0d86298eb2cb02\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/shell.js\":\"780ddf53497dcf3a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/surface.js\":\"9cc7a60d646ec7e4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/spatial-navigation/walker.js\":\"69418d7f7a189125\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/RescheduleToast.js\":\"0fa7efc502d59836\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/dataExtension.js\":\"5dbbb3c77067d7f6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/index.js\":\"47d98c0d7dd63b74\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/indicator.js\":\"c5ffcc1389ee798a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/moveSrsState.js\":\"846698d368f007fc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b08149aad3aa0755\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/scheduler.js\":\"f65fc847e0ea6b52\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/schema.js\":\"12325ee60d86ac71\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c55c3241812ee837\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/srsClipboard.js\":\"fca51b63179c80fd\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"64c957c31dcba82b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DailyNoteReviewHint.js\":\"13c7e0c84ba96c8a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/DeckPicker.js\":\"e1332bc838fd235f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewControls.js\":\"0e27f349690d4d71\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6235dbcccea326f4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/ReviewSession.js\":\"94c2b9c5d979e254\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/actions.js\":\"1e830e2d720e7b03\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/archive.js\":\"9f9768144edfaf04\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dataExtension.js\":\"e5da879b7bd65e94\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/deck.js\":\"3ecc39e26dc2d492\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/dueQuery.js\":\"07704ea2e3df12a2\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/gradeDecision.js\":\"fe13eaba183a34d5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/index.js\":\"8df6f187aa7798f0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/keyHints.js\":\"17af706fc26f88ce\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewCardLayout.js\":\"187fff2b95dac036\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/reviewProgress.js\":\"5600eda7a8669c1d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/schema.js\":\"df8501fa1dd78ece\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/srs-review/useDueCards.js\":\"b43e91743f77806b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/index.js\":\"8d4560e1c963311d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/startup-metrics/record.js\":\"e3bd96f9f6ccd155\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/index.js\":\"4043ba59d448ce8e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/persistenceStatus.js\":\"d409f789237b4072\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/storage-persistence/requestAction.js\":\"d593ff6d0d5bd6f6\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/TypeChipsDecorator.js\":\"f5fe60747e66d60f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/codeMirrorExtensions.js\":\"66b5bc137b620fcc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/index.js\":\"84a4ff946b9e6fef\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/supertags/typeAutocomplete.js\":\"9db84940b7efdf88\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"63c41690131d2c79\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/actions.js\":\"314d58cd9dbba52b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/anchor.js\":\"03cc46342d7ea762\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/events.js\":\"920f06f788759da1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/gestureActions.js\":\"78c16bedcc028f6f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/index.js\":\"60bb13d7a318c198\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2fab5206a0d2c323\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/collect.js\":\"6c329fdcb3e0771d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/index.js\":\"eef1baeea1660d8d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/sync-metrics/record.js\":\"a4eea797e17e3000\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/RejectionDialog.js\":\"19b59fbb58eec46e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/SystemStatusHeaderItem.js\":\"fc96b8c43f9c2c0a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/index.js\":\"54048fa9bbe00d0f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/model.js\":\"6b9cd3da8e6f9044\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/queueCounts.js\":\"9391c68cd4edd248\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rejectedHelpers.js\":\"9bfe183bda18ebca\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/rematerializeAction.js\":\"18fc36959ba69039\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/system-status/useHysteresis.js\":\"a787672928e6209f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/ColumnHeaders.js\":\"8447e876ac888dfc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/TableLayout.js\":\"b1e531fe2d719db3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/actions.js\":\"4c046e63c8142a16\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/cellEdits.js\":\"d5bfc96a77d9554d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/columns.js\":\"590b642bb35b5c6b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/controller.js\":\"43b0f1ab14fd0afb\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/convert.js\":\"ad14ee6ec943f146\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/dataExtension.js\":\"358d5859fd2e674a\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/index.js\":\"23fc8582a04ca3e4\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/keys.js\":\"c43c4dd3f0536731\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/model.js\":\"61a62661ec6d18bc\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/format.js\":\"21f633e7fd852d95\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/query/parse.js\":\"3d4844db64a68fad\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/registry.js\":\"a57da120ff4451af\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/tables/schema.js\":\"6496e63518f1f3b0\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/effect.js\":\"96bf350f7c2e0c7c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/index.js\":\"800a4896f844afe5\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/theme-toggle/theme.js\":\"b13e5983819ea56d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/actions.js\":\"c61daf02dcc0ed8b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/dataExtension.js\":\"df059697cb5c8b9c\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/index.js\":\"761eac21480aee89\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/todo/schema.js\":\"734688064540a578\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/TouchSelectionLayer.js\":\"27c9d638e6228bbf\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/actions.js\":\"6e1efec678143d3d\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/defaultItems.js\":\"82cd7aae53088439\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/facet.js\":\"d49fb0101959def7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/holdRecognizer.js\":\"70b610cef9318343\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/touch-selection/index.js\":\"6fc090fe0ce3fcc3\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/UpdateIndicator.js\":\"ce7c7e631fad8432\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/index.js\":\"0fd400062f6c75d1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/update-indicator/loadTimes.js\":\"cf6a765871035e08\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoNotesRenderer.js\":\"852a816949fd4017\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoPlayerRenderer.js\":\"036ce19e2f5964e1\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/VideoTimeStamp.js\":\"17ab1fd65c947c9b\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/actions.js\":\"5f6d617141084c9e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/index.js\":\"56ce3f582d251333\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/markdown.js\":\"38de0e89900dd993\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/notes.js\":\"1d5f880de305e08f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/registry.js\":\"b01a8556eb609b83\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/remark-timestamps.js\":\"9165ea9436d11e85\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/video-player/view.js\":\"d430f853c0350f88\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/LinkHints.js\":\"30cab221548d141f\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/index.js\":\"349164232a0b4c19\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/model.js\":\"29ae351e4a00df2e\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-link-hints/settings.js\":\"6013422995d5f649\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/actions.js\":\"14fd759311cebeae\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/index.js\":\"eb66cbdcce752018\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/vim-normal-mode/interactions.js\":\"bdf38ecb8f4f9fa7\",\"/knowledge-medium/pr-preview/pr-1835/src/plugins/workspace-header/index.js\":\"640f472d17de8315\",\"/knowledge-medium/pr-preview/pr-1835/src/registerServiceWorker.js\":\"59b79b111dafc9d5\",\"/knowledge-medium/pr-preview/pr-1835/src/requestPersistentStorage.js\":\"b2be813fe0e88dc2\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authRequestDeadline.js\":\"3252636c2a43b282\",\"/knowledge-medium/pr-preview/pr-1835/src/services/authStorage.js\":\"c11825e567bd5dfc\",\"/knowledge-medium/pr-preview/pr-1835/src/services/powersync.js\":\"3ab49996c0ef4ac1\",\"/knowledge-medium/pr-preview/pr-1835/src/services/supabase.js\":\"d72971131687e05d\",\"/knowledge-medium/pr-preview/pr-1835/src/services/uploadErrorClassifier.js\":\"b6597b94af3451cc\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/ActiveContexts.js\":\"803af10d152bf3eb\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/HotkeyReconciler.js\":\"b0dbfce7efca4749\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/WipeLocalDataDialog.js\":\"740231ac228fea65\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionDispatch.js\":\"ddf2aa2d432700a8\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/actionRefItems.js\":\"9942fa1108382f53\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/applyKeybindingOverrides.js\":\"7384bd1567d6f7ac\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/blockActions.js\":\"24cfdf8bda02f266\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/canonicalizeChord.js\":\"bf9a442c63d8fafb\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultContexts.js\":\"ce6ca79e4e2ca410\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/defaultShortcuts.js\":\"2efec93e1e041e5a\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/effectiveActions.js\":\"5f2ac514c053de4a\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureAction.js\":\"5ad74aa84cbe505c\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/gestureBinding.js\":\"9f56182f024e99ca\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/holdRegistry.js\":\"d440e5991d6a9cf1\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingConflicts.js\":\"4fbd7fef88f4b816\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/keybindingOverrides.js\":\"3679eece053a80e3\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/pointerAction.js\":\"c81470015c2137a6\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/resolve.js\":\"5c28d9b82e727474\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/runAction.js\":\"9582022b440b5b8a\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/sequenceMatcher.js\":\"79a4922898ca6208\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/types.js\":\"07c0f05f440549c8\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionContext.js\":\"14e93d15e3d66646\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/useActionDiscovery.js\":\"17071471d1f298a4\",\"/knowledge-medium/pr-preview/pr-1835/src/shortcuts/utils.js\":\"21a41a48f0febc9a\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/bootStore.js\":\"8408e71abcf925b5\",\"/knowledge-medium/pr-preview/pr-1835/src/sw/previewDatabases.js\":\"06b919a5a63f3f3d\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/byteTransform.js\":\"4924df118323f61b\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/attachmentCleaner.js\":\"4fe2f9e55171cce4\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/attachmentParts.js\":\"52aeb064daa9bf33\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleParts.js\":\"630020be3cd0fc50\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/bundleRecord.js\":\"ecefb2b9408d67af\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/manifest.js\":\"b0bdce89cd708a1c\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/takeBundle.js\":\"719fbe3a5f8317c2\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/bundle/verifyBundle.js\":\"3b56428938eb6319\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/cleaningStage.js\":\"e2e790a48ee3a5c6\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionKey.js\":\"6673100e5d361730\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/conversionServer.js\":\"fb967ae6e6b8b986\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flip.js\":\"7ab6139b28525fd5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/flipAttempts.js\":\"6aa0fda65f90c565\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/pages.js\":\"36d2c4274e53f8b6\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/preflight.js\":\"dd75bab0398f08b4\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/reseal.js\":\"bcaa03462ab56696\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runConversion.js\":\"f0bc176eacb4f5d8\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/runLock.js\":\"e2af2c739f47aa46\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealing.js\":\"cd3494783cc09ff5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/sealingStage.js\":\"590927e8946244fd\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/stage.js\":\"c3d4b6f90f01bfd5\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/conversion/verifyReseal.js\":\"4d3f00aed37cc445\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aad.js\":\"59046d5f619e76cf\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/aead.js\":\"7373735a9551fb2b\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base32.js\":\"309f168649f1d20e\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/base64url.js\":\"ed56445805bd416c\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/binaryEnvelope.js\":\"e2e80f4dc00241a2\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/byteAead.js\":\"77b0459948a51b84\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/canary.js\":\"96cc52df80093e0b\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentHash.js\":\"1efc05c126e89729\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/contentKey.js\":\"b12f3594580090af\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/derivedIdNamespace.js\":\"146bcf10313236d0\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/envelope.js\":\"fb82ce3be2527d2c\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/hex.js\":\"cca14ea73967cde4\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/sha256Hex.js\":\"29132cd41c7fe316\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/crypto/workspaceKey.js\":\"1f4e58544bd65b73\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/conversionState.js\":\"661234229771d341\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/createEncryptedWorkspace.js\":\"678e1f291f096f33\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/pastedKey.js\":\"c27a75a3e6e60f75\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ec742d5de3a6871b\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d961b50ec646673f\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/keyStore.js\":\"361520f4fb902529\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/mintWorkspaceKey.js\":\"4934a48f5ac09e15\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/modePin.js\":\"ac03d82253c24836\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/openWorkspaceKeys.js\":\"31a501ce26edaf1d\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolveWorkspaceEntry.js\":\"f223449ce9a53834\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/resolver.js\":\"ee202f0b312d42d3\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/keys/workspaceAccess.js\":\"d565f8db8eef0b54\",\"/knowledge-medium/pr-preview/pr-1835/src/sync/transform.js\":\"853870ef5471d4ce\",\"/knowledge-medium/pr-preview/pr-1835/src/themeBootDefaults.js\":\"41d5c14c03ef531e\",\"/knowledge-medium/pr-preview/pr-1835/src/types.js\":\"34e57b7f8980d44a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/ClientLocalSettings.js\":\"77bc9754c172c2ff\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/abortableSleep.js\":\"456f585e2fcb0ceb\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/array.js\":\"9e06f5107ffbf6ed\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/backlinkAutocomplete.js\":\"6f34f713f488d758\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockCrumbs.js\":\"d2dff900dc70467d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/blockrefAutocomplete.js\":\"f454fd1e68a6add1\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/cadencedIdleJob.js\":\"6bff1f9a87273209\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/callbackSet.js\":\"409b9d47684b4fe7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/clientId.js\":\"950bd04a6dbaa73c\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirror.js\":\"58f5726116903c67\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/codemirrorCompletion.js\":\"beb52dce9d0c0a7d\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/copy.js\":\"144f9e4a15047eea\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dailyPage.js\":\"0f6c1f792bf0d58b\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensics.js\":\"58a57f5e0e317ded\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dbForensicsHooks.js\":\"ba19590ebba7e246\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/deleteBlockThroughUi.js\":\"b9d3c201390f70af\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dialogs.js\":\"aaa3d5ca5e826d65\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/dom.js\":\"fb4e7345d2674819\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/downloadBlob.js\":\"3715f81c58ad557f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/exportSqliteDb.js\":\"6cd975a86b34a23e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fileSystemAccess.js\":\"95db52156bd2b0ce\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/flipSlide.js\":\"27da15d970476a7e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fnv1a.js\":\"2843c20e2f0629e6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/formatBytes.js\":\"998ff1ad76438355\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/fuzzyRank.js\":\"f97ac2713e292ef2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idbKeyedStore.js\":\"3de88decb0f43812\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/idleCallbackPolyfill.js\":\"18db916aa2cec93e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardAwareScroll.js\":\"1959164f31437d4e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/keyboardViewport.js\":\"6944c2515e2bd1ee\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/lastWorkspace.js\":\"9a6df77dd4fdf584\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutColumns.js\":\"4138e88daafce78f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionDom.js\":\"509ad2b286d6bc66\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/layoutSessionId.js\":\"cad321199cbc658f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkClickGestures.js\":\"c4b06f794f1430f7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/linkTargetAutocomplete.js\":\"59529cf2016d1895\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbCorruption.js\":\"53670decc049962f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/localDbRecovery.js\":\"525f2d0cc92d9251\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/markdownParser.js\":\"61c41288d3c323b0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/memoize.js\":\"9503dce0bf2aabd8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameFieldCommit.js\":\"81ed94e8b43e9868\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/nameList.js\":\"08543ac692565b99\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/navigation.js\":\"7653e7ab1b7d7ada\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/omnilinerNamespace.js\":\"71d37db8cc66eab7\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/opfsPageScan.js\":\"ead75f2bb133bea3\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelClearance.js\":\"b4d5e04c71f8cae9\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelHistory.js\":\"69b81a6cfa7a940a\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLanes.js\":\"b8c57d218601f3b2\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelLayoutProjection.js\":\"9195854bc6958849\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelScrollAnchor.js\":\"47ad947347a13a4f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/panelUrlFlags.js\":\"b489ee4fefafbc28\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/platform.js\":\"d922dded707b0cea\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/pluralize.js\":\"03ab41a59ff697ea\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyCreation.js\":\"cd748ccc4badf9c6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyNavigation.js\":\"33ce1df9cf9a8c55\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/propertyValueContext.js\":\"8a9a77f9a12a0e8f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/react.js\":\"08698f05ae2d8a30\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeDate.js\":\"6198ab7a64559302\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/relativeTime.js\":\"be8a0b54f4c26d49\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/renderScope.js\":\"df1c0be755d684c8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/resolvedThenable.js\":\"1eb8d3830c9fde44\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/routing.js\":\"72acf21cbfa001c8\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/safeMode.js\":\"cfd71935799e3edc\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/scheduleIdle.js\":\"df8bd18d240d3f72\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/screenWakeLock.js\":\"79bb4fb97f39acf0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/selection.js\":\"4c2ee0c7ae9a455e\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/softKeyboardGrab.js\":\"ddacf7574e045633\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/startupTimeline.js\":\"e8f49ca87694a17f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/state.js\":\"02053b43a83760b0\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/string.js\":\"b085de675f7ba10f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/surfaceZoom.js\":\"1ea414cf869b71c5\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/time.js\":\"58ab9bfd995efeb6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toast.js\":\"9faf8de84d07ca77\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/toggleStore.js\":\"4d8b7732b8cbf153\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/untilStopped.js\":\"b6915e0c26146196\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/userActivity.js\":\"2d29361554c2a4ae\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewTransition.js\":\"da08fe32f7b05311\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/viewport.js\":\"b76315bd63c92f49\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/webLock.js\":\"5f9052aeafef323f\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceRecovery.js\":\"f157a75e60f83f10\",\"/knowledge-medium/pr-preview/pr-1835/src/utils/workspaceSnapshotStore.js\":\"1b2c677c0712b440\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-compiler-runtime.js\":\"c38dcef450a79b44\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-client.js\":\"034c5ac71311fe16\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server-edge.js\":\"2d3b8c12563f950b\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-server.js\":\"2c18619d25931bb7\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static-edge.js\":\"f3afac53efe64617\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-static.js\":\"1ee75e88f0efa82d\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom-test-utils.js\":\"112d85c39e2c60b6\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-dom.js\":\"0a669c2d614d848e\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react-jsx-runtime.js\":\"1e78966bc1f0cec4\",\"/knowledge-medium/pr-preview/pr-1835/src/vendor/react.js\":\"c416201d5fd71fce\",\"/knowledge-medium/pr-preview/pr-1835/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1835/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
