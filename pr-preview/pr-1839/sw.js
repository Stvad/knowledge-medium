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
		buildId: "0d06107ead78-ae4e3dac",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1839/\":\"fac4c58eed6fe80d\",\"/knowledge-medium/pr-preview/pr-1839/index.html\":\"fac4c58eed6fe80d\",\"/knowledge-medium/pr-preview/pr-1839/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1839/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1839/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1839/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1839/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1839/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1839/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1839/assets/FacadeVFS-B_XJYgXu.js\":\"7c5a5d582bd53742\",\"/knowledge-medium/pr-preview/pr-1839/assets/OPFSCoopSyncVFS-BTiiOOhp.js\":\"6bc9708a0e10aec2\",\"/knowledge-medium/pr-preview/pr-1839/assets/OPFSWriteAheadVFS-BCYyRMIP.js\":\"d4c5d14542cdb045\",\"/knowledge-medium/pr-preview/pr-1839/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1839/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1839/assets/wa-sqlite-async-C5HKNvJG.js\":\"c871ffd7d56852ad\",\"/knowledge-medium/pr-preview/pr-1839/assets/wa-sqlite-lDWFF0mT.js\":\"71507875e023c5fe\",\"/knowledge-medium/pr-preview/pr-1839/assets/worker-BMiqJyXd.js\":\"df28bda40ed17ad1\",\"/knowledge-medium/pr-preview/pr-1839/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1839/chunks/app-DnlJ__Aw.js\":\"bac9531bf353f561\",\"/knowledge-medium/pr-preview/pr-1839/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1839/index.js\":\"8eae4c6ec1054cca\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1839/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1839/assets/AccessHandlePoolVFS-bSoTyXkd.js\":\"d50c8b6dcd1c6098\",\"/knowledge-medium/pr-preview/pr-1839/assets/IDBBatchAtomicVFS-2dhwMCLg.js\":\"8d2a4985be2ea421\",\"/knowledge-medium/pr-preview/pr-1839/assets/MemoryVFS-JYU8lxfy.js\":\"cb3b20ed07bbb6ac\",\"/knowledge-medium/pr-preview/pr-1839/assets/mc-wa-sqlite-CPBdlOLl.js\":\"61f45e61d0c1dc94\",\"/knowledge-medium/pr-preview/pr-1839/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1839/assets/mc-wa-sqlite-async-Ds6TnwNW.js\":\"c4e03c17b3bbdb7d\",\"/knowledge-medium/pr-preview/pr-1839/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1839/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1839/chunks/AccessHandlePoolVFS-Ba2FywJZ.js\":\"d23dfdc6fa1a3466\",\"/knowledge-medium/pr-preview/pr-1839/chunks/FacadeVFS-DvVylH35.js\":\"6c15190ca5dfc0a5\",\"/knowledge-medium/pr-preview/pr-1839/chunks/IDBBatchAtomicVFS-pOTbhwtF.js\":\"f721dc7af0b9335e\",\"/knowledge-medium/pr-preview/pr-1839/chunks/MemoryVFS-CJ3QU0XQ.js\":\"8b918d3dd44cd63d\",\"/knowledge-medium/pr-preview/pr-1839/chunks/OPFSCoopSyncVFS-w8u8n8NM.js\":\"b5b371029055f4c8\",\"/knowledge-medium/pr-preview/pr-1839/chunks/OPFSWriteAheadVFS-BkNOtDUX.js\":\"8d2d3e3273d15ef4\",\"/knowledge-medium/pr-preview/pr-1839/chunks/Preview-DjV0fv3x.js\":\"7eba7c157d83652f\",\"/knowledge-medium/pr-preview/pr-1839/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1839/chunks/card-DJAU3ZDU.js\":\"69a476cc659d02ac\",\"/knowledge-medium/pr-preview/pr-1839/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1839/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1839/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1839/chunks/dist-CjYCIeoA.js\":\"a41306825dfced1e\",\"/knowledge-medium/pr-preview/pr-1839/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1839/chunks/mc-wa-sqlite-B-isHzz6.js\":\"2acef1455542080c\",\"/knowledge-medium/pr-preview/pr-1839/chunks/mc-wa-sqlite-async-DRno3wm1.js\":\"b9ed22e13b8cccd1\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-BHfRPT1P.js\":\"ba4c67522064b125\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-CI8xk4vA.js\":\"c98681c5edb6b9c1\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-CK4VJLhJ.js\":\"74b09e2b22250136\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-Cy14hQHv.js\":\"ae96acd3b6ed5f7b\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-DiSeW6fJ.js\":\"409da1c4a84e9e57\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-dom-server-legacy.browser.production-CDK3RFZU.js\":\"4e2a8649c9981e94\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-dom-server.browser.production-BW53CYkT.js\":\"c89a9f6286cc7a69\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-dom-server.edge.production-8okrIsP7.js\":\"a721f3e27d15e7c3\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-f4bNcE_2.js\":\"751491a825a8a3c9\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-fsD0lPK9.js\":\"eeb734f176a03039\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-ynm575yh.js\":\"626890241115d534\",\"/knowledge-medium/pr-preview/pr-1839/chunks/server.browser-DDDIzw2H.js\":\"b0ff31125fc0db18\",\"/knowledge-medium/pr-preview/pr-1839/chunks/textarea-CZDXgdIC.js\":\"60cdb81d3109a5f1\",\"/knowledge-medium/pr-preview/pr-1839/chunks/ui-BmaIX8eg.js\":\"2d1946e151c5374b\",\"/knowledge-medium/pr-preview/pr-1839/chunks/wa-sqlite-async-Csm--P64.js\":\"edd4992a8b1ebc86\",\"/knowledge-medium/pr-preview/pr-1839/chunks/wa-sqlite-cXKe6feQ.js\":\"7053c1648df83958\",\"/knowledge-medium/pr-preview/pr-1839/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1839/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1839/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1839/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1839/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1839/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1839/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1839/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1839/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1839/src/App.js\":\"9bb1700201fdabce\",\"/knowledge-medium/pr-preview/pr-1839/src/appUpdate.js\":\"6bd10fda0aee2203\",\"/knowledge-medium/pr-preview/pr-1839/src/appVersion.js\":\"a544e1fcf651dac7\",\"/knowledge-medium/pr-preview/pr-1839/src/bootstrap/initialLayout.js\":\"4eeda8176bcf0dd0\",\"/knowledge-medium/pr-preview/pr-1839/src/bootstrap/openWorkspaceData.js\":\"26af49af3caf7ab0\",\"/knowledge-medium/pr-preview/pr-1839/src/bootstrap/resolveWorkspace.js\":\"3130f09bf297519b\",\"/knowledge-medium/pr-preview/pr-1839/src/bootstrap/workspaceBootstrap.js\":\"7c3a6b2d0cc73f5d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockComponent.js\":\"d01f90ded937648c\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockCrumbs.js\":\"ef2724aaf9b3307f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockEditor.js\":\"5864364e48693c53\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockLoadingPlaceholder.js\":\"e32f8c84f2bd8e9c\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockProperties.js\":\"2941ac80a20c8547\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockSearchPicker.js\":\"24d0736244c57526\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ConfirmBulkDeleteDialog.js\":\"c3124c3d360b145f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/DividerHandle.js\":\"7ae95968d7a9b140\",\"/knowledge-medium/pr-preview/pr-1839/src/components/DraftEditor.js\":\"eef44a2a40a804ef\",\"/knowledge-medium/pr-preview/pr-1839/src/components/GutterPill.js\":\"7ceb490c3cb08aad\",\"/knowledge-medium/pr-preview/pr-1839/src/components/Header.js\":\"acedb38129db2c63\",\"/knowledge-medium/pr-preview/pr-1839/src/components/LazyBlockComponent.js\":\"909934ad0b37e568\",\"/knowledge-medium/pr-preview/pr-1839/src/components/Login.js\":\"971ffef1231c2a1b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ZoomableSurface.js\":\"6fa5df1b487b15a1\",\"/knowledge-medium/pr-preview/pr-1839/src/components/editModeKeepalive.js\":\"9f7aef80531e96de\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a42b0e3550c93c71\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8f6cdef182b871f9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/RefPropertyEditor.js\":\"10aa6f92e5b1a140\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/RefTargetTypePicker.js\":\"679347551e378714\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/SelectPropertyEditor.js\":\"18f352fdd5aee288\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/TypesPropertyEditor.js\":\"f13b2b204a24825e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/defaults.js\":\"6bdbf8ff8f01b5fd\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/kernelValuePresets.js\":\"0a7891a291c91c3e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/selectablePresets.js\":\"fd6da8d1f4295ddc\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/typesPropertyUi.js\":\"de98b71f4d28273f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/AddPropertyForm.js\":\"45ea9b8439ca7459\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/PropertyPicker.js\":\"2f6e46acb2131ade\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/PropertyRow.js\":\"cde7e534195a9e28\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/Rows.js\":\"10136df1dfe82c06\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/actions.js\":\"cabbbaa8e01b466a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/declarationOnly.js\":\"8f3fb4eb6d6e0342\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/layout.js\":\"05fa803b4596e887\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/model.js\":\"f5731902b49e9bd9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/shapeUi.js\":\"778af5aec7b5428f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/shapes.js\":\"c9c51682c0871ea4\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ee452876e7e4cd48\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/visibility.js\":\"0993ea29fb390ee7\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanelSections.js\":\"ec40df15b2d421f9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/BlockEmbed.js\":\"7f1aa60bc401f36e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/BlockLink.js\":\"9010d07cb067aa5e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/BlockRef.js\":\"fc2d8285aa573251\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/ReferenceLink.js\":\"27ad8ad34433322c\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/cycleGuard.js\":\"ec6ab8ea11b7a913\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/cycleGuardContext.js\":\"c2c5d0a1334d1d11\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/linkInteraction.js\":\"55123f92ad3652dd\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/referenceLayout.js\":\"d4f190f198fba068\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/useBlockRefAncestors.js\":\"b395d89673a2b2bb\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/BlockGutter.js\":\"682b6cdd937b8f64\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/BlockInfoDialog.js\":\"10de526cb178e54a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/BlockTypeBlockRenderer.js\":\"5f20b703de48e9ea\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/BulletHoverCard.js\":\"2f8404e75dd1279b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/CodeMirrorContentRenderer.js\":\"66d54340646c3f6b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2e43d0e7fecc85cc\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/ColumnResizeHandles.js\":\"0593d20d7ece476f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"56d59bbbc7c2b08f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/DefaultBlockRenderer.js\":\"81e9435f48f0c1ad\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/LayoutRenderer.js\":\"d085022c424742f3\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/MarkdownContentRenderer.js\":\"189a3af955ac27e8\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/MissingDataRenderer.js\":\"0a68282315f19646\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/PanelRenderer.js\":\"094ad4bb6c2e046b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e548e41a60bbcc0d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/TopLevelRenderer.js\":\"c9b00d7aeba6b29a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/blockGutterMode.js\":\"3948c8d18038a2ee\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/blockTitleText.js\":\"201d5dc91eccddb3\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/fieldCreationKeydown.js\":\"a3904609cd612806\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/layoutRootContext.js\":\"9520f40fef81507d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/typeChip/TypeChip.js\":\"3c5d73c558fb51d8\",\"/knowledge-medium/pr-preview/pr-1839/src/components/typeChip/chipStyle.js\":\"456c01c3d695e3b9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/anchored-floating.js\":\"de2137a445bf03e4\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/button.js\":\"f2140dd89a5f83b0\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/card.js\":\"946336969d4dd0b0\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/checkbox.js\":\"c2231132938b1a38\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/collapsible.js\":\"acdae4ade745a42e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/command.js\":\"d6d9b11dec892183\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/context-menu.js\":\"5519c0b597a6d2ff\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/dialog.js\":\"c7830a3d1e20226a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/dropdown-menu.js\":\"80860d01887af806\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/floating-listbox.js\":\"c93e5a0eb6de9150\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/index.js\":\"2329806473ca0035\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/input.js\":\"9f276dab195a05af\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/kbd.js\":\"092e69ae57b5ce23\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/label.js\":\"3386f18b3f3b6e4e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/textarea.js\":\"54a1a889fe80a5ae\",\"/knowledge-medium/pr-preview/pr-1839/src/components/useEditModeYieldKeepalive.js\":\"75b9270194b794d9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/BootFallback.js\":\"27fbd46a1eb890a8\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/FocusedRowLazyMount.js\":\"27d28b9e9ae8f198\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/LazyViewportMount.js\":\"26e2a621cc4a744a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/LocalDbCorruptionFallback.js\":\"5db9e0988b5241f1\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/error.js\":\"86af4169da3f3588\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/lazyMountRegistry.js\":\"b1ed9dcfc4d268f3\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/suspense.js\":\"e168aa19d9e2bd22\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/CreateWorkspaceDialog.js\":\"ba685439f3fe0a2d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/PendingInvitations.js\":\"efad2645673dbb93\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/SyncProgress.js\":\"f7336cec97a749e1\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/UnlockProgress.js\":\"0be1d7493114b876\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/WorkspaceKeyGate.js\":\"806ad5145a8ef77f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/WorkspaceSettingsDialog.js\":\"1aeb668b40da788d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/WorkspaceSwitcher.js\":\"108e78e77dbc11d8\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/WorkspaceSyncGate.js\":\"9db9757156eaf243\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/ConversionFlow.js\":\"b1afcd05df8b299e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/ConversionFlowHost.js\":\"b76c9f4eecadb050\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/EncryptionSection.js\":\"d85a950ba7e924f8\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/attachmentPrompts.js\":\"8d70a53511033194\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/bundleFolderPrompts.js\":\"bb838ee4de3db4e5\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/conversionFlowDeps.js\":\"cc2ea4a279efdaa7\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/conversionFlowStore.js\":\"59e5ffb1707df4fe\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/flowUi.js\":\"d4cbdf9631c708d9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/useConversionRun.js\":\"f86c98d662bfb6f3\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/keyUi.js\":\"842cbbf5a591ad21\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/useCloseOnKeyLoss.js\":\"e6d74ba3497136ce\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/useCloseOnServerE2ee.js\":\"d57b827978ceacb9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/workspaceUnlocked.js\":\"2d34b977d60686d6\",\"/knowledge-medium/pr-preview/pr-1839/src/context/backgroundSubtree.js\":\"a5fe003cc78147bc\",\"/knowledge-medium/pr-preview/pr-1839/src/context/block.js\":\"47de5df69902114b\",\"/knowledge-medium/pr-preview/pr-1839/src/context/layoutWsContext.js\":\"bf3c1978f83462d4\",\"/knowledge-medium/pr-preview/pr-1839/src/context/propertyDisplay.js\":\"2dcfa24468ec69ca\",\"/knowledge-medium/pr-preview/pr-1839/src/context/repo.js\":\"b905c30f8bba9131\",\"/knowledge-medium/pr-preview/pr-1839/src/data/aliasClaim.js\":\"d5b1dbb632d2bb92\",\"/knowledge-medium/pr-preview/pr-1839/src/data/aliasSeatNamespace.js\":\"77dee24399336680\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/blockData.js\":\"74e0650da24f0483\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/blockType.js\":\"11f866e439269e70\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/changeScope.js\":\"34d26907b8bdf361\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/codecs.js\":\"9b0a337cd04f3e77\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/derivedData.js\":\"95c4cfb395f3680a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/errors.js\":\"ddb2a64cdeaabb08\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/events.js\":\"aac2d933c92e9de2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/handle.js\":\"cf43b6b95db21eb9\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/index.js\":\"30b7140c8d01f5f7\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/mutator.js\":\"7983f66e1a31ee90\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/processor.js\":\"326cfd0983314a08\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/propertySchema.js\":\"485c19c75c76f71b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/query.js\":\"65167772c804dc9d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/sameTxProcessor.js\":\"12eed21944790b2b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/schema.js\":\"cf43b6b95db21eb9\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/tx.js\":\"cf43b6b95db21eb9\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/typedBlockQuery.js\":\"cfb452561f4218e0\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/user.js\":\"9175d9415c5f6eba\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/valuePresetCore.js\":\"2de904166829f937\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/valuePresets.js\":\"cfa770d08d849b82\",\"/knowledge-medium/pr-preview/pr-1839/src/data/attachmentCleanerIOVerb.js\":\"e64370a0bd4519a4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/block.js\":\"d12e9f615b44edeb\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockCache.js\":\"f46f221584065562\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockId.js\":\"e0291b309ad75013\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockLiveness.js\":\"8ae89af33940eb3e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockMerge.js\":\"e20c07b1d662fde0\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockSchema.js\":\"a7e0a6b0c1d47367\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockTypeLookup.js\":\"7f68ccbafcb02374\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockTypes.js\":\"184876cf9bf7d5c4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/clientContext.js\":\"6434aa278ccc0a16\",\"/knowledge-medium/pr-preview/pr-1839/src/data/dbFileSiblings.js\":\"aaad25358d8eb39f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/definitionSeeds.js\":\"47b92ec8c110f4c4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/derivedIds.js\":\"b5790b376af3c6dc\",\"/knowledge-medium/pr-preview/pr-1839/src/data/drawnSubtree.js\":\"cb8e3a43955be91a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/facetBridge.js\":\"4efa2de167cd74c5\",\"/knowledge-medium/pr-preview/pr-1839/src/data/facets.js\":\"0fab0aaa39959a62\",\"/knowledge-medium/pr-preview/pr-1839/src/data/globalState.js\":\"90bfc03bc75dd7ad\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/aliasClaimRederiveProcessor.js\":\"69a7005b72d89ce2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/ancestorBatch.js\":\"93ba548a9d0c6c32\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/blockTypeTypeifyProcessor.js\":\"72201755093e4311\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/clientSchema.js\":\"920c6955c1c80708\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/commitPipeline.js\":\"51d6341b4086756f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/devAssertions.js\":\"8020ffa5d2528357\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/firstSync.js\":\"51c4627e6802689f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/freshInitialLoad.js\":\"713cfd31a0d4fd60\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/graphBackfillClaim.js\":\"ece028590df7182b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/handleStore.js\":\"e3494f6b06836c42\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/idleMarkerJobs.js\":\"1a5c2b1b43bc23dc\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/initialDownload.js\":\"b3dd9d377ded9b8f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/initializeClientDatabase.js\":\"026c55520c126432\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/jsonCanonical.js\":\"a3965fe3471d5862\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/kernelInvalidation.js\":\"9a26156fc3738df7\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/kernelProcessors.js\":\"f982388e47bf3193\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/kernelQueries.js\":\"b13f72e9f499d547\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/mergeTypeMembershipProcessor.js\":\"fcbcb9aa802bbec1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/normalizeReferencesProcessor.js\":\"80127b049b6119be\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/poolInstrumentation.js\":\"c3ee6e880885b9fe\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/processorRunner.js\":\"aee5c350ca7ca98b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyCellBackfill.js\":\"137e48604e6b3f08\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyChildMint.js\":\"16ecf2afcec1111e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyChildrenProcessor.js\":\"ae131dcda112d422\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyDefinitionChangeProcessor.js\":\"42df76de6f302201\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyDefinitionSynthesis.js\":\"7c357ef35af750c9\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyKeyScan.js\":\"021e0223c7ee6fb9\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertySchemaResolution.js\":\"2b8ef54c798c1d1a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyValueEdits.js\":\"152fb03e34700cc2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/raiseProtocol.js\":\"27ef54c9e11dc9a5\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/readBatch.js\":\"a4be2f78330232a6\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/refProjection.js\":\"58c7cfd7c2907336\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/referenceTargetLookups.js\":\"73563f4e91c4c511\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/referenceTargetProcessor.js\":\"3e2f19b1cde7eace\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/replayMerge.js\":\"9fe80df2d3b58cc3\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/sqlBinds.js\":\"4ff299787487f6e4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4bdc8d472c5d5f41\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/arrivalProcessors.js\":\"ef8b689192d3b919\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/invalidate.js\":\"81c8a564fabd91b1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/materialize.js\":\"0563f2eaf5383a8a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/observer.js\":\"590efcf23f7e25f4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/reconcile.js\":\"125c72a5161a359e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/timingMetrics.js\":\"ec6016443e414893\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/treeQueries.js\":\"9390c1ca1563657b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/txEngine.js\":\"c4cd589c14f4d97b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/txSnapshots.js\":\"3a5fadc437a57e79\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/typedBlockQuery.js\":\"0ff6b8c1bd0835e4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/undoManager.js\":\"ba6529e016931f4d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/invalidation.js\":\"48caf4f27060c52e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/kernelDataExtension.js\":\"e6edfcd26f966a03\",\"/knowledge-medium/pr-preview/pr-1839/src/data/kernelPage.js\":\"3a2c1c14f3433dbc\",\"/knowledge-medium/pr-preview/pr-1839/src/data/kernelValuePresetCores.js\":\"c763aa6c44890105\",\"/knowledge-medium/pr-preview/pr-1839/src/data/localDbCorruptionSignal.js\":\"7be4ececa09cfd86\",\"/knowledge-medium/pr-preview/pr-1839/src/data/localDbStorage.js\":\"af4e011a9d26ee6a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/localDbVfs.js\":\"fa34ca693b0a425c\",\"/knowledge-medium/pr-preview/pr-1839/src/data/localSchema.js\":\"72d3bba211c7e45c\",\"/knowledge-medium/pr-preview/pr-1839/src/data/maintenance.js\":\"4fc3e16433dfedb4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/mergeProperties.js\":\"e223e3eebc9eda54\",\"/knowledge-medium/pr-preview/pr-1839/src/data/metricsConsoleHook.js\":\"87ea9036c22d8270\",\"/knowledge-medium/pr-preview/pr-1839/src/data/migrationsPage.js\":\"d8f2f8cefc2b7006\",\"/knowledge-medium/pr-preview/pr-1839/src/data/mutators.js\":\"290f7189d5282a92\",\"/knowledge-medium/pr-preview/pr-1839/src/data/orderKey.js\":\"701ffadd18a23fdb\",\"/knowledge-medium/pr-preview/pr-1839/src/data/orderKeyPlacement.js\":\"a1eb652e36f69728\",\"/knowledge-medium/pr-preview/pr-1839/src/data/outlineSurface.js\":\"a7df07c974bef087\",\"/knowledge-medium/pr-preview/pr-1839/src/data/pendingEditorContent.js\":\"59c9e9d8d1cc08a2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/pendingUploadsSql.js\":\"b661f1026bfd4fe2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/pluginStateExtensions.js\":\"55f1033a5982d9d5\",\"/knowledge-medium/pr-preview/pr-1839/src/data/powerSyncLogger.js\":\"67e8c255782fb07b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/projectorRuntime.js\":\"d7448ff13fcf3934\",\"/knowledge-medium/pr-preview/pr-1839/src/data/properties.js\":\"d4945e1aa23781b1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertiesPage.js\":\"3cd12a4e28419b00\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyChildren.js\":\"09448ad349e06b6f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyDefinitionFanout.js\":\"a5e1d7e6067d66d0\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyDefinitionMetadata.js\":\"cdaedf1c1b3b1a8e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyDefinitionRegistry.js\":\"9a3721d5a9c39009\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyDisplayMode.js\":\"6f2861d237872e68\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyRowCreation.js\":\"ca0d11f5ed1c6910\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertySchemaCreation.js\":\"d34bba4947fec286\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertySeeds.js\":\"158d6055867259b7\",\"/knowledge-medium/pr-preview/pr-1839/src/data/recentsPage.js\":\"c2da45092abe9ef9\",\"/knowledge-medium/pr-preview/pr-1839/src/data/referenceBlock.js\":\"fa63a24255fa8dbc\",\"/knowledge-medium/pr-preview/pr-1839/src/data/rejectedUploads.js\":\"b6df68bb7f37395d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/releasePowerSyncConnection.js\":\"d34f1fda586bed54\",\"/knowledge-medium/pr-preview/pr-1839/src/data/repo.js\":\"3963a4a07c1b42a2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/repoProvider.js\":\"2bbdf122a5e0f18a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/rowProperty.js\":\"5ba45a4355b7bfcc\",\"/knowledge-medium/pr-preview/pr-1839/src/data/searchFilter.js\":\"df215f56797bb996\",\"/knowledge-medium/pr-preview/pr-1839/src/data/seedIdentityLedger.js\":\"2f9e64aae2c92b3b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/stateBlocks.js\":\"38d807328c244e00\",\"/knowledge-medium/pr-preview/pr-1839/src/data/structuralEditPolicy.js\":\"e346b4a3f2b37395\",\"/knowledge-medium/pr-preview/pr-1839/src/data/subtreeDelete.js\":\"57515530317ebbc5\",\"/knowledge-medium/pr-preview/pr-1839/src/data/syncStreamLock.js\":\"fc33ac28992047c3\",\"/knowledge-medium/pr-preview/pr-1839/src/data/syncedTableSqlRecognizer.js\":\"5c20127a591310f1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/syncedTableWriteGuard.js\":\"af721a641c114028\",\"/knowledge-medium/pr-preview/pr-1839/src/data/targets.js\":\"3b1e27ac1e9adad7\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeColors.js\":\"2a2918e259f68cba\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeDefinitionMetadata.js\":\"de86908592144181\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeDefinitionRegistry.js\":\"945b8a00c489426a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeExtraction.js\":\"8650f0797972e4eb\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeInitialValues.js\":\"9f6317eeef5a977a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typePropertyGroups.js\":\"4443cf79e99b86f0\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeSeeds.js\":\"7d2fcdd6b90725ce\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeTagger.js\":\"f780193cca80940e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typedRecords.js\":\"d5bd62f11f988a91\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typesPage.js\":\"ad63986fd0b44e01\",\"/knowledge-medium/pr-preview/pr-1839/src/data/userPrefs.js\":\"3ec27233bfc26b9c\",\"/knowledge-medium/pr-preview/pr-1839/src/data/userSchemasService.js\":\"b4a19830ccca66a3\",\"/knowledge-medium/pr-preview/pr-1839/src/data/userTypesService.js\":\"ef3c6472b9498134\",\"/knowledge-medium/pr-preview/pr-1839/src/data/valuePresetRegistry.js\":\"918039c5b4889030\",\"/knowledge-medium/pr-preview/pr-1839/src/data/visibleChildren.js\":\"d4915bb17f9d4fa2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaceConversion.js\":\"4e1fc6f107b7f4ad\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaceFirstSync.js\":\"4f96fcfdd8bb9d45\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaceIdNamespace.js\":\"d607d58b08f8502f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaceSchema.js\":\"659eefae77856481\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaces.js\":\"6087c1a8c761a425\",\"/knowledge-medium/pr-preview/pr-1839/src/data/writeAheadLog.js\":\"a312b60bfc836ac1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/BlockPasteShellDecorator.js\":\"7e76dc64dabb6bad\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/atTrigger.js\":\"2b60ec969e2e20e7\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/autocomplete.js\":\"86fc2a08ea8782f5\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/codeMirrorExtensions.js\":\"66f9fe15b4d0a87f\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/contentFlush.js\":\"b69d2c0ed34ba18b\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/defaultInteractions.js\":\"56de3b612cc126df\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/editSettleSignal.js\":\"97fd26b6699b810b\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/insertImage.js\":\"cfd4e7590025ecce\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/referenceCompletionRange.js\":\"473b97cdaf93cc16\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/referenceTargetTypes.js\":\"4455b21162eeed27\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/syntaxContext.js\":\"8675b398170fc54b\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/triggerMatch.js\":\"62e2156d51164ccc\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/AppRuntimeProvider.js\":\"7f48981b61559143\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/BlockFocusShellDecorator.js\":\"426ef564d3251060\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/ExtensionRenderBoundary.js\":\"df5cfc46b224509d\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/PanelContentRecovery.js\":\"47340e5289b4665c\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/apiCatalog.js\":\"69d467b8db65f233\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/approveExtensionHere.js\":\"9a646bb11e7225bf\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/armedCutAppMount.js\":\"e064a4b0bb949d48\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/batchableKeyedStore.js\":\"cabd6ce0b7048f66\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/blockInteraction.js\":\"bfaeea5637111458\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/blockSelectionAction.js\":\"5878942c403f34fa\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/compileExtensionModule.js\":\"38e8da6259f04d23\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/compiledModuleCache.js\":\"fbebf48f13cffb47\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/continuousGestures.js\":\"f9a358c69063aea7\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/core.js\":\"620d231b8953d6dc\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/defaultRenderers.js\":\"afd679607f65391b\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/definitionFanoutAppMount.js\":\"cf04658d047c52f6\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/dialogAppMount.js\":\"09b00dc45c93e0ea\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/dynamicExtensionSeeds.js\":\"cac87c9445b223ae\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/dynamicExtensions.js\":\"b719ebf3b6e75d45\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/exampleExtensions.js\":\"80e82a5116426643\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionApprovalStatus.js\":\"982e42e8d32d0608\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionLoadErrorToast.js\":\"12e056d7c90f5c08\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionLoadErrors.js\":\"fa86704c32597488\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionLookup.js\":\"3378d26dc0ee305a\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionToggles.js\":\"ec9b68fe8661cfd0\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionUtilitiesCss.js\":\"3f5f669d80e95134\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/kernelPageDeletionGuard.js\":\"41b33d2d8f7c5ddc\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/liveRuntime.js\":\"2d76f5ca6c52b451\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/openExtensionsSettings.js\":\"b8da1dd5f7180166\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/overridesCache.js\":\"8c421ecb954af196\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/pluginIds.js\":\"c35efa634ea3b15c\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/processorRejectionToast.js\":\"f0ae117a960c7874\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/runtimeActions.js\":\"31be9857a4c018b5\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/runtimeContext.js\":\"3f97ab0970cd2053\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/staticAppExtensions.js\":\"9fd2790f45db3302\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/staticDataExtensions.js\":\"5628760a77c78f7c\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/toastAppMount.js\":\"cb737ab69683596e\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/useOverrides.js\":\"7ad3f5a1c17abaed\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/useShortcutSurfaceActivations.js\":\"79251febf7b81ef1\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/discoverToggleTree.js\":\"468c8c1926dc8225\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/facet.js\":\"7e173cdfe83fbcc6\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/resolveAppRuntime.js\":\"76e0a628c6b27c2d\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/runtimeEvents.js\":\"6077987d96ce1cac\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/togglable.js\":\"7057a7dba6cc6f96\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/variantFacet.js\":\"814272b5955d0738\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/verbFacet.js\":\"1e292e6eadae8f96\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/block.js\":\"42c0c40add483540\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/focusedChild.js\":\"ce36351ea8f4cce9\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/propertySchemas.js\":\"3b4820f6b3f5842e\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/typeRegistry.js\":\"49ec238277a6c356\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useAncestorCrumbs.js\":\"385a8f90ae78b867\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useAutocompleteListbox.js\":\"d8b59db1639fe9c1\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useDebouncedSearch.js\":\"cff086d5518a880b\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useDebouncedValue.js\":\"701761de3abb3108\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useIsFocalRender.js\":\"3f82b0e1553393fc\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useIsReadOnly.js\":\"7956b823a8f32c59\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useMaterializeBacklog.js\":\"4e8c0ee562a735c0\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useMinuteClock.js\":\"30fc12d37676b5ae\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/usePanelLayoutProjection.js\":\"f5dd6f9df76e7080\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/usePendingInvitations.js\":\"214788c788830818\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useRendererRegistry.js\":\"b32e6ec76b480918\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useRetainedFieldRows.js\":\"b38f921511c52324\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useWorkspaces.js\":\"ef887c8e038d30e9\",\"/knowledge-medium/pr-preview/pr-1839/src/lib/utils.js\":\"d700fb3b6fc9c0bd\",\"/knowledge-medium/pr-preview/pr-1839/src/main.js\":\"eee39f4ab8293bb8\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/MarkdownImage.js\":\"72adb642bfc87df9\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/blockSeparators.js\":\"cb41dba2a755625c\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/context.js\":\"7afbcfb7676b21d5\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/defaultMarkdownExtension.js\":\"cfd10d79b39cb4ab\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/extensions.js\":\"13ae791d21742729\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/renderMarkdownHtml.js\":\"3e134f1e4964150e\",\"/knowledge-medium/pr-preview/pr-1839/src/minimal-editor.js\":\"cd1b562d848d63e5\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/armedCut.js\":\"7712aec24ee88df5\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/captureMediaVerb.js\":\"79020ca72222d625\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/clipboard.js\":\"914277ad7e4566ef\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/decision.js\":\"3c034c5374f0de01\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/operations.js\":\"554b2376661a1471\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/account-header/AccountHeaderItem.js\":\"df59a0055a9c9ef7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/account-header/index.js\":\"5ab833d688b14ff4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2cf5de7d7a760421\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/askAgent.js\":\"f3e64a8e6429192f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/askedStore.js\":\"9bd249e7e80f6591\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"aefd760b33121c19\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/chipState.js\":\"02f747c016fb7159\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2a8d1025247e5a81\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/index.js\":\"d9ee34b1e057b64d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7b5650c653d83712\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/schema.js\":\"e2fbd5e7f9544814\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7e3dfb8232863b92\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/BridgePairingDialog.js\":\"351cb15e84d891c5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/addMedia.js\":\"0a0ed714e6cd4536\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6234d7869e5b3420\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/block.js\":\"7c4e6eff6f643e52\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/context.js\":\"505c984492c54c8e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b6ac15694feb53a3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/index.js\":\"e462697365a13538\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/outline.js\":\"d1b027086915ae9d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/properties.js\":\"01a535017ae5a4ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/refs.js\":\"ec144d31c1ec7cff\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6702f1d52c9b849e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/search.js\":\"7f2729519295641d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/shared.js\":\"1de0ab54ea2f5d4e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"cfaaa0057dba7136\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/text.js\":\"e078a0d45fe9d411\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentWrites.js\":\"1940e28f4202c139\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/authoringCatalog.js\":\"d0ac222483761a73\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/blockRefTargets.js\":\"955e781ef2825dfa\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/bridge.js\":\"af07b1c381915402\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/bridgeLoop.js\":\"77d9bf69c7686109\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/changeHistory.js\":\"7a3740685554f747\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/commands.js\":\"f0471fce854fd984\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/commentsCommands.js\":\"0dbdeb8e7bf0c00a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/dataExtension.js\":\"4bd345f394fb21c7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/dataModelGuide.js\":\"33c7203d01e3d713\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/describeRuntime.js\":\"ed83bfb98313b501\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/extensionLint.js\":\"df9c4b2d573de428\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/grainAudit.js\":\"a9483635c8602232\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/healthCommand.js\":\"e8ffd605635680a1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/index.js\":\"14cf8d7f89ee7d19\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/presetIdentity.js\":\"bd9e3f4c38bf9b1a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"98de2db2da978b0b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/readMedia.js\":\"a1622ade9a788f6e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/schema.js\":\"0c7481e29b63c011\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/serialization.js\":\"5346e1a3cd410751\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/targets.js\":\"471380ea8ba97dd4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/tokens.js\":\"2a716dbf4e949164\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/watchEvents.js\":\"924010af26e0d28a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/workspaceGuard.js\":\"839f63a027f782c0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/writeCommands.js\":\"7f07f129144ff50e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/AliasCollisionToast.js\":\"566a38b0c3f53285\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/DuplicateNameBanner.js\":\"0fb2e5bca4e43b69\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/collisionMerge.js\":\"641844349afed44d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/dataExtension.js\":\"c304654d2fb54027\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/index.js\":\"01d762771067a77f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/mergeCollisionAction.js\":\"d0ec914e36be348b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/pageStyling.js\":\"ab8d076601d95526\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/rejectionToast.js\":\"93a6416ecb9d0268\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/syncProcessor.js\":\"9c252e04521e0fe3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/actions.js\":\"03adad4d6f467328\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/addComment.js\":\"a5e829becd646ef4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/anchor.js\":\"79ee0331e6a39bd9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/anchorState.js\":\"fd9af6c7dd3952cc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/commentLinks.js\":\"83ae15c5dd176aab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/confirmThreadDeletion.js\":\"937261cfc86c05f5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/container.js\":\"1986348cced4573a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/dataExtension.js\":\"5ba5e4865d8a2bf9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/deleteComment.js\":\"9847cafcf57d8623\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/highlights.js\":\"b063dc3434b2fabc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/index.js\":\"f33b415ac2329921\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/linkedCommentsPill.js\":\"5a3558724fd1b2a9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/margin.js\":\"7542c57ca73365e8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/marginSchema.js\":\"fee1485d75110256\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/newComment.js\":\"acde8de436e707cf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/ownThreadPicker.js\":\"249c345b1855f2ca\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/placement.js\":\"ddf8728a1acd61e2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/queries.js\":\"0232fd00b9ae8c73\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/quotePosition.js\":\"acd5fc89b2faf763\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/quotedIn.js\":\"fc2a11cb55457fa1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/quotedRange.js\":\"0b66f5dfcc6b181a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/rangeRefs.js\":\"7ecc85372442fb58\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/readHighlights.js\":\"636b629641c09d84\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/readSelection.js\":\"202531716129648a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/readSelectionUi.js\":\"c5e21ade634c41b5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/reanchor.js\":\"b38962ca9cf59e62\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/schema.js\":\"447d96cd7f72ae11\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/scope.js\":\"b613f9b0b6ec4d5b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/scopeThreads.js\":\"6f9b73b97ab0a610\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/splitRetarget.js\":\"5f5072a7cc27155a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/suggestionCard.js\":\"6f3bccda7975467b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/suggestions.js\":\"5ad3c0cba46697f4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/summaries.js\":\"25a4151a31d43a51\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/summaryBatch.js\":\"39f782e8da1d6dc4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/surface.js\":\"a6e065b11cc142f9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/threadNavigation.js\":\"ff6351369f564deb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/threads.js\":\"cec33ed502f10e15\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/ui.js\":\"5314fd83f1e03b51\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/uiStore.js\":\"b06eea2b82947688\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/app-intents/appIntents.js\":\"75dc18e870201f6b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/app-intents/index.js\":\"0a3533612377c697\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/app-update-prompt/index.js\":\"1c426aa66c19e433\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/app-update-prompt/status.js\":\"45167cf0989ec7ce\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"64d997093966b34b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/MediaBlockRenderer.js\":\"f2609865aa87406d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/MediaDownLaneReplicator.js\":\"63d6c2733a16de3f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/MediaUploadReconciler.js\":\"c6395766ef8a085d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/assetDownLane.js\":\"f71c87f5afff058c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/assetResolver.js\":\"ca9f52e15b5076f7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/assetUpload.js\":\"90e8afecd49d1b44\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/attachmentCleanerIO.js\":\"20f4defddb432906\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/supabaseAuditIO.js\":\"7c9d5968c11fae9d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/blobStore.js\":\"3727074b6216ba04\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/byteStore.js\":\"6c45a3ea43561df8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/cleanerIO.js\":\"d69c95e1a2295447\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/cleanupAttachments.js\":\"07008d130d76cd56\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/dataExtension.js\":\"bd3552792316d89d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/downLane.js\":\"4aae6729cd87f16d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/index.js\":\"8181474d657ebe3d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/insertImageContribution.js\":\"c7a2205468ed5c10\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/laneArming.js\":\"e430c8c046e55efd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/laneLock.js\":\"207e6e15a8205b44\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/mediaBlock.js\":\"a07a20fe11fdf8ef\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/mediaCapture.js\":\"0c6f88723930d9f3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/mediaViewers.js\":\"299975840a1fba38\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/mediaViewersFacet.js\":\"5df06ce3078fa2f0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/pasteCapture.js\":\"e06360dfc788acdc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/resolver.js\":\"dad99daf0a476cce\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/retryUploadsAction.js\":\"a656a2c9c854becc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/storagePaths.js\":\"1aa616fce437da6d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadDrain.js\":\"114efe27328d3016\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadLaneStatus.js\":\"8ae32db6d32f39d9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadReconcile.js\":\"d624fb48b0f6f10e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadRecovery.js\":\"c298ec6731e57eac\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadStore.js\":\"487dd67530fbc79a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/useAssetObjectUrl.js\":\"5f7213624959941c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b145f733e09fb356\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/BacklinksViewSection.js\":\"73a1f0666fac8f2e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/facet.js\":\"83c5aa5aa2154124\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/index.js\":\"748cb1836e48d103\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/prop.js\":\"4e91d37bd4825156\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/BacklinkFilters.js\":\"0c1845c56c4780b2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"dc919547938714a2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/BlockEntry.js\":\"2745c18fd7e8a102\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/LinkedReferences.js\":\"732b91b0614557ee\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8e844290382210fd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/dailyNoteDefaults.js\":\"af12fe26b383570f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/dataExtension.js\":\"17a5589e167a99c0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/edgeExclusions.js\":\"21ba48b33cc13d79\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/filterProperty.js\":\"78feaf1866422f24\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/index.js\":\"ab09d9ca229f8b93\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"fb06bacfc423c237\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/applies.js\":\"c443ca0fc19f6a86\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/countQuery.js\":\"2d0a3abe84fe2112\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/expansionStore.js\":\"755d01818237c80b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/index.js\":\"5b80b8a2013ef863\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1d4eee3f07038d49\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/presentationInvalidation.js\":\"7e2d41f8f0b7875c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/propertyEditorOverride.js\":\"a687bc69f2fb1295\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/propertyFilter.js\":\"8442eeac292b0249\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/query.js\":\"d741b055f232308e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/resolveFilter.js\":\"6f9b7eb98a31a03d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/sourceBatch.js\":\"85beac6ef12ef586\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/sources.js\":\"871e94912918e09a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/useBacklinks.js\":\"88f209a1217c068c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"69e253c08120a3d5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/BirthdayCelebration.js\":\"c2d660bb34a9ef4b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/BirthdayOverlay.js\":\"8690f692078eccdd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/gate.js\":\"8b62d6b0cc9d97da\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/index.js\":\"3babbc5af13c6b7e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/wolfTheme.js\":\"8ea2a57cde0656e0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/BlockDragLayer.js\":\"e4876aa253dc98d2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/dragController.js\":\"b448d276e1d71436\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/dropTarget.js\":\"5bd432a9f2052d12\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/index.js\":\"59c1b1a3615389e2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/projection.js\":\"8cc1d5c119b9d5f8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-info/BlockMetaCard.js\":\"065fa8fcf9cb60cc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-info/index.js\":\"58ecd355eaf2818d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/AddTagDialog.js\":\"c41c05ab8c95153d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a43fc085f49be7ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/TagNameIssueHint.js\":\"3873aa3f4bca45be\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/addTagAction.js\":\"b41cea3879d7987a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/appendTag.js\":\"31f6af88cf35d4e7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/config.js\":\"4740c5697bc809ec\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/dataExtension.js\":\"f402649fb55b2126\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/index.js\":\"f3ebc5d0b7103a87\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/propertyEditorOverride.js\":\"2e4d1975831a46e9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6407045c2bcaae35\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5b51e43bd088614d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/Breadcrumbs.js\":\"aafc824d64a4d81d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"86aabf6dda429bc6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7ccc9757e4c3a409\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/index.js\":\"3ca5bcee30534b65\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bfd273b0da084908\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/CharacterCountItem.js\":\"297e71fd649db432\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f593ad72898997b9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/actions.js\":\"f3b1ef62610930f3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/blockType.js\":\"415135c715862e78\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/charCount.js\":\"7cc5e961ad9a40f6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/dataExtension.js\":\"2a45d480a794a275\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/index.js\":\"55bb0e3594ed30a4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/profiles.js\":\"0cfe93e7091e0a40\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/properties.js\":\"939c986fe5a89141\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/textCounts.js\":\"260e46731cdb9c87\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/colemak-keybindings/index.js\":\"3a697ac53a8234a8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/CommandPalette.js\":\"b271a700fe708797\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/HeaderItem.js\":\"6b20036e7443441e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/context.js\":\"27c52f5100b7350e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/index.js\":\"af31cf31fe5e9a7b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/selection.js\":\"0bfb15e02822f655\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/toggleStore.js\":\"c714d8648e639060\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/useCommandPaletteActions.js\":\"ff1d4f82aa722a68\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/ContributorBadges.js\":\"70e9c37c35288d56\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/author.js\":\"d6143be11d82835e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/codeMirrorExtensions.js\":\"446e8b0e2a28d4d0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/dataExtension.js\":\"d24ca96856cbde21\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/index.js\":\"cd126b9abdaf4b72\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/mentionAutocomplete.js\":\"b3d33264ffd047a8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/processor.js\":\"99512e1c61bd6ece\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/profiles.js\":\"3e63e061c5673936\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/queries.js\":\"c0e13465086d7061\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/schema.js\":\"a753234b9587c27e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e7278d4b2480a8db\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/followOrigin.js\":\"33c0e08ecca48db9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/index.js\":\"ba0e18bae2df5f94\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a75951607a50d76f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4d7f6429cad0ea25\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/CalendarGrid.js\":\"5df7e87d7121f943\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/DailyNotePicker.js\":\"cf9350b131e428ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9942d14ada7ce042\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/DateNavDecorator.js\":\"9d0da7b3dadd6eed\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/DateScrubOverlay.js\":\"353aca6f5b38f9eb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/HeaderItem.js\":\"98efe7923fe58836\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/ReschedulePicker.js\":\"f74f3da0269b4662\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/SpreadDatesDialog.js\":\"01455a752c1658c1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/actions.js\":\"95bdc58d5994f2fe\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/blockDateAdapter.js\":\"e41a0068574597fa\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/calendar.js\":\"783cd66419f5fef6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dailyNotes.js\":\"235cc5c9cd8c44f2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dataExtension.js\":\"4be36b2a2ae55546\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dateScrubActions.js\":\"abaf26d886b8231e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dateScrubGesture.js\":\"aa6573ff8660a484\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5779f27eacabb3f5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a95e893969be5936\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/deletionGuard.js\":\"bd7f6781037b87cb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dueQuery.js\":\"ed31d115497ca0ac\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/index.js\":\"5991cbe0222bab28\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/landing.js\":\"a810a2f4942b6752\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/localSchema.js\":\"c1d07958d7e1aae3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/referenceDateAdapter.js\":\"5aacdb6a15fe0e53\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/rescheduleAction.js\":\"90b9f6424952a34f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/schema.js\":\"b345f63a1328e81b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/spreadBlockDates.js\":\"4b79d6e424feee48\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/spreadDatesAction.js\":\"1ea425acca5ec7d4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/today.js\":\"bc15c17c0a760b2e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a719839c302d4fa8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5b883625b8f88fef\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/audit.js\":\"460fa4c18c285912\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/auditAction.js\":\"010208b60c245586\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/auditRanges.js\":\"7c8365814a694a63\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/diagnosticsSource.js\":\"3caedb57674a2ea7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/divergenceScan.js\":\"a79f8a07dacb747e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/index.js\":\"496c1e9da02bd427\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b5bca4791348b04c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/referencesMirror.js\":\"9b8905139d574503\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/rowJson.js\":\"83840e7dd88b8a99\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/schedule.js\":\"a3779e57ba5d8e5f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/store.js\":\"ad652d5a6c2e136b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-maintenance/action.js\":\"7ac547ec2b65bea9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-maintenance/index.js\":\"2c6a2b2173a1591a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-maintenance/plugin.js\":\"82b5927d021784d1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ceee41b25f75a6ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/actions.js\":\"9196d106dbc36664\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/changeMarker.js\":\"8fdd1b4ec75b5b5e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/diagnostics.js\":\"064d10f24c494f4c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/fileSystemAccess.js\":\"578070352211b47e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/filenames.js\":\"e7107473da64570f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/index.js\":\"9d0b677f77340b08\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/mirror.js\":\"abd7f875c19535da\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/runLock.js\":\"07dccaa54e0ead90\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/runtimeHealth.js\":\"5f4cc2a617236492\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/schedule.js\":\"39dd4f4e07dc7b2e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/store.js\":\"75a1b102329c96ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/default-themes/index.js\":\"00b573831dc3f31d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/default-themes/themes.js\":\"d69c5005fc2a458b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/diagnostics/facet.js\":\"f6b34953a3684935\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/diagnostics/useDiagnostics.js\":\"6fcc6ac36ecc9396\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extension-prompts/dismissals.js\":\"60ec8d88f7e6b9e0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extension-prompts/index.js\":\"8540a12cedf37ab5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extension-prompts/status.js\":\"803e7a34cd70e85d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extension-prompts/store.js\":\"1dbf1bf4c0d726bd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c62b1ee4ec0ba761\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f39fe1f645e3ae71\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/actions.js\":\"9758910bd504c036\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/config.js\":\"954c522d26361fe3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/dataExtension.js\":\"8cefa57f871e9c30\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/effect.js\":\"547bcc2b79280e8d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/index.js\":\"c1056bde035a448a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5d560b10838d544a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/useToggleTree.js\":\"6e5de9a18085adad\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/ExtractTypeDialog.js\":\"58c5dd061a58ad17\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"81d51fece0f6e07a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/PropertyShapePicker.js\":\"e08b4552af9ece33\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/action.js\":\"180bca47219f9dfa\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/index.js\":\"e09d61e35d5f607f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/FindReplaceDialog.js\":\"c864cf9755959401\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/HeaderItem.js\":\"d2759cfd1e56e994\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/dataExtension.js\":\"c9f7977f941bdadc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/index.js\":\"8f209168515b6003\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/search.js\":\"ee1cdfd6b064b90b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/toggleStore.js\":\"3055dcf57200d8d6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/LocationPropertyEditor.js\":\"c24e9dffdb36ff3c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/MapView.js\":\"440903f80f711f63\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/blockTypes.js\":\"3498513846e57c7a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/codeMirrorExtensions.js\":\"8b55f0b9667c3507\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/createOrFindPlace.js\":\"5f3e83116df04dc1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/currentLocation.js\":\"ad5fb6c1b98f352c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/dataExtension.js\":\"33eeb735f7914344\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/geoContentDecorator.js\":\"f356f47ca74c44ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/googlePlacesClient.js\":\"c261f8ca2d6ac9ad\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/index.js\":\"f36fb967627db296\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/locationsPage.js\":\"1fe8aae4df654c46\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/mapViewport.js\":\"ea7e6ae6e57c5c01\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/pickCurrentLocation.js\":\"d66cff5807b7d3a0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/placeAutocomplete.js\":\"4672a46f5d1fa3e2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/placeNameCollision.js\":\"ca3eeb8cc35b5b1d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/properties.js\":\"4dc29239954874f1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/propertyEditorOverrides.js\":\"9c78fea06ec1b760\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/query.js\":\"037c573268f4dfa4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/usePlaceSearch.js\":\"c3300287a81dabc4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d29aab00a2a75f7c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"406fbbd7f0a15fc0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e278e056729d502a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/config.js\":\"c706f15626e6296d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/dataExtension.js\":\"0280152d17d824c4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/facet.js\":\"d204847d0c78701b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/grouping.js\":\"18ef0337f272b646\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/index.js\":\"78734353b0c3c5fc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5b57643fcd2093fc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/query.js\":\"de55200a13ad0ed6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/resolveConfig.js\":\"f0583e0805211ebe\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"83b731edc99aa6fb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"97bff8b3c03076ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/HtmlDocumentContent.js\":\"294fdeb07c84b9bc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/HtmlFrame.js\":\"34db7d2804657b3d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/actions.js\":\"7b65f582f51fde0b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/blockType.js\":\"516c9e4d64219e63\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/confirmRunScripts.js\":\"8432534fbc8eeabe\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/dataExtension.js\":\"9d8c2ab723433691\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/frameAnnotations.js\":\"087c8a15b442f6bf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/frameDocument.js\":\"21a9a2ff11bc9fe5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/frameTheme.js\":\"242c1580090a614d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/index.js\":\"32f4e60346c2faf8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/scriptConsent.js\":\"dcaffa51b54ddec8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/sourceMap.js\":\"a5a47a3e6f35dfaf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/useDocumentScripts.js\":\"51c75096e528c810\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/index.js\":\"c207dbcb4f6b0bd7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/record.js\":\"a71da793901f9fba\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/recordStore.js\":\"e2070c845a59a4e9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/responsiveness.js\":\"ce5e62663bf2ebd2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/schedule.js\":\"b43c4603ac5ad252\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/sessionContext.js\":\"25c36472368736e9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0bf043fe0d294c9d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b19265740dac26ac\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/actions.js\":\"c1c816a805ea0df6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/config.js\":\"f98e84b9e765a565\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/dataExtension.js\":\"0c2b5f5ea069594b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/effect.js\":\"31b8d9a9c9b37677\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/index.js\":\"9196af49d99acaac\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/keyCapture.js\":\"69055275bfff38ef\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/overrideStore.js\":\"890fc0326e17a686\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"375fea29816d92ad\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/HeaderItem.js\":\"ca0e35ad536bc4d4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/LeftSidebar.js\":\"d5c4a3b23a4c903f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/actions.js\":\"f54cb714793bde5a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/facet.js\":\"1a8d6b2081577917\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/index.js\":\"87775c54430cdac4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/shortcuts.js\":\"c5264df0c76451eb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/toggleStore.js\":\"b104084b5fc606a8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/merge-blocks/MergePicker.js\":\"1d635bfc6ffb6b3e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/merge-blocks/index.js\":\"5e89df90c5ec3aeb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/merge-blocks/mergeAction.js\":\"f6a38c7c65abb440\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/merge-blocks/strategy.js\":\"e4f58987df3f36af\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/Button.js\":\"d404570b9a0e5077\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"107348ee4384add4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/defaultItems.js\":\"df2fb004209583f1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/facet.js\":\"9089cf45a4d09a90\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/index.js\":\"1ab306b7638769ce\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"640771d505adc2b8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/actions.js\":\"07e619627499d786\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"89f45761ef52995c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/facet.js\":\"cbf87489caf58599\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/index.js\":\"c5da8249b5353de9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f869126ff91e02df\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/blockSubtreeMembership.js\":\"de3aa7814b183d2d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/contextMenuItem.js\":\"9b1db9262704cf25\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/index.js\":\"17fc7b5863d20722\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/moveAction.js\":\"9c432f53ae429069\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/moveBlocks.js\":\"5b55ea2c5c434379\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/selectionAfterMove.js\":\"2771ceee3c834202\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/TutorialBanner.js\":\"cdc8f71757720e95\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/action.js\":\"dfcc7ed9132c9a92\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/bannerDismissal.js\":\"8a90a78758ba8b8e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/documents/cheatSheet.js\":\"95b71cb1dc563b65\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/index.js\":\"337c66a2adaaac5c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/keys.js\":\"9804f5f2c6444e18\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/landing.js\":\"80acf1c54c4b7edc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/outline.js\":\"d9cbebdd5f40b980\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/seed.js\":\"31e7afa74773f534\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e345d15950917869\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/analyze.js\":\"9bc8a2d855f85265\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/diagnosticsSource.js\":\"8cb706e91b134c38\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/index.js\":\"b1768f1f7c8a985b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/load.js\":\"7fc654786dc89725\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/monitorRun.js\":\"7a693b69a92059ff\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/schedule.js\":\"1ce16ba4c04bdf66\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/series.js\":\"b5c5f4e1bc638f55\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/store.js\":\"aeaa870a4e0f3c5d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/trendAction.js\":\"f785cfddb7dcd6f1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/verdict.js\":\"80dc4eea97d4058a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/plain-outliner/clickToEditAction.js\":\"e25f4fcd0b8ec63f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/plain-outliner/index.js\":\"5be4638373b1f862\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/plain-outliner/interactions.js\":\"3b06182fb6946cc1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c86155196f71dacb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/MigrationGate.js\":\"c7a2400460c2701f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/MigrationGateDialog.js\":\"2744d64dfbcd99a7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/action.js\":\"faa5680b9d631a0c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/index.js\":\"6ebc8ecf1cebcb6e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/localRunMessage.js\":\"5036697e7b408b19\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/plugin.js\":\"e8e2f74212086ca7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/progressReport.js\":\"12fc7824d89f3587\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/sweepProgress.js\":\"251fb69d8c916181\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/FieldRowRenderer.js\":\"3e7c2b4bec1e4d70\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/ValueRowRenderer.js\":\"7a408f212d6b5d32\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/actions.js\":\"6091ab1da5215199\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/autocomplete.js\":\"1081abb712fca6b9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/fieldRow.js\":\"67794a899c3ce08e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/index.js\":\"69ed63fd94463ec6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/referenceWarning.js\":\"f5449ac1a7cccfb5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/valueAutocomplete.js\":\"53121fe00b04a68b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/valueSchema.js\":\"47c9373cd46dac34\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/HeaderItem.js\":\"5f6fd269af792392\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/QuickFind.js\":\"c609f2bee64c0ad8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/index.js\":\"6bd4a8ffa7ae177a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/recents.js\":\"bf6ba6148affade2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/resultItems.js\":\"7e32368a375bdf30\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/selection.js\":\"811915ece923f31a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/toggleStore.js\":\"919c1d67943f3b25\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/HeaderItem.js\":\"265e2089595aa853\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7c5f283f00b343d6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/grouping.js\":\"ab0cab260b3e8c08\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/index.js\":\"6b0ac35a86cab8b7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/target.js\":\"e907e6e65a536647\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/codeMirrorExtensions.js\":\"0ef1ee1a52f57eb8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/contentPrefill.js\":\"b8df1fb5c2cd1de9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/dataExtension.js\":\"2d1347011bf6dc71\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/index.js\":\"10c9e2c4e910e6b9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"509ce5feb85cf1ee\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/invalidation.js\":\"9d944e5f43e65005\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/localSchema.js\":\"2f6d23b570fef34c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/blockrefs/index.js\":\"31d104de5401bb03\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5c561e2d79c2193d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/index.js\":\"2e3d22fba2508dbb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/referenceNode.js\":\"bae8d5d93ee085ff\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/remark-reference-occurrences.js\":\"af88fbe314165201\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d37e4a6bcaf2f884\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/wikilinks/index.js\":\"f28ac5d77d787acb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4cf98178a96eb70f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fb95b61737ccd04f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/mergeRetargetProcessor.js\":\"c9da9f8b615aadda\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/parseFence.js\":\"d27f7b7cb669f11d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/referenceParser.js\":\"0fb9b447db935985\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/referenceProjection.js\":\"d6ab575819dc4922\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/referencesProcessor.js\":\"5c4530dd61fd102d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/renameProcessor.js\":\"d7a082e437ad9b56\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/spanReplacement.js\":\"7435454b4712ea9a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/rich-paste/htmlToOutline.js\":\"8116634f23862d73\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/rich-paste/index.js\":\"56c8c179c583c9d3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/rich-paste/normalizeClipboardDom.js\":\"432cb63d65012ea0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/rich-paste/pasteDecision.js\":\"271f6baa4e8f7b07\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/action.js\":\"51c53e0c870ade51\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/blockIds.js\":\"a4e43935806946e9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/content.js\":\"ba6c612e7897c861\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/effect.js\":\"96be85b2adeea817\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/ids.js\":\"293a4401bf804ef3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/import.js\":\"fb4c68d92077109e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/index.js\":\"5c29b8255b53e163\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/plan.js\":\"2b450f31e3769efa\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/plugin.js\":\"578d99be161f2799\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/promotion.js\":\"ac32b6decc419680\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/properties.js\":\"2b763157cee10a20\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/references.js\":\"433467fcd7e8ffc4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/report.js\":\"7363f62344db4912\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/roamMemo.js\":\"3b524dd8764673c8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/runtime.js\":\"198eb682c8464866\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/schemaReconciliation.js\":\"48c4b207c8d29eec\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/srsMarkers.js\":\"5735e2ed41b53c7a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/todo.js\":\"fe16fde53f43ce47\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/typeCandidates.js\":\"c49bb314830372e7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/types.js\":\"578760e430dbcce9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/search-health/index.js\":\"b1c1719c51899cf7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/search-health/store.js\":\"c812398406c9b8a1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/HeaderItem.js\":\"5ddfbdd75af9f000\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7d98300174d655af\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/index.js\":\"f79324cc1dc3511a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/model.js\":\"d69ff32404188ea5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/toggleStore.js\":\"44947c866ce7aa07\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/useKeyInspector.js\":\"8675263175d14961\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"82dac17f196d79a2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/ShellDecorator.js\":\"99a6510db87f022b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/actions.js\":\"40c4df6b261e4d84\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/exclusionsFacet.js\":\"adb5a606c480e168\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/index.js\":\"a71afc890e0f82ba\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/shell.js\":\"00a9c9984ba5b1ce\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/surface.js\":\"38961414707d43d6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/walker.js\":\"4d8cf01202075658\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/RescheduleToast.js\":\"bc31dd1f8a9804c6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/dataExtension.js\":\"8a3191d6413b8a80\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/index.js\":\"c07ef00192249a1a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/indicator.js\":\"4d4c7860ad560478\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/moveSrsState.js\":\"4e2fc9df5112a4bf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"03094b46bc968370\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/scheduler.js\":\"927a9ab8b2e1bf30\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/schema.js\":\"2ed4f3f49e2d1e70\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"5426b7f30450323c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/srsClipboard.js\":\"268f28e01225310e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"94aac4120f0c918c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e6f9aa4760e4ac80\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/DeckPicker.js\":\"9e4a1811b7ad544a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/ReviewControls.js\":\"4d95b4688d2ad65a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/ReviewDeckRenderer.js\":\"057af9ba3c38ce42\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/ReviewSession.js\":\"1a5519faedc27710\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/actions.js\":\"9ed04f982704299c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/archive.js\":\"2ae1909f92099c9c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/dataExtension.js\":\"ea902fddff97203f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/deck.js\":\"6013bea2b9eb2636\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/dueQuery.js\":\"4c9057bcf7cb3757\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/gradeDecision.js\":\"380b523ea2b7a1c8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/index.js\":\"bc676e2c2bd8ca0b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/keyHints.js\":\"c1fffadadc7ed565\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/reviewCardLayout.js\":\"590a9e3a7af33452\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/reviewProgress.js\":\"95aa11d6a1ae46d6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/schema.js\":\"72a21d8bb2b78b47\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/useDueCards.js\":\"1eb32bae01ec4244\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/startup-metrics/index.js\":\"d76effe017f8aacf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/startup-metrics/record.js\":\"5074f57e4a35a65e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/storage-persistence/index.js\":\"25be2fd2b610a682\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/storage-persistence/persistenceStatus.js\":\"d006a422648eced6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/storage-persistence/requestAction.js\":\"2ccdd0ac9aa602b6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/supertags/TypeChipsDecorator.js\":\"db274068b15ebb1a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/supertags/codeMirrorExtensions.js\":\"bcee4a3de21ab60d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/supertags/index.js\":\"b9c7336fe9e40a10\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/supertags/typeAutocomplete.js\":\"b1adbf560af75e15\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ccaced2badf74733\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/actions.js\":\"2de111ef42ffccff\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/anchor.js\":\"08a8479ebb323f90\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/events.js\":\"120a9ec0b2d888e1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/gestureActions.js\":\"3eba2573607b9fd6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/index.js\":\"895c91d2936d46a7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"088e760875167f7b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/sync-metrics/collect.js\":\"4a17232c353d64f7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/sync-metrics/index.js\":\"4c309de1c4fb7a7a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/sync-metrics/record.js\":\"95d7141f66aeeedd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/RejectionDialog.js\":\"ab21f87aadcb2fd2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/SystemStatusHeaderItem.js\":\"80e0969c0c89e5f4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/index.js\":\"0a503e5f274415f5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/model.js\":\"c8be66af4d80ad5e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/queueCounts.js\":\"671e517036914d2c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/rejectedHelpers.js\":\"fe216acc29c7f57c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/rematerializeAction.js\":\"9d6dfcb9754e4f02\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/useHysteresis.js\":\"302f0d3a77e598ed\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/ColumnHeaders.js\":\"2e9ed4c5c05f3bf1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/QueryUi.js\":\"bc8b5af78350754b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/TableLayout.js\":\"6f792cb9cd19e3f5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/actions.js\":\"207dd5e60fc51125\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/cellEdits.js\":\"ebdb64928afba154\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/columns.js\":\"d286ad30ddd8424a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/controller.js\":\"52c1e8546d59a0a1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/convert.js\":\"231282f23ff48120\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/dataExtension.js\":\"90fa7f00f7b930ad\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/index.js\":\"d762aa8afe476cef\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/keys.js\":\"5deb624af1acff43\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/model.js\":\"cefe03b09f3e8c4b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/backfill.js\":\"c37a40bac5a2debd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/format.js\":\"908ae4a9aafad8c9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/parse.js\":\"b1991ef29f21b80b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/queryValue.js\":\"cece386118ac1ff6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/source.js\":\"7c35ccf5465ee96b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/registry.js\":\"74fd2717616e463f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/schema.js\":\"66d32a4a9eec415c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/sort.js\":\"e9bc99a9f40826ac\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/theme-toggle/effect.js\":\"4be2fa3e139148ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/theme-toggle/index.js\":\"f6e34040a4af16e1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/theme-toggle/theme.js\":\"a9fdd9395eabdd08\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/todo/actions.js\":\"e2addf736f8716ba\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/todo/dataExtension.js\":\"8f2b87221d840462\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/todo/index.js\":\"0a1a4ffd0510a6c7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/todo/schema.js\":\"c004f33d71ab7d0c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/TouchSelectionLayer.js\":\"843ac2d76c3e93b3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/actions.js\":\"147053022b0c46cc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/defaultItems.js\":\"5bd4fa08d3493fda\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/facet.js\":\"27d88e6b1a60e3f0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/holdRecognizer.js\":\"c4c0eb6fe616ecb1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/index.js\":\"0a577f42c03258a5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/update-indicator/UpdateIndicator.js\":\"3d1cb02ba0d1c8e0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/update-indicator/index.js\":\"f941ae0f4898c47d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/update-indicator/loadTimes.js\":\"1ae0d74f5650e53a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/VideoNotesRenderer.js\":\"1f1e2ee9607ac4a2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/VideoPlayerRenderer.js\":\"e8f7d2cc18194e0b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/VideoTimeStamp.js\":\"8f681a2953389490\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/actions.js\":\"c2faad3c6c8af907\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/index.js\":\"9e5bf9dcbda6e44d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/markdown.js\":\"ccf58e03b800915a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/notes.js\":\"64c2bd0e8319eede\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/registry.js\":\"6aeac87b2459fe34\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/remark-timestamps.js\":\"f3b48edb1f76f776\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/view.js\":\"d779dd213fe28fb0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-link-hints/LinkHints.js\":\"3054e5a97f2b1d57\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-link-hints/index.js\":\"11816399ff1935db\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-link-hints/model.js\":\"148bea6120225158\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-link-hints/settings.js\":\"889ec300d6a960af\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-normal-mode/actions.js\":\"ff74809bd80547ad\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-normal-mode/index.js\":\"ae24025d296cb904\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-normal-mode/interactions.js\":\"6950e070b3b4a57b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/workspace-header/index.js\":\"cc70d01893e97a1f\",\"/knowledge-medium/pr-preview/pr-1839/src/registerServiceWorker.js\":\"76eefc37c303784d\",\"/knowledge-medium/pr-preview/pr-1839/src/requestPersistentStorage.js\":\"e20c314fe9a67bc6\",\"/knowledge-medium/pr-preview/pr-1839/src/services/authRequestDeadline.js\":\"bff4bebce33f204f\",\"/knowledge-medium/pr-preview/pr-1839/src/services/authStorage.js\":\"4cfb9921bbb871cf\",\"/knowledge-medium/pr-preview/pr-1839/src/services/powersync.js\":\"e532418d1e5edaa0\",\"/knowledge-medium/pr-preview/pr-1839/src/services/supabase.js\":\"3471229887dddafe\",\"/knowledge-medium/pr-preview/pr-1839/src/services/uploadErrorClassifier.js\":\"3f77329721c118b5\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/ActiveContexts.js\":\"604fcc1fd94f0958\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/HotkeyReconciler.js\":\"67f783b7b7837baf\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/WipeLocalDataDialog.js\":\"c78e7cd7dab13ac5\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/actionDispatch.js\":\"8b139974d149e94f\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/actionRefItems.js\":\"c0a9d71d8366bc70\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/applyKeybindingOverrides.js\":\"d25d5e0898bd5363\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/blockActions.js\":\"9f7ff16cbcaac125\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/canonicalizeChord.js\":\"562477411c739789\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/defaultContexts.js\":\"8a08e8ef6c5cf1dc\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/defaultShortcuts.js\":\"75f69b2e0e008d25\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/effectiveActions.js\":\"51063f136dde5e0d\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/gestureAction.js\":\"fc86bcf451f0838c\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/gestureBinding.js\":\"ef84d5a41f50ffc2\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/holdRegistry.js\":\"c0ad2a56bf988b06\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/keybindingConflicts.js\":\"3df0cc687ad5cca3\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/keybindingOverrides.js\":\"32f2e1d6fe2c4984\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/pointerAction.js\":\"66d9ab5e22bf17c5\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/resolve.js\":\"9a6d24ee602a77b8\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/runAction.js\":\"02875fb6e6151a52\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/sequenceMatcher.js\":\"717c27afb587a770\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/types.js\":\"84f1e1c9acdb158a\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/useActionContext.js\":\"81b45753e3abac14\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/useActionDiscovery.js\":\"44ae6a8e8957f16d\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/utils.js\":\"9f46815acb277344\",\"/knowledge-medium/pr-preview/pr-1839/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1839/src/sw/bootStore.js\":\"2a9ffd86a21a379a\",\"/knowledge-medium/pr-preview/pr-1839/src/sw/previewDatabases.js\":\"2cc9fd402ff512c6\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/byteTransform.js\":\"b39b0fb21ca7a050\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/attachmentCleaner.js\":\"eaabd3cc1d5fbd7a\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/attachmentParts.js\":\"a901e9a34e2836fe\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/bundleParts.js\":\"fd95451801162bab\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/bundleRecord.js\":\"1b5e8fdaa067ead7\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/manifest.js\":\"c9dd8680c8d1d1c5\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/takeBundle.js\":\"45ea5623cc43850d\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/verifyBundle.js\":\"96df43dcdc51f3d1\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/cleaningStage.js\":\"afead2763f06ee21\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/conversionKey.js\":\"c078f0d46d4e5d31\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/conversionServer.js\":\"2e2a0d03ab2e99fa\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/flip.js\":\"3e9128fc09cff256\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/flipAttempts.js\":\"1cc2a6331e8c8c1c\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/pages.js\":\"19a3e2643aca24a2\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/preflight.js\":\"74913a450ce33516\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/reseal.js\":\"f2498df1b369dcad\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/runConversion.js\":\"7f589827bbbafba9\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/runLock.js\":\"825ced645e91fc90\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/sealing.js\":\"289c3400b1cb86fd\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/sealingStage.js\":\"880ce5e45d554d9f\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/stage.js\":\"3a5cfb669e6e492c\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/verifyReseal.js\":\"65161374a435d740\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/aad.js\":\"69ee09c13818a4f4\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/aead.js\":\"827065eeb50ab72d\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/base32.js\":\"746996024bb71196\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/base64url.js\":\"f413f81d6474f744\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/binaryEnvelope.js\":\"587ca02f0f449009\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/byteAead.js\":\"e845907b4111e276\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/canary.js\":\"cfb58c6914738d20\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/contentHash.js\":\"e6dbf818cf506dc5\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/contentKey.js\":\"4f8b9f75adc055ab\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/derivedIdNamespace.js\":\"5fb69af5e2e13a6f\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/envelope.js\":\"903a2d84fe89ab53\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/hex.js\":\"aab6141689d18d20\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/sha256Hex.js\":\"22ecece972d82d32\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/workspaceKey.js\":\"7ada07ff4ead2f10\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/conversionState.js\":\"fea81488d2b54cef\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/flows/createEncryptedWorkspace.js\":\"cc29791718e67cb9\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/flows/pastedKey.js\":\"bfbedb9a37b72fcb\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6e93904c72ba1939\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/flows/upgradeWorkspacePin.js\":\"cbe55bb14e692d65\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/keyStore.js\":\"ec7f988f67264ebc\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/mintWorkspaceKey.js\":\"67c348e1a64adb2f\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/modePin.js\":\"aaf37cde76860cd9\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/openWorkspaceKeys.js\":\"ebfd13126e06b820\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/resolveWorkspaceEntry.js\":\"b41ac08602f928e5\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/resolver.js\":\"882fee9f1c7292d1\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/workspaceAccess.js\":\"6e17602473b672b6\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/transform.js\":\"f02b2a00b80aee80\",\"/knowledge-medium/pr-preview/pr-1839/src/themeBootDefaults.js\":\"d6aa0cbeced4f9a1\",\"/knowledge-medium/pr-preview/pr-1839/src/types.js\":\"79456dd389da2344\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/ClientLocalSettings.js\":\"48c970b28c45c14d\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/abortableSleep.js\":\"360a5a7cad384a35\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/array.js\":\"bc2af70bd704e19c\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/backlinkAutocomplete.js\":\"74b5b2dedf64f5eb\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/blockCrumbs.js\":\"90bd06484b2b8da0\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/blockrefAutocomplete.js\":\"c86a1ab7543d81a0\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/cadencedIdleJob.js\":\"81fcacfbc25c760b\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/callbackSet.js\":\"117567862c6822e1\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/clientId.js\":\"918352c663425b7a\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/codemirror.js\":\"bf0bd049a64dff3e\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/codemirrorCompletion.js\":\"f62b51e1cc94d1e6\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/copy.js\":\"1f184868e55fafa0\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dailyPage.js\":\"7a48f01837316254\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dbForensics.js\":\"47f988a4949f0607\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dbForensicsHooks.js\":\"12492c337d9cf583\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/deleteBlockThroughUi.js\":\"18debb22c4758b3a\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dialogs.js\":\"d834e37345301f0d\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dom.js\":\"9bc6b90270bf7f76\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/downloadBlob.js\":\"e7f4034898be6729\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/exportSqliteDb.js\":\"e790414a092ffef0\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/fileSystemAccess.js\":\"3d701a770eb2cf02\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/flipSlide.js\":\"6a4e282e3de0f317\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/fnv1a.js\":\"20cbb407e96a06d1\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/formatBytes.js\":\"0f1c47a474f0ae74\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/fuzzyRank.js\":\"8de5561cbed621f0\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/idbKeyedStore.js\":\"b2cde23400229b77\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/idleCallbackPolyfill.js\":\"3c77c0fc0d210dcf\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/keyboardAwareScroll.js\":\"16042906ac4e53a6\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/keyboardViewport.js\":\"965f8c32781cafdc\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/lastWorkspace.js\":\"7a78e8a7e41c2c12\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/layoutColumns.js\":\"a6af344c083c5508\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/layoutSessionDom.js\":\"7d6fe5fcb1c285da\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/layoutSessionId.js\":\"e8580f126d3fdc8e\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/linkClickGestures.js\":\"f91c0cf66ff9e64a\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/linkTargetAutocomplete.js\":\"53b725751fa7fce8\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/localDbCorruption.js\":\"8f5a61ec4ed7c8b7\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/localDbRecovery.js\":\"8a900c02fa374e28\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/markdownParser.js\":\"3cbd131fe2af6de2\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/memoize.js\":\"24514f5b36e07bb1\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/nameFieldCommit.js\":\"6d01a707e0e46a27\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/nameList.js\":\"10ec8e4c5ec04406\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/navigation.js\":\"729b46aad6fa8533\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/omnilinerNamespace.js\":\"3310e3d18ac359d0\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/opfsPageScan.js\":\"403881418c4c902e\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelClearance.js\":\"f1bbf947164e6625\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelHistory.js\":\"f021f678c852c3e1\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelLanes.js\":\"0e5a49dcd913740f\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelLayoutProjection.js\":\"2249f6fecad741ea\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelScrollAnchor.js\":\"3214026498206c9a\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelUrlFlags.js\":\"bc99ed0c14b38efb\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/platform.js\":\"a735e2ea2ccdc485\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/pluralize.js\":\"ab7db4307eab2e9c\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/propertyCreation.js\":\"0f18a975bd61725a\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/propertyNavigation.js\":\"d5ef8d6f53a21ebd\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/propertyValueContext.js\":\"924126f5946bf5bc\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/react.js\":\"05e8df6f67596a90\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/relativeDate.js\":\"09fa6b06640ce5b4\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/relativeTime.js\":\"6419dfc5ea7fa62c\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/renderScope.js\":\"95e4b22b825d3dc9\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/resolvedThenable.js\":\"1ea6224aebfc4f74\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/routing.js\":\"38b458e2b5de82e9\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/safeMode.js\":\"f2eccd8e3aabdf97\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/scheduleIdle.js\":\"14911516c61444d6\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/screenWakeLock.js\":\"e155c9eee11e8996\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/selection.js\":\"4fec33a68ac91e33\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/softKeyboardGrab.js\":\"1da5a53c1e010003\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/startupTimeline.js\":\"bb9e2c06c258bee4\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/state.js\":\"3f95de2d29d53ccc\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/string.js\":\"09e7a8a3c043b847\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/surfaceZoom.js\":\"7e7043d9a19c7521\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/time.js\":\"6374fb1c2ab4cf00\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/toast.js\":\"809f816864dcdda2\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/toggleStore.js\":\"b634243fde8feffd\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/untilStopped.js\":\"b74e37c41db77dfd\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/userActivity.js\":\"7d851fc298d9bee1\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/viewTransition.js\":\"737e72a9d03bf0d8\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/viewport.js\":\"0933f7d624dc85dd\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/webLock.js\":\"7f812981b006cc8c\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/workspaceRecovery.js\":\"3f70391a28f6020c\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/workspaceSnapshotStore.js\":\"7380e2d72cda4546\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-compiler-runtime.js\":\"23faa4a113e32bcf\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-client.js\":\"bfa48eeb6f1f8827\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-server-edge.js\":\"eefdeb92c074f0f9\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-server.js\":\"5925c17e38a611bd\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-static-edge.js\":\"1dbab7c3a7756b76\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-static.js\":\"6882dd61c52a778c\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-test-utils.js\":\"657d708f7610cc64\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom.js\":\"5065dfc807cfebbc\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-jsx-runtime.js\":\"f3538a16ead4771f\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react.js\":\"766d28a2a10bd99a\",\"/knowledge-medium/pr-preview/pr-1839/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1839/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1839/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
