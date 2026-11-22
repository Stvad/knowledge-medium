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
		buildId: "a59d8bff03b4-8f3f249e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/\":\"edf5597b5677a00c\",\"/knowledge-medium/pr-preview/pr-1850/index.html\":\"edf5597b5677a00c\",\"/knowledge-medium/pr-preview/pr-1850/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1850/assets/FacadeVFS-C3YaxVH5.js\":\"c0df8189857b81d6\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSCoopSyncVFS-B4MHOhJZ.js\":\"41a5843bf3786b10\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSWriteAheadVFS-Bnpvgrdn.js\":\"aaafb46dbe1fabd2\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-C0f-xGTU.js\":\"723f0a1c012357db\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-Djlkx6W6.js\":\"9574ac053ba011f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/worker-CDPWNcV9.js\":\"300a17428e4a5990\",\"/knowledge-medium/pr-preview/pr-1850/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1850/chunks/app-BtX2RBb9.js\":\"9e9e6615fbba23d9\",\"/knowledge-medium/pr-preview/pr-1850/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1850/index.js\":\"6dc97287c9594289\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1850/assets/AccessHandlePoolVFS-CjsnhIX7.js\":\"049857fa6c2c8ce7\",\"/knowledge-medium/pr-preview/pr-1850/assets/IDBBatchAtomicVFS-Bd8YX9nf.js\":\"b4044f5239497377\",\"/knowledge-medium/pr-preview/pr-1850/assets/MemoryVFS-B8T71J8j.js\":\"0dcdbc69f987e47b\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-DgeMTr2L.js\":\"c54753da65c0c565\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-DKE1_okS.js\":\"a8a5c5e8e98a84cb\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1850/chunks/AccessHandlePoolVFS-DGS_C1f5.js\":\"6cf6cd9e00e200d8\",\"/knowledge-medium/pr-preview/pr-1850/chunks/FacadeVFS-DSa94Ce0.js\":\"bf559cc4e7815429\",\"/knowledge-medium/pr-preview/pr-1850/chunks/IDBBatchAtomicVFS-CRO3tUu4.js\":\"56a688e0c1faef10\",\"/knowledge-medium/pr-preview/pr-1850/chunks/MemoryVFS-Dt00lM1v.js\":\"c03ed12fa20ec1f0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSCoopSyncVFS-CpgBAMrs.js\":\"ddc684cdcfadd2ac\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSWriteAheadVFS-Dx-_Jd52.js\":\"c02b75a1997f3f29\",\"/knowledge-medium/pr-preview/pr-1850/chunks/Preview-BOY0FVo2.js\":\"4bf0aad63daa8833\",\"/knowledge-medium/pr-preview/pr-1850/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/card-BRVXCBdg.js\":\"554e70f1b22cffeb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BZQPLs3W.js\":\"1e14d21be70781c6\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-3XaDUhkh.js\":\"bda9bc9ec18249b0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-async-CbRt5IV5.js\":\"924f2a0a8ccb7fb2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-6PY6dWqn.js\":\"c4c04be540495eef\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BH-VvW0P.js\":\"7f0cc9bf5259ec81\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-Bg0-24C6.js\":\"04780a3dc5c2338a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CKcfTmgl.js\":\"9fed35ac8b1f69b1\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-Dtpvmx6l.js\":\"56a0176ba79d5a90\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-NrolrGCz.js\":\"e2b9abf07dacaafb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-TuBrxi8k.js\":\"32cb7fd1abf01219\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-bL-8CKp6.js\":\"707cffb206147337\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server-legacy.browser.production-CjQkSm12.js\":\"7b24f79ecf391299\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.browser.production-Cuc8G58n.js\":\"bee13885b3d67295\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.edge.production-qwR7knYT.js\":\"37199b28e03fae2f\",\"/knowledge-medium/pr-preview/pr-1850/chunks/server.browser-CTe5bRGb.js\":\"0d7fb11905850421\",\"/knowledge-medium/pr-preview/pr-1850/chunks/textarea-BPpFCSVg.js\":\"c4f995e48f898661\",\"/knowledge-medium/pr-preview/pr-1850/chunks/ui-BQcvnw1t.js\":\"30d8e71701a9bd73\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-CKYkn7lL.js\":\"61af9430e5900fcb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-async-CTvqRNLY.js\":\"4918cebd32c5c0df\",\"/knowledge-medium/pr-preview/pr-1850/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1850/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/src/App.js\":\"bbf2481e168f75e4\",\"/knowledge-medium/pr-preview/pr-1850/src/appUpdate.js\":\"367805ff70e46de6\",\"/knowledge-medium/pr-preview/pr-1850/src/appVersion.js\":\"36ad54961d06f4ac\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/initialLayout.js\":\"b6a754809f1b1b72\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/openWorkspaceData.js\":\"c22dc14ca54d4d0d\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/resolveWorkspace.js\":\"2e8516a51e64bd8a\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/workspaceBootstrap.js\":\"5374be65ec1d9b37\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockComponent.js\":\"8750ba2f9d937659\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockCrumbs.js\":\"e7ec7e873917a4f0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockEditor.js\":\"66fd4b84761a93f5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockLoadingPlaceholder.js\":\"9480221ff45e07d9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockProperties.js\":\"bbf91a0a7320086a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockSearchPicker.js\":\"2e98f47936ba4f00\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ConfirmBulkDeleteDialog.js\":\"12cff3b5330c041d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DividerHandle.js\":\"9e8a7ed55a416f3d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DraftEditor.js\":\"48d681184c1c2b0c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/GutterPill.js\":\"a234aa9161fcd08d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Header.js\":\"f245ca45a3c5b582\",\"/knowledge-medium/pr-preview/pr-1850/src/components/LazyBlockComponent.js\":\"820e4e3186ae1145\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Login.js\":\"d0bb34ff4b441765\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ZoomableSurface.js\":\"06a2fcdc58caa1d0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/editModeKeepalive.js\":\"610bac712dca82e4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9db85209e759420e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"9fab504c7a5ee973\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefPropertyEditor.js\":\"b4d4f72a331a27ed\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefTargetTypePicker.js\":\"a7597bf40977ba9a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/SelectPropertyEditor.js\":\"129d52ea114a135e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/TypesPropertyEditor.js\":\"9a49284ead3e0e86\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/defaults.js\":\"bbbca48eb2e87639\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/kernelValuePresets.js\":\"94bb12c3d97d554a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/selectablePresets.js\":\"abbd487fd912c91e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/typesPropertyUi.js\":\"6c4723d0c0f08160\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/AddPropertyForm.js\":\"4814188cc1f35cfb\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyPicker.js\":\"591e05c76650f4a8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyRow.js\":\"bb08f9258112f626\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/Rows.js\":\"f231674cd2dd8ce9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/actions.js\":\"0592a0e203a4eecc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/declarationOnly.js\":\"36e39ad698eda665\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/layout.js\":\"5f403ceb6b72a348\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/model.js\":\"89f6161dedf6b40a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapeUi.js\":\"27b43101556c4c5d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapes.js\":\"91a2a361a33f84ae\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a848734a8e77a8df\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/visibility.js\":\"3dfa0d85acc20d16\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanelSections.js\":\"b3e712fe536a06bc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockEmbed.js\":\"9f031997ea9fa299\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockLink.js\":\"ec3f4b69457b87e9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockRef.js\":\"147df9be7f12bce7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/ReferenceLink.js\":\"1105b88b1cf3b7fa\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuard.js\":\"0684c54173721f4d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuardContext.js\":\"5bc7e9c958f5b109\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/linkInteraction.js\":\"b666ed66585af6c3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/referenceLayout.js\":\"9a6e28fb9f0e13a4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/useBlockRefAncestors.js\":\"16bc06df9cb8c34f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockGutter.js\":\"3c22d590a023e583\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockInfoDialog.js\":\"ab39fdb36c996bbf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockTypeBlockRenderer.js\":\"f2116018d3096ff1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BulletHoverCard.js\":\"eb2fc75fef4fb796\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorContentRenderer.js\":\"717f40fb20fa3baf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"717cb3650c519506\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ColumnResizeHandles.js\":\"509de5e93d00261d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b102885b9de7844a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/DefaultBlockRenderer.js\":\"f4b9ac08cb9a8180\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/LayoutRenderer.js\":\"fd02852784936ff6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MarkdownContentRenderer.js\":\"267277e082af1795\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MissingDataRenderer.js\":\"906a8cf006825a77\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PanelRenderer.js\":\"47ceb00493ef550a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PropertySchemaBlockRenderer.js\":\"99f4bc096a5de710\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/TopLevelRenderer.js\":\"41aa030f76a83c0f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockGutterMode.js\":\"ab6e34b08da2ed0a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockTitleText.js\":\"1f8690ad4bc6f3cc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/fieldCreationKeydown.js\":\"49e434a19fa44516\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/layoutRootContext.js\":\"bcc9ad4860b11d38\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/TypeChip.js\":\"c63686c71576ef63\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/chipStyle.js\":\"a178cafed95ddb76\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/anchored-floating.js\":\"dd70e79f5617abf2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/button.js\":\"16b8a8cc956dbbb1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/card.js\":\"456262d39545df44\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/checkbox.js\":\"fd4dbde1699f818a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/collapsible.js\":\"a5536e795332c862\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/command.js\":\"841fceaae7319114\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/context-menu.js\":\"90b8ee97874931ac\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dialog.js\":\"4d33b107571b244f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dropdown-menu.js\":\"3877fdc832f6719c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/floating-listbox.js\":\"e23b545f67b89981\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/index.js\":\"26bfd273ad3577a2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/input.js\":\"cdaef4f26cef8b08\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/kbd.js\":\"3ceaeebac44ccce2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/label.js\":\"2af596ec11e71cec\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/textarea.js\":\"06dd705cf3045192\",\"/knowledge-medium/pr-preview/pr-1850/src/components/useEditModeYieldKeepalive.js\":\"8ddee658c0dbf07e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/BootFallback.js\":\"30debab2cad800dd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/FocusedRowLazyMount.js\":\"c53ed5bf8fc9acd6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LazyViewportMount.js\":\"9692fced2ef354c1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LocalDbCorruptionFallback.js\":\"9e806861d3ef0553\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/error.js\":\"24115e52416bac85\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/lazyMountRegistry.js\":\"38b6d4249146c484\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/suspense.js\":\"02b536a6bdc46964\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/CreateWorkspaceDialog.js\":\"06696b0bc45f8b47\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/PendingInvitations.js\":\"aae82f7e683fe61b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/SyncProgress.js\":\"9e2a5393bc27a910\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/UnlockProgress.js\":\"1ab5e1edce06bad1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceKeyGate.js\":\"5469714e0c2e4297\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSettingsDialog.js\":\"47c22a3204acff09\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSwitcher.js\":\"1e1206f6245ecf97\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSyncGate.js\":\"ff05f371d41ec2ed\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlow.js\":\"039f522a87b6eb1e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlowHost.js\":\"a5715748573180ed\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/EncryptionSection.js\":\"40355b18ebf86c62\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/attachmentPrompts.js\":\"92d200769d932fee\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1af978554bd2812a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowDeps.js\":\"429718fe8e563da4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowStore.js\":\"4a14b11d13cefafc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/flowUi.js\":\"7aae8e658e36a34e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/useConversionRun.js\":\"f8b4ea99703f8e65\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/keyUi.js\":\"8dbc2f6dae55a6a7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnKeyLoss.js\":\"b4b2220784fc8f3c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnServerE2ee.js\":\"b7bd9b56ea348a84\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/workspaceUnlocked.js\":\"99c6d82340396852\",\"/knowledge-medium/pr-preview/pr-1850/src/context/backgroundSubtree.js\":\"1df3cc07314adf5b\",\"/knowledge-medium/pr-preview/pr-1850/src/context/block.js\":\"625406362e10b5ff\",\"/knowledge-medium/pr-preview/pr-1850/src/context/layoutWsContext.js\":\"8d75db9d71af4931\",\"/knowledge-medium/pr-preview/pr-1850/src/context/propertyDisplay.js\":\"de1d56228e878bbb\",\"/knowledge-medium/pr-preview/pr-1850/src/context/repo.js\":\"7694f606e2b18680\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasClaim.js\":\"92351993ff05aad8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasSeatNamespace.js\":\"7953a3ca2baffbed\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockData.js\":\"3e55b3b3284c0483\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockType.js\":\"7b7b8a65ca5e5865\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/changeScope.js\":\"cd3ef75e91478720\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/codecs.js\":\"a03de0a428592586\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/derivedData.js\":\"c28b4db69f7493d6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/errors.js\":\"e075d43faea35490\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/events.js\":\"02c68e12bde1273e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/handle.js\":\"05e3a95cadb6a6a8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/index.js\":\"e16bdd903a1f23ce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/mutator.js\":\"463d9e69f0013f5d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/processor.js\":\"a5fc5e020a4efef9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/propertySchema.js\":\"b0e46ba47a541648\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/query.js\":\"955d2c5b320e7887\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/sameTxProcessor.js\":\"6698b44b90530b6f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/schema.js\":\"05e3a95cadb6a6a8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/tx.js\":\"05e3a95cadb6a6a8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/typedBlockQuery.js\":\"75992cb235c3236d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/user.js\":\"a778e5626c2134ad\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresetCore.js\":\"c4f9c99a38b176b2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresets.js\":\"a159a81e43a3d115\",\"/knowledge-medium/pr-preview/pr-1850/src/data/attachmentCleanerIOVerb.js\":\"a520ad799f6a9000\",\"/knowledge-medium/pr-preview/pr-1850/src/data/block.js\":\"563cbee31194fc22\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockCache.js\":\"5d9b80b8e74135b6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockId.js\":\"6e1510bd7b1ffd07\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockLiveness.js\":\"738bbe1846997d9a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockMerge.js\":\"ccea02836136806a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockSchema.js\":\"9aabb4d59826a0cd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypeLookup.js\":\"4b93f7919dfd7a82\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypes.js\":\"d4afd697a7c763d7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/clientContext.js\":\"7a702052c0c78a20\",\"/knowledge-medium/pr-preview/pr-1850/src/data/dbFileSiblings.js\":\"a9a0d1990ae723af\",\"/knowledge-medium/pr-preview/pr-1850/src/data/definitionSeeds.js\":\"6daf82bd4fac10fa\",\"/knowledge-medium/pr-preview/pr-1850/src/data/derivedIds.js\":\"d911a11a8e9d4817\",\"/knowledge-medium/pr-preview/pr-1850/src/data/drawnSubtree.js\":\"b2eb9c391a633c96\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facetBridge.js\":\"a8c6cd69872280c4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facets.js\":\"01a784b39b3c65b2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/globalState.js\":\"87da76df0b8996a7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/aliasClaimRederiveProcessor.js\":\"9b7843a43f3b6be9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/ancestorBatch.js\":\"54303accef6c8c7e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/blockTypeTypeifyProcessor.js\":\"ac5c889bfe51062e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/clientSchema.js\":\"dd41ad8962312534\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/commitPipeline.js\":\"e53f1538fd10e74c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/devAssertions.js\":\"a3c44f3c8f077f9c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/firstSync.js\":\"7c973e1018ca7d19\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/freshInitialLoad.js\":\"2d1d82fb52b7cc1a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/graphBackfillClaim.js\":\"2ae5f39fc70bb807\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/handleStore.js\":\"9f17502ec706bbfe\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/idleMarkerJobs.js\":\"2f26a702659236a1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initialDownload.js\":\"e7304cdb86ef947d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initializeClientDatabase.js\":\"b0f488da94d93820\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/jsonCanonical.js\":\"855bc0503a33dc44\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelInvalidation.js\":\"0ddfa71bb31c9a65\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelProcessors.js\":\"54b4e938541a4747\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelQueries.js\":\"25ce068300208208\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/mergeTypeMembershipProcessor.js\":\"39dc2f213ecb6f52\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/normalizeReferencesProcessor.js\":\"8afdff2b586943dd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/poolInstrumentation.js\":\"d596825d61bb78d4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/processorRunner.js\":\"d530b3c1eb060702\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyCellBackfill.js\":\"fd6e1ffd13227d31\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildMint.js\":\"bc4a07809bb0ea39\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildrenProcessor.js\":\"fbcd473200a69475\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionChangeProcessor.js\":\"cf8bb21e05ea0b73\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionSynthesis.js\":\"ad047e5ee739d472\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyKeyScan.js\":\"bb923716df482a2a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertySchemaResolution.js\":\"7d20559e6a06f0e5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyValueEdits.js\":\"1e0b9c78f30491d7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/raiseProtocol.js\":\"858769adca992343\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/readBatch.js\":\"d74eb74ebbcd6e50\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/refProjection.js\":\"eadd748417851eb1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetLookups.js\":\"7b7957103ea680e5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetProcessor.js\":\"f2a684f6c3fa1bb9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/replayMerge.js\":\"bd5da32a7ef74052\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/sqlBinds.js\":\"595b8f44a89a6148\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5375ffa8d5c0742d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/arrivalProcessors.js\":\"aae1401801a8b822\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/invalidate.js\":\"e94a83526a5075ae\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/materialize.js\":\"a18253fd2b1d5cdd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/observer.js\":\"1fb3bef1fe0e2d32\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/reconcile.js\":\"5c622f8dd5852d9d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/timingMetrics.js\":\"3adc88047d4c2bc8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/treeQueries.js\":\"c8b9e2f8a51454e1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txEngine.js\":\"cadca3d4d016b2a3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txSnapshots.js\":\"034dffad07d1bbe8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/typedBlockQuery.js\":\"0e52656ffb12dc37\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/undoManager.js\":\"3a796234f1eb7b20\",\"/knowledge-medium/pr-preview/pr-1850/src/data/invalidation.js\":\"ea2eda343e565840\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelDataExtension.js\":\"ee9f2971030deca4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelPage.js\":\"5ea4cc4187dd2269\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelValuePresetCores.js\":\"31a15a02eebb7f12\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbCorruptionSignal.js\":\"3c94bdc894500283\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbStorage.js\":\"a52e691706097ab2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbVfs.js\":\"5bf1cba8d81cf61a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localSchema.js\":\"5e263b3041dbb8ca\",\"/knowledge-medium/pr-preview/pr-1850/src/data/maintenance.js\":\"650501095c1aa925\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mergeProperties.js\":\"ff572e4fe92f4199\",\"/knowledge-medium/pr-preview/pr-1850/src/data/metricsConsoleHook.js\":\"181dbc546e7d1f47\",\"/knowledge-medium/pr-preview/pr-1850/src/data/migrationsPage.js\":\"857c3daaed3c3691\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mutators.js\":\"24cea0f7e1340b3c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKey.js\":\"b57a0765f78e4e0f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKeyPlacement.js\":\"ba214f2d3a03846c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/outlineSurface.js\":\"84dacb941532818b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingEditorContent.js\":\"fb3d45d64b367782\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingUploadsSql.js\":\"3c1f8027bc62d95e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pluginStateExtensions.js\":\"0db96033ba7bb6e1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/powerSyncLogger.js\":\"5a82dcc67070b825\",\"/knowledge-medium/pr-preview/pr-1850/src/data/projectorRuntime.js\":\"0a42da2650328a67\",\"/knowledge-medium/pr-preview/pr-1850/src/data/properties.js\":\"3d4ad674fe6661b7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertiesPage.js\":\"0fd1997df2668548\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyChildren.js\":\"004e8261fc877634\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionFanout.js\":\"26352c3517e0b828\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionMetadata.js\":\"45af6a5eb18962e0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionRegistry.js\":\"727fd17032d8a79c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDisplayMode.js\":\"4b721f7987755cb7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyRowCreation.js\":\"9333e92b66f41cd8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySchemaCreation.js\":\"0767227b9b844925\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySeeds.js\":\"1f503755760267a1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/recentsPage.js\":\"ebb153a0f9b37456\",\"/knowledge-medium/pr-preview/pr-1850/src/data/referenceBlock.js\":\"f8574c3e17db4d75\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rejectedUploads.js\":\"212dcdde57a5cbf3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/releasePowerSyncConnection.js\":\"3ce747dcb2798663\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repo.js\":\"8ec7a8b9e08b0817\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repoProvider.js\":\"0f4a08ddf24aeeaf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rowProperty.js\":\"d7f4fa4b2ba86f39\",\"/knowledge-medium/pr-preview/pr-1850/src/data/searchFilter.js\":\"961af3b0752185d9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/seedIdentityLedger.js\":\"edfef39c28ca2532\",\"/knowledge-medium/pr-preview/pr-1850/src/data/stateBlocks.js\":\"b7b8ac113ea6ffae\",\"/knowledge-medium/pr-preview/pr-1850/src/data/structuralEditPolicy.js\":\"99ddfaa35f8a0a00\",\"/knowledge-medium/pr-preview/pr-1850/src/data/subtreeDelete.js\":\"500485b546857965\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncStreamLock.js\":\"4a7dec40480bfa7d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableSqlRecognizer.js\":\"187fdf02bb636f11\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableWriteGuard.js\":\"2bc8144ddf73214b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/targets.js\":\"ca6582c8a631c97b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeColors.js\":\"7226685d25ee2e89\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionMetadata.js\":\"2964a5310232ad07\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionRegistry.js\":\"5dbd2103ffe376cb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeExtraction.js\":\"31297deda41b0a0d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeInitialValues.js\":\"0f1a0316525e8b7c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typePropertyGroups.js\":\"96d76dbcccd1b4d3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeSeeds.js\":\"0d31f71e7e80e36c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeTagger.js\":\"634b2120fa7cd3ee\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typedRecords.js\":\"12dc522d090e2e43\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typesPage.js\":\"744ed9f970b4575d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userPrefs.js\":\"38f492c385d0f57e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userSchemasService.js\":\"43d9f81fe67e0ac2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userTypesService.js\":\"5d1b6291212f6c92\",\"/knowledge-medium/pr-preview/pr-1850/src/data/valuePresetRegistry.js\":\"8410aa4970ded79b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/visibleChildren.js\":\"1a41fee01a2c2f3e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceConversion.js\":\"f060543e53fc42e2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceFirstSync.js\":\"e5f21f79e1e243a8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceIdNamespace.js\":\"0fb372a20e5b9f6f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceSchema.js\":\"8335f97d60e2855f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaces.js\":\"1379c8218294d3bb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadLog.js\":\"4d9dcf24bfc3f8f8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/BlockPasteShellDecorator.js\":\"424ef980413b320b\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/atTrigger.js\":\"7d25af57b3db4820\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/autocomplete.js\":\"e9de538db1d1e344\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/codeMirrorExtensions.js\":\"d5bf9f6b29e6eaa9\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/contentFlush.js\":\"ed87df8494e7c820\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/defaultInteractions.js\":\"4dacc6f19b2a82e1\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/editSettleSignal.js\":\"e691c82a849c3e40\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/insertImage.js\":\"17c5a37fd8a8c40f\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceCompletionRange.js\":\"09a2f62d583a3412\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceTargetTypes.js\":\"b127f32c49eef62a\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/syntaxContext.js\":\"b50840ad095c5755\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/triggerMatch.js\":\"78e64ffa1004ba38\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/AppRuntimeProvider.js\":\"3a9dc4069b5b89a2\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/BlockFocusShellDecorator.js\":\"6c1a198a00984941\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/ExtensionRenderBoundary.js\":\"5969433012b83f7b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/PanelContentRecovery.js\":\"504770ea0630c012\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/apiCatalog.js\":\"9e5967f08d91a200\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/approveExtensionHere.js\":\"8f137979fed75a97\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/armedCutAppMount.js\":\"0caf15ea3b8cbd48\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/batchableKeyedStore.js\":\"e62dd74bf0222203\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockInteraction.js\":\"abd811c7e89d92e3\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockSelectionAction.js\":\"1d0b81d1085344f2\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compileExtensionModule.js\":\"af84f19393717fab\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compiledModuleCache.js\":\"470fa47c2cf31d67\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/continuousGestures.js\":\"7a966732e9938d6b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/core.js\":\"7d7175572c621bbc\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/defaultRenderers.js\":\"059cc0778913b605\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/definitionFanoutAppMount.js\":\"8b22c4343209686c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dialogAppMount.js\":\"fef425ac90827940\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensionSeeds.js\":\"6bb88bc337426d73\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensions.js\":\"aaa591061347777a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/exampleExtensions.js\":\"648c2f4268fafd4d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionApprovalStatus.js\":\"940c6b9bb7bba557\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrorToast.js\":\"a7d65ceb9d09dea9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrors.js\":\"7a41743f17d20bfb\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLookup.js\":\"1ada6a6217b9e604\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionToggles.js\":\"e904013f9f507924\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionUtilitiesCss.js\":\"3dd1997a65069b98\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/kernelPageDeletionGuard.js\":\"3ac5e399b97c2a40\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/liveRuntime.js\":\"6a608b02f5d5610d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/openExtensionsSettings.js\":\"3fa1027d7e3cfc71\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/overridesCache.js\":\"6855c482559d486f\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/pluginIds.js\":\"4e15b9cb4cc93af9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/processorRejectionToast.js\":\"36526e6b7fd007eb\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeActions.js\":\"e1fbf9e181e89127\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeContext.js\":\"8bde14e61a8f039c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticAppExtensions.js\":\"94840a22e0aaddea\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticDataExtensions.js\":\"f901b6f0f8f15ee2\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/toastAppMount.js\":\"693d80fdba0f8d12\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useOverrides.js\":\"ef5d70bebc3532e4\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useShortcutSurfaceActivations.js\":\"bcf03f590a71007a\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/discoverToggleTree.js\":\"ba9fdd401d91110d\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/facet.js\":\"1603faeedcb907fc\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/resolveAppRuntime.js\":\"f6fdf1248964552e\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/runtimeEvents.js\":\"0567fbbecf9c217b\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/togglable.js\":\"15a9b6cbad8e718b\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/variantFacet.js\":\"d6bf283001d250e8\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/verbFacet.js\":\"3b317ab78484e322\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/block.js\":\"a7e39fd9cdeaa786\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/focusedChild.js\":\"850fe71a43364c01\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/propertySchemas.js\":\"e56d2e5f4f18530a\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/typeRegistry.js\":\"4f19c35f20a43ac6\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAncestorCrumbs.js\":\"9368855eb87759de\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAutocompleteListbox.js\":\"450b02dacac54570\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedSearch.js\":\"0e4c083c488fdf9d\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedValue.js\":\"601a89547e74de8f\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsFocalRender.js\":\"7aed0f94c3e6c4f3\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsReadOnly.js\":\"08a708ab53c95eb4\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMaterializeBacklog.js\":\"f239d6a1aec9e7e2\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMinuteClock.js\":\"83e6b3999d49608f\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePanelLayoutProjection.js\":\"a036873e71310ea1\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePendingInvitations.js\":\"1f2c9798affb75b2\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRendererRegistry.js\":\"7c02680843b54b1c\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRetainedFieldRows.js\":\"6b4182abff0f05cb\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useWorkspaces.js\":\"7aae10389d40500a\",\"/knowledge-medium/pr-preview/pr-1850/src/lib/utils.js\":\"bcb22191d179428a\",\"/knowledge-medium/pr-preview/pr-1850/src/main.js\":\"d50fdbb5d29f81dc\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/MarkdownImage.js\":\"98bb309e3340eb79\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/blockSeparators.js\":\"346d73a504170d06\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/context.js\":\"addef2e0e621afd4\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/defaultMarkdownExtension.js\":\"7bccf8913070807f\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/extensions.js\":\"aec3c524c28343e0\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/renderMarkdownHtml.js\":\"a06e6f0091da67a4\",\"/knowledge-medium/pr-preview/pr-1850/src/minimal-editor.js\":\"eb7d5c6d85bd2394\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/armedCut.js\":\"ce1377272926dd4f\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/captureMediaVerb.js\":\"5037b030d74d4ed4\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/clipboard.js\":\"1cbe460d1d13436b\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/decision.js\":\"1f542db59405a754\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/operations.js\":\"3252e4bce3efdf56\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/AccountHeaderItem.js\":\"08e0f0b8246d272c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/index.js\":\"2e6b2bf57faa7adb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e9f419910df233e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askAgent.js\":\"0140b7944c8ec1f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askedStore.js\":\"42555e63850cf1dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8f42c0a137308897\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/chipState.js\":\"d41a0ada8efc5342\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e5e9d5d1b270d662\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/index.js\":\"943729310481681c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"25fc3026740a347d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/schema.js\":\"9cd128c2f0551fae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6dca4eb56e06634c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8f2a79cea9731837\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/addMedia.js\":\"0bd8d07f95497a48\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d234ef7dd67e8776\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/block.js\":\"407260c68b249c8e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/context.js\":\"2b28857cfe471e9f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7b3ddd55b1c1df61\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/index.js\":\"4072bef17641e907\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/outline.js\":\"1b1d6698e7d41ae2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/properties.js\":\"5c854e23a76c2da5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/refs.js\":\"7f41026f63180cd9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"097dff4f5d067d4e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/search.js\":\"5778695d238fab51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/shared.js\":\"d75b69306f3341ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"54eceb6bac12ef43\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/text.js\":\"eaceb3de68c5e994\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentWrites.js\":\"18bf6d4f2b574ca3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/authoringCatalog.js\":\"86815fb8d4ce8652\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/blockRefTargets.js\":\"faab993d9486346c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridge.js\":\"f42b721545023d3a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridgeLoop.js\":\"b34474d0fae0a871\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/changeHistory.js\":\"5199eb69288d1a9a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commands.js\":\"032900c37ed7c87a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commentsCommands.js\":\"6046a67105363034\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataExtension.js\":\"4b785eaab61c6a7a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataModelGuide.js\":\"5ee89545d7bea633\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/describeRuntime.js\":\"44295e5e1f1996fe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/extensionLint.js\":\"30420839b3b5335d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/grainAudit.js\":\"18c0a3563d42a356\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/healthCommand.js\":\"f22934900d717794\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/index.js\":\"d3edaa96ab8dde33\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/presetIdentity.js\":\"ad4734cd3d6c9b83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4e426ddbe744dc85\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/readMedia.js\":\"125c4c305fcc65d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/schema.js\":\"e2ba2c32130dcfc0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/serialization.js\":\"e85b6586118ef5b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/targets.js\":\"a4e5c33179ea65c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/tokens.js\":\"21dc4fafa2e893da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/watchEvents.js\":\"816601a9185232f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/workspaceGuard.js\":\"de373275248d3c70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/writeCommands.js\":\"a32eeeb7352bfaf5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/AliasCollisionToast.js\":\"56d9bb4af5bf5cfa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/DuplicateNameBanner.js\":\"7f60401326a0ebb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/collisionMerge.js\":\"1106cb2f5ac286e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/dataExtension.js\":\"67a715a8f49d51c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/index.js\":\"8f5c72ec7695cf20\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/mergeCollisionAction.js\":\"e00548c4b8ee581c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/pageStyling.js\":\"7b17617b9c15f3b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/rejectionToast.js\":\"e8979286f5916a08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/syncProcessor.js\":\"a52c782d0789bd3e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/actions.js\":\"ef5c6b60bfd3d3ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/addComment.js\":\"b2996496488dda7c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchor.js\":\"c9a4578507952f97\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchorState.js\":\"19b28b62a903b1da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/commentLinks.js\":\"fc00dd97f98976aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/confirmThreadDeletion.js\":\"2745cb536e450196\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/container.js\":\"f832d17e70cc000f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/dataExtension.js\":\"6bc5908ee35ed0cc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/deleteComment.js\":\"2ddaae6fd47e360d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/highlights.js\":\"84c4571dcf83439e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/index.js\":\"9e4e80a42bdeceae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/linkedCommentsPill.js\":\"5392a0e252c661d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/margin.js\":\"4a59ad211b340afa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/marginSchema.js\":\"e10e0312d0c77249\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/newComment.js\":\"55fcdcebd1658a29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ownThreadPicker.js\":\"968e616d3e9d17d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/placement.js\":\"7d2e7506a6b75a43\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/queries.js\":\"6e1d721c28ff5b07\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotePosition.js\":\"e99bebcae48c8e04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedIn.js\":\"f5246b1dd65507a9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedRange.js\":\"e6eedf2b3cb1cf4c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/rangeRefs.js\":\"985e4e89fa637568\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readHighlights.js\":\"b03dd5e01462987c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelection.js\":\"329cbff3997946a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelectionUi.js\":\"382caa8fa3fe2d7d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/reanchor.js\":\"2677b7fb31b6f597\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/schema.js\":\"72cbc72d4975e0ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scope.js\":\"c2963b80d7b4f2e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scopeThreads.js\":\"9160f1da95b75c6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/splitRetarget.js\":\"4702d5129d5046a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestionCard.js\":\"508a1aee267242ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestions.js\":\"5ac93d2b374bf973\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaries.js\":\"dd8f2237ce8db679\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaryBatch.js\":\"4d27a25b510837af\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/surface.js\":\"ab80aa5bce55b391\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threadNavigation.js\":\"f49ca2b5d4aad97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threads.js\":\"cc968ff9b6c8b8f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ui.js\":\"8ac21bea7aac7433\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/uiStore.js\":\"025d0fc9377adce1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/appIntents.js\":\"bd439e18e190cf81\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/index.js\":\"d758e96756c79637\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/index.js\":\"61e560023d03cbe2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/status.js\":\"cd52f9fceb8a3e0c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"cc4ed7da48dcc455\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaBlockRenderer.js\":\"f81732cb7aef369a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7cab94825ee5adff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaUploadReconciler.js\":\"8db0cecc0f99a190\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetDownLane.js\":\"3ea7f24083eeb6a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetResolver.js\":\"69331e1574c18ed8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetUpload.js\":\"ac2de346d7054761\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/attachmentCleanerIO.js\":\"beef28c69aff4c1f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c10e2ac7ed91fda8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/blobStore.js\":\"80870219fdc0b7d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/byteStore.js\":\"debce0369534ccab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanerIO.js\":\"55b13b9643bd9adc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanupAttachments.js\":\"8b4b7ad13e892fca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/dataExtension.js\":\"d953d1daa8923c38\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/downLane.js\":\"980bbdcca56131eb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/index.js\":\"a527936dad0ea13e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/insertImageContribution.js\":\"35b9b025aaac58bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneArming.js\":\"b6583edd2ba4a7fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneLock.js\":\"23d3aff0ccafc809\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaBlock.js\":\"a69e34c209fc163b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaCapture.js\":\"7e0016f43d23eea8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewers.js\":\"9b970194c84208f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewersFacet.js\":\"d4aca5bbcbb35da5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/pasteCapture.js\":\"067a059d0ca2f707\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/resolver.js\":\"e2e58b8ffa056444\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/retryUploadsAction.js\":\"6251617824189f8a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/storagePaths.js\":\"d85fbbb272a1b352\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadDrain.js\":\"5c78c37ede3d6e41\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadLaneStatus.js\":\"5dae1a3a87527a34\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadReconcile.js\":\"bae878a0fef46b97\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadRecovery.js\":\"83ac5f93a2561ef5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadStore.js\":\"34637ff12b860e82\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/useAssetObjectUrl.js\":\"232be317d1515612\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c6116adfa8f263ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksViewSection.js\":\"bcf10c2239bee6c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/facet.js\":\"cf7e92e61a9ae91d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/index.js\":\"0074eec907ccdf85\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/prop.js\":\"dc6f7c7dc3b102cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinkFilters.js\":\"a122908807146a04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"679d8e8682f3fb62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BlockEntry.js\":\"476f668f8beb251b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/LinkedReferences.js\":\"07c14e3dde536965\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5016a71fb532b5b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dailyNoteDefaults.js\":\"e156cba4ad6434e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dataExtension.js\":\"9aac32bee286a224\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/edgeExclusions.js\":\"dff75cdaa0e77e71\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/filterProperty.js\":\"3b607feab3399069\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/index.js\":\"29f382bbdfd9c471\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4cee94afed0c055b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/applies.js\":\"94c84df6936d805c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/countQuery.js\":\"632f5b7130822de9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/expansionStore.js\":\"58a70759b700f00b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/index.js\":\"a90353d24bc4b42b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bcfa658222a87a92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/presentationInvalidation.js\":\"8e17d009c6f5afb4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyEditorOverride.js\":\"af7bcf77ef615be5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyFilter.js\":\"54210e8c102b9a64\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/query.js\":\"809092b7bf6b8e61\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/resolveFilter.js\":\"0afc5747e6c62b62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sourceBatch.js\":\"fe04c6b11eb09039\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sources.js\":\"e3bb0474a4cb8dbe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useBacklinks.js\":\"0229cb19e49e15fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d2e6a1ca0c1de251\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayCelebration.js\":\"7eba4ec28eab7fb6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayOverlay.js\":\"c7ce001be8426c21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/gate.js\":\"dcf87276ddd10140\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/index.js\":\"0d0bbd39433ed4e8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/wolfTheme.js\":\"16cd37234de8e517\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/BlockDragLayer.js\":\"3faf5500368dd70f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dragController.js\":\"eecdbc83517a6c89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dropTarget.js\":\"6bb18e47d91aac11\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/index.js\":\"7d1e972f2cf0e965\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/projection.js\":\"49b4545fc80e5d4b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/BlockMetaCard.js\":\"b8d9ed9034b7974d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/index.js\":\"506cb75cb0206a24\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/AddTagDialog.js\":\"5e1461b54c8f174f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ae52f7605f5845be\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/TagNameIssueHint.js\":\"542b3cc77ea679cc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/addTagAction.js\":\"b05050510efe3bdb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/appendTag.js\":\"967663e65302a060\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/config.js\":\"304ea73eb3d5e89e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/dataExtension.js\":\"09f2652f06cfaba7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/index.js\":\"f8f6639e48b53e71\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/propertyEditorOverride.js\":\"36932de1830a6d78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ca5163143e2921c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"09827c56f690dc1c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/Breadcrumbs.js\":\"dced16db71dc6e37\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b8f54c212b4b9f93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"6a9fc8363b50d9b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/index.js\":\"927e96adce0b3dd9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"3ccdf28248099a9a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/CharacterCountItem.js\":\"6193b3786d64c2cd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7e41429baf1e6500\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/actions.js\":\"99494bac103c6383\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/blockType.js\":\"934424af43319021\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/charCount.js\":\"764b4fb3bf8ae25c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/dataExtension.js\":\"036d124602817a4c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/index.js\":\"cc89b045aeeb09f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/profiles.js\":\"0e07d1796ac4a839\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/properties.js\":\"7cba01b57621ea38\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/textCounts.js\":\"962d438bb404b37c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/colemak-keybindings/index.js\":\"a573a3be342018d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/CommandPalette.js\":\"a7861fdf742360c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/HeaderItem.js\":\"077d6b3d03156126\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/context.js\":\"4846bf89ab129575\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/index.js\":\"e3f212bf7d1c270c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/selection.js\":\"d7b2bdf323ac8922\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/toggleStore.js\":\"c02b288d58e4eb29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/useCommandPaletteActions.js\":\"984012a4f2a8ed93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/ContributorBadges.js\":\"56b9f191ca3f7ce7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/author.js\":\"7ae2e4e1e9f34b90\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/codeMirrorExtensions.js\":\"28b48cfb9c479c33\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/dataExtension.js\":\"f90a69483b88b181\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/index.js\":\"d8e214119a8105d1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/mentionAutocomplete.js\":\"2a9f247a33602db6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/processor.js\":\"221e4904737c9c22\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/profiles.js\":\"2eb7635a21f5155f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/queries.js\":\"d3230c3dda006b2a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/schema.js\":\"f128d6175afd8b9b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"6dd2b172a44bc82e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7589ae8c9e0bda26\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/index.js\":\"e8209d5dc05a6bc2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d9b1bdac040998dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"80299c5791c680ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/CalendarGrid.js\":\"601ad4e8f8df5544\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DailyNotePicker.js\":\"8bfea9b39d2670bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"159e4ea1d06fd158\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateNavDecorator.js\":\"61d01fe3c978eb16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateScrubOverlay.js\":\"40f8615865b75f4a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/HeaderItem.js\":\"7fb5deea4ba850b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/ReschedulePicker.js\":\"d49bd809da86f4f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/SpreadDatesDialog.js\":\"76eeee502c0f80ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/actions.js\":\"67a913a131920f0b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/blockDateAdapter.js\":\"8fdb2d0f70cb04e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/calendar.js\":\"7bf42c205dd86e96\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dailyNotes.js\":\"83e4a577dedd4c17\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dataExtension.js\":\"9c9f850233a4a764\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubActions.js\":\"fa7e76b40f4963b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGesture.js\":\"1d6c67ef3590dbf0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGestureActions.js\":\"31cdf089dda0fb8f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e6799104aaeffcd5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/deletionGuard.js\":\"b465ab3c955a40f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dueQuery.js\":\"1a9eab3ee2e76a17\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/index.js\":\"b29c4b0ef4683228\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/landing.js\":\"fcaab62489b9fbab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/localSchema.js\":\"b86495983e169d95\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/referenceDateAdapter.js\":\"39b28e4b4f042bed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/rescheduleAction.js\":\"68c04b17816d7900\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/schema.js\":\"660f5a05c260a2d6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadBlockDates.js\":\"ab26198820e6bfe7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadDatesAction.js\":\"55d03c6cdef4e6b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/today.js\":\"eac83904e0d194de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3ed212a4ed55a6f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3a757eb89a48d09f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/audit.js\":\"f786f360e1b4f085\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditAction.js\":\"d170d8c2f759d8cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditRanges.js\":\"df75171dd8e534da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/diagnosticsSource.js\":\"8599089a0cc05826\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/divergenceScan.js\":\"ff9d17c537b63b10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/index.js\":\"e69bd3585f1bd3d9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a1638d1a1af04d9d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/referencesMirror.js\":\"16295a2940718c32\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/rowJson.js\":\"6869f497468e8b98\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/schedule.js\":\"80fdd2f4935c384f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/store.js\":\"e0f8c473540f990a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/action.js\":\"d8c57eb81c1b7803\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/index.js\":\"a9929159bd4a178c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/plugin.js\":\"49eb77a67847cdec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a2106db87abb086c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/actions.js\":\"072469ca84390d52\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/changeMarker.js\":\"f9793638a9f01482\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/diagnostics.js\":\"2434f6985cf9ef8f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/fileSystemAccess.js\":\"b19ae95c09790541\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/filenames.js\":\"4b04bee503b39615\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/index.js\":\"0dcbe55e33903bda\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/mirror.js\":\"0a2d3ed8e8741d20\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runLock.js\":\"0932ed0786e3c041\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runtimeHealth.js\":\"3776cfc2d9830f5c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/schedule.js\":\"db97d80f31ee0bfd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/store.js\":\"81e002bde8ef4c67\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/index.js\":\"fe1cac012dfb71cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/themes.js\":\"6b060813cf4354e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/facet.js\":\"3c135ed1e0e5adc2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/useDiagnostics.js\":\"2a5d7dcc5a69d893\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/dismissals.js\":\"44affa6be78df49e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/index.js\":\"0901e9f15d82f450\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/status.js\":\"09262c1c16a2e8d8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/store.js\":\"68cca5c0b919f604\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9ca500639f361d43\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8308c802568a1fd6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/actions.js\":\"a2b12165382c5a4d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/config.js\":\"6d3ce41363c69fbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/dataExtension.js\":\"03613826a9110e33\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/effect.js\":\"bc1bc13def6de2b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/index.js\":\"9f4fd1795ba1656d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/propertyEditorOverride.js\":\"92f62a2ae8b24a3b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/useToggleTree.js\":\"623de266e6739ba0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/ExtractTypeDialog.js\":\"4c4ec2e3f2985923\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e673384368b48ec2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/PropertyShapePicker.js\":\"5f74f4b8d134dabc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/action.js\":\"cbab43e6efd7e3aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/index.js\":\"dd9d3e3008eab7a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/FindReplaceDialog.js\":\"3ce414e74ec50407\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/HeaderItem.js\":\"4ae72565ae64442c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/dataExtension.js\":\"454e3b346118b945\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/index.js\":\"e92f3edb1bfc8793\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/search.js\":\"c2cacffa19ee744c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/toggleStore.js\":\"12b19a9294d02bbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/LocationPropertyEditor.js\":\"4712c82868d95e8c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/MapView.js\":\"c6e5341a62c5eca5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/blockTypes.js\":\"6ecead090ddb8dbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/codeMirrorExtensions.js\":\"932be518182f47d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/createOrFindPlace.js\":\"038557e09d2a9d4d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/currentLocation.js\":\"f051a6b09b4753b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/dataExtension.js\":\"b6bd2bcbc96888c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/geoContentDecorator.js\":\"a514d17a7f439b3a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/googlePlacesClient.js\":\"36b339860511baba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/index.js\":\"04b581d5512f2512\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/locationsPage.js\":\"e276576617066c3c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/mapViewport.js\":\"bdbf2993469537af\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/pickCurrentLocation.js\":\"b7f7e5c3179288a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeAutocomplete.js\":\"824aa2a70d331aca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeNameCollision.js\":\"dda0c583152d9c10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/properties.js\":\"414d01027e63b8a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/propertyEditorOverrides.js\":\"54d064fe035e00cd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/query.js\":\"c5332d2e7d1be29e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/usePlaceSearch.js\":\"60c2d0f900c7f1da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7593593380ebf2f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"850301d6adde41d9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"42b4aedacad6cff5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/config.js\":\"0bbc1585adfd30f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/dataExtension.js\":\"03ab5f302e1e5679\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/facet.js\":\"b74d89e14038d21c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/grouping.js\":\"f3e59881079152f2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/index.js\":\"f59534db701e7ae0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"bec603c90f34924e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/query.js\":\"6251a5fbd8224b64\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/resolveConfig.js\":\"ae6bd33510eddd80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"91a66c3e329f47cc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"754e4d4043bc3d9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlDocumentContent.js\":\"f9adb6033a4c3805\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlFrame.js\":\"9518343ccb1dfa3c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/actions.js\":\"dcb5fe2ce54e4b83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/blockType.js\":\"5fea664a3583678b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/confirmRunScripts.js\":\"8960a7f74acfa6f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/dataExtension.js\":\"499cbe5a9fdbb59a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameAnnotations.js\":\"4df9a4e924a26ea3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameDocument.js\":\"2feb446a6d763d85\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameTheme.js\":\"50c036f22918b5af\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/index.js\":\"336d8bfc8eec7019\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/scriptConsent.js\":\"bcfb8ffafa647511\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/sourceMap.js\":\"4eabd2d5f36882e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/useDocumentScripts.js\":\"b01c95dd0658ac87\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/index.js\":\"2743f364e59a0200\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/record.js\":\"bf43a1b042bc30b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/recordStore.js\":\"6dfe1cc0a1547d0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/responsiveness.js\":\"8a9f18e47dee00ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/schedule.js\":\"fcd64ff1026367f2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/sessionContext.js\":\"7b501b115554bf66\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"7e958f2e43c9d324\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3fee58b4a16b6868\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/actions.js\":\"788edf2625a07bcb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/config.js\":\"6f1887a35a15e302\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/dataExtension.js\":\"93314bfa67462be1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/effect.js\":\"73c9bb3b0bc6c544\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/index.js\":\"a30d24e05ae33fca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/keyCapture.js\":\"21092c228172da9b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/overrideStore.js\":\"c3389163659411e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"580bda839dc46f78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/HeaderItem.js\":\"ea698ac6753b977a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/LeftSidebar.js\":\"9b8e11b0933cb3e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/actions.js\":\"628a0c48a35d20d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/facet.js\":\"c2f0856abc142e44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/index.js\":\"126e90b005cec82b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/shortcuts.js\":\"a29a9fd88f36e27f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/toggleStore.js\":\"88cd629197f95aff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/MergePicker.js\":\"38cda7119c827935\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/index.js\":\"f1215699a853dd44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/mergeAction.js\":\"ec0509507e72356a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/strategy.js\":\"44d69d2ef02d7285\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/Button.js\":\"5c0b727ffeb065ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ebaf25b70dab09ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/defaultItems.js\":\"cd51d8b7ec111a04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/facet.js\":\"3106c13e6aab4933\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/index.js\":\"fbd461dba60dc9da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d88224655ff56c68\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/actions.js\":\"43613460fc9d25f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c2ca28676a0563aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/facet.js\":\"0006cdfff9f9c3e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/index.js\":\"06c59a1ecc2f3cd8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/MoveDestinationPicker.js\":\"84c08e7b0d79484f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9438d5d48660f3ea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/contextMenuItem.js\":\"174a7828326fcd37\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/index.js\":\"842cacb0a511951e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveAction.js\":\"85a1428b73965b21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveBlocks.js\":\"a29c0d7b7f871036\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/selectionAfterMove.js\":\"d497dd2c5ef5ebcc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/TutorialBanner.js\":\"cae7461b0f71c503\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/action.js\":\"235e6a23c094c744\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/bannerDismissal.js\":\"910828a54a9139c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/documents/cheatSheet.js\":\"3252265b62690cea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/index.js\":\"611c5ae1ca47c009\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/keys.js\":\"d068deba8b0fd2bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/landing.js\":\"09353b911aebfb44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/outline.js\":\"2e0c2be4f79a322d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/seed.js\":\"a26b6467e318dafd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/PerfTrendDialog.js\":\"bda6b12bc44c4aac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/analyze.js\":\"86a019f241f56e30\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/diagnosticsSource.js\":\"e3d6a96af75f1742\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/index.js\":\"1b0aa1d000a57f6c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/load.js\":\"fd037fd540b2c6b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/monitorRun.js\":\"8b2d816f390d294f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/schedule.js\":\"39540a681a3a9a70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/series.js\":\"83d3e1aeba5e1808\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/store.js\":\"2e244fe071b0fa29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/trendAction.js\":\"779ea383c568f94e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/verdict.js\":\"ebfbfbda70a57606\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/clickToEditAction.js\":\"b4610ef7101aa7f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/index.js\":\"7164f0481d8b7c7d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/interactions.js\":\"3f85fc2fd02624b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ec4af5c232e5dd6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGate.js\":\"6269af9a688ded7a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGateDialog.js\":\"eac6908797689ac4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/action.js\":\"ce2ad57e2ae7b2f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/index.js\":\"2af69429e4ac9589\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/localRunMessage.js\":\"74dfe6dc0f1efac2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/plugin.js\":\"49778ddaaba4c38e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/progressReport.js\":\"b78e6b3acdbcd451\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/sweepProgress.js\":\"b2449384f5763504\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/FieldRowRenderer.js\":\"acf94183307e71a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/ValueRowRenderer.js\":\"c477d5d5a45482a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/actions.js\":\"5cc4bd9b51419fb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/autocomplete.js\":\"00f7e5539f74ca31\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/fieldRow.js\":\"a5452dfb27b66886\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/index.js\":\"40cc090fd039232f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/referenceWarning.js\":\"9e8a826f10cd436a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueAutocomplete.js\":\"62d5ce33722011e3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueSchema.js\":\"a1fce544a94d8bc8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/HeaderItem.js\":\"4377a7ed0e788b22\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/QuickFind.js\":\"3904de31eec896bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/index.js\":\"cb51145c66c1db88\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/recents.js\":\"84da88f24a3bfe48\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/resultItems.js\":\"e762ed19ee9a8b1b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/selection.js\":\"9a3b5274bff89271\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/toggleStore.js\":\"6425e7bad45feb75\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/HeaderItem.js\":\"79a5cc5091bcb16a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/RecentsPageBlockRenderer.js\":\"eaf522de6b567246\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/grouping.js\":\"18bcb9f02f40533c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/index.js\":\"8aeb37f05407aef6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/target.js\":\"ac45ba624293c960\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/codeMirrorExtensions.js\":\"20c75f906fcde24d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/contentPrefill.js\":\"43e883b6007c34bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/dataExtension.js\":\"30fd73bd72aa3532\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/index.js\":\"27f915936d5a779a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"00792e581045d230\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/invalidation.js\":\"8b10a16c19a9f277\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/localSchema.js\":\"d8ba5584bebe3cf4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/index.js\":\"cf75d013b27fa75a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8dfd6e6c5a10bf9f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/index.js\":\"85e8931fe72e0aa2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/referenceNode.js\":\"8912cd6eecbf0765\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a8e5e71285afc5d9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"4b483ea4eb755dc6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/index.js\":\"71356592b546248b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5a81320a1bce2f24\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6268b129512ca12d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/mergeRetargetProcessor.js\":\"6ddf3ed28ee65816\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/parseFence.js\":\"13b422d60e6187f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceParser.js\":\"44555348393b9678\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceProjection.js\":\"b82e73be98f820e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referencesProcessor.js\":\"0e9e540edbed314e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/renameProcessor.js\":\"654cdf186deec276\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/spanReplacement.js\":\"9f3b36486f6e1225\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/htmlToOutline.js\":\"5f3d97a10102f178\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/index.js\":\"915b010d2f81ffae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/normalizeClipboardDom.js\":\"63c685b3c50fe3cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/pasteDecision.js\":\"d45bab105cedcd08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/action.js\":\"61058f33abeedca7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/blockIds.js\":\"86e7451c5c33b32f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/content.js\":\"975499b9e0485862\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/effect.js\":\"8c3c0da540898422\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/ids.js\":\"82382203dd0d6bc5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/import.js\":\"e4b4818004085fc1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/index.js\":\"2948725d8ddc7972\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plan.js\":\"905bfa217bffbeeb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plugin.js\":\"f2066bf930e03d7c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/promotion.js\":\"0f6af3e025456e19\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/properties.js\":\"9d48180c52405f1f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/references.js\":\"44c48203e14daaad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/report.js\":\"3698ac013ce2e869\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/roamMemo.js\":\"320f815e174b9c01\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/runtime.js\":\"ad37503837039a59\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/schemaReconciliation.js\":\"ddbca68251e2ecfc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/srsMarkers.js\":\"9a256f08f14a5626\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/todo.js\":\"3255f298177bae75\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/typeCandidates.js\":\"93465766f8c8051e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/types.js\":\"e571bd360c5e4b7a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/index.js\":\"1663a02d33ceedb9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/store.js\":\"cc2e24d38610da24\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/HeaderItem.js\":\"e1f17691089b134d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6abe152762bbf139\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/index.js\":\"2606e26929171194\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/model.js\":\"6bcea4b9b965f26a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/toggleStore.js\":\"12f88c2c6bd57325\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/useKeyInspector.js\":\"1b1b78f0ce9844ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"196c091d3e6b2e4b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/ShellDecorator.js\":\"f440c587c5ba65ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/actions.js\":\"782a1bbcfa768eb7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bfc85f72127791ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/index.js\":\"3430937b95879955\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/shell.js\":\"f6a78691c27433fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/surface.js\":\"b86847767f67c63e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/walker.js\":\"baa99d9403fcc704\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/RescheduleToast.js\":\"51c4c129feda5175\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/dataExtension.js\":\"7db1b7496659565a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/index.js\":\"5bffb10f8d7e7e12\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/indicator.js\":\"d7bd9853f2eaff78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/moveSrsState.js\":\"2a7332ff0ec92dc7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2492bfcd5cdd899c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/scheduler.js\":\"7d22c767fc8387e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/schema.js\":\"1471067fb0ad2174\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"648bb2a6731ab959\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsClipboard.js\":\"e79e5b37f76d4066\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1a64a6d50c2274f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b3100027fb8fb142\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DeckPicker.js\":\"307ab11bc9d28086\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewControls.js\":\"548305fa356aa930\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f0f7f8dcba94d164\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewSession.js\":\"01d0f5537a98ffd9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/actions.js\":\"445806e24826656e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/archive.js\":\"5cb4cd2331688f9d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dataExtension.js\":\"cd8f4871c87ebef0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/deck.js\":\"91d23be29af7a632\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dueQuery.js\":\"be748c40eabc42af\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/gradeDecision.js\":\"a912e4272f4fc9d9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/index.js\":\"cf2f0a51056084ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/keyHints.js\":\"caf5d6d0807bfbff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewCardLayout.js\":\"6bbc991d42e2e40b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewProgress.js\":\"5b87a5390661fdcc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/schema.js\":\"c8a5f808976e0d49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/useDueCards.js\":\"1af25a9817107acd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/index.js\":\"7e527483e5001893\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/record.js\":\"1de9cb563df25a46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/index.js\":\"a1fd4f7c40134de1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/persistenceStatus.js\":\"c73018b63dae04f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/requestAction.js\":\"de7e07e4b33e52b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/TypeChipsDecorator.js\":\"92b740380c6b8c70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/codeMirrorExtensions.js\":\"fca179f7fe41c149\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/index.js\":\"711611fc19a8649d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/typeAutocomplete.js\":\"5966d81a0c081fee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"7b87b381c77cf57e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/actions.js\":\"0ac21ac0eb11c8a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/anchor.js\":\"80d6c93e575ea437\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/events.js\":\"e1aa04ecb813416e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/gestureActions.js\":\"4b248c1d3348714d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/index.js\":\"42e3d764e0985e6b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f865fb361d8ad491\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/collect.js\":\"681d2f909c971b39\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/index.js\":\"a7e76c7e1ec49e16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/record.js\":\"e383b4eb838c0620\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/RejectionDialog.js\":\"6a793db189284beb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/SystemStatusHeaderItem.js\":\"644223f7b41f75b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/index.js\":\"085df3473214048d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/model.js\":\"f73fec0375aa1032\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/queueCounts.js\":\"cffbb1fa3e561db3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rejectedHelpers.js\":\"107a241c117c6550\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rematerializeAction.js\":\"18529d763efb345e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/useHysteresis.js\":\"c8689a013ee6f326\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/ColumnHeaders.js\":\"52a378a8cf821ef0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/QueryUi.js\":\"f8da8be8194fed8a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/TableLayout.js\":\"d8fd4ea7ab507869\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/actions.js\":\"5309ba9cdb19d48f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/cellEdits.js\":\"fdbe9af5729cf00b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/columns.js\":\"8daeb065e16d25a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/controller.js\":\"e33b0ee888c9f77a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/convert.js\":\"55e9eaf8bef9482f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/dataExtension.js\":\"a539ae8ebbfd25ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/index.js\":\"470c36f809033a15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/keys.js\":\"2570ef6316e5f5aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/model.js\":\"ef63f32b0c0b71ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/backfill.js\":\"8ff6c58efafe692e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/format.js\":\"37e356e1a96d46f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/parse.js\":\"0ad582d6e1e15c92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/queryValue.js\":\"6b7b3dba4855daaa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/source.js\":\"ebe8870fd256ac41\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/registry.js\":\"3a8b43ba43886d06\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowGutter.js\":\"8e72ab302e329a2d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowVerbs.js\":\"ba859be182976e14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/schema.js\":\"88e7bca37c1f8c80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/sort.js\":\"4b6e0cbfdbf7a62a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/effect.js\":\"936a93947bed721b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/index.js\":\"3da3ed6b7ecfee3f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/theme.js\":\"75fc04820bb077e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/actions.js\":\"571155e8c90d56cc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/dataExtension.js\":\"0a8ca7ccc435f4ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/index.js\":\"3efdd22f61c7acf1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/schema.js\":\"90b33479b9ade5d9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/TouchSelectionLayer.js\":\"32171841cf3fbdd2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/actions.js\":\"444599630a28d386\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/defaultItems.js\":\"1cf21d088e133962\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/facet.js\":\"34eeced0e4a0a6f2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/holdRecognizer.js\":\"6734d6368d30d7c3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/index.js\":\"a8f1400bec194538\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/UpdateIndicator.js\":\"1fce9ada6b12d5f5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/index.js\":\"5fe1e5036e005a81\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/loadTimes.js\":\"4b61ade1b610f1cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoNotesRenderer.js\":\"b93382a2d5ab6d02\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoPlayerRenderer.js\":\"9933bad9db26d28b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoTimeStamp.js\":\"b3d278fe5ec7538c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/actions.js\":\"c7f0502008a0dbc8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/index.js\":\"aae1577752b73155\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/markdown.js\":\"e5e757714fca5d43\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/notes.js\":\"7c1214f7f22dc20e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/registry.js\":\"7782ecdb283bade1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/remark-timestamps.js\":\"628b9ef4338efd72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/view.js\":\"9124494c23c32e27\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/LinkHints.js\":\"f09f6909c8957bfb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/index.js\":\"ace9827518761855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/model.js\":\"a563a19f31c85198\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/settings.js\":\"1fcceaf1b70d6e04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/actions.js\":\"19a858cff0daee67\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/index.js\":\"8742cd831268ea57\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/interactions.js\":\"7427c22ad91a3aab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/workspace-header/index.js\":\"9d568786d5e619aa\",\"/knowledge-medium/pr-preview/pr-1850/src/registerServiceWorker.js\":\"f2cf18bc072931e5\",\"/knowledge-medium/pr-preview/pr-1850/src/requestPersistentStorage.js\":\"2a5fca384b80d9f3\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authRequestDeadline.js\":\"7876a20e265f726f\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authStorage.js\":\"cae169c423904aa9\",\"/knowledge-medium/pr-preview/pr-1850/src/services/powersync.js\":\"9d2b9b55f09760df\",\"/knowledge-medium/pr-preview/pr-1850/src/services/supabase.js\":\"feb82bab7962cf6e\",\"/knowledge-medium/pr-preview/pr-1850/src/services/uploadErrorClassifier.js\":\"4d87a863f726e146\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/ActiveContexts.js\":\"191b5628113ee6ed\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/HotkeyReconciler.js\":\"224d2fda055fccca\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/WipeLocalDataDialog.js\":\"062bfd7e1f86a272\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionDispatch.js\":\"1d5b295187beabc0\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionRefItems.js\":\"8b4b1b7998a21808\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/applyKeybindingOverrides.js\":\"13378b202be704be\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockActions.js\":\"e90d55ce85489a1b\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockMergeGesture.js\":\"710acce928477920\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/canonicalizeChord.js\":\"4998d1c9c2b827bd\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultContexts.js\":\"5fb2089c04489b57\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultShortcuts.js\":\"3fedbc315e3f56d1\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/effectiveActions.js\":\"e8a3105928e62e77\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureAction.js\":\"8676f9c3c728a77d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureBinding.js\":\"4c511144836c2bdb\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/holdRegistry.js\":\"1f0720a63ea2a8fc\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingConflicts.js\":\"4705ea752d5a871d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingOverrides.js\":\"1e44bd83a883b8d2\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/pointerAction.js\":\"e0ad3a89420933b1\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/resolve.js\":\"3696ac4131c9dcd5\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/runAction.js\":\"13c7afc2ef5dfce8\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/sequenceMatcher.js\":\"006b2be517874329\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/types.js\":\"cfd5b46fb612eb2b\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionContext.js\":\"a088257ef5aa7037\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionDiscovery.js\":\"a69d83cd7d01cf57\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/utils.js\":\"4f8ecd104556afa5\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/bootStore.js\":\"fcafac191edce096\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/previewDatabases.js\":\"3d58e7920e62e311\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/byteTransform.js\":\"7ec77ada2dc65385\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/attachmentCleaner.js\":\"d356f4368b180722\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/attachmentParts.js\":\"be2b8c8bdf7bfb84\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleParts.js\":\"0e3c08d89c0b3aef\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleRecord.js\":\"7e713c9addc6f561\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/manifest.js\":\"7f6678d5f3cc95fa\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/takeBundle.js\":\"c624b898f32ae486\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/verifyBundle.js\":\"2b7e93b29b4b4778\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/cleaningStage.js\":\"97b68e79f45e0c6a\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionKey.js\":\"1af0c3bbf27b7947\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionServer.js\":\"5fb392cdef383453\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flip.js\":\"eb12e67038366083\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flipAttempts.js\":\"5d9b7498c1ff0761\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/pages.js\":\"d2011ad701e8aa2b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/preflight.js\":\"239d71333fb369ad\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/reseal.js\":\"404d81cc8f5c8b37\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runConversion.js\":\"2651737aad08bf69\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runLock.js\":\"80557c70dcfdd733\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealing.js\":\"50d0fd32ba86e65e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealingStage.js\":\"0698acc2d9b40ce3\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/stage.js\":\"3ca079a957d8a024\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/verifyReseal.js\":\"fef708d8783b23a8\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aad.js\":\"93228e53729c1ed8\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aead.js\":\"d9dd4c2aa3cd3fb6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base32.js\":\"4e321085ef687987\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base64url.js\":\"ca1ed2b1a11691a7\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/binaryEnvelope.js\":\"76382ffe29fe7125\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/byteAead.js\":\"82de1d4b48e1c4be\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/canary.js\":\"b7eff70cf04115b4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentHash.js\":\"d228539e0d310550\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentKey.js\":\"5625c1c62f650bed\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/derivedIdNamespace.js\":\"1b5068f43b8be6f5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/envelope.js\":\"31c7c8fcc09342fc\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/hex.js\":\"2455c11bccd1f55d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/sha256Hex.js\":\"146374cd83e21da5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/workspaceKey.js\":\"ac0cfc8f86736954\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/conversionState.js\":\"396f60b8e915d6ca\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2944ab13911e1389\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/pastedKey.js\":\"aecfa3b5dd93324d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"314b2284eb4af6bb\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b94d123586e88ced\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/keyStore.js\":\"478c53cd93a51808\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/mintWorkspaceKey.js\":\"edb4902e8aa7e138\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/modePin.js\":\"dbf177929b969c35\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/openWorkspaceKeys.js\":\"e6c9f252a2d14d5f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolveWorkspaceEntry.js\":\"10107c3fab8292a2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolver.js\":\"38ff6c965c8739cb\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/workspaceAccess.js\":\"1e562f7edd5095b3\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/transform.js\":\"ad47965f68ac934f\",\"/knowledge-medium/pr-preview/pr-1850/src/themeBootDefaults.js\":\"b0de1daf05bce90d\",\"/knowledge-medium/pr-preview/pr-1850/src/types.js\":\"e81647e74dc4c021\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/ClientLocalSettings.js\":\"2fc5ca44c60a8ed2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/abortableSleep.js\":\"ddf8f1013fa5c309\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/array.js\":\"546a5daad590d659\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/backlinkAutocomplete.js\":\"ddcdd941ea0e098c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockCrumbs.js\":\"c34b8deba46e3e3d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockrefAutocomplete.js\":\"d8248b326b6b53e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/cadencedIdleJob.js\":\"b3c3dc4b89191fee\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/callbackSet.js\":\"45a8f95e2031b22c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/clientId.js\":\"5a3722d4fd521d1c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirror.js\":\"43fa3b5e357d6bf3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirrorCompletion.js\":\"73da8379b598f7de\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/copy.js\":\"f330d4241b4b35be\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dailyPage.js\":\"194286f03753b426\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensics.js\":\"e08f2be57457cd53\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensicsHooks.js\":\"27d908fc129535a6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/deleteBlockThroughUi.js\":\"ca409f3ecc8f91a9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dialogs.js\":\"a754f5b3aa803814\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dom.js\":\"d4a785aed3caf5ce\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/downloadBlob.js\":\"6765af130b54b1df\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/exportSqliteDb.js\":\"4a87500ee400bf6b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fileSystemAccess.js\":\"c1a3432a2291d45a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/flipSlide.js\":\"a66d0463c1e57c8e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fnv1a.js\":\"f71d85fff9c1e135\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/formatBytes.js\":\"5215f0dfb15cd0b4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fuzzyRank.js\":\"b8f57ae6213dec41\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idbKeyedStore.js\":\"4f09441d7b242894\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idleCallbackPolyfill.js\":\"62a9e10eed64d777\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardAwareScroll.js\":\"5dd38d1c2c77a341\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardViewport.js\":\"dc823fc810a6114c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/lastWorkspace.js\":\"acbc915c17750027\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutColumns.js\":\"b568ece6db197579\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionDom.js\":\"ce7f80c617afb609\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionId.js\":\"ac6dc3e9ec40b304\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkClickGestures.js\":\"efa14612679f9772\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkTargetAutocomplete.js\":\"ce8a81095e75abf2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbCorruption.js\":\"c9b224a99d1dc31a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbRecovery.js\":\"803ee80df57d6038\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/markdownParser.js\":\"4b7fb7b5b91f1a17\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/memoize.js\":\"fea2af1a018b467a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameFieldCommit.js\":\"5e3abe095d1b4944\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameList.js\":\"d4aaa49b160e201a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/navigation.js\":\"412fedb3280f5754\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/omnilinerNamespace.js\":\"a92ca2a1e800f7ac\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/opfsPageScan.js\":\"9c4dfeae230b21c9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelClearance.js\":\"0d57a537ffef0fda\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelHistory.js\":\"5cda36739ff23d86\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLanes.js\":\"d6c14e861da59b34\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLayoutProjection.js\":\"17b4f5fdb84ab0f0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelScrollAnchor.js\":\"fd90ad600dc3fc57\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelUrlFlags.js\":\"50629718a5ca1309\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/platform.js\":\"11dc3af6d2cae37b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/pluralize.js\":\"d7a78d80e00d6a31\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyCreation.js\":\"876df29374a3198d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyNavigation.js\":\"06d366899d009355\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyValueContext.js\":\"cfb8a839eed54362\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/react.js\":\"13a8d487926678c6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeDate.js\":\"45dae9f6da75d095\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeTime.js\":\"a77be5e2d0bf771d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/renderScope.js\":\"e3e48325f835a44d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/resolvedThenable.js\":\"4b713618227dfa75\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/routing.js\":\"6b8044b291931076\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/safeMode.js\":\"b7c1f264c6c498ac\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/scheduleIdle.js\":\"c1d9ba5b2ebb83ed\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/screenWakeLock.js\":\"0e75b24b3c7d9ede\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/selection.js\":\"571305d55a8f65c9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/softKeyboardGrab.js\":\"1ec35841bd21c9c0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/startupTimeline.js\":\"f4fb8c76afe3caf0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/state.js\":\"7ca563d3b479f9f6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/string.js\":\"bc0f18a80f0ec738\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/surfaceZoom.js\":\"7b1fba9dc9ec0718\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/time.js\":\"eaa562444bbd1751\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toast.js\":\"f534aa1334bab993\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toggleStore.js\":\"33b59210343825db\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/untilStopped.js\":\"f2099c9e14398c01\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/userActivity.js\":\"edb0ac6f5bfd95a1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewTransition.js\":\"c441e5f9aeeebc8a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewport.js\":\"0bb5d0a82940bf8f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/webLock.js\":\"0488940f26f9abf3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceRecovery.js\":\"4975f093d9db5232\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceSnapshotStore.js\":\"bba3c1b706d04530\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-compiler-runtime.js\":\"5594d90b09a27fe1\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-client.js\":\"af18c92c18b87412\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server-edge.js\":\"248237c43f7f5cff\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server.js\":\"5aa3533669ea99a8\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static-edge.js\":\"452c5b9322794d43\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static.js\":\"0619ef29f1cf2069\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-test-utils.js\":\"8dbb16b12b70d0ca\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom.js\":\"d7842c5ec0faaa34\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-runtime.js\":\"39822c0907899d83\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react.js\":\"3370641182d3f5c9\",\"/knowledge-medium/pr-preview/pr-1850/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
