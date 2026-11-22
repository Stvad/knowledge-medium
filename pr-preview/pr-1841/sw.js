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
		buildId: "417f233f7189-c177ac3e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1841/\":\"c4e471a316d22d21\",\"/knowledge-medium/pr-preview/pr-1841/index.html\":\"c4e471a316d22d21\",\"/knowledge-medium/pr-preview/pr-1841/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1841/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1841/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1841/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1841/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1841/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1841/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1841/assets/FacadeVFS-DgscxRzW.js\":\"a7581b6aab530439\",\"/knowledge-medium/pr-preview/pr-1841/assets/OPFSCoopSyncVFS-DGn0sO7h.js\":\"921bc37959343d4a\",\"/knowledge-medium/pr-preview/pr-1841/assets/OPFSWriteAheadVFS-BXJgMZgi.js\":\"8dd0c25e40e982c3\",\"/knowledge-medium/pr-preview/pr-1841/assets/wa-sqlite-69HqqzeX.js\":\"6e2748115e781c07\",\"/knowledge-medium/pr-preview/pr-1841/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1841/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1841/assets/wa-sqlite-async-BbO1G48J.js\":\"9db02797ad72f1bc\",\"/knowledge-medium/pr-preview/pr-1841/assets/worker-wyzhu4iR.js\":\"0e7e490be8888602\",\"/knowledge-medium/pr-preview/pr-1841/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1841/chunks/app-DOQ4T4iz.js\":\"d3c4796cdb7f2605\",\"/knowledge-medium/pr-preview/pr-1841/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1841/index.js\":\"9446a51530787cc5\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1841/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1841/assets/AccessHandlePoolVFS-Dz7_W96n.js\":\"3a27d51397d35d3b\",\"/knowledge-medium/pr-preview/pr-1841/assets/IDBBatchAtomicVFS-DyHwjhsI.js\":\"d6b8f028df1090aa\",\"/knowledge-medium/pr-preview/pr-1841/assets/MemoryVFS-BImCWWAl.js\":\"bdbc5fe04deca6c9\",\"/knowledge-medium/pr-preview/pr-1841/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1841/assets/mc-wa-sqlite-D4UinwM3.js\":\"6081d8db93d98c8f\",\"/knowledge-medium/pr-preview/pr-1841/assets/mc-wa-sqlite-async-CTIJSUdS.js\":\"5f7b3f035e1f04c1\",\"/knowledge-medium/pr-preview/pr-1841/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1841/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1841/chunks/AccessHandlePoolVFS-Dy-h3iDR.js\":\"31feeb40985b9228\",\"/knowledge-medium/pr-preview/pr-1841/chunks/FacadeVFS-Fm555xi9.js\":\"ba92037f720b11ff\",\"/knowledge-medium/pr-preview/pr-1841/chunks/IDBBatchAtomicVFS-BZSHvCZi.js\":\"bfe4102aa0fe51a7\",\"/knowledge-medium/pr-preview/pr-1841/chunks/MemoryVFS-DhUl8xUj.js\":\"c755e0578648f99f\",\"/knowledge-medium/pr-preview/pr-1841/chunks/OPFSCoopSyncVFS-CNYNa9nE.js\":\"231ca387dd3fc532\",\"/knowledge-medium/pr-preview/pr-1841/chunks/OPFSWriteAheadVFS-CcqNhhfh.js\":\"2d224af1d0786f69\",\"/knowledge-medium/pr-preview/pr-1841/chunks/Preview-Bro0jkYs.js\":\"bd9198f03b100d1d\",\"/knowledge-medium/pr-preview/pr-1841/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1841/chunks/card-By-ZLzcK.js\":\"2de8a71f21ffc794\",\"/knowledge-medium/pr-preview/pr-1841/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1841/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1841/chunks/dist-BK8L5s6n.js\":\"6ac2242fedba0ede\",\"/knowledge-medium/pr-preview/pr-1841/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1841/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1841/chunks/mc-wa-sqlite-C0OYdgW8.js\":\"f57bf4fc69873c89\",\"/knowledge-medium/pr-preview/pr-1841/chunks/mc-wa-sqlite-async-2o5c48W0.js\":\"e560cc8dc16e2ed2\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-BSTg5j4f.js\":\"6ece2f44d3026541\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-BthVsJvp.js\":\"d06323440efe4d1c\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-BuGnIS7t.js\":\"b485a8e754226114\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-CTr0Rita.js\":\"2159baa5387f1d5d\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-CU3wkU3q.js\":\"f3191caf9535f6e9\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-D-Sahz6r.js\":\"ea162425d9830435\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-DYvr9e4r.js\":\"585f4c3e68b33ec0\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-dom-server-legacy.browser.production-DCbTCiAD.js\":\"c55c44212c1c8618\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-dom-server.browser.production-3bcGIXys.js\":\"fd3c31884db6263d\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-dom-server.edge.production-CD11ZpAG.js\":\"f8c61fb562d854fd\",\"/knowledge-medium/pr-preview/pr-1841/chunks/react-tsTfKHD1.js\":\"5766adb0e5534d0e\",\"/knowledge-medium/pr-preview/pr-1841/chunks/server.browser-p4RuK5KM.js\":\"36e0e93a33bdcc3f\",\"/knowledge-medium/pr-preview/pr-1841/chunks/textarea-CxuP4e5q.js\":\"8cbafe4f58241e2d\",\"/knowledge-medium/pr-preview/pr-1841/chunks/ui-zv_Z4AAF.js\":\"d2804cf87ebf7929\",\"/knowledge-medium/pr-preview/pr-1841/chunks/wa-sqlite-BvGVjGOE.js\":\"a5c48f4cbd9f3bba\",\"/knowledge-medium/pr-preview/pr-1841/chunks/wa-sqlite-async-C6M1tieI.js\":\"92a3e33f642e0347\",\"/knowledge-medium/pr-preview/pr-1841/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1841/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1841/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1841/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1841/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1841/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1841/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1841/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1841/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1841/src/App.js\":\"595b3fa58c75b445\",\"/knowledge-medium/pr-preview/pr-1841/src/appUpdate.js\":\"38524319761a579a\",\"/knowledge-medium/pr-preview/pr-1841/src/appVersion.js\":\"9564e285f4b218ec\",\"/knowledge-medium/pr-preview/pr-1841/src/bootstrap/initialLayout.js\":\"4f4580821ba89ad0\",\"/knowledge-medium/pr-preview/pr-1841/src/bootstrap/openWorkspaceData.js\":\"2d2f5fdabe067199\",\"/knowledge-medium/pr-preview/pr-1841/src/bootstrap/resolveWorkspace.js\":\"864a17681b40be70\",\"/knowledge-medium/pr-preview/pr-1841/src/bootstrap/workspaceBootstrap.js\":\"9bd069c51778cecf\",\"/knowledge-medium/pr-preview/pr-1841/src/components/BlockComponent.js\":\"138a31901c0cad55\",\"/knowledge-medium/pr-preview/pr-1841/src/components/BlockCrumbs.js\":\"ed44c6d95af897df\",\"/knowledge-medium/pr-preview/pr-1841/src/components/BlockEditor.js\":\"5bc21bfdd1fd9790\",\"/knowledge-medium/pr-preview/pr-1841/src/components/BlockLoadingPlaceholder.js\":\"91fe2ee63ce35821\",\"/knowledge-medium/pr-preview/pr-1841/src/components/BlockProperties.js\":\"5021361b8214fb96\",\"/knowledge-medium/pr-preview/pr-1841/src/components/BlockSearchPicker.js\":\"9f5958e8054a0c70\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ConfirmBulkDeleteDialog.js\":\"8e333e3e85cf3bfe\",\"/knowledge-medium/pr-preview/pr-1841/src/components/DividerHandle.js\":\"0f73dbaad8f2c48e\",\"/knowledge-medium/pr-preview/pr-1841/src/components/DraftEditor.js\":\"019a2d015686a7c2\",\"/knowledge-medium/pr-preview/pr-1841/src/components/GutterPill.js\":\"89c82cf39e5aa58c\",\"/knowledge-medium/pr-preview/pr-1841/src/components/Header.js\":\"a6294035e2aa3357\",\"/knowledge-medium/pr-preview/pr-1841/src/components/LazyBlockComponent.js\":\"cf992af856d3476f\",\"/knowledge-medium/pr-preview/pr-1841/src/components/Login.js\":\"c1665bab9e518f3d\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ZoomableSurface.js\":\"352d0390f8741d80\",\"/knowledge-medium/pr-preview/pr-1841/src/components/editModeKeepalive.js\":\"c21ce2d2a6a00b8d\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a92f563a7ca95459\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"50d3b1929e1f9a42\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyEditors/RefPropertyEditor.js\":\"0fa3f05638d59ace\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyEditors/RefTargetTypePicker.js\":\"5a99d16bce2ea9b2\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyEditors/SelectPropertyEditor.js\":\"ceb88dec8af9b844\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyEditors/TypesPropertyEditor.js\":\"b4eca3927a3951de\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyEditors/defaults.js\":\"d2565c65cb7182f0\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyEditors/kernelValuePresets.js\":\"66175410b6e66b10\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyEditors/selectablePresets.js\":\"726e90bf00440513\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyEditors/typesPropertyUi.js\":\"1bbafaa78edfa87f\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/AddPropertyForm.js\":\"371de2e55c8ab693\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/PropertyPicker.js\":\"d37fe78a3165c0f6\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/PropertyRow.js\":\"a8d9725c53b7e1a9\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/Rows.js\":\"5f55aacf319db1e2\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/actions.js\":\"e7ca4589aa71b535\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/declarationOnly.js\":\"04de7e8cb59a525f\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/layout.js\":\"623890c828d509e4\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/model.js\":\"c9efa88bead9b74b\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/shapeUi.js\":\"e88b75b46ff1ae55\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/shapes.js\":\"ab16d2f0ca30dc2a\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0e4a3394e2fa838f\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanel/visibility.js\":\"6ba202dddf520c7e\",\"/knowledge-medium/pr-preview/pr-1841/src/components/propertyPanelSections.js\":\"2d0834137477daa3\",\"/knowledge-medium/pr-preview/pr-1841/src/components/references/BlockEmbed.js\":\"195a9f3f9c96eb70\",\"/knowledge-medium/pr-preview/pr-1841/src/components/references/BlockLink.js\":\"4624ded67125d956\",\"/knowledge-medium/pr-preview/pr-1841/src/components/references/BlockRef.js\":\"a60f2c8f12e98da3\",\"/knowledge-medium/pr-preview/pr-1841/src/components/references/ReferenceLink.js\":\"aa4b5c4433c54bc1\",\"/knowledge-medium/pr-preview/pr-1841/src/components/references/cycleGuard.js\":\"0897844a0aeb8a66\",\"/knowledge-medium/pr-preview/pr-1841/src/components/references/cycleGuardContext.js\":\"de41e836d2f86ace\",\"/knowledge-medium/pr-preview/pr-1841/src/components/references/linkInteraction.js\":\"fdaea61030840b29\",\"/knowledge-medium/pr-preview/pr-1841/src/components/references/referenceLayout.js\":\"5ff904998bbab4ef\",\"/knowledge-medium/pr-preview/pr-1841/src/components/references/useBlockRefAncestors.js\":\"d5f36e0a7c8cd9c9\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/BlockGutter.js\":\"c7820bd018e77fa0\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/BlockInfoDialog.js\":\"ff13164354ffe752\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/BlockTypeBlockRenderer.js\":\"11512d7d56278918\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/BulletHoverCard.js\":\"cb2c891d4039d894\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/CodeMirrorContentRenderer.js\":\"d5040ce3ec293f83\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9778724dbc2bb10c\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/ColumnResizeHandles.js\":\"3943297912765f9d\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"aac2db5bb69a5429\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/DefaultBlockRenderer.js\":\"dd4b3b7895f73aa0\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/LayoutRenderer.js\":\"0499dece7a64d3b6\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/MarkdownContentRenderer.js\":\"5a821243a69bf71b\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/MissingDataRenderer.js\":\"2d3268d9ad194ade\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/PanelRenderer.js\":\"771a2003ef5a86b9\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/PropertySchemaBlockRenderer.js\":\"34de1aea6eb76c98\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/TopLevelRenderer.js\":\"0730575c2230c31d\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/blockGutterMode.js\":\"5537b441b1d95733\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/blockTitleText.js\":\"41eed6ecd04c8124\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/fieldCreationKeydown.js\":\"0bf9b3d1998a774c\",\"/knowledge-medium/pr-preview/pr-1841/src/components/renderer/layoutRootContext.js\":\"21ee86c7eb807a9e\",\"/knowledge-medium/pr-preview/pr-1841/src/components/typeChip/TypeChip.js\":\"2afbdaa5f6c6c6ae\",\"/knowledge-medium/pr-preview/pr-1841/src/components/typeChip/chipStyle.js\":\"6c857a8c9e3579fa\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/anchored-floating.js\":\"7b339a379b51ef06\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/button.js\":\"31db53c12cf83447\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/card.js\":\"9c7e6100011a0342\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/checkbox.js\":\"8b1797a58a8c036c\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/collapsible.js\":\"04433ee6c2cc470a\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/command.js\":\"42923235aa3e38f7\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/context-menu.js\":\"6271b4e074a1c399\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/dialog.js\":\"3780cc33e2aa569a\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/dropdown-menu.js\":\"5ffbfab0f41a5f17\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/floating-listbox.js\":\"678e2d7b9b9077c8\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/index.js\":\"aded3634e8aa13ec\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/input.js\":\"f4196fd7ebd7f1cd\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/kbd.js\":\"7bac6d6574f74100\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/label.js\":\"06c06f8c78572879\",\"/knowledge-medium/pr-preview/pr-1841/src/components/ui/textarea.js\":\"71c2494baa94b7c1\",\"/knowledge-medium/pr-preview/pr-1841/src/components/useEditModeYieldKeepalive.js\":\"7b076b8d693b5e6f\",\"/knowledge-medium/pr-preview/pr-1841/src/components/util/BootFallback.js\":\"7177f9860d678b57\",\"/knowledge-medium/pr-preview/pr-1841/src/components/util/FocusedRowLazyMount.js\":\"083b128d5c8f4f96\",\"/knowledge-medium/pr-preview/pr-1841/src/components/util/LazyViewportMount.js\":\"672628ea27b17425\",\"/knowledge-medium/pr-preview/pr-1841/src/components/util/LocalDbCorruptionFallback.js\":\"11f37b890e8b16dd\",\"/knowledge-medium/pr-preview/pr-1841/src/components/util/error.js\":\"1e14823ef1cb5883\",\"/knowledge-medium/pr-preview/pr-1841/src/components/util/lazyMountRegistry.js\":\"859fef974f566b20\",\"/knowledge-medium/pr-preview/pr-1841/src/components/util/suspense.js\":\"472a05d5e482fe77\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/CreateWorkspaceDialog.js\":\"55367ac70cd94584\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/PendingInvitations.js\":\"52fe58453104782c\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/SyncProgress.js\":\"df42d429b04fd08f\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/UnlockProgress.js\":\"b2e26e6df9edf89d\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/WorkspaceKeyGate.js\":\"08921e4bb0f596dc\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/WorkspaceSettingsDialog.js\":\"590e0222390b988a\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/WorkspaceSwitcher.js\":\"c4d8571658fe6c52\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/WorkspaceSyncGate.js\":\"d48923312e482a9f\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/conversion/ConversionFlow.js\":\"4e0eb19732aff190\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/conversion/ConversionFlowHost.js\":\"6825e25756f69b5b\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/conversion/EncryptionSection.js\":\"025f95fb0361488b\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/conversion/attachmentPrompts.js\":\"345e3ab630bbec32\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0178958fb51b2766\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/conversion/conversionFlowDeps.js\":\"8593297bd9cee6e3\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/conversion/conversionFlowStore.js\":\"62babd86f639f273\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/conversion/flowUi.js\":\"ada4bea0e69001a3\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/conversion/useConversionRun.js\":\"9a9881cb51495f26\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/keyUi.js\":\"39659f115adfd522\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/useCloseOnKeyLoss.js\":\"8473f9c9b25f48c6\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/useCloseOnServerE2ee.js\":\"c21bb691bf4ff020\",\"/knowledge-medium/pr-preview/pr-1841/src/components/workspace/workspaceUnlocked.js\":\"2d186a2b78bee903\",\"/knowledge-medium/pr-preview/pr-1841/src/context/backgroundSubtree.js\":\"341ab2d13b1e15de\",\"/knowledge-medium/pr-preview/pr-1841/src/context/block.js\":\"27cb70af39bcee5d\",\"/knowledge-medium/pr-preview/pr-1841/src/context/layoutWsContext.js\":\"d4185a4ca3ce40e4\",\"/knowledge-medium/pr-preview/pr-1841/src/context/propertyDisplay.js\":\"0e93937ee850d170\",\"/knowledge-medium/pr-preview/pr-1841/src/context/repo.js\":\"f936d1e38db2cdd2\",\"/knowledge-medium/pr-preview/pr-1841/src/data/aliasClaim.js\":\"367c70892522d98a\",\"/knowledge-medium/pr-preview/pr-1841/src/data/aliasSeatNamespace.js\":\"760fbb030fb019cb\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/blockData.js\":\"1cad4e99a0b01429\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/blockType.js\":\"7e2f8c8e72adcdfe\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/changeScope.js\":\"620439b0783a238d\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/codecs.js\":\"9d0d106e6546052c\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/derivedData.js\":\"011b120c888a911b\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/errors.js\":\"df46c2323ebc8b8e\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/events.js\":\"8ee2379b2cfe6387\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/handle.js\":\"e83bd47156b2c952\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/index.js\":\"cb51a2348e5059f2\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/mutator.js\":\"66922fefbd9a9417\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/processor.js\":\"d968f42c46561ed2\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/propertySchema.js\":\"7d2371ec37e6c734\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/query.js\":\"543628d65a03e84e\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/sameTxProcessor.js\":\"ccc549a3971cfb40\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/schema.js\":\"e83bd47156b2c952\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/tx.js\":\"e83bd47156b2c952\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/typedBlockQuery.js\":\"ccb621194db05842\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/user.js\":\"017ddbea61666b72\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/valuePresetCore.js\":\"3eff3a07e283b0b2\",\"/knowledge-medium/pr-preview/pr-1841/src/data/api/valuePresets.js\":\"18dc0872203f3a5f\",\"/knowledge-medium/pr-preview/pr-1841/src/data/attachmentCleanerIOVerb.js\":\"922dcedb257dfb2c\",\"/knowledge-medium/pr-preview/pr-1841/src/data/block.js\":\"f9eb4fd3615b5bf1\",\"/knowledge-medium/pr-preview/pr-1841/src/data/blockCache.js\":\"8b8a06a19491e808\",\"/knowledge-medium/pr-preview/pr-1841/src/data/blockId.js\":\"5beb7fa367cacfb1\",\"/knowledge-medium/pr-preview/pr-1841/src/data/blockLiveness.js\":\"2a759f6fa51b1ed0\",\"/knowledge-medium/pr-preview/pr-1841/src/data/blockMerge.js\":\"a6fe8fa33f9a3061\",\"/knowledge-medium/pr-preview/pr-1841/src/data/blockSchema.js\":\"8c0d9f59feaa451d\",\"/knowledge-medium/pr-preview/pr-1841/src/data/blockTypeLookup.js\":\"d1b80f2d723295b5\",\"/knowledge-medium/pr-preview/pr-1841/src/data/blockTypes.js\":\"efea6a7142089677\",\"/knowledge-medium/pr-preview/pr-1841/src/data/clientContext.js\":\"354d397b6dfde26f\",\"/knowledge-medium/pr-preview/pr-1841/src/data/dbFileSiblings.js\":\"591d09344f367272\",\"/knowledge-medium/pr-preview/pr-1841/src/data/definitionSeeds.js\":\"1b6f0c82980f4d0d\",\"/knowledge-medium/pr-preview/pr-1841/src/data/derivedIds.js\":\"94cc825185ea3208\",\"/knowledge-medium/pr-preview/pr-1841/src/data/drawnSubtree.js\":\"e3509a41d36646d9\",\"/knowledge-medium/pr-preview/pr-1841/src/data/facetBridge.js\":\"3a409e59b1586b46\",\"/knowledge-medium/pr-preview/pr-1841/src/data/facets.js\":\"d05158731b6c3f38\",\"/knowledge-medium/pr-preview/pr-1841/src/data/globalState.js\":\"54cbfd51229a6b43\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/aliasClaimRederiveProcessor.js\":\"15c2b0fa8379119d\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/ancestorBatch.js\":\"03c5d0e7d87997d6\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/blockTypeTypeifyProcessor.js\":\"b9bb302b8dcf1832\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/clientSchema.js\":\"0e4fcc484291b5e4\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/commitPipeline.js\":\"3d0df11870f913fb\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/devAssertions.js\":\"6c4748a1ca0b4535\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/firstSync.js\":\"ef89b74e923b17b4\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/freshInitialLoad.js\":\"ec9bab92a9ab1c9c\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/graphBackfillClaim.js\":\"ed88cd87a6d91191\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/handleStore.js\":\"d0b92f1b18e9a942\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/idleMarkerJobs.js\":\"6fbb0f14e549b862\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/initialDownload.js\":\"1f441454c226092f\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/initializeClientDatabase.js\":\"dd7f69e03f845451\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/jsonCanonical.js\":\"d063114bc5201084\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/kernelInvalidation.js\":\"8d9637dce540e5ac\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/kernelProcessors.js\":\"dcb340f93c2afe52\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/kernelQueries.js\":\"075ef7cb97f56f72\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/mergeTypeMembershipProcessor.js\":\"c2538aa30676237e\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/normalizeReferencesProcessor.js\":\"2eab4158bea65222\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/poolInstrumentation.js\":\"2dd8ee117c1164e0\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/processorRunner.js\":\"e2c54d633a0b21da\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/propertyCellBackfill.js\":\"ca981ae27bd3b748\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/propertyChildMint.js\":\"eeaa2db53e4d32ed\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/propertyChildrenProcessor.js\":\"14a58e2034daf85e\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/propertyDefinitionChangeProcessor.js\":\"700eed8933524fd8\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/propertyDefinitionSynthesis.js\":\"f8b6fae01867930f\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/propertyKeyScan.js\":\"b2c67f10e1515ea0\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/propertySchemaResolution.js\":\"a4c7c12a81730d79\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/propertyValueEdits.js\":\"280ac57e42050913\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/raiseProtocol.js\":\"4b78ed7f92f2ee21\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/readBatch.js\":\"70d09c23af72f507\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/refProjection.js\":\"5c8c90dd2f33c888\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/referenceTargetLookups.js\":\"a363808ad6774f50\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/referenceTargetProcessor.js\":\"ddba2dab66100ddb\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/replayMerge.js\":\"4d85ea0e8cf084cd\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/sqlBinds.js\":\"e7c2afffd16d0cdf\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"19e9593a75e826d1\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/syncObserver/arrivalProcessors.js\":\"6b19fd7a23349a36\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/syncObserver/invalidate.js\":\"4cf866416a2494a0\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/syncObserver/materialize.js\":\"75bf07b541995499\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/syncObserver/observer.js\":\"91b18a7a95ce12be\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/syncObserver/reconcile.js\":\"42857d54671bc60a\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/timingMetrics.js\":\"83f0768914678a91\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/treeQueries.js\":\"92931b8254b9b902\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/txEngine.js\":\"8791fa5cc913be44\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/txSnapshots.js\":\"e2249af50841af1d\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/typedBlockQuery.js\":\"8ff634eaeb1b757e\",\"/knowledge-medium/pr-preview/pr-1841/src/data/internals/undoManager.js\":\"e80ed5f30da84535\",\"/knowledge-medium/pr-preview/pr-1841/src/data/invalidation.js\":\"1989590555dca915\",\"/knowledge-medium/pr-preview/pr-1841/src/data/kernelDataExtension.js\":\"be4a8d7712eebbd0\",\"/knowledge-medium/pr-preview/pr-1841/src/data/kernelPage.js\":\"e533d6000f0cc622\",\"/knowledge-medium/pr-preview/pr-1841/src/data/kernelValuePresetCores.js\":\"145c2d31e9fb0fa0\",\"/knowledge-medium/pr-preview/pr-1841/src/data/localDbCorruptionSignal.js\":\"28e64c1f1e3e76b6\",\"/knowledge-medium/pr-preview/pr-1841/src/data/localDbStorage.js\":\"6cf66214cdbf1213\",\"/knowledge-medium/pr-preview/pr-1841/src/data/localDbVfs.js\":\"edb1d0731484ba5b\",\"/knowledge-medium/pr-preview/pr-1841/src/data/localSchema.js\":\"d4e9254fb45b7d8e\",\"/knowledge-medium/pr-preview/pr-1841/src/data/maintenance.js\":\"1aa99a738f332c0e\",\"/knowledge-medium/pr-preview/pr-1841/src/data/mergeProperties.js\":\"516c9f030aa7cd07\",\"/knowledge-medium/pr-preview/pr-1841/src/data/metricsConsoleHook.js\":\"62f1471045b70659\",\"/knowledge-medium/pr-preview/pr-1841/src/data/migrationsPage.js\":\"56887e54fe50679d\",\"/knowledge-medium/pr-preview/pr-1841/src/data/mutators.js\":\"52176a06ac896045\",\"/knowledge-medium/pr-preview/pr-1841/src/data/orderKey.js\":\"ef79aa20b994acdd\",\"/knowledge-medium/pr-preview/pr-1841/src/data/orderKeyPlacement.js\":\"f9da8b96c9d3b55b\",\"/knowledge-medium/pr-preview/pr-1841/src/data/outlineSurface.js\":\"3d1eb7357b473ec7\",\"/knowledge-medium/pr-preview/pr-1841/src/data/pendingEditorContent.js\":\"c2edb45266d22a80\",\"/knowledge-medium/pr-preview/pr-1841/src/data/pendingUploadsSql.js\":\"a9aabc342292dadb\",\"/knowledge-medium/pr-preview/pr-1841/src/data/pluginStateExtensions.js\":\"f4098a5cb931920c\",\"/knowledge-medium/pr-preview/pr-1841/src/data/powerSyncLogger.js\":\"9f59349713c3acf1\",\"/knowledge-medium/pr-preview/pr-1841/src/data/projectorRuntime.js\":\"f22e2ef9651bb386\",\"/knowledge-medium/pr-preview/pr-1841/src/data/properties.js\":\"5a236a16dec85d37\",\"/knowledge-medium/pr-preview/pr-1841/src/data/propertiesPage.js\":\"e5a95584d36a3c0e\",\"/knowledge-medium/pr-preview/pr-1841/src/data/propertyChildren.js\":\"9a6162e48dba348a\",\"/knowledge-medium/pr-preview/pr-1841/src/data/propertyDefinitionFanout.js\":\"e8d46a11980436e9\",\"/knowledge-medium/pr-preview/pr-1841/src/data/propertyDefinitionMetadata.js\":\"429a4f5c54964d40\",\"/knowledge-medium/pr-preview/pr-1841/src/data/propertyDefinitionRegistry.js\":\"0239280f5a8341fb\",\"/knowledge-medium/pr-preview/pr-1841/src/data/propertyDisplayMode.js\":\"901759705bafb92b\",\"/knowledge-medium/pr-preview/pr-1841/src/data/propertyRowCreation.js\":\"1d90f55097589476\",\"/knowledge-medium/pr-preview/pr-1841/src/data/propertySchemaCreation.js\":\"2eb78c72e41b2813\",\"/knowledge-medium/pr-preview/pr-1841/src/data/propertySeeds.js\":\"ffdfbe9b6a3f0aee\",\"/knowledge-medium/pr-preview/pr-1841/src/data/recentsPage.js\":\"280c754ca1a7a131\",\"/knowledge-medium/pr-preview/pr-1841/src/data/referenceBlock.js\":\"2aba510c93583e65\",\"/knowledge-medium/pr-preview/pr-1841/src/data/rejectedUploads.js\":\"5e65eda3d178d224\",\"/knowledge-medium/pr-preview/pr-1841/src/data/releasePowerSyncConnection.js\":\"5b6f2b64f8129708\",\"/knowledge-medium/pr-preview/pr-1841/src/data/repo.js\":\"1ea68ac706bf7c80\",\"/knowledge-medium/pr-preview/pr-1841/src/data/repoProvider.js\":\"e41d2e302ed627ee\",\"/knowledge-medium/pr-preview/pr-1841/src/data/rowProperty.js\":\"6dc30eb271220b3f\",\"/knowledge-medium/pr-preview/pr-1841/src/data/searchFilter.js\":\"6ff0baebbb8f8b99\",\"/knowledge-medium/pr-preview/pr-1841/src/data/seedIdentityLedger.js\":\"b82621e7c6666537\",\"/knowledge-medium/pr-preview/pr-1841/src/data/stateBlocks.js\":\"9cb72d1098acad69\",\"/knowledge-medium/pr-preview/pr-1841/src/data/structuralEditPolicy.js\":\"6b0c83e09ae52d38\",\"/knowledge-medium/pr-preview/pr-1841/src/data/subtreeDelete.js\":\"437747ed06aabd38\",\"/knowledge-medium/pr-preview/pr-1841/src/data/syncStreamLock.js\":\"a0fe0e66fdb5e48b\",\"/knowledge-medium/pr-preview/pr-1841/src/data/syncedTableSqlRecognizer.js\":\"321ce27720d86a02\",\"/knowledge-medium/pr-preview/pr-1841/src/data/syncedTableWriteGuard.js\":\"0df9721c4ab20270\",\"/knowledge-medium/pr-preview/pr-1841/src/data/targets.js\":\"6951de05e20a9876\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typeColors.js\":\"63490bf0e0c9bf18\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typeDefinitionMetadata.js\":\"34c292504cb75e15\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typeDefinitionRegistry.js\":\"5830e603a3d54939\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typeExtraction.js\":\"9169e76367c0281e\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typeInitialValues.js\":\"97944c99a0198662\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typePropertyGroups.js\":\"f43be04be8346dcb\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typeSeeds.js\":\"0844f3f322196ae6\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typeTagger.js\":\"986203bbc2e6695a\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typedRecords.js\":\"9fa4b82ec7bc59ef\",\"/knowledge-medium/pr-preview/pr-1841/src/data/typesPage.js\":\"8ede30ff8427ba91\",\"/knowledge-medium/pr-preview/pr-1841/src/data/userPrefs.js\":\"6ed1d0b577b660b9\",\"/knowledge-medium/pr-preview/pr-1841/src/data/userSchemasService.js\":\"a3f6494693c775aa\",\"/knowledge-medium/pr-preview/pr-1841/src/data/userTypesService.js\":\"1a4465db3acca69b\",\"/knowledge-medium/pr-preview/pr-1841/src/data/valuePresetRegistry.js\":\"1e979e3686fbdd5a\",\"/knowledge-medium/pr-preview/pr-1841/src/data/visibleChildren.js\":\"fcaeed726a7eeac9\",\"/knowledge-medium/pr-preview/pr-1841/src/data/workspaceConversion.js\":\"190f9589ba9b2edf\",\"/knowledge-medium/pr-preview/pr-1841/src/data/workspaceFirstSync.js\":\"0703871e921c1adc\",\"/knowledge-medium/pr-preview/pr-1841/src/data/workspaceIdNamespace.js\":\"137f7576d5fef63c\",\"/knowledge-medium/pr-preview/pr-1841/src/data/workspaceSchema.js\":\"6f5fe3320753aab0\",\"/knowledge-medium/pr-preview/pr-1841/src/data/workspaces.js\":\"c80f9450aadb28f0\",\"/knowledge-medium/pr-preview/pr-1841/src/data/writeAheadLog.js\":\"eaf58d65efaa4027\",\"/knowledge-medium/pr-preview/pr-1841/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/BlockPasteShellDecorator.js\":\"43e8b59af89691dc\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/atTrigger.js\":\"d6283eb8c7e0fb8d\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/autocomplete.js\":\"1baf33667064da0f\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/codeMirrorExtensions.js\":\"0a2a9c06f5b53cf2\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/contentFlush.js\":\"cabe94b47f49ec95\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/defaultInteractions.js\":\"772c771adc08f5b0\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/editSettleSignal.js\":\"9669bb541e4e7842\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/insertImage.js\":\"25f0b2b86eebd184\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/referenceCompletionRange.js\":\"02cc3619531609ec\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/referenceTargetTypes.js\":\"920ae4a9067e9247\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/syntaxContext.js\":\"a1ea22d222dd861d\",\"/knowledge-medium/pr-preview/pr-1841/src/editor/triggerMatch.js\":\"d5f4037da8acc58e\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/AppRuntimeProvider.js\":\"ae8be3c899d2b702\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/BlockFocusShellDecorator.js\":\"467e802772e75de1\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/ExtensionRenderBoundary.js\":\"28621af193396c9c\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/PanelContentRecovery.js\":\"8d45c4842920a16e\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/apiCatalog.js\":\"bb31958f82a54b6c\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/approveExtensionHere.js\":\"50983fa6ab12a56e\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/armedCutAppMount.js\":\"502467e3ec757bc8\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/batchableKeyedStore.js\":\"ca3fe4d0a92af8bc\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/blockInteraction.js\":\"843df994fc752d72\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/blockSelectionAction.js\":\"ac73d30d14f609c7\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/compileExtensionModule.js\":\"de9fa2b5e5a61166\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/compiledModuleCache.js\":\"b2e2d264d5a9f3d3\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/continuousGestures.js\":\"d154f4d0dccdee41\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/core.js\":\"3c81563b469b7644\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/defaultRenderers.js\":\"c3fe83791fa30fb8\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/definitionFanoutAppMount.js\":\"fa3fa0d9f6e79ab6\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/dialogAppMount.js\":\"703accf7f7d968de\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/dynamicExtensionSeeds.js\":\"ecafe9bee5eaa735\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/dynamicExtensions.js\":\"1ee8bb62810bb5b3\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/exampleExtensions.js\":\"fc3d56acf0fb9c77\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/extensionApprovalStatus.js\":\"22e80e255510c1ab\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/extensionLoadErrorToast.js\":\"175ca434e578322e\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/extensionLoadErrors.js\":\"81d607998a0938ba\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/extensionLookup.js\":\"d8003702c4715ea6\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/extensionToggles.js\":\"4e46e38f5a88e4ef\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/extensionUtilitiesCss.js\":\"4fce147e6f1d9fde\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/kernelPageDeletionGuard.js\":\"bdd47bc599afef55\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/liveRuntime.js\":\"36c05c8cd3455af5\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/openExtensionsSettings.js\":\"0108f976aba785af\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/overridesCache.js\":\"f02e9300b683c6ca\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/pluginIds.js\":\"99f3d2d5f090f7ca\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/processorRejectionToast.js\":\"9e454bbc74f88fd9\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/runtimeActions.js\":\"0dea0be09d939bc8\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/runtimeContext.js\":\"f319e38866fbc816\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/staticAppExtensions.js\":\"1e186442596bbff4\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/staticDataExtensions.js\":\"09025b848f7a7de6\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/toastAppMount.js\":\"659693e192c9f1e0\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/useOverrides.js\":\"4e07360fedd0405f\",\"/knowledge-medium/pr-preview/pr-1841/src/extensions/useShortcutSurfaceActivations.js\":\"7df906cf7d6ef08c\",\"/knowledge-medium/pr-preview/pr-1841/src/facets/discoverToggleTree.js\":\"426d03e6555de293\",\"/knowledge-medium/pr-preview/pr-1841/src/facets/facet.js\":\"092c618488678ce2\",\"/knowledge-medium/pr-preview/pr-1841/src/facets/resolveAppRuntime.js\":\"ed5f1756f86defe3\",\"/knowledge-medium/pr-preview/pr-1841/src/facets/runtimeEvents.js\":\"d836ed0e3caefee8\",\"/knowledge-medium/pr-preview/pr-1841/src/facets/togglable.js\":\"2e54793fcd699e7e\",\"/knowledge-medium/pr-preview/pr-1841/src/facets/variantFacet.js\":\"1c1f13d2539e526e\",\"/knowledge-medium/pr-preview/pr-1841/src/facets/verbFacet.js\":\"8018db9dcfa2412f\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/block.js\":\"8e53b06af39e92f2\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/focusedChild.js\":\"8fd6387e7a9d334c\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/propertySchemas.js\":\"a78aacdeef4903a0\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/typeRegistry.js\":\"fcc01659521771e8\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useAncestorCrumbs.js\":\"8e7a422047b17cb5\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useAutocompleteListbox.js\":\"8dd3c2156e2f159a\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useDebouncedSearch.js\":\"0f66ca489cb70a9c\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useDebouncedValue.js\":\"a5aa1ba498b5f497\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useIsFocalRender.js\":\"4bc8af80ca060489\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useIsReadOnly.js\":\"5233900ecda5dceb\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useMaterializeBacklog.js\":\"88344e9a015a5823\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useMinuteClock.js\":\"aad1387591fc20ac\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/usePanelLayoutProjection.js\":\"3ddeeebc008dd122\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/usePendingInvitations.js\":\"0e4060c7a91ec0e9\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useRendererRegistry.js\":\"7ee4b29b75732389\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useRetainedFieldRows.js\":\"e5978b17cced7b21\",\"/knowledge-medium/pr-preview/pr-1841/src/hooks/useWorkspaces.js\":\"57394cc098869a0e\",\"/knowledge-medium/pr-preview/pr-1841/src/lib/utils.js\":\"b72f0d7fd0c9ae8d\",\"/knowledge-medium/pr-preview/pr-1841/src/main.js\":\"a873853fba187bda\",\"/knowledge-medium/pr-preview/pr-1841/src/markdown/MarkdownImage.js\":\"9583c726f6309277\",\"/knowledge-medium/pr-preview/pr-1841/src/markdown/blockSeparators.js\":\"9c17355a1cef3e88\",\"/knowledge-medium/pr-preview/pr-1841/src/markdown/context.js\":\"9e663962171e04a3\",\"/knowledge-medium/pr-preview/pr-1841/src/markdown/defaultMarkdownExtension.js\":\"4db60540e6416f0a\",\"/knowledge-medium/pr-preview/pr-1841/src/markdown/extensions.js\":\"29784eac1f0f8a7b\",\"/knowledge-medium/pr-preview/pr-1841/src/markdown/renderMarkdownHtml.js\":\"8eda4c5ecec21bb3\",\"/knowledge-medium/pr-preview/pr-1841/src/minimal-editor.js\":\"8e19fdccb020a8e4\",\"/knowledge-medium/pr-preview/pr-1841/src/paste/armedCut.js\":\"f3fb4a69ef60866d\",\"/knowledge-medium/pr-preview/pr-1841/src/paste/captureMediaVerb.js\":\"79fcb3af5aef5b3a\",\"/knowledge-medium/pr-preview/pr-1841/src/paste/clipboard.js\":\"ff85d9e54f22cae1\",\"/knowledge-medium/pr-preview/pr-1841/src/paste/decision.js\":\"1d231a7b1e909700\",\"/knowledge-medium/pr-preview/pr-1841/src/paste/operations.js\":\"c91f6ba020981292\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/account-header/AccountHeaderItem.js\":\"b10fd8e582fa282a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/account-header/index.js\":\"4cda478b13e552e6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"fd6bfc9ed9248a80\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-dispatch-companion/askAgent.js\":\"f65e5e10380f41c3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-dispatch-companion/askedStore.js\":\"074b6c5509c8ec00\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1120c72147f2e3c7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-dispatch-companion/chipState.js\":\"aa6cf28366d14bdb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2c1d6cfee8e158c6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-dispatch-companion/index.js\":\"57c0a71fd70b97cc\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8cdb5d256de767b8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-dispatch-companion/schema.js\":\"400201c0e239d95f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e58b010afa32a170\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c200be2fadd8ad86\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/addMedia.js\":\"8172cfd1e0cbd34a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3d201a258bd91592\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/block.js\":\"b5b67dc7a0385f35\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/context.js\":\"b34351e3041f14c3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/displayIds.js\":\"13b7888e673a5c89\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/index.js\":\"ccaa18021aedf626\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/outline.js\":\"1250d67a8b4411e2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/properties.js\":\"2e4aee5682ec2147\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/refs.js\":\"c1455be898edd80b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"093d48704f242bef\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/search.js\":\"b646efc0e3a76ce3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/shared.js\":\"353220105d2793aa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6b539173198645e9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentViews/text.js\":\"229c0d8aa7ff6548\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/agentWrites.js\":\"a11942d661226d12\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/authoringCatalog.js\":\"d1af3640c84683da\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/blockRefTargets.js\":\"d2f2c4e6a7cdb1d3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/bridge.js\":\"112e6d26bbbbc3f0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/bridgeLoop.js\":\"2a891ade6a234c94\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/changeHistory.js\":\"977f075bdf6aabd4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/commands.js\":\"85ce6ef3cdeb1cd3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/commentsCommands.js\":\"9014d061c0c216ce\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/dataExtension.js\":\"e891803286322915\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/dataModelGuide.js\":\"174e6d448c7c73d2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/describeRuntime.js\":\"c3396a8842648cde\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/extensionLint.js\":\"899b1ddc8b4226b2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/grainAudit.js\":\"60f0e027a10181c2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/healthCommand.js\":\"92a1997dc4814b88\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/index.js\":\"56d6a2d42f64d19a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/presetIdentity.js\":\"a0604bae442dbcf7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"cd8a5ba7927e562d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/readMedia.js\":\"2ee64503c2ba2d1c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/schema.js\":\"d560103be2c43437\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/serialization.js\":\"96d04c46e27f7329\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/targets.js\":\"2f8708a958607299\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/tokens.js\":\"f1bdde83a626a7e5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/watchEvents.js\":\"49567d7b646bd48d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/workspaceGuard.js\":\"ee5203ea419569d5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/agent-runtime/writeCommands.js\":\"27b07500911fd782\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/alias/AliasCollisionToast.js\":\"a7f62c84af265544\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/alias/DuplicateNameBanner.js\":\"a1df46b058099950\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/alias/collisionMerge.js\":\"17d99b895c635a6e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/alias/dataExtension.js\":\"1312d0852296ce91\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/alias/index.js\":\"a0f6812a212d8f1b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/alias/mergeCollisionAction.js\":\"dd13cc2abd30861c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/alias/pageStyling.js\":\"7ce528095dac3d39\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/alias/rejectionToast.js\":\"0746a5d3a0d9d319\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/alias/syncProcessor.js\":\"68f397596a80c670\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/actions.js\":\"fb1e19402e94db40\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/addComment.js\":\"2502d994bb9e1df6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/anchor.js\":\"d185bd56abc13c00\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/anchorState.js\":\"5eea22922fdec60b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/commentLinks.js\":\"dabcf4b2e636a52e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/confirmThreadDeletion.js\":\"70c5edb4fab44b7b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/container.js\":\"6b56f8bd3a167957\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/dataExtension.js\":\"318139715fec66f2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/deleteComment.js\":\"406913304e8bf742\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/highlights.js\":\"19d46f3a60b4cd6f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/index.js\":\"57d034a621aae5a8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/linkedCommentsPill.js\":\"869b952704822d16\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/margin.js\":\"b30a239e7ac1bd45\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/marginSchema.js\":\"cb639c244320231f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/newComment.js\":\"6654f1a61d05f454\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/ownThreadPicker.js\":\"e005d1761a59031c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/placement.js\":\"8fd561e2d9c7943b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/queries.js\":\"7b3faf6c6ed01807\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/quotePosition.js\":\"3c73f9d292eb9efb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/quotedIn.js\":\"d867fc4c82fe15c9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/quotedRange.js\":\"048271dc80303630\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/rangeRefs.js\":\"8109ab2edf0a65ee\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/readHighlights.js\":\"7348ec7267e2851a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/readSelection.js\":\"aa6174124c3299ae\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/readSelectionUi.js\":\"917de6763b4a3998\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/reanchor.js\":\"90ee6e11f21fbf9e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/schema.js\":\"47b0c16ed8cd8cd0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/scope.js\":\"5fe9644bb86f7644\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/scopeThreads.js\":\"7754c0a6edd584bd\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/splitRetarget.js\":\"909c800e5c711d66\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/suggestionCard.js\":\"87884803ee1b01b1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/suggestions.js\":\"1a85a45be73a91f6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/summaries.js\":\"f7106cb7931da0af\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/summaryBatch.js\":\"4a069eb5d2d05336\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/surface.js\":\"4d947a70768f764e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/threadNavigation.js\":\"cc2d438fca76f80c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/threads.js\":\"3f4ed363d10fd160\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/ui.js\":\"850ef5741560f5d3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/annotations/uiStore.js\":\"fc4a377cc1bd6eb1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/app-intents/appIntents.js\":\"7693e1a6d9509f30\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/app-intents/index.js\":\"67d9cc2e2d459cf2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/app-update-prompt/index.js\":\"12ec62f255126e77\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/app-update-prompt/status.js\":\"053205e62691ff01\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e44d1781c7022f3a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/MediaBlockRenderer.js\":\"ddd7e324ef20f334\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5fd95b0062a1d63b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/MediaUploadReconciler.js\":\"52c7d319863de154\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/assetDownLane.js\":\"76218f428d4653d0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/assetResolver.js\":\"be5fd760a2cb4608\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/assetUpload.js\":\"1a85417b04de0004\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/attachmentCleanerIO.js\":\"95b5a622fd3e1c6f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/audit/supabaseAuditIO.js\":\"70643cdd28209538\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/blobStore.js\":\"6f837c8011bc64f7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/byteStore.js\":\"6a913953be1e61f0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/cleanerIO.js\":\"474e85cdd2150fb6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/cleanupAttachments.js\":\"e871279856abcb98\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/dataExtension.js\":\"70b7a8e4f78fd93d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/downLane.js\":\"09bb9f23fd8a74fc\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/index.js\":\"d0d30f7c4972cd31\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/insertImageContribution.js\":\"667632ab4ea54691\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/laneArming.js\":\"6f6d37663a360578\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/laneLock.js\":\"71d8e102332b6bae\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/mediaBlock.js\":\"fe7a632be51c7fbe\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/mediaCapture.js\":\"ae55b32ed94ab635\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/mediaViewers.js\":\"61fe5149e1d16d29\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/mediaViewersFacet.js\":\"75fb4c1589c35b54\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/pasteCapture.js\":\"1c639cd324ce3fd5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/resolver.js\":\"d3572311e46d7420\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/retryUploadsAction.js\":\"6bbf69f6df53c82a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/storagePaths.js\":\"49c411f99ccd68e8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/uploadDrain.js\":\"ee8f643a809e35a5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/uploadLaneStatus.js\":\"ef5ccb399f03453c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/uploadReconcile.js\":\"669af7fcda70847d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/uploadRecovery.js\":\"1bb01b05e31ac2a9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/uploadStore.js\":\"bdfb23b8a096549d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/attachments/useAssetObjectUrl.js\":\"c14fa932e626e51b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"86336a905ed65824\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks-view/BacklinksViewSection.js\":\"6100d64d79c1d59c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks-view/facet.js\":\"a06f81bbf3d2937d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks-view/index.js\":\"df3072c781dba31e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks-view/prop.js\":\"f3defbc670bcfe25\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/BacklinkFilters.js\":\"7d39d6fe0ad402b1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"0a2ae7ed5421c79e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/BlockEntry.js\":\"bc64d611e27b05ed\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/LinkedReferences.js\":\"ea3552e6b75173cb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"caba1ada42eab2f0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/dailyNoteDefaults.js\":\"ab4266d6c3f9b00d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/dataExtension.js\":\"c04f61228a4ed1a1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/edgeExclusions.js\":\"2909fbd31ef0c397\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/filterProperty.js\":\"c3d5c6def922a3c1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/index.js\":\"850626141b0d88ca\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5d26d225252c1163\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/inline-counts/applies.js\":\"eab56e9a886cbb94\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/inline-counts/countQuery.js\":\"ff9796ea5fb4e61e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/inline-counts/expansionStore.js\":\"21167631f81b6d86\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/inline-counts/index.js\":\"34f4098444fdc3a9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0797eb28d0b6ee61\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/presentationInvalidation.js\":\"4d75be7fbf4c0536\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/propertyEditorOverride.js\":\"cf7cfe43dcf504b0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/propertyFilter.js\":\"d8255f7d7dc2351f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/query.js\":\"ce412a20a059b4fc\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/resolveFilter.js\":\"842eba5e2e659637\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/sourceBatch.js\":\"1d2ece6681068685\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/sources.js\":\"f77a2a4122e26262\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/useBacklinks.js\":\"51c44dd26e3a0159\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6c6a4ef8498d0588\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/birthday/BirthdayCelebration.js\":\"3fd6d1c4e8c5a55d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/birthday/BirthdayOverlay.js\":\"27a738c5b7c672a2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/birthday/gate.js\":\"05aad7a32582ae4e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/birthday/index.js\":\"1c56041113ba2d57\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/birthday/wolfTheme.js\":\"d5b4d4abcf8d2c24\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-drag/BlockDragLayer.js\":\"2935d9cc8b104629\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-drag/dragController.js\":\"4559d7b59537fd79\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-drag/dropTarget.js\":\"76430e848cc25af1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-drag/index.js\":\"e0662cf91082f088\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-drag/projection.js\":\"56ef686d81a1ed1f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-info/BlockMetaCard.js\":\"d2c3944ddb4d7810\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-info/index.js\":\"c0be2431c679f668\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-tagging/AddTagDialog.js\":\"47902d298c8e70c8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e1dd8d42f2672b96\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-tagging/TagNameIssueHint.js\":\"bd0c7efc592994a2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-tagging/addTagAction.js\":\"f1a3e68f542d4ebc\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-tagging/appendTag.js\":\"f78a0ea49e04204e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-tagging/config.js\":\"cde1c9f15ca64d54\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-tagging/dataExtension.js\":\"a5192d2006275e64\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-tagging/index.js\":\"4ee8ca60c05443d7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/block-tagging/propertyEditorOverride.js\":\"98dba08dac00c69f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1c8216bd5d2d9881\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cf4ab417314a20b8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/breadcrumbs/Breadcrumbs.js\":\"147e5dc84dd35437\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c4c72e11a812c076\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c8b32134c43a5e49\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/breadcrumbs/index.js\":\"ee6a6350f37b1b65\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"697b2e2a56a6355b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/CharacterCountItem.js\":\"7746f3405a227aae\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/ProfilePropertyEditor.js\":\"53ee22fba8adb2c0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/actions.js\":\"dae86798a2213113\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/blockType.js\":\"459ef104b91306b3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/charCount.js\":\"50cf08e1e041f5aa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/dataExtension.js\":\"21e0df257c487b45\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/index.js\":\"ca0a3e2d66f70ffb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/profiles.js\":\"f9292473633998ea\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/properties.js\":\"95cd0f2357cdbf3b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/character-counter/textCounts.js\":\"5d6f1b35ae121036\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/colemak-keybindings/index.js\":\"0a3a6c931bd600b7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/command-palette/CommandPalette.js\":\"05cd9705a63b58e1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/command-palette/HeaderItem.js\":\"094f9234b80540cc\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/command-palette/context.js\":\"c12ea224b3a15539\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/command-palette/index.js\":\"ddf7fe1a092074aa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/command-palette/selection.js\":\"44c6324cf2a698fa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/command-palette/toggleStore.js\":\"7138f5ec258392a8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/command-palette/useCommandPaletteActions.js\":\"e9b0812577fb9241\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/ContributorBadges.js\":\"717f24ee1fcd77f2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/author.js\":\"2107fb36d89f6060\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/codeMirrorExtensions.js\":\"87903c78ac65163e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/dataExtension.js\":\"fe3457a5990bad52\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/index.js\":\"75fd9c88948f2d81\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/mentionAutocomplete.js\":\"a9c1743458d432b6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/processor.js\":\"f432b0df0adead91\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/profiles.js\":\"2ebf9e5eb66fc169\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/queries.js\":\"b86f1dc010587dae\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/contributors/schema.js\":\"d12ce18f60de8075\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e7116c9273acb171\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/cursor-follows-scroll/followOrigin.js\":\"86b6e6f0947dc60e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/cursor-follows-scroll/index.js\":\"2664f0fa3ee9efbb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"12db38c2772baa53\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"605cb284071a2d56\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/CalendarGrid.js\":\"2bb8d03dce1000b9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/DailyNotePicker.js\":\"b6c474bdd742eb68\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"20a3d7a42584fbeb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/DateNavDecorator.js\":\"40e8bf9e9928981e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/DateScrubOverlay.js\":\"cc17456398f284d8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/HeaderItem.js\":\"3aabee5fbd58cb75\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/ReschedulePicker.js\":\"0e75e4f76fc187fc\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/SpreadDatesDialog.js\":\"48c69d2531333fd4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/actions.js\":\"f8c897b233396e48\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/blockDateAdapter.js\":\"0a8f331d36a3396a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/calendar.js\":\"9b92980451e0e194\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/dailyNotes.js\":\"90790c938d1bc032\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/dataExtension.js\":\"32fc134c710f7aea\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/dateScrubActions.js\":\"4b2fa1674d70d51b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/dateScrubGesture.js\":\"e29cb2527c219cdd\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/dateScrubGestureActions.js\":\"9a535ba79c8568b8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/dateScrubRecognizer.js\":\"2e17acc2d1df0338\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/deletionGuard.js\":\"2ec0d6e4cb3a67db\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/dueQuery.js\":\"84f05ab5d697608c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/index.js\":\"4d59f56c0191d609\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/landing.js\":\"1feab078dd94c6a8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/localSchema.js\":\"983953ffdd7fe372\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/referenceDateAdapter.js\":\"b4d37f33c1c0b6fa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/rescheduleAction.js\":\"959c217ba7ef3a8b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/schema.js\":\"aba13001e42f20b5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/spreadBlockDates.js\":\"c819ca9f989f0feb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/spreadDatesAction.js\":\"feb9d60a08bc3e85\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/today.js\":\"f4e30f401027bbf1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"66c91412a92087da\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1e8cee371d4544ee\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/audit.js\":\"2c8538f271c1d22e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/auditAction.js\":\"9cd3db779d5cf266\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/auditRanges.js\":\"97ea9585ed4f8ada\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/diagnosticsSource.js\":\"f9ccc1116a2127a4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/divergenceScan.js\":\"7030c0ffd731fc23\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/index.js\":\"92034b3e5dc588ed\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e5122acd427c85aa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/referencesMirror.js\":\"4c0689b738539f98\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/rowJson.js\":\"86db1bbb9ad8e324\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/schedule.js\":\"3181d638f991d06d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/data-integrity/store.js\":\"3ba02821f95095e4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-maintenance/action.js\":\"6a1076a91b334993\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-maintenance/index.js\":\"4c12f08f1c8aab9e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-maintenance/plugin.js\":\"b78e13b43b2de579\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"44c1e03ef9ba8bf1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/actions.js\":\"f7ac7e004f581c99\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/changeMarker.js\":\"658c70e8d4c35848\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/diagnostics.js\":\"500fe9def0926d20\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/fileSystemAccess.js\":\"8e64cb2f89060ffe\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/filenames.js\":\"7981c17d73c70ee4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/index.js\":\"75eb0a016eb3a7c6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/mirror.js\":\"934b787e1bc43d60\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/runLock.js\":\"72945da34638958e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/runtimeHealth.js\":\"abb602a1db9cbc3c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/schedule.js\":\"a7eb676d785277ff\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/db-mirror/store.js\":\"1e364796dbfb669d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/default-themes/index.js\":\"4bac9e69243eafbe\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/default-themes/themes.js\":\"c1260270b0aa5db8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/diagnostics/facet.js\":\"18e045f2f15418bf\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/diagnostics/useDiagnostics.js\":\"0c97e7bd7581afcd\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extension-prompts/dismissals.js\":\"87b867188ec160aa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extension-prompts/index.js\":\"e657e63a82f0ee7a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extension-prompts/status.js\":\"b72a6242f89fa9aa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extension-prompts/store.js\":\"c153fcc1a8581368\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1594b381d7d1c779\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extensions-settings/ExtensionsSettings.js\":\"75ea4f25409b1895\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extensions-settings/actions.js\":\"0687ffcd885e14c0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extensions-settings/config.js\":\"e3466bae29fed14f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extensions-settings/dataExtension.js\":\"148e3fcfcc11ff23\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extensions-settings/effect.js\":\"5e118df064c0b627\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extensions-settings/index.js\":\"d3abd0291c1671e8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extensions-settings/propertyEditorOverride.js\":\"4b92058e090b0ee5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extensions-settings/useToggleTree.js\":\"289f6a24224fcf6f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extract-type/ExtractTypeDialog.js\":\"e4d4f109c4eee62f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6d35c808efece6b3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extract-type/PropertyShapePicker.js\":\"1a33416bade23c2d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extract-type/action.js\":\"1b3490d671eb5e13\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/extract-type/index.js\":\"b9a5fde90c93210f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/find-replace/FindReplaceDialog.js\":\"10c12c212105ebe2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/find-replace/HeaderItem.js\":\"a4329e25844689c7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/find-replace/dataExtension.js\":\"12229125ba8de117\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/find-replace/index.js\":\"088e51416eb16fc9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/find-replace/search.js\":\"921349ca5695a0d5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/find-replace/toggleStore.js\":\"8ea232e04340295f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/LocationPropertyEditor.js\":\"3f9eb1a424c54a43\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/MapView.js\":\"8e9c617481849a33\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/blockTypes.js\":\"7b9b92770602e8a6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/codeMirrorExtensions.js\":\"bedbaa598b7d3113\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/createOrFindPlace.js\":\"670c8d3815b91e86\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/currentLocation.js\":\"0973be529d65380d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/dataExtension.js\":\"92bee771ac6b9137\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/geoContentDecorator.js\":\"51ff566112128e2b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/googlePlacesClient.js\":\"468c027ea7c03c7d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/index.js\":\"0b4d310d8cab323d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/locationsPage.js\":\"38f9b491afd72baa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/mapViewport.js\":\"2a0e25c984a29919\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/pickCurrentLocation.js\":\"e29dc454392e3c25\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/placeAutocomplete.js\":\"b6806a5a1623a3fd\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/placeNameCollision.js\":\"25e380b911fa74ac\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/properties.js\":\"9d316f718cd18fec\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/propertyEditorOverrides.js\":\"9210a62b8e1ab55f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/query.js\":\"87f7e1c0692a8048\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/geo/usePlaceSearch.js\":\"97fbf84022553635\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9cff16dfb5b74a6b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1e874a68c26e2236\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"118c8cd3b599200c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/config.js\":\"a0770f0a45c04606\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/dataExtension.js\":\"bdd12184ae7cb47e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/facet.js\":\"b2eb8a9607c8e482\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/grouping.js\":\"aa532ed19fb2ffbf\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/index.js\":\"da6bb8be61b26f7a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"09a508e80f9e9959\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/query.js\":\"7c26aef7e19a3bb6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/resolveConfig.js\":\"306efcf7a8070cce\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f0bbf9f1435fcbf2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7097c39c5f6fa0d6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/HtmlDocumentContent.js\":\"5c32901bf98264c4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/HtmlFrame.js\":\"f71906d393687328\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/actions.js\":\"37aa1d79b20831c2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/blockType.js\":\"baca8b57cfee36e0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/confirmRunScripts.js\":\"c78bd99e17dcc416\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/dataExtension.js\":\"8627ad6199a3582d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/frameAnnotations.js\":\"d7160c669181d8e0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/frameDocument.js\":\"f20b643af77c75a8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/frameTheme.js\":\"319f83bfb2275290\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/index.js\":\"9fc03598e2b094f4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/scriptConsent.js\":\"85de310e4406e1c9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/sourceMap.js\":\"b40d460b35bdd336\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/html-document/useDocumentScripts.js\":\"6308626f4db3d900\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/interaction-metrics/index.js\":\"b4cafc535c9404b5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/interaction-metrics/record.js\":\"e57c967f243b2653\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/interaction-metrics/recordStore.js\":\"bc8ebcb054e25083\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/interaction-metrics/responsiveness.js\":\"d3fcffb37f6cbc96\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/interaction-metrics/schedule.js\":\"dbd072a7bc9f6e7a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/interaction-metrics/sessionContext.js\":\"911b88cbec876fcf\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f4a29300b17df992\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"875cfa05993864ed\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/actions.js\":\"91b3ff0e673aed43\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/config.js\":\"b5130ef34fe06f7f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/dataExtension.js\":\"ffc8fe4eb2bd5b20\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/effect.js\":\"3273b7bbc04ccdb3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/index.js\":\"3172bba209e0b74c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/keyCapture.js\":\"edc7b6c12da3b87d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/overrideStore.js\":\"46439008a8f0ead7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dbd94146507c334a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/left-sidebar/HeaderItem.js\":\"96967f003e987471\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/left-sidebar/LeftSidebar.js\":\"9e866d9dbec36e4a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/left-sidebar/actions.js\":\"0ce7d440f225e9c4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/left-sidebar/facet.js\":\"dd9485b437cef3b5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/left-sidebar/index.js\":\"cb71445b0e18a83b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/left-sidebar/shortcuts.js\":\"3bf6a4049d3a3371\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/left-sidebar/toggleStore.js\":\"a786682e3c91eb72\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/merge-blocks/MergePicker.js\":\"dcbf582c5dd3dfa8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/merge-blocks/index.js\":\"fc01f0c5683e4d30\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/merge-blocks/mergeAction.js\":\"fff490ffdd2f4cc5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/merge-blocks/strategy.js\":\"0b5cec9e8de81b84\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-bottom-nav/Button.js\":\"d6864edd0c969194\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"714cff0dc329c778\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8f1aa503fe6bc783\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-bottom-nav/facet.js\":\"17e5d825ab76467e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-bottom-nav/index.js\":\"22a764054393efa9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"457ddf120637c045\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a80e171ebcc26742\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"31de181b3405b69d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-keyboard-toolbar/facet.js\":\"48c7980beed561f4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/mobile-keyboard-toolbar/index.js\":\"483076c2370f550d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/move-blocks/MoveDestinationPicker.js\":\"dd3bf9f0bd0fd78e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/move-blocks/blockSubtreeMembership.js\":\"61045ad3d3e3e208\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/move-blocks/contextMenuItem.js\":\"fa46c9388c42b3cc\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/move-blocks/index.js\":\"6aa6effc8ab0e3db\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/move-blocks/moveAction.js\":\"6b9e1f123f8e2184\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/move-blocks/moveBlocks.js\":\"e87840613c5b641e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/move-blocks/selectionAfterMove.js\":\"f8f8e5e5139deefb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/onboarding/TutorialBanner.js\":\"d15f0caaf5e5645a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/onboarding/action.js\":\"08da1c1a1327193a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/onboarding/bannerDismissal.js\":\"c424be0a35ae90a0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/onboarding/documents/cheatSheet.js\":\"c43380a12cec0cef\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/onboarding/index.js\":\"64785db5e58b405a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/onboarding/keys.js\":\"aca1f5dac8125f84\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/onboarding/landing.js\":\"c0e46af0fa7c8965\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/onboarding/outline.js\":\"4841339d6362caaf\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/onboarding/seed.js\":\"02000d8da02525e6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5e448b97a982eb48\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/analyze.js\":\"c4731bfd9ddf53c7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/diagnosticsSource.js\":\"4dd1044955c300d3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/index.js\":\"99d0b407dc246b53\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/load.js\":\"03093df4ffdaacda\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/monitorRun.js\":\"e06315cbce0f091f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/schedule.js\":\"1d632be1d3218824\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/series.js\":\"03c84f540449ed59\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/store.js\":\"fd9df34b42414bb6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/trendAction.js\":\"fe7f659b178674e8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/perf-monitor/verdict.js\":\"492abe294a1ca766\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/plain-outliner/clickToEditAction.js\":\"70d6fb6533c1c3c9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/plain-outliner/index.js\":\"559f80ce74ecfaf5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/plain-outliner/interactions.js\":\"6c07a4ef723dae4b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d262291f8a618de5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/properties-migration/MigrationGate.js\":\"4fd8e578ed498b2c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/properties-migration/MigrationGateDialog.js\":\"9c2641c173042a52\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/properties-migration/action.js\":\"0dd063e577a7b8c7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/properties-migration/index.js\":\"2f71b2f54ab9b84d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/properties-migration/localRunMessage.js\":\"ed72dabd9a19d712\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/properties-migration/plugin.js\":\"acf1b5fedd360bc9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/properties-migration/progressReport.js\":\"2eb3b2b423720dff\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/properties-migration/sweepProgress.js\":\"a1ede013c163fab3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/property-rows/FieldRowRenderer.js\":\"335a9f9d8b1bc51f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/property-rows/ValueRowRenderer.js\":\"7a669e578ed93760\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/property-rows/actions.js\":\"d66dcef5bd5ba8e4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/property-rows/autocomplete.js\":\"18881d63f45631ad\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/property-rows/fieldRow.js\":\"1bc04f1dab17ab9a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/property-rows/index.js\":\"4dc91af757f305d5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/property-rows/referenceWarning.js\":\"d6ee7a9ce5f303c0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/property-rows/valueAutocomplete.js\":\"0d36f1f565a98a03\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/property-rows/valueSchema.js\":\"d194a5d342858833\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/quick-find/HeaderItem.js\":\"db795aefaa3a7f2c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/quick-find/QuickFind.js\":\"f91b1e5a3f4add7b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/quick-find/index.js\":\"b71946d0be7e5f04\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/quick-find/recents.js\":\"98d37f234856590f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/quick-find/resultItems.js\":\"a74ffb9e02e4e2f8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/quick-find/selection.js\":\"14e7d9068c8006f9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/quick-find/toggleStore.js\":\"65af7d9f98c7706b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/recents/HeaderItem.js\":\"e1dea1c20d69c4a2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/recents/RecentsPageBlockRenderer.js\":\"69f0c72af088cf61\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/recents/grouping.js\":\"8ca9db1cd27eda03\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/recents/index.js\":\"33088cf82218ad69\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/recents/target.js\":\"4d68f7ace8ecb76c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/codeMirrorExtensions.js\":\"9bdae2a129c51886\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/contentPrefill.js\":\"8b0e69d7bd848513\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/dataExtension.js\":\"ea4fe41a4759dae0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/index.js\":\"8abfb9c0edf2b833\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"441251ed8a40818a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/invalidation.js\":\"5c728c6852f08560\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/localSchema.js\":\"c4f70e761adc716d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/markdown/blockrefs/index.js\":\"770f541a853a7d92\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"47a08565ea3b29fb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/markdown/index.js\":\"23dafaf8c7c64bca\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/markdown/referenceNode.js\":\"c1abd5f76a757638\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/markdown/remark-reference-occurrences.js\":\"dbaa329060dfa3a2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a6d2bdbd68238308\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/markdown/wikilinks/index.js\":\"02cb9d37e2da54cd\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"580b9e4e372a83a5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a51316585fc59a8a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/mergeRetargetProcessor.js\":\"76a26a73ba4a24c5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/parseFence.js\":\"73177472d553baf5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/referenceParser.js\":\"14b6860c94141da0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/referenceProjection.js\":\"51116c6c4157bdb0\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/referencesProcessor.js\":\"5f858b19b0e60ae5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/renameProcessor.js\":\"4369edd24ca915f4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/references/spanReplacement.js\":\"2dbe0d10e94f60af\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/rich-paste/htmlToOutline.js\":\"6136c13223255cef\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/rich-paste/index.js\":\"22e7b861491cf4f3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2989e892681f8a52\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/rich-paste/pasteDecision.js\":\"b45639c3bd14aa73\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/action.js\":\"ec228fb9dcc198a1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/blockIds.js\":\"84b16db314a8702f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/content.js\":\"4e3d49e71c243abb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/effect.js\":\"546fc37a453f02c8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/ids.js\":\"2ccea8d7d43a94b2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/import.js\":\"2127755e6161d81e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/index.js\":\"afe4e6480608c099\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/plan.js\":\"998ac1f8785a2bf1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/plugin.js\":\"8edfdf784b9a0b58\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/promotion.js\":\"b6f331f38141177e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/properties.js\":\"4623ebe845663894\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/references.js\":\"71a620744fcfd228\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/report.js\":\"4c028cccbcd208d5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/roamMemo.js\":\"c0000c58292785ad\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/runtime.js\":\"e81917d6691dd94a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/schemaReconciliation.js\":\"c5dcb94a0f3c633f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/srsMarkers.js\":\"af1b293baccd2bcd\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/todo.js\":\"2bebddd2b68829f4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/typeCandidates.js\":\"5f5a86373fcc510c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/roam-import/types.js\":\"7aecf96c28136a0d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/search-health/index.js\":\"4eb05ff46c0afd76\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/search-health/store.js\":\"3e38fa46c26dc05e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/shortcut-help/HeaderItem.js\":\"8784c6e05948439b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"643664e2229939f9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/shortcut-help/index.js\":\"aa9be8940b39514b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/shortcut-help/model.js\":\"9a8f4acc547c5a2f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/shortcut-help/toggleStore.js\":\"78f5e46916b3720b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/shortcut-help/useKeyInspector.js\":\"61d5cb9f46505a69\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"84b500b741cd19f3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/spatial-navigation/ShellDecorator.js\":\"dfd55a21bb5cc213\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/spatial-navigation/actions.js\":\"dc179fa4e7b059d7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/spatial-navigation/exclusionsFacet.js\":\"30623ccf99999aec\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/spatial-navigation/index.js\":\"5a83c0a3f156ef88\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/spatial-navigation/shell.js\":\"9917ad1ab40b9efb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/spatial-navigation/surface.js\":\"df28c6e4bfa4ea05\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/spatial-navigation/walker.js\":\"03ceb3afd8b74939\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/RescheduleToast.js\":\"65109fd101623e5f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/dataExtension.js\":\"9ba98abb9fbdd1f6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/index.js\":\"fe51d6e29eb9066d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/indicator.js\":\"b7a0de1795e3a4ec\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/moveSrsState.js\":\"db70a748ca345a28\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e0ba6168e22dea47\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/scheduler.js\":\"334fb91ca30651ab\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/schema.js\":\"c1f60a6a2c5b324b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9a9102c7c2e3546b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/srsClipboard.js\":\"c7a0337a6eb7704e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"df0a6ac2256f0ba8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ef99b4a60c0a3753\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/DeckPicker.js\":\"c895f7afe914bd98\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/ReviewControls.js\":\"b0642032b23cb656\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2fa5a1524fd47242\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/ReviewSession.js\":\"2d6df08f9b37da06\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/actions.js\":\"b825dc6acaeca208\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/archive.js\":\"076d2e58a0ae2789\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/dataExtension.js\":\"8e93040f79bce035\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/deck.js\":\"8335128d5dc50818\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/dueQuery.js\":\"606d9e0775ed87b5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/gradeDecision.js\":\"56bb47367049b2e1\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/index.js\":\"8b636fc153273d61\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/keyHints.js\":\"daa5268db478368b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/reviewCardLayout.js\":\"2dc4af83c88795f8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/reviewProgress.js\":\"f1fa58921e457c71\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/schema.js\":\"b9a0d63494d9523b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/srs-review/useDueCards.js\":\"ecbd7afb854e3093\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/startup-metrics/index.js\":\"34554dce0288bd25\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/startup-metrics/record.js\":\"75997f73b8eadea2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/storage-persistence/index.js\":\"60da2816382bcd13\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/storage-persistence/persistenceStatus.js\":\"81694f21e4e12a26\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/storage-persistence/requestAction.js\":\"62e361404ea3c738\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/supertags/TypeChipsDecorator.js\":\"3f13417330362082\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/supertags/codeMirrorExtensions.js\":\"7dca51e6f3eb4e56\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/supertags/index.js\":\"e834a71497d40251\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/supertags/typeAutocomplete.js\":\"cc7036c4a2cbc965\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"37e4ac91ea74c9ca\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/swipe-quick-actions/actions.js\":\"b632b4932cc25aaa\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/swipe-quick-actions/anchor.js\":\"728c0e571ae07d1f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/swipe-quick-actions/events.js\":\"33c1938c24992e27\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/swipe-quick-actions/gestureActions.js\":\"a2dc01b7acc390e8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/swipe-quick-actions/index.js\":\"132f136b11ea760e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5de28bb31ba2c91a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/sync-metrics/collect.js\":\"63b477441bbf7f25\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/sync-metrics/index.js\":\"e9d9f56f87400586\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/sync-metrics/record.js\":\"ae1670b6b081a879\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/system-status/RejectionDialog.js\":\"b039f3eb5b21337c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1a4e8c8f59639ff9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/system-status/index.js\":\"cd4fe496bdf8159d\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/system-status/model.js\":\"318559cabdcc9bc6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/system-status/queueCounts.js\":\"29320d047ac32e5f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/system-status/rejectedHelpers.js\":\"6710a136810fdf9f\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/system-status/rematerializeAction.js\":\"f580ff4bd825acc5\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/system-status/useHysteresis.js\":\"7b50e7b6000ecea2\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/ColumnHeaders.js\":\"1c8e708cdfb05738\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/QueryUi.js\":\"13d213b73ef5c7c7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/TableLayout.js\":\"1140242387a5abe7\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/actions.js\":\"9b7cb1b6d4edc5ea\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/cellEdits.js\":\"aa5876cbefd92c8c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/columns.js\":\"5b9a1f2874eab0e6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/controller.js\":\"0a78e69b59d098c3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/convert.js\":\"c309ccaa4828b941\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/dataExtension.js\":\"33e8d4bceca52503\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/index.js\":\"43caea836fa76d5e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/keys.js\":\"1e064d6e241626c3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/model.js\":\"3c5a56bb7f8ea2cf\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/query/backfill.js\":\"6c5ffd048e3df3c4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/query/format.js\":\"a793d83c9384bcec\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/query/parse.js\":\"cf977bef592cf0a8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/query/queryValue.js\":\"2f0ee439e8672426\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/query/source.js\":\"65eddc25a6a739e6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/registry.js\":\"52b77e9960cfea63\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/schema.js\":\"d5692ba07619305e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/tables/sort.js\":\"73912fcefa4f0384\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/theme-toggle/effect.js\":\"0031ad6141ce9a01\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/theme-toggle/index.js\":\"ac1885524775a55a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/theme-toggle/theme.js\":\"551acec5f404e6b9\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/todo/actions.js\":\"b8f326fb11339bdb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/todo/dataExtension.js\":\"869015a8b234fba8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/todo/index.js\":\"a37c23b999adabdb\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/todo/schema.js\":\"677a3efb7553517e\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/touch-selection/TouchSelectionLayer.js\":\"fa51ffcd5dd38157\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/touch-selection/actions.js\":\"c49d18dca42bc1a4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/touch-selection/defaultItems.js\":\"d44c05df798833d4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/touch-selection/facet.js\":\"dadea73d7ec3daf4\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/touch-selection/holdRecognizer.js\":\"bfb0a5f0953f5e4a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/touch-selection/index.js\":\"450f64d5fccb3954\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/update-indicator/UpdateIndicator.js\":\"b6a50e8fc39a2fa6\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/update-indicator/index.js\":\"c64ff8e88f465991\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/update-indicator/loadTimes.js\":\"80c403bde4225c8b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/VideoNotesRenderer.js\":\"9d861bbaa0e13419\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/VideoPlayerRenderer.js\":\"de6dd2375bffbf2c\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/VideoTimeStamp.js\":\"e63ebc79c003475b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/actions.js\":\"a2ef7d0171324303\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/index.js\":\"2ba826c43cd87259\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/markdown.js\":\"c91933fada2c032a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/notes.js\":\"a1a86c2e0b5883cd\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/registry.js\":\"366043964362e70a\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/remark-timestamps.js\":\"6f153fbded9a9c72\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/video-player/view.js\":\"4da616405080a0bc\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/vim-link-hints/LinkHints.js\":\"52eb79e7b9e8f4da\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/vim-link-hints/index.js\":\"3ed09a41dbd02e74\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/vim-link-hints/model.js\":\"96cf3d51a7de060b\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/vim-link-hints/settings.js\":\"b2cc52f58050c3f3\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/vim-normal-mode/actions.js\":\"306d3a73c7d1f6c8\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/vim-normal-mode/index.js\":\"96e4969bea61f419\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/vim-normal-mode/interactions.js\":\"47359eb4fd4af915\",\"/knowledge-medium/pr-preview/pr-1841/src/plugins/workspace-header/index.js\":\"9007889ce9a68483\",\"/knowledge-medium/pr-preview/pr-1841/src/registerServiceWorker.js\":\"b01851143cd4fac9\",\"/knowledge-medium/pr-preview/pr-1841/src/requestPersistentStorage.js\":\"d5b1eb1d25f57155\",\"/knowledge-medium/pr-preview/pr-1841/src/services/authRequestDeadline.js\":\"cd71c5df19521078\",\"/knowledge-medium/pr-preview/pr-1841/src/services/authStorage.js\":\"1afb43c1b2490ea5\",\"/knowledge-medium/pr-preview/pr-1841/src/services/powersync.js\":\"7af970064dd258ca\",\"/knowledge-medium/pr-preview/pr-1841/src/services/supabase.js\":\"40485b5250980d40\",\"/knowledge-medium/pr-preview/pr-1841/src/services/uploadErrorClassifier.js\":\"38c8628e662c816d\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/ActiveContexts.js\":\"b333e9eb67825635\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/HotkeyReconciler.js\":\"58fda799a6d2785f\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/WipeLocalDataDialog.js\":\"757f1b2c3b650d4e\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/actionDispatch.js\":\"4c97e1e60cc89a90\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/actionRefItems.js\":\"e43dac4df7b899c2\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/applyKeybindingOverrides.js\":\"27ad1166da54fe84\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/blockActions.js\":\"cf32393f77fcfb4e\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/canonicalizeChord.js\":\"db7118e6ee6d0eac\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/defaultContexts.js\":\"abc8a8e9c20742a3\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/defaultShortcuts.js\":\"e6008e1650e9d4b9\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/effectiveActions.js\":\"d2c999b85a681140\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/gestureAction.js\":\"1ee9577f71748ff8\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/gestureBinding.js\":\"a5e97aae31860d94\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/holdRegistry.js\":\"9dcb595674b558bd\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/keybindingConflicts.js\":\"d216f529cee8f854\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/keybindingOverrides.js\":\"b4902bd45175d3ea\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/pointerAction.js\":\"3d6aa18d5a122e73\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/resolve.js\":\"33769e86a2e85c03\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/runAction.js\":\"bed438ece781fa04\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/sequenceMatcher.js\":\"e9dee40a80c89f65\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/types.js\":\"6a04684ce4a19b1a\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/useActionContext.js\":\"4875c88f677c8559\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/useActionDiscovery.js\":\"3d3bc1c7bd2da718\",\"/knowledge-medium/pr-preview/pr-1841/src/shortcuts/utils.js\":\"0d894b953a4ae436\",\"/knowledge-medium/pr-preview/pr-1841/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1841/src/sw/bootStore.js\":\"46be75a84190ed44\",\"/knowledge-medium/pr-preview/pr-1841/src/sw/previewDatabases.js\":\"6a798c8b38825821\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/byteTransform.js\":\"bf86c98d33f7287f\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/attachmentCleaner.js\":\"11346b97d9990446\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/bundle/attachmentParts.js\":\"f05f3f4a048cbd23\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/bundle/bundleParts.js\":\"0441a4c2b08519af\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/bundle/bundleRecord.js\":\"44f6a95b6778aef2\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/bundle/manifest.js\":\"ba5d1b5f513b0f40\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/bundle/takeBundle.js\":\"38ed9bcec7f9c8ab\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/bundle/verifyBundle.js\":\"5d4dbb733f823536\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/cleaningStage.js\":\"d2d73ac1c62f1c32\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/conversionKey.js\":\"8af06eecad180f8e\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/conversionServer.js\":\"7467b75c04d4520b\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/flip.js\":\"eec209623a2ca1b9\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/flipAttempts.js\":\"3cbc9bdca6031e81\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/pages.js\":\"29b4afec2e0aed31\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/preflight.js\":\"3e506fb551a86779\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/reseal.js\":\"b164b3c87a781a7d\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/runConversion.js\":\"fc14a58c31669c7a\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/runLock.js\":\"ab5ce03e49fa2277\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/sealing.js\":\"c345e5e9674696ad\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/sealingStage.js\":\"e373bbc114834dad\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/stage.js\":\"1b47b1ee6b63eb12\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/conversion/verifyReseal.js\":\"75c1b44b13be8bdd\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/aad.js\":\"3ece08cfcb498e7d\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/aead.js\":\"605937e8eff37a2f\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/base32.js\":\"0b0db2f89fc94e79\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/base64url.js\":\"87a3371eb81db368\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/binaryEnvelope.js\":\"f464a8a84973f10c\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/byteAead.js\":\"92a09bd212515648\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/canary.js\":\"88a2bc0f754f1bbc\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/contentHash.js\":\"cd51e6d15b8e19bc\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/contentKey.js\":\"53bbdc6fc0c05518\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/derivedIdNamespace.js\":\"b5e6a5ebc55144cb\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/envelope.js\":\"766e331d62283e2a\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/hex.js\":\"44af7e2c964f2820\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/sha256Hex.js\":\"2c48936ece16a162\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/crypto/workspaceKey.js\":\"1a57cfc092290e0e\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/conversionState.js\":\"e2815daff9171a10\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/flows/createEncryptedWorkspace.js\":\"415854a38163b5b9\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/flows/pastedKey.js\":\"890509e63b78dbfe\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c1852802968b0686\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b285e69f610837b7\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/keyStore.js\":\"a080b728ce8f2a9f\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/mintWorkspaceKey.js\":\"d369f90040b452db\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/modePin.js\":\"3c3a3d7930460ef6\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/openWorkspaceKeys.js\":\"41d5487bacb4c25b\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/resolveWorkspaceEntry.js\":\"518e08bb402ca130\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/resolver.js\":\"a4a985e73abeae41\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/keys/workspaceAccess.js\":\"9d94287eaf4ac9c5\",\"/knowledge-medium/pr-preview/pr-1841/src/sync/transform.js\":\"11f8506a0a2ab3c0\",\"/knowledge-medium/pr-preview/pr-1841/src/themeBootDefaults.js\":\"f787bddb288207e4\",\"/knowledge-medium/pr-preview/pr-1841/src/types.js\":\"1f90acf3037f964b\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/ClientLocalSettings.js\":\"dabdd7495ac8cf4c\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/abortableSleep.js\":\"388ea695eb27abd1\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/array.js\":\"4845397f98ecdf84\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/backlinkAutocomplete.js\":\"d8fff24d38fbc7e0\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/blockCrumbs.js\":\"ee063444c935cef2\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/blockrefAutocomplete.js\":\"2cbeead58bebbca9\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/cadencedIdleJob.js\":\"a86f3dd35b51332c\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/callbackSet.js\":\"2da0f4b7f77f2c9c\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/clientId.js\":\"1c086d07f8057e6e\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/codemirror.js\":\"ef6dccb19d839621\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/codemirrorCompletion.js\":\"4fc53d77d6ea391c\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/copy.js\":\"340abd0ac37d67a7\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/dailyPage.js\":\"48490b004adc9661\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/dbForensics.js\":\"6d10d1acb3a77a0f\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/dbForensicsHooks.js\":\"491b70ba462126f4\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/deleteBlockThroughUi.js\":\"23c28d440e91e5eb\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/dialogs.js\":\"4b1566eee4d9b629\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/dom.js\":\"ae6ccfd15027d90d\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/downloadBlob.js\":\"80288498d957bc79\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/exportSqliteDb.js\":\"24d45a25bf1f79a4\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/fileSystemAccess.js\":\"050cefcf84eec9fd\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/flipSlide.js\":\"17257ce6e0f9beea\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/fnv1a.js\":\"c808ad3d175471f4\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/formatBytes.js\":\"23b7a41594a3e843\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/fuzzyRank.js\":\"83e39053eaf3b5bf\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/idbKeyedStore.js\":\"f3d35be2ccce69c4\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/idleCallbackPolyfill.js\":\"3001680c59104a58\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/keyboardAwareScroll.js\":\"3344e142c3e4807a\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/keyboardViewport.js\":\"b7a39a95bfa9cec9\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/lastWorkspace.js\":\"252d2a28c29c847a\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/layoutColumns.js\":\"ca653f27cb0af8e1\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/layoutSessionDom.js\":\"8c1b0328c0210158\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/layoutSessionId.js\":\"8a86c82cbd5fbb3f\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/linkClickGestures.js\":\"b60aa141b88a53cc\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/linkTargetAutocomplete.js\":\"dff93d3c9a5badf1\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/localDbCorruption.js\":\"41ea175491ed2535\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/localDbRecovery.js\":\"796a36bf2b67f213\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/markdownParser.js\":\"1836d388f73a8a9e\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/memoize.js\":\"81abc5b2d2ecd5ab\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/nameFieldCommit.js\":\"4d9d9ef44c855117\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/nameList.js\":\"98163bf5840139ad\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/navigation.js\":\"53238f702790c712\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/omnilinerNamespace.js\":\"087b56eec46aad0a\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/opfsPageScan.js\":\"8f280686de279d6e\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/panelClearance.js\":\"0f1d15f4484c7106\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/panelHistory.js\":\"a35def8ba0f918c0\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/panelLanes.js\":\"eae4b72ce23e9f48\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/panelLayoutProjection.js\":\"995654a8cb0bd833\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/panelScrollAnchor.js\":\"eec13fa898d39383\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/panelUrlFlags.js\":\"4535902e52430f71\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/platform.js\":\"60299cb420f72f30\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/pluralize.js\":\"cfa2465b6f9f3f61\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/propertyCreation.js\":\"4cfa0286c67096d6\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/propertyNavigation.js\":\"e0ecae46986c986b\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/propertyValueContext.js\":\"5c58fd8fdd9322c3\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/react.js\":\"34c334fe781f3706\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/relativeDate.js\":\"3dc4c643f1f5e51e\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/relativeTime.js\":\"65766f9853e3c732\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/renderScope.js\":\"84d2970ed666cdaa\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/resolvedThenable.js\":\"f79b4dde1a217e1a\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/routing.js\":\"e0caef3a2c750051\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/safeMode.js\":\"36d22bc263dce1d0\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/scheduleIdle.js\":\"58cf306fb9b4a4f8\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/screenWakeLock.js\":\"29f9b17b450a698b\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/selection.js\":\"4fe06eebf9f813ee\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/softKeyboardGrab.js\":\"c8c74092614fdc97\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/startupTimeline.js\":\"167fa2dafae411fe\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/state.js\":\"fc00dd8de669f231\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/string.js\":\"ea16540818180c30\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/surfaceZoom.js\":\"0c5abaa23101a948\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/time.js\":\"03e01c499b9caaba\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/toast.js\":\"1e882ebc10f4b246\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/toggleStore.js\":\"0088f3857810c48d\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/untilStopped.js\":\"c2c7a9879cb7ed36\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/userActivity.js\":\"c5d5fe8f498b15f4\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/viewTransition.js\":\"9282f4b4e50a1639\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/viewport.js\":\"04953e082e0f8476\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/webLock.js\":\"a453b65e793b7c9b\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/workspaceRecovery.js\":\"dd3b7cd388dad72d\",\"/knowledge-medium/pr-preview/pr-1841/src/utils/workspaceSnapshotStore.js\":\"3d94b6643e442cbe\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-compiler-runtime.js\":\"b3ee998d3d92a9bb\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-dom-client.js\":\"80259c6053ed13a1\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-dom-server-edge.js\":\"e0f4bd8f479bfebc\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-dom-server.js\":\"7837a6a5578286bd\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-dom-static-edge.js\":\"34ee717e75ef12a4\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-dom-static.js\":\"ba7433b8f216c7d4\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-dom-test-utils.js\":\"fd71fcc4c3c46ab9\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-dom.js\":\"4d8f78e0412eac25\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react-jsx-runtime.js\":\"b680e79cb451bffe\",\"/knowledge-medium/pr-preview/pr-1841/src/vendor/react.js\":\"d71a12bd05783fa9\",\"/knowledge-medium/pr-preview/pr-1841/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1841/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1841/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
