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
		buildId: "2f0881785ca0-ddb391d4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1845/\":\"0d51e6008b0167ad\",\"/knowledge-medium/pr-preview/pr-1845/index.html\":\"0d51e6008b0167ad\",\"/knowledge-medium/pr-preview/pr-1845/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1845/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1845/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1845/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1845/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1845/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1845/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1845/assets/FacadeVFS-CzfVQ-se.js\":\"2125984befe3bad2\",\"/knowledge-medium/pr-preview/pr-1845/assets/OPFSCoopSyncVFS-PvCFhg2H.js\":\"edf88a7835fa86fc\",\"/knowledge-medium/pr-preview/pr-1845/assets/OPFSWriteAheadVFS-DT4GOUq7.js\":\"798196912a3647f3\",\"/knowledge-medium/pr-preview/pr-1845/assets/wa-sqlite-C7zzrpeW.js\":\"a81cfb47f2457cea\",\"/knowledge-medium/pr-preview/pr-1845/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1845/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1845/assets/wa-sqlite-async-DRAqzW2h.js\":\"cf147649b3c8f835\",\"/knowledge-medium/pr-preview/pr-1845/assets/worker-DoFojmx7.js\":\"513ed34765c08c0a\",\"/knowledge-medium/pr-preview/pr-1845/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1845/chunks/app-m-Ucc5LI.js\":\"c66758bd6c4c4e63\",\"/knowledge-medium/pr-preview/pr-1845/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1845/index.js\":\"e61291db2e5f854d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1845/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1845/assets/AccessHandlePoolVFS-iD1AvQ16.js\":\"63fae4f97148b67c\",\"/knowledge-medium/pr-preview/pr-1845/assets/IDBBatchAtomicVFS-ClGhFF5W.js\":\"e6e8689afd304fa3\",\"/knowledge-medium/pr-preview/pr-1845/assets/MemoryVFS-DKj9B5LP.js\":\"7d592b5a2d236c35\",\"/knowledge-medium/pr-preview/pr-1845/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1845/assets/mc-wa-sqlite-SeAzxWao.js\":\"db052c61e6c28b52\",\"/knowledge-medium/pr-preview/pr-1845/assets/mc-wa-sqlite-async-CCNHIc_x.js\":\"39f8b3d285608f4b\",\"/knowledge-medium/pr-preview/pr-1845/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1845/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1845/chunks/AccessHandlePoolVFS-3y2lJCib.js\":\"38830749a17dd520\",\"/knowledge-medium/pr-preview/pr-1845/chunks/FacadeVFS-DbLHiJmx.js\":\"e09ce2c278f64ac7\",\"/knowledge-medium/pr-preview/pr-1845/chunks/IDBBatchAtomicVFS-Cw5lmRYB.js\":\"1e2499dd93b4d30d\",\"/knowledge-medium/pr-preview/pr-1845/chunks/MemoryVFS-prB58BcS.js\":\"97d9660d32cfbab3\",\"/knowledge-medium/pr-preview/pr-1845/chunks/OPFSCoopSyncVFS-hO4SCc_l.js\":\"c69a693fbd541580\",\"/knowledge-medium/pr-preview/pr-1845/chunks/OPFSWriteAheadVFS-B7omFyfp.js\":\"f8317acf2edf72b8\",\"/knowledge-medium/pr-preview/pr-1845/chunks/Preview-rg4gPpEu.js\":\"1f577eaa68ab8dbf\",\"/knowledge-medium/pr-preview/pr-1845/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1845/chunks/card-DHtaPtS2.js\":\"372af46cd56e341c\",\"/knowledge-medium/pr-preview/pr-1845/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1845/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1845/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1845/chunks/dist-CVq-FWNS.js\":\"15a8140f53ec3b56\",\"/knowledge-medium/pr-preview/pr-1845/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1845/chunks/mc-wa-sqlite-CTomSnyV.js\":\"5dc9bcf8de78d92f\",\"/knowledge-medium/pr-preview/pr-1845/chunks/mc-wa-sqlite-async-m8BOSOSo.js\":\"fe4832d2ff7052d8\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-BNd5Tlec.js\":\"5e87c8491c2a34a4\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-BVe63CtJ.js\":\"58a679f33ba42323\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-Ca_GnKVB.js\":\"1583db5a611f1d6e\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-DMpz-hsq.js\":\"2c2f8c9258ad4e09\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-DOLSyB71.js\":\"ccbd827cf7b18840\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-DzXj1p0L.js\":\"97c310116d08477a\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-Gndke096.js\":\"2d9403318e29edd1\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-dom-server-legacy.browser.production-DriMvXso.js\":\"a8702029c2bd4a3f\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-dom-server.browser.production-cZL6gsml.js\":\"d0b4c00dff97e6a2\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-dom-server.edge.production-OscrKI5u.js\":\"71629eafb9235d3e\",\"/knowledge-medium/pr-preview/pr-1845/chunks/react-tfFboO2y.js\":\"82e10db871ab5024\",\"/knowledge-medium/pr-preview/pr-1845/chunks/server.browser-C00zwVu0.js\":\"9c7059566e968050\",\"/knowledge-medium/pr-preview/pr-1845/chunks/textarea-BpzA9r-c.js\":\"3b19e7e144a4d59d\",\"/knowledge-medium/pr-preview/pr-1845/chunks/ui-Baqf4aGF.js\":\"4a0943ac1becfadc\",\"/knowledge-medium/pr-preview/pr-1845/chunks/wa-sqlite-DleHxBtE.js\":\"b90ed629f58b3252\",\"/knowledge-medium/pr-preview/pr-1845/chunks/wa-sqlite-async-BbqEtlHh.js\":\"5f6fb826a74d80e7\",\"/knowledge-medium/pr-preview/pr-1845/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1845/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1845/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1845/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1845/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1845/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1845/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1845/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1845/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1845/src/App.js\":\"f661148df46110a8\",\"/knowledge-medium/pr-preview/pr-1845/src/appUpdate.js\":\"3f1f868d9d2e420b\",\"/knowledge-medium/pr-preview/pr-1845/src/appVersion.js\":\"9e21b1258317423d\",\"/knowledge-medium/pr-preview/pr-1845/src/bootstrap/initialLayout.js\":\"932dd03946185193\",\"/knowledge-medium/pr-preview/pr-1845/src/bootstrap/openWorkspaceData.js\":\"28a4808444609bb2\",\"/knowledge-medium/pr-preview/pr-1845/src/bootstrap/resolveWorkspace.js\":\"bb96aae994c8207d\",\"/knowledge-medium/pr-preview/pr-1845/src/bootstrap/workspaceBootstrap.js\":\"76156668f40b60eb\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockComponent.js\":\"cd9b0538a1f92050\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockCrumbs.js\":\"4ea76600c5962f5a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockEditor.js\":\"5001549cf6afc744\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockLoadingPlaceholder.js\":\"9ec0f0ca30d8401a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockProperties.js\":\"a352dc2ec0d67e71\",\"/knowledge-medium/pr-preview/pr-1845/src/components/BlockSearchPicker.js\":\"b893d1be9435ae06\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ConfirmBulkDeleteDialog.js\":\"5cb059c1437c3d70\",\"/knowledge-medium/pr-preview/pr-1845/src/components/DividerHandle.js\":\"25d07b186918206e\",\"/knowledge-medium/pr-preview/pr-1845/src/components/DraftEditor.js\":\"b05a00fd036cfaaf\",\"/knowledge-medium/pr-preview/pr-1845/src/components/GutterPill.js\":\"e77bb741218ee982\",\"/knowledge-medium/pr-preview/pr-1845/src/components/Header.js\":\"c0582ff2d3906981\",\"/knowledge-medium/pr-preview/pr-1845/src/components/LazyBlockComponent.js\":\"f486157b73a603bf\",\"/knowledge-medium/pr-preview/pr-1845/src/components/Login.js\":\"f269959472dcc46a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ZoomableSurface.js\":\"f26add1a73932048\",\"/knowledge-medium/pr-preview/pr-1845/src/components/editModeKeepalive.js\":\"c61513c64ae4cdc1\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3271c7a48ed9cc95\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2a81688dcf0ad660\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/RefPropertyEditor.js\":\"044feda85a2b95e4\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/RefTargetTypePicker.js\":\"dba40df6c49ed18d\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/SelectPropertyEditor.js\":\"509620f9a43737f6\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/TypesPropertyEditor.js\":\"091b144e4ebab42b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/defaults.js\":\"d0e7acc1e05ec1aa\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/kernelValuePresets.js\":\"692ba9c36b879d79\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/selectablePresets.js\":\"77e4a1876286d67b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyEditors/typesPropertyUi.js\":\"88958ecec40317dc\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/AddPropertyForm.js\":\"4d4c23ebcfe6596a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/PropertyPicker.js\":\"92d880b5ca2fa834\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/PropertyRow.js\":\"ae0bcc83506574e8\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/Rows.js\":\"f784f9e444f1e6ee\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/actions.js\":\"d5f62ff95f9f075d\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/declarationOnly.js\":\"76dd66aee4726a3b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/layout.js\":\"3201e3e123d19a9a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/model.js\":\"7b7baaa9e203ff74\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/shapeUi.js\":\"9deb0a9b63ac8df9\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/shapes.js\":\"019fef8d0e4261a4\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a03f1ccb5d36e080\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanel/visibility.js\":\"0fcacea4f2a1e406\",\"/knowledge-medium/pr-preview/pr-1845/src/components/propertyPanelSections.js\":\"377f58ebe3a5db34\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/BlockEmbed.js\":\"655a42e173dfbaa6\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/BlockLink.js\":\"e2739183a14af470\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/BlockRef.js\":\"d49aab9d03f70170\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/ReferenceLink.js\":\"0fd33a0e144db997\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/cycleGuard.js\":\"30648b0e499c7bf7\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/cycleGuardContext.js\":\"90ac5328964bafca\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/linkInteraction.js\":\"b03342c18bd25efa\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/referenceLayout.js\":\"2a22d76863550ea7\",\"/knowledge-medium/pr-preview/pr-1845/src/components/references/useBlockRefAncestors.js\":\"7f2842191ffcc316\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/BlockGutter.js\":\"e290f4b453e76341\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/BlockInfoDialog.js\":\"03d0359ff3672c31\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/BlockTypeBlockRenderer.js\":\"fce471208513e66c\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/BulletHoverCard.js\":\"7878f2d5ec76cf71\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/CodeMirrorContentRenderer.js\":\"d99539ca60c65bed\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b200d90caee0fcbb\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/ColumnResizeHandles.js\":\"9f6809ceaef7e0df\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"6c1436e8423eb548\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/DefaultBlockRenderer.js\":\"f6601471d93fb87b\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/LayoutRenderer.js\":\"383953a2ee95442a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/MarkdownContentRenderer.js\":\"b57918af8992735f\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/MissingDataRenderer.js\":\"2a7b8fc6e4c0fce9\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/PanelRenderer.js\":\"81ab3785d33c55e7\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6f11de4631c748f1\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/TopLevelRenderer.js\":\"669c0cbeffe8d458\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/blockGutterMode.js\":\"a515142b4d19d077\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/blockTitleText.js\":\"a0e88f6f430a2ed2\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/fieldCreationKeydown.js\":\"db6d83fc6cfa8882\",\"/knowledge-medium/pr-preview/pr-1845/src/components/renderer/layoutRootContext.js\":\"867a200c27297c6a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/typeChip/TypeChip.js\":\"03b7b14e88c96a83\",\"/knowledge-medium/pr-preview/pr-1845/src/components/typeChip/chipStyle.js\":\"049f7931ffbebf3d\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/anchored-floating.js\":\"a531af4e3dbfd498\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/button.js\":\"ff4b13a7205ee6f1\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/card.js\":\"deba2b121c6169c2\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/checkbox.js\":\"c437077fa2b45fc0\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/collapsible.js\":\"ffc49b1180673955\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/command.js\":\"e2889fc2f98866fc\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/context-menu.js\":\"c63cc5c76d81edac\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/dialog.js\":\"c216c3bebf40c478\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/dropdown-menu.js\":\"d16f42ff161df0fb\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/floating-listbox.js\":\"9031c1d4ec72de52\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/index.js\":\"979cece11bd502e3\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/input.js\":\"fef741f61c95b31a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/kbd.js\":\"be336453fc7f7929\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/label.js\":\"a86b39d3b0054cba\",\"/knowledge-medium/pr-preview/pr-1845/src/components/ui/textarea.js\":\"f2a009d6332186f5\",\"/knowledge-medium/pr-preview/pr-1845/src/components/useEditModeYieldKeepalive.js\":\"a6f569a32f176667\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/BootFallback.js\":\"4ee8dd8249c09fba\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/FocusedRowLazyMount.js\":\"4d9b5167d8f21e7d\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/LazyViewportMount.js\":\"435eb1af6ebd955c\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/LocalDbCorruptionFallback.js\":\"1b45b050faa2b448\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/error.js\":\"01a17821d95ddb77\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/lazyMountRegistry.js\":\"779586d364a8d265\",\"/knowledge-medium/pr-preview/pr-1845/src/components/util/suspense.js\":\"23a1eb6c610ca750\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/CreateWorkspaceDialog.js\":\"8b1300356f86906f\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/PendingInvitations.js\":\"62f1f7679c5bf51e\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/SyncProgress.js\":\"2950bf38a901cca8\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/UnlockProgress.js\":\"90e2cf52f62cc751\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/WorkspaceKeyGate.js\":\"a859b5ea1bfc4576\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/WorkspaceSettingsDialog.js\":\"3cd0e4143d68e98a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/WorkspaceSwitcher.js\":\"08bac0cb103cb414\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/WorkspaceSyncGate.js\":\"e384bfb8f49ef143\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/ConversionFlow.js\":\"9fd8f976c1539d67\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/ConversionFlowHost.js\":\"f48a5d681ab86788\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/EncryptionSection.js\":\"fb20f98d4c6b606a\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/attachmentPrompts.js\":\"89478d9609ecb76c\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8a84c185a9133a9d\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/conversionFlowDeps.js\":\"66f56986c3bf4fcc\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/conversionFlowStore.js\":\"efc20c9db7575daa\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/flowUi.js\":\"8217736d30cbe8c5\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/conversion/useConversionRun.js\":\"1350850573a695f3\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/keyUi.js\":\"0ecc5d7e9cc69b82\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/useCloseOnKeyLoss.js\":\"4c6f8952eb2d4090\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/useCloseOnServerE2ee.js\":\"e8dc60e8107cf229\",\"/knowledge-medium/pr-preview/pr-1845/src/components/workspace/workspaceUnlocked.js\":\"9e4a8a084e6f11db\",\"/knowledge-medium/pr-preview/pr-1845/src/context/backgroundSubtree.js\":\"fffbf5b129ba0b2e\",\"/knowledge-medium/pr-preview/pr-1845/src/context/block.js\":\"9582b31435e0a23f\",\"/knowledge-medium/pr-preview/pr-1845/src/context/layoutWsContext.js\":\"2e3b6166489c4ed1\",\"/knowledge-medium/pr-preview/pr-1845/src/context/propertyDisplay.js\":\"582bdacbab9d3daa\",\"/knowledge-medium/pr-preview/pr-1845/src/context/repo.js\":\"61551010ccccfceb\",\"/knowledge-medium/pr-preview/pr-1845/src/data/aliasClaim.js\":\"93b41cd2d0260355\",\"/knowledge-medium/pr-preview/pr-1845/src/data/aliasSeatNamespace.js\":\"ba1e880d941818a8\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/blockData.js\":\"2a6390192168de47\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/blockType.js\":\"dec0caf02eac55de\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/changeScope.js\":\"a3d19c748d4d7a49\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/codecs.js\":\"fc74f383c5977164\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/derivedData.js\":\"acd8e266ea53f2e9\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/errors.js\":\"c4200d3b0fdf45a6\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/events.js\":\"c132112c2eba3f51\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/handle.js\":\"0801c54f168f2a8e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/index.js\":\"bc987f380b40f8f1\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/mutator.js\":\"9ed42bd21be76d1c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/processor.js\":\"05dd502c5583c0f1\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/propertySchema.js\":\"e64abcd24a857249\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/query.js\":\"b8992f44b48ba379\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/sameTxProcessor.js\":\"bfa2f37874a981fa\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/schema.js\":\"0801c54f168f2a8e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/tx.js\":\"0801c54f168f2a8e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/typedBlockQuery.js\":\"29d863a83de48dfa\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/user.js\":\"ad869ecc36dd848a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/valuePresetCore.js\":\"8dc1591e8192dea0\",\"/knowledge-medium/pr-preview/pr-1845/src/data/api/valuePresets.js\":\"bcf584a6ef688f94\",\"/knowledge-medium/pr-preview/pr-1845/src/data/attachmentCleanerIOVerb.js\":\"691e49e797038b78\",\"/knowledge-medium/pr-preview/pr-1845/src/data/block.js\":\"1043ff40ba580547\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockCache.js\":\"b4044c1ea2882218\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockId.js\":\"58a563ce0184b067\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockLiveness.js\":\"6510aa42d6b7b075\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockMerge.js\":\"a4ee587d7257832a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockSchema.js\":\"dec7c5ad3496dbdc\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockTypeLookup.js\":\"aa9f6887ba08dfd5\",\"/knowledge-medium/pr-preview/pr-1845/src/data/blockTypes.js\":\"6d9c5b7c37f4b3e3\",\"/knowledge-medium/pr-preview/pr-1845/src/data/clientContext.js\":\"dc44c697343e1ab2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/dbFileSiblings.js\":\"6a6610a53d826d83\",\"/knowledge-medium/pr-preview/pr-1845/src/data/definitionSeeds.js\":\"8193ed753e38b6e9\",\"/knowledge-medium/pr-preview/pr-1845/src/data/derivedIds.js\":\"b4c74f735fc08edc\",\"/knowledge-medium/pr-preview/pr-1845/src/data/drawnSubtree.js\":\"5faf39290c85cadf\",\"/knowledge-medium/pr-preview/pr-1845/src/data/facetBridge.js\":\"2e37eb944dd1240a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/facets.js\":\"cc01abf20f6c9514\",\"/knowledge-medium/pr-preview/pr-1845/src/data/globalState.js\":\"2b439fbca10666ac\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/aliasClaimRederiveProcessor.js\":\"b908e13f26a5dde2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/ancestorBatch.js\":\"09ec9e81485a61bc\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/blockTypeTypeifyProcessor.js\":\"3b44bbb9897064ae\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/clientSchema.js\":\"77a15c1368623382\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/commitPipeline.js\":\"6af6d44a313b56ff\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/devAssertions.js\":\"add0e554d82db710\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/firstSync.js\":\"b5d47651c070e62c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/freshInitialLoad.js\":\"1a62d43e561bebb0\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/graphBackfillClaim.js\":\"2b8e1da6e24c0831\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/handleStore.js\":\"10ad7422f0b1673d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/idleMarkerJobs.js\":\"1ce88dced3a80bad\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/initialDownload.js\":\"e73e6bd1e3c68512\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/initializeClientDatabase.js\":\"aec6b32691e9ff28\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/jsonCanonical.js\":\"2f4e8c84a456524b\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/kernelInvalidation.js\":\"1a3240f8466ca93d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/kernelProcessors.js\":\"edf92588becaf9f2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/kernelQueries.js\":\"17703a7dce17b812\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/mergeTypeMembershipProcessor.js\":\"7885bdea4aa97679\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/normalizeReferencesProcessor.js\":\"9e709a6db3c7d32a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/poolInstrumentation.js\":\"f5e418b685b8b32e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/processorRunner.js\":\"c8285fc461a389b2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyCellBackfill.js\":\"c5d9fbe9147dfb2e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyChildMint.js\":\"3aad7eebecfe9e31\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyChildrenProcessor.js\":\"b6cdfca804fb8686\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0388c1f5c7abcec7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyDefinitionSynthesis.js\":\"482000ff1434ffd5\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyKeyScan.js\":\"ff857d3a280276be\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertySchemaResolution.js\":\"4d9e2da87e516ac5\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/propertyValueEdits.js\":\"8e6bab459898363a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/raiseProtocol.js\":\"47d78b06ab8dabb2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/readBatch.js\":\"96b0bbe6d0ba87e1\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/refProjection.js\":\"4b280e1d48960a66\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/referenceTargetLookups.js\":\"c7d5252b31577cbe\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/referenceTargetProcessor.js\":\"24d02e0cb4e85308\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/replayMerge.js\":\"8405fc6538fe9d8f\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/sqlBinds.js\":\"5333ee7d3e46e2c4\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"69cdf5fdbe7ec706\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/arrivalProcessors.js\":\"8f40fcc0ce883714\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/invalidate.js\":\"33bedce235598fb0\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/materialize.js\":\"a6249ca00095e301\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/observer.js\":\"41b02a15127d4900\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/syncObserver/reconcile.js\":\"57b213ecf98091aa\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/timingMetrics.js\":\"675ddf5538a1a3d2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/treeQueries.js\":\"5cb2a9a2c6711274\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/txEngine.js\":\"b6c94d7e0d59dfdd\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/txSnapshots.js\":\"912c0072c20bcc7b\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/typedBlockQuery.js\":\"0b421c5a05203a23\",\"/knowledge-medium/pr-preview/pr-1845/src/data/internals/undoManager.js\":\"3669644daca99912\",\"/knowledge-medium/pr-preview/pr-1845/src/data/invalidation.js\":\"497ee5f5de3cda9a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/kernelDataExtension.js\":\"67853d4b8d800233\",\"/knowledge-medium/pr-preview/pr-1845/src/data/kernelPage.js\":\"93421b2e3bf04704\",\"/knowledge-medium/pr-preview/pr-1845/src/data/kernelValuePresetCores.js\":\"80260d2c6891f17e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/localDbCorruptionSignal.js\":\"c795e6e78faca69a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/localDbStorage.js\":\"2a03e697e6a10b66\",\"/knowledge-medium/pr-preview/pr-1845/src/data/localDbVfs.js\":\"6204173aeeeedb50\",\"/knowledge-medium/pr-preview/pr-1845/src/data/localSchema.js\":\"a5a238088c1f9af7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/maintenance.js\":\"f8c6912fa2f237a4\",\"/knowledge-medium/pr-preview/pr-1845/src/data/mergeProperties.js\":\"9d7ecf6470a44d7c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/metricsConsoleHook.js\":\"861a60ed4f590ea2\",\"/knowledge-medium/pr-preview/pr-1845/src/data/migrationsPage.js\":\"da63d130f40e8925\",\"/knowledge-medium/pr-preview/pr-1845/src/data/mutators.js\":\"51b7551dbe42ddc4\",\"/knowledge-medium/pr-preview/pr-1845/src/data/orderKey.js\":\"c65beb784f34fd20\",\"/knowledge-medium/pr-preview/pr-1845/src/data/orderKeyPlacement.js\":\"7045d21a98c15b35\",\"/knowledge-medium/pr-preview/pr-1845/src/data/outlineSurface.js\":\"4c4a7725ebb4e521\",\"/knowledge-medium/pr-preview/pr-1845/src/data/pendingEditorContent.js\":\"461b58dcbb54bfff\",\"/knowledge-medium/pr-preview/pr-1845/src/data/pendingUploadsSql.js\":\"89d535b5ca464784\",\"/knowledge-medium/pr-preview/pr-1845/src/data/pluginStateExtensions.js\":\"e2ad432aace6e041\",\"/knowledge-medium/pr-preview/pr-1845/src/data/powerSyncLogger.js\":\"6801b5c438671028\",\"/knowledge-medium/pr-preview/pr-1845/src/data/projectorRuntime.js\":\"d198c8384ae8df12\",\"/knowledge-medium/pr-preview/pr-1845/src/data/properties.js\":\"5909c4b6965c56da\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertiesPage.js\":\"29a352f6e85b87e4\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyChildren.js\":\"9dce37177c5c22b6\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyDefinitionFanout.js\":\"54ab6558776bf041\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyDefinitionMetadata.js\":\"8ef8d2e82a354f24\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyDefinitionRegistry.js\":\"5a9f60a66e907429\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyDisplayMode.js\":\"c76a33ea9280b6c8\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertyRowCreation.js\":\"bac161f3a2c87ae0\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertySchemaCreation.js\":\"624e99f3ccf671ad\",\"/knowledge-medium/pr-preview/pr-1845/src/data/propertySeeds.js\":\"3c89e1dbcf933f08\",\"/knowledge-medium/pr-preview/pr-1845/src/data/recentsPage.js\":\"9933a8f35c0cb9f7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/referenceBlock.js\":\"33e8e9cef6502a67\",\"/knowledge-medium/pr-preview/pr-1845/src/data/rejectedUploads.js\":\"982ef389ee6bb99a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/releasePowerSyncConnection.js\":\"380dde8f9a4dfe05\",\"/knowledge-medium/pr-preview/pr-1845/src/data/repo.js\":\"161ea5d3c3fe498e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/repoProvider.js\":\"6dd8f3b8f33b2f18\",\"/knowledge-medium/pr-preview/pr-1845/src/data/rowProperty.js\":\"f036029dd0cafa9d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/searchFilter.js\":\"01bd868d5ce63ba7\",\"/knowledge-medium/pr-preview/pr-1845/src/data/seedIdentityLedger.js\":\"1f0e3661682842f6\",\"/knowledge-medium/pr-preview/pr-1845/src/data/stateBlocks.js\":\"bb4b7d458291473c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/structuralEditPolicy.js\":\"f162446149f4a64c\",\"/knowledge-medium/pr-preview/pr-1845/src/data/subtreeDelete.js\":\"d6a51c8cd77cf969\",\"/knowledge-medium/pr-preview/pr-1845/src/data/syncStreamLock.js\":\"01171b9db6112ce3\",\"/knowledge-medium/pr-preview/pr-1845/src/data/syncedTableSqlRecognizer.js\":\"54591cbaa3fb1392\",\"/knowledge-medium/pr-preview/pr-1845/src/data/syncedTableWriteGuard.js\":\"736483d2f8ddac1e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/targets.js\":\"3a41515a61f20aa9\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeColors.js\":\"3e5be2dbf554c1f0\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeDefinitionMetadata.js\":\"cce2076faeef1c72\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeDefinitionRegistry.js\":\"7b6b87603c38d417\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeExtraction.js\":\"4962035153004953\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeInitialValues.js\":\"186c127832366b4d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typePropertyGroups.js\":\"24937dfa42c4c4a5\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeSeeds.js\":\"8c37d233d4ef01d5\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typeTagger.js\":\"2360a99ea10feef5\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typedRecords.js\":\"000634bcf6cb9490\",\"/knowledge-medium/pr-preview/pr-1845/src/data/typesPage.js\":\"b69b0cb1666ee80a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/userPrefs.js\":\"57e201f808e16083\",\"/knowledge-medium/pr-preview/pr-1845/src/data/userSchemasService.js\":\"0c08364488bb271d\",\"/knowledge-medium/pr-preview/pr-1845/src/data/userTypesService.js\":\"908aa10e2ca2054a\",\"/knowledge-medium/pr-preview/pr-1845/src/data/valuePresetRegistry.js\":\"3da1f67622e9469e\",\"/knowledge-medium/pr-preview/pr-1845/src/data/visibleChildren.js\":\"cd67a2b48c561675\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaceConversion.js\":\"53fa29ceb7678545\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaceFirstSync.js\":\"6080f4e8b8573bec\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaceIdNamespace.js\":\"dd640c0f1bff80a3\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaceSchema.js\":\"3c3d0a032f0f6fa3\",\"/knowledge-medium/pr-preview/pr-1845/src/data/workspaces.js\":\"ec61e4a4c3992098\",\"/knowledge-medium/pr-preview/pr-1845/src/data/writeAheadLog.js\":\"c61406fa0e60082b\",\"/knowledge-medium/pr-preview/pr-1845/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/BlockPasteShellDecorator.js\":\"909f050574d32628\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/atTrigger.js\":\"29a173baba709766\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/autocomplete.js\":\"7b2a96816a043448\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/codeMirrorExtensions.js\":\"d2b0a8974a7860c1\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/contentFlush.js\":\"dd8e0a09f679f8e5\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/defaultInteractions.js\":\"60da2f7ff4b2112b\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/editSettleSignal.js\":\"87307f66fc0cbd85\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/insertImage.js\":\"5bf56024d7332758\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/referenceCompletionRange.js\":\"4bae02c00302ac92\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/referenceTargetTypes.js\":\"2d368ec80cff8558\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/syntaxContext.js\":\"f49e02c72ace1b79\",\"/knowledge-medium/pr-preview/pr-1845/src/editor/triggerMatch.js\":\"def44b557f01784d\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/AppRuntimeProvider.js\":\"1d23445503cd9407\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/BlockFocusShellDecorator.js\":\"a171fa3c951aedeb\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/ExtensionRenderBoundary.js\":\"fa0e94132c48b84e\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/PanelContentRecovery.js\":\"4fa1ee212ccbe372\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/apiCatalog.js\":\"9e31733739cc5605\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/approveExtensionHere.js\":\"f91c988f94bb3677\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/armedCutAppMount.js\":\"be7a1f5f97f7cfb5\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/batchableKeyedStore.js\":\"e44bc4c5cc04b44f\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/blockInteraction.js\":\"21e2c0201e5a6b24\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/blockSelectionAction.js\":\"32c2805dd0326a62\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/compileExtensionModule.js\":\"9d393cc5745f6aa1\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/compiledModuleCache.js\":\"71021b345605566a\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/continuousGestures.js\":\"e5e972da850fd5ac\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/core.js\":\"56a451313d75a15f\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/defaultRenderers.js\":\"f5e37530e1b5d460\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/definitionFanoutAppMount.js\":\"4231cf7fa9beef17\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/dialogAppMount.js\":\"95a6884d2f540460\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/dynamicExtensionSeeds.js\":\"fd7601e589d8c4b6\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/dynamicExtensions.js\":\"a6b832ecd82fa452\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/exampleExtensions.js\":\"9f5861c6dde4bb0d\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionApprovalStatus.js\":\"77b95f65478314f1\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionLoadErrorToast.js\":\"52372210b4c46371\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionLoadErrors.js\":\"fb03f8a45db17888\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionLookup.js\":\"ad33e0ff63056a90\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionToggles.js\":\"47511b759f65836b\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/extensionUtilitiesCss.js\":\"1773ff6a1a686a6e\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/kernelPageDeletionGuard.js\":\"84b6a29161573340\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/liveRuntime.js\":\"d29f55d6a5e78a5d\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/openExtensionsSettings.js\":\"1b2a8d183cb506ef\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/overridesCache.js\":\"13ea3f5f9beeb2ed\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/pluginIds.js\":\"10026119a12caba7\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/processorRejectionToast.js\":\"30ba43a89a87948b\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/runtimeActions.js\":\"b26edbceba6473d0\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/runtimeContext.js\":\"0bac4d85bebdea22\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/staticAppExtensions.js\":\"217ad64de7c3eac6\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/staticDataExtensions.js\":\"699bab1a66ed71a5\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/toastAppMount.js\":\"8a70fafb1dd7f200\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/useOverrides.js\":\"4b1a36d4530b6c03\",\"/knowledge-medium/pr-preview/pr-1845/src/extensions/useShortcutSurfaceActivations.js\":\"81af05e85c4e0570\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/discoverToggleTree.js\":\"7c147f346ea70a65\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/facet.js\":\"7e25811f10c8cdc6\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/resolveAppRuntime.js\":\"d70264541c3ddaf8\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/runtimeEvents.js\":\"3baf962979fe361a\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/togglable.js\":\"16baf79aa2305d2e\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/variantFacet.js\":\"d17030ef1c41e96b\",\"/knowledge-medium/pr-preview/pr-1845/src/facets/verbFacet.js\":\"b807c75e3044bb13\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/block.js\":\"28758936b81aa3f6\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/focusedChild.js\":\"4c826b34d529377b\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/propertySchemas.js\":\"5790d4a5727ae722\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/typeRegistry.js\":\"7d003a2a0296bc54\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useAncestorCrumbs.js\":\"771b14866c8508bb\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useAutocompleteListbox.js\":\"a278f858342923cb\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useDebouncedSearch.js\":\"5f7e619001b3e982\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useDebouncedValue.js\":\"dd3b7e9236a53095\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useIsFocalRender.js\":\"0b020386af15c723\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useIsReadOnly.js\":\"69739dfc9bc1615b\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useMaterializeBacklog.js\":\"c35469fef6df9e7c\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useMinuteClock.js\":\"cdf80f71f15cb679\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/usePanelLayoutProjection.js\":\"e125936049d02925\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/usePendingInvitations.js\":\"93057e73cee50820\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useRendererRegistry.js\":\"a68d9aeb36abbbd5\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useRetainedFieldRows.js\":\"465ddfd2e2190990\",\"/knowledge-medium/pr-preview/pr-1845/src/hooks/useWorkspaces.js\":\"6c4917aff42f4bd6\",\"/knowledge-medium/pr-preview/pr-1845/src/lib/utils.js\":\"3659209d6e6667b1\",\"/knowledge-medium/pr-preview/pr-1845/src/main.js\":\"bfa44a2f66a0bd97\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/MarkdownImage.js\":\"1bfc253754a13e0c\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/blockSeparators.js\":\"904214ee604fb492\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/context.js\":\"7c95f4a0b2947c08\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/defaultMarkdownExtension.js\":\"1dc906ed2732281e\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/extensions.js\":\"920ef5915cefbfb4\",\"/knowledge-medium/pr-preview/pr-1845/src/markdown/renderMarkdownHtml.js\":\"c103284316f6990b\",\"/knowledge-medium/pr-preview/pr-1845/src/minimal-editor.js\":\"b84ee0423e882bf4\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/armedCut.js\":\"7506295cdd8f6fdb\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/captureMediaVerb.js\":\"f63c5670c7619692\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/clipboard.js\":\"02b7616fb70b4423\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/decision.js\":\"0828e2b9a6982714\",\"/knowledge-medium/pr-preview/pr-1845/src/paste/operations.js\":\"3e8b7565740efee3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/account-header/AccountHeaderItem.js\":\"008c35ec43a94135\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/account-header/index.js\":\"59b94b6d621752e6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"bd7661da0949d25f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/askAgent.js\":\"b0f6a8c27bf438fe\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/askedStore.js\":\"bd5d9e31a8f4d563\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9fbed2bb4f84f5b7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/chipState.js\":\"3fb99481683018b6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/dataExtension.js\":\"94cb90861f7404d4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/index.js\":\"1bb0eb7b96393fbd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"13018aa8f4108087\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-dispatch-companion/schema.js\":\"5ddc30725a95c157\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/AgentTokensDialog.js\":\"881eea0aec463dbd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c64472a2e35ea9bc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/addMedia.js\":\"2ee5c0ff43847dde\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d4ed6cb35a285786\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/block.js\":\"adb0d90862e63d0f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/context.js\":\"799aaa9b3d1ba1e2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ff69e61b0a45d258\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/index.js\":\"c447c7654464cc5a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/outline.js\":\"cbbdae92c41ddf7a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/properties.js\":\"e74ea37b3b085c36\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/refs.js\":\"1d5ba9b91fd77668\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"daf46e0fccb7d142\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/search.js\":\"86f8444f6fe872e1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/shared.js\":\"d682f110c367a226\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"02aa937498c5e621\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentViews/text.js\":\"d9d0fb85e8b9c1af\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/agentWrites.js\":\"a3bf801f4eb465e1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/authoringCatalog.js\":\"d9219c6123987887\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/blockRefTargets.js\":\"f954c6192720aa55\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/bridge.js\":\"64644e0aa1c823d3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/bridgeLoop.js\":\"5b6af0db28f4cf1f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/changeHistory.js\":\"eae5a85c7a7346e0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/commands.js\":\"49239c51ef474bcc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/commentsCommands.js\":\"f391e882472d30a8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/dataExtension.js\":\"04d67e1388edd474\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/dataModelGuide.js\":\"a19a38031915a4a4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/describeRuntime.js\":\"14a366b148e29bdf\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/extensionLint.js\":\"addbc82bc90a3c16\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/grainAudit.js\":\"d214ceffc4e929cc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/healthCommand.js\":\"76faf86cd1b0211d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/index.js\":\"b79eccaa9498789a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/presetIdentity.js\":\"c68bb30eb9f4e2b6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b078ac0b724037a6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/readMedia.js\":\"461fbe3dac7fa64a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/schema.js\":\"16ba0f3344ebc29d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/serialization.js\":\"eaf43f8d715c1d38\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/targets.js\":\"895df552d550f726\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/tokens.js\":\"eecc1787a59aefa6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/watchEvents.js\":\"e46cbeced684565a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/workspaceGuard.js\":\"c97bb6b68c70df37\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/agent-runtime/writeCommands.js\":\"6fda333e59b0548d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/AliasCollisionToast.js\":\"eab782fb649295f4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/DuplicateNameBanner.js\":\"b9beff8c3f3f78ba\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/collisionMerge.js\":\"af999bc152f6085e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/dataExtension.js\":\"6b8bc253423f8699\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/index.js\":\"9a4aa90f301fc068\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/mergeCollisionAction.js\":\"e41f5c1d40644ec8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/pageStyling.js\":\"a65e8dac430da55e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/rejectionToast.js\":\"f6f982fb79c1e266\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/alias/syncProcessor.js\":\"c7745ebeeeb98942\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/actions.js\":\"2c29980e870e4216\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/addComment.js\":\"ef2619bc496c80d1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/anchor.js\":\"df1ce4ace04a43d9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/anchorState.js\":\"7f727063ea0cbf92\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/commentLinks.js\":\"51d3be21337f1358\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/confirmThreadDeletion.js\":\"a8c84cc6d2b9c5ee\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/container.js\":\"8ebc1d7d1d3e09f5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/dataExtension.js\":\"6ccb4447e0605875\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/deleteComment.js\":\"3884ea6b736e3431\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/highlights.js\":\"e960e759874c5e0f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/index.js\":\"9fb8d1fd6fe9b3d0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/linkedCommentsPill.js\":\"b4f5a48795442d59\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/margin.js\":\"b337db5b55e06044\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/marginSchema.js\":\"329aadfe3d8f5685\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/newComment.js\":\"2b67e075745e75fd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/ownThreadPicker.js\":\"fb7703959494067d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/placement.js\":\"0f0841f1a89176e4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/queries.js\":\"0c9584b2912ac960\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/quotePosition.js\":\"63cc1863960419a3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/quotedIn.js\":\"6684a83d317d8d94\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/quotedRange.js\":\"b19025bc75735729\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/rangeRefs.js\":\"b111539567a550d7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/readHighlights.js\":\"118702df2c0e444f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/readSelection.js\":\"d6908c639a88fa7f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/readSelectionUi.js\":\"b090a3cfb05c88d2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/reanchor.js\":\"4b2a5e5cf60f60ae\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/schema.js\":\"cb4974f32ea066e8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/scope.js\":\"2363d55b75247061\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/scopeThreads.js\":\"dc420a841e05b1fa\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/splitRetarget.js\":\"715530a03c26d2b3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/suggestionCard.js\":\"08beff2eb5fbae61\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/suggestions.js\":\"2e1fae3fa56e2e72\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/summaries.js\":\"c1ca8958794047c0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/summaryBatch.js\":\"74e561153049038f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/surface.js\":\"f87185550493ba13\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/threadNavigation.js\":\"e2f29cc8dfc7b6db\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/threads.js\":\"7f77e2d8618cab58\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/ui.js\":\"dfd5c645762bf47b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/annotations/uiStore.js\":\"852df6c3cd6da688\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/app-intents/appIntents.js\":\"90c354181292b795\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/app-intents/index.js\":\"e7cd66f25e0b5f51\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/app-update-prompt/index.js\":\"7a8d49e54c9e4740\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/app-update-prompt/status.js\":\"6105e05da5a09575\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"25bd03e20c0c6009\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/MediaBlockRenderer.js\":\"7bba1f58178d036d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/MediaDownLaneReplicator.js\":\"58a17f1a331c0c20\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/MediaUploadReconciler.js\":\"90ce9d722ec56a54\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/assetDownLane.js\":\"05cda6e6f9cbd5b8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/assetResolver.js\":\"d0f6a51367faf76b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/assetUpload.js\":\"86118e782d7a605c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/attachmentCleanerIO.js\":\"85a34dc6f4f47ede\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/supabaseAuditIO.js\":\"be0d379513386750\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/blobStore.js\":\"eb62ae392bc478c1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/byteStore.js\":\"f5845fdcae1ffe71\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/cleanerIO.js\":\"1fdf99500978d50e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/cleanupAttachments.js\":\"93b19693a3b69a0d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/dataExtension.js\":\"c32ed93a03143133\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/downLane.js\":\"89b30364e7d6dde9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/index.js\":\"8f3bdd206222bc4b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/insertImageContribution.js\":\"8e73056620356125\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/laneArming.js\":\"62bd1250565dd774\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/laneLock.js\":\"822c02d71db7a9d9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/mediaBlock.js\":\"f3748a90d0af4a51\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/mediaCapture.js\":\"585bf1830b48882a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/mediaViewers.js\":\"d7933d8fca4873b4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/mediaViewersFacet.js\":\"77ec309b9c7a4716\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/pasteCapture.js\":\"85cbc1fbe22bfd86\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/resolver.js\":\"0dc72064418c139c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/retryUploadsAction.js\":\"dde0d2b2a1fbe1e3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/storagePaths.js\":\"b0bbf0ee3777516b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadDrain.js\":\"f02dc5bdce581fae\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadLaneStatus.js\":\"15173ca5eb81782f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadReconcile.js\":\"b0229661daa622dd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadRecovery.js\":\"a2b01f6b324a413c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/uploadStore.js\":\"a42fef69ca8b5bed\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/attachments/useAssetObjectUrl.js\":\"7c7d5f0c7bfc6b43\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"178e1623c3e9c66f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/BacklinksViewSection.js\":\"1c7f8ec638e1f6b3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/facet.js\":\"862c443f1705a753\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/index.js\":\"469834b738b35813\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks-view/prop.js\":\"cbe5e2cb065f4c87\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/BacklinkFilters.js\":\"519e066d6a8e7f61\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"067e169429d2ec6c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/BlockEntry.js\":\"e2a97a331cfafcf3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/LinkedReferences.js\":\"b2261db17939d4e8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8948368d69e25aee\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/dailyNoteDefaults.js\":\"62a92518d4ab90f2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/dataExtension.js\":\"e126d3fdf5d78a4d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/edgeExclusions.js\":\"0b0b594694547459\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/filterProperty.js\":\"f9fa3942ecad41b5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/index.js\":\"a868dbf06739cc3e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"6cc69212f6ed8f9a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/applies.js\":\"ff6912d214d40227\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/countQuery.js\":\"34183c9784e8bb91\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ebc55c9237faca12\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/index.js\":\"91934bdccf845377\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"926b7aa5df6f89ba\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/presentationInvalidation.js\":\"97364e9f3cfe45c7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/propertyEditorOverride.js\":\"d7eb490740d419dd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/propertyFilter.js\":\"f7592bad4713df44\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/query.js\":\"6139c8be8a425f81\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/resolveFilter.js\":\"957d978f4abaa83a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/sourceBatch.js\":\"4f31ea1c3383bb36\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/sources.js\":\"74a730833cb7ae47\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/useBacklinks.js\":\"097d47b53f6c86b8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"53c78791e4f31f1c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/BirthdayCelebration.js\":\"8ef6fc1bf97a6c7c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/BirthdayOverlay.js\":\"31f0a9f01c9c6716\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/gate.js\":\"d939e4df4a026469\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/index.js\":\"fe9d7ff56583b08a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/birthday/wolfTheme.js\":\"5db710710fabbb32\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/BlockDragLayer.js\":\"934b435ecaa46e71\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/dragController.js\":\"0313ccf766eb3d74\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/dropTarget.js\":\"0cfe704b7531ee4b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/index.js\":\"ace9fa0aff66200e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-drag/projection.js\":\"cc821c981cabaf2c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-info/BlockMetaCard.js\":\"83bc2a4c57f7d36e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-info/index.js\":\"46ff193e47250e09\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/AddTagDialog.js\":\"5e8506dceda2374d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4c060758e362d15c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/TagNameIssueHint.js\":\"0a514c01c1941f2c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/addTagAction.js\":\"781555fe68f15b06\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/appendTag.js\":\"dee64a4fcfefc387\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/config.js\":\"76431b12067254bc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/dataExtension.js\":\"6c8eee35f27d4f22\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/index.js\":\"0a2e0feb20e85a49\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/block-tagging/propertyEditorOverride.js\":\"283e54c43fb75e13\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c9553ef9ac9d14e1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"56e9f408e78cb146\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fdd9de48e5b8b9a2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1ae9a2837b1afe54\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8fc6ed48f3228443\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/index.js\":\"16d77a154b0b9c5a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"2322d697777083f1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/CharacterCountItem.js\":\"1bd0f4e0fbcc568b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1f7921a9977daa76\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/actions.js\":\"f4690faea5164e7c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/blockType.js\":\"42e124ba90948700\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/charCount.js\":\"ce5cb75c647f55f4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/dataExtension.js\":\"e361c414b74c62d9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/index.js\":\"13d1f78b7ce10b64\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/profiles.js\":\"da6850162c1a02e8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/properties.js\":\"ed002e39b0e93668\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/character-counter/textCounts.js\":\"615c03abff250ffd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/colemak-keybindings/index.js\":\"f3886873322d152c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/CommandPalette.js\":\"2755f037f3ed74e2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/HeaderItem.js\":\"8293b80f79bd923d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/context.js\":\"6134265967ac1e3a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/index.js\":\"ae0a9f8f8cb93960\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/selection.js\":\"838ee22dae342762\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/toggleStore.js\":\"08d7e578b1f95230\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/command-palette/useCommandPaletteActions.js\":\"5e110dfa5dc81120\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/ContributorBadges.js\":\"f9a53349d14d7a64\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/author.js\":\"afd0da086165921e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/codeMirrorExtensions.js\":\"0f4c02933d274057\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/dataExtension.js\":\"b7e186c069960f87\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/index.js\":\"294348e91a3307e0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/mentionAutocomplete.js\":\"c36329b6d460c3f3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/processor.js\":\"1190d763ea9db9bc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/profiles.js\":\"663803386f5e59b6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/queries.js\":\"ccb88549367396d1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/contributors/schema.js\":\"76646e9a8c4370c9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"331a8bd8e63d74bb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0d4b182a4c05be8d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/index.js\":\"dab8a7011fed6ad5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c97395e826cea117\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"bf133602c3d7becb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/CalendarGrid.js\":\"eb43cd424cf1a6f7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/DailyNotePicker.js\":\"cbbd37a58575e7fb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"816b27f6eac5303f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/DateNavDecorator.js\":\"32c6fd96c1487870\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/DateScrubOverlay.js\":\"a25262d5fc4d13f7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/HeaderItem.js\":\"0618bb9f01ea26e6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/ReschedulePicker.js\":\"2e9d8425187652ed\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2a03f6159a9386e1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/actions.js\":\"ce643c8679e54d77\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/blockDateAdapter.js\":\"9ffb19c875b0b430\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/calendar.js\":\"3d7d02e00bf63892\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dailyNotes.js\":\"420b1fc68018d9da\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dataExtension.js\":\"2656589391fddf21\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dateScrubActions.js\":\"89eb82248103d084\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dateScrubGesture.js\":\"8f4ad549899ac3b7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dateScrubGestureActions.js\":\"893a84993261a966\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dateScrubRecognizer.js\":\"eefb390976bd4f2c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/deletionGuard.js\":\"0b7e32e8ebc2131f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/dueQuery.js\":\"4486be60636e3837\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/index.js\":\"a59e6126d9947c77\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/landing.js\":\"5cfd8a85624255ec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/localSchema.js\":\"f5498dd0cd805ae2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/referenceDateAdapter.js\":\"05121ad76bd7ef68\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/rescheduleAction.js\":\"6f0bb871f0e4856a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/schema.js\":\"7fcdba275f17c593\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/spreadBlockDates.js\":\"401c6ed1d38df52b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/spreadDatesAction.js\":\"56dd62cf4f2c354c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/today.js\":\"88d62d713a4250a4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f281914d3d32784c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7d543b2bf2a2b428\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/audit.js\":\"f7397b2de07e37e8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/auditAction.js\":\"fb8cb6807d21bff5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/auditRanges.js\":\"b7b85d16a026d68d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/diagnosticsSource.js\":\"8bd7ac2f55266151\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/divergenceScan.js\":\"ebc568d2b39c0d55\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/index.js\":\"e15a7e94978accf0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/propertyChildrenChecks.js\":\"133a7448c5b1f10d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/referencesMirror.js\":\"eb886bab062fd3c2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/rowJson.js\":\"192acdb5dc96a062\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/schedule.js\":\"3b6d6ffcbb556a46\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/data-integrity/store.js\":\"fd8417bb9747df62\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-maintenance/action.js\":\"629d6e01bd841ea4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-maintenance/index.js\":\"8ea0909bfbc3a854\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-maintenance/plugin.js\":\"95a6346cda386f64\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"344a7f116ca76bd5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/actions.js\":\"c2ede3e9e2eaf89d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/changeMarker.js\":\"1810cd3434b5e50b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/diagnostics.js\":\"3bcb73d4b080b6f7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/fileSystemAccess.js\":\"5dc8d2e28d5cabe2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/filenames.js\":\"54dc06b2677d0394\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/index.js\":\"c358915381cc1970\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/mirror.js\":\"a64764683165f879\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/runLock.js\":\"506f618cb728ed76\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/runtimeHealth.js\":\"2679a68b42b52508\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/schedule.js\":\"91516f877e7e5b05\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/db-mirror/store.js\":\"7c73d26d8952eb20\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/default-themes/index.js\":\"31180b0c08d36a53\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/default-themes/themes.js\":\"1effa57852ba408b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/diagnostics/facet.js\":\"717a70bd096fa747\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/diagnostics/useDiagnostics.js\":\"03d6f51c90c99f14\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extension-prompts/dismissals.js\":\"70667d50ff961945\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extension-prompts/index.js\":\"0da1ec5c15fb09cc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extension-prompts/status.js\":\"e1e29b8d9115d8ca\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extension-prompts/store.js\":\"7917f978322ccafb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f6b3bdf24919215f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8c57d53f1adb948d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/actions.js\":\"d3d5f41328368d05\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/config.js\":\"210b9b921c31793c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/dataExtension.js\":\"be6b2ebc53bb3c8a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/effect.js\":\"3ff6c7c51415cf92\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/index.js\":\"62fda4e86e605624\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/propertyEditorOverride.js\":\"11e2e20b0eec9bd7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extensions-settings/useToggleTree.js\":\"ba3708e6f4929567\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/ExtractTypeDialog.js\":\"55f18fd50ac5e652\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"76a097cfbeda221e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/PropertyShapePicker.js\":\"b60fbe0a408743df\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/action.js\":\"986707bf9aac3bdb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/extract-type/index.js\":\"738b4215058409b6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/FindReplaceDialog.js\":\"5b775c1e9d126866\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/HeaderItem.js\":\"a6e7b1a0ad647920\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/dataExtension.js\":\"d89447c866818ff6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/index.js\":\"ed0991f1b97f8ed5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/search.js\":\"816d3df8d436b7c0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/toggleStore.js\":\"71a34e5abc212a8b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/LocationPropertyEditor.js\":\"f81c466785c6f09a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/MapView.js\":\"a08d97456e08af3d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/blockTypes.js\":\"5046761cef2f059f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/codeMirrorExtensions.js\":\"3b6afd9316df1e4a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/createOrFindPlace.js\":\"5df702fbcb6b4ee3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/currentLocation.js\":\"f15dbb418d6bd5e1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/dataExtension.js\":\"ce84debcdcb72090\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/geoContentDecorator.js\":\"bfe0c2cf24a566f3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/googlePlacesClient.js\":\"08cba45dad9f92de\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/index.js\":\"d7ba19cfdffce49f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/locationsPage.js\":\"124a8a10cae889eb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/mapViewport.js\":\"97d8454d4f22b6eb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/pickCurrentLocation.js\":\"9feda840070d5d5d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/placeAutocomplete.js\":\"d95f333521ad63c6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/placeNameCollision.js\":\"e85502c922d6dd11\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/properties.js\":\"80735376ecf8c7f3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/propertyEditorOverrides.js\":\"c767b13d8f2de224\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/query.js\":\"222767b33a5813a8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/geo/usePlaceSearch.js\":\"98b14afe1beb639d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"dcc349c52057aa1a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3ff4b6b50b38a42f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"927d6c532d6c58c7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/config.js\":\"492c76a2cd104d67\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/dataExtension.js\":\"22e19f4f7044422a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/facet.js\":\"f2816e7eaa203450\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/grouping.js\":\"230dae9e3247fded\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/index.js\":\"6a5bec59483a3663\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"368ae8f112cc3af9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/query.js\":\"53988f495baeb2b4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/resolveConfig.js\":\"71d044c87d7ead8b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"fea92ce17d7b41b4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c9237d65166e6ee0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/HtmlDocumentContent.js\":\"696434c56083d366\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/HtmlFrame.js\":\"9c672174283184ff\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/actions.js\":\"7bd8b47c52f9ba08\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/blockType.js\":\"a4f5432bcc4f76b9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/confirmRunScripts.js\":\"b5f345f99bcf1ef5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/dataExtension.js\":\"7313fa1317a6363d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/frameAnnotations.js\":\"b9602a36f4b40d5e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/frameDocument.js\":\"590e16e59313e2ec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/frameTheme.js\":\"62059c0ba380d3fe\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/index.js\":\"19428c5338fd648c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/scriptConsent.js\":\"4c1e951948adb82e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/sourceMap.js\":\"fae86bcdd5074884\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/html-document/useDocumentScripts.js\":\"66693fba56e44207\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/index.js\":\"cc09c49037244e2b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/record.js\":\"7a7db18e46b835d2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/recordStore.js\":\"4d0fc74ea006fcb5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/responsiveness.js\":\"1d0460647d7b145c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/schedule.js\":\"80ae17facd06a895\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/interaction-metrics/sessionContext.js\":\"b536351b89c7b138\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1b3057013c484e5f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a3a70120f17b85ec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/actions.js\":\"d59fff9fe9ea357c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/config.js\":\"6bb17e374bc6ae0c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/dataExtension.js\":\"64726828519926ba\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/effect.js\":\"94807b4ace6b41d1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/index.js\":\"c36eb3b55aaf0848\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/keyCapture.js\":\"bc6f883bf0401294\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/overrideStore.js\":\"e4e17b74631e32de\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4f56052f539bbc97\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/HeaderItem.js\":\"3f0bd6437e441d32\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/LeftSidebar.js\":\"19179ab79a2f52b7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/actions.js\":\"518267068b722dc7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/facet.js\":\"824c6a342bcac3d7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/index.js\":\"44ff8a40dd594fe7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/shortcuts.js\":\"7de0d25a57230bcc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/left-sidebar/toggleStore.js\":\"31d11779ad25e7ce\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/merge-blocks/MergePicker.js\":\"7877810a053ffba3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/merge-blocks/index.js\":\"e2b041523dea09ae\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/merge-blocks/mergeAction.js\":\"67f60f5609a7d386\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/merge-blocks/strategy.js\":\"e77fde5f727863ec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/Button.js\":\"3457b50836ecd2d2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7f07ebe9ab12efda\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/defaultItems.js\":\"16d3a0d6a1e6620e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/facet.js\":\"4bcd3d8b2d0299cb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-bottom-nav/index.js\":\"38120dbacfb89f6c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fcf7ec7b76745c91\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8bca30541000be3e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"285c568e5cf1ffb8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c4915500e0e9c0ef\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/mobile-keyboard-toolbar/index.js\":\"772ac41c4052e050\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2fba7026cf7627d0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/blockSubtreeMembership.js\":\"cd01969dcf53396c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/contextMenuItem.js\":\"b32772e56bfbb10d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/index.js\":\"354bdc8991c3c26f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/moveAction.js\":\"fab6521ed277a2ac\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/moveBlocks.js\":\"dc51b667b8d8108f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/move-blocks/selectionAfterMove.js\":\"48f5eaa8e3be765b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/TutorialBanner.js\":\"f96e2f510826d4cd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/action.js\":\"da91edf2dd33bcde\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/bannerDismissal.js\":\"8d9e724d09a6984c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/documents/cheatSheet.js\":\"1a38ea16d42f372e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/index.js\":\"c97f0f7339882307\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/keys.js\":\"dc92116b6f4a689a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/landing.js\":\"d02b420fe7143dc2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/outline.js\":\"f661a6a867b31fcb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/onboarding/seed.js\":\"b5acc10bb8f56008\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/PerfTrendDialog.js\":\"06837af51d5cfdde\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/analyze.js\":\"14d7a5453a197205\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/diagnosticsSource.js\":\"97608cb7522711b1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/index.js\":\"1fa4c8fd8621ba88\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/load.js\":\"57fd9b279c70cb4c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/monitorRun.js\":\"2df3eb92690a7952\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/schedule.js\":\"734b39eef77c6cbd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/series.js\":\"c7df0c14f9a365f3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/store.js\":\"1196033f72217d45\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/trendAction.js\":\"dd5c6faffcde761f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/perf-monitor/verdict.js\":\"ddb52cdf01cbf8e1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/plain-outliner/clickToEditAction.js\":\"51df0a657f1ed294\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/plain-outliner/index.js\":\"b2c10b60a36fc496\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/plain-outliner/interactions.js\":\"b3293f53baecc7aa\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7c171e61388c543d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/MigrationGate.js\":\"6f722399742cbfa0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/MigrationGateDialog.js\":\"53773f8daf08ac4f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/action.js\":\"262323b24821877c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/index.js\":\"d85fc733bc543ce4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/localRunMessage.js\":\"3145b28c48fe3f29\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/plugin.js\":\"239e692fdae39b15\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/progressReport.js\":\"0f188bf323bf57e3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/properties-migration/sweepProgress.js\":\"eab9fd247e587270\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/FieldRowRenderer.js\":\"5e9f9b2c27f3cb0f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/ValueRowRenderer.js\":\"bc7bb095768f6e37\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/actions.js\":\"540537d5fb9d20ad\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/autocomplete.js\":\"fe66cd4bc4830257\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/fieldRow.js\":\"4e9314ea228a4626\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/index.js\":\"4d78114757cb4d8b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/referenceWarning.js\":\"f4493c7d83d4b0e6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/valueAutocomplete.js\":\"af1f657515effd8a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/property-rows/valueSchema.js\":\"64d4a5beade18ca5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/HeaderItem.js\":\"552fd0c9d12a9b5e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/QuickFind.js\":\"591cacfbe09768ae\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/index.js\":\"d97f3ca608042ead\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/recents.js\":\"24b198bc0f35159c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/resultItems.js\":\"79f218c17df0cce3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/selection.js\":\"389283de08c82830\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/quick-find/toggleStore.js\":\"7afc31fb28bb43b9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/HeaderItem.js\":\"3b1e71652773ba12\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/RecentsPageBlockRenderer.js\":\"02e62cf16afaa003\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/grouping.js\":\"24128ee73c4a3c9d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/index.js\":\"73ad22e5bd38d2c0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/recents/target.js\":\"b44af095a5e4b416\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/codeMirrorExtensions.js\":\"3238575ee0b17017\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/contentPrefill.js\":\"9e6bdde442eb28e4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/dataExtension.js\":\"0da58ccea1d9e2af\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/index.js\":\"90f49f9d6e59e6a8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"71e519640a2838a8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/invalidation.js\":\"84daba62096edd6e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/localSchema.js\":\"7b801a1c019fc1ea\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/blockrefs/index.js\":\"62fda80af8249ab1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b133f1aee796933a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/index.js\":\"a43307b10d0d1544\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/referenceNode.js\":\"a26a5980417938fa\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/remark-reference-occurrences.js\":\"6af130fae7cecc48\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"61ff55b384b32c93\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/wikilinks/index.js\":\"6d464025f91a7547\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2fde396ad2289b12\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2b7eb3853d7fc336\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/mergeRetargetProcessor.js\":\"5fde4fad1f858d14\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/parseFence.js\":\"3187e3f8dece9aa5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/referenceParser.js\":\"00acc0b2093a9bd6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/referenceProjection.js\":\"4b013161ee3510f1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/referencesProcessor.js\":\"d9e06a47e5b62fac\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/renameProcessor.js\":\"26bcbac3b107dfa5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/references/spanReplacement.js\":\"b2831b9f7d47a583\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/rich-paste/htmlToOutline.js\":\"c7b0b4f95d119e11\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/rich-paste/index.js\":\"c7c73afd78fcbf88\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1b8ac6fc7463895c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/rich-paste/pasteDecision.js\":\"a784edd18f1dce21\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/action.js\":\"02645fedd89143e6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/blockIds.js\":\"a3a13798b01ef472\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/content.js\":\"793fd1ca0291aee0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/effect.js\":\"9d168132fb53508a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/ids.js\":\"c83acd700d8b7a6f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/import.js\":\"23b0044b79d35f16\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/index.js\":\"00beef2dea39b598\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/plan.js\":\"a5e707d91a53010b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/plugin.js\":\"a57259edd742863f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/promotion.js\":\"a0c72bb1fbe999c4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/properties.js\":\"9bf6c7840982b9c2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/references.js\":\"6d1e8c9a88eeaef5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/report.js\":\"8d64c13f80f5cf89\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/roamMemo.js\":\"05d8b814ac57f4cd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/runtime.js\":\"b349c750cc82b125\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/schemaReconciliation.js\":\"28d7a7e15ee1786a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/srsMarkers.js\":\"1e6b59c7fd44cd4f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/todo.js\":\"587375e664f4e85d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/typeCandidates.js\":\"b75bf606aa801996\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/roam-import/types.js\":\"21bd1480c9a652c0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/search-health/index.js\":\"a2099d3b50b91fc0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/search-health/store.js\":\"1daba5304a1aa193\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/HeaderItem.js\":\"496b3e6af74185ac\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"864e39d088c0d3dc\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/index.js\":\"0aaac6475424508b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/model.js\":\"bbd7cb6c3e2db3ec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/toggleStore.js\":\"7f162cac97bb4822\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/shortcut-help/useKeyInspector.js\":\"a8d187e10b776371\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8603fbeb25f43150\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/ShellDecorator.js\":\"fbb4f211ec9a18c6\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/actions.js\":\"e5d52ead7ee1f736\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/exclusionsFacet.js\":\"2688caac1c04020b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/index.js\":\"e82974fb08cc66cb\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/shell.js\":\"f9d072ab380e0b9e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/surface.js\":\"0529e7a038167e82\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/spatial-navigation/walker.js\":\"6e8f5985d5515055\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e9e4d9f12b8382cf\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/dataExtension.js\":\"3fceadfbe168a93e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/index.js\":\"4cd1bb6a541209c1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/indicator.js\":\"a8b7f2c3519ced6f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/moveSrsState.js\":\"9d755c9260b7f465\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"44b5a31cafc80ae7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/scheduler.js\":\"75dcc27f7b82e4a8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/schema.js\":\"863bf46328885f5c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"71e1040ffb0691c5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/srsClipboard.js\":\"26383a9ff9f65664\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"411affc619f70cdf\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ca966d4f42ce5eb0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/DeckPicker.js\":\"3244af202f3dbebf\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/ReviewControls.js\":\"0963e178068588d4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2f459a796c75a49b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/ReviewSession.js\":\"39fb6914a8b322d0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/actions.js\":\"121a5df45785bd52\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/archive.js\":\"1200c7785836e42f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/dataExtension.js\":\"3a1ab1f9477862b2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/deck.js\":\"8f81d5d4f3dea2e7\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/dueQuery.js\":\"2bc03ffa6c4f0c51\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/gradeDecision.js\":\"e8dbe87a53102d5c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/index.js\":\"70a65ccfc1ef21e2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/keyHints.js\":\"a6f4091de9a9a7b4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/reviewCardLayout.js\":\"3ae44ddaf9fba983\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/reviewProgress.js\":\"3d039c2f18ef9ad0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/schema.js\":\"430e12f2e666ae13\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/srs-review/useDueCards.js\":\"fee3f9da9c041f46\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/startup-metrics/index.js\":\"6fd6f0caa78b8607\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/startup-metrics/record.js\":\"79938edfb959155c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/storage-persistence/index.js\":\"a36779d278ff02d8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/storage-persistence/persistenceStatus.js\":\"899db98350d7bda8\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/storage-persistence/requestAction.js\":\"84b022d95e317b5b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/supertags/TypeChipsDecorator.js\":\"b634c60aa6ffed1f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/supertags/codeMirrorExtensions.js\":\"739d52d7a14e5759\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/supertags/index.js\":\"605161b45429e18a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/supertags/typeAutocomplete.js\":\"801badbc1b03a30f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"818c02b19e786a3e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/actions.js\":\"3bb3f06a57657ff9\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/anchor.js\":\"2b59e540ad3fe464\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/events.js\":\"6d6d4be8eb6fab80\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/gestureActions.js\":\"5e6d76d765f41c68\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/index.js\":\"af9b7b5105d2bacf\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d4462fd1a7e7d694\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/sync-metrics/collect.js\":\"9b042a4aac45f07d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/sync-metrics/index.js\":\"5a72f7e4a965a930\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/sync-metrics/record.js\":\"854c486ccdf17e98\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/RejectionDialog.js\":\"1337aba9d4cc8466\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/SystemStatusHeaderItem.js\":\"cdbd77039f003ce2\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/index.js\":\"de57b32dedea04cf\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/model.js\":\"2a401761613d6e66\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/queueCounts.js\":\"068b54e4ff43d2a3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/rejectedHelpers.js\":\"46dbb291a03d3938\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/rematerializeAction.js\":\"ba474e77b8c15975\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/system-status/useHysteresis.js\":\"8e458658b6500e46\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/ColumnHeaders.js\":\"e0d1a5100f63cab1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/QueryUi.js\":\"5667396844310600\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/TableLayout.js\":\"a53c400171e4816f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/actions.js\":\"1b77b9e0cd5df9b4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/cellEdits.js\":\"ad1ce6752f63114e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/columns.js\":\"a9c373a992b35a6d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/controller.js\":\"b9bc7d561da550f1\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/convert.js\":\"909bbd7e270778b5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/dataExtension.js\":\"2abaa00f9aa5e06a\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/index.js\":\"d0a3f7cb1c378a8e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/keys.js\":\"685381d432f0de40\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/model.js\":\"a253b4e6a768a159\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/backfill.js\":\"e1a3d08e69d8e20e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/format.js\":\"695a9d3601dc90c3\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/parse.js\":\"94aa2a5bedd0a167\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/queryValue.js\":\"9762dbbe178c42ef\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/query/source.js\":\"4685f3f22b4df2c5\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/registry.js\":\"5bef46570351ea6d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/schema.js\":\"2d25301925d5e31e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/tables/sort.js\":\"6de7d23ad1e57752\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/theme-toggle/effect.js\":\"a7b58bd841f78bad\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/theme-toggle/index.js\":\"a30c219e243bd82b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/theme-toggle/theme.js\":\"75c307b8e36ade25\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/todo/actions.js\":\"cb2320b835e5db29\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/todo/dataExtension.js\":\"525c9480b00f12e4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/todo/index.js\":\"4679f239296bec43\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/todo/schema.js\":\"83c9a620a1e0f39e\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d59b40721166a689\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/actions.js\":\"e337492452d3767c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/defaultItems.js\":\"b1655a8c0e1caeba\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/facet.js\":\"3546908c93e0ee32\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/holdRecognizer.js\":\"c36cfb1f98707815\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/touch-selection/index.js\":\"acbec228b260c03d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/update-indicator/UpdateIndicator.js\":\"bd789022155636c0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/update-indicator/index.js\":\"a3b2df2a78ef8dc4\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/update-indicator/loadTimes.js\":\"9e8113fbda17226d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/VideoNotesRenderer.js\":\"2f8747e1a766bfac\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/VideoPlayerRenderer.js\":\"45b696beac508c05\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/VideoTimeStamp.js\":\"a284a553d63f3eb0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/actions.js\":\"96493e59f2a17c09\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/index.js\":\"b39ef8adb8af6f1c\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/markdown.js\":\"14705bb957f4ffdd\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/notes.js\":\"acfcf0a740e3153b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/registry.js\":\"ccb877822c170f86\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/remark-timestamps.js\":\"2198736bdffdee70\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/video-player/view.js\":\"2b0d1bdac17da18d\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-link-hints/LinkHints.js\":\"2dc83a68f036f5ce\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-link-hints/index.js\":\"cb5d6783e95067ec\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-link-hints/model.js\":\"d08620a9c304859f\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-link-hints/settings.js\":\"3aae9ee8394ac25b\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-normal-mode/actions.js\":\"3e6460c0511931ae\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-normal-mode/index.js\":\"1d97994a9f2307f0\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/vim-normal-mode/interactions.js\":\"0c58d5a6b622ad11\",\"/knowledge-medium/pr-preview/pr-1845/src/plugins/workspace-header/index.js\":\"ac6bec007188ca72\",\"/knowledge-medium/pr-preview/pr-1845/src/registerServiceWorker.js\":\"948cb1352f686db8\",\"/knowledge-medium/pr-preview/pr-1845/src/requestPersistentStorage.js\":\"fc0708b8a93efd1e\",\"/knowledge-medium/pr-preview/pr-1845/src/services/authRequestDeadline.js\":\"6274e84c960cbc76\",\"/knowledge-medium/pr-preview/pr-1845/src/services/authStorage.js\":\"45ec6a39e3003984\",\"/knowledge-medium/pr-preview/pr-1845/src/services/powersync.js\":\"a1e6cce281d88b5a\",\"/knowledge-medium/pr-preview/pr-1845/src/services/supabase.js\":\"28e24b09a61e7157\",\"/knowledge-medium/pr-preview/pr-1845/src/services/uploadErrorClassifier.js\":\"df290e1082b2f972\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/ActiveContexts.js\":\"5a4cc215a4179f4b\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/HotkeyReconciler.js\":\"05eb72a31b41469c\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/WipeLocalDataDialog.js\":\"e19ecc3110014e7a\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/actionDispatch.js\":\"85809b57a17233b8\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/actionRefItems.js\":\"9f733472662c6bc3\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/applyKeybindingOverrides.js\":\"0b3619f87a1e87e7\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/blockActions.js\":\"ebc9b3d0f2d8afd3\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/canonicalizeChord.js\":\"19e94383eb47272b\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/defaultContexts.js\":\"b0acd3ecd7e377c7\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/defaultShortcuts.js\":\"b45a6500be4d43d9\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/effectiveActions.js\":\"6faa46b90fd256b9\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/gestureAction.js\":\"2984aeeb261f48c1\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/gestureBinding.js\":\"cbeac43bf7e06db7\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/holdRegistry.js\":\"b6fe7886604edfbb\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/keybindingConflicts.js\":\"620343bdc9dc2bf3\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/keybindingOverrides.js\":\"9b4262b37ba49470\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/pointerAction.js\":\"9508033339f81fad\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/resolve.js\":\"4b496bfdd04a38da\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/runAction.js\":\"399834c55b5f9dc5\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/sequenceMatcher.js\":\"9d4e9fe2c89fbd68\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/types.js\":\"e352e25044fd94f1\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/useActionContext.js\":\"6493105c22e46300\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/useActionDiscovery.js\":\"0b95c521df15a1b3\",\"/knowledge-medium/pr-preview/pr-1845/src/shortcuts/utils.js\":\"f91786ebe4385252\",\"/knowledge-medium/pr-preview/pr-1845/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1845/src/sw/bootStore.js\":\"7b9c34aa74f9890a\",\"/knowledge-medium/pr-preview/pr-1845/src/sw/previewDatabases.js\":\"ab2e8a2546505392\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/byteTransform.js\":\"4f6d68d75523d315\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/attachmentCleaner.js\":\"49e594bd458f1b6a\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/attachmentParts.js\":\"2b04775b572f4433\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/bundleParts.js\":\"d7782b85e0d99b7c\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/bundleRecord.js\":\"f65a6eed4eeba74a\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/manifest.js\":\"a17efa7fe37b5f75\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/takeBundle.js\":\"051122ef2af430da\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/bundle/verifyBundle.js\":\"fafb41b8a4bd04d9\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/cleaningStage.js\":\"8639597eacb732dd\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/conversionKey.js\":\"c79dffae9794a8d2\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/conversionServer.js\":\"5ed2d811bd139853\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/flip.js\":\"dce6403335281631\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/flipAttempts.js\":\"2ab74e600abee03f\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/pages.js\":\"fe1e9993e41295c8\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/preflight.js\":\"73491ed6c2d56cec\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/reseal.js\":\"02e65b254024e5d8\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/runConversion.js\":\"bff2e91cf66933ca\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/runLock.js\":\"0543e9edc017b054\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/sealing.js\":\"efe881cda6edd634\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/sealingStage.js\":\"956a7e4cac1aaf6e\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/stage.js\":\"2bd740cee001e2ff\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/conversion/verifyReseal.js\":\"2a3c1065f6b0e9e9\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/aad.js\":\"bf445df36bc75491\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/aead.js\":\"804b5cfa76f176b5\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/base32.js\":\"05f503b2d43dab81\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/base64url.js\":\"7b9465bc7c10bf1f\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/binaryEnvelope.js\":\"1a1ab0baddb8d541\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/byteAead.js\":\"5530da3e30300d7d\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/canary.js\":\"fd30464dd04f355d\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/contentHash.js\":\"30354f0651b9c937\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/contentKey.js\":\"a89082f2c935dde6\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/derivedIdNamespace.js\":\"631bed5ee243836b\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/envelope.js\":\"4a62c9252f8684fb\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/hex.js\":\"93fa07195c7fbf3b\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/sha256Hex.js\":\"936ecb28b1205605\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/crypto/workspaceKey.js\":\"92a8d89c0bd30a63\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/conversionState.js\":\"51ea6fdee9b82822\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0a7dd19ccd316958\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/flows/pastedKey.js\":\"003c84e7e2277041\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"db27c2c79a99d6d5\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/flows/upgradeWorkspacePin.js\":\"87f8d13af668645c\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/keyStore.js\":\"27455dc76f03800d\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/mintWorkspaceKey.js\":\"72e0530466cc53bd\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/modePin.js\":\"cfe4bbcc502ffe4e\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/openWorkspaceKeys.js\":\"d2c1c666d9ef0e15\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/resolveWorkspaceEntry.js\":\"a5bfaa344065464d\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/resolver.js\":\"19fe9b73b44814e4\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/keys/workspaceAccess.js\":\"599ffe602d328402\",\"/knowledge-medium/pr-preview/pr-1845/src/sync/transform.js\":\"60544b89ea11cd62\",\"/knowledge-medium/pr-preview/pr-1845/src/themeBootDefaults.js\":\"8f4774ff03dab962\",\"/knowledge-medium/pr-preview/pr-1845/src/types.js\":\"a50aaec6b7bfdff7\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/ClientLocalSettings.js\":\"9a9b0301e9ad1cf1\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/abortableSleep.js\":\"888b3d1ce2b7fab0\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/array.js\":\"bb7e01246573d1c0\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/backlinkAutocomplete.js\":\"d64201bb81e25313\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/blockCrumbs.js\":\"42dbf7e54b5bfb4e\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/blockrefAutocomplete.js\":\"e15cd2ba11e25a20\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/cadencedIdleJob.js\":\"cc864014171f229a\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/callbackSet.js\":\"985eabf6b80a15c1\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/clientId.js\":\"d0854c3a9d1c9e22\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/codemirror.js\":\"8b2940ce7effb34e\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/codemirrorCompletion.js\":\"11750f457b7dea0f\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/copy.js\":\"95fb06373fbb6f9c\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dailyPage.js\":\"1c5ea3718ef35417\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dbForensics.js\":\"3a459fc0d6bc3416\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dbForensicsHooks.js\":\"d53b858521f6d11d\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/deleteBlockThroughUi.js\":\"c349e6b51f8fb9e2\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dialogs.js\":\"c1eb8b46b0165925\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/dom.js\":\"0fc44fa2deae8095\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/downloadBlob.js\":\"0e7bb84b28e191a4\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/exportSqliteDb.js\":\"53936fb98e4ad4b7\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/fileSystemAccess.js\":\"a0f9c8d3a47d1f32\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/flipSlide.js\":\"100d282ecf74f9dd\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/fnv1a.js\":\"40cbbb9414d478a8\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/formatBytes.js\":\"acbd0330359e0c15\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/fuzzyRank.js\":\"a3d12d007be49a74\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/idbKeyedStore.js\":\"f48004933a6b86a9\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/idleCallbackPolyfill.js\":\"fe84ef3be83e82c8\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/keyboardAwareScroll.js\":\"25e1949a8246f009\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/keyboardViewport.js\":\"29fa2164dd13a16b\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/lastWorkspace.js\":\"131b50cf32418ab6\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/layoutColumns.js\":\"418c53c976dc225f\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/layoutSessionDom.js\":\"9e24c7c82c363614\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/layoutSessionId.js\":\"3f8318c1e87fb437\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/linkClickGestures.js\":\"e898be49f4404102\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/linkTargetAutocomplete.js\":\"5feb84cca702364a\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/localDbCorruption.js\":\"dde59540791ce289\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/localDbRecovery.js\":\"1c0370c3894972f8\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/markdownParser.js\":\"97bce1603d3dbc79\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/memoize.js\":\"36d3f5d4d732b9be\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/nameFieldCommit.js\":\"2685ddbc5d7b9487\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/nameList.js\":\"058f80c0f423fb87\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/navigation.js\":\"e3ba251a96b81df7\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/omnilinerNamespace.js\":\"d4199e6290f9d944\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/opfsPageScan.js\":\"82f029ff3d052405\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelClearance.js\":\"202f906bae65c1d7\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelHistory.js\":\"51cd1d666ae5c81f\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelLanes.js\":\"ad115f6c4ee00644\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelLayoutProjection.js\":\"61f67905a800945a\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelScrollAnchor.js\":\"4762a4a59b35556b\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/panelUrlFlags.js\":\"49d8ee4150f569ad\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/platform.js\":\"49877bade22710c4\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/pluralize.js\":\"c5fb6788555a001f\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/propertyCreation.js\":\"f2069a9579cb2b66\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/propertyNavigation.js\":\"e240838f790721d1\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/propertyValueContext.js\":\"e343e70fb642f4a4\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/react.js\":\"6c314d6bc0d00776\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/relativeDate.js\":\"c85ae39dd43df0c2\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/relativeTime.js\":\"e04c661d0139f00c\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/renderScope.js\":\"5d11a0e074b114fc\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/resolvedThenable.js\":\"f31d3e967c4162f9\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/routing.js\":\"065225da0305c4e6\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/safeMode.js\":\"4c82e519c4caab21\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/scheduleIdle.js\":\"98d250d82123fc83\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/screenWakeLock.js\":\"0a39999227245d62\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/selection.js\":\"4d4e9299a03e80dd\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/softKeyboardGrab.js\":\"ce642a6115aad68d\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/startupTimeline.js\":\"33a1bdc8026a8519\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/state.js\":\"15e5fede2457e11a\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/string.js\":\"0b62f03df0abc6b6\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/surfaceZoom.js\":\"cdded60a7b4f04a4\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/time.js\":\"2279067a414edef2\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/toast.js\":\"9b45651ab0446fab\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/toggleStore.js\":\"dfe8db1049c65851\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/untilStopped.js\":\"7609b86947b40771\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/userActivity.js\":\"27b484e4fde57542\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/viewTransition.js\":\"6dee1f8e98dd7220\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/viewport.js\":\"5eebc83c6ec93ac7\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/webLock.js\":\"a8943b7cbe50bdb8\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/workspaceRecovery.js\":\"1e6d46caad391115\",\"/knowledge-medium/pr-preview/pr-1845/src/utils/workspaceSnapshotStore.js\":\"5a1f34367d4780d8\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-compiler-runtime.js\":\"b042039b2391cccf\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-client.js\":\"45b2f8795ce63ee8\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-server-edge.js\":\"b064fb87b2b35e68\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-server.js\":\"f8716c2bf371294f\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-static-edge.js\":\"4b9d688438296c14\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-static.js\":\"28691a7812427737\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom-test-utils.js\":\"44ac7ab138908485\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-dom.js\":\"ec64396583f7e9b8\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react-jsx-runtime.js\":\"5b0bd136bd61cf3c\",\"/knowledge-medium/pr-preview/pr-1845/src/vendor/react.js\":\"417d05dcb96d1b55\",\"/knowledge-medium/pr-preview/pr-1845/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1845/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1845/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
