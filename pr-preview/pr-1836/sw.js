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
		buildId: "8f2059d391af-ab669d5d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1836/\":\"8fd14b9735813847\",\"/knowledge-medium/pr-preview/pr-1836/index.html\":\"8fd14b9735813847\",\"/knowledge-medium/pr-preview/pr-1836/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1836/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1836/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1836/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1836/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1836/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1836/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1836/assets/FacadeVFS-BJD0GA0x.js\":\"32b4948dad4dd78c\",\"/knowledge-medium/pr-preview/pr-1836/assets/OPFSCoopSyncVFS-Bd77hpFK.js\":\"3bfb22b7cce89e2b\",\"/knowledge-medium/pr-preview/pr-1836/assets/OPFSWriteAheadVFS-CfGWPVnp.js\":\"a9cb9319a2142cbe\",\"/knowledge-medium/pr-preview/pr-1836/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1836/assets/wa-sqlite-H5LR6fvb.js\":\"eb0264d86da1b262\",\"/knowledge-medium/pr-preview/pr-1836/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1836/assets/wa-sqlite-async-D2tJ9_id.js\":\"f08c0d4d00c503d0\",\"/knowledge-medium/pr-preview/pr-1836/assets/worker-BN3UaTYF.js\":\"af517868bb184389\",\"/knowledge-medium/pr-preview/pr-1836/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1836/chunks/app-D-5Oz8CN.js\":\"7bdfa62b75945814\",\"/knowledge-medium/pr-preview/pr-1836/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1836/index.js\":\"e6f0d259994cd23d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1836/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1836/assets/AccessHandlePoolVFS-BoEwdGkS.js\":\"21313fa8d71daa92\",\"/knowledge-medium/pr-preview/pr-1836/assets/IDBBatchAtomicVFS-Dsb1xElG.js\":\"39f91f7459ea970a\",\"/knowledge-medium/pr-preview/pr-1836/assets/MemoryVFS-D83bZLSM.js\":\"07c4a3ea10a065ce\",\"/knowledge-medium/pr-preview/pr-1836/assets/mc-wa-sqlite-BVX9D_0v.js\":\"f2ddb21e076530c5\",\"/knowledge-medium/pr-preview/pr-1836/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1836/assets/mc-wa-sqlite-async-DIBpyViY.js\":\"b63fa9ab91fa017b\",\"/knowledge-medium/pr-preview/pr-1836/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1836/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1836/chunks/AccessHandlePoolVFS-B0dVb8aY.js\":\"19725586bf2d9550\",\"/knowledge-medium/pr-preview/pr-1836/chunks/FacadeVFS-DOvAvPwi.js\":\"939f34505571ac39\",\"/knowledge-medium/pr-preview/pr-1836/chunks/IDBBatchAtomicVFS-jHD7ySn7.js\":\"d74200e9309a2331\",\"/knowledge-medium/pr-preview/pr-1836/chunks/MemoryVFS-Dt1Y3Zpa.js\":\"c6216784c1a8afa6\",\"/knowledge-medium/pr-preview/pr-1836/chunks/OPFSCoopSyncVFS-CDJFqE7o.js\":\"4bafecd3e1afe1d9\",\"/knowledge-medium/pr-preview/pr-1836/chunks/OPFSWriteAheadVFS-Cjj9ZSB6.js\":\"d20af72d463965d9\",\"/knowledge-medium/pr-preview/pr-1836/chunks/Preview-BOokYnFs.js\":\"ef7689d16980890e\",\"/knowledge-medium/pr-preview/pr-1836/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1836/chunks/card-CvhY-xsY.js\":\"04105620c5320077\",\"/knowledge-medium/pr-preview/pr-1836/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1836/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1836/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1836/chunks/dist-E9NB4JAI.js\":\"f26af5cf8110d056\",\"/knowledge-medium/pr-preview/pr-1836/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1836/chunks/mc-wa-sqlite-VjsbJaii.js\":\"6d973ae12c2cf554\",\"/knowledge-medium/pr-preview/pr-1836/chunks/mc-wa-sqlite-async-Bn5qRmwk.js\":\"f2f7b15a05b02353\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react--cCh0yxj.js\":\"4346fb903e8d02e3\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-BsJXhkOu.js\":\"1b56554c40f74900\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-Bxj5Rpt7.js\":\"45adb25facb7ebe3\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-CAr8R7oE.js\":\"648d1c5f62dde30a\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-D81cufJ-.js\":\"d53f329e870b4f93\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-DTbwjfnM.js\":\"7e58ae92bd8db879\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-Qpl6oeQG.js\":\"6f0acd95312b352f\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-TQU3uc1i.js\":\"7343803fd0876ea6\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-dom-server-legacy.browser.production-DPWJ-Nvr.js\":\"4b47718bb91385bb\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-dom-server.browser.production-BI-fjuWD.js\":\"1ce7a75d79ffb34e\",\"/knowledge-medium/pr-preview/pr-1836/chunks/react-dom-server.edge.production-C3VjXYzG.js\":\"f3a5ff8c969ed052\",\"/knowledge-medium/pr-preview/pr-1836/chunks/server.browser-CcPoT7Cx.js\":\"0b1f3dd9b81582d8\",\"/knowledge-medium/pr-preview/pr-1836/chunks/textarea-BV-z-YWR.js\":\"445c122e6147b3bd\",\"/knowledge-medium/pr-preview/pr-1836/chunks/ui-DLqwX8hX.js\":\"70e43d59398fa6fc\",\"/knowledge-medium/pr-preview/pr-1836/chunks/wa-sqlite-DOpGwQf9.js\":\"b3874924597b705e\",\"/knowledge-medium/pr-preview/pr-1836/chunks/wa-sqlite-async-GcPQhx0V.js\":\"c23a4d0fcd9d58be\",\"/knowledge-medium/pr-preview/pr-1836/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1836/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1836/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1836/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1836/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1836/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1836/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1836/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1836/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1836/src/App.js\":\"740375f6d02ca3ed\",\"/knowledge-medium/pr-preview/pr-1836/src/appUpdate.js\":\"d6f96cb8cdbe8b06\",\"/knowledge-medium/pr-preview/pr-1836/src/appVersion.js\":\"ea2bf4d0f77ecd37\",\"/knowledge-medium/pr-preview/pr-1836/src/bootstrap/initialLayout.js\":\"0ce960c2c3e29d87\",\"/knowledge-medium/pr-preview/pr-1836/src/bootstrap/openWorkspaceData.js\":\"64b82d79a7d291ff\",\"/knowledge-medium/pr-preview/pr-1836/src/bootstrap/resolveWorkspace.js\":\"6863ae8dd3f7376e\",\"/knowledge-medium/pr-preview/pr-1836/src/bootstrap/workspaceBootstrap.js\":\"ee384d68d99417bb\",\"/knowledge-medium/pr-preview/pr-1836/src/components/BlockComponent.js\":\"9c31e3eff7513b26\",\"/knowledge-medium/pr-preview/pr-1836/src/components/BlockCrumbs.js\":\"2af09744fa9bcebf\",\"/knowledge-medium/pr-preview/pr-1836/src/components/BlockEditor.js\":\"fa3edcb91475812a\",\"/knowledge-medium/pr-preview/pr-1836/src/components/BlockLoadingPlaceholder.js\":\"562b6edaa0d14316\",\"/knowledge-medium/pr-preview/pr-1836/src/components/BlockProperties.js\":\"69c516da9c0ac1fc\",\"/knowledge-medium/pr-preview/pr-1836/src/components/BlockSearchPicker.js\":\"4443c58594e2d237\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ConfirmBulkDeleteDialog.js\":\"1da781763c10e05a\",\"/knowledge-medium/pr-preview/pr-1836/src/components/DividerHandle.js\":\"11fe9410eea12b1d\",\"/knowledge-medium/pr-preview/pr-1836/src/components/DraftEditor.js\":\"4ee1623761fd9f0d\",\"/knowledge-medium/pr-preview/pr-1836/src/components/GutterPill.js\":\"23da256825bdc205\",\"/knowledge-medium/pr-preview/pr-1836/src/components/Header.js\":\"a133ea5c90cee1b2\",\"/knowledge-medium/pr-preview/pr-1836/src/components/LazyBlockComponent.js\":\"09e1d231ebaae773\",\"/knowledge-medium/pr-preview/pr-1836/src/components/Login.js\":\"88d285dadeb21616\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ZoomableSurface.js\":\"e78e2c31185875d0\",\"/knowledge-medium/pr-preview/pr-1836/src/components/editModeKeepalive.js\":\"d825118808b17b83\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyDisplay/PropertyDisplayScope.js\":\"873e28b96c5ce9a0\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"089bf89a25ea2d84\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyEditors/RefPropertyEditor.js\":\"f3eae0e83d7b8bc9\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyEditors/RefTargetTypePicker.js\":\"58fd2d1e2954f62c\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyEditors/SelectPropertyEditor.js\":\"6c628409d2e21c3f\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyEditors/TypesPropertyEditor.js\":\"2551a436438c9be2\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyEditors/defaults.js\":\"340e22634f3d1ab2\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyEditors/kernelValuePresets.js\":\"f7ed079b688df704\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyEditors/selectablePresets.js\":\"8dba009188f12193\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyEditors/typesPropertyUi.js\":\"8850a6e9da2c52be\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/AddPropertyForm.js\":\"30816c54ab5ce141\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/PropertyPicker.js\":\"d6f7da720b96777b\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/PropertyRow.js\":\"893bf7f63e519188\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/Rows.js\":\"b205824e7e725376\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/actions.js\":\"96c0aad080103535\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/declarationOnly.js\":\"21e47e1c513fa515\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/layout.js\":\"009c8b1e52ec9bb1\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/model.js\":\"0181f4b77420c70a\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/shapeUi.js\":\"ea3d46eee0a0f742\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/shapes.js\":\"3f9200c0b2d356fb\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/usePropertyEditingActivation.js\":\"27cf80316db32f9a\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanel/visibility.js\":\"5e767ff9f4dd8d9a\",\"/knowledge-medium/pr-preview/pr-1836/src/components/propertyPanelSections.js\":\"079755f5833a77b5\",\"/knowledge-medium/pr-preview/pr-1836/src/components/references/BlockEmbed.js\":\"a7221510bac5219c\",\"/knowledge-medium/pr-preview/pr-1836/src/components/references/BlockLink.js\":\"859f84eecfdb2833\",\"/knowledge-medium/pr-preview/pr-1836/src/components/references/BlockRef.js\":\"f0a463817f44de4a\",\"/knowledge-medium/pr-preview/pr-1836/src/components/references/ReferenceLink.js\":\"428d8f38e6489397\",\"/knowledge-medium/pr-preview/pr-1836/src/components/references/cycleGuard.js\":\"6c18ddc7169576a0\",\"/knowledge-medium/pr-preview/pr-1836/src/components/references/cycleGuardContext.js\":\"31b00e6ee70db460\",\"/knowledge-medium/pr-preview/pr-1836/src/components/references/linkInteraction.js\":\"3b005198157d1152\",\"/knowledge-medium/pr-preview/pr-1836/src/components/references/referenceLayout.js\":\"ebb9ef7bfbc96bd0\",\"/knowledge-medium/pr-preview/pr-1836/src/components/references/useBlockRefAncestors.js\":\"fa27eb81e89d3978\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/BlockGutter.js\":\"c182e1853e2d7e28\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/BlockInfoDialog.js\":\"376b417398f173b3\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/BlockTypeBlockRenderer.js\":\"0d92b4deff5ada56\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/BulletHoverCard.js\":\"20fa761dbb8d542b\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/CodeMirrorContentRenderer.js\":\"cae458cd69c2ccf6\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4323fb0e9ef73928\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/ColumnResizeHandles.js\":\"070adb897d90fc5f\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1958b47062152f03\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/DefaultBlockRenderer.js\":\"ee8790206e6d4a93\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/LayoutRenderer.js\":\"fa8f9fe0e17452f4\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/MarkdownContentRenderer.js\":\"65c48ab6fe5453cd\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/MissingDataRenderer.js\":\"36b1ef355e8e1745\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/PanelRenderer.js\":\"11c1977bc2c04111\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a340f3375973ecfe\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/TopLevelRenderer.js\":\"dd4c7ba24b8e7929\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/blockGutterMode.js\":\"c2e53df4b875cbe2\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/blockTitleText.js\":\"65e32c08d165b0fb\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/fieldCreationKeydown.js\":\"274d0cc9f40eb2bd\",\"/knowledge-medium/pr-preview/pr-1836/src/components/renderer/layoutRootContext.js\":\"14142754f132d31f\",\"/knowledge-medium/pr-preview/pr-1836/src/components/typeChip/TypeChip.js\":\"f4b56a00b5fb7c46\",\"/knowledge-medium/pr-preview/pr-1836/src/components/typeChip/chipStyle.js\":\"33108207416b1144\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/anchored-floating.js\":\"65e1e9e26035d221\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/button.js\":\"b1d7cc64667ab998\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/card.js\":\"59e827a17fe02076\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/checkbox.js\":\"7ad526d83ccc00ba\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/collapsible.js\":\"a03570766f314a57\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/command.js\":\"9bf3082e7bdd5630\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/context-menu.js\":\"4ccf9e07fa329d21\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/dialog.js\":\"0dbbd62988d4cf04\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/dropdown-menu.js\":\"9e210c94cb569200\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/floating-listbox.js\":\"55c20449c7e29438\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/index.js\":\"dfe6c9299327f8e8\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/input.js\":\"b94d8d5584d3e2cc\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/kbd.js\":\"a1c3de02cd40e3c7\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/label.js\":\"4f34db8af2e87faa\",\"/knowledge-medium/pr-preview/pr-1836/src/components/ui/textarea.js\":\"863f175ba822f1e1\",\"/knowledge-medium/pr-preview/pr-1836/src/components/useEditModeYieldKeepalive.js\":\"5ad798597e2696a0\",\"/knowledge-medium/pr-preview/pr-1836/src/components/util/BootFallback.js\":\"3827c5a8aacb7827\",\"/knowledge-medium/pr-preview/pr-1836/src/components/util/FocusedRowLazyMount.js\":\"75ef5755238a07ba\",\"/knowledge-medium/pr-preview/pr-1836/src/components/util/LazyViewportMount.js\":\"9fcec0ad166aa986\",\"/knowledge-medium/pr-preview/pr-1836/src/components/util/LocalDbCorruptionFallback.js\":\"31add4e05e5291e0\",\"/knowledge-medium/pr-preview/pr-1836/src/components/util/error.js\":\"ad8a5ef5bf8d50a4\",\"/knowledge-medium/pr-preview/pr-1836/src/components/util/lazyMountRegistry.js\":\"6ce63928484782db\",\"/knowledge-medium/pr-preview/pr-1836/src/components/util/suspense.js\":\"1e7744ca71d2f6aa\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/CreateWorkspaceDialog.js\":\"ab66d3ab68fe386f\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/PendingInvitations.js\":\"049fde3a7f27a3d8\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/SyncProgress.js\":\"09961e0f5ced3adb\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/UnlockProgress.js\":\"89c87f457a9f6a20\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/WorkspaceKeyGate.js\":\"3060f418bc861026\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/WorkspaceSettingsDialog.js\":\"2feffdafaa2ffb29\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/WorkspaceSwitcher.js\":\"81164d351c6c520a\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/WorkspaceSyncGate.js\":\"d6387ae3bbb6d663\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/conversion/ConversionFlow.js\":\"53a137f859f10c38\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/conversion/ConversionFlowHost.js\":\"2f08dda8f9b52dd3\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/conversion/EncryptionSection.js\":\"0fc9fecf4abe1ff6\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/conversion/attachmentPrompts.js\":\"8e1f7b6ac29035e1\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/conversion/bundleFolderPrompts.js\":\"5b3e065a93229001\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/conversion/conversionFlowDeps.js\":\"f4aa06846637f7b4\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/conversion/conversionFlowStore.js\":\"6b1d12444f4d67d5\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/conversion/flowUi.js\":\"7a8c64c778b7083b\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/conversion/useConversionRun.js\":\"1ca1fdb103af6ae0\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/keyUi.js\":\"6502833646ab0ad0\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/useCloseOnKeyLoss.js\":\"92333b960f422f3d\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/useCloseOnServerE2ee.js\":\"63dfb87a0ca6bdc5\",\"/knowledge-medium/pr-preview/pr-1836/src/components/workspace/workspaceUnlocked.js\":\"3494811098d9c935\",\"/knowledge-medium/pr-preview/pr-1836/src/context/backgroundSubtree.js\":\"fd8baaed764419b2\",\"/knowledge-medium/pr-preview/pr-1836/src/context/block.js\":\"19404e945a3a6bd9\",\"/knowledge-medium/pr-preview/pr-1836/src/context/layoutWsContext.js\":\"64a3b61edb638ff1\",\"/knowledge-medium/pr-preview/pr-1836/src/context/propertyDisplay.js\":\"536420a8a4af2781\",\"/knowledge-medium/pr-preview/pr-1836/src/context/repo.js\":\"e23dea7778a73c7b\",\"/knowledge-medium/pr-preview/pr-1836/src/data/aliasClaim.js\":\"3b42293dde262bf3\",\"/knowledge-medium/pr-preview/pr-1836/src/data/aliasSeatNamespace.js\":\"6805c8043bf06475\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/blockData.js\":\"ae5f9285a5050771\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/blockType.js\":\"053205aaa3ea8748\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/changeScope.js\":\"246597bdc933ca14\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/codecs.js\":\"f86b38a20a9e3b08\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/derivedData.js\":\"03ceac66de09d21c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/errors.js\":\"95c873dfaa0aeb79\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/events.js\":\"2b593942f1d44802\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/handle.js\":\"a11449d4ee598d7d\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/index.js\":\"3d43270ccba4280f\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/mutator.js\":\"81066be3b2ac03ea\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/processor.js\":\"afb9f426a6c7884e\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/propertySchema.js\":\"667315c089639d66\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/query.js\":\"546ea433b527c0e2\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/sameTxProcessor.js\":\"1d995b6b336174ea\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/schema.js\":\"a11449d4ee598d7d\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/tx.js\":\"a11449d4ee598d7d\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/typedBlockQuery.js\":\"cc332b11eb838d9c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/user.js\":\"9703ce8cd938ba90\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/valuePresetCore.js\":\"6fceeb883465e23c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/api/valuePresets.js\":\"2266362f01d6d1ca\",\"/knowledge-medium/pr-preview/pr-1836/src/data/attachmentCleanerIOVerb.js\":\"6112a94c83bd4ffa\",\"/knowledge-medium/pr-preview/pr-1836/src/data/block.js\":\"4003510cec406262\",\"/knowledge-medium/pr-preview/pr-1836/src/data/blockCache.js\":\"1045758b98db62e4\",\"/knowledge-medium/pr-preview/pr-1836/src/data/blockId.js\":\"ee0059ec0cd2a717\",\"/knowledge-medium/pr-preview/pr-1836/src/data/blockLiveness.js\":\"7812cdd142331b5e\",\"/knowledge-medium/pr-preview/pr-1836/src/data/blockMerge.js\":\"98f0ce11f6c4593a\",\"/knowledge-medium/pr-preview/pr-1836/src/data/blockSchema.js\":\"4e3a2286b94cf9aa\",\"/knowledge-medium/pr-preview/pr-1836/src/data/blockTypeLookup.js\":\"094be84db35fdf13\",\"/knowledge-medium/pr-preview/pr-1836/src/data/blockTypes.js\":\"7f8c9e491a652641\",\"/knowledge-medium/pr-preview/pr-1836/src/data/clientContext.js\":\"e05f8980671fd29f\",\"/knowledge-medium/pr-preview/pr-1836/src/data/dbFileSiblings.js\":\"0bdf5dd430d87643\",\"/knowledge-medium/pr-preview/pr-1836/src/data/definitionSeeds.js\":\"56f6503ebb452a01\",\"/knowledge-medium/pr-preview/pr-1836/src/data/derivedIds.js\":\"ce1356452dbfd821\",\"/knowledge-medium/pr-preview/pr-1836/src/data/drawnSubtree.js\":\"d63bc92ecaf7873f\",\"/knowledge-medium/pr-preview/pr-1836/src/data/facetBridge.js\":\"58d90c0fdc209aac\",\"/knowledge-medium/pr-preview/pr-1836/src/data/facets.js\":\"d4880e1ce362302b\",\"/knowledge-medium/pr-preview/pr-1836/src/data/globalState.js\":\"d20ca389e895129c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/aliasClaimRederiveProcessor.js\":\"40b773210acfdcef\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/ancestorBatch.js\":\"1270442e7c827c58\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/blockTypeTypeifyProcessor.js\":\"3ef34999e26116c3\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/clientSchema.js\":\"cd189f95ba28c53a\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/commitPipeline.js\":\"1f12144cc351d850\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/devAssertions.js\":\"31970a3e74c7a57a\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/firstSync.js\":\"f8a1dee8c6b15f54\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/freshInitialLoad.js\":\"b143ae5ed6be045f\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/graphBackfillClaim.js\":\"b8d6979c7081c26a\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/handleStore.js\":\"7d19b5302447880c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/idleMarkerJobs.js\":\"324a6db062087b4a\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/initialDownload.js\":\"d789f1809b2bd3ac\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/initializeClientDatabase.js\":\"a9cb9434a701fde8\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/jsonCanonical.js\":\"d822e7055df60709\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/kernelInvalidation.js\":\"7bc72532a45bfea6\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/kernelProcessors.js\":\"85bfbcba58487cbf\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/kernelQueries.js\":\"158602af41576df7\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/mergeTypeMembershipProcessor.js\":\"2bcef2af4848d908\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/normalizeReferencesProcessor.js\":\"37e448c639fbaf36\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/poolInstrumentation.js\":\"6ba16dbce2f51721\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/processorRunner.js\":\"71a1d80f7dca09ce\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/propertyCellBackfill.js\":\"ce5d09c5a10c298e\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/propertyChildMint.js\":\"7ae4cd9352e6255c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/propertyChildrenProcessor.js\":\"849b7649eeb40072\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bbbc43f904fc4cde\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/propertyDefinitionSynthesis.js\":\"2a516664e32cda13\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/propertyKeyScan.js\":\"ef8b1b5c782bfa21\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/propertySchemaResolution.js\":\"5c6946211ade7ebf\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/propertyValueEdits.js\":\"488accc497484922\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/raiseProtocol.js\":\"cc87b8cbf4ae5e85\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/readBatch.js\":\"1cd28fa2af78e95b\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/refProjection.js\":\"d0a4822171433057\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/referenceTargetLookups.js\":\"c871e177f611fc81\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/referenceTargetProcessor.js\":\"fed8cfc8369ba2ad\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/replayMerge.js\":\"fdf98631edbd1a5e\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/sqlBinds.js\":\"7d818e2d3ea5b0a2\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"95db59779d0e19c0\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/syncObserver/arrivalProcessors.js\":\"c327104c5ae61b52\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/syncObserver/invalidate.js\":\"eb6c92d3348334f2\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/syncObserver/materialize.js\":\"4ea015ad771013f2\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/syncObserver/observer.js\":\"d5a70c5a6b29af1e\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/syncObserver/reconcile.js\":\"8a793e0345e84b1a\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/timingMetrics.js\":\"12159ac909d5c9bf\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/treeQueries.js\":\"8ffff4fb5f2104f9\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/txEngine.js\":\"30dff9cd2eb48a04\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/txSnapshots.js\":\"d66b02e00a56e10b\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/typedBlockQuery.js\":\"0a28518c39f10c1e\",\"/knowledge-medium/pr-preview/pr-1836/src/data/internals/undoManager.js\":\"d22c75b607eed13e\",\"/knowledge-medium/pr-preview/pr-1836/src/data/invalidation.js\":\"653028e564bb9d70\",\"/knowledge-medium/pr-preview/pr-1836/src/data/kernelDataExtension.js\":\"9a1ebe18992104ad\",\"/knowledge-medium/pr-preview/pr-1836/src/data/kernelPage.js\":\"6bc98f3625a7ae42\",\"/knowledge-medium/pr-preview/pr-1836/src/data/kernelValuePresetCores.js\":\"0ba1b2e9fbb86e20\",\"/knowledge-medium/pr-preview/pr-1836/src/data/localDbCorruptionSignal.js\":\"542c65b24cc6eb26\",\"/knowledge-medium/pr-preview/pr-1836/src/data/localDbStorage.js\":\"a21bd85a8188a85f\",\"/knowledge-medium/pr-preview/pr-1836/src/data/localDbVfs.js\":\"9de251cf56f80d6f\",\"/knowledge-medium/pr-preview/pr-1836/src/data/localSchema.js\":\"ab976a24ff648fae\",\"/knowledge-medium/pr-preview/pr-1836/src/data/maintenance.js\":\"42f5716b860eae2c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/mergeProperties.js\":\"a31983df29b56fa8\",\"/knowledge-medium/pr-preview/pr-1836/src/data/metricsConsoleHook.js\":\"5d2a8b971aa6ef26\",\"/knowledge-medium/pr-preview/pr-1836/src/data/migrationsPage.js\":\"f801703974574f6b\",\"/knowledge-medium/pr-preview/pr-1836/src/data/mutators.js\":\"90a12ba36a104e09\",\"/knowledge-medium/pr-preview/pr-1836/src/data/orderKey.js\":\"b7d769532b726268\",\"/knowledge-medium/pr-preview/pr-1836/src/data/orderKeyPlacement.js\":\"dfcde345704b0a39\",\"/knowledge-medium/pr-preview/pr-1836/src/data/outlineSurface.js\":\"b9aade630a993600\",\"/knowledge-medium/pr-preview/pr-1836/src/data/pendingEditorContent.js\":\"c9d770daad766264\",\"/knowledge-medium/pr-preview/pr-1836/src/data/pendingUploadsSql.js\":\"fcf07a2556864742\",\"/knowledge-medium/pr-preview/pr-1836/src/data/pluginStateExtensions.js\":\"9b7fcd9d00f30387\",\"/knowledge-medium/pr-preview/pr-1836/src/data/powerSyncLogger.js\":\"b238dea3d15ff0dd\",\"/knowledge-medium/pr-preview/pr-1836/src/data/projectorRuntime.js\":\"919cd2146f1bb58d\",\"/knowledge-medium/pr-preview/pr-1836/src/data/properties.js\":\"7f527f3617140509\",\"/knowledge-medium/pr-preview/pr-1836/src/data/propertiesPage.js\":\"71043ea48416f15c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/propertyChildren.js\":\"ce930f8c48032ee1\",\"/knowledge-medium/pr-preview/pr-1836/src/data/propertyDefinitionFanout.js\":\"6a0f468c773ed1ce\",\"/knowledge-medium/pr-preview/pr-1836/src/data/propertyDefinitionMetadata.js\":\"d2a701c6ab88fe6c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/propertyDefinitionRegistry.js\":\"099d3852b5bda6b9\",\"/knowledge-medium/pr-preview/pr-1836/src/data/propertyDisplayMode.js\":\"4ee7c38f20aceede\",\"/knowledge-medium/pr-preview/pr-1836/src/data/propertyRowCreation.js\":\"4535113501b639fe\",\"/knowledge-medium/pr-preview/pr-1836/src/data/propertySchemaCreation.js\":\"84825a5ee857fcf8\",\"/knowledge-medium/pr-preview/pr-1836/src/data/propertySeeds.js\":\"e32703a75df4ae98\",\"/knowledge-medium/pr-preview/pr-1836/src/data/recentsPage.js\":\"48e6c296b218a805\",\"/knowledge-medium/pr-preview/pr-1836/src/data/referenceBlock.js\":\"3ae4726750b944e5\",\"/knowledge-medium/pr-preview/pr-1836/src/data/rejectedUploads.js\":\"de1ff3dff3ba940c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/releasePowerSyncConnection.js\":\"daeff4fed283c513\",\"/knowledge-medium/pr-preview/pr-1836/src/data/repo.js\":\"f7f0b948fe025234\",\"/knowledge-medium/pr-preview/pr-1836/src/data/repoProvider.js\":\"5ede4f91bb614174\",\"/knowledge-medium/pr-preview/pr-1836/src/data/rowProperty.js\":\"b1404b7d5db30372\",\"/knowledge-medium/pr-preview/pr-1836/src/data/searchFilter.js\":\"cd7c022bfd146e60\",\"/knowledge-medium/pr-preview/pr-1836/src/data/seedIdentityLedger.js\":\"a851cc8229019e1d\",\"/knowledge-medium/pr-preview/pr-1836/src/data/stateBlocks.js\":\"21570598161458cf\",\"/knowledge-medium/pr-preview/pr-1836/src/data/structuralEditPolicy.js\":\"76d46abbbc44f025\",\"/knowledge-medium/pr-preview/pr-1836/src/data/subtreeDelete.js\":\"9a313fc5e4177ad2\",\"/knowledge-medium/pr-preview/pr-1836/src/data/syncStreamLock.js\":\"412329355d92b18d\",\"/knowledge-medium/pr-preview/pr-1836/src/data/syncedTableSqlRecognizer.js\":\"49ae91b84957b24c\",\"/knowledge-medium/pr-preview/pr-1836/src/data/syncedTableWriteGuard.js\":\"eb1084cf843a6f23\",\"/knowledge-medium/pr-preview/pr-1836/src/data/targets.js\":\"684c7df7dc7f65b4\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typeColors.js\":\"0af3ac68c05d919b\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typeDefinitionMetadata.js\":\"cf68396534c36957\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typeDefinitionRegistry.js\":\"c577d72892104121\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typeExtraction.js\":\"3b12e3673d1d7948\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typeInitialValues.js\":\"1160e34af6d49734\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typePropertyGroups.js\":\"1aa4ef0c253a2233\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typeSeeds.js\":\"c9c554df3755f582\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typeTagger.js\":\"ed199701f6a3a823\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typedRecords.js\":\"68a2f8d2f89d1170\",\"/knowledge-medium/pr-preview/pr-1836/src/data/typesPage.js\":\"3b746ccbe93a16b9\",\"/knowledge-medium/pr-preview/pr-1836/src/data/userPrefs.js\":\"2c39f5e9bc8024c9\",\"/knowledge-medium/pr-preview/pr-1836/src/data/userSchemasService.js\":\"cef25c1f2826d4c6\",\"/knowledge-medium/pr-preview/pr-1836/src/data/userTypesService.js\":\"dc58b1de7ec87830\",\"/knowledge-medium/pr-preview/pr-1836/src/data/valuePresetRegistry.js\":\"bdcc3b58a9ac117f\",\"/knowledge-medium/pr-preview/pr-1836/src/data/visibleChildren.js\":\"b9ceb38140fa2c81\",\"/knowledge-medium/pr-preview/pr-1836/src/data/workspaceConversion.js\":\"893a684aab654541\",\"/knowledge-medium/pr-preview/pr-1836/src/data/workspaceFirstSync.js\":\"32a7f79f525614b0\",\"/knowledge-medium/pr-preview/pr-1836/src/data/workspaceIdNamespace.js\":\"f6b0d33372bcbdad\",\"/knowledge-medium/pr-preview/pr-1836/src/data/workspaceSchema.js\":\"a755386baad49084\",\"/knowledge-medium/pr-preview/pr-1836/src/data/workspaces.js\":\"13e58bc58d3ded50\",\"/knowledge-medium/pr-preview/pr-1836/src/data/writeAheadLog.js\":\"314aa57930f6a142\",\"/knowledge-medium/pr-preview/pr-1836/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/BlockPasteShellDecorator.js\":\"03a4c1dd1b1e41be\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/atTrigger.js\":\"13b89c0a9de7d84e\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/autocomplete.js\":\"173b14660c2c7e34\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/codeMirrorExtensions.js\":\"5e3430f170db219b\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/contentFlush.js\":\"949495b97b6d11b3\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/defaultInteractions.js\":\"aac021b6aa123c92\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/editSettleSignal.js\":\"fdaa5392115ef7e9\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/insertImage.js\":\"ddcc27fab1f3e88b\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/referenceCompletionRange.js\":\"28581d8a4be150ab\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/referenceTargetTypes.js\":\"4c1c2c32736a4402\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/syntaxContext.js\":\"9f4a64cec96e7acc\",\"/knowledge-medium/pr-preview/pr-1836/src/editor/triggerMatch.js\":\"5eeb4411c9fe620a\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/AppRuntimeProvider.js\":\"72c13841703b6e8d\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/BlockFocusShellDecorator.js\":\"475c67a6e1834e70\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/ExtensionRenderBoundary.js\":\"7de3e62ed486ab90\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/PanelContentRecovery.js\":\"3dac506408685f00\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/apiCatalog.js\":\"7e132f25fdbb9502\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/approveExtensionHere.js\":\"ed2be7e46fa64fd2\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/armedCutAppMount.js\":\"c0db8d5878c22dc9\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/batchableKeyedStore.js\":\"983e3fd84a8bdece\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/blockInteraction.js\":\"1b6f0a7f7ada7c3a\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/blockSelectionAction.js\":\"94d91ab2c1ed3606\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/compileExtensionModule.js\":\"02e2473f67ef5c9c\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/compiledModuleCache.js\":\"07602dccfa111e29\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/continuousGestures.js\":\"011d2f0f6d4af88c\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/core.js\":\"4573401800e30b82\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/defaultRenderers.js\":\"6577823483c5f5d8\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/definitionFanoutAppMount.js\":\"7932d38ce3ba95ea\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/dialogAppMount.js\":\"1cea8a7ed98f7294\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/dynamicExtensionSeeds.js\":\"39c4f1d90b1fbb1e\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/dynamicExtensions.js\":\"f30790a8722836d1\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/exampleExtensions.js\":\"c71368e7fd9c9e44\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/extensionApprovalStatus.js\":\"7b0c3285f3f002e2\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/extensionLoadErrorToast.js\":\"e0adcd7b25d63d6f\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/extensionLoadErrors.js\":\"ed281985418e652b\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/extensionLookup.js\":\"2a21821f498d423c\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/extensionToggles.js\":\"a4e0c1f0838ea292\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/extensionUtilitiesCss.js\":\"79ef7e7e21bf12b1\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/kernelPageDeletionGuard.js\":\"0e038da27cf62910\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/liveRuntime.js\":\"47e26143c2b15b25\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/openExtensionsSettings.js\":\"a626007e1a494187\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/overridesCache.js\":\"4c640660f023f1db\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/pluginIds.js\":\"2ae43632c6aa5144\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/processorRejectionToast.js\":\"31338616d6f08e6e\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/runtimeActions.js\":\"7fa34fad5847c39b\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/runtimeContext.js\":\"946faad4d19cb5ba\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/staticAppExtensions.js\":\"2e715bb586be4785\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/staticDataExtensions.js\":\"765b040f08c09141\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/toastAppMount.js\":\"57d55e0abcc0ead7\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/useOverrides.js\":\"02f893d1a541b075\",\"/knowledge-medium/pr-preview/pr-1836/src/extensions/useShortcutSurfaceActivations.js\":\"ef83c9f7b977ab92\",\"/knowledge-medium/pr-preview/pr-1836/src/facets/discoverToggleTree.js\":\"82f900123141cd90\",\"/knowledge-medium/pr-preview/pr-1836/src/facets/facet.js\":\"bac0c8b6a4c8faac\",\"/knowledge-medium/pr-preview/pr-1836/src/facets/resolveAppRuntime.js\":\"a303affa50f62dc3\",\"/knowledge-medium/pr-preview/pr-1836/src/facets/runtimeEvents.js\":\"ef383527d7d1175d\",\"/knowledge-medium/pr-preview/pr-1836/src/facets/togglable.js\":\"538e2c900343af1c\",\"/knowledge-medium/pr-preview/pr-1836/src/facets/variantFacet.js\":\"bdc1a17a35feee9c\",\"/knowledge-medium/pr-preview/pr-1836/src/facets/verbFacet.js\":\"e8186c8a5af7a805\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/block.js\":\"da716cffcf8692b4\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/focusedChild.js\":\"459c8976e725679d\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/propertySchemas.js\":\"b5e2c079145017a4\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/typeRegistry.js\":\"6d1247139b70d452\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useAncestorCrumbs.js\":\"500f6fb7f923ab58\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useAutocompleteListbox.js\":\"d1545de41dc50b6d\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useDebouncedSearch.js\":\"2aadce9038511746\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useDebouncedValue.js\":\"00a350dae1fff584\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useIsFocalRender.js\":\"ec7b7390081284fe\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useIsReadOnly.js\":\"6b50b50c0ab8a1d6\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useMaterializeBacklog.js\":\"066b576e934c3d01\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useMinuteClock.js\":\"b6f792312e98b925\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/usePanelLayoutProjection.js\":\"62ac1f7296fadbc2\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/usePendingInvitations.js\":\"246c152f9f9a6873\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useRendererRegistry.js\":\"8e6bf2c4600b06a5\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useRetainedFieldRows.js\":\"92991ceff37d8220\",\"/knowledge-medium/pr-preview/pr-1836/src/hooks/useWorkspaces.js\":\"c5335f9a14b78ed2\",\"/knowledge-medium/pr-preview/pr-1836/src/lib/utils.js\":\"ae9ca1de295f0dfd\",\"/knowledge-medium/pr-preview/pr-1836/src/main.js\":\"ab1dcc177079c574\",\"/knowledge-medium/pr-preview/pr-1836/src/markdown/MarkdownImage.js\":\"2d38d9d522c1afae\",\"/knowledge-medium/pr-preview/pr-1836/src/markdown/blockSeparators.js\":\"7566c396e0fda6b2\",\"/knowledge-medium/pr-preview/pr-1836/src/markdown/context.js\":\"d4397b0aae371ac7\",\"/knowledge-medium/pr-preview/pr-1836/src/markdown/defaultMarkdownExtension.js\":\"56b5f36243b6bdf8\",\"/knowledge-medium/pr-preview/pr-1836/src/markdown/extensions.js\":\"53ce2f8dcc91c9ff\",\"/knowledge-medium/pr-preview/pr-1836/src/markdown/renderMarkdownHtml.js\":\"2ce868e847c51afb\",\"/knowledge-medium/pr-preview/pr-1836/src/minimal-editor.js\":\"93cfc2f7230cc7f6\",\"/knowledge-medium/pr-preview/pr-1836/src/paste/armedCut.js\":\"9bfd4856c7e76602\",\"/knowledge-medium/pr-preview/pr-1836/src/paste/captureMediaVerb.js\":\"6b9ae8a009a9bea0\",\"/knowledge-medium/pr-preview/pr-1836/src/paste/clipboard.js\":\"90627b8bcb210820\",\"/knowledge-medium/pr-preview/pr-1836/src/paste/decision.js\":\"03cc00dc4ac3ce43\",\"/knowledge-medium/pr-preview/pr-1836/src/paste/operations.js\":\"8f86acbefda2816c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/account-header/AccountHeaderItem.js\":\"7226de89f5754472\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/account-header/index.js\":\"ebd3f24fe05e46f7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9fe29800a0c08d24\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-dispatch-companion/askAgent.js\":\"8f801c8b8198162c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-dispatch-companion/askedStore.js\":\"4fb76a506d5ac445\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3777843012f5fe64\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-dispatch-companion/chipState.js\":\"32e8aa9cc86c5d0a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4549f3199d7ad726\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-dispatch-companion/index.js\":\"e4f7a56722ee8941\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4e354be6d143e72d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-dispatch-companion/schema.js\":\"470dd7b716ee2ffb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c860ee4559a9bc56\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4de7fe104f3c5b84\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/addMedia.js\":\"78d86d119cb8a6b4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/backlinks.js\":\"834d56811d1f386b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/block.js\":\"fa8a81ffabb5d651\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/context.js\":\"8f4c70b7093257df\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7d9474d527ccf0ed\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/index.js\":\"c7c82fc7919590a7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/outline.js\":\"af8d2a169450f207\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/properties.js\":\"58d19a4ac5b7fbf5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/refs.js\":\"02636e9b51d06c53\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"80c60f1a19746dcb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/search.js\":\"344760f0c8e7f79d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/shared.js\":\"8618d1b745cf5b39\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"720bd3ce16c8c369\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentViews/text.js\":\"dac9d626351de252\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/agentWrites.js\":\"63906f191c8d3485\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/authoringCatalog.js\":\"ed586865ce10a244\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/blockRefTargets.js\":\"31fd8dc61a588195\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/bridge.js\":\"d5dcda817d7b7e66\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/bridgeLoop.js\":\"373dd02ac1317323\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/changeHistory.js\":\"4d463289bd7b6206\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/commands.js\":\"14638891625951a6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/commentsCommands.js\":\"aaef640a36303c8c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/dataExtension.js\":\"4d0a09218b6ab343\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/dataModelGuide.js\":\"1a68f7fdce157809\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/describeRuntime.js\":\"aa151980b2437ab3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/extensionLint.js\":\"4a9ec9e37d722246\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/grainAudit.js\":\"d49488402efc3a17\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/healthCommand.js\":\"dad61d2adb99acb7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/index.js\":\"60ff4ff576fa4363\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/presetIdentity.js\":\"b4b7ff694bfd1bd3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b39fb93eadf025f2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/readMedia.js\":\"c5144731041c1b41\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/schema.js\":\"8a4944d9bbb26245\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/serialization.js\":\"b45f0cd2bcdf12ee\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/targets.js\":\"79032d6da6083934\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/tokens.js\":\"602db66f4b147f5f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/watchEvents.js\":\"33196c0ca72636ba\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/workspaceGuard.js\":\"4fda2bc53881faaf\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/agent-runtime/writeCommands.js\":\"35b77eb8fa608a5e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/alias/AliasCollisionToast.js\":\"5d343c3ec9275742\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/alias/DuplicateNameBanner.js\":\"c8dc937e0d928cd7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/alias/collisionMerge.js\":\"602be0ea1dbf539e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/alias/dataExtension.js\":\"331403ba4d9ba5de\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/alias/index.js\":\"08cc4c22021e1001\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/alias/mergeCollisionAction.js\":\"9fff1bb076a235de\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/alias/pageStyling.js\":\"064174737532cc9c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/alias/rejectionToast.js\":\"da20ce1f748ffa15\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/alias/syncProcessor.js\":\"e17439c48fb90e40\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/actions.js\":\"6173bbe6fcccfa38\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/addComment.js\":\"4271d2f8369190cc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/anchor.js\":\"69c44fb0020e3a47\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/anchorState.js\":\"1654eec791d00a2e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/commentLinks.js\":\"52799a951576ebec\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/confirmThreadDeletion.js\":\"77e48569c280869a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/container.js\":\"694e046a6c31fa8e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/dataExtension.js\":\"2023391de17523f3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/deleteComment.js\":\"e9b7f8589f381e45\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/highlights.js\":\"a17c67174e150e83\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/index.js\":\"a9ea65e99ba946ff\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/linkedCommentsPill.js\":\"1650d766d9a1d4cb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/margin.js\":\"6ba38b1f9f386437\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/marginSchema.js\":\"cd4fc8924a3fdc5d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/newComment.js\":\"b738a395f931cd23\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/ownThreadPicker.js\":\"3ca0da3d8186d71c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/placement.js\":\"90b391b1c8197f87\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/queries.js\":\"32599a4184fc98dd\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/quotePosition.js\":\"2949b640bd9f1950\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/quotedIn.js\":\"e1e88502861ddb46\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/quotedRange.js\":\"490b8273f6bf7d24\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/rangeRefs.js\":\"c5c03d93a97efd94\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/readHighlights.js\":\"de602f73677e7ef1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/readSelection.js\":\"472adb374c09be35\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/readSelectionUi.js\":\"7e1c491a72100ba4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/reanchor.js\":\"7255cc86f6d4fdb8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/schema.js\":\"abe59889c0152d23\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/scope.js\":\"828f6ea9d981613c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/scopeThreads.js\":\"0581fd9df532a111\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/splitRetarget.js\":\"ead74b89853e4c9d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/suggestionCard.js\":\"6ea76046fe111e1b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/suggestions.js\":\"2d318a3fb6436c6e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/summaries.js\":\"e511f43e9aed08dd\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/summaryBatch.js\":\"12f147504ab15382\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/surface.js\":\"f20aa56d37735c38\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/threadNavigation.js\":\"79f6b849e031312b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/threads.js\":\"c205b3517e41a94d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/ui.js\":\"7eeae6f45c625f0b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/annotations/uiStore.js\":\"bffdf5afa30ab057\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/app-intents/appIntents.js\":\"b7e53a47740c57b4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/app-intents/index.js\":\"a56edaf5b400d8a3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/app-update-prompt/index.js\":\"5542acb6d1b1de92\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/app-update-prompt/status.js\":\"9351dad99f357fc7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c0200546cc1ae315\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/MediaBlockRenderer.js\":\"debd37e41b1ed2b9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ab1c290ff9ed3557\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/MediaUploadReconciler.js\":\"c84a166637b56a83\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/assetDownLane.js\":\"4979fd47c1609140\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/assetResolver.js\":\"bde0298785980ca6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/assetUpload.js\":\"844664cea27a14db\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/attachmentCleanerIO.js\":\"e3cec123b2b5269f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/audit/supabaseAuditIO.js\":\"64835c63ff35f419\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/blobStore.js\":\"a06983348d9f9b4a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/byteStore.js\":\"108fb4b20dbdaa0b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/cleanerIO.js\":\"241596e0ebb7dab9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/cleanupAttachments.js\":\"b3e548327ced2d14\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/dataExtension.js\":\"8a98bd001b8c3d2c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/downLane.js\":\"6aa4c5a380dde8a9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/index.js\":\"aa8d665e69928676\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/insertImageContribution.js\":\"fe928ca29b214691\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/laneArming.js\":\"f43e6f78bcf76591\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/laneLock.js\":\"26385ff4acc81e7d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/mediaBlock.js\":\"302d830ad56ed2f9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/mediaCapture.js\":\"994c1df67cd1652e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/mediaViewers.js\":\"f799f00578b1aab2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/mediaViewersFacet.js\":\"977fbf283abeadc6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/pasteCapture.js\":\"40cabe09f0b26566\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/resolver.js\":\"b2c6fb864d200716\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/retryUploadsAction.js\":\"69ff6034068bf10c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/storagePaths.js\":\"ab66e455bab7647d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/uploadDrain.js\":\"72050c3e157a6b2b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/uploadLaneStatus.js\":\"475976d50d9650e0\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/uploadReconcile.js\":\"ad07ab9cce9ef11b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/uploadRecovery.js\":\"cb73993007988d55\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/uploadStore.js\":\"bf87675059e106c4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/attachments/useAssetObjectUrl.js\":\"755734b3f88df6a2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"82ede8bd66278a67\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e09c5fece9f183a6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks-view/facet.js\":\"cd8254225e4f2ff6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks-view/index.js\":\"536ca34b94ff8f4d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks-view/prop.js\":\"532bb592cabd12b9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/BacklinkFilters.js\":\"5a7e2475c8fa4479\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"def31f17a079bbb5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/BlockEntry.js\":\"ed625eece2a9bd4c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/LinkedReferences.js\":\"a047db11b217224a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"6e2f4b726f77159a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/dailyNoteDefaults.js\":\"817dc37cc5833bb7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/dataExtension.js\":\"ff50d8223307d0ab\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/edgeExclusions.js\":\"f75684cebfd1b35e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/filterProperty.js\":\"08d5b794ba99628a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/index.js\":\"bc784afac3692356\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"20a7d8881a43370c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/inline-counts/applies.js\":\"a205bf466cd8fd8e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/inline-counts/countQuery.js\":\"a71f0cb6abe74fbb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7439be876f10b319\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/inline-counts/index.js\":\"fdee051dfe1f1bd8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8be766cc65d44504\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/presentationInvalidation.js\":\"eea1564022bb333b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/propertyEditorOverride.js\":\"7f69b0ec4ad58b4f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/propertyFilter.js\":\"1ca07b34635a2084\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/query.js\":\"7607c74ce7c61df0\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/resolveFilter.js\":\"a8787b67645daf6f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/sourceBatch.js\":\"965046ff50f09d12\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/sources.js\":\"a57ca56bdf023cea\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/useBacklinks.js\":\"bdc293fc63e5fb02\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"1968746457d1e932\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/birthday/BirthdayCelebration.js\":\"6e4721587e415438\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/birthday/BirthdayOverlay.js\":\"de7cc814238e601f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/birthday/gate.js\":\"6aa1223aa2064908\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/birthday/index.js\":\"6c6a93ef8509f304\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/birthday/wolfTheme.js\":\"b5f33796b17c60b7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-drag/BlockDragLayer.js\":\"caf6bca50e4f0384\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-drag/dragController.js\":\"5051c7be148021e5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-drag/dropTarget.js\":\"335cb1c1c162f540\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-drag/index.js\":\"dd0fbbf99edecbd1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-drag/projection.js\":\"4885d4655ac4847f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-info/BlockMetaCard.js\":\"e59cdd2f6289cb9e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-info/index.js\":\"b47d47c8d80dbd26\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-tagging/AddTagDialog.js\":\"19faba88a83968b6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7ee0c1d40cfd6ea8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-tagging/TagNameIssueHint.js\":\"6a6a6b8b0f5037d5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-tagging/addTagAction.js\":\"ef5177488d29ef2d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-tagging/appendTag.js\":\"1c245f4dc92ead4c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-tagging/config.js\":\"c3327d2ee8efddb9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-tagging/dataExtension.js\":\"49c4f58bf30d1a45\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-tagging/index.js\":\"5dad4af7b1f7ed9b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/block-tagging/propertyEditorOverride.js\":\"83fd4d5bd781d183\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9292d66bcb2560f2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"69220510596c220e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c9293f6f9f2993e4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3bbc5c755ee1e182\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f6491f9b53c0808a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/breadcrumbs/index.js\":\"94f43b30a3307924\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e64d9fa7a17ffbd8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/CharacterCountItem.js\":\"61724634935c9b98\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a83dc28418c38c66\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/actions.js\":\"3429dddf7d90bac1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/blockType.js\":\"6c4eb33d981c30f4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/charCount.js\":\"a1d6b36d1ef3ac2c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/dataExtension.js\":\"3c6640fe2ce1e0f3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/index.js\":\"a853afe88a94e86d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/profiles.js\":\"06417f90579b50bc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/properties.js\":\"408ab6ff213352df\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/character-counter/textCounts.js\":\"35d8d24bb3d3fc41\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/colemak-keybindings/index.js\":\"4527d15609dfbb1b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/command-palette/CommandPalette.js\":\"c42322789daf4f0e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/command-palette/HeaderItem.js\":\"73f77b0b48da5b1a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/command-palette/context.js\":\"223e2f2f9afecf86\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/command-palette/index.js\":\"dfb2fb8698d32855\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/command-palette/selection.js\":\"b6fb2d2cce6733c5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/command-palette/toggleStore.js\":\"648d687a98f3238b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/command-palette/useCommandPaletteActions.js\":\"6c95a2d62b304eea\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/ContributorBadges.js\":\"65c2325906709165\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/author.js\":\"b3b45d542118e4db\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/codeMirrorExtensions.js\":\"795076f271ea460b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/dataExtension.js\":\"66a006e815f8f6e7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/index.js\":\"48e6c2bc378715bf\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/mentionAutocomplete.js\":\"42b0b0059d117180\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/processor.js\":\"40b83650c23cc811\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/profiles.js\":\"99a90ba813807dd2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/queries.js\":\"90292a25b3fd87a6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/contributors/schema.js\":\"90962ec392e205f5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"292f934db184dff9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b0a6d8025d8cde62\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/cursor-follows-scroll/index.js\":\"35040adf73d15b9b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d2babd3f97e10c31\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"8b15305fdee8c932\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/CalendarGrid.js\":\"a30815387a523d1a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/DailyNotePicker.js\":\"b4cded5273be4dea\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8395f490290cda7c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/DateNavDecorator.js\":\"61b43c6ed82c254c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/DateScrubOverlay.js\":\"44dac3bce70b7d92\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/HeaderItem.js\":\"4641b30176b91fe5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/ReschedulePicker.js\":\"08eb86a5b1b484ed\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/SpreadDatesDialog.js\":\"af8076320950a064\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/actions.js\":\"8c09ef3536c405d3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/blockDateAdapter.js\":\"1b9a91cd3c4fcd66\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/calendar.js\":\"baa49740973b4c6a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/dailyNotes.js\":\"af8f3c6f11db39fe\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/dataExtension.js\":\"e0144bab94b5617c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/dateScrubActions.js\":\"669dcb2ce4388083\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/dateScrubGesture.js\":\"65cdbf1a5e3f201a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1cc00aeb1af208a2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4b99d09da7365713\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/deletionGuard.js\":\"282994df39c20241\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/dueQuery.js\":\"676986917fb3ac37\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/index.js\":\"cc68a67938daf0ee\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/landing.js\":\"e39a7bc09425262f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/localSchema.js\":\"2ed2c52ed8ef8288\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/referenceDateAdapter.js\":\"48096c82e6aaca35\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/rescheduleAction.js\":\"0aa6259313d32d17\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/schema.js\":\"6c7fd350165c73fb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/spreadBlockDates.js\":\"51ffd11959864d87\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/spreadDatesAction.js\":\"fcea9873336fae18\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/today.js\":\"cdd285a273a2b0b7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"23818c9dfe8d9854\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5c8efcb94584250e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/audit.js\":\"38334cd71909554c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/auditAction.js\":\"cf245bc9ec3fc475\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/auditRanges.js\":\"7088485c02fd9ec9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/diagnosticsSource.js\":\"995523805220bad2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/divergenceScan.js\":\"07befd83104b2d4f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/index.js\":\"41605c7a3badec4a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ed2b93944552a20d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/referencesMirror.js\":\"7ccc016bdf3ff5e5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/rowJson.js\":\"fc48d8497e702c91\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/schedule.js\":\"a2f2ecfa223ecf60\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/data-integrity/store.js\":\"dab1689e6c062492\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-maintenance/action.js\":\"ee29eeb101bd6b5d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-maintenance/index.js\":\"869985c3843accbb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-maintenance/plugin.js\":\"782efc5ad4fa8758\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"90fb691c84bd8f83\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/actions.js\":\"75bd5e8d5100eddb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/changeMarker.js\":\"8d8282da0f1ecc41\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/diagnostics.js\":\"77775f24a63949ba\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/fileSystemAccess.js\":\"c4c979f42f59e1a6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/filenames.js\":\"bf06b9823d4408a5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/index.js\":\"6577e64d5f0731fc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/mirror.js\":\"eaa5abc760bcc9e2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/runLock.js\":\"32abe9c83b6747c8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/runtimeHealth.js\":\"d05944429fe69eb9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/schedule.js\":\"c67c9fe1533eb5ee\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/db-mirror/store.js\":\"d262cc17f9125676\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/default-themes/index.js\":\"eff7aacfad7c461b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/default-themes/themes.js\":\"a68106b51d57bac4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/diagnostics/facet.js\":\"4034645ce2058d11\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/diagnostics/useDiagnostics.js\":\"a47eb5c943c4968d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extension-prompts/dismissals.js\":\"450149f2bee42030\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extension-prompts/index.js\":\"4529bf001704daa6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extension-prompts/status.js\":\"68ab7c7412f863ef\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extension-prompts/store.js\":\"3267892b26e367e7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"76e543f7cabad812\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c7d9bf871d59a805\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extensions-settings/actions.js\":\"d927238cff92849e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extensions-settings/config.js\":\"4700e6991cfe18f3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extensions-settings/dataExtension.js\":\"d3dc6a3cd097c1c5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extensions-settings/effect.js\":\"7d5a4d11d40f2000\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extensions-settings/index.js\":\"8fa2ce21a8d3e5e1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8d100f499d42ee73\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extensions-settings/useToggleTree.js\":\"0913084a84b17fb1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extract-type/ExtractTypeDialog.js\":\"71d71ee9d5e665b2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"0d24e3f9f02d00b6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extract-type/PropertyShapePicker.js\":\"dcd9b69dbf04e4dc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extract-type/action.js\":\"b5bdf08916f4088f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/extract-type/index.js\":\"d7a10009157831e7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/find-replace/FindReplaceDialog.js\":\"fe83841e0f45b647\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/find-replace/HeaderItem.js\":\"565497e6ec8a52f9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/find-replace/dataExtension.js\":\"e88f5286c71c0a27\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/find-replace/index.js\":\"d54ffe955a214623\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/find-replace/search.js\":\"c8e820fc1caeb53b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/find-replace/toggleStore.js\":\"ae045786f693801a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/LocationPropertyEditor.js\":\"97d901b2f682e9bd\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/MapView.js\":\"d8cfe01996be3668\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/blockTypes.js\":\"db7886fbab8590d4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/codeMirrorExtensions.js\":\"f82b19a62a043166\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/createOrFindPlace.js\":\"22670c09f0971df5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/currentLocation.js\":\"b4daae7c1a3aced6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/dataExtension.js\":\"de5d9e13de8dfee6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/geoContentDecorator.js\":\"3fe512596dcaa4cb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/googlePlacesClient.js\":\"a230a15df7cc2fcf\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/index.js\":\"da2a6068669a3a97\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/locationsPage.js\":\"d4c0bd581efd37eb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/mapViewport.js\":\"b9911a25f51880b5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/pickCurrentLocation.js\":\"cf8c04b63d16c121\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/placeAutocomplete.js\":\"084e836fde9e977c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/placeNameCollision.js\":\"3ae1a3a8a728f49c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/properties.js\":\"99ff711c17fe40b8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/propertyEditorOverrides.js\":\"f32415c32ab91460\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/query.js\":\"485ea542d629cc26\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/geo/usePlaceSearch.js\":\"94a4c190d7135e23\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"be62384ee80b0740\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0682bec2481be8bb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8b3b12e6217f59d9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/config.js\":\"0c72f51402132954\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/dataExtension.js\":\"292eb5ccb9eaec74\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/facet.js\":\"527db50dc21565dc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/grouping.js\":\"d36c27c658b827f3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/index.js\":\"5baa8dbd2661bae7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"97da23b8cf67d01a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/query.js\":\"09e5bcee68264838\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/resolveConfig.js\":\"2c381b0c313ce621\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1ecb15bf0b560635\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9ffb955d37c4f8d7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/HtmlDocumentContent.js\":\"8c1841568822203c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/HtmlFrame.js\":\"6263f352676d1ce1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/actions.js\":\"928bf06fe32985b6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/blockType.js\":\"2de70733e5ad6e73\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/confirmRunScripts.js\":\"80640bfc91dfc30d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/dataExtension.js\":\"f5792b71aac4d47f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/frameAnnotations.js\":\"52c2b887a068d9f4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/frameDocument.js\":\"7257e816b36c89b4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/frameTheme.js\":\"c26c31ba8e35e5ac\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/index.js\":\"22d91f1ac49194a2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/scriptConsent.js\":\"1edec9d1392e1aff\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/sourceMap.js\":\"036f8a20d6e4fd14\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/html-document/useDocumentScripts.js\":\"283818c4dd0fa00d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/interaction-metrics/index.js\":\"227e83caeea3437f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/interaction-metrics/record.js\":\"5feb0b98ae272765\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/interaction-metrics/recordStore.js\":\"5ee670032e7d1d28\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/interaction-metrics/responsiveness.js\":\"7dad321990cc3a84\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/interaction-metrics/schedule.js\":\"789f69eecd008b3c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/interaction-metrics/sessionContext.js\":\"5e9b1463babaa3ef\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"890b3dac271bfc79\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e6cba453eaec3948\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/actions.js\":\"08d6a7eb819da302\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/config.js\":\"ae9c28a706eae84e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/dataExtension.js\":\"e268d9379c36ebb1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/effect.js\":\"c4b6996213bf40c7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/index.js\":\"ed1bcb258ab6ee1d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/keyCapture.js\":\"808a5c1d0ad5c331\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/overrideStore.js\":\"d94f82f0aaf2015c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0e31330942dd7e81\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/left-sidebar/HeaderItem.js\":\"980ea86defc74146\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/left-sidebar/LeftSidebar.js\":\"4e6b3d503d8e4231\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/left-sidebar/actions.js\":\"4940ecf4fe6df02a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/left-sidebar/facet.js\":\"0c0d50f9fdeb1676\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/left-sidebar/index.js\":\"765c8cbe4853d361\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/left-sidebar/shortcuts.js\":\"9b6b31be25115258\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/left-sidebar/toggleStore.js\":\"deb4c31adf865ef7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/merge-blocks/MergePicker.js\":\"cbca5f9c5134058e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/merge-blocks/index.js\":\"51fc0c9af5f6607e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/merge-blocks/mergeAction.js\":\"da15e416674cf822\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/merge-blocks/strategy.js\":\"5f9c3835d34951e9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-bottom-nav/Button.js\":\"cafde4a4d204b63d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ba32ddc16825afd6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-bottom-nav/defaultItems.js\":\"bcb3e6a5ef1f937f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-bottom-nav/facet.js\":\"a1e73757b9208aa2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-bottom-nav/index.js\":\"2261444f38da2f82\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"38696f362788630f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7068238d5426c74e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0f72018dc28dc636\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-keyboard-toolbar/facet.js\":\"04cd34750849d025\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/mobile-keyboard-toolbar/index.js\":\"ca284a67c0bee644\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9430ca5cef697be5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/move-blocks/blockSubtreeMembership.js\":\"664c7f5bb51e8354\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/move-blocks/contextMenuItem.js\":\"f9a9bd8cfe770b70\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/move-blocks/index.js\":\"ee517a2d4960eccc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/move-blocks/moveAction.js\":\"66830ed18d951be2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/move-blocks/moveBlocks.js\":\"82109552a6f43fe7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/move-blocks/selectionAfterMove.js\":\"38714b5982b2c832\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/onboarding/TutorialBanner.js\":\"e99baa249e8f5928\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/onboarding/action.js\":\"83af02639c62d6b3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/onboarding/bannerDismissal.js\":\"08cea18fd0d84b41\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/onboarding/documents/cheatSheet.js\":\"2e1c4e8a05830fba\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/onboarding/index.js\":\"0526cafff116908e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/onboarding/keys.js\":\"01407b4e0833c03a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/onboarding/landing.js\":\"a2b85b5a6925e18c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/onboarding/outline.js\":\"c964fbe82b890b1a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/onboarding/seed.js\":\"9c4a7ccac45e479f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/PerfTrendDialog.js\":\"af01005db5db0334\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/analyze.js\":\"346f56e9b5551ec5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/diagnosticsSource.js\":\"7fda966d8e26149e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/index.js\":\"bf5fa371cba88719\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/load.js\":\"48501bcdf149e3f8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/monitorRun.js\":\"aa49c1f40640c04f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/schedule.js\":\"0e5cad448916b7d4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/series.js\":\"767925bc0e0f79d3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/store.js\":\"5573e18183464d80\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/trendAction.js\":\"65c41accb2349db7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/perf-monitor/verdict.js\":\"daa71f6e07259b70\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/plain-outliner/clickToEditAction.js\":\"a3c64820ff5e63fa\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/plain-outliner/index.js\":\"cfd1b5c598a668e8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/plain-outliner/interactions.js\":\"454cdb0b9ccd54eb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0ff29befed328720\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/properties-migration/MigrationGate.js\":\"3ddfabd0fd795396\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/properties-migration/MigrationGateDialog.js\":\"a0aa8070ada7b52b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/properties-migration/action.js\":\"e120c65f8cbf61b8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/properties-migration/index.js\":\"d3308000114e14e8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/properties-migration/localRunMessage.js\":\"d61da28a89c5fea8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/properties-migration/plugin.js\":\"fa45e2ea7d47dfa9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/properties-migration/progressReport.js\":\"eaa27b14848bfacd\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/properties-migration/sweepProgress.js\":\"abcda5cff818b62b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/property-rows/FieldRowRenderer.js\":\"8174a26708ab5c85\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/property-rows/ValueRowRenderer.js\":\"b28ddf27fc271317\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/property-rows/actions.js\":\"6e07ef17496cc30c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/property-rows/autocomplete.js\":\"041261448193b30f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/property-rows/fieldRow.js\":\"c598d2b9375986e4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/property-rows/index.js\":\"32c126376d43ebf9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/property-rows/referenceWarning.js\":\"2db29d8392b42202\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/property-rows/valueAutocomplete.js\":\"5d68e20e00fcff16\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/property-rows/valueSchema.js\":\"7e9e9babd11e40cb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/quick-find/HeaderItem.js\":\"b9f20a6f4d911ad9\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/quick-find/QuickFind.js\":\"d2d36724718833ba\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/quick-find/index.js\":\"7fab36d7efc5fdf0\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/quick-find/recents.js\":\"1f96274070f30e95\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/quick-find/resultItems.js\":\"8f6ba29d4cc23003\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/quick-find/selection.js\":\"7341f251e770c3ca\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/quick-find/toggleStore.js\":\"24b5c94fe597e6e0\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/recents/HeaderItem.js\":\"31f9c3cb617bd373\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/recents/RecentsPageBlockRenderer.js\":\"72c8d879584024ec\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/recents/grouping.js\":\"d736ffbc8a48b3ed\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/recents/index.js\":\"6a71a229727e63fb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/recents/target.js\":\"0088e5f3151dfc47\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/codeMirrorExtensions.js\":\"5a62a6ff921c148c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/contentPrefill.js\":\"af3d1039410a33bd\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/dataExtension.js\":\"d6a8126edd57d871\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/index.js\":\"a24c452fd849bdbf\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"519c6ef49f31962f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/invalidation.js\":\"c28b35cf26b542f4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/localSchema.js\":\"5d267b123737511e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/markdown/blockrefs/index.js\":\"a0a4f18fe8da9271\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"16078bc38ff8369b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/markdown/index.js\":\"28e1d91476f4bad1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/markdown/referenceNode.js\":\"e977a35d4175ce70\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a37cdfa71e260d91\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"31d262020cc7d1d3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/markdown/wikilinks/index.js\":\"453998892a126e85\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5ddaea3c0d09ec2f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d335113dca57b493\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/mergeRetargetProcessor.js\":\"42f6e631be829b6b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/parseFence.js\":\"f2967c9e44545b73\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/referenceParser.js\":\"c2989616e51bfe29\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/referenceProjection.js\":\"ea58487d4821dbe7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/referencesProcessor.js\":\"bd0b87f8c227f562\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/renameProcessor.js\":\"8147a1b3ff8f284d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/references/spanReplacement.js\":\"89a947c577a6cd16\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/rich-paste/htmlToOutline.js\":\"d6f5cf59e77a4f6d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/rich-paste/index.js\":\"d6d0edb00711aecc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/rich-paste/normalizeClipboardDom.js\":\"58d8a3077b45c8bd\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/rich-paste/pasteDecision.js\":\"e27ca709dd0f7882\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/action.js\":\"28f301a2ea299e25\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/blockIds.js\":\"3b0cc30b94019975\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/content.js\":\"a4c5974c7b48585b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/effect.js\":\"9b4e4407605c81ce\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/ids.js\":\"16c045f8a715777e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/import.js\":\"06bd8b93993abb7a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/index.js\":\"4f84d47c18289fc8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/plan.js\":\"5d30bbf7bb30f29c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/plugin.js\":\"ffb2958a49bcdf4d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/promotion.js\":\"24b3f5bbd4e0f483\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/properties.js\":\"f23d9d822ee64e80\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/references.js\":\"f3238be49bbb52c6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/report.js\":\"546748cea26429da\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/roamMemo.js\":\"947255d617382fff\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/runtime.js\":\"95be1063293ff7bc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/schemaReconciliation.js\":\"55274fb8e5e54aa2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/srsMarkers.js\":\"924653169c923e28\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/todo.js\":\"2ca0ed7c9f9ce7a8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/typeCandidates.js\":\"96e0e08fa22d3b8c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/roam-import/types.js\":\"1dbc18c5c9e0da7f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/search-health/index.js\":\"c386b1e89c1b63e7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/search-health/store.js\":\"ee3e7e53191e9313\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/shortcut-help/HeaderItem.js\":\"b9f33ab99c4d4be6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b5bc5567cb7b4622\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/shortcut-help/index.js\":\"c02e05055e2eff11\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/shortcut-help/model.js\":\"a775ff502fdbc4a3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/shortcut-help/toggleStore.js\":\"937b4bfea65e3360\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/shortcut-help/useKeyInspector.js\":\"fab59f10714831cd\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"87acb5a628834625\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/spatial-navigation/ShellDecorator.js\":\"b1acc91821f31a3d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/spatial-navigation/actions.js\":\"590fe0e6e2a78f14\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e5b777d46bcdbcf3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/spatial-navigation/index.js\":\"56a850166b21fdfd\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/spatial-navigation/shell.js\":\"7ec8194567b455cb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/spatial-navigation/surface.js\":\"6dbfebd14897da16\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/spatial-navigation/walker.js\":\"72a3cb798051fe02\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8c8c9ad58f48ee4a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/dataExtension.js\":\"7291423ff74fa9e1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/index.js\":\"a8cf4dcb80721f33\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/indicator.js\":\"cde21b337613e802\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/moveSrsState.js\":\"1d65bfd9653d0375\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e72de162877490f8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/scheduler.js\":\"2bd32351b4dfc96b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/schema.js\":\"5c7fd8d9cd763d1f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"adcfb9a81b0d74cc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/srsClipboard.js\":\"ac19a51853394bb1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"75b8e2eb2f38fc8c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3d86ffa2d1b1b6cc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/DeckPicker.js\":\"a131c8deb7d09ec8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/ReviewControls.js\":\"f143f1a26bd3b70c\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0d5572235c79e541\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/ReviewSession.js\":\"449316ff2898629b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/actions.js\":\"87ec393ee4b1889d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/archive.js\":\"82fdcd46e5dea362\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/dataExtension.js\":\"5de00cb0dc98620d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/deck.js\":\"2625bae4ecd26ba6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/dueQuery.js\":\"693e02a8cbf2a388\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/gradeDecision.js\":\"79d0300b66555de3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/index.js\":\"bb8cd01dcb5a3cf7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/keyHints.js\":\"bdff09630ea9d463\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/reviewCardLayout.js\":\"c8934ee1ba40d737\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/reviewProgress.js\":\"57bfa1c56d13a76d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/schema.js\":\"c9a3d026d6fb694d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/srs-review/useDueCards.js\":\"e20238e059bd3c28\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/startup-metrics/index.js\":\"797edff1901412e7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/startup-metrics/record.js\":\"eeeb5d2491404b17\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/storage-persistence/index.js\":\"3133ee857c3b85f6\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/storage-persistence/persistenceStatus.js\":\"b44b1985dd7a6a80\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/storage-persistence/requestAction.js\":\"61e42ad41fab1012\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/supertags/TypeChipsDecorator.js\":\"2ab3ea597d1c5969\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/supertags/codeMirrorExtensions.js\":\"9a69165def690ea7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/supertags/index.js\":\"08780322e56666d8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/supertags/typeAutocomplete.js\":\"41699bf6a997a8b0\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1814a7c78ac62157\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/swipe-quick-actions/actions.js\":\"8f0131583dde5b17\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/swipe-quick-actions/anchor.js\":\"7e16b6a380957214\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/swipe-quick-actions/events.js\":\"0d677d7ca48afea1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/swipe-quick-actions/gestureActions.js\":\"09eaf71b0e7521d2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/swipe-quick-actions/index.js\":\"a7e02a4131cb340a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"bddb8c601305d790\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/sync-metrics/collect.js\":\"7587ddf1248a99f7\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/sync-metrics/index.js\":\"9178c3caa835240b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/sync-metrics/record.js\":\"f2c9d4f4977419b8\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/system-status/RejectionDialog.js\":\"456ba67f7a852782\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a2bfdb2a6bb651fb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/system-status/index.js\":\"961bfeab9e287aae\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/system-status/model.js\":\"1912df5788d07dc2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/system-status/queueCounts.js\":\"8ccf0edc653b8bdd\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/system-status/rejectedHelpers.js\":\"b6f1442b0a21210a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/system-status/rematerializeAction.js\":\"83eaaf46bef7f193\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/system-status/useHysteresis.js\":\"348cd56750cd9461\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/ColumnHeaders.js\":\"6bb041b7be2aae5e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/TableLayout.js\":\"f451ad4d8234fdd4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/actions.js\":\"9386e81616d1dcec\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/cellEdits.js\":\"dc236f211c343310\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/columns.js\":\"72ea7699ace9d93a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/controller.js\":\"1d2749316e50a337\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/convert.js\":\"899eaf7fe5dc5443\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/dataExtension.js\":\"b1c583d1961e58b4\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/index.js\":\"ccf9366b8c9acd67\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/keys.js\":\"a74ef2da0b4738c3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/model.js\":\"9ebfd9e0dd853bb1\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/registry.js\":\"a9ad2ee3d2019659\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/tables/schema.js\":\"242307f0d241e070\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/theme-toggle/effect.js\":\"52be142225fbffbb\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/theme-toggle/index.js\":\"c928c11ae8d4e3bc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/theme-toggle/theme.js\":\"8524d8b5cc333323\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/todo/actions.js\":\"6650743173f2ccee\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/todo/dataExtension.js\":\"7733710d648ca340\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/todo/index.js\":\"e29bf63623ce7370\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/todo/schema.js\":\"79fde7b0be80483a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f74fab264472b198\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/touch-selection/actions.js\":\"97eae463064c7e28\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/touch-selection/defaultItems.js\":\"2e21a9e04ed680aa\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/touch-selection/facet.js\":\"3178fd1ee5907264\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/touch-selection/holdRecognizer.js\":\"b4d9e9e17f4af54a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/touch-selection/index.js\":\"f260c10007215bfa\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/update-indicator/UpdateIndicator.js\":\"a9a511664ff2f20d\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/update-indicator/index.js\":\"8bcf4ca3d62ed7ce\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/update-indicator/loadTimes.js\":\"655ee54aa180c232\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/VideoNotesRenderer.js\":\"250d08c67dbd420f\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/VideoPlayerRenderer.js\":\"bc4118bd9505247b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/VideoTimeStamp.js\":\"c65feaa64265fcd3\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/actions.js\":\"cf1f18d4d5f08b19\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/index.js\":\"2d1b9ad2fde752da\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/markdown.js\":\"acf6d95af148938e\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/notes.js\":\"3c7851d73bb6cc3b\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/registry.js\":\"906f5c1ee04bf0fc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/remark-timestamps.js\":\"b879e0e686ea77d2\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/video-player/view.js\":\"5cd01209f08e680a\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/vim-link-hints/LinkHints.js\":\"de4522e426bf6728\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/vim-link-hints/index.js\":\"75693e543f0ca210\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/vim-link-hints/model.js\":\"2050d392ca1cb5a5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/vim-link-hints/settings.js\":\"dd5f63dee90534fc\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/vim-normal-mode/actions.js\":\"93ce18ea7f7070b5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/vim-normal-mode/index.js\":\"9763620d9266d2c5\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/vim-normal-mode/interactions.js\":\"7fda1dc083a84802\",\"/knowledge-medium/pr-preview/pr-1836/src/plugins/workspace-header/index.js\":\"18df589029d57cf5\",\"/knowledge-medium/pr-preview/pr-1836/src/registerServiceWorker.js\":\"0334146e7c9a8676\",\"/knowledge-medium/pr-preview/pr-1836/src/requestPersistentStorage.js\":\"6f822b64de6fe439\",\"/knowledge-medium/pr-preview/pr-1836/src/services/authRequestDeadline.js\":\"03b5b73e3d67afc6\",\"/knowledge-medium/pr-preview/pr-1836/src/services/authStorage.js\":\"b02e19bb380b2208\",\"/knowledge-medium/pr-preview/pr-1836/src/services/powersync.js\":\"8f1000b1d6bd94c9\",\"/knowledge-medium/pr-preview/pr-1836/src/services/supabase.js\":\"32dab2f2a223e7d8\",\"/knowledge-medium/pr-preview/pr-1836/src/services/uploadErrorClassifier.js\":\"0d85c3bd52c73b6b\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/ActiveContexts.js\":\"b784ded59e5499f8\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/HotkeyReconciler.js\":\"ff4cc78fe1b4d380\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/WipeLocalDataDialog.js\":\"d8c7993e22ef20f1\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/actionDispatch.js\":\"6e1375d4ac8ccd5f\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/actionRefItems.js\":\"a6051123ac038d19\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/applyKeybindingOverrides.js\":\"e78c59b448dc20ac\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/blockActions.js\":\"e711d1f68f9949eb\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/canonicalizeChord.js\":\"11dcf3e1c9a3cc1b\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/defaultContexts.js\":\"3c02128eb0253d76\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/defaultShortcuts.js\":\"6a4ce0d5f003b5c0\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/effectiveActions.js\":\"d30125dbda4f114c\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/gestureAction.js\":\"97e6f73c3be39b9f\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/gestureBinding.js\":\"48c6c244eac748db\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/holdRegistry.js\":\"dd448c3ff479488a\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/keybindingConflicts.js\":\"44c2e93be0196c21\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/keybindingOverrides.js\":\"c92b7ec5be49e416\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/pointerAction.js\":\"bacdc10d1052b0b2\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/resolve.js\":\"1f1832b8a2ea4750\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/runAction.js\":\"280e7066d7df8c62\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/sequenceMatcher.js\":\"f4ec303e5a3c9b2d\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/types.js\":\"897d002e5ed998d9\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/useActionContext.js\":\"375b8e2a9539caa7\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/useActionDiscovery.js\":\"e25090b995be9756\",\"/knowledge-medium/pr-preview/pr-1836/src/shortcuts/utils.js\":\"14256b2d5be95d91\",\"/knowledge-medium/pr-preview/pr-1836/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1836/src/sw/bootStore.js\":\"44e8be25141b7711\",\"/knowledge-medium/pr-preview/pr-1836/src/sw/previewDatabases.js\":\"57393f58cb364743\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/byteTransform.js\":\"9d9c0434e4b13305\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/attachmentCleaner.js\":\"f0c4c400d62454b7\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/bundle/attachmentParts.js\":\"e74cc9505e610caf\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/bundle/bundleParts.js\":\"835cdfacd5163290\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/bundle/bundleRecord.js\":\"2d819a401937669c\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/bundle/manifest.js\":\"b74b160f2450c9b0\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/bundle/takeBundle.js\":\"cfc1e865aaddfd5e\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/bundle/verifyBundle.js\":\"dc065ad67629e05f\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/cleaningStage.js\":\"564de922d20652b8\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/conversionKey.js\":\"4c99be8348a6a5b4\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/conversionServer.js\":\"47bf67831bf8c19d\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/flip.js\":\"76fb0439d3c6a548\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/flipAttempts.js\":\"74d8bc558e7d1729\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/pages.js\":\"969381a6207c9acc\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/preflight.js\":\"78bcc43f38de7009\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/reseal.js\":\"cbd2af554832b078\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/runConversion.js\":\"a9fec44f57b49c5e\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/runLock.js\":\"8537110b2514db0d\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/sealing.js\":\"15c22cb39c525668\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/sealingStage.js\":\"76c0e185a2d2bd4f\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/stage.js\":\"a6514b7a1ddf9765\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/conversion/verifyReseal.js\":\"336602c10e127371\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/aad.js\":\"b6cac112721a3815\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/aead.js\":\"126e17bf647c305b\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/base32.js\":\"a007705da70a4e5b\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/base64url.js\":\"d5023c77d9766cae\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/binaryEnvelope.js\":\"5399cfb0f302578b\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/byteAead.js\":\"5f1ebf81870ca923\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/canary.js\":\"645251d2e6f604e8\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/contentHash.js\":\"e049799a133b325e\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/contentKey.js\":\"945968bc8fb9ccd8\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/derivedIdNamespace.js\":\"4dba70b2f4d5f97f\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/envelope.js\":\"eef6272c7c869ae2\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/hex.js\":\"193f11f271ba6c2c\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/sha256Hex.js\":\"59b5515f476b3454\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/crypto/workspaceKey.js\":\"5d983899f8a944d4\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/conversionState.js\":\"42d76d45d204de2c\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/flows/createEncryptedWorkspace.js\":\"1db6c4be28534b7c\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/flows/pastedKey.js\":\"a70261e757222238\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3ae42f5248bbf8b5\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7bfb74ad8de82981\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/keyStore.js\":\"792ea95f364f92db\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/mintWorkspaceKey.js\":\"878331530e39f2b8\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/modePin.js\":\"30e5949bf55c31c0\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/openWorkspaceKeys.js\":\"a510aa2677c40a56\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/resolveWorkspaceEntry.js\":\"9da8d8386ece0dee\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/resolver.js\":\"291f8ffeba7bd8c7\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/keys/workspaceAccess.js\":\"08f6dac185c36fd6\",\"/knowledge-medium/pr-preview/pr-1836/src/sync/transform.js\":\"2ec42ca41db3b3e3\",\"/knowledge-medium/pr-preview/pr-1836/src/themeBootDefaults.js\":\"d36d3cf5116ea694\",\"/knowledge-medium/pr-preview/pr-1836/src/types.js\":\"2cfd4f81271ac4de\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/ClientLocalSettings.js\":\"46bfedb9b13f3d0c\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/abortableSleep.js\":\"8433ebca2c765102\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/array.js\":\"4150d99d4a705d6e\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/backlinkAutocomplete.js\":\"618c27dd43bd0fa6\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/blockCrumbs.js\":\"97dbffd8bd603024\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/blockrefAutocomplete.js\":\"09b8481e539c5f69\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/cadencedIdleJob.js\":\"828feeb8e79afbbd\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/callbackSet.js\":\"c3548748f1f04351\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/clientId.js\":\"17e8864d8b5fa918\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/codemirror.js\":\"69885399cfcda8d5\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/codemirrorCompletion.js\":\"7d6dd56bd6edd36a\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/copy.js\":\"f746067332250adc\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/dailyPage.js\":\"1654f190f293812d\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/dbForensics.js\":\"b50e71416b1f975f\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/dbForensicsHooks.js\":\"722f84a49bfe7098\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/deleteBlockThroughUi.js\":\"b90d3c41d4169a4d\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/dialogs.js\":\"37b7a20583741f7c\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/dom.js\":\"050ae623bbb1f1bc\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/downloadBlob.js\":\"3a6f227f2aaea10f\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/exportSqliteDb.js\":\"79fd76dbccdb2c58\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/fileSystemAccess.js\":\"df4a8aec9e267a45\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/flipSlide.js\":\"33ebdb3773bb3be0\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/fnv1a.js\":\"2fc6285916e27fa6\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/formatBytes.js\":\"2e44e4a85dea377e\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/fuzzyRank.js\":\"1355ddae3172e7f6\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/idbKeyedStore.js\":\"d20526924f86b9c0\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/idleCallbackPolyfill.js\":\"1f7e015d9e590567\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/keyboardAwareScroll.js\":\"b14a730c52e1f039\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/keyboardViewport.js\":\"ade78f8c579117ab\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/lastWorkspace.js\":\"a4640b0f6141f5f2\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/layoutColumns.js\":\"75c9caad17d74ea7\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/layoutSessionDom.js\":\"9e9fec5425e1e311\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/layoutSessionId.js\":\"7d1a64fd5a19954b\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/linkClickGestures.js\":\"36c2eaa939ae1ad0\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/linkTargetAutocomplete.js\":\"e31b070ebf401a6f\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/localDbCorruption.js\":\"02ccf4dc0d689670\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/localDbRecovery.js\":\"e6e80485ec370a7a\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/markdownParser.js\":\"81edeed7c7db381a\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/memoize.js\":\"8cdf295e4de7a37b\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/nameFieldCommit.js\":\"89483a181da546f3\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/nameList.js\":\"2f9743524dc7a3e4\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/navigation.js\":\"d591fadb9b07085f\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/omnilinerNamespace.js\":\"bcd4250c2acce6e9\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/opfsPageScan.js\":\"346bd3015123c482\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/panelClearance.js\":\"3b16975fb2ebbb4a\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/panelHistory.js\":\"44b84318f2b56ffa\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/panelLanes.js\":\"ce49367a3840268a\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/panelLayoutProjection.js\":\"83c05f967b880329\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/panelScrollAnchor.js\":\"65597e7ca7f2a392\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/panelUrlFlags.js\":\"ea1fdc39519afc5c\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/platform.js\":\"7cc9673ff24301d9\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/pluralize.js\":\"337bf04ea612515b\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/propertyCreation.js\":\"a08e5e3d814c8106\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/propertyNavigation.js\":\"0cddd0926645c149\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/propertyValueContext.js\":\"020ba697d185cc31\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/react.js\":\"00cf8f7b9d3653fa\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/relativeDate.js\":\"6883e6cfc8af0a17\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/relativeTime.js\":\"4d6b302660340571\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/renderScope.js\":\"872f842ac2fda255\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/resolvedThenable.js\":\"8b8daf74b7b6eefe\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/routing.js\":\"62303d3a5bd13d50\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/safeMode.js\":\"25f4175c036c3014\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/scheduleIdle.js\":\"7b480ba95d85d054\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/screenWakeLock.js\":\"e3918be3e99243b2\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/selection.js\":\"2fe9eaef4b172776\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/softKeyboardGrab.js\":\"8401fbe2174e8e3a\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/startupTimeline.js\":\"b39e818cb455778e\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/state.js\":\"34b7e057909809ef\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/string.js\":\"2145fe1125844346\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/surfaceZoom.js\":\"1e64e250f64dee7c\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/time.js\":\"b44d8705fdaac060\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/toast.js\":\"893274d799567baf\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/toggleStore.js\":\"b40c5aae9e12e45a\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/untilStopped.js\":\"d32015f149c0c290\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/userActivity.js\":\"97540d20ba048fc0\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/viewTransition.js\":\"708d0ab0527c54fe\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/viewport.js\":\"d922e78da1ec4abf\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/webLock.js\":\"e06f562975c8efb3\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/workspaceRecovery.js\":\"fe52a4d7b3a262e6\",\"/knowledge-medium/pr-preview/pr-1836/src/utils/workspaceSnapshotStore.js\":\"04716ce08c42dcc0\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-compiler-runtime.js\":\"273495c39ad70a51\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-dom-client.js\":\"115d9aeb6d823bb8\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-dom-server-edge.js\":\"cb7c49920b251958\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-dom-server.js\":\"c762c1ddcfebb1ad\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-dom-static-edge.js\":\"8ab4bc4d1f4dbc1a\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-dom-static.js\":\"faede8f4e0f1b2b1\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-dom-test-utils.js\":\"a5c2f2c0900eaa28\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-dom.js\":\"0b04340079c05781\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react-jsx-runtime.js\":\"a99f72c32665f636\",\"/knowledge-medium/pr-preview/pr-1836/src/vendor/react.js\":\"83b16bc196683bc4\",\"/knowledge-medium/pr-preview/pr-1836/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1836/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1836/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
