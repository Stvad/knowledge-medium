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
		buildId: "fa6997e46539-1fc26125",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/\":\"62d9d8415b149d15\",\"/knowledge-medium/pr-preview/pr-1849/index.html\":\"62d9d8415b149d15\",\"/knowledge-medium/pr-preview/pr-1849/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1849/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1849/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1849/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1849/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1849/assets/FacadeVFS-CTUZxKpZ.js\":\"7ce2ea4ed2cbd954\",\"/knowledge-medium/pr-preview/pr-1849/assets/OPFSCoopSyncVFS-CLdqY3-Z.js\":\"b59445b4827a448c\",\"/knowledge-medium/pr-preview/pr-1849/assets/OPFSWriteAheadVFS-CTtA_Q1m.js\":\"6355e05a4504078e\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-async-D08pev_M.js\":\"1b73992d4499fe2e\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-vz8waUKe.js\":\"b03de34da6f14e03\",\"/knowledge-medium/pr-preview/pr-1849/assets/worker-DZrcfXSe.js\":\"e2723d0ee3dc82b4\",\"/knowledge-medium/pr-preview/pr-1849/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1849/chunks/app-Dl3ZLykt.js\":\"4938bd8730f1e91e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1849/index.js\":\"5daf9bd6b0382b7d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1849/assets/AccessHandlePoolVFS-DreJETfy.js\":\"01f907cbd40a06be\",\"/knowledge-medium/pr-preview/pr-1849/assets/IDBBatchAtomicVFS-ywRrXwEr.js\":\"a6c04e5ac8b38ba9\",\"/knowledge-medium/pr-preview/pr-1849/assets/MemoryVFS-Di6fqy7r.js\":\"0da4807deefc1b14\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-CRjJAkFh.js\":\"563f9d8cb1164b5a\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-async-DSeoc4RX.js\":\"68d831d8cbfbef0e\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1849/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1849/chunks/AccessHandlePoolVFS-CC6Qm6nZ.js\":\"f01416359488a0e4\",\"/knowledge-medium/pr-preview/pr-1849/chunks/FacadeVFS-DDgNBSoo.js\":\"e4c9948964545cad\",\"/knowledge-medium/pr-preview/pr-1849/chunks/IDBBatchAtomicVFS-Dqzr4i0r.js\":\"c75cb3e92aa5f31c\",\"/knowledge-medium/pr-preview/pr-1849/chunks/MemoryVFS-DpQvSw2e.js\":\"a8c41faf977b258a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/OPFSCoopSyncVFS-B8PM-Tau.js\":\"19d53f21814f71f5\",\"/knowledge-medium/pr-preview/pr-1849/chunks/OPFSWriteAheadVFS-DqWo2mOr.js\":\"cace596a5f8acda1\",\"/knowledge-medium/pr-preview/pr-1849/chunks/Preview-6-Dwx2Y_.js\":\"71d9ee44d013e441\",\"/knowledge-medium/pr-preview/pr-1849/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1849/chunks/card-CUYSNVOY.js\":\"0e5b9ad145466b09\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-DL3yaRiV.js\":\"8314302c5f33776f\",\"/knowledge-medium/pr-preview/pr-1849/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1849/chunks/mc-wa-sqlite-0IYL4xS2.js\":\"1157dd6ff2df531b\",\"/knowledge-medium/pr-preview/pr-1849/chunks/mc-wa-sqlite-async-D_7oJdE3.js\":\"a28d4feb79e1d771\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-BR6SIpVR.js\":\"1fab0ec5888d193a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-BpnvGNxN.js\":\"e897fa56b968632f\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-C38tHgjX.js\":\"79ef557b90b290f7\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-D9A2dMF7.js\":\"457361c74e6221ab\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-DC5gFlpp.js\":\"dd1ddd39eb3ebaeb\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-DaQL-uWb.js\":\"183fe33adb992924\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-TIqlWWT4.js\":\"c4cccc97979c7171\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server-legacy.browser.production-DChmxA7z.js\":\"f5454694eee09cd3\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server.browser.production-DtsrQIRY.js\":\"9a566eb9655b42cf\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server.edge.production-BcQXVVG8.js\":\"4c066b6a12050e8a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-nXrM5B6-.js\":\"f784cc8589ffd8b5\",\"/knowledge-medium/pr-preview/pr-1849/chunks/server.browser-3AJUZal3.js\":\"d2851778ac935fcd\",\"/knowledge-medium/pr-preview/pr-1849/chunks/textarea-Cy5BxRn3.js\":\"1af353af51e96a2c\",\"/knowledge-medium/pr-preview/pr-1849/chunks/ui-C79Bb8qX.js\":\"6afc5d77b5908ec7\",\"/knowledge-medium/pr-preview/pr-1849/chunks/wa-sqlite-async-fqHSP1g_.js\":\"3cbea204c659e45e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/wa-sqlite-wEY6Mp41.js\":\"35504ebac4ec9c2a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1849/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1849/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1849/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1849/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1849/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1849/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1849/src/App.js\":\"870cf003d50dcdc2\",\"/knowledge-medium/pr-preview/pr-1849/src/appUpdate.js\":\"1869355d4bfe7a0e\",\"/knowledge-medium/pr-preview/pr-1849/src/appVersion.js\":\"a4dd533521458b36\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/initialLayout.js\":\"faccef18f6c97a6b\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/openWorkspaceData.js\":\"be5515217ce5e4a4\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/resolveWorkspace.js\":\"8bc5bb5ed70c6973\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/workspaceBootstrap.js\":\"6f30836abb35ffd3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockComponent.js\":\"5073c35bd3b8710f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockCrumbs.js\":\"4c09f7c7076df9b7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockEditor.js\":\"0a5b98fe219494b9\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockLoadingPlaceholder.js\":\"f60d3b10980b7d62\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockProperties.js\":\"1ac7f0fa4bc0e306\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockSearchPicker.js\":\"08728d44b5a7b982\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ConfirmBulkDeleteDialog.js\":\"9c9f9e29be004889\",\"/knowledge-medium/pr-preview/pr-1849/src/components/DividerHandle.js\":\"d2a26136d9693aeb\",\"/knowledge-medium/pr-preview/pr-1849/src/components/DraftEditor.js\":\"df08bff3c2d1877a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/GutterPill.js\":\"37598cd6cc8229ad\",\"/knowledge-medium/pr-preview/pr-1849/src/components/Header.js\":\"0d6b610eb34f139b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/LazyBlockComponent.js\":\"a65db024412bf90a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/Login.js\":\"ee078ef19e7355cf\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ZoomableSurface.js\":\"f20618dde27cb070\",\"/knowledge-medium/pr-preview/pr-1849/src/components/editModeKeepalive.js\":\"53d82cb44e341d1a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a60dafa4e702f7b3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0c00f59370256461\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/RefPropertyEditor.js\":\"b8574f99b168c30f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/RefTargetTypePicker.js\":\"f99931fdbaeb3980\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/SelectPropertyEditor.js\":\"9d81355f14ae28bc\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/TypesPropertyEditor.js\":\"888a5045a7906197\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/defaults.js\":\"9f4536d5a2064ef7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/kernelValuePresets.js\":\"487087d7ac83a651\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/selectablePresets.js\":\"de6793b59de2fa29\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/typesPropertyUi.js\":\"39f513f5b77b23ff\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/AddPropertyForm.js\":\"fb204c0f73357ed3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/PropertyPicker.js\":\"c4b9dfa557523fa2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/PropertyRow.js\":\"42eb837f7112d5a6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/Rows.js\":\"fe2c0033db6423e0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/actions.js\":\"56e779f8932b7af4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/declarationOnly.js\":\"e507b02bfdafce3c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/layout.js\":\"d556959c750f0d47\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/model.js\":\"bd79d51d78b66cd0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/shapeUi.js\":\"f395eb32662056c0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/shapes.js\":\"69e05992e38d8159\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9ec4f0630cc07ef1\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/visibility.js\":\"091b7902cc65862d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanelSections.js\":\"d2c2736d8318eb82\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockEmbed.js\":\"e5ab1417ac8b1fd8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockLink.js\":\"e6e0d03dab6cd863\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockRef.js\":\"b3ab64613fc929a7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/ReferenceLink.js\":\"f2c72720ff380f9a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/cycleGuard.js\":\"b70571a08d99e340\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/cycleGuardContext.js\":\"8a61d1c9a462dd40\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/linkInteraction.js\":\"83b0982f68949894\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/referenceLayout.js\":\"dd27662412572304\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/useBlockRefAncestors.js\":\"ab3ce609d9e65821\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockGutter.js\":\"2b6a3295df2f1e10\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockInfoDialog.js\":\"ce7fc31dc43d70e9\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockTypeBlockRenderer.js\":\"996091fde6a489e3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BulletHoverCard.js\":\"230abfed45fcd679\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/CodeMirrorContentRenderer.js\":\"a9872235e3963943\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"89b84ea6d1d815f9\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/ColumnResizeHandles.js\":\"2f0114b2b8496aa0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ee556da793b89907\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/DefaultBlockRenderer.js\":\"6d9f7a277744bc9f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/LayoutRenderer.js\":\"135e42c5f5a3e09f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/MarkdownContentRenderer.js\":\"ceab92b1b0a4c3ce\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/MissingDataRenderer.js\":\"611cbe883be87930\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/PanelRenderer.js\":\"63f9c63e397c1999\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b76ab0b9ed1e4dd6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/TopLevelRenderer.js\":\"206732547904e8f9\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/blockGutterMode.js\":\"ab493d59fddb4b98\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/blockTitleText.js\":\"0a58ad7b28e9abf3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/fieldCreationKeydown.js\":\"957bbce54a975bae\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/layoutRootContext.js\":\"dc8ea95af8cc8630\",\"/knowledge-medium/pr-preview/pr-1849/src/components/typeChip/TypeChip.js\":\"c04d3b6f0e7a8810\",\"/knowledge-medium/pr-preview/pr-1849/src/components/typeChip/chipStyle.js\":\"5a0d544661ab9786\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/anchored-floating.js\":\"71a21be897e49b2a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/button.js\":\"e5c0d03af190b46b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/card.js\":\"1424276a324f8c83\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/checkbox.js\":\"7b7362a73ff13da5\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/collapsible.js\":\"98e6cfe6e88c8649\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/command.js\":\"a36bac91f2fd920e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/context-menu.js\":\"6f724a08b9ee1894\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/dialog.js\":\"52e6f1100e09f3d6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/dropdown-menu.js\":\"07a0c0fe06159448\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/floating-listbox.js\":\"b6a10f89c7fb57fc\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/index.js\":\"126d7b056341318d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/input.js\":\"514651bfecb482e5\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/kbd.js\":\"a82ebfa7f54caa03\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/label.js\":\"e45a00746ae02b0a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/textarea.js\":\"81fcbe5603aeb9a5\",\"/knowledge-medium/pr-preview/pr-1849/src/components/useEditModeYieldKeepalive.js\":\"989bcf7b54115360\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/BootFallback.js\":\"6ade6496df28af8c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/FocusedRowLazyMount.js\":\"0760df9162a3794d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/LazyViewportMount.js\":\"05c7bcca17215b98\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/LocalDbCorruptionFallback.js\":\"09b8d227b703da08\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/error.js\":\"9a8e0b846899db33\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/lazyMountRegistry.js\":\"3de8015b337c39aa\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/suspense.js\":\"9f129dca20a8caee\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/CreateWorkspaceDialog.js\":\"1c61514f9081cf95\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/PendingInvitations.js\":\"5c6cc13a86d1c7e5\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/SyncProgress.js\":\"269ed68897f89f11\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/UnlockProgress.js\":\"8556f4f360179ede\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceKeyGate.js\":\"9280fad6e6b0ffe5\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSettingsDialog.js\":\"4cd76d86d7320fde\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSwitcher.js\":\"f13aeb5b51234d4f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSyncGate.js\":\"e2a282427ad3b759\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/ConversionFlow.js\":\"7bd43e010b7620fb\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/ConversionFlowHost.js\":\"1cc91c1f0f8f653f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/EncryptionSection.js\":\"501d9776f2909e69\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/attachmentPrompts.js\":\"7c69f0c667ac20ce\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0421775e761665b4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/conversionFlowDeps.js\":\"71bad310c1341da2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/conversionFlowStore.js\":\"065d21e4d0ab50bf\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/flowUi.js\":\"d6a2e90ffc38a62b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/useConversionRun.js\":\"2d7226a87216c3ff\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/keyUi.js\":\"a003c89beace7541\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/useCloseOnKeyLoss.js\":\"191a410407d1fd7a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/useCloseOnServerE2ee.js\":\"ac61550f5c42e055\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/workspaceUnlocked.js\":\"41d5f59cee483375\",\"/knowledge-medium/pr-preview/pr-1849/src/context/backgroundSubtree.js\":\"dfc737ed03a53287\",\"/knowledge-medium/pr-preview/pr-1849/src/context/block.js\":\"77dc3cb25cf22416\",\"/knowledge-medium/pr-preview/pr-1849/src/context/layoutWsContext.js\":\"fba4d31936bcaa64\",\"/knowledge-medium/pr-preview/pr-1849/src/context/propertyDisplay.js\":\"f03eac3ea4216cc8\",\"/knowledge-medium/pr-preview/pr-1849/src/context/repo.js\":\"4233eea0444fef27\",\"/knowledge-medium/pr-preview/pr-1849/src/data/aliasClaim.js\":\"e61c2e982674665d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/aliasSeatNamespace.js\":\"60b372bb4e513a21\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/blockData.js\":\"2a981c61e36ecda7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/blockType.js\":\"3b405cc9d77ab1a3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/changeScope.js\":\"349bb20d0dd35d13\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/codecs.js\":\"1a013e72604e139f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/derivedData.js\":\"2db2a00206908c3f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/errors.js\":\"12a0dfc0d202938d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/events.js\":\"fef0b0411ac2e9dc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/handle.js\":\"fbb329dce2970b68\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/index.js\":\"6bec3da3f4c9d385\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/mutator.js\":\"ced65bd1366c5a88\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/processor.js\":\"86d5ac9ccf7ea832\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/propertySchema.js\":\"46f0dfe50f266081\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/query.js\":\"a40813b7fe3e6736\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/sameTxProcessor.js\":\"c0f56ef88d57b92d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/schema.js\":\"fbb329dce2970b68\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/tx.js\":\"fbb329dce2970b68\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/typedBlockQuery.js\":\"849bb56fae1f4ebb\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/user.js\":\"6028e5c5c0620b5e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/valuePresetCore.js\":\"a0935ee6163f3ef6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/valuePresets.js\":\"6b90c0f9a1d37e68\",\"/knowledge-medium/pr-preview/pr-1849/src/data/attachmentCleanerIOVerb.js\":\"70f516d4cd48918c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/block.js\":\"548b44ce84c08305\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockCache.js\":\"4d00b4c794204676\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockId.js\":\"1aeaaab285a65a17\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockLiveness.js\":\"2c40772177e6ed86\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockMerge.js\":\"f96354c190d42b81\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockSchema.js\":\"041923f9bf156edc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockTypeLookup.js\":\"e0a5f0d482ebca12\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockTypes.js\":\"1ded9235394beb42\",\"/knowledge-medium/pr-preview/pr-1849/src/data/clientContext.js\":\"7bf6bcc45dbf4bff\",\"/knowledge-medium/pr-preview/pr-1849/src/data/dbFileSiblings.js\":\"ec9c3bfb7b1d2696\",\"/knowledge-medium/pr-preview/pr-1849/src/data/definitionSeeds.js\":\"1190fcc0a44e8227\",\"/knowledge-medium/pr-preview/pr-1849/src/data/derivedIds.js\":\"788468016883a044\",\"/knowledge-medium/pr-preview/pr-1849/src/data/drawnSubtree.js\":\"84f5adb567a0df47\",\"/knowledge-medium/pr-preview/pr-1849/src/data/facetBridge.js\":\"4052f23f7f22c081\",\"/knowledge-medium/pr-preview/pr-1849/src/data/facets.js\":\"6b9557c264d0a60a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/globalState.js\":\"b15b543d04dffe2d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/aliasClaimRederiveProcessor.js\":\"31d783b755e4531c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/ancestorBatch.js\":\"f9e47d324527e767\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/blockTypeTypeifyProcessor.js\":\"dba7638dab922f5b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/clientSchema.js\":\"8aed15fc40ca8d80\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/commitPipeline.js\":\"b3f3b6b915ed9b3c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/devAssertions.js\":\"4d01e3b68e696bb0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/firstSync.js\":\"0f7e03658c3b0616\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/freshInitialLoad.js\":\"061e1c1538f46bb5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/graphBackfillClaim.js\":\"1e6478b3f7439874\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/handleStore.js\":\"10b9675bd29fa68a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/idleMarkerJobs.js\":\"f0a7f082e2a5136f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/initialDownload.js\":\"2714972fd0d84413\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/initializeClientDatabase.js\":\"8dc3299159b1cc02\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/jsonCanonical.js\":\"edd61bcbe2fcfb6b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelInvalidation.js\":\"1f3b70cfe2522772\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelProcessors.js\":\"f770519657345a87\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelQueries.js\":\"d674be19d7aef937\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/mergeTypeMembershipProcessor.js\":\"5770d987c4cba860\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/normalizeReferencesProcessor.js\":\"4e35be56ad8f6b2e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/poolInstrumentation.js\":\"389244c1b8bc96a4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/processorRunner.js\":\"c7b84f7c2e527126\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyCellBackfill.js\":\"968f36ce574707db\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyChildMint.js\":\"c4f568b9bc3d0fe0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyChildrenProcessor.js\":\"f81dfd4c40c7eb8b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyDefinitionChangeProcessor.js\":\"13d75bb6a2ece598\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyDefinitionSynthesis.js\":\"ea060a457c930bdc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyKeyScan.js\":\"e0f8db145ee88343\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertySchemaResolution.js\":\"a4535eee3555210a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyValueEdits.js\":\"205f3466bb633ae9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/raiseProtocol.js\":\"8dd7e76b5fb9129a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/readBatch.js\":\"1d8079b43f90d942\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/refProjection.js\":\"fdbbe307da121008\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/referenceTargetLookups.js\":\"7e55a7984133153e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/referenceTargetProcessor.js\":\"886d58e3990952ad\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/replayMerge.js\":\"f29981b90a6953ba\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/sqlBinds.js\":\"d20cb288c463f387\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0e6acee3bd405a92\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/arrivalProcessors.js\":\"17183c0eef3e8c42\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/invalidate.js\":\"71b2ea0592ffafb7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/materialize.js\":\"48e68db7d3c8c072\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/observer.js\":\"313d8d90d5eea853\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/reconcile.js\":\"ed5254b727a2a244\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/timingMetrics.js\":\"947ace82661e7839\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/treeQueries.js\":\"4b488dfb490f6028\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/txEngine.js\":\"48d40f0881ee1332\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/txSnapshots.js\":\"75a77f5d6093e0d1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/typedBlockQuery.js\":\"0a206f7871098abf\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/undoManager.js\":\"1b5599ea3f7163e4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/invalidation.js\":\"ae7d84cc9aa22e99\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelDataExtension.js\":\"0ab47e7d058b5c13\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelPage.js\":\"772eff931649060f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelValuePresetCores.js\":\"bd65ef3e36d7acb0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbCorruptionSignal.js\":\"53912fffa9745fc6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbStorage.js\":\"a69a07c4fc3eef5d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbVfs.js\":\"8f415b8bdeeb75b4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localSchema.js\":\"2532826d43160b77\",\"/knowledge-medium/pr-preview/pr-1849/src/data/maintenance.js\":\"d812d149e30fc278\",\"/knowledge-medium/pr-preview/pr-1849/src/data/mergeProperties.js\":\"4d6dcc7888367528\",\"/knowledge-medium/pr-preview/pr-1849/src/data/metricsConsoleHook.js\":\"d9acb5667593b162\",\"/knowledge-medium/pr-preview/pr-1849/src/data/migrationsPage.js\":\"04274e046a05707c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/mutators.js\":\"a07a6c8f92d818e1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/orderKey.js\":\"54d549398f4cc39e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/orderKeyPlacement.js\":\"9830d3ea4ec076d1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/outlineSurface.js\":\"75eebe2405343637\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pendingEditorContent.js\":\"965e9a81f885bd3e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pendingUploadsSql.js\":\"72f1e6d5602ebc45\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pluginStateExtensions.js\":\"281eeb153d97d020\",\"/knowledge-medium/pr-preview/pr-1849/src/data/powerSyncLogger.js\":\"3fa902b6da314e16\",\"/knowledge-medium/pr-preview/pr-1849/src/data/projectorRuntime.js\":\"f26a3b39dee3b2b3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/properties.js\":\"c73e74cf5c8113d0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertiesPage.js\":\"bb1565a322f7fc01\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyChildren.js\":\"63215bb213c08723\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionFanout.js\":\"c4a110389a9bd2a1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionMetadata.js\":\"4b1285cac7d02545\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionRegistry.js\":\"3fbbc5d66610f2fc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDisplayMode.js\":\"344a95f87b5381a7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyRowCreation.js\":\"1dc8cb818724e210\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertySchemaCreation.js\":\"e4f4ec879f81efbf\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertySeeds.js\":\"9c40b5056ccd35ff\",\"/knowledge-medium/pr-preview/pr-1849/src/data/recentsPage.js\":\"7adb056e3739c1d9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/referenceBlock.js\":\"5ace419e00c16195\",\"/knowledge-medium/pr-preview/pr-1849/src/data/rejectedUploads.js\":\"98ff66a52b33f2b4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/releasePowerSyncConnection.js\":\"804233e00f664d5d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/repo.js\":\"18dfd4b395a516b8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/repoProvider.js\":\"e57ac08a25c5c266\",\"/knowledge-medium/pr-preview/pr-1849/src/data/rowProperty.js\":\"55a3ce2a76579474\",\"/knowledge-medium/pr-preview/pr-1849/src/data/searchFilter.js\":\"7f9afafe766aff11\",\"/knowledge-medium/pr-preview/pr-1849/src/data/seedIdentityLedger.js\":\"5d0c0b9ab96f515e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/stateBlocks.js\":\"05945b86b2b141e2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/structuralEditPolicy.js\":\"9efab2e2aa2ea5da\",\"/knowledge-medium/pr-preview/pr-1849/src/data/subtreeDelete.js\":\"c719033440e145b5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncStreamLock.js\":\"b73ef3e9630d33fe\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncedTableSqlRecognizer.js\":\"2a73c6059fe4c435\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncedTableWriteGuard.js\":\"29d483ff6ccbbd02\",\"/knowledge-medium/pr-preview/pr-1849/src/data/targets.js\":\"2499d56fbc9e2e74\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeColors.js\":\"eec2db0da789cb82\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeDefinitionMetadata.js\":\"5e448f12deb8dd4c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeDefinitionRegistry.js\":\"0dc394c7ff8eadc8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeExtraction.js\":\"82f55f7c4dd228aa\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeInitialValues.js\":\"dd5c8515bc9532f6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typePropertyGroups.js\":\"29a1429becb630ee\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeSeeds.js\":\"429954cd3d307067\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeTagger.js\":\"c51023c10218d7d0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typedRecords.js\":\"a497fe2469298c51\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typesPage.js\":\"33f84e68d8e44bec\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userPrefs.js\":\"820e37aaead94ce2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userSchemasService.js\":\"d7e7d1a1f9a52f55\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userTypesService.js\":\"b7da9cff2340f636\",\"/knowledge-medium/pr-preview/pr-1849/src/data/valuePresetRegistry.js\":\"937eba371136618f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/visibleChildren.js\":\"612f90dc2029c84f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceConversion.js\":\"6b3de21da6cbbf9c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceFirstSync.js\":\"7fc16b88cd20e4cd\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceIdNamespace.js\":\"6cc6b67278ef5fe1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceSchema.js\":\"4ce17a4722197150\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaces.js\":\"9104d8aac600d92d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/writeAheadLog.js\":\"bb39f25432cf68bb\",\"/knowledge-medium/pr-preview/pr-1849/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/BlockPasteShellDecorator.js\":\"7ad60e50ea97ab5c\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/atTrigger.js\":\"91dab2ba54fc0458\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/autocomplete.js\":\"04cf8dc586372d87\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/codeMirrorExtensions.js\":\"913005b3801bd129\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/contentFlush.js\":\"d19dd4f133076749\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/defaultInteractions.js\":\"5d67d76c058a27fe\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/editSettleSignal.js\":\"7ff7181b36017c6f\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/insertImage.js\":\"e028820390fbe33b\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/referenceCompletionRange.js\":\"388815af47923d9f\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/referenceTargetTypes.js\":\"963ba694e2b9ad2e\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/syntaxContext.js\":\"5dfc08f1a7cb20c3\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/triggerMatch.js\":\"0beca88e495585b0\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/AppRuntimeProvider.js\":\"0d3df72c40ed7547\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/BlockFocusShellDecorator.js\":\"fbe221e794c83c3e\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/ExtensionRenderBoundary.js\":\"b75b335c6d0b7c6f\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/PanelContentRecovery.js\":\"c4cee334a3d3e828\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/apiCatalog.js\":\"d8d93709add86a48\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/approveExtensionHere.js\":\"18b3f75e795d29e6\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/armedCutAppMount.js\":\"3861e381b8dee646\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/batchableKeyedStore.js\":\"2a00d6c6d1288aa3\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/blockInteraction.js\":\"21458a977784e9ec\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/blockSelectionAction.js\":\"d4f12206e32cdb44\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/compileExtensionModule.js\":\"bcd8afa1693479e4\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/compiledModuleCache.js\":\"9f4c1f872eaac399\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/continuousGestures.js\":\"6d852387753795dc\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/core.js\":\"ff93addb66273f83\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/defaultRenderers.js\":\"c12e1fc1d03f5450\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/definitionFanoutAppMount.js\":\"bc5b843eccee0347\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dialogAppMount.js\":\"2f3ed624a7434a30\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dynamicExtensionSeeds.js\":\"bb6e6a8e93bcdcbc\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dynamicExtensions.js\":\"847bb4a749ba8079\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/exampleExtensions.js\":\"d9b7b03d825e7e9e\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionApprovalStatus.js\":\"373931bad2816ce3\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLoadErrorToast.js\":\"61424e9ceb03b067\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLoadErrors.js\":\"53bc07934621f93a\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLookup.js\":\"6975864f47f2fcef\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionToggles.js\":\"631368db049396a3\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionUtilitiesCss.js\":\"e7a2b320e26c963f\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/kernelPageDeletionGuard.js\":\"3ef3fd485cb2502a\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/liveRuntime.js\":\"4ceb4a4a92eaf507\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/openExtensionsSettings.js\":\"6e0e81c9c15f580b\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/overridesCache.js\":\"5e5fb22707e90b71\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/pluginIds.js\":\"001ebd6ab6616c85\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/processorRejectionToast.js\":\"40dddd9af055096a\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/runtimeActions.js\":\"a24c842683b6739f\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/runtimeContext.js\":\"3132e706440f655f\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/staticAppExtensions.js\":\"d8010430e214dbda\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/staticDataExtensions.js\":\"e2e1a51e0853c804\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/toastAppMount.js\":\"4a3efc03720f035e\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/useOverrides.js\":\"3a90f50b3c56daa5\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/useShortcutSurfaceActivations.js\":\"87bd03596840b12b\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/discoverToggleTree.js\":\"38b5acb06a2413e9\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/facet.js\":\"8f190443ea37761a\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/resolveAppRuntime.js\":\"e16f529e6968d443\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/runtimeEvents.js\":\"57a26ab25cdcacf4\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/togglable.js\":\"42f69bcb8a5a92d6\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/variantFacet.js\":\"62e62eccc75a31e8\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/verbFacet.js\":\"fe0a9a70a06e1c50\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/block.js\":\"d3444d40f0294671\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/focusedChild.js\":\"ddb6afbc9fd7340f\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/propertySchemas.js\":\"098944cd3d640446\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/typeRegistry.js\":\"2c3791e2230387dd\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useAncestorCrumbs.js\":\"9d0b74e4af4b118b\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useAutocompleteListbox.js\":\"94fb36da9567668d\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useDebouncedSearch.js\":\"cd70960d64545c6b\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useDebouncedValue.js\":\"0e0a951248714909\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useIsFocalRender.js\":\"9f38d24ec573045d\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useIsReadOnly.js\":\"3ef2d5b59920d3a8\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useMaterializeBacklog.js\":\"6da67fa3b69a4638\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useMinuteClock.js\":\"e9cc3a331d548f93\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/usePanelLayoutProjection.js\":\"3b293c766db4126b\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/usePendingInvitations.js\":\"e48038bfce443fdd\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useRendererRegistry.js\":\"0219e850a0f9a584\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useRetainedFieldRows.js\":\"19c2edb0b7321600\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useWorkspaces.js\":\"fcba061b449077be\",\"/knowledge-medium/pr-preview/pr-1849/src/lib/utils.js\":\"9bbb25646ceee91a\",\"/knowledge-medium/pr-preview/pr-1849/src/main.js\":\"7d2167f41d8c9423\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/MarkdownImage.js\":\"f8badd8fe7b24077\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/blockSeparators.js\":\"14ac10e951670ce7\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/context.js\":\"ec45b58aa18d00ea\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/defaultMarkdownExtension.js\":\"a3f91d71b8d81476\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/extensions.js\":\"f6b341d135f72b06\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/renderMarkdownHtml.js\":\"783ec530ed344454\",\"/knowledge-medium/pr-preview/pr-1849/src/minimal-editor.js\":\"6371ae62a500ca65\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/armedCut.js\":\"68ee71f602013c0e\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/captureMediaVerb.js\":\"c048638eff51bbee\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/clipboard.js\":\"feeaf2807ff6ef5a\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/decision.js\":\"a4df6a54d65e80c6\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/operations.js\":\"1682fdf1021272d0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/account-header/AccountHeaderItem.js\":\"08e8b5b9dd463c66\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/account-header/index.js\":\"aa203b864b8f4e7a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"460696fcda8aef29\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/askAgent.js\":\"506e6b9c75e6e1b0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/askedStore.js\":\"85f64c5b841dc8b7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d85cd81f9cef9b40\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/chipState.js\":\"d0ee74adb838ba8c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/dataExtension.js\":\"63b50d4848382757\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/index.js\":\"930e424f01609cf9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"0bebf4036df0381f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/schema.js\":\"2a2e7e2b96f8b2c7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f736676f4664408b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c66d3ae0929e1682\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/addMedia.js\":\"d05eead8952a268d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/backlinks.js\":\"54dd4127bd2b3d6b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/block.js\":\"a9f23650050a383c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/context.js\":\"a3b446bb7fc34745\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a308b637c475b7b0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/index.js\":\"4262fc798869f153\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/outline.js\":\"9fc69134fb5224ba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/properties.js\":\"252779f4c7fd30cd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/refs.js\":\"73ecf0d6df37fb65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d59b2e1ea39cd94f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/search.js\":\"b7311601fcc7037d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/shared.js\":\"0366ce68e0c906c0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"fab7bbf04f626051\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/text.js\":\"3c30471808d7da65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentWrites.js\":\"39e1d5cb758a8af2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/authoringCatalog.js\":\"9988d536f3affeae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/blockRefTargets.js\":\"a0e552e9a1252ba4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/bridge.js\":\"7e5f7ed84599ccf3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/bridgeLoop.js\":\"b8aa14daed8eb897\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/changeHistory.js\":\"045d2fb5388b79fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/commands.js\":\"174b44ddd2fcbf9b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/commentsCommands.js\":\"6effc7321fee7dba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/dataExtension.js\":\"3efaa201145e03cb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/dataModelGuide.js\":\"98dd79b4353ebeb3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/describeRuntime.js\":\"cb896a1f05ea32ad\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/extensionLint.js\":\"afa5e8f98c92b3e3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/grainAudit.js\":\"1683bc94d708e98a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/healthCommand.js\":\"14c182fda1f4f00c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/index.js\":\"854e605083c4b1b9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/presetIdentity.js\":\"4ed5ab140434ecfa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"43fde282673b56bc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/readMedia.js\":\"54f0bdc3caa4820a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/schema.js\":\"529caf6ee398f640\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/serialization.js\":\"ed03f3c38b268e20\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/targets.js\":\"1fc4c579f4a0e0ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/tokens.js\":\"9655243e654066ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/watchEvents.js\":\"81ea8723735a014d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/workspaceGuard.js\":\"a3da2cf357375e75\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/writeCommands.js\":\"c65e03b7d645c105\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/AliasCollisionToast.js\":\"b807e23c129f498a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/DuplicateNameBanner.js\":\"01ca48e4d232dfa4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/collisionMerge.js\":\"d6764f2fd4de1883\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/dataExtension.js\":\"6defd0d9ce671c46\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/index.js\":\"27384b4ee93c5e72\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/mergeCollisionAction.js\":\"58fbca42603e6c33\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/pageStyling.js\":\"2a3f88eeb501825f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/rejectionToast.js\":\"9223c367f6e8afe0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/syncProcessor.js\":\"fb8bc61e4f645bd1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/actions.js\":\"cc9eb2b0de89bc42\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/addComment.js\":\"b21021984a6c2e51\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/anchor.js\":\"9c62018c32a4b407\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/anchorState.js\":\"743f50bcd567cf53\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/commentLinks.js\":\"e6023dae66399c01\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/confirmThreadDeletion.js\":\"a0b6b1f994e6e307\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/container.js\":\"13287c49c6cd7025\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/dataExtension.js\":\"59f6364db743713a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/deleteComment.js\":\"95c9f516b3fad18b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/highlights.js\":\"b69b1828856e4841\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/index.js\":\"fc26bdec57ecc82c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/linkedCommentsPill.js\":\"0341ce2944ff65af\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/margin.js\":\"5daf35dfade89bff\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/marginSchema.js\":\"c07e37b4a53f55bb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/newComment.js\":\"80d048affe090b02\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/ownThreadPicker.js\":\"5f5d97f0b90afb72\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/placement.js\":\"23610de0c4b57c96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/queries.js\":\"99591e619255d322\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotePosition.js\":\"413806c8e43d028e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotedIn.js\":\"384aecc16f050e7f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotedRange.js\":\"3c23d95386abef44\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/rangeRefs.js\":\"818eaed3cbec1ae4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readHighlights.js\":\"e3ff0275843549cc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readSelection.js\":\"8dfc6e17a9857a4a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readSelectionUi.js\":\"ea9c35a56e5be188\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/reanchor.js\":\"3d13eec98981b27f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/schema.js\":\"c8aba8e096f24b24\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/scope.js\":\"57ffea99f75e5e54\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/scopeThreads.js\":\"605d8a79d108ef8a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/splitRetarget.js\":\"e1d9e70902ab05de\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/suggestionCard.js\":\"d49004081eb8d8df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/suggestions.js\":\"a8e67cf1802cdb03\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/summaries.js\":\"0e72ff4ebd6ceafd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/summaryBatch.js\":\"385131ae941caeb0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/surface.js\":\"ab6a888cfb508dcb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/threadNavigation.js\":\"8910480710c38e18\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/threads.js\":\"16e2f62d9cf269a0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/ui.js\":\"815707baa16cd640\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/uiStore.js\":\"b177f72de92c2f6f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-intents/appIntents.js\":\"436e162f67bc917a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-intents/index.js\":\"bd69bf85ac5e37f0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-update-prompt/index.js\":\"91e5fc41c19b737c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-update-prompt/status.js\":\"805104b6e9de1f0a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c17fa6f33a953ce4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaBlockRenderer.js\":\"6a4a9b5eb2db774f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaDownLaneReplicator.js\":\"3799a31ce5371f62\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaUploadReconciler.js\":\"4897b5d4b4c9e640\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetDownLane.js\":\"cb95361c71a3c6cc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetResolver.js\":\"dea6ac686b3adb78\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetUpload.js\":\"7c718cc587071756\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/attachmentCleanerIO.js\":\"195581411e134b7a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1a4e4935c01accb3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/blobStore.js\":\"13f8d354893f355d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/byteStore.js\":\"4bb516c5dd4ab680\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/cleanerIO.js\":\"87a00f648e636a56\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/cleanupAttachments.js\":\"332ab9f7807012fd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/dataExtension.js\":\"4010212b294ba4ab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/downLane.js\":\"0ad61fd718caf439\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/index.js\":\"23a5e966f1f3a110\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/insertImageContribution.js\":\"a63658a48ca28dc5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/laneArming.js\":\"6a1c20652256ffe5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/laneLock.js\":\"40e347fa818da09b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaBlock.js\":\"c0a8b5a91cbb21db\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaCapture.js\":\"ab5137eb08d8ced4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaViewers.js\":\"0fe700e834e63927\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaViewersFacet.js\":\"a4f7e96b98a393ac\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/pasteCapture.js\":\"0d36c9febd6fa7a0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/resolver.js\":\"2624727da99b1fb6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/retryUploadsAction.js\":\"2610355cc6de9f3b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/storagePaths.js\":\"8056e479cacec2e9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadDrain.js\":\"c16dd686def37778\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadLaneStatus.js\":\"28b1f7f585ad37e3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadReconcile.js\":\"008840e9007b7e0b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadRecovery.js\":\"9380856cfa581ede\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadStore.js\":\"803af80e85bb7798\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/useAssetObjectUrl.js\":\"1f42d856f02b0124\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"050c669af6fcb96e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/BacklinksViewSection.js\":\"14c8be1b9db58402\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/facet.js\":\"e44ec451d570e313\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/index.js\":\"0419397fc6639fa1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/prop.js\":\"3155b96eab247b40\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BacklinkFilters.js\":\"8ec992293d8b2b71\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a8b7dd87b109f200\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BlockEntry.js\":\"449694cc953740dd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/LinkedReferences.js\":\"6e18360597595e7a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"645154a27c10a92b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/dailyNoteDefaults.js\":\"4b2f6bf3ec930c13\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/dataExtension.js\":\"a75122edca04df06\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/edgeExclusions.js\":\"d405ad173e5cf384\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/filterProperty.js\":\"1598e5b6cc4bce5e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/index.js\":\"8d86316643f11915\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"822d292733755468\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/applies.js\":\"cd821bca6012d2d5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/countQuery.js\":\"a8b031351af87dba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e700c9b2f23bd025\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/index.js\":\"ae3a3606e76c585a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b914550bdf6e25b1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/presentationInvalidation.js\":\"147c565c642829b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/propertyEditorOverride.js\":\"4d7205f816fac837\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/propertyFilter.js\":\"acba3601122c11ac\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/query.js\":\"916a5a72e45fb66d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/resolveFilter.js\":\"778d0a276634a469\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/sourceBatch.js\":\"39e345ea853d91e8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/sources.js\":\"f4c0599d936aa6f0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/useBacklinks.js\":\"92795741f4c1c6e5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c0683efc6ef9e29b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/BirthdayCelebration.js\":\"9d4b3b2f40530532\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/BirthdayOverlay.js\":\"0097dabdf2763356\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/gate.js\":\"9383dc56e903329e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/index.js\":\"e3fcc7862efdef0b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/wolfTheme.js\":\"bbd8dc76e600b857\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/BlockDragLayer.js\":\"b575cb0029eee426\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/dragController.js\":\"1a4ad2cdbd4303d2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/dropTarget.js\":\"73328a432cda3ad6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/index.js\":\"7d68f5a9fd143f23\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/projection.js\":\"53221d0910dbd94e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-info/BlockMetaCard.js\":\"0cbe8f3779c9336f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-info/index.js\":\"7b8cd97e01bd498b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/AddTagDialog.js\":\"77af26b05a0995c9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"eeed63bba8a55e8f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/TagNameIssueHint.js\":\"ce04269c0cacb0c5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/addTagAction.js\":\"460df4b172945a26\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/appendTag.js\":\"99b74075b58a922e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/config.js\":\"8a0ca7827cbfda4a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/dataExtension.js\":\"f18818fdba6eedde\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/index.js\":\"f48b15b1f1bf850a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/propertyEditorOverride.js\":\"2cbe9a0e757d7419\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/BreadcrumbList.js\":\"46ef38e900888304\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"95095e387a3485da\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/Breadcrumbs.js\":\"95fe21c40d58fc63\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"715872fdbdc6a859\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4e85828c44b1e5cd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/index.js\":\"2701eb676660c053\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4b85c2fb835b0d00\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/CharacterCountItem.js\":\"a1ba6303d6e5d75b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/ProfilePropertyEditor.js\":\"65b75e09d5a2207e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/actions.js\":\"0c25ddec93752c0b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/blockType.js\":\"dbae0b419ab5468d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/charCount.js\":\"cb0f7cbd04bc80f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/dataExtension.js\":\"56852c565eeb19d0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/index.js\":\"b4d1cf29544c41c5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/profiles.js\":\"9e376916b981a4fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/properties.js\":\"736d77e3563a91f0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/textCounts.js\":\"b9622d8bd813c458\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/colemak-keybindings/index.js\":\"bafc9517f2e88a50\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/CommandPalette.js\":\"ec456a30e80b4d6d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/HeaderItem.js\":\"ee03349026f798fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/context.js\":\"e939324eb5d81078\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/index.js\":\"f9ada216d8895665\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/selection.js\":\"08700e0f03bd56e8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/toggleStore.js\":\"595201c7b9861037\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/useCommandPaletteActions.js\":\"a9d4bf31127f5640\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/ContributorBadges.js\":\"6adc53d349e2caf0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/author.js\":\"49777a165fbe403f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/codeMirrorExtensions.js\":\"e67efd4ad69622b5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/dataExtension.js\":\"5f396a59953f337c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/index.js\":\"845ca3a3b2ad1a99\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/mentionAutocomplete.js\":\"828c562ea01cbd82\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/processor.js\":\"eb9d86a288fb3389\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/profiles.js\":\"07b1a6e6373af851\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/queries.js\":\"5ba5b388cf75851c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/schema.js\":\"974f32f271def568\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d3eabd6a187e5b38\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b45d9cd490ff606d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/index.js\":\"057911197e4be42b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0df385b52d6fa293\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"11bff6ee2c2ac067\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/CalendarGrid.js\":\"f1d8e3eb7363c21f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DailyNotePicker.js\":\"90d5d68c7ced85d0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"473f66975d17bba3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateNavDecorator.js\":\"a0c26613d033f51f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateScrubOverlay.js\":\"a22d1bce9af439ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/HeaderItem.js\":\"e0188195cbb7371d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/ReschedulePicker.js\":\"252d6d5d72f28e8d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/SpreadDatesDialog.js\":\"47843c9a70d0becb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/actions.js\":\"de59d879dbd8a9f1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/blockDateAdapter.js\":\"bc87297b15fce917\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/calendar.js\":\"ea62ecc85d8731cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dailyNotes.js\":\"27d995aa2cf40e58\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dataExtension.js\":\"715878e68e2aaaec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubActions.js\":\"5dc99e7b491aa7fe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubGesture.js\":\"52625031bf1a77fd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d22b82d51a193a72\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubRecognizer.js\":\"23bcf45f91f68bae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/deletionGuard.js\":\"4be83f0112894864\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dueQuery.js\":\"ab47f85c266e704e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/index.js\":\"33b555f72268860c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/landing.js\":\"edf3e688171cb9b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/localSchema.js\":\"f23bfa4b3e8839c9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/referenceDateAdapter.js\":\"8f8fb90bfdee0e2a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/rescheduleAction.js\":\"d96ca903131e548e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/schema.js\":\"8c7ea5bc26581195\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/spreadBlockDates.js\":\"921087cc10a9376e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/spreadDatesAction.js\":\"08a5e2e19d5b9ac4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/today.js\":\"afca644613feaf76\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b917842ed35d496e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"dae4edefef37b72e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/audit.js\":\"2250394a3f5ad5f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/auditAction.js\":\"2a7dc183388369de\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/auditRanges.js\":\"023084fb578dd803\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/diagnosticsSource.js\":\"2ae1adceeca778f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/divergenceScan.js\":\"acc6e0a122445a7a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/index.js\":\"32a2859909a835ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6ec671679dacee8f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/referencesMirror.js\":\"1c101bda7d4d3a71\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/rowJson.js\":\"c7f80875515e362c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/schedule.js\":\"be5f55cb422c8038\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/store.js\":\"c02933ec0134d6d8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/action.js\":\"9a917546ac18b5d1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/index.js\":\"610a465cfef4b13a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/plugin.js\":\"4958e97bbee08f30\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"60cacd759487f18e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/actions.js\":\"30fbea343387c2d8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/changeMarker.js\":\"a0e8eb989a005f9f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/diagnostics.js\":\"12d4aab13ad32eca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/fileSystemAccess.js\":\"719af3b339afe361\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/filenames.js\":\"ecc0b0640219a886\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/index.js\":\"c622b8a6a9635b79\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/mirror.js\":\"4219e18f08c96b55\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/runLock.js\":\"7a6f60ea8a082854\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/runtimeHealth.js\":\"f771d4dacb5a4825\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/schedule.js\":\"8b0fa786737c6f1e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/store.js\":\"962df84eff0b6a20\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/default-themes/index.js\":\"42206850005b8195\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/default-themes/themes.js\":\"613dc8b648c9c89f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/diagnostics/facet.js\":\"5fe28ebca9e5f4fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/diagnostics/useDiagnostics.js\":\"a75c28624a3030b8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/dismissals.js\":\"45ce7bec560f4b3d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/index.js\":\"7b64b07690d9c313\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/status.js\":\"e8221fe3ab684cc9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/store.js\":\"a428abcb7b521ad7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"53fa85a6774aa67b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/ExtensionsSettings.js\":\"42a2ada6e98cd0e7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/actions.js\":\"5de5db0eebec7267\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/config.js\":\"bd1d7e1943fc9be7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/dataExtension.js\":\"2f0f4480a865c385\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/effect.js\":\"7bc0f274b4d029d3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/index.js\":\"40822f7091b48dcb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/propertyEditorOverride.js\":\"66a124ec605293e0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/useToggleTree.js\":\"5f21ab276907f8d8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/ExtractTypeDialog.js\":\"a645bd0706342a77\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"66375332e333b276\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/PropertyShapePicker.js\":\"a8812ed2b757efd0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/action.js\":\"7fed37a5936b1cc6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/index.js\":\"50742b439b72368f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/FindReplaceDialog.js\":\"f6012d1730d460dd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/HeaderItem.js\":\"e4f20fcd3821d0e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/dataExtension.js\":\"41c525972d7a22f1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/index.js\":\"fb215460dd281d18\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/search.js\":\"f32ad06d672adfa6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/toggleStore.js\":\"be5d6b52bcbaa857\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/LocationPropertyEditor.js\":\"b391ccfd22878a8c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/MapView.js\":\"f32005ca47a616ed\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/blockTypes.js\":\"181e17f21986196d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/codeMirrorExtensions.js\":\"ad149c20de915d3d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/createOrFindPlace.js\":\"a15a9df8fc497a1b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/currentLocation.js\":\"df43c6448391bf8a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/dataExtension.js\":\"9569ab4d9b3cb623\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/geoContentDecorator.js\":\"8f1031bfcc8f681d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/googlePlacesClient.js\":\"369bfdc743a8a2d0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/index.js\":\"75f8b4f0528baf6a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/locationsPage.js\":\"8ac01716eae0c3f9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/mapViewport.js\":\"967bd11164d72842\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/pickCurrentLocation.js\":\"add134daf18cfd4a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/placeAutocomplete.js\":\"fb4f96d42c803c65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/placeNameCollision.js\":\"aaf1a3223b40a441\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/properties.js\":\"ca642ca0d372afe0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/propertyEditorOverrides.js\":\"8e096596d15b3514\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/query.js\":\"0516f064bd95ce2e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/usePlaceSearch.js\":\"7e23dab1a02822f1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6c2c6f551c49bade\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"89803e1f785de3c2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"92bc4d22c81752b0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/config.js\":\"1c9809d17bc55345\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/dataExtension.js\":\"b18fe999b0d460b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/facet.js\":\"b13644ce9223f945\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/grouping.js\":\"b3b4559422593083\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/index.js\":\"c7392ac7474f49c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6f9a40c17c040fd1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/query.js\":\"ccbe6719c5c73375\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/resolveConfig.js\":\"662d33aa96c2069a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"21d836ecb44bd5be\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6b26a3a9b3d191c9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/HtmlDocumentContent.js\":\"d77515dbad97e24a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/HtmlFrame.js\":\"fa791351c69a9ea3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/actions.js\":\"4b9abc646c6d2c85\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/blockType.js\":\"f431039a2eaa95ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/confirmRunScripts.js\":\"96c0cd9be12bf6dd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/dataExtension.js\":\"0143b4e7dc9986a0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameAnnotations.js\":\"3ef39f4c27d174b7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameDocument.js\":\"dc41ab76fb6cdb02\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameTheme.js\":\"ec8bc873dec82afd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/index.js\":\"79ffbbec24bcf4df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/scriptConsent.js\":\"7ea343953598635b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/sourceMap.js\":\"5b0b863b4f13e062\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/useDocumentScripts.js\":\"200f160bf36bfbb6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/index.js\":\"00472e036815d469\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/record.js\":\"26b5644a8d2a0dce\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/recordStore.js\":\"68adc013faa7b7e2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/responsiveness.js\":\"26782d1664059348\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/schedule.js\":\"20536300654a4fc5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/sessionContext.js\":\"93a83fabe35e09dd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5ff584b25f1cb13e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2d6f35e128bfdbb5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/actions.js\":\"71616f12a37f9931\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/config.js\":\"325872bde465643f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/dataExtension.js\":\"2337644a566e1d1f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/effect.js\":\"9691d7e49dca0bbc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/index.js\":\"467263414e7067d6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/keyCapture.js\":\"7e05bda2c069c3e8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/overrideStore.js\":\"1c6bcc3576d6837a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d7f52f3a6110266a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/HeaderItem.js\":\"36b885362ee5e868\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/LeftSidebar.js\":\"b89f2ed16577b70a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/actions.js\":\"9b5a0752a9d203e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/facet.js\":\"c9ab321874cb054b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/index.js\":\"f3655ff545f298c5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/shortcuts.js\":\"01d14009486fad23\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/toggleStore.js\":\"b25fc9eb1d495d51\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/MergePicker.js\":\"68977cd27503a1b6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/index.js\":\"7933db871abf4ec9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/mergeAction.js\":\"8263d275b7333749\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/strategy.js\":\"0b2777e77afaef0b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/Button.js\":\"555ed01d2f45b122\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f01c12d0d34d4a77\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/defaultItems.js\":\"fc53082c5dd88dc6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/facet.js\":\"57736b716218f34e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/index.js\":\"84d36b0d935d3b6b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"5555758c1c64cad3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0a1c25cb950f8173\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"bab436fc2d1b5f20\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/facet.js\":\"dffd17a5eafd2d5f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/index.js\":\"40aa43831cf3bf01\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ac92717f359a8d73\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1ad0dbe5b80bf5ce\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/contextMenuItem.js\":\"cdfed63f1a981827\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/index.js\":\"621a0d0257fa2337\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/moveAction.js\":\"0f9e076963f80e87\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/moveBlocks.js\":\"8172433fffe593fd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/selectionAfterMove.js\":\"e9e4d557bfdf16a7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/TutorialBanner.js\":\"9631b2daa81261fb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/action.js\":\"cf31247d18b1633f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/bannerDismissal.js\":\"97cc7371a6dcd513\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/documents/cheatSheet.js\":\"0e1ad97b1ccfe8d6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/index.js\":\"e3cccc15090ceffd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/keys.js\":\"a167fcaefd505b2b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/landing.js\":\"2bccc7c5532ef6c7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/outline.js\":\"0f8d7d7258cab496\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/seed.js\":\"bce56aaa4b85a417\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/PerfTrendDialog.js\":\"cfd543d2cb8e5cc7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/analyze.js\":\"0fd73a1a81063b02\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/diagnosticsSource.js\":\"0549b46d18b77c49\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/index.js\":\"09cd139156721784\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/load.js\":\"257f33fb8944636f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/monitorRun.js\":\"7540ffb0bf49cc18\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/schedule.js\":\"a56d0b1da8fbba1a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/series.js\":\"d467eebb633f1e9a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/store.js\":\"bec27fe7baf7a5c9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/trendAction.js\":\"ad4f4becf94486d5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/verdict.js\":\"b36d471944fde51b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/clickToEditAction.js\":\"d254e1311cefec3a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/index.js\":\"8422d6a7b9253ed1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/interactions.js\":\"36a89680041d4c32\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d6c530d0baf56e8f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/MigrationGate.js\":\"404908c4724895c1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/MigrationGateDialog.js\":\"65b8901c7a278d0c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/action.js\":\"57d4464d7c31b3a2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/index.js\":\"e662f0a2f4d5d78a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/localRunMessage.js\":\"2766f45c6bbc7018\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/plugin.js\":\"a2ebafcab9ba34e8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/progressReport.js\":\"23caf29f81b61bf7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/sweepProgress.js\":\"5a420a32ab233b28\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/FieldRowRenderer.js\":\"7c632b59f13ea802\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/ValueRowRenderer.js\":\"261fc544ea1de7d3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/actions.js\":\"dc9d709f4e988b95\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/autocomplete.js\":\"7cc901be1a7ab8cd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/fieldRow.js\":\"42fe8e19cd54cb3c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/index.js\":\"0ef7877d92c94844\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/referenceWarning.js\":\"b02a5da5a98de755\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/valueAutocomplete.js\":\"5792d4f18440a827\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/valueSchema.js\":\"022259a396cc9d2c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/HeaderItem.js\":\"c2a8f183aa456d8c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/QuickFind.js\":\"007f5fa2163f2d2b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/index.js\":\"65c689a372357b99\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/recents.js\":\"40159abd3185ebe9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/resultItems.js\":\"40bb118fee72a42a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/selection.js\":\"17cd90485b04c52f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/toggleStore.js\":\"02665b4c8e05c98d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/HeaderItem.js\":\"c39f70ce2bf49120\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c124984f394527bb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/grouping.js\":\"51e721f8d4bb600f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/index.js\":\"1423e83d543bf48d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/target.js\":\"3664152e05656640\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/codeMirrorExtensions.js\":\"9a48302b781af949\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/contentPrefill.js\":\"9ce384dd1f176310\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/dataExtension.js\":\"1e160cd5fb9856c2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/index.js\":\"1be1956692d4809c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"823bda0a8573ed57\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/invalidation.js\":\"9356cc376c17e6ae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/localSchema.js\":\"665ca5290bc4d6f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/blockrefs/index.js\":\"97e65091a12ddcc5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3134534f3dcaee76\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/index.js\":\"3c794b3d2e55e7e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/referenceNode.js\":\"3bdb87e74260d66f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/remark-reference-occurrences.js\":\"62bb356a77202a34\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3834936d53de889c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/index.js\":\"31b3fea3cff3f364\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5e89b2cd710cc1aa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b24e4722e9eb7cca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/mergeRetargetProcessor.js\":\"b59b8281bc2d215d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/parseFence.js\":\"80d77a00ef7c88a9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referenceParser.js\":\"f684f26ecf8fa016\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referenceProjection.js\":\"356818978e44295c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referencesProcessor.js\":\"1f4511d7f4d07e7e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/renameProcessor.js\":\"6e22dcdfb70e8067\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/spanReplacement.js\":\"f24e4228699bd033\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/htmlToOutline.js\":\"8470b88eb0e6a87d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/index.js\":\"c89d1bb655d7ac98\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/normalizeClipboardDom.js\":\"adfd879e61151870\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/pasteDecision.js\":\"c5a9c92f0eedffaa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/action.js\":\"6779c8af875a4122\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/blockIds.js\":\"428149206b0d2093\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/content.js\":\"879eced57b79f482\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/effect.js\":\"50b0e17c3b1bbac0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/ids.js\":\"509f0e58a9c30489\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/import.js\":\"31ef8386512f6bca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/index.js\":\"4c2e45f5b049fdd8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/plan.js\":\"09ae8b5d551ca3e3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/plugin.js\":\"ba1396a4a62cc9d7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/promotion.js\":\"6e5436784c3512ad\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/properties.js\":\"c093079160e74733\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/references.js\":\"d725038cb7553b6a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/report.js\":\"768e3f3ad4326005\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/roamMemo.js\":\"25ac62d391ab8518\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/runtime.js\":\"a4746e3b78aac80b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/schemaReconciliation.js\":\"a3a54b42710a7131\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/srsMarkers.js\":\"e143bf8ab437a6fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/todo.js\":\"05be6d1ad1f454f0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/typeCandidates.js\":\"c7eb219c1ea240be\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/types.js\":\"e9a963f18d7fd4fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/search-health/index.js\":\"f6fc761f0e010f8f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/search-health/store.js\":\"683ef74793103c83\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/HeaderItem.js\":\"230ea5aceca40023\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"78f328c1c274c4cd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/index.js\":\"4913734b5d768c35\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/model.js\":\"8dee77e4c6194dd9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/toggleStore.js\":\"3138ac024825d86c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/useKeyInspector.js\":\"39274dfeedd4539e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c1a5c3d4347af33a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/ShellDecorator.js\":\"dd960c1967050b35\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/actions.js\":\"aecb6937bd4b5bfa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3caf3804bdaf5537\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/index.js\":\"8a9c47fb62f07c9f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/shell.js\":\"c698bc8c6897ba4f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/surface.js\":\"7068e51ab6ebef46\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/walker.js\":\"5c6ea29a1d7dd4e2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5b849b726328921e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/dataExtension.js\":\"d4db461fc3b473d5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/index.js\":\"b630c435665a2bca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/indicator.js\":\"d8131c6f3a5dcfbe\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/moveSrsState.js\":\"f10aa35cdc99f196\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9fbe48dd3c97c086\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/scheduler.js\":\"c5556e0ab98c99df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/schema.js\":\"edf9f7fc62a2f345\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3e39f111672ddea2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/srsClipboard.js\":\"a93ad4c1cdc68f57\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"aa181066b172939a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/DailyNoteReviewHint.js\":\"42a410d9d9c0858c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/DeckPicker.js\":\"9b34d985a8bb6933\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewControls.js\":\"b1ac99f33b9c51b7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewDeckRenderer.js\":\"714156a3ab20fd7c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewSession.js\":\"dd450ef997f21bfa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/actions.js\":\"a86304a775cc9a65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/archive.js\":\"e90549b855c38a1b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/dataExtension.js\":\"e05490ad390bd4c3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/deck.js\":\"2a3f11a0b45df5c3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/dueQuery.js\":\"8086f51c12c14d61\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/gradeDecision.js\":\"021682015bcd2961\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/index.js\":\"d956f1221ed88307\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/keyHints.js\":\"1062f372b7980bfb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/reviewCardLayout.js\":\"bbf38607b7ec70e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/reviewProgress.js\":\"c83fe3acf5afb63f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/schema.js\":\"dd2ce32771f2c6a3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/useDueCards.js\":\"5941aed3520f15a0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/startup-metrics/index.js\":\"b0e47db1a267125f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/startup-metrics/record.js\":\"34cbb344f412ef05\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/index.js\":\"22b7712587b095fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/persistenceStatus.js\":\"4e719b62ff8eff11\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/requestAction.js\":\"59e4a462058a2888\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/TypeChipsDecorator.js\":\"38a2b43fe376f394\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/codeMirrorExtensions.js\":\"34b78eb333c330e7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/index.js\":\"6c7cda4ba24b2855\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/typeAutocomplete.js\":\"2087aae385b6e094\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6a42ec3ae1ef8d57\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/actions.js\":\"1d9dff998946ae31\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/anchor.js\":\"6139a7e7847febea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/events.js\":\"28e1c02ec8088503\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/gestureActions.js\":\"cd70bfa831d3b7be\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/index.js\":\"f47dcbd35a95d397\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5664a1b5bc29096e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/collect.js\":\"1635c3e086c7b2b7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/index.js\":\"cf83b9d6e0f1f240\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/record.js\":\"0b5e6fa6415cea9f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/RejectionDialog.js\":\"f3ba5665db044c50\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1bfec33072403437\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/index.js\":\"f14609f737c22a1f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/model.js\":\"1938250cfa600217\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/queueCounts.js\":\"a1960498a1ef2b48\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/rejectedHelpers.js\":\"b4287f6090ae0970\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/rematerializeAction.js\":\"331595bbcff32ac9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/useHysteresis.js\":\"d494dc229b8ed7b4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/ColumnHeaders.js\":\"9ef22de84b1abeb7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/QueryUi.js\":\"1b49187e202cd52f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/TableLayout.js\":\"4dfd8d654f366f31\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/actions.js\":\"ae5ea3661b8671c7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/cellEdits.js\":\"306640779bdfd640\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/columns.js\":\"1dd9cdce58fa1614\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/controller.js\":\"856c67810b749d1c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/convert.js\":\"cf9d0bca13effe89\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/dataExtension.js\":\"37157e063ab7609b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/index.js\":\"1d0b40d1908ba698\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/keys.js\":\"3f04beedc51f3e71\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/model.js\":\"0ec3845a82bf41c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/backfill.js\":\"81da870b5f377838\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/format.js\":\"9a1aac33a7192356\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/parse.js\":\"3467239c5162d0f0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/queryValue.js\":\"b99eddb30abc4e0f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/source.js\":\"a838a2bbd2f770f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/registry.js\":\"bc3f0fdd3f8e128a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/schema.js\":\"7ebf9ab8fe9f4453\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/sort.js\":\"15ff151c583b2f69\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/effect.js\":\"2d7cae1dbe83bffc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/index.js\":\"bfacd40704269980\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/theme.js\":\"9bede12d9e98476c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/actions.js\":\"08ec35350eb5cd38\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/dataExtension.js\":\"17c5603c6a08ebb6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/index.js\":\"f5a591cee9ee6681\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/schema.js\":\"1d8978e6d64a509a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/TouchSelectionLayer.js\":\"bcef121b1fb34c24\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/actions.js\":\"c806650ec843d371\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/defaultItems.js\":\"a9d04b98aabd48c3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/facet.js\":\"e42e31743e171e9a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/holdRecognizer.js\":\"a9093d61f3c7847e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/index.js\":\"2182dc3f16f49601\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/UpdateIndicator.js\":\"303551ef8569dce6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/index.js\":\"2ff8e804afba28ba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/loadTimes.js\":\"9b391b9fc826c361\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoNotesRenderer.js\":\"1c2466e29987892c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoPlayerRenderer.js\":\"108ea3ca1799be96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoTimeStamp.js\":\"ff535eaa92866c34\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/actions.js\":\"0deebc3299a67d59\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/index.js\":\"3d8f3e829121de16\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/markdown.js\":\"a290cda764f040b9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/notes.js\":\"44c6f8ce9c3580e3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/registry.js\":\"88484fb2f8c20896\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/remark-timestamps.js\":\"82129060031c4fa2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/view.js\":\"ad485fb5ba300509\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/LinkHints.js\":\"fef87c10a785f8f6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/index.js\":\"f4a92959fa66ece9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/model.js\":\"cf1fe6d761610126\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/settings.js\":\"fe52ad0a1f20e4fd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/actions.js\":\"9818863705563093\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/index.js\":\"ee17510492103a65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/interactions.js\":\"2c33d54f9f833041\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/workspace-header/index.js\":\"2820c6f36102bf04\",\"/knowledge-medium/pr-preview/pr-1849/src/registerServiceWorker.js\":\"673cb7bf890f8973\",\"/knowledge-medium/pr-preview/pr-1849/src/requestPersistentStorage.js\":\"97010bd7bb98d820\",\"/knowledge-medium/pr-preview/pr-1849/src/services/authRequestDeadline.js\":\"88b7a2cd5f3c3584\",\"/knowledge-medium/pr-preview/pr-1849/src/services/authStorage.js\":\"c6d6c7b0b802805f\",\"/knowledge-medium/pr-preview/pr-1849/src/services/powersync.js\":\"b3f32592d0b43c20\",\"/knowledge-medium/pr-preview/pr-1849/src/services/supabase.js\":\"5a896c5418062a5b\",\"/knowledge-medium/pr-preview/pr-1849/src/services/uploadErrorClassifier.js\":\"dad3f408c1356109\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/ActiveContexts.js\":\"372eb48920804922\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/HotkeyReconciler.js\":\"a33dcf05b6e9a5dd\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/WipeLocalDataDialog.js\":\"6d2f9c985e552ec9\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/actionDispatch.js\":\"7035c2038213f377\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/actionRefItems.js\":\"563b2a31ebb560f5\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/applyKeybindingOverrides.js\":\"53be623bdaf413b3\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/blockActions.js\":\"72b77a51df69d4e1\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/canonicalizeChord.js\":\"c2aa9850d7564f30\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/defaultContexts.js\":\"53c60ae1ad14f2a6\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/defaultShortcuts.js\":\"78fa99b31db7e9d4\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/effectiveActions.js\":\"7605a69541b0ae5d\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/gestureAction.js\":\"1b78f2fa4a1bdca8\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/gestureBinding.js\":\"0987e369ed0a521e\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/holdRegistry.js\":\"f66cb772af12410d\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/keybindingConflicts.js\":\"7746850f84c8338c\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/keybindingOverrides.js\":\"5bf24be25a60cc01\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/pointerAction.js\":\"a1b8bb633aa4ede9\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/resolve.js\":\"96a2705fc64db720\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/runAction.js\":\"a131bf534c5ea0c9\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/sequenceMatcher.js\":\"cd0b27ecbe10df2f\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/types.js\":\"1cd8af96d6214be8\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/useActionContext.js\":\"4ebac2e2d174a5a9\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/useActionDiscovery.js\":\"5cb3da00a527b9c9\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/utils.js\":\"df2fd98c73cd569a\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/bootStore.js\":\"3d20a64414746cd7\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/previewDatabases.js\":\"fcbbc910252a6231\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/byteTransform.js\":\"0e43fa7eeee98d4b\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/attachmentCleaner.js\":\"92045c969056f6d3\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/attachmentParts.js\":\"3c1075c3be028b63\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/bundleParts.js\":\"9c2677e436e6394f\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/bundleRecord.js\":\"a9feca8f91fff101\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/manifest.js\":\"70b87a9ba875fb70\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/takeBundle.js\":\"fd3242b46b6b8e33\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/verifyBundle.js\":\"1789fa54179163a5\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/cleaningStage.js\":\"cac55c16f2df62e0\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionKey.js\":\"658e7753c8c0f7be\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionServer.js\":\"6e5e58a39e6e395e\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/flip.js\":\"ae55e7e4ccbd573a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/flipAttempts.js\":\"38a0bb377c1e7538\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/pages.js\":\"0aac7c239b8476b7\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/preflight.js\":\"d45537b1157fcdaf\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/reseal.js\":\"0d5232de5b94028c\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/runConversion.js\":\"0b0c6a6d492bd923\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/runLock.js\":\"2b7799dcec3ac84c\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/sealing.js\":\"2b5561b586b8338a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/sealingStage.js\":\"01a04b8e1c352a87\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/stage.js\":\"dcfa7abbbd960c97\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/verifyReseal.js\":\"64fbbca2ab289be9\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/aad.js\":\"fbcd91b4d0a0c56e\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/aead.js\":\"7fc2d0ef65a17816\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/base32.js\":\"b59be62d1b45f5ff\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/base64url.js\":\"8970ca5135ec4e84\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/binaryEnvelope.js\":\"a79adba107d177b6\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/byteAead.js\":\"f2e9c8f2aa883305\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/canary.js\":\"abdce30fd23b78fa\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/contentHash.js\":\"45d1a3f6546a23cb\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/contentKey.js\":\"5c22cfc623de2c4a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/derivedIdNamespace.js\":\"4e272500c2b32b1d\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/envelope.js\":\"4d256d6de28c2c3e\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/hex.js\":\"829fb3175227cc83\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/sha256Hex.js\":\"924d1b6a43d30a8a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/workspaceKey.js\":\"5418b9a0f628b882\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/conversionState.js\":\"287d90ed51399451\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4ebf7aef7342bf4c\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/pastedKey.js\":\"61d128afa76c8145\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f18eca269843c87d\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b8def74bbfa5ce04\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/keyStore.js\":\"1b9218e4284eb3a9\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/mintWorkspaceKey.js\":\"1ba4087855ba23df\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/modePin.js\":\"b2310ef2a2b22df9\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/openWorkspaceKeys.js\":\"57c8158cdb3747b4\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/resolveWorkspaceEntry.js\":\"58a05bcb4459469b\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/resolver.js\":\"f9b7b124d415db3c\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/workspaceAccess.js\":\"4e4f22c2398455e5\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/transform.js\":\"ecc38ab461ca72ef\",\"/knowledge-medium/pr-preview/pr-1849/src/themeBootDefaults.js\":\"ee48b3478b645097\",\"/knowledge-medium/pr-preview/pr-1849/src/types.js\":\"d016df549f3cced0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/ClientLocalSettings.js\":\"3374245092925c84\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/abortableSleep.js\":\"ec7df3b71305b84d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/array.js\":\"3ac7791b7327f7ac\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/backlinkAutocomplete.js\":\"077cf09f3d09f8c4\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/blockCrumbs.js\":\"0d54801d055f66ad\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/blockrefAutocomplete.js\":\"fb8e679977701101\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/cadencedIdleJob.js\":\"64d6961227d5c068\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/callbackSet.js\":\"517db042be964567\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/clientId.js\":\"e53efd151c7b49cc\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/codemirror.js\":\"29c625e008bd6bb0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/codemirrorCompletion.js\":\"d4e4415e56889e2b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/copy.js\":\"fa7fa0f6a1220414\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dailyPage.js\":\"31ea6b9eb6998054\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dbForensics.js\":\"6cc11ff9ebe80a79\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dbForensicsHooks.js\":\"c85ddeebb82769c0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/deleteBlockThroughUi.js\":\"4faf83f4ea2665d2\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dialogs.js\":\"a09c65c9b0cc2d54\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dom.js\":\"ae20a1300ee1255d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/downloadBlob.js\":\"8d1e9cc5879979cf\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/exportSqliteDb.js\":\"c41b754f0fb81b90\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fileSystemAccess.js\":\"5520ae8278d63cc9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/flipSlide.js\":\"6684d5b46e26734b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fnv1a.js\":\"d8710fc3d87d5ed7\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/formatBytes.js\":\"fe192658b112193f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fuzzyRank.js\":\"0f45df873f9f1b83\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/idbKeyedStore.js\":\"006215ba7e066b26\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/idleCallbackPolyfill.js\":\"0c2b9d7a0a51f0fe\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/keyboardAwareScroll.js\":\"401e71f341d8253e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/keyboardViewport.js\":\"03e605c9a325a9d9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/lastWorkspace.js\":\"56a403179ad6ffc0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutColumns.js\":\"424dff3c40850677\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutSessionDom.js\":\"0d3ff184d25b6c62\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutSessionId.js\":\"ad1e0894154f3b41\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/linkClickGestures.js\":\"7e399ce336f91d02\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/linkTargetAutocomplete.js\":\"87d2e014aaff1d3d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/localDbCorruption.js\":\"0cca0bc0a0309e7d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/localDbRecovery.js\":\"487c5477d92333c4\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/markdownParser.js\":\"f85d83a1a90676b9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/memoize.js\":\"dc3b034f7d0b8b27\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/nameFieldCommit.js\":\"60e3a6e54b07750e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/nameList.js\":\"32cb9bc7141573ac\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/navigation.js\":\"5e8dc7275b02c57c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/omnilinerNamespace.js\":\"4961e5e8cacaace7\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/opfsPageScan.js\":\"6147599d5a751c95\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelClearance.js\":\"863517e2bf079540\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelHistory.js\":\"4dca95d1062c191c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelLanes.js\":\"93ee6e083c3f480c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelLayoutProjection.js\":\"ea17069dcac2093d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelScrollAnchor.js\":\"7edb92cce9f501e9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelUrlFlags.js\":\"7fd2c2bed01a6588\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/platform.js\":\"83d990ea65e33c39\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/pluralize.js\":\"a561082bcbaa9d46\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyCreation.js\":\"1f4bc4b1444f46e6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyNavigation.js\":\"faf6edd4ae50f89c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyValueContext.js\":\"d369d2f8424dca4c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/react.js\":\"5129f34f5fa35932\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/relativeDate.js\":\"13047d8e2de20f40\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/relativeTime.js\":\"64f2839d66f4a4b2\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/renderScope.js\":\"e3b9fd4aed468c91\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/resolvedThenable.js\":\"5249c5c0994fb4e6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/routing.js\":\"91055736b3d41cb0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/safeMode.js\":\"33a4d0f00459ce3a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/scheduleIdle.js\":\"f37791c4ba95d706\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/screenWakeLock.js\":\"aba3cea748389cca\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/selection.js\":\"2482bfde24c964d4\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/softKeyboardGrab.js\":\"9c4b817f2d3fb94f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/startupTimeline.js\":\"270ad8bbd7562ae1\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/state.js\":\"54dfee58c04fc90b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/string.js\":\"afb963a30003b6a3\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/surfaceZoom.js\":\"bc5d6a63222361c8\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/time.js\":\"2b1073b568a7afa5\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/toast.js\":\"76d26fc4f9009267\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/toggleStore.js\":\"2a16d88119420bfd\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/untilStopped.js\":\"7919d7fff1bcad12\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/userActivity.js\":\"2d172d501f0c914f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/viewTransition.js\":\"71abfce30b09215a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/viewport.js\":\"fe63fdaa5d79fd25\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/webLock.js\":\"3aa12877e221f39b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/workspaceRecovery.js\":\"e52a4210f54d4786\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/workspaceSnapshotStore.js\":\"b3baed38b8ffeb48\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-compiler-runtime.js\":\"ee0f09b8d82a42b5\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-client.js\":\"8392f5c564cda440\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-server-edge.js\":\"6414bff5fe9fb09a\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-server.js\":\"2c4425cbbdc7f25d\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-static-edge.js\":\"d19858611ad02fb1\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-static.js\":\"00536b3406f3d990\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-test-utils.js\":\"e8ec291b530ae0e8\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom.js\":\"0b18ec6a3df03859\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-jsx-runtime.js\":\"4869a0d77de6296d\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react.js\":\"38d758103c7ed296\",\"/knowledge-medium/pr-preview/pr-1849/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1849/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1849/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
