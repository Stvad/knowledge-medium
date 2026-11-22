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
		buildId: "d9dbb58f911e-647f82dd",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/\":\"c518369276020601\",\"/knowledge-medium/pr-preview/pr-1843/index.html\":\"c518369276020601\",\"/knowledge-medium/pr-preview/pr-1843/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1843/assets/FacadeVFS-ofj0i22q.js\":\"a6e1f28e5361feec\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSCoopSyncVFS-BhrlvFWA.js\":\"8fc25c534ea5c990\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSWriteAheadVFS-DS0_FyaA.js\":\"16e103b17d91d23e\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CRCguSI5.js\":\"aa6dbe9e5bc6a3b3\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-GLERWaka.js\":\"cf98e2fdd0d1dbaf\",\"/knowledge-medium/pr-preview/pr-1843/assets/worker-B9r2ZG4t.js\":\"4f9964d75f43f9e6\",\"/knowledge-medium/pr-preview/pr-1843/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1843/chunks/app-Cfv8gWmJ.js\":\"f79f6f89342c7bb7\",\"/knowledge-medium/pr-preview/pr-1843/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1843/index.js\":\"09867a206f05b79a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1843/assets/AccessHandlePoolVFS-BrHqH0LF.js\":\"3dd3b425d7f584f3\",\"/knowledge-medium/pr-preview/pr-1843/assets/IDBBatchAtomicVFS-DisVqdIZ.js\":\"715765c3a8a2d1d6\",\"/knowledge-medium/pr-preview/pr-1843/assets/MemoryVFS-CT4RX-8V.js\":\"4f9a7b62a7277c63\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-BUt3sh4X.js\":\"b01cc87057ea9771\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-BhT5GCaC.js\":\"f0ae8daa6730efe3\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1843/chunks/AccessHandlePoolVFS-v2JxbnaZ.js\":\"9f05c19716c230d3\",\"/knowledge-medium/pr-preview/pr-1843/chunks/FacadeVFS-G8QnRIxe.js\":\"e3a8c503fc56f9a4\",\"/knowledge-medium/pr-preview/pr-1843/chunks/IDBBatchAtomicVFS-CGiToVqc.js\":\"0ee7d8b11d2a3c14\",\"/knowledge-medium/pr-preview/pr-1843/chunks/MemoryVFS-DsRSbyV0.js\":\"0cd7c926bd6d7695\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSCoopSyncVFS-CB2eQMZV.js\":\"dd917682c64ce405\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSWriteAheadVFS-BeXQ8S4O.js\":\"b942d54a46c67dce\",\"/knowledge-medium/pr-preview/pr-1843/chunks/Preview-DbU6BRiL.js\":\"994982c946a403a0\",\"/knowledge-medium/pr-preview/pr-1843/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/card-Dm5q8Mb8.js\":\"3f02f33ec4ddbf5b\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-B278WQbq.js\":\"f545120eac1b5bcd\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1843/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-B9TJN1tb.js\":\"25c78e2fa0e0eb26\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-async-BT0UTX_Y.js\":\"ed020206259b34be\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-B_bw0ovG.js\":\"6c6779244aa5371f\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-CSSzUed-.js\":\"966c050b82eb502c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-CeVugwT-.js\":\"a2369a2e829991b3\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-CyyA4aRo.js\":\"b9bbdf6724e5d270\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-CzFub1tZ.js\":\"63751d3805cf3eb6\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-DgIpTCM5.js\":\"d8a8789a1a6e5ebc\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-JhM7MaRg.js\":\"bef7240fab1897f9\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server-legacy.browser.production-NLSkdPiT.js\":\"b6cd93f810aa00ce\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.browser.production-B-KfGF2t.js\":\"a5eef22c536337cb\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.edge.production-BGj9nYXC.js\":\"8aa5fd7a240bdfe8\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-qrWPbyAy.js\":\"e6d6d74b811747ae\",\"/knowledge-medium/pr-preview/pr-1843/chunks/server.browser-DqL9V_T9.js\":\"610e6ee91b0da20a\",\"/knowledge-medium/pr-preview/pr-1843/chunks/textarea-KDsVx794.js\":\"0de825917bed7e74\",\"/knowledge-medium/pr-preview/pr-1843/chunks/ui-DpsG5Ytp.js\":\"eee63b436bf8d44d\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-async-DnYoTG4E.js\":\"117a0af3381be428\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-smHdvteP.js\":\"915b850638bb69de\",\"/knowledge-medium/pr-preview/pr-1843/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1843/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/src/App.js\":\"690dd6225b2e944d\",\"/knowledge-medium/pr-preview/pr-1843/src/appUpdate.js\":\"82b3c81c475420d5\",\"/knowledge-medium/pr-preview/pr-1843/src/appVersion.js\":\"26b02b05a9210f06\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/initialLayout.js\":\"fdd4d6bc8c7fc94b\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/openWorkspaceData.js\":\"c4efb1f0fc0b4deb\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/resolveWorkspace.js\":\"73eb36dde419a074\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/workspaceBootstrap.js\":\"14122adda407c80c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockComponent.js\":\"9ec63822904ff923\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockCrumbs.js\":\"c9f2e082d85a38b8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockEditor.js\":\"9579208a4e46bbae\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockLoadingPlaceholder.js\":\"a1583f65e9355f30\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockProperties.js\":\"8581929f7633948b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockSearchPicker.js\":\"440d397b77c4c047\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ConfirmBulkDeleteDialog.js\":\"8d58752e9082f063\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DividerHandle.js\":\"37deb53981d9f5c6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DraftEditor.js\":\"fde7e8c5391ef66a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/GutterPill.js\":\"4292ac0a07a58eb9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Header.js\":\"900358bffc71018a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/LazyBlockComponent.js\":\"1b6688880ab410b6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Login.js\":\"0aab77399f07711a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ZoomableSurface.js\":\"ccab1388812a23e4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/editModeKeepalive.js\":\"b8573dd6cb46d827\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4e1c925c68290508\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5b953e3d4ab6959a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefPropertyEditor.js\":\"5fde5d1f82de9f49\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefTargetTypePicker.js\":\"68c871274028a636\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/SelectPropertyEditor.js\":\"6e60d2117b0175b4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/TypesPropertyEditor.js\":\"6db8d040cf9530e4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/defaults.js\":\"8ac6d324c5c55cbf\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/kernelValuePresets.js\":\"a1239c8c2ba410e9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/selectablePresets.js\":\"af03f9edde4a05e0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/typesPropertyUi.js\":\"0c7f8bbcbc188c4b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/AddPropertyForm.js\":\"daf0563735c067eb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyPicker.js\":\"b93b9ee6826ee006\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyRow.js\":\"f29295f7808641b4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/Rows.js\":\"7c743ba6d75194f2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/actions.js\":\"a552fe38b6801bfc\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/declarationOnly.js\":\"1c516da599f8e40a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/layout.js\":\"69cd624c6b4b7d5b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/model.js\":\"b9ab94e2a82f2cd4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapeUi.js\":\"f4c2cb86a3932059\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapes.js\":\"bfbf32c5be2081ab\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ca5bca44b9dcc61f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/visibility.js\":\"4c52b2cdf932ef6f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanelSections.js\":\"35c53d7dfe4c5f8c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockEmbed.js\":\"fd637b6db0e7aa81\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockLink.js\":\"a1fc4e8741486b13\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockRef.js\":\"7f9e232b6f0fe9e9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/ReferenceLink.js\":\"b7124d274281f137\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuard.js\":\"0947938af3f8a091\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuardContext.js\":\"b405b56de459ccaa\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/linkInteraction.js\":\"c83fada653e367bb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/referenceLayout.js\":\"ec0a301c6a697118\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/useBlockRefAncestors.js\":\"c87f94ca376b35da\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockGutter.js\":\"b4c291c5bae7c29f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockInfoDialog.js\":\"1ed1657ae3c862d7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockTypeBlockRenderer.js\":\"fd0d3c16d7a5d444\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BulletHoverCard.js\":\"4195578c4002e95d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorContentRenderer.js\":\"0c4bb2eb7bc0dd69\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f6b869dd0970b537\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ColumnResizeHandles.js\":\"061c603c0fa2b0f4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3bbb92e91bb30250\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/DefaultBlockRenderer.js\":\"0558fc4e57d1f11a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/LayoutRenderer.js\":\"f4a8406742b148bb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MarkdownContentRenderer.js\":\"22666801cf61ac48\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MissingDataRenderer.js\":\"0aff663406f9492b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PanelRenderer.js\":\"84cb120c1d617d46\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6a8c856f103ecfda\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/TopLevelRenderer.js\":\"dfc17cb6e3a91d0e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockGutterMode.js\":\"eddb89c5202c2b06\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockTitleText.js\":\"79925e2a7411f71c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/fieldCreationKeydown.js\":\"15f5d348675b089a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/layoutRootContext.js\":\"92e073078cb23a8d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/TypeChip.js\":\"203492d55f0ff285\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/chipStyle.js\":\"73865a2f08259717\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/anchored-floating.js\":\"4371c57a2ccfecfe\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/button.js\":\"c7ee311865893d12\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/card.js\":\"c98ce6c51b26464c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/checkbox.js\":\"57e34bf9d8e6ee84\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/collapsible.js\":\"edca1c155b9b631f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/command.js\":\"86a51da99df518f6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/context-menu.js\":\"f5437a7c2b731ac7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dialog.js\":\"742d0714e0971d87\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dropdown-menu.js\":\"41ec4182eda3b61b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/floating-listbox.js\":\"163cd5938562da4d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/index.js\":\"18c010c0520321bc\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/input.js\":\"2921f449be4fe517\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/kbd.js\":\"9919528f0d8fb27f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/label.js\":\"b75ff3094a6bd75c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/textarea.js\":\"902381a489cd7e9d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/useEditModeYieldKeepalive.js\":\"8a62e43cd643f3f2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/BootFallback.js\":\"9a4d03dc91ec1a3c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/FocusedRowLazyMount.js\":\"95d1dddd43750293\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LazyViewportMount.js\":\"e854f65ca830e10b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LocalDbCorruptionFallback.js\":\"514f24180dc2b256\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/error.js\":\"a50dbcc7302d3b39\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/lazyMountRegistry.js\":\"c7274d13484a83dc\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/suspense.js\":\"c8069bbc21e55614\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/CreateWorkspaceDialog.js\":\"678096ef7da516c6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/PendingInvitations.js\":\"9d2acc4dc8d9c27a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/SyncProgress.js\":\"6d7d3a2e72901158\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/UnlockProgress.js\":\"71bce1643c95baba\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceKeyGate.js\":\"5a4234d8cb7c2d98\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSettingsDialog.js\":\"9b4c95b10ef967bf\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSwitcher.js\":\"2440634ba484d170\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSyncGate.js\":\"16e1731bfe406f66\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlow.js\":\"ff2a159b4279d1f8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlowHost.js\":\"8287ecbfdc6f0571\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/EncryptionSection.js\":\"005a50ad4dcf2c69\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/attachmentPrompts.js\":\"39f7b720625e87c4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/bundleFolderPrompts.js\":\"73bf205cdc8f6913\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowDeps.js\":\"ab71a86f24f6ae26\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowStore.js\":\"4a53165f7592280f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/flowUi.js\":\"20e3bc71d000aeb3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/useConversionRun.js\":\"ca8147fee4265eb4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/keyUi.js\":\"2a5925ffa4e162eb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnKeyLoss.js\":\"f7dd99801af92431\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnServerE2ee.js\":\"0497ef7aca0ed08f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/workspaceUnlocked.js\":\"778d4b237f0fb5b5\",\"/knowledge-medium/pr-preview/pr-1843/src/context/backgroundSubtree.js\":\"86bb4221cab69f35\",\"/knowledge-medium/pr-preview/pr-1843/src/context/block.js\":\"eb3a63ffb3f4d83f\",\"/knowledge-medium/pr-preview/pr-1843/src/context/layoutWsContext.js\":\"15459ad011921dc5\",\"/knowledge-medium/pr-preview/pr-1843/src/context/propertyDisplay.js\":\"37b66755caa02ed3\",\"/knowledge-medium/pr-preview/pr-1843/src/context/repo.js\":\"3095136a5e31d13d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasClaim.js\":\"d389716cca6dce80\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasSeatNamespace.js\":\"fe519bd6078269bc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockData.js\":\"ffe768b01664e1ef\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockType.js\":\"01144bf0662dca8c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/changeScope.js\":\"b5ee4e890f9c82ed\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/codecs.js\":\"0fbde322a5d80acd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/derivedData.js\":\"51bc40f8a43a10c1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/errors.js\":\"65df1efad93683b2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/events.js\":\"d07f5a43eddd8860\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/handle.js\":\"ca64409022dc7095\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/index.js\":\"8fb01e7cecf9e507\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/mutator.js\":\"a0ff13f1e765ee39\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/processor.js\":\"2d406cdfd97d7f67\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/propertySchema.js\":\"dbae04715bfe2f79\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/query.js\":\"6d266988c98c583b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/sameTxProcessor.js\":\"db03d1cf0f77bfd2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/schema.js\":\"ca64409022dc7095\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/tx.js\":\"ca64409022dc7095\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/typedBlockQuery.js\":\"e0d120b9ddebfc1b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/user.js\":\"cd49940c0ea07b37\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresetCore.js\":\"4b1b9f2804fca771\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresets.js\":\"da6783bf6f1368f5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/attachmentCleanerIOVerb.js\":\"0dfd80fc1969f47d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/block.js\":\"12d17170f624939a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockCache.js\":\"6298b530d2051f70\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockId.js\":\"e515bab6880bd40c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockLiveness.js\":\"34bd191d54a5b4ff\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockMerge.js\":\"7e85977cf5f7d1a8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockSchema.js\":\"e0c71072f0dba721\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypeLookup.js\":\"7b99e892cc7b20d2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypes.js\":\"ec04a4c2bd581360\",\"/knowledge-medium/pr-preview/pr-1843/src/data/clientContext.js\":\"e90a59cbdff5b1c6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/dbFileSiblings.js\":\"d3ea125ef02a781d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/definitionSeeds.js\":\"3085099e089a654b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/derivedIds.js\":\"0c618d88d37405dd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/drawnSubtree.js\":\"f14261108d39250c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facetBridge.js\":\"ee3b2ff1b700bf5d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facets.js\":\"254eea40c38989e4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/globalState.js\":\"7f3506e916bb501d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/aliasClaimRederiveProcessor.js\":\"acad80be92dd44e5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/ancestorBatch.js\":\"1c8af17051c9e212\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/blockTypeTypeifyProcessor.js\":\"80dd8ee7e156c2a4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/clientSchema.js\":\"83ab1b74d8256b5c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/commitPipeline.js\":\"89035060d2c5acfd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/devAssertions.js\":\"ea099f7b2eda6b04\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/firstSync.js\":\"d9a8f284e88fb113\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/freshInitialLoad.js\":\"7fe145d7992f17b3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/graphBackfillClaim.js\":\"7056c7378feafd1f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/handleStore.js\":\"efe2b446d39ae4eb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/idleMarkerJobs.js\":\"2a22866e6227d075\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initialDownload.js\":\"1cb0416b2c320d13\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initializeClientDatabase.js\":\"e3cbadfb550af66a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/jsonCanonical.js\":\"7e291a36fbf816b8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelInvalidation.js\":\"45f041db45514edd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelProcessors.js\":\"abcad4b9c6155f99\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelQueries.js\":\"5f005d4669ea1afc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/mergeTypeMembershipProcessor.js\":\"710a0c28abb4506c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/normalizeReferencesProcessor.js\":\"99deaae4ac60b323\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/poolInstrumentation.js\":\"3fdfb7ac2d5364ba\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/processorRunner.js\":\"dc290a5b117679ae\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyCellBackfill.js\":\"6522776cdb2296e7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildMint.js\":\"f9e3207bca2e81ef\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildrenProcessor.js\":\"edc5719c72b99235\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2c9279f9b30ad2b7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionSynthesis.js\":\"7c9fea4e8fd22993\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyKeyScan.js\":\"a8ec98a266781aed\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertySchemaResolution.js\":\"54c98e50395f8cf3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyValueEdits.js\":\"dd615ac70e7dac4a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/raiseProtocol.js\":\"30073329816991a8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/readBatch.js\":\"9b6dc56961f37c23\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/refProjection.js\":\"dccb45522d400aae\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetLookups.js\":\"847a11a42dd30d86\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetProcessor.js\":\"faea0250b83a99b1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/replayMerge.js\":\"ad5f20359d27050a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/sqlBinds.js\":\"025a0a6aa43b2c45\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"673f41191d519c5a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/arrivalProcessors.js\":\"a30c743cdb46559c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/invalidate.js\":\"aac390769ccc4971\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/materialize.js\":\"e5d88b9629ef27a4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/observer.js\":\"7c11c294637cf324\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/reconcile.js\":\"7b8121a82bdacceb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/timingMetrics.js\":\"9766519faab833e4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/treeQueries.js\":\"a8ee6689af49bf66\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txEngine.js\":\"78f4130528de7020\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txSnapshots.js\":\"488f96905db14983\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/typedBlockQuery.js\":\"dead09f40a5e628a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/undoManager.js\":\"fb6044d97b048f83\",\"/knowledge-medium/pr-preview/pr-1843/src/data/invalidation.js\":\"83ffb090e7ec543a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelDataExtension.js\":\"9564a270521d9116\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelPage.js\":\"2427106bd909b596\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelValuePresetCores.js\":\"fb509e08a77eec38\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbCorruptionSignal.js\":\"bf9e9a8df0984519\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbStorage.js\":\"a84a3932e2af2151\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbVfs.js\":\"16bfee52bfbb0491\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localSchema.js\":\"3e3354bcc5bcaef1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/maintenance.js\":\"599c24599abfbe54\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mergeProperties.js\":\"4231e6ed88fbd760\",\"/knowledge-medium/pr-preview/pr-1843/src/data/metricsConsoleHook.js\":\"f82f2c159950ee66\",\"/knowledge-medium/pr-preview/pr-1843/src/data/migrationsPage.js\":\"2872fa089c1bc516\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mutators.js\":\"47aceca805fb849e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKey.js\":\"193d4933a2fd448a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKeyPlacement.js\":\"07e33c8663480495\",\"/knowledge-medium/pr-preview/pr-1843/src/data/outlineSurface.js\":\"13946fc4b6cd8fc4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingEditorContent.js\":\"4f9843a345ad49a4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingUploadsSql.js\":\"506f75281508716c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pluginStateExtensions.js\":\"bd4194fcf7801ab0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/powerSyncLogger.js\":\"0b6aa3c7b085370d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/projectorRuntime.js\":\"abe42e87c27dd496\",\"/knowledge-medium/pr-preview/pr-1843/src/data/properties.js\":\"683041e4ea3211fe\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertiesPage.js\":\"43cdb0fbb717d1cb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyChildren.js\":\"dbaf0bf0e7645330\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionFanout.js\":\"74c4333591f52e53\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionMetadata.js\":\"8e690717a6dbd978\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionRegistry.js\":\"c1079586d64dc956\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDisplayMode.js\":\"b1c841578555d955\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyRowCreation.js\":\"b51dc12019539e67\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySchemaCreation.js\":\"3f4c7a6898bd51f7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySeeds.js\":\"23d0c5df12fd5eed\",\"/knowledge-medium/pr-preview/pr-1843/src/data/recentsPage.js\":\"90094408d9d844c0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/referenceBlock.js\":\"e78a116ba19c00f0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rejectedUploads.js\":\"66dc645efc1393c3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/releasePowerSyncConnection.js\":\"1784d228d2494c30\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repo.js\":\"f1fd5d72dbf9b551\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repoProvider.js\":\"ded051616c953895\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rowProperty.js\":\"ed5ca583415aaa9b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/searchFilter.js\":\"7998e45e1a0391bc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/seedIdentityLedger.js\":\"d563761ab2bfd41f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/stateBlocks.js\":\"ea35dbde678b468a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/structuralEditPolicy.js\":\"5819ebead17e3987\",\"/knowledge-medium/pr-preview/pr-1843/src/data/subtreeDelete.js\":\"410e805e7dcb3be1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncStreamLock.js\":\"984f86bc72ddf9a6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableSqlRecognizer.js\":\"4c3f1d3d96d6b269\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableWriteGuard.js\":\"075e3fc83e4d6f76\",\"/knowledge-medium/pr-preview/pr-1843/src/data/targets.js\":\"dc6abad4abfdfaba\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeColors.js\":\"0b143adcfd1c499c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionMetadata.js\":\"1f98b254cc4c9838\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionRegistry.js\":\"ffcfad47205e2e05\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeExtraction.js\":\"89da0f580138fe33\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeInitialValues.js\":\"052ee6094764b184\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typePropertyGroups.js\":\"3eb871c2e99b60d9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeSeeds.js\":\"6e19c290c530c750\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeTagger.js\":\"528352aafff3c30d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typedRecords.js\":\"44ce619edac3b8f7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typesPage.js\":\"140a7f27954528be\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userPrefs.js\":\"e5d6ce96ddfccee2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userSchemasService.js\":\"48313909959ee738\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userTypesService.js\":\"3da1744fd3101121\",\"/knowledge-medium/pr-preview/pr-1843/src/data/valuePresetRegistry.js\":\"d13da8d4c12120c1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/visibleChildren.js\":\"035b2597f7c76aa1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceConversion.js\":\"9dfd7d90fc6105a4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceFirstSync.js\":\"9c981986616bbada\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceIdNamespace.js\":\"7535173be0ba3cd9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceSchema.js\":\"bcea1e1fc0b5069c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaces.js\":\"297d637aa8b4882f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadLog.js\":\"d990b46a8754dd34\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/BlockPasteShellDecorator.js\":\"1cd91f10081a8a4e\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/atTrigger.js\":\"58e736a3d859bc93\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/autocomplete.js\":\"2cf894aad373bfa0\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/codeMirrorExtensions.js\":\"a79ca73244beb81f\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/contentFlush.js\":\"cc02cb28cbfb7bc1\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/defaultInteractions.js\":\"90b899e75985b23d\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/editSettleSignal.js\":\"6b1e35de5bd95af0\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/insertImage.js\":\"9551c15165b77bdc\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceCompletionRange.js\":\"ed16017d22294e40\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceTargetTypes.js\":\"2c0b893070d7810f\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/syntaxContext.js\":\"73f532965594e2e4\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/triggerMatch.js\":\"ae96511109c974ab\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/AppRuntimeProvider.js\":\"4ee3c5afae1bfb2e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/BlockFocusShellDecorator.js\":\"e40cb16c5f104ae1\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/ExtensionRenderBoundary.js\":\"a8d07cf2ad904799\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/PanelContentRecovery.js\":\"6ad93a69976f60b9\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/apiCatalog.js\":\"1082b026223d3bb9\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/approveExtensionHere.js\":\"993c0f4f579efc03\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/armedCutAppMount.js\":\"6e4484e3dcc49e6b\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/batchableKeyedStore.js\":\"1084d70b537d4281\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockInteraction.js\":\"913c8cdd104f7e5e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockSelectionAction.js\":\"5fd6090ba35a4bb2\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compileExtensionModule.js\":\"7128982614d521d2\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compiledModuleCache.js\":\"a46fcf16c448ca74\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/continuousGestures.js\":\"e5a3cace44f4bd85\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/core.js\":\"683992f9678ca102\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/defaultRenderers.js\":\"5307d66852a76dbe\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/definitionFanoutAppMount.js\":\"d28ea6e85e438c60\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dialogAppMount.js\":\"bef49eb0e7d54468\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensionSeeds.js\":\"438879aa0f42e472\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensions.js\":\"6d5f30b8d911b168\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/exampleExtensions.js\":\"49e3ad7b3bc21a37\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionApprovalStatus.js\":\"ad5b03eff0ccd195\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrorToast.js\":\"d85444ed2dbf4a82\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrors.js\":\"bf3ff5adf561efff\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLookup.js\":\"9f326adddc66ac53\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionToggles.js\":\"d52f1f3ed3309e33\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionUtilitiesCss.js\":\"c1c09680c389120b\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/kernelPageDeletionGuard.js\":\"f968475c633871ec\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/liveRuntime.js\":\"17439b836dc498db\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/openExtensionsSettings.js\":\"300b42f58396f545\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/overridesCache.js\":\"d7ae976a12aa337e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/pluginIds.js\":\"f4a6ac110d7fc86d\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/processorRejectionToast.js\":\"a734606ae86ebc1e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeActions.js\":\"61dbc592c9ef5ee1\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeContext.js\":\"20bbc34fb4fcaae9\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticAppExtensions.js\":\"634aa26ad677db58\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticDataExtensions.js\":\"bf1082c667e6efa5\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/toastAppMount.js\":\"050a79b649fa3041\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useOverrides.js\":\"e3aa7ea5f90a62f0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useShortcutSurfaceActivations.js\":\"20a1e4b8361cd6fc\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/discoverToggleTree.js\":\"22706bdff7f7c3b4\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/facet.js\":\"c2555030d3305414\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/resolveAppRuntime.js\":\"285c62ea6bafba20\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/runtimeEvents.js\":\"ca5062dae07192b0\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/togglable.js\":\"7c08eec4148046ec\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/variantFacet.js\":\"d88c1bd4c4a6aed2\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/verbFacet.js\":\"e64bb6dc13ff24bd\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/block.js\":\"bd40871923ef6dda\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/focusedChild.js\":\"d5c78f6cb5e76797\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/propertySchemas.js\":\"11ded57d4ce9b161\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/typeRegistry.js\":\"def6adfc5b9291c3\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAncestorCrumbs.js\":\"5de711e032126a12\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAutocompleteListbox.js\":\"1d4d85c23d8b6dae\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedSearch.js\":\"52035d157308c628\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedValue.js\":\"2b64e20a78d9415f\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsFocalRender.js\":\"5a348c79b50e3549\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsReadOnly.js\":\"6ee735e1f4c09d29\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMaterializeBacklog.js\":\"93dc0d5332d8211a\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMinuteClock.js\":\"39e8af1e49c43596\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePanelLayoutProjection.js\":\"b2fadd519d080253\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePendingInvitations.js\":\"4dd6d8c359f5bd6d\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRendererRegistry.js\":\"4a5a079c24658ea8\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRetainedFieldRows.js\":\"a77bcd43fc773176\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useWorkspaces.js\":\"fe6148203803599d\",\"/knowledge-medium/pr-preview/pr-1843/src/lib/utils.js\":\"e55847140e0653e4\",\"/knowledge-medium/pr-preview/pr-1843/src/main.js\":\"78f8db02134629bb\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/MarkdownImage.js\":\"04185ac6e5d60c71\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/blockSeparators.js\":\"b9fb294cbf6aa568\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/context.js\":\"10169cd114250eb6\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/defaultMarkdownExtension.js\":\"a1b15af491f0d54a\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/extensions.js\":\"17a93f9bff405c6b\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/renderMarkdownHtml.js\":\"f6844a485cbba32f\",\"/knowledge-medium/pr-preview/pr-1843/src/minimal-editor.js\":\"62e26a43ef7ab96c\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/armedCut.js\":\"5b5a2e905f27c178\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/captureMediaVerb.js\":\"8e8349533e5e594d\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/clipboard.js\":\"f89758778aa352bc\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/decision.js\":\"1bed937aa3cd00a5\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/operations.js\":\"8a089562d7a052b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/AccountHeaderItem.js\":\"d82cecb5914ae3fe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/index.js\":\"95a05111250f70e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2ee965cd66f74e5f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askAgent.js\":\"320d2a173d69e237\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askedStore.js\":\"8ddf6dc4dd5d660f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d4b02d2f7655844e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/chipState.js\":\"3af42d4b43cb0e84\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7eb5ecfa6698be7b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/index.js\":\"a8cc5873485212ba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c5220714ad19fb46\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/schema.js\":\"e305ca7c6ce06de8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6c1836695e4aff00\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/BridgePairingDialog.js\":\"3d2e907c41dbd40f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/addMedia.js\":\"50dd9702c0d14b65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/backlinks.js\":\"efdb66a18563f19a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/block.js\":\"65c2d1552373a090\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/context.js\":\"59adfb29645e9acf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e8a862f38976857a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/index.js\":\"8a32ac7eb0eea8f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/outline.js\":\"24d3b96dd7c5ffd0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/properties.js\":\"e54213b2bdd12bce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/refs.js\":\"d125be62991da2a8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"dc5ea1d8cc7c54d5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/search.js\":\"3ab047a7c259a46b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/shared.js\":\"e6cb6be5368509aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9e2a577a37376b12\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/text.js\":\"b1d1bd0f92053597\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentWrites.js\":\"c6b5f5afbf4c398c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/authoringCatalog.js\":\"59017fd9d4f73bc4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/blockRefTargets.js\":\"8c170651688b77dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridge.js\":\"135f2c316c984ea5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridgeLoop.js\":\"651f7104e151737e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/changeHistory.js\":\"3784222ec0441d80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commands.js\":\"ad708cda9ee3d9f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commentsCommands.js\":\"e21beab82c0fa121\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataExtension.js\":\"f5b17895e46651ee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataModelGuide.js\":\"dbaedb9f2d52e411\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/describeRuntime.js\":\"c6c19585587f40f3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/extensionLint.js\":\"72a05d5edae82ced\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/grainAudit.js\":\"aac21b9ee061cd87\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/healthCommand.js\":\"d09a477ea76605f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/index.js\":\"b0e28ed2e7905676\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/presetIdentity.js\":\"1102c6304ce655db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e4b1486e14d09678\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/readMedia.js\":\"682325d4e99103ad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/schema.js\":\"12455aeda13cf37a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/serialization.js\":\"3ba3bb5f3dd2322a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/targets.js\":\"0a94041d1dc63434\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/tokens.js\":\"748b76d7f7662574\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/watchEvents.js\":\"d2fe33924e6267de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/workspaceGuard.js\":\"ab2a3ad5040d811f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/writeCommands.js\":\"7f4e66655715d530\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/AliasCollisionToast.js\":\"e00c8e3fd66a37c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/DuplicateNameBanner.js\":\"65fe4a62a5aa6b32\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/collisionMerge.js\":\"7961c36bbb8581cc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/dataExtension.js\":\"14dcdb4b3e066605\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/index.js\":\"8c0c81c727d4f767\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/mergeCollisionAction.js\":\"504f11faa5183d3a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/pageStyling.js\":\"84d2907bb8db78b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/rejectionToast.js\":\"26dd3b2b25412311\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/syncProcessor.js\":\"b7f8b3839f4cce03\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/actions.js\":\"d73c2737c849f53e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/addComment.js\":\"0d119aa54b22d316\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchor.js\":\"d35de959c910a363\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchorState.js\":\"e87bd9d98d47c61b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/commentLinks.js\":\"4a60f32b602fcbd3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/confirmThreadDeletion.js\":\"f7ca77b2ecdde632\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/container.js\":\"e19ab64bb5ec3e76\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/dataExtension.js\":\"55240b3641fbe51c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/deleteComment.js\":\"38b9277a3a87aad7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/highlights.js\":\"fcc1e5db32833ca9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/index.js\":\"34944cc532beaafb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/linkedCommentsPill.js\":\"22e0ddb555717815\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/margin.js\":\"b62102531f75e2a1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/marginSchema.js\":\"79be041d7df15a7d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/newComment.js\":\"4f3200fdff3e7a30\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ownThreadPicker.js\":\"bd1470a511f5500c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/placement.js\":\"1fd1aae6fcb7c77a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/queries.js\":\"e70a3d0f0eaf1035\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotePosition.js\":\"15279f2f5c525c8b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedIn.js\":\"3ae70ca4ae05e404\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedRange.js\":\"d47ef5cf9afbbf2c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/rangeRefs.js\":\"ee60fd9356d390fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readHighlights.js\":\"b36b0a256e0dd008\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelection.js\":\"02d0f88f6643113e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelectionUi.js\":\"e71eba49d367c229\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/reanchor.js\":\"5717d6234c0458b1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/schema.js\":\"95238f8bf391cec0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scope.js\":\"1136b509cd04b19e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scopeThreads.js\":\"5028c255bccab654\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/splitRetarget.js\":\"508d7c018f246226\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestionCard.js\":\"18381e316f382a32\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestions.js\":\"5dad7ccbcdac566b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaries.js\":\"0c4941659c84d538\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaryBatch.js\":\"0325f8da5856f653\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/surface.js\":\"4fdf82c1e3e0a781\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threadNavigation.js\":\"158a3e2342c8d5d1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threads.js\":\"4797f9ea889c86c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ui.js\":\"823a833062df6064\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/uiStore.js\":\"25dbcc987d26cb8a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/appIntents.js\":\"3a9095241db0b699\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/index.js\":\"87110ec40dbd9e1f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/index.js\":\"d19b2e54c76ebf14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/status.js\":\"6db04df9cca465c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a02fb83cd8d83b4e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaBlockRenderer.js\":\"28c4dfd32a6b34bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaDownLaneReplicator.js\":\"221252c750d283a0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaUploadReconciler.js\":\"ed3a03828261e522\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetDownLane.js\":\"55516912d85cc720\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetResolver.js\":\"a5854848020028b7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetUpload.js\":\"dbfc8b39641cec17\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/attachmentCleanerIO.js\":\"4d4efbaab6b807b8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3a370a66a4ba1ed3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/blobStore.js\":\"6147138bb61e4453\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/byteStore.js\":\"817f89608f5d9688\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanerIO.js\":\"ead631d07d0e4b8a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanupAttachments.js\":\"e85f837d76bb1c90\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/dataExtension.js\":\"6b052d44861eaba3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/downLane.js\":\"6973eba1b321b2d5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/index.js\":\"de6d35e28ccbc292\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/insertImageContribution.js\":\"2455bd00d4fd5679\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneArming.js\":\"396246d03983c9dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneLock.js\":\"ac92a6f07958d496\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaBlock.js\":\"83398ed1bb5fb7a5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaCapture.js\":\"4199148f25cdfe4f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewers.js\":\"1fb99820e87cc8dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewersFacet.js\":\"5c0798e259406c6c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/pasteCapture.js\":\"5578fcac65c2ba96\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/resolver.js\":\"35e0644efcf79072\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/retryUploadsAction.js\":\"366ce2addbeb8318\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/storagePaths.js\":\"b9cb21626b2e9e31\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadDrain.js\":\"b3304a4d653842dc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadLaneStatus.js\":\"e8cb5019c2d5762d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadReconcile.js\":\"97977b347d6680eb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadRecovery.js\":\"5daae6787f749488\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadStore.js\":\"79bf4bdd179e5a67\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/useAssetObjectUrl.js\":\"c3c55c5e2aa34180\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6e1fc814512dd2b3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksViewSection.js\":\"1524457ebfe487b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/facet.js\":\"c69e8c268d9ca7f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/index.js\":\"9ce28cf4d1bd8fd1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/prop.js\":\"2489135dfc57c4fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinkFilters.js\":\"461303309e3cd628\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a29917ba737d74f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BlockEntry.js\":\"9622cc8ad72524e5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/LinkedReferences.js\":\"251976c58de2cc3c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"f10f6bdb42f6786b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dailyNoteDefaults.js\":\"181eee1c59947d73\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dataExtension.js\":\"69e19980830c1509\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/edgeExclusions.js\":\"1cabc34042406727\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/filterProperty.js\":\"90ceb7a5c001bf06\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/index.js\":\"7c576ca05dbf444f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"32d2c97286a67172\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/applies.js\":\"0fbc919516dbbe6c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/countQuery.js\":\"174347136985f38c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8eec87a7d68770d8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/index.js\":\"0bf61ec8778d854e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7ba460a79abff3f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/presentationInvalidation.js\":\"dcc9712313178a67\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyEditorOverride.js\":\"a383d08cc502b716\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyFilter.js\":\"84047a2b460e47a7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/query.js\":\"234013e374879d75\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/resolveFilter.js\":\"1eac8c5925658a62\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sourceBatch.js\":\"ba4866449358bcdf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sources.js\":\"2089e03681407b75\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useBacklinks.js\":\"5d95024fb0419315\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"41ee408cc72b32ef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayCelebration.js\":\"b0d1c0f82f6e394e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayOverlay.js\":\"2e60a4176b07fe30\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/gate.js\":\"19bd1edf31c6b40d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/index.js\":\"605bab4e29a201c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/wolfTheme.js\":\"e539370335cb601f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/BlockDragLayer.js\":\"758e1ba7dbc110b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dragController.js\":\"5c0895ef5ff9d7f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dropTarget.js\":\"64f9c3e1a58e7b4c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/index.js\":\"bc99582f937dea59\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/projection.js\":\"4597a20ddd48f1a3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/BlockMetaCard.js\":\"c0bb2edea5865d7f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/index.js\":\"de0cd13eda1862dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/AddTagDialog.js\":\"15f922fcda785815\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b7fa4ea456640e8a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/TagNameIssueHint.js\":\"7b34aac7c06612f4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/addTagAction.js\":\"d1d8da2958fc6f2e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/appendTag.js\":\"b1eee1448f69ce87\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/config.js\":\"4b8e25ad69205c37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/dataExtension.js\":\"59405133f03239f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/index.js\":\"58222a7e02ca443c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/propertyEditorOverride.js\":\"c3f7e88bc7f0f93b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbList.js\":\"3381735b2f59124f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"74808522ae20c0ad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a0f41e920c69bdcf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2d9ed64ceb4614eb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"53c627abcfe4d39d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/index.js\":\"d9d46c0141424cbb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9e60cd9fc0f0e9a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/CharacterCountItem.js\":\"9ecb4628473058b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3f394bb14a86c8f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/actions.js\":\"5a3ecc53e66415fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/blockType.js\":\"72655cad3c00bf91\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/charCount.js\":\"55dd52f6fac8d23f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/dataExtension.js\":\"79468a6c89daf734\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/index.js\":\"d709116d803d096d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/profiles.js\":\"e746d0c7806b375d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/properties.js\":\"f99f883e0c229e7d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/textCounts.js\":\"06ded461eff3002c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/colemak-keybindings/index.js\":\"d65613653573059e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/CommandPalette.js\":\"0fa6096784a6692a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/HeaderItem.js\":\"4b4802280dd19db4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/context.js\":\"84b80f7c8b27bdbe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/index.js\":\"5457ea7778d4888e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/selection.js\":\"f8bf784f574b2a91\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/toggleStore.js\":\"5933481b701bb8f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/useCommandPaletteActions.js\":\"2e3ca9e2c662197c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/ContributorBadges.js\":\"b04f2db11a14417c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/author.js\":\"0a09e49d48b1175d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/codeMirrorExtensions.js\":\"69f29d712f025f66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/dataExtension.js\":\"97172eb3bbd8ff07\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/index.js\":\"858cfcfa07ce9b80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/mentionAutocomplete.js\":\"9ebd121100ee88a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/processor.js\":\"0e7d86a49e382856\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/profiles.js\":\"101cbba2b2e41e17\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/queries.js\":\"421cc8e30b94d20a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/schema.js\":\"490fe604124a60cb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"0d0d109236d7185e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d26c8723e30307b5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/index.js\":\"d557d3fd71e94de0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"cf6b7687292c8ce0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7cacee8b930b58d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/CalendarGrid.js\":\"8616e6db0a7c05ce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DailyNotePicker.js\":\"b024dc8254cafdeb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"adac39683e83b346\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateNavDecorator.js\":\"ab2460f97c151bd6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateScrubOverlay.js\":\"7637a54661d3e6f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/HeaderItem.js\":\"4bc165e02beb045b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/ReschedulePicker.js\":\"13b37ffff4a8a034\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/SpreadDatesDialog.js\":\"657d4d0b0077ea7d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/actions.js\":\"28aba307538359bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/blockDateAdapter.js\":\"2bfcda2c6df9b7e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/calendar.js\":\"e23f825944d4cabe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dailyNotes.js\":\"2cbf223cc9e4c69f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dataExtension.js\":\"8cd742dabfb5b57a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubActions.js\":\"32d38c3c8e9b3226\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGesture.js\":\"135a8adb5d0db8cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d5b62da2f46adad5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubRecognizer.js\":\"af0319ea08f0dfd0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/deletionGuard.js\":\"662db7fa08cc4ffb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dueQuery.js\":\"e18d2d0385bd7f7c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/index.js\":\"c417c41aaa010a40\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/landing.js\":\"4c548793ebc467fe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/localSchema.js\":\"fb2e7ca4322bd07d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/referenceDateAdapter.js\":\"825d2da60e3c1d1f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/rescheduleAction.js\":\"e4ebf749bc294e53\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/schema.js\":\"e47d3cf06b87a1b0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadBlockDates.js\":\"4390721d1c7840de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadDatesAction.js\":\"b3db2a043f0f9bf3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/today.js\":\"bc5c9a1aedb1b77e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e7d8d4607b1f41c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"092f3427f13cd83c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/audit.js\":\"23405061975ab116\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditAction.js\":\"36024887f74e3d3b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditRanges.js\":\"a16c7fbaf4d2fe1e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/diagnosticsSource.js\":\"e0413acf0a046c22\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/divergenceScan.js\":\"97ebb88c7847bff4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/index.js\":\"f8031cdbbd5ea171\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/propertyChildrenChecks.js\":\"00a44886ab410ddd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/referencesMirror.js\":\"027cd2cb41b52afa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/rowJson.js\":\"c233cacfed64abe3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/schedule.js\":\"750038b0d2f3dd54\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/store.js\":\"0390bec920f08c81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/action.js\":\"f616bfeef566c20a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/index.js\":\"f48ce1428b2a0519\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/plugin.js\":\"fc65ca68a5c6a0fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ae74661d42f22208\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/actions.js\":\"240ae743ccec1e5e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/changeMarker.js\":\"2a1b9566a71b7f8d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/diagnostics.js\":\"8c7007cc39f5fb95\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/fileSystemAccess.js\":\"b4f5061d172bc1dc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/filenames.js\":\"7d07b3d509710b75\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/index.js\":\"039b41dbaab6019c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/mirror.js\":\"3476ca1e29affac0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runLock.js\":\"a2f5f7a3543687e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runtimeHealth.js\":\"94e9fb71598a5ce8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/schedule.js\":\"0d9bf0526ebb1b8e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/store.js\":\"c8b8c8fc5ca7a3f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/index.js\":\"fefbb124723c1497\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/themes.js\":\"858eafdd4aab0b65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/facet.js\":\"fa68c99ae719632a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/useDiagnostics.js\":\"864bd3291aa0513f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/dismissals.js\":\"2bef6d1f186d5f91\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/index.js\":\"7481019cedb20863\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/status.js\":\"d95c86e97836ceab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/store.js\":\"dbe42628e97dfed6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2e7152c3b0a48f65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bf38b48aa5871c2a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/actions.js\":\"16ce4cdfeede105a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/config.js\":\"e0b60c06a59b9451\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/dataExtension.js\":\"1620d4c2198d22f3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/effect.js\":\"bcab3afb7e1351a8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/index.js\":\"7d1036d0accb1d70\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bca40938bc505a7f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/useToggleTree.js\":\"041e330fbf6ca70a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/ExtractTypeDialog.js\":\"d8ef20968c816d33\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5c74188cc4bf6737\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/PropertyShapePicker.js\":\"29eec4259cf2555e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/action.js\":\"c40f8556fa5edcf1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/index.js\":\"f47411e05a5bdce3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/FindReplaceDialog.js\":\"a616ee291d240534\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/HeaderItem.js\":\"aebdf9cebf01f6b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/dataExtension.js\":\"122cd51b2eeecc5c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/index.js\":\"efe6726f54fa3ee2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/search.js\":\"2a756a1d4af150f2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/toggleStore.js\":\"64f4f934d466e39f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/LocationPropertyEditor.js\":\"1b90adbcb3ec9b43\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/MapView.js\":\"7c61b5067ec45fd0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/blockTypes.js\":\"435fa0523842c641\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/codeMirrorExtensions.js\":\"625795f089de9bad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/createOrFindPlace.js\":\"38b085180b742a92\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/currentLocation.js\":\"c2deb2570cc16509\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/dataExtension.js\":\"562fd80e32f0e328\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/geoContentDecorator.js\":\"188ea469bc77bc66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/googlePlacesClient.js\":\"3899b66170b9a576\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/index.js\":\"d11b12b02041c46e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/locationsPage.js\":\"ba8b1ca7d05ef232\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/mapViewport.js\":\"66d0cb774fa5bcbf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/pickCurrentLocation.js\":\"158b8819460ebd53\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeAutocomplete.js\":\"508e6285b82a8d71\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeNameCollision.js\":\"4b266a5d3d3b3239\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/properties.js\":\"b935a97eac7a4b3b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/propertyEditorOverrides.js\":\"6c49c9661348df80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/query.js\":\"74452d07b280ca60\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/usePlaceSearch.js\":\"45ef20bca74769c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2fca98e841dfac66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"49bf4e51765c7ebd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"51e078e07cc55491\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/config.js\":\"b0d9fd93e88eb236\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/dataExtension.js\":\"02b8c2beb9a3b8b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/facet.js\":\"be4972ab69298e83\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/grouping.js\":\"ba2bab209994959d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/index.js\":\"f1944c05a4aeeed5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a55e8537963944f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/query.js\":\"4eb2152314db5f15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/resolveConfig.js\":\"45e391720c7042a7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"898feb0bd0c8b71c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"dd148edc4b8b5250\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlDocumentContent.js\":\"3b1a34fb0b6a5e1d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlFrame.js\":\"a36d722ed0e7499f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/actions.js\":\"7c652aab99d8f4e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/blockType.js\":\"fb5b919b6869ad86\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/confirmRunScripts.js\":\"e9726aa6d323f676\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/dataExtension.js\":\"6b9aff19d7018df4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameAnnotations.js\":\"7c1012d08f5c16c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameDocument.js\":\"6f24fdf5cdf22ee7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameTheme.js\":\"0e62df50d3a4d46b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/index.js\":\"5ee1a06053e39950\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/scriptConsent.js\":\"fbe00f5a7e33a3fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/sourceMap.js\":\"95570c6030773ba3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/useDocumentScripts.js\":\"76f0243f9990eb0b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/index.js\":\"9ec73b7d52e50c85\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/record.js\":\"18c42c7c6d31078e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/recordStore.js\":\"873af3e4de7644f8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/responsiveness.js\":\"f091a5da3faeeb51\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/schedule.js\":\"a7479debec278ed8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/sessionContext.js\":\"c2ad4c59697abd58\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c6fa2ec32251e7e3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"eae6df0438ce2b6e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/actions.js\":\"40d8b83c5c30ba71\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/config.js\":\"b05319657fa4399a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/dataExtension.js\":\"1e0a3d4f96def0c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/effect.js\":\"72920c88cb0b470a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/index.js\":\"f604da8a2de92091\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/keyCapture.js\":\"ff8321168328d280\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/overrideStore.js\":\"e5ef18a3b307e550\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3ae3e6bb6878ca85\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/HeaderItem.js\":\"d60719ed8f7db2c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/LeftSidebar.js\":\"adc475d7a7b517ba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/actions.js\":\"152516c0997ec3ba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/facet.js\":\"c13e49d643782b37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/index.js\":\"bcb2eb18325cc5d6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/shortcuts.js\":\"3447d3088d9c3981\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/toggleStore.js\":\"06e7368428e304f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/MergePicker.js\":\"cf795d677e8dcbd6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/index.js\":\"071344678b0a4f0c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/mergeAction.js\":\"454c1026f82712a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/strategy.js\":\"ab4baa792395fdb2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/Button.js\":\"857f972d42139768\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b3301a7d1f3d30df\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/defaultItems.js\":\"c08885f00300a57a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/facet.js\":\"a362fdc0ab841673\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/index.js\":\"7da93f9dad0aa108\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cb9160af38410949\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/actions.js\":\"1c26a41df744a8e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e6c90f7c3c1a3165\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/facet.js\":\"296433beca6d64fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/index.js\":\"dd42a942196f9fc9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3560b9f655a250e2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b185daf35a6c8a40\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/contextMenuItem.js\":\"56d1eee2b72913fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/index.js\":\"b321a02545b58852\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveAction.js\":\"d738c87a30fb0283\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveBlocks.js\":\"cb21a9f0179a9647\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/selectionAfterMove.js\":\"82e41dc21b82282b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/TutorialBanner.js\":\"8bca7814a9bbbdcf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/action.js\":\"0da72bb46d302e56\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/bannerDismissal.js\":\"d7aadde1ac6dee1f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/documents/cheatSheet.js\":\"9092796c84d87eb6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/index.js\":\"b49184d27355fe66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/keys.js\":\"af44ca9b2ddca52f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/landing.js\":\"b188775c03e19dfa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/outline.js\":\"62235b21a581aa88\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/seed.js\":\"ac12db3353be6a1a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ab0cebc8cef0b6d8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/analyze.js\":\"24aed92a2e6991cc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/diagnosticsSource.js\":\"3d344314dfa46407\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/index.js\":\"c03707bcaf68b8ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/load.js\":\"6902d6597ee780d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/monitorRun.js\":\"9d8739eb49000e56\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/schedule.js\":\"97c5381566601909\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/series.js\":\"073a9d8b2535bd64\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/store.js\":\"a8a330080de9371e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/trendAction.js\":\"ac84e827419a0430\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/verdict.js\":\"9b524a024bd5aa80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/clickToEditAction.js\":\"37cdb03ac981b8e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/index.js\":\"c4432ad23eed88b7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/interactions.js\":\"8492dd53e592f628\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"52301ad508230391\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGate.js\":\"231b5346b937d52a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGateDialog.js\":\"6e800afe9d0f00ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/action.js\":\"a06ef3f4cf754f0d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/index.js\":\"c5e5f97cbee36047\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/localRunMessage.js\":\"cd41f42e6d75cc22\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/plugin.js\":\"34903d2e8a035aa2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/progressReport.js\":\"13b445c40dbb27c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/sweepProgress.js\":\"fe19a63bbd80162a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/FieldRowRenderer.js\":\"f0c35ee47ba36a01\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/ValueRowRenderer.js\":\"34d4728081635b9a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/actions.js\":\"f0ecb5734b6357af\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/autocomplete.js\":\"1337dca46578be3a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/fieldRow.js\":\"dc37f7d36bc0d350\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/index.js\":\"6a2bbdc0e9fc8a8b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/referenceWarning.js\":\"9fea4a29c2b0c2cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueAutocomplete.js\":\"0de98209ee94e11e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueSchema.js\":\"0ffb70bc6184f37f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/HeaderItem.js\":\"2daba46eb6da16f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/QuickFind.js\":\"ff4c257c3be1f5e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/index.js\":\"1104a8806ddb4e1c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/recents.js\":\"9a1431a60dd33eaa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/resultItems.js\":\"0b5933032a5e225a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/selection.js\":\"07f31ba3bf7ae88f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/toggleStore.js\":\"f776abb197e6683c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/HeaderItem.js\":\"28120572f83cc515\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f68d229e2969c30c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/grouping.js\":\"13e24c3824bc3ea5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/index.js\":\"6774f9a230195456\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/target.js\":\"30050f0bcec89c2c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/codeMirrorExtensions.js\":\"eaaaa84e68b3325e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/contentPrefill.js\":\"62f29f2a49685270\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/dataExtension.js\":\"08c8b0cd916c3aef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/index.js\":\"553263c4c7f4dde1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"6b25f26cafcb543d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/invalidation.js\":\"8083978680f701db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/localSchema.js\":\"dafb83b241e48299\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/index.js\":\"8ba1ae962fafeec5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b21dfc701495fcb9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/index.js\":\"0a9d1b136dfaa311\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/referenceNode.js\":\"f61bfea0073f5222\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e8819778bb483697\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f9fe367eb55af003\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/index.js\":\"509fb3bdb047299f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3a064878a2a33219\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"268521620cca05ba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/mergeRetargetProcessor.js\":\"c7002601dc912932\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/parseFence.js\":\"1a4c4eb9cfbc715d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceParser.js\":\"fff921c0ab46548c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceProjection.js\":\"55b4f0826800b7d6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referencesProcessor.js\":\"79ce1e655d60072a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/renameProcessor.js\":\"18028ad6b6dbfcb7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/spanReplacement.js\":\"503d7c9f8b333025\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/htmlToOutline.js\":\"7cfbd35b57fdfea3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/index.js\":\"b150d23d078543e5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/normalizeClipboardDom.js\":\"4c248f2fb51db84f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/pasteDecision.js\":\"ae8768442bd613cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/action.js\":\"170900f2e73ee5ce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/blockIds.js\":\"80c4e6cbc4d94019\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/content.js\":\"858b8832003b8368\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/effect.js\":\"647e6d21eab6e886\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/ids.js\":\"78f7acbc44ae70c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/import.js\":\"9ba0e98789492df6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/index.js\":\"18a6b3f568ead533\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plan.js\":\"4cb20850a290d6e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plugin.js\":\"501616b3d32acc76\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/promotion.js\":\"b35159b819e021b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/properties.js\":\"a6efc4268496c402\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/references.js\":\"62c5d1be37340189\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/report.js\":\"e42a8190f20afa97\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/roamMemo.js\":\"515e8cd8fdf02759\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/runtime.js\":\"596bf7103bd9ca99\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/schemaReconciliation.js\":\"88a1cb3918e21d01\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/srsMarkers.js\":\"43bd18d78578d176\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/todo.js\":\"039082bea9fa3335\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/typeCandidates.js\":\"ae74197f38862c6e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/types.js\":\"b6aa261994489d02\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/index.js\":\"1f2f3ab6ed45fce9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/store.js\":\"977bf64a8585c115\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/HeaderItem.js\":\"cc9c46aaf6f33a74\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"aa4db90ab3988816\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/index.js\":\"8f92f7668294e0de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/model.js\":\"0183af317c897071\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/toggleStore.js\":\"ce9207b038af7278\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/useKeyInspector.js\":\"44ac92d13464e311\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"42d03950bc7e0904\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/ShellDecorator.js\":\"7d62334ed2ebce91\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/actions.js\":\"d34d36aca3605b6d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d3edd44f605ee6b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/index.js\":\"d8fa4984746db0fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/shell.js\":\"345645f564ac196c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/surface.js\":\"ad1c737168f6a12a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/walker.js\":\"d0c5f584f9bda3b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/RescheduleToast.js\":\"964a245855137efa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/dataExtension.js\":\"18939011760b8a4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/index.js\":\"6758031527dde89a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/indicator.js\":\"4bf2dbe844a67be5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/moveSrsState.js\":\"876e2563ca0fc3c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7532eff39b665240\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/scheduler.js\":\"d834dc57e7bbb4ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/schema.js\":\"1e798e987ef14c67\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a0b11cdd72d7be0f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsClipboard.js\":\"69393b6c1165cb3b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"697c4308500d5d7f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DailyNoteReviewHint.js\":\"deb877665a3266b0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DeckPicker.js\":\"eee420de91e4d835\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewControls.js\":\"34d2a6e57bcb7b55\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9af295badc34f2ef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewSession.js\":\"832b7134db0dce75\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/actions.js\":\"4b8cc61587c7269b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/archive.js\":\"7ffb6250eaaa32e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dataExtension.js\":\"237d78dddaf15e91\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/deck.js\":\"8b0b07595b5d53f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dueQuery.js\":\"31704b96d36f4c1b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/gradeDecision.js\":\"30de8cc9636785ae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/index.js\":\"f975c189e98d10a0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/keyHints.js\":\"2f3f20f883affcd3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewCardLayout.js\":\"45c249c80c05e883\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewProgress.js\":\"7cbf07d56a63138b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/schema.js\":\"700c45f83d291b32\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/useDueCards.js\":\"9b2eacdbf02d67ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/index.js\":\"5e3989b5e8c2f979\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/record.js\":\"0526b2b61f472832\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/index.js\":\"5aa74f204a0c3e4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/persistenceStatus.js\":\"c8327c4787e4bea2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/requestAction.js\":\"e257b76609e6cf50\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/TypeChipsDecorator.js\":\"d1e67209c116263b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/codeMirrorExtensions.js\":\"6a70cfaf7981fa7c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/index.js\":\"f056666d331dccd1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/typeAutocomplete.js\":\"1c9b045877e89e90\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"01b12aeae2a56b47\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/actions.js\":\"6ea4158a0e8a63fb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/anchor.js\":\"c3ff1df161884246\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/events.js\":\"d4002f2d575c2af1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/gestureActions.js\":\"fdcbc4dd6010cfe6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/index.js\":\"86cdcbbe04705766\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"edf2beca02041678\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/collect.js\":\"8e3a3e4bd6229577\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/index.js\":\"9bc975fb9b8c895e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/record.js\":\"bbc0e5c5294d727b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/RejectionDialog.js\":\"d2811f6de92a7b94\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e7ebc93c0db6e6d1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/index.js\":\"eb48be09749129f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/model.js\":\"38342eea088cb47b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/queueCounts.js\":\"f63b61871b0f359d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rejectedHelpers.js\":\"8172b6727be7cc60\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rematerializeAction.js\":\"48e89fdb516b8cf1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/useHysteresis.js\":\"a16d0e82d2bfea72\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/ColumnHeaders.js\":\"7c5d2aae20492239\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/QueryUi.js\":\"b5975bb7a41bed03\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/TableLayout.js\":\"0df11a3bcd0e8947\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/actions.js\":\"b44a24b13392151e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/cellEdits.js\":\"5487a7fbb4a4aca1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/columns.js\":\"ec43eadd894e00ae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/controller.js\":\"8df02ebd7cbc0e1a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/convert.js\":\"7de01bf2f9a5104b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/dataExtension.js\":\"434de41df0adc272\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/index.js\":\"34f7ca696330e662\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/keys.js\":\"e0ab786006f4e253\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/model.js\":\"cb650949ed2890a5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/backfill.js\":\"9dc2d13b8f36fa4c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/completion.js\":\"512ddeaabdd7ea75\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/format.js\":\"d8701bcb1bb1d2de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/parse.js\":\"a2a9f11fb83332fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/queryValue.js\":\"ba5668ac6be1d750\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/source.js\":\"0bece675bc30e383\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/registry.js\":\"88c7a060edad526c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/schema.js\":\"ca241baf3f2d8f4f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/sort.js\":\"689a116cff5ba860\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/effect.js\":\"5a2ea099acf2598c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/index.js\":\"9edaffe0505b54b3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/theme.js\":\"cbc1aa93ee573d42\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/actions.js\":\"b3ededa3726a5535\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/dataExtension.js\":\"7545930f419cda52\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/index.js\":\"c40bec9e06aa522b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/schema.js\":\"622ba5053bda93ee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0902199a8ae91deb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/actions.js\":\"973159c02338f8b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/defaultItems.js\":\"4ec49cd86890afa9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/facet.js\":\"29c12d143490a4ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/holdRecognizer.js\":\"c89de2ee67b71e5c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/index.js\":\"6aa172b8e97e0109\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/UpdateIndicator.js\":\"7e1d156d39e46bcf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/index.js\":\"a5bac028fa9e6206\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/loadTimes.js\":\"a9837b63d9f00b05\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoNotesRenderer.js\":\"46c6607a22dc93b7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoPlayerRenderer.js\":\"ac2d28b4ac02761e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoTimeStamp.js\":\"6485a0c1744a5111\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/actions.js\":\"8882ed218c15f0bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/index.js\":\"e7a9b66be4118529\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/markdown.js\":\"a19d2b04d6ad4f9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/notes.js\":\"4c6cb274697ee2e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/registry.js\":\"5ea0ed071e511e0c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/remark-timestamps.js\":\"8b9cef3d8054ab5d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/view.js\":\"d0c8b3d44b3b36b1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/LinkHints.js\":\"70ddb9d0456d51db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/index.js\":\"b6121183ad72c42a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/model.js\":\"35aaa265d786908b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/settings.js\":\"fd0326837f8d59ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/actions.js\":\"31afbd83bd0cd9d8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/index.js\":\"97258f806b75b88c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/interactions.js\":\"8776d4a6ca22852a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/workspace-header/index.js\":\"27b2724ffe870896\",\"/knowledge-medium/pr-preview/pr-1843/src/registerServiceWorker.js\":\"df692f4465aa29f8\",\"/knowledge-medium/pr-preview/pr-1843/src/requestPersistentStorage.js\":\"884c5edd9857f6eb\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authRequestDeadline.js\":\"aeb52af32ae0a927\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authStorage.js\":\"72e4b43635d434df\",\"/knowledge-medium/pr-preview/pr-1843/src/services/powersync.js\":\"642c8413eb619bf4\",\"/knowledge-medium/pr-preview/pr-1843/src/services/supabase.js\":\"d8dc127fae739c34\",\"/knowledge-medium/pr-preview/pr-1843/src/services/uploadErrorClassifier.js\":\"84637224094a42f1\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/ActiveContexts.js\":\"094654a2fc94d196\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/HotkeyReconciler.js\":\"90a076ffcd5d8fd1\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/WipeLocalDataDialog.js\":\"a5c314b395d09751\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionDispatch.js\":\"1b67b59721a6afd0\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionRefItems.js\":\"80b1793b710606a4\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/applyKeybindingOverrides.js\":\"4fcf405c5511b39c\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/blockActions.js\":\"d24972db6b2fbc83\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/canonicalizeChord.js\":\"5d9cd04e6fcda12f\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultContexts.js\":\"4d623bb159703bf6\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultShortcuts.js\":\"c74575b65ef8e195\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/effectiveActions.js\":\"c93b50b9aca7efbd\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureAction.js\":\"96be6823b6a436b6\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureBinding.js\":\"63c7844fe8153fb8\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/holdRegistry.js\":\"f106e13d131cb29e\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingConflicts.js\":\"b02bac2fa06b725c\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingOverrides.js\":\"a45322cc87bf3fee\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/pointerAction.js\":\"03bc91f60547531e\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/resolve.js\":\"196c622e0ab75114\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/runAction.js\":\"4e52fa08420fa4e5\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/sequenceMatcher.js\":\"6d37dcb9d9b500f4\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/types.js\":\"7578f360e67f9498\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionContext.js\":\"8c168ed593edd783\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionDiscovery.js\":\"abd1a00eb2a802e6\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/utils.js\":\"19f56c0d94f3c612\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/bootStore.js\":\"21857f85c6812c2e\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/previewDatabases.js\":\"552b8a90a71e9763\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/byteTransform.js\":\"004df7cae568f596\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/attachmentCleaner.js\":\"db4ae0780926160f\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/attachmentParts.js\":\"75ca4bb0d51bffc2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleParts.js\":\"fc0822e60a2eca31\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleRecord.js\":\"8bf74d67f3275480\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/manifest.js\":\"471a143313d5616c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/takeBundle.js\":\"f2143f5ea42ca704\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/verifyBundle.js\":\"63db13168592090b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/cleaningStage.js\":\"57bf1591389e60bf\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionKey.js\":\"d7767dbc2107420b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionServer.js\":\"c91bdb9eccada482\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flip.js\":\"960718b975240845\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flipAttempts.js\":\"e49228de1cf2c859\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/pages.js\":\"95174f9ee867b315\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/preflight.js\":\"7cfe29827af7aace\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/reseal.js\":\"822b6b0d31d61e9c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runConversion.js\":\"e57593c3cac4bc95\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runLock.js\":\"9bb66990d0b44912\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealing.js\":\"5ce48f6bfccb0863\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealingStage.js\":\"61839bffeb3d6a2e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/stage.js\":\"c446f695b9ffb001\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/verifyReseal.js\":\"c02e236b2a890b6b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aad.js\":\"020dd6edf2a1b376\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aead.js\":\"ec48230d2b3d3c04\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base32.js\":\"5fa47a69db9b4969\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base64url.js\":\"51578e24deb4f299\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/binaryEnvelope.js\":\"983a698ecdca7f13\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/byteAead.js\":\"9dc0f547f7726116\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/canary.js\":\"822915949690db5c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentHash.js\":\"08836b3c3880cf4a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentKey.js\":\"ecd91ccb99e64bd4\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/derivedIdNamespace.js\":\"23d524567bf96d86\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/envelope.js\":\"644cc5873d77bff2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/hex.js\":\"dd5ffa4d5d52e375\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/sha256Hex.js\":\"a707470eeaa019f2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/workspaceKey.js\":\"60c9b6bafca1f833\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/conversionState.js\":\"8944f93eb8a3d2ba\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/createEncryptedWorkspace.js\":\"db50be7762bf4456\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/pastedKey.js\":\"c3d8e0231bfa82ca\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"84b3b192d4e5ad58\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b24f03321412866a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/keyStore.js\":\"f8f943b71dba24cb\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/mintWorkspaceKey.js\":\"df413b54d2f9cf22\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/modePin.js\":\"c4950a756a50e6c7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/openWorkspaceKeys.js\":\"564c8e9dd5ba8c52\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolveWorkspaceEntry.js\":\"70850c90a8799216\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolver.js\":\"b7c05612e16ad1bd\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/workspaceAccess.js\":\"e50530c3e2c72d16\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/transform.js\":\"1f8aba39d2b28856\",\"/knowledge-medium/pr-preview/pr-1843/src/themeBootDefaults.js\":\"fa4f32b7d2b64c69\",\"/knowledge-medium/pr-preview/pr-1843/src/types.js\":\"4b3fe04639ce3c7a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/ClientLocalSettings.js\":\"670db720d8ae2f6f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/abortableSleep.js\":\"3b2a008b81446fc8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/array.js\":\"6669023591fd6c82\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/backlinkAutocomplete.js\":\"a24243b3f1ca403f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockCrumbs.js\":\"804cad1ba5d94607\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockrefAutocomplete.js\":\"a5a2ce171cec2f7f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/cadencedIdleJob.js\":\"faa7f6c6b424b628\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/callbackSet.js\":\"b9428edf986867a8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/clientId.js\":\"6bb3340837af3df8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirror.js\":\"1f1f79f417070c6b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirrorCompletion.js\":\"55f3a62b46496269\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/copy.js\":\"d8d8f8258484c008\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dailyPage.js\":\"df28b372fb8b3c3c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensics.js\":\"a56914340aedaf56\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensicsHooks.js\":\"0d24432415d14fcf\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/deleteBlockThroughUi.js\":\"915f6cee4fd78a4f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dialogs.js\":\"119a9542bf7ef733\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dom.js\":\"61860860daabf773\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/downloadBlob.js\":\"959c5ae3ad4eb857\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/exportSqliteDb.js\":\"ac353b32756087e1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fileSystemAccess.js\":\"24280b5b084b7763\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/flipSlide.js\":\"122c005332b622c4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fnv1a.js\":\"57e6015e2e480a6a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/formatBytes.js\":\"85135f2997131767\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fuzzyRank.js\":\"2b08d22ebb38faca\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idbKeyedStore.js\":\"c98e1bbe8caca91a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idleCallbackPolyfill.js\":\"e69c511fa73e4337\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardAwareScroll.js\":\"0c5f2076a8f948f8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardViewport.js\":\"7cf11c7ea699d6e3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/lastWorkspace.js\":\"87696bbf1ef7e75d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutColumns.js\":\"a9bedc6b7e270329\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionDom.js\":\"a91932ac83784fef\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionId.js\":\"320cd1d7a524615e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkClickGestures.js\":\"edd3e6a554d1b8f2\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkTargetAutocomplete.js\":\"e4f2cb72adf38d8d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbCorruption.js\":\"97d54452e5f97a5c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbRecovery.js\":\"ec2bf31dc64809ad\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/markdownParser.js\":\"066ef495b0f39f78\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/memoize.js\":\"4904ad02203ce8d6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameFieldCommit.js\":\"69a9c31e86359f0a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameList.js\":\"1f115f1675e9778d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/navigation.js\":\"f1d53b115bf8a0c9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/omnilinerNamespace.js\":\"80b8e691d1395f4f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/opfsPageScan.js\":\"bb3bc51822ec8c2f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelClearance.js\":\"c282c5ec13542ad6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelHistory.js\":\"0cbde1e904f26b2d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLanes.js\":\"3e6a347658eda702\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLayoutProjection.js\":\"7a6b58ca679dda47\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelScrollAnchor.js\":\"f4b27774eec2676b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelUrlFlags.js\":\"5fa8180df8a3acef\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/platform.js\":\"40a044e4d110c38b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/pluralize.js\":\"02c125fc62525d4e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyCreation.js\":\"55ea6233384eecf9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyNavigation.js\":\"1b3d445277c97db5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyValueContext.js\":\"a3038635df203517\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/react.js\":\"0a955a4696dcbd7b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeDate.js\":\"d73d1668817e10d5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeTime.js\":\"05c3822905a7c83a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/renderScope.js\":\"42a823437ccfa108\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/resolvedThenable.js\":\"2dc7d6c3a87d6554\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/routing.js\":\"22e69df0000e1089\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/safeMode.js\":\"e3c9856c6b9a8849\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/scheduleIdle.js\":\"3b932e5e363aa5e5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/screenWakeLock.js\":\"e4ce7414d18bc23f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/selection.js\":\"2da33dcf194e85cd\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/softKeyboardGrab.js\":\"7d151022c5a61055\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/startupTimeline.js\":\"dc5b0f193d0d21ae\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/state.js\":\"8450b9b8846b7e25\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/string.js\":\"a1002e59d022f0d7\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/surfaceZoom.js\":\"0cd1276590fa6956\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/time.js\":\"8bbd3356d6ebf597\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toast.js\":\"e6058af4f4cc6fa1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toggleStore.js\":\"c5739d253a9056a4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/untilStopped.js\":\"b6cc7e3aa5bd2577\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/userActivity.js\":\"74bf4c9a393ed6d5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewTransition.js\":\"60fa5a424c4a407b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewport.js\":\"c3051b748b8dd295\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/webLock.js\":\"296375f6419f1ad5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceRecovery.js\":\"3ea47c34782652ba\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceSnapshotStore.js\":\"c454a5e3f84157d3\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-compiler-runtime.js\":\"be11d0b053083e30\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-client.js\":\"e6c1fc437affc136\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server-edge.js\":\"799f7567c390b0a0\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server.js\":\"8cfec801559d191c\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static-edge.js\":\"79ff1861b5f70327\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static.js\":\"6f5a3c674f365c8b\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-test-utils.js\":\"200714e1cb518b75\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom.js\":\"b055b69e968f7087\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-runtime.js\":\"eaf6faaa13ea580b\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react.js\":\"afb0372f5e9c0efd\",\"/knowledge-medium/pr-preview/pr-1843/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
