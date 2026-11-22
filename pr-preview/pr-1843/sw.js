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
		buildId: "e49a62be9c8d-fdd634f5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/\":\"3c0b5d7e3a16b2a2\",\"/knowledge-medium/pr-preview/pr-1843/index.html\":\"3c0b5d7e3a16b2a2\",\"/knowledge-medium/pr-preview/pr-1843/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1843/assets/FacadeVFS-ofj0i22q.js\":\"a6e1f28e5361feec\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSCoopSyncVFS-BhrlvFWA.js\":\"8fc25c534ea5c990\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSWriteAheadVFS-DS0_FyaA.js\":\"16e103b17d91d23e\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CRCguSI5.js\":\"aa6dbe9e5bc6a3b3\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-GLERWaka.js\":\"cf98e2fdd0d1dbaf\",\"/knowledge-medium/pr-preview/pr-1843/assets/worker-B9r2ZG4t.js\":\"4f9964d75f43f9e6\",\"/knowledge-medium/pr-preview/pr-1843/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1843/chunks/app-DrLuVBtw.js\":\"57f7245d9feaad95\",\"/knowledge-medium/pr-preview/pr-1843/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1843/index.js\":\"4fd2818d00d0a4b7\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1843/assets/AccessHandlePoolVFS-BrHqH0LF.js\":\"3dd3b425d7f584f3\",\"/knowledge-medium/pr-preview/pr-1843/assets/IDBBatchAtomicVFS-DisVqdIZ.js\":\"715765c3a8a2d1d6\",\"/knowledge-medium/pr-preview/pr-1843/assets/MemoryVFS-CT4RX-8V.js\":\"4f9a7b62a7277c63\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-BUt3sh4X.js\":\"b01cc87057ea9771\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-BhT5GCaC.js\":\"f0ae8daa6730efe3\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1843/chunks/AccessHandlePoolVFS-CWlOj7B1.js\":\"ec3e283e6fb9a1eb\",\"/knowledge-medium/pr-preview/pr-1843/chunks/FacadeVFS-NmSU7Ehl.js\":\"db6133dcc3cac53a\",\"/knowledge-medium/pr-preview/pr-1843/chunks/IDBBatchAtomicVFS-B04rbNPW.js\":\"9a916f2bfc9f0168\",\"/knowledge-medium/pr-preview/pr-1843/chunks/MemoryVFS-CaFZy4Us.js\":\"2797106508e2d01d\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSCoopSyncVFS-gjVOsNFI.js\":\"8a191215c0239e2f\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSWriteAheadVFS-DOyslIXb.js\":\"5182c69def073434\",\"/knowledge-medium/pr-preview/pr-1843/chunks/Preview-BCBivjUK.js\":\"1286b7fa5caa5abc\",\"/knowledge-medium/pr-preview/pr-1843/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/card-Jhp9NzF5.js\":\"eb5af2d7ae256d5c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-5ffHv8uL.js\":\"48be06e4a73a08f3\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1843/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-B9TJN1tb.js\":\"25c78e2fa0e0eb26\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-async-BT0UTX_Y.js\":\"ed020206259b34be\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-COR8P6VA.js\":\"02a56211a0064dd4\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-ChESwn1X.js\":\"584370b603b27f41\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-CuN_MpC5.js\":\"3021c2f36449a7b6\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-D4hTHcQp.js\":\"afac75b8ea5ee43e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-Mo_xVufy.js\":\"1d4da396de2dede3\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-XUxHUA0o.js\":\"084c30dc7e87eda5\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server-legacy.browser.production-D-VmGHuZ.js\":\"33ccf8b2a1889ff8\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.browser.production-B6YnhnqJ.js\":\"47b8260bba9781d7\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.edge.production-DbOLv5k2.js\":\"5e5fbe3c7056ade7\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-pyJfWgg5.js\":\"b3e431cd7bb9294d\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-t5oo2T5h.js\":\"64cdacd183eb562f\",\"/knowledge-medium/pr-preview/pr-1843/chunks/server.browser-LqHJrO3G.js\":\"d6fcaf150dd377a5\",\"/knowledge-medium/pr-preview/pr-1843/chunks/textarea-B7NyZPKe.js\":\"6d1246dd26fbeea5\",\"/knowledge-medium/pr-preview/pr-1843/chunks/ui-D3yRNWFA.js\":\"9ac6814fa2de66e7\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-async-DnYoTG4E.js\":\"117a0af3381be428\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-smHdvteP.js\":\"915b850638bb69de\",\"/knowledge-medium/pr-preview/pr-1843/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1843/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/src/App.js\":\"fdd5869b65224e37\",\"/knowledge-medium/pr-preview/pr-1843/src/appUpdate.js\":\"e117932916f62f83\",\"/knowledge-medium/pr-preview/pr-1843/src/appVersion.js\":\"efed2c3d1a87ac40\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/initialLayout.js\":\"d190a1c382cee462\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/openWorkspaceData.js\":\"c8a236be025b732e\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/resolveWorkspace.js\":\"034ed7e8c2e6d47d\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/workspaceBootstrap.js\":\"f8d4bc3980c875bf\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockComponent.js\":\"48f35edecc3763bc\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockCrumbs.js\":\"01694c29937f4ba3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockEditor.js\":\"7b9f88a33ab8ffeb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockLoadingPlaceholder.js\":\"1c2b41406981243e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockProperties.js\":\"45c8ac34b17af578\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockSearchPicker.js\":\"7b6f2d4c18e7a568\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ConfirmBulkDeleteDialog.js\":\"9ab9af3a43cf8f4a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DividerHandle.js\":\"03ee7a1e4ea1d753\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DraftEditor.js\":\"c861657b1d8b0494\",\"/knowledge-medium/pr-preview/pr-1843/src/components/GutterPill.js\":\"acf74d323c53b356\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Header.js\":\"d89613347a85fdd1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/LazyBlockComponent.js\":\"cd0fd18bb211beb1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Login.js\":\"8cf3dd4edd606845\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ZoomableSurface.js\":\"d98cbfa011cc3679\",\"/knowledge-medium/pr-preview/pr-1843/src/components/editModeKeepalive.js\":\"b2acdac14b57df94\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8bdf8f2260b70608\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"9e0786e0ae71ecd5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefPropertyEditor.js\":\"29561701a37a9fe8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefTargetTypePicker.js\":\"2e80fd74a2b3363d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/SelectPropertyEditor.js\":\"672184dcc1ee7038\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/TypesPropertyEditor.js\":\"2bbaec96c9502896\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/defaults.js\":\"5260206aa3e40ffa\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/kernelValuePresets.js\":\"ceb44418cbdef68c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/selectablePresets.js\":\"a1c47ea3d6235cc3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/typesPropertyUi.js\":\"6d8389dcedd49504\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/AddPropertyForm.js\":\"7687ccee6879a916\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyPicker.js\":\"c02a3b1785cdc8a6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyRow.js\":\"2428a91957e21e2d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/Rows.js\":\"0a1bdda1db0dabf8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/actions.js\":\"c7ca31dbfeed4a02\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/declarationOnly.js\":\"a5038152e01f58ec\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/layout.js\":\"0dc1e0e9ae05dbc4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/model.js\":\"759fb2a24418e3ea\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapeUi.js\":\"75832e947efc9855\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapes.js\":\"cd77345000582c34\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/usePropertyEditingActivation.js\":\"dc1cc2c1d762bb42\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/visibility.js\":\"822e897e5b468f74\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanelSections.js\":\"c35051c2e20721d9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockEmbed.js\":\"6e39bcdff29b8719\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockLink.js\":\"0fc3d513f2af2210\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockRef.js\":\"1c8a6ed878d6c102\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/ReferenceLink.js\":\"93240a6e393930e5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuard.js\":\"71835839ef6a5889\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuardContext.js\":\"32104c29985d11af\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/linkInteraction.js\":\"159ca3fca4337885\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/referenceLayout.js\":\"e1e6884220e40d04\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/useBlockRefAncestors.js\":\"1da9a8fa2f1b8df8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockGutter.js\":\"e03883a01ca70b63\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockInfoDialog.js\":\"4fbc429db2044bdf\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockTypeBlockRenderer.js\":\"38e82dfe296a0276\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BulletHoverCard.js\":\"97c6a6133e62ff69\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorContentRenderer.js\":\"5eed0afef90ae7de\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0295d9d076837d8c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ColumnResizeHandles.js\":\"39f67b9d6eac4715\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9a8be3abc8fa8e78\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/DefaultBlockRenderer.js\":\"4ecff10c2668a386\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/LayoutRenderer.js\":\"8f63a8586af12d2f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MarkdownContentRenderer.js\":\"6992f587cc1cd6ed\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MissingDataRenderer.js\":\"704927ed845c0cd7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PanelRenderer.js\":\"823f7a3135f0a97a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c32e8040df7509ed\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/TopLevelRenderer.js\":\"123fc16d0c459f27\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockGutterMode.js\":\"5ffa78c72e2cc3e2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockTitleText.js\":\"ea2ade5ed7b42f10\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/fieldCreationKeydown.js\":\"d0759f17c505c345\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/layoutRootContext.js\":\"ef913602784cd962\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/TypeChip.js\":\"e7d3af0f4d38ca8e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/chipStyle.js\":\"89487a3ad274ea37\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/anchored-floating.js\":\"627220630507bd23\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/button.js\":\"5d7cbc7d9eb3bb88\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/card.js\":\"af47fd5911733f07\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/checkbox.js\":\"3777a2202b2bceb7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/collapsible.js\":\"6bc83c1cbd0f8fcd\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/command.js\":\"6d1ea1e283cee914\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/context-menu.js\":\"c6c0b02246a4b565\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dialog.js\":\"b35e406efe9c74e4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dropdown-menu.js\":\"e922ed328fb9fa8d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/floating-listbox.js\":\"9c038ee272854278\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/index.js\":\"0fa6da025ebaaf77\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/input.js\":\"aaabf833a33d1ef2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/kbd.js\":\"635ffb523ddf1e67\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/label.js\":\"b96efc2132160fbb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/textarea.js\":\"9c9f16cf733d9823\",\"/knowledge-medium/pr-preview/pr-1843/src/components/useEditModeYieldKeepalive.js\":\"94e7da9b3d62a424\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/BootFallback.js\":\"894d37f594b498f3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/FocusedRowLazyMount.js\":\"03d05e2904bded49\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LazyViewportMount.js\":\"7200a1a5463ace97\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LocalDbCorruptionFallback.js\":\"311048a73898d052\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/error.js\":\"80b359a088879d3a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/lazyMountRegistry.js\":\"b2a7c06a0d1af9d8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/suspense.js\":\"d301728ddca4b3f2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/CreateWorkspaceDialog.js\":\"c053bf17605b832f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/PendingInvitations.js\":\"ac159af49f94dbe9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/SyncProgress.js\":\"39b48f72c9c1bb6c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/UnlockProgress.js\":\"6e0b7693b9d46514\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceKeyGate.js\":\"41a3a2611265d283\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSettingsDialog.js\":\"46e4b605afd6ac12\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSwitcher.js\":\"a9a0112d20a0d41e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSyncGate.js\":\"6a1ac88cd7821601\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlow.js\":\"b897cfda9397420e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlowHost.js\":\"04b4070050dc768a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/EncryptionSection.js\":\"648718037262d973\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/attachmentPrompts.js\":\"d5c2b09b3efb6245\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c112f4661758af70\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowDeps.js\":\"be2606462f41aa22\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowStore.js\":\"b2018455bb01516d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/flowUi.js\":\"81ab49edfcac67fa\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/useConversionRun.js\":\"2643cf15ce14e8e0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/keyUi.js\":\"896623547497cdec\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnKeyLoss.js\":\"e90d89937beb2fff\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnServerE2ee.js\":\"b05641318654ad2c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/workspaceUnlocked.js\":\"79bdb9f22e64002e\",\"/knowledge-medium/pr-preview/pr-1843/src/context/backgroundSubtree.js\":\"b16856166d9c1aad\",\"/knowledge-medium/pr-preview/pr-1843/src/context/block.js\":\"52aba735c944bfb9\",\"/knowledge-medium/pr-preview/pr-1843/src/context/layoutWsContext.js\":\"7ab02150d8e8d0d5\",\"/knowledge-medium/pr-preview/pr-1843/src/context/propertyDisplay.js\":\"00d0ac557b3a5c83\",\"/knowledge-medium/pr-preview/pr-1843/src/context/repo.js\":\"b5b2dcbdec8daed1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasClaim.js\":\"cda55fd72677ec34\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasSeatNamespace.js\":\"71cda68c146e3801\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockData.js\":\"2caeb8d2ec2bcac9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockType.js\":\"c9cdd7621f232398\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/changeScope.js\":\"a5bf84f2eaa94f91\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/codecs.js\":\"6d4e5637d5ea851b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/derivedData.js\":\"8f996778e20b29fb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/errors.js\":\"0805f20376d47969\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/events.js\":\"87172f782427f229\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/handle.js\":\"8cf63acf7e99042a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/index.js\":\"f2eb07c9972e5800\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/mutator.js\":\"74c09440ff26ccb9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/processor.js\":\"c6874d24893d2704\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/propertySchema.js\":\"97551a096a7abba3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/query.js\":\"aa70557fbce29b93\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/sameTxProcessor.js\":\"1639780770d869a5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/schema.js\":\"8cf63acf7e99042a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/tx.js\":\"8cf63acf7e99042a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/typedBlockQuery.js\":\"d763bc56e4f5f3a8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/user.js\":\"15e95d0167d42093\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresetCore.js\":\"e53d8b21030d14fa\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresets.js\":\"33ea666e7fef994e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/attachmentCleanerIOVerb.js\":\"efcca8679d877a36\",\"/knowledge-medium/pr-preview/pr-1843/src/data/block.js\":\"3442a374cea8f397\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockCache.js\":\"30f966a8615cbe18\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockId.js\":\"a60bf3c5234e5164\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockLiveness.js\":\"343bd0d088bdcbcd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockMerge.js\":\"a04b7d71141f19c9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockSchema.js\":\"c8e9ad3d49c5246b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypeLookup.js\":\"fc07245f3814ffc5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypes.js\":\"676eeb03910c4df7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/clientContext.js\":\"2a942d2324b208ec\",\"/knowledge-medium/pr-preview/pr-1843/src/data/dbFileSiblings.js\":\"a050c1408067e610\",\"/knowledge-medium/pr-preview/pr-1843/src/data/definitionSeeds.js\":\"71c29d5e0f60f230\",\"/knowledge-medium/pr-preview/pr-1843/src/data/derivedIds.js\":\"631dd00957e8b6de\",\"/knowledge-medium/pr-preview/pr-1843/src/data/drawnSubtree.js\":\"cef02ddd3ad52357\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facetBridge.js\":\"b8255e60adc37696\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facets.js\":\"e3798c2bf728349d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/globalState.js\":\"c3c9dc0d0539c09a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/aliasClaimRederiveProcessor.js\":\"f80dcbdf3e99b4c5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/ancestorBatch.js\":\"5d823800d3e118b7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/blockTypeTypeifyProcessor.js\":\"d680712d35765ed7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/clientSchema.js\":\"162a492f129dce2f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/commitPipeline.js\":\"1c6bbc14a40db2b7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/devAssertions.js\":\"2be2b1333bebb75f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/firstSync.js\":\"7095d06d2bbe9383\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/freshInitialLoad.js\":\"a7dfae64f958b12e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/graphBackfillClaim.js\":\"bf6ce165eae2cfbe\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/handleStore.js\":\"da37778d406de5ad\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/idleMarkerJobs.js\":\"bc6d2609d4d987c8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initialDownload.js\":\"bde4c6f486e4d146\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initializeClientDatabase.js\":\"514cac12db4ebff5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/jsonCanonical.js\":\"355be4d9626066f8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelInvalidation.js\":\"84bbe9c3469c77a6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelProcessors.js\":\"6586e74a2105d254\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelQueries.js\":\"7d048643a91693f1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/mergeTypeMembershipProcessor.js\":\"34b4bb301d6674cb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/normalizeReferencesProcessor.js\":\"7f162496ebb7f8e4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/poolInstrumentation.js\":\"697fa49bbdd9659d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/processorRunner.js\":\"64d1a6a6b480e26f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyCellBackfill.js\":\"2f4be8456073e3fe\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildMint.js\":\"f267f46b6295310a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildrenProcessor.js\":\"3a72b8c62e39248e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionChangeProcessor.js\":\"ad070dfaa94499ac\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionSynthesis.js\":\"1acbddb230d31bc7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyKeyScan.js\":\"2ebd952bc7f51a3a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertySchemaResolution.js\":\"731bcfabb31f0f91\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyValueEdits.js\":\"6d4906d5a06d9594\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/raiseProtocol.js\":\"1692b993adc5093e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/readBatch.js\":\"66706aa4f29dd3f7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/refProjection.js\":\"d3c7aff65330956e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetLookups.js\":\"9459648a0c9760c7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetProcessor.js\":\"ecaea7c82e8aa8a5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/replayMerge.js\":\"81827f2710322217\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/sqlBinds.js\":\"817dadfb308ed743\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"51e0be7bca8c7813\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/arrivalProcessors.js\":\"ac95e7fd3a76bbfc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/invalidate.js\":\"9e3990319d005877\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/materialize.js\":\"577f9b294cbe16e0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/observer.js\":\"6fdeeb232de0ec2f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/reconcile.js\":\"3e0d77f78e86ccce\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/timingMetrics.js\":\"9a447911ea0c27ee\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/treeQueries.js\":\"d8a2856e2932de7b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txEngine.js\":\"b7b282b17910dc00\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txSnapshots.js\":\"ef36eaebb75e2bfe\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/typedBlockQuery.js\":\"1b3dce742944a9d1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/undoManager.js\":\"25c17f8cd8645854\",\"/knowledge-medium/pr-preview/pr-1843/src/data/invalidation.js\":\"b027af28ab742398\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelDataExtension.js\":\"1eeace7f7d28cf8a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelPage.js\":\"81945fa703081ddc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelValuePresetCores.js\":\"41358ee69ac18665\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbCorruptionSignal.js\":\"8e434b66985a386b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbStorage.js\":\"1e73a2ce3092c552\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbVfs.js\":\"398843226ed1a52a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localSchema.js\":\"b451b4d0af1e4277\",\"/knowledge-medium/pr-preview/pr-1843/src/data/maintenance.js\":\"e83fc837a30a8e4e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mergeProperties.js\":\"3ec23b0b6ef349df\",\"/knowledge-medium/pr-preview/pr-1843/src/data/metricsConsoleHook.js\":\"792576eb975a9b38\",\"/knowledge-medium/pr-preview/pr-1843/src/data/migrationsPage.js\":\"9baf1450809667ef\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mutators.js\":\"9b38b2757fcac02a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKey.js\":\"9ad60bc677ed81f8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKeyPlacement.js\":\"06d99331e0df1ed3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/outlineSurface.js\":\"7cdb8b1eefdc5e23\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingEditorContent.js\":\"16999b716867de6e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingUploadsSql.js\":\"87b62e711ed3efc1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pluginStateExtensions.js\":\"99ff7c3dfee9f7c2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/powerSyncLogger.js\":\"c3cfe96f7511fd30\",\"/knowledge-medium/pr-preview/pr-1843/src/data/projectorRuntime.js\":\"d6a5b797450ba3a8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/properties.js\":\"a467108239a447e4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertiesPage.js\":\"a481e7628f0babf5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyChildren.js\":\"b3c253ef5a487632\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionFanout.js\":\"72133c5954ea5526\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionMetadata.js\":\"77998cfd43c2a516\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionRegistry.js\":\"45526d5c2a9f69c6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDisplayMode.js\":\"6992d6b588b66ef5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyRowCreation.js\":\"ecd6e51f36fc2bcd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySchemaCreation.js\":\"0ad439bb74c111ed\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySeeds.js\":\"9badf0ce899852e6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/recentsPage.js\":\"002f8c04e55eb20a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/referenceBlock.js\":\"d84ae4b8d2c3f688\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rejectedUploads.js\":\"4a7edc724128a7ab\",\"/knowledge-medium/pr-preview/pr-1843/src/data/releasePowerSyncConnection.js\":\"2ef558f5bedec4c7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repo.js\":\"972b33a655645649\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repoProvider.js\":\"b428492eef4ea21d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rowProperty.js\":\"c14388a08f51d63c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/searchFilter.js\":\"c135b861b468c804\",\"/knowledge-medium/pr-preview/pr-1843/src/data/seedIdentityLedger.js\":\"da93a7aefc1e4d91\",\"/knowledge-medium/pr-preview/pr-1843/src/data/stateBlocks.js\":\"f6faedcfcabef7b1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/structuralEditPolicy.js\":\"b79596560d114299\",\"/knowledge-medium/pr-preview/pr-1843/src/data/subtreeDelete.js\":\"81b69752626f981d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncStreamLock.js\":\"3a3177b19b142b4c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableSqlRecognizer.js\":\"119ece0f6234fe7a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableWriteGuard.js\":\"d93525ac041c66da\",\"/knowledge-medium/pr-preview/pr-1843/src/data/targets.js\":\"9c858089248fa8cd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeColors.js\":\"d378b22e377bb85e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionMetadata.js\":\"973e90321d02fb0e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionRegistry.js\":\"036119d4372592e5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeExtraction.js\":\"32ea12899d3307ca\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeInitialValues.js\":\"654e88e901144c15\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typePropertyGroups.js\":\"ac8341faf0b7b270\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeSeeds.js\":\"ad69de3e2f93eb6c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeTagger.js\":\"614555783418abf6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typedRecords.js\":\"9b399a2565cbbbdb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typesPage.js\":\"808ecec1bf1d5d76\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userPrefs.js\":\"9684a6c6f6ebe01e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userSchemasService.js\":\"d93fd4e906e68add\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userTypesService.js\":\"e193a91fdf859abc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/valuePresetRegistry.js\":\"b3958b8e41efdf24\",\"/knowledge-medium/pr-preview/pr-1843/src/data/visibleChildren.js\":\"b343bec6b3df078a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceConversion.js\":\"c5db76a37883db2d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceFirstSync.js\":\"427a202825d026fd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceIdNamespace.js\":\"73baefb75c08130d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceSchema.js\":\"bcf3a3d50d625dec\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaces.js\":\"a5aefab27f5567f5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadLog.js\":\"d140a8144046848c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/BlockPasteShellDecorator.js\":\"62d8bf4a1676c5f7\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/atTrigger.js\":\"04b1038ff6cb9e30\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/autocomplete.js\":\"b4741a8c5d901d34\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/codeMirrorExtensions.js\":\"073224030fc90981\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/contentFlush.js\":\"ef820c5e24cfc29f\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/defaultInteractions.js\":\"f5efed4b0435770e\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/editSettleSignal.js\":\"39451df76983bb26\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/insertImage.js\":\"294267cf43b328f6\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceCompletionRange.js\":\"ea343fd8d3d77279\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceTargetTypes.js\":\"c45094cb56e4da0f\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/syntaxContext.js\":\"503e5b1497107e29\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/triggerMatch.js\":\"c5914d20e9fb05c8\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/AppRuntimeProvider.js\":\"a1c8f988c4aeddee\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/BlockFocusShellDecorator.js\":\"09806ff14ec79c3f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/ExtensionRenderBoundary.js\":\"490da1c51ae33601\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/PanelContentRecovery.js\":\"9f20790a08610590\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/apiCatalog.js\":\"78123edc8fc93722\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/approveExtensionHere.js\":\"bd38f98f1a8486d8\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/armedCutAppMount.js\":\"cc40d616713be0e3\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/batchableKeyedStore.js\":\"5c2f32fab5458ef5\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockInteraction.js\":\"b9a1fcc13d94a76f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockSelectionAction.js\":\"13b4b1271e8541f0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compileExtensionModule.js\":\"c55c148bf81fe952\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compiledModuleCache.js\":\"543ef6166b4357b0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/continuousGestures.js\":\"f22329f33c07a2f6\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/core.js\":\"ac1b817121713140\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/defaultRenderers.js\":\"785586d8b3c920a3\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/definitionFanoutAppMount.js\":\"8bbd7ee7779118a0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dialogAppMount.js\":\"3308f549167b27d3\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensionSeeds.js\":\"6eaaac0bb7db3e2c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensions.js\":\"5015526be97666ef\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/exampleExtensions.js\":\"e3aa5e5928806238\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionApprovalStatus.js\":\"1c7541e582670cce\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrorToast.js\":\"2048b4b6b3ad8b0e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrors.js\":\"24162937eabbebe8\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLookup.js\":\"b0c2af15cbe1d3b8\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionToggles.js\":\"f7e51694498ffd48\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionUtilitiesCss.js\":\"4a8404f74761607b\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/kernelPageDeletionGuard.js\":\"cf8f7b9dd5046803\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/liveRuntime.js\":\"2b20f7d547645da7\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/openExtensionsSettings.js\":\"fc2095b98b250d1d\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/overridesCache.js\":\"eb7d8c4e2d26c425\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/pluginIds.js\":\"98417c85b24611a0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/processorRejectionToast.js\":\"cbbc11200ca04fc5\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeActions.js\":\"56f3269d344bf106\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeContext.js\":\"a13a3b2434bb5437\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticAppExtensions.js\":\"02b12f178d185884\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticDataExtensions.js\":\"d7d65020be2c57ed\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/toastAppMount.js\":\"ff23bd1b9ab72d69\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useOverrides.js\":\"c7ce4ce38b7e1aea\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useShortcutSurfaceActivations.js\":\"7b6f8aa9acc877b1\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/discoverToggleTree.js\":\"9dda7fa6489a27fd\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/facet.js\":\"550033d040abda20\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/resolveAppRuntime.js\":\"6f907d682fb156c3\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/runtimeEvents.js\":\"919e5c3a22d9ea36\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/togglable.js\":\"801e40ec48c3d9de\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/variantFacet.js\":\"216a4b3e9b5bff6a\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/verbFacet.js\":\"ffe1ccb60c84ef1a\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/block.js\":\"ae0859b46cc774c1\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/focusedChild.js\":\"e829358ecbb2556d\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/propertySchemas.js\":\"132b562a3f9239f8\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/typeRegistry.js\":\"d01ab8a69e129036\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAncestorCrumbs.js\":\"c9951ec32f0fbaa3\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAutocompleteListbox.js\":\"83d0e803e93a332b\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedSearch.js\":\"fa0b76ac7bd33f04\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedValue.js\":\"6cefe41921280272\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsFocalRender.js\":\"9829753d4a0a33b0\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsReadOnly.js\":\"25d7212df8da6e4e\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMaterializeBacklog.js\":\"11c654275e2ceaad\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMinuteClock.js\":\"616d8f46247d1b50\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePanelLayoutProjection.js\":\"fa68ed3fcf42fc25\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePendingInvitations.js\":\"f251936f639987b8\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRendererRegistry.js\":\"b3b5bbc8c9fb020e\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRetainedFieldRows.js\":\"aeed33a8a1b6ff2e\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useWorkspaces.js\":\"098e3da15aa49349\",\"/knowledge-medium/pr-preview/pr-1843/src/lib/utils.js\":\"ceedd4d2a8dd04f1\",\"/knowledge-medium/pr-preview/pr-1843/src/main.js\":\"4920d6c2c390122a\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/MarkdownImage.js\":\"c87ab5d17a894a15\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/blockSeparators.js\":\"e1ba4846643acef8\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/context.js\":\"a966584bcf0ad2df\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/defaultMarkdownExtension.js\":\"743ee93426023a68\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/extensions.js\":\"f701453fc86d6357\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/renderMarkdownHtml.js\":\"9a23bc844c3a88ed\",\"/knowledge-medium/pr-preview/pr-1843/src/minimal-editor.js\":\"93e7836cf4db58e9\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/armedCut.js\":\"4896e8caf4a68c62\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/captureMediaVerb.js\":\"3fc72d4bec15c37d\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/clipboard.js\":\"555cf708722a68f0\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/decision.js\":\"06d798f98e5e00b7\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/operations.js\":\"8579c2d869975e3f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/AccountHeaderItem.js\":\"4afe7589b98af4ce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/index.js\":\"8dd6fbb5373bea39\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0d545ef068ee04f3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askAgent.js\":\"29cc90c7137bea78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askedStore.js\":\"a2d3d7b87c330e98\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1a8690f0ee0a33d6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/chipState.js\":\"8d403961070d1275\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/dataExtension.js\":\"83acb1743e8d5cce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/index.js\":\"812765df766ec98d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"cfe3cdadb9348eeb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/schema.js\":\"e85bdae842ed889d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b1793bda3211f95e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/BridgePairingDialog.js\":\"58c01fb2753d1971\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/addMedia.js\":\"77d1e890fe7c11ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/backlinks.js\":\"39d081c5c3b7b5df\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/block.js\":\"3e2dc141126c67ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/context.js\":\"ae45584eaab3b1c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/displayIds.js\":\"02bfbd1e4923f96e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/index.js\":\"a35a060caa35450e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/outline.js\":\"468f21c328d5fcfd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/properties.js\":\"bcf481d2ae875390\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/refs.js\":\"ba8a12b30be9d98b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"291e9c728021e2f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/search.js\":\"751f6f8cce0b2eda\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/shared.js\":\"5d696842968c17d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"5164752163dd2020\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/text.js\":\"b5651ac328b6eeb5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentWrites.js\":\"671cf483e0ec7a97\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/authoringCatalog.js\":\"a3124fe6bed596b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/blockRefTargets.js\":\"f8395c766d356508\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridge.js\":\"670f2f668cef50b7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridgeLoop.js\":\"29e50961c613d32b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/changeHistory.js\":\"914449ebe5c89f01\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commands.js\":\"8040d2fdcc3be259\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commentsCommands.js\":\"4661f6d7406fe3ac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataExtension.js\":\"913db52841cde060\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataModelGuide.js\":\"2f9ee9d61531131d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/describeRuntime.js\":\"c4803e39a4b8d626\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/extensionLint.js\":\"63f8d3c9e00102c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/grainAudit.js\":\"7238c562e88b28a4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/healthCommand.js\":\"916615053c17c141\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/index.js\":\"1b07b9d9169523ce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/presetIdentity.js\":\"6029cbcb6698a6ba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ebfb090aa7bf2a85\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/readMedia.js\":\"ff699394aacd1400\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/schema.js\":\"7d2469fb629b2352\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/serialization.js\":\"97c264d07a71ba9a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/targets.js\":\"968dea22b109c6cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/tokens.js\":\"0acbc94bc7d886b0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/watchEvents.js\":\"06ae711fa3d39578\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/workspaceGuard.js\":\"b7404f76d25f7210\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/writeCommands.js\":\"fa76295d6814392a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/AliasCollisionToast.js\":\"a149c5b9fe59b6aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/DuplicateNameBanner.js\":\"58aad73646241fd3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/collisionMerge.js\":\"9f45f555081cc8f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/dataExtension.js\":\"74abebf2994122f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/index.js\":\"077f37d46a7e0e39\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/mergeCollisionAction.js\":\"b3d1dd9ae31ecba9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/pageStyling.js\":\"2314baab107a4343\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/rejectionToast.js\":\"3a4b3234e5ef5423\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/syncProcessor.js\":\"d1f0e153573e1041\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/actions.js\":\"82d0eedcefd652f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/addComment.js\":\"e2515c5eb8ed62c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchor.js\":\"b6fc4bab46a9d8d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchorState.js\":\"e4a633aaf6d657e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/commentLinks.js\":\"7a7e42e1eccc35d6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/confirmThreadDeletion.js\":\"adab258e2715e662\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/container.js\":\"329ad2d6074616ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/dataExtension.js\":\"edb4dd7e408b1313\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/deleteComment.js\":\"29a4a2784d9e2b1c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/highlights.js\":\"12399cdb3c9588fd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/index.js\":\"a800afc388408889\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/linkedCommentsPill.js\":\"2b0521f2b3e41649\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/margin.js\":\"c44ba832b3abe9b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/marginSchema.js\":\"df1094ac047e0767\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/newComment.js\":\"e77b5aa63edd54e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ownThreadPicker.js\":\"a3237126b4ed9407\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/placement.js\":\"29c91977abdfa4ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/queries.js\":\"4036dd5cc3d55b81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotePosition.js\":\"ad821c3189411fb3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedIn.js\":\"7a7c4a21cab3b763\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedRange.js\":\"79a30748247f2f05\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/rangeRefs.js\":\"52cc7729db7e4dec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readHighlights.js\":\"14a4acbf7de9bcc4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelection.js\":\"1a29b79893fa0faa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelectionUi.js\":\"6be0cd31b0859cec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/reanchor.js\":\"a5794cee34176b07\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/schema.js\":\"0318f20e85b2c534\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scope.js\":\"5ccb9cb572819f8a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scopeThreads.js\":\"5ad5bffb9fd51a77\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/splitRetarget.js\":\"91d6fbde859fae8a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestionCard.js\":\"52246f547e273b9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestions.js\":\"b0af6024fe83a508\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaries.js\":\"1cafaebcb8c02608\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaryBatch.js\":\"cdce5caecd337cea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/surface.js\":\"bd25d75e2f87d6af\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threadNavigation.js\":\"645d4d7308bc843e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threads.js\":\"fb1c24b78ddf7f7a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ui.js\":\"b248a59be2fc522a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/uiStore.js\":\"60370c9830e94ea1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/appIntents.js\":\"1b29ed0e2d5498fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/index.js\":\"2a8b871f8b52e3a1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/index.js\":\"3bcdca70593bf9ef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/status.js\":\"6bb021c09c52b825\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a8cc6de551ac1713\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaBlockRenderer.js\":\"7d2280f949228649\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bc4b74ffa7adf028\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaUploadReconciler.js\":\"a79a2143c6cd6449\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetDownLane.js\":\"a3de5a9ec897b209\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetResolver.js\":\"f463d95f505395c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetUpload.js\":\"53cc218310e1bf6e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/attachmentCleanerIO.js\":\"ff862f39a5717170\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/supabaseAuditIO.js\":\"618b07012395cbb3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/blobStore.js\":\"84765005466e27f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/byteStore.js\":\"29ff5a1205d23def\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanerIO.js\":\"f9a009202668a4f4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanupAttachments.js\":\"89614777cc73e9cf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/dataExtension.js\":\"3f23e90a2e249520\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/downLane.js\":\"5833d62b96b86b7b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/index.js\":\"74a09d077b41c788\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/insertImageContribution.js\":\"a2be7ebb14ba7ae4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneArming.js\":\"e5a605b397034f00\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneLock.js\":\"a5e59da3212b4234\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaBlock.js\":\"a06bb339d4af522b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaCapture.js\":\"1edf0f1beb07616d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewers.js\":\"30bff4e30284b269\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewersFacet.js\":\"d872ac104ebac3a3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/pasteCapture.js\":\"bd16998aafc2d4da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/resolver.js\":\"3cc4f166d8dcba5b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/retryUploadsAction.js\":\"ffb45d47877e8aaa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/storagePaths.js\":\"3510c7a362f08640\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadDrain.js\":\"4e43be28fab597f2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadLaneStatus.js\":\"c09d06c6ad18638f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadReconcile.js\":\"770f435698311a78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadRecovery.js\":\"c5e5bfe969415918\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadStore.js\":\"3a276146a9b4ee4d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/useAssetObjectUrl.js\":\"53e2a9c8290a4dfd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"695b08406d84970b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d74995ac29f371c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/facet.js\":\"a11f97d45bf53e0b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/index.js\":\"cd5726f75956b0ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/prop.js\":\"159cc2232dee78dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinkFilters.js\":\"465a76157d871445\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2ec49d4d2e74d26c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BlockEntry.js\":\"95a9107dcd07035d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/LinkedReferences.js\":\"17e320cd7a9e2097\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9812b28f5bde502d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dailyNoteDefaults.js\":\"a168b66df56b09aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dataExtension.js\":\"c0197fb0f63d58e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/edgeExclusions.js\":\"d60109c4d8af82a6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/filterProperty.js\":\"48d886d696fcaa2f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/index.js\":\"afab1aaa78d1e3fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1c53f23d92f0926e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/applies.js\":\"d82e432bf8f43f2c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/countQuery.js\":\"1ca124d3795df8b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f2b59b7651d92f2c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/index.js\":\"d0eed15c0af448b1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"cfedc812e9d8b6ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/presentationInvalidation.js\":\"39b4ec924c8bf795\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyEditorOverride.js\":\"afccddc44bd22f37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyFilter.js\":\"d5fe93693597a702\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/query.js\":\"5c4270ad224c0d4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/resolveFilter.js\":\"d44d0333c6c77332\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sourceBatch.js\":\"46f87371fd1d1bf1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sources.js\":\"af4ab423f4e12209\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useBacklinks.js\":\"c89b9070082c744e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ed03e39d97ce61e2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayCelebration.js\":\"90add6ffeec2adbd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayOverlay.js\":\"0ac0e78fb041a42f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/gate.js\":\"3d26d354419f9933\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/index.js\":\"16566405729043c8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/wolfTheme.js\":\"8c69a0c0bf9309d6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/BlockDragLayer.js\":\"51adc921d5de67fb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dragController.js\":\"7215af87d7b84475\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dropTarget.js\":\"2e36532b354164c4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/index.js\":\"5b47b2215975e978\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/projection.js\":\"3e8fc92c71356814\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/BlockMetaCard.js\":\"659f51657d3b6c78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/index.js\":\"10d09fef80f4a707\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/AddTagDialog.js\":\"18caf2969e996895\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"df9623de1ca460e5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/TagNameIssueHint.js\":\"155a08b5a7030cfa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/addTagAction.js\":\"3c60da99b5c22da8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/appendTag.js\":\"a79e004d095ad8b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/config.js\":\"8f034a96e3a7e992\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/dataExtension.js\":\"5e97ffe0ed0b2e78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/index.js\":\"fcae547e42a03c77\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/propertyEditorOverride.js\":\"bd8084c27ebe90f3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a84788fcff641c38\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cc26063eb7ab400e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fe7a62e64a8d07b7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6174c1b48ca0b85f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fef8dc44151f27be\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/index.js\":\"cf8054f917a8c5ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"85348ac9ba5a4d56\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/CharacterCountItem.js\":\"fa22b3a89ce5e419\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3f3e7e6480737840\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/actions.js\":\"bb9ee4056650d116\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/blockType.js\":\"1b470265d8cd34b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/charCount.js\":\"c43bb769cc846bc6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/dataExtension.js\":\"8235f26b8af6f340\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/index.js\":\"462dbde2c8775f37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/profiles.js\":\"74e1c5c74e503936\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/properties.js\":\"e434c7d26c7be434\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/textCounts.js\":\"deeda11fd43be088\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/colemak-keybindings/index.js\":\"92923dff1d84736f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/CommandPalette.js\":\"4f868260eaf40b05\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/HeaderItem.js\":\"a0c9530a066260bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/context.js\":\"290f134483895911\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/index.js\":\"0dba9fcaddbb3364\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/selection.js\":\"b323e224681869c4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/toggleStore.js\":\"7379567288d7d99d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/useCommandPaletteActions.js\":\"0682d9f0cc91279f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/ContributorBadges.js\":\"0c208cfa1f8c59be\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/author.js\":\"3af9993615eef2d7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/codeMirrorExtensions.js\":\"d020a4fc533819e0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/dataExtension.js\":\"60c5ef2b86d38ef6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/index.js\":\"2b95c1e18c8fed42\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/mentionAutocomplete.js\":\"0aa217c09d9776a6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/processor.js\":\"8dfecdcc5ab12882\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/profiles.js\":\"2bcf53eec866d619\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/queries.js\":\"9dd0e6d82de07e80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/schema.js\":\"f44a3f99bfcf4033\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"55ac6155a8cb7138\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8383029e99cdf306\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/index.js\":\"7ca31325017cad00\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4521bd3eb764a341\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c42da486d60183d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/CalendarGrid.js\":\"10b66909b02159d6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DailyNotePicker.js\":\"1a672c8fb4a28250\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"0ccf7e4cb09b7013\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateNavDecorator.js\":\"a23eee6f3fae7bbd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateScrubOverlay.js\":\"8ce761eff315504d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/HeaderItem.js\":\"3d45df4420148b64\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/ReschedulePicker.js\":\"30abbde8a46eec0c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/SpreadDatesDialog.js\":\"74d791a41b2221b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/actions.js\":\"503fc20de1810432\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/blockDateAdapter.js\":\"ff7bf753bb9d2a88\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/calendar.js\":\"1897da98309ab2d6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dailyNotes.js\":\"583cb4448c90ccc7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dataExtension.js\":\"5ab0903e4ba6b021\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubActions.js\":\"9ccb134c373ecf48\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGesture.js\":\"fda94f641646ad9a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGestureActions.js\":\"714f64f372646de0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubRecognizer.js\":\"bce3a4c2f0dac38d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/deletionGuard.js\":\"98814114416ff70f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dueQuery.js\":\"6a69e511c2316bd9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/index.js\":\"90d863e0466a91fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/landing.js\":\"c1f53dc21575cfb5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/localSchema.js\":\"6931b308a93f6944\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/referenceDateAdapter.js\":\"07c634fcd0d27f26\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/rescheduleAction.js\":\"df03267932f76ab9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/schema.js\":\"3d6a398a36381414\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadBlockDates.js\":\"88b20470936de561\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadDatesAction.js\":\"c0cf3ddd9078e59f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/today.js\":\"2929cea1fc187c22\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"af2915a272579083\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"79cbaa25ebc482d0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/audit.js\":\"7929abc7d2d0b8b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditAction.js\":\"2711239271dc508f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditRanges.js\":\"3ba9b0fee1955b9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/diagnosticsSource.js\":\"6fa97cd2fb50a9cf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/divergenceScan.js\":\"ad52cfe2150a7f05\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/index.js\":\"8ba0b2991cc45c73\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b02d7d4843f9ea57\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/referencesMirror.js\":\"bebcf03bf4828d9b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/rowJson.js\":\"a8fbeb01e65d0062\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/schedule.js\":\"0caed6ca2ab12d1c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/store.js\":\"c506227995da106f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/action.js\":\"2ef4e0663d95bba8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/index.js\":\"4c6fb02dbf925522\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/plugin.js\":\"2e7b7461bfef822e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"82e8979085d7b0b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/actions.js\":\"babfa284fcb8b6ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/changeMarker.js\":\"96f61e2c6548c9f0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/diagnostics.js\":\"b6b5f5e065031dca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/fileSystemAccess.js\":\"68b262b8faf7c565\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/filenames.js\":\"14299c73a229df36\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/index.js\":\"f53293a6966a1e06\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/mirror.js\":\"c2ae877059417ca3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runLock.js\":\"43632a67dc7f08e3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runtimeHealth.js\":\"0433b66c7fca42e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/schedule.js\":\"583491dabaf92fac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/store.js\":\"e96452af27dc059f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/index.js\":\"0dcb623b97f95bab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/themes.js\":\"df9bea8bdbe704f0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/facet.js\":\"cf3f0fde8272b052\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/useDiagnostics.js\":\"3fe86ab2a4acef63\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/dismissals.js\":\"306c478ee632a62c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/index.js\":\"a855b923431d7a3b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/status.js\":\"f16a067de3b6a962\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/store.js\":\"c47e614799412d5b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5b24b1ac8f93f1b0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9b47ef9a555d55aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/actions.js\":\"b36ae565bf55f060\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/config.js\":\"1ef572a8c922222b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/dataExtension.js\":\"b1f2aa65602ec253\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/effect.js\":\"dc98e9261ead2dd3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/index.js\":\"a7e778bbd388d4eb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/propertyEditorOverride.js\":\"84075365b7ad6a3c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/useToggleTree.js\":\"2683fb3c1a84e1f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/ExtractTypeDialog.js\":\"9ba9d5a634b51697\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"847237f1ef245397\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/PropertyShapePicker.js\":\"43c843b7c2db401d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/action.js\":\"e7e5fd049696a229\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/index.js\":\"58dd46cee780410a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/FindReplaceDialog.js\":\"db337bce03421f59\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/HeaderItem.js\":\"b11514002da6dbd7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/dataExtension.js\":\"c7985d94319b2cdf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/index.js\":\"7403c90979705bb9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/search.js\":\"65c03d023e6149c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/toggleStore.js\":\"5c1d9cb49b9ffde7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/LocationPropertyEditor.js\":\"10cd8e274ea91c01\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/MapView.js\":\"d6153af042ef3383\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/blockTypes.js\":\"a2a4a67feef71f94\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/codeMirrorExtensions.js\":\"380b26fa1fcda13c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/createOrFindPlace.js\":\"ad4ed9ac54b44d95\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/currentLocation.js\":\"cdc40944a96d29f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/dataExtension.js\":\"7ab5f673b12d68e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/geoContentDecorator.js\":\"d5354138d273ef5d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/googlePlacesClient.js\":\"69ed8d8a2dd96cfa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/index.js\":\"248ca266e8ac17ad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/locationsPage.js\":\"bce6237d74a63480\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/mapViewport.js\":\"efa205a8e98fba3c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/pickCurrentLocation.js\":\"38b259fa8aefd17c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeAutocomplete.js\":\"7651cab27fc4fd19\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeNameCollision.js\":\"0d13310a4c44406e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/properties.js\":\"8c0d2b8f8155b277\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/propertyEditorOverrides.js\":\"ea8e0fd2c260873d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/query.js\":\"8b8e5fa32dff3726\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/usePlaceSearch.js\":\"15774b012dc0fb7b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ce3430b3e06e8bd5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"22162a89a6d6a1a1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b1161beeead65e20\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/config.js\":\"fb9296da820f10bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/dataExtension.js\":\"e3368754fd721a6a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/facet.js\":\"b884b6ff74ee2855\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/grouping.js\":\"5a3521d993dbe05d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/index.js\":\"592a3694900ae147\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"afe99158221e3f77\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/query.js\":\"f3c47d4cc4a1d7ba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/resolveConfig.js\":\"322ca1c4833f94b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"47f07d2b09cd7104\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b06b33d6275afcff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlDocumentContent.js\":\"06507ee018bef84d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlFrame.js\":\"fc4f0907ad050e4f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/actions.js\":\"146b34d0ff17a6d9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/blockType.js\":\"8b1948fcb6000d8e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/confirmRunScripts.js\":\"6dd6dc88fc637266\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/dataExtension.js\":\"921e3e576b4a761a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameAnnotations.js\":\"95a9e29dc4ff6c81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameDocument.js\":\"dbcdf388071582bc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameTheme.js\":\"e3889d0270ad6515\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/index.js\":\"9c45b461c666185f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/scriptConsent.js\":\"3348c6d9121ae88b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/sourceMap.js\":\"ffd0351ce5aec40c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/useDocumentScripts.js\":\"0b28de5a4698e3e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/index.js\":\"512cd73553905a8c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/record.js\":\"9440a62ec04402ef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/recordStore.js\":\"b2fbbc4c387ad188\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/responsiveness.js\":\"ae1a9e8774d161a8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/schedule.js\":\"26777f28cf2ff063\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/sessionContext.js\":\"081516c3f5724f0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d3653b870727b920\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5273007d35e84564\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/actions.js\":\"ab6f7ba366b4c2b8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/config.js\":\"57798abb67235a4b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/dataExtension.js\":\"4cab164602897e01\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/effect.js\":\"b882ad214204ead5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/index.js\":\"6cc8a04ce961f3e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/keyCapture.js\":\"dc9910c58c8baa1f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/overrideStore.js\":\"b2244c38e15cc4a1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e89c96bb5f660630\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/HeaderItem.js\":\"4f44ad7e9200566f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/LeftSidebar.js\":\"224a4cf812e89565\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/actions.js\":\"a3ccce17d7d36663\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/facet.js\":\"11beca73d9eb9d37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/index.js\":\"6b6472550787523d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/shortcuts.js\":\"2286f38df5e70593\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/toggleStore.js\":\"a7aea691793aaaa7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/MergePicker.js\":\"2d976fdd6f296ba9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/index.js\":\"feb726d5501fca3b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/mergeAction.js\":\"a70714d79d0e22db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/strategy.js\":\"32de6b2114806c9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/Button.js\":\"be7b72f81318b4c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1ca28080a1dc66d1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7b66cc03ad2cd44f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/facet.js\":\"dd3ed4bb3dab50bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/index.js\":\"8ffcf1e2b234e212\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3bf8608f4aaa5a15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8beccdd9f9df9b4d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0f8a4fbe3ca8e9ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c18e68afb0f9b4e5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/index.js\":\"9973b35cac6c6f70\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/MoveDestinationPicker.js\":\"cb7e0e4347bb5cb2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fdaaf887445abfcc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/contextMenuItem.js\":\"b5408994425bdd0d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/index.js\":\"99b87bc40365860d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveAction.js\":\"648c9c22c9446a78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveBlocks.js\":\"745e28b0e2e0f56e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/selectionAfterMove.js\":\"cf4dc97c5ba7fb05\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/TutorialBanner.js\":\"36c2c86e445197ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/action.js\":\"d93244978c95fd4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/bannerDismissal.js\":\"8fac11b6c7436a59\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/documents/cheatSheet.js\":\"88b32113c105d6e2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/index.js\":\"72de319dd4d8e686\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/keys.js\":\"6dfdffbc555e2cc6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/landing.js\":\"cea98fe83ceb791d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/outline.js\":\"1dfefebef95837b5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/seed.js\":\"f327b7cca74a88f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/PerfTrendDialog.js\":\"608aa4f3e1cefbd1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/analyze.js\":\"256e9146a790cc06\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/diagnosticsSource.js\":\"106d01d58f813f12\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/index.js\":\"b7dbff0e2bca2227\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/load.js\":\"f58adc2260269b4e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/monitorRun.js\":\"c32ccbda0e840148\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/schedule.js\":\"e6b03e6ef547f5be\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/series.js\":\"66d4423a5cc57fab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/store.js\":\"f3ad7f26dce12a7d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/trendAction.js\":\"73844a4fc558fd1f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/verdict.js\":\"ae061e87d0b80022\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/clickToEditAction.js\":\"4feddd60c61e1525\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/index.js\":\"a40e434cda1de100\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/interactions.js\":\"af96ce5695abdc28\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"03c8fc9967e20879\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGate.js\":\"dd638d8706ac07e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGateDialog.js\":\"8f57978da3561a68\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/action.js\":\"9fafb66e805ffdda\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/index.js\":\"524f53e842b7c9f4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/localRunMessage.js\":\"cb6c8ec985f70c70\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/plugin.js\":\"af9f014e0d9d58a5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/progressReport.js\":\"26070ffa626eff42\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/sweepProgress.js\":\"f9ecda705d5be714\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/FieldRowRenderer.js\":\"301340850c1ae893\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/ValueRowRenderer.js\":\"7db6b47632b4ca51\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/actions.js\":\"aa07aa8747a7344e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/autocomplete.js\":\"9e584eae02a51a99\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/fieldRow.js\":\"a57fc26d22b719aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/index.js\":\"b8dc94ac09f03d27\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/referenceWarning.js\":\"95e5b7ee52216f89\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueAutocomplete.js\":\"1d045f33682d7b41\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueSchema.js\":\"561b840fce81dc8d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/HeaderItem.js\":\"7c4020aadff25a5a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/QuickFind.js\":\"44c0eb1c84e674d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/index.js\":\"7c44530e626285fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/recents.js\":\"4b2839af6784f79f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/resultItems.js\":\"321bd68c0385291c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/selection.js\":\"383ffdb5587ed840\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/toggleStore.js\":\"bca3f5321dd77428\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/HeaderItem.js\":\"b9f232652bac0081\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0bd87f2db78e3d85\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/grouping.js\":\"104fab0a49c6d1a6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/index.js\":\"a040d349b18b6033\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/target.js\":\"375078fb14aa5f34\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/codeMirrorExtensions.js\":\"b858f20962767d96\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/contentPrefill.js\":\"9315e3e07dc7c2d9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/dataExtension.js\":\"2d1a74d568172897\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/index.js\":\"ba048694c8001214\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0d9a03d00bfba6e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/invalidation.js\":\"1e4888e1631b24f8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/localSchema.js\":\"da81d82ed7a50318\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/index.js\":\"6d9b1cdb74f39611\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b75e57186f9c97f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/index.js\":\"12ff6d017d13cc7b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/referenceNode.js\":\"de2447c4e6077002\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/remark-reference-occurrences.js\":\"51713b977984f4f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"65ab3970279ca099\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/index.js\":\"113ec0d92cefc120\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"807d5fce8143dc56\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6c5ccc6b3ad48424\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/mergeRetargetProcessor.js\":\"1cc2601bcabcf634\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/parseFence.js\":\"e655ec8cf9e63686\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceParser.js\":\"86e2fef07d9b824d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceProjection.js\":\"6e0ea5e8d7e06c9c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referencesProcessor.js\":\"07039ff68c7d8227\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/renameProcessor.js\":\"5694be2c364a51e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/spanReplacement.js\":\"6f8464cde3fff6b8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/htmlToOutline.js\":\"d5e051a8fac0d9ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/index.js\":\"731b70bad1c5d46d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d0feeff665e6bdfc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/pasteDecision.js\":\"9283dd056b64981d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/action.js\":\"8e5b400dcc1a4c64\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/blockIds.js\":\"173177e1cbb8d085\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/content.js\":\"9a785c42c9fe88bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/effect.js\":\"44550c5ef1bd7dd6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/ids.js\":\"714f08e001cbfaf4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/import.js\":\"50703272ca03e153\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/index.js\":\"a9d0467241a2d8b8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plan.js\":\"826ade9ce67ef0aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plugin.js\":\"6630bad2e7d5ed2c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/promotion.js\":\"918c91ebe2e0ea23\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/properties.js\":\"7ac79baeb0026ff0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/references.js\":\"b40992b1661e34c4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/report.js\":\"e8edc2cbc6c26729\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/roamMemo.js\":\"496c5afa8a018fcd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/runtime.js\":\"29e7575920b29c03\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/schemaReconciliation.js\":\"e89675dd7b0c115a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/srsMarkers.js\":\"f690f70ac215d84c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/todo.js\":\"92e49a10923c96e0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/typeCandidates.js\":\"71b1fd974a12cce1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/types.js\":\"27dd86ce3e03da44\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/index.js\":\"40e8b9fa01b0780d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/store.js\":\"53714a6f6b2eac8b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/HeaderItem.js\":\"b8facfb5c01b28de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ffa33086108dd33b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/index.js\":\"514120b8b4148db4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/model.js\":\"34b3cc322fd521a7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/toggleStore.js\":\"fadc02e285e9be14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/useKeyInspector.js\":\"f794d0c5bfd67926\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"69a1247690a37dde\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/ShellDecorator.js\":\"66019d93ffde2027\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/actions.js\":\"837cccfd86c49317\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/exclusionsFacet.js\":\"18c199790192fa6c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/index.js\":\"81899378b0955b71\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/shell.js\":\"87172f83806ffadd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/surface.js\":\"70a2e6b095c0eb0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/walker.js\":\"2c07271e6d100c1a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b1d804c41248de22\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/dataExtension.js\":\"ab96ae9cb510c4e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/index.js\":\"6144453b2bd39db8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/indicator.js\":\"91ab023bcb58c35e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/moveSrsState.js\":\"0b10f24ec59f1113\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8225b2d41eaf9231\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/scheduler.js\":\"ad677bf06c02fdf8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/schema.js\":\"0e1b9414266c1f09\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9408033fb630f8b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsClipboard.js\":\"a3543425f8460c82\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"53dce773a4a3922c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DailyNoteReviewHint.js\":\"5ceac342068db74d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DeckPicker.js\":\"635be9b6aae4ebf0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewControls.js\":\"97aeddca0fe706d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewDeckRenderer.js\":\"07dc9d114413a55c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewSession.js\":\"61d376cc932ee0e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/actions.js\":\"c009c7bdcc5b67c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/archive.js\":\"db8195d980c5b4c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dataExtension.js\":\"ec01b43b95d82d8a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/deck.js\":\"3a786a438b132f27\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dueQuery.js\":\"668febb2129e6ebf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/gradeDecision.js\":\"cf13ff9597cded67\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/index.js\":\"ede97b96f13ce057\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/keyHints.js\":\"894806f74560ecc0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewCardLayout.js\":\"493f48c3a5170b33\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewProgress.js\":\"3e66360b226722e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/schema.js\":\"386f6efa341a0af3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/useDueCards.js\":\"9f641663e2d8a18b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/index.js\":\"0e0c618f33e07d44\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/record.js\":\"6b0d60fac713197e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/index.js\":\"21125022c5769880\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/persistenceStatus.js\":\"3899118769b87af7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/requestAction.js\":\"bca3053c54e8aca7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/TypeChipsDecorator.js\":\"9fc055e4dd66292a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/codeMirrorExtensions.js\":\"a0e7cfb79479d20a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/index.js\":\"139761a46af30b07\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/typeAutocomplete.js\":\"d2614ecb5d15542d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c7079379f1c686f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/actions.js\":\"f2f5e7925fb7fb50\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/anchor.js\":\"eb3c9e509a46fddb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/events.js\":\"0a0d97d8d9aca9a5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/gestureActions.js\":\"a920d95eef652949\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/index.js\":\"b1cc1a0c017115f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"93cbfa8f735dad10\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/collect.js\":\"3e81b8ae5c02d6e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/index.js\":\"ead39b721d298d7f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/record.js\":\"e0967783cb1b6036\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/RejectionDialog.js\":\"2bf4fe2cd112831c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b8e24c83531c3b9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/index.js\":\"4f673835959d9922\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/model.js\":\"99429cf695ed5699\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/queueCounts.js\":\"aa2b2ff69e3fc4c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rejectedHelpers.js\":\"6467e9ac35ffefc2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rematerializeAction.js\":\"2d13b31ffa8b5348\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/useHysteresis.js\":\"af6b08042fa04c1f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/ColumnHeaders.js\":\"0bfcdb810277b2fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/QueryUi.js\":\"ad8623406a14d6ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/TableLayout.js\":\"93b341bc7a2dad19\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/actions.js\":\"d389c057ffe84898\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/cellEdits.js\":\"5df363043533e9c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/columns.js\":\"15ba69b9dded96ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/controller.js\":\"b74a808d19d64676\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/convert.js\":\"a0bec223296695c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/dataExtension.js\":\"fca8d055a521a50e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/index.js\":\"2ea6d0aebbd914b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/keys.js\":\"86cac5b43c5f417d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/model.js\":\"fd74fe147ad74511\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/backfill.js\":\"8817a15f20ea80e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/completion.js\":\"6848b42279ec355d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/format.js\":\"e1ff182856dbef2e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/parse.js\":\"23d3f024b1e20208\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/queryValue.js\":\"8aad88ee14b6be98\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/source.js\":\"607260f40503fc03\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/registry.js\":\"d3b4144ee3362c4e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/schema.js\":\"f763ef4824294c78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/sort.js\":\"d193bde7bdb1afeb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/effect.js\":\"51642d0d28878dd1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/index.js\":\"6b0000de378211e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/theme.js\":\"0ae4a617e3e8fecf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/actions.js\":\"4d266aaf4c94d26a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/dataExtension.js\":\"7198c3546582053d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/index.js\":\"50be78b0ca687237\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/schema.js\":\"2b7daff45d89e15b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0ceca53dc224ec18\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/actions.js\":\"b2dbddbf262a12b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/defaultItems.js\":\"db15ca3961a3882f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/facet.js\":\"eb5590e7838d9880\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/holdRecognizer.js\":\"11543bde17c61482\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/index.js\":\"7eacce99bb7c7f78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/UpdateIndicator.js\":\"1eddf20407ab8e06\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/index.js\":\"4b5002d0e5f62440\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/loadTimes.js\":\"4c86f668d583d9ee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoNotesRenderer.js\":\"a0dc61292c093b53\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoPlayerRenderer.js\":\"964e202b5ff2ba80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoTimeStamp.js\":\"043c4df0a48cb901\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/actions.js\":\"1b288de4699f3464\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/index.js\":\"5e6bc56190771383\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/markdown.js\":\"46096d9b7da87619\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/notes.js\":\"f89f9d2982f0513d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/registry.js\":\"a5d74bc0415cccb0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/remark-timestamps.js\":\"f099ec6dd3068142\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/view.js\":\"0ca59bda38c65450\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/LinkHints.js\":\"bfeed146f6c96eb2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/index.js\":\"93e3137f6a095bd8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/model.js\":\"a2b35e5ceedd3c4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/settings.js\":\"394a4e8d0cd5cc79\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/actions.js\":\"3adf4d289a6a160e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/index.js\":\"a28cc1ba79f90846\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/interactions.js\":\"3ca56b7192c0256c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/workspace-header/index.js\":\"7c91cc3e07ccee5c\",\"/knowledge-medium/pr-preview/pr-1843/src/registerServiceWorker.js\":\"925a7f5912196ae0\",\"/knowledge-medium/pr-preview/pr-1843/src/requestPersistentStorage.js\":\"ab7f2b34fca784bd\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authRequestDeadline.js\":\"1ee80eac3da319c4\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authStorage.js\":\"fcfdbbe3895989af\",\"/knowledge-medium/pr-preview/pr-1843/src/services/powersync.js\":\"4fc9b0473cbe9460\",\"/knowledge-medium/pr-preview/pr-1843/src/services/supabase.js\":\"e731b11d25dbdd6c\",\"/knowledge-medium/pr-preview/pr-1843/src/services/uploadErrorClassifier.js\":\"8044ceb0e4147a61\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/ActiveContexts.js\":\"d1385af9bc3b0e3f\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/HotkeyReconciler.js\":\"44ec67196d055ab5\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/WipeLocalDataDialog.js\":\"4064ab5d0d27194c\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionDispatch.js\":\"134bf7dd60242437\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionRefItems.js\":\"6f51982bd515f6c3\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/applyKeybindingOverrides.js\":\"3430c0d17e686779\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/blockActions.js\":\"9cad9662932c77ef\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/canonicalizeChord.js\":\"15a0ddebb2c72239\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultContexts.js\":\"d0b8e0847e6eb6ff\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultShortcuts.js\":\"b8975d1084ce9ac3\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/effectiveActions.js\":\"bc21a91c35a4bac9\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureAction.js\":\"1c1706eb2e5cad30\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureBinding.js\":\"b0060321e6acc323\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/holdRegistry.js\":\"dcfc4feeaa6c913c\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingConflicts.js\":\"1e3eaddcb35158dd\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingOverrides.js\":\"bdf0bd43403105a7\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/pointerAction.js\":\"2014d991114f687b\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/resolve.js\":\"4286c3909cd33003\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/runAction.js\":\"b736ce8fbbaf3ee6\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/sequenceMatcher.js\":\"6fdb4cabb0c3d63f\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/types.js\":\"7e899a5613397322\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionContext.js\":\"b03e0c5b355e3f53\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionDiscovery.js\":\"307f75d9bea9e22e\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/utils.js\":\"c6f07dee28f30fb5\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/bootStore.js\":\"31a736e6dc6deea9\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/previewDatabases.js\":\"dbe2931cbc3387b5\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/byteTransform.js\":\"39b32181d77aa89d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/attachmentCleaner.js\":\"3511ab9183952a5a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/attachmentParts.js\":\"8ddb91f54a62ae4a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleParts.js\":\"d473074da0743852\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleRecord.js\":\"41042c50bb74ac32\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/manifest.js\":\"4039663b42ed6047\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/takeBundle.js\":\"1dcf9d4772a6edd0\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/verifyBundle.js\":\"b5fdd0bd3b82c7e1\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/cleaningStage.js\":\"ec521d7d11fd7856\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionKey.js\":\"84385caa4d1793dd\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionServer.js\":\"aa2426d7ce6182b0\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flip.js\":\"00c877d5e75d74eb\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flipAttempts.js\":\"43f245728cf04844\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/pages.js\":\"18bd5e358400d76c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/preflight.js\":\"78ec5a602a626b70\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/reseal.js\":\"0ee61a1fe7e00633\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runConversion.js\":\"9859dd2f92bfd9d1\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runLock.js\":\"2dad7d3a287a6425\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealing.js\":\"a1d5f8b2e14dec71\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealingStage.js\":\"07e7c2ae6742e93f\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/stage.js\":\"e8bb388576af04af\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/verifyReseal.js\":\"da47d228e92a5625\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aad.js\":\"0e0152eba74a6b81\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aead.js\":\"66d108be4626521e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base32.js\":\"6af108cf3d43ae7a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base64url.js\":\"062277aa50769aa4\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/binaryEnvelope.js\":\"96d7c2a34d14bd17\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/byteAead.js\":\"48f85a478af4606b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/canary.js\":\"1b0886770520c153\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentHash.js\":\"5b23a8eb47c6f99d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentKey.js\":\"426ee201d5df26f2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/derivedIdNamespace.js\":\"1cb0218172ad25a3\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/envelope.js\":\"a7a1365325e2ffd6\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/hex.js\":\"1f2aef533f7c3907\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/sha256Hex.js\":\"7a14b0acc3c951c9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/workspaceKey.js\":\"5d95fc3e767f0bce\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/conversionState.js\":\"c5845e4100cfa0d9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e7ad8da7564a52b5\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/pastedKey.js\":\"bad1706116e1e1f4\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5c36253ccfc6c10a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9b2fb85b5d1c3724\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/keyStore.js\":\"7c9c20dd3274aad7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/mintWorkspaceKey.js\":\"899a6a9eba06d562\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/modePin.js\":\"5c15c5871faf3cc2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/openWorkspaceKeys.js\":\"68188a27a9a47323\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolveWorkspaceEntry.js\":\"8c4b92d03f46c9f9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolver.js\":\"0b779d2c1c888cd9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/workspaceAccess.js\":\"9f37f4a5acf6db37\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/transform.js\":\"7d7f9f0a7dd5e16e\",\"/knowledge-medium/pr-preview/pr-1843/src/themeBootDefaults.js\":\"a142c47829ff2823\",\"/knowledge-medium/pr-preview/pr-1843/src/types.js\":\"0c554ba0ce59976f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/ClientLocalSettings.js\":\"dfced24419806ca0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/abortableSleep.js\":\"d99e3098a9ab8f03\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/array.js\":\"0b7aea87d83099a1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/backlinkAutocomplete.js\":\"910774136b3d81c9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockCrumbs.js\":\"f77a95942994e8ab\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockrefAutocomplete.js\":\"bd23d784e3114e25\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/cadencedIdleJob.js\":\"acd37fe9c230cf36\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/callbackSet.js\":\"9d926b916da2dee1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/clientId.js\":\"078e8923ff2b9ffa\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirror.js\":\"9b24d5913dca1ed9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirrorCompletion.js\":\"d580d828ac155ed4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/copy.js\":\"556f99fc42c4218e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dailyPage.js\":\"4f7dad8c597c0865\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensics.js\":\"9c2cc4e74f13209a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensicsHooks.js\":\"6bdd484f3e8d3964\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/deleteBlockThroughUi.js\":\"9f06e11a4e694054\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dialogs.js\":\"3c0ec9eb11581c9f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dom.js\":\"13a31c1bd730d7f5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/downloadBlob.js\":\"3b820aded10b1697\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/exportSqliteDb.js\":\"3b9ebde5ad5de068\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fileSystemAccess.js\":\"b027528a3f274c82\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/flipSlide.js\":\"2254f41c3f5edc94\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fnv1a.js\":\"3ae7a669adc30b53\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/formatBytes.js\":\"959262f3013064c8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fuzzyRank.js\":\"d7fb56dbb78c1875\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idbKeyedStore.js\":\"3fd83fb2e2de3c86\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idleCallbackPolyfill.js\":\"d21629cabb16515e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardAwareScroll.js\":\"fb2020bd73aec8d7\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardViewport.js\":\"e306af4958ac370c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/lastWorkspace.js\":\"d955f8c068830970\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutColumns.js\":\"361c81360bfb292a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionDom.js\":\"00553878be16d560\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionId.js\":\"e210c3037f1ce9e6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkClickGestures.js\":\"2ab089abb2db9ad1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkTargetAutocomplete.js\":\"7add0289c0033a77\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbCorruption.js\":\"376a51dda3624894\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbRecovery.js\":\"a3b51873bfaf7012\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/markdownParser.js\":\"7ce92b15a83090eb\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/memoize.js\":\"a40117bad6ed0889\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameFieldCommit.js\":\"08a67195d08b22e7\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameList.js\":\"a48118b741589c20\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/navigation.js\":\"56a2a578a5d1cd2a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/omnilinerNamespace.js\":\"602c93cf52e46134\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/opfsPageScan.js\":\"4a070b228dd4adda\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelClearance.js\":\"d17ad38186e9d803\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelHistory.js\":\"5c3d1d61075cc03c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLanes.js\":\"279cf094daaf8d80\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLayoutProjection.js\":\"4da26e718a20399e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelScrollAnchor.js\":\"b14a553ccef0dc18\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelUrlFlags.js\":\"66f446097a591b65\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/platform.js\":\"a5447cfa2eb70eda\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/pluralize.js\":\"c9724a98829e9936\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyCreation.js\":\"1b064a180813193f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyNavigation.js\":\"ab109e8ad70aa210\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyValueContext.js\":\"b15446d890fd04b3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/react.js\":\"6c6ba81d3e6512ae\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeDate.js\":\"bef382552f65a265\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeTime.js\":\"43abca1d4db212c4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/renderScope.js\":\"a311d348d9c021e4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/resolvedThenable.js\":\"aa2dce856bacc9af\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/routing.js\":\"46833ab318ef143b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/safeMode.js\":\"c9bc9d79342855bc\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/scheduleIdle.js\":\"63fe9ac369bd5f62\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/screenWakeLock.js\":\"798d88c6779a7ff1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/selection.js\":\"ec151364753681f7\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/softKeyboardGrab.js\":\"42298455cfc45297\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/startupTimeline.js\":\"a44f520c9f70dad9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/state.js\":\"9ca0c0a2613164b9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/string.js\":\"dd7386b91aea50aa\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/surfaceZoom.js\":\"f805dccb06593ae5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/time.js\":\"7dc3f602d7d0cb83\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toast.js\":\"d943bc06dd339f51\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toggleStore.js\":\"6e058ac8e60a05c8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/untilStopped.js\":\"bb0832ab17db0df6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/userActivity.js\":\"22082cd258367286\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewTransition.js\":\"4670744ccc1ecd02\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewport.js\":\"6ddeb2b4b94e0fe8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/webLock.js\":\"7c7a1acaa79d8c9f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceRecovery.js\":\"ddfdde30a3c9508b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceSnapshotStore.js\":\"cf1550b33c2aef8c\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-compiler-runtime.js\":\"d032ee29b50090e3\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-client.js\":\"7235eee6c0897ee8\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server-edge.js\":\"e279e021263614f2\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server.js\":\"fdebf0b9b57189a4\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static-edge.js\":\"0b297472be71b610\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static.js\":\"6d0710f37be9077c\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-test-utils.js\":\"43795a25696bc92b\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom.js\":\"b0a6201a96657b68\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-runtime.js\":\"533f54f248607c5c\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react.js\":\"d561243fdbcef0ef\",\"/knowledge-medium/pr-preview/pr-1843/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
