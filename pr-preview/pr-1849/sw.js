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
		buildId: "09d9676e2c9e-16f7b1f9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/\":\"03c3be4c623ac686\",\"/knowledge-medium/pr-preview/pr-1849/index.html\":\"03c3be4c623ac686\",\"/knowledge-medium/pr-preview/pr-1849/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1849/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1849/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1849/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1849/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1849/assets/FacadeVFS-CTUZxKpZ.js\":\"7ce2ea4ed2cbd954\",\"/knowledge-medium/pr-preview/pr-1849/assets/OPFSCoopSyncVFS-CLdqY3-Z.js\":\"b59445b4827a448c\",\"/knowledge-medium/pr-preview/pr-1849/assets/OPFSWriteAheadVFS-CTtA_Q1m.js\":\"6355e05a4504078e\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-async-D08pev_M.js\":\"1b73992d4499fe2e\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-vz8waUKe.js\":\"b03de34da6f14e03\",\"/knowledge-medium/pr-preview/pr-1849/assets/worker-DZrcfXSe.js\":\"e2723d0ee3dc82b4\",\"/knowledge-medium/pr-preview/pr-1849/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1849/chunks/app-BEUVW9-0.js\":\"1a88ddfcc806d2b3\",\"/knowledge-medium/pr-preview/pr-1849/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1849/index.js\":\"0743563d7897f6a0\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1849/assets/AccessHandlePoolVFS-DreJETfy.js\":\"01f907cbd40a06be\",\"/knowledge-medium/pr-preview/pr-1849/assets/IDBBatchAtomicVFS-ywRrXwEr.js\":\"a6c04e5ac8b38ba9\",\"/knowledge-medium/pr-preview/pr-1849/assets/MemoryVFS-Di6fqy7r.js\":\"0da4807deefc1b14\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-CRjJAkFh.js\":\"563f9d8cb1164b5a\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-async-DSeoc4RX.js\":\"68d831d8cbfbef0e\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1849/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1849/chunks/AccessHandlePoolVFS-DwdkdhFD.js\":\"af121f5775bd9842\",\"/knowledge-medium/pr-preview/pr-1849/chunks/FacadeVFS-DY7efCdb.js\":\"649663f8a87822f6\",\"/knowledge-medium/pr-preview/pr-1849/chunks/IDBBatchAtomicVFS-bq_p_B7s.js\":\"3f51676073e1fece\",\"/knowledge-medium/pr-preview/pr-1849/chunks/MemoryVFS-BHiiuOgL.js\":\"651cb5abac065305\",\"/knowledge-medium/pr-preview/pr-1849/chunks/OPFSCoopSyncVFS-BtVCcSkG.js\":\"70340c0d57ed0bae\",\"/knowledge-medium/pr-preview/pr-1849/chunks/OPFSWriteAheadVFS-DXN97YHH.js\":\"8b08382a32b6e96b\",\"/knowledge-medium/pr-preview/pr-1849/chunks/Preview-D9TgRKrW.js\":\"d35defd1345291f9\",\"/knowledge-medium/pr-preview/pr-1849/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1849/chunks/card-693_PfzU.js\":\"a03d24383e794f60\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-Bo0Co8E5.js\":\"0605e62c0d9c707a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1849/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1849/chunks/mc-wa-sqlite-0IYL4xS2.js\":\"1157dd6ff2df531b\",\"/knowledge-medium/pr-preview/pr-1849/chunks/mc-wa-sqlite-async-D_7oJdE3.js\":\"a28d4feb79e1d771\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-BcY_rb4X.js\":\"07469fac821d5340\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-Bmh_rV2V.js\":\"d3f81e2fe50a8536\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-CU5D_JYz.js\":\"fc3321a8c5fe5f34\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-CXg_dAQG.js\":\"551dd009438f0a87\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-CYPvn3l8.js\":\"8cac240b664380f1\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-Cikxkphj.js\":\"8a22b1956707a74d\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-Dja-y_nF.js\":\"b540f180d08e6975\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server-legacy.browser.production-BlJ1KpE0.js\":\"de33e81e76e9c565\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server.browser.production-BAgZaRmo.js\":\"4f8b2a3d3275ad40\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server.edge.production-DLzyOaGM.js\":\"f1302c9f44edfaae\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-hgoqC6VE.js\":\"0e99a823db5cc414\",\"/knowledge-medium/pr-preview/pr-1849/chunks/server.browser-BAhrVIvT.js\":\"dcba386ffaf7c480\",\"/knowledge-medium/pr-preview/pr-1849/chunks/textarea-DOoKABMB.js\":\"5305f82fa44e0eb3\",\"/knowledge-medium/pr-preview/pr-1849/chunks/ui-l2xpQStV.js\":\"a2f442e1b458eeb8\",\"/knowledge-medium/pr-preview/pr-1849/chunks/wa-sqlite-async-fqHSP1g_.js\":\"3cbea204c659e45e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/wa-sqlite-wEY6Mp41.js\":\"35504ebac4ec9c2a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1849/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1849/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1849/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1849/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1849/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1849/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1849/src/App.js\":\"c9cf96204066685a\",\"/knowledge-medium/pr-preview/pr-1849/src/appUpdate.js\":\"732a4925aa0e7e41\",\"/knowledge-medium/pr-preview/pr-1849/src/appVersion.js\":\"99f03ca632bd5428\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/initialLayout.js\":\"1d81e375a8714ee6\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/openWorkspaceData.js\":\"e1f9e413b5c1e03c\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/resolveWorkspace.js\":\"663eca502e6c7da1\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/workspaceBootstrap.js\":\"c0cd80c99e8a03df\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockComponent.js\":\"39bb15102eba96c7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockCrumbs.js\":\"a1c42715f6dad4e8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockEditor.js\":\"6b9ad43123acf026\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockLoadingPlaceholder.js\":\"e7a1fd31eac04266\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockProperties.js\":\"ed66ad3288f7edc8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockSearchPicker.js\":\"ba59f1d68d833c89\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ConfirmBulkDeleteDialog.js\":\"cf167bd18a1f13fd\",\"/knowledge-medium/pr-preview/pr-1849/src/components/DividerHandle.js\":\"b3ed6af624afbaff\",\"/knowledge-medium/pr-preview/pr-1849/src/components/DraftEditor.js\":\"ee708b94e0c74cea\",\"/knowledge-medium/pr-preview/pr-1849/src/components/GutterPill.js\":\"469c91e1c21747b3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/Header.js\":\"6347db0878d0f0b2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/LazyBlockComponent.js\":\"c11d6041ce2e41ae\",\"/knowledge-medium/pr-preview/pr-1849/src/components/Login.js\":\"f7bee7350e25b421\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ZoomableSurface.js\":\"efdb97606894dfa6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/editModeKeepalive.js\":\"aabf52329b359b46\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyDisplay/PropertyDisplayScope.js\":\"45e92a8d8b76cdce\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5041d809034357d6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/RefPropertyEditor.js\":\"c806353ad8a80228\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/RefTargetTypePicker.js\":\"6f2da923390261e0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/SelectPropertyEditor.js\":\"21da62682f8c6ccb\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/TypesPropertyEditor.js\":\"a5ebe6a7cdc05da0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/defaults.js\":\"fd0fb0b3dac7bbf6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/kernelValuePresets.js\":\"16cfdff6b14fe152\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/selectablePresets.js\":\"22c2e24cd19974bb\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/typesPropertyUi.js\":\"47f6e5d2c2ff9815\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/AddPropertyForm.js\":\"3f678d245ab7a35a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/PropertyPicker.js\":\"e40d490084675282\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/PropertyRow.js\":\"6a9ede8d9a5e45c2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/Rows.js\":\"1295569bba8379f3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/actions.js\":\"6822a24529236a2a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/declarationOnly.js\":\"000f89257bcfca76\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/layout.js\":\"976352855e405603\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/model.js\":\"7a22eaf4ef273289\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/shapeUi.js\":\"03bdcc4ba0bbedb2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/shapes.js\":\"d0dccfb7bdd00e2a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/usePropertyEditingActivation.js\":\"85a1c650d5e5d574\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/visibility.js\":\"6c1411aa8a4ed822\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanelSections.js\":\"be380ae290f24d8f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockEmbed.js\":\"1fe490fd24b1e0cd\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockLink.js\":\"970cceeecfa1a5a4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockRef.js\":\"81b528eedf4e2fa8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/ReferenceLink.js\":\"5bb32846225e254f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/cycleGuard.js\":\"e4fc09291657a1de\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/cycleGuardContext.js\":\"5acf8986cb29d2c0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/linkInteraction.js\":\"9c22da89d258a91d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/referenceLayout.js\":\"bf086ca1aab664ae\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/useBlockRefAncestors.js\":\"a99ee59bcbc9bb3f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockGutter.js\":\"bf4bd46db29a532e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockInfoDialog.js\":\"a79f7369e974399f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockTypeBlockRenderer.js\":\"662e4c921eb7d7e8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BulletHoverCard.js\":\"b54c23f7493f0131\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/CodeMirrorContentRenderer.js\":\"7abb45afe3cb0b98\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"3c386e01bc432fd8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/ColumnResizeHandles.js\":\"2bd1dbc9f97fe2f8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0f5c9e6360c460d2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/DefaultBlockRenderer.js\":\"9edc28b22449044f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/LayoutRenderer.js\":\"f4696046ef98ecab\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/MarkdownContentRenderer.js\":\"f2be73fdb686c4e6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/MissingDataRenderer.js\":\"e8d46334b083393d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/PanelRenderer.js\":\"8f5936eec192a902\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/PropertySchemaBlockRenderer.js\":\"61f0eaf31350fc0c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/TopLevelRenderer.js\":\"f6dac5ed359c3f87\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/blockGutterMode.js\":\"23276dbb04becbb4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/blockTitleText.js\":\"c154736c5c819cc6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/fieldCreationKeydown.js\":\"7aca902ab8a8dbaf\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/layoutRootContext.js\":\"7965399239c1f0ab\",\"/knowledge-medium/pr-preview/pr-1849/src/components/typeChip/TypeChip.js\":\"f5b315f845a9d1ed\",\"/knowledge-medium/pr-preview/pr-1849/src/components/typeChip/chipStyle.js\":\"9c5e11007386d22b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/anchored-floating.js\":\"5d2a638d6211a9d0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/button.js\":\"09dbe58756fa220d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/card.js\":\"e8a6de518b8b5638\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/checkbox.js\":\"474afddaa52f61f1\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/collapsible.js\":\"2a177ed9273af323\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/command.js\":\"a4bfa49e8e0003b4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/context-menu.js\":\"2e19ec3dcf8b3756\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/dialog.js\":\"d768bc809a9436dd\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/dropdown-menu.js\":\"19941a11c6b34216\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/floating-listbox.js\":\"cb7c5995d5ae83a3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/index.js\":\"6dc6628c383d7854\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/input.js\":\"520d557bad753e66\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/kbd.js\":\"51a7a58c0368b56e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/label.js\":\"eeb36a3ba1b02570\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/textarea.js\":\"57c231b39f2de83d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/useEditModeYieldKeepalive.js\":\"4b722b12cf682a5e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/BootFallback.js\":\"c0127f5436b8cef7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/FocusedRowLazyMount.js\":\"1b3ca5f7997cbe96\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/LazyViewportMount.js\":\"6a9ebf53c2a82c05\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/LocalDbCorruptionFallback.js\":\"e6f5b07ce2f1e49c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/error.js\":\"d21d0bde95d8c34a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/lazyMountRegistry.js\":\"ca23f9e275ea5898\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/suspense.js\":\"cf1b04c29f6ba23f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/CreateWorkspaceDialog.js\":\"70358c795bae71f3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/PendingInvitations.js\":\"d5bdc05bf419f437\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/SyncProgress.js\":\"a8fde1ca8e371613\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/UnlockProgress.js\":\"fff1acb040216c48\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceKeyGate.js\":\"a8554a5806f9bdcd\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSettingsDialog.js\":\"a14793ef32860eec\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSwitcher.js\":\"219687d6c5450d67\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSyncGate.js\":\"c2a364a73578b814\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/ConversionFlow.js\":\"6059716c12bafafa\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/ConversionFlowHost.js\":\"8e3d4aafcdb09f0e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/EncryptionSection.js\":\"2db111cd7beb1d6e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/attachmentPrompts.js\":\"573aa4bc0350ea8b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9a8929f941ded235\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/conversionFlowDeps.js\":\"bee130f439fb0878\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/conversionFlowStore.js\":\"402e7ab713ff99f4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/flowUi.js\":\"15c60a1efea49df0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/useConversionRun.js\":\"088b924412ee58df\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/keyUi.js\":\"3b880d49eb3c43e9\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/useCloseOnKeyLoss.js\":\"10e450da2d4abd05\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/useCloseOnServerE2ee.js\":\"854fc8529fbec516\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/workspaceUnlocked.js\":\"af9b77e2fae8cbcc\",\"/knowledge-medium/pr-preview/pr-1849/src/context/backgroundSubtree.js\":\"8a29baafc3a54733\",\"/knowledge-medium/pr-preview/pr-1849/src/context/block.js\":\"741734feeed85042\",\"/knowledge-medium/pr-preview/pr-1849/src/context/layoutWsContext.js\":\"507d92eceea1da8e\",\"/knowledge-medium/pr-preview/pr-1849/src/context/propertyDisplay.js\":\"9e8fa7d72a7773b6\",\"/knowledge-medium/pr-preview/pr-1849/src/context/repo.js\":\"2739f73f919493f7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/aliasClaim.js\":\"35f03ce2d6d4d648\",\"/knowledge-medium/pr-preview/pr-1849/src/data/aliasSeatNamespace.js\":\"e55434bda4bfc44c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/blockData.js\":\"948df25fb5abb8ed\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/blockType.js\":\"3ee2dcdd0e7c408c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/changeScope.js\":\"9704dd9b89f0cc92\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/codecs.js\":\"0c2b293edf386af3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/derivedData.js\":\"57d20f92c73e6062\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/errors.js\":\"8edc81264ccc7e69\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/events.js\":\"e3ccf042ab01211e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/handle.js\":\"3a1dacd770a736a4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/index.js\":\"343370709fe1ae3f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/mutator.js\":\"cc96377990827ad5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/processor.js\":\"09fb739d63e5be2a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/propertySchema.js\":\"91c25bafffaf08fc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/query.js\":\"addd098f06f8ae48\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/sameTxProcessor.js\":\"d7e20b99ae0d7c50\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/schema.js\":\"3a1dacd770a736a4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/tx.js\":\"3a1dacd770a736a4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/typedBlockQuery.js\":\"05e3d651a0723ddb\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/user.js\":\"190e20ab4274e18b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/valuePresetCore.js\":\"0f82381b7221b2e4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/valuePresets.js\":\"0280082737259c5b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/attachmentCleanerIOVerb.js\":\"182bda0d27862742\",\"/knowledge-medium/pr-preview/pr-1849/src/data/block.js\":\"a7b720fe4dc888b3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockCache.js\":\"77901048e36d0da5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockId.js\":\"4c45e31161cf4bc9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockLiveness.js\":\"72dd1345f27203d4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockMerge.js\":\"05c9b62265a2a48c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockSchema.js\":\"35c5301f6908c72c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockTypeLookup.js\":\"b4495fcf3119f09b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockTypes.js\":\"259ded887c83f80b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/clientContext.js\":\"54c7757b588cb14e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/dbFileSiblings.js\":\"a39bfa8d0a0a6707\",\"/knowledge-medium/pr-preview/pr-1849/src/data/definitionSeeds.js\":\"fcd313d48d7bb082\",\"/knowledge-medium/pr-preview/pr-1849/src/data/derivedIds.js\":\"3b400a9c0d2490d5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/drawnSubtree.js\":\"0e55e4ddfbf310bf\",\"/knowledge-medium/pr-preview/pr-1849/src/data/facetBridge.js\":\"f3233f49bbcbf379\",\"/knowledge-medium/pr-preview/pr-1849/src/data/facets.js\":\"b0499f0ac73ee5f5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/globalState.js\":\"8548ad37375cf634\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/aliasClaimRederiveProcessor.js\":\"1a57422b03f74010\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/ancestorBatch.js\":\"d70a84bee968e1f4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/blockTypeTypeifyProcessor.js\":\"d9abacc49984eb9c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/clientSchema.js\":\"d1a05c1cc1967e27\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/commitPipeline.js\":\"68ebee50bfe95580\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/devAssertions.js\":\"c8c5e695925ddb0a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/firstSync.js\":\"8c934397990af1b1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/freshInitialLoad.js\":\"4cad8f293d11d893\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/graphBackfillClaim.js\":\"b9acba9f7d485eb6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/handleStore.js\":\"24e8018a3e4e02dc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/idleMarkerJobs.js\":\"3ddbea1367f67890\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/initialDownload.js\":\"e275628c7e6c0b3c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/initializeClientDatabase.js\":\"73d0210b26fab26c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/jsonCanonical.js\":\"8d4966ecc7fe2d06\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelInvalidation.js\":\"d31efde8a2a79be5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelProcessors.js\":\"e04fd8a7f52752b4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelQueries.js\":\"0d0e7531819e6931\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/mergeTypeMembershipProcessor.js\":\"27c945e5346f3b35\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/normalizeReferencesProcessor.js\":\"22c32a5ad5c99fd8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/poolInstrumentation.js\":\"855ab5bfadca14c0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/processorRunner.js\":\"54785605180fb5de\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyCellBackfill.js\":\"5f22b558debcb588\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyChildMint.js\":\"6521395b761fc4c2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyChildrenProcessor.js\":\"cdd0564ddb386a87\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f4a95256b51716a4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyDefinitionSynthesis.js\":\"d4032cc87b93d6b9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyKeyScan.js\":\"01c69aecbfb5b078\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertySchemaResolution.js\":\"97d1501ed8aacab9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyValueEdits.js\":\"d7ecd5ed5267e6a1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/raiseProtocol.js\":\"195d7d6c096c645c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/readBatch.js\":\"36bfe86609797100\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/refProjection.js\":\"57cda6d86272aded\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/referenceTargetLookups.js\":\"58f28026ed2fc377\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/referenceTargetProcessor.js\":\"111b98f6c361afa6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/replayMerge.js\":\"1665b005cfe0596b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/sqlBinds.js\":\"0599ba40dd99295b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f91bd699a44bdd8d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/arrivalProcessors.js\":\"050fe777e5837965\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/invalidate.js\":\"8a24bb5a4a1f1404\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/materialize.js\":\"fec98d7b84b03b63\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/observer.js\":\"8a9aa1a5c6b880df\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/reconcile.js\":\"d327d4d692889d8f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/timingMetrics.js\":\"7fb88b83c5ffd2df\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/treeQueries.js\":\"fbceb707666d1c08\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/txEngine.js\":\"ed026693d2859019\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/txSnapshots.js\":\"597480885a75624e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/typedBlockQuery.js\":\"52e089bfde14e648\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/undoManager.js\":\"70b4ad3529f3ec36\",\"/knowledge-medium/pr-preview/pr-1849/src/data/invalidation.js\":\"1e84a37aeab57e07\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelDataExtension.js\":\"733e71ed4eea5c7d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelPage.js\":\"2e965865e6a90bde\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelValuePresetCores.js\":\"907ea4aca3115dac\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbCorruptionSignal.js\":\"d57d03d14591a720\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbStorage.js\":\"47c2925e83be2472\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbVfs.js\":\"fff1221ff80aab17\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localSchema.js\":\"34b81f90d521e108\",\"/knowledge-medium/pr-preview/pr-1849/src/data/maintenance.js\":\"40db8e4fb88b2ef7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/mergeProperties.js\":\"75024a3ecd22a721\",\"/knowledge-medium/pr-preview/pr-1849/src/data/metricsConsoleHook.js\":\"6a5b01b4766fc2a0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/migrationsPage.js\":\"1eebbccf7a3a4ebd\",\"/knowledge-medium/pr-preview/pr-1849/src/data/mutators.js\":\"bd187e3abd4fcd11\",\"/knowledge-medium/pr-preview/pr-1849/src/data/orderKey.js\":\"cc2929aef5489a39\",\"/knowledge-medium/pr-preview/pr-1849/src/data/orderKeyPlacement.js\":\"43840d2e27cb01e6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/outlineSurface.js\":\"2a05aab9b3b76a89\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pendingEditorContent.js\":\"328b18df67cdc4af\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pendingUploadsSql.js\":\"3148b5615a7781da\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pluginStateExtensions.js\":\"32310fcdaeff41f9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/powerSyncLogger.js\":\"974b70e720a7d934\",\"/knowledge-medium/pr-preview/pr-1849/src/data/projectorRuntime.js\":\"5d46bca87e53dfff\",\"/knowledge-medium/pr-preview/pr-1849/src/data/properties.js\":\"b503f63cdf049e2f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertiesPage.js\":\"3574883a3a66f00e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyChildren.js\":\"3fdf58b564192b92\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionFanout.js\":\"f4f140a53662f6df\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionMetadata.js\":\"51fbbeb5ce85f1fc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionRegistry.js\":\"9fa5f94787b5ebd9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDisplayMode.js\":\"b35a07bada24ef6e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyRowCreation.js\":\"9b631130e9d10bc4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertySchemaCreation.js\":\"eff663faa45d8b8d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertySeeds.js\":\"cfa242f2ec1873a6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/recentsPage.js\":\"f0a607681efac3fa\",\"/knowledge-medium/pr-preview/pr-1849/src/data/referenceBlock.js\":\"c0efeef52c878149\",\"/knowledge-medium/pr-preview/pr-1849/src/data/rejectedUploads.js\":\"fc265ea2f15f95a6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/releasePowerSyncConnection.js\":\"73e918f1110ac528\",\"/knowledge-medium/pr-preview/pr-1849/src/data/repo.js\":\"8f6eea6d90916d65\",\"/knowledge-medium/pr-preview/pr-1849/src/data/repoProvider.js\":\"7d2904a7027278f3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/rowProperty.js\":\"5876e65237b46210\",\"/knowledge-medium/pr-preview/pr-1849/src/data/searchFilter.js\":\"69b565f7e3a2db79\",\"/knowledge-medium/pr-preview/pr-1849/src/data/seedIdentityLedger.js\":\"aa0c6eff861a1cb2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/stateBlocks.js\":\"0a0daabd6730f2af\",\"/knowledge-medium/pr-preview/pr-1849/src/data/structuralEditPolicy.js\":\"cf58d41910ce2df5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/subtreeDelete.js\":\"4b3772d78da488b5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncStreamLock.js\":\"bf12e9514db7074b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncedTableSqlRecognizer.js\":\"22c791871774c4ca\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncedTableWriteGuard.js\":\"dd9a69de591e5d88\",\"/knowledge-medium/pr-preview/pr-1849/src/data/targets.js\":\"cef1da7ef2229041\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeColors.js\":\"7c0a4e62092fc047\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeDefinitionMetadata.js\":\"1037dfb6e8b4ce21\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeDefinitionRegistry.js\":\"04b54f3b71137c90\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeExtraction.js\":\"96b10e7d686e437f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeInitialValues.js\":\"cf31c976fbf41f4d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typePropertyGroups.js\":\"011ef471d6e30c07\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeSeeds.js\":\"c988f4fe4283f02a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeTagger.js\":\"671586a9be11db53\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typedRecords.js\":\"dea8e03dfc1b6585\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typesPage.js\":\"9e5906dd5344fba5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userPrefs.js\":\"706e39c11a8f4d85\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userSchemasService.js\":\"661f30da2e8138f3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userTypesService.js\":\"176519b865b6d0a0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/valuePresetRegistry.js\":\"ac368cb83fb4f8f5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/visibleChildren.js\":\"da3806528763bd13\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceConversion.js\":\"371495fab5209c4f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceFirstSync.js\":\"1d3f8217aea2fbc6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceIdNamespace.js\":\"e86683faf1859fa3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceSchema.js\":\"a44b157d935dd63c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaces.js\":\"30b6c13c2316aa60\",\"/knowledge-medium/pr-preview/pr-1849/src/data/writeAheadLog.js\":\"b38f5f6fa8774a0a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/BlockPasteShellDecorator.js\":\"576ae3697e92ff6e\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/atTrigger.js\":\"22ee0ebbe7820c2b\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/autocomplete.js\":\"fc73878dbdf1dd0f\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/codeMirrorExtensions.js\":\"e77a31ca38a31485\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/contentFlush.js\":\"249cf192007deb64\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/defaultInteractions.js\":\"bc30f3c8a1e5e219\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/editSettleSignal.js\":\"9ae0725bdd440586\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/insertImage.js\":\"812f6e8e2d836f76\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/referenceCompletionRange.js\":\"394da92d2485701c\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/referenceTargetTypes.js\":\"33630bd2d2d92910\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/syntaxContext.js\":\"c6a8211c4b411d7d\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/triggerMatch.js\":\"175a70b9629ec7c0\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/AppRuntimeProvider.js\":\"f027215723f3c427\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/BlockFocusShellDecorator.js\":\"1f3c417092fc4e04\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/ExtensionRenderBoundary.js\":\"b9b3b7c893d6712a\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/PanelContentRecovery.js\":\"8614c3a33d897471\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/apiCatalog.js\":\"c7f3acda23d86d20\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/approveExtensionHere.js\":\"9a8615bc20651daf\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/armedCutAppMount.js\":\"31da32eed078e03f\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/batchableKeyedStore.js\":\"4375b9a4ddd47687\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/blockInteraction.js\":\"b289abd25670a5b6\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/blockSelectionAction.js\":\"b3eebd5518d0d6fd\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/compileExtensionModule.js\":\"eb991ef27c967ed8\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/compiledModuleCache.js\":\"eb24f1953cec68a7\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/continuousGestures.js\":\"7259e1940002debc\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/core.js\":\"d167019ac15d2bbd\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/defaultRenderers.js\":\"3fdeeab1153ac9f0\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/definitionFanoutAppMount.js\":\"93dca708f90ffc13\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dialogAppMount.js\":\"fd3b56408f0505b3\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dynamicExtensionSeeds.js\":\"d3ac7c1cdfb521a4\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dynamicExtensions.js\":\"e5126a43f04a5088\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/exampleExtensions.js\":\"745d25111924a34d\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionApprovalStatus.js\":\"4eba5474d93452e1\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLoadErrorToast.js\":\"c55c682b807e75bc\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLoadErrors.js\":\"8eff9cd1cc3b3517\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLookup.js\":\"21f06c92d3e38b8b\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionToggles.js\":\"9fde7dfad8ca8f5d\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionUtilitiesCss.js\":\"dcc1a471f5cd11e4\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/kernelPageDeletionGuard.js\":\"8d81dee6895844ce\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/liveRuntime.js\":\"19efc00bdcec481a\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/openExtensionsSettings.js\":\"17b534807de1ec53\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/overridesCache.js\":\"543a47f147f934ef\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/pluginIds.js\":\"1e3514bb1038d172\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/processorRejectionToast.js\":\"a6b4b4258c4dae0c\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/runtimeActions.js\":\"89896693afca62d1\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/runtimeContext.js\":\"3970587d1217ed5a\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/staticAppExtensions.js\":\"d37225a3d09b5158\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/staticDataExtensions.js\":\"6f72cb663219fdfa\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/toastAppMount.js\":\"dfa0865165268266\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/useOverrides.js\":\"9644760b2e9579c1\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/useShortcutSurfaceActivations.js\":\"cf961255f2c65c8c\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/discoverToggleTree.js\":\"76390a2aefe9ce5f\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/facet.js\":\"0f71b27389dbca06\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/resolveAppRuntime.js\":\"7a88d39525c8ec4f\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/runtimeEvents.js\":\"ec1805315e321e3f\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/togglable.js\":\"2050b27611e5bdde\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/variantFacet.js\":\"7a0051a0e208e601\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/verbFacet.js\":\"102f684d2a8ec213\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/block.js\":\"15dc825247cb15de\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/focusedChild.js\":\"0b3a5d4719c8031b\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/propertySchemas.js\":\"a47a254bf0cce1ae\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/typeRegistry.js\":\"2880ab48dc34804c\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useAncestorCrumbs.js\":\"80eece5f7b82f655\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useAutocompleteListbox.js\":\"d8055c55c2ddde5f\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useDebouncedSearch.js\":\"3b23c00bb7d27614\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useDebouncedValue.js\":\"25f8c280015b43d9\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useIsFocalRender.js\":\"93bf96bfff29236a\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useIsReadOnly.js\":\"d0633343a1386bbc\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useMaterializeBacklog.js\":\"cdf6f83b14fb12a2\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useMinuteClock.js\":\"7ba28b1049b69020\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/usePanelLayoutProjection.js\":\"6db93f365df4f71a\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/usePendingInvitations.js\":\"9441d73f98e477de\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useRendererRegistry.js\":\"e95f6d74361da7b0\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useRetainedFieldRows.js\":\"c63802625dcb53c7\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useWorkspaces.js\":\"9a89b1488161add5\",\"/knowledge-medium/pr-preview/pr-1849/src/lib/utils.js\":\"f03e37e09569dda0\",\"/knowledge-medium/pr-preview/pr-1849/src/main.js\":\"a43b78e7652f0f2b\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/MarkdownImage.js\":\"45b98777d8bd8a65\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/blockSeparators.js\":\"369f4942abcbd2dd\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/context.js\":\"6d0b69d12ff66379\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/defaultMarkdownExtension.js\":\"be83a3f9729f7a21\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/extensions.js\":\"8006852813ffb5c4\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/renderMarkdownHtml.js\":\"f28c76dffab743b5\",\"/knowledge-medium/pr-preview/pr-1849/src/minimal-editor.js\":\"2cb81c7bd8f2cc27\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/armedCut.js\":\"b59848449e8632f3\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/captureMediaVerb.js\":\"926bcee068ffa638\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/clipboard.js\":\"470df21eb2fd64d2\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/decision.js\":\"7afeb2f030747504\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/operations.js\":\"63f5d31dbcadd38a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/account-header/AccountHeaderItem.js\":\"daa853b4f64627f2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/account-header/index.js\":\"b451b2f57baad4df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"661a43f064c5a917\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/askAgent.js\":\"9ec600ac03cb1140\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/askedStore.js\":\"00f547eeb61373f8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"e8ff091921630949\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/chipState.js\":\"65d9b65bedb792a4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/dataExtension.js\":\"391e9a577ddac247\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/index.js\":\"9846e0aada03a2fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"97efb69df0e5ae9e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/schema.js\":\"e3902cbd154b050c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6db1b0cd13a8043b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bf11c6d4a5956ff9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/addMedia.js\":\"c0d7857636be834c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b49c67b1baa7fd53\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/block.js\":\"2e66de44d5e08b48\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/context.js\":\"333deef4bcfc5a80\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c8b33b1e3266b2dd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/index.js\":\"316a68b5f87936ce\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/outline.js\":\"c2d7aca43fc85e35\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/properties.js\":\"2c5abc3da0f57551\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/refs.js\":\"819e4c31edd0e2eb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d691181a795e1136\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/search.js\":\"6bf8a52e10be807b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/shared.js\":\"bdc68de6b0c66c76\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3993f4d1baeff26d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/text.js\":\"478092663aadbb79\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentWrites.js\":\"a2524134a69f1b14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/authoringCatalog.js\":\"438ff981a16e48e0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/blockRefTargets.js\":\"5ffe4b7da9abde44\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/bridge.js\":\"26e99047ab153bbc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/bridgeLoop.js\":\"762a0aa0fba12321\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/changeHistory.js\":\"67a70f544c168d06\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/commands.js\":\"c19a01736a6187b8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/commentsCommands.js\":\"bb209d37736d6238\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/dataExtension.js\":\"f7aa8a6464ab4713\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/dataModelGuide.js\":\"9f8e8e17c9d4e3a9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/describeRuntime.js\":\"4054db176de8cb83\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/extensionLint.js\":\"80048fd45f40b0c6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/grainAudit.js\":\"8801978b5f54bb09\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/healthCommand.js\":\"b7228dc8800407a6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/index.js\":\"82add083c07a0c96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/presetIdentity.js\":\"78251f32650f95b2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c8d611a7c3d7a1da\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/readMedia.js\":\"947e43a5fd4e2db9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/schema.js\":\"567e5451ee9cefb3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/serialization.js\":\"0aa443ac31c00395\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/targets.js\":\"ca9859f38e784594\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/tokens.js\":\"5087e07590996dab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/watchEvents.js\":\"427418c63706c123\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/workspaceGuard.js\":\"02d140c536f4e450\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/writeCommands.js\":\"f79eb43e09abca20\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/AliasCollisionToast.js\":\"256a162f2e06c75c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/DuplicateNameBanner.js\":\"459ccbe0b91d55a8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/collisionMerge.js\":\"dc69df514ced7569\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/dataExtension.js\":\"706fd856fdfaef8a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/index.js\":\"d355daf39c9c58f5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/mergeCollisionAction.js\":\"9bd141703d48f1e0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/pageStyling.js\":\"05de2a0cf32f5a05\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/rejectionToast.js\":\"f6de7c32a752293f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/syncProcessor.js\":\"748c58a19a13d4c2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/actions.js\":\"b7bb1c357235b73e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/addComment.js\":\"6ecae014e2a564e5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/anchor.js\":\"09160fad1a083229\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/anchorState.js\":\"4c595179a0ebac6f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/commentLinks.js\":\"edf2c3bc4426eb96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/confirmThreadDeletion.js\":\"a3aed045ec213117\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/container.js\":\"fd1c28a83b375e5e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/dataExtension.js\":\"494f1604d319bd6a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/deleteComment.js\":\"b4ef6648f743dfb1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/highlights.js\":\"b887d5ccb0eca44c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/index.js\":\"f5058549a390ac17\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/linkedCommentsPill.js\":\"a55e228fa2c5cd3e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/margin.js\":\"19e7b12589f9f745\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/marginSchema.js\":\"3661ecd5339eb27c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/newComment.js\":\"3ad6701dbe9f77cc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/ownThreadPicker.js\":\"42f1864b26712352\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/placement.js\":\"0e015f351f720a26\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/queries.js\":\"cfdf28cb280b6ba4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotePosition.js\":\"af3e0b5936c4d726\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotedIn.js\":\"e208712f95a1e255\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotedRange.js\":\"b33537848a134727\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/rangeRefs.js\":\"df5388e21ea8537a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readHighlights.js\":\"4ad2bb1b471fd8a6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readSelection.js\":\"cf26d719f8a310ad\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readSelectionUi.js\":\"5ae53b24c1be3e2d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/reanchor.js\":\"d1b5e24321c15bc1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/schema.js\":\"36e850d942da00b0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/scope.js\":\"c0837e578d712a78\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/scopeThreads.js\":\"026333603b11bcf7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/splitRetarget.js\":\"e943e57f73a13d4d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/suggestionCard.js\":\"a26fc1f66ff66ce3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/suggestions.js\":\"66c4fe5df8577b34\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/summaries.js\":\"a967f355d8c20d14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/summaryBatch.js\":\"5707ae26ed4c1d01\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/surface.js\":\"650fa0da3ecf3f22\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/threadNavigation.js\":\"9f198b5d3b27e171\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/threads.js\":\"4391a9b3cf344dcf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/ui.js\":\"470d92e083d01942\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/uiStore.js\":\"97d16f6bbb3ccfa4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-intents/appIntents.js\":\"85b59d4e3728c986\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-intents/index.js\":\"39782a121bfa98b3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-update-prompt/index.js\":\"58f671637ece1895\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-update-prompt/status.js\":\"94b549a3613e47c2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"632b6738ac969aee\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaBlockRenderer.js\":\"2dddcd6a39b592c9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaDownLaneReplicator.js\":\"333d5135fc0cb2f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaUploadReconciler.js\":\"e8418d62bba1a420\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetDownLane.js\":\"5e30318a47a845cb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetResolver.js\":\"4e7ba667ccc26955\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetUpload.js\":\"392c7b4558c8e27c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/attachmentCleanerIO.js\":\"36789cb0d418cc8f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d8bf21a0c02b372d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/blobStore.js\":\"c7c12794f8bc5adc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/byteStore.js\":\"35d1f79881a078c9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/cleanerIO.js\":\"05d90cebeae1cbe2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/cleanupAttachments.js\":\"9f9acb0728737b73\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/dataExtension.js\":\"4ca4f572d13bdcc4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/downLane.js\":\"316102e754cccc63\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/index.js\":\"562f9a3ef1c7df04\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/insertImageContribution.js\":\"98295c14cfc22227\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/laneArming.js\":\"0ffccdb8a21a2021\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/laneLock.js\":\"8cda1f81e000d2ae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaBlock.js\":\"6f989d63f50a39f7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaCapture.js\":\"76e361498601fc62\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaViewers.js\":\"662ce0ee1502f605\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaViewersFacet.js\":\"f1c1b67ceff17476\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/pasteCapture.js\":\"615ac21475cd1dad\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/resolver.js\":\"2b25fd2a4f060a20\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/retryUploadsAction.js\":\"8638ff4b0d161db5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/storagePaths.js\":\"f5b04d43bc5cd125\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadDrain.js\":\"a3c7065cf4c6b2b7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadLaneStatus.js\":\"d48bfc964be9377b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadReconcile.js\":\"4e142a1c8e98137e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadRecovery.js\":\"62ac84f63eb7db24\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadStore.js\":\"71f71b049ccfa17f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/useAssetObjectUrl.js\":\"9047cf36f214f548\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"bdd8fa3c1ff33fe6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/BacklinksViewSection.js\":\"6efede5e90f09018\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/facet.js\":\"021240169f621f66\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/index.js\":\"157d9db64e1f321a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/prop.js\":\"0a17b4a5996cfb54\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BacklinkFilters.js\":\"4a72b5848a548e2f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a155d5c9b87b1862\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BlockEntry.js\":\"7bebbb2b6eab7a1a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/LinkedReferences.js\":\"05974319bc77a5e6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"516c7bb3b0fa3dac\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/dailyNoteDefaults.js\":\"3a940318e7aef7a3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/dataExtension.js\":\"95dbbbeb47246e21\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/edgeExclusions.js\":\"05e8261024da29ce\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/filterProperty.js\":\"823f13b91eda63d9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/index.js\":\"d64969e318af0cb7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"28b4a30229e6c14e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/applies.js\":\"9244af2db97c7451\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/countQuery.js\":\"05e3442157bfe7f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/expansionStore.js\":\"dd498f59ea1e60ce\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/index.js\":\"c39032fd69123ddd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"68997beca163e70f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/presentationInvalidation.js\":\"73f17235b1465dde\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/propertyEditorOverride.js\":\"c2fd811c7d5b2058\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/propertyFilter.js\":\"44dab3cb4872cbb9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/query.js\":\"01c24b40edbc1022\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/resolveFilter.js\":\"d116b020acdaf5f5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/sourceBatch.js\":\"9dddc8038f8eda20\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/sources.js\":\"71abe2660e511255\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/useBacklinks.js\":\"d55ad6efdd247b92\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2a172801c7b6bf9a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/BirthdayCelebration.js\":\"4489adab4637f59b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/BirthdayOverlay.js\":\"638a7a6a8d942845\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/gate.js\":\"b9b140dd5a3bb051\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/index.js\":\"5b2344c22af99871\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/wolfTheme.js\":\"2e01ff56407dc0e6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/BlockDragLayer.js\":\"6b94a006970205f6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/dragController.js\":\"eb2dc279e2bf4d4a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/dropTarget.js\":\"eb19e072e308e450\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/index.js\":\"d73456d41e085a5a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/projection.js\":\"c0b64c2e49ec34c8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-info/BlockMetaCard.js\":\"48f0c3b2b1d6a445\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-info/index.js\":\"701990f9d8a93fa6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/AddTagDialog.js\":\"f202dff283263109\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"892223f50eac13c0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/TagNameIssueHint.js\":\"0510889162715041\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/addTagAction.js\":\"ff746c7eb666c994\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/appendTag.js\":\"026a28d3a7684155\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/config.js\":\"11b251b90bd2dad5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/dataExtension.js\":\"f69695d888f1e311\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/index.js\":\"84baf389858650e9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/propertyEditorOverride.js\":\"670479dd968acf0a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/BreadcrumbList.js\":\"dfe2b5a3cf6a3693\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d24ba0a43daf20fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b43889252af67f6f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2efdfbbcb4d21abc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"45eee1f15912b93e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/index.js\":\"5b2362abefc35a58\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"0e9dcf5020157e9d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/CharacterCountItem.js\":\"19ed3baa90b4b7d3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3ed38680db8a8548\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/actions.js\":\"571248422282aff7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/blockType.js\":\"4a43f316d557603d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/charCount.js\":\"5b10c3463714b52d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/dataExtension.js\":\"a25e8ded2d1952ea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/index.js\":\"5a9a2ba2ab28b275\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/profiles.js\":\"24a7861035518d41\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/properties.js\":\"9400c4bef0b903d5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/textCounts.js\":\"0fc8e7dbefb41d9e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/colemak-keybindings/index.js\":\"b426e7e1c97331ff\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/CommandPalette.js\":\"e2e279970ceb4687\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/HeaderItem.js\":\"a6c76caf6a2888f5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/context.js\":\"3db13183fd8c05f9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/index.js\":\"d4b85cba4306bbc3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/selection.js\":\"976b01691d1b4317\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/toggleStore.js\":\"3a3c7a8b99f09b8a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/useCommandPaletteActions.js\":\"526773d27dd4f574\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/ContributorBadges.js\":\"c730d3c6fe963b16\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/author.js\":\"0ee273f70c7919e0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/codeMirrorExtensions.js\":\"cb56e3d497559aa5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/dataExtension.js\":\"e69adb7476d04bf9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/index.js\":\"fe8241d78ff13eb2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/mentionAutocomplete.js\":\"e6cbb4869798bebb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/processor.js\":\"b427442c7f6408a0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/profiles.js\":\"920365927d1f9345\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/queries.js\":\"ede83057bf4c9e4b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/schema.js\":\"69b92a3ea594e5ff\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8a36c080c04f9db1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/followOrigin.js\":\"873a75988c9862ea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/index.js\":\"24f26b35cf035b88\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"67da79c43ff46d05\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7b546773020670f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/CalendarGrid.js\":\"cec1009609df8b19\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DailyNotePicker.js\":\"b0955ed41ca0f0fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"179fd152e19af449\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateNavDecorator.js\":\"de632980a1776d71\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateScrubOverlay.js\":\"6828e813a09874f2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/HeaderItem.js\":\"62efe0dd9ebadfb3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/ReschedulePicker.js\":\"1fbb8a13a60721c7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/SpreadDatesDialog.js\":\"580211a3591c062d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/actions.js\":\"81375e34a5a45722\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/blockDateAdapter.js\":\"b1909fd3b316cd8e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/calendar.js\":\"ed5ff7d6c768c5de\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dailyNotes.js\":\"c029a4bf4ddba723\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dataExtension.js\":\"16ef4a1e776f8dea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubActions.js\":\"3419684d68948288\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubGesture.js\":\"cb77f33dcbb10422\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubGestureActions.js\":\"216aa523a0de6a36\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubRecognizer.js\":\"246f24f8649639eb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/deletionGuard.js\":\"73e95e1b1bffdb7d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dueQuery.js\":\"aada99a28b75ddb1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/index.js\":\"7ca09bba99027aec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/landing.js\":\"fc14987651337636\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/localSchema.js\":\"b973dd7063400891\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/referenceDateAdapter.js\":\"5bb3b9d122dc68b0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/rescheduleAction.js\":\"605fbfe0deda90d1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/schema.js\":\"8d29bdc213a57bd8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/spreadBlockDates.js\":\"e4b0c2cdec1b99ac\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/spreadDatesAction.js\":\"1038a5564aa66cb6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/today.js\":\"762c7478d2f89297\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d71f942ece66a5ee\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9ca3ea72c68209f8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/audit.js\":\"a528fe732783c8be\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/auditAction.js\":\"a5cc830215b22ca2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/auditRanges.js\":\"915fc5d5c56e9a92\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/diagnosticsSource.js\":\"0f75d91749a9e16d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/divergenceScan.js\":\"fce1abbf7f61affa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/index.js\":\"09bab978effb9c73\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7aac338446e43388\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/referencesMirror.js\":\"163625e9b31c2cb1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/rowJson.js\":\"a1cffe8a541aa50e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/schedule.js\":\"cc2d13e395cabfe6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/store.js\":\"329cebbab2ac65d2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/action.js\":\"d6f35fdc1e8fca06\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/index.js\":\"87d433ddf13a8c8c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/plugin.js\":\"51840b5ad1befdb5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"7afa544ed09b6536\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/actions.js\":\"08b36613aa8c10c3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/changeMarker.js\":\"ba7b72a6d81a3c5e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/diagnostics.js\":\"790a13988ae0213c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/fileSystemAccess.js\":\"a4009d89ba4ef5ba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/filenames.js\":\"9d101612c68e7afb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/index.js\":\"ec9d509f0778732d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/mirror.js\":\"ced7de618ae6730f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/runLock.js\":\"87aec00de1b2ad00\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/runtimeHealth.js\":\"6ad314d88c6ef10a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/schedule.js\":\"be0f0f94e23e91ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/store.js\":\"f01d3c5bbd209b8e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/default-themes/index.js\":\"57ac808f5ed6525c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/default-themes/themes.js\":\"0d2f366ad9a03243\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/diagnostics/facet.js\":\"2584d13973c9c036\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/diagnostics/useDiagnostics.js\":\"2adcb1eb9a4202d7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/dismissals.js\":\"394d78f0ec9c4421\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/index.js\":\"31b171ad933fa9f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/status.js\":\"2516ae67f671fc75\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/store.js\":\"d198f47ab90eb19e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"668b67c13582b09c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d598b042ab2719ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/actions.js\":\"910dc562b3d9fd56\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/config.js\":\"f95827b400d08b07\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/dataExtension.js\":\"606c0932081d499c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/effect.js\":\"8977f58e725400ee\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/index.js\":\"2f2f5fc9aa8365c5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d6d72e57e5acdb89\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/useToggleTree.js\":\"96fd481f483549d5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/ExtractTypeDialog.js\":\"8eab149369ac6c96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7fe1633711f5da13\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/PropertyShapePicker.js\":\"fefc53e2f3c926c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/action.js\":\"5b91a198d397b787\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/index.js\":\"828dc5538bfc93cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/FindReplaceDialog.js\":\"184b45172bd97eb9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/HeaderItem.js\":\"be5f71af73199852\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/dataExtension.js\":\"2cfc89bf12bb3337\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/index.js\":\"d0cc04816fb851d9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/search.js\":\"9c6b48b25b4b1d96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/toggleStore.js\":\"f23f475a6945cc6a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/LocationPropertyEditor.js\":\"538781ab7f2ab453\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/MapView.js\":\"742ba2787fe447bd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/blockTypes.js\":\"e9b6cc4757f1f2f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/codeMirrorExtensions.js\":\"19e64d8f630167ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/createOrFindPlace.js\":\"4ffe96d945313170\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/currentLocation.js\":\"0ecad8d4365b220e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/dataExtension.js\":\"9ca4fc2cad8e534b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/geoContentDecorator.js\":\"2035d82b99399dce\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/googlePlacesClient.js\":\"de5b2630e012c42c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/index.js\":\"9927da0e9101800d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/locationsPage.js\":\"0e550def901c0ed8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/mapViewport.js\":\"279df206793f2979\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/pickCurrentLocation.js\":\"1cd2d7fef633abae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/placeAutocomplete.js\":\"d830564b7286a576\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/placeNameCollision.js\":\"ea660f1650b7cbb3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/properties.js\":\"2a08db5376c6932d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/propertyEditorOverrides.js\":\"5e9d5d3d53ef5f55\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/query.js\":\"b095e91c9e94462b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/usePlaceSearch.js\":\"2514d962131f789a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"53f01b4de7dfc791\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"5a36489955dba333\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4883ad510c5c7b96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/config.js\":\"1bc64228bb0cfdb7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/dataExtension.js\":\"fe9807153bd6ec57\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/facet.js\":\"2bcc3f8ffabb5c8a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/grouping.js\":\"fa3cf61c0ef3e93e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/index.js\":\"39e1b35362185704\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"09ec83bca6155ae9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/query.js\":\"8a886d6230833116\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/resolveConfig.js\":\"7b3db0e1a306088f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ba5d54edcbc74c03\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f63bf8910798d2f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/HtmlDocumentContent.js\":\"fceb2a7e7d218e9a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/HtmlFrame.js\":\"425cb0284ed98a09\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/actions.js\":\"e2f416d07190eb6f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/blockType.js\":\"701f70b5db8e64bf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/confirmRunScripts.js\":\"6204024d8cd878b8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/dataExtension.js\":\"3accb3f513767d7a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameAnnotations.js\":\"5283466302a434e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameDocument.js\":\"611e0cbfa2d9629a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameTheme.js\":\"50c6a8c9596813e2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/index.js\":\"7bc11937e46d05bc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/scriptConsent.js\":\"bffe29c1cd4ab6f6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/sourceMap.js\":\"cff27db0b77c9864\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/useDocumentScripts.js\":\"f397b2452ebf93ef\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/index.js\":\"fbde0e2fac50bac4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/record.js\":\"51d7c9df09ebce10\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/recordStore.js\":\"99f66d6312da2923\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/responsiveness.js\":\"6519bd11322d153b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/schedule.js\":\"e566e9ca3b46d652\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/sessionContext.js\":\"8fc3843347fd15f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d742ca48f1dca1be\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"40fbe83d23c5e82b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/actions.js\":\"de16582547cccc31\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/config.js\":\"c29605ed260b418d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/dataExtension.js\":\"0cb5e3d305a99542\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/effect.js\":\"e421e66f73935c2f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/index.js\":\"5dc4e9697eb5edf8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/keyCapture.js\":\"f9dc34abfe07fb2a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/overrideStore.js\":\"3222aba502bac25b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"125f9c5cc7448c69\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/HeaderItem.js\":\"7c53b1240a989f27\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/LeftSidebar.js\":\"4688c27d050aa570\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/actions.js\":\"988feaf21e65944a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/facet.js\":\"0578f8e70c54e5d6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/index.js\":\"4574a8c75d7c18d2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/shortcuts.js\":\"d2fb822e2ebb8fd3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/toggleStore.js\":\"29e2646f9f035e6d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/MergePicker.js\":\"ba56d4046973306c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/index.js\":\"b01a77a1568b912f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/mergeAction.js\":\"38860dd68fac30b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/strategy.js\":\"bb4685ec1ddf0579\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/Button.js\":\"bc3a6bd68c4df398\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"99cc0f33b25935c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/defaultItems.js\":\"493eac782ce970fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/facet.js\":\"5b11509ce9327fee\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/index.js\":\"1f3e9f424e4e785d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fc97b664be305d9c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a870eb31baec5049\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"11a706785b51c94f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c7587396eb78706f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/index.js\":\"1e1b835b446f5f84\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/MoveDestinationPicker.js\":\"338cb035fd47503b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a1bbc9d669847952\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/contextMenuItem.js\":\"01ced20423b6eb19\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/index.js\":\"2d27734569216bed\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/moveAction.js\":\"035bf440b62d6a4b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/moveBlocks.js\":\"410cec50034aed15\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/selectionAfterMove.js\":\"c2fd6cb5bd0e69fd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/TutorialBanner.js\":\"2c7fc407d88722f0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/action.js\":\"03089829d86ba4fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/bannerDismissal.js\":\"bd66183abfef3b56\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/documents/cheatSheet.js\":\"6dc5d66b8bf1d2c8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/index.js\":\"900c03cabc3e626a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/keys.js\":\"9ad5b4b7abc3933f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/landing.js\":\"05e7672b58e38deb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/outline.js\":\"b9dcd184bacc36d6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/seed.js\":\"6a3455e8030abd1f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5d908f40dbe85dfb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/analyze.js\":\"904d5c43588f7523\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/diagnosticsSource.js\":\"3637aad9ed16f9e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/index.js\":\"9a28e037642ba102\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/load.js\":\"3825f0b0df2d2eec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/monitorRun.js\":\"bc4f193edeff3489\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/schedule.js\":\"ee5d43b774c0e1a6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/series.js\":\"9d65a79a7a2d221f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/store.js\":\"f3e23fde68357cae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/trendAction.js\":\"cfe6d7727f5f963c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/verdict.js\":\"136e795212c2e6ac\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/clickToEditAction.js\":\"ea433bd934ae0170\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/index.js\":\"f1537e839aea2b33\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/interactions.js\":\"154260c41e720482\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"088fd92fb679ad76\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/MigrationGate.js\":\"269497ab2f2f30e5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/MigrationGateDialog.js\":\"90721406143f981d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/action.js\":\"a5967eff3adb5cc6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/index.js\":\"582b6e1d67b6cc5c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/localRunMessage.js\":\"5f3561332b0c61cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/plugin.js\":\"2025c4706c80d730\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/progressReport.js\":\"412209feb1f26337\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/sweepProgress.js\":\"9ba51f19fc5923b1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/FieldRowRenderer.js\":\"3082f04e61758dea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/ValueRowRenderer.js\":\"fe6b8f9b10e6f183\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/actions.js\":\"c00c1bc3699edf90\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/autocomplete.js\":\"9fe2baf9e6ccfde9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/fieldRow.js\":\"4d615667ddd415b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/index.js\":\"0c0c7b075860fd72\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/referenceWarning.js\":\"89da484b0642a37c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/valueAutocomplete.js\":\"c601cf0b23fc79ae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/valueSchema.js\":\"34b1387e8d86b76e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/HeaderItem.js\":\"3ea02c2a8804aa85\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/QuickFind.js\":\"dc85ca1d2c812606\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/index.js\":\"eafb7ea57490502d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/recents.js\":\"a58ff3ea112e0467\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/resultItems.js\":\"05c34668aa4e313d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/selection.js\":\"b9c8032cb723ed98\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/toggleStore.js\":\"d280ace8636e17ea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/HeaderItem.js\":\"9b4094cae0f6d764\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/RecentsPageBlockRenderer.js\":\"fcdfca6ae03cef49\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/grouping.js\":\"0d68335d1fc31bb1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/index.js\":\"36bb84f3eef7c86b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/target.js\":\"c58da6ab9ddd64c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/codeMirrorExtensions.js\":\"37c6635044dc0f00\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/contentPrefill.js\":\"41c2209aa5589614\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/dataExtension.js\":\"be178d78d3aceff5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/index.js\":\"0a1daa0a9dcab8e2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a84b42ebf370a416\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/invalidation.js\":\"333de69b65e24379\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/localSchema.js\":\"4a9f3eed24b2f9b5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/blockrefs/index.js\":\"583d25f0609c29db\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"cfb1dd4c29fffd92\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/index.js\":\"f695525238bc5043\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/referenceNode.js\":\"2e48d3cb0fa35e5a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b6c2ab8626697574\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"1453f519b7dc1e93\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/index.js\":\"8665967b4bf88f85\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bffbec47b893f977\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2f5f127d2bbd268e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/mergeRetargetProcessor.js\":\"4f9cf4de91526e10\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/parseFence.js\":\"1fc2d8a768e45f48\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referenceParser.js\":\"6ff7ff7f0b55b2fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referenceProjection.js\":\"12d109d48779cb13\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referencesProcessor.js\":\"1be3dce71d8f474a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/renameProcessor.js\":\"3dd7dad7fc1e9bf6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/spanReplacement.js\":\"fa222a6351bdf560\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/htmlToOutline.js\":\"73e1f69a4230ded3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/index.js\":\"fd5ed99af5916ca6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/normalizeClipboardDom.js\":\"837283c34cb95461\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/pasteDecision.js\":\"fad747647623c861\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/action.js\":\"3318980ea9267595\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/blockIds.js\":\"96beacb101b6062f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/content.js\":\"e1274ff071f07a1d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/effect.js\":\"0f8748dc5c0d7cbd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/ids.js\":\"d00786249a7ea73c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/import.js\":\"5ac08ebb157a7d06\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/index.js\":\"43a58ee2e92a8f69\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/plan.js\":\"a038081c2dee11ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/plugin.js\":\"67d9c647016498a7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/promotion.js\":\"39aeb89e8299a00a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/properties.js\":\"07fac68ebc7786ab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/references.js\":\"a0a62062db97f22c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/report.js\":\"1c2d3774e0580945\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/roamMemo.js\":\"541c61308d969efd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/runtime.js\":\"6fc7fcb4db78229e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/schemaReconciliation.js\":\"196d27c811c2f93e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/srsMarkers.js\":\"895db54de82637ab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/todo.js\":\"0bc3d860f567fcb9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/typeCandidates.js\":\"fe1f02d3e5aae866\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/types.js\":\"2f2a8d2e118585ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/search-health/index.js\":\"65d76e66c28a99af\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/search-health/store.js\":\"960946b40657c2d6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/HeaderItem.js\":\"b31c96f12ab43473\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"bad00993f1dcfc4b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/index.js\":\"734f7d6271ed5191\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/model.js\":\"44eea8cfbb9d8b8d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/toggleStore.js\":\"6a5b80d6e666d0cd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/useKeyInspector.js\":\"e08e863214dc863b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"7cf5dbae7346ad30\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/ShellDecorator.js\":\"14e9dd27d2b1fefd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/actions.js\":\"003c2411ab60c629\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ee2db696cc076be6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/index.js\":\"300291c44eb4542c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/shell.js\":\"4f00f8e1064edeb4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/surface.js\":\"e9d497f094c43565\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/walker.js\":\"5262cd2f6d3828a3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c5d84186f6f56d20\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/dataExtension.js\":\"cbb71101da69237d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/index.js\":\"e1e9d1da3d176c80\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/indicator.js\":\"ea4a1162a5ad6cd8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/moveSrsState.js\":\"0064d8fb974aec34\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f45b3a65795e9d41\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/scheduler.js\":\"ecbf9422e9b381e3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/schema.js\":\"bda783f4639f3493\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"42618f140fe6d97f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/srsClipboard.js\":\"534b1ae031e3715b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"58e686b126d1f0a4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9a9fdce81c5fc73e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/DeckPicker.js\":\"77f31e932dbca3ee\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewControls.js\":\"f21a5332890f1814\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0e5654764d5c66af\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewSession.js\":\"1d2bd756f4a41cd2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/actions.js\":\"d48001ec6e3f52e3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/archive.js\":\"17c5dc72dacf5a98\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/dataExtension.js\":\"4f33c4b954f31707\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/deck.js\":\"77568ad3253ccbaa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/dueQuery.js\":\"fd39817ae8487da2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/gradeDecision.js\":\"f72de8fc6cf50d9a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/index.js\":\"3ebc04254292e958\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/keyHints.js\":\"fc6622239f5f333f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/reviewCardLayout.js\":\"d4a92538c662be84\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/reviewProgress.js\":\"7bc723cc85a05313\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/schema.js\":\"299bdc293c6cb8f1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/useDueCards.js\":\"0bd3d7d5f9fe1c97\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/startup-metrics/index.js\":\"8e4d73d17790938a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/startup-metrics/record.js\":\"5af57712c7178f70\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/index.js\":\"2e4461164fc272fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/persistenceStatus.js\":\"cbb93858b28785b2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/requestAction.js\":\"01bde1df27e8e316\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/TypeChipsDecorator.js\":\"91813f7f4b17899c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/codeMirrorExtensions.js\":\"71b0b0dc997a1eb8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/index.js\":\"50648b17596b8c3c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/typeAutocomplete.js\":\"55141c77c3732c10\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"eed7cd8c21131d4c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/actions.js\":\"1f4949fb4271a127\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/anchor.js\":\"ec5ae3c86a8f6c29\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/events.js\":\"7d79f33f4fbd71c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/gestureActions.js\":\"afb4aafb96e57a14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/index.js\":\"07c20296545a39c6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"69ac13c9d0fcd66e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/collect.js\":\"86151efd8a0cd274\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/index.js\":\"5f90a2f63fecb91a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/record.js\":\"d9c3317af2b719c0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/RejectionDialog.js\":\"32017c690636011b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6f6196dfefd9a8cb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/index.js\":\"10742f7f584c4223\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/model.js\":\"6467bab2ca256bc6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/queueCounts.js\":\"181f80b1f76c9841\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/rejectedHelpers.js\":\"eb6b19f306f89f27\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/rematerializeAction.js\":\"41f092e4e31a5699\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/useHysteresis.js\":\"797f639bb65ca12b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/ColumnHeaders.js\":\"d5994b042861265c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/QueryUi.js\":\"4df3b65c0ba7c46e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/TableLayout.js\":\"61e64a186c35b004\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/actions.js\":\"69fcb1165f7d7337\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/cellEdits.js\":\"7cc4759b8b933886\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/columns.js\":\"f5045adb882b22af\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/controller.js\":\"e576ce82f2bb6ca3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/convert.js\":\"c87dec4389f4fa57\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/dataExtension.js\":\"fb8084f132aae86f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/index.js\":\"2fcfe08516cd2b5f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/keys.js\":\"a146382871c58510\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/model.js\":\"896f113b7b75bd8b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/backfill.js\":\"054cdf955a0cf234\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/format.js\":\"ebe27dc751dbc2d8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/parse.js\":\"ca58f05f922c60cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/queryValue.js\":\"401595eac7f91eb7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/source.js\":\"f00aa288a5f46614\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/registry.js\":\"5040bf1b318d09fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/schema.js\":\"4e74bf06b9dfed71\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/sort.js\":\"29fcd3216bec4309\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/effect.js\":\"e054b8e4658cced0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/index.js\":\"66cf953a101a0700\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/theme.js\":\"a1f0327a021b421d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/actions.js\":\"338967df0906107f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/dataExtension.js\":\"c83d28c985572441\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/index.js\":\"941ca6900c1fc2f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/schema.js\":\"30e09816e8896313\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/TouchSelectionLayer.js\":\"803cd37d79c3e928\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/actions.js\":\"60e071114945ba63\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/defaultItems.js\":\"c73f135ffdd66b9a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/facet.js\":\"4f7e9661a626435e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/holdRecognizer.js\":\"397b2b0acd3fd784\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/index.js\":\"76829c66078dc89b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/UpdateIndicator.js\":\"269ad85e8490d821\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/index.js\":\"2cf13e83a1f35e69\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/loadTimes.js\":\"1cf09acf8aaffebf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoNotesRenderer.js\":\"87d26f4a85c8cfd3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoPlayerRenderer.js\":\"86b264bacf781b95\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoTimeStamp.js\":\"1037bdc58a5b139e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/actions.js\":\"22af3187a0ebca37\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/index.js\":\"952bd34f6b963c4b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/markdown.js\":\"c205eccf812621c5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/notes.js\":\"905cc060d05de133\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/registry.js\":\"7a3d7a8859eba1da\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/remark-timestamps.js\":\"231f5b891a4a30cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/view.js\":\"fe86f71d0a65ddc8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/LinkHints.js\":\"f6f769641793e4c0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/index.js\":\"fb77a83d195d45cb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/model.js\":\"5a1f5c73d7e51c4a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/settings.js\":\"78c9224fd96dcaa8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/actions.js\":\"1b7639b21344fbab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/index.js\":\"a780f8344a5cde2a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/interactions.js\":\"f44606e6b198b7df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/workspace-header/index.js\":\"7ec21951085c8e57\",\"/knowledge-medium/pr-preview/pr-1849/src/registerServiceWorker.js\":\"7ab945a073b319cc\",\"/knowledge-medium/pr-preview/pr-1849/src/requestPersistentStorage.js\":\"1847a9e7932526da\",\"/knowledge-medium/pr-preview/pr-1849/src/services/authRequestDeadline.js\":\"b4c32cef5e0ec1c0\",\"/knowledge-medium/pr-preview/pr-1849/src/services/authStorage.js\":\"da30fb077ae5ca93\",\"/knowledge-medium/pr-preview/pr-1849/src/services/powersync.js\":\"c3412511be4a63bf\",\"/knowledge-medium/pr-preview/pr-1849/src/services/supabase.js\":\"d6a8332ccc7eb383\",\"/knowledge-medium/pr-preview/pr-1849/src/services/uploadErrorClassifier.js\":\"f12f4c59c2845775\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/ActiveContexts.js\":\"308fbca31e5dcdf4\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/HotkeyReconciler.js\":\"a4f53af85b282e98\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/WipeLocalDataDialog.js\":\"4ea2ea551b074a76\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/actionDispatch.js\":\"a2b6c9e430c4d823\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/actionRefItems.js\":\"28886430a26b19fa\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/applyKeybindingOverrides.js\":\"555b2e8f57cff279\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/blockActions.js\":\"e15f66490de290ef\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/canonicalizeChord.js\":\"e52ba3cac51291fe\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/defaultContexts.js\":\"f24d1d60bda0e38f\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/defaultShortcuts.js\":\"07d2e3c29d8a0028\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/effectiveActions.js\":\"489740336ff7e421\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/gestureAction.js\":\"46efb45922e07373\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/gestureBinding.js\":\"897ab30f39d5e5e6\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/holdRegistry.js\":\"08ace96a45b4b0f9\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/keybindingConflicts.js\":\"2cc71ed783d3c105\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/keybindingOverrides.js\":\"b9441632b424a811\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/pointerAction.js\":\"1ee123344353ae24\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/resolve.js\":\"02bc506c246ed84d\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/runAction.js\":\"9b38a86a770b6cd8\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/sequenceMatcher.js\":\"e831481ab2b73e44\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/types.js\":\"e04a81bcb108d5a8\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/useActionContext.js\":\"5128336a14908aba\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/useActionDiscovery.js\":\"21fb72223386a5ff\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/utils.js\":\"6a5be7ef9e555e75\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/bootStore.js\":\"8d67717ee08d7506\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/previewDatabases.js\":\"1ee5845a1f5d2268\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/byteTransform.js\":\"15cdb0017a687365\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/attachmentCleaner.js\":\"2611cd34f0a3dda9\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/attachmentParts.js\":\"d9dd6f9e56d589aa\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/bundleParts.js\":\"c10601e40c21f887\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/bundleRecord.js\":\"9a62dda3530142fd\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/manifest.js\":\"6949891ea50746db\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/takeBundle.js\":\"1094cc52ae18ca42\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/verifyBundle.js\":\"94166ed018642f21\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/cleaningStage.js\":\"89b2800f5ae7481a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionKey.js\":\"5af0e2d350e66404\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionServer.js\":\"67ac27c36347d56e\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/flip.js\":\"bc5c795accd03351\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/flipAttempts.js\":\"33a671977177d0ae\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/pages.js\":\"a332caeb5c03e408\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/preflight.js\":\"d6182c987911da12\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/reseal.js\":\"abc0ede27571b25c\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/runConversion.js\":\"8978b929cca14ebc\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/runLock.js\":\"ffb46ebbc16c8dfa\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/sealing.js\":\"c83dfa7e341d5dc5\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/sealingStage.js\":\"4c6fa2bee2840faa\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/stage.js\":\"a227d7a2729a71ac\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/verifyReseal.js\":\"4a40eacadb6346e2\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/aad.js\":\"763b0e4d1ef49989\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/aead.js\":\"81f2704bfe1772b8\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/base32.js\":\"ed944b2dafe986d2\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/base64url.js\":\"d9745af986e8d75c\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/binaryEnvelope.js\":\"579d55ba10fe36a2\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/byteAead.js\":\"d9a965b3b3281199\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/canary.js\":\"09705dd41463ba09\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/contentHash.js\":\"3d70c74429218237\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/contentKey.js\":\"4377e3946457724a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/derivedIdNamespace.js\":\"c087ca15b4fe3d8a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/envelope.js\":\"0a32bac4a0e033d7\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/hex.js\":\"c7607a7063240456\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/sha256Hex.js\":\"3bf4e7085d017e8a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/workspaceKey.js\":\"6fa60f83774b9916\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/conversionState.js\":\"720eb54b1f4f2613\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e925f63e97765694\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/pastedKey.js\":\"1c64fb33378cb786\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7e83aace197fd9d7\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/upgradeWorkspacePin.js\":\"142c3cfa0d4ea8c7\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/keyStore.js\":\"8e88f736b8fdf6a2\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/mintWorkspaceKey.js\":\"4cec7b6039a43aeb\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/modePin.js\":\"c36824f27865fdb0\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/openWorkspaceKeys.js\":\"5eab957e531364a1\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/resolveWorkspaceEntry.js\":\"f7fc1af8cf9313d3\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/resolver.js\":\"8b2885f2f8166454\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/workspaceAccess.js\":\"a8e2afa8ecea29de\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/transform.js\":\"062509b602d85543\",\"/knowledge-medium/pr-preview/pr-1849/src/themeBootDefaults.js\":\"114a23be95f4a517\",\"/knowledge-medium/pr-preview/pr-1849/src/types.js\":\"fba27fbda7093ffc\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/ClientLocalSettings.js\":\"775a5cdecf982a33\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/abortableSleep.js\":\"23b2aa8b93125076\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/array.js\":\"6c14cd7ba28b82d7\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/backlinkAutocomplete.js\":\"b3e2698516b20dfc\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/blockCrumbs.js\":\"52bb97379222007c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/blockrefAutocomplete.js\":\"92e05910685b5fc5\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/cadencedIdleJob.js\":\"f01f3597f8f2b1b0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/callbackSet.js\":\"991793c27fceec60\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/clientId.js\":\"f7b4a4092e07da52\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/codemirror.js\":\"27a0d1538debfc8c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/codemirrorCompletion.js\":\"3cbb7080c5933b87\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/copy.js\":\"2e601a5953989071\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dailyPage.js\":\"1f4b1964be760e86\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dbForensics.js\":\"936644aeb7388dfc\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dbForensicsHooks.js\":\"d9c2a86552a8a1e1\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/deleteBlockThroughUi.js\":\"130a4b3ab7e9ebad\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dialogs.js\":\"f02a14f205ed66d9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dom.js\":\"903ba5fd801dd4b4\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/downloadBlob.js\":\"02b77d68f5dd20f9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/exportSqliteDb.js\":\"06c7c7a11ddcbe17\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fileSystemAccess.js\":\"6f4c5f10de2e7297\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/flipSlide.js\":\"4d5c701cf3813518\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fnv1a.js\":\"f65782f07c3f2d15\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/formatBytes.js\":\"f5f6eaff65b3313d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fuzzyRank.js\":\"040795a80fe4a713\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/idbKeyedStore.js\":\"43314b9dab99b3d9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/idleCallbackPolyfill.js\":\"d1d6fd6f61418576\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/keyboardAwareScroll.js\":\"942a815403d1763d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/keyboardViewport.js\":\"731b341a9bdef444\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/lastWorkspace.js\":\"c86110a00492e784\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutColumns.js\":\"36d7377269a06ca3\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutSessionDom.js\":\"125bde3d107ecdce\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutSessionId.js\":\"990af9df745fbaea\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/linkClickGestures.js\":\"084acef257f8e67b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/linkTargetAutocomplete.js\":\"baa340fbeb89aa97\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/localDbCorruption.js\":\"70dc8344c3713d04\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/localDbRecovery.js\":\"91867abccb693497\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/markdownParser.js\":\"60cb589a2240b9ba\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/memoize.js\":\"d5e3eca37991dc7e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/nameFieldCommit.js\":\"07cedd584271b321\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/nameList.js\":\"623fd6dc4a993536\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/navigation.js\":\"d8801f1c047057fc\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/omnilinerNamespace.js\":\"69a42d64b3fda39f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/opfsPageScan.js\":\"eaa47ff4be76a03b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelClearance.js\":\"b1fe3079e0425f3c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelHistory.js\":\"da468785a9df36b6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelLanes.js\":\"87255a6e8cb4c726\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelLayoutProjection.js\":\"2ff6e03331bb5b51\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelScrollAnchor.js\":\"5b067a2294eb2c8b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelUrlFlags.js\":\"6d11a5c21f6ad8fa\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/platform.js\":\"5121e43efc224c5f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/pluralize.js\":\"b7729d49d1c255c3\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyCreation.js\":\"f9ad7c539f710500\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyNavigation.js\":\"a3c77fb405ef7e8f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyValueContext.js\":\"7d58734324d7073f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/react.js\":\"0de9d18314e2dffd\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/relativeDate.js\":\"865ffe88ea42e19e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/relativeTime.js\":\"5c1390e109c06992\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/renderScope.js\":\"122e752e51d15c81\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/resolvedThenable.js\":\"936233c863382126\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/routing.js\":\"0f8bdc8e93f0a100\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/safeMode.js\":\"f105c7e3164096a5\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/scheduleIdle.js\":\"56a4d61b71ceec0d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/screenWakeLock.js\":\"55f3dc4ac0bc3cfb\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/selection.js\":\"507fb7c26f0f142e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/softKeyboardGrab.js\":\"1f7670699381efb7\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/startupTimeline.js\":\"dd80ce944ffecb59\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/state.js\":\"3e81482243545f0d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/string.js\":\"11949c3183d54f11\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/surfaceZoom.js\":\"beb3e9e2f2ecac73\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/time.js\":\"e55b44555083057a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/toast.js\":\"92838cc564cbe509\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/toggleStore.js\":\"ba01cb3e839307d3\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/untilStopped.js\":\"bc0fd5570bc13ccd\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/userActivity.js\":\"b48de1b6f6895883\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/viewTransition.js\":\"5f5591f56a50012c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/viewport.js\":\"9a0420824c4431a1\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/webLock.js\":\"30a8780661d9ba75\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/workspaceRecovery.js\":\"1dd9d9f1fbc2c517\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/workspaceSnapshotStore.js\":\"a0d2b0ee4d44353b\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-compiler-runtime.js\":\"c29b9e8c4947fbe7\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-client.js\":\"a7efdf10eb06bf3b\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-server-edge.js\":\"4986036381e389a3\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-server.js\":\"0692c257aeb128dd\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-static-edge.js\":\"0b79e16297a427aa\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-static.js\":\"a742b7bad1e46ff6\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-test-utils.js\":\"a18ed5510165c729\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom.js\":\"796a17ece1e4b79a\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-jsx-runtime.js\":\"ccc506767f3214c0\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react.js\":\"2f3c4f7e0af09bde\",\"/knowledge-medium/pr-preview/pr-1849/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1849/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1849/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
