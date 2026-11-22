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
		buildId: "9ba3c293b590-39f5c5cb",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/\":\"7ffb9866e19a830f\",\"/knowledge-medium/pr-preview/pr-1846/index.html\":\"7ffb9866e19a830f\",\"/knowledge-medium/pr-preview/pr-1846/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1846/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1846/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1846/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1846/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1846/assets/FacadeVFS-Cuc_pJ5k.js\":\"9b192afb14c04bba\",\"/knowledge-medium/pr-preview/pr-1846/assets/OPFSCoopSyncVFS-B4s0e9Xx.js\":\"16ef4e94724a0461\",\"/knowledge-medium/pr-preview/pr-1846/assets/OPFSWriteAheadVFS-DmiwJfWP.js\":\"0f362a1d1371b520\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-Bf_q2CX1.js\":\"8a1046760280d7e4\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-async-DyzoZ0I4.js\":\"520896e328a0766f\",\"/knowledge-medium/pr-preview/pr-1846/assets/worker-CtYXZDNX.js\":\"a836ca8165647d4b\",\"/knowledge-medium/pr-preview/pr-1846/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1846/chunks/app-CtH5JoO7.js\":\"324b93b798c6ccf1\",\"/knowledge-medium/pr-preview/pr-1846/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1846/index.js\":\"f4605f0b92f6dfde\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1846/assets/AccessHandlePoolVFS-Dsmo1HS6.js\":\"7cb7b7d6c2b2b1fe\",\"/knowledge-medium/pr-preview/pr-1846/assets/IDBBatchAtomicVFS-C7-vPcxJ.js\":\"dff84084e46a9d34\",\"/knowledge-medium/pr-preview/pr-1846/assets/MemoryVFS-DLPl70D3.js\":\"36f3bb41d37c48b0\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-BlcjHb6I.js\":\"a0d7affd462ddaa0\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-async-DblfZHmo.js\":\"939f1951d472d7c6\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1846/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1846/chunks/AccessHandlePoolVFS-Czf84WuY.js\":\"be3f8ee463ca14f3\",\"/knowledge-medium/pr-preview/pr-1846/chunks/FacadeVFS-CWP6ndEF.js\":\"bfd2777614b83ab8\",\"/knowledge-medium/pr-preview/pr-1846/chunks/IDBBatchAtomicVFS-CxLf4nSM.js\":\"a99fa78c3efa3123\",\"/knowledge-medium/pr-preview/pr-1846/chunks/MemoryVFS-CPLpIE4x.js\":\"019824a32751bc82\",\"/knowledge-medium/pr-preview/pr-1846/chunks/OPFSCoopSyncVFS-CduPVemL.js\":\"10d95758a1460a38\",\"/knowledge-medium/pr-preview/pr-1846/chunks/OPFSWriteAheadVFS-CTHqc2MN.js\":\"0c6f9dab25d66b29\",\"/knowledge-medium/pr-preview/pr-1846/chunks/Preview-CryT20b5.js\":\"3884cdee95814842\",\"/knowledge-medium/pr-preview/pr-1846/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1846/chunks/card-3lwl-th9.js\":\"7a2f3a58349371c2\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-6hB4LiXi.js\":\"4787f9555ba6cdf0\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1846/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1846/chunks/mc-wa-sqlite-BBDmmTOX.js\":\"1cbd2b9a5c82007f\",\"/knowledge-medium/pr-preview/pr-1846/chunks/mc-wa-sqlite-async-BAb8TCGe.js\":\"9f1520728616cb99\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-BeJNGDC3.js\":\"0d64b641a44f84fb\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-Bi8ogAs9.js\":\"5fd9a98668277e5f\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-CXfr-f8C.js\":\"7657355a9d337bb1\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-D7ktU5cr.js\":\"75b3b58145983112\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-DgViXgMs.js\":\"38ceb7a835ba8a52\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-Dh4UokoX.js\":\"e4c104dbc99d946a\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-Dh9ag8qx.js\":\"0d92efc9b7a956fb\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-XiFFeAol.js\":\"334bec33c535816f\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server-legacy.browser.production-D-nE8zYb.js\":\"a9e806735cba4935\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server.browser.production-CKM0tIGv.js\":\"17a35238c297322d\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server.edge.production-C6th1_IZ.js\":\"213077fb79496bb0\",\"/knowledge-medium/pr-preview/pr-1846/chunks/server.browser-C35H273o.js\":\"273b5bed922a2753\",\"/knowledge-medium/pr-preview/pr-1846/chunks/textarea-LkaImiNZ.js\":\"1c595c3c1b867b5b\",\"/knowledge-medium/pr-preview/pr-1846/chunks/ui-CjQAh2Rq.js\":\"c4fc9a1e66524950\",\"/knowledge-medium/pr-preview/pr-1846/chunks/wa-sqlite-DRxP6gag.js\":\"c04e8508e75ead41\",\"/knowledge-medium/pr-preview/pr-1846/chunks/wa-sqlite-async-Cu4l9yQT.js\":\"2ed8c37398349730\",\"/knowledge-medium/pr-preview/pr-1846/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1846/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1846/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1846/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1846/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1846/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1846/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1846/src/App.js\":\"5cd651a7c615c5f7\",\"/knowledge-medium/pr-preview/pr-1846/src/appUpdate.js\":\"2e5fef820324bcb6\",\"/knowledge-medium/pr-preview/pr-1846/src/appVersion.js\":\"94988315821e7557\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/initialLayout.js\":\"9893a52eb1c64dd7\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/openWorkspaceData.js\":\"ef0e52c570b2e85f\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/resolveWorkspace.js\":\"5f592ce5a118e836\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/workspaceBootstrap.js\":\"74f7c19cc19dc7be\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockComponent.js\":\"0fc180c60382cd6a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockCrumbs.js\":\"a2f8dcecd0ade46c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockEditor.js\":\"95b19a7328ce15b3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockLoadingPlaceholder.js\":\"0fb5cbf866a5fea7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockProperties.js\":\"449988d5c54f3aba\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockSearchPicker.js\":\"e7fee8c4618e4b54\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ConfirmBulkDeleteDialog.js\":\"7eaf22875a19d3bb\",\"/knowledge-medium/pr-preview/pr-1846/src/components/DividerHandle.js\":\"5b263fa407a1ded4\",\"/knowledge-medium/pr-preview/pr-1846/src/components/DraftEditor.js\":\"bc82e19da13cea11\",\"/knowledge-medium/pr-preview/pr-1846/src/components/GutterPill.js\":\"c75792062f93b4a0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/Header.js\":\"38deb70283c0724f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/LazyBlockComponent.js\":\"dd36df1c9d28dd00\",\"/knowledge-medium/pr-preview/pr-1846/src/components/Login.js\":\"fb132e5153b8c8ac\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ZoomableSurface.js\":\"03f30f6caacb75c9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/editModeKeepalive.js\":\"591446083d1c2dbc\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e891e2f02b28fc7d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"52935dbb4af825e2\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/RefPropertyEditor.js\":\"9a38cee7279d674d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/RefTargetTypePicker.js\":\"fe74c7d55a6056bd\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/SelectPropertyEditor.js\":\"7c0d74dcbad51620\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/TypesPropertyEditor.js\":\"2841d22986ac56c1\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/defaults.js\":\"25ba029f518ff3ed\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/kernelValuePresets.js\":\"122927ff4372f246\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/selectablePresets.js\":\"f3a4fa3eac441a29\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/typesPropertyUi.js\":\"cb267d9dc2232502\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/AddPropertyForm.js\":\"ca835c7c8c49903d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/PropertyPicker.js\":\"34b205615fb9b30a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/PropertyRow.js\":\"0f5eac876bcd66ed\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/Rows.js\":\"fa9d8fc4f8cc433d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/actions.js\":\"46d468965c47e711\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/declarationOnly.js\":\"eecc4823999bd95f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/layout.js\":\"c7d02d5640baef16\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/model.js\":\"651c400269cb35d7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/shapeUi.js\":\"37949bdf4f7e7fa3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/shapes.js\":\"478f6328edb9520a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5b7d6f5ebe5ee228\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/visibility.js\":\"7394a12db856dd01\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanelSections.js\":\"6a05851dbc4a701a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockEmbed.js\":\"ef3055afe1f83c2b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockLink.js\":\"9637af4cf5aaefee\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockRef.js\":\"b3853a9e0a97efc5\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/ReferenceLink.js\":\"5c9a803093c047df\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/cycleGuard.js\":\"11efcaa69f115c63\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/cycleGuardContext.js\":\"1224645e36053100\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/linkInteraction.js\":\"a652a589bdeaeebf\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/referenceLayout.js\":\"8d8455e8f1a830b3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/useBlockRefAncestors.js\":\"1fa416a2917c4359\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockGutter.js\":\"7ab7dedf5a868245\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockInfoDialog.js\":\"2647f4dbd9054e2f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockTypeBlockRenderer.js\":\"8af961051f94801b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BulletHoverCard.js\":\"c9caa061adf3a21e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/CodeMirrorContentRenderer.js\":\"5ee6f36b8cd4ea71\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"82e62efeb3c61f5f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/ColumnResizeHandles.js\":\"f24c1171153ee7a7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"2865fa326acf271d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/DefaultBlockRenderer.js\":\"bb802a062541fe89\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/LayoutRenderer.js\":\"bc2f7e5233d1051b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/MarkdownContentRenderer.js\":\"fa3f74d5b3c0f840\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/MissingDataRenderer.js\":\"680aa54544bb50b2\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/PanelRenderer.js\":\"fbe47072ca3c7540\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/PropertySchemaBlockRenderer.js\":\"69cae057eb87e5b9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/TopLevelRenderer.js\":\"a77de09d2f075d23\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/blockGutterMode.js\":\"549a060ad2d5355f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/blockTitleText.js\":\"df0e1c6b9878a488\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/fieldCreationKeydown.js\":\"b799308e7104e1e3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/layoutRootContext.js\":\"b186a9eaff4b33cb\",\"/knowledge-medium/pr-preview/pr-1846/src/components/typeChip/TypeChip.js\":\"8319894fd66ca3da\",\"/knowledge-medium/pr-preview/pr-1846/src/components/typeChip/chipStyle.js\":\"830ee4765530c918\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/anchored-floating.js\":\"d90d6be968b58946\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/button.js\":\"22ba53cb19ceaec0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/card.js\":\"5572adced40e6ac5\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/checkbox.js\":\"9744895456c61edd\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/collapsible.js\":\"f1596a5923f61a98\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/command.js\":\"0fb35406fbb76788\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/context-menu.js\":\"d85b4b576ef41db9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/dialog.js\":\"0f5e7bce56c311b6\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/dropdown-menu.js\":\"e52dbf3f0d1ad164\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/floating-listbox.js\":\"59a0b70edde7ac02\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/index.js\":\"8d246c50105d70ba\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/input.js\":\"f3677579aa2c2aba\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/kbd.js\":\"7196df3e1d3971b0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/label.js\":\"951eb17cdec2ad17\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/textarea.js\":\"2cbb3659714e53ab\",\"/knowledge-medium/pr-preview/pr-1846/src/components/useEditModeYieldKeepalive.js\":\"f47e5dac01b98107\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/BootFallback.js\":\"12b7b51963cf4a10\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/FocusedRowLazyMount.js\":\"f8a63eabea081171\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/LazyViewportMount.js\":\"aa437c39855d625d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/LocalDbCorruptionFallback.js\":\"81d1384f86161833\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/error.js\":\"066bf27a6dc6ceda\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/lazyMountRegistry.js\":\"ebb3348832c368e9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/suspense.js\":\"d30e9661f7c3a753\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/CreateWorkspaceDialog.js\":\"c9fc3de10c582cdd\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/PendingInvitations.js\":\"d291627584546829\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/SyncProgress.js\":\"485baecb8fe56d34\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/UnlockProgress.js\":\"820ba37a97b6d3d3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceKeyGate.js\":\"c3f5d6760b0e2519\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSettingsDialog.js\":\"46e0869b9960f027\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSwitcher.js\":\"0342a7bf7ba5d69d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSyncGate.js\":\"707e151cc0ac5bd7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/ConversionFlow.js\":\"d7437a71c5d7fa65\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/ConversionFlowHost.js\":\"0ddf938da921a203\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/EncryptionSection.js\":\"dbdf85785be14d6b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/attachmentPrompts.js\":\"d874636c9845b3c6\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8804db9b9c7e6c07\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/conversionFlowDeps.js\":\"1ea5307dc2e0b599\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/conversionFlowStore.js\":\"9b3b9b36e34df5b3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/flowUi.js\":\"f3eb76e5fdb8aaa3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/useConversionRun.js\":\"bdfb719d8dab81d3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/keyUi.js\":\"2873e785279d3c23\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/useCloseOnKeyLoss.js\":\"aa96f2a87dda64f0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/useCloseOnServerE2ee.js\":\"6bd4b4c80f42f8b5\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/workspaceUnlocked.js\":\"2e0310f1b39ce6b8\",\"/knowledge-medium/pr-preview/pr-1846/src/context/backgroundSubtree.js\":\"29ac981836ed90c2\",\"/knowledge-medium/pr-preview/pr-1846/src/context/block.js\":\"b03e7197255d56ec\",\"/knowledge-medium/pr-preview/pr-1846/src/context/layoutWsContext.js\":\"80a84c0648a0b098\",\"/knowledge-medium/pr-preview/pr-1846/src/context/propertyDisplay.js\":\"6f6737d568eac21c\",\"/knowledge-medium/pr-preview/pr-1846/src/context/repo.js\":\"ec99aa0a01bdf10f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/aliasClaim.js\":\"1570bec8c6ccfe44\",\"/knowledge-medium/pr-preview/pr-1846/src/data/aliasSeatNamespace.js\":\"22f9eea9064b05c9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/blockData.js\":\"3321bc5e57177ccd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/blockType.js\":\"cc6bad257a8825b4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/changeScope.js\":\"bd582eeac4da1444\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/codecs.js\":\"9b757085418cfc3d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/derivedData.js\":\"0d282bc12f99a320\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/errors.js\":\"e8ab7915317cd92a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/events.js\":\"aa75fd560ef401f3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/handle.js\":\"82cdd3ec69cff7a6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/index.js\":\"df790117966fa91c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/mutator.js\":\"92d9da4ea1c19a88\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/processor.js\":\"49a3b777ffc644ff\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/propertySchema.js\":\"8754d25198ab7a61\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/query.js\":\"cdf715f64487034e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/sameTxProcessor.js\":\"f1fd238a0ed951ae\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/schema.js\":\"82cdd3ec69cff7a6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/tx.js\":\"82cdd3ec69cff7a6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/typedBlockQuery.js\":\"1899d4f1843dcba0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/user.js\":\"b68a7278ce2d2de1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/valuePresetCore.js\":\"c927812476c523cb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/valuePresets.js\":\"3d7a9dc19c7bc747\",\"/knowledge-medium/pr-preview/pr-1846/src/data/attachmentCleanerIOVerb.js\":\"5519888ab8b92dca\",\"/knowledge-medium/pr-preview/pr-1846/src/data/block.js\":\"7a1e13b97a945cfb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockCache.js\":\"2742b5102f5c288e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockId.js\":\"93641315b103f1d9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockLiveness.js\":\"e34452ca3034a1db\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockMerge.js\":\"5d97d19c02a8a30c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockSchema.js\":\"f5bfa415e2cfe328\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockTypeLookup.js\":\"b02435a647770e3b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockTypes.js\":\"19b2e52df8174288\",\"/knowledge-medium/pr-preview/pr-1846/src/data/clientContext.js\":\"6077da7182f972dc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/dbFileSiblings.js\":\"c93632d0e9449c4d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/definitionSeeds.js\":\"a69821daf5f91b76\",\"/knowledge-medium/pr-preview/pr-1846/src/data/derivedIds.js\":\"3bf9fcab0cf891e4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/drawnSubtree.js\":\"4924d10a277bca16\",\"/knowledge-medium/pr-preview/pr-1846/src/data/facetBridge.js\":\"084e6acffc3c33f4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/facets.js\":\"ed22995fb74e6e86\",\"/knowledge-medium/pr-preview/pr-1846/src/data/globalState.js\":\"8756bad1a41a54b4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/aliasClaimRederiveProcessor.js\":\"c266cfc609b0eb7b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/ancestorBatch.js\":\"8964da1abc5e6c62\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/blockTypeTypeifyProcessor.js\":\"8fdb541e606b1881\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/clientSchema.js\":\"357adfb60ecfeeb6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/commitPipeline.js\":\"7560d1433ebe5afd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/devAssertions.js\":\"114f626619c6f6dc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/firstSync.js\":\"cf31c123b6d41ee7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/freshInitialLoad.js\":\"b85ec3b1fe23ad1a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/graphBackfillClaim.js\":\"6d864763733d6a64\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/handleStore.js\":\"88e89a0ef0872765\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/idleMarkerJobs.js\":\"79dcb460ab932ae0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/initialDownload.js\":\"0bd0694063a9175e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/initializeClientDatabase.js\":\"0f51acd75b5d6c41\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/jsonCanonical.js\":\"51baf70da2966709\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelInvalidation.js\":\"c0d48a2fe742abe6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelProcessors.js\":\"2f2f8b3882b56352\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelQueries.js\":\"d76ea4ecae5bde4e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/mergeTypeMembershipProcessor.js\":\"4c87a734cb23328f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/normalizeReferencesProcessor.js\":\"e88aa59b6ea62124\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/poolInstrumentation.js\":\"5f2edd7c8778cd75\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/processorRunner.js\":\"905613531cd7f02c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyCellBackfill.js\":\"1cb1c1a29f8dd2d7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyChildMint.js\":\"2f04a6af1e102f23\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyChildrenProcessor.js\":\"67b1ca12c78a63ab\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyDefinitionChangeProcessor.js\":\"96189fe8a7e5d1fe\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyDefinitionSynthesis.js\":\"1db0fd6497d148f9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyKeyScan.js\":\"b574d85706878169\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertySchemaResolution.js\":\"eaf9c95f1e130608\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyValueEdits.js\":\"a3b043eade2ac91a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/raiseProtocol.js\":\"4834519c86e25e0a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/readBatch.js\":\"db0a2b3f86f3b027\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/refProjection.js\":\"8a75337fbdd83fae\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/referenceTargetLookups.js\":\"bfa04c53b79e1f6e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/referenceTargetProcessor.js\":\"b0114b0fb4e92794\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/replayMerge.js\":\"20fbe9857575c0cc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/sqlBinds.js\":\"ca23f1a4ed9ded06\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e9b0e20d8cfc3333\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/arrivalProcessors.js\":\"56d465c9e5a43892\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/invalidate.js\":\"c0181cf8f2f42bea\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/materialize.js\":\"cddeea24b8901049\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/observer.js\":\"5dfc590abf5f6bc0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/reconcile.js\":\"c5115ae07e0b3865\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/timingMetrics.js\":\"cb4a95c2695ade2a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/treeQueries.js\":\"4f47352ef066d2da\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/txEngine.js\":\"fe7ab380e616594d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/txSnapshots.js\":\"a7449c6fbaa636e3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/typedBlockQuery.js\":\"8b199ad2d15058c6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/undoManager.js\":\"4305cd18600f48e0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/invalidation.js\":\"7dd356cf0d4408c4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelDataExtension.js\":\"ee50385fcff84898\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelPage.js\":\"f476f10e03c1a6cb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelValuePresetCores.js\":\"fe4e42f0181e50c9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbCorruptionSignal.js\":\"daaec8437eeed79a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbStorage.js\":\"0f910ad426ff3868\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbVfs.js\":\"e2cfd85b70e1e88b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localSchema.js\":\"5daad3d3329c8faa\",\"/knowledge-medium/pr-preview/pr-1846/src/data/maintenance.js\":\"b4ce3ef47e518ba3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/mergeProperties.js\":\"8b998552a64fb2e6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/metricsConsoleHook.js\":\"2c3fc1d924dbdf35\",\"/knowledge-medium/pr-preview/pr-1846/src/data/migrationsPage.js\":\"c057056f102dfe73\",\"/knowledge-medium/pr-preview/pr-1846/src/data/mutators.js\":\"37309aba7c8065f7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/orderKey.js\":\"1ebba222b882cb12\",\"/knowledge-medium/pr-preview/pr-1846/src/data/orderKeyPlacement.js\":\"0926f61fb49df61c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/outlineSurface.js\":\"22fa00caa56f97a8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pendingEditorContent.js\":\"adc017fda646dc60\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pendingUploadsSql.js\":\"58511acbbc08cb75\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pluginStateExtensions.js\":\"885096832b7aad56\",\"/knowledge-medium/pr-preview/pr-1846/src/data/powerSyncLogger.js\":\"87c766ec0f9a8541\",\"/knowledge-medium/pr-preview/pr-1846/src/data/projectorRuntime.js\":\"79bedccf1c9c9e2c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/properties.js\":\"561ccf1566cc124c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertiesPage.js\":\"29569d843862f6fa\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyChildren.js\":\"419f1a6b790d010e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionFanout.js\":\"b0757b9c7261fd8f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionMetadata.js\":\"762e6992f014dc93\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionRegistry.js\":\"3cd86309801fd6e2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDisplayMode.js\":\"cd07ab8f0bdc7997\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyRowCreation.js\":\"e25aa12ccbf04b6a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertySchemaCreation.js\":\"548580f141535433\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertySeeds.js\":\"56051f2f59fb708d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/recentsPage.js\":\"a599ae2c04584bce\",\"/knowledge-medium/pr-preview/pr-1846/src/data/referenceBlock.js\":\"ad5ce89d85a2f597\",\"/knowledge-medium/pr-preview/pr-1846/src/data/rejectedUploads.js\":\"88da007073973b50\",\"/knowledge-medium/pr-preview/pr-1846/src/data/releasePowerSyncConnection.js\":\"6b9199e1b30e3c6b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/repo.js\":\"03fa6603657ac6e3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/repoProvider.js\":\"5ca1850932f38448\",\"/knowledge-medium/pr-preview/pr-1846/src/data/rowProperty.js\":\"92b017159d8b5f51\",\"/knowledge-medium/pr-preview/pr-1846/src/data/searchFilter.js\":\"9922051e7116389c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/seedIdentityLedger.js\":\"d39e07d9a4e3d6f6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/stateBlocks.js\":\"0986896cadb0dbdc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/structuralEditPolicy.js\":\"8e1b3b4e7a0a379e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/subtreeDelete.js\":\"037f3dee32c71063\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncStreamLock.js\":\"98a66d233705a3f2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncedTableSqlRecognizer.js\":\"eb34928f59b49bd1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncedTableWriteGuard.js\":\"88108175552b412a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/targets.js\":\"f5247aae83da8876\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeColors.js\":\"079a66b6c94a79ec\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeDefinitionMetadata.js\":\"7cf10ca1e5444a4c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeDefinitionRegistry.js\":\"6cff4e27f15dfeff\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeExtraction.js\":\"31fd1f1452d456a5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeInitialValues.js\":\"182a1c45a27effe2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typePropertyGroups.js\":\"c7ddf31a2b19a777\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeSeeds.js\":\"2d1d26c89848c821\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeTagger.js\":\"790505f273a73482\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typedRecords.js\":\"b0d67a362d2ccaad\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typesPage.js\":\"f5c5bcd57cd96e81\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userPrefs.js\":\"08b7a9eb972988fb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userSchemasService.js\":\"e283059e3c1cde0b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userTypesService.js\":\"9b77c1b5fc326f0d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/valuePresetRegistry.js\":\"7598c9e3fe336e84\",\"/knowledge-medium/pr-preview/pr-1846/src/data/visibleChildren.js\":\"800a6889be941996\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceConversion.js\":\"c7bd9fe16c03eb68\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceFirstSync.js\":\"e826a249e1719e2e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceIdNamespace.js\":\"8164049c0df4c2ab\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceSchema.js\":\"43aac8f4a97153b2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaces.js\":\"5c04a4a837e69bbd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/writeAheadLog.js\":\"1867de7b24e0c546\",\"/knowledge-medium/pr-preview/pr-1846/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/BlockPasteShellDecorator.js\":\"5964b5fa5f0f3292\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/atTrigger.js\":\"ad7ee4b002c4712e\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/autocomplete.js\":\"e0871b75cf2e66a8\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/codeMirrorExtensions.js\":\"305b19ab34042cba\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/contentFlush.js\":\"01ad99be99563c10\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/defaultInteractions.js\":\"194d5381d95100de\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/editSettleSignal.js\":\"448ac85662997ea1\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/insertImage.js\":\"badfff0ddc244c72\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/referenceCompletionRange.js\":\"6bcd1a2c3efe7df5\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/referenceTargetTypes.js\":\"6a44c9d194fdeb4d\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/syntaxContext.js\":\"68e2f01471705665\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/triggerMatch.js\":\"f6481df923b3a442\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/AppRuntimeProvider.js\":\"f77ee26be68c2bc4\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/BlockFocusShellDecorator.js\":\"b60febbd31f0d2b3\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/ExtensionRenderBoundary.js\":\"1b72132fb482a337\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/PanelContentRecovery.js\":\"8272caa95a0f5320\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/apiCatalog.js\":\"3247aeafe9ccae2e\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/approveExtensionHere.js\":\"2a4992a264c6f1a8\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/armedCutAppMount.js\":\"576b40c2e6cfa17d\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/batchableKeyedStore.js\":\"77d4e8528fc1c19b\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/blockInteraction.js\":\"8ae04066ea9203e8\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/blockSelectionAction.js\":\"794bb8499cd9287b\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/compileExtensionModule.js\":\"0046bfc67a6b828a\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/compiledModuleCache.js\":\"feecced440514c2f\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/continuousGestures.js\":\"05c21c0ec4e53860\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/core.js\":\"a78c4a801643a38c\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/defaultRenderers.js\":\"7c4f0f244b85b8c2\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/definitionFanoutAppMount.js\":\"10941a740a649f87\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dialogAppMount.js\":\"d0bfcf07eee6ee35\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dynamicExtensionSeeds.js\":\"a80f54e009b4afa4\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dynamicExtensions.js\":\"8b6be892a969bcef\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/exampleExtensions.js\":\"d4cbd088400205ca\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionApprovalStatus.js\":\"ce275130faabb2f0\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLoadErrorToast.js\":\"7e47910b4fb760a2\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLoadErrors.js\":\"e4611bcd2e939da9\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLookup.js\":\"f578cf75862cd220\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionToggles.js\":\"96192de619e3ee44\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionUtilitiesCss.js\":\"0712016781897fba\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/kernelPageDeletionGuard.js\":\"68bcf10571bdfcff\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/liveRuntime.js\":\"8c9b717a70ffd4cd\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/openExtensionsSettings.js\":\"8cc43612fa7d61d8\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/overridesCache.js\":\"8af2d4264f8389c7\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/pluginIds.js\":\"05f46b09d5a63c16\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/processorRejectionToast.js\":\"36fa4d3924d2d6ef\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/runtimeActions.js\":\"7bea09cf2ac7550d\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/runtimeContext.js\":\"63fbd04f6456606e\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/staticAppExtensions.js\":\"4415715c8d73475e\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/staticDataExtensions.js\":\"3f7672e3d90960b3\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/toastAppMount.js\":\"b5200c2a664204a1\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/useOverrides.js\":\"cdb2995776629d70\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/useShortcutSurfaceActivations.js\":\"9c5fbbb10b8be5b2\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/discoverToggleTree.js\":\"343416b27d374f35\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/facet.js\":\"973a25adefc288e4\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/resolveAppRuntime.js\":\"2a5379c0b9cbccd9\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/runtimeEvents.js\":\"30c78f9692a33807\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/togglable.js\":\"1ad51d3a8f3e859b\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/variantFacet.js\":\"24fe25e3b3a83dda\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/verbFacet.js\":\"c9735409a4524189\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/block.js\":\"5f62ffd7a71ceffc\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/focusedChild.js\":\"547fea863e26fcaf\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/propertySchemas.js\":\"fca930eb32140f00\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/typeRegistry.js\":\"6a2137a7ce0b6e8e\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useAncestorCrumbs.js\":\"6577dfa49b64e879\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useAutocompleteListbox.js\":\"bae2af17639a8c1e\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useDebouncedSearch.js\":\"37cbb3507295ff0a\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useDebouncedValue.js\":\"ac6e3a4b2111210e\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useIsFocalRender.js\":\"9456bff56047da14\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useIsReadOnly.js\":\"a32369baf108d441\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useMaterializeBacklog.js\":\"18b055e561375465\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useMinuteClock.js\":\"e4faf597ff935a7b\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/usePanelLayoutProjection.js\":\"9fd7798802153af4\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/usePendingInvitations.js\":\"1ef41aed685ed2a5\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useRendererRegistry.js\":\"9e7c4a59b7e916b9\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useRetainedFieldRows.js\":\"fd73427a0983b812\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useWorkspaces.js\":\"06275e53cbcca07b\",\"/knowledge-medium/pr-preview/pr-1846/src/lib/utils.js\":\"4d8260b218879124\",\"/knowledge-medium/pr-preview/pr-1846/src/main.js\":\"fd52582e09f4166e\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/MarkdownImage.js\":\"14c2f3f2655734ca\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/blockSeparators.js\":\"36fd8b7d1ecfff3f\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/context.js\":\"33d3e3c91c71c993\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/defaultMarkdownExtension.js\":\"d30545fd986d9a9d\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/extensions.js\":\"7899fb63ce577cf2\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/renderMarkdownHtml.js\":\"939ec1d2744d170b\",\"/knowledge-medium/pr-preview/pr-1846/src/minimal-editor.js\":\"2d79141092473fe7\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/armedCut.js\":\"edf8af02b496a7a8\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/captureMediaVerb.js\":\"5cfc75df60bf0b2a\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/clipboard.js\":\"3fa4ba0cfece3d37\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/decision.js\":\"42d598075d5f5899\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/operations.js\":\"82b2c402cc9a6889\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/account-header/AccountHeaderItem.js\":\"a0f34956b16e1017\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/account-header/index.js\":\"8fcf8dead335468f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"6d251674a526a972\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/askAgent.js\":\"789e214fb346ce28\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/askedStore.js\":\"efb7db6570d1c07e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"06f8ba9c266ddf66\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/chipState.js\":\"01f6696f34384540\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/dataExtension.js\":\"95bafa71d09c2540\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/index.js\":\"586e2cceb586bfa8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d29f66357ca7e163\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/schema.js\":\"2cc9f5e3a580ae2f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7273d00236d5a76d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/BridgePairingDialog.js\":\"cda9a73651502db5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/addMedia.js\":\"ebcf0127c6e576af\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1b5aeef75ff50efb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/block.js\":\"eead5d174998c7aa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/context.js\":\"43fb104790ef197e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b5c5ed9e7f6c420a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/index.js\":\"f5d1f6356106fe66\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/outline.js\":\"8496803031a975d6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/properties.js\":\"aa6f6df71147e498\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/refs.js\":\"79b6e68be1af3e5a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2c5067a0ba41287a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/search.js\":\"5896d0a129b064ff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/shared.js\":\"05ac22a77282e52d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f24c6ee4f94cdf81\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/text.js\":\"3e69660fc9bd4d27\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentWrites.js\":\"8db3df4e9ad6e25d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/authoringCatalog.js\":\"8f73d9501df903da\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/blockRefTargets.js\":\"a85e3e8817a02fb2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/bridge.js\":\"d257c0f5bebef978\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/bridgeLoop.js\":\"09605835a9561d6e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/changeHistory.js\":\"1632adb64290504a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/commands.js\":\"93a59af83d487d52\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/commentsCommands.js\":\"f891e84db1e2ce52\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/dataExtension.js\":\"aa663320ea63626f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/dataModelGuide.js\":\"a15081206b896477\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/describeRuntime.js\":\"6fb91a4cfcbff8ff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/extensionLint.js\":\"5ac2d2f27796cd93\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/grainAudit.js\":\"120c6228501891d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/healthCommand.js\":\"05e823006ac9cac8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/index.js\":\"fd374de3e2f3c2ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/presetIdentity.js\":\"4dae4e2ce6984c6e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4155c3048e5a07d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/readMedia.js\":\"6ae217680c26fb23\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/schema.js\":\"0bd2bddc8173d834\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/serialization.js\":\"1b8d6a8068a26454\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/targets.js\":\"4ef2e9ce7ad8edd4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/tokens.js\":\"660608253f477e54\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/watchEvents.js\":\"3b031d9c86cbf48f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/workspaceGuard.js\":\"5fae2b85a5a25ead\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/writeCommands.js\":\"70c3a0d27ff1b94a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/AliasCollisionToast.js\":\"b6aaed448c05b6ee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/DuplicateNameBanner.js\":\"43ee9ba67e4c1317\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/collisionMerge.js\":\"83ff06dd442729d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/dataExtension.js\":\"1c848c87d10f3eaf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/index.js\":\"484318d45cebdbc3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/mergeCollisionAction.js\":\"f99fbf7c1160b348\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/pageStyling.js\":\"aa2de2237f336823\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/rejectionToast.js\":\"f6f005cf1bdf9cd0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/syncProcessor.js\":\"a8c65db21b8c04be\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/actions.js\":\"9c01a1feba019006\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/addComment.js\":\"3ec0d517ffa7fc9e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/anchor.js\":\"e60212bac2982855\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/anchorState.js\":\"0e01ea5ccec2f332\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/commentLinks.js\":\"bb009a87fdf34a85\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/confirmThreadDeletion.js\":\"a43e97784bfc6b75\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/container.js\":\"1caee70739d28e3e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/dataExtension.js\":\"37ca047a9a182354\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/deleteComment.js\":\"4615be3fa22c1c85\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/highlights.js\":\"a205db36f8a7cbb6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/index.js\":\"b0cd9e6809c98a28\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/linkedCommentsPill.js\":\"90b13e9699109fb5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/margin.js\":\"0e52632f76c5164f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/marginSchema.js\":\"a62d1dc5f211ded9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/newComment.js\":\"f1e8693baad188dd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/ownThreadPicker.js\":\"0283e7ac4c3d2b72\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/placement.js\":\"108473a9e93abb5a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/queries.js\":\"2770955efc7c68b3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotePosition.js\":\"4939d87da4954363\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotedIn.js\":\"a7150b59306a11a6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotedRange.js\":\"7489e22e395ff394\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/rangeRefs.js\":\"72cdd5a2b028021a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readHighlights.js\":\"f6ecd98ad5e93804\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readSelection.js\":\"0c8c07d655d48661\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readSelectionUi.js\":\"d6c857e94838225f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/reanchor.js\":\"dd8f0f1bb4ffde2b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/schema.js\":\"59038f64740bb8ae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/scope.js\":\"099dd723eb8e3d21\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/scopeThreads.js\":\"40aa30a04b38160b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/splitRetarget.js\":\"f80cf6ec5d3cd4c5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/suggestionCard.js\":\"c460dbbe9d255674\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/suggestions.js\":\"523b2258bb6e0d5e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/summaries.js\":\"2bd78cca8dc5f0d4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/summaryBatch.js\":\"a5637f958e59f445\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/surface.js\":\"365b0e7c0cdef3cc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/threadNavigation.js\":\"5a7252ae234dc780\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/threads.js\":\"bd4900af5cc476ce\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/ui.js\":\"48795a22d0c3af9e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/uiStore.js\":\"b07444c5738a4bee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-intents/appIntents.js\":\"38ffb01ac04120fe\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-intents/index.js\":\"41ee8f5ab0261b3e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-update-prompt/index.js\":\"d0aad54c2ba2b267\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-update-prompt/status.js\":\"dd207a39ddcd0dde\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fda690784477dab3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaBlockRenderer.js\":\"79c7cd1c5cdd02d9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d64684b066753ad3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaUploadReconciler.js\":\"857a94d9ecf55995\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetDownLane.js\":\"6434d14cfa878a18\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetResolver.js\":\"5e9b37a1613bbe46\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetUpload.js\":\"0e859c4e01460093\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/attachmentCleanerIO.js\":\"cb76b987e34b1938\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/supabaseAuditIO.js\":\"45567c5c055805b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/blobStore.js\":\"7404ba0c91eec726\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/byteStore.js\":\"f0dcc76e36f186d1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/cleanerIO.js\":\"412e4551ccf77186\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/cleanupAttachments.js\":\"e8d824e7030b360a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/dataExtension.js\":\"b3ce221e29f9bce0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/downLane.js\":\"e361e55a0bc7c29c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/index.js\":\"8c2ff56a47cb3f1e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/insertImageContribution.js\":\"f2afca75d3217a95\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/laneArming.js\":\"680db53487fea684\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/laneLock.js\":\"baf2564aa805f3f7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaBlock.js\":\"221b849fcfba930e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaCapture.js\":\"33012339102d2de5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaViewers.js\":\"04b6f8624c91533f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaViewersFacet.js\":\"718d6a8a34ff0491\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/pasteCapture.js\":\"701557629533b144\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/resolver.js\":\"c4bc29f955edf0ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/retryUploadsAction.js\":\"38c7467445a6cfe9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/storagePaths.js\":\"3b30489be5cfb053\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadDrain.js\":\"d94c3cc8b93ffd3f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadLaneStatus.js\":\"78248f0b752f67a9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadReconcile.js\":\"ec93492fc7bc3394\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadRecovery.js\":\"662d208a0e3521d4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadStore.js\":\"278b90eb85ef68b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/useAssetObjectUrl.js\":\"ebfa265596c3f994\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"044b3292b757657a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/BacklinksViewSection.js\":\"64602601313734a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/facet.js\":\"5fb2ac0c1b86e715\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/index.js\":\"15a4e1bfbe4c6a07\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/prop.js\":\"6e39caad0ecb79dc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BacklinkFilters.js\":\"b60831e5300d82e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5e337d88f73f4d17\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BlockEntry.js\":\"7b87c6f88eb4e4d3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/LinkedReferences.js\":\"9095c922f33b2ea9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5ff51bd23c99f8d7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/dailyNoteDefaults.js\":\"171f95be523fd7ad\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/dataExtension.js\":\"ce54d57a5e6b98f3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/edgeExclusions.js\":\"18b496d617770244\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/filterProperty.js\":\"ee9ddfe2cf2307a6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/index.js\":\"3d422832a2ef25ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ff2ceb4537c29877\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/applies.js\":\"edaebd9e94a3c785\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/countQuery.js\":\"05ef706e1e27192b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e3f570d4c4d79f0a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/index.js\":\"cd4cec576bd85994\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"be9562df812b3c4e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/presentationInvalidation.js\":\"98c8f1b092ade83e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/propertyEditorOverride.js\":\"45658de2a8bc640b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/propertyFilter.js\":\"f391d61a87646689\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/query.js\":\"db954b0c38a0b45a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/resolveFilter.js\":\"91b939648b5416cb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/sourceBatch.js\":\"231d84d08dd8b198\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/sources.js\":\"c65c632cfd34d200\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/useBacklinks.js\":\"843079e104aca169\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"65339d6d9610d22b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/BirthdayCelebration.js\":\"c0d02b3d4075252a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/BirthdayOverlay.js\":\"681777f465bd3fca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/gate.js\":\"188614a2a52f0fc9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/index.js\":\"ab936ca55223cc99\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/wolfTheme.js\":\"92b240aba889be10\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/BlockDragLayer.js\":\"f7f76e24b6358e1b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/dragController.js\":\"34adec8152de56f0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/dropTarget.js\":\"71a09c4095fe7d4e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/index.js\":\"02e0bdfc73eeeaa0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/projection.js\":\"ea34c55b6607e710\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-info/BlockMetaCard.js\":\"1f8a35c6e91e9733\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-info/index.js\":\"5725518036536dec\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/AddTagDialog.js\":\"389831d6f55b3178\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"add9026bda568d38\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/TagNameIssueHint.js\":\"75fce783a536acce\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/addTagAction.js\":\"007453e7dfb47f95\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/appendTag.js\":\"f12a7f040a94aeee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/config.js\":\"076bd606f2d4eb36\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/dataExtension.js\":\"9a17409e8661b6d6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/index.js\":\"64b7a522c4d193bb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/propertyEditorOverride.js\":\"2466bf5bafb26edb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/BreadcrumbList.js\":\"940b09c3467075ab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"148f2b56437224e8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6caecf31244695e4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"bd2e73b1f33f9e0a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9c84e21f8622174d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/index.js\":\"869b6a9d2fddfac8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"660db2c37a283ed4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/CharacterCountItem.js\":\"165d7e08b152d0dc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/ProfilePropertyEditor.js\":\"861ed0ae6a2da05d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/actions.js\":\"00f89132d54e83df\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/blockType.js\":\"c24f039474aac247\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/charCount.js\":\"5ad9ae0099e85811\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/dataExtension.js\":\"79a15a7e2214f026\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/index.js\":\"69610d5e5da10ad2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/profiles.js\":\"940ca18e61b1d7b7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/properties.js\":\"f4787467cc39b1b8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/textCounts.js\":\"c3f713aadeb65020\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/colemak-keybindings/index.js\":\"501b5a7b0781a1f9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/CommandPalette.js\":\"48cf0c0059f02b0d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/HeaderItem.js\":\"13cbc7537bbc997f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/context.js\":\"f2307f9dba0edd53\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/index.js\":\"89b93c326d1e121b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/selection.js\":\"d31a93f4e0141fbd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/toggleStore.js\":\"d9679edfae3c1296\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/useCommandPaletteActions.js\":\"dcf154f2bf36f5ad\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/ContributorBadges.js\":\"25f9383f76b11dfa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/author.js\":\"163ab1b38dcff039\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/codeMirrorExtensions.js\":\"772e57cbe2abb946\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/dataExtension.js\":\"2e10aa8eff514588\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/index.js\":\"0a143615bb105fbf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/mentionAutocomplete.js\":\"f7696fdf26c97311\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/processor.js\":\"17edc8085e008265\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/profiles.js\":\"2910e04f6e1a99f6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/queries.js\":\"1be014f5a7137cc4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/schema.js\":\"fb3f4403514318e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b9c0c6113a1aeada\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e30a84e0fc9535ac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/index.js\":\"ff19291d16e3b4c9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"10f18cf39d029ab8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e4d6b3d53f0b7552\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/CalendarGrid.js\":\"55853dfa3d8f8ae4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DailyNotePicker.js\":\"476544339830460a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4592190db85a5b37\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateNavDecorator.js\":\"bb369e5cbfb1a818\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateScrubOverlay.js\":\"4ed3ad525940703b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/HeaderItem.js\":\"a0ae21e61bcd02b1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/ReschedulePicker.js\":\"ec32d9ddc8207d67\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/SpreadDatesDialog.js\":\"09cc6e3a770f67f8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/actions.js\":\"319285fca33a8da4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/blockDateAdapter.js\":\"5f42fb2a8c79d0bf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/calendar.js\":\"a2c4c52de7e4d3c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dailyNotes.js\":\"646e19f55c9c5539\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dataExtension.js\":\"fab1d0ded4890662\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubActions.js\":\"32bbc137d4c540d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubGesture.js\":\"a8a838ebb7ab7c2c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d6c33419ce637fbd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ea3d34bded7276c9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/deletionGuard.js\":\"69bbee854268e6d0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dueQuery.js\":\"40359400fd714602\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/index.js\":\"5170febd95ea3d6d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/landing.js\":\"497a0406ea49fd33\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/localSchema.js\":\"4d645e47ee6dd2c1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/referenceDateAdapter.js\":\"42bea45cbfe8775c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/rescheduleAction.js\":\"208a2d74fa40c1ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/schema.js\":\"e93e268fab032c1c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/spreadBlockDates.js\":\"d32638dbfb50215a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/spreadDatesAction.js\":\"00c027f6f2861bcc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/today.js\":\"acb17b4c37954dea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"75a8ed5e2c64f7ac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5898d48c1d46820f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/audit.js\":\"9436701043523009\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/auditAction.js\":\"6351e81ef8b8922b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/auditRanges.js\":\"3025fca6ac88d210\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/diagnosticsSource.js\":\"e232a2625e1cb590\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/divergenceScan.js\":\"69f1733b0ac2985f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/index.js\":\"eb63b2524d6dd502\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/propertyChildrenChecks.js\":\"15d699a2b35eb2c6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/referencesMirror.js\":\"179d9ad129c7d885\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/rowJson.js\":\"79f05a12a0ffe5ab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/schedule.js\":\"5bf10f5cc16ea0bd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/store.js\":\"671fd5f6328317d5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/action.js\":\"f415bd35cf5b045c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/index.js\":\"45a6e61c924c1950\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/plugin.js\":\"bfd1239834d1e5df\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"17a261e09c117b0d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/actions.js\":\"9f0f17eed9261a53\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/changeMarker.js\":\"0c9afb7e9e76a0a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/diagnostics.js\":\"f23a9b0128e2fa36\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/fileSystemAccess.js\":\"52085369e62ce46b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/filenames.js\":\"5bd1fe2c8d51b9ed\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/index.js\":\"8fbd89e2efd24f16\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/mirror.js\":\"36443a78598ba919\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/runLock.js\":\"261722ea2341e581\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/runtimeHealth.js\":\"ae72e49d64cd04bf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/schedule.js\":\"2abb29e4a167eb9d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/store.js\":\"6f72230666d4fbb6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/default-themes/index.js\":\"a2b3c0e991d15731\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/default-themes/themes.js\":\"38af6b9018ffc684\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/diagnostics/facet.js\":\"8e55e53902dc0c54\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/diagnostics/useDiagnostics.js\":\"58de199baa3a83e3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/dismissals.js\":\"eafdf3af2974f8b1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/index.js\":\"3085575ef871d3e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/status.js\":\"5025cfbef6444f88\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/store.js\":\"5bdff8f27043f7c7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"560d54e57deaa8fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8d7341ec51792b3c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/actions.js\":\"31693cc40a02b993\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/config.js\":\"dc1b05cdfdcc5397\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/dataExtension.js\":\"e4d6e38142bc24ee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/effect.js\":\"542b80ed9965b301\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/index.js\":\"9a5de10d275d0e0c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/propertyEditorOverride.js\":\"175d8cde746b93aa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/useToggleTree.js\":\"0e263631c858befd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/ExtractTypeDialog.js\":\"cd468acbdc29690f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"bf526b7460edccb8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/PropertyShapePicker.js\":\"810d2398c6ceda41\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/action.js\":\"ff4b45239c2a6806\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/index.js\":\"6196aaf279cd0895\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/FindReplaceDialog.js\":\"b54f6a59e5ca97d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/HeaderItem.js\":\"a852f0cbda9e9a10\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/dataExtension.js\":\"3f1a8d83403bbfa5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/index.js\":\"4e39a8402dbdd43c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/search.js\":\"0d9477eb34bb9b96\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/toggleStore.js\":\"24f2f61ec2c82362\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/LocationPropertyEditor.js\":\"a12b664e7009d7e3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/MapView.js\":\"d22a2a06c54db63c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/blockTypes.js\":\"7caf5c7b72cd4ecc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/codeMirrorExtensions.js\":\"22708d76573d1b07\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/createOrFindPlace.js\":\"a78c1caa4659540e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/currentLocation.js\":\"889e7968ee49e516\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/dataExtension.js\":\"b4c1357c2ec02f1b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/geoContentDecorator.js\":\"905fe331b6a9e840\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/googlePlacesClient.js\":\"efb0ffd9673b753d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/index.js\":\"40be5fe03f42fefb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/locationsPage.js\":\"fe0579a29f9baad5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/mapViewport.js\":\"ca72bfaf927fd867\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/pickCurrentLocation.js\":\"e394f8c1177d1a3a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/placeAutocomplete.js\":\"09078a617b15b229\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/placeNameCollision.js\":\"bba0f05101b58139\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/properties.js\":\"bc536977382d35ab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/propertyEditorOverrides.js\":\"9e146abce5ab6f61\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/query.js\":\"b34f0a7e99480ff5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/usePlaceSearch.js\":\"015c76a36e414033\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"582950ec692fc765\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b48e60ecbe978b9e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4cf5158888ca2285\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/config.js\":\"75b4c388270871e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/dataExtension.js\":\"a9b1f107ecdc622c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/facet.js\":\"a0bca291cff6b9ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/grouping.js\":\"f8f4c8eb7393a523\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/index.js\":\"762f4ba73828c39d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a8d0adb2986c7226\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/query.js\":\"7a0cac54012554f8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/resolveConfig.js\":\"2af9b66b0e4f7005\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"80841f42c6308ddb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"893d521763b7c9a6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/HtmlDocumentContent.js\":\"412729d3fa4d812e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/HtmlFrame.js\":\"6127252a5c118b5c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/actions.js\":\"950bdc62f36c1305\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/blockType.js\":\"e65070dc9c5f8ede\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/confirmRunScripts.js\":\"95a4d95ef900b18b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/dataExtension.js\":\"527bc7b2f995d36f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameAnnotations.js\":\"a2be762aa152903f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameDocument.js\":\"b8cb83def2c1c575\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameTheme.js\":\"d9f994b9def2c3ec\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/index.js\":\"509cd2aae24dffec\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/scriptConsent.js\":\"e8f076773aeb2e64\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/sourceMap.js\":\"67d1e0009c1815af\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/useDocumentScripts.js\":\"432c6536c611f31a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/index.js\":\"2465a8da71e935a3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/record.js\":\"51a43de9d0175c46\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/recordStore.js\":\"268ffceb071a1226\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/responsiveness.js\":\"1098aaa027fd7971\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/schedule.js\":\"d95e95948dfbace0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/sessionContext.js\":\"9eaef2effec91101\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0b0b7aa6d4d48d3c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1308af894e1d2b67\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/actions.js\":\"3cfb4f1c09ce24d9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/config.js\":\"3aa507170d0d3b14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/dataExtension.js\":\"81a812eb045e899f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/effect.js\":\"4665fb19613773f8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/index.js\":\"6b5bf30c46e31a80\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/keyCapture.js\":\"21c8b812a445e54d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/overrideStore.js\":\"9eb10dba17efeac8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6c5a95ca7b525046\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/HeaderItem.js\":\"7372ebd23bebd493\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/LeftSidebar.js\":\"d889a384470f725c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/actions.js\":\"171d4a739673a038\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/facet.js\":\"6c1e52dd4c0985f4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/index.js\":\"3ec4f8612dd9dacb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/shortcuts.js\":\"22b401f429aa4a6b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/toggleStore.js\":\"fa1f60acd9281967\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/MergePicker.js\":\"8794300049eddb5d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/index.js\":\"2e450be644a421c5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/mergeAction.js\":\"e335b56980734ac6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/strategy.js\":\"2c68859cd05ec8d4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/Button.js\":\"14d95a3d38dc4a5b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"66d830c5d59824bb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/defaultItems.js\":\"3685773c46d58ddb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/facet.js\":\"5cfce15ff43751a3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/index.js\":\"af5c70c04446e514\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d4fadce9a7ad0793\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/actions.js\":\"98dca8aff93d4ed4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9fb56fa4c92a43a4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/facet.js\":\"13d279237808c060\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/index.js\":\"0b39e7ec6064d3e4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/MoveDestinationPicker.js\":\"fe86365991d8b7d9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fa40f8e88af2f7f2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/contextMenuItem.js\":\"9c07c3cd370a096b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/index.js\":\"b4b37e67b32e43d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/moveAction.js\":\"33bfaaac6b954a16\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/moveBlocks.js\":\"fb1600b53ab91dd5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/selectionAfterMove.js\":\"fa618bba25ceaaeb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/TutorialBanner.js\":\"66152fbeb2ff9879\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/action.js\":\"2326721086cc2d46\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/bannerDismissal.js\":\"22101b84c7dbe49c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/documents/cheatSheet.js\":\"ed3d13579f70e305\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/index.js\":\"6a25927056920668\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/keys.js\":\"a04997c56495af7f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/landing.js\":\"e47fec9a3f13c7b8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/outline.js\":\"89fc87d77a3e9f1f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/seed.js\":\"f4151a35673dd7ad\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/PerfTrendDialog.js\":\"df84db3d4c034eaf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/analyze.js\":\"e33a4703f39deb8c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/diagnosticsSource.js\":\"9c9cb1a1076392c9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/index.js\":\"64d417ad78bf40dc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/load.js\":\"6c7702fd732c8588\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/monitorRun.js\":\"9eace58cfea32495\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/schedule.js\":\"c76d6132f17b75b9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/series.js\":\"898d6ddce6aca19c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/store.js\":\"08a78c99f8e693c0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/trendAction.js\":\"e412c116eb115503\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/verdict.js\":\"694d0edbea94ae49\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/clickToEditAction.js\":\"89c759bb688867b6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/index.js\":\"198b94d320909e70\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/interactions.js\":\"ed592f3fa14762dd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3e19a6091e65350b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/MigrationGate.js\":\"027ce7bfd785940f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/MigrationGateDialog.js\":\"6996301b18639846\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/action.js\":\"9a342dff1c6c03a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/index.js\":\"43c57a456ceff86c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/localRunMessage.js\":\"1f88bd5d282c09b3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/plugin.js\":\"5db4b3be07b59c7c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/progressReport.js\":\"a3a4b34a01d73a8e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/sweepProgress.js\":\"0b3df6997328bc84\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/FieldRowRenderer.js\":\"66085ac2fb424be6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/ValueRowRenderer.js\":\"53785f3c6b73e601\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/actions.js\":\"03232bf5403c6e5f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/autocomplete.js\":\"d07a35e302a38e58\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/fieldRow.js\":\"6072fae1ec982cb0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/index.js\":\"20a017eacaceb4c8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/referenceWarning.js\":\"3f5d529ed9153762\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/valueAutocomplete.js\":\"6f2de18d6ada71ac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/valueSchema.js\":\"095fb2c215e4041a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/HeaderItem.js\":\"0844a1860bb7ad3e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/QuickFind.js\":\"7b783d972e2327bf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/index.js\":\"dbba98c952f2d550\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/recents.js\":\"fad4e884ee3adaf5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/resultItems.js\":\"2361c7f3493e26f9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/selection.js\":\"f49b6c08ad7d0b35\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/toggleStore.js\":\"6bfdd039a48f9d08\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/HeaderItem.js\":\"9ad133c699297ab4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f73b606ebd63ac88\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/grouping.js\":\"3994662e6d7e8546\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/index.js\":\"04ca36b536bf5c5e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/target.js\":\"de8a39e236cd44a6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/codeMirrorExtensions.js\":\"7262fdd770d0d792\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/contentPrefill.js\":\"5e21941f5c4c9a8c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/dataExtension.js\":\"fcd1cb6179040e11\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/index.js\":\"588fb9d543d4e2ea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"bb3819753aa6ee1c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/invalidation.js\":\"811e3330ef5aa6b9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/localSchema.js\":\"ec1dedfa6f22afa8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/blockrefs/index.js\":\"1038e731f55b597d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5a14e93c60fd529c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/index.js\":\"67dd924866ab023e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/referenceNode.js\":\"6364c0324f14ced6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/remark-reference-occurrences.js\":\"1e8af57966dfdb49\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"cc26bd987328509b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/index.js\":\"5d51a46e8fcab2cb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"6fe0550ef5872330\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"90fed5b57ef3ff7d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/mergeRetargetProcessor.js\":\"b89a83dacc628c71\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/parseFence.js\":\"b630780dcf946f3f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referenceParser.js\":\"391d045f0b7f8484\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referenceProjection.js\":\"93619fdba3350f48\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referencesProcessor.js\":\"542b461eb8c3fdd4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/renameProcessor.js\":\"0b28426dec7052dd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/spanReplacement.js\":\"ba834f79fcf4559b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/htmlToOutline.js\":\"16fd896eb3f373db\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/index.js\":\"fc15db8e250f0a68\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5b421688a7586cd6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/pasteDecision.js\":\"45fa5b8de6d9b509\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/action.js\":\"e076f2e70866454a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/blockIds.js\":\"3f4e595970e551b7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/content.js\":\"3a7225e32fbc6147\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/effect.js\":\"68f8e34632e4964c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/ids.js\":\"180f41ebafbe9af0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/import.js\":\"c7719f52bd917851\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/index.js\":\"25d1fb9582b2356e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/plan.js\":\"11c49c9b0e81cae2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/plugin.js\":\"580b35a210945cf7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/promotion.js\":\"553a3f3b2daf7347\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/properties.js\":\"2e00f511a3b9497e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/references.js\":\"3f8eeae7249376fd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/report.js\":\"5eb326355c887ee3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/roamMemo.js\":\"861534d9a1f21407\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/runtime.js\":\"f2c2138616008e7b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/schemaReconciliation.js\":\"e1399434b6e4deff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/srsMarkers.js\":\"06f940a053dd2f1f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/todo.js\":\"8be8cf3108612ad3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/typeCandidates.js\":\"126d2bb93e5f9509\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/types.js\":\"ab976f9262c342da\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/search-health/index.js\":\"71da525bb506f341\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/search-health/store.js\":\"da9ffca86bd2ec30\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/HeaderItem.js\":\"3b5a855935c94f3f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"1c401ce984413f44\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/index.js\":\"5377acc4a9524982\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/model.js\":\"d433533676716f47\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/toggleStore.js\":\"15640002a28ae9d7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/useKeyInspector.js\":\"1a006af8bc8e4ba3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9a85bc3f367230af\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/ShellDecorator.js\":\"554378cc69225640\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/actions.js\":\"16b5f7755c29bfd2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/exclusionsFacet.js\":\"da6a7eebf2ebb2cd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/index.js\":\"97b7db8b477d9d6b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/shell.js\":\"2036d66f247b9f86\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/surface.js\":\"050a300830251be8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/walker.js\":\"8cfa8b1f03564595\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/RescheduleToast.js\":\"09a2e8bdd1629654\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/dataExtension.js\":\"708a194e70e7af2c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/index.js\":\"899cfe3d937bbdf0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/indicator.js\":\"b7e8e4b067f738ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/moveSrsState.js\":\"b89fd545a9fa97a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"aee61ffc03bf29c7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/scheduler.js\":\"b42d6342ddbead1f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/schema.js\":\"150af18b69ad57bb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"15df45f3b78ed890\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/srsClipboard.js\":\"79474919464b58e6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ef9393d66d4c8218\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/DailyNoteReviewHint.js\":\"669f7006dfa2bd8d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/DeckPicker.js\":\"d161721464485245\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewControls.js\":\"a03a2fcb163b9232\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f6d2bf780652fd88\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewSession.js\":\"c460031c0cc36bb8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/actions.js\":\"0b6d182bf921da42\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/archive.js\":\"2f430c660add1e94\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/dataExtension.js\":\"8160b1d1bc9d9224\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/deck.js\":\"dc5bab5c13826fb0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/dueQuery.js\":\"835173ffe12d448d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/gradeDecision.js\":\"7246fa613ae3ebf7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/index.js\":\"5d130c291703d5b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/keyHints.js\":\"ef0a13a78c347a0f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/reviewCardLayout.js\":\"cb8d798fd72e9e9f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/reviewProgress.js\":\"880a3564e65def67\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/schema.js\":\"839af1b40d9f7e45\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/useDueCards.js\":\"0e4a115e8e2d8342\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/startup-metrics/index.js\":\"679f85235826be0e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/startup-metrics/record.js\":\"0ab8a898a96c1412\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/index.js\":\"85a8fb928f427534\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/persistenceStatus.js\":\"d32c09ec4cbc676d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/requestAction.js\":\"bba5849cbb65ad19\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/TypeChipsDecorator.js\":\"88579a9b03231528\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/codeMirrorExtensions.js\":\"5ce90032ed3c418c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/index.js\":\"416926643b44aa34\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/typeAutocomplete.js\":\"e544c7000466819b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"3658f758f8618a34\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/actions.js\":\"c645d1f4fc9696b4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/anchor.js\":\"7d547fa7392cb3c6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/events.js\":\"ca0e219485ca7af0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/gestureActions.js\":\"921e27cb47b00724\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/index.js\":\"e63f5cc0c9a73d3c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f19770c8e3e43619\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/collect.js\":\"0f39e374a810cd7a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/index.js\":\"d9d732363503a115\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/record.js\":\"e9a04df632336320\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/RejectionDialog.js\":\"20155b8925b4a14f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/SystemStatusHeaderItem.js\":\"34c87dddef1f3e91\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/index.js\":\"f74c982db3b99181\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/model.js\":\"04b3ab06c84ea457\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/queueCounts.js\":\"d1e4ec7e4f5a60b3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/rejectedHelpers.js\":\"37a86603343e635d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/rematerializeAction.js\":\"5571185fa09e6799\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/useHysteresis.js\":\"4256c103701fdaeb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/ColumnHeaders.js\":\"87368d4a8c46d6d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/QueryUi.js\":\"9b488e6063c1610f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/TableLayout.js\":\"4e038b2036a46881\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/actions.js\":\"4893fc48436d2907\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/cellEdits.js\":\"94b8692dd65e9bf9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/columns.js\":\"139b6bc299730056\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/controller.js\":\"42273ec6b83859ed\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/convert.js\":\"b7b9613f2861f3cf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/dataExtension.js\":\"eb02a0fa1a41831a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/index.js\":\"c3d14123a0064715\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/keys.js\":\"0b3b76ea45b8b1a1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/model.js\":\"ead932b3078e4770\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/navigation.js\":\"3b6787828ba10cb1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/backfill.js\":\"daecf82fe0d78d71\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/format.js\":\"b83a5c79613a3b82\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/parse.js\":\"8aa190b01381213c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/queryValue.js\":\"b1efb5e325279945\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/source.js\":\"5306ed5a76bce075\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/registry.js\":\"ba82e4b3f40d6646\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/schema.js\":\"aec7507a8ee74db8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/sort.js\":\"12de469cb2d84264\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/effect.js\":\"d1b212565c699bfc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/index.js\":\"b830afae5f0be798\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/theme.js\":\"f72253366be851e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/actions.js\":\"96ac3c673ffd342c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/dataExtension.js\":\"5fea201251a92840\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/index.js\":\"2265805ba5cb7f93\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/schema.js\":\"ff12d86510e7300b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c9def554a3dfeeca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/actions.js\":\"99041301c5532602\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/defaultItems.js\":\"613b76f8e4e836cb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/facet.js\":\"2aa4780821fc9b3b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/holdRecognizer.js\":\"641111b9720b83bf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/index.js\":\"bd5802c723cbf85e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/UpdateIndicator.js\":\"050399f007d62b6a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/index.js\":\"8f7b9bc0ebcf897d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/loadTimes.js\":\"a3ae8e8aebe7843e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoNotesRenderer.js\":\"622689dbff6199b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoPlayerRenderer.js\":\"baa5c7f33c08703c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoTimeStamp.js\":\"6b69db57ae5b7dea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/actions.js\":\"b0eeb3a15688faf2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/index.js\":\"14d1637cace5e8fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/markdown.js\":\"1d940dfec6dee550\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/notes.js\":\"9d89c7850ff98dad\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/registry.js\":\"644fce49d13cec22\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/remark-timestamps.js\":\"682024c6e295900b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/view.js\":\"238810479e4479fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/LinkHints.js\":\"111d89ad4c75555b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/index.js\":\"0d6b8663a7af876a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/model.js\":\"cbc1b58c224a929b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/settings.js\":\"6c72cf92b1a4b17e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/actions.js\":\"99984dccbbca3904\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/index.js\":\"150d8225b2dc9f55\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/interactions.js\":\"2de22e8c33629cf8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/workspace-header/index.js\":\"e0606c461f5d3f83\",\"/knowledge-medium/pr-preview/pr-1846/src/registerServiceWorker.js\":\"9b16dcc7cb157631\",\"/knowledge-medium/pr-preview/pr-1846/src/requestPersistentStorage.js\":\"283db991b3445a2e\",\"/knowledge-medium/pr-preview/pr-1846/src/services/authRequestDeadline.js\":\"07485d7062c983df\",\"/knowledge-medium/pr-preview/pr-1846/src/services/authStorage.js\":\"d59411ddbf6f6903\",\"/knowledge-medium/pr-preview/pr-1846/src/services/powersync.js\":\"5eaeba037a66026b\",\"/knowledge-medium/pr-preview/pr-1846/src/services/supabase.js\":\"413ac99c528a71ce\",\"/knowledge-medium/pr-preview/pr-1846/src/services/uploadErrorClassifier.js\":\"e80e8ffeda06d1bf\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/ActiveContexts.js\":\"69ca156db310ef0c\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/HotkeyReconciler.js\":\"5de141a792d30c23\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/WipeLocalDataDialog.js\":\"34d34fca6c517324\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/actionDispatch.js\":\"81d2dc547e144203\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/actionRefItems.js\":\"a7ebc1c65df19bf1\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/applyKeybindingOverrides.js\":\"da7f743dfec821cb\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/blockActions.js\":\"b1578cb768e3b025\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/canonicalizeChord.js\":\"d5e22b108236605e\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/defaultContexts.js\":\"df6e110c8a3a9ff1\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/defaultShortcuts.js\":\"d2b7fea463793d55\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/effectiveActions.js\":\"7765227a35c1e8ef\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/gestureAction.js\":\"fe1f42ed62f3f727\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/gestureBinding.js\":\"5678ff309c22af41\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/holdRegistry.js\":\"7eb3b9dffd977acd\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/keybindingConflicts.js\":\"b94e84c531c0a874\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/keybindingOverrides.js\":\"69299619a59421c7\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/pointerAction.js\":\"fcdd91110dee79cd\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/resolve.js\":\"1d6e00629a2219b1\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/runAction.js\":\"4e311b39a40defd9\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/sequenceMatcher.js\":\"51fd237a8ba953ef\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/types.js\":\"dda3f1ed96909049\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/useActionContext.js\":\"98380e55bb1c8733\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/useActionDiscovery.js\":\"a27edfa45b4ceab3\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/utils.js\":\"f1a0fd60d8e5fef8\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/bootStore.js\":\"e0e8ef046e38aeb6\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/previewDatabases.js\":\"2fccd8204290a93a\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/byteTransform.js\":\"920e858a71c05bee\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/attachmentCleaner.js\":\"771a9d5d8edf7f92\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/attachmentParts.js\":\"a8a545653ce82a80\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/bundleParts.js\":\"4cfef6d2aa6d2337\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/bundleRecord.js\":\"fd3ffe0b9f129ad4\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/manifest.js\":\"175d044f50967355\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/takeBundle.js\":\"b6dd30eda42695d6\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/verifyBundle.js\":\"57ddcf4e59dc5cfd\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/cleaningStage.js\":\"cd538a335c05e57b\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionKey.js\":\"50548f8de285ecdc\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionServer.js\":\"52b1ff6235ce15b7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/flip.js\":\"58eae8841579f276\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/flipAttempts.js\":\"89c813ce8226c162\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/pages.js\":\"81c5dc5c2bb916d7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/preflight.js\":\"52130a56982305ef\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/reseal.js\":\"b8bdf9d2a30e8dd2\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/runConversion.js\":\"0b4ce99aa814b60f\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/runLock.js\":\"db1834e8e13cf585\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/sealing.js\":\"fe9851f691c29ce8\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/sealingStage.js\":\"2f30ffbb6dcfa39c\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/stage.js\":\"8e154cef0fc2262f\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/verifyReseal.js\":\"8d9d0613ac13040d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/aad.js\":\"e8acd8539861aaad\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/aead.js\":\"8225670b30541147\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/base32.js\":\"a100db3376477421\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/base64url.js\":\"35391b4808c43dc8\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/binaryEnvelope.js\":\"feb8e3a90fafecea\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/byteAead.js\":\"d74165899791c5ed\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/canary.js\":\"1859dad224df4a9c\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/contentHash.js\":\"ce1c5f481aee5d9f\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/contentKey.js\":\"5be69f875252edf0\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/derivedIdNamespace.js\":\"e138aab6488677bf\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/envelope.js\":\"3028c5a69f725be2\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/hex.js\":\"9a7202c052c1a5a5\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/sha256Hex.js\":\"e17e0e3a81ecc0c7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/workspaceKey.js\":\"cd6e818ca0153760\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/conversionState.js\":\"e7cde804ae1d7e6d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/createEncryptedWorkspace.js\":\"527bf34b31d50121\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/pastedKey.js\":\"ba6926dc3e56a02c\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"702db0b30a10c5d8\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/upgradeWorkspacePin.js\":\"959c9cb62d1be781\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/keyStore.js\":\"1f7ac2e9e03a1497\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/mintWorkspaceKey.js\":\"222f0ec844ea0bd0\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/modePin.js\":\"23e94ba1f9c2f83d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/openWorkspaceKeys.js\":\"5874ae1b1d27763a\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/resolveWorkspaceEntry.js\":\"ad30abbe9711f8a7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/resolver.js\":\"8f1a66fb51eae19e\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/workspaceAccess.js\":\"ff0623d200156b35\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/transform.js\":\"87f745f71406e968\",\"/knowledge-medium/pr-preview/pr-1846/src/themeBootDefaults.js\":\"8ee1fcabd0bfd619\",\"/knowledge-medium/pr-preview/pr-1846/src/types.js\":\"d401741457175b33\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/ClientLocalSettings.js\":\"c98c4aa865a992aa\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/abortableSleep.js\":\"8d6b0e6b880d4fb5\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/array.js\":\"1afd36fe2efb65d0\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/backlinkAutocomplete.js\":\"bc7d285d0f5ccc30\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/blockCrumbs.js\":\"370af48a860658af\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/blockrefAutocomplete.js\":\"5f1eb5e4b88f2f76\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/cadencedIdleJob.js\":\"821516d62f94d65e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/callbackSet.js\":\"b9412445a6db94d9\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/clientId.js\":\"2ec9da83971ed9e3\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/codemirror.js\":\"8d2306fb859466b9\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/codemirrorCompletion.js\":\"4bb0171982c068ad\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/copy.js\":\"2dd81c612f944683\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dailyPage.js\":\"e24f6d9bf89e6ff5\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dbForensics.js\":\"afe7e1c5850355c8\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dbForensicsHooks.js\":\"15e768decf360cd2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/deleteBlockThroughUi.js\":\"b949ba1ffe4f61d2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dialogs.js\":\"be5bf7462e178759\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dom.js\":\"26f9a6f30066186d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/downloadBlob.js\":\"b8bb3761d6aa1433\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/exportSqliteDb.js\":\"47420c4a9abbbe1f\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fileSystemAccess.js\":\"c524e471213bd825\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/flipSlide.js\":\"c016563f02221101\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fnv1a.js\":\"8a714348d6f914ca\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/formatBytes.js\":\"cde239edca698ac2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fuzzyRank.js\":\"1925928ce4f75e03\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/idbKeyedStore.js\":\"4186df391fc45d25\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/idleCallbackPolyfill.js\":\"8aab4d20d4b514ee\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/keyboardAwareScroll.js\":\"5359ea9c4442889b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/keyboardViewport.js\":\"25987da7d889615d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/lastWorkspace.js\":\"8369339e96f5b57b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutColumns.js\":\"4f192c6fd411ae15\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutSessionDom.js\":\"961e34ab1c2a95e5\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutSessionId.js\":\"285e5c57c9bd05eb\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/linkClickGestures.js\":\"794365de8c4696d5\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/linkTargetAutocomplete.js\":\"6088e0ce15ce04f2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/localDbCorruption.js\":\"8c9ffc897bde3d36\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/localDbRecovery.js\":\"9d1459aec1dfe553\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/markdownParser.js\":\"9eb8bfe12c50e183\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/memoize.js\":\"82c72ef100c2109a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/nameFieldCommit.js\":\"b5bbf48c47befd8f\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/nameList.js\":\"50aee1760b0b6308\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/navigation.js\":\"98576d2ad64cc6dc\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/omnilinerNamespace.js\":\"05b1a424fedb083c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/opfsPageScan.js\":\"371da21f551a5271\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelClearance.js\":\"fb9a29dac1bd90ed\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelHistory.js\":\"e1f01cf90c27993d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelLanes.js\":\"7f70759715847943\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelLayoutProjection.js\":\"8bf4ffb8de060e30\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelScrollAnchor.js\":\"b2abfbb8ba98d6e7\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelUrlFlags.js\":\"2f8d99f57b43276c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/platform.js\":\"51bc4d3a50c24ee3\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/pluralize.js\":\"36aeb4a3e9fcda45\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyCreation.js\":\"5817631d026503e9\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyNavigation.js\":\"9d887d310e9083c3\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyValueContext.js\":\"3bf4e4237a0d2ccf\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/react.js\":\"e2b0d72f6aab9545\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/relativeDate.js\":\"c69f1df5ba28e000\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/relativeTime.js\":\"f74abe481b1c9aca\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/renderScope.js\":\"239139d56a69e6a2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/resolvedThenable.js\":\"1dd64a8d420ff8e3\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/routing.js\":\"478bd54f69c05f25\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/safeMode.js\":\"fe8ae10fa6287e02\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/scheduleIdle.js\":\"1a4698f8216a3377\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/screenWakeLock.js\":\"cd902373871c93ac\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/selection.js\":\"ec9c1ea3e08dee16\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/softKeyboardGrab.js\":\"e68f5eff0329e85d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/startupTimeline.js\":\"186743e398bcf16e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/state.js\":\"397036679948be5f\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/string.js\":\"eb23f56517343ad0\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/surfaceZoom.js\":\"0d1502b870919d62\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/time.js\":\"0fb966c5b2a75ce6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/toast.js\":\"7fb2962fad010fd8\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/toggleStore.js\":\"2f853cb91584be41\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/untilStopped.js\":\"e9fd4716e0e331ce\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/userActivity.js\":\"a58ab72154fcb4b8\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/viewTransition.js\":\"fbc36ac8964d0b9c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/viewport.js\":\"721b36c8d5cdc21b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/webLock.js\":\"c87149f670263c20\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/workspaceRecovery.js\":\"8919e204dccb415e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/workspaceSnapshotStore.js\":\"afc8990e12f51506\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-compiler-runtime.js\":\"71ecac6cc95c5c7c\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-client.js\":\"8485e93a4dd6d393\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-server-edge.js\":\"28d12e46035eb02f\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-server.js\":\"c974aee98325041b\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-static-edge.js\":\"e2780d2c6758a937\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-static.js\":\"c19ba0cdbdd40e46\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-test-utils.js\":\"da469478f5346123\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom.js\":\"732375148902b991\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-jsx-runtime.js\":\"c86adbc53a088be6\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react.js\":\"b15edb57cb68ff2d\",\"/knowledge-medium/pr-preview/pr-1846/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1846/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1846/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
