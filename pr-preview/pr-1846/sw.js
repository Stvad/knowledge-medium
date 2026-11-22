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
		buildId: "b0264e197829-f6e483be",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/\":\"8bb838a8dcc653c4\",\"/knowledge-medium/pr-preview/pr-1846/index.html\":\"8bb838a8dcc653c4\",\"/knowledge-medium/pr-preview/pr-1846/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1846/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1846/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1846/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1846/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1846/assets/FacadeVFS-Cuc_pJ5k.js\":\"9b192afb14c04bba\",\"/knowledge-medium/pr-preview/pr-1846/assets/OPFSCoopSyncVFS-B4s0e9Xx.js\":\"16ef4e94724a0461\",\"/knowledge-medium/pr-preview/pr-1846/assets/OPFSWriteAheadVFS-DmiwJfWP.js\":\"0f362a1d1371b520\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-Bf_q2CX1.js\":\"8a1046760280d7e4\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-async-DyzoZ0I4.js\":\"520896e328a0766f\",\"/knowledge-medium/pr-preview/pr-1846/assets/worker-CtYXZDNX.js\":\"a836ca8165647d4b\",\"/knowledge-medium/pr-preview/pr-1846/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1846/chunks/app-D5c-_AVG.js\":\"a7860dc0012ac6d6\",\"/knowledge-medium/pr-preview/pr-1846/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1846/index.js\":\"9f81e0ecbc1f98f3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1846/assets/AccessHandlePoolVFS-Dsmo1HS6.js\":\"7cb7b7d6c2b2b1fe\",\"/knowledge-medium/pr-preview/pr-1846/assets/IDBBatchAtomicVFS-C7-vPcxJ.js\":\"dff84084e46a9d34\",\"/knowledge-medium/pr-preview/pr-1846/assets/MemoryVFS-DLPl70D3.js\":\"36f3bb41d37c48b0\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-BlcjHb6I.js\":\"a0d7affd462ddaa0\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-async-DblfZHmo.js\":\"939f1951d472d7c6\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1846/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1846/chunks/AccessHandlePoolVFS-B9Dn29Gh.js\":\"665705a32a4f2737\",\"/knowledge-medium/pr-preview/pr-1846/chunks/FacadeVFS-t1eksB69.js\":\"53086b806affef43\",\"/knowledge-medium/pr-preview/pr-1846/chunks/IDBBatchAtomicVFS-CqjzgKJ6.js\":\"9672ac6cbbdaa365\",\"/knowledge-medium/pr-preview/pr-1846/chunks/MemoryVFS-CPtn3iD0.js\":\"761c6d99a3d6bb41\",\"/knowledge-medium/pr-preview/pr-1846/chunks/OPFSCoopSyncVFS-w5_JzQkv.js\":\"1e00fdbc310067df\",\"/knowledge-medium/pr-preview/pr-1846/chunks/OPFSWriteAheadVFS-CquB_ktt.js\":\"1c94fef9c5b28634\",\"/knowledge-medium/pr-preview/pr-1846/chunks/Preview-CcxWNm2-.js\":\"0c72e43f097c65fc\",\"/knowledge-medium/pr-preview/pr-1846/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1846/chunks/card-BJd8uY8F.js\":\"6a25a5abc9f7eea8\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-DNXztaRT.js\":\"b01419df232f59d5\",\"/knowledge-medium/pr-preview/pr-1846/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1846/chunks/mc-wa-sqlite-BBDmmTOX.js\":\"1cbd2b9a5c82007f\",\"/knowledge-medium/pr-preview/pr-1846/chunks/mc-wa-sqlite-async-BAb8TCGe.js\":\"9f1520728616cb99\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-C5tLqwe3.js\":\"f647503234b94334\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-CdoESIMi.js\":\"79169acccec89411\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-CkMEKg2M.js\":\"d5335091e7c17e37\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-D0MHearq.js\":\"5ffd114448b7822a\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-DPOkglD-.js\":\"3aaa625e7232994e\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-DWBRmb97.js\":\"cdeee076feb945f2\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-De9FAXwa.js\":\"1f7f808fec60ea94\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-Ds6DzFJG.js\":\"42e01fbf69e02368\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server-legacy.browser.production-7gjSESi8.js\":\"e7edd71b5e35c15f\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server.browser.production-BWoH3dRf.js\":\"efc147394a937f5f\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server.edge.production-BYAfNAHR.js\":\"7e0492eacc5c5570\",\"/knowledge-medium/pr-preview/pr-1846/chunks/server.browser-xe9gaA_M.js\":\"b515b5b59f635eb5\",\"/knowledge-medium/pr-preview/pr-1846/chunks/textarea-93wIZCaG.js\":\"ddf4ff8a5b5af658\",\"/knowledge-medium/pr-preview/pr-1846/chunks/ui-0YOrBXZa.js\":\"f7b40fb2e42fb192\",\"/knowledge-medium/pr-preview/pr-1846/chunks/wa-sqlite-DRxP6gag.js\":\"c04e8508e75ead41\",\"/knowledge-medium/pr-preview/pr-1846/chunks/wa-sqlite-async-Cu4l9yQT.js\":\"2ed8c37398349730\",\"/knowledge-medium/pr-preview/pr-1846/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1846/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1846/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1846/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1846/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1846/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1846/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1846/src/App.js\":\"20b79e799a75fd37\",\"/knowledge-medium/pr-preview/pr-1846/src/appUpdate.js\":\"239b48a00d10a7a6\",\"/knowledge-medium/pr-preview/pr-1846/src/appVersion.js\":\"2c8cd4f3a4d4f1e8\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/initialLayout.js\":\"08f8bac805d44f72\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/openWorkspaceData.js\":\"08904cd4eca8a90f\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/resolveWorkspace.js\":\"b302e0c2035d6ecf\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/workspaceBootstrap.js\":\"49310f10b70b920a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockComponent.js\":\"1d5d24b8f0232e50\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockCrumbs.js\":\"95f8cb354787dcfe\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockEditor.js\":\"4db00e3de6c2e6e4\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockLoadingPlaceholder.js\":\"9c9875f251031b4a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockProperties.js\":\"6c2b6f0654b883bd\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockSearchPicker.js\":\"a62592d633168203\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ConfirmBulkDeleteDialog.js\":\"187905b0867fb1d7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/DividerHandle.js\":\"83bf220e20a1cc79\",\"/knowledge-medium/pr-preview/pr-1846/src/components/DraftEditor.js\":\"7ab312032e0fa563\",\"/knowledge-medium/pr-preview/pr-1846/src/components/GutterPill.js\":\"3cdd3d6aa5c3c56a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/Header.js\":\"6c573c7cb372a4ad\",\"/knowledge-medium/pr-preview/pr-1846/src/components/LazyBlockComponent.js\":\"c5995da505af4689\",\"/knowledge-medium/pr-preview/pr-1846/src/components/Login.js\":\"7c6064f7931f0ae2\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ZoomableSurface.js\":\"182232ac5cb42e2c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/editModeKeepalive.js\":\"79af3dd18546a1a0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyDisplay/PropertyDisplayScope.js\":\"72adc98d06899343\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4aa8fbbf3ff38a75\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/RefPropertyEditor.js\":\"1be43b497d126a4f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/RefTargetTypePicker.js\":\"6090925df6ae5729\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/SelectPropertyEditor.js\":\"148ab84dbfffa1d0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/TypesPropertyEditor.js\":\"e88db65bc437c994\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/defaults.js\":\"6f3cbd1bd394b9c8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/kernelValuePresets.js\":\"e4f6accb791f75c4\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/selectablePresets.js\":\"896c5e8fd827877c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/typesPropertyUi.js\":\"ca3d6e9676cbec06\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/AddPropertyForm.js\":\"8fb7be214cb9f6f1\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/PropertyPicker.js\":\"ef3dd6f92c027400\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/PropertyRow.js\":\"efd6988b1c9a593c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/Rows.js\":\"8df728d69dadf132\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/actions.js\":\"63e6c097ac1d9b9a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/declarationOnly.js\":\"5910cd0912578834\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/layout.js\":\"c0e0ba1fc7fa7177\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/model.js\":\"d374b13ba819bbda\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/shapeUi.js\":\"b96cd64b5211371c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/shapes.js\":\"294f1441b7317965\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7b77c86eea67890d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/visibility.js\":\"ea173dc042760ffa\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanelSections.js\":\"6a32f95e157e5a01\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockEmbed.js\":\"4dd231e403cf04b0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockLink.js\":\"283ca156793adc05\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockRef.js\":\"83b0389117c772fe\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/ReferenceLink.js\":\"430af0ae83e55ca7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/cycleGuard.js\":\"e1881f7ac5acf722\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/cycleGuardContext.js\":\"88b652fa33553004\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/linkInteraction.js\":\"768ba27e363fe610\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/referenceLayout.js\":\"08abf3dda3b0dcf1\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/useBlockRefAncestors.js\":\"5d1789e42ad1b3b9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockGutter.js\":\"7235a066b33b4901\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockInfoDialog.js\":\"845d36f0662bab07\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockTypeBlockRenderer.js\":\"b147481b3847951b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BulletHoverCard.js\":\"8737166e7de72a2d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/CodeMirrorContentRenderer.js\":\"60f456bddcb54147\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"368711d0aceb6a41\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/ColumnResizeHandles.js\":\"d1142e2b25757a73\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e236162c195adb40\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/DefaultBlockRenderer.js\":\"f1672ef05cf3229b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/LayoutRenderer.js\":\"223194be08fb3214\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/MarkdownContentRenderer.js\":\"25d09c898a541979\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/MissingDataRenderer.js\":\"ac381a2310887d01\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/PanelRenderer.js\":\"8a35f77c9d07d77d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8400a526baa68d33\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/TopLevelRenderer.js\":\"77c9609ef2769167\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/blockGutterMode.js\":\"0f26b2da9da9e892\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/blockTitleText.js\":\"a0b0150cb9479d6e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/fieldCreationKeydown.js\":\"887f14fb8c16e957\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/layoutRootContext.js\":\"dcf810db514515b0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/typeChip/TypeChip.js\":\"22c4db61b3a96e85\",\"/knowledge-medium/pr-preview/pr-1846/src/components/typeChip/chipStyle.js\":\"dca5063cc9f58eb0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/anchored-floating.js\":\"915b26a33ed20d18\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/button.js\":\"e93d9ebcb902cb93\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/card.js\":\"269929995dc5acd3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/checkbox.js\":\"95afc4a972d31078\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/collapsible.js\":\"2f31b5a0b0859773\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/command.js\":\"6b4058a7d2ee4985\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/context-menu.js\":\"af55622330c5890d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/dialog.js\":\"8cc8bb36a2115d82\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/dropdown-menu.js\":\"aae6b6f125a987a7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/floating-listbox.js\":\"2fbda99360d34a17\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/index.js\":\"029cf2ae12e1dd3d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/input.js\":\"f0830f60b84eac20\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/kbd.js\":\"aaef812a9edcdee6\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/label.js\":\"aa1f9f4978f44416\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/textarea.js\":\"cd3489fb81d040b4\",\"/knowledge-medium/pr-preview/pr-1846/src/components/useEditModeYieldKeepalive.js\":\"40f7862b4d18fb8d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/BootFallback.js\":\"911e7bf919ff12c8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/FocusedRowLazyMount.js\":\"c048e616bf93d324\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/LazyViewportMount.js\":\"8be1f47a6519eaa9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/LocalDbCorruptionFallback.js\":\"4a1b9e1371d64e31\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/error.js\":\"e7998f58bb5e67df\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/lazyMountRegistry.js\":\"63e3648823fccf54\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/suspense.js\":\"b4553a456d9bf458\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/CreateWorkspaceDialog.js\":\"093723b3c9bb1290\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/PendingInvitations.js\":\"e90464714542be91\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/SyncProgress.js\":\"e84aa1c570cb0e0b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/UnlockProgress.js\":\"06cedd03cddba1a1\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceKeyGate.js\":\"32ea5bb719d96d2e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSettingsDialog.js\":\"71b2811c55f19a3d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSwitcher.js\":\"5832480011d3844f\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSyncGate.js\":\"13358724a71b87b3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/ConversionFlow.js\":\"53c05cdada03b682\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/ConversionFlowHost.js\":\"f30bd58b0fada5c9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/EncryptionSection.js\":\"1040c73d25c9d657\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/attachmentPrompts.js\":\"a49f0e7f3bed5019\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/bundleFolderPrompts.js\":\"39eaf04a22a83faf\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/conversionFlowDeps.js\":\"711f673b40abe996\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/conversionFlowStore.js\":\"54b9bb0b91c26853\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/flowUi.js\":\"0b2f4cd618764e5e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/useConversionRun.js\":\"999d9c96e754c64b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/keyUi.js\":\"30c8bef1e6262009\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/useCloseOnKeyLoss.js\":\"34e6611596794326\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/useCloseOnServerE2ee.js\":\"cabf6f881391503c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/workspaceUnlocked.js\":\"f57068bee861f295\",\"/knowledge-medium/pr-preview/pr-1846/src/context/backgroundSubtree.js\":\"378e7d070bce6082\",\"/knowledge-medium/pr-preview/pr-1846/src/context/block.js\":\"136f47128692d4bc\",\"/knowledge-medium/pr-preview/pr-1846/src/context/layoutWsContext.js\":\"fb2e5972588f0eea\",\"/knowledge-medium/pr-preview/pr-1846/src/context/propertyDisplay.js\":\"8dc7078ed7c7b261\",\"/knowledge-medium/pr-preview/pr-1846/src/context/repo.js\":\"e6a8d7fc72079461\",\"/knowledge-medium/pr-preview/pr-1846/src/data/aliasClaim.js\":\"1b65d922cc2b280e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/aliasSeatNamespace.js\":\"60bbff695c2792ef\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/blockData.js\":\"5965fd4f99f39ea2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/blockType.js\":\"98ab0842e317d210\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/changeScope.js\":\"17352b14a437ecc2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/codecs.js\":\"ae9814e1949003d8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/derivedData.js\":\"94d78f27b31002b4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/errors.js\":\"1f8870b01fc796da\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/events.js\":\"e7e802b37a6ff9be\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/handle.js\":\"ebe8f0de9bb1e945\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/index.js\":\"6d637b7439b24bc2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/mutator.js\":\"2370efb07d3acef4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/processor.js\":\"efadbff744bd1875\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/propertySchema.js\":\"1be2bcf7ee00541f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/query.js\":\"bd53dd47784bc58b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/sameTxProcessor.js\":\"b59ad862aa6df467\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/schema.js\":\"ebe8f0de9bb1e945\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/tx.js\":\"ebe8f0de9bb1e945\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/typedBlockQuery.js\":\"20cb1b786335f6ea\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/user.js\":\"76cdb3a59164e457\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/valuePresetCore.js\":\"ac6e3219d521dc30\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/valuePresets.js\":\"a4b63c3b690b7719\",\"/knowledge-medium/pr-preview/pr-1846/src/data/attachmentCleanerIOVerb.js\":\"11c7ba08858c7de7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/block.js\":\"44f6230c895b6eef\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockCache.js\":\"65ee7a7e51440237\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockId.js\":\"3d9161f2c1804cdd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockLiveness.js\":\"98e7df10f7132eb5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockMerge.js\":\"739dbd615a51f99c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockSchema.js\":\"232b2c65e889efdb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockTypeLookup.js\":\"8353133fc90d2d0c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockTypes.js\":\"32707443d6cc269d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/clientContext.js\":\"bdc8c28698695112\",\"/knowledge-medium/pr-preview/pr-1846/src/data/dbFileSiblings.js\":\"443650f1952365e5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/definitionSeeds.js\":\"d594e19b71a706db\",\"/knowledge-medium/pr-preview/pr-1846/src/data/derivedIds.js\":\"e87b9b49225986f3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/drawnSubtree.js\":\"aa6800dfcd4fbf76\",\"/knowledge-medium/pr-preview/pr-1846/src/data/facetBridge.js\":\"1335ca40211f5987\",\"/knowledge-medium/pr-preview/pr-1846/src/data/facets.js\":\"95c081fe54f4a264\",\"/knowledge-medium/pr-preview/pr-1846/src/data/globalState.js\":\"2db5dbfd8af84c42\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/aliasClaimRederiveProcessor.js\":\"f754dde983a56da7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/ancestorBatch.js\":\"1eb2a91ea9f81f54\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/blockTypeTypeifyProcessor.js\":\"50d5841c04ec2cfb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/clientSchema.js\":\"408f52f0d7618667\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/commitPipeline.js\":\"0a9ce637cb6fb0f0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/devAssertions.js\":\"af34740db21efb35\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/firstSync.js\":\"c6a2d36ccacd3f4b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/freshInitialLoad.js\":\"518b7d06fb435cb5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/graphBackfillClaim.js\":\"504a96df83dfa695\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/handleStore.js\":\"f0d03387dbcfc47d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/idleMarkerJobs.js\":\"6615afbf3b1a8fbf\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/initialDownload.js\":\"5aa9acae3d7638f1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/initializeClientDatabase.js\":\"d1baf629221b5d0e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/jsonCanonical.js\":\"08ef89540e1c8831\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelInvalidation.js\":\"86b488d2237b62ee\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelProcessors.js\":\"72ab4c65f7fb3d4e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelQueries.js\":\"0b3f8b6307604ac9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/mergeTypeMembershipProcessor.js\":\"56a255071b466f12\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/normalizeReferencesProcessor.js\":\"5b25bf99164d3bde\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/poolInstrumentation.js\":\"57f43d4bed97e80c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/processorRunner.js\":\"466d86d12b8267af\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyCellBackfill.js\":\"cb070f856fd562df\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyChildMint.js\":\"f12d42dc68ae714f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyChildrenProcessor.js\":\"1b630931c132b42e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyDefinitionChangeProcessor.js\":\"cf1dc428bb3bfd90\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyDefinitionSynthesis.js\":\"cc75a7e949612f8f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyKeyScan.js\":\"5ff05d4d8b055333\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertySchemaResolution.js\":\"dddccfc7c649909c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyValueEdits.js\":\"3614ea5706f83ce3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/raiseProtocol.js\":\"e90be7881264cb1f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/readBatch.js\":\"2e855f786568bb89\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/refProjection.js\":\"0e14d530beb4f19b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/referenceTargetLookups.js\":\"afba317f36783d68\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/referenceTargetProcessor.js\":\"7e00166f14f8625b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/replayMerge.js\":\"894900e351909d33\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/sqlBinds.js\":\"3e139df0d5e919af\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"865ecf94983ce876\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/arrivalProcessors.js\":\"b21ea67055386e34\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/invalidate.js\":\"d9ed681d5e683280\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/materialize.js\":\"9db3b828e351dc81\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/observer.js\":\"65d9498c3409443e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/reconcile.js\":\"529b33c0de89f2a7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/timingMetrics.js\":\"2fa2dc2a0a722a0d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/treeQueries.js\":\"c2da560e7b8d40b5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/txEngine.js\":\"84408835907bbb37\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/txSnapshots.js\":\"9123c7edbeddaf50\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/typedBlockQuery.js\":\"c09c5f9a8dbe3a71\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/undoManager.js\":\"9c37e54356ada684\",\"/knowledge-medium/pr-preview/pr-1846/src/data/invalidation.js\":\"1453b227f5a064cf\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelDataExtension.js\":\"aa2536e1faa59ced\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelPage.js\":\"f679e555b63c5015\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelValuePresetCores.js\":\"bf6d2fa6ac8bd60b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbCorruptionSignal.js\":\"1c8248d6620cb546\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbStorage.js\":\"0642c46cae95c72c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbVfs.js\":\"a1ded2bc7a4fe688\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localSchema.js\":\"499430df603e3109\",\"/knowledge-medium/pr-preview/pr-1846/src/data/maintenance.js\":\"ecbb4efa623981bb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/mergeProperties.js\":\"5d36c2e558493bd0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/metricsConsoleHook.js\":\"72ac17eb75e559fb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/migrationsPage.js\":\"3a2c1297fcb5cd0c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/mutators.js\":\"6c7aead5a3d97f38\",\"/knowledge-medium/pr-preview/pr-1846/src/data/orderKey.js\":\"82c0260258ee33ce\",\"/knowledge-medium/pr-preview/pr-1846/src/data/orderKeyPlacement.js\":\"3660f943614f82b7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/outlineSurface.js\":\"0e8a73f7bab6404e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pendingEditorContent.js\":\"39b7e2d7be282c23\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pendingUploadsSql.js\":\"1c9009629b7dd5b0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pluginStateExtensions.js\":\"d47ca563df28e5bd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/powerSyncLogger.js\":\"327a438782beecf8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/projectorRuntime.js\":\"5471c25d1928df55\",\"/knowledge-medium/pr-preview/pr-1846/src/data/properties.js\":\"4371d0ceb5d40c60\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertiesPage.js\":\"0e3951cb4293a799\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyChildren.js\":\"2aab5c40dda30895\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionFanout.js\":\"f5269f8d494961f4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionMetadata.js\":\"f87e3e77626c1865\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionRegistry.js\":\"f147af4fe254c9f8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDisplayMode.js\":\"90a949a0c13e665a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyRowCreation.js\":\"9b528dd86d37d5ba\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertySchemaCreation.js\":\"61fd97a225f61edb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertySeeds.js\":\"ac1a7d17ae11fcc7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/recentsPage.js\":\"a2712c1132a73dfd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/referenceBlock.js\":\"bc2b912646596cb2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/rejectedUploads.js\":\"279efa80d84348af\",\"/knowledge-medium/pr-preview/pr-1846/src/data/releasePowerSyncConnection.js\":\"d06aee4d1e5a846b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/repo.js\":\"1b99e3d42476f407\",\"/knowledge-medium/pr-preview/pr-1846/src/data/repoProvider.js\":\"cd40b59e9ef8a5c2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/rowProperty.js\":\"2b1e61c32508d900\",\"/knowledge-medium/pr-preview/pr-1846/src/data/searchFilter.js\":\"3778d2b8ad12ef95\",\"/knowledge-medium/pr-preview/pr-1846/src/data/seedIdentityLedger.js\":\"fdeef71bbf6ff561\",\"/knowledge-medium/pr-preview/pr-1846/src/data/stateBlocks.js\":\"e4ba8ee92fbec207\",\"/knowledge-medium/pr-preview/pr-1846/src/data/structuralEditPolicy.js\":\"c3210ed619668ea8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/subtreeDelete.js\":\"af399b1aeab0797c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncStreamLock.js\":\"9d6378123d882731\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncedTableSqlRecognizer.js\":\"2ca3ae4068306b32\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncedTableWriteGuard.js\":\"3210b9b14731270f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/targets.js\":\"11f5ce48e1ba768e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeColors.js\":\"d8886f10f08c2a07\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeDefinitionMetadata.js\":\"a14fae00a63c81e0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeDefinitionRegistry.js\":\"a525c3a969969596\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeExtraction.js\":\"1c84697526b94edc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeInitialValues.js\":\"26e57c3a173108ec\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typePropertyGroups.js\":\"c26f81c12dafd97b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeSeeds.js\":\"c245f745bc87b4b0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeTagger.js\":\"e4068d5a446b4926\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typedRecords.js\":\"1c9526951f4ab2d4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typesPage.js\":\"8c947cbedbbe9c38\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userPrefs.js\":\"88134b6398d0edb9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userSchemasService.js\":\"df70dc0f2a809654\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userTypesService.js\":\"607ad9ddf96e786b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/valuePresetRegistry.js\":\"2380ceed123e9df6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/visibleChildren.js\":\"55f29a70c787ca32\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceConversion.js\":\"8b9603b53594deb8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceFirstSync.js\":\"b4cf6b175d827ee7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceIdNamespace.js\":\"7efde05d05d97b26\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceSchema.js\":\"d8be5a6a59a717b2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaces.js\":\"e3939cfa89042bd9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/writeAheadLog.js\":\"111213f6df092490\",\"/knowledge-medium/pr-preview/pr-1846/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/BlockPasteShellDecorator.js\":\"2992cfa034176213\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/atTrigger.js\":\"0242ce3ce76ee9ef\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/autocomplete.js\":\"f8d04e5dc060794f\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/codeMirrorExtensions.js\":\"521e84a039ea9f18\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/contentFlush.js\":\"6738c5c6bebb2132\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/defaultInteractions.js\":\"5d0b3d0c279d788e\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/editSettleSignal.js\":\"a43d1e011b83d3e6\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/insertImage.js\":\"ae076c0716f281ce\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/referenceCompletionRange.js\":\"ee1f39b4ab84ce14\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/referenceTargetTypes.js\":\"bc8578aea8865e5b\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/syntaxContext.js\":\"c89091d1e4c9e903\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/triggerMatch.js\":\"b6f4416ff0da7a64\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/AppRuntimeProvider.js\":\"ba352d425180c517\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/BlockFocusShellDecorator.js\":\"3256c121a9bc78cb\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/ExtensionRenderBoundary.js\":\"6f66a36e9a37e386\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/PanelContentRecovery.js\":\"fa8b7bf31b83e9aa\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/apiCatalog.js\":\"7c8fb9c066257bcd\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/approveExtensionHere.js\":\"0d34cf6f717f9a41\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/armedCutAppMount.js\":\"11215e9df500dbc6\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/batchableKeyedStore.js\":\"9949bde0337447ad\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/blockInteraction.js\":\"c5b581f7b2bd159d\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/blockSelectionAction.js\":\"ff9bdbce04766337\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/compileExtensionModule.js\":\"6c277585c31237d4\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/compiledModuleCache.js\":\"5d1302662dae4acd\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/continuousGestures.js\":\"3e65f7cf4d81ca62\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/core.js\":\"7c0013f88ce8b5df\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/defaultRenderers.js\":\"b2c081561747c435\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/definitionFanoutAppMount.js\":\"4cb7a7ffdf633c58\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dialogAppMount.js\":\"3f3459b69ec6ec6c\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dynamicExtensionSeeds.js\":\"979649445cbb2b45\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dynamicExtensions.js\":\"5c3e36ff41f11ba6\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/exampleExtensions.js\":\"f505eb35ac9ff88f\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionApprovalStatus.js\":\"42fea13d939d2d0c\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLoadErrorToast.js\":\"63fc3924c6ad948e\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLoadErrors.js\":\"fa8bfcf925ae9865\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLookup.js\":\"2de6c1f1119ff379\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionToggles.js\":\"8016e065aee0d902\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionUtilitiesCss.js\":\"1dd5ad7c4642d907\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/kernelPageDeletionGuard.js\":\"5afad409cf43d3eb\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/liveRuntime.js\":\"2007d5b6dc5bc774\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/openExtensionsSettings.js\":\"e8f8f32a5a8bd52a\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/overridesCache.js\":\"e71cebba5c7768b3\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/pluginIds.js\":\"64074558ada5bb67\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/processorRejectionToast.js\":\"658f33c270305e9e\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/runtimeActions.js\":\"59970b0e63582ca5\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/runtimeContext.js\":\"f90267bac82accbb\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/staticAppExtensions.js\":\"71434b3ab618bd71\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/staticDataExtensions.js\":\"7f48c251c671f8a8\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/toastAppMount.js\":\"a38f52984804f0ef\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/useOverrides.js\":\"1119e58dab6b7993\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/useShortcutSurfaceActivations.js\":\"dddeb79a235a80b4\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/discoverToggleTree.js\":\"63bd0a5f6669b20f\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/facet.js\":\"36d710db68a260d0\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/resolveAppRuntime.js\":\"18cae27e95863de4\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/runtimeEvents.js\":\"469f0be6004eed0b\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/togglable.js\":\"9211d1f0b21053ac\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/variantFacet.js\":\"22ef13297a82a999\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/verbFacet.js\":\"d1f5957960e22246\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/block.js\":\"09b3a1f1872e3dcf\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/focusedChild.js\":\"94bc7cd0dc16e8f9\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/propertySchemas.js\":\"863629703855a2f0\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/typeRegistry.js\":\"0ba684a69a83ae5f\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useAncestorCrumbs.js\":\"e68ff8d98e332114\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useAutocompleteListbox.js\":\"cf94495a8035345b\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useDebouncedSearch.js\":\"39774eb383c83fcc\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useDebouncedValue.js\":\"e29187327f417e95\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useIsFocalRender.js\":\"48eb0f9087fdd47a\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useIsReadOnly.js\":\"da878ceeb77ee20d\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useMaterializeBacklog.js\":\"be3e4f5d2467c9e2\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useMinuteClock.js\":\"1661da74666a6e2f\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/usePanelLayoutProjection.js\":\"0768357b4a44ae1b\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/usePendingInvitations.js\":\"4796932fe365cdd4\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useRendererRegistry.js\":\"c53926f50f9a6399\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useRetainedFieldRows.js\":\"600a1f90c2fe0c2f\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useWorkspaces.js\":\"965a80ac8bc46e4d\",\"/knowledge-medium/pr-preview/pr-1846/src/lib/utils.js\":\"0e9cf4bae881a85e\",\"/knowledge-medium/pr-preview/pr-1846/src/main.js\":\"e287a13f65557602\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/MarkdownImage.js\":\"b9a1328e1c011a60\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/blockSeparators.js\":\"58a2bf4232ad19c9\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/context.js\":\"f189ace195116d50\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/defaultMarkdownExtension.js\":\"f6cccd74982f6754\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/extensions.js\":\"38a019b3721b2f01\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/renderMarkdownHtml.js\":\"9cb1f2ab4fb5dd2a\",\"/knowledge-medium/pr-preview/pr-1846/src/minimal-editor.js\":\"c7a161a0167eb79a\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/armedCut.js\":\"0bb6f6d22c493d24\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/captureMediaVerb.js\":\"9e9911e374393b18\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/clipboard.js\":\"1fe5967fd7163c02\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/decision.js\":\"97be4ed84be4a487\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/operations.js\":\"5ba07aeec8c3c790\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/account-header/AccountHeaderItem.js\":\"fd19ede0bada99bf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/account-header/index.js\":\"48f317dcd7aa515b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1ff7c1457aaeddce\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/askAgent.js\":\"2738b47b72c48cd7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/askedStore.js\":\"a9aeed1806579e58\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"38e3fc0999a93e7b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/chipState.js\":\"f64405506f1a27dd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/dataExtension.js\":\"64040aac2ca4115c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/index.js\":\"1fe5c22f35f6b733\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ea31f4a9bad4ab27\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/schema.js\":\"11780a98c4a4d5d5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3edd961b943be0c2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/BridgePairingDialog.js\":\"dfd9cc50e3338c79\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/addMedia.js\":\"dc23b2ae0cc96664\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/backlinks.js\":\"bb7a95ecde2a9826\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/block.js\":\"7862b529b6c56221\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/context.js\":\"34f336e7c864dca9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0d8b66b20bbe0c73\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/index.js\":\"0a52562c412c65d3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/outline.js\":\"5bf8b51042e13553\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/properties.js\":\"28911fe0605c11d5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/refs.js\":\"1c05617de86e7ece\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"00d320b967190b72\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/search.js\":\"01367a1a848d2020\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/shared.js\":\"6a526ae452475b9a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"738e43daeeb337d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/text.js\":\"1730261333624757\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentWrites.js\":\"59f03a7361ea0ad8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/authoringCatalog.js\":\"81b7bafa26ca9481\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/blockRefTargets.js\":\"996d70e45e68a855\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/bridge.js\":\"1c124648f662ddc9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/bridgeLoop.js\":\"9d752ec1787e9a54\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/changeHistory.js\":\"3912785f47aa4505\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/commands.js\":\"c1dc3ba878874706\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/commentsCommands.js\":\"44e98449b542b9e3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/dataExtension.js\":\"c01fc6aacd857aaf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/dataModelGuide.js\":\"b48b7e8c64817363\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/describeRuntime.js\":\"11d41cd73e26f05b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/extensionLint.js\":\"bff30427427aca7f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/grainAudit.js\":\"1b6ced4faee2b8b4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/healthCommand.js\":\"d0d65eb0441535c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/index.js\":\"2cf7886a3227cad6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/presetIdentity.js\":\"aa811c53ffa68cd2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f54a7339519bda6f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/readMedia.js\":\"66c4f9dfb5c5fd60\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/schema.js\":\"a4507215ef1ac44a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/serialization.js\":\"24404f5df3eaf5c4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/targets.js\":\"6ff6bb8afd476255\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/tokens.js\":\"273cb3948756dd28\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/watchEvents.js\":\"f631fd008956e992\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/workspaceGuard.js\":\"6c815ace3a0306d6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/writeCommands.js\":\"9039393ba3112e2f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/AliasCollisionToast.js\":\"51c0c5312a721397\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/DuplicateNameBanner.js\":\"016f1e68064669dd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/collisionMerge.js\":\"87a936e5b7b00a92\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/dataExtension.js\":\"0119c4ebfbaffdaf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/index.js\":\"b4d5b328a12e6263\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/mergeCollisionAction.js\":\"4466a63ddc848cb9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/pageStyling.js\":\"f7e9738628dde7e4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/rejectionToast.js\":\"763709777571a49f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/syncProcessor.js\":\"4334b13aee1cdb6a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/actions.js\":\"5efc245623e90e46\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/addComment.js\":\"ce04fbc240af0eb5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/anchor.js\":\"a5a11489697021a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/anchorState.js\":\"9b9528569256b27e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/commentLinks.js\":\"bba8b83e694b9669\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/confirmThreadDeletion.js\":\"7fb41e7a6fa98d58\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/container.js\":\"530c7191710ded1a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/dataExtension.js\":\"9b5cb1414c699b66\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/deleteComment.js\":\"b3e7fe0ab75139ed\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/highlights.js\":\"b313e7f5032eab77\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/index.js\":\"06efd05fccbc89d3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/linkedCommentsPill.js\":\"2707a97c878b8b14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/margin.js\":\"4b353dbce368ede6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/marginSchema.js\":\"2bf601c236678a82\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/newComment.js\":\"50cc25f78c7126c5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/ownThreadPicker.js\":\"f8b4e585bc1b44f3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/placement.js\":\"9a2b66c01eacdb9b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/queries.js\":\"72402bc821f07200\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotePosition.js\":\"424d9a8ede2c53a5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotedIn.js\":\"0572322ade7fef5f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotedRange.js\":\"a48d600bd4872bf7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/rangeRefs.js\":\"2bbecb349def6cf5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readHighlights.js\":\"0563f58dcd45f914\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readSelection.js\":\"89a82ef017bc69b1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readSelectionUi.js\":\"ae7766bffebcb284\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/reanchor.js\":\"da54bf62b272251e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/schema.js\":\"e040e87ef8716a0a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/scope.js\":\"a18ce66bae00f89a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/scopeThreads.js\":\"2db23fb306750d4d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/splitRetarget.js\":\"caa64bebb6bdc6bf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/suggestionCard.js\":\"d3bcf1ccc4bc9327\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/suggestions.js\":\"0e723c620fb5bbf8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/summaries.js\":\"0489f06ef1145dbe\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/summaryBatch.js\":\"41dbcb264bec00ec\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/surface.js\":\"fd0a2714a14f9f98\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/threadNavigation.js\":\"f74a676ed7b0d16a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/threads.js\":\"10ae056e813ecd34\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/ui.js\":\"1efb04107e05277e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/uiStore.js\":\"21007bd0fa3d9b5a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-intents/appIntents.js\":\"dc2e6617662ff35b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-intents/index.js\":\"fac4f1101f9f8327\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-update-prompt/index.js\":\"0052374a072027c6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-update-prompt/status.js\":\"5011bc13ac2eaed4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9cdc20010f020ddd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaBlockRenderer.js\":\"c169746c15b37b28\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b513171c1ad64f90\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaUploadReconciler.js\":\"f5b8b0e30c7ddf0e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetDownLane.js\":\"835ff499481a5b6a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetResolver.js\":\"54c2c5e0365d4b4b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetUpload.js\":\"830898e10324a9b4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/attachmentCleanerIO.js\":\"ef4986f71eb57d2b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2d6f4aea8bde4d5e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/blobStore.js\":\"cf17a42e1649894c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/byteStore.js\":\"90769894144e89e3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/cleanerIO.js\":\"0e80e58c93ba4310\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/cleanupAttachments.js\":\"a57e172433f855ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/dataExtension.js\":\"2e5d9b1bccab0550\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/downLane.js\":\"6ba7b30738f386d7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/index.js\":\"2941b99aac7f2d51\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/insertImageContribution.js\":\"155b875918e14523\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/laneArming.js\":\"4af5a274d16afc37\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/laneLock.js\":\"e1a35802a82f5c5b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaBlock.js\":\"14866ec8c30861fd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaCapture.js\":\"4488b0bb3c500000\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaViewers.js\":\"88579f84e3178503\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaViewersFacet.js\":\"6bbfa30c1984719b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/pasteCapture.js\":\"cbc0cdf357ba13b2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/resolver.js\":\"6f0da789ac7425ab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/retryUploadsAction.js\":\"1d1e23b7ac5fd5e2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/storagePaths.js\":\"44c77665e3437fd1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadDrain.js\":\"fea491addb15c9fa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadLaneStatus.js\":\"ef7d9b0b39d75cc2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadReconcile.js\":\"87a14d3ecc56dda7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadRecovery.js\":\"5cf2da44bbb5326a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadStore.js\":\"4c16aa67379009c0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/useAssetObjectUrl.js\":\"fdcdb60b8d4d2152\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"7f9176add2abe66c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e8ef5edea88f7dda\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/facet.js\":\"aca8ca6dfd762636\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/index.js\":\"9d8bc3c9e2e4a5b4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/prop.js\":\"ec2b4588a225c978\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BacklinkFilters.js\":\"c7c39b9df32ec441\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f2cd6c01495b6db0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BlockEntry.js\":\"719ae29253bd0cc1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/LinkedReferences.js\":\"a4364b3c22056f4e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"21727b491740572b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/dailyNoteDefaults.js\":\"a03fcf11f2b34c8a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/dataExtension.js\":\"66596f87b9d9c540\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/edgeExclusions.js\":\"d08046364b2bff9e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/filterProperty.js\":\"b5014fb86efbc5bd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/index.js\":\"3aee962f308d3401\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a3ef0a3a675126fd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/applies.js\":\"4a876c0043be0e0f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/countQuery.js\":\"9d2ef535828cef41\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/expansionStore.js\":\"45c7fc0b91962bc7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/index.js\":\"413d6173696e12f6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"4521aa3c3496a599\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/presentationInvalidation.js\":\"b6e1e9686bf8d68b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/propertyEditorOverride.js\":\"12667cf141bc51db\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/propertyFilter.js\":\"2e69a47daabd3a61\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/query.js\":\"d3ee552f2913e7db\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/resolveFilter.js\":\"74d5f2e8e017a121\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/sourceBatch.js\":\"9b708f11f8c0f999\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/sources.js\":\"86c2d7da98e7f024\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/useBacklinks.js\":\"b5a1a28226458d07\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"72bdd468e60b81d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/BirthdayCelebration.js\":\"e56a5322d624e3ff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/BirthdayOverlay.js\":\"04d97cc28527fae4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/gate.js\":\"7b45bfb33057ee6a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/index.js\":\"233c62c9b36ff256\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/wolfTheme.js\":\"934746ff610756d4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/BlockDragLayer.js\":\"38875a70b1ce376e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/dragController.js\":\"d680c480988f11ab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/dropTarget.js\":\"52d4525533bbea5c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/index.js\":\"23dda458867ec80e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/projection.js\":\"1babe52f1b1a4ad9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-info/BlockMetaCard.js\":\"b82563a343609678\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-info/index.js\":\"a2951536bd3f6c73\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/AddTagDialog.js\":\"6ea6c3748faa8fc4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a08d11e32d72c8bd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/TagNameIssueHint.js\":\"3468b9d55ff60c51\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/addTagAction.js\":\"facaac82a95c2fab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/appendTag.js\":\"0b65d3da77c6efb2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/config.js\":\"5d883ae3a11f12f4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/dataExtension.js\":\"51828d72d9eb4251\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/index.js\":\"dc279506b743d2b4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/propertyEditorOverride.js\":\"8173b7381fd970f3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e07c6f6b61d3fcff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d05cfcc1e06a0131\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/Breadcrumbs.js\":\"de31aca14b48f744\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"5ed47ab49e880f26\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"53bc4d991f5dd1ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/index.js\":\"87b3f2c55dd6a545\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9edad74de2249add\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/CharacterCountItem.js\":\"bd38f16d0a123c3b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/ProfilePropertyEditor.js\":\"948980db280c1ad0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/actions.js\":\"b6062d6660d8d1ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/blockType.js\":\"7dd746201d04fe30\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/charCount.js\":\"ad28e68a55866a97\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/dataExtension.js\":\"279045c701f58170\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/index.js\":\"c83d24ecf780ae4a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/profiles.js\":\"fee5345d706bfe6f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/properties.js\":\"9a19f6f2cd86af8c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/textCounts.js\":\"2415ccb6c209cb9f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/colemak-keybindings/index.js\":\"0f686d06e191a5c8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/CommandPalette.js\":\"f4664e0d1c5ac151\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/HeaderItem.js\":\"fbf414e59686c16e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/context.js\":\"51ea484034eb5bff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/index.js\":\"3e7ce4628bc2fe29\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/selection.js\":\"2d74cde6d6abdd9c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/toggleStore.js\":\"6c8ffec36765d4c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/useCommandPaletteActions.js\":\"e6a6510fb0fd257f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/ContributorBadges.js\":\"a342fd94da753ae2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/author.js\":\"c656ac25fb7a92f6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/codeMirrorExtensions.js\":\"5e83d737269f7fa3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/dataExtension.js\":\"759945fff670b69c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/index.js\":\"5f9008c2ce7c5913\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/mentionAutocomplete.js\":\"4c4ee1218be9e0e8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/processor.js\":\"536aa21e8bfece50\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/profiles.js\":\"b80ef0f0797ffb76\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/queries.js\":\"69ed9ead6033873e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/schema.js\":\"77824e15bc4732f9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e6b1330ff4ff309a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/followOrigin.js\":\"296688d684bd2041\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/index.js\":\"7c1c12406b554f6d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1354decafaa417e9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"103620b42dcc0716\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/CalendarGrid.js\":\"bca082864534b94e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DailyNotePicker.js\":\"79b0b76a72746573\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c018d908532e0f9d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateNavDecorator.js\":\"06059264c12a2505\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateScrubOverlay.js\":\"03df0d17ebfddfa9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/HeaderItem.js\":\"72e37fd13860dfbf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/ReschedulePicker.js\":\"9bfaa564e737f827\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/SpreadDatesDialog.js\":\"574d764a4ac255ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/actions.js\":\"1b9e9710b2feae7c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/blockDateAdapter.js\":\"791d834cfc48b7d1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/calendar.js\":\"3246494b29144f0f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dailyNotes.js\":\"b302b63424aaded4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dataExtension.js\":\"56d1bc6f9152fdea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubActions.js\":\"dec2fb681bacd830\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubGesture.js\":\"d573bd21d3a09d49\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubGestureActions.js\":\"88e81879b1d7b209\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0ab1b2e558f33c77\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/deletionGuard.js\":\"c97803e41317f02d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dueQuery.js\":\"7b5153bf20e0289a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/index.js\":\"4a8797b43a40079f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/landing.js\":\"93103266dcf9aece\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/localSchema.js\":\"66f8b0de43e2f929\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/referenceDateAdapter.js\":\"18378e42e1653262\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/rescheduleAction.js\":\"0d112a2b31190907\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/schema.js\":\"ae0917e3b9ca9f41\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/spreadBlockDates.js\":\"35a143f5e406e544\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/spreadDatesAction.js\":\"cdf48522968f29ad\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/today.js\":\"6ff5f3c6bc9ec499\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a66f252f1f615cee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6aa88eddf5df8d47\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/audit.js\":\"39aaaad94187b010\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/auditAction.js\":\"feb573d1844adf0f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/auditRanges.js\":\"ce2d4dae4922390b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/diagnosticsSource.js\":\"2ff8d4092a376af9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/divergenceScan.js\":\"e8e6a73f31679969\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/index.js\":\"d8b8930cd2db6ace\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/propertyChildrenChecks.js\":\"55c13aab06efedae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/referencesMirror.js\":\"3b0a515e8b161bef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/rowJson.js\":\"2a30dac841eef1f3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/schedule.js\":\"6fbcdcf6aa62acff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/store.js\":\"a5e6f558e69c46f2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/action.js\":\"becc9b9634cb4f9e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/index.js\":\"4c6839e734140c65\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/plugin.js\":\"afc0576fed0bf5aa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5e11931202553a1b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/actions.js\":\"2c73c152bc39889f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/changeMarker.js\":\"bd41df6852d2caa1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/diagnostics.js\":\"f98915c58163c520\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/fileSystemAccess.js\":\"ee21d3123e26ca63\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/filenames.js\":\"fd2169bd238494d1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/index.js\":\"efa4c3ba42437ecd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/mirror.js\":\"0b8843413626ee4f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/runLock.js\":\"98eeaa41f24a8168\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/runtimeHealth.js\":\"b0edb8a30776279f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/schedule.js\":\"8a5efdf8b20a9012\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/store.js\":\"4e8cbe336b68c8bb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/default-themes/index.js\":\"eea55b87700a5f13\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/default-themes/themes.js\":\"09dc8c42d388d57f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/diagnostics/facet.js\":\"9b563b72a192a0d4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/diagnostics/useDiagnostics.js\":\"a2c05ca093ceaf67\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/dismissals.js\":\"55854091104f1f81\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/index.js\":\"616a87bd6116fa27\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/status.js\":\"c2f7d9eaa49b0d01\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/store.js\":\"50a20286290b94f1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"538509386a7c6055\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a77eb25856b59ebb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/actions.js\":\"dd82567702ce1a83\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/config.js\":\"ae1d1fbd6610c607\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/dataExtension.js\":\"0fc38f7a82f84899\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/effect.js\":\"ba89e114d58004a3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/index.js\":\"08588aa817cf9bd9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/propertyEditorOverride.js\":\"20eb4c27fe56abe6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/useToggleTree.js\":\"d491e4c0385cc9c0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/ExtractTypeDialog.js\":\"f71262bc93b4f26e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ac8f42d982c38d41\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/PropertyShapePicker.js\":\"43d95bd26f7653e2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/action.js\":\"8016dd0722a25806\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/index.js\":\"16a1079f363abbb0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/FindReplaceDialog.js\":\"94b1b1984af86193\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/HeaderItem.js\":\"0f7bed5ac1237bd6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/dataExtension.js\":\"70d42eccb26842dc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/index.js\":\"979c0d77416f6118\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/search.js\":\"a15e2b64597fcde8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/toggleStore.js\":\"d7302121bd7a6440\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/LocationPropertyEditor.js\":\"eaf33ee8eac027de\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/MapView.js\":\"6a8012551a1c88e6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/blockTypes.js\":\"f2bd7793d007e490\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/codeMirrorExtensions.js\":\"da0f156638379d12\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/createOrFindPlace.js\":\"cca55f1d81feb13b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/currentLocation.js\":\"dd0ecb6d6068c8c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/dataExtension.js\":\"564a910cbe33fec4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/geoContentDecorator.js\":\"083676f943d93368\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/googlePlacesClient.js\":\"c3040370eba8e462\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/index.js\":\"72d4e6c8243e88c2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/locationsPage.js\":\"3d2493a25397dabd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/mapViewport.js\":\"b7518558b00689eb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/pickCurrentLocation.js\":\"14f383ebb47bd167\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/placeAutocomplete.js\":\"a6be316868cf3756\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/placeNameCollision.js\":\"383f61dac15eb379\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/properties.js\":\"7819ee7bdb33e5ab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/propertyEditorOverrides.js\":\"4113371b87185bd7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/query.js\":\"e96a62c94d0e2a8b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/usePlaceSearch.js\":\"17d1dfcd78fdd434\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6ca5789c0305a630\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"53a87ec78df99177\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"dd6a896e6303b4cb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/config.js\":\"1da835a581482bbf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/dataExtension.js\":\"f6dfbec219507f0f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/facet.js\":\"e855a17f7fca67b8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/grouping.js\":\"ceed7bd56e7cf084\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/index.js\":\"bc0f1f3e0c024e15\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"fd5befb15eecbb44\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/query.js\":\"27f7da0801310b24\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/resolveConfig.js\":\"97a5ed0221eec02c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d01e5a8805f05a37\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4007890079824861\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/HtmlDocumentContent.js\":\"8960a6b2db4c5036\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/HtmlFrame.js\":\"dfbd99628cda78b0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/actions.js\":\"0de2ef9b5c846c1a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/blockType.js\":\"f826f9cd321d80cd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/confirmRunScripts.js\":\"3f50dafebde49a2c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/dataExtension.js\":\"0f1ed9d4f280adf1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameAnnotations.js\":\"a0c1b195f301e424\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameDocument.js\":\"9611b467a612c130\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameTheme.js\":\"8dcf64dfe0414e22\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/index.js\":\"d44c3a3c3544a034\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/scriptConsent.js\":\"4dca7b7669728467\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/sourceMap.js\":\"e227bb22b039db9e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/useDocumentScripts.js\":\"45530a963c361cb2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/index.js\":\"b33936035f48e9e8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/record.js\":\"9567886b6c5bdb9f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/recordStore.js\":\"b81827ed14815c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/responsiveness.js\":\"ad1f412a5376c62e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/schedule.js\":\"771cafaecdcfa894\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/sessionContext.js\":\"ee3c1e0941d504aa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0f9d01a9f37a027d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"338b9bc023cf13bd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/actions.js\":\"e4bb4cf2ec102ab6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/config.js\":\"5f275b9b40625e6a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/dataExtension.js\":\"f6e64ac29e70b5e5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/effect.js\":\"66912b3e5a650244\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/index.js\":\"dd8c38f1c464bd50\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/keyCapture.js\":\"244569dc806f160f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/overrideStore.js\":\"886f2e6ebe9936a3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dbf4539ef6ec1b2c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/HeaderItem.js\":\"9b1fbadb5b425adf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/LeftSidebar.js\":\"41f83b3fb39eb49e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/actions.js\":\"5406e95a93a11b70\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/facet.js\":\"f8aaa7b3bf22bedd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/index.js\":\"62a7d93ec8db0f2f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/shortcuts.js\":\"edb1f48cce6ade51\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/toggleStore.js\":\"9fe77e78ed709d1e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/MergePicker.js\":\"f73c931e1f8c05f9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/index.js\":\"89b73ec8bf71b18f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/mergeAction.js\":\"cd67507361e23bc7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/strategy.js\":\"43a7616a04a25f9c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/Button.js\":\"fcd20a300d13c2ae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c76547c9e5524bec\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4a94ef5713f91785\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/facet.js\":\"7b2eed764e1f851c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/index.js\":\"e2ddd53e7adc9a3c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a0cdf21b12f31d4e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/actions.js\":\"21a690098f309b09\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d46717c3521b9165\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/facet.js\":\"13cd6b72c172edb5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/index.js\":\"7f7074292487a9fd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/MoveDestinationPicker.js\":\"0f3106ff1984f533\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/blockSubtreeMembership.js\":\"97b4b387a07dda8e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/contextMenuItem.js\":\"383f0b1d1ec10526\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/index.js\":\"efcead3d608fb325\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/moveAction.js\":\"396cafb91dc76376\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/moveBlocks.js\":\"51af879a73793700\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/selectionAfterMove.js\":\"40d0dcadd00461fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/TutorialBanner.js\":\"215bd614f0921bb8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/action.js\":\"be301bac14a59571\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/bannerDismissal.js\":\"c4e73bc4c8f76d58\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/documents/cheatSheet.js\":\"806c76130c57293b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/index.js\":\"02efeadc08238591\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/keys.js\":\"f9dc48d30474fe24\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/landing.js\":\"18b78eefca5e2816\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/outline.js\":\"c174c68aaa34b9bb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/seed.js\":\"4e0e2267a99cd3c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0f4756fbfd6dc67f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/analyze.js\":\"4c40174889fa2aa8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/diagnosticsSource.js\":\"c4cb83964125723a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/index.js\":\"fdec3cd1e296a040\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/load.js\":\"24a3e34f966ac464\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/monitorRun.js\":\"a089b233d165c813\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/schedule.js\":\"af322d852e6da92c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/series.js\":\"19e00c1ee51cc72c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/store.js\":\"9d635e4cd226e321\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/trendAction.js\":\"72a16644ae0c3786\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/verdict.js\":\"29246517c4492ba1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/clickToEditAction.js\":\"bc03dd9d32b2edfd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/index.js\":\"50256ab69feba01c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/interactions.js\":\"97056f8a30b822c6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"29c8e310df7cac77\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/MigrationGate.js\":\"c4c82c7cebcc5506\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/MigrationGateDialog.js\":\"c6615ac8c9f7d53a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/action.js\":\"cc1de2f464241920\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/index.js\":\"dcf0f2c8a8f8ec1f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/localRunMessage.js\":\"f31f9c4a0ab695ed\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/plugin.js\":\"3d0735063098fbb0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/progressReport.js\":\"9cd493f12a55a794\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/sweepProgress.js\":\"a98631f46e1a4993\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/FieldRowRenderer.js\":\"956f89c439386d24\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/ValueRowRenderer.js\":\"e4e2b894d220c2ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/actions.js\":\"f3228930c775b63f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/autocomplete.js\":\"e7c52dbcaf35a1b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/fieldRow.js\":\"764105b825ad2af1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/index.js\":\"40b37806b766853e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/referenceWarning.js\":\"3176ee506ec284d4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/valueAutocomplete.js\":\"92b9b506815b33bd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/valueSchema.js\":\"4c4d623238e20c46\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/HeaderItem.js\":\"4f4a90d73dfe0196\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/QuickFind.js\":\"df0da22f53cea845\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/index.js\":\"11f4799d7059d116\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/recents.js\":\"0d6f73a248057f45\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/resultItems.js\":\"063e907f23a780f8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/selection.js\":\"abba735c43bbdd16\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/toggleStore.js\":\"a1900aef3bc32743\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/HeaderItem.js\":\"c1289c80eb87d5c4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2ea1c8146c5add02\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/grouping.js\":\"ee61a2552624349b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/index.js\":\"e2408f4f6455998d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/target.js\":\"95f806cf607bfbac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/codeMirrorExtensions.js\":\"0233d5e1cf8d4dd7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/contentPrefill.js\":\"3e09a7dedd0db280\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/dataExtension.js\":\"20ed2614b177ae12\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/index.js\":\"a593b07bc25241ae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f512d7c3c1783c27\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/invalidation.js\":\"4761bfb257d47046\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/localSchema.js\":\"c9f3c5eee2be87bf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/blockrefs/index.js\":\"103a8a098470ab73\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e4c13af80ac3a720\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/index.js\":\"32dedafa9b358f69\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/referenceNode.js\":\"d59d82ae3b1c561f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e723634be6ee0f72\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"305624a386c44e00\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/index.js\":\"770f49d8bffccfbe\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5c4d082fd2326dd6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"21b580ca618dd238\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/mergeRetargetProcessor.js\":\"80aae9c82103f34e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/parseFence.js\":\"b5b035ffc2be9598\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referenceParser.js\":\"1530d31bc28e95c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referenceProjection.js\":\"02af6948c1fdfc83\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referencesProcessor.js\":\"24a00336728f0d55\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/renameProcessor.js\":\"1cda114bb129b889\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/spanReplacement.js\":\"11cc2c7c7e8e333b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/htmlToOutline.js\":\"5fd92b58f17de64d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/index.js\":\"1bc2704d826ca1e9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/normalizeClipboardDom.js\":\"01001e108b57e7c1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/pasteDecision.js\":\"b920d9edee17665d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/action.js\":\"b9a5ebedaf7f5848\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/blockIds.js\":\"b120142cc2f4b7c7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/content.js\":\"0b24bbb4ce64efd1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/effect.js\":\"bf07dc374cd98518\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/ids.js\":\"372a41aee35a4531\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/import.js\":\"a571abfd95c363a5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/index.js\":\"a5f71aa5061711a2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/plan.js\":\"d9c7aa0b88948201\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/plugin.js\":\"23e76cd0780f3c44\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/promotion.js\":\"6459adfa92fc870a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/properties.js\":\"48ae764b88e86ed6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/references.js\":\"b98685668b4eac40\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/report.js\":\"c371469147b0f3f7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/roamMemo.js\":\"98f4dd140e399f4b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/runtime.js\":\"bc45d0cfc579dbc9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/schemaReconciliation.js\":\"f7f69e99744ba75b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/srsMarkers.js\":\"c65e5587177edbb1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/todo.js\":\"88242379d0787291\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/typeCandidates.js\":\"d0dca9dcbed999b9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/types.js\":\"964c549f89b1f586\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/search-health/index.js\":\"46fcda2fc45ea876\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/search-health/store.js\":\"a4501e50ab35832d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/HeaderItem.js\":\"8b314c0ff265e6ad\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"35dc41d52eddd2b9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/index.js\":\"8ab05ba35957221f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/model.js\":\"73273805124d097a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/toggleStore.js\":\"c27e39400d646af5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/useKeyInspector.js\":\"0a363cb34b91041a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0a6b7eb8e6b3bece\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/ShellDecorator.js\":\"cde508abaa183ae3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/actions.js\":\"68153143f2ba599e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/exclusionsFacet.js\":\"09059f78da39dbd9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/index.js\":\"dfe302fc7c04f7f0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/shell.js\":\"578df69789fb2408\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/surface.js\":\"e9485f7372e98392\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/walker.js\":\"a858e64e73bb046d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/RescheduleToast.js\":\"23d208383f029cc2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/dataExtension.js\":\"273e8e4ab4c75791\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/index.js\":\"5bebfa06a9c0b2df\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/indicator.js\":\"f0e6203ed92858e8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/moveSrsState.js\":\"312dd8db9b87b0f9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"eb049b7fdba97846\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/scheduler.js\":\"af2959a40aa8f5d4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/schema.js\":\"fd0db878fa952db4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"220abd29a1034aec\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/srsClipboard.js\":\"62f08312c4f641f0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"3fb0d433cb55ec91\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/DailyNoteReviewHint.js\":\"779a6ae90f3e7cb4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/DeckPicker.js\":\"53c932b26ed06fce\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewControls.js\":\"8bf99b7b22bb3538\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewDeckRenderer.js\":\"bdd1793ae07899be\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewSession.js\":\"fba5899b4692e1a8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/actions.js\":\"72b8b963508016c8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/archive.js\":\"d3d757957df33c89\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/dataExtension.js\":\"e817696dab27aa2e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/deck.js\":\"5df3ddfd095ba8cc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/dueQuery.js\":\"d739aee048fd4b8f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/gradeDecision.js\":\"6eb996ecf5483e37\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/index.js\":\"1ab065b411994d0b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/keyHints.js\":\"996aec23f94c959f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/reviewCardLayout.js\":\"553f61dd89fd4d8b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/reviewProgress.js\":\"665306a60fc24059\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/schema.js\":\"a2b9a5f9c430989d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/useDueCards.js\":\"2f52373553265523\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/startup-metrics/index.js\":\"2fa98176ed854f05\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/startup-metrics/record.js\":\"8c1b4bcc976494f9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/index.js\":\"9fb024ada052e24e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/persistenceStatus.js\":\"54875e27436ebc32\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/requestAction.js\":\"4e1b5c49058de2d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/TypeChipsDecorator.js\":\"e050efe8f37780b2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/codeMirrorExtensions.js\":\"fcf414a4c399dc8b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/index.js\":\"d618b6efbe86f134\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/typeAutocomplete.js\":\"901753753c1a25ea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8da19a7208ad9121\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/actions.js\":\"479378766a3ffe3f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/anchor.js\":\"004f15dced3f75e3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/events.js\":\"bfaf7f385aca84e9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/gestureActions.js\":\"ec1e09d4736ac6c1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/index.js\":\"c11dedcde55bf83a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"325eb3056038a1dc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/collect.js\":\"e389077a3824b87e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/index.js\":\"202c1dc3178eadf2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/record.js\":\"85e653cefaf7af16\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/RejectionDialog.js\":\"ff4e02468fde6683\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/SystemStatusHeaderItem.js\":\"354fa24dfd038f56\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/index.js\":\"baaaddc94b22775c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/model.js\":\"3477546a81a23356\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/queueCounts.js\":\"72420bf751566a8b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/rejectedHelpers.js\":\"3cc8bf3b110faa45\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/rematerializeAction.js\":\"c1f8fd1219dcb528\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/useHysteresis.js\":\"f1626cf514c8a05c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/ColumnHeaders.js\":\"db851629bea7b027\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/QueryUi.js\":\"04750695b2f022c0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/TableLayout.js\":\"dc58b9763b31fc75\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/actions.js\":\"bfc94b9d6b75bcf2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/cellEdits.js\":\"f1ad7ef4f6d9980e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/columns.js\":\"f80503785a895581\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/controller.js\":\"a61c329a31ac798f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/convert.js\":\"cba53fd18b17dcd5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/dataExtension.js\":\"fe92a99501f35410\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/index.js\":\"7d3ea162236162c4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/keys.js\":\"807fa163f1c43827\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/model.js\":\"a95009e1d25c2dbd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/navigation.js\":\"55d24cdb7292aa0c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/backfill.js\":\"aca683af57702d58\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/format.js\":\"dcc371b20d58f057\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/parse.js\":\"d0df0b53464985a5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/queryValue.js\":\"e91e2c2142ebf28f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/source.js\":\"8b6530c26c2c88da\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/registry.js\":\"1fcc94c7ab44a5ee\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/schema.js\":\"4020d4bbb5d28328\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/sort.js\":\"e1367fe0000cf10e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/effect.js\":\"9e457b64ea42ecb0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/index.js\":\"35557b495cd111e2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/theme.js\":\"64f7a7dc1bb52102\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/actions.js\":\"914236c82e960893\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/dataExtension.js\":\"daf5bad802ade861\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/index.js\":\"eddceb9dc6f85639\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/schema.js\":\"8487fbb0d5b33fe0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/TouchSelectionLayer.js\":\"2f47696cbb43b3a9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/actions.js\":\"fe1021bcf484f564\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/defaultItems.js\":\"948d7ca5ce8346a2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/facet.js\":\"a0faa342763d5e60\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/holdRecognizer.js\":\"1dbab0f2c287fdbb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/index.js\":\"90ccee8be4630a5a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/UpdateIndicator.js\":\"cb8a5a302d6a9d79\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/index.js\":\"1f2216be9c19bae9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/loadTimes.js\":\"773e6a310a7070a9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoNotesRenderer.js\":\"4cfa0d21111e00c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoPlayerRenderer.js\":\"9ebeb1056d562630\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoTimeStamp.js\":\"69f83e82a5499cab\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/actions.js\":\"7f8c0852169b5698\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/index.js\":\"3daf6656f037f5f9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/markdown.js\":\"a588387dcc625509\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/notes.js\":\"23a06e4901f96c45\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/registry.js\":\"995df98ae074ba24\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/remark-timestamps.js\":\"065a0b991b736104\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/view.js\":\"e16a960585cfa34d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/LinkHints.js\":\"c0cf46c8ab5ec019\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/index.js\":\"8fc50b889525a4ce\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/model.js\":\"d2c5eb9367bcc0d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/settings.js\":\"863cec1c75d7a800\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/actions.js\":\"5a78098a6fc979a6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/index.js\":\"5baef89956394005\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/interactions.js\":\"1e9381b9019ebbc4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/workspace-header/index.js\":\"f5287ac5de7aeb02\",\"/knowledge-medium/pr-preview/pr-1846/src/registerServiceWorker.js\":\"f5e52a0ac6b1ff83\",\"/knowledge-medium/pr-preview/pr-1846/src/requestPersistentStorage.js\":\"fe3283386dabad20\",\"/knowledge-medium/pr-preview/pr-1846/src/services/authRequestDeadline.js\":\"e82e8ddb7f508bcc\",\"/knowledge-medium/pr-preview/pr-1846/src/services/authStorage.js\":\"2e2445feb44a62ba\",\"/knowledge-medium/pr-preview/pr-1846/src/services/powersync.js\":\"64d26b9693c8d41d\",\"/knowledge-medium/pr-preview/pr-1846/src/services/supabase.js\":\"d766985eceb745e0\",\"/knowledge-medium/pr-preview/pr-1846/src/services/uploadErrorClassifier.js\":\"a73102327a208adc\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/ActiveContexts.js\":\"0aebb9d7869e5930\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/HotkeyReconciler.js\":\"67837178c1dd283d\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/WipeLocalDataDialog.js\":\"817bb9194ae09c84\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/actionDispatch.js\":\"80befb4d9d27e73d\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/actionRefItems.js\":\"8b76f9ed32da7e27\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/applyKeybindingOverrides.js\":\"b5fcffcf935e64c9\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/blockActions.js\":\"c31c63f375947d6f\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/canonicalizeChord.js\":\"25554b5f39f4022e\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/defaultContexts.js\":\"0aacf500c98bb61d\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/defaultShortcuts.js\":\"a0d21e5e89c7372c\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/effectiveActions.js\":\"01e7a5e44d7305c4\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/gestureAction.js\":\"a976e946709fc54d\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/gestureBinding.js\":\"f5f950a1829fba34\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/holdRegistry.js\":\"5ceb931c5404cb4f\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/keybindingConflicts.js\":\"ddf5afa977cae63b\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/keybindingOverrides.js\":\"a5f3abc4ab929b5e\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/pointerAction.js\":\"d22ae3cd4a887d2e\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/resolve.js\":\"d1a3fc4fe25bc0b0\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/runAction.js\":\"4bd8c4688bcf90ec\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/sequenceMatcher.js\":\"7a5269727ab29022\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/types.js\":\"755668f572eadfaf\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/useActionContext.js\":\"8e1d7d5e628b8170\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/useActionDiscovery.js\":\"b12afc97bd34459a\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/utils.js\":\"797985e1f41b4482\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/bootStore.js\":\"d68faef9f1d06ee3\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/previewDatabases.js\":\"a4b1826989c370ad\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/byteTransform.js\":\"c7415f6102c3e1b0\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/attachmentCleaner.js\":\"42c93dd97a6ef41e\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/attachmentParts.js\":\"55ebd21a3fd7978a\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/bundleParts.js\":\"963f8a2f333b6891\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/bundleRecord.js\":\"176e0e60b18e67ac\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/manifest.js\":\"a0c74c2abc2fcfa0\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/takeBundle.js\":\"90eb05b45b62f3df\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/verifyBundle.js\":\"9a8ca1ef466f463d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/cleaningStage.js\":\"6d33cf1461c7fedf\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionKey.js\":\"b1ce6826bfe4e3ae\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionServer.js\":\"41b747e3466fe345\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/flip.js\":\"84901d039e633b0c\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/flipAttempts.js\":\"c57982224d4112af\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/pages.js\":\"d047fe74e056bee7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/preflight.js\":\"2839ca1807060680\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/reseal.js\":\"251bf639a4394456\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/runConversion.js\":\"8de01e87298c7b08\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/runLock.js\":\"325fca35194928d7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/sealing.js\":\"4bea1a65cd459a53\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/sealingStage.js\":\"1e47374a7bc29a5e\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/stage.js\":\"ae114dc40091f453\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/verifyReseal.js\":\"f7a15f60c0872ca7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/aad.js\":\"5a0a08115d8441e5\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/aead.js\":\"e2ed41543b7612ba\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/base32.js\":\"d1995b9ea8676c64\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/base64url.js\":\"9d757161c312608d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/binaryEnvelope.js\":\"433259eac9494125\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/byteAead.js\":\"a5670f83c632e8d8\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/canary.js\":\"d40e6aa9bffe75e5\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/contentHash.js\":\"f055e18cd36b0279\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/contentKey.js\":\"265eec6a76f20243\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/derivedIdNamespace.js\":\"4acbabbf20323fea\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/envelope.js\":\"4e217ee4dfd4923f\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/hex.js\":\"c1ef6fe92ddd95e1\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/sha256Hex.js\":\"9ccf646af90fb518\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/workspaceKey.js\":\"530986fef8435f46\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/conversionState.js\":\"20a02d1bbf5df3fb\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/createEncryptedWorkspace.js\":\"1cf3d83865d73a68\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/pastedKey.js\":\"58f43bd7fcf357b6\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"34eb41946704c0ba\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/upgradeWorkspacePin.js\":\"aac962cb71aa1f5a\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/keyStore.js\":\"59809453f9192b83\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/mintWorkspaceKey.js\":\"8c2a21ffcf098ba7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/modePin.js\":\"17a87ff26a0c7fa2\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/openWorkspaceKeys.js\":\"9937b8b49d12db38\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/resolveWorkspaceEntry.js\":\"f5cef9903ae5fce8\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/resolver.js\":\"b48f761eeb9e8f10\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/workspaceAccess.js\":\"f684a4ef02c098a6\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/transform.js\":\"ea03052e5929ff82\",\"/knowledge-medium/pr-preview/pr-1846/src/themeBootDefaults.js\":\"6524fc85f7866dd5\",\"/knowledge-medium/pr-preview/pr-1846/src/types.js\":\"e9d983f0b6e15b3a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/ClientLocalSettings.js\":\"4b9dba955b2b2936\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/abortableSleep.js\":\"12ebaadb759b00b6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/array.js\":\"7cacf750ebc98da5\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/backlinkAutocomplete.js\":\"781fc0d0e15f135b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/blockCrumbs.js\":\"b8436187d682cbcd\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/blockrefAutocomplete.js\":\"cc62ee444c49bc0d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/cadencedIdleJob.js\":\"4ba4d214684b80fa\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/callbackSet.js\":\"768f2d78f5f32f7b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/clientId.js\":\"b636ac10fb557f0c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/codemirror.js\":\"172615478bd323db\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/codemirrorCompletion.js\":\"3cf604437fa9d042\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/copy.js\":\"a5d36e28d28eb4a7\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dailyPage.js\":\"17afed928c9b4cf4\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dbForensics.js\":\"f7d13ce40f0945cd\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dbForensicsHooks.js\":\"eb040c014cf3e029\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/deleteBlockThroughUi.js\":\"ab5c0050bf1ecc99\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dialogs.js\":\"4d5179023444e053\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dom.js\":\"f49ed25b3613180c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/downloadBlob.js\":\"51dabc570fec8f99\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/exportSqliteDb.js\":\"5d3ebe6da8c764e1\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fileSystemAccess.js\":\"b171d19307a98bdf\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/flipSlide.js\":\"c76e4f43a44035f6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fnv1a.js\":\"5dda31b91762dff7\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/formatBytes.js\":\"196695bef0ca2be0\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fuzzyRank.js\":\"012133e72fd03995\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/idbKeyedStore.js\":\"66bb4ce59aa4906e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/idleCallbackPolyfill.js\":\"05dd199aae6c8866\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/keyboardAwareScroll.js\":\"9da781266207ab93\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/keyboardViewport.js\":\"1eae51e6de4902e8\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/lastWorkspace.js\":\"9f872b5e6ceaeb2c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutColumns.js\":\"e38d2b32e3f001be\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutSessionDom.js\":\"4c9411f4b80cd1c3\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutSessionId.js\":\"9bc5617e07fb4d1b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/linkClickGestures.js\":\"3ef18a3a1b63e0ff\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/linkTargetAutocomplete.js\":\"0d9c904681ca9d48\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/localDbCorruption.js\":\"e181859fa12880f6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/localDbRecovery.js\":\"5273b759502eb755\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/markdownParser.js\":\"b95b043a09b27980\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/memoize.js\":\"cba63b6f9fe608a1\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/nameFieldCommit.js\":\"d82205db3ace7be3\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/nameList.js\":\"c20fa967ad9a1e8a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/navigation.js\":\"f69dbabdefc0fd07\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/omnilinerNamespace.js\":\"a3ffa8b71c7b9404\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/opfsPageScan.js\":\"331823597f97a00f\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelClearance.js\":\"d8ea4f92fb56b5d0\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelHistory.js\":\"914e2ddb354556b1\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelLanes.js\":\"cd0db5d80db30ade\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelLayoutProjection.js\":\"0c12ab3ecba11f04\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelScrollAnchor.js\":\"5fc70b8619b15f93\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelUrlFlags.js\":\"53514ffe70be5b16\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/platform.js\":\"8864b09fdce99d28\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/pluralize.js\":\"41f6c757074eff16\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyCreation.js\":\"b0d27eaba8aa20a8\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyNavigation.js\":\"64134353802ac968\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyValueContext.js\":\"512687cacb912281\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/react.js\":\"12a83c29de2022a4\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/relativeDate.js\":\"1321d5fa34a47322\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/relativeTime.js\":\"2043d0a5956be39a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/renderScope.js\":\"14b79ef90aee56e6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/resolvedThenable.js\":\"b064f618662960c4\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/routing.js\":\"3da8388da7dccdd5\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/safeMode.js\":\"44f9fd6228ae8abf\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/scheduleIdle.js\":\"221b4c1ac33dece2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/screenWakeLock.js\":\"957ab764119c722c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/selection.js\":\"96947609b3d19a0a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/softKeyboardGrab.js\":\"b5384925994b12b8\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/startupTimeline.js\":\"207c1f13d5e8dd4f\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/state.js\":\"6e7288cea87fe339\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/string.js\":\"39f77f304b412c04\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/surfaceZoom.js\":\"985a2b4234384dad\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/time.js\":\"a15a3e7402e874b0\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/toast.js\":\"9d4f4a1e98f6b9d1\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/toggleStore.js\":\"3cd9764e46cdfd1a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/untilStopped.js\":\"e2a57726c7a2a280\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/userActivity.js\":\"4ad91b8e7c3d585d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/viewTransition.js\":\"6592c09fbdddb167\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/viewport.js\":\"8a8ed872ba75986e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/webLock.js\":\"a3871261dee30d7b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/workspaceRecovery.js\":\"4d160701abf13fff\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/workspaceSnapshotStore.js\":\"059b1908bc482292\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-compiler-runtime.js\":\"5246abcd66c78e75\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-client.js\":\"4964a7e5a5b50505\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-server-edge.js\":\"9cb473fc83c99668\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-server.js\":\"f85562c978b0dee2\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-static-edge.js\":\"96baa8203a914aef\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-static.js\":\"1199fb184166d4a8\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-test-utils.js\":\"319dac7d62b25f66\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom.js\":\"5587db9322d6e904\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-jsx-runtime.js\":\"d5dd3575f003d01f\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react.js\":\"6f625e70570803d1\",\"/knowledge-medium/pr-preview/pr-1846/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1846/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1846/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
