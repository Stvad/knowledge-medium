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
		buildId: "a8401b14d277-21e09557",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/\":\"83378176aa720de6\",\"/knowledge-medium/pr-preview/pr-1849/index.html\":\"83378176aa720de6\",\"/knowledge-medium/pr-preview/pr-1849/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1849/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1849/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1849/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1849/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/pr-preview/pr-1849/assets/FacadeVFS-CTUZxKpZ.js\":\"7ce2ea4ed2cbd954\",\"/knowledge-medium/pr-preview/pr-1849/assets/OPFSCoopSyncVFS-CLdqY3-Z.js\":\"b59445b4827a448c\",\"/knowledge-medium/pr-preview/pr-1849/assets/OPFSWriteAheadVFS-CTtA_Q1m.js\":\"6355e05a4504078e\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-async-D08pev_M.js\":\"1b73992d4499fe2e\",\"/knowledge-medium/pr-preview/pr-1849/assets/wa-sqlite-vz8waUKe.js\":\"b03de34da6f14e03\",\"/knowledge-medium/pr-preview/pr-1849/assets/worker-DZrcfXSe.js\":\"e2723d0ee3dc82b4\",\"/knowledge-medium/pr-preview/pr-1849/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1849/chunks/app-CaiqMuIC.js\":\"e149f940254973a6\",\"/knowledge-medium/pr-preview/pr-1849/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1849/index.js\":\"26dec441d6f72ffc\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1849/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1849/assets/AccessHandlePoolVFS-DreJETfy.js\":\"01f907cbd40a06be\",\"/knowledge-medium/pr-preview/pr-1849/assets/IDBBatchAtomicVFS-ywRrXwEr.js\":\"a6c04e5ac8b38ba9\",\"/knowledge-medium/pr-preview/pr-1849/assets/MemoryVFS-Di6fqy7r.js\":\"0da4807deefc1b14\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-CRjJAkFh.js\":\"563f9d8cb1164b5a\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-async-DSeoc4RX.js\":\"68d831d8cbfbef0e\",\"/knowledge-medium/pr-preview/pr-1849/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1849/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1849/chunks/AccessHandlePoolVFS-Dk-cAN2S.js\":\"62e5547602c635b3\",\"/knowledge-medium/pr-preview/pr-1849/chunks/FacadeVFS-Afefru45.js\":\"ca7edfa20eeb5226\",\"/knowledge-medium/pr-preview/pr-1849/chunks/IDBBatchAtomicVFS-DdhIWLMN.js\":\"ffa7e5354aa3728b\",\"/knowledge-medium/pr-preview/pr-1849/chunks/MemoryVFS-C48qpJhf.js\":\"622fed67e1da2ad1\",\"/knowledge-medium/pr-preview/pr-1849/chunks/OPFSCoopSyncVFS-BO8Q4uCp.js\":\"2fef13acc03a21f5\",\"/knowledge-medium/pr-preview/pr-1849/chunks/OPFSWriteAheadVFS-8c9Rdt6E.js\":\"be3783744b613ee2\",\"/knowledge-medium/pr-preview/pr-1849/chunks/Preview-AioQvjNk.js\":\"5fede3d1df3d8c98\",\"/knowledge-medium/pr-preview/pr-1849/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1849/chunks/card-BH5gaYac.js\":\"bb1a8b7aa8825b9f\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1849/chunks/dist-CuyahXPD.js\":\"024aff9a4b0deca3\",\"/knowledge-medium/pr-preview/pr-1849/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1849/chunks/mc-wa-sqlite-0IYL4xS2.js\":\"1157dd6ff2df531b\",\"/knowledge-medium/pr-preview/pr-1849/chunks/mc-wa-sqlite-async-D_7oJdE3.js\":\"a28d4feb79e1d771\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-4cSmSr2q.js\":\"bd820b6b2f42e7f8\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-B9wFyRRa.js\":\"20b57a382ce41571\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-BS_IfDhk.js\":\"302bd91323438c42\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-C3t0O5Sj.js\":\"58383f26191da161\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-CoYkgZQg.js\":\"ba838a1113e3344e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-WiOzqJfU.js\":\"a51ecb669864667a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-ZV8w4Afx.js\":\"0cb7bfb9428372cd\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server-legacy.browser.production-BzQt4mB2.js\":\"725c808c731c7f9a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server.browser.production-Dmfwageu.js\":\"4c76ccb91b57e13b\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-dom-server.edge.production-4eXAjvkf.js\":\"bb6803b6a23d58c0\",\"/knowledge-medium/pr-preview/pr-1849/chunks/react-fiDn27di.js\":\"8779e33e8b6047d9\",\"/knowledge-medium/pr-preview/pr-1849/chunks/server.browser-PqCzQpoD.js\":\"9736e351d5d6a530\",\"/knowledge-medium/pr-preview/pr-1849/chunks/textarea-DloGvYIt.js\":\"15f09a2e4f514fab\",\"/knowledge-medium/pr-preview/pr-1849/chunks/ui-BpcyOwE0.js\":\"e5e0f6531e68928f\",\"/knowledge-medium/pr-preview/pr-1849/chunks/wa-sqlite-async-fqHSP1g_.js\":\"3cbea204c659e45e\",\"/knowledge-medium/pr-preview/pr-1849/chunks/wa-sqlite-wEY6Mp41.js\":\"35504ebac4ec9c2a\",\"/knowledge-medium/pr-preview/pr-1849/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1849/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/pr-preview/pr-1849/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1849/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1849/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1849/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1849/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1849/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1849/src/App.js\":\"87411cefbdd68fe7\",\"/knowledge-medium/pr-preview/pr-1849/src/appUpdate.js\":\"e860d7945d7e52f2\",\"/knowledge-medium/pr-preview/pr-1849/src/appVersion.js\":\"d8b41214d522423b\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/initialLayout.js\":\"e8b08442c7583043\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/openWorkspaceData.js\":\"c0c3693fcd8dbff9\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/resolveWorkspace.js\":\"22c7a741c26b231d\",\"/knowledge-medium/pr-preview/pr-1849/src/bootstrap/workspaceBootstrap.js\":\"94b2a0e0e4e02224\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockComponent.js\":\"637c297d43ea94ff\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockCrumbs.js\":\"cb337747ed27e02b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockEditor.js\":\"eb78e6312a5e7ef6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockLoadingPlaceholder.js\":\"6787668147aca77b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockProperties.js\":\"1b98ffc0ba344a98\",\"/knowledge-medium/pr-preview/pr-1849/src/components/BlockSearchPicker.js\":\"fab8ca0f1b410aa1\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ConfirmBulkDeleteDialog.js\":\"9bd8b21e9705205d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/DividerHandle.js\":\"0d4db997f6045afb\",\"/knowledge-medium/pr-preview/pr-1849/src/components/DraftEditor.js\":\"0475b9fa373da0d2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/GutterPill.js\":\"9fe3b99c018b599e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/Header.js\":\"095e3884179d3179\",\"/knowledge-medium/pr-preview/pr-1849/src/components/LazyBlockComponent.js\":\"db22c09ca7ee095f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/Login.js\":\"7946a8b7cb0cb94c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ZoomableSurface.js\":\"6c7ae041216dbca2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/editModeKeepalive.js\":\"bc69e2719ee8ff39\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyDisplay/PropertyDisplayScope.js\":\"02e2b5206efcce4c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"38fa8d8ee0a3ff36\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/RefPropertyEditor.js\":\"4be38fc5471c1b54\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/RefTargetTypePicker.js\":\"c0ea88903221fe2b\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/SelectPropertyEditor.js\":\"c8eb72a45d6d653d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/TypesPropertyEditor.js\":\"f129d52a77b37ec3\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/defaults.js\":\"e809c431cdb2bf99\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/kernelValuePresets.js\":\"d3fa8f8ccd432ed2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/selectablePresets.js\":\"f1c51118c4bbd4c2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyEditors/typesPropertyUi.js\":\"70fb51fedd073a18\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/AddPropertyForm.js\":\"3614a5344ffc709e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/PropertyPicker.js\":\"6494907c6c67a035\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/PropertyRow.js\":\"428e26f8899d1209\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/Rows.js\":\"d12eb6b89a0726b4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/actions.js\":\"8110fd97229680f6\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/declarationOnly.js\":\"00492dafd8d040d0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/layout.js\":\"b004ae9b1c5b5abc\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/model.js\":\"80142c13b3ab5bc7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/shapeUi.js\":\"3ff9eb02548b49d2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/shapes.js\":\"cb38985e7c81cdf7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/usePropertyEditingActivation.js\":\"f03304699be6c4ea\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanel/visibility.js\":\"ce6969a335fe2b9f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/propertyPanelSections.js\":\"9e8d1b6a287d5ef0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockEmbed.js\":\"a6b0f1860f790eee\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockLink.js\":\"833ee867c5c605c7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/BlockRef.js\":\"b96cd311080a113f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/ReferenceLink.js\":\"8552dc6983f0e4bc\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/cycleGuard.js\":\"86cbe6dfb6e80631\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/cycleGuardContext.js\":\"383ef91e54771ae8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/linkInteraction.js\":\"17ebef068f4d391c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/referenceLayout.js\":\"4d2f915cbdd034a2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/references/useBlockRefAncestors.js\":\"e3f704844d26d7ae\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockGutter.js\":\"b9faa3bca83dc6bc\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockInfoDialog.js\":\"bc58bb4ec07e3607\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BlockTypeBlockRenderer.js\":\"c38ed1da068416fb\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/BulletHoverCard.js\":\"ac1528d6297d6191\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/CodeMirrorContentRenderer.js\":\"6ade7766631714db\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"76ec99558ba0d959\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/ColumnResizeHandles.js\":\"b135d3647b5fbcc7\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5efa63d8c544d894\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/DefaultBlockRenderer.js\":\"f87ea5c234456e57\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/LayoutRenderer.js\":\"2a34f7e8c2f71299\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/MarkdownContentRenderer.js\":\"52aef01030ecf751\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/MissingDataRenderer.js\":\"99ed5c82fad6dab8\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/PanelRenderer.js\":\"c7e7e2af1093a686\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8778353c73523dfb\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/TopLevelRenderer.js\":\"e3d6cbc51ae627ba\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/blockGutterMode.js\":\"e5f20a4071109d8d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/blockTitleText.js\":\"124eadd34d2a03ab\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/fieldCreationKeydown.js\":\"abc6b2e8ed2169b2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/renderer/layoutRootContext.js\":\"41e406bc71978df4\",\"/knowledge-medium/pr-preview/pr-1849/src/components/typeChip/TypeChip.js\":\"5cdb3a7daec59f62\",\"/knowledge-medium/pr-preview/pr-1849/src/components/typeChip/chipStyle.js\":\"f185ee4c6d557c0f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/anchored-floating.js\":\"fd5e41b0fc6654d2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/button.js\":\"510a9f65a717a357\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/card.js\":\"6af5f535c03893fb\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/checkbox.js\":\"d8a52ee064496653\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/collapsible.js\":\"a0d5699502694e1d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/command.js\":\"2b4a9f0a85d6ba00\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/context-menu.js\":\"89d53aee2722f37d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/dialog.js\":\"f7882a45d128914f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/dropdown-menu.js\":\"4b9caf901535f275\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/floating-listbox.js\":\"57433eebb9974dd2\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/index.js\":\"2fbb925640a87687\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/input.js\":\"7adf66d667180071\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/kbd.js\":\"3a00f21cbd46a8b1\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/label.js\":\"5af7a4513b64e237\",\"/knowledge-medium/pr-preview/pr-1849/src/components/ui/textarea.js\":\"c20ae6894c73b230\",\"/knowledge-medium/pr-preview/pr-1849/src/components/useEditModeYieldKeepalive.js\":\"c21a8941f7d2dc5e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/BootFallback.js\":\"3d0585ff9c932259\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/FocusedRowLazyMount.js\":\"9ee05220d44c1d57\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/LazyViewportMount.js\":\"508eb507f25e25ff\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/LocalDbCorruptionFallback.js\":\"c66d6f1156c68e06\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/error.js\":\"1759345637e6157e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/lazyMountRegistry.js\":\"25437653c5781e51\",\"/knowledge-medium/pr-preview/pr-1849/src/components/util/suspense.js\":\"00c3b7f9cfc014e0\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/CreateWorkspaceDialog.js\":\"6f031c671c4b7951\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/PendingInvitations.js\":\"634f73777713b99f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/SyncProgress.js\":\"6ecb217ed4a8cfac\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/UnlockProgress.js\":\"e0c3bba1b20211bd\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceKeyGate.js\":\"b23222c62900862f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSettingsDialog.js\":\"45b561c6efe05957\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSwitcher.js\":\"f524c451fd80453c\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/WorkspaceSyncGate.js\":\"dcc5f867f9b1583a\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/ConversionFlow.js\":\"d7b3e3b54f638649\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/ConversionFlowHost.js\":\"3ec289b5f7469caf\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/EncryptionSection.js\":\"ad0aeca0fcd5ac72\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/attachmentPrompts.js\":\"4204de515ca3734e\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/bundleFolderPrompts.js\":\"cfec2522a608783d\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/conversionFlowDeps.js\":\"0cb875d0009a7b81\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/conversionFlowStore.js\":\"16f9b612b0e074dc\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/flowUi.js\":\"bfa3578494fc5a75\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/conversion/useConversionRun.js\":\"26a020ac9e0db45f\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/keyUi.js\":\"ad1d969c9f4ead29\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/useCloseOnKeyLoss.js\":\"10524639ea369192\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/useCloseOnServerE2ee.js\":\"0c75e33e64db8777\",\"/knowledge-medium/pr-preview/pr-1849/src/components/workspace/workspaceUnlocked.js\":\"092102bff6f34671\",\"/knowledge-medium/pr-preview/pr-1849/src/context/backgroundSubtree.js\":\"9b4815935eea7e76\",\"/knowledge-medium/pr-preview/pr-1849/src/context/block.js\":\"cd63c316b1f4d516\",\"/knowledge-medium/pr-preview/pr-1849/src/context/layoutWsContext.js\":\"a50eda52f91e719e\",\"/knowledge-medium/pr-preview/pr-1849/src/context/propertyDisplay.js\":\"fc4f1a574335a9fa\",\"/knowledge-medium/pr-preview/pr-1849/src/context/repo.js\":\"02c4624c9239a1e7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/aliasClaim.js\":\"4e53ce509b8e6305\",\"/knowledge-medium/pr-preview/pr-1849/src/data/aliasSeatNamespace.js\":\"bc31252027cb41ff\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/blockData.js\":\"ce994525984db827\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/blockType.js\":\"aef845fedd853067\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/changeScope.js\":\"2dcbfb8478456b61\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/codecs.js\":\"85b97d1a524f6603\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/derivedData.js\":\"ad443bed6bb006f0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/errors.js\":\"06bbc84898a2449a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/events.js\":\"3044e9580c494525\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/handle.js\":\"4e51d6536db60507\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/index.js\":\"e5ef2e329a8b2176\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/mutator.js\":\"bb0f2a8a80caae6d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/processor.js\":\"2fa10640e3c080fe\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/propertySchema.js\":\"29681ffc91bc1f06\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/query.js\":\"7e4fc84b393222e3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/sameTxProcessor.js\":\"c39a6f67ab220c36\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/schema.js\":\"4e51d6536db60507\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/tx.js\":\"4e51d6536db60507\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/typedBlockQuery.js\":\"3395d85dcbf1f7bc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/user.js\":\"709501dfebacde09\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/valuePresetCore.js\":\"b84af25959f3c3db\",\"/knowledge-medium/pr-preview/pr-1849/src/data/api/valuePresets.js\":\"3ad2808e3404f05c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/attachmentCleanerIOVerb.js\":\"9c63fc95aa31a48f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/block.js\":\"4152791fb651da0c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockCache.js\":\"d564bfc2e18e6cc8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockId.js\":\"c4c247985e68a89f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockLiveness.js\":\"19fb972de7ea5b63\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockMerge.js\":\"e2ae2162d1a5a59a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockSchema.js\":\"5ea2b85010932e7f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockTypeLookup.js\":\"0ca5407747b4cacb\",\"/knowledge-medium/pr-preview/pr-1849/src/data/blockTypes.js\":\"41a2e820a13e966b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/clientContext.js\":\"05c7f7c02c607eed\",\"/knowledge-medium/pr-preview/pr-1849/src/data/dbFileSiblings.js\":\"21387ac0304cdc26\",\"/knowledge-medium/pr-preview/pr-1849/src/data/definitionSeeds.js\":\"8de25ad894fe9c7f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/derivedIds.js\":\"b05811a6df4b9a28\",\"/knowledge-medium/pr-preview/pr-1849/src/data/drawnSubtree.js\":\"fdde5293a0f90bc6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/facetBridge.js\":\"9262bb093aace62b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/facets.js\":\"3b0f1cc9ca614696\",\"/knowledge-medium/pr-preview/pr-1849/src/data/globalState.js\":\"2b1205ebb04cfa09\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/aliasClaimRederiveProcessor.js\":\"4091d044149acdbd\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/ancestorBatch.js\":\"76ad475f7561e825\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/blockTypeTypeifyProcessor.js\":\"1513156c83e8160d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/clientSchema.js\":\"8016860920d1338c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/commitPipeline.js\":\"221ce481dd056f86\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/devAssertions.js\":\"419fd526d907831a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/firstSync.js\":\"fa9c9bd19c4679c6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/freshInitialLoad.js\":\"34a2226420750a4a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/graphBackfillClaim.js\":\"cdab68d068dc288b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/handleStore.js\":\"c51d0f9fc333bb05\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/idleMarkerJobs.js\":\"f015cffecdce8451\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/initialDownload.js\":\"531ec3f379ad098f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/initializeClientDatabase.js\":\"98f43f6b807a4a4c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/jsonCanonical.js\":\"00ac2814dc33e90c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelInvalidation.js\":\"d332269395faeb98\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelProcessors.js\":\"2abb07c7915aff7d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/kernelQueries.js\":\"ee800834065be877\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/mergeTypeMembershipProcessor.js\":\"bec8f4b0c4902eb4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/normalizeReferencesProcessor.js\":\"d7811898ff344234\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/poolInstrumentation.js\":\"4e075d90c34c800d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/processorRunner.js\":\"0b158eed916f6a00\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyCellBackfill.js\":\"fd19f136b3fc846d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyChildMint.js\":\"2befc733f6a4db6a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyChildrenProcessor.js\":\"b18ef8660b49afa0\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9343a9e667f479fb\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyDefinitionSynthesis.js\":\"ee31199155ae952b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyKeyScan.js\":\"dced7c6ab33f47e8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertySchemaResolution.js\":\"25171a583cd774a9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/propertyValueEdits.js\":\"ecfa7c37af2c5651\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/raiseProtocol.js\":\"9aa5695a8824c87f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/readBatch.js\":\"17c018aec36a3a41\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/refProjection.js\":\"e404a925f9e9a673\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/referenceTargetLookups.js\":\"e109908bf30237c4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/referenceTargetProcessor.js\":\"89b9a8289d554072\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/replayMerge.js\":\"f46dbc10b7dfe7ad\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/sqlBinds.js\":\"8df5c4ac0356a656\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"dbef750fd8aa85f1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/arrivalProcessors.js\":\"3ce79df6de963197\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/invalidate.js\":\"91ecfc2e86619dd5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/materialize.js\":\"6d874d5a93c65be3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/observer.js\":\"452afdb26f855f65\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/syncObserver/reconcile.js\":\"83e68c3a1ad7e9a4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/timingMetrics.js\":\"9279e77307de99fc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/treeQueries.js\":\"714f12e714a07048\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/txEngine.js\":\"7c9c71b5ba8b85db\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/txSnapshots.js\":\"9581305376029b46\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/typedBlockQuery.js\":\"d3ac1f7fd0cf3520\",\"/knowledge-medium/pr-preview/pr-1849/src/data/internals/undoManager.js\":\"b2a3a600a86f0c77\",\"/knowledge-medium/pr-preview/pr-1849/src/data/invalidation.js\":\"8e8067b21abb25e6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelDataExtension.js\":\"aec035990abda168\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelPage.js\":\"c04d0f8150ed0d41\",\"/knowledge-medium/pr-preview/pr-1849/src/data/kernelValuePresetCores.js\":\"c48b57b54482c7e4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbCorruptionSignal.js\":\"e31bab6c77c877a6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbStorage.js\":\"7185865189cf4a60\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localDbVfs.js\":\"44fb898f0ab5cd17\",\"/knowledge-medium/pr-preview/pr-1849/src/data/localSchema.js\":\"e721e67b0e7dfb4d\",\"/knowledge-medium/pr-preview/pr-1849/src/data/maintenance.js\":\"47f46a3a82a1d453\",\"/knowledge-medium/pr-preview/pr-1849/src/data/mergeProperties.js\":\"ee334a9ebe198b71\",\"/knowledge-medium/pr-preview/pr-1849/src/data/metricsConsoleHook.js\":\"1a2120f4b07cc933\",\"/knowledge-medium/pr-preview/pr-1849/src/data/migrationsPage.js\":\"7d718ee769ba2375\",\"/knowledge-medium/pr-preview/pr-1849/src/data/mutators.js\":\"766b91c9e5528350\",\"/knowledge-medium/pr-preview/pr-1849/src/data/orderKey.js\":\"d697a25d6afac1d8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/orderKeyPlacement.js\":\"7858fab2834594b8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/outlineSurface.js\":\"6dd3090615213a1e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pendingEditorContent.js\":\"164b1a943a7ae7ce\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pendingUploadsSql.js\":\"36630b2afd2b67bf\",\"/knowledge-medium/pr-preview/pr-1849/src/data/pluginStateExtensions.js\":\"5be04c675056d2be\",\"/knowledge-medium/pr-preview/pr-1849/src/data/powerSyncLogger.js\":\"f50ec0fe67103c3b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/projectorRuntime.js\":\"6cb00c24ed2f5ed2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/properties.js\":\"7cfe30fb96ac09b1\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertiesPage.js\":\"86228161a583267b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyChildren.js\":\"6b0ae6875dd13044\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionFanout.js\":\"77f6893e14c86641\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionMetadata.js\":\"242f274370702607\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDefinitionRegistry.js\":\"8e10d0042daebc63\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyDisplayMode.js\":\"ff19b6d3bedb5db2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertyRowCreation.js\":\"acc396140b8a708a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertySchemaCreation.js\":\"76aef422fc986e31\",\"/knowledge-medium/pr-preview/pr-1849/src/data/propertySeeds.js\":\"bd4355c5fd23a440\",\"/knowledge-medium/pr-preview/pr-1849/src/data/recentsPage.js\":\"fcaedb0e951a891c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/referenceBlock.js\":\"5e6884ef31ba07c4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/rejectedUploads.js\":\"80a9606145897ba9\",\"/knowledge-medium/pr-preview/pr-1849/src/data/releasePowerSyncConnection.js\":\"3a949540e053492b\",\"/knowledge-medium/pr-preview/pr-1849/src/data/repo.js\":\"217b0ce5fe95a65e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/repoProvider.js\":\"62f7a67362ada643\",\"/knowledge-medium/pr-preview/pr-1849/src/data/rowProperty.js\":\"ba288d10091026e2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/searchFilter.js\":\"82937991dd4bff1c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/seedIdentityLedger.js\":\"1ddf0b3b6e24b54c\",\"/knowledge-medium/pr-preview/pr-1849/src/data/stateBlocks.js\":\"2dcd4ebb20cc4cdf\",\"/knowledge-medium/pr-preview/pr-1849/src/data/structuralEditPolicy.js\":\"dcd8e5c4228a1f62\",\"/knowledge-medium/pr-preview/pr-1849/src/data/subtreeDelete.js\":\"8383bdda6c5bdb0e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncStreamLock.js\":\"1300b59fb4e32a42\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncedTableSqlRecognizer.js\":\"49105ce0435070d6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/syncedTableWriteGuard.js\":\"bd7bf6a483026eef\",\"/knowledge-medium/pr-preview/pr-1849/src/data/targets.js\":\"dfeb239789d1d8e4\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeColors.js\":\"f3b9e1126379b5ec\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeDefinitionMetadata.js\":\"c3c92139d17ea2dc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeDefinitionRegistry.js\":\"5a37b491007e15e6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeExtraction.js\":\"e311aa536e7bbdf6\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeInitialValues.js\":\"1f709ae13b83f582\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typePropertyGroups.js\":\"604dadbeffb412cd\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeSeeds.js\":\"0bb920990d7479ae\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typeTagger.js\":\"992a7b063c8f0726\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typedRecords.js\":\"e7e7c1ca63cc97fc\",\"/knowledge-medium/pr-preview/pr-1849/src/data/typesPage.js\":\"bbdd2bd0b6ef7060\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userPrefs.js\":\"c82eef0e4144c5d7\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userSchemasService.js\":\"1c3f74342f9a6c08\",\"/knowledge-medium/pr-preview/pr-1849/src/data/userTypesService.js\":\"493949a80f84de8f\",\"/knowledge-medium/pr-preview/pr-1849/src/data/valuePresetRegistry.js\":\"58ee4aa053af444a\",\"/knowledge-medium/pr-preview/pr-1849/src/data/visibleChildren.js\":\"4ab2e698cc463e2e\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceConversion.js\":\"5a0259a6b930a6c5\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceFirstSync.js\":\"cf094d0590c907b3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceIdNamespace.js\":\"4d9725ae30e317fb\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaceSchema.js\":\"87f78b13f2de16c8\",\"/knowledge-medium/pr-preview/pr-1849/src/data/workspaces.js\":\"addb6d986ef436f3\",\"/knowledge-medium/pr-preview/pr-1849/src/data/writeAheadLog.js\":\"350a2d8803175ff2\",\"/knowledge-medium/pr-preview/pr-1849/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/BlockPasteShellDecorator.js\":\"0957a908354200d9\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/atTrigger.js\":\"b5cae2bc154fe980\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/autocomplete.js\":\"e0dd244cf1f5693c\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/codeMirrorExtensions.js\":\"cf67fe2db9620b2c\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/contentFlush.js\":\"a1d2a5acbb3dc92a\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/defaultInteractions.js\":\"33780c617badf3de\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/editSettleSignal.js\":\"5fced38c352dd9f0\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/insertImage.js\":\"8f16a5c0cecc9342\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/referenceCompletionRange.js\":\"489d92131f6e41da\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/referenceTargetTypes.js\":\"9aad7e3df2b6d8b1\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/syntaxContext.js\":\"e35d526689eb9899\",\"/knowledge-medium/pr-preview/pr-1849/src/editor/triggerMatch.js\":\"625f678b36e65d15\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/AppRuntimeProvider.js\":\"98fb10c9cab98a01\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/BlockFocusShellDecorator.js\":\"3052c5a81b26cc04\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/ExtensionRenderBoundary.js\":\"e64e4390eb4440d5\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/PanelContentRecovery.js\":\"9a698c019a7a4ff0\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/apiCatalog.js\":\"58539d5e8b67c310\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/approveExtensionHere.js\":\"e3574197506b3d18\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/armedCutAppMount.js\":\"2e44166745eb6b55\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/batchableKeyedStore.js\":\"65bd309f427817d8\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/blockInteraction.js\":\"eaf4076537a51aa4\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/blockSelectionAction.js\":\"1a0d12db494a65b2\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/compileExtensionModule.js\":\"a4bcdcbb30c2ae46\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/compiledModuleCache.js\":\"ec7f546afde9fb53\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/continuousGestures.js\":\"418372fbbf050710\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/core.js\":\"ad32e264fbee8921\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/defaultRenderers.js\":\"ef8c6dfbb8ad8945\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/definitionFanoutAppMount.js\":\"b48e55dcaf4963a2\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dialogAppMount.js\":\"d8dac5717d23c1b0\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dynamicExtensionSeeds.js\":\"c7712bc928e96555\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/dynamicExtensions.js\":\"5b629bc5649763fb\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/exampleExtensions.js\":\"ef5f277edf3662f0\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionApprovalStatus.js\":\"a28af035dca6ebef\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLoadErrorToast.js\":\"2dad2b22c2ce5b67\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLoadErrors.js\":\"011d04aa838ed1cc\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionLookup.js\":\"4b1b2f6925df45b5\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionToggles.js\":\"008f7d1a01385aca\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/extensionUtilitiesCss.js\":\"3a485d2a3d52b932\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/kernelPageDeletionGuard.js\":\"893f6623fb0383ee\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/liveRuntime.js\":\"bdc3f2c12cd2ccb0\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/openExtensionsSettings.js\":\"b7a018a7219cd6b4\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/overridesCache.js\":\"04ad75fe111e7704\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/pluginIds.js\":\"4eabe0c66c91e290\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/processorRejectionToast.js\":\"6deb24dd4fbd8ea0\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/runtimeActions.js\":\"7b6decf361dd854b\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/runtimeContext.js\":\"3ae4048d86fc3add\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/staticAppExtensions.js\":\"1cfb1a5e37e743b3\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/staticDataExtensions.js\":\"ae92dc914267b735\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/toastAppMount.js\":\"d47a051c6ab8fb9d\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/useOverrides.js\":\"20633bce0cb9f8ab\",\"/knowledge-medium/pr-preview/pr-1849/src/extensions/useShortcutSurfaceActivations.js\":\"b3aa082ae83aab8e\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/discoverToggleTree.js\":\"0e7ea07e9541732d\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/facet.js\":\"4a6dfd8ea051e5c0\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/resolveAppRuntime.js\":\"6803e7cc4c36da0a\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/runtimeEvents.js\":\"56e9ca9c5da34369\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/togglable.js\":\"fd5617a1067189e3\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/variantFacet.js\":\"5d1c2120e6dcd30c\",\"/knowledge-medium/pr-preview/pr-1849/src/facets/verbFacet.js\":\"85dc98daab8b6800\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/block.js\":\"945e67988a24e7cd\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/focusedChild.js\":\"f50d20b002fa89db\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/propertySchemas.js\":\"e0096e422b3e1a0f\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/typeRegistry.js\":\"1218adaf80a1d719\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useAncestorCrumbs.js\":\"8cdde949e75dfb11\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useAutocompleteListbox.js\":\"c6da87ee5eece809\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useDebouncedSearch.js\":\"dc40b51c5333fea0\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useDebouncedValue.js\":\"16a528f9039ab35d\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useIsFocalRender.js\":\"4afb4ea73e8faa4d\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useIsReadOnly.js\":\"88cdd5c694a2b075\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useMaterializeBacklog.js\":\"3b46c839c5cb2a9d\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useMinuteClock.js\":\"d2848cf26408012c\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/usePanelLayoutProjection.js\":\"5dd9067273a539f9\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/usePendingInvitations.js\":\"686efd37604ee36c\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useRendererRegistry.js\":\"461af0a33b0fce2a\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useRetainedFieldRows.js\":\"2252dc1c663e8f31\",\"/knowledge-medium/pr-preview/pr-1849/src/hooks/useWorkspaces.js\":\"5664dbf0573953be\",\"/knowledge-medium/pr-preview/pr-1849/src/lib/utils.js\":\"ae8ee699854de224\",\"/knowledge-medium/pr-preview/pr-1849/src/main.js\":\"f28031866f41fcf3\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/MarkdownImage.js\":\"795c98318d84e643\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/blockSeparators.js\":\"b46f57e98564a139\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/context.js\":\"10f6cb4d2ce9d62e\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/defaultMarkdownExtension.js\":\"a8ce4a4be64b95fd\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/extensions.js\":\"98a8b6c50ac0da0f\",\"/knowledge-medium/pr-preview/pr-1849/src/markdown/renderMarkdownHtml.js\":\"5e51403b3acda019\",\"/knowledge-medium/pr-preview/pr-1849/src/minimal-editor.js\":\"08c4f908cf54bd05\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/armedCut.js\":\"02b328fdf1a7cbcf\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/captureMediaVerb.js\":\"5c631466998b0534\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/clipboard.js\":\"82f54ca60e793713\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/decision.js\":\"949aa6a0b16952c7\",\"/knowledge-medium/pr-preview/pr-1849/src/paste/operations.js\":\"1b1ba3b3a4549f81\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/account-header/AccountHeaderItem.js\":\"8773ef1f83d09b3a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/account-header/index.js\":\"22fa959e9e1e5834\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f1c3be15a717c32d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/askAgent.js\":\"f361904bdba63d87\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/askedStore.js\":\"68b692c999bd88c2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c77cd31fe7a8e5a8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/chipState.js\":\"be4cfb12a4fae993\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6fa9f1b403a06b39\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/index.js\":\"4d21813b7edb0dcd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d5b75fb63900ca42\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-dispatch-companion/schema.js\":\"fd52433e2aade76b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/AgentTokensDialog.js\":\"aac059724ea1f0a3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/BridgePairingDialog.js\":\"205e598c11294eb9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/addMedia.js\":\"df57bec355f9dc86\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/backlinks.js\":\"beb22b607a46ca43\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/block.js\":\"ee2d8bd47624033f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/context.js\":\"4b1861fe7ed30fc7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d6bc614a9c748e3b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/index.js\":\"f592a207b54a7d27\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/outline.js\":\"b1efda00c91d3816\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/properties.js\":\"775aed5d2ab85b79\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/refs.js\":\"91b0010f6f65f882\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"05458a354dbdc546\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/search.js\":\"5514824798abb293\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/shared.js\":\"67f470baa2ed6446\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9a8f8c87278f9468\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentViews/text.js\":\"7f649fbbd23152e6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/agentWrites.js\":\"6e9a67583b1a9c5d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/authoringCatalog.js\":\"7184f3c67b5de804\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/blockRefTargets.js\":\"6f9b6d996fec0bc6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/bridge.js\":\"501b58e55440c1e5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/bridgeLoop.js\":\"feb277e488d50f29\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/changeHistory.js\":\"bac7b1ded9e35626\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/commands.js\":\"905b459f20e889b5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/commentsCommands.js\":\"86583c55705874d1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/dataExtension.js\":\"ec987c8bc002c667\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/dataModelGuide.js\":\"5a3c5cff4180e040\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/describeRuntime.js\":\"7187a4824d809a0b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/extensionLint.js\":\"6ec3f415a041ced6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/grainAudit.js\":\"47be7c79d99822dc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/healthCommand.js\":\"518913770bf3be3f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/index.js\":\"329e02594b8ef34a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/presetIdentity.js\":\"b19870d836062db4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e49c4356c1dfd5fb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/readMedia.js\":\"53f6c2793cc53118\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/schema.js\":\"061e43755053f313\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/serialization.js\":\"4df9d88c64d94b57\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/targets.js\":\"c46f1ace3bbaadb6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/tokens.js\":\"23862c6c2ac2fde2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/watchEvents.js\":\"93f5d41b9289d5aa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/workspaceGuard.js\":\"44541d9da457850c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/agent-runtime/writeCommands.js\":\"51faab22323c1827\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/AliasCollisionToast.js\":\"0934c963bb089242\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/DuplicateNameBanner.js\":\"a1ca3e621be4989d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/collisionMerge.js\":\"ea1aa38729871df0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/dataExtension.js\":\"e0d5e356036bd398\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/index.js\":\"5379628dc30382e2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/mergeCollisionAction.js\":\"6bf4cfdb3da6645e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/pageStyling.js\":\"ab1c306771ee66bf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/rejectionToast.js\":\"30ea842d1fc27949\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/alias/syncProcessor.js\":\"68ed3a25f8f1f260\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/actions.js\":\"507f064297e3e5c9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/addComment.js\":\"2dcb401cf880a068\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/anchor.js\":\"a76cb9f7904a5d83\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/anchorState.js\":\"348f1d23779d6972\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/commentLinks.js\":\"fdcb0094b1c21007\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/confirmThreadDeletion.js\":\"1926d9cfb6409298\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/container.js\":\"f814166e581a9687\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/dataExtension.js\":\"d83fd3599dfbcfd8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/deleteComment.js\":\"8b1b08a5913ce1d5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/highlights.js\":\"757b70e1dadfee29\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/index.js\":\"910f82662df01743\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/linkedCommentsPill.js\":\"c7075304f4629972\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/margin.js\":\"90af28ed92a156ba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/marginSchema.js\":\"5826cf6cf5362d63\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/newComment.js\":\"de791a32145249e5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/ownThreadPicker.js\":\"fe3db02b942fcc20\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/placement.js\":\"5a05ff280fd7be40\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/queries.js\":\"1c9ac0772f399192\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotePosition.js\":\"6122dfe91b073eda\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotedIn.js\":\"6c57387c40906039\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/quotedRange.js\":\"d6ab8ad1eb9fea94\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/rangeRefs.js\":\"10030017073224aa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readHighlights.js\":\"79358ee903f3ccc0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readSelection.js\":\"aa1b5c234ca0af3c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/readSelectionUi.js\":\"b73cf51ae50ed0be\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/reanchor.js\":\"5220f632e53dcd52\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/schema.js\":\"b34a9d7238ae7492\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/scope.js\":\"892a3ba591706f6e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/scopeThreads.js\":\"ae3d5bda3863bfad\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/splitRetarget.js\":\"a1817b47320691a9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/suggestionCard.js\":\"079fdf7f46d9c99c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/suggestions.js\":\"83337c889f80e195\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/summaries.js\":\"d80926433ae4515d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/summaryBatch.js\":\"194a32038b938d35\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/surface.js\":\"4d02f5e57337aa5c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/threadNavigation.js\":\"5a395458daa2e7e5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/threads.js\":\"05c5f4c6ea98730b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/ui.js\":\"e69612ec0818e57d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/annotations/uiStore.js\":\"6128896382e6237b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-intents/appIntents.js\":\"09c37e0cecfaca78\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-intents/index.js\":\"a3e051cb36518fb7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-update-prompt/index.js\":\"f3adc3f66e4fc0d2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/app-update-prompt/status.js\":\"b0e3e442f283b4dc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e9cb79323316c31f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaBlockRenderer.js\":\"4c577cd32e18c623\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5cfb9875855996bc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/MediaUploadReconciler.js\":\"ed048be2f6b15f07\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetDownLane.js\":\"228e11e40bf8cf4b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetResolver.js\":\"f2c8ce09cc4da277\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/assetUpload.js\":\"86d3c69511157ac2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/attachmentCleanerIO.js\":\"2342e56215342c40\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/supabaseAuditIO.js\":\"77916656d42a5262\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/blobStore.js\":\"cd804578e5610286\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/byteStore.js\":\"645e292592397d19\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/cleanerIO.js\":\"97a6776a1506281b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/cleanupAttachments.js\":\"d7eb421cf131b3f8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/dataExtension.js\":\"e0e145faedf773bd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/downLane.js\":\"d15f179749cf7596\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/index.js\":\"6cee26f13887c43f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/insertImageContribution.js\":\"d504c658d856a024\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/laneArming.js\":\"811a388363345d6d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/laneLock.js\":\"46c642f572b004d3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaBlock.js\":\"c8769063f6458b9a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaCapture.js\":\"fe7e15f9ef10b1d7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaViewers.js\":\"b8464a4e184e542a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/mediaViewersFacet.js\":\"e5d91aab6576588d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/pasteCapture.js\":\"53363efd1be653c7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/resolver.js\":\"4ece68accb9cb973\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/retryUploadsAction.js\":\"6b47e10afaeff236\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/storagePaths.js\":\"b4c91964f5843db8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadDrain.js\":\"0ef15ec00f66f678\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadLaneStatus.js\":\"6dbf7282ee9f863f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadReconcile.js\":\"4dfb4f34d03e570b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadRecovery.js\":\"1659823e910bad3b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/uploadStore.js\":\"8fd73c75387b1c71\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/attachments/useAssetObjectUrl.js\":\"48c01b26bf4dd028\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"42d2dab568749390\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/BacklinksViewSection.js\":\"95465e219abddb85\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/facet.js\":\"9f3205f89fb7d909\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/index.js\":\"4055cd8cb6e26799\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks-view/prop.js\":\"d8e6f4a8d0c80cfb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BacklinkFilters.js\":\"18f0ad595a61e1e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"de509ee7bb7414c1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/BlockEntry.js\":\"1cc9fad8a9efb2d1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/LinkedReferences.js\":\"5f9a689c845791e0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"23d2a11f8303afc2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/dailyNoteDefaults.js\":\"012d50f5193719e2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/dataExtension.js\":\"af4ed1da367a0744\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/edgeExclusions.js\":\"87af78e3102a27cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/filterProperty.js\":\"0c5706b305f6d660\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/index.js\":\"b5aa12de9eda01ac\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"36029488fd19c3e6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/applies.js\":\"40ae8d5e9c2202f7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/countQuery.js\":\"fd0eb0593dbaea83\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3ecc498362e9f46b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/index.js\":\"d9384fe48421ca1d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0b08e137ea76f6af\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/presentationInvalidation.js\":\"f9b226a790f599ef\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/propertyEditorOverride.js\":\"30ae05fe38f8f8ba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/propertyFilter.js\":\"363f2fc3334c8f01\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/query.js\":\"c04c28d6a9dbc570\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/resolveFilter.js\":\"27e10fd950bc30f8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/sourceBatch.js\":\"55b317cd5907a52e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/sources.js\":\"3d377d28ad894abf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/useBacklinks.js\":\"2413b8e600702503\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f71bb2c14b056f46\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/BirthdayCelebration.js\":\"9442be1121928f8b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/BirthdayOverlay.js\":\"eb582a550bed5369\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/gate.js\":\"6c34d54e49c2a5a3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/index.js\":\"1b8a7ca1ef4bec2e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/birthday/wolfTheme.js\":\"c2423c513c1e37c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/BlockDragLayer.js\":\"743d22a4d719e48e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/dragController.js\":\"bda0a9b0dc1436a4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/dropTarget.js\":\"c20c0c8d060d40d5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/index.js\":\"58aeb143518e4404\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-drag/projection.js\":\"c08d0d90c720ac0c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-info/BlockMetaCard.js\":\"fb40f64fbbfb8091\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-info/index.js\":\"260125ea04d5f32b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/AddTagDialog.js\":\"c43b0a8723cc5970\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b698611f6eed8f6b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/TagNameIssueHint.js\":\"371179135f14dbb7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/addTagAction.js\":\"5a4865ec2a14f73d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/appendTag.js\":\"c8559e25e3a11208\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/config.js\":\"aad6f153898a535c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/dataExtension.js\":\"998ff4294943d70d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/index.js\":\"f44f05e5bda108c0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/block-tagging/propertyEditorOverride.js\":\"41ee218ec01c6450\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5cbf599c8b921002\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6182e7733f774d4f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/Breadcrumbs.js\":\"413743683011434b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3efe321b1fe75053\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5ebfa16ad61d0034\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/index.js\":\"18ec69953c5a60ff\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f5f853d41474ccc0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/CharacterCountItem.js\":\"88100f2c45ae3b0b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a8f31eb9d0b8c490\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/actions.js\":\"33b91c3f9e19062d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/blockType.js\":\"de7f483baed29048\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/charCount.js\":\"be0fc514ee55f7ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/dataExtension.js\":\"35e5330f7e8bfc96\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/index.js\":\"7bcc011d241348f1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/profiles.js\":\"4990359537f90f8c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/properties.js\":\"82e94b76ea7da343\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/character-counter/textCounts.js\":\"c679930435a2e989\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/colemak-keybindings/index.js\":\"911abc7a35ef29b0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/CommandPalette.js\":\"634da9f812988a0f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/HeaderItem.js\":\"fae69c39a95bc97c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/context.js\":\"8ed2aca20cc326bc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/index.js\":\"e5a612a1aa51307b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/selection.js\":\"ab8a9d8c9ef666f3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/toggleStore.js\":\"921e25ffd30d9518\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/command-palette/useCommandPaletteActions.js\":\"73a62bbfdb4741f1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/ContributorBadges.js\":\"8c8356e56325174e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/author.js\":\"e3dbbe5fd2de4c11\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/codeMirrorExtensions.js\":\"ec0e945411f1be86\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/dataExtension.js\":\"5ea13a1dbd9bbb73\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/index.js\":\"509032a7febc4435\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/mentionAutocomplete.js\":\"0127aa1a78a1943c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/processor.js\":\"7bb30ac723fdc8ec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/profiles.js\":\"ce8c6f498ca6e677\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/queries.js\":\"be88bf6f789bb024\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/contributors/schema.js\":\"409d49151e2c25bc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a80b0b8eca072153\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/followOrigin.js\":\"9dde59cf32be5ee7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/index.js\":\"f236d108bfc1bd11\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e661b64d51f490cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"690dc4e9e4e3158b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/CalendarGrid.js\":\"04b446c7b201ac46\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DailyNotePicker.js\":\"a168fe7d6daa0888\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"da62c7e351d0a87a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateNavDecorator.js\":\"dad5391fb658f0b3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/DateScrubOverlay.js\":\"792941b0ce593bea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/HeaderItem.js\":\"ae4db3f2c34469f1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/ReschedulePicker.js\":\"395aa075218f622b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4ab825afd4766127\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/actions.js\":\"6e606c069b316a21\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/blockDateAdapter.js\":\"af94b43334fa34e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/calendar.js\":\"f08a4dd3e1021fd5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dailyNotes.js\":\"756865638a28f531\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dataExtension.js\":\"c699a1fc1816b9d4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubActions.js\":\"3a2405ada0591056\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubGesture.js\":\"b73ff55f363d23c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5f5b2852f3705d23\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dateScrubRecognizer.js\":\"37407cedc1bc7f92\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/deletionGuard.js\":\"e8b251092d55714e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/dueQuery.js\":\"d34f79e33e9826be\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/index.js\":\"e829b36142049920\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/landing.js\":\"65bce1f352ff8eaf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/localSchema.js\":\"5df4604df7719b1d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/referenceDateAdapter.js\":\"fa40a08e96342dd7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/rescheduleAction.js\":\"121704e2292d470c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/schema.js\":\"55d1297d46081cb8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/spreadBlockDates.js\":\"6076c61e4341970f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/spreadDatesAction.js\":\"27f1bfad09c44d53\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/today.js\":\"ce1a9a166a32ba41\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a84bfbed480a8329\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"869eb55851442476\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/audit.js\":\"8419fb3a12d1a720\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/auditAction.js\":\"71c518a58460e5e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/auditRanges.js\":\"cd6d437d8f6000b8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/diagnosticsSource.js\":\"514022e2c29b6aba\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/divergenceScan.js\":\"e297af82e5d3c698\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/index.js\":\"f25146845279cfbd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/propertyChildrenChecks.js\":\"1e294d2aa911c154\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/referencesMirror.js\":\"2bfc41765522a76e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/rowJson.js\":\"c2a6659c75663a77\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/schedule.js\":\"fb0a120c60a237bb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/data-integrity/store.js\":\"ea167c5e2f2c7294\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/action.js\":\"76cf4b099e62af6d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/index.js\":\"c43c523e6827e80d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-maintenance/plugin.js\":\"47206edf3b82f831\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"46417046b899fcc4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/actions.js\":\"409437b2c4726850\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/changeMarker.js\":\"0f70398e25f159db\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/diagnostics.js\":\"6ab844eaeefef90d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/fileSystemAccess.js\":\"7e16b22f55db9234\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/filenames.js\":\"b520ceb7f8b60a80\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/index.js\":\"0e789a4081b957c7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/mirror.js\":\"174fbf35142e8301\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/runLock.js\":\"161d826813fc9707\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/runtimeHealth.js\":\"0e70d0e46aa9aa64\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/schedule.js\":\"be2774c54fa90709\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/db-mirror/store.js\":\"567b10c18707715c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/default-themes/index.js\":\"70f9196441ca4b64\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/default-themes/themes.js\":\"092c249ca5e3cd9b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/diagnostics/facet.js\":\"abb2d6a31eb5d89f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/diagnostics/useDiagnostics.js\":\"86c4fe048e20c10c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/dismissals.js\":\"b20f86b116576190\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/index.js\":\"b1fa9c9ee0babd86\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/status.js\":\"5735d6b55cdf3bec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extension-prompts/store.js\":\"188e68cac12635bc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"36a253593078c6fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/ExtensionsSettings.js\":\"413199844ddecf95\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/actions.js\":\"c35b53744853691f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/config.js\":\"aa3b8c8a02ec4052\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/dataExtension.js\":\"a88afca3f6d7b81e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/effect.js\":\"e0c604e22f814d3e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/index.js\":\"45cca2abd7f7c1c0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d11d20b97c237cec\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extensions-settings/useToggleTree.js\":\"62e9d04c756866a7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/ExtractTypeDialog.js\":\"154393d3966f77d4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d6723f2211d7adf8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/PropertyShapePicker.js\":\"3175bc10946447cc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/action.js\":\"4d49805d3734584e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/extract-type/index.js\":\"c1d871d544777ff8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/FindReplaceDialog.js\":\"bcce6ee87459d998\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/HeaderItem.js\":\"17eb632c129bee32\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/dataExtension.js\":\"9585ae90895dca92\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/index.js\":\"0e1fa630b874dad5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/search.js\":\"7120535564248993\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/toggleStore.js\":\"aadee27c5c3925de\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/LocationPropertyEditor.js\":\"2c92af0d199e55ab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/MapView.js\":\"b6552af9e95d405d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/blockTypes.js\":\"d0b1bce2afa697f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/codeMirrorExtensions.js\":\"773d02fa98e12281\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/createOrFindPlace.js\":\"05042339d7f12ab2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/currentLocation.js\":\"21cc77f4ec70daf9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/dataExtension.js\":\"5cd8b42843f5ca57\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/geoContentDecorator.js\":\"2d67fb2e2df736a4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/googlePlacesClient.js\":\"7c0c8633658f3ebd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/index.js\":\"4a4f53327e5244a5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/locationsPage.js\":\"c9449a5881f59c7b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/mapViewport.js\":\"2567e2487f37bc61\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/pickCurrentLocation.js\":\"932dd4c315e490b2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/placeAutocomplete.js\":\"b40c07095372612a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/placeNameCollision.js\":\"a2743963fec51054\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/properties.js\":\"3b3c80f1148ce078\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/propertyEditorOverrides.js\":\"39ff323e2941f177\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/query.js\":\"87213781d5fcd33d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/geo/usePlaceSearch.js\":\"d0cdb83d3b44d01c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"fc5c98f8cc5c0e19\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b847ba856bd2e1d0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"16c8f49990fc86bb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/config.js\":\"d9fdd2e32066c854\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/dataExtension.js\":\"71534c67cbe74c90\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/facet.js\":\"2bd0e9cf5ebff5e3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/grouping.js\":\"29af4ce6eae4357c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/index.js\":\"6f88545ba4c0cd6d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"90f5c1d0a831776a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/query.js\":\"92f7fb2c10181c42\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/resolveConfig.js\":\"6746876006bc537c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"60207e36ce438864\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"db481ccb5ba5da61\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/HtmlDocumentContent.js\":\"4727b2f47ce217b7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/HtmlFrame.js\":\"1326ec2961f789f5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/actions.js\":\"5c013af1a1427b1d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/blockType.js\":\"b4e776b20fa0f996\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/confirmRunScripts.js\":\"19624a20b5a26701\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/dataExtension.js\":\"e1a43d36409a997a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameAnnotations.js\":\"2a0131d8ac20596c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameDocument.js\":\"0bf10e5fadae3cca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/frameTheme.js\":\"57405576f574965b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/index.js\":\"9a0d23277994a665\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/scriptConsent.js\":\"308addb66ff03321\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/sourceMap.js\":\"10a386018fa013f1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/html-document/useDocumentScripts.js\":\"0aafef8c6d6c369e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/index.js\":\"8b3f0a6199753cfb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/record.js\":\"681d6416d7234066\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/recordStore.js\":\"8a149914b847a990\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/responsiveness.js\":\"d092317959ae6cf2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/schedule.js\":\"240a38e17a8befd4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/interaction-metrics/sessionContext.js\":\"9362d039ab34c636\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"7ed380f2fdfa61c8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c4aa9b337b139a0e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/actions.js\":\"1b0c368a746ba1ea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/config.js\":\"375472e22094b386\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/dataExtension.js\":\"6847c8c6506ae15f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/effect.js\":\"fddc6e2c6e6bba64\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/index.js\":\"fb4cee2bbb88d9ad\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/keyCapture.js\":\"66b9fd351bb1bf5a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/overrideStore.js\":\"c11a5f76f9e7c663\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a2dacc9b4a53365f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/HeaderItem.js\":\"294651e77abf0975\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/LeftSidebar.js\":\"b4b2180902c3fb40\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/actions.js\":\"7ad88a04d5a92a04\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/facet.js\":\"7b2f02e2b39649e5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/index.js\":\"55913b61a9f6524f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/shortcuts.js\":\"07fa311736a7927c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/left-sidebar/toggleStore.js\":\"c37f835af82b3512\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/MergePicker.js\":\"3d562b6de195a4e7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/index.js\":\"5e2cfccd96d46799\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/mergeAction.js\":\"05f6c06e7d335f6a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/merge-blocks/strategy.js\":\"3401917c440e0699\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/Button.js\":\"c3a0894606b92ed8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c0195c26dddb0020\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/defaultItems.js\":\"1a73594765e95f52\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/facet.js\":\"6f68dff6f1fe3222\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-bottom-nav/index.js\":\"290a40c0b8ea8b09\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8681621101873663\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/actions.js\":\"fc977e7dbda99af1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"475e041fb45c33c1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/facet.js\":\"fe4b53860c71d506\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/mobile-keyboard-toolbar/index.js\":\"552ba7cea82805ad\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4e53adeb1bdcd642\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/blockSubtreeMembership.js\":\"033f84c62c2a9b68\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/contextMenuItem.js\":\"90dd2f308bccf179\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/index.js\":\"b57db86a526f4e9c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/moveAction.js\":\"afea8fd44d7891e6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/moveBlocks.js\":\"ebaf21d57737cbdd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/move-blocks/selectionAfterMove.js\":\"d40eb647e7daa9c3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/TutorialBanner.js\":\"cb08d4fe9708a35a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/action.js\":\"d3ee1cbd00e6e65f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/bannerDismissal.js\":\"9bacd7c36856fb35\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/documents/cheatSheet.js\":\"55fe04294a860621\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/index.js\":\"3e586fbcd7e4ed9f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/keys.js\":\"51a455ba1491cc7d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/landing.js\":\"60a3aad7edc733ae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/outline.js\":\"f222cc9780caf159\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/onboarding/seed.js\":\"d099f7c747b068e1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a0b321f278cdc872\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/analyze.js\":\"545a0a8a9a9af527\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/diagnosticsSource.js\":\"a5ee89676f8404ca\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/index.js\":\"b9c78d7bc2d13247\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/load.js\":\"4d990c098a985161\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/monitorRun.js\":\"99ebe6ac3086e60c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/schedule.js\":\"c498d83a113e68cb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/series.js\":\"cea95f30fc112a53\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/store.js\":\"e10fea356d8af8d2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/trendAction.js\":\"b09e42ceefd9a61d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/perf-monitor/verdict.js\":\"ca3ab2e595375d51\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/clickToEditAction.js\":\"4ae9e15eb205af39\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/index.js\":\"c3b1a00c17286641\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/plain-outliner/interactions.js\":\"16941cf4e52e3403\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5382851af5ff041d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/MigrationGate.js\":\"6bd7159fb0c8cd65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/MigrationGateDialog.js\":\"0b840c1c262255fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/action.js\":\"feca4591f677c755\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/index.js\":\"1aaa9a0b7e82bb66\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/localRunMessage.js\":\"5184bc5b3401d2fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/plugin.js\":\"6090f08ab941619f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/progressReport.js\":\"353730a4c5095ce6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/properties-migration/sweepProgress.js\":\"7b120056bac7e949\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/FieldRowRenderer.js\":\"c77e036d7ea50545\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/ValueRowRenderer.js\":\"a83307963eae5e69\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/actions.js\":\"ed0f3e176711ee51\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/autocomplete.js\":\"9fcc2faec73d8344\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/fieldRow.js\":\"f9bc332205d5f120\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/index.js\":\"43b82582b7880ed7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/referenceWarning.js\":\"86f5641b64008f07\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/valueAutocomplete.js\":\"1e22c0503896d83c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/property-rows/valueSchema.js\":\"d48a08c502f49a08\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/HeaderItem.js\":\"12bdcc2915c5d713\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/QuickFind.js\":\"26b87bf19829ec05\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/index.js\":\"ee94b9fcc80fcb9c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/recents.js\":\"35e93d8ab4e6d606\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/resultItems.js\":\"81e20657195d7803\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/selection.js\":\"72292783fdce1be6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/quick-find/toggleStore.js\":\"f41a82c8c08e3b7e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/HeaderItem.js\":\"da47d762380e4735\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c2e360c1966e36fb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/grouping.js\":\"7ee89c3b895a11c3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/index.js\":\"98974b08cfe774b7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/recents/target.js\":\"8ca82e38774ffd3d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/codeMirrorExtensions.js\":\"b850e2538b5a59fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/contentPrefill.js\":\"d4aa0187dacf7771\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/dataExtension.js\":\"d6c464cde37305e4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/index.js\":\"dede07ca2ebb3fa1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5d9f32d06b6568dc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/invalidation.js\":\"f359a94f1b4199a1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/localSchema.js\":\"e74e34261a65a5f4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/blockrefs/index.js\":\"cf5af81351a081b1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0a8110e36ff1afd7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/index.js\":\"85d115091384695c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/referenceNode.js\":\"d341e4202fe07427\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2b1aca6d4e5bee9c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"25534a18c9ee6e56\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/index.js\":\"f1b5fe49ee609305\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"cb1b783c1b0e531d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e6d9514458390e6e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/mergeRetargetProcessor.js\":\"2a072bc845818fee\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/parseFence.js\":\"6ad03c4feeca3e65\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referenceParser.js\":\"784aaac0c326519c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referenceProjection.js\":\"38a0501af8ab59ae\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/referencesProcessor.js\":\"613fc797950d0d5f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/renameProcessor.js\":\"322052e584149703\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/references/spanReplacement.js\":\"3d67e1e5719a44c9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/htmlToOutline.js\":\"ff44d2ba86cc3b45\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/index.js\":\"1a5bba413c188d9a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/normalizeClipboardDom.js\":\"4d35fc116dc1505e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/rich-paste/pasteDecision.js\":\"3d504a463f8ecb1a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/action.js\":\"995be5fd051d36a0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/blockIds.js\":\"2cffd96b7e10913c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/content.js\":\"30e3ec485a8edaa2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/effect.js\":\"b4d49974f9e7ff2b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/ids.js\":\"acdb8c991804885e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/import.js\":\"18017b85b985d15a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/index.js\":\"cf3084ebd47543c4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/plan.js\":\"91b492507e12a109\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/plugin.js\":\"9cee9fdc9a7c1046\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/promotion.js\":\"3d4b2a3fadb2a627\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/properties.js\":\"fe51d0c0dd310340\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/references.js\":\"f2b6e8a357b689df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/report.js\":\"b150ea6a38219da4\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/roamMemo.js\":\"d93cb7709d7fe570\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/runtime.js\":\"cbbb644308bacbf7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/schemaReconciliation.js\":\"c741a9a454fdfa9f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/srsMarkers.js\":\"b9e5c4d23bd6dac6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/todo.js\":\"7850a0e0184a56c0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/typeCandidates.js\":\"dadf18e1a7b76b91\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/roam-import/types.js\":\"bc0fd05ebc87a409\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/search-health/index.js\":\"60fe6574847e017a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/search-health/store.js\":\"f2a768c4eee52fc1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/HeaderItem.js\":\"4e3cd9eada120e25\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3a9b9a8f6110a9fd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/index.js\":\"207ae025f445827c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/model.js\":\"e7e9fe7ccd90bd69\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/toggleStore.js\":\"a8b95ac6e35404a2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/shortcut-help/useKeyInspector.js\":\"c4a83399300b338f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0272dfac0c3e13e2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/ShellDecorator.js\":\"c6c5fc7d75ea56ab\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/actions.js\":\"845d62d0fd2ac632\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bc8935ffb6214ee0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/index.js\":\"cc8488aedeeaa408\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/shell.js\":\"210b28dc109e9caa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/surface.js\":\"65bd40f3146c8b61\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/spatial-navigation/walker.js\":\"0ff06782c7b1f7c8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/RescheduleToast.js\":\"423a985c9c2f5be2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/dataExtension.js\":\"50bd84d369c05a5f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/index.js\":\"98570aee6bc91485\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/indicator.js\":\"a5ed8b3cf7495780\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/moveSrsState.js\":\"3aba3f56df317b9f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6c055e1b79fbaf5d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/scheduler.js\":\"ed68921551bd1931\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/schema.js\":\"dcc44684445cb488\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"df901faaaa8f2388\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/srsClipboard.js\":\"74ef2f9895c5c9fc\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b6a5b69b08b39179\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2af07e0fbbc95024\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/DeckPicker.js\":\"534a7a1d059d5638\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewControls.js\":\"237a15e2bf868ddb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8492720ceb13685c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/ReviewSession.js\":\"9d002f8cad8c5d34\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/actions.js\":\"dd4c5628682923b9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/archive.js\":\"7b5d23709884ca91\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/dataExtension.js\":\"be65e6d3e4dd2f2b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/deck.js\":\"373cb285c1777926\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/dueQuery.js\":\"bc865e217e4f17b9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/gradeDecision.js\":\"b99a4f103fb379bb\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/index.js\":\"02c45e7d6e6d842f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/keyHints.js\":\"9986b42cd484aaa2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/reviewCardLayout.js\":\"96aa16af2ed4a198\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/reviewProgress.js\":\"8e47c622165f7778\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/schema.js\":\"bd7677aba498585d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/srs-review/useDueCards.js\":\"bc63f0af86476378\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/startup-metrics/index.js\":\"a76b2477a7776120\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/startup-metrics/record.js\":\"9aa5c41225ec21a7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/index.js\":\"4cbbcd285288d1de\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/persistenceStatus.js\":\"dc675654b60545fd\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/storage-persistence/requestAction.js\":\"12e218b0143893df\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/TypeChipsDecorator.js\":\"cdf9f4923caed3b6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/codeMirrorExtensions.js\":\"b948e73bb091f5ac\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/index.js\":\"5ae176a9525eed3b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/supertags/typeAutocomplete.js\":\"867d359f21d41fb9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0b3f5e8fdf442440\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/actions.js\":\"711d14608b12b25d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/anchor.js\":\"60d702d314c6c047\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/events.js\":\"ef60ea7f194fd5c5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/gestureActions.js\":\"35d02bc76da42a11\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/index.js\":\"548404800aa8c017\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"7cd1ec1bc0c4c2a8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/collect.js\":\"8029bd4b4666a7bf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/index.js\":\"fa92640ad0d34156\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/sync-metrics/record.js\":\"91f5759ba140d04f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/RejectionDialog.js\":\"2735cc9e80681956\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/SystemStatusHeaderItem.js\":\"fa0bd3c46c3f8b83\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/index.js\":\"c9c891b2dbf96b7b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/model.js\":\"25a2d33bd12cfe56\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/queueCounts.js\":\"fd943195617b0575\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/rejectedHelpers.js\":\"b8026e6b62e429a2\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/rematerializeAction.js\":\"15122755a4eab41c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/system-status/useHysteresis.js\":\"6e45f0b48ad9b18e\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/ColumnHeaders.js\":\"54dda326b03588f1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/QueryUi.js\":\"3935cf4cbda522d3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/TableLayout.js\":\"c4befa4255dd512a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/actions.js\":\"c844c60369655085\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/cellEdits.js\":\"fc860eb1660b6394\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/columns.js\":\"13e1e5ac9ad78d13\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/controller.js\":\"db07f38dd09549cf\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/convert.js\":\"1371bd4b94fa5623\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/dataExtension.js\":\"fba6c5ccb39fca12\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/index.js\":\"9e746c3d699e7450\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/keys.js\":\"bbdb0bbac09fe182\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/model.js\":\"bebe3973f12d0ff5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/backfill.js\":\"799a69511514d049\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/format.js\":\"5725a3e90e16f95f\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/parse.js\":\"ce4ae2aad7c7ac29\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/queryValue.js\":\"25e656a839725150\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/query/source.js\":\"ad350162c54f2a44\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/registry.js\":\"9570df37f87d8f05\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/schema.js\":\"ae8be10e6c97fcf7\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/tables/sort.js\":\"8aa0b4cc0fd36cc0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/effect.js\":\"fd0cf0511dc2953b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/index.js\":\"a2c68b300f43b440\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/theme-toggle/theme.js\":\"0ed7d8f991156323\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/actions.js\":\"2521866c55bc2577\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/dataExtension.js\":\"1a7bdeba85dca984\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/index.js\":\"f17b1df72fb2fac1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/todo/schema.js\":\"8256a3957220a495\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/TouchSelectionLayer.js\":\"702fe57b3f425aa6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/actions.js\":\"8782529797833844\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/defaultItems.js\":\"9edeeb2c3a7f8b7c\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/facet.js\":\"e343a6c4b6e206a1\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/holdRecognizer.js\":\"3b419c41c90d156a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/touch-selection/index.js\":\"4ff381be774ad858\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/UpdateIndicator.js\":\"09de50270b15004d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/index.js\":\"cf1de7c81f8d87e0\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/update-indicator/loadTimes.js\":\"729c85ec14e4f322\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoNotesRenderer.js\":\"8648aa131701a2b8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoPlayerRenderer.js\":\"3513cac408ba37b5\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/VideoTimeStamp.js\":\"27d9c53cec8910fa\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/actions.js\":\"d3322a63da0d2b90\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/index.js\":\"41b0ca51744f7db8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/markdown.js\":\"76ab3a24d7f1126d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/notes.js\":\"2f3fc4f726e98ede\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/registry.js\":\"10e340ce839354ea\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/remark-timestamps.js\":\"6758a6c120a67b7d\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/video-player/view.js\":\"b4056de3ecce0883\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/LinkHints.js\":\"de33934e903565f8\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/index.js\":\"c2cfe198d0dd045b\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/model.js\":\"cea03792182c62b6\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-link-hints/settings.js\":\"e49e32b38f7f94d9\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/actions.js\":\"54fa5fc3dace4a4a\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/index.js\":\"cf9c7f848fbdccf3\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/vim-normal-mode/interactions.js\":\"c177ff7b77c71956\",\"/knowledge-medium/pr-preview/pr-1849/src/plugins/workspace-header/index.js\":\"a2d3c891e624dd64\",\"/knowledge-medium/pr-preview/pr-1849/src/registerServiceWorker.js\":\"c3f10fcbd817d1bd\",\"/knowledge-medium/pr-preview/pr-1849/src/requestPersistentStorage.js\":\"925dd27b6ba01847\",\"/knowledge-medium/pr-preview/pr-1849/src/services/authRequestDeadline.js\":\"350730deb62efb77\",\"/knowledge-medium/pr-preview/pr-1849/src/services/authStorage.js\":\"65ccd2e80aeba0af\",\"/knowledge-medium/pr-preview/pr-1849/src/services/powersync.js\":\"f66fdae79a512ed8\",\"/knowledge-medium/pr-preview/pr-1849/src/services/supabase.js\":\"40edc7a50a4c55bc\",\"/knowledge-medium/pr-preview/pr-1849/src/services/uploadErrorClassifier.js\":\"179102b046c09d7e\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/ActiveContexts.js\":\"728490921d2241bf\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/HotkeyReconciler.js\":\"faf0589da868c75f\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/WipeLocalDataDialog.js\":\"4a28ce5e57698c07\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/actionDispatch.js\":\"af05cc8f080ab2cd\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/actionRefItems.js\":\"388cd7fc4da36a88\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/applyKeybindingOverrides.js\":\"4476cd0a3d917d3e\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/blockActions.js\":\"302c542c719827e2\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/canonicalizeChord.js\":\"26ff76d2307169a5\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/defaultContexts.js\":\"f467d8c92931da58\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/defaultShortcuts.js\":\"d1d6a7bf2d8250ce\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/effectiveActions.js\":\"6367b124564f39ee\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/gestureAction.js\":\"568389e8d804ec71\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/gestureBinding.js\":\"0f86f0958b22c943\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/holdRegistry.js\":\"ee6a2d92099006ef\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/keybindingConflicts.js\":\"6f4064dd3b4bf46e\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/keybindingOverrides.js\":\"f66fa912350ee016\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/pointerAction.js\":\"b8086546f7b7e702\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/resolve.js\":\"24e21d4efea9aa84\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/runAction.js\":\"b7097c3c5dbfb24d\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/sequenceMatcher.js\":\"5afce0222bbcee34\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/types.js\":\"8672ac8148661ccc\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/useActionContext.js\":\"213e2044abe77ce3\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/useActionDiscovery.js\":\"0f7b00eb56ea6067\",\"/knowledge-medium/pr-preview/pr-1849/src/shortcuts/utils.js\":\"4f8dd5df1d324d69\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/bootStore.js\":\"1019c79e55bb8894\",\"/knowledge-medium/pr-preview/pr-1849/src/sw/previewDatabases.js\":\"d2b3e80b467e3235\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/byteTransform.js\":\"4418a467eef5231e\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/attachmentCleaner.js\":\"d5782e6da5a8ffff\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/attachmentParts.js\":\"7766e583e3b94fcb\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/bundleParts.js\":\"60b167e26676666c\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/bundleRecord.js\":\"a25a25bfb01ef4f7\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/manifest.js\":\"ba08ac420284dcbb\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/takeBundle.js\":\"52a62015d90dd004\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/bundle/verifyBundle.js\":\"d6aedfd913d80b03\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/cleaningStage.js\":\"42f3aa60c5e02244\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionKey.js\":\"a63b68aaefd9c423\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/conversionServer.js\":\"4e04700f1b351e4d\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/flip.js\":\"dcafdd60a368e2ba\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/flipAttempts.js\":\"0dc695d104473f53\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/pages.js\":\"677ec61623c3a924\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/preflight.js\":\"c7974a6436a96d87\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/reseal.js\":\"8b9f56272608d721\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/runConversion.js\":\"ef2253233357c7ea\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/runLock.js\":\"717a6a3215f2af62\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/sealing.js\":\"50bc3ee211748800\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/sealingStage.js\":\"04f3408ed981c47e\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/stage.js\":\"c0c31d47380da57f\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/conversion/verifyReseal.js\":\"8465f053c4e18866\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/aad.js\":\"2cbc00541fb74f38\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/aead.js\":\"efd5970ead75bd13\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/base32.js\":\"cedca89b7ec7a627\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/base64url.js\":\"45bcc5db88fd01d2\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/binaryEnvelope.js\":\"d090fdc2aefa3692\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/byteAead.js\":\"ac2a4228abbd4180\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/canary.js\":\"79f8a9c32bc560b8\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/contentHash.js\":\"d6e813dc8651886a\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/contentKey.js\":\"8ca575f49a831026\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/derivedIdNamespace.js\":\"a33cfe4f39693662\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/envelope.js\":\"c89eaa4717e108e1\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/hex.js\":\"69cf0b39918eacc5\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/sha256Hex.js\":\"976ed1dcf3199a35\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/crypto/workspaceKey.js\":\"8527df66675af7ba\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/conversionState.js\":\"c61e056ad8f1afb7\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e366b05820298378\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/pastedKey.js\":\"6734a2f30411441d\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5e4dd07ea50204d5\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2c027138a506abdf\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/keyStore.js\":\"0b985221414cc216\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/mintWorkspaceKey.js\":\"292f9e1413411599\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/modePin.js\":\"c8d8b9c6ff3e857d\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/openWorkspaceKeys.js\":\"dd0f12a6aa5ad5be\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/resolveWorkspaceEntry.js\":\"ab08b6a1ec757130\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/resolver.js\":\"00ab1da002a4765b\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/keys/workspaceAccess.js\":\"4694358ca933a55b\",\"/knowledge-medium/pr-preview/pr-1849/src/sync/transform.js\":\"aca0af2eaedf40ff\",\"/knowledge-medium/pr-preview/pr-1849/src/themeBootDefaults.js\":\"bae5cae5ff25ddeb\",\"/knowledge-medium/pr-preview/pr-1849/src/types.js\":\"7697590c3a230292\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/ClientLocalSettings.js\":\"c85c42baa0cddfb7\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/abortableSleep.js\":\"f9c88e4227f54a50\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/array.js\":\"c857d3454621dc9b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/backlinkAutocomplete.js\":\"3dcf718fcc638a43\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/blockCrumbs.js\":\"308c9fd678bcb5c1\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/blockrefAutocomplete.js\":\"6cec9ee63f1aec45\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/cadencedIdleJob.js\":\"fe50fa1a6054a482\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/callbackSet.js\":\"462d4c04d72e37cb\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/clientId.js\":\"86196c9b81263a91\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/codemirror.js\":\"234331f26dd378db\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/codemirrorCompletion.js\":\"84e45d224eef716c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/copy.js\":\"169d369ec99dc2a1\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dailyPage.js\":\"e114cd18fd62f99a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dbForensics.js\":\"33166239f73819a5\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dbForensicsHooks.js\":\"9c80ed98ee356890\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/deleteBlockThroughUi.js\":\"fc5a6b78e496bf2e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dialogs.js\":\"3001de01e7ff1f54\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/dom.js\":\"9067212f3f0d149c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/downloadBlob.js\":\"e607e3cfeb57f536\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/exportSqliteDb.js\":\"426c7437d816c828\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fileSystemAccess.js\":\"b8eec69790ddf338\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/flipSlide.js\":\"070388e6c1b67521\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fnv1a.js\":\"343245f5cebc6da7\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/formatBytes.js\":\"b2629d3c4e84e067\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/fuzzyRank.js\":\"6dc90c70cb22eabf\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/idbKeyedStore.js\":\"c482fd7d56bd57d8\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/idleCallbackPolyfill.js\":\"d861497dcc0d9dd6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/keyboardAwareScroll.js\":\"14dbe86904310bea\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/keyboardViewport.js\":\"5c56fb3d8ed5fb1f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/lastWorkspace.js\":\"093e11e7b1ebd05c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutColumns.js\":\"2b9e8cfa24d62e7b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutSessionDom.js\":\"b3ee69a3892731b8\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/layoutSessionId.js\":\"6cf2cd16d721f750\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/linkClickGestures.js\":\"170af89e9d68c0dc\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/linkTargetAutocomplete.js\":\"05b51a5eaaa1415b\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/localDbCorruption.js\":\"e0ddd865bc19defb\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/localDbRecovery.js\":\"511b1be06af786d9\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/markdownParser.js\":\"9d8b0e8acf5b7ec0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/memoize.js\":\"917b6404c2b51c12\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/nameFieldCommit.js\":\"f9d395ba3d6bf014\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/nameList.js\":\"c563d1ff7b7a54b4\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/navigation.js\":\"50312671ca68dd1d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/omnilinerNamespace.js\":\"f6ec1ea2e3c3b052\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/opfsPageScan.js\":\"d6a075b52e7e8ca0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelClearance.js\":\"c625864026efe87f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelHistory.js\":\"b82d9645ee77b93f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelLanes.js\":\"64f6481f5850bc59\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelLayoutProjection.js\":\"90aa4a47655e284a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelScrollAnchor.js\":\"bbde6d5c1fab9b54\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/panelUrlFlags.js\":\"5f981ae8e9b71d2a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/platform.js\":\"5082ce76d4ff2d3c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/pluralize.js\":\"e6b953804083935e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyCreation.js\":\"ae7f8c731881b369\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyNavigation.js\":\"7d975e4d48f7f29d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/propertyValueContext.js\":\"45cf26b7f3345d96\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/react.js\":\"163f199fe924946f\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/relativeDate.js\":\"fc4e7f9814d54761\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/relativeTime.js\":\"53bbfb33a4b46232\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/renderScope.js\":\"f4337ce043b56ed5\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/resolvedThenable.js\":\"233fbc317d552d31\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/routing.js\":\"b69fcde7bd5e71e0\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/safeMode.js\":\"5784479f4632645a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/scheduleIdle.js\":\"34b8986967085632\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/screenWakeLock.js\":\"ba1f21f1e681c0c8\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/selection.js\":\"fdde1a9f59b3fff4\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/softKeyboardGrab.js\":\"9f0af64998596619\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/startupTimeline.js\":\"6ce762725e19174a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/state.js\":\"68d4f0fc45f12669\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/string.js\":\"0f41443ef35b9ff6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/surfaceZoom.js\":\"e78c843daa190284\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/time.js\":\"27d4844dc784ef8a\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/toast.js\":\"e684fe6d6a888814\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/toggleStore.js\":\"51f8392ee4f6009d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/untilStopped.js\":\"09b4bd730c91333c\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/userActivity.js\":\"e1a5cb7f861dc5bd\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/viewTransition.js\":\"c40e1a1b63184704\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/viewport.js\":\"54e6e877bd3740f8\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/webLock.js\":\"80fc70696304676e\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/workspaceRecovery.js\":\"146cb4d0f945cb7d\",\"/knowledge-medium/pr-preview/pr-1849/src/utils/workspaceSnapshotStore.js\":\"a087a1e6d59f92b6\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-compiler-runtime.js\":\"c980ccd7a44a1411\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-client.js\":\"66c9fe4f780ae81a\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-server-edge.js\":\"c0106264f5b5d97d\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-server.js\":\"f255c84ed8773907\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-static-edge.js\":\"39e1bad663e986b3\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-static.js\":\"91665a9e0df80499\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom-test-utils.js\":\"9299ede6383382cd\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-dom.js\":\"e1dd714460ba032f\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react-jsx-runtime.js\":\"a0b3138120c8e1f2\",\"/knowledge-medium/pr-preview/pr-1849/src/vendor/react.js\":\"3cca158fb50675b3\",\"/knowledge-medium/pr-preview/pr-1849/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1849/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1849/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
