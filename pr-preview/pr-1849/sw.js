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
		buildId: "62df2d781634-2fc2c021",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/\":\"830341bd253b7f02\",\"/knowledge-medium/pr-preview/pr-1849/index.html\":\"830341bd253b7f02\",\"/knowledge-medium/pr-preview/pr-1849/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1849/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1849/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1849/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1849/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1849/assets/FacadeVFS-CTUZxKpZ.js\":\"7ce2ea4ed2cbd954\",\"/knowledge-medium/pr-preview/pr-1849/assets/OPFSCoopSyncVFS-CLdqY3-Z.js\":\"b59445b4827a448c\",\"/knowledge-medium/pr-preview/pr-1849/assets/OPFSWriteAheadVFS-CTtA_Q1m.js\":\"6355e05a4504078e\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-async-D08pev_M.js\":\"1b73992d4499fe2e\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-vz8waUKe.js\":\"b03de34da6f14e03\",\"/knowledge-medium/pr-preview/pr-1849/assets/worker-DZrcfXSe.js\":\"e2723d0ee3dc82b4\",\"/knowledge-medium/pr-preview/pr-1849/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1849/chunks/app-C1Pwz8kQ.js\":\"1455eb0f0c9a5950\",\"/knowledge-medium/pr-preview/pr-1849/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1849/index.js\":\"3b8dfde2371fb099\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1849/assets/AccessHandlePoolVFS-DreJETfy.js\":\"01f907cbd40a06be\",\"/knowledge-medium/pr-preview/pr-1849/assets/IDBBatchAtomicVFS-ywRrXwEr.js\":\"a6c04e5ac8b38ba9\",\"/knowledge-medium/pr-preview/pr-1849/assets/MemoryVFS-Di6fqy7r.js\":\"0da4807deefc1b14\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-CRjJAkFh.js\":\"563f9d8cb1164b5a\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-async-DSeoc4RX.js\":\"68d831d8cbfbef0e\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1849/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1849/chunks/AccessHandlePoolVFS-BgkU_RJc.js\":\"2af6b79e29330818\",\"/knowledge-medium/pr-preview/pr-1849/chunks/FacadeVFS-DrYKkLRT.js\":\"11ab3025fe619c0e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/IDBBatchAtomicVFS-ByXSPupM.js\":\"9506413806e015b6\",\"/knowledge-medium/pr-preview/pr-1849/chunks/MemoryVFS-DnK3ZYY_.js\":\"a1d892645cc8aa49\",\"/knowledge-medium/pr-preview/pr-1849/chunks/OPFSCoopSyncVFS-D1hesbfR.js\":\"385f0b689bf8d80d\",\"/knowledge-medium/pr-preview/pr-1849/chunks/OPFSWriteAheadVFS-DsbTuMYb.js\":\"d8dd0b1d9ff053a9\",\"/knowledge-medium/pr-preview/pr-1849/chunks/Preview-CvUlYFDz.js\":\"1577627afc609485\",\"/knowledge-medium/pr-preview/pr-1849/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1849/chunks/card-DYO82OP6.js\":\"d82e51de613a86c6\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-BfzIIHBO.js\":\"4b9cd42f3f39457d\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1849/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1849/chunks/mc-wa-sqlite-0IYL4xS2.js\":\"1157dd6ff2df531b\",\"/knowledge-medium/pr-preview/pr-1849/chunks/mc-wa-sqlite-async-D_7oJdE3.js\":\"a28d4feb79e1d771\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-BI2vyna7.js\":\"b25c85b1692710ec\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-BV3k1-UM.js\":\"db68324c7db770fa\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-CRyLdnDI.js\":\"3bb8f74dc90d1d03\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-CUElkvc5.js\":\"33acf76e0711b874\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-CY-giWhr.js\":\"78eab3067bd7bdc8\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-DFh2HrPS.js\":\"c88b00f51ee1c878\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-DYyu3-pg.js\":\"354c82b7a42efdd3\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-DruQC7wF.js\":\"54dd9949cb8784bd\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server-legacy.browser.production-C55x_20g.js\":\"a7ea3485030aeb92\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server.browser.production-DIMRY9AX.js\":\"d2f0413a6b329926\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server.edge.production-D4RfLJFp.js\":\"95b750b601660a81\",\"/knowledge-medium/pr-preview/pr-1849/chunks/server.browser-Bb8x9UIN.js\":\"0493da610649813a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/textarea-D0O8aAni.js\":\"6f71c10a68487b61\",\"/knowledge-medium/pr-preview/pr-1849/chunks/ui-DU1ZcGPn.js\":\"83590bc8869ed67e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/wa-sqlite-async-fqHSP1g_.js\":\"3cbea204c659e45e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/wa-sqlite-wEY6Mp41.js\":\"35504ebac4ec9c2a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1849/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1849/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1849/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1849/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1849/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1849/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1849/src/App.js\":\"f72155a2d26dffd6\",\"/knowledge-medium/pr-preview/pr-1849/src/appUpdate.js\":\"aa44d46f962aa7f3\",\"/knowledge-medium/pr-preview/pr-1849/src/appVersion.js\":\"07b63ff8f878b6b5\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/initialLayout.js\":\"20752b24daee0fe4\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/openWorkspaceData.js\":\"63ef8831b0029572\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/resolveWorkspace.js\":\"9d6fb886f01fc3eb\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/workspaceBootstrap.js\":\"d75e222791697f06\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockComponent.js\":\"762048f0dbd2ab72\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockCrumbs.js\":\"4daabe0573ca5371\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockEditor.js\":\"b87daa2e22f5ccf6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockLoadingPlaceholder.js\":\"a6a69a41ecf28653\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockProperties.js\":\"49b4b5c38c378cb0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockSearchPicker.js\":\"fe82e3b7e4df001a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ConfirmBulkDeleteDialog.js\":\"50cafcbbfc1fa04a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/DividerHandle.js\":\"c00234259ee14349\",\"/knowledge-medium/pr-preview/pr-1849/src/components/DraftEditor.js\":\"55f17987b1a2c92c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/GutterPill.js\":\"6f1910512e9abc03\",\"/knowledge-medium/pr-preview/pr-1849/src/components/Header.js\":\"6b6be69f42e15f59\",\"/knowledge-medium/pr-preview/pr-1849/src/components/LazyBlockComponent.js\":\"bca0b5049afa649a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/Login.js\":\"5ffd4b39c6641c5d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ZoomableSurface.js\":\"15d33e48267385cf\",\"/knowledge-medium/pr-preview/pr-1849/src/components/editModeKeepalive.js\":\"bdffaea67d7bf52b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyDisplay/PropertyDisplayScope.js\":\"38dfdd7cb08400d2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e18698ef4daa6ba5\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/RefPropertyEditor.js\":\"279679fc9dd3da20\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/RefTargetTypePicker.js\":\"7d46062f08c923e5\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/SelectPropertyEditor.js\":\"7d0fe63193c1d258\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/TypesPropertyEditor.js\":\"c1cda6971101d38c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/defaults.js\":\"5aaac570cf42d24e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/kernelValuePresets.js\":\"127e59cb8f0fedd7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/selectablePresets.js\":\"27a39d9f3274fa91\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/typesPropertyUi.js\":\"3ca5b2bb87a0909a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/AddPropertyForm.js\":\"68e209f827c13d8c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/PropertyPicker.js\":\"d52d9e84ed906ce4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/PropertyRow.js\":\"94d191c7e12e3d60\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/Rows.js\":\"72fd29eab5a820ba\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/actions.js\":\"5582ab6beafa2e7b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/declarationOnly.js\":\"fef3bb5cbad56451\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/layout.js\":\"2ec9b6e67c25fcff\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/model.js\":\"e6f369c56b760ac0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/shapeUi.js\":\"78a270ae708d0c4d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/shapes.js\":\"ced297f8efb4b940\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/usePropertyEditingActivation.js\":\"88ff1bc041601bd5\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/visibility.js\":\"b4166f17eb48c1da\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanelSections.js\":\"c9ae3e5b3a0faf7d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockEmbed.js\":\"693e37b5f5fd101d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockLink.js\":\"bcfe79c4c6473e09\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockRef.js\":\"7658b7eb91a70ea9\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/ReferenceLink.js\":\"2517c547a36228be\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/cycleGuard.js\":\"fda6898310747557\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/cycleGuardContext.js\":\"e12692668868a039\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/linkInteraction.js\":\"c269452c193be11b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/referenceLayout.js\":\"f82c73c7f0289bf1\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/useBlockRefAncestors.js\":\"2636f5626814d006\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockGutter.js\":\"29d97f356620429a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockInfoDialog.js\":\"e265f948b658857c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockTypeBlockRenderer.js\":\"7e961753226a9389\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BulletHoverCard.js\":\"dd0bfae5589434ed\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/CodeMirrorContentRenderer.js\":\"e2ee31de558e24b9\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"18deedcbde6511f1\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/ColumnResizeHandles.js\":\"ae02f2ad2ef3f8b6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"226b725e26797bd8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/DefaultBlockRenderer.js\":\"25bb9cdbd05a74e4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/LayoutRenderer.js\":\"394896c2c51afd4d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/MarkdownContentRenderer.js\":\"73da4485ec071a2c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/MissingDataRenderer.js\":\"f2013267ad29258b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/PanelRenderer.js\":\"6ac1bea2c97afbee\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c97310bcbb4fdebb\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/TopLevelRenderer.js\":\"0041c6d077f10b5c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/blockGutterMode.js\":\"97af1596116e29de\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/blockTitleText.js\":\"e1f4d7a89b5c0d18\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/fieldCreationKeydown.js\":\"82dfcd1aba99c6b7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/layoutRootContext.js\":\"21500a89413bf713\",\"/knowledge-medium/pr-preview/pr-1849/src/components/typeChip/TypeChip.js\":\"4553b28b9b30c9a1\",\"/knowledge-medium/pr-preview/pr-1849/src/components/typeChip/chipStyle.js\":\"bd04a58409b68e9b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/anchored-floating.js\":\"6a0469520a1f331e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/button.js\":\"e288430eabece493\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/card.js\":\"88b20b859cd5f368\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/checkbox.js\":\"7597739fa6561e29\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/collapsible.js\":\"51d7d9245f59f925\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/command.js\":\"65cb638de5488a33\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/context-menu.js\":\"fc1ab79aa8c8c0b4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/dialog.js\":\"3e802dcd6089b2c2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/dropdown-menu.js\":\"901d8cc86273340d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/floating-listbox.js\":\"be2a8dc762c209e7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/index.js\":\"cf48a2cf308279b6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/input.js\":\"0112e66967dafc6a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/kbd.js\":\"a19a89fd46673b2e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/label.js\":\"ca00939c14e6d25f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/textarea.js\":\"c47f656a0615c172\",\"/knowledge-medium/pr-preview/pr-1849/src/components/useEditModeYieldKeepalive.js\":\"a5075c6359d7fb3b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/BootFallback.js\":\"7faffe34e7f52ada\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/FocusedRowLazyMount.js\":\"fa9918609734ecd0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/LazyViewportMount.js\":\"c85407ebab2950d0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/LocalDbCorruptionFallback.js\":\"4f0622a98d248332\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/error.js\":\"9bd34b4c224e51b1\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/lazyMountRegistry.js\":\"433f096643d10301\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/suspense.js\":\"0a134370dfac8fa1\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/CreateWorkspaceDialog.js\":\"c3cb38ce2e7580ed\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/PendingInvitations.js\":\"48aa62b88d976aa6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/SyncProgress.js\":\"5014058a314ec915\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/UnlockProgress.js\":\"3544a44ebaeb5b0c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceKeyGate.js\":\"ba55695a32c80b45\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSettingsDialog.js\":\"b46bdc74ecb75a84\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSwitcher.js\":\"4771ce022a37afce\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSyncGate.js\":\"8f3d3c94a8f264d6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/ConversionFlow.js\":\"5e9c476f97955ae3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/ConversionFlowHost.js\":\"715d3282b4a04379\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/EncryptionSection.js\":\"f036126332572b6b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/attachmentPrompts.js\":\"57461406b2230c99\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a9a74fa9c4ba07cd\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/conversionFlowDeps.js\":\"3599e94929114a5e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/conversionFlowStore.js\":\"8f525ecb32deb32c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/flowUi.js\":\"ac0937528fc17bf0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/useConversionRun.js\":\"46315403ea976319\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/keyUi.js\":\"37b0042573c0208d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/useCloseOnKeyLoss.js\":\"c9237f4959258be0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/useCloseOnServerE2ee.js\":\"47e923be4fff115a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/workspaceUnlocked.js\":\"a204111401c427ba\",\"/knowledge-medium/pr-preview/pr-1849/src/context/backgroundSubtree.js\":\"03f468dd86ab177d\",\"/knowledge-medium/pr-preview/pr-1849/src/context/block.js\":\"bb3137ec95609986\",\"/knowledge-medium/pr-preview/pr-1849/src/context/layoutWsContext.js\":\"69fe42d5f54bb195\",\"/knowledge-medium/pr-preview/pr-1849/src/context/propertyDisplay.js\":\"da117a90c6ad2781\",\"/knowledge-medium/pr-preview/pr-1849/src/context/repo.js\":\"909416978711e850\",\"/knowledge-medium/pr-preview/pr-1849/src/data/aliasClaim.js\":\"1b19983971c8f70b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/aliasSeatNamespace.js\":\"88961c88d31d6ed6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/blockData.js\":\"2d4d84ecb9f26577\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/blockType.js\":\"3ac8d102adc56f6d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/changeScope.js\":\"74f03b1c4108731b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/codecs.js\":\"1879d13156f55625\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/derivedData.js\":\"02bf8ececb5d87ac\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/errors.js\":\"ca120e946fca4ad2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/events.js\":\"2b046fbd74b813d2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/handle.js\":\"7f5eb309b835e7f2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/index.js\":\"d1bc77ac299bf885\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/mutator.js\":\"4b1add677bb5fd34\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/processor.js\":\"6e223f9ad844da59\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/propertySchema.js\":\"fcf22c3160bddd75\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/query.js\":\"7e8ca33a39470082\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/sameTxProcessor.js\":\"354a9c6f4795426b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/schema.js\":\"7f5eb309b835e7f2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/tx.js\":\"7f5eb309b835e7f2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/typedBlockQuery.js\":\"7c4101cb00794cd1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/user.js\":\"215dba44f4e9fcd0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/valuePresetCore.js\":\"54064e16e1dedfa7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/valuePresets.js\":\"328bbda930049354\",\"/knowledge-medium/pr-preview/pr-1849/src/data/attachmentCleanerIOVerb.js\":\"502a8d77b640687a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/block.js\":\"71324aa3831c75f5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockCache.js\":\"3f02516df38c12cc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockId.js\":\"e8ea40c60289dc90\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockLiveness.js\":\"f95ad5f7e9050336\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockMerge.js\":\"e02c9eda7ee4b238\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockSchema.js\":\"6016ae69a4230b7c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockTypeLookup.js\":\"2304fb57d5000b53\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockTypes.js\":\"ee8e7d4b965373f8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/clientContext.js\":\"bd309aa55f9d8ada\",\"/knowledge-medium/pr-preview/pr-1849/src/data/dbFileSiblings.js\":\"75b24649891d6ee7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/definitionSeeds.js\":\"3d7ccac53ad1435c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/derivedIds.js\":\"a407ca79ff835c38\",\"/knowledge-medium/pr-preview/pr-1849/src/data/drawnSubtree.js\":\"6eaf3f5e3f657986\",\"/knowledge-medium/pr-preview/pr-1849/src/data/facetBridge.js\":\"82ef0ba9d9093e8e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/facets.js\":\"4079fff77a451d17\",\"/knowledge-medium/pr-preview/pr-1849/src/data/globalState.js\":\"7d243d06586dfef7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/aliasClaimRederiveProcessor.js\":\"a483bf61d5d0d63b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/ancestorBatch.js\":\"8cc11a0f9e93e434\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/blockTypeTypeifyProcessor.js\":\"267388692ef7a373\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/clientSchema.js\":\"b47479d4326b6068\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/commitPipeline.js\":\"672517aa720a2029\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/devAssertions.js\":\"db887df8f2c4c1f6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/firstSync.js\":\"86a3971e4fc4d35a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/freshInitialLoad.js\":\"dd2b6c219d96586a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/graphBackfillClaim.js\":\"937cfe059c35325e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/handleStore.js\":\"ce55b2461339f0a2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/idleMarkerJobs.js\":\"a0424f4691810310\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/initialDownload.js\":\"536cac9736380485\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/initializeClientDatabase.js\":\"c5f06b8b51620c8b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/jsonCanonical.js\":\"c601140218dda506\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelInvalidation.js\":\"50be4e8f4d4513ae\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelProcessors.js\":\"cc62d40aa27d950b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelQueries.js\":\"fe5c52024575cdde\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/mergeTypeMembershipProcessor.js\":\"ffc938d63980ec23\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/normalizeReferencesProcessor.js\":\"4d62eb21ff8b33cc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/poolInstrumentation.js\":\"8fa82c48c06853f5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/processorRunner.js\":\"84b12e7f221f9593\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyCellBackfill.js\":\"de4e258baa154d7a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyChildMint.js\":\"c8bce816a05d56cd\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyChildrenProcessor.js\":\"54cd9a13da363bb4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8155478aa92c775f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyDefinitionSynthesis.js\":\"7d9e2f53263e5085\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyKeyScan.js\":\"9b0261bd917d08b9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertySchemaResolution.js\":\"6b926e0c7a0657a5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyValueEdits.js\":\"a5e4ddd27379787c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/raiseProtocol.js\":\"253c3a6721596118\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/readBatch.js\":\"872a3ca36970d504\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/refProjection.js\":\"07b03f1ae714f28f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/referenceTargetLookups.js\":\"ed0068c4cc512772\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/referenceTargetProcessor.js\":\"7d1132899dc133a9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/replayMerge.js\":\"165b6084eb7fe56b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/sqlBinds.js\":\"383f034f8f7dd167\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"dc923e1bfea6637a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/arrivalProcessors.js\":\"41bffc3dc3beef8e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/invalidate.js\":\"7df19cd3e8468478\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/materialize.js\":\"3777519e397579af\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/observer.js\":\"a5fb1afd2298bd69\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/reconcile.js\":\"51e58e08a50d7b45\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/timingMetrics.js\":\"70c8568e1632712b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/treeQueries.js\":\"b3ecf83afad189f5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/txEngine.js\":\"df505f7808dfbb26\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/txSnapshots.js\":\"bed0774f711184d6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/typedBlockQuery.js\":\"86ce7f953066f546\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/undoManager.js\":\"9c53b0417f0c9d0d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/invalidation.js\":\"3d25f8eda935b0d9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelDataExtension.js\":\"24b11ce609754efb\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelPage.js\":\"a92d9db89fbaf8cf\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelValuePresetCores.js\":\"b8b60d7ee58dc500\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbCorruptionSignal.js\":\"dd61cab564c3f673\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbStorage.js\":\"d8b63d07f5671ed7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbVfs.js\":\"445c42c056ac7d96\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localSchema.js\":\"700ea731b3d6558b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/maintenance.js\":\"fac9c3e6471e1780\",\"/knowledge-medium/pr-preview/pr-1849/src/data/mergeProperties.js\":\"a826e129cecda9b1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/metricsConsoleHook.js\":\"262da2c31731c109\",\"/knowledge-medium/pr-preview/pr-1849/src/data/migrationsPage.js\":\"bfbdab6c0bdf025b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/mutators.js\":\"88b48d955fd6cadd\",\"/knowledge-medium/pr-preview/pr-1849/src/data/orderKey.js\":\"6801c5ee3f45e9b6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/orderKeyPlacement.js\":\"0af632777e368bb1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/outlineSurface.js\":\"bb7e0fc8112b643b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pendingEditorContent.js\":\"a4072545202fdae8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pendingUploadsSql.js\":\"a805df72e99c436b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pluginStateExtensions.js\":\"50019372140bdf99\",\"/knowledge-medium/pr-preview/pr-1849/src/data/powerSyncLogger.js\":\"6b3f0b899fe93a20\",\"/knowledge-medium/pr-preview/pr-1849/src/data/projectorRuntime.js\":\"052f299ccc8e72a8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/properties.js\":\"ccfe107f5ca8f40d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertiesPage.js\":\"e79973a9c45cfc0a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyChildren.js\":\"66fbdd7eeba13081\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionFanout.js\":\"970cf21f3c6979c2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionMetadata.js\":\"e46e7602c7aff7f5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionRegistry.js\":\"97d4445143032cee\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDisplayMode.js\":\"f3c211ae776b5a40\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyRowCreation.js\":\"47fdcc3129b4ce9b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertySchemaCreation.js\":\"4768ec7aba7e4f37\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertySeeds.js\":\"dd2eee6f5c523d83\",\"/knowledge-medium/pr-preview/pr-1849/src/data/recentsPage.js\":\"0819471a49cfdf76\",\"/knowledge-medium/pr-preview/pr-1849/src/data/referenceBlock.js\":\"f88a0c636f19755d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/rejectedUploads.js\":\"98babe6483d906c8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/releasePowerSyncConnection.js\":\"f7e6cdf5411ea66d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/repo.js\":\"a61507a9ed1a7bf0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/repoProvider.js\":\"7b0ab3ff1e8c2fdc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/rowProperty.js\":\"c6be3ece30812d0b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/searchFilter.js\":\"706ba23f6404d227\",\"/knowledge-medium/pr-preview/pr-1849/src/data/seedIdentityLedger.js\":\"33c09e30684655e3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/stateBlocks.js\":\"f092488c846d5a02\",\"/knowledge-medium/pr-preview/pr-1849/src/data/structuralEditPolicy.js\":\"b1d8bc7f2c93aab1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/subtreeDelete.js\":\"46acff76f3bcfa9b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncStreamLock.js\":\"01457efd658d0040\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncedTableSqlRecognizer.js\":\"46c7c87f62054a1e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncedTableWriteGuard.js\":\"f02003b6b4e6c323\",\"/knowledge-medium/pr-preview/pr-1849/src/data/targets.js\":\"f7d3db286d3e3750\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeColors.js\":\"354bd8eb43c01317\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeDefinitionMetadata.js\":\"45e1029ffb1b7917\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeDefinitionRegistry.js\":\"fb42417ca345e712\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeExtraction.js\":\"4465e131cef021c5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeInitialValues.js\":\"097df7231a39d212\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typePropertyGroups.js\":\"515e0c966acd4127\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeSeeds.js\":\"c6d2ebbfc7806553\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeTagger.js\":\"7ff00359127681e8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typedRecords.js\":\"ddb5211f24cfd1d3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typesPage.js\":\"b42b23828f71f609\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userPrefs.js\":\"a67bc2c64a3930dd\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userSchemasService.js\":\"409ee31fba133992\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userTypesService.js\":\"287b95a304c9c5bb\",\"/knowledge-medium/pr-preview/pr-1849/src/data/valuePresetRegistry.js\":\"8a10502f0a9680f9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/visibleChildren.js\":\"46ed96976cddec39\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceConversion.js\":\"eaadc1eda55e8ea0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceFirstSync.js\":\"a13609bfdbda64fe\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceIdNamespace.js\":\"a2894fc3ee73c670\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceSchema.js\":\"f06952ffdf3afa7f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaces.js\":\"4a0c4787cce89f96\",\"/knowledge-medium/pr-preview/pr-1849/src/data/writeAheadLog.js\":\"ff37057795acc139\",\"/knowledge-medium/pr-preview/pr-1849/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/BlockPasteShellDecorator.js\":\"c5def31352a5a39a\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/atTrigger.js\":\"caa0a075e5fdf598\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/autocomplete.js\":\"c54279aae74a7921\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/codeMirrorExtensions.js\":\"c1287780c0e7faa2\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/contentFlush.js\":\"b6ae2b75fdf2ac67\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/defaultInteractions.js\":\"9a0996c23c1f83d0\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/editSettleSignal.js\":\"0eb9c37b2cf3ce1f\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/insertImage.js\":\"c6d9d399d2783ab9\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/referenceCompletionRange.js\":\"ee0ef66eaaeef495\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/referenceTargetTypes.js\":\"1ca1af5d3662a2c5\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/syntaxContext.js\":\"5231503eb306e31c\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/triggerMatch.js\":\"49af4b26ec6e2341\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/AppRuntimeProvider.js\":\"ca3894ad6fc311cb\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/BlockFocusShellDecorator.js\":\"aef4555a5ed04c5c\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/ExtensionRenderBoundary.js\":\"3a9197d19f8d1585\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/PanelContentRecovery.js\":\"34f8b002c83aceef\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/apiCatalog.js\":\"b82eb8c4060cabfe\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/approveExtensionHere.js\":\"649768c012a9582f\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/armedCutAppMount.js\":\"bc7f75ed4b94ab02\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/batchableKeyedStore.js\":\"f1edfa1edc79481e\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/blockInteraction.js\":\"82df44231714185c\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/blockSelectionAction.js\":\"f20bca619b64d36e\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/compileExtensionModule.js\":\"f1fe2c17369a6683\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/compiledModuleCache.js\":\"db55f6c1b4ec3a91\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/continuousGestures.js\":\"f42b78412dadf485\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/core.js\":\"d9246b61dd68090c\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/defaultRenderers.js\":\"6e73dd9a22efc4a4\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/definitionFanoutAppMount.js\":\"ff1a140e0e8f7696\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dialogAppMount.js\":\"c8041733d19f44a8\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dynamicExtensionSeeds.js\":\"ee0fea8d39bd9ae6\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dynamicExtensions.js\":\"46f598ba818ba592\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/exampleExtensions.js\":\"c60d195cc6bf0a38\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionApprovalStatus.js\":\"4e10781249569686\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLoadErrorToast.js\":\"91d32adfcd58b220\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLoadErrors.js\":\"e794d15b4b57fb4f\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLookup.js\":\"27bf7da211473aeb\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionToggles.js\":\"96c8e748e9fea36e\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionUtilitiesCss.js\":\"3848cf5d3bd36575\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/kernelPageDeletionGuard.js\":\"ec11a19aee6dbba1\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/liveRuntime.js\":\"54928e9db08c8689\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/openExtensionsSettings.js\":\"de6797d24ead542b\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/overridesCache.js\":\"e780aefaf1f07f8c\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/pluginIds.js\":\"aa157a61902b7942\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/processorRejectionToast.js\":\"881d82e2ee9d21b5\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/runtimeActions.js\":\"08e3c507bf5b0627\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/runtimeContext.js\":\"e2fd2f07439bac37\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/staticAppExtensions.js\":\"dc4ef65a02df08c9\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/staticDataExtensions.js\":\"006e49da002e9aa6\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/toastAppMount.js\":\"38c18bb694ea1503\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/useOverrides.js\":\"7691590981a7ab1f\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/useShortcutSurfaceActivations.js\":\"7276ae4e3b972eb8\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/discoverToggleTree.js\":\"bef620e76282770b\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/facet.js\":\"aa01abd4890f0ed9\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/resolveAppRuntime.js\":\"d327b798b7dbaf88\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/runtimeEvents.js\":\"ebd7e046c215ea0a\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/togglable.js\":\"1f52d5a943200d19\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/variantFacet.js\":\"97bd008cb07146ff\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/verbFacet.js\":\"d4e17fd84d1a21e4\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/block.js\":\"3005192e2300d08c\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/focusedChild.js\":\"9420f1b494d8fac1\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/propertySchemas.js\":\"4fa04f24b995e521\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/typeRegistry.js\":\"261931c3eab3f0c7\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useAncestorCrumbs.js\":\"381a3e14c1cccea1\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useAutocompleteListbox.js\":\"825643975720ee29\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useDebouncedSearch.js\":\"a978ef8364c2bee4\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useDebouncedValue.js\":\"ab2ce2030c6d6007\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useIsFocalRender.js\":\"82514bce2934b172\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useIsReadOnly.js\":\"787ffe950beebe62\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useMaterializeBacklog.js\":\"5a991bad6386aa05\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useMinuteClock.js\":\"1cb7ffd80c9fe468\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/usePanelLayoutProjection.js\":\"fa9ed869659bf142\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/usePendingInvitations.js\":\"8e040817e8a0b6c1\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useRendererRegistry.js\":\"dc518a147c8b6a1d\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useRetainedFieldRows.js\":\"2ab9f75f9ccce028\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useWorkspaces.js\":\"d9680af44461244a\",\"/knowledge-medium/pr-preview/pr-1849/src/lib/utils.js\":\"858973aaaa716548\",\"/knowledge-medium/pr-preview/pr-1849/src/main.js\":\"546b8103152dc1f7\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/MarkdownImage.js\":\"fae9a0604f049682\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/blockSeparators.js\":\"926ab2020f329ca9\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/context.js\":\"4d7c843e6d22931e\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/defaultMarkdownExtension.js\":\"630ddd63286e0132\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/extensions.js\":\"2cc2a2343af1646c\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/renderMarkdownHtml.js\":\"2dfadf4222fa752a\",\"/knowledge-medium/pr-preview/pr-1849/src/minimal-editor.js\":\"8336e0be2136e603\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/armedCut.js\":\"e828c4d3239a8f71\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/captureMediaVerb.js\":\"f6d4337340243d1a\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/clipboard.js\":\"81766deb0161f0e5\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/decision.js\":\"26d6fd25fa913c97\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/operations.js\":\"171d5eeff47d9412\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/account-header/AccountHeaderItem.js\":\"f6d25694d4e4dd92\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/account-header/index.js\":\"43fc1d2aa3de57a0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"449f98603f5b038d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/askAgent.js\":\"16336b7d2739f4c2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/askedStore.js\":\"7118b6db4246df1e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"95d89c5db02d1e4f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/chipState.js\":\"434354c6ca55fc8f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b30bea1e2353a3fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/index.js\":\"9cde68a29f18cd78\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"f20a226d0e2fbed7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/schema.js\":\"6cd97c4fbd2cc8c1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b5764fbf3b990550\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9e87b648aecf9e45\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/addMedia.js\":\"97c1dd5ae8060954\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/backlinks.js\":\"32ccd52ac2f62921\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/block.js\":\"633bf25795849f9d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/context.js\":\"ed63e444b6ff4827\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/displayIds.js\":\"593dd2a475c2673a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/index.js\":\"8d39b77cc394f133\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/outline.js\":\"680e84dcdd7e0871\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/properties.js\":\"ae62c998dedb99a5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/refs.js\":\"4445a65614eb3dc5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"609aa209de2537df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/search.js\":\"083f25bf53446593\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/shared.js\":\"24c70d46a39ce6d1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"de371f38d2a0e8ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/text.js\":\"518b3c582810dd51\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentWrites.js\":\"7768daf838195fac\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/authoringCatalog.js\":\"d1a7547920e45c6b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/blockRefTargets.js\":\"d58930564df21d5d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/bridge.js\":\"64244cee274022c6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/bridgeLoop.js\":\"8251cd1adf611497\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/changeHistory.js\":\"9792fdb9350e7055\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/commands.js\":\"5dd186f25ba16e66\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/commentsCommands.js\":\"e654406dab9679fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/dataExtension.js\":\"4dc11493d7ec062e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/dataModelGuide.js\":\"89400d6beba32f4f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/describeRuntime.js\":\"cb1925654d7521b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/extensionLint.js\":\"9b19dcf401bdecb7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/grainAudit.js\":\"08ab81406fbd234f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/healthCommand.js\":\"b2fba26d570eb9e6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/index.js\":\"360b9ff0d30a2646\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/presetIdentity.js\":\"8b343a0c725fc454\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"674a3918f006b050\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/readMedia.js\":\"413bcb902a96f2b7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/schema.js\":\"3866f04befacd857\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/serialization.js\":\"f2b133ed32a9281f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/targets.js\":\"befc40e6b287db63\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/tokens.js\":\"f338b50e970f3da1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/watchEvents.js\":\"9824b9d46eacbc4f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/workspaceGuard.js\":\"bfc8b6fffaa5b430\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/writeCommands.js\":\"493dba38490812d4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/AliasCollisionToast.js\":\"332f6886c1ebed99\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/DuplicateNameBanner.js\":\"60c83a1260c4ffd5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/collisionMerge.js\":\"dc78da0041c67eff\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/dataExtension.js\":\"9dac796d45ce70b6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/index.js\":\"87c6bfa0641801ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/mergeCollisionAction.js\":\"6b59ea879475d367\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/pageStyling.js\":\"79ec4537913c24aa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/rejectionToast.js\":\"a40d10e2d324bf57\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/syncProcessor.js\":\"c7878bf731b593bd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/actions.js\":\"a7a714d2a1dfca5e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/addComment.js\":\"3f4a9a7f59aea66a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/anchor.js\":\"f869d8858ea4c8e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/anchorState.js\":\"2a6d38ab194779c1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/commentLinks.js\":\"9278eeab8d00fa54\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/confirmThreadDeletion.js\":\"216fdbcccfb5af8d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/container.js\":\"9d62738ad7417a59\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/dataExtension.js\":\"5eeeec221dd5f40a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/deleteComment.js\":\"fcf0cff70acc1c13\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/highlights.js\":\"9080227267206142\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/index.js\":\"7e6261b0286bb928\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/linkedCommentsPill.js\":\"8e2cf28a07e2102e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/margin.js\":\"5874b85f7b3860d8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/marginSchema.js\":\"b19c782be3823ba3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/newComment.js\":\"e73ea4ea85bf84c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/ownThreadPicker.js\":\"dfa95450b5540ec6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/placement.js\":\"7fee093fd156cc3d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/queries.js\":\"0337f8178f0a70d2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotePosition.js\":\"ff99db5c9fee5176\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotedIn.js\":\"24af654bcd22f3a3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotedRange.js\":\"c7d42fbcc82fc326\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/rangeRefs.js\":\"5b67f32d6cf06cbe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readHighlights.js\":\"83629620d9ab8cf1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readSelection.js\":\"7949f3c30c981dd0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readSelectionUi.js\":\"7a5159624455e519\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/reanchor.js\":\"05bbf53db4b6c680\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/schema.js\":\"382e5d32757db1d3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/scope.js\":\"94e680de17fe5f64\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/scopeThreads.js\":\"ee986c19f84075a8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/splitRetarget.js\":\"791ad9ebdad6e0e6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/suggestionCard.js\":\"f2fee51ae6da8f34\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/suggestions.js\":\"9832b6912c56abb2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/summaries.js\":\"7693ff365eaab60f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/summaryBatch.js\":\"f48fd2b72833f3d6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/surface.js\":\"82496f73e22d3078\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/threadNavigation.js\":\"dade3f89acc697bf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/threads.js\":\"7790f9a6ff484797\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/ui.js\":\"8a5ab686ee5e42ee\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/uiStore.js\":\"a0cf96bc71f53a60\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-intents/appIntents.js\":\"39718d30b2ffc5d8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-intents/index.js\":\"ded5da8edb0168ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-update-prompt/index.js\":\"ea5cac4182ac8dd1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-update-prompt/status.js\":\"0e12f0eb0c2fd99d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"8e31d3c650bd7afa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaBlockRenderer.js\":\"715b57d9d2c43a23\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f48b6afb46326179\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaUploadReconciler.js\":\"e4cda929f9428af5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetDownLane.js\":\"1a7f455b9224b508\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetResolver.js\":\"503940abcdfa028c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetUpload.js\":\"4e22b31e7ba32a82\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/attachmentCleanerIO.js\":\"7a928cd5e94cbd3c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/supabaseAuditIO.js\":\"94f8803c71d9c1e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/blobStore.js\":\"2639676288516f01\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/byteStore.js\":\"ef1dc22682ba1aeb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/cleanerIO.js\":\"1bab0431c515d004\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/cleanupAttachments.js\":\"351084389e664d35\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/dataExtension.js\":\"6d154d97c1baac32\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/downLane.js\":\"3a43003c6766aac9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/index.js\":\"e422475c2298de3e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/insertImageContribution.js\":\"31383f88f509a092\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/laneArming.js\":\"5d6c884accdb0326\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/laneLock.js\":\"4c28471c0e16df7b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaBlock.js\":\"98e40a5912184df3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaCapture.js\":\"771842f4dce48380\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaViewers.js\":\"d8dc056b352c8efb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaViewersFacet.js\":\"ebba8dbc1ea6d4fb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/pasteCapture.js\":\"0034bb95eb209ff7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/resolver.js\":\"6703a332b1034efd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/retryUploadsAction.js\":\"dfb678f7140f9565\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/storagePaths.js\":\"e1daa9810115e8ce\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadDrain.js\":\"bb7387fb485b1543\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadLaneStatus.js\":\"a54d4132cbdceff2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadReconcile.js\":\"e2ae5ac1caaca7e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadRecovery.js\":\"e8590eb8ebeed02c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadStore.js\":\"04772e19e3a5b7e2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/useAssetObjectUrl.js\":\"684a9cc5e0da85d0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"11e2d8775713b508\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/BacklinksViewSection.js\":\"010d0b727eb39ab7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/facet.js\":\"4be76463f599b839\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/index.js\":\"a63618b809955742\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/prop.js\":\"3ba846fb132d7c23\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BacklinkFilters.js\":\"9eeaf0fa5dc7d7e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"0016b36b119e5f90\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BlockEntry.js\":\"d5bc31c6f02c8069\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/LinkedReferences.js\":\"32818becb2b12054\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"d9056c6682fb0120\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/dailyNoteDefaults.js\":\"8b1fbcc0be565b73\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/dataExtension.js\":\"f9bbef1d227b092c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/edgeExclusions.js\":\"787c7a72f981d2d0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/filterProperty.js\":\"21a0c6bb63834043\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/index.js\":\"994f1cbe03c1ca6c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"202b661307773f14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/applies.js\":\"7af0a975ca1e2902\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/countQuery.js\":\"aabeade5119ca13e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f695dca68f0f0a0d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/index.js\":\"93d8b041c2751b8b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3464a88c9b9b5192\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/presentationInvalidation.js\":\"e072f455b27f8934\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/propertyEditorOverride.js\":\"478ce3fb860cb608\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/propertyFilter.js\":\"0d220e308018523c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/query.js\":\"ec69503102a80edb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/resolveFilter.js\":\"43f9337c3dc0a95b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/sourceBatch.js\":\"47a5a20226be4199\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/sources.js\":\"890f7541f6558d3e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/useBacklinks.js\":\"6d9360c6d2991826\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"90f197d99e776719\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/BirthdayCelebration.js\":\"3c46d8f40b8a8c9d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/BirthdayOverlay.js\":\"d6cb82b9acf5f48e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/gate.js\":\"33d5dc3f9c74772b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/index.js\":\"c326ce6385e7c6a6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/wolfTheme.js\":\"c39348d03c8db799\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/BlockDragLayer.js\":\"e986b7bf58b070f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/dragController.js\":\"53b3604d78c2293f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/dropTarget.js\":\"224bd4662774bb6f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/index.js\":\"02b50e97249eff30\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/projection.js\":\"6c628e4ff603484b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-info/BlockMetaCard.js\":\"495abd746f706790\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-info/index.js\":\"6d2bf6f761bac9ba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/AddTagDialog.js\":\"3e9099d3bf786fb8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d03d085387d67c19\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/TagNameIssueHint.js\":\"997e5a8a9752e6cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/addTagAction.js\":\"d2fb1d88cfac10a7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/appendTag.js\":\"56cd280c3132ecfc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/config.js\":\"98d55ab2f6c6b989\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/dataExtension.js\":\"ddb7af9fe87a4aef\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/index.js\":\"86848c2b8b666f43\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/propertyEditorOverride.js\":\"ba4a75d1b88c35b0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/BreadcrumbList.js\":\"94ffa22dce72aa1e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f6cc70e64b67b76c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/Breadcrumbs.js\":\"945d71dae32d97c5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"77e0c8e42cfb98ad\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"82c0f5df792b6b0b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/index.js\":\"9141dd1ca2504af7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1629f330695ed8d4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/CharacterCountItem.js\":\"0042c3381899f786\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b83e01f0c87adbe6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/actions.js\":\"5abeb175c5853509\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/blockType.js\":\"f83222aaee7ae88c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/charCount.js\":\"2763c7bd4309117f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/dataExtension.js\":\"3cf7b0af9adb41df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/index.js\":\"e136cb51f28679c5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/profiles.js\":\"78a7fce0fd4dbb03\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/properties.js\":\"7f812283259d357b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/textCounts.js\":\"5955ad9efbad3839\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/colemak-keybindings/index.js\":\"c57059c7987ccf91\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/CommandPalette.js\":\"5cd2e8a210f1ad3c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/HeaderItem.js\":\"f4e86968b3b25faf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/context.js\":\"b85abd4ad8f3c003\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/index.js\":\"7a4e0240aaefdd8c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/selection.js\":\"fd6c90b8fbc85d34\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/toggleStore.js\":\"8d8d87695629147f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/useCommandPaletteActions.js\":\"aa1cb66235f9a2ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/ContributorBadges.js\":\"156033b83c63e993\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/author.js\":\"69089b09dd1758da\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/codeMirrorExtensions.js\":\"f7fd4570139b864c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/dataExtension.js\":\"0a28c61c386fb756\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/index.js\":\"eff8fbeb3372905c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/mentionAutocomplete.js\":\"fad3062fb77d9055\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/processor.js\":\"e4f8b368d81eb694\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/profiles.js\":\"0753f3ee89473f3e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/queries.js\":\"a5c2846ec69a0175\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/schema.js\":\"1abd635bc9b1d16b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"746b345835bb1d42\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8781f8177b532d5b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/index.js\":\"2fb9f115428371bd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3e5ec999df7c9ffe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"bf2cfc10312f159d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/CalendarGrid.js\":\"53cd82d127602347\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DailyNotePicker.js\":\"52e418b8a37bfb50\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"718847c4a3d1da1d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateNavDecorator.js\":\"8241c93e4b90c2ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateScrubOverlay.js\":\"976e3df77714964c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/HeaderItem.js\":\"6edf4bf67eae2b87\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/ReschedulePicker.js\":\"d63f0ea479fde02f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/SpreadDatesDialog.js\":\"81f6c79c3921dd97\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/actions.js\":\"36b9f620592ddd09\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/blockDateAdapter.js\":\"711a7ad972c5d556\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/calendar.js\":\"5c0a563a86dfd032\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dailyNotes.js\":\"a31a45b59c8816e0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dataExtension.js\":\"f64de16ab13efc4b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubActions.js\":\"e325fa05219454a6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubGesture.js\":\"1b7727608e2476b1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubGestureActions.js\":\"87d2484473d67e89\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a7af1e5c5962ab8b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/deletionGuard.js\":\"111186671eb50099\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dueQuery.js\":\"31749828ae18a7ea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/index.js\":\"f873df561225feaf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/landing.js\":\"2141a838f3a28b53\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/localSchema.js\":\"b368470949cdf6a3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/referenceDateAdapter.js\":\"8a3485286f22f66e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/rescheduleAction.js\":\"57f42c521befb148\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/schema.js\":\"e0b405a0e419ca54\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/spreadBlockDates.js\":\"e69cc0676be6f8fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/spreadDatesAction.js\":\"76c9b40689a4295a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/today.js\":\"413915ab2885b2a8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c190d876bdbd5229\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ef42d2dcf7854bb6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/audit.js\":\"74359ff6bbbfc3df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/auditAction.js\":\"c36ce48f60b3ebfe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/auditRanges.js\":\"220241362b5836bd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/diagnosticsSource.js\":\"38a5b04ee69ca56f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/divergenceScan.js\":\"b3c4736943f2121b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/index.js\":\"908b665c708b124b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/propertyChildrenChecks.js\":\"827cda38962f457a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/referencesMirror.js\":\"b0891908d5e0d515\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/rowJson.js\":\"2cb62d9bd76f91b1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/schedule.js\":\"41e21bf949910bad\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/store.js\":\"afe26ac554d00fff\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/action.js\":\"e036f05fbe1ec976\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/index.js\":\"dfa69bea28b052c6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/plugin.js\":\"0707bac6684cf88e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ed07e8e1c247d4ea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/actions.js\":\"b58340e7f3801994\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/changeMarker.js\":\"525a57c9cb475a94\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/diagnostics.js\":\"af438144435623c0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/fileSystemAccess.js\":\"a56fb9ea88967142\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/filenames.js\":\"e80726e7146a2c60\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/index.js\":\"944a919548f41c78\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/mirror.js\":\"060d2b4907ec15af\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/runLock.js\":\"c03fae8ccf0a19bc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/runtimeHealth.js\":\"a7e6c2027c37ea36\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/schedule.js\":\"ff6eed58b417cbf0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/store.js\":\"881824806e84427e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/default-themes/index.js\":\"90c99fcc9cecbc3f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/default-themes/themes.js\":\"dd959ec76ed42a32\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/diagnostics/facet.js\":\"1b3e9929716f9e5f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/diagnostics/useDiagnostics.js\":\"811636be9de305fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/dismissals.js\":\"6a1749dffcb7510e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/index.js\":\"258cf63061396800\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/status.js\":\"19ac4f68c85b8d75\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/store.js\":\"ce0eb7c62acb2d3b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"dace1876f69bd9e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b2aa12c76d00d8f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/actions.js\":\"a974fc1b4e1dcddc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/config.js\":\"54c5e5d61d5ecbb0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/dataExtension.js\":\"9fa74d49302bf99e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/effect.js\":\"8a2962cdbbcbf87a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/index.js\":\"98c37319f03f3cf0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/propertyEditorOverride.js\":\"98d4b96b66ec555a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/useToggleTree.js\":\"57fc1b06d0122705\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/ExtractTypeDialog.js\":\"2cad25b314333d56\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"88d6442e58a03a6d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/PropertyShapePicker.js\":\"4713ef9d25396e35\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/action.js\":\"552909da4c724c59\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/index.js\":\"049b63ccd6eef620\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/FindReplaceDialog.js\":\"c879fe109a9247f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/HeaderItem.js\":\"7e7f2ffd8cd19dd7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/dataExtension.js\":\"4a54445dcf60c2b7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/index.js\":\"ec3c98f67be7e011\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/search.js\":\"1c7a6098bc65b8ae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/toggleStore.js\":\"eb3cef28d58664f6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/LocationPropertyEditor.js\":\"de88cc4e117e94af\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/MapView.js\":\"7ba15525bd1e9f05\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/blockTypes.js\":\"ea2d1a29e063d092\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/codeMirrorExtensions.js\":\"f01f46842563cd11\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/createOrFindPlace.js\":\"701cfe4e5bb9c717\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/currentLocation.js\":\"39b2bc37035a4ef5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/dataExtension.js\":\"5c481b24a99c6e71\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/geoContentDecorator.js\":\"63bcd1f73a077e18\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/googlePlacesClient.js\":\"6a8edb37110cbc96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/index.js\":\"0a75936599da3dbb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/locationsPage.js\":\"ace5e75a6ae81321\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/mapViewport.js\":\"0af7ef62a4e0df35\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/pickCurrentLocation.js\":\"1e5e8c74f83e2356\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/placeAutocomplete.js\":\"605d32a88085d9ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/placeNameCollision.js\":\"e555a1afcd2633fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/properties.js\":\"6351fbd8d63e9951\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/propertyEditorOverrides.js\":\"a88cbbea74883be1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/query.js\":\"07661e96156a4d2b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/usePlaceSearch.js\":\"24ffd0491668a04f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1107984d2b6f96cb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"71b979cd6d5515fb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"07e3665f3188631a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/config.js\":\"259d6633e34322dc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/dataExtension.js\":\"e8a3e247560551cb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/facet.js\":\"fe0fac6ba6e364a7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/grouping.js\":\"9ad0419b78dd163b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/index.js\":\"c2db3a656561d2bc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6ab9545c3a2aada9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/query.js\":\"c45c12eb9d807024\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/resolveConfig.js\":\"395d1e9ad78d72a4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0d374da9c27aa0d1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"aafd9e5e09f4620d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/HtmlDocumentContent.js\":\"9c5fc303474ffb73\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/HtmlFrame.js\":\"3c53ea2c22153232\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/actions.js\":\"48db5ee4c848571b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/blockType.js\":\"40a76a83bc1ec329\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/confirmRunScripts.js\":\"913c4e21204d96fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/dataExtension.js\":\"91ec83eba049fa53\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameAnnotations.js\":\"321fdff07c8e78f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameDocument.js\":\"df165ca3ff3d7ade\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameTheme.js\":\"f5b1d10a01bb5ed1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/index.js\":\"da8565bfbbd77050\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/scriptConsent.js\":\"b77547867e5928f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/sourceMap.js\":\"11c298d31f6fb27b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/useDocumentScripts.js\":\"8bc3e24e970028cb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/index.js\":\"a64c912217593790\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/record.js\":\"7407814ac8ecf824\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/recordStore.js\":\"7b9f801ade307c41\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/responsiveness.js\":\"1a7b2307f61079c0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/schedule.js\":\"1ccb3732bb92871d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/sessionContext.js\":\"463ec4c441bbbaab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1f2d95a8ec041a39\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2a28a5ddad80a966\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/actions.js\":\"50faa028f579a219\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/config.js\":\"4322fb9ff286ff27\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/dataExtension.js\":\"bfff8197e6eeb098\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/effect.js\":\"42d102ed9c3be511\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/index.js\":\"e79a0bd1fafcad43\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/keyCapture.js\":\"bc644826b01d6a7b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/overrideStore.js\":\"1f3ef272b9975dd4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"48b582bb6d2e0bf9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/HeaderItem.js\":\"eeee0ee1686dd2e6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/LeftSidebar.js\":\"f2fd4bbd6858e01f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/actions.js\":\"8e96415a340096a3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/facet.js\":\"92e0fb341f93ab98\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/index.js\":\"065a9ae482da946c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/shortcuts.js\":\"d7e61522895da571\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/toggleStore.js\":\"c7dd345679aa5c08\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/MergePicker.js\":\"de9aed8bf6e5744d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/index.js\":\"c183ba6b8d59fc49\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/mergeAction.js\":\"6dccc467d8548e92\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/strategy.js\":\"aeb8133ce42bf1fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/Button.js\":\"29ce52c6a62622d8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ec1341aff7f6d797\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/defaultItems.js\":\"cfb67852a481e544\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/facet.js\":\"250f9a5773a5fa60\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/index.js\":\"ad59873fa32034ab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b3288e94e2d761b1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4d121e9f4c9b2648\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8b49a16de01ba7a4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7f1ff21235ebff96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/index.js\":\"8b91a49bf88c9ec3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c2e2bd9bf928197b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/blockSubtreeMembership.js\":\"21809d3a53279676\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/contextMenuItem.js\":\"4509e5407311fe01\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/index.js\":\"7f3e9419eef2195f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/moveAction.js\":\"9010f56c2219bf8d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/moveBlocks.js\":\"2121ce1cef66d467\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/selectionAfterMove.js\":\"501eed10cd918dc2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/TutorialBanner.js\":\"5ebd5f040e7c4ac0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/action.js\":\"9557c18cf6c686c2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/bannerDismissal.js\":\"87e5c52dc7ae9d6f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/documents/cheatSheet.js\":\"6b3198f329334c86\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/index.js\":\"cf42ec225ef567e9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/keys.js\":\"e15d53d08a3e7134\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/landing.js\":\"961b97a48adab904\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/outline.js\":\"57fa51ee1f6aef1c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/seed.js\":\"d5361023b40aa316\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f4c72ae7a599e7b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/analyze.js\":\"f913f06163d3e981\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/diagnosticsSource.js\":\"0fb1b53c0974b2ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/index.js\":\"99ee268d26febd0b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/load.js\":\"03ddcb44b7dc208c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/monitorRun.js\":\"7f788fd4e7f21f00\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/schedule.js\":\"d04c63804e55bc8a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/series.js\":\"1e82434c74b12faf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/store.js\":\"8ae7884f0f6ceb34\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/trendAction.js\":\"9ba221ce69b2f485\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/verdict.js\":\"6ff04edacb1074cd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/clickToEditAction.js\":\"1fc50117d28cfffd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/index.js\":\"2f4d9ded408cfbf6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/interactions.js\":\"80123846cadb9c89\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9fba448361ca5473\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/MigrationGate.js\":\"c2687404c01ba9d8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/MigrationGateDialog.js\":\"c4570346128164e0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/action.js\":\"d6f2a99ac54f9d05\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/index.js\":\"81555877f3e2abab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/localRunMessage.js\":\"3a09ecf223677ebb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/plugin.js\":\"3430caa651eae480\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/progressReport.js\":\"5d2d909f8dea1061\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/sweepProgress.js\":\"7949cd301d0134c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/FieldRowRenderer.js\":\"621867da18f31c7c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/ValueRowRenderer.js\":\"e8f2ff4f4f73296c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/actions.js\":\"5b6a33b99c439e69\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/autocomplete.js\":\"2cfcb021021af5b5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/fieldRow.js\":\"22b55a0019ccdbb8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/index.js\":\"b149ba833cbd4906\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/referenceWarning.js\":\"e8f2cc2fd95148ae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/valueAutocomplete.js\":\"7d559506309526db\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/valueSchema.js\":\"a5d596008be90b01\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/HeaderItem.js\":\"ff58f6e374089144\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/QuickFind.js\":\"10e37dfbbe097d86\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/index.js\":\"3a3e0f44cb4bb20e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/recents.js\":\"62d3895636cfff8c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/resultItems.js\":\"423dfd7261e6e6e8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/selection.js\":\"7df8f1f0bd9886ef\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/toggleStore.js\":\"7622144d3df89cae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/HeaderItem.js\":\"14f88b1b5c406fd6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/RecentsPageBlockRenderer.js\":\"8f845d2df46712c2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/grouping.js\":\"6dd602684dc6d92d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/index.js\":\"2cab23958c5ee568\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/target.js\":\"4341977780e1ca09\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/codeMirrorExtensions.js\":\"9ee1d438d0788047\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/contentPrefill.js\":\"3b5d7de82513c4b9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/dataExtension.js\":\"154881cbeb811e03\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/index.js\":\"8a17a007abdece41\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"31848400473f956d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/invalidation.js\":\"8dcdfb1a43c33683\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/localSchema.js\":\"57b5d99c50b1afe2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/blockrefs/index.js\":\"a89ebcb52b9c0f7c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"316ad632cf5ef3e3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/index.js\":\"8aebc8c4a66faabd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/referenceNode.js\":\"30398eb879bff27a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/remark-reference-occurrences.js\":\"1e8518cbfc18c141\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7d9d63e507f375eb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/index.js\":\"097fe48ace9b4530\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2da908501671af55\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"450db9a274e713f7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/mergeRetargetProcessor.js\":\"e3bbdfa05109fafd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/parseFence.js\":\"f4291bc5726b9ea7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referenceParser.js\":\"c488edc2956dc2b8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referenceProjection.js\":\"b138a10e67699151\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referencesProcessor.js\":\"04ab83e65a80bfc1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/renameProcessor.js\":\"2b1782b6ac40b27a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/spanReplacement.js\":\"160982ab7674e08b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/htmlToOutline.js\":\"3456b828fb708ea1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/index.js\":\"ff1f96186e4cc185\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ff842e7ca7206c6c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/pasteDecision.js\":\"1d358e4bcee4044a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/action.js\":\"02a39f497804c4f9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/blockIds.js\":\"eec6ec6f13fd038a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/content.js\":\"1a8d20d88df1c772\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/effect.js\":\"1b874450d0af347d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/ids.js\":\"2f3b922ca8944080\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/import.js\":\"95cfba638bf5b0ea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/index.js\":\"4c950eadb00a1e72\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/plan.js\":\"05ea33b877eb0d55\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/plugin.js\":\"0b147b6d2b9d46a2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/promotion.js\":\"1d7aefc2384e752c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/properties.js\":\"a7754cf1f14f3e71\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/references.js\":\"61ce50ecf15157b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/report.js\":\"c3b2fc530cd51031\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/roamMemo.js\":\"ab725482ecb09082\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/runtime.js\":\"7e94370db817bdb9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/schemaReconciliation.js\":\"8322e956bd5f74f9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/srsMarkers.js\":\"794c7ea1f7ea90b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/todo.js\":\"f3e0a8961b2c6177\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/typeCandidates.js\":\"07bf5c45395a44b6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/types.js\":\"9eb52a4ec35359c1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/search-health/index.js\":\"4188cb8a91e323b8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/search-health/store.js\":\"445613131ffa529e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/HeaderItem.js\":\"a76e10dbea068ed7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"d50eabf39ec5aacf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/index.js\":\"60fd483c16d115bd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/model.js\":\"05a8af31d63a186c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/toggleStore.js\":\"0b6d0b85434ea0e3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/useKeyInspector.js\":\"7af6905236f2c7c9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"44dd3c38b9741874\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/ShellDecorator.js\":\"e059deb7785b51a7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/actions.js\":\"bb5901c98e30c0fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/exclusionsFacet.js\":\"12e9d9c3dba28846\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/index.js\":\"85315d1d4e85bb9c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/shell.js\":\"60fb40ec6a45f08a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/surface.js\":\"44a923fe235bd474\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/walker.js\":\"1d6457895119f607\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/RescheduleToast.js\":\"2cafa6dae3d0991b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/dataExtension.js\":\"5603d966c1b94856\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/index.js\":\"a6b9aafaffdd5331\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/indicator.js\":\"026de4c8d30e9618\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/moveSrsState.js\":\"e90f936b97835219\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"220d9231a4f0f503\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/scheduler.js\":\"e2c64c54e74e6845\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/schema.js\":\"4059616492edaad2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4a026f282286141f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/srsClipboard.js\":\"4bca483aa90a2e1a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e363dff1007118d6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/DailyNoteReviewHint.js\":\"dae56c0fd8dcfbda\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/DeckPicker.js\":\"e71a787365570fdd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewControls.js\":\"e5c9cd0d2e8a0e5b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2598943b0d74bf65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewSession.js\":\"34af596e534b24f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/actions.js\":\"ef562c50da198bcb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/archive.js\":\"8b387fe1e474d3a8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/dataExtension.js\":\"fc0c1c4023b4ffd8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/deck.js\":\"b1f41b80aefada38\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/dueQuery.js\":\"2380cc5024bc9759\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/gradeDecision.js\":\"595351f39ffd6874\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/index.js\":\"0faf05f327532689\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/keyHints.js\":\"0588a9aaa6e73194\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/reviewCardLayout.js\":\"f3d43f346030f265\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/reviewProgress.js\":\"784da62bf9535ca9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/schema.js\":\"37fef693ca387680\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/useDueCards.js\":\"62ae141d9e4737d7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/startup-metrics/index.js\":\"e5a098a8135462a2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/startup-metrics/record.js\":\"c439f9e0dedc5dc7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/index.js\":\"59b25db8f9fa26fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/persistenceStatus.js\":\"29578c7f6cb2f589\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/requestAction.js\":\"a2550917e0313809\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/TypeChipsDecorator.js\":\"1faff8b0f605d68b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/codeMirrorExtensions.js\":\"ff87f9bb0177c4af\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/index.js\":\"89684fa128c1d779\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/typeAutocomplete.js\":\"24f1ff15a319b8cd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a396d3b8e8703630\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/actions.js\":\"3eb1c41b1332e8ba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/anchor.js\":\"620f3785853e3d6c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/events.js\":\"95507b5b64cc7011\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/gestureActions.js\":\"30a145c68346e80c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/index.js\":\"80faabec3eb79c71\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3549e23810eff82d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/collect.js\":\"8373e78c5ab08a85\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/index.js\":\"b3bdd13b4ce90086\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/record.js\":\"c0ba518460503e96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/RejectionDialog.js\":\"5312865392c3bf55\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7785eb2689547bc3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/index.js\":\"cac4995ead43fd8d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/model.js\":\"be5d021436c9fba1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/queueCounts.js\":\"3483509ed45c8d34\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/rejectedHelpers.js\":\"6a5ac307c8989a93\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/rematerializeAction.js\":\"28988f3d613d823d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/useHysteresis.js\":\"bac71290f578929a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/ColumnHeaders.js\":\"5d51105de23f6e88\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/QueryUi.js\":\"1331488f1f19f95e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/TableLayout.js\":\"fdf27a78f69a84e2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/actions.js\":\"20b93f8dc0d10af2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/cellEdits.js\":\"9c69167630af6f80\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/columns.js\":\"d931d61c1a12e0bb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/controller.js\":\"b86637ff36658f37\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/convert.js\":\"299e78ae0db29379\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/dataExtension.js\":\"fe6e3a6f69cc629e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/index.js\":\"3829d2d7224453f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/keys.js\":\"9d73c24f93306a73\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/model.js\":\"098defa6c2ed16df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/backfill.js\":\"c90f63e355585784\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/format.js\":\"5078e8246a518dde\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/parse.js\":\"149ff3688a3bac3d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/queryValue.js\":\"4cbc03fa213f5e3c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/source.js\":\"761898bad232bac2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/registry.js\":\"27a45e6f04312f49\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/schema.js\":\"31a3fec970e258a6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/sort.js\":\"db7879d20ef758b8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/effect.js\":\"b49d82dfd953c094\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/index.js\":\"aac6bd34f3c464d3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/theme.js\":\"5139ee7f10e47ac4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/actions.js\":\"42ea5d8d064ce0d2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/dataExtension.js\":\"18f1f5baf157d1be\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/index.js\":\"728653135723e356\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/schema.js\":\"73b9ff12183a65fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/TouchSelectionLayer.js\":\"63ecdd243f8f03a3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/actions.js\":\"8ade6b1442d07ff2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/defaultItems.js\":\"66064030e7308e7f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/facet.js\":\"8b3b882c251de907\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/holdRecognizer.js\":\"11d0bfca0128d0cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/index.js\":\"7d35174103ea76d4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/UpdateIndicator.js\":\"b7538b3bd2ac2d16\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/index.js\":\"11d5dbdabcfc56ed\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/loadTimes.js\":\"593b3d1a53f27e1d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoNotesRenderer.js\":\"1078f4b96e098596\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoPlayerRenderer.js\":\"f4e7a46791ce8a5e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoTimeStamp.js\":\"2e524a8d3e490fcf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/actions.js\":\"78f187b7ab13c33b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/index.js\":\"62459b294284e52e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/markdown.js\":\"c4750be8925877a8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/notes.js\":\"b6d5578cd3fbe53a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/registry.js\":\"f75d24f9c77a248f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/remark-timestamps.js\":\"9c65e2d43d5a1dd3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/view.js\":\"fb2b016fb6716b9d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/LinkHints.js\":\"254d91db4b3d4a5a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/index.js\":\"92facb4efb21ac23\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/model.js\":\"848a4ac293cb6ab6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/settings.js\":\"03f6fcfa83c6e169\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/actions.js\":\"e4fa60f1abb5e235\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/index.js\":\"683281c72109534a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/interactions.js\":\"2858497041f53462\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/workspace-header/index.js\":\"eca8a736be9e9fbe\",\"/knowledge-medium/pr-preview/pr-1849/src/registerServiceWorker.js\":\"cc033d48ef5908c4\",\"/knowledge-medium/pr-preview/pr-1849/src/requestPersistentStorage.js\":\"00a56eabfd1f52b0\",\"/knowledge-medium/pr-preview/pr-1849/src/services/authRequestDeadline.js\":\"41bd86624ba41d50\",\"/knowledge-medium/pr-preview/pr-1849/src/services/authStorage.js\":\"b8f392bbf9faa71e\",\"/knowledge-medium/pr-preview/pr-1849/src/services/powersync.js\":\"3786e8029b9e172d\",\"/knowledge-medium/pr-preview/pr-1849/src/services/supabase.js\":\"f1c756eb9c657525\",\"/knowledge-medium/pr-preview/pr-1849/src/services/uploadErrorClassifier.js\":\"504475717fde3523\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/ActiveContexts.js\":\"cd2674f39be166d4\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/HotkeyReconciler.js\":\"9cedf092b68f7bce\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/WipeLocalDataDialog.js\":\"ee11cbbe29104688\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/actionDispatch.js\":\"a256cc87841a4716\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/actionRefItems.js\":\"7099fe9f6ed5ae06\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/applyKeybindingOverrides.js\":\"004db35a5ebd0bd9\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/blockActions.js\":\"5698368fe6760cec\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/canonicalizeChord.js\":\"5a6cc2ed3dd596ad\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/defaultContexts.js\":\"f292200d88a556fa\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/defaultShortcuts.js\":\"c6014fde4e53d26f\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/effectiveActions.js\":\"424ac41179b08960\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/gestureAction.js\":\"9ea0cd6952d87418\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/gestureBinding.js\":\"bbf66baad3899159\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/holdRegistry.js\":\"4f66e2aa25f4f7de\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/keybindingConflicts.js\":\"4efbfa9b3b5fd3b2\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/keybindingOverrides.js\":\"60a84c9849859968\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/pointerAction.js\":\"e502a483ad54bafb\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/resolve.js\":\"89a0d87ac248b1f3\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/runAction.js\":\"76d94c5d5c2c567a\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/sequenceMatcher.js\":\"2efb6dc04c846848\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/types.js\":\"247cf97b7d5a2d17\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/useActionContext.js\":\"4098fea62fd40f0a\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/useActionDiscovery.js\":\"30bfef257693cb72\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/utils.js\":\"c9db264641ba7db2\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/bootStore.js\":\"ea80027f98d82dc4\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/previewDatabases.js\":\"f74a8d4c6b35a80e\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/byteTransform.js\":\"74d252834519320f\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/attachmentCleaner.js\":\"966575d81add3c49\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/attachmentParts.js\":\"fd61ae47a65309dc\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/bundleParts.js\":\"c5918992b2002cdc\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/bundleRecord.js\":\"1e1d35b51141eb7b\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/manifest.js\":\"33e2565ed327e2b6\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/takeBundle.js\":\"3259ae5163e31ab2\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/verifyBundle.js\":\"564e58788ead68b5\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/cleaningStage.js\":\"f3cac23f4d6b17ab\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionKey.js\":\"a8863d6640feab87\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionServer.js\":\"0ac80548819d32a9\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/flip.js\":\"4e2691b02370a64e\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/flipAttempts.js\":\"e9e7949de03b2b63\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/pages.js\":\"d0db673b0015c3d9\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/preflight.js\":\"83120207cb2f5488\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/reseal.js\":\"efe869148fe0b5df\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/runConversion.js\":\"49e2055e59d5c246\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/runLock.js\":\"060639ff5125cf7f\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/sealing.js\":\"1100e952d9367cdd\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/sealingStage.js\":\"fd45ae293079327a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/stage.js\":\"dd3ea039e95cbf39\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/verifyReseal.js\":\"9d1324b770791773\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/aad.js\":\"8d5388729b7f1594\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/aead.js\":\"58e0cbb66b25aa26\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/base32.js\":\"d039d3ec1e0282e5\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/base64url.js\":\"f3d0cdbcbfcbda23\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/binaryEnvelope.js\":\"6ef475f4eb00a65f\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/byteAead.js\":\"654bae8740df3585\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/canary.js\":\"95a7d40b427394e0\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/contentHash.js\":\"ef9eedc8f0d0bdda\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/contentKey.js\":\"f90e3233e546985d\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/derivedIdNamespace.js\":\"3df29dd7be851cad\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/envelope.js\":\"c6bcedd3becf5815\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/hex.js\":\"b9b89602830ba794\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/sha256Hex.js\":\"de7f264a36a11ed9\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/workspaceKey.js\":\"f628b3d724ca5b82\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/conversionState.js\":\"fbf6649a17ef30f1\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9de44a57a11347df\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/pastedKey.js\":\"9308fe4f0c21401b\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ddd936366faad5f4\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f7c619e9a6603979\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/keyStore.js\":\"5c60a6f7ed8491f3\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/mintWorkspaceKey.js\":\"1d9e4fb4b3abbc0f\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/modePin.js\":\"ffe002e878c29c00\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/openWorkspaceKeys.js\":\"9d4d5cb5b33836cc\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/resolveWorkspaceEntry.js\":\"0c6b88ceca3ec2cd\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/resolver.js\":\"7a37ab476c903df3\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/workspaceAccess.js\":\"334296a74aa9c6ba\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/transform.js\":\"ca94d0f9b6a8028a\",\"/knowledge-medium/pr-preview/pr-1849/src/themeBootDefaults.js\":\"10a50a87cb782992\",\"/knowledge-medium/pr-preview/pr-1849/src/types.js\":\"2ab2866fe0775e07\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/ClientLocalSettings.js\":\"7ec69e975de12b82\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/abortableSleep.js\":\"eca838f8a95dcdcd\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/array.js\":\"dc6aad0afdac7722\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/backlinkAutocomplete.js\":\"d7f4199e49262acc\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/blockCrumbs.js\":\"2b952aa67062843e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/blockrefAutocomplete.js\":\"8cf8dfd290b4da4f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/cadencedIdleJob.js\":\"e1e177a958d7e40c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/callbackSet.js\":\"d665f9000b839f39\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/clientId.js\":\"6f1a395d1214d245\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/codemirror.js\":\"63c68033bd021936\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/codemirrorCompletion.js\":\"b3645abf85ac7c26\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/copy.js\":\"4eac668040b063e6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dailyPage.js\":\"4f5c265f1f83c831\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dbForensics.js\":\"486166dad7e50b55\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dbForensicsHooks.js\":\"f5e904673dce36d3\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/deleteBlockThroughUi.js\":\"b9af6c9b676ef2ba\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dialogs.js\":\"e7f1891bbbf56cda\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dom.js\":\"61cb8078660db32c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/downloadBlob.js\":\"def492ee76db3d8b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/exportSqliteDb.js\":\"782c56c0d89c65da\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fileSystemAccess.js\":\"073dc4df4b06c63d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/flipSlide.js\":\"996e7867aaa02e65\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fnv1a.js\":\"b65ed5b64b2b479b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/formatBytes.js\":\"0cf0c0a28a4cda71\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fuzzyRank.js\":\"02780a8f6333793f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/idbKeyedStore.js\":\"661e0bba1561c80f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/idleCallbackPolyfill.js\":\"f7261689e420d603\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/keyboardAwareScroll.js\":\"8f0c8b0e2cbaf959\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/keyboardViewport.js\":\"7032983142813881\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/lastWorkspace.js\":\"0f177b35959bdee8\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutColumns.js\":\"31bd13f744ae5abf\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutSessionDom.js\":\"7c53dbe726337ea3\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutSessionId.js\":\"eeb0b06f3bc4ff40\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/linkClickGestures.js\":\"c69f4927ce1a6f79\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/linkTargetAutocomplete.js\":\"39e1df8923c512ea\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/localDbCorruption.js\":\"3d0c5f98d2730023\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/localDbRecovery.js\":\"2d3e20b2504bd6a2\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/markdownParser.js\":\"5c94ed22018871e0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/memoize.js\":\"f38dce85cc1a2ec8\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/nameFieldCommit.js\":\"a94b7b7ac040e5b2\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/nameList.js\":\"bfe3fab9dd032665\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/navigation.js\":\"c22b756bc0d61407\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/omnilinerNamespace.js\":\"0b716b85c210bdc9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/opfsPageScan.js\":\"5f1c47bdc5331077\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelClearance.js\":\"a2fc6d7dab75b54f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelHistory.js\":\"7fdd28f526a2cb0f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelLanes.js\":\"77bc818891c39614\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelLayoutProjection.js\":\"e5b7289d415f086e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelScrollAnchor.js\":\"67a531371861a636\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelUrlFlags.js\":\"fed81d0a3406f42c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/platform.js\":\"c38c24d94e0076df\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/pluralize.js\":\"0ff24f700a46ea2a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyCreation.js\":\"a27a9bbd97304bfb\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyNavigation.js\":\"8c8f690e6d58e92a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyValueContext.js\":\"1dfa7407ce67a8f6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/react.js\":\"5ed50cb1bbe0ffc6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/relativeDate.js\":\"78acd0a87fd78440\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/relativeTime.js\":\"b03c9b8cae9c559e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/renderScope.js\":\"935220ab24879059\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/resolvedThenable.js\":\"17e99f8d05435447\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/routing.js\":\"7a3867bee62e9270\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/safeMode.js\":\"b0805bf93c8b499b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/scheduleIdle.js\":\"d6e19b311e3b6bfa\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/screenWakeLock.js\":\"99ec203cffbaadb9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/selection.js\":\"f8a930beb17ac849\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/softKeyboardGrab.js\":\"af9f85f9faf3a31c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/startupTimeline.js\":\"c314956ddf3542dd\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/state.js\":\"6f5adb6eb59eeda1\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/string.js\":\"9555b134d9ff7b92\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/surfaceZoom.js\":\"acf8c95183aa4da9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/time.js\":\"63abecf2ba2458ce\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/toast.js\":\"0eaec6432039b689\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/toggleStore.js\":\"67b3ab9a5903cda3\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/untilStopped.js\":\"f398dc8701b94d87\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/userActivity.js\":\"bdf34c24ee435edb\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/viewTransition.js\":\"cb3d8447a94de409\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/viewport.js\":\"02dd2f369424fb79\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/webLock.js\":\"5b3826ee863c8055\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/workspaceRecovery.js\":\"d2c52fd4d6001456\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/workspaceSnapshotStore.js\":\"1565fc07a3b51af7\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-compiler-runtime.js\":\"2b0a2c4185ddf11e\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-client.js\":\"d0d66dea9af9d9e5\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-server-edge.js\":\"70ea48b5f33dce42\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-server.js\":\"69f480b02c108b6e\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-static-edge.js\":\"cf45d5d760bc6ef3\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-static.js\":\"118aa77dbe7b3948\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-test-utils.js\":\"a4861fcfee059b8a\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom.js\":\"82c31b1fc8432c12\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-jsx-runtime.js\":\"b61f0cc9ec5029d8\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react.js\":\"b2f29dff8a06d9d7\",\"/knowledge-medium/pr-preview/pr-1849/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1849/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1849/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
