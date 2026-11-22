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
		buildId: "5daf0ad26607-21d09a51",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/\":\"3f03c68213d79614\",\"/knowledge-medium/pr-preview/pr-1843/index.html\":\"3f03c68213d79614\",\"/knowledge-medium/pr-preview/pr-1843/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1843/assets/FacadeVFS-ofj0i22q.js\":\"a6e1f28e5361feec\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSCoopSyncVFS-BhrlvFWA.js\":\"8fc25c534ea5c990\",\"/knowledge-medium/pr-preview/pr-1843/assets/OPFSWriteAheadVFS-DS0_FyaA.js\":\"16e103b17d91d23e\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CRCguSI5.js\":\"aa6dbe9e5bc6a3b3\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/assets/wa-sqlite-async-GLERWaka.js\":\"cf98e2fdd0d1dbaf\",\"/knowledge-medium/pr-preview/pr-1843/assets/worker-B9r2ZG4t.js\":\"4f9964d75f43f9e6\",\"/knowledge-medium/pr-preview/pr-1843/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1843/chunks/app-Db_uraK-.js\":\"7ea857a7dbd0f47e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1843/index.js\":\"590eaf35542c5c56\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1843/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1843/assets/AccessHandlePoolVFS-BrHqH0LF.js\":\"3dd3b425d7f584f3\",\"/knowledge-medium/pr-preview/pr-1843/assets/IDBBatchAtomicVFS-DisVqdIZ.js\":\"715765c3a8a2d1d6\",\"/knowledge-medium/pr-preview/pr-1843/assets/MemoryVFS-CT4RX-8V.js\":\"4f9a7b62a7277c63\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-BUt3sh4X.js\":\"b01cc87057ea9771\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-BhT5GCaC.js\":\"f0ae8daa6730efe3\",\"/knowledge-medium/pr-preview/pr-1843/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1843/chunks/AccessHandlePoolVFS-BHDXYZHP.js\":\"1accaac7b100be4b\",\"/knowledge-medium/pr-preview/pr-1843/chunks/FacadeVFS-BQOgkpoE.js\":\"5fb32900a7c46208\",\"/knowledge-medium/pr-preview/pr-1843/chunks/IDBBatchAtomicVFS-ZjpJwPH4.js\":\"16f4778ecf21a5f1\",\"/knowledge-medium/pr-preview/pr-1843/chunks/MemoryVFS-dgCykXsJ.js\":\"29bde3115a63906e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSCoopSyncVFS-hx3RGPVq.js\":\"72291d79462910e2\",\"/knowledge-medium/pr-preview/pr-1843/chunks/OPFSWriteAheadVFS-BJPR30UA.js\":\"6fc89beb8b27f4e4\",\"/knowledge-medium/pr-preview/pr-1843/chunks/Preview-CpEDoHsJ.js\":\"dc60531d237861a7\",\"/knowledge-medium/pr-preview/pr-1843/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/card-QlI7_fq1.js\":\"5dff0486004e6742\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1843/chunks/dist-DaOSRXX1.js\":\"a7f734ad84e0e710\",\"/knowledge-medium/pr-preview/pr-1843/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-B9TJN1tb.js\":\"25c78e2fa0e0eb26\",\"/knowledge-medium/pr-preview/pr-1843/chunks/mc-wa-sqlite-async-BT0UTX_Y.js\":\"ed020206259b34be\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-B3MZqULC.js\":\"bcf635aba617b62e\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-BBV6gEDi.js\":\"eb4701443c4c730f\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-BWxo6380.js\":\"2026dcefacca3aaa\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-BYtoQtaU.js\":\"49599a4408d64e11\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-BdorYH2R.js\":\"4ee9567fb4325c55\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-CbN9bbAy.js\":\"ea38e90272ab910b\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-D6gvVSm_.js\":\"e8770bfa9ca42fd0\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-DVauroqk.js\":\"0130cf94ea172ae2\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server-legacy.browser.production-PU-8fuej.js\":\"3b21178045bdaafc\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.browser.production-QCAkvJl0.js\":\"8825525b6e52e804\",\"/knowledge-medium/pr-preview/pr-1843/chunks/react-dom-server.edge.production-zgW-1WPR.js\":\"0c314a2056e178b4\",\"/knowledge-medium/pr-preview/pr-1843/chunks/server.browser-BtdjBtup.js\":\"c994aba461a17baa\",\"/knowledge-medium/pr-preview/pr-1843/chunks/textarea-VGF_KfMf.js\":\"f6196c72db70b85c\",\"/knowledge-medium/pr-preview/pr-1843/chunks/ui-Dr8-zWNB.js\":\"11e493dbcffbc4c4\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-async-DnYoTG4E.js\":\"117a0af3381be428\",\"/knowledge-medium/pr-preview/pr-1843/chunks/wa-sqlite-smHdvteP.js\":\"915b850638bb69de\",\"/knowledge-medium/pr-preview/pr-1843/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1843/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1843/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1843/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1843/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1843/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1843/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1843/src/App.js\":\"0668068b3116993f\",\"/knowledge-medium/pr-preview/pr-1843/src/appUpdate.js\":\"5ed9eda75245f1a2\",\"/knowledge-medium/pr-preview/pr-1843/src/appVersion.js\":\"bd7e17501d00a339\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/initialLayout.js\":\"47bb22ba58085f25\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/openWorkspaceData.js\":\"a9952e7d8a5d81ef\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/resolveWorkspace.js\":\"9ea0e5ad72ff2d49\",\"/knowledge-medium/pr-preview/pr-1843/src/bootstrap/workspaceBootstrap.js\":\"a5ba1d1fbfecc04b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockComponent.js\":\"4e7231628ec38fd3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockCrumbs.js\":\"5d1577192642b397\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockEditor.js\":\"8e88931d84062d55\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockLoadingPlaceholder.js\":\"936c0162f32570e8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockProperties.js\":\"45bdea678de9f0f5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/BlockSearchPicker.js\":\"3f834a2069203f6e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ConfirmBulkDeleteDialog.js\":\"0fd75a166122970a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DividerHandle.js\":\"7dcbcee6c567acca\",\"/knowledge-medium/pr-preview/pr-1843/src/components/DraftEditor.js\":\"f63dfa305db1fb6c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/GutterPill.js\":\"d194fc3cb2135551\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Header.js\":\"cfdb0f12a206cbf3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/LazyBlockComponent.js\":\"ad01bb61f22bb2e4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/Login.js\":\"91050ed3fa6ad4e3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ZoomableSurface.js\":\"aae0cc6dfcafb3d4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/editModeKeepalive.js\":\"cc22c2e03bf38cb0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b9b9058eda66b58e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1c66ef949165f9da\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefPropertyEditor.js\":\"f648104cf7fcab94\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/RefTargetTypePicker.js\":\"72bcfbbc3e4e8cd2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/SelectPropertyEditor.js\":\"ceb587d25fff610b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/TypesPropertyEditor.js\":\"2434eaf4cf38a204\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/defaults.js\":\"42c5ba84ea4e4985\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/kernelValuePresets.js\":\"1006610fe7b57f54\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/selectablePresets.js\":\"aa4ccc19965785b7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyEditors/typesPropertyUi.js\":\"acb977c2ce6d33dc\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/AddPropertyForm.js\":\"2d2d968aa0f417ab\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyPicker.js\":\"39dfc85a8700f0b2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/PropertyRow.js\":\"6ff0850890d0bd86\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/Rows.js\":\"4bf8f601a75613cf\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/actions.js\":\"deb0a71663576e37\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/declarationOnly.js\":\"9dec6446a0c812e4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/layout.js\":\"f2b01957c9edf182\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/model.js\":\"98677ab98f4f5147\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapeUi.js\":\"76b1f945a60e2d1d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/shapes.js\":\"99a5b3f531c2735b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4c07593d3e22e825\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanel/visibility.js\":\"b00dbec3f8f65ed8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/propertyPanelSections.js\":\"03bf16acf68cfefe\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockEmbed.js\":\"52a9fdb038ea2ec3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockLink.js\":\"97caad183f41e735\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/BlockRef.js\":\"00979db47a84bf8c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/ReferenceLink.js\":\"f96c1aabf9d9f58b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuard.js\":\"e6ca20d41a950452\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/cycleGuardContext.js\":\"efa335b5d7b2f6dd\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/linkInteraction.js\":\"537a7fc7508c923e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/referenceLayout.js\":\"6d16145d2374e977\",\"/knowledge-medium/pr-preview/pr-1843/src/components/references/useBlockRefAncestors.js\":\"ec4f1771843cd63a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockGutter.js\":\"8b314688d1c97db8\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockInfoDialog.js\":\"11f3b1c50e589df1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BlockTypeBlockRenderer.js\":\"b97f53318b3b9549\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/BulletHoverCard.js\":\"643638bdb168cf01\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorContentRenderer.js\":\"e6051d782c2b6c4a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"e18272f8a519214b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ColumnResizeHandles.js\":\"b4c3721b1eea4fce\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"2d709288fa3b44f2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/DefaultBlockRenderer.js\":\"343869666d29afac\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/LayoutRenderer.js\":\"10259540b8d785a6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MarkdownContentRenderer.js\":\"7f4b7e70661f7a9d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/MissingDataRenderer.js\":\"368dfafbc3efb818\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PanelRenderer.js\":\"598af708b3798a5c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/PropertySchemaBlockRenderer.js\":\"179bd1dcfe8abfb9\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/TopLevelRenderer.js\":\"ea2bb7441769ec50\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockGutterMode.js\":\"a2b38e0830aad3a5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/blockTitleText.js\":\"1bce0992b049474b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/fieldCreationKeydown.js\":\"13a29507f015e223\",\"/knowledge-medium/pr-preview/pr-1843/src/components/renderer/layoutRootContext.js\":\"0ddab7477eac223c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/TypeChip.js\":\"9508fa880d5655c4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/typeChip/chipStyle.js\":\"54ccf05d67e305ae\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/anchored-floating.js\":\"68eab24963729571\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/button.js\":\"f4f936ed026a9048\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/card.js\":\"b3437a8f7acd2874\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/checkbox.js\":\"233983f3feeba706\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/collapsible.js\":\"bede7d12dc90983e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/command.js\":\"bd6d59bc663b2089\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/context-menu.js\":\"44429d366d8fd1c4\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dialog.js\":\"f52175878c581f73\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/dropdown-menu.js\":\"eec3ec8c2f477cd6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/floating-listbox.js\":\"0f85fe096e6c1066\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/index.js\":\"3d4543441237d41f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/input.js\":\"e4db1d5fe901a18a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/kbd.js\":\"d711c72e65ce00b0\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/label.js\":\"a6d68afcf4a3084b\",\"/knowledge-medium/pr-preview/pr-1843/src/components/ui/textarea.js\":\"883ce4184aeb5725\",\"/knowledge-medium/pr-preview/pr-1843/src/components/useEditModeYieldKeepalive.js\":\"0678945f305259e7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/BootFallback.js\":\"b3f1610eb7b94de7\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/FocusedRowLazyMount.js\":\"83d521adce4ef31a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LazyViewportMount.js\":\"5f4f91951519b6c6\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/LocalDbCorruptionFallback.js\":\"4d9e83a2f2357b6e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/error.js\":\"790f374af338d049\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/lazyMountRegistry.js\":\"03b2596fe5a9900f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/util/suspense.js\":\"0a8b851da16a883e\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/CreateWorkspaceDialog.js\":\"99902d3d91f03630\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/PendingInvitations.js\":\"6b7b5c06c12cd448\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/SyncProgress.js\":\"5aadadfe41b2093a\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/UnlockProgress.js\":\"38375f67173f75da\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceKeyGate.js\":\"5dcc55f5c325e184\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSettingsDialog.js\":\"b8947c45fa036e7f\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSwitcher.js\":\"585b1ab97b408ff3\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/WorkspaceSyncGate.js\":\"9256f3c5f7de6967\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlow.js\":\"1b16ef516b8a0d46\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/ConversionFlowHost.js\":\"b5cedeb4bf3f96a5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/EncryptionSection.js\":\"f97d695544f7dccb\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/attachmentPrompts.js\":\"e188e71fcb5ee21d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f27444e4f583313d\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowDeps.js\":\"9d88f2c9d063f8ec\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/conversionFlowStore.js\":\"06d168b01092199c\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/flowUi.js\":\"1eb920bd68d1fc39\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/conversion/useConversionRun.js\":\"2adbe72903da27d5\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/keyUi.js\":\"c62cb5b195868987\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnKeyLoss.js\":\"e02c28937f124af2\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/useCloseOnServerE2ee.js\":\"fac1c7472f0c4cb1\",\"/knowledge-medium/pr-preview/pr-1843/src/components/workspace/workspaceUnlocked.js\":\"8c56ce7d9e81f4b2\",\"/knowledge-medium/pr-preview/pr-1843/src/context/backgroundSubtree.js\":\"af1d0107e426106a\",\"/knowledge-medium/pr-preview/pr-1843/src/context/block.js\":\"5795f54142aa76b0\",\"/knowledge-medium/pr-preview/pr-1843/src/context/layoutWsContext.js\":\"fb8c8fad1a41af8f\",\"/knowledge-medium/pr-preview/pr-1843/src/context/propertyDisplay.js\":\"34423079292cb119\",\"/knowledge-medium/pr-preview/pr-1843/src/context/repo.js\":\"d78341f1a9ffab0e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasClaim.js\":\"23a95e1e031cd50c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/aliasSeatNamespace.js\":\"fa44491246668a16\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockData.js\":\"bef5e9a7abf3c436\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/blockType.js\":\"040fe15d06efa178\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/changeScope.js\":\"c06f5363301a79af\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/codecs.js\":\"6f8a1d3a103516c3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/derivedData.js\":\"f1cf810d7c685678\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/errors.js\":\"adfb65f0247b2d79\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/events.js\":\"9a7c2de6230608ff\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/handle.js\":\"d0ae92f4f8867d6a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/index.js\":\"81c6248297b91b3c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/mutator.js\":\"12bd6f6486509e39\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/processor.js\":\"3f9c87b3d9d3d40d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/propertySchema.js\":\"acb3bfd18c49ec25\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/query.js\":\"c12df17092b24a04\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/sameTxProcessor.js\":\"1005daad85a0ea65\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/schema.js\":\"d0ae92f4f8867d6a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/tx.js\":\"d0ae92f4f8867d6a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/typedBlockQuery.js\":\"21ea2d8d072c566e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/user.js\":\"b0383590ca66746b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresetCore.js\":\"1f3e2a2ccc58d066\",\"/knowledge-medium/pr-preview/pr-1843/src/data/api/valuePresets.js\":\"a64bf5190f0bb46d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/attachmentCleanerIOVerb.js\":\"d0edac8e219556b2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/block.js\":\"f257d444191d770d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockCache.js\":\"5b4152dae75fb1d7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockId.js\":\"a5df7acda5aa1b59\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockLiveness.js\":\"b00747210953dcb8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockMerge.js\":\"d8ece436c13182e2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockSchema.js\":\"6f409065f3e791df\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypeLookup.js\":\"56051029123626df\",\"/knowledge-medium/pr-preview/pr-1843/src/data/blockTypes.js\":\"60020b945b5f1a81\",\"/knowledge-medium/pr-preview/pr-1843/src/data/clientContext.js\":\"a9f62813b5c2fed4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/dbFileSiblings.js\":\"a47c49c217870e94\",\"/knowledge-medium/pr-preview/pr-1843/src/data/definitionSeeds.js\":\"71f9f10def49edff\",\"/knowledge-medium/pr-preview/pr-1843/src/data/derivedIds.js\":\"eef3f9bfcb6d3b93\",\"/knowledge-medium/pr-preview/pr-1843/src/data/drawnSubtree.js\":\"e806cdd63400eebe\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facetBridge.js\":\"d8a49283c3cf61d9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/facets.js\":\"fb7e80089e6c0414\",\"/knowledge-medium/pr-preview/pr-1843/src/data/globalState.js\":\"f9ad2922a624d9fa\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/aliasClaimRederiveProcessor.js\":\"a4c834a254e0be66\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/ancestorBatch.js\":\"235702dea10bec20\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/blockTypeTypeifyProcessor.js\":\"defb1ac18c1db83f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/clientSchema.js\":\"5405509933fe62d1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/commitPipeline.js\":\"8914030cadd00807\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/devAssertions.js\":\"ae3859e638c9c8ec\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/firstSync.js\":\"c7c6efd16ac9361b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/freshInitialLoad.js\":\"8dd2b0531a2621bd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/graphBackfillClaim.js\":\"4681e4f820782c08\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/handleStore.js\":\"451e06b20d43b3f3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/idleMarkerJobs.js\":\"eafd5ba07458a7eb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initialDownload.js\":\"b7c3c44fe2de143c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/initializeClientDatabase.js\":\"f8312f0a16141846\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/jsonCanonical.js\":\"d6ffd64549a60c46\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelInvalidation.js\":\"b4e18947679c9ed1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelProcessors.js\":\"1c0db1e6d267e8fe\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/kernelQueries.js\":\"ce6266acc9ce5448\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/mergeTypeMembershipProcessor.js\":\"84f815902094d459\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/normalizeReferencesProcessor.js\":\"30fd3de071c1aec5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/poolInstrumentation.js\":\"98349cc1dd34ff61\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/processorRunner.js\":\"41fb169d7980b90f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyCellBackfill.js\":\"3d7c0ad46c1defc7\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildMint.js\":\"a6383269410fc218\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyChildrenProcessor.js\":\"b5b84bc30a26f6b5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionChangeProcessor.js\":\"dd24654dea97fc93\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyDefinitionSynthesis.js\":\"88492013c3ea858c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyKeyScan.js\":\"cbdaf4cde447a1a4\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertySchemaResolution.js\":\"e91e3496b2265b40\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/propertyValueEdits.js\":\"fbf50af7d3720d6b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/raiseProtocol.js\":\"1e54d332a0d147b9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/readBatch.js\":\"1a83e7c84d8c268a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/refProjection.js\":\"ecd4756e48ee58fb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetLookups.js\":\"ae986f11f38437a2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/referenceTargetProcessor.js\":\"d3c2a7b46b80d5fd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/replayMerge.js\":\"f7f8a93dcc7fd78b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/sqlBinds.js\":\"cc78a159385a7194\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c08910514a7960c2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/arrivalProcessors.js\":\"4a83b07c770f1a1d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/invalidate.js\":\"6bc453cd523c2991\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/materialize.js\":\"c5b190abae2118f1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/observer.js\":\"7476c15eca9f65ea\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/syncObserver/reconcile.js\":\"3f89ff517fb8b2d6\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/timingMetrics.js\":\"9042c9e37a4d574c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/treeQueries.js\":\"eec4b50a3fb0e58a\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txEngine.js\":\"106ab7e336c83c62\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/txSnapshots.js\":\"2101bf8ffd629efd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/typedBlockQuery.js\":\"9fb22eaa0b3b94bd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/internals/undoManager.js\":\"bb308ae93b221822\",\"/knowledge-medium/pr-preview/pr-1843/src/data/invalidation.js\":\"351ae92e6b693fd9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelDataExtension.js\":\"72591182b5733e20\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelPage.js\":\"d7b9cfebd5cf11d0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/kernelValuePresetCores.js\":\"9115ad185eb332dd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbCorruptionSignal.js\":\"f2c699f3e5a74d89\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbStorage.js\":\"2326be6def488de3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localDbVfs.js\":\"78af7af61abe8d39\",\"/knowledge-medium/pr-preview/pr-1843/src/data/localSchema.js\":\"58e39b4a295e740c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/maintenance.js\":\"d50df8ed8a1345f3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mergeProperties.js\":\"8689794b8aa40093\",\"/knowledge-medium/pr-preview/pr-1843/src/data/metricsConsoleHook.js\":\"b0ae54b4ebf1d763\",\"/knowledge-medium/pr-preview/pr-1843/src/data/migrationsPage.js\":\"726432d3e21d97ca\",\"/knowledge-medium/pr-preview/pr-1843/src/data/mutators.js\":\"57cbc1c78047e104\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKey.js\":\"e6b2e4d3f5aa2e7b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/orderKeyPlacement.js\":\"59650bf8257e305d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/outlineSurface.js\":\"6f678ccb005380cd\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingEditorContent.js\":\"f6423b87772ed8de\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pendingUploadsSql.js\":\"d6cda88cfcd70838\",\"/knowledge-medium/pr-preview/pr-1843/src/data/pluginStateExtensions.js\":\"944a46660abcfa73\",\"/knowledge-medium/pr-preview/pr-1843/src/data/powerSyncLogger.js\":\"6b7d80176b7885be\",\"/knowledge-medium/pr-preview/pr-1843/src/data/projectorRuntime.js\":\"b9d4fb47465e7f28\",\"/knowledge-medium/pr-preview/pr-1843/src/data/properties.js\":\"54adbebf2b01aae2\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertiesPage.js\":\"2b0f85f81171ab5e\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyChildren.js\":\"caf05e9af968b696\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionFanout.js\":\"b2f05de190b6a5a1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionMetadata.js\":\"3f81af78b1b9bf85\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDefinitionRegistry.js\":\"4400706eb6d26f40\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyDisplayMode.js\":\"ec77aa15ec3e0425\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertyRowCreation.js\":\"6c87f156323d79ef\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySchemaCreation.js\":\"7b63b5a32338ef9f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/propertySeeds.js\":\"cd021216cfa01919\",\"/knowledge-medium/pr-preview/pr-1843/src/data/recentsPage.js\":\"960085bb06e172e1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/referenceBlock.js\":\"51c9c0ff38436287\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rejectedUploads.js\":\"30b29fd2b1269cd9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/releasePowerSyncConnection.js\":\"25aef508774ed3ff\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repo.js\":\"860013f521699c91\",\"/knowledge-medium/pr-preview/pr-1843/src/data/repoProvider.js\":\"80518f54daff7681\",\"/knowledge-medium/pr-preview/pr-1843/src/data/rowProperty.js\":\"fad662d4e9c46a34\",\"/knowledge-medium/pr-preview/pr-1843/src/data/searchFilter.js\":\"bd084def37fc169d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/seedIdentityLedger.js\":\"19c4d578a06c0a3d\",\"/knowledge-medium/pr-preview/pr-1843/src/data/stateBlocks.js\":\"dafdafa7e4a29f0f\",\"/knowledge-medium/pr-preview/pr-1843/src/data/structuralEditPolicy.js\":\"89af178676a498d1\",\"/knowledge-medium/pr-preview/pr-1843/src/data/subtreeDelete.js\":\"8f00869857c68b51\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncStreamLock.js\":\"5cd6a6abbcdfa4bb\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableSqlRecognizer.js\":\"afce45f3ea097404\",\"/knowledge-medium/pr-preview/pr-1843/src/data/syncedTableWriteGuard.js\":\"a087918e5720a4ca\",\"/knowledge-medium/pr-preview/pr-1843/src/data/targets.js\":\"a5cfae2d5122275c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeColors.js\":\"0633bbf908b3d8a8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionMetadata.js\":\"0fed0610d4be9da9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeDefinitionRegistry.js\":\"57a2ef4710211104\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeExtraction.js\":\"80f529ee8fa65d7c\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeInitialValues.js\":\"dda57fc30959f859\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typePropertyGroups.js\":\"ab8f0a95de198683\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeSeeds.js\":\"41af4faebb79d201\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typeTagger.js\":\"951588e26ceef73b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typedRecords.js\":\"cc448b2c52a3f1a9\",\"/knowledge-medium/pr-preview/pr-1843/src/data/typesPage.js\":\"995eb81b989f8571\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userPrefs.js\":\"d826b294be8aa882\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userSchemasService.js\":\"eea2a7f6cb096520\",\"/knowledge-medium/pr-preview/pr-1843/src/data/userTypesService.js\":\"6418413473daac29\",\"/knowledge-medium/pr-preview/pr-1843/src/data/valuePresetRegistry.js\":\"a30695e0808bb4b5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/visibleChildren.js\":\"f66b5510dd70baf8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceConversion.js\":\"6c4802a8f2b130f3\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceFirstSync.js\":\"c392a0ad87eb6ce0\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceIdNamespace.js\":\"0ea11736a3016e19\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaceSchema.js\":\"64fa2f10ceffbe3b\",\"/knowledge-medium/pr-preview/pr-1843/src/data/workspaces.js\":\"9b46abaadd6992b8\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadLog.js\":\"e83504ec340efbe5\",\"/knowledge-medium/pr-preview/pr-1843/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/BlockPasteShellDecorator.js\":\"2941c39a27b2d0e0\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/atTrigger.js\":\"3953a9afac5173c6\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/autocomplete.js\":\"ceca9609ec06d24b\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/codeMirrorExtensions.js\":\"410558b89e963e1a\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/contentFlush.js\":\"023c33ee9ad5de91\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/defaultInteractions.js\":\"cb5a3a7c3df77674\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/editSettleSignal.js\":\"d40980e68acf4441\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/insertImage.js\":\"3c805a0555845fb6\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceCompletionRange.js\":\"7cd245e248843f0f\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/referenceTargetTypes.js\":\"bed73045bc28ab7b\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/syntaxContext.js\":\"04334c54f15ee4f8\",\"/knowledge-medium/pr-preview/pr-1843/src/editor/triggerMatch.js\":\"b4b6e6e16b96067c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/AppRuntimeProvider.js\":\"65b4e4f64f865d2c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/BlockFocusShellDecorator.js\":\"200c5250014a27e7\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/ExtensionRenderBoundary.js\":\"25dc5ab42666affe\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/PanelContentRecovery.js\":\"66897a930c8bad06\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/apiCatalog.js\":\"c3b4aaed163e97a7\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/approveExtensionHere.js\":\"f4918def29456d80\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/armedCutAppMount.js\":\"8ca92a075e18795c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/batchableKeyedStore.js\":\"68fa076077602e5a\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockInteraction.js\":\"e7e95ebd141241f2\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/blockSelectionAction.js\":\"eefbe191e25d1671\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compileExtensionModule.js\":\"e581802180456217\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/compiledModuleCache.js\":\"e5dc790f4fcad0e5\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/continuousGestures.js\":\"29eae68f3d6a60e4\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/core.js\":\"9e41fcb7e3eedbf7\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/defaultRenderers.js\":\"c0bb7da9df1cfb55\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/definitionFanoutAppMount.js\":\"73e9f83ae17cd6c7\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dialogAppMount.js\":\"1d3e36873db8146e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensionSeeds.js\":\"3bbb18b32e9f2366\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/dynamicExtensions.js\":\"c79765340182c255\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/exampleExtensions.js\":\"7a48bae66b53e44e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionApprovalStatus.js\":\"a64e17798e41d01b\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrorToast.js\":\"36a0fbc26dc10af1\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLoadErrors.js\":\"3e3b7fa4b2060416\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionLookup.js\":\"d845d9730b7c12d8\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionToggles.js\":\"57421352d788772c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/extensionUtilitiesCss.js\":\"42d240babd1ca4f0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/kernelPageDeletionGuard.js\":\"cb069cbfae38bdf0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/liveRuntime.js\":\"685fb090bfe9a2b0\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/openExtensionsSettings.js\":\"818084064c0dedbe\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/overridesCache.js\":\"34000ac397cbd420\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/pluginIds.js\":\"6426a06be1fc87e4\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/processorRejectionToast.js\":\"2b068ffd3b3ad680\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeActions.js\":\"e19202b62e88d38b\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/runtimeContext.js\":\"e92e3aff0dcdec4f\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticAppExtensions.js\":\"65168b385b18082c\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/staticDataExtensions.js\":\"4e1260b70a60de08\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/toastAppMount.js\":\"f9f5c5d53a5e748e\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useOverrides.js\":\"45f676d82d05f404\",\"/knowledge-medium/pr-preview/pr-1843/src/extensions/useShortcutSurfaceActivations.js\":\"1e5455614f08dfcf\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/discoverToggleTree.js\":\"31b67b1496516010\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/facet.js\":\"d576090c0c8b3cc0\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/resolveAppRuntime.js\":\"54f9143d7a47186d\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/runtimeEvents.js\":\"8d3b84d8cb2706ab\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/togglable.js\":\"ac689b405656e9e9\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/variantFacet.js\":\"d613e794d51aae27\",\"/knowledge-medium/pr-preview/pr-1843/src/facets/verbFacet.js\":\"2207a98241b5e30c\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/block.js\":\"5e06a83674933aed\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/focusedChild.js\":\"5156a81242bdea6a\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/propertySchemas.js\":\"6db8cde0dca83736\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/typeRegistry.js\":\"534d5c869485b273\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAncestorCrumbs.js\":\"2ef3d04e78fe263c\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useAutocompleteListbox.js\":\"74d6b2eb8fd3bcb0\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedSearch.js\":\"8dbb4fa72e44c0e7\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useDebouncedValue.js\":\"6e7f6f217e6052e1\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsFocalRender.js\":\"66512813b8bb3150\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useIsReadOnly.js\":\"c4cad9e975d3a0d0\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMaterializeBacklog.js\":\"c2555d0340dbf8e9\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useMinuteClock.js\":\"0e8d0c3f3f0ec136\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePanelLayoutProjection.js\":\"857d76ba6a503738\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/usePendingInvitations.js\":\"9722f4ff84d24de4\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRendererRegistry.js\":\"7e7571480b841043\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useRetainedFieldRows.js\":\"09aaf569e2365ae1\",\"/knowledge-medium/pr-preview/pr-1843/src/hooks/useWorkspaces.js\":\"9c3d6e3d0dee4ea9\",\"/knowledge-medium/pr-preview/pr-1843/src/lib/utils.js\":\"e907dd167cfbf06a\",\"/knowledge-medium/pr-preview/pr-1843/src/main.js\":\"96d5746a6448f70d\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/MarkdownImage.js\":\"e1392647e4641b7f\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/blockSeparators.js\":\"3ca71b82472b316f\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/context.js\":\"c49a8d45a4ffa784\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/defaultMarkdownExtension.js\":\"92b3ec042e062946\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/extensions.js\":\"b698f1201bc7a032\",\"/knowledge-medium/pr-preview/pr-1843/src/markdown/renderMarkdownHtml.js\":\"844f6e6bd2325347\",\"/knowledge-medium/pr-preview/pr-1843/src/minimal-editor.js\":\"d602df4827f5125a\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/armedCut.js\":\"64a9c2c66f738ff6\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/captureMediaVerb.js\":\"a80ee8a740966259\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/clipboard.js\":\"6fc98e9db9e0fa6f\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/decision.js\":\"3b3d38a2b27bc8c9\",\"/knowledge-medium/pr-preview/pr-1843/src/paste/operations.js\":\"445f5345fe034e4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/AccountHeaderItem.js\":\"dff22ad63d42dbd7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/account-header/index.js\":\"8167ae2f4d57e1dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"6b1cac45df38bea4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askAgent.js\":\"6b8d96866f7f16e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/askedStore.js\":\"d901c858bbc4cabd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f219000d95ef225f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/chipState.js\":\"74f277c098376b00\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/dataExtension.js\":\"92e03d33d6d375ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/index.js\":\"c6033381ea1b8415\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"92f97ce4f93fb86f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-dispatch-companion/schema.js\":\"91867676971ccf9e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/AgentTokensDialog.js\":\"372386edf5e59704\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5074b360f8666b79\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/addMedia.js\":\"a6c848740eff46b7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/backlinks.js\":\"996f579cbe8e55ab\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/block.js\":\"d14fd9be8f67c499\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/context.js\":\"10fce198a2b99d68\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1e0a8e6bbedabea3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/index.js\":\"abfea746b800073c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/outline.js\":\"a237461e08990846\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/properties.js\":\"9b642d5338e956a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/refs.js\":\"511a3e32a05afff8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"fdfec50abdd9a340\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/search.js\":\"16e5cd91e36cd090\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/shared.js\":\"3a4f1870179e6a2a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c66988a61a2e897e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentViews/text.js\":\"c93c1dd1797c5a82\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/agentWrites.js\":\"0358e0ce1480c0b5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/authoringCatalog.js\":\"1919a8eab7358af0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/blockRefTargets.js\":\"3dc1ba890b127acd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridge.js\":\"1a97b675a591efa4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/bridgeLoop.js\":\"dabbc36fb66f1b6a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/changeHistory.js\":\"38e6febdab6a75e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commands.js\":\"e0ba96357b9149f3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/commentsCommands.js\":\"db5f04654562f4b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataExtension.js\":\"a524287fb8df2a3e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/dataModelGuide.js\":\"ea3b8db2cdaf428d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/describeRuntime.js\":\"5e0358e5c13bcb03\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/extensionLint.js\":\"086980ab542d216c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/grainAudit.js\":\"081f41cbf3d00ca0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/healthCommand.js\":\"b367920410f40524\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/index.js\":\"0ccdf9022f2a17f0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/presetIdentity.js\":\"1ebed12db5cccbdc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d47a129d4f8c502f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/readMedia.js\":\"a61ae047f790976f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/schema.js\":\"a1f565b6284a10ad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/serialization.js\":\"e31065ea455dbeff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/targets.js\":\"66d8f0dcdbce1e57\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/tokens.js\":\"97330baecc76bc61\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/watchEvents.js\":\"6f8d7c4e1a06a75e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/workspaceGuard.js\":\"802def4d6de9dec3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/agent-runtime/writeCommands.js\":\"0db54245bcb5c6f4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/AliasCollisionToast.js\":\"431a9e2c9909beca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/DuplicateNameBanner.js\":\"94d96b5532dedc16\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/collisionMerge.js\":\"f194d6835d6d7056\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/dataExtension.js\":\"993518cecc6cb8bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/index.js\":\"5d3b1e58a3910b91\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/mergeCollisionAction.js\":\"8b42352ce4a78f62\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/pageStyling.js\":\"def0be474ad39fd6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/rejectionToast.js\":\"bb72c8b35a5c3944\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/alias/syncProcessor.js\":\"a890e46590ed91f2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/actions.js\":\"df6c456bbd688ec9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/addComment.js\":\"fdc34de6c5bfb608\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchor.js\":\"6ddc6825b37126e2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/anchorState.js\":\"19141377a3eb6daf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/commentLinks.js\":\"294d3beee71c6275\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/confirmThreadDeletion.js\":\"3dc70a66aead94d1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/container.js\":\"46bda00574e51359\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/dataExtension.js\":\"dd59e7757131a601\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/deleteComment.js\":\"646c60c1eaad1553\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/highlights.js\":\"cf1aad21a8dc62d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/index.js\":\"a7046fd2ffda71d7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/linkedCommentsPill.js\":\"eb5dd362eaf03804\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/margin.js\":\"6c6dd0c4bdb0285d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/marginSchema.js\":\"4e963c5493588199\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/newComment.js\":\"b560f546a2bc5ba5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ownThreadPicker.js\":\"bc176eb3ec9689a8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/placement.js\":\"7c59b15aae6615c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/queries.js\":\"08b665c02eae84d1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotePosition.js\":\"d126f0e1741b4a0b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedIn.js\":\"74588674be6d589a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/quotedRange.js\":\"25aafb8cb403a705\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/rangeRefs.js\":\"6f1236f10d9f5586\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readHighlights.js\":\"52c75a2924573f48\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelection.js\":\"e8c2b61a0e7a9619\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/readSelectionUi.js\":\"e19fb8d8dbb141c4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/reanchor.js\":\"efa201bce47a8f13\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/schema.js\":\"92344b8bd29e5fd9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scope.js\":\"46514e62bd548427\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/scopeThreads.js\":\"53eb746520fdf5a8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/splitRetarget.js\":\"b2c5afa4865056e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestionCard.js\":\"5acff8697407af34\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/suggestions.js\":\"4e3ccbc3c1f47241\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaries.js\":\"b2c81c2b847d1d08\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/summaryBatch.js\":\"0b39d1d5915efaee\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/surface.js\":\"b43cd83815b15388\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threadNavigation.js\":\"8906c09c93749101\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/threads.js\":\"e3c2f7ef76b3e4fc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/ui.js\":\"eca19b5bf42bc9c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/annotations/uiStore.js\":\"bd4776573ea00888\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/appIntents.js\":\"3ab2f6f91d51371d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-intents/index.js\":\"590af6756a5207c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/index.js\":\"ff1493d350ec3922\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/app-update-prompt/status.js\":\"d6df736498bce977\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"06dd5d474991c0cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaBlockRenderer.js\":\"a5ae2bc813fbfd75\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f5fad237da58a63f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/MediaUploadReconciler.js\":\"2a9416a97c5afda6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetDownLane.js\":\"8a386b3630517fdc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetResolver.js\":\"be5f34f8e45b37c3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/assetUpload.js\":\"8c30d536121fb6f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/attachmentCleanerIO.js\":\"23a34866cc1b4f7d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/supabaseAuditIO.js\":\"efe6b063327e95a9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/blobStore.js\":\"cbdfec952cf6bc43\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/byteStore.js\":\"2d61cd4290f943f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanerIO.js\":\"d6b7bdf9f90fa747\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/cleanupAttachments.js\":\"b639c940dc39c827\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/dataExtension.js\":\"753d7e3d4313fa98\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/downLane.js\":\"d032a91954e648f9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/index.js\":\"de3a735996b273e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/insertImageContribution.js\":\"a6b189b0cfc27289\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneArming.js\":\"d9c7467f3cb2eae5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/laneLock.js\":\"760605d12416a8a0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaBlock.js\":\"9e6e84ac9f2db76e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaCapture.js\":\"d95c626631a2d66e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewers.js\":\"7d3ec51cbe4fa73a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/mediaViewersFacet.js\":\"11c053441b25f775\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/pasteCapture.js\":\"ad98ee8abf690d41\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/resolver.js\":\"54b3f9ff7e889c29\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/retryUploadsAction.js\":\"cac0141742260018\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/storagePaths.js\":\"dbeb9fce91f23b4d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadDrain.js\":\"a001e39e5ee974ce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadLaneStatus.js\":\"cdcaf3e1cecb9217\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadReconcile.js\":\"e6d502b241df98a8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadRecovery.js\":\"5fd03a668f28498a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/uploadStore.js\":\"0b0d9437d92d0cf6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/attachments/useAssetObjectUrl.js\":\"31b53882f481e2d9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8ad697ecc39fa4db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/BacklinksViewSection.js\":\"417084d6b642676f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/facet.js\":\"26615cf04b1459bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/index.js\":\"7fc622b0a3329579\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks-view/prop.js\":\"028b7ba228d35755\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinkFilters.js\":\"e4914a7a4831706e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"409305d85218fa7a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/BlockEntry.js\":\"e7d1cd623a417899\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/LinkedReferences.js\":\"cb09d1f0afb21255\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b6af9bf6d921813e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dailyNoteDefaults.js\":\"bf66c6ad1537cc0c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/dataExtension.js\":\"d941790771a97ee9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/edgeExclusions.js\":\"8e9c451422be6a20\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/filterProperty.js\":\"6b947196e072d9d0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/index.js\":\"39a683b40087d514\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"09c885df7fa2909f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/applies.js\":\"985dcda3292592c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/countQuery.js\":\"c957bf5678cc4078\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3410c286a1cc234f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/index.js\":\"11806b874e140cfe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"6a8b3678be7574f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/presentationInvalidation.js\":\"e4ab7be56fa6471b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyEditorOverride.js\":\"033252072c44c4f0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/propertyFilter.js\":\"c895e059d1276bfc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/query.js\":\"ef151c41f035a4c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/resolveFilter.js\":\"a053bf65c18eba40\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sourceBatch.js\":\"d92606b6c26b2d9f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/sources.js\":\"69a26d6b344a2201\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useBacklinks.js\":\"098ae2dd8ee5c76a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b4adf0c8e60ef0ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayCelebration.js\":\"cd2a9f4ed039b630\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/BirthdayOverlay.js\":\"1aab71b6670af2b8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/gate.js\":\"32068fc2ad45e5af\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/index.js\":\"0745412c202997dc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/birthday/wolfTheme.js\":\"cddd15a79175568f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/BlockDragLayer.js\":\"2b667e42564e29c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dragController.js\":\"5422cae3886aca45\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/dropTarget.js\":\"6e261a7fc8d49506\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/index.js\":\"ab306438ac11d435\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-drag/projection.js\":\"1ec196427bfa4c63\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/BlockMetaCard.js\":\"4f2d2b3065886544\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-info/index.js\":\"08ccc7080545c212\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/AddTagDialog.js\":\"0c7fdecd9894d0dc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f741e96f9a9cc714\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/TagNameIssueHint.js\":\"68854f9a8134734b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/addTagAction.js\":\"3287e3d8bb830685\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/appendTag.js\":\"18a53da1b02910a0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/config.js\":\"502918adef5d480d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/dataExtension.js\":\"26b713eb85c098cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/index.js\":\"546d6645e90ab461\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/block-tagging/propertyEditorOverride.js\":\"322f449762b93476\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9d18dc73db146ceb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9bf110f28661b124\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/Breadcrumbs.js\":\"16306df929a075f8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6b8fe221ea7e7077\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0bfaff4cc2694c97\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/index.js\":\"c1ebbfaefd2a5255\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"abacb157f4530759\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/CharacterCountItem.js\":\"ce184ceadde96092\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a01c2fa541a3a717\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/actions.js\":\"6fb1d11aa926fe04\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/blockType.js\":\"b158d54f9d370ac8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/charCount.js\":\"d67bbef85ed9158d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/dataExtension.js\":\"008eb52f123d3d28\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/index.js\":\"21f09dbac380fc04\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/profiles.js\":\"3d1b49da086ca398\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/properties.js\":\"2a1c387a5f0cf278\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/character-counter/textCounts.js\":\"ebd182074b3ca292\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/colemak-keybindings/index.js\":\"30bc42f9cf21726e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/CommandPalette.js\":\"e47c2d0e819a5fd3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/HeaderItem.js\":\"c6d639cde65ec0cd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/context.js\":\"7a3b3de01bc71712\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/index.js\":\"b13b362fd1851050\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/selection.js\":\"c27fd1c8f2bfb5f6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/toggleStore.js\":\"e582f46cd53c6835\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/command-palette/useCommandPaletteActions.js\":\"f69cda76935704fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/ContributorBadges.js\":\"931f6e53db4241a7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/author.js\":\"6dd68046f6ade1d9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/codeMirrorExtensions.js\":\"afb03e42cbd3d9ce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/dataExtension.js\":\"665e41be761c683c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/index.js\":\"5f480a1e23e5b642\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/mentionAutocomplete.js\":\"b50e4d5e0b25fc1d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/processor.js\":\"7c16fa73b3341416\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/profiles.js\":\"7cffcce6b50aac57\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/queries.js\":\"44b212fe5da33674\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/contributors/schema.js\":\"13b37aaa2286f5b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"75a369fc8f6dbc4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/followOrigin.js\":\"5d0565f5c5ded9a1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/index.js\":\"fa0268dc12171852\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c1f1cabedaaf4683\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f086949eed01a999\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/CalendarGrid.js\":\"f25382f898121482\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DailyNotePicker.js\":\"757500cc43a25daa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7e3ac01ed9c8135d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateNavDecorator.js\":\"4e868613881a5a3b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/DateScrubOverlay.js\":\"8aaf403fddbd2ce3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/HeaderItem.js\":\"1efde9f03ef2d600\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/ReschedulePicker.js\":\"7065b0b9fe1e6df3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d744bbd8e68e7917\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/actions.js\":\"a6320a8769e66d60\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/blockDateAdapter.js\":\"c68db59ef9ec6e15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/calendar.js\":\"fd7a8d976e80a7c6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dailyNotes.js\":\"932e721fd09596de\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dataExtension.js\":\"279c76677952956d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubActions.js\":\"90dd4f4f8cd35b82\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGesture.js\":\"7db83e5b883a39af\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3b7d7690dcf5e8d1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4a21751fe17c36f0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/deletionGuard.js\":\"3c8d264d4cf227ef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/dueQuery.js\":\"a785582bb7860d53\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/index.js\":\"2b1cd026afd9cbe7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/landing.js\":\"e9e1135eb0780f4a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/localSchema.js\":\"d6599ca8dfef3b07\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/referenceDateAdapter.js\":\"64f3af0e3f5f0605\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/rescheduleAction.js\":\"ea11efc654a73ca5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/schema.js\":\"ab3812857d8b4031\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadBlockDates.js\":\"b368fbac728785af\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/spreadDatesAction.js\":\"29ede8e610ac680c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/today.js\":\"20ddfd7174fd1a83\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a38cc5670af26935\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9d0005490bfd4a4b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/audit.js\":\"766127e76e3c87f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditAction.js\":\"67967723da2a7022\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/auditRanges.js\":\"a746683d400184c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/diagnosticsSource.js\":\"de85daf0d6c8d46b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/divergenceScan.js\":\"7d9e0e4e1973cd19\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/index.js\":\"d09af308cddeecb6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/propertyChildrenChecks.js\":\"91531c6cde6d1fde\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/referencesMirror.js\":\"2350da86dd97f9a5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/rowJson.js\":\"566854fc5171fd81\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/schedule.js\":\"a9977c627fec3b59\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/data-integrity/store.js\":\"27bb9221f24625cf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/action.js\":\"5ba6ca938dad0da0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/index.js\":\"886e8b262a811045\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-maintenance/plugin.js\":\"4fa5754ecb54e97a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bd819868b1da9b29\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/actions.js\":\"44306b65f0c7c310\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/changeMarker.js\":\"6d6352f739916130\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/diagnostics.js\":\"9759dd9392d67177\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/fileSystemAccess.js\":\"9c49de4d8c029f04\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/filenames.js\":\"cef22f491c8e1ff3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/index.js\":\"566882c41b327d33\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/mirror.js\":\"f30f728c176a785b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runLock.js\":\"92fde54449dcfe74\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/runtimeHealth.js\":\"6e357afef7a1e5fe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/schedule.js\":\"63cd6ffed7335cb5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/db-mirror/store.js\":\"085eedc9abd2446c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/index.js\":\"8808feaa61e570d4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/default-themes/themes.js\":\"40bd69644376274c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/facet.js\":\"0f0ffc13e29131c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/diagnostics/useDiagnostics.js\":\"ff299fe82a3782a6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/dismissals.js\":\"7677f15084743b9c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/index.js\":\"85ede66aeb637c7a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/status.js\":\"0a216d743326cca7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extension-prompts/store.js\":\"59994614385acb5e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"de7c06942404faed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ffa3202d3cea28bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/actions.js\":\"a732d3f202a35ed0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/config.js\":\"eae71477c798b534\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/dataExtension.js\":\"d6a3ec92988aefc6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/effect.js\":\"b10ff7e34b2bb10f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/index.js\":\"b552296e6ca34eb0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/propertyEditorOverride.js\":\"39fff0b985d88f38\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extensions-settings/useToggleTree.js\":\"52e64f38699a0bb5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/ExtractTypeDialog.js\":\"f274b9714c83db3c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e4359aa5f0c8d687\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/PropertyShapePicker.js\":\"778711ed6392feac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/action.js\":\"0d67cd0d8de06837\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/extract-type/index.js\":\"3888fd49c17a17a0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/FindReplaceDialog.js\":\"ba1e20779e1eba1d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/HeaderItem.js\":\"902ae3028b606bfc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/dataExtension.js\":\"f5be4811bfada2db\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/index.js\":\"abd180ef4d321ae0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/search.js\":\"55aa475f13d6fd3a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/toggleStore.js\":\"352b77f98481e2a2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/LocationPropertyEditor.js\":\"96c5e4f0497616df\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/MapView.js\":\"f8130a4ed8730582\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/blockTypes.js\":\"ea232f036ee134eb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/codeMirrorExtensions.js\":\"229741ae3a26d24b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/createOrFindPlace.js\":\"dc4e728e9d46c128\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/currentLocation.js\":\"e1747373f34eabc2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/dataExtension.js\":\"26bd5f7d914caaa8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/geoContentDecorator.js\":\"37847e33bd8c1c5f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/googlePlacesClient.js\":\"f4eccd8a6aeb457e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/index.js\":\"6c2cf64eb5e91e1b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/locationsPage.js\":\"5a5f8cd12ed8258d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/mapViewport.js\":\"f819891f8c6c119d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/pickCurrentLocation.js\":\"33e2ab57d5ab342b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeAutocomplete.js\":\"1985ecf6805c48bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/placeNameCollision.js\":\"c5034c29b9156274\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/properties.js\":\"aaae6181672e38bc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/propertyEditorOverrides.js\":\"861a0bbbfb20374b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/query.js\":\"8e471878a6f26e72\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/geo/usePlaceSearch.js\":\"02e3876bed4490e8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7bce5307a1c9a8fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"f61e82039299de1b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"028e780df9bf0327\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/config.js\":\"c34d0fb8b111dac5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/dataExtension.js\":\"f5c7f69e14c45939\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/facet.js\":\"019681c14be40c14\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/grouping.js\":\"29476faef1c9c3e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/index.js\":\"f09b8f0c70f1bc5a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6b5f837b42bf4c7d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/query.js\":\"9b9bba463ff46d63\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/resolveConfig.js\":\"0d3b40cc2c0cf36a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"6e3dfd766fd0facc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a82bd76e45e0ae0d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlDocumentContent.js\":\"b9e4b7a97fb96f80\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/HtmlFrame.js\":\"ea5317fb2d243282\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/actions.js\":\"53ddc9174c923e37\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/blockType.js\":\"1fce8b0cc1ac9531\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/confirmRunScripts.js\":\"2d2126332b678def\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/dataExtension.js\":\"4f1c73cd42e021b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameAnnotations.js\":\"6c880d736ac6c1b5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameDocument.js\":\"72325f3334d46073\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/frameTheme.js\":\"5047fda242d8f639\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/index.js\":\"07218ea03ffa91ed\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/scriptConsent.js\":\"df74571fff87f59a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/sourceMap.js\":\"4d33333f1cf4c85d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/html-document/useDocumentScripts.js\":\"97eda03756c578e3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/index.js\":\"b07ffb6079e7b118\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/record.js\":\"88287e7ccbc29e40\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/recordStore.js\":\"a3a2ec9e6577eb8f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/responsiveness.js\":\"b9555bc7100c5354\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/schedule.js\":\"34d038db7e0c23a1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/interaction-metrics/sessionContext.js\":\"6c4613f22428ae70\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f99eabe46dadc638\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a0fb8831c26b55c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/actions.js\":\"f08a8270b5d832bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/config.js\":\"dd5542689c3e3a3d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/dataExtension.js\":\"a45bc2c017c30d63\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/effect.js\":\"ce52b272414c3451\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/index.js\":\"01387283254bcc3e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/keyCapture.js\":\"7c000b4084bdb754\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/overrideStore.js\":\"353fcd62ac4ef6eb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4492423c0972f13d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/HeaderItem.js\":\"6c6824440f7c4935\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/LeftSidebar.js\":\"1eaadf01a241bdfb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/actions.js\":\"e6ca55fc286e79f8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/facet.js\":\"5bcf27835a57566a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/index.js\":\"c56d36d08543b42d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/shortcuts.js\":\"87e549b0b688b833\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/left-sidebar/toggleStore.js\":\"5604d99aa3e5181c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/MergePicker.js\":\"ef86cee5823a2242\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/index.js\":\"37c2bca904485752\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/mergeAction.js\":\"e31d3c3c3b043c18\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/merge-blocks/strategy.js\":\"2fb408c9331fa713\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/Button.js\":\"363866ac31695cde\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"85c963b1a385aa93\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f55b18648098a8d5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/facet.js\":\"b188540ec78385ec\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-bottom-nav/index.js\":\"e5dad595d9bef313\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3d1e8da07809edce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/actions.js\":\"cf1ddabbec250b61\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2e4cfddf6a63a5c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/facet.js\":\"01200e2410651368\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/mobile-keyboard-toolbar/index.js\":\"ba2998207f3f13e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d16b0a9394562789\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/blockSubtreeMembership.js\":\"762d497f5d1f6f5a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/contextMenuItem.js\":\"09b11b1e74bfd2c5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/index.js\":\"6a46526ec978f59e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveAction.js\":\"d9c71045e57c5754\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/moveBlocks.js\":\"9d83baddd8107c0b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/move-blocks/selectionAfterMove.js\":\"1405fde1a64b21f8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/TutorialBanner.js\":\"f12df9addc727df4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/action.js\":\"ddf0444ec0944975\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/bannerDismissal.js\":\"213671b16bbd62f4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/documents/cheatSheet.js\":\"33aec9f038e14395\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/index.js\":\"8c1db5f03a12a8b2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/keys.js\":\"5eb7e10b5fa9519e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/landing.js\":\"c30e9feec734bc1a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/outline.js\":\"495fe2ed7b70224d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/onboarding/seed.js\":\"41446f575eb27074\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7eed91e6ad5f57d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/analyze.js\":\"770af934b891b0ff\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/diagnosticsSource.js\":\"5066ec980cd688e4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/index.js\":\"09f7d7aad6b1a7d3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/load.js\":\"3ba6674da2b9d903\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/monitorRun.js\":\"5017fab1f9173155\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/schedule.js\":\"9d5babbbf6b714bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/series.js\":\"ab2027677f83201f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/store.js\":\"1fc612265e1d9c95\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/trendAction.js\":\"380c94ae0f887585\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/perf-monitor/verdict.js\":\"8ceac188ebb2e763\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/clickToEditAction.js\":\"5a3509f5782c2840\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/index.js\":\"f59c30b3c5350add\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/plain-outliner/interactions.js\":\"6933aa591d9724b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5cd60c359ec9e91f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGate.js\":\"eeb75118965da40c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/MigrationGateDialog.js\":\"d42208a227744afe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/action.js\":\"f2e74087dcf13949\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/index.js\":\"2fefd5d9fb0227e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/localRunMessage.js\":\"c964c7af9122e3ae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/plugin.js\":\"ba64a123a2bc1fd9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/progressReport.js\":\"9ab8d3b106d6b22b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/properties-migration/sweepProgress.js\":\"9139c8fac6fc36d8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/FieldRowRenderer.js\":\"86f974cb78bcf350\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/ValueRowRenderer.js\":\"3306dc9cd0ed1ace\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/actions.js\":\"795e4e22c9ef30bc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/autocomplete.js\":\"74dd035762692e78\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/fieldRow.js\":\"deb1623eb777b99e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/index.js\":\"a761b25573f6f6d8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/referenceWarning.js\":\"80304756c44b8494\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueAutocomplete.js\":\"396367cbdb682f2f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/property-rows/valueSchema.js\":\"929076c59c813d0d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/HeaderItem.js\":\"ae9c19025ddd48bd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/QuickFind.js\":\"6484fa561f1a49e5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/index.js\":\"294b985c3b5dad4c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/recents.js\":\"c25d07a57bb2b83d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/resultItems.js\":\"0a2f1a08328eaca9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/selection.js\":\"7106372152077bf2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/quick-find/toggleStore.js\":\"cb9b2f34add03ff4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/HeaderItem.js\":\"f74782cd89b6a64e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e657034bffef45bf\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/grouping.js\":\"48ca4f472b7711f2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/index.js\":\"c44b9eb7216618a3\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/recents/target.js\":\"53549fdec7bfc86d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/codeMirrorExtensions.js\":\"3a04fe0f4fdf9ac6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/contentPrefill.js\":\"7a563493021a0bc6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/dataExtension.js\":\"fc844de1b563d106\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/index.js\":\"62fd9c0ae2a48a02\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0089ebd14848ca9e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/invalidation.js\":\"62ae52fafc20d326\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/localSchema.js\":\"4d3e03fb77d463f5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/index.js\":\"616cba0c0bac2860\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a5df0aa363e73036\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/index.js\":\"0a1ffa8c9ffbf125\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/referenceNode.js\":\"0290a3a57c5509f1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/remark-reference-occurrences.js\":\"859085b40fc21dd9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a4a5f505c7c7d793\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/index.js\":\"9e0fd073728020ac\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8d422d6831181c30\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e223a0ab43cbde58\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/mergeRetargetProcessor.js\":\"0dd7521540a48a6f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/parseFence.js\":\"36239b191aa4b413\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceParser.js\":\"2f60e3e620bc1acb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referenceProjection.js\":\"4c9df99fa4439bfc\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/referencesProcessor.js\":\"fc0c75f85ee8b9d5\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/renameProcessor.js\":\"2291c90cfd939bfa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/references/spanReplacement.js\":\"0ff8589cf509596e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/htmlToOutline.js\":\"88a15f8f6fd47b73\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/index.js\":\"96c90d028e00c201\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/normalizeClipboardDom.js\":\"4823367263efdd67\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/rich-paste/pasteDecision.js\":\"59d83d61d2f21e95\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/action.js\":\"d39aeb547de28a4e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/blockIds.js\":\"7dc85107d8a41a03\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/content.js\":\"b220e22fe179a690\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/effect.js\":\"e99b8946fb1aba18\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/ids.js\":\"b8d0d8b55bb866df\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/import.js\":\"ec85cb683b78872d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/index.js\":\"e4430b3eaef4c422\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plan.js\":\"dae10dcb612ff280\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/plugin.js\":\"20c213291c871ba2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/promotion.js\":\"c3d772995ca9fd87\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/properties.js\":\"a95f0d9506d54610\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/references.js\":\"fa8937f96521ba08\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/report.js\":\"0ef7e4bac2e61b52\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/roamMemo.js\":\"94d32a25efc33771\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/runtime.js\":\"82791fd1c0438c82\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/schemaReconciliation.js\":\"15c809b6871676ce\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/srsMarkers.js\":\"dad5f774cb59d3cb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/todo.js\":\"ab07739020bb5565\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/typeCandidates.js\":\"0f7bf4e23f88c457\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/roam-import/types.js\":\"4ff44d6f3fef1448\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/index.js\":\"678add42826a0924\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/search-health/store.js\":\"926d30145b09fa4d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/HeaderItem.js\":\"e696284820446fd8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2d86d058c6ef7da9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/index.js\":\"8311de458219854b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/model.js\":\"ced12d1218f607e1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/toggleStore.js\":\"f93e78442405b555\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/shortcut-help/useKeyInspector.js\":\"6b0b99a70c65193a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"7204f6e1ba785235\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/ShellDecorator.js\":\"979c285c35d0ceae\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/actions.js\":\"cc4eab77efc0d12f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/exclusionsFacet.js\":\"61ed97f75bae727d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/index.js\":\"12918fe694f7e6e6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/shell.js\":\"c932ac713d808783\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/surface.js\":\"f421d94318fe77cb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/spatial-navigation/walker.js\":\"0370e1d2dc9cf8c9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3364e6716d1b42c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/dataExtension.js\":\"a2d77624960a77fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/index.js\":\"dfee63c9fd280c5c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/indicator.js\":\"1fd7722bd433633f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/moveSrsState.js\":\"dc4e58cf2c5c3276\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f33f4f0e38024dc1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/scheduler.js\":\"21225b22f636ad58\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/schema.js\":\"6d6a08bdec80f895\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c74fe6005711b117\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/srsClipboard.js\":\"13aedc4a32c9087f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"734d1d5a640f0565\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1ac8b987e6211a0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/DeckPicker.js\":\"e460f27a3aa608c1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewControls.js\":\"ab3612d401ef52c2\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7b8aa095740e254a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/ReviewSession.js\":\"5ea2df240eae8b20\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/actions.js\":\"2add8a300b3c9d28\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/archive.js\":\"04f63da6f19723fa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dataExtension.js\":\"58f0033825824fd1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/deck.js\":\"8e728fe125074c0b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/dueQuery.js\":\"3286a58e2db69477\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/gradeDecision.js\":\"261db5121a1df760\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/index.js\":\"ed579040169f6451\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/keyHints.js\":\"1d631d29ae11a8ad\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewCardLayout.js\":\"0319141ffc2daa1f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/reviewProgress.js\":\"9a91ad9d00249957\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/schema.js\":\"07ab4a4a7a578a62\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/srs-review/useDueCards.js\":\"9f2036579dadf7dd\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/index.js\":\"ad04e947fcccbfa9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/startup-metrics/record.js\":\"8aa900e9573350b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/index.js\":\"f66bde139a464f15\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/persistenceStatus.js\":\"da840895ff4a7a95\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/storage-persistence/requestAction.js\":\"7279afca67ad3d1c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/TypeChipsDecorator.js\":\"99b49bf2fec824a1\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/codeMirrorExtensions.js\":\"f7b24fc6bf110004\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/index.js\":\"21fff4edea5ad036\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/supertags/typeAutocomplete.js\":\"fbdeb0a5ccf21dc8\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c37111287f2cda7e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/actions.js\":\"7554a41a645d3161\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/anchor.js\":\"5a4a89bbb993c303\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/events.js\":\"6f5fa5c120be9f8f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/gestureActions.js\":\"10c9a2ddbe700300\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/index.js\":\"5a4a0fe53b89fed4\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"ac6bc912b811d118\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/collect.js\":\"0154d9a5c43abd0e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/index.js\":\"100315a317fe5c84\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/sync-metrics/record.js\":\"f642cc7ff7dbdade\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/RejectionDialog.js\":\"ab45262aa7abf3b6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c7884579db41027d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/index.js\":\"b06bc6ebb5ca5376\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/model.js\":\"858ae1cf6d41ba6b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/queueCounts.js\":\"0ca084ba953584e7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rejectedHelpers.js\":\"af157c4583dc03f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/rematerializeAction.js\":\"b47768f10f98d077\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/system-status/useHysteresis.js\":\"57694515853516c7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/ColumnHeaders.js\":\"1558939bfbddd122\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/QueryUi.js\":\"c1e4651cf4a01a21\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/TableLayout.js\":\"f48b55cba632c1bb\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/actions.js\":\"ee1d9ba15b6f0224\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/cellEdits.js\":\"48b8127624ed8593\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/columns.js\":\"0fb3558e2387eb03\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/controller.js\":\"0107ee5d4d566981\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/convert.js\":\"1f4389be1ce89e5b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/dataExtension.js\":\"637da441f2047573\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/index.js\":\"bdf2577f5ef37490\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/keys.js\":\"dfaba1043afe1e0c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/model.js\":\"33c38b278679d6a7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/backfill.js\":\"92af465adac981da\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/completion.js\":\"b631f2c58347313b\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/format.js\":\"f8a8989a6634cf4c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/parse.js\":\"251aad99ca00b17f\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/queryValue.js\":\"7894fccacfb4301c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/query/source.js\":\"ce5f1870f74a2a10\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/registry.js\":\"8a290ba1aecdb5ef\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/schema.js\":\"2b0e3e90ad37d722\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/tables/sort.js\":\"a2a9c70a7fb40dd0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/effect.js\":\"d4ca4b9e8da0abfa\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/index.js\":\"3f921e5a1e770e02\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/theme-toggle/theme.js\":\"299fd911ea0ec368\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/actions.js\":\"bec2d557cc9e0438\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/dataExtension.js\":\"ca745260410ff756\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/index.js\":\"684beddcbaefd19a\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/todo/schema.js\":\"f6ae4cafb9793482\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/TouchSelectionLayer.js\":\"2bac31c6e94d11b9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/actions.js\":\"2086b9f0b50c2a3c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/defaultItems.js\":\"bde4c9500e1b55a0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/facet.js\":\"a8f9b0ce77beb6f7\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/holdRecognizer.js\":\"a370d0936cd9d819\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/touch-selection/index.js\":\"6bdc610d3bb0dc9e\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/UpdateIndicator.js\":\"de9293f799c6b995\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/index.js\":\"b4b0d03a95f10a10\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/update-indicator/loadTimes.js\":\"4df67aa878bbd826\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoNotesRenderer.js\":\"4f8c5c6c302d7da6\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoPlayerRenderer.js\":\"30377fca91c53597\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/VideoTimeStamp.js\":\"a2dcaab326dbe393\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/actions.js\":\"682e53d5d2b79175\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/index.js\":\"df9bc8ace84b1000\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/markdown.js\":\"2c7aea55c3f2eeca\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/notes.js\":\"4f6820de40a19e10\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/registry.js\":\"aa85127327ddfdbe\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/remark-timestamps.js\":\"b0ea1be7878643c0\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/video-player/view.js\":\"a7671315ac714839\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/LinkHints.js\":\"d3b74c9702f8039d\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/index.js\":\"4243a9698e8de404\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/model.js\":\"c2fb21cd28cb6c8c\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-link-hints/settings.js\":\"f93f0e0bde899527\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/actions.js\":\"f144591f2b373542\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/index.js\":\"c6839e40ced7a000\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/vim-normal-mode/interactions.js\":\"da6f3ba6708204e9\",\"/knowledge-medium/pr-preview/pr-1843/src/plugins/workspace-header/index.js\":\"2771c94b74dc0329\",\"/knowledge-medium/pr-preview/pr-1843/src/registerServiceWorker.js\":\"ad897eaafcfcc8e1\",\"/knowledge-medium/pr-preview/pr-1843/src/requestPersistentStorage.js\":\"4b4c7b99260de4aa\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authRequestDeadline.js\":\"de32f15cb1603b33\",\"/knowledge-medium/pr-preview/pr-1843/src/services/authStorage.js\":\"4bb692bb6bcb14a2\",\"/knowledge-medium/pr-preview/pr-1843/src/services/powersync.js\":\"e8023857082fe237\",\"/knowledge-medium/pr-preview/pr-1843/src/services/supabase.js\":\"0f7c7341646c9a9e\",\"/knowledge-medium/pr-preview/pr-1843/src/services/uploadErrorClassifier.js\":\"3af57bb291ee2f49\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/ActiveContexts.js\":\"cbd03d01b081d9d7\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/HotkeyReconciler.js\":\"c4f7f41c45590473\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/WipeLocalDataDialog.js\":\"940e1aebff818445\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionDispatch.js\":\"49dbcb4842f14abc\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/actionRefItems.js\":\"b7d47ac01b27d2e4\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/applyKeybindingOverrides.js\":\"afb4e3f4d400e05b\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/blockActions.js\":\"c4f134acfcd8322c\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/canonicalizeChord.js\":\"cb3384d01e6e3eb3\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultContexts.js\":\"fbcca46b2252c900\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/defaultShortcuts.js\":\"7ffa6945059c8ee2\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/effectiveActions.js\":\"ea51d5a27747eec5\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureAction.js\":\"72c7048eb098b319\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/gestureBinding.js\":\"d9384f3e16b62cde\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/holdRegistry.js\":\"a86dfe930afe2151\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingConflicts.js\":\"ba6bc444b49eb187\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/keybindingOverrides.js\":\"06ed9093bdaeea6d\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/pointerAction.js\":\"89adacd8978f76e0\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/resolve.js\":\"98ccbd085489332b\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/runAction.js\":\"92fe32e679aac707\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/sequenceMatcher.js\":\"f9f12cf6a48bbaf9\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/types.js\":\"9fd4f1c05f704a7d\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionContext.js\":\"734a2cee49f56566\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/useActionDiscovery.js\":\"c122dac6bb8dc5d2\",\"/knowledge-medium/pr-preview/pr-1843/src/shortcuts/utils.js\":\"711c25d52618b673\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/bootStore.js\":\"7fe3476b1fb76e7d\",\"/knowledge-medium/pr-preview/pr-1843/src/sw/previewDatabases.js\":\"d0bd1c392e75903b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/byteTransform.js\":\"048b6f6ac51bf0a5\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/attachmentCleaner.js\":\"a08f116ce853b904\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/attachmentParts.js\":\"d79bea6e70735450\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleParts.js\":\"b73dc269ac1fd14d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/bundleRecord.js\":\"d120650fde33f871\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/manifest.js\":\"5a354f3f5aa406a7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/takeBundle.js\":\"db8da09e094e0ef6\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/bundle/verifyBundle.js\":\"822951ef09546861\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/cleaningStage.js\":\"9c842158c2c8cf05\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionKey.js\":\"bf63b35e2a931222\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/conversionServer.js\":\"56f9c59a7b02a0f7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flip.js\":\"fac327cfe336b298\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/flipAttempts.js\":\"2ba6d59bf04e8e19\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/pages.js\":\"0f5300f923949841\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/preflight.js\":\"72baff59c868cd85\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/reseal.js\":\"2bd062ddc2f1586e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runConversion.js\":\"d3b26b7433bcfdf4\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/runLock.js\":\"8f61c4325f256bb9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealing.js\":\"682d4a7752053874\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/sealingStage.js\":\"f96df5c98530350e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/stage.js\":\"8a6de0a89736f63c\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/conversion/verifyReseal.js\":\"af7ad7bff1b6ccb3\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aad.js\":\"9b2ea3e428d5ff16\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/aead.js\":\"fda68149a51f9ffb\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base32.js\":\"6e54300e69f741c1\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/base64url.js\":\"61c607f06322349d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/binaryEnvelope.js\":\"dcabca5f9263653d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/byteAead.js\":\"3778c767a08fc98d\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/canary.js\":\"6fdef352571e04af\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentHash.js\":\"2e41b58243d2819a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/contentKey.js\":\"1f7e3929b1bf8522\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/derivedIdNamespace.js\":\"f71dde1131aaa5d7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/envelope.js\":\"07cada2291628ada\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/hex.js\":\"794aa621f6db57b2\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/sha256Hex.js\":\"3dea57ae7175bd88\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/crypto/workspaceKey.js\":\"a1c800306f54fe67\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/conversionState.js\":\"8a35748375a8e6d4\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/createEncryptedWorkspace.js\":\"aa02771d21f4069b\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/pastedKey.js\":\"ef3465c6069bdb76\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"64d169e4296cec3a\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8fbc61499e59f565\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/keyStore.js\":\"29c05d9dfca5dbeb\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/mintWorkspaceKey.js\":\"65c51fb794dd57d4\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/modePin.js\":\"a5d76542d9651d3e\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/openWorkspaceKeys.js\":\"976e7593a685a2f7\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolveWorkspaceEntry.js\":\"819f246d33692aa9\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/resolver.js\":\"916877a3b4af0a18\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/keys/workspaceAccess.js\":\"705e9492e8191e81\",\"/knowledge-medium/pr-preview/pr-1843/src/sync/transform.js\":\"59095456d2d4c39a\",\"/knowledge-medium/pr-preview/pr-1843/src/themeBootDefaults.js\":\"b521444f08c84a6c\",\"/knowledge-medium/pr-preview/pr-1843/src/types.js\":\"ea82675280125249\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/ClientLocalSettings.js\":\"494e47d77fc3e349\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/abortableSleep.js\":\"31210f10a5d6549d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/array.js\":\"4e89d940d5c6a865\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/backlinkAutocomplete.js\":\"0bf37ba5ffb05ed2\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockCrumbs.js\":\"51e6b2ea05016d0e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/blockrefAutocomplete.js\":\"df80a0889bbffcf0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/cadencedIdleJob.js\":\"bd7e213839987e25\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/callbackSet.js\":\"0cd62ecabcf91017\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/clientId.js\":\"028f7c3c0c3c771a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirror.js\":\"7f65e814d5157e8c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/codemirrorCompletion.js\":\"647beecd326059c0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/copy.js\":\"9917ad81423936f1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dailyPage.js\":\"57e2ecad0b286d71\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensics.js\":\"7e9bbdb3a7041f5a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dbForensicsHooks.js\":\"269e30a27108cb50\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/deleteBlockThroughUi.js\":\"d2a626eebea85ec7\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dialogs.js\":\"afb6049694d7f96e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/dom.js\":\"3770aaac1e38ed3b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/downloadBlob.js\":\"872c6c7216583fef\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/exportSqliteDb.js\":\"87b7ad9495652518\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fileSystemAccess.js\":\"422754fe92fe57a7\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/flipSlide.js\":\"d34f620c7a97b0ae\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fnv1a.js\":\"247c0910d038d6ac\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/formatBytes.js\":\"93593fac85db972e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/fuzzyRank.js\":\"639befbb2a2ec47b\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idbKeyedStore.js\":\"34dc134abe54ccae\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/idleCallbackPolyfill.js\":\"0241e87e6eea8288\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardAwareScroll.js\":\"822fed59967ee188\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/keyboardViewport.js\":\"f7680f696b67fce0\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/lastWorkspace.js\":\"12f594659e01da9c\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutColumns.js\":\"830e2acbebb05b8f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionDom.js\":\"739a4add538b0b96\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/layoutSessionId.js\":\"7f527778fe51c200\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkClickGestures.js\":\"acbe8e8aebadfc50\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/linkTargetAutocomplete.js\":\"80159a25632dc9bb\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbCorruption.js\":\"faa28c0ab559b12f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/localDbRecovery.js\":\"d8a039d117f66578\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/markdownParser.js\":\"f4c41b921a3f1d03\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/memoize.js\":\"327ef16583f48512\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameFieldCommit.js\":\"b54448a1b04d30ee\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/nameList.js\":\"b41934c5567324cf\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/navigation.js\":\"305ff09af823266f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/omnilinerNamespace.js\":\"ca72a88886921073\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/opfsPageScan.js\":\"191af0cffbcda330\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelClearance.js\":\"598c8353c5801bb1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelHistory.js\":\"043f38bb5ea9ffa9\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLanes.js\":\"bc14cb63ab1dc857\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelLayoutProjection.js\":\"b800dad4e0af7e10\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelScrollAnchor.js\":\"daeeb9d08f893777\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/panelUrlFlags.js\":\"41365adfaecd0fa4\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/platform.js\":\"2833a497c7ccd36a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/pluralize.js\":\"57fb7ca2a614ad7e\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyCreation.js\":\"22ee2a8f3e4b4464\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyNavigation.js\":\"2012608cdcc0734f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/propertyValueContext.js\":\"9d13080a4aede55a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/react.js\":\"9ff95e795015a4cc\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeDate.js\":\"da59a409cca736c3\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/relativeTime.js\":\"a85f2473ae6dbd23\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/renderScope.js\":\"78430f61778bd47a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/resolvedThenable.js\":\"e79091ed09a61e13\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/routing.js\":\"0aa0ec071615740a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/safeMode.js\":\"85a77585ff186e50\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/scheduleIdle.js\":\"99cf808f8194adb6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/screenWakeLock.js\":\"66d431b5b07efa6d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/selection.js\":\"5d4c1a60950c14b1\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/softKeyboardGrab.js\":\"8066e6e1855afa5d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/startupTimeline.js\":\"fdd4b827d8abb6cf\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/state.js\":\"9a474cd7bd34015f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/string.js\":\"e30b5acb0187dd57\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/surfaceZoom.js\":\"215393ac0408256d\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/time.js\":\"763e30d93f64c06f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toast.js\":\"42a82fcec495f88a\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/toggleStore.js\":\"ae7d580b09883e87\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/untilStopped.js\":\"5216c4ea6647d891\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/userActivity.js\":\"d24ada9d8302fd46\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewTransition.js\":\"b287c63e91486e29\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/viewport.js\":\"afe06e27d50dfd86\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/webLock.js\":\"e94c8a118c4e683f\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceRecovery.js\":\"5e6a41a61347fda2\",\"/knowledge-medium/pr-preview/pr-1843/src/utils/workspaceSnapshotStore.js\":\"e6cdc970e8b90fbe\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-compiler-runtime.js\":\"b302f43fe4800077\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-client.js\":\"65a2c1e2ab3c6e8e\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server-edge.js\":\"20365f2296476077\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-server.js\":\"142968c4758e8ab2\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static-edge.js\":\"6ddd2de1117b6978\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-static.js\":\"9f6ccb268387b6e2\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom-test-utils.js\":\"1844fd67f6aaa135\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-dom.js\":\"64e824778c0ff882\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react-jsx-runtime.js\":\"a3d7924c217e840f\",\"/knowledge-medium/pr-preview/pr-1843/src/vendor/react.js\":\"9696aa6405a5f1fc\",\"/knowledge-medium/pr-preview/pr-1843/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1843/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
