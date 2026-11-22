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
		buildId: "3fc7c448a116-51312c21",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/\":\"e9ebbf996d82b982\",\"/knowledge-medium/pr-preview/pr-1844/index.html\":\"e9ebbf996d82b982\",\"/knowledge-medium/pr-preview/pr-1844/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1844/assets/FacadeVFS-CdPZJozz.js\":\"95dbbe99d24a85e0\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSCoopSyncVFS-DX-4dq8o.js\":\"f61de067a0052a45\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSWriteAheadVFS-BhUDl6pR.js\":\"90c784d9a94dae31\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-BWUc3oPE.js\":\"dbf8f5c7e4fa691a\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-ikNcdICK.js\":\"13bb89deac0b406f\",\"/knowledge-medium/pr-preview/pr-1844/assets/worker-BeKqn80T.js\":\"95f1ed473eb16e98\",\"/knowledge-medium/pr-preview/pr-1844/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1844/chunks/app-D3pwnspo.js\":\"3a6d16f32c910864\",\"/knowledge-medium/pr-preview/pr-1844/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1844/index.js\":\"d1f965f778480e4b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1844/assets/AccessHandlePoolVFS-A3-OAZnf.js\":\"3594d17686c4670e\",\"/knowledge-medium/pr-preview/pr-1844/assets/IDBBatchAtomicVFS-C6xEtJtD.js\":\"cc1fadd6cbcadeab\",\"/knowledge-medium/pr-preview/pr-1844/assets/MemoryVFS-DVo-dTJ4.js\":\"d8f85a52506fe0b2\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-SUWAzvyQ.js\":\"abf42bf3002268da\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-5cmjl-J3.js\":\"00adf704c198e3ef\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1844/chunks/AccessHandlePoolVFS-CMZTo7Xc.js\":\"7246c340ffa921cc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/FacadeVFS-DmSYawxa.js\":\"0de86276eb44d386\",\"/knowledge-medium/pr-preview/pr-1844/chunks/IDBBatchAtomicVFS-BUsjFW2R.js\":\"a994d184e0660423\",\"/knowledge-medium/pr-preview/pr-1844/chunks/MemoryVFS-BJxUSc0f.js\":\"718780627c4c0871\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSCoopSyncVFS-DVkYh_dp.js\":\"4a0c38c4456fffe6\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSWriteAheadVFS-TyD2MqcW.js\":\"bf5b60a2ca1275ee\",\"/knowledge-medium/pr-preview/pr-1844/chunks/Preview-DNN7wBCO.js\":\"54c8b20e35bf25bb\",\"/knowledge-medium/pr-preview/pr-1844/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/card-CddkZs59.js\":\"31132e228188a8bc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-BYKICG02.js\":\"1bc13bcce1631891\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-CnUpQEJl.js\":\"21a79808d9b496a7\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-async-CvGrzZ_c.js\":\"9692696160d7f73c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-BOBFJrhX.js\":\"28ee13de6511a08c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-C2xUocmz.js\":\"8b9a4bd05dcf059b\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-CddnfLEO.js\":\"615bb1a9021220d9\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DKnLJLA1.js\":\"51cbb0b30aba1338\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-Doxxo_z_.js\":\"db1ab5e4f40f2d2a\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DvSdgAdT.js\":\"a08241fb7da24651\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-S1dQa8Xn.js\":\"b0ce245c5d572a7a\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server-legacy.browser.production-BFiAnPHl.js\":\"8a4988305a7ea139\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.browser.production-gET6T2bY.js\":\"2abdf28bfb9178dd\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.edge.production-Dy2npKE7.js\":\"a1e3e762d3b27423\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-gM0TuHJY.js\":\"d73780c2272b7e4f\",\"/knowledge-medium/pr-preview/pr-1844/chunks/server.browser-4fDdCxg3.js\":\"0cf9a40af881c5f5\",\"/knowledge-medium/pr-preview/pr-1844/chunks/textarea-qf8_-0Xg.js\":\"bef095b23860eefe\",\"/knowledge-medium/pr-preview/pr-1844/chunks/ui-Doh9sZRH.js\":\"5e95184343168685\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-BvEzlTnI.js\":\"5393f551905b546c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-async-Xadwtb4r.js\":\"bafc79d117cd8e66\",\"/knowledge-medium/pr-preview/pr-1844/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1844/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/src/App.js\":\"c04e397b66ced6d8\",\"/knowledge-medium/pr-preview/pr-1844/src/appUpdate.js\":\"1f089659a3bf1c3d\",\"/knowledge-medium/pr-preview/pr-1844/src/appVersion.js\":\"1ee85d058c24cf16\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/initialLayout.js\":\"2c6a2c7d86720486\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/openWorkspaceData.js\":\"2ff36e45b5c0f07f\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/resolveWorkspace.js\":\"fa72756e352adad2\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/workspaceBootstrap.js\":\"c4b4667728ccc675\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockComponent.js\":\"778457f2c4868b3d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockCrumbs.js\":\"e1829b21043e6965\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockEditor.js\":\"d254b070e8442d12\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockLoadingPlaceholder.js\":\"8ce8640b1300f0df\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockProperties.js\":\"1a1cced41c343358\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockSearchPicker.js\":\"943550b9b8f16380\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ConfirmBulkDeleteDialog.js\":\"e706951c16c20537\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DividerHandle.js\":\"b43a20c4c9ccf71a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DraftEditor.js\":\"f67300b5da865018\",\"/knowledge-medium/pr-preview/pr-1844/src/components/GutterPill.js\":\"109c8100aa36f670\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Header.js\":\"0fefd6d871ca395a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/LazyBlockComponent.js\":\"b53b786fcc87d678\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Login.js\":\"ef6fc2352ef38766\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ZoomableSurface.js\":\"3e75897409b8d199\",\"/knowledge-medium/pr-preview/pr-1844/src/components/editModeKeepalive.js\":\"3b8e15c969cdce7f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b0303628635aa31e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e72f8308b5826815\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefPropertyEditor.js\":\"31a8a1d9585a62f4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefTargetTypePicker.js\":\"39215d239facb4fa\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/SelectPropertyEditor.js\":\"f306e57655824b2b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/TypesPropertyEditor.js\":\"37669af4c147b6c4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/defaults.js\":\"0a94866a8a883b79\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/kernelValuePresets.js\":\"600fbca2e3e24158\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/selectablePresets.js\":\"515a706a6a4a447e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/typesPropertyUi.js\":\"c14b2989b1e54da0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/AddPropertyForm.js\":\"9d36e38fefeac4fc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyPicker.js\":\"d61cb20258a9b1f9\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyRow.js\":\"eeec5ecd4d1ed03d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/Rows.js\":\"b0b472edf99c6637\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/actions.js\":\"223d3b0376d43eed\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/declarationOnly.js\":\"d9169f03d00edb3e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/layout.js\":\"0bcbdcf7e179cc79\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/model.js\":\"7e92f274ebe3f998\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapeUi.js\":\"9e41005c98467aed\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapes.js\":\"d27902562dbe5302\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1b01c42f38734759\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/visibility.js\":\"178b37ea72929503\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanelSections.js\":\"15b566018a93869d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockEmbed.js\":\"a04d4fc6046abc80\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockLink.js\":\"eef37499db5e7586\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockRef.js\":\"b13199d368a6da57\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/ReferenceLink.js\":\"ec1bc9d0dd01ef70\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuard.js\":\"690f78617322f8dd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuardContext.js\":\"c416822608833656\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/linkInteraction.js\":\"f0e2e466a128b144\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/referenceLayout.js\":\"05ad9f8db56835ee\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/useBlockRefAncestors.js\":\"357c00b78e5f3fdc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockGutter.js\":\"f90cb0ad0ca015de\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockInfoDialog.js\":\"a86b065320d93c21\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockTypeBlockRenderer.js\":\"20ece2c55a3b0c76\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BulletHoverCard.js\":\"247763e392caad0f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorContentRenderer.js\":\"92fbf22f19818a77\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4be2d76cebfb5e04\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ColumnResizeHandles.js\":\"ac35309d72279f2d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"45ef4fda4da61243\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/DefaultBlockRenderer.js\":\"a3c9d83dc28de34c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/LayoutRenderer.js\":\"9e2311a65d3953e2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MarkdownContentRenderer.js\":\"e31b9950047056bb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MissingDataRenderer.js\":\"b5124511333d2c27\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PanelRenderer.js\":\"acefd383a334a76a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PropertySchemaBlockRenderer.js\":\"25e7667039b7efef\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/TopLevelRenderer.js\":\"ef0150b098d3e19b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockGutterMode.js\":\"b632cded70f1d3de\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockTitleText.js\":\"f6b5bb6d6033ed6c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/fieldCreationKeydown.js\":\"01c7b44b9f37832b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/layoutRootContext.js\":\"31feabb341aa7e27\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/TypeChip.js\":\"8f7d81de7adaf2a3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/chipStyle.js\":\"981c940aa344d1b4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/anchored-floating.js\":\"66066730aaa6d768\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/button.js\":\"8ab07384958be95e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/card.js\":\"5d2be5cb515b7de4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/checkbox.js\":\"d6c64b7d8964ec26\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/collapsible.js\":\"3cb3a0988b9f7c88\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/command.js\":\"6e9a52048ad5a358\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/context-menu.js\":\"8e4615b715d7ea4e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dialog.js\":\"c1420ffece7af953\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dropdown-menu.js\":\"fcbc95fa9656a39f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/floating-listbox.js\":\"d342f3ddc95ad9ce\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/index.js\":\"749b4940a857f8da\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/input.js\":\"285a43beb9546411\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/kbd.js\":\"eeb5388db64cf986\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/label.js\":\"db27b24afa776540\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/textarea.js\":\"22e508e76ec23fa2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/useEditModeYieldKeepalive.js\":\"2d08ca7a86fb5dd3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/BootFallback.js\":\"1b55f1ae38e5ce6e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/FocusedRowLazyMount.js\":\"6324088b43a2e845\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LazyViewportMount.js\":\"1aa3f3323fcd424d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LocalDbCorruptionFallback.js\":\"796fe46f0f64bd3c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/error.js\":\"b366e37f5ecda308\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/lazyMountRegistry.js\":\"5a400c681d9594e8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/suspense.js\":\"d025a8b39ce51164\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/CreateWorkspaceDialog.js\":\"0e4587298d35e35d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/PendingInvitations.js\":\"dc28c69a51d7e574\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/SyncProgress.js\":\"80903f275f75425f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/UnlockProgress.js\":\"252d49efe9e1db10\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceKeyGate.js\":\"86b312aadc7684c2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSettingsDialog.js\":\"42e1324cedcff92d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSwitcher.js\":\"ba78f8f232adf4c6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSyncGate.js\":\"bc58303ce1c5d903\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlow.js\":\"d4355c0fa34aa18e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlowHost.js\":\"92348f6d408b5f70\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/EncryptionSection.js\":\"25339f89755f4034\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/attachmentPrompts.js\":\"4e869315e98dfa62\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/bundleFolderPrompts.js\":\"127d382d774760b4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowDeps.js\":\"1929831ad1b845ee\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowStore.js\":\"6929e0348bc8e415\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/flowUi.js\":\"c6adb1141bcd6572\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/useConversionRun.js\":\"6efab0364b1de94e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/keyUi.js\":\"566e57493574fde0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnKeyLoss.js\":\"9843aacb52ddd008\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnServerE2ee.js\":\"bf8c6ce9510a9d01\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/workspaceUnlocked.js\":\"79dc160209a08ccb\",\"/knowledge-medium/pr-preview/pr-1844/src/context/backgroundSubtree.js\":\"1066fa5bab8c957a\",\"/knowledge-medium/pr-preview/pr-1844/src/context/block.js\":\"41f1a6a50c00ce42\",\"/knowledge-medium/pr-preview/pr-1844/src/context/layoutWsContext.js\":\"34aae09c9ff70361\",\"/knowledge-medium/pr-preview/pr-1844/src/context/propertyDisplay.js\":\"46a8f4d9ba0e74c0\",\"/knowledge-medium/pr-preview/pr-1844/src/context/repo.js\":\"169fff8ddbbcc55a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasClaim.js\":\"ab5f5edb45a8937f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasSeatNamespace.js\":\"9054f43bc64b986b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockData.js\":\"c4b23b65dd007974\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockType.js\":\"c6b87883cb10b962\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/changeScope.js\":\"6d7caafc3d81af7a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/codecs.js\":\"cda07066720a12dd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/derivedData.js\":\"eaded27659e7130f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/errors.js\":\"c1a0aeaa9fcb1cf1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/events.js\":\"f13c850a16e9e0ba\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/handle.js\":\"a7bc162896a215d9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/index.js\":\"d312db1ddd6c8cb3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/mutator.js\":\"990540c2bcaa3f62\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/processor.js\":\"8e17ce0fd62cacd5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/propertySchema.js\":\"842b3628db9016fb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/query.js\":\"dcfe127ddc365619\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/sameTxProcessor.js\":\"c7cce5eb15939541\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/schema.js\":\"a7bc162896a215d9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/tx.js\":\"a7bc162896a215d9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/typedBlockQuery.js\":\"32b6aa70a3f2d610\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/user.js\":\"d0e26a2ab5cd40f9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresetCore.js\":\"4237d85fa857432b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresets.js\":\"6f6487a68427d49a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/attachmentCleanerIOVerb.js\":\"ccbb58ae009a4e9e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/block.js\":\"2027c8e48de6f0d1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockCache.js\":\"6baaff3c3a6bdfcb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockId.js\":\"110d27ce31b6cf7b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockLiveness.js\":\"2092c5528f4c6969\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockMerge.js\":\"1093a7d5f1e5ea41\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockSchema.js\":\"91d02b8bb6a8a1cc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypeLookup.js\":\"18d816619369fce8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypes.js\":\"b93abc0b3c81b1a1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/clientContext.js\":\"2f1050639fc4be03\",\"/knowledge-medium/pr-preview/pr-1844/src/data/dbFileSiblings.js\":\"e05ae8dcd0c11451\",\"/knowledge-medium/pr-preview/pr-1844/src/data/definitionSeeds.js\":\"22646ca1795012f4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/derivedIds.js\":\"3701ec5cf22ce23e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/drawnSubtree.js\":\"bb0c82d170c70007\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facetBridge.js\":\"ec32638339accb3c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facets.js\":\"675d08df6ec8944b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/globalState.js\":\"c47ac4024031a72a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/aliasClaimRederiveProcessor.js\":\"c6a590d774aafe84\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/ancestorBatch.js\":\"f65281c91f16aada\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/blockTypeTypeifyProcessor.js\":\"485529f631467ed1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/clientSchema.js\":\"6c179b9ed4c6885b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/commitPipeline.js\":\"78d84b77e9b6376b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/devAssertions.js\":\"a721e02cca106676\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/firstSync.js\":\"99b8c10ab3f1fee9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/freshInitialLoad.js\":\"ebfb5ce4fed4229a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/graphBackfillClaim.js\":\"29a7fffd87ac301f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/handleStore.js\":\"6e92f9bdb5ce140d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/idleMarkerJobs.js\":\"ffff25022722fbf2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initialDownload.js\":\"eafa693a58179c62\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initializeClientDatabase.js\":\"0da3fcdfbfffbcad\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/jsonCanonical.js\":\"10d58b17783939a3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelInvalidation.js\":\"064dabfb1154742b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelProcessors.js\":\"95433e9f969db490\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelQueries.js\":\"51f9a20d916c46d1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/mergeTypeMembershipProcessor.js\":\"2b7c18bf8ec3fce1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/normalizeReferencesProcessor.js\":\"710b08af749d546e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/poolInstrumentation.js\":\"039f8976b4fd9799\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/processorRunner.js\":\"052e3833f7dde11b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyCellBackfill.js\":\"f230594249ef0eeb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildMint.js\":\"b84e5fe164ad074c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildrenProcessor.js\":\"9e7aee803f2a1b20\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1359bcd414022e59\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionSynthesis.js\":\"13237a49af69aa84\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyKeyScan.js\":\"94a7994518045cb5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertySchemaResolution.js\":\"cd619c92e0a0ef7a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyValueEdits.js\":\"25de5b97489af435\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/raiseProtocol.js\":\"a3b96bc1379564fa\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/readBatch.js\":\"f5994d889910f0e9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/refProjection.js\":\"43b90f2afa2300c7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetLookups.js\":\"f38be7d7e8807ac5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetProcessor.js\":\"cb8d42a3c13e604f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/replayMerge.js\":\"18bd7b86c9a457ea\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/sqlBinds.js\":\"5232e8e49a70b914\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"13d35b54e910ad9b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/arrivalProcessors.js\":\"174a58bea76ae86f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/invalidate.js\":\"6ed0e2dadbc0c399\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/materialize.js\":\"eed658e71bcf72f8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/observer.js\":\"9b2c55c9081e58f5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/reconcile.js\":\"67de9a768813cfda\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/timingMetrics.js\":\"2b95b29ee3e2f187\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/treeQueries.js\":\"361bea222ce39794\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txEngine.js\":\"2ec6784786df747c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txSnapshots.js\":\"685ab0eb63edaa60\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/typedBlockQuery.js\":\"c8f8cb0b281e11d4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/undoManager.js\":\"3cee94de4c3c1d45\",\"/knowledge-medium/pr-preview/pr-1844/src/data/invalidation.js\":\"5c7d278eec62bfee\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelDataExtension.js\":\"b0ecb995999480e8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelPage.js\":\"9d20f221d056170a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelValuePresetCores.js\":\"5dd1007b66d65eb8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbCorruptionSignal.js\":\"bd3cfc28582d7c3b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbStorage.js\":\"d42e3cd438b2a05f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbVfs.js\":\"74fac0e39f123b82\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localSchema.js\":\"1e60e2af62566c71\",\"/knowledge-medium/pr-preview/pr-1844/src/data/maintenance.js\":\"c188f104108e45fb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mergeProperties.js\":\"5422825dcab5b5c1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/metricsConsoleHook.js\":\"7b4e2a090fed91b0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/migrationsPage.js\":\"e40be5e8f0a09e6e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mutators.js\":\"84980ebebfaeab66\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKey.js\":\"158525be997e3698\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKeyPlacement.js\":\"c5176e1c1ccd0386\",\"/knowledge-medium/pr-preview/pr-1844/src/data/outlineSurface.js\":\"5aae4f546f183477\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingEditorContent.js\":\"848c2bc02b6e752c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingUploadsSql.js\":\"8c12c1bcbcd95e42\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pluginStateExtensions.js\":\"c153de633a85cb6b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/powerSyncLogger.js\":\"557e36c443ea5253\",\"/knowledge-medium/pr-preview/pr-1844/src/data/projectorRuntime.js\":\"6af0ad1a51c5874a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/properties.js\":\"21d3dbe574d18fe7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertiesPage.js\":\"0eca9679fbf46a91\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyChildren.js\":\"f32cd30360886102\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionFanout.js\":\"d0f9c7702054eac4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionMetadata.js\":\"037326649b9d9409\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionRegistry.js\":\"e22fe8ed43a9c9dd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDisplayMode.js\":\"e6bd997f4274949e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyRowCreation.js\":\"044b6f48f4eaf49e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySchemaCreation.js\":\"c6d9dcd530265a4c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySeeds.js\":\"22776d802d823676\",\"/knowledge-medium/pr-preview/pr-1844/src/data/recentsPage.js\":\"f8b1b1f73e299f8d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/referenceBlock.js\":\"b0bf0b08c99ee206\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rejectedUploads.js\":\"3ec5e6bceef15967\",\"/knowledge-medium/pr-preview/pr-1844/src/data/releasePowerSyncConnection.js\":\"cd36690ba41c7876\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repo.js\":\"650658bcaf1443a6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repoProvider.js\":\"f8ea8195dc1d41d8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rowProperty.js\":\"976695871575d101\",\"/knowledge-medium/pr-preview/pr-1844/src/data/searchFilter.js\":\"a17dcdf4d95f320c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/seedIdentityLedger.js\":\"547101417c1e59cd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/stateBlocks.js\":\"2cd50a0eaaf53c71\",\"/knowledge-medium/pr-preview/pr-1844/src/data/structuralEditPolicy.js\":\"4db4664766f3f440\",\"/knowledge-medium/pr-preview/pr-1844/src/data/subtreeDelete.js\":\"0f1733ee793ec17b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncStreamLock.js\":\"469d0ab541d52432\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableSqlRecognizer.js\":\"31727604c20a5272\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableWriteGuard.js\":\"1488f1409131f718\",\"/knowledge-medium/pr-preview/pr-1844/src/data/targets.js\":\"1fb4de280e4d0ebb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeColors.js\":\"51575f4476f9cfc5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionMetadata.js\":\"fdfc0b2744301a26\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionRegistry.js\":\"e70a5f59ea89b429\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeExtraction.js\":\"1132b9d7b7d25f84\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeInitialValues.js\":\"34375cc3130a68ed\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typePropertyGroups.js\":\"9f823c39f3b56b7b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeSeeds.js\":\"fb21f6467356ba15\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeTagger.js\":\"297a902f4086efbd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typedRecords.js\":\"0e6dd1598f80a8c2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typesPage.js\":\"eb10e4f65fbc0561\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userPrefs.js\":\"7c6c39e551ca69fa\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userSchemasService.js\":\"49e24f12d075f8bb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userTypesService.js\":\"c514e8da925d308c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/valuePresetRegistry.js\":\"479f45458c262c47\",\"/knowledge-medium/pr-preview/pr-1844/src/data/visibleChildren.js\":\"934b99f16839f583\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceConversion.js\":\"fd0b64e46368f4a1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceFirstSync.js\":\"a9f632078336a7be\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceIdNamespace.js\":\"1d2da3c9b809ad3e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceSchema.js\":\"69e127fa9e36da93\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaces.js\":\"0f5aff0562ddd977\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadLog.js\":\"3be4e68be7ce729f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/BlockPasteShellDecorator.js\":\"c3258521d0fa393a\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/atTrigger.js\":\"e62ff29b37c66930\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/autocomplete.js\":\"ca7c5b60d392d060\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/codeMirrorExtensions.js\":\"ae53de8968daf40f\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/contentFlush.js\":\"0557145b56f7ce5b\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/defaultInteractions.js\":\"ed3aca595d493f24\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/editSettleSignal.js\":\"553134daea03bb0c\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/insertImage.js\":\"e348f99cbb0ad253\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceCompletionRange.js\":\"4f9a84f8e8704877\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceTargetTypes.js\":\"287995251286bda3\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/syntaxContext.js\":\"080105489d9a524f\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/triggerMatch.js\":\"b3f69490378f3340\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/AppRuntimeProvider.js\":\"f8b5acb182d8a222\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/BlockFocusShellDecorator.js\":\"f6d0d003673ecc06\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/ExtensionRenderBoundary.js\":\"dbf2c6f09bae90d4\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/PanelContentRecovery.js\":\"28d37cd2266bf60e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/apiCatalog.js\":\"a9850ddec104fbed\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/approveExtensionHere.js\":\"2889826befa65e61\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/armedCutAppMount.js\":\"761972b8797488bf\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/batchableKeyedStore.js\":\"75693a9d9b0f77d1\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockInteraction.js\":\"b33af7b71cbfc498\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockSelectionAction.js\":\"0ad7a3f150738350\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compileExtensionModule.js\":\"a96ffe8d570aa8fe\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compiledModuleCache.js\":\"103d4350b0479f04\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/continuousGestures.js\":\"2e16ba82172d5bfd\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/core.js\":\"82422ca244936fb5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/defaultRenderers.js\":\"549a02c12d70860b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/definitionFanoutAppMount.js\":\"4d0603f2dcbdc57c\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dialogAppMount.js\":\"74c64d7853c59992\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensionSeeds.js\":\"f3299e22d73813d5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensions.js\":\"b4ef65e8141e2ec7\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/exampleExtensions.js\":\"f79637278af0343b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionApprovalStatus.js\":\"5ed2a534f434df00\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrorToast.js\":\"8f2090f4d9e1cf40\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrors.js\":\"b1d6c7064261a8b5\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLookup.js\":\"3fae342b5793aa96\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionToggles.js\":\"c8a075dda1893d6b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionUtilitiesCss.js\":\"6cc93c32b0579eb1\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/kernelPageDeletionGuard.js\":\"76920b357b0fe705\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/liveRuntime.js\":\"f309cb274495588b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/openExtensionsSettings.js\":\"3a955620ad439935\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/overridesCache.js\":\"22479807f115a2db\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/pluginIds.js\":\"2fe7b6742ad5cb89\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/processorRejectionToast.js\":\"adff7f99f511375b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeActions.js\":\"80694da3e40315cb\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeContext.js\":\"6186f35057730f0d\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticAppExtensions.js\":\"dc1c66461b19553a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticDataExtensions.js\":\"c8e6fd83bd730641\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/toastAppMount.js\":\"181269bd72378223\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useOverrides.js\":\"2390ff9669e56095\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useShortcutSurfaceActivations.js\":\"551df0c00c9b1fe9\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/discoverToggleTree.js\":\"c2240e74198611f6\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/facet.js\":\"844b17c9f8b3e534\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/resolveAppRuntime.js\":\"a74648b41a29936b\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/runtimeEvents.js\":\"7f85d64057d7bad2\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/togglable.js\":\"ce0b54b37d38f552\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/variantFacet.js\":\"94983961a0b0d1a2\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/verbFacet.js\":\"416a136899d80209\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/block.js\":\"b6d24414606053db\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/focusedChild.js\":\"e42065826d31a8e3\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/propertySchemas.js\":\"66660c2feaf318db\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/typeRegistry.js\":\"d60ab906a073be16\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAncestorCrumbs.js\":\"b8899549de4b1ef0\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAutocompleteListbox.js\":\"18592b2e042daea0\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedSearch.js\":\"cb9e29aecdf8e143\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedValue.js\":\"0adcb864d3d3956f\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsFocalRender.js\":\"f30d4c423d0e1f18\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsReadOnly.js\":\"1686a917e899bec3\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMaterializeBacklog.js\":\"e9791688f5a8b5b2\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMinuteClock.js\":\"49226f9d3ce8ee45\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePanelLayoutProjection.js\":\"43b2e3a4baa31fe2\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePendingInvitations.js\":\"3c45abc73bcd461b\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRendererRegistry.js\":\"086b7d3571bbe093\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRetainedFieldRows.js\":\"3a1d375c1428ec7c\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useWorkspaces.js\":\"6b589d548b28742b\",\"/knowledge-medium/pr-preview/pr-1844/src/lib/utils.js\":\"68d58c64ccd57a8b\",\"/knowledge-medium/pr-preview/pr-1844/src/main.js\":\"e7e4ae2e14243ae4\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/MarkdownImage.js\":\"b8e8aa49f8ab30b4\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/blockSeparators.js\":\"eaff52068829a567\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/context.js\":\"18a4b7949f7b7684\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/defaultMarkdownExtension.js\":\"f40e685955ad5d53\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/extensions.js\":\"a19cf3115260e28c\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/renderMarkdownHtml.js\":\"136579aa3194ef1b\",\"/knowledge-medium/pr-preview/pr-1844/src/minimal-editor.js\":\"9ca4836bac84f4db\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/armedCut.js\":\"d287aa21c5bd8cad\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/captureMediaVerb.js\":\"e35cfee4813fd7d8\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/clipboard.js\":\"e10a053395f262be\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/decision.js\":\"32c077567b0cace9\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/operations.js\":\"f38ff5ce4c359f74\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/AccountHeaderItem.js\":\"03126c4870608c87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/index.js\":\"00e750c820821817\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a5aca8a8e63e8c0e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askAgent.js\":\"ed13d4cb39207aaa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askedStore.js\":\"524690427f6e7634\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2bf49b4044e2a92b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/chipState.js\":\"85d58aecfc734b4a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/dataExtension.js\":\"58246d3726b5e5b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/index.js\":\"624e50e7b58e987a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"099b5c1d4365fbb9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/schema.js\":\"ad1fa1a87563c6f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/AgentTokensDialog.js\":\"967fbe0c703d21a1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/BridgePairingDialog.js\":\"df851fd3ea97f601\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/addMedia.js\":\"0e40356ecfaa63ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/backlinks.js\":\"16cd8bb8bcb1a3b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/block.js\":\"4785cee24fcdb4eb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/context.js\":\"1004cd2454bd2eeb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/displayIds.js\":\"066010f6237f2456\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/index.js\":\"430e553a5bc094d6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/outline.js\":\"18c6186d57ab4eee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/properties.js\":\"4d3a5143b0bc2191\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/refs.js\":\"3909a3ff96937119\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3975d3a43c3a59e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/search.js\":\"cdd48e1ea1e84093\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/shared.js\":\"e09ef6d18d865144\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d1fdcffb2dc97dba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/text.js\":\"ae3d461288f340ae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentWrites.js\":\"3871a4203c750f1a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/authoringCatalog.js\":\"fb3db595c954d9e5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/blockRefTargets.js\":\"7f5a74f273478678\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridge.js\":\"cfe70545fa8c144f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridgeLoop.js\":\"31f65a884f97d7df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/changeHistory.js\":\"09567b2f69aa1940\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commands.js\":\"291ac74162a1d035\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commentsCommands.js\":\"7361004ccef752d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataExtension.js\":\"be690b290194db27\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataModelGuide.js\":\"8134e5460715e014\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/describeRuntime.js\":\"cfd05e33e8b68c60\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/extensionLint.js\":\"9c144c0a43436469\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/grainAudit.js\":\"709d227af7d9f87d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/healthCommand.js\":\"9c496a02a6574953\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/index.js\":\"cdf8bf5435c02c48\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/presetIdentity.js\":\"317efa681fd1e67c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"47731f7b5c2d3a94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/readMedia.js\":\"368b0fc6ed7bd579\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/schema.js\":\"f35271b14eaca5e6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/serialization.js\":\"ee39a56f0e290c80\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/targets.js\":\"25c27d1c154bf2c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/tokens.js\":\"10a076a54d3a4894\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/watchEvents.js\":\"acb31cdb1338ec46\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/workspaceGuard.js\":\"90d31b501533e6b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/writeCommands.js\":\"42627743f2e85d34\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/AliasCollisionToast.js\":\"43f97a1e5e799bc6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/DuplicateNameBanner.js\":\"e4c5df0a828a9e6f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/collisionMerge.js\":\"db814a201547af1b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/dataExtension.js\":\"07910f68d2d4d254\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/index.js\":\"71f9766a39b7de84\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/mergeCollisionAction.js\":\"3e9c4b454a5392f9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/pageStyling.js\":\"093775a13069d79b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/rejectionToast.js\":\"086da710e419c5aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/syncProcessor.js\":\"4223af418f93a47d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/actions.js\":\"7b092327166b658a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/addComment.js\":\"45220bde66220d25\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchor.js\":\"f3f5b3880d2f76da\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchorState.js\":\"5460d882d7dccb8d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/commentLinks.js\":\"7658bd0f96dfc686\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/confirmThreadDeletion.js\":\"c8ebdb00e5c007a5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/container.js\":\"811867c1d3d4bd4a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/dataExtension.js\":\"b0c1b9770189f298\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/deleteComment.js\":\"7ad6ccd8cbf90717\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/highlights.js\":\"bf1f0aa683c197bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/index.js\":\"0183ad3bc9814384\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/linkedCommentsPill.js\":\"6445e371899e0fea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/margin.js\":\"3e14ecf2977b1b6e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/marginSchema.js\":\"543a6ff88defd956\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/newComment.js\":\"2749c3f85d2d5079\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ownThreadPicker.js\":\"fa59359cbceebe27\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/placement.js\":\"064af9c23c3d733f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/queries.js\":\"2da65ae5c8aa598a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotePosition.js\":\"346184f7aedcac78\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedIn.js\":\"cbc6feb2a7c7033d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedRange.js\":\"f93c345234de5ef2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/rangeRefs.js\":\"1a23505d670d128b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readHighlights.js\":\"e1c6b04947fb76f9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelection.js\":\"bada567c675afa22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelectionUi.js\":\"19c2d2b9753db640\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/reanchor.js\":\"e0ca39ee006089f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/schema.js\":\"dd6faedca6957aee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scope.js\":\"09b7cfcefe93948e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scopeThreads.js\":\"8c017e6428dab519\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/splitRetarget.js\":\"dc35ad504af48a51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestionCard.js\":\"08cdde2a0bba032a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestions.js\":\"59c831bde7d05716\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaries.js\":\"4b6cb6f9a5b31b21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaryBatch.js\":\"9f5e78b20c6425b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/surface.js\":\"f1e32a2c42c1633d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threadNavigation.js\":\"44d474bfca89e39d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threads.js\":\"24cb956b2850b5ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ui.js\":\"958bc87a0b6c39e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/uiStore.js\":\"2e0e39206574ae22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/appIntents.js\":\"b113352b473fe5d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/index.js\":\"eaad3274e472903a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/index.js\":\"6a345091a46f8df0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/status.js\":\"73c9dc323ba85e85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b9f9815781088595\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaBlockRenderer.js\":\"9961cecef334e02d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaDownLaneReplicator.js\":\"cd7f46c056877d34\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaUploadReconciler.js\":\"48483e8bba550f62\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetDownLane.js\":\"0c748e9a07acf73a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetResolver.js\":\"c5ae465010edfaa9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetUpload.js\":\"d7d8a8e7c0dd2c51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/attachmentCleanerIO.js\":\"8c534675d91582fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/supabaseAuditIO.js\":\"97a46f77509085e3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/blobStore.js\":\"b5a0d1a9135601b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/byteStore.js\":\"2c7f6992ba936f33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanerIO.js\":\"2e96a1c0ab67a06f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanupAttachments.js\":\"b02ce14769f6f308\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/dataExtension.js\":\"246bcf8cc008a0e5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/downLane.js\":\"64657b848ea22f89\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/index.js\":\"2d9fac9e0b904701\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/insertImageContribution.js\":\"955433a4e02512ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneArming.js\":\"75b35a988ee8b726\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneLock.js\":\"117a2398a99d5807\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaBlock.js\":\"dc9ed0601445df5e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaCapture.js\":\"a40a04d9a2720ee1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewers.js\":\"abaa9c29ce4bbed5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewersFacet.js\":\"97a390121e7a1262\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/pasteCapture.js\":\"a9a78d521a64b3e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/resolver.js\":\"edb7ff378b5a8d81\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/retryUploadsAction.js\":\"f12ec7a8342032e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/storagePaths.js\":\"1e15877b5d37887e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadDrain.js\":\"0b97846302ceb437\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadLaneStatus.js\":\"d3c7a2c161a34a58\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadReconcile.js\":\"ad0a248ff9134457\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadRecovery.js\":\"55087d37dddf7501\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadStore.js\":\"b3805c1437c635e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/useAssetObjectUrl.js\":\"15a6c7eca9416346\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cfb24cc037c73fe9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksViewSection.js\":\"05d5b48ed40fc3be\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/facet.js\":\"11bbeeab16043a08\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/index.js\":\"d73238c97ff76f33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/prop.js\":\"1ba3774858544cba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinkFilters.js\":\"bb37db933f3c9af9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c6217359d2be6834\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BlockEntry.js\":\"a56cbdfa6b792e79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/LinkedReferences.js\":\"55b7ba7f5813e204\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"928193c53af19204\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dailyNoteDefaults.js\":\"a4d7ae24cb71dabd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dataExtension.js\":\"b7b070fc7cea1af1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/edgeExclusions.js\":\"0b9cbc53627fbadd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/filterProperty.js\":\"3aad6e8e4b83c91b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/index.js\":\"75f317d9e7527754\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"374ddf68c804d3aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/applies.js\":\"0f1618ac2443ba5f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/countQuery.js\":\"ff73f939de142475\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/expansionStore.js\":\"cbe3ac5b412f134d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/index.js\":\"715c167ab5a38c25\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"61accc34f3d831c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/presentationInvalidation.js\":\"0e75edb2eb66db50\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyEditorOverride.js\":\"894abc470e482d11\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyFilter.js\":\"0bcc6eb96f6d8592\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/query.js\":\"1f03be4d12c6c832\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/resolveFilter.js\":\"329e83deb8612dc6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sourceBatch.js\":\"7ae986286f70cf4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sources.js\":\"f67bab2c53669f64\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useBacklinks.js\":\"162d53c448e134e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a48ff1f5f548db59\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayCelebration.js\":\"349d56a08d21a2d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayOverlay.js\":\"7ea6058d5af3eec6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/gate.js\":\"5b091416136e31a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/index.js\":\"68274016fc528712\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/wolfTheme.js\":\"53009822fe9f852e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/BlockDragLayer.js\":\"2f48965c391999fd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dragController.js\":\"7f57c6e5b7ad9455\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dropTarget.js\":\"d55fa6e893f5e8b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/index.js\":\"a0191be3bf8172cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/projection.js\":\"0a67eb1966e44139\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/BlockMetaCard.js\":\"0c0bf542e5c54f7e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/index.js\":\"275a8dc303edda61\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/AddTagDialog.js\":\"f73010a921a58dd8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"9ecb4720bf73114f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/TagNameIssueHint.js\":\"00b054282cc13461\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/addTagAction.js\":\"8f18679af385e194\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/appendTag.js\":\"3e08b03aebd8bcf4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/config.js\":\"d391a80458c26037\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/dataExtension.js\":\"50d3d23895ea5ecd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/index.js\":\"6a6923b4007b25e3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/propertyEditorOverride.js\":\"74f8687d669c3e84\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f036b73c7e872c3d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"91cc0c61b525e3cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b32fb8488a77f6d6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"eb27540227b949ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"88870b8893d244f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/index.js\":\"7e84f9ef7832f70a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d12d5bde665505b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/CharacterCountItem.js\":\"99e2c468f61481da\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/ProfilePropertyEditor.js\":\"41e49e18bd08935a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/actions.js\":\"bc0e9b6cb2eb2d21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/blockType.js\":\"b54a1aab9c18ef24\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/charCount.js\":\"c08020f6564a1b42\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/dataExtension.js\":\"a09c53fcb3b0ab68\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/index.js\":\"fcffdf9f24e35f52\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/profiles.js\":\"a2589856afdc407b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/properties.js\":\"d4ec1ccf8ae8ce71\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/textCounts.js\":\"1d1611cbf79f4c3f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/colemak-keybindings/index.js\":\"ece389b2ac15e005\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/CommandPalette.js\":\"31fdd9d7007f305a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/HeaderItem.js\":\"16ff52d2447e12cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/context.js\":\"4a303eefbb1c4777\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/index.js\":\"79d5de55f54ad4dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/selection.js\":\"a25e23a83724ec3a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/toggleStore.js\":\"9a995e2c4b801751\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/useCommandPaletteActions.js\":\"c1b9d7e183b36e96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/ContributorBadges.js\":\"a2050b0d790c1b31\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/author.js\":\"c7aca9c91af1bf72\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/codeMirrorExtensions.js\":\"afcecfe0b18253d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/dataExtension.js\":\"39206ee58d10942e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/index.js\":\"1f1f243f9514527c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/mentionAutocomplete.js\":\"334b1d96d2c8987b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/processor.js\":\"923e5b99bf810dc5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/profiles.js\":\"7db1b52e15beec78\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/queries.js\":\"659203b430cf279b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/schema.js\":\"f02a6124ce69e9e7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4cc3a4ea31874957\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/followOrigin.js\":\"529164740741d069\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/index.js\":\"d9658807c7161c89\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c602b9214fe83fc0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"526f923c7d7b22c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/CalendarGrid.js\":\"946bb6ae278af391\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DailyNotePicker.js\":\"b6e2fa3c26e7b9d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f1f9bc9be977062f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateNavDecorator.js\":\"16ad37de65ba5639\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateScrubOverlay.js\":\"8f1047736e218f3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/HeaderItem.js\":\"97218189dbc6ca4a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/ReschedulePicker.js\":\"7f862ff66a21d99e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/SpreadDatesDialog.js\":\"de1491e6409871c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/actions.js\":\"64635b03b7c0a84c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/blockDateAdapter.js\":\"7a5b134a9ad6c6b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/calendar.js\":\"eca31d3c2729cbab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dailyNotes.js\":\"970707da67ce3568\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dataExtension.js\":\"913f2945e75ff0be\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubActions.js\":\"b0d785d69f948321\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGesture.js\":\"f91698109ef1d2b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGestureActions.js\":\"20f6d69e5d298d93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9b3c003c99dc0649\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/deletionGuard.js\":\"4af48e733de6823c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dueQuery.js\":\"dc47b91c060dd7ca\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/index.js\":\"c73453b78763efe8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/landing.js\":\"3c6f50e6bf893960\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/localSchema.js\":\"8d4e2d6aea27e0c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/referenceDateAdapter.js\":\"df5252dc68d2184a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/rescheduleAction.js\":\"672a4804d80e42fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/schema.js\":\"110968c9c626bbfa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadBlockDates.js\":\"1be5f4c7b4580194\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadDatesAction.js\":\"2fac00e86e37b4a2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/today.js\":\"468ae95cd23ba410\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b78de5e2a4808657\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"869cddc5cd9aea06\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/audit.js\":\"82201cb5f8132f72\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditAction.js\":\"54e9cdfa79dc860a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditRanges.js\":\"d404414c7a312364\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/diagnosticsSource.js\":\"4e01feceed4b5fc8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/divergenceScan.js\":\"6765b3c3445afc67\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/index.js\":\"740704eb363a368a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/propertyChildrenChecks.js\":\"fb0e23a45b694857\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/referencesMirror.js\":\"f4b6c4b3f29c4c81\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/rowJson.js\":\"f0f06bdf8a433fbb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/schedule.js\":\"4e0e27e32e51fb0d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/store.js\":\"83594d957b919c22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/action.js\":\"1cda8202ca64b36b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/index.js\":\"a15054e7d9dc323a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/plugin.js\":\"9441f15a1e773688\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"497030f1511ec05c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/actions.js\":\"f801678ed952888a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/changeMarker.js\":\"63c5abe01589e6ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/diagnostics.js\":\"6199ff017bb0c10f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/fileSystemAccess.js\":\"5c3edb7782af769d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/filenames.js\":\"8c9251e1ff282bcd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/index.js\":\"4861e7463aa0b423\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/mirror.js\":\"1705f891d9618691\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runLock.js\":\"9fc13c70eb3a4af9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runtimeHealth.js\":\"0b6efd47671090bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/schedule.js\":\"d02a5b494cef80aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/store.js\":\"5ce5ec0bc625ea28\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/index.js\":\"01aa84a39404f8ca\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/themes.js\":\"d13e970e8087bb09\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/facet.js\":\"e04cedabb4dd5a21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/useDiagnostics.js\":\"d31c4e561681b5e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/dismissals.js\":\"195cff5711e0d919\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/index.js\":\"ebc33422873d69bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/status.js\":\"504a9e24786eb747\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/store.js\":\"0f1efe6ca178ffdb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"8cb63b68158ce22f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsSettings.js\":\"cf009e36a753325a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/actions.js\":\"47b463426b9b5a22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/config.js\":\"98f148ed0bcd2de2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/dataExtension.js\":\"fecad8a78bb97640\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/effect.js\":\"1f5d3690f55430ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/index.js\":\"66de42824c9e96c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/propertyEditorOverride.js\":\"c2e81bfe6dd230e6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/useToggleTree.js\":\"d59f3f2173217af1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/ExtractTypeDialog.js\":\"acdf53a1f7a43bda\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c1b45d7a220b2bde\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/PropertyShapePicker.js\":\"7ca4e299d60b3dcb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/action.js\":\"bb3c6764240d578c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/index.js\":\"e171109c82202397\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/FindReplaceDialog.js\":\"d952209f9199db49\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/HeaderItem.js\":\"f40c94c53129ac94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/dataExtension.js\":\"993732145f90a764\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/index.js\":\"406862b50911d1c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/search.js\":\"33e705ba965a6e63\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/toggleStore.js\":\"55b3855a46404b05\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/LocationPropertyEditor.js\":\"dff4ad1ac859c1fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/MapView.js\":\"32a1d1e28e2c464c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/blockTypes.js\":\"49b83fd087ae74d0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/codeMirrorExtensions.js\":\"fa356fe5facc3eba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/createOrFindPlace.js\":\"7dd87974b8af8048\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/currentLocation.js\":\"7bf4efc5f7226179\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/dataExtension.js\":\"f1a848810aa376b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/geoContentDecorator.js\":\"114e73e42bf182f3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/googlePlacesClient.js\":\"7f8dc1b279bcc8f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/index.js\":\"58eee932f289e513\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/locationsPage.js\":\"280d79c9c150da64\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/mapViewport.js\":\"7042172f8f267656\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/pickCurrentLocation.js\":\"1dea3deca8ff328e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeAutocomplete.js\":\"3361b739ae38a2d3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeNameCollision.js\":\"ea8836aaf8856bdd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/properties.js\":\"f633c9a923adc64c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/propertyEditorOverrides.js\":\"da8f340ce118bd12\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/query.js\":\"d23b9e0cdaea957f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/usePlaceSearch.js\":\"205f502fa1c7416b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1b5b1066e2bec3c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3b2e46ad2b27b406\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9f3572aea5d1a212\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/config.js\":\"d105884c371d1b57\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/dataExtension.js\":\"f8fdb2b0b0ea43af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/facet.js\":\"c7076621c9e755ed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/grouping.js\":\"b9d3ef20d1c1bf47\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/index.js\":\"5b669a3748826472\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5885760679c420ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/query.js\":\"bdcce97fc9340c2c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/resolveConfig.js\":\"eef484a233ed5196\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"cac10e16d6a261b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ba59549464f48646\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlDocumentContent.js\":\"b68b1bc10708f1e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlFrame.js\":\"adabd78c0e3dcd6a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/actions.js\":\"ec4bce22b1d3801a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/blockType.js\":\"3ab1486f8c283a4a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/confirmRunScripts.js\":\"8ee50392ce499d51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/dataExtension.js\":\"e7302be5f71a9d25\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameAnnotations.js\":\"0f956d96f92dae46\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameDocument.js\":\"c6c37ace0e5004ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameTheme.js\":\"e789ebbd549e0407\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/index.js\":\"104cb5311813751f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/scriptConsent.js\":\"16b12394ffb55dcd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/sourceMap.js\":\"9722627ad35beca4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/useDocumentScripts.js\":\"b1459a2e48d68af5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/index.js\":\"ca3e29c4b98cca2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/record.js\":\"0ae2efea0f543720\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/recordStore.js\":\"d66e06bdb0f94608\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/responsiveness.js\":\"0dbaef182b3ca3a1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/schedule.js\":\"52b2edb436f4a9e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/sessionContext.js\":\"1430df76ff5a57f3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1e343761562dd887\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"586c24006deb10d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/actions.js\":\"e4cceaa8bf9c5ae2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/config.js\":\"bfa8a0fc7a047ed3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/dataExtension.js\":\"acfae9d4e9a8e070\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/effect.js\":\"8a93d144fecb5a41\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/index.js\":\"3c41009b881e042f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/keyCapture.js\":\"c8d201d710c5db99\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/overrideStore.js\":\"0f3a62348b3c0218\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"fbde7d145351562f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/HeaderItem.js\":\"b92987ca3ae62ac9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/LeftSidebar.js\":\"8a89420d2eadb6c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/actions.js\":\"cc8feaca05662c2b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/facet.js\":\"8a93161b8de83571\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/index.js\":\"4450be19c4e7f2c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/shortcuts.js\":\"028800e6d979f9cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/toggleStore.js\":\"61162478431c61ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/MergePicker.js\":\"ef712057fe2cf90b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/index.js\":\"b847661f14b6f722\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/mergeAction.js\":\"08b0b4dfbbc74205\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/strategy.js\":\"e94add402c9f8d27\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/Button.js\":\"68f73f706c6cdf4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b9e1bd002da6827b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4d4ebb8cf40623bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/facet.js\":\"92b10b967ac3781f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/index.js\":\"69a20184b46058eb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"85ad48bedd29bfcf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/actions.js\":\"00c27e3f1da5f16a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"29dea252ee471351\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ddd3b11f91356536\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/index.js\":\"664be527395cf3ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f46e6a2eebfe6a31\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/blockSubtreeMembership.js\":\"643084d1f506db40\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/contextMenuItem.js\":\"27f4e62349763e68\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/index.js\":\"f5fc876652c9a568\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveAction.js\":\"9c3fb8fbc34c7f50\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveBlocks.js\":\"7ddc14496e9dc1c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/selectionAfterMove.js\":\"bc09156cf4c60580\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/TutorialBanner.js\":\"df2515df6260f950\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/action.js\":\"73a53b2454564196\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/bannerDismissal.js\":\"dfcfceb646d5be2f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/documents/cheatSheet.js\":\"8af00a1923cd9020\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/index.js\":\"c97cf42e159c6bd9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/keys.js\":\"ab0c34bd22952171\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/landing.js\":\"9d28592e45f1cc75\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/outline.js\":\"3d142cf4d4afe8ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/seed.js\":\"984c51f3191a8532\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b7d4ffc93039ff94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/analyze.js\":\"a476e8767273f16c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/diagnosticsSource.js\":\"18d683b6ac2459c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/index.js\":\"738716ecd37d5adf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/load.js\":\"96f87424b1003948\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/monitorRun.js\":\"001f801034e2393e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/schedule.js\":\"eb3a66b263a657b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/series.js\":\"690cdf0218dbccfe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/store.js\":\"3471c7f9abea981c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/trendAction.js\":\"78bc1b3f9a939af2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/verdict.js\":\"f6d6f5ef81877244\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/clickToEditAction.js\":\"e0a0ef229f53a658\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/index.js\":\"399bb5dcb12c8c6c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/interactions.js\":\"5ddcd468bf697ca9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"59aaa7ca935b9648\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGate.js\":\"49a46b52b97ec838\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGateDialog.js\":\"f698fc00b71b347b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/action.js\":\"b74b7507468efd6e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/index.js\":\"4ae4df24307dbeff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/localRunMessage.js\":\"9e929ba38d42557d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/plugin.js\":\"d15b7ad8540dbfef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/progressReport.js\":\"0e2f6fa76caadac3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/sweepProgress.js\":\"3f9804117358c6b0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/FieldRowRenderer.js\":\"572488df956dd0ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/ValueRowRenderer.js\":\"13849173eb76322d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/actions.js\":\"c162a676c1cfc03d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/autocomplete.js\":\"25c1c59bd6a99a37\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/fieldRow.js\":\"c517a7d898e1d43f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/index.js\":\"ac007ea23ee00422\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/referenceWarning.js\":\"425a5f8d5c43d720\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueAutocomplete.js\":\"a143848a05e485ca\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueSchema.js\":\"d0676bff6ec877fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/HeaderItem.js\":\"b01d90160b101c89\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/QuickFind.js\":\"68e0e9a3d86f7557\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/index.js\":\"ac8a9d0e29fa3b7e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/recents.js\":\"483ee101ba174f36\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/resultItems.js\":\"fbb6eca540a5a1ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/selection.js\":\"44cf3e2588cc15a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/toggleStore.js\":\"fbc8bc408e7d5b84\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/HeaderItem.js\":\"f4eef8587198bc55\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/RecentsPageBlockRenderer.js\":\"8af1646095a192c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/grouping.js\":\"07a7133e0f593f59\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/index.js\":\"ace30b7fb133a324\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/target.js\":\"02a84b8eae895590\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/codeMirrorExtensions.js\":\"e03333750ba49217\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/contentPrefill.js\":\"298bb86205f1e1c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/dataExtension.js\":\"6084601d85aead77\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/index.js\":\"756554f94f539a25\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"3b5d538da28fbcda\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/invalidation.js\":\"e66c3e765e77b70f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/localSchema.js\":\"04a84e4c49800a9b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/index.js\":\"a306c4e70162c829\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"49b5b6b1f8aca43e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/index.js\":\"955bcc7a00bcd696\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/referenceNode.js\":\"b8af2769abe99df5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c704a2e6be14af69\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ab77b40727674cba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/index.js\":\"acde041c3829bead\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"07617c8c8e3d19e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ca61e7900e18af3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/mergeRetargetProcessor.js\":\"e1bae722c04375ce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/parseFence.js\":\"8b9a9765882e1612\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceParser.js\":\"e07a69db0b176beb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceProjection.js\":\"cd78ceb214122905\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referencesProcessor.js\":\"a023479f83c2c0fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/renameProcessor.js\":\"ca70e9e0a13f131e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/spanReplacement.js\":\"fd84579c44d36475\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/htmlToOutline.js\":\"b65e526d0c5f03fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/index.js\":\"6a0f9add7505f685\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/normalizeClipboardDom.js\":\"92e24ad7eb654187\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/pasteDecision.js\":\"71400d2f115fae0f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/action.js\":\"60d3e1b16e1ecb8f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/blockIds.js\":\"7360aaa364db0dc9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/content.js\":\"a7141bedcab788e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/effect.js\":\"6dc3cc6d7253530a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/ids.js\":\"69f38a99453a0ed1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/import.js\":\"693081ee702016a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/index.js\":\"d89bc289dce13721\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plan.js\":\"752ac3ccadfa7701\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plugin.js\":\"aa4266329c8cf585\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/promotion.js\":\"1d952a43f4df72f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/properties.js\":\"3497a139479fce54\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/references.js\":\"ca44a371478c0449\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/report.js\":\"4d30b3e353865040\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/roamMemo.js\":\"b9426b8539e09721\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/runtime.js\":\"f6a92cd602478710\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/schemaReconciliation.js\":\"11a4aef0afd2db88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/srsMarkers.js\":\"b12f7facae8de3a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/todo.js\":\"ef8cd08ea92c4f44\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/typeCandidates.js\":\"521f056b53606cc2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/types.js\":\"a17dfa09a313ad71\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/index.js\":\"832d4942f7dbda87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/store.js\":\"8eb5028fe392fa42\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/HeaderItem.js\":\"e323511f6815aed7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ceb4859d7e2df85a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/index.js\":\"c11752b49b678ce1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/model.js\":\"9c6cb9e936688c97\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/toggleStore.js\":\"baca1d2b12d8f662\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/useKeyInspector.js\":\"a4072e29f6a1c6fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"07689d01e740b0ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/ShellDecorator.js\":\"a20402982b3b1233\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/actions.js\":\"bedd662bec57cc08\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/exclusionsFacet.js\":\"03d7b6a72e7d7407\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/index.js\":\"b4a296e772f2fb0b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/shell.js\":\"4399712daf920b18\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/surface.js\":\"17cbbd13eb85446a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/walker.js\":\"51c5ba7db0bcd1a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/RescheduleToast.js\":\"71d9d1613af95aa5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/dataExtension.js\":\"82ab200c43e26d37\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/index.js\":\"c7c90a02a84f5bd9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/indicator.js\":\"861a59d31c0f6932\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/moveSrsState.js\":\"e40d622d64edb436\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1d37cb851069dbda\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/scheduler.js\":\"f499deec5fef83cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/schema.js\":\"357e630fd5237451\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"60d7267a488bf164\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsClipboard.js\":\"82f10f123ae9380a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f4e6363b2fcad223\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a696edd5e3917fab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DeckPicker.js\":\"6cd015cccdc5855a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewControls.js\":\"9c048e98ebbff5b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewDeckRenderer.js\":\"121256fa68ffff47\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewSession.js\":\"19129481162e91c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/actions.js\":\"5a7d65688cb8aaea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/archive.js\":\"d8cfd480354d2d26\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dataExtension.js\":\"7012d9e950b54e26\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/deck.js\":\"8f9306307f7642de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dueQuery.js\":\"54b99178b93bad14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/gradeDecision.js\":\"195e841498336668\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/index.js\":\"004820f708e5c0ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/keyHints.js\":\"f1518774e9634a71\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewCardLayout.js\":\"20ca6e14ccd1d880\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewProgress.js\":\"f9619a807d470970\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/schema.js\":\"bf6dc4c06f56b08c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/useDueCards.js\":\"bb0b41543872cd98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/index.js\":\"74ffe7ac5ce6a1f9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/record.js\":\"cacc65402d951148\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/index.js\":\"ba87fb3f82e16c81\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/persistenceStatus.js\":\"f45d35b808dca71a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/requestAction.js\":\"afbe67da465ade3d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/TypeChipsDecorator.js\":\"869ef7ff7b3deb2b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/codeMirrorExtensions.js\":\"1ce292b5c51f98cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/index.js\":\"6a4dda4c79b40b94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/typeAutocomplete.js\":\"5ea7c28e61ddc027\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f055bfe81e841911\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/actions.js\":\"b15b400d9321f0d0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/anchor.js\":\"7e63d56b0fc39c22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/events.js\":\"173098e05465f218\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/gestureActions.js\":\"3018f8b398273363\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/index.js\":\"bf7bf6d6e9342b9e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"7918af4ca31d88ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/collect.js\":\"3eb3baf36429650b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/index.js\":\"59e5ddc2f957dc0e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/record.js\":\"681398519d623383\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/RejectionDialog.js\":\"86bbc35a109e6ef9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b5e2c65e159e0a09\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/index.js\":\"7d28a01b5320b375\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/model.js\":\"250600eddd9e5e19\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/queueCounts.js\":\"bf63c60c6feb61bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rejectedHelpers.js\":\"ca7b6e72657c0cb0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rematerializeAction.js\":\"384fccca70c48838\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/useHysteresis.js\":\"bf89541ef011bde2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/ColumnHeaders.js\":\"8af2447dd2c1c12c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/QueryUi.js\":\"f88cf88f8f56a0d3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/TableLayout.js\":\"6a916cc005fbae74\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/actions.js\":\"ba58c7f46d3f74a1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/cellEdits.js\":\"71e2fb9c7322c53c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/columns.js\":\"69dedbde124a3f28\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/controller.js\":\"e01ea6c372633110\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/convert.js\":\"919676142fb51bbd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/dataExtension.js\":\"b441a618a0296814\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/index.js\":\"4132d01d1ff6c3a7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/keys.js\":\"7e6691e312964daa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/model.js\":\"53bebd8a47faeb45\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/backfill.js\":\"6f40ac9bf2ba7bf3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/format.js\":\"f2c789b75e9dd598\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/parse.js\":\"b694d903baabcfb6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/queryValue.js\":\"d638261cc98b4a37\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/source.js\":\"a514918b4d02f8c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/registry.js\":\"56c92ebb3ea4f9c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/schema.js\":\"f6b580af74a0a75d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/sort.js\":\"2219be2e7cb8defa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/effect.js\":\"ebd46089cfcd9791\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/index.js\":\"d90313b4faf11431\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/theme.js\":\"f8d27e46be1fc25a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/actions.js\":\"0bada2cf208164c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/dataExtension.js\":\"6db475d27d3a85f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/index.js\":\"6d290cefe9d191f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/schema.js\":\"de8f52b8a46cb8a6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/TouchSelectionLayer.js\":\"894527875a977f79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/actions.js\":\"bbd34948b121397b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/defaultItems.js\":\"7521bdcbe6731850\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/facet.js\":\"c201b43c4bb1d301\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/holdRecognizer.js\":\"6d4bc437dc3652fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/index.js\":\"c41e4c53777127e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/UpdateIndicator.js\":\"92451294fe4db664\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/index.js\":\"1dc67bd5f1b22088\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/loadTimes.js\":\"ddc796338ac9c388\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoNotesRenderer.js\":\"15862747e49e95da\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoPlayerRenderer.js\":\"4a95c960e5e99ef8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoTimeStamp.js\":\"861fa20f92872055\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/actions.js\":\"90795b7d2768f3b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/index.js\":\"b46c1277ba06c8c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/markdown.js\":\"176c87c7bd61df7d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/notes.js\":\"34523f89e3bb8c52\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/registry.js\":\"a91420e83c7bcf3d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/remark-timestamps.js\":\"9fbd0d2c5af47e5d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/view.js\":\"b361ff2364c007e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/LinkHints.js\":\"aefdbab0a44b727a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/index.js\":\"f621d64e07be6851\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/model.js\":\"4d50ff6abb776c0a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/settings.js\":\"42eaf39d34255e49\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/actions.js\":\"40e31381e49c6b20\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/index.js\":\"86e3ac56fd7595e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/interactions.js\":\"0a5d02833dd8ba8c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/workspace-header/index.js\":\"469656753c83b47c\",\"/knowledge-medium/pr-preview/pr-1844/src/registerServiceWorker.js\":\"0e73d614b973566b\",\"/knowledge-medium/pr-preview/pr-1844/src/requestPersistentStorage.js\":\"92a8f5ddd029374c\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authRequestDeadline.js\":\"8ddc7067996be1c1\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authStorage.js\":\"eae904caeffa5ef2\",\"/knowledge-medium/pr-preview/pr-1844/src/services/powersync.js\":\"c9d571363d3a69d1\",\"/knowledge-medium/pr-preview/pr-1844/src/services/supabase.js\":\"44173ca62991b378\",\"/knowledge-medium/pr-preview/pr-1844/src/services/uploadErrorClassifier.js\":\"6f485ff58ae5380d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/ActiveContexts.js\":\"39e2a877ccf9d033\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/HotkeyReconciler.js\":\"2f8083078a7550c7\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/WipeLocalDataDialog.js\":\"a16d6c18f6d5cc68\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionDispatch.js\":\"1b143496fd986ff8\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionRefItems.js\":\"0095c6ad8e00c6ad\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/applyKeybindingOverrides.js\":\"cb1c302f3c316306\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/blockActions.js\":\"9de556fbb9fac4fe\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/canonicalizeChord.js\":\"af941dc286aa9b9f\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultContexts.js\":\"69fb9aea6c36899d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultShortcuts.js\":\"0a7052dc25e9d1ed\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/effectiveActions.js\":\"4d2a6b3af100950d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureAction.js\":\"7e164d62bd14e934\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureBinding.js\":\"0b3812954d702387\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/holdRegistry.js\":\"2c82c42229190b7e\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingConflicts.js\":\"54dc6ee3570a8762\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingOverrides.js\":\"e4b3f051db8e3da8\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/pointerAction.js\":\"5e3c12141269e05e\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/resolve.js\":\"8b85f7b48eca7c25\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/runAction.js\":\"4f779d6416f5343d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/sequenceMatcher.js\":\"30a0eac42a632e7d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/types.js\":\"2be1868cb2703ec5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionContext.js\":\"c5b742376ea5b0bd\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionDiscovery.js\":\"bcd519f7b2e882c9\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/utils.js\":\"6986ec22eebd5aaa\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/bootStore.js\":\"28f1944f89a6f935\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/previewDatabases.js\":\"7eeb4f5c0b6eb122\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/byteTransform.js\":\"214355e143b38961\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/attachmentCleaner.js\":\"664c72c5f9370dc7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/attachmentParts.js\":\"b110ca252149340b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleParts.js\":\"588328c1fa89125a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleRecord.js\":\"5f45a62317bffd04\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/manifest.js\":\"aea1de1589d45d9c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/takeBundle.js\":\"143ab8c5a258518a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/verifyBundle.js\":\"953a5163d7d49c0a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/cleaningStage.js\":\"e48daa96448eddfc\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionKey.js\":\"0c95481af858b13a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionServer.js\":\"0ee3103f2cd7578e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flip.js\":\"ca00646dbce81a0f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flipAttempts.js\":\"7863e132cf8834ea\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/pages.js\":\"6ea502025be6e442\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/preflight.js\":\"8d28b52b43caf3bf\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/reseal.js\":\"fc866d242f60e9cf\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runConversion.js\":\"4f7f3f1d5bacfe6a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runLock.js\":\"470b8a907ee3c448\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealing.js\":\"3e12300dad01d01e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealingStage.js\":\"c516b0a1ee097f4a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/stage.js\":\"f5a1d5e4bec7be61\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/verifyReseal.js\":\"78f2b91252eca983\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aad.js\":\"8df4110c4bafb202\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aead.js\":\"1981dc68f5d24350\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base32.js\":\"66f9448b2647ee4b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base64url.js\":\"8029b16359a3fed9\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/binaryEnvelope.js\":\"2804cd0da2924c56\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/byteAead.js\":\"66b4ad7511e3d9cf\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/canary.js\":\"11fdf042b32f719f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentHash.js\":\"e1ecd313db9e2fed\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentKey.js\":\"59ec5cbf744f4b27\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/derivedIdNamespace.js\":\"df7500480c489810\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/envelope.js\":\"aecbf76bb5e162c7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/hex.js\":\"2d91667fdbfa6be3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/sha256Hex.js\":\"83d77b0217a67a76\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/workspaceKey.js\":\"042bf4264ee30edb\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/conversionState.js\":\"b54d505142bc0327\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0f289104a27fb7f0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/pastedKey.js\":\"f74b134bad5250f7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"22349a69186abace\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f6405330598bf8e8\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/keyStore.js\":\"65dd5a5a4d92d865\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/mintWorkspaceKey.js\":\"f9cc4c68d7f9b78f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/modePin.js\":\"19f9fd94b3529f09\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/openWorkspaceKeys.js\":\"f0520ddc57736a8b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolveWorkspaceEntry.js\":\"34ff5255eb9cdb8b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolver.js\":\"d147b7f592e89723\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/workspaceAccess.js\":\"7d652b94e7cb434d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/transform.js\":\"866be7eea7119793\",\"/knowledge-medium/pr-preview/pr-1844/src/themeBootDefaults.js\":\"4311f0d7635ef3ff\",\"/knowledge-medium/pr-preview/pr-1844/src/types.js\":\"aaac44c4869aa32b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/ClientLocalSettings.js\":\"67aae8deaf1e7808\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/abortableSleep.js\":\"9ff6560c23bc5fd4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/array.js\":\"3b9eb73fe50fcf57\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/backlinkAutocomplete.js\":\"19e622b0e3306d94\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockCrumbs.js\":\"48e395c2cfd1d0ee\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockrefAutocomplete.js\":\"33364ab0cc930f11\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/cadencedIdleJob.js\":\"e8eb9859ef09c96e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/callbackSet.js\":\"02077d38bec184cd\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/clientId.js\":\"ce83c830225ffff7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirror.js\":\"c8eed052e74454ac\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirrorCompletion.js\":\"d35ef732793b3438\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/copy.js\":\"36d7e34949b7d279\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dailyPage.js\":\"6a8f894bd6a961f6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensics.js\":\"7527985b68fb9584\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensicsHooks.js\":\"dc6248bbffed890e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/deleteBlockThroughUi.js\":\"6a501e70da6b1028\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dialogs.js\":\"e3264f167bd24eb4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dom.js\":\"60e23a10982bb786\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/downloadBlob.js\":\"d5fdb357611af0e6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/exportSqliteDb.js\":\"c42b6c25b5baac2d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fileSystemAccess.js\":\"b2130ef2c669d785\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/flipSlide.js\":\"6cd9bf2e4c13b047\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fnv1a.js\":\"f2a0daebf4ec162d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/formatBytes.js\":\"7fcbe2a0705771f4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fuzzyRank.js\":\"c0ee43fdd5a796d7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idbKeyedStore.js\":\"325d48012e8f99b1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idleCallbackPolyfill.js\":\"04512943928371fa\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardAwareScroll.js\":\"9ae5bedd454577d4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardViewport.js\":\"a1e91b490779f188\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/lastWorkspace.js\":\"2327f093971e778f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutColumns.js\":\"47a1112b687c36eb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionDom.js\":\"dcf3c3c52437c4d5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionId.js\":\"9204968d872a4ff5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkClickGestures.js\":\"399cab831c0734f4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkTargetAutocomplete.js\":\"e8c88a0ea48812c6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbCorruption.js\":\"a3e58757d1ade08f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbRecovery.js\":\"fb8f2531c2cb5fe7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/markdownParser.js\":\"be4f6e8b0cfb0924\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/memoize.js\":\"9a90732b058fe706\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameFieldCommit.js\":\"19a3e43207a2b181\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameList.js\":\"46b61a31c7b19dc8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/navigation.js\":\"efb23cf1a233298e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/omnilinerNamespace.js\":\"0b7112ba1e5cf149\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/opfsPageScan.js\":\"2642d1ee7dab5573\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelClearance.js\":\"9d513220ffaa6049\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelHistory.js\":\"c76f85392185b169\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLanes.js\":\"18e31fa0bd89d494\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLayoutProjection.js\":\"57527deee9f54d5e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelScrollAnchor.js\":\"c04ef87b84bbf9d8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelUrlFlags.js\":\"a98e07bc22a06238\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/platform.js\":\"56e69d1608148cbb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/pluralize.js\":\"8446ccfd20505ac5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyCreation.js\":\"f9a0b97b686212bd\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyNavigation.js\":\"79631ec2d11055c6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyValueContext.js\":\"586e6adcd700ce7e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/react.js\":\"8e9fd4b69add0051\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeDate.js\":\"4e479f1c10920bd5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeTime.js\":\"dcb92fad47d2c718\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/renderScope.js\":\"6de46577e73a6a81\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/resolvedThenable.js\":\"1a2972040c4cb376\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/routing.js\":\"9cabf6bab67d196a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/safeMode.js\":\"2980a21c32c3c3bf\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/scheduleIdle.js\":\"5ff2b12838db2c0b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/screenWakeLock.js\":\"0a781599d765adf9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/selection.js\":\"3a126164d6fa5423\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/softKeyboardGrab.js\":\"1e16a7f20611ea11\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/startupTimeline.js\":\"97dbb95acfbb9929\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/state.js\":\"979a1d32ed305f97\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/string.js\":\"242cd437d28f0cab\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/surfaceZoom.js\":\"12fad83c449a80c8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/time.js\":\"62b06761e0a6eebb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toast.js\":\"95f3eb77c9a42a31\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toggleStore.js\":\"cc4acba447f96315\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/untilStopped.js\":\"7dfd32dac4193bb7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/userActivity.js\":\"1bd965dbfa7f5c1d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewTransition.js\":\"910e89a0f1e748d5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewport.js\":\"017efeeb2eb9ded6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/webLock.js\":\"73778256d39df7e8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceRecovery.js\":\"55fe81774fc237ee\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceSnapshotStore.js\":\"9794f0db32e66ba6\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-compiler-runtime.js\":\"5de4bba583d78abe\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-client.js\":\"ac1007589e9a0a65\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server-edge.js\":\"82d31f51f364c117\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server.js\":\"da884010181fbb9c\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static-edge.js\":\"4cb1ccd81df644d5\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static.js\":\"ac5dcaa55b3f91aa\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-test-utils.js\":\"f5d80b08395ff4d4\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom.js\":\"65531d92ff63c203\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-runtime.js\":\"cca0f6b8a2ae20d7\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react.js\":\"01e64caec44553ad\",\"/knowledge-medium/pr-preview/pr-1844/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
