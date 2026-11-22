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
		buildId: "10cf03ca4a37-d4a24798",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/\":\"33390c35896bd143\",\"/knowledge-medium/pr-preview/pr-1843/index.html\":\"33390c35896bd143\",\"/knowledge-medium/pr-preview/pr-1843/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1843/assets/FacadeVFS-ofj0i22q.js\":\"a6e1f28e5361feec\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSCoopSyncVFS-BhrlvFWA.js\":\"8fc25c534ea5c990\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSWriteAheadVFS-DS0_FyaA.js\":\"16e103b17d91d23e\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CRCguSI5.js\":\"aa6dbe9e5bc6a3b3\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-GLERWaka.js\":\"cf98e2fdd0d1dbaf\",\"/knowledge-medium/pr-preview/pr-1843/assets/worker-B9r2ZG4t.js\":\"4f9964d75f43f9e6\",\"/knowledge-medium/pr-preview/pr-1843/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1843/chunks/app-BIrUxSFq.js\":\"2b02874e0f5c25f7\",\"/knowledge-medium/pr-preview/pr-1843/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1843/index.js\":\"588a11da7487887e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1843/assets/AccessHandlePoolVFS-BrHqH0LF.js\":\"3dd3b425d7f584f3\",\"/knowledge-medium/pr-preview/pr-1843/assets/IDBBatchAtomicVFS-DisVqdIZ.js\":\"715765c3a8a2d1d6\",\"/knowledge-medium/pr-preview/pr-1843/assets/MemoryVFS-CT4RX-8V.js\":\"4f9a7b62a7277c63\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-BUt3sh4X.js\":\"b01cc87057ea9771\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-BhT5GCaC.js\":\"f0ae8daa6730efe3\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1843/chunks/AccessHandlePoolVFS-DeqHiWnD.js\":\"19c6e4d041ff0cf5\",\"/knowledge-medium/pr-preview/pr-1843/chunks/FacadeVFS-DLVun39K.js\":\"a0684033e2176055\",\"/knowledge-medium/pr-preview/pr-1843/chunks/IDBBatchAtomicVFS-CUWO0ynA.js\":\"eebffe40cfb71359\",\"/knowledge-medium/pr-preview/pr-1843/chunks/MemoryVFS-RPFz19O8.js\":\"dc974bf9e085cd59\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSCoopSyncVFS-CV0XsnMG.js\":\"26c59820d045fc9c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSWriteAheadVFS-86UyH576.js\":\"6771bf9986563aec\",\"/knowledge-medium/pr-preview/pr-1843/chunks/Preview-BV1m5LHM.js\":\"8085874e67e276b9\",\"/knowledge-medium/pr-preview/pr-1843/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/card-QAVyusQn.js\":\"2c696b07fc5e00b3\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-CpU23Yxy.js\":\"0d0e0741351e8571\",\"/knowledge-medium/pr-preview/pr-1843/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-B9TJN1tb.js\":\"25c78e2fa0e0eb26\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-async-BT0UTX_Y.js\":\"ed020206259b34be\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-B6YWlzFq.js\":\"65d0adc942e3adc0\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-CGwav3yA.js\":\"30da74d873d1ad01\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-CTDgPYHI.js\":\"2657864a786a617a\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-DDRwryvm.js\":\"89292e3c36ccdf92\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-DPrIvi4R.js\":\"a37288fbf131dac9\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-FfbWCrL0.js\":\"7aa5550c1e527ec4\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-_dh6N3N4.js\":\"1d89c3b4519baeb8\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server-legacy.browser.production-Dt_11WK5.js\":\"365e0ad8063baeff\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.browser.production-CpXMHaTC.js\":\"7bcde46cf823ac0a\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.edge.production-B4H5tzpy.js\":\"605627e322396293\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-vpfpbnpr.js\":\"018026a18914e5e1\",\"/knowledge-medium/pr-preview/pr-1843/chunks/server.browser-BppATYDk.js\":\"c588f1acdf4a937b\",\"/knowledge-medium/pr-preview/pr-1843/chunks/textarea-CMKppNlN.js\":\"522274c649f36248\",\"/knowledge-medium/pr-preview/pr-1843/chunks/ui-DbY1dugm.js\":\"957a5449d77c23ce\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-async-DnYoTG4E.js\":\"117a0af3381be428\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-smHdvteP.js\":\"915b850638bb69de\",\"/knowledge-medium/pr-preview/pr-1843/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1843/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/src/App.js\":\"c256c57571b8a706\",\"/knowledge-medium/pr-preview/pr-1843/src/appUpdate.js\":\"dc0016c502cae60b\",\"/knowledge-medium/pr-preview/pr-1843/src/appVersion.js\":\"c1b53fb11e81dd20\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/initialLayout.js\":\"86dfd482c09a370a\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/openWorkspaceData.js\":\"8c3d496bc4329f3c\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/resolveWorkspace.js\":\"279ecca65d243233\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/workspaceBootstrap.js\":\"33d970415f35fff4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockComponent.js\":\"99d5611685fc489c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockCrumbs.js\":\"5d597c93deaa7b94\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockEditor.js\":\"900e65f8083760f4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockLoadingPlaceholder.js\":\"5948fb9e3da79376\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockProperties.js\":\"0b1c417f3be92821\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockSearchPicker.js\":\"4e6c30e9f3075e8e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ConfirmBulkDeleteDialog.js\":\"15f2f3557ccf2548\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DividerHandle.js\":\"365d6f85be76fbec\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DraftEditor.js\":\"27dcd7c91ed8c5ca\",\"/knowledge-medium/pr-preview/pr-1843/src/components/GutterPill.js\":\"a0554010de01bf83\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Header.js\":\"d4db0e0c8563837d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/LazyBlockComponent.js\":\"09bd72b363cebc8d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Login.js\":\"7d7a00a085b4680f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ZoomableSurface.js\":\"dce5ac5a61c44701\",\"/knowledge-medium/pr-preview/pr-1843/src/components/editModeKeepalive.js\":\"9bd80289951216c5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0c85d57a3d688107\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"045d8d204e3296bd\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefPropertyEditor.js\":\"798c5a25dc7731d9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefTargetTypePicker.js\":\"5ebe6f8ca425c8b5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/SelectPropertyEditor.js\":\"058e97a553fb7ea6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/TypesPropertyEditor.js\":\"6df477f96494959b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/defaults.js\":\"52c6e385fb1b7473\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/kernelValuePresets.js\":\"bb58a1f357261610\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/selectablePresets.js\":\"aeac2737dabad72d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/typesPropertyUi.js\":\"f24e3ba7d2256271\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/AddPropertyForm.js\":\"62a4e93164852b6d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyPicker.js\":\"c205c6c444c7e18e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyRow.js\":\"c177cdc4b8135239\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/Rows.js\":\"977bf842c6667c47\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/actions.js\":\"1a784ed027b0f14d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/declarationOnly.js\":\"221bc6e421265e5e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/layout.js\":\"abfee0110fe7dcbd\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/model.js\":\"1d121c3bb94b5876\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapeUi.js\":\"bea3f443258ee291\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapes.js\":\"a7d790f17729c570\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/usePropertyEditingActivation.js\":\"adfa29587a596950\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/visibility.js\":\"b04e7838e6c542ee\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanelSections.js\":\"debf4e4c7d9ab4d7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockEmbed.js\":\"177ffbc098cce14a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockLink.js\":\"d9be6bb86d08123c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockRef.js\":\"f7a19b7939c510b9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/ReferenceLink.js\":\"d4ab1dff763096e7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuard.js\":\"89d90635b52e0af7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuardContext.js\":\"5ec6dc95a5bc05d7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/linkInteraction.js\":\"9cb2f60c1ab774c1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/referenceLayout.js\":\"0e23b887d6e6310b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/useBlockRefAncestors.js\":\"89ebab1699978d6c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockGutter.js\":\"ef1a641a5585cb4c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockInfoDialog.js\":\"b56c53dd88e07bb6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockTypeBlockRenderer.js\":\"b1e0ee3db32fdb62\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BulletHoverCard.js\":\"8af42b1e50677271\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorContentRenderer.js\":\"a3325f03281beae4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2ea338b5b7979645\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ColumnResizeHandles.js\":\"e6b600f2373c5c36\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"09b945fee2c4d3de\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/DefaultBlockRenderer.js\":\"cfae2773fab9d384\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/LayoutRenderer.js\":\"aa005694b3f3b193\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MarkdownContentRenderer.js\":\"e3e9269e047dc521\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MissingDataRenderer.js\":\"87c4a5babfcd2d6f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PanelRenderer.js\":\"ccecad1ba22f1310\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PropertySchemaBlockRenderer.js\":\"479c737d57895178\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/TopLevelRenderer.js\":\"0081e99e917bfc55\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockGutterMode.js\":\"ae00d2c1eb25fffe\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockTitleText.js\":\"4660f44989d42579\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/fieldCreationKeydown.js\":\"f69b45f5ebc49bc4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/layoutRootContext.js\":\"2c11f0d7c24c7e20\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/TypeChip.js\":\"a186d6129d9d34b6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/chipStyle.js\":\"562bc042a12e20a8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/anchored-floating.js\":\"f64e1eeb7ec0571c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/button.js\":\"b8d61eafe25c8e4a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/card.js\":\"cdcbcce0443adfa4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/checkbox.js\":\"6207c8f92b345b15\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/collapsible.js\":\"af164ada1611a38e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/command.js\":\"0b6547a430ae0021\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/context-menu.js\":\"3373602125df0b65\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dialog.js\":\"61a07f49b8b9653d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dropdown-menu.js\":\"3d7e340b7dbf6c57\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/floating-listbox.js\":\"bbbe4368c66c43c6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/index.js\":\"22b8e69f4f8846ae\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/input.js\":\"e54b389ca2f9549e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/kbd.js\":\"44fccfd4ced4c5ee\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/label.js\":\"bd4f39800dec8b87\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/textarea.js\":\"31762461565a295f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/useEditModeYieldKeepalive.js\":\"9decd53f4de57292\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/BootFallback.js\":\"856d39b3053e148f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/FocusedRowLazyMount.js\":\"1b7ca80d46e85485\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LazyViewportMount.js\":\"216f720398bb6d17\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LocalDbCorruptionFallback.js\":\"861f55038ab1af83\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/error.js\":\"7b83e93b28e330a1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/lazyMountRegistry.js\":\"5ffc286e65b84647\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/suspense.js\":\"16720bdbbd6f1f7b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/CreateWorkspaceDialog.js\":\"763e008adc88a03f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/PendingInvitations.js\":\"27a5a5d2596dc3d3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/SyncProgress.js\":\"533bba350de0aa1e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/UnlockProgress.js\":\"42a76d2215f6ec61\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceKeyGate.js\":\"11a01ffd5525b432\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSettingsDialog.js\":\"5ab301ddd3428601\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSwitcher.js\":\"b7bcb4b143455b9a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSyncGate.js\":\"40253936f72ef5a3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlow.js\":\"a0468c115736fdd7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlowHost.js\":\"d7b1ac10f8b454ec\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/EncryptionSection.js\":\"9a324b350b1cdec4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/attachmentPrompts.js\":\"90667aae0acc67c4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c6e4f578896bb1c2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowDeps.js\":\"6a57f6c23b6b8bff\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowStore.js\":\"8a40f1ecb1f98b6b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/flowUi.js\":\"5530c16d78a4ab7d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/useConversionRun.js\":\"37da5cec9291317d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/keyUi.js\":\"f42b15ad05edfac8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnKeyLoss.js\":\"ae606ff12a8e5b68\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnServerE2ee.js\":\"47ed806424a06459\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/workspaceUnlocked.js\":\"98b8e203b94c2642\",\"/knowledge-medium/pr-preview/pr-1843/src/context/backgroundSubtree.js\":\"68c208c99e5e9e0a\",\"/knowledge-medium/pr-preview/pr-1843/src/context/block.js\":\"97cdcd5ffcc1cf90\",\"/knowledge-medium/pr-preview/pr-1843/src/context/layoutWsContext.js\":\"151a0c16d59be30c\",\"/knowledge-medium/pr-preview/pr-1843/src/context/propertyDisplay.js\":\"eae29a14807ad855\",\"/knowledge-medium/pr-preview/pr-1843/src/context/repo.js\":\"e814032ad9626d2a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasClaim.js\":\"885efb7028dc2664\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasSeatNamespace.js\":\"b83f9355f21c7de6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockData.js\":\"339627b5e54f312b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockType.js\":\"001fdd481ec6979d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/changeScope.js\":\"a269f7ecda151989\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/codecs.js\":\"c81786210b4fd68b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/derivedData.js\":\"e79d686f530c8c16\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/errors.js\":\"0cee7a34fd5e68cf\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/events.js\":\"7f94934757e9c4d5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/handle.js\":\"500b094e6cf046e6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/index.js\":\"2f3e6a14fa5ba644\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/mutator.js\":\"4f12b9343f852976\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/processor.js\":\"9a093f9578b8cc98\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/propertySchema.js\":\"7a7b48e06d3351f8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/query.js\":\"0cfe79ed50a53b1d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/sameTxProcessor.js\":\"4f99940572935dd4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/schema.js\":\"500b094e6cf046e6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/tx.js\":\"500b094e6cf046e6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/typedBlockQuery.js\":\"94d4c846e8d04327\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/user.js\":\"653943716888fec7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresetCore.js\":\"31e8528e732250c2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresets.js\":\"3c3fc04888bd3a7d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/attachmentCleanerIOVerb.js\":\"5d230c2051582acb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/block.js\":\"b42193379fa3d740\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockCache.js\":\"cdeb45cd631df0a6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockId.js\":\"417c6540e68ccb13\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockLiveness.js\":\"5216f95d0b26b7ff\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockMerge.js\":\"b9f9d79dfb32cb8f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockSchema.js\":\"eb8f0634404c0a79\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypeLookup.js\":\"2359327b89c618da\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypes.js\":\"d395959a0a9c1bcd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/clientContext.js\":\"da973790d40f37fb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/dbFileSiblings.js\":\"82a1d1a8062df09d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/definitionSeeds.js\":\"e498b5fe5293f2cb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/derivedIds.js\":\"1d962d27092aaf82\",\"/knowledge-medium/pr-preview/pr-1843/src/data/drawnSubtree.js\":\"b05e6b5047f5a738\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facetBridge.js\":\"53293ecc80091251\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facets.js\":\"9edb18e6bd4a3b34\",\"/knowledge-medium/pr-preview/pr-1843/src/data/globalState.js\":\"4cb7b8e88e601505\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/aliasClaimRederiveProcessor.js\":\"99ff744e81c341a9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/ancestorBatch.js\":\"b22aa6d062a77763\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/blockTypeTypeifyProcessor.js\":\"8e6b88cc248a723d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/clientSchema.js\":\"d8b513dbe06561d1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/commitPipeline.js\":\"a4d77f0429ea9d5b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/devAssertions.js\":\"c5dddc7e0d6c1abb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/firstSync.js\":\"d370d54dbe0e9d5e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/freshInitialLoad.js\":\"31e18d2b5ade308f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/graphBackfillClaim.js\":\"08d83183278376ee\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/handleStore.js\":\"4beea97cb1a05307\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/idleMarkerJobs.js\":\"eb9eed5dc7a8bb66\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initialDownload.js\":\"9c7ca8933fa9b6c7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initializeClientDatabase.js\":\"384965293e4b6b6b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/jsonCanonical.js\":\"154c3d8f74d85fd4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelInvalidation.js\":\"1f6e704f4e13b1b7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelProcessors.js\":\"42fb6e8af4ce1074\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelQueries.js\":\"8aece4f1e46d54e1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/mergeTypeMembershipProcessor.js\":\"5a82c0fcd1f55abc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/normalizeReferencesProcessor.js\":\"7772d76aff3212c2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/poolInstrumentation.js\":\"c8859e5cd1466cae\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/processorRunner.js\":\"1a1b5dc1123e0eb4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyCellBackfill.js\":\"095c10b674987fd5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildMint.js\":\"05378dd125f97dbc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildrenProcessor.js\":\"9cf1c51d1461ac90\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bc306e6d164b91ea\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionSynthesis.js\":\"d90c2bf34cb9c24b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyKeyScan.js\":\"f5a4002e049bfe0e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertySchemaResolution.js\":\"72d35fd1c1f01724\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyValueEdits.js\":\"a7478970c03560ff\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/raiseProtocol.js\":\"ce36b86f2a7dc57f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/readBatch.js\":\"87d502eff4199dd8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/refProjection.js\":\"5d60ea37dd5098fe\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetLookups.js\":\"4e408d656d2ccf22\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetProcessor.js\":\"49ab2d5bd7a7a9b0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/replayMerge.js\":\"8c565ccb701f950b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/sqlBinds.js\":\"18160d34342a3cba\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"58592ef8ad34a3cc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/arrivalProcessors.js\":\"77581cc14709ae69\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/invalidate.js\":\"a30797c9218407ac\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/materialize.js\":\"c297a2fbfd0e0e3b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/observer.js\":\"c7b5ba38d3a8107f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/reconcile.js\":\"9833b570df3709e8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/timingMetrics.js\":\"4dd213518dea6850\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/treeQueries.js\":\"66f39940b33b8b0f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txEngine.js\":\"52bc2ddb2d383009\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txSnapshots.js\":\"da215e16db50056d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/typedBlockQuery.js\":\"ee2aee562d52cf53\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/undoManager.js\":\"59bc00300601d11b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/invalidation.js\":\"d1cf9c06f7e8adaa\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelDataExtension.js\":\"532b64cb213fb812\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelPage.js\":\"2befc683fecd4435\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelValuePresetCores.js\":\"0a60c248cd7f3009\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbCorruptionSignal.js\":\"ad8402f40c278deb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbStorage.js\":\"a32a6a683187046b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbVfs.js\":\"425d59cc27906c98\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localSchema.js\":\"1c027db72113c912\",\"/knowledge-medium/pr-preview/pr-1843/src/data/maintenance.js\":\"3780dcfbe9752131\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mergeProperties.js\":\"06d13fd7235b6b40\",\"/knowledge-medium/pr-preview/pr-1843/src/data/metricsConsoleHook.js\":\"df955039e6499bdb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/migrationsPage.js\":\"11a4cbb0914e40e3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mutators.js\":\"0ff27d693a069914\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKey.js\":\"738141082ae8f23f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKeyPlacement.js\":\"b40a0ad449a9a3dc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/outlineSurface.js\":\"21ada83e5668822a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingEditorContent.js\":\"f7e692f8af890c64\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingUploadsSql.js\":\"7e4dad1019617497\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pluginStateExtensions.js\":\"cec4c1e50b640a5a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/powerSyncLogger.js\":\"b4d57f400350742e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/projectorRuntime.js\":\"d56bd633bcc24ada\",\"/knowledge-medium/pr-preview/pr-1843/src/data/properties.js\":\"97e925b29a749368\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertiesPage.js\":\"f82811c2f9378638\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyChildren.js\":\"f09b97e9d6fd79d2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionFanout.js\":\"49010e0986d3c150\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionMetadata.js\":\"8eb21057e7f2e380\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionRegistry.js\":\"ecc1c3b21a67d50b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDisplayMode.js\":\"b7a269698f6ed023\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyRowCreation.js\":\"4f8e386b152893f4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySchemaCreation.js\":\"816c26d132687bb0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySeeds.js\":\"40f56b1414618a94\",\"/knowledge-medium/pr-preview/pr-1843/src/data/recentsPage.js\":\"3c57f9af1c85ee98\",\"/knowledge-medium/pr-preview/pr-1843/src/data/referenceBlock.js\":\"a0e2736bf03523cc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rejectedUploads.js\":\"1050cd1dc182a8a8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/releasePowerSyncConnection.js\":\"014c9fcd1382046e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repo.js\":\"d21b7bd59e4da37e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repoProvider.js\":\"068f701eade92edd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rowProperty.js\":\"087c1072ca170008\",\"/knowledge-medium/pr-preview/pr-1843/src/data/searchFilter.js\":\"a654e771290c4805\",\"/knowledge-medium/pr-preview/pr-1843/src/data/seedIdentityLedger.js\":\"4224bd83440ff2a0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/stateBlocks.js\":\"52797bf6aaf4624a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/structuralEditPolicy.js\":\"e0265c5f1efacc9b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/subtreeDelete.js\":\"a352b4541a4bd02a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncStreamLock.js\":\"6e6b82895daa7233\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableSqlRecognizer.js\":\"751071f191896b0b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableWriteGuard.js\":\"69033c18b99c27e9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/targets.js\":\"3a4af356391ce677\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeColors.js\":\"361ac262bb47f165\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionMetadata.js\":\"5e82e7c61065f0ef\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionRegistry.js\":\"ca641568fb1e0172\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeExtraction.js\":\"60b56633aa0e0542\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeInitialValues.js\":\"2ea5a5d8b3ed05c5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typePropertyGroups.js\":\"5c2c59b06c3d02ea\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeSeeds.js\":\"260038474c640277\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeTagger.js\":\"736237d080655f37\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typedRecords.js\":\"866f8bdcde5847b4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typesPage.js\":\"370b2d725d1ea5e6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userPrefs.js\":\"45f04c36e95f2c3e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userSchemasService.js\":\"6cc53a3c9e0f545b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userTypesService.js\":\"d69e83fdd44ba576\",\"/knowledge-medium/pr-preview/pr-1843/src/data/valuePresetRegistry.js\":\"63201bd7e08fca35\",\"/knowledge-medium/pr-preview/pr-1843/src/data/visibleChildren.js\":\"a879db502d20087e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceConversion.js\":\"02315aa9047c333e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceFirstSync.js\":\"255c9864ecd696ec\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceIdNamespace.js\":\"4030130c00c1282e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceSchema.js\":\"92550979e70342c2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaces.js\":\"9e47537e3bcd4417\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadLog.js\":\"3b2a8084566d4d7c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/BlockPasteShellDecorator.js\":\"043b4484a3a8e284\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/atTrigger.js\":\"a52a183e751204e5\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/autocomplete.js\":\"b306fd13b84b1b76\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/codeMirrorExtensions.js\":\"e20350846af8d842\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/contentFlush.js\":\"2cd02cb1ccbdd015\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/defaultInteractions.js\":\"de7a2787779f779f\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/editSettleSignal.js\":\"8ad8a19fcb406618\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/insertImage.js\":\"9d4a4b81bf62b84c\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceCompletionRange.js\":\"25f02dccc3f80023\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceTargetTypes.js\":\"89e389450b7967d0\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/syntaxContext.js\":\"77a92b745ddd9cac\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/triggerMatch.js\":\"b8f1103166fe4ba1\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/AppRuntimeProvider.js\":\"8cb515e7852fe5a4\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/BlockFocusShellDecorator.js\":\"3b5cbf3999371e9f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/ExtensionRenderBoundary.js\":\"1be22e355263e379\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/PanelContentRecovery.js\":\"ed3e821edc4a9301\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/apiCatalog.js\":\"3604c19940ab2755\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/approveExtensionHere.js\":\"b98172328c2d4451\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/armedCutAppMount.js\":\"777fd0bae2de2515\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/batchableKeyedStore.js\":\"5e8dbce10d1ddc25\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockInteraction.js\":\"570c003419454d6f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockSelectionAction.js\":\"fe81ace2f99157cd\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compileExtensionModule.js\":\"2dd4f6d821065337\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compiledModuleCache.js\":\"5da7c6fbc1244550\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/continuousGestures.js\":\"b437bcc566f8081d\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/core.js\":\"31b91416877d8a30\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/defaultRenderers.js\":\"16f00439a82eb8c5\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/definitionFanoutAppMount.js\":\"c5bbcaceb4753900\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dialogAppMount.js\":\"7a46c355c77cf8b8\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensionSeeds.js\":\"2fed1e64d0484498\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensions.js\":\"c3c5758b58d8dab6\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/exampleExtensions.js\":\"2b5b479eba929f3d\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionApprovalStatus.js\":\"1918ba5c9225810b\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrorToast.js\":\"24aa0d1ec1b51521\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrors.js\":\"67a599eb130dd883\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLookup.js\":\"420af0a27a67663a\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionToggles.js\":\"e3f6a68832de9601\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionUtilitiesCss.js\":\"0d411e1032c3f495\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/kernelPageDeletionGuard.js\":\"1109ccab8eac34a5\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/liveRuntime.js\":\"f4112ba7a56bde2a\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/openExtensionsSettings.js\":\"78a071a9664ae83d\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/overridesCache.js\":\"56aa4e064fc80907\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/pluginIds.js\":\"6cfb45bcb3be0dc1\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/processorRejectionToast.js\":\"788fd7ce2e200eae\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeActions.js\":\"d56c94c986aa545c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeContext.js\":\"25d6ace5934400e2\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticAppExtensions.js\":\"521b3fdfa5bd90b4\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticDataExtensions.js\":\"49c095a4887a5ee6\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/toastAppMount.js\":\"d4d7166dca6c19a3\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useOverrides.js\":\"36f58bdde9a010a0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useShortcutSurfaceActivations.js\":\"281e1a1db934cc98\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/discoverToggleTree.js\":\"9fcb19041e94a28a\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/facet.js\":\"55f7b1c0ea316f0f\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/resolveAppRuntime.js\":\"e217a1cd1c641eac\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/runtimeEvents.js\":\"f59aba30bb7fae27\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/togglable.js\":\"8762b904bf1626b0\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/variantFacet.js\":\"3b0e6c741df8afec\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/verbFacet.js\":\"c7c01ee028cfd02d\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/block.js\":\"0c6c96c4bc9f0cf8\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/focusedChild.js\":\"575545afe3f8c8fa\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/propertySchemas.js\":\"8398f02c02e3e9d0\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/typeRegistry.js\":\"713e9785ee6bdf1f\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAncestorCrumbs.js\":\"aab02ab006cdd88b\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAutocompleteListbox.js\":\"75596c1e8ebc8282\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedSearch.js\":\"37c42d49b7fb64d3\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedValue.js\":\"28982e73a7649399\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsFocalRender.js\":\"3828be908a731fbb\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsReadOnly.js\":\"0cf6631927ac4ac6\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMaterializeBacklog.js\":\"38bf363a7eb38578\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMinuteClock.js\":\"044247c4fcdce2f9\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePanelLayoutProjection.js\":\"386bea7283e92b38\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePendingInvitations.js\":\"0d0d1193050c01c1\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRendererRegistry.js\":\"67185f0bfd79ba56\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRetainedFieldRows.js\":\"0fc5dfebbc7b70f1\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useWorkspaces.js\":\"186472cacd7662bb\",\"/knowledge-medium/pr-preview/pr-1843/src/lib/utils.js\":\"268c49a21d14e944\",\"/knowledge-medium/pr-preview/pr-1843/src/main.js\":\"545ff5e1cf209e08\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/MarkdownImage.js\":\"9128b0f9e2dc0fae\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/blockSeparators.js\":\"02f517b8023a9839\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/context.js\":\"5fffc05d128ee096\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/defaultMarkdownExtension.js\":\"d886364d53d5bbe5\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/extensions.js\":\"1dd87c8e2e889237\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/renderMarkdownHtml.js\":\"b44c0cce8294edd6\",\"/knowledge-medium/pr-preview/pr-1843/src/minimal-editor.js\":\"d8aa8b27dc5935d5\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/armedCut.js\":\"4c4c9ad832559da7\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/captureMediaVerb.js\":\"c2cdc01882aa49a6\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/clipboard.js\":\"a38ce5940cba1bd8\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/decision.js\":\"0f5d54552af951a2\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/operations.js\":\"576c95a4a76ed687\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/AccountHeaderItem.js\":\"128c6f53cc14d16d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/index.js\":\"5454b9ac607e1a96\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"216cff6340b83005\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askAgent.js\":\"051a37777bb9e2b1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askedStore.js\":\"7aa76aa715ba5191\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ebba681fd529406c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/chipState.js\":\"61ec63988ee245d8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ddbcf7fe6ffbe66a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/index.js\":\"494b361eb1c678e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5590f230802b734c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/schema.js\":\"5d720bb3ddf4cd79\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e68cf4f192e88762\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c964574f48a795e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/addMedia.js\":\"c9278fab49669ff5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e9e778d127f1b2ef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/block.js\":\"02bd75f053d885ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/context.js\":\"1cc559b47e8bc24b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/displayIds.js\":\"063eb1a89ccc1ec7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/index.js\":\"c682d96d10d2be21\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/outline.js\":\"e77ed9540e32942b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/properties.js\":\"162ff644e5cee4ac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/refs.js\":\"4734e665dfda94d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"24dc56945725c127\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/search.js\":\"7d86c1c42bfae75a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/shared.js\":\"223631260ea03fcb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0d5c10680c881fcd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/text.js\":\"8041f2d2a67fd502\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentWrites.js\":\"35d7251fa462d845\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/authoringCatalog.js\":\"37c94a8580a62d38\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/blockRefTargets.js\":\"833c11f018acb72d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridge.js\":\"d7dcd6e3e2182676\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridgeLoop.js\":\"c7be15f88dc51ce0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/changeHistory.js\":\"37fa044576e2335d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commands.js\":\"74304b527b1a01dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commentsCommands.js\":\"37d0a17b32171b77\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataExtension.js\":\"80c09bc5f4f2045c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataModelGuide.js\":\"099167332137ece4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/describeRuntime.js\":\"1bd88af12659081d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/extensionLint.js\":\"980ca15df9b330e5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/grainAudit.js\":\"559264f89d376b07\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/healthCommand.js\":\"05b04d88483fa4ba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/index.js\":\"64fa3d5db967cc7e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/presetIdentity.js\":\"506d1431baab50d6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"093f79fcfb1d79c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/readMedia.js\":\"0406c799ee8c2795\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/schema.js\":\"f36fbd9b6fe9447a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/serialization.js\":\"3f2f5fecb69886cf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/targets.js\":\"82e388f2bf4d3e89\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/tokens.js\":\"4f8766414c9c2cd0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/watchEvents.js\":\"eb89663fe5fdbc7f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/workspaceGuard.js\":\"d97c5c018ee9a290\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/writeCommands.js\":\"fca41a7c4d4f91cc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/AliasCollisionToast.js\":\"48d293ea0bcee440\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/DuplicateNameBanner.js\":\"7e9877a2cbf274ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/collisionMerge.js\":\"d8aa009dda5059be\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/dataExtension.js\":\"46ac4fa81f846ca8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/index.js\":\"da5af0480a51b1bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/mergeCollisionAction.js\":\"c0573544a74647c3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/pageStyling.js\":\"e467f8b62d5043f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/rejectionToast.js\":\"45ac33cad7afafd6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/syncProcessor.js\":\"6017c81826dbb8fe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/actions.js\":\"109681130ffd59af\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/addComment.js\":\"fca34837d1001b6a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchor.js\":\"c66c8cd6a5531ea8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchorState.js\":\"75c2dc7032938e44\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/commentLinks.js\":\"4da808c1f21d0a66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/confirmThreadDeletion.js\":\"4abf4886e78a967d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/container.js\":\"b97af2bebd83b4df\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/dataExtension.js\":\"836b8ef8cba24348\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/deleteComment.js\":\"80597aa25aaef651\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/highlights.js\":\"4a964a66aaaa833f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/index.js\":\"08d569d812374bc0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/linkedCommentsPill.js\":\"c1e12bff8ff3cd22\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/margin.js\":\"c9310dc95a0d91dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/marginSchema.js\":\"9dbb068113fb67a8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/newComment.js\":\"ce098c78a3b79a1b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ownThreadPicker.js\":\"1480f63ade7fb0e2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/placement.js\":\"13906fe7c0f7c5f0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/queries.js\":\"f7c2c8091b3644f4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotePosition.js\":\"56363d0f368a9801\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedIn.js\":\"00cf5ada24f3f7dc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedRange.js\":\"223d510e56a8d3a4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/rangeRefs.js\":\"c7880c7054293088\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readHighlights.js\":\"050077b03e3be80a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelection.js\":\"30c2dbcd4104b93e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelectionUi.js\":\"97a4f500ecf45f93\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/reanchor.js\":\"c72eb522bcb96f40\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/schema.js\":\"88605545335e87d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scope.js\":\"f2d33bedea3af539\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scopeThreads.js\":\"662fd0f60570fe0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/splitRetarget.js\":\"2dadb9e07bcc4186\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestionCard.js\":\"194f91e21e224708\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestions.js\":\"8f0b887f6759a8c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaries.js\":\"75a0093b9f26c9da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaryBatch.js\":\"4603aa9e753e745e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/surface.js\":\"3144ad720d715757\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threadNavigation.js\":\"0b8d24d1dd6a83b3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threads.js\":\"d6a03f6634b3e194\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ui.js\":\"764cdf5793a2f87a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/uiStore.js\":\"d7945902664336dc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/appIntents.js\":\"05b64cd26479401c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/index.js\":\"2927ea6d813c1c40\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/index.js\":\"c35e5f1b090ae954\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/status.js\":\"17d68b117ef16557\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0c6b9f4c288c14e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaBlockRenderer.js\":\"6c4fb23e9c1d0250\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5d3a69097f533a6b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaUploadReconciler.js\":\"1e4a4c16a66b6c19\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetDownLane.js\":\"6445db21276eec48\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetResolver.js\":\"c27f9c3cac8f35ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetUpload.js\":\"c2daf2269ce0dabb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/attachmentCleanerIO.js\":\"5d6941f7ecbab0cb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c213c3b4715a2134\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/blobStore.js\":\"b49001f3a9fe5399\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/byteStore.js\":\"8b668eaf579826ac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanerIO.js\":\"433f4caf7dbe5b5f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanupAttachments.js\":\"d6bdff8917e553cb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/dataExtension.js\":\"0623fc6f31394e8e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/downLane.js\":\"95d2e55fac292740\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/index.js\":\"31ae3b7f56735ff6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/insertImageContribution.js\":\"f1121c6a1dbda612\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneArming.js\":\"61e6cedca625effa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneLock.js\":\"c2c526cd0b61cd2e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaBlock.js\":\"f47bd16fad7a71b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaCapture.js\":\"40bf54568c5fc952\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewers.js\":\"04565138b60b1277\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewersFacet.js\":\"0ad2ff631b75d142\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/pasteCapture.js\":\"b8180c827655f53d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/resolver.js\":\"076eca8de86218e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/retryUploadsAction.js\":\"8f47cab3c09bbdcb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/storagePaths.js\":\"7b55f7d2bf67bc19\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadDrain.js\":\"91b56be7ecc8ec3c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadLaneStatus.js\":\"62ec2215ecfa037d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadReconcile.js\":\"dee5b504f1123785\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadRecovery.js\":\"838d25cfd154582e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadStore.js\":\"3d97ff302dc4e330\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/useAssetObjectUrl.js\":\"5ce7507777ac5d02\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e5c81002e675da6b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksViewSection.js\":\"bacb354308caa841\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/facet.js\":\"fc89fa7b4fab9565\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/index.js\":\"70e5d4171b65bb06\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/prop.js\":\"210159dc020a0acc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinkFilters.js\":\"7a737094044838da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b4eb1e098bee1a2b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BlockEntry.js\":\"4773f6ee249f616b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/LinkedReferences.js\":\"18e83c9440e73258\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"cedd35b5f3919f43\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dailyNoteDefaults.js\":\"ed61ca9957865b54\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dataExtension.js\":\"387b7cf4035e97b3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/edgeExclusions.js\":\"e0c87c06caa75532\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/filterProperty.js\":\"b0f077e076c8849a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/index.js\":\"b068378cad192a74\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2f825246803af0dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/applies.js\":\"35e02de5b4129978\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/countQuery.js\":\"6bfd9b72e90550e3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8a3b9ee4dc0eedb4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/index.js\":\"d5da2cb5bd69da68\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"af81e31f8458422d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/presentationInvalidation.js\":\"d2b8149c491111f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyEditorOverride.js\":\"ac916c01a4527fe2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyFilter.js\":\"c60bb3c8dab3d839\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/query.js\":\"ba416c17b69efd8d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/resolveFilter.js\":\"0c16b7d88603e451\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sourceBatch.js\":\"5b8aec5e7d9d9711\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sources.js\":\"4b157389f88ef579\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useBacklinks.js\":\"d903dcf89470ad0d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b7ae33a902b11843\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayCelebration.js\":\"6b56e756ec1948ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayOverlay.js\":\"098b4dbea2eb3a90\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/gate.js\":\"42e13f82ef2a389c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/index.js\":\"9680b5b8a1c41eeb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/wolfTheme.js\":\"e484ae724e98ad0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/BlockDragLayer.js\":\"cbe6c4bd4f9a814f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dragController.js\":\"ffc903a746be0a6c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dropTarget.js\":\"595530ab0733e650\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/index.js\":\"9d3bbed82c2720ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/projection.js\":\"053a07b11fc5351d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/BlockMetaCard.js\":\"43c47f6b3f3ee855\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/index.js\":\"c5ad66b017c94ea5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/AddTagDialog.js\":\"d661faf33a4bdc26\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"cf9e64cf8d8b461c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/TagNameIssueHint.js\":\"afb1e99b2cb4923b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/addTagAction.js\":\"8e2c0955c2a264df\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/appendTag.js\":\"7900c5efd5c1f359\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/config.js\":\"4c3a82e3660ef2a4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/dataExtension.js\":\"81993a45e35d0eda\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/index.js\":\"0c041154b1d66114\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/propertyEditorOverride.js\":\"f8b9c4936e5ef6eb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f453eb538a3ccc3f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"7ad577aa4d763130\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b4cba047124e2e5f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e37ea05bdc42d4ae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d48eee6dbe645bf5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/index.js\":\"d573a02c730085a9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fca08d5dc96149d0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/CharacterCountItem.js\":\"af9f17404a90ece3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0fc536783ee40978\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/actions.js\":\"aef87505a38cd926\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/blockType.js\":\"c1e5f5c1df506be9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/charCount.js\":\"1c20d3b6ea019f40\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/dataExtension.js\":\"f63332869b9933b5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/index.js\":\"21df9583049d0c29\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/profiles.js\":\"8ee3553cc5e85e7e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/properties.js\":\"39d56fc864418627\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/textCounts.js\":\"fd3647598b7836f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/colemak-keybindings/index.js\":\"fac264f40f3aba3d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/CommandPalette.js\":\"840e66dd69751947\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/HeaderItem.js\":\"cfa339513c922ac0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/context.js\":\"f1d23910826f0121\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/index.js\":\"f989c274803a2be3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/selection.js\":\"a3c2667726d0ea25\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/toggleStore.js\":\"b05ca79c7a82698d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/useCommandPaletteActions.js\":\"218d174ca7be2b5a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/ContributorBadges.js\":\"bd9072c4b58570c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/author.js\":\"fd4a1073345c8338\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/codeMirrorExtensions.js\":\"5effbbaf080859a6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/dataExtension.js\":\"b795355efb23397a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/index.js\":\"323ab4baa1711ece\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/mentionAutocomplete.js\":\"8b8f338b74da3546\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/processor.js\":\"5b0949eb3eadb1e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/profiles.js\":\"1e7c74400f930f1b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/queries.js\":\"3236044fcbe61426\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/schema.js\":\"24d9bb2578e1fdfa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1468e5f9a8b2ebc0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/followOrigin.js\":\"fd52fdb0d861242e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/index.js\":\"2f0e14ddc281eb1c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"caab9bdfc7e26184\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"2f71e529101eab76\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/CalendarGrid.js\":\"12f055ca5de9a18e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DailyNotePicker.js\":\"770f48ac0e34690d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c87abe6b5bb89765\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateNavDecorator.js\":\"e666bd74bab30be1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateScrubOverlay.js\":\"fd52614b3cabb1ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/HeaderItem.js\":\"05114c2f70cdf8ef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/ReschedulePicker.js\":\"8b572e3cceb7b506\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/SpreadDatesDialog.js\":\"113479be75c7fc6e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/actions.js\":\"f706e3cccc2aae32\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/blockDateAdapter.js\":\"771a5ed746b64b6a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/calendar.js\":\"6f522a8f2bdbb937\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dailyNotes.js\":\"ca8e7976415563c3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dataExtension.js\":\"0aa1fbe4d3a2860d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubActions.js\":\"de709210e6977f2f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGesture.js\":\"ab7427a595e40ce2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7372bbf94b8a94bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubRecognizer.js\":\"2a1c4e53f91e2e47\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/deletionGuard.js\":\"d9c4c49ce20aa7f8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dueQuery.js\":\"c008a092cdcc9a02\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/index.js\":\"4ada3f28af86e74d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/landing.js\":\"63aeaf614f9109d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/localSchema.js\":\"020578a03e1eaf0c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/referenceDateAdapter.js\":\"9b89237d4ab0b05c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/rescheduleAction.js\":\"06c9a5c18a8f9937\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/schema.js\":\"a882bd15fbf18081\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadBlockDates.js\":\"0f2e436cba9072ac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadDatesAction.js\":\"76ed58fc78d6abda\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/today.js\":\"cd5d1d436a129bef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b35dec007d052883\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e9a9cfb37b779291\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/audit.js\":\"e24755d2bf6618ad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditAction.js\":\"3c09a6bd656ed354\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditRanges.js\":\"9961de080daddd64\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/diagnosticsSource.js\":\"31ca4be2b24a17ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/divergenceScan.js\":\"3d93ed355cf75866\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/index.js\":\"dfd8c0cb28c0e3a0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/propertyChildrenChecks.js\":\"fba25e93b27e26e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/referencesMirror.js\":\"876f2ef79e72f1de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/rowJson.js\":\"28845c4ccc314e0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/schedule.js\":\"02246f7f0ef2d14b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/store.js\":\"4e84f9691ee358d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/action.js\":\"f66f21c910a18681\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/index.js\":\"86b782eadc12501e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/plugin.js\":\"372a75c52aa6fa66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ad70a4e6fb38b5da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/actions.js\":\"d9734f6fe4b1d27a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/changeMarker.js\":\"7314ddcf7519bb8c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/diagnostics.js\":\"fbea4fcb7672e64b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/fileSystemAccess.js\":\"92dddb76ab779acf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/filenames.js\":\"8b56f3895811fda7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/index.js\":\"004249d684634359\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/mirror.js\":\"87a55ff8628526d6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runLock.js\":\"b1437fbe016bdb19\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runtimeHealth.js\":\"0a8aa8faa9736d87\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/schedule.js\":\"1bcb5dee259d4e15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/store.js\":\"1f71b092f5b22181\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/index.js\":\"42a1947af5619bd1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/themes.js\":\"f4b4b676c89fb243\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/facet.js\":\"db7fa21e1521f733\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/useDiagnostics.js\":\"8fffecaeff15e68e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/dismissals.js\":\"c069bb45d8935bb9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/index.js\":\"341a6167b363b949\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/status.js\":\"71d5c0102cb5213b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/store.js\":\"b8c2bdc8f97f8fe3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4089615b1397b90a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsSettings.js\":\"edce884eed1d0768\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/actions.js\":\"4a51bd6f8b346dbb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/config.js\":\"2c49108d0343d4cf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/dataExtension.js\":\"6a0972663097f7ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/effect.js\":\"39cbdf5c237dd39c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/index.js\":\"83e3743bef744091\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/propertyEditorOverride.js\":\"03b2ef8810d8a823\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/useToggleTree.js\":\"2d5fc26e5106e719\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/ExtractTypeDialog.js\":\"bf5a5205f5235323\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7b0bd0b863e31c35\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/PropertyShapePicker.js\":\"a05b92aacc61439e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/action.js\":\"75318b0829e22a41\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/index.js\":\"a6620ab6877be732\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/FindReplaceDialog.js\":\"2871006c96c369bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/HeaderItem.js\":\"bc7010c3c6bc9d4e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/dataExtension.js\":\"9c017eb8c8f77d57\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/index.js\":\"18e8b47152feeb9b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/search.js\":\"efec6bb192603215\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/toggleStore.js\":\"43957341a1c2afe5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/LocationPropertyEditor.js\":\"80c41389a1e64024\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/MapView.js\":\"9f5023f9c474fc7d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/blockTypes.js\":\"18d643d9744a6190\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/codeMirrorExtensions.js\":\"bb5f42b3ff36eacf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/createOrFindPlace.js\":\"b1f7835d628b0b98\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/currentLocation.js\":\"3e13f54aef1b8a58\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/dataExtension.js\":\"48f42a2384eb9319\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/geoContentDecorator.js\":\"1a09411b2ce8a720\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/googlePlacesClient.js\":\"86c52b11d2b8d71e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/index.js\":\"b19d1b5a587616dc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/locationsPage.js\":\"5fa10041672f1b0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/mapViewport.js\":\"a49a7ce134ad5fb8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/pickCurrentLocation.js\":\"fad561d1fed098e2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeAutocomplete.js\":\"7a97120c3af72ac7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeNameCollision.js\":\"e1146adab6c289a4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/properties.js\":\"a410cf7226929c75\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/propertyEditorOverrides.js\":\"75a447c6705c767b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/query.js\":\"3873e7e4afc55a0d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/usePlaceSearch.js\":\"a503f9fd6de09265\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1fbe1f733401fd9b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"306c4358bcc7b750\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"35806f87926d8e8b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/config.js\":\"52a46f673737cde8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/dataExtension.js\":\"7d093feb04428f87\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/facet.js\":\"ad56e431b834eb90\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/grouping.js\":\"a9726ba6e1bb3725\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/index.js\":\"3868e9c4f4aa701d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"0e88ff2243383bf2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/query.js\":\"4963d549bb32af2c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/resolveConfig.js\":\"608780e786fa7679\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7e9aae902db36f61\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3ca0bb7e91bd7f68\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlDocumentContent.js\":\"371fea2907fae3bc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlFrame.js\":\"590ff0752202c1ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/actions.js\":\"b10585583074d259\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/blockType.js\":\"60058ce7b64c2162\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/confirmRunScripts.js\":\"8a91af6f83bfadfc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/dataExtension.js\":\"c0be02ed416007bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameAnnotations.js\":\"437626fc1ba3af89\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameDocument.js\":\"2d3f693cf1871563\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameTheme.js\":\"18011c94e8e7cfe1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/index.js\":\"d959d0aca260f9cc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/scriptConsent.js\":\"5e034e3d23ff6e5c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/sourceMap.js\":\"10761bf198a1af35\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/useDocumentScripts.js\":\"76e628941d2bd1f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/index.js\":\"c6dd574f7b17a29a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/record.js\":\"8e9e30ff1122dc1f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/recordStore.js\":\"5445a24d8ebf25bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/responsiveness.js\":\"30921380b8c986c4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/schedule.js\":\"0386680f9f5ff3d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/sessionContext.js\":\"f5aa2bdfca6b9fe2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"122b5d7d10efabae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"40d2d304ceae9716\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/actions.js\":\"2d7c04e15a2373c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/config.js\":\"77fa8b15fe45caed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/dataExtension.js\":\"5379a8a44293b750\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/effect.js\":\"fbb60a69fd45e7b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/index.js\":\"35d281abf8c05c2d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/keyCapture.js\":\"b20566b8fb521185\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/overrideStore.js\":\"ea484144e016df25\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bb75e65285df1491\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/HeaderItem.js\":\"c12dc3d39d23bd24\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/LeftSidebar.js\":\"93677793050c9c55\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/actions.js\":\"1e2896379be157d0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/facet.js\":\"040467f735662fa6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/index.js\":\"a56bac357d2e108f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/shortcuts.js\":\"7dbeecf400897472\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/toggleStore.js\":\"85f78a9c1057b787\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/MergePicker.js\":\"7cb5aa26bbda37e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/index.js\":\"8d80419d3c6bd03c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/mergeAction.js\":\"65c616534da7babe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/strategy.js\":\"3db86437c99be003\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/Button.js\":\"fe225eb0827f8979\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"860b2df8b56799f3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ab68e69e764c8842\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/facet.js\":\"9d72a5dddbfc2ffa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/index.js\":\"5be81e73c148bed9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e3bd36c3b8dbb37b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ab5cad13aca6cbcc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"4d8100d7e4608459\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/facet.js\":\"0c5d26c64171b4f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/index.js\":\"471119cd36f275c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4fb5b09168a28e6c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/blockSubtreeMembership.js\":\"30a27f78ea12b27a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/contextMenuItem.js\":\"7f4dd19f71d5437b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/index.js\":\"ba06ff55a3b1a0ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveAction.js\":\"647035cb0a4b441f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveBlocks.js\":\"549e4edf0b6e5774\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/selectionAfterMove.js\":\"7c06bdf757236241\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/TutorialBanner.js\":\"837c1d5534815c3d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/action.js\":\"fe85b0f36cb55fc9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/bannerDismissal.js\":\"2932608b502650e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/documents/cheatSheet.js\":\"d8b12c12d497b10a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/index.js\":\"4dbc0ac108975b4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/keys.js\":\"d9471f317b373c19\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/landing.js\":\"10ff2787736f879d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/outline.js\":\"c57a13959e421389\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/seed.js\":\"8d9bb08f2ab89d8f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/PerfTrendDialog.js\":\"52c8216f073ebacd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/analyze.js\":\"66fbe1f981fca123\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/diagnosticsSource.js\":\"64d9d83e0d201bdd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/index.js\":\"8fb9306ea4a256cc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/load.js\":\"5504d78330b6ad6b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/monitorRun.js\":\"948e5fb265d0743e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/schedule.js\":\"cc27683f4b3d5d4c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/series.js\":\"4fb0863f3468e4d7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/store.js\":\"91aa8e01939f9888\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/trendAction.js\":\"26ceed339b5bf8fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/verdict.js\":\"f2a096208169cc98\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/clickToEditAction.js\":\"e1f0c467c22663c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/index.js\":\"ba86d4d28530826d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/interactions.js\":\"0f5ff4eb53c6c142\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0f0ee826c9b23df2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGate.js\":\"03208de1e539907c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGateDialog.js\":\"fac29bf58b46d2c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/action.js\":\"f5ac631f09eb6b15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/index.js\":\"a03ed02184e8a08b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/localRunMessage.js\":\"842b419b50915288\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/plugin.js\":\"25496271ea24e220\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/progressReport.js\":\"e2785ff81d1462c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/sweepProgress.js\":\"ec06004064f66d95\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/FieldRowRenderer.js\":\"d7414b71bba92ae7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/ValueRowRenderer.js\":\"64085a4797a71bb7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/actions.js\":\"234d8d9417adf5d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/autocomplete.js\":\"fcc7f9fa71267145\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/fieldRow.js\":\"a42fe66678ee458b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/index.js\":\"d07561cf37251ba7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/referenceWarning.js\":\"b45115627367ad08\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueAutocomplete.js\":\"8adabb5f015d859f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueSchema.js\":\"0f44b011f30be213\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/HeaderItem.js\":\"3dfb03b140054956\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/QuickFind.js\":\"8282be5d6d4bb950\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/index.js\":\"f6ec2d9a3bd9d8fe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/recents.js\":\"e3579d874519005e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/resultItems.js\":\"4248078102b2bc85\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/selection.js\":\"0c4f0ce83c187961\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/toggleStore.js\":\"f6250c0c2dd6cd5c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/HeaderItem.js\":\"159fdf69c2bb7696\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f5c8a8214e5a5cb0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/grouping.js\":\"18386064c681be1a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/index.js\":\"fdac2946377e8589\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/target.js\":\"d0bb6ad3031e7f36\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/codeMirrorExtensions.js\":\"dd94d3497667a434\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/contentPrefill.js\":\"bbffc136d89b9614\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/dataExtension.js\":\"21d17623b1753374\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/index.js\":\"65d31b103b0e30ee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c58d57e602003eef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/invalidation.js\":\"c46ba2abceeda253\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/localSchema.js\":\"df4e00fb79e5e07c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/index.js\":\"0bc6bb317028ec81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"31fd70aafa352e94\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/index.js\":\"b79a432670649470\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/referenceNode.js\":\"6bb95f6fdc7fcb9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e83f1d93249ad2ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"38a018f6431cda20\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/index.js\":\"fef11270ad3696ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4ca64b614443bf4d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fdf9150d9eb5a940\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/mergeRetargetProcessor.js\":\"10fadd655dd85a9a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/parseFence.js\":\"eb6718a197869218\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceParser.js\":\"cba5b02f1a40501e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceProjection.js\":\"aafbf111e0a7dfa0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referencesProcessor.js\":\"5c1087f4dd923123\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/renameProcessor.js\":\"b0fe3f71d67f8f80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/spanReplacement.js\":\"50aba8cf78e2cdff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/htmlToOutline.js\":\"56f09de31f13de07\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/index.js\":\"666ec894c773a69c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/normalizeClipboardDom.js\":\"eee8681c7d2fbd7c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/pasteDecision.js\":\"cc2a40917c47618f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/action.js\":\"e4ad1c228ab5a1bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/blockIds.js\":\"7edf50b45522b344\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/content.js\":\"9a221890e6817d48\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/effect.js\":\"ccc58d66b2150309\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/ids.js\":\"bbffb169aa38c4c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/import.js\":\"b98a24b2569f774c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/index.js\":\"54bac1432676d25e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plan.js\":\"e56d423fa5a809d7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plugin.js\":\"fb2f86a32dbd9a77\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/promotion.js\":\"7f0347f72ebc182a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/properties.js\":\"4e62a82052e365f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/references.js\":\"0e451cb424396891\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/report.js\":\"c20d19492ead8533\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/roamMemo.js\":\"f36f21cdc89c8dfb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/runtime.js\":\"dab5c930350670fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/schemaReconciliation.js\":\"311b0cb32dd0e7d5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/srsMarkers.js\":\"d6f34788f9642c4c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/todo.js\":\"9442ec1d3dbfc5d1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/typeCandidates.js\":\"f06da88f10b9c16b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/types.js\":\"4c53a7493fd72511\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/index.js\":\"15ee20d607dc850c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/store.js\":\"7ebe6dac08416b1b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/HeaderItem.js\":\"801553c257422468\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"072e9fc20ba322d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/index.js\":\"c0e8bf57326c34ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/model.js\":\"86a80af3bd533804\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/toggleStore.js\":\"8f62883e672c26ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/useKeyInspector.js\":\"a398a001a05508e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e32bf71f3e077e65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/ShellDecorator.js\":\"c9be02b0b810b3f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/actions.js\":\"2f72a9310cfb592d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/exclusionsFacet.js\":\"cd2ba2bef8f2faf6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/index.js\":\"91df5d8a29a9e1b1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/shell.js\":\"1abc8eff470873ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/surface.js\":\"3632269b7c98ef39\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/walker.js\":\"9196b743d60e1f71\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e58613ac6d846cb1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/dataExtension.js\":\"28bc56615e8b6472\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/index.js\":\"ccf4c56675009af0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/indicator.js\":\"fbea0508dc896bff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/moveSrsState.js\":\"05db58a0729b1685\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"df0224852d2d8833\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/scheduler.js\":\"92f4f8b00d45fb42\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/schema.js\":\"08e598f1d714f944\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c18beac8c92d9dc1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsClipboard.js\":\"29f5e688afedbdb0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a104be4da0751370\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DailyNoteReviewHint.js\":\"dc01534bf5ed5737\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DeckPicker.js\":\"05595edf3e473e59\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewControls.js\":\"77cf4ed131377953\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4772ad05ec39ccf1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewSession.js\":\"66a08b6a57fc4850\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/actions.js\":\"f21a347c7e854155\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/archive.js\":\"9cc7cdf46cbd04e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dataExtension.js\":\"d8b8a00866c9e476\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/deck.js\":\"de19415531b3c6c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dueQuery.js\":\"4de646e93219a875\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/gradeDecision.js\":\"762b9c7f45485d41\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/index.js\":\"614954a0b4854cce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/keyHints.js\":\"4ec9805007b97bfd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewCardLayout.js\":\"11aca16c6e988a2a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewProgress.js\":\"dcf4721ffc7168f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/schema.js\":\"99fc14cbc83edff9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/useDueCards.js\":\"04a1afd286105380\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/index.js\":\"67b5895071e6c080\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/record.js\":\"e7e24885af74c418\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/index.js\":\"cee9c7dfd88cf05c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/persistenceStatus.js\":\"ce9a373bf6f81cf3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/requestAction.js\":\"9d49d5613c893e55\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/TypeChipsDecorator.js\":\"ed44826273de9285\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/codeMirrorExtensions.js\":\"c7ff263480b6669c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/index.js\":\"ab39b8a2de1fd631\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/typeAutocomplete.js\":\"0d7ba7761d3db397\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ee71d00a6e3611aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/actions.js\":\"0d917ffc5fb530b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/anchor.js\":\"7e9d654b2c793908\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/events.js\":\"dcd18548c9e02179\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/gestureActions.js\":\"7e26fc28bcdea90e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/index.js\":\"7938fe312a86edbd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b2fa097ae164e701\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/collect.js\":\"46a97a0d68944a30\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/index.js\":\"810453e8c4de2511\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/record.js\":\"9c1ff74e4e067572\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/RejectionDialog.js\":\"5769c83341b63b5d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6f3c7f16552ee019\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/index.js\":\"b836b4435de2a248\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/model.js\":\"748ad958efce8302\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/queueCounts.js\":\"394e0e8d05248b2c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rejectedHelpers.js\":\"374ee3b7f6bc4b6d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rematerializeAction.js\":\"bfe6cb1720b81b31\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/useHysteresis.js\":\"220eed2887f117eb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/ColumnHeaders.js\":\"1db28fb1d94bc54e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/QueryUi.js\":\"c3235efa0cd16196\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/TableLayout.js\":\"6c0e7f0a6dc4bc0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/actions.js\":\"3eec51c42e384004\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/cellEdits.js\":\"a9b362d1313ff69b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/columns.js\":\"1a18112ddf56041e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/controller.js\":\"838ed05278cfcb36\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/convert.js\":\"f5a8d6fdc9b845e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/dataExtension.js\":\"10e3a332934fbd5f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/index.js\":\"8cbd154f064094bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/keys.js\":\"9db7f7e6938790b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/model.js\":\"983d7f1518f8a5dc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/navigation.js\":\"9adfde3debe46917\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/backfill.js\":\"1896a56da7edcd09\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/completion.js\":\"a6f0e618f10388c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/format.js\":\"5181705a4923e5d8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/parse.js\":\"5337744955494a3c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/queryValue.js\":\"1bddf3eba18289ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/source.js\":\"6886aaef5df2ecce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/registry.js\":\"472735678277ee2b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/rowGutter.js\":\"5eae2ce9daa885f0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/rowVerbs.js\":\"6063c063b6f3a55f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/schema.js\":\"83a08f5ac2d7822c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/sort.js\":\"922d67fa53ccf2bc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/effect.js\":\"70a08a14447e7cb9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/index.js\":\"5a29f934aefad270\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/theme.js\":\"4ae02526019acc4e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/actions.js\":\"dbc7d624237f2a5c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/dataExtension.js\":\"9a47c872512cdc3c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/index.js\":\"dd27d770a2ecaf6b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/schema.js\":\"6895cbb2da5eb4e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f661193571657c2a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/actions.js\":\"f6feccb56af3f472\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/defaultItems.js\":\"fa09ca37ef09bda6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/facet.js\":\"e4757203c2bd1cd7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/holdRecognizer.js\":\"a06981be99ecedc5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/index.js\":\"7f81eb4781e60846\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/UpdateIndicator.js\":\"71083bc86b713be1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/index.js\":\"bacd4e7e22c9a35e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/loadTimes.js\":\"6ffc7ee630c3458b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoNotesRenderer.js\":\"1aa31671e1e2cee8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoPlayerRenderer.js\":\"b23d0278826619df\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoTimeStamp.js\":\"b6afe6965f09c441\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/actions.js\":\"65e055fdc174df11\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/index.js\":\"210ccc31e6e9b932\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/markdown.js\":\"f42cced7be5ab08e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/notes.js\":\"518d4fafab5bbf66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/registry.js\":\"f40c714647fa9b9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/remark-timestamps.js\":\"bab194ad9361c8fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/view.js\":\"c4828095068d7baf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/LinkHints.js\":\"0c4af2e732977416\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/index.js\":\"4f098bdcf2320637\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/model.js\":\"57aa540623eeddeb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/settings.js\":\"7567ea1bc2124ef8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/actions.js\":\"04cb963987d15f96\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/index.js\":\"7f78ad14b8444742\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/interactions.js\":\"b126c598f1d1a832\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/workspace-header/index.js\":\"3810afb51da39430\",\"/knowledge-medium/pr-preview/pr-1843/src/registerServiceWorker.js\":\"c9f9bf2eea38d994\",\"/knowledge-medium/pr-preview/pr-1843/src/requestPersistentStorage.js\":\"3f6d75b4f276e57f\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authRequestDeadline.js\":\"6745c15c9be8dd1d\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authStorage.js\":\"b1863b678d34a625\",\"/knowledge-medium/pr-preview/pr-1843/src/services/powersync.js\":\"04126f2d22a5b688\",\"/knowledge-medium/pr-preview/pr-1843/src/services/supabase.js\":\"5bdd9508b0683668\",\"/knowledge-medium/pr-preview/pr-1843/src/services/uploadErrorClassifier.js\":\"7c105b2056400d69\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/ActiveContexts.js\":\"82726c8273666b2d\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/HotkeyReconciler.js\":\"b4cc72283b69be5a\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/WipeLocalDataDialog.js\":\"97af1559d4ca5bf9\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionDispatch.js\":\"d4148fd301e4af78\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionRefItems.js\":\"fcbd8f5d1a302086\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/applyKeybindingOverrides.js\":\"bdec16222bc5da03\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/blockActions.js\":\"1e5a2906bc2c71a0\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/blockMergeGesture.js\":\"fa43100f017d87d7\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/canonicalizeChord.js\":\"3cddd5e76b8d5619\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultContexts.js\":\"844bc83fd6fae59e\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultShortcuts.js\":\"778b3fbf2a44b53b\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/effectiveActions.js\":\"4934a91f28e39f2c\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureAction.js\":\"6bc6d92af8155833\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureBinding.js\":\"c2379efc8149bd5c\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/holdRegistry.js\":\"0443c2f7326060f5\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingConflicts.js\":\"1cbee765b63cacba\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingOverrides.js\":\"cb91de5cd2049c9e\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/pointerAction.js\":\"8a154ebbf51c0333\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/resolve.js\":\"a88250c41c918ece\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/runAction.js\":\"a05adf37b4d3f798\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/sequenceMatcher.js\":\"5a149bb81461d03d\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/types.js\":\"9ee7ea3bfbb48a14\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionContext.js\":\"502c50f209df8ab5\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionDiscovery.js\":\"0e7ff5ac6c74d062\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/utils.js\":\"bbe12d86b38c938b\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/bootStore.js\":\"aca13b2dd8fce43b\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/previewDatabases.js\":\"05d5841f4588e2e0\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/byteTransform.js\":\"622493c82ebfa4a3\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/attachmentCleaner.js\":\"bb1c72621176f1ab\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/attachmentParts.js\":\"a6351347ee1c2e04\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleParts.js\":\"e62cc3f058ebb059\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleRecord.js\":\"bc25b46536c0475e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/manifest.js\":\"4e4f9425fb3d7241\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/takeBundle.js\":\"4c5e5e2e9bbba022\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/verifyBundle.js\":\"9b1743e44e94859a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/cleaningStage.js\":\"0a4b11c3626edb03\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionKey.js\":\"4f810c3aab1b4a77\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionServer.js\":\"5d47fd11a44a1683\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flip.js\":\"315dbad3252ca999\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flipAttempts.js\":\"53a3f0113242dd4d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/pages.js\":\"8d724aadb260b0f1\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/preflight.js\":\"cbf7207d880c2c76\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/reseal.js\":\"c5dad82af0452fe4\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runConversion.js\":\"fdcf2c741bbbc73a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runLock.js\":\"ff0967fc6c36a21b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealing.js\":\"4a4d408198715f4b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealingStage.js\":\"e399e7701d2d79b7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/stage.js\":\"d7eb429e99e7c597\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/verifyReseal.js\":\"a8d46f80be2f675f\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aad.js\":\"fa683e96642857fb\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aead.js\":\"8083fe34f0ed40b7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base32.js\":\"c270333833570034\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base64url.js\":\"aa7db727a16fc99a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/binaryEnvelope.js\":\"c649fedc3be9b973\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/byteAead.js\":\"4d47d9879be26c38\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/canary.js\":\"658b05747ea6f485\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentHash.js\":\"f1124b2ef587bdc1\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentKey.js\":\"94b975d51a55c09d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/derivedIdNamespace.js\":\"afe7fee4aac16b34\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/envelope.js\":\"0bd362f46f420370\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/hex.js\":\"64476b83728fc814\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/sha256Hex.js\":\"7a1fbecdaada8b68\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/workspaceKey.js\":\"76a9b55925cf70dd\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/conversionState.js\":\"a10024798226dddd\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a08dbe8a94e62524\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/pastedKey.js\":\"7686433c929f60bf\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ffdc6442acd9979c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d6db530ce70874b8\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/keyStore.js\":\"6ebb1a831afb3e9e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/mintWorkspaceKey.js\":\"89fb5e404524ad2c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/modePin.js\":\"7336ddfd228037f9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/openWorkspaceKeys.js\":\"b5b19578dc060a2c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolveWorkspaceEntry.js\":\"88e055bec8f23ff6\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolver.js\":\"4e70ad97ed35057d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/workspaceAccess.js\":\"32dabe8f532e13b9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/transform.js\":\"666157948b1b22ad\",\"/knowledge-medium/pr-preview/pr-1843/src/themeBootDefaults.js\":\"5f7381f9bda733ea\",\"/knowledge-medium/pr-preview/pr-1843/src/types.js\":\"f6f569d33d8ecf8b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/ClientLocalSettings.js\":\"2ac440b2f9f31533\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/abortableSleep.js\":\"da4475d14c2c3966\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/array.js\":\"8346b783c118f8d9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/backlinkAutocomplete.js\":\"7ab1e8fdaac50350\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockCrumbs.js\":\"277c833df8c6cb98\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockrefAutocomplete.js\":\"b354456aa3b87a9e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/cadencedIdleJob.js\":\"ef9eee77cfac7b36\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/callbackSet.js\":\"780b4d288e3d7685\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/clientId.js\":\"9dc43c636ba85d52\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirror.js\":\"29c432daad5da6ea\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirrorCompletion.js\":\"0b8e2eda36e99cb5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/copy.js\":\"94297f671f06e4b8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dailyPage.js\":\"f72982c5df16bd50\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensics.js\":\"c693ad5658b6b258\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensicsHooks.js\":\"12ab32e3692f562d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/deleteBlockThroughUi.js\":\"da65d63ead33c885\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dialogs.js\":\"5541d83dd473a517\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dom.js\":\"b05e80bdfae299cf\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/downloadBlob.js\":\"96e3099ea8b27fc3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/exportSqliteDb.js\":\"a3f60b5e709b8a8e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fileSystemAccess.js\":\"c98d38a0b1c61dbb\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/flipSlide.js\":\"fb3c56023d7d6fcd\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fnv1a.js\":\"2ee88015285cde2f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/formatBytes.js\":\"adb14402cc2873c9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fuzzyRank.js\":\"c5f116fc62a76b37\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idbKeyedStore.js\":\"569e5b343cc7dc8a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idleCallbackPolyfill.js\":\"41bedac6ead012c8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardAwareScroll.js\":\"5c03371a3714a0ae\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardViewport.js\":\"948f4ecad7cb96a6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/lastWorkspace.js\":\"73484e3412e7516a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutColumns.js\":\"c3ba933eb5098ad9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionDom.js\":\"8e9d0528eef40493\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionId.js\":\"8b6209071938a831\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkClickGestures.js\":\"cabecc1b5562f337\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkTargetAutocomplete.js\":\"6a232bbe64ecb060\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbCorruption.js\":\"37da0a35b5931e71\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbRecovery.js\":\"816572d822243f7d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/markdownParser.js\":\"8bc76fd2944800d3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/memoize.js\":\"24ca1ae95da128e0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameFieldCommit.js\":\"20ea504769d400bb\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameList.js\":\"d8eb662a029324e3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/navigation.js\":\"210ee16f0c911b82\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/omnilinerNamespace.js\":\"af60e0fd9a7870cb\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/opfsPageScan.js\":\"0599c267dc8a8400\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelClearance.js\":\"ac7db8e5c3931243\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelHistory.js\":\"9121704b555f31f5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLanes.js\":\"b83c4254362c9510\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLayoutProjection.js\":\"bc5d455651856c8a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelScrollAnchor.js\":\"5577447d15c55c11\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelUrlFlags.js\":\"825299bbd9eb8fc2\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/platform.js\":\"18f1506c8f5754db\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/pluralize.js\":\"8057094e1da8b7c2\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyCreation.js\":\"7e3f32f1943d97d5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyNavigation.js\":\"b5e8795a967e2998\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyValueContext.js\":\"9e95223f419e765c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/react.js\":\"9b64cf6ad3371023\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeDate.js\":\"a9726e99872fbc51\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeTime.js\":\"a77ce3e8ed409940\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/renderScope.js\":\"8b0547e5712020f5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/resolvedThenable.js\":\"6fb63979ea24ec1a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/routing.js\":\"ee3c6e1bd9671b5e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/safeMode.js\":\"df085980a55f052f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/scheduleIdle.js\":\"9b2b0282f09e8b0b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/screenWakeLock.js\":\"9c4197d3332c4070\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/selection.js\":\"c81043e1cd7ac747\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/softKeyboardGrab.js\":\"efecb4375d6e76b2\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/startupTimeline.js\":\"0e55dce4e108e830\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/state.js\":\"853d1d39c2d558c0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/string.js\":\"62164d9aa2df6803\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/surfaceZoom.js\":\"8fdf86be9f5e34c6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/time.js\":\"f5202e297067f685\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toast.js\":\"a0a09033494ad4ba\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toggleStore.js\":\"b63a2d0029216c21\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/untilStopped.js\":\"2cef65516b6501bf\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/userActivity.js\":\"08d4a17b27ae1032\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewTransition.js\":\"5ab6678a8d173d48\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewport.js\":\"bfb39cea0a43740b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/webLock.js\":\"1cfee7d3a973eaaa\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceRecovery.js\":\"e5bf2d7861219fb9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceSnapshotStore.js\":\"bba8983a2f25d2ac\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-compiler-runtime.js\":\"493bea0dce2f9d9d\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-client.js\":\"a380351b67f0d2cb\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server-edge.js\":\"f9a0c11f63a05bd9\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server.js\":\"79aab0f3debd0c5b\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static-edge.js\":\"96f65285e4854026\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static.js\":\"bb1916202555bfcd\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-test-utils.js\":\"0c33f38a876ce3b2\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom.js\":\"c02a58a25a515b8d\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-runtime.js\":\"dacba6b8df146ab8\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react.js\":\"af9d6ec50659270d\",\"/knowledge-medium/pr-preview/pr-1843/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
