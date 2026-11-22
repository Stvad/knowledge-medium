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
		buildId: "65369a2fb9ab-61e77de9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/\":\"cd55b8529e273256\",\"/knowledge-medium/pr-preview/pr-1838/index.html\":\"cd55b8529e273256\",\"/knowledge-medium/pr-preview/pr-1838/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1838/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1838/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1838/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1838/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1838/assets/FacadeVFS-BySLRrgy.js\":\"c937961717e328e7\",\"/knowledge-medium/pr-preview/pr-1838/assets/OPFSCoopSyncVFS-BJussN0g.js\":\"843ec09d77610a7e\",\"/knowledge-medium/pr-preview/pr-1838/assets/OPFSWriteAheadVFS-22KnAots.js\":\"ff4d9107215a71b8\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-CUslscDW.js\":\"ecbe51a9cc52c25e\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-async-CzHkASy3.js\":\"b9205250746f8a6f\",\"/knowledge-medium/pr-preview/pr-1838/assets/worker-BPHOaONh.js\":\"21ce53a57ca3e255\",\"/knowledge-medium/pr-preview/pr-1838/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1838/chunks/app-NB06hHs5.js\":\"44d86121af2d0f31\",\"/knowledge-medium/pr-preview/pr-1838/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1838/index.js\":\"0e209934786a7323\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1838/assets/AccessHandlePoolVFS-CT99hxBA.js\":\"7e6b1a2e30ec2a15\",\"/knowledge-medium/pr-preview/pr-1838/assets/IDBBatchAtomicVFS-CTCRiAsU.js\":\"55b425e36708ce25\",\"/knowledge-medium/pr-preview/pr-1838/assets/MemoryVFS-Dg-kJpBa.js\":\"827562397803fb1d\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-D3HCz0zt.js\":\"f631cfb2cb828574\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-async-eWUON75F.js\":\"c535857379a2efff\",\"/knowledge-medium/pr-preview/pr-1838/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1838/chunks/AccessHandlePoolVFS-BhF2xixa.js\":\"f3f609a346d1f067\",\"/knowledge-medium/pr-preview/pr-1838/chunks/FacadeVFS-eB0BGFXL.js\":\"e9ffc10040d0857f\",\"/knowledge-medium/pr-preview/pr-1838/chunks/IDBBatchAtomicVFS-anH3oq17.js\":\"3f64812977900612\",\"/knowledge-medium/pr-preview/pr-1838/chunks/MemoryVFS-B55h_8l5.js\":\"d3a29e3718187eab\",\"/knowledge-medium/pr-preview/pr-1838/chunks/OPFSCoopSyncVFS-C0McHfV3.js\":\"9bf907ed6bedda95\",\"/knowledge-medium/pr-preview/pr-1838/chunks/OPFSWriteAheadVFS-Ym8bH27A.js\":\"0704d28b00edbb8b\",\"/knowledge-medium/pr-preview/pr-1838/chunks/Preview-BYDNCLgZ.js\":\"d63f57c187197ab7\",\"/knowledge-medium/pr-preview/pr-1838/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/card-DbozT1Vh.js\":\"2c285a6fac92ba0b\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-CfKB6EFC.js\":\"c23bc14eba8e6917\",\"/knowledge-medium/pr-preview/pr-1838/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1838/chunks/mc-wa-sqlite-Z9OeqASv.js\":\"d0eaf25bb218ac2a\",\"/knowledge-medium/pr-preview/pr-1838/chunks/mc-wa-sqlite-async-BgpXKL_H.js\":\"8af2bce8ddc67cb5\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-5fyfdrae.js\":\"1a324da50c27add9\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-BKOoBx3_.js\":\"c988b34ab542b19e\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-BU6PKRhd.js\":\"00140d747a2caebe\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-CbCnCR2R.js\":\"3742737682929ea2\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-CiaAg-Jd.js\":\"9faf7919c2631386\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-CkAsnQb4.js\":\"b9e4f3b3b21d0a9c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-D8V2DkP7.js\":\"cd40be13e5863d2c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server-legacy.browser.production-BcOCr2kn.js\":\"2b9e5019b0d91415\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server.browser.production-Dos68YqE.js\":\"c66bf012f55cefa5\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server.edge.production-yk7l4pI7.js\":\"97530b695bc89336\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-z44t-0LO.js\":\"f85afbef8cc0680c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/server.browser-C1io7sRw.js\":\"8d09a0f9cf694d8c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/textarea-Dz88MLUN.js\":\"ba2f003f508226b3\",\"/knowledge-medium/pr-preview/pr-1838/chunks/ui-DCaeKOUt.js\":\"0d254953f21b22f3\",\"/knowledge-medium/pr-preview/pr-1838/chunks/wa-sqlite-DBTW7mS-.js\":\"d1b6fb00976447e7\",\"/knowledge-medium/pr-preview/pr-1838/chunks/wa-sqlite-async-Bnw-RiT7.js\":\"90570f8c161ab3eb\",\"/knowledge-medium/pr-preview/pr-1838/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1838/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1838/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1838/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1838/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1838/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1838/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1838/src/App.js\":\"cf7aa5184fe296e8\",\"/knowledge-medium/pr-preview/pr-1838/src/appUpdate.js\":\"77cfba5c4c9efea7\",\"/knowledge-medium/pr-preview/pr-1838/src/appVersion.js\":\"2299a59864ce87aa\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/initialLayout.js\":\"8e91e13851aabac3\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/openWorkspaceData.js\":\"ccbe95e4d1c99be7\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/resolveWorkspace.js\":\"6b131b95272490ed\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/workspaceBootstrap.js\":\"3cb05ffae07006e6\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockComponent.js\":\"bf4877e9c6ad619b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockCrumbs.js\":\"242dfc7842dbb164\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockEditor.js\":\"f3da26f4e7bcece9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockLoadingPlaceholder.js\":\"0ab72f50bfb21cf5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockProperties.js\":\"04dfd9e0cc199912\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockSearchPicker.js\":\"c6ce00951cd48923\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ConfirmBulkDeleteDialog.js\":\"ccc61b1599b3ed4b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/DividerHandle.js\":\"856dd285a45842db\",\"/knowledge-medium/pr-preview/pr-1838/src/components/DraftEditor.js\":\"adcc6bda05a2a716\",\"/knowledge-medium/pr-preview/pr-1838/src/components/GutterPill.js\":\"5666aeae3f32aa25\",\"/knowledge-medium/pr-preview/pr-1838/src/components/Header.js\":\"4a4c09440fff712f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/LazyBlockComponent.js\":\"f71afc9c7574ae77\",\"/knowledge-medium/pr-preview/pr-1838/src/components/Login.js\":\"fa3eb0b840e7ef94\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ZoomableSurface.js\":\"4dc44ea13910df0e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/editModeKeepalive.js\":\"32fa0a479efd660a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0bf9c9d11ed03115\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"73516623a904c7b4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/RefPropertyEditor.js\":\"1529e17d90070fe4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/RefTargetTypePicker.js\":\"abb2c38544f1bf9c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/SelectPropertyEditor.js\":\"66485f6669a5778e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/TypesPropertyEditor.js\":\"bfc7e2c32aac372d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/defaults.js\":\"de09a179b6b8a79f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/kernelValuePresets.js\":\"007afd9f9b33ba3b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/selectablePresets.js\":\"13552f8adc44bae3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/typesPropertyUi.js\":\"7619dbc67af707a4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/AddPropertyForm.js\":\"329cf0057526bca9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/PropertyPicker.js\":\"32d8f0fb3ba076f0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/PropertyRow.js\":\"9576158832ee216d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/Rows.js\":\"fb30c85b0e321acd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/actions.js\":\"85fd4167022f14e0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/declarationOnly.js\":\"77e700e5e7096c7a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/layout.js\":\"a02acfeecbaeed75\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/model.js\":\"075b2095bf80a3f8\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/shapeUi.js\":\"ee85a95849eb5112\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/shapes.js\":\"de3255ab602a6c2b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ff7160b99c12cac7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/visibility.js\":\"0b976685445c5c9c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanelSections.js\":\"44722be1c2333a9c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockEmbed.js\":\"03d50e02af1d700e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockLink.js\":\"db13925d7e75c54c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockRef.js\":\"ef8dc48947594385\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/ReferenceLink.js\":\"a1c1721c037d7824\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/cycleGuard.js\":\"a1e46afd4dc71633\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/cycleGuardContext.js\":\"d0e03b96597f41e7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/linkInteraction.js\":\"c3a4cc44c1dbf093\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/referenceLayout.js\":\"cfa4ee8c3955858d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/useBlockRefAncestors.js\":\"54645bd84433a369\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockGutter.js\":\"26c1a32a730eb80f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockInfoDialog.js\":\"805e5384f22135f2\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockTypeBlockRenderer.js\":\"8355a96a4d0d79fc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BulletHoverCard.js\":\"aaeec78574fe7d44\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/CodeMirrorContentRenderer.js\":\"2239b3afbf80a136\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"522a58c0977ed8f5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/ColumnResizeHandles.js\":\"2c04ebfbf243ae12\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f9f424bc177904bc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/DefaultBlockRenderer.js\":\"e0777c68e5f1b144\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/LayoutRenderer.js\":\"60f5815d3a589baa\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/MarkdownContentRenderer.js\":\"0d5f4e62887f58fd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/MissingDataRenderer.js\":\"2902132cb5ab578b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/PanelRenderer.js\":\"8d148f44dd2704bc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/PropertySchemaBlockRenderer.js\":\"fa7993275e0fefce\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/TopLevelRenderer.js\":\"8460874191a9aed7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/blockGutterMode.js\":\"b47123f940a297af\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/blockTitleText.js\":\"449f53520fc0960c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/fieldCreationKeydown.js\":\"17ea757837765d00\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/layoutRootContext.js\":\"55b4bc6a84f7c44a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/typeChip/TypeChip.js\":\"a8604d566aa31ecb\",\"/knowledge-medium/pr-preview/pr-1838/src/components/typeChip/chipStyle.js\":\"9b4edd3ceb7336cd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/anchored-floating.js\":\"2f31138d0a5ddc3b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/button.js\":\"3605cb31374cedd0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/card.js\":\"7361629af13e5775\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/checkbox.js\":\"475b01e38ac812b8\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/collapsible.js\":\"212729a75ceb4bed\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/command.js\":\"5c327e8c6341e7fd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/context-menu.js\":\"0f69f1578edd58f0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/dialog.js\":\"6fc10c90a5243b90\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/dropdown-menu.js\":\"94b673279a0d69ce\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/floating-listbox.js\":\"87a464ecbac9504d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/index.js\":\"0e3c2543a5a87606\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/input.js\":\"597c63166b2d2b13\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/kbd.js\":\"24cf9048a5d2b071\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/label.js\":\"690bd2314aa30549\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/textarea.js\":\"8b15fd03443cf1a4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/useEditModeYieldKeepalive.js\":\"80b8a72a08161bf3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/BootFallback.js\":\"47f91f38fab71925\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/FocusedRowLazyMount.js\":\"adf5816c73662a02\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/LazyViewportMount.js\":\"e62fcf5fa1d6ce82\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/LocalDbCorruptionFallback.js\":\"176834add2bef250\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/error.js\":\"b45dd6ca7c5c7522\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/lazyMountRegistry.js\":\"a3b8a0843fb3b6f9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/suspense.js\":\"4edbd2c670313090\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/CreateWorkspaceDialog.js\":\"e39ce9f73517fd02\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/PendingInvitations.js\":\"39518dc38bf4b468\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/SyncProgress.js\":\"34118e915eb01978\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/UnlockProgress.js\":\"d43c286a479bb3f7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceKeyGate.js\":\"7945591cfe1312a2\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSettingsDialog.js\":\"1973166c4a0b9b53\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSwitcher.js\":\"c1a0322cd407f9d0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSyncGate.js\":\"0debfd4d48a2f15c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/ConversionFlow.js\":\"fdac315d60704ff4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/ConversionFlowHost.js\":\"62a8c2c361ea5a9d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/EncryptionSection.js\":\"971f38d38b0ab162\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/attachmentPrompts.js\":\"bc4ef52adeed363f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e0923c7849c755ce\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/conversionFlowDeps.js\":\"d1b12bc4d078b84f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/conversionFlowStore.js\":\"1c2bc19e8b8507cc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/flowUi.js\":\"0433d87e6beb5498\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/useConversionRun.js\":\"43633e3d36f7df89\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/keyUi.js\":\"3899be60ceef67af\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/useCloseOnKeyLoss.js\":\"ec9a8954026e4960\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/useCloseOnServerE2ee.js\":\"01bd3abf0b2f15ed\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/workspaceUnlocked.js\":\"d3022ca9e03b6a89\",\"/knowledge-medium/pr-preview/pr-1838/src/context/backgroundSubtree.js\":\"e4d4a7f62f2e7b6b\",\"/knowledge-medium/pr-preview/pr-1838/src/context/block.js\":\"cb3223963935625c\",\"/knowledge-medium/pr-preview/pr-1838/src/context/layoutWsContext.js\":\"b7b2a0865fd644d7\",\"/knowledge-medium/pr-preview/pr-1838/src/context/propertyDisplay.js\":\"81143d27a2b656a3\",\"/knowledge-medium/pr-preview/pr-1838/src/context/repo.js\":\"ed8c51cd0c9a4565\",\"/knowledge-medium/pr-preview/pr-1838/src/data/aliasClaim.js\":\"ef7a14c1d861cc05\",\"/knowledge-medium/pr-preview/pr-1838/src/data/aliasSeatNamespace.js\":\"905397b2cc6ee84b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/blockData.js\":\"6ab69898cb788d5e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/blockType.js\":\"ac42baf25bad7b93\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/changeScope.js\":\"958ce24ba9327e79\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/codecs.js\":\"44a0d99f368a74e7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/derivedData.js\":\"6e628179473e4d07\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/errors.js\":\"598152b246d47f9c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/events.js\":\"e77bebfab6671d53\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/handle.js\":\"cd0bca47a5dfe8e8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/index.js\":\"3681338c9290b1cd\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/mutator.js\":\"b5b7528172b7c44a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/processor.js\":\"f1079ff339d47f62\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/propertySchema.js\":\"c9dcb3af6f70d99a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/query.js\":\"315eb1a0fee57732\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/sameTxProcessor.js\":\"e7dd713b1991f4f2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/schema.js\":\"cd0bca47a5dfe8e8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/tx.js\":\"cd0bca47a5dfe8e8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/typedBlockQuery.js\":\"0f45fcea1937d670\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/user.js\":\"845802e6016d366e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/valuePresetCore.js\":\"4ad2b10931c18bfd\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/valuePresets.js\":\"42fd32543694f894\",\"/knowledge-medium/pr-preview/pr-1838/src/data/attachmentCleanerIOVerb.js\":\"c6832b53322cdaad\",\"/knowledge-medium/pr-preview/pr-1838/src/data/block.js\":\"bd84e17676f770f9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockCache.js\":\"7c3a4d28ef487be4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockId.js\":\"2f5a5674b1b13d61\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockLiveness.js\":\"672ad4ed72091572\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockMerge.js\":\"971b22fe067d1d64\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockSchema.js\":\"8341e8a04d32bab2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockTypeLookup.js\":\"038088e54885f8be\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockTypes.js\":\"b4cebb3e01dcf6a6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/clientContext.js\":\"7ef3b76271f34c52\",\"/knowledge-medium/pr-preview/pr-1838/src/data/dbFileSiblings.js\":\"c69bbfba671e34da\",\"/knowledge-medium/pr-preview/pr-1838/src/data/definitionSeeds.js\":\"b0e53ac7305c17df\",\"/knowledge-medium/pr-preview/pr-1838/src/data/derivedIds.js\":\"739e7573bd0d490a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/drawnSubtree.js\":\"a198140e84e9acab\",\"/knowledge-medium/pr-preview/pr-1838/src/data/facetBridge.js\":\"f5429b1922fd6c0b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/facets.js\":\"f6a52d3a4e6b1f7c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/globalState.js\":\"abfc8729270297f9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/aliasClaimRederiveProcessor.js\":\"4ac1d2bd77ce5427\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/ancestorBatch.js\":\"03e025aecc93e930\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/blockTypeTypeifyProcessor.js\":\"534b826ff86e3a8e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/clientSchema.js\":\"ea77822367be114a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/commitPipeline.js\":\"41cdd912f1388f74\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/devAssertions.js\":\"5b4ebead01cac8a5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/firstSync.js\":\"552183fba288d945\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/freshInitialLoad.js\":\"9db42c65de65c54c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/graphBackfillClaim.js\":\"e0634bcabd948f32\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/handleStore.js\":\"21217d63fed122ee\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/idleMarkerJobs.js\":\"3a0deb669248c5f1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/initialDownload.js\":\"ebc0cdd01d207337\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/initializeClientDatabase.js\":\"74c8045c7109b82c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/jsonCanonical.js\":\"6b8dbb8fb9f641e2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelInvalidation.js\":\"ca3ccad285151241\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelProcessors.js\":\"0afdbdfdae569e40\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelQueries.js\":\"072adaa706903f28\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/mergeTypeMembershipProcessor.js\":\"59c77f5d98641a32\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/normalizeReferencesProcessor.js\":\"bf01fc0288ea77dd\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/poolInstrumentation.js\":\"4c7c130bb0793c8f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/processorRunner.js\":\"8eeb10935019ca4f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyCellBackfill.js\":\"7fb4e622196eb0ff\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyChildMint.js\":\"d0e0b7b6b1e67e1a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyChildrenProcessor.js\":\"7ff43636811c8f05\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d2483626dbb596de\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyDefinitionSynthesis.js\":\"97c5b994d69c76b8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyKeyScan.js\":\"a106c4cde58d9962\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertySchemaResolution.js\":\"89db0a02f18834f8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyValueEdits.js\":\"6f741a27e10331f2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/raiseProtocol.js\":\"2c7a2698004df618\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/readBatch.js\":\"b99bbd3d943a44f4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/refProjection.js\":\"41ff2e9f5a95b2a6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/referenceTargetLookups.js\":\"9ce28ae7a6ad3f82\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/referenceTargetProcessor.js\":\"1b56f1f446f81e4a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/replayMerge.js\":\"f7900097cd1d8f59\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/sqlBinds.js\":\"b1878f7f63ead8eb\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8e9dd6b1e3ef9a11\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/arrivalProcessors.js\":\"1b7b35607bc6bc62\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/invalidate.js\":\"22d168d3db6e03d2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/materialize.js\":\"ea404efc57390079\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/observer.js\":\"26fbd1d6f813489d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/reconcile.js\":\"dd591a358200c186\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/timingMetrics.js\":\"1d259cc0a6b1dcfb\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/treeQueries.js\":\"cb07db83910dcfea\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/txEngine.js\":\"00f785a72b50773d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/txSnapshots.js\":\"4277f58f3ad7afd0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/typedBlockQuery.js\":\"837cc65adef90c3c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/undoManager.js\":\"b3817ba17f77bc5a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/invalidation.js\":\"915969e5e011cf57\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelDataExtension.js\":\"603112760257ee66\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelPage.js\":\"e9250b5be813575a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelValuePresetCores.js\":\"48268e4922ef9d3a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbCorruptionSignal.js\":\"142694f99c84e418\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbStorage.js\":\"8e8618186d0e4d3c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbVfs.js\":\"126975b960325d04\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localSchema.js\":\"ff40a804c05e44f1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/maintenance.js\":\"e029423ae348755b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/mergeProperties.js\":\"0151ae8aa7a089b4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/metricsConsoleHook.js\":\"2f482aec4d77f6c7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/migrationsPage.js\":\"93ad918140b2f79d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/mutators.js\":\"77f6c844fccb066d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/orderKey.js\":\"af71b6ffedbb3efe\",\"/knowledge-medium/pr-preview/pr-1838/src/data/orderKeyPlacement.js\":\"a072855747e292dc\",\"/knowledge-medium/pr-preview/pr-1838/src/data/outlineSurface.js\":\"0406028cd7f739a4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pendingEditorContent.js\":\"1fad5a3a06d7e8d3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pendingUploadsSql.js\":\"f58d135aef12ee42\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pluginStateExtensions.js\":\"909fa18ce4811cd8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/powerSyncLogger.js\":\"a13a7a91ce731001\",\"/knowledge-medium/pr-preview/pr-1838/src/data/projectorRuntime.js\":\"ee9ba12550d984e5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/properties.js\":\"a36ded1ff19624ed\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertiesPage.js\":\"2af48e2056f071a2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyChildren.js\":\"d5e297184d7c7533\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionFanout.js\":\"13c4b7d5467ca53e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionMetadata.js\":\"1c21c1c629c62d1f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionRegistry.js\":\"09d1442de49cd887\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDisplayMode.js\":\"c13b3c77d96ef8e5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyRowCreation.js\":\"ba6025d6b86acc3e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertySchemaCreation.js\":\"fb9eda11d314c372\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertySeeds.js\":\"a112567b0df5b787\",\"/knowledge-medium/pr-preview/pr-1838/src/data/recentsPage.js\":\"e1f0d1dbd12198e2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/referenceBlock.js\":\"49dfdf0257ee47c6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/rejectedUploads.js\":\"9b3055dbb7c41d22\",\"/knowledge-medium/pr-preview/pr-1838/src/data/releasePowerSyncConnection.js\":\"fb8acd8621a137af\",\"/knowledge-medium/pr-preview/pr-1838/src/data/repo.js\":\"f0283e1927c48962\",\"/knowledge-medium/pr-preview/pr-1838/src/data/repoProvider.js\":\"05e262913d6cb50f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/rowProperty.js\":\"923d65dc56dd07b9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/searchFilter.js\":\"429f935401a42398\",\"/knowledge-medium/pr-preview/pr-1838/src/data/seedIdentityLedger.js\":\"675454380c5595d5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/stateBlocks.js\":\"d566fcf713067876\",\"/knowledge-medium/pr-preview/pr-1838/src/data/structuralEditPolicy.js\":\"4b203b9a1e3fb5ad\",\"/knowledge-medium/pr-preview/pr-1838/src/data/subtreeDelete.js\":\"e536ebf5ffa709a1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncStreamLock.js\":\"0aae629ac66d6a67\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncedTableSqlRecognizer.js\":\"efe9f965e85d3ada\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncedTableWriteGuard.js\":\"774985e72424316b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/targets.js\":\"9ee328c8cf98dd3a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeColors.js\":\"bd59a406485cff8b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeDefinitionMetadata.js\":\"b41968ceb5bb32c3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeDefinitionRegistry.js\":\"266825a72d6d2aa9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeExtraction.js\":\"89de9ed8b487aad7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeInitialValues.js\":\"177f12da5797294f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typePropertyGroups.js\":\"15d539fa59038968\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeSeeds.js\":\"88875a3697178afc\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeTagger.js\":\"a64b2b79c1e63164\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typedRecords.js\":\"9065c1411a6b4afd\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typesPage.js\":\"ce58308cb79a8f40\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userPrefs.js\":\"5a7db11f6b47d926\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userSchemasService.js\":\"911d0712da8603d1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userTypesService.js\":\"d98dea1ddf4ae448\",\"/knowledge-medium/pr-preview/pr-1838/src/data/valuePresetRegistry.js\":\"0e77760b07823c96\",\"/knowledge-medium/pr-preview/pr-1838/src/data/visibleChildren.js\":\"7fa45a74a5e5c4c1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceConversion.js\":\"9d2fb31ada935bac\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceFirstSync.js\":\"e7da33964c0e2136\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceIdNamespace.js\":\"19b425272c05ca01\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceSchema.js\":\"0c935e3d79d67678\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaces.js\":\"ada2888c545e682a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/writeAheadLog.js\":\"ff8b266817542eab\",\"/knowledge-medium/pr-preview/pr-1838/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/BlockPasteShellDecorator.js\":\"e0f3663378e9b76f\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/atTrigger.js\":\"58cf06942742be9d\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/autocomplete.js\":\"a7ddfcd6ec075ed8\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/codeMirrorExtensions.js\":\"a22581702aff6804\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/contentFlush.js\":\"e772c42d2844a2ef\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/defaultInteractions.js\":\"b9c362b788cbcf2b\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/editSettleSignal.js\":\"61aae4cfaed642d3\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/insertImage.js\":\"7f90773cf24deff7\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/referenceCompletionRange.js\":\"3ce9d05bbae8f27f\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/referenceTargetTypes.js\":\"8c71db26ff5ca182\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/syntaxContext.js\":\"f351ed0aa9e8aa30\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/triggerMatch.js\":\"9400dbc6b325485e\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/AppRuntimeProvider.js\":\"babb0ce441fcb9f8\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/BlockFocusShellDecorator.js\":\"16e36d3fe57cc3a4\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/ExtensionRenderBoundary.js\":\"38223318d6fc343e\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/PanelContentRecovery.js\":\"f78e4329620f1c2d\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/apiCatalog.js\":\"722f0f1f1fe3543b\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/approveExtensionHere.js\":\"742caa4362d2c8ca\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/armedCutAppMount.js\":\"33d1be1701782fa8\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/batchableKeyedStore.js\":\"ee1dafa0e551854f\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/blockInteraction.js\":\"4de468019b26f597\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/blockSelectionAction.js\":\"54e31f6507081628\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/compileExtensionModule.js\":\"94c25ce86182cba1\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/compiledModuleCache.js\":\"cbe6bbe020bd04ac\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/continuousGestures.js\":\"02e567d6e48e2ebb\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/core.js\":\"96293134d7c8465e\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/defaultRenderers.js\":\"90fbb7e2aa3b5702\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/definitionFanoutAppMount.js\":\"7511bbe3a2ef9971\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dialogAppMount.js\":\"8cf1d1ef2c78df56\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dynamicExtensionSeeds.js\":\"bd8ae28b2082e978\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dynamicExtensions.js\":\"1c5dd4efe46f0343\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/exampleExtensions.js\":\"ec31f4f7130e49ea\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionApprovalStatus.js\":\"6f53d15eebb7ae8d\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLoadErrorToast.js\":\"90a3ed22c97b4483\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLoadErrors.js\":\"d81b0a259f97f9b0\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLookup.js\":\"7919faffd54aae6f\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionToggles.js\":\"319d1fb40ba4f6c9\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionUtilitiesCss.js\":\"8dbd9d6116fc8671\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/kernelPageDeletionGuard.js\":\"2516dc793bd79c7a\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/liveRuntime.js\":\"63fb6d16aa71f7dd\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/openExtensionsSettings.js\":\"95035cf9f47ba63d\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/overridesCache.js\":\"5cc89c420ff31d9d\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/pluginIds.js\":\"87ad86ba88173d18\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/processorRejectionToast.js\":\"df219053a0fd24bf\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/runtimeActions.js\":\"00728a240ff36d67\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/runtimeContext.js\":\"625ed6fe5532e00f\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/staticAppExtensions.js\":\"441ba0e65375881f\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/staticDataExtensions.js\":\"f5572feb971865ee\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/toastAppMount.js\":\"0582f7a838941c90\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/useOverrides.js\":\"d7e297e44f7d26cf\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/useShortcutSurfaceActivations.js\":\"a60bceb3fc70916b\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/discoverToggleTree.js\":\"96ec3965fa290c18\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/facet.js\":\"f19b1d16d608affd\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/resolveAppRuntime.js\":\"6b20d49a96f0b172\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/runtimeEvents.js\":\"c6614d4b51ab1c0a\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/togglable.js\":\"f80dfa8457b7b021\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/variantFacet.js\":\"2ed7414c395ba3e1\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/verbFacet.js\":\"b5e98264e62e5656\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/block.js\":\"c5f4cf94accefd7b\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/focusedChild.js\":\"7dbfab55e043e8f6\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/propertySchemas.js\":\"8822dc5df0ffe2d3\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/typeRegistry.js\":\"3f8dc171bad1205e\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useAncestorCrumbs.js\":\"b811a15cfe3da3fd\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useAutocompleteListbox.js\":\"d81aa82788846c24\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useDebouncedSearch.js\":\"ac828cebfa3e6bd2\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useDebouncedValue.js\":\"4b1acd8ec1272630\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useIsFocalRender.js\":\"916c753c1f26aa6a\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useIsReadOnly.js\":\"c1a936debfd443a1\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useMaterializeBacklog.js\":\"5fd869ac0a1b0d4a\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useMinuteClock.js\":\"00cad276ef56c724\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/usePanelLayoutProjection.js\":\"256cad7ede1edbf5\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/usePendingInvitations.js\":\"22ebecce00c9345d\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useRendererRegistry.js\":\"f773b8bc16f3de9a\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useRetainedFieldRows.js\":\"0e3675908b8ad78e\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useWorkspaces.js\":\"3e1fda688e812ffd\",\"/knowledge-medium/pr-preview/pr-1838/src/lib/utils.js\":\"90ef7b6726de3fb5\",\"/knowledge-medium/pr-preview/pr-1838/src/main.js\":\"cc5b20e267a093ab\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/MarkdownImage.js\":\"f3da6a00261d91f0\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/blockSeparators.js\":\"ff5c4a6d9680d4cd\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/context.js\":\"20933087e1bee87c\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/defaultMarkdownExtension.js\":\"7a74fe39caf846a6\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/extensions.js\":\"9d21e8c6274b357b\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/renderMarkdownHtml.js\":\"c229021cdf2cd395\",\"/knowledge-medium/pr-preview/pr-1838/src/minimal-editor.js\":\"62b9cf9219b6f89e\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/armedCut.js\":\"368c994b6442603f\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/captureMediaVerb.js\":\"b6cd8417ecb83e05\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/clipboard.js\":\"9ab577cff571e614\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/decision.js\":\"36365547ce0724df\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/operations.js\":\"00d99f067fd61bd6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/account-header/AccountHeaderItem.js\":\"336c3b8a76f23f51\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/account-header/index.js\":\"1044e21fa990e281\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e7d88914b606d01a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/askAgent.js\":\"f8d2617142f5cf64\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/askedStore.js\":\"8492fd8c46f94974\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b2194ac54b7bf6ea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/chipState.js\":\"deb72a3b241fe192\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a6e46680296fce0a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/index.js\":\"406e17d92d5aaa5f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"11d5e4a491e0b13b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/schema.js\":\"bf5bd40b114809ff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/AgentTokensDialog.js\":\"54a4b4d731799a89\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8e9f1043678b21eb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/addMedia.js\":\"c85dc3d21afccd0c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/backlinks.js\":\"09e5cf15767c2538\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/block.js\":\"c0e50ef2c29e7547\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/context.js\":\"592c9cae4b29cd1d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/displayIds.js\":\"31d96050a6f87459\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/index.js\":\"0f11fc24081a74bf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/outline.js\":\"0e93ac8e6551f19c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/properties.js\":\"06ac4ee39a403523\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/refs.js\":\"439837fc52c5527e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b4f46512685af6c5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/search.js\":\"9d80d72c47d95355\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/shared.js\":\"353325fcae6096b8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"37911b7bb667f93b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/text.js\":\"81b8f01feab080b1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentWrites.js\":\"896b4d4c54775d97\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/authoringCatalog.js\":\"0c12abbc687d55ec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/blockRefTargets.js\":\"e61518fc82822b1a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/bridge.js\":\"dc77c814405645da\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/bridgeLoop.js\":\"7dac8357e46c5c29\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/changeHistory.js\":\"9765ebe100eb88dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/commands.js\":\"d2ca89c877fbd480\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/commentsCommands.js\":\"42c4d471199bc297\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/dataExtension.js\":\"4f764a9140f68150\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/dataModelGuide.js\":\"11da4f5c1e44ce57\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/describeRuntime.js\":\"44e5d8955654a212\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/extensionLint.js\":\"ae00eb495e6ba11c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/grainAudit.js\":\"b3c264a32683bc65\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/healthCommand.js\":\"9b7e47dfb597cd9e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/index.js\":\"7efeda4289c05177\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/presetIdentity.js\":\"62b24cd3b6d65d10\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"14f849fed28e398b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/readMedia.js\":\"11e7b0be093a42db\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/schema.js\":\"8ecb357171d976c5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/serialization.js\":\"3fc9e2b73745fb52\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/targets.js\":\"7c0da9ddcadfdcc5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/tokens.js\":\"207245dce217d96e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/watchEvents.js\":\"5806872eb6503ba2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/workspaceGuard.js\":\"7d20173ca1840a49\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/writeCommands.js\":\"3e0ad1ef12cfd02a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/AliasCollisionToast.js\":\"1fdea13c29738eb4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/DuplicateNameBanner.js\":\"7db0a9a5d033dffa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/collisionMerge.js\":\"ab8ddcc69a36eda8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/dataExtension.js\":\"a2d239c646963baf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/index.js\":\"271d0e32b6627e5b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/mergeCollisionAction.js\":\"a54f03dff7b00bc9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/pageStyling.js\":\"10050ef7ae8bff87\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/rejectionToast.js\":\"54055dd5465bb6d9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/syncProcessor.js\":\"efdf1a48bcec38e4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/actions.js\":\"6671274c086b7655\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/addComment.js\":\"5b0cbc76afdff54e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/anchor.js\":\"9835a922e1fa5f34\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/anchorState.js\":\"f4b6cc0751a9c7f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/commentLinks.js\":\"49ef10e8a26cbc9b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/confirmThreadDeletion.js\":\"1e9d8089d46350cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/container.js\":\"b502aefee27ead2c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/dataExtension.js\":\"7c209a445dae1c88\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/deleteComment.js\":\"637a2bc4f2302bf4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/highlights.js\":\"695dbd1bfba636d0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/index.js\":\"a03a31e16db5d24d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/linkedCommentsPill.js\":\"92e7ebe2bf9d7fae\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/margin.js\":\"1bf94058e937591e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/marginSchema.js\":\"6a1460e5b34e05f6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/newComment.js\":\"aa621693cc6dcb2c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/ownThreadPicker.js\":\"02cb8557b6069657\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/placement.js\":\"b93a4af7e0063577\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/queries.js\":\"0f889180dfcb49e7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotePosition.js\":\"a0b1cd2602c53e27\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotedIn.js\":\"85e24a4e39cbeb32\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotedRange.js\":\"519c7c79ef543c35\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/rangeRefs.js\":\"dbfbcddfd73998a2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readHighlights.js\":\"7316b2e7a600ebc2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readSelection.js\":\"ef0cd585cb9af018\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readSelectionUi.js\":\"5b5081ff012b15f0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/reanchor.js\":\"21144b066ec9dbab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/schema.js\":\"7cd13e3481d44116\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/scope.js\":\"a2c1ee29159387a1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/scopeThreads.js\":\"2ec0a4eabef20151\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/splitRetarget.js\":\"89770301d03fb31c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/suggestionCard.js\":\"244c201d5ad8b0e6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/suggestions.js\":\"9a78bff17c0b1569\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/summaries.js\":\"c052a6d905dab8c0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/summaryBatch.js\":\"d3981c55ec92ff3b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/surface.js\":\"4d3b399315468418\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/threadNavigation.js\":\"514589953df0cefa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/threads.js\":\"324be00f1bfcf430\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/ui.js\":\"96ba490498495794\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/uiStore.js\":\"9374fd6e7c31efff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-intents/appIntents.js\":\"ad89a7246c096d7d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-intents/index.js\":\"07d7e0de638a8e3c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-update-prompt/index.js\":\"9c10deec768cfc97\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-update-prompt/status.js\":\"188ef35dd2d5647c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"75fd8dc1cbaf5da1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaBlockRenderer.js\":\"325e54cc489f5ffa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaDownLaneReplicator.js\":\"968a5e071df46fb1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaUploadReconciler.js\":\"3cb5e41027d0de53\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetDownLane.js\":\"42ac9aff7aee32e8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetResolver.js\":\"88aaa4a0fc3e260c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetUpload.js\":\"160711020aa4e92b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/attachmentCleanerIO.js\":\"caf9763d329892b5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5e804ba46f072903\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/blobStore.js\":\"8b3a9cbc847df9cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/byteStore.js\":\"d110bf6acaefa673\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/cleanerIO.js\":\"84370587fc335d1e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/cleanupAttachments.js\":\"801c112ea32316dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/dataExtension.js\":\"665c546a963b2c7c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/downLane.js\":\"7dd071d3adfc500c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/index.js\":\"0da82a84e72f9b63\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/insertImageContribution.js\":\"a7507b2b55650dc3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/laneArming.js\":\"0b49d1f6dcad68dd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/laneLock.js\":\"5ba909943923a14b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaBlock.js\":\"c8a6ad78e43d9d8d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaCapture.js\":\"7a0a22e4f6b53939\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaViewers.js\":\"b1661b4d1862ac8b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaViewersFacet.js\":\"4cf3c0611fae69cc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/pasteCapture.js\":\"9d82c21ae46c2891\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/resolver.js\":\"85c4daf9a09d072d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/retryUploadsAction.js\":\"1dc66d4c81fc074e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/storagePaths.js\":\"8d8a900ace9e19d3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadDrain.js\":\"4073f480a70be67e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadLaneStatus.js\":\"97cffa857f2611b5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadReconcile.js\":\"5fec99ef1f30e1d8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadRecovery.js\":\"16150386d82fa743\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadStore.js\":\"e7a63e2e17d76765\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/useAssetObjectUrl.js\":\"b141514900b8e97a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6da646bf0afb5b0f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/BacklinksViewSection.js\":\"90239e6504679815\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/facet.js\":\"95f10dcdd9b1320d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/index.js\":\"9348be9658bf0466\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/prop.js\":\"5596c063e39250e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BacklinkFilters.js\":\"8031f794f8a8e57e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b1e109dd8a60d5ee\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BlockEntry.js\":\"f7b526301656300e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/LinkedReferences.js\":\"2500b24ac1ff28ec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fef6088f748aa13b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/dailyNoteDefaults.js\":\"329272b556593b6a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/dataExtension.js\":\"3707b87b6cf857f9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/edgeExclusions.js\":\"657c02c3be82c000\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/filterProperty.js\":\"9ed16880133487d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/index.js\":\"9bd6abf0d093a77d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"cd938092e59805e8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/applies.js\":\"7a3d5fd37d683a05\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/countQuery.js\":\"32844ccc021f03d9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/expansionStore.js\":\"352e44b4cf51ec8e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/index.js\":\"a5ab656b6b29bc91\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f1ddb2cf8e2fe95c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/presentationInvalidation.js\":\"d8decb12bb1d71df\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/propertyEditorOverride.js\":\"42f52964d462b1bf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/propertyFilter.js\":\"43408ec6b251928c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/query.js\":\"122828af68d5240b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/resolveFilter.js\":\"eadb375bc5b6875b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/sourceBatch.js\":\"3ad66c45839081b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/sources.js\":\"1ccc0daa617cfce4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/useBacklinks.js\":\"ddff744ea2a6e926\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4be14d253dd2198b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/BirthdayCelebration.js\":\"84746dc282a35dc3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/BirthdayOverlay.js\":\"7642c13b9fd72058\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/gate.js\":\"9d498c640b0e657e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/index.js\":\"ee1a26fd7a13c989\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/wolfTheme.js\":\"eefb1031b569994c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/BlockDragLayer.js\":\"a1b50630f8482f62\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/dragController.js\":\"4ea10b42d1ff1423\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/dropTarget.js\":\"b8ffe657207d990e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/index.js\":\"b67ae0128e30f9ff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/projection.js\":\"e95b126ae73e3277\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-info/BlockMetaCard.js\":\"026df69e4d5b1fe5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-info/index.js\":\"e86ee8e71f27b453\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/AddTagDialog.js\":\"04bf8c6c7e489c1b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7cb982d54916d27c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/TagNameIssueHint.js\":\"4d55c616ff9d8524\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/addTagAction.js\":\"f662e735554fadc7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/appendTag.js\":\"53f0fa10d7e4c68f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/config.js\":\"f6bea79e5fe37a68\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/dataExtension.js\":\"43487cf5020ae8a5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/index.js\":\"fd33bd789249dc87\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/propertyEditorOverride.js\":\"88607e8c1bc61556\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/BreadcrumbList.js\":\"771593582b72e8db\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"67c369ea583fda82\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e13e7b104363b311\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"767975731be38b15\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"09b31866292084c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/index.js\":\"ee6f57e9fbbb557a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1002f3556750f542\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/CharacterCountItem.js\":\"dce9c7d84bde3a91\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d9ca45c0290dcd83\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/actions.js\":\"b1a0a8c2513db4df\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/blockType.js\":\"d0f532f3bd147947\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/charCount.js\":\"78b772aa175f201b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/dataExtension.js\":\"7d92121c9ecab08f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/index.js\":\"415ffa30b45527f8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/profiles.js\":\"38096a4240ee6fcb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/properties.js\":\"e9f995aeb866d1f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/textCounts.js\":\"1eb4b6b7975d0085\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/colemak-keybindings/index.js\":\"4e305515f52354b1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/CommandPalette.js\":\"f7546a6b0ddcb8b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/HeaderItem.js\":\"1e0191786a263025\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/context.js\":\"0a8b22f05ac3e5f0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/index.js\":\"1e5f07f23d55d4ca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/selection.js\":\"c082bc2e7f168bf0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/toggleStore.js\":\"a5f56bd446a832ed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/useCommandPaletteActions.js\":\"35232fc97dd52989\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/ContributorBadges.js\":\"7b5ca1f51128388a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/author.js\":\"87c709a4e9bc54da\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/codeMirrorExtensions.js\":\"3e6a4bc013e2b47f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/dataExtension.js\":\"31c42dc4b8bc049f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/index.js\":\"3a091e883d5cfd2b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/mentionAutocomplete.js\":\"05d0a0fc3b296da6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/processor.js\":\"1b6fc86c6b1dcb89\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/profiles.js\":\"3611d6bfd35c71fd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/queries.js\":\"385b7ededfac62d3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/schema.js\":\"a56673ba2a6cc94a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"880b5962877a1d95\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3dbcd0baa660fc73\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/index.js\":\"cb493c35fe4bcda9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"29ecd6b87d8f9485\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5d98658c2f3243f5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/CalendarGrid.js\":\"964bf817efc02ea8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DailyNotePicker.js\":\"ce85f26537717805\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e266024092fcc6e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateNavDecorator.js\":\"ec1f635f73320df8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateScrubOverlay.js\":\"8308b8ea4aeed581\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/HeaderItem.js\":\"2012c6d155a39b0b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/ReschedulePicker.js\":\"c21ead808486b444\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/SpreadDatesDialog.js\":\"aaa6a03793b1a518\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/actions.js\":\"a7290d3d4bf87201\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/blockDateAdapter.js\":\"c9900809cd0bbd45\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/calendar.js\":\"16335ed33741ab08\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dailyNotes.js\":\"b59e24084ee5c9c1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dataExtension.js\":\"2b16d2b1d3dce109\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubActions.js\":\"3ec3a746d11f89b4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubGesture.js\":\"4079d931e5a43f37\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6dcdffd5e690079b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubRecognizer.js\":\"65490fbe3b183da4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/deletionGuard.js\":\"b90c9849c8d6a84b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dueQuery.js\":\"e7eb9438b383647d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/index.js\":\"a9efd1a731dc49b1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/landing.js\":\"d4d26425e5e4a6e9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/localSchema.js\":\"33ef82a487d880e0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/referenceDateAdapter.js\":\"c976ddde010d54b4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/rescheduleAction.js\":\"3278d2af324764d3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/schema.js\":\"bbeec8abb31450bd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/spreadBlockDates.js\":\"e7672bb9b4bfcdb3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/spreadDatesAction.js\":\"e2e79f8e4b6ba7d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/today.js\":\"8b5fd6a9e26ee5c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8350c8947e3a32d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"def062cdc8862a92\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/audit.js\":\"69599cc5a75206b8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/auditAction.js\":\"b5e0a012c21745a8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/auditRanges.js\":\"956d5990b0fa54f6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/diagnosticsSource.js\":\"45d88fa52ad44de0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/divergenceScan.js\":\"099661f2ce38415f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/index.js\":\"b76cfd628e8400c8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4a298cd92ecaad2f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/referencesMirror.js\":\"ce1c68bed3cde81b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/rowJson.js\":\"eefa9b207d844a3f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/schedule.js\":\"774aab95852f2b67\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/store.js\":\"d869c4780e4fb8c6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/action.js\":\"f0c164b0d72e26c4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/index.js\":\"2ba7159c3e05d0ee\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/plugin.js\":\"c0c05f8fda8760e3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c02d012834f450f5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/actions.js\":\"d39d3135620f372c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/changeMarker.js\":\"1b1a39261598fb21\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/diagnostics.js\":\"28ac270abc1bdd9f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/fileSystemAccess.js\":\"4cf432619244a53e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/filenames.js\":\"caa432616e83db2c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/index.js\":\"0e15047c101fa3c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/mirror.js\":\"d47032401949845b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/runLock.js\":\"4ae85f143c7907aa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/runtimeHealth.js\":\"4ba72655f7f9d72f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/schedule.js\":\"b6f37355dd73ff6f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/store.js\":\"595959f49697c8ce\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/default-themes/index.js\":\"aeb3a07e1ff1cf6c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/default-themes/themes.js\":\"02027716cba7425f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/diagnostics/facet.js\":\"b1ff1beb6c66bea7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/diagnostics/useDiagnostics.js\":\"ab9978b423c19815\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/dismissals.js\":\"12270bed2390c389\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/index.js\":\"31fb66ef7b976dc1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/status.js\":\"092b36a04521d986\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/store.js\":\"3bdf934b89b3d6a4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"25c0d9dac6dfe7bb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c5825bf9924509ff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/actions.js\":\"303ee2ee8a755c79\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/config.js\":\"5275c7b899bf82cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/dataExtension.js\":\"f281f75f99292a88\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/effect.js\":\"fb4e957b55946b4c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/index.js\":\"306c6ae2551fb363\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0d1fbc631221959b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/useToggleTree.js\":\"6ad0905c9f3b3f30\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/ExtractTypeDialog.js\":\"b0ae23733f65c728\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b26c77fd0963711f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/PropertyShapePicker.js\":\"015785d40d487810\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/action.js\":\"9e4f5a5d0eb8eda6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/index.js\":\"c6315b9f05b7956a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/FindReplaceDialog.js\":\"6a4dcaea91e0505b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/HeaderItem.js\":\"6dba601f0e1cd679\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/dataExtension.js\":\"f416d3aeeb272cea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/index.js\":\"14edf9ffce72aaf6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/search.js\":\"533ae382101381c3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/toggleStore.js\":\"2dd29a17897ea7b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/LocationPropertyEditor.js\":\"f7cd85a93c041ef2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/MapView.js\":\"4b1f01846d2ce6f7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/blockTypes.js\":\"4b42c056728d91b3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/codeMirrorExtensions.js\":\"2d1addec9a5602f8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/createOrFindPlace.js\":\"5d5d7562e7a82b3b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/currentLocation.js\":\"38d11ec4d8665f93\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/dataExtension.js\":\"6b48aa3f66a5b616\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/geoContentDecorator.js\":\"96c350c8f6ee6139\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/googlePlacesClient.js\":\"f62453eca5ffcc8b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/index.js\":\"b68e6f8ae351d7a6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/locationsPage.js\":\"695f7ed027c1c56e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/mapViewport.js\":\"2f157ba912f0fd53\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/pickCurrentLocation.js\":\"9199eef9d6fbf3fb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/placeAutocomplete.js\":\"1b32df0202a5debc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/placeNameCollision.js\":\"d9e047415487dbac\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/properties.js\":\"fedf88963f2190dd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/propertyEditorOverrides.js\":\"e729ee4f4c0108df\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/query.js\":\"acce62d710d9b0e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/usePlaceSearch.js\":\"29aa2cf62540c4e3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b078e651ea54d19a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7ee00b6fed8e6edf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"f52c90912f8d3def\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/config.js\":\"5ff7eb62f33e46b0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/dataExtension.js\":\"03db8dc7dcf14b17\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/facet.js\":\"e7f61f62280c8a84\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/grouping.js\":\"9c20ea527ac6fef6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/index.js\":\"3daba8545116d1d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2be55407c09f933d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/query.js\":\"5ea423b5c15f37d5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/resolveConfig.js\":\"c50c457a99ce85f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e2c66c5fca875094\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1922700448159ac0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/HtmlDocumentContent.js\":\"78d1319fe89ab67d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/HtmlFrame.js\":\"df424a7853dbc658\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/actions.js\":\"3a4afcc8a69b08b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/blockType.js\":\"16d2f4209802e9a7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/confirmRunScripts.js\":\"76f23111a6561b7a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/dataExtension.js\":\"5a2f90717491bdb6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameAnnotations.js\":\"04f2138710a186e0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameDocument.js\":\"89a5b36e09c4637d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameTheme.js\":\"9a2d8c2a91e2d37e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/index.js\":\"f85c9e56ef2c2a3d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/scriptConsent.js\":\"b34ec3607b45bddd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/sourceMap.js\":\"0b4f38d40d7b65ed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/useDocumentScripts.js\":\"740cf6d43a323b5d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/index.js\":\"a8a144ad562635f9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/record.js\":\"dd0fe801cd0fd3f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/recordStore.js\":\"03060eda2aae843b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/responsiveness.js\":\"2d2d546a02041ef0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/schedule.js\":\"48379da57723a65a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/sessionContext.js\":\"314066639159b6bc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e0cc5cd62e3193cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"27688e1201fac753\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/actions.js\":\"76835d24c8476c0d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/config.js\":\"64699971bf3b6cec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/dataExtension.js\":\"1059106ce588da45\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/effect.js\":\"63c0c0a01201bae7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/index.js\":\"e60fe14d2f3fe445\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/keyCapture.js\":\"a9659173bf277207\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/overrideStore.js\":\"3ea139c83bc29d44\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d9099fa54ac73243\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/HeaderItem.js\":\"809e28f4e47a6dcc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/LeftSidebar.js\":\"033ba8b1730ba6e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/actions.js\":\"506debeb0c3d73c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/facet.js\":\"bb95f0aa27c44ccf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/index.js\":\"92670c1526da4949\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/shortcuts.js\":\"a9b54ae632a291a7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/toggleStore.js\":\"7a98b90f9b739912\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/MergePicker.js\":\"ac85e18d34d75ee8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/index.js\":\"c60b79e2605c6c65\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/mergeAction.js\":\"c839d05a20c53c61\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/strategy.js\":\"9036aed20c5750c7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/Button.js\":\"cbb286b1e188d7d2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ef0ba776a78c7fbe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f26c7abd00c86d3a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/facet.js\":\"5e478fd3eaa320b6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/index.js\":\"8cf779865c6195cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ddcc9abe988196d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/actions.js\":\"54393e38d9d23496\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"4f8bbac6b3aca357\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9541c4e9c5efa8b8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/index.js\":\"a96c9d6fe35807f0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/MoveDestinationPicker.js\":\"68606d731e8678d2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b9a8589e3f2fb492\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/contextMenuItem.js\":\"e0956f68c4d99c15\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/index.js\":\"de585582450cafdd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/moveAction.js\":\"cdab5ea535b596f9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/moveBlocks.js\":\"9f3c9ba87a52e8e5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/selectionAfterMove.js\":\"95550976a9029c79\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/TutorialBanner.js\":\"1254f73a4b91ceb4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/action.js\":\"f22a48b2a7d779bf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/bannerDismissal.js\":\"78b019f926628f78\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/documents/cheatSheet.js\":\"a5b82dd7e9d7a8d3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/index.js\":\"b1a81d9e2f7967c0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/keys.js\":\"53fc6a979bfd5b05\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/landing.js\":\"59214daaefee248b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/outline.js\":\"b051c84c7fe22024\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/seed.js\":\"6901f4bf70bcde00\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/PerfTrendDialog.js\":\"2bd4fb7efa5ddacd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/analyze.js\":\"f4b171e66bd53ec6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/diagnosticsSource.js\":\"01f65b3d10fd7cbd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/index.js\":\"fa88bf06edc0cd4a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/load.js\":\"11f49a2153ea3849\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/monitorRun.js\":\"a85ce5e80920106b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/schedule.js\":\"40ccb9913d0c78b1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/series.js\":\"c1f021a0c7be5851\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/store.js\":\"299cbe6cf9d2b7d7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/trendAction.js\":\"af0051acd7c194b6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/verdict.js\":\"0e9f03b164823d7b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/clickToEditAction.js\":\"b427a11c4686f90e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/index.js\":\"f93b695e76108f57\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/interactions.js\":\"1b13a3efc615c730\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"39e970ea94724464\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/MigrationGate.js\":\"3ae2e7401387ad15\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/MigrationGateDialog.js\":\"123939507f9d3da3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/action.js\":\"cc49baf6e415ba2c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/index.js\":\"50b3d2b1133b8779\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/localRunMessage.js\":\"d5c34941ca4fd236\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/plugin.js\":\"3827139b95e60ba7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/progressReport.js\":\"9e360e354f122571\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/sweepProgress.js\":\"95fdd6819d073ed1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/FieldRowRenderer.js\":\"8b43883ffb6188e7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/ValueRowRenderer.js\":\"15753d3ac3727595\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/actions.js\":\"bbe77715e3ec4715\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/autocomplete.js\":\"afd04ee8a2612230\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/fieldRow.js\":\"71aed8b333a368bb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/index.js\":\"c1956efab2a7f5be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/referenceWarning.js\":\"c942b8a73bf59c64\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/valueAutocomplete.js\":\"333a2643c5c235a7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/valueSchema.js\":\"d9c400db51531740\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/HeaderItem.js\":\"5ee7f80aa6a41ad3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/QuickFind.js\":\"b7562252bcd329ff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/index.js\":\"0517e39811c29d30\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/recents.js\":\"b64a5d394dfa13f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/resultItems.js\":\"e221316ef6ef965b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/selection.js\":\"51b080ddb3460a90\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/toggleStore.js\":\"3ab12dc67f94172a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/HeaderItem.js\":\"67ff95382c32b87d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f5fb707427649cfa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/grouping.js\":\"f224f5bc793112d6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/index.js\":\"46b39755611cb7b3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/target.js\":\"0684046b253e21c5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/codeMirrorExtensions.js\":\"8d713615a1ce8092\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/contentPrefill.js\":\"4c9e6d3a188eb8df\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/dataExtension.js\":\"4c98aa9e9ffcae53\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/index.js\":\"f726ca5651e4c3f2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4995596cad23f99b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/invalidation.js\":\"d8cf2107235cc6a6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/localSchema.js\":\"32712d896171c9c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/blockrefs/index.js\":\"0c8e963743eac702\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4d5d940a610625c0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/index.js\":\"3b96dcd54ce3a54f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/referenceNode.js\":\"a2676a94a449b151\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/remark-reference-occurrences.js\":\"364f9571257106b0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"482ad76fd698c753\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/index.js\":\"b058709eaee01da9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"39a1ea662e3dd136\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2e46081e7af74001\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/mergeRetargetProcessor.js\":\"486cd7bd05369414\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/parseFence.js\":\"725d92b35ba9ec3a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referenceParser.js\":\"b0db1d28d48a1cba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referenceProjection.js\":\"d4b1c10893c6f897\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referencesProcessor.js\":\"e9ccde0a016f0135\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/renameProcessor.js\":\"279daa0b5138d004\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/spanReplacement.js\":\"6256dc6e7a352bdf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/htmlToOutline.js\":\"3bdf046c86773190\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/index.js\":\"c6ad617b0943061e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/normalizeClipboardDom.js\":\"fd808aac39505e5d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/pasteDecision.js\":\"6da3307409f5f8e8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/action.js\":\"da30b4f251ebe6e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/blockIds.js\":\"3871e3a5b094a238\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/content.js\":\"08846267901e7a84\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/effect.js\":\"e82ec0017dcff255\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/ids.js\":\"87db54c17556f524\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/import.js\":\"3b0b9b2d456069e4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/index.js\":\"6844c76651191cc4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/plan.js\":\"6734f4f5e4d024b6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/plugin.js\":\"b1142d11999d48da\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/promotion.js\":\"f9d1e00fecfb03a4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/properties.js\":\"6d96ae8589721416\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/references.js\":\"b706f2c48d94ae6e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/report.js\":\"b577f0bf74d72994\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/roamMemo.js\":\"a7a4f5070d199397\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/runtime.js\":\"9e5ffd090e63b285\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/schemaReconciliation.js\":\"d6d7f0d19475e0fc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/srsMarkers.js\":\"c629420c777bae37\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/todo.js\":\"adb9aa25848a9cc7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/typeCandidates.js\":\"3eb5b0c4492d1e4e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/types.js\":\"15baf5a5535b321e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/search-health/index.js\":\"2054c3580a1ac53b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/search-health/store.js\":\"fc7f5a9b8c0030b0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/HeaderItem.js\":\"aa7efba183b396b8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"fcf031fcf1ed1091\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/index.js\":\"63ee3e3603563e41\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/model.js\":\"3a7a1396b0c005eb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/toggleStore.js\":\"5f05a7acd453d45e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/useKeyInspector.js\":\"0ad568e3d79348db\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1fafaf65d0205815\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/ShellDecorator.js\":\"5130c53daa49def6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/actions.js\":\"9425a943d4b59053\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d7e1780182ec2d7f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/index.js\":\"1b7285096f376714\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/shell.js\":\"da7cec7b7a5e633d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/surface.js\":\"a84b6cf9be876a25\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/walker.js\":\"7ef00dfb61c61925\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c9e00721d310f77c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/dataExtension.js\":\"a6f1f2ffa74da934\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/index.js\":\"531afc2d2d698ee2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/indicator.js\":\"9dc6cecc845c046b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/moveSrsState.js\":\"7ff7ee4c70c0a13d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a18380d6969a48de\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/scheduler.js\":\"43d8b4e316a8675e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/schema.js\":\"52fe271c69eba1aa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"7cd1700cdbeca0cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/srsClipboard.js\":\"4ad3506f78040651\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a73177922d272b25\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3536087420cac9ce\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/DeckPicker.js\":\"3a558eec360c5c7c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewControls.js\":\"3f57d88d67cbadac\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f19208a1bed32d6b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewSession.js\":\"3d3b25457d6fbf1e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/actions.js\":\"f7f1bacbdcccfba9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/archive.js\":\"6ed483740688882d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/dataExtension.js\":\"79b59acbdd13d784\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/deck.js\":\"aa59d9e1ad5231cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/dueQuery.js\":\"2c86c590389f704c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/gradeDecision.js\":\"b8fb7306e9d906df\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/index.js\":\"16eca2b19bcf7a75\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/keyHints.js\":\"02ec307e22bdafa7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/reviewCardLayout.js\":\"460aedeffffff41c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/reviewProgress.js\":\"1888ceb6d87bc22c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/schema.js\":\"369f8be04fe520cf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/useDueCards.js\":\"9d42f74a578bbe3e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/startup-metrics/index.js\":\"84e01f39c55dc46e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/startup-metrics/record.js\":\"7854e89075e231f7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/index.js\":\"b835368ed2892905\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/persistenceStatus.js\":\"40bce11499db0e37\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/requestAction.js\":\"d5e2c050f93d7d1b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/TypeChipsDecorator.js\":\"8516c19cafea8e79\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/codeMirrorExtensions.js\":\"a82e3753f4da4108\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/index.js\":\"3a979f06da854729\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/typeAutocomplete.js\":\"6eb45bbedd9f3358\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2fa09f60b90e4376\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/actions.js\":\"6d7a88c56c565d69\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/anchor.js\":\"ac7805f98e7b6361\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/events.js\":\"64357a05474f8406\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/gestureActions.js\":\"30a80752012a058d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/index.js\":\"9450c8d1f8d61328\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"94398854e2e3ee2f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/collect.js\":\"9d595d6abb388249\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/index.js\":\"5c010126cd677ffe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/record.js\":\"aac1b657d0850b49\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/RejectionDialog.js\":\"e916de3eab478323\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/SystemStatusHeaderItem.js\":\"28f3a9601c5a40cf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/index.js\":\"88fa4e8552758f58\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/model.js\":\"47a121fdd93410b4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/queueCounts.js\":\"61b85453d4129050\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/rejectedHelpers.js\":\"4b7e2fb107f3a41b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/rematerializeAction.js\":\"f72c960fb53c2539\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/useHysteresis.js\":\"971e075c3bc30664\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/ColumnHeaders.js\":\"335c3e32700e8d30\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/TableLayout.js\":\"7c05d2bc317415f0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/actions.js\":\"fe6b85df1bb8c13c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/cellEdits.js\":\"ab55dd37dec470d0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/columns.js\":\"e96e864ae9365f95\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/controller.js\":\"f5b0bdfb57da7e51\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/convert.js\":\"23de4863decb4cd9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/dataExtension.js\":\"d7c3be8902ec9382\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/index.js\":\"2eac5566fe656f2e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/keys.js\":\"3d1e94604b32c62e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/model.js\":\"fc357e871b2b5a73\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/backfill.js\":\"2566972525837ef4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/format.js\":\"b05b013639e7099e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/parse.js\":\"484b8547404f27ed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/source.js\":\"4a0a785e0471d3d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/registry.js\":\"a76b18f37405728a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/schema.js\":\"8cd201844b3da28c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/sort.js\":\"5e8a7034ba580fb9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/effect.js\":\"1779e9fd99f16f46\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/index.js\":\"b6dfe307e3f891f5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/theme.js\":\"f9f86c6518e05181\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/actions.js\":\"71cb233f4330d1e7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/dataExtension.js\":\"dabcfa27c4b8db10\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/index.js\":\"64c2862747646056\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/schema.js\":\"56ba03825418ba05\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/TouchSelectionLayer.js\":\"bccea9fd90e47f38\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/actions.js\":\"82799121d81c28e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/defaultItems.js\":\"bde3751d9155777c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/facet.js\":\"27553be5bd33a179\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/holdRecognizer.js\":\"502ab839bc9891cc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/index.js\":\"f8a1fdfb1e34b6a6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/UpdateIndicator.js\":\"00d1d74aae8912b0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/index.js\":\"554e02a618d36aaf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/loadTimes.js\":\"6d02819a763f03ff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoNotesRenderer.js\":\"e373d1b61cf36d12\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoPlayerRenderer.js\":\"983a1822f371ee5b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoTimeStamp.js\":\"99e735d3d73e0b94\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/actions.js\":\"d335ab46fc1c7755\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/index.js\":\"d823f30fea9b016d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/markdown.js\":\"282e19d65f5cf899\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/notes.js\":\"1fc313491be875c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/registry.js\":\"ecb1ad8eda289d0f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/remark-timestamps.js\":\"f7523b9cc8cdd601\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/view.js\":\"878a5233de808b8c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/LinkHints.js\":\"ba751f0532cd4cd2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/index.js\":\"fdef7c8be243ace7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/model.js\":\"dd0353007d0f685b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/settings.js\":\"d670b548bad8beae\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/actions.js\":\"0e51b9f1885e8413\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/index.js\":\"200ba4ffae1a4af6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/interactions.js\":\"17e4844effda738a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/workspace-header/index.js\":\"04b2d5fd247bef1e\",\"/knowledge-medium/pr-preview/pr-1838/src/registerServiceWorker.js\":\"3712824a75323f76\",\"/knowledge-medium/pr-preview/pr-1838/src/requestPersistentStorage.js\":\"eafff6c60f601888\",\"/knowledge-medium/pr-preview/pr-1838/src/services/authRequestDeadline.js\":\"71ce5a0c837646a1\",\"/knowledge-medium/pr-preview/pr-1838/src/services/authStorage.js\":\"511220f593026469\",\"/knowledge-medium/pr-preview/pr-1838/src/services/powersync.js\":\"8ea9c693ff589c86\",\"/knowledge-medium/pr-preview/pr-1838/src/services/supabase.js\":\"a350565972a5a364\",\"/knowledge-medium/pr-preview/pr-1838/src/services/uploadErrorClassifier.js\":\"b236d265fe9f7b11\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/ActiveContexts.js\":\"615e15121d6a0806\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/HotkeyReconciler.js\":\"32a94fa9b3f642bf\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/WipeLocalDataDialog.js\":\"c4c6951784f27f69\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/actionDispatch.js\":\"ad86063fa4da50fb\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/actionRefItems.js\":\"ac59ff0173f50676\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/applyKeybindingOverrides.js\":\"487df551508cc4d0\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/blockActions.js\":\"d61cabfeb6a71815\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/canonicalizeChord.js\":\"69abc5670f05041a\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/defaultContexts.js\":\"f48996ae3eb2c688\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/defaultShortcuts.js\":\"7667fbcbe7e69663\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/effectiveActions.js\":\"4ad940643149be16\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/gestureAction.js\":\"c7cec7b45d760d77\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/gestureBinding.js\":\"cdcede1ad63a708b\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/holdRegistry.js\":\"f1f06758bad7556d\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/keybindingConflicts.js\":\"566618124630e8f0\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/keybindingOverrides.js\":\"70bdbd07a48988d9\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/pointerAction.js\":\"7bd8872ba7a3231a\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/resolve.js\":\"539d7b0a3ab0a8fa\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/runAction.js\":\"d5d99ccc99015a51\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/sequenceMatcher.js\":\"fc366924f783781e\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/types.js\":\"67d900a1c9848d3e\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/useActionContext.js\":\"0bd4541783ec583e\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/useActionDiscovery.js\":\"00b4840a319ff100\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/utils.js\":\"552fcfb1f71c2a0d\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/bootStore.js\":\"81064bea27884a81\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/previewDatabases.js\":\"4fbeb4a7f82ef75e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/byteTransform.js\":\"e63df686fc14335c\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/attachmentCleaner.js\":\"da9f7349de54728f\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/attachmentParts.js\":\"a27c84260a6512f8\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/bundleParts.js\":\"00b9fad624a960dd\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/bundleRecord.js\":\"ffa0508415d8847d\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/manifest.js\":\"37efe225f8f193a8\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/takeBundle.js\":\"a2317b9d6523c556\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/verifyBundle.js\":\"7133f943846396ac\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/cleaningStage.js\":\"8507cda31eeb14d2\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionKey.js\":\"e63803efad42159b\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionServer.js\":\"7ab22179cc54d284\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/flip.js\":\"346b352b3741ec4c\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/flipAttempts.js\":\"fd5c0a223fa0e3c6\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/pages.js\":\"71846a8fdc126b1d\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/preflight.js\":\"6333fc9d2406ce7e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/reseal.js\":\"b7d3cd3ba7238409\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/runConversion.js\":\"5813ecbe51715af2\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/runLock.js\":\"37cb6d02fa1658e7\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/sealing.js\":\"c8397928bc4e90f1\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/sealingStage.js\":\"582655e4857cc588\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/stage.js\":\"882ae274e355e0f1\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/verifyReseal.js\":\"c83be4b7fa1c9731\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/aad.js\":\"163fd78b8ddb4379\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/aead.js\":\"39eb3c425d30b694\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/base32.js\":\"e048dec0ba6ec0dc\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/base64url.js\":\"f97285d5f1d291a4\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/binaryEnvelope.js\":\"ad3a0a387afce45b\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/byteAead.js\":\"e14df83256d2bfac\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/canary.js\":\"fd492c4e476ed746\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/contentHash.js\":\"fe8970f5a73d2724\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/contentKey.js\":\"76f8c2f7a730a455\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/derivedIdNamespace.js\":\"215fd70183589fc6\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/envelope.js\":\"6f755c7a00b27502\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/hex.js\":\"4b6c6b5a0615eac1\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/sha256Hex.js\":\"a8f76b90dd802a21\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/workspaceKey.js\":\"ee3e35d16656cf88\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/conversionState.js\":\"b5622a1121cc68a5\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/createEncryptedWorkspace.js\":\"978d7d6c590fec6e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/pastedKey.js\":\"86712cbcd4be4575\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"92d0292edd8bbde5\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/upgradeWorkspacePin.js\":\"115da25db25ac154\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/keyStore.js\":\"3f8168c1e905bbb9\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/mintWorkspaceKey.js\":\"b6141415d4a3ae49\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/modePin.js\":\"e0232e5586cf65d0\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/openWorkspaceKeys.js\":\"9ddb502bb58c995a\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/resolveWorkspaceEntry.js\":\"582b3e3bdaad283e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/resolver.js\":\"0fb1efe64cebfa25\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/workspaceAccess.js\":\"eaaf6707f04baada\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/transform.js\":\"2a8c788edbce4ee0\",\"/knowledge-medium/pr-preview/pr-1838/src/themeBootDefaults.js\":\"bd3a851586813c8a\",\"/knowledge-medium/pr-preview/pr-1838/src/types.js\":\"75b91397edc3f089\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/ClientLocalSettings.js\":\"1372a5cab1151003\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/abortableSleep.js\":\"bcd974b942ab5f43\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/array.js\":\"08d9152726a06525\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/backlinkAutocomplete.js\":\"a6c66b5688955f59\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/blockCrumbs.js\":\"220bfac8c722320c\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/blockrefAutocomplete.js\":\"f53b56c6ac253d39\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/cadencedIdleJob.js\":\"ddb411b319bc2236\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/callbackSet.js\":\"5dbbb860bf111005\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/clientId.js\":\"af10f249a1abd7a6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/codemirror.js\":\"e93359b1f371d8dc\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/codemirrorCompletion.js\":\"31d92206f1061ac7\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/copy.js\":\"0179608618278a61\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dailyPage.js\":\"d8e17104d9743c8a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dbForensics.js\":\"2eafe88f6558ef9f\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dbForensicsHooks.js\":\"6847a95b2acac8e4\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/deleteBlockThroughUi.js\":\"b42369a79afc61ad\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dialogs.js\":\"b68c68a1636da6f8\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dom.js\":\"b998a16c5ca4f632\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/downloadBlob.js\":\"030ff344479f3c31\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/exportSqliteDb.js\":\"7a1ec3b2d53ddfd2\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fileSystemAccess.js\":\"e3d5c555328921f5\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/flipSlide.js\":\"b83094eebe7d070a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fnv1a.js\":\"a661da0e453754e8\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/formatBytes.js\":\"4d85f058d2442309\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fuzzyRank.js\":\"56550a0da57cdce1\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/idbKeyedStore.js\":\"d6bd75796886e85d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/idleCallbackPolyfill.js\":\"a26cea70306957e2\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/keyboardAwareScroll.js\":\"d3beb924396c5028\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/keyboardViewport.js\":\"5690009573f176f5\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/lastWorkspace.js\":\"95183250d0d1c5dd\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutColumns.js\":\"8e30c89a27456843\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutSessionDom.js\":\"d794cc14efc1cb48\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutSessionId.js\":\"a7eb0fbf6ace9ecf\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/linkClickGestures.js\":\"9e317819ee5acb6b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/linkTargetAutocomplete.js\":\"12dd26d835f61eac\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/localDbCorruption.js\":\"e099ac97b8f4c87c\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/localDbRecovery.js\":\"707e79b3187d57f0\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/markdownParser.js\":\"abb8bf707345cace\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/memoize.js\":\"c28baeedcf3138a0\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/nameFieldCommit.js\":\"6225e5d80f07c3a4\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/nameList.js\":\"d8f57e74594ea66b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/navigation.js\":\"b0c8195b1026eeb5\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/omnilinerNamespace.js\":\"5b9da9911097de38\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/opfsPageScan.js\":\"77390f089f42350e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelClearance.js\":\"65a9660711708c54\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelHistory.js\":\"9f575189ccec868e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelLanes.js\":\"5ecdd5f2999ab3a7\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelLayoutProjection.js\":\"4cbf2c357494bb5b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelScrollAnchor.js\":\"33f2e85d9039b9c7\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelUrlFlags.js\":\"0ab6e850f076e5e4\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/platform.js\":\"613069b0a84fe4a0\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/pluralize.js\":\"e64e36f04fa17094\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyCreation.js\":\"bf4589bf59b73a12\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyNavigation.js\":\"28142176610f4854\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyValueContext.js\":\"0359e3532d17b600\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/react.js\":\"a18e34deb0884c1a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/relativeDate.js\":\"3d24fc205a598441\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/relativeTime.js\":\"73f58aea163e6bf1\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/renderScope.js\":\"00e5aec9dc860607\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/resolvedThenable.js\":\"4fb8bcf43173aa74\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/routing.js\":\"a80544061042efc8\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/safeMode.js\":\"c89bc231ca5b4714\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/scheduleIdle.js\":\"f3662a24aa81a88d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/screenWakeLock.js\":\"b9bd054c4149e3d5\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/selection.js\":\"40544cd7dd3c3d74\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/softKeyboardGrab.js\":\"334cc606f22d2b72\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/startupTimeline.js\":\"d759260ab5e4ccf3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/state.js\":\"46fba807ef41a552\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/string.js\":\"be4a282b1cc2e0b9\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/surfaceZoom.js\":\"edb000766a57c3f4\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/time.js\":\"7a681e564d8cf8d3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/toast.js\":\"068661d7cf69ab0d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/toggleStore.js\":\"21842e156196b1a1\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/untilStopped.js\":\"d1267eb0f8222b2f\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/userActivity.js\":\"c242b53bd1ca7d89\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/viewTransition.js\":\"169cc9c1521f0757\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/viewport.js\":\"2fe3b633384abc9e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/webLock.js\":\"ebd1de5cd186b2f3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/workspaceRecovery.js\":\"620e7ff1e0a929a1\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/workspaceSnapshotStore.js\":\"e949614af3fd135c\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-compiler-runtime.js\":\"ac079ee971419aaa\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-client.js\":\"22da2a0ad291b995\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-server-edge.js\":\"a5ef774a88124060\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-server.js\":\"399af79aeee126a9\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-static-edge.js\":\"15c24f13a91e8874\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-static.js\":\"6e2f24609b406957\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-test-utils.js\":\"e3114febe814a3f8\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom.js\":\"d5f06cec0de906b0\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-jsx-runtime.js\":\"0cbcdc9f0d282bff\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react.js\":\"b3183c392825bd8d\",\"/knowledge-medium/pr-preview/pr-1838/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1838/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1838/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
