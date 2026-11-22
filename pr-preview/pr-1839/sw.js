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
		buildId: "e80067e9be89-8600ea4a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1839/\":\"2a1306f73210bd5c\",\"/knowledge-medium/pr-preview/pr-1839/index.html\":\"2a1306f73210bd5c\",\"/knowledge-medium/pr-preview/pr-1839/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1839/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1839/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1839/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1839/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1839/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1839/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1839/assets/FacadeVFS-B_XJYgXu.js\":\"7c5a5d582bd53742\",\"/knowledge-medium/pr-preview/pr-1839/assets/OPFSCoopSyncVFS-BTiiOOhp.js\":\"6bc9708a0e10aec2\",\"/knowledge-medium/pr-preview/pr-1839/assets/OPFSWriteAheadVFS-BCYyRMIP.js\":\"d4c5d14542cdb045\",\"/knowledge-medium/pr-preview/pr-1839/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1839/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1839/assets/wa-sqlite-async-C5HKNvJG.js\":\"c871ffd7d56852ad\",\"/knowledge-medium/pr-preview/pr-1839/assets/wa-sqlite-lDWFF0mT.js\":\"71507875e023c5fe\",\"/knowledge-medium/pr-preview/pr-1839/assets/worker-BMiqJyXd.js\":\"df28bda40ed17ad1\",\"/knowledge-medium/pr-preview/pr-1839/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1839/chunks/app-CSKRKmra.js\":\"44a51ddc621bebe2\",\"/knowledge-medium/pr-preview/pr-1839/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1839/index.js\":\"a9ae785846b89c8c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1839/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1839/assets/AccessHandlePoolVFS-bSoTyXkd.js\":\"d50c8b6dcd1c6098\",\"/knowledge-medium/pr-preview/pr-1839/assets/IDBBatchAtomicVFS-2dhwMCLg.js\":\"8d2a4985be2ea421\",\"/knowledge-medium/pr-preview/pr-1839/assets/MemoryVFS-JYU8lxfy.js\":\"cb3b20ed07bbb6ac\",\"/knowledge-medium/pr-preview/pr-1839/assets/mc-wa-sqlite-CPBdlOLl.js\":\"61f45e61d0c1dc94\",\"/knowledge-medium/pr-preview/pr-1839/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1839/assets/mc-wa-sqlite-async-Ds6TnwNW.js\":\"c4e03c17b3bbdb7d\",\"/knowledge-medium/pr-preview/pr-1839/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1839/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1839/chunks/AccessHandlePoolVFS-17JFfdO9.js\":\"307cae0051ba5d02\",\"/knowledge-medium/pr-preview/pr-1839/chunks/FacadeVFS-Cc_JVoLl.js\":\"720002f0a1bc220f\",\"/knowledge-medium/pr-preview/pr-1839/chunks/IDBBatchAtomicVFS-BNP4gLPh.js\":\"4cb193cd1e7e46b8\",\"/knowledge-medium/pr-preview/pr-1839/chunks/MemoryVFS-CweFnMfl.js\":\"2394b42f77feb157\",\"/knowledge-medium/pr-preview/pr-1839/chunks/OPFSCoopSyncVFS-DW6201x6.js\":\"0c47f7bff793b2a5\",\"/knowledge-medium/pr-preview/pr-1839/chunks/OPFSWriteAheadVFS-BN7IBD05.js\":\"9d567feb9dd81552\",\"/knowledge-medium/pr-preview/pr-1839/chunks/Preview-Rq0ZBs5E.js\":\"ecfce69890617130\",\"/knowledge-medium/pr-preview/pr-1839/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1839/chunks/card-DoC6_t4B.js\":\"4c5400b70803c265\",\"/knowledge-medium/pr-preview/pr-1839/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1839/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1839/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1839/chunks/dist-ChHVmSvb.js\":\"b6eb0f2573199e9c\",\"/knowledge-medium/pr-preview/pr-1839/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1839/chunks/mc-wa-sqlite-B-isHzz6.js\":\"2acef1455542080c\",\"/knowledge-medium/pr-preview/pr-1839/chunks/mc-wa-sqlite-async-DRno3wm1.js\":\"b9ed22e13b8cccd1\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-3m3DB7kT.js\":\"c5235f5378d478f7\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-Bmr3WYbs.js\":\"188e1e2d259c4bdd\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-BsboEJBC.js\":\"010367ad4dcde8fa\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-D8_fqKWr.js\":\"5dfa595d2401907a\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-DBu-iCeC.js\":\"5e8fff1328713199\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-DdAMXBcU.js\":\"0d379d2d4a774c84\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-O2aDttxb.js\":\"bec0332dad7c0362\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-PASsVHBv.js\":\"280aee5f87beecaa\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-dom-server-legacy.browser.production-Boxb3AKp.js\":\"4f3e6e7a7320c5b5\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-dom-server.browser.production-DKHiYMUi.js\":\"5456590a107f86d4\",\"/knowledge-medium/pr-preview/pr-1839/chunks/react-dom-server.edge.production-BBrhUWF6.js\":\"27cb7bac5bd040a4\",\"/knowledge-medium/pr-preview/pr-1839/chunks/server.browser-97_UF5V3.js\":\"512c4ea282dba5b7\",\"/knowledge-medium/pr-preview/pr-1839/chunks/textarea-G0a4Xozx.js\":\"44fd6b24fc255565\",\"/knowledge-medium/pr-preview/pr-1839/chunks/ui-DRNASS3X.js\":\"04bb5ffc0678e342\",\"/knowledge-medium/pr-preview/pr-1839/chunks/wa-sqlite-async-Csm--P64.js\":\"edd4992a8b1ebc86\",\"/knowledge-medium/pr-preview/pr-1839/chunks/wa-sqlite-cXKe6feQ.js\":\"7053c1648df83958\",\"/knowledge-medium/pr-preview/pr-1839/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1839/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1839/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1839/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1839/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1839/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1839/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1839/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1839/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1839/src/App.js\":\"f05ac7357cc5102b\",\"/knowledge-medium/pr-preview/pr-1839/src/appUpdate.js\":\"bee2bcd02f00ab66\",\"/knowledge-medium/pr-preview/pr-1839/src/appVersion.js\":\"7de6be3a0f3f1592\",\"/knowledge-medium/pr-preview/pr-1839/src/bootstrap/initialLayout.js\":\"7915cfce8879939f\",\"/knowledge-medium/pr-preview/pr-1839/src/bootstrap/openWorkspaceData.js\":\"e8c872269752c71e\",\"/knowledge-medium/pr-preview/pr-1839/src/bootstrap/resolveWorkspace.js\":\"d06583603f7f60cb\",\"/knowledge-medium/pr-preview/pr-1839/src/bootstrap/workspaceBootstrap.js\":\"87fb97f1b393db24\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockComponent.js\":\"9295f0fc63c68ee2\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockCrumbs.js\":\"4511bd851791e0c9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockEditor.js\":\"f793ea2f13fe3292\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockLoadingPlaceholder.js\":\"394495101582b0ef\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockProperties.js\":\"552b90cbcb79c98d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/BlockSearchPicker.js\":\"fa6ae8cf2e37f14d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ConfirmBulkDeleteDialog.js\":\"4399237955df28ca\",\"/knowledge-medium/pr-preview/pr-1839/src/components/DividerHandle.js\":\"f1a1d7128a8a459f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/DraftEditor.js\":\"4a69e81abe10dd3c\",\"/knowledge-medium/pr-preview/pr-1839/src/components/GutterPill.js\":\"8ec5169e62f98553\",\"/knowledge-medium/pr-preview/pr-1839/src/components/Header.js\":\"877781716b3a66cc\",\"/knowledge-medium/pr-preview/pr-1839/src/components/LazyBlockComponent.js\":\"f904281a8848394e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/Login.js\":\"f2ca1171588aef97\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ZoomableSurface.js\":\"f90b4b1d106e92c0\",\"/knowledge-medium/pr-preview/pr-1839/src/components/editModeKeepalive.js\":\"ad1afa2d74ea4d6e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyDisplay/PropertyDisplayScope.js\":\"ba98040694c985cb\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"784d904f28c45826\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/RefPropertyEditor.js\":\"162de2d077403ae3\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/RefTargetTypePicker.js\":\"fb0ef8f9887a444f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/SelectPropertyEditor.js\":\"250f9bb00418b419\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/TypesPropertyEditor.js\":\"bc4389ee45d21e44\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/defaults.js\":\"eb761fe8b2f072f4\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/kernelValuePresets.js\":\"c7e421241c8f389a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/selectablePresets.js\":\"92baf2f91e8753e9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyEditors/typesPropertyUi.js\":\"2ba23ca13af14c5f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/AddPropertyForm.js\":\"a13283b56a88206c\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/PropertyPicker.js\":\"1432b4e72c0fb87d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/PropertyRow.js\":\"3c0de6684002efe0\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/Rows.js\":\"fababa09c90a969a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/actions.js\":\"c2dda8d0019ab0c7\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/declarationOnly.js\":\"8fae1001f1a4ae4c\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/layout.js\":\"faebad3487ea183e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/model.js\":\"b7bec7f795d6b492\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/shapeUi.js\":\"21ab81c0c2c9e08a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/shapes.js\":\"a5f3e18b72026d8f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b3c6675a95e7473d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanel/visibility.js\":\"6e8aab1f7925b297\",\"/knowledge-medium/pr-preview/pr-1839/src/components/propertyPanelSections.js\":\"5b5a58911a82013b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/BlockEmbed.js\":\"c53f13a2f365014f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/BlockLink.js\":\"86a1c531f166b674\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/BlockRef.js\":\"c03f14c0e508d077\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/ReferenceLink.js\":\"5ce671c9439f515d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/cycleGuard.js\":\"24e1af808c1ca3f7\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/cycleGuardContext.js\":\"74499cac0957102b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/linkInteraction.js\":\"604640e011f01fa5\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/referenceLayout.js\":\"b5944bb41e99a38e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/references/useBlockRefAncestors.js\":\"27c35ffd8c60d40d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/BlockGutter.js\":\"1b4f06f3270bc668\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/BlockInfoDialog.js\":\"7288e8f0f9b8b529\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/BlockTypeBlockRenderer.js\":\"0cba8fb3391e6624\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/BulletHoverCard.js\":\"a67688374e5c3672\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/CodeMirrorContentRenderer.js\":\"5618739a5a76fc7e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8eb7f765390f84dc\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/ColumnResizeHandles.js\":\"9e0c28e2ee3f9ef4\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d2c0fd6c8ad40cf6\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/DefaultBlockRenderer.js\":\"9b9793bd308b0543\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/LayoutRenderer.js\":\"3143d76782775b96\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/MarkdownContentRenderer.js\":\"d64c9f53466c2449\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/MissingDataRenderer.js\":\"1c4dbf0c3a10b517\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/PanelRenderer.js\":\"5eaeb098b99b7e7b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c314f92a42dab93b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/TopLevelRenderer.js\":\"0565b4a2537e2f6e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/blockGutterMode.js\":\"1a6b440b65078ede\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/blockTitleText.js\":\"4f77c144bfd33d2d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/fieldCreationKeydown.js\":\"f73c7f21f376986e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/renderer/layoutRootContext.js\":\"bb9e975f6e3e95ca\",\"/knowledge-medium/pr-preview/pr-1839/src/components/typeChip/TypeChip.js\":\"34ef8847431c836f\",\"/knowledge-medium/pr-preview/pr-1839/src/components/typeChip/chipStyle.js\":\"6e9ee2dc8c48fa7b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/anchored-floating.js\":\"3f1db2b9099a77c4\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/button.js\":\"5a0b6d6fa16c3441\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/card.js\":\"c4fa357fc8c55761\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/checkbox.js\":\"3fad025cea1f2e96\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/collapsible.js\":\"a828a0cf69c28f5b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/command.js\":\"90ec7dfd231abf50\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/context-menu.js\":\"de0de0567e1ed44a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/dialog.js\":\"d425bfc40289847d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/dropdown-menu.js\":\"82efe46ac975ebf0\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/floating-listbox.js\":\"8e843ba30587532c\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/index.js\":\"267301ce27db89b9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/input.js\":\"3b8d7c4c78d4b7f4\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/kbd.js\":\"8a1c9a8e7e299ef4\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/label.js\":\"6f47c46af84a0617\",\"/knowledge-medium/pr-preview/pr-1839/src/components/ui/textarea.js\":\"33fe32b4c4b44561\",\"/knowledge-medium/pr-preview/pr-1839/src/components/useEditModeYieldKeepalive.js\":\"842ed023a4ff176b\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/BootFallback.js\":\"b47cab7d347dae04\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/FocusedRowLazyMount.js\":\"ae37db10b1e9227d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/LazyViewportMount.js\":\"49bae29bcaf452c8\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/LocalDbCorruptionFallback.js\":\"5023de20c1256c8a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/error.js\":\"8c88d668df5bb2c9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/lazyMountRegistry.js\":\"9be2a82b4cd1779a\",\"/knowledge-medium/pr-preview/pr-1839/src/components/util/suspense.js\":\"9c668e0fc171609e\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/CreateWorkspaceDialog.js\":\"2858a732c9512e3d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/PendingInvitations.js\":\"9984be4f567e7fbb\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/SyncProgress.js\":\"c60669354de337a2\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/UnlockProgress.js\":\"4c6e747d1a205319\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/WorkspaceKeyGate.js\":\"929b8d10064390c2\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/WorkspaceSettingsDialog.js\":\"b9f171b264c78749\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/WorkspaceSwitcher.js\":\"be6c10ac09d3fc27\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/WorkspaceSyncGate.js\":\"ab0fedbe55280bf9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/ConversionFlow.js\":\"74a2e1c84544e0ad\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/ConversionFlowHost.js\":\"5541ed9b0c9885b1\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/EncryptionSection.js\":\"d4b8baabcd5230c3\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/attachmentPrompts.js\":\"56f4a8c197fdccba\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b15be01291dd98d9\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/conversionFlowDeps.js\":\"7a5949f29eb8f718\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/conversionFlowStore.js\":\"54d6382932424227\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/flowUi.js\":\"de8d0c5ca2882421\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/conversion/useConversionRun.js\":\"f03d34b4ca084b3d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/keyUi.js\":\"19052896a6a49cf2\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/useCloseOnKeyLoss.js\":\"e11c6ae5be7d306d\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/useCloseOnServerE2ee.js\":\"8fdfbf1ebe9b4963\",\"/knowledge-medium/pr-preview/pr-1839/src/components/workspace/workspaceUnlocked.js\":\"d7027605f4eb554f\",\"/knowledge-medium/pr-preview/pr-1839/src/context/backgroundSubtree.js\":\"459cff4cceed573e\",\"/knowledge-medium/pr-preview/pr-1839/src/context/block.js\":\"e0af2d333f40eb3c\",\"/knowledge-medium/pr-preview/pr-1839/src/context/layoutWsContext.js\":\"dd42e94ffb26f4a0\",\"/knowledge-medium/pr-preview/pr-1839/src/context/propertyDisplay.js\":\"21e9f3dda633178b\",\"/knowledge-medium/pr-preview/pr-1839/src/context/repo.js\":\"e3d19cc0ac26d77d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/aliasClaim.js\":\"48ec871bb8e35ff1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/aliasSeatNamespace.js\":\"00fee9a0d0054be3\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/blockData.js\":\"77716e336bf4d9d9\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/blockType.js\":\"6768c295c9ed8d63\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/changeScope.js\":\"493a344b4f5ae9d5\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/codecs.js\":\"fd68060754f88093\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/derivedData.js\":\"f62aa19f6cfa6fde\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/errors.js\":\"c4476087de6ad1dd\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/events.js\":\"9dd9655a32c04a2d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/handle.js\":\"88074e6fb4d20dfd\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/index.js\":\"deee49c732f2d177\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/mutator.js\":\"8f2a391d49618c68\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/processor.js\":\"e0a14e705d914529\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/propertySchema.js\":\"20237b564365364b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/query.js\":\"1a6fd1287a8fb497\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/sameTxProcessor.js\":\"8440431229084211\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/schema.js\":\"88074e6fb4d20dfd\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/tx.js\":\"88074e6fb4d20dfd\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/typedBlockQuery.js\":\"878da88599486ec6\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/user.js\":\"5aadd7d0c81e018d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/valuePresetCore.js\":\"f24e5e90c1b4bc28\",\"/knowledge-medium/pr-preview/pr-1839/src/data/api/valuePresets.js\":\"f1e9aaf6fa0c7d46\",\"/knowledge-medium/pr-preview/pr-1839/src/data/attachmentCleanerIOVerb.js\":\"9333cdedbcc1fa79\",\"/knowledge-medium/pr-preview/pr-1839/src/data/block.js\":\"e5ce9249301c20ce\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockCache.js\":\"2d710d40c90c6ef9\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockId.js\":\"0c6f75a543d6aaed\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockLiveness.js\":\"24690c6ff7e3690a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockMerge.js\":\"f701e72c703ccc1b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockSchema.js\":\"c5091aaf6b3d3fc4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockTypeLookup.js\":\"f0de018d3580a432\",\"/knowledge-medium/pr-preview/pr-1839/src/data/blockTypes.js\":\"0c8667b4a67d8de4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/clientContext.js\":\"4575faaee0c61200\",\"/knowledge-medium/pr-preview/pr-1839/src/data/dbFileSiblings.js\":\"9b779c2c5658abe4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/definitionSeeds.js\":\"934861676dd5ad13\",\"/knowledge-medium/pr-preview/pr-1839/src/data/derivedIds.js\":\"250ef787b43a97a1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/drawnSubtree.js\":\"f124131dac99eb01\",\"/knowledge-medium/pr-preview/pr-1839/src/data/facetBridge.js\":\"4caa9dfcf516ad36\",\"/knowledge-medium/pr-preview/pr-1839/src/data/facets.js\":\"e37cab29994c20ae\",\"/knowledge-medium/pr-preview/pr-1839/src/data/globalState.js\":\"e9d35f5498d2243b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/aliasClaimRederiveProcessor.js\":\"4d19511f4e26e0bd\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/ancestorBatch.js\":\"8357a77cb45fbd2f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/blockTypeTypeifyProcessor.js\":\"5fb4377653fbab82\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/clientSchema.js\":\"2491184e752ea5e4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/commitPipeline.js\":\"eb57a7b0809fb62d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/devAssertions.js\":\"590ec6c9796ce8f1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/firstSync.js\":\"34fd4154a7029498\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/freshInitialLoad.js\":\"161445b5a7608bdc\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/graphBackfillClaim.js\":\"868fecce80c6028e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/handleStore.js\":\"505e89b9ccfc7987\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/idleMarkerJobs.js\":\"a5e28cda964017d2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/initialDownload.js\":\"b2e917e33ce7cd37\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/initializeClientDatabase.js\":\"4cc61b4d263ef955\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/jsonCanonical.js\":\"0f0bbe301a32a728\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/kernelInvalidation.js\":\"f4bea1979758cbaa\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/kernelProcessors.js\":\"a77c3c8eaebdfe86\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/kernelQueries.js\":\"56c451d7eac96479\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/mergeTypeMembershipProcessor.js\":\"1e4a75aeeee9ed52\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/normalizeReferencesProcessor.js\":\"d72ea3e88a743622\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/poolInstrumentation.js\":\"47240de24734f11f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/processorRunner.js\":\"d07d52ed2000b3a3\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyCellBackfill.js\":\"b724dcff2ca00650\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyChildMint.js\":\"be37b2ce6f39da58\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyChildrenProcessor.js\":\"751342ffd7b97d82\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1e177fb624d5100c\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyDefinitionSynthesis.js\":\"71915d7687f75f1e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyKeyScan.js\":\"3580b7a8e34c4b53\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertySchemaResolution.js\":\"aea1288de6c6326f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/propertyValueEdits.js\":\"632bd59e648071f1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/raiseProtocol.js\":\"b43ae29302773ef5\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/readBatch.js\":\"0b4aa7ef37810498\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/refProjection.js\":\"bbd5ce4eb1f78810\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/referenceTargetLookups.js\":\"7cadfc6af4ff971c\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/referenceTargetProcessor.js\":\"82367109bfb2a0e3\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/replayMerge.js\":\"00e8dfc8fa65683e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/sqlBinds.js\":\"ece7633297e4fcbd\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c4cbf3c7053d7ae4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/arrivalProcessors.js\":\"6e405e80d62f5319\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/invalidate.js\":\"c70c01db284f444e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/materialize.js\":\"8f0f64f4d9b6fe36\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/observer.js\":\"08fef2f13108900c\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/syncObserver/reconcile.js\":\"acd6cb66a73014a3\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/timingMetrics.js\":\"2797e26c9c534da3\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/treeQueries.js\":\"6f8d478223b6d892\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/txEngine.js\":\"bba08eeb0468d1b4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/txSnapshots.js\":\"12e17276565cf90b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/typedBlockQuery.js\":\"aca63c3b44262539\",\"/knowledge-medium/pr-preview/pr-1839/src/data/internals/undoManager.js\":\"7c8f385bec73a8cd\",\"/knowledge-medium/pr-preview/pr-1839/src/data/invalidation.js\":\"93a33d6a6df63881\",\"/knowledge-medium/pr-preview/pr-1839/src/data/kernelDataExtension.js\":\"d6414e46c80d47ba\",\"/knowledge-medium/pr-preview/pr-1839/src/data/kernelPage.js\":\"a1a544dde9812fcf\",\"/knowledge-medium/pr-preview/pr-1839/src/data/kernelValuePresetCores.js\":\"e30944346f4e66e2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/localDbCorruptionSignal.js\":\"58d3cfbcae70f774\",\"/knowledge-medium/pr-preview/pr-1839/src/data/localDbStorage.js\":\"e695dddf6bdad5f1\",\"/knowledge-medium/pr-preview/pr-1839/src/data/localDbVfs.js\":\"76efa0d55dc71d86\",\"/knowledge-medium/pr-preview/pr-1839/src/data/localSchema.js\":\"faa75622aca4aa44\",\"/knowledge-medium/pr-preview/pr-1839/src/data/maintenance.js\":\"a033d7a0d9dfa2d0\",\"/knowledge-medium/pr-preview/pr-1839/src/data/mergeProperties.js\":\"114956c310c2a28d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/metricsConsoleHook.js\":\"405ab392672316e5\",\"/knowledge-medium/pr-preview/pr-1839/src/data/migrationsPage.js\":\"03dcc49556f74dea\",\"/knowledge-medium/pr-preview/pr-1839/src/data/mutators.js\":\"03a144747f6e13ce\",\"/knowledge-medium/pr-preview/pr-1839/src/data/orderKey.js\":\"157cdda7255d486f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/orderKeyPlacement.js\":\"c810fc42b4415c5f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/outlineSurface.js\":\"76cab69df2e4426d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/pendingEditorContent.js\":\"07ccb09a2c590c54\",\"/knowledge-medium/pr-preview/pr-1839/src/data/pendingUploadsSql.js\":\"d62f14d073bd211b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/pluginStateExtensions.js\":\"f3a03632ea0d476d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/powerSyncLogger.js\":\"f4f3f69af826623e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/projectorRuntime.js\":\"53aa95e101f67eb5\",\"/knowledge-medium/pr-preview/pr-1839/src/data/properties.js\":\"7f47b76ec285f633\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertiesPage.js\":\"befb56921a4d2d4a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyChildren.js\":\"a7c1c3048c2e2dd4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyDefinitionFanout.js\":\"064c8108416305ce\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyDefinitionMetadata.js\":\"5d65faa1b29c7a70\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyDefinitionRegistry.js\":\"110238909672aa1f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyDisplayMode.js\":\"6e783cf21b35128f\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertyRowCreation.js\":\"99920965e5a3da2d\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertySchemaCreation.js\":\"5986c5817bc6e8dc\",\"/knowledge-medium/pr-preview/pr-1839/src/data/propertySeeds.js\":\"8b24b4de528b5806\",\"/knowledge-medium/pr-preview/pr-1839/src/data/recentsPage.js\":\"106433b2daaf64ad\",\"/knowledge-medium/pr-preview/pr-1839/src/data/referenceBlock.js\":\"29e4411de21d91e2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/rejectedUploads.js\":\"e505e77840531440\",\"/knowledge-medium/pr-preview/pr-1839/src/data/releasePowerSyncConnection.js\":\"527d33c88ad9a6ec\",\"/knowledge-medium/pr-preview/pr-1839/src/data/repo.js\":\"6a11f06fff9033b2\",\"/knowledge-medium/pr-preview/pr-1839/src/data/repoProvider.js\":\"a6175ae8fd8786c8\",\"/knowledge-medium/pr-preview/pr-1839/src/data/rowProperty.js\":\"b60f98f8a42ede87\",\"/knowledge-medium/pr-preview/pr-1839/src/data/searchFilter.js\":\"70f3e4a23ea4383c\",\"/knowledge-medium/pr-preview/pr-1839/src/data/seedIdentityLedger.js\":\"f5778ea5a7fee1d4\",\"/knowledge-medium/pr-preview/pr-1839/src/data/stateBlocks.js\":\"1da30d7dc2a70418\",\"/knowledge-medium/pr-preview/pr-1839/src/data/structuralEditPolicy.js\":\"93fd87cd0ec6cc49\",\"/knowledge-medium/pr-preview/pr-1839/src/data/subtreeDelete.js\":\"b644402e90d572a0\",\"/knowledge-medium/pr-preview/pr-1839/src/data/syncStreamLock.js\":\"ab762dc745819a35\",\"/knowledge-medium/pr-preview/pr-1839/src/data/syncedTableSqlRecognizer.js\":\"27202a648de95d1b\",\"/knowledge-medium/pr-preview/pr-1839/src/data/syncedTableWriteGuard.js\":\"5f5ad61b2283b748\",\"/knowledge-medium/pr-preview/pr-1839/src/data/targets.js\":\"ec86b4f2a88b30e0\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeColors.js\":\"e39b2b547133325a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeDefinitionMetadata.js\":\"172f0c82dc28369e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeDefinitionRegistry.js\":\"6130fde8021dfb29\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeExtraction.js\":\"bb38ac3633901f68\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeInitialValues.js\":\"1eba820d466881a7\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typePropertyGroups.js\":\"cf6fc0444dbed800\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeSeeds.js\":\"cfe5e1d26da2906e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typeTagger.js\":\"7334a6ac9c95d57e\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typedRecords.js\":\"567a96d23841697a\",\"/knowledge-medium/pr-preview/pr-1839/src/data/typesPage.js\":\"b471345e15e596e0\",\"/knowledge-medium/pr-preview/pr-1839/src/data/userPrefs.js\":\"e81e76185e85c382\",\"/knowledge-medium/pr-preview/pr-1839/src/data/userSchemasService.js\":\"0ec58ebd8b0b3534\",\"/knowledge-medium/pr-preview/pr-1839/src/data/userTypesService.js\":\"1b2077d512d1e152\",\"/knowledge-medium/pr-preview/pr-1839/src/data/valuePresetRegistry.js\":\"42c567562471b1a0\",\"/knowledge-medium/pr-preview/pr-1839/src/data/visibleChildren.js\":\"a9e48030afe5dab3\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaceConversion.js\":\"dbafbaa76dc27394\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaceFirstSync.js\":\"8b1dc42c781a5dcb\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaceIdNamespace.js\":\"8d6f9da269e81e22\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaceSchema.js\":\"72f29f9a525ebc73\",\"/knowledge-medium/pr-preview/pr-1839/src/data/workspaces.js\":\"e6eb85c27fdeea40\",\"/knowledge-medium/pr-preview/pr-1839/src/data/writeAheadLog.js\":\"f74d744f5ae52012\",\"/knowledge-medium/pr-preview/pr-1839/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/BlockPasteShellDecorator.js\":\"b310b9ef35234f25\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/atTrigger.js\":\"a42a944a99a4c691\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/autocomplete.js\":\"517ffbe6f0129843\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/codeMirrorExtensions.js\":\"a3d167d29926b23c\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/contentFlush.js\":\"1185c821cd6a7afe\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/defaultInteractions.js\":\"031f2db93e0cd22d\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/editSettleSignal.js\":\"eb909d382b544fba\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/insertImage.js\":\"abc6c1722e27e16d\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/referenceCompletionRange.js\":\"6fd07925a99d1a26\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/referenceTargetTypes.js\":\"7d7f0fe0aa555273\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/syntaxContext.js\":\"6f560f868eef6d70\",\"/knowledge-medium/pr-preview/pr-1839/src/editor/triggerMatch.js\":\"ede7b7c84b1da670\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/AppRuntimeProvider.js\":\"7b748ad35f74145b\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/BlockFocusShellDecorator.js\":\"900e4691e0429988\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/ExtensionRenderBoundary.js\":\"3a4479f51220bcd2\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/PanelContentRecovery.js\":\"9e7c7b2c833b7bc5\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/apiCatalog.js\":\"3adf7b33fbe58aa6\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/approveExtensionHere.js\":\"a1454015f9f95100\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/armedCutAppMount.js\":\"2cb8f9402b1d595e\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/batchableKeyedStore.js\":\"6c5a94a613e49ab4\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/blockInteraction.js\":\"89be59dde1e36e2a\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/blockSelectionAction.js\":\"ff4c0b2ef162b496\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/compileExtensionModule.js\":\"7ad0e9cf339f1d42\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/compiledModuleCache.js\":\"05de00f60453c323\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/continuousGestures.js\":\"baa65325a4f31988\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/core.js\":\"927dd3b1e650caa4\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/defaultRenderers.js\":\"198949a34368efb4\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/definitionFanoutAppMount.js\":\"37af456b10f95457\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/dialogAppMount.js\":\"4c80a3d1e5e02dcf\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/dynamicExtensionSeeds.js\":\"048e045c1493576f\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/dynamicExtensions.js\":\"9b78157e70ccbfe0\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/exampleExtensions.js\":\"a7b34106cc4f4410\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionApprovalStatus.js\":\"65573259df368611\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionLoadErrorToast.js\":\"80199fc6dc59d327\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionLoadErrors.js\":\"1e683a1c0c217fab\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionLookup.js\":\"8bd1f5c6daa44b6f\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionToggles.js\":\"abfcf937d1ab76a3\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/extensionUtilitiesCss.js\":\"d7a0a4ad7ec99390\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/kernelPageDeletionGuard.js\":\"ddfd57bebc947422\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/liveRuntime.js\":\"2a3dabee771636e9\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/openExtensionsSettings.js\":\"00c8f79a5c04ac3e\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/overridesCache.js\":\"e002aed66b22d9ef\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/pluginIds.js\":\"72749336554ce685\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/processorRejectionToast.js\":\"e5ce473570fbe2cd\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/runtimeActions.js\":\"489f770eb4594785\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/runtimeContext.js\":\"1354a8b24dca23f6\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/staticAppExtensions.js\":\"329f8e3eb123802a\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/staticDataExtensions.js\":\"874aaa131705952e\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/toastAppMount.js\":\"dc42dfb618efe513\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/useOverrides.js\":\"0930875e558da41f\",\"/knowledge-medium/pr-preview/pr-1839/src/extensions/useShortcutSurfaceActivations.js\":\"f16791494a865d85\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/discoverToggleTree.js\":\"74a8cfbb519f0fd5\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/facet.js\":\"126bd59baab2d0b3\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/resolveAppRuntime.js\":\"6f8dc755598eac37\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/runtimeEvents.js\":\"c081f299a745efb7\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/togglable.js\":\"fe63e6e6106e0493\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/variantFacet.js\":\"ab1afb01a39d600b\",\"/knowledge-medium/pr-preview/pr-1839/src/facets/verbFacet.js\":\"7db8468d5614f3b6\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/block.js\":\"400b592118b72a28\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/focusedChild.js\":\"5ef1e11960201316\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/propertySchemas.js\":\"dea5d3b941df0e61\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/typeRegistry.js\":\"003963315f3d8713\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useAncestorCrumbs.js\":\"082d86bb884bc6da\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useAutocompleteListbox.js\":\"d03ea55e5adc31b7\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useDebouncedSearch.js\":\"d2697f8d9cf644ae\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useDebouncedValue.js\":\"6c7d0741c3958a72\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useIsFocalRender.js\":\"661b5284acd22d96\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useIsReadOnly.js\":\"01671b5d71cbeac2\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useMaterializeBacklog.js\":\"e0c194652097efbf\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useMinuteClock.js\":\"096cda9652bb7ad3\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/usePanelLayoutProjection.js\":\"2c4a4eded0b674a9\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/usePendingInvitations.js\":\"8172ba1390ebedb5\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useRendererRegistry.js\":\"5b808d0a38754bc6\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useRetainedFieldRows.js\":\"8b84469768414373\",\"/knowledge-medium/pr-preview/pr-1839/src/hooks/useWorkspaces.js\":\"027a48741c38e1a6\",\"/knowledge-medium/pr-preview/pr-1839/src/lib/utils.js\":\"eea9092a3954f598\",\"/knowledge-medium/pr-preview/pr-1839/src/main.js\":\"37b0722ce6b31298\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/MarkdownImage.js\":\"c16592087aac6c9b\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/blockSeparators.js\":\"7579df688e908b83\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/context.js\":\"5e09cf2191111ac2\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/defaultMarkdownExtension.js\":\"96911c32afaa3d50\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/extensions.js\":\"ac183a5c14459788\",\"/knowledge-medium/pr-preview/pr-1839/src/markdown/renderMarkdownHtml.js\":\"c56202289b4e1777\",\"/knowledge-medium/pr-preview/pr-1839/src/minimal-editor.js\":\"80b379f9a81930dc\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/armedCut.js\":\"058bbd05d39bd10e\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/captureMediaVerb.js\":\"4899e557387d8b9a\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/clipboard.js\":\"4e1cd7a2a918d8be\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/decision.js\":\"fa2615329285644c\",\"/knowledge-medium/pr-preview/pr-1839/src/paste/operations.js\":\"c217305d33f2224d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/account-header/AccountHeaderItem.js\":\"4619e6fa0c468825\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/account-header/index.js\":\"fdcbc6a8d6f33b4c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c67da52aaebe79c9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/askAgent.js\":\"73f0ad76c37d93fe\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/askedStore.js\":\"4d06a25b242a25fd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"52bd2ba3a5c8c2c2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/chipState.js\":\"b9ba0dc92fb2cb81\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c78b3597c6008114\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/index.js\":\"d185dad1a4b46553\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8933e645dd50cae1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-dispatch-companion/schema.js\":\"7d0db63779acdfa4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/AgentTokensDialog.js\":\"12b9412f38f172bd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7b904bae21cce7a0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/addMedia.js\":\"dee4a7bc761662da\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/backlinks.js\":\"dec8b719cef6be8b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/block.js\":\"45f8ea57f97c7d51\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/context.js\":\"36c5dde7cde473dc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/displayIds.js\":\"959712803037eadf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/index.js\":\"46b20af364f28677\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/outline.js\":\"a7519282c30a9edb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/properties.js\":\"a1e84dd8edd4a267\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/refs.js\":\"3a81b800d5a0f769\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8b477febe9057433\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/search.js\":\"9ad59316feaa2c06\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/shared.js\":\"27b7f7d06ce06f29\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d31e3f5a9a354f91\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentViews/text.js\":\"f4f12be8e4c15b10\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/agentWrites.js\":\"5dd75ca9d3b6853a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/authoringCatalog.js\":\"c43bac6d2c4e8d7b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/blockRefTargets.js\":\"cf153071d6ab7398\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/bridge.js\":\"b07d22f97ff238a9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/bridgeLoop.js\":\"5f9debe1c65d1ce8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/changeHistory.js\":\"dadadb90720b9f80\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/commands.js\":\"974948cf19310694\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/commentsCommands.js\":\"7a052858829118dd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/dataExtension.js\":\"2886afcd56f54f4b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/dataModelGuide.js\":\"ea936b36f4354bb1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/describeRuntime.js\":\"6c91b5ff37d87ccd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/extensionLint.js\":\"e879f06e6958206a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/grainAudit.js\":\"99a5d317f5b35dee\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/healthCommand.js\":\"ad39c4b2fbd77570\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/index.js\":\"173d094a8662b0ad\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/presetIdentity.js\":\"53d258b6d380ce43\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f2c78690c7358bde\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/readMedia.js\":\"85ad3ff7bbfde0da\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/schema.js\":\"29fca03d0fe40731\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/serialization.js\":\"973224c7e3496bf7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/targets.js\":\"e8c3bfd7af338072\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/tokens.js\":\"52c96e787dfd8baa\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/watchEvents.js\":\"70732e7e71c8ca02\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/workspaceGuard.js\":\"4dbcdba6f0a09329\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/agent-runtime/writeCommands.js\":\"f5e5e3964414ccf0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/AliasCollisionToast.js\":\"ee871d8e096ff051\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/DuplicateNameBanner.js\":\"97b48cdb7857d942\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/collisionMerge.js\":\"405aed008dcb6d2f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/dataExtension.js\":\"00463a629fa4ea20\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/index.js\":\"7cc8ab2523a1922b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/mergeCollisionAction.js\":\"79c8aa0145abeefc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/pageStyling.js\":\"429233dfe38615c0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/rejectionToast.js\":\"b4bc9c991e8159e2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/alias/syncProcessor.js\":\"f8d4151b297afd55\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/actions.js\":\"20a20de0de1c540c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/addComment.js\":\"f36110191dcfb3db\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/anchor.js\":\"9e52e51f83af6d62\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/anchorState.js\":\"314bc7ab7caf02f1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/commentLinks.js\":\"539b15260c2f4d58\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/confirmThreadDeletion.js\":\"04ef212fc2f51539\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/container.js\":\"7fb3a7f290b41dc5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/dataExtension.js\":\"1d25e70d77f631b2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/deleteComment.js\":\"4593bc3a3442934c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/highlights.js\":\"c9ecc05bd8fdfe06\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/index.js\":\"a6f0c3f7966262cd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/linkedCommentsPill.js\":\"7cc467fe0254aafb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/margin.js\":\"c3b5afd665ec733b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/marginSchema.js\":\"5b4d7c5fc8485cc2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/newComment.js\":\"9e92fa908351b0ad\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/ownThreadPicker.js\":\"e419a302d00afd01\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/placement.js\":\"b63bc442cf80a3a2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/queries.js\":\"ffba7c076d6b986d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/quotePosition.js\":\"8707b72b7400eaaa\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/quotedIn.js\":\"c71d956300b7ee52\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/quotedRange.js\":\"1634eb443b1d7641\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/rangeRefs.js\":\"77c9f732a59243f7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/readHighlights.js\":\"fd90f9c83a0da18a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/readSelection.js\":\"c2f1ae28dc9e1c68\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/readSelectionUi.js\":\"5ad64d2a0eabffd9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/reanchor.js\":\"1c80f7f24d3104a5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/schema.js\":\"fea583f47ad6ef37\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/scope.js\":\"2e8b24ed5c7916cf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/scopeThreads.js\":\"6fa4e4090ed95058\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/splitRetarget.js\":\"e6cc69e4a169b9e4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/suggestionCard.js\":\"e8f7a7e23067935b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/suggestions.js\":\"e86d5ff76a1e53b3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/summaries.js\":\"18351617249614f5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/summaryBatch.js\":\"b8094027ef0391d1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/surface.js\":\"61d81d38c2dea8a0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/threadNavigation.js\":\"3cb6604e1119c9b7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/threads.js\":\"3c24d812e4f36c63\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/ui.js\":\"91aea4d4fcb34e19\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/annotations/uiStore.js\":\"19221f75c80a3544\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/app-intents/appIntents.js\":\"c19033c1d6d3758b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/app-intents/index.js\":\"2cb268a71ca5143d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/app-update-prompt/index.js\":\"1c3d7919a6660693\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/app-update-prompt/status.js\":\"bc47c4766cabc89e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b9f353fbc282367c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/MediaBlockRenderer.js\":\"82f5a77d5e2dca02\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d6462af60a17fddc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/MediaUploadReconciler.js\":\"d3f391ccf79f042d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/assetDownLane.js\":\"107bbdbbc20d1ee1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/assetResolver.js\":\"54d58c5b09928ae9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/assetUpload.js\":\"041ad335602ea5fc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/attachmentCleanerIO.js\":\"f8cd49237eb3da95\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c49b0d84a5ae0b9a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/blobStore.js\":\"3ffa731dc174552d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/byteStore.js\":\"280603d224d9155e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/cleanerIO.js\":\"ddf52d4326def4ff\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/cleanupAttachments.js\":\"34c9f1ea629429fc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/dataExtension.js\":\"e93a100ae7a996be\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/downLane.js\":\"487f0c05b5035f42\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/index.js\":\"7b8863ef54d8c26b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/insertImageContribution.js\":\"cf663cd4c17f35bf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/laneArming.js\":\"38174b2b74fb2a96\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/laneLock.js\":\"f8ad0ccdf08385da\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/mediaBlock.js\":\"0cb51e6a0ddd5ced\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/mediaCapture.js\":\"1af11b7de483f4ed\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/mediaViewers.js\":\"6b15a52e25edf4cd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/mediaViewersFacet.js\":\"dc79eabc10f0af6e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/pasteCapture.js\":\"1077ff3ed848301c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/resolver.js\":\"f1f82e9ef0b01ece\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/retryUploadsAction.js\":\"f9aa25d006cc3941\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/storagePaths.js\":\"2cc3fece505373cf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadDrain.js\":\"fa571c53f6090fda\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadLaneStatus.js\":\"87621d2fd027c6c4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadReconcile.js\":\"d55e946ea4ac6572\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadRecovery.js\":\"dcf392309e10768f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/uploadStore.js\":\"bc4dac8941a9781a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/attachments/useAssetObjectUrl.js\":\"6747fec62afb467f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"60bf7a52cad7fb4a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e9b43730b674c720\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/facet.js\":\"25398e3b942bdd20\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/index.js\":\"2c31bce8e768c798\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks-view/prop.js\":\"0efae7e8345069cc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/BacklinkFilters.js\":\"8bf23c98f7109b66\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2bf2b308a9714105\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/BlockEntry.js\":\"e8e04d7f9f0dcf1a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/LinkedReferences.js\":\"36a4f74aa1fb9a7e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"68347f459a72bc2e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/dailyNoteDefaults.js\":\"82b467ec9cdc5d5b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/dataExtension.js\":\"e905a81ec200fb05\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/edgeExclusions.js\":\"b4f5266a74dc5b82\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/filterProperty.js\":\"60a44d905bed43e7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/index.js\":\"94095d0312a47a52\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f77ff60cd0a7d163\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/applies.js\":\"d034ba311c79ed53\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/countQuery.js\":\"4a8e302584ed3a9f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3caf12f9509edc54\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/index.js\":\"bb61fb9d5db76e56\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ff5e714a17302983\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/presentationInvalidation.js\":\"76f4a92f1c737f9c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/propertyEditorOverride.js\":\"cd9c3e0f030bbe26\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/propertyFilter.js\":\"a9f32ed61574531b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/query.js\":\"e44d6f17f8b0723c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/resolveFilter.js\":\"a14bf0eca970d00e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/sourceBatch.js\":\"43b9726c164c4ba3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/sources.js\":\"fb708368544a0156\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/useBacklinks.js\":\"d642200bfd54a0c1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f6a5d8594b805626\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/BirthdayCelebration.js\":\"5da5c287cde78644\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/BirthdayOverlay.js\":\"d360633ba44e2ae7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/gate.js\":\"9fe57a306d156fe1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/index.js\":\"0dfdb2101a32e5f9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/birthday/wolfTheme.js\":\"0a683c38040153d9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/BlockDragLayer.js\":\"050c8d37b864b998\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/dragController.js\":\"8997cf93183e1fac\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/dropTarget.js\":\"cdddc512a8c9fef3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/index.js\":\"c991ee267dc62488\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-drag/projection.js\":\"e8b7de50bf8dfce8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-info/BlockMetaCard.js\":\"a06797f55262b3ae\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-info/index.js\":\"64d6d5601ccff587\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/AddTagDialog.js\":\"50fc4baf9d2ae529\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"88984e5bae1a3a31\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/TagNameIssueHint.js\":\"c12654b51480fdeb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/addTagAction.js\":\"519c58a473e637b4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/appendTag.js\":\"a5984b9b2a725ca7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/config.js\":\"ae618ff7ea0202c0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/dataExtension.js\":\"588969c4b65ed695\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/index.js\":\"c2916ded10f6e428\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/block-tagging/propertyEditorOverride.js\":\"71a1a36e39b7ad5e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/BreadcrumbList.js\":\"64d04625c7d08e1c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"83be43471e54f7f0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/Breadcrumbs.js\":\"bf313bbdefea0d1f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a25d0d27077fc962\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"957a45bc678ae7a5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/index.js\":\"fff0a286bc923704\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"515c85f7a4b600ed\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/CharacterCountItem.js\":\"2c25a3b0f3ee6e2d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/ProfilePropertyEditor.js\":\"298d6cd731164338\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/actions.js\":\"f311cdf85e37eaab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/blockType.js\":\"5f30e0ee6a6ac078\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/charCount.js\":\"45a4768318913fb6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/dataExtension.js\":\"33ad2954c459b3fd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/index.js\":\"f8086930864ff741\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/profiles.js\":\"6a4f0710fc235121\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/properties.js\":\"d0e07e150ae65eb6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/character-counter/textCounts.js\":\"bdfd31547a11947c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/colemak-keybindings/index.js\":\"55a48470972fc77b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/CommandPalette.js\":\"857efec7d79fdef4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/HeaderItem.js\":\"fde311d44e39cf27\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/context.js\":\"683e9c5521da3ae4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/index.js\":\"ca80526833f08df1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/selection.js\":\"00d65c3323b3af8b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/toggleStore.js\":\"9ab2730cc2140b6c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/command-palette/useCommandPaletteActions.js\":\"756fa99125d1be54\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/ContributorBadges.js\":\"adba9d61b264b45d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/author.js\":\"6729aa8e07254bb9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/codeMirrorExtensions.js\":\"842848c1a01a827f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/dataExtension.js\":\"ee9b2e11f085bac8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/index.js\":\"acde7f1420fd26c1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/mentionAutocomplete.js\":\"b2cdc765eeac89d5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/processor.js\":\"e33f0d901cf96e0d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/profiles.js\":\"a68c4d66bd9c7334\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/queries.js\":\"d04e17c5658178d1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/contributors/schema.js\":\"8ec2f917edee60a5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3bf44952b9c53afa\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f0d7b47bac141608\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/index.js\":\"753b08db4ddf8357\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d30751001d8adc14\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"72bca130cbe12596\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/CalendarGrid.js\":\"97c7b2e7bb54d779\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/DailyNotePicker.js\":\"964baca6bc25db40\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b405616ed1d43e09\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/DateNavDecorator.js\":\"720986da9aa1258e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/DateScrubOverlay.js\":\"a0dcb338736e37b8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/HeaderItem.js\":\"9c3f6aff4a8849b1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/ReschedulePicker.js\":\"0d6c29230ec8d6ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5f9563057007b153\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/actions.js\":\"d053c7c04297e378\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/blockDateAdapter.js\":\"8249039d764dde80\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/calendar.js\":\"f9bad7e178c48393\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dailyNotes.js\":\"12de8ab47cd86ec6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dataExtension.js\":\"30e934d3d773082a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dateScrubActions.js\":\"6a129b3126e475aa\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dateScrubGesture.js\":\"2aa77229b779908f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0825827add5bff81\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dateScrubRecognizer.js\":\"95432599532b127f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/deletionGuard.js\":\"343c690b0858fc9e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/dueQuery.js\":\"974c1f32b17df3b5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/index.js\":\"1a1649010a66afc8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/landing.js\":\"bf607aa0393bb9be\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/localSchema.js\":\"6e190f1682a3ba63\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/referenceDateAdapter.js\":\"24557a3556df7052\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/rescheduleAction.js\":\"2aec67f78496b61b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/schema.js\":\"d51b3bb887bd7500\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/spreadBlockDates.js\":\"187c5c4ad1d9f312\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/spreadDatesAction.js\":\"55dd73ccff9ab7a1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/today.js\":\"f4ad7c8bd54659a0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2b507d1bd90ebdf6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e2d49019264c4ce8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/audit.js\":\"04463df98fba313f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/auditAction.js\":\"fa66934d979ddb0f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/auditRanges.js\":\"9f0c2a4124c465bb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/diagnosticsSource.js\":\"3ddc0e19aa660e5b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/divergenceScan.js\":\"5f97bc487fba2c81\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/index.js\":\"2c1e5b8c0e7ef3d8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/propertyChildrenChecks.js\":\"02ddb317b3a5c476\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/referencesMirror.js\":\"9aeb876dc5cc86d5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/rowJson.js\":\"347045bb89ab33a0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/schedule.js\":\"6eeda7ef6f5a473e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/data-integrity/store.js\":\"407b7c8bddd0abc1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-maintenance/action.js\":\"31c3efcb57b64fd1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-maintenance/index.js\":\"4c838f8249a7dc44\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-maintenance/plugin.js\":\"c48db998b639e3cb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f38d626ab57b6a11\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/actions.js\":\"3f209b02ece595d6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/changeMarker.js\":\"f1708f6bfc799b0c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/diagnostics.js\":\"c290f2674aafcc58\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/fileSystemAccess.js\":\"55f839c16732352a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/filenames.js\":\"e504ebdfda73b4dc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/index.js\":\"2c938bb4c3be7c46\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/mirror.js\":\"b2a3c8d7d2ca83bb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/runLock.js\":\"7aeceaee855babc0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/runtimeHealth.js\":\"29da0f8c5c7b9202\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/schedule.js\":\"d716a0abfb63a49b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/db-mirror/store.js\":\"c92fdfbd367fba41\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/default-themes/index.js\":\"c3c7db95b133d430\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/default-themes/themes.js\":\"fea534de99cf65f4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/diagnostics/facet.js\":\"639dda95bc0f0a7a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/diagnostics/useDiagnostics.js\":\"4c2c26dc5be5f5b8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extension-prompts/dismissals.js\":\"020d9b8fe4be81c2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extension-prompts/index.js\":\"af25d7b72c469943\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extension-prompts/status.js\":\"c4a8e0c03b08b543\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extension-prompts/store.js\":\"cf7103ed9f1c5172\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9b2b44deb95932f0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/ExtensionsSettings.js\":\"65df49f6fba0a3ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/actions.js\":\"a9e302ac24121859\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/config.js\":\"5d07dd38c8ba65b8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/dataExtension.js\":\"d44572089249cc0f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/effect.js\":\"ce04320f634442d7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/index.js\":\"f28b55eb786a2c7c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f78d957e7e94fae9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extensions-settings/useToggleTree.js\":\"9b420de21d287467\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/ExtractTypeDialog.js\":\"30a04bc15d4f90f7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"a8526ba70d43c44d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/PropertyShapePicker.js\":\"062f61fff023dc03\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/action.js\":\"fcbeae983c5d90d7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/extract-type/index.js\":\"78e532083844ea73\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/FindReplaceDialog.js\":\"fbf5d604597f2590\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/HeaderItem.js\":\"a9cecb645269feb8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/dataExtension.js\":\"9d3d66f9bba3b1c1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/index.js\":\"839b0b34326f0163\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/search.js\":\"29aa9acad830f912\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/toggleStore.js\":\"cf1f2ab9034a5200\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/LocationPropertyEditor.js\":\"59b5a6a493237278\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/MapView.js\":\"3352807d4a3c355d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/blockTypes.js\":\"40e405bb59907ad7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/codeMirrorExtensions.js\":\"a8478833f6db14cb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/createOrFindPlace.js\":\"89b047e69000c776\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/currentLocation.js\":\"0a122fa041723a73\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/dataExtension.js\":\"79d1366ce70eb696\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/geoContentDecorator.js\":\"b4aaffa30ba14977\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/googlePlacesClient.js\":\"2abd7f8a18724e1f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/index.js\":\"ef39565549696b3d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/locationsPage.js\":\"675a6506a28d97fa\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/mapViewport.js\":\"59a91cfa09d719db\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/pickCurrentLocation.js\":\"0b91b7365f5a8522\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/placeAutocomplete.js\":\"76b79e7c1643fdab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/placeNameCollision.js\":\"280ebba92dbc478d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/properties.js\":\"85d6d1a690c110e1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/propertyEditorOverrides.js\":\"d879c82da7f762f2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/query.js\":\"90a77a4ae9e96d1d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/geo/usePlaceSearch.js\":\"b68f7d9a59f23b38\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9476bde58a1f489e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a08154a4fbf7d0ff\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"54b8db74fcda1e1f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/config.js\":\"676de3cb27f7c749\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/dataExtension.js\":\"21ab6382bf5e39f8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/facet.js\":\"1f3c9d42a4624673\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/grouping.js\":\"299dbecea9e50e13\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/index.js\":\"7cd46f805f100dae\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c4f3dda60c085d8c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/query.js\":\"536228f552fd1130\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/resolveConfig.js\":\"5dfb27c214977619\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c30c898d60afc901\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1f453938fd59a734\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/HtmlDocumentContent.js\":\"c0db964c4ee87292\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/HtmlFrame.js\":\"b491a8fa95b3e37c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/actions.js\":\"75522ab52b6538d1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/blockType.js\":\"e778f69f7fa01060\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/confirmRunScripts.js\":\"5c64f57ebaeb6827\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/dataExtension.js\":\"5eb417eed65ee967\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/frameAnnotations.js\":\"ba887ea28f0be83c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/frameDocument.js\":\"17c7f760fe3fe4e8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/frameTheme.js\":\"4468d7048e578d0f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/index.js\":\"da875be4a6213f1c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/scriptConsent.js\":\"9ca12e164b2be1e4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/sourceMap.js\":\"a5432b4ef7b865f7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/html-document/useDocumentScripts.js\":\"0b7c4cb4174ceead\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/index.js\":\"b4d2e2bafddf6c85\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/record.js\":\"3d76db509a5ac0a8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/recordStore.js\":\"b66364c49a10ef25\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/responsiveness.js\":\"54e9057933e63d9d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/schedule.js\":\"01cb4394baaabbc4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/interaction-metrics/sessionContext.js\":\"6a619f95a787e581\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"84bfba9923f5040b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"50564e5319ad9c64\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/actions.js\":\"1d687a17865e419b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/config.js\":\"649448d1ce586b37\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/dataExtension.js\":\"112932ed677bada6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/effect.js\":\"31a8d97483f9bcf9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/index.js\":\"15da3c1fb598d060\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/keyCapture.js\":\"cbacf7aab0932965\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/overrideStore.js\":\"d0908a648526d838\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4e1b9ef3a1f561c5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/HeaderItem.js\":\"d41ac63278953497\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/LeftSidebar.js\":\"d62f82ca3a425152\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/actions.js\":\"dd3597ae980bb908\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/facet.js\":\"7d71d888e348b503\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/index.js\":\"a495313f74185acf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/shortcuts.js\":\"7075a43001ddf3cf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/left-sidebar/toggleStore.js\":\"9fcd11399b9732c8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/merge-blocks/MergePicker.js\":\"c2cf94ecd4085e93\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/merge-blocks/index.js\":\"047142326d0e0e26\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/merge-blocks/mergeAction.js\":\"022fce7ccdd5c193\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/merge-blocks/strategy.js\":\"55755d7f00d69828\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/Button.js\":\"712179da9e9f6a47\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d53644c37f202c9e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/defaultItems.js\":\"46485751d7d7e96a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/facet.js\":\"7dc898fa399d5d36\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-bottom-nav/index.js\":\"373c39457ee5a773\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c0e7eb8de14e604e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c0b230a80b060ed0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8b2ec97e47b50bd5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c3fae14345086820\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/mobile-keyboard-toolbar/index.js\":\"0e428ecc91b2b867\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/MoveDestinationPicker.js\":\"69c70125da593913\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/blockSubtreeMembership.js\":\"46b62856e6b6a6d6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/contextMenuItem.js\":\"676efd3ee8a24fa9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/index.js\":\"ccf32161f9a15535\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/moveAction.js\":\"aab93bf2cbfaeb21\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/moveBlocks.js\":\"5fba8f83c28130a5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/move-blocks/selectionAfterMove.js\":\"2161bad1aae8a73d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/TutorialBanner.js\":\"87f91318e317c14a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/action.js\":\"faa40d74595b9887\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/bannerDismissal.js\":\"6668d89885a4dccd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/documents/cheatSheet.js\":\"3485ba9bc06054cd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/index.js\":\"41959bc07aa5b600\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/keys.js\":\"86533a40356acc93\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/landing.js\":\"0031991990a36af5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/outline.js\":\"9a464c57d0d23c60\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/onboarding/seed.js\":\"49b4e49e982a092b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/PerfTrendDialog.js\":\"75e260593d2915e7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/analyze.js\":\"0c1694632e1bf061\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/diagnosticsSource.js\":\"5dc2795a08647a06\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/index.js\":\"b9764ee3ddfc933f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/load.js\":\"41eced5547a0857d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/monitorRun.js\":\"bf51fab3b1edbefd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/schedule.js\":\"77621ba62611ebdf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/series.js\":\"7befdca7ffc73c64\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/store.js\":\"b77a7af2f65f627d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/trendAction.js\":\"fd336be109f125ab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/perf-monitor/verdict.js\":\"d86fe35b8b02f93d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/plain-outliner/clickToEditAction.js\":\"b26dbbd50efb894b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/plain-outliner/index.js\":\"a464e12ba6315aaf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/plain-outliner/interactions.js\":\"eedae79c9dd9d073\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"39aa8da53159a665\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/MigrationGate.js\":\"b887a7f2acce0f55\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/MigrationGateDialog.js\":\"9a71732bbb367ce9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/action.js\":\"da67ff6256833d2c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/index.js\":\"318e4db9862c22d8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/localRunMessage.js\":\"48a42636c649be9c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/plugin.js\":\"1ed6c84238520d4c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/progressReport.js\":\"3a98f48f61dc883b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/properties-migration/sweepProgress.js\":\"d1c8be4b7d40b39e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/FieldRowRenderer.js\":\"68cf5b9e74a4cdb3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/ValueRowRenderer.js\":\"3f6d432a0b0f8b2b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/actions.js\":\"881f429b7063fd36\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/autocomplete.js\":\"200980a61b0e96da\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/fieldRow.js\":\"8a36f6402fa62b73\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/index.js\":\"6778b8729c91345c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/referenceWarning.js\":\"b6b9eee42f92f1cb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/valueAutocomplete.js\":\"da2277a448baaa9e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/property-rows/valueSchema.js\":\"9539571157713848\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/HeaderItem.js\":\"162d28ea8e962fad\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/QuickFind.js\":\"54f7869732bea4de\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/index.js\":\"69de7dc912f545e9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/recents.js\":\"58e03a2263d561fb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/resultItems.js\":\"c686eb2dd1a6a228\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/selection.js\":\"094f2570ca1d1bcd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/quick-find/toggleStore.js\":\"5f92762ec10b7b5a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/HeaderItem.js\":\"9d79ee5fdcc1aeb6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a5be61a817299bfb\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/grouping.js\":\"a6c1147cffecf2d8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/index.js\":\"bf8adb132335d2ef\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/recents/target.js\":\"9ede10a6c8149249\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/codeMirrorExtensions.js\":\"1db756bfaa95a33c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/contentPrefill.js\":\"91a17d5efccac6c5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/dataExtension.js\":\"619e7b7a862e5663\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/index.js\":\"f7eb43f074dc7149\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cb74fef5aa5f0985\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/invalidation.js\":\"1b7ed5d6a4440de6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/localSchema.js\":\"08f9f7162cc3ac48\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/blockrefs/index.js\":\"11edbf16e26dca46\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"82eeabe690ba8a13\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/index.js\":\"b7732f6130557331\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/referenceNode.js\":\"efda1a22c4bb2abd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/remark-reference-occurrences.js\":\"441d273d27147619\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"8c09cb27db4aa03b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/wikilinks/index.js\":\"d25330564b47018a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a0804e4355bb5ab1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d93c7e6603dc214c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/mergeRetargetProcessor.js\":\"41f3fd028511590d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/parseFence.js\":\"d986a33bedd34294\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/referenceParser.js\":\"75f5c7202df63313\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/referenceProjection.js\":\"790610ad8e830362\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/referencesProcessor.js\":\"272013dfda350008\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/renameProcessor.js\":\"3c747abd2c976a0a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/references/spanReplacement.js\":\"bd1304a8af0aa471\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/rich-paste/htmlToOutline.js\":\"b6747ea68fce8432\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/rich-paste/index.js\":\"31aca525f7c6a657\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b2072b437907759c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/rich-paste/pasteDecision.js\":\"6a2315ed0b707156\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/action.js\":\"f73e71fcdecbca53\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/blockIds.js\":\"553840e779eb009c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/content.js\":\"762b8b5769b1b61c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/effect.js\":\"0fefec65b9fc2a00\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/ids.js\":\"fc1825f3a64d3572\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/import.js\":\"98d120c1a8612508\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/index.js\":\"9c30248938f66b5f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/plan.js\":\"1e68bb58992312ee\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/plugin.js\":\"0c36679db0d6b5fc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/promotion.js\":\"7ede0558ad5a3034\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/properties.js\":\"0171627fb11e345a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/references.js\":\"bd96e427f257d565\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/report.js\":\"7de60e3e2a3e5dac\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/roamMemo.js\":\"4ba1ef657aaf2c99\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/runtime.js\":\"cb02847858a46edf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/schemaReconciliation.js\":\"7f9ed11da793de39\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/srsMarkers.js\":\"10ad13e7a0b80375\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/todo.js\":\"df207414ac0ab37a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/typeCandidates.js\":\"c3946a405ff2089d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/roam-import/types.js\":\"6272720e230e8551\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/search-health/index.js\":\"7850e28e42854f8e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/search-health/store.js\":\"e95f9415551165c4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/HeaderItem.js\":\"cc3d86838fac63b0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f8a6699f6528ce67\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/index.js\":\"c437f0b6ab924219\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/model.js\":\"20b68aa667d7e631\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/toggleStore.js\":\"0f1469bd6315c234\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/shortcut-help/useKeyInspector.js\":\"227dc2b2de62bc18\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"b121edfa954f4c4f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/ShellDecorator.js\":\"2f8f0d8710565f37\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/actions.js\":\"319bc2ac3f825cce\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4db0621ac0933ee8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/index.js\":\"eb776933e655700a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/shell.js\":\"3bd9bf2e794a87dd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/surface.js\":\"396dc6b2f87a7565\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/spatial-navigation/walker.js\":\"4750f5afafb52ca7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ef0de121961a0d99\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/dataExtension.js\":\"378a78c9126a23c3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/index.js\":\"8bc440bc51a6c7be\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/indicator.js\":\"db42e31ff51d9b49\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/moveSrsState.js\":\"d2177412723a3cc3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"16b294bf65c3f60e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/scheduler.js\":\"cfe97f1dee85f95e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/schema.js\":\"d2e97a19c047a5e5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"83905f745824474f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/srsClipboard.js\":\"f0ac63ac39df42c0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"826c78fd158f7a00\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7eb33b561285a93d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/DeckPicker.js\":\"cca93036b22598d9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/ReviewControls.js\":\"e6782b35d3f1f69d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/ReviewDeckRenderer.js\":\"25716b4d62a6313f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/ReviewSession.js\":\"fb6c311d88445a2b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/actions.js\":\"6f610372ee23fed6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/archive.js\":\"f040a541332c826b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/dataExtension.js\":\"fd44d906f8c22195\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/deck.js\":\"3b902825b15fb090\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/dueQuery.js\":\"76c532f068bd565a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/gradeDecision.js\":\"113cfd2e0e522f86\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/index.js\":\"8650a9bf8b7cdf4f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/keyHints.js\":\"67c73ca5e9727dc4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/reviewCardLayout.js\":\"6e41083d7e501f43\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/reviewProgress.js\":\"1a3cca4b57136407\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/schema.js\":\"bd61b80c9f11c977\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/srs-review/useDueCards.js\":\"ba6e6402e3f2d87d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/startup-metrics/index.js\":\"eb171ae5207c5b0f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/startup-metrics/record.js\":\"fc643eaadeb1e719\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/storage-persistence/index.js\":\"fe7c453c78585884\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/storage-persistence/persistenceStatus.js\":\"fd4ca3873aa9809b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/storage-persistence/requestAction.js\":\"fffec962f801ebab\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/supertags/TypeChipsDecorator.js\":\"90d8cb62729572cc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/supertags/codeMirrorExtensions.js\":\"5211ec03ef30347f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/supertags/index.js\":\"81239bd94399e8da\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/supertags/typeAutocomplete.js\":\"31b804d9054e9863\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9e5c54e8121665da\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/actions.js\":\"c2932de20a62d41f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/anchor.js\":\"f14b0ff59ad3283b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/events.js\":\"5b8a2b670a41b909\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/gestureActions.js\":\"b721c2e0dd9e7603\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/index.js\":\"38e9ff7c9469f511\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9c3bff0235f89e6e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/sync-metrics/collect.js\":\"0298456b315b92c1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/sync-metrics/index.js\":\"d55a81afb8a66b73\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/sync-metrics/record.js\":\"84a3edaf620df667\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/RejectionDialog.js\":\"4e5891eb85c13700\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/SystemStatusHeaderItem.js\":\"91b0239ddc694f6d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/index.js\":\"9c8b3b3530da49b0\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/model.js\":\"21e2649947e72b4d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/queueCounts.js\":\"42a0a0635889b2b1\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/rejectedHelpers.js\":\"ba8c92d5f21f0f2a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/rematerializeAction.js\":\"d4e02a396918b464\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/system-status/useHysteresis.js\":\"df1266ce896cbb9d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/ColumnHeaders.js\":\"33cd9866325f4bf4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/QueryUi.js\":\"d1a5d99eb6051a32\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/TableLayout.js\":\"45e27fdbc26ccb41\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/actions.js\":\"72d47ca3b094dbcf\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/cellEdits.js\":\"d779a1ecbc7e7080\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/columns.js\":\"d969ec16fbc9a3e2\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/controller.js\":\"4fd92ba333ee93fd\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/convert.js\":\"0d56938540160f4a\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/dataExtension.js\":\"a5ae5dab9fa15ca5\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/index.js\":\"2b63306fe6fdfc03\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/keys.js\":\"d3a06b1e1debce06\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/model.js\":\"2caff6ea81370bad\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/backfill.js\":\"5efb9faec3278876\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/format.js\":\"67ace1c9efa77591\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/parse.js\":\"0bf938f8376361dc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/queryValue.js\":\"6eec3611641ae43f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/query/source.js\":\"91f068b5fedbac5d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/registry.js\":\"b375335275621c3e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/schema.js\":\"ec03b6d8600c6f69\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/tables/sort.js\":\"4d086b1cba1f72f3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/theme-toggle/effect.js\":\"cf48077f64a399fc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/theme-toggle/index.js\":\"17e88105b211fe0d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/theme-toggle/theme.js\":\"eabbd39dddd8ad6e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/todo/actions.js\":\"2090c75c8dd017fe\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/todo/dataExtension.js\":\"2da7233a6c14001d\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/todo/index.js\":\"2af6492f678acd0e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/todo/schema.js\":\"c529c3e922cd3dfc\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/TouchSelectionLayer.js\":\"00b1c30049c37cd7\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/actions.js\":\"0d7bed857bef42c6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/defaultItems.js\":\"df0293c1b5236282\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/facet.js\":\"d10302dfaabc8ed4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/holdRecognizer.js\":\"5238bd825d1368c4\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/touch-selection/index.js\":\"73e90000d61a6f76\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/update-indicator/UpdateIndicator.js\":\"a3e6f40c63ed0d1e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/update-indicator/index.js\":\"28e1731bcb1a5d79\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/update-indicator/loadTimes.js\":\"126e92be2ae2060e\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/VideoNotesRenderer.js\":\"a451eeb26c5b9182\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/VideoPlayerRenderer.js\":\"3e5da7f12895cb03\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/VideoTimeStamp.js\":\"db2e732403f81408\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/actions.js\":\"c1edfa75a1b3787f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/index.js\":\"32c3e2cea6c00c23\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/markdown.js\":\"5a431b6220b81ca9\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/notes.js\":\"ff9d34712ad545b6\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/registry.js\":\"891c77f352219e13\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/remark-timestamps.js\":\"6485d0b34294673f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/video-player/view.js\":\"a07163a6c76dda99\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-link-hints/LinkHints.js\":\"ccc1cba8a857518b\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-link-hints/index.js\":\"8a945ebc98a3b7d8\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-link-hints/model.js\":\"b6bc6ade5d70a098\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-link-hints/settings.js\":\"4bc996a18a0afa8f\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-normal-mode/actions.js\":\"5389d102e5ba52f3\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-normal-mode/index.js\":\"a4eabff08b0c5c95\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/vim-normal-mode/interactions.js\":\"9d50feaaffadb28c\",\"/knowledge-medium/pr-preview/pr-1839/src/plugins/workspace-header/index.js\":\"290c0e446b9301e7\",\"/knowledge-medium/pr-preview/pr-1839/src/registerServiceWorker.js\":\"3953d04848f95e1b\",\"/knowledge-medium/pr-preview/pr-1839/src/requestPersistentStorage.js\":\"6e858367545d981d\",\"/knowledge-medium/pr-preview/pr-1839/src/services/authRequestDeadline.js\":\"d41ff25ef6f9b002\",\"/knowledge-medium/pr-preview/pr-1839/src/services/authStorage.js\":\"8d8644837bc9dec4\",\"/knowledge-medium/pr-preview/pr-1839/src/services/powersync.js\":\"1974f9e739ce553d\",\"/knowledge-medium/pr-preview/pr-1839/src/services/supabase.js\":\"11588d7b02db2ed3\",\"/knowledge-medium/pr-preview/pr-1839/src/services/uploadErrorClassifier.js\":\"acca87f2652253bc\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/ActiveContexts.js\":\"64c3245e1ab2881b\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/HotkeyReconciler.js\":\"0779a9823b134753\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/WipeLocalDataDialog.js\":\"83e0e7ffe6030818\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/actionDispatch.js\":\"940fbca71b02f0fb\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/actionRefItems.js\":\"b2d0327a21c3f88a\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/applyKeybindingOverrides.js\":\"8992964744c9fad0\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/blockActions.js\":\"b7677f5f265db3e6\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/canonicalizeChord.js\":\"6f12a3ac767a5a56\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/defaultContexts.js\":\"91ae019232f39f56\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/defaultShortcuts.js\":\"5e87117047694ef3\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/effectiveActions.js\":\"af586f3b8d4868c2\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/gestureAction.js\":\"202fd3d82f310d1d\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/gestureBinding.js\":\"42a8841a976d672a\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/holdRegistry.js\":\"4cac881633e30094\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/keybindingConflicts.js\":\"73ab69a21aa60c63\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/keybindingOverrides.js\":\"f350b59619167995\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/pointerAction.js\":\"d3660e6531b770c9\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/resolve.js\":\"d9481deae9745457\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/runAction.js\":\"e086c57b79286c71\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/sequenceMatcher.js\":\"78deae923329b9f2\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/types.js\":\"53b19215f4fb5b46\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/useActionContext.js\":\"d4312a74e517354f\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/useActionDiscovery.js\":\"c6c49dad8d59344b\",\"/knowledge-medium/pr-preview/pr-1839/src/shortcuts/utils.js\":\"e456d66c8ab08dc5\",\"/knowledge-medium/pr-preview/pr-1839/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1839/src/sw/bootStore.js\":\"f4282812c88a1677\",\"/knowledge-medium/pr-preview/pr-1839/src/sw/previewDatabases.js\":\"2d31050e69f75069\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/byteTransform.js\":\"0694adaf4b72347e\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/attachmentCleaner.js\":\"f684ad1135d97c70\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/attachmentParts.js\":\"aad36c5e1e2d3a38\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/bundleParts.js\":\"19dfb981916c31fb\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/bundleRecord.js\":\"1025685fc9aaa2ab\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/manifest.js\":\"297191bb50b20746\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/takeBundle.js\":\"3eee25523b30a890\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/bundle/verifyBundle.js\":\"d0999de81c08ce07\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/cleaningStage.js\":\"3bacadfec9fcb065\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/conversionKey.js\":\"f303db62b6d92ae8\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/conversionServer.js\":\"214abd83b966aa4f\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/flip.js\":\"b5bc6bbb478bdb2e\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/flipAttempts.js\":\"13a2d51adff4ae42\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/pages.js\":\"2f16085895da78bc\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/preflight.js\":\"2f1d477de5de9471\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/reseal.js\":\"da9f32d536a331ab\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/runConversion.js\":\"096e0dc7b5f6a8d8\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/runLock.js\":\"403ac6247ca2dd1d\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/sealing.js\":\"b2f2df4724ada8c5\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/sealingStage.js\":\"2d3ed877d2b14351\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/stage.js\":\"6b84bf03fdaa4b70\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/conversion/verifyReseal.js\":\"42e4e5a6b3493fd9\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/aad.js\":\"bcc4670d8824edda\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/aead.js\":\"d14c1ac52f3f5aed\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/base32.js\":\"d3377a8e2354ce90\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/base64url.js\":\"1595333eb0cb5a0f\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/binaryEnvelope.js\":\"ae2c46c90fd12226\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/byteAead.js\":\"192b28d0cce6fc8c\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/canary.js\":\"74951faee45b2b65\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/contentHash.js\":\"9987c7daad2b69c6\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/contentKey.js\":\"db648395f2a06906\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/derivedIdNamespace.js\":\"50a7cb35c5c09746\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/envelope.js\":\"a4a06fcf5b15f746\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/hex.js\":\"530e2f28c100e2c8\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/sha256Hex.js\":\"fb41b698eeae93fe\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/crypto/workspaceKey.js\":\"c298ee175703ad55\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/conversionState.js\":\"ffbb68382f6ea17e\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4126a9ab56c5d3c7\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/flows/pastedKey.js\":\"b89887e767285626\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"28e8f5a0a4afa2da\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/flows/upgradeWorkspacePin.js\":\"100536a1aee1ac2e\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/keyStore.js\":\"37348665b385df53\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/mintWorkspaceKey.js\":\"34b434c52c4d5668\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/modePin.js\":\"3c06892edf9c17cc\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/openWorkspaceKeys.js\":\"695a965ba2f09b39\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/resolveWorkspaceEntry.js\":\"411a6931d4184331\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/resolver.js\":\"0a14d053231b0a86\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/keys/workspaceAccess.js\":\"f68921f6ad5b700c\",\"/knowledge-medium/pr-preview/pr-1839/src/sync/transform.js\":\"738bf73792ec80ff\",\"/knowledge-medium/pr-preview/pr-1839/src/themeBootDefaults.js\":\"26a9675f61827199\",\"/knowledge-medium/pr-preview/pr-1839/src/types.js\":\"3d5d8ed70f2f6ff5\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/ClientLocalSettings.js\":\"04148351ac172a6b\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/abortableSleep.js\":\"4d97e24744b2f5fa\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/array.js\":\"87841ed055674a1a\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/backlinkAutocomplete.js\":\"66b07466df6278c1\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/blockCrumbs.js\":\"1b584133c33da360\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/blockrefAutocomplete.js\":\"4cedaf2cbfa8a852\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/cadencedIdleJob.js\":\"29baba16519a30a4\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/callbackSet.js\":\"26d6dd0c15be8608\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/clientId.js\":\"01aac2eebb467387\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/codemirror.js\":\"939cd0bdbd0a0e57\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/codemirrorCompletion.js\":\"f6e0cde8ccbbd0df\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/copy.js\":\"48b7ca300130c9ad\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dailyPage.js\":\"e2cd8cc37675bfc6\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dbForensics.js\":\"db53abcf81d37fbb\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dbForensicsHooks.js\":\"d1c7200c19c36d3b\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/deleteBlockThroughUi.js\":\"c0d6a45fc79260f0\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dialogs.js\":\"161688b2be63ae2c\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/dom.js\":\"4346d53813d1ba0f\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/downloadBlob.js\":\"edbfbb7d25cd99fa\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/exportSqliteDb.js\":\"e210be3774860e5f\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/fileSystemAccess.js\":\"93a3015d4115ce59\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/flipSlide.js\":\"6609610635260b42\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/fnv1a.js\":\"763286a9063f2fbf\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/formatBytes.js\":\"1b6ba3cf96ec1aa8\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/fuzzyRank.js\":\"601266811425c2d2\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/idbKeyedStore.js\":\"82592b778f511c4e\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/idleCallbackPolyfill.js\":\"fa5936b830cdc14d\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/keyboardAwareScroll.js\":\"513e14d6f705c7ac\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/keyboardViewport.js\":\"8094bb43f84f342f\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/lastWorkspace.js\":\"6da570c9e3bc7cc1\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/layoutColumns.js\":\"4c8e1cb333664572\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/layoutSessionDom.js\":\"fe1d91328a5fd190\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/layoutSessionId.js\":\"6c95bcea355c85c6\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/linkClickGestures.js\":\"d9393b781ce36e1f\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/linkTargetAutocomplete.js\":\"91e442f4a0d7d7e5\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/localDbCorruption.js\":\"3cdd707e2ea9dc59\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/localDbRecovery.js\":\"3c5a8ea746f08987\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/markdownParser.js\":\"26b0458bacf90524\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/memoize.js\":\"cca1f43988a14059\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/nameFieldCommit.js\":\"ddc6b731ab2db6fe\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/nameList.js\":\"6faba9b68e96389b\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/navigation.js\":\"a08f0bb5b6ab3436\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/omnilinerNamespace.js\":\"a4f990fd165fb343\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/opfsPageScan.js\":\"6981e969b1b32165\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelClearance.js\":\"98c99d52612f8223\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelHistory.js\":\"de1c78675a2238ef\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelLanes.js\":\"702b78cb13758e62\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelLayoutProjection.js\":\"c440900b5b0febeb\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelScrollAnchor.js\":\"485e6a93acc1c9bb\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/panelUrlFlags.js\":\"3368b6fe553bec17\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/platform.js\":\"e3a3d937874f63da\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/pluralize.js\":\"486ce641b25d3195\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/propertyCreation.js\":\"85c313bb64c3289f\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/propertyNavigation.js\":\"1c5db21b1126bd25\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/propertyValueContext.js\":\"b17089154bd9b431\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/react.js\":\"9b8bd81d085dc555\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/relativeDate.js\":\"697021d462194154\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/relativeTime.js\":\"2ab5d42247bf0f92\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/renderScope.js\":\"6b75613cd0361a36\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/resolvedThenable.js\":\"ba575cf6092d8dd9\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/routing.js\":\"8829fc9a40979d9e\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/safeMode.js\":\"85956099ccd76fda\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/scheduleIdle.js\":\"7a7dc0bc340c5846\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/screenWakeLock.js\":\"3c701682b827e923\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/selection.js\":\"45f9352fea364f8a\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/softKeyboardGrab.js\":\"6591dc341dc8812a\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/startupTimeline.js\":\"858294413bbea6c3\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/state.js\":\"58d34f40b2aa8110\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/string.js\":\"80953e901cc577ae\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/surfaceZoom.js\":\"6ba73c7499163c53\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/time.js\":\"29450e78c9b4e47d\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/toast.js\":\"5a5fc2d23a7b5993\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/toggleStore.js\":\"2674e8803054cd8a\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/untilStopped.js\":\"c8195fa01de2e77c\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/userActivity.js\":\"1a632e86e8875fa3\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/viewTransition.js\":\"636576230214e2cb\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/viewport.js\":\"6b33df636336b62d\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/webLock.js\":\"f70eb44362965766\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/workspaceRecovery.js\":\"5dab96efc6426429\",\"/knowledge-medium/pr-preview/pr-1839/src/utils/workspaceSnapshotStore.js\":\"84631dff65978948\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-compiler-runtime.js\":\"41e2cf634f751bbc\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-client.js\":\"1259eafbb06e1c74\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-server-edge.js\":\"3153ee3e28cd306e\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-server.js\":\"8192fdf2b666f291\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-static-edge.js\":\"88aea096c9c9ccc0\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-static.js\":\"aa4015a5a8caf165\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom-test-utils.js\":\"2ddccb6e97ce9012\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-dom.js\":\"a824c3ce317a479b\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react-jsx-runtime.js\":\"02b93da78793637b\",\"/knowledge-medium/pr-preview/pr-1839/src/vendor/react.js\":\"e9a2822d7b71e9aa\",\"/knowledge-medium/pr-preview/pr-1839/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1839/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1839/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
