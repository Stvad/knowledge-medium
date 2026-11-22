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
		buildId: "92d5c04d715b-bef26785",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/\":\"b5f3e47060b50b9c\",\"/knowledge-medium/pr-preview/pr-1843/index.html\":\"b5f3e47060b50b9c\",\"/knowledge-medium/pr-preview/pr-1843/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1843/assets/FacadeVFS-ofj0i22q.js\":\"a6e1f28e5361feec\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSCoopSyncVFS-BhrlvFWA.js\":\"8fc25c534ea5c990\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSWriteAheadVFS-DS0_FyaA.js\":\"16e103b17d91d23e\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CRCguSI5.js\":\"aa6dbe9e5bc6a3b3\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-GLERWaka.js\":\"cf98e2fdd0d1dbaf\",\"/knowledge-medium/pr-preview/pr-1843/assets/worker-B9r2ZG4t.js\":\"4f9964d75f43f9e6\",\"/knowledge-medium/pr-preview/pr-1843/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1843/chunks/app-xiHdS4ro.js\":\"b13cc5fadcd9ff38\",\"/knowledge-medium/pr-preview/pr-1843/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1843/index.js\":\"00573a30d824b9a7\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1843/assets/AccessHandlePoolVFS-BrHqH0LF.js\":\"3dd3b425d7f584f3\",\"/knowledge-medium/pr-preview/pr-1843/assets/IDBBatchAtomicVFS-DisVqdIZ.js\":\"715765c3a8a2d1d6\",\"/knowledge-medium/pr-preview/pr-1843/assets/MemoryVFS-CT4RX-8V.js\":\"4f9a7b62a7277c63\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-BUt3sh4X.js\":\"b01cc87057ea9771\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-BhT5GCaC.js\":\"f0ae8daa6730efe3\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1843/chunks/AccessHandlePoolVFS-Bya9pOMn.js\":\"c217f92836da06f9\",\"/knowledge-medium/pr-preview/pr-1843/chunks/FacadeVFS-CRUPvJaD.js\":\"76040f7eedf269ec\",\"/knowledge-medium/pr-preview/pr-1843/chunks/IDBBatchAtomicVFS-CeYdm813.js\":\"2f73291706dd3d37\",\"/knowledge-medium/pr-preview/pr-1843/chunks/MemoryVFS-CFE6zVA1.js\":\"5a2b78266da37c07\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSCoopSyncVFS-DNhJS8XR.js\":\"e501f3bd0cf90bbf\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSWriteAheadVFS-BdpgMmlB.js\":\"b49a7fbc915812ab\",\"/knowledge-medium/pr-preview/pr-1843/chunks/Preview-Dj_GFNXA.js\":\"314a0cac86942536\",\"/knowledge-medium/pr-preview/pr-1843/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/card-Bgzrwq1B.js\":\"0fb85eead8aad704\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-e9V4Gj7R.js\":\"bd895b701c036763\",\"/knowledge-medium/pr-preview/pr-1843/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-B9TJN1tb.js\":\"25c78e2fa0e0eb26\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-async-BT0UTX_Y.js\":\"ed020206259b34be\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-2eT3J7-T.js\":\"897f227c1291881e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-BCSUGpcR.js\":\"913eb35661bbf222\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-Bk8Cd0AT.js\":\"50ce2cf7d92b3b38\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-BvncXIMj.js\":\"88c04f48c4d7bacb\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-D3veeIKJ.js\":\"3dad53d7787e7581\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-DRzIqm2G.js\":\"b5f9d17fc752b444\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server-legacy.browser.production-BSSYYk3W.js\":\"7797fce5d3785d18\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.browser.production-CRPy3D58.js\":\"9d8c55a3c3762b92\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.edge.production-BAozyILM.js\":\"5b406af59afedf31\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-k1XdCgBB.js\":\"912c055089af6e65\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-mMMPvLqU.js\":\"b0f480a2d6d334cd\",\"/knowledge-medium/pr-preview/pr-1843/chunks/server.browser-CWQALXFU.js\":\"9f4e4d65ff5b3b31\",\"/knowledge-medium/pr-preview/pr-1843/chunks/textarea-LrNIV42a.js\":\"77bc6230d1dd5f58\",\"/knowledge-medium/pr-preview/pr-1843/chunks/ui-BkUCkk7l.js\":\"e0a1dce18262792a\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-async-DnYoTG4E.js\":\"117a0af3381be428\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-smHdvteP.js\":\"915b850638bb69de\",\"/knowledge-medium/pr-preview/pr-1843/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1843/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/src/App.js\":\"24a193c2f6343672\",\"/knowledge-medium/pr-preview/pr-1843/src/appUpdate.js\":\"fb41325507a9fe4c\",\"/knowledge-medium/pr-preview/pr-1843/src/appVersion.js\":\"7ce7af1d9eef54ea\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/initialLayout.js\":\"d53929d33110902f\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/openWorkspaceData.js\":\"99d4f5b4e428a71f\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/resolveWorkspace.js\":\"66e7a73aa053e50e\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/workspaceBootstrap.js\":\"9acc357807ef79b9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockComponent.js\":\"a801d297c2543c74\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockCrumbs.js\":\"a216a773b9a9911b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockEditor.js\":\"878ce2488c3a91c6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockLoadingPlaceholder.js\":\"2b133be4fe340fb2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockProperties.js\":\"f456db034fcc1b8d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockSearchPicker.js\":\"32969f8f83661202\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ConfirmBulkDeleteDialog.js\":\"351c66b66dc2ee2c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DividerHandle.js\":\"db11b06902ac4de5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DraftEditor.js\":\"54d51dfccdd92452\",\"/knowledge-medium/pr-preview/pr-1843/src/components/GutterPill.js\":\"d7d88fe3d05e88fb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Header.js\":\"e1df04b5253b122a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/LazyBlockComponent.js\":\"1ab0d5a9dff16c2c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Login.js\":\"47ab5191a32f8e3d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ZoomableSurface.js\":\"7ff18a74a7949442\",\"/knowledge-medium/pr-preview/pr-1843/src/components/editModeKeepalive.js\":\"4daa8fb32ae80d21\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyDisplay/PropertyDisplayScope.js\":\"50d86a25af772732\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1b909c4e5effa031\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefPropertyEditor.js\":\"00f3215ea053b552\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefTargetTypePicker.js\":\"16e537d64b789970\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/SelectPropertyEditor.js\":\"c242f152c7e845af\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/TypesPropertyEditor.js\":\"accbe12169068241\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/defaults.js\":\"51240987b1c32078\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/kernelValuePresets.js\":\"3dd575f88e9a5e3f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/selectablePresets.js\":\"9143c2bba86cfd24\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/typesPropertyUi.js\":\"c52a4b8e816ed1f8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/AddPropertyForm.js\":\"5ac7fc5e67e264ca\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyPicker.js\":\"c04c737f9526b688\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyRow.js\":\"1ed6671fc2e0c4f4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/Rows.js\":\"d40b13c40ca8560f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/actions.js\":\"60a32273f95cbaf8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/declarationOnly.js\":\"52492d721c64e2fc\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/layout.js\":\"85787a6677c66952\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/model.js\":\"0905132151ffeb3e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapeUi.js\":\"807ec8438ca89656\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapes.js\":\"461bd09cb69ed27e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/usePropertyEditingActivation.js\":\"914f1181febc7453\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/visibility.js\":\"3d161cf9b3508eec\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanelSections.js\":\"3c9dd004bf30103d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockEmbed.js\":\"ead35eb731710897\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockLink.js\":\"230dbd9f909f6400\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockRef.js\":\"042fda7cd191e530\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/ReferenceLink.js\":\"8ad55749e88395a5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuard.js\":\"bdb7a43a826536c4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuardContext.js\":\"e4af6bb6d2e264b9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/linkInteraction.js\":\"b8837ddb12752099\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/referenceLayout.js\":\"a448314a42dd4de2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/useBlockRefAncestors.js\":\"94d9cad6b80ef545\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockGutter.js\":\"759db23a43fc25a8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockInfoDialog.js\":\"699c7aa3856c539b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockTypeBlockRenderer.js\":\"03c8b8341795bcfd\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BulletHoverCard.js\":\"f95ea27b2f6a810c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorContentRenderer.js\":\"07adba17ec2152ad\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"84250da4da1b987d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ColumnResizeHandles.js\":\"40a11afbf3cb272e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"be2836f7b9cf1fa6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/DefaultBlockRenderer.js\":\"6261f23b10d0494f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/LayoutRenderer.js\":\"6c90aa845585bf5b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MarkdownContentRenderer.js\":\"2ec24fcf40559e50\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MissingDataRenderer.js\":\"55f1732eb2e7c232\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PanelRenderer.js\":\"1b7f9b8163685208\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a799504ed4cb3c96\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/TopLevelRenderer.js\":\"1a9107523bcd52df\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockGutterMode.js\":\"50b1bc6a8a164abc\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockTitleText.js\":\"36bbc2f16c5a69d3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/fieldCreationKeydown.js\":\"a1401094f13cefbd\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/layoutRootContext.js\":\"831f9c994503e165\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/TypeChip.js\":\"6c90f3fc5c5626c1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/chipStyle.js\":\"2e6d992780346297\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/anchored-floating.js\":\"bc0bf82ad9b0c8eb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/button.js\":\"7cded6383ec87e7b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/card.js\":\"5be8fc6550faa12e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/checkbox.js\":\"434df1487603959b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/collapsible.js\":\"3b6177e659d96d7e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/command.js\":\"2e0b55483106298a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/context-menu.js\":\"3f46494ca0bb16b3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dialog.js\":\"fa8267bd8c102966\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dropdown-menu.js\":\"c1b99f5446d589cd\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/floating-listbox.js\":\"f5f1bdea9b06879a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/index.js\":\"3c42eee81dc24db8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/input.js\":\"9208c263e99dc73b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/kbd.js\":\"960c120a4f64f4b7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/label.js\":\"c4a1878fe0aaae69\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/textarea.js\":\"088373bbf1e78e74\",\"/knowledge-medium/pr-preview/pr-1843/src/components/useEditModeYieldKeepalive.js\":\"73af6b5ad62447ff\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/BootFallback.js\":\"ea8bf83741096781\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/FocusedRowLazyMount.js\":\"2c1b9e7b7d780e54\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LazyViewportMount.js\":\"f037339bc799abf0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LocalDbCorruptionFallback.js\":\"5ebe9c5edc2ab5ea\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/error.js\":\"29af17158a9d223a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/lazyMountRegistry.js\":\"2f8c3614155cc0aa\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/suspense.js\":\"4b55c0b982013e28\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/CreateWorkspaceDialog.js\":\"f17d0767fc730bc0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/PendingInvitations.js\":\"39d68af557eb6684\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/SyncProgress.js\":\"583a37df54c43481\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/UnlockProgress.js\":\"761a788076869618\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceKeyGate.js\":\"0eddd9af7c133b7d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSettingsDialog.js\":\"95a8e609c1d27b17\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSwitcher.js\":\"070e74172d037384\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSyncGate.js\":\"a59b6df52b2470b1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlow.js\":\"56d50c21225b8a45\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlowHost.js\":\"7c5d63b5683d76e2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/EncryptionSection.js\":\"dd7770d89e4c39c0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/attachmentPrompts.js\":\"d7f814873d245c76\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0e449611e616f603\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowDeps.js\":\"431318227288ba35\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowStore.js\":\"f77b498d827257b8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/flowUi.js\":\"cbfafdcb5bd40829\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/useConversionRun.js\":\"84541a840c61bc3a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/keyUi.js\":\"9307a61c00483705\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnKeyLoss.js\":\"86d700561ea834e9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnServerE2ee.js\":\"3bef392ed22508ff\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/workspaceUnlocked.js\":\"c1f510f087ff79e0\",\"/knowledge-medium/pr-preview/pr-1843/src/context/backgroundSubtree.js\":\"3b83d63ef745bb2e\",\"/knowledge-medium/pr-preview/pr-1843/src/context/block.js\":\"8d28a292e39b77be\",\"/knowledge-medium/pr-preview/pr-1843/src/context/layoutWsContext.js\":\"0150437eec628b7d\",\"/knowledge-medium/pr-preview/pr-1843/src/context/propertyDisplay.js\":\"79250c1d84678633\",\"/knowledge-medium/pr-preview/pr-1843/src/context/repo.js\":\"bff0f4b0f67dbba4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasClaim.js\":\"2ceafdfce2f08e1d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasSeatNamespace.js\":\"2d82dcf02c1eadcd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockData.js\":\"5ec924df364282c8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockType.js\":\"159f38e6a8b090a6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/changeScope.js\":\"8d8544d3c7d0c827\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/codecs.js\":\"5afd00f1d6966d37\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/derivedData.js\":\"90e1f0f6421c2013\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/errors.js\":\"f6fca42ee9411482\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/events.js\":\"7a79f3b72418bef3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/handle.js\":\"a4b4941a532ba979\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/index.js\":\"5aa98cc104fb60d8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/mutator.js\":\"79b8c57bb5654d15\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/processor.js\":\"4c257069be4beb24\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/propertySchema.js\":\"c810d00a2ef7dc48\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/query.js\":\"bd0f119fcb1c7888\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/sameTxProcessor.js\":\"cd9b70043b4cf4e0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/schema.js\":\"a4b4941a532ba979\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/tx.js\":\"a4b4941a532ba979\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/typedBlockQuery.js\":\"d1b87f747192a799\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/user.js\":\"2e56cb1a8cbf6354\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresetCore.js\":\"8c806a8e1755f1d3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresets.js\":\"7bf8bbd2d1361cd1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/attachmentCleanerIOVerb.js\":\"7172d57881546eea\",\"/knowledge-medium/pr-preview/pr-1843/src/data/block.js\":\"1af84c5f7a180e03\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockCache.js\":\"8d94f5462aa8e213\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockId.js\":\"1ef21005a6f0f4aa\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockLiveness.js\":\"f11976ffa00be750\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockMerge.js\":\"4a2c65092c017877\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockSchema.js\":\"ec53f22c609afe58\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypeLookup.js\":\"ead50839a1bf7a74\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypes.js\":\"48eeebcafd6ee083\",\"/knowledge-medium/pr-preview/pr-1843/src/data/clientContext.js\":\"5889bd39debaa9e7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/dbFileSiblings.js\":\"a980e3d1d579c567\",\"/knowledge-medium/pr-preview/pr-1843/src/data/definitionSeeds.js\":\"c95cc6b5878d65d2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/derivedIds.js\":\"e444a6020934f66a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/drawnSubtree.js\":\"6e25f3e64749ccd2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facetBridge.js\":\"de1bdd7e0a98ae10\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facets.js\":\"cb851af4900ace39\",\"/knowledge-medium/pr-preview/pr-1843/src/data/globalState.js\":\"e32e72579ae813f6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/aliasClaimRederiveProcessor.js\":\"0efef2380ae1080d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/ancestorBatch.js\":\"e3147939689618d5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/blockTypeTypeifyProcessor.js\":\"fc6eef72c6f9ac3c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/clientSchema.js\":\"f12ddfde1a26b8dd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/commitPipeline.js\":\"5afb9e4d7719cbde\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/devAssertions.js\":\"7b5fa8ebf6549315\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/firstSync.js\":\"396b9ae0396c57f2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/freshInitialLoad.js\":\"5ea445c49c079030\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/graphBackfillClaim.js\":\"63ac1375f55574b9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/handleStore.js\":\"3fbac847013ffd7d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/idleMarkerJobs.js\":\"7890de55e7f70700\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initialDownload.js\":\"a27bbd5e4f26b483\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initializeClientDatabase.js\":\"2efa4d60bcb9d597\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/jsonCanonical.js\":\"5bf6cd2249c915e0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelInvalidation.js\":\"aa34e9d8a7e2035d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelProcessors.js\":\"32add20bc66100b7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelQueries.js\":\"d5ee42e110434b7f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/mergeTypeMembershipProcessor.js\":\"52352f6b71023a7a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/normalizeReferencesProcessor.js\":\"1c68494e52c0ce42\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/poolInstrumentation.js\":\"16b0b3999e84127c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/processorRunner.js\":\"c52129e2d1e79cf6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyCellBackfill.js\":\"04d34f75d6f27c84\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildMint.js\":\"82a469a441fb4360\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildrenProcessor.js\":\"9d351a778b903734\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionChangeProcessor.js\":\"61655b36df5e8aae\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionSynthesis.js\":\"780d4be1192c1c21\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyKeyScan.js\":\"ea1228a43f1a7edf\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertySchemaResolution.js\":\"3a28173384d95dab\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyValueEdits.js\":\"2939710b2d800391\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/raiseProtocol.js\":\"12ab193f37c7d925\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/readBatch.js\":\"d13610ff629a3826\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/refProjection.js\":\"dd890ca2746c8610\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetLookups.js\":\"c3810d94ab1d043b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetProcessor.js\":\"40aa9c44277f3ad6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/replayMerge.js\":\"92d9736e25f4a3f5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/sqlBinds.js\":\"987fc9ea4b3732c3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"55df2ea937dfdf43\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/arrivalProcessors.js\":\"7d24d818c9e3cca0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/invalidate.js\":\"ce775dc5949a78b1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/materialize.js\":\"f016d628d7e32192\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/observer.js\":\"f5e39999bb253f01\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/reconcile.js\":\"fad4cb2af3711761\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/timingMetrics.js\":\"e50ea8d1286dc2c3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/treeQueries.js\":\"ce757294280236c7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txEngine.js\":\"c1dfc51af728e1e3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txSnapshots.js\":\"b299c1540327ba41\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/typedBlockQuery.js\":\"d9e65e7fc44eeb9a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/undoManager.js\":\"772459549fef027b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/invalidation.js\":\"58a76dcf3df80d9e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelDataExtension.js\":\"ac3b64506755376b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelPage.js\":\"6011dd8f7e93caad\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelValuePresetCores.js\":\"be61e1ecd80bcfb2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbCorruptionSignal.js\":\"38615dc737a27cee\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbStorage.js\":\"c574d7d40656805a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbVfs.js\":\"2f08c8c73143add1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localSchema.js\":\"d065f5113b5d5489\",\"/knowledge-medium/pr-preview/pr-1843/src/data/maintenance.js\":\"a48dc9bccc76a618\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mergeProperties.js\":\"a51f060f6a5c4210\",\"/knowledge-medium/pr-preview/pr-1843/src/data/metricsConsoleHook.js\":\"42c5e766baf97133\",\"/knowledge-medium/pr-preview/pr-1843/src/data/migrationsPage.js\":\"5e1a7fa1744be859\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mutators.js\":\"3e5a5b9da203bd78\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKey.js\":\"371f79b293db94df\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKeyPlacement.js\":\"a04f6e7c0615789c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/outlineSurface.js\":\"731404662ef21cb5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingEditorContent.js\":\"851e65227c7b9d2a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingUploadsSql.js\":\"26661b6937300bab\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pluginStateExtensions.js\":\"ee3f7e2447babeda\",\"/knowledge-medium/pr-preview/pr-1843/src/data/powerSyncLogger.js\":\"3f628dc0df12d886\",\"/knowledge-medium/pr-preview/pr-1843/src/data/projectorRuntime.js\":\"afc53c048048452e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/properties.js\":\"05bccb0485c5e3e9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertiesPage.js\":\"a313af4d8a4debb9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyChildren.js\":\"a04d064101dd39c9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionFanout.js\":\"57f5aa7a02badd39\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionMetadata.js\":\"20ee1270143f1e6f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionRegistry.js\":\"ad9dd8aad71605f3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDisplayMode.js\":\"ef98af5821a64668\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyRowCreation.js\":\"b7d80b89aaf69d2d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySchemaCreation.js\":\"d702b8526e9d01fd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySeeds.js\":\"8fe681baa25665ae\",\"/knowledge-medium/pr-preview/pr-1843/src/data/recentsPage.js\":\"2dba9ab386316bfd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/referenceBlock.js\":\"a5f0ab1a3dc59264\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rejectedUploads.js\":\"575b3f19b564623e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/releasePowerSyncConnection.js\":\"7daacc08b98c0aff\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repo.js\":\"2b116d7767e40100\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repoProvider.js\":\"7a750f9f92649fd2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rowProperty.js\":\"546a48541ae6fd8e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/searchFilter.js\":\"d77174abd749fc49\",\"/knowledge-medium/pr-preview/pr-1843/src/data/seedIdentityLedger.js\":\"c428fd344c77234a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/stateBlocks.js\":\"2115198d8b4404d3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/structuralEditPolicy.js\":\"3ca84d9acfebf0ea\",\"/knowledge-medium/pr-preview/pr-1843/src/data/subtreeDelete.js\":\"609298e8404ed662\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncStreamLock.js\":\"18e2fd4d7a3ff1be\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableSqlRecognizer.js\":\"fd3d2b5d879db290\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableWriteGuard.js\":\"744a01b125c46872\",\"/knowledge-medium/pr-preview/pr-1843/src/data/targets.js\":\"17a41d45cf10e41b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeColors.js\":\"01264674d26aa36e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionMetadata.js\":\"e5d9883f2562f1cf\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionRegistry.js\":\"f2cf623c22cfc397\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeExtraction.js\":\"4fa4fbac1b7513ed\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeInitialValues.js\":\"48025f1138d4e95b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typePropertyGroups.js\":\"7f96bc549f0c630c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeSeeds.js\":\"093b56e0ae2ec664\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeTagger.js\":\"69a49b9a0e08c715\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typedRecords.js\":\"45d066956181177a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typesPage.js\":\"3062a58215a2f522\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userPrefs.js\":\"0a9b3f0b0901a87a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userSchemasService.js\":\"91a58874c8324737\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userTypesService.js\":\"a9ca645c2fb5cc49\",\"/knowledge-medium/pr-preview/pr-1843/src/data/valuePresetRegistry.js\":\"5bc92477a80db659\",\"/knowledge-medium/pr-preview/pr-1843/src/data/visibleChildren.js\":\"92137d32cb1476d4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceConversion.js\":\"8c380506c2d4c63a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceFirstSync.js\":\"240b191a3f04bac2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceIdNamespace.js\":\"d948cc8134efc8f9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceSchema.js\":\"b980910166a253d5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaces.js\":\"be8fe85e134b7775\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadLog.js\":\"329528af2c769782\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/BlockPasteShellDecorator.js\":\"0b290e2fe54cec72\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/atTrigger.js\":\"3558c1bad371202a\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/autocomplete.js\":\"58a7c3e5abbe736c\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/codeMirrorExtensions.js\":\"0dba3aabf038c26a\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/contentFlush.js\":\"a34ccab709c16354\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/defaultInteractions.js\":\"57f388fd2d4a3394\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/editSettleSignal.js\":\"b57e4c123fd7bb55\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/insertImage.js\":\"c21d376267591f61\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceCompletionRange.js\":\"8255c39599e1345b\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceTargetTypes.js\":\"55528b93d66b92c8\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/syntaxContext.js\":\"11bc939dedec166a\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/triggerMatch.js\":\"fadc51533431148c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/AppRuntimeProvider.js\":\"1fce0319c70b3a3a\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/BlockFocusShellDecorator.js\":\"b5483ca91140fa5d\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/ExtensionRenderBoundary.js\":\"96d8c9b13bbc0726\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/PanelContentRecovery.js\":\"2d5027d9c45e2949\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/apiCatalog.js\":\"b08ab5c4e561c5a0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/approveExtensionHere.js\":\"75c13c77dafa82a7\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/armedCutAppMount.js\":\"d1cb91cc526eef59\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/batchableKeyedStore.js\":\"e8860f1c5a950672\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockInteraction.js\":\"d93d1c3765e98436\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockSelectionAction.js\":\"b291b9ed78e8176f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compileExtensionModule.js\":\"c680bbf5ad31abab\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compiledModuleCache.js\":\"b941d7db58ca0d08\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/continuousGestures.js\":\"4e5c5c6b5c008e9a\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/core.js\":\"2389fd4b15b177e7\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/defaultRenderers.js\":\"f76c932602044ce9\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/definitionFanoutAppMount.js\":\"6d8c873bd7949789\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dialogAppMount.js\":\"ac499135eb5e5a69\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensionSeeds.js\":\"9cbf6a1b882f36c1\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensions.js\":\"e53f4772053b20bd\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/exampleExtensions.js\":\"fe8e6e7f072eb43b\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionApprovalStatus.js\":\"4c3f59f190498ad9\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrorToast.js\":\"8d1a649dd01e1b72\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrors.js\":\"8320576f0ca69cc5\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLookup.js\":\"f911eb9aedc34e7c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionToggles.js\":\"2c48bab77ecfcb5f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionUtilitiesCss.js\":\"b05fcf1c47167ffd\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/kernelPageDeletionGuard.js\":\"2ce91a646aaa7640\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/liveRuntime.js\":\"0e7511e901c683fd\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/openExtensionsSettings.js\":\"60bad6396f91474f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/overridesCache.js\":\"b1132cebe625dae0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/pluginIds.js\":\"f4af99edf5138d9e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/processorRejectionToast.js\":\"63df5d87c8083853\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeActions.js\":\"7521271d457138cb\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeContext.js\":\"fd7632c58df2cabd\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticAppExtensions.js\":\"85e9832d89cb324c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticDataExtensions.js\":\"fc54c7be10778200\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/toastAppMount.js\":\"759a61e1ba5d3549\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useOverrides.js\":\"a02c763e8b0e8c7b\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useShortcutSurfaceActivations.js\":\"abd726c6e5611294\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/discoverToggleTree.js\":\"9520b2fec252c99d\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/facet.js\":\"11409355754b2f9e\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/resolveAppRuntime.js\":\"327678c14dda8cc0\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/runtimeEvents.js\":\"41d1767d242b73a2\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/togglable.js\":\"7dee4486d605f08d\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/variantFacet.js\":\"981858553d786d6b\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/verbFacet.js\":\"ea44d205524aab8c\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/block.js\":\"af41529621f07105\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/focusedChild.js\":\"f4cc1ebbd6da538a\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/propertySchemas.js\":\"d1957eaa1dc84a29\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/typeRegistry.js\":\"8c6eb6f7db61cdad\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAncestorCrumbs.js\":\"875697e5a5f17e97\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAutocompleteListbox.js\":\"b2edd67335a7c518\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedSearch.js\":\"0249f7d7224fcbe7\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedValue.js\":\"d4ba47c068487914\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsFocalRender.js\":\"0d40f0bb4d3f5f6a\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsReadOnly.js\":\"632738d117793c09\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMaterializeBacklog.js\":\"0cfd980faed7ad07\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMinuteClock.js\":\"3426276364ea9f93\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePanelLayoutProjection.js\":\"cb678ee53b6be39b\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePendingInvitations.js\":\"33dca54124915a47\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRendererRegistry.js\":\"d8d24e896e4eaf65\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRetainedFieldRows.js\":\"0636655af2e662f6\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useWorkspaces.js\":\"05b409f0d4cb508d\",\"/knowledge-medium/pr-preview/pr-1843/src/lib/utils.js\":\"1d2101915e82a9c4\",\"/knowledge-medium/pr-preview/pr-1843/src/main.js\":\"a38020a439bc4628\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/MarkdownImage.js\":\"a9ae708d0097c3ef\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/blockSeparators.js\":\"47b909d280ec46a4\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/context.js\":\"d8a83562b076b75f\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/defaultMarkdownExtension.js\":\"eca2e1067279e63b\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/extensions.js\":\"86fa0e1f96247a21\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/renderMarkdownHtml.js\":\"e700833658586960\",\"/knowledge-medium/pr-preview/pr-1843/src/minimal-editor.js\":\"92b9904489f86f68\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/armedCut.js\":\"b4143e9c8af4e1df\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/captureMediaVerb.js\":\"ba89d949b98f6aa2\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/clipboard.js\":\"779a7576572662ae\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/decision.js\":\"22a895f253cda4b9\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/operations.js\":\"814c0c6558ed7013\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/AccountHeaderItem.js\":\"34d82e06a3e4e9b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/index.js\":\"9c82c9d605515db9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"32c51e5242251b79\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askAgent.js\":\"e8281ff867349faf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askedStore.js\":\"9d534c8eb4914ccf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"890fbe0f2966f0d9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/chipState.js\":\"df75308620c42de1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/dataExtension.js\":\"32a3a69573492d3f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/index.js\":\"be948c9aa57f944c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4aeb1b10d4526466\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/schema.js\":\"b95b0f7589df281c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/AgentTokensDialog.js\":\"28595b8a508d6314\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/BridgePairingDialog.js\":\"94d5423b41c9c3fe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/addMedia.js\":\"d7e07050565acbf8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/backlinks.js\":\"950651a9377eec73\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/block.js\":\"fab6d329328fc75a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/context.js\":\"709b5001049783da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b2a683ddd58b9d4b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/index.js\":\"e38eca4a9cd379bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/outline.js\":\"7b7a572e8194dc17\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/properties.js\":\"86cdbc780974c4d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/refs.js\":\"2ace1c8c67e9fbb8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"33b4bedee04b06a8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/search.js\":\"f7fe7b60250fc968\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/shared.js\":\"44b2a4689a109b45\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"30d56ab5ecd7ab85\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/text.js\":\"c49f508df086c55c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentWrites.js\":\"22e787e7c3700809\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/authoringCatalog.js\":\"8183017c46fc3d9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/blockRefTargets.js\":\"afdf270508e9bd6e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridge.js\":\"ff74ed855be4b6ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridgeLoop.js\":\"16b595dfd688e662\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/changeHistory.js\":\"53f591afadd3bab8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commands.js\":\"8373dd9d1775b846\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commentsCommands.js\":\"1c93b67f1fd3e206\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataExtension.js\":\"1d08cdd3f488f2c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataModelGuide.js\":\"fecf462ba0c90cc0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/describeRuntime.js\":\"24aff7b6c0738b76\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/extensionLint.js\":\"385c03e2d66ff63f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/grainAudit.js\":\"57931b8b5da53920\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/healthCommand.js\":\"c1980dbf2e8de393\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/index.js\":\"1bef55210e52d2e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/presetIdentity.js\":\"1368000bd272a609\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f62cac8b66dde7ad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/readMedia.js\":\"066884432718cd30\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/schema.js\":\"b32db1e9d89abd8c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/serialization.js\":\"50ff456f6b0ee614\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/targets.js\":\"ad3a1f032b199968\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/tokens.js\":\"5e69c1a78761f1cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/watchEvents.js\":\"e6c88842357cae0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/workspaceGuard.js\":\"4d78e2d6cf2f0e61\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/writeCommands.js\":\"4df83835f1377cd9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/AliasCollisionToast.js\":\"21da1fe336454fdb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/DuplicateNameBanner.js\":\"8be401a13b0d71a0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/collisionMerge.js\":\"d824216556506f14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/dataExtension.js\":\"a170140b4471c6fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/index.js\":\"d6ba1a0a9d6ca9ba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/mergeCollisionAction.js\":\"ebc29ef2482c14f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/pageStyling.js\":\"e290d5f32617344c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/rejectionToast.js\":\"8a1e6726d3471b1a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/syncProcessor.js\":\"767f9ebc4018fdd7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/actions.js\":\"656b801b81f2d7e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/addComment.js\":\"3b54d2a284944e7e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchor.js\":\"de8509431caae7d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchorState.js\":\"0cbb74ebe96227ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/commentLinks.js\":\"4e64523e7cc4bc44\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/confirmThreadDeletion.js\":\"b6e9bc0d892e7f51\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/container.js\":\"02367ec119494f61\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/dataExtension.js\":\"f6c24f18b00fdfa0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/deleteComment.js\":\"bee4bd32ce9e7ced\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/highlights.js\":\"2a0f0ddcc43a4027\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/index.js\":\"c4ddf4c862c28d9a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/linkedCommentsPill.js\":\"bb4d5d036d8744d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/margin.js\":\"4a280e049b0950d7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/marginSchema.js\":\"c7fe815068633987\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/newComment.js\":\"448e60bd08edefb5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ownThreadPicker.js\":\"9c76502d7df91677\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/placement.js\":\"5d7f8b7e4c4c752c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/queries.js\":\"cf51e597faef35d5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotePosition.js\":\"c1074946ec1f6312\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedIn.js\":\"4e1d04bf2ab8fcd3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedRange.js\":\"c2fce78071344c5c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/rangeRefs.js\":\"43c32633983ec8a9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readHighlights.js\":\"d3559a42b44b66de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelection.js\":\"862fb0bbd100af58\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelectionUi.js\":\"adcf77b6fe338eea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/reanchor.js\":\"9913fcdeb80b58ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/schema.js\":\"37ab9931eb13274a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scope.js\":\"10669a5b1d4466ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scopeThreads.js\":\"7318dfc22e02a1bc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/splitRetarget.js\":\"2523dfbffa0418c3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestionCard.js\":\"30da4470b1e7e59a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestions.js\":\"a929dc7a3325a67c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaries.js\":\"801ecd6a1000c0ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaryBatch.js\":\"702617bcde3f91e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/surface.js\":\"c0c18f53aa859e66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threadNavigation.js\":\"9626bed0c6221552\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threads.js\":\"989a7a70e9ac1ee8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ui.js\":\"89410bb2b7e63bc2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/uiStore.js\":\"3c6009cb222d3711\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/appIntents.js\":\"889b427852bab9cf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/index.js\":\"7d706d12110724bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/index.js\":\"b7b22447e49fc579\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/status.js\":\"cbbedee37d10af2c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f8f3e128d10333ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaBlockRenderer.js\":\"a2c00206e4885330\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaDownLaneReplicator.js\":\"3ebe9dbf9699d97d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaUploadReconciler.js\":\"4551dc775f2bc9e0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetDownLane.js\":\"2dd45c0f8d1c419e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetResolver.js\":\"4d770fa83b6c9094\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetUpload.js\":\"fa33f7b368897c1c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/attachmentCleanerIO.js\":\"30c075ed1555eadd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3ba478bfae66dfdd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/blobStore.js\":\"93e2a7dbadc882cc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/byteStore.js\":\"ad0e71ffbe2d52c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanerIO.js\":\"726e78f9432e6a72\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanupAttachments.js\":\"9cf34edeea811033\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/dataExtension.js\":\"09ba036ee3f45d23\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/downLane.js\":\"1acb566dcbb9dcfc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/index.js\":\"37fad0cab78c5062\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/insertImageContribution.js\":\"a112fd789b390033\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneArming.js\":\"9247f3e114112cce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneLock.js\":\"cda2c44e76317cc8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaBlock.js\":\"c6b90a078fcd3935\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaCapture.js\":\"0bda84e12a2e0260\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewers.js\":\"93f2921450c04eac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewersFacet.js\":\"23b315da58176384\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/pasteCapture.js\":\"e0c3196418e1c714\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/resolver.js\":\"bbf3e98e7fbe03c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/retryUploadsAction.js\":\"22707df75da13baa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/storagePaths.js\":\"6c320e8996399a26\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadDrain.js\":\"e440072071dff5d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadLaneStatus.js\":\"33958a4884f3d4c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadReconcile.js\":\"e463b479c72ce8e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadRecovery.js\":\"1332cb91c679ea84\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadStore.js\":\"7c8567afdb62588d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/useAssetObjectUrl.js\":\"351cf5ce249b2e90\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a177062ad6ecdc83\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksViewSection.js\":\"59041f103e2d9e68\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/facet.js\":\"a249752257aa33d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/index.js\":\"d63e227d344f8a9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/prop.js\":\"202a1e1c6245a92a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinkFilters.js\":\"196ea727f00fbe4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e55da53d411ab0e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BlockEntry.js\":\"3c989ab4970b134f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/LinkedReferences.js\":\"bb2b55bd84c3c6ee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7da00f0a6b4f1398\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dailyNoteDefaults.js\":\"78b53d5ed67221f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dataExtension.js\":\"8005213d032028a4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/edgeExclusions.js\":\"b373f39ac21bc636\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/filterProperty.js\":\"203d7fbdb6d3772e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/index.js\":\"2eaf6620f633a789\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a4ebad7eb0d53aac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/applies.js\":\"9e24f3448d267c87\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/countQuery.js\":\"9e83144e78260758\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/expansionStore.js\":\"dec9974ef159c3b1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/index.js\":\"91e7c7006b70c596\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c8b47920901e214e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/presentationInvalidation.js\":\"60cd5245d3f2fca6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyEditorOverride.js\":\"d747b6005a3ae8f0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyFilter.js\":\"2e03fc390911c838\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/query.js\":\"ab957e3c0f819c42\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/resolveFilter.js\":\"aa99c0e004818b1a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sourceBatch.js\":\"884a8fac089ad8c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sources.js\":\"ee0026c18874517d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useBacklinks.js\":\"9a6b312e012e46a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"398176592a018e5d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayCelebration.js\":\"234349945f256c68\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayOverlay.js\":\"a70a3b4e39f7231f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/gate.js\":\"d74e304358800b37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/index.js\":\"e64ed8da52db70c8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/wolfTheme.js\":\"0029db9ab6e12cea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/BlockDragLayer.js\":\"a9f8f166db75b7c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dragController.js\":\"74769f69e6b583b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dropTarget.js\":\"fb66ac2e0665b88b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/index.js\":\"571df7006172ed47\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/projection.js\":\"d21fedbbaf99b8c3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/BlockMetaCard.js\":\"cdb0291338107c6d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/index.js\":\"3415cf8a15472eb0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/AddTagDialog.js\":\"73b4073d17d7e9e3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a4aa03c2414b883a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/TagNameIssueHint.js\":\"431d0f903ea1df37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/addTagAction.js\":\"374414c5eb48a523\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/appendTag.js\":\"79e9baff60dc86f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/config.js\":\"d6c352e271b82228\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/dataExtension.js\":\"939aef9cca101896\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/index.js\":\"8fe4c6c25c5fd34d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/propertyEditorOverride.js\":\"81ede02761f5620c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbList.js\":\"43020f6b48a035d7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"11f7b08fa6206488\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fa35652bfe81e7b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"f9fe8eb594a2441d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2a3b331605b7d262\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/index.js\":\"5daa5d8342f6f7ae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"175b5230e2d36a09\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/CharacterCountItem.js\":\"e6f21d6f4ccfc92d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6e4e3c4bdbd89708\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/actions.js\":\"a91a937229d22f2b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/blockType.js\":\"c7455dadeafcbdf5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/charCount.js\":\"0a01e5d35f0f0c08\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/dataExtension.js\":\"c6c23c553c401d90\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/index.js\":\"ca4a68ef14eca44a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/profiles.js\":\"a4eafd381689c5ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/properties.js\":\"ebe39c98928cbd73\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/textCounts.js\":\"a6ebbe753b6f2fd8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/colemak-keybindings/index.js\":\"c87c75b9f4ddcbc4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/CommandPalette.js\":\"13e1bdd8c09c3051\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/HeaderItem.js\":\"3bd1630a730edb7d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/context.js\":\"a3601a06cba5cb2e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/index.js\":\"80c97548f4b43a10\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/selection.js\":\"325fdfd8bbdb8cd2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/toggleStore.js\":\"2393b4af2c232a47\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/useCommandPaletteActions.js\":\"53c0af5f08542111\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/ContributorBadges.js\":\"6d4ae5810c9b17f4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/author.js\":\"0bbe248df33b72bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/codeMirrorExtensions.js\":\"720c87bc2915ef02\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/dataExtension.js\":\"043f6a728d2f6317\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/index.js\":\"3ba18cdcf6a1eeb9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/mentionAutocomplete.js\":\"2496f835799570d7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/processor.js\":\"3e93b7437b3f26cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/profiles.js\":\"01e410c57b91f9cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/queries.js\":\"97384eb01c398abf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/schema.js\":\"a0bd0bcc22b7199c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"22a56c67bb0a26a9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/followOrigin.js\":\"331195ba73f36bef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/index.js\":\"c20ba67686a0d61b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ec30bf1895027ef2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"cd687003a7583da3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/CalendarGrid.js\":\"615fb908d4acd47e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DailyNotePicker.js\":\"c280a26bb81855d8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b30456917ed7d03a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateNavDecorator.js\":\"db074c0bccb36688\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateScrubOverlay.js\":\"cc27b6a042194a8a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/HeaderItem.js\":\"ef552d496a553b45\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/ReschedulePicker.js\":\"6e92b2a6a80e2b55\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e22817206dcbc018\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/actions.js\":\"4fe25252285a0bb8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/blockDateAdapter.js\":\"b595b1045e7574e0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/calendar.js\":\"7d16863fa70083c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dailyNotes.js\":\"9641032582220ea2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dataExtension.js\":\"717919b14109f7ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubActions.js\":\"60ef9115afdf29d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGesture.js\":\"68b24384a38c74ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8351a98970652600\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubRecognizer.js\":\"95a5957c7b358b81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/deletionGuard.js\":\"0bc3baca6675e1db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dueQuery.js\":\"902a627a6484d7c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/index.js\":\"98f90ebcce3ff820\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/landing.js\":\"6101a38f0909695d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/localSchema.js\":\"adc0ffef4c9c8122\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/referenceDateAdapter.js\":\"d8492f2c4ad51614\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/rescheduleAction.js\":\"8957ebe1b774d171\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/schema.js\":\"cd6cb940265c0746\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadBlockDates.js\":\"4a09c096c0f43d04\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadDatesAction.js\":\"feff6d6b1be96ed8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/today.js\":\"9915596648026d3b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"00bfb423cc53587b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a25fd34d08ecd683\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/audit.js\":\"6e57b73c8c73c5e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditAction.js\":\"e951986ef245cc94\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditRanges.js\":\"89a3db26842329af\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/diagnosticsSource.js\":\"e036e6f2cbd7922a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/divergenceScan.js\":\"e0ad5cd7c004bd61\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/index.js\":\"a4fbd57b664f45d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d6efc0fa02e722bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/referencesMirror.js\":\"412d394dcfe97041\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/rowJson.js\":\"80591cebfa8b20c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/schedule.js\":\"65e48a357d4cc1fe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/store.js\":\"0bac57e578299732\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/action.js\":\"469d0eec7d5a837a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/index.js\":\"49498b5e42f11638\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/plugin.js\":\"788b59ad0d84379b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9c6ed6ca7b9bccb8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/actions.js\":\"f98e2e1263f2544f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/changeMarker.js\":\"455d34f2c39161bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/diagnostics.js\":\"906270a1b09a34f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/fileSystemAccess.js\":\"55d08b1ad9eb95b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/filenames.js\":\"048e25f7c22eee6b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/index.js\":\"b5af956d817a3d4f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/mirror.js\":\"85efb8f50ac92ba4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runLock.js\":\"908229fb5d510053\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runtimeHealth.js\":\"c0826168afe89d7a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/schedule.js\":\"4abd0f0929a11067\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/store.js\":\"40b30438cc0592ba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/index.js\":\"372ac50189fbd0f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/themes.js\":\"c2fb7ff2292b9d47\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/facet.js\":\"247b38e425364b2b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/useDiagnostics.js\":\"5c0f98bec1c8aca4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/dismissals.js\":\"d7f58d9dc07a5558\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/index.js\":\"cbb7ad96a94533d0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/status.js\":\"844e5c8978e3480a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/store.js\":\"d766ec4b0e8a9235\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"55efe2b8ed6477bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsSettings.js\":\"da75876bd5588c42\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/actions.js\":\"1fbf3f873cd629d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/config.js\":\"4935f8d649c78b47\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/dataExtension.js\":\"9870b2d778e629a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/effect.js\":\"e92d5e7dd0e5b7ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/index.js\":\"98f21582f70269c8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8c1287bb1a0e8c32\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/useToggleTree.js\":\"1905b4729981b595\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/ExtractTypeDialog.js\":\"8558511098fdb4fb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"40d44eab81c3a86e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/PropertyShapePicker.js\":\"b42eda97e1827e8c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/action.js\":\"a7352f4c8221bcef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/index.js\":\"bcd07782d12b6e26\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/FindReplaceDialog.js\":\"ace80918481095d7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/HeaderItem.js\":\"a06c6ec8e3625cec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/dataExtension.js\":\"c8b1a71eaae8e4a7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/index.js\":\"7761c3217572f205\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/search.js\":\"b248dc08897d0771\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/toggleStore.js\":\"724ff3a153dfba23\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/LocationPropertyEditor.js\":\"63e88572b2f0a517\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/MapView.js\":\"a685971776edce9b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/blockTypes.js\":\"9f317ef40f699bc0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/codeMirrorExtensions.js\":\"e61716a78d08a23f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/createOrFindPlace.js\":\"458a71b8b737b31b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/currentLocation.js\":\"bda369923e75a2b8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/dataExtension.js\":\"22330d39d4567b1e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/geoContentDecorator.js\":\"aa4c24578899b8d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/googlePlacesClient.js\":\"f14dced8a199579e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/index.js\":\"fb4ec93a25d8311b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/locationsPage.js\":\"1d6e122ac0299906\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/mapViewport.js\":\"f666c8606a6a4c20\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/pickCurrentLocation.js\":\"20a62104549c200b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeAutocomplete.js\":\"6c72dcbfe6d3c492\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeNameCollision.js\":\"52e3b0e04b7cf7c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/properties.js\":\"8d54df45366e54fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/propertyEditorOverrides.js\":\"d750456f9904aabe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/query.js\":\"d6435b7e090428bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/usePlaceSearch.js\":\"87304116218ddeaf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"326a69f26b0961b1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e0b5b6f30c2c97f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b6af12fb0067110f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/config.js\":\"774382c097ce0350\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/dataExtension.js\":\"04866f2f9fc36224\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/facet.js\":\"47a018703294105d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/grouping.js\":\"6cf1b1a36b0463e3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/index.js\":\"8a1419c9a701d124\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2702ca0b4dc9fbfa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/query.js\":\"4933bfb3e6d400e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/resolveConfig.js\":\"d92b65a89a5d4994\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d4c6fe1653ae22c8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"499c3b5bc79f93b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlDocumentContent.js\":\"de27f92235e2afb3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlFrame.js\":\"af0573034790ff7f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/actions.js\":\"6ce219e01f81f347\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/blockType.js\":\"aec351c9b3da82a8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/confirmRunScripts.js\":\"0f8f0d2db215da8e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/dataExtension.js\":\"e91240d81a15eefe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameAnnotations.js\":\"a6429c7890e211f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameDocument.js\":\"07fcb5f8ee0f7ae3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameTheme.js\":\"81dd465b6481ec20\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/index.js\":\"0f95886543030147\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/scriptConsent.js\":\"b9d8bd6736d55028\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/sourceMap.js\":\"8e7989319b1d1281\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/useDocumentScripts.js\":\"99e48ccd504c43c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/index.js\":\"ad6a369078e844c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/record.js\":\"3c3288bb76e70c0c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/recordStore.js\":\"3f97f5b320415fd5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/responsiveness.js\":\"a472051f1b2a2d1b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/schedule.js\":\"88771c7dccd3a82f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/sessionContext.js\":\"245dc5012abc35c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2c26d41c5eafa8b3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"81eb27f1e5172916\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/actions.js\":\"1880c85af0d6135f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/config.js\":\"1f09c91d6c01a621\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/dataExtension.js\":\"c5443b3e0eeb0099\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/effect.js\":\"892ffd449a056100\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/index.js\":\"af5a6e9276d09486\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/keyCapture.js\":\"77778016d2af5585\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/overrideStore.js\":\"73ab29316e2b2684\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d44aaac71dba7e3e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/HeaderItem.js\":\"0d5ec5934c686037\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/LeftSidebar.js\":\"eaedc541de5ecff5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/actions.js\":\"87f261fcde49aea0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/facet.js\":\"fe9f82157b8e98fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/index.js\":\"72d63083dfca0029\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/shortcuts.js\":\"01769c9333aab35d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/toggleStore.js\":\"e085a5acb3c97330\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/MergePicker.js\":\"b52ce3b400e6e461\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/index.js\":\"99beac12ba6cf90a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/mergeAction.js\":\"6a064cf1807a4a4e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/strategy.js\":\"6efff1584540a8c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/Button.js\":\"d3ef0a3ec1d67fbb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ddc9ebc07e49498b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/defaultItems.js\":\"689e1dd7430f20ee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/facet.js\":\"2570a5b4ca4fd31b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/index.js\":\"c6760ba9ea4d5645\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e670ed8bc74371cb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9c63275cf98dad4c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7df2720f637a9445\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a689d57966e99f88\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/index.js\":\"a158a93f013eea4f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/MoveDestinationPicker.js\":\"72ca2332c906bea8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3a01d40896bba0c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/contextMenuItem.js\":\"4375c718c3918cfa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/index.js\":\"32b1ebaa5973daa0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveAction.js\":\"b870c25f7aff5d5c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveBlocks.js\":\"eb8119bf85e9f25a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/selectionAfterMove.js\":\"b04fc0ebf4435141\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/TutorialBanner.js\":\"0a6f9c56137a4b17\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/action.js\":\"4030cc3e8f15829d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/bannerDismissal.js\":\"5731279bc5b51551\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/documents/cheatSheet.js\":\"48254105ec3dd54b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/index.js\":\"31b33ba4491ca521\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/keys.js\":\"36fbdd0b1ed7cb97\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/landing.js\":\"5a3f97da72c43cf1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/outline.js\":\"67a6af2e28b96616\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/seed.js\":\"b41f26e6abee99ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/PerfTrendDialog.js\":\"77fae66250a3772a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/analyze.js\":\"ba2869946c624a8c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/diagnosticsSource.js\":\"88ade36a9472e847\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/index.js\":\"66dd210b78b313ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/load.js\":\"19dcfb56a19fccc3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/monitorRun.js\":\"b9e0d2fe1752dc6b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/schedule.js\":\"7163e0a5bda5aec5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/series.js\":\"d7aef693f6edc0cb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/store.js\":\"9647fad26af0ae77\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/trendAction.js\":\"e5852646db848061\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/verdict.js\":\"d662e4cb2b91b426\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/clickToEditAction.js\":\"cea8f1660c635e4f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/index.js\":\"ab305c4b96c55209\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/interactions.js\":\"54e0257ef2264ce8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"19903517160a3520\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGate.js\":\"58a70d72a89884c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGateDialog.js\":\"f164c8268bce09b1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/action.js\":\"85d0247cae766568\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/index.js\":\"77992670b708dc4d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/localRunMessage.js\":\"ba7067fbebc24bc8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/plugin.js\":\"048a115fc2027697\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/progressReport.js\":\"c775f257e455b6f3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/sweepProgress.js\":\"8ac7ad25bb69a90a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/FieldRowRenderer.js\":\"d2c0d5cc191c21f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/ValueRowRenderer.js\":\"6040d96ba5c9695e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/actions.js\":\"5ab02331e946ca81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/autocomplete.js\":\"08f384f32a9d8772\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/fieldRow.js\":\"9acac003a41de061\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/index.js\":\"97395adf813618fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/referenceWarning.js\":\"0340273f0ac87a07\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueAutocomplete.js\":\"9722411632c94704\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueSchema.js\":\"008520955bfd5cf9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/HeaderItem.js\":\"9d0daf0802afc10d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/QuickFind.js\":\"0a0acc127404b168\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/index.js\":\"9f82df8b6968d3c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/recents.js\":\"0280e58b671b0656\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/resultItems.js\":\"6795c5afe1cfc57c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/selection.js\":\"21166f50c37e7ff3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/toggleStore.js\":\"67d518abbf3e6c81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/HeaderItem.js\":\"b02897df7bb36eb3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/RecentsPageBlockRenderer.js\":\"571630573fbc0713\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/grouping.js\":\"708bbfec774e21dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/index.js\":\"cf0de333ff43281d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/target.js\":\"2c9747a3a633da18\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/codeMirrorExtensions.js\":\"7b61f5ed3df87fd4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/contentPrefill.js\":\"0ab050bfe2530c0d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/dataExtension.js\":\"d82bc2cacdeed8b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/index.js\":\"273b25a7b37f0439\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"29c6f15f63b393ef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/invalidation.js\":\"5995407a516fc139\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/localSchema.js\":\"325242e4652e4a30\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/index.js\":\"e107d719a2664cf3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"217007a46e689383\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/index.js\":\"601dd22a58ad696a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/referenceNode.js\":\"f74773fe185bd91f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/remark-reference-occurrences.js\":\"96b65842469c53bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c29f9109ae9de4ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/index.js\":\"6c46f42b9816b5c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"abd6cdf31a886737\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"49b089992d60c9ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/mergeRetargetProcessor.js\":\"e78424026724cf46\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/parseFence.js\":\"4c13f733e7a78fa4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceParser.js\":\"56ebc6c1d87cbebe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceProjection.js\":\"05a934fa087c7b51\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referencesProcessor.js\":\"a8619951a2c002c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/renameProcessor.js\":\"aee6b61222a5ea93\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/spanReplacement.js\":\"61f83393c61bb31b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/htmlToOutline.js\":\"3244ab603af2e959\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/index.js\":\"2a51b08e3c51d5db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/normalizeClipboardDom.js\":\"73cff5e2e03dd894\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/pasteDecision.js\":\"3b65f032eb3abb9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/action.js\":\"b425dd71c1fa6191\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/blockIds.js\":\"b65a9c21e3dfc929\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/content.js\":\"bf720d7f9085bbdf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/effect.js\":\"73f11a73a9703b0b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/ids.js\":\"58071f1e988d8f92\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/import.js\":\"e629ee67f6bdf3c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/index.js\":\"e02f81e6316b527f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plan.js\":\"397d347d88606f80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plugin.js\":\"1205d64f77cb11d9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/promotion.js\":\"fb48a2826ca925c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/properties.js\":\"98e7f9bb517ca36d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/references.js\":\"597bd8c2e01f2500\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/report.js\":\"795c3e2710605ec7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/roamMemo.js\":\"28198f48cf51ed28\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/runtime.js\":\"eb737d6d9881cc20\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/schemaReconciliation.js\":\"6c3e13d535135d5a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/srsMarkers.js\":\"ba71d2aa109b3fdf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/todo.js\":\"33cf648ecde3fa8a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/typeCandidates.js\":\"22a7adcbf3ae5e11\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/types.js\":\"43421535d202483f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/index.js\":\"5d9d663214fd57c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/store.js\":\"00a7b40f30f6763f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/HeaderItem.js\":\"e911a57057b7ba08\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"69932dc536591f05\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/index.js\":\"f8790e2ed404b4b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/model.js\":\"4822bdb3d37cd10a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/toggleStore.js\":\"1c45073beb3da3ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/useKeyInspector.js\":\"86701eea7122d569\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5c04c2e18504b93a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/ShellDecorator.js\":\"1cd381c66ebcc676\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/actions.js\":\"e91b6e29c0b61505\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ad41638d9f65e839\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/index.js\":\"77be1c06bd401c15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/shell.js\":\"d307bd443911da07\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/surface.js\":\"4519f65d8ec0b3e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/walker.js\":\"9f3dbbc0e61a3a56\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/RescheduleToast.js\":\"297a21fa53fe715c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/dataExtension.js\":\"37943c4ad62b5280\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/index.js\":\"0a66ca552967e02b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/indicator.js\":\"2991623d0d5c5a8d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/moveSrsState.js\":\"05d8110384c8a7a9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c8acbc04dfb6d998\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/scheduler.js\":\"e165fdf2e69e4076\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/schema.js\":\"43b14a2997dfedc3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d6197048db599560\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsClipboard.js\":\"a8d40489a01ce44d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"556675beca2e9cba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9f4aa86d7da1a5f8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DeckPicker.js\":\"1c3d12ddee90ec5f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewControls.js\":\"de25d21bbb0e401a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4a1a496fda965fdb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewSession.js\":\"486ade2b144e6ca0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/actions.js\":\"ba0e8b15cec36bf2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/archive.js\":\"c2f160027aa98224\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dataExtension.js\":\"c4e53099ad782256\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/deck.js\":\"321484e0bb1d1017\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dueQuery.js\":\"e6129d54688bd7c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/gradeDecision.js\":\"2ecef9537c2fb313\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/index.js\":\"af7aa16e25e7392f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/keyHints.js\":\"8faf3740d86f967c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewCardLayout.js\":\"673f7e31e156173f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewProgress.js\":\"b8f40531f2ad2e35\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/schema.js\":\"230ef89c8a9b4c3a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/useDueCards.js\":\"c2cbf73e325ce01a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/index.js\":\"1e8eebe3d6c3cde6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/record.js\":\"7464ff19257089c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/index.js\":\"45132bf4e1e83590\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/persistenceStatus.js\":\"45cdd7c9b6433388\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/requestAction.js\":\"be6357276ed90465\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/TypeChipsDecorator.js\":\"9785273041fc5dc9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/codeMirrorExtensions.js\":\"8f986d99b25daa5d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/index.js\":\"20148f31c36d170b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/typeAutocomplete.js\":\"f6980013b52b00a1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8863e4ccb4f8b6a9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/actions.js\":\"4912a64b855386f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/anchor.js\":\"0b231e9e77cb7225\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/events.js\":\"abdad595b441812b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/gestureActions.js\":\"04f3dc5ced708243\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/index.js\":\"f1ea88d89ee94529\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e3ec0555b52d5e8c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/collect.js\":\"1e857e1b6532f391\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/index.js\":\"1639e9a4274a39ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/record.js\":\"85fccd8bb2545cee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/RejectionDialog.js\":\"630e551f44faf213\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/SystemStatusHeaderItem.js\":\"553d711cf63db328\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/index.js\":\"2b58e520910ea803\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/model.js\":\"d30ece1292064e7e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/queueCounts.js\":\"855366c99eb6d1a9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rejectedHelpers.js\":\"1009d11bbd2c0bdb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rematerializeAction.js\":\"b11e9c1252a897eb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/useHysteresis.js\":\"8b62830178796270\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/ColumnHeaders.js\":\"051fd793c68e92fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/QueryUi.js\":\"5b945881eddc67b7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/TableLayout.js\":\"2949ceeae5d499e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/actions.js\":\"7136d7a14ca8bbcb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/cellEdits.js\":\"fd5ab9dfd63bba53\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/columns.js\":\"ece75cc79e650c1a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/controller.js\":\"e44a1c678f274eb2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/convert.js\":\"ccdc50559203f0fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/dataExtension.js\":\"d12c27f5590a3cdc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/index.js\":\"dfbec33414c65b1b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/keys.js\":\"8a226ba792a4f4cb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/model.js\":\"eccc3986c204c7b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/backfill.js\":\"ec51187f94d87790\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/completion.js\":\"bf10e252263601d0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/format.js\":\"287800d5f910a240\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/parse.js\":\"0739241ca1698a0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/queryValue.js\":\"1a6a0688643c1b1e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/source.js\":\"438e14d974b865b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/registry.js\":\"2ea47b52f6191e9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/schema.js\":\"ca9e17cd87b5312d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/sort.js\":\"3de1f33c98712264\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/effect.js\":\"5400aec8f3e5db98\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/index.js\":\"e5b63c0eb6261656\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/theme.js\":\"f94ed2c46a0363e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/actions.js\":\"c5bf16f4257db558\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/dataExtension.js\":\"5f869965c341c85f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/index.js\":\"18f7d672ad990bab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/schema.js\":\"af4081718c9b1d3c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f4290b643e0f8b9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/actions.js\":\"5ab6eb3df58beed5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/defaultItems.js\":\"139e6b5001a9e59c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/facet.js\":\"93511144f626ebdb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/holdRecognizer.js\":\"bbf48aad40d0f295\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/index.js\":\"ac0c7c5f48e0af61\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/UpdateIndicator.js\":\"027a2440bf5300eb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/index.js\":\"2a78de4dbb5e3cb2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/loadTimes.js\":\"955873243190bca9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoNotesRenderer.js\":\"2b6c4b8db06712e3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoPlayerRenderer.js\":\"91ac41290f92e1f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoTimeStamp.js\":\"65fca98f1f4081a4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/actions.js\":\"944ddd93d3c2d37a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/index.js\":\"5e78094237273aeb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/markdown.js\":\"bf3be7e9b85d9d0f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/notes.js\":\"ba71623847b6c642\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/registry.js\":\"e55e0eda7b9f2ce6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/remark-timestamps.js\":\"ea6596ce96d20033\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/view.js\":\"eb7de060afa25f9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/LinkHints.js\":\"606c6bf553e00916\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/index.js\":\"65103c1598fd35e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/model.js\":\"03ec67a54060f3bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/settings.js\":\"d1b7c71bb5d31bde\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/actions.js\":\"f301bccbc98c3831\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/index.js\":\"0691f65135427ba1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/interactions.js\":\"0e5a06d191679972\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/workspace-header/index.js\":\"cd9ab6b4986c73a4\",\"/knowledge-medium/pr-preview/pr-1843/src/registerServiceWorker.js\":\"12d1ab08dc264458\",\"/knowledge-medium/pr-preview/pr-1843/src/requestPersistentStorage.js\":\"310e30b27fb5c7ad\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authRequestDeadline.js\":\"20afdde56785c807\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authStorage.js\":\"5420c7259fa188e7\",\"/knowledge-medium/pr-preview/pr-1843/src/services/powersync.js\":\"5cab399de531c13e\",\"/knowledge-medium/pr-preview/pr-1843/src/services/supabase.js\":\"2f280917eb0c6a66\",\"/knowledge-medium/pr-preview/pr-1843/src/services/uploadErrorClassifier.js\":\"3494d9e2519e1e16\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/ActiveContexts.js\":\"5f775025cf67f6bd\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/HotkeyReconciler.js\":\"3813c862971abcd1\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/WipeLocalDataDialog.js\":\"3b21b81708612d60\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionDispatch.js\":\"ab8922bedfce3d59\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionRefItems.js\":\"21162cd43d91d74b\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/applyKeybindingOverrides.js\":\"f008610bb744c436\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/blockActions.js\":\"e69dcebd898a5efd\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/canonicalizeChord.js\":\"e8012373ff0dd348\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultContexts.js\":\"f933f4cec320be35\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultShortcuts.js\":\"0594f7fd05a30840\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/effectiveActions.js\":\"559f9daa1dc32d11\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureAction.js\":\"aaf955487654c8fb\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureBinding.js\":\"70b15bcd0c7267fb\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/holdRegistry.js\":\"098ec1fdbd8f28fe\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingConflicts.js\":\"4b6a9c81d414f224\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingOverrides.js\":\"d2d1a06742118a76\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/pointerAction.js\":\"9bdcd4b515b8229e\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/resolve.js\":\"31970df6a5a5300c\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/runAction.js\":\"f3a5b2c2171fb004\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/sequenceMatcher.js\":\"33f4e4f466a34289\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/types.js\":\"c8ed0c3c0ebc0998\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionContext.js\":\"e9b5440fce361efe\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionDiscovery.js\":\"57b5ecd9fe782517\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/utils.js\":\"7a5551a539e07668\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/bootStore.js\":\"ba21d77121d7bd31\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/previewDatabases.js\":\"f4e1718e6d8616e2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/byteTransform.js\":\"c2cebe5b2749635a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/attachmentCleaner.js\":\"300c9e8d871cf46d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/attachmentParts.js\":\"058cb8f1f9d26e53\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleParts.js\":\"b0e4f06f711efc74\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleRecord.js\":\"b932a75ae04bc522\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/manifest.js\":\"1605fb71d4a11a35\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/takeBundle.js\":\"7a7f29b65d939500\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/verifyBundle.js\":\"2ebd97fec9ce5d5c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/cleaningStage.js\":\"d6b16dead4fa60a3\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionKey.js\":\"707fdb53524ff642\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionServer.js\":\"1ecbb131111e0ad0\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flip.js\":\"8fa302194c4a45a3\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flipAttempts.js\":\"0d47f91e21c010d3\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/pages.js\":\"137e93aa7cc96556\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/preflight.js\":\"884a20e621743996\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/reseal.js\":\"2e825e60a5c89225\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runConversion.js\":\"236439af361e60a8\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runLock.js\":\"ddcd8dd9f48405af\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealing.js\":\"60e2ec8a23c7dc7d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealingStage.js\":\"ddf964bd59dcee8c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/stage.js\":\"72c51a19f14c301e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/verifyReseal.js\":\"741f48833f594098\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aad.js\":\"93152669b05e7d9b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aead.js\":\"ce15341c13359071\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base32.js\":\"9b5979f4cf873a17\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base64url.js\":\"48950e03a780e770\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/binaryEnvelope.js\":\"8d36d1c7bd742d8c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/byteAead.js\":\"381fd1b8e739e550\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/canary.js\":\"9e092e2a9dbb58de\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentHash.js\":\"f05c4cb116e9c356\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentKey.js\":\"b56a5a5801eec6c7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/derivedIdNamespace.js\":\"f4ac69a2682698f6\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/envelope.js\":\"d27aff7aff8c1676\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/hex.js\":\"eaa938b48b84a5d5\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/sha256Hex.js\":\"57530efccec9b390\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/workspaceKey.js\":\"cdd96bf44dccae01\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/conversionState.js\":\"9a7807845ce31cfa\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e123a2fa5c3c1621\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/pastedKey.js\":\"c51b273192f0aabf\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e906615452315d3c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/upgradeWorkspacePin.js\":\"28238510f70a7b02\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/keyStore.js\":\"eef207515fb80f94\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/mintWorkspaceKey.js\":\"838550ce3be428c6\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/modePin.js\":\"398cf71b6cfa4764\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/openWorkspaceKeys.js\":\"01f9c8af77e99f26\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolveWorkspaceEntry.js\":\"15cc6e9930513406\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolver.js\":\"9baf33a166409db4\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/workspaceAccess.js\":\"d656572d7fc76b59\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/transform.js\":\"e4c5eabf7fb915e3\",\"/knowledge-medium/pr-preview/pr-1843/src/themeBootDefaults.js\":\"78fb437a9dabcdd2\",\"/knowledge-medium/pr-preview/pr-1843/src/types.js\":\"9b8cdbfb03d4a880\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/ClientLocalSettings.js\":\"ee74e4999eb0ba58\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/abortableSleep.js\":\"8051eb194eaf809f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/array.js\":\"c34c41bc3ecfa580\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/backlinkAutocomplete.js\":\"8e521298678b33b9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockCrumbs.js\":\"e495360f95ef8f48\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockrefAutocomplete.js\":\"2d81d1f2944d2346\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/cadencedIdleJob.js\":\"56d307980db53365\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/callbackSet.js\":\"aa584804534535bb\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/clientId.js\":\"b8f19c0e0d5cf092\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirror.js\":\"f1450232641e3f39\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirrorCompletion.js\":\"27fd136bde4a0d49\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/copy.js\":\"12860e9f80baf336\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dailyPage.js\":\"3ac5137cfa15b196\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensics.js\":\"d4075a72adf675b9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensicsHooks.js\":\"b73f18d11c0054f1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/deleteBlockThroughUi.js\":\"3a3c3485a99e87b3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dialogs.js\":\"36e284f01cf20855\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dom.js\":\"a935988682099fbc\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/downloadBlob.js\":\"738455485e9a36d0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/exportSqliteDb.js\":\"3f0b61224a6b2d50\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fileSystemAccess.js\":\"1d24eaeadd5b6e6f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/flipSlide.js\":\"6ae7a55688e6bff3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fnv1a.js\":\"9d3171f9c1bca27a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/formatBytes.js\":\"a259b1033571fdd6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fuzzyRank.js\":\"cb3dda62c7b47b39\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idbKeyedStore.js\":\"c74fda7686783b64\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idleCallbackPolyfill.js\":\"1c73b24df4a97a3a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardAwareScroll.js\":\"9ed179beda09c2a4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardViewport.js\":\"31f0c747fdea6511\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/lastWorkspace.js\":\"be4632fea2ec1fd6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutColumns.js\":\"9e4983726afa3308\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionDom.js\":\"550f4664a30d09f0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionId.js\":\"6a03561efdffab0e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkClickGestures.js\":\"a08e4af615e9c728\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkTargetAutocomplete.js\":\"7b7419d32d50e232\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbCorruption.js\":\"0fdc17aae30b87eb\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbRecovery.js\":\"dd9467012014a674\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/markdownParser.js\":\"e3df6e5a5e8af03c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/memoize.js\":\"394ad0233fedfd18\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameFieldCommit.js\":\"1403e64c67dd4fac\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameList.js\":\"76b2017d94afc63e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/navigation.js\":\"bae2959d3b298cc0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/omnilinerNamespace.js\":\"80730688154cbf19\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/opfsPageScan.js\":\"87b6b70432b178ab\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelClearance.js\":\"b5c793a5f817dd0f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelHistory.js\":\"df1eb0c5dcf6d908\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLanes.js\":\"33c0f36a7f2b4d1f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLayoutProjection.js\":\"9c8d951917a6c174\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelScrollAnchor.js\":\"c8f88a5ebf0e34b7\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelUrlFlags.js\":\"8ad6743389b50465\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/platform.js\":\"3372163dfd8d05e0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/pluralize.js\":\"8054252d75d87460\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyCreation.js\":\"580e85091a769afc\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyNavigation.js\":\"8ccbea93d5574888\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyValueContext.js\":\"f49924e00a0bf4ff\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/react.js\":\"390497e2ce5c7c76\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeDate.js\":\"a2b4f1f861ca55b1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeTime.js\":\"15bae29ec4a24c55\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/renderScope.js\":\"3971ac9ac68b7075\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/resolvedThenable.js\":\"00561c2be1e75857\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/routing.js\":\"1da637f5351d9980\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/safeMode.js\":\"c539d7b8030d5dc4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/scheduleIdle.js\":\"276695b5ae7ed1d2\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/screenWakeLock.js\":\"2b3999eb823dc5b0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/selection.js\":\"033ce37b168e4728\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/softKeyboardGrab.js\":\"18e98a0142977968\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/startupTimeline.js\":\"d3356a38545a2c25\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/state.js\":\"f63bd41ee9a509cc\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/string.js\":\"de1f754ea308ae06\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/surfaceZoom.js\":\"e978df35f6d1ccd4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/time.js\":\"ec8be99545ef4a94\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toast.js\":\"c4c009d8c0c51e38\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toggleStore.js\":\"6e9e5c2a9a8e9c84\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/untilStopped.js\":\"62cca0ce22e768fe\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/userActivity.js\":\"5563266f7c55ba07\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewTransition.js\":\"688eb05e35476c5f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewport.js\":\"9730780185ffd25a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/webLock.js\":\"499b05c10410ac2a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceRecovery.js\":\"627949cf89d9a0d5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceSnapshotStore.js\":\"b6a80c0c8fb47230\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-compiler-runtime.js\":\"8acbd5a1c233b1cd\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-client.js\":\"7880e8283f906df5\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server-edge.js\":\"2de05538862aef11\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server.js\":\"fa333c39dfb652da\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static-edge.js\":\"11e29ecc2202a1c5\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static.js\":\"5874bc83a25778a9\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-test-utils.js\":\"417dc4dd51311264\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom.js\":\"60e12ccdfcbac24e\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-runtime.js\":\"6585a998fc1032cb\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react.js\":\"43d26d5ea5845229\",\"/knowledge-medium/pr-preview/pr-1843/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
