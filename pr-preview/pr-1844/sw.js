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
		buildId: "bdae40120585-df3cba9c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/\":\"cb7fbcc692ef0404\",\"/knowledge-medium/pr-preview/pr-1844/index.html\":\"cb7fbcc692ef0404\",\"/knowledge-medium/pr-preview/pr-1844/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1844/assets/FacadeVFS-CdPZJozz.js\":\"95dbbe99d24a85e0\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSCoopSyncVFS-DX-4dq8o.js\":\"f61de067a0052a45\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSWriteAheadVFS-BhUDl6pR.js\":\"90c784d9a94dae31\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-BWUc3oPE.js\":\"dbf8f5c7e4fa691a\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-ikNcdICK.js\":\"13bb89deac0b406f\",\"/knowledge-medium/pr-preview/pr-1844/assets/worker-BeKqn80T.js\":\"95f1ed473eb16e98\",\"/knowledge-medium/pr-preview/pr-1844/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1844/chunks/app-C5i7mp-R.js\":\"77fbe27bd11f0d59\",\"/knowledge-medium/pr-preview/pr-1844/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1844/index.js\":\"3b6f89492b877505\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1844/assets/AccessHandlePoolVFS-A3-OAZnf.js\":\"3594d17686c4670e\",\"/knowledge-medium/pr-preview/pr-1844/assets/IDBBatchAtomicVFS-C6xEtJtD.js\":\"cc1fadd6cbcadeab\",\"/knowledge-medium/pr-preview/pr-1844/assets/MemoryVFS-DVo-dTJ4.js\":\"d8f85a52506fe0b2\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-SUWAzvyQ.js\":\"abf42bf3002268da\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-5cmjl-J3.js\":\"00adf704c198e3ef\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1844/chunks/AccessHandlePoolVFS-BYGuP4dQ.js\":\"f56f62fe45a57d33\",\"/knowledge-medium/pr-preview/pr-1844/chunks/FacadeVFS-DhZkFFbW.js\":\"36885c8700d84e6b\",\"/knowledge-medium/pr-preview/pr-1844/chunks/IDBBatchAtomicVFS-DyvoQXag.js\":\"20492b32bf6e97a5\",\"/knowledge-medium/pr-preview/pr-1844/chunks/MemoryVFS-CKuATvUr.js\":\"d9f4e8dfdaaf6a33\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSCoopSyncVFS-CSRSMg_J.js\":\"bcc18c47b90ebddb\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSWriteAheadVFS-yzmKI8qd.js\":\"7f1d14093b09ca7f\",\"/knowledge-medium/pr-preview/pr-1844/chunks/Preview-0eMb61UL.js\":\"85e44dd9c5acb898\",\"/knowledge-medium/pr-preview/pr-1844/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/card-C2YcARUG.js\":\"aac468dc1fac207c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-DzfrFVY4.js\":\"16c129c5cfe29921\",\"/knowledge-medium/pr-preview/pr-1844/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-CnUpQEJl.js\":\"21a79808d9b496a7\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-async-CvGrzZ_c.js\":\"9692696160d7f73c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-B0QliHDQ.js\":\"260e550b8bf756a9\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-D9KNhs9y.js\":\"4b31d2ce012de463\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DFNEBL-B.js\":\"7de9b6d6e9ec14ff\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DFQTo5qE.js\":\"ed86c045b4f72327\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-Dwno80qa.js\":\"d3b1684a3275d098\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-RgAVqvae.js\":\"fd69a0b740cf64f0\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-WV6j3caR.js\":\"1e401580586edc72\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server-legacy.browser.production-BNOtGtT-.js\":\"e07756dd76bf266d\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.browser.production-B7bbAzy3.js\":\"08c278ce2f0f15fe\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.edge.production-Bkm_WzFt.js\":\"60b9cc2db77ebde1\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-kwPlSbc1.js\":\"244f65eb55949a5a\",\"/knowledge-medium/pr-preview/pr-1844/chunks/server.browser-Fwuj1ILp.js\":\"0fe042130ff3c776\",\"/knowledge-medium/pr-preview/pr-1844/chunks/textarea-B-ucm-N8.js\":\"3f59e8fc0539e851\",\"/knowledge-medium/pr-preview/pr-1844/chunks/ui-4FWvAObU.js\":\"97e0aeb2428041ad\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-BvEzlTnI.js\":\"5393f551905b546c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-async-Xadwtb4r.js\":\"bafc79d117cd8e66\",\"/knowledge-medium/pr-preview/pr-1844/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1844/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/src/App.js\":\"6025346905e25f65\",\"/knowledge-medium/pr-preview/pr-1844/src/appUpdate.js\":\"87e04bdba0ed4969\",\"/knowledge-medium/pr-preview/pr-1844/src/appVersion.js\":\"fabf4382f6dce078\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/initialLayout.js\":\"d84b9c6f824952a6\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/openWorkspaceData.js\":\"ca07a0482ce6a7de\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/resolveWorkspace.js\":\"45954be634331271\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/workspaceBootstrap.js\":\"3ccde99a89b5790d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockComponent.js\":\"8a5a7b12eaa2dbb8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockCrumbs.js\":\"c03c501ec8c21647\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockEditor.js\":\"cd41cd9db181ee5b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockLoadingPlaceholder.js\":\"409bbfcba4f2f221\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockProperties.js\":\"244935edac35cd47\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockSearchPicker.js\":\"eff28be74cf61c35\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ConfirmBulkDeleteDialog.js\":\"f920f825604df2e8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DividerHandle.js\":\"d9d5ae5d0124c6f6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DraftEditor.js\":\"fb3fce67a1fa1d3f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/GutterPill.js\":\"3d8cede89afa94c1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Header.js\":\"046742633bb49f14\",\"/knowledge-medium/pr-preview/pr-1844/src/components/LazyBlockComponent.js\":\"eef882d7228a9d29\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Login.js\":\"dea5d147a975c8ed\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ZoomableSurface.js\":\"09ba4b0d3de2191c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/editModeKeepalive.js\":\"0bd58b79bdec607d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a0e3c253199a9777\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f65c5d06067ab8af\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefPropertyEditor.js\":\"4258571a4b98ddf2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefTargetTypePicker.js\":\"ecffb145ba07ae67\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/SelectPropertyEditor.js\":\"50451507f9df331a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/TypesPropertyEditor.js\":\"9646715709b9bb75\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/defaults.js\":\"c00a1f839eee3e06\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/kernelValuePresets.js\":\"439b840ca1bb2f0b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/selectablePresets.js\":\"21edc5a85a0345f8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/typesPropertyUi.js\":\"3711a520a21f0958\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/AddPropertyForm.js\":\"b39edfe7ada89148\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyPicker.js\":\"97889429d3d91617\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyRow.js\":\"b6743477692d71f0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/Rows.js\":\"a2071940138041a0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/actions.js\":\"fc821a2f8c3248e2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/declarationOnly.js\":\"d35f4f524453f40c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/layout.js\":\"28c54888412409d4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/model.js\":\"404d60fc273b4bed\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapeUi.js\":\"be60588fe2f97822\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapes.js\":\"f40a9f3e9022657d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/usePropertyEditingActivation.js\":\"bd78f7f16ccd83db\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/visibility.js\":\"acaabaf6bf30a8c2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanelSections.js\":\"4dda349bb6f6ad3f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockEmbed.js\":\"ec8eeb9643509171\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockLink.js\":\"1caab6f8527f7469\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockRef.js\":\"81c28c791c6af084\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/ReferenceLink.js\":\"39bde42816700d39\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuard.js\":\"cb5e27f93ab17d20\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuardContext.js\":\"c40319d81e5cff72\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/linkInteraction.js\":\"bd5273d0c8c3109d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/referenceLayout.js\":\"4caea6a2c8057786\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/useBlockRefAncestors.js\":\"852ba7250194b400\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockGutter.js\":\"11bf06f7b3435866\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockInfoDialog.js\":\"55de56455a763127\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockTypeBlockRenderer.js\":\"9dd83fe03ca9a055\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BulletHoverCard.js\":\"2b43f1d99ded6ea5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorContentRenderer.js\":\"4c713025d2690717\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5577aa0f7365058e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ColumnResizeHandles.js\":\"ac407605f2fc616d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"32efaa38b7be0d1c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/DefaultBlockRenderer.js\":\"300e20fc2eb281bc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/LayoutRenderer.js\":\"8bbe68880a65ce48\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MarkdownContentRenderer.js\":\"4bfb826a4059d159\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MissingDataRenderer.js\":\"98ec8248ed667928\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PanelRenderer.js\":\"1b84ef15943d8781\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b19d20abbe7f8914\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/TopLevelRenderer.js\":\"744da48ec60b513e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockGutterMode.js\":\"88981e09f60456fd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockTitleText.js\":\"27bfea4344aa17f5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/fieldCreationKeydown.js\":\"c7e1f5092cd9ae7d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/layoutRootContext.js\":\"2e7359a5168be647\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/TypeChip.js\":\"f3879984a735ab8d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/chipStyle.js\":\"cd78333bcc7eeca2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/anchored-floating.js\":\"f040ba32a82d042d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/button.js\":\"af1843573ddc0e30\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/card.js\":\"5176c57d87fd2bf6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/checkbox.js\":\"a4b82b6388edb56f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/collapsible.js\":\"593635d80ead1086\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/command.js\":\"79adc058052446b2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/context-menu.js\":\"147393d36de8ec97\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dialog.js\":\"ee8faa0954134b39\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dropdown-menu.js\":\"647247dec7a397fb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/floating-listbox.js\":\"f7338cf138e27dcc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/index.js\":\"82e7ceda2cbc8560\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/input.js\":\"454393cbd32b4ed8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/kbd.js\":\"50d6c0df8e8aed4b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/label.js\":\"8947746e938e68eb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/textarea.js\":\"a8802d00caa42c33\",\"/knowledge-medium/pr-preview/pr-1844/src/components/useEditModeYieldKeepalive.js\":\"15dd16966f75711d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/BootFallback.js\":\"893c6b1fe8806ecb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/FocusedRowLazyMount.js\":\"0b6399b1c76bda71\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LazyViewportMount.js\":\"509ce5c64be0f15d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LocalDbCorruptionFallback.js\":\"19fcd77e89bf6e33\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/error.js\":\"23fe2904ce93e80e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/lazyMountRegistry.js\":\"496dc96e4e157929\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/suspense.js\":\"9e03a8b1772d4372\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/CreateWorkspaceDialog.js\":\"5eca5eed7df7453c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/PendingInvitations.js\":\"626b2642bb924ab3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/SyncProgress.js\":\"f6dc11dd9846309b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/UnlockProgress.js\":\"29830d074fad470b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceKeyGate.js\":\"1efb3f781736a3a4\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSettingsDialog.js\":\"da8e738b423abb29\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSwitcher.js\":\"4a5551ec2eb0ef3e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSyncGate.js\":\"1ae6d717e5e1fbc3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlow.js\":\"69db27c8ce5d72a1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlowHost.js\":\"f42b52532ccb1451\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/EncryptionSection.js\":\"be93dc35a93f127b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/attachmentPrompts.js\":\"59b717194ec487ab\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/bundleFolderPrompts.js\":\"55a441f85de4704a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowDeps.js\":\"b3ca128523aad85f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowStore.js\":\"bd1b97b32872faca\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/flowUi.js\":\"ded9d3662521a0bf\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/useConversionRun.js\":\"33689fb9ab3e3aa1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/keyUi.js\":\"880c05e2b68a5495\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnKeyLoss.js\":\"b4d9b17a0586f34a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnServerE2ee.js\":\"18be01375542d47a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/workspaceUnlocked.js\":\"5f0a128c127f519c\",\"/knowledge-medium/pr-preview/pr-1844/src/context/backgroundSubtree.js\":\"0b17b65754ce1b30\",\"/knowledge-medium/pr-preview/pr-1844/src/context/block.js\":\"0a064e3eff32dc30\",\"/knowledge-medium/pr-preview/pr-1844/src/context/layoutWsContext.js\":\"11ff3cbbd39af107\",\"/knowledge-medium/pr-preview/pr-1844/src/context/propertyDisplay.js\":\"35faa441cdeb70ef\",\"/knowledge-medium/pr-preview/pr-1844/src/context/repo.js\":\"3889a700d954fd99\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasClaim.js\":\"2fd194843dfd4fa9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasSeatNamespace.js\":\"7436d172ad57d846\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockData.js\":\"dab58ac438f3ffc6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockType.js\":\"35fa69ae627ac211\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/changeScope.js\":\"3af112ccf40470cc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/codecs.js\":\"964ecafd1148d04c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/derivedData.js\":\"193859ef043b50d3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/errors.js\":\"43a05a965f20923a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/events.js\":\"6691db5904b581fb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/handle.js\":\"2ac9fb5f6fea4bd4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/index.js\":\"9b712e50ec265cd9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/mutator.js\":\"a44957d0bc72c5cf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/processor.js\":\"85f214459703cbb1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/propertySchema.js\":\"cec5eae705489ae3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/query.js\":\"080858ab0f824137\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/sameTxProcessor.js\":\"27eab5b09d8e4913\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/schema.js\":\"2ac9fb5f6fea4bd4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/tx.js\":\"2ac9fb5f6fea4bd4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/typedBlockQuery.js\":\"bc90decdb0d7cb90\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/user.js\":\"1bffacdbff307fae\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresetCore.js\":\"ab3fb194d1fdc28e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresets.js\":\"89e9b56b22e7f1fe\",\"/knowledge-medium/pr-preview/pr-1844/src/data/attachmentCleanerIOVerb.js\":\"0a3ca23813fecb36\",\"/knowledge-medium/pr-preview/pr-1844/src/data/block.js\":\"d32242d447b1b10e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockCache.js\":\"524e53da5a3cecf9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockId.js\":\"b6e7810417e630a4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockLiveness.js\":\"c1dce81928afecad\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockMerge.js\":\"c5377fc93a359c74\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockSchema.js\":\"acfd586387a874d7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypeLookup.js\":\"b123d3de150beef7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypes.js\":\"0c8e6424024761af\",\"/knowledge-medium/pr-preview/pr-1844/src/data/clientContext.js\":\"9d6346c6cc71df02\",\"/knowledge-medium/pr-preview/pr-1844/src/data/dbFileSiblings.js\":\"5c2ba4014f1a2931\",\"/knowledge-medium/pr-preview/pr-1844/src/data/definitionSeeds.js\":\"504d6543bb2c931c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/derivedIds.js\":\"c16c71cdf8506353\",\"/knowledge-medium/pr-preview/pr-1844/src/data/drawnSubtree.js\":\"53c8bd2f001e6fcd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facetBridge.js\":\"a4f0fc4b4155249e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facets.js\":\"7a301e71adb27690\",\"/knowledge-medium/pr-preview/pr-1844/src/data/globalState.js\":\"6a5ed1a5b230d46b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/aliasClaimRederiveProcessor.js\":\"5581153fb92439f8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/ancestorBatch.js\":\"ae411fb39f80fdda\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/blockTypeTypeifyProcessor.js\":\"dff1cf53dea4fe1a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/clientSchema.js\":\"2e3e190bd99964be\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/commitPipeline.js\":\"9a534653be503049\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/devAssertions.js\":\"0c078c4d70fc3a89\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/firstSync.js\":\"c14a48382bb6f42d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/freshInitialLoad.js\":\"fee04345b360efed\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/graphBackfillClaim.js\":\"4f74ee6e1ec536a7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/handleStore.js\":\"666a97608b1fdbb0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/idleMarkerJobs.js\":\"7b9badeada6f06c4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initialDownload.js\":\"1f8da6f4d730b5f4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initializeClientDatabase.js\":\"d192edc3cd60724f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/jsonCanonical.js\":\"6d2039b005d20ef7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelInvalidation.js\":\"32248559413aa1e8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelProcessors.js\":\"cd5248af083a6d6f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelQueries.js\":\"3d0f72e60bd04c58\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/mergeTypeMembershipProcessor.js\":\"66e9d036fbdc589a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/normalizeReferencesProcessor.js\":\"09bc3f41a60a7662\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/poolInstrumentation.js\":\"a7b31532f709d3a9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/processorRunner.js\":\"959ce5ad693a8ad6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyCellBackfill.js\":\"e45617cbcb3e1354\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildMint.js\":\"e0ee6f4eee3d69c9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildrenProcessor.js\":\"349d5c4df9e26e9f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionChangeProcessor.js\":\"49e71fb5a0af0072\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionSynthesis.js\":\"bf996a6579df4a37\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyKeyScan.js\":\"ead82cf69822a44e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertySchemaResolution.js\":\"3d003c30d6ac3945\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyValueEdits.js\":\"68d5c3f260faa52d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/raiseProtocol.js\":\"847c43a1aad74194\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/readBatch.js\":\"47f327f1bf1d8272\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/refProjection.js\":\"a1e634718aede193\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetLookups.js\":\"93b0e2c5780e4666\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetProcessor.js\":\"12a852248844a558\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/replayMerge.js\":\"72bea24d220b9d72\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/sqlBinds.js\":\"0893b33430246eb1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"568bef555def5fa0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/arrivalProcessors.js\":\"f635c9fd078ce067\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/invalidate.js\":\"2a4317deeeb90b38\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/materialize.js\":\"ecd420a011b61ff7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/observer.js\":\"d3f5a34acc1e21db\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/reconcile.js\":\"f9157abc675bd7ef\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/timingMetrics.js\":\"d06cb6aceb298ec6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/treeQueries.js\":\"9abf79dcd0b7d8ad\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txEngine.js\":\"d6afdfbcb3bc557c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txSnapshots.js\":\"55f0229af45fe56f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/typedBlockQuery.js\":\"81acaf51c01da637\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/undoManager.js\":\"10db6a52112bfad2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/invalidation.js\":\"7f593bcd2d85d99d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelDataExtension.js\":\"77e78c1584560cfa\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelPage.js\":\"60ab4d36a4f9bf90\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelValuePresetCores.js\":\"6d769b1d53a5c65d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbCorruptionSignal.js\":\"227d82381185125f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbStorage.js\":\"12053af5c0f73723\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbVfs.js\":\"d0e62ab112c1871a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localSchema.js\":\"baaacf4b200fc105\",\"/knowledge-medium/pr-preview/pr-1844/src/data/maintenance.js\":\"c0ead1074009b15d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mergeProperties.js\":\"0f48388e2a438246\",\"/knowledge-medium/pr-preview/pr-1844/src/data/metricsConsoleHook.js\":\"c33ae48cbc260414\",\"/knowledge-medium/pr-preview/pr-1844/src/data/migrationsPage.js\":\"ba1445682600dd63\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mutators.js\":\"f89ede5b3958915b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKey.js\":\"6a1770fd2db0456c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKeyPlacement.js\":\"4a6fcced558cfbfb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/outlineSurface.js\":\"b6f31f81596878d8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingEditorContent.js\":\"b82590fb6ceea87c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingUploadsSql.js\":\"6c21e481c5ba82ad\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pluginStateExtensions.js\":\"e3909232690cf3f9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/powerSyncLogger.js\":\"cf6e5ee260c920e9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/projectorRuntime.js\":\"d5bda9df51489cf7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/properties.js\":\"0b6ce99624b40854\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertiesPage.js\":\"f55a7ff4214f1b15\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyChildren.js\":\"ed0315b5a1189476\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionFanout.js\":\"b68f74730e13c872\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionMetadata.js\":\"e77f0ff6fc4f8d93\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionRegistry.js\":\"e59762735fa48f65\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDisplayMode.js\":\"95254faa24c69d8c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyRowCreation.js\":\"2b96be6af919312a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySchemaCreation.js\":\"5e4bce2e7101cd9f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySeeds.js\":\"1b76f3a93149897e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/recentsPage.js\":\"273a484e4d90ac78\",\"/knowledge-medium/pr-preview/pr-1844/src/data/referenceBlock.js\":\"0855ed37362a7508\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rejectedUploads.js\":\"c5f08202b491a2ba\",\"/knowledge-medium/pr-preview/pr-1844/src/data/releasePowerSyncConnection.js\":\"8fec8ddf3ce79d99\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repo.js\":\"e653b599ce868239\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repoProvider.js\":\"115041492200ba38\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rowProperty.js\":\"a00b261616b7d7a6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/searchFilter.js\":\"f62b5072db68ddde\",\"/knowledge-medium/pr-preview/pr-1844/src/data/seedIdentityLedger.js\":\"73867569c8142cfa\",\"/knowledge-medium/pr-preview/pr-1844/src/data/stateBlocks.js\":\"f05790a373cbbc06\",\"/knowledge-medium/pr-preview/pr-1844/src/data/structuralEditPolicy.js\":\"05abe97acbf4ebcc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/subtreeDelete.js\":\"1b7b388f4f5b70c0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncStreamLock.js\":\"86074100e975aac7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableSqlRecognizer.js\":\"cb9364222fa8de6e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableWriteGuard.js\":\"e265544ea382759f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/targets.js\":\"b0ccc73a44f0a42b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeColors.js\":\"2a9dfe72c55de410\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionMetadata.js\":\"93f92d6c5565214a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionRegistry.js\":\"ae8ca95ce02a4b5f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeExtraction.js\":\"6c8f14638566a2ac\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeInitialValues.js\":\"5add683eb3de5bc0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typePropertyGroups.js\":\"2d94ba67bbbed6e1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeSeeds.js\":\"c735c50efa5977d7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeTagger.js\":\"7924c2333470257f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typedRecords.js\":\"14bbe0d84369f739\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typesPage.js\":\"4df51675838c6d2e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userPrefs.js\":\"9d464eddcb69b1c7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userSchemasService.js\":\"b50f3efd49fdf769\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userTypesService.js\":\"0b0da60014d41c87\",\"/knowledge-medium/pr-preview/pr-1844/src/data/valuePresetRegistry.js\":\"aa5f58e9bd447986\",\"/knowledge-medium/pr-preview/pr-1844/src/data/visibleChildren.js\":\"e1a7033092e4115b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceConversion.js\":\"1332c411e0d0fa70\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceFirstSync.js\":\"dc5e0efb4175da01\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceIdNamespace.js\":\"5c05b6734db1b111\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceSchema.js\":\"dc7c39de9673ce50\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaces.js\":\"c824cd649a68cae5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadLog.js\":\"8d01f67647de93ff\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/BlockPasteShellDecorator.js\":\"f03de7db5378d475\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/atTrigger.js\":\"db651cd7718b2c41\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/autocomplete.js\":\"9f13fee5882b5857\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/codeMirrorExtensions.js\":\"346b0480f3e0823f\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/contentFlush.js\":\"474075fab5f6721a\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/defaultInteractions.js\":\"073ed6ac9066ec2a\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/editSettleSignal.js\":\"3dce4623fb190109\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/insertImage.js\":\"42f1092641ce46a5\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceCompletionRange.js\":\"743c9dadf26d0a56\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceTargetTypes.js\":\"7629f9fc208bd962\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/syntaxContext.js\":\"7ff24a027542c315\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/triggerMatch.js\":\"9f85bda4eb188c88\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/AppRuntimeProvider.js\":\"10d5c8fca90d6b3f\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/BlockFocusShellDecorator.js\":\"06665c3cb2b4cbfe\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/ExtensionRenderBoundary.js\":\"64ab3f7895740a8b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/PanelContentRecovery.js\":\"55b177376059700d\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/apiCatalog.js\":\"efa4a293a59f7c4c\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/approveExtensionHere.js\":\"5519748859d28317\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/armedCutAppMount.js\":\"de30a85ee3dbc9e6\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/batchableKeyedStore.js\":\"bae5da0c78608c2b\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockInteraction.js\":\"ec0c782691f60785\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockSelectionAction.js\":\"3e0e7c949a11fbdf\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compileExtensionModule.js\":\"909fcb4f576f0b59\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compiledModuleCache.js\":\"07d17b11f110f2e6\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/continuousGestures.js\":\"7dcf8d41642c09ff\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/core.js\":\"d33dd1f7d8a659d4\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/defaultRenderers.js\":\"9a1704da8b5cc013\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/definitionFanoutAppMount.js\":\"335e392ca77a820e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dialogAppMount.js\":\"84e411a680f34668\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensionSeeds.js\":\"d4ba594563ce56a8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensions.js\":\"c8db409966903dcd\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/exampleExtensions.js\":\"0b9b47568b833f1e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionApprovalStatus.js\":\"2638257229627771\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrorToast.js\":\"0a94fa57cf1e939d\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrors.js\":\"a22f486e0d5277a9\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLookup.js\":\"b968ba2b2af60282\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionToggles.js\":\"a187624907fdf276\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionUtilitiesCss.js\":\"7f802bcde66bcddc\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/kernelPageDeletionGuard.js\":\"6e03ee61959aa24f\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/liveRuntime.js\":\"6e20c545d370be31\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/openExtensionsSettings.js\":\"09c7856855af9e18\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/overridesCache.js\":\"d6ae72e9547dd135\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/pluginIds.js\":\"677b3d1d7e9eda92\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/processorRejectionToast.js\":\"afa6b9335e7c12d6\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeActions.js\":\"e973717228f1038a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeContext.js\":\"03450b098d47eac2\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticAppExtensions.js\":\"7d8291eacd245e5e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticDataExtensions.js\":\"68087af33f020fef\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/toastAppMount.js\":\"c1e3772cb14d7910\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useOverrides.js\":\"82eb61ff5c294237\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useShortcutSurfaceActivations.js\":\"78a4dc6d958618a9\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/discoverToggleTree.js\":\"d50236415ab229cd\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/facet.js\":\"c622f7b0d0bafea3\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/resolveAppRuntime.js\":\"4bfe12bbf6452306\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/runtimeEvents.js\":\"e0bab8c573f42f50\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/togglable.js\":\"29a717dfa2408a20\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/variantFacet.js\":\"1e21da60d1173a52\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/verbFacet.js\":\"573544c9408690fc\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/block.js\":\"578c09c0b634f73a\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/focusedChild.js\":\"9252e83e7ffedaa4\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/propertySchemas.js\":\"e8f081822ec31bef\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/typeRegistry.js\":\"5bb82649e9fcc511\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAncestorCrumbs.js\":\"f865ecd43f06cbe7\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAutocompleteListbox.js\":\"919c9d699bc36ea6\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedSearch.js\":\"db7951e76c66a52d\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedValue.js\":\"07c1a3780b646553\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsFocalRender.js\":\"18016f4686e50e9b\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsReadOnly.js\":\"aa9a6b895430bd01\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMaterializeBacklog.js\":\"2661edaaa61f958a\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMinuteClock.js\":\"2cdd0066c3d940b5\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePanelLayoutProjection.js\":\"71b162fb6390a673\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePendingInvitations.js\":\"3e8fcf62f0b90a3c\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRendererRegistry.js\":\"7e5f8d5f13337282\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRetainedFieldRows.js\":\"be0d0b4d0e5f2f3b\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useWorkspaces.js\":\"2b420888effc17b8\",\"/knowledge-medium/pr-preview/pr-1844/src/lib/utils.js\":\"bf50f52270dd1647\",\"/knowledge-medium/pr-preview/pr-1844/src/main.js\":\"415b1adab4389229\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/MarkdownImage.js\":\"954a14844a1531e5\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/blockSeparators.js\":\"9a38247ba7d395a3\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/context.js\":\"233a6f5b9a7a51eb\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/defaultMarkdownExtension.js\":\"a5eb17f61dbc5181\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/extensions.js\":\"9b32709a3f7a90d4\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/renderMarkdownHtml.js\":\"93d74c9ca13dcf7e\",\"/knowledge-medium/pr-preview/pr-1844/src/minimal-editor.js\":\"a0faaa512c3ddb27\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/armedCut.js\":\"202bf79b2f230446\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/captureMediaVerb.js\":\"16791343023412db\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/clipboard.js\":\"5d08f94595edc177\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/decision.js\":\"02ce2c157dc73691\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/operations.js\":\"1a4ba47cdcaed46b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/AccountHeaderItem.js\":\"2b3e6c1295d74ca0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/index.js\":\"29627b1782c25ce3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ef03bb623417ec87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askAgent.js\":\"bf17f90b0b8ed49a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askedStore.js\":\"ab22dfd10b76aec9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ecc5a532af574b22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/chipState.js\":\"c2bf30eae4f4954b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/dataExtension.js\":\"843abdcb8646ff17\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/index.js\":\"c72daac0e876dbbc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4fec22b619f732a7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/schema.js\":\"74e316aaa7e4034d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/AgentTokensDialog.js\":\"16d45c26080c067e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0a6c255162712f06\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/addMedia.js\":\"82aeafa5c2e15f8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f6181ce1e7b4c985\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/block.js\":\"384362feb28b15ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/context.js\":\"ac490a47226dc054\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/displayIds.js\":\"976af01099bc7155\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/index.js\":\"7281349b27f8868b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/outline.js\":\"a4c301290d3588d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/properties.js\":\"145c35ec7cca611b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/refs.js\":\"08cf3259bfd9e282\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3084a316b264292e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/search.js\":\"893f0f8ea1a242a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/shared.js\":\"a475a8d9bd518334\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c77873d719b58dfc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/text.js\":\"c1e6e8b79413087f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentWrites.js\":\"0607e55584fecaf0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/authoringCatalog.js\":\"2edc3b7cd7ad809a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/blockRefTargets.js\":\"b856233aa736338d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridge.js\":\"b7f797bf7eb9d3c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridgeLoop.js\":\"bd02d4341e18bd96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/changeHistory.js\":\"de3f0b66bfbbba5e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commands.js\":\"8c3fb9adfa07fee7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commentsCommands.js\":\"5e9b911fe9fcca93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataExtension.js\":\"2563e8b0d7d90b41\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataModelGuide.js\":\"1f58a0c01f2e7ce9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/describeRuntime.js\":\"7bfb417da4cdb24d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/extensionLint.js\":\"e0ca3476ceaebbd7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/grainAudit.js\":\"44475ce055b0c0a5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/healthCommand.js\":\"5979d0605fbcc1c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/index.js\":\"c8850c21ac354113\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/presetIdentity.js\":\"43f102941c2c7c59\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"eab2f291f0b940fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/readMedia.js\":\"594868c04c3c4e0d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/schema.js\":\"bbe7192c36e49f80\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/serialization.js\":\"18ee32e2feb34a18\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/targets.js\":\"4b894602a0811354\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/tokens.js\":\"89587ca89535d8c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/watchEvents.js\":\"21a5768afe556f01\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/workspaceGuard.js\":\"0ec7dd670eb89d2f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/writeCommands.js\":\"cbc66ac1403b6fa6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/AliasCollisionToast.js\":\"4695386e26376db6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/DuplicateNameBanner.js\":\"730b1a58198e3dc9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/collisionMerge.js\":\"a8002a629b843919\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/dataExtension.js\":\"f030dedf489df193\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/index.js\":\"ce526925c50fd937\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/mergeCollisionAction.js\":\"91b17a8b3ce1b903\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/pageStyling.js\":\"7be3ebf8f5d50757\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/rejectionToast.js\":\"de4c5999c6ae41d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/syncProcessor.js\":\"b5461e91f07191d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/actions.js\":\"38b64e797722282a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/addComment.js\":\"893c0cc75d9b2f4d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchor.js\":\"130ba0f2265ea485\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchorState.js\":\"12588b15ea971ada\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/commentLinks.js\":\"1ae7bb3bc56c8f4e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/confirmThreadDeletion.js\":\"a32854916fb81ce0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/container.js\":\"cb8f84532dd3abac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/dataExtension.js\":\"72603ea05d1944f2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/deleteComment.js\":\"40f7419d1179919a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/highlights.js\":\"a176090295d6ef93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/index.js\":\"291c764809bb8ba7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/linkedCommentsPill.js\":\"fb16dbf8f720fd9f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/margin.js\":\"fce4fd9a05603c8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/marginSchema.js\":\"cf25be9a38a5e4ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/newComment.js\":\"d437f427be654d96\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ownThreadPicker.js\":\"1cad7175ed311678\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/placement.js\":\"3beadd7e8c19aa58\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/queries.js\":\"fb65c79ea3c6f10b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotePosition.js\":\"d13140fdf6758c23\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedIn.js\":\"ece9fa026bbd7fe2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedRange.js\":\"26db59b73f03939f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/rangeRefs.js\":\"944114b788a98e02\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readHighlights.js\":\"cc1dce454b126375\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelection.js\":\"8505db266b80ba31\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelectionUi.js\":\"360c61a0b7b945e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/reanchor.js\":\"5d5be191445dbc1e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/schema.js\":\"0a7c5a765240e6ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scope.js\":\"637dcfaff2abb890\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scopeThreads.js\":\"0cac99e89b90f4fa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/splitRetarget.js\":\"6e7034552918fba1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestionCard.js\":\"ea4dec2ed3671ef8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestions.js\":\"2aa7d52e2b60099f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaries.js\":\"4cbc07e0a7de7277\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaryBatch.js\":\"c8c4027d2259162b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/surface.js\":\"cef214a61a1a6a5f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threadNavigation.js\":\"b143379c89f97ad6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threads.js\":\"511a71df756f1f8f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ui.js\":\"d3e9a62c841d52a6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/uiStore.js\":\"64bb109d3491ba04\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/appIntents.js\":\"ca3b9e339858b88b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/index.js\":\"adcba9d2633217ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/index.js\":\"7245e4cb6b2c2bb1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/status.js\":\"8bfb95b0ac3a2f9d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4927c49b15c9cf21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaBlockRenderer.js\":\"2fa2293d922f376f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8477c2ec03a002cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaUploadReconciler.js\":\"a030f51e60f2a229\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetDownLane.js\":\"35d34fe0ff0415db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetResolver.js\":\"66bfbf532f58f63f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetUpload.js\":\"befb088019ec703a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/attachmentCleanerIO.js\":\"e931e6de708fdce4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/supabaseAuditIO.js\":\"eb94f96829451f2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/blobStore.js\":\"07485aedc6a3b2a2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/byteStore.js\":\"99bf69e481a870c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanerIO.js\":\"02d8cb71cfd9e04a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanupAttachments.js\":\"9437e112d3d331b0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/dataExtension.js\":\"b6de9f3a03587503\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/downLane.js\":\"279f3614c8cd30a1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/index.js\":\"661766a9653d83f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/insertImageContribution.js\":\"ea0d64042756bd07\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneArming.js\":\"d7782612ab254c66\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneLock.js\":\"7984edd57d1583b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaBlock.js\":\"71597909f94d15e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaCapture.js\":\"f5c9520dc24c9037\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewers.js\":\"a1f8a8cd20d18413\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewersFacet.js\":\"4af5b8a2b2cd32b0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/pasteCapture.js\":\"1769b06d3ab8d413\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/resolver.js\":\"7df0ed2cf6577ca9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/retryUploadsAction.js\":\"53cc77870bc80174\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/storagePaths.js\":\"e37dd94c01bbf76e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadDrain.js\":\"417fa2b73b54c358\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadLaneStatus.js\":\"f753104924609a88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadReconcile.js\":\"a28832af294af715\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadRecovery.js\":\"553b9d3eab43f533\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadStore.js\":\"15c2344be4b3cd26\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/useAssetObjectUrl.js\":\"2c92ef629e8e7da6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d71d7de9336ce13b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksViewSection.js\":\"84edd31d8aa4a265\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/facet.js\":\"89a5abbdc9ea65f7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/index.js\":\"64193fc70a8bd7c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/prop.js\":\"17767e967b1db499\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinkFilters.js\":\"8124b4f8c46aa427\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7aee5fccecd12629\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BlockEntry.js\":\"eef9f234c612d9bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/LinkedReferences.js\":\"2890b0830383669a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"81109280d8707d85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dailyNoteDefaults.js\":\"36db3a205bdfb43e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dataExtension.js\":\"3ff79f36a182c151\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/edgeExclusions.js\":\"982cc63154097a05\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/filterProperty.js\":\"b75f9a06af81a2cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/index.js\":\"5fd8ad1a6ae4ad0c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"cfcab7bb1c7803d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/applies.js\":\"61006f3f9106e371\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/countQuery.js\":\"dd85737a720f82a2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b670810a2bfa1b93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/index.js\":\"48da5f8c03f5b813\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"452c4bc534e3143b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/presentationInvalidation.js\":\"d3a2f436c0e218d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyEditorOverride.js\":\"e47e00939b2263c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyFilter.js\":\"607698965d9ea6db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/query.js\":\"0e51183521892cc2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/resolveFilter.js\":\"11be510b5a7a2d73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sourceBatch.js\":\"a5d4e3dc743842b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sources.js\":\"30c4eba1a9b278c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useBacklinks.js\":\"a5efe28f6afc4496\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ef670610f7311a19\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayCelebration.js\":\"9deee3b1f427cbe0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayOverlay.js\":\"4faeab510530f137\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/gate.js\":\"a17c4a8ebb13ccb4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/index.js\":\"05c0c214bce25b41\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/wolfTheme.js\":\"657f0983196c3b6d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/BlockDragLayer.js\":\"4da1ce3494af5dd2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dragController.js\":\"9f5d2f5520c10f23\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dropTarget.js\":\"e43e0ef8bed5e89d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/index.js\":\"660dcdf7dd859068\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/projection.js\":\"28dd6c639307ecc5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/BlockMetaCard.js\":\"1ea279159333657b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/index.js\":\"5500ae5343043a77\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/AddTagDialog.js\":\"41c9f893579840c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ba43da212471a222\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/TagNameIssueHint.js\":\"ed79246fdda71ad4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/addTagAction.js\":\"851f41bc820ed8ce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/appendTag.js\":\"5b23b63ae60ef035\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/config.js\":\"0edff0718a1919d7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/dataExtension.js\":\"6993db7fff3608ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/index.js\":\"0d2293ec41d03d6c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/propertyEditorOverride.js\":\"b087bb3362c953df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6f698c0bff18221a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ad78d8ed144c4db6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e989c785e773bdce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1f488c6c9d2bcc51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5e7c4e81566989ee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/index.js\":\"35d5bfa370fd2b78\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fee5aeddde284ab6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/CharacterCountItem.js\":\"e6426b9ea6cd6f9f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/ProfilePropertyEditor.js\":\"12733cb008973fb4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/actions.js\":\"cf4702e2d7c825a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/blockType.js\":\"ade40b5d92a92af6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/charCount.js\":\"ebd8df8d8dd60396\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/dataExtension.js\":\"bc14f03712a7431d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/index.js\":\"ac05dc432970dc85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/profiles.js\":\"c622e607b6ae1921\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/properties.js\":\"018bb96e07bd67de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/textCounts.js\":\"fc74f84aaaa102d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/colemak-keybindings/index.js\":\"88728281693ee493\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/CommandPalette.js\":\"71e32feed0a35ed8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/HeaderItem.js\":\"1c9cd1eff3cadd36\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/context.js\":\"40bc4b4b22359ca1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/index.js\":\"aacc1d0117abdc8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/selection.js\":\"6de67e671b88a220\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/toggleStore.js\":\"7ae4aaa7fbd79646\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/useCommandPaletteActions.js\":\"c793699389e53b93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/ContributorBadges.js\":\"88348005a64dffd6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/author.js\":\"44d4dfbda42f66ce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/codeMirrorExtensions.js\":\"14f6f2cc5cb6e366\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/dataExtension.js\":\"0778a0d9c97d1f2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/index.js\":\"0fc2f81d0e32efab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/mentionAutocomplete.js\":\"00e8918813d6801b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/processor.js\":\"e6d07ce12d1a7877\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/profiles.js\":\"fd3c1bc2831838b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/queries.js\":\"bc3ce4533634d904\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/schema.js\":\"28703ab4d6317753\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e54162b725f32c4a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7cdf5f2d90af9c3a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/index.js\":\"6bd325d541c22caf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"58a2ce53f8bfd924\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9144c55fd25fb61a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/CalendarGrid.js\":\"9a38d530550116c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DailyNotePicker.js\":\"60e92f203e12cd2e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e28427d30d04344b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateNavDecorator.js\":\"e8dae98eedb41823\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateScrubOverlay.js\":\"516779692b0adb9e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/HeaderItem.js\":\"7c7c502d349db97a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/ReschedulePicker.js\":\"21c701bcc25452ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4c97381b7da8ffc4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/actions.js\":\"760846299116ce52\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/blockDateAdapter.js\":\"b8d1d82d548f1ad5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/calendar.js\":\"f779ca29efd19953\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dailyNotes.js\":\"edef971e7e89162f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dataExtension.js\":\"26be3b35559a41cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubActions.js\":\"d6bac1aae1b60668\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGesture.js\":\"556be8d5f251e0a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGestureActions.js\":\"174e4ec71d6dd6f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3bc3582a613794d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/deletionGuard.js\":\"1eb38b3dcc2e155a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dueQuery.js\":\"ad876f6e5d407fc3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/index.js\":\"c5e9e477308875aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/landing.js\":\"34af9972010c81bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/localSchema.js\":\"d24508bc366bffd4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/referenceDateAdapter.js\":\"434758c1f5e90088\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/rescheduleAction.js\":\"92cdc54d3bf74b49\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/schema.js\":\"690a947088825baf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadBlockDates.js\":\"2f30ea3c6a2029cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadDatesAction.js\":\"d47e7dc61e2fcb90\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/today.js\":\"dff43e7f4cb90343\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9beed9d87bcda7dc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"03fb68860af20e3a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/audit.js\":\"607d9fc44396f70b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditAction.js\":\"8691fea7491767a6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditRanges.js\":\"557467003eeb2c77\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/diagnosticsSource.js\":\"9d6e773b672913fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/divergenceScan.js\":\"44cbdab241a4ed32\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/index.js\":\"b6fc284d09c5e269\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/propertyChildrenChecks.js\":\"9cc237b4604a12b5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/referencesMirror.js\":\"498ee599d5430d4c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/rowJson.js\":\"5b0ef94f6bfb3ee1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/schedule.js\":\"f3c27597bea7cfc6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/store.js\":\"9fd6f5d5bf315446\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/action.js\":\"96293db176a76c5f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/index.js\":\"ed9c20e7cff2b76a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/plugin.js\":\"7d7783066bcc0653\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"13e9d4b0b42a6362\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/actions.js\":\"054f539a29c7ebd6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/changeMarker.js\":\"bb8e43d0f7f8aa94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/diagnostics.js\":\"4bf5b4d14f09aa31\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/fileSystemAccess.js\":\"7e46503872ba21c8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/filenames.js\":\"125af0bb53f43c6b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/index.js\":\"4b89a370a8e1e20b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/mirror.js\":\"5e8f8b7b48b2a1ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runLock.js\":\"8c33983b6552db87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runtimeHealth.js\":\"1eddec81ff8e76d3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/schedule.js\":\"ee5151c97dbee1f6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/store.js\":\"f4e204b2cdd784ed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/index.js\":\"d268db75b5dc637f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/themes.js\":\"ce6dbaa61b8737ed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/facet.js\":\"b2127d0df11fd489\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/useDiagnostics.js\":\"1793284dc6b37ab1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/dismissals.js\":\"f3852caa58cd9868\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/index.js\":\"963f0240f27c506e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/status.js\":\"3dd5a6112be92b16\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/store.js\":\"fbf150747a99474a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a7007dd8212fc6a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsSettings.js\":\"887d78bf374cf60f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/actions.js\":\"83e01aca26216eab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/config.js\":\"38ddc74f6d1e642a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/dataExtension.js\":\"e083323249b6d046\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/effect.js\":\"57874c5ea4727986\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/index.js\":\"9d0753d65e10fee4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/propertyEditorOverride.js\":\"35349e2c7f426d02\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/useToggleTree.js\":\"8790f06870ce075c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/ExtractTypeDialog.js\":\"e91ea44eac46f753\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"2c668c93ebf73ac9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/PropertyShapePicker.js\":\"451f832dd13be186\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/action.js\":\"7355c1c9b9488ffd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/index.js\":\"f70cc56b9059f8df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/FindReplaceDialog.js\":\"9063b1a83a2e549f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/HeaderItem.js\":\"42d6c496c804365d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/dataExtension.js\":\"8bc29e2adc5a361f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/index.js\":\"5f5bdbddebadc4f2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/search.js\":\"b6d6d3b9832135d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/toggleStore.js\":\"31db07b661f9c268\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/LocationPropertyEditor.js\":\"0de21297d8698d2e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/MapView.js\":\"30b170c401da5605\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/blockTypes.js\":\"900e12bec15d30bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/codeMirrorExtensions.js\":\"b8871c9ea47fe096\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/createOrFindPlace.js\":\"55d71ab5d96ee747\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/currentLocation.js\":\"6b9e8de4eb8bdf0a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/dataExtension.js\":\"621ce87a29452363\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/geoContentDecorator.js\":\"de691cb66c42e656\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/googlePlacesClient.js\":\"df9cd182812da444\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/index.js\":\"13c70c635cac3055\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/locationsPage.js\":\"43880b9e44df3222\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/mapViewport.js\":\"54b8abec16b37a2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/pickCurrentLocation.js\":\"3cf5959b631a0653\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeAutocomplete.js\":\"a532ac4b249067cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeNameCollision.js\":\"7dfb81c1633e032d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/properties.js\":\"824f37d891313d73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/propertyEditorOverrides.js\":\"2f67f70409f1a3f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/query.js\":\"1ef41a917d1477ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/usePlaceSearch.js\":\"8fa5c01b38114e72\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1f09568dd076d3b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e901e246064b6467\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"013118305f124ce9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/config.js\":\"9a5fcd506ba0e22d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/dataExtension.js\":\"fb7333c39d50c922\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/facet.js\":\"8936c78187a9bb20\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/grouping.js\":\"b4aa584abfe024ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/index.js\":\"7c25340986276130\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"50af59a2d7c42045\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/query.js\":\"58c6bfd1d8becc39\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/resolveConfig.js\":\"f05c2154823682f0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b22cafcdb189f00e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8d8ebc7f0ee858cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlDocumentContent.js\":\"7820c99cf66938a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlFrame.js\":\"eac75ac87319f9b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/actions.js\":\"7639c966d604574b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/blockType.js\":\"19c77167d3d62d3e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/confirmRunScripts.js\":\"50db97f7565b1289\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/dataExtension.js\":\"4c66ee70a48964d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameAnnotations.js\":\"272b0a7b04cc6b34\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameDocument.js\":\"b3a7b8692abf3f2b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameTheme.js\":\"ffc594125b740d21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/index.js\":\"66ed02ab34689ba6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/scriptConsent.js\":\"f9bdd85bd348714f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/sourceMap.js\":\"55696c81c6aec389\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/useDocumentScripts.js\":\"f42c6c42dc123928\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/index.js\":\"c22bf10f22f498a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/record.js\":\"b2c5e31579d33be0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/recordStore.js\":\"1d1fbb0b070a26c1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/responsiveness.js\":\"e2a63a7ca7c3deac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/schedule.js\":\"b64cff921ae6c9d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/sessionContext.js\":\"c842d3b998cf589c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c0f88dc9bd47f63b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b5e0473f976b65ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/actions.js\":\"280156854bf3436d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/config.js\":\"deaea7eda45ec871\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/dataExtension.js\":\"c250b988d7725365\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/effect.js\":\"09e6665ae114d707\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/index.js\":\"2e260c790e42a303\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/keyCapture.js\":\"c14d20e6c30917de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/overrideStore.js\":\"8f312833c13f61ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"60e9f7c28804f04a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/HeaderItem.js\":\"de22c3dc4b358ceb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/LeftSidebar.js\":\"d6652a9dee7875ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/actions.js\":\"804f0e9b990bb08e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/facet.js\":\"7626898fccd74937\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/index.js\":\"b742eee4b3b306f6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/shortcuts.js\":\"b79f1578573691b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/toggleStore.js\":\"c142912b39b85a2f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/MergePicker.js\":\"2413b85992893c30\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/index.js\":\"7e081e6871deaec0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/mergeAction.js\":\"b63de68761fca2f9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/strategy.js\":\"2d1d6fa04d259d34\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/Button.js\":\"2fdce7665866c58e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e1296493cf812c99\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/defaultItems.js\":\"66395e1f4506c8bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/facet.js\":\"a230a8355ccdaf9e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/index.js\":\"069eb5daaa47a0eb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d949284868735538\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a45582f91ba84e71\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5c839620990e16d7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9394afb0147618f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/index.js\":\"e910b5f0c295ef38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f5523ae5741d60e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a0759dd2de176756\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/contextMenuItem.js\":\"1c6f3fb823152ca7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/index.js\":\"64c0d832e3769f49\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveAction.js\":\"73c3c29b7bb8c082\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveBlocks.js\":\"476f5a5addbf2000\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/selectionAfterMove.js\":\"bf050b07af8be391\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/TutorialBanner.js\":\"5c29c0dfee7802c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/action.js\":\"28928c2942dbf8ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/bannerDismissal.js\":\"d08d9a0568ec0467\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/documents/cheatSheet.js\":\"1b4671d94782e220\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/index.js\":\"653077bb8fa2c05b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/keys.js\":\"9a493ec46d66e985\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/landing.js\":\"71e629481a04ea95\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/outline.js\":\"cf0a5439b290b574\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/seed.js\":\"20491424c847a20b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b0c1474c90d9d2cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/analyze.js\":\"82af08d6923ab2b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/diagnosticsSource.js\":\"f3781b8cddab7bea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/index.js\":\"17db2f9a56c6cacf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/load.js\":\"7a668487b5595418\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/monitorRun.js\":\"583741fbda50d794\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/schedule.js\":\"cb3e7dc2d59720d7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/series.js\":\"9a946fc9b6ad2971\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/store.js\":\"a4e266790511ca41\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/trendAction.js\":\"5ee7bf628fa1b483\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/verdict.js\":\"d095d550432972b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/clickToEditAction.js\":\"126c42802518557f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/index.js\":\"1daa31b88b33c260\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/interactions.js\":\"af2fce405395a579\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8d00b7c25d064f50\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGate.js\":\"bd9c81337e113b85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGateDialog.js\":\"5cdd84013dc16743\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/action.js\":\"9b1aa486a1c10963\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/index.js\":\"626f3011c8245a4b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/localRunMessage.js\":\"19c89a7662c48ea4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/plugin.js\":\"a26263ba7591237b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/progressReport.js\":\"8eb030c7d5211531\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/sweepProgress.js\":\"0e1998162d4d2d87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/FieldRowRenderer.js\":\"0c8a98cb62b4d05e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/ValueRowRenderer.js\":\"d652f49161c60e2c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/actions.js\":\"8790e4c4648665d6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/autocomplete.js\":\"d7e5c4802f11b78d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/fieldRow.js\":\"a5c9ccbce0bb05b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/index.js\":\"9a8f3e766d4a0c7f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/referenceWarning.js\":\"3c746e28f5fe569e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueAutocomplete.js\":\"0501a0eb4bc1c973\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueSchema.js\":\"7864a4d7f5debe8e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/HeaderItem.js\":\"c06ee022b323cf88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/QuickFind.js\":\"64915ac78efe5563\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/index.js\":\"440e9c6667e42fc5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/recents.js\":\"0976b6006cd34346\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/resultItems.js\":\"0cd2d4521deb6c83\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/selection.js\":\"2d3b328f5c6aa8f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/toggleStore.js\":\"3bd0b9a7be756ef1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/HeaderItem.js\":\"8bbe35a88e116b85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/RecentsPageBlockRenderer.js\":\"cd7702e96d764179\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/grouping.js\":\"0484571cc6abdb74\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/index.js\":\"90ebcc95b79dab46\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/target.js\":\"2249a1fab62932bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/codeMirrorExtensions.js\":\"fe3a74e53d466820\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/contentPrefill.js\":\"d75c2a9b7e6c90d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/dataExtension.js\":\"9ab2b97b7723d750\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/index.js\":\"7e41f2d401530036\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2e9017eb21e4a1cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/invalidation.js\":\"69b60477e39cfa7b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/localSchema.js\":\"64dc48022df36e5e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/index.js\":\"641768d3fae99e89\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"eab5079e82a58d16\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/index.js\":\"cb2d813b71c31253\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/referenceNode.js\":\"0253995b31db086f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4c7e030e8c8aad51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3f1143c6fde08e8b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/index.js\":\"4dd7ad68fa704e0d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c112fb8bd9bb89d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3386be08a2541a73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/mergeRetargetProcessor.js\":\"b645948537ffa98e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/parseFence.js\":\"3fcae076f92f1935\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceParser.js\":\"218b403b63ba07ab\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceProjection.js\":\"370a2a9ea357a2b3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referencesProcessor.js\":\"9f90c25475b129bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/renameProcessor.js\":\"eefabe683d37ae73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/spanReplacement.js\":\"e652dbeb85889a6b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/htmlToOutline.js\":\"ab635ddc0659cc51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/index.js\":\"a9ff0776ae90b1f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/normalizeClipboardDom.js\":\"02a0d42694507ac2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/pasteDecision.js\":\"7ce314f9b059455c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/action.js\":\"85c0e05790629a91\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/blockIds.js\":\"935095ac671dacd8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/content.js\":\"472bf0edc9205c88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/effect.js\":\"2082211204be3555\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/ids.js\":\"d71d27d41edffe68\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/import.js\":\"ddd0ca34b7687bd1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/index.js\":\"79199961220f60e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plan.js\":\"78f99274043be9f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plugin.js\":\"48d8194da25baa70\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/promotion.js\":\"421536e72d1bc3ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/properties.js\":\"2f72dec489827dd7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/references.js\":\"4cab907268ae5567\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/report.js\":\"099e93c06efd9b3c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/roamMemo.js\":\"4502a5b426ffd751\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/runtime.js\":\"616a8f6eae68b26a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/schemaReconciliation.js\":\"be09392eb47a316d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/srsMarkers.js\":\"05630552506e5809\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/todo.js\":\"651da92124e6306b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/typeCandidates.js\":\"eaeb25b544cb3267\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/types.js\":\"cd5fd9847dd4dd6c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/index.js\":\"eb945bbe5b4bb2ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/store.js\":\"ea51e1cf9bb350c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/HeaderItem.js\":\"2ce630dc112eb1f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"dea11cd8c1fcb86b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/index.js\":\"3e42d2f584840185\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/model.js\":\"ed41276209879404\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/toggleStore.js\":\"03934671af01144b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/useKeyInspector.js\":\"e9ed77cb5fb810af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"bdf24a77c05f99ce\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/ShellDecorator.js\":\"4d040271688d6bf4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/actions.js\":\"f4149ed4b87f6b18\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8c7e498037dfb303\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/index.js\":\"716926f1bd726263\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/shell.js\":\"66e5dec7247f7955\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/surface.js\":\"5a0f58a12ef5ea1c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/walker.js\":\"ac1eebb68ea4aa16\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5a4f10852b558a62\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/dataExtension.js\":\"df3f4889434eb549\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/index.js\":\"286410c46e7e4094\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/indicator.js\":\"fc80d1c0a879a86b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/moveSrsState.js\":\"b6cb8e18bd1d663c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a9dae7acbca58c69\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/scheduler.js\":\"3aaec87ee50d0dbc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/schema.js\":\"ff107dda8b3e04e5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e3889f53ca2b5b64\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsClipboard.js\":\"4d87f70153ae746e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9e5e011d49cae397\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3495d2bbd52bb8ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DeckPicker.js\":\"4f6f40473c03372c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewControls.js\":\"bc5371d66126b548\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewDeckRenderer.js\":\"063b34d5f48c026e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewSession.js\":\"17dc97da1af00ea4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/actions.js\":\"3efffe574828c00d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/archive.js\":\"3f915c1fe1305e59\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dataExtension.js\":\"df9a84c5c3eebc6a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/deck.js\":\"73bf4150e45ebcd9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dueQuery.js\":\"9eb9f91b72ad8244\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/gradeDecision.js\":\"cd73e4c8b6e46b88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/index.js\":\"ebc95f4a626ce370\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/keyHints.js\":\"07ff1753dbe4de7b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewCardLayout.js\":\"4c1984810b2a5e78\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewProgress.js\":\"9f9936df65ab5ee9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/schema.js\":\"d527cb80ddf8baaf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/useDueCards.js\":\"94c9418d9698a313\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/index.js\":\"fdc687a898464292\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/record.js\":\"69bde8d75a8f6150\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/index.js\":\"9f15b63c5530d00c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/persistenceStatus.js\":\"e77ed29526f7b689\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/requestAction.js\":\"7d2a49a723939863\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/TypeChipsDecorator.js\":\"9eaae36389165b6f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/codeMirrorExtensions.js\":\"43f2cc02016ee8ed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/index.js\":\"dc7a069ce2b11e73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/typeAutocomplete.js\":\"fcea9e1ccef67a8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"baf0fde94748050a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/actions.js\":\"56bcde3fb315b400\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/anchor.js\":\"b35476f097c44039\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/events.js\":\"e563660def81e3ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/gestureActions.js\":\"491d26b48d6ce56b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/index.js\":\"5892fcfc101ca4f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c3a9cdca92cfd86b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/collect.js\":\"59407dd59df847a7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/index.js\":\"d6a178d701725bed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/record.js\":\"bb2eb999e1472278\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/RejectionDialog.js\":\"08de742f549d52b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/SystemStatusHeaderItem.js\":\"8767d8cac963e999\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/index.js\":\"3d3109f33a15ba21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/model.js\":\"e4f449d553b158a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/queueCounts.js\":\"0f5d5e91328c5914\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rejectedHelpers.js\":\"41d1c38ca0ff590f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rematerializeAction.js\":\"a37470262a9ecbea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/useHysteresis.js\":\"bcc090dd4d2c33f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/ColumnHeaders.js\":\"23246785c89f42d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/QueryUi.js\":\"0f715b7b95ccdc35\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/TableLayout.js\":\"0bd7295dd2ccab70\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/actions.js\":\"6a675cc515bf1af5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/cellEdits.js\":\"31eb7d9c8fbedb79\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/columns.js\":\"c782d18ee0d062e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/controller.js\":\"f4e10c89730f8775\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/convert.js\":\"2ba4f8be0c2dedf2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/dataExtension.js\":\"d9ea4cc4e6dcc67f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/index.js\":\"f8e56a6aec7b5f5e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/keys.js\":\"d6e21e986697d50c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/model.js\":\"ee8d0c8d8578aef0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/backfill.js\":\"412e0518b7883daa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/format.js\":\"2b614a4a27587cdd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/parse.js\":\"38c2b500759cd0ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/queryValue.js\":\"54aae151d8f63607\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/source.js\":\"91a815550cce04e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/registry.js\":\"7d3c7e7374c2fc57\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/schema.js\":\"22b2d2c52211d496\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/sort.js\":\"75fbe27861322ffd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/effect.js\":\"9de8a8c44fa87c21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/index.js\":\"12f685fa383845c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/theme.js\":\"90627b79e4330b2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/actions.js\":\"fadfc780cf23d8f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/dataExtension.js\":\"2384e161d945a5dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/index.js\":\"62c56c825e125475\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/schema.js\":\"e3c3cd69c12e6679\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0bc0acb510862ccd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/actions.js\":\"1ab252f28008ab38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/defaultItems.js\":\"484eed6fea7bdf7a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/facet.js\":\"361259becc05c596\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/holdRecognizer.js\":\"aebd65b7a7337eee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/index.js\":\"fcdb6c17fab5b3e9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/UpdateIndicator.js\":\"a6411b4ce39fbe4e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/index.js\":\"d58cade6328a319b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/loadTimes.js\":\"71b1b6777333cef1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoNotesRenderer.js\":\"79eb57558c3855f9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoPlayerRenderer.js\":\"dcd8ccc6c6aba7db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoTimeStamp.js\":\"ea435617a90c894d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/actions.js\":\"e9c79fa2a90d5936\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/index.js\":\"2de7d1705212915d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/markdown.js\":\"a514dbc8f75828db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/notes.js\":\"ac80d295b2d50460\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/registry.js\":\"8054962d157f37e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/remark-timestamps.js\":\"0821ab84b09fd390\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/view.js\":\"0a9013aabf5d00e5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/LinkHints.js\":\"2ab4df2fedbfa653\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/index.js\":\"d7483bba43264e82\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/model.js\":\"50236c2802f53129\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/settings.js\":\"3b0ba376e78ea0e6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/actions.js\":\"e8e0ef180b534269\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/index.js\":\"5af75aced9a2af59\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/interactions.js\":\"d07e8b4bafff5190\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/workspace-header/index.js\":\"9d6521fdc0d34343\",\"/knowledge-medium/pr-preview/pr-1844/src/registerServiceWorker.js\":\"e9c7621e97720acb\",\"/knowledge-medium/pr-preview/pr-1844/src/requestPersistentStorage.js\":\"f6baa657b3ad1bf0\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authRequestDeadline.js\":\"536c65f2701f6cdd\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authStorage.js\":\"0e1fe69aec6b9639\",\"/knowledge-medium/pr-preview/pr-1844/src/services/powersync.js\":\"eb3f5ebe3b8d99f8\",\"/knowledge-medium/pr-preview/pr-1844/src/services/supabase.js\":\"8450d333e6cfada4\",\"/knowledge-medium/pr-preview/pr-1844/src/services/uploadErrorClassifier.js\":\"4a0547361905d0c8\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/ActiveContexts.js\":\"6184da68b2db0620\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/HotkeyReconciler.js\":\"6741aeb0d42139e7\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/WipeLocalDataDialog.js\":\"259771536a50524d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionDispatch.js\":\"da39bba7033f1557\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionRefItems.js\":\"683cf6bf5f5aa2b8\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/applyKeybindingOverrides.js\":\"b5dae144f3172b9d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/blockActions.js\":\"2e8937f890d9589f\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/canonicalizeChord.js\":\"326904f27a943e99\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultContexts.js\":\"fa254fade14dcdd4\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultShortcuts.js\":\"0ac4e966a716060a\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/effectiveActions.js\":\"403177932603fdd7\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureAction.js\":\"eb08aba6849b11e9\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureBinding.js\":\"6feeb93db3e6a57e\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/holdRegistry.js\":\"8964dbe74f3180e0\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingConflicts.js\":\"f8d04e41a641f3d9\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingOverrides.js\":\"964118a5ffa001c5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/pointerAction.js\":\"c8ff74e9bfeab164\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/resolve.js\":\"2551f684c008087d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/runAction.js\":\"ab77f78b229edc49\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/sequenceMatcher.js\":\"347738ae85672e8c\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/types.js\":\"9ef2d83bdefa737a\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionContext.js\":\"52a019cde0579038\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionDiscovery.js\":\"cae28e02cc74be2b\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/utils.js\":\"dcd451d1f084ef4e\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/bootStore.js\":\"76e423d12e0d544f\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/previewDatabases.js\":\"cc18238436a749a8\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/byteTransform.js\":\"d4a129d35ab41f64\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/attachmentCleaner.js\":\"c2b1a98ef4013ec7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/attachmentParts.js\":\"7634952ff12c54fd\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleParts.js\":\"a6d56c14aaf0c256\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleRecord.js\":\"b12e2501a5c8ab4c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/manifest.js\":\"1b1dd240b06e71e9\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/takeBundle.js\":\"20583171947a525a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/verifyBundle.js\":\"7513803321ded9ac\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/cleaningStage.js\":\"90a04d36aa18a442\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionKey.js\":\"f34da7f810f2100e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionServer.js\":\"1b857fa118b4b724\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flip.js\":\"7f96759df7acc30e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flipAttempts.js\":\"7a8275f269236de7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/pages.js\":\"48fc0f65b5b92e10\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/preflight.js\":\"e437d1ad938ccbd9\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/reseal.js\":\"bd8e6504429a4e1c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runConversion.js\":\"9ccbb7e076a287be\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runLock.js\":\"b0464493567356ae\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealing.js\":\"5ca5d9092602be23\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealingStage.js\":\"1866b1dc83b88ea1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/stage.js\":\"d960aeb2d713a77b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/verifyReseal.js\":\"3f985fd495331f57\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aad.js\":\"c95749c285bc6c05\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aead.js\":\"b4c3a51a8086a875\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base32.js\":\"a332b5d36bb577c1\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base64url.js\":\"4c671fdb8f23366a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/binaryEnvelope.js\":\"1c5483dcbcb81c60\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/byteAead.js\":\"f1252f54dc746e69\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/canary.js\":\"b6370c6870143c53\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentHash.js\":\"2df22c51624fc256\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentKey.js\":\"57baa1207e2e7d44\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/derivedIdNamespace.js\":\"b121112f04dcaa48\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/envelope.js\":\"19590de6e686872b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/hex.js\":\"d867e677f49afb08\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/sha256Hex.js\":\"1ed6969f610da750\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/workspaceKey.js\":\"6a26e088676fe61d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/conversionState.js\":\"ce474304dbfdd3f2\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c2fab1493dc24d3d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/pastedKey.js\":\"440086fa78bdd7fd\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"110b3d5f95a0358d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8200ad07c295cb15\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/keyStore.js\":\"a3779995245f5521\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/mintWorkspaceKey.js\":\"74b144369835bd09\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/modePin.js\":\"3516d25f19963322\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/openWorkspaceKeys.js\":\"dc34604d805663d7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolveWorkspaceEntry.js\":\"2b178514c4203ad4\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolver.js\":\"3e1dd3ef67726c00\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/workspaceAccess.js\":\"343dc42c1875cae6\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/transform.js\":\"af2ed9841a4fcfaf\",\"/knowledge-medium/pr-preview/pr-1844/src/themeBootDefaults.js\":\"0921bdae54ef62a3\",\"/knowledge-medium/pr-preview/pr-1844/src/types.js\":\"34cfbe9e2ce760d4\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/ClientLocalSettings.js\":\"1262030979cfa166\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/abortableSleep.js\":\"3d77dd788b38c22c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/array.js\":\"e87166f0cd946b59\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/backlinkAutocomplete.js\":\"be26a73878badf80\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockCrumbs.js\":\"4b4a0184fb174a67\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockrefAutocomplete.js\":\"c9798c233d21261e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/cadencedIdleJob.js\":\"bce716c49299ca47\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/callbackSet.js\":\"9cf33c246051b0d1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/clientId.js\":\"10f8cac7cad47c16\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirror.js\":\"e3ffc5ba3ff79931\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirrorCompletion.js\":\"b1c4806d59e11c67\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/copy.js\":\"ab453706371774c2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dailyPage.js\":\"3c455b5447900bff\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensics.js\":\"025331327b2be17d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensicsHooks.js\":\"73f07ab2f2037c01\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/deleteBlockThroughUi.js\":\"2caa578b8b169583\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dialogs.js\":\"fc5b47785968e2f6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dom.js\":\"1dfdfaba1b16ead7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/downloadBlob.js\":\"893bf7d2b2269948\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/exportSqliteDb.js\":\"bf120b631e7f6b68\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fileSystemAccess.js\":\"22aa53fb576cb79e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/flipSlide.js\":\"600dd2983a81fe82\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fnv1a.js\":\"51a3ec8dbce9b215\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/formatBytes.js\":\"2e06df1d2f7df0c8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fuzzyRank.js\":\"993a6da95fd06cb3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idbKeyedStore.js\":\"76c96d3c16da737d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idleCallbackPolyfill.js\":\"fe47533d633a4578\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardAwareScroll.js\":\"100d8d5f523207f1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardViewport.js\":\"4ec569af1ec140f8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/lastWorkspace.js\":\"1795eb072107fc62\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutColumns.js\":\"d123932d20ed93d5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionDom.js\":\"820f37abeebbb639\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionId.js\":\"8971058eea50ea59\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkClickGestures.js\":\"aa090505313df3b2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkTargetAutocomplete.js\":\"62e68d21a8641b6a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbCorruption.js\":\"8fc8e69359519a4a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbRecovery.js\":\"f40bc5fde4b6f34f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/markdownParser.js\":\"582a2bce13426f7b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/memoize.js\":\"b0fe93a5e0af2f76\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameFieldCommit.js\":\"4e964a709f532bb5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameList.js\":\"dec52e63d773b920\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/navigation.js\":\"56a9217f6b836036\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/omnilinerNamespace.js\":\"41651470daf8840e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/opfsPageScan.js\":\"2d2c97af2fdbf098\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelClearance.js\":\"ab4c4f62c0ee0d98\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelHistory.js\":\"b77975cfaafd6763\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLanes.js\":\"14f69ba3d7b81982\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLayoutProjection.js\":\"885b071ac92073a2\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelScrollAnchor.js\":\"811be40023f6ae1e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelUrlFlags.js\":\"8425aaebe2efec2a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/platform.js\":\"183cf61637090688\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/pluralize.js\":\"e3c84bcadfcb535a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyCreation.js\":\"51e9f5c786bc9de1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyNavigation.js\":\"c7f93aef8fa66f6f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyValueContext.js\":\"8edba1a6173c247d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/react.js\":\"9b7e21835623a31c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeDate.js\":\"8f0e645c8d8c8c46\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeTime.js\":\"a607ca8b971802fb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/renderScope.js\":\"595bb559efe2f569\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/resolvedThenable.js\":\"c7a6e2676d289cbc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/routing.js\":\"9a21490518033cf8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/safeMode.js\":\"897f95edb9fb5182\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/scheduleIdle.js\":\"01b5924681e89f39\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/screenWakeLock.js\":\"17a4acf78a888f27\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/selection.js\":\"8c2b6407aa3ea1cb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/softKeyboardGrab.js\":\"2879c380d098b53f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/startupTimeline.js\":\"e0870000f32bab6b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/state.js\":\"f7e6dfddcb71715c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/string.js\":\"4d54f50a6dbd4bb8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/surfaceZoom.js\":\"e0386c6ed872cf64\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/time.js\":\"3cee45dd9795b053\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toast.js\":\"51eb4e4c3148d1eb\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toggleStore.js\":\"e7c0364a8afc4058\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/untilStopped.js\":\"435c5846980bd663\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/userActivity.js\":\"3f6ea2ff475188cc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewTransition.js\":\"d8633bcf56aad42a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewport.js\":\"fbf992e60c6330d1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/webLock.js\":\"ce2788307972a0dc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceRecovery.js\":\"e1702330feed3bed\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceSnapshotStore.js\":\"65f82ec78338d658\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-compiler-runtime.js\":\"cbe9d2f40c931a55\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-client.js\":\"277b8da825d4cc5c\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server-edge.js\":\"8e51a9479b0c7986\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server.js\":\"4238c65dfd899c4c\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static-edge.js\":\"0f7d78114b24df6f\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static.js\":\"477b6270cf292b09\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-test-utils.js\":\"d8f25c4d8a42c397\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom.js\":\"9dd038d23e9cbdf8\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-runtime.js\":\"1a82a7473a7f8bd8\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react.js\":\"0562daefcd5a2cd7\",\"/knowledge-medium/pr-preview/pr-1844/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
