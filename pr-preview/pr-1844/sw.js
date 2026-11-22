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
		buildId: "ddad489e7dbc-e554c0bb",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/\":\"84169950c37d9232\",\"/knowledge-medium/pr-preview/pr-1844/index.html\":\"84169950c37d9232\",\"/knowledge-medium/pr-preview/pr-1844/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1844/assets/FacadeVFS-CdPZJozz.js\":\"95dbbe99d24a85e0\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSCoopSyncVFS-DX-4dq8o.js\":\"f61de067a0052a45\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSWriteAheadVFS-BhUDl6pR.js\":\"90c784d9a94dae31\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-BWUc3oPE.js\":\"dbf8f5c7e4fa691a\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-ikNcdICK.js\":\"13bb89deac0b406f\",\"/knowledge-medium/pr-preview/pr-1844/assets/worker-BeKqn80T.js\":\"95f1ed473eb16e98\",\"/knowledge-medium/pr-preview/pr-1844/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1844/chunks/app-Bsf4jZ8e.js\":\"d7a25d6e3e6dedb1\",\"/knowledge-medium/pr-preview/pr-1844/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1844/index.js\":\"bca8f007ac6b40c3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1844/assets/AccessHandlePoolVFS-A3-OAZnf.js\":\"3594d17686c4670e\",\"/knowledge-medium/pr-preview/pr-1844/assets/IDBBatchAtomicVFS-C6xEtJtD.js\":\"cc1fadd6cbcadeab\",\"/knowledge-medium/pr-preview/pr-1844/assets/MemoryVFS-DVo-dTJ4.js\":\"d8f85a52506fe0b2\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-SUWAzvyQ.js\":\"abf42bf3002268da\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-5cmjl-J3.js\":\"00adf704c198e3ef\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1844/chunks/AccessHandlePoolVFS-BiFI2q1C.js\":\"e06554446e2f45d9\",\"/knowledge-medium/pr-preview/pr-1844/chunks/FacadeVFS-g7FCqbPN.js\":\"5af2a2a711b49c42\",\"/knowledge-medium/pr-preview/pr-1844/chunks/IDBBatchAtomicVFS-CyfOT_yd.js\":\"a9d41eab9d05237f\",\"/knowledge-medium/pr-preview/pr-1844/chunks/MemoryVFS-D7zxOWxO.js\":\"37c20897d73e39e1\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSCoopSyncVFS-BaG64Xyg.js\":\"286b0a742c578839\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSWriteAheadVFS-CK2-5iXN.js\":\"3524505b91c7f2a5\",\"/knowledge-medium/pr-preview/pr-1844/chunks/Preview-CYUepTPQ.js\":\"626a4e379fffa10a\",\"/knowledge-medium/pr-preview/pr-1844/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/card-fOlQOSPp.js\":\"3bd4618d098e2e61\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-C4thJzdO.js\":\"a84819bb0669c662\",\"/knowledge-medium/pr-preview/pr-1844/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-CnUpQEJl.js\":\"21a79808d9b496a7\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-async-CvGrzZ_c.js\":\"9692696160d7f73c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-1w8_zboq.js\":\"70a7633b816978ff\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-BRUfdkdv.js\":\"b5a12f95d35628bf\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-BUbWxZrJ.js\":\"267d5de644d8ecb0\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-CFQkqWV1.js\":\"4c84857fc9f1a3c3\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-CGlTNRu_.js\":\"779b8a694880605a\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-C_MIaQva.js\":\"00eff955da073856\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DwYzXJbP.js\":\"17293112e364caed\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server-legacy.browser.production-DRTx1I9S.js\":\"9a551de706de575d\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.browser.production-C4aWnF_B.js\":\"bd2cc31d063bcf68\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.edge.production-DGUUfE9T.js\":\"86e829f2a4894099\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-sCSKjq_S.js\":\"ffc58b6256fa15d9\",\"/knowledge-medium/pr-preview/pr-1844/chunks/server.browser-Di6q4AJF.js\":\"5187667c90ac4424\",\"/knowledge-medium/pr-preview/pr-1844/chunks/textarea-CPydr_h3.js\":\"e49576b6fb3ed830\",\"/knowledge-medium/pr-preview/pr-1844/chunks/ui-D9CYpXt7.js\":\"44d8d861aeaafa4d\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-BvEzlTnI.js\":\"5393f551905b546c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-async-Xadwtb4r.js\":\"bafc79d117cd8e66\",\"/knowledge-medium/pr-preview/pr-1844/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1844/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/src/App.js\":\"072c15eb616ac3a3\",\"/knowledge-medium/pr-preview/pr-1844/src/appUpdate.js\":\"e9d9ff95c04bfe18\",\"/knowledge-medium/pr-preview/pr-1844/src/appVersion.js\":\"6fa1ff0be7c02cf6\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/initialLayout.js\":\"bd871d7e1456e5e3\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/openWorkspaceData.js\":\"4288b717e72a8a6d\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/resolveWorkspace.js\":\"04e3e90a4a9b321b\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/workspaceBootstrap.js\":\"bb06d075f7681ac6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockComponent.js\":\"33a6d028e0b7247e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockCrumbs.js\":\"bd08dfe9759e77cd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockEditor.js\":\"b39839dbf2dfb1ee\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockLoadingPlaceholder.js\":\"52281f4f13455c6f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockProperties.js\":\"959973187a256131\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockSearchPicker.js\":\"ac7ad52cd9d372e4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ConfirmBulkDeleteDialog.js\":\"408cbca0beda034f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DividerHandle.js\":\"2b1ef2cfa117f68d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DraftEditor.js\":\"253ab0397224b4dc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/GutterPill.js\":\"1a895544e95ee0e3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Header.js\":\"07ad2a7d40a274cf\",\"/knowledge-medium/pr-preview/pr-1844/src/components/LazyBlockComponent.js\":\"ea9ea64ce2574b32\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Login.js\":\"ce0a7574bc0de330\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ZoomableSurface.js\":\"01fa6b918dd16f28\",\"/knowledge-medium/pr-preview/pr-1844/src/components/editModeKeepalive.js\":\"797a2d6df29c0f0f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d4490fc8d2b89a95\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"48dde72f1c9e4e50\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefPropertyEditor.js\":\"d0628081d662f6a2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefTargetTypePicker.js\":\"325f5cda37d79c55\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/SelectPropertyEditor.js\":\"66c23de848a8fe72\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/TypesPropertyEditor.js\":\"3722f5db3d8f0a5a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/defaults.js\":\"6dda715afb649913\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/kernelValuePresets.js\":\"429c97e115c6418b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/selectablePresets.js\":\"5925e1e35791209f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/typesPropertyUi.js\":\"f0de2037a033e6cd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/AddPropertyForm.js\":\"4af48d0200d6e388\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyPicker.js\":\"526f005d26c10a67\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyRow.js\":\"cd53989be4b2c883\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/Rows.js\":\"d951c743baf557cf\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/actions.js\":\"9e82ef698c27a30c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/declarationOnly.js\":\"11dbc64a29ed3161\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/layout.js\":\"6f109e80290f91b1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/model.js\":\"829b33d0c873caf0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapeUi.js\":\"68896ec77fa34ce6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapes.js\":\"c5bdb7c0f4a50385\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c366daf473f99ee4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/visibility.js\":\"11b87948e74b8e56\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanelSections.js\":\"7d242cda65a1ff50\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockEmbed.js\":\"e763b465f93d5201\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockLink.js\":\"219bc3b29f393d56\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockRef.js\":\"b8cdbd0350ca505b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/ReferenceLink.js\":\"247e3079800ba2a6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuard.js\":\"877ff92232547290\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuardContext.js\":\"4c5980d39512260d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/linkInteraction.js\":\"994be6da6c589160\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/referenceLayout.js\":\"ce8c0e1ff145cbc4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/useBlockRefAncestors.js\":\"2aff6644d9a68a34\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockGutter.js\":\"c0291e7162d238d1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockInfoDialog.js\":\"db8d6f76a9b4c457\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockTypeBlockRenderer.js\":\"30a11d4806c43eca\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BulletHoverCard.js\":\"9ea3fb08e5908944\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorContentRenderer.js\":\"c89759315b71aa1a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ac8b4ff716714992\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ColumnResizeHandles.js\":\"637b14b488febf66\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"401946fd4508d7da\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/DefaultBlockRenderer.js\":\"5b0337fec1519b18\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/LayoutRenderer.js\":\"70444a673c37439b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MarkdownContentRenderer.js\":\"53d51128cb481d7e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MissingDataRenderer.js\":\"44d420a0b96ef848\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PanelRenderer.js\":\"a40128c27f760976\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a640dcdac1a5f26c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/TopLevelRenderer.js\":\"934741b18af23f2e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockGutterMode.js\":\"dbca41312a3608d2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockTitleText.js\":\"e19bce07e6784976\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/fieldCreationKeydown.js\":\"91662f41098bf191\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/layoutRootContext.js\":\"f035dd96845d9a5c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/TypeChip.js\":\"9aed9342b1e7f3e6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/chipStyle.js\":\"047f1126621ee88c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/anchored-floating.js\":\"69aee23ca0b328fe\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/button.js\":\"bb83268d0281b1b8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/card.js\":\"15fb81a20a8ca571\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/checkbox.js\":\"38773d7b9b6e5424\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/collapsible.js\":\"f2678518c5757e7f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/command.js\":\"9eb7b12e58efba79\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/context-menu.js\":\"40b618ef9ca1ab60\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dialog.js\":\"6156fa84a1d6553d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dropdown-menu.js\":\"99ca927ed170ca77\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/floating-listbox.js\":\"69c218ac13b687f0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/index.js\":\"25c5fc1a0ce7de67\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/input.js\":\"1ee7982cce0f8464\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/kbd.js\":\"bf0ddc32f3a20a36\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/label.js\":\"6b0a8b3a60f04923\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/textarea.js\":\"275d84cf9f7ed953\",\"/knowledge-medium/pr-preview/pr-1844/src/components/useEditModeYieldKeepalive.js\":\"371d03290d09f2b4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/BootFallback.js\":\"79553982535b12de\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/FocusedRowLazyMount.js\":\"0857bfd27adbacca\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LazyViewportMount.js\":\"1db673667aeff49b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LocalDbCorruptionFallback.js\":\"0632744f81da1d11\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/error.js\":\"7dd09393c721b0f5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/lazyMountRegistry.js\":\"de06a51253078e4b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/suspense.js\":\"4290ed1ba9175ffd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/CreateWorkspaceDialog.js\":\"b3d422fb3daadafb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/PendingInvitations.js\":\"3a01011a0293cc35\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/SyncProgress.js\":\"c19e18e7f7485cc1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/UnlockProgress.js\":\"84b451bf56c8c693\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceKeyGate.js\":\"28a6ac6b937c9018\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSettingsDialog.js\":\"01a0ff09953488e6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSwitcher.js\":\"026984fce9132847\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSyncGate.js\":\"ec7c05543a427b2b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlow.js\":\"910857e69e796632\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlowHost.js\":\"2009a8f02f651ae6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/EncryptionSection.js\":\"82703c0de6ff4059\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/attachmentPrompts.js\":\"bf75d1738630ee6d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/bundleFolderPrompts.js\":\"17694a7e38a70a7d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowDeps.js\":\"a9077675bf4b1f18\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowStore.js\":\"9e72904b29ac769a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/flowUi.js\":\"04c708d1dc7041fc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/useConversionRun.js\":\"aadc9ca00108145f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/keyUi.js\":\"c670ea6b4fd59806\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnKeyLoss.js\":\"fd4e8c5acfe2a8ae\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnServerE2ee.js\":\"71ce20f039380524\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/workspaceUnlocked.js\":\"51d102274e9b13d1\",\"/knowledge-medium/pr-preview/pr-1844/src/context/backgroundSubtree.js\":\"d3f1672dabd66e1d\",\"/knowledge-medium/pr-preview/pr-1844/src/context/block.js\":\"24cbdc3f1665931b\",\"/knowledge-medium/pr-preview/pr-1844/src/context/layoutWsContext.js\":\"ab8b08868ccc7880\",\"/knowledge-medium/pr-preview/pr-1844/src/context/propertyDisplay.js\":\"4a318dc926a8dce8\",\"/knowledge-medium/pr-preview/pr-1844/src/context/repo.js\":\"c4fa421050eff472\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasClaim.js\":\"22865b1df957bd98\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasSeatNamespace.js\":\"65f5ea3944da70b8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockData.js\":\"e5d1b3aae09f9a2b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockType.js\":\"7d5a9eba95911adf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/changeScope.js\":\"39ead80312d61ba8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/codecs.js\":\"0619f722939b54f8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/derivedData.js\":\"faa52d52db41d54a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/errors.js\":\"b819a04e0855c359\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/events.js\":\"32fd87d09a696c82\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/handle.js\":\"350fc511b7c2224d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/index.js\":\"cbc5baf1554c3a63\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/mutator.js\":\"cb835aed6ebc76c7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/processor.js\":\"8ce2fe5091192dba\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/propertySchema.js\":\"e141611ba1d81324\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/query.js\":\"aaa1990f0484458e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/sameTxProcessor.js\":\"2597f391386d0ff7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/schema.js\":\"350fc511b7c2224d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/tx.js\":\"350fc511b7c2224d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/typedBlockQuery.js\":\"de8a371b07c41db7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/user.js\":\"d2b40e4a4ed3ed15\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresetCore.js\":\"bc7c504bae9f3621\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresets.js\":\"8e3118907730fee5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/attachmentCleanerIOVerb.js\":\"5efffbabfdcd4c1d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/block.js\":\"7c31c0fa7a468314\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockCache.js\":\"d6849dd327664361\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockId.js\":\"ba820ef823c2bd69\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockLiveness.js\":\"cb4762b733c9d3d3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockMerge.js\":\"4621f147e45599cc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockSchema.js\":\"d24c4b53c8dfd25e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypeLookup.js\":\"93a32615e111cc4e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypes.js\":\"40b96a08179dffb9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/clientContext.js\":\"1634770383eb78ec\",\"/knowledge-medium/pr-preview/pr-1844/src/data/dbFileSiblings.js\":\"26d311749b79f7e4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/definitionSeeds.js\":\"231376b0c82719c1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/derivedIds.js\":\"510ac4612d2cc929\",\"/knowledge-medium/pr-preview/pr-1844/src/data/drawnSubtree.js\":\"6468b04cdcad6c28\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facetBridge.js\":\"cfc1c5b7c1da408c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facets.js\":\"86ba59fa08f46e38\",\"/knowledge-medium/pr-preview/pr-1844/src/data/globalState.js\":\"68fe6a008d39d495\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/aliasClaimRederiveProcessor.js\":\"a0e589c069860c06\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/ancestorBatch.js\":\"6ab7d9f46d88b7af\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/blockTypeTypeifyProcessor.js\":\"688da8b043b5904f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/clientSchema.js\":\"386b76408313be71\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/commitPipeline.js\":\"37b09d923c09d4b7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/devAssertions.js\":\"6369db6e5a376e38\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/firstSync.js\":\"44f71012fcd6a8b8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/freshInitialLoad.js\":\"c6d63eada1e5e67f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/graphBackfillClaim.js\":\"9e39c1a86761793f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/handleStore.js\":\"8b7051d3f7741aaa\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/idleMarkerJobs.js\":\"25b562b218253cca\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initialDownload.js\":\"2fb9f5d1a64b33ea\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initializeClientDatabase.js\":\"b772fac8c219be44\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/jsonCanonical.js\":\"fb2d08fc047ef50a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelInvalidation.js\":\"151ade3ce71393b7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelProcessors.js\":\"d29d392cce52910d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelQueries.js\":\"b47331887aeb2e3b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/mergeTypeMembershipProcessor.js\":\"42177ba4450dc131\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/normalizeReferencesProcessor.js\":\"708f3e1f3441fb2f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/poolInstrumentation.js\":\"abca83372e32f75a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/processorRunner.js\":\"d51c78a074b7455b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyCellBackfill.js\":\"a03235471d07e2d7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildMint.js\":\"9909d1deaaa84d59\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildrenProcessor.js\":\"efcdbfcfaa756273\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bf4d7213455a058e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionSynthesis.js\":\"1274432e9d4c7e04\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyKeyScan.js\":\"2008a761485d9a52\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertySchemaResolution.js\":\"2030f7e58cf60eed\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyValueEdits.js\":\"adec262d460ae0da\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/raiseProtocol.js\":\"ce05a9ae23446ac9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/readBatch.js\":\"8ce2ac0e6036a4a1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/refProjection.js\":\"d625397a9284dc45\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetLookups.js\":\"f0034fea7d244522\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetProcessor.js\":\"2bf403e80c775f92\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/replayMerge.js\":\"12a5b46610a664bb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/sqlBinds.js\":\"31ee9a43c5736bc9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"d90ab4810735a6b2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/arrivalProcessors.js\":\"f87dd4435a381afd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/invalidate.js\":\"2be3cce696c5a53e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/materialize.js\":\"59f81874a8323414\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/observer.js\":\"739d124c8a005d43\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/reconcile.js\":\"d1c0635fecd3ee47\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/timingMetrics.js\":\"b55cc8d72f58fb98\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/treeQueries.js\":\"d473ead0f5d2168c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txEngine.js\":\"d745e1943fc047af\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txSnapshots.js\":\"20ea9df274f011cd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/typedBlockQuery.js\":\"57fdb133472470da\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/undoManager.js\":\"826df02c69d30040\",\"/knowledge-medium/pr-preview/pr-1844/src/data/invalidation.js\":\"09b29a4e04c85f1d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelDataExtension.js\":\"8372a7603462a367\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelPage.js\":\"f65c7e5136465178\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelValuePresetCores.js\":\"973eec472a7e188d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbCorruptionSignal.js\":\"3f2c9af6c7c97bf2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbStorage.js\":\"a0cac859657f1f4c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbVfs.js\":\"fca16229610715df\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localSchema.js\":\"48f07c966b24d730\",\"/knowledge-medium/pr-preview/pr-1844/src/data/maintenance.js\":\"330caa73c5e6c272\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mergeProperties.js\":\"c497eb5931bf39f4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/metricsConsoleHook.js\":\"5d10ed8e5e8dc624\",\"/knowledge-medium/pr-preview/pr-1844/src/data/migrationsPage.js\":\"32d4dab5cc4d1255\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mutators.js\":\"5e35b662146f3a8e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKey.js\":\"b250013797aa4f39\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKeyPlacement.js\":\"a9492dca77576346\",\"/knowledge-medium/pr-preview/pr-1844/src/data/outlineSurface.js\":\"87e57666ff11bef8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingEditorContent.js\":\"3b6b1d9802c032b0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingUploadsSql.js\":\"c3780fffd4875392\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pluginStateExtensions.js\":\"de1e1543484bb122\",\"/knowledge-medium/pr-preview/pr-1844/src/data/powerSyncLogger.js\":\"3ffa2543d37f85f7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/projectorRuntime.js\":\"7cd052f35b620e18\",\"/knowledge-medium/pr-preview/pr-1844/src/data/properties.js\":\"ed85bf22bf001593\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertiesPage.js\":\"0755696917939b87\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyChildren.js\":\"fc0aa0b2c7c92489\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionFanout.js\":\"c4716210a5b80cf7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionMetadata.js\":\"880a8aa4e59d1b7a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionRegistry.js\":\"ffad1654fafc9c3f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDisplayMode.js\":\"90cce6d4da3753ad\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyRowCreation.js\":\"be95e7e391f31ff9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySchemaCreation.js\":\"f8af8698e8a23690\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySeeds.js\":\"25182b2e4372c9c9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/recentsPage.js\":\"04dba28bfab728f0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/referenceBlock.js\":\"c019466e01481ca3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rejectedUploads.js\":\"381321fe1d109509\",\"/knowledge-medium/pr-preview/pr-1844/src/data/releasePowerSyncConnection.js\":\"91c80acc1aaaedbd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repo.js\":\"022c104c1c24fa3c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repoProvider.js\":\"adbeb5c1612cdb3d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rowProperty.js\":\"194bda6165cfdc49\",\"/knowledge-medium/pr-preview/pr-1844/src/data/searchFilter.js\":\"4fe80c878099d20e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/seedIdentityLedger.js\":\"ea365ace5d6b7353\",\"/knowledge-medium/pr-preview/pr-1844/src/data/stateBlocks.js\":\"b6f77b82b27110a6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/structuralEditPolicy.js\":\"faecb96116eedb6f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/subtreeDelete.js\":\"004088f78bec5655\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncStreamLock.js\":\"53ec374b518a9ca3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableSqlRecognizer.js\":\"29d8e1f8cc74002a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableWriteGuard.js\":\"facf033c2ec20e31\",\"/knowledge-medium/pr-preview/pr-1844/src/data/targets.js\":\"ade670a7d2d8a2f7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeColors.js\":\"f596ae916ed852dc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionMetadata.js\":\"b3dc3ea5864437d0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionRegistry.js\":\"b992c50ca2b2b2d6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeExtraction.js\":\"d883b57b05c5fedb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeInitialValues.js\":\"9a0bda3871617cd1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typePropertyGroups.js\":\"83736cb1e7d6dd22\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeSeeds.js\":\"ffdf317240ca09c7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeTagger.js\":\"53292c4644efe290\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typedRecords.js\":\"889736b9dd5f105c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typesPage.js\":\"4549e176f4ced53c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userPrefs.js\":\"51b4f95aa774aa63\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userSchemasService.js\":\"970cfb35068c8c4b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userTypesService.js\":\"705e3fdfef8472ba\",\"/knowledge-medium/pr-preview/pr-1844/src/data/valuePresetRegistry.js\":\"7e4cbbd2e7b7ea76\",\"/knowledge-medium/pr-preview/pr-1844/src/data/visibleChildren.js\":\"2733ad169e31d92f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceConversion.js\":\"a236e6c4d24d8416\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceFirstSync.js\":\"04ad6ab75e7c352a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceIdNamespace.js\":\"d79a26eac460f55e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceSchema.js\":\"58d15dd44d653d66\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaces.js\":\"e6cd5b83342bb382\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadLog.js\":\"e5f0336c0ffd4a27\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/BlockPasteShellDecorator.js\":\"44e972620e72f621\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/atTrigger.js\":\"b7159d8ab5b33f17\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/autocomplete.js\":\"c8c97056ebfc95a1\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/codeMirrorExtensions.js\":\"bbc8d9cb3e1d4a51\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/contentFlush.js\":\"23cc936d993fb437\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/defaultInteractions.js\":\"baabb060692d6a61\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/editSettleSignal.js\":\"f8d5cb6920537244\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/editorOccurrences.js\":\"497600b0efb9cde5\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/insertImage.js\":\"25dad05b6dc57cc2\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceCompletionRange.js\":\"2ddd28eac0e022ba\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceTargetTypes.js\":\"30b825f10190948d\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/syntaxContext.js\":\"a96e0a9b98bb1d89\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/triggerMatch.js\":\"ddddd5c5e8a0203f\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/AppRuntimeProvider.js\":\"06038f5ec9ae3190\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/BlockFocusShellDecorator.js\":\"7524eaea5def3d7a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/ExtensionRenderBoundary.js\":\"9e55738cfb23a15d\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/PanelContentRecovery.js\":\"172e3ca4f7c01c80\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/apiCatalog.js\":\"222d71f11ad93d12\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/approveExtensionHere.js\":\"c2c48f182f4eca82\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/armedCutAppMount.js\":\"6599658f9018017a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/batchableKeyedStore.js\":\"d2698fef8aa7c1cd\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockInteraction.js\":\"353f016dfa7b22f2\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockSelectionAction.js\":\"42d1c3c32350638e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compileExtensionModule.js\":\"062f2df2a2247590\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compiledModuleCache.js\":\"5fdd1a7c29a55961\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/continuousGestures.js\":\"83afda07cfc76f50\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/core.js\":\"e2d342788ea19933\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/defaultRenderers.js\":\"fb2c2c78fb2b7b05\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/definitionFanoutAppMount.js\":\"0fba2e730244285e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dialogAppMount.js\":\"942f2c3230829fd7\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensionSeeds.js\":\"dd4fad8bbea85721\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensions.js\":\"36a9f71da59d27f7\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/exampleExtensions.js\":\"8c7823709a4b6e95\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionApprovalStatus.js\":\"29e024a26d72d1c8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrorToast.js\":\"58d9fb9b14fa97c2\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrors.js\":\"0da20bebb8b70b01\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLookup.js\":\"be0505f63408b953\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionToggles.js\":\"3a24d6f76dae6994\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionUtilitiesCss.js\":\"f9dceec863a171b8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/kernelPageDeletionGuard.js\":\"8d02ccae6f4a28bd\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/liveRuntime.js\":\"6b1fa382a36b3981\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/openExtensionsSettings.js\":\"750452c5fa4fb329\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/overridesCache.js\":\"384b707a318a028b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/pluginIds.js\":\"9447859d9277afce\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/processorRejectionToast.js\":\"333af0cdd5ef2e70\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeActions.js\":\"c87cf779c2ad64ac\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeContext.js\":\"232a23076de43108\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticAppExtensions.js\":\"46131bad31ac6014\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticDataExtensions.js\":\"1d9793b20f40df68\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/toastAppMount.js\":\"519999ec62ddc349\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useOverrides.js\":\"0140c7537ce2c030\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useShortcutSurfaceActivations.js\":\"7ee2b7ee7c4bcc93\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/discoverToggleTree.js\":\"0af9aab7df1aa1bd\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/facet.js\":\"08383bbc56ed3dfd\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/resolveAppRuntime.js\":\"c4809b34bc17664e\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/runtimeEvents.js\":\"77f0e4e58f69e9ce\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/togglable.js\":\"73fef98077036cac\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/variantFacet.js\":\"9d747a0afba1ef6e\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/verbFacet.js\":\"b4530f26b6303b35\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/block.js\":\"b0f4f3a61ac564c8\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/focusedChild.js\":\"f2f0da62b58e5869\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/propertySchemas.js\":\"b2d8290a433793ee\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/typeRegistry.js\":\"600bd2a6426a9f4c\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAncestorCrumbs.js\":\"44b0ae14367b9160\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAutocompleteListbox.js\":\"ee6be63e2a4abce6\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedSearch.js\":\"def17c1d575b170e\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedValue.js\":\"44d482d587437e6b\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsFocalRender.js\":\"1cc18e3cf5818d3e\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsReadOnly.js\":\"10900cc9edf7325e\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMaterializeBacklog.js\":\"4e4c5543024f20b9\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMinuteClock.js\":\"e14541839ae96ee6\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePanelLayoutProjection.js\":\"1ec71566c9fa343a\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePendingInvitations.js\":\"9e871af56a92afdd\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRendererRegistry.js\":\"49d1a4f582274f87\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRetainedFieldRows.js\":\"f86748776a23fddb\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useWorkspaces.js\":\"058df65f5d903801\",\"/knowledge-medium/pr-preview/pr-1844/src/lib/utils.js\":\"68c8f39a157d5244\",\"/knowledge-medium/pr-preview/pr-1844/src/main.js\":\"88a2f37aae2c89b4\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/MarkdownImage.js\":\"70115d6e71643236\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/blockSeparators.js\":\"28f1ff75afe1b1a4\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/context.js\":\"80ae7d3a09ad9c91\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/defaultMarkdownExtension.js\":\"55a9bdfac87a87c8\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/extensions.js\":\"97a0b434b2d2a1cc\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/renderMarkdownHtml.js\":\"fdbb819c6e71c127\",\"/knowledge-medium/pr-preview/pr-1844/src/minimal-editor.js\":\"1d720f551d51cf84\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/armedCut.js\":\"d366a7ce6d289d6b\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/captureMediaVerb.js\":\"59dd107ccf5d48aa\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/clipboard.js\":\"1d2cf09981369938\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/decision.js\":\"3ad6414b081125da\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/operations.js\":\"0bda3c0275bb1807\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/AccountHeaderItem.js\":\"3bd837edfbe1a88a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/index.js\":\"494277afa69e11d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b020e45b83d76335\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askAgent.js\":\"61269f2977dd94bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askedStore.js\":\"b62d3f565f5de493\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d94b6204ed1833d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/chipState.js\":\"fea1110e91253ea3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/dataExtension.js\":\"02699c75d527eadf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/index.js\":\"d6e17c1639ef19c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"097992ae557da490\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/schema.js\":\"422a5466c78cfabf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/AgentTokensDialog.js\":\"5aff390933648969\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c039e1b776501212\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/addMedia.js\":\"a223aa69055508b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9a89b97032360d47\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/block.js\":\"225cd3f2ae687066\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/context.js\":\"b65cae0cfcae3d23\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/displayIds.js\":\"cbe4142ffea6a06b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/index.js\":\"540fba3f85ee84d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/outline.js\":\"8f5109607a46440d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/properties.js\":\"171387296ba74631\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/refs.js\":\"7118e0a0bf11aeec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"eeed4c412a6fb4e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/search.js\":\"aeb175cd72bd8d02\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/shared.js\":\"98884900497a1849\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"fce73bde218fb064\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/text.js\":\"b51a3f5144a868fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentWrites.js\":\"ed986568075ca42b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/authoringCatalog.js\":\"2d01f71476cfd176\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/blockRefTargets.js\":\"411eac719b5b195f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridge.js\":\"319c85313fe61a4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridgeLoop.js\":\"9a789014e9f78054\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/changeHistory.js\":\"e0dc503b31b51c2f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commands.js\":\"c3a8193bb8e2fb12\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commentsCommands.js\":\"f541a082f74a6979\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataExtension.js\":\"350be275cc007e01\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataModelGuide.js\":\"2ae2d8ccf1853add\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/describeRuntime.js\":\"cb507d17f00351b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/extensionLint.js\":\"264a4faddd5676be\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/grainAudit.js\":\"09690d1412b9f9fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/healthCommand.js\":\"73e96187f285f06f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/index.js\":\"c7cb9ded7baffb70\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/presetIdentity.js\":\"34ec914ddae7a24b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1f876d6e2e36443b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/readMedia.js\":\"56b96f3376d61ec5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/schema.js\":\"1e36d673d43dc72c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/serialization.js\":\"2362c8e2faf42c23\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/targets.js\":\"b5724d9733ebe542\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/tokens.js\":\"ceb42dba95c78059\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/watchEvents.js\":\"c2b704be1f1b0724\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/workspaceGuard.js\":\"cbe2f6c5251f4c3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/writeCommands.js\":\"489da0ba373a3c10\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/AliasCollisionToast.js\":\"82c422c3f995dc02\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/DuplicateNameBanner.js\":\"8fb57ca2f0e36a63\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/collisionMerge.js\":\"3bd8b5cf4a63dd52\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/dataExtension.js\":\"c023e5f0231c7a2c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/index.js\":\"fc69a8f6bf64e8a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/mergeCollisionAction.js\":\"515b447cd1babd75\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/pageStyling.js\":\"ad118764b812150f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/rejectionToast.js\":\"8c8c8aa157bec3a1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/syncProcessor.js\":\"509f094df8f2e497\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/actions.js\":\"3358285bee4124ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/addComment.js\":\"aea7b83a477ed44c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchor.js\":\"ac78a51df017a426\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchorState.js\":\"386f75630e03f237\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/commentLinks.js\":\"ad3dfb350ca708ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/confirmThreadDeletion.js\":\"bea4c0eec21f230d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/container.js\":\"0fdeca624bc7c710\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/dataExtension.js\":\"942f631abac2c11b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/deleteComment.js\":\"6edb3223975c4068\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/highlights.js\":\"dea6b0cc01ee2aea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/index.js\":\"0d7466d473f3e227\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/linkedCommentsPill.js\":\"ceefe9f00d429c35\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/margin.js\":\"099cc0bd36f7fcc4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/marginSchema.js\":\"7a76c028deb14baa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/newComment.js\":\"3c18715a58bd8923\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ownThreadPicker.js\":\"8e6d5052510c60e3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/placement.js\":\"6f8b4dced1e5d7cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/queries.js\":\"b17a1a8a8d262ed4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotePosition.js\":\"20b216b4386d13e7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedIn.js\":\"36e5e263cb8eac7b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedRange.js\":\"3d94b496a029bfc8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/rangeRefs.js\":\"fbd687410e268f87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readHighlights.js\":\"48afb495fa2902b5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelection.js\":\"7727958aca145fa2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelectionUi.js\":\"8ca681914b12a161\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/reanchor.js\":\"25ffc02cedddfedc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/schema.js\":\"d40a3b9693ba125d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scope.js\":\"346abcaf3310a9e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scopeThreads.js\":\"f58460163df02fd2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/splitRetarget.js\":\"19c0ef66365c5143\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestionCard.js\":\"1a691f071410a840\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestions.js\":\"08d6cf7c30a7d20e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaries.js\":\"aef6cf3aee0fb765\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaryBatch.js\":\"6439ce5d7a9b052d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/surface.js\":\"a3315d9072a6f973\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threadNavigation.js\":\"48f144eeff52c15a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threads.js\":\"8cb860149b91a4ce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ui.js\":\"bf0f1d9a789d30ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/uiStore.js\":\"4cff69eb16762025\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/appIntents.js\":\"d64691c56d441436\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/index.js\":\"14ec283d3c349c82\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/index.js\":\"2a215cc403a92103\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/status.js\":\"cde4066e4f44b3dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"45db101f26bcf070\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaBlockRenderer.js\":\"cd1eb5714f62c4ce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4fcf4732b3a3b0de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaUploadReconciler.js\":\"1cd2db82456ad257\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetDownLane.js\":\"fcf730927a25593f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetResolver.js\":\"ef9653c2bbfc7e79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetUpload.js\":\"1c42c3b3bfa57039\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/attachmentCleanerIO.js\":\"79d0c8f1d4635399\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/supabaseAuditIO.js\":\"04512a09370e2fef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/blobStore.js\":\"6bf9cd881c40245b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/byteStore.js\":\"e39cfabc016ed698\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanerIO.js\":\"d91367fbf5e48919\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanupAttachments.js\":\"04d551eecb764065\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/dataExtension.js\":\"91645dfa3051d040\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/downLane.js\":\"44e54a3b93a9a6f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/index.js\":\"2f0c44e05a507487\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/insertImageContribution.js\":\"b89efa2f4fdbc7bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneArming.js\":\"be7e0769d621c305\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneLock.js\":\"96854e3e1d611ea0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaBlock.js\":\"7980145608eeac85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaCapture.js\":\"bc10743e650243b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewers.js\":\"1760e5c8026e213d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewersFacet.js\":\"179bbc904a49c71a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/pasteCapture.js\":\"0e3a2d88373330d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/resolver.js\":\"967615e24514fdb7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/retryUploadsAction.js\":\"3c915613dfedb0ae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/storagePaths.js\":\"029ec2a3e6c5f57b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadDrain.js\":\"491bf40a34b9f906\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadLaneStatus.js\":\"2ba6633eece6c12f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadReconcile.js\":\"70b501861b511aec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadRecovery.js\":\"6bcd65c0f7caf5dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadStore.js\":\"ba7c26b0ba9a0f6b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/useAssetObjectUrl.js\":\"b33ba681e7eddb19\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c4aa34a00433702a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksViewSection.js\":\"19da9abbbfa31ad3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/facet.js\":\"d3bab8010d9530c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/index.js\":\"c43f15c65447117f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/prop.js\":\"09300ec0520ac660\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinkFilters.js\":\"7725bb28fa224afb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"443e60a2298c7302\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BlockEntry.js\":\"09eab8b0bfa7f286\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/LinkedReferences.js\":\"ea991d77cc18ad82\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8d39eb04940afb33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dailyNoteDefaults.js\":\"9832ac9c5f8effc2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dataExtension.js\":\"9e680ffa75871daf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/edgeExclusions.js\":\"460be33639d1402a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/filterProperty.js\":\"77487974d5dbb715\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/index.js\":\"dd2d7e1aacd0936d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9ccc6c05edcb5872\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/applies.js\":\"7c6110348b20a075\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/countQuery.js\":\"f95eea3d421f3aef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4f1d7c3e59c33890\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/index.js\":\"df5f88c60bf54d30\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"656fad25cfa3b776\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/presentationInvalidation.js\":\"6edbb64abadc8da9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyEditorOverride.js\":\"bf897938fbded144\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyFilter.js\":\"cf4532442ca45cfb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/query.js\":\"efb4aaab84230153\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/resolveFilter.js\":\"14f6a1e10ac79417\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sourceBatch.js\":\"fb01787b078f4faa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sources.js\":\"5449956b185008ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useBacklinks.js\":\"d07b95a420b86333\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ca818f6bd403c4c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayCelebration.js\":\"1d179623dceec21e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayOverlay.js\":\"6e6d68dab858fb07\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/gate.js\":\"1594bbb21350ddac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/index.js\":\"7d385c51dab82c19\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/wolfTheme.js\":\"6a4869611448bd93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/BlockDragLayer.js\":\"fad7e9c68bfa5d07\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dragController.js\":\"fac357c2f41625f0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dropTarget.js\":\"9a94c710d9822458\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/index.js\":\"d23d701e954705d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/projection.js\":\"4cdd3a0a4d104217\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/BlockMetaCard.js\":\"10108116e1c7997d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/index.js\":\"038165c4b8a98ddf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/AddTagDialog.js\":\"645e4a91250a62a2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"af27f23181180afd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/TagNameIssueHint.js\":\"0978f5a44de23d82\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/addTagAction.js\":\"cb81c862a49d6122\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/appendTag.js\":\"4ed3116d18f842e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/config.js\":\"9863521b7b8b0186\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/dataExtension.js\":\"b07ab586b6c72ba4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/index.js\":\"e807c89d24b4a93a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/propertyEditorOverride.js\":\"d791da63ebfacd10\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbList.js\":\"981a2e38fa1fbbe2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8d8b758985b63d66\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a1a25dcfe3b16962\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1a890a4936e73b30\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f91e471b53cb44bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/index.js\":\"ef8ebb8c9f910a16\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4c13c891347e8967\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/CharacterCountItem.js\":\"07b371300f737788\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/ProfilePropertyEditor.js\":\"88e418794c742b1a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/actions.js\":\"35740d27908feeee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/blockType.js\":\"d43ef7427ac278f7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/charCount.js\":\"d733812e9392cc69\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/dataExtension.js\":\"42f03f5f66bff410\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/index.js\":\"f8f2085498bb9d9b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/profiles.js\":\"60d8d6deec02b418\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/properties.js\":\"3cad1f132f16c915\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/textCounts.js\":\"77bc1ad8480c895e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/colemak-keybindings/index.js\":\"96b512f4bf9800be\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/CommandPalette.js\":\"a129d62add73f476\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/HeaderItem.js\":\"fcbce00ea4647d7e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/context.js\":\"83d699ceffa61963\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/index.js\":\"f4bc2c1baa9ba8f6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/selection.js\":\"4b4a11eefe11b280\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/toggleStore.js\":\"d0d7a3330106bf9b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/useCommandPaletteActions.js\":\"8097a699cc8b36a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/ContributorBadges.js\":\"5337c1369d8afda9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/author.js\":\"0b70a6039634ebd6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/codeMirrorExtensions.js\":\"813ee1e6f6b12d5c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/dataExtension.js\":\"f84fd73dfe006950\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/index.js\":\"ee84b1e2116045cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/mentionAutocomplete.js\":\"b541180e77c7156e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/processor.js\":\"c52169778e98b68f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/profiles.js\":\"e2c36a60d3d78ef7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/queries.js\":\"7bc5d3ecf2c0914e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/schema.js\":\"172d484cad2473ed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"fad461600d7634c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/followOrigin.js\":\"20664009fb8c41d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/index.js\":\"2231ebe41cda8451\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f360dd2e53554c04\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b8a2601a241eb5b3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/CalendarGrid.js\":\"09822951046377b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DailyNotePicker.js\":\"68e9b6603ad90aab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a3b5105a6dcdad85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateNavDecorator.js\":\"a70543cd0a81eb99\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateScrubOverlay.js\":\"5af84fdc72c35da5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/HeaderItem.js\":\"09c47bd9e8eea824\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/ReschedulePicker.js\":\"1fd74d10750d7e24\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4a20ac9445bf9d42\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/actions.js\":\"94f3fea42f877313\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/blockDateAdapter.js\":\"d40cecd272fdd920\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/calendar.js\":\"41bf445c2d9592a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dailyNotes.js\":\"970b5cf9464fe0dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dataExtension.js\":\"11825958d00623b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubActions.js\":\"82c6d30d7153f527\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGesture.js\":\"d7349565d9dac6d0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGestureActions.js\":\"cbf8f8338ce125a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubRecognizer.js\":\"237597fcc1076311\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/deletionGuard.js\":\"f31668febc98a7b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dueQuery.js\":\"58943cbc43f88a9c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/index.js\":\"76efb757cb03ba8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/landing.js\":\"d9d469362f557359\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/localSchema.js\":\"0dd040e126025869\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/referenceDateAdapter.js\":\"fcb3eddf8fe6c82f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/rescheduleAction.js\":\"1722481fbebd15aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/schema.js\":\"eef57e2b4f364a90\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadBlockDates.js\":\"f8868f6806d5bf2b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadDatesAction.js\":\"009e10a7693d47ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/today.js\":\"48b25eb9f1b0b805\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f230fbd77367a12e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"481732b6f94eb558\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/audit.js\":\"cf7af268d198f7dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditAction.js\":\"a627591618a55549\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditRanges.js\":\"f91ed674f8d50d07\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/diagnosticsSource.js\":\"b1cdc08f48071c82\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/divergenceScan.js\":\"2c56c2b0750b4a34\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/index.js\":\"dd41d7241d859cff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6d0fa3c07f4d3277\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/referencesMirror.js\":\"71048995368315bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/rowJson.js\":\"18d1cb4008fc677f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/schedule.js\":\"1ba93162a66d8c77\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/store.js\":\"85a598fb390958fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/action.js\":\"95fcee1689d83165\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/index.js\":\"278f69daf3fdacf2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/plugin.js\":\"841fef41a5cfb39a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2d2bcf3fbcde6af8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/actions.js\":\"225e3c559f6f55f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/changeMarker.js\":\"2b75509c26155351\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/diagnostics.js\":\"21c77ad608b2252f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/fileSystemAccess.js\":\"f6be04adb2f25e06\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/filenames.js\":\"6738b190ca799304\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/index.js\":\"61a5eb1492aaaf09\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/mirror.js\":\"b2011d126c050105\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runLock.js\":\"5b23ce24f7153b88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runtimeHealth.js\":\"188c7fe8ba7f295e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/schedule.js\":\"267702b166fa3b71\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/store.js\":\"b5218c92f64c5a36\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/index.js\":\"00940b4216e68b9c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/themes.js\":\"6fa3f886c884e689\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/facet.js\":\"5db4022d950f1b29\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/useDiagnostics.js\":\"65212f64d2302bf1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/dismissals.js\":\"afc272ca3ca47092\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/index.js\":\"8bca91b960d31fd0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/status.js\":\"04119506df37c3f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/store.js\":\"69b202e8097dbd38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"bbf0828475e5835e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d07163f7d970b621\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/actions.js\":\"838ba0b94e74851a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/config.js\":\"f817c565edbbd42c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/dataExtension.js\":\"e8166e947eacaf70\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/effect.js\":\"c7ea26f3b45efea0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/index.js\":\"2791a0154d2f7a83\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0169e177d0eef161\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/useToggleTree.js\":\"fdc1c80a8f953ded\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/ExtractTypeDialog.js\":\"8f837f9c171812aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"049aa2980e4dcb6e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/PropertyShapePicker.js\":\"59511d8c0a51ba91\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/action.js\":\"35ad6cc62275013e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/index.js\":\"8a3f5542779f8139\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/FindReplaceDialog.js\":\"1a61c2d816f775d0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/HeaderItem.js\":\"1b847faf1b6afdae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/dataExtension.js\":\"3b83feea8d3615f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/index.js\":\"a6a4fa5546e93212\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/search.js\":\"c74d1aaa38ce6bf8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/toggleStore.js\":\"53607fce0dbaf08a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/LocationPropertyEditor.js\":\"c1b4509a1ec58f2c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/MapView.js\":\"1a4b849bb2e041ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/blockTypes.js\":\"93e47c4b077b288c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/codeMirrorExtensions.js\":\"a45e1d953e07f5c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/createOrFindPlace.js\":\"b5a0470d09af70db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/currentLocation.js\":\"47e026cc6566e933\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/dataExtension.js\":\"dfa59dc0e1588a93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/geoContentDecorator.js\":\"a3c2a177d0fa4664\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/googlePlacesClient.js\":\"4cfd46a2e0b03002\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/index.js\":\"a8fb6a524466ef33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/locationsPage.js\":\"c92619b994e0d36a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/mapViewport.js\":\"c0961a765ad3d67f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/pickCurrentLocation.js\":\"2c69bf7898b2c90f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeAutocomplete.js\":\"b5911fc847118e76\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeNameCollision.js\":\"fb910bddfa289775\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/properties.js\":\"f28a52b3445a2d5a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/propertyEditorOverrides.js\":\"12f1539e56258ad6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/query.js\":\"70822a441181050c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/usePlaceSearch.js\":\"b3b71a0ba1b7b75c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2d4bf12afe9ffced\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"329d063b6a67a325\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a5e57a92483d0211\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/config.js\":\"d71cbf802d54f609\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/dataExtension.js\":\"b73c0d0211a8cc8b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/facet.js\":\"96a1f0d4745252dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/grouping.js\":\"50b464fe70817dc6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/index.js\":\"8525da5a28137a95\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"267e92e1dc2fec4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/query.js\":\"e7fa0262d6f69cdb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/resolveConfig.js\":\"e33934525a078c3c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"19dac261564785a2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ea4ae52ff9df16c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlDocumentContent.js\":\"eab7ec30c65ea0d7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlFrame.js\":\"8b41ad7734ea6f37\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/actions.js\":\"6ea37eddb8b00847\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/blockType.js\":\"a33800c2b21486d3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/confirmRunScripts.js\":\"73c9ed8369aab8cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/dataExtension.js\":\"8a19df0918b0bb97\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameAnnotations.js\":\"93893e69c712a550\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameDocument.js\":\"aebb3227fa0e19f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameTheme.js\":\"d966a5649a02d952\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/index.js\":\"485e9328d8346d43\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/scriptConsent.js\":\"13ec430256ef02a5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/sourceMap.js\":\"4d70aaed4ae778d6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/useDocumentScripts.js\":\"84f5fbb140bc8963\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/index.js\":\"6ebcc8f13d85034e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/record.js\":\"69a0bf43d1eddbc7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/recordStore.js\":\"3d7a63f622ce039e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/responsiveness.js\":\"942c65889f4ea6e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/schedule.js\":\"842c476068f16dac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/sessionContext.js\":\"649317279d1efff7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fac612d9ef72bb51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"74cabdbb1c086f38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/actions.js\":\"3c7d3c29c25db11b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/config.js\":\"020f873f38cd27f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/dataExtension.js\":\"db1f99cd5a0a8dcd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/effect.js\":\"64fb30d761352c5f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/index.js\":\"3b3680b808396470\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/keyCapture.js\":\"92423736174e7046\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/overrideStore.js\":\"c26147776add0797\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c6f2c8fec09c1249\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/HeaderItem.js\":\"e604b411358eddf2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/LeftSidebar.js\":\"54176859d52a739d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/actions.js\":\"b45b8bf52e6e14d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/facet.js\":\"84df5eecf9702c33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/index.js\":\"edd1be0020fed9e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/shortcuts.js\":\"ac87b7442c10c37e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/toggleStore.js\":\"3fd0cc30bf170678\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/MergePicker.js\":\"f6c0c0096c0ee64c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/index.js\":\"48f6bc4765d17d28\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/mergeAction.js\":\"a4276a8c3f22577f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/strategy.js\":\"9977c81f79f4ab55\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/Button.js\":\"128a2318ab80b43c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"607874958085b593\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/defaultItems.js\":\"18b24b414c8ee490\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/facet.js\":\"95baed0308a28c98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/index.js\":\"badf7b4b73eba083\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"114b6b91155a808c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7be6b7179b83cb0a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e0e987956ef14678\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/facet.js\":\"56a3f1f8b9208632\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/index.js\":\"8b9f1174bba2c5d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/MoveDestinationPicker.js\":\"44c5ad936e569316\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e596ef8607e83870\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/contextMenuItem.js\":\"776cd788fc9eedd0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/index.js\":\"3761558a22dd0020\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveAction.js\":\"ebf4d0f17fc034ca\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveBlocks.js\":\"c16971d5c94f1fd6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/selectionAfterMove.js\":\"a5451ff577206d0d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/TutorialBanner.js\":\"6901093a8cd87998\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/action.js\":\"428db0171a848681\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/bannerDismissal.js\":\"77c8bfc9725a06e3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/documents/cheatSheet.js\":\"aa0015e011e8cec8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/index.js\":\"cb18651653851e9b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/keys.js\":\"e9bb31268635368f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/landing.js\":\"788597678eeb6010\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/outline.js\":\"5617dca5ae3479dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/seed.js\":\"de6287b0b1d35904\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6dacae20c8d36459\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/analyze.js\":\"a71cac05ddef88a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/diagnosticsSource.js\":\"8bf34fcd224b0f9a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/index.js\":\"571e13e2e05dad9a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/load.js\":\"c9bf6278cc0b3f20\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/monitorRun.js\":\"f2f8ad930e3713ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/schedule.js\":\"5fc147902eb32bbe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/series.js\":\"7d48625c4f1566ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/store.js\":\"7315398456e34f1c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/trendAction.js\":\"9d78996d140a5ff0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/verdict.js\":\"d2b4773aad727f52\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/clickToEditAction.js\":\"7cea8f91e7923a67\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/index.js\":\"1457d31cc5883c75\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/interactions.js\":\"994bdfdf4814bbaa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"57fcc1de697b260e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGate.js\":\"31c3558f8829e1fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGateDialog.js\":\"8a8075c126374983\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/action.js\":\"2166894a92a17edc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/index.js\":\"f83a9486ed17eb38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/localRunMessage.js\":\"6bdbb54c43178615\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/plugin.js\":\"65b020e856ea002f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/progressReport.js\":\"d3f1af32530b0daa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/sweepProgress.js\":\"be20261fc64062e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/FieldRowRenderer.js\":\"c0ea723c3c6ad887\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/ValueRowRenderer.js\":\"e92faba0cb32ca46\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/actions.js\":\"01ec05cf5c4fe40c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/autocomplete.js\":\"23de5966f97d8bb0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/fieldRow.js\":\"3374c000a6423547\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/index.js\":\"f759facc47c5f688\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/referenceWarning.js\":\"09232226460539df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueAutocomplete.js\":\"00a09d0cce0edac2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueSchema.js\":\"4df6d16f1fdcc15d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/HeaderItem.js\":\"605a24b9e9b6cd79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/QuickFind.js\":\"ce8c9332e3a35d31\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/index.js\":\"bfedecba024cdc63\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/recents.js\":\"c82de9fc980363fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/resultItems.js\":\"62bbe47c7c0b0ae6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/selection.js\":\"74bec2e63f9f12c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/toggleStore.js\":\"81752cc61f2b5beb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/HeaderItem.js\":\"e6d54619d885145e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ce2b28f04bf51448\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/grouping.js\":\"18a2d0fe31b4dcee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/index.js\":\"6b94b4fd9e2c5dc9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/target.js\":\"ddc593363a477f31\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/codeMirrorExtensions.js\":\"55190ef5a7476051\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/contentPrefill.js\":\"539e1d43d6ae4cb4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/dataExtension.js\":\"1fdaaf29ce603e2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/index.js\":\"f16dc06f1afacdf7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a4f43362bd9535ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/invalidation.js\":\"137a1f7794250747\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/localSchema.js\":\"17dfe881dd954d0a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/index.js\":\"037ec6a67aa66601\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"33b421ea8ef4979a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/index.js\":\"a7e5e20e3add521e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/referenceNode.js\":\"2854c7a440e9938d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b9195801d28e0531\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"170d41ef0afb4075\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/index.js\":\"511823fd5a053768\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7e12687f6f01a90c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8e68905893603d55\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/mergeRetargetProcessor.js\":\"65877c330027bda1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/parseFence.js\":\"6f89b015e622cdd7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceParser.js\":\"446ca00ddbdcdef6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceProjection.js\":\"ff1bfe2a0c27e782\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referencesProcessor.js\":\"1a0769c0cbc37ff9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/renameProcessor.js\":\"645c2db5dbdaaa46\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/spanReplacement.js\":\"0391af725dec22b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/htmlToOutline.js\":\"41c3b259c8ff19ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/index.js\":\"de088907a12027da\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/normalizeClipboardDom.js\":\"33cc6f2562d0e8dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/pasteDecision.js\":\"a67545ee1007a7ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/action.js\":\"dc203fc25bebbff4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/blockIds.js\":\"05737de995a379c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/content.js\":\"5e818cd0d2212391\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/effect.js\":\"92ba111bfb8175fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/ids.js\":\"fe8e2095868b44ca\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/import.js\":\"cb71156c8563037a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/index.js\":\"b407e4832acb1bed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plan.js\":\"50f8aa1e99dcb645\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plugin.js\":\"583043c1a51e8865\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/promotion.js\":\"495ee0e960050f57\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/properties.js\":\"ab033a482da12781\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/references.js\":\"1380f87a9a181cd1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/report.js\":\"eac97bcd6052995e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/roamMemo.js\":\"1e736e1e6959ccda\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/runtime.js\":\"952d62f69d2cdb30\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/schemaReconciliation.js\":\"6d946a52c3266f87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/srsMarkers.js\":\"e18264ae2ea85f4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/todo.js\":\"dc70a6e74e0533c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/typeCandidates.js\":\"a52019c356645ab3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/types.js\":\"60f5aee6cb412f75\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/index.js\":\"836b4e4ccc0b477c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/store.js\":\"f8797635d7a52ddb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/HeaderItem.js\":\"a37e68e158343c10\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"769c44094caca3b4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/index.js\":\"3118477b96c492b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/model.js\":\"4d344d2ed3eddaa4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/toggleStore.js\":\"69b1ef8ab4bfa2a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/useKeyInspector.js\":\"a25a8749e54eaa56\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"709fd84814d4e751\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/ShellDecorator.js\":\"bad24ee62d23cc0a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/actions.js\":\"ffb24849c21a3574\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3cc24be66216f64d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/index.js\":\"4025163609e398a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/shell.js\":\"fc2d6e9b5e532dd4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/surface.js\":\"a6492ddc29537ba3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/walker.js\":\"87f8c0624013a2d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c788099571d1e1fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/dataExtension.js\":\"f263fb82a8b7e6fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/index.js\":\"1c8f0125ebf72713\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/indicator.js\":\"37139465183ef52e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/moveSrsState.js\":\"e3f8e86167add479\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"44e6d0ba173f7007\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/scheduler.js\":\"4d4ce358c1c29190\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/schema.js\":\"e41287ed76b2e51e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b30956c5730fd6b0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsClipboard.js\":\"347966e419f16eca\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"14aff13103ed36cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DailyNoteReviewHint.js\":\"faa8f5580080e133\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DeckPicker.js\":\"9c00ea91e4d3977e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewControls.js\":\"da4feaed0d422cb9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewDeckRenderer.js\":\"cfc9c16c9c825edd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewSession.js\":\"fccf0cb8160f0ad6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/actions.js\":\"bc9b41b95a2086a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/archive.js\":\"6dea6ada3d281bb1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dataExtension.js\":\"e438e389fc95215f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/deck.js\":\"bce6ab83ac6eeba6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dueQuery.js\":\"e5ee703b5f60f573\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/gradeDecision.js\":\"fb3a3078583bb646\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/index.js\":\"5ff88f1ea1fc10f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/keyHints.js\":\"01aa6b90f479c108\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewCardLayout.js\":\"1f0102712578c2c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewProgress.js\":\"e3660c5ed496ec78\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/schema.js\":\"7239221698990610\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/useDueCards.js\":\"4921a5639980ad94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/index.js\":\"47af74cbd4f25f38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/record.js\":\"41ae7c1a578ce5c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/index.js\":\"ff58f77b82a89406\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/persistenceStatus.js\":\"5ad95c56a8d3188a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/requestAction.js\":\"fc429633b8beb10c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/TypeChipsDecorator.js\":\"182be10cf203c0db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/codeMirrorExtensions.js\":\"70f03baf18ec6536\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/index.js\":\"5484d52485ac5d71\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/typeAutocomplete.js\":\"f6864f599d391c19\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1750e8131625bb24\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/actions.js\":\"c3ae57ce37afa466\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/anchor.js\":\"1f8502d28644cbec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/events.js\":\"93b5f96c5e3a5421\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/gestureActions.js\":\"c172667a4d07ffb3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/index.js\":\"37a610504b1b6909\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0bb20efe90276c12\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/collect.js\":\"2cf3bf172356a837\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/index.js\":\"83dca5c4effc6c2d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/record.js\":\"4099995412433553\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/RejectionDialog.js\":\"ef31627c1f353f57\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1b23c6c0875227fd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/index.js\":\"5f7af20803c6f38e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/model.js\":\"0d7957ba45782f2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/queueCounts.js\":\"97b8713812e361ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rejectedHelpers.js\":\"65e17a93021852ae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rematerializeAction.js\":\"cb26c44fcb0b6935\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/useHysteresis.js\":\"cb9f533ed4a71c95\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/ColumnHeaders.js\":\"ccb870a844ae3871\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/QueryUi.js\":\"963fe151d78358f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/TableLayout.js\":\"bf8310458a71d275\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/actions.js\":\"bf507dc9acc21223\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/cellEdits.js\":\"85519d448717b227\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/columns.js\":\"7819d10659365f28\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/controller.js\":\"c1a331ec75d772eb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/convert.js\":\"e0eb6b177230d6e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/dataExtension.js\":\"3f9b09b66b283851\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/index.js\":\"789880851dd93258\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/keys.js\":\"8575bd7637ac40f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/model.js\":\"4e1230341c1f2bdf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/backfill.js\":\"8360822d28e24d96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/format.js\":\"e7ac91888c71286a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/parse.js\":\"9a7a1e477935e31c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/queryValue.js\":\"8585b13168fdafb0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/source.js\":\"b08f0640c4edffdd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/registry.js\":\"1ffb878951c5ad1e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/schema.js\":\"8350ee2e3f3b5b38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/sort.js\":\"3cbc495798ad75ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/effect.js\":\"272999cac4455910\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/index.js\":\"d599f672fcdba1dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/theme.js\":\"aca703d075b17b84\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/actions.js\":\"723ec928edab8bc1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/dataExtension.js\":\"672d203d2bec3391\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/index.js\":\"beaa9c2d64c18340\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/schema.js\":\"44503b70928e3313\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/TouchSelectionLayer.js\":\"de9365a3f8014fd7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/actions.js\":\"e7eaa3c83794a0d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/defaultItems.js\":\"290cdbee8a0e6983\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/facet.js\":\"15ffca963d60ff94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/holdRecognizer.js\":\"f344d9b1689d8a4d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/index.js\":\"f285cdcbc0f2c55d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/UpdateIndicator.js\":\"1e81952441568a4a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/index.js\":\"732f6585b6ac0da3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/loadTimes.js\":\"7c451e5ff3b836df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoNotesRenderer.js\":\"103cdf8c8aad970c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoPlayerRenderer.js\":\"93fb0e5dc7444b72\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoTimeStamp.js\":\"211b85a4957397c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/actions.js\":\"7b4cf946a4f91e3d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/index.js\":\"2647a06bc33672c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/markdown.js\":\"c535813f8592ef2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/notes.js\":\"5a2f1d7ccd57c71a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/registry.js\":\"3fdb712c27a2d72c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/remark-timestamps.js\":\"28486d6328467f54\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/view.js\":\"e76ac031f57df1e7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/LinkHints.js\":\"88e889f2c1717d2f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/index.js\":\"30862388e448cfe3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/model.js\":\"d6b56d3a787289ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/settings.js\":\"6c658049c67330d6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/actions.js\":\"5020f91aac2b441b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/index.js\":\"d5e2c03e33d07675\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/interactions.js\":\"e7d48a6958a41b0c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/workspace-header/index.js\":\"9876150907fbb1b9\",\"/knowledge-medium/pr-preview/pr-1844/src/registerServiceWorker.js\":\"9a548a0f95e69041\",\"/knowledge-medium/pr-preview/pr-1844/src/requestPersistentStorage.js\":\"6abc323a596e637b\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authRequestDeadline.js\":\"f0eca26bc4abb856\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authStorage.js\":\"231cb4af65b77c20\",\"/knowledge-medium/pr-preview/pr-1844/src/services/powersync.js\":\"ced2a2729013b98a\",\"/knowledge-medium/pr-preview/pr-1844/src/services/supabase.js\":\"e1487c9a5964bdef\",\"/knowledge-medium/pr-preview/pr-1844/src/services/uploadErrorClassifier.js\":\"543deb8eb63ef152\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/ActiveContexts.js\":\"c6291b70354bb086\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/HotkeyReconciler.js\":\"a372b47b09de0df9\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/WipeLocalDataDialog.js\":\"1373db577c4ec2d7\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionDispatch.js\":\"25130d509f672507\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionRefItems.js\":\"2efac5974c79761a\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/applyKeybindingOverrides.js\":\"8db4bb5f7a671cc3\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/blockActions.js\":\"b949be1c33c963eb\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/canonicalizeChord.js\":\"6d77f08f0bb90683\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultContexts.js\":\"c6994f37491b0f35\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultShortcuts.js\":\"33c92f16f80ae3ef\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/effectiveActions.js\":\"4fd21914bbaa2c25\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureAction.js\":\"cdff25aa36722766\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureBinding.js\":\"6e1a0f1f8f588cfb\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/holdRegistry.js\":\"bc0e632503e580fa\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingConflicts.js\":\"11bd72406f0b40a5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingOverrides.js\":\"a286d3ce594d1f7d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/pointerAction.js\":\"747e0d0d2b9af0d6\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/resolve.js\":\"26a4a77b53807717\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/runAction.js\":\"f231cd731c363af2\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/sequenceMatcher.js\":\"997f2ed9eb5ba5d3\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/types.js\":\"cd327cd836b15f33\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionContext.js\":\"dae55a3278af22cd\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionDiscovery.js\":\"f0ada76b7958ad21\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/utils.js\":\"c66af27e204bd1ba\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/bootStore.js\":\"b86c16b9719280ba\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/previewDatabases.js\":\"f857cef534775e29\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/byteTransform.js\":\"0388739bc8b6a274\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/attachmentCleaner.js\":\"7e50ef9e262c23fd\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/attachmentParts.js\":\"cb1bc65696418f16\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleParts.js\":\"7f6132e97fde6f22\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleRecord.js\":\"d52097a6a682d5a5\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/manifest.js\":\"50a4ab9822ff1af6\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/takeBundle.js\":\"e185455fe4de27b1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/verifyBundle.js\":\"2b0a6a55a7df0d67\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/cleaningStage.js\":\"d5fe19dd5569e457\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionKey.js\":\"295181dde6c4a778\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionServer.js\":\"a459901c9246a29b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flip.js\":\"742865fdb98c164e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flipAttempts.js\":\"f69a59e7ebf23b54\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/pages.js\":\"2bffdf8b8e4562eb\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/preflight.js\":\"ff670ebfc93bd271\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/reseal.js\":\"1f2d21ffb8fa4372\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runConversion.js\":\"b52efddb38f9b76d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runLock.js\":\"e51525be4b8547d0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealing.js\":\"70cea8a4222a4c6c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealingStage.js\":\"9aeae13718681232\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/stage.js\":\"f15145089b67c71d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/verifyReseal.js\":\"81648e5c674e65d3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aad.js\":\"16987f203657db87\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aead.js\":\"24d3ff66622a1479\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base32.js\":\"65408c389c3a01e0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base64url.js\":\"3c8d158c5b6b3cfa\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/binaryEnvelope.js\":\"594a4a7f8e7ab2c7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/byteAead.js\":\"038d9f19f4e8fafa\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/canary.js\":\"204d237500962fec\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentHash.js\":\"825643c5f2741e1a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentKey.js\":\"1f126a1560c39cb1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/derivedIdNamespace.js\":\"d817534e179a3d08\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/envelope.js\":\"c46ac99de8da2585\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/hex.js\":\"71a28d1cf6bcd7d7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/sha256Hex.js\":\"b58dd416e5ca6ad0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/workspaceKey.js\":\"ecc8c8a275aa62e8\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/conversionState.js\":\"cafaca4d5274b9c8\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ab513d5482d1fdcf\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/pastedKey.js\":\"375422bcc0a3e6cb\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"02d5b144fdce4b3f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2f18602fbbbc608e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/keyStore.js\":\"8fc265a994e04422\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/mintWorkspaceKey.js\":\"6b416fba8f2dc040\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/modePin.js\":\"d5657238d92885cc\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/openWorkspaceKeys.js\":\"48b2bb012ecb8109\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolveWorkspaceEntry.js\":\"b53f12e1cbba6ee9\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolver.js\":\"4fb66d090d87d40b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/workspaceAccess.js\":\"5f7d7c2f74c7f353\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/transform.js\":\"c0610ee59a16153e\",\"/knowledge-medium/pr-preview/pr-1844/src/themeBootDefaults.js\":\"62518616d5e0781f\",\"/knowledge-medium/pr-preview/pr-1844/src/types.js\":\"b37ed67cc3ea4f5f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/ClientLocalSettings.js\":\"301a79ed487e42b1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/abortableSleep.js\":\"68e07dee30dddab7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/array.js\":\"17ca8a81210f33ac\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/backlinkAutocomplete.js\":\"bf8f2d0f6ccfe7ec\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockCrumbs.js\":\"d9567b773a687f5b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockrefAutocomplete.js\":\"9d518e0cfb93f8d1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/cadencedIdleJob.js\":\"a1a912eb2122dd3c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/callbackSet.js\":\"4f8e4611997eefaf\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/clientId.js\":\"fffc36bdc032c56e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirror.js\":\"3509f1a3af40dd64\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirrorCompletion.js\":\"8d49fd6b0cde051e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/copy.js\":\"e4dab8b585a624fb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dailyPage.js\":\"9baf10337548cd45\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensics.js\":\"d840affc9f823d8c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensicsHooks.js\":\"720d5e6590a81cbf\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/deleteBlockThroughUi.js\":\"82d4b0141a6e24f0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dialogs.js\":\"8a5599bb65c97672\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dom.js\":\"109a5797e6cbb74f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/downloadBlob.js\":\"01d09d805b1ba34a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/exportSqliteDb.js\":\"934d8e4b6988895f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fileSystemAccess.js\":\"71799ed2e7fd4a25\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/flipSlide.js\":\"b5e53e6a6cf06df7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fnv1a.js\":\"55defa7f95d9bd22\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/formatBytes.js\":\"dbdd55c6872fa3df\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fuzzyRank.js\":\"eeb72173997e30a0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idbKeyedStore.js\":\"e176892bd1fc5fe9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idleCallbackPolyfill.js\":\"27be890418409080\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardAwareScroll.js\":\"8a55eff799d1b584\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardViewport.js\":\"b876a616d99f7257\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/lastWorkspace.js\":\"cc7bf74e1b39a4d4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutColumns.js\":\"a137451130e95203\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionDom.js\":\"bfac58a420a996de\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionId.js\":\"87ddf5205b0abc1a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkClickGestures.js\":\"c8142002e49f9f97\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkTargetAutocomplete.js\":\"2e770dcc1fadc179\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbCorruption.js\":\"224bd0e4a927584d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbRecovery.js\":\"a0e1d66a1a99992a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/markdownParser.js\":\"c38d78469e0d21eb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/memoize.js\":\"65e2addbb4d234a0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameFieldCommit.js\":\"3789839d3877b171\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameList.js\":\"3e1f900f471da495\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/navigation.js\":\"97d600017597fc02\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/omnilinerNamespace.js\":\"ccc572d5ccbdc180\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/opfsPageScan.js\":\"96f221c4cbe6afb2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelClearance.js\":\"560a0b010bceacee\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelHistory.js\":\"a23dd9f34aae3d89\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLanes.js\":\"9a48e8d5ae46c4af\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLayoutProjection.js\":\"3f139aa25e1ea13e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelScrollAnchor.js\":\"b50d9c7d763dc703\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelUrlFlags.js\":\"8b6684159ef8128a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/platform.js\":\"590f1c892770658e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/pluralize.js\":\"c6ff64c4c9a6cd7b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyCreation.js\":\"2a8ce4713ab8bce9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyNavigation.js\":\"1998e0b891328881\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyValueContext.js\":\"3374e6b1091dec9c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/react.js\":\"0ce9b9a5d628929f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeDate.js\":\"c09092fc2cb49dcb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeTime.js\":\"a62da983c6b833f1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/renderScope.js\":\"31e044ceaac6559f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/resolvedThenable.js\":\"f7a5651a23fe80b8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/routing.js\":\"5c869cba3dabb412\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/safeMode.js\":\"96fbb8582a2dc32f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/scheduleIdle.js\":\"9eaa387a56977355\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/screenWakeLock.js\":\"cb0eec1d19edf0fe\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/selection.js\":\"b366ba644e75bfa1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/softKeyboardGrab.js\":\"3fd902f67c56cdb0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/startupTimeline.js\":\"e0a26c356790e9fe\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/state.js\":\"37791f22f17bf91a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/string.js\":\"05140e6a35c58cdc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/surfaceZoom.js\":\"5e0252c839519529\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/time.js\":\"e81d31d5476afad7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toast.js\":\"e8a2ec418afab7f7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toggleStore.js\":\"ca9ebbe52a251cd1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/untilStopped.js\":\"371c05d92533caf3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/userActivity.js\":\"259108b1b965faa4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewTransition.js\":\"9311572294de936f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewport.js\":\"59f0cc6d64f0eeb3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/webLock.js\":\"cfbe5a992ba4008b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceRecovery.js\":\"41d68d7b35c1d753\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceSnapshotStore.js\":\"9fa2632e87e830d3\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-compiler-runtime.js\":\"5cc96ac4585eec3d\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-client.js\":\"990b3036811e11ed\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server-edge.js\":\"8456221c788f33ab\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server.js\":\"c61b7f66e208a86a\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static-edge.js\":\"5057fae09b538c80\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static.js\":\"e7519886edd33555\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-test-utils.js\":\"ec2b0783a2997b30\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom.js\":\"cb28141b6a68e5c9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-runtime.js\":\"32089192ccd8833a\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react.js\":\"a1695572faaee99f\",\"/knowledge-medium/pr-preview/pr-1844/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
