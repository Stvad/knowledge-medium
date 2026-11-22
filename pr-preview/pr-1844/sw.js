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
		buildId: "77205b0fb52e-660e497e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/\":\"485a95d3762686ac\",\"/knowledge-medium/pr-preview/pr-1844/index.html\":\"485a95d3762686ac\",\"/knowledge-medium/pr-preview/pr-1844/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1844/assets/FacadeVFS-CdPZJozz.js\":\"95dbbe99d24a85e0\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSCoopSyncVFS-DX-4dq8o.js\":\"f61de067a0052a45\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSWriteAheadVFS-BhUDl6pR.js\":\"90c784d9a94dae31\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-BWUc3oPE.js\":\"dbf8f5c7e4fa691a\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-ikNcdICK.js\":\"13bb89deac0b406f\",\"/knowledge-medium/pr-preview/pr-1844/assets/worker-BeKqn80T.js\":\"95f1ed473eb16e98\",\"/knowledge-medium/pr-preview/pr-1844/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1844/chunks/app-CUkDBXnm.js\":\"8963d2dfe694a2b9\",\"/knowledge-medium/pr-preview/pr-1844/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1844/index.js\":\"7b7471a4f3948dfb\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1844/assets/AccessHandlePoolVFS-A3-OAZnf.js\":\"3594d17686c4670e\",\"/knowledge-medium/pr-preview/pr-1844/assets/IDBBatchAtomicVFS-C6xEtJtD.js\":\"cc1fadd6cbcadeab\",\"/knowledge-medium/pr-preview/pr-1844/assets/MemoryVFS-DVo-dTJ4.js\":\"d8f85a52506fe0b2\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-SUWAzvyQ.js\":\"abf42bf3002268da\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-5cmjl-J3.js\":\"00adf704c198e3ef\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1844/chunks/AccessHandlePoolVFS-BisIa8Qt.js\":\"30429a01e94b8d71\",\"/knowledge-medium/pr-preview/pr-1844/chunks/FacadeVFS-B-7eZx3K.js\":\"634bfa6258852686\",\"/knowledge-medium/pr-preview/pr-1844/chunks/IDBBatchAtomicVFS-Cq_GIWxA.js\":\"2521332daf799c3e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/MemoryVFS-nXTkWuKw.js\":\"648d7e2d143f1149\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSCoopSyncVFS-VFTUhWlO.js\":\"9e893482a8894ae8\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSWriteAheadVFS-BMR3kj06.js\":\"b31793df1d20a7df\",\"/knowledge-medium/pr-preview/pr-1844/chunks/Preview-C_qRljfk.js\":\"28c9389291c92e52\",\"/knowledge-medium/pr-preview/pr-1844/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/card-DrFXdMcJ.js\":\"b6b918b75cbd34bc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-DhIQPEjY.js\":\"fda8a95b0a27b954\",\"/knowledge-medium/pr-preview/pr-1844/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-CnUpQEJl.js\":\"21a79808d9b496a7\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-async-CvGrzZ_c.js\":\"9692696160d7f73c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-7xQg-NFl.js\":\"4fcce7bdd6fa98fa\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-CqgrBMUd.js\":\"fdf8448c99c53332\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-Crzc98ll.js\":\"9d3ec375368c5ef7\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-CwAuDMTG.js\":\"b62a6774ad43a71c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-D3_p5lPY.js\":\"50787f31f10ddcb8\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DwTRlEBZ.js\":\"677f433177ee7400\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-Dwpyg63y.js\":\"9d3aec4af08147e6\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-XXF6U5tb.js\":\"1f668d4cd51f6884\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server-legacy.browser.production-1y_nrj8H.js\":\"2e8dbae9fb1db64b\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.browser.production-B0ud4pQq.js\":\"350bd4ffcdb99cb3\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.edge.production-pgDjhmmW.js\":\"22e736c89c40c12a\",\"/knowledge-medium/pr-preview/pr-1844/chunks/server.browser-BSL-VLUd.js\":\"6b73ae90d2d34baa\",\"/knowledge-medium/pr-preview/pr-1844/chunks/textarea-C38SkvIk.js\":\"a2a916d3c455771c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/ui-C569R0nf.js\":\"fbe95337c9ad47aa\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-BvEzlTnI.js\":\"5393f551905b546c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-async-Xadwtb4r.js\":\"bafc79d117cd8e66\",\"/knowledge-medium/pr-preview/pr-1844/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1844/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/src/App.js\":\"a068f455d50758d3\",\"/knowledge-medium/pr-preview/pr-1844/src/appUpdate.js\":\"ac86b476cb299a6a\",\"/knowledge-medium/pr-preview/pr-1844/src/appVersion.js\":\"521d64f7a204e068\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/initialLayout.js\":\"1b4462ee82fad411\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/openWorkspaceData.js\":\"1ec8885be39d1d45\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/resolveWorkspace.js\":\"db2c7aeb33fdd678\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/workspaceBootstrap.js\":\"b1ba03faca0ca8d3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockComponent.js\":\"6d82e74847f73f95\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockCrumbs.js\":\"2f4d45e4aa288b20\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockEditor.js\":\"1da503d356c8c5f6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockLoadingPlaceholder.js\":\"a70d26513ec1f697\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockProperties.js\":\"9f93383c3d17001f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockSearchPicker.js\":\"d11b2145a13a9a6b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ConfirmBulkDeleteDialog.js\":\"1ae9def4077e1380\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DividerHandle.js\":\"cf104a9a21040001\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DraftEditor.js\":\"1e25912ef07b2a8f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/GutterPill.js\":\"88e1b87b66b7ac74\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Header.js\":\"6f78626bc071f4dc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/LazyBlockComponent.js\":\"16cf8831dba99ebf\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Login.js\":\"8809dc09a185d1d8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ZoomableSurface.js\":\"fb08149e6dd29728\",\"/knowledge-medium/pr-preview/pr-1844/src/components/editModeKeepalive.js\":\"e7b3c2b6d4700c83\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8c0c223baf98bcbd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d2e2e30863f7f4c6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefPropertyEditor.js\":\"1400a2a010520cc3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefTargetTypePicker.js\":\"37b123295e126310\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/SelectPropertyEditor.js\":\"a582d63634868dbb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/TypesPropertyEditor.js\":\"5f898c3a0bd01865\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/defaults.js\":\"2ffd6c4229af8f10\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/kernelValuePresets.js\":\"b0461c418432e85d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/selectablePresets.js\":\"b4ad578ba6f97014\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/typesPropertyUi.js\":\"5dbb4277127724b0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/AddPropertyForm.js\":\"9d38ad4961177812\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyPicker.js\":\"0e501f6f1247c29b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyRow.js\":\"f03796fc98ca51ae\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/Rows.js\":\"7e5dc83ffdd5c262\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/actions.js\":\"78041ca9a280474b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/declarationOnly.js\":\"e50654c651a89ead\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/layout.js\":\"3a5eaed3a40807f6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/model.js\":\"7abf790f4203c149\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapeUi.js\":\"30354b32bc22fdad\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapes.js\":\"160b3e8b5adc08b7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/usePropertyEditingActivation.js\":\"01ea03c61e7119e4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/visibility.js\":\"4ede8ca49feee0c6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanelSections.js\":\"64cf8315bae0d089\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockEmbed.js\":\"35b8d196c666dbb5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockLink.js\":\"2093bfce5c60c062\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockRef.js\":\"240dcec3cfe8ca42\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/ReferenceLink.js\":\"04202bc934450c53\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuard.js\":\"6783b34dc92ddab4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuardContext.js\":\"628f730d9fb7646c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/linkInteraction.js\":\"ba7f75044d82e958\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/referenceLayout.js\":\"4278d4677c6648c0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/useBlockRefAncestors.js\":\"e56fd1074b305c39\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockGutter.js\":\"561a87c7a5913e00\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockInfoDialog.js\":\"f860d45ea85764db\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockTypeBlockRenderer.js\":\"eb7253ada80bc75d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BulletHoverCard.js\":\"04bc83d382aea19b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorContentRenderer.js\":\"3f489d8eafe7ad5d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2be7e3be8904cc45\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ColumnResizeHandles.js\":\"64300f19b8c68931\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c16d4594793ff248\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/DefaultBlockRenderer.js\":\"75409fa4b0a68ec0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/LayoutRenderer.js\":\"e455f9df7ff712f4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MarkdownContentRenderer.js\":\"51759a1bca9bc7ea\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MissingDataRenderer.js\":\"905f8ca92d8be8d1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PanelRenderer.js\":\"baec7a5c03b71602\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0164c071bc177895\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/TopLevelRenderer.js\":\"deae4d6162b3f5e6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockGutterMode.js\":\"5c953037b799d2a6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockTitleText.js\":\"c79db1d7227deb46\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/fieldCreationKeydown.js\":\"8df9447923c034d9\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/layoutRootContext.js\":\"78de5cd2d9e731ce\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/TypeChip.js\":\"7cc27a8c1b234bf5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/chipStyle.js\":\"1d769eb9113db8ce\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/anchored-floating.js\":\"deb951bf746f0b33\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/button.js\":\"a4b7a5015bb07a9a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/card.js\":\"2557c9c0a190f39e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/checkbox.js\":\"8921a0c0f29a053d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/collapsible.js\":\"85b8951453b91dc9\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/command.js\":\"d55c6c5ea7e26b96\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/context-menu.js\":\"66abcf26b06020aa\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dialog.js\":\"f6d4553eb1e48c4d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dropdown-menu.js\":\"33a238852beba8c5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/floating-listbox.js\":\"fc350bc4074415de\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/index.js\":\"b38f9f53a73ed98f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/input.js\":\"b1c0f2c6da193d64\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/kbd.js\":\"fbd8925cdb6897fb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/label.js\":\"9146b06f2bd391fe\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/textarea.js\":\"71bd92b8eba55b20\",\"/knowledge-medium/pr-preview/pr-1844/src/components/useEditModeYieldKeepalive.js\":\"f9bcb83bcac687fa\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/BootFallback.js\":\"4529de2a34701157\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/FocusedRowLazyMount.js\":\"5cc08f1f1bec4aec\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LazyViewportMount.js\":\"0c3440e63ccd2ab3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LocalDbCorruptionFallback.js\":\"fa0324cd3626d10f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/error.js\":\"e4ba8be104070a89\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/lazyMountRegistry.js\":\"496f132a8413df36\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/suspense.js\":\"e76ff46b90ac727d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/CreateWorkspaceDialog.js\":\"0ce9f1d33c46adb8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/PendingInvitations.js\":\"9c1f1bac040a2970\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/SyncProgress.js\":\"12d6018f7ea8fbe7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/UnlockProgress.js\":\"a4103fcae5c4910b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceKeyGate.js\":\"523614c3fc76b608\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSettingsDialog.js\":\"bba9d78e89d8b97e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSwitcher.js\":\"ebd1f635cc063e55\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSyncGate.js\":\"00c4ac0d3caf2e1c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlow.js\":\"22adc21290ff98e0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlowHost.js\":\"a28bf4be3de78689\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/EncryptionSection.js\":\"05478b60229278ac\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/attachmentPrompts.js\":\"e501ce7bf3afd537\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/bundleFolderPrompts.js\":\"59b05be4cac27c56\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowDeps.js\":\"c8d1c6dbb8cdc4b3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowStore.js\":\"63408577e3b14b47\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/flowUi.js\":\"c6b8f035f05d3b6b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/useConversionRun.js\":\"24046835ab00da92\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/keyUi.js\":\"1502022ee90d2f15\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnKeyLoss.js\":\"ddc7ceabd71686ea\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnServerE2ee.js\":\"d19895ec61a6f04e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/workspaceUnlocked.js\":\"deaa9900210aa714\",\"/knowledge-medium/pr-preview/pr-1844/src/context/backgroundSubtree.js\":\"bef72643e1820218\",\"/knowledge-medium/pr-preview/pr-1844/src/context/block.js\":\"77b0097852577562\",\"/knowledge-medium/pr-preview/pr-1844/src/context/layoutWsContext.js\":\"6f43efb4da0d23b1\",\"/knowledge-medium/pr-preview/pr-1844/src/context/propertyDisplay.js\":\"117d669b67abdc3a\",\"/knowledge-medium/pr-preview/pr-1844/src/context/repo.js\":\"75ff7f6451b3b4dd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasClaim.js\":\"4e57d2523d615d8e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasSeatNamespace.js\":\"3847abc2b62afb78\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockData.js\":\"a0931efc96691cab\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockType.js\":\"1a5b5a229a612efc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/changeScope.js\":\"a8c5c3eb24cbab5e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/codecs.js\":\"2bccda761c35527d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/derivedData.js\":\"2728d6e17f5c48a0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/errors.js\":\"bbb303f961a11360\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/events.js\":\"299db70abf401826\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/handle.js\":\"5164efb1b73279d0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/index.js\":\"cf54b4d14a11ea13\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/mutator.js\":\"58eddab15af46b75\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/processor.js\":\"f2ad65896e54abf8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/propertySchema.js\":\"a05f3389b3b44227\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/query.js\":\"110157219d2e83c1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/sameTxProcessor.js\":\"33f581cef2c7bab9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/schema.js\":\"5164efb1b73279d0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/tx.js\":\"5164efb1b73279d0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/typedBlockQuery.js\":\"f93797ba50cd9846\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/user.js\":\"e58e7a9f6ae879cd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresetCore.js\":\"3962da6e0d8f7f73\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresets.js\":\"a7a046be264bb16a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/attachmentCleanerIOVerb.js\":\"b0ad272e0fae844c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/block.js\":\"a7d2a49fb62496a5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockCache.js\":\"d217cb31a8d10127\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockId.js\":\"3e12c41db7c852d7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockLiveness.js\":\"3c3f1dc8b31401d4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockMerge.js\":\"45040f05fd746651\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockSchema.js\":\"7638329587034356\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypeLookup.js\":\"9bb7dff5de02640b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypes.js\":\"e74e47fc2df28c71\",\"/knowledge-medium/pr-preview/pr-1844/src/data/clientContext.js\":\"c6059cf2c1cf3b83\",\"/knowledge-medium/pr-preview/pr-1844/src/data/dbFileSiblings.js\":\"594123319432301c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/definitionSeeds.js\":\"26bc2f397011b081\",\"/knowledge-medium/pr-preview/pr-1844/src/data/derivedIds.js\":\"37fb0175c1b9d47f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/drawnSubtree.js\":\"a6fb473d80f80df2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facetBridge.js\":\"237c983573a89b9e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facets.js\":\"6f6c699c0233ddf6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/globalState.js\":\"eb49389858314060\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/aliasClaimRederiveProcessor.js\":\"bb7f059718d700b3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/ancestorBatch.js\":\"d66f3eacf79a1a7c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/blockTypeTypeifyProcessor.js\":\"8cca32af83f50b3c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/clientSchema.js\":\"d502d11fb282f605\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/commitPipeline.js\":\"65f1f61cdd41d146\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/devAssertions.js\":\"92e0a4be5a94f47e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/firstSync.js\":\"dc3b63c5a00d3a18\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/freshInitialLoad.js\":\"89eaff0626ae24a1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/graphBackfillClaim.js\":\"c13762711354a444\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/handleStore.js\":\"7b782a34242cdc14\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/idleMarkerJobs.js\":\"efb0ddbeefaa2fe6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initialDownload.js\":\"5fd328ad1ac18a72\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initializeClientDatabase.js\":\"5450046962b8f7c1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/jsonCanonical.js\":\"56205100c1adaf56\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelInvalidation.js\":\"7bed137a2b465c76\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelProcessors.js\":\"f28bb766ac142246\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelQueries.js\":\"e893bfc1ace357d7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/mergeTypeMembershipProcessor.js\":\"4c6ff4676c1c83ca\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/normalizeReferencesProcessor.js\":\"c2098cedc8cff6d2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/poolInstrumentation.js\":\"47b66dd77bf03ef8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/processorRunner.js\":\"b6a4d1f37a854875\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyCellBackfill.js\":\"dd50416a4ce46ba3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildMint.js\":\"df282e37e1f4b8cf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildrenProcessor.js\":\"8d6d0628469523c5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c39212d956ea7c07\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionSynthesis.js\":\"31b66e6e136a0fb8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyKeyScan.js\":\"fef063b90eb5a736\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertySchemaResolution.js\":\"224e6d50af5e41fd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyValueEdits.js\":\"4e45c6d089fa1ad7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/raiseProtocol.js\":\"387138777e02ceb2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/readBatch.js\":\"b9302f25248f5022\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/refProjection.js\":\"47eb489e3c828f35\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetLookups.js\":\"2862f1d2ed7a9520\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetProcessor.js\":\"45826eb19bc413a2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/replayMerge.js\":\"d2cfc418dd444099\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/sqlBinds.js\":\"20ba774a618c8b32\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"1eb126e7923a7819\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/arrivalProcessors.js\":\"9afa11e74cb7afaf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/invalidate.js\":\"3c691fcc65bcf708\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/materialize.js\":\"0bcbe442b591b824\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/observer.js\":\"ce9da93e059964f8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/reconcile.js\":\"fa908659e5c64489\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/timingMetrics.js\":\"c387ae4114e00c12\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/treeQueries.js\":\"4d6c05d12670fd16\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txEngine.js\":\"1b2a920533a28b15\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txSnapshots.js\":\"44fa2d1455e82d5c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/typedBlockQuery.js\":\"c5c5948a4b23968c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/undoManager.js\":\"24c5fce9564ca80d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/invalidation.js\":\"bef64dc8835d4127\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelDataExtension.js\":\"6d6354d23998fa87\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelPage.js\":\"6fced791e460affe\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelValuePresetCores.js\":\"6766997a3fbf68c0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbCorruptionSignal.js\":\"d7a4148aefba9df9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbStorage.js\":\"1ab279fdf77b10c8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbVfs.js\":\"f727763124c6f266\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localSchema.js\":\"5e6395425c0a652e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/maintenance.js\":\"8cd20583c22211ea\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mergeProperties.js\":\"b8d2ffeb93374d5a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/metricsConsoleHook.js\":\"df55b078ab89ce65\",\"/knowledge-medium/pr-preview/pr-1844/src/data/migrationsPage.js\":\"98f4adb552d1864c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mutators.js\":\"afa5787d924ba823\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKey.js\":\"6dd67532cb66de44\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKeyPlacement.js\":\"c1ee4c7e492c4b23\",\"/knowledge-medium/pr-preview/pr-1844/src/data/outlineSurface.js\":\"e0a17167b945924b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingEditorContent.js\":\"a280c48e09d65f96\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingUploadsSql.js\":\"d98a44004f12b25e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pluginStateExtensions.js\":\"38d52ecf666166ca\",\"/knowledge-medium/pr-preview/pr-1844/src/data/powerSyncLogger.js\":\"dd1b007a5bd3b1db\",\"/knowledge-medium/pr-preview/pr-1844/src/data/projectorRuntime.js\":\"c69f3a346e085af2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/properties.js\":\"5098e935d5885b9e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertiesPage.js\":\"36c99a138c63b542\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyChildren.js\":\"586b58ad577f6ae7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionFanout.js\":\"dce550c37362bf64\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionMetadata.js\":\"449787b2723f6749\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionRegistry.js\":\"9784311c1042e0da\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDisplayMode.js\":\"617b4209ed94dd7a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyRowCreation.js\":\"20288ea2183bd651\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySchemaCreation.js\":\"9325d932862b4a02\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySeeds.js\":\"40415f457f58fde9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/recentsPage.js\":\"93c9a5b1a85b7798\",\"/knowledge-medium/pr-preview/pr-1844/src/data/referenceBlock.js\":\"ea546846fb0d4c00\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rejectedUploads.js\":\"67ee87226af78a69\",\"/knowledge-medium/pr-preview/pr-1844/src/data/releasePowerSyncConnection.js\":\"ecdf9a0d206b3846\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repo.js\":\"5dc09a1cf6065bc4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repoProvider.js\":\"ec227ce954f50e76\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rowProperty.js\":\"57a520bf86efb9b5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/searchFilter.js\":\"826a24807ca3082e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/seedIdentityLedger.js\":\"eaa1769f8837eadb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/stateBlocks.js\":\"1417865aa02ce1dd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/structuralEditPolicy.js\":\"da9df74d66d0e06d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/subtreeDelete.js\":\"0b93aef165f8c4c1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncStreamLock.js\":\"028d66688a812e2c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableSqlRecognizer.js\":\"c13c790e90046fa5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableWriteGuard.js\":\"38f906171063332f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/targets.js\":\"b4ae243bfb693cd3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeColors.js\":\"b366096401d75f00\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionMetadata.js\":\"7e4d65b998811fd2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionRegistry.js\":\"902d67c3977e6125\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeExtraction.js\":\"f2de810e3d21ade3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeInitialValues.js\":\"e46360c15d081956\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typePropertyGroups.js\":\"41aa86cb5714484c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeSeeds.js\":\"a318b07ffe5278f7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeTagger.js\":\"df82648bf35be457\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typedRecords.js\":\"d4d8bb2d4c929363\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typesPage.js\":\"fa4488a28815a932\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userPrefs.js\":\"dab954f331bc781b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userSchemasService.js\":\"dab413b958ad5f31\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userTypesService.js\":\"ecf6070e69f33cc2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/valuePresetRegistry.js\":\"56b451358c6e159d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/visibleChildren.js\":\"b3679f209c91d644\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceConversion.js\":\"57589128f97a7ebf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceFirstSync.js\":\"c13117924c8e210e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceIdNamespace.js\":\"56d117618162d7db\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceSchema.js\":\"f3dad43809ba70ad\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaces.js\":\"ed30b3702efa38de\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadLog.js\":\"df313385217d15bc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/BlockPasteShellDecorator.js\":\"f6aab151d9e8d0a1\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/atTrigger.js\":\"c370039a98daa772\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/autocomplete.js\":\"2130f44dde9beba5\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/codeMirrorExtensions.js\":\"407fb441679ddd53\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/contentFlush.js\":\"171d7572acba8a33\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/defaultInteractions.js\":\"17fc6913bf27175c\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/editSettleSignal.js\":\"6ed5b2288437525d\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/insertImage.js\":\"812428cae16541e1\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceCompletionRange.js\":\"054564723d115907\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceTargetTypes.js\":\"47b2a5242781da80\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/syntaxContext.js\":\"82dfd0917cdb7a55\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/triggerMatch.js\":\"5b97c70b983b8d93\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/AppRuntimeProvider.js\":\"0a7d0d4231476521\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/BlockFocusShellDecorator.js\":\"63ee617f10184e23\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/ExtensionRenderBoundary.js\":\"083277fe06eaea59\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/PanelContentRecovery.js\":\"7fb97c461467e8a3\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/apiCatalog.js\":\"e673b709570b11a5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/approveExtensionHere.js\":\"90bd179b7b20425b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/armedCutAppMount.js\":\"18802be5b4719dd9\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/batchableKeyedStore.js\":\"5ba69c1a6460923f\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockInteraction.js\":\"a72a593424433950\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockSelectionAction.js\":\"793b28c46cf9b681\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compileExtensionModule.js\":\"a98e9e567c87f049\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compiledModuleCache.js\":\"8a1d9b3fa78c406c\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/continuousGestures.js\":\"3ff4e2291ac79bdc\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/core.js\":\"9c051008cd69f0bd\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/defaultRenderers.js\":\"9e6e7188f05964e5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/definitionFanoutAppMount.js\":\"e5800f856f369901\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dialogAppMount.js\":\"d7c7ba6a08078dfe\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensionSeeds.js\":\"3dc43fe70016e7e2\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensions.js\":\"008c446de879bcc8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/exampleExtensions.js\":\"d5ad4d349dce7a43\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionApprovalStatus.js\":\"059a9e6cf826595c\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrorToast.js\":\"8654c5c03d13d247\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrors.js\":\"09af8f0237b0d5a7\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLookup.js\":\"cb0bcbb08a7816a6\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionToggles.js\":\"9a9d5cb5244b59d9\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionUtilitiesCss.js\":\"ebd4b95632cf70ca\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/kernelPageDeletionGuard.js\":\"33430feac114cb40\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/liveRuntime.js\":\"33c502f812b04571\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/openExtensionsSettings.js\":\"e93b53696f076d13\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/overridesCache.js\":\"6461efe2f8736943\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/pluginIds.js\":\"8ec8c87368f99e8b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/processorRejectionToast.js\":\"db0a9eeafbdc6b0a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeActions.js\":\"005bc0fd11cfa416\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeContext.js\":\"88cd216c31bf93b5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticAppExtensions.js\":\"0dd87fec218b2100\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticDataExtensions.js\":\"7241c6a0c3920a1d\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/toastAppMount.js\":\"bb0477ad6449c28c\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useOverrides.js\":\"0569a9adfa32d7d8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useShortcutSurfaceActivations.js\":\"56d120c38ce213e0\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/discoverToggleTree.js\":\"534a3a9c8a9f0967\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/facet.js\":\"d7108604d668025e\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/resolveAppRuntime.js\":\"a42847173f197bb1\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/runtimeEvents.js\":\"6b042d6fcb997ab4\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/togglable.js\":\"82b0b3626abb1174\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/variantFacet.js\":\"f0d18be2cee1aa4c\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/verbFacet.js\":\"1f66d2186d339e8d\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/block.js\":\"b2f258907b7d80a7\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/focusedChild.js\":\"e5d58c4eecfd86ab\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/propertySchemas.js\":\"50efd368d8c87522\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/typeRegistry.js\":\"de32a8c738d8ca40\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAncestorCrumbs.js\":\"ec069ae799079963\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAutocompleteListbox.js\":\"f3a7a552b9e7cf08\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedSearch.js\":\"b9f5056956c43449\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedValue.js\":\"303dfd0983cf67f3\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsFocalRender.js\":\"a4f8c02a57b77ad4\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsReadOnly.js\":\"3cec61154eae8197\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMaterializeBacklog.js\":\"11db24fce75aa5eb\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMinuteClock.js\":\"30438434a6d9c6ed\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePanelLayoutProjection.js\":\"233c4019e7ff250d\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePendingInvitations.js\":\"258a9eef4c1cf3e4\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRendererRegistry.js\":\"8bf8e3f2560c3424\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRetainedFieldRows.js\":\"0af4ac2e601971a7\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useWorkspaces.js\":\"d18352e6d5884fe7\",\"/knowledge-medium/pr-preview/pr-1844/src/lib/utils.js\":\"b11b18d41879402a\",\"/knowledge-medium/pr-preview/pr-1844/src/main.js\":\"30b169d2e51b36d6\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/MarkdownImage.js\":\"8f83862c5e67b6eb\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/blockSeparators.js\":\"a6c9d00fd3143713\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/context.js\":\"6923081e879c8957\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/defaultMarkdownExtension.js\":\"744abe8a0c5309b9\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/extensions.js\":\"3ea7ff9b59ccb76e\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/renderMarkdownHtml.js\":\"d88c195e52700dd7\",\"/knowledge-medium/pr-preview/pr-1844/src/minimal-editor.js\":\"ca979c0b9f9b4f72\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/armedCut.js\":\"ac5d2585131502f0\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/captureMediaVerb.js\":\"52ce292973cf58a0\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/clipboard.js\":\"b6d003a4bece9055\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/decision.js\":\"cdcd9be894253fb6\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/operations.js\":\"615d798d4304d5a5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/AccountHeaderItem.js\":\"f35d6398fae6e2c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/index.js\":\"013840f6eab95c61\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c8fa6121f0110032\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askAgent.js\":\"c0f5f4f03edf8e21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askedStore.js\":\"9bc24b1677724db2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a78aa4bf151629e6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/chipState.js\":\"6988af899a599b59\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/dataExtension.js\":\"eb7e424cfa254408\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/index.js\":\"e4bd440a501719fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ec53ecae1a3aa5cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/schema.js\":\"b13c65d544a005a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b546ef4e2199c8e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d38d2b56e2273e65\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/addMedia.js\":\"0518620a1a377da3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b07cd4dd6178e976\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/block.js\":\"8702f5c2a2cbdc43\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/context.js\":\"01ade01d8a574200\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/displayIds.js\":\"540f5fb77df521d0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/index.js\":\"2f09751da33c1f17\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/outline.js\":\"2711c9f396d7c162\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/properties.js\":\"eee522dbac0e2bb5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/refs.js\":\"450ac0478d34f8b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b9e7829b1f937fd4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/search.js\":\"0d30e66d2879431b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/shared.js\":\"8f171ce96486c2bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a775986254327185\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/text.js\":\"3ee2dd4e6f1df1f2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentWrites.js\":\"485aef8cdf50d4cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/authoringCatalog.js\":\"46d7d7ab5bb3111b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/blockRefTargets.js\":\"e2472926f32b7953\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridge.js\":\"9fa981079323bdd5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridgeLoop.js\":\"cccb41ab25b69039\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/changeHistory.js\":\"a2b11fd4f6919195\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commands.js\":\"8be27add7cff817c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commentsCommands.js\":\"87b066666040564d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataExtension.js\":\"fd25b2c0881212fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataModelGuide.js\":\"4ff33742bbfeceb5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/describeRuntime.js\":\"509c3d1639abd7ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/extensionLint.js\":\"42efff5e5aa34c1f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/grainAudit.js\":\"6b150c6fdeb165bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/healthCommand.js\":\"f588ef30398bee1c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/index.js\":\"ee5ef568c19f8cc0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/presetIdentity.js\":\"b1457ac46c9766aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1005c41eacc23c9c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/readMedia.js\":\"e4b1426a401de907\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/schema.js\":\"946a1c537a96b130\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/serialization.js\":\"beaa764ff15ad55a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/targets.js\":\"c27db385e0dd538d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/tokens.js\":\"3a233bb5f85b76e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/watchEvents.js\":\"e9fbdd831c2d049b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/workspaceGuard.js\":\"70a44b7417284383\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/writeCommands.js\":\"491933fe12f9e53b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/AliasCollisionToast.js\":\"e1a26d4e21b42b44\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/DuplicateNameBanner.js\":\"171ea2dbb7ee3140\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/collisionMerge.js\":\"3ee3deb5ce75476c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/dataExtension.js\":\"3054752101558991\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/index.js\":\"bb0c7317734f5f2e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/mergeCollisionAction.js\":\"70faa8ac31f77f80\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/pageStyling.js\":\"a131f0638d62df7a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/rejectionToast.js\":\"c0aac8a224fd94dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/syncProcessor.js\":\"c7d6977d14f39cec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/actions.js\":\"7c27984ce5f5d1de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/addComment.js\":\"a85c1aa9c9bda5a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchor.js\":\"652218fd00897255\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchorState.js\":\"3cd6e04c118bb1a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/commentLinks.js\":\"889acc501761845a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/confirmThreadDeletion.js\":\"0d1a3316c6ffaeec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/container.js\":\"26d5567447f0c39e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/dataExtension.js\":\"ca1ab6628cbe8d6a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/deleteComment.js\":\"1962fba8edaadede\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/highlights.js\":\"59a7fe9bcf9e5dec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/index.js\":\"8d74f031aa59d5c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/linkedCommentsPill.js\":\"e123ee512cd96b90\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/margin.js\":\"7d08d07e0199d373\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/marginSchema.js\":\"ac864050c1d4922e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/newComment.js\":\"b0ff499d1fdd1c17\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ownThreadPicker.js\":\"c1fc6fac93f32df4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/placement.js\":\"f408434629538236\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/queries.js\":\"099bc939cc19631a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotePosition.js\":\"0d647648ca64e569\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedIn.js\":\"aff89eb260a7e98c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedRange.js\":\"baeb5da0c808345e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/rangeRefs.js\":\"1cc3be63e5a60dfa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readHighlights.js\":\"a53aba5dc7dbab33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelection.js\":\"b6c28e9ae6c9d10b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelectionUi.js\":\"cc3af48f2d2105db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/reanchor.js\":\"be9525bd56e8d811\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/schema.js\":\"e508742092c868b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scope.js\":\"b00b8968747ce560\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scopeThreads.js\":\"959f1fd3d4949157\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/splitRetarget.js\":\"da5d9d5bdcb0b77d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestionCard.js\":\"a2921a1ef0917ff7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestions.js\":\"ef6745bc95bf3c89\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaries.js\":\"7a028cbf1d66fb9b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaryBatch.js\":\"01e94f7f31e933c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/surface.js\":\"8ac0273bc45828cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threadNavigation.js\":\"825711f93794ce50\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threads.js\":\"51c1b996f962c977\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ui.js\":\"414cfa99a134d054\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/uiStore.js\":\"33da21e9427de723\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/appIntents.js\":\"6fefe53272a70394\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/index.js\":\"0ebfa2079ed55c6f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/index.js\":\"57ed8b845e852487\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/status.js\":\"5461c61b80cad9e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"bba7dc942524c92e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaBlockRenderer.js\":\"1b128ce07bdeb650\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b5a88fc61d5bb3a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaUploadReconciler.js\":\"9028df009bacd329\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetDownLane.js\":\"1a8d722e0142ee95\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetResolver.js\":\"2ebef0f97774b458\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetUpload.js\":\"94da5596778f649c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/attachmentCleanerIO.js\":\"a6494eed13a3c917\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c5062ade1d871820\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/blobStore.js\":\"de6e4569943071f2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/byteStore.js\":\"2b88ae276fc150e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanerIO.js\":\"ac52df4617aaf10e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanupAttachments.js\":\"68d0dac1be77991a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/dataExtension.js\":\"b22b3827682c1432\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/downLane.js\":\"94db880f68080a8f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/index.js\":\"c197982b446dec40\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/insertImageContribution.js\":\"6c66699ac6c5514f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneArming.js\":\"1e5bb9db7b9227aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneLock.js\":\"ed485ca074ecf3e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaBlock.js\":\"dc02bf1758f9aa1a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaCapture.js\":\"e5b971b0c644c52e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewers.js\":\"04afa39ccd1f1605\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewersFacet.js\":\"e53f775b8dee2223\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/pasteCapture.js\":\"916244f90b4652da\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/resolver.js\":\"c62456736d338075\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/retryUploadsAction.js\":\"7509393b9594ac8b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/storagePaths.js\":\"a946a40cb508f774\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadDrain.js\":\"d9451b0bb34dd5bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadLaneStatus.js\":\"23e97e5a2eaf6999\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadReconcile.js\":\"49a9f36618a1bf67\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadRecovery.js\":\"1496a1d2a8110f04\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadStore.js\":\"62e3f1ce60ccd2a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/useAssetObjectUrl.js\":\"02bf04b5e60b0d39\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e2fe29cbb74a4a62\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b83db0bb5930540f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/facet.js\":\"d38e6e2bb6152a48\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/index.js\":\"baa2d5a21e456fad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/prop.js\":\"08687dc8e324b8e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinkFilters.js\":\"dc9a31c8ac167555\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f83be2783ef5973f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BlockEntry.js\":\"e1856c8d7847420a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/LinkedReferences.js\":\"8cea596cd838b1ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a57aa09775e3e830\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dailyNoteDefaults.js\":\"6b6dfa96efbffa47\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dataExtension.js\":\"a5cce9fcd7ee28d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/edgeExclusions.js\":\"77552c1b94ef1a18\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/filterProperty.js\":\"b196852c01f7c12b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/index.js\":\"fe4b47fd686e43c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a5337d6f9ad913c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/applies.js\":\"2a5d21273e4c3129\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/countQuery.js\":\"2e49affae25c1150\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6fb1564151db45fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/index.js\":\"c781cd602da3e979\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b9b0e94c77bcbc42\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/presentationInvalidation.js\":\"e976e78442b94966\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyEditorOverride.js\":\"d2b2ae43aec97dd4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyFilter.js\":\"23baafb0c1080def\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/query.js\":\"dea7c938e9401361\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/resolveFilter.js\":\"2bdbdb59669eb8af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sourceBatch.js\":\"afc1d9463f7fac93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sources.js\":\"c68463ae5382689d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useBacklinks.js\":\"e52ca810691c2530\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"34dd494e51334000\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayCelebration.js\":\"4f5a3fffd95248ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayOverlay.js\":\"e09eafa6c5291cc7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/gate.js\":\"f08c112b29e64c49\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/index.js\":\"5fc9e64141dfca30\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/wolfTheme.js\":\"fd3fbd666c8cd284\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/BlockDragLayer.js\":\"0a617f9f092a5a66\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dragController.js\":\"aa6926c4b649dce0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dropTarget.js\":\"8e77308b572460c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/index.js\":\"636e63adb0e5feb3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/projection.js\":\"3372364c3581c166\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/BlockMetaCard.js\":\"f94df24252ab5710\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/index.js\":\"3f413c0215a8290e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/AddTagDialog.js\":\"4964167baa776c48\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1918ba50857f8779\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/TagNameIssueHint.js\":\"195c67c6263043b3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/addTagAction.js\":\"41ac75c93ab94847\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/appendTag.js\":\"de2079191891eae7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/config.js\":\"1a99f3f4cfaa4753\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/dataExtension.js\":\"8de84f04975ca33a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/index.js\":\"92092ae50aa1d9ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/propertyEditorOverride.js\":\"ec40c90cd5c008df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbList.js\":\"628ee6ccf2f68228\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4bbf91855d570090\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e96f7c415aed9f3c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"57bd3c0666a96591\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"6b69e1b0087b4e54\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/index.js\":\"8cb3efc0a1d9f895\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"417f9cdbd303e89a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/CharacterCountItem.js\":\"ac8d4cd617a21608\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2118508a492f0f77\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/actions.js\":\"44eaa4f2d372b073\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/blockType.js\":\"83e3d914473345b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/charCount.js\":\"945f360cd351f547\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/dataExtension.js\":\"69e91b77bc0cc40b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/index.js\":\"4a17e18708ec95c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/profiles.js\":\"7f61dd9d01e28f6b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/properties.js\":\"7417465de783bd4b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/textCounts.js\":\"f355858105f90466\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/colemak-keybindings/index.js\":\"0fca99086eb7b7a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/CommandPalette.js\":\"d03975dc71ea3a6e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/HeaderItem.js\":\"eaf91e5dc0295867\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/context.js\":\"3a24266520c0c976\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/index.js\":\"3b5aca27b9556f29\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/selection.js\":\"d4cc82a1427e202b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/toggleStore.js\":\"4274795beaba5ead\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/useCommandPaletteActions.js\":\"ff76c5f74a643960\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/ContributorBadges.js\":\"e999adf4a7f863ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/author.js\":\"95785a922e670f3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/codeMirrorExtensions.js\":\"21e6de2275f9562e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/dataExtension.js\":\"61057ac799f3ea96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/index.js\":\"678b923994efb2ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/mentionAutocomplete.js\":\"8c17693abc40ae66\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/processor.js\":\"8c5683a80fc52be1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/profiles.js\":\"d5754468c832d922\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/queries.js\":\"bb94cfa264141748\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/schema.js\":\"d9a0a9f2e53fb311\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"40a4576c242f2044\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/followOrigin.js\":\"19d886c6eaf0456c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/index.js\":\"7d918d819a1e2785\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"256a86bde529d224\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e3c09e4651936499\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/CalendarGrid.js\":\"1f6f61ba87f49bea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DailyNotePicker.js\":\"dc1e0f9a09afa3ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"6b3f55a534142dee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateNavDecorator.js\":\"198887da270d5b50\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateScrubOverlay.js\":\"542fb2cffba0a624\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/HeaderItem.js\":\"cbaa97265479b4f6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/ReschedulePicker.js\":\"1c00316e74a9df21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5ce572a25ddf1c3f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/actions.js\":\"52ae91d2669d7a97\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/blockDateAdapter.js\":\"312228cc3db33143\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/calendar.js\":\"6552f41ff6c8054e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dailyNotes.js\":\"63aea174bcd1b0cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dataExtension.js\":\"c14b176846dc64dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubActions.js\":\"cf8053d5f81674ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGesture.js\":\"a4d05292a57fca56\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f4a7194f6937969e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubRecognizer.js\":\"621c50cd56395c4e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/deletionGuard.js\":\"d7d1a7a1c656a813\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dueQuery.js\":\"efc5eee7d9328832\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/index.js\":\"6155a6ae1d4359d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/landing.js\":\"c8816d3a82990e8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/localSchema.js\":\"2dd049f4b3180486\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/referenceDateAdapter.js\":\"60245b249a78af18\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/rescheduleAction.js\":\"33aa8a1ac21d1e84\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/schema.js\":\"f7bfe35ae91ac51a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadBlockDates.js\":\"0276638901255a0e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadDatesAction.js\":\"cba1de5123d60b56\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/today.js\":\"ad91c4c193d4e6ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"1679e2b081be2fdb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e83b521eeb5b2038\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/audit.js\":\"411ecaab32855467\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditAction.js\":\"cca3485e24776823\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditRanges.js\":\"438afb8e2e88e437\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/diagnosticsSource.js\":\"bd9b039431ed51ae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/divergenceScan.js\":\"d7553afb46b6a3bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/index.js\":\"ed08981bab1262b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/propertyChildrenChecks.js\":\"cccbff81189d0a21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/referencesMirror.js\":\"c6759a588f318178\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/rowJson.js\":\"21e27dc6cd95d86c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/schedule.js\":\"5f583e9018687492\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/store.js\":\"f0cc7347eab6a51f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/action.js\":\"7674946295ba5366\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/index.js\":\"f174c5e53003877a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/plugin.js\":\"98b1475d72c48823\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a40730df538f6439\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/actions.js\":\"6e3a1e6dcfeb668b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/changeMarker.js\":\"7f63d2dd30f879b5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/diagnostics.js\":\"c68b9183caf5a8a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/fileSystemAccess.js\":\"036eea9caee18512\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/filenames.js\":\"c72a8a0b59cc34c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/index.js\":\"73d577af673ec550\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/mirror.js\":\"491d149c85d5e4f2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runLock.js\":\"0968e2f559c9f482\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runtimeHealth.js\":\"f6f216538b5ac4c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/schedule.js\":\"f4bb1852eeb2bf00\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/store.js\":\"b76825cb7b1b90b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/index.js\":\"6c72acc2401f343e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/themes.js\":\"b7cc0bbb7706fb05\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/facet.js\":\"1997e980ca59f9b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/useDiagnostics.js\":\"86a70ce8a485c9fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/dismissals.js\":\"f55532e5534d5206\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/index.js\":\"e4842cf8352aa9bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/status.js\":\"381d5fbf5e9ef390\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/store.js\":\"305e5bb7d3134b3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ec8e81f9f15c8167\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsSettings.js\":\"10ebcffede5e8d2b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/actions.js\":\"17b7d83c055e3b22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/config.js\":\"62bb3be049754d2e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/dataExtension.js\":\"ff8c42c67bfe9510\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/effect.js\":\"273732057a8d3ee1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/index.js\":\"04e487420e81f4a1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/propertyEditorOverride.js\":\"82d8cc2073f55032\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/useToggleTree.js\":\"4c36bad5b281057c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/ExtractTypeDialog.js\":\"466691d079920d98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"90aeddba752e6b1f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/PropertyShapePicker.js\":\"dcbe4b6becc51575\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/action.js\":\"0a2c86d65cda2ea2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/index.js\":\"41e7e5772119a3c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/FindReplaceDialog.js\":\"6e3aad5234800fb8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/HeaderItem.js\":\"6b087148e733568b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/dataExtension.js\":\"f53677e713a8b6e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/index.js\":\"8ee2fadc69af62b3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/search.js\":\"02925dcc226fc7f7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/toggleStore.js\":\"0c70eca22bf46e76\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/LocationPropertyEditor.js\":\"4a518ba8f9cf65c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/MapView.js\":\"ff8dbbba07ae2e98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/blockTypes.js\":\"29c3a0b535fca216\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/codeMirrorExtensions.js\":\"ab25ffeb0fb6b171\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/createOrFindPlace.js\":\"6a9aa43d669fa910\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/currentLocation.js\":\"4f5a025cb37de23c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/dataExtension.js\":\"ab2c71aa54842b52\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/geoContentDecorator.js\":\"e29faab482cb8827\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/googlePlacesClient.js\":\"34c524e8d3b97792\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/index.js\":\"d35d52f0d22113a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/locationsPage.js\":\"d07038d10cadeb3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/mapViewport.js\":\"23fb62a822f93bfc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/pickCurrentLocation.js\":\"8d0c4e49d5a81266\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeAutocomplete.js\":\"5cd3c7348d2ddd42\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeNameCollision.js\":\"d4bd55c1b1d60107\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/properties.js\":\"5b633c7b70bf2792\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/propertyEditorOverrides.js\":\"3e0b28cecaef9f21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/query.js\":\"acc23d665509269e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/usePlaceSearch.js\":\"066d440a7bb03bf3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"dc1fd7989a4ec5d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3d282636c850726a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8e9a0ebce92e56ae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/config.js\":\"ffb06c131103a8cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/dataExtension.js\":\"0ee8c61a60bd2e91\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/facet.js\":\"f8f361d399c410ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/grouping.js\":\"c888b73e2dd28c09\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/index.js\":\"1d74be617a7cad73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1a83d7159257ada2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/query.js\":\"c0dbe867f2ffbf5c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/resolveConfig.js\":\"e057eb65e7de8ae3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"793d226e8dbf3603\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c2797f9f2594456e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlDocumentContent.js\":\"0ae52cd04a6104a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlFrame.js\":\"3f0413453feac7b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/actions.js\":\"27c6f2a4968444bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/blockType.js\":\"eb4bad9964dc4523\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/confirmRunScripts.js\":\"96b3042754882223\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/dataExtension.js\":\"e66b21213410b6a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameAnnotations.js\":\"814c9c5c447a208f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameDocument.js\":\"3658d5005b4f002a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameTheme.js\":\"d021d8baf4e38bdf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/index.js\":\"b248c445e7f9bdbb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/scriptConsent.js\":\"49ecfa514ab96e41\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/sourceMap.js\":\"3a021fdcf5964343\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/useDocumentScripts.js\":\"17d39317b25ae86d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/index.js\":\"882c6739b663b3e3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/record.js\":\"fe0bb8b3c3e1e5bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/recordStore.js\":\"47cb03d2f16fb497\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/responsiveness.js\":\"c7b4a70ba91d3e63\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/schedule.js\":\"57773fccad3ee3f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/sessionContext.js\":\"a08c2e2bea3d6984\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"823c606b81a2c3bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"42bf6755722ad6a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/actions.js\":\"2d89986ef8bb91c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/config.js\":\"a13d5cea56b44f7d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/dataExtension.js\":\"910a03c56eba90f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/effect.js\":\"8de3aaa4df824be1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/index.js\":\"94391a6aa72b7a87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/keyCapture.js\":\"593aebfe33d4e589\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/overrideStore.js\":\"8982cfdb66e63137\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"076c649f204c2435\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/HeaderItem.js\":\"dd3ca353089488bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/LeftSidebar.js\":\"369a534dc2f4001b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/actions.js\":\"cf43243b3ac6617d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/facet.js\":\"3e769853954f2256\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/index.js\":\"263c538c20488dfa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/shortcuts.js\":\"792c7d265f179cec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/toggleStore.js\":\"07c1812bba37b4e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/MergePicker.js\":\"a49d06be4bf37852\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/index.js\":\"56b964f1712bf380\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/mergeAction.js\":\"99d789da49350ed8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/strategy.js\":\"16eb8afc2bfcc5c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/Button.js\":\"37b8ba5f13e273ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"053b738d17590de7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/defaultItems.js\":\"32f27c72032ca1fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/facet.js\":\"347c27c3e97f7bda\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/index.js\":\"893ac78a3e638b19\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"378999a0433d26f3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/actions.js\":\"671a1c1f2b598076\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b78d8fab01307654\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b8951f601f45f154\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/index.js\":\"e99d688203a1c21c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e75f06933feb4d98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/blockSubtreeMembership.js\":\"180ca19eb68874dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/contextMenuItem.js\":\"57856560a4a757c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/index.js\":\"23b26992b0640fb2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveAction.js\":\"8de1cb14530e6aba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveBlocks.js\":\"6bdad756f08ec4a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/selectionAfterMove.js\":\"2529f797a1423bd4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/TutorialBanner.js\":\"ebbe11c7259627bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/action.js\":\"5eb1bd5014e5f83b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/bannerDismissal.js\":\"31c668728975ef51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/documents/cheatSheet.js\":\"0dbbc9c612d67e89\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/index.js\":\"51891fdbe5ea9cff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/keys.js\":\"45804247bf06abb5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/landing.js\":\"929a95256dafb184\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/outline.js\":\"de9be3fc5a68a56d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/seed.js\":\"f787e58a0b9e936f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7d5903044148fe37\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/analyze.js\":\"3d3999fcf04bbc50\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/diagnosticsSource.js\":\"11dcadaaa6e9cf60\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/index.js\":\"1f14fe0e35939f68\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/load.js\":\"a2c9e340bd18de0f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/monitorRun.js\":\"71410280b42f8e90\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/schedule.js\":\"8a8137a75b3f6c79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/series.js\":\"7aeddaa7deb863df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/store.js\":\"a7f9a9a9b26bda2b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/trendAction.js\":\"b0b8e1688c6a197a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/verdict.js\":\"5bc6eb66fa38dd60\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/clickToEditAction.js\":\"650c1139095d65e6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/index.js\":\"210e4feb9a194983\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/interactions.js\":\"188a3972f193ec43\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5ca6375b40b3b54d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGate.js\":\"2730f523bb92f29b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGateDialog.js\":\"581f189973fc89cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/action.js\":\"605c9944d2860b96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/index.js\":\"e83c0c84f3e8abf0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/localRunMessage.js\":\"6213283c36e0cd9c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/plugin.js\":\"4e9503881c8128e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/progressReport.js\":\"0dd9666f5e5af415\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/sweepProgress.js\":\"99367194328d9662\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/FieldRowRenderer.js\":\"94e9d040befc086f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/ValueRowRenderer.js\":\"f2a34fa4881ba6cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/actions.js\":\"0c0f9b7e3678dbfe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/autocomplete.js\":\"0441aa985bd062df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/fieldRow.js\":\"9e4e594891164f7d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/index.js\":\"c3ce7a7e49b2e2ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/referenceWarning.js\":\"131aa27990fece39\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueAutocomplete.js\":\"b2618687de8fc68c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueSchema.js\":\"0e5321e91203a7b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/HeaderItem.js\":\"b1c3ff4a0e315f70\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/QuickFind.js\":\"6eb67ae91d9ecea1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/index.js\":\"67c8ab54535d2add\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/recents.js\":\"35da936efd1b4236\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/resultItems.js\":\"71aa2316405cdcb7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/selection.js\":\"2b5a2719d99dcedf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/toggleStore.js\":\"44fc59a2e07495c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/HeaderItem.js\":\"77dd20a9d103373b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c175e2ed97882807\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/grouping.js\":\"43961b2d03ae4999\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/index.js\":\"2ca22cd2bc25f3a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/target.js\":\"66bf5bf2663841e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/codeMirrorExtensions.js\":\"53be0889000387fd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/contentPrefill.js\":\"6cb80e386ee29258\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/dataExtension.js\":\"c78940b367bade40\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/index.js\":\"2a2028ed09ae0a0b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d1ea434f77bdc58a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/invalidation.js\":\"42ed64948a0c1856\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/localSchema.js\":\"f8f467089e29aaa8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/index.js\":\"a12b7a1734ee5f5e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4f709c38c54fb268\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/index.js\":\"7e429c4a4e2a1547\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/referenceNode.js\":\"c8d218fe599712cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2d3b5054233975e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"94862a69132063c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/index.js\":\"52ff5a481d0918f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"600df847a84092a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3a5dbf13ae8ec331\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/mergeRetargetProcessor.js\":\"e3185a318b3b0b1d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/parseFence.js\":\"8128ddcc5130c5d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceParser.js\":\"8a7acf07f73a4208\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceProjection.js\":\"4dbdba8c3352fb60\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referencesProcessor.js\":\"e391face0e07cc7d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/renameProcessor.js\":\"a83f4e1231b99094\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/spanReplacement.js\":\"507d796ee34dad77\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/htmlToOutline.js\":\"51a4f9cd98aec70d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/index.js\":\"c9f55c79812f5470\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/normalizeClipboardDom.js\":\"703a81ad0a96c483\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/pasteDecision.js\":\"dcdf6715b1cad26f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/action.js\":\"a3e44735947b460e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/blockIds.js\":\"061cda8c988daef3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/content.js\":\"fc906532418b1147\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/effect.js\":\"5deb92a662699d2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/ids.js\":\"c527e8e7b574ec6a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/import.js\":\"0a43591058e624d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/index.js\":\"f96c0346b41aecdd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plan.js\":\"acbac572273146cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plugin.js\":\"c29c29637556c5cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/promotion.js\":\"941b75342da9c299\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/properties.js\":\"ccf056380935ccf9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/references.js\":\"ce6778ce7078484c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/report.js\":\"7bad096f0a4540c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/roamMemo.js\":\"ae908a5a4806a753\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/runtime.js\":\"e553d40350541eed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/schemaReconciliation.js\":\"003257bdb913960b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/srsMarkers.js\":\"b504dbe693ce8440\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/todo.js\":\"476cd08adabd82c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/typeCandidates.js\":\"6a92a0c92593d1c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/types.js\":\"b2d234393cb55fe1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/index.js\":\"9fec3671e4b14d67\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/store.js\":\"39d12f290bf27b0a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/HeaderItem.js\":\"a42659c52dd91902\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"bafaa3d75022651e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/index.js\":\"b3e3a9ce16d1f4a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/model.js\":\"b39645206d436561\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/toggleStore.js\":\"9d2e088e8ab1515d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/useKeyInspector.js\":\"5f5054c85d01d57f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"bb4e5b2342b385d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/ShellDecorator.js\":\"2c6c66420792627d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/actions.js\":\"f3980f22fa1e0c70\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b1616304c09e1243\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/index.js\":\"508f30458ccdebbb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/shell.js\":\"362ad52258af7b98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/surface.js\":\"f0cf451608a7bc7a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/walker.js\":\"7292a5d5e3e0e878\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4ccbf737d7cfd599\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/dataExtension.js\":\"f798ac1a5c0f519e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/index.js\":\"be277385ea2107fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/indicator.js\":\"116641eadda15211\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/moveSrsState.js\":\"2c143120498b8320\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d9e22302613f5e84\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/scheduler.js\":\"9e6ab96984506671\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/schema.js\":\"dab0c233d8dbb552\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"eb845c91b6c8a622\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsClipboard.js\":\"b0508015441322e5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"cbb057e13901b77c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0df253c901eebc56\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DeckPicker.js\":\"2c51e3b86aa7a385\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewControls.js\":\"a291bfabfb868628\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3826e589832ecc94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewSession.js\":\"0588fe0a093ab10b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/actions.js\":\"a229545ad7233002\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/archive.js\":\"cb45712dd7cd9a4b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dataExtension.js\":\"326169e999c05ef7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/deck.js\":\"18780615a13ee4ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dueQuery.js\":\"10381022beb79713\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/gradeDecision.js\":\"0c48d6fbb8584c9b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/index.js\":\"906a73215d5e8e78\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/keyHints.js\":\"8cfd9f08ab81182b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewCardLayout.js\":\"bae24f62bd8c5a78\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewProgress.js\":\"ad1ecedccf130929\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/schema.js\":\"4bb080ebf0c96fbf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/useDueCards.js\":\"cb1afdae6ab79992\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/index.js\":\"458f07d776c58036\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/record.js\":\"0b983c51e0e50f35\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/index.js\":\"3661e7bd973947cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/persistenceStatus.js\":\"1e123405bf53891d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/requestAction.js\":\"6a64b780806aecc9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/TypeChipsDecorator.js\":\"38db0700098162f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/codeMirrorExtensions.js\":\"fdd67c2e3e7e5193\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/index.js\":\"cbf7e377b7b08a4f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/typeAutocomplete.js\":\"a5d3df76016f6ea4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"bfb64efd5abd90b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/actions.js\":\"198e7fbc87786abd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/anchor.js\":\"db1d8a9dbf08625b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/events.js\":\"4bdf42157245d953\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/gestureActions.js\":\"e18f388f28a06435\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/index.js\":\"02d99d64473e8f75\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"57d20cffceefc1bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/collect.js\":\"5281d39ec5ae462b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/index.js\":\"e9b8536a83eb57e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/record.js\":\"91d110338d17de02\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/RejectionDialog.js\":\"f41267e1d5beb2d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/SystemStatusHeaderItem.js\":\"da4102aa0573c648\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/index.js\":\"e2b9be48586809b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/model.js\":\"8caf5af33f4dfa16\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/queueCounts.js\":\"bad925534ccd5c44\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rejectedHelpers.js\":\"1817821fca28dc5a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rematerializeAction.js\":\"4847b96b459ebff4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/useHysteresis.js\":\"1f15c398c2370fb9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/ColumnHeaders.js\":\"8392fd35df527c01\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/QueryUi.js\":\"6e93e0eaad77558b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/TableLayout.js\":\"73f41495891aa84f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/actions.js\":\"d4e68b73783b471b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/cellEdits.js\":\"334876ecebc2bdb3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/columns.js\":\"8226777661cd424f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/controller.js\":\"24f442e0e77b7766\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/convert.js\":\"07b63c5328abb766\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/dataExtension.js\":\"56ea7dfb1e56f1ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/index.js\":\"349c0441cd64ecc7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/keys.js\":\"d9ce4ca45b78a770\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/model.js\":\"0b786c4eb9081cc6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/backfill.js\":\"c5adc24c6147333a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/format.js\":\"2a490d1c409c2067\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/parse.js\":\"bf2e9fe94e829237\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/queryValue.js\":\"f3621cd8d60678f9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/source.js\":\"fa3bbc807b2e21ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/registry.js\":\"9dfc53b3086df627\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/schema.js\":\"b978c9d2e8849f5f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/sort.js\":\"5c17f1ca086a66f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/effect.js\":\"2b842a0e36c4a401\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/index.js\":\"7b02256a93e7e881\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/theme.js\":\"2f0ae2504e007b59\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/actions.js\":\"221a6819388f3938\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/dataExtension.js\":\"8a637713d3255f2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/index.js\":\"c5cc997f67fcd4aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/schema.js\":\"dd2775b677c6115f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a93f23aaf6207a02\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/actions.js\":\"25e8ea8eb67357b5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/defaultItems.js\":\"52b0f4eb45930243\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/facet.js\":\"3675a874b66a2c96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/holdRecognizer.js\":\"3565af47b541035c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/index.js\":\"b55f52459192b3c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/UpdateIndicator.js\":\"468b43c25ec9f2b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/index.js\":\"db8b3d88b9284bc8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/loadTimes.js\":\"79e99c763df88fc0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoNotesRenderer.js\":\"c77f547d822f3dfb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoPlayerRenderer.js\":\"c9cee0f1c6b5fe90\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoTimeStamp.js\":\"ba184540fc5016f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/actions.js\":\"c97cfd9a47d07ebf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/index.js\":\"aa448bf9fbe1bef1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/markdown.js\":\"a4100bd487ada885\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/notes.js\":\"b1fc603f287ac2c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/registry.js\":\"15df07df88222c66\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/remark-timestamps.js\":\"da337ae7c0bc504e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/view.js\":\"dbbd4dc554a796d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/LinkHints.js\":\"34033061b69fd234\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/index.js\":\"a7338e4d272c353e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/model.js\":\"e77f402c20accfce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/settings.js\":\"5af0335b1391faae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/actions.js\":\"14f3b188df5eb05a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/index.js\":\"9098aeccdd34d5f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/interactions.js\":\"00a0d6b4336d08e7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/workspace-header/index.js\":\"2010300a00cc1c31\",\"/knowledge-medium/pr-preview/pr-1844/src/registerServiceWorker.js\":\"23d61254262e41aa\",\"/knowledge-medium/pr-preview/pr-1844/src/requestPersistentStorage.js\":\"75f37b23590684ed\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authRequestDeadline.js\":\"2de156d7c6ad0de4\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authStorage.js\":\"15e67ab23c43c813\",\"/knowledge-medium/pr-preview/pr-1844/src/services/powersync.js\":\"a3959954fc7019f8\",\"/knowledge-medium/pr-preview/pr-1844/src/services/supabase.js\":\"ece3bc928c876860\",\"/knowledge-medium/pr-preview/pr-1844/src/services/uploadErrorClassifier.js\":\"7a1b3200d9d3935a\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/ActiveContexts.js\":\"349d3a43220de60d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/HotkeyReconciler.js\":\"03e22f8a0cb55b5c\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/WipeLocalDataDialog.js\":\"925b794b74040d99\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionDispatch.js\":\"2e8cb7740264df94\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionRefItems.js\":\"a8a98f87138238ca\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/applyKeybindingOverrides.js\":\"85f408c58c230ff6\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/blockActions.js\":\"c94183ec21ec4443\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/canonicalizeChord.js\":\"44f6df0c3b4f11a5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultContexts.js\":\"d99b91588f273d00\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultShortcuts.js\":\"82e80038c946ad04\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/effectiveActions.js\":\"42480670b1cc2d1c\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureAction.js\":\"943665150863af56\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureBinding.js\":\"226d3aa81d08d5bf\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/holdRegistry.js\":\"855e0bfaa12035a5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingConflicts.js\":\"2329ef7dc580e907\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingOverrides.js\":\"83dc15095867be3b\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/pointerAction.js\":\"371d8d7d3f55cc5f\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/resolve.js\":\"f4c4f81e3de2477e\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/runAction.js\":\"07e38ee803858c37\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/sequenceMatcher.js\":\"109f502f28f38ec2\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/types.js\":\"45e8b060ec78034a\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionContext.js\":\"10ef2904cb3c7a29\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionDiscovery.js\":\"a5fa0b98d28f2589\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/utils.js\":\"e74da858fb4a16a5\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/bootStore.js\":\"ad375e61c90a523c\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/previewDatabases.js\":\"0fb6ea3438fe57aa\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/byteTransform.js\":\"df8f583bb775bc82\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/attachmentCleaner.js\":\"8a98528691d10f3a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/attachmentParts.js\":\"19c9962540b841ac\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleParts.js\":\"179bb5a013b05033\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleRecord.js\":\"f265a7f7452a9ceb\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/manifest.js\":\"714202e1d9677acd\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/takeBundle.js\":\"f38e7c6db1b77f28\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/verifyBundle.js\":\"746273925b405d23\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/cleaningStage.js\":\"f9350928f80a361a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionKey.js\":\"c5933a6024727f98\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionServer.js\":\"fde333f0da82a179\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flip.js\":\"7b631e57e00e3e64\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flipAttempts.js\":\"9e3922246681cc95\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/pages.js\":\"cadb81970ea3a76c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/preflight.js\":\"ebe56c9aed88a04b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/reseal.js\":\"2adf1bd03a475703\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runConversion.js\":\"005e9c1b544bb5ae\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runLock.js\":\"3fefb7ab5657b6f8\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealing.js\":\"1a4e51fa63cdf3d3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealingStage.js\":\"9ab47e3de17e1376\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/stage.js\":\"5c5cbf5c85bc965d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/verifyReseal.js\":\"e449a5cce89596dc\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aad.js\":\"f5205170b1925f74\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aead.js\":\"ba46e9c5664a747b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base32.js\":\"e371241372430246\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base64url.js\":\"d8f64bcf3538d30a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/binaryEnvelope.js\":\"c595c74920f42025\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/byteAead.js\":\"3566ca8717f9fdbf\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/canary.js\":\"e08db142cd0abaa9\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentHash.js\":\"38f26ccec059ec1c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentKey.js\":\"3de5d51e41fbdaf3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/derivedIdNamespace.js\":\"e7b12f64486518ac\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/envelope.js\":\"f2d0973a535739a1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/hex.js\":\"a1507d3bea30a41b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/sha256Hex.js\":\"05b6566fe75a00f3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/workspaceKey.js\":\"16b7958ce105f58e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/conversionState.js\":\"54e6de43ec54cc3c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/createEncryptedWorkspace.js\":\"cf19b3e098806389\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/pastedKey.js\":\"8d18302c45ff6c58\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"be38622b139fffb0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/upgradeWorkspacePin.js\":\"bc52a09ac6df2c4f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/keyStore.js\":\"86bcbd2aca30aa62\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/mintWorkspaceKey.js\":\"7a41d771b3613e8b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/modePin.js\":\"54ba44a30835b67e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/openWorkspaceKeys.js\":\"9e026c83664d0342\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolveWorkspaceEntry.js\":\"5c87d54f455979ea\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolver.js\":\"9cc04a6c1bca1af5\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/workspaceAccess.js\":\"503ce4986817f1bb\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/transform.js\":\"ee8bdaea16d09221\",\"/knowledge-medium/pr-preview/pr-1844/src/themeBootDefaults.js\":\"7259611c1d61d8d3\",\"/knowledge-medium/pr-preview/pr-1844/src/types.js\":\"2bda3bfbb8437a0a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/ClientLocalSettings.js\":\"1d7d9dce07617deb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/abortableSleep.js\":\"8504b85d23890ae4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/array.js\":\"4df1975801035f88\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/backlinkAutocomplete.js\":\"619b8f58306f3c19\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockCrumbs.js\":\"39a4fe52db617fbf\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockrefAutocomplete.js\":\"2dae7b80aeb1cf14\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/cadencedIdleJob.js\":\"82bcc656f2c4f979\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/callbackSet.js\":\"0a67fac708b91a1e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/clientId.js\":\"8f680251c040f8dc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirror.js\":\"9f76d8e28b712914\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirrorCompletion.js\":\"d7f5572de7ebc8d4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/copy.js\":\"b399585645445abf\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dailyPage.js\":\"80fe1cc180ab6108\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensics.js\":\"5b56b2653405b680\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensicsHooks.js\":\"cef3bc01f2324a45\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/deleteBlockThroughUi.js\":\"f81c4e05a4a212d8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dialogs.js\":\"eb4a470a67c86577\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dom.js\":\"7a8c9ae044756465\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/downloadBlob.js\":\"5f1b094476aa7e62\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/exportSqliteDb.js\":\"b355d72b426ba1b9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fileSystemAccess.js\":\"bc0552c71cab697c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/flipSlide.js\":\"ac48b7e101fd026a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fnv1a.js\":\"2683b9c4d0e072e9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/formatBytes.js\":\"d021ff9f3c11893c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fuzzyRank.js\":\"2c700f49bb1df6aa\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idbKeyedStore.js\":\"9946cf1861839ff7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idleCallbackPolyfill.js\":\"004db5acbc6ca801\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardAwareScroll.js\":\"689760cb88f70498\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardViewport.js\":\"345a6f2aaa7d6367\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/lastWorkspace.js\":\"4a1915b337723694\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutColumns.js\":\"796f699015fa1733\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionDom.js\":\"21d0f41155b839dc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionId.js\":\"ab020ad0b882b803\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkClickGestures.js\":\"be8e47eb2d6d709d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkTargetAutocomplete.js\":\"dff2428db1710f77\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbCorruption.js\":\"8c6a3ee9e18165ef\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbRecovery.js\":\"f39721a4363506dd\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/markdownParser.js\":\"d51bdb2505c77ea6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/memoize.js\":\"a855258fa676e73f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameFieldCommit.js\":\"68b05074a9ff39c2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameList.js\":\"480345d5d7510455\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/navigation.js\":\"bd661d9e45b90bbc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/omnilinerNamespace.js\":\"ac74ccc267fa1b3a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/opfsPageScan.js\":\"24981cdce5b45563\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelClearance.js\":\"dbf3552d58747b6e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelHistory.js\":\"f616f58f6a6d5f02\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLanes.js\":\"7244b51db09afbdc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLayoutProjection.js\":\"164c3a9e67a0f0fe\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelScrollAnchor.js\":\"ffdb0315d1cc4f6e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelUrlFlags.js\":\"663290b478327af8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/platform.js\":\"b5fc50f4f2c1ae1c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/pluralize.js\":\"35252a41be092559\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyCreation.js\":\"17baf0afd50d6ae4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyNavigation.js\":\"25d235a41710f7e5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyValueContext.js\":\"66d62250536a8fa3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/react.js\":\"71163339220edffe\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeDate.js\":\"10963e5dc25bfcf5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeTime.js\":\"9b9fa141fc946746\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/renderScope.js\":\"1685e2606a9d65d7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/resolvedThenable.js\":\"fe38e99a43c2a1fa\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/routing.js\":\"49b1bc3f4bd78421\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/safeMode.js\":\"9e0e48646a3b2102\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/scheduleIdle.js\":\"d6504499c9077d7f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/screenWakeLock.js\":\"78b310b948b5dedf\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/selection.js\":\"53ba1405e016b04c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/softKeyboardGrab.js\":\"b7a97322beabf866\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/startupTimeline.js\":\"ac70b61ac363db03\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/state.js\":\"d55b36cccbc39c92\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/string.js\":\"4a3f0cb203152ca3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/surfaceZoom.js\":\"eab9bf569efa0893\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/time.js\":\"63a8dc0e1bab30fe\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toast.js\":\"bdde376b610a1740\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toggleStore.js\":\"7a79dcb8600d76ce\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/untilStopped.js\":\"2694c7a0e41f1cf4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/userActivity.js\":\"6f0813856e8b7eef\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewTransition.js\":\"3026ce1fe0e5cba2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewport.js\":\"4b58391219c1e620\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/webLock.js\":\"cebf8dbb45b2412b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceRecovery.js\":\"a8ed137ae2e555bc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceSnapshotStore.js\":\"93007dddfe14e341\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-compiler-runtime.js\":\"164253db0c81bf95\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-client.js\":\"c1e3bb9726bc1081\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server-edge.js\":\"fab11167e7b2c7ce\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server.js\":\"bf7adcb88cc4e697\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static-edge.js\":\"4274ba9b6701674c\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static.js\":\"d9c9b7f8c7f73906\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-test-utils.js\":\"d13d2b2e4def0354\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom.js\":\"4b3058896048e307\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-runtime.js\":\"54065125f80055a4\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react.js\":\"40b75eefd39d4bb0\",\"/knowledge-medium/pr-preview/pr-1844/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
