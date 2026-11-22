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
		buildId: "7c7caa387762-0e7ef36a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/\":\"8aa664b42c8b4ff1\",\"/knowledge-medium/pr-preview/pr-1846/index.html\":\"8aa664b42c8b4ff1\",\"/knowledge-medium/pr-preview/pr-1846/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1846/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1846/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1846/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1846/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1846/assets/FacadeVFS-Cuc_pJ5k.js\":\"9b192afb14c04bba\",\"/knowledge-medium/pr-preview/pr-1846/assets/OPFSCoopSyncVFS-B4s0e9Xx.js\":\"16ef4e94724a0461\",\"/knowledge-medium/pr-preview/pr-1846/assets/OPFSWriteAheadVFS-DmiwJfWP.js\":\"0f362a1d1371b520\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-Bf_q2CX1.js\":\"8a1046760280d7e4\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1846/assets/wa-sqlite-async-DyzoZ0I4.js\":\"520896e328a0766f\",\"/knowledge-medium/pr-preview/pr-1846/assets/worker-CtYXZDNX.js\":\"a836ca8165647d4b\",\"/knowledge-medium/pr-preview/pr-1846/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1846/chunks/app-C3XWOd6H.js\":\"2920ad6d9921ee72\",\"/knowledge-medium/pr-preview/pr-1846/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1846/index.js\":\"2941ca21651fd468\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1846/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1846/assets/AccessHandlePoolVFS-Dsmo1HS6.js\":\"7cb7b7d6c2b2b1fe\",\"/knowledge-medium/pr-preview/pr-1846/assets/IDBBatchAtomicVFS-C7-vPcxJ.js\":\"dff84084e46a9d34\",\"/knowledge-medium/pr-preview/pr-1846/assets/MemoryVFS-DLPl70D3.js\":\"36f3bb41d37c48b0\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-BlcjHb6I.js\":\"a0d7affd462ddaa0\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-async-DblfZHmo.js\":\"939f1951d472d7c6\",\"/knowledge-medium/pr-preview/pr-1846/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1846/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1846/chunks/AccessHandlePoolVFS-BrCct3QD.js\":\"5eb82f03d3a05668\",\"/knowledge-medium/pr-preview/pr-1846/chunks/FacadeVFS-Bs_FBhjO.js\":\"82c168adef452598\",\"/knowledge-medium/pr-preview/pr-1846/chunks/IDBBatchAtomicVFS-C_2P0hI8.js\":\"57f007eda89abe3f\",\"/knowledge-medium/pr-preview/pr-1846/chunks/MemoryVFS-05BlEBSC.js\":\"8728617d3dd0627d\",\"/knowledge-medium/pr-preview/pr-1846/chunks/OPFSCoopSyncVFS-BkwBnSRT.js\":\"a78d34c6482c3f7a\",\"/knowledge-medium/pr-preview/pr-1846/chunks/OPFSWriteAheadVFS-_y-cFJhS.js\":\"7d667fb1b2518d64\",\"/knowledge-medium/pr-preview/pr-1846/chunks/Preview-BKeyvAE5.js\":\"a5950d9c35e70a59\",\"/knowledge-medium/pr-preview/pr-1846/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1846/chunks/card-CZ-Ci_CE.js\":\"66a00ad93a44b56a\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1846/chunks/dist-CAcZ_qUw.js\":\"a6ce0c59688b1560\",\"/knowledge-medium/pr-preview/pr-1846/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1846/chunks/mc-wa-sqlite-BBDmmTOX.js\":\"1cbd2b9a5c82007f\",\"/knowledge-medium/pr-preview/pr-1846/chunks/mc-wa-sqlite-async-BAb8TCGe.js\":\"9f1520728616cb99\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-BLgMBZtp.js\":\"54294ddf9d8b09a3\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-BuARzbw0.js\":\"c6e93a310f8277e2\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-CCUCT1oB.js\":\"0a1b5d0345608e4e\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-CbwMCgRe.js\":\"2d25b95978fe7a23\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-DCG1jJMI.js\":\"83ba5638518dee95\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-DlXt6NIq.js\":\"6c75694e52dd720e\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-G0NcDzdv.js\":\"12005a1abf57decc\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server-legacy.browser.production-DAwn9mQ7.js\":\"3a984b2f3e44c5f0\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server.browser.production-HGvG8d9m.js\":\"558965af04ad6b68\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-dom-server.edge.production-Dn0K0H-g.js\":\"d3c59e8bd015f0cd\",\"/knowledge-medium/pr-preview/pr-1846/chunks/react-kYkc5ovX.js\":\"d6b3e53996faddb7\",\"/knowledge-medium/pr-preview/pr-1846/chunks/server.browser-DP7WI_l9.js\":\"f92764d28b1ea54e\",\"/knowledge-medium/pr-preview/pr-1846/chunks/textarea-BP4Xl1ev.js\":\"5745cf6fd5a8d836\",\"/knowledge-medium/pr-preview/pr-1846/chunks/ui-DfapiJ99.js\":\"4d5a57671ba29c10\",\"/knowledge-medium/pr-preview/pr-1846/chunks/wa-sqlite-DRxP6gag.js\":\"c04e8508e75ead41\",\"/knowledge-medium/pr-preview/pr-1846/chunks/wa-sqlite-async-Cu4l9yQT.js\":\"2ed8c37398349730\",\"/knowledge-medium/pr-preview/pr-1846/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1846/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1846/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1846/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1846/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1846/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1846/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1846/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1846/src/App.js\":\"6593a434b89ce5e5\",\"/knowledge-medium/pr-preview/pr-1846/src/appUpdate.js\":\"3a540a6faa580576\",\"/knowledge-medium/pr-preview/pr-1846/src/appVersion.js\":\"68659bdff511a044\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/initialLayout.js\":\"0678bc5b71881f6b\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/openWorkspaceData.js\":\"b622948d0800a9f7\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/resolveWorkspace.js\":\"03707bca90f21695\",\"/knowledge-medium/pr-preview/pr-1846/src/bootstrap/workspaceBootstrap.js\":\"a9117678aa0485b3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockComponent.js\":\"46a24611d878cda9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockCrumbs.js\":\"8f91e19e741a84ef\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockEditor.js\":\"336660d7ec471dfa\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockLoadingPlaceholder.js\":\"4c99fe479ddc172e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockProperties.js\":\"6c73652f641d942a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/BlockSearchPicker.js\":\"48ff56dd5f6dcac8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ConfirmBulkDeleteDialog.js\":\"96f757b27c3ca2ac\",\"/knowledge-medium/pr-preview/pr-1846/src/components/DividerHandle.js\":\"0b36024e18f1230e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/DraftEditor.js\":\"a68c4ee909e6f3cb\",\"/knowledge-medium/pr-preview/pr-1846/src/components/GutterPill.js\":\"e54cba94f59d7e7d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/Header.js\":\"6e3c71d4374c9d69\",\"/knowledge-medium/pr-preview/pr-1846/src/components/LazyBlockComponent.js\":\"3f0110d48929a62c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/Login.js\":\"f781071cfaa31074\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ZoomableSurface.js\":\"4750806c99012d81\",\"/knowledge-medium/pr-preview/pr-1846/src/components/editModeKeepalive.js\":\"17d235a7c3d9c9f2\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyDisplay/PropertyDisplayScope.js\":\"083db23917b84b70\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8922fd4780692050\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/RefPropertyEditor.js\":\"0604e59ac30c05f6\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/RefTargetTypePicker.js\":\"0c597630f3bdca3e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/SelectPropertyEditor.js\":\"e4f887e51646a874\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/TypesPropertyEditor.js\":\"ad96147808121f32\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/defaults.js\":\"2461140f99507dd4\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/kernelValuePresets.js\":\"f65daa80c8156d0e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/selectablePresets.js\":\"4d23fff1faa2528a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyEditors/typesPropertyUi.js\":\"746fffcacc4e2c28\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/AddPropertyForm.js\":\"9a1754ebf3f9e6db\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/PropertyPicker.js\":\"44fd6f11b2f5f33c\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/PropertyRow.js\":\"91843c1151ce0385\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/Rows.js\":\"d089d2337e2c6457\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/actions.js\":\"ef2322de84497bed\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/declarationOnly.js\":\"0fd1c2a79c42c076\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/layout.js\":\"445a2b7ba59f1cb9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/model.js\":\"e9223881e2095b58\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/shapeUi.js\":\"8527f456e524e7a2\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/shapes.js\":\"87ad8c24e47cfdba\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/usePropertyEditingActivation.js\":\"8d4365f488912d06\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanel/visibility.js\":\"a8136fceda81de22\",\"/knowledge-medium/pr-preview/pr-1846/src/components/propertyPanelSections.js\":\"93aa9d8870e6e8ea\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockEmbed.js\":\"2ad313e469398600\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockLink.js\":\"46a813568f6607fa\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/BlockRef.js\":\"8125c2028b83bd95\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/ReferenceLink.js\":\"73a01e61673a4a48\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/cycleGuard.js\":\"70c09c924bb6e4ba\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/cycleGuardContext.js\":\"09ad64400be50a79\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/linkInteraction.js\":\"609956cd2a499515\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/referenceLayout.js\":\"792f5dda07e9c3fc\",\"/knowledge-medium/pr-preview/pr-1846/src/components/references/useBlockRefAncestors.js\":\"a08f43719e4967d4\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockGutter.js\":\"116af0992b1d9fd8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockInfoDialog.js\":\"536b44abf93ed0e7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BlockTypeBlockRenderer.js\":\"6807856d519aad40\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/BulletHoverCard.js\":\"2216b0d87750eba7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/CodeMirrorContentRenderer.js\":\"22fb298c1eca4c81\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0c71d63caa569a95\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/ColumnResizeHandles.js\":\"f8775e3bfcaaeae0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5bd909e5d22fc8c1\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/DefaultBlockRenderer.js\":\"4a270b1967f20a78\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/LayoutRenderer.js\":\"b7e3c417d98dc434\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/MarkdownContentRenderer.js\":\"845f886f1618405d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/MissingDataRenderer.js\":\"7dd5000e3250acb8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/PanelRenderer.js\":\"ad7fbd085a623f87\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/PropertySchemaBlockRenderer.js\":\"951726ffdd1a3415\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/TopLevelRenderer.js\":\"4c215003ea2189cd\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/blockGutterMode.js\":\"fb44697157ff8829\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/blockTitleText.js\":\"6ea9d9a044f8875a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/fieldCreationKeydown.js\":\"640e303b7685f982\",\"/knowledge-medium/pr-preview/pr-1846/src/components/renderer/layoutRootContext.js\":\"6a4dcfcf5ad4a403\",\"/knowledge-medium/pr-preview/pr-1846/src/components/typeChip/TypeChip.js\":\"997f1a782fd136f3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/typeChip/chipStyle.js\":\"9c312663a7f1ed55\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/anchored-floating.js\":\"ef433e3022fba2e9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/button.js\":\"7b252328889499d8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/card.js\":\"09f1c08b77429e18\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/checkbox.js\":\"541f3ac263847462\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/collapsible.js\":\"9d65311807eabac1\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/command.js\":\"1aa94cb40436219d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/context-menu.js\":\"46ee00ed0943ca2e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/dialog.js\":\"4034994fe6495a12\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/dropdown-menu.js\":\"e87698cb383dcd36\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/floating-listbox.js\":\"9b85610ca3893e54\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/index.js\":\"8654a178479d5b45\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/input.js\":\"7bbca624398621f3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/kbd.js\":\"f37626df25cfe6bd\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/label.js\":\"382b713043def456\",\"/knowledge-medium/pr-preview/pr-1846/src/components/ui/textarea.js\":\"c437dc8ded0a4886\",\"/knowledge-medium/pr-preview/pr-1846/src/components/useEditModeYieldKeepalive.js\":\"b5b13eef3af84ff7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/BootFallback.js\":\"3f6a8e3048c5a7d7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/FocusedRowLazyMount.js\":\"c2902fb33ffecd09\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/LazyViewportMount.js\":\"910a1858977e542d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/LocalDbCorruptionFallback.js\":\"1c3eb0bee5446cb9\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/error.js\":\"cfd679384fd1c5c0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/lazyMountRegistry.js\":\"fe8b0c5ff5417e3d\",\"/knowledge-medium/pr-preview/pr-1846/src/components/util/suspense.js\":\"efb9712ab4905521\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/CreateWorkspaceDialog.js\":\"f671f4528eb1ffa8\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/PendingInvitations.js\":\"47b34b69bb2ca217\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/SyncProgress.js\":\"b93d71f65e5fd093\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/UnlockProgress.js\":\"4e6227265bfcbaa5\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceKeyGate.js\":\"6db0bbf5d3a9dcbe\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSettingsDialog.js\":\"c9497d0b910eacfe\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSwitcher.js\":\"c88b7c4eca91690b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/WorkspaceSyncGate.js\":\"adc1feb10f7cf4c7\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/ConversionFlow.js\":\"97c5bacc4959ec04\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/ConversionFlowHost.js\":\"38423235814b57c0\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/EncryptionSection.js\":\"1cb97a483ed3ec1e\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/attachmentPrompts.js\":\"81cf212e1d36c343\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4cdbcbc728fcf178\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/conversionFlowDeps.js\":\"6bae32a66c150a8b\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/conversionFlowStore.js\":\"86a890ebbda2d213\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/flowUi.js\":\"c0c1bfa42f1aead4\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/conversion/useConversionRun.js\":\"50ccb072932a4fd3\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/keyUi.js\":\"d55b144a4cc7062a\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/useCloseOnKeyLoss.js\":\"12e402bd8f0e4472\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/useCloseOnServerE2ee.js\":\"4468b21fbcf556aa\",\"/knowledge-medium/pr-preview/pr-1846/src/components/workspace/workspaceUnlocked.js\":\"fdc604fe28f45bf3\",\"/knowledge-medium/pr-preview/pr-1846/src/context/backgroundSubtree.js\":\"03634b6ed36203df\",\"/knowledge-medium/pr-preview/pr-1846/src/context/block.js\":\"69b1e179adf9272d\",\"/knowledge-medium/pr-preview/pr-1846/src/context/layoutWsContext.js\":\"8da7f5af181109cc\",\"/knowledge-medium/pr-preview/pr-1846/src/context/propertyDisplay.js\":\"e00c491b670af49d\",\"/knowledge-medium/pr-preview/pr-1846/src/context/repo.js\":\"15b0c8814471b4d0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/aliasClaim.js\":\"2d13011705682bc0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/aliasSeatNamespace.js\":\"dd31eee7bbd9ee85\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/blockData.js\":\"27db314dfdc22414\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/blockType.js\":\"fedfbf9bd79a06b9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/changeScope.js\":\"07636be27e1c82ed\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/codecs.js\":\"7eeab52ab224d81a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/derivedData.js\":\"82829be83a30fe11\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/errors.js\":\"4b615b5cd0e80f7f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/events.js\":\"8eac034082eef4d6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/handle.js\":\"1dd88c60baeec964\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/index.js\":\"06b9b75c9662600f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/mutator.js\":\"9c22a2f8a02acd54\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/processor.js\":\"f1d8e61fd000c17a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/propertySchema.js\":\"23ea0fc1590ab162\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/query.js\":\"08f8f6932db96a53\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/sameTxProcessor.js\":\"798d955059c16769\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/schema.js\":\"1dd88c60baeec964\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/tx.js\":\"1dd88c60baeec964\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/typedBlockQuery.js\":\"69f0beeeb897e3c3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/user.js\":\"1a47ca7a98f962d2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/valuePresetCore.js\":\"7a6febbde5a5c1dc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/api/valuePresets.js\":\"2d11d6323111a064\",\"/knowledge-medium/pr-preview/pr-1846/src/data/attachmentCleanerIOVerb.js\":\"a86dc0c5e79d888e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/block.js\":\"dfd245fc27982735\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockCache.js\":\"dcff9594c2585be4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockId.js\":\"30a85a0a2cc37da4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockLiveness.js\":\"d8ec5fdd3cd8057a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockMerge.js\":\"c14837faa153d5df\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockSchema.js\":\"054a2d4c51bfe90c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockTypeLookup.js\":\"c0450f4cc8e29a38\",\"/knowledge-medium/pr-preview/pr-1846/src/data/blockTypes.js\":\"e0dd9173a398e0c9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/clientContext.js\":\"ae0c2f50a157f7fa\",\"/knowledge-medium/pr-preview/pr-1846/src/data/dbFileSiblings.js\":\"4a5623c5b1a5e09c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/definitionSeeds.js\":\"e66cd117c7fabf08\",\"/knowledge-medium/pr-preview/pr-1846/src/data/derivedIds.js\":\"2293f310d579e70e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/drawnSubtree.js\":\"d9ff8b44ed52cfba\",\"/knowledge-medium/pr-preview/pr-1846/src/data/facetBridge.js\":\"187e505aa11e44cd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/facets.js\":\"d4eca9d32bdd02b6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/globalState.js\":\"88a125cce10cfadb\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/aliasClaimRederiveProcessor.js\":\"c51e1da32b9b8eb8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/ancestorBatch.js\":\"586e1fc5025bfb03\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/blockTypeTypeifyProcessor.js\":\"b8f6f1249b207f21\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/clientSchema.js\":\"f9d91e398128bcbc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/commitPipeline.js\":\"1201eba8327f1e1f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/devAssertions.js\":\"b5a5bf07d7e7bf0b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/firstSync.js\":\"ed88399bf165c6d1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/freshInitialLoad.js\":\"366f5b708661cb15\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/graphBackfillClaim.js\":\"cdf2fab640ec07ca\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/handleStore.js\":\"1e87c25f0c4675d7\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/idleMarkerJobs.js\":\"923a2a4337500983\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/initialDownload.js\":\"c7605583dd94d0ac\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/initializeClientDatabase.js\":\"f11137f70d2e3554\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/jsonCanonical.js\":\"b59e4f16718d9431\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelInvalidation.js\":\"9026ae9602e76787\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelProcessors.js\":\"dfb527e945e53715\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/kernelQueries.js\":\"78969c8b3c0f4748\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/mergeTypeMembershipProcessor.js\":\"1099415dd3917e44\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/normalizeReferencesProcessor.js\":\"a6090801ea30a4b5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/poolInstrumentation.js\":\"46bcfb48cfc1ba03\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/processorRunner.js\":\"3183f00ec65bb6f3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyCellBackfill.js\":\"9bd5a456a1d53990\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyChildMint.js\":\"2b28b829131a752a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyChildrenProcessor.js\":\"330b4c7dac4e0297\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8757719cd9085b74\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyDefinitionSynthesis.js\":\"52d4c52a38100e71\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyKeyScan.js\":\"bfe1a76644f9a068\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertySchemaResolution.js\":\"e9a0a349a7088e37\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/propertyValueEdits.js\":\"7ec0b23d8f4f20d9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/raiseProtocol.js\":\"2761736cc194a630\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/readBatch.js\":\"d1ae4496e37d1d72\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/refProjection.js\":\"ed4a92dc995e77e0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/referenceTargetLookups.js\":\"fb1379a0c9b0644c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/referenceTargetProcessor.js\":\"34a31ea376399709\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/replayMerge.js\":\"5925eb0d53aaa98b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/sqlBinds.js\":\"37b3be8fc2166bb0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"28c2c987e0db1fb1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/arrivalProcessors.js\":\"6e5c20ed77108232\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/invalidate.js\":\"1f580916b9c2a47a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/materialize.js\":\"93469459722ffda6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/observer.js\":\"53b255fc7a035497\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/syncObserver/reconcile.js\":\"856f19e096f838b8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/timingMetrics.js\":\"2caaabdc42e5c7c5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/treeQueries.js\":\"9216cef400bf80e0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/txEngine.js\":\"f7dd18690d09db86\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/txSnapshots.js\":\"c4fbfaab696a302a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/typedBlockQuery.js\":\"935ea23cc13cb7cd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/internals/undoManager.js\":\"af29ccf14131b91f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/invalidation.js\":\"524eea4a9e557c94\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelDataExtension.js\":\"5bfd6e18139de313\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelPage.js\":\"64953ddeb7244b22\",\"/knowledge-medium/pr-preview/pr-1846/src/data/kernelValuePresetCores.js\":\"5283122bd5b1a69e\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbCorruptionSignal.js\":\"35cf7beaab65cc26\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbStorage.js\":\"ce71916e96118065\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localDbVfs.js\":\"cc3f743c80170af2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/localSchema.js\":\"e2216b2716f97cbd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/maintenance.js\":\"c20ca9a20072d8f4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/mergeProperties.js\":\"1f5e55bb806c0684\",\"/knowledge-medium/pr-preview/pr-1846/src/data/metricsConsoleHook.js\":\"58f8f615b77f1bd5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/migrationsPage.js\":\"031db33ba7c95977\",\"/knowledge-medium/pr-preview/pr-1846/src/data/mutators.js\":\"c0cb73b3ff56ab17\",\"/knowledge-medium/pr-preview/pr-1846/src/data/orderKey.js\":\"0233f40463fbd7e8\",\"/knowledge-medium/pr-preview/pr-1846/src/data/orderKeyPlacement.js\":\"0eb9454551c032d3\",\"/knowledge-medium/pr-preview/pr-1846/src/data/outlineSurface.js\":\"86063d453f6d28bd\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pendingEditorContent.js\":\"60d0276d7757bc2b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pendingUploadsSql.js\":\"09d6a7a65a5146bc\",\"/knowledge-medium/pr-preview/pr-1846/src/data/pluginStateExtensions.js\":\"78fb2e818c9b6add\",\"/knowledge-medium/pr-preview/pr-1846/src/data/powerSyncLogger.js\":\"1a66a6faf0158c52\",\"/knowledge-medium/pr-preview/pr-1846/src/data/projectorRuntime.js\":\"6a7a3a899848596d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/properties.js\":\"2123911c474c636b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertiesPage.js\":\"4ffbdaa94f5d96d9\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyChildren.js\":\"c1a36339d47e4ff1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionFanout.js\":\"243c52150c155b23\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionMetadata.js\":\"2527a0db34793177\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDefinitionRegistry.js\":\"53fabe421e21fa0f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyDisplayMode.js\":\"daa3d5b78fe042d1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertyRowCreation.js\":\"dcf34062e87a24d5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertySchemaCreation.js\":\"3c41ad73cce799b1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/propertySeeds.js\":\"084c659895399583\",\"/knowledge-medium/pr-preview/pr-1846/src/data/recentsPage.js\":\"cbe16d84f9104034\",\"/knowledge-medium/pr-preview/pr-1846/src/data/referenceBlock.js\":\"7acb0e68ee9505f0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/rejectedUploads.js\":\"78ebd0c5b1ad666b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/releasePowerSyncConnection.js\":\"e3fcec5fae3cfe68\",\"/knowledge-medium/pr-preview/pr-1846/src/data/repo.js\":\"f0136cd83c48f485\",\"/knowledge-medium/pr-preview/pr-1846/src/data/repoProvider.js\":\"7395c61b444b976b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/rowProperty.js\":\"63a8d1aec8de7c9d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/searchFilter.js\":\"b58e8d4f5e504520\",\"/knowledge-medium/pr-preview/pr-1846/src/data/seedIdentityLedger.js\":\"86e737b7ded30ab1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/stateBlocks.js\":\"da998b03aa9d088b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/structuralEditPolicy.js\":\"4038a6cb4a01e549\",\"/knowledge-medium/pr-preview/pr-1846/src/data/subtreeDelete.js\":\"c01dbd20fde54eab\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncStreamLock.js\":\"5bc088856a3dec35\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncedTableSqlRecognizer.js\":\"9b2f703a6fb4b475\",\"/knowledge-medium/pr-preview/pr-1846/src/data/syncedTableWriteGuard.js\":\"340db5e5520cda50\",\"/knowledge-medium/pr-preview/pr-1846/src/data/targets.js\":\"547ddceeb1d3f287\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeColors.js\":\"89ad023c8ce9d8b4\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeDefinitionMetadata.js\":\"bf0bb4e5118d29b1\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeDefinitionRegistry.js\":\"ec1f5f949ba6368b\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeExtraction.js\":\"83bd81225170f255\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeInitialValues.js\":\"489ba9ea809c626c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typePropertyGroups.js\":\"ae248b6ad6ca5b90\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeSeeds.js\":\"7665e84ff4d13e92\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typeTagger.js\":\"190bca649b580df0\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typedRecords.js\":\"1d9e350bf6eaf012\",\"/knowledge-medium/pr-preview/pr-1846/src/data/typesPage.js\":\"f2151fb30466e32d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userPrefs.js\":\"d379febbe9f45e9d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userSchemasService.js\":\"905c7fc401c73440\",\"/knowledge-medium/pr-preview/pr-1846/src/data/userTypesService.js\":\"f46399ea7d04bf69\",\"/knowledge-medium/pr-preview/pr-1846/src/data/valuePresetRegistry.js\":\"747bcbe81d3d81e6\",\"/knowledge-medium/pr-preview/pr-1846/src/data/visibleChildren.js\":\"1d69062b953efa4d\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceConversion.js\":\"370022200f9fec0f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceFirstSync.js\":\"86ca2a0903608fc2\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceIdNamespace.js\":\"00e111500444762f\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaceSchema.js\":\"cf6c96361274fbf5\",\"/knowledge-medium/pr-preview/pr-1846/src/data/workspaces.js\":\"d88d07d3f601930a\",\"/knowledge-medium/pr-preview/pr-1846/src/data/writeAheadLog.js\":\"4f636bf05f866b5c\",\"/knowledge-medium/pr-preview/pr-1846/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/BlockPasteShellDecorator.js\":\"51476b06e749ec72\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/atTrigger.js\":\"ba3b47194be3de90\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/autocomplete.js\":\"9e2d99ea2ee21fb9\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/codeMirrorExtensions.js\":\"b250e2c8fe4cbead\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/contentFlush.js\":\"7141c5451af43c31\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/defaultInteractions.js\":\"030559fbdb9f6bd9\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/editSettleSignal.js\":\"54cc5e7cc53e66fe\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/insertImage.js\":\"b6632087fd0bd06b\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/referenceCompletionRange.js\":\"174cd7e9de6d7f4c\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/referenceTargetTypes.js\":\"3fc0f539ae975583\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/syntaxContext.js\":\"490be71d01e670d3\",\"/knowledge-medium/pr-preview/pr-1846/src/editor/triggerMatch.js\":\"b18f54181a628b46\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/AppRuntimeProvider.js\":\"9e03a9f5c4519ed9\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/BlockFocusShellDecorator.js\":\"1c794a3799baa0c0\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/ExtensionRenderBoundary.js\":\"19c6e10eef4acc33\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/PanelContentRecovery.js\":\"e0ece9a68c2f1d8d\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/apiCatalog.js\":\"bdf838bb96e4cc97\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/approveExtensionHere.js\":\"ec789264557d1ed5\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/armedCutAppMount.js\":\"6976d9add912e29c\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/batchableKeyedStore.js\":\"dff56b165c235f14\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/blockInteraction.js\":\"df6f3a52d9ba4dce\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/blockSelectionAction.js\":\"df1058b4f42e1f94\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/compileExtensionModule.js\":\"5ab160112501e4d7\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/compiledModuleCache.js\":\"0d01611f50f61efd\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/continuousGestures.js\":\"dac4cc26836f1618\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/core.js\":\"ac752da5ea09f3db\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/defaultRenderers.js\":\"32e1cdb459b926cd\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/definitionFanoutAppMount.js\":\"ec9e8e5fada74cf3\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dialogAppMount.js\":\"40eb22fad0904269\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dynamicExtensionSeeds.js\":\"821ffce2fb7733ea\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/dynamicExtensions.js\":\"a28f52441d2a2f31\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/exampleExtensions.js\":\"193e3816a9dc4e03\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionApprovalStatus.js\":\"f8ba791bc1951329\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLoadErrorToast.js\":\"088348a1720534a7\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLoadErrors.js\":\"a44b47846afb8e83\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionLookup.js\":\"213b66997b1064d4\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionToggles.js\":\"cdb9ceed4f535764\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/extensionUtilitiesCss.js\":\"ca13b59cca40a23a\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/kernelPageDeletionGuard.js\":\"64dff100cc25171c\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/liveRuntime.js\":\"a0c7506c136d45c2\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/openExtensionsSettings.js\":\"e1f96043b6028a86\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/overridesCache.js\":\"52c744bd9070975b\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/pluginIds.js\":\"0261a999580f999a\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/processorRejectionToast.js\":\"bf3f29ff191ea64a\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/runtimeActions.js\":\"44e97c8a48a5b795\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/runtimeContext.js\":\"b90709998a2ffd1e\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/staticAppExtensions.js\":\"500f414ccb9a89c9\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/staticDataExtensions.js\":\"2c9c51f5cb0f2bda\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/toastAppMount.js\":\"646a7465f585340d\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/useOverrides.js\":\"51ed4d0ce84deab3\",\"/knowledge-medium/pr-preview/pr-1846/src/extensions/useShortcutSurfaceActivations.js\":\"9263daa111421cbc\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/discoverToggleTree.js\":\"6f4d8fa2dc681684\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/facet.js\":\"cad922b2fb7c127e\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/resolveAppRuntime.js\":\"c5984e8e289eecfa\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/runtimeEvents.js\":\"0fb7fd82146c7a10\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/togglable.js\":\"953982c769a07267\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/variantFacet.js\":\"6f319037f1ae1866\",\"/knowledge-medium/pr-preview/pr-1846/src/facets/verbFacet.js\":\"c9230aebdaa41dea\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/block.js\":\"02932133662df7bc\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/focusedChild.js\":\"6bfbfb16f2fb8c88\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/propertySchemas.js\":\"2bcc344327131d03\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/typeRegistry.js\":\"80c8c95407d44733\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useAncestorCrumbs.js\":\"82c8a2401736afa2\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useAutocompleteListbox.js\":\"82b22dd3fa039b96\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useDebouncedSearch.js\":\"4ed1d9e30b437895\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useDebouncedValue.js\":\"077a7e19b7ffdaed\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useIsFocalRender.js\":\"1981e19ed6afb39a\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useIsReadOnly.js\":\"9c52b3a79fbebebb\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useMaterializeBacklog.js\":\"0e66ecc9e36cad00\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useMinuteClock.js\":\"0347f198120f5bf0\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/usePanelLayoutProjection.js\":\"5334d93180abfddc\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/usePendingInvitations.js\":\"99a9159ca62e3aa7\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useRendererRegistry.js\":\"46722e12bbf570ee\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useRetainedFieldRows.js\":\"d56593ade5f9fb66\",\"/knowledge-medium/pr-preview/pr-1846/src/hooks/useWorkspaces.js\":\"298f6adabb25e57d\",\"/knowledge-medium/pr-preview/pr-1846/src/lib/utils.js\":\"53361b330b0c19fc\",\"/knowledge-medium/pr-preview/pr-1846/src/main.js\":\"01cfad779b3934d9\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/MarkdownImage.js\":\"c31f32556c7133d9\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/blockSeparators.js\":\"8949b1a4e4e931cb\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/context.js\":\"469775a813f6e476\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/defaultMarkdownExtension.js\":\"456c155fd6423429\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/extensions.js\":\"5ccceb0d4a6d342e\",\"/knowledge-medium/pr-preview/pr-1846/src/markdown/renderMarkdownHtml.js\":\"cae32953b4ce792a\",\"/knowledge-medium/pr-preview/pr-1846/src/minimal-editor.js\":\"074ff9723ef7fac5\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/armedCut.js\":\"c4de2f2b489c5119\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/captureMediaVerb.js\":\"95151c399ed734af\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/clipboard.js\":\"d67f789584240b9a\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/decision.js\":\"e148c811342ad89e\",\"/knowledge-medium/pr-preview/pr-1846/src/paste/operations.js\":\"2d974ccbbbe391f5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/account-header/AccountHeaderItem.js\":\"ddbbe53b1b6e765e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/account-header/index.js\":\"24f7bfcd1b65b4a6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9339ea60525f9118\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/askAgent.js\":\"0554790beaff62e7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/askedStore.js\":\"60ee468bc8d9c3d7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9274757beb9146d5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/chipState.js\":\"81ffcd3fe75cb9c2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/dataExtension.js\":\"324cf0ad5b40ab2a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/index.js\":\"63757e3c31eed23b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4a9852ca45a0dee1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-dispatch-companion/schema.js\":\"395004f325ba52f7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d2f134875499fa8c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/BridgePairingDialog.js\":\"911749a712470008\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/addMedia.js\":\"0d5fbeec4bb0d4f6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0481c2b57348deb8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/block.js\":\"da77addf7608de81\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/context.js\":\"71562dfe4d5269c4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f9f6e8e379a23ee9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/index.js\":\"f23b0e93581cc992\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/outline.js\":\"bcff7e93d565e644\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/properties.js\":\"cf2f70cb0ff6bec6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/refs.js\":\"d6015662607250cb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1a3bb318f974bdcc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/search.js\":\"5bea332d0fbfb821\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/shared.js\":\"fe06bf35c8f102f8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9734136e61626106\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentViews/text.js\":\"154ef8f6c4cf5c11\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/agentWrites.js\":\"2db9f2cfc728b499\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/authoringCatalog.js\":\"7bf208009a657659\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/blockRefTargets.js\":\"12c1cf92dc1a1890\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/bridge.js\":\"14c20ecf6460b0c9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/bridgeLoop.js\":\"b2b262fd67a99b88\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/changeHistory.js\":\"af00e2edfbbf3ce8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/commands.js\":\"3dd96a0a679561b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/commentsCommands.js\":\"8ab70e339f2ab6fc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/dataExtension.js\":\"b5173ce8bd75a56c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/dataModelGuide.js\":\"e825dd835924faa3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/describeRuntime.js\":\"4cf36ca9d8ce9044\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/extensionLint.js\":\"daa12ce9a648d595\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/grainAudit.js\":\"a3f904a2d4a939d0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/healthCommand.js\":\"611a396da612169f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/index.js\":\"a3c4437aadd64a96\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/presetIdentity.js\":\"5bc91705155ac2fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ca7fb2adc2fe0a62\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/readMedia.js\":\"4469bd273db2de43\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/schema.js\":\"384c3bf85ab32ab9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/serialization.js\":\"ffe481f304d7d592\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/targets.js\":\"d832efb7534435eb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/tokens.js\":\"6a541faf913b2603\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/watchEvents.js\":\"76b417c2114c206b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/workspaceGuard.js\":\"cd6876ed715e9cca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/agent-runtime/writeCommands.js\":\"5a1b17a42282bedd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/AliasCollisionToast.js\":\"b9d30e83f3dff18f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/DuplicateNameBanner.js\":\"c7e452cd26b57306\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/collisionMerge.js\":\"fbd6a86d417e7d6a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/dataExtension.js\":\"3eeb21e0b1ff8300\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/index.js\":\"9e8f7ec7afae3da9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/mergeCollisionAction.js\":\"ce48d3d027dd9f9d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/pageStyling.js\":\"8a5d1ee26503461c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/rejectionToast.js\":\"aa042f342a63174f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/alias/syncProcessor.js\":\"b63488ff81957596\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/actions.js\":\"cafc303a4ab8e699\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/addComment.js\":\"c81991be94603d5b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/anchor.js\":\"ce76436af7a92267\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/anchorState.js\":\"14183d6b216ee5c7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/commentLinks.js\":\"d35e5c31622d8f04\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/confirmThreadDeletion.js\":\"902ce7372f76e310\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/container.js\":\"a98a5767f7f9fa81\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/dataExtension.js\":\"37facac92f3fff3b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/deleteComment.js\":\"b2bbc5713034c79d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/highlights.js\":\"17d36d332fccd83f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/index.js\":\"6741f24521fb8117\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/linkedCommentsPill.js\":\"eafad1d851e7344d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/margin.js\":\"194a536ff896ee68\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/marginSchema.js\":\"9bfc6b2d58c384f7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/newComment.js\":\"14a403de7cd0122b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/ownThreadPicker.js\":\"44f6f80bf292853e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/placement.js\":\"463b4415588534fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/queries.js\":\"d38d1217be5a177e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotePosition.js\":\"4ba51833ad3dbbe1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotedIn.js\":\"2f22714483a61617\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/quotedRange.js\":\"4e43480b94dd96b7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/rangeRefs.js\":\"e3c1708d8d5b5d28\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readHighlights.js\":\"45fca0ba9922b8b3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readSelection.js\":\"58ed0998f8fb0619\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/readSelectionUi.js\":\"cb543923b62311f0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/reanchor.js\":\"ee413f0b19dc238e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/schema.js\":\"cb9e83fc207937b9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/scope.js\":\"004bd93302f762f1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/scopeThreads.js\":\"96a84f70a489fe3c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/splitRetarget.js\":\"adf66bf10d414a4a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/suggestionCard.js\":\"57bc141ed2e2a47b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/suggestions.js\":\"7c5b549fb4acee8b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/summaries.js\":\"e3b3b279d1f60835\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/summaryBatch.js\":\"1b4cbca40896df78\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/surface.js\":\"6a8f2b9b87f08a4c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/threadNavigation.js\":\"a19dba6ffd29ff7c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/threads.js\":\"51fa770ff8aa5add\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/ui.js\":\"e3141d74a9c2fcb7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/annotations/uiStore.js\":\"036e33f3b235e892\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-intents/appIntents.js\":\"21cb3819b8dd260f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-intents/index.js\":\"c75a493131e22922\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-update-prompt/index.js\":\"13d6614e5145d50e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/app-update-prompt/status.js\":\"abd6a7fdfe5de6bd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"edd8e87c5a51d83a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaBlockRenderer.js\":\"f8af84491a5dfc80\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d3080287699d84fd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/MediaUploadReconciler.js\":\"9d5349db1547aac1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetDownLane.js\":\"9489d26cd8f8dd54\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetResolver.js\":\"24faec45b19da4ed\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/assetUpload.js\":\"17283955210ac298\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/attachmentCleanerIO.js\":\"cf521d48ab65ca82\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/supabaseAuditIO.js\":\"23bf1b76ab2dd3e4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/blobStore.js\":\"ac787042c242028f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/byteStore.js\":\"7e7264af3ecc462c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/cleanerIO.js\":\"4c08254c657885e1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/cleanupAttachments.js\":\"dd39383cfb16a056\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/dataExtension.js\":\"e840f8ff65b9bde3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/downLane.js\":\"1ec85214b355a42f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/index.js\":\"4f81bfff440ef9e6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/insertImageContribution.js\":\"fbf9bbd41c625431\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/laneArming.js\":\"075bcf5b67a5dd53\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/laneLock.js\":\"261cf7b075f6f8de\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaBlock.js\":\"ba206022377f9974\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaCapture.js\":\"b482d2597d98db29\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaViewers.js\":\"4bc36a2d71dae30b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/mediaViewersFacet.js\":\"96f3a5b6d4ea0584\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/pasteCapture.js\":\"6236701531b72948\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/resolver.js\":\"f9d00dbc7b6aed8e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/retryUploadsAction.js\":\"dec1639f04f7561b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/storagePaths.js\":\"2c3c69d2cf36c1c6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadDrain.js\":\"2d17038e1901d7aa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadLaneStatus.js\":\"7a9f56c28fdfb343\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadReconcile.js\":\"f64908b1d961ffae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadRecovery.js\":\"b5a47986c3ba9a35\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/uploadStore.js\":\"15f41a1fbc6867e9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/attachments/useAssetObjectUrl.js\":\"b48c4a076ab5090e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9529c7c1b537917b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ec62861d1e3d5c9e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/facet.js\":\"ac05e7bc56f576fc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/index.js\":\"1b2184f2453b3283\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks-view/prop.js\":\"a382ad9af1719705\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BacklinkFilters.js\":\"336ec5c370980662\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"88bd67882e70d602\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/BlockEntry.js\":\"237770a5c66fd932\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/LinkedReferences.js\":\"ed918b8fbe57ec69\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2aad06223bf934a2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/dailyNoteDefaults.js\":\"08a6832d3e7c0317\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/dataExtension.js\":\"d7c5699ef092f5a6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/edgeExclusions.js\":\"a795df7d70768d5b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/filterProperty.js\":\"7b793f874fa6f625\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/index.js\":\"de31f4f8ad345bf2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7929a6ef662525aa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/applies.js\":\"46e2052759b7a258\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/countQuery.js\":\"c73ebcfedea5a81e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3e4d73f3c870520a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/index.js\":\"29ace9c7c07e8910\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b2bcbc4575c54b05\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/presentationInvalidation.js\":\"bf9b1b79d0820a9b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/propertyEditorOverride.js\":\"c8883a9318122043\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/propertyFilter.js\":\"ec1925af1db71948\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/query.js\":\"6d9c0b327fff2a45\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/resolveFilter.js\":\"44bd5d7426e5cb93\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/sourceBatch.js\":\"e581c79bad91fd59\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/sources.js\":\"a8f9877e11418bb3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/useBacklinks.js\":\"bef8fc66b4247093\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2b9ae9563bfd1c6e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/BirthdayCelebration.js\":\"1508730fac93b81e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/BirthdayOverlay.js\":\"a76defc5aa545811\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/gate.js\":\"d33db9a83eec7800\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/index.js\":\"59cda6a22ac801a2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/birthday/wolfTheme.js\":\"31593a6827ba9b7d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/BlockDragLayer.js\":\"2c611e6e5b193a45\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/dragController.js\":\"c5b43587e8f522b0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/dropTarget.js\":\"4afdea6e95ff6f16\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/index.js\":\"d747c3cb9cfcef12\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-drag/projection.js\":\"2b39d60f1b52e425\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-info/BlockMetaCard.js\":\"e58220c29b41c12d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-info/index.js\":\"26fa193dd420062d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/AddTagDialog.js\":\"2f2b2206a326265b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b9b809ce1e58b475\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/TagNameIssueHint.js\":\"0b716c81e421981a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/addTagAction.js\":\"c66941ee632bbd70\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/appendTag.js\":\"b8dad260376772c1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/config.js\":\"17db87fef9ab9f2f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/dataExtension.js\":\"0293bed3f624a2c1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/index.js\":\"bae21e5878cf791a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/block-tagging/propertyEditorOverride.js\":\"49bce3d468541735\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b10ee00990095289\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"0d2f5b8b78a78647\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/Breadcrumbs.js\":\"df8a23115b746e24\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"56d7003f8378d1f4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"719eb06c661d7754\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/index.js\":\"67a5dfc809ab636a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1e391f2c9b4d7041\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/CharacterCountItem.js\":\"8fc41e65ae3a3349\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b5512303f6ddad3c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/actions.js\":\"b4dff4a7463b467c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/blockType.js\":\"e0051d5e3edc2a58\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/charCount.js\":\"4a73798b308cf36a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/dataExtension.js\":\"9b453fa097a00904\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/index.js\":\"4a05c6006939a5a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/profiles.js\":\"8f2e8c45f12f9961\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/properties.js\":\"0b30039d58279f2d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/character-counter/textCounts.js\":\"6cddbc54270589bc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/colemak-keybindings/index.js\":\"f934420a07aed290\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/CommandPalette.js\":\"8adebe0b212d0f35\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/HeaderItem.js\":\"6198e65d16434103\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/context.js\":\"a2679bd2bc65fad9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/index.js\":\"fcb067a21b0970fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/selection.js\":\"fbdcd223b0f83cd3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/toggleStore.js\":\"68bdf6e9ef1459c1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/command-palette/useCommandPaletteActions.js\":\"8fa569d273892fe0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/ContributorBadges.js\":\"7014269293e60406\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/author.js\":\"206e90e24ea3168c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/codeMirrorExtensions.js\":\"9cd16b5b643cb0aa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/dataExtension.js\":\"bfdfadd321e02e06\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/index.js\":\"92e833bbc283fc35\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/mentionAutocomplete.js\":\"c3f71d7fb26a2fae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/processor.js\":\"296989922af54150\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/profiles.js\":\"07ad71ef35541590\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/queries.js\":\"679769d0d10c5c7e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/contributors/schema.js\":\"b819efd9f6cd00a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4a199ffad8087bed\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/followOrigin.js\":\"faf04b9b7460d478\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/index.js\":\"363bc3c938e216a2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"874e3ccde9bd5f58\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"22c670d76281cf9f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/CalendarGrid.js\":\"e05fd04b787bf775\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DailyNotePicker.js\":\"1c20ded4c1b790cf\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"99d12f37a0ded574\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateNavDecorator.js\":\"ece6008b955faa65\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/DateScrubOverlay.js\":\"793ac15ee0c7a963\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/HeaderItem.js\":\"d11c14b6261fe465\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/ReschedulePicker.js\":\"2630446ca1bf7d12\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e027160f9f3b5ef9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/actions.js\":\"08ab3eee12ee6ce4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/blockDateAdapter.js\":\"0a2361d2f308748a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/calendar.js\":\"9e38163d28a618ae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dailyNotes.js\":\"b86fa85aaa25f740\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dataExtension.js\":\"eb8bf6fde930f571\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubActions.js\":\"c57852427f69d215\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubGesture.js\":\"6499b4ed3be9363d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1ca3e0b6562b4dc4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dateScrubRecognizer.js\":\"bac8440d8f338cad\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/deletionGuard.js\":\"f4ec73557fdf3581\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/dueQuery.js\":\"82b946a0df93cde6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/index.js\":\"99484ca769c3f611\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/landing.js\":\"9bd1d5d1efa4a5dc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/localSchema.js\":\"b8ff90837a6f652a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/referenceDateAdapter.js\":\"f7176b725b4d7b01\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/rescheduleAction.js\":\"fa23eb61053994e8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/schema.js\":\"48eb7d7eca78d475\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/spreadBlockDates.js\":\"4ead48d844416e58\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/spreadDatesAction.js\":\"8b58cd7343966576\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/today.js\":\"cf6cf08d244dca0b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"fe01b77f2c0aa531\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ff8b222ee5db03a4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/audit.js\":\"c89b031042c3afff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/auditAction.js\":\"d99f42253399f36f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/auditRanges.js\":\"eb3787f46b282b78\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/diagnosticsSource.js\":\"30e12a9364ca4570\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/divergenceScan.js\":\"003a8364028c606c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/index.js\":\"1e56f56f16254ed5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3b00a06ed6336b6a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/referencesMirror.js\":\"bdb8c6c36f67f50f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/rowJson.js\":\"ba9c5a551f84119d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/schedule.js\":\"abb2123086341661\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/data-integrity/store.js\":\"bcc9c0e981a55ed7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/action.js\":\"1fb9e5369746d906\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/index.js\":\"1a7ff4244a288db1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-maintenance/plugin.js\":\"3919e62ed3515272\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d4c49e949f987f0a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/actions.js\":\"e327cdca27de5f40\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/changeMarker.js\":\"883933e5fbb107f2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/diagnostics.js\":\"f9643fe3cc8e7ba4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/fileSystemAccess.js\":\"a9a989108c1e42c8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/filenames.js\":\"1a60b149e76b5339\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/index.js\":\"3cdb57362842acd6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/mirror.js\":\"9ba2be2ebeee02ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/runLock.js\":\"15b6f0fcd15a87af\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/runtimeHealth.js\":\"6bd003dbe9a8cc7a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/schedule.js\":\"1a1b621ba3960b30\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/db-mirror/store.js\":\"a47595a2cd2e5aba\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/default-themes/index.js\":\"2a5e23aa615eded0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/default-themes/themes.js\":\"817e1cfdc99ba857\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/diagnostics/facet.js\":\"a2cc7f2a09480f46\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/diagnostics/useDiagnostics.js\":\"acb3ba719c7540d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/dismissals.js\":\"d5d04793fc080ba3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/index.js\":\"b17eb8cecc25c2e3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/status.js\":\"eeaa9a7e9db47e8b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extension-prompts/store.js\":\"90039be2b8ed78e2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4bb9ad663ef27419\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b300be1db3db09b1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/actions.js\":\"52e9cee99c90b796\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/config.js\":\"3d32f89a78635d7f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/dataExtension.js\":\"e4d6ca873e28e262\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/effect.js\":\"20b0a192aebd7bc5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/index.js\":\"4ac6438b7083d0c1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a2e9f8f2e8438f63\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extensions-settings/useToggleTree.js\":\"84e1b5bf0689e9f8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/ExtractTypeDialog.js\":\"cd799ca90e459ae4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5b2a6384854ae397\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/PropertyShapePicker.js\":\"b13859e08058d72b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/action.js\":\"dfec4cac07dd67e5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/extract-type/index.js\":\"93ac5747aaa6b15b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/FindReplaceDialog.js\":\"5100661c415ae4af\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/HeaderItem.js\":\"0083398a25fc146b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/dataExtension.js\":\"a672cc04a98c0f0b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/index.js\":\"406f7daf9e719b52\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/search.js\":\"10dd46baff5fe0d9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/toggleStore.js\":\"8110462964425761\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/LocationPropertyEditor.js\":\"c40b50109f1c0236\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/MapView.js\":\"80113edc25e3de05\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/blockTypes.js\":\"6e7b566069379e4c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/codeMirrorExtensions.js\":\"c55d942e8471af32\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/createOrFindPlace.js\":\"a7e63824e6bb540b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/currentLocation.js\":\"0f1ccd77c8eda04f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/dataExtension.js\":\"37abb20301c62510\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/geoContentDecorator.js\":\"c149c736deddc084\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/googlePlacesClient.js\":\"df9a0802e0eb6f0e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/index.js\":\"b8b6942d4049c957\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/locationsPage.js\":\"8fb7edb43f5014e5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/mapViewport.js\":\"56d867a8597d7186\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/pickCurrentLocation.js\":\"32c4abc5ca4605a1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/placeAutocomplete.js\":\"5517978e3037179d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/placeNameCollision.js\":\"b5f37f269322beba\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/properties.js\":\"2d6372a93e3e5147\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/propertyEditorOverrides.js\":\"16c7da0654036ccc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/query.js\":\"ac3768cb426e7819\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/geo/usePlaceSearch.js\":\"8d3dbbab78b9779d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f6430bc868f18c38\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"dce09a638dad68e4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6f699e960147ec38\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/config.js\":\"d738b95e1d326f31\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/dataExtension.js\":\"c016edc7a834aaae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/facet.js\":\"0d559a98a9864126\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/grouping.js\":\"77bb7516c68c9f46\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/index.js\":\"0fbdd802eb9bdd20\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"ed222ce27f866d90\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/query.js\":\"32cea288863e2847\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/resolveConfig.js\":\"5d1c241c09d84db2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"75b286cadde1b41d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d46d86dfaefe5a92\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/HtmlDocumentContent.js\":\"00f13551e7ea9116\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/HtmlFrame.js\":\"6f67556f44490cd0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/actions.js\":\"90683e9cea12ca65\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/blockType.js\":\"fb014b2684d1fb74\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/confirmRunScripts.js\":\"c444471b871b86e8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/dataExtension.js\":\"c94d888fb977209f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameAnnotations.js\":\"bb6ca47aa9ced2ca\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameDocument.js\":\"d7b1f22b7bd4106f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/frameTheme.js\":\"83a16501265138eb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/index.js\":\"4a02b314570477d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/scriptConsent.js\":\"281e22864734583c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/sourceMap.js\":\"be713a39c13c267a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/html-document/useDocumentScripts.js\":\"10c507a1fd0c5cef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/index.js\":\"0740c22e6b8f6c0f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/record.js\":\"0e18520ccdfec761\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/recordStore.js\":\"247c71e59adcba26\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/responsiveness.js\":\"6db44483ec19a0eb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/schedule.js\":\"5716d0ed5ec4329b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/interaction-metrics/sessionContext.js\":\"f4191860275e732c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"15a7904699010907\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d5558d65fc80fb10\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/actions.js\":\"830fca85d8e5e5ff\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/config.js\":\"5ee514fe7deb9551\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/dataExtension.js\":\"5d8b8de53d168625\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/effect.js\":\"2cd7ee745b7004fd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/index.js\":\"5f9e2fd0583b7511\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/keyCapture.js\":\"ae0ff8958d68e4d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/overrideStore.js\":\"7b92a6382334f0f6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bfe92cbdb923e99c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/HeaderItem.js\":\"b37f27d8841dd3b1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/LeftSidebar.js\":\"8ee7d566b062d349\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/actions.js\":\"ae859af0f9328733\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/facet.js\":\"f1ac9b6d734fe8ac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/index.js\":\"ae0440799fa7d96f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/shortcuts.js\":\"da8c4d22e03b4fc2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/left-sidebar/toggleStore.js\":\"e2a1e665fbc8fbae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/MergePicker.js\":\"21bdf5547c98f760\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/index.js\":\"70d5a82da75808d2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/mergeAction.js\":\"b5b2260efa3f9011\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/merge-blocks/strategy.js\":\"40f8fddef79940d7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/Button.js\":\"3efb8e1ea589e7c7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2f4ff4506f0e2d28\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/defaultItems.js\":\"604e47bfee20959d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/facet.js\":\"f11e71e53bf9ac04\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-bottom-nav/index.js\":\"29a15e8fad598319\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"22e30f53fc89cd28\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9eedfffd42641f6b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"6a9600c39b295010\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/facet.js\":\"afe73155fb0ea61f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/mobile-keyboard-toolbar/index.js\":\"85c92b8460d22b21\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/MoveDestinationPicker.js\":\"25d27c6ef917b741\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/blockSubtreeMembership.js\":\"64ec9127214b76fd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/contextMenuItem.js\":\"4e7880bae8af9521\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/index.js\":\"46e1633b748ce6bd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/moveAction.js\":\"76e2ef6fe65666d9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/moveBlocks.js\":\"f4b431c853d3448a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/move-blocks/selectionAfterMove.js\":\"aac3423dc3193337\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/TutorialBanner.js\":\"7365c25a52ffd9b1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/action.js\":\"bef8662bbd6d7f96\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/bannerDismissal.js\":\"0736a8ee4ea333f5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/documents/cheatSheet.js\":\"e3f79c8741818947\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/index.js\":\"9179fee2ce943649\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/keys.js\":\"d3e2c3e2737b0ec3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/landing.js\":\"64de205098b71a3f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/outline.js\":\"d71030398b196918\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/onboarding/seed.js\":\"6683edc550727dae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/PerfTrendDialog.js\":\"204fb38966ef728e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/analyze.js\":\"2fc0d54ba0dc6932\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/diagnosticsSource.js\":\"192cc6dd2f82a6a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/index.js\":\"505a2bfe74cf70b6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/load.js\":\"ee0a9b973620791c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/monitorRun.js\":\"b188fa2936e2800a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/schedule.js\":\"ac74540466e4e901\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/series.js\":\"48b212b953741b4d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/store.js\":\"1bfc313c8914f4a0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/trendAction.js\":\"ad97f7213bf4c92d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/perf-monitor/verdict.js\":\"b271e5ab6103bdd7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/clickToEditAction.js\":\"6aec51ec348fe7a5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/index.js\":\"7465c962488aa9e2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/plain-outliner/interactions.js\":\"47ee9029c590e804\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3d38430150bf96b7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/MigrationGate.js\":\"0543f5b2ac64538c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/MigrationGateDialog.js\":\"b6aad0cebe79d48e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/action.js\":\"3c5fbf26bc225288\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/index.js\":\"79dcdba642b94aba\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/localRunMessage.js\":\"0661ac8fa82ab991\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/plugin.js\":\"373500142e86c6c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/progressReport.js\":\"e2d678c950615de2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/properties-migration/sweepProgress.js\":\"2269581b957011e2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/FieldRowRenderer.js\":\"ca14f2ba1bce7905\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/ValueRowRenderer.js\":\"fa2d2ed5af50fcd5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/actions.js\":\"518b641c6445f00f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/autocomplete.js\":\"2143e9309254c187\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/fieldRow.js\":\"2b59577dbbcd6507\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/index.js\":\"02eb40c60a4849b9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/referenceWarning.js\":\"727d0c00659946f6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/valueAutocomplete.js\":\"89c421940e51aa31\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/property-rows/valueSchema.js\":\"7a156c6ec76e17b6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/HeaderItem.js\":\"c9788c79d135ba41\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/QuickFind.js\":\"bf0d5d8da2414437\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/index.js\":\"b0e9b891605d6ba2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/recents.js\":\"fe66c6eb20e069f5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/resultItems.js\":\"f92ba35dd6f41a03\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/selection.js\":\"e5f25f67726a8fc9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/quick-find/toggleStore.js\":\"a9b62092dd0af345\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/HeaderItem.js\":\"83aef6bb329285e4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9e5a25afacebf426\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/grouping.js\":\"5319b8560804ac61\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/index.js\":\"f7e99c349bd19e2d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/recents/target.js\":\"fd33cde0de92cc7e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/codeMirrorExtensions.js\":\"d24a0a7bbd44d2d7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/contentPrefill.js\":\"af24d588d869c0f5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/dataExtension.js\":\"6cc56751e99b3224\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/index.js\":\"893fddea548b9dc0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"aa60014dfb48ae83\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/invalidation.js\":\"ca9961659b1deb8c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/localSchema.js\":\"d26d1b43d9392690\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/blockrefs/index.js\":\"57d3abaf16cbdb40\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6bb676818f8d708c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/index.js\":\"f21ca64b6eaa906c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/referenceNode.js\":\"a74d66c3edb4c83c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/remark-reference-occurrences.js\":\"f8153f4361ae8cb6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9bc4a3bbd489aa71\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/index.js\":\"d62b5139d5dfee9e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e3d59ce9de373d49\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"761ba65ff5460be0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/mergeRetargetProcessor.js\":\"ec9418bf2b977830\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/parseFence.js\":\"f874e90a203ab26d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referenceParser.js\":\"ecce2dc0fcee1c58\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referenceProjection.js\":\"b17b72239f152f41\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/referencesProcessor.js\":\"15dfdf0f812408b8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/renameProcessor.js\":\"050db5847f403133\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/references/spanReplacement.js\":\"b4e59a8d37e07057\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/htmlToOutline.js\":\"092a07e4bfc40f43\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/index.js\":\"cc15d88eaf631de2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2b3886c396fa7386\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/rich-paste/pasteDecision.js\":\"c0656e55086c6dae\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/action.js\":\"d80672f174e357c5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/blockIds.js\":\"2d692ff105e061de\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/content.js\":\"6bf20b813b46257d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/effect.js\":\"c5fc50b82f42a7fd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/ids.js\":\"2ddce6ec80853f92\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/import.js\":\"599540fbf769db54\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/index.js\":\"1469f07d3f8049ef\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/plan.js\":\"5167faeefdd81ae0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/plugin.js\":\"54148228231c41c7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/promotion.js\":\"d39c221ea77ef35f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/properties.js\":\"62023bdd4fa1d540\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/references.js\":\"8ec26d02af9f187b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/report.js\":\"3d781318be910dc2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/roamMemo.js\":\"1744fea3d7cf7557\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/runtime.js\":\"7a1ab6f5a5ec489d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/schemaReconciliation.js\":\"b4f0b56ae9796bb3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/srsMarkers.js\":\"d1ef14e93155975b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/todo.js\":\"0d6ae0316c6434a8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/typeCandidates.js\":\"e052090b1ede6878\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/roam-import/types.js\":\"45459030840ed7c1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/search-health/index.js\":\"69eeb07e9a60f80f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/search-health/store.js\":\"00032525f3e09721\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/HeaderItem.js\":\"5767e96d0b9bc79e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"208615702bdc4f81\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/index.js\":\"95d26500d25fbf21\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/model.js\":\"4fb13418a79b6943\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/toggleStore.js\":\"14b78867227964ba\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/shortcut-help/useKeyInspector.js\":\"31fcd5687843a2f1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e8934a657a47fd35\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/ShellDecorator.js\":\"ab2a3efd238b583d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/actions.js\":\"6864c7f5200ecada\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/exclusionsFacet.js\":\"460ee49d407851a0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/index.js\":\"e9d747963da2c2af\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/shell.js\":\"07f9fb55ea9e7068\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/surface.js\":\"372e013cb083a620\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/spatial-navigation/walker.js\":\"f2e9afa90902ac56\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c77f94c6b8bb7d83\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/dataExtension.js\":\"606222bcf551a770\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/index.js\":\"ecaaf6382c76e735\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/indicator.js\":\"2782e146649aa8d6\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/moveSrsState.js\":\"71c8c712e41ce760\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"ad9abbdbd9b6ac41\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/scheduler.js\":\"1f6cbbe4e1416c4d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/schema.js\":\"6f2b1f904328bbcb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"718df382ec44e86b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/srsClipboard.js\":\"7a22396d371e7c03\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"596b395dcb9fa238\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6dc627668d9d4593\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/DeckPicker.js\":\"edbae5ebc5be80ac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewControls.js\":\"9b4aec9f91837f8b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewDeckRenderer.js\":\"11edb81e2291c8fa\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/ReviewSession.js\":\"e6d250bafe380382\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/actions.js\":\"d498599173cf5cbd\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/archive.js\":\"195a0e89b1da9994\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/dataExtension.js\":\"0f44fe137e70d58c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/deck.js\":\"4e6fee2e7e6946d1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/dueQuery.js\":\"a11a5a68342a114f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/gradeDecision.js\":\"dfc1203d712cec1e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/index.js\":\"23436afccd8d120e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/keyHints.js\":\"f0f710bd18861b93\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/reviewCardLayout.js\":\"837c3ab60b124e42\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/reviewProgress.js\":\"c33bf05b4fb735e3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/schema.js\":\"169f46fb58e4b322\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/srs-review/useDueCards.js\":\"e181af3672bfdc82\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/startup-metrics/index.js\":\"8595be39625b4e40\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/startup-metrics/record.js\":\"b4d7f39da303e347\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/index.js\":\"17689eed6b1e4276\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/persistenceStatus.js\":\"7f55eb18d2a06533\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/storage-persistence/requestAction.js\":\"638647a239d4d69a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/TypeChipsDecorator.js\":\"66a3dc1fe9fef560\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/codeMirrorExtensions.js\":\"564a510f4802a2e9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/index.js\":\"1645cd4dfa922921\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/supertags/typeAutocomplete.js\":\"896b21a9470eb46c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a707a34a417bb9c5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/actions.js\":\"9df07e13be0deaf1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/anchor.js\":\"69b32de0791b8da1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/events.js\":\"6bf529135e8dbb15\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/gestureActions.js\":\"3f1ffb14fa5309fc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/index.js\":\"99002b789b4cff38\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9ba55cf5cbac9e4e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/collect.js\":\"cfb8b98c74b69494\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/index.js\":\"6c9e5afec05bf2f1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/sync-metrics/record.js\":\"1bdaaa9d8438f621\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/RejectionDialog.js\":\"5ededaf69bd05e09\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3d68c6bd3ebf36b5\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/index.js\":\"4d1e04d945517a36\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/model.js\":\"7ada81cdd30b3149\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/queueCounts.js\":\"c4093a4c78cf6055\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/rejectedHelpers.js\":\"5cb4bc5318a884b7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/rematerializeAction.js\":\"b2850373b68dbcc2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/system-status/useHysteresis.js\":\"72b1a976a5876180\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/ColumnHeaders.js\":\"00fda28da46284ea\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/QueryUi.js\":\"3bd04d56f35550af\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/TableLayout.js\":\"ac442f4fdd81e0a9\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/actions.js\":\"e66b4105b514e047\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/cellEdits.js\":\"52a8f85c0938fa86\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/columns.js\":\"472848ffb127267f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/controller.js\":\"bd22a11401df828b\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/convert.js\":\"e5aa740a0385e723\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/dataExtension.js\":\"da392b92949af202\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/index.js\":\"1d932885683d7df3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/keys.js\":\"b7ae59366f6cd413\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/model.js\":\"5d29b4ca1741b3fb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/navigation.js\":\"3afbc6e42837517f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/backfill.js\":\"1c988af85bfbe057\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/format.js\":\"3037dacfe38ef541\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/parse.js\":\"56ba952b7b172b33\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/queryValue.js\":\"de82a670fbda16b8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/query/source.js\":\"9b4aef8dfce52219\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/registry.js\":\"0d1da7d7a2f59142\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/schema.js\":\"6fd4001c62333b7e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/tables/sort.js\":\"abc5914a268b749c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/effect.js\":\"8277f6f9dca9b1c3\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/index.js\":\"d57f20ed50f85369\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/theme-toggle/theme.js\":\"cedc19949feb5e78\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/actions.js\":\"1738a2e3d80ef3e7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/dataExtension.js\":\"c2447297bf032ae2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/index.js\":\"06ab25aac5df982c\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/todo/schema.js\":\"9719dd1373604801\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0889548d6bc26016\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/actions.js\":\"eb57a4052607746e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/defaultItems.js\":\"a752ead187c22984\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/facet.js\":\"c9420f4220fcb951\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/holdRecognizer.js\":\"2786257dd890c0ac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/touch-selection/index.js\":\"3b0544473879f884\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/UpdateIndicator.js\":\"4ab70863fb24a5a2\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/index.js\":\"afdc77892141dbbc\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/update-indicator/loadTimes.js\":\"0328bd28e63621a7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoNotesRenderer.js\":\"21996dd5a8f6b5ac\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoPlayerRenderer.js\":\"43b97a8dd00c630f\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/VideoTimeStamp.js\":\"ec1fe872cec95218\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/actions.js\":\"9daa969f196559a4\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/index.js\":\"5e96793926d411c8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/markdown.js\":\"6ed5c755c3f686d8\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/notes.js\":\"86f9504d4b04f27a\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/registry.js\":\"8d06aa67bc88085e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/remark-timestamps.js\":\"a949375293621f64\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/video-player/view.js\":\"8169e78cecc2d52d\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/LinkHints.js\":\"389d61c1fd675f80\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/index.js\":\"7bcb9672dfa35ab7\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/model.js\":\"24c5eb51af69c4c1\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-link-hints/settings.js\":\"b6661531ad512bcb\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/actions.js\":\"5ad5bce3e9478a3e\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/index.js\":\"b4d0544026febec0\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/vim-normal-mode/interactions.js\":\"c16a1cc8b62a7973\",\"/knowledge-medium/pr-preview/pr-1846/src/plugins/workspace-header/index.js\":\"c7f8698b01cad167\",\"/knowledge-medium/pr-preview/pr-1846/src/registerServiceWorker.js\":\"9b73c3bd095f7206\",\"/knowledge-medium/pr-preview/pr-1846/src/requestPersistentStorage.js\":\"77eaf113614b2c67\",\"/knowledge-medium/pr-preview/pr-1846/src/services/authRequestDeadline.js\":\"34b375175c8b727b\",\"/knowledge-medium/pr-preview/pr-1846/src/services/authStorage.js\":\"43a36ca03b57b093\",\"/knowledge-medium/pr-preview/pr-1846/src/services/powersync.js\":\"3fa011f52b3a0ef2\",\"/knowledge-medium/pr-preview/pr-1846/src/services/supabase.js\":\"857372b41ab0d5ba\",\"/knowledge-medium/pr-preview/pr-1846/src/services/uploadErrorClassifier.js\":\"7ab10ca9443651a0\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/ActiveContexts.js\":\"070beb63c822f5ea\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/HotkeyReconciler.js\":\"3e7f716bb67d6e81\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/WipeLocalDataDialog.js\":\"a655958d8fc30d6f\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/actionDispatch.js\":\"f22ed78340ea7efb\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/actionRefItems.js\":\"1043ac053c130237\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/applyKeybindingOverrides.js\":\"25700973e005e3f2\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/blockActions.js\":\"7ec15a827a849252\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/canonicalizeChord.js\":\"032264525f616615\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/defaultContexts.js\":\"1890230a05be4daf\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/defaultShortcuts.js\":\"c6954df5cb3b8ab3\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/effectiveActions.js\":\"58ef7e2e26e3019e\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/gestureAction.js\":\"f0f0c063e051e8ba\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/gestureBinding.js\":\"8a75d49e06e85ef1\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/holdRegistry.js\":\"3be31e503c5046d5\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/keybindingConflicts.js\":\"0f40246a020a4879\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/keybindingOverrides.js\":\"1f4dcd9f8b4601d0\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/pointerAction.js\":\"3ffcc87f24820188\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/resolve.js\":\"7c5274dc98b1cd5e\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/runAction.js\":\"a69d0ab37f1490f3\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/sequenceMatcher.js\":\"6fba4275650947e3\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/types.js\":\"b28c74934ed75531\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/useActionContext.js\":\"ac4e68f63362e173\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/useActionDiscovery.js\":\"221e226ed2dc748b\",\"/knowledge-medium/pr-preview/pr-1846/src/shortcuts/utils.js\":\"5f00caa4f585cfc4\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/bootStore.js\":\"77332553a94c4509\",\"/knowledge-medium/pr-preview/pr-1846/src/sw/previewDatabases.js\":\"64d12611df541333\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/byteTransform.js\":\"1ad89f9ebdd17e21\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/attachmentCleaner.js\":\"6f946d9e241fc7df\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/attachmentParts.js\":\"5238ec37bfe54fc6\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/bundleParts.js\":\"b8e38c27826903b7\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/bundleRecord.js\":\"ac1998702d35fbe8\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/manifest.js\":\"255afdc70306e96c\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/takeBundle.js\":\"9e5d8661a6ce4e9c\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/bundle/verifyBundle.js\":\"cf2b454222ee61fa\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/cleaningStage.js\":\"4f651324effe8fc5\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionKey.js\":\"f8facb21e8750456\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/conversionServer.js\":\"87838ea74c8d5621\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/flip.js\":\"229b74874c46b941\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/flipAttempts.js\":\"05d2fde009be91c1\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/pages.js\":\"b626c28765ab124c\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/preflight.js\":\"81563cee779d3f7f\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/reseal.js\":\"7a1189c91938dee1\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/runConversion.js\":\"b9651818dc964b5f\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/runLock.js\":\"cc9786fab639372a\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/sealing.js\":\"7973fdcfd31ae4af\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/sealingStage.js\":\"c8a9009555346891\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/stage.js\":\"ef3ae7048cfd5350\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/conversion/verifyReseal.js\":\"7349dbfff8e97cf3\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/aad.js\":\"f1a54f6d6b63ed94\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/aead.js\":\"c8cd3cac28179592\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/base32.js\":\"32e6a832133ebcbc\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/base64url.js\":\"d20e1c9cc5e8f52d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/binaryEnvelope.js\":\"9f0d963e7170624d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/byteAead.js\":\"fd475e27b1077b52\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/canary.js\":\"d2b8573446b4209a\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/contentHash.js\":\"4a18d7a514959095\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/contentKey.js\":\"89461918a3b37fb0\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/derivedIdNamespace.js\":\"c1c265bee7cc6474\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/envelope.js\":\"0ed8dec58d9a7d68\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/hex.js\":\"8abc88345f73c042\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/sha256Hex.js\":\"16609ea2b1995c7d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/crypto/workspaceKey.js\":\"878e67e2bac06aa3\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/conversionState.js\":\"b499e139c980a87b\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4a53e2485c090595\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/pastedKey.js\":\"d11515d1345d63e2\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8c85517de5586ae3\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a87d3f9ded77f2e3\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/keyStore.js\":\"7de5c6e361fde61d\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/mintWorkspaceKey.js\":\"57894da109ec6ff8\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/modePin.js\":\"4ab17fd515789d17\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/openWorkspaceKeys.js\":\"a987619c2334e8cc\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/resolveWorkspaceEntry.js\":\"08336f6781111ccf\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/resolver.js\":\"dc896b880eae7210\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/keys/workspaceAccess.js\":\"053ac6eeb3eb9821\",\"/knowledge-medium/pr-preview/pr-1846/src/sync/transform.js\":\"50b710f390c0be7a\",\"/knowledge-medium/pr-preview/pr-1846/src/themeBootDefaults.js\":\"92a86a9a2743e60d\",\"/knowledge-medium/pr-preview/pr-1846/src/types.js\":\"1ec2df1abc9ef27b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/ClientLocalSettings.js\":\"4fe9f3917447c627\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/abortableSleep.js\":\"41c3567dd4aafe28\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/array.js\":\"a3249e76a5053d7a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/backlinkAutocomplete.js\":\"c2f3c4d24b5594d6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/blockCrumbs.js\":\"4c90d14dee51d1a6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/blockrefAutocomplete.js\":\"e4e6b012b50b5be6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/cadencedIdleJob.js\":\"b60a265edf28a8cc\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/callbackSet.js\":\"247ea010dd4d79a4\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/clientId.js\":\"901deafb4c1adee3\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/codemirror.js\":\"29ede47cccb3a5f2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/codemirrorCompletion.js\":\"36746f348c60b1e2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/copy.js\":\"5e6519b8dc3ae887\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dailyPage.js\":\"98e2ae2af7a91bda\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dbForensics.js\":\"a4190e651c6f5fde\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dbForensicsHooks.js\":\"e9d09b537efc4998\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/deleteBlockThroughUi.js\":\"6e2837e5f282f830\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dialogs.js\":\"8a665fc924a365ef\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/dom.js\":\"ec3b2011eab09219\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/downloadBlob.js\":\"abe3a30542d15985\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/exportSqliteDb.js\":\"bd7a8dccb0cee4ee\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fileSystemAccess.js\":\"cdcfeabc7d34151e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/flipSlide.js\":\"d8587b67df82edcd\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fnv1a.js\":\"561ab16297857083\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/formatBytes.js\":\"cd53f8f3804712f9\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/fuzzyRank.js\":\"f90c1e8b468e34cb\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/idbKeyedStore.js\":\"1cd6016ed263b25e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/idleCallbackPolyfill.js\":\"866a1d622b915638\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/keyboardAwareScroll.js\":\"ca0a1a2fd33efc17\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/keyboardViewport.js\":\"7b14b94a06e4301d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/lastWorkspace.js\":\"4d23fc0885663f2a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutColumns.js\":\"f017c63fd508323c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutSessionDom.js\":\"faa78428595ac910\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/layoutSessionId.js\":\"16888ba9e1050228\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/linkClickGestures.js\":\"52864cef4975fcfd\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/linkTargetAutocomplete.js\":\"cfa767269156d76b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/localDbCorruption.js\":\"eb3f9911b8c71dbf\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/localDbRecovery.js\":\"a47d9ffd8960a975\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/markdownParser.js\":\"777500891453b39e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/memoize.js\":\"54e7e70e0fc385ef\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/nameFieldCommit.js\":\"59b7cf0e4cdf98c2\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/nameList.js\":\"053a6fe520230352\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/navigation.js\":\"971650d200ed2984\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/omnilinerNamespace.js\":\"c7e01753e2b22410\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/opfsPageScan.js\":\"6053c95e16fc4b27\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelClearance.js\":\"fc1fa908ec621117\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelHistory.js\":\"bf5aa6a63f4cb1a1\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelLanes.js\":\"a678febb6eab2343\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelLayoutProjection.js\":\"e0f46c81c4f7efa0\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelScrollAnchor.js\":\"42862e4e439b5dc4\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/panelUrlFlags.js\":\"7bd45adc017ec9aa\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/platform.js\":\"dc12198b0f70007b\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/pluralize.js\":\"fd2f832ec916844e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyCreation.js\":\"7ccc9f438f9a62df\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyNavigation.js\":\"adb9ba7c7de1824e\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/propertyValueContext.js\":\"49ec827b43ecb2d9\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/react.js\":\"341630cc36fcb27c\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/relativeDate.js\":\"1089b811358bbbbc\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/relativeTime.js\":\"0e4746a84ddac1c6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/renderScope.js\":\"90bfdae89088b8dc\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/resolvedThenable.js\":\"c56abce8525bd48d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/routing.js\":\"da4ce334353f32ba\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/safeMode.js\":\"6b5015f03587b662\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/scheduleIdle.js\":\"7def33212675c8f1\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/screenWakeLock.js\":\"2c08a2c92cc3de56\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/selection.js\":\"68ab6b2edb7a1335\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/softKeyboardGrab.js\":\"16c3e5e1f5b2c5e4\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/startupTimeline.js\":\"f27810cc11215938\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/state.js\":\"dd866eec6eed2142\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/string.js\":\"3654e747eb926dfd\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/surfaceZoom.js\":\"06c0d0f529ee0ec5\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/time.js\":\"0acde86a0e6ff81a\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/toast.js\":\"e3133f83c9898333\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/toggleStore.js\":\"578ad2ec40b6a9aa\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/untilStopped.js\":\"e7c7da6589f599c8\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/userActivity.js\":\"599420af78fb19dd\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/viewTransition.js\":\"b945291b4a267539\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/viewport.js\":\"31f3272c0fb7cb49\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/webLock.js\":\"fcf10b3d4c022efc\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/workspaceRecovery.js\":\"100b16245522a86d\",\"/knowledge-medium/pr-preview/pr-1846/src/utils/workspaceSnapshotStore.js\":\"0bb5345927d654fb\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-compiler-runtime.js\":\"f7740c35fe798521\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-client.js\":\"36a4c95f76ed9429\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-server-edge.js\":\"7c023d283bb08979\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-server.js\":\"679708f3721de2ab\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-static-edge.js\":\"36357975d7756840\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-static.js\":\"7a1228dadce066f0\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom-test-utils.js\":\"27606579184fbf20\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-dom.js\":\"b7b59beb7cf1c0aa\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react-jsx-runtime.js\":\"e749b560a6f154a8\",\"/knowledge-medium/pr-preview/pr-1846/src/vendor/react.js\":\"4b28b1155f2919fa\",\"/knowledge-medium/pr-preview/pr-1846/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1846/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1846/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
