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
		buildId: "c04d47a1e2eb-18fe5955",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/\":\"fd5adaa80f25b58e\",\"/knowledge-medium/pr-preview/pr-1846/index.html\":\"fd5adaa80f25b58e\",\"/knowledge-medium/pr-preview/pr-1846/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1846/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1846/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1846/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1846/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1846/assets/FacadeVFS-Cuc_pJ5k.js\":\"9b192afb14c04bba\",\"/knowledge-medium/pr-preview/pr-1846/assets/OPFSCoopSyncVFS-B4s0e9Xx.js\":\"16ef4e94724a0461\",\"/knowledge-medium/pr-preview/pr-1846/assets/OPFSWriteAheadVFS-DmiwJfWP.js\":\"0f362a1d1371b520\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-Bf_q2CX1.js\":\"8a1046760280d7e4\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-async-DyzoZ0I4.js\":\"520896e328a0766f\",\"/knowledge-medium/pr-preview/pr-1846/assets/worker-CtYXZDNX.js\":\"a836ca8165647d4b\",\"/knowledge-medium/pr-preview/pr-1846/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1846/chunks/app-BrT2Advu.js\":\"29f432fe20df3065\",\"/knowledge-medium/pr-preview/pr-1846/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1846/index.js\":\"8b35cd3de0a0af28\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1846/assets/AccessHandlePoolVFS-Dsmo1HS6.js\":\"7cb7b7d6c2b2b1fe\",\"/knowledge-medium/pr-preview/pr-1846/assets/IDBBatchAtomicVFS-C7-vPcxJ.js\":\"dff84084e46a9d34\",\"/knowledge-medium/pr-preview/pr-1846/assets/MemoryVFS-DLPl70D3.js\":\"36f3bb41d37c48b0\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-BlcjHb6I.js\":\"a0d7affd462ddaa0\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-async-DblfZHmo.js\":\"939f1951d472d7c6\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1846/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1846/chunks/AccessHandlePoolVFS-CS0D-3Nh.js\":\"0231f443a217f0bb\",\"/knowledge-medium/pr-preview/pr-1846/chunks/FacadeVFS-CkxPWR8v.js\":\"3ffa53b2b51c7b10\",\"/knowledge-medium/pr-preview/pr-1846/chunks/IDBBatchAtomicVFS-Ceelc17c.js\":\"8fbbdc47c430d757\",\"/knowledge-medium/pr-preview/pr-1846/chunks/MemoryVFS-vUiWy9BP.js\":\"6f2d96b705f809ab\",\"/knowledge-medium/pr-preview/pr-1846/chunks/OPFSCoopSyncVFS-BiSx4PhO.js\":\"79a36b4e2676cbe3\",\"/knowledge-medium/pr-preview/pr-1846/chunks/OPFSWriteAheadVFS-CPXiBHU4.js\":\"f3689d8c5f7b7e8d\",\"/knowledge-medium/pr-preview/pr-1846/chunks/Preview-Egi7_KaF.js\":\"c2837f022025892b\",\"/knowledge-medium/pr-preview/pr-1846/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1846/chunks/card-BhIOWFf_.js\":\"4dbe4b570dc96b3c\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-Cul5tj12.js\":\"fcbe749907914e4d\",\"/knowledge-medium/pr-preview/pr-1846/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1846/chunks/mc-wa-sqlite-BBDmmTOX.js\":\"1cbd2b9a5c82007f\",\"/knowledge-medium/pr-preview/pr-1846/chunks/mc-wa-sqlite-async-BAb8TCGe.js\":\"9f1520728616cb99\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-BOadEuaC.js\":\"5c14789e5f15f356\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-Bd9tzTkE.js\":\"d44fa06c809b7a36\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-BpTronKt.js\":\"fc9dd13cbc5b8ed2\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-BwfbUsYn.js\":\"146214d3580a9738\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-CACk65TQ.js\":\"7b667f714251b1aa\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-C_HjbOit.js\":\"1f4d9e4bbaa4ee65\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-CmvvdYll.js\":\"8479fb1b2a84d39d\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-DPnZ4MBU.js\":\"a3c704ac3b5eec3a\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server-legacy.browser.production-CbSCHR6l.js\":\"13afc23c804301c4\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server.browser.production-4J8LXegu.js\":\"b8578ab96e996d84\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server.edge.production-BAMUowUu.js\":\"45dad1d4653757eb\",\"/knowledge-medium/pr-preview/pr-1846/chunks/server.browser-BQ7IVVak.js\":\"3df3df9e34ce81fa\",\"/knowledge-medium/pr-preview/pr-1846/chunks/textarea-w00EW2Yv.js\":\"69be931676b56fd1\",\"/knowledge-medium/pr-preview/pr-1846/chunks/ui-DyuZK_wJ.js\":\"0238a910567f06be\",\"/knowledge-medium/pr-preview/pr-1846/chunks/wa-sqlite-DRxP6gag.js\":\"c04e8508e75ead41\",\"/knowledge-medium/pr-preview/pr-1846/chunks/wa-sqlite-async-Cu4l9yQT.js\":\"2ed8c37398349730\",\"/knowledge-medium/pr-preview/pr-1846/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1846/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1846/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1846/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1846/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1846/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1846/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1846/src/App.js\":\"c2064d70c074070f\",\"/knowledge-medium/pr-preview/pr-1846/src/appUpdate.js\":\"2ef37753b7c822d4\",\"/knowledge-medium/pr-preview/pr-1846/src/appVersion.js\":\"7a56b77b7f321518\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/initialLayout.js\":\"b3a4071898a150c8\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/openWorkspaceData.js\":\"01223b9b9d6291e0\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/resolveWorkspace.js\":\"02f23596529b25c3\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/workspaceBootstrap.js\":\"a0f811dfc0175918\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockComponent.js\":\"047fe58dbafe4166\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockCrumbs.js\":\"504c4d11bf567829\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockEditor.js\":\"e29323277fac13fa\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockLoadingPlaceholder.js\":\"5317f1284765ae49\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockProperties.js\":\"9c1326998b28092c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockSearchPicker.js\":\"45745a1865fc1c65\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ConfirmBulkDeleteDialog.js\":\"e9d0d5a09051e8a3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/DividerHandle.js\":\"5beb9104c82ec188\",\"/knowledge-medium/pr-preview/pr-1846/src/components/DraftEditor.js\":\"8ca099d5ea72dcaf\",\"/knowledge-medium/pr-preview/pr-1846/src/components/GutterPill.js\":\"a3b98b60fc907a3c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/Header.js\":\"321928f4e8f3f853\",\"/knowledge-medium/pr-preview/pr-1846/src/components/LazyBlockComponent.js\":\"5c3822405a49201e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/Login.js\":\"96e4ade9a6f7f11a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ZoomableSurface.js\":\"7853662f050a3080\",\"/knowledge-medium/pr-preview/pr-1846/src/components/editModeKeepalive.js\":\"197139f68748faec\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c0c16e93a5404c29\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e2712b835c185bb4\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/RefPropertyEditor.js\":\"560d8d95acbf3b02\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/RefTargetTypePicker.js\":\"16c8f40cd600bfe7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/SelectPropertyEditor.js\":\"793d38b40d69782c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/TypesPropertyEditor.js\":\"dbc61b22ed85cb7f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/defaults.js\":\"fc1d08f668ce22a6\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/kernelValuePresets.js\":\"ebe1911cbe2a6b63\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/selectablePresets.js\":\"61c85b58e364c854\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/typesPropertyUi.js\":\"bf5321dac96145fd\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/AddPropertyForm.js\":\"e58153f5adf3e213\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/PropertyPicker.js\":\"f7a0b8b99e0a61b8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/PropertyRow.js\":\"ada2dff9132d118e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/Rows.js\":\"ad1e8717c23e972f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/actions.js\":\"632fbf2efe037b09\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/declarationOnly.js\":\"34133b1ac1d0b349\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/layout.js\":\"a5ca6cde49c8bb99\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/model.js\":\"c9f0c6a1d1b88c9a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/shapeUi.js\":\"20976a4fac1d1cdd\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/shapes.js\":\"5c4188207b91c848\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d0105bdcf768f041\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/visibility.js\":\"14515f9e1a774c96\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanelSections.js\":\"1be2e8f8ddc36e21\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockEmbed.js\":\"3b993bf9524080cc\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockLink.js\":\"151d8ce9a63f0f7d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockRef.js\":\"d7f882410bad0dc1\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/ReferenceLink.js\":\"5b40e62e69c7e433\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/cycleGuard.js\":\"4e761d4a2272fd97\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/cycleGuardContext.js\":\"80867db85f5b5187\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/linkInteraction.js\":\"fc4a2d8905dce660\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/referenceLayout.js\":\"e4e7745d779cbfc7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/useBlockRefAncestors.js\":\"0ec522426aec549f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockGutter.js\":\"0282f513fbbd7655\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockInfoDialog.js\":\"2d4f282ea16a8c39\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockTypeBlockRenderer.js\":\"290e7e8e3344d0ce\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BulletHoverCard.js\":\"e2da99692e7155f0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/CodeMirrorContentRenderer.js\":\"5c28ae8409184fdf\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"72a7e439a41a6778\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/ColumnResizeHandles.js\":\"15fca6108d42b058\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"abdc7736cd8c7afe\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/DefaultBlockRenderer.js\":\"11ebfff18fce0b16\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/LayoutRenderer.js\":\"8c98e169cebe007c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/MarkdownContentRenderer.js\":\"058639764cd77dc4\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/MissingDataRenderer.js\":\"898d1e1d6cef8a6e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/PanelRenderer.js\":\"12dd304c80f3a504\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/PropertySchemaBlockRenderer.js\":\"5cfbb57e81d6ddab\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/TopLevelRenderer.js\":\"aba7c128d5020887\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/blockGutterMode.js\":\"5ef99622a8361939\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/blockTitleText.js\":\"1cabb3bd8b32b079\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/fieldCreationKeydown.js\":\"378021ed150f2c3a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/layoutRootContext.js\":\"36839dd660941ea5\",\"/knowledge-medium/pr-preview/pr-1846/src/components/typeChip/TypeChip.js\":\"648c53fee8cdf892\",\"/knowledge-medium/pr-preview/pr-1846/src/components/typeChip/chipStyle.js\":\"198846046c3dcb6a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/anchored-floating.js\":\"38187a31b7bda23e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/button.js\":\"4acfae470c5eaa7d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/card.js\":\"999e500d610cc5fa\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/checkbox.js\":\"a87130ec66a5d6f9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/collapsible.js\":\"94512f7c1a492d6d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/command.js\":\"7d9442a7efe2f9cb\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/context-menu.js\":\"93346a5952a121be\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/dialog.js\":\"cff02c580bf47a01\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/dropdown-menu.js\":\"106c1f2bc59c554e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/floating-listbox.js\":\"3cb8515c0ae61d48\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/index.js\":\"f09ef762007655f7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/input.js\":\"0acf07e9245ff277\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/kbd.js\":\"a366c5594b95216f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/label.js\":\"af97cdd68114779b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/textarea.js\":\"c5b43a331b292acf\",\"/knowledge-medium/pr-preview/pr-1846/src/components/useEditModeYieldKeepalive.js\":\"cd391baeb4200533\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/BootFallback.js\":\"e70d40e0442288ff\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/FocusedRowLazyMount.js\":\"28a03ac43cd822b6\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/LazyViewportMount.js\":\"0d043abe8249a9e9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/LocalDbCorruptionFallback.js\":\"94632fc254e8586c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/error.js\":\"886fcd859773b435\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/lazyMountRegistry.js\":\"3081aec59ee789a8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/suspense.js\":\"8d699202b75b1647\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/CreateWorkspaceDialog.js\":\"eef659a472c18f02\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/PendingInvitations.js\":\"ae0ee2b76ce7a9c1\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/SyncProgress.js\":\"90094ccdbd0cdd5f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/UnlockProgress.js\":\"1d9fd8a51aaecac5\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceKeyGate.js\":\"2cd83ebc3d5da08b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSettingsDialog.js\":\"f003720e1426d32e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSwitcher.js\":\"fde6c30d873b7cf7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSyncGate.js\":\"f829aab35d3f7bd8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/ConversionFlow.js\":\"b12f5d2dab1164ae\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/ConversionFlowHost.js\":\"c0cd3520cc13b3a8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/EncryptionSection.js\":\"4d3aa03468ac06c0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/attachmentPrompts.js\":\"88dd4629e129aa1f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9a2aaea0d7d01ad5\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/conversionFlowDeps.js\":\"a83df35ef284002c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/conversionFlowStore.js\":\"0d295040c4a99b68\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/flowUi.js\":\"55d866cd13336270\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/useConversionRun.js\":\"aa84459c7cb51bad\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/keyUi.js\":\"78a37aa9054ab9b9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/useCloseOnKeyLoss.js\":\"724d02e38d9b6f3e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/useCloseOnServerE2ee.js\":\"c2a8266462664d82\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/workspaceUnlocked.js\":\"aff5e2238d63bee7\",\"/knowledge-medium/pr-preview/pr-1846/src/context/backgroundSubtree.js\":\"ef62e7c3168e05a0\",\"/knowledge-medium/pr-preview/pr-1846/src/context/block.js\":\"74802aca2543494d\",\"/knowledge-medium/pr-preview/pr-1846/src/context/layoutWsContext.js\":\"42f0838f05e7eee3\",\"/knowledge-medium/pr-preview/pr-1846/src/context/propertyDisplay.js\":\"d2bb4203c85b50a0\",\"/knowledge-medium/pr-preview/pr-1846/src/context/repo.js\":\"cf2a8431660fb610\",\"/knowledge-medium/pr-preview/pr-1846/src/data/aliasClaim.js\":\"c3d68b6140ff5528\",\"/knowledge-medium/pr-preview/pr-1846/src/data/aliasSeatNamespace.js\":\"63aa1b7ddd1c0326\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/blockData.js\":\"e29d7920abbf8374\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/blockType.js\":\"0ce44928f77b06c6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/changeScope.js\":\"31d01b1faf1d97bb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/codecs.js\":\"fb47eddff3255f5d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/derivedData.js\":\"947e4a4399ff5dee\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/errors.js\":\"752ba354125964c5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/events.js\":\"dbdd32dd4b425308\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/handle.js\":\"c9e480406503703a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/index.js\":\"8db9ef3488e7ac3f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/mutator.js\":\"b47720dd7baa5914\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/processor.js\":\"923eb31c838fa0c0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/propertySchema.js\":\"23a6d907fc3d040f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/query.js\":\"ae0a286b7a312ede\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/sameTxProcessor.js\":\"615ff2c8dae0a9df\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/schema.js\":\"c9e480406503703a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/tx.js\":\"c9e480406503703a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/typedBlockQuery.js\":\"2e11c35f7affa136\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/user.js\":\"51d3b5cf8130967f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/valuePresetCore.js\":\"5219cf03d9896a10\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/valuePresets.js\":\"ab97db4ba2920e22\",\"/knowledge-medium/pr-preview/pr-1846/src/data/attachmentCleanerIOVerb.js\":\"ae4c5a0d29589469\",\"/knowledge-medium/pr-preview/pr-1846/src/data/block.js\":\"ed49122b9476a025\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockCache.js\":\"151c0593b7cfded4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockId.js\":\"027f391bd41a1ea6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockLiveness.js\":\"52d7cb391691af88\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockMerge.js\":\"d1e7f43666fd0540\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockSchema.js\":\"c6aa45396b2974d8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockTypeLookup.js\":\"69ffdc7f35f134a3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockTypes.js\":\"10fc036bf75f6510\",\"/knowledge-medium/pr-preview/pr-1846/src/data/clientContext.js\":\"da7656bbca3afbb1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/dbFileSiblings.js\":\"e9dc751cabc06942\",\"/knowledge-medium/pr-preview/pr-1846/src/data/definitionSeeds.js\":\"440b2b024c0db877\",\"/knowledge-medium/pr-preview/pr-1846/src/data/derivedIds.js\":\"564017aa1e3215e8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/drawnSubtree.js\":\"c0f436ec93f22bde\",\"/knowledge-medium/pr-preview/pr-1846/src/data/facetBridge.js\":\"4a2e4c0c04e0c1ec\",\"/knowledge-medium/pr-preview/pr-1846/src/data/facets.js\":\"eb68d08e993db951\",\"/knowledge-medium/pr-preview/pr-1846/src/data/globalState.js\":\"0755d36d2e5614aa\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/aliasClaimRederiveProcessor.js\":\"7e54510827eb24d4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/ancestorBatch.js\":\"e9543d229d482d02\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/blockTypeTypeifyProcessor.js\":\"7c0b8990e68974b8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/clientSchema.js\":\"2ef4ca2865a4407d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/commitPipeline.js\":\"eba13c36cb89a8c5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/devAssertions.js\":\"af6fb189617b3c8b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/firstSync.js\":\"67b1aa9f4167e16b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/freshInitialLoad.js\":\"3f5d7c83f60b509b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/graphBackfillClaim.js\":\"55d225930ac7a5a2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/handleStore.js\":\"1a84dde9bb3ed856\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/idleMarkerJobs.js\":\"3d7ff13fd7e370bf\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/initialDownload.js\":\"96ff8f9a5950068e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/initializeClientDatabase.js\":\"6cdb61f1dd3feab3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/jsonCanonical.js\":\"f7c7d51618fd3780\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelInvalidation.js\":\"f17eec9b0663bb1d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelProcessors.js\":\"731b8bcec9764e7c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelQueries.js\":\"5b35df5c12d7ea42\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/mergeTypeMembershipProcessor.js\":\"171f0625bc658a67\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/normalizeReferencesProcessor.js\":\"b4ef6dbbf2ff1a4c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/poolInstrumentation.js\":\"75b0b0ceb18105f1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/processorRunner.js\":\"b76290a3625a7816\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyCellBackfill.js\":\"aa3f69e33a195808\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyChildMint.js\":\"2f7106702ad06fb6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyChildrenProcessor.js\":\"45871f0fac7ae390\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1552e18189910850\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyDefinitionSynthesis.js\":\"e7bf776030a8cf39\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyKeyScan.js\":\"fa14483223d23179\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertySchemaResolution.js\":\"ccab3fe02c5ab44b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyValueEdits.js\":\"091a850a403d1011\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/raiseProtocol.js\":\"afdbbede1d94f5f4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/readBatch.js\":\"7473f76a05e87bd5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/refProjection.js\":\"cd95c0ac5e5291d0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/referenceTargetLookups.js\":\"d2939303481baafc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/referenceTargetProcessor.js\":\"ef6364f694e89615\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/replayMerge.js\":\"f1e5a970c80b0a51\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/sqlBinds.js\":\"cf8dc9cd7bbec40e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"bcd2c0c975fec821\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/arrivalProcessors.js\":\"53c692a951f1c3ce\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/invalidate.js\":\"15bc97a511cafc58\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/materialize.js\":\"f55b27eb6f951bba\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/observer.js\":\"44e86e9dc2e14abe\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/reconcile.js\":\"8539bd0f70fa1403\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/timingMetrics.js\":\"5be87e913069bff3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/treeQueries.js\":\"4ebab0b773bf0831\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/txEngine.js\":\"56fc986e401f17a4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/txSnapshots.js\":\"7bf8a240ed477e27\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/typedBlockQuery.js\":\"197baec7a96ee810\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/undoManager.js\":\"3d290b1eb961657f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/invalidation.js\":\"be6dc70c25acb4cc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelDataExtension.js\":\"52d95c4699a1eb45\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelPage.js\":\"82455a6d026581d6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelValuePresetCores.js\":\"9f52723f086fdf49\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbCorruptionSignal.js\":\"9e87cfe354d01026\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbStorage.js\":\"333ee842c85d5923\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbVfs.js\":\"680c02426a5842a6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localSchema.js\":\"9feb78e8c113acfc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/maintenance.js\":\"917557a030ea5ce4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/mergeProperties.js\":\"0bce18248e402385\",\"/knowledge-medium/pr-preview/pr-1846/src/data/metricsConsoleHook.js\":\"df19e05d3c024695\",\"/knowledge-medium/pr-preview/pr-1846/src/data/migrationsPage.js\":\"356f4afd4ec1c1fc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/mutators.js\":\"41b73c6cee4fb84a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/orderKey.js\":\"3fa2469b08a42db2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/orderKeyPlacement.js\":\"c41620ba1a779610\",\"/knowledge-medium/pr-preview/pr-1846/src/data/outlineSurface.js\":\"0de0027400f5484c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pendingEditorContent.js\":\"09b26d38a0a6d016\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pendingUploadsSql.js\":\"648bddb5ee3a4d0f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pluginStateExtensions.js\":\"93ca7c730cd28081\",\"/knowledge-medium/pr-preview/pr-1846/src/data/powerSyncLogger.js\":\"184c5cdd421fa1c9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/projectorRuntime.js\":\"c7b286c3c04b8474\",\"/knowledge-medium/pr-preview/pr-1846/src/data/properties.js\":\"a93239846bc80575\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertiesPage.js\":\"6664d6e374ae9281\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyChildren.js\":\"07ab1146b06d050f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionFanout.js\":\"362371e1590db5cf\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionMetadata.js\":\"18b8c71a9913c0e6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionRegistry.js\":\"2f285699d69f8ac1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDisplayMode.js\":\"93c15ff27b99f97b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyRowCreation.js\":\"aab83796790ae7f7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertySchemaCreation.js\":\"06a3951dbc0c07df\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertySeeds.js\":\"fa7151f8c4beda39\",\"/knowledge-medium/pr-preview/pr-1846/src/data/recentsPage.js\":\"ea9eaa12f34c8dbc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/referenceBlock.js\":\"80631184913f236c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/rejectedUploads.js\":\"57bb3099726532ef\",\"/knowledge-medium/pr-preview/pr-1846/src/data/releasePowerSyncConnection.js\":\"905c69314e9b2f5f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/repo.js\":\"9609fa8be56a32f4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/repoProvider.js\":\"74e90278d7c72c66\",\"/knowledge-medium/pr-preview/pr-1846/src/data/rowProperty.js\":\"24a284dddef0322b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/searchFilter.js\":\"79ac6979bd854894\",\"/knowledge-medium/pr-preview/pr-1846/src/data/seedIdentityLedger.js\":\"2b8999a8a5bdeb00\",\"/knowledge-medium/pr-preview/pr-1846/src/data/stateBlocks.js\":\"6fbffe9f4203a68a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/structuralEditPolicy.js\":\"b73f7166fa8de08d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/subtreeDelete.js\":\"b9f9354ce50163a3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncStreamLock.js\":\"392086ff9e3b4748\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncedTableSqlRecognizer.js\":\"03c7a6a61cc631c5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncedTableWriteGuard.js\":\"feaa7d95c344cd72\",\"/knowledge-medium/pr-preview/pr-1846/src/data/targets.js\":\"479d9d6c35e4fa71\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeColors.js\":\"e75d6fc991a0de68\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeDefinitionMetadata.js\":\"185e2ccafcd9368f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeDefinitionRegistry.js\":\"f6ab9a6618878d71\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeExtraction.js\":\"26cbd4cd853d8a48\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeInitialValues.js\":\"7b44341bbc24fe2c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typePropertyGroups.js\":\"30d7a900635edf81\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeSeeds.js\":\"9f63929b7123a66b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeTagger.js\":\"a6bf83431850831a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typedRecords.js\":\"09554f2c745f1686\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typesPage.js\":\"6aa6e25c5de0a69b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userPrefs.js\":\"d0b4c0e9ca1a6fe7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userSchemasService.js\":\"281b051c05898db6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userTypesService.js\":\"ee9d43a03a296455\",\"/knowledge-medium/pr-preview/pr-1846/src/data/valuePresetRegistry.js\":\"699ea590cb98d669\",\"/knowledge-medium/pr-preview/pr-1846/src/data/visibleChildren.js\":\"6ce73bc6153a0a58\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceConversion.js\":\"9334e1b3d559cafd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceFirstSync.js\":\"7b7ca9aaa8e054bf\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceIdNamespace.js\":\"d264df09a33f16fd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceSchema.js\":\"f3d4032c045bf16e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaces.js\":\"14e886afee8ebe54\",\"/knowledge-medium/pr-preview/pr-1846/src/data/writeAheadLog.js\":\"1387aa736892e453\",\"/knowledge-medium/pr-preview/pr-1846/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/BlockPasteShellDecorator.js\":\"a0ce7d4771bc3b09\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/atTrigger.js\":\"5c5d905ef756d1c7\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/autocomplete.js\":\"b52d61205599053c\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/codeMirrorExtensions.js\":\"c8c7b4f3ac97096e\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/contentFlush.js\":\"8e810d5cf2122d43\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/defaultInteractions.js\":\"d4033354ccdf3408\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/editSettleSignal.js\":\"d2dd83b42ed16d89\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/insertImage.js\":\"db5092e738aad197\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/referenceCompletionRange.js\":\"e13c8daa3bdd0d37\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/referenceTargetTypes.js\":\"fb459693ead05650\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/syntaxContext.js\":\"545f1cff9fbfc213\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/triggerMatch.js\":\"a5376cf650f035c6\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/AppRuntimeProvider.js\":\"fb52c875cf23abd3\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/BlockFocusShellDecorator.js\":\"8fa0da3587c98cd5\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/ExtensionRenderBoundary.js\":\"b70ddf9f69d791b5\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/PanelContentRecovery.js\":\"79c348f33f8baddb\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/apiCatalog.js\":\"47123bf9e273cb12\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/approveExtensionHere.js\":\"736a04cdfea250fe\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/armedCutAppMount.js\":\"0d1baa4ce6c918d6\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/batchableKeyedStore.js\":\"309982888f179867\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/blockInteraction.js\":\"800dca6908a49271\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/blockSelectionAction.js\":\"d445ed9280d274ab\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/compileExtensionModule.js\":\"3d3776d2c104c958\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/compiledModuleCache.js\":\"d7e8efcc0941afbd\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/continuousGestures.js\":\"f93206f8207af5db\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/core.js\":\"434300623cbe51c3\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/defaultRenderers.js\":\"6eae0011130b6ad7\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/definitionFanoutAppMount.js\":\"b9b241edafa1812c\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dialogAppMount.js\":\"e4e177ecca7bc0d4\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dynamicExtensionSeeds.js\":\"fd65ee11c38b2a54\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dynamicExtensions.js\":\"8a7ac8939166ca1e\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/exampleExtensions.js\":\"9087bcb065db9a0d\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionApprovalStatus.js\":\"3b288ff01a8dc48f\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLoadErrorToast.js\":\"cca2f8f8391bbb58\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLoadErrors.js\":\"808873f438083b72\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLookup.js\":\"0abfe1d944213984\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionToggles.js\":\"451e1f276fc9ae62\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionUtilitiesCss.js\":\"a2b2e10813452066\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/kernelPageDeletionGuard.js\":\"9aac8eb05d1f28f1\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/liveRuntime.js\":\"5e8e8f7e76aa0eea\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/openExtensionsSettings.js\":\"7a053f691b36323a\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/overridesCache.js\":\"7353a97a9184acce\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/pluginIds.js\":\"53402fad8b676385\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/processorRejectionToast.js\":\"dcd6961f41c1b32d\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/runtimeActions.js\":\"a7c924ea4c60870c\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/runtimeContext.js\":\"94936de231fe21d0\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/staticAppExtensions.js\":\"5ca32883ede3f17b\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/staticDataExtensions.js\":\"6ea11f0364bd14d1\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/toastAppMount.js\":\"4cb3455639275c95\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/useOverrides.js\":\"05eb3cf980c8c253\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/useShortcutSurfaceActivations.js\":\"0ea49e974db1d56a\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/discoverToggleTree.js\":\"8f72a99127c35e30\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/facet.js\":\"264a276b0ba87075\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/resolveAppRuntime.js\":\"d07a75cf8bce36cd\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/runtimeEvents.js\":\"a86d0258dfc4b96a\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/togglable.js\":\"aa1ae622606c19e6\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/variantFacet.js\":\"d65f795bc62758f2\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/verbFacet.js\":\"23e9e698b3dbe6b0\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/block.js\":\"5777549bd22ce16b\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/focusedChild.js\":\"772dc6d019a6a3e7\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/propertySchemas.js\":\"2a3b25a509e57454\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/typeRegistry.js\":\"d11df4a036bbc5ee\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useAncestorCrumbs.js\":\"cd341380cba1dcc3\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useAutocompleteListbox.js\":\"7ecb0b672142330f\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useDebouncedSearch.js\":\"1c366a4a29af8c4f\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useDebouncedValue.js\":\"7c8903a8e87b5f3f\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useIsFocalRender.js\":\"816e8c6f9817c6fa\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useIsReadOnly.js\":\"266ee6c5773de74a\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useMaterializeBacklog.js\":\"6b94103983991ead\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useMinuteClock.js\":\"c114202190d21bf1\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/usePanelLayoutProjection.js\":\"3a7f5ed1932c8165\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/usePendingInvitations.js\":\"c27ca754e260f868\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useRendererRegistry.js\":\"dcab849e22014ffe\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useRetainedFieldRows.js\":\"38ad66610ce1657b\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useWorkspaces.js\":\"c22999f1955be12a\",\"/knowledge-medium/pr-preview/pr-1846/src/lib/utils.js\":\"36c3531611df3981\",\"/knowledge-medium/pr-preview/pr-1846/src/main.js\":\"e49a9f8e4688ce11\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/MarkdownImage.js\":\"7c2fbfdc540f0485\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/blockSeparators.js\":\"e15f9b05dc274622\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/context.js\":\"62d5d09766a971b8\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/defaultMarkdownExtension.js\":\"e610184f660976ab\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/extensions.js\":\"c0ebe8a22b6817b4\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/renderMarkdownHtml.js\":\"c37042202a457f1d\",\"/knowledge-medium/pr-preview/pr-1846/src/minimal-editor.js\":\"b01e6053260f629c\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/armedCut.js\":\"3cad9347e606ec4e\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/captureMediaVerb.js\":\"3f16ec004a6f2b90\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/clipboard.js\":\"b6f595691c8e0bc0\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/decision.js\":\"38f6bfcdadc8945f\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/operations.js\":\"515efb4bb96e7c62\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/account-header/AccountHeaderItem.js\":\"159e841debfb953f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/account-header/index.js\":\"0781db8aa77397f7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2d3ab8b6c809c38d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/askAgent.js\":\"7ff3500309aaa6a5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/askedStore.js\":\"b29df9817f790cf0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f94a89090a3b65ad\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/chipState.js\":\"cb61426259029318\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6b0885a51552fae0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/index.js\":\"85a5d525e69b6f7c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c6611c0a26ff3f80\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/schema.js\":\"533058d5257eda5a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9faeb16b38a1813b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5b4144124426b7cd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/addMedia.js\":\"d027b0ed1dd8aaed\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c3eb8d1e8e7f3ebf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/block.js\":\"c7d9c38883625061\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/context.js\":\"7b9ee2d2490ae8ce\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ad85ba2862d2469e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/index.js\":\"f77df00f5c739add\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/outline.js\":\"9ad6c01a131b35ee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/properties.js\":\"d169db3e31a5558f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/refs.js\":\"61a79341b644a9ce\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5e3a96a906b0b49d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/search.js\":\"21967603892ba1b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/shared.js\":\"26db8482f49f70ea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4a74608db471cbf3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/text.js\":\"a0226627a36a8572\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentWrites.js\":\"9d3c975f3c3bf7c0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/authoringCatalog.js\":\"4866c8cd32f4aa5c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/blockRefTargets.js\":\"546ecd4814d754cf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/bridge.js\":\"3a1c169dbc8bcd22\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/bridgeLoop.js\":\"f1e4597605c5e305\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/changeHistory.js\":\"7ecba13db9905788\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/commands.js\":\"06245872cc01454b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/commentsCommands.js\":\"e2ee797c8981ac56\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/dataExtension.js\":\"4e8e9d5120444dc2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/dataModelGuide.js\":\"6a0074ff1acaee7a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/describeRuntime.js\":\"3d0e6a36c956d52d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/extensionLint.js\":\"ac3672e36860808d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/grainAudit.js\":\"38b8f2c5f7a003d1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/healthCommand.js\":\"3cddf9dd0c84482a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/index.js\":\"74e5660508235e84\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/presetIdentity.js\":\"0a3202ded68570e3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"bc00812fd514d975\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/readMedia.js\":\"7cd4a180aa5990a3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/schema.js\":\"22b8c85f17bc7113\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/serialization.js\":\"a7c0bd7f068d9263\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/targets.js\":\"a780177f37ec1abd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/tokens.js\":\"e3ce649b7fc783e7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/watchEvents.js\":\"5982b3a8b89395a3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/workspaceGuard.js\":\"10e37abfc2205501\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/writeCommands.js\":\"2ca8a3e2c2d5963d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/AliasCollisionToast.js\":\"0a393fc7e2c13965\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/DuplicateNameBanner.js\":\"d7790cf045bf852e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/collisionMerge.js\":\"a9faf472fed11bf1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/dataExtension.js\":\"6ad3da1e6a5bb9ba\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/index.js\":\"9eaa1061bc734d6b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/mergeCollisionAction.js\":\"13a5b3a7884892e7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/pageStyling.js\":\"b1d6546bcbdba7f2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/rejectionToast.js\":\"59c36f2e194ab058\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/syncProcessor.js\":\"840ba14df34fe4d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/actions.js\":\"ab501525b79ed4b3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/addComment.js\":\"7262198785573166\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/anchor.js\":\"13a9310272c60624\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/anchorState.js\":\"af818647f28a707d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/commentLinks.js\":\"0723269a405eadff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/confirmThreadDeletion.js\":\"fc73d2f325ac3755\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/container.js\":\"fd25223bc6b0a5ee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/dataExtension.js\":\"9b2cca4feb791b11\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/deleteComment.js\":\"b833cbcadc8e1cc1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/highlights.js\":\"7315b5102c31f951\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/index.js\":\"2f4faa5b827b16f4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/linkedCommentsPill.js\":\"ef9662003b0249b2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/margin.js\":\"93a97429722c14f8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/marginSchema.js\":\"9e5b00189cc2dcbd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/newComment.js\":\"261fade04216d852\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/ownThreadPicker.js\":\"995c5f98216b5492\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/placement.js\":\"0eb0beb111c16bae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/queries.js\":\"dd343251d795e136\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotePosition.js\":\"d220989832d34804\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotedIn.js\":\"ace4df1cf3b122ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotedRange.js\":\"153f40b55407495c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/rangeRefs.js\":\"ab1656146e4ea40e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readHighlights.js\":\"5a64a4dce7d199ea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readSelection.js\":\"b66cfc34257b13ab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readSelectionUi.js\":\"1cc80229aa13fb9d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/reanchor.js\":\"a1a65afd6ae3a1a0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/schema.js\":\"866092b5c543e233\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/scope.js\":\"389d0e46b54b60e5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/scopeThreads.js\":\"257e8d3f084291e0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/splitRetarget.js\":\"fd76c0f0466528d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/suggestionCard.js\":\"09cc6a78fe24cc0f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/suggestions.js\":\"f0204772bcd6453c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/summaries.js\":\"6b0e7259716359ff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/summaryBatch.js\":\"22f08c69a87b3d29\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/surface.js\":\"9d0e64a21b56d0f5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/threadNavigation.js\":\"451b07bd257414c7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/threads.js\":\"10dd90586b5467ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/ui.js\":\"7c5784db58ec30de\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/uiStore.js\":\"7fe82046f0833420\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-intents/appIntents.js\":\"0b8e25995192be61\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-intents/index.js\":\"9e2f5585b8cdcad6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-update-prompt/index.js\":\"f348e60e592730b8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-update-prompt/status.js\":\"5bee0b82031c785d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4d1c813259e68573\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaBlockRenderer.js\":\"74969ba2462005e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaDownLaneReplicator.js\":\"913881ecb85b9b22\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaUploadReconciler.js\":\"456b87da4ca9b41c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetDownLane.js\":\"c25a4707636755cc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetResolver.js\":\"a759b5789f682eba\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetUpload.js\":\"486eed1d2bf2a2c7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/attachmentCleanerIO.js\":\"2e0fbb76b155e008\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f3da7a990efcd0b1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/blobStore.js\":\"efd53c63e9e804c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/byteStore.js\":\"0ee546f862063606\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/cleanerIO.js\":\"e601203fb71b3d9a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/cleanupAttachments.js\":\"d27365ec7963d3b1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/dataExtension.js\":\"17bf0ea90520e4e4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/downLane.js\":\"cd5caf3827fc79fa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/index.js\":\"9d9c7420f74fbae8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/insertImageContribution.js\":\"28923f647a5f09f0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/laneArming.js\":\"3ab9f6b9478fc1e2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/laneLock.js\":\"a4f979c1601453e7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaBlock.js\":\"12bb38a357496a89\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaCapture.js\":\"8c815cd3936be89c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaViewers.js\":\"a4acfb8aed2151f1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaViewersFacet.js\":\"304a7c2306b74704\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/pasteCapture.js\":\"ec6907b46a5b70b0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/resolver.js\":\"7734f1223e433899\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/retryUploadsAction.js\":\"45d7e2a080174992\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/storagePaths.js\":\"4f2b119846eea550\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadDrain.js\":\"3eac71c510c25ae8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadLaneStatus.js\":\"7002f3a4df3275a8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadReconcile.js\":\"fd1cea03def038a0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadRecovery.js\":\"4cc92dc74d353d36\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadStore.js\":\"644585d18600ca71\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/useAssetObjectUrl.js\":\"58e1c505c2f799a1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ed2f685e3f2c55e0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fc96e29317689355\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/facet.js\":\"61dfb8922a62533f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/index.js\":\"6a5b7402c86a29f6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/prop.js\":\"67f4f652e5cd5ad2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BacklinkFilters.js\":\"d9732c78166f1216\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"dbc9681c7b1b603e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BlockEntry.js\":\"856c5847ac66b637\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/LinkedReferences.js\":\"7f52186bda8a456e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"75255e47bb652b4b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/dailyNoteDefaults.js\":\"c81a388f5d175a4c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/dataExtension.js\":\"3233774cdbff1e2a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/edgeExclusions.js\":\"89930fd316277c54\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/filterProperty.js\":\"b6f5a03c0a4de984\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/index.js\":\"670c6288d9ffd131\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"510d95ad83aeec92\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/applies.js\":\"b70865a307b1dfee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/countQuery.js\":\"7db18f35eef47c8e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e324670450d1a18a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/index.js\":\"7ab694bbc7123c4d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"def9c111d72acb30\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/presentationInvalidation.js\":\"42674091d4f146ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/propertyEditorOverride.js\":\"22cba2681a62bba6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/propertyFilter.js\":\"ba8ed9336a6a4f6b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/query.js\":\"977be231ec7756dd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/resolveFilter.js\":\"5a061e7ea3249652\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/sourceBatch.js\":\"a521e7a1061a64fd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/sources.js\":\"b6b3fcde0a088522\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/useBacklinks.js\":\"5d3d700d0e741e5b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"3c775c29c698a367\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/BirthdayCelebration.js\":\"8247be5412e24eb8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/BirthdayOverlay.js\":\"2acb2d0d74aceedb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/gate.js\":\"a4e4a8de37dd5b10\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/index.js\":\"12770378612ed311\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/wolfTheme.js\":\"da97860968731640\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/BlockDragLayer.js\":\"9cdda1e4592d80e5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/dragController.js\":\"a860b1b8ac118c43\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/dropTarget.js\":\"462a0b3a6c608c18\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/index.js\":\"036c8c2bc31d6357\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/projection.js\":\"f5520c4821e8277a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-info/BlockMetaCard.js\":\"30fd15c175f9bfd3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-info/index.js\":\"e5128bdcb2fce6fa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/AddTagDialog.js\":\"cb28e298adb0130c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c903a0aeccbfb4a5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/TagNameIssueHint.js\":\"53a33082dbb0670a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/addTagAction.js\":\"d2593bc74fb5bea6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/appendTag.js\":\"83f1b514c0741db2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/config.js\":\"0f2e903c5a4df898\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/dataExtension.js\":\"a6edcbb2bace0174\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/index.js\":\"d47f558888f5e2b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/propertyEditorOverride.js\":\"dcd253b550f0aa08\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c400dbd07c239e75\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"e18e620264481189\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/Breadcrumbs.js\":\"289b9cc1e17705ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"462cbefa64bde80b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3de69d077488b0e0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/index.js\":\"0b3ed303788ded40\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"57c2b5376d11635d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/CharacterCountItem.js\":\"fef5807eaebfb6fa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b5e9a8b5dd059c3a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/actions.js\":\"d22a73e3e8ba14ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/blockType.js\":\"f4f80cb2bc9329a9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/charCount.js\":\"b3ca8e840925e029\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/dataExtension.js\":\"7212c9c541ac8d07\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/index.js\":\"ea4c574d68a4c2a9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/profiles.js\":\"e4b78ee6801aa25a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/properties.js\":\"0f064435a89aac36\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/textCounts.js\":\"d72b5c63890d76c8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/colemak-keybindings/index.js\":\"617edee27599fc16\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/CommandPalette.js\":\"e04eb08e24c7c191\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/HeaderItem.js\":\"abd919d61e67cccd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/context.js\":\"9479903a87018d32\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/index.js\":\"45f0cdca3571970c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/selection.js\":\"c98113d90ac906cd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/toggleStore.js\":\"9c0a30cded61a77c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/useCommandPaletteActions.js\":\"94d7b6782d745657\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/ContributorBadges.js\":\"df7980e89ab5b807\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/author.js\":\"d2a703e7d20c36e9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/codeMirrorExtensions.js\":\"2c8baefbb4e74e10\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/dataExtension.js\":\"7beec24c6077f7f3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/index.js\":\"83f5b5a8ef5de3fa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/mentionAutocomplete.js\":\"c827d43e182f44bc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/processor.js\":\"17023c2b4441e7db\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/profiles.js\":\"7ec4f95c56562c2b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/queries.js\":\"a0b19e2aab58a2c2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/schema.js\":\"6a1ceb8b9c23ecd6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4594d6b336db8f18\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2fa4c4d62d764014\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/index.js\":\"5aee69eb836d0263\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4cfcd475a34d7950\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e3e05b6158c0bad3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/CalendarGrid.js\":\"bb22ed6c15c35760\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DailyNotePicker.js\":\"e0d3552a180b7c32\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a3e8ac82ec3dc2da\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateNavDecorator.js\":\"d287c7ef205206a5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateScrubOverlay.js\":\"95c9306b41d5014f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/HeaderItem.js\":\"88a8c3a05469538d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/ReschedulePicker.js\":\"acc80192b8f7eaa9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/SpreadDatesDialog.js\":\"434bab1a35240e14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/actions.js\":\"2de25cee577763cf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/blockDateAdapter.js\":\"cd5c86b342362032\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/calendar.js\":\"3d9c6d9fb9ab4d92\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dailyNotes.js\":\"0c88323754126e7c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dataExtension.js\":\"db745418fbb49f3f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubActions.js\":\"a8d39250fa97ae18\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubGesture.js\":\"c898d75a3cf061b0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d408691ab87f359d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubRecognizer.js\":\"dca04d3ffb45bdf5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/deletionGuard.js\":\"95653a14883c6f22\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dueQuery.js\":\"a3c9e4e2ad93d3b4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/index.js\":\"71a01c8f3839bf16\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/landing.js\":\"e2fcd210492e54f5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/localSchema.js\":\"921b675c02200901\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/referenceDateAdapter.js\":\"c14d845adb1c774b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/rescheduleAction.js\":\"857ca40a79b80102\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/schema.js\":\"c73a3ad38062886c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/spreadBlockDates.js\":\"4838b44f35b34e44\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/spreadDatesAction.js\":\"f36c7c08e8d6c9fa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/today.js\":\"4f059f17512682fc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"94197ad07d11930d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f141d64e1cf48e1c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/audit.js\":\"4923febe55f27ee2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/auditAction.js\":\"a9077473f0bdefee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/auditRanges.js\":\"0bbb073f604890df\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/diagnosticsSource.js\":\"e4a10c7ccdb9568a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/divergenceScan.js\":\"0064d5e6ba31b58d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/index.js\":\"f2bbbdaf8760a470\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6537631a2a39bfba\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/referencesMirror.js\":\"0ed68bca83a5718a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/rowJson.js\":\"976a16740b9eb5e0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/schedule.js\":\"28557925d21f4fbb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/store.js\":\"b5b28f65d5f56922\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/action.js\":\"c0cdc1d2df1cc85e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/index.js\":\"9d269cea57dbb4d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/plugin.js\":\"469c43ac9da5efdc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c44bf05e7f228347\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/actions.js\":\"3fcb78f8cbee0c75\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/changeMarker.js\":\"adabed504ca92213\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/diagnostics.js\":\"875ae9fa59cf0dc1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/fileSystemAccess.js\":\"422b750eca4d5d02\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/filenames.js\":\"93a7576cdbe99d54\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/index.js\":\"c66f31843120d535\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/mirror.js\":\"affe73b2505bec72\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/runLock.js\":\"5432dedfc142707f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/runtimeHealth.js\":\"07b47a310eb41ff1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/schedule.js\":\"0ab5bd48411b03f2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/store.js\":\"79bf3f26374ea619\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/default-themes/index.js\":\"9b4108523f0eecf0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/default-themes/themes.js\":\"699842e49498ef9d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/diagnostics/facet.js\":\"51661a950c53caa7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/diagnostics/useDiagnostics.js\":\"81782931848d2ff3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/dismissals.js\":\"7f1f96290cda41c5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/index.js\":\"cfaa16548b262e02\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/status.js\":\"257f9403dee2e239\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/store.js\":\"074e37aaac1e5f6b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5fee6eeab9af42c8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b2e5682407745649\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/actions.js\":\"7850cc51c33ea387\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/config.js\":\"a10aee0bfa1e6dbb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/dataExtension.js\":\"ee6c793982577ffc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/effect.js\":\"057c7fde21ac33d1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/index.js\":\"e56253c1c5bd3f9b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/propertyEditorOverride.js\":\"4ccddfdc3b05a1af\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/useToggleTree.js\":\"38619a5bcdbf3e31\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/ExtractTypeDialog.js\":\"d36632dc7c18e078\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f530ac98871e446f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/PropertyShapePicker.js\":\"2e97517c51e8cf93\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/action.js\":\"bc99f2d56f57d3b3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/index.js\":\"b89765eadb955e59\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/FindReplaceDialog.js\":\"1a5123f51edf0d47\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/HeaderItem.js\":\"05f26a803ba81b4a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/dataExtension.js\":\"2719475c3643f531\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/index.js\":\"22abcecdcb3c4158\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/search.js\":\"e42704d874d6661b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/toggleStore.js\":\"78df5f478b80c111\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/LocationPropertyEditor.js\":\"824e374c62ad254a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/MapView.js\":\"af56f4f8f7727459\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/blockTypes.js\":\"bb8e25339a8dad5f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/codeMirrorExtensions.js\":\"d3027a8eb8af4698\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/createOrFindPlace.js\":\"c304bd96429f0942\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/currentLocation.js\":\"7319ebdf2861da98\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/dataExtension.js\":\"5695e42ac91b23f3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/geoContentDecorator.js\":\"8bd1ffe939e9d02d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/googlePlacesClient.js\":\"e0ff44fcf454d830\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/index.js\":\"189a06a68684e782\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/locationsPage.js\":\"190076f1a6e8ac96\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/mapViewport.js\":\"b6aa7175705ba742\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/pickCurrentLocation.js\":\"7249a0f715c548cb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/placeAutocomplete.js\":\"f71db552c1bdc746\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/placeNameCollision.js\":\"31a070e15d3a2220\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/properties.js\":\"7ccd9707709c7683\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/propertyEditorOverrides.js\":\"25969cb2922c0553\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/query.js\":\"4e443ecde2944594\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/usePlaceSearch.js\":\"e553944ab894aa6c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"01243355b11253b9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"53eaafb18ca34096\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"930d5cb1e55c9080\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/config.js\":\"ea0d77bc4e66894d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/dataExtension.js\":\"d51c60901f3d7cac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/facet.js\":\"12e0ba79a0a8c9b1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/grouping.js\":\"98a47bbc3910b1ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/index.js\":\"b44274cfb040c8b3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6f0983335e7b9705\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/query.js\":\"101e89637406dc63\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/resolveConfig.js\":\"a0d0bb67e085b10b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2c48adce3412e025\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ba90243ae7510cfe\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/HtmlDocumentContent.js\":\"86e4081874a98940\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/HtmlFrame.js\":\"639d6f59d11cef9b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/actions.js\":\"0a0a92e2f9ab5ed9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/blockType.js\":\"9a2d3c69accfaaef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/confirmRunScripts.js\":\"4f76c001aad1f359\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/dataExtension.js\":\"fa0512664df731f5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameAnnotations.js\":\"ad134bb3c29a8690\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameDocument.js\":\"42e9ff9e05871f36\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameTheme.js\":\"d73717a5da04ee64\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/index.js\":\"2eade347ab325e36\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/scriptConsent.js\":\"69b9e48b96c277c7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/sourceMap.js\":\"a7ca700202cf46fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/useDocumentScripts.js\":\"ac39983e94cb881b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/index.js\":\"91b718404df95da3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/record.js\":\"db50c1d4357c972e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/recordStore.js\":\"982f2f24ee831d90\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/responsiveness.js\":\"c16d563603746752\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/schedule.js\":\"4fd0f64ceb4f1b96\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/sessionContext.js\":\"3a044efe48d6e212\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5c9cab13a70bddc4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6526993bb3eef448\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/actions.js\":\"b7f090581e4e121f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/config.js\":\"11d70f4b5f53a07d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/dataExtension.js\":\"beb70b47d3ef2ed0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/effect.js\":\"c647d248c5e083dd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/index.js\":\"72948ef38a625577\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/keyCapture.js\":\"63d16cec6e6515a6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/overrideStore.js\":\"385797216373fb6c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c2d61bb6c93366f2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/HeaderItem.js\":\"da0cb374c2d25bfa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/LeftSidebar.js\":\"2a75855581538d2d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/actions.js\":\"d346fba7f9b2a4f7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/facet.js\":\"fdf9362192060b87\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/index.js\":\"8b4c67d8f0c49078\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/shortcuts.js\":\"1438b4203cf1689d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/toggleStore.js\":\"44ca35f9249f9837\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/MergePicker.js\":\"3cbc86ea64919bbd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/index.js\":\"c8a4f8e28439cc9d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/mergeAction.js\":\"24f055f7330209f1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/strategy.js\":\"92b3d6a6610178d5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/Button.js\":\"a90f3d8bf28e5412\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"26bb80f876d3f872\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/defaultItems.js\":\"43907972c44fcbc4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/facet.js\":\"8c08067c2845a7c8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/index.js\":\"5948f9a4af9fcc7e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"65d5abd203b46ced\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7f6461fd77878056\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ef07ec82013cf6aa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/facet.js\":\"fcb8bc696d4ce01c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/index.js\":\"af46573798921dcb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/MoveDestinationPicker.js\":\"474f1b7beeb1f263\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/blockSubtreeMembership.js\":\"dae88c4c082bbdf6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/contextMenuItem.js\":\"732745db9027d89a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/index.js\":\"fdc031e7eded84a9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/moveAction.js\":\"982175424b99ff2d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/moveBlocks.js\":\"eacf1d2a030d7c48\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/selectionAfterMove.js\":\"698dc1a48e79bab8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/TutorialBanner.js\":\"554e72821fe93430\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/action.js\":\"8d0faf461513c0ed\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/bannerDismissal.js\":\"bb57742374e89b14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/documents/cheatSheet.js\":\"342a0b414a74092b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/index.js\":\"38e40de67eca3d50\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/keys.js\":\"0313d2e7833fb398\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/landing.js\":\"4d3a97ef635bb1b8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/outline.js\":\"24cecb04b48d5bb7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/seed.js\":\"b2e645bbbcc60626\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1cbcdcef915bf2e4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/analyze.js\":\"593f938215cd3e02\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/diagnosticsSource.js\":\"af2abde9acf74d55\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/index.js\":\"8528c0b0867f78cf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/load.js\":\"b99e5b49bf003ed1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/monitorRun.js\":\"1d74929d56d3a9bd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/schedule.js\":\"1b80e8f83d08cbc5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/series.js\":\"87bde4e0210b4aea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/store.js\":\"944fd6a3d8750110\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/trendAction.js\":\"2b127ff33f8c5899\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/verdict.js\":\"6c67088e879d981e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/clickToEditAction.js\":\"74ec04a35667caa1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/index.js\":\"327d391d6f55a7c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/interactions.js\":\"8faeb6935746829e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"db2e106509b1b7e8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/MigrationGate.js\":\"67c696d21d148806\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/MigrationGateDialog.js\":\"206a49a81be4ff06\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/action.js\":\"48b421a7ab82f200\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/index.js\":\"45d0fd641f893793\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/localRunMessage.js\":\"8e89e7efc7d7514b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/plugin.js\":\"47eeefa34e7881d7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/progressReport.js\":\"c4154b4c52e0b7f3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/sweepProgress.js\":\"00f30d02f546166f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/FieldRowRenderer.js\":\"3137b0a37daa7d7a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/ValueRowRenderer.js\":\"c0c454a29effda3f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/actions.js\":\"04d1cd403ef0b3d6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/autocomplete.js\":\"a70479ac9da6eb4c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/fieldRow.js\":\"e8bef1215c0cd93d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/index.js\":\"ec96a0ef41188a62\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/referenceWarning.js\":\"f1ac37d967de04c8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/valueAutocomplete.js\":\"8c6372919c091e7f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/valueSchema.js\":\"282f86a77cc1b5c0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/HeaderItem.js\":\"68daae8d91dd0adb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/QuickFind.js\":\"157fb6efb554d3fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/index.js\":\"5f62bd9a0d9a70f4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/recents.js\":\"817324a50661da22\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/resultItems.js\":\"f51adc73f6899080\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/selection.js\":\"d82ab7d483875856\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/toggleStore.js\":\"1597a86780348b16\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/HeaderItem.js\":\"5b30bc9968c3ee33\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7b598cd2b92bcdf1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/grouping.js\":\"e9bff9b4cb7948e6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/index.js\":\"e1b53d07117a9dd6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/target.js\":\"f2aabebdd6572a8c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/codeMirrorExtensions.js\":\"ff0ce72265cbe5ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/contentPrefill.js\":\"00b1950c171ec8ee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/dataExtension.js\":\"2c5b8fc284701657\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/index.js\":\"2e2d068841b12dac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5fd4ccefb026fae7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/invalidation.js\":\"39118d54a4fe8f53\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/localSchema.js\":\"1c58d0f7ee0a5584\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/blockrefs/index.js\":\"dbf84fb3bcb936ce\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6425867d2a87409a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/index.js\":\"8893db0ffee23338\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/referenceNode.js\":\"b5fc9515ac800709\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/remark-reference-occurrences.js\":\"458f8a5f0ad89aed\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ea64e1ee1a30b3c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/index.js\":\"88ee122d840ea4df\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d28cf77c958017d3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"59fce77fbb657242\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/mergeRetargetProcessor.js\":\"197b317078de4f12\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/parseFence.js\":\"6b1ebb1b5cfecf68\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referenceParser.js\":\"4cbb7129ed24d51f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referenceProjection.js\":\"b4d26a3c5c1b2b7d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referencesProcessor.js\":\"52d18d36a715163f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/renameProcessor.js\":\"c416f80f47689bc8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/spanReplacement.js\":\"53564b257b7d68a0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/htmlToOutline.js\":\"03515c0bcdd47b10\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/index.js\":\"fdbf2ed0ede608c2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/normalizeClipboardDom.js\":\"009090aeba1484f7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/pasteDecision.js\":\"91cd96349ab87050\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/action.js\":\"8306e927898fb298\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/blockIds.js\":\"8e4528e03a511002\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/content.js\":\"6e4e5dd3e1cc9748\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/effect.js\":\"95b060cb3b1dfc46\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/ids.js\":\"3a86ca635d70eb92\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/import.js\":\"d956317b0a8e6430\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/index.js\":\"b5676325af01f070\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/plan.js\":\"c00f4a82c82e91c5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/plugin.js\":\"467130eba0c155ff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/promotion.js\":\"caf81aa642cb820a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/properties.js\":\"0986ba4996b29b2c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/references.js\":\"6afb7af554a1c464\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/report.js\":\"4c2b9ce2fa1677c9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/roamMemo.js\":\"2cb599a1c1b74e68\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/runtime.js\":\"f693f92cc2cf37e7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/schemaReconciliation.js\":\"b21211c1b806d66d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/srsMarkers.js\":\"ec1eba0546734d63\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/todo.js\":\"065de3445da68453\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/typeCandidates.js\":\"1144cb4bdb364b4c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/types.js\":\"c8d15c93cf4b5085\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/search-health/index.js\":\"016c1e3f2303b24d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/search-health/store.js\":\"a252faee7e23287d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/HeaderItem.js\":\"0ee85d7855b0fd90\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"48e862b74de857ad\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/index.js\":\"6944d594d849b7f5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/model.js\":\"8f6c4c8f2d8bf3f8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/toggleStore.js\":\"e1a4d6dbb57995a1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/useKeyInspector.js\":\"1865ba332e9dd9a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9b99d78f1ad0db84\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/ShellDecorator.js\":\"fe38f03846c786de\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/actions.js\":\"8c66210a79ed96c2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/exclusionsFacet.js\":\"dd79ee08bf4426a2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/index.js\":\"cc3e51a102f6fe4a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/shell.js\":\"1bd3be9f49bafb82\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/surface.js\":\"2e4a6d6a39fe0f85\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/walker.js\":\"caed39235d754d5d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/RescheduleToast.js\":\"472a7c5d30df7d39\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/dataExtension.js\":\"87140b97a42b1edd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/index.js\":\"ae9c6bb21ef9e694\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/indicator.js\":\"42b397ad4f55e801\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/moveSrsState.js\":\"563b1d51fbf2c098\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e5230fe68c03b719\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/scheduler.js\":\"a070443c2f950a7b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/schema.js\":\"c545380241066cbb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d5fc150436f8ad67\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/srsClipboard.js\":\"96a64de14b0510a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b1d53706b53cff46\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/DailyNoteReviewHint.js\":\"95d532f3fb16cdfe\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/DeckPicker.js\":\"843e51f4d513a099\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewControls.js\":\"a05156f6872587d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9e5959617a31709c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewSession.js\":\"ee44fc706981b831\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/actions.js\":\"47b857419826b9bf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/archive.js\":\"f068471c4cc26f2e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/dataExtension.js\":\"09e4d056010acb5f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/deck.js\":\"4924150250465837\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/dueQuery.js\":\"2745f88780553b97\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/gradeDecision.js\":\"926b78ab91aa2d85\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/index.js\":\"e3481e6f85d47dbc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/keyHints.js\":\"ab2d0dcded2934bb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/reviewCardLayout.js\":\"adf94cdd14b6b2b8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/reviewProgress.js\":\"2b5da9c32e59ce98\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/schema.js\":\"0c3232cdeab7ee15\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/useDueCards.js\":\"872295c68dcb11dd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/startup-metrics/index.js\":\"ac6623b4468362d5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/startup-metrics/record.js\":\"a4e89c9a3145782d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/index.js\":\"4d28416a41562cec\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/persistenceStatus.js\":\"c8b667265f8280f1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/requestAction.js\":\"d7d2caa5a93b8a95\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/TypeChipsDecorator.js\":\"69b8d57ce817e592\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/codeMirrorExtensions.js\":\"5b9f5ac9c531855a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/index.js\":\"b575dee310976623\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/typeAutocomplete.js\":\"8df55b1f7bf8ab38\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6a67ffb64486e05d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/actions.js\":\"f2fb05b012397ffe\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/anchor.js\":\"62b1d9be6e75dfd8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/events.js\":\"4bca2a22dd21bcbb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/gestureActions.js\":\"7a60f2a64269574b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/index.js\":\"ae36cf85eff5ea13\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"df02af3e2aff722c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/collect.js\":\"8e69313114f55ecf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/index.js\":\"cdd92446a145ccb4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/record.js\":\"ef6822bf39dde76e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/RejectionDialog.js\":\"507bd5a4ec4ae400\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b130ed7ff9ad9b74\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/index.js\":\"7ef8547d0da6009d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/model.js\":\"52179928c2aaefe1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/queueCounts.js\":\"d5e6301c9da4fdb3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/rejectedHelpers.js\":\"91ea1e1c5bdbd6b4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/rematerializeAction.js\":\"ea2b9419e520a0b4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/useHysteresis.js\":\"4c761657bad80583\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/ColumnHeaders.js\":\"37d9293a7e2156d6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/QueryUi.js\":\"231c104db77bdf27\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/TableLayout.js\":\"b67294a1b8cedaee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/actions.js\":\"3b4c0006635eab92\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/cellEdits.js\":\"e55c93b1198244c9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/columns.js\":\"af0c68aea600d808\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/controller.js\":\"237dc1a677ae9df2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/convert.js\":\"8994bbde08cae4da\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/dataExtension.js\":\"3f701f26a04667c5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/index.js\":\"4672f8b3bae6ba05\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/keys.js\":\"b0f158add1d8bb42\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/model.js\":\"435929fdf64c9a23\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/navigation.js\":\"2cdf435bf7e47082\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/backfill.js\":\"2484e1bd899ba5ea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/format.js\":\"99034f3f5d6ec3ab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/parse.js\":\"48ee768db8579625\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/queryValue.js\":\"031b80cd54d185df\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/source.js\":\"63c78137d04f293e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/registry.js\":\"8f6a9bcc93e77d8a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/schema.js\":\"4c7bd3261a14f530\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/sort.js\":\"075685858f2b31d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/effect.js\":\"7565d87ff0eab78c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/index.js\":\"5b80563da8c28d52\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/theme.js\":\"7bfd11fab14a9ef9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/actions.js\":\"54ac944a0dff9780\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/dataExtension.js\":\"e8517603f1ff605e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/index.js\":\"59e7e6dd6a6a027c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/schema.js\":\"3dd5565b1419b9e0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/TouchSelectionLayer.js\":\"fb18cd4de8e358b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/actions.js\":\"84dad8909ad31b93\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/defaultItems.js\":\"2c0d235b52a8ae1e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/facet.js\":\"70636ea4b3b014c4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/holdRecognizer.js\":\"09681b2b728e3e5f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/index.js\":\"5d6980e0ab1b65ee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/UpdateIndicator.js\":\"412fb7896103735b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/index.js\":\"f8640aadb392d074\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/loadTimes.js\":\"e693b1cafb660317\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoNotesRenderer.js\":\"7ca92da9d6167809\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoPlayerRenderer.js\":\"6e338280f44e1301\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoTimeStamp.js\":\"81e471c61e6e0b7d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/actions.js\":\"407cf3469d9fa3db\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/index.js\":\"a36f23dbe20384e5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/markdown.js\":\"ba5a4f68cf6e57bf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/notes.js\":\"2d55354d4b2db7c4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/registry.js\":\"51b82d279bcfff72\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/remark-timestamps.js\":\"8aa82823bcb73a92\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/view.js\":\"f8a2bd52306ceb95\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/LinkHints.js\":\"9ec56303a756d54c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/index.js\":\"70d1bbc079f88220\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/model.js\":\"9516cd419f5289e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/settings.js\":\"b72909dc2d55bdfc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/actions.js\":\"cd7e8a69b9f265ac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/index.js\":\"7bc969e3086c62d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/interactions.js\":\"8a59efdc9fd4ff0f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/workspace-header/index.js\":\"47d080781efbe497\",\"/knowledge-medium/pr-preview/pr-1846/src/registerServiceWorker.js\":\"67cc2730341c5f7b\",\"/knowledge-medium/pr-preview/pr-1846/src/requestPersistentStorage.js\":\"5abe385c1084e449\",\"/knowledge-medium/pr-preview/pr-1846/src/services/authRequestDeadline.js\":\"f5ecabf1037330e6\",\"/knowledge-medium/pr-preview/pr-1846/src/services/authStorage.js\":\"d5c9e6bb2fef61f4\",\"/knowledge-medium/pr-preview/pr-1846/src/services/powersync.js\":\"c06582cfa92e1134\",\"/knowledge-medium/pr-preview/pr-1846/src/services/supabase.js\":\"c063fb04c5d5a8a2\",\"/knowledge-medium/pr-preview/pr-1846/src/services/uploadErrorClassifier.js\":\"8e4667d0c3295ff9\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/ActiveContexts.js\":\"99e1e50a5485ea42\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/HotkeyReconciler.js\":\"a454608ce75f741c\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/WipeLocalDataDialog.js\":\"e19c85282afd91a9\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/actionDispatch.js\":\"2d749a830a2c778c\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/actionRefItems.js\":\"61aae9daf14dcd4a\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/applyKeybindingOverrides.js\":\"e4bd463589d9c8b1\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/blockActions.js\":\"6ec729657e67914c\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/canonicalizeChord.js\":\"50a08d8fa1463b88\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/defaultContexts.js\":\"b4d9db51dab35d0d\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/defaultShortcuts.js\":\"cdabbc5fba36eac1\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/effectiveActions.js\":\"a83cba2af69cd618\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/gestureAction.js\":\"294619011c8da154\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/gestureBinding.js\":\"15c191b38c6e7ffa\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/holdRegistry.js\":\"0fd14aa20d0e47d0\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/keybindingConflicts.js\":\"d3f3a659cc7d5c73\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/keybindingOverrides.js\":\"db5241213278a811\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/pointerAction.js\":\"e8fd2119dc272a0b\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/resolve.js\":\"3ef099f348b9a5f0\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/runAction.js\":\"09c04624bbac8769\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/sequenceMatcher.js\":\"489598309ce4a53f\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/types.js\":\"8a05f8b74c5559db\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/useActionContext.js\":\"4717486716397518\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/useActionDiscovery.js\":\"d44f1b68966730eb\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/utils.js\":\"2164d257e6b52c33\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/bootStore.js\":\"677da3be27bfdcb9\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/previewDatabases.js\":\"f8fb96050f7fb15a\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/byteTransform.js\":\"e7a176e2c931d8dc\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/attachmentCleaner.js\":\"a09b52f4e09f6a8c\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/attachmentParts.js\":\"559f15491c2f869a\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/bundleParts.js\":\"3040bc0901a0a47f\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/bundleRecord.js\":\"eea10821c80623b3\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/manifest.js\":\"42adc1ee7812fc9d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/takeBundle.js\":\"5f373b8ac4c5e8a7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/verifyBundle.js\":\"be1d886a9868e620\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/cleaningStage.js\":\"9648226c3b26168d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionKey.js\":\"d84df9b30e6b9425\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionServer.js\":\"5a6c4c6ee0495464\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/flip.js\":\"5144acea6147d1fd\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/flipAttempts.js\":\"1d40982cc6d75984\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/pages.js\":\"16b026accb2eeae5\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/preflight.js\":\"529820a575804e9f\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/reseal.js\":\"9f6a0e996979e608\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/runConversion.js\":\"77fd439597eb3b7a\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/runLock.js\":\"a102b71911e6e33d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/sealing.js\":\"ace0be1a7e67f943\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/sealingStage.js\":\"a5aac828a81459fb\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/stage.js\":\"710d986ca3fc2777\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/verifyReseal.js\":\"0ce243ba920d34b9\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/aad.js\":\"0661b9bee5bd6a59\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/aead.js\":\"ab5c4fc36d936a84\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/base32.js\":\"9d131ac7984b506e\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/base64url.js\":\"b79d7ef6448c184d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/binaryEnvelope.js\":\"8f9800a51d736478\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/byteAead.js\":\"955b4f3a0bcc54e1\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/canary.js\":\"6cee2cd8dad762b0\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/contentHash.js\":\"4a026d7523426c56\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/contentKey.js\":\"7c302e9fcfd0c6ce\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/derivedIdNamespace.js\":\"af4039448da197f4\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/envelope.js\":\"3008f121a0daad48\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/hex.js\":\"69df342748e21ae8\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/sha256Hex.js\":\"4602b8b551f0b589\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/workspaceKey.js\":\"987da1525378cde9\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/conversionState.js\":\"8e44e8b99b8b7bb4\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6460a732255f8ced\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/pastedKey.js\":\"1d012b778c2d3d7e\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2ae794b4b00d5acc\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/upgradeWorkspacePin.js\":\"714e96fdfa614ab5\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/keyStore.js\":\"746d0f028cd14f9e\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/mintWorkspaceKey.js\":\"587d031708c4af67\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/modePin.js\":\"e1936bc799684888\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/openWorkspaceKeys.js\":\"1083b1b5a64edecc\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/resolveWorkspaceEntry.js\":\"f46298a05c3ede0d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/resolver.js\":\"c9442b97a8b9abe3\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/workspaceAccess.js\":\"2943a930c6fcda99\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/transform.js\":\"8a6e259ac3f77468\",\"/knowledge-medium/pr-preview/pr-1846/src/themeBootDefaults.js\":\"1ccc27fe7a03663b\",\"/knowledge-medium/pr-preview/pr-1846/src/types.js\":\"b1c2daf5609ec268\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/ClientLocalSettings.js\":\"f234a94e3686e98c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/abortableSleep.js\":\"24b9f30b402930c0\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/array.js\":\"99c2d07906a915b9\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/backlinkAutocomplete.js\":\"400ac8aea402c3c8\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/blockCrumbs.js\":\"ca40922864d11f3f\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/blockrefAutocomplete.js\":\"16a6fed619b70daa\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/cadencedIdleJob.js\":\"a5220fa572807f96\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/callbackSet.js\":\"64bfd07846715174\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/clientId.js\":\"cb44826d364434e3\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/codemirror.js\":\"737a701705f6db99\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/codemirrorCompletion.js\":\"4e909f277a579900\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/copy.js\":\"b22d28e346988238\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dailyPage.js\":\"58819ec6b6b8f8d6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dbForensics.js\":\"1a40bdbd9181cf02\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dbForensicsHooks.js\":\"31607b74cb48fb46\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/deleteBlockThroughUi.js\":\"91e6c6673182fb85\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dialogs.js\":\"411e1b595d73d668\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dom.js\":\"ee57554072661348\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/downloadBlob.js\":\"d6fd69ed8995ab73\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/exportSqliteDb.js\":\"ee7b9d7dc9809b75\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fileSystemAccess.js\":\"9f153e18b82675cd\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/flipSlide.js\":\"037bacc48c095763\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fnv1a.js\":\"76242712ee1aadbe\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/formatBytes.js\":\"ab97d8223c7368cf\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fuzzyRank.js\":\"564c59620e4a38f5\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/idbKeyedStore.js\":\"c8d85b82960b7ffa\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/idleCallbackPolyfill.js\":\"4a5f9c67bb5cd8c4\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/keyboardAwareScroll.js\":\"4345cd1d33a22c96\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/keyboardViewport.js\":\"ff3c0fc7c334487f\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/lastWorkspace.js\":\"ca7a2b38850e81cf\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutColumns.js\":\"aa40686f17a99bcf\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutSessionDom.js\":\"8eae43075e78a03b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutSessionId.js\":\"ef8f56ce0e7e8485\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/linkClickGestures.js\":\"5f24f54648c0c0cf\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/linkTargetAutocomplete.js\":\"d2ca4ee4f512cb74\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/localDbCorruption.js\":\"0a0928122799062e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/localDbRecovery.js\":\"3f83ae546422d08b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/markdownParser.js\":\"ba3c56f924444619\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/memoize.js\":\"340b9b936b1e5b1a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/nameFieldCommit.js\":\"6e31c056038df3c7\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/nameList.js\":\"228336e73ad5e1f6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/navigation.js\":\"75044dc605d2bf5b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/omnilinerNamespace.js\":\"e56d9afd4b322828\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/opfsPageScan.js\":\"187bd37c14ae1937\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelClearance.js\":\"b90b9d09035985e9\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelHistory.js\":\"f10b89f89524718c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelLanes.js\":\"9f19199e2b682dbd\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelLayoutProjection.js\":\"692476a71bb9e072\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelScrollAnchor.js\":\"036ab1b23b0445af\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelUrlFlags.js\":\"5c058d1d467e8486\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/platform.js\":\"e7d2a3f7fb6a284d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/pluralize.js\":\"c21bed61e6e59d10\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyCreation.js\":\"1c4d9aadd0bf7d1b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyNavigation.js\":\"482383006e048ff7\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyValueContext.js\":\"60ed6fb6313be3c6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/react.js\":\"c0eec765c3a157c3\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/relativeDate.js\":\"2c3adb70819a3e18\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/relativeTime.js\":\"3fba142729a3dcd0\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/renderScope.js\":\"ea8d1322493c7cb0\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/resolvedThenable.js\":\"80c507f7bfc46d63\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/routing.js\":\"1891c0e67cfa2849\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/safeMode.js\":\"4a18167ac8242f95\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/scheduleIdle.js\":\"d349962646a7bbde\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/screenWakeLock.js\":\"bd2229e8c8f872a2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/selection.js\":\"815239659097cf05\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/softKeyboardGrab.js\":\"3151bf7f62f8dcdf\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/startupTimeline.js\":\"10e30c1445ac031c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/state.js\":\"8c99f6d5b3b81aa9\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/string.js\":\"bbd8a7d5e1210068\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/surfaceZoom.js\":\"b630020f3305c3f6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/time.js\":\"4002080ba30d6c65\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/toast.js\":\"f3fc730c3f215f9b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/toggleStore.js\":\"195897c9158b4e35\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/untilStopped.js\":\"38610e51c0ba7a18\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/userActivity.js\":\"ebbccc5f13d07f6c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/viewTransition.js\":\"1d246d9b7551a346\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/viewport.js\":\"274c90ba6c0e2e1e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/webLock.js\":\"a5380074da4b10df\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/workspaceRecovery.js\":\"a05e7448af4eb308\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/workspaceSnapshotStore.js\":\"5df118750f8f1455\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-compiler-runtime.js\":\"b14afafb934b9d47\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-client.js\":\"3d6d22fb05c21bd0\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-server-edge.js\":\"9b22799b245ba240\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-server.js\":\"3a3ff0b66b71e826\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-static-edge.js\":\"96f635d9b6682a0e\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-static.js\":\"ab8f714610077dc8\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-test-utils.js\":\"0cca1fae80e0e664\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom.js\":\"196b8c7023bab959\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-jsx-runtime.js\":\"b1415281a7cdbd89\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react.js\":\"845f8c0db49e6178\",\"/knowledge-medium/pr-preview/pr-1846/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1846/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1846/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
