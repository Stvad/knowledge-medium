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
		buildId: "2e9a93e750b8-c5270bfa",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/\":\"083f076c99afd0ae\",\"/knowledge-medium/pr-preview/pr-1844/index.html\":\"083f076c99afd0ae\",\"/knowledge-medium/pr-preview/pr-1844/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1844/assets/FacadeVFS-CdPZJozz.js\":\"95dbbe99d24a85e0\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSCoopSyncVFS-DX-4dq8o.js\":\"f61de067a0052a45\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSWriteAheadVFS-BhUDl6pR.js\":\"90c784d9a94dae31\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-BWUc3oPE.js\":\"dbf8f5c7e4fa691a\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-ikNcdICK.js\":\"13bb89deac0b406f\",\"/knowledge-medium/pr-preview/pr-1844/assets/worker-BeKqn80T.js\":\"95f1ed473eb16e98\",\"/knowledge-medium/pr-preview/pr-1844/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1844/chunks/app-DLyKVrm8.js\":\"a56ba41740fad437\",\"/knowledge-medium/pr-preview/pr-1844/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1844/index.js\":\"bebadeb60912a420\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1844/assets/AccessHandlePoolVFS-A3-OAZnf.js\":\"3594d17686c4670e\",\"/knowledge-medium/pr-preview/pr-1844/assets/IDBBatchAtomicVFS-C6xEtJtD.js\":\"cc1fadd6cbcadeab\",\"/knowledge-medium/pr-preview/pr-1844/assets/MemoryVFS-DVo-dTJ4.js\":\"d8f85a52506fe0b2\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-SUWAzvyQ.js\":\"abf42bf3002268da\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-5cmjl-J3.js\":\"00adf704c198e3ef\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1844/chunks/AccessHandlePoolVFS-CbIpqjEl.js\":\"d8915ee97405d6e0\",\"/knowledge-medium/pr-preview/pr-1844/chunks/FacadeVFS-DAA4byOq.js\":\"17efe684aa074c12\",\"/knowledge-medium/pr-preview/pr-1844/chunks/IDBBatchAtomicVFS-B1J4t1ke.js\":\"780ea815a3cb0adb\",\"/knowledge-medium/pr-preview/pr-1844/chunks/MemoryVFS-hNH5wmqN.js\":\"ac658aa12e982d1c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSCoopSyncVFS-Bu_ePqEE.js\":\"6e4d1d0a9c5c1cee\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSWriteAheadVFS-BbAB0r-C.js\":\"9cad3be027ee8724\",\"/knowledge-medium/pr-preview/pr-1844/chunks/Preview-AjRQbQFK.js\":\"64e24bbf1de33c68\",\"/knowledge-medium/pr-preview/pr-1844/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/card-Ba5FKJn1.js\":\"e19a77e23482fcd1\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-WSxFpROg.js\":\"2254b27ceca13440\",\"/knowledge-medium/pr-preview/pr-1844/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-CnUpQEJl.js\":\"21a79808d9b496a7\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-async-CvGrzZ_c.js\":\"9692696160d7f73c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-BGPGRKr6.js\":\"f579099192c64fd1\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-BJZtmH60.js\":\"431a1e0147e24bd3\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-C8yg91EJ.js\":\"b580a233dcdcacf5\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-CoFWAtXd.js\":\"c89a34a7b829c37c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-CqmDiBhA.js\":\"3e8871f02d0d3d19\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DVXecgT2.js\":\"33b2f0fccd9f1a20\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DhUCvTGr.js\":\"1cd7da61339b103a\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-N0i7h5ce.js\":\"273d77109dd7d5c3\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server-legacy.browser.production-B7rYia1j.js\":\"c07bffa79c4a7aeb\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.browser.production-A05z_qv3.js\":\"829b436b46d023b8\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.edge.production-103oxHLC.js\":\"c6461d0c7af39c85\",\"/knowledge-medium/pr-preview/pr-1844/chunks/server.browser-Cqs_jMIK.js\":\"b8b5bff3faa1feeb\",\"/knowledge-medium/pr-preview/pr-1844/chunks/textarea-DfE9QckF.js\":\"8bb4303bb2592e23\",\"/knowledge-medium/pr-preview/pr-1844/chunks/ui-WT2Wv8CF.js\":\"b15a4d3aa5a3601f\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-BvEzlTnI.js\":\"5393f551905b546c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-async-Xadwtb4r.js\":\"bafc79d117cd8e66\",\"/knowledge-medium/pr-preview/pr-1844/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1844/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/src/App.js\":\"7ca34b92649d9652\",\"/knowledge-medium/pr-preview/pr-1844/src/appUpdate.js\":\"4cd82896f6d412ff\",\"/knowledge-medium/pr-preview/pr-1844/src/appVersion.js\":\"603b4622ef2fd891\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/initialLayout.js\":\"837327d10985d206\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/openWorkspaceData.js\":\"37363c2cbd09e81e\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/resolveWorkspace.js\":\"92ed0c3a5a7dbed6\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/workspaceBootstrap.js\":\"6b6d002ea2a5f853\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockComponent.js\":\"c47f21a022c473f8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockCrumbs.js\":\"0fd37033d14bd969\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockEditor.js\":\"c938751ed4009227\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockLoadingPlaceholder.js\":\"550076c25d105595\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockProperties.js\":\"56e040faecb06d3d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockSearchPicker.js\":\"1e71b333d2da34df\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ConfirmBulkDeleteDialog.js\":\"c22373c972208c0d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DividerHandle.js\":\"f302dec13a0a2900\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DraftEditor.js\":\"c1208c64ccaa3dbb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/GutterPill.js\":\"f7cf52b8f24e35af\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Header.js\":\"1016429b94b73c44\",\"/knowledge-medium/pr-preview/pr-1844/src/components/LazyBlockComponent.js\":\"c1651b0010b351d5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Login.js\":\"45c93a506a148fe2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ZoomableSurface.js\":\"3dfaf497ed3411e0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/editModeKeepalive.js\":\"72c1f4751c21574c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyDisplay/PropertyDisplayScope.js\":\"2203d747dba51fce\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7898d24ea81f2128\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefPropertyEditor.js\":\"865a0b09e9fd7848\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefTargetTypePicker.js\":\"9f6baeccda053b4f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/SelectPropertyEditor.js\":\"d0176dbaac36bfd6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/TypesPropertyEditor.js\":\"c02e5113e50e31ed\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/defaults.js\":\"78c1fb8c2763efc7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/kernelValuePresets.js\":\"07dea93fff11d943\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/selectablePresets.js\":\"fdb4416a807c8a66\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/typesPropertyUi.js\":\"aecb77b3a03dc8eb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/AddPropertyForm.js\":\"fd93ab7068ae1653\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyPicker.js\":\"c6d08b1f5239311d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyRow.js\":\"f529302028e914a2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/Rows.js\":\"8dd075e324904d20\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/actions.js\":\"48a7d5ab04d75b82\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/declarationOnly.js\":\"d2293238defb8bd5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/layout.js\":\"56b5b62599131d35\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/model.js\":\"3e8b3a180cd1f825\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapeUi.js\":\"4ff89e7a2d20b626\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapes.js\":\"cc7844cf116ea1a7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1363184d3f7f9833\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/visibility.js\":\"31f955b19da7cc86\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanelSections.js\":\"041cd098fbf5fcf0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockEmbed.js\":\"492327a399491d49\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockLink.js\":\"94bc6569fd44f1f6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockRef.js\":\"c93cd10235c83fd1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/ReferenceLink.js\":\"e13eb3338664caa4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuard.js\":\"1de1d59f403409e6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuardContext.js\":\"e155d41350061b79\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/linkInteraction.js\":\"5f5787fea3aaabbe\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/referenceLayout.js\":\"9d34de3e249463bd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/useBlockRefAncestors.js\":\"f78d1854704c29b8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockGutter.js\":\"072238654ba0ace7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockInfoDialog.js\":\"6f7ba23b493f02e0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockTypeBlockRenderer.js\":\"d24ee8bb00bc0ee6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BulletHoverCard.js\":\"12caae9a8766f578\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorContentRenderer.js\":\"b4546cdafde0bf65\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f22ca327bae30a9f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ColumnResizeHandles.js\":\"844dc883d60265ea\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"83f9b1229eb8b201\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/DefaultBlockRenderer.js\":\"10e90f038f2be8b8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/LayoutRenderer.js\":\"3fb777cb1e0aa4c6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MarkdownContentRenderer.js\":\"0c2dccb8fdcaf4b2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MissingDataRenderer.js\":\"1611638da64b0235\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PanelRenderer.js\":\"d3451745212894aa\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PropertySchemaBlockRenderer.js\":\"73aef57db95a8672\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/TopLevelRenderer.js\":\"7e51d1ad37491567\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockGutterMode.js\":\"b75b12ab55ef7c16\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockTitleText.js\":\"06aada078cbab39d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/fieldCreationKeydown.js\":\"64b7e03648e4977f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/layoutRootContext.js\":\"e1bae352a3be025b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/TypeChip.js\":\"f35737d575fe7740\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/chipStyle.js\":\"37abc4a6474a83aa\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/anchored-floating.js\":\"b2237088e547734e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/button.js\":\"162b5db5e940d46d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/card.js\":\"b0ee94fdef8f23df\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/checkbox.js\":\"1bd93a30b910ea09\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/collapsible.js\":\"3547abe867df6129\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/command.js\":\"cb786a145e4780cb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/context-menu.js\":\"ea85d060d09aca8a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dialog.js\":\"3cb0b64c4b42fafc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dropdown-menu.js\":\"0f1cb4b69858298e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/floating-listbox.js\":\"32c23c50b7f2c24d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/index.js\":\"02d6884ec95cf006\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/input.js\":\"fc415d11f63912d1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/kbd.js\":\"f5815661e00a10d2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/label.js\":\"6419f40fa3f12060\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/textarea.js\":\"abd1ab2fdf73075e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/useEditModeYieldKeepalive.js\":\"3ccf15e221c1d05f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/BootFallback.js\":\"9ebab12efb90daf2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/FocusedRowLazyMount.js\":\"b5a1e36626729b44\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LazyViewportMount.js\":\"5b0351e022208ddd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LocalDbCorruptionFallback.js\":\"79e30fed809a3497\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/error.js\":\"569460f1bded833e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/lazyMountRegistry.js\":\"623260740d4b4bc9\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/suspense.js\":\"d612a53895b3bf7e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/CreateWorkspaceDialog.js\":\"9fa89ffa29be5b41\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/PendingInvitations.js\":\"efb7e61a9efd5ccf\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/SyncProgress.js\":\"8427e52323f23ba0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/UnlockProgress.js\":\"2e77307008e483dc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceKeyGate.js\":\"7a68ce9cb4e7daba\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSettingsDialog.js\":\"b82c30b4859e7fb9\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSwitcher.js\":\"5d17bb767b8b6d07\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSyncGate.js\":\"9a7937db9b72db57\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlow.js\":\"43333060fc9fbb9a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlowHost.js\":\"b86dd4948918d7cc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/EncryptionSection.js\":\"8c1800a505094e4f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/attachmentPrompts.js\":\"6206b6cc1f78248f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/bundleFolderPrompts.js\":\"253725284a78a129\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowDeps.js\":\"f0484c757e7a17bd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowStore.js\":\"b5529e66c263168b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/flowUi.js\":\"6536b072937aa942\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/useConversionRun.js\":\"0743ca680674174b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/keyUi.js\":\"5fe72c0fd984549b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnKeyLoss.js\":\"9e48a7f6762d1b1a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnServerE2ee.js\":\"191435ea0381895b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/workspaceUnlocked.js\":\"659f4c46771df824\",\"/knowledge-medium/pr-preview/pr-1844/src/context/backgroundSubtree.js\":\"8af221e86ff8c613\",\"/knowledge-medium/pr-preview/pr-1844/src/context/block.js\":\"ef1ddcf6713dc979\",\"/knowledge-medium/pr-preview/pr-1844/src/context/layoutWsContext.js\":\"2f9a936d6448762a\",\"/knowledge-medium/pr-preview/pr-1844/src/context/propertyDisplay.js\":\"ee5512fe6ce54339\",\"/knowledge-medium/pr-preview/pr-1844/src/context/repo.js\":\"7b637c03b385202e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasClaim.js\":\"91fc7b25b98ec2e5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasSeatNamespace.js\":\"5f29a7af493ac88a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockData.js\":\"ca2c8ddf297b9b18\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockType.js\":\"a3de08f5a2714dc9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/changeScope.js\":\"e2c4067549695914\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/codecs.js\":\"b26300bbf292efbe\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/derivedData.js\":\"9a1f7c5d4b7507f4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/errors.js\":\"88714b495306ad6a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/events.js\":\"f876802fbbcb5636\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/handle.js\":\"09c63286364e6b8b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/index.js\":\"1c909d27c0f7545f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/mutator.js\":\"519de61b98b45477\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/processor.js\":\"8bd372be9d363f90\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/propertySchema.js\":\"1da30ce1216eb60c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/query.js\":\"5f083f7aae573a60\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/sameTxProcessor.js\":\"5f3656595416fe6f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/schema.js\":\"09c63286364e6b8b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/tx.js\":\"09c63286364e6b8b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/typedBlockQuery.js\":\"a204bf998b83a7e1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/user.js\":\"fbd664fc1dd4bc40\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresetCore.js\":\"76e58558adfa1aad\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresets.js\":\"44b8b4570140ada4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/attachmentCleanerIOVerb.js\":\"9e1c63fa1a82efc6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/block.js\":\"37cf37b5dc94fceb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockCache.js\":\"71d8fdb5758373e9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockId.js\":\"25709531c3f529c5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockLiveness.js\":\"2f51923616efdba0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockMerge.js\":\"60b664ba44d73c4a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockSchema.js\":\"48bba5c8dfe7ffa5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypeLookup.js\":\"d68e322618e31b40\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypes.js\":\"527f74f8b81dc9ad\",\"/knowledge-medium/pr-preview/pr-1844/src/data/clientContext.js\":\"97cafaf2cd0c4d7e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/dbFileSiblings.js\":\"852017c19239c6cc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/definitionSeeds.js\":\"c2c7757ea8782be1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/derivedIds.js\":\"5f0eba1e9d0c3391\",\"/knowledge-medium/pr-preview/pr-1844/src/data/drawnSubtree.js\":\"6eefc99ae5b4494c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facetBridge.js\":\"397418bfc18cf376\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facets.js\":\"9ec75f8cea682cd0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/globalState.js\":\"db0b8637d1ea4bd1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/aliasClaimRederiveProcessor.js\":\"07384e150db7db3b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/ancestorBatch.js\":\"d17424881f461bbb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/blockTypeTypeifyProcessor.js\":\"a81ad6e5ac059e84\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/clientSchema.js\":\"cbbb43659f1100cd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/commitPipeline.js\":\"b14a480288033b01\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/devAssertions.js\":\"38f161dc88e184ce\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/firstSync.js\":\"23660f64b6e08943\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/freshInitialLoad.js\":\"83df299e797a34a8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/graphBackfillClaim.js\":\"7c3d73ea19546520\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/handleStore.js\":\"c311f4d8200e8b49\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/idleMarkerJobs.js\":\"015d0fb45cd729e4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initialDownload.js\":\"56edd7347f96fa97\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initializeClientDatabase.js\":\"aef77e66c7f68faa\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/jsonCanonical.js\":\"dffb3c6bfde3cf1b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelInvalidation.js\":\"1d30ec2d40baa61e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelProcessors.js\":\"5cc605966de213d5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelQueries.js\":\"8f8ae5dd34824bd4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/mergeTypeMembershipProcessor.js\":\"fd1b1e75f1fdf150\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/normalizeReferencesProcessor.js\":\"fef5b34f1ee3cb0c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/poolInstrumentation.js\":\"3fb4bffa2d0d3753\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/processorRunner.js\":\"47921d7ca855519a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyCellBackfill.js\":\"b25c30bf2c7c3e3d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildMint.js\":\"8249db440cb594dd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildrenProcessor.js\":\"1f22283ce9666a93\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionChangeProcessor.js\":\"43e31933a703b65d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionSynthesis.js\":\"3b9851719a4bffc7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyKeyScan.js\":\"465856f4b92c5fbe\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertySchemaResolution.js\":\"d53e01ee5c8ca9e1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyValueEdits.js\":\"e7339dc35b79e1e5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/raiseProtocol.js\":\"f1f69f45e77cc9a5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/readBatch.js\":\"37a6ae47c05e7962\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/refProjection.js\":\"42a588cb5577923f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetLookups.js\":\"e876868216a560c7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetProcessor.js\":\"20fe4c19d1504c5c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/replayMerge.js\":\"d06e2f03686871e6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/sqlBinds.js\":\"3b22eae390fb5184\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"97b04d9590a5c22f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/arrivalProcessors.js\":\"b8808765474ad3c9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/invalidate.js\":\"14dd2aa023013e1a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/materialize.js\":\"19ea913d4ab1473d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/observer.js\":\"cc2970b0cef1b03a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/reconcile.js\":\"9bc6562f26e4d0dc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/timingMetrics.js\":\"b02e698c7e93e581\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/treeQueries.js\":\"4705bf9c6f056d75\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txEngine.js\":\"040147bb531f63c7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txSnapshots.js\":\"a92da596f162f4e9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/typedBlockQuery.js\":\"c4749aeba6a7eb29\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/undoManager.js\":\"bde6d7a30c20712a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/invalidation.js\":\"c511e30f2be8395b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelDataExtension.js\":\"b0b071f5f9955f34\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelPage.js\":\"27f151fb92bd0f95\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelValuePresetCores.js\":\"a85df49a2de47a2e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbCorruptionSignal.js\":\"c9e1b6010137db1c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbStorage.js\":\"d8526dfcd82f1c0e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbVfs.js\":\"fd676809bbaacd1b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localSchema.js\":\"2faf79c8fa174f18\",\"/knowledge-medium/pr-preview/pr-1844/src/data/maintenance.js\":\"211fcb22388fc9b8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mergeProperties.js\":\"baabe82e3851fdaf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/metricsConsoleHook.js\":\"447fae84e7f080de\",\"/knowledge-medium/pr-preview/pr-1844/src/data/migrationsPage.js\":\"e34f69ac67459505\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mutators.js\":\"cd2829320083b939\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKey.js\":\"7b3f54d7a297f8e7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKeyPlacement.js\":\"97cf464ce50f7ebb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/outlineSurface.js\":\"131b49343bf5ee26\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingEditorContent.js\":\"5b12ba3861192662\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingUploadsSql.js\":\"f6febbdb77e1b521\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pluginStateExtensions.js\":\"6981a6cb5c83f54b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/powerSyncLogger.js\":\"2ba7d70c2f226eec\",\"/knowledge-medium/pr-preview/pr-1844/src/data/projectorRuntime.js\":\"2ada9e28703ffa53\",\"/knowledge-medium/pr-preview/pr-1844/src/data/properties.js\":\"dc8c7aed0e16229a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertiesPage.js\":\"e5cfa4dabcea2c29\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyChildren.js\":\"066f6e0e0f842494\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionFanout.js\":\"36bd0edd888e0c2d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionMetadata.js\":\"6f971183de58e258\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionRegistry.js\":\"455a8b4546a39aba\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDisplayMode.js\":\"a394a38b2dd72dbd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyRowCreation.js\":\"8e0920ab947df97b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySchemaCreation.js\":\"cdd65b3cc9b8b643\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySeeds.js\":\"f2f00b0d85d1cf8a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/recentsPage.js\":\"73b57c8a89ab6f2e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/referenceBlock.js\":\"9b856f0b1ed92432\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rejectedUploads.js\":\"eaa683a2e1125913\",\"/knowledge-medium/pr-preview/pr-1844/src/data/releasePowerSyncConnection.js\":\"2e5ffa7ac56e1acf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repo.js\":\"0ff59ce37bd6cc4a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repoProvider.js\":\"3f1c05a3181d21f2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rowProperty.js\":\"4fa095cb6068e4c3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/searchFilter.js\":\"9abec33c0bb20370\",\"/knowledge-medium/pr-preview/pr-1844/src/data/seedIdentityLedger.js\":\"1c97bc6b2ea6da4d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/stateBlocks.js\":\"393b7631cd39cdec\",\"/knowledge-medium/pr-preview/pr-1844/src/data/structuralEditPolicy.js\":\"2015b898864d954c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/subtreeDelete.js\":\"9d762443b3efa2e8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncStreamLock.js\":\"7c7f1d17d16faaec\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableSqlRecognizer.js\":\"1f86f39ba577cbf0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableWriteGuard.js\":\"7f42f20165dcd4a2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/targets.js\":\"cf495872b84cfff7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeColors.js\":\"d06e6c9cef88a5b5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionMetadata.js\":\"dd7299c17e713e7e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionRegistry.js\":\"49a715b833239abd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeExtraction.js\":\"66fec7f0d058c9dd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeInitialValues.js\":\"8865967d2045fd5d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typePropertyGroups.js\":\"ed0800ed0a7dbe27\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeSeeds.js\":\"65c50278e4d2ca1c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeTagger.js\":\"7401488cf854497e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typedRecords.js\":\"f8b5a6192162a93c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typesPage.js\":\"ecfa6c7ef9d3ba19\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userPrefs.js\":\"ae1cd10b4953232d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userSchemasService.js\":\"b77e3f62ddd6d901\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userTypesService.js\":\"87971d8f1ed2a7f4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/valuePresetRegistry.js\":\"1b24199ecc021285\",\"/knowledge-medium/pr-preview/pr-1844/src/data/visibleChildren.js\":\"d93617dc27a23287\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceConversion.js\":\"71b59f1cc05baa4b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceFirstSync.js\":\"b6e26efbb278c5f7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceIdNamespace.js\":\"c2498806642bfb1c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceSchema.js\":\"ea9f055fe925cd61\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaces.js\":\"5c743a6df706c464\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadLog.js\":\"60e5e1dc4e16389b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/BlockPasteShellDecorator.js\":\"313a170f1e5ba905\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/atTrigger.js\":\"0fddb74e683f2397\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/autocomplete.js\":\"498aa99a5b2ed1ad\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/codeMirrorExtensions.js\":\"4696485f46ac7a94\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/contentFlush.js\":\"9f269dd615878d4a\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/defaultInteractions.js\":\"c359c5f84c50aeb7\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/editSettleSignal.js\":\"05d48cd55822736b\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/insertImage.js\":\"59e7c84627aa6a56\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceCompletionRange.js\":\"d1b24d8f9aaa65c0\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceTargetTypes.js\":\"47ee846115fc02b0\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/syntaxContext.js\":\"6a0ad073a0a42a01\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/triggerMatch.js\":\"29cc62413f4910a7\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/AppRuntimeProvider.js\":\"7057fc8fc55ac1d0\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/BlockFocusShellDecorator.js\":\"8ee65b153a68fe24\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/ExtensionRenderBoundary.js\":\"d896db36cb962850\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/PanelContentRecovery.js\":\"7922ac4c92471f90\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/apiCatalog.js\":\"5e305dc782fd570e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/approveExtensionHere.js\":\"8bc13d4e8f83e8e8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/armedCutAppMount.js\":\"9227e3d325030ece\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/batchableKeyedStore.js\":\"ffcd2e5dd2049c07\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockInteraction.js\":\"028be43b61dea10d\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockSelectionAction.js\":\"db25fe39a70207a8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compileExtensionModule.js\":\"4345ca83e6971a5b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compiledModuleCache.js\":\"b329e6db1590f100\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/continuousGestures.js\":\"453a174860f424e4\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/core.js\":\"acef7c11838657ef\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/defaultRenderers.js\":\"2a662e71d5f75ffd\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/definitionFanoutAppMount.js\":\"05368e7e3b9642c6\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dialogAppMount.js\":\"2ba540ccf8438b47\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensionSeeds.js\":\"57ecc3835e063ecb\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensions.js\":\"8553f648a6bedb11\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/exampleExtensions.js\":\"4c7b0a4ab1e9464f\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionApprovalStatus.js\":\"a79709efc116dac0\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrorToast.js\":\"e947ffc723b6f4ec\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrors.js\":\"274bddecb2789460\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLookup.js\":\"775a20afb18f4659\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionToggles.js\":\"d56172f3e6f04c63\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionUtilitiesCss.js\":\"79a6aa8c74c0847a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/kernelPageDeletionGuard.js\":\"74cf967ba2c6a898\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/liveRuntime.js\":\"0a219629f621cf2a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/openExtensionsSettings.js\":\"dc6fd48cf2f33400\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/overridesCache.js\":\"c2b8b68aed3a48f4\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/pluginIds.js\":\"9092daf886849fce\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/processorRejectionToast.js\":\"87a0457a7534c6d9\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeActions.js\":\"bcc67399c5300da8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeContext.js\":\"a11db1348ba4a4d1\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticAppExtensions.js\":\"5e563702f34d5ce7\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticDataExtensions.js\":\"cc8949e1e3f33787\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/toastAppMount.js\":\"38cc543a49d17307\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useOverrides.js\":\"a535e06ff5b3d904\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useShortcutSurfaceActivations.js\":\"0be8b0218b85ea30\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/discoverToggleTree.js\":\"fd63d015ba0a668d\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/facet.js\":\"3a0d6671e7a4c304\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/resolveAppRuntime.js\":\"7b17384d67a89d5d\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/runtimeEvents.js\":\"00fd54100d43f6af\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/togglable.js\":\"679582f1d01a81cc\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/variantFacet.js\":\"805c30c1a393b7a0\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/verbFacet.js\":\"54a872219c7be067\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/block.js\":\"484da0d86d2bc89c\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/focusedChild.js\":\"5813da11e9792eaf\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/propertySchemas.js\":\"e0270926459b7fc6\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/typeRegistry.js\":\"ff55aefb72c3e987\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAncestorCrumbs.js\":\"32fb22f005aafc80\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAutocompleteListbox.js\":\"db57f8f76fafb417\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedSearch.js\":\"83be55155569a582\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedValue.js\":\"202b3f04c9e667f6\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsFocalRender.js\":\"2315d0545c1218a0\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsReadOnly.js\":\"c87bc715bac6d204\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMaterializeBacklog.js\":\"d66a8dc4c399e45e\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMinuteClock.js\":\"f867faed012f266d\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePanelLayoutProjection.js\":\"83928a9f8e9caa9a\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePendingInvitations.js\":\"3f0d5fe6f77ef5eb\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRendererRegistry.js\":\"733ea580e00113c2\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRetainedFieldRows.js\":\"cdb331d40958c1ed\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useWorkspaces.js\":\"f8384a148e70eb9f\",\"/knowledge-medium/pr-preview/pr-1844/src/lib/utils.js\":\"dc0dee484d63d703\",\"/knowledge-medium/pr-preview/pr-1844/src/main.js\":\"58baf5eac43cc328\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/MarkdownImage.js\":\"592e98fcc5ff579d\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/blockSeparators.js\":\"a6477d2cb81d31cd\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/context.js\":\"c4e0c03c76845f33\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/defaultMarkdownExtension.js\":\"854472b8abd3d695\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/extensions.js\":\"955cac39bf06ef5d\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/renderMarkdownHtml.js\":\"4f33d5cbdf7d2803\",\"/knowledge-medium/pr-preview/pr-1844/src/minimal-editor.js\":\"3bf74999f4aa34c4\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/armedCut.js\":\"dc34e00a819aaa24\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/captureMediaVerb.js\":\"af122cd23bad24e9\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/clipboard.js\":\"003eab87f865abeb\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/decision.js\":\"ce37630a17feb84c\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/operations.js\":\"498078e54c1b58ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/AccountHeaderItem.js\":\"8f1b7cbc5563f327\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/index.js\":\"2e8756dd2f43a3d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ee9f5ecff979f990\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askAgent.js\":\"d20b63b4584e3cb1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askedStore.js\":\"653e41ebffed9681\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"92904a047d50a07c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/chipState.js\":\"1430faafeff16b12\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/dataExtension.js\":\"84f3db06222b5125\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/index.js\":\"111395f8cc86fe42\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"63d7e9122085fbaa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/schema.js\":\"588d0e8b38fca524\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b2a98ac201114cac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/BridgePairingDialog.js\":\"87054e1a376f5c81\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/addMedia.js\":\"29d12a70f8558a8b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7b0a665121cd7a30\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/block.js\":\"5380840d389032b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/context.js\":\"69e713605c7d54c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d31578deca1d4dbb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/index.js\":\"5c1d02a0d266f0ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/outline.js\":\"fc74ab0d4d9fde93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/properties.js\":\"42fe6b5838ff3329\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/refs.js\":\"34715c6b82e17eb0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"fab5879c93c2b414\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/search.js\":\"0083dac58ed3bea6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/shared.js\":\"582ba56dec9e2364\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8c07e84eef9c6b9c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/text.js\":\"3e3420f8c124d0ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentWrites.js\":\"d4bb51002d767139\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/authoringCatalog.js\":\"58a0221c3e9daf3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/blockRefTargets.js\":\"25f6b5e55cc50547\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridge.js\":\"6cbdd7ad798282dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridgeLoop.js\":\"436a4ddfa4fbaa73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/changeHistory.js\":\"56645298f2c06d19\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commands.js\":\"cedd11b812b497fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commentsCommands.js\":\"79eb7805a26da98d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataExtension.js\":\"c289a9fa1915bedd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataModelGuide.js\":\"44af67b8c23effed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/describeRuntime.js\":\"12e9c81011342225\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/extensionLint.js\":\"d7d5ed059a599f35\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/grainAudit.js\":\"a01fb821dc9e9f59\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/healthCommand.js\":\"b49e7682473b5a1c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/index.js\":\"e707812548520a5d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/presetIdentity.js\":\"8db7b5dd1e60960d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d2ea28498aa81e79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/readMedia.js\":\"3e71b77a69c443c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/schema.js\":\"3e35bfd0339d3c48\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/serialization.js\":\"177ca36176e1c431\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/targets.js\":\"332027f97d4c53bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/tokens.js\":\"6c07fc1028f0dda2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/watchEvents.js\":\"2d78a63754be4b27\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/workspaceGuard.js\":\"a0babb7a71bec578\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/writeCommands.js\":\"a2649265a1ffcd5e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/AliasCollisionToast.js\":\"a40b9f52887c8c60\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/DuplicateNameBanner.js\":\"54a20ab8b341bbaf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/collisionMerge.js\":\"88df9f9f12390b84\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/dataExtension.js\":\"867f7902b0a71975\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/index.js\":\"3deaae5895939b32\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/mergeCollisionAction.js\":\"c084e9854f171da8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/pageStyling.js\":\"c4f62dc310670405\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/rejectionToast.js\":\"6b10e0952f5384e5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/syncProcessor.js\":\"dfc19ef2d8c57c17\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/actions.js\":\"f13a347c047aef38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/addComment.js\":\"3920f1eadabd2258\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchor.js\":\"57d2adbebb47d0af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchorState.js\":\"bbaa1418ddc2ea6c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/commentLinks.js\":\"18f251ae08174400\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/confirmThreadDeletion.js\":\"1fec66a4868220aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/container.js\":\"cc927d2b7879de99\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/dataExtension.js\":\"b91f155c52692f69\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/deleteComment.js\":\"0f6c10327e3b017d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/highlights.js\":\"648be790a915c848\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/index.js\":\"f69101e786385277\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/linkedCommentsPill.js\":\"45614ab7d1a30cc1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/margin.js\":\"4b0bfd935e810c2d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/marginSchema.js\":\"93b6c7e4230630c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/newComment.js\":\"91d3482914602cb5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ownThreadPicker.js\":\"b542977b48936e12\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/placement.js\":\"b584c851f3dbcedd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/queries.js\":\"7b1481db363dbfe5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotePosition.js\":\"98742c3a28c8f573\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedIn.js\":\"1b052051a540ab01\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedRange.js\":\"46b70df608dc08a7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/rangeRefs.js\":\"0d48b5b780a073cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readHighlights.js\":\"0b038ecb6c060ef9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelection.js\":\"a31a62b240fe8145\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelectionUi.js\":\"6b5524a07e011974\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/reanchor.js\":\"9cde2b11e4018eb4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/schema.js\":\"a0b3a2123ca28f5c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scope.js\":\"e10ab3fa096f9955\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scopeThreads.js\":\"d1fbbd2d60d70f10\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/splitRetarget.js\":\"3d7a3192bec6f9e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestionCard.js\":\"0ae8ebf55e6340a2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestions.js\":\"54ff09ff20974750\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaries.js\":\"dd0401c42766c866\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaryBatch.js\":\"0464912fc1c2e536\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/surface.js\":\"d26d01c7b3c1bf63\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threadNavigation.js\":\"8691db8cc15282dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threads.js\":\"78b1c1fb5675f1e6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ui.js\":\"1966a99d42a1be13\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/uiStore.js\":\"d59f1e438571f7ed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/appIntents.js\":\"fb603260bee3efb5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/index.js\":\"efbf353babd352fd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/index.js\":\"b4b78785764243b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/status.js\":\"3286ad85afca465d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3f9995d2fb5726a5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaBlockRenderer.js\":\"139d63125b5cf14d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaDownLaneReplicator.js\":\"76a5a83bf7027405\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaUploadReconciler.js\":\"a991935c873d0bf0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetDownLane.js\":\"ffe2b163bb16c34e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetResolver.js\":\"78e0dc91f24a39fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetUpload.js\":\"4df8461d3d3eee8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/attachmentCleanerIO.js\":\"133ed7ad3b5ba4ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/supabaseAuditIO.js\":\"87cf6bad6e91b177\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/blobStore.js\":\"a940e6149905ed1f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/byteStore.js\":\"0e785c32a7e256c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanerIO.js\":\"e7968482b491c513\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanupAttachments.js\":\"2a8ea950dbb1f193\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/dataExtension.js\":\"d82bfdcc1d582dcb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/downLane.js\":\"f75127fdb77de8b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/index.js\":\"2f25245279d803f3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/insertImageContribution.js\":\"dbf595980aab7b97\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneArming.js\":\"41a360046a4d0a8c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneLock.js\":\"44d8d6e555dcec31\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaBlock.js\":\"b710f3ab43f123a5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaCapture.js\":\"4074efe0f2a6a300\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewers.js\":\"2885aed4f7186b74\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewersFacet.js\":\"c8bbc7daca12e783\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/pasteCapture.js\":\"60e568a49925e508\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/resolver.js\":\"a079976e37c916eb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/retryUploadsAction.js\":\"f6ceaf384e50429f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/storagePaths.js\":\"78396cc4bc048c0f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadDrain.js\":\"fa980a88b179c03d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadLaneStatus.js\":\"43bfb3e8d37844d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadReconcile.js\":\"407a885c9c0aa94b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadRecovery.js\":\"bb9195eff1cbedad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadStore.js\":\"7d77eb1d8ff23791\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/useAssetObjectUrl.js\":\"f3ffffb5fe369e12\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ab0fd63e225a3c67\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3823fb2912cb9a0e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/facet.js\":\"b32ab5305e483961\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/index.js\":\"00594261aca86d06\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/prop.js\":\"ea6a25afacadd90d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinkFilters.js\":\"dc89c7df11a627b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d4937bae34e6c697\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BlockEntry.js\":\"4fe3bf5a48f2f850\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/LinkedReferences.js\":\"cd454b2c1608dd7d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e975268d9ff3a044\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dailyNoteDefaults.js\":\"1bc9eae88e2a859c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dataExtension.js\":\"b7917cca42eea989\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/edgeExclusions.js\":\"783e12242dd7cd94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/filterProperty.js\":\"004605f4002483a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/index.js\":\"413c34aa7e0e46ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2264a841529cd95d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/applies.js\":\"c0f948747bc05651\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/countQuery.js\":\"4010f03054aba213\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/expansionStore.js\":\"bee3f1c002b35f96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/index.js\":\"5553940b38db7232\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b2b0cf84de4f5225\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/presentationInvalidation.js\":\"05f6b94898d4ddcc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyEditorOverride.js\":\"772d7e4cac7d55d7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyFilter.js\":\"4edbf4fc71568952\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/query.js\":\"9f02c73f33e0b357\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/resolveFilter.js\":\"db34c75434fbdd4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sourceBatch.js\":\"b02c23981746f250\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sources.js\":\"55249ddebe91274f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useBacklinks.js\":\"8d997900f64b608c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"938a4a3b6de64ee0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayCelebration.js\":\"d651b55875a4298a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayOverlay.js\":\"a83a2a39a54c5927\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/gate.js\":\"5ec84cdc81d80f47\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/index.js\":\"62eee1a40367f9db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/wolfTheme.js\":\"a466b50538f13ac9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/BlockDragLayer.js\":\"5acd932546abdb8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dragController.js\":\"1cb62d078c078746\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dropTarget.js\":\"c41e02da7c0db6af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/index.js\":\"295e93336f8acbe2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/projection.js\":\"0d107e1b6ea421f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/BlockMetaCard.js\":\"967b507e1d332282\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/index.js\":\"716ac9a974e8bef2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/AddTagDialog.js\":\"b5dc4ef84d7ed42e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c2721062b0899e03\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/TagNameIssueHint.js\":\"4cb7f89adde81712\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/addTagAction.js\":\"8007ac0c1ca3f8ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/appendTag.js\":\"10631b60d4b55883\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/config.js\":\"58e9121b31107db3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/dataExtension.js\":\"e9bbbfe76ae7eacd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/index.js\":\"7d75cbab20a7d304\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/propertyEditorOverride.js\":\"74e506f3b0da8f45\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbList.js\":\"520de5a4d51b11a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"eeb1fd50e1e1af9d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/Breadcrumbs.js\":\"77199bab51d9721c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b79ae1e5ed67e7f6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"62969008e5e13848\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/index.js\":\"df4c706a03127cae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"af15d7212a02fe97\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/CharacterCountItem.js\":\"86d0979210defbd3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/ProfilePropertyEditor.js\":\"332f78155a56c9b4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/actions.js\":\"afbb55a9f2b3e5bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/blockType.js\":\"4fa5025f2f2e7c66\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/charCount.js\":\"0f520b33f71722d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/dataExtension.js\":\"971179b150b44cad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/index.js\":\"ccdf5f65c6913028\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/profiles.js\":\"708d23af174b4cba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/properties.js\":\"8430cfb0639dd81f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/textCounts.js\":\"186abd06a785c6fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/colemak-keybindings/index.js\":\"08aa99add4a12cf4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/CommandPalette.js\":\"7a094554f3b6e899\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/HeaderItem.js\":\"f0a58e617a066c5e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/context.js\":\"b03de9c965d570c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/index.js\":\"5fec090aeabfdf9b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/selection.js\":\"2ae172ae6abf72de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/toggleStore.js\":\"d6e6d09ad901bdee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/useCommandPaletteActions.js\":\"4d0fbe426dac1b01\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/ContributorBadges.js\":\"86aa8881e9a72375\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/author.js\":\"bbb46927421389b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/codeMirrorExtensions.js\":\"18db2407d7319698\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/dataExtension.js\":\"77fdca390eb813ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/index.js\":\"45d978a0ca223016\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/mentionAutocomplete.js\":\"4df991107385cd09\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/processor.js\":\"7c02269500f378e6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/profiles.js\":\"641b46042a11c355\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/queries.js\":\"ea96933900420c72\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/schema.js\":\"a3e0b4ac2e6e574b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e986d459d65bcb01\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/followOrigin.js\":\"158e4eb7fe426868\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/index.js\":\"a9d4c730de6e5ed3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"313511d3efac4d20\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"63b2323183318548\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/CalendarGrid.js\":\"af258e35cd1b36b3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DailyNotePicker.js\":\"fda0767c3c249997\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7ac79f676d7dfb7c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateNavDecorator.js\":\"09ac0852011c927b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateScrubOverlay.js\":\"f28b60871423999b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/HeaderItem.js\":\"2bb8c6e815ae2615\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/ReschedulePicker.js\":\"bdad452a964c73cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/SpreadDatesDialog.js\":\"edf49eae98831a92\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/actions.js\":\"a82f30fe5bd81b08\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/blockDateAdapter.js\":\"07cd5546908673a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/calendar.js\":\"84847b674a873c9d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dailyNotes.js\":\"68839a892cf784b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dataExtension.js\":\"b39eb527c95c296b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubActions.js\":\"1da85d072de3dbfc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGesture.js\":\"626703260929681f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3ca379f43d9b69ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f2d330636df78cb0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/deletionGuard.js\":\"77d4ab9614611d88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dueQuery.js\":\"8d06d2698a996e8c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/index.js\":\"f589421a639c8579\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/landing.js\":\"75b0bf7d531f6d5b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/localSchema.js\":\"c5a2c367465cfa10\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/referenceDateAdapter.js\":\"99bbb65b930f8ca4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/rescheduleAction.js\":\"9e95232de82ab0bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/schema.js\":\"9281e313f596b9b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadBlockDates.js\":\"0cee32ad8ad7c71a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadDatesAction.js\":\"d49125a415191f79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/today.js\":\"19d0efa1bb8e4540\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f4da21641c666902\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"105b0f6cba603cb7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/audit.js\":\"ef2145e67c65e7e4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditAction.js\":\"a2413905cb32bcb1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditRanges.js\":\"3ce8f5dcf51a43a5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/diagnosticsSource.js\":\"afb851fa5664d614\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/divergenceScan.js\":\"21edfdb977af41ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/index.js\":\"53af1733386b9fca\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/propertyChildrenChecks.js\":\"1be3895d11d6228f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/referencesMirror.js\":\"9ff37533fabc05aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/rowJson.js\":\"66b344dd08935c2d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/schedule.js\":\"6449b7375f800a1d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/store.js\":\"fa8e0a4cfd2de531\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/action.js\":\"67ae5587dcec59e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/index.js\":\"b682c9de75087a4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/plugin.js\":\"c71f3cf51ddcd08c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bf7efecced52bf52\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/actions.js\":\"ce59a1192c76aaba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/changeMarker.js\":\"0bf52400eeaf446a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/diagnostics.js\":\"697d7a095ee402e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/fileSystemAccess.js\":\"67fe82d807ba9954\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/filenames.js\":\"1b41e2aa59219d25\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/index.js\":\"449cbbfc47a3165b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/mirror.js\":\"716fa63112266fe5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runLock.js\":\"c2b8df0ed9a9ec36\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runtimeHealth.js\":\"166df2059ad6dc4b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/schedule.js\":\"59cf786ee3b75e0b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/store.js\":\"097104b010591042\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/index.js\":\"740fde5847f240dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/themes.js\":\"ad69ab86632dfe89\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/facet.js\":\"0a2d4b3589473183\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/useDiagnostics.js\":\"392be2fdb8b924db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/dismissals.js\":\"022d907243595321\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/index.js\":\"03416ac7a5336e16\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/status.js\":\"b5d12191b8d1af54\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/store.js\":\"16d4f411bf5b26c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"719576e80213dcc4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsSettings.js\":\"1171d7a96604b9ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/actions.js\":\"53be3cbafd02db5a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/config.js\":\"a7dd8375a0093b61\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/dataExtension.js\":\"407b368a5d632cbf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/effect.js\":\"151609c33adcb93e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/index.js\":\"f622b93c2120089b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0d20fac6ab5f4bfc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/useToggleTree.js\":\"fc2b8140495a7c15\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/ExtractTypeDialog.js\":\"7402f0af148cc9b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f990684dcb2d2e73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/PropertyShapePicker.js\":\"fd6e39dc9cc92f5a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/action.js\":\"53717ba95a81ad26\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/index.js\":\"87cd063f9f05372b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/FindReplaceDialog.js\":\"a2699ae58262d1d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/HeaderItem.js\":\"73b6b021268c03b0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/dataExtension.js\":\"b3e5a514e0230f92\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/index.js\":\"7efe2fe1b922fbfd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/search.js\":\"eaa5c2b3da9ab611\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/toggleStore.js\":\"63fd0355ae48b80c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/LocationPropertyEditor.js\":\"358ea4988ea76814\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/MapView.js\":\"905c93b2f921c37a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/blockTypes.js\":\"d0d586e19e66b169\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/codeMirrorExtensions.js\":\"273cdd5a24dcdf86\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/createOrFindPlace.js\":\"ef32a098e711ec6c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/currentLocation.js\":\"1755d790031bb11f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/dataExtension.js\":\"4331743b233035bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/geoContentDecorator.js\":\"9642b2063b7904e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/googlePlacesClient.js\":\"6dfa44338fd2f51c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/index.js\":\"5580241f63a1b3b3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/locationsPage.js\":\"27c0c55e7ad56b8b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/mapViewport.js\":\"654f223e894f9640\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/pickCurrentLocation.js\":\"ff55aac6e94ee32c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeAutocomplete.js\":\"fefb9871da501aeb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeNameCollision.js\":\"d99ed66328c6670b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/properties.js\":\"36a89fbfce89adb2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/propertyEditorOverrides.js\":\"3e3be7843331d48e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/query.js\":\"008650776bf46733\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/usePlaceSearch.js\":\"a565467cdd3ab565\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c93957fce2fd4bfd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"8e57d9673c9c539f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ff1ea51db8a6f4e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/config.js\":\"85432aa7f299c43c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/dataExtension.js\":\"eb9fe424068d1443\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/facet.js\":\"f2bca26ac7d6025e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/grouping.js\":\"7eef79dfc0efb632\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/index.js\":\"ffafba5f288e7953\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2705b99bc888fe29\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/query.js\":\"7e5962232626344f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/resolveConfig.js\":\"9af4bc8953dfa97c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"499f845fa387ede3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8b63f0212ca4a202\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlDocumentContent.js\":\"596573d6f06b10bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlFrame.js\":\"e9059ff00cab323d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/actions.js\":\"3e1676e1c309eea7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/blockType.js\":\"cda18a893dc663c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/confirmRunScripts.js\":\"5688277d6e7ebee0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/dataExtension.js\":\"90fbf32b5793754a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameAnnotations.js\":\"f7c8f1bcc06a4529\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameDocument.js\":\"1e61a9fb05953816\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameTheme.js\":\"0f659a2179a31cec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/index.js\":\"d39a6d2a42ec3ce7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/scriptConsent.js\":\"d04246fdda909170\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/sourceMap.js\":\"39713f924b910fdb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/useDocumentScripts.js\":\"78cfafe74e381546\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/index.js\":\"0d7e086838267dfc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/record.js\":\"622f278b1d28e86e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/recordStore.js\":\"ce74fc0cdc3d0aaa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/responsiveness.js\":\"8b2d4e9c1b70184d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/schedule.js\":\"21f2365c9992a1d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/sessionContext.js\":\"983fee9a5e3b992c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2085b30bc8a6f7bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3f2db9d490571074\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/actions.js\":\"2a3cd1656cb4ed3f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/config.js\":\"eb1a09b4d1af3e4b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/dataExtension.js\":\"648305b16f209ee4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/effect.js\":\"d28966a8ea7f3d09\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/index.js\":\"2ae923d9ace41eba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/keyCapture.js\":\"379be4874de18f11\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/overrideStore.js\":\"ed1406ea1b2272b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d0bf9be5eb4f3df0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/HeaderItem.js\":\"cc5ae4c3a0eabac9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/LeftSidebar.js\":\"862bc3a171704686\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/actions.js\":\"1d3c55855f7c70c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/facet.js\":\"0d866b826fd3638c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/index.js\":\"7f48cae16226b66d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/shortcuts.js\":\"fd0a59ad3e8209f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/toggleStore.js\":\"5552f29d4789e26b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/MergePicker.js\":\"8ffd17bcff13de08\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/index.js\":\"972630c3b62bff8e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/mergeAction.js\":\"fbd61ee3cd0d114a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/strategy.js\":\"20a9268cc1c7116b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/Button.js\":\"67a0af54ecab97d3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"389058e04bf7f689\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/defaultItems.js\":\"715d64d5a8701e4e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/facet.js\":\"e2d7c5644b5d7848\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/index.js\":\"695447809dd0781f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"7de6f981669c1b6a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2070f921b24c8bc2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"18c24d0ecb940a76\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/facet.js\":\"29f59b75706af714\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/index.js\":\"367c097a84575644\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/MoveDestinationPicker.js\":\"196e0b41675e71c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/blockSubtreeMembership.js\":\"09799c52893a8a20\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/contextMenuItem.js\":\"899cf893eb1f7dae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/index.js\":\"729a0aac3e87cecd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveAction.js\":\"585e42cd315d35f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveBlocks.js\":\"9ea5caddf52edf64\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/selectionAfterMove.js\":\"b5c7c07251d0c2c1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/TutorialBanner.js\":\"5dde16c996f3b897\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/action.js\":\"ab92088845ec076b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/bannerDismissal.js\":\"a1aceff1a5aa0abd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/documents/cheatSheet.js\":\"3cc6cb81ad5fc96e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/index.js\":\"a7a4100d2006fba5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/keys.js\":\"191b5bfd53663179\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/landing.js\":\"4f7b4e0e50907c3f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/outline.js\":\"11d1d754672d5293\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/seed.js\":\"7ab2ba704e69e3e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/PerfTrendDialog.js\":\"84d47fd90e7f96f7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/analyze.js\":\"870c11e1d901c36c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/diagnosticsSource.js\":\"98e0706c56d80360\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/index.js\":\"d4288e594357d8ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/load.js\":\"e421ec90f0671a0a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/monitorRun.js\":\"be6f8e251e3ba3fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/schedule.js\":\"574a16d8bc3f99a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/series.js\":\"80be236f306518b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/store.js\":\"0da655aa11dd7e8d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/trendAction.js\":\"5ddb3b8a8df1734d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/verdict.js\":\"609ca380809b8b70\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/clickToEditAction.js\":\"fc886e18724008d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/index.js\":\"73878516bb2676fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/interactions.js\":\"8145c5f83f2ba2e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3e454b3955f09b2f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGate.js\":\"84e5be2f46ed5b41\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGateDialog.js\":\"b6a7251821a0652b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/action.js\":\"a10cde1e89b71fab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/index.js\":\"432cd7ff5ebc7795\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/localRunMessage.js\":\"7897fc3de47bc1ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/plugin.js\":\"defe391c8cc28b83\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/progressReport.js\":\"03a5fedac55390d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/sweepProgress.js\":\"568e474ff7270c82\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/FieldRowRenderer.js\":\"794589e469fc397c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/ValueRowRenderer.js\":\"e5713d154deb9836\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/actions.js\":\"713c83f4f4a91386\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/autocomplete.js\":\"4af1e264b4fea114\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/fieldRow.js\":\"e799188e7c2a109b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/index.js\":\"2383d9c65b0854a2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/referenceWarning.js\":\"731d70b93cd620d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueAutocomplete.js\":\"3fe683da3a090e57\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueSchema.js\":\"f0031eb77ce8d278\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/HeaderItem.js\":\"e7df8c4b768932dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/QuickFind.js\":\"6b4283d5b772806a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/index.js\":\"f08e0fdb1459ccc9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/recents.js\":\"dc68f053482c2be7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/resultItems.js\":\"784ee45702e806f6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/selection.js\":\"e8962109dd1ee7b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/toggleStore.js\":\"eb69eb81f743fe13\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/HeaderItem.js\":\"5ab045caa9800bf3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/RecentsPageBlockRenderer.js\":\"71cd1b16950ebd92\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/grouping.js\":\"c3bc9f0ac987a86f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/index.js\":\"50b28278d2c54737\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/target.js\":\"90a546fa050d83ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/codeMirrorExtensions.js\":\"65738f148927c8d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/contentPrefill.js\":\"cfa832f8a0ea53c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/dataExtension.js\":\"841664e53ebeba85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/index.js\":\"89db93025311d70b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5a5f0d6fb39e36be\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/invalidation.js\":\"ff8035300f04fbf5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/localSchema.js\":\"43030662e4f04694\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/index.js\":\"ef2682dafdb1bbb2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d55ba3ea8691d08a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/index.js\":\"272baa886b120b88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/referenceNode.js\":\"bf8e6329b2b0f341\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5f1149d175d48612\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c1ce4524f864793b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/index.js\":\"09df592c72054131\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bfc3c2864672fffa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3f1964a614c41094\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/mergeRetargetProcessor.js\":\"8ffa03516a81b36b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/parseFence.js\":\"50213ee0f3f4e6ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceParser.js\":\"6ad6b68946530ccd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceProjection.js\":\"60c655e3e2420a53\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referencesProcessor.js\":\"e193f223854581fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/renameProcessor.js\":\"b2cf740cf7fc1c79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/spanReplacement.js\":\"0978b4bf23f0ace6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/htmlToOutline.js\":\"a099cfdab62860d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/index.js\":\"112c923996f97ab1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c34d4bd3bf9dfbc8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/pasteDecision.js\":\"b00aff048ff0ae59\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/action.js\":\"6f636a3b2694412e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/blockIds.js\":\"7c1b38c9c1fc78d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/content.js\":\"6ddf15bea7e1fce4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/effect.js\":\"7dfc5e0add4804b3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/ids.js\":\"8666b5d4edd2cf6b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/import.js\":\"aa1ccc30a1ceaef6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/index.js\":\"f3f7d6aabeebb7ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plan.js\":\"e3c6b827a43ce2fd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plugin.js\":\"92d9015dbf70de0f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/promotion.js\":\"5a831a3fb7925c26\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/properties.js\":\"3b6fca1f68751f37\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/references.js\":\"c338dbc762704e3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/report.js\":\"2536254de5d655d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/roamMemo.js\":\"c45b6de8d70bb1f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/runtime.js\":\"8e4c3e47a125b98f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/schemaReconciliation.js\":\"1c16f7da6902a958\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/srsMarkers.js\":\"4c99740c254cf67d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/todo.js\":\"64a44427c53d6138\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/typeCandidates.js\":\"2c5d3ac2c712d4e6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/types.js\":\"fd53a182a0c2bb06\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/index.js\":\"a96829a7a0f36ceb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/store.js\":\"42aeb0dfcef0ddf4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/HeaderItem.js\":\"bb876cbf06e44766\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"bcd4bb4f19379a26\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/index.js\":\"a51bd53be30ded91\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/model.js\":\"7fb37305cb71a089\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/toggleStore.js\":\"1acb29120155f630\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/useKeyInspector.js\":\"98503e13b0fb4184\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c84ca098a97b9999\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/ShellDecorator.js\":\"82a6403b62aff17e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/actions.js\":\"b5b6ea9cd6b93e04\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5c1dc06f9a5f7a8b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/index.js\":\"e2ed2e509bbe2c01\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/shell.js\":\"2ff7a28bd60e39e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/surface.js\":\"d2adcfc20d43bc3d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/walker.js\":\"7d0f96290ab07d5b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/RescheduleToast.js\":\"03ef7bc31b54dafc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/dataExtension.js\":\"074014291a7b8fff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/index.js\":\"648c03376fa91aa6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/indicator.js\":\"98cc0d1cd8b357ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/moveSrsState.js\":\"a512315378f185cf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a4da62144adc1568\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/scheduler.js\":\"6deb7c0f4d3f4b5d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/schema.js\":\"5a605562e44bcbc0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3714c86d24500e21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsClipboard.js\":\"9594aa429f7b8344\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"cd513db2e55eb502\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b356c2c722ac8c29\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DeckPicker.js\":\"dcae7d1e41254c86\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewControls.js\":\"7147b69adb3e6836\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewDeckRenderer.js\":\"970a333dc4475f76\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewSession.js\":\"385aa30b6893e2cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/actions.js\":\"4ecb5538f7396f18\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/archive.js\":\"aa853ebcd789b5f9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dataExtension.js\":\"cdd551de07ed7aae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/deck.js\":\"134e5a4c83827c92\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dueQuery.js\":\"d9c19d2a9f148a49\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/gradeDecision.js\":\"8f49be387c1231b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/index.js\":\"a503977af56a6970\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/keyHints.js\":\"10b018a2f1395e41\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewCardLayout.js\":\"ca010b64d0db99d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewProgress.js\":\"d3b1bcb65046f936\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/schema.js\":\"8156f093505c4d16\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/useDueCards.js\":\"ff331b3ef8c9e880\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/index.js\":\"e24aae49d34db66e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/record.js\":\"37cfe83aed3eecd9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/index.js\":\"5c9bdc0b8f2924ae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/persistenceStatus.js\":\"84ed250d81383f74\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/requestAction.js\":\"2502a0d7c773a3d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/TypeChipsDecorator.js\":\"5a423a48853578d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/codeMirrorExtensions.js\":\"95516750f2bc3baa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/index.js\":\"9da115c6cf2454c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/typeAutocomplete.js\":\"42655d4b71a6f8c1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"663928865acebb2f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/actions.js\":\"a4fb60cb40067fcd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/anchor.js\":\"466fa2c0366b2d4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/events.js\":\"a89d71145f0078c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/gestureActions.js\":\"3bc028f7bb5c7c4f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/index.js\":\"565f7bfd2a7d331d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9ffd82304834bd37\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/collect.js\":\"d83b35795b2a39f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/index.js\":\"108c6b25aa74c805\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/record.js\":\"1da42a1bd78a2040\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/RejectionDialog.js\":\"9483a71bd227fefb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/SystemStatusHeaderItem.js\":\"456359db3136d225\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/index.js\":\"01a9cd1db0ae9e3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/model.js\":\"6831496d80d98b31\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/queueCounts.js\":\"5e62e24e4e9876cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rejectedHelpers.js\":\"055a628978db038b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rematerializeAction.js\":\"9e9e17895556265a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/useHysteresis.js\":\"f557f5f0d0f737fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/ColumnHeaders.js\":\"7888ca0389e5ee88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/QueryUi.js\":\"5790d6f81538ca0e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/TableLayout.js\":\"51bb5dbdca08e588\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/actions.js\":\"f2989ca52d15cc71\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/cellEdits.js\":\"0212578bf2b8f51c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/columns.js\":\"0e743bbd1b636418\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/controller.js\":\"392b47f331888920\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/convert.js\":\"fdcb2f8a923f1146\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/dataExtension.js\":\"7930d9f8440c3123\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/index.js\":\"1b2fc6497398c14e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/keys.js\":\"ea797e769e15eb49\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/model.js\":\"296520ff01877316\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/backfill.js\":\"3716c66deec320c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/format.js\":\"c324b671526770b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/parse.js\":\"26c7e451a5eaada2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/queryValue.js\":\"1434abfdc02800db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/source.js\":\"bcaed4312c66290c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/registry.js\":\"a300b231964f8245\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/schema.js\":\"ece8df6f2977c9a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/sort.js\":\"f38ceff9befba842\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/effect.js\":\"0ae7a70da98cb604\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/index.js\":\"b605166894b40ffc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/theme.js\":\"fc08abf98698c7af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/actions.js\":\"23b340f1dcbc3927\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/dataExtension.js\":\"a5bcf1996ab4ba8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/index.js\":\"c168f39e06affbb5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/schema.js\":\"03aade86a00cbc05\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a3b5af390d660838\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/actions.js\":\"46947215333acef4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/defaultItems.js\":\"1278e26a0affb86a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/facet.js\":\"a73e817e54e02177\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/holdRecognizer.js\":\"1d76084cd4e28fc4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/index.js\":\"fd66915e2ef6ffed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/UpdateIndicator.js\":\"e60b2d7719a2afcc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/index.js\":\"b1b54beba4b90915\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/loadTimes.js\":\"fbc1a17e0f2d8074\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoNotesRenderer.js\":\"6ac196a2bd35af29\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoPlayerRenderer.js\":\"68bb3d888527b2d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoTimeStamp.js\":\"f1a8067dc489e866\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/actions.js\":\"ae54fa3a6920362b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/index.js\":\"bd308e1b8eefaccd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/markdown.js\":\"d2f21ad360986ae5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/notes.js\":\"9c685e1b68622405\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/registry.js\":\"80385bb3866bbe7d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/remark-timestamps.js\":\"6213413d186cd774\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/view.js\":\"6f345397aa7c03bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/LinkHints.js\":\"22c9a2dbe24d9834\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/index.js\":\"a251dd7525f85369\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/model.js\":\"d9d2d47fd97a953c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/settings.js\":\"c816e3a9a2ce920a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/actions.js\":\"47a10412eb32a0a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/index.js\":\"596afa08d67c5879\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/interactions.js\":\"9485289abe0272bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/workspace-header/index.js\":\"c70dd3a36312444c\",\"/knowledge-medium/pr-preview/pr-1844/src/registerServiceWorker.js\":\"87aabbf243456b6f\",\"/knowledge-medium/pr-preview/pr-1844/src/requestPersistentStorage.js\":\"d888eb117a9c5124\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authRequestDeadline.js\":\"42e732beae179a79\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authStorage.js\":\"36e79dd4004a2a72\",\"/knowledge-medium/pr-preview/pr-1844/src/services/powersync.js\":\"bf62830bc75d95be\",\"/knowledge-medium/pr-preview/pr-1844/src/services/supabase.js\":\"2a6d1ebe0241af2e\",\"/knowledge-medium/pr-preview/pr-1844/src/services/uploadErrorClassifier.js\":\"597cdd45c8db7d92\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/ActiveContexts.js\":\"d13b714e709113b2\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/HotkeyReconciler.js\":\"915dadb4b2e65eeb\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/WipeLocalDataDialog.js\":\"8bc6211af5d33c8e\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionDispatch.js\":\"3df3d0072796578d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionRefItems.js\":\"82bf8f78485616e6\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/applyKeybindingOverrides.js\":\"d356de98d4457ead\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/blockActions.js\":\"9f24e9155e3b36d5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/canonicalizeChord.js\":\"3dcc45f68d661748\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultContexts.js\":\"63c7d4eae9fd9a10\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultShortcuts.js\":\"3bd28665ac805200\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/effectiveActions.js\":\"c915fb3544add6a7\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureAction.js\":\"8a37b9e9a130f3f1\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureBinding.js\":\"1b94d790b2e94851\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/holdRegistry.js\":\"8777f94dcdf24a56\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingConflicts.js\":\"3afa049e36425da8\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingOverrides.js\":\"1958d9abe30053f2\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/pointerAction.js\":\"8ae51709c5171fc3\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/resolve.js\":\"7429375eb49da421\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/runAction.js\":\"9d742a0822fff8c6\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/sequenceMatcher.js\":\"f99613002bdb5333\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/types.js\":\"ff2c190b1373da3d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionContext.js\":\"7ec497c675eae9fa\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionDiscovery.js\":\"3ea63e980e61003e\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/utils.js\":\"5678a8349d3fd69c\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/bootStore.js\":\"691e2c20556cd084\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/previewDatabases.js\":\"fd118f007364fd11\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/byteTransform.js\":\"52a98022ec656044\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/attachmentCleaner.js\":\"c394c53372d9a462\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/attachmentParts.js\":\"8d96e92161f53d3f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleParts.js\":\"8544c34eeb1cac5c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleRecord.js\":\"4f18a46bae3e55cb\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/manifest.js\":\"d2d4bb303f49e61e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/takeBundle.js\":\"0d9dc266a7471978\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/verifyBundle.js\":\"829d06c282e32541\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/cleaningStage.js\":\"a8158a21c3c06045\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionKey.js\":\"ab4933b7a1483b35\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionServer.js\":\"22b0145b3dcc1817\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flip.js\":\"08e3ea1895d29b58\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flipAttempts.js\":\"225b3bdfaf5d76c1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/pages.js\":\"0f81e8b90e39631b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/preflight.js\":\"8f4dd06d797f4772\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/reseal.js\":\"380e21071416b24e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runConversion.js\":\"374551db08ccb46f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runLock.js\":\"645216ed0e867730\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealing.js\":\"0ba1200f62a517ae\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealingStage.js\":\"a04097aa9c6f4ac7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/stage.js\":\"b5cde58d7d410fa5\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/verifyReseal.js\":\"bb8d6ae24dc9d606\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aad.js\":\"44294b22c87153f1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aead.js\":\"9688c0c6f4c469f3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base32.js\":\"1c5ca2e8d78f70c0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base64url.js\":\"94c462d1dfdab0fe\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/binaryEnvelope.js\":\"5007a09473ee216d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/byteAead.js\":\"646f251114713f27\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/canary.js\":\"5b00f2bea82d5df1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentHash.js\":\"bd28b2384c6786c2\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentKey.js\":\"65750891d5aecf99\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/derivedIdNamespace.js\":\"e426c5c3a53da39d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/envelope.js\":\"b5f595d4af94f1cb\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/hex.js\":\"51a205f244832458\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/sha256Hex.js\":\"6d43cce89639b033\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/workspaceKey.js\":\"05c9534d66f8d47f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/conversionState.js\":\"026446e3b0411bc7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e45884855d92dff9\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/pastedKey.js\":\"945973290421e7b8\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a65c0826cb6779d5\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/upgradeWorkspacePin.js\":\"449d4ae1240c3a56\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/keyStore.js\":\"3b37d77256b350da\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/mintWorkspaceKey.js\":\"a4aac04a4e8d24b8\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/modePin.js\":\"b5898154bd505f51\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/openWorkspaceKeys.js\":\"ab6bbe74486a722f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolveWorkspaceEntry.js\":\"9957035145b7f201\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolver.js\":\"998ca4821fb886c3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/workspaceAccess.js\":\"e65b6b1d7e8e3ae6\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/transform.js\":\"b608984f66469a60\",\"/knowledge-medium/pr-preview/pr-1844/src/themeBootDefaults.js\":\"5c2f217d2e174c38\",\"/knowledge-medium/pr-preview/pr-1844/src/types.js\":\"ee7b7945421eba15\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/ClientLocalSettings.js\":\"a08deec1e0c81d1e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/abortableSleep.js\":\"60fa9b345ae0ffb1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/array.js\":\"3895e47117b1c814\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/backlinkAutocomplete.js\":\"3ef0283c45825a3d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockCrumbs.js\":\"9441e5992e70a0f2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockrefAutocomplete.js\":\"1e76c631d430c5d7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/cadencedIdleJob.js\":\"94d067c3654c8a20\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/callbackSet.js\":\"22c6ef78a44f42cf\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/clientId.js\":\"6549fcc183ecbe68\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirror.js\":\"01c46f947b7f01ba\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirrorCompletion.js\":\"b5ec921bebbeaee6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/copy.js\":\"09e2faec515b0723\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dailyPage.js\":\"0141207e5bcf54ba\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensics.js\":\"b8fff293b403507b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensicsHooks.js\":\"7735a1e6517231a2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/deleteBlockThroughUi.js\":\"235e25ae129addb5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dialogs.js\":\"be5012fad036fb07\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dom.js\":\"30c5088997d37f14\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/downloadBlob.js\":\"2e4d9051e0ad531a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/exportSqliteDb.js\":\"16de350e540d589b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fileSystemAccess.js\":\"a2b87844ec447b43\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/flipSlide.js\":\"0d1bf8ba0f6f0cd9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fnv1a.js\":\"d36317111ead9bbe\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/formatBytes.js\":\"7ae3a79b1d297071\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fuzzyRank.js\":\"0b392241c8ed6da7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idbKeyedStore.js\":\"bf376b658a6e6dbd\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idleCallbackPolyfill.js\":\"d4fd82ae7b361e93\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardAwareScroll.js\":\"e68937c4de963f23\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardViewport.js\":\"62fdddeebadede02\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/lastWorkspace.js\":\"ba85e523efb30cf0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutColumns.js\":\"8a402c38097ad72e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionDom.js\":\"447e8ed81cea0d49\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionId.js\":\"6993b9ee7488220b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkClickGestures.js\":\"ea957c1287b3705a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkTargetAutocomplete.js\":\"0f66eaeaee4ca58f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbCorruption.js\":\"5014d501227b219c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbRecovery.js\":\"4cff7b6b4538f156\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/markdownParser.js\":\"2c403d99dff54e0c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/memoize.js\":\"18a937b1d7e04075\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameFieldCommit.js\":\"58d5a7d0309dbca5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameList.js\":\"3aef1f14d923f0c3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/navigation.js\":\"767288c5aa23235b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/omnilinerNamespace.js\":\"29bd87c98030ace8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/opfsPageScan.js\":\"4549fac08f949973\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelClearance.js\":\"eab611cbd280073e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelHistory.js\":\"1ddd31e7ce0604b5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLanes.js\":\"c226184b42d0de6d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLayoutProjection.js\":\"312c37a97f1530a0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelScrollAnchor.js\":\"e0dcdb4442923cb3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelUrlFlags.js\":\"6532731a1891ecb5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/platform.js\":\"918fcce0568dd14f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/pluralize.js\":\"936613cf2ce41dbf\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyCreation.js\":\"fd1d1eac20fcb558\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyNavigation.js\":\"273981bed4c75000\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyValueContext.js\":\"6997f0b2928a40d0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/react.js\":\"f1cede09777709e2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeDate.js\":\"76f912a8a89e9df4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeTime.js\":\"cc561bf4be4afd80\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/renderScope.js\":\"97b211068911d49e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/resolvedThenable.js\":\"3680c0da5243052f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/routing.js\":\"41200357fee591f8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/safeMode.js\":\"33bff114d84936e9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/scheduleIdle.js\":\"e8d636a1947c1df7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/screenWakeLock.js\":\"25c96e8b89baeea8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/selection.js\":\"0a96acd7c3235be4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/softKeyboardGrab.js\":\"8252226dc01f4f2b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/startupTimeline.js\":\"f0624dee169b07b9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/state.js\":\"545c0081c18ea01c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/string.js\":\"aeb7ff8a59dd46a0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/surfaceZoom.js\":\"49c591b95e89c01f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/time.js\":\"eb17c78d10a6adb6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toast.js\":\"6652e9ae02872512\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toggleStore.js\":\"23c69d7e10519156\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/untilStopped.js\":\"ceac86d823e079bf\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/userActivity.js\":\"991c8d7f67612985\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewTransition.js\":\"5a462d7b89aab295\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewport.js\":\"2aeb5da98fb925fb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/webLock.js\":\"998eec7ef4b2b2ac\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceRecovery.js\":\"1e8375d562fea6ca\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceSnapshotStore.js\":\"b89b18b1efd601d3\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-compiler-runtime.js\":\"851f42a95369d697\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-client.js\":\"8edda56dbc82d5e8\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server-edge.js\":\"f14ec3fd0a33acb1\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server.js\":\"ca1202e9beece8ba\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static-edge.js\":\"0a2d3cc85aecadb3\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static.js\":\"2c8219236982f197\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-test-utils.js\":\"dfe695976e242e52\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom.js\":\"2145d0de5d45a34e\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-runtime.js\":\"6208a53fe8d5c8ca\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react.js\":\"b76c6e509053ef16\",\"/knowledge-medium/pr-preview/pr-1844/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
