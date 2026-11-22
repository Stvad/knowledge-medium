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
		buildId: "91438211a28e-9d7b3f9d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/\":\"1b252e5182927751\",\"/knowledge-medium/pr-preview/pr-1843/index.html\":\"1b252e5182927751\",\"/knowledge-medium/pr-preview/pr-1843/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1843/assets/FacadeVFS-ofj0i22q.js\":\"a6e1f28e5361feec\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSCoopSyncVFS-BhrlvFWA.js\":\"8fc25c534ea5c990\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSWriteAheadVFS-DS0_FyaA.js\":\"16e103b17d91d23e\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CRCguSI5.js\":\"aa6dbe9e5bc6a3b3\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-GLERWaka.js\":\"cf98e2fdd0d1dbaf\",\"/knowledge-medium/pr-preview/pr-1843/assets/worker-B9r2ZG4t.js\":\"4f9964d75f43f9e6\",\"/knowledge-medium/pr-preview/pr-1843/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1843/chunks/app-I5VnnxUk.js\":\"846b7b85921469a0\",\"/knowledge-medium/pr-preview/pr-1843/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1843/index.js\":\"25c6bf5077fd9fcc\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1843/assets/AccessHandlePoolVFS-BrHqH0LF.js\":\"3dd3b425d7f584f3\",\"/knowledge-medium/pr-preview/pr-1843/assets/IDBBatchAtomicVFS-DisVqdIZ.js\":\"715765c3a8a2d1d6\",\"/knowledge-medium/pr-preview/pr-1843/assets/MemoryVFS-CT4RX-8V.js\":\"4f9a7b62a7277c63\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-BUt3sh4X.js\":\"b01cc87057ea9771\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-BhT5GCaC.js\":\"f0ae8daa6730efe3\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1843/chunks/AccessHandlePoolVFS-CDKGhzT7.js\":\"2aac38d3b0c8c6f9\",\"/knowledge-medium/pr-preview/pr-1843/chunks/FacadeVFS-DUdqSQqG.js\":\"b34e8e8fbf3ffa8b\",\"/knowledge-medium/pr-preview/pr-1843/chunks/IDBBatchAtomicVFS-DOfInyJ3.js\":\"feca5d9f2c42fbd5\",\"/knowledge-medium/pr-preview/pr-1843/chunks/MemoryVFS-C139KScU.js\":\"b8a230602c49b147\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSCoopSyncVFS-Cqis_QLj.js\":\"eccf31e2d395bb3f\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSWriteAheadVFS-DSz4btuw.js\":\"f1e7b82ecf446ad0\",\"/knowledge-medium/pr-preview/pr-1843/chunks/Preview-Bkgzvrvy.js\":\"f31223428c7c6481\",\"/knowledge-medium/pr-preview/pr-1843/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/card-BQue7G-j.js\":\"d1c1b5841b884715\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-B-8OaIKH.js\":\"16853e01ce6f2c04\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1843/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-B9TJN1tb.js\":\"25c78e2fa0e0eb26\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-async-BT0UTX_Y.js\":\"ed020206259b34be\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-6D4JE8cj.js\":\"25a7c361cfe0c3da\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-A9cbiKmB.js\":\"73a2ea60852100f0\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-BrCcnMvU.js\":\"01fb0f5482a19a26\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-CTNevCdY.js\":\"bed4f7ba4995dccb\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-D2dtPpNG.js\":\"7aa74a658cac3763\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-D3OJXFZP.js\":\"ab4fb43e804e716f\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-P1V-kqS3.js\":\"a01406badeb9c6b3\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-Ro0Hgmia.js\":\"cdd79a0ebda25f0b\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server-legacy.browser.production-CQJSwF9u.js\":\"79c4fbc0bb766c95\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.browser.production-CuWEV8Wv.js\":\"dc2d4c79361d85dd\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.edge.production-DRhr0LXG.js\":\"d66f3b5b8d330ffe\",\"/knowledge-medium/pr-preview/pr-1843/chunks/server.browser-BZH9UmC9.js\":\"c8c427e60201d4c4\",\"/knowledge-medium/pr-preview/pr-1843/chunks/textarea-BwL04Zcw.js\":\"40752e8428110298\",\"/knowledge-medium/pr-preview/pr-1843/chunks/ui-Cu0sp31Z.js\":\"d22ed498a3aa6b8d\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-async-DnYoTG4E.js\":\"117a0af3381be428\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-smHdvteP.js\":\"915b850638bb69de\",\"/knowledge-medium/pr-preview/pr-1843/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1843/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/src/App.js\":\"659779e99ace6b1b\",\"/knowledge-medium/pr-preview/pr-1843/src/appUpdate.js\":\"0b753351b3de61b7\",\"/knowledge-medium/pr-preview/pr-1843/src/appVersion.js\":\"c0643ec6b32634ba\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/initialLayout.js\":\"4042884df9fc96b6\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/openWorkspaceData.js\":\"29f2b09496324160\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/resolveWorkspace.js\":\"d9f6bb5f53f429de\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/workspaceBootstrap.js\":\"f3770743b6515700\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockComponent.js\":\"44dd4d259f552b14\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockCrumbs.js\":\"186e3674e406f0e4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockEditor.js\":\"06f9936c38fd4df2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockLoadingPlaceholder.js\":\"646a996661ef305f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockProperties.js\":\"a9f1635ed532abf1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockSearchPicker.js\":\"1fee05fd3d1f8225\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ConfirmBulkDeleteDialog.js\":\"7eef06d57c19d512\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DividerHandle.js\":\"cf444db5b6732f04\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DraftEditor.js\":\"cb21a35216c5d5fa\",\"/knowledge-medium/pr-preview/pr-1843/src/components/GutterPill.js\":\"887d6fcedcf6a34a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Header.js\":\"402a6b2278b39e94\",\"/knowledge-medium/pr-preview/pr-1843/src/components/LazyBlockComponent.js\":\"3887c5917647d8f0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Login.js\":\"3ec1ec13d46a873e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ZoomableSurface.js\":\"feff970c499c4e9b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/editModeKeepalive.js\":\"bc1ae46eebf5197d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyDisplay/PropertyDisplayScope.js\":\"dc8076e7acfcf04c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b81724dae60b5071\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefPropertyEditor.js\":\"07a345639ac09428\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefTargetTypePicker.js\":\"e3303fac963882e7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/SelectPropertyEditor.js\":\"d4286c278dff9e78\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/TypesPropertyEditor.js\":\"032db16004a165c9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/defaults.js\":\"48dafb615fb06a5b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/kernelValuePresets.js\":\"8e414cdd0d8ee797\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/selectablePresets.js\":\"ae7a02c9ed5c510f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/typesPropertyUi.js\":\"1157aff0f32b0e27\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/AddPropertyForm.js\":\"1f000035d6d75a95\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyPicker.js\":\"0be1ecdb3e348a16\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyRow.js\":\"7d655719169d3a97\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/Rows.js\":\"c92e1bf19650eafd\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/actions.js\":\"752ed3887df14aeb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/declarationOnly.js\":\"5a3e36ea7422bfa4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/layout.js\":\"8f7a57115c35c487\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/model.js\":\"1094823c5527e1aa\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapeUi.js\":\"7d7a23041fcf5f6d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapes.js\":\"d5d50c5be4384f60\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/usePropertyEditingActivation.js\":\"204bb9cd3920218f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/visibility.js\":\"44a230f55e77dae7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanelSections.js\":\"055e704dc77cb9f3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockEmbed.js\":\"50508b9d00000401\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockLink.js\":\"f6648514e1e9b811\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockRef.js\":\"e50cf2f1beab578e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/ReferenceLink.js\":\"5a326ef303982583\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuard.js\":\"d6dfca660748d911\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuardContext.js\":\"803b90a92b6b29ac\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/linkInteraction.js\":\"58daada1a0940e2c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/referenceLayout.js\":\"c482ec19dd9eafe1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/useBlockRefAncestors.js\":\"698af8d1e8825a68\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockGutter.js\":\"9a57603681fed640\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockInfoDialog.js\":\"ececed45dd9fb109\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockTypeBlockRenderer.js\":\"f6c4ad46d1561674\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BulletHoverCard.js\":\"aef41933638641e0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorContentRenderer.js\":\"4d20b9e98091b032\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"a18ad77f958c2e09\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ColumnResizeHandles.js\":\"1cfbfac7a11954ee\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"881e7b448f7ee0a9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/DefaultBlockRenderer.js\":\"410f3d5fdbc0d630\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/LayoutRenderer.js\":\"b47b930c6d19a1fe\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MarkdownContentRenderer.js\":\"b83b516f62c5eddd\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MissingDataRenderer.js\":\"ce1760a8211be28f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PanelRenderer.js\":\"65605739097e9323\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PropertySchemaBlockRenderer.js\":\"4126344a5085aa4e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/TopLevelRenderer.js\":\"23e9954798a0461e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockGutterMode.js\":\"4e3edf1efb40219b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockTitleText.js\":\"5971618d6237b421\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/fieldCreationKeydown.js\":\"d44927312ac4d447\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/layoutRootContext.js\":\"c46d8644caabbb5b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/TypeChip.js\":\"eced67f59df10b8d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/chipStyle.js\":\"633cc4e17c21723b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/anchored-floating.js\":\"b19d55589978567a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/button.js\":\"f3873866dd2043c2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/card.js\":\"7a9c90b65a46091c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/checkbox.js\":\"013bc2e79ba97d22\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/collapsible.js\":\"b106cab35970b970\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/command.js\":\"8c3887cc50e44f66\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/context-menu.js\":\"badd3b9f707ed9b6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dialog.js\":\"81aed5bfe3aca085\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dropdown-menu.js\":\"267c9f46fe21e171\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/floating-listbox.js\":\"89519a6f4dafa14a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/index.js\":\"8a1692894241823f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/input.js\":\"41dcd177eb2dd51a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/kbd.js\":\"2f4365eb4041d9ea\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/label.js\":\"119ecdaae8e31f60\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/textarea.js\":\"6dd893601e91c4f1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/useEditModeYieldKeepalive.js\":\"66c1b67c9f0efcf8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/BootFallback.js\":\"3b5c1eb0e62c3f5d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/FocusedRowLazyMount.js\":\"72272200ed74db26\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LazyViewportMount.js\":\"26cae9df67a802ab\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LocalDbCorruptionFallback.js\":\"2cc7a687da33a205\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/error.js\":\"2afbe4122182a501\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/lazyMountRegistry.js\":\"da43f63bbdb0ae57\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/suspense.js\":\"15ac6d2a330bd05c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/CreateWorkspaceDialog.js\":\"5b3f003a5f8bc306\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/PendingInvitations.js\":\"eb79b6c5f8d1e573\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/SyncProgress.js\":\"75c80f74b3f6a675\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/UnlockProgress.js\":\"40063aa5c6fc47c4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceKeyGate.js\":\"886113511cc9fbf0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSettingsDialog.js\":\"af64142295c15c7e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSwitcher.js\":\"ff693bb7ad56df78\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSyncGate.js\":\"437a274c1d1e59a6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlow.js\":\"0f042648112cc7f8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlowHost.js\":\"aebe36d6063f6e37\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/EncryptionSection.js\":\"6391e7aab6853b36\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/attachmentPrompts.js\":\"150b0a50e71cb352\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3c526761556ed13f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowDeps.js\":\"c4f2d01d51f6c94b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowStore.js\":\"5250663551350d52\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/flowUi.js\":\"c0ffbca1f1cefe77\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/useConversionRun.js\":\"c69ac881fe8c1999\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/keyUi.js\":\"dfd42b1fcc524fa8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnKeyLoss.js\":\"ae6d8609c1b2684d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnServerE2ee.js\":\"b7cabb9aa340585f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/workspaceUnlocked.js\":\"89c92d98f91583d7\",\"/knowledge-medium/pr-preview/pr-1843/src/context/backgroundSubtree.js\":\"b3c3bae210e28764\",\"/knowledge-medium/pr-preview/pr-1843/src/context/block.js\":\"3a01ee5286d9a3c7\",\"/knowledge-medium/pr-preview/pr-1843/src/context/layoutWsContext.js\":\"4b72c25329b75e1d\",\"/knowledge-medium/pr-preview/pr-1843/src/context/propertyDisplay.js\":\"02a9f37df7ae2f2c\",\"/knowledge-medium/pr-preview/pr-1843/src/context/repo.js\":\"a0eee4ff0ec05910\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasClaim.js\":\"f4e74c714e88eba8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasSeatNamespace.js\":\"8b85341da1db04f8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockData.js\":\"a3bf6e48104d166b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockType.js\":\"ed1781c3afb6696e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/changeScope.js\":\"ee521aac4d18b41d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/codecs.js\":\"31f7607fa80f5f12\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/derivedData.js\":\"3925b77305523f0f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/errors.js\":\"0aca4c29af7ff326\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/events.js\":\"ff2550353d1de1eb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/handle.js\":\"22dbee37717741f6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/index.js\":\"9ce942e1d178d87e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/mutator.js\":\"dca476792ace0810\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/processor.js\":\"e323171067892087\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/propertySchema.js\":\"da55903a6c24f394\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/query.js\":\"7aca4d83cfe33dd0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/sameTxProcessor.js\":\"763ec16ec8f3e529\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/schema.js\":\"22dbee37717741f6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/tx.js\":\"22dbee37717741f6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/typedBlockQuery.js\":\"aabbfc2dc898c439\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/user.js\":\"fc3b0b1f4fdd7861\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresetCore.js\":\"5d348da50c3006ea\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresets.js\":\"9697ea2769eb9b5d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/attachmentCleanerIOVerb.js\":\"4a3454ef8ad91d4f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/block.js\":\"98d25213481fd615\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockCache.js\":\"d1705116b4e76513\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockId.js\":\"aff575819eca482a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockLiveness.js\":\"6b585cd46fb46410\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockMerge.js\":\"1c4b6f73f239e1b0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockSchema.js\":\"8a2b73e43b34ba34\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypeLookup.js\":\"5c4587bbc524a4cc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypes.js\":\"b41056ccbc697949\",\"/knowledge-medium/pr-preview/pr-1843/src/data/clientContext.js\":\"4e981399a0ba799a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/dbFileSiblings.js\":\"240c72adf1aba3e3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/definitionSeeds.js\":\"ec7873729649ccbe\",\"/knowledge-medium/pr-preview/pr-1843/src/data/derivedIds.js\":\"2eba4ebc8b81d8d6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/drawnSubtree.js\":\"0534cd4578950369\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facetBridge.js\":\"71d7fa47798c43fc\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facets.js\":\"4acc2d54b4d2f675\",\"/knowledge-medium/pr-preview/pr-1843/src/data/globalState.js\":\"53a4f093b621b8c2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/aliasClaimRederiveProcessor.js\":\"08d322e7401e0e88\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/ancestorBatch.js\":\"6f58b5516de325cd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/blockTypeTypeifyProcessor.js\":\"0680cc774578c074\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/clientSchema.js\":\"a2d7bb0795ef519b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/commitPipeline.js\":\"b351d7d8984998e5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/devAssertions.js\":\"de4c6388e31a1745\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/firstSync.js\":\"68f31d38e8f6208e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/freshInitialLoad.js\":\"597c0811f10c78f8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/graphBackfillClaim.js\":\"de7b0f0185957b2c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/handleStore.js\":\"f424bdd8830410d0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/idleMarkerJobs.js\":\"5f9c5bc8487f9f06\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initialDownload.js\":\"37e11ff2386cc844\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initializeClientDatabase.js\":\"02e4ecf05e92b80c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/jsonCanonical.js\":\"f7ee6f8503ebb2b3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelInvalidation.js\":\"12adcebb967ffe88\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelProcessors.js\":\"8c81b275dcf858a8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelQueries.js\":\"07c63b293513cb5b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/mergeTypeMembershipProcessor.js\":\"2f089260b38ea53a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/normalizeReferencesProcessor.js\":\"0a71edc8645f0442\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/poolInstrumentation.js\":\"a91934c410bb79ff\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/processorRunner.js\":\"7043114a63f5afca\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyCellBackfill.js\":\"5db303509ce078a5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildMint.js\":\"637f67b789bf0d1e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildrenProcessor.js\":\"ea2f3fc513ebe159\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9f1dc5b5e25397a8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionSynthesis.js\":\"11651798f407c4fd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyKeyScan.js\":\"0f0f75e6fdc5e441\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertySchemaResolution.js\":\"05a6b2a757e0a8f1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyValueEdits.js\":\"eb6720f89f186615\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/raiseProtocol.js\":\"6e7f5bf604e842f2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/readBatch.js\":\"4289f7899942c755\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/refProjection.js\":\"ca51d2bafb7d46ef\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetLookups.js\":\"383ae79306247800\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetProcessor.js\":\"4816f7d9d843adba\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/replayMerge.js\":\"f6b6d48c418bd747\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/sqlBinds.js\":\"23290edfb61db6d0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"669241594104e639\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/arrivalProcessors.js\":\"1ab38d56fdabe1c3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/invalidate.js\":\"c5d2cc67e6060010\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/materialize.js\":\"3109603ceded4453\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/observer.js\":\"8c4725e9495107d4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/reconcile.js\":\"c67db9dbd1704645\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/timingMetrics.js\":\"4dfec65d1f36f5db\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/treeQueries.js\":\"40e6a9b28ee83098\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txEngine.js\":\"0f8efb83ea8b3eff\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txSnapshots.js\":\"15b754f6ef4dbb0a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/typedBlockQuery.js\":\"3454aff71eef2d1c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/undoManager.js\":\"5c141fd13ae298b5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/invalidation.js\":\"653dc283616faf74\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelDataExtension.js\":\"f529e67a8e21aa67\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelPage.js\":\"66f1901504c4ca4f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelValuePresetCores.js\":\"54c51eec45d760ee\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbCorruptionSignal.js\":\"5accbe0e46cf33e5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbStorage.js\":\"13059f66029c111d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbVfs.js\":\"13f39f6979f19703\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localSchema.js\":\"65134675cebf7a3c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/maintenance.js\":\"f896557e93f0ad61\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mergeProperties.js\":\"7b1e34f8c6865956\",\"/knowledge-medium/pr-preview/pr-1843/src/data/metricsConsoleHook.js\":\"05dea74b0651921e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/migrationsPage.js\":\"74d835018b1eff99\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mutators.js\":\"c317019482012c32\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKey.js\":\"c4678dc67c1dd97f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKeyPlacement.js\":\"4c7106f949f3b8d1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/outlineSurface.js\":\"cb3d401211f7832d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingEditorContent.js\":\"d31ed8a77d60a314\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingUploadsSql.js\":\"b470038a124df093\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pluginStateExtensions.js\":\"2fab818e8f2585f9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/powerSyncLogger.js\":\"0f668baf1d9cbbfd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/projectorRuntime.js\":\"d8a6a505774e3cc1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/properties.js\":\"1066c8f4b0bcac7a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertiesPage.js\":\"95c1c4f9a5ecd649\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyChildren.js\":\"22509abad5d8dc2a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionFanout.js\":\"f626e3f888254d56\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionMetadata.js\":\"963c48921e432fc2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionRegistry.js\":\"253c6f2c565a610a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDisplayMode.js\":\"99148771b5c8b6ca\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyRowCreation.js\":\"f45a3f3e10873f3d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySchemaCreation.js\":\"eef10e19e35e6bf4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySeeds.js\":\"24f584f5268a07ef\",\"/knowledge-medium/pr-preview/pr-1843/src/data/recentsPage.js\":\"40015311a819ee45\",\"/knowledge-medium/pr-preview/pr-1843/src/data/referenceBlock.js\":\"c17863c8fd3b4ed5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rejectedUploads.js\":\"7ca292f4de0ba289\",\"/knowledge-medium/pr-preview/pr-1843/src/data/releasePowerSyncConnection.js\":\"d3f235f33c772b0b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repo.js\":\"e662597d963e2112\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repoProvider.js\":\"0a29a7f5b3c395ab\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rowProperty.js\":\"ed1e4fe8dd8ff4fa\",\"/knowledge-medium/pr-preview/pr-1843/src/data/searchFilter.js\":\"2710cd16b2aa8b5d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/seedIdentityLedger.js\":\"d4d7a723fa498d97\",\"/knowledge-medium/pr-preview/pr-1843/src/data/stateBlocks.js\":\"47b624942afe880a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/structuralEditPolicy.js\":\"5b0e5a67eac87cb8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/subtreeDelete.js\":\"aa98e4c5b433e724\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncStreamLock.js\":\"25ef25fe1fbb7114\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableSqlRecognizer.js\":\"0056180211c12d5e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableWriteGuard.js\":\"650434abd222c167\",\"/knowledge-medium/pr-preview/pr-1843/src/data/targets.js\":\"6cf2e3f650b56a9b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeColors.js\":\"518ccb0fc52b97bb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionMetadata.js\":\"9dc660d1ad0bf8f4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionRegistry.js\":\"3cd0d2fca8948eaf\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeExtraction.js\":\"257c2f79e071d30b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeInitialValues.js\":\"eb50ef877b17e861\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typePropertyGroups.js\":\"ea661ab71735404b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeSeeds.js\":\"38daf6ad06829f5a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeTagger.js\":\"0358e0ec7e8f6e5e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typedRecords.js\":\"7e5f03e186ff2dee\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typesPage.js\":\"db607dc20429d6a6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userPrefs.js\":\"f85696b04cc7fa7b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userSchemasService.js\":\"cb50ae3e49e00b4e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userTypesService.js\":\"d3098c2284d2ec69\",\"/knowledge-medium/pr-preview/pr-1843/src/data/valuePresetRegistry.js\":\"21d38dc1d217ff42\",\"/knowledge-medium/pr-preview/pr-1843/src/data/visibleChildren.js\":\"3fb76c517f413634\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceConversion.js\":\"78f526440054da59\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceFirstSync.js\":\"b44afa2552e8d022\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceIdNamespace.js\":\"45b7dd6c9b36c2d9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceSchema.js\":\"3a9da5470fe63136\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaces.js\":\"7e7ff283d423b821\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadLog.js\":\"6b1db1c197a59a3e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/BlockPasteShellDecorator.js\":\"7ee16949a162f79a\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/atTrigger.js\":\"faa7dd1fe5940d0d\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/autocomplete.js\":\"a43b8f6dc9b9910b\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/codeMirrorExtensions.js\":\"fed121158e94b60b\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/contentFlush.js\":\"188e38b2d9fcf8cd\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/defaultInteractions.js\":\"d0413efcd5e495f0\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/editSettleSignal.js\":\"fe2fe9c1a3ef4eae\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/insertImage.js\":\"174ae5d66b71eb60\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceCompletionRange.js\":\"80fb2c3d82ce4a31\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceTargetTypes.js\":\"cce64d0b68a83b63\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/syntaxContext.js\":\"93c4d447a4834598\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/triggerMatch.js\":\"adf95a2dd1f9efd3\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/AppRuntimeProvider.js\":\"ff41e20b038990f4\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/BlockFocusShellDecorator.js\":\"693d5baf89de4846\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/ExtensionRenderBoundary.js\":\"5ba6b2a486bc9bdd\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/PanelContentRecovery.js\":\"c62748a2af2d69be\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/apiCatalog.js\":\"48d2a8cb710faf07\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/approveExtensionHere.js\":\"ad2430c001308f4e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/armedCutAppMount.js\":\"d7cc0098caa981de\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/batchableKeyedStore.js\":\"d9cc9230034b0b1e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockInteraction.js\":\"31e20e0cc244e721\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockSelectionAction.js\":\"b5216eab7c3d273f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compileExtensionModule.js\":\"a5c763d7b9599273\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compiledModuleCache.js\":\"2b62365a54014fbb\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/continuousGestures.js\":\"c91671e80511cf1f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/core.js\":\"4bd9574f394e4560\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/defaultRenderers.js\":\"87f2b7e0261ead85\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/definitionFanoutAppMount.js\":\"26fa8ed8dd098637\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dialogAppMount.js\":\"974b2166d8515c3d\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensionSeeds.js\":\"5e102475101362c3\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensions.js\":\"5f57bfbba2308224\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/exampleExtensions.js\":\"164ad3993ce108bb\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionApprovalStatus.js\":\"67a7b818eb9140ec\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrorToast.js\":\"71e3a9471864444c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrors.js\":\"ec5399f36f6f397c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLookup.js\":\"a5820fbac76f86c1\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionToggles.js\":\"3bf3705cb76ec5e9\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionUtilitiesCss.js\":\"132ba07b2cdb2098\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/kernelPageDeletionGuard.js\":\"d8ae7718b57a1b37\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/liveRuntime.js\":\"69f9fc2f4d21bb76\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/openExtensionsSettings.js\":\"39201617b16eced9\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/overridesCache.js\":\"8f692c1942b8d8a0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/pluginIds.js\":\"b9e6a07ae546c8ce\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/processorRejectionToast.js\":\"a7938b687e6c6a48\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeActions.js\":\"af12bebc8186b832\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeContext.js\":\"e53798d9f4b9b54d\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticAppExtensions.js\":\"ae383cb6a9e99399\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticDataExtensions.js\":\"99d00a8e724e5e5e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/toastAppMount.js\":\"4092c12dac5112bd\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useOverrides.js\":\"b818da04ebed36ba\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useShortcutSurfaceActivations.js\":\"e50da151f0acfb5e\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/discoverToggleTree.js\":\"a71716a4b55db9b5\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/facet.js\":\"d2efde0171c9340b\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/resolveAppRuntime.js\":\"34a85afd195f1baa\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/runtimeEvents.js\":\"e05e79ad96eaf297\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/togglable.js\":\"f3b93c2a81532584\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/variantFacet.js\":\"e643a12209fcc1ca\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/verbFacet.js\":\"489b1542e69eba00\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/block.js\":\"0ba0ab9db5450f84\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/focusedChild.js\":\"5db2a7c8d2fbb15a\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/propertySchemas.js\":\"4f7455e95bd28ff1\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/typeRegistry.js\":\"93d2d437f4dc4275\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAncestorCrumbs.js\":\"5a8faf59c2781498\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAutocompleteListbox.js\":\"cd9cb895b2c0b8a4\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedSearch.js\":\"fda9c79cdc98b52a\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedValue.js\":\"ec0e18f148505a31\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsFocalRender.js\":\"441ebcbf31a3b95b\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsReadOnly.js\":\"dd00829965beb661\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMaterializeBacklog.js\":\"f16f1db40958b97e\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMinuteClock.js\":\"95a7c86a4f7140d2\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePanelLayoutProjection.js\":\"da30638016cc9ff1\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePendingInvitations.js\":\"36ef1d7ae23774c6\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRendererRegistry.js\":\"a767fadc92c429e9\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRetainedFieldRows.js\":\"3ffff468e93e6a4f\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useWorkspaces.js\":\"1b70528a8f194820\",\"/knowledge-medium/pr-preview/pr-1843/src/lib/utils.js\":\"842685636ef7c842\",\"/knowledge-medium/pr-preview/pr-1843/src/main.js\":\"80ff2ffde4d2ecb5\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/MarkdownImage.js\":\"18d794afd55d16c1\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/blockSeparators.js\":\"631b88c77b062cc5\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/context.js\":\"610a55561c55d4a1\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/defaultMarkdownExtension.js\":\"bde7640d5a2a6615\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/extensions.js\":\"8667bea93be857d9\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/renderMarkdownHtml.js\":\"ae9348f3441b1aad\",\"/knowledge-medium/pr-preview/pr-1843/src/minimal-editor.js\":\"d5f65f659596b2fd\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/armedCut.js\":\"9635961aa57387c1\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/captureMediaVerb.js\":\"7de7bdcd199efdb6\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/clipboard.js\":\"2ef692309198fb67\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/decision.js\":\"e5d572d2ccb59737\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/operations.js\":\"8f69fb2b7fbdd73c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/AccountHeaderItem.js\":\"1cc3caadf024f1d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/index.js\":\"506a910a500434e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"38bce28526e13e39\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askAgent.js\":\"4ddb716e41bf8b0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askedStore.js\":\"23189e1a927d57a0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1eeb3e073dfa9668\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/chipState.js\":\"e7b647581da82071\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/dataExtension.js\":\"83a047fa4030faae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/index.js\":\"495c318b1696dcc9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6f345f734c2b1530\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/schema.js\":\"4fb027e2ea7eb5f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2e048094cb8b2642\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/BridgePairingDialog.js\":\"f349a524127a120e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/addMedia.js\":\"b7bbbad3d428542b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d362b03a479d1580\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/block.js\":\"a60e9433be25da2d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/context.js\":\"a957c78e3ce8d66e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/displayIds.js\":\"98decdf26a987a9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/index.js\":\"719b35e0db37d147\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/outline.js\":\"f33c0a80743ae18a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/properties.js\":\"efa01fb0c1458ea4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/refs.js\":\"cdd01e5cd4162301\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ee02e6d80676d8fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/search.js\":\"436c7124014dd11a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/shared.js\":\"50c2482f33c297a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"534da5511176c78d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/text.js\":\"2151ec67e3c1b21c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentWrites.js\":\"a81500d3638f8628\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/authoringCatalog.js\":\"d2ad37d19af63314\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/blockRefTargets.js\":\"dee618e1007366d1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridge.js\":\"2e6839cd4197546c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridgeLoop.js\":\"86de955b32a2582c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/changeHistory.js\":\"539fbd9ef96cc0d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commands.js\":\"41d72897beca4b68\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commentsCommands.js\":\"fc57e281f0d06523\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataExtension.js\":\"f73df3ba3d46bf66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataModelGuide.js\":\"87ee996a0f86a1c3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/describeRuntime.js\":\"b9f198c2c879e9bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/extensionLint.js\":\"f6b43ce8129de3b5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/grainAudit.js\":\"6a01768de7e6426d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/healthCommand.js\":\"24350037ae490542\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/index.js\":\"b0b87f67b297f26b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/presetIdentity.js\":\"619513260d633078\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d101a0a4c4f4c8b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/readMedia.js\":\"ae27b1e45a088a35\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/schema.js\":\"21c06b12532077c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/serialization.js\":\"db791a9534e70f32\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/targets.js\":\"6ba82940fbfb31fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/tokens.js\":\"b3a2e61f1964cb72\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/watchEvents.js\":\"f4bc70a6c3fcffbb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/workspaceGuard.js\":\"68285543a754b961\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/writeCommands.js\":\"3a1b4ced02e97c9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/AliasCollisionToast.js\":\"00fc1cb2047061ad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/DuplicateNameBanner.js\":\"1a158941b8779ad2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/collisionMerge.js\":\"5a4475decd69859b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/dataExtension.js\":\"e8f68b67ae81cf8d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/index.js\":\"d064600bed771adc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/mergeCollisionAction.js\":\"9df507f15a7b8345\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/pageStyling.js\":\"1545c9d134aedc01\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/rejectionToast.js\":\"3bcaa10539b4c9a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/syncProcessor.js\":\"39ce24d9e21c05fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/actions.js\":\"10c664e1fbebd5a4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/addComment.js\":\"67e998cf9d022363\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchor.js\":\"72c4e5614c738a6a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchorState.js\":\"e29078418cf0515b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/commentLinks.js\":\"ff5128c2a033254b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/confirmThreadDeletion.js\":\"549606ea76124086\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/container.js\":\"dd28dee5593dc02a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/dataExtension.js\":\"fccd12cccd35295b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/deleteComment.js\":\"348212877a8535f0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/highlights.js\":\"24f12f32151430da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/index.js\":\"b94e9e69ca0405dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/linkedCommentsPill.js\":\"35e711fc3097de03\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/margin.js\":\"c453586d1bdeb20d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/marginSchema.js\":\"85c108c9df4115c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/newComment.js\":\"bceb532c33613cbf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ownThreadPicker.js\":\"3a9dbfdb25250992\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/placement.js\":\"2a02fab599d53cac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/queries.js\":\"041f9319ea42f405\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotePosition.js\":\"45aefc41fc8aa0c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedIn.js\":\"a5fd4a3da4e31c09\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedRange.js\":\"d89a9abda7cd8093\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/rangeRefs.js\":\"973f53b54511e14d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readHighlights.js\":\"783ec9468883d359\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelection.js\":\"1431ec446b482a64\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelectionUi.js\":\"e53fe2e8249c9e67\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/reanchor.js\":\"d4e832390a65ffad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/schema.js\":\"779de01963681535\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scope.js\":\"61cb926e265eb16d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scopeThreads.js\":\"cf06028ea9c22e04\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/splitRetarget.js\":\"cc770cf4df5e15f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestionCard.js\":\"cee43b1e240b51ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestions.js\":\"978e6290c310988c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaries.js\":\"93a3a2d13e02ffd5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaryBatch.js\":\"75749ba3d56218a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/surface.js\":\"d48fcf32c876dca6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threadNavigation.js\":\"821c1cf62fc0d6f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threads.js\":\"96fdb853231b4f15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ui.js\":\"913efd7731f11cdf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/uiStore.js\":\"f2f072e576e4295a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/appIntents.js\":\"72d17597b540ebe7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/index.js\":\"f5eb719c15109ca2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/index.js\":\"037373c858a22b78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/status.js\":\"5f67da7cabc1d9bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"96919a865b7842ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaBlockRenderer.js\":\"776df84a985d4a21\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaDownLaneReplicator.js\":\"fa78055cab0cc80c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaUploadReconciler.js\":\"9b3a1010afcc9205\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetDownLane.js\":\"133e9073c2ecbe34\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetResolver.js\":\"d880ebaf020e355c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetUpload.js\":\"55481b55e87df7c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/attachmentCleanerIO.js\":\"5761483be99b9441\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8d76ff03f9f330f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/blobStore.js\":\"53c1cfafd65f2b81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/byteStore.js\":\"52bfdd2d8b6c64e3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanerIO.js\":\"ec36c7dc2a78d2e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanupAttachments.js\":\"6caca19806f00a78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/dataExtension.js\":\"d7cff158a86e0fe2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/downLane.js\":\"204698f6a27f5175\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/index.js\":\"ecebffa9b331d253\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/insertImageContribution.js\":\"a0932fd7b943f853\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneArming.js\":\"3b7f35aa79a594e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneLock.js\":\"3f06f21a094c06ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaBlock.js\":\"59bc0b220489fc80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaCapture.js\":\"4c14c5b901da15e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewers.js\":\"dd21d1fec71e507a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewersFacet.js\":\"a16b677e76b71d6d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/pasteCapture.js\":\"866a81064352738d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/resolver.js\":\"d8f56e5334b775a3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/retryUploadsAction.js\":\"7d6c93a9434b7d07\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/storagePaths.js\":\"60548278e37d940b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadDrain.js\":\"0541040416abf0ae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadLaneStatus.js\":\"f93f3ff06a3a6aa3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadReconcile.js\":\"d36105907304384c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadRecovery.js\":\"1b740dc372e705e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadStore.js\":\"2dbbb1bbd35587be\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/useAssetObjectUrl.js\":\"473481edf6a413bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e4de78512b6ddc4b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0989ab3faba17c66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/facet.js\":\"34990f24fd36bf42\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/index.js\":\"4a9d31bf77dba85e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/prop.js\":\"1b26b316969ef2f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinkFilters.js\":\"c581e0595ea8d30d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"8c96b60b2b8b496f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BlockEntry.js\":\"592ca9cea2b8f956\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/LinkedReferences.js\":\"d8dfe2edf5de1c04\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3d2b54758b6a705d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dailyNoteDefaults.js\":\"0b4852a0219a1a8b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dataExtension.js\":\"99406d398af1369c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/edgeExclusions.js\":\"21aac6509a4de5c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/filterProperty.js\":\"1232a8689717ef86\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/index.js\":\"bd1af8a931c826d5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"30240fdf2b5f18a5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/applies.js\":\"a18ec2fc7c95adb1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/countQuery.js\":\"90544e4b529eb342\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8f3114afdd40632c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/index.js\":\"10429ef8799c1c15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e59f4ddb2670ceed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/presentationInvalidation.js\":\"3d2e6cd1c8df4008\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyEditorOverride.js\":\"340ea7a0a50cfb49\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyFilter.js\":\"21b48a3dac694500\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/query.js\":\"bc3b405dcfa0487f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/resolveFilter.js\":\"5498ccdce6e5f0c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sourceBatch.js\":\"f00ff26831a65066\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sources.js\":\"1c3728377c4d1de7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useBacklinks.js\":\"e201e85d6922328e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"71808a1fc170acd0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayCelebration.js\":\"480ac345c9d09122\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayOverlay.js\":\"b93a792e4f88beb5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/gate.js\":\"6782fcd340b0ba94\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/index.js\":\"3d569fe93d9c54f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/wolfTheme.js\":\"075b9a52f06d118e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/BlockDragLayer.js\":\"89fe11045cf55c9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dragController.js\":\"4dba76f54b0d3db2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dropTarget.js\":\"8eb12130a80cbd40\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/index.js\":\"a90301abc9fd498f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/projection.js\":\"0d3b85fdc032f5f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/BlockMetaCard.js\":\"accdf4a0b29aedb3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/index.js\":\"b01cf6e61fccc41c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/AddTagDialog.js\":\"a0031919a38a9b2e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b1ec786dc9238796\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/TagNameIssueHint.js\":\"76d70f5f7d69c591\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/addTagAction.js\":\"3e372c479c305d37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/appendTag.js\":\"524e7bad02fd2fdb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/config.js\":\"1fcf1aae6209f3de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/dataExtension.js\":\"7860248b389b8c85\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/index.js\":\"1b4602ff4c43bf42\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/propertyEditorOverride.js\":\"c7a15e97818307c4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbList.js\":\"fd8c9b22317bac08\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"971480a729556f61\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f83146acbbd6ec2d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"d3d783d9c2e94c9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a461dc10d8fd7b93\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/index.js\":\"ed02c8ebeab50f00\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"368e1e58d85e253a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/CharacterCountItem.js\":\"a56118dfa425f5c8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/ProfilePropertyEditor.js\":\"553f23a6b98b894c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/actions.js\":\"383988af1c0a44f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/blockType.js\":\"0f87a51e0b0d1cb9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/charCount.js\":\"be113a4a6ae1e4a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/dataExtension.js\":\"32dd7304c0fff0c4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/index.js\":\"015f8b1ce3d25380\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/profiles.js\":\"3e59e02319787972\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/properties.js\":\"ac0bfd9c3627f243\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/textCounts.js\":\"90214f8f6becfbb0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/colemak-keybindings/index.js\":\"93ad72daff5294d2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/CommandPalette.js\":\"303f3a9adeb74932\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/HeaderItem.js\":\"3673a94edcda8d80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/context.js\":\"98a3365603f0a6dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/index.js\":\"135ef9a8ec5d5a5f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/selection.js\":\"335126e86cb5504d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/toggleStore.js\":\"595b7ca875a15cf2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/useCommandPaletteActions.js\":\"17b76ef86a503404\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/ContributorBadges.js\":\"7e6ce5865ce7c3aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/author.js\":\"b253e40dc41e4e4b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/codeMirrorExtensions.js\":\"99e7b50a272a12aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/dataExtension.js\":\"f86afb275237f815\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/index.js\":\"c1784c84a5c76311\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/mentionAutocomplete.js\":\"80419f54fca6aee1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/processor.js\":\"f6f35a894ea42d65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/profiles.js\":\"7ed2e6f6a9f0451f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/queries.js\":\"f1c292584e1ba4da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/schema.js\":\"f191aad478e7d229\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1d3ef60d42eb4e37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c634d287698daeae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/index.js\":\"aec3beb0df91cc4e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"50ccff8cb597138c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"76082c9546e5bf4d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/CalendarGrid.js\":\"2539a3e90810dc63\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DailyNotePicker.js\":\"243b9d8b725fc866\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"5eea59252c09f8f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateNavDecorator.js\":\"d6dd1a1baf0b66e3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateScrubOverlay.js\":\"b7043e9c4c49eb14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/HeaderItem.js\":\"7b0dc351f777c1c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/ReschedulePicker.js\":\"a4ab63964a7c304f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c7a6d989b4a2b36d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/actions.js\":\"e407269ca9f13ea4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/blockDateAdapter.js\":\"6e5fcae4524b8600\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/calendar.js\":\"4b58cd0d010bfdcf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dailyNotes.js\":\"98dffc716b13a5ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dataExtension.js\":\"ca450880296744f3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubActions.js\":\"be7104eb71029471\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGesture.js\":\"cf0344b8ff6cd40c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5e72b7d8e69ef2c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubRecognizer.js\":\"49d6b0c4e85fac0d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/deletionGuard.js\":\"f79c48f1c9db8efa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dueQuery.js\":\"13bc17cd8c7ce221\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/index.js\":\"fe9cdedcda5baf18\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/landing.js\":\"5214173153770d0b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/localSchema.js\":\"4a454caf393d00b0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/referenceDateAdapter.js\":\"3833636e38998c99\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/rescheduleAction.js\":\"22657931aa5ed26d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/schema.js\":\"b0e5e160e0598b8e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadBlockDates.js\":\"8e3d74d2be6c6341\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadDatesAction.js\":\"da5ebd4ef04f8eb6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/today.js\":\"2b3fd7793ec72cd1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b74860c19e8f5064\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"43918f3403d84e79\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/audit.js\":\"d26920110a8c709c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditAction.js\":\"68a971e8feb70a48\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditRanges.js\":\"84bdd518202c0986\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/diagnosticsSource.js\":\"b60ae3477b830a69\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/divergenceScan.js\":\"e1f048b455b39bac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/index.js\":\"6660797a311d2f69\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6e9d9c13fd109af8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/referencesMirror.js\":\"20c834f7871a2f0a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/rowJson.js\":\"963c22f87a9f0e65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/schedule.js\":\"f0c911eba714c5e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/store.js\":\"617eb614997809e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/action.js\":\"26d3c94ec8b8b50a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/index.js\":\"d4ff7a8655455f2e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/plugin.js\":\"24760759a0fcb63a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"026dc98981ce5fba\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/actions.js\":\"99177aa6970c8418\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/changeMarker.js\":\"2c24b50132d14a6a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/diagnostics.js\":\"a18eeb6f726ce5b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/fileSystemAccess.js\":\"ab66ae85df27364d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/filenames.js\":\"294863aacf0d4f15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/index.js\":\"54d3a76e1d70466a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/mirror.js\":\"940b537fcc5cee38\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runLock.js\":\"2eac5c7a20e38184\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runtimeHealth.js\":\"79854629b47196b8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/schedule.js\":\"3108f9c53738c4d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/store.js\":\"b4420131e431c7a5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/index.js\":\"4631a8bcd8b1293b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/themes.js\":\"9e35b5bd96ef8212\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/facet.js\":\"55139b23d46f2955\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/useDiagnostics.js\":\"376edb6999144baa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/dismissals.js\":\"4030c61b6b71a58d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/index.js\":\"8352eeea5a89fb3b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/status.js\":\"aa4a26ee4dcc3f79\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/store.js\":\"ee028bf8ec0f9655\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d139c4be2772a399\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2fbc63dafd2fa33c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/actions.js\":\"9a3fe1e549c2e520\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/config.js\":\"350d9f336f304aed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/dataExtension.js\":\"065032198758b95d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/effect.js\":\"d76dcb0b0c0eb75f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/index.js\":\"d36c3cde475f4801\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/propertyEditorOverride.js\":\"68649d3ebafa7e85\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/useToggleTree.js\":\"9f4b240249c81d04\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/ExtractTypeDialog.js\":\"09a186eb8ab6c9ee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"1fa4a2f1ab5152e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/PropertyShapePicker.js\":\"b89664e5328380f2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/action.js\":\"78aedb11b8705b9d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/index.js\":\"b6abb722d0edde87\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/FindReplaceDialog.js\":\"8be2e4097e8a868b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/HeaderItem.js\":\"fdc8e9bb3bc5bdb6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/dataExtension.js\":\"f0c441b4cf1289a9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/index.js\":\"87bb0569604971ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/search.js\":\"ab854f36705b0d4f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/toggleStore.js\":\"fd8bbfb984bcb5e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/LocationPropertyEditor.js\":\"59f177cbe6568ffb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/MapView.js\":\"c10c876ff46fbc99\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/blockTypes.js\":\"67ed8aeaf036d4ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/codeMirrorExtensions.js\":\"2752e22a380088a1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/createOrFindPlace.js\":\"536a9e8d812d2de1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/currentLocation.js\":\"b79a726e09d3a667\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/dataExtension.js\":\"fcdb6fc07d08f265\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/geoContentDecorator.js\":\"a7abe094ab44d4bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/googlePlacesClient.js\":\"75f66fae03a7ba76\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/index.js\":\"cc9f642c3647287f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/locationsPage.js\":\"0c3b9a52b8498fae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/mapViewport.js\":\"6b1079533898049b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/pickCurrentLocation.js\":\"a604667760becffd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeAutocomplete.js\":\"0ecc47934b2d6779\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeNameCollision.js\":\"8ce1857642c34a65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/properties.js\":\"842c07b70118409f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/propertyEditorOverrides.js\":\"d9699e27ddfd7775\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/query.js\":\"088f9a4ed66fa198\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/usePlaceSearch.js\":\"a84daeca6b80e517\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"571c52a07bb47470\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3b0f05ca43901cb5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3809dca206d8e165\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/config.js\":\"d3999117a7249a09\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/dataExtension.js\":\"019037bbe271e97f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/facet.js\":\"9873db39e33a0262\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/grouping.js\":\"f03f61c4b6144f5e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/index.js\":\"4458185d4abbdffc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5ae48bd4bc871afc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/query.js\":\"6fce61bbe01a8859\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/resolveConfig.js\":\"c46f69c6e655b7fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4678e4065308f346\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f6d453742081acfe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlDocumentContent.js\":\"eeaf166f95391e8e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlFrame.js\":\"c079b7ac6e7e6d94\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/actions.js\":\"4535b8af4f32f5ae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/blockType.js\":\"84b3031dc85ec796\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/confirmRunScripts.js\":\"b3e005d3bf6cc3d5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/dataExtension.js\":\"0dd5d668c36b8735\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameAnnotations.js\":\"4e5630b423c335f8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameDocument.js\":\"c7acc491647e213d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameTheme.js\":\"a6758adcc19f89df\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/index.js\":\"cb5c32acd26a2a58\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/scriptConsent.js\":\"089311abf58dd741\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/sourceMap.js\":\"69098b2438a4ab92\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/useDocumentScripts.js\":\"4b7b071da6025641\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/index.js\":\"cf4fe42a5b825d4b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/record.js\":\"05c3af0a7d6c6eca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/recordStore.js\":\"d8b3fafeecb11838\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/responsiveness.js\":\"a87cf8bdeaf450cf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/schedule.js\":\"6bf9ef8693af2ceb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/sessionContext.js\":\"46dd38f7c57a941c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b9cf8438d6f93ed4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0080c272f8814324\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/actions.js\":\"499a7bba18df741a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/config.js\":\"70a6c812956a6dc5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/dataExtension.js\":\"4b61ddb083c53589\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/effect.js\":\"e795e036bd758212\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/index.js\":\"23d629913c118b85\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/keyCapture.js\":\"d591fd719d5a4319\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/overrideStore.js\":\"2df8c372943789f8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"35d1483ea821abe8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/HeaderItem.js\":\"ba9b4aef41aba56c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/LeftSidebar.js\":\"9f7239a7a2dfa394\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/actions.js\":\"8f0c88bfb7d71a97\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/facet.js\":\"83911ccede71fb97\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/index.js\":\"4bd98ecebfa7af55\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/shortcuts.js\":\"eb4d49700a04cd39\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/toggleStore.js\":\"ab3a341f9090f7c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/MergePicker.js\":\"5f1f2e9e2c026653\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/index.js\":\"4346e69fcaeb4d81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/mergeAction.js\":\"a51700e1d3294b05\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/strategy.js\":\"552c853e0c552fb1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/Button.js\":\"5567f19af10fbd20\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5e4d9466f38b2e6f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/defaultItems.js\":\"eb612a5a757f99c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/facet.js\":\"7b637f3894ca13f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/index.js\":\"72fdb308758c4566\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"601e1ffb42e08472\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c33688895c581c5d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"653ab44a4f98e184\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9a0a74734bc9521e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/index.js\":\"8c2915463e2c98e5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1e7bf429e133704a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3eab2616b31fc72e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/contextMenuItem.js\":\"e8293709e8c51fcc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/index.js\":\"08e441b1037c7f3e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveAction.js\":\"5d114adf05ea7e58\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveBlocks.js\":\"413cd60495c2d80f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/selectionAfterMove.js\":\"23d5e85abef15b94\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/TutorialBanner.js\":\"cde51c0c6661a6e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/action.js\":\"52fc95da7fa8f6f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/bannerDismissal.js\":\"c7f6283b20e50dd7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/documents/cheatSheet.js\":\"99787fe105ff6a31\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/index.js\":\"40b34fc9bcc0a7fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/keys.js\":\"0abd066ffa929318\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/landing.js\":\"adcbb30dec2c608b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/outline.js\":\"80a52ecb7b004391\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/seed.js\":\"e5a30512258e7c80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7376c0a19ecf3b6a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/analyze.js\":\"09291a28097e21bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/diagnosticsSource.js\":\"fc2276f1a3d6b5ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/index.js\":\"bf1c9d02e3b19a67\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/load.js\":\"fdcc97a361a7147a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/monitorRun.js\":\"f9cde7ba85565d0f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/schedule.js\":\"e4c8ee402d9b7a0c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/series.js\":\"9f77558693b2c6db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/store.js\":\"2a0457aae4a338bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/trendAction.js\":\"86436b229b0eb3e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/verdict.js\":\"911562020a92e95b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/clickToEditAction.js\":\"bb52748dca813997\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/index.js\":\"db66d111aec0d4c4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/interactions.js\":\"73bdd5b0bff14e66\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a0ff71b4d1a2eda7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGate.js\":\"57e5ff54842998c4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGateDialog.js\":\"95c14280ffa58af3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/action.js\":\"5a7ab7beb528a38b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/index.js\":\"871f547ca283972a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/localRunMessage.js\":\"002d8924ec9f1e74\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/plugin.js\":\"5744d31103c2af5d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/progressReport.js\":\"7dd96cabbabb6353\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/sweepProgress.js\":\"2859fd2119c88c65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/FieldRowRenderer.js\":\"ef6e4921039f52fe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/ValueRowRenderer.js\":\"12f3399626fbd39c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/actions.js\":\"09d42060f635350a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/autocomplete.js\":\"f805dc82b5342dcc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/fieldRow.js\":\"0578e7f9036fe939\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/index.js\":\"5bc4d0c8b2825a18\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/referenceWarning.js\":\"bdecb6325e615c22\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueAutocomplete.js\":\"355aea47cd885d6e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueSchema.js\":\"762f4a57b2b7499f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/HeaderItem.js\":\"042d4f68b14cd6db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/QuickFind.js\":\"c67dc32ae023fbc1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/index.js\":\"646e2f327a96bc18\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/recents.js\":\"c600a0d307959dca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/resultItems.js\":\"83380c370091942f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/selection.js\":\"0f9b0499df5ca52a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/toggleStore.js\":\"152f87b920a2f738\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/HeaderItem.js\":\"14948b970fefb8b4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4d9ffa1f3b73108b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/grouping.js\":\"01339cf80c8928d9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/index.js\":\"d3c592d62521f323\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/target.js\":\"2a6933d98b5c8476\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/codeMirrorExtensions.js\":\"e3e84f63c8c37628\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/contentPrefill.js\":\"35b02619f4caaa50\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/dataExtension.js\":\"20c0f830120f80a3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/index.js\":\"daa5073fd503a851\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a2cb416f8c71cb1e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/invalidation.js\":\"0456fe724e5ee62c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/localSchema.js\":\"86df68b059623309\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/index.js\":\"c3af614d51d8d7c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4ebbdf0f0283cf76\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/index.js\":\"e41d45080d64b07c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/referenceNode.js\":\"b69aa0da1f7964bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fb523421bb0b70da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"0fa96e91faa39070\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/index.js\":\"58cfcdf64d500ea9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"949a2e8a5a5c8ae5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"46498fae885024ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/mergeRetargetProcessor.js\":\"743641dca02d3505\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/parseFence.js\":\"d746553d62e08ac5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceParser.js\":\"5a5ac77c33f55158\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceProjection.js\":\"1c8816c06908ffc4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referencesProcessor.js\":\"13ef9d9589b643dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/renameProcessor.js\":\"23b1017b4089f9fb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/spanReplacement.js\":\"eeaa873235520494\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/htmlToOutline.js\":\"f02108e9584d3955\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/index.js\":\"46afc3ab5ded3e47\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e7a8e9ebbaf158e5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/pasteDecision.js\":\"413306b10b7b7177\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/action.js\":\"1461f063a940094e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/blockIds.js\":\"10c7a0d5756b191d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/content.js\":\"f56e78c59ec632ac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/effect.js\":\"90bda1d380bddebb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/ids.js\":\"51c25088bf1660dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/import.js\":\"391a6cd34f9aa9f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/index.js\":\"6450f30a998376ce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plan.js\":\"6ea6e3dfd3ef4ef1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plugin.js\":\"d00264303dfb07ee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/promotion.js\":\"6438dfab20ff6c12\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/properties.js\":\"24dee2ea12a65ed1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/references.js\":\"a73c9a679341a1c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/report.js\":\"dc9c364753fb5a7a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/roamMemo.js\":\"8fcf41ca3d368b25\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/runtime.js\":\"851ca87d7e4fd1de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/schemaReconciliation.js\":\"1c47b765d823c277\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/srsMarkers.js\":\"f6bdcad99fa38b2e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/todo.js\":\"10fe334b96d99cd8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/typeCandidates.js\":\"8c85c4d3cde9e494\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/types.js\":\"7fccf717f7513563\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/index.js\":\"436fb40fe0da112c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/store.js\":\"cd87e3144c046a26\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/HeaderItem.js\":\"eed8e3fc574b0783\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"fa60f2403e3f8adb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/index.js\":\"2c5edb7f995d6792\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/model.js\":\"00c3395ec86b596c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/toggleStore.js\":\"675f16fb350c27b7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/useKeyInspector.js\":\"6d4c62f0ad519437\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5ec82fe4f6c7161e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/ShellDecorator.js\":\"845da5d9554c3089\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/actions.js\":\"4ac2cef8c72a2d6a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8307aed489473933\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/index.js\":\"c51a538da6ae7c13\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/shell.js\":\"b523b4739b939489\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/surface.js\":\"cf972c5961c9df71\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/walker.js\":\"276c2062fc548037\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f1c07420fde7e8d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/dataExtension.js\":\"fd8a53d1c518db21\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/index.js\":\"a09f4aebb68c2c12\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/indicator.js\":\"1a6a5c5953a18543\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/moveSrsState.js\":\"5164b4065d632e56\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0603933cdee1f042\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/scheduler.js\":\"7cf9bfc823163892\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/schema.js\":\"ea240e00418616c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"63c6c2ecc41d6e75\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsClipboard.js\":\"1a3ba9a8f5c8e062\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5f796cb3d7bc91d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DailyNoteReviewHint.js\":\"149dd3cbba343741\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DeckPicker.js\":\"0dcdadeb35cc90ca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewControls.js\":\"cf79acd409ff87e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9ed75e5400debab4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewSession.js\":\"f94b224ff09fda18\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/actions.js\":\"2fa6699e7777e90f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/archive.js\":\"e3d238ea1de54498\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dataExtension.js\":\"1d26f16cc29c4acb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/deck.js\":\"a3376e3ee81d68c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dueQuery.js\":\"0ea458accc917cdc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/gradeDecision.js\":\"dc7751373df89480\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/index.js\":\"8c2e2f7f37ef1de1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/keyHints.js\":\"ad17d4b692e8ae0a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewCardLayout.js\":\"308cdf796cda3901\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewProgress.js\":\"57832cf98bd3631a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/schema.js\":\"9a461ee91e5506b1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/useDueCards.js\":\"c6d5e08618ccbe29\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/index.js\":\"a454260ad5909194\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/record.js\":\"baea7318f0bffd05\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/index.js\":\"b794ab67e3064ffa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/persistenceStatus.js\":\"40a62d264cf97eeb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/requestAction.js\":\"a567f72b25ec661f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/TypeChipsDecorator.js\":\"a122edc5aa6a1f4f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/codeMirrorExtensions.js\":\"71f7176202845bac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/index.js\":\"9f5b23a70b408717\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/typeAutocomplete.js\":\"92aff186e5398ea2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"443d740cfc810327\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/actions.js\":\"78f75201905e0f32\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/anchor.js\":\"9cabae3c457468b7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/events.js\":\"539451e7a8dc8cdf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/gestureActions.js\":\"64807e54ecfff4ea\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/index.js\":\"363398c7cf9a8a5d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"24f9b224c9a9bf5f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/collect.js\":\"b0edce81df3ee491\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/index.js\":\"41d96a574e608d1f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/record.js\":\"8a8184d5378d2713\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/RejectionDialog.js\":\"7c2ea9efcfa45c92\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/SystemStatusHeaderItem.js\":\"142197168a745618\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/index.js\":\"0b65224c9b718c6f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/model.js\":\"99d6e9662c35e38a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/queueCounts.js\":\"039f1fcab6525af9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rejectedHelpers.js\":\"a16cc769b2e4fe6a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rematerializeAction.js\":\"24c1231a0f48538a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/useHysteresis.js\":\"3f480b97c0de883d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/ColumnHeaders.js\":\"924a472af55d0f9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/QueryUi.js\":\"8db0990e02db1bc9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/TableLayout.js\":\"1d0d28162928e08b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/actions.js\":\"d1c79acab488df68\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/cellEdits.js\":\"2050cd61f89f38bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/columns.js\":\"b646bde78f05e928\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/controller.js\":\"aae178832e44c53e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/convert.js\":\"d160c8a3537de805\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/dataExtension.js\":\"aadf000af387663e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/index.js\":\"c6c51ffcfa8b63c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/keys.js\":\"e4d5575f730557aa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/model.js\":\"b256adcb6d588b9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/backfill.js\":\"034b69d072ed8268\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/completion.js\":\"fa56c05a15795f0f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/format.js\":\"7381935a4edc3670\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/parse.js\":\"9ec2c055c839964e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/queryValue.js\":\"82f1c3ee0c603553\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/source.js\":\"0f3e0a007d2827dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/registry.js\":\"d5199ff962f7ce10\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/schema.js\":\"60e3c723b5b1df4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/sort.js\":\"9117633a6f8acd40\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/effect.js\":\"9f159dfdc9a6359a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/index.js\":\"6873ade2c85c1be8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/theme.js\":\"827e758917abd8da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/actions.js\":\"d96ed56c9207e5ac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/dataExtension.js\":\"d0932cd29316e9a3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/index.js\":\"8294909e0b8d717b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/schema.js\":\"39b48b2bd8703bec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d95f35f4d579f5fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/actions.js\":\"b2333e26a8538a13\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/defaultItems.js\":\"48a06b4af668e1c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/facet.js\":\"86263b962842ccd3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/holdRecognizer.js\":\"43e43756f56cf8fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/index.js\":\"1d18462b257f548b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/UpdateIndicator.js\":\"da6b6f309a6185bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/index.js\":\"800468ff9c0d55c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/loadTimes.js\":\"bb9e37f91f39f67d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoNotesRenderer.js\":\"049ae09772bcd57a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoPlayerRenderer.js\":\"8d9d8a80a98fbc30\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoTimeStamp.js\":\"e80d25d8a7c71f17\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/actions.js\":\"2f7e3bfc2d5e92d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/index.js\":\"4e72e982c97ca66f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/markdown.js\":\"2b920da6bd3dd18b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/notes.js\":\"ee74ba8aa8bf2ab6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/registry.js\":\"f57a2816d6539f13\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/remark-timestamps.js\":\"8132bb7363805b78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/view.js\":\"52c8eda4a8167f1c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/LinkHints.js\":\"866b9c63b8f39dd1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/index.js\":\"544e187e165f283f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/model.js\":\"6da6d673454888df\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/settings.js\":\"b8735e34fb04461d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/actions.js\":\"bcf0d5a646382bb1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/index.js\":\"0bb1fe641122e2a9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/interactions.js\":\"13a073f0a2845c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/workspace-header/index.js\":\"39d9c3bfb4fc4114\",\"/knowledge-medium/pr-preview/pr-1843/src/registerServiceWorker.js\":\"a903aa7c1e7cf5e0\",\"/knowledge-medium/pr-preview/pr-1843/src/requestPersistentStorage.js\":\"e2bfd0488e21e505\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authRequestDeadline.js\":\"510170d9f277ae8b\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authStorage.js\":\"142c35b2fee1c31b\",\"/knowledge-medium/pr-preview/pr-1843/src/services/powersync.js\":\"9ab1fd5fe0995f83\",\"/knowledge-medium/pr-preview/pr-1843/src/services/supabase.js\":\"b2cc9c0a4f6e285f\",\"/knowledge-medium/pr-preview/pr-1843/src/services/uploadErrorClassifier.js\":\"5307f778833bbd78\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/ActiveContexts.js\":\"bb5d4b4e751417d5\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/HotkeyReconciler.js\":\"edb097d8db4f9ba8\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/WipeLocalDataDialog.js\":\"a42a98d33e152195\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionDispatch.js\":\"ffd0a00c23bd6c5f\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionRefItems.js\":\"8339e2f548d6c6c0\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/applyKeybindingOverrides.js\":\"5b369831649c114f\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/blockActions.js\":\"8a88542f37c8b86d\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/canonicalizeChord.js\":\"b0e65d9fe7ca3169\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultContexts.js\":\"d68b27765dbc797f\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultShortcuts.js\":\"2a915c4d3c85c60e\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/effectiveActions.js\":\"cbfc8c8498c539a9\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureAction.js\":\"bea017c1e842dc7d\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureBinding.js\":\"ccd5c1736a14310b\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/holdRegistry.js\":\"607c4aea4211d26a\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingConflicts.js\":\"f8f2099ae4646be4\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingOverrides.js\":\"aef9bb189974e672\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/pointerAction.js\":\"dbfd611b078383d9\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/resolve.js\":\"6c55bd225613be6c\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/runAction.js\":\"d82b3e33dc825243\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/sequenceMatcher.js\":\"efe7061fb6990969\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/types.js\":\"12facc7fb30081f4\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionContext.js\":\"9abd7a768cacde88\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionDiscovery.js\":\"a4a164bad784eb4d\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/utils.js\":\"45c54b6039bb0187\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/bootStore.js\":\"13a8e49b2b9cb3bc\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/previewDatabases.js\":\"72b6695890d0b1b2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/byteTransform.js\":\"d43d3d1ddcbe6ab7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/attachmentCleaner.js\":\"9cf8031b4a015b41\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/attachmentParts.js\":\"e325cc3658c7e141\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleParts.js\":\"b4c62750dfba34a1\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleRecord.js\":\"893d8df4651e7e95\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/manifest.js\":\"9e115ca8235739d2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/takeBundle.js\":\"e85c18cc27027b26\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/verifyBundle.js\":\"958a570865e44814\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/cleaningStage.js\":\"cbfded2d4ac46be9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionKey.js\":\"55a90ace476ffbfc\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionServer.js\":\"fddaeceb628b77f4\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flip.js\":\"f8360c92dd3e999a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flipAttempts.js\":\"90962929d1f255c9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/pages.js\":\"7e6c49a86fec1137\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/preflight.js\":\"2d501001977fc35e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/reseal.js\":\"b938ad6ca59d720d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runConversion.js\":\"f82d46e341dddf50\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runLock.js\":\"04d07de8df543d87\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealing.js\":\"1c25d1637e89bacf\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealingStage.js\":\"54404016892d3986\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/stage.js\":\"b9d71b39e5040a37\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/verifyReseal.js\":\"e25b78d59f1f5bbb\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aad.js\":\"58516f4928af88a2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aead.js\":\"65d30c91b6a5b9c6\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base32.js\":\"1419d864669715d1\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base64url.js\":\"d058243158c27c74\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/binaryEnvelope.js\":\"4e51522aa235416f\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/byteAead.js\":\"5021656021f7eb18\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/canary.js\":\"d4630b48ec5e8e2e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentHash.js\":\"c6c4e9640379453b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentKey.js\":\"a08287ed8eeced80\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/derivedIdNamespace.js\":\"67c769361d1f9963\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/envelope.js\":\"59e161d820f9ff50\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/hex.js\":\"d23f7507f439b321\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/sha256Hex.js\":\"f935675d95ba899c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/workspaceKey.js\":\"34c2dbd57291929f\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/conversionState.js\":\"63bbcb2e16fccf25\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/createEncryptedWorkspace.js\":\"615fad3ec00214f5\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/pastedKey.js\":\"b04a2ffafa6abdd0\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1d47db3ccee09da8\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/upgradeWorkspacePin.js\":\"91b8f7fb6cb18f6f\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/keyStore.js\":\"e81d0c827370a1fa\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/mintWorkspaceKey.js\":\"09ba6be6db738d22\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/modePin.js\":\"f6d05ddcea5907da\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/openWorkspaceKeys.js\":\"dbfb9573ef5d38ca\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolveWorkspaceEntry.js\":\"27e4aeac7db2df4f\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolver.js\":\"aa79a4068bccf38b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/workspaceAccess.js\":\"f5e3e9b669e6a494\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/transform.js\":\"21a574ebd8a6ed26\",\"/knowledge-medium/pr-preview/pr-1843/src/themeBootDefaults.js\":\"ad0a4423c4b527fc\",\"/knowledge-medium/pr-preview/pr-1843/src/types.js\":\"694c2973f5582cdf\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/ClientLocalSettings.js\":\"b2b2c7cbcd77aaae\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/abortableSleep.js\":\"2da8cdec729f6917\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/array.js\":\"6c197c579c6d4150\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/backlinkAutocomplete.js\":\"a0400493422b3dde\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockCrumbs.js\":\"e48de2f7d13b2e82\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockrefAutocomplete.js\":\"6bac8358525e997c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/cadencedIdleJob.js\":\"26ea7cb1bc7dc215\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/callbackSet.js\":\"88b00f315d8f57cb\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/clientId.js\":\"7130b6f7daa247c9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirror.js\":\"bdf570b986326504\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirrorCompletion.js\":\"220ea1aae9dc00eb\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/copy.js\":\"905fb68b1be47494\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dailyPage.js\":\"d588437d56cfa029\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensics.js\":\"5c1abebbb7d3b3b8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensicsHooks.js\":\"5c3f001c0cced408\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/deleteBlockThroughUi.js\":\"40a5dc4a9c9864d4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dialogs.js\":\"a01fbedb37aca77b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dom.js\":\"0c8b075d442a0ea3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/downloadBlob.js\":\"144df5add3da49b6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/exportSqliteDb.js\":\"67c1c6cef805d536\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fileSystemAccess.js\":\"5228fd6bcb611a85\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/flipSlide.js\":\"c01c99d2cb950869\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fnv1a.js\":\"0663b0c784ad8321\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/formatBytes.js\":\"ac4606df824f7bf0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fuzzyRank.js\":\"cd538fe1676efa7d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idbKeyedStore.js\":\"09df0bce35bd95f2\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idleCallbackPolyfill.js\":\"a2831f8fa9571396\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardAwareScroll.js\":\"db17a1402f6cf025\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardViewport.js\":\"ec58b8c4e8b44289\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/lastWorkspace.js\":\"dc1211aa2c38366a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutColumns.js\":\"df5b2d9bca9a993b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionDom.js\":\"cdf56e8f3ed05681\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionId.js\":\"7cd653bdf1d95405\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkClickGestures.js\":\"edee8e22f65b649c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkTargetAutocomplete.js\":\"e4c5dd61e79d0c9e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbCorruption.js\":\"8611fd72af9dbed4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbRecovery.js\":\"d13aa99cdb9154b6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/markdownParser.js\":\"261cc6f863b1426d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/memoize.js\":\"94b331db4a96dce3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameFieldCommit.js\":\"0d0df8de606aed3f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameList.js\":\"94e0d33e16fe26ac\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/navigation.js\":\"c599ebf9c9247f30\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/omnilinerNamespace.js\":\"2f95e6803d9e6e40\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/opfsPageScan.js\":\"7884544a9f6b39e6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelClearance.js\":\"d2a81ffd21021536\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelHistory.js\":\"a349c1c6f956682f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLanes.js\":\"2088075a272b3118\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLayoutProjection.js\":\"1aa9743286f031d5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelScrollAnchor.js\":\"f68102d3bdcb8156\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelUrlFlags.js\":\"63a4a90a8b57aaa3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/platform.js\":\"c704399988a5569c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/pluralize.js\":\"f2be18461c33e6e5\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyCreation.js\":\"163e9b0dabdfa718\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyNavigation.js\":\"6a5b7e8762fe0fd6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyValueContext.js\":\"6ec76bb77668680a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/react.js\":\"27127abd526dfaaf\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeDate.js\":\"04c59fd79e9f855f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeTime.js\":\"2e9f380ecf2d23c4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/renderScope.js\":\"08155e9c1887fdb7\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/resolvedThenable.js\":\"259e57bbb220d3a0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/routing.js\":\"f77f55bf0fecd9e1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/safeMode.js\":\"468b617097d0bdf6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/scheduleIdle.js\":\"c66f35eace3b98d6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/screenWakeLock.js\":\"906546fbc84ba0a8\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/selection.js\":\"499d76fa3f98815e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/softKeyboardGrab.js\":\"81ac49e99211e256\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/startupTimeline.js\":\"5fc1778c17986a47\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/state.js\":\"7246ecef3ae5f033\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/string.js\":\"4b4f64d7bdcb14e1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/surfaceZoom.js\":\"95dc9e66fe58a46d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/time.js\":\"a2421f06e5230851\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toast.js\":\"e0cbdfa2ed2c751c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toggleStore.js\":\"951deaa66ca56dac\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/untilStopped.js\":\"4c05707017a509c4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/userActivity.js\":\"d72d9881776faa40\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewTransition.js\":\"b6f9b871b330c728\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewport.js\":\"8e7cfbd2546fb30d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/webLock.js\":\"0bd64cb26c912c65\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceRecovery.js\":\"e91bfe858fe98dfa\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceSnapshotStore.js\":\"45d3c96622fe9394\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-compiler-runtime.js\":\"06d3f0d319f03620\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-client.js\":\"955c08c98c5bd431\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server-edge.js\":\"9458d66e514a604f\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server.js\":\"5a3342d59cefbd40\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static-edge.js\":\"bd72016152e775cc\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static.js\":\"d89e0f4b1931a073\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-test-utils.js\":\"39b2f174510809da\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom.js\":\"6aa307545c2fc483\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-runtime.js\":\"38aba2177ecb4669\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react.js\":\"9a47d4b2cf8604ef\",\"/knowledge-medium/pr-preview/pr-1843/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
