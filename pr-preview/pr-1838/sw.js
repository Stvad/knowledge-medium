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
		buildId: "14e2a80fb95e-fefbbf0a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/\":\"838ff383aa4832e8\",\"/knowledge-medium/pr-preview/pr-1838/index.html\":\"838ff383aa4832e8\",\"/knowledge-medium/pr-preview/pr-1838/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1838/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1838/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1838/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1838/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1838/assets/FacadeVFS-BySLRrgy.js\":\"c937961717e328e7\",\"/knowledge-medium/pr-preview/pr-1838/assets/OPFSCoopSyncVFS-BJussN0g.js\":\"843ec09d77610a7e\",\"/knowledge-medium/pr-preview/pr-1838/assets/OPFSWriteAheadVFS-22KnAots.js\":\"ff4d9107215a71b8\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-CUslscDW.js\":\"ecbe51a9cc52c25e\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-async-CzHkASy3.js\":\"b9205250746f8a6f\",\"/knowledge-medium/pr-preview/pr-1838/assets/worker-BPHOaONh.js\":\"21ce53a57ca3e255\",\"/knowledge-medium/pr-preview/pr-1838/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1838/chunks/app-of-M_6eT.js\":\"9a02e829d8fb7539\",\"/knowledge-medium/pr-preview/pr-1838/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1838/index.js\":\"61f1329cf5771087\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1838/assets/AccessHandlePoolVFS-CT99hxBA.js\":\"7e6b1a2e30ec2a15\",\"/knowledge-medium/pr-preview/pr-1838/assets/IDBBatchAtomicVFS-CTCRiAsU.js\":\"55b425e36708ce25\",\"/knowledge-medium/pr-preview/pr-1838/assets/MemoryVFS-Dg-kJpBa.js\":\"827562397803fb1d\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-D3HCz0zt.js\":\"f631cfb2cb828574\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-async-eWUON75F.js\":\"c535857379a2efff\",\"/knowledge-medium/pr-preview/pr-1838/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1838/chunks/AccessHandlePoolVFS-DBj1w3yo.js\":\"8faa58086be07086\",\"/knowledge-medium/pr-preview/pr-1838/chunks/FacadeVFS-BeKKfCaR.js\":\"eea60a291a2c31de\",\"/knowledge-medium/pr-preview/pr-1838/chunks/IDBBatchAtomicVFS-DKuzPkJH.js\":\"ebbcd84c0f4a971b\",\"/knowledge-medium/pr-preview/pr-1838/chunks/MemoryVFS-WbAJf-Cm.js\":\"4413fadd053fe288\",\"/knowledge-medium/pr-preview/pr-1838/chunks/OPFSCoopSyncVFS-CQoTZbA8.js\":\"5f92ce94b606d00c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/OPFSWriteAheadVFS-DavoK32o.js\":\"79b6114ebfc3e2b6\",\"/knowledge-medium/pr-preview/pr-1838/chunks/Preview-CF_zSmMR.js\":\"13ca655810966138\",\"/knowledge-medium/pr-preview/pr-1838/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/card-HyrNbTwS.js\":\"cbcc50bc2bf89dee\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-BSvaITpB.js\":\"f83263d41afba007\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1838/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1838/chunks/mc-wa-sqlite-Z9OeqASv.js\":\"d0eaf25bb218ac2a\",\"/knowledge-medium/pr-preview/pr-1838/chunks/mc-wa-sqlite-async-BgpXKL_H.js\":\"8af2bce8ddc67cb5\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-CH3ysI5j.js\":\"ebe4c262b9b822e7\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-CcrQdtNg.js\":\"4e5463095cf8b22c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-Ch6J9nnM.js\":\"d78c2226a700e51b\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-DdmQAj-L.js\":\"860ee7f694f9693a\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-Dfux_XAC.js\":\"32a6d863fb990db2\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-MeESvu5h.js\":\"5e70ac329f529ff4\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server-legacy.browser.production-DBYVWAXo.js\":\"ee14fdc755a1c087\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server.browser.production-CDeaFVa0.js\":\"9136b7364c6673f5\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server.edge.production-BCklAtKt.js\":\"280e247409add9b6\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-ez8-qgND.js\":\"81bff43fd0fa616e\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-ggSJPr1f.js\":\"676644b7d61535aa\",\"/knowledge-medium/pr-preview/pr-1838/chunks/server.browser-jYft8dIN.js\":\"5ffbb52cfd033c35\",\"/knowledge-medium/pr-preview/pr-1838/chunks/textarea-BImtVg5l.js\":\"b770d456b7f8fdc0\",\"/knowledge-medium/pr-preview/pr-1838/chunks/ui-Cg_A69lY.js\":\"fb8781c020f58a94\",\"/knowledge-medium/pr-preview/pr-1838/chunks/wa-sqlite-DBTW7mS-.js\":\"d1b6fb00976447e7\",\"/knowledge-medium/pr-preview/pr-1838/chunks/wa-sqlite-async-Bnw-RiT7.js\":\"90570f8c161ab3eb\",\"/knowledge-medium/pr-preview/pr-1838/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1838/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1838/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1838/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1838/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1838/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1838/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1838/src/App.js\":\"507f49872df39b07\",\"/knowledge-medium/pr-preview/pr-1838/src/appUpdate.js\":\"991083461b3abbac\",\"/knowledge-medium/pr-preview/pr-1838/src/appVersion.js\":\"6c61840d9a53d1cc\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/initialLayout.js\":\"55dc08b1f89f6ba6\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/openWorkspaceData.js\":\"6e74c66c247b905e\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/resolveWorkspace.js\":\"9c815a5624a7cdf9\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/workspaceBootstrap.js\":\"0af6bcfb2798a526\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockComponent.js\":\"c923e343cdae16bb\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockCrumbs.js\":\"2fc79742d8e4f9fe\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockEditor.js\":\"5905dcc965711754\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockLoadingPlaceholder.js\":\"9be74a0e823e5c9e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockProperties.js\":\"ff2767f22b088950\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockSearchPicker.js\":\"d4eb9f7aea458f82\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ConfirmBulkDeleteDialog.js\":\"3954b2393bf9d98c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/DividerHandle.js\":\"a529aa90707b2210\",\"/knowledge-medium/pr-preview/pr-1838/src/components/DraftEditor.js\":\"27f67f2d1c0526da\",\"/knowledge-medium/pr-preview/pr-1838/src/components/GutterPill.js\":\"27fba237164eafa2\",\"/knowledge-medium/pr-preview/pr-1838/src/components/Header.js\":\"849973ea0f3a104b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/LazyBlockComponent.js\":\"322f313ead75157a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/Login.js\":\"cf0d5df769c7d49c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ZoomableSurface.js\":\"a89d1995ed6373e1\",\"/knowledge-medium/pr-preview/pr-1838/src/components/editModeKeepalive.js\":\"2a9dd910df01c5e7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyDisplay/PropertyDisplayScope.js\":\"834dad01baa86693\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1b78d641e3293e8e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/RefPropertyEditor.js\":\"e0cb64522ab34b58\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/RefTargetTypePicker.js\":\"c6e99ae291d5238c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/SelectPropertyEditor.js\":\"7e69cc497a71bc4a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/TypesPropertyEditor.js\":\"b70faa6ef6a1ffbc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/defaults.js\":\"c7c36db4dbf14dad\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/kernelValuePresets.js\":\"d013999c2b80442c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/selectablePresets.js\":\"80f794b61e574576\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/typesPropertyUi.js\":\"c29bd7c931de2a25\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/AddPropertyForm.js\":\"254e275cc384a7a4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/PropertyPicker.js\":\"bbe951bf27770b77\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/PropertyRow.js\":\"c2694c719e017434\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/Rows.js\":\"8c9325df4230e9bb\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/actions.js\":\"1143d521bcdbb3b0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/declarationOnly.js\":\"84094e5224b41386\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/layout.js\":\"4cde83a8371ec0c3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/model.js\":\"a9fc52f06ca8e30a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/shapeUi.js\":\"8f4534ef149e38cf\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/shapes.js\":\"c5c92e1f62e7f6c3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1d45baeba108f7a5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/visibility.js\":\"603f914c99a3ce5e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanelSections.js\":\"e6680e4a2bfac424\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockEmbed.js\":\"96049dc51019d5bd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockLink.js\":\"4cc10d5e76d552bf\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockRef.js\":\"b8e515ae2090ae7f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/ReferenceLink.js\":\"04297afdd9a13a2e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/cycleGuard.js\":\"81aa4beb8f277e1a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/cycleGuardContext.js\":\"7b89b93c9d821d69\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/linkInteraction.js\":\"d263dae1623d68d1\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/referenceLayout.js\":\"0cc22e204e05ac9a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/useBlockRefAncestors.js\":\"71d5f4066d21177f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockGutter.js\":\"4b5f7a41a6777dbd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockInfoDialog.js\":\"74959b1dc6d6d275\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockTypeBlockRenderer.js\":\"62593e3a16c39760\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BulletHoverCard.js\":\"7b8a46611510fcec\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/CodeMirrorContentRenderer.js\":\"11ca1501d1b8f908\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"65b5ecbfe2604ad6\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/ColumnResizeHandles.js\":\"b0252ba22a3dacdf\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"09d9bbb4cba3e175\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/DefaultBlockRenderer.js\":\"02a43a5131d945f4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/LayoutRenderer.js\":\"8e103d255d5456f4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/MarkdownContentRenderer.js\":\"f83deabe31dce7c5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/MissingDataRenderer.js\":\"76683ab48143f07b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/PanelRenderer.js\":\"3f3467da64e0caa8\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/PropertySchemaBlockRenderer.js\":\"21bb8448c974ce1d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/TopLevelRenderer.js\":\"3816ab949fa39603\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/blockGutterMode.js\":\"bc7a53af8b128e79\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/blockTitleText.js\":\"ae0d735881a90f5d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/fieldCreationKeydown.js\":\"dc0e7cce2037a1cc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/layoutRootContext.js\":\"c16c534a7804037a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/typeChip/TypeChip.js\":\"a9368d8d06e35fb3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/typeChip/chipStyle.js\":\"4533929d06f0c283\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/anchored-floating.js\":\"f81bf1eb3bf0d052\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/button.js\":\"92584512e52ff691\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/card.js\":\"332de205eaef7186\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/checkbox.js\":\"16cfc86a1f90e0b1\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/collapsible.js\":\"7734d80889e80be3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/command.js\":\"83cd655eb6add2a1\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/context-menu.js\":\"05f4c61ce548e5b7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/dialog.js\":\"d8b85fd4adc985c2\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/dropdown-menu.js\":\"e4ed08b66587b5cc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/floating-listbox.js\":\"33b89a9288473456\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/index.js\":\"05fb39df2299ec72\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/input.js\":\"5047106307dc56da\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/kbd.js\":\"8c0a471b0464f4a4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/label.js\":\"64c14f7dbc79b406\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/textarea.js\":\"532ff61c88b69012\",\"/knowledge-medium/pr-preview/pr-1838/src/components/useEditModeYieldKeepalive.js\":\"a75f855e76c35892\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/BootFallback.js\":\"1c8e4334c127ad26\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/FocusedRowLazyMount.js\":\"a33961301859d2d3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/LazyViewportMount.js\":\"ae73436be8987071\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/LocalDbCorruptionFallback.js\":\"a8dae04316e48daf\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/error.js\":\"3b457b9f26e66620\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/lazyMountRegistry.js\":\"386ac86ab77c5ee9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/suspense.js\":\"0d1daa319fcd2d17\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/CreateWorkspaceDialog.js\":\"90753d83fdd0e56e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/PendingInvitations.js\":\"0531a73d8a81e336\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/SyncProgress.js\":\"b1fbd92a7671bf60\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/UnlockProgress.js\":\"ae44d7d3233e7d4f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceKeyGate.js\":\"9908755fbe0e9834\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSettingsDialog.js\":\"066bfa6cc28f18a3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSwitcher.js\":\"ff05d5427b761236\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSyncGate.js\":\"132b7123d42ada7e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/ConversionFlow.js\":\"d72af1b10269ed53\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/ConversionFlowHost.js\":\"5e799eb650fa4b55\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/EncryptionSection.js\":\"6f332b4e39c2a00d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/attachmentPrompts.js\":\"28fcd85ec585ac9b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/bundleFolderPrompts.js\":\"27ccc4a37c59f2ef\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/conversionFlowDeps.js\":\"e8f0c0814dc62105\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/conversionFlowStore.js\":\"5c66705a7dd1f100\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/flowUi.js\":\"5f2d792672ffa090\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/useConversionRun.js\":\"15a4c335e79d922d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/keyUi.js\":\"b9e17a68aa8dcbe9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/useCloseOnKeyLoss.js\":\"64ef0479ac3e3327\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/useCloseOnServerE2ee.js\":\"5373b2dc2919fdf2\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/workspaceUnlocked.js\":\"c93e4047583dda2b\",\"/knowledge-medium/pr-preview/pr-1838/src/context/backgroundSubtree.js\":\"195380a1bb5a3113\",\"/knowledge-medium/pr-preview/pr-1838/src/context/block.js\":\"0969f74a65b5ef2e\",\"/knowledge-medium/pr-preview/pr-1838/src/context/layoutWsContext.js\":\"b7f6701c0f11c35f\",\"/knowledge-medium/pr-preview/pr-1838/src/context/propertyDisplay.js\":\"0cfb431d1d75e5e5\",\"/knowledge-medium/pr-preview/pr-1838/src/context/repo.js\":\"d8bc95a4397ba055\",\"/knowledge-medium/pr-preview/pr-1838/src/data/aliasClaim.js\":\"71353a1c71126265\",\"/knowledge-medium/pr-preview/pr-1838/src/data/aliasSeatNamespace.js\":\"2bafccc22af4e3ea\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/blockData.js\":\"8357f9fbfc982ac8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/blockType.js\":\"cdb16347c556a498\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/changeScope.js\":\"e7ecdae5ee6834d5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/codecs.js\":\"39b78ad488063352\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/derivedData.js\":\"aa158a944f551c90\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/errors.js\":\"2959a8a61b8bdee6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/events.js\":\"7260f7587c369799\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/handle.js\":\"77d922cb849fac51\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/index.js\":\"7247ea4f15c153a1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/mutator.js\":\"f2c31672d3fb3be9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/processor.js\":\"0942e2cf23883afe\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/propertySchema.js\":\"903e7a00d0f84d33\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/query.js\":\"b329d39069b75a23\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/sameTxProcessor.js\":\"98dcf802b82018b3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/schema.js\":\"77d922cb849fac51\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/tx.js\":\"77d922cb849fac51\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/typedBlockQuery.js\":\"f06fc32314f9d33c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/user.js\":\"39b1c44ea5eb9f71\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/valuePresetCore.js\":\"42210736dbf00924\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/valuePresets.js\":\"255d5c0f40df0067\",\"/knowledge-medium/pr-preview/pr-1838/src/data/attachmentCleanerIOVerb.js\":\"ed659a08b500a773\",\"/knowledge-medium/pr-preview/pr-1838/src/data/block.js\":\"aef0387067f0205c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockCache.js\":\"63fa5675b55612df\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockId.js\":\"186d82a26a7cb14f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockLiveness.js\":\"95f8c0fa62ed4992\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockMerge.js\":\"981260a00fb35047\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockSchema.js\":\"eecbdebf34b71127\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockTypeLookup.js\":\"8d40d3295ef352fc\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockTypes.js\":\"837c6e17b6b596ac\",\"/knowledge-medium/pr-preview/pr-1838/src/data/clientContext.js\":\"e0f96ddf5f32fddc\",\"/knowledge-medium/pr-preview/pr-1838/src/data/dbFileSiblings.js\":\"2a93125aa5172e79\",\"/knowledge-medium/pr-preview/pr-1838/src/data/definitionSeeds.js\":\"7639e2242cbde3ca\",\"/knowledge-medium/pr-preview/pr-1838/src/data/derivedIds.js\":\"aba4389817314025\",\"/knowledge-medium/pr-preview/pr-1838/src/data/drawnSubtree.js\":\"ff919c61e3f2d4e6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/facetBridge.js\":\"40b4cfc2d7b9fda0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/facets.js\":\"90ca479156198a78\",\"/knowledge-medium/pr-preview/pr-1838/src/data/globalState.js\":\"4f6c80e296b9e7b1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/aliasClaimRederiveProcessor.js\":\"167c2fe6deed3bf2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/ancestorBatch.js\":\"64f15be14654a106\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/blockTypeTypeifyProcessor.js\":\"8e685aed5164cc60\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/clientSchema.js\":\"edf5f8fe306efab4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/commitPipeline.js\":\"645670034324308f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/devAssertions.js\":\"19363410c871a697\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/firstSync.js\":\"6020141d33deb341\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/freshInitialLoad.js\":\"8877c4fc6c7148f5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/graphBackfillClaim.js\":\"2c62816dc00b2fc5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/handleStore.js\":\"5a32c33ac2bd7d1e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/idleMarkerJobs.js\":\"b3a236d453b44bfe\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/initialDownload.js\":\"89e42b9657b72537\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/initializeClientDatabase.js\":\"77f72ba62acf4cfa\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/jsonCanonical.js\":\"ddd96405925684ea\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelInvalidation.js\":\"8bac9be229ecf4d0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelProcessors.js\":\"0efc29a60cb72783\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelQueries.js\":\"687649c34d88f025\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/mergeTypeMembershipProcessor.js\":\"80848c5e32ba1e5f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/normalizeReferencesProcessor.js\":\"9f9f9065f759488d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/poolInstrumentation.js\":\"9c3f6244bd80c7c8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/processorRunner.js\":\"642b1a014f19e7e6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyCellBackfill.js\":\"84c73e797dd4637c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyChildMint.js\":\"fd3169602c47981e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyChildrenProcessor.js\":\"95f6878da67b5d8f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyDefinitionChangeProcessor.js\":\"de7cb22ca8a15201\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyDefinitionSynthesis.js\":\"96269a4c52f67ac1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyKeyScan.js\":\"4abe2e67db4655f2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertySchemaResolution.js\":\"c343d3f5e0eaf23d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyValueEdits.js\":\"e1f0f60ffacdfb85\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/raiseProtocol.js\":\"861ca174c98ec200\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/readBatch.js\":\"44971141765966fe\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/refProjection.js\":\"ce46534222ce2a21\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/referenceTargetLookups.js\":\"5485fa531b2a3618\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/referenceTargetProcessor.js\":\"9f28c7bcddb35640\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/replayMerge.js\":\"c0f6ac9be8306a9b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/sqlBinds.js\":\"f221873b87cf9d50\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8d15c83943f4cf96\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/arrivalProcessors.js\":\"40a2f5487ccdfbc6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/invalidate.js\":\"152d9af2043b91c2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/materialize.js\":\"8458df565f8f5ac4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/observer.js\":\"b23adc8c741be9cd\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/reconcile.js\":\"b30e589b77f8d63f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/timingMetrics.js\":\"6c8a1fc5a849f6c6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/treeQueries.js\":\"0121e12e31ff1f94\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/txEngine.js\":\"046f063cef0c5251\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/txSnapshots.js\":\"dd557a4ff9c650a9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/typedBlockQuery.js\":\"4bcd7c80d67ac3ff\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/undoManager.js\":\"e69c702125cd8178\",\"/knowledge-medium/pr-preview/pr-1838/src/data/invalidation.js\":\"04aa4f1b908284ea\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelDataExtension.js\":\"e7d02a924655a06c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelPage.js\":\"7c9e6e372764ea04\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelValuePresetCores.js\":\"00f870793953bf9b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbCorruptionSignal.js\":\"cb87f7a7a07bef33\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbStorage.js\":\"18f8d7ac97d91d13\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbVfs.js\":\"4e20992f4608b11f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localSchema.js\":\"cdbf1e6aa0b892f3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/maintenance.js\":\"3060402257fe1f6c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/mergeProperties.js\":\"a53f44b60e437ebd\",\"/knowledge-medium/pr-preview/pr-1838/src/data/metricsConsoleHook.js\":\"e370be44ce98d195\",\"/knowledge-medium/pr-preview/pr-1838/src/data/migrationsPage.js\":\"243397feb8af5458\",\"/knowledge-medium/pr-preview/pr-1838/src/data/mutators.js\":\"17c349740f9fe75e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/orderKey.js\":\"dfd277080d899810\",\"/knowledge-medium/pr-preview/pr-1838/src/data/orderKeyPlacement.js\":\"22c229e206b84c91\",\"/knowledge-medium/pr-preview/pr-1838/src/data/outlineSurface.js\":\"db73a79ad3d82208\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pendingEditorContent.js\":\"a80aa375e1d7dc26\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pendingUploadsSql.js\":\"c10102898345aecb\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pluginStateExtensions.js\":\"c13a5b8780103dff\",\"/knowledge-medium/pr-preview/pr-1838/src/data/powerSyncLogger.js\":\"5e1d59e08f5e1eba\",\"/knowledge-medium/pr-preview/pr-1838/src/data/projectorRuntime.js\":\"2fdcd5c0363f2ba3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/properties.js\":\"2d5905d1e2721263\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertiesPage.js\":\"dae3121672b8d426\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyChildren.js\":\"5a31cffba751b5be\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionFanout.js\":\"49681c5f17ca561e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionMetadata.js\":\"d50ad23b6eed8d5a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionRegistry.js\":\"202ad196c176faef\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDisplayMode.js\":\"c565e03831b22864\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyRowCreation.js\":\"63c73e70631ec735\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertySchemaCreation.js\":\"7d478b1c90020371\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertySeeds.js\":\"671ab26a337907b8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/recentsPage.js\":\"040e93270aba6c17\",\"/knowledge-medium/pr-preview/pr-1838/src/data/referenceBlock.js\":\"1b12e2532b64ba84\",\"/knowledge-medium/pr-preview/pr-1838/src/data/rejectedUploads.js\":\"bf0a39a72a4bc0e5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/releasePowerSyncConnection.js\":\"a78fa8f79ec67ae9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/repo.js\":\"d744a2387728820b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/repoProvider.js\":\"1c86dc936f295a4a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/rowProperty.js\":\"02df13ee4cb75df0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/searchFilter.js\":\"a1c08c2f2ce692b1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/seedIdentityLedger.js\":\"9e9015858f296be7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/stateBlocks.js\":\"69394032396a3cde\",\"/knowledge-medium/pr-preview/pr-1838/src/data/structuralEditPolicy.js\":\"6505cda7eb58bcae\",\"/knowledge-medium/pr-preview/pr-1838/src/data/subtreeDelete.js\":\"85b9452f4bb8be56\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncStreamLock.js\":\"43a45606e76dbbb4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncedTableSqlRecognizer.js\":\"2af2902d5874ac2b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncedTableWriteGuard.js\":\"ed38a553b5189b36\",\"/knowledge-medium/pr-preview/pr-1838/src/data/targets.js\":\"dcef6d57dbed7045\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeColors.js\":\"f138d5c91269f93c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeDefinitionMetadata.js\":\"51a1b19281f36d09\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeDefinitionRegistry.js\":\"8649425b3afb66c2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeExtraction.js\":\"3a7eba181fe32fb7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeInitialValues.js\":\"4d03484434b8ca88\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typePropertyGroups.js\":\"c1c704d56d589cef\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeSeeds.js\":\"2e46b2cc39c7dddc\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeTagger.js\":\"955f4b152ca17769\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typedRecords.js\":\"65d0002c4bba1bf8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typesPage.js\":\"32b444c33f64e7cc\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userPrefs.js\":\"ec5d7029ca74f414\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userSchemasService.js\":\"96cae7bc15874409\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userTypesService.js\":\"543310a9425f489a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/valuePresetRegistry.js\":\"5fb548a765e08dd3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/visibleChildren.js\":\"62e7fc2cfd61e7f6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceConversion.js\":\"cb20f3925e1f9922\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceFirstSync.js\":\"d22ba0e9f2220eea\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceIdNamespace.js\":\"cd143061ece718ce\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceSchema.js\":\"b14e8fc714763b5b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaces.js\":\"090f32fc246a516c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/writeAheadLog.js\":\"39ef94ad9d1a5e1d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/BlockPasteShellDecorator.js\":\"775dd87b17109dfc\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/atTrigger.js\":\"6d376e8cddfe09d6\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/autocomplete.js\":\"6971efd1e7d8ab33\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/codeMirrorExtensions.js\":\"6b06998c323010ca\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/contentFlush.js\":\"751f0d869e3ff1e0\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/defaultInteractions.js\":\"b39bb35b210cd5b2\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/editSettleSignal.js\":\"a36ae260799a60ab\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/insertImage.js\":\"17fea1bf8709c306\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/referenceCompletionRange.js\":\"df1e2377082e52b8\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/referenceTargetTypes.js\":\"2f3379f73a983181\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/syntaxContext.js\":\"b31966e6b1d8bd1a\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/triggerMatch.js\":\"0b2841f25952e86f\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/AppRuntimeProvider.js\":\"7b24b19218d3083d\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/BlockFocusShellDecorator.js\":\"870d2293a0b194a3\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/ExtensionRenderBoundary.js\":\"65a41458f54dcdb4\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/PanelContentRecovery.js\":\"c133ae9d56ac3343\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/apiCatalog.js\":\"863aa019221fc9ed\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/approveExtensionHere.js\":\"506e4c279037743d\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/armedCutAppMount.js\":\"16140e91cac1eec7\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/batchableKeyedStore.js\":\"1a7731fd3b1eead4\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/blockInteraction.js\":\"355849a1614dc2a6\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/blockSelectionAction.js\":\"ba133f1c27a3952d\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/compileExtensionModule.js\":\"9a339f7ef9a2a4cb\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/compiledModuleCache.js\":\"630d2a4ae76f43a1\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/continuousGestures.js\":\"1c217eb37a5e61a5\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/core.js\":\"70a15ae93563a94b\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/defaultRenderers.js\":\"acbe710225baf816\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/definitionFanoutAppMount.js\":\"40539feaed078671\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dialogAppMount.js\":\"c7b637e8a845ae25\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dynamicExtensionSeeds.js\":\"9452ac0f6d575d50\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dynamicExtensions.js\":\"dff8e10d7997f079\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/exampleExtensions.js\":\"402af5c445c8c00d\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionApprovalStatus.js\":\"88d916f8cae0240e\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLoadErrorToast.js\":\"da0392d197133311\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLoadErrors.js\":\"2ccf9f83d588c3af\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLookup.js\":\"1f8e4a6e35ebe37c\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionToggles.js\":\"9f4c03a21e60f7fb\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionUtilitiesCss.js\":\"9c0eee47a28cd8bc\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/kernelPageDeletionGuard.js\":\"777f19c9511de344\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/liveRuntime.js\":\"61cc03263106dda0\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/openExtensionsSettings.js\":\"0210b9ef0152641d\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/overridesCache.js\":\"749c559c80516198\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/pluginIds.js\":\"aa52ab13d1e0e26f\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/processorRejectionToast.js\":\"23ab606cd4a44fc8\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/runtimeActions.js\":\"13755713851660f7\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/runtimeContext.js\":\"f5681bddad8ec863\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/staticAppExtensions.js\":\"f4ca7f5d7c7bd1c2\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/staticDataExtensions.js\":\"bbf8e33458d27e29\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/toastAppMount.js\":\"60811849427726f6\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/useOverrides.js\":\"f0a2eda0e268fa83\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/useShortcutSurfaceActivations.js\":\"dd1bf317f4666097\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/discoverToggleTree.js\":\"68c3670a96fa8ce9\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/facet.js\":\"bc53ae909c33e1b1\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/resolveAppRuntime.js\":\"a24b55a38657ab8b\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/runtimeEvents.js\":\"c032c66fe8d482c8\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/togglable.js\":\"1a10c58732628758\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/variantFacet.js\":\"59a16df357d78ef2\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/verbFacet.js\":\"6011fdc1f23bd22a\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/block.js\":\"773fac9ee4957b27\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/focusedChild.js\":\"fd6b556f24e90512\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/propertySchemas.js\":\"23e71bf15fea12b0\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/typeRegistry.js\":\"1d092e140b0976d2\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useAncestorCrumbs.js\":\"fbc4a6234ce883fb\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useAutocompleteListbox.js\":\"648814d570316a40\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useDebouncedSearch.js\":\"49df69a35844a84d\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useDebouncedValue.js\":\"8cf3d570d98270a8\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useIsFocalRender.js\":\"4c6c1714023106d1\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useIsReadOnly.js\":\"9ccde819f85487dc\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useMaterializeBacklog.js\":\"0431ad36ead06eea\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useMinuteClock.js\":\"1788dde8f85e1f50\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/usePanelLayoutProjection.js\":\"c92582e89391811e\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/usePendingInvitations.js\":\"ac343bc5c3278a24\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useRendererRegistry.js\":\"9466d6db35977f8b\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useRetainedFieldRows.js\":\"4f260810e5c41233\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useWorkspaces.js\":\"5942267d35e3b56d\",\"/knowledge-medium/pr-preview/pr-1838/src/lib/utils.js\":\"533bdb08d55e2653\",\"/knowledge-medium/pr-preview/pr-1838/src/main.js\":\"6eadc2c76238267a\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/MarkdownImage.js\":\"cecfe44b1f254565\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/blockSeparators.js\":\"88a17efb9346afd7\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/context.js\":\"71fd0daf70458e7c\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/defaultMarkdownExtension.js\":\"306c0e7033140c67\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/extensions.js\":\"751bbfb76ac02fed\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/renderMarkdownHtml.js\":\"43450497d1c1b591\",\"/knowledge-medium/pr-preview/pr-1838/src/minimal-editor.js\":\"7acb24bab18f4bbe\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/armedCut.js\":\"391779ae683fe36b\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/captureMediaVerb.js\":\"6a638922ffca3138\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/clipboard.js\":\"ac0c6c78bc1be249\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/decision.js\":\"a5468e8282a1e421\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/operations.js\":\"3a27beb772581c35\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/account-header/AccountHeaderItem.js\":\"a0a492c1c4ea0d44\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/account-header/index.js\":\"9af07c82a2f93748\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"20a0fdec88240adf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/askAgent.js\":\"e0404e5f5c5935ed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/askedStore.js\":\"cd72197ca8f5d58b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5eb2b1a9c9f63ad2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/chipState.js\":\"bad7b948a76cb7cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/dataExtension.js\":\"52a4c1528e8aae4c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/index.js\":\"30cad7ff5107bb22\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e074682180dd33ba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/schema.js\":\"23ec81708977ba29\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/AgentTokensDialog.js\":\"12b327905ed595e3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/BridgePairingDialog.js\":\"71c521df061e24bf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/addMedia.js\":\"c96d1315ed8d9084\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/backlinks.js\":\"407b013285fb1c22\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/block.js\":\"a6c296857b422b6d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/context.js\":\"d83ee877d395a563\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/displayIds.js\":\"eb4fe6886c869c84\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/index.js\":\"7f10b29e5fc80a31\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/outline.js\":\"278cbb2427b6c762\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/properties.js\":\"2748dc2c0383c9a0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/refs.js\":\"a6eaf67f7a89c192\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"eb101a2a0fe9de1e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/search.js\":\"5db7a048ada18c73\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/shared.js\":\"e268b3d1369b597b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"19ebf87025b93351\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/text.js\":\"c0e2aff16ff259e8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentWrites.js\":\"fe035ff3193b55a6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/authoringCatalog.js\":\"680f2c20c2993218\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/blockRefTargets.js\":\"4018166808e02b2b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/bridge.js\":\"54759735680f252c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/bridgeLoop.js\":\"f0c98a375e7b5cfb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/changeHistory.js\":\"6f169f3e7f4c8785\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/commands.js\":\"4c094af807363dbf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/commentsCommands.js\":\"d20882eda3179db3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/dataExtension.js\":\"f27fbcb813d9a12c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/dataModelGuide.js\":\"43472e14ce467687\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/describeRuntime.js\":\"8caf75596b59053b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/extensionLint.js\":\"19b07be251d30d2f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/grainAudit.js\":\"05b0d2c1f1dbf95d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/healthCommand.js\":\"bd2c01b89b719a5f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/index.js\":\"a00f3a9455abd344\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/presetIdentity.js\":\"352074caffed8810\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"06b21e67a9251854\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/readMedia.js\":\"13a602ce6fd89ba0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/schema.js\":\"97b058e8a99b2f3d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/serialization.js\":\"02f8aad519ce4af3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/targets.js\":\"a35288015e886b10\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/tokens.js\":\"7c242fc2cad7c4ab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/watchEvents.js\":\"e3fd460cac5d1a25\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/workspaceGuard.js\":\"c36051f77e39095e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/writeCommands.js\":\"ed87cd5813153378\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/AliasCollisionToast.js\":\"43a27a44c3e3825c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/DuplicateNameBanner.js\":\"7556da3fcc3d9ee7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/collisionMerge.js\":\"49c98f7db901738d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/dataExtension.js\":\"5c3979791b8113ca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/index.js\":\"7a02e1bc83d31028\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/mergeCollisionAction.js\":\"991e7d1b34ec6591\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/pageStyling.js\":\"a38c67d1043e867b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/rejectionToast.js\":\"3bc6d416af86cc35\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/syncProcessor.js\":\"648d8964100e3f98\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/actions.js\":\"f97c157855d26546\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/addComment.js\":\"7808edbd742c3e55\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/anchor.js\":\"1b091d92864c2c3c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/anchorState.js\":\"44be706d23455e5d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/commentLinks.js\":\"c4f54f30ea7a99a0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/confirmThreadDeletion.js\":\"68ae895bbce919bc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/container.js\":\"055857fd38893e6f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/dataExtension.js\":\"af995afe4985607f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/deleteComment.js\":\"3168c2347d776e67\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/highlights.js\":\"4be924993792ec71\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/index.js\":\"7a5f41bc38fd2a6f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/linkedCommentsPill.js\":\"8e426e218b30cf4c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/margin.js\":\"0edde451bd7f19ea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/marginSchema.js\":\"4070460426eeab79\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/newComment.js\":\"243c0a5dcfbf24e4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/ownThreadPicker.js\":\"455cfbeff3fabb94\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/placement.js\":\"76c3a8abf6578f50\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/queries.js\":\"732fc022cc69d4d5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotePosition.js\":\"89feabb2c39ff914\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotedIn.js\":\"bb80a507bb762f25\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotedRange.js\":\"c74e39075dcaaf17\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/rangeRefs.js\":\"a00eef0164ad20cc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readHighlights.js\":\"fb5df0c34a442768\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readSelection.js\":\"5e75f5d323a0588d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readSelectionUi.js\":\"ab2cfd4d4df8bb3b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/reanchor.js\":\"17acf2424fc8a450\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/schema.js\":\"bd8dc40568f97acc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/scope.js\":\"f97cc9254269e772\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/scopeThreads.js\":\"939f0c21afeb32ad\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/splitRetarget.js\":\"c5de95d10e47e96c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/suggestionCard.js\":\"d32645d7f9f33ff3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/suggestions.js\":\"18e4f06caa826638\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/summaries.js\":\"ae41fb5e45890a4c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/summaryBatch.js\":\"8a2e77a5123beb26\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/surface.js\":\"07dfee0652f49ff0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/threadNavigation.js\":\"d818308be3c0e3ae\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/threads.js\":\"f88382fbb9256941\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/ui.js\":\"8b3c0ffd9bf82f11\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/uiStore.js\":\"adfd10332d20dbe1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-intents/appIntents.js\":\"5f622b0db5249a0e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-intents/index.js\":\"6897e4f986436b5a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-update-prompt/index.js\":\"092e89be68945d39\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-update-prompt/status.js\":\"19882258505f0273\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c910851e2e94e773\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaBlockRenderer.js\":\"8e0645c47a577ee5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1cc6fb6d2c00076d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaUploadReconciler.js\":\"711446900b4a75a0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetDownLane.js\":\"6ddca73cfbd40510\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetResolver.js\":\"e215d587f827a533\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetUpload.js\":\"49313e1c4b7c18a8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/attachmentCleanerIO.js\":\"e954c68a557d2f2c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e396ce358c057832\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/blobStore.js\":\"0148a86d0ed3fe05\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/byteStore.js\":\"ddb10f13fab09125\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/cleanerIO.js\":\"a9f6609607779f7d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/cleanupAttachments.js\":\"388098cef71ed647\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/dataExtension.js\":\"aae49770a597d645\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/downLane.js\":\"d53f39b18b6bf7b1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/index.js\":\"158822efad901f21\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/insertImageContribution.js\":\"9ecd258e2db0c842\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/laneArming.js\":\"3b111271d69a9957\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/laneLock.js\":\"4ed12a59ea8191ef\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaBlock.js\":\"7d2ae22e7e1c425f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaCapture.js\":\"f7a64bce66f155b8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaViewers.js\":\"f2fa336fa593439e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaViewersFacet.js\":\"e096f11de6a6f503\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/pasteCapture.js\":\"1fca351860e94805\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/resolver.js\":\"1580657a6d08b267\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/retryUploadsAction.js\":\"7cd2ca1624fdb007\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/storagePaths.js\":\"e6818388266dbbcb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadDrain.js\":\"e57799d3cf2d944d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadLaneStatus.js\":\"88ec30e86eb87e80\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadReconcile.js\":\"3cb83f67cbc0b703\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadRecovery.js\":\"dbc3ec3594e4199f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadStore.js\":\"df6c12a061146078\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/useAssetObjectUrl.js\":\"bc2b447373e7f72d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e6486d014d80430a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/BacklinksViewSection.js\":\"12ec7478d9e61a3d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/facet.js\":\"a8c119abf0778644\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/index.js\":\"20cfdcc258047a2f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/prop.js\":\"cb9995e97165a450\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BacklinkFilters.js\":\"dc37ec73cf613191\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ba1fb17179f26a4d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BlockEntry.js\":\"f5eaffced00fa730\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/LinkedReferences.js\":\"fa7f94bc1595494b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e1b31670cd834187\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/dailyNoteDefaults.js\":\"57a6de322b5ce046\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/dataExtension.js\":\"b3c4c1e57be01fde\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/edgeExclusions.js\":\"1fc50d40259923b5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/filterProperty.js\":\"eced90d269e9acdf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/index.js\":\"68a327af6e95dbbb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4f4dbcfc6ed092ed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/applies.js\":\"0ab95bf584d7d910\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/countQuery.js\":\"0266eddb3607c121\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/expansionStore.js\":\"bdfaeb81212879d8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/index.js\":\"107ee960a35d65f4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0f22d93bfd95d423\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/presentationInvalidation.js\":\"7deffca3d9a5bfcf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/propertyEditorOverride.js\":\"3e168825efe37bd3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/propertyFilter.js\":\"1727743e67d30ad8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/query.js\":\"40eb69bb4937d5bf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/resolveFilter.js\":\"265115fdce670ea0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/sourceBatch.js\":\"deec11aadd9014cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/sources.js\":\"135251c973730402\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/useBacklinks.js\":\"116cf56fb35d9330\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a1714fd83c26a7d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/BirthdayCelebration.js\":\"5de902ca93bbd4d3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/BirthdayOverlay.js\":\"8c6f00b13852b4c0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/gate.js\":\"068f2e678ce1d813\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/index.js\":\"6b0df1bd59eafc68\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/wolfTheme.js\":\"e8aed853533f2a24\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/BlockDragLayer.js\":\"4f8d8d44e71846b2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/dragController.js\":\"a41688a7080cc0f7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/dropTarget.js\":\"2b103ba656bd1010\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/index.js\":\"84ec4790687cf9ed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/projection.js\":\"d287045c4ea508f0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-info/BlockMetaCard.js\":\"7f934e1004027812\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-info/index.js\":\"00b759477c1d080c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/AddTagDialog.js\":\"0da8b688f67ffb3c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6071bcc8c8221c19\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/TagNameIssueHint.js\":\"dcc8bfd973961c07\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/addTagAction.js\":\"8142d1a01da393dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/appendTag.js\":\"a3cd40354953e175\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/config.js\":\"294dd39510c58bbd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/dataExtension.js\":\"fb094c2365a05197\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/index.js\":\"ee1a10a996e5ca5d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/propertyEditorOverride.js\":\"a15c9c06355c5525\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2a0d6d9141c28e50\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ea5b307c8ce78641\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/Breadcrumbs.js\":\"de07ce09672ffffb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"d6a581dfbdd4553f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"dbd05823e2cdbb8d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/index.js\":\"46b94f6a995440bf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5fc7154bce36ae0d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/CharacterCountItem.js\":\"54ad894b19770df6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/ProfilePropertyEditor.js\":\"8556e71fd849d681\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/actions.js\":\"ec49daff4b9e50e0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/blockType.js\":\"6a03acab71b01c48\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/charCount.js\":\"a399989f29f4f6af\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/dataExtension.js\":\"7b7e866417a352ca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/index.js\":\"df7ea0b466ca6764\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/profiles.js\":\"e2fb0d9fb4e696f7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/properties.js\":\"af5c8e1e748ee043\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/textCounts.js\":\"9fa9f71c55f3640e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/colemak-keybindings/index.js\":\"6e5e8361f991bfba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/CommandPalette.js\":\"ed3d3a4721ff744d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/HeaderItem.js\":\"3deb8f7e1bf2d5f9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/context.js\":\"bb69dfae785cbe2c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/index.js\":\"f1670a5041694bb1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/selection.js\":\"bdac66ed6eb59c07\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/toggleStore.js\":\"0b71a66f3906ce55\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/useCommandPaletteActions.js\":\"e74d82433caab595\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/ContributorBadges.js\":\"7d30d44919394394\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/author.js\":\"4a2eca727cad9da0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/codeMirrorExtensions.js\":\"535fffd5cebaf24e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/dataExtension.js\":\"f4765150910492d8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/index.js\":\"6b63e5e92a54298b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/mentionAutocomplete.js\":\"7fc3ac1d0a8d26b9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/processor.js\":\"62b91e1aee3990c8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/profiles.js\":\"caccc0fa815280d7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/queries.js\":\"3ab19ea76c776ce5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/schema.js\":\"aead0ebd9356c3f0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"76a3f1db5f06fccd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c76d127357f17920\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/index.js\":\"dad053dc8bd29776\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ca060786b487b399\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"529ce15154d2d5b1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/CalendarGrid.js\":\"c5dcd5879f61f764\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DailyNotePicker.js\":\"f03387f4d6146f09\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"de84c59a2e6892db\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateNavDecorator.js\":\"9aa2f67b24c61d97\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateScrubOverlay.js\":\"723c3df3379c2eef\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/HeaderItem.js\":\"2cfed189b62c0522\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/ReschedulePicker.js\":\"4e5a1ca03a3cd482\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/SpreadDatesDialog.js\":\"267c6910ede562a1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/actions.js\":\"6b90f3863b6b80fd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/blockDateAdapter.js\":\"e0eabea4d9a51461\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/calendar.js\":\"10c0070542e34bda\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dailyNotes.js\":\"876fb1c7143e714e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dataExtension.js\":\"37972ceec5da5014\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubActions.js\":\"2a49eab186925e7a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubGesture.js\":\"d7a94b131f55e386\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1ea5a936d775fd70\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubRecognizer.js\":\"5cfd461eaab855c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/deletionGuard.js\":\"15858ede745b576c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dueQuery.js\":\"d5de19605e606d36\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/index.js\":\"209522b8247dc270\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/landing.js\":\"7f9d814aa2951359\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/localSchema.js\":\"dec1556247e89284\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/referenceDateAdapter.js\":\"5a8c598f12ce5fb6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/rescheduleAction.js\":\"5a294526f1e22de3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/schema.js\":\"1986155f022043bb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/spreadBlockDates.js\":\"9776a8771e484ce4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/spreadDatesAction.js\":\"fb575e70ca07923a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/today.js\":\"eba348a3daffde42\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"33c820462c4b7bb1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7b4197657ae62f55\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/audit.js\":\"f7a640adb8ebbbd8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/auditAction.js\":\"1c0f9dd1d0ab79b2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/auditRanges.js\":\"1f5271fbaab63eb5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/diagnosticsSource.js\":\"f18077b8763c3216\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/divergenceScan.js\":\"5d88223114d4c9dd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/index.js\":\"58303896d27e0b8e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/propertyChildrenChecks.js\":\"db84fc4f296d2092\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/referencesMirror.js\":\"8c1ccb99dc33bcd7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/rowJson.js\":\"c3cfc1eae4c12fea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/schedule.js\":\"c2c6090cca63de4d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/store.js\":\"f38e299e77538498\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/action.js\":\"b1a26121e7a17cda\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/index.js\":\"37c63d49d42cf6d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/plugin.js\":\"d2cbda012adc9ece\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8da756368524c878\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/actions.js\":\"f91ea0c3a93db5e7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/changeMarker.js\":\"5c314ec90d33458c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/diagnostics.js\":\"00603be5db289253\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/fileSystemAccess.js\":\"92dee1f81f2d01ce\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/filenames.js\":\"e837fc6c1f722c57\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/index.js\":\"84d4d36afe4910fb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/mirror.js\":\"d4b726413920bbc6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/runLock.js\":\"e19998018d8f4537\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/runtimeHealth.js\":\"b7c6521347e0948d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/schedule.js\":\"528aedc603135e47\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/store.js\":\"cf40fa0d391335fa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/default-themes/index.js\":\"e36f17ae464b30af\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/default-themes/themes.js\":\"213f958d6e79739d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/diagnostics/facet.js\":\"c323e479379649a8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/diagnostics/useDiagnostics.js\":\"de84738f09c3a576\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/dismissals.js\":\"18e4ed5242128da8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/index.js\":\"2e21455e2633bd91\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/status.js\":\"de1710d2b1093302\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/store.js\":\"c74bd7798b283226\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"09572bfea94f5eb6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7efc416568e253e5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/actions.js\":\"d0b6ff9361b676ca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/config.js\":\"266ea306b63d5418\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/dataExtension.js\":\"b752d8f9c0668c89\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/effect.js\":\"edae9264438b7c64\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/index.js\":\"5805f39da66c4c24\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/propertyEditorOverride.js\":\"474907335422f298\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/useToggleTree.js\":\"8dcf8dbb9ba0afc8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/ExtractTypeDialog.js\":\"87858a52087a7382\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"21dcff0b728ae780\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/PropertyShapePicker.js\":\"f38dbd5b93fcb1aa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/action.js\":\"395add2b55716b8d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/index.js\":\"91ba856daad3bedc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/FindReplaceDialog.js\":\"f50415206a81f85b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/HeaderItem.js\":\"29fec64c34abb95d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/dataExtension.js\":\"5e8e434dd34482dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/index.js\":\"97dfb310993d12d9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/search.js\":\"d2c26f59e3f576f5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/toggleStore.js\":\"db0afbf1ea9030c5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/LocationPropertyEditor.js\":\"5d5512a90589d1d9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/MapView.js\":\"ddaa45c762c15808\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/blockTypes.js\":\"50e9a8274459afc3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/codeMirrorExtensions.js\":\"9781edf791c96296\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/createOrFindPlace.js\":\"4f47de5450df982c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/currentLocation.js\":\"774e707aea7c4dcf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/dataExtension.js\":\"5ec2632f1957b192\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/geoContentDecorator.js\":\"be7d38ba5ded7a5a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/googlePlacesClient.js\":\"ea59293ac918367e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/index.js\":\"ed305704945e7a85\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/locationsPage.js\":\"32cce9bdf0df7b6c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/mapViewport.js\":\"904ab2c4ed692270\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/pickCurrentLocation.js\":\"64f807752df0dafa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/placeAutocomplete.js\":\"bbd373be24308e51\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/placeNameCollision.js\":\"c80bf3b4bc20f76b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/properties.js\":\"9b7e3c14eb605538\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/propertyEditorOverrides.js\":\"c21ef1de351553aa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/query.js\":\"c102b4866376a305\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/usePlaceSearch.js\":\"b340ea10eeb12e53\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d564b020b337e02c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d2836fc95426c0d0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e63d7a5db63a1ffe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/config.js\":\"d037b6f67305a229\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/dataExtension.js\":\"519abdcba30336be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/facet.js\":\"6f7c107df324a3a0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/grouping.js\":\"ade6ee0742359b05\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/index.js\":\"2003e3d23b51c74f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6cc0c14ee6571bfc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/query.js\":\"9a1a10ef6d07f994\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/resolveConfig.js\":\"10f63bde4da1ba89\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d3458a31307b0faa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"749931fec15e948b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/HtmlDocumentContent.js\":\"ad12ed0e26d15d87\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/HtmlFrame.js\":\"f89ef89b397f8dd2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/actions.js\":\"0b9c9969a34a9c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/blockType.js\":\"7a2c16199a2c7a79\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/confirmRunScripts.js\":\"b787905ac1d1148e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/dataExtension.js\":\"fd019c095583c4b6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameAnnotations.js\":\"ce9a27bb5030a770\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameDocument.js\":\"c8a22eda096d46e5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameTheme.js\":\"74c746f03cf9450f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/index.js\":\"3ff07a54471dbe2f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/scriptConsent.js\":\"87ff6db4141f1d24\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/sourceMap.js\":\"64865de5ef965eaf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/useDocumentScripts.js\":\"11c8cd46cdb14bdd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/index.js\":\"4f6547a5e8eb71df\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/record.js\":\"c4c8596de8f67a7c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/recordStore.js\":\"0b79cc83045f6be4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/responsiveness.js\":\"bfaa3bab1c50b2f1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/schedule.js\":\"1934b697fbf62f89\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/sessionContext.js\":\"b466de4c8a61c1f4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"355c2a42d0f2de73\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"fb8612c11b4afa68\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/actions.js\":\"0f5bbe176ac7ea2e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/config.js\":\"abfc3846851ec9d7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/dataExtension.js\":\"e2a012f733e6571e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/effect.js\":\"234a6d1f38d896e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/index.js\":\"7e64794254b62301\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/keyCapture.js\":\"9477a2da86823f72\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/overrideStore.js\":\"7426febf84765072\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8c5e97760cfb3249\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/HeaderItem.js\":\"0dd21249805cee1d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/LeftSidebar.js\":\"225e6ad648f377cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/actions.js\":\"c1d81bcc7bed5871\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/facet.js\":\"b2aeac8ccfb36e49\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/index.js\":\"8e62eea76bc91bae\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/shortcuts.js\":\"fdb9b40f9c70856a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/toggleStore.js\":\"049f6f2f6e1f1ab3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/MergePicker.js\":\"e3c1be0a6135a186\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/index.js\":\"fe26b3e08b721fa6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/mergeAction.js\":\"e3b958e4b56483da\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/strategy.js\":\"b99509ce94693045\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/Button.js\":\"fabbcfbf5e295c48\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a41972f89e3d25bc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/defaultItems.js\":\"c02ccb6c4ef455b4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/facet.js\":\"0c6d9c1a7d5ef106\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/index.js\":\"1abe392d8177c188\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0c3c04f6adae4dc8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ab61c77e209a644d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ff181e6b70fffa34\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4676a04ab7b4d55a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/index.js\":\"7b283eccdb617977\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/MoveDestinationPicker.js\":\"78902421cae18bfb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9969b7f60562018f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/contextMenuItem.js\":\"e1f652def3a78e5c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/index.js\":\"1010e2ba9530b105\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/moveAction.js\":\"cde092e2d521b8db\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/moveBlocks.js\":\"8c6f08e37b7b17bd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/selectionAfterMove.js\":\"e683aab174027875\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/TutorialBanner.js\":\"ba04055c997519a1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/action.js\":\"1e8bb2c8b26c0bb7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/bannerDismissal.js\":\"05dd46068c02c46c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/documents/cheatSheet.js\":\"7c1052263559deda\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/index.js\":\"b45c5cdfc0419fdb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/keys.js\":\"61fad0f3a6ccd55b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/landing.js\":\"c16f50d46344cd62\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/outline.js\":\"afbf7964ac146b88\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/seed.js\":\"204b946dac8dd3cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0fb2556790555d09\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/analyze.js\":\"8e3586dcaea1ae04\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/diagnosticsSource.js\":\"ffbd849dc7d07296\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/index.js\":\"54d30a7c6c85dfc0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/load.js\":\"55c80828d95778ae\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/monitorRun.js\":\"574145ae0a35cf06\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/schedule.js\":\"91f942299182cb8e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/series.js\":\"9e25fe0756ec05c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/store.js\":\"346da85806a6a8b3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/trendAction.js\":\"b8df321fdce64de4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/verdict.js\":\"7245dceaf9c2f3d8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/clickToEditAction.js\":\"f46b3ce1f7be5495\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/index.js\":\"44684bd738a76545\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/interactions.js\":\"52ee70d201ededed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b0155af6000fcbda\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/MigrationGate.js\":\"9eb7a21beb8a4f54\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/MigrationGateDialog.js\":\"756513f0af9ac99e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/action.js\":\"9d196f51e6e61d0e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/index.js\":\"c5204bfb5b4c0acd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/localRunMessage.js\":\"ef4f090dbbd9c583\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/plugin.js\":\"d4f06618c431914c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/progressReport.js\":\"3294008244e9988e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/sweepProgress.js\":\"fda2f38647a0ee33\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/FieldRowRenderer.js\":\"0f67d9b5b2cd5316\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/ValueRowRenderer.js\":\"e87d0921519ce66c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/actions.js\":\"016dad6767b4f65a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/autocomplete.js\":\"3a91ff416cfddc03\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/fieldRow.js\":\"1e3f102b6241dd31\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/index.js\":\"f76101000a22a833\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/referenceWarning.js\":\"1cccc2ffbc108a39\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/valueAutocomplete.js\":\"51d0c291aca97364\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/valueSchema.js\":\"75086925b1210efb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/HeaderItem.js\":\"b034accf79de3dba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/QuickFind.js\":\"6fe2a9e8e4cd8948\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/index.js\":\"8165a1a63782801c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/recents.js\":\"b47ea94f41c0f096\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/resultItems.js\":\"25786f35b827db22\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/selection.js\":\"5159b8c92630fd45\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/toggleStore.js\":\"8acd240c995b2bca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/HeaderItem.js\":\"45c96cdfbf590ce9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/RecentsPageBlockRenderer.js\":\"57d0258f5e44cf73\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/grouping.js\":\"4cab89cdb924cd8c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/index.js\":\"297ea3c6f627de3f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/target.js\":\"d66147f6f3c9531e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/codeMirrorExtensions.js\":\"5022a77b1362b1f5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/contentPrefill.js\":\"a1dea282857c3a2f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/dataExtension.js\":\"3546d33c2c3f24b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/index.js\":\"51b1c89951b6efcd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"862b22dab5c93df8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/invalidation.js\":\"1afdb48d04145095\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/localSchema.js\":\"15c6feebd604da96\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/blockrefs/index.js\":\"7f8398f81e026eb7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6fea3e3c2d6bbece\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/index.js\":\"a6ebe7752f6508ec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/referenceNode.js\":\"943e7f7c616f5abe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/remark-reference-occurrences.js\":\"3b7ab13f631ba8e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"eb8cdf4ad191371b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/index.js\":\"0cc9f7ef677253ec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"386f785d3f3c1ece\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"cfd0ee149ae61b57\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/mergeRetargetProcessor.js\":\"25dc76eaa93a218f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/parseFence.js\":\"809c6621a1d2ce30\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referenceParser.js\":\"345cedb44a1e74f6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referenceProjection.js\":\"16623545d290a4b6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referencesProcessor.js\":\"8bf12fc76cb59d66\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/renameProcessor.js\":\"856075399469cc75\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/spanReplacement.js\":\"6474b2dc90ae33f5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/htmlToOutline.js\":\"ab414a8533dda5fe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/index.js\":\"0025448e4f6a1e3b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5958b65757cf489e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/pasteDecision.js\":\"4dd24719c98511e9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/action.js\":\"de77f3e6e0812fbc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/blockIds.js\":\"a7be977ddea0d159\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/content.js\":\"804911aa899bf4c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/effect.js\":\"cd355b1046b32094\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/ids.js\":\"14e8b4fb4cd33732\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/import.js\":\"1203a6dd022f3c3b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/index.js\":\"d6ed8ad5226d510b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/plan.js\":\"6d9a52bc870f6a1b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/plugin.js\":\"518608b9b88bece7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/promotion.js\":\"7e6c7a01fb98b7a0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/properties.js\":\"cd23e9a36a0b8bc8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/references.js\":\"87d7f9e486f69a1b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/report.js\":\"cae7cff4d8c74712\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/roamMemo.js\":\"e3a7bdc39725c00e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/runtime.js\":\"4869b6251109a044\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/schemaReconciliation.js\":\"2034071e6cf59293\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/srsMarkers.js\":\"cb6925b5186c56d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/todo.js\":\"f5ffda2f8faded17\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/typeCandidates.js\":\"be6fd8d8bb6d7441\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/types.js\":\"577540f32472710d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/search-health/index.js\":\"897a66eaf3241d17\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/search-health/store.js\":\"0cee13089bb793b6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/HeaderItem.js\":\"0bb8a263562a3a2f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ad8d52c361b530b1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/index.js\":\"9e657a4a152341d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/model.js\":\"c0b63d5ea259e70c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/toggleStore.js\":\"c27d6a1dff2d1fb3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/useKeyInspector.js\":\"24df30f636f81f57\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d62ebcda37966abe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/ShellDecorator.js\":\"6adce590b4464932\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/actions.js\":\"9c77757687cb8d1b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a221d434528425ef\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/index.js\":\"0547ecc4962dfcc5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/shell.js\":\"94cb718f0302f948\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/surface.js\":\"1c180dd86286cd6e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/walker.js\":\"205a2363eca4df7f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3c68fe2d02852580\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/dataExtension.js\":\"1a410dd3f18c204f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/index.js\":\"70a2f36ebfd48571\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/indicator.js\":\"5fbd26b8d5c06296\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/moveSrsState.js\":\"8063660dde8c43c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6540cd4edfb650c7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/scheduler.js\":\"c133095a0cd7b75d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/schema.js\":\"b866301f416f0374\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3a86a5b28c8a89ac\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/srsClipboard.js\":\"e274d5da8b24a87a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f653c21b3eb93814\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2d6c9dded170a44e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/DeckPicker.js\":\"e86317e8804c67ca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewControls.js\":\"91c9c298d024bbe0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewDeckRenderer.js\":\"700fd3d87d29beab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewSession.js\":\"a587ed778de35268\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/actions.js\":\"747218042bc3fcad\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/archive.js\":\"61b4163129e65f9d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/dataExtension.js\":\"94b95dbfd8144466\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/deck.js\":\"c5fda12e603d8bc6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/dueQuery.js\":\"8458387f595fdeea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/gradeDecision.js\":\"09eec51ff82b07a5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/index.js\":\"0499ddc2efa6bb46\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/keyHints.js\":\"c0552d355eb58ab8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/reviewCardLayout.js\":\"c9446a60c03f1cb4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/reviewProgress.js\":\"e2d5078308a33062\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/schema.js\":\"7e977de9cdbe0b42\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/useDueCards.js\":\"10f2c2453a8cf841\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/startup-metrics/index.js\":\"ca1f2845bb0f58ea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/startup-metrics/record.js\":\"e7a0ce9e2cd4a443\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/index.js\":\"5527b71d505fbd14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/persistenceStatus.js\":\"4caeb20bd7c69d01\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/requestAction.js\":\"e5379cdfa77386b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/TypeChipsDecorator.js\":\"69dbbdb9bb35659c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/codeMirrorExtensions.js\":\"721c226a20d8c69b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/index.js\":\"e125ec3d374664a2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/typeAutocomplete.js\":\"6273701cb2fea65c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"30afded8eeb5e3dd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/actions.js\":\"485dc044da28301d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/anchor.js\":\"e6fe58e9dfd2f4ac\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/events.js\":\"c39fc71ba1c41298\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/gestureActions.js\":\"618305fcd62d8cd9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/index.js\":\"2437d9aa5baff2e0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"468d00318dc20bc4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/collect.js\":\"a179ba4b8a8caa1d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/index.js\":\"c88793a365e18bab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/record.js\":\"b8ec70f664f6a631\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/RejectionDialog.js\":\"cbb0086c4e0820bf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/SystemStatusHeaderItem.js\":\"59db2501056d04be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/index.js\":\"9bf0d371d1e7a7ad\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/model.js\":\"cb792887d8bee56d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/queueCounts.js\":\"87f064e0c87875e5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/rejectedHelpers.js\":\"1e0e0313d0170859\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/rematerializeAction.js\":\"8b1a6b22fa46683f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/useHysteresis.js\":\"d267d9f530373049\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/ColumnHeaders.js\":\"40fa84b25eb9a403\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/QueryUi.js\":\"cac5c16fe0676947\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/TableLayout.js\":\"d0a61f364cd7e62b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/actions.js\":\"2688a334a7afdf40\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/cellEdits.js\":\"5bc9b7fce2f0c98a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/columns.js\":\"17852baec5cc1a23\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/controller.js\":\"986ca9e2bca2081e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/convert.js\":\"8bcb120f8d2e30ae\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/dataExtension.js\":\"99891a3567aa1cc5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/index.js\":\"98cca3b0b3adf96c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/keys.js\":\"2a7b6ab943bdf8d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/model.js\":\"c65efa9cfa411068\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/backfill.js\":\"b3889dd290ccd3ae\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/format.js\":\"689ded27590240e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/parse.js\":\"808527344c7f67b0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/queryValue.js\":\"cfb4512d82c1e4d7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/source.js\":\"8a6f26cf1a426ceb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/registry.js\":\"d28881d336e6b464\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/schema.js\":\"1533ab18dd7a6065\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/sort.js\":\"f85d0e5c24d9153a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/effect.js\":\"2537395239cc9037\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/index.js\":\"b0709efdd6c24575\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/theme.js\":\"c76f235bbed7913a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/actions.js\":\"fa85d2bf530a227a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/dataExtension.js\":\"3fb2a3a5a0f7f836\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/index.js\":\"8816620c4ba3643e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/schema.js\":\"1c978ccd1aa95eed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b3477c965da3e207\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/actions.js\":\"4906706f2162cea1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/defaultItems.js\":\"f1669efb82a5d34b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/facet.js\":\"3c3cccd1391259b2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/holdRecognizer.js\":\"f9f5231eb9e4f792\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/index.js\":\"a1f7a14f6ba49c6c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/UpdateIndicator.js\":\"add21480c14876b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/index.js\":\"0619071897d4e056\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/loadTimes.js\":\"94596fb385bf9d7a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoNotesRenderer.js\":\"0a401b0d272e635e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoPlayerRenderer.js\":\"69b12443fc283105\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoTimeStamp.js\":\"254ffd3a4040c128\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/actions.js\":\"bb7b1110425cffd9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/index.js\":\"9cf46b9c0fa0786b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/markdown.js\":\"25b20c38b42ed4aa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/notes.js\":\"7aac12e58cd13e25\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/registry.js\":\"9a74332a5b483a2b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/remark-timestamps.js\":\"3a5e49d9cc6ab11b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/view.js\":\"cc02077c5a49385d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/LinkHints.js\":\"41ab270ee4c3f59d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/index.js\":\"9535a8d1f083a48d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/model.js\":\"bcb1a9c867cc9f3d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/settings.js\":\"137102fd03bfa8a1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/actions.js\":\"52981ed9e5d89f9b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/index.js\":\"dba2b671aa316e06\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/interactions.js\":\"a2459dc6ce5d34b1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/workspace-header/index.js\":\"754fcac8b295bf43\",\"/knowledge-medium/pr-preview/pr-1838/src/registerServiceWorker.js\":\"deb3d4556d98468a\",\"/knowledge-medium/pr-preview/pr-1838/src/requestPersistentStorage.js\":\"f164bb6d264d7f76\",\"/knowledge-medium/pr-preview/pr-1838/src/services/authRequestDeadline.js\":\"19f6bf6d95e1eef9\",\"/knowledge-medium/pr-preview/pr-1838/src/services/authStorage.js\":\"96426fc73c02f469\",\"/knowledge-medium/pr-preview/pr-1838/src/services/powersync.js\":\"916139731cad0737\",\"/knowledge-medium/pr-preview/pr-1838/src/services/supabase.js\":\"a84f01900ab09a28\",\"/knowledge-medium/pr-preview/pr-1838/src/services/uploadErrorClassifier.js\":\"ac44164f9436bf5e\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/ActiveContexts.js\":\"ce8f39b3352a1c70\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/HotkeyReconciler.js\":\"49f5c1c7ea3edaf6\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/WipeLocalDataDialog.js\":\"b449287397306665\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/actionDispatch.js\":\"1388733bfa8eb091\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/actionRefItems.js\":\"421186514ad058a1\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/applyKeybindingOverrides.js\":\"f13a9926d1c5907b\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/blockActions.js\":\"7e899e25fb05d5d5\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/canonicalizeChord.js\":\"9e11581f8eb470ec\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/defaultContexts.js\":\"ae9e23b1ae2cb773\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/defaultShortcuts.js\":\"4886e3b43e0d206f\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/effectiveActions.js\":\"e43f7016f4652f48\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/gestureAction.js\":\"1fe5349407304436\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/gestureBinding.js\":\"2c590ff115e2dc7c\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/holdRegistry.js\":\"b2dab9ad3eb3e290\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/keybindingConflicts.js\":\"0364d3075372aaef\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/keybindingOverrides.js\":\"7f64e34f8e08c589\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/pointerAction.js\":\"382d0b23812164c9\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/resolve.js\":\"a65798c3626bfe19\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/runAction.js\":\"5719b9c2801524cb\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/sequenceMatcher.js\":\"4f5b8a9aacb02952\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/types.js\":\"40fc6a240ef35efa\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/useActionContext.js\":\"22c3da9ce70ae696\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/useActionDiscovery.js\":\"d30f5d311e509221\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/utils.js\":\"4b71f5a0738556ff\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/bootStore.js\":\"978e4313bb1345f2\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/previewDatabases.js\":\"7be5ea04a9bf25ed\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/byteTransform.js\":\"4ce1eb66a9040eb3\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/attachmentCleaner.js\":\"b66b2882fee26081\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/attachmentParts.js\":\"ac77e8833c4967d9\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/bundleParts.js\":\"e14841f9dd21629f\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/bundleRecord.js\":\"71618b23325657c1\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/manifest.js\":\"a8cd7fea40d55dee\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/takeBundle.js\":\"6b8dab7ad3206a51\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/verifyBundle.js\":\"24e563094077ed22\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/cleaningStage.js\":\"b416f290946814b0\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionKey.js\":\"a40d795bd0d1fe0d\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionServer.js\":\"48fb342029396b5e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/flip.js\":\"2ec95b2a6c79756d\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/flipAttempts.js\":\"c6470271f9b7a09d\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/pages.js\":\"e5eed288a7acd627\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/preflight.js\":\"2fed3584ca29c1cf\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/reseal.js\":\"cb92c50eb1f628f5\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/runConversion.js\":\"0ee5fb6e8ae0e80e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/runLock.js\":\"e46b3156f43e80d8\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/sealing.js\":\"23870f4150b75789\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/sealingStage.js\":\"59790efc35573bc1\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/stage.js\":\"16da2060cb0bb315\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/verifyReseal.js\":\"8e18767d3ff75364\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/aad.js\":\"67e479997aefd768\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/aead.js\":\"1882eab359adaf02\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/base32.js\":\"367ee5ab0471f1ad\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/base64url.js\":\"0f70458ec5af771e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/binaryEnvelope.js\":\"e365030cb37d7450\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/byteAead.js\":\"faa3dec0865c816c\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/canary.js\":\"c821acca1e6ac2e4\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/contentHash.js\":\"16a934b746ffd637\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/contentKey.js\":\"11dd46d8f2069687\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/derivedIdNamespace.js\":\"39d9cedc94b3b4a4\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/envelope.js\":\"c306d2ecb1ece171\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/hex.js\":\"ee1ca0e7fefe4bca\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/sha256Hex.js\":\"e9ced9b162b9d8ea\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/workspaceKey.js\":\"43795cfc7e7acff8\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/conversionState.js\":\"ee596ab0dbff7155\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2570efa0777e6a21\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/pastedKey.js\":\"95e3554782fed1d8\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"948ef90191b02fa8\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8c8c7a37db15c30f\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/keyStore.js\":\"b988c4f823a1aefa\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/mintWorkspaceKey.js\":\"73b874f90add7a21\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/modePin.js\":\"a189704002169fa0\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/openWorkspaceKeys.js\":\"6cee788e48fd44ec\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/resolveWorkspaceEntry.js\":\"253577e693534f67\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/resolver.js\":\"a0d15dd2f869f152\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/workspaceAccess.js\":\"3e4838f3b0d36eb4\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/transform.js\":\"b732085df93755b1\",\"/knowledge-medium/pr-preview/pr-1838/src/themeBootDefaults.js\":\"abe8a28f1ff4c8b6\",\"/knowledge-medium/pr-preview/pr-1838/src/types.js\":\"bdf23617f2c82564\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/ClientLocalSettings.js\":\"20428714d39b80cd\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/abortableSleep.js\":\"23aeb443d8a6e8b0\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/array.js\":\"e1e40fe49e4633d1\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/backlinkAutocomplete.js\":\"2ec9c1861b972866\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/blockCrumbs.js\":\"5b983d8e363cc998\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/blockrefAutocomplete.js\":\"a96e39e756893594\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/cadencedIdleJob.js\":\"c19f0778661cc277\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/callbackSet.js\":\"d385888f230c99a1\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/clientId.js\":\"424aae1d148bf569\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/codemirror.js\":\"2b99e19a97807470\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/codemirrorCompletion.js\":\"2dc139a1124f7698\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/copy.js\":\"d5b8676efa467a32\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dailyPage.js\":\"662cdb6a9d0668c6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dbForensics.js\":\"ec9054b162a11aba\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dbForensicsHooks.js\":\"507fda8d20e8f516\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/deleteBlockThroughUi.js\":\"7a89d95a8ad71089\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dialogs.js\":\"8854451e26a01565\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dom.js\":\"e49bae501ec185be\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/downloadBlob.js\":\"b9c6d9617aa20f48\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/exportSqliteDb.js\":\"656156190bac0b3a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fileSystemAccess.js\":\"8ee4a5ba196ad742\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/flipSlide.js\":\"5468ab7d9d89acdc\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fnv1a.js\":\"eb172aec481b0186\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/formatBytes.js\":\"10c6b4aa3a8dc101\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fuzzyRank.js\":\"56a9c22a0c1559db\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/idbKeyedStore.js\":\"03a4346e704d504d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/idleCallbackPolyfill.js\":\"211b0bae3b8928a8\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/keyboardAwareScroll.js\":\"24e24fac20fab1ce\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/keyboardViewport.js\":\"5080fdaa51bc988f\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/lastWorkspace.js\":\"905e0e4a13ad270d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutColumns.js\":\"bafbed0b1a063068\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutSessionDom.js\":\"1c52e3cc2f8a08cb\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutSessionId.js\":\"85ecfb47c27f4070\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/linkClickGestures.js\":\"07ce0fa86a098e82\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/linkTargetAutocomplete.js\":\"5fd2e221b3a4e34f\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/localDbCorruption.js\":\"7818c2498ee21850\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/localDbRecovery.js\":\"b506759b86380aa3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/markdownParser.js\":\"654208a6f4361e8d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/memoize.js\":\"d7b8f00380751545\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/nameFieldCommit.js\":\"35a0d59e5a25a171\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/nameList.js\":\"ca36e58e7b1bc2bb\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/navigation.js\":\"69275c192d0b54d2\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/omnilinerNamespace.js\":\"85c00e9b358955e8\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/opfsPageScan.js\":\"1f2045c50121f714\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelClearance.js\":\"9631b0e54ea11056\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelHistory.js\":\"46bf88934ae70d90\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelLanes.js\":\"b31e6e287ae1b1d3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelLayoutProjection.js\":\"e5941dd7d63d2164\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelScrollAnchor.js\":\"e7dbcc30ceaad315\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelUrlFlags.js\":\"1e13262a77a19653\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/platform.js\":\"e3eac2ae4da7944a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/pluralize.js\":\"e657ff1870095436\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyCreation.js\":\"029e3939c815f380\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyNavigation.js\":\"d07c68bbfaaabd31\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyValueContext.js\":\"f06de69d30c56fe0\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/react.js\":\"6e9dde815426c906\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/relativeDate.js\":\"d663aab75848e5a9\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/relativeTime.js\":\"56185d874bd9ebae\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/renderScope.js\":\"bc0c8c6efe5c16dc\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/resolvedThenable.js\":\"5c6f553b6551bda8\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/routing.js\":\"23fde260a77d6e7d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/safeMode.js\":\"c0570ef0e2d5c5e0\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/scheduleIdle.js\":\"612c46fe3d0c0151\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/screenWakeLock.js\":\"6f45daa77152069d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/selection.js\":\"94835b507027b78d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/softKeyboardGrab.js\":\"111962101ddef1eb\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/startupTimeline.js\":\"1d6b052bff2756ac\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/state.js\":\"ec54bab1e3cd7ff7\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/string.js\":\"23e25d8974371dda\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/surfaceZoom.js\":\"ec14405c11517ab6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/time.js\":\"87359c3af114eefb\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/toast.js\":\"14c297d1e5c08ffd\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/toggleStore.js\":\"87f303596d1d6579\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/untilStopped.js\":\"0f5006320def9342\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/userActivity.js\":\"1b067d7f3d6865b6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/viewTransition.js\":\"9cc6bde480ba4e93\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/viewport.js\":\"08a27fb276612650\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/webLock.js\":\"a68804cea1273468\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/workspaceRecovery.js\":\"ba91be714f768818\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/workspaceSnapshotStore.js\":\"6eb73d094b195385\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-compiler-runtime.js\":\"aa3ec79bfb9f019e\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-client.js\":\"5a74305bdb3ca249\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-server-edge.js\":\"e77c4461407a7d2b\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-server.js\":\"56c643f628ca1d27\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-static-edge.js\":\"03e448e77144f31e\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-static.js\":\"2e66ab0f1771155a\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-test-utils.js\":\"820935f63fb861fe\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom.js\":\"372f32b198c4ab04\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-jsx-runtime.js\":\"678a1583bbfdf119\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react.js\":\"1e6c8d98517cd2b2\",\"/knowledge-medium/pr-preview/pr-1838/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1838/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1838/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
