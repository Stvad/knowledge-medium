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
		buildId: "b54f30af3f3b-026cb050",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/\":\"31bba7aa6067fa11\",\"/knowledge-medium/pr-preview/pr-1838/index.html\":\"31bba7aa6067fa11\",\"/knowledge-medium/pr-preview/pr-1838/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1838/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1838/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1838/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1838/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1838/assets/FacadeVFS-BySLRrgy.js\":\"c937961717e328e7\",\"/knowledge-medium/pr-preview/pr-1838/assets/OPFSCoopSyncVFS-BJussN0g.js\":\"843ec09d77610a7e\",\"/knowledge-medium/pr-preview/pr-1838/assets/OPFSWriteAheadVFS-22KnAots.js\":\"ff4d9107215a71b8\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-CUslscDW.js\":\"ecbe51a9cc52c25e\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-async-CzHkASy3.js\":\"b9205250746f8a6f\",\"/knowledge-medium/pr-preview/pr-1838/assets/worker-BPHOaONh.js\":\"21ce53a57ca3e255\",\"/knowledge-medium/pr-preview/pr-1838/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1838/chunks/app-hFI-T6Iq.js\":\"dc0859c395f25ad2\",\"/knowledge-medium/pr-preview/pr-1838/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1838/index.js\":\"ab7d3756612960fd\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1838/assets/AccessHandlePoolVFS-CT99hxBA.js\":\"7e6b1a2e30ec2a15\",\"/knowledge-medium/pr-preview/pr-1838/assets/IDBBatchAtomicVFS-CTCRiAsU.js\":\"55b425e36708ce25\",\"/knowledge-medium/pr-preview/pr-1838/assets/MemoryVFS-Dg-kJpBa.js\":\"827562397803fb1d\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-D3HCz0zt.js\":\"f631cfb2cb828574\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-async-eWUON75F.js\":\"c535857379a2efff\",\"/knowledge-medium/pr-preview/pr-1838/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1838/chunks/AccessHandlePoolVFS-CmpBzOI7.js\":\"af8175c062fef5b5\",\"/knowledge-medium/pr-preview/pr-1838/chunks/FacadeVFS-ZoYGxfFr.js\":\"b54e2cda93c40419\",\"/knowledge-medium/pr-preview/pr-1838/chunks/IDBBatchAtomicVFS-yAuGJxs6.js\":\"509798dfb44f92db\",\"/knowledge-medium/pr-preview/pr-1838/chunks/MemoryVFS-DxHorfwG.js\":\"4b7f459b60621b2a\",\"/knowledge-medium/pr-preview/pr-1838/chunks/OPFSCoopSyncVFS-CZHpjIfb.js\":\"57b722f0d4a19e1a\",\"/knowledge-medium/pr-preview/pr-1838/chunks/OPFSWriteAheadVFS-B_evK90d.js\":\"7fe9baf591cb9ebe\",\"/knowledge-medium/pr-preview/pr-1838/chunks/Preview-nFbpL4DM.js\":\"8f8a6f1f3320b276\",\"/knowledge-medium/pr-preview/pr-1838/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/card-BTLDSus6.js\":\"0611f5505665dbe0\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-BLcneSJD.js\":\"c3d14371c85c82a3\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1838/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1838/chunks/mc-wa-sqlite-Z9OeqASv.js\":\"d0eaf25bb218ac2a\",\"/knowledge-medium/pr-preview/pr-1838/chunks/mc-wa-sqlite-async-BgpXKL_H.js\":\"8af2bce8ddc67cb5\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-BxMgLxu4.js\":\"a4f41390fa96c954\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-CBNBvyBb.js\":\"8dd41a7d1d2a5b73\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-CmzRkCXv.js\":\"0c037870e3d2a791\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-DkHebern.js\":\"e6e9a7f75a6a9256\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-Dp0CqUX_.js\":\"031e59c453e3f13e\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-DrnDsYJC.js\":\"4cd38f44fd308647\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-DwGvRCZa.js\":\"e72a6c9c0e626892\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-JF95n0JQ.js\":\"f178ecc57830d1c5\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server-legacy.browser.production-BNcwTPN_.js\":\"8892581d1d89cf44\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server.browser.production-DJ6owMsT.js\":\"1fa48fd552d35fc4\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server.edge.production-C3xhLqDH.js\":\"8b856d5caa2a06d4\",\"/knowledge-medium/pr-preview/pr-1838/chunks/server.browser-D49USCOG.js\":\"ef91ec4cab464b35\",\"/knowledge-medium/pr-preview/pr-1838/chunks/textarea-DtEHLtP9.js\":\"33f25cc8ee4b4c3d\",\"/knowledge-medium/pr-preview/pr-1838/chunks/ui-FnR9IJf7.js\":\"6b0b0880a82c3062\",\"/knowledge-medium/pr-preview/pr-1838/chunks/wa-sqlite-DBTW7mS-.js\":\"d1b6fb00976447e7\",\"/knowledge-medium/pr-preview/pr-1838/chunks/wa-sqlite-async-Bnw-RiT7.js\":\"90570f8c161ab3eb\",\"/knowledge-medium/pr-preview/pr-1838/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1838/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1838/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1838/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1838/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1838/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1838/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1838/src/App.js\":\"7d4a5261f595eb9d\",\"/knowledge-medium/pr-preview/pr-1838/src/appUpdate.js\":\"fc2b6a6e1607d3f2\",\"/knowledge-medium/pr-preview/pr-1838/src/appVersion.js\":\"f7a4e3e355605bef\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/initialLayout.js\":\"8a5a000f2bad0428\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/openWorkspaceData.js\":\"9b0a2f2557123010\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/resolveWorkspace.js\":\"d490be643e133480\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/workspaceBootstrap.js\":\"86732ac838fdb3b2\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockComponent.js\":\"9508f2ffb9ef21e4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockCrumbs.js\":\"6eb8a42564ba6756\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockEditor.js\":\"d460a820f835701e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockLoadingPlaceholder.js\":\"021a1421e6ed5a7f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockProperties.js\":\"78eb22dab711e3a4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockSearchPicker.js\":\"2c1b054387ed43e3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ConfirmBulkDeleteDialog.js\":\"4374f8cb013e8289\",\"/knowledge-medium/pr-preview/pr-1838/src/components/DividerHandle.js\":\"9e4d777388694027\",\"/knowledge-medium/pr-preview/pr-1838/src/components/DraftEditor.js\":\"55ee0327ed454608\",\"/knowledge-medium/pr-preview/pr-1838/src/components/GutterPill.js\":\"9205486627e38060\",\"/knowledge-medium/pr-preview/pr-1838/src/components/Header.js\":\"8ea1fede5e0c3225\",\"/knowledge-medium/pr-preview/pr-1838/src/components/LazyBlockComponent.js\":\"e8de4565fa063d32\",\"/knowledge-medium/pr-preview/pr-1838/src/components/Login.js\":\"00c180c794b656fb\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ZoomableSurface.js\":\"4be224724085669b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/editModeKeepalive.js\":\"acf5fdef12d6d51e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e1f2032fabd5e513\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"28feb27d2b98a241\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/RefPropertyEditor.js\":\"18e1f35d6a184526\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/RefTargetTypePicker.js\":\"a5a495f9114005ba\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/SelectPropertyEditor.js\":\"01299ea7d72a8b68\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/TypesPropertyEditor.js\":\"24cf79b0cd0a27e9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/defaults.js\":\"7009b3b731ecf4a5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/kernelValuePresets.js\":\"011af02bd07992c1\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/selectablePresets.js\":\"0ba0629613a22bb8\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/typesPropertyUi.js\":\"5dee0c9091545f32\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/AddPropertyForm.js\":\"cee269d1e2a7b454\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/PropertyPicker.js\":\"349038a68f007bb8\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/PropertyRow.js\":\"88ea127a3b6e42c5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/Rows.js\":\"a4ab637674b499a4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/actions.js\":\"aee593d6a7fe8102\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/declarationOnly.js\":\"80fe102c5da4a2be\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/layout.js\":\"5aaae067936f5fe5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/model.js\":\"4da944f69eafd2ed\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/shapeUi.js\":\"e53fae56f5c349ef\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/shapes.js\":\"9a1f1f415ffe42cd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/usePropertyEditingActivation.js\":\"76c883dc7eda89ed\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/visibility.js\":\"72e31fa60ad2408b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanelSections.js\":\"4fe7f7842b781a91\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockEmbed.js\":\"fbd326ab35c56be4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockLink.js\":\"3cd4ff5384c45e1e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockRef.js\":\"a82955aa321df8e5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/ReferenceLink.js\":\"c1ad40a3903878b4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/cycleGuard.js\":\"d27bb7ab9200c27e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/cycleGuardContext.js\":\"e59fbbdcfef47665\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/linkInteraction.js\":\"8031f60e39e8260e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/referenceLayout.js\":\"65038408ebce9c65\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/useBlockRefAncestors.js\":\"6bd0c768b8b33b13\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockGutter.js\":\"b0fe9e174fe0769c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockInfoDialog.js\":\"2ad4b4f06f4199f9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockTypeBlockRenderer.js\":\"2c880c995ca39d46\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BulletHoverCard.js\":\"e4a877810883a63d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/CodeMirrorContentRenderer.js\":\"e75b788c17d583d6\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"93a298c9620f8c9c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/ColumnResizeHandles.js\":\"dd3ac7d0cfbd2b5e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c5b2f747f297d63d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/DefaultBlockRenderer.js\":\"624fda6a07e82a24\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/LayoutRenderer.js\":\"3ffab39b9e2213d6\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/MarkdownContentRenderer.js\":\"2f95396ef7c9d6ec\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/MissingDataRenderer.js\":\"fe837c687ec37efe\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/PanelRenderer.js\":\"65f7e13402b92b86\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a9db14b032994d33\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/TopLevelRenderer.js\":\"961cf2bc8c40598a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/blockGutterMode.js\":\"c528cef48954da27\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/blockTitleText.js\":\"f675cbbdea5b5739\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/fieldCreationKeydown.js\":\"804b2bb0858471ce\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/layoutRootContext.js\":\"29fc91aff5b2e088\",\"/knowledge-medium/pr-preview/pr-1838/src/components/typeChip/TypeChip.js\":\"9641fee80d2d2590\",\"/knowledge-medium/pr-preview/pr-1838/src/components/typeChip/chipStyle.js\":\"929c133e12937446\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/anchored-floating.js\":\"68e247a508b9e774\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/button.js\":\"eb0aabd20e397ea5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/card.js\":\"736b5fdd8a735292\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/checkbox.js\":\"69f26bc2d6545e3a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/collapsible.js\":\"b6e819a029809a09\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/command.js\":\"f162a5e558cb68c5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/context-menu.js\":\"4e8f8ad04b1bcb88\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/dialog.js\":\"b0ea1309f30555dd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/dropdown-menu.js\":\"99ddd89c22d3ca0f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/floating-listbox.js\":\"5b873f341583ce9c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/index.js\":\"ad19f78c424e23ca\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/input.js\":\"c2339254f874de85\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/kbd.js\":\"50f273a476ddde21\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/label.js\":\"257125a4f0f46501\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/textarea.js\":\"d1994006ab896289\",\"/knowledge-medium/pr-preview/pr-1838/src/components/useEditModeYieldKeepalive.js\":\"c2159dfde2b612c9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/BootFallback.js\":\"c4150dfa5094283f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/FocusedRowLazyMount.js\":\"e1a0f12fe2ece894\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/LazyViewportMount.js\":\"ced87a041ab17dd4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/LocalDbCorruptionFallback.js\":\"90c6c2ee99935702\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/error.js\":\"355742b6c7493b06\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/lazyMountRegistry.js\":\"e0a53dced694d81c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/suspense.js\":\"d44d2d2d4f17f0b3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/CreateWorkspaceDialog.js\":\"711b8b28d8ceb05a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/PendingInvitations.js\":\"3353b30551a8ffdb\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/SyncProgress.js\":\"933316aff7c38b7d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/UnlockProgress.js\":\"e047b7313a8c45e7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceKeyGate.js\":\"e089b04e3acb0597\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSettingsDialog.js\":\"bd71b189ed36551d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSwitcher.js\":\"a077f5a6dee80bb3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSyncGate.js\":\"0d1e9f36840223e8\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/ConversionFlow.js\":\"44b9e97d931fd98a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/ConversionFlowHost.js\":\"a3d7de5287b29156\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/EncryptionSection.js\":\"f1df65a870010ed0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/attachmentPrompts.js\":\"f996f39bf000ad4e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/bundleFolderPrompts.js\":\"daf1baa3d7ca5ff5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/conversionFlowDeps.js\":\"ef9cd039465aad8a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/conversionFlowStore.js\":\"1d07b1c7b1324aa9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/flowUi.js\":\"e14f7afcf83cd9ab\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/useConversionRun.js\":\"3c591951751c13b6\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/keyUi.js\":\"76f25a230aa569db\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/useCloseOnKeyLoss.js\":\"74228924ce6019ae\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/useCloseOnServerE2ee.js\":\"5ac7363ad7be7d85\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/workspaceUnlocked.js\":\"0776ddb8192b9ed8\",\"/knowledge-medium/pr-preview/pr-1838/src/context/backgroundSubtree.js\":\"31bc52baab091cb3\",\"/knowledge-medium/pr-preview/pr-1838/src/context/block.js\":\"c79a19a399cf3e43\",\"/knowledge-medium/pr-preview/pr-1838/src/context/layoutWsContext.js\":\"dcc4d321921dc69e\",\"/knowledge-medium/pr-preview/pr-1838/src/context/propertyDisplay.js\":\"5e796cee561a0867\",\"/knowledge-medium/pr-preview/pr-1838/src/context/repo.js\":\"d693db0bd695ef3c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/aliasClaim.js\":\"a32bb30555efa738\",\"/knowledge-medium/pr-preview/pr-1838/src/data/aliasSeatNamespace.js\":\"6161dedb757c2d21\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/blockData.js\":\"9c545424247925df\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/blockType.js\":\"e87345c1b6c4d6ce\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/changeScope.js\":\"5962311a8f73b3d0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/codecs.js\":\"3a798b85dbb9014c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/derivedData.js\":\"518deda246431184\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/errors.js\":\"5b76784ac348d03c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/events.js\":\"2428a0501dce3321\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/handle.js\":\"aa188733f0f57da9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/index.js\":\"1b0b5edbb4d5eba9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/mutator.js\":\"ed7b27e5c54b84aa\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/processor.js\":\"56d0960e478295a9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/propertySchema.js\":\"f44b30c35be8175d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/query.js\":\"16ba2c2c45cc8fd4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/sameTxProcessor.js\":\"3f8aa03c9d29d993\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/schema.js\":\"aa188733f0f57da9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/tx.js\":\"aa188733f0f57da9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/typedBlockQuery.js\":\"b3537a40bdb848d8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/user.js\":\"cba9396fb51cc470\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/valuePresetCore.js\":\"62c8b7b282e1c874\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/valuePresets.js\":\"ee7c16aaca38c199\",\"/knowledge-medium/pr-preview/pr-1838/src/data/attachmentCleanerIOVerb.js\":\"3816734b1de41315\",\"/knowledge-medium/pr-preview/pr-1838/src/data/block.js\":\"ad6150391512c73b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockCache.js\":\"273f3bbb3d4a45c5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockId.js\":\"bb306cfbdaaaa8ee\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockLiveness.js\":\"dbc725c8321dc013\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockMerge.js\":\"1c3f42f28006c54b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockSchema.js\":\"912f978c511d3430\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockTypeLookup.js\":\"fa0cb732f8fff337\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockTypes.js\":\"3c9d9eb0c19cd178\",\"/knowledge-medium/pr-preview/pr-1838/src/data/clientContext.js\":\"0bfdc81442179eed\",\"/knowledge-medium/pr-preview/pr-1838/src/data/dbFileSiblings.js\":\"b60c4352915f65bc\",\"/knowledge-medium/pr-preview/pr-1838/src/data/definitionSeeds.js\":\"ecdb55bac820b431\",\"/knowledge-medium/pr-preview/pr-1838/src/data/derivedIds.js\":\"bb83120107eeed07\",\"/knowledge-medium/pr-preview/pr-1838/src/data/drawnSubtree.js\":\"396ee3d4e086af19\",\"/knowledge-medium/pr-preview/pr-1838/src/data/facetBridge.js\":\"5ce532de3a9845d5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/facets.js\":\"8842566c86071db3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/globalState.js\":\"81454152baae4cc6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/aliasClaimRederiveProcessor.js\":\"4b0133cbb861c2f5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/ancestorBatch.js\":\"b80e5275d7b28b48\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/blockTypeTypeifyProcessor.js\":\"7a8e4a9c27f1d8d4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/clientSchema.js\":\"06930c9a1efd5670\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/commitPipeline.js\":\"edbd3ad670772ae3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/devAssertions.js\":\"1d2ac97e63911449\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/firstSync.js\":\"951db0ab4848de48\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/freshInitialLoad.js\":\"249a6d6fea253717\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/graphBackfillClaim.js\":\"14fdf150f433f379\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/handleStore.js\":\"c0b2fc4c310856c5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/idleMarkerJobs.js\":\"8573a69420734e7f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/initialDownload.js\":\"935b0a3360e4268c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/initializeClientDatabase.js\":\"8d506a9d5471d18f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/jsonCanonical.js\":\"aa5be2e81bbd4ed7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelInvalidation.js\":\"66f0d680f1ff6c9d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelProcessors.js\":\"379d34ec5863828e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelQueries.js\":\"b0803adecffad628\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/mergeTypeMembershipProcessor.js\":\"24df82756064e5d5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/normalizeReferencesProcessor.js\":\"9fe6e9cbe6bcb8dd\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/poolInstrumentation.js\":\"512cb9629e89ec36\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/processorRunner.js\":\"84a7951118a6b67d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyCellBackfill.js\":\"d4c179b7fa7dad87\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyChildMint.js\":\"f0d5d3d404da8964\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyChildrenProcessor.js\":\"bc108b28f2aefc34\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f1bda3359fc796f8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyDefinitionSynthesis.js\":\"645306e8327e3378\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyKeyScan.js\":\"0de1461c3fae0635\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertySchemaResolution.js\":\"72366142a5501def\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyValueEdits.js\":\"00f46bc1aaaa6b62\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/raiseProtocol.js\":\"bef0e8db4f316800\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/readBatch.js\":\"92159a40c8c7ca36\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/refProjection.js\":\"914f304628053810\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/referenceTargetLookups.js\":\"a48c26b17db5bab7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/referenceTargetProcessor.js\":\"741229ee3699d4d2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/replayMerge.js\":\"e5249e5b2b38a034\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/sqlBinds.js\":\"00eaba5d54843530\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"83b1b75f6812ab3c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/arrivalProcessors.js\":\"16e7b729b377a56d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/invalidate.js\":\"4f13ec852280b8fa\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/materialize.js\":\"319f02e38b9470bc\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/observer.js\":\"95726ffbc71d2d95\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/reconcile.js\":\"5d2e18698b571bc9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/timingMetrics.js\":\"f281485a18074057\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/treeQueries.js\":\"4b442254f2b78150\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/txEngine.js\":\"cb7cbe935eb46d83\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/txSnapshots.js\":\"606268eb2eda98fc\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/typedBlockQuery.js\":\"4dd8bf69ad057c0a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/undoManager.js\":\"171477c2546077b1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/invalidation.js\":\"2767a1d5dee36b89\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelDataExtension.js\":\"53f4b0afd9458107\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelPage.js\":\"3f69a1a8e03ae201\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelValuePresetCores.js\":\"dfb7a3a6ed7b2eab\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbCorruptionSignal.js\":\"501bb85bbcf12197\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbStorage.js\":\"4a6aee8b9f194f08\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbVfs.js\":\"4de47f560b1cc222\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localSchema.js\":\"a30c7f16af6cadbb\",\"/knowledge-medium/pr-preview/pr-1838/src/data/maintenance.js\":\"ae43ce480bd86c16\",\"/knowledge-medium/pr-preview/pr-1838/src/data/mergeProperties.js\":\"1ae6b3405bb2213d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/metricsConsoleHook.js\":\"50487649e6e75262\",\"/knowledge-medium/pr-preview/pr-1838/src/data/migrationsPage.js\":\"53dfd4150e08818e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/mutators.js\":\"88d0cc340c39ce10\",\"/knowledge-medium/pr-preview/pr-1838/src/data/orderKey.js\":\"b8a3e5d37b14a8ce\",\"/knowledge-medium/pr-preview/pr-1838/src/data/orderKeyPlacement.js\":\"8c9ebbd61724f80b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/outlineSurface.js\":\"78ee6dbe07bead95\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pendingEditorContent.js\":\"714ed35453411e88\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pendingUploadsSql.js\":\"63a70014317120b1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pluginStateExtensions.js\":\"dd637b489d54e215\",\"/knowledge-medium/pr-preview/pr-1838/src/data/powerSyncLogger.js\":\"0766a7df16f7bc1a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/projectorRuntime.js\":\"86fb60bd0b2e1851\",\"/knowledge-medium/pr-preview/pr-1838/src/data/properties.js\":\"616112d446678075\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertiesPage.js\":\"02703b8008088429\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyChildren.js\":\"a9605f6fbc082ba8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionFanout.js\":\"97304bb2cac900da\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionMetadata.js\":\"0297d506aea6fca9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionRegistry.js\":\"4004278e75ff3fed\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDisplayMode.js\":\"361a61b54e6cbd25\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyRowCreation.js\":\"3836700ed333faf3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertySchemaCreation.js\":\"e8c8c242c90b844e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertySeeds.js\":\"b878a7ff195e5c2f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/recentsPage.js\":\"0c8254cdcf27094b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/referenceBlock.js\":\"67754060d4de5670\",\"/knowledge-medium/pr-preview/pr-1838/src/data/rejectedUploads.js\":\"004c53a91094c923\",\"/knowledge-medium/pr-preview/pr-1838/src/data/releasePowerSyncConnection.js\":\"e2313e1ed5210027\",\"/knowledge-medium/pr-preview/pr-1838/src/data/repo.js\":\"a618812a23e4b83b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/repoProvider.js\":\"b11aa389675036a8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/rowProperty.js\":\"12e5f02c3328e7e3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/searchFilter.js\":\"6cd58d39f126a814\",\"/knowledge-medium/pr-preview/pr-1838/src/data/seedIdentityLedger.js\":\"7f2ed6677246eaf2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/stateBlocks.js\":\"1afecc0ada916b2d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/structuralEditPolicy.js\":\"adc691179698b847\",\"/knowledge-medium/pr-preview/pr-1838/src/data/subtreeDelete.js\":\"99f335a5994f3d47\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncStreamLock.js\":\"4a2895827678f2b0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncedTableSqlRecognizer.js\":\"5b5bc6b1cc6cca4e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncedTableWriteGuard.js\":\"3d9042186945e740\",\"/knowledge-medium/pr-preview/pr-1838/src/data/targets.js\":\"a42cc299e9535979\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeColors.js\":\"fdf456753b0e14ec\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeDefinitionMetadata.js\":\"fb8bf30e48fcbb25\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeDefinitionRegistry.js\":\"91530fe443f09c01\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeExtraction.js\":\"91a10cd1d3e7d4f1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeInitialValues.js\":\"70eb7d55d425237c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typePropertyGroups.js\":\"637275ba28a77ed2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeSeeds.js\":\"0f4d4bddeb8aab47\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeTagger.js\":\"387c7acb80e4db65\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typedRecords.js\":\"065ecef0b262ed76\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typesPage.js\":\"c7672a666a9b81ff\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userPrefs.js\":\"f43b9be76a841457\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userSchemasService.js\":\"b3c57980b3a4dd80\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userTypesService.js\":\"5d4281c94abe308c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/valuePresetRegistry.js\":\"c9699b2e88d8c7b1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/visibleChildren.js\":\"abe0a6c865355863\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceConversion.js\":\"3c4b6b2c66c3086f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceFirstSync.js\":\"f76c891734819ea0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceIdNamespace.js\":\"b2fc60d853c1a57e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceSchema.js\":\"b60ee9d4656a5edf\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaces.js\":\"97b42c952c6fe2fb\",\"/knowledge-medium/pr-preview/pr-1838/src/data/writeAheadLog.js\":\"ff1e05cbb1207c25\",\"/knowledge-medium/pr-preview/pr-1838/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/BlockPasteShellDecorator.js\":\"16111c245827e046\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/atTrigger.js\":\"9a217dc5720b9aaa\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/autocomplete.js\":\"4e044f99213ad9eb\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/codeMirrorExtensions.js\":\"78659fa0523ab0c3\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/contentFlush.js\":\"2911b3af19336aeb\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/defaultInteractions.js\":\"13f4c45c13a884ee\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/editSettleSignal.js\":\"5b9789c0d09fa44d\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/insertImage.js\":\"7f19c8ca98f9f18a\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/referenceCompletionRange.js\":\"c10548a0f61e5a8e\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/referenceTargetTypes.js\":\"a1e708a56632eef8\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/syntaxContext.js\":\"3c96c780a42c5b09\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/triggerMatch.js\":\"2ac975820dbc9cfe\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/AppRuntimeProvider.js\":\"74d1652e643f9f7b\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/BlockFocusShellDecorator.js\":\"49aaa13b96d61ce9\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/ExtensionRenderBoundary.js\":\"6e32954efc7b6c05\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/PanelContentRecovery.js\":\"f2aa6d74ec4d47ee\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/apiCatalog.js\":\"da3da745b7bd109c\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/approveExtensionHere.js\":\"14c4c94b7e3f5b23\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/armedCutAppMount.js\":\"e897171efbd65921\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/batchableKeyedStore.js\":\"f48fd7dca2153a7a\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/blockInteraction.js\":\"45c6532a45a53c82\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/blockSelectionAction.js\":\"3b762c6c8feb81a3\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/compileExtensionModule.js\":\"9477c16d83ff4181\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/compiledModuleCache.js\":\"364ac0e24cb75b1c\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/continuousGestures.js\":\"7f473e765b9d96ed\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/core.js\":\"98032f41b0b9a954\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/defaultRenderers.js\":\"07dfa8ce39106bd2\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/definitionFanoutAppMount.js\":\"46af3ccb73271ebf\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dialogAppMount.js\":\"a88ba7511e0d18ba\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dynamicExtensionSeeds.js\":\"1007bf56be2e3480\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dynamicExtensions.js\":\"19e5381b0b9f6681\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/exampleExtensions.js\":\"3d4e3596657de025\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionApprovalStatus.js\":\"8a7a6490b13aa037\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLoadErrorToast.js\":\"66f4b4417b3b2faf\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLoadErrors.js\":\"435cf6f180189661\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLookup.js\":\"33eba3b2999aa7c3\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionToggles.js\":\"b3c55161bb18ca45\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionUtilitiesCss.js\":\"efa319575bfefd82\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/kernelPageDeletionGuard.js\":\"ef6893155a09d64b\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/liveRuntime.js\":\"7cddb8c95210f0bd\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/openExtensionsSettings.js\":\"45248f21fa2ab71b\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/overridesCache.js\":\"29844a10c09cb987\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/pluginIds.js\":\"593050d673fd4e69\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/processorRejectionToast.js\":\"9ebc7692c1e394bf\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/runtimeActions.js\":\"1b8d16a27bee86f5\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/runtimeContext.js\":\"03dfde17ebf8df8f\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/staticAppExtensions.js\":\"383ebef1cd26b79c\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/staticDataExtensions.js\":\"cb35fa76001115ad\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/toastAppMount.js\":\"2b4ef1b2c59c69df\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/useOverrides.js\":\"be180c1ba6734f38\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/useShortcutSurfaceActivations.js\":\"92a691e778741698\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/discoverToggleTree.js\":\"cf997d4fe93838fc\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/facet.js\":\"d79af0cac4fc4214\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/resolveAppRuntime.js\":\"f6b5eb9c17c33669\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/runtimeEvents.js\":\"92fb426fc9e585cc\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/togglable.js\":\"3ae828379027bf61\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/variantFacet.js\":\"981efcf574517cb0\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/verbFacet.js\":\"1ecac962dec62998\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/block.js\":\"509fe349f91281e4\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/focusedChild.js\":\"e6127e85333a93b3\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/propertySchemas.js\":\"2fcedbaebe59174d\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/typeRegistry.js\":\"0540d5061451c2ab\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useAncestorCrumbs.js\":\"8147d5c93f4ebf49\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useAutocompleteListbox.js\":\"d794dda15b43e269\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useDebouncedSearch.js\":\"6b9769711637d8aa\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useDebouncedValue.js\":\"2e13f658842fbbb9\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useIsFocalRender.js\":\"6fe6b8b03ec13fb3\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useIsReadOnly.js\":\"697c50f4f942c77b\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useMaterializeBacklog.js\":\"96e1005ad638340e\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useMinuteClock.js\":\"f544d2a244513041\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/usePanelLayoutProjection.js\":\"9738c49187615244\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/usePendingInvitations.js\":\"7701aff8e75efefb\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useRendererRegistry.js\":\"339c592e69b994bb\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useRetainedFieldRows.js\":\"ea58acf3e2c4a001\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useWorkspaces.js\":\"557e90eff4402352\",\"/knowledge-medium/pr-preview/pr-1838/src/lib/utils.js\":\"f565e008ca26489a\",\"/knowledge-medium/pr-preview/pr-1838/src/main.js\":\"f6ee1bafa2d9729c\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/MarkdownImage.js\":\"796a86e7db091e38\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/blockSeparators.js\":\"af751e2719bd8b0e\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/context.js\":\"980d3a63ab39bd68\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/defaultMarkdownExtension.js\":\"21f40ee74d185b80\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/extensions.js\":\"77f9f6933bf695ec\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/renderMarkdownHtml.js\":\"75f937fde2b1cbc4\",\"/knowledge-medium/pr-preview/pr-1838/src/minimal-editor.js\":\"90e5c98a064eb677\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/armedCut.js\":\"cdd70e27e13bedd1\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/captureMediaVerb.js\":\"7fbcfb6daa0e8ca5\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/clipboard.js\":\"1819a7dfff60edf6\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/decision.js\":\"37cdb7b3daf4e6df\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/operations.js\":\"73d565794fe02bef\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/account-header/AccountHeaderItem.js\":\"a2203d2555463dbc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/account-header/index.js\":\"8572a3eeeb16bfbf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"93db0bdc6ec4c8a0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/askAgent.js\":\"0a16668d992bb23c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/askedStore.js\":\"d865e0a0125227fa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3ec19db224f5555f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/chipState.js\":\"cb8206c7539fec5f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2c470695e3b4b476\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/index.js\":\"9fabf51f38cabac3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"66b6dece9013df37\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/schema.js\":\"0b4d9088d8dbd984\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e78abed0a60cdf8a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/BridgePairingDialog.js\":\"353c0eb17aaae59b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/addMedia.js\":\"d8e6c12664cc0291\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b1faf06fa0d76a70\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/block.js\":\"1255653c245238f7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/context.js\":\"4e0d6c37d4d2e086\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c9cb31ac635ddc0b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/index.js\":\"807647e5975a23f7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/outline.js\":\"e2dd8cd4aec1851b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/properties.js\":\"07a35f4fac4aecba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/refs.js\":\"d9d272d1543a67a5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"73a84ad1d9c029d9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/search.js\":\"11f5667049deaa53\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/shared.js\":\"5e7addb569258dd9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"09d65fe99ea20462\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/text.js\":\"1621be46edea40cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentWrites.js\":\"320efafbb8292f09\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/authoringCatalog.js\":\"b40b11b388f2f69f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/blockRefTargets.js\":\"a274cc9e66f31768\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/bridge.js\":\"996c59c31b8c79d9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/bridgeLoop.js\":\"9a9bec3e70c84733\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/changeHistory.js\":\"1b38a819be54ef35\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/commands.js\":\"fb86d5550cf6385a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/commentsCommands.js\":\"a950cc131386f699\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/dataExtension.js\":\"fdc3267e9eb02eec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/dataModelGuide.js\":\"ed5f8c297490df38\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/describeRuntime.js\":\"e8b5ff5de36b9312\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/extensionLint.js\":\"d5be697abafbd05e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/grainAudit.js\":\"15448d7d58be59bd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/healthCommand.js\":\"9092df6ecec1510f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/index.js\":\"af010d623465369e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/presetIdentity.js\":\"08448e9b61c30b46\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8b9d74525df1199c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/readMedia.js\":\"1479baddb8d8e332\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/schema.js\":\"fdf4e5e189d1ec26\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/serialization.js\":\"817a35a202d6db34\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/targets.js\":\"241195cda35154ac\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/tokens.js\":\"11dda96cce0c7e38\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/watchEvents.js\":\"e7032f757420f3fc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/workspaceGuard.js\":\"2f6ae1bd21f8635b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/writeCommands.js\":\"16800b7bf6a77ddc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/AliasCollisionToast.js\":\"1118a65192f35b3c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/DuplicateNameBanner.js\":\"c5baeb494dc5b765\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/collisionMerge.js\":\"5e5fe2cd825b8912\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/dataExtension.js\":\"8c0133fbb29068d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/index.js\":\"4892f30f3984f53e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/mergeCollisionAction.js\":\"c4b4a4e1178cf7ab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/pageStyling.js\":\"0ea5ee23f4992a1e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/rejectionToast.js\":\"9bfd49d75d1640cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/syncProcessor.js\":\"0b163b47baac602f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/actions.js\":\"a13a687210afec3d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/addComment.js\":\"dec1d351d7cfec1b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/anchor.js\":\"af79cbab5c3c2b00\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/anchorState.js\":\"3b18fccb26688ccf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/commentLinks.js\":\"2dc5fcb29c0a71de\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/confirmThreadDeletion.js\":\"015482018830547f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/container.js\":\"985e113b86b9a3bd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/dataExtension.js\":\"3393ad0d05e43e48\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/deleteComment.js\":\"6b83355932b87893\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/highlights.js\":\"37697f78ec1e046c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/index.js\":\"a92fb59382be7496\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/linkedCommentsPill.js\":\"780c008bcf0277bf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/margin.js\":\"eda037b424b165fc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/marginSchema.js\":\"b6ac7c2cad304f7b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/newComment.js\":\"504654446ffabf0f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/ownThreadPicker.js\":\"1681404057534fe8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/placement.js\":\"66171ab1f17276b0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/queries.js\":\"db620a1c87b94ab6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotePosition.js\":\"73f15bf33f578720\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotedIn.js\":\"cf4e7046e0a3ff08\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotedRange.js\":\"a6ea9f60973baafe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/rangeRefs.js\":\"79ba6cf8238dcb65\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readHighlights.js\":\"302968db48d3162d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readSelection.js\":\"46becaac9610b5a9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readSelectionUi.js\":\"6ef51b8e2fb624ca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/reanchor.js\":\"fd50d8e9f3f0905e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/schema.js\":\"8eedced6beebdd64\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/scope.js\":\"ebc48713b21832c4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/scopeThreads.js\":\"b86b49ff35ce9c0a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/splitRetarget.js\":\"9abc23b18dd603ce\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/suggestionCard.js\":\"238115fd49d42498\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/suggestions.js\":\"9de5681e92ef9196\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/summaries.js\":\"da2089042152a7a8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/summaryBatch.js\":\"ce22fb02ec8167fe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/surface.js\":\"e71cd2b73bfa455d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/threadNavigation.js\":\"4efd7d2b99dc04b6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/threads.js\":\"a53825fe3ad40358\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/ui.js\":\"3b32228e59c635c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/uiStore.js\":\"fa1e927433398915\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-intents/appIntents.js\":\"c7892eaabf5f9e53\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-intents/index.js\":\"23bd51b08a7ae659\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-update-prompt/index.js\":\"764f0f5abdc9c73e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-update-prompt/status.js\":\"848cdcd7749afc49\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"cc479508705c2bf0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaBlockRenderer.js\":\"0ecd04eb650d2163\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b941b8d1e07b14e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaUploadReconciler.js\":\"70188dce3fddf76f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetDownLane.js\":\"c39dc1beb9cf1a09\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetResolver.js\":\"9f685db4a4c0cd50\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetUpload.js\":\"78d4a9b77940cd7a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/attachmentCleanerIO.js\":\"5043cf5337ef6014\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/supabaseAuditIO.js\":\"afa766b34ae1c572\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/blobStore.js\":\"fe2764feac018f9e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/byteStore.js\":\"539dbd4e3a3711ce\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/cleanerIO.js\":\"4bc7ef1444aa3957\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/cleanupAttachments.js\":\"563810924186dcca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/dataExtension.js\":\"0ff86fdd61abbd19\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/downLane.js\":\"1c65bac7ec7ef227\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/index.js\":\"c57d3adc7dfae0d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/insertImageContribution.js\":\"066fd5122511a5ea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/laneArming.js\":\"8021be1fd1620921\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/laneLock.js\":\"4b1adfaad8c4bc84\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaBlock.js\":\"a620c53651356295\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaCapture.js\":\"8b4464467b39009c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaViewers.js\":\"988f542f8896363d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaViewersFacet.js\":\"3931d21090134219\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/pasteCapture.js\":\"f249c993725b2752\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/resolver.js\":\"c7a083d256c78df1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/retryUploadsAction.js\":\"5c2d18700152b81d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/storagePaths.js\":\"a9ddd8e44dec4c2a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadDrain.js\":\"08832edc5b3afd36\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadLaneStatus.js\":\"760a58017d267869\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadReconcile.js\":\"4ba54219764b44ba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadRecovery.js\":\"2733d6c6c3550ff8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadStore.js\":\"46a0e12d84150b10\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/useAssetObjectUrl.js\":\"e904012fde4f768e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"31a02627ad2561ed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c8b0f00c92878cde\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/facet.js\":\"b7fd921f43603412\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/index.js\":\"b3f747711f16b4c0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/prop.js\":\"df4c1a2b23563778\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BacklinkFilters.js\":\"4f4edf898774e0b1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"bb2f4ed927f848e6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BlockEntry.js\":\"6d4595e0580f390a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/LinkedReferences.js\":\"b6aba246211e4a5d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4808b2f0711526a3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/dailyNoteDefaults.js\":\"d1e2330136307073\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/dataExtension.js\":\"d0cd68e1edcc51bc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/edgeExclusions.js\":\"49f638a01e747796\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/filterProperty.js\":\"649ac4db1a59c245\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/index.js\":\"1af03c949cea4268\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"fc434e1705b5cf98\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/applies.js\":\"8da8f28cdc91b1ed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/countQuery.js\":\"291ed13bfcd6b986\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/expansionStore.js\":\"833ec7bb24df4589\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/index.js\":\"8a084d80b27afd9e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"29a24d431db6576b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/presentationInvalidation.js\":\"461c89adbfa969a3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/propertyEditorOverride.js\":\"d40de7a51491fd43\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/propertyFilter.js\":\"ff7701b40a29f28a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/query.js\":\"dacefe420b3d78af\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/resolveFilter.js\":\"ff436ed1375f9889\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/sourceBatch.js\":\"f273774f5b169611\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/sources.js\":\"1681bb80061e20f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/useBacklinks.js\":\"35d22249cdf93dbe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"db48645776290a37\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/BirthdayCelebration.js\":\"1fc9061c259d98a6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/BirthdayOverlay.js\":\"387c6034dbe1b919\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/gate.js\":\"3a19573187934259\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/index.js\":\"d72af82a040aea3a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/wolfTheme.js\":\"f89c4ca729757210\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/BlockDragLayer.js\":\"437585161edb9554\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/dragController.js\":\"87b5c8b97085e47f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/dropTarget.js\":\"9fc8c74a7f89c22e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/index.js\":\"0b7b8b65352ec0dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/projection.js\":\"ce52031b3e3a0012\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-info/BlockMetaCard.js\":\"ab3a6fac155cd51b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-info/index.js\":\"d83d51dfa8927648\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/AddTagDialog.js\":\"5cea4317ae0f3a90\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a71a1984799a1597\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/TagNameIssueHint.js\":\"82ea62d0edf01eb5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/addTagAction.js\":\"1e3ec5157f9c074c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/appendTag.js\":\"6b8f4c065a4db721\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/config.js\":\"89a87ae187280b12\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/dataExtension.js\":\"1cfe72dcc90c1ef2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/index.js\":\"5fc67d3ab9832540\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/propertyEditorOverride.js\":\"866695777d135fdb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6c67fcc666829cab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a0f9b894b390c731\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f411b1f354ad0125\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3fce6a6603c99683\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e1f71bcedce6a390\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/index.js\":\"675bff9f82d78496\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5137ef205a6eaeae\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/CharacterCountItem.js\":\"af074fd515aefb1c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/ProfilePropertyEditor.js\":\"4b4cac6adb481b89\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/actions.js\":\"4209b01aa9daa29a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/blockType.js\":\"2c7676250850842d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/charCount.js\":\"1652ccaf6ddc2761\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/dataExtension.js\":\"29c1c50d27b14baf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/index.js\":\"3706818aa9ffa130\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/profiles.js\":\"f9075df97623bd07\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/properties.js\":\"0e9c2295fc3edebd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/textCounts.js\":\"23ae203f78b05764\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/colemak-keybindings/index.js\":\"7b95272eaea4c797\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/CommandPalette.js\":\"ba69d69ae0d89637\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/HeaderItem.js\":\"3e0b83ca6ad31c34\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/context.js\":\"e44ba9b94074f649\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/index.js\":\"5bbcb038a832a562\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/selection.js\":\"0d6e9807d7fc0fef\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/toggleStore.js\":\"9f98ca2a8a614c40\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/useCommandPaletteActions.js\":\"ce517493c8abc236\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/ContributorBadges.js\":\"a8e05b3309c476c8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/author.js\":\"8e8321e36b44e2c6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/codeMirrorExtensions.js\":\"92a6b87f061022dd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/dataExtension.js\":\"26d1d6da53b12061\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/index.js\":\"774a807c33739ed1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/mentionAutocomplete.js\":\"d74ea11a57b9a20f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/processor.js\":\"bb4b266c673b830f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/profiles.js\":\"c8c8788d8489689b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/queries.js\":\"5c24e6a932533a54\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/schema.js\":\"01dbfc1cc0acd0c8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"26f5502c4c9fa3b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c15d1036dd846c2d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/index.js\":\"b90c61ceb167a1d2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2dd235275cfda9be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"88ed69630bc4fab0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/CalendarGrid.js\":\"ce551e89d00d706e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DailyNotePicker.js\":\"1d8661c694fdc0f2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"979dbd06b44f4f88\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateNavDecorator.js\":\"25912be82ef5aaa2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateScrubOverlay.js\":\"1a9b186c1a9b7103\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/HeaderItem.js\":\"c5a2c1d68a60f5fe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/ReschedulePicker.js\":\"18b715ccca359d69\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8c9ff5f697386b40\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/actions.js\":\"eb5e7ba53e174ad3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/blockDateAdapter.js\":\"ae7def38490e50e0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/calendar.js\":\"d42f3a4335bf5c2c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dailyNotes.js\":\"0b223832fb6122ac\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dataExtension.js\":\"2f88c04670f5fd7d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubActions.js\":\"0388998cf2eeaa19\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubGesture.js\":\"668e0e286abfaade\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubGestureActions.js\":\"aac115a596c52c84\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c09d8afc55d4936a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/deletionGuard.js\":\"bb64c45a5ea35bd1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dueQuery.js\":\"6b87f8e9e5418a06\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/index.js\":\"024582e2fcbf9025\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/landing.js\":\"5648f6a2b187712b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/localSchema.js\":\"3c0cfc1d2219cb77\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/referenceDateAdapter.js\":\"28962712a9eee040\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/rescheduleAction.js\":\"34b40759e377aa81\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/schema.js\":\"b1371f14e9310ade\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/spreadBlockDates.js\":\"e28083c5ac0fc7bc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/spreadDatesAction.js\":\"38cebf1a81aedb38\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/today.js\":\"ddc05521030f8e99\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3a6458fd65fcfc45\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"fec7e20e99bdc8fc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/audit.js\":\"286f56d782be6a05\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/auditAction.js\":\"af37099f3528e2d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/auditRanges.js\":\"204617d1404e20e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/diagnosticsSource.js\":\"6164e3adbad80144\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/divergenceScan.js\":\"7c6fd6e56015762f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/index.js\":\"e70dd10b63b08325\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c6951f0536e3e995\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/referencesMirror.js\":\"4ce0cf65a50197f1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/rowJson.js\":\"5497e6cab2d33a82\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/schedule.js\":\"5afe678ab467d07f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/store.js\":\"234f2d6a27a15a8f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/action.js\":\"dba20afdd84cdcb8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/index.js\":\"ab7483a8a8b1ffd7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/plugin.js\":\"35c8a70a5b700d8e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"cae3724ef6b4c0ba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/actions.js\":\"6c2c4bfb49959c49\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/changeMarker.js\":\"fb3307d17c6cfa2b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/diagnostics.js\":\"4d82e4b9dd96d198\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/fileSystemAccess.js\":\"b58dc38e091c5bd2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/filenames.js\":\"f0f8e63f269a5460\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/index.js\":\"077dad45c22f0705\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/mirror.js\":\"43e574e745c47739\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/runLock.js\":\"517bd33bb858dc8f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/runtimeHealth.js\":\"8e43a00889d411a5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/schedule.js\":\"562979e34a148264\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/store.js\":\"aabcf8d6aa699f2c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/default-themes/index.js\":\"8223268ff3abf68e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/default-themes/themes.js\":\"e25f3c99b10eb63f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/diagnostics/facet.js\":\"f3d9d9cd7bf79886\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/diagnostics/useDiagnostics.js\":\"9e21e61c0a32d82b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/dismissals.js\":\"1a73c75d80ba6797\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/index.js\":\"9994b3be8f57d07b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/status.js\":\"77b80bd11466f1fc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/store.js\":\"20240a22abae563e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5c0938da170f8136\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8c56788a4d3a201b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/actions.js\":\"4421e4ebf2c567e9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/config.js\":\"d3d244408dcd6602\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/dataExtension.js\":\"7c13b93bcd665282\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/effect.js\":\"7304d73c66a0cef5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/index.js\":\"6e2cfeaa1e8a8bc7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/propertyEditorOverride.js\":\"4b6e05fdced3bedf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/useToggleTree.js\":\"d6d0bb2f3b83aacc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/ExtractTypeDialog.js\":\"088f22085b871f41\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"3e87604e1756cf96\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/PropertyShapePicker.js\":\"26c3c5d4d0ff1ea6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/action.js\":\"e61b95d8a2e681c8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/index.js\":\"68507a5f2d942505\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/FindReplaceDialog.js\":\"72a86c8c5be38614\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/HeaderItem.js\":\"1f9175eb7ac5052e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/dataExtension.js\":\"3a306d0981e4e83c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/index.js\":\"8787aae575ab78aa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/search.js\":\"4b3beed33c87845e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/toggleStore.js\":\"7aeec5c4d12665d2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/LocationPropertyEditor.js\":\"38acbe7325fdb90b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/MapView.js\":\"cc58ca11342c7f10\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/blockTypes.js\":\"f896085697cf07f8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/codeMirrorExtensions.js\":\"897f38559e2cfc3c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/createOrFindPlace.js\":\"29944abeab9683ea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/currentLocation.js\":\"6b3336836b837c15\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/dataExtension.js\":\"14c7df3ebefe1a62\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/geoContentDecorator.js\":\"5e226ab3979c2bfb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/googlePlacesClient.js\":\"161981dfb1f50c0f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/index.js\":\"3b83652af1d2a611\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/locationsPage.js\":\"f338b590a99e66b2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/mapViewport.js\":\"b0528b04fd45d103\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/pickCurrentLocation.js\":\"f00d550f3a767e95\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/placeAutocomplete.js\":\"7bb87cdfafe9871d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/placeNameCollision.js\":\"e35a15de43b81b3f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/properties.js\":\"0aacd8f198590db9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/propertyEditorOverrides.js\":\"9201db7bab9b75f4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/query.js\":\"ba85329250c97ff3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/usePlaceSearch.js\":\"c83cfadc5156894c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f7c7b8ce9008ec12\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"8bf331e0af1f644c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"296903650000e230\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/config.js\":\"163aedba4358c947\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/dataExtension.js\":\"77bad74f23e6c703\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/facet.js\":\"ec8a25c09102f205\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/grouping.js\":\"c95c0f5e72fc346b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/index.js\":\"c444c70977acd2a8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"02b2af9370097c28\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/query.js\":\"25c66a799f4ccadf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/resolveConfig.js\":\"56dd6eaa9c1070db\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2a37d9b70b30472b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5c01ee6b2adc89cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/HtmlDocumentContent.js\":\"d6d8c6bdd1c4c7ea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/HtmlFrame.js\":\"c70d00eec473361b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/actions.js\":\"0da613b9a56605b4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/blockType.js\":\"3ba83a89e9cf284a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/confirmRunScripts.js\":\"1836d32bc87d11b4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/dataExtension.js\":\"ecfa242f15388159\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameAnnotations.js\":\"2c6e5fd755e0254a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameDocument.js\":\"6df77c2f02979025\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameTheme.js\":\"1f91682e2223b481\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/index.js\":\"96d8d00c0db8a68d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/scriptConsent.js\":\"a9dc280d360ce9e4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/sourceMap.js\":\"cc686758a26e1a42\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/useDocumentScripts.js\":\"343e206b36b890e0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/index.js\":\"a580b999874c7dbc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/record.js\":\"b45dcf7890c832b9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/recordStore.js\":\"49b33e9055a709f9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/responsiveness.js\":\"a771180dc4897e83\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/schedule.js\":\"7796a88071a6c762\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/sessionContext.js\":\"aec0f48b48e1fac3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c510f339b6a3616c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"aa11ca7a0329868b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/actions.js\":\"88bb7ec361c7444b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/config.js\":\"88523587d729ce10\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/dataExtension.js\":\"18cb8dd0f393b60c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/effect.js\":\"2a2c615874bf7aad\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/index.js\":\"455966022af56736\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/keyCapture.js\":\"5e9596d33d0f9331\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/overrideStore.js\":\"0de06d167f67ed88\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"31de8ff33c1e0ae2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/HeaderItem.js\":\"652041f827c7f3a7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/LeftSidebar.js\":\"d884738cc4dfec01\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/actions.js\":\"70df35e50d958a1a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/facet.js\":\"79e3e71130ca88c1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/index.js\":\"79de369fb3cfbfa4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/shortcuts.js\":\"cc6415e53a90cb00\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/toggleStore.js\":\"07c3a648b4e910d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/MergePicker.js\":\"0f650c72497ead23\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/index.js\":\"73ae6e42bff8e09c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/mergeAction.js\":\"22353e04cf54819d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/strategy.js\":\"3511848ac9ae8d6b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/Button.js\":\"821c0a1572ad659e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5f0f4bcedb483173\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5a3dffdfb0f071c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/facet.js\":\"c31601529d760470\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/index.js\":\"6bbd1355984f2e47\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b39f4183066b2303\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d8da1e7598f8a8ff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"96ede75da6445ad0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/facet.js\":\"023767ccc9a7c585\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/index.js\":\"9f3dd25a86238ddf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2a692eda31037245\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/blockSubtreeMembership.js\":\"44793ba96a06ccc2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/contextMenuItem.js\":\"639082868b846c09\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/index.js\":\"1970e43cfc017e70\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/moveAction.js\":\"694e1a8b59211eba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/moveBlocks.js\":\"ae9a270dff2768f1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/selectionAfterMove.js\":\"2228bb57bb66560c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/TutorialBanner.js\":\"d6a4a10888ee4a44\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/action.js\":\"4b8ba9fb7449d44f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/bannerDismissal.js\":\"28248990d60421b2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/documents/cheatSheet.js\":\"ba6de65096633bed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/index.js\":\"541a8d8a22add825\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/keys.js\":\"8496712e6a72eb17\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/landing.js\":\"3071251f237e5c25\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/outline.js\":\"ff8e7c2af9282148\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/seed.js\":\"32c3befda4f5927b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c82c57f6d75978e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/analyze.js\":\"57b5988a534e634c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/diagnosticsSource.js\":\"6325c8b6003078d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/index.js\":\"0dcc46d68b83f252\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/load.js\":\"cfb83d14e74fa971\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/monitorRun.js\":\"27e593280005e475\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/schedule.js\":\"19849a68596eba33\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/series.js\":\"4cb903bbab9e31bc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/store.js\":\"10ea812f843f6f2d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/trendAction.js\":\"6b3e842ab1b55dd5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/verdict.js\":\"81a679e08cdc2bb8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/clickToEditAction.js\":\"626f845173a0ed9f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/index.js\":\"68c5a40f43d0056e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/interactions.js\":\"ca86a95910db5e40\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"fb7159fb1b1d7f89\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/MigrationGate.js\":\"3395ab241e885611\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/MigrationGateDialog.js\":\"571267cfaab2097b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/action.js\":\"48ba9a773a8114b5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/index.js\":\"3b993c6f1aad58af\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/localRunMessage.js\":\"4a176f8cceb3e255\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/plugin.js\":\"d072e1ad15464197\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/progressReport.js\":\"e47feb5c4a7419f9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/sweepProgress.js\":\"ef02deec1cb2164e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/FieldRowRenderer.js\":\"4a82241e03ba02d5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/ValueRowRenderer.js\":\"b72eaf385395d6d7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/actions.js\":\"2453d11cf8851428\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/autocomplete.js\":\"f58e570bd6d0cb5a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/fieldRow.js\":\"7f22d5537aef4c9f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/index.js\":\"619ae3bf846f984b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/referenceWarning.js\":\"be44353c07d51a84\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/valueAutocomplete.js\":\"7b79c12128618c9b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/valueSchema.js\":\"fc7c665b497d49d3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/HeaderItem.js\":\"5529e5083a0160af\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/QuickFind.js\":\"80b21fd0da534d13\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/index.js\":\"c293d80b57953ce2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/recents.js\":\"9556f7b3a30af275\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/resultItems.js\":\"93627cf69739eab3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/selection.js\":\"749d7934ce03236b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/toggleStore.js\":\"af83256b9ae5a2cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/HeaderItem.js\":\"2f57cc5fc5cdbd60\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7d94d635768e4765\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/grouping.js\":\"4c7834b8c5975660\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/index.js\":\"3dad086d02f175d3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/target.js\":\"f6dc2e04dbfd5b4a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/codeMirrorExtensions.js\":\"58f8915003be3d2e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/contentPrefill.js\":\"e9b10b9002170502\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/dataExtension.js\":\"41fac732a8031ca5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/index.js\":\"6edb65d84d58b1e9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5b044ee3675943b2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/invalidation.js\":\"8ed51ec22785a4d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/localSchema.js\":\"6341c041778c3fab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/blockrefs/index.js\":\"01e4bc7a970ce724\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6d8f73e4272e8034\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/index.js\":\"2dd6591df6ac4f3d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/referenceNode.js\":\"d452b4d19b4054e8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5d5b61a84998fd55\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"4d4f83f34709f32c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/index.js\":\"8a97659ce1084613\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1a79913c3cc9cc00\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2ac1d2f18695cb4d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/mergeRetargetProcessor.js\":\"6e6979c8eded6e80\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/parseFence.js\":\"145cad8f08036c62\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referenceParser.js\":\"4bc5eb5189987dc3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referenceProjection.js\":\"42ea799dc82919e3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referencesProcessor.js\":\"b1cade06e70162cf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/renameProcessor.js\":\"c475720313089a69\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/spanReplacement.js\":\"59f8d42a6ab3a9e5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/htmlToOutline.js\":\"1eb2ea82512edacd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/index.js\":\"a25c902c90b64751\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/normalizeClipboardDom.js\":\"318c3b079d49cb7c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/pasteDecision.js\":\"d7fa51193f19e716\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/action.js\":\"f0d1a4d50a7d9430\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/blockIds.js\":\"40a65dc4f05ec254\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/content.js\":\"ac766b2e7e42e127\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/effect.js\":\"4ef4aa9146a708ce\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/ids.js\":\"18f32aab77185a63\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/import.js\":\"de019b4ad272b1be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/index.js\":\"fc6dd329df635829\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/plan.js\":\"7c29db7acd8f6a91\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/plugin.js\":\"929e0f33455473f5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/promotion.js\":\"0b8d6f41dd1bae88\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/properties.js\":\"15e2396bab8f2610\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/references.js\":\"56e10baab81e6cd4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/report.js\":\"311548a0b7e94ab9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/roamMemo.js\":\"6d010298c004943d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/runtime.js\":\"1a5c3578c2bd7136\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/schemaReconciliation.js\":\"e104d3e6a7b66492\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/srsMarkers.js\":\"049d0f6353142109\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/todo.js\":\"542621718a3f9ac8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/typeCandidates.js\":\"71800e3e485b3094\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/types.js\":\"17c48e822fd41deb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/search-health/index.js\":\"0a76311a99c0f221\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/search-health/store.js\":\"fd8dd6922c4c4073\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/HeaderItem.js\":\"790f524a9c6976ae\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"fcd31c14174dc28d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/index.js\":\"750264a84ddc79d6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/model.js\":\"5f06ed4097cc19cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/toggleStore.js\":\"2e3b85e7e4fb31e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/useKeyInspector.js\":\"806afdb14659a09b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1e1a1115651b0c9d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/ShellDecorator.js\":\"dec7e45224dea9b4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/actions.js\":\"2552d1d4acfe1df1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9d1d01746b1e487e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/index.js\":\"ecd01be96c15a13a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/shell.js\":\"ef191359b40b7079\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/surface.js\":\"b820390a53703b72\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/walker.js\":\"534b22fb62b76040\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/RescheduleToast.js\":\"736f32d3de211b81\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/dataExtension.js\":\"f6c3caa5bd4ee073\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/index.js\":\"7cd0fa5888b96180\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/indicator.js\":\"17d8cd4613aa9715\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/moveSrsState.js\":\"82ed1f20a6e230db\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a2b885a540a49c1b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/scheduler.js\":\"7bf1a7c9263ec446\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/schema.js\":\"49559a9a3ec2f92d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"eef73d69174b7a52\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/srsClipboard.js\":\"e4f1ac9459e8b968\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"8dbdafea49c24e4d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1f602d317a7bbb30\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/DeckPicker.js\":\"62dfab370ea52129\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewControls.js\":\"950c75c2f4e81b40\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewDeckRenderer.js\":\"98393a7477aac925\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewSession.js\":\"8bb50edcf2243c21\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/actions.js\":\"b4f72d9ac579cbbc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/archive.js\":\"1f89c1fe6699ab57\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/dataExtension.js\":\"8509233fd19d15e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/deck.js\":\"a88a12c1560f4290\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/dueQuery.js\":\"f8b76817fe12a041\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/gradeDecision.js\":\"f73d8d364ac882ca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/index.js\":\"98ad3e714376b34e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/keyHints.js\":\"0aaa40539248f7ec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/reviewCardLayout.js\":\"d0fd8e2725cfdf63\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/reviewProgress.js\":\"1c08af1794338479\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/schema.js\":\"1edec02d5448b973\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/useDueCards.js\":\"6c90806a6684681e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/startup-metrics/index.js\":\"3ec45d5dedcbd57b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/startup-metrics/record.js\":\"5a3b3afb1b089827\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/index.js\":\"f0e13d7c6cd47d77\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/persistenceStatus.js\":\"ee687a467b419869\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/requestAction.js\":\"05044e5075478b5f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/TypeChipsDecorator.js\":\"939b103984d1550f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/codeMirrorExtensions.js\":\"2a69df95a01eb1e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/index.js\":\"7d792b323abd9fec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/typeAutocomplete.js\":\"159fae456fa04f6b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2a53f04ed24bee9f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/actions.js\":\"5d075d2f4921b95b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/anchor.js\":\"a9ea7512f4c5c779\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/events.js\":\"bbaa321361058c3e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/gestureActions.js\":\"bedb1a8d5122d0a5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/index.js\":\"f2a3edce1653d155\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d008a66aaf49ec34\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/collect.js\":\"4c0396a90f1dad62\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/index.js\":\"cc87df2b888d25cc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/record.js\":\"197956db4d819032\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/RejectionDialog.js\":\"36bf5e2195fd26bf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7a48dbbd5a342763\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/index.js\":\"a75d41d511628dfc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/model.js\":\"f41cd51f13de0eaa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/queueCounts.js\":\"4d7131549d973f8e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/rejectedHelpers.js\":\"251b8c98ad922a9d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/rematerializeAction.js\":\"b463464a72da8d06\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/useHysteresis.js\":\"cef3dc9047ada03e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/ColumnHeaders.js\":\"ef045f89306a2aa9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/QueryUi.js\":\"19b4d118937a62c3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/TableLayout.js\":\"6d629a170b75a10c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/actions.js\":\"4602ed487111f3a1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/cellEdits.js\":\"c0169cc2aaeeb579\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/columns.js\":\"7cfba321885e952a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/controller.js\":\"bbe344a6ac6abe1e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/convert.js\":\"b114a3dff3ab3d1f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/dataExtension.js\":\"0b2c6a7dece65b8a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/index.js\":\"cce2a9a59ddcdc75\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/keys.js\":\"143c54aa15d92161\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/model.js\":\"ee62eab16f536b6d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/backfill.js\":\"92c5a572366396cf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/format.js\":\"c552ccbfdad5f20c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/parse.js\":\"2f7b40c39e9a9800\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/queryValue.js\":\"6ef45365a1375a2f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/source.js\":\"5ab5400913982b1f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/registry.js\":\"fb6418ca532ec274\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/schema.js\":\"4428de32b0785c0d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/sort.js\":\"ceb7b96e570fbf11\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/effect.js\":\"cba21a052cbd2838\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/index.js\":\"3f2b699f05cde3f6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/theme.js\":\"e4d79e79018b7930\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/actions.js\":\"03a152d53e4ce08a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/dataExtension.js\":\"be5e657ee225751a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/index.js\":\"e07897cf2b1823ec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/schema.js\":\"bb8dcfe3a24383c4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f24751c22d8c47a9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/actions.js\":\"7fdc0b4b5daf5d2b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/defaultItems.js\":\"5116764763ae879a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/facet.js\":\"ccf2da3c1f05242e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/holdRecognizer.js\":\"0fc8b537dd73e77f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/index.js\":\"42885a00e36406ca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/UpdateIndicator.js\":\"413309d3692f26f2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/index.js\":\"ef0bf27e604acbe7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/loadTimes.js\":\"4b67d732d67af047\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoNotesRenderer.js\":\"2e178bf30bc9adee\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoPlayerRenderer.js\":\"8591ee8a5a5ca7de\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoTimeStamp.js\":\"8bb56ed7fe9ce18d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/actions.js\":\"88cea6846512fce5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/index.js\":\"dc29ba2e724a461f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/markdown.js\":\"d5d9b15d70cbc578\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/notes.js\":\"486a91d714010279\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/registry.js\":\"b1fdf48a2ef6bb4b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/remark-timestamps.js\":\"84265502664588df\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/view.js\":\"3281a5c0b82a95be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/LinkHints.js\":\"3b8d088dc3fb81c7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/index.js\":\"196da1798dce46e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/model.js\":\"40018dfc657f923c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/settings.js\":\"f13421c40e6f00be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/actions.js\":\"2609d863f3b8e22e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/index.js\":\"7664d96f9369685d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/interactions.js\":\"21ccbbd18b9dc831\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/workspace-header/index.js\":\"5883c9a34a7e9435\",\"/knowledge-medium/pr-preview/pr-1838/src/registerServiceWorker.js\":\"fa32174ce2401eac\",\"/knowledge-medium/pr-preview/pr-1838/src/requestPersistentStorage.js\":\"0df5051577bfeb0f\",\"/knowledge-medium/pr-preview/pr-1838/src/services/authRequestDeadline.js\":\"7737bf609fb40e0e\",\"/knowledge-medium/pr-preview/pr-1838/src/services/authStorage.js\":\"19a3478ea1304cdd\",\"/knowledge-medium/pr-preview/pr-1838/src/services/powersync.js\":\"6d3fbb90f4af9223\",\"/knowledge-medium/pr-preview/pr-1838/src/services/supabase.js\":\"3de7d271d346c31e\",\"/knowledge-medium/pr-preview/pr-1838/src/services/uploadErrorClassifier.js\":\"0d398a73e40b5f0c\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/ActiveContexts.js\":\"a7fe4be9053521fc\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/HotkeyReconciler.js\":\"75fdaf4d2dd47d9b\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/WipeLocalDataDialog.js\":\"b4c1d547a81244b8\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/actionDispatch.js\":\"8f0bfda7ad37cc9f\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/actionRefItems.js\":\"d07c587ffd3f5f62\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/applyKeybindingOverrides.js\":\"ec55c19a6b39ec98\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/blockActions.js\":\"eef8fe304e06c220\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/canonicalizeChord.js\":\"aac9dda8178d1a6e\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/defaultContexts.js\":\"1348079d807603fe\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/defaultShortcuts.js\":\"3e6511f3b815f03e\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/effectiveActions.js\":\"01b8e644f296ef27\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/gestureAction.js\":\"fbb0b14b0fe196f7\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/gestureBinding.js\":\"afa7a4d7f7d38096\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/holdRegistry.js\":\"80d4990ce5caa2ba\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/keybindingConflicts.js\":\"1130f48058f31f70\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/keybindingOverrides.js\":\"ecc42eb470d2e005\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/pointerAction.js\":\"460ebd7a0c822436\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/resolve.js\":\"4086a7e79dd7f3d3\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/runAction.js\":\"325c71d9470764b8\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/sequenceMatcher.js\":\"5de29026abc5a120\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/types.js\":\"07c44252416d13bd\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/useActionContext.js\":\"24a87192a22632f7\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/useActionDiscovery.js\":\"b1c51399ed95e5d7\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/utils.js\":\"9dfecd78d6d6a6d7\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/bootStore.js\":\"dc9ebd8a5340726a\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/previewDatabases.js\":\"63f749412eb4c935\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/byteTransform.js\":\"f85d5f39bfc92f83\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/attachmentCleaner.js\":\"15dcfd49c5c52f06\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/attachmentParts.js\":\"bfaa25a713bec866\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/bundleParts.js\":\"c13008e5c4bda739\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/bundleRecord.js\":\"d414cca99cf406d5\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/manifest.js\":\"fca7a0c80b13b0c9\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/takeBundle.js\":\"283806ff86d30979\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/verifyBundle.js\":\"8062743b19589075\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/cleaningStage.js\":\"6799229034666797\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionKey.js\":\"4ebcae0c0ea05bc7\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionServer.js\":\"8ecdc88d713854bd\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/flip.js\":\"2259b787b87e6048\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/flipAttempts.js\":\"454de59130249e66\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/pages.js\":\"c28de6a5ddb5b30a\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/preflight.js\":\"0d953ac3f6fda00f\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/reseal.js\":\"ddcdb1c6f6333017\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/runConversion.js\":\"42b5032de36fa1cb\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/runLock.js\":\"9d1c754af9f25d3a\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/sealing.js\":\"7d57d5b65dc10c12\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/sealingStage.js\":\"16247a729ef0dbf4\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/stage.js\":\"e5b8596028e295b2\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/verifyReseal.js\":\"784f196622498594\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/aad.js\":\"3aef576283f7a3fb\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/aead.js\":\"147374b72cb97864\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/base32.js\":\"1690d846c7506b3a\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/base64url.js\":\"5eff17d45a3ed6c6\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/binaryEnvelope.js\":\"42b464416c31b176\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/byteAead.js\":\"e3606247d05fd548\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/canary.js\":\"b9b2823604f8d193\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/contentHash.js\":\"9c4761eb0af2fbc2\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/contentKey.js\":\"ba0fab8a630a4531\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/derivedIdNamespace.js\":\"089e3a40d221bedd\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/envelope.js\":\"5858c25fbd86cce5\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/hex.js\":\"819d79bd073ec108\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/sha256Hex.js\":\"6e9a46522623b763\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/workspaceKey.js\":\"5938ccf135b52f30\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/conversionState.js\":\"a415a1464a100dfe\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/createEncryptedWorkspace.js\":\"dfac25b88808cd76\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/pastedKey.js\":\"47762cee04ceb231\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"20ebf59b83802cb4\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e4a682444118e00c\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/keyStore.js\":\"6345a188816e76b3\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/mintWorkspaceKey.js\":\"748e7e18bc5671db\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/modePin.js\":\"10f4e6a307d0597c\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/openWorkspaceKeys.js\":\"ae70851064762787\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/resolveWorkspaceEntry.js\":\"d561e35a3ad72a8e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/resolver.js\":\"f3852f4b24804461\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/workspaceAccess.js\":\"e440d5d6698495dd\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/transform.js\":\"ec286e3933c522fb\",\"/knowledge-medium/pr-preview/pr-1838/src/themeBootDefaults.js\":\"1ce84f7bb8d52a35\",\"/knowledge-medium/pr-preview/pr-1838/src/types.js\":\"9acadd9504847814\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/ClientLocalSettings.js\":\"a1ef3c78014b66a9\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/abortableSleep.js\":\"a3052ee5d73e286f\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/array.js\":\"9d7e393f80c9f912\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/backlinkAutocomplete.js\":\"19ca19ba6821e72c\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/blockCrumbs.js\":\"2f234a18ed441d83\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/blockrefAutocomplete.js\":\"72a54c9d9f5bb809\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/cadencedIdleJob.js\":\"f4f96aa6c1dfc58e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/callbackSet.js\":\"10a35ddff8d7b463\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/clientId.js\":\"9cd896b4ace2557e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/codemirror.js\":\"d74bd7836301af41\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/codemirrorCompletion.js\":\"c0173e73c77b853e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/copy.js\":\"f69e4b57d5942925\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dailyPage.js\":\"573024c35df00807\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dbForensics.js\":\"8299e31b0a7c3bf4\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dbForensicsHooks.js\":\"bd46e051b961a48a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/deleteBlockThroughUi.js\":\"9947c8af05bcfe2d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dialogs.js\":\"5891a11516c166dd\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dom.js\":\"80d462ce9f34bee0\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/downloadBlob.js\":\"bac56d91eb739333\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/exportSqliteDb.js\":\"d45fb666bbe2b534\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fileSystemAccess.js\":\"0156d58e98da3093\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/flipSlide.js\":\"59698ecbf83b1f9e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fnv1a.js\":\"c2f4d809eb93311d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/formatBytes.js\":\"4d248a40157455a6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fuzzyRank.js\":\"3375382a5fec6b97\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/idbKeyedStore.js\":\"b3e3718c8caf3371\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/idleCallbackPolyfill.js\":\"12e3ce767edf1eb0\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/keyboardAwareScroll.js\":\"ba4fb3e396ec034e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/keyboardViewport.js\":\"523d2663cf651ab3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/lastWorkspace.js\":\"a1eb953afe557a63\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutColumns.js\":\"4a0b9f84c0742e73\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutSessionDom.js\":\"9f19aece8a2299a9\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutSessionId.js\":\"32b82799bfd996e5\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/linkClickGestures.js\":\"4b7a6b3585a44090\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/linkTargetAutocomplete.js\":\"3240b370330b0b96\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/localDbCorruption.js\":\"3c6395726856ab99\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/localDbRecovery.js\":\"ef7b38c5f1e8b077\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/markdownParser.js\":\"e9e668a287c4c892\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/memoize.js\":\"f722831e0ebf854a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/nameFieldCommit.js\":\"efe0ec887d6ea008\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/nameList.js\":\"a9d398b7b78687c3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/navigation.js\":\"95b769af62829ad7\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/omnilinerNamespace.js\":\"0d9e800515236936\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/opfsPageScan.js\":\"e1b8b67ebc777666\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelClearance.js\":\"82565f21c2b4c953\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelHistory.js\":\"6a10c616e3be22cf\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelLanes.js\":\"dee658663d3bd815\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelLayoutProjection.js\":\"3b7472bb53183258\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelScrollAnchor.js\":\"a538021adefed409\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelUrlFlags.js\":\"a1b5edb17b934bef\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/platform.js\":\"27e5553834148c22\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/pluralize.js\":\"b4a56680be764c9e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyCreation.js\":\"d2e53c97559cb861\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyNavigation.js\":\"8a26988560f0a464\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyValueContext.js\":\"33ecf80c85f84f62\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/react.js\":\"f879f2702667ef01\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/relativeDate.js\":\"33fee7492218156d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/relativeTime.js\":\"3a12a34e2fa4bdab\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/renderScope.js\":\"31e507e9ceceb2bd\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/resolvedThenable.js\":\"6fea0f5eb93ffa98\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/routing.js\":\"262a1f97da538937\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/safeMode.js\":\"bc32bedf21be5e67\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/scheduleIdle.js\":\"dec9f4e900f2719e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/screenWakeLock.js\":\"4458f30488981a20\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/selection.js\":\"ae36a58e7a0a7d8e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/softKeyboardGrab.js\":\"9e532ff3e713548c\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/startupTimeline.js\":\"8f17e8922a646880\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/state.js\":\"ab9e01460c54e6aa\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/string.js\":\"950524fb335cd603\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/surfaceZoom.js\":\"8841df29e6e36109\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/time.js\":\"189c325c846f794c\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/toast.js\":\"c6cb2ec90f7682e4\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/toggleStore.js\":\"026bbea56a95982c\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/untilStopped.js\":\"21b98ff8d1fbd4c0\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/userActivity.js\":\"ff6568ed2c7a953a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/viewTransition.js\":\"0331ceff36952c43\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/viewport.js\":\"d85c9e2599aee75c\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/webLock.js\":\"10808dc2cccfa017\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/workspaceRecovery.js\":\"dfb6558116a1392d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/workspaceSnapshotStore.js\":\"1c08aab39a97e5e5\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-compiler-runtime.js\":\"8d0b824434d7b453\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-client.js\":\"468cfb0667b24b1d\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-server-edge.js\":\"eee3c6f2c3fd9f29\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-server.js\":\"bb34fe28fd50978d\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-static-edge.js\":\"a94ea4be7e91aff1\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-static.js\":\"e2eae6305c0fd6ed\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-test-utils.js\":\"fcb053d1e6eec955\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom.js\":\"e625b60949b16652\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-jsx-runtime.js\":\"0be5973c0721d3ee\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react.js\":\"3267bf5fbaf6845a\",\"/knowledge-medium/pr-preview/pr-1838/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1838/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1838/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
