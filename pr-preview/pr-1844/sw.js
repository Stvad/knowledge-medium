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
		buildId: "d18fe86e1500-f5fcd0f4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/\":\"f25adddcccb97b54\",\"/knowledge-medium/pr-preview/pr-1844/index.html\":\"f25adddcccb97b54\",\"/knowledge-medium/pr-preview/pr-1844/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1844/assets/FacadeVFS-CdPZJozz.js\":\"95dbbe99d24a85e0\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSCoopSyncVFS-DX-4dq8o.js\":\"f61de067a0052a45\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSWriteAheadVFS-BhUDl6pR.js\":\"90c784d9a94dae31\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-BWUc3oPE.js\":\"dbf8f5c7e4fa691a\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-ikNcdICK.js\":\"13bb89deac0b406f\",\"/knowledge-medium/pr-preview/pr-1844/assets/worker-BeKqn80T.js\":\"95f1ed473eb16e98\",\"/knowledge-medium/pr-preview/pr-1844/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1844/chunks/app-BaDTmYNp.js\":\"55fe761e45056bdd\",\"/knowledge-medium/pr-preview/pr-1844/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1844/index.js\":\"39f07e3e847a1bec\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1844/assets/AccessHandlePoolVFS-A3-OAZnf.js\":\"3594d17686c4670e\",\"/knowledge-medium/pr-preview/pr-1844/assets/IDBBatchAtomicVFS-C6xEtJtD.js\":\"cc1fadd6cbcadeab\",\"/knowledge-medium/pr-preview/pr-1844/assets/MemoryVFS-DVo-dTJ4.js\":\"d8f85a52506fe0b2\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-SUWAzvyQ.js\":\"abf42bf3002268da\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-5cmjl-J3.js\":\"00adf704c198e3ef\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1844/chunks/AccessHandlePoolVFS-DGWGNDXy.js\":\"9ea32e28b6128531\",\"/knowledge-medium/pr-preview/pr-1844/chunks/FacadeVFS-oSfBWhY0.js\":\"e0fe08d247d5af21\",\"/knowledge-medium/pr-preview/pr-1844/chunks/IDBBatchAtomicVFS-DMbGsW1e.js\":\"ee26619e0c952b9f\",\"/knowledge-medium/pr-preview/pr-1844/chunks/MemoryVFS-BTV3IVpi.js\":\"e4d90305d882f597\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSCoopSyncVFS-BKtJoK95.js\":\"a950b13aa929cf45\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSWriteAheadVFS-erUExqjc.js\":\"8368dae0037ddc96\",\"/knowledge-medium/pr-preview/pr-1844/chunks/Preview-CiaMkbuQ.js\":\"b8c5b7af80cb4b38\",\"/knowledge-medium/pr-preview/pr-1844/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/card-B9Pz6vAd.js\":\"fd687e1c36c1a415\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-DJAyjbq2.js\":\"175bf405c2e0b2bf\",\"/knowledge-medium/pr-preview/pr-1844/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-CnUpQEJl.js\":\"21a79808d9b496a7\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-async-CvGrzZ_c.js\":\"9692696160d7f73c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-0DCNnmu7.js\":\"f11c4c8b0b3686e4\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-Bfb8E-TJ.js\":\"a4c901a035f5f9e9\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-Bz1z8D13.js\":\"393fd88c22977de5\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-C6NGbufj.js\":\"5b2510c6be5b5381\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-D3AGVPxK.js\":\"4352c3bb1c54c77b\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DUIE7Ofm.js\":\"7f645dbcb177cda5\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DwgaDUHt.js\":\"63a98356fc0a485e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server-legacy.browser.production-xF9YMG_P.js\":\"fd35f244b94ce8c9\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.browser.production-AApaoc-e.js\":\"28e93d3ac24ec69e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.edge.production-B3RprxDY.js\":\"da643fdf3dc364bf\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-exNYMJen.js\":\"b2dbdc1edf1bfecb\",\"/knowledge-medium/pr-preview/pr-1844/chunks/server.browser-CZxY75h2.js\":\"8595b964e49c2b9b\",\"/knowledge-medium/pr-preview/pr-1844/chunks/textarea-B_c0gF9W.js\":\"f5d803b0684953d7\",\"/knowledge-medium/pr-preview/pr-1844/chunks/ui-CGVBQjrq.js\":\"acabf9401842968e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-BvEzlTnI.js\":\"5393f551905b546c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-async-Xadwtb4r.js\":\"bafc79d117cd8e66\",\"/knowledge-medium/pr-preview/pr-1844/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1844/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/src/App.js\":\"35f95723f22a37a2\",\"/knowledge-medium/pr-preview/pr-1844/src/appUpdate.js\":\"06815f09c43292c5\",\"/knowledge-medium/pr-preview/pr-1844/src/appVersion.js\":\"08acda357b6ed2ef\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/initialLayout.js\":\"b5dc854958c5a50f\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/openWorkspaceData.js\":\"c9c23cdae2180f46\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/resolveWorkspace.js\":\"60ffbf4d2d4e6ee0\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/workspaceBootstrap.js\":\"5b1a4469bc8790ee\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockComponent.js\":\"f9b8bed3a320ba52\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockCrumbs.js\":\"ef3de55f0fbaead8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockEditor.js\":\"877e292e677a02e4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockLoadingPlaceholder.js\":\"a7c5e82627cfca6a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockProperties.js\":\"77c629d580e71f99\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockSearchPicker.js\":\"672d56f4ad151a9c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ConfirmBulkDeleteDialog.js\":\"d55a63db5be5803d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DividerHandle.js\":\"2cd849a9bc600358\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DraftEditor.js\":\"c60080a73bdfa812\",\"/knowledge-medium/pr-preview/pr-1844/src/components/GutterPill.js\":\"bb54287fb2fb39e7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Header.js\":\"69afe327e95e942f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/LazyBlockComponent.js\":\"b4ed7a1d70062f41\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Login.js\":\"3a5739ea079ae114\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ZoomableSurface.js\":\"10a973f4dc67fa61\",\"/knowledge-medium/pr-preview/pr-1844/src/components/editModeKeepalive.js\":\"0a3292fb458f13ac\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b86a8aa895a532a5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f64f25ca7e8c02f8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefPropertyEditor.js\":\"1fcd885c021c9e36\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefTargetTypePicker.js\":\"3ae95d7f215770de\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/SelectPropertyEditor.js\":\"817ae8fdd6413d72\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/TypesPropertyEditor.js\":\"e7b69b73d2ff3cc2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/defaults.js\":\"7817e69d480e72ac\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/kernelValuePresets.js\":\"9a9726c8cda419ae\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/selectablePresets.js\":\"1b8180386c4f9dea\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/typesPropertyUi.js\":\"32b984dae5e8d508\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/AddPropertyForm.js\":\"c89a57c7f2de561e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyPicker.js\":\"728a98f53cc78d48\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyRow.js\":\"5a420db598b177fe\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/Rows.js\":\"ee73d8a19bfc79ea\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/actions.js\":\"ca8724fc4a462b55\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/declarationOnly.js\":\"4f310005d550fa78\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/layout.js\":\"f2ed79d5d8e8253d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/model.js\":\"26bfd52ef9574c7a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapeUi.js\":\"869f07814f37146e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapes.js\":\"4e54cb6d58223c91\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4c135f360a83cd27\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/visibility.js\":\"b827ee6cf55479bb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanelSections.js\":\"c46751c82e8178d0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockEmbed.js\":\"e92f53bd2660f812\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockLink.js\":\"4cd4d970b05edcd5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockRef.js\":\"b1bfe212a6a92e8a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/ReferenceLink.js\":\"753375a2c966db21\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuard.js\":\"5fe3ef31ddb4fddc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuardContext.js\":\"cfb918024c8435cd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/linkInteraction.js\":\"035931d771db772f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/referenceLayout.js\":\"2efa64ec3819a770\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/useBlockRefAncestors.js\":\"f366e9a1d74dfe06\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockGutter.js\":\"06a31fdb8200f2bc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockInfoDialog.js\":\"a4ed9c39441be873\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockTypeBlockRenderer.js\":\"aab907dbd781b811\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BulletHoverCard.js\":\"d78073af127c619d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorContentRenderer.js\":\"210af7dd9e5496fe\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"38129e92c782ccb0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ColumnResizeHandles.js\":\"4c27cc618df8bba2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f8511dcd6dbaddec\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/DefaultBlockRenderer.js\":\"44b5db55910798e2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/LayoutRenderer.js\":\"46408cb7874caea2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MarkdownContentRenderer.js\":\"b97733fc3cc7c21b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MissingDataRenderer.js\":\"5d7c054359d754bb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PanelRenderer.js\":\"fb2520bb3b27b181\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PropertySchemaBlockRenderer.js\":\"29d598f25b9b04a1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/TopLevelRenderer.js\":\"2c9e888f25a1ecb1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockGutterMode.js\":\"1050ed7d354a392a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockTitleText.js\":\"029f2ddbaf72f1da\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/fieldCreationKeydown.js\":\"775958e68f8c1663\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/layoutRootContext.js\":\"8a16d9cf6d45c198\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/TypeChip.js\":\"2695b0f05056d561\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/chipStyle.js\":\"f553ecb8e046d209\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/anchored-floating.js\":\"98ea64c17720eb08\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/button.js\":\"46f291a03dbe64e7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/card.js\":\"f6d0fa24e80f5888\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/checkbox.js\":\"5d20969065b7160f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/collapsible.js\":\"f9d3815382f18f10\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/command.js\":\"7e3d7c5a7155b125\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/context-menu.js\":\"88cd5c89b1263921\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dialog.js\":\"bc0ee0791760bd27\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dropdown-menu.js\":\"970c877f2d437519\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/floating-listbox.js\":\"4e66e56204b58106\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/index.js\":\"c7e2f0e0b8377ebd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/input.js\":\"ffd74359efec084d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/kbd.js\":\"530dd823337a1141\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/label.js\":\"9376d09f9c8cbb22\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/textarea.js\":\"d62e3b2369b94e90\",\"/knowledge-medium/pr-preview/pr-1844/src/components/useEditModeYieldKeepalive.js\":\"f1aa8ac1bf7f9a04\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/BootFallback.js\":\"179917a1f0a83ca6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/FocusedRowLazyMount.js\":\"1f13838bd37bf53e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LazyViewportMount.js\":\"66645567fca34d61\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LocalDbCorruptionFallback.js\":\"7087d475a7445739\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/error.js\":\"5c6dbe93804cd1b6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/lazyMountRegistry.js\":\"dbaa194d620be825\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/suspense.js\":\"036f02833a2b5d5c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/CreateWorkspaceDialog.js\":\"0f4d3c97ed8e55ae\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/PendingInvitations.js\":\"d2841780ac1ebb93\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/SyncProgress.js\":\"be94baaa28719f36\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/UnlockProgress.js\":\"30dc543559b656f2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceKeyGate.js\":\"838f11b4f93e03fa\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSettingsDialog.js\":\"f886aa76d91a00e5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSwitcher.js\":\"ac417c9c1b149828\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSyncGate.js\":\"5dc694fecf6014e6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlow.js\":\"2b09bc15fcdff769\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlowHost.js\":\"8e4ef941331867f6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/EncryptionSection.js\":\"be6c606873cd9ffc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/attachmentPrompts.js\":\"5a92d62e416102cb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ea2fa9aa27124748\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowDeps.js\":\"028e6b5e7c3ac2f8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowStore.js\":\"1901a55ef206ca8f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/flowUi.js\":\"2f7550f3c9cf79a2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/useConversionRun.js\":\"42dd9a1fe3904bcb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/keyUi.js\":\"f869af9817e9924a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnKeyLoss.js\":\"f5b4cee9e7d4e759\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnServerE2ee.js\":\"996bf960e5dddaea\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/workspaceUnlocked.js\":\"f511c5cdeb6cb66d\",\"/knowledge-medium/pr-preview/pr-1844/src/context/backgroundSubtree.js\":\"a1882ef132219537\",\"/knowledge-medium/pr-preview/pr-1844/src/context/block.js\":\"a20fa092da2bd33a\",\"/knowledge-medium/pr-preview/pr-1844/src/context/layoutWsContext.js\":\"1ce45c807692fadd\",\"/knowledge-medium/pr-preview/pr-1844/src/context/propertyDisplay.js\":\"bb2b860a9c8f0136\",\"/knowledge-medium/pr-preview/pr-1844/src/context/repo.js\":\"fb6a4048ec4c7d0c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasClaim.js\":\"02bca5fd2b1af440\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasSeatNamespace.js\":\"aacc2a0fff513c56\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockData.js\":\"ba36ce45e5edc2ab\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockType.js\":\"ef8556ccc2a8b55f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/changeScope.js\":\"deac6a53359d48c5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/codecs.js\":\"fa9c88cf9448dbfd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/derivedData.js\":\"0829a9efec37a7dc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/errors.js\":\"febeb80288e07355\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/events.js\":\"14b3baf573015af3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/handle.js\":\"90cbebcaa98253d8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/index.js\":\"5e0304d31fba3c1d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/mutator.js\":\"186e58a40210550a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/processor.js\":\"596b42843638eccf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/propertySchema.js\":\"30acf0faf945e213\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/query.js\":\"8c01eb36af85810a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/sameTxProcessor.js\":\"5ea8393cc0a1553b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/schema.js\":\"90cbebcaa98253d8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/tx.js\":\"90cbebcaa98253d8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/typedBlockQuery.js\":\"f2c0a7325ee21bf4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/user.js\":\"1965a168c91dee48\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresetCore.js\":\"b8af0cf18cfe250f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresets.js\":\"b72b24b93eab7bba\",\"/knowledge-medium/pr-preview/pr-1844/src/data/attachmentCleanerIOVerb.js\":\"f4ff1c9f9db23a10\",\"/knowledge-medium/pr-preview/pr-1844/src/data/block.js\":\"1ea5d31637c3a9f5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockCache.js\":\"2f75713e584f1e17\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockId.js\":\"be1468cf99553216\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockLiveness.js\":\"8a1294fca05fb03f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockMerge.js\":\"2dc2178d4df72d20\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockSchema.js\":\"6f8069ab48d74044\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypeLookup.js\":\"eeb4cea97ae63516\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypes.js\":\"a4ea7751f59ebc51\",\"/knowledge-medium/pr-preview/pr-1844/src/data/clientContext.js\":\"486fab64bc2bfa2a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/dbFileSiblings.js\":\"1d953ee1af97597a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/definitionSeeds.js\":\"bed23a6a69ca4829\",\"/knowledge-medium/pr-preview/pr-1844/src/data/derivedIds.js\":\"6241a48af3383b9d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/drawnSubtree.js\":\"d9b0abd4d651b27f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facetBridge.js\":\"4478aa1272f6357c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facets.js\":\"b55596d760c7c86c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/globalState.js\":\"3580e5594752c81e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/aliasClaimRederiveProcessor.js\":\"856a880d773c1f0a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/ancestorBatch.js\":\"4930ebd61de253b1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/blockTypeTypeifyProcessor.js\":\"a2f18f735d5686b8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/clientSchema.js\":\"90fd4af057b87068\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/commitPipeline.js\":\"e3cc0f8a8ea9323d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/devAssertions.js\":\"ee101fcc6bf392c3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/firstSync.js\":\"302e47c0292894a3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/freshInitialLoad.js\":\"9fb86c973e85eac1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/graphBackfillClaim.js\":\"df8eb8e0a9e76b5f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/handleStore.js\":\"c2bea7027eedfe33\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/idleMarkerJobs.js\":\"953ab15439ae4085\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initialDownload.js\":\"586cdb2483ed2c0a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initializeClientDatabase.js\":\"22763b7eda41dd78\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/jsonCanonical.js\":\"cbb43ef0ed9e0521\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelInvalidation.js\":\"49b1fd8f886cbd2e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelProcessors.js\":\"797b7ee40b629158\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelQueries.js\":\"3f47adaecdb5020a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/mergeTypeMembershipProcessor.js\":\"87b9478d3b046529\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/normalizeReferencesProcessor.js\":\"032781f32e26d059\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/poolInstrumentation.js\":\"c37eb84421dca841\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/processorRunner.js\":\"7e4e233407de4ab0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyCellBackfill.js\":\"3622ed9a4ef783a3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildMint.js\":\"9aa405bf17f39f7d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildrenProcessor.js\":\"29d51be7f7fd08a6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4174829a8a0a5611\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionSynthesis.js\":\"07eba128cbc61408\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyKeyScan.js\":\"5097efd05cc577e6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertySchemaResolution.js\":\"c65abc5e2c8dbe5b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyValueEdits.js\":\"e2da63831723ccbe\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/raiseProtocol.js\":\"9ea181af812b96f8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/readBatch.js\":\"df975e7ebc22a136\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/refProjection.js\":\"657c9087c96f34be\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetLookups.js\":\"21248b5821d4cb11\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetProcessor.js\":\"826d2dbe881e3821\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/replayMerge.js\":\"5189b688d967a85c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/sqlBinds.js\":\"51b1d736204ef3ff\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"78b809c637746239\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/arrivalProcessors.js\":\"0b0d25d3c2a091ed\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/invalidate.js\":\"0365977747d8a104\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/materialize.js\":\"ae989ec59ee2377e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/observer.js\":\"159a26fed1acfe4d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/reconcile.js\":\"64ef757d0407b155\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/timingMetrics.js\":\"8bfb7cbea2e9dcae\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/treeQueries.js\":\"844a1ef194d67645\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txEngine.js\":\"2a15e76ec3216c98\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txSnapshots.js\":\"4a757e7bc1560ffc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/typedBlockQuery.js\":\"7fa142bb7ec03d8d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/undoManager.js\":\"8c27ed70f76b91c5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/invalidation.js\":\"c43cce879b47f326\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelDataExtension.js\":\"c0080d96f9082513\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelPage.js\":\"b6d99ca1fa318225\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelValuePresetCores.js\":\"04faed6ab113e016\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbCorruptionSignal.js\":\"9059412a8d8bdc30\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbStorage.js\":\"b863ffcabd6ad6e5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbVfs.js\":\"a3af98901a4cb958\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localSchema.js\":\"dd26e079a5a3aaa0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/maintenance.js\":\"e575e2efbe8018d7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mergeProperties.js\":\"5d4dca5fc4d146a5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/metricsConsoleHook.js\":\"71d5312b62601b38\",\"/knowledge-medium/pr-preview/pr-1844/src/data/migrationsPage.js\":\"16193d8ab901f9cb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mutators.js\":\"57a498114fab5fde\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKey.js\":\"ab0744004255b096\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKeyPlacement.js\":\"4165b4975d395f6f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/outlineSurface.js\":\"a90fb93ea9276d86\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingEditorContent.js\":\"37f6966997b5c79d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingUploadsSql.js\":\"680024053d2167ca\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pluginStateExtensions.js\":\"548402f520075f69\",\"/knowledge-medium/pr-preview/pr-1844/src/data/powerSyncLogger.js\":\"803f02b5ac6d4335\",\"/knowledge-medium/pr-preview/pr-1844/src/data/projectorRuntime.js\":\"86efda25bd43a3b6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/properties.js\":\"ed1d049e6460e506\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertiesPage.js\":\"786b4560c91b7f90\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyChildren.js\":\"e5ae1b06e2ff423d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionFanout.js\":\"55bea36a8a381ec3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionMetadata.js\":\"e729ed41f7838fc7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionRegistry.js\":\"07c663b082c5c683\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDisplayMode.js\":\"83f7730fd0586f7a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyRowCreation.js\":\"2cad5a63276d69e0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySchemaCreation.js\":\"14656d236dd13a91\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySeeds.js\":\"44e11f0f3e30de0b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/recentsPage.js\":\"483f319007f8879c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/referenceBlock.js\":\"070668f4a304151e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rejectedUploads.js\":\"66df12d107bef395\",\"/knowledge-medium/pr-preview/pr-1844/src/data/releasePowerSyncConnection.js\":\"a58ab725eb4ae93f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repo.js\":\"36581cf8101cf095\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repoProvider.js\":\"1f1150ef4be8aa7e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rowProperty.js\":\"ac49c39466a2aa93\",\"/knowledge-medium/pr-preview/pr-1844/src/data/searchFilter.js\":\"7286e15c2c5f9b3f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/seedIdentityLedger.js\":\"82c2cf36fffae856\",\"/knowledge-medium/pr-preview/pr-1844/src/data/stateBlocks.js\":\"85d8e72ed7867825\",\"/knowledge-medium/pr-preview/pr-1844/src/data/structuralEditPolicy.js\":\"b5d81f38b53b7e7d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/subtreeDelete.js\":\"37b22c023dabdec2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncStreamLock.js\":\"b3bdb4fa8194097e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableSqlRecognizer.js\":\"3be0c253084170dc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableWriteGuard.js\":\"52777ff0cc0665bc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/targets.js\":\"eba1215d8a6f65ae\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeColors.js\":\"f37996a0b02ae973\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionMetadata.js\":\"fcadfb1df8c83b18\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionRegistry.js\":\"501d17df10d5c331\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeExtraction.js\":\"356e551fe60d651e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeInitialValues.js\":\"be19d474ffc67ff6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typePropertyGroups.js\":\"beef51e8dd8662e5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeSeeds.js\":\"5f7ffd9e313b6446\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeTagger.js\":\"786b97201947cf58\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typedRecords.js\":\"96154fac06dd18b6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typesPage.js\":\"5640a09ae60d6667\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userPrefs.js\":\"10d709d5456c994a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userSchemasService.js\":\"70e6da5c07a9c480\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userTypesService.js\":\"bcb116cbc282036a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/valuePresetRegistry.js\":\"2ec2f63fb0e650e2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/visibleChildren.js\":\"f6d22b5e2af324bf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceConversion.js\":\"bf8b8977f5e3b254\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceFirstSync.js\":\"0b2ef0efb15a91dd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceIdNamespace.js\":\"66b400efcc11e29c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceSchema.js\":\"8d21c483192f27bd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaces.js\":\"33b52c04c61a1a7d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadLog.js\":\"aa052abcfdad02c7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/BlockPasteShellDecorator.js\":\"1ca3cb469619a98b\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/atTrigger.js\":\"65f84bb4f80e2cb2\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/autocomplete.js\":\"9d48b11d99e89729\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/codeMirrorExtensions.js\":\"4d8d9ea8f25cbe17\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/contentFlush.js\":\"7b7e86d7910feea6\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/defaultInteractions.js\":\"d9d6b5d8716106cd\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/editSettleSignal.js\":\"2a2436bc9366780e\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/editorOccurrences.js\":\"b6f2c99144ac9d26\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/insertImage.js\":\"054ffc97294a6ad9\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceCompletionRange.js\":\"042180448f01f6f2\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceTargetTypes.js\":\"d73498e60a2184f1\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/syntaxContext.js\":\"276fd0f70afc88ad\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/triggerMatch.js\":\"6696a44014e1da86\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/AppRuntimeProvider.js\":\"6fb7a551d0a8a1d5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/BlockFocusShellDecorator.js\":\"75082ce30299fdb4\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/ExtensionRenderBoundary.js\":\"8d2d2d21077958a9\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/PanelContentRecovery.js\":\"64dd6c2c3e2a73c9\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/apiCatalog.js\":\"87268ad28e46f1bf\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/approveExtensionHere.js\":\"d1dce2c211f8ad38\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/armedCutAppMount.js\":\"cd6e8eda9801fbdb\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/batchableKeyedStore.js\":\"79f792adad043c74\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockInteraction.js\":\"75c8d6c572927aa8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockSelectionAction.js\":\"b4d548ffce20c2c5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compileExtensionModule.js\":\"a5e522773cdf80b9\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compiledModuleCache.js\":\"060e93d3523f7ce5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/continuousGestures.js\":\"6945f8424d42b4e8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/core.js\":\"fe75d5d11ad4d5b5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/defaultRenderers.js\":\"b78f349ca659e309\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/definitionFanoutAppMount.js\":\"ae95a579a3d39cd3\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dialogAppMount.js\":\"75764d7fa9e4e5d0\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensionSeeds.js\":\"38d7e3982c2ec307\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensions.js\":\"23bc2d1b5fa9925e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/exampleExtensions.js\":\"ae8dc9275d86e714\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionApprovalStatus.js\":\"9e17018c42ace4a6\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrorToast.js\":\"123de56e36f969f7\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrors.js\":\"cca88883388120c1\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLookup.js\":\"f60fdc23104dd450\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionToggles.js\":\"ece26928711676a0\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionUtilitiesCss.js\":\"bcdae9a7803b9e9d\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/kernelPageDeletionGuard.js\":\"a5c8cb9dfc971cc5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/liveRuntime.js\":\"7ac844a7c9e70450\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/openExtensionsSettings.js\":\"12168a7890e64b82\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/overridesCache.js\":\"a24f645ce9a45056\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/pluginIds.js\":\"49b785d82c422561\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/processorRejectionToast.js\":\"a63962c6a5727b2f\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeActions.js\":\"257739d877346704\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeContext.js\":\"9be9f7b2d35dd9dd\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticAppExtensions.js\":\"c5b86c1aa576616d\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticDataExtensions.js\":\"996c5d31b9f4b120\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/toastAppMount.js\":\"4c24f5b264cbce44\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useOverrides.js\":\"9c2725cd03a82ce5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useShortcutSurfaceActivations.js\":\"f73bb088a4b1adce\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/discoverToggleTree.js\":\"3e6ada2697ffcc6b\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/facet.js\":\"d105117dced6403e\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/resolveAppRuntime.js\":\"dc064c60949fe08d\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/runtimeEvents.js\":\"674bf825aeaf57a1\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/togglable.js\":\"77ae740fee4622f3\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/variantFacet.js\":\"2a4b9ced820b6b63\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/verbFacet.js\":\"c13e0716f813adc9\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/block.js\":\"731eff7c042a07c8\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/focusedChild.js\":\"1cc959fbbfc2206e\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/propertySchemas.js\":\"8f5c7be4c4db2e31\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/typeRegistry.js\":\"8681f8d854871e20\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAncestorCrumbs.js\":\"9d2074c824ff167c\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAutocompleteListbox.js\":\"a174f4f3b6601324\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedSearch.js\":\"a878f99ed8301e81\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedValue.js\":\"59c28780e55067bd\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsFocalRender.js\":\"db4a1482ba2ae2a0\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsReadOnly.js\":\"9310a4b1ca003682\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMaterializeBacklog.js\":\"c2f546a815917d57\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMinuteClock.js\":\"c4434c88c473765d\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePanelLayoutProjection.js\":\"1b3ffe9fe3281f9c\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePendingInvitations.js\":\"05232dd44cef0070\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRendererRegistry.js\":\"cff663b01bdd34ae\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRetainedFieldRows.js\":\"1bf4b62c2bb6a894\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useWorkspaces.js\":\"d0652525c41b5351\",\"/knowledge-medium/pr-preview/pr-1844/src/lib/utils.js\":\"15c2378bb7ea6833\",\"/knowledge-medium/pr-preview/pr-1844/src/main.js\":\"469562eaf3748dc0\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/MarkdownImage.js\":\"348f2e78e4b1daf6\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/blockSeparators.js\":\"423566ccc35b62f8\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/context.js\":\"88716d898aac3d40\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/defaultMarkdownExtension.js\":\"3fa141a8f24ca36f\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/extensions.js\":\"118ca4119421e7bc\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/renderMarkdownHtml.js\":\"5f7b637743fe461e\",\"/knowledge-medium/pr-preview/pr-1844/src/minimal-editor.js\":\"e252b18191ac15b5\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/armedCut.js\":\"0d0bf0f143f21f64\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/captureMediaVerb.js\":\"14a072fc6781cb1e\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/clipboard.js\":\"c9c04c2a733d190e\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/decision.js\":\"e5377ebac32e55b0\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/operations.js\":\"4b6aa74abc2fc35c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/AccountHeaderItem.js\":\"88d91d4bf480eb75\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/index.js\":\"403fe84a3bbc4e0d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7e1047d699af75d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askAgent.js\":\"adb9bfd7b3ec624e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askedStore.js\":\"51cef776d2a7f5e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"813a07f7f2fd71eb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/chipState.js\":\"86bddcb25227edc2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3292dae142f1ffe1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/index.js\":\"ceaf87d2cedab9b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"dab622717272e4e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/schema.js\":\"f25d92e895cf4070\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/AgentTokensDialog.js\":\"cdd5c682a6887133\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/BridgePairingDialog.js\":\"01e799d1d6008888\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/addMedia.js\":\"2902f248265e9d94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b1d84b89b2c57609\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/block.js\":\"215f360432aef401\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/context.js\":\"64d65e15a72e2d15\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a102a9f3b30fb567\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/index.js\":\"19796a73af1d532c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/outline.js\":\"d15383cb35a667a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/properties.js\":\"b67fd25c42191bf8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/refs.js\":\"c1cb5544678ac65c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2d16674bc67d3cad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/search.js\":\"61f3f6d025b02830\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/shared.js\":\"01f59eab88d8aaba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4c4763e4ee23b5e5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/text.js\":\"6de526113113acc3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentWrites.js\":\"31fd3142a6540db4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/authoringCatalog.js\":\"cb1b450cf7768940\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/blockRefTargets.js\":\"ecddf29326682ef6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridge.js\":\"51df8a726bdfce39\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridgeLoop.js\":\"44bd6e32da6baa0b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/changeHistory.js\":\"f6d5cec7e46d83d3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commands.js\":\"e3d6e8896a32df04\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commentsCommands.js\":\"c9305e324f1b752d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataExtension.js\":\"48508127f9fa8319\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataModelGuide.js\":\"33a93364c300ab94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/describeRuntime.js\":\"5f3050117cf3e406\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/extensionLint.js\":\"7b309e6d5927cbc9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/grainAudit.js\":\"f72bd1fbd264e9d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/healthCommand.js\":\"da43d60ab2a8d9fd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/index.js\":\"fdfe351538d6bba6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/presetIdentity.js\":\"e6b39dec9afc60e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"58c5a98878a0aeb2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/readMedia.js\":\"d25029db958de771\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/schema.js\":\"9563e926590d87ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/serialization.js\":\"dd6d1a696bf0283f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/targets.js\":\"741cd9edad95dd41\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/tokens.js\":\"87ce2f9e0de1a1c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/watchEvents.js\":\"670a3ba67f0de3b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/workspaceGuard.js\":\"9a7f663962e4e658\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/writeCommands.js\":\"a2f9da523d0497cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/AliasCollisionToast.js\":\"26bc185a4fc8d6f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/DuplicateNameBanner.js\":\"7cc5dfc5754f963c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/collisionMerge.js\":\"49c4d4c361fe9732\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/dataExtension.js\":\"81250e6a49a495a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/index.js\":\"3aea7eb4c4876e55\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/mergeCollisionAction.js\":\"483f1e36d1e859e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/pageStyling.js\":\"b16ffb94ab166dda\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/rejectionToast.js\":\"b2568ec9dca16ea0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/syncProcessor.js\":\"48a48bd5284eeafb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/actions.js\":\"8cb29d9d03bb764d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/addComment.js\":\"2493aaca6073b0cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchor.js\":\"278b41e029a1f4a7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchorState.js\":\"6272bcb2a923b04d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/commentLinks.js\":\"c65853fa58f846ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/confirmThreadDeletion.js\":\"98dd35e5392a951e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/container.js\":\"a658010f7454bf80\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/dataExtension.js\":\"c21df9a9ef40ae51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/deleteComment.js\":\"9a33fd6de5686f7e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/highlights.js\":\"1629c192b9c88efc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/index.js\":\"a32d6da24cdd3756\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/linkedCommentsPill.js\":\"27739dea0d019d96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/margin.js\":\"f2614704151d0498\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/marginSchema.js\":\"d383075d7f84dd1c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/newComment.js\":\"fc43066435bfa56a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ownThreadPicker.js\":\"3981d3f67a021643\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/placement.js\":\"74369e1341ee13dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/queries.js\":\"57f5e385fd691d00\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotePosition.js\":\"25829f7e6fbe6c7b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedIn.js\":\"7d5a2f2d59167535\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedRange.js\":\"0e58ca23661e041f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/rangeRefs.js\":\"11a96c5139680c33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readHighlights.js\":\"d451a01cafb1aa42\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelection.js\":\"8c96eff7703db5b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelectionUi.js\":\"03dc97c90719e4cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/reanchor.js\":\"40f379ad197128a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/schema.js\":\"00a4eac3d9786fe4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scope.js\":\"65d7eb12e11c4e2d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scopeThreads.js\":\"501cac33baec49c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/splitRetarget.js\":\"b2b5b7ea8a9a37a6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestionCard.js\":\"0af07e0253c5009f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestions.js\":\"dc5798b2bde0d156\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaries.js\":\"0b5fbe32c726f67a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaryBatch.js\":\"d289f75acac09c58\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/surface.js\":\"000f9b4f075ef87a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threadNavigation.js\":\"028e9eb86f3450e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threads.js\":\"146eaa937827beb6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ui.js\":\"db88c6d2fc81e8fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/uiStore.js\":\"06713d8db7f60d49\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/appIntents.js\":\"adc89cf10356af31\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/index.js\":\"8ef8e80a183d1fa1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/index.js\":\"d3acf4578b1c7b30\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/status.js\":\"4bd279117b48162d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3ab51c8536b292d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaBlockRenderer.js\":\"6565876ffdef6c4f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaDownLaneReplicator.js\":\"997ac3cd73d345ed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaUploadReconciler.js\":\"98e61b6c8804a71c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetDownLane.js\":\"26a71502cc7d6da3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetResolver.js\":\"3db336a5fb810723\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetUpload.js\":\"57a3ce54d89cb44c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/attachmentCleanerIO.js\":\"fea001697ee07ee1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/supabaseAuditIO.js\":\"9ed098288f6bcc4f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/blobStore.js\":\"b9886e750480a149\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/byteStore.js\":\"c64fad6d6e635a5b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanerIO.js\":\"ddcc4109287acfdf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanupAttachments.js\":\"b2e4986d9d38f0e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/dataExtension.js\":\"528e6b407537a4a7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/downLane.js\":\"3a96585279668e11\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/index.js\":\"01f6b2d0de35f5ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/insertImageContribution.js\":\"b9e905fcbae4d672\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneArming.js\":\"92585875b83a5787\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneLock.js\":\"7748b13d4bbe9331\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaBlock.js\":\"342cb5783afe5762\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaCapture.js\":\"8fc96fb7ea689162\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewers.js\":\"80c6ae1d2bd12e2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewersFacet.js\":\"7aada2229978604c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/pasteCapture.js\":\"780d5b4b3e039655\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/resolver.js\":\"37636115730a887a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/retryUploadsAction.js\":\"5858e091e30431e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/storagePaths.js\":\"6e6a486cbc4991ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadDrain.js\":\"26553ae69d29cdfb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadLaneStatus.js\":\"4508fd1210ab2d8c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadReconcile.js\":\"de7cde28dd093df1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadRecovery.js\":\"e4f4d963c425a421\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadStore.js\":\"de8ec356dbe4eab0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/useAssetObjectUrl.js\":\"021c70fb081aefd2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"00c1a3f3838abd11\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksViewSection.js\":\"aec5e9409899e14a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/facet.js\":\"0c7d950cfa72e11d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/index.js\":\"e0127e56748f097d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/prop.js\":\"1b9688ee78ab15d6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinkFilters.js\":\"bffbb126ae9f99af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"26e5a12b16b2555d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BlockEntry.js\":\"6e703eb77320a2b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/LinkedReferences.js\":\"4782b01747cef37b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"60bad41f2946c5f2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dailyNoteDefaults.js\":\"afef7dac66a7de11\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dataExtension.js\":\"ed722685a6108117\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/edgeExclusions.js\":\"ee1b18af76373023\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/filterProperty.js\":\"8c43ccf387862eac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/index.js\":\"2b1b2136c00b1131\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f4e0f3711268fe3f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/applies.js\":\"b7c5433acdf74121\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/countQuery.js\":\"8c3dc9f8e888ef46\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d08c0bf0f1601aea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/index.js\":\"870bfba34989c6c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"94e8772b95b67538\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/presentationInvalidation.js\":\"c8cdd85ca90d15f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyEditorOverride.js\":\"f472ca0638c85e4a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyFilter.js\":\"4d618a414b7626c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/query.js\":\"4270268b713abde3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/resolveFilter.js\":\"667c31209fb75a79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sourceBatch.js\":\"92ab80f45ec78c8d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sources.js\":\"783cd96122105326\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useBacklinks.js\":\"a831b7e658aecbfb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"016b4a9dbcb72df9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayCelebration.js\":\"c7b860a17a36a04d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayOverlay.js\":\"35060acec807aee2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/gate.js\":\"c3a966aea8c11831\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/index.js\":\"57702705ae646197\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/wolfTheme.js\":\"af90be3054354932\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/BlockDragLayer.js\":\"5a598caaa081169b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dragController.js\":\"c96024031bd47b79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dropTarget.js\":\"438f3a130d7a9a9d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/index.js\":\"a8ef66db47718b4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/projection.js\":\"e1cae7511c243d5b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/BlockMetaCard.js\":\"7d83a090a69129a6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/index.js\":\"b229ebe3a6a01c4e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/AddTagDialog.js\":\"6282d8203edbe123\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0640a5273931cba4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/TagNameIssueHint.js\":\"3f232ccd23aabec4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/addTagAction.js\":\"d147448b891e6993\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/appendTag.js\":\"7afe8eda61ebd560\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/config.js\":\"3fa2725803dca3f6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/dataExtension.js\":\"7f1419b57bf04dee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/index.js\":\"7f174db6735e5297\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/propertyEditorOverride.js\":\"1cbd80041f4afbf4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a3b195965ba21d2d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"40018f0b3c627449\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c8094535fe925a8d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"eaf752faabafce39\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ab9fab6952105278\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/index.js\":\"5ab405c80cb95254\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5d2adceff095c28a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/CharacterCountItem.js\":\"2dac3249ecbec438\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/ProfilePropertyEditor.js\":\"bceff05f6f78b00e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/actions.js\":\"717c7fb6de132b23\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/blockType.js\":\"4411758ec49ae92a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/charCount.js\":\"4674e2d3b06da15c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/dataExtension.js\":\"ff3d0c35dff23318\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/index.js\":\"fbdad230545a8243\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/profiles.js\":\"7e7a6c4c167550dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/properties.js\":\"35f399d6eca5de4f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/textCounts.js\":\"552ec556d1445461\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/colemak-keybindings/index.js\":\"f5d4a681ec0d45eb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/CommandPalette.js\":\"0552b06f6e0cd688\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/HeaderItem.js\":\"30a6977b29936790\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/context.js\":\"b0f0164bbf29ff3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/index.js\":\"127c8805c4081c3c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/selection.js\":\"df2ad77b2dc41782\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/toggleStore.js\":\"40a3dfcc793751fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/useCommandPaletteActions.js\":\"c056c7af163400aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/ContributorBadges.js\":\"be7af92cc6993513\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/author.js\":\"ec33b7b665dd05cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/codeMirrorExtensions.js\":\"b9da35f58f3a3c83\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/dataExtension.js\":\"47072777aa06f932\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/index.js\":\"8eccbf2271ab8419\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/mentionAutocomplete.js\":\"b2b2665211f595d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/processor.js\":\"06be60ff80d98cc2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/profiles.js\":\"5b7c86a5edf20815\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/queries.js\":\"a0efb5c37e638451\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/schema.js\":\"3a72f7e47e7a771f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9f87418a8a6a91a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/followOrigin.js\":\"96a2f1988888ea62\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/index.js\":\"87e7ce667680b5ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"fc34f9f50e45da3c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"2b74ce302be50aa3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/CalendarGrid.js\":\"aeb7a7ddca43da9d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DailyNotePicker.js\":\"79f30f585940a77f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"312863257103ec97\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateNavDecorator.js\":\"5ba0d8ea9b19fd3e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateScrubOverlay.js\":\"8266f68aaf0af92a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/HeaderItem.js\":\"50afbe90fff05c7f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/ReschedulePicker.js\":\"17fbf12711b0ca8f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cfa46d72870e0ad0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/actions.js\":\"1cc9b4a6137fd5a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/blockDateAdapter.js\":\"f7524d45d2174835\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/calendar.js\":\"a9d86c65c22faf12\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dailyNotes.js\":\"73a914547aff6093\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dataExtension.js\":\"5df60736c7662883\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubActions.js\":\"fb3c1bb16eda29d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGesture.js\":\"b6baa7991ebc74ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6423ca702ac8a8e6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c2da667c753b0bd8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/deletionGuard.js\":\"a17a448d15b3aae5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dueQuery.js\":\"f091b242786c6c9c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/index.js\":\"298185f1fd0a5297\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/landing.js\":\"fcb359d230d3ebc7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/localSchema.js\":\"d9e21821b2f943c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/referenceDateAdapter.js\":\"e7fc19853e34d558\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/rescheduleAction.js\":\"a935b786e08ff564\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/schema.js\":\"3b9aedeb2137df25\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadBlockDates.js\":\"263f5d2084a0d123\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadDatesAction.js\":\"08a2fe08df198259\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/today.js\":\"566aae58243c28d3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ea30abd592ee2ce1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"95aab382138e5044\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/audit.js\":\"44773c1ca2064301\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditAction.js\":\"70c13c58aa9a8745\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditRanges.js\":\"354ad6d5fdc95957\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/diagnosticsSource.js\":\"83146db2b62acbef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/divergenceScan.js\":\"6d7c7b2622fa8f8e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/index.js\":\"dc4dde6913831334\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/propertyChildrenChecks.js\":\"683aa6f414b819b3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/referencesMirror.js\":\"af8ef56677734af8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/rowJson.js\":\"e2f1d10e19c4d532\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/schedule.js\":\"03659c5ccbce3a2d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/store.js\":\"87ca51c89c33392c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/action.js\":\"7805887f6cf51d7e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/index.js\":\"0b6efb2815951856\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/plugin.js\":\"4b525372894f272e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5e06539cf95adad8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/actions.js\":\"c5e58a776b770d1c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/changeMarker.js\":\"eaad971c2e90b06f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/diagnostics.js\":\"37611b4d3398d4f2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/fileSystemAccess.js\":\"93b8696c301e5b86\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/filenames.js\":\"264882d04d6467a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/index.js\":\"bfca3683f1184f6e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/mirror.js\":\"d89fc7c2c5ba8cd0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runLock.js\":\"ac30cf3d617a6841\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runtimeHealth.js\":\"d172fcde3c4a5052\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/schedule.js\":\"3a3500e8f6f25769\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/store.js\":\"bb7563d664741403\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/index.js\":\"1c283f310afa5cf3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/themes.js\":\"87b92c8534370e1a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/facet.js\":\"5f9c1c7b4f3adde5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/useDiagnostics.js\":\"9be6ff6a39d37d2c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/dismissals.js\":\"05af0d8deedc16ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/index.js\":\"a0fbe22f180c7427\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/status.js\":\"a8b032b67fe318bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/store.js\":\"0ea4dbcc6f54de96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a1ed824ee345d155\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsSettings.js\":\"927a3523c2ceedcd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/actions.js\":\"75180e83de1ca7ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/config.js\":\"ae5c544cd927572e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/dataExtension.js\":\"e6f456bd9b57d3bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/effect.js\":\"7c173cae49954c6a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/index.js\":\"7cb5dd1ef8b43daa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3b22e1bfc9abe2cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/useToggleTree.js\":\"64a9c14f82596635\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/ExtractTypeDialog.js\":\"fceba7465019737f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"305f08a350a5da42\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/PropertyShapePicker.js\":\"447338804959eb22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/action.js\":\"c7e3be14f2acfde1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/index.js\":\"5f6f2ecffd87a6c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/FindReplaceDialog.js\":\"43f1c4ed833e58d3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/HeaderItem.js\":\"fa7562cfe3dbe6c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/dataExtension.js\":\"23953061e8f6f8fd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/index.js\":\"4494f4588332f5fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/search.js\":\"90935d6f4fe687a2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/toggleStore.js\":\"8c04d62557c5a1e5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/LocationPropertyEditor.js\":\"d1634d7116c1ef0f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/MapView.js\":\"a7b071084587e4c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/blockTypes.js\":\"b1599c8f6370299a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/codeMirrorExtensions.js\":\"0191a0101c5be774\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/createOrFindPlace.js\":\"a743ad2517b3b0a1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/currentLocation.js\":\"1650608504eb15c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/dataExtension.js\":\"a449ef0a3eef5b23\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/geoContentDecorator.js\":\"55fd1069bf7e4755\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/googlePlacesClient.js\":\"cb56a51ceff95ee2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/index.js\":\"7b55b6455befa70e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/locationsPage.js\":\"db6af9ea67858e35\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/mapViewport.js\":\"32edaf67724509d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/pickCurrentLocation.js\":\"90e21c0f1e226ccd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeAutocomplete.js\":\"544ba34a5a247eb1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeNameCollision.js\":\"0457523ae82acbce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/properties.js\":\"7ad734e1b526ae90\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/propertyEditorOverrides.js\":\"f24f4b64d2a3c6e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/query.js\":\"cce0846c667d6bb5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/usePlaceSearch.js\":\"61380ec65aca0501\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a786ce5b5f1e3b4e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1b897fe45b719be2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"21974f84beb1b261\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/config.js\":\"ee7096a8027fb882\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/dataExtension.js\":\"f9b05e5ba5ee6641\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/facet.js\":\"164308f94cf98b23\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/grouping.js\":\"f213276a0d27dc48\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/index.js\":\"43b26c06652cf17a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"409dc0e713ba240f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/query.js\":\"da3c8f11c3c255b5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/resolveConfig.js\":\"c6eb2ca550768fb0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ae15335bd7f5ea77\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1236ed7e95046da3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlDocumentContent.js\":\"32d5240a61e21eef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlFrame.js\":\"5ef859b332e08930\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/actions.js\":\"7dc1e9bdb383fc90\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/blockType.js\":\"dfe735d39427a15f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/confirmRunScripts.js\":\"0ba210af08112bd6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/dataExtension.js\":\"f63a3577f079e33f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameAnnotations.js\":\"ece41df7cb5d9433\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameDocument.js\":\"610e32e9145d7bc2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameTheme.js\":\"7193dca2d18755cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/index.js\":\"45df699b3f8b2e4b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/scriptConsent.js\":\"f772b20abb8254de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/sourceMap.js\":\"a9f79875e706c9a7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/useDocumentScripts.js\":\"a532e08ad46141f7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/index.js\":\"40b0996ac8daa72e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/record.js\":\"0aa55ffd640816bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/recordStore.js\":\"d4c137a6e521d533\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/responsiveness.js\":\"951f1306ecdc038c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/schedule.js\":\"3447179aeec75791\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/sessionContext.js\":\"f8979de282373f06\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c21d24fe1b5ebf8e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d1630717789514fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/actions.js\":\"6fe06e77e8a16f23\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/config.js\":\"1d0f1a0dc5a7bbda\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/dataExtension.js\":\"dd776a983f6c49e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/effect.js\":\"83c846d40b1cb47e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/index.js\":\"b6034dfaf3a8ea98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/keyCapture.js\":\"76d7bc24fcfe9378\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/overrideStore.js\":\"8c548fba4c6c6c46\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bf3b079ae53c0d94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/HeaderItem.js\":\"0f315dbec1789574\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/LeftSidebar.js\":\"5ad136bae36b9c38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/actions.js\":\"1f7d5f06d3828048\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/facet.js\":\"fb684df5d0b9988e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/index.js\":\"4e39a4d3c593171b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/shortcuts.js\":\"9e04d02d0df71250\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/toggleStore.js\":\"8e748508764e12a1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/MergePicker.js\":\"640e1ef6efaa0c9c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/index.js\":\"0734c83b8ebb5653\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/mergeAction.js\":\"c4bbd62725c10c73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/strategy.js\":\"eab2689363062bf6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/Button.js\":\"8192d0c7c7c4e719\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1a5dc6f9450bf8d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f2cddf220ecc83aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/facet.js\":\"9156019d9f246920\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/index.js\":\"d120b12186c8fd78\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"28f824d4103c7a3e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d5317484333046b4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"939b50ea24624a89\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/facet.js\":\"67bf0a71fe405640\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/index.js\":\"917eb4c43992f17b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ff492943434e2ec2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fe43b55a957d359c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/contextMenuItem.js\":\"12bff05bc07c1590\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/index.js\":\"14aed4a41f2a55b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveAction.js\":\"83be904682174e98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveBlocks.js\":\"42838fe9afca9e14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/selectionAfterMove.js\":\"c84b24f206a21741\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/TutorialBanner.js\":\"505425955d3ab0fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/action.js\":\"8c90fa02636c3c64\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/bannerDismissal.js\":\"dd1c21c39f3e6b80\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/documents/cheatSheet.js\":\"7dccbbac9ab21886\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/index.js\":\"93ec90714f5b421e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/keys.js\":\"f6177c2869966788\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/landing.js\":\"ea3dc8f6a8061f7a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/outline.js\":\"273ca875c3369b13\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/seed.js\":\"eba62952cb5d9125\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/PerfTrendDialog.js\":\"9ae7d54d2b6da1fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/analyze.js\":\"4497813eabd6f4af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/diagnosticsSource.js\":\"844af2de6401c23d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/index.js\":\"ce63411df399572d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/load.js\":\"881722b67fd6a748\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/monitorRun.js\":\"d856c282c3d31ea5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/schedule.js\":\"cbf942089bf00e33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/series.js\":\"ff44c292966e27e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/store.js\":\"dfdc6ea7511624b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/trendAction.js\":\"c18e17d644a0de07\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/verdict.js\":\"74b5b9ebf3a99e93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/clickToEditAction.js\":\"e1483965c823f9af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/index.js\":\"0ff8ab6688c163fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/interactions.js\":\"99f74cadcead6012\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2fc6e2dce041e8ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGate.js\":\"10c8b92bb7367ae4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGateDialog.js\":\"c6e549a83968c177\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/action.js\":\"dae885db52a3e365\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/index.js\":\"3be5f0210080489c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/localRunMessage.js\":\"a243b36c1b730cf6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/plugin.js\":\"83ab8a1f5202a33d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/progressReport.js\":\"bb652bee68d188e3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/sweepProgress.js\":\"4e39598ac0556671\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/FieldRowRenderer.js\":\"00fee4912e949916\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/ValueRowRenderer.js\":\"3322df29682781c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/actions.js\":\"476bab4e77068cc3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/autocomplete.js\":\"9e2ea2346d29a53e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/fieldRow.js\":\"c905c8b1af378dd2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/index.js\":\"313133aea8fcb7d3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/referenceWarning.js\":\"73412f55ae8e981f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueAutocomplete.js\":\"a9e62877a0adbf62\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueSchema.js\":\"0366ae74ece3aa7c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/HeaderItem.js\":\"c74d1f9216cb3fb0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/QuickFind.js\":\"4298b90008f11ddd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/index.js\":\"0f72d29641357bfb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/recents.js\":\"10c2ed77ccb2f877\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/resultItems.js\":\"ac161557782a1afd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/selection.js\":\"59d4c3cb425c5671\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/toggleStore.js\":\"bc8ef464709f5bf5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/HeaderItem.js\":\"64e7c4899acf77b4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ca5b22237999416a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/grouping.js\":\"d15466ee24036e88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/index.js\":\"a03ce6a3bc4d0367\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/target.js\":\"af37eab25a00e883\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/codeMirrorExtensions.js\":\"f36785fd881c8d39\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/contentPrefill.js\":\"400ab79a4547b57d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/dataExtension.js\":\"7a95f4831c3dfbab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/index.js\":\"a3aa402402e6fc0d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c4b33090f5c340b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/invalidation.js\":\"f6efaf16564d7cc6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/localSchema.js\":\"a89f1c62f6e2bc19\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/index.js\":\"93c0aa5dc838c31b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ed3ec02acc4266be\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/index.js\":\"1cf289c6b83d0758\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/referenceNode.js\":\"98efde8bd3fd1247\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ce1adc9b6cc203fd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"78f7822c47f2358f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/index.js\":\"7313a252676102cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c5ba6532f9c4b1c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"422410a2acf304f6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/mergeRetargetProcessor.js\":\"064a2f55103f98cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/parseFence.js\":\"beea4cc9f96be51d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceParser.js\":\"71aca75da5a6175f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceProjection.js\":\"bf16d2fb77fe8f15\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referencesProcessor.js\":\"53b9b58e0a8e1302\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/renameProcessor.js\":\"46934b2dccf39d01\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/spanReplacement.js\":\"2ea751104d505968\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/htmlToOutline.js\":\"e7cab251398a045c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/index.js\":\"c174ff1bf6fd03e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6d4a796901ae2c07\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/pasteDecision.js\":\"5f4f75a19b6f421e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/action.js\":\"b5c1df04c1160c7d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/blockIds.js\":\"483ae020c4fd9951\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/content.js\":\"dd8382e26b0a4117\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/effect.js\":\"b37809e69749c382\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/ids.js\":\"be79df0daee00217\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/import.js\":\"e0eef6e531d6b737\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/index.js\":\"f91c5f2fc124f200\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plan.js\":\"73e82ee79b5b9262\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plugin.js\":\"db29eb26f1d19e50\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/promotion.js\":\"cb66e2ca3e5dbd51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/properties.js\":\"0d98ba3d34456ecb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/references.js\":\"e6be5793b2182cd0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/report.js\":\"44eacbb8cf0549c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/roamMemo.js\":\"7ed40f2ad6897434\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/runtime.js\":\"eeac0f1101431389\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/schemaReconciliation.js\":\"ca76dcfa605f7609\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/srsMarkers.js\":\"9fa74ab5f8280045\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/todo.js\":\"38fce49031f2fd45\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/typeCandidates.js\":\"5b67bc0262e5f2e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/types.js\":\"7f949e73390f86b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/index.js\":\"077a5ca1fee52889\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/store.js\":\"26e0d84b03babb0f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/HeaderItem.js\":\"ca28b1b6ffb59693\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"de09c37221a24a38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/index.js\":\"af6674c35db75d12\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/model.js\":\"09ba93a68038d213\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/toggleStore.js\":\"2d60d4afa2ef791b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/useKeyInspector.js\":\"21e2827cc60c2afe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8e6cd3ccc0cecd52\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/ShellDecorator.js\":\"dea0fb2c2da74ab8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/actions.js\":\"e70376b7603a838e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/exclusionsFacet.js\":\"657404debb1b280b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/index.js\":\"3ec29d3bf0554bd1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/shell.js\":\"f6aa6010db5024e7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/surface.js\":\"06743f25d7b717b5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/walker.js\":\"e16a5c798d078b91\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/RescheduleToast.js\":\"0d8c8122c5492d72\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/dataExtension.js\":\"14c802eb21a44d3d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/index.js\":\"e8ea2fb283b5e206\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/indicator.js\":\"2a69c7d62f20065a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/moveSrsState.js\":\"2ee8047aeeb070cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e0811ca1d1bae12b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/scheduler.js\":\"f3c5955d1db254e7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/schema.js\":\"27b13f75ddbefe1a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6eec4d2f42a9f2fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsClipboard.js\":\"cd873a26884c4a8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"62798d6354bd495a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a68cc09c6b2b82f3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DeckPicker.js\":\"bf109f5d74c3038c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewControls.js\":\"9af9314532262bf2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewDeckRenderer.js\":\"787cb704b8de90d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewSession.js\":\"6db2624b58386c39\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/actions.js\":\"f24ca0deaed3655c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/archive.js\":\"e166cccf17c84fe8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dataExtension.js\":\"92bc626bd146c5e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/deck.js\":\"9cc581591f758825\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dueQuery.js\":\"27cb95f0d7a0eb10\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/gradeDecision.js\":\"7c69e4f77d6ecda8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/index.js\":\"05a58e6410f01a91\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/keyHints.js\":\"94eb825c9084ec3c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewCardLayout.js\":\"062aaf7342786e75\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewProgress.js\":\"a2796a0c9cf45b04\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/schema.js\":\"1eda1a3b4f8b2700\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/useDueCards.js\":\"ecd19234bf386709\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/index.js\":\"3b2d332d44e1aa98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/record.js\":\"39a1bce068054cd9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/index.js\":\"fc90514d60b9727c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/persistenceStatus.js\":\"b0041bb5c26fba1d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/requestAction.js\":\"25ef0aed5fdee4f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/TypeChipsDecorator.js\":\"8249248a319a83ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/codeMirrorExtensions.js\":\"09e1408d333ad817\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/index.js\":\"ab8862c447faf5f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/typeAutocomplete.js\":\"58c40e5445434d2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"718b00d02046e3f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/actions.js\":\"948683801e1b885d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/anchor.js\":\"fd50bbdc54a508c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/events.js\":\"24e19153a06221c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/gestureActions.js\":\"58a3c31f4a7e6362\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/index.js\":\"a62c6db45a9f82bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"434a7aafcdff7b09\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/collect.js\":\"0dd7fe296eca18b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/index.js\":\"9c9d18ac91725a84\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/record.js\":\"5376449e18d692da\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/RejectionDialog.js\":\"aa13546f59f0843b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7c60b605e4d6ef22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/index.js\":\"44dc470c52495549\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/model.js\":\"e229f0f1382a54e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/queueCounts.js\":\"ca1fff18f5fe096f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rejectedHelpers.js\":\"a2969436ef8a5eac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rematerializeAction.js\":\"f6973f42ad4bed25\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/useHysteresis.js\":\"405bf74aaadf2b82\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/ColumnHeaders.js\":\"143fbbc55c09ccce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/QueryUi.js\":\"a878baa80f6839fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/TableLayout.js\":\"fc9fb1fa75088253\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/actions.js\":\"d36a410308299ee3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/cellEdits.js\":\"ecba02da0d57f71f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/columns.js\":\"67c28c8672cd08bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/controller.js\":\"e38f58f277b6fa3f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/convert.js\":\"c134bc3232208310\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/dataExtension.js\":\"b7416c9b8fa2229b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/index.js\":\"2a9a9d26d637064c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/keys.js\":\"9e57a879b7017eee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/model.js\":\"5fd07349f918ff7a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/backfill.js\":\"af07eea79ed00d83\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/format.js\":\"fa87062487fe9a93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/parse.js\":\"0e803358b3860c0b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/queryValue.js\":\"1431ecf1d7afd363\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/source.js\":\"d5ae57b984478e11\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/registry.js\":\"a7cf4ef83627a2fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/schema.js\":\"01f812eae618f62a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/sort.js\":\"1fa867fe574dc609\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/effect.js\":\"996fdd06fee06c5d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/index.js\":\"5346abf6984cbc7f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/theme.js\":\"3ec151fd53e9aea0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/actions.js\":\"eaba8b0533325b71\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/dataExtension.js\":\"8191322d622847a1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/index.js\":\"92a29e40e9639d48\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/schema.js\":\"8ded45f9aacd3e13\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/TouchSelectionLayer.js\":\"82cccb9d16552855\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/actions.js\":\"ccbf312af3051d90\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/defaultItems.js\":\"001985e4d54082c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/facet.js\":\"c0f7f1aeba6bc7fd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/holdRecognizer.js\":\"c93658c1ed5da5d6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/index.js\":\"02900fb5964bc161\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/UpdateIndicator.js\":\"ff157c79a013b1b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/index.js\":\"d0c1058fa9d68adf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/loadTimes.js\":\"4400096c5b3d6d5c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoNotesRenderer.js\":\"8875150301fb3646\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoPlayerRenderer.js\":\"9f2f98d5ae91ac5d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoTimeStamp.js\":\"36699e8db7b47682\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/actions.js\":\"38d2fa8e4e8d4764\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/index.js\":\"21a21b6f83e856a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/markdown.js\":\"90fe99da3156f6a6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/notes.js\":\"1800c57dbf15ce86\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/registry.js\":\"f0e5888de08787f7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/remark-timestamps.js\":\"e3719bf3bcbffd87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/view.js\":\"e8a7b9c84b17ce12\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/LinkHints.js\":\"57d4f1a4f9b3fcb8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/index.js\":\"994c403a41d14534\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/model.js\":\"8d511359a97633b3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/settings.js\":\"e7e1c4d89b54459f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/actions.js\":\"bb4b27327215006b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/index.js\":\"990a11bc589f6fe1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/interactions.js\":\"8dcd1701fb688d9b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/workspace-header/index.js\":\"c91e28dd4edc8804\",\"/knowledge-medium/pr-preview/pr-1844/src/registerServiceWorker.js\":\"be6d41b2b5b0354b\",\"/knowledge-medium/pr-preview/pr-1844/src/requestPersistentStorage.js\":\"7eec5476a8c7bcdf\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authRequestDeadline.js\":\"09ebcc8957bef6a2\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authStorage.js\":\"ca7bd3e2f4c7fbfe\",\"/knowledge-medium/pr-preview/pr-1844/src/services/powersync.js\":\"99073de0153596e3\",\"/knowledge-medium/pr-preview/pr-1844/src/services/supabase.js\":\"35f48e3fe45bebbc\",\"/knowledge-medium/pr-preview/pr-1844/src/services/uploadErrorClassifier.js\":\"47047a085cfb2157\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/ActiveContexts.js\":\"8cb5abb7b68f9c3d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/HotkeyReconciler.js\":\"07972f666e7b9e73\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/WipeLocalDataDialog.js\":\"cb7d0b279d5bf9ef\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionDispatch.js\":\"747d44f36f959d2d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionRefItems.js\":\"ba5f7cffb28a21cd\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/applyKeybindingOverrides.js\":\"27bcb544955622c5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/blockActions.js\":\"2725e27e1aede037\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/canonicalizeChord.js\":\"42e7f68e1c0275cb\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultContexts.js\":\"fa5e1349ed9564e0\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultShortcuts.js\":\"c94395177bb0f51b\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/effectiveActions.js\":\"59b56aa1acb731b1\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureAction.js\":\"58ac074a3b27d335\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureBinding.js\":\"8e57e511fa860b20\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/holdRegistry.js\":\"3cc582f41bd76991\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingConflicts.js\":\"3c1667defc2bbbaf\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingOverrides.js\":\"06bf5b88a14b4d33\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/pointerAction.js\":\"5b15c8006efb983b\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/resolve.js\":\"2ba071e5d210ba9d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/runAction.js\":\"31a116e88a23d965\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/sequenceMatcher.js\":\"96a529c5d7a07768\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/types.js\":\"9585ed244b6017f7\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionContext.js\":\"9f3528d9a839187b\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionDiscovery.js\":\"8f9efed3ecb2bf63\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/utils.js\":\"61f552c1a778805f\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/bootStore.js\":\"60b39efd32cb8e17\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/previewDatabases.js\":\"32af1e8af1ea947e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/byteTransform.js\":\"bd1820f1bff93c5f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/attachmentCleaner.js\":\"2fa576bd904671ba\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/attachmentParts.js\":\"6a07d43abd197496\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleParts.js\":\"3a5a63db77aa5369\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleRecord.js\":\"d1ea23e91b44814d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/manifest.js\":\"7596869b3451cfc7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/takeBundle.js\":\"118d5925dc581434\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/verifyBundle.js\":\"d8f4533aea343118\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/cleaningStage.js\":\"37df4bd4ce604dbc\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionKey.js\":\"ea8c5e37ce5ce79f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionServer.js\":\"d79b1da70e003109\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flip.js\":\"4bc092f5be29109f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flipAttempts.js\":\"f17cf3c7f8152048\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/pages.js\":\"ac5e764b83b7d58e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/preflight.js\":\"e9b3ac59dceb6e07\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/reseal.js\":\"ccecf7f36ecbd870\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runConversion.js\":\"659d1f9c2b32da6a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runLock.js\":\"40b293e5fc4b0dec\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealing.js\":\"225be4617e07095e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealingStage.js\":\"ce258af8e2f23bcc\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/stage.js\":\"a3c413e117d6c8c4\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/verifyReseal.js\":\"12fe4d473348922a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aad.js\":\"71123f1a7657b59b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aead.js\":\"0f80920c7cdb928d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base32.js\":\"2c6d5e392b4e0762\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base64url.js\":\"02282e57cf666ab2\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/binaryEnvelope.js\":\"93f5ce6bcf4f5783\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/byteAead.js\":\"a8bf92deb44eaeec\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/canary.js\":\"1677e042c5d666b0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentHash.js\":\"66daf8e9a3373d34\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentKey.js\":\"c635034599ea00c1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/derivedIdNamespace.js\":\"666678c05450b72b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/envelope.js\":\"13f10fa11bb6a59a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/hex.js\":\"d860325d060be560\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/sha256Hex.js\":\"0151933f32fde2a3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/workspaceKey.js\":\"731538d67a7f1971\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/conversionState.js\":\"ea42392571ecb8b0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a1e476f548c9be1c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/pastedKey.js\":\"3915e080f430d69a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"612b1f81517de5c0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/upgradeWorkspacePin.js\":\"983e22bf0e45774a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/keyStore.js\":\"d55de045cac9be20\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/mintWorkspaceKey.js\":\"612c224e558da6f2\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/modePin.js\":\"ed211236d681ddf5\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/openWorkspaceKeys.js\":\"334ce79a3d87bc41\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolveWorkspaceEntry.js\":\"83d8d69319024b86\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolver.js\":\"080373f657ed3ff1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/workspaceAccess.js\":\"7ff0266fbde2fd58\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/transform.js\":\"14f43a4efd56b373\",\"/knowledge-medium/pr-preview/pr-1844/src/themeBootDefaults.js\":\"0bc0d3916ef94e83\",\"/knowledge-medium/pr-preview/pr-1844/src/types.js\":\"c46cde2cf22cc8f0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/ClientLocalSettings.js\":\"4e35210e1ee12097\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/abortableSleep.js\":\"93270702dbd03a4b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/array.js\":\"548ecbf95c29b6f9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/backlinkAutocomplete.js\":\"6db2c615e1ee3794\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockCrumbs.js\":\"51c37c4167f10caa\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockrefAutocomplete.js\":\"7f45050ffc00939f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/cadencedIdleJob.js\":\"98ccc448b4723bfe\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/callbackSet.js\":\"1fe868efc34eaf84\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/clientId.js\":\"37faf7f3b64f7cb8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirror.js\":\"65148754fcc43e74\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirrorCompletion.js\":\"848e8b28dc687952\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/copy.js\":\"59c977dd86eb5dcd\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dailyPage.js\":\"20c41463df9b53bb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensics.js\":\"04a20c7b6e975f89\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensicsHooks.js\":\"d2ed46def6fafa2d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/deleteBlockThroughUi.js\":\"79199f52cd35e3c6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dialogs.js\":\"39e49a1ce3cd250f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dom.js\":\"aeda644c8c56d497\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/downloadBlob.js\":\"a2096351b82e7367\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/exportSqliteDb.js\":\"e54bd6140b0a28c6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fileSystemAccess.js\":\"60213cdd1be8808c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/flipSlide.js\":\"578a39a58e5c0a5d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fnv1a.js\":\"09ff0078a2f345b5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/formatBytes.js\":\"774d8c1a06f23a44\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fuzzyRank.js\":\"798dd53cf3cf813a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idbKeyedStore.js\":\"786e35487516081c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idleCallbackPolyfill.js\":\"51aebb83e6574a72\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardAwareScroll.js\":\"1fcf0c775cbf14b2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardViewport.js\":\"319adbf4cf375031\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/lastWorkspace.js\":\"d297089ef231e0b0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutColumns.js\":\"66a0c01a2b65119e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionDom.js\":\"37a1c7c5eb64f99b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionId.js\":\"957b67bc8bbcbe44\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkClickGestures.js\":\"c9b2db18066625bb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkTargetAutocomplete.js\":\"1578191a1ab92a24\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbCorruption.js\":\"ee9088af492c9b14\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbRecovery.js\":\"a5d921e2c17808ec\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/markdownParser.js\":\"26004d937263fdd6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/memoize.js\":\"e7ffb85e3f997a56\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameFieldCommit.js\":\"b1fa9a3c117383c5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameList.js\":\"e21f226df5aadc0e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/navigation.js\":\"da7db70b94cce197\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/omnilinerNamespace.js\":\"b7d3f8abde141c02\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/opfsPageScan.js\":\"8ebc0e2470a09ec1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelClearance.js\":\"c17cc204d7f63158\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelHistory.js\":\"156ee0ee993d0cde\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLanes.js\":\"b1da4cbf7f423706\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLayoutProjection.js\":\"c335aa37d624bc34\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelScrollAnchor.js\":\"f9a976b49d7ffb4a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelUrlFlags.js\":\"da7a6c77354588a1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/platform.js\":\"8906f25d253c92e3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/pluralize.js\":\"3fefb05423c8a35a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyCreation.js\":\"667244288a8f1db4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyNavigation.js\":\"0feb5d9ec4af9786\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyValueContext.js\":\"580778880a7227a0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/react.js\":\"0e3ca94931194f20\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeDate.js\":\"844b3a66fd8c68b7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeTime.js\":\"375a7721319acb32\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/renderScope.js\":\"bf0c9797f31618a4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/resolvedThenable.js\":\"7a5b5cde261570fc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/routing.js\":\"e74d14791c001ad2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/safeMode.js\":\"ea98bbb8797997fe\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/scheduleIdle.js\":\"7bdb6609efa2afd6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/screenWakeLock.js\":\"fb85f2576c3bf706\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/selection.js\":\"7948371daa78b687\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/softKeyboardGrab.js\":\"cccc70a6a3f8feb7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/startupTimeline.js\":\"92ef087d139ca910\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/state.js\":\"628826c0db4e4ab6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/string.js\":\"3f2a9b7d42d0412d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/surfaceZoom.js\":\"80900f1e7cf1fb6d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/time.js\":\"e0ac13d51c0c0dfc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toast.js\":\"66af3341ec11807e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toggleStore.js\":\"f1a3a95a7e05fa13\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/untilStopped.js\":\"9f449bbd73eb61bd\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/userActivity.js\":\"acd0725eafbfc7b0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewTransition.js\":\"69f8c853e5731d72\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewport.js\":\"86d152f23c94ea86\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/webLock.js\":\"02a2fd862f86b337\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceRecovery.js\":\"7e86d8956c950091\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceSnapshotStore.js\":\"c18cda8448f36cd2\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-compiler-runtime.js\":\"22181ba30a0cb304\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-client.js\":\"ba5d53c1df9232c2\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server-edge.js\":\"f8ca4592cce76a3c\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server.js\":\"4505f0e348c6c908\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static-edge.js\":\"dac0bfb4c585c98c\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static.js\":\"34c9021f2e6359a3\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-test-utils.js\":\"d0793504fc3453c9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom.js\":\"662ba01436c0dd3f\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-runtime.js\":\"807ecfc7306c623a\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react.js\":\"575c340dfec2f6eb\",\"/knowledge-medium/pr-preview/pr-1844/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
