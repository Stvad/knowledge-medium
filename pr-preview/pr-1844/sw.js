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
		buildId: "b22a7382ecb1-29f07e21",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/\":\"27d9f4d9d46b23da\",\"/knowledge-medium/pr-preview/pr-1844/index.html\":\"27d9f4d9d46b23da\",\"/knowledge-medium/pr-preview/pr-1844/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1844/assets/FacadeVFS-CdPZJozz.js\":\"95dbbe99d24a85e0\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSCoopSyncVFS-DX-4dq8o.js\":\"f61de067a0052a45\",\"/knowledge-medium/pr-preview/pr-1844/assets/OPFSWriteAheadVFS-BhUDl6pR.js\":\"90c784d9a94dae31\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-async-BWUc3oPE.js\":\"dbf8f5c7e4fa691a\",\"/knowledge-medium/pr-preview/pr-1844/assets/wa-sqlite-ikNcdICK.js\":\"13bb89deac0b406f\",\"/knowledge-medium/pr-preview/pr-1844/assets/worker-BeKqn80T.js\":\"95f1ed473eb16e98\",\"/knowledge-medium/pr-preview/pr-1844/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1844/chunks/app-CdWCRFxQ.js\":\"e49a181f55d41843\",\"/knowledge-medium/pr-preview/pr-1844/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1844/index.js\":\"c8e026ee5b152fe5\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1844/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1844/assets/AccessHandlePoolVFS-A3-OAZnf.js\":\"3594d17686c4670e\",\"/knowledge-medium/pr-preview/pr-1844/assets/IDBBatchAtomicVFS-C6xEtJtD.js\":\"cc1fadd6cbcadeab\",\"/knowledge-medium/pr-preview/pr-1844/assets/MemoryVFS-DVo-dTJ4.js\":\"d8f85a52506fe0b2\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-SUWAzvyQ.js\":\"abf42bf3002268da\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-5cmjl-J3.js\":\"00adf704c198e3ef\",\"/knowledge-medium/pr-preview/pr-1844/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1844/chunks/AccessHandlePoolVFS-CPTMHl_l.js\":\"a68d29750284bbaf\",\"/knowledge-medium/pr-preview/pr-1844/chunks/FacadeVFS-DzqPx8Jb.js\":\"9f369aa9bf8fabe1\",\"/knowledge-medium/pr-preview/pr-1844/chunks/IDBBatchAtomicVFS-DmacUsL8.js\":\"2b65b77376fe9c1c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/MemoryVFS-CcO6rVPY.js\":\"28adba0883ca4e12\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSCoopSyncVFS-DaKJF20s.js\":\"43de6e154d7022d5\",\"/knowledge-medium/pr-preview/pr-1844/chunks/OPFSWriteAheadVFS-DAAm0eVl.js\":\"a6010ad7e247af62\",\"/knowledge-medium/pr-preview/pr-1844/chunks/Preview-CYUv4Jjp.js\":\"590536c9c34a4a6d\",\"/knowledge-medium/pr-preview/pr-1844/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/card-C10d5mJz.js\":\"9bbb3f7c24beaa84\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1844/chunks/dist-Cq88bi5Q.js\":\"12e343e087a55c64\",\"/knowledge-medium/pr-preview/pr-1844/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-CnUpQEJl.js\":\"21a79808d9b496a7\",\"/knowledge-medium/pr-preview/pr-1844/chunks/mc-wa-sqlite-async-CvGrzZ_c.js\":\"9692696160d7f73c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-B1XztsP0.js\":\"9851207d0f5cce47\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-B6VaxITl.js\":\"d43ff5ada899fd25\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-CAEaLo_i.js\":\"889184a296e25e7d\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-COZ0v0Fj.js\":\"6141e660428e5a52\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-D9NUG96E.js\":\"9cbc3239140cb665\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-DP-7n8NI.js\":\"cbf34cd1fd5a23a0\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-P4iRVJ9I.js\":\"0e5aa9f3543b875b\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server-legacy.browser.production-B4YnEWah.js\":\"d6a4dd850f55ce33\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.browser.production-DyjD2T3U.js\":\"e3f26a232550f3d5\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-dom-server.edge.production-DV1L4CBA.js\":\"5c816dd8774538a5\",\"/knowledge-medium/pr-preview/pr-1844/chunks/react-zqrO8l1p.js\":\"81e9025419e7c56f\",\"/knowledge-medium/pr-preview/pr-1844/chunks/server.browser-BNMpn4Ve.js\":\"049055c4f870b16b\",\"/knowledge-medium/pr-preview/pr-1844/chunks/textarea-CRWr3Yio.js\":\"f68d00b28d9f462b\",\"/knowledge-medium/pr-preview/pr-1844/chunks/ui-BRVmoIbb.js\":\"2efd7d8144f62d86\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-BvEzlTnI.js\":\"5393f551905b546c\",\"/knowledge-medium/pr-preview/pr-1844/chunks/wa-sqlite-async-Xadwtb4r.js\":\"bafc79d117cd8e66\",\"/knowledge-medium/pr-preview/pr-1844/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1844/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1844/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1844/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1844/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1844/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1844/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1844/src/App.js\":\"5b4bb3f3085d9549\",\"/knowledge-medium/pr-preview/pr-1844/src/appUpdate.js\":\"ebcd654e7432cacf\",\"/knowledge-medium/pr-preview/pr-1844/src/appVersion.js\":\"41b03c7ffe053b1a\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/initialLayout.js\":\"f92af744d9679d40\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/openWorkspaceData.js\":\"77d727283c8f12a8\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/resolveWorkspace.js\":\"093433a446cace16\",\"/knowledge-medium/pr-preview/pr-1844/src/bootstrap/workspaceBootstrap.js\":\"3346827470badde8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockComponent.js\":\"5bd9fe1597764294\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockCrumbs.js\":\"14ba81a70a1386fc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockEditor.js\":\"75746d3ec5f21ba5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockLoadingPlaceholder.js\":\"5aed62c4b37ad512\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockProperties.js\":\"cb2d4925a317599d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/BlockSearchPicker.js\":\"be9be5e145132565\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ConfirmBulkDeleteDialog.js\":\"1784b3b317ee7b55\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DividerHandle.js\":\"e5d2e41be35ab64f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/DraftEditor.js\":\"8fd74f1a572296e7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/GutterPill.js\":\"0550e89d95537ed3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Header.js\":\"9e143d6317a67e79\",\"/knowledge-medium/pr-preview/pr-1844/src/components/LazyBlockComponent.js\":\"d10b647cfff9fa35\",\"/knowledge-medium/pr-preview/pr-1844/src/components/Login.js\":\"8252dbb6e6f9a5f9\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ZoomableSurface.js\":\"66d4f92bfc42e346\",\"/knowledge-medium/pr-preview/pr-1844/src/components/editModeKeepalive.js\":\"41eb827862d6632c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6f7d35991f9a56a8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"91aff5562acd036c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefPropertyEditor.js\":\"49ea7c392c109b07\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/RefTargetTypePicker.js\":\"1f803f0290fee2ae\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/SelectPropertyEditor.js\":\"74dadf3e0d77e805\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/TypesPropertyEditor.js\":\"4530ddedd0d6a7e2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/defaults.js\":\"57adb162424cad3b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/kernelValuePresets.js\":\"9298aa3805d88028\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/selectablePresets.js\":\"4eff525b6d9993fc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyEditors/typesPropertyUi.js\":\"aa0fb47b7e102ded\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/AddPropertyForm.js\":\"438848e896dfb79f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyPicker.js\":\"d0e0ad76af3e0f4d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/PropertyRow.js\":\"b02958c0c47a287a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/Rows.js\":\"edb7c29f8520565c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/actions.js\":\"fe1204771f58afe7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/declarationOnly.js\":\"5eb5378f15f77978\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/layout.js\":\"e8af938013de6675\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/model.js\":\"c86a0809c978e3ae\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapeUi.js\":\"a9b1159057f6f6da\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/shapes.js\":\"e5db45ae369559a6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ca08f9bf4cc47ceb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanel/visibility.js\":\"625a1618c963958c\",\"/knowledge-medium/pr-preview/pr-1844/src/components/propertyPanelSections.js\":\"a4ed0dd4f624a460\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockEmbed.js\":\"97f8285d596c4e32\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockLink.js\":\"4a0a4b3ef33c30bc\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/BlockRef.js\":\"4934bdbda6bf6741\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/ReferenceLink.js\":\"6f5c5f6bcf11a411\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuard.js\":\"6a9165fecc3e5273\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/cycleGuardContext.js\":\"33255ee0c58b841e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/linkInteraction.js\":\"952cdf34b10dca7e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/referenceLayout.js\":\"e8c33212322f633d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/references/useBlockRefAncestors.js\":\"477642213dbfdc44\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockGutter.js\":\"b01af08e96dbee5e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockInfoDialog.js\":\"65c6aa582dd4776a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BlockTypeBlockRenderer.js\":\"26c63257d8c20717\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/BulletHoverCard.js\":\"4b904fbdb2441de2\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorContentRenderer.js\":\"710432835ee5355b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5948c5e257aa3012\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ColumnResizeHandles.js\":\"9eb6c86ef34a4845\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"363b023ff2a16eb3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/DefaultBlockRenderer.js\":\"ce6f3974126ce5cb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/LayoutRenderer.js\":\"c35d60d8ea5df716\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MarkdownContentRenderer.js\":\"c09f21e69a068943\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/MissingDataRenderer.js\":\"6e89cd1c14418f8f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PanelRenderer.js\":\"28825ca4c45dbbed\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d328a9ecdb316e80\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/TopLevelRenderer.js\":\"dc5243aaef18a498\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockGutterMode.js\":\"ceb3f93ed8c04a14\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/blockTitleText.js\":\"427e9c460b350b8d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/fieldCreationKeydown.js\":\"318bf64d6f9e0d19\",\"/knowledge-medium/pr-preview/pr-1844/src/components/renderer/layoutRootContext.js\":\"1e3f4fc169377fef\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/TypeChip.js\":\"8a2d596ce67899bf\",\"/knowledge-medium/pr-preview/pr-1844/src/components/typeChip/chipStyle.js\":\"882ac68601a7178a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/anchored-floating.js\":\"5e2e8e5df944e5ec\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/button.js\":\"64b0d917546aa0c6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/card.js\":\"1f003fbd7245231d\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/checkbox.js\":\"46ecf063eb74067e\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/collapsible.js\":\"d8f3eac97f3c0020\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/command.js\":\"5229feedf2d13cb5\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/context-menu.js\":\"419e516be1dedb17\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dialog.js\":\"0e8669e088d68c2f\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/dropdown-menu.js\":\"4695088733384054\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/floating-listbox.js\":\"f8fbc214400a0f13\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/index.js\":\"dd9b0b54b466e425\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/input.js\":\"01586758f65e0a61\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/kbd.js\":\"2ba4bc04ac75eed6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/label.js\":\"f068bff8828e5675\",\"/knowledge-medium/pr-preview/pr-1844/src/components/ui/textarea.js\":\"b13f2704edf5db94\",\"/knowledge-medium/pr-preview/pr-1844/src/components/useEditModeYieldKeepalive.js\":\"4db4dc50084418d6\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/BootFallback.js\":\"6030413005aa9d55\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/FocusedRowLazyMount.js\":\"fb61e16455a0cf17\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LazyViewportMount.js\":\"76dc55473b721ad1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/LocalDbCorruptionFallback.js\":\"c58856afcbd31844\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/error.js\":\"cf1703c329244ebd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/lazyMountRegistry.js\":\"d58c31b6f1334f5a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/util/suspense.js\":\"e025fff14d4bf004\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/CreateWorkspaceDialog.js\":\"172136c9a76967ba\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/PendingInvitations.js\":\"e85596c1cd2f4bb1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/SyncProgress.js\":\"2c802efb0f529808\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/UnlockProgress.js\":\"8b9f0091f55651fb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceKeyGate.js\":\"41aad04020f0a4b8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSettingsDialog.js\":\"f3e5c67f92535c1b\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSwitcher.js\":\"ba4b722d1d0e646a\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/WorkspaceSyncGate.js\":\"cfcaf17b39d28ea0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlow.js\":\"5d9da58c36acfe10\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/ConversionFlowHost.js\":\"8311665400e01de7\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/EncryptionSection.js\":\"17f6de85335c7ec0\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/attachmentPrompts.js\":\"0732fc2436e34805\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ff4abe0552d8fce3\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowDeps.js\":\"def218081a10b187\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/conversionFlowStore.js\":\"2511cb3aa93b02fb\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/flowUi.js\":\"8db1814408f83435\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/conversion/useConversionRun.js\":\"162baeccea15ace1\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/keyUi.js\":\"08cde590d520c965\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnKeyLoss.js\":\"04f616e20b2da5c8\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/useCloseOnServerE2ee.js\":\"52de680202d56ebd\",\"/knowledge-medium/pr-preview/pr-1844/src/components/workspace/workspaceUnlocked.js\":\"71ffc40973ee0215\",\"/knowledge-medium/pr-preview/pr-1844/src/context/backgroundSubtree.js\":\"6d97f69dd8da9786\",\"/knowledge-medium/pr-preview/pr-1844/src/context/block.js\":\"5b4a3a198d7257c3\",\"/knowledge-medium/pr-preview/pr-1844/src/context/layoutWsContext.js\":\"49a9a534ffd6f97e\",\"/knowledge-medium/pr-preview/pr-1844/src/context/propertyDisplay.js\":\"ae4a4387fb5be94d\",\"/knowledge-medium/pr-preview/pr-1844/src/context/repo.js\":\"e564e7f63b7f2ff5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasClaim.js\":\"ef605b3539dc979d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/aliasSeatNamespace.js\":\"cfa6455d01816d47\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockData.js\":\"3d2fcfb42d6564fa\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/blockType.js\":\"6e43079bbde98b77\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/changeScope.js\":\"f7a068a240fc2673\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/codecs.js\":\"1ebe50f45c4e982a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/derivedData.js\":\"bc67e4bb63853866\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/errors.js\":\"5e0dab3a14afd42d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/events.js\":\"ce02d167cc0002c1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/handle.js\":\"b9e55a417b16be78\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/index.js\":\"75e2ee193c679099\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/mutator.js\":\"4857d2e5540ad737\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/processor.js\":\"9b3c4a9bcc2e8610\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/propertySchema.js\":\"09c98f34ed213f19\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/query.js\":\"68fe8d4b46149eac\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/sameTxProcessor.js\":\"ba0adc1f775ecb3f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/schema.js\":\"b9e55a417b16be78\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/tx.js\":\"b9e55a417b16be78\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/typedBlockQuery.js\":\"f957de754318910b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/user.js\":\"d50c5f52c398fe8f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresetCore.js\":\"6bf62f6e6aaad7ce\",\"/knowledge-medium/pr-preview/pr-1844/src/data/api/valuePresets.js\":\"c44e6d3acf61c5c9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/attachmentCleanerIOVerb.js\":\"be672feda08a711f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/block.js\":\"f5def7874f73bcb4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockCache.js\":\"d6481c35712a0c56\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockId.js\":\"b4f3a63cd9f8d9cf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockLiveness.js\":\"5e459147f3a6c110\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockMerge.js\":\"3963f9613c75380b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockSchema.js\":\"a43e56729ebb11c2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypeLookup.js\":\"92ac07f1937a753e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/blockTypes.js\":\"c0a4f0c0fe584f22\",\"/knowledge-medium/pr-preview/pr-1844/src/data/clientContext.js\":\"632531d39bda999d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/dbFileSiblings.js\":\"40f3aec05037ae2d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/definitionSeeds.js\":\"062cf1231b3b60f8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/derivedIds.js\":\"f7bb882081f6e2e2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/drawnSubtree.js\":\"22e082a0d049ff1c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facetBridge.js\":\"59f6fd3bfff7c619\",\"/knowledge-medium/pr-preview/pr-1844/src/data/facets.js\":\"dd3ee1a2ac99e90a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/globalState.js\":\"f18d2ab23d3a4bcd\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/aliasClaimRederiveProcessor.js\":\"c2bd8447684100c7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/ancestorBatch.js\":\"7b6b7a14b3af628b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/blockTypeTypeifyProcessor.js\":\"e5b8d74cf5db4857\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/clientSchema.js\":\"c444b1554071744a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/commitPipeline.js\":\"56dbfdfde035b1db\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/devAssertions.js\":\"f3c550fd5ad8da4d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/firstSync.js\":\"e35934f4afacaa5e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/freshInitialLoad.js\":\"447dd285a3d2488d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/graphBackfillClaim.js\":\"ebaac36d212e4f24\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/handleStore.js\":\"c0603da41bc239ec\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/idleMarkerJobs.js\":\"b37482b6491f3cf9\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initialDownload.js\":\"64180c80ce73046f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/initializeClientDatabase.js\":\"6fbd68865e903c40\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/jsonCanonical.js\":\"66a2ea4fdfdf76c0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelInvalidation.js\":\"deb1443394d7d769\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelProcessors.js\":\"b4532e12b48bc3d5\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/kernelQueries.js\":\"72669efce9c2e79b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/mergeTypeMembershipProcessor.js\":\"e1b96999db6ba6db\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/normalizeReferencesProcessor.js\":\"222f560ae5497dbb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/poolInstrumentation.js\":\"4089530c5748ca24\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/processorRunner.js\":\"e7bd29a7a1a82cad\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyCellBackfill.js\":\"7ead71a4b3282c62\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildMint.js\":\"dfd779bda49cfff7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyChildrenProcessor.js\":\"24442b190d25376a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4ccdd79bd8e02fbb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyDefinitionSynthesis.js\":\"89b9c9e5abf52e47\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyKeyScan.js\":\"1d952f331736985d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertySchemaResolution.js\":\"b62b71a8b94d3fa7\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/propertyValueEdits.js\":\"eccbb226895fa51a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/raiseProtocol.js\":\"3981ba6de4eea2f3\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/readBatch.js\":\"a09481532745bf7e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/refProjection.js\":\"4cc612e804c1a243\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetLookups.js\":\"f59f98573542cbf2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/referenceTargetProcessor.js\":\"31e4e63d60300b60\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/replayMerge.js\":\"89058e4954f84e48\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/sqlBinds.js\":\"99af11ee8e5b4d99\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c12c8ecffe0c97bf\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/arrivalProcessors.js\":\"f123fe7a182de100\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/invalidate.js\":\"d52e0ba32ac58dee\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/materialize.js\":\"03a9d3c4df22be36\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/observer.js\":\"4f15af7f44d1547d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/syncObserver/reconcile.js\":\"88bc02b3c27df559\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/timingMetrics.js\":\"cb6d965acb186fb0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/treeQueries.js\":\"64b7ef09efbddf8b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txEngine.js\":\"a6ffae5ab6e0cd30\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/txSnapshots.js\":\"b8e14d214fc8bce8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/typedBlockQuery.js\":\"cad09b1da5f9eae6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/internals/undoManager.js\":\"988ffe479a1ddf4b\",\"/knowledge-medium/pr-preview/pr-1844/src/data/invalidation.js\":\"5896fc0773166ce1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelDataExtension.js\":\"3f29bbdbd9e638a2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelPage.js\":\"6831a10587a68142\",\"/knowledge-medium/pr-preview/pr-1844/src/data/kernelValuePresetCores.js\":\"9689d7bbd5921585\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbCorruptionSignal.js\":\"624f7f72d13e9f4c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbStorage.js\":\"8f4df6a3a579b772\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localDbVfs.js\":\"81c83071d7d49a9c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/localSchema.js\":\"007dbde030a730c1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/maintenance.js\":\"457f97112112e0ff\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mergeProperties.js\":\"1e99265611415025\",\"/knowledge-medium/pr-preview/pr-1844/src/data/metricsConsoleHook.js\":\"b152ef9dedbaa21c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/migrationsPage.js\":\"901b241fcba87789\",\"/knowledge-medium/pr-preview/pr-1844/src/data/mutators.js\":\"08d2e803b088f7b0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKey.js\":\"0dc0cb53cc734408\",\"/knowledge-medium/pr-preview/pr-1844/src/data/orderKeyPlacement.js\":\"71771c69ec1226ef\",\"/knowledge-medium/pr-preview/pr-1844/src/data/outlineSurface.js\":\"6920ee50dd59454d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingEditorContent.js\":\"71443d59c612bd6e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pendingUploadsSql.js\":\"658cc3b6b098f87d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/pluginStateExtensions.js\":\"781048139042229d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/powerSyncLogger.js\":\"ae55d1991de4fa2e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/projectorRuntime.js\":\"c2ea0cad554b6b0d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/properties.js\":\"ec2d714dc7594dbc\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertiesPage.js\":\"8a97f32160a7dd8f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyChildren.js\":\"24ecae5cf3c663f0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionFanout.js\":\"a4a2609081765b99\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionMetadata.js\":\"a1e1397710b55e0c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDefinitionRegistry.js\":\"8b4e442d61625d68\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyDisplayMode.js\":\"9c0c2a59886ac5a4\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertyRowCreation.js\":\"09309deaec6fa29f\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySchemaCreation.js\":\"0610458d2494b3d0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/propertySeeds.js\":\"a2d184f53face406\",\"/knowledge-medium/pr-preview/pr-1844/src/data/recentsPage.js\":\"574bef44299fd7ed\",\"/knowledge-medium/pr-preview/pr-1844/src/data/referenceBlock.js\":\"aca5c3b5e7d465be\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rejectedUploads.js\":\"fc62bf4ca7a3248c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/releasePowerSyncConnection.js\":\"3f4e3033dafbede6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repo.js\":\"d6138d41c1fd03da\",\"/knowledge-medium/pr-preview/pr-1844/src/data/repoProvider.js\":\"eb8915f93669ae0a\",\"/knowledge-medium/pr-preview/pr-1844/src/data/rowProperty.js\":\"9696483d50f7b4f0\",\"/knowledge-medium/pr-preview/pr-1844/src/data/searchFilter.js\":\"6ececcfda364df67\",\"/knowledge-medium/pr-preview/pr-1844/src/data/seedIdentityLedger.js\":\"3135914609fda475\",\"/knowledge-medium/pr-preview/pr-1844/src/data/stateBlocks.js\":\"649a589799b2f123\",\"/knowledge-medium/pr-preview/pr-1844/src/data/structuralEditPolicy.js\":\"079c6c339e75e1c8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/subtreeDelete.js\":\"8b364af5c3501569\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncStreamLock.js\":\"2adbfe2065999f8c\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableSqlRecognizer.js\":\"c727293ea265b4f6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/syncedTableWriteGuard.js\":\"75f8a63ac1d135ba\",\"/knowledge-medium/pr-preview/pr-1844/src/data/targets.js\":\"561d7be7e0f5929d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeColors.js\":\"0a765e2b85b28ffe\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionMetadata.js\":\"dc9f2e7972239f84\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeDefinitionRegistry.js\":\"5fa8f7bf8073098d\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeExtraction.js\":\"a6f632fd6965c760\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeInitialValues.js\":\"4c9059e8a818bb83\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typePropertyGroups.js\":\"26decbae38631d11\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeSeeds.js\":\"2722e9495c39b6a1\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typeTagger.js\":\"335954450032c816\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typedRecords.js\":\"e7a47e892b0627f2\",\"/knowledge-medium/pr-preview/pr-1844/src/data/typesPage.js\":\"016de6a8eef9e2e6\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userPrefs.js\":\"8c14ec679b367d47\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userSchemasService.js\":\"422f6026b8ce18bb\",\"/knowledge-medium/pr-preview/pr-1844/src/data/userTypesService.js\":\"a7091c62e14a16aa\",\"/knowledge-medium/pr-preview/pr-1844/src/data/valuePresetRegistry.js\":\"b4b834f7bc770707\",\"/knowledge-medium/pr-preview/pr-1844/src/data/visibleChildren.js\":\"6d484d38ee40fe0e\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceConversion.js\":\"b1642bdb1f5f8459\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceFirstSync.js\":\"9af0a65578bf9120\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceIdNamespace.js\":\"9d81610e5f730054\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaceSchema.js\":\"2c1ca3bcbc0cf9ac\",\"/knowledge-medium/pr-preview/pr-1844/src/data/workspaces.js\":\"6085701bca4a5fd8\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadLog.js\":\"c89b2986e41d6e81\",\"/knowledge-medium/pr-preview/pr-1844/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/BlockPasteShellDecorator.js\":\"223d93d0d1dbe94b\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/atTrigger.js\":\"8473ab21001674eb\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/autocomplete.js\":\"cdceb6d70d9997de\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/codeMirrorExtensions.js\":\"3b5863a06a60b402\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/contentFlush.js\":\"8dfa8793e7427231\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/defaultInteractions.js\":\"a60cb3c53e5af5cc\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/editSettleSignal.js\":\"4a9d0428bbedce1f\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/insertImage.js\":\"3fcf10c437c592cb\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceCompletionRange.js\":\"a1e0131adf9ace0c\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/referenceTargetTypes.js\":\"fd3d2055357afdf3\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/syntaxContext.js\":\"7804fafdd259496c\",\"/knowledge-medium/pr-preview/pr-1844/src/editor/triggerMatch.js\":\"f509a1dd57a862b0\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/AppRuntimeProvider.js\":\"30dacc1bf02caca0\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/BlockFocusShellDecorator.js\":\"e3e2e7af5b7f827a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/ExtensionRenderBoundary.js\":\"2f012975d22d8052\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/PanelContentRecovery.js\":\"81bb972ed905e27c\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/apiCatalog.js\":\"8df42f067fb16c69\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/approveExtensionHere.js\":\"e54420839fed600f\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/armedCutAppMount.js\":\"2c38fe91d90d70fc\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/batchableKeyedStore.js\":\"4d4c645598b15619\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockInteraction.js\":\"fb54aa27959ae8d3\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/blockSelectionAction.js\":\"db33d6b7a18ffa83\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compileExtensionModule.js\":\"6e31ec256601f626\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/compiledModuleCache.js\":\"d73267ef82a271b4\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/continuousGestures.js\":\"a8205e52c8e19298\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/core.js\":\"75d00d7ffd30d924\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/defaultRenderers.js\":\"183299a5c8c01c1e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/definitionFanoutAppMount.js\":\"257f2e61e4bb7f74\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dialogAppMount.js\":\"82897bc46881d058\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensionSeeds.js\":\"aa8cac309dfaaf4a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/dynamicExtensions.js\":\"53962b9eabceea73\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/exampleExtensions.js\":\"27d943fa8b96dd14\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionApprovalStatus.js\":\"d16b83776b9be3ab\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrorToast.js\":\"1d1510c793978f41\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLoadErrors.js\":\"0212a084626ca3b6\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionLookup.js\":\"a8cbee34a1ed68e0\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionToggles.js\":\"fcba0fd4aac0b5d8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/extensionUtilitiesCss.js\":\"d96431e867c31638\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/kernelPageDeletionGuard.js\":\"a69d78517d4ecc3a\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/liveRuntime.js\":\"fc106293abfb6c4e\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/openExtensionsSettings.js\":\"a74db478447be001\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/overridesCache.js\":\"efc0758bbdfbb684\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/pluginIds.js\":\"36b2f7b77e86c439\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/processorRejectionToast.js\":\"0e5dbf73a673b8f8\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeActions.js\":\"23746ff948a9fd72\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/runtimeContext.js\":\"12ee0022a75a3c5d\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticAppExtensions.js\":\"17e1fbeb564a915c\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/staticDataExtensions.js\":\"f1a6e53ce64c2435\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/toastAppMount.js\":\"b04dd49db424b0df\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useOverrides.js\":\"53360897f58e89d6\",\"/knowledge-medium/pr-preview/pr-1844/src/extensions/useShortcutSurfaceActivations.js\":\"c10dc0cecb8d522d\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/discoverToggleTree.js\":\"e69fb38c2a93db7c\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/facet.js\":\"74dcbe0bcf497884\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/resolveAppRuntime.js\":\"1d6e94ee75bb8d4d\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/runtimeEvents.js\":\"795048552b603d24\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/togglable.js\":\"ca05ece420208147\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/variantFacet.js\":\"970cb408602ff4a2\",\"/knowledge-medium/pr-preview/pr-1844/src/facets/verbFacet.js\":\"15d67f2d64c9fbe0\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/block.js\":\"b7515fa0ad3bdc7b\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/focusedChild.js\":\"3b0eeb0a9a2194f7\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/propertySchemas.js\":\"e9e6965228f4c75b\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/typeRegistry.js\":\"5858a3faa7e4f521\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAncestorCrumbs.js\":\"c1a96aa5bb1abbf0\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useAutocompleteListbox.js\":\"9176d5aba4a5a60e\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedSearch.js\":\"08fc6997c2875852\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useDebouncedValue.js\":\"04a935ba8671a52f\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsFocalRender.js\":\"38d33bfce384826b\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useIsReadOnly.js\":\"95a6f38eec86206e\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMaterializeBacklog.js\":\"01240446731745a6\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useMinuteClock.js\":\"2ae430294fd6a2bc\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePanelLayoutProjection.js\":\"db8e50cefab56f61\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/usePendingInvitations.js\":\"ec86aec6b9f81708\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRendererRegistry.js\":\"e118854dd8d194f8\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useRetainedFieldRows.js\":\"7462f68d947591c9\",\"/knowledge-medium/pr-preview/pr-1844/src/hooks/useWorkspaces.js\":\"0db968c3142adb5d\",\"/knowledge-medium/pr-preview/pr-1844/src/lib/utils.js\":\"275314c00b7f7cc8\",\"/knowledge-medium/pr-preview/pr-1844/src/main.js\":\"b8c0ceadcc59c43d\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/MarkdownImage.js\":\"40129b004ea26e3c\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/blockSeparators.js\":\"2b30c6facac155ce\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/context.js\":\"f563505b2a4dc610\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/defaultMarkdownExtension.js\":\"66a59fffb67576f0\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/extensions.js\":\"90f94982bd9812a8\",\"/knowledge-medium/pr-preview/pr-1844/src/markdown/renderMarkdownHtml.js\":\"acd6b8fea825dd86\",\"/knowledge-medium/pr-preview/pr-1844/src/minimal-editor.js\":\"2338ed512e1dffa8\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/armedCut.js\":\"6080948c94402026\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/captureMediaVerb.js\":\"2c00b982a8715994\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/clipboard.js\":\"9898244f18133dec\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/decision.js\":\"d89bc4507227bdfc\",\"/knowledge-medium/pr-preview/pr-1844/src/paste/operations.js\":\"44bb09af00e6422d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/AccountHeaderItem.js\":\"e47ab300ddcb519e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/account-header/index.js\":\"cdc2d1d234c8ba62\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9deeaa303c496696\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askAgent.js\":\"788b44737e7062d6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/askedStore.js\":\"0bd961f370a8c0be\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d99940d4051957e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/chipState.js\":\"9bf8bbde13b86a68\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/dataExtension.js\":\"178c8d0459ccb18b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/index.js\":\"5540fc2e4478e95b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"37282be45627d1d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-dispatch-companion/schema.js\":\"ca079a0d6d4b9d49\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3b3a0d167f9327a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8a3eeac5d40b844f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/addMedia.js\":\"c39c78793f39695b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6d04e5bce7d30b36\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/block.js\":\"789806ebe3c63929\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/context.js\":\"f5573e99e91d4e53\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d9397335004a5187\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/index.js\":\"da1d234ff8cd3ae2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/outline.js\":\"1b4bae3f619a0cb0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/properties.js\":\"dc00f792e38fb182\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/refs.js\":\"52f57d58ae7029bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"90348cf1d2a35e6c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/search.js\":\"3b5a99e5bb2a23a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/shared.js\":\"7e0fed05677d4b3b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"00082dc7aa90db22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentViews/text.js\":\"c0f6ed050eaa3d1a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/agentWrites.js\":\"0d2622ac5d7db1a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/authoringCatalog.js\":\"2e744363c4af942f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/blockRefTargets.js\":\"115849e1aecd90ae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridge.js\":\"5766c1f5fa16714a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/bridgeLoop.js\":\"dc0fe75ab48dc250\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/changeHistory.js\":\"be0df0e3fb1c711a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commands.js\":\"df17fe355696371f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/commentsCommands.js\":\"ae787e58ab859d8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataExtension.js\":\"1640c996dddf21d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/dataModelGuide.js\":\"365faff09a6da1a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/describeRuntime.js\":\"bee71099ebc6bcee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/extensionLint.js\":\"c2c2f4adfc968913\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/grainAudit.js\":\"6b9314784a20950c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/healthCommand.js\":\"082b2ac69ff15d83\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/index.js\":\"199ab79d8f1c078e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/presetIdentity.js\":\"d14397f18c76c6db\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"adeb1c9305e5b6f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/readMedia.js\":\"a8bfb9299810331e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/schema.js\":\"d23e88010591c055\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/serialization.js\":\"6fc37f52d6c6002d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/targets.js\":\"301021e5ffba89bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/tokens.js\":\"ecdedbde5d920b92\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/watchEvents.js\":\"b498055ed38cfa05\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/workspaceGuard.js\":\"cc97c827c6012644\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/agent-runtime/writeCommands.js\":\"451c75db7a75431a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/AliasCollisionToast.js\":\"be20525c53ca8247\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/DuplicateNameBanner.js\":\"d05accc97db2df9b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/collisionMerge.js\":\"fe9ad1b54af35c8f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/dataExtension.js\":\"1317e8307a879e66\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/index.js\":\"e499c13faaed477b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/mergeCollisionAction.js\":\"c0c1955bb244a12e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/pageStyling.js\":\"10a9a20dce9df4a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/rejectionToast.js\":\"f0fc8ee2d7f1dcf4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/alias/syncProcessor.js\":\"4bd074a67dec6516\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/actions.js\":\"5ee7e921bb456a9a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/addComment.js\":\"46ce1d41d85ab40e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchor.js\":\"7080776694f77ce8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/anchorState.js\":\"5ac0899208ec716b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/commentLinks.js\":\"c1d4e047e2db1bbd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/confirmThreadDeletion.js\":\"169903394d3ad490\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/container.js\":\"397f45a93cc81693\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/dataExtension.js\":\"3517a16787b33829\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/deleteComment.js\":\"4252846965ceb3ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/highlights.js\":\"aa2d14b0db2d5ec8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/index.js\":\"97b4ce514877eb14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/linkedCommentsPill.js\":\"2f58f8d8772487ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/margin.js\":\"22272768f5526816\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/marginSchema.js\":\"e54ed0171c1149ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/newComment.js\":\"8c0f2d66ec8ecba1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ownThreadPicker.js\":\"7a35008677fa4b92\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/placement.js\":\"955f84213edf2061\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/queries.js\":\"c87719a34b1daad9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotePosition.js\":\"69d6d748ae6e8887\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedIn.js\":\"b09d9d3c5e09ef22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/quotedRange.js\":\"8080317d8d64745f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/rangeRefs.js\":\"f6eaaa38ddbacd88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readHighlights.js\":\"645a455391bc66ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelection.js\":\"061e00f3dafc3291\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/readSelectionUi.js\":\"866d780a148d35a5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/reanchor.js\":\"77e543d2d39e8f93\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/schema.js\":\"2d812c55f2b7fb33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scope.js\":\"5abeb596b8b6e504\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/scopeThreads.js\":\"fc34f2f0016ac35b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/splitRetarget.js\":\"09fbb730ebcbed94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestionCard.js\":\"280dc7bab99661af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/suggestions.js\":\"20975aa453f3e62e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaries.js\":\"db2b77215fca8712\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/summaryBatch.js\":\"9227099d0af781b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/surface.js\":\"a08f9cfc999e21ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threadNavigation.js\":\"dcd0b8dead7ed05d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/threads.js\":\"173fa26748bd4cf7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/ui.js\":\"0be6c5e8a09afc85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/annotations/uiStore.js\":\"eda157f0f69dae4a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/appIntents.js\":\"9b99cbd8ddaa04d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-intents/index.js\":\"c097e752b8142200\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/index.js\":\"9b63fe5325020e42\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/app-update-prompt/status.js\":\"438f95df97a85010\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c5b9c4e297fb739c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaBlockRenderer.js\":\"21a0afb81024caed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7fd431323b62df19\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/MediaUploadReconciler.js\":\"02a5cf1f3919bb01\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetDownLane.js\":\"07563292acf2c3aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetResolver.js\":\"8e7c56e851310dc2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/assetUpload.js\":\"17c510dbf77e6af4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/attachmentCleanerIO.js\":\"ae5d1a83c7b15c53\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d9c1925d268dd4fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/blobStore.js\":\"22710cdff16eb006\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/byteStore.js\":\"8a373b5de3c47a33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanerIO.js\":\"7aba5f297cab4b81\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/cleanupAttachments.js\":\"b80a59001f1b82e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/dataExtension.js\":\"032ded60659b1925\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/downLane.js\":\"e4e9070be00d8320\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/index.js\":\"c998db2db1bab4fb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/insertImageContribution.js\":\"40a513f19b4d7f52\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneArming.js\":\"8c37ab8453c27810\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/laneLock.js\":\"aff74407de45628c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaBlock.js\":\"23a5afb345302427\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaCapture.js\":\"ec391bd29d4d8f0f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewers.js\":\"3cdfb4eab14e607b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/mediaViewersFacet.js\":\"d0163a05db4bc72d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/pasteCapture.js\":\"74aba1b9a3395ca8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/resolver.js\":\"422921dd0289fe20\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/retryUploadsAction.js\":\"a33bc63092be92f7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/storagePaths.js\":\"4b1d6381634b91af\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadDrain.js\":\"647e04d2272b984b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadLaneStatus.js\":\"ce71dfa165193f23\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadReconcile.js\":\"f1886cdc38f7cbcc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadRecovery.js\":\"787946d16e8c7674\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/uploadStore.js\":\"8d1968479fec33b0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/attachments/useAssetObjectUrl.js\":\"5b6ad62ec114d7a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"fdf825a34010ad18\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3ff27941a80f68c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/facet.js\":\"fc276f2bbbba8534\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/index.js\":\"a2a670e19b98ab21\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks-view/prop.js\":\"3805a6b336d90aa5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinkFilters.js\":\"99625609a0b3cd30\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7030a59a574cf3a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/BlockEntry.js\":\"153ad4bd0b6e8a56\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/LinkedReferences.js\":\"88616e3409ee2896\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c10f716ab50e854f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dailyNoteDefaults.js\":\"de12f151a168c993\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/dataExtension.js\":\"d6112679642c2e6a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/edgeExclusions.js\":\"ea9fb32d8da4a6a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/filterProperty.js\":\"b7f3ac9d8beed01c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/index.js\":\"89afd5f0f3517167\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0ec21128a3a87dbe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/applies.js\":\"fa651b16cbc8409f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/countQuery.js\":\"7655821edb165776\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9e05cd68f2ffa82d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/index.js\":\"ddb0b384b18a24d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1b000deb1ab98a43\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/presentationInvalidation.js\":\"7424eec220980ada\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyEditorOverride.js\":\"afaa846429ac1552\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/propertyFilter.js\":\"515fc670dd4b0a9f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/query.js\":\"31f58f0687cf73b6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/resolveFilter.js\":\"182dddbc39f08f51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sourceBatch.js\":\"89cabe1c43e92693\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/sources.js\":\"df82fec7e0b4553a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useBacklinks.js\":\"34aae37222cce3ae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d19b7df157151d62\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayCelebration.js\":\"309768486362d39c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/BirthdayOverlay.js\":\"11747568dc54aeba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/gate.js\":\"a24dce74ce9fa6bb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/index.js\":\"c15dc5b0f9a3f9a2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/birthday/wolfTheme.js\":\"603557f205c3bd44\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/BlockDragLayer.js\":\"890738b2d0573293\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dragController.js\":\"70ff7d49c3f7973d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/dropTarget.js\":\"a4729eaae5ad2f6f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/index.js\":\"3a6a36c44e5581e7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-drag/projection.js\":\"1a727c88fbbce6cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/BlockMetaCard.js\":\"420415353f0f0471\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-info/index.js\":\"3ea2ac7ecf3ee0d6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/AddTagDialog.js\":\"2878456ca315030e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1c3a8bdac149b1ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/TagNameIssueHint.js\":\"498cd8f364576401\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/addTagAction.js\":\"8ca7ae801c1a574a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/appendTag.js\":\"23273e67b9d61a73\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/config.js\":\"7f59f645b5f8616a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/dataExtension.js\":\"ec9802ed845bc0f9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/index.js\":\"6fba51837a50dca6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/block-tagging/propertyEditorOverride.js\":\"a86ae77fb15061c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f88bdd87dae2dc85\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1990bbf92a9a5698\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/Breadcrumbs.js\":\"359bebbe167e0e71\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"36ecec85495907e7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f3d9eb097c26997f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/index.js\":\"71c2a5f2eed20db2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7f72595a5c4091bf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/CharacterCountItem.js\":\"ce28b998750a7165\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/ProfilePropertyEditor.js\":\"24996b68c479a90a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/actions.js\":\"f95a927792ca81ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/blockType.js\":\"dd9429c5fab5cbfa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/charCount.js\":\"a7f1f3ca386eeacc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/dataExtension.js\":\"c7419ef332758724\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/index.js\":\"ae20f7e3541694f0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/profiles.js\":\"c75c0844603d0584\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/properties.js\":\"6c30a91e593a0bc6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/character-counter/textCounts.js\":\"f56e911ead2be0f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/colemak-keybindings/index.js\":\"bc926005e0b85244\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/CommandPalette.js\":\"115507ed7b66ed29\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/HeaderItem.js\":\"32336d6cad7ed439\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/context.js\":\"eee97e60064aaf82\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/index.js\":\"4d4c28e120e32efd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/selection.js\":\"0a98038dc397a052\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/toggleStore.js\":\"4e5e68db58b99354\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/command-palette/useCommandPaletteActions.js\":\"83c530089f2515b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/ContributorBadges.js\":\"123930f9bf03c9df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/author.js\":\"085e0696fed5b509\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/codeMirrorExtensions.js\":\"a143fe8de0db84a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/dataExtension.js\":\"a3a05e587456d838\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/index.js\":\"cf072db2977e22a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/mentionAutocomplete.js\":\"dce14d0827ac5035\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/processor.js\":\"1324d3f6a6e0f52d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/profiles.js\":\"b47e2eaca193ad90\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/queries.js\":\"20332240f7bb8e5b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/contributors/schema.js\":\"fb49e0c0dc81414e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"0890a0db3956549e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/followOrigin.js\":\"08786bf2ec5b7191\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/index.js\":\"ac88db1141f5e82d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"85983a75d5140bc2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7dc5ae3f600ca763\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/CalendarGrid.js\":\"8e55de3c4353af27\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DailyNotePicker.js\":\"01a26f4500dc9457\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"195106da855fbbde\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateNavDecorator.js\":\"d62402dcf2b7a606\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/DateScrubOverlay.js\":\"df1223dbd874a643\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/HeaderItem.js\":\"c65f05fa8f04b32a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/ReschedulePicker.js\":\"77eddf82b694e463\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2de12e351cbe8083\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/actions.js\":\"75171f4ae9586691\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/blockDateAdapter.js\":\"1aba93b5576c0158\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/calendar.js\":\"f3b2b8fd1283c678\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dailyNotes.js\":\"903be5a26df9a336\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dataExtension.js\":\"24e78ec878e4e298\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubActions.js\":\"a1fe8cbfa18045a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGesture.js\":\"558105adb34dfd58\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubGestureActions.js\":\"920e7c7fc66e67bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3945f792c7cc31e8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/deletionGuard.js\":\"492eaa5e80caa7bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/dueQuery.js\":\"56d20b87d36ba1e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/index.js\":\"2eee6494b8c8a256\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/landing.js\":\"d11530793723ef58\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/localSchema.js\":\"5cb34f1d5f8d580b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/referenceDateAdapter.js\":\"ecc6af4d7ec84fc6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/rescheduleAction.js\":\"fbe47b043b744ea1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/schema.js\":\"3913a49c4c670428\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadBlockDates.js\":\"35f5cfacc79afe94\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/spreadDatesAction.js\":\"8abcee85528b4cfe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/today.js\":\"5554015c2974d4c0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bc53e57a93b4a7d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6aed5f76911b993d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/audit.js\":\"2f4f592c921e784c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditAction.js\":\"5c2fb3d5f817ece4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/auditRanges.js\":\"076e34cf24e12d48\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/diagnosticsSource.js\":\"f4de700fdc28adf2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/divergenceScan.js\":\"61ac96eeefefda63\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/index.js\":\"a8d009be457427ed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3f1bdc527a514b0d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/referencesMirror.js\":\"5dbab1d9feebe5f9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/rowJson.js\":\"85aa14c4266e391f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/schedule.js\":\"e0ae4c29784a6e28\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/data-integrity/store.js\":\"f6641d26f46b099c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/action.js\":\"f4ec2b754664d793\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/index.js\":\"d9f228cbb08180ae\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-maintenance/plugin.js\":\"8997c05ce4865267\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"fa668375ae11eb66\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/actions.js\":\"5086a7cd4c838a4e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/changeMarker.js\":\"d8640685d6136bb3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/diagnostics.js\":\"48682b4c9b40b1b2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/fileSystemAccess.js\":\"e29b1600e690df1c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/filenames.js\":\"4a2c05d110687f66\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/index.js\":\"5f43938589cf334c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/mirror.js\":\"f5b4b22f9fe3d393\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runLock.js\":\"ef1550c77cdce8d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/runtimeHealth.js\":\"1d17e11cc016da11\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/schedule.js\":\"140f14660b557951\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/db-mirror/store.js\":\"364987765aaa8c39\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/index.js\":\"bfbad6cfd59fd845\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/default-themes/themes.js\":\"8ba7fd7d96d0cd09\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/facet.js\":\"550a895782c24e57\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/diagnostics/useDiagnostics.js\":\"b2f7d219bca83456\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/dismissals.js\":\"ac04ab6d5bc14b29\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/index.js\":\"0c22d672342d2936\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/status.js\":\"f1ed65e9d8bc8aaf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extension-prompts/store.js\":\"0e3f0b3a19181f5f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a76103851312c139\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/ExtensionsSettings.js\":\"cceae54d5d18d1d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/actions.js\":\"4e2d82900b351678\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/config.js\":\"ccc2c5ed4804c86f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/dataExtension.js\":\"0c0f77bfef000b33\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/effect.js\":\"9a1c29de41316372\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/index.js\":\"13c425b1a9671f4b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7b5574f6b8ab082b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extensions-settings/useToggleTree.js\":\"defdbfc36dad271d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/ExtractTypeDialog.js\":\"bf73f60a9c968550\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"617e30e1ee66de17\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/PropertyShapePicker.js\":\"8a55dcff8d949535\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/action.js\":\"94b71bda21e8049f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/extract-type/index.js\":\"127140b542cd7491\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/FindReplaceDialog.js\":\"71f88f812b148b82\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/HeaderItem.js\":\"fc3750337d20b5d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/dataExtension.js\":\"7de5a3b4e0e32a7c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/index.js\":\"76abecf0222e7ecb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/search.js\":\"ec89e17ebafb558d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/toggleStore.js\":\"4a83d6afc1ddff77\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/LocationPropertyEditor.js\":\"395d5f853c9b81b1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/MapView.js\":\"bdac636eeb8261a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/blockTypes.js\":\"7e4e509068d64acb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/codeMirrorExtensions.js\":\"a167f9d2bfd82148\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/createOrFindPlace.js\":\"a73038ef36585ca9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/currentLocation.js\":\"c5e60adfe6d1b0a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/dataExtension.js\":\"2434465c09a53980\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/geoContentDecorator.js\":\"7663155bbc68f28b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/googlePlacesClient.js\":\"5cfbac6abc8ce667\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/index.js\":\"14ac2bf861a4d489\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/locationsPage.js\":\"13516da2f6bc6765\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/mapViewport.js\":\"68507346931c905b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/pickCurrentLocation.js\":\"e95a6c0d5586afca\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeAutocomplete.js\":\"930235dfa0184cbe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/placeNameCollision.js\":\"f72469f56ee536be\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/properties.js\":\"70ea186db9a5bcf2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/propertyEditorOverrides.js\":\"73bb633d3340d1a4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/query.js\":\"8a30a57a54e6b0e0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/geo/usePlaceSearch.js\":\"8a244e61a0757556\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"48a17153186664c3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"f98cff3be28d6f4b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"027e38098b7e9ad7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/config.js\":\"f99b73e02c9d8e16\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/dataExtension.js\":\"1f33c5346559eb4b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/facet.js\":\"87a28ebe6d61630f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/grouping.js\":\"a92e49ff2ecba20f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/index.js\":\"f021fd0927bad3f7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2199ec554165ca1d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/query.js\":\"638e35f6e0af2cf5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/resolveConfig.js\":\"7f1e1b065043168c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"90cb2554938a089f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b568aaf95aa9c898\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlDocumentContent.js\":\"5ce726e9c2272e8e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/HtmlFrame.js\":\"d82908715763c534\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/actions.js\":\"cb810bce3ed1b0ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/blockType.js\":\"b45eaa3b0a43ece7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/confirmRunScripts.js\":\"f85cc4b1d213c12e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/dataExtension.js\":\"b2cc449a78d814cb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameAnnotations.js\":\"e0801e3a17e406ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameDocument.js\":\"bde4e189af00e7cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/frameTheme.js\":\"953dbc80baf2d79f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/index.js\":\"46d830e256d37a58\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/scriptConsent.js\":\"e88e9fab0a0f3ca1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/sourceMap.js\":\"da4ec94c2fec75f4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/html-document/useDocumentScripts.js\":\"f88bc01d396b1a76\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/index.js\":\"d999dfe556f25fea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/record.js\":\"28f5ea9995613145\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/recordStore.js\":\"6794e0e8044665b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/responsiveness.js\":\"80d79f8938a3c433\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/schedule.js\":\"19a1f19338f35f7d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/interaction-metrics/sessionContext.js\":\"e585baac0d476390\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"86dcbb0c68118e81\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f1fa2647962d76a6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/actions.js\":\"4bde5a574c0fe0ac\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/config.js\":\"fb489209ede4e6a8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/dataExtension.js\":\"d90628b203d97993\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/effect.js\":\"9c5a82d574cf38c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/index.js\":\"bed6b34c5e03bb58\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/keyCapture.js\":\"60769e8d373c1b51\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/overrideStore.js\":\"61595b06999c500d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e58a5bb479d176f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/HeaderItem.js\":\"ab83b7caca12e7f3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/LeftSidebar.js\":\"583087ad8724b1ad\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/actions.js\":\"5b9fb13ef29553b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/facet.js\":\"e7ba9cfebf28879b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/index.js\":\"fca6acf0704a8d2b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/shortcuts.js\":\"d9119e8b1c474808\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/left-sidebar/toggleStore.js\":\"cae214ff29b3f41c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/MergePicker.js\":\"51e9ef5b9f03f7ba\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/index.js\":\"b1b210a2b6c4885d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/mergeAction.js\":\"b1cab50e6e1e90b9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/merge-blocks/strategy.js\":\"40df917a894d64ed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/Button.js\":\"1de616dd56c77092\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ea7706ca762e9818\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e3c25000f3c4571f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/facet.js\":\"1ced462fc8dcaab1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-bottom-nav/index.js\":\"54c7afb3e66a2a2d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6ae4b3b03dbe9128\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/actions.js\":\"06532139e88c0578\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ce9d011ac5d3973b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2d0fa38ca0b0f2df\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/mobile-keyboard-toolbar/index.js\":\"b9e6de69765dd06e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e1438ac82d8a8ef2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a18a5ad1a5d74037\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/contextMenuItem.js\":\"d02ca090063b1d98\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/index.js\":\"113492af2774e052\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveAction.js\":\"af124f3e24d9a5e5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/moveBlocks.js\":\"dd2478ceb0ca04d1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/move-blocks/selectionAfterMove.js\":\"95ab1276ceefec4e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/TutorialBanner.js\":\"13199cb07eb1e674\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/action.js\":\"e0dbf7dba9376888\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/bannerDismissal.js\":\"cc519ad7980e9bcb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/documents/cheatSheet.js\":\"3da191a3f904310c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/index.js\":\"534265ebf49c0184\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/keys.js\":\"2da3eb97ec62413a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/landing.js\":\"efde6bcf311faaf9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/outline.js\":\"774d8300606a614d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/onboarding/seed.js\":\"6a6095b9a1e434a9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1f92efc40d08a734\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/analyze.js\":\"15298ac238d546ff\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/diagnosticsSource.js\":\"08125dae628cdf63\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/index.js\":\"95817e1a5c93d6e3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/load.js\":\"11fa16443c418dec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/monitorRun.js\":\"f40340b98b75b807\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/schedule.js\":\"3bfdf13da41f4d3e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/series.js\":\"c0fd95da296ae75d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/store.js\":\"73d1258d8ee2b1f1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/trendAction.js\":\"6d71f640886a55dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/perf-monitor/verdict.js\":\"4519d43fe291618c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/clickToEditAction.js\":\"0f50f806f8c10f87\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/index.js\":\"5d77ca831263f2de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/plain-outliner/interactions.js\":\"045f92ef13b698dd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5303ee8f1c415d2a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGate.js\":\"c7ebbf97a7b07ce3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/MigrationGateDialog.js\":\"5a47e9c40f51dd08\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/action.js\":\"56fd61cc4be66ce6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/index.js\":\"1505f16f9115c614\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/localRunMessage.js\":\"5ba6d3db0f324b99\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/plugin.js\":\"d390f6f6592166eb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/progressReport.js\":\"3f5a4f9d6278f47a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/properties-migration/sweepProgress.js\":\"702ef1e67db9788c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/FieldRowRenderer.js\":\"0af61ad323deb372\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/ValueRowRenderer.js\":\"2aec4b5f8b3694e3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/actions.js\":\"501681eb14c3effd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/autocomplete.js\":\"6dfe2974f1c77bf6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/fieldRow.js\":\"6751e3eaffc1f299\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/index.js\":\"1bf7f42ca608a3f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/referenceWarning.js\":\"6f3b9fd438582c6a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueAutocomplete.js\":\"0ea4d98169e0ed36\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/property-rows/valueSchema.js\":\"359aaa18d473d5a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/HeaderItem.js\":\"bc210caa829c75c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/QuickFind.js\":\"f21f57f7f89640de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/index.js\":\"6ca249c598be47aa\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/recents.js\":\"79e52e1f12980b4e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/resultItems.js\":\"d0570b44aa3748ea\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/selection.js\":\"43891c43c50cef8a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/quick-find/toggleStore.js\":\"22470b33bc1c050c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/HeaderItem.js\":\"b256e3e85d22a590\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/RecentsPageBlockRenderer.js\":\"fb4abed021a80684\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/grouping.js\":\"a222ce3ced0e112c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/index.js\":\"2fa91ad859a12684\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/recents/target.js\":\"b6da33844c2eeb63\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/codeMirrorExtensions.js\":\"25086c345405f810\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/contentPrefill.js\":\"ec76044a8c4e37cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/dataExtension.js\":\"43675557556e93d7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/index.js\":\"0f450c6d83ddaaee\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8a0c421fb1182191\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/invalidation.js\":\"1c60b944cdbd9139\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/localSchema.js\":\"2f808a3e7d069a3f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/index.js\":\"9c3924b45dbdc853\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"46c48baf5096704d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/index.js\":\"871e54ccb20d32f3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/referenceNode.js\":\"c1211425ba19ba37\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fec3afb2db572fc3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5161bcecb1e38ce8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/index.js\":\"b30a57530e8f57c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"80228e3ce7151a99\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"39d569208db4ce54\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/mergeRetargetProcessor.js\":\"64839135866604eb\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/parseFence.js\":\"f41eaca8f2269daf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceParser.js\":\"1c2bf87e7b0f44fc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referenceProjection.js\":\"51b97c53b32ff0a3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/referencesProcessor.js\":\"341af463b7d871d4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/renameProcessor.js\":\"5e9e14594c8a97cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/references/spanReplacement.js\":\"81b237a8b026b09b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/htmlToOutline.js\":\"c20c9111fbb02578\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/index.js\":\"dde833f363a4b400\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3d18f433ba0eb3bd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/rich-paste/pasteDecision.js\":\"e22c216998f53c70\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/action.js\":\"3bd1aede57c3e5c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/blockIds.js\":\"6e37cf946a0d45ec\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/content.js\":\"444df4b01edb99d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/effect.js\":\"05574ac3b2161ac6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/ids.js\":\"8b5bf858034cb03d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/import.js\":\"bcff15e0fc9cc585\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/index.js\":\"1ebb6ffc8678365d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plan.js\":\"f81c194f3bd39c4f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/plugin.js\":\"c41f317bfc1cf67c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/promotion.js\":\"81bfa4c0b0c7120f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/properties.js\":\"392b8269858b5d2f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/references.js\":\"e8dee57af459675f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/report.js\":\"639d5ccab5937684\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/roamMemo.js\":\"6aace38cc65db14b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/runtime.js\":\"5f12b39421c5f592\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/schemaReconciliation.js\":\"66f34db9260679f3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/srsMarkers.js\":\"2e1b21da1d8f9648\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/todo.js\":\"360bc44831ca89fe\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/typeCandidates.js\":\"d3d0b0e6f3e07827\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/roam-import/types.js\":\"c850e7a6529ecfe0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/index.js\":\"250ae150613727de\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/search-health/store.js\":\"aeff1a973314ddf4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/HeaderItem.js\":\"fd134a5cc26c5c26\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"cff169a1dea29b88\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/index.js\":\"dfa85cfcd3a8c3d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/model.js\":\"3220e5af86b70538\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/toggleStore.js\":\"b141d962f41170e1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/shortcut-help/useKeyInspector.js\":\"309faed76368adda\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f054e266a7ea6b06\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/ShellDecorator.js\":\"44031392ab12ca60\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/actions.js\":\"b85d14524ee69eed\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/exclusionsFacet.js\":\"356d625d2698a14a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/index.js\":\"a343ea103c995a8c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/shell.js\":\"7a385a8b78719199\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/surface.js\":\"349772c8068c2514\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/spatial-navigation/walker.js\":\"e55d4c98a384f2c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d0d39ca97f3ae37e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/dataExtension.js\":\"e51bc87465f52ef6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/index.js\":\"75a9706e93020dd9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/indicator.js\":\"a600033125cfa3c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/moveSrsState.js\":\"aca108680b6f3c04\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bf80db2e2f4c93cc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/scheduler.js\":\"fab8256cca644b4d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/schema.js\":\"2b2ddfeffbb4277f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2bc2ad54f8206cc8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/srsClipboard.js\":\"dc29b9b278e063c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c7390f32b55edfa3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DailyNoteReviewHint.js\":\"8ed5a1ca54f4dcfc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/DeckPicker.js\":\"bde70b8215f2283d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewControls.js\":\"448fcf6b636c226e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9af886e1aa589191\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/ReviewSession.js\":\"e6287cd5a46fa897\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/actions.js\":\"682e2bad4d9360e2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/archive.js\":\"f3963363a7f88fd3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dataExtension.js\":\"8b709b0bf3e6e9f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/deck.js\":\"7d7b434a3d1cea9d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/dueQuery.js\":\"c79c16d1bbb7bed3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/gradeDecision.js\":\"23badfe549d2a725\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/index.js\":\"66d54bd9e7e1f4c4\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/keyHints.js\":\"1098d73d322d09bc\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewCardLayout.js\":\"e529c62561d7f6c2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/reviewProgress.js\":\"df163209b2d1ae38\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/schema.js\":\"71e1845d3a591b22\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/srs-review/useDueCards.js\":\"cf9b24c851fadcf6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/index.js\":\"098f2c0022269eb1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/startup-metrics/record.js\":\"a49c473266cf57c1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/index.js\":\"0ad8ae27cf162b54\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/persistenceStatus.js\":\"41146f30ec1c66e3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/storage-persistence/requestAction.js\":\"957fb54f48401984\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/TypeChipsDecorator.js\":\"d1fb36150c3000f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/codeMirrorExtensions.js\":\"7ea3691e9761f265\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/index.js\":\"82738beac231fb57\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/supertags/typeAutocomplete.js\":\"760545bc8640d100\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"bfab47e55f7b0862\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/actions.js\":\"69541cb52a9aa728\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/anchor.js\":\"f44af13e4281f14f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/events.js\":\"73543fa5366e22f8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/gestureActions.js\":\"47e041b9a9703457\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/index.js\":\"98de2c632b03346f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b6ab3107404f30d2\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/collect.js\":\"9cbd1eac8f7bee76\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/index.js\":\"a916b70e77f89175\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/sync-metrics/record.js\":\"1d20cf2fa488517b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/RejectionDialog.js\":\"2d9fdb5d36e87a9e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4216516cb4ef6df1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/index.js\":\"831f2678acfa8daf\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/model.js\":\"04a05d0f2fe517d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/queueCounts.js\":\"a40f426a9d43fe8b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rejectedHelpers.js\":\"ff7b1ef116a5cab9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/rematerializeAction.js\":\"de4d12a8fe646673\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/system-status/useHysteresis.js\":\"6d5f8995068352c9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/ColumnHeaders.js\":\"37324355c1f90ea6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/QueryUi.js\":\"4d3f645b1f4be86e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/TableLayout.js\":\"63695152be19eef1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/actions.js\":\"3ee29a0354aa90ca\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/cellEdits.js\":\"e98d8e4d0944ab60\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/columns.js\":\"5def47fbc67d73f5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/controller.js\":\"3212dd6fda9e4198\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/convert.js\":\"357faa7ea63668c7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/dataExtension.js\":\"105ef261f6f34943\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/index.js\":\"640a2cdf41119f7f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/keys.js\":\"d8c1c3406af85f5e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/model.js\":\"b6fb196fee8a32a0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/backfill.js\":\"fd9596ab5d9befc3\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/format.js\":\"086d4032babe38c5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/parse.js\":\"5ef0da25560e403f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/queryValue.js\":\"b53a3ec9312fb045\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/query/source.js\":\"eedb74ed7e74370b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/registry.js\":\"5889df66f02766b0\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/schema.js\":\"4c7f7aa46c99e6c1\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/tables/sort.js\":\"f4c0d81a2eca7474\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/effect.js\":\"e9cbc5ff4602de7f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/index.js\":\"ab493c4fb8fbd15c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/theme-toggle/theme.js\":\"73d230e24307db48\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/actions.js\":\"fe178e7439afa82d\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/dataExtension.js\":\"e72f353563bb00ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/index.js\":\"e2f3bef0d7ad20f7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/todo/schema.js\":\"0b6aeeeb2755958f\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/TouchSelectionLayer.js\":\"6a3f6c9619d97f07\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/actions.js\":\"4a17dac09d71947e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/defaultItems.js\":\"e23a84f17300042c\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/facet.js\":\"a0c37eea24b5f2cd\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/holdRecognizer.js\":\"a08bee340287e0d8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/touch-selection/index.js\":\"5495a7666bfb12d5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/UpdateIndicator.js\":\"69f92b655c4e30ef\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/index.js\":\"409703bfb500ba6a\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/update-indicator/loadTimes.js\":\"4f6776e4a6929536\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoNotesRenderer.js\":\"9fa1118a3b094900\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoPlayerRenderer.js\":\"6a89c7790622cea9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/VideoTimeStamp.js\":\"280152cb54fd8190\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/actions.js\":\"42c137496f02024b\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/index.js\":\"1cde0fa8419acc08\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/markdown.js\":\"7ccb4af53c1487d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/notes.js\":\"2ca9c0594e1c4738\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/registry.js\":\"6f35be03efa11c15\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/remark-timestamps.js\":\"4d245a020b81ef7e\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/video-player/view.js\":\"bb91bc3e73a496b7\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/LinkHints.js\":\"88697c0d37bee637\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/index.js\":\"c14042289a30bc11\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/model.js\":\"ec280b7b87c5f7b8\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-link-hints/settings.js\":\"ee284e7c996d9cc5\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/actions.js\":\"3cda8afe899854d9\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/index.js\":\"aac2f4e0cb21e7c6\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/vim-normal-mode/interactions.js\":\"1cefea937757e395\",\"/knowledge-medium/pr-preview/pr-1844/src/plugins/workspace-header/index.js\":\"fe2e9089f4357414\",\"/knowledge-medium/pr-preview/pr-1844/src/registerServiceWorker.js\":\"795ef0e4c1becd3f\",\"/knowledge-medium/pr-preview/pr-1844/src/requestPersistentStorage.js\":\"c0af417919dd4d39\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authRequestDeadline.js\":\"7045f09afb946fa3\",\"/knowledge-medium/pr-preview/pr-1844/src/services/authStorage.js\":\"eb7a3bdf0387bc29\",\"/knowledge-medium/pr-preview/pr-1844/src/services/powersync.js\":\"9cf2cd2941e87d25\",\"/knowledge-medium/pr-preview/pr-1844/src/services/supabase.js\":\"15a840b8a71c42c8\",\"/knowledge-medium/pr-preview/pr-1844/src/services/uploadErrorClassifier.js\":\"1312b09e2f417fbd\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/ActiveContexts.js\":\"0788836ae7d36f0f\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/HotkeyReconciler.js\":\"65a43e7f3aac028d\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/WipeLocalDataDialog.js\":\"9c551eed2d0237b9\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionDispatch.js\":\"6f01a5bd16834925\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/actionRefItems.js\":\"ef0cc28858cca9b4\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/applyKeybindingOverrides.js\":\"51f60cae56ab1e4e\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/blockActions.js\":\"7042dd3006cea30e\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/canonicalizeChord.js\":\"72961a7fad0de365\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultContexts.js\":\"c00c20edc759d8f3\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/defaultShortcuts.js\":\"a93db6a13f39c1f5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/effectiveActions.js\":\"70eb6bc3208debe5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureAction.js\":\"9135b30e686702b5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/gestureBinding.js\":\"85ba0582509da8e2\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/holdRegistry.js\":\"bf288839070d53ba\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingConflicts.js\":\"55464482a5352a58\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/keybindingOverrides.js\":\"0f02fe314d9a0270\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/pointerAction.js\":\"65309d28fa9059f3\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/resolve.js\":\"ed13ed819bfd397a\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/runAction.js\":\"51d96061fda08e17\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/sequenceMatcher.js\":\"679bf0f0d95c93dc\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/types.js\":\"07b6e581fd13dbc5\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionContext.js\":\"6ab4e6910bf8c522\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/useActionDiscovery.js\":\"2f0cf5ce472e0b1e\",\"/knowledge-medium/pr-preview/pr-1844/src/shortcuts/utils.js\":\"014468bdab423e8d\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/bootStore.js\":\"3f853a0ac4d89cb4\",\"/knowledge-medium/pr-preview/pr-1844/src/sw/previewDatabases.js\":\"ddfc0ce2d42fa9f9\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/byteTransform.js\":\"7dfa77d829a9c56c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/attachmentCleaner.js\":\"c27ceb81470587de\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/attachmentParts.js\":\"e60bd40793c75953\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleParts.js\":\"1f8d0316a2321faa\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/bundleRecord.js\":\"f6f7239f18f5b517\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/manifest.js\":\"21332ec1c219b2da\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/takeBundle.js\":\"0b5dd5040b0bd817\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/bundle/verifyBundle.js\":\"3f0b510d6fcf9751\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/cleaningStage.js\":\"7244a401a27e1d01\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionKey.js\":\"793cd880a5e1ed54\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/conversionServer.js\":\"3b8492efe970694b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flip.js\":\"e976eb0ac2edd30e\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/flipAttempts.js\":\"8ac2fed35679673a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/pages.js\":\"95df34fab10f8f00\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/preflight.js\":\"113d503b0364fb23\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/reseal.js\":\"9e711fb6e5abc89c\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runConversion.js\":\"f6dc430d46c5b10d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/runLock.js\":\"464628728cd735e6\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealing.js\":\"b0b911378e1611b7\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/sealingStage.js\":\"253120a4cbdbdda0\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/stage.js\":\"e6d43fd6fd837f5d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/conversion/verifyReseal.js\":\"c10b50eb9fba335a\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aad.js\":\"c5219099f618d247\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/aead.js\":\"62e717c1463d6a23\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base32.js\":\"8f5bc05a2340d989\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/base64url.js\":\"e5cab6fc36b4309f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/binaryEnvelope.js\":\"1a25af3ceaa00da3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/byteAead.js\":\"c9708aa33e94c8c5\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/canary.js\":\"1e0ce1d30b33fc0f\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentHash.js\":\"fe0929b1959ea0f8\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/contentKey.js\":\"cd52dc52f38150ac\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/derivedIdNamespace.js\":\"6a62eb6360bcdc65\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/envelope.js\":\"d7cf65359b78156b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/hex.js\":\"f53d341ffba7ad60\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/sha256Hex.js\":\"f790984391e2fc2d\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/crypto/workspaceKey.js\":\"8a09c039d65c7cd3\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/conversionState.js\":\"60948c3272a1dc14\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4562365d22f381a4\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/pastedKey.js\":\"6297a4c03ce0cec5\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ce0ba7a512393bda\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d2441f0c5049d126\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/keyStore.js\":\"ce338f9a5a941f05\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/mintWorkspaceKey.js\":\"e87a13d1e50f5d4b\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/modePin.js\":\"ae2024b326e047d2\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/openWorkspaceKeys.js\":\"d652fa7b820e4117\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolveWorkspaceEntry.js\":\"d6af53b4aa35c334\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/resolver.js\":\"d393095c2cca5859\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/keys/workspaceAccess.js\":\"f4541d8a78e60801\",\"/knowledge-medium/pr-preview/pr-1844/src/sync/transform.js\":\"e4247cf93dfad5b1\",\"/knowledge-medium/pr-preview/pr-1844/src/themeBootDefaults.js\":\"e9becf12702f9a1b\",\"/knowledge-medium/pr-preview/pr-1844/src/types.js\":\"e018afbb86401c5a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/ClientLocalSettings.js\":\"ccdbba6ecfdcef22\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/abortableSleep.js\":\"1affacd35c1f868c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/array.js\":\"8f0e2af7f7d386e0\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/backlinkAutocomplete.js\":\"a22ded46389ffa51\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockCrumbs.js\":\"bed4c7b218450a35\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/blockrefAutocomplete.js\":\"4f1d5e8dd1e39272\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/cadencedIdleJob.js\":\"134b46113f49f37c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/callbackSet.js\":\"738b7c4431b7fa60\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/clientId.js\":\"c28dc246d5176f0c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirror.js\":\"dd1ace073aa9d79d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/codemirrorCompletion.js\":\"9736f2adc8964c3f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/copy.js\":\"a51b37cf07b3c27f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dailyPage.js\":\"17a6a9c779039bda\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensics.js\":\"5f037a4aea8dc31a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dbForensicsHooks.js\":\"71bde22bc08b253d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/deleteBlockThroughUi.js\":\"3323562b7d6743f7\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dialogs.js\":\"292a197429b79963\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/dom.js\":\"c42f9e5d91bfa478\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/downloadBlob.js\":\"bfb4980cf89b8e3e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/exportSqliteDb.js\":\"a9d1cce1ab5d5ab3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fileSystemAccess.js\":\"f5c439f2b83960d5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/flipSlide.js\":\"d3cabfae6abe9f31\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fnv1a.js\":\"32bf602acbf48d81\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/formatBytes.js\":\"a915f46ba1cb7490\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/fuzzyRank.js\":\"3fec40a9b757c943\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idbKeyedStore.js\":\"0cedf3c5cfdba981\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/idleCallbackPolyfill.js\":\"f64fd0075f496d96\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardAwareScroll.js\":\"ccac4e211f228d66\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/keyboardViewport.js\":\"a83ed2fe50427c37\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/lastWorkspace.js\":\"f0a9561ef615e17e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutColumns.js\":\"8c5cbe5c6954dd49\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionDom.js\":\"0d6d6861c3fb6547\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/layoutSessionId.js\":\"15d3de6d0daf3628\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkClickGestures.js\":\"0767972ec8ff4064\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/linkTargetAutocomplete.js\":\"0746415c11ce6a9a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbCorruption.js\":\"9507fef30f834bb8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/localDbRecovery.js\":\"084827a8389b05d5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/markdownParser.js\":\"de164103b30e1a3b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/memoize.js\":\"1847d55abcb3bcd5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameFieldCommit.js\":\"eb52088c6c2b244f\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/nameList.js\":\"b56a26561e6eb1aa\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/navigation.js\":\"bd18a77126b47af3\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/omnilinerNamespace.js\":\"2966a4fd150f103b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/opfsPageScan.js\":\"19a00b8e7ac87818\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelClearance.js\":\"e8399d17aaf0ac5d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelHistory.js\":\"bbb95d3904fcf925\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLanes.js\":\"da7d6437c2477f5b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelLayoutProjection.js\":\"0d5260f694002e35\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelScrollAnchor.js\":\"748391a06b821202\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/panelUrlFlags.js\":\"ed81986d4dd646cc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/platform.js\":\"bd059cead25c3718\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/pluralize.js\":\"be43d94d5301cd98\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyCreation.js\":\"ebe1b0336a814d2b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyNavigation.js\":\"9bd560a4f8d41594\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/propertyValueContext.js\":\"1359b529b749cea6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/react.js\":\"258f01c9e53a5d16\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeDate.js\":\"1b0cfe837bd944d9\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/relativeTime.js\":\"a8cad676c30383ce\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/renderScope.js\":\"32c05868f426c51b\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/resolvedThenable.js\":\"6401c8e5b078f0ee\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/routing.js\":\"04a4f956617f19cc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/safeMode.js\":\"c92ea238a65635c5\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/scheduleIdle.js\":\"581b2223f260f82d\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/screenWakeLock.js\":\"02d1ecbc956a48fc\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/selection.js\":\"377dfb83b942d5c8\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/softKeyboardGrab.js\":\"b81d8dcf3d8f30a1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/startupTimeline.js\":\"cd2787deff0e4754\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/state.js\":\"ff2b47ad590fd4ee\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/string.js\":\"b7b8294d5ead5b52\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/surfaceZoom.js\":\"7e9ac63a2731bf2a\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/time.js\":\"ccd0b6cef437831c\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toast.js\":\"e91c24a99d13f203\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/toggleStore.js\":\"7847938cae7ca8c1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/untilStopped.js\":\"af8852f941c5b9f1\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/userActivity.js\":\"fc740323291b3246\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewTransition.js\":\"f4044c25e236d222\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/viewport.js\":\"0eccf08022e0fc8e\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/webLock.js\":\"c8e7c420343f6016\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceRecovery.js\":\"3aa95e9664573313\",\"/knowledge-medium/pr-preview/pr-1844/src/utils/workspaceSnapshotStore.js\":\"51f551a5187e8d3c\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-compiler-runtime.js\":\"7bc7a7d5801a38fa\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-client.js\":\"48f9ca64387cb6fc\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server-edge.js\":\"2fa27c2b218c9023\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-server.js\":\"c20df193926d100b\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static-edge.js\":\"64aeee144128dd7c\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-static.js\":\"7e873a1303018355\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom-test-utils.js\":\"554c2c92cb332faf\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-dom.js\":\"d8f3c5f6f99edad3\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react-jsx-runtime.js\":\"9d608e6aedd1cca9\",\"/knowledge-medium/pr-preview/pr-1844/src/vendor/react.js\":\"ff5cec86c237f2da\",\"/knowledge-medium/pr-preview/pr-1844/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1844/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
