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
		buildId: "6e72ca65f704-99f8537b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1842/\":\"aae15d279e94253a\",\"/knowledge-medium/pr-preview/pr-1842/index.html\":\"aae15d279e94253a\",\"/knowledge-medium/pr-preview/pr-1842/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1842/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1842/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1842/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1842/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1842/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1842/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1842/assets/FacadeVFS-CowLmFZC.js\":\"c8b5a1cbeece691d\",\"/knowledge-medium/pr-preview/pr-1842/assets/OPFSCoopSyncVFS-DXcSNWvh.js\":\"0f408d0735c9630b\",\"/knowledge-medium/pr-preview/pr-1842/assets/OPFSWriteAheadVFS-fnG4ajLn.js\":\"7258a87349f5efe9\",\"/knowledge-medium/pr-preview/pr-1842/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1842/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1842/assets/wa-sqlite-async-CDDvoVGi.js\":\"ad17a274ccd0018f\",\"/knowledge-medium/pr-preview/pr-1842/assets/wa-sqlite-p8gcsP6V.js\":\"3f59524f1b0a38b6\",\"/knowledge-medium/pr-preview/pr-1842/assets/worker-Dvz6YXG5.js\":\"9d3921543fa6936f\",\"/knowledge-medium/pr-preview/pr-1842/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1842/chunks/app-D-G6uRcc.js\":\"485a48ce010f94cb\",\"/knowledge-medium/pr-preview/pr-1842/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1842/index.js\":\"7377664ef33f8eb1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1842/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1842/assets/AccessHandlePoolVFS-DAGnM2_0.js\":\"43a6e26c19a482fc\",\"/knowledge-medium/pr-preview/pr-1842/assets/IDBBatchAtomicVFS-CqaoMSYT.js\":\"dc2b0742a167af63\",\"/knowledge-medium/pr-preview/pr-1842/assets/MemoryVFS-zwUyOtVJ.js\":\"29203acaeaadb4c3\",\"/knowledge-medium/pr-preview/pr-1842/assets/mc-wa-sqlite-CDR5-LHa.js\":\"4f8e40f606e5ede0\",\"/knowledge-medium/pr-preview/pr-1842/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1842/assets/mc-wa-sqlite-async-4HoTYio9.js\":\"276cab0a8b9fa75e\",\"/knowledge-medium/pr-preview/pr-1842/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1842/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1842/chunks/AccessHandlePoolVFS-CObxNyL2.js\":\"023b75aa2b04c4f5\",\"/knowledge-medium/pr-preview/pr-1842/chunks/FacadeVFS-CiQbw7cC.js\":\"395cb0df44ad5b58\",\"/knowledge-medium/pr-preview/pr-1842/chunks/IDBBatchAtomicVFS-CGiZn4jW.js\":\"ccc94205ed8975cb\",\"/knowledge-medium/pr-preview/pr-1842/chunks/MemoryVFS-xM6rVsJp.js\":\"15bcb13c70a53b18\",\"/knowledge-medium/pr-preview/pr-1842/chunks/OPFSCoopSyncVFS-CQRuIOe5.js\":\"0c2f5e76e13689b1\",\"/knowledge-medium/pr-preview/pr-1842/chunks/OPFSWriteAheadVFS-DxKCMzT3.js\":\"f96ce6ff50cbcdf3\",\"/knowledge-medium/pr-preview/pr-1842/chunks/Preview-CFyR1Dky.js\":\"db5d99e0ed2fe201\",\"/knowledge-medium/pr-preview/pr-1842/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1842/chunks/card-DczP5gWe.js\":\"c612a1f7668ce647\",\"/knowledge-medium/pr-preview/pr-1842/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1842/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1842/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1842/chunks/dist-CALJdZQm.js\":\"24b89682ad45b465\",\"/knowledge-medium/pr-preview/pr-1842/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1842/chunks/mc-wa-sqlite-B3DdZoWk.js\":\"883336a4e8769a0c\",\"/knowledge-medium/pr-preview/pr-1842/chunks/mc-wa-sqlite-async-BWAhLiGA.js\":\"1a03bb3a4bd0a2d8\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-7ix9OXmN.js\":\"0fd8b960e5978180\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-BZCAMXwX.js\":\"0b663ae2c9705757\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-Cd8L2IGJ.js\":\"9aa92e374ef2ea3b\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-DHPcblpp.js\":\"f36c802bed06f5b2\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-M257eu8X.js\":\"50aae567f4fc79d1\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-VSwvDKis.js\":\"4e83203556e8a431\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-_PA3dE3a.js\":\"f71e4afb3ccb76f1\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-dom-server-legacy.browser.production-BPw7WHkH.js\":\"5421d38de5d454d7\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-dom-server.browser.production-vzHOPQUy.js\":\"f330e519ba706ddf\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-dom-server.edge.production-C1L83JPG.js\":\"81a06bd1b9b72775\",\"/knowledge-medium/pr-preview/pr-1842/chunks/react-oyYtLwjt.js\":\"043cec4592069340\",\"/knowledge-medium/pr-preview/pr-1842/chunks/server.browser-DZ-N0O6v.js\":\"38a3cb109277df4c\",\"/knowledge-medium/pr-preview/pr-1842/chunks/textarea-wuSxakmZ.js\":\"21acce379b25fcb6\",\"/knowledge-medium/pr-preview/pr-1842/chunks/ui-D1MnvX2q.js\":\"9f435942dfc5c19f\",\"/knowledge-medium/pr-preview/pr-1842/chunks/wa-sqlite-PQl6UXMZ.js\":\"c92b5b07dd7241b9\",\"/knowledge-medium/pr-preview/pr-1842/chunks/wa-sqlite-async-WGdbXdS2.js\":\"a4e410a45ddfecb2\",\"/knowledge-medium/pr-preview/pr-1842/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1842/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1842/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1842/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1842/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1842/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1842/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1842/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1842/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1842/src/App.js\":\"7542b3a9d1476262\",\"/knowledge-medium/pr-preview/pr-1842/src/appUpdate.js\":\"ef496cf6f30fb915\",\"/knowledge-medium/pr-preview/pr-1842/src/appVersion.js\":\"5ad89068e6511a68\",\"/knowledge-medium/pr-preview/pr-1842/src/bootstrap/initialLayout.js\":\"f2ec3614b7b9e633\",\"/knowledge-medium/pr-preview/pr-1842/src/bootstrap/openWorkspaceData.js\":\"e31bdaa38a4fb6f9\",\"/knowledge-medium/pr-preview/pr-1842/src/bootstrap/resolveWorkspace.js\":\"cbb6b5d3f2cae187\",\"/knowledge-medium/pr-preview/pr-1842/src/bootstrap/workspaceBootstrap.js\":\"f2777e23b44f2435\",\"/knowledge-medium/pr-preview/pr-1842/src/components/BlockComponent.js\":\"d12aeee7a0545ca3\",\"/knowledge-medium/pr-preview/pr-1842/src/components/BlockCrumbs.js\":\"116fbe3e2cd430c1\",\"/knowledge-medium/pr-preview/pr-1842/src/components/BlockEditor.js\":\"2618389cf5fbfa2f\",\"/knowledge-medium/pr-preview/pr-1842/src/components/BlockLoadingPlaceholder.js\":\"ed5cf53df76f8707\",\"/knowledge-medium/pr-preview/pr-1842/src/components/BlockProperties.js\":\"e880ee5b90831a11\",\"/knowledge-medium/pr-preview/pr-1842/src/components/BlockSearchPicker.js\":\"dfaa8a6a6df5a8da\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ConfirmBulkDeleteDialog.js\":\"6c748aef4c94ae7f\",\"/knowledge-medium/pr-preview/pr-1842/src/components/DividerHandle.js\":\"f6de337f9c99d2b1\",\"/knowledge-medium/pr-preview/pr-1842/src/components/DraftEditor.js\":\"c14d090126c12708\",\"/knowledge-medium/pr-preview/pr-1842/src/components/GutterPill.js\":\"735d1881149762df\",\"/knowledge-medium/pr-preview/pr-1842/src/components/Header.js\":\"775cd3c11d3b4ecb\",\"/knowledge-medium/pr-preview/pr-1842/src/components/LazyBlockComponent.js\":\"2e1dda77800336c2\",\"/knowledge-medium/pr-preview/pr-1842/src/components/Login.js\":\"a989023992751c46\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ZoomableSurface.js\":\"ceb817b627f1117f\",\"/knowledge-medium/pr-preview/pr-1842/src/components/editModeKeepalive.js\":\"a4b80b73ad32f1c8\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyDisplay/PropertyDisplayScope.js\":\"5b7df19265480e39\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7cc8ba7dda5d37e1\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyEditors/RefPropertyEditor.js\":\"29c251ad2ebf1e1a\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyEditors/RefTargetTypePicker.js\":\"8dbf0f558fdd5d9e\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyEditors/SelectPropertyEditor.js\":\"9b736eebc296fb0c\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyEditors/TypesPropertyEditor.js\":\"85037a7697837d31\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyEditors/defaults.js\":\"d39c1f987c5accb7\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyEditors/kernelValuePresets.js\":\"6385d7462f66c3b4\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyEditors/selectablePresets.js\":\"fc443ddcc2c4f0e1\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyEditors/typesPropertyUi.js\":\"d9d4d5761a08c74e\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/AddPropertyForm.js\":\"31126dc4ff363df9\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/PropertyPicker.js\":\"55f60420a49025bb\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/PropertyRow.js\":\"57271455d131f813\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/Rows.js\":\"b141ff779b033b3f\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/actions.js\":\"cb9d03839e8525c0\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/declarationOnly.js\":\"dda94901f6adc430\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/layout.js\":\"fe04b3dacc34c8b5\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/model.js\":\"b846cfdf4e5b9683\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/shapeUi.js\":\"a7c988ae43aaf3d7\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/shapes.js\":\"a40f44f70cd74fec\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a4441ef6d595ef82\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanel/visibility.js\":\"dde80ec8fd3ee0ea\",\"/knowledge-medium/pr-preview/pr-1842/src/components/propertyPanelSections.js\":\"99c4572fb86d108e\",\"/knowledge-medium/pr-preview/pr-1842/src/components/references/BlockEmbed.js\":\"1ea4f536fc829792\",\"/knowledge-medium/pr-preview/pr-1842/src/components/references/BlockLink.js\":\"5fd13eb1c5e21a90\",\"/knowledge-medium/pr-preview/pr-1842/src/components/references/BlockRef.js\":\"f9adf576c9d83913\",\"/knowledge-medium/pr-preview/pr-1842/src/components/references/ReferenceLink.js\":\"9dff7d1f8571181e\",\"/knowledge-medium/pr-preview/pr-1842/src/components/references/cycleGuard.js\":\"c9563980539e96b5\",\"/knowledge-medium/pr-preview/pr-1842/src/components/references/cycleGuardContext.js\":\"c39124e8fb9df6fe\",\"/knowledge-medium/pr-preview/pr-1842/src/components/references/linkInteraction.js\":\"ca717dd8d23e4b7c\",\"/knowledge-medium/pr-preview/pr-1842/src/components/references/referenceLayout.js\":\"4b73a13c6c7b5d67\",\"/knowledge-medium/pr-preview/pr-1842/src/components/references/useBlockRefAncestors.js\":\"47792cc4cb278eeb\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/BlockGutter.js\":\"6ed0706795595216\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/BlockInfoDialog.js\":\"25f6609aa051a75c\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/BlockTypeBlockRenderer.js\":\"9abe3b71c4a3287a\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/BulletHoverCard.js\":\"582b97703565c660\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/CodeMirrorContentRenderer.js\":\"b3b1f3d13bcc1b84\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c7b8fc27be5ce194\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/ColumnResizeHandles.js\":\"2be946b88033268c\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b049c628b2bfc7cb\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/DefaultBlockRenderer.js\":\"a5fa1b6b3007ba91\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/LayoutRenderer.js\":\"d8f46315fd4e5521\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/MarkdownContentRenderer.js\":\"442be29eaea4e7e0\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/MissingDataRenderer.js\":\"b08bf07a8c3f3202\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/PanelRenderer.js\":\"a23cc0e2975c5ea1\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/PropertySchemaBlockRenderer.js\":\"52ddea9de2bc8d19\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/TopLevelRenderer.js\":\"3f49152d2db1ac49\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/blockGutterMode.js\":\"dc64b39c52a889a6\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/blockTitleText.js\":\"d1f1a2c5e2f7ad32\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/fieldCreationKeydown.js\":\"6c090a6b8f0fbbf6\",\"/knowledge-medium/pr-preview/pr-1842/src/components/renderer/layoutRootContext.js\":\"9da758e4fb57a545\",\"/knowledge-medium/pr-preview/pr-1842/src/components/typeChip/TypeChip.js\":\"898442c2f5d29e05\",\"/knowledge-medium/pr-preview/pr-1842/src/components/typeChip/chipStyle.js\":\"888bddd4e4bd1cab\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/anchored-floating.js\":\"d8558fd738fa78fb\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/button.js\":\"b0f861da9e3caa3b\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/card.js\":\"3494ba5f2c9bebab\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/checkbox.js\":\"32db88853cc9d2fc\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/collapsible.js\":\"d867c260ca8a0fa7\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/command.js\":\"e2d31717cf148581\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/context-menu.js\":\"d31d9a3fa6eb8060\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/dialog.js\":\"5924fae3a61cd6e4\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/dropdown-menu.js\":\"24a3a8ff50abd857\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/floating-listbox.js\":\"9166912c87dd45d3\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/index.js\":\"6bcb16a7c4a7decf\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/input.js\":\"e9b645728e74c2d7\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/kbd.js\":\"8cb9e9ec5162ffc8\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/label.js\":\"1b6f539ee8670d7c\",\"/knowledge-medium/pr-preview/pr-1842/src/components/ui/textarea.js\":\"557694de159aa792\",\"/knowledge-medium/pr-preview/pr-1842/src/components/useEditModeYieldKeepalive.js\":\"48a8f841318243f7\",\"/knowledge-medium/pr-preview/pr-1842/src/components/util/BootFallback.js\":\"66a445589b1950f5\",\"/knowledge-medium/pr-preview/pr-1842/src/components/util/FocusedRowLazyMount.js\":\"17aac6db624caf74\",\"/knowledge-medium/pr-preview/pr-1842/src/components/util/LazyViewportMount.js\":\"f484ca5145c0a77e\",\"/knowledge-medium/pr-preview/pr-1842/src/components/util/LocalDbCorruptionFallback.js\":\"f3b15dba0f039043\",\"/knowledge-medium/pr-preview/pr-1842/src/components/util/error.js\":\"12d1f5d0b7174d4d\",\"/knowledge-medium/pr-preview/pr-1842/src/components/util/lazyMountRegistry.js\":\"8c0daa2abd54c0ee\",\"/knowledge-medium/pr-preview/pr-1842/src/components/util/suspense.js\":\"192851a60d856454\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/CreateWorkspaceDialog.js\":\"e5e7833b48d2d87d\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/PendingInvitations.js\":\"354c36fba9e8a064\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/SyncProgress.js\":\"307b93738e17d048\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/UnlockProgress.js\":\"2f266907662111aa\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/WorkspaceKeyGate.js\":\"9154082fa68a2011\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/WorkspaceSettingsDialog.js\":\"5a5ab3d42cda1f84\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/WorkspaceSwitcher.js\":\"eefeb2bde537cb7b\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/WorkspaceSyncGate.js\":\"fd338ec260072a1e\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/conversion/ConversionFlow.js\":\"ce2cc8166e7158ca\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/conversion/ConversionFlowHost.js\":\"6719b3271b369b41\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/conversion/EncryptionSection.js\":\"5b89bc964f5eef0c\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/conversion/attachmentPrompts.js\":\"ee51a69851af15e9\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3833705071275d6e\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/conversion/conversionFlowDeps.js\":\"45fa9000d4d20409\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/conversion/conversionFlowStore.js\":\"9f84b9e1fdf03075\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/conversion/flowUi.js\":\"b75a9d02dadbf7bf\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/conversion/useConversionRun.js\":\"10007236791cf2c3\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/keyUi.js\":\"15415b7a17140477\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/useCloseOnKeyLoss.js\":\"d348e820aefc33dd\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/useCloseOnServerE2ee.js\":\"467b70ff881a237e\",\"/knowledge-medium/pr-preview/pr-1842/src/components/workspace/workspaceUnlocked.js\":\"eda294c1462f67b3\",\"/knowledge-medium/pr-preview/pr-1842/src/context/backgroundSubtree.js\":\"96a97468df4dc005\",\"/knowledge-medium/pr-preview/pr-1842/src/context/block.js\":\"3d49a067fa184ae0\",\"/knowledge-medium/pr-preview/pr-1842/src/context/layoutWsContext.js\":\"1203b1738ffd7efc\",\"/knowledge-medium/pr-preview/pr-1842/src/context/propertyDisplay.js\":\"480ac6c99ba969e8\",\"/knowledge-medium/pr-preview/pr-1842/src/context/repo.js\":\"fa71147b9a4d690f\",\"/knowledge-medium/pr-preview/pr-1842/src/data/aliasClaim.js\":\"3c5ec87e27f2b46a\",\"/knowledge-medium/pr-preview/pr-1842/src/data/aliasSeatNamespace.js\":\"49f2cf44d2dc32eb\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/blockData.js\":\"a9354103dd51857e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/blockType.js\":\"ef0c7ad039dbb52b\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/changeScope.js\":\"903cd5894725cbbd\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/codecs.js\":\"078a91ee72bf9828\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/derivedData.js\":\"9fb59ee1bb0cbaeb\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/errors.js\":\"2fbd7602852a0371\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/events.js\":\"f1db5117857f6a37\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/handle.js\":\"5c3301f162bc8f10\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/index.js\":\"88bb65eb9a4b5188\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/mutator.js\":\"eb68044c56beb533\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/processor.js\":\"3135b881b33af106\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/propertySchema.js\":\"339b2e9e68e1ad70\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/query.js\":\"ee9bfbbb1ae979c8\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/sameTxProcessor.js\":\"9a8734bee0fb80b3\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/schema.js\":\"5c3301f162bc8f10\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/tx.js\":\"5c3301f162bc8f10\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/typedBlockQuery.js\":\"d6369797199d4783\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/user.js\":\"2452e83ccd3eacf4\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/valuePresetCore.js\":\"403c3da2c200d4a7\",\"/knowledge-medium/pr-preview/pr-1842/src/data/api/valuePresets.js\":\"226f9226caf33dd4\",\"/knowledge-medium/pr-preview/pr-1842/src/data/attachmentCleanerIOVerb.js\":\"cdadd1b6d5a70db5\",\"/knowledge-medium/pr-preview/pr-1842/src/data/block.js\":\"dcb595fbe75fbc73\",\"/knowledge-medium/pr-preview/pr-1842/src/data/blockCache.js\":\"d317d27546ab0e6a\",\"/knowledge-medium/pr-preview/pr-1842/src/data/blockId.js\":\"9a4bdc8719fdb49e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/blockLiveness.js\":\"1d43136175b0a662\",\"/knowledge-medium/pr-preview/pr-1842/src/data/blockMerge.js\":\"b659544aa7f8299c\",\"/knowledge-medium/pr-preview/pr-1842/src/data/blockSchema.js\":\"7153dbdb1005b4b1\",\"/knowledge-medium/pr-preview/pr-1842/src/data/blockTypeLookup.js\":\"07202090141baaf9\",\"/knowledge-medium/pr-preview/pr-1842/src/data/blockTypes.js\":\"ea4af91cbc386c9b\",\"/knowledge-medium/pr-preview/pr-1842/src/data/clientContext.js\":\"9e708743ebfb66b0\",\"/knowledge-medium/pr-preview/pr-1842/src/data/dbFileSiblings.js\":\"678c2bd72c9ec067\",\"/knowledge-medium/pr-preview/pr-1842/src/data/definitionSeeds.js\":\"d44c6f1a657b32e2\",\"/knowledge-medium/pr-preview/pr-1842/src/data/derivedIds.js\":\"206d4d47795142cc\",\"/knowledge-medium/pr-preview/pr-1842/src/data/drawnSubtree.js\":\"663e22b011fa1cac\",\"/knowledge-medium/pr-preview/pr-1842/src/data/facetBridge.js\":\"6e41e0deb8d8d286\",\"/knowledge-medium/pr-preview/pr-1842/src/data/facets.js\":\"b2a8c23cc91c3de9\",\"/knowledge-medium/pr-preview/pr-1842/src/data/globalState.js\":\"c0d29b0ee03a9b26\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/aliasClaimRederiveProcessor.js\":\"25045f9c5fde71bd\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/ancestorBatch.js\":\"06caec2d19739993\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/blockTypeTypeifyProcessor.js\":\"10b4b54714ea04b6\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/clientSchema.js\":\"e6437460e26e2b69\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/commitPipeline.js\":\"368607422154b668\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/devAssertions.js\":\"b4a720fb11c11c6c\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/firstSync.js\":\"df6326934ae36b3b\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/freshInitialLoad.js\":\"01aae78fcc23e5fd\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/graphBackfillClaim.js\":\"82f58aad752a7727\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/handleStore.js\":\"877322cde64ca402\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/idleMarkerJobs.js\":\"06853320735a4eb8\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/initialDownload.js\":\"b5de72adb1cfb200\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/initializeClientDatabase.js\":\"9fdb5ef6003ac48a\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/jsonCanonical.js\":\"1648680db11e5121\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/kernelInvalidation.js\":\"31bd01e3164d31d4\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/kernelProcessors.js\":\"8a7a1262b711869e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/kernelQueries.js\":\"488bdfde987d43cf\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/mergeTypeMembershipProcessor.js\":\"ba45df914216639d\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/normalizeReferencesProcessor.js\":\"02df46fded3ed4da\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/poolInstrumentation.js\":\"494444489b78574f\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/processorRunner.js\":\"bf82a2033efc5116\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/propertyCellBackfill.js\":\"d04fb65f49911924\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/propertyChildMint.js\":\"0c30338ad11c5db7\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/propertyChildrenProcessor.js\":\"bf82d4d1c35daaf5\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8de0d393a31e7908\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/propertyDefinitionSynthesis.js\":\"7ad7063342b1e879\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/propertyKeyScan.js\":\"9c30247269908e05\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/propertySchemaResolution.js\":\"2c9002545283b726\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/propertyValueEdits.js\":\"c157177ed6dbd2e5\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/raiseProtocol.js\":\"57abbede9e589e39\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/readBatch.js\":\"b32e3689d3d472da\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/refProjection.js\":\"39d16243fd0ff139\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/referenceTargetLookups.js\":\"8227f48b13d887da\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/referenceTargetProcessor.js\":\"47b3a672c8f45a56\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/replayMerge.js\":\"e93c5d42581349a9\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/sqlBinds.js\":\"f11edb9a78edc553\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6c0a0df7b05e27f9\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/syncObserver/arrivalProcessors.js\":\"add8aa42a4660cba\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/syncObserver/invalidate.js\":\"382ae032a41cb7ae\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/syncObserver/materialize.js\":\"7d453e6d6968ca53\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/syncObserver/observer.js\":\"92b5aea0a3fe7374\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/syncObserver/reconcile.js\":\"b831d246f57ec6d7\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/timingMetrics.js\":\"6c9251637238327e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/treeQueries.js\":\"46bc6c871fbb5a12\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/txEngine.js\":\"5f4cff56e8937e8a\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/txSnapshots.js\":\"62e2ee6602cb0140\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/typedBlockQuery.js\":\"c4cafd9f679124b3\",\"/knowledge-medium/pr-preview/pr-1842/src/data/internals/undoManager.js\":\"6ee0821a66ccc7e0\",\"/knowledge-medium/pr-preview/pr-1842/src/data/invalidation.js\":\"fd24e2bff892904e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/kernelDataExtension.js\":\"d33e31c315e993a5\",\"/knowledge-medium/pr-preview/pr-1842/src/data/kernelPage.js\":\"8ede3b733476fd53\",\"/knowledge-medium/pr-preview/pr-1842/src/data/kernelValuePresetCores.js\":\"19c7066119382879\",\"/knowledge-medium/pr-preview/pr-1842/src/data/localDbCorruptionSignal.js\":\"8884aa55dd9ca88d\",\"/knowledge-medium/pr-preview/pr-1842/src/data/localDbStorage.js\":\"0d0483fc77584b35\",\"/knowledge-medium/pr-preview/pr-1842/src/data/localDbVfs.js\":\"a9c79bb8561159c7\",\"/knowledge-medium/pr-preview/pr-1842/src/data/localSchema.js\":\"d1e929144f658118\",\"/knowledge-medium/pr-preview/pr-1842/src/data/maintenance.js\":\"1601736899144fc1\",\"/knowledge-medium/pr-preview/pr-1842/src/data/mergeProperties.js\":\"a08be07766a0ada1\",\"/knowledge-medium/pr-preview/pr-1842/src/data/metricsConsoleHook.js\":\"b928e00dbacb4e8c\",\"/knowledge-medium/pr-preview/pr-1842/src/data/migrationsPage.js\":\"90910971e62539e4\",\"/knowledge-medium/pr-preview/pr-1842/src/data/mutators.js\":\"457526d3bf502c57\",\"/knowledge-medium/pr-preview/pr-1842/src/data/orderKey.js\":\"3a4dd180f5b466e3\",\"/knowledge-medium/pr-preview/pr-1842/src/data/orderKeyPlacement.js\":\"acbe914862402c64\",\"/knowledge-medium/pr-preview/pr-1842/src/data/outlineSurface.js\":\"43d2992b7ad31f1b\",\"/knowledge-medium/pr-preview/pr-1842/src/data/pendingEditorContent.js\":\"706ccf0e6757d5ea\",\"/knowledge-medium/pr-preview/pr-1842/src/data/pendingUploadsSql.js\":\"064782c30d431f80\",\"/knowledge-medium/pr-preview/pr-1842/src/data/pluginStateExtensions.js\":\"3448a7c66bc28ce6\",\"/knowledge-medium/pr-preview/pr-1842/src/data/powerSyncLogger.js\":\"073c3964bbd05d53\",\"/knowledge-medium/pr-preview/pr-1842/src/data/projectorRuntime.js\":\"171488e0193bc691\",\"/knowledge-medium/pr-preview/pr-1842/src/data/properties.js\":\"e23f0f0eaabbba57\",\"/knowledge-medium/pr-preview/pr-1842/src/data/propertiesPage.js\":\"a3338a277c8fcdfe\",\"/knowledge-medium/pr-preview/pr-1842/src/data/propertyChildren.js\":\"b4be86fd7021e2f8\",\"/knowledge-medium/pr-preview/pr-1842/src/data/propertyDefinitionFanout.js\":\"0ed8fd5053dffa56\",\"/knowledge-medium/pr-preview/pr-1842/src/data/propertyDefinitionMetadata.js\":\"7dbb67ee75a2d172\",\"/knowledge-medium/pr-preview/pr-1842/src/data/propertyDefinitionRegistry.js\":\"c647a0fc62d8c08e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/propertyDisplayMode.js\":\"16e09826596c4b82\",\"/knowledge-medium/pr-preview/pr-1842/src/data/propertyRowCreation.js\":\"ec72dfff3cb34d53\",\"/knowledge-medium/pr-preview/pr-1842/src/data/propertySchemaCreation.js\":\"f0dd80382d9c04b9\",\"/knowledge-medium/pr-preview/pr-1842/src/data/propertySeeds.js\":\"76cf0ea11eb14fde\",\"/knowledge-medium/pr-preview/pr-1842/src/data/recentsPage.js\":\"885f078bfff18f63\",\"/knowledge-medium/pr-preview/pr-1842/src/data/referenceBlock.js\":\"74b8de767f07bca2\",\"/knowledge-medium/pr-preview/pr-1842/src/data/rejectedUploads.js\":\"dd945d09f98df93e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/releasePowerSyncConnection.js\":\"97e1caf9d063cfc7\",\"/knowledge-medium/pr-preview/pr-1842/src/data/repo.js\":\"4265cf30b6b2ebae\",\"/knowledge-medium/pr-preview/pr-1842/src/data/repoProvider.js\":\"265a4e37adc0625e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/rowProperty.js\":\"84b7ec98dfe88a0e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/searchFilter.js\":\"20d325557306fb44\",\"/knowledge-medium/pr-preview/pr-1842/src/data/seedIdentityLedger.js\":\"31ccc611a3b66ceb\",\"/knowledge-medium/pr-preview/pr-1842/src/data/stateBlocks.js\":\"107e4d969aff1d02\",\"/knowledge-medium/pr-preview/pr-1842/src/data/structuralEditPolicy.js\":\"6e87a972e094d5e8\",\"/knowledge-medium/pr-preview/pr-1842/src/data/subtreeDelete.js\":\"298bac027f415efe\",\"/knowledge-medium/pr-preview/pr-1842/src/data/syncStreamLock.js\":\"851a7ac3989d2c28\",\"/knowledge-medium/pr-preview/pr-1842/src/data/syncedTableSqlRecognizer.js\":\"fbcba93319e6aa21\",\"/knowledge-medium/pr-preview/pr-1842/src/data/syncedTableWriteGuard.js\":\"8e21edd0aed276a0\",\"/knowledge-medium/pr-preview/pr-1842/src/data/targets.js\":\"b06765edda756f42\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typeColors.js\":\"2fb78836317097ce\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typeDefinitionMetadata.js\":\"a5082a9741707ef6\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typeDefinitionRegistry.js\":\"aff75a8f3dabc51c\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typeExtraction.js\":\"b4572143940ed6bc\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typeInitialValues.js\":\"1f849265dbae8de2\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typePropertyGroups.js\":\"f577a612f7a808e6\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typeSeeds.js\":\"80af3cc0ec38b260\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typeTagger.js\":\"a8ce11f40677e3bc\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typedRecords.js\":\"dc074769946205a2\",\"/knowledge-medium/pr-preview/pr-1842/src/data/typesPage.js\":\"fc53eee9f0a54d3e\",\"/knowledge-medium/pr-preview/pr-1842/src/data/userPrefs.js\":\"152c351c8eb24596\",\"/knowledge-medium/pr-preview/pr-1842/src/data/userSchemasService.js\":\"fb8223c659f23be6\",\"/knowledge-medium/pr-preview/pr-1842/src/data/userTypesService.js\":\"7472f2cb5822d2bf\",\"/knowledge-medium/pr-preview/pr-1842/src/data/valuePresetRegistry.js\":\"0552ffc0be749415\",\"/knowledge-medium/pr-preview/pr-1842/src/data/visibleChildren.js\":\"7d907aca0cfc995d\",\"/knowledge-medium/pr-preview/pr-1842/src/data/workspaceConversion.js\":\"a1f3ec2fba6b7675\",\"/knowledge-medium/pr-preview/pr-1842/src/data/workspaceFirstSync.js\":\"06c6284de4e8e912\",\"/knowledge-medium/pr-preview/pr-1842/src/data/workspaceIdNamespace.js\":\"1c2221f862bdb880\",\"/knowledge-medium/pr-preview/pr-1842/src/data/workspaceSchema.js\":\"02e7f7189b3149f0\",\"/knowledge-medium/pr-preview/pr-1842/src/data/workspaces.js\":\"4529ce0d2f3d4b14\",\"/knowledge-medium/pr-preview/pr-1842/src/data/writeAheadLog.js\":\"6efe356e0112a24f\",\"/knowledge-medium/pr-preview/pr-1842/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/BlockPasteShellDecorator.js\":\"c26d276b913a062d\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/atTrigger.js\":\"81ab818d9a464e55\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/autocomplete.js\":\"799e8d816e688a18\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/codeMirrorExtensions.js\":\"51b117d33befc9b7\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/contentFlush.js\":\"1e611b83f1aa1081\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/defaultInteractions.js\":\"ad8fa2f9eb38ea89\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/editSettleSignal.js\":\"8acd0bf2d668be03\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/insertImage.js\":\"b9f673df482bc70b\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/referenceCompletionRange.js\":\"c5d46faf6c4560d4\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/referenceTargetTypes.js\":\"4cad7c14e9733b25\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/syntaxContext.js\":\"96f9a17801b347d5\",\"/knowledge-medium/pr-preview/pr-1842/src/editor/triggerMatch.js\":\"1e0dfa33933f688c\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/AppRuntimeProvider.js\":\"d4469d657d78951d\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/BlockFocusShellDecorator.js\":\"5a7990aa626350a6\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/ExtensionRenderBoundary.js\":\"73e5c7396e2026dd\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/PanelContentRecovery.js\":\"3b8cbc5453c3164b\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/apiCatalog.js\":\"a0cea6f8814ce111\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/approveExtensionHere.js\":\"b418e9bd0d118ac9\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/armedCutAppMount.js\":\"14b3886c7ce4ef48\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/batchableKeyedStore.js\":\"9fa5c37eca7b4c4d\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/blockInteraction.js\":\"33ed8a4f0dc7636c\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/blockSelectionAction.js\":\"1ca78c73e1fb20c4\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/compileExtensionModule.js\":\"fe88742a594a0b8f\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/compiledModuleCache.js\":\"ceaae1d355a55640\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/continuousGestures.js\":\"9aea2cb0e03b45d6\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/core.js\":\"8fa405cb04761cb1\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/defaultRenderers.js\":\"4cef54d378186c4d\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/definitionFanoutAppMount.js\":\"8922f7c2d7f1e5b1\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/dialogAppMount.js\":\"b59b4d5b555f8c07\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/dynamicExtensionSeeds.js\":\"7814b208f9f5277a\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/dynamicExtensions.js\":\"fddb36d6ad89a559\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/exampleExtensions.js\":\"33dba6cd6f171ef6\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/extensionApprovalStatus.js\":\"d802f1dc0d61a81c\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/extensionLoadErrorToast.js\":\"acd40e1a8f7b8b6b\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/extensionLoadErrors.js\":\"61850fb88a3ef293\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/extensionLookup.js\":\"982c2c4e726b8965\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/extensionToggles.js\":\"38d2b1c0fe56cca5\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/extensionUtilitiesCss.js\":\"e4f0331e0a96ba5b\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/kernelPageDeletionGuard.js\":\"a83772af9ef08c7d\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/liveRuntime.js\":\"33182c89f081a6fd\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/openExtensionsSettings.js\":\"fe14a8dbb3d898a9\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/overridesCache.js\":\"400010bbe32ca22f\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/pluginIds.js\":\"44dcf179b1103b3f\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/processorRejectionToast.js\":\"00b9dbb4f76feb0c\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/runtimeActions.js\":\"c95419a8a7e8f2c7\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/runtimeContext.js\":\"a8a8a7ce01c66498\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/staticAppExtensions.js\":\"5350c172b3abcc6b\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/staticDataExtensions.js\":\"d0c1988390f30785\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/toastAppMount.js\":\"cb3d50b985574472\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/useOverrides.js\":\"efbfb09556870aa0\",\"/knowledge-medium/pr-preview/pr-1842/src/extensions/useShortcutSurfaceActivations.js\":\"7d94e9057d441f27\",\"/knowledge-medium/pr-preview/pr-1842/src/facets/discoverToggleTree.js\":\"ddd014138c12cda1\",\"/knowledge-medium/pr-preview/pr-1842/src/facets/facet.js\":\"22b3d6a647e1f82d\",\"/knowledge-medium/pr-preview/pr-1842/src/facets/resolveAppRuntime.js\":\"1f4560b5b8276218\",\"/knowledge-medium/pr-preview/pr-1842/src/facets/runtimeEvents.js\":\"23c4a86be4d70e7e\",\"/knowledge-medium/pr-preview/pr-1842/src/facets/togglable.js\":\"e0ef0f9ed5a617d1\",\"/knowledge-medium/pr-preview/pr-1842/src/facets/variantFacet.js\":\"ec495e0115120416\",\"/knowledge-medium/pr-preview/pr-1842/src/facets/verbFacet.js\":\"15e7326f8c526aff\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/block.js\":\"bd2952dc68224539\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/focusedChild.js\":\"a452e34c1c1b2cc8\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/propertySchemas.js\":\"0496dec7ceccfd78\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/typeRegistry.js\":\"b53be280aac18b96\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useAncestorCrumbs.js\":\"397b77f8d284474e\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useAutocompleteListbox.js\":\"e0a835fccabd5077\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useDebouncedSearch.js\":\"310ffe3ac9b9ecf8\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useDebouncedValue.js\":\"cc69d574fb87b510\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useIsFocalRender.js\":\"bb511f7c2e5d40dd\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useIsReadOnly.js\":\"dae804ea4040618f\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useMaterializeBacklog.js\":\"9739289da039b8fb\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useMinuteClock.js\":\"2cb363942782c72e\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/usePanelLayoutProjection.js\":\"15948e382f6c8852\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/usePendingInvitations.js\":\"59583a7dfb90a338\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useRendererRegistry.js\":\"187809ac05c1bd71\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useRetainedFieldRows.js\":\"2787eb3e492e53b6\",\"/knowledge-medium/pr-preview/pr-1842/src/hooks/useWorkspaces.js\":\"1d15cfe68c4ff6bf\",\"/knowledge-medium/pr-preview/pr-1842/src/lib/utils.js\":\"f2af2c9bd2ea6150\",\"/knowledge-medium/pr-preview/pr-1842/src/main.js\":\"23220d02c501b68a\",\"/knowledge-medium/pr-preview/pr-1842/src/markdown/MarkdownImage.js\":\"1be0fefa36894b31\",\"/knowledge-medium/pr-preview/pr-1842/src/markdown/blockSeparators.js\":\"529b752fe0c71b87\",\"/knowledge-medium/pr-preview/pr-1842/src/markdown/context.js\":\"93e6b6b1584606c4\",\"/knowledge-medium/pr-preview/pr-1842/src/markdown/defaultMarkdownExtension.js\":\"583efafcf1b72bd8\",\"/knowledge-medium/pr-preview/pr-1842/src/markdown/extensions.js\":\"1394c8811a4ff479\",\"/knowledge-medium/pr-preview/pr-1842/src/markdown/renderMarkdownHtml.js\":\"cf6c4dc493e40082\",\"/knowledge-medium/pr-preview/pr-1842/src/minimal-editor.js\":\"8592fd8925b98b6b\",\"/knowledge-medium/pr-preview/pr-1842/src/paste/armedCut.js\":\"00361c6a5054fd8f\",\"/knowledge-medium/pr-preview/pr-1842/src/paste/captureMediaVerb.js\":\"267f2899ce099fa8\",\"/knowledge-medium/pr-preview/pr-1842/src/paste/clipboard.js\":\"df6cc8ee80a4fe18\",\"/knowledge-medium/pr-preview/pr-1842/src/paste/decision.js\":\"a6b6f07eec86d9ef\",\"/knowledge-medium/pr-preview/pr-1842/src/paste/operations.js\":\"5989ca34bb04da0b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/account-header/AccountHeaderItem.js\":\"c7e9e7631c462dbc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/account-header/index.js\":\"65cf8daa4f685516\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9fb808ffef33a627\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-dispatch-companion/askAgent.js\":\"5b00fa85c2f14e83\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-dispatch-companion/askedStore.js\":\"1b7154cf8644dab5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"12ef3083e50eaa97\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-dispatch-companion/chipState.js\":\"ca836664a378bdcc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-dispatch-companion/dataExtension.js\":\"74bc709703d06df1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-dispatch-companion/index.js\":\"bdc3cad51fc49e4f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"58b2f85a5b9fcb53\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-dispatch-companion/schema.js\":\"bc1a24b21f776471\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b7ac60f66e6029df\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4c42c59c7ff96eec\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/addMedia.js\":\"94efcc1cf3873906\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/backlinks.js\":\"670fa19f21543bee\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/block.js\":\"1bbef95e23df9230\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/context.js\":\"d052eb58e3dbc6b2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/displayIds.js\":\"975597319c1436d6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/index.js\":\"9a496bf2243cf79c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/outline.js\":\"ecb52f70ee857966\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/properties.js\":\"4899d9d041eef29c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/refs.js\":\"fc18f32ca47f6c9f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"21b41ff695c20881\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/search.js\":\"82c6acbe418d144d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/shared.js\":\"ad3161903422e13d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0a96af0f4efbcfd3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentViews/text.js\":\"e30c188de6f0f69d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/agentWrites.js\":\"7af7e2402c9d27bb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/authoringCatalog.js\":\"a75a570eadc0fb37\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/blockRefTargets.js\":\"17310b768d2bc1d8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/bridge.js\":\"a8de8572db7af18f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/bridgeLoop.js\":\"97d3a1ec566e8b26\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/changeHistory.js\":\"9548d89d3cb6317a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/commands.js\":\"65a6aac198c720b8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/commentsCommands.js\":\"9f61ba39ece9dbf0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/dataExtension.js\":\"09ee061e5b2ff262\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/dataModelGuide.js\":\"3ebf7bdfb3e7318c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/describeRuntime.js\":\"54950ef89c38027e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/extensionLint.js\":\"182e0368199aa191\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/grainAudit.js\":\"3949db8ecf32ad26\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/healthCommand.js\":\"48b378344a730c4b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/index.js\":\"aa1f9b1278a31ef4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/presetIdentity.js\":\"2691d5de2e3f58cf\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e5a5147ade4a78b3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/readMedia.js\":\"a431c18cce3d3677\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/schema.js\":\"5ba0b9bfbb6130b7\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/serialization.js\":\"6310c3201aad6b83\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/targets.js\":\"fa2b691afdd88c15\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/tokens.js\":\"ccd56a7afc0443f2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/watchEvents.js\":\"1e99a77d16c95da9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/workspaceGuard.js\":\"94b9965a26cbe04a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/agent-runtime/writeCommands.js\":\"27e44814d9689c94\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/alias/AliasCollisionToast.js\":\"677f9bcc07f0006f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/alias/DuplicateNameBanner.js\":\"372e983b875e06f5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/alias/collisionMerge.js\":\"cee91159a74b674a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/alias/dataExtension.js\":\"fdb7777cc46e35f4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/alias/index.js\":\"e2f03e2b7aa95a6b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/alias/mergeCollisionAction.js\":\"ebb157bd14a71452\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/alias/pageStyling.js\":\"c038fab7812a629a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/alias/rejectionToast.js\":\"a2751f7fdd833df3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/alias/syncProcessor.js\":\"dd8ece91955cfea8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/actions.js\":\"4999d5afc2100dfb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/addComment.js\":\"b00d5123a9fa849e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/anchor.js\":\"6592b0b74230c6e0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/anchorState.js\":\"b8e7345ee5e8fa97\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/commentLinks.js\":\"d7dfc4231ef007fa\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/confirmThreadDeletion.js\":\"f3d3bab5e3aa51b3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/container.js\":\"fe0f14dbaf270352\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/dataExtension.js\":\"69d7e49d1b9fe290\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/deleteComment.js\":\"07cd5eba533a3962\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/highlights.js\":\"c1dcf52b08231f28\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/index.js\":\"a177fa7644fb54d1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/linkedCommentsPill.js\":\"0ea69be12fbbb941\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/margin.js\":\"667db8b809b1057d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/marginSchema.js\":\"e09c040ae40e5d63\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/newComment.js\":\"babdcb30f6f1df7d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/ownThreadPicker.js\":\"560e09969edbfc0d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/placement.js\":\"edf31a94bae49940\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/queries.js\":\"055fefe1201f0168\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/quotePosition.js\":\"08d0c356ba838ecb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/quotedIn.js\":\"f4bbdd9998566b5c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/quotedRange.js\":\"1f2216f945f34e28\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/rangeRefs.js\":\"534ce185333d8859\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/readHighlights.js\":\"9f39fee14b5bc571\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/readSelection.js\":\"328d3560409b0edf\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/readSelectionUi.js\":\"1d7546b2f24d4006\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/reanchor.js\":\"a8f9c0bbac80c536\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/schema.js\":\"543d915567db6b52\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/scope.js\":\"80a4ce5e22ba065a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/scopeThreads.js\":\"c1f3e5ef0d9ee445\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/splitRetarget.js\":\"8894b7cfb0ad14e7\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/suggestionCard.js\":\"ab6184c77d7ab6d7\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/suggestions.js\":\"77cb7ee4fc15d9fb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/summaries.js\":\"c65729b687f0c7e6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/summaryBatch.js\":\"68564cf430c54815\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/surface.js\":\"953dcd40d04495d9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/threadNavigation.js\":\"b27ecc6589c06d77\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/threads.js\":\"a23e601e8c263ba4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/ui.js\":\"4759996f5f5b05db\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/annotations/uiStore.js\":\"6ffbfcb323b728c2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/app-intents/appIntents.js\":\"54259f62b82d7b74\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/app-intents/index.js\":\"c6a6a92e34d9be94\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/app-update-prompt/index.js\":\"afa32ed654d23b8a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/app-update-prompt/status.js\":\"e7a42f6613f0c33e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a42e53011d7229a0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/MediaBlockRenderer.js\":\"a5de0bb564ef8dbc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ffa5a7ecea2ca97d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/MediaUploadReconciler.js\":\"5429b9d4d4c01b1b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/assetDownLane.js\":\"b05cfde083afeb78\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/assetResolver.js\":\"cb689c40f63982ec\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/assetUpload.js\":\"08fb6283a6e3b4bc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/attachmentCleanerIO.js\":\"40191ff5a52f8c7c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/audit/supabaseAuditIO.js\":\"75c0eea5f4855a29\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/blobStore.js\":\"02b28b3acb1b7d12\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/byteStore.js\":\"53098d05820ad08f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/cleanerIO.js\":\"aca77f70fe537a97\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/cleanupAttachments.js\":\"6d2d99fdeb46d5d3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/dataExtension.js\":\"1e420c5d604c8b6f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/downLane.js\":\"fc46075b7b09381e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/index.js\":\"7814dd6d2a68f4f5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/insertImageContribution.js\":\"8dc4bac32208902c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/laneArming.js\":\"93979e75f8e998e0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/laneLock.js\":\"f0622cb482050b02\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/mediaBlock.js\":\"2e773519c76a15b6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/mediaCapture.js\":\"0c0b3a9551d8c882\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/mediaViewers.js\":\"26820cabff6927d5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/mediaViewersFacet.js\":\"6012144093a436e7\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/pasteCapture.js\":\"e96ca4d82088f32f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/resolver.js\":\"8af79873817f1c6e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/retryUploadsAction.js\":\"f920ceaac98bba47\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/storagePaths.js\":\"e2b99f52aa419cf3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/uploadDrain.js\":\"fd6ca2cbe98cd3ab\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/uploadLaneStatus.js\":\"188de68ebebe018f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/uploadReconcile.js\":\"fd8026b9cf1b89c9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/uploadRecovery.js\":\"c796e4760589281f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/uploadStore.js\":\"6a0693159df71127\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/attachments/useAssetObjectUrl.js\":\"9cc741c3f567e852\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"068afc4d7f8aa026\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks-view/BacklinksViewSection.js\":\"1de5f7d951a6b346\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks-view/facet.js\":\"041696d1b109f48a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks-view/index.js\":\"7d53e9a99aeaf287\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks-view/prop.js\":\"9eec0acf16a7c730\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/BacklinkFilters.js\":\"f2f2d03352ec8862\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"8d83d9d628784ae3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/BlockEntry.js\":\"3867605ebbfad9b6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/LinkedReferences.js\":\"b5270b37d3d5c92e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8e4a6fa8050bbd85\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/dailyNoteDefaults.js\":\"bce9d1cad5cf1d41\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/dataExtension.js\":\"1e646a52349c8a9a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/edgeExclusions.js\":\"46eea703d1638b26\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/filterProperty.js\":\"df4606762f9a35f5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/index.js\":\"6d4b98501762ad69\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ad7815acc67a0495\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/inline-counts/applies.js\":\"0e7c73c6d78557d9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/inline-counts/countQuery.js\":\"1036717de3a420ed\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/inline-counts/expansionStore.js\":\"0abe831bd3d3a7b1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/inline-counts/index.js\":\"7fc750ad21c182cc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5aecaa3483913d5f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/presentationInvalidation.js\":\"568db0db409321ff\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/propertyEditorOverride.js\":\"c2e8669121119f51\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/propertyFilter.js\":\"7bd1390f99510279\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/query.js\":\"5f03a71a0e98f28a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/resolveFilter.js\":\"69062a56f4945289\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/sourceBatch.js\":\"fa0a94b446e58cb9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/sources.js\":\"535755585d303387\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/useBacklinks.js\":\"3e6ce358ac28fb92\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c8c8ba616c44ceeb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/birthday/BirthdayCelebration.js\":\"db65d9e7e37ea221\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/birthday/BirthdayOverlay.js\":\"6005b9138b340ee6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/birthday/gate.js\":\"d84c5a3ffecc72d0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/birthday/index.js\":\"4767647440c54c96\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/birthday/wolfTheme.js\":\"2825f1ea85181e16\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-drag/BlockDragLayer.js\":\"fe6b80f6e8142bdc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-drag/dragController.js\":\"8644c80ea2157f3a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-drag/dropTarget.js\":\"34224b8c6fbe5b52\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-drag/index.js\":\"1b444bd5bfc708b1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-drag/projection.js\":\"2c6b110506953c20\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-info/BlockMetaCard.js\":\"03b9ae0488acecf4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-info/index.js\":\"66c7c40eef8ea4a3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-tagging/AddTagDialog.js\":\"f5f7546981965a9b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ede91e3c51e001db\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-tagging/TagNameIssueHint.js\":\"43c780b79d64a002\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-tagging/addTagAction.js\":\"6a501bc782ef02dc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-tagging/appendTag.js\":\"0797947a85b86c87\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-tagging/config.js\":\"5f4efdb2636e6a5a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-tagging/dataExtension.js\":\"74c3b26cf593a7e1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-tagging/index.js\":\"b65b1f7049481fa0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/block-tagging/propertyEditorOverride.js\":\"029cfc6a140eadb2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b847ff080c434a58\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1491c9d57003c3fe\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/breadcrumbs/Breadcrumbs.js\":\"87db8a421687092b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ea5827e1d89ee881\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4e8bbe498fb8664f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/breadcrumbs/index.js\":\"0f2861ac60827571\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"05d0708383963937\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/CharacterCountItem.js\":\"0ef1ee977caa216d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d38d728101235c79\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/actions.js\":\"b0a065aae9eb830f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/blockType.js\":\"434b59f13f82355f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/charCount.js\":\"c6b488c3d7b39992\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/dataExtension.js\":\"19d26154b9975f46\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/index.js\":\"7d60469b743aac83\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/profiles.js\":\"ac3e1164685908c5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/properties.js\":\"1eaa4a2496690cac\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/character-counter/textCounts.js\":\"57d4b9ffa471b608\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/colemak-keybindings/index.js\":\"ec7568e4a5a4c4a0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/command-palette/CommandPalette.js\":\"678b6474c09ae700\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/command-palette/HeaderItem.js\":\"4631d6a8667cf953\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/command-palette/context.js\":\"1301ff23b3f382bb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/command-palette/index.js\":\"f05043532801671d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/command-palette/selection.js\":\"aa0b2f0f7b40d194\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/command-palette/toggleStore.js\":\"41aa5c7b8bc4114d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/command-palette/useCommandPaletteActions.js\":\"bf5261e635fe4806\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/ContributorBadges.js\":\"882497277e1f536e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/author.js\":\"91823986697826cf\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/codeMirrorExtensions.js\":\"09eaedf282dd8996\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/dataExtension.js\":\"1724860a0628389b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/index.js\":\"a52fa73665fb4137\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/mentionAutocomplete.js\":\"08d63e2b37ed5f99\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/processor.js\":\"23f90cc91a7c2768\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/profiles.js\":\"86d090e14534c649\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/queries.js\":\"ca30e48e058bd478\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/contributors/schema.js\":\"304ed6b4360198ce\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4ef350f84f79d016\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/cursor-follows-scroll/followOrigin.js\":\"444e46ec1a899f82\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/cursor-follows-scroll/index.js\":\"45c62ffb55fe30a6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"678c7cef888cedc4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"a551e9808ea30ebc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/CalendarGrid.js\":\"bb310b708dd66a63\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/DailyNotePicker.js\":\"755117a276b7ac72\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"777eaf210734273c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/DateNavDecorator.js\":\"7ce666a44a0a0eaf\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/DateScrubOverlay.js\":\"5d919281c8db13aa\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/HeaderItem.js\":\"e217c697d4f888bd\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/ReschedulePicker.js\":\"db1864836f1992cf\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d631a87784b3670f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/actions.js\":\"b8d7ec3dfafeb4ae\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/blockDateAdapter.js\":\"bae0636857ad8224\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/calendar.js\":\"3326017507c4af5b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/dailyNotes.js\":\"144719b1eca0e728\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/dataExtension.js\":\"b9b064c6aed12b08\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/dateScrubActions.js\":\"e87015968d4f894e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/dateScrubGesture.js\":\"2af28fb1d64bc50b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d053793d23130839\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/dateScrubRecognizer.js\":\"7aa73633534395e6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/deletionGuard.js\":\"c1b051f7c5cbf54b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/dueQuery.js\":\"aceac48d6bb534e2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/index.js\":\"0ce5eb99ab16eb5f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/landing.js\":\"9dae9fd23bc91d5b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/localSchema.js\":\"0b354ad472b1906f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/referenceDateAdapter.js\":\"487b409606f785cc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/rescheduleAction.js\":\"1c2002ff3431e73a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/schema.js\":\"787bc58d754ca9f6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/spreadBlockDates.js\":\"883a297ef149b0a0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/spreadDatesAction.js\":\"240f733b5c25cd93\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/today.js\":\"0f37f311e7a6d23d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"1f829aed4d94521d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"eb16fc330c7f0aba\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/audit.js\":\"fdb8097a31768364\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/auditAction.js\":\"2d49e62fe605277e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/auditRanges.js\":\"56233f4d1d354f91\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/diagnosticsSource.js\":\"cf9babfc5ce63f80\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/divergenceScan.js\":\"dbe28ce9e14abde2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/index.js\":\"21d756ba9a32068e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5570d227c161d16a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/referencesMirror.js\":\"df505cfdc0b7df33\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/rowJson.js\":\"702af08acff0cf53\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/schedule.js\":\"6a7f8f04cbbc464f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/data-integrity/store.js\":\"1b17e01a37751fd3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-maintenance/action.js\":\"b898bf2f7b88223c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-maintenance/index.js\":\"11cdc5de5da61563\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-maintenance/plugin.js\":\"47ebedc247d12f49\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f2411302cd0a7c03\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/actions.js\":\"ad06861a54e7c78d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/changeMarker.js\":\"00455391f54a39ce\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/diagnostics.js\":\"87b355e717573eee\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/fileSystemAccess.js\":\"67c9ae5442c8584e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/filenames.js\":\"68a0c38fb777ac04\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/index.js\":\"15ecc940e0e924f5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/mirror.js\":\"b80d00f835f0be5e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/runLock.js\":\"f123b109f596bc1d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/runtimeHealth.js\":\"cf404c3c28a77124\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/schedule.js\":\"6b399d307415f627\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/db-mirror/store.js\":\"ad2134a56d9b69ad\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/default-themes/index.js\":\"46e25c849ec90d44\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/default-themes/themes.js\":\"0d53cfcfd01b5f8a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/diagnostics/facet.js\":\"bd89d92df98f5733\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/diagnostics/useDiagnostics.js\":\"97402829189dadef\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extension-prompts/dismissals.js\":\"730547c1595199c1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extension-prompts/index.js\":\"f2d883d7c1c1da03\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extension-prompts/status.js\":\"a5dd157b0decf6ae\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extension-prompts/store.js\":\"588c458a5d05b4b4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"75a4680d86f59e50\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d97f10d8f475edaa\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extensions-settings/actions.js\":\"f3d8157dcbdf2afe\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extensions-settings/config.js\":\"9c02935213ca1463\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extensions-settings/dataExtension.js\":\"0a9cabcb72ab1689\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extensions-settings/effect.js\":\"6eee6ea7c2f77f65\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extensions-settings/index.js\":\"37726ef67847512d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extensions-settings/propertyEditorOverride.js\":\"139f81bfdd91c09e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extensions-settings/useToggleTree.js\":\"0ce98a35b04e37e3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extract-type/ExtractTypeDialog.js\":\"cca64c29da3a408f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f0e2ac4d1be7e6e9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extract-type/PropertyShapePicker.js\":\"d919e16598ba206d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extract-type/action.js\":\"55af0ab1abfe0d54\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/extract-type/index.js\":\"b440a485470da39a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/find-replace/FindReplaceDialog.js\":\"62e00f77735eb8b0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/find-replace/HeaderItem.js\":\"65a5aaf9452b22cb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/find-replace/dataExtension.js\":\"547dcae0a5739621\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/find-replace/index.js\":\"c59e764c80147e5f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/find-replace/search.js\":\"f7a6f56bffe8164f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/find-replace/toggleStore.js\":\"10c83cc5854b9d8c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/LocationPropertyEditor.js\":\"563d4ca5d477d64d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/MapView.js\":\"5c165e28ef800614\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/blockTypes.js\":\"de3a1948ebfb0f97\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/codeMirrorExtensions.js\":\"ff6e0c5374eb5137\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/createOrFindPlace.js\":\"43cec5a9eea8b51c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/currentLocation.js\":\"93e7547c669d9457\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/dataExtension.js\":\"52d5e321c815cad5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/geoContentDecorator.js\":\"5aeb30b0914af7bb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/googlePlacesClient.js\":\"7e1805966451afd4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/index.js\":\"ac8bc35a5a164ca9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/locationsPage.js\":\"a53204a026b49930\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/mapViewport.js\":\"3cb2c24899390b7a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/pickCurrentLocation.js\":\"239155c7914ccf69\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/placeAutocomplete.js\":\"0bcf07e19ed6cc29\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/placeNameCollision.js\":\"c5b4e89148cb6af3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/properties.js\":\"21b2e49d1a14290a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/propertyEditorOverrides.js\":\"574383e2f8ab6e2f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/query.js\":\"885aae30ab4925d2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/geo/usePlaceSearch.js\":\"79ff4b46f68e2472\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"fc4efa3a81a75b76\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a32dd5f8a38ffbb1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"465bcf3e6927fbdf\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/config.js\":\"dc3034c4e410fff6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/dataExtension.js\":\"178680ad3b03ed54\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/facet.js\":\"6bb0ccb4c634bf25\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/grouping.js\":\"d46ea6da05e134b0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/index.js\":\"f9c058d293b44444\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"fb4746e191d2bfb9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/query.js\":\"6013a858f4327edc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/resolveConfig.js\":\"d8c7dc1af0d5ca4d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a6fd089c87462f49\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"bb3948070d3bd635\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/HtmlDocumentContent.js\":\"cae75869fa488589\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/HtmlFrame.js\":\"4e699d716308ff63\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/actions.js\":\"e30e356f850b421a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/blockType.js\":\"d6c7f6a54f07b256\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/confirmRunScripts.js\":\"7fceb4afa9271b6b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/dataExtension.js\":\"3b9c1e76939f4e5b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/frameAnnotations.js\":\"ef5f3ab8e4a93eb8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/frameDocument.js\":\"0565f66dcdb1e6f7\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/frameTheme.js\":\"522807caceb21e8e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/index.js\":\"03cfa9ca5eac58f6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/scriptConsent.js\":\"e6a7de336696fef0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/sourceMap.js\":\"70ee7fe414f310de\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/html-document/useDocumentScripts.js\":\"14c8b7b0b9f416fe\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/interaction-metrics/index.js\":\"a540613bd6dc6a1e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/interaction-metrics/record.js\":\"e0076a70521d4180\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/interaction-metrics/recordStore.js\":\"994fcc56a16aca06\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/interaction-metrics/responsiveness.js\":\"24286f85c8bef4fd\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/interaction-metrics/schedule.js\":\"afeedf5f5d42e212\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/interaction-metrics/sessionContext.js\":\"e43c2e3f2d4c876d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ee2af76820ae47a6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b137de249c10f023\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/actions.js\":\"566fc3019e5c819f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/config.js\":\"143384a1176b74fe\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/dataExtension.js\":\"f40b7a57d25abda6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/effect.js\":\"4d67591a5a1b477f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/index.js\":\"ba7bea93ca1920bc\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/keyCapture.js\":\"5cb745310acd160f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/overrideStore.js\":\"42a2d5bdff5e352a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"01da664a7ebdaee8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/left-sidebar/HeaderItem.js\":\"f5af825da8b93535\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/left-sidebar/LeftSidebar.js\":\"4d59db6792931678\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/left-sidebar/actions.js\":\"f09e7aa0e3d1812b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/left-sidebar/facet.js\":\"1b42a06f856a8cc4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/left-sidebar/index.js\":\"3617cf2ebd7b8525\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/left-sidebar/shortcuts.js\":\"579a2f18bef3709c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/left-sidebar/toggleStore.js\":\"7b5dbe44a7f7fa84\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/merge-blocks/MergePicker.js\":\"168a038fec679969\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/merge-blocks/index.js\":\"49ad857e7d97c850\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/merge-blocks/mergeAction.js\":\"9a06e19313af120e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/merge-blocks/strategy.js\":\"45b45087210d9e2a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-bottom-nav/Button.js\":\"4b4f6b17b4bc088e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b936dfc8b0dc9486\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7c9fc952f8b32b95\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-bottom-nav/facet.js\":\"0133ab4c97bdd9e8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-bottom-nav/index.js\":\"5f2357c232c1ff15\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"545b294cfe8cff2a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2ac879a6a1e2d6e9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"556bbded6ed5dd57\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b44567b7f1d80146\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/mobile-keyboard-toolbar/index.js\":\"674d8474bed0a257\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/move-blocks/MoveDestinationPicker.js\":\"49c8b3e87d49262b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e5665ed8c6ffee4d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/move-blocks/contextMenuItem.js\":\"92ff1e59c72bee1e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/move-blocks/index.js\":\"30a4ac193fb1e4e5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/move-blocks/moveAction.js\":\"3a730d0bebf5bae4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/move-blocks/moveBlocks.js\":\"22f95f8108c41863\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/move-blocks/selectionAfterMove.js\":\"9634349c830477b6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/onboarding/TutorialBanner.js\":\"b556232666e16f4f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/onboarding/action.js\":\"032a6a4d66e41ab5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/onboarding/bannerDismissal.js\":\"c01bd2b7ee6c67d6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/onboarding/documents/cheatSheet.js\":\"d0d8d55fcb2c3a84\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/onboarding/index.js\":\"5a4b9868540779c9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/onboarding/keys.js\":\"5fb71a04ff854b41\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/onboarding/landing.js\":\"51e0a56bf64bc4ef\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/onboarding/outline.js\":\"4242c624b7a640a4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/onboarding/seed.js\":\"061b5bc66ef565c4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/PerfTrendDialog.js\":\"49894078d91e1db8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/analyze.js\":\"2825637c2c1460d6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/diagnosticsSource.js\":\"5c7d1b31da2f88cf\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/index.js\":\"90025d1cf0a9228b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/load.js\":\"a30d672d0788eb55\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/monitorRun.js\":\"c8aa63045e6e35f3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/schedule.js\":\"ca08039210edd434\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/series.js\":\"0e1cda3e19058d0d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/store.js\":\"82a50f2c7a9192b0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/trendAction.js\":\"3627fd5c8720aa4b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/perf-monitor/verdict.js\":\"a6f3dc9e6caad6f6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/plain-outliner/clickToEditAction.js\":\"956d874936785133\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/plain-outliner/index.js\":\"d59c6ddb442ba4d5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/plain-outliner/interactions.js\":\"d50c97ebc39ecea5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"13408257d1273bb8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/properties-migration/MigrationGate.js\":\"80cce45c9e1fcfde\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/properties-migration/MigrationGateDialog.js\":\"ff5b4adc164ae798\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/properties-migration/action.js\":\"d1f8c88c4415cc6e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/properties-migration/index.js\":\"363adf633a4101a8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/properties-migration/localRunMessage.js\":\"275f2b2f01d1f055\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/properties-migration/plugin.js\":\"8d9b3d7f1a7aba1b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/properties-migration/progressReport.js\":\"c1b6c50de66aff2c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/properties-migration/sweepProgress.js\":\"5acdf10fcf5ee66d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/property-rows/FieldRowRenderer.js\":\"97687bbfc66242c4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/property-rows/ValueRowRenderer.js\":\"9a7a4e5362c611af\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/property-rows/actions.js\":\"3183e4ccf1377571\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/property-rows/autocomplete.js\":\"4879dd1cb7037ace\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/property-rows/fieldRow.js\":\"c3f3a14ea1039f9f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/property-rows/index.js\":\"c03a6691b8fb2973\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/property-rows/referenceWarning.js\":\"f6002e1e71f85cb8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/property-rows/valueAutocomplete.js\":\"4c1f849b09b36d08\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/property-rows/valueSchema.js\":\"e37453cae0b14509\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/quick-find/HeaderItem.js\":\"6d0d1256bfed3035\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/quick-find/QuickFind.js\":\"b387dd70ce437371\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/quick-find/index.js\":\"6f65015dc7c9995b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/quick-find/recents.js\":\"c3606295960bc423\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/quick-find/resultItems.js\":\"14e7af751fa5278c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/quick-find/selection.js\":\"34fa452a3b359979\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/quick-find/toggleStore.js\":\"56585a121be6384b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/recents/HeaderItem.js\":\"83d6c853c8631475\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c7cb26b156280dc6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/recents/grouping.js\":\"2af5fe2d6944f634\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/recents/index.js\":\"b830275b68a70fc0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/recents/target.js\":\"02c187fbb09dcea9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/codeMirrorExtensions.js\":\"777cdf5227ade797\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/contentPrefill.js\":\"745fc33df19b1284\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/dataExtension.js\":\"43ee70c38d9fd95e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/index.js\":\"0facfed75efe9138\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2aec7e18bb13e020\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/invalidation.js\":\"04edf744e44760a5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/localSchema.js\":\"1d346f4aa702018c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/markdown/blockrefs/index.js\":\"3beb90a8c8a048f4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c66025dffecb0977\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/markdown/index.js\":\"3bd833ede445d8ff\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/markdown/referenceNode.js\":\"a7b9268157e0ef56\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d8ded3f01d37ee24\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"714f522abbc01c45\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/markdown/wikilinks/index.js\":\"fe8d43d0e69e8296\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0b1a0542d08c2703\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"f8e98027279617ad\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/mergeRetargetProcessor.js\":\"b6daf733e62b1ed8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/parseFence.js\":\"9579e664088039d3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/referenceParser.js\":\"a56851e921825396\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/referenceProjection.js\":\"af2f7de7a9bd75fe\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/referencesProcessor.js\":\"479e1e93f04982c2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/renameProcessor.js\":\"bdf16c4a8fdaaae9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/references/spanReplacement.js\":\"4434917f5ea6c787\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/rich-paste/htmlToOutline.js\":\"9bd0232f7de4c3ec\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/rich-paste/index.js\":\"c002b884f0923918\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8bdf99860acd1583\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/rich-paste/pasteDecision.js\":\"d177b82cdbf912b6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/action.js\":\"04562c402002736a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/blockIds.js\":\"13bf32612170b8c0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/content.js\":\"4bedf78fd9e99b69\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/effect.js\":\"4226cd783229758b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/ids.js\":\"549524314046d869\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/import.js\":\"2089078e780e9fb1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/index.js\":\"853f48f2c41ab9eb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/plan.js\":\"bcc3df7c2537122d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/plugin.js\":\"6f4af94c689ff7d6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/promotion.js\":\"013fe31c93c11c9f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/properties.js\":\"032da3424f5a6ca1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/references.js\":\"27b1c9a30c7f8640\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/report.js\":\"6ec6793d05cab28b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/roamMemo.js\":\"dd86dad5077b84ac\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/runtime.js\":\"c39ce8e7c82def35\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/schemaReconciliation.js\":\"647c4affdabfc2d2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/srsMarkers.js\":\"3e09ba151df32187\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/todo.js\":\"3b25d173151ba93e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/typeCandidates.js\":\"9a9226f892dadd05\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/roam-import/types.js\":\"a9a4cd48c2eafe73\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/search-health/index.js\":\"581aab6d61bce114\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/search-health/store.js\":\"1b6b088e5aaf972b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/shortcut-help/HeaderItem.js\":\"c2783dabff98bad9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3349db364c87e7d9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/shortcut-help/index.js\":\"4ff521a87255af80\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/shortcut-help/model.js\":\"dbfad56331c7c904\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/shortcut-help/toggleStore.js\":\"3459ced337c973e9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/shortcut-help/useKeyInspector.js\":\"c5bc3d7e0123a61a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"519de7373367f7c5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/spatial-navigation/ShellDecorator.js\":\"4996bee3fc1b47c7\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/spatial-navigation/actions.js\":\"8eff3dcadd2a2451\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/spatial-navigation/exclusionsFacet.js\":\"eea36e6964a4caca\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/spatial-navigation/index.js\":\"e76f5b5227e910a5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/spatial-navigation/shell.js\":\"d5ee8767fa79e93b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/spatial-navigation/surface.js\":\"98df4e2a7f53879f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/spatial-navigation/walker.js\":\"2b49ad3ed2a652e5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6365fb17dd45c485\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/dataExtension.js\":\"8ee6d53a273334ab\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/index.js\":\"8ab6170509b79f6f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/indicator.js\":\"afcbbb084799f018\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/moveSrsState.js\":\"15772acea278e37f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"472f8e2629c559ec\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/scheduler.js\":\"4593d1d092cefee9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/schema.js\":\"b4d64696e484a8b8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8c8ca5733b4ae034\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/srsClipboard.js\":\"469053628ea4a4a5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9544e791d0a8c24f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3c9a970cd577c9a3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/DeckPicker.js\":\"9382fd24fae9c0b3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/ReviewControls.js\":\"5902ac3995023acf\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/ReviewDeckRenderer.js\":\"a806496b5a99b9c3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/ReviewSession.js\":\"8bdbbd84b9dafdaf\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/actions.js\":\"32cbb1220bef08a3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/archive.js\":\"d3c975391a75366e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/dataExtension.js\":\"0452257fd838c1c8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/deck.js\":\"9f6ebcd0e71aa536\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/dueQuery.js\":\"507b2602255a8d73\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/gradeDecision.js\":\"9aedb64d8ef08e03\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/index.js\":\"1643790a993cd73c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/keyHints.js\":\"f5e40860feb141c3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/reviewCardLayout.js\":\"f6727f1cdc81dc14\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/reviewProgress.js\":\"45f711d5dc26a17e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/schema.js\":\"6895ebba6e573794\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/srs-review/useDueCards.js\":\"be900f1f56d9ceee\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/startup-metrics/index.js\":\"51090c9c3e2137e1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/startup-metrics/record.js\":\"6cb67695aea12d1c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/storage-persistence/index.js\":\"594331eb674469e1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/storage-persistence/persistenceStatus.js\":\"978428f266131777\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/storage-persistence/requestAction.js\":\"f65c0fdbcec59554\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/supertags/TypeChipsDecorator.js\":\"db1576c2b66047f2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/supertags/codeMirrorExtensions.js\":\"fdf02bfe8446edac\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/supertags/index.js\":\"8eecddc2a973de39\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/supertags/typeAutocomplete.js\":\"ad87d7b7442c769d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"10ce5523482f8993\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/swipe-quick-actions/actions.js\":\"51ce709ebbb8e67d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/swipe-quick-actions/anchor.js\":\"e88c4ea934e8561a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/swipe-quick-actions/events.js\":\"01278800a2cca887\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/swipe-quick-actions/gestureActions.js\":\"b3f4e404588044c3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/swipe-quick-actions/index.js\":\"ec42621ccc537d78\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"23be103cccad4f3c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/sync-metrics/collect.js\":\"267164e766c62fbd\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/sync-metrics/index.js\":\"4e939fd7ccd08114\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/sync-metrics/record.js\":\"c53ceeeb0aa7d615\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/system-status/RejectionDialog.js\":\"7bbd6b2ea383505a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/system-status/SystemStatusHeaderItem.js\":\"2cdf148ec6c25ce3\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/system-status/index.js\":\"fd914cbde5df4ca9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/system-status/model.js\":\"de546de6dcdff7ba\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/system-status/queueCounts.js\":\"8305dcadc967210e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/system-status/rejectedHelpers.js\":\"7f182c93fff9b400\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/system-status/rematerializeAction.js\":\"a8f2b69835225258\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/system-status/useHysteresis.js\":\"ccab7c330fb875b4\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/ColumnHeaders.js\":\"8f31f13c3f2f74ee\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/QueryUi.js\":\"8b1a3f8f87e51f31\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/TableLayout.js\":\"d7ebe6d6a8bf6262\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/actions.js\":\"00c9a27b744a816a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/cellEdits.js\":\"7e8d862242c48054\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/columns.js\":\"d405419bd20f42de\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/controller.js\":\"fba9b6793405a7af\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/convert.js\":\"2df16e3897ea1831\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/dataExtension.js\":\"001c97001a49b0db\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/index.js\":\"ad581902467d8384\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/keys.js\":\"1c68637e91ceb91c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/model.js\":\"e0cab5988ffd8bc0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/query/backfill.js\":\"5907bef89de805ea\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/query/format.js\":\"4ec29daa1cc4a08e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/query/parse.js\":\"d0546372a48a58fd\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/query/queryValue.js\":\"313876d642f29091\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/query/source.js\":\"c5945f011ffddd55\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/registry.js\":\"c822de559025d798\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/schema.js\":\"80524a9a63f4e15e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/tables/sort.js\":\"5f3ffc2808200d0f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/theme-toggle/effect.js\":\"e138454e0685ef84\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/theme-toggle/index.js\":\"9053f98374e056f8\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/theme-toggle/theme.js\":\"70b884ed2b40097b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/todo/actions.js\":\"10951b11977356b6\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/todo/dataExtension.js\":\"fbface21d30a779c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/todo/index.js\":\"a2e49e4bf1096614\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/todo/schema.js\":\"794c13bcc04a6c4c\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/touch-selection/TouchSelectionLayer.js\":\"6878ed11a308c160\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/touch-selection/actions.js\":\"f9b392ba5e32fb7d\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/touch-selection/defaultItems.js\":\"f14311bf6490a537\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/touch-selection/facet.js\":\"8995cb62c9a8505b\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/touch-selection/holdRecognizer.js\":\"8bad25902c9db939\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/touch-selection/index.js\":\"800696a94b873c31\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/update-indicator/UpdateIndicator.js\":\"4b2c03debf276fde\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/update-indicator/index.js\":\"182cab9d2d6d5f3f\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/update-indicator/loadTimes.js\":\"5414258d380ff197\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/VideoNotesRenderer.js\":\"0ce203c3aa50136e\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/VideoPlayerRenderer.js\":\"bef244d50130ae74\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/VideoTimeStamp.js\":\"fc4cb614232a1172\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/actions.js\":\"f3ff878ef49df0bd\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/index.js\":\"52518a9bd97c87f1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/markdown.js\":\"8b103e1ad28a0b1a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/notes.js\":\"1fec0040dc3c74ea\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/registry.js\":\"c239fe889014c6f2\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/remark-timestamps.js\":\"b1aea3f8e0939d46\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/video-player/view.js\":\"22c16da12420cde9\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/vim-link-hints/LinkHints.js\":\"6e366210ce31315a\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/vim-link-hints/index.js\":\"45ad8702a3d253ea\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/vim-link-hints/model.js\":\"6ac6f63896c40fe0\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/vim-link-hints/settings.js\":\"5086f4113c9cb145\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/vim-normal-mode/actions.js\":\"dd7b1e2e9e0cedd5\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/vim-normal-mode/index.js\":\"ecccbf4e56a6cce1\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/vim-normal-mode/interactions.js\":\"9ba790c2f3c6f3fb\",\"/knowledge-medium/pr-preview/pr-1842/src/plugins/workspace-header/index.js\":\"07637e613df726e5\",\"/knowledge-medium/pr-preview/pr-1842/src/registerServiceWorker.js\":\"e8fbe3c9ad560ba1\",\"/knowledge-medium/pr-preview/pr-1842/src/requestPersistentStorage.js\":\"c1f952222e9b8078\",\"/knowledge-medium/pr-preview/pr-1842/src/services/authRequestDeadline.js\":\"0459c151e23571f6\",\"/knowledge-medium/pr-preview/pr-1842/src/services/authStorage.js\":\"f71e270042bae2b5\",\"/knowledge-medium/pr-preview/pr-1842/src/services/powersync.js\":\"ffa07259422f323a\",\"/knowledge-medium/pr-preview/pr-1842/src/services/supabase.js\":\"5ffbb2eadfdf1d23\",\"/knowledge-medium/pr-preview/pr-1842/src/services/uploadErrorClassifier.js\":\"29a2f69887f266d4\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/ActiveContexts.js\":\"e41cde13ddffe618\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/HotkeyReconciler.js\":\"0391750c869c17e0\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/WipeLocalDataDialog.js\":\"65c0d6932949fe7c\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/actionDispatch.js\":\"1e93f11e144d7ef0\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/actionRefItems.js\":\"31b7fbb2fade9407\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/applyKeybindingOverrides.js\":\"e89e787fc1670651\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/blockActions.js\":\"1d966d6335ce1f92\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/canonicalizeChord.js\":\"114589347c50852e\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/defaultContexts.js\":\"2985322f456b3188\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/defaultShortcuts.js\":\"c1390afe6bc3c985\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/effectiveActions.js\":\"b59e9c4ea97dd5ea\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/gestureAction.js\":\"6194ce5dd4dbfb7c\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/gestureBinding.js\":\"fcdca8360714ac26\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/holdRegistry.js\":\"6d6144862ee7979c\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/keybindingConflicts.js\":\"a52bf5334fb44407\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/keybindingOverrides.js\":\"f0e68d760227dd5b\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/pointerAction.js\":\"1cabd69eb079d729\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/resolve.js\":\"c28a59decf89f223\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/runAction.js\":\"ffab04b494949a03\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/sequenceMatcher.js\":\"bc75a9897a941e49\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/types.js\":\"e86dddfae1128669\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/useActionContext.js\":\"819ffa7db9a31405\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/useActionDiscovery.js\":\"b5a36d5a092a536f\",\"/knowledge-medium/pr-preview/pr-1842/src/shortcuts/utils.js\":\"cdcc625be6e8e9b5\",\"/knowledge-medium/pr-preview/pr-1842/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1842/src/sw/bootStore.js\":\"4573d633ecfcafcd\",\"/knowledge-medium/pr-preview/pr-1842/src/sw/previewDatabases.js\":\"50c4548b3d797ab9\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/byteTransform.js\":\"910af63b0f817eb5\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/attachmentCleaner.js\":\"0ef2cdfa4949d63e\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/bundle/attachmentParts.js\":\"5dbdd44e7fbbad74\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/bundle/bundleParts.js\":\"3d04332f491d44ba\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/bundle/bundleRecord.js\":\"49fc5b6e98e7c06e\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/bundle/manifest.js\":\"c0a5e634bd8f577d\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/bundle/takeBundle.js\":\"7b870aee525b0a9a\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/bundle/verifyBundle.js\":\"9ee200b1cef7eebd\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/cleaningStage.js\":\"5675ec7278f41fe3\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/conversionKey.js\":\"7b36022e43cae3e0\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/conversionServer.js\":\"2b7f9877b457e682\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/flip.js\":\"34cf9f77bcc1f735\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/flipAttempts.js\":\"a61992c5178b0dfc\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/pages.js\":\"d2ec876f6903ee85\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/preflight.js\":\"1b2d825c54677650\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/reseal.js\":\"52919ae888357625\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/runConversion.js\":\"d9df1fd131cd93c6\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/runLock.js\":\"285ef46f62c41dfa\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/sealing.js\":\"ef5177f0e2f219d0\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/sealingStage.js\":\"abee3b0d873f5c46\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/stage.js\":\"dff387eb232686da\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/conversion/verifyReseal.js\":\"f144f3dfcf6c6f85\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/aad.js\":\"9d1f92c8346452d9\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/aead.js\":\"c126929e36d20ad6\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/base32.js\":\"e76f61012e74839d\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/base64url.js\":\"2813f58fbc78e287\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/binaryEnvelope.js\":\"2ef082cde85b6a7f\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/byteAead.js\":\"d9cad86a81f965d4\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/canary.js\":\"e13763caee9733ac\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/contentHash.js\":\"9a34fabac3656465\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/contentKey.js\":\"b7c417645d0e855c\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/derivedIdNamespace.js\":\"d2cca3a16fbc4356\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/envelope.js\":\"11df53afe2ee0f4b\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/hex.js\":\"f7c4aa9dbc66dcf6\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/sha256Hex.js\":\"9818ec96f4db4b15\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/crypto/workspaceKey.js\":\"576b7af7be166764\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/conversionState.js\":\"89ca4735d3c62f95\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7297e2a0168fb80e\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/flows/pastedKey.js\":\"616890d6e740c01c\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"800f9c821e877243\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d9bf81f4f28f5ae5\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/keyStore.js\":\"03ebcda2bd02db64\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/mintWorkspaceKey.js\":\"7b07637b030fe645\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/modePin.js\":\"92900fd5cc2c0676\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/openWorkspaceKeys.js\":\"6a8c9e8050256e6c\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/resolveWorkspaceEntry.js\":\"13cb97ec6234d4ca\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/resolver.js\":\"8aca3e356d5ca7ce\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/keys/workspaceAccess.js\":\"7300470ecbdf81d5\",\"/knowledge-medium/pr-preview/pr-1842/src/sync/transform.js\":\"b94bde58ba2f5a9d\",\"/knowledge-medium/pr-preview/pr-1842/src/themeBootDefaults.js\":\"adb01eb063b40bd0\",\"/knowledge-medium/pr-preview/pr-1842/src/types.js\":\"7f2b749e1f66f3a3\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/ClientLocalSettings.js\":\"1644eda831cfc9a9\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/abortableSleep.js\":\"6734fd5b01c0a6d2\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/array.js\":\"42330e9597bb4e46\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/backlinkAutocomplete.js\":\"c07389665a6f7d2e\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/blockCrumbs.js\":\"a9bf242ce8484678\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/blockrefAutocomplete.js\":\"5396481c19a613cc\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/cadencedIdleJob.js\":\"c446aa9c7641cdc0\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/callbackSet.js\":\"b9f3abe4ad6878ad\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/clientId.js\":\"b60f4f15b300cef2\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/codemirror.js\":\"2699ca7a34490c92\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/codemirrorCompletion.js\":\"e97060d7c6316358\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/copy.js\":\"993fb50a64b9e7e2\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/dailyPage.js\":\"45f639e43afe9bf8\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/dbForensics.js\":\"4da2ab5a0fe505db\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/dbForensicsHooks.js\":\"a51e38e77c062fe7\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/deleteBlockThroughUi.js\":\"229af65e535f307f\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/dialogs.js\":\"5f202457c86962a0\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/dom.js\":\"403c6e8a5168c2cf\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/downloadBlob.js\":\"dc6c2af9e4e982d4\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/exportSqliteDb.js\":\"17d9d2eaa6cffb6d\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/fileSystemAccess.js\":\"a40af8b6c5b2c561\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/flipSlide.js\":\"f9db8d39717ccbfb\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/fnv1a.js\":\"47836f8a8ae9bc94\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/formatBytes.js\":\"0092e4695ec30e4f\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/fuzzyRank.js\":\"8fec5eb64752f623\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/idbKeyedStore.js\":\"c9de794a3223e160\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/idleCallbackPolyfill.js\":\"f8c37acd2b954f39\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/keyboardAwareScroll.js\":\"02b6ddda5df8d87a\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/keyboardViewport.js\":\"3d9c143a08d80357\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/lastWorkspace.js\":\"e4e342833d14020c\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/layoutColumns.js\":\"0ee12cf3937e6504\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/layoutSessionDom.js\":\"f162a42904b7a9db\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/layoutSessionId.js\":\"d92cbe70072767c5\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/linkClickGestures.js\":\"7a07e59a6ae3efcb\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/linkTargetAutocomplete.js\":\"79d15c04b30ca970\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/localDbCorruption.js\":\"85fb1a6d00e456e6\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/localDbRecovery.js\":\"2c7cb274a5d1d03a\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/markdownParser.js\":\"0a38ffdf3cd7392d\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/memoize.js\":\"1c17db810847eb6c\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/nameFieldCommit.js\":\"bb68b0f16fedaa3d\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/nameList.js\":\"632060cbbe6a0fd9\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/navigation.js\":\"67b86641bc08bdf6\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/omnilinerNamespace.js\":\"edaa34422f9d195a\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/opfsPageScan.js\":\"54a4a3ef95df9731\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/panelClearance.js\":\"b187ded6d331f394\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/panelHistory.js\":\"70c0b0c60443b321\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/panelLanes.js\":\"ef6a1d6d0c123bc2\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/panelLayoutProjection.js\":\"fa918dc4b5a85787\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/panelScrollAnchor.js\":\"3704e1005f6f5f95\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/panelUrlFlags.js\":\"0e7db4dbf8153efb\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/platform.js\":\"e7171dcbafdb0332\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/pluralize.js\":\"a5f51c5616e77b81\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/propertyCreation.js\":\"86fd28d4b4d4e8d5\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/propertyNavigation.js\":\"5f5a6041e5c83882\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/propertyValueContext.js\":\"95a425c6a286c2ef\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/react.js\":\"7ce8a22f30c90eae\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/relativeDate.js\":\"03ede5a26fce2d3f\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/relativeTime.js\":\"a2a241669f422a01\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/renderScope.js\":\"d27bac02e0c10184\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/resolvedThenable.js\":\"397a192501df4701\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/routing.js\":\"4cd322db7e9ee041\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/safeMode.js\":\"81442a99e8b75629\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/scheduleIdle.js\":\"0133bc1528655c96\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/screenWakeLock.js\":\"876370b520d6f090\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/selection.js\":\"90313fd72decbf73\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/softKeyboardGrab.js\":\"6b66610d0173b6d8\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/startupTimeline.js\":\"819863ca6cdbbc1c\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/state.js\":\"96c65e1498381433\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/string.js\":\"66e20bf8fb6819db\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/surfaceZoom.js\":\"c75d33408afc075d\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/time.js\":\"57d82a18dc6708a3\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/toast.js\":\"bb35c64ad1f13980\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/toggleStore.js\":\"18eb333cde91c3f6\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/untilStopped.js\":\"19006c730eff14f3\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/userActivity.js\":\"5f168b4389bd5cbd\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/viewTransition.js\":\"517c33bba29dcde2\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/viewport.js\":\"41ffb6e9f744fff9\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/webLock.js\":\"2eeade535cb40e32\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/workspaceRecovery.js\":\"34871f23c9c15276\",\"/knowledge-medium/pr-preview/pr-1842/src/utils/workspaceSnapshotStore.js\":\"4c5e3efd093a29fb\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-compiler-runtime.js\":\"28d85e568c56322c\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-dom-client.js\":\"7bff3892a8928eee\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-dom-server-edge.js\":\"50d37a10018fc97c\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-dom-server.js\":\"8223a7e0d3ee35b4\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-dom-static-edge.js\":\"f15b3200229b01dc\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-dom-static.js\":\"483c83d927dea8a2\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-dom-test-utils.js\":\"91865346afc15878\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-dom.js\":\"554340fa67ce11e8\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react-jsx-runtime.js\":\"f618cd2eed91ce17\",\"/knowledge-medium/pr-preview/pr-1842/src/vendor/react.js\":\"8f117dae1c6ddf06\",\"/knowledge-medium/pr-preview/pr-1842/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1842/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1842/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
