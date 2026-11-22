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
		buildId: "40c9e637eadc-0580d05f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/\":\"c6aa84b214f23b15\",\"/knowledge-medium/pr-preview/pr-1838/index.html\":\"c6aa84b214f23b15\",\"/knowledge-medium/pr-preview/pr-1838/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1838/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1838/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1838/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1838/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1838/assets/FacadeVFS-BySLRrgy.js\":\"c937961717e328e7\",\"/knowledge-medium/pr-preview/pr-1838/assets/OPFSCoopSyncVFS-BJussN0g.js\":\"843ec09d77610a7e\",\"/knowledge-medium/pr-preview/pr-1838/assets/OPFSWriteAheadVFS-22KnAots.js\":\"ff4d9107215a71b8\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-CUslscDW.js\":\"ecbe51a9cc52c25e\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1838/assets/wa-sqlite-async-CzHkASy3.js\":\"b9205250746f8a6f\",\"/knowledge-medium/pr-preview/pr-1838/assets/worker-BPHOaONh.js\":\"21ce53a57ca3e255\",\"/knowledge-medium/pr-preview/pr-1838/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1838/chunks/app-BJryqiZw.js\":\"33019320a36cea74\",\"/knowledge-medium/pr-preview/pr-1838/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1838/index.js\":\"47d906289b6ab94f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1838/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1838/assets/AccessHandlePoolVFS-CT99hxBA.js\":\"7e6b1a2e30ec2a15\",\"/knowledge-medium/pr-preview/pr-1838/assets/IDBBatchAtomicVFS-CTCRiAsU.js\":\"55b425e36708ce25\",\"/knowledge-medium/pr-preview/pr-1838/assets/MemoryVFS-Dg-kJpBa.js\":\"827562397803fb1d\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-D3HCz0zt.js\":\"f631cfb2cb828574\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1838/assets/mc-wa-sqlite-async-eWUON75F.js\":\"c535857379a2efff\",\"/knowledge-medium/pr-preview/pr-1838/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1838/chunks/AccessHandlePoolVFS-D5wlcXiz.js\":\"a0c9e3353934962e\",\"/knowledge-medium/pr-preview/pr-1838/chunks/FacadeVFS-Dhn2S84Y.js\":\"42c6b5bb9293b246\",\"/knowledge-medium/pr-preview/pr-1838/chunks/IDBBatchAtomicVFS-C01Fro5h.js\":\"c4d352fda2bda6f0\",\"/knowledge-medium/pr-preview/pr-1838/chunks/MemoryVFS-DhTBLwEZ.js\":\"c7c87451a02fd67d\",\"/knowledge-medium/pr-preview/pr-1838/chunks/OPFSCoopSyncVFS-DDQyVbOz.js\":\"7ec416384ed10496\",\"/knowledge-medium/pr-preview/pr-1838/chunks/OPFSWriteAheadVFS-BmLXWw6u.js\":\"ad680cf344b4f10f\",\"/knowledge-medium/pr-preview/pr-1838/chunks/Preview-i2JLZOTj.js\":\"e0a646fa5091794a\",\"/knowledge-medium/pr-preview/pr-1838/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1838/chunks/card-uVvzatTb.js\":\"cfc668d3e1489dc5\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1838/chunks/dist-pjI4ySEU.js\":\"4c12d449a039a8dc\",\"/knowledge-medium/pr-preview/pr-1838/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1838/chunks/mc-wa-sqlite-Z9OeqASv.js\":\"d0eaf25bb218ac2a\",\"/knowledge-medium/pr-preview/pr-1838/chunks/mc-wa-sqlite-async-BgpXKL_H.js\":\"8af2bce8ddc67cb5\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-5m75ttuT.js\":\"9979789965394ae8\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-6qpBbs6E.js\":\"b788102e92b2cd77\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-C-BG4jWc.js\":\"e1f47bf2d07c29cd\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-CE0dKIWw.js\":\"d08811d7c1008f80\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-CdrIQkN5.js\":\"908470c54edd29cf\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-Cq6_hzZd.js\":\"06ebd5d93e437ad9\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-DlrqT3Rp.js\":\"7b4b7bc1eae05465\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-DqJSNkkm.js\":\"bb3c18a41b6b151d\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server-legacy.browser.production-hsJKW0s-.js\":\"7f70369ba0ff815e\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server.browser.production-BTLQuMlK.js\":\"de882c7e2bffdef7\",\"/knowledge-medium/pr-preview/pr-1838/chunks/react-dom-server.edge.production-BX0E8VfW.js\":\"a1ff66e7a9e8f20f\",\"/knowledge-medium/pr-preview/pr-1838/chunks/server.browser-DyzymyOO.js\":\"f74904e9da2894e0\",\"/knowledge-medium/pr-preview/pr-1838/chunks/textarea-CKwf3PGP.js\":\"b4da799f561970b4\",\"/knowledge-medium/pr-preview/pr-1838/chunks/ui-DA23qdN9.js\":\"ac58220a9ce565cf\",\"/knowledge-medium/pr-preview/pr-1838/chunks/wa-sqlite-DBTW7mS-.js\":\"d1b6fb00976447e7\",\"/knowledge-medium/pr-preview/pr-1838/chunks/wa-sqlite-async-Bnw-RiT7.js\":\"90570f8c161ab3eb\",\"/knowledge-medium/pr-preview/pr-1838/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1838/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1838/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1838/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1838/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1838/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1838/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1838/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1838/src/App.js\":\"4860a41034c80a72\",\"/knowledge-medium/pr-preview/pr-1838/src/appUpdate.js\":\"6d8d69f53d92aa3f\",\"/knowledge-medium/pr-preview/pr-1838/src/appVersion.js\":\"d16885a7c811a299\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/initialLayout.js\":\"5eb661487e0158ec\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/openWorkspaceData.js\":\"9dcff612a0480c7d\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/resolveWorkspace.js\":\"b6fcf2c95cea9824\",\"/knowledge-medium/pr-preview/pr-1838/src/bootstrap/workspaceBootstrap.js\":\"ef9d0e50fa3833b3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockComponent.js\":\"a346e12a1b9348e9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockCrumbs.js\":\"58b898f4c0b6eee3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockEditor.js\":\"6e48634602129414\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockLoadingPlaceholder.js\":\"ff291d5fb1123f87\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockProperties.js\":\"5285333238eabc8e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/BlockSearchPicker.js\":\"7acafd69a3a0df7d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ConfirmBulkDeleteDialog.js\":\"5d9d629abf184b75\",\"/knowledge-medium/pr-preview/pr-1838/src/components/DividerHandle.js\":\"64a2b2ec40d8809c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/DraftEditor.js\":\"87cd8d339c5186dc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/GutterPill.js\":\"87b177ffde0ea836\",\"/knowledge-medium/pr-preview/pr-1838/src/components/Header.js\":\"e9329cc973bd72cd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/LazyBlockComponent.js\":\"b5ea112a105d5b44\",\"/knowledge-medium/pr-preview/pr-1838/src/components/Login.js\":\"cdc2e82ce4ad1baa\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ZoomableSurface.js\":\"c732e888ddb79bbb\",\"/knowledge-medium/pr-preview/pr-1838/src/components/editModeKeepalive.js\":\"6ca3d38d884916b5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyDisplay/PropertyDisplayScope.js\":\"948b34c5c70d6240\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5d49acd0e5f175cc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/RefPropertyEditor.js\":\"569b804b6d499891\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/RefTargetTypePicker.js\":\"b88ca9bec099d50f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/SelectPropertyEditor.js\":\"cd42d7b2567917dc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/TypesPropertyEditor.js\":\"855fc27494be6360\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/defaults.js\":\"8f4f799ca2e3770c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/kernelValuePresets.js\":\"3d35de4290b4fc77\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/selectablePresets.js\":\"c1049dd1734ad95d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyEditors/typesPropertyUi.js\":\"31a94f248ae530d0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/AddPropertyForm.js\":\"fdfeae6b24601ae7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/PropertyPicker.js\":\"85a83ae25a351947\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/PropertyRow.js\":\"ba16a198159790c4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/Rows.js\":\"943f7375ebf22040\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/actions.js\":\"d162ec1a01643591\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/declarationOnly.js\":\"1b3ebbce9aef68ac\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/layout.js\":\"e57bfab18c13dafe\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/model.js\":\"867cbc00c953cd0f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/shapeUi.js\":\"a7f5b8ce750d028e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/shapes.js\":\"b36cb55aa1d447aa\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/usePropertyEditingActivation.js\":\"f05b67d0f0ca0c07\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanel/visibility.js\":\"3a9e9308697b1467\",\"/knowledge-medium/pr-preview/pr-1838/src/components/propertyPanelSections.js\":\"1c746b9db5dd66a9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockEmbed.js\":\"7787ba6e946cea0f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockLink.js\":\"f528fd9de61a500c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/BlockRef.js\":\"5621da0769c405c5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/ReferenceLink.js\":\"059808b48e7ec2c2\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/cycleGuard.js\":\"d18d9ba1e268da75\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/cycleGuardContext.js\":\"297bf744b6d04d66\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/linkInteraction.js\":\"db99a6393d1b8cc4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/referenceLayout.js\":\"0a7bd2d7b4133973\",\"/knowledge-medium/pr-preview/pr-1838/src/components/references/useBlockRefAncestors.js\":\"b0b4b95d30e0f2cc\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockGutter.js\":\"c97903e35fbedb58\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockInfoDialog.js\":\"48ca184f781a35ef\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BlockTypeBlockRenderer.js\":\"ccd827451e8260dd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/BulletHoverCard.js\":\"26bb5a7dfd5443b4\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/CodeMirrorContentRenderer.js\":\"0e28fcfadad9edf3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"de89ad646dbba62e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/ColumnResizeHandles.js\":\"73753fc1ccd8daf6\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a6af48afb9bc0bd5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/DefaultBlockRenderer.js\":\"63b36fcc9d4a51f5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/LayoutRenderer.js\":\"16fd05ea9547c8e8\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/MarkdownContentRenderer.js\":\"1d9891bc4267ca32\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/MissingDataRenderer.js\":\"f5a8a6e6b23bc92f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/PanelRenderer.js\":\"e32dce971b4f329e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c3693988adf60d33\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/TopLevelRenderer.js\":\"d21feac8a70b47f5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/blockGutterMode.js\":\"1b48f981f97f1d1f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/blockTitleText.js\":\"722288db7eae63db\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/fieldCreationKeydown.js\":\"665d3a43201f2df5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/renderer/layoutRootContext.js\":\"537f670997632516\",\"/knowledge-medium/pr-preview/pr-1838/src/components/typeChip/TypeChip.js\":\"4263eafb293eaf9a\",\"/knowledge-medium/pr-preview/pr-1838/src/components/typeChip/chipStyle.js\":\"fc28fc958d123574\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/anchored-floating.js\":\"0adbbbf474a0c76f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/button.js\":\"d0fc12a495241716\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/card.js\":\"d935a381ee8557f8\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/checkbox.js\":\"fd47c43b19dda1a5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/collapsible.js\":\"71266792d3a0da33\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/command.js\":\"b38115b27d0edfed\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/context-menu.js\":\"ad55b6e886338c38\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/dialog.js\":\"e496ee7b1aab6561\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/dropdown-menu.js\":\"aa5b1ff973976250\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/floating-listbox.js\":\"98cea0a0a12bcfec\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/index.js\":\"208016b3c093db8f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/input.js\":\"87b659bb365611a2\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/kbd.js\":\"7dd047146fd80f2c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/label.js\":\"d2bff85400d1c4da\",\"/knowledge-medium/pr-preview/pr-1838/src/components/ui/textarea.js\":\"28a5fa769fbd2c40\",\"/knowledge-medium/pr-preview/pr-1838/src/components/useEditModeYieldKeepalive.js\":\"966b3747a7be336c\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/BootFallback.js\":\"730deae4de087004\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/FocusedRowLazyMount.js\":\"87ab2f9e0610afa0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/LazyViewportMount.js\":\"605f1ce7ff1cd08b\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/LocalDbCorruptionFallback.js\":\"d0f7543ee351e9bd\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/error.js\":\"e97a4957fdb336e9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/lazyMountRegistry.js\":\"19ac598b66b8c00e\",\"/knowledge-medium/pr-preview/pr-1838/src/components/util/suspense.js\":\"49f56174a2c2dbaf\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/CreateWorkspaceDialog.js\":\"726df1e4cbe752e5\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/PendingInvitations.js\":\"5e79884d3482a3f7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/SyncProgress.js\":\"7a8e05b3308b18f0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/UnlockProgress.js\":\"a99a54a9a4409e69\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceKeyGate.js\":\"b1e27bc7639a4c64\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSettingsDialog.js\":\"f2dcf4d34db09346\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSwitcher.js\":\"4d706ceacbffcfa9\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/WorkspaceSyncGate.js\":\"175a4cd5d06ec608\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/ConversionFlow.js\":\"d05a29ebfc544346\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/ConversionFlowHost.js\":\"c49ba0237c4c1e5d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/EncryptionSection.js\":\"de9d83616a405f9f\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/attachmentPrompts.js\":\"5a97a8d7d71e5af0\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4f8a8e1ca74080a7\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/conversionFlowDeps.js\":\"c059a7befdab6069\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/conversionFlowStore.js\":\"dd1f002d5ab27e05\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/flowUi.js\":\"e23a1d845f900584\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/conversion/useConversionRun.js\":\"eee806c424a15ef3\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/keyUi.js\":\"c0b7352b973d6577\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/useCloseOnKeyLoss.js\":\"e3f69fa26fae903d\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/useCloseOnServerE2ee.js\":\"6c26e23c7a88dc49\",\"/knowledge-medium/pr-preview/pr-1838/src/components/workspace/workspaceUnlocked.js\":\"765b26d73289b427\",\"/knowledge-medium/pr-preview/pr-1838/src/context/backgroundSubtree.js\":\"e46d437a50bfff2f\",\"/knowledge-medium/pr-preview/pr-1838/src/context/block.js\":\"2cf66d2b951ddff7\",\"/knowledge-medium/pr-preview/pr-1838/src/context/layoutWsContext.js\":\"7454d753e483a11a\",\"/knowledge-medium/pr-preview/pr-1838/src/context/propertyDisplay.js\":\"688f870b46cb40f2\",\"/knowledge-medium/pr-preview/pr-1838/src/context/repo.js\":\"9ec8044b740065c3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/aliasClaim.js\":\"94a241f5da6e635d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/aliasSeatNamespace.js\":\"977f0319bc67143a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/blockData.js\":\"bfc75d8e3a21beab\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/blockType.js\":\"31eaf34ab5e12b6d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/changeScope.js\":\"6ee849894fa29241\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/codecs.js\":\"9979d18edc0072e5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/derivedData.js\":\"7ca6907e720ce435\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/errors.js\":\"f4c1364431801246\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/events.js\":\"3ffbd53f1d3a847d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/handle.js\":\"5f2ed05eb856a6c0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/index.js\":\"ac8be20565993e0d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/mutator.js\":\"502e5038bdf2cd7e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/processor.js\":\"069ca36197ad464f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/propertySchema.js\":\"162b5bb7190ad390\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/query.js\":\"536b911ae04d153c\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/sameTxProcessor.js\":\"9206b86a2ba08491\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/schema.js\":\"5f2ed05eb856a6c0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/tx.js\":\"5f2ed05eb856a6c0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/typedBlockQuery.js\":\"d0025b3a747031ed\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/user.js\":\"cd5ae0d596631b03\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/valuePresetCore.js\":\"e9e250b9d5f0ff4d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/api/valuePresets.js\":\"ba9358a0bd9d53c9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/attachmentCleanerIOVerb.js\":\"90efe0977b150108\",\"/knowledge-medium/pr-preview/pr-1838/src/data/block.js\":\"fb7ddddef6f3e81b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockCache.js\":\"ab79443b4a060057\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockId.js\":\"c71328d038d8bea7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockLiveness.js\":\"b7bbcd1131024123\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockMerge.js\":\"a52a6f922206f1e7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockSchema.js\":\"848608d5fdbad256\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockTypeLookup.js\":\"bcad760a012a9723\",\"/knowledge-medium/pr-preview/pr-1838/src/data/blockTypes.js\":\"1458e0fdd69bad24\",\"/knowledge-medium/pr-preview/pr-1838/src/data/clientContext.js\":\"185f7ff6df81871e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/dbFileSiblings.js\":\"53d80ddef86a6405\",\"/knowledge-medium/pr-preview/pr-1838/src/data/definitionSeeds.js\":\"67900ce4cca8df16\",\"/knowledge-medium/pr-preview/pr-1838/src/data/derivedIds.js\":\"dc0a205234c006c7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/drawnSubtree.js\":\"5cd8530cb60ff3c9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/facetBridge.js\":\"7a6d8f8dd199f559\",\"/knowledge-medium/pr-preview/pr-1838/src/data/facets.js\":\"d39980eeae933f78\",\"/knowledge-medium/pr-preview/pr-1838/src/data/globalState.js\":\"4ece5509db0b093a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/aliasClaimRederiveProcessor.js\":\"9e7d2d6dfc77211f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/ancestorBatch.js\":\"263c93925a2a4583\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/blockTypeTypeifyProcessor.js\":\"86a92deada36f0b4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/clientSchema.js\":\"fbe63f7b4bb81dc8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/commitPipeline.js\":\"3c341bdee5fcb792\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/devAssertions.js\":\"719b46b8f062a628\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/firstSync.js\":\"a39fef34f3799a58\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/freshInitialLoad.js\":\"9114b591a80f8f60\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/graphBackfillClaim.js\":\"71592299407f1902\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/handleStore.js\":\"d6435e4aea7f7e60\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/idleMarkerJobs.js\":\"6c68b05e10bbf2a6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/initialDownload.js\":\"fb03c69f7d2d108d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/initializeClientDatabase.js\":\"bc7de8ec4f307f98\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/jsonCanonical.js\":\"fab7b8b6c6445f40\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelInvalidation.js\":\"3533fd936c990485\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelProcessors.js\":\"dde2afb1f92fd0cd\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/kernelQueries.js\":\"ffa9adc238ded2b8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/mergeTypeMembershipProcessor.js\":\"5591ddd070303ca6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/normalizeReferencesProcessor.js\":\"73b9a296cb53c4a4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/poolInstrumentation.js\":\"42ffa4b795ea26ea\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/processorRunner.js\":\"86c92507ee8a129d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyCellBackfill.js\":\"32cbf9d8674d3577\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyChildMint.js\":\"af5bb153909a5679\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyChildrenProcessor.js\":\"ac64bb63752ee75a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyDefinitionChangeProcessor.js\":\"df782265b1c69753\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyDefinitionSynthesis.js\":\"9ead676e0d4cc299\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyKeyScan.js\":\"c5a928e10f0df91f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertySchemaResolution.js\":\"4e611df96fa0b7e4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/propertyValueEdits.js\":\"6bfe6c90dd73cb19\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/raiseProtocol.js\":\"45cf0d2925f992b9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/readBatch.js\":\"112ca8363e2d90dd\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/refProjection.js\":\"c15d69fcd49caf89\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/referenceTargetLookups.js\":\"6c4b8f061b5cdf41\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/referenceTargetProcessor.js\":\"edd3cf3e62a0a649\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/replayMerge.js\":\"3b8ba333479d0128\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/sqlBinds.js\":\"05674e5a3d0147a8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7cd26df8f5f4f64b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/arrivalProcessors.js\":\"3b7821df22c6d38e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/invalidate.js\":\"567debdcd96acaba\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/materialize.js\":\"400d850fe0969fd1\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/observer.js\":\"c7bb2602700a9ae2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/syncObserver/reconcile.js\":\"2dc43ace39e94954\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/timingMetrics.js\":\"48f096e7137110d7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/treeQueries.js\":\"b10c12b92c20ce36\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/txEngine.js\":\"2d532f6d02547701\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/txSnapshots.js\":\"32d7730c203f1e64\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/typedBlockQuery.js\":\"3cb9910b63d5f3a9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/internals/undoManager.js\":\"b02135594f980bec\",\"/knowledge-medium/pr-preview/pr-1838/src/data/invalidation.js\":\"74090205f2403afb\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelDataExtension.js\":\"69b3aae28fa4a799\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelPage.js\":\"cade61b42eb146ed\",\"/knowledge-medium/pr-preview/pr-1838/src/data/kernelValuePresetCores.js\":\"a67d6f25348168eb\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbCorruptionSignal.js\":\"2386fbe4bf1c083e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbStorage.js\":\"95225f3b2c14aa5d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localDbVfs.js\":\"7f101b34eb19f739\",\"/knowledge-medium/pr-preview/pr-1838/src/data/localSchema.js\":\"74d09d661182cbdb\",\"/knowledge-medium/pr-preview/pr-1838/src/data/maintenance.js\":\"0bd8522ba9a1ed81\",\"/knowledge-medium/pr-preview/pr-1838/src/data/mergeProperties.js\":\"9dfd25dd9609fc43\",\"/knowledge-medium/pr-preview/pr-1838/src/data/metricsConsoleHook.js\":\"53f92051bda5e3f6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/migrationsPage.js\":\"f1e522746267663b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/mutators.js\":\"7036d62b7140f11a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/orderKey.js\":\"07d426f39f351248\",\"/knowledge-medium/pr-preview/pr-1838/src/data/orderKeyPlacement.js\":\"a0c158a32bd30e14\",\"/knowledge-medium/pr-preview/pr-1838/src/data/outlineSurface.js\":\"1b666213ed565b1d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pendingEditorContent.js\":\"9cbda61a67b97d18\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pendingUploadsSql.js\":\"d82ebc3215f44c13\",\"/knowledge-medium/pr-preview/pr-1838/src/data/pluginStateExtensions.js\":\"3c7025fa1e32b2e7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/powerSyncLogger.js\":\"ee7289d4632b10a5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/projectorRuntime.js\":\"f125562382656d06\",\"/knowledge-medium/pr-preview/pr-1838/src/data/properties.js\":\"1a0011f938b731fe\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertiesPage.js\":\"7f1aebc4e9ee298e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyChildren.js\":\"f736754e2d22a0b6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionFanout.js\":\"9add7934040561d5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionMetadata.js\":\"88b5ee0e4235fbb6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDefinitionRegistry.js\":\"60c9dc02ede5c6e0\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyDisplayMode.js\":\"f0a23c0d6ff0274b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertyRowCreation.js\":\"473d719bdc770bcb\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertySchemaCreation.js\":\"25ffce65d1c4988d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/propertySeeds.js\":\"92fed40ad684ffb5\",\"/knowledge-medium/pr-preview/pr-1838/src/data/recentsPage.js\":\"b9d66e9171468d33\",\"/knowledge-medium/pr-preview/pr-1838/src/data/referenceBlock.js\":\"1c97934c78985214\",\"/knowledge-medium/pr-preview/pr-1838/src/data/rejectedUploads.js\":\"0ae8285a8efcb6ca\",\"/knowledge-medium/pr-preview/pr-1838/src/data/releasePowerSyncConnection.js\":\"e420a9192123c620\",\"/knowledge-medium/pr-preview/pr-1838/src/data/repo.js\":\"fcc39b97980aab2a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/repoProvider.js\":\"f097e728f6200a3a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/rowProperty.js\":\"24d89a1d0bb93b7f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/searchFilter.js\":\"f454f1601ec3fb02\",\"/knowledge-medium/pr-preview/pr-1838/src/data/seedIdentityLedger.js\":\"906bb14076e1cdb7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/stateBlocks.js\":\"064a8cca43b96eb7\",\"/knowledge-medium/pr-preview/pr-1838/src/data/structuralEditPolicy.js\":\"6de4db70a57263ee\",\"/knowledge-medium/pr-preview/pr-1838/src/data/subtreeDelete.js\":\"7ea1d5150724af24\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncStreamLock.js\":\"552b6ea3bb8ecc4e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncedTableSqlRecognizer.js\":\"139970e1c2d15011\",\"/knowledge-medium/pr-preview/pr-1838/src/data/syncedTableWriteGuard.js\":\"363ab6fef506c9d8\",\"/knowledge-medium/pr-preview/pr-1838/src/data/targets.js\":\"cfdd8afeea57e502\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeColors.js\":\"754ccaaf8fd9a6c9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeDefinitionMetadata.js\":\"19727d137d288bb9\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeDefinitionRegistry.js\":\"cc290080b470e2ef\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeExtraction.js\":\"1c71aadb16352e5a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeInitialValues.js\":\"fe1c92480ba59cba\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typePropertyGroups.js\":\"3dac90c2d6689bb6\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeSeeds.js\":\"cfc86e6219f5bad2\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typeTagger.js\":\"22cf8abe25d2bcf3\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typedRecords.js\":\"b2bbe406a37ef67d\",\"/knowledge-medium/pr-preview/pr-1838/src/data/typesPage.js\":\"f72b40b01dab36de\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userPrefs.js\":\"aa915a1c700fc30e\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userSchemasService.js\":\"dbaf0d8f52f12b4b\",\"/knowledge-medium/pr-preview/pr-1838/src/data/userTypesService.js\":\"0f5d70a76e5417ec\",\"/knowledge-medium/pr-preview/pr-1838/src/data/valuePresetRegistry.js\":\"2d9ebbe8dc83492a\",\"/knowledge-medium/pr-preview/pr-1838/src/data/visibleChildren.js\":\"9640e44653814aff\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceConversion.js\":\"f16ddb3dcbaf549f\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceFirstSync.js\":\"054631f079829133\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceIdNamespace.js\":\"5964e634d248f105\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaceSchema.js\":\"01ef983b28d23570\",\"/knowledge-medium/pr-preview/pr-1838/src/data/workspaces.js\":\"72f06c03d89bde50\",\"/knowledge-medium/pr-preview/pr-1838/src/data/writeAheadLog.js\":\"9183a5f386619dd4\",\"/knowledge-medium/pr-preview/pr-1838/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/BlockPasteShellDecorator.js\":\"9b0ad4ab93ddb231\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/atTrigger.js\":\"9422557846dd9907\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/autocomplete.js\":\"5483c0ea9c4d8bef\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/codeMirrorExtensions.js\":\"dad180bb6b59da8d\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/contentFlush.js\":\"f70dfbf4e28bdfc9\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/defaultInteractions.js\":\"a00c06d0b693ba78\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/editSettleSignal.js\":\"966cd9f72091401a\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/insertImage.js\":\"e5154a40403ddace\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/referenceCompletionRange.js\":\"4e16610f05630389\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/referenceTargetTypes.js\":\"72ac2695a213a620\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/syntaxContext.js\":\"a59d4f0a67dbce25\",\"/knowledge-medium/pr-preview/pr-1838/src/editor/triggerMatch.js\":\"44223cddefdeb3ff\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/AppRuntimeProvider.js\":\"b6c6fef1132bbb00\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/BlockFocusShellDecorator.js\":\"cf23b346a776cb73\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/ExtensionRenderBoundary.js\":\"848db7c26defa90c\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/PanelContentRecovery.js\":\"64d72be9a7bf2aaa\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/apiCatalog.js\":\"61f5b7bec08105c8\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/approveExtensionHere.js\":\"30cd290d67f5cdac\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/armedCutAppMount.js\":\"69959773fdefb9a6\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/batchableKeyedStore.js\":\"38e6c7cce00174fa\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/blockInteraction.js\":\"72fc848986598204\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/blockSelectionAction.js\":\"a8513371f4d1a75c\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/compileExtensionModule.js\":\"644c3dfc09891adc\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/compiledModuleCache.js\":\"6dd2b01b96c354a3\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/continuousGestures.js\":\"69927cbfd84b602a\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/core.js\":\"8ae9dd735bee44f5\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/defaultRenderers.js\":\"cd9fa9d98c97711b\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/definitionFanoutAppMount.js\":\"347a8763c425b193\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dialogAppMount.js\":\"6ea40e07dfafd6c3\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dynamicExtensionSeeds.js\":\"2415a1105d96878b\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/dynamicExtensions.js\":\"77cf073e3005ed16\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/exampleExtensions.js\":\"930a687493a3fbc5\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionApprovalStatus.js\":\"0c7547c265d35ef9\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLoadErrorToast.js\":\"40da0e7eb4928dcd\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLoadErrors.js\":\"3db44574627bb7bb\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionLookup.js\":\"56549808b1657d51\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionToggles.js\":\"761e2a9c2d4ccad0\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/extensionUtilitiesCss.js\":\"901ddfc91670cc31\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/kernelPageDeletionGuard.js\":\"fdfa44fee4057ff6\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/liveRuntime.js\":\"9951385df5e931e7\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/openExtensionsSettings.js\":\"6e79abfc52ae7e05\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/overridesCache.js\":\"cf4108997c811883\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/pluginIds.js\":\"bb81b3b8f8bb5d70\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/processorRejectionToast.js\":\"0a9180d0711f190a\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/runtimeActions.js\":\"e56dafa7e96900c9\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/runtimeContext.js\":\"6415540243ed1c4a\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/staticAppExtensions.js\":\"6779d11810f4e5a9\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/staticDataExtensions.js\":\"5222cc912ff07bf8\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/toastAppMount.js\":\"e29392e7a01cfc55\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/useOverrides.js\":\"1b7f58aa9548750b\",\"/knowledge-medium/pr-preview/pr-1838/src/extensions/useShortcutSurfaceActivations.js\":\"27c4d7c27082adf6\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/discoverToggleTree.js\":\"469931ee8f8dd0b4\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/facet.js\":\"b4223e4732e688de\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/resolveAppRuntime.js\":\"cc8ba0375816e260\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/runtimeEvents.js\":\"dc14ff39bc36d877\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/togglable.js\":\"8935542a325adc0f\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/variantFacet.js\":\"60c46554249d7519\",\"/knowledge-medium/pr-preview/pr-1838/src/facets/verbFacet.js\":\"2d2b08f94aba213f\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/block.js\":\"65d192eb3874a927\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/focusedChild.js\":\"96f360575254a0ce\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/propertySchemas.js\":\"a60a7778747f6d6b\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/typeRegistry.js\":\"e825df015d4402ff\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useAncestorCrumbs.js\":\"db304a45a01c31f3\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useAutocompleteListbox.js\":\"094e353e434ce774\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useDebouncedSearch.js\":\"6198cc1be2e4bdd2\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useDebouncedValue.js\":\"ff0e0e0aba1442c7\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useIsFocalRender.js\":\"e343ab32ac199d38\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useIsReadOnly.js\":\"b73a433c5ad0efe3\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useMaterializeBacklog.js\":\"d7bd18e646ba4600\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useMinuteClock.js\":\"108c62a9bb691174\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/usePanelLayoutProjection.js\":\"f1ff90e5d1667fce\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/usePendingInvitations.js\":\"bbea847130b72f40\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useRendererRegistry.js\":\"28c9fbf480dd9b7c\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useRetainedFieldRows.js\":\"682931cb78925404\",\"/knowledge-medium/pr-preview/pr-1838/src/hooks/useWorkspaces.js\":\"d8dd31ab227fc4a6\",\"/knowledge-medium/pr-preview/pr-1838/src/lib/utils.js\":\"c9693400a045cc82\",\"/knowledge-medium/pr-preview/pr-1838/src/main.js\":\"605f7111381278c8\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/MarkdownImage.js\":\"89d6586b8030270e\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/blockSeparators.js\":\"27e2f4e2f71ff0ae\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/context.js\":\"d1fdcf6a7d0e46db\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/defaultMarkdownExtension.js\":\"39a934e4511d36f7\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/extensions.js\":\"d157fbf26e55e81c\",\"/knowledge-medium/pr-preview/pr-1838/src/markdown/renderMarkdownHtml.js\":\"8fee333eec3a1461\",\"/knowledge-medium/pr-preview/pr-1838/src/minimal-editor.js\":\"517c00b84f59b9c2\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/armedCut.js\":\"d8f4f329f9e24ad2\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/captureMediaVerb.js\":\"e16f28cbb6eb67cc\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/clipboard.js\":\"8e4b9761be8ee1f2\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/decision.js\":\"8a200b642e48faa7\",\"/knowledge-medium/pr-preview/pr-1838/src/paste/operations.js\":\"038e3e573cd970d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/account-header/AccountHeaderItem.js\":\"03642c5a4d2aaa20\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/account-header/index.js\":\"eefbb4c8687e322a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1b3e7de3acd627cc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/askAgent.js\":\"2a902ee3ac273120\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/askedStore.js\":\"1c045fd4e81f4caa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3e75abe735e24e0e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/chipState.js\":\"ea35f49ab9af5511\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3ff2c9a213736ad1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/index.js\":\"33a1478c8df6e1ac\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e84f19483d6ef26b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-dispatch-companion/schema.js\":\"b1aa8153e94d76f6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3ce7e6b453664384\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b41fba018887d859\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/addMedia.js\":\"f2f14470ae000db1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4e3d09c07e07c196\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/block.js\":\"c834f8e9b6fc24d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/context.js\":\"e796a28d1969a3ee\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/displayIds.js\":\"31e943b40f62eb86\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/index.js\":\"96449ad392cfec31\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/outline.js\":\"d2bb94109cffcd87\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/properties.js\":\"3326b0586bdf3865\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/refs.js\":\"3d7b27cb341d57b5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"361d0c9daa4fcee9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/search.js\":\"d54274429ff9d8f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/shared.js\":\"a8c9319d0bc6d8c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7e83d94da3b4f241\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentViews/text.js\":\"2c4cf0b6a9852036\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/agentWrites.js\":\"885438f4e622c7d2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/authoringCatalog.js\":\"20d461e7b1d7d039\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/blockRefTargets.js\":\"19c86f56b715e57f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/bridge.js\":\"e36171187772b789\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/bridgeLoop.js\":\"75aa38f6d4dc7a46\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/changeHistory.js\":\"1cbb9f60e3624d43\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/commands.js\":\"659cb6885dadedf2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/commentsCommands.js\":\"3db2e49143e2da63\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/dataExtension.js\":\"4621007f01f0fd1d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/dataModelGuide.js\":\"06d94ff9107bd077\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/describeRuntime.js\":\"97c66b2c9daffe23\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/extensionLint.js\":\"92132a822786004d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/grainAudit.js\":\"5482b476ea9633dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/healthCommand.js\":\"da11ba92897f63ff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/index.js\":\"6d65386010324d0b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/presetIdentity.js\":\"64894c67b2323e91\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a4e8a8c5112e65e0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/readMedia.js\":\"da2b75365649790b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/schema.js\":\"633580e2c6fbf1d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/serialization.js\":\"4015a6e2cd2eab93\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/targets.js\":\"339227775f0bb39f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/tokens.js\":\"bb138c832b033549\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/watchEvents.js\":\"90465184317f153b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/workspaceGuard.js\":\"1da27f0fe0ddcff5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/agent-runtime/writeCommands.js\":\"030a4776336aa1c8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/AliasCollisionToast.js\":\"c0d3e4d0919a1147\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/DuplicateNameBanner.js\":\"3099b1892ba5c1bb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/collisionMerge.js\":\"a96a1a2d5a465075\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/dataExtension.js\":\"83e1f7efbb0ebf46\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/index.js\":\"be4957cce91dd6c0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/mergeCollisionAction.js\":\"c3829ab6ead300b3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/pageStyling.js\":\"00e9cbccda33240b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/rejectionToast.js\":\"0ae1cf16416e4278\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/alias/syncProcessor.js\":\"ce45514b8cc9d800\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/actions.js\":\"05fa4d6ce53a3aaf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/addComment.js\":\"2ea3dcf560cefe53\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/anchor.js\":\"5bcb34a09ce97891\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/anchorState.js\":\"c0cf7862c75e4861\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/commentLinks.js\":\"f230e44aec099281\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/confirmThreadDeletion.js\":\"5275f25a20a6dd1d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/container.js\":\"70fb7ee64b28553e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/dataExtension.js\":\"bfb2b1502124d5df\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/deleteComment.js\":\"1df38ee646503b69\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/highlights.js\":\"960f59f929f202fe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/index.js\":\"0bef270940cd9caa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/linkedCommentsPill.js\":\"24ee3c038942ee68\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/margin.js\":\"5db1e5afb93a971e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/marginSchema.js\":\"9d035cdf04517bc5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/newComment.js\":\"cc4b4526ead484ab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/ownThreadPicker.js\":\"1eff3df93120c996\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/placement.js\":\"06c34b38775dba7f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/queries.js\":\"554209c790435d7b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotePosition.js\":\"2f1858feb32255a7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotedIn.js\":\"d1ce5fb04f7cd7b5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/quotedRange.js\":\"67958a1f46a15b9c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/rangeRefs.js\":\"9006f812fa3e44c5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readHighlights.js\":\"9949bedf00946b10\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readSelection.js\":\"f50a00f1db2468f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/readSelectionUi.js\":\"8d4412037fe135e5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/reanchor.js\":\"df189deb78e5c55a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/schema.js\":\"47232d22670a9646\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/scope.js\":\"52c9cb874e971b4e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/scopeThreads.js\":\"9c9f55b8eb925527\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/splitRetarget.js\":\"d3256b71d362cc55\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/suggestionCard.js\":\"e4a68f7fb4b007c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/suggestions.js\":\"276d04c1e6ae95a1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/summaries.js\":\"d24746976cc9ac39\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/summaryBatch.js\":\"626cc396655fe448\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/surface.js\":\"866aec3dd81b6ed2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/threadNavigation.js\":\"68825e99c4b48819\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/threads.js\":\"f88ce2b48a29a687\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/ui.js\":\"ea4c020dbd7a477c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/annotations/uiStore.js\":\"3d1e3c4c14d847b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-intents/appIntents.js\":\"66f54c813a0a93e5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-intents/index.js\":\"865303f689c1162c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-update-prompt/index.js\":\"72ff720718e0c5a9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/app-update-prompt/status.js\":\"a1df04053a7519c3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"987578b7db4bc1d8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaBlockRenderer.js\":\"d2b8207f2d81d9ef\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaDownLaneReplicator.js\":\"699aa24d9fcaf40a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/MediaUploadReconciler.js\":\"2426bfa5d2f51826\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetDownLane.js\":\"1d2887436d7e8a43\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetResolver.js\":\"712f774eadc3c067\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/assetUpload.js\":\"4c67991cf54bf594\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/attachmentCleanerIO.js\":\"dbe9d07b3f041f3b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/supabaseAuditIO.js\":\"cebad6ab7b0f154b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/blobStore.js\":\"66b27d497dfbfbd8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/byteStore.js\":\"430b0ab912f0e0a4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/cleanerIO.js\":\"3a39996847aff772\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/cleanupAttachments.js\":\"df38bcda4ef5d1d2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/dataExtension.js\":\"8b5084776c5d6152\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/downLane.js\":\"ab0716741883dbb6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/index.js\":\"d30ad8ee47895f46\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/insertImageContribution.js\":\"922d4d64ff113c73\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/laneArming.js\":\"ad5939a448bf5fe4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/laneLock.js\":\"fccc80212a756aff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaBlock.js\":\"f7c9fed9b26bba34\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaCapture.js\":\"a247b0ea29b400b5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaViewers.js\":\"a8e591a9b6206c6f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/mediaViewersFacet.js\":\"dfa438fc9cc550f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/pasteCapture.js\":\"03211db99729a2e0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/resolver.js\":\"1efea2971ff9d032\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/retryUploadsAction.js\":\"68461ca8e0bbc7c5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/storagePaths.js\":\"7ca2640c1801e150\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadDrain.js\":\"24ae9872eb09c5da\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadLaneStatus.js\":\"a78bb1774e7bf3c8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadReconcile.js\":\"7f18f50d6f6b3624\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadRecovery.js\":\"e6a095dd07dc272a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/uploadStore.js\":\"a9df7f3fb392a8ef\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/attachments/useAssetObjectUrl.js\":\"0a9341189a459505\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8821ef8459be8d6a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2611706e97c455dd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/facet.js\":\"1e27fe947f1d3138\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/index.js\":\"a2df28230a6e22a3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks-view/prop.js\":\"396ea3262d67ffb5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BacklinkFilters.js\":\"896fec596a4428f2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e6fd2752e899a857\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/BlockEntry.js\":\"e9b8314c5085625c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/LinkedReferences.js\":\"aaf6ac82c5e20105\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"30a49f500f3c8539\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/dailyNoteDefaults.js\":\"30965f8f28cc5e1d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/dataExtension.js\":\"b51c9af6f7b8591e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/edgeExclusions.js\":\"96010fb34f29bfb4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/filterProperty.js\":\"9400d61bfc345ea9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/index.js\":\"6a6dc837abb79ca4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"05d2a55388476ce1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/applies.js\":\"0458e184386eac87\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/countQuery.js\":\"4a8f1956438a9e51\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a158caf247112ae7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/index.js\":\"fa164cb739a3da25\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f9aa3ac115f3bf76\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/presentationInvalidation.js\":\"8bc6101b53d63889\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/propertyEditorOverride.js\":\"e31190589db9e6c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/propertyFilter.js\":\"327275f042061130\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/query.js\":\"455ec8311ee6e060\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/resolveFilter.js\":\"6fe103f3a92a3339\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/sourceBatch.js\":\"52323415ecdbd1d0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/sources.js\":\"2801e5b199d26e06\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/useBacklinks.js\":\"d3e83d90b9abf31e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"98cc6cfe677a1c95\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/BirthdayCelebration.js\":\"9aef0d4005db0bef\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/BirthdayOverlay.js\":\"a69ed59812b96154\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/gate.js\":\"6638e3d541846142\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/index.js\":\"1259604cd708aa08\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/birthday/wolfTheme.js\":\"0f60ec42126fa944\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/BlockDragLayer.js\":\"dc28a3626261a16e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/dragController.js\":\"c44eabfbebf7649f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/dropTarget.js\":\"73e84f757c97b648\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/index.js\":\"60d7409dfe797ea4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-drag/projection.js\":\"d2f58499a2506ee9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-info/BlockMetaCard.js\":\"1f1bb7c646ce67eb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-info/index.js\":\"df2e78e3d87d547b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/AddTagDialog.js\":\"2f737d7bfb5f8afe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e1714a64e6e9891b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/TagNameIssueHint.js\":\"f84b8a6837b9a4b0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/addTagAction.js\":\"f22fc9fee89d2c38\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/appendTag.js\":\"cb38cbab160a8aeb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/config.js\":\"3ad0b3193dacd144\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/dataExtension.js\":\"4514f6078673a345\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/index.js\":\"56f37ce6b7d76c77\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/block-tagging/propertyEditorOverride.js\":\"cb788b932ba871b3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d1cd713ba1517ce1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"518d3e4359116bba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4e00578129590fbd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"79cf12f467cf5160\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e0d19d9e5534dec1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/index.js\":\"b6389fb5474ca16a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"942ef491f4872e59\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/CharacterCountItem.js\":\"8bd6b06505a1de4d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5ae3f4a01a1b2903\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/actions.js\":\"6ba4ef7207acc507\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/blockType.js\":\"69176447c7eddac2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/charCount.js\":\"719665d2fdd6e98b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/dataExtension.js\":\"e85362a573246069\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/index.js\":\"a4eaa1e3ba2c9d80\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/profiles.js\":\"96ed7ab8cb7e0266\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/properties.js\":\"5abf23d18e5738c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/character-counter/textCounts.js\":\"d9e429b2d5752067\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/colemak-keybindings/index.js\":\"c14e5ffae047dec3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/CommandPalette.js\":\"5d25d3875f095641\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/HeaderItem.js\":\"4ff16e20218e9cc1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/context.js\":\"e9147c64abc17851\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/index.js\":\"bc5f8d22e9f323a2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/selection.js\":\"65f958ca7c03dab0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/toggleStore.js\":\"d682e0baa0215a3e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/command-palette/useCommandPaletteActions.js\":\"044223010f7b3e65\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/ContributorBadges.js\":\"e8fc57ae834e453a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/author.js\":\"76b11f8c4f850697\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/codeMirrorExtensions.js\":\"f8ee5ec487b30560\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/dataExtension.js\":\"3d921c0d500cc8cf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/index.js\":\"c016117a65f1b8d5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/mentionAutocomplete.js\":\"96ac1e98f868536c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/processor.js\":\"90b8de85d86a25e5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/profiles.js\":\"d7d8a835d6bfeb55\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/queries.js\":\"69d74eea21f20d52\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/contributors/schema.js\":\"ec425c9131be4c9c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d099ea03cb58119a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7cba978572b3a059\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/index.js\":\"9c05ca97c6ecaaa0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"84a58d698dcaea4f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"ca6c4a553876531e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/CalendarGrid.js\":\"687b78e7e07afdda\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DailyNotePicker.js\":\"fd00f0342d78e0ec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b9817febade0a4be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateNavDecorator.js\":\"12bdbb354d5503b5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/DateScrubOverlay.js\":\"9e0ca68a8b1de316\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/HeaderItem.js\":\"3174daa0dd4e79b5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/ReschedulePicker.js\":\"6de4aff45db3d1a7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/SpreadDatesDialog.js\":\"666ee1cf74c6d381\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/actions.js\":\"8edb3062c29bec9a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/blockDateAdapter.js\":\"af3b1a79fea8dc68\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/calendar.js\":\"e5638cd514f87c97\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dailyNotes.js\":\"b97344a68ba353d5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dataExtension.js\":\"145d51d5cf9e3732\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubActions.js\":\"92e8db2ed52a8135\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubGesture.js\":\"b95244b7b2ae879e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubGestureActions.js\":\"43c355008b381c00\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dateScrubRecognizer.js\":\"5e88d95a9110088d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/deletionGuard.js\":\"61883ddd80586c0b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/dueQuery.js\":\"d73c4596a5b0bc2a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/index.js\":\"9ad1d9a9c81daecc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/landing.js\":\"20c4f8def2bd5a22\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/localSchema.js\":\"7a723d790c07c09b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/referenceDateAdapter.js\":\"945a47802b6dd9d5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/rescheduleAction.js\":\"6f6c15ed72748233\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/schema.js\":\"033363acbd705c6e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/spreadBlockDates.js\":\"4675338ae75f2200\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/spreadDatesAction.js\":\"6357a5d0e8171301\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/today.js\":\"cb356ad6e1e1cafd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"227a18c491121aff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"cf4a362b0018ca3a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/audit.js\":\"82ec5556a281b107\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/auditAction.js\":\"602e0af8e9e59eec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/auditRanges.js\":\"537056b77b7a9486\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/diagnosticsSource.js\":\"545c1d8986bae7d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/divergenceScan.js\":\"593bac1fd2e21055\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/index.js\":\"c1f6e34479c459f5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a6a6a6c563004569\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/referencesMirror.js\":\"2b638b531b4bee59\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/rowJson.js\":\"998d0df30dc2dccd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/schedule.js\":\"24ea724dea97a26e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/data-integrity/store.js\":\"057e6f118d5dbce9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/action.js\":\"9830ad3e9da79430\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/index.js\":\"727aae73cec95453\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-maintenance/plugin.js\":\"74c2e43cfd3461c9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"47617ccbe8e3e4a1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/actions.js\":\"f748a57c32e38f35\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/changeMarker.js\":\"856b4f69624ff16a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/diagnostics.js\":\"842f312d5de072fa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/fileSystemAccess.js\":\"972a86a098858d9d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/filenames.js\":\"4206737cd959aa7d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/index.js\":\"deece67264487a13\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/mirror.js\":\"d0a65fff6bbcf631\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/runLock.js\":\"72fab614debec398\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/runtimeHealth.js\":\"ee4d80343eb96857\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/schedule.js\":\"9900ecab8bcb4fbf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/db-mirror/store.js\":\"0bde58f4e0f831df\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/default-themes/index.js\":\"7fed2a1729e18a30\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/default-themes/themes.js\":\"c62eafff792304d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/diagnostics/facet.js\":\"1c04456001a735c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/diagnostics/useDiagnostics.js\":\"a8ec21a38d67bf49\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/dismissals.js\":\"bdea7564a9b00a30\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/index.js\":\"326aabfd5574f9ff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/status.js\":\"45fa4792824b69dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extension-prompts/store.js\":\"0f11b9f18bd9a159\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2f8a9eaeec0513e8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0fc87936e8d94d70\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/actions.js\":\"61c43b4bd93c5a57\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/config.js\":\"c488915fb5f053f3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/dataExtension.js\":\"19808d636583a02b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/effect.js\":\"b2b8e4e9de7bd5cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/index.js\":\"cafcfbd8b1ef015a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/propertyEditorOverride.js\":\"63fa48e8ec4b4805\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extensions-settings/useToggleTree.js\":\"04620f04bd23878f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/ExtractTypeDialog.js\":\"5b8ab7ad7c084dd0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"31aadcde3c56050d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/PropertyShapePicker.js\":\"772949bc1e010d20\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/action.js\":\"c70e181ed654df86\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/extract-type/index.js\":\"ff5dac56604cc8dd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/FindReplaceDialog.js\":\"73401f6b7aa7538c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/HeaderItem.js\":\"b43a1492744a7e29\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/dataExtension.js\":\"2177938381c3b398\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/index.js\":\"9d46afb508c737b0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/search.js\":\"f668cec433fd92bc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/toggleStore.js\":\"bcf7278782e19a0d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/LocationPropertyEditor.js\":\"3b25b872e7980305\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/MapView.js\":\"526eeaf9de692492\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/blockTypes.js\":\"ca6d9124a3c98c8a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/codeMirrorExtensions.js\":\"2aa69f66dd46cfd3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/createOrFindPlace.js\":\"e445a96fb4b87214\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/currentLocation.js\":\"1f8ed2a430dd6a0a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/dataExtension.js\":\"4934bcf8a115a16f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/geoContentDecorator.js\":\"e11c0323d4661458\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/googlePlacesClient.js\":\"380f815bb53ed74f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/index.js\":\"5609e13283db94b0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/locationsPage.js\":\"e29b0ab71309f535\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/mapViewport.js\":\"4c75ab0680c47bdd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/pickCurrentLocation.js\":\"6298d082ecb79e01\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/placeAutocomplete.js\":\"e528c0ec3de9e341\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/placeNameCollision.js\":\"388a85b1ec2abe70\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/properties.js\":\"238b79ba98d8f038\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/propertyEditorOverrides.js\":\"41ba2a4e50cbde66\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/query.js\":\"d0b1ea89333525cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/geo/usePlaceSearch.js\":\"7befc3dc8dac1f89\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1d5a651f9aba72dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"94d288a0826cb653\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5cbe00f0b84650ec\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/config.js\":\"f6c7baf8822e62cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/dataExtension.js\":\"d171b8925d7c3d8a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/facet.js\":\"2aef58b3e7928c42\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/grouping.js\":\"b72d7b30d5aac7eb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/index.js\":\"c476cd0a17f14d72\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"565ceba817371fb8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/query.js\":\"fb6a3bfc605f74e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/resolveConfig.js\":\"161b637abfb907e3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"25e659f5a0e7511f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"bcea4945794371b6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/HtmlDocumentContent.js\":\"362868aa5f7d2472\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/HtmlFrame.js\":\"99c23b5ccb02d56a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/actions.js\":\"61e0739fd9b5163d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/blockType.js\":\"30a39b18ea70e48f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/confirmRunScripts.js\":\"fabbe530bf240af6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/dataExtension.js\":\"3ff650e7c358dc17\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameAnnotations.js\":\"89a253557ea705a5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameDocument.js\":\"8faaf36dae807cfb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/frameTheme.js\":\"723de815c708a4ed\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/index.js\":\"57c53391404b054d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/scriptConsent.js\":\"2d3c5f166838c367\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/sourceMap.js\":\"b7e2bf9d1de2257c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/html-document/useDocumentScripts.js\":\"1eb9bcd177efad27\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/index.js\":\"c3a5e577656729ea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/record.js\":\"debfe8930e328079\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/recordStore.js\":\"0b7b768e52bedbe1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/responsiveness.js\":\"21a91c29ee9932a2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/schedule.js\":\"c0ea5e84b4cae6f1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/interaction-metrics/sessionContext.js\":\"4212f0fb41294c9c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6393ad8e53ff6926\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ccd006489d7389cd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/actions.js\":\"59c9b69352205559\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/config.js\":\"532c32a6baf1231c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/dataExtension.js\":\"ac712cd64274d394\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/effect.js\":\"c5daacbd16c5d0c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/index.js\":\"7971a38808038444\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/keyCapture.js\":\"f98a2c4f031cfd2b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/overrideStore.js\":\"0d38f08a9eef7585\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a34ddf4e3630f1f1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/HeaderItem.js\":\"8be49254ecb53331\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/LeftSidebar.js\":\"c6da4bbf019ca6e5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/actions.js\":\"dfdc0129d1fcf27e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/facet.js\":\"5bebcfd7862eef16\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/index.js\":\"bb8b2ceb885aac1a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/shortcuts.js\":\"557a31a26f15a91c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/left-sidebar/toggleStore.js\":\"e48769aba5a90308\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/MergePicker.js\":\"bbb46b5e0bb1b013\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/index.js\":\"2dd96d6ee319d53e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/mergeAction.js\":\"b90cc26d85416cfa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/merge-blocks/strategy.js\":\"3798f9e83d38d8c7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/Button.js\":\"476f655bdafb237f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1351a36dcac407b3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7ee76ffccbbf5baa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/facet.js\":\"4bc66231e1fd85b8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-bottom-nav/index.js\":\"642e5f7c877aa2b7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"79842dc05c213376\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/actions.js\":\"65082aaa5c1b9d67\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7007503bf97fd663\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/facet.js\":\"10b359d78ab2a62e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/mobile-keyboard-toolbar/index.js\":\"983c5b28a29af402\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/MoveDestinationPicker.js\":\"0260178595eff137\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3aefafb5ed669a79\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/contextMenuItem.js\":\"04f97d101b262c21\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/index.js\":\"cefa3afa952b2b7c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/moveAction.js\":\"c3009e0a445613d6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/moveBlocks.js\":\"eef0542d15f564cb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/move-blocks/selectionAfterMove.js\":\"de6c03c72ca1fde4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/TutorialBanner.js\":\"a2249b8a12cdd183\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/action.js\":\"41b65cd289f2e9ff\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/bannerDismissal.js\":\"a8cbde5ae96dd17e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/documents/cheatSheet.js\":\"1e20584b3cad71f8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/index.js\":\"56cdbfdb4fca3fc5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/keys.js\":\"1259582fbcc5a845\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/landing.js\":\"d8dd5cfe5824cf97\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/outline.js\":\"586136989697f66e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/onboarding/seed.js\":\"9db8457d7b28d5de\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/PerfTrendDialog.js\":\"819730ac5edd589c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/analyze.js\":\"5bcd607adaefbaac\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/diagnosticsSource.js\":\"1ad93d7e47634430\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/index.js\":\"624f85aedac19636\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/load.js\":\"c352bc181028c85f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/monitorRun.js\":\"c5b4dcb7f82fe02e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/schedule.js\":\"b43c21d53a3a3ffa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/series.js\":\"a0da95d7dc596678\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/store.js\":\"bc5f7a4dcc537d21\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/trendAction.js\":\"aeb223818bc1affe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/perf-monitor/verdict.js\":\"f83e5f6625653ce9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/clickToEditAction.js\":\"4f8e1711947a53b4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/index.js\":\"9e902bd31b619dab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/plain-outliner/interactions.js\":\"f2370cdbdc075353\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"16670c42891a53be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/MigrationGate.js\":\"7e4ccd5140a8ac5b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/MigrationGateDialog.js\":\"1df282556047e0b2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/action.js\":\"21b18be1a10e6a9e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/index.js\":\"2c73821728c54e16\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/localRunMessage.js\":\"076233d10606c6d7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/plugin.js\":\"152f48e30dd08a8b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/progressReport.js\":\"9a2ab98fe8492dc5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/properties-migration/sweepProgress.js\":\"ccdf04d67d53806c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/FieldRowRenderer.js\":\"b97486ee214b8d0e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/ValueRowRenderer.js\":\"72a0eed881658619\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/actions.js\":\"2af6c59bf22b2a91\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/autocomplete.js\":\"742afd137b411e29\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/fieldRow.js\":\"daa19cd185daabdd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/index.js\":\"e37a40accfdeec0d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/referenceWarning.js\":\"805cd4a9962b37fe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/valueAutocomplete.js\":\"c5266d5dbe955a21\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/property-rows/valueSchema.js\":\"7c1ace38e4c1abb2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/HeaderItem.js\":\"29808326c162e3f6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/QuickFind.js\":\"a029b794c069777f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/index.js\":\"f1f5de691e326554\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/recents.js\":\"a35f646776c0a1f4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/resultItems.js\":\"80eb10af035c984d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/selection.js\":\"684ca7a248b91b59\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/quick-find/toggleStore.js\":\"f3c3adaa67416c86\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/HeaderItem.js\":\"787bceb84a9f0354\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/RecentsPageBlockRenderer.js\":\"01414888c796cd5f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/grouping.js\":\"22185f4f2f123633\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/index.js\":\"696ac1955be67ce8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/recents/target.js\":\"b9763a06f84132de\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/codeMirrorExtensions.js\":\"0f015ba6624ef49f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/contentPrefill.js\":\"a3b567561f48d4d1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/dataExtension.js\":\"f070104223344f74\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/index.js\":\"aaf5b41cd4631b82\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4212eb158754be40\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/invalidation.js\":\"6a8040285aad6f66\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/localSchema.js\":\"6a26319447eaafa8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/blockrefs/index.js\":\"1b3aa749e7dc6e66\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"af9252d2503c53a1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/index.js\":\"ae910332132a323c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/referenceNode.js\":\"89aac69862be4d99\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/remark-reference-occurrences.js\":\"3e873fe7d4a13844\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"24efa65be2889d7d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/index.js\":\"0e0e8e0e5e26c8fe\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"14bb716e20ca2ddd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b020ef62f13e5c0a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/mergeRetargetProcessor.js\":\"324d40c404278f4d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/parseFence.js\":\"357efc0876c2f6e6\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referenceParser.js\":\"4ab3aaaf79634350\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referenceProjection.js\":\"c40ec9c3674c3983\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/referencesProcessor.js\":\"475df7ff8b56e929\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/renameProcessor.js\":\"950e53a12e48a162\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/references/spanReplacement.js\":\"72ca4a0a7576fee0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/htmlToOutline.js\":\"151ba76894cff65f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/index.js\":\"b184841d4dad05be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/normalizeClipboardDom.js\":\"672f2545a7251ab3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/rich-paste/pasteDecision.js\":\"cf79c55cc5aa314c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/action.js\":\"beeb4851862a5273\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/blockIds.js\":\"cdd1323e2f43b05f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/content.js\":\"0b2043018583d31c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/effect.js\":\"666bce4227248ccd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/ids.js\":\"f1d6db2b5858d02f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/import.js\":\"131347e2b6f5b88e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/index.js\":\"a0f24c45fa07fae3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/plan.js\":\"43aeed18d9667323\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/plugin.js\":\"c2dce6a85d5f1b9f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/promotion.js\":\"63931af788799eba\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/properties.js\":\"129b5a9e2f0c51ca\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/references.js\":\"2104bd47936be1ea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/report.js\":\"c786636727e1e59d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/roamMemo.js\":\"758c034e9e56e571\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/runtime.js\":\"d196fd89ecd5487f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/schemaReconciliation.js\":\"707f33360b0bbf01\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/srsMarkers.js\":\"907d90a06df8afab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/todo.js\":\"dc43dc215fc0b261\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/typeCandidates.js\":\"61f25ef5aadbd068\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/roam-import/types.js\":\"d46d4fc4797ce7be\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/search-health/index.js\":\"96338ec80bc796a9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/search-health/store.js\":\"e7825c1500e08a82\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/HeaderItem.js\":\"f97979a2d00c1bf5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9911f09226427930\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/index.js\":\"408ab63962d3e705\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/model.js\":\"a225b6e8b7990a03\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/toggleStore.js\":\"b941da8248f851ad\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/shortcut-help/useKeyInspector.js\":\"6519c2b097f5ebc1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a770180e06feee62\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/ShellDecorator.js\":\"67b3c6f281583413\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/actions.js\":\"266d8f649a291388\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c91669bf622d73ad\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/index.js\":\"b3940d0ba6bdeaef\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/shell.js\":\"6648fa3beb6a8ce8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/surface.js\":\"0c3066c6d28bc9b2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/spatial-navigation/walker.js\":\"1dd9846710bcfd3c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f7c27d577874a4fa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/dataExtension.js\":\"f0e516510f371304\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/index.js\":\"7602218ba28e10c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/indicator.js\":\"5ec48684028e6668\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/moveSrsState.js\":\"8508a7ec11a62b33\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"49aa6d3f4873e9d7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/scheduler.js\":\"0f18218bdf65bf35\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/schema.js\":\"5d97f69eb342c245\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"157f450cdc3a10dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/srsClipboard.js\":\"5aa69849ff8da490\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e90ec381c0f45f7a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/DailyNoteReviewHint.js\":\"086773c287136a74\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/DeckPicker.js\":\"4aae82b7e8ffb1e2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewControls.js\":\"6efd077228b1808d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1a5ea2de09dede23\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/ReviewSession.js\":\"64b333acfd8f4ff1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/actions.js\":\"1a19097e60998766\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/archive.js\":\"ea4ef0983cb8585f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/dataExtension.js\":\"06c98533d904b831\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/deck.js\":\"0511df1485b84061\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/dueQuery.js\":\"c96d6dbd06a8928f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/gradeDecision.js\":\"14d600bc28f8c060\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/index.js\":\"dd9b5d07d73e88c3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/keyHints.js\":\"a78a2ae5bc6d03dc\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/reviewCardLayout.js\":\"0708d873da4595c1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/reviewProgress.js\":\"72c564b506fc9659\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/schema.js\":\"8b2479e7f5432c26\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/srs-review/useDueCards.js\":\"60b7e0beafaa2045\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/startup-metrics/index.js\":\"162130a812319432\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/startup-metrics/record.js\":\"22cf56cccb6af821\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/index.js\":\"629f984e7950e6d4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/persistenceStatus.js\":\"0a2d5c8c855ee233\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/storage-persistence/requestAction.js\":\"3fd6162e0d7213e9\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/TypeChipsDecorator.js\":\"ccd57e216001aa5e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/codeMirrorExtensions.js\":\"f91c898941414c03\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/index.js\":\"9ec20da876ca165a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/supertags/typeAutocomplete.js\":\"0ac0f0ecf857a096\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ea984b96786d1c0e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/actions.js\":\"6c28c1c69b7d6b30\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/anchor.js\":\"effe2f21fe94b9c7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/events.js\":\"83ae1381045c84fa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/gestureActions.js\":\"45d676ee2546aac3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/index.js\":\"0ce539e938c79c67\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"775b82405020c127\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/collect.js\":\"b31e2d852837f11b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/index.js\":\"eef03c1ff566a7a5\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/sync-metrics/record.js\":\"73f1b862741d1bbf\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/RejectionDialog.js\":\"5b828da1afd9ed8b\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/SystemStatusHeaderItem.js\":\"50763d034c85dc05\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/index.js\":\"78ccb9578340cf06\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/model.js\":\"cba086c57a425b1f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/queueCounts.js\":\"57b98828167605c2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/rejectedHelpers.js\":\"5c091784ef6c3ddb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/rematerializeAction.js\":\"c5eb7f70dbcf77ea\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/system-status/useHysteresis.js\":\"7b78c72783760fd8\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/ColumnHeaders.js\":\"95c60185356a64e3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/QueryUi.js\":\"6443cc115aa8e95e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/TableLayout.js\":\"ebbcf614281b1591\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/actions.js\":\"8009fa0461522549\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/cellEdits.js\":\"0d4a4d8f47d61cfa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/columns.js\":\"6ab9e8e12246fc1f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/controller.js\":\"98a7edacda60e4fb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/convert.js\":\"599d5ec22aaa0adb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/dataExtension.js\":\"329102bff76052aa\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/index.js\":\"255c0d6b13291d32\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/keys.js\":\"925eaa4081237893\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/model.js\":\"4f71325a4e35ca61\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/backfill.js\":\"8c9fc3f085d935f4\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/format.js\":\"b5e46ec19a2482f2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/parse.js\":\"c2a997cd52d06437\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/queryValue.js\":\"fdae4b178bcfd63e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/query/source.js\":\"3e1522c53057609c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/registry.js\":\"c6138d2b2e11e423\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/schema.js\":\"51b209f40120a219\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/tables/sort.js\":\"a7dc9d10a7c08d25\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/effect.js\":\"da8d8cbd6cd1f39a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/index.js\":\"de448acaadacc352\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/theme-toggle/theme.js\":\"eba9bda726112b4f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/actions.js\":\"281e91d3dc88a513\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/dataExtension.js\":\"5a843d7011c7f662\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/index.js\":\"55ba71ccbacb3880\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/todo/schema.js\":\"eb94d8ebab26c5ab\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/TouchSelectionLayer.js\":\"603560c7b9934539\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/actions.js\":\"179cf9966180a329\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/defaultItems.js\":\"8be3bcb260d665e1\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/facet.js\":\"9440e386b066679e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/holdRecognizer.js\":\"8226dd8d1a113cb7\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/touch-selection/index.js\":\"2d5fcf5fa7fc7c6c\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/UpdateIndicator.js\":\"9aa0d16cd03e3142\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/index.js\":\"14125df67854941e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/update-indicator/loadTimes.js\":\"b40eb3c7b364490a\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoNotesRenderer.js\":\"b9ae74c324982912\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoPlayerRenderer.js\":\"85765782564bae78\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/VideoTimeStamp.js\":\"99f6aea35dc12be2\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/actions.js\":\"0d45320c23fa56b3\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/index.js\":\"be6291996350ef82\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/markdown.js\":\"78320550dc297c35\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/notes.js\":\"959a9dd85bdc692e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/registry.js\":\"517b601a7a249b04\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/remark-timestamps.js\":\"9fcd5e784e62ee4d\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/video-player/view.js\":\"05068b52c47a8d05\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/LinkHints.js\":\"272d90ccbc06720f\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/index.js\":\"fab85db2fe514afd\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/model.js\":\"e70e599fdaebef18\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-link-hints/settings.js\":\"683430c4ade1d4f0\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/actions.js\":\"c83fa92629c5addb\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/index.js\":\"bcb5b455fb21d591\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/vim-normal-mode/interactions.js\":\"11d5967b9014702e\",\"/knowledge-medium/pr-preview/pr-1838/src/plugins/workspace-header/index.js\":\"0b8bac249bdbabb9\",\"/knowledge-medium/pr-preview/pr-1838/src/registerServiceWorker.js\":\"1f9e6ab995adb067\",\"/knowledge-medium/pr-preview/pr-1838/src/requestPersistentStorage.js\":\"cf98d5c4980722d6\",\"/knowledge-medium/pr-preview/pr-1838/src/services/authRequestDeadline.js\":\"2028d53a536c9e57\",\"/knowledge-medium/pr-preview/pr-1838/src/services/authStorage.js\":\"cbe4b0aa795e1b24\",\"/knowledge-medium/pr-preview/pr-1838/src/services/powersync.js\":\"d3709782e373d4d0\",\"/knowledge-medium/pr-preview/pr-1838/src/services/supabase.js\":\"2dbd3508689e8ff0\",\"/knowledge-medium/pr-preview/pr-1838/src/services/uploadErrorClassifier.js\":\"bc1c8f7a3dcb5dea\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/ActiveContexts.js\":\"c8264151b7754a19\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/HotkeyReconciler.js\":\"edfe8a2ac34d09fd\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/WipeLocalDataDialog.js\":\"45613c8e01e463f0\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/actionDispatch.js\":\"915259a2e0a4dd61\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/actionRefItems.js\":\"3aff10ce8c6d6bf1\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/applyKeybindingOverrides.js\":\"21f34af8df02d3a8\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/blockActions.js\":\"abc8956dc07398c9\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/canonicalizeChord.js\":\"69cd6f624fe2490f\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/defaultContexts.js\":\"b19741209d854576\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/defaultShortcuts.js\":\"cd9d3c538ea748c3\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/effectiveActions.js\":\"f908124d5d9bb5d7\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/gestureAction.js\":\"16e87907af573da8\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/gestureBinding.js\":\"b49818f5cce5ceea\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/holdRegistry.js\":\"eca6ccd1b93584d8\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/keybindingConflicts.js\":\"4f073230eafc9f14\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/keybindingOverrides.js\":\"b6b58eeb8084be2e\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/pointerAction.js\":\"fd6e77d1f874bf52\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/resolve.js\":\"511042a649aa6bc2\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/runAction.js\":\"8da0fd7ceefe02ac\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/sequenceMatcher.js\":\"db5c2109a9cd23f9\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/types.js\":\"56679179bcd79136\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/useActionContext.js\":\"5e59cf02dadaf70c\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/useActionDiscovery.js\":\"538d4e36a59c7b1e\",\"/knowledge-medium/pr-preview/pr-1838/src/shortcuts/utils.js\":\"658a85b3aec71213\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/bootStore.js\":\"ae8a9a30ce98fbf3\",\"/knowledge-medium/pr-preview/pr-1838/src/sw/previewDatabases.js\":\"973e552c9b57ea65\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/byteTransform.js\":\"0300076b8095a504\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/attachmentCleaner.js\":\"3821353bde90c0de\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/attachmentParts.js\":\"2b0d894324e8d1ee\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/bundleParts.js\":\"95622210b08f974e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/bundleRecord.js\":\"e0351c6df079848c\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/manifest.js\":\"995e60e53f68601e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/takeBundle.js\":\"37cf1183b47bc869\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/bundle/verifyBundle.js\":\"c9c57d6bce362f37\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/cleaningStage.js\":\"b4f2b585b2214dc0\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionKey.js\":\"f8936bd689b5cb95\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/conversionServer.js\":\"9e4bbdf3c3f8a631\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/flip.js\":\"d9fec29f0535595b\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/flipAttempts.js\":\"b15dced32b1929e0\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/pages.js\":\"0085227c844f0ce2\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/preflight.js\":\"44a9bba6ee97122a\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/reseal.js\":\"9459fc581c00fd7f\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/runConversion.js\":\"f84c8a443cd0c84a\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/runLock.js\":\"9a9fa07160e7309c\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/sealing.js\":\"b4bc704ab8f6a1e7\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/sealingStage.js\":\"d3c5bd7ff923966e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/stage.js\":\"e78393a1efdb8d29\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/conversion/verifyReseal.js\":\"13ebbe7dfad39f23\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/aad.js\":\"0288aee28bc529e0\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/aead.js\":\"47e679d0d1f1c53e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/base32.js\":\"e88869321c8b1328\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/base64url.js\":\"6e17803518e8804e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/binaryEnvelope.js\":\"6c5d133e3789cf5d\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/byteAead.js\":\"6d47ee1efd09bea3\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/canary.js\":\"5485c74e103f49e2\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/contentHash.js\":\"4574d63597506e71\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/contentKey.js\":\"71b2ad2174a959dc\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/derivedIdNamespace.js\":\"8e2018a4160a253f\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/envelope.js\":\"2293eeb70c21801f\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/hex.js\":\"a0076316c146acaf\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/sha256Hex.js\":\"60964ff43285b53c\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/crypto/workspaceKey.js\":\"78e9b87b560af97f\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/conversionState.js\":\"03533bc039992703\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/createEncryptedWorkspace.js\":\"dc6b1c040870e9bf\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/pastedKey.js\":\"ba3400be63a40e0c\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"534c1eaae97f894a\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e21318bfeb09b601\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/keyStore.js\":\"fcf89475c1b7be34\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/mintWorkspaceKey.js\":\"64431be686af7f64\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/modePin.js\":\"1ad9b7a3f87418fe\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/openWorkspaceKeys.js\":\"0b6d41b763c9adf0\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/resolveWorkspaceEntry.js\":\"54eb62f9a09c53fa\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/resolver.js\":\"0ccfd5dd6d5e3add\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/keys/workspaceAccess.js\":\"7cb1a93fbd8eb09e\",\"/knowledge-medium/pr-preview/pr-1838/src/sync/transform.js\":\"5da3979f5cd39f4b\",\"/knowledge-medium/pr-preview/pr-1838/src/themeBootDefaults.js\":\"7afd9a2afe0bf314\",\"/knowledge-medium/pr-preview/pr-1838/src/types.js\":\"08fb8ea21b688d7d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/ClientLocalSettings.js\":\"6d11aaf86fc9513d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/abortableSleep.js\":\"971b2d760444d03e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/array.js\":\"3000e2fabeebf8b6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/backlinkAutocomplete.js\":\"5b23996a420e22eb\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/blockCrumbs.js\":\"1e149b5d6e75c058\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/blockrefAutocomplete.js\":\"5b113336938a8861\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/cadencedIdleJob.js\":\"8ad30511d606b3cf\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/callbackSet.js\":\"547677b13b4bc80e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/clientId.js\":\"16198ca34cfd588a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/codemirror.js\":\"ad13ca79f9c32657\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/codemirrorCompletion.js\":\"8a178b1d98e3b6fa\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/copy.js\":\"b0ec357ff478a887\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dailyPage.js\":\"8228b6cb808690f4\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dbForensics.js\":\"651c4cc321191c0a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dbForensicsHooks.js\":\"a97e7b48afae95cf\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/deleteBlockThroughUi.js\":\"ce772bdd87cdaf1a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dialogs.js\":\"c237dd04179d024b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/dom.js\":\"c05f837700ab2040\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/downloadBlob.js\":\"0790152f50ea6d72\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/exportSqliteDb.js\":\"a5fa1e41d31ba233\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fileSystemAccess.js\":\"5109c379a44ac1c4\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/flipSlide.js\":\"e638dd1e725ced29\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fnv1a.js\":\"8228843ff2685dfa\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/formatBytes.js\":\"80775e974969b576\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/fuzzyRank.js\":\"e8d3ff63d3671b9e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/idbKeyedStore.js\":\"f94137c6043c9633\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/idleCallbackPolyfill.js\":\"912aa8808224ac3e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/keyboardAwareScroll.js\":\"3da4dda65a0d96e3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/keyboardViewport.js\":\"95f1e22b0ba17735\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/lastWorkspace.js\":\"e9f862fcece2dcd1\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutColumns.js\":\"1e8925e94bf2430a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutSessionDom.js\":\"707898f27b654b4c\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/layoutSessionId.js\":\"43128b7f2e23b95d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/linkClickGestures.js\":\"54e51fff6c501f44\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/linkTargetAutocomplete.js\":\"edde1dca71bc09fe\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/localDbCorruption.js\":\"579ad16cc7c6289b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/localDbRecovery.js\":\"978e542fb25fdfcc\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/markdownParser.js\":\"3295ebc56f5c7109\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/memoize.js\":\"31525e1e908304db\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/nameFieldCommit.js\":\"ba243436a66f5ba8\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/nameList.js\":\"6d05439a04a7b617\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/navigation.js\":\"80922f25cb18e8b3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/omnilinerNamespace.js\":\"c5153b92931e47c8\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/opfsPageScan.js\":\"7e27a14d75c87e95\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelClearance.js\":\"88bc58b49332596a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelHistory.js\":\"edde2fcdb930c1f9\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelLanes.js\":\"b17f5b6d2a66a9b2\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelLayoutProjection.js\":\"0b792abd565f1323\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelScrollAnchor.js\":\"32b7e5ca964b4ef3\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/panelUrlFlags.js\":\"4ca8c82e4ca48d61\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/platform.js\":\"a4ab5508697b3931\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/pluralize.js\":\"4f7de5e47509d847\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyCreation.js\":\"eadeaddff3a8fb3f\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyNavigation.js\":\"9258bc027b99c027\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/propertyValueContext.js\":\"a2b843ea761e6c81\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/react.js\":\"98fc0a1dfd7bdc1b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/relativeDate.js\":\"c46fcfb886cddb07\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/relativeTime.js\":\"7fcad4c57ec392aa\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/renderScope.js\":\"4a49c44aed70f21a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/resolvedThenable.js\":\"31e2b9a8b653a616\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/routing.js\":\"25d696b1a034a54d\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/safeMode.js\":\"f6a51ec85474a38b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/scheduleIdle.js\":\"364ead3e4c8b837e\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/screenWakeLock.js\":\"d98372088674a80a\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/selection.js\":\"ea3a58ffdfb2c267\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/softKeyboardGrab.js\":\"9359fce681a9889b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/startupTimeline.js\":\"989e1839fbdfdaed\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/state.js\":\"0c8856dbcdb1487f\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/string.js\":\"5f5d899722849472\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/surfaceZoom.js\":\"491768f37145ab7b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/time.js\":\"6f99c33c8ff274ff\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/toast.js\":\"fccebc5e774184d5\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/toggleStore.js\":\"ce044b3516af660b\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/untilStopped.js\":\"d2f4b991646f18eb\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/userActivity.js\":\"0b2bf678d9b234ff\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/viewTransition.js\":\"ca82d7fe4c5529b7\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/viewport.js\":\"f350603dd7e523ca\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/webLock.js\":\"1148b52787100563\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/workspaceRecovery.js\":\"5cbfbd59651a7e83\",\"/knowledge-medium/pr-preview/pr-1838/src/utils/workspaceSnapshotStore.js\":\"233d0ba0093064bd\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-compiler-runtime.js\":\"f3c4db49ec749ce7\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-client.js\":\"deb1676c2ff72d52\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-server-edge.js\":\"c9e2c130f79c8ad7\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-server.js\":\"883c56e3e9403541\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-static-edge.js\":\"3d9c42c9b8ed07ad\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-static.js\":\"f54e4bf78de4fb55\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom-test-utils.js\":\"64b17cccb57b7a1c\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-dom.js\":\"a3fd12f8e4652d0c\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react-jsx-runtime.js\":\"a3d1edf23be25fe8\",\"/knowledge-medium/pr-preview/pr-1838/src/vendor/react.js\":\"a0a3cf71c51c18b6\",\"/knowledge-medium/pr-preview/pr-1838/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1838/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1838/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
