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
		buildId: "a09378eba38f-e570414c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1845/\":\"fe12de4641271347\",\"/knowledge-medium/pr-preview/pr-1845/index.html\":\"fe12de4641271347\",\"/knowledge-medium/pr-preview/pr-1845/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1845/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1845/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1845/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1845/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1845/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1845/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1845/assets/FacadeVFS-CzfVQ-se.js\":\"2125984befe3bad2\",\"/knowledge-medium/pr-preview/pr-1845/assets/OPFSCoopSyncVFS-PvCFhg2H.js\":\"edf88a7835fa86fc\",\"/knowledge-medium/pr-preview/pr-1845/assets/OPFSWriteAheadVFS-DT4GOUq7.js\":\"798196912a3647f3\",\"/knowledge-medium/pr-preview/pr-1845/assets/wa-sqlite-C7zzrpeW.js\":\"a81cfb47f2457cea\",\"/knowledge-medium/pr-preview/pr-1845/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1845/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1845/assets/wa-sqlite-async-DRAqzW2h.js\":\"cf147649b3c8f835\",\"/knowledge-medium/pr-preview/pr-1845/assets/worker-DoFojmx7.js\":\"513ed34765c08c0a\",\"/knowledge-medium/pr-preview/pr-1845/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1845/chunks/app-By_g4h5K.js\":\"cc47f514dea14dbe\",\"/knowledge-medium/pr-preview/pr-1845/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1845/index.js\":\"d1147dc716609db8\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1845/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1845/assets/AccessHandlePoolVFS-iD1AvQ16.js\":\"63fae4f97148b67c\",\"/knowledge-medium/pr-preview/pr-1845/assets/IDBBatchAtomicVFS-ClGhFF5W.js\":\"e6e8689afd304fa3\",\"/knowledge-medium/pr-preview/pr-1845/assets/MemoryVFS-DKj9B5LP.js\":\"7d592b5a2d236c35\",\"/knowledge-medium/pr-preview/pr-1845/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1845/assets/mc-wa-sqlite-SeAzxWao.js\":\"db052c61e6c28b52\",\"/knowledge-medium/pr-preview/pr-1845/assets/mc-wa-sqlite-async-CCNHIc_x.js\":\"39f8b3d285608f4b\",\"/knowledge-medium/pr-preview/pr-1845/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1845/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1845/chunks/AccessHandlePoolVFS-D3HQ5O-c.js\":\"a14d84d655f59660\",\"/knowledge-medium/pr-preview/pr-1845/chunks/FacadeVFS-BpL38n-7.js\":\"12400f3e3f1bf161\",\"/knowledge-medium/pr-preview/pr-1845/chunks/IDBBatchAtomicVFS-D9uEaUkL.js\":\"d4f3e611412398cc\",\"/knowledge-medium/pr-preview/pr-1845/chunks/MemoryVFS-jdrr68RC.js\":\"4aa3f597593ea7cb\",\"/knowledge-medium/pr-preview/pr-1845/chunks/OPFSCoopSyncVFS-FyW7o8rI.js\":\"3ab79d15c74b9f77\",\"/knowledge-medium/pr-preview/pr-1845/chunks/OPFSWriteAheadVFS-CrOHhrB_.js\":\"579c89a9ff160541\",\"/knowledge-medium/pr-preview/pr-1845/chunks/Preview-Ct7hRMbQ.js\":\"ef6a2a477a3a1f17\",\"/knowledge-medium/pr-preview/pr-1845/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1845/chunks/card-DylqUujv.js\":\"e10db37090a5e49f\",\"/knowledge-medium/pr-preview/pr-1845/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1845/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1845/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1845/chunks/dist-CXuwW61l.js\":\"4200a3f7cebf1edb\",\"/knowledge-medium/pr-preview/pr-1845/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1845/chunks/mc-wa-sqlite-CTomSnyV.js\":\"5dc9bcf8de78d92f\",\"/knowledge-medium/pr-preview/pr-1845/chunks/mc-wa-sqlite-async-m8BOSOSo.js\":\"fe4832d2ff7052d8\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-CWykf7oI.js\":\"025ddcaef85a026c\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-Cwi1oE0h.js\":\"4bf95db811ce8e4a\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-DoTKYcAR.js\":\"52fe2a7c592fb2e3\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-Dqmp_WQa.js\":\"e0751e8e6fa78db8\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-Dr8I1BwU.js\":\"549586907f7020f3\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-Dx8rABd0.js\":\"fc42dc894793ba53\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-QQSdSskw.js\":\"b6748000179f5042\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-dom-server-legacy.browser.production-qYEy1ZXF.js\":\"878e00c6e43e3f1a\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-dom-server.browser.production-TfnPrhon.js\":\"fd0e3b62397c2984\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-dom-server.edge.production-9ICEM6b-.js\":\"4b8efaf9303d6e16\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-rNfJIFHl.js\":\"eaf6a670099920ac\",\"/knowledge-medium/pr-preview/pr-1845/chunks/server.browser-CXzpmGYC.js\":\"2616d960046575bb\",\"/knowledge-medium/pr-preview/pr-1845/chunks/textarea-BnR0i_Nc.js\":\"1387e5706dcfdc30\",\"/knowledge-medium/pr-preview/pr-1845/chunks/ui-BDQRaiL0.js\":\"f7313ba12507c709\",\"/knowledge-medium/pr-preview/pr-1845/chunks/wa-sqlite-DleHxBtE.js\":\"b90ed629f58b3252\",\"/knowledge-medium/pr-preview/pr-1845/chunks/wa-sqlite-async-BbqEtlHh.js\":\"5f6fb826a74d80e7\",\"/knowledge-medium/pr-preview/pr-1845/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1845/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1845/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1845/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1845/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1845/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1845/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1845/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1845/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1845/src/App.js\":\"114d792cba0eb05f\",\"/knowledge-medium/pr-preview/pr-1845/src/appUpdate.js\":\"a8a5e2a830e213ec\",\"/knowledge-medium/pr-preview/pr-1845/src/appVersion.js\":\"027a176ecf313edf\",\"/knowledge-medium/pr-preview/pr-1845/src/bootstrap/initialLayout.js\":\"15cf90118384c4c7\",\"/knowledge-medium/pr-preview/pr-1845/src/bootstrap/openWorkspaceData.js\":\"4d9959c4fac77215\",\"/knowledge-medium/pr-preview/pr-1845/src/bootstrap/resolveWorkspace.js\":\"29adf0e94eb19654\",\"/knowledge-medium/pr-preview/pr-1845/src/bootstrap/workspaceBootstrap.js\":\"5a31d5e7e757c26d\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockComponent.js\":\"cf6dab5b35258195\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockCrumbs.js\":\"80929aa3258f1fe0\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockEditor.js\":\"8004108664a60b81\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockLoadingPlaceholder.js\":\"3538f5b0db57aff3\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockProperties.js\":\"d1f8607c4b6b5405\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockSearchPicker.js\":\"c71877333d48565f\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ConfirmBulkDeleteDialog.js\":\"21e2a80260ed1989\",\"/knowledge-medium/pr-preview/pr-1845/src/components/DividerHandle.js\":\"b77737a44c1f9fb2\",\"/knowledge-medium/pr-preview/pr-1845/src/components/DraftEditor.js\":\"abc3cf47432f715e\",\"/knowledge-medium/pr-preview/pr-1845/src/components/GutterPill.js\":\"872e755d574ab65a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/Header.js\":\"22f1b72a36355602\",\"/knowledge-medium/pr-preview/pr-1845/src/components/LazyBlockComponent.js\":\"818f54d373f8986a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/Login.js\":\"4158e1ffb8157d0b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ZoomableSurface.js\":\"e5141a3c70582715\",\"/knowledge-medium/pr-preview/pr-1845/src/components/editModeKeepalive.js\":\"ba4c48693eb81290\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f2442d03293fadb0\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1ae192d80b712c60\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/RefPropertyEditor.js\":\"9e1281015bf9440d\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/RefTargetTypePicker.js\":\"186940e05e8f68e5\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/SelectPropertyEditor.js\":\"ca88dc6252ebfecf\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/TypesPropertyEditor.js\":\"74ef2acf11025b8c\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/defaults.js\":\"e5834afea06d8ac6\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/kernelValuePresets.js\":\"a60b21a7658a1275\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/selectablePresets.js\":\"660d33206b6af4c0\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/typesPropertyUi.js\":\"9cb798d467675c7b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/AddPropertyForm.js\":\"52d17fa1f8f176e2\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/PropertyPicker.js\":\"78f50ed73fa19d81\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/PropertyRow.js\":\"8b56045c1488bfa5\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/Rows.js\":\"6a1aa1476dee2803\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/actions.js\":\"c9ad7b7e45666a38\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/declarationOnly.js\":\"604c775718e83bc8\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/layout.js\":\"61f2ed4737ae6710\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/model.js\":\"5de4cbca1955d53b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/shapeUi.js\":\"3638fe923dd1359b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/shapes.js\":\"0bc045d88e521ba0\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/usePropertyEditingActivation.js\":\"568221ab19baabfd\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/visibility.js\":\"c3d53567fa386e27\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanelSections.js\":\"a2c0b8fef7403cd3\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/BlockEmbed.js\":\"2ab7340ea1d72c79\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/BlockLink.js\":\"9a12166eaa8137ae\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/BlockRef.js\":\"8640fa248e929170\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/ReferenceLink.js\":\"882ec845ce8c9b15\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/cycleGuard.js\":\"a4611ee19e8efa1d\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/cycleGuardContext.js\":\"bb6591dc5bb158b9\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/linkInteraction.js\":\"1ef8043457c4246c\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/referenceLayout.js\":\"46bea7aa94ba7488\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/useBlockRefAncestors.js\":\"0afb83a6e96dfff3\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/BlockGutter.js\":\"dfd7f089fd5d9ecc\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/BlockInfoDialog.js\":\"6e2a5b54e3a1699b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/BlockTypeBlockRenderer.js\":\"ab2dbef868e92aa3\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/BulletHoverCard.js\":\"a66b9971a1af79c4\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/CodeMirrorContentRenderer.js\":\"2c6951e6d49e9a5a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7d2e832303dc7914\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/ColumnResizeHandles.js\":\"d408a3fe1e99535a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bf9a0f1f55c1326c\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/DefaultBlockRenderer.js\":\"5959eddfa9157b15\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/LayoutRenderer.js\":\"208e9e78b7719e09\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/MarkdownContentRenderer.js\":\"04f9d72372f6790b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/MissingDataRenderer.js\":\"806e1fc06ed530db\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/PanelRenderer.js\":\"b375195756aab144\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c586a795b35d197c\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/TopLevelRenderer.js\":\"8698fffba02e26e4\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/blockGutterMode.js\":\"519aa79244661d87\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/blockTitleText.js\":\"cc908215fca3f711\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/fieldCreationKeydown.js\":\"fce0a92943151fac\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/layoutRootContext.js\":\"ff40e5c3b397d1e0\",\"/knowledge-medium/pr-preview/pr-1845/src/components/typeChip/TypeChip.js\":\"a3e173336d1cdda0\",\"/knowledge-medium/pr-preview/pr-1845/src/components/typeChip/chipStyle.js\":\"e6c6fa50b48875bb\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/anchored-floating.js\":\"825877d893ac9e5b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/button.js\":\"bb089aa9072e5f57\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/card.js\":\"b975786617be5d11\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/checkbox.js\":\"fd1f09fb3190cd31\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/collapsible.js\":\"74c969f032c08d91\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/command.js\":\"24cce5b16152bdc2\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/context-menu.js\":\"122b37492f89baf5\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/dialog.js\":\"c5eea074dd388f6c\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/dropdown-menu.js\":\"30e2d1bccfa94cde\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/floating-listbox.js\":\"371d29b83cd1a3fd\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/index.js\":\"202dccbc46b84ca8\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/input.js\":\"7505d8cc68278c9e\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/kbd.js\":\"01cdb5fc099d4702\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/label.js\":\"8bf8844e9d68b9dc\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/textarea.js\":\"27842607be00df98\",\"/knowledge-medium/pr-preview/pr-1845/src/components/useEditModeYieldKeepalive.js\":\"d951655eb5c4b618\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/BootFallback.js\":\"668cb9a428c62df2\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/FocusedRowLazyMount.js\":\"dd7acbe4000b5bfd\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/LazyViewportMount.js\":\"e4e356b170c53224\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/LocalDbCorruptionFallback.js\":\"8669ac68c771ec29\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/error.js\":\"162dd6ca8b827af0\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/lazyMountRegistry.js\":\"768195b3cfabf044\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/suspense.js\":\"763b1057267c5766\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/CreateWorkspaceDialog.js\":\"1c7ca99d5877a4f1\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/PendingInvitations.js\":\"4d9625ba03d80c5b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/SyncProgress.js\":\"f811984b79181e86\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/UnlockProgress.js\":\"c30113eb0b0514ef\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/WorkspaceKeyGate.js\":\"d39a114b1beb7f38\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/WorkspaceSettingsDialog.js\":\"0899e2093a63bbcb\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/WorkspaceSwitcher.js\":\"0daf83f2b79501b2\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/WorkspaceSyncGate.js\":\"1edd8f2b4027ece7\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/ConversionFlow.js\":\"4507374e763c4c34\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/ConversionFlowHost.js\":\"489f88a3f0320d2b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/EncryptionSection.js\":\"73776906720095d7\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/attachmentPrompts.js\":\"63d0a308066e1104\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/bundleFolderPrompts.js\":\"dc735304ba191782\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/conversionFlowDeps.js\":\"45689b3a5a57acd9\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/conversionFlowStore.js\":\"7c260e218eddb998\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/flowUi.js\":\"bbd2e627cb6c7b06\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/useConversionRun.js\":\"51d0609b84b177cc\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/keyUi.js\":\"a5c09a72bc1fbb09\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/useCloseOnKeyLoss.js\":\"7ce98b896066fc69\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/useCloseOnServerE2ee.js\":\"87293b7ad12a0d98\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/workspaceUnlocked.js\":\"a8b5ac702c27f976\",\"/knowledge-medium/pr-preview/pr-1845/src/context/backgroundSubtree.js\":\"2d38a35e6cf982fd\",\"/knowledge-medium/pr-preview/pr-1845/src/context/block.js\":\"e246409e67e5c6f2\",\"/knowledge-medium/pr-preview/pr-1845/src/context/layoutWsContext.js\":\"5c6df475a5f38d1c\",\"/knowledge-medium/pr-preview/pr-1845/src/context/propertyDisplay.js\":\"9f19d772fb4de5bd\",\"/knowledge-medium/pr-preview/pr-1845/src/context/repo.js\":\"a9a109b81420977c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/aliasClaim.js\":\"7f0dc3a754630a54\",\"/knowledge-medium/pr-preview/pr-1845/src/data/aliasSeatNamespace.js\":\"d2d31326633119ce\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/blockData.js\":\"cb192d2c1b9dbaf3\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/blockType.js\":\"cc7e3672439237e2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/changeScope.js\":\"062f05df3ebb2055\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/codecs.js\":\"b2b332fbe0bcdbd7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/derivedData.js\":\"0f20fe187806d934\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/errors.js\":\"b65b3f1ea4230a7c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/events.js\":\"fad882714c7a5bc3\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/handle.js\":\"309b6d618ebec637\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/index.js\":\"a5ee176768879156\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/mutator.js\":\"d210b9446996f9c9\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/processor.js\":\"32ae43a94ab067ed\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/propertySchema.js\":\"991a65ae434a5371\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/query.js\":\"d65df6e85c88acc1\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/sameTxProcessor.js\":\"9cd91deabfd0d2bf\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/schema.js\":\"309b6d618ebec637\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/tx.js\":\"309b6d618ebec637\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/typedBlockQuery.js\":\"55621c430abe680d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/user.js\":\"8a7af54fa923744f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/valuePresetCore.js\":\"11f3ae3f7dca1885\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/valuePresets.js\":\"17d75746fdb429b1\",\"/knowledge-medium/pr-preview/pr-1845/src/data/attachmentCleanerIOVerb.js\":\"ae80860cde858222\",\"/knowledge-medium/pr-preview/pr-1845/src/data/block.js\":\"ddfb257ca170b1d7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockCache.js\":\"9aa8dc36b5db13e7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockId.js\":\"d0dad8964f152f4d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockLiveness.js\":\"d05f747a819bb28d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockMerge.js\":\"40c4ab2924e81a28\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockSchema.js\":\"4a5fa11e92262ddf\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockTypeLookup.js\":\"2698567551de0f3d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockTypes.js\":\"521a3475d04eed46\",\"/knowledge-medium/pr-preview/pr-1845/src/data/clientContext.js\":\"6490f875f05ee039\",\"/knowledge-medium/pr-preview/pr-1845/src/data/dbFileSiblings.js\":\"439157f55b531cc2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/definitionSeeds.js\":\"d6b3a4b591b1cc4c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/derivedIds.js\":\"caff9ffc13b87e2a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/drawnSubtree.js\":\"862422b3ad2767ee\",\"/knowledge-medium/pr-preview/pr-1845/src/data/facetBridge.js\":\"89a165bee03eb371\",\"/knowledge-medium/pr-preview/pr-1845/src/data/facets.js\":\"35e7f7ea18ef8780\",\"/knowledge-medium/pr-preview/pr-1845/src/data/globalState.js\":\"9b4b8c15d56defc6\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/aliasClaimRederiveProcessor.js\":\"fab8fa79f0225cc7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/ancestorBatch.js\":\"a4ce9facbccf8db8\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/blockTypeTypeifyProcessor.js\":\"077343183266b84f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/clientSchema.js\":\"a7310db2a47d831e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/commitPipeline.js\":\"5c12a5c5366d20d8\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/devAssertions.js\":\"31ea86d64c67c1c8\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/firstSync.js\":\"9b4e9ff5efe468c5\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/freshInitialLoad.js\":\"0f09fd2faf58a61c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/graphBackfillClaim.js\":\"51d879a336e2a01e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/handleStore.js\":\"87c31090eafe85cb\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/idleMarkerJobs.js\":\"21ee44168d98468c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/initialDownload.js\":\"7e2b2871f3795963\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/initializeClientDatabase.js\":\"31577f11caa1b256\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/jsonCanonical.js\":\"260e0cf31dae24c0\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/kernelInvalidation.js\":\"d18199911c106554\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/kernelProcessors.js\":\"e0c9eb6be2023425\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/kernelQueries.js\":\"fa1affe07f8c6841\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/mergeTypeMembershipProcessor.js\":\"87241d387af3a910\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/normalizeReferencesProcessor.js\":\"d3d20634bd99d697\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/poolInstrumentation.js\":\"98cde9b817a42495\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/processorRunner.js\":\"31f83a33e5c583fe\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyCellBackfill.js\":\"a609543fe8307b35\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyChildMint.js\":\"07cb19e097bb01a1\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyChildrenProcessor.js\":\"6e4c248873072c89\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyDefinitionChangeProcessor.js\":\"01d5d403bd5ba893\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyDefinitionSynthesis.js\":\"0488c3144c088f1b\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyKeyScan.js\":\"c8eff6967065fc5b\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertySchemaResolution.js\":\"9a5a4444b11b872c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyValueEdits.js\":\"9b7710ff89b9de1f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/raiseProtocol.js\":\"beeea66ae93593af\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/readBatch.js\":\"928add25cb769382\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/refProjection.js\":\"c3617a35565f2060\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/referenceTargetLookups.js\":\"df982d4eb0a02fd3\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/referenceTargetProcessor.js\":\"cd1db7b81f6217bc\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/replayMerge.js\":\"9f3a0b3284c24f16\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/sqlBinds.js\":\"1ee5c6e84affc2b2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"853b1372b83a9ab7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/arrivalProcessors.js\":\"7665012af05e5515\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/invalidate.js\":\"1ec9b155ad078985\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/materialize.js\":\"a96b84c0929c81c1\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/observer.js\":\"ed0e821ff26c5085\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/reconcile.js\":\"61ce4a883b5d1cf2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/timingMetrics.js\":\"b558492336df27d9\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/treeQueries.js\":\"2a47cf713afb9e8a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/txEngine.js\":\"1b62a2780156ff6f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/txSnapshots.js\":\"51a1741dabea68e5\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/typedBlockQuery.js\":\"03f722d04b71ab41\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/undoManager.js\":\"ec4b398c65f575e6\",\"/knowledge-medium/pr-preview/pr-1845/src/data/invalidation.js\":\"a1db161de58dc9df\",\"/knowledge-medium/pr-preview/pr-1845/src/data/kernelDataExtension.js\":\"c5fe61ea2d8d8832\",\"/knowledge-medium/pr-preview/pr-1845/src/data/kernelPage.js\":\"89a02153f627e341\",\"/knowledge-medium/pr-preview/pr-1845/src/data/kernelValuePresetCores.js\":\"da0b916ff1d9dec4\",\"/knowledge-medium/pr-preview/pr-1845/src/data/localDbCorruptionSignal.js\":\"08f24d8b24d69755\",\"/knowledge-medium/pr-preview/pr-1845/src/data/localDbStorage.js\":\"563e91d92e4a6ddf\",\"/knowledge-medium/pr-preview/pr-1845/src/data/localDbVfs.js\":\"7ed3b17101027eed\",\"/knowledge-medium/pr-preview/pr-1845/src/data/localSchema.js\":\"a9f0eb01b59e6734\",\"/knowledge-medium/pr-preview/pr-1845/src/data/maintenance.js\":\"a18c81e5db1ada94\",\"/knowledge-medium/pr-preview/pr-1845/src/data/mergeProperties.js\":\"e30b45d16edcb610\",\"/knowledge-medium/pr-preview/pr-1845/src/data/metricsConsoleHook.js\":\"c8e12004d13ac742\",\"/knowledge-medium/pr-preview/pr-1845/src/data/migrationsPage.js\":\"0930ae084ffb9234\",\"/knowledge-medium/pr-preview/pr-1845/src/data/mutators.js\":\"64af313d1a6219d8\",\"/knowledge-medium/pr-preview/pr-1845/src/data/orderKey.js\":\"474aa2f6dd6a536e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/orderKeyPlacement.js\":\"fc4683f296a5e124\",\"/knowledge-medium/pr-preview/pr-1845/src/data/outlineSurface.js\":\"45d951d930ba6687\",\"/knowledge-medium/pr-preview/pr-1845/src/data/pendingEditorContent.js\":\"8a43128ed2f4a47f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/pendingUploadsSql.js\":\"51f66c86afacd083\",\"/knowledge-medium/pr-preview/pr-1845/src/data/pluginStateExtensions.js\":\"ff61bff74598f618\",\"/knowledge-medium/pr-preview/pr-1845/src/data/powerSyncLogger.js\":\"2525ecc34f76e9f8\",\"/knowledge-medium/pr-preview/pr-1845/src/data/projectorRuntime.js\":\"fdcb5a4db1099d84\",\"/knowledge-medium/pr-preview/pr-1845/src/data/properties.js\":\"92c54fd3aefb9ca2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertiesPage.js\":\"0415dbe82300b69c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyChildren.js\":\"12e8760d039c0c8f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyDefinitionFanout.js\":\"b0cbbb6ca9e407bd\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyDefinitionMetadata.js\":\"9d88466d08e80440\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyDefinitionRegistry.js\":\"6194e41297a60bb9\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyDisplayMode.js\":\"fb89c29196cfcf7c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyRowCreation.js\":\"4b0f8d7ca201b2b4\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertySchemaCreation.js\":\"6f5cb9c942980f54\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertySeeds.js\":\"c4a0252a7d50f8aa\",\"/knowledge-medium/pr-preview/pr-1845/src/data/recentsPage.js\":\"bacc3bf29c38ad18\",\"/knowledge-medium/pr-preview/pr-1845/src/data/referenceBlock.js\":\"13bf4cd757e90e6b\",\"/knowledge-medium/pr-preview/pr-1845/src/data/rejectedUploads.js\":\"fa6ba05c579b10ad\",\"/knowledge-medium/pr-preview/pr-1845/src/data/releasePowerSyncConnection.js\":\"00f95e475b0ed3b2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/repo.js\":\"566c936c3327a664\",\"/knowledge-medium/pr-preview/pr-1845/src/data/repoProvider.js\":\"67c7f4ab1b01c3c2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/rowProperty.js\":\"b7994c09c242f63b\",\"/knowledge-medium/pr-preview/pr-1845/src/data/searchFilter.js\":\"40ad640e5645394d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/seedIdentityLedger.js\":\"2e3b614649d0e6a0\",\"/knowledge-medium/pr-preview/pr-1845/src/data/stateBlocks.js\":\"c3bdf9951fdf0ad2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/structuralEditPolicy.js\":\"8f3bb7348d653cee\",\"/knowledge-medium/pr-preview/pr-1845/src/data/subtreeDelete.js\":\"2d3c7ef84b604b99\",\"/knowledge-medium/pr-preview/pr-1845/src/data/syncStreamLock.js\":\"4b3dccafa607db6f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/syncedTableSqlRecognizer.js\":\"85de4bec9da59250\",\"/knowledge-medium/pr-preview/pr-1845/src/data/syncedTableWriteGuard.js\":\"ff4e15cee86504ed\",\"/knowledge-medium/pr-preview/pr-1845/src/data/targets.js\":\"302ce793bdfd4a18\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeColors.js\":\"30d88182fa76d0d9\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeDefinitionMetadata.js\":\"8cc28955a2a1ef51\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeDefinitionRegistry.js\":\"71bef65054e550e5\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeExtraction.js\":\"655837b21fd5c24f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeInitialValues.js\":\"6d95d389abf98fc3\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typePropertyGroups.js\":\"c44ff7767ff27fd7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeSeeds.js\":\"b0ec5bc76e29fe5c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeTagger.js\":\"9b3ec8a4bad1f5b8\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typedRecords.js\":\"03baf7ccdb6c9c69\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typesPage.js\":\"806183791fc411af\",\"/knowledge-medium/pr-preview/pr-1845/src/data/userPrefs.js\":\"a8063465d2bb63c0\",\"/knowledge-medium/pr-preview/pr-1845/src/data/userSchemasService.js\":\"027642e18d7c1b95\",\"/knowledge-medium/pr-preview/pr-1845/src/data/userTypesService.js\":\"ef297f9e6e043730\",\"/knowledge-medium/pr-preview/pr-1845/src/data/valuePresetRegistry.js\":\"16b7458af13ef002\",\"/knowledge-medium/pr-preview/pr-1845/src/data/visibleChildren.js\":\"c4bbea43653c702f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaceConversion.js\":\"cf9271f99c2468db\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaceFirstSync.js\":\"040ec049df202e19\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaceIdNamespace.js\":\"2fba9af6caffece0\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaceSchema.js\":\"2ce75ba766a73693\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaces.js\":\"d02a0136dc75b32f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/writeAheadLog.js\":\"609e5a9ab0fd9ee9\",\"/knowledge-medium/pr-preview/pr-1845/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/BlockPasteShellDecorator.js\":\"59ef3d905ab8c7df\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/atTrigger.js\":\"0654d63579c90973\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/autocomplete.js\":\"2b6c12106775020b\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/codeMirrorExtensions.js\":\"897e9f91bf5bcbbc\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/contentFlush.js\":\"c29cb6295ef52b85\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/defaultInteractions.js\":\"3087321dfd0b6aaf\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/editSettleSignal.js\":\"342fb232e5b0a362\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/insertImage.js\":\"ea4868f4993926ec\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/referenceCompletionRange.js\":\"643d0faf37cf9d0f\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/referenceTargetTypes.js\":\"baa2f1be12a13a8c\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/syntaxContext.js\":\"71eee3e23dd2efec\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/triggerMatch.js\":\"1abb1776bc9ba263\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/AppRuntimeProvider.js\":\"f824acbb699b44d3\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/BlockFocusShellDecorator.js\":\"ba539111361f86ac\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/ExtensionRenderBoundary.js\":\"034edc30e7c5275a\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/PanelContentRecovery.js\":\"144e6d6da46ec159\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/apiCatalog.js\":\"cd1ee61b96d4a62a\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/approveExtensionHere.js\":\"cf26bc7a9774f6f5\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/armedCutAppMount.js\":\"61aab2a52adf7b15\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/batchableKeyedStore.js\":\"3c7a802c614babe7\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/blockInteraction.js\":\"658f8397db68ebf7\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/blockSelectionAction.js\":\"3d4a781adcaab781\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/compileExtensionModule.js\":\"d19c1e9190ef8674\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/compiledModuleCache.js\":\"411247f017b6481e\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/continuousGestures.js\":\"fde58f0b3c2ea1a1\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/core.js\":\"47111ae78cd689fc\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/defaultRenderers.js\":\"6446f42562815454\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/definitionFanoutAppMount.js\":\"6903e6055eb252cb\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/dialogAppMount.js\":\"6825cd9cf0232ae7\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/dynamicExtensionSeeds.js\":\"a44c394ec48b822e\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/dynamicExtensions.js\":\"92f1b31efc8e3d2a\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/exampleExtensions.js\":\"01e5f674b68bab89\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionApprovalStatus.js\":\"60b32cd5f3864e79\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionLoadErrorToast.js\":\"4d6bd6bd60aafc95\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionLoadErrors.js\":\"1c2a2da0f3c5cfe0\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionLookup.js\":\"96f39ace70944222\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionToggles.js\":\"e6093572ff3a873b\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionUtilitiesCss.js\":\"87f3d4c93411ade4\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/kernelPageDeletionGuard.js\":\"de5d129c00a5ac8c\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/liveRuntime.js\":\"6fd685cc56a14be9\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/openExtensionsSettings.js\":\"2ab38af2aee2bd1d\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/overridesCache.js\":\"6cb14117db223fb7\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/pluginIds.js\":\"219547ddccfb3c9b\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/processorRejectionToast.js\":\"30c0ae0173c4add1\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/runtimeActions.js\":\"3a804b5249645fb1\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/runtimeContext.js\":\"6bebed506e23b028\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/staticAppExtensions.js\":\"58f9f2134e2527aa\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/staticDataExtensions.js\":\"4e34440c3c9637d2\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/toastAppMount.js\":\"92b5b9336123fae7\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/useOverrides.js\":\"d20749d86aaaa554\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/useShortcutSurfaceActivations.js\":\"b43911e779864712\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/discoverToggleTree.js\":\"f88acb1c9af90db4\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/facet.js\":\"d86cd994d0e08cd0\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/resolveAppRuntime.js\":\"10b4074f59467293\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/runtimeEvents.js\":\"e783fcc455d8c83c\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/togglable.js\":\"6ad0e2efd43a37af\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/variantFacet.js\":\"857fdc065bf8ec9d\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/verbFacet.js\":\"57252c9ec7bbb3ae\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/block.js\":\"1cf386112c3d7b26\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/focusedChild.js\":\"ac65403ce1856c20\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/propertySchemas.js\":\"285c8889840860b5\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/typeRegistry.js\":\"484964ecf43507f6\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useAncestorCrumbs.js\":\"1c89f394de3e5180\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useAutocompleteListbox.js\":\"17db51ba8bd99756\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useDebouncedSearch.js\":\"329be2c665d6822b\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useDebouncedValue.js\":\"e586654d965fb6cf\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useIsFocalRender.js\":\"d9e1a38de3fe3c06\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useIsReadOnly.js\":\"f2c965b8f7f2d945\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useMaterializeBacklog.js\":\"a4f746fa81161ee2\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useMinuteClock.js\":\"ffe77b067683954f\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/usePanelLayoutProjection.js\":\"38e273c16c9861ce\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/usePendingInvitations.js\":\"4b269d98b742e128\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useRendererRegistry.js\":\"42093871d488022e\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useRetainedFieldRows.js\":\"29490ca2a84ad4d1\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useWorkspaces.js\":\"60106eb973a0f262\",\"/knowledge-medium/pr-preview/pr-1845/src/lib/utils.js\":\"51a67b3c0a8ef122\",\"/knowledge-medium/pr-preview/pr-1845/src/main.js\":\"0ecae487b3d30a78\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/MarkdownImage.js\":\"3c1f21b518cb7cc1\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/blockSeparators.js\":\"ad98637c9e3f22b5\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/context.js\":\"503244efd3a2bd6c\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/defaultMarkdownExtension.js\":\"8c2eba62ab6fa1cf\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/extensions.js\":\"59be43814c29e4b3\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/renderMarkdownHtml.js\":\"83caec01b663224e\",\"/knowledge-medium/pr-preview/pr-1845/src/minimal-editor.js\":\"e4f56b6c04dd8111\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/armedCut.js\":\"9e254bb389da7975\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/captureMediaVerb.js\":\"87d6acb65431a580\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/clipboard.js\":\"77a2cd3f82c7aa59\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/decision.js\":\"59bbe0e44715046c\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/operations.js\":\"6dcb2ed31c9dc91a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/account-header/AccountHeaderItem.js\":\"1935ccd1ebfe3c44\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/account-header/index.js\":\"5dea66d9ffde9ddd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4e13533b058b73e1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/askAgent.js\":\"ce451818034c60c4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/askedStore.js\":\"6af014abec94ed48\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3835ee9d5d3a22e4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/chipState.js\":\"ee0b92f1f0a2b326\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4a8111ece1744e67\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/index.js\":\"8d06e2dd11322ed6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"f67d5a6f2becc9ea\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/schema.js\":\"0a29e34afd38fee3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8b985f6a61d60c57\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/BridgePairingDialog.js\":\"f280cd8975a1500b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/addMedia.js\":\"1e755a84cdaf317e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/backlinks.js\":\"cb53eb30476f6513\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/block.js\":\"7e2e3f691aec80e2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/context.js\":\"43f5948949b722d5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3bde46b096d5d063\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/index.js\":\"bb92a760abce487f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/outline.js\":\"9fa62e2620c0e672\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/properties.js\":\"ee51368a001f3d1b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/refs.js\":\"d5ec03b67e35f0af\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a07fdfb48da22742\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/search.js\":\"7f277346a653f4e9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/shared.js\":\"c087bc5c1e9d136e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"29797e414ef93b1d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/text.js\":\"aaeb473f2b6b171f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentWrites.js\":\"a0d6484885728677\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/authoringCatalog.js\":\"6390f95a987f15a3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/blockRefTargets.js\":\"b2e9f3c06f994168\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/bridge.js\":\"2f52637e0a27bc01\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/bridgeLoop.js\":\"78f06d187cbdbe15\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/changeHistory.js\":\"20b413d46bdca7a6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/commands.js\":\"0c7b816f13481b2a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/commentsCommands.js\":\"10530e2992790dcc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/dataExtension.js\":\"1c4da5fb1ac83de9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/dataModelGuide.js\":\"6865e25c5baeb9bd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/describeRuntime.js\":\"a15012bc36679a8e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/extensionLint.js\":\"e61136936187880b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/grainAudit.js\":\"0e242e8711323476\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/healthCommand.js\":\"8befe6b664e46a41\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/index.js\":\"58b731e21adc6890\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/presetIdentity.js\":\"5903db6657c8fd73\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f330d8cc77ceda8f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/readMedia.js\":\"8d86c1a71f32bc35\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/schema.js\":\"aa83cb55b4b9feba\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/serialization.js\":\"1bb550bdd47f3a98\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/targets.js\":\"0f928834bb408ed9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/tokens.js\":\"c245b1c971806cc7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/watchEvents.js\":\"4ee1b4d4b2cd4df5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/workspaceGuard.js\":\"33dbbcf376793691\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/writeCommands.js\":\"8a8d53643c3f1025\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/AliasCollisionToast.js\":\"3784e0ee87ecf4ce\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/DuplicateNameBanner.js\":\"6986198535a8b9a8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/collisionMerge.js\":\"2aa25d47f952c0f4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/dataExtension.js\":\"a8e528f6bf7e8275\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/index.js\":\"2d81f79303910c6f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/mergeCollisionAction.js\":\"9d449a216fcc9ce5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/pageStyling.js\":\"ac14a7b03a3b523e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/rejectionToast.js\":\"ad298812b2a68478\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/syncProcessor.js\":\"e9549757963039e9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/actions.js\":\"f66e1d30db79b0d6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/addComment.js\":\"f0633559a7f942fc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/anchor.js\":\"cdfec1dd2b099461\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/anchorState.js\":\"a2f0528d5e224119\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/commentLinks.js\":\"ccc3fd536837719d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/confirmThreadDeletion.js\":\"304ae965e82a2c61\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/container.js\":\"a61944ba59f11a4b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/dataExtension.js\":\"8352aef6f13a6f00\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/deleteComment.js\":\"736fefb7e36b859a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/highlights.js\":\"29f0395872d41107\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/index.js\":\"15efc5db15820207\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/linkedCommentsPill.js\":\"8926d4940b31bb1e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/margin.js\":\"6fd568c7edf6558d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/marginSchema.js\":\"f980b3663b94b4c9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/newComment.js\":\"780650682a64f8f1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/ownThreadPicker.js\":\"ef8e6e9e750e031d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/placement.js\":\"615e3e9ba1f397a3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/queries.js\":\"5b39c61b9adeb7f1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/quotePosition.js\":\"90ce2d860d8eaf84\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/quotedIn.js\":\"7d4508d0e1138d76\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/quotedRange.js\":\"43bd5d6b158612d1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/rangeRefs.js\":\"4b450d148b937e86\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/readHighlights.js\":\"0a92778b4dd0aec4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/readSelection.js\":\"fd4caf15cfa433d3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/readSelectionUi.js\":\"5eab05198f943522\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/reanchor.js\":\"a27131a3f35525a8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/schema.js\":\"b3f216c5fba53c1f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/scope.js\":\"e8266d4673e00f88\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/scopeThreads.js\":\"ea3246bdb4318244\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/splitRetarget.js\":\"913b1d107d0b8ddf\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/suggestionCard.js\":\"1f22a1d0d26714b5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/suggestions.js\":\"32e686f2ac007424\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/summaries.js\":\"d33cf5d4116727bc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/summaryBatch.js\":\"39ff7a5d2e8641b8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/surface.js\":\"e3de8da267a68ab6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/threadNavigation.js\":\"0ce01bdf1aa7d0de\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/threads.js\":\"ed9f0e2ec171aaf4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/ui.js\":\"ab6f375f10f1b780\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/uiStore.js\":\"c704f7e3761742b7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/app-intents/appIntents.js\":\"9e136a0f0c83d080\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/app-intents/index.js\":\"ff356dd838bc1695\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/app-update-prompt/index.js\":\"6327655f00245b98\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/app-update-prompt/status.js\":\"31bf3512e69ac530\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"af10544baaececfe\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/MediaBlockRenderer.js\":\"1a3d91146345ab16\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1cd8608cbf1d1763\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/MediaUploadReconciler.js\":\"633f7bfa9e91bab2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/assetDownLane.js\":\"9cff74d22ed7bb7c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/assetResolver.js\":\"24c8d512923276da\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/assetUpload.js\":\"da826a95f4e15a2b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/attachmentCleanerIO.js\":\"fa6ca42b15ce3826\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6ea6067bb9a9f5db\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/blobStore.js\":\"4c2d2bce3aa29940\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/byteStore.js\":\"022b2d30eba324ad\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/cleanerIO.js\":\"69cbc06c051d7100\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/cleanupAttachments.js\":\"5b87d742bb89d4ba\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/dataExtension.js\":\"c0db84d85aff4035\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/downLane.js\":\"dd53a8600c658f1d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/index.js\":\"28593bfc61185d55\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/insertImageContribution.js\":\"794286921e2f1e69\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/laneArming.js\":\"d6d1aaae6c2bf082\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/laneLock.js\":\"9876b96b5ad9f648\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/mediaBlock.js\":\"a6eca261e2ccb656\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/mediaCapture.js\":\"2bcc04e6efead805\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/mediaViewers.js\":\"221a34abb1e7eba9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/mediaViewersFacet.js\":\"2c3921dd6701813a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/pasteCapture.js\":\"dd519373869f8b69\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/resolver.js\":\"51696ee1c90f1b4a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/retryUploadsAction.js\":\"10684e4c1a734411\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/storagePaths.js\":\"f8d640ee7dd04691\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadDrain.js\":\"35acbfc83d8a7b0d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadLaneStatus.js\":\"34fe7690237732c9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadReconcile.js\":\"482a243dd195420c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadRecovery.js\":\"403889d8cd3ce549\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadStore.js\":\"ef6f77bb3f8a7bfb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/useAssetObjectUrl.js\":\"89935897793618e5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a678a4a116ffe32b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a453a7514aed3055\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/facet.js\":\"5c67d405a33eb845\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/index.js\":\"89dad85084bf510f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/prop.js\":\"ca3c58f2e33cc561\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/BacklinkFilters.js\":\"aaf7ff746f0c2b59\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"43c39d95595c9380\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/BlockEntry.js\":\"2c609011034c27ec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/LinkedReferences.js\":\"5e9e220dec5e0d3f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"72305a1356fe371d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/dailyNoteDefaults.js\":\"aadbb03096d6fdb2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/dataExtension.js\":\"a809f1e6d850d5d3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/edgeExclusions.js\":\"65715006cdd320a1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/filterProperty.js\":\"f3af97f06ad135ee\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/index.js\":\"a8a76be2eedf2b12\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bc9cf0ca4160c936\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/applies.js\":\"c426ad2d419d8a42\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/countQuery.js\":\"0e8f3d9cdf49cc79\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/expansionStore.js\":\"bfaa1b488dc01aef\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/index.js\":\"888451c63006b1a6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"2d3a0afda5e47698\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/presentationInvalidation.js\":\"e690592e3c30eab7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/propertyEditorOverride.js\":\"61b3e50213639379\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/propertyFilter.js\":\"e9a65fbfbf536aee\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/query.js\":\"aeed4b7688fb392b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/resolveFilter.js\":\"8c92a570bf084660\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/sourceBatch.js\":\"7bc5bc2151744e46\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/sources.js\":\"393ab5aa6646aeef\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/useBacklinks.js\":\"3af7248d0f9906f0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5cc1429072f5e540\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/BirthdayCelebration.js\":\"451ad26b673be054\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/BirthdayOverlay.js\":\"4048ff1f44770896\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/gate.js\":\"dd1b3b1b3583f8a7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/index.js\":\"3f70ca735cf5c628\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/wolfTheme.js\":\"61e3347a87dbc86a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/BlockDragLayer.js\":\"dbb5c9f3d23ab7ef\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/dragController.js\":\"ec1a391498571a9f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/dropTarget.js\":\"994c96e3b8738dd7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/index.js\":\"746d5c1a761b24d1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/projection.js\":\"00203806ce1149da\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-info/BlockMetaCard.js\":\"88705c51f090cee1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-info/index.js\":\"7f1168aac5d2aaf4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/AddTagDialog.js\":\"4c2924af56946beb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7498244db7d0ee17\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/TagNameIssueHint.js\":\"6866264f5c89388a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/addTagAction.js\":\"9066079f89cc36f9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/appendTag.js\":\"4e1bc40a2e0983d3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/config.js\":\"bbd50626f616f59b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/dataExtension.js\":\"67f3c88f47ab0f15\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/index.js\":\"aa959cf4c7dcd730\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/propertyEditorOverride.js\":\"e20ffc6ee92de61b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0b24a566981c8d85\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"575fc7523479feb8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b575c6a5ef6b448e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"55669427119ecb99\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b91eabd05a136c63\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/index.js\":\"a6ba89330cd52e4c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"08af776a2f341c5a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/CharacterCountItem.js\":\"c6bde09308e1c7d7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7aa4fb64de071913\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/actions.js\":\"b266f40476ea4df6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/blockType.js\":\"2b29d55983b4b644\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/charCount.js\":\"a9816cf817e31fc9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/dataExtension.js\":\"46c8448bab1512a7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/index.js\":\"91211ed0574e3703\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/profiles.js\":\"7f7134793b1cd5a2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/properties.js\":\"3234053aeb6b5bec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/textCounts.js\":\"d158c2914e2f3543\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/colemak-keybindings/index.js\":\"d7437fc7bfc2e6d9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/CommandPalette.js\":\"3a14cd0ba062b812\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/HeaderItem.js\":\"6c4706c2aa2d69dc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/context.js\":\"5d45b89ea7a44073\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/index.js\":\"e5d691d4392bf56d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/selection.js\":\"5fab7dd5cdaabb59\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/toggleStore.js\":\"fd626d024423b38f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/useCommandPaletteActions.js\":\"a734d5df9f444cde\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/ContributorBadges.js\":\"ad83948e03f21bfc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/author.js\":\"c931dc7448848f92\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/codeMirrorExtensions.js\":\"73c7d75fb71289f4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/dataExtension.js\":\"3c3afbe61ff57299\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/index.js\":\"13e8769cf3a0f069\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/mentionAutocomplete.js\":\"00c2de3398885b75\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/processor.js\":\"458293bb164508b8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/profiles.js\":\"e042597d6b79873b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/queries.js\":\"6f9d96343fa6eb5d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/schema.js\":\"bbd35d01e6913aa2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d85241d839a0b9e4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a9928bc28bf6c060\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/index.js\":\"0b4def29bd81927d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"076c477223560b39\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1a225c3c28f13508\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/CalendarGrid.js\":\"85534ef8028c4324\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/DailyNotePicker.js\":\"67beabbe927f3f39\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"928b19a0a75f41ab\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/DateNavDecorator.js\":\"2fb91933a3239a2f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/DateScrubOverlay.js\":\"bcbf3b4103c9f7ac\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/HeaderItem.js\":\"b60e26e0a3006f3c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/ReschedulePicker.js\":\"4b741a3a304f4b33\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/SpreadDatesDialog.js\":\"caa0593a59554c62\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/actions.js\":\"38f48bdbce98a56e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/blockDateAdapter.js\":\"fb8c2c4919adecdd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/calendar.js\":\"0cda60da183c7d5f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dailyNotes.js\":\"33347f5dd799796f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dataExtension.js\":\"6d38c05eb15efc77\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dateScrubActions.js\":\"3fad186cbc434c19\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dateScrubGesture.js\":\"f94135e7b7b0a1c3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fc2f219a3bcb59b3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9fcd9e8fa4d26aab\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/deletionGuard.js\":\"2c5ab0839e92bb7d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dueQuery.js\":\"a13ccadc6ab795ec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/index.js\":\"02f5912f4e179901\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/landing.js\":\"4669a47d7bf5cc37\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/localSchema.js\":\"36e5ace02a68bc43\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/referenceDateAdapter.js\":\"5d91834c815eeff8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/rescheduleAction.js\":\"9af9cffb572b9615\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/schema.js\":\"39262045f7b6116c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/spreadBlockDates.js\":\"953ad4b676a70629\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/spreadDatesAction.js\":\"b9163a16f1e0a592\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/today.js\":\"0430a23187732478\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c9d67be60095dcca\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6bd8fec735e1e690\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/audit.js\":\"6bcea617b13e64ed\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/auditAction.js\":\"7b519289854eea26\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/auditRanges.js\":\"3d6d51ae474ef106\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/diagnosticsSource.js\":\"735ca8a4f89e7ec8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/divergenceScan.js\":\"32dd4ed3a3b9d3b8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/index.js\":\"e84c77289f94ff5e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/propertyChildrenChecks.js\":\"62cc9ba968823afc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/referencesMirror.js\":\"478422476c3f50ea\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/rowJson.js\":\"37fa794fc420903e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/schedule.js\":\"afa70c429fa86fe1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/store.js\":\"2cddb0ed87371db7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-maintenance/action.js\":\"acd4286264d9be35\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-maintenance/index.js\":\"7be9478a8774299b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-maintenance/plugin.js\":\"b41d34ef2945d308\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d7a7e24619707837\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/actions.js\":\"9d1999f57e4f5173\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/changeMarker.js\":\"8caf322e3c33d40c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/diagnostics.js\":\"8a87e77830f9a185\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/fileSystemAccess.js\":\"5342785ba2e76466\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/filenames.js\":\"dded7b72948c9f86\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/index.js\":\"1976f5a5e6694e82\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/mirror.js\":\"762908e84856bc69\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/runLock.js\":\"d0c9f033f4b4813c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/runtimeHealth.js\":\"b45a25506e9c7d6c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/schedule.js\":\"3b76e8f8c6cfee8c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/store.js\":\"62e41761b204f8dc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/default-themes/index.js\":\"1ed1fdf751300290\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/default-themes/themes.js\":\"8472162937a85eb9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/diagnostics/facet.js\":\"a4dfd24b9d071b54\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/diagnostics/useDiagnostics.js\":\"1b4fe69539c4af6c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extension-prompts/dismissals.js\":\"6c816aba21e86ce0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extension-prompts/index.js\":\"4c97218ebdea58ac\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extension-prompts/status.js\":\"f6e762894752a1e2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extension-prompts/store.js\":\"cfe26f954f1c1ea5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"239e79e31cc751c5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/ExtensionsSettings.js\":\"502e6c033a2a43a8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/actions.js\":\"2a1470acbb734dd1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/config.js\":\"23b1317bb9b4762b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/dataExtension.js\":\"c5bfa71c3edc284b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/effect.js\":\"299d64a18cf12118\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/index.js\":\"877b2dd9e34c93cb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1071adbac8aaf397\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/useToggleTree.js\":\"55aacc710e453c89\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/ExtractTypeDialog.js\":\"184d0ab0fd5b0eb4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ee283f33654d59a6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/PropertyShapePicker.js\":\"67027e86d8ee0d27\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/action.js\":\"2f9101b6d2eed20c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/index.js\":\"cffdfb1e6f5a9b38\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/FindReplaceDialog.js\":\"d8a806b43da0fad2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/HeaderItem.js\":\"be4ace81710cd9a9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/dataExtension.js\":\"1d6b3f53a6cf0aa8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/index.js\":\"91c545f461352090\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/search.js\":\"58e41beb2a7f5247\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/toggleStore.js\":\"ac275b4a8edc9de3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/LocationPropertyEditor.js\":\"56aa184f264a6515\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/MapView.js\":\"bbfb21af99823c39\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/blockTypes.js\":\"cc861ce3c120e2f7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/codeMirrorExtensions.js\":\"90cdeec9488ff526\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/createOrFindPlace.js\":\"7f2d5db7d56192f8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/currentLocation.js\":\"334f93b0acd7ca97\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/dataExtension.js\":\"cd2c965f762a12a2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/geoContentDecorator.js\":\"50297997b658306d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/googlePlacesClient.js\":\"973927e25be46545\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/index.js\":\"4ae164c6dd137738\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/locationsPage.js\":\"ba4f85237b836830\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/mapViewport.js\":\"8f6b4824a8183a35\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/pickCurrentLocation.js\":\"221cbe06b4361065\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/placeAutocomplete.js\":\"34e1b42403e90b5e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/placeNameCollision.js\":\"e6bd6db0ce00c276\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/properties.js\":\"2118d26e8c3c2248\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/propertyEditorOverrides.js\":\"b591b2a2e1d952de\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/query.js\":\"e38db18169e3e080\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/usePlaceSearch.js\":\"68e23d253b51c7d6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d18b733de18eb191\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ef615f54fb495d9d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"786705a2e6b4fbbf\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/config.js\":\"f11a4977e4fb52a6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/dataExtension.js\":\"572c5bfb625cc69c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/facet.js\":\"8b5dda4a389163c2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/grouping.js\":\"c6e71c53797a497f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/index.js\":\"12577edcc4735b9a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7cd2c1a8023a0395\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/query.js\":\"3bda3314456762fa\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/resolveConfig.js\":\"1752fcc4b62f9f9d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"88acfcabf54f1414\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"bbe270f55c9cabd8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/HtmlDocumentContent.js\":\"4dfeccad013b4292\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/HtmlFrame.js\":\"76386a276d9c1c49\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/actions.js\":\"f242230e33877f00\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/blockType.js\":\"e844cb73d8546ab3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/confirmRunScripts.js\":\"835aad6181ec9c78\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/dataExtension.js\":\"19e7af3c5f60e15d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/frameAnnotations.js\":\"e74ae77fa385544a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/frameDocument.js\":\"91d9f83a24f6eab8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/frameTheme.js\":\"b7c7191d5adaa5f3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/index.js\":\"33bbb1edaabcfb41\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/scriptConsent.js\":\"012428a738a0d988\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/sourceMap.js\":\"e2380fc5a014cd5f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/useDocumentScripts.js\":\"648b39516bc8a54d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/index.js\":\"ee787fd41aae2d79\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/record.js\":\"4ca464c907f11fe4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/recordStore.js\":\"390f2ef2632dc211\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/responsiveness.js\":\"e2a810bf2d4d2768\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/schedule.js\":\"0c7d155cfd6f15d4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/sessionContext.js\":\"cf0b467a33eb9bf5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fa49f68ed28bea17\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"44d6b36d8562a936\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/actions.js\":\"1b294b7e49b717e6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/config.js\":\"e9432e6a4624f29f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/dataExtension.js\":\"6539171af410d158\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/effect.js\":\"fb7c09b5da812dcb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/index.js\":\"ecd68c4f06ac3534\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/keyCapture.js\":\"c95c39191720f930\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/overrideStore.js\":\"1ecd25ca48facd3e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d82f94b9f9b1d350\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/HeaderItem.js\":\"1a4457001615e63b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/LeftSidebar.js\":\"11c5055fdb437425\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/actions.js\":\"59a159266edce299\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/facet.js\":\"a4f30c667dba81ac\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/index.js\":\"8d67ebf27b6ac335\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/shortcuts.js\":\"f58a1b89339a295f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/toggleStore.js\":\"f4d23a1fabaaee66\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/merge-blocks/MergePicker.js\":\"045055459ecb7671\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/merge-blocks/index.js\":\"d2bb5f413eb1b89e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/merge-blocks/mergeAction.js\":\"840a24c3495c1f71\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/merge-blocks/strategy.js\":\"4f07f8476c11981c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/Button.js\":\"cc400fe8f04f186e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"dcd3c64abfc51f17\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0df1fb475dc27ad2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/facet.js\":\"a8ca58c2200bb8c0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/index.js\":\"9bfabfc38b34cc7c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e1f95a9f29431f89\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/actions.js\":\"24db75790d287699\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6c3291d4977dd4bb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b27dd5219236c701\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/index.js\":\"d770fe889402b8ef\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2d8ea87425b17802\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1a1fc7314d0e4f75\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/contextMenuItem.js\":\"55f371dd7350d1cd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/index.js\":\"de0cfa412f506a6f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/moveAction.js\":\"f3fcf19b0c537d54\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/moveBlocks.js\":\"11d433a18d2c6d38\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/selectionAfterMove.js\":\"c41d0d2a9acb4ef4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/TutorialBanner.js\":\"ab661e01a8a6f735\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/action.js\":\"1319120a3d254458\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/bannerDismissal.js\":\"bdcbf01f7be7a12e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/documents/cheatSheet.js\":\"f7bcd57594ec73b6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/index.js\":\"0af2901a719310d0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/keys.js\":\"5d9c5e457e053d3a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/landing.js\":\"8539328c11cda5b8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/outline.js\":\"7aaa36314224baa0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/seed.js\":\"e23cd39e7354fdd2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b44ee532afd010cc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/analyze.js\":\"c7a81a00139108d6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/diagnosticsSource.js\":\"3ad93940d756d614\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/index.js\":\"eaa295b18bed33f9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/load.js\":\"b36826bd1cf1477c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/monitorRun.js\":\"ebffd0f3935a948a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/schedule.js\":\"ee7aaf08df3b0f4c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/series.js\":\"2898c3f76e743e29\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/store.js\":\"9919d17999e9a3fe\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/trendAction.js\":\"6d26ea5b64bbef77\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/verdict.js\":\"3dc1dbc7e8ee9b61\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/plain-outliner/clickToEditAction.js\":\"921468f4c0e93e3c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/plain-outliner/index.js\":\"d1dd630d6df20fc8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/plain-outliner/interactions.js\":\"867e28c171bdc91c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f87f9ba777c62653\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/MigrationGate.js\":\"ce37c8cd78016d69\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/MigrationGateDialog.js\":\"1b2694dc8bd83718\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/action.js\":\"49603368c5e915a4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/index.js\":\"70b4d25901b08640\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/localRunMessage.js\":\"aff891623d3544de\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/plugin.js\":\"3fc80c4bc556cd21\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/progressReport.js\":\"d3607a092cb146d6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/sweepProgress.js\":\"52daf4d42354a6d8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/FieldRowRenderer.js\":\"4ad46745bfb83a9f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/ValueRowRenderer.js\":\"8c47d072f415f92a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/actions.js\":\"a784cdb816ff9983\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/autocomplete.js\":\"6cdbbf7c1a780eb0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/fieldRow.js\":\"79adc815aa59dfe6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/index.js\":\"db28dd6e514675b1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/referenceWarning.js\":\"4cd1ea0783f92bb5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/valueAutocomplete.js\":\"d2433afce48906e5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/valueSchema.js\":\"3f6a3d6b4e177ab8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/HeaderItem.js\":\"d0c0b166b71451c5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/QuickFind.js\":\"8d6c762e00ce1db8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/index.js\":\"6a1e6e6134175ce3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/recents.js\":\"7b377d2729fd71d5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/resultItems.js\":\"ecb66c31576fd08f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/selection.js\":\"0af60b27b0363835\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/toggleStore.js\":\"642013eb642eeabd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/HeaderItem.js\":\"b03f331aca6b1456\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/RecentsPageBlockRenderer.js\":\"17e6e82e92452f88\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/grouping.js\":\"b40c473e1955cd78\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/index.js\":\"1d226782ba115121\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/target.js\":\"aba5227c3ee8fb2a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/codeMirrorExtensions.js\":\"0b6fe96f20542c59\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/contentPrefill.js\":\"cd0e31b84d6a4043\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/dataExtension.js\":\"ab2d7f46e68bbb14\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/index.js\":\"7c58559014ca3ada\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"46237685e23343ac\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/invalidation.js\":\"f22df3322d6664df\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/localSchema.js\":\"e532689f6eea987a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/blockrefs/index.js\":\"11da38044edc5f84\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1f38d37606c6a5e3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/index.js\":\"bc7ac3cbe975bc94\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/referenceNode.js\":\"68b9e25fa1670b97\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/remark-reference-occurrences.js\":\"f2dedf47b32aba28\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e6ed6ca8b49c1e52\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/wikilinks/index.js\":\"913bdc3f36dfceec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8659c74d10d73739\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b6a2890b0af89ae7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/mergeRetargetProcessor.js\":\"6f33014520573f29\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/parseFence.js\":\"0dd92f0b8e084f7f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/referenceParser.js\":\"fe379e47724cbb0c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/referenceProjection.js\":\"bff4d81499e9343b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/referencesProcessor.js\":\"54b6ff836a79a3dc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/renameProcessor.js\":\"ee9badea706064a1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/spanReplacement.js\":\"ab6b3dceecd2030d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/rich-paste/htmlToOutline.js\":\"adae0142ef398a39\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/rich-paste/index.js\":\"36bab17783ce9391\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/rich-paste/normalizeClipboardDom.js\":\"44ad4c0192e77dce\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/rich-paste/pasteDecision.js\":\"5b8b1ea7da946b0c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/action.js\":\"9692e57095e0e305\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/blockIds.js\":\"a01e1dd337b498b0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/content.js\":\"c0ef4490d5811dc9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/effect.js\":\"f4dfdacd5d5259f1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/ids.js\":\"f5f9b26b5527e17c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/import.js\":\"b9228b1b8aeeda03\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/index.js\":\"1e84074e5273d0e0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/plan.js\":\"a8f1dc0206f3b5a5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/plugin.js\":\"488fa395aaa7b971\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/promotion.js\":\"69df39e8e35c867f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/properties.js\":\"51c76f078b093a53\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/references.js\":\"557acdf6acda3c3e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/report.js\":\"f015e6db48f92791\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/roamMemo.js\":\"de885dde9d0884f3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/runtime.js\":\"c95931befccc1ae9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/schemaReconciliation.js\":\"1cdad57006ec0f1a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/srsMarkers.js\":\"7b9f2b1262d3406e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/todo.js\":\"358a73117f956d36\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/typeCandidates.js\":\"91466ded3b4f093a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/types.js\":\"1eb2f15663bbcf7b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/search-health/index.js\":\"f6f300a486c9635c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/search-health/store.js\":\"f24c649a53e12542\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/HeaderItem.js\":\"91939c09f64f5618\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"228323c74c1b0608\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/index.js\":\"2bae848230d5045d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/model.js\":\"90dc32cf4366d050\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/toggleStore.js\":\"b34ba0cbcd7deaad\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/useKeyInspector.js\":\"49ab16367b624875\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"fd4d525b9b48bafb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/ShellDecorator.js\":\"f0394330d3588b3f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/actions.js\":\"3a0061ac36f95ca4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/exclusionsFacet.js\":\"1096b52d54768062\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/index.js\":\"6a489573d5f6da68\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/shell.js\":\"721c6e972b3876a4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/surface.js\":\"0b7eee4ec9d83fda\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/walker.js\":\"2802f710357ea8ec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7ee2bbf5dbf74033\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/dataExtension.js\":\"5856afb443c49ba2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/index.js\":\"714a41d0f97eee35\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/indicator.js\":\"b8eafd638dd83fb7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/moveSrsState.js\":\"ce0258316611547d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"24f11e859b3bff4d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/scheduler.js\":\"834c459d3fc799b4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/schema.js\":\"ee2217ff972512de\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4dceaa10c4d499cd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/srsClipboard.js\":\"1bb9693377a9110c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"695c83c85d7b9f9f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4c72a2c1e77fd1cc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/DeckPicker.js\":\"ef089620081715dd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/ReviewControls.js\":\"9d3ac5d2a00db473\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/ReviewDeckRenderer.js\":\"13f1b2efd419f5e0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/ReviewSession.js\":\"9f988572c1357348\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/actions.js\":\"aa546fdf900fc9cc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/archive.js\":\"2a484f810602230e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/dataExtension.js\":\"113e69d96b65bfdb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/deck.js\":\"8f5372c4633ef2ee\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/dueQuery.js\":\"e98504353189f70c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/gradeDecision.js\":\"9c671b0e8bd7e668\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/index.js\":\"c0b63fc35ffa5c4f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/keyHints.js\":\"9be37f10c6662258\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/reviewCardLayout.js\":\"68bde28fcdcacbc2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/reviewProgress.js\":\"188f204ae6bfab2a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/schema.js\":\"4b2dae02acbb2683\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/useDueCards.js\":\"22dc601d786d7bd0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/startup-metrics/index.js\":\"8e4fddf0a6475908\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/startup-metrics/record.js\":\"04a5fc7b0c500ad3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/storage-persistence/index.js\":\"2e5956cc24d4a525\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/storage-persistence/persistenceStatus.js\":\"ecf74c2ecb6df1e5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/storage-persistence/requestAction.js\":\"29e90da0128d34d5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/supertags/TypeChipsDecorator.js\":\"59118fa76931893d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/supertags/codeMirrorExtensions.js\":\"b9d10c9489b3ffcc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/supertags/index.js\":\"084e96cabb62401e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/supertags/typeAutocomplete.js\":\"b60a75f9d027663f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1e908f3c97dca355\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/actions.js\":\"39e4f83955cefcb0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/anchor.js\":\"6de65c05edad310b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/events.js\":\"c07138f4786ffa8a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/gestureActions.js\":\"8a5c89ce64b1c066\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/index.js\":\"e2ca472780aff5eb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f49a23c4c37e2a54\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/sync-metrics/collect.js\":\"718aeb121afe6384\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/sync-metrics/index.js\":\"b5a17ea7fba5ece3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/sync-metrics/record.js\":\"7a35db5a5ea2336b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/RejectionDialog.js\":\"9bf60b608541113b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/SystemStatusHeaderItem.js\":\"014c356de5a96144\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/index.js\":\"efb47fdfeb16d40f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/model.js\":\"cb282b730ca75dec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/queueCounts.js\":\"14c1ab00da0284de\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/rejectedHelpers.js\":\"5d42c4ed9f909a1a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/rematerializeAction.js\":\"fa62ffdaa4eb8234\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/useHysteresis.js\":\"66960c68110fa154\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/ColumnHeaders.js\":\"4a6aba7072b3ef2f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/QueryUi.js\":\"eb53006654a78831\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/TableLayout.js\":\"a1144dbdb089cfb7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/actions.js\":\"665df9a1b7851632\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/cellEdits.js\":\"0ec2f52a23c24193\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/columns.js\":\"92cc3d5e9e38c098\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/controller.js\":\"22535580243136f7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/convert.js\":\"55d051009d064f5c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/dataExtension.js\":\"8b001814474cb837\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/index.js\":\"e2298b3d11d2e27e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/keys.js\":\"1af7e97055cd7ba0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/model.js\":\"f443540728a2fe6f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/backfill.js\":\"9ce10de861746a22\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/format.js\":\"4126b5de3a16e33b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/parse.js\":\"483009b95d137f0b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/queryValue.js\":\"d146a30a9ededc1a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/source.js\":\"3de4b6cf7e0b8b03\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/registry.js\":\"ffde7ce4554b6796\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/schema.js\":\"084904e9ff8d2cc9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/sort.js\":\"24b56a4666069db1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/theme-toggle/effect.js\":\"c2dfeaa74f9e4ded\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/theme-toggle/index.js\":\"43115cf090fba4db\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/theme-toggle/theme.js\":\"a59d510676a6ae4b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/todo/actions.js\":\"c655612849ada017\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/todo/dataExtension.js\":\"2c96aeb2765bbd1b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/todo/index.js\":\"1fce1f0ddbe15a28\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/todo/schema.js\":\"c1d3282c027eb4ae\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e0f1657ae8bce5fe\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/actions.js\":\"f9a271d89bbc3b8c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/defaultItems.js\":\"d2cc29c31c6e36df\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/facet.js\":\"e6e61922859c520a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/holdRecognizer.js\":\"e90feb57f42f048e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/index.js\":\"ac65cfb7b2539e8f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/update-indicator/UpdateIndicator.js\":\"4b333dc7c0559d99\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/update-indicator/index.js\":\"8ecbcea8b212cb05\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/update-indicator/loadTimes.js\":\"f340cd7368f8841e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/VideoNotesRenderer.js\":\"a2056dfbe63db52a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/VideoPlayerRenderer.js\":\"ff1e556b6ebc95de\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/VideoTimeStamp.js\":\"9a1d9b257a82d7a9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/actions.js\":\"d41498d9347dd806\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/index.js\":\"a39a5bcf33e7bd05\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/markdown.js\":\"096122433be4d4b5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/notes.js\":\"53ecde720b6d48e6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/registry.js\":\"db876eab7e8d44ef\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/remark-timestamps.js\":\"27b99bb35551fde3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/view.js\":\"c5f417bbb74852c9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-link-hints/LinkHints.js\":\"3aef49270c43852d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-link-hints/index.js\":\"e63aac002a36dbf7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-link-hints/model.js\":\"b2b77ae8784572d6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-link-hints/settings.js\":\"1c6fe2ab2dde4c88\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-normal-mode/actions.js\":\"4ac7d9dd470bcaa1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-normal-mode/index.js\":\"447a4d3862aa9bc4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-normal-mode/interactions.js\":\"c77d095814898da8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/workspace-header/index.js\":\"92b46431545b577b\",\"/knowledge-medium/pr-preview/pr-1845/src/registerServiceWorker.js\":\"02c7362cef173684\",\"/knowledge-medium/pr-preview/pr-1845/src/requestPersistentStorage.js\":\"3b4ba097f04ba62d\",\"/knowledge-medium/pr-preview/pr-1845/src/services/authRequestDeadline.js\":\"99c581173174c710\",\"/knowledge-medium/pr-preview/pr-1845/src/services/authStorage.js\":\"33192ae5b6dddeb1\",\"/knowledge-medium/pr-preview/pr-1845/src/services/powersync.js\":\"ddb8e06364949241\",\"/knowledge-medium/pr-preview/pr-1845/src/services/supabase.js\":\"747109ac75178737\",\"/knowledge-medium/pr-preview/pr-1845/src/services/uploadErrorClassifier.js\":\"784248e18930ae83\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/ActiveContexts.js\":\"0a6282cebbd6ddb1\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/HotkeyReconciler.js\":\"83d7a65795fde227\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/WipeLocalDataDialog.js\":\"88c522d601930cca\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/actionDispatch.js\":\"608ecb3360fff451\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/actionRefItems.js\":\"b558e217704c4318\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/applyKeybindingOverrides.js\":\"abe2f2ad29bee8d4\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/blockActions.js\":\"037e68dcf6f75950\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/canonicalizeChord.js\":\"1eda6f876a959f23\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/defaultContexts.js\":\"dbbe88460e72b70f\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/defaultShortcuts.js\":\"65d3955e6d0bc41c\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/effectiveActions.js\":\"f08490cecf19494d\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/gestureAction.js\":\"674ae4ead469a614\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/gestureBinding.js\":\"f8bf80f3997b6a79\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/holdRegistry.js\":\"6a6d699412985992\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/keybindingConflicts.js\":\"5147074142e453ea\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/keybindingOverrides.js\":\"6e1ceb7a64ad029b\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/pointerAction.js\":\"922c7de2cc21bb53\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/resolve.js\":\"de91f5d0382bb4e2\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/runAction.js\":\"75415c09521e450a\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/sequenceMatcher.js\":\"b8d07bd2efba72a0\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/types.js\":\"16d941a358d77e3e\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/useActionContext.js\":\"af17ded8c620dd0e\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/useActionDiscovery.js\":\"0bfbb2b5f7070e53\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/utils.js\":\"77471f6fce4461cd\",\"/knowledge-medium/pr-preview/pr-1845/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1845/src/sw/bootStore.js\":\"c1a0ce25fd30848c\",\"/knowledge-medium/pr-preview/pr-1845/src/sw/previewDatabases.js\":\"aac9bc85522f2ad4\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/byteTransform.js\":\"1010976e1a71782c\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/attachmentCleaner.js\":\"c6bda6f372c2321d\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/attachmentParts.js\":\"bd2ecf973b37cd63\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/bundleParts.js\":\"0e84bf603fb90862\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/bundleRecord.js\":\"9887f2fd3d607090\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/manifest.js\":\"c62d7b2d1ccaa141\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/takeBundle.js\":\"0d1052922f760743\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/verifyBundle.js\":\"edf283f2bf7abd16\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/cleaningStage.js\":\"87622b33949ed00f\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/conversionKey.js\":\"d2ae1dbd39328017\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/conversionServer.js\":\"8202ae9bc82867d6\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/flip.js\":\"e4c7f0db3811b3d4\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/flipAttempts.js\":\"d0894a1309595309\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/pages.js\":\"e1d10ad723ea7991\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/preflight.js\":\"42e00ade6360c2d6\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/reseal.js\":\"f20f1446d2ae9299\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/runConversion.js\":\"202dc3a8f43e237e\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/runLock.js\":\"062b02b534fb86b3\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/sealing.js\":\"0e282b15174ed2e4\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/sealingStage.js\":\"f70b1d08884f3e37\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/stage.js\":\"6b949afcce362936\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/verifyReseal.js\":\"019673341a1061e6\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/aad.js\":\"8378242c005620ec\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/aead.js\":\"e1fde73762e9db4b\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/base32.js\":\"944cbb3a4c266a10\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/base64url.js\":\"5382fd887bcf45ab\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/binaryEnvelope.js\":\"17f813ba94ec7257\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/byteAead.js\":\"20733dcc5cd362b6\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/canary.js\":\"e464d8b8c223bef3\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/contentHash.js\":\"9d6a7cedd7379906\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/contentKey.js\":\"83fec3369ef9d19c\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/derivedIdNamespace.js\":\"cc1bfbde9b7cf5ae\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/envelope.js\":\"58efcd4adb92de98\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/hex.js\":\"826c2f82a5d282b8\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/sha256Hex.js\":\"aee7a794db409f67\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/workspaceKey.js\":\"56487a2c82c5c113\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/conversionState.js\":\"1d2ba10df47e8cdb\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/flows/createEncryptedWorkspace.js\":\"84a2f6a05406b314\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/flows/pastedKey.js\":\"5209bc4ba3fd938d\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"00a6c78060b96b55\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7e24d040a1c1175b\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/keyStore.js\":\"dbecf3417a738830\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/mintWorkspaceKey.js\":\"7d9c25f8fdaf885e\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/modePin.js\":\"881604073a08f99a\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/openWorkspaceKeys.js\":\"22e190a36bffe799\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/resolveWorkspaceEntry.js\":\"e77cf722f6d7ba8c\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/resolver.js\":\"43594e69e2ccae78\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/workspaceAccess.js\":\"08fd16cc82c35bfc\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/transform.js\":\"459ee3796f9f22af\",\"/knowledge-medium/pr-preview/pr-1845/src/themeBootDefaults.js\":\"593f3ac51d1f1397\",\"/knowledge-medium/pr-preview/pr-1845/src/types.js\":\"a161282a6f6bedc9\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/ClientLocalSettings.js\":\"2a9df022dd7decb1\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/abortableSleep.js\":\"0c4ab4f15b2f9500\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/array.js\":\"9926f741dc1e0699\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/backlinkAutocomplete.js\":\"bd581f8cfc20a078\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/blockCrumbs.js\":\"c17b230cdfdd4c72\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/blockrefAutocomplete.js\":\"66b4b6fa648ae4cd\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/cadencedIdleJob.js\":\"2f7e6fc7eb5a596c\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/callbackSet.js\":\"621362271496b0c8\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/clientId.js\":\"4bf2d0dae9627539\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/codemirror.js\":\"9ac7e6cefa684f80\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/codemirrorCompletion.js\":\"abcc99337fec0480\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/copy.js\":\"52da53e54774ff29\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dailyPage.js\":\"8eab571781bc61ac\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dbForensics.js\":\"e88ac78917087b03\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dbForensicsHooks.js\":\"07e0c9eb0f45295a\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/deleteBlockThroughUi.js\":\"368ef2bada4f7210\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dialogs.js\":\"449fcbe12017209d\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dom.js\":\"217b8e6273df4ba8\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/downloadBlob.js\":\"2c417024f9ee172b\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/exportSqliteDb.js\":\"bd4cf95f03fb0d69\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/fileSystemAccess.js\":\"3b501ac506cfd924\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/flipSlide.js\":\"697dc978bf3bbb45\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/fnv1a.js\":\"6e5f997c025ac805\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/formatBytes.js\":\"3b056fb64d833d89\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/fuzzyRank.js\":\"65ea9edf588514ea\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/idbKeyedStore.js\":\"79c9f3c94592a378\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/idleCallbackPolyfill.js\":\"b16d898beda75b04\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/keyboardAwareScroll.js\":\"dd3e70a7ac8096ef\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/keyboardViewport.js\":\"c9a3d345e6e0e48e\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/lastWorkspace.js\":\"0820da3bdbadd426\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/layoutColumns.js\":\"70c3ea09f1381e89\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/layoutSessionDom.js\":\"5fd166de9c276693\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/layoutSessionId.js\":\"56d4fff77e2abff8\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/linkClickGestures.js\":\"647f49d2d231786c\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/linkTargetAutocomplete.js\":\"3c0b15ea2383bac8\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/localDbCorruption.js\":\"8b9d2400b35ebaf0\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/localDbRecovery.js\":\"104a0275eb453ad2\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/markdownParser.js\":\"b4f7927fb6cfec7f\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/memoize.js\":\"cccc722bfd1ad1bf\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/nameFieldCommit.js\":\"8fe0d9609e367f0d\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/nameList.js\":\"0ed28511d6050210\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/navigation.js\":\"48f4ece08b40d584\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/omnilinerNamespace.js\":\"2ddcad5efba054f5\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/opfsPageScan.js\":\"7751f658f17d2cdd\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelClearance.js\":\"d68d41264fb39fb4\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelHistory.js\":\"24a29ba74895ef4a\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelLanes.js\":\"5326be2850184959\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelLayoutProjection.js\":\"c467a69e89a4d009\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelScrollAnchor.js\":\"69a2cefad8770c18\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelUrlFlags.js\":\"a9b7151011b2569e\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/platform.js\":\"a4bdc89a20906f1d\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/pluralize.js\":\"abb405aeca794cf2\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/propertyCreation.js\":\"42f4fd16c265f980\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/propertyNavigation.js\":\"590f3c480f48f749\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/propertyValueContext.js\":\"1c7574eeb2f1b951\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/react.js\":\"7c80a180156ff47a\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/relativeDate.js\":\"ca9bb00d221a21d0\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/relativeTime.js\":\"9c5e7910fd899776\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/renderScope.js\":\"0de83224bf9dbe04\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/resolvedThenable.js\":\"312cb22d491e24ae\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/routing.js\":\"141c693551634862\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/safeMode.js\":\"85b544bcbf92917b\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/scheduleIdle.js\":\"e89939f9ccbc3965\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/screenWakeLock.js\":\"2870b9c321b97267\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/selection.js\":\"5339221491e39192\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/softKeyboardGrab.js\":\"f26f2b3f83613d3e\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/startupTimeline.js\":\"61967ab540951bc9\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/state.js\":\"48b5ed626c823c57\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/string.js\":\"14c62cc5eaa538ec\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/surfaceZoom.js\":\"f38445052aae6023\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/time.js\":\"f2ca06d0c6af7719\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/toast.js\":\"026b02f0d1935beb\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/toggleStore.js\":\"72cec5017e500b53\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/untilStopped.js\":\"26dc9d6a66dfbb51\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/userActivity.js\":\"777a04c34e0cd22d\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/viewTransition.js\":\"adf67038a308cd88\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/viewport.js\":\"6caa1e594de3f12a\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/webLock.js\":\"8b3e1258f93f72c8\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/workspaceRecovery.js\":\"14b76a07fd7e5c0e\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/workspaceSnapshotStore.js\":\"950bdb13727d9fd3\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-compiler-runtime.js\":\"a622598fefa8d272\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-client.js\":\"ef35afa94849f192\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-server-edge.js\":\"c004dcf2f53ebb1e\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-server.js\":\"bccc5ca47b6b863a\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-static-edge.js\":\"632a27616ce83fca\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-static.js\":\"5caaaf01b6bff2a1\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-test-utils.js\":\"63cc336da5667da7\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom.js\":\"a3628f28704bee97\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-jsx-runtime.js\":\"3e976a2b762a8a37\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react.js\":\"0765c4d7d6b84d6a\",\"/knowledge-medium/pr-preview/pr-1845/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1845/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1845/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
