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
		buildId: "6cd891b41c9c-e76ffa60",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/\":\"bffefc2d1efe4c17\",\"/knowledge-medium/pr-preview/pr-1850/index.html\":\"bffefc2d1efe4c17\",\"/knowledge-medium/pr-preview/pr-1850/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1850/assets/FacadeVFS-C3YaxVH5.js\":\"c0df8189857b81d6\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSCoopSyncVFS-B4MHOhJZ.js\":\"41a5843bf3786b10\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSWriteAheadVFS-Bnpvgrdn.js\":\"aaafb46dbe1fabd2\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-C0f-xGTU.js\":\"723f0a1c012357db\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-Djlkx6W6.js\":\"9574ac053ba011f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/worker-CDPWNcV9.js\":\"300a17428e4a5990\",\"/knowledge-medium/pr-preview/pr-1850/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1850/chunks/app-C9vuBKkH.js\":\"63899e11503a6a32\",\"/knowledge-medium/pr-preview/pr-1850/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1850/index.js\":\"f24c3653d4b4d9c1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1850/assets/AccessHandlePoolVFS-CjsnhIX7.js\":\"049857fa6c2c8ce7\",\"/knowledge-medium/pr-preview/pr-1850/assets/IDBBatchAtomicVFS-Bd8YX9nf.js\":\"b4044f5239497377\",\"/knowledge-medium/pr-preview/pr-1850/assets/MemoryVFS-B8T71J8j.js\":\"0dcdbc69f987e47b\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-DgeMTr2L.js\":\"c54753da65c0c565\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-DKE1_okS.js\":\"a8a5c5e8e98a84cb\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1850/chunks/AccessHandlePoolVFS-Bv4Flhu2.js\":\"15a9e30af3853947\",\"/knowledge-medium/pr-preview/pr-1850/chunks/FacadeVFS-hchTc-Lw.js\":\"206336f09c5c52ba\",\"/knowledge-medium/pr-preview/pr-1850/chunks/IDBBatchAtomicVFS-CkP2GMWo.js\":\"decafaccd7b64eec\",\"/knowledge-medium/pr-preview/pr-1850/chunks/MemoryVFS-CkcyLD3o.js\":\"6c3fa492076517ba\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSCoopSyncVFS-5w5A-KsW.js\":\"913827cca685e93f\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSWriteAheadVFS-Djjsjyhs.js\":\"49674420b2b1d989\",\"/knowledge-medium/pr-preview/pr-1850/chunks/Preview-B65-y7Dp.js\":\"d26f7f2a2a3f885c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/card-ANmaX5dr.js\":\"7d0bc2200a55665b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-DQQ9-LEH.js\":\"a433c1a8eb93c484\",\"/knowledge-medium/pr-preview/pr-1850/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-3XaDUhkh.js\":\"bda9bc9ec18249b0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-async-CbRt5IV5.js\":\"924f2a0a8ccb7fb2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-B-d_uVw2.js\":\"767dcc6633beea79\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BTMXNxrg.js\":\"6379e09bdc41842e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BV4bv3-v.js\":\"89de8add22fa8dba\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BayNOnSb.js\":\"adf6840d96940e5d\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CIQcMgye.js\":\"b53b079a043a68f7\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-DUnt6CdS.js\":\"f529047b2338464b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-I8Miy16v.js\":\"92e4a2b7d640e16d\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server-legacy.browser.production-DxgEZf8E.js\":\"21c8b38fe20d49c3\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.browser.production-__8WrjF1.js\":\"845f57fe1e2cc53b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.edge.production-Cx9YxjXR.js\":\"40c5e8773fcf8e80\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-lj4SpcgH.js\":\"b65a30b59ae44ca2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/server.browser-tdjE98sk.js\":\"ea8cad4ceba5d7c6\",\"/knowledge-medium/pr-preview/pr-1850/chunks/textarea-OyOPFfTv.js\":\"2644f04e651f4ae3\",\"/knowledge-medium/pr-preview/pr-1850/chunks/ui-Bd-eia1R.js\":\"715ee6ff51a1fff9\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-CKYkn7lL.js\":\"61af9430e5900fcb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-async-CTvqRNLY.js\":\"4918cebd32c5c0df\",\"/knowledge-medium/pr-preview/pr-1850/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1850/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/src/App.js\":\"7a37cb2374072f36\",\"/knowledge-medium/pr-preview/pr-1850/src/appUpdate.js\":\"520d449588df471f\",\"/knowledge-medium/pr-preview/pr-1850/src/appVersion.js\":\"f7dd219a662c32d5\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/initialLayout.js\":\"caa31aab26f7ddb5\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/openWorkspaceData.js\":\"c9acb8a6bd2e8d4b\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/resolveWorkspace.js\":\"6dd12a6b9c56e68f\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/workspaceBootstrap.js\":\"dfcf4596ddaf7512\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockComponent.js\":\"f04b35c9f3cbdb27\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockCrumbs.js\":\"f81650b47e916e59\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockEditor.js\":\"b2c6a625e0b86667\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockLoadingPlaceholder.js\":\"73ac66cd75bff482\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockProperties.js\":\"85bcc19a8bc5f768\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockSearchPicker.js\":\"efa3854bf4e6819f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ConfirmBulkDeleteDialog.js\":\"ecd6c760bc879486\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DividerHandle.js\":\"1dbc8a780657db15\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DraftEditor.js\":\"7e2726f0fa3cd04b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/GutterPill.js\":\"7999fd8c1e7150e5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Header.js\":\"c803ff16ba13aa25\",\"/knowledge-medium/pr-preview/pr-1850/src/components/LazyBlockComponent.js\":\"273b04db89736368\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Login.js\":\"d5ba2f3961a2934a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ZoomableSurface.js\":\"0158c21f7a6e2b73\",\"/knowledge-medium/pr-preview/pr-1850/src/components/editModeKeepalive.js\":\"4482bdba420b9e70\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyDisplay/PropertyDisplayScope.js\":\"104a12a1e927bac4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f42477b6769f041b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefPropertyEditor.js\":\"df39a22883b254ff\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefTargetTypePicker.js\":\"eafee618804194aa\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/SelectPropertyEditor.js\":\"3721d8ff4feeb0ce\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/TypesPropertyEditor.js\":\"339fdcda5d3190d9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/defaults.js\":\"77b41627c9a6b2af\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/kernelValuePresets.js\":\"42abe9869eaf617a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/selectablePresets.js\":\"a404c7c6dc24893e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/typesPropertyUi.js\":\"fbcf964f19db3e49\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/AddPropertyForm.js\":\"7aa8302de90ac1eb\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyPicker.js\":\"ed301470aa379f5f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyRow.js\":\"cc4cd5bce52e98e3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/Rows.js\":\"76be7edf4c219adb\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/actions.js\":\"64d13f8674fabc8e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/declarationOnly.js\":\"227e3b2bb48a527b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/layout.js\":\"7f6439ced7a5766c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/model.js\":\"9da3308c45220a66\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapeUi.js\":\"a91acd8337dd081b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapes.js\":\"c5565039eb7b9370\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9948b535d7f18cee\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/visibility.js\":\"32f227461f3ca25d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanelSections.js\":\"346809b03c1d565c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockEmbed.js\":\"d2a02d30c32482cd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockLink.js\":\"c59b1283a27e6045\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockRef.js\":\"42eec6a76257b499\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/ReferenceLink.js\":\"c6467c22ac897c25\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuard.js\":\"4d48dc2e620a3998\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuardContext.js\":\"e8458a55af40362d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/linkInteraction.js\":\"553f7999c64a618b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/referenceLayout.js\":\"6ba51fa5a80c9231\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/useBlockRefAncestors.js\":\"57234eb3567e015b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockGutter.js\":\"e2a65b448c020935\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockInfoDialog.js\":\"7533a53a00b2cb40\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockTypeBlockRenderer.js\":\"fa8d9f2b2b30119f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BulletHoverCard.js\":\"a0fcb302d53b71d1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorContentRenderer.js\":\"bd92e3706142ce59\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9b79b03cb649133d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ColumnResizeHandles.js\":\"d9ba7fd88a9f3ffe\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bf1a62bf423e595a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/DefaultBlockRenderer.js\":\"e3f65d2e39326e8d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/LayoutRenderer.js\":\"5bfd9f9c3b83a09e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MarkdownContentRenderer.js\":\"648a3324b7bf87c9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MissingDataRenderer.js\":\"0bf8410e88ccdb0d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PanelRenderer.js\":\"071ff01569653796\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ab4144875afed673\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/TopLevelRenderer.js\":\"1aa574363d2f13ca\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockGutterMode.js\":\"1f7c00b2a4d8b3da\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockTitleText.js\":\"bf279a1ea6502ea1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/fieldCreationKeydown.js\":\"438163b7fda483e4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/layoutRootContext.js\":\"ebde4d77d3b47511\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/TypeChip.js\":\"b22a3c09eb5e6ab2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/chipStyle.js\":\"e769aa9f81697e75\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/anchored-floating.js\":\"6857db80dd33700f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/button.js\":\"6a93ab44de73178c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/card.js\":\"1d5ec0fc0818cdec\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/checkbox.js\":\"89ea26261186cede\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/collapsible.js\":\"71e16411454b2e10\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/command.js\":\"25f0cad644c727a5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/context-menu.js\":\"a0bdb935e787a647\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dialog.js\":\"b4f6ec8cd59fe3d8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dropdown-menu.js\":\"a77e4b64bfd70be1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/floating-listbox.js\":\"fe5c22b2c6459f91\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/index.js\":\"55b27b1fff131fae\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/input.js\":\"d1bd5c1c107f52f9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/kbd.js\":\"96755417df398efc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/label.js\":\"42a8e8c9f6d8cd0e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/textarea.js\":\"aa2bf3056814005a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/useEditModeYieldKeepalive.js\":\"3b43e778fbe9e4e6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/BootFallback.js\":\"2b1322108b86a9e0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/FocusedRowLazyMount.js\":\"2f1452f0b69c1ffd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LazyViewportMount.js\":\"9a057c81c9a34302\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LocalDbCorruptionFallback.js\":\"2aa6b8669ebf5106\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/error.js\":\"9d39414686c61f73\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/lazyMountRegistry.js\":\"835807a40b52ddbe\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/suspense.js\":\"e6c29878552c2f76\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/CreateWorkspaceDialog.js\":\"0276331306cf3d22\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/PendingInvitations.js\":\"acbcb1833cd69877\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/SyncProgress.js\":\"c7a04f380f407466\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/UnlockProgress.js\":\"42a68f8cf61947ff\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceKeyGate.js\":\"b2fb76933b7cf414\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSettingsDialog.js\":\"88df3187c1c1b16c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSwitcher.js\":\"e251eaa93914dac6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSyncGate.js\":\"d8c958539548549c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlow.js\":\"f6befc1f5f794755\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlowHost.js\":\"be2ab7bc81f5a549\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/EncryptionSection.js\":\"311b3383bac80bbc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/attachmentPrompts.js\":\"b32ccfe57e254ca8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/bundleFolderPrompts.js\":\"aa662c7f9f3f88cd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowDeps.js\":\"b37de07398e18c2a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowStore.js\":\"0664a23e2fafb7b0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/flowUi.js\":\"98d9ca1fad3c59f8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/useConversionRun.js\":\"e204310c8e591ef4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/keyUi.js\":\"03380df28a4b1b1b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnKeyLoss.js\":\"16c91a1a3d7b359b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnServerE2ee.js\":\"4c39ea4b78fac579\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/workspaceUnlocked.js\":\"5995c3943a783f58\",\"/knowledge-medium/pr-preview/pr-1850/src/context/backgroundSubtree.js\":\"ca0e92876633df91\",\"/knowledge-medium/pr-preview/pr-1850/src/context/block.js\":\"a10eebc793727eac\",\"/knowledge-medium/pr-preview/pr-1850/src/context/layoutWsContext.js\":\"8547fc349c90188e\",\"/knowledge-medium/pr-preview/pr-1850/src/context/propertyDisplay.js\":\"0322ed89e60a7079\",\"/knowledge-medium/pr-preview/pr-1850/src/context/repo.js\":\"39d26fe112b072ab\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasClaim.js\":\"71302b0e89e10791\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasSeatNamespace.js\":\"0e549a291a4a5615\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockData.js\":\"fbbe373384a72dce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockType.js\":\"468c613fbdff7105\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/changeScope.js\":\"3a4b8ece9e93237b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/codecs.js\":\"b5058a559bd7199c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/derivedData.js\":\"66351578ab0d649b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/errors.js\":\"80a637cabb33b890\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/events.js\":\"e8ad057ae32953f5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/handle.js\":\"32449acbe25a5d7d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/index.js\":\"5f72a0247bab6eb4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/mutator.js\":\"479a01ae7d4766de\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/processor.js\":\"69da619d60708cdc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/propertySchema.js\":\"d11076a74eefe7e2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/query.js\":\"fa2deb38c5a97cfe\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/sameTxProcessor.js\":\"a8ccbdfc4fbba743\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/schema.js\":\"32449acbe25a5d7d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/tx.js\":\"32449acbe25a5d7d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/typedBlockQuery.js\":\"ab388f922200638c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/user.js\":\"8936aa2674ef778b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresetCore.js\":\"4700c1e5c412a740\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresets.js\":\"201996f25c196580\",\"/knowledge-medium/pr-preview/pr-1850/src/data/attachmentCleanerIOVerb.js\":\"9b3550385db1e14a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/block.js\":\"0a5009478f17348f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockCache.js\":\"2715a478f228a36a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockId.js\":\"e8af475a5cfc2b5f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockLiveness.js\":\"c7486dc22d0cdbfd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockMerge.js\":\"05f60c513f3d71a5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockSchema.js\":\"19d4b9c5686fd6cd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypeLookup.js\":\"9f1ab4d282acd774\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypes.js\":\"fc0e474d7480819f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/clientContext.js\":\"b5d7deccd8ab8657\",\"/knowledge-medium/pr-preview/pr-1850/src/data/dbFileSiblings.js\":\"83eb611927a297b5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/definitionSeeds.js\":\"0fd5eb8f194bd548\",\"/knowledge-medium/pr-preview/pr-1850/src/data/derivedIds.js\":\"6ea6de75cf23dd91\",\"/knowledge-medium/pr-preview/pr-1850/src/data/drawnSubtree.js\":\"5572ad038f2b23df\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facetBridge.js\":\"06641f8e5c8ec71f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facets.js\":\"a561ee8eabcf9503\",\"/knowledge-medium/pr-preview/pr-1850/src/data/globalState.js\":\"b79792544d02f832\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/aliasClaimRederiveProcessor.js\":\"b52c99be249e051b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/ancestorBatch.js\":\"6f2eb4a7d5050abd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/blockTypeTypeifyProcessor.js\":\"0540025b3198ee80\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/clientSchema.js\":\"c7d4706f03675e34\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/commitPipeline.js\":\"8f67cbf70ae99696\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/devAssertions.js\":\"7377c24e47cf32df\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/firstSync.js\":\"afb51b861651c870\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/freshInitialLoad.js\":\"79015fd9db6a79ae\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/graphBackfillClaim.js\":\"81bf6733593d0a85\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/handleStore.js\":\"4e70a34143c9f888\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/idleMarkerJobs.js\":\"d57925ce5a934eda\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initialDownload.js\":\"ee5df67b02b46644\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initializeClientDatabase.js\":\"84fa2e0b46460749\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/jsonCanonical.js\":\"73c8ebe6e8409a6c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelInvalidation.js\":\"dfe92e9fb8d3223d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelProcessors.js\":\"77521c954b707111\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelQueries.js\":\"f7c51fd982c56e5e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/mergeTypeMembershipProcessor.js\":\"6e0b79d2b531f3da\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/normalizeReferencesProcessor.js\":\"e135cacc4f8e6de7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/poolInstrumentation.js\":\"0993be668e997d21\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/processorRunner.js\":\"8ec69b3fde09987e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyCellBackfill.js\":\"ba671923af110e87\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildMint.js\":\"ac54fbaa24da063a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildrenProcessor.js\":\"d45d601190ea3e77\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bec0f8394fb08180\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionSynthesis.js\":\"14139d48d6b334ef\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyKeyScan.js\":\"dc3598210a6afbb7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertySchemaResolution.js\":\"ca5404c3b7c54583\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyValueEdits.js\":\"763c09ec101c4130\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/raiseProtocol.js\":\"c33057c3a3105bc1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/readBatch.js\":\"8772f9aca895e4ec\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/refProjection.js\":\"c3db908a185928aa\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetLookups.js\":\"cc5677da0e76c1dc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetProcessor.js\":\"e6ef294274461e98\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/replayMerge.js\":\"0370e3c40cae5072\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/sqlBinds.js\":\"4f0a4a25ce1fabe8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b2614e1c5bdc5bce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/arrivalProcessors.js\":\"b2252a920df808c7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/invalidate.js\":\"47d67403ca4d1406\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/materialize.js\":\"b5e5943bbb223dbf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/observer.js\":\"4c64b3168222f4ba\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/reconcile.js\":\"25de37e9bc02f660\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/timingMetrics.js\":\"0fbee650bd1035bf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/treeQueries.js\":\"9d4ec222950ab36a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txEngine.js\":\"25117059f34ea858\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txSnapshots.js\":\"5cc6b16fe09ae63f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/typedBlockQuery.js\":\"18c8543fc4de5d3f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/undoManager.js\":\"774ec761830f4133\",\"/knowledge-medium/pr-preview/pr-1850/src/data/invalidation.js\":\"885272360d56f69a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelDataExtension.js\":\"2e8ccd47c8094a85\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelPage.js\":\"63d40f66f0c1d1bf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelValuePresetCores.js\":\"6f09950a4d9490ce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbCorruptionSignal.js\":\"deee4b958fcc8522\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbStorage.js\":\"b234cd266285bb50\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbVfs.js\":\"c4383edb3ec2729c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localSchema.js\":\"2ab05a858222379c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/maintenance.js\":\"cd8bb3e19aef02fd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mergeProperties.js\":\"1f067369b173cfce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/metricsConsoleHook.js\":\"a4d4eab7dbcb0993\",\"/knowledge-medium/pr-preview/pr-1850/src/data/migrationsPage.js\":\"6ed549daa1c6ed71\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mutators.js\":\"572010f98e328fdf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKey.js\":\"bc0cde279f39c309\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKeyPlacement.js\":\"d08f9bbdcf27fb92\",\"/knowledge-medium/pr-preview/pr-1850/src/data/outlineSurface.js\":\"61f2911075c0a6e3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingEditorContent.js\":\"9e45f1b1919067c4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingUploadsSql.js\":\"bca6a5e8fc2850d4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pluginStateExtensions.js\":\"4bc9206c45f54f4e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/powerSyncLogger.js\":\"f4274accb1c32298\",\"/knowledge-medium/pr-preview/pr-1850/src/data/projectorRuntime.js\":\"c1189bbec797abde\",\"/knowledge-medium/pr-preview/pr-1850/src/data/properties.js\":\"07952ef8d2bfc4e3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertiesPage.js\":\"008405e9a1f0e521\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyChildren.js\":\"4b9e6c501e4b215b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionFanout.js\":\"67bc3ca64a7d722c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionMetadata.js\":\"5e74db266674849b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionRegistry.js\":\"8e98d52efd4b1e42\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDisplayMode.js\":\"73c5fe9b4855f750\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyRowCreation.js\":\"197dad42ffc59f76\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySchemaCreation.js\":\"ec23f31e0ca09992\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySeeds.js\":\"8ce645d26ba2f948\",\"/knowledge-medium/pr-preview/pr-1850/src/data/recentsPage.js\":\"1f043f62c4a17e02\",\"/knowledge-medium/pr-preview/pr-1850/src/data/referenceBlock.js\":\"bf6d65a38f41a2e6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rejectedUploads.js\":\"f29eccc99366a256\",\"/knowledge-medium/pr-preview/pr-1850/src/data/releasePowerSyncConnection.js\":\"6e6a5b9ee337a38f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repo.js\":\"fac79f9b6590289c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repoProvider.js\":\"15d21d27f7f616eb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rowProperty.js\":\"1d16b6760d6c679b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/searchFilter.js\":\"b8c8ddc17a314556\",\"/knowledge-medium/pr-preview/pr-1850/src/data/seedIdentityLedger.js\":\"0b3de614fa441570\",\"/knowledge-medium/pr-preview/pr-1850/src/data/stateBlocks.js\":\"4eae0d641c2a28dc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/structuralEditPolicy.js\":\"6af393c3fa84b147\",\"/knowledge-medium/pr-preview/pr-1850/src/data/subtreeDelete.js\":\"4182b6aa374ef82d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncStreamLock.js\":\"f5423501dad447da\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableSqlRecognizer.js\":\"512b3f4b23ec62c8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableWriteGuard.js\":\"5ca9533beaf28900\",\"/knowledge-medium/pr-preview/pr-1850/src/data/targets.js\":\"f3342f9fb921d211\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeColors.js\":\"5d22f5a604bcc150\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionMetadata.js\":\"64b476f8c2df33e8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionRegistry.js\":\"b42e348a46f820a9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeExtraction.js\":\"8f24b071b12a26a3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeInitialValues.js\":\"0b2792e76497c0ea\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typePropertyGroups.js\":\"11f6286de12f1d2b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeSeeds.js\":\"d183b7635c46cda1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeTagger.js\":\"c800f3b5e56e7cc4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typedRecords.js\":\"b7882d0709761463\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typesPage.js\":\"eeac1b496604532c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userPrefs.js\":\"91aaf01f9cad2b0e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userSchemasService.js\":\"38a3589e6aca6a56\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userTypesService.js\":\"22163854cee4a843\",\"/knowledge-medium/pr-preview/pr-1850/src/data/valuePresetRegistry.js\":\"d331314d8366aff0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/visibleChildren.js\":\"74fa0f7bea505886\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceConversion.js\":\"911257c8f177e0e0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceFirstSync.js\":\"6d1119d858dc019b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceIdNamespace.js\":\"6c2beec0fd0ced3f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceSchema.js\":\"ef6deb7dd448fd31\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaces.js\":\"f07359dcf5b3eb16\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadLog.js\":\"f0abd2693879851e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/BlockPasteShellDecorator.js\":\"709058d1bda63898\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/atTrigger.js\":\"7f3b06ecd1a28cc1\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/autocomplete.js\":\"3d3d220ae56ada8f\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/codeMirrorExtensions.js\":\"11d25d096c839951\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/contentFlush.js\":\"cb00e8eaab8d4db1\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/defaultInteractions.js\":\"a7052ab4165bfbcc\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/editSettleSignal.js\":\"bee039a3dc622451\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/insertImage.js\":\"2bafa98233823760\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceCompletionRange.js\":\"5f2d800e334c1a0e\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceTargetTypes.js\":\"899b76badc7f33a4\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/syntaxContext.js\":\"76be1b69c37f970a\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/triggerMatch.js\":\"97bf02f7f754bfe3\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/AppRuntimeProvider.js\":\"cb233b2d6d7abf7a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/BlockFocusShellDecorator.js\":\"64cea39f432fde82\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/ExtensionRenderBoundary.js\":\"dcb316e947f25e51\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/PanelContentRecovery.js\":\"ff751a673145a18a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/apiCatalog.js\":\"5f099da8ac3ad189\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/approveExtensionHere.js\":\"a241e03089348eb1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/armedCutAppMount.js\":\"000cd24cb9d56e67\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/batchableKeyedStore.js\":\"3c24662d4a82adc1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockInteraction.js\":\"10e66f57c4bd9f83\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockSelectionAction.js\":\"4b09ece938ba0950\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compileExtensionModule.js\":\"16562c5de1dbd009\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compiledModuleCache.js\":\"ce56cfc1b107bec9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/continuousGestures.js\":\"3c89099e2f90babf\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/core.js\":\"9d8033d505166984\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/defaultRenderers.js\":\"cc9e2f65ef3ce056\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/definitionFanoutAppMount.js\":\"eb435912321cca49\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dialogAppMount.js\":\"d55b6884cc8fe28c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensionSeeds.js\":\"ebef86d422b57051\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensions.js\":\"1be2af48afdc2c26\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/exampleExtensions.js\":\"cabd0fc7a465d41d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionApprovalStatus.js\":\"ff48ac53a7482b57\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrorToast.js\":\"7a85f3738a8306f5\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrors.js\":\"df233c8390359252\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLookup.js\":\"8106ea65e7cff1f5\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionToggles.js\":\"11605e5b4166ac74\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionUtilitiesCss.js\":\"f154bb210f02d65e\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/kernelPageDeletionGuard.js\":\"d2eca7345e29083a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/liveRuntime.js\":\"468659c2f1ba7576\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/openExtensionsSettings.js\":\"0018b1bd02603f65\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/overridesCache.js\":\"368e7ad0b4583270\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/pluginIds.js\":\"9b65cdcafc023e70\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/processorRejectionToast.js\":\"fad4c6b476142e01\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeActions.js\":\"9cbd92d2be57126d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeContext.js\":\"2e390ada51bba125\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticAppExtensions.js\":\"05fe737770bb3971\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticDataExtensions.js\":\"0d18b6ef8a77c51d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/toastAppMount.js\":\"cad929e08b10aaeb\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useOverrides.js\":\"a84cef4425af62c4\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useShortcutSurfaceActivations.js\":\"17bec440366f6006\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/discoverToggleTree.js\":\"65e1232da52c6e69\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/facet.js\":\"f9105f168776fdf9\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/resolveAppRuntime.js\":\"76e33a3375b517c9\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/runtimeEvents.js\":\"076759daf362e7d2\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/togglable.js\":\"93a4256ffe9223ed\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/variantFacet.js\":\"ab957920bf432551\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/verbFacet.js\":\"a9892be4ffb1fe45\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/block.js\":\"5a0665f412efaa6e\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/focusedChild.js\":\"a2a57e78bc4a97a6\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/propertySchemas.js\":\"f57b4bbabada2988\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/typeRegistry.js\":\"4ed735f3c1d8c571\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAncestorCrumbs.js\":\"7fcd7a47cbe37272\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAutocompleteListbox.js\":\"848aeb4df3c464e4\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedSearch.js\":\"5f4af406c44aa90d\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedValue.js\":\"b315f1659b124c4d\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsFocalRender.js\":\"3fc390e9e47b136b\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsReadOnly.js\":\"25afb3b96c76981c\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMaterializeBacklog.js\":\"23d8c492439fd19e\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMinuteClock.js\":\"e222b420823412c8\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePanelLayoutProjection.js\":\"7feac3df52ec2df5\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePendingInvitations.js\":\"abb1ce47ce282bea\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRendererRegistry.js\":\"5a249d6412c62b14\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRetainedFieldRows.js\":\"80c01ce62d5d26e4\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useWorkspaces.js\":\"706a5e8e3c80dfda\",\"/knowledge-medium/pr-preview/pr-1850/src/lib/utils.js\":\"0e705563c365c578\",\"/knowledge-medium/pr-preview/pr-1850/src/main.js\":\"7088420183fd80da\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/MarkdownImage.js\":\"a2544876e76f2c4f\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/blockSeparators.js\":\"086c46b14b18c039\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/context.js\":\"5a5feb186ed808fc\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/defaultMarkdownExtension.js\":\"acab3d1f9c146701\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/extensions.js\":\"dfa6f632bcf50a83\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/renderMarkdownHtml.js\":\"b8419f50396b5240\",\"/knowledge-medium/pr-preview/pr-1850/src/minimal-editor.js\":\"32a69227f63e0018\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/armedCut.js\":\"54c56d8da1c1499b\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/captureMediaVerb.js\":\"bc5cb54dd5a96d79\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/clipboard.js\":\"6a9eefdf96a15ad6\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/decision.js\":\"1ce1b217f92c332f\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/operations.js\":\"99e17721946ef40e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/AccountHeaderItem.js\":\"c6a71e1a6a00a98d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/index.js\":\"63c1d71f5d042557\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4ae5319e645f821a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askAgent.js\":\"c46d53c4e968c3db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askedStore.js\":\"2917be54195db808\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5f13d4e5ab5f1465\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/chipState.js\":\"5fd3cfd977f20aaf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/dataExtension.js\":\"cc4c8f3f9c288fcf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/index.js\":\"fd958f8d1ceacfab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"362330b55867bd04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/schema.js\":\"b56fc0b36e48e1d8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2b41185576800334\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b5bcea00545afd5f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/addMedia.js\":\"03f802621bc898f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/backlinks.js\":\"80fb8ba933f53bbe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/block.js\":\"f4febcdbff714d47\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/context.js\":\"51b9fc7c166cc0b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c8974f8b25d2ee21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/index.js\":\"712a045fcf2b8242\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/outline.js\":\"5b3de1f7bbbf5b72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/properties.js\":\"31ee8b0e6e9551b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/refs.js\":\"d6520602c670151d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"789f08712cdfa411\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/search.js\":\"63c2a7272337f05f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/shared.js\":\"a8419b487ddfde35\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"20512711db484810\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/text.js\":\"a23cfd980ea063c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentWrites.js\":\"9bdc4d904f9b7ba7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/authoringCatalog.js\":\"106d0a515dea3e59\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/blockRefTargets.js\":\"81d176345cd009d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridge.js\":\"8973868bea3f67f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridgeLoop.js\":\"114160d797f3696e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/changeHistory.js\":\"798508789ed4b87e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commands.js\":\"d1e1b5972cf86531\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commentsCommands.js\":\"acda1a2a22ac6a77\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataExtension.js\":\"047e7db3c477cca0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataModelGuide.js\":\"e9c6a42c0c68d8b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/describeRuntime.js\":\"39036127d8633cba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/extensionLint.js\":\"6ec28eeb7f38760f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/grainAudit.js\":\"faa69cfcd49edc89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/healthCommand.js\":\"dfd097fb1d383dd5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/index.js\":\"f2508629c12f3db6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/presetIdentity.js\":\"6d865862611bb7a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"515aa4621d3ab1bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/readMedia.js\":\"a9308a732c8efe6e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/schema.js\":\"b323da69f21362b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/serialization.js\":\"89e68bc354b2e54e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/targets.js\":\"8e0e98590825e804\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/tokens.js\":\"0e8912dd374065ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/watchEvents.js\":\"8c21bc0bdf0aab6c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/workspaceGuard.js\":\"80c7f569ed972d81\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/writeCommands.js\":\"4950cf636794eea2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/AliasCollisionToast.js\":\"cbca41cb1bea541e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/DuplicateNameBanner.js\":\"6be32304ad1e6f0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/collisionMerge.js\":\"9e9fe81b0560f8c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/dataExtension.js\":\"285929508e410491\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/index.js\":\"36e901a7cd207f62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/mergeCollisionAction.js\":\"e14c62dd6cd964df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/pageStyling.js\":\"2f4459890fd81257\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/rejectionToast.js\":\"af90fda8a3236996\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/syncProcessor.js\":\"b25d44527cfd2083\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/actions.js\":\"bf04e926bd4afecb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/addComment.js\":\"ad69418564c1c638\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchor.js\":\"0babb6495683d523\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchorState.js\":\"7eb7da32839ad1d6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/commentLinks.js\":\"1a1f7f02e107f7da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/confirmThreadDeletion.js\":\"b28635e196fbebba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/container.js\":\"610e1f54ca743996\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/dataExtension.js\":\"851f4208680de48e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/deleteComment.js\":\"ed58afe823a7fdea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/highlights.js\":\"c3df03d87da18819\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/index.js\":\"8d469e49ff540800\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/linkedCommentsPill.js\":\"ef3e908c0fa3e419\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/margin.js\":\"769782f3812c1038\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/marginSchema.js\":\"42811bf16b55d06a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/newComment.js\":\"3fe36abf4c923c82\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ownThreadPicker.js\":\"56b7ca3c2e48932d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/placement.js\":\"32575fa6a9fa49a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/queries.js\":\"8d699b95fdc898b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotePosition.js\":\"da3ceb8f00bf8f96\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedIn.js\":\"c6ac965c10d4c2e8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedRange.js\":\"806fb4ea77cf490e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/rangeRefs.js\":\"1e37a005dfb6dca7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readHighlights.js\":\"dbb7a4a32a0897f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelection.js\":\"df7c40005ccb73da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelectionUi.js\":\"f4364b8b3a134318\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/reanchor.js\":\"5bb373fcccd22eb3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/schema.js\":\"a5c5531df514bcfd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scope.js\":\"a45c0af9ccf13cbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scopeThreads.js\":\"2e5eb4a44a06b6bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/splitRetarget.js\":\"bb22043d91728ea8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestionCard.js\":\"02bca57f839e2e24\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestions.js\":\"d8762b1d18272b86\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaries.js\":\"255783c31addf144\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaryBatch.js\":\"adc872ef1313e8cd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/surface.js\":\"be01302491b2ac05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threadNavigation.js\":\"ae17ec6904863d7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threads.js\":\"b11e6d6f71596067\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ui.js\":\"fbaf7ef2e727460e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/uiStore.js\":\"5f64fbfcd7818a1e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/appIntents.js\":\"08e4fce78838d380\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/index.js\":\"30c5da56a18dc3f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/index.js\":\"e0b138e9ca4f0d30\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/status.js\":\"2a3f916a2e7132a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4dcbc46306088737\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaBlockRenderer.js\":\"b284b9be5f07ad37\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4b7ccd1e3e558b67\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaUploadReconciler.js\":\"40551ac41ce1d261\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetDownLane.js\":\"55433bb311f919e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetResolver.js\":\"4e75d6f05eb7cbd2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetUpload.js\":\"b25e67f31fb8b735\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/attachmentCleanerIO.js\":\"d0ef0816131751a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e5c6c4d9249add3d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/blobStore.js\":\"c1d85efa3db5356f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/byteStore.js\":\"31ce67945c5b2b6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanerIO.js\":\"6b58162c776cfe17\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanupAttachments.js\":\"d14fcce944d3c292\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/dataExtension.js\":\"f1ca0075f3e5d75b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/downLane.js\":\"4544a12a1e888917\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/index.js\":\"24823ed3085884a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/insertImageContribution.js\":\"1d5a5265438ca7d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneArming.js\":\"d977f3068b1ec539\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneLock.js\":\"47ab87317c26f5db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaBlock.js\":\"f4225387c359db2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaCapture.js\":\"6c1b9c8222d9e8c9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewers.js\":\"e01e25d70c9c9e10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewersFacet.js\":\"7d113719d23ffe3e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/pasteCapture.js\":\"9bcb3c23a7b54909\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/resolver.js\":\"ea3bfda87d19975b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/retryUploadsAction.js\":\"bedd6fb2d71f0dee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/storagePaths.js\":\"e5d3889f0b5df677\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadDrain.js\":\"0566295422c5b2a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadLaneStatus.js\":\"f613af95a9cd0ac9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadReconcile.js\":\"140c948658e5f5db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadRecovery.js\":\"21d9fd54648316ea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadStore.js\":\"8e98d1c1fa36207c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/useAssetObjectUrl.js\":\"548d0902b76be980\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9cb11f585cbc6561\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e316fac9db3214c5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/facet.js\":\"5d38d584de30de7c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/index.js\":\"8616d82d4fc66ef6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/prop.js\":\"485710b210aecad8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinkFilters.js\":\"5e4320a0d7f4c0f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9411300274d9df1b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BlockEntry.js\":\"972bf795143370fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/LinkedReferences.js\":\"1f9fd936b864d09e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"aa768fff43ad621a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dailyNoteDefaults.js\":\"3d625c4b681b7874\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dataExtension.js\":\"a6ae798037aca4f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/edgeExclusions.js\":\"1fab5bfa24b3964d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/filterProperty.js\":\"b5ec18a784bbe0ce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/index.js\":\"468db4af22a85e96\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0d4faa68d6a6629b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/applies.js\":\"534a01e749d8ca19\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/countQuery.js\":\"df79b84a0c9e6e74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/expansionStore.js\":\"67f1c22c8eca914c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/index.js\":\"f5ea265478989092\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e1729eeae0116d15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/presentationInvalidation.js\":\"e0b66ae1735e82c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyEditorOverride.js\":\"1764db8e22ad00df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyFilter.js\":\"832575213c2c2990\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/query.js\":\"9370d71b71a47cdd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/resolveFilter.js\":\"3a4218dcb7adcd26\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sourceBatch.js\":\"b076fc9f2238a58d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sources.js\":\"2e98003c9bcd8798\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useBacklinks.js\":\"479d3cce4e01c0d6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f7bb412abbfbe32a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayCelebration.js\":\"7679773be5e2acbe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayOverlay.js\":\"6dab043018fdca93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/gate.js\":\"036f4ed97941b904\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/index.js\":\"984707de9176ba00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/wolfTheme.js\":\"a2b3026dfcfe336a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/BlockDragLayer.js\":\"d4aac36a7f2d47b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dragController.js\":\"75d029a76a804a3e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dropTarget.js\":\"fcef4ba7a657e29b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/index.js\":\"b57eeda1e30405a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/projection.js\":\"ba097ca96f7fcfb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/BlockMetaCard.js\":\"87bc0000841a8c76\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/index.js\":\"1fab0049552b0cba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/AddTagDialog.js\":\"39a4dfe5c8356be4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"37d3d1d320064bc8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/TagNameIssueHint.js\":\"8e21110067c30b25\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/addTagAction.js\":\"f91b8c7b95bf362e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/appendTag.js\":\"be2f12733589d68d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/config.js\":\"578a53bf3aba08be\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/dataExtension.js\":\"023e701af7619d6b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/index.js\":\"9fed5d81498ec056\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/propertyEditorOverride.js\":\"5c5057b87cab6965\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbList.js\":\"864dc6dd748afda9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d96146de893cecf2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6e3e702b7d6bbcb4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c52d6b35377141ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"55a1f9c0299f6ab1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/index.js\":\"d97e140f29f756b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"34acdacd96f47b32\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/CharacterCountItem.js\":\"cf316fe2ce2e02a0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/ProfilePropertyEditor.js\":\"dc07538bd0513a69\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/actions.js\":\"7fea09e35c9ed7fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/blockType.js\":\"109956c95dcca58d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/charCount.js\":\"132d9db081f7bc32\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/dataExtension.js\":\"1feaf33b7d5bf9e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/index.js\":\"a77a94f08a09428b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/profiles.js\":\"1f3b5f816e39c61a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/properties.js\":\"6904f4d598a1bc7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/textCounts.js\":\"e21a5d17b9d48e16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/colemak-keybindings/index.js\":\"a6d28b01ab782963\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/CommandPalette.js\":\"4b83b92b6fd4344f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/HeaderItem.js\":\"a8aac289f510416d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/context.js\":\"13de288357dedd2e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/index.js\":\"c74f14975395d3be\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/selection.js\":\"7daddda1d19b043a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/toggleStore.js\":\"1a7a1ff6a90bb9d6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/useCommandPaletteActions.js\":\"dc6ea983794ffaff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/ContributorBadges.js\":\"e25dc48e082ef0e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/author.js\":\"a563af33795d98ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/codeMirrorExtensions.js\":\"1789aeb3f5913473\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/dataExtension.js\":\"cbb8e7c7774226df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/index.js\":\"f6e6c3c097a48e1d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/mentionAutocomplete.js\":\"e82abd14708f5a32\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/processor.js\":\"b1c88ce13df388b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/profiles.js\":\"a9d982ac3b2bc8af\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/queries.js\":\"0ef97d4310ebc31c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/schema.js\":\"d14b8a3976a255a0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"6765c0a6c02b3339\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/followOrigin.js\":\"dd84d6cb5739f203\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/index.js\":\"98faa0e45db00b71\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"20a3c737ca92bac5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1e68f7ddeb6f23ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/CalendarGrid.js\":\"cd8e0888d4050587\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DailyNotePicker.js\":\"d7582ea619655c3c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"79c96995f7af6dd9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateNavDecorator.js\":\"eb112831be7cf991\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateScrubOverlay.js\":\"6867d3df3fec5a0d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/HeaderItem.js\":\"e7c98c1a7364217f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/ReschedulePicker.js\":\"073256ab3e41466c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/SpreadDatesDialog.js\":\"705e540d467e5ab7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/actions.js\":\"e305196809a27c36\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/blockDateAdapter.js\":\"8029f24b0a49edac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/calendar.js\":\"bf71ff6ee8ad505c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dailyNotes.js\":\"3cf897e9b35ac5bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dataExtension.js\":\"a2db2f5d1810d1b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubActions.js\":\"5b23a57bee43be0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGesture.js\":\"4c3a12f95b220352\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGestureActions.js\":\"68c9f8e9870e1737\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubRecognizer.js\":\"68fcaad01d117eff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/deletionGuard.js\":\"454c102bea79136f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dueQuery.js\":\"f0cc1fb30a173113\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/index.js\":\"d809dd8f71e6f567\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/landing.js\":\"482079f70af9c88f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/localSchema.js\":\"ee0af7f696459f4c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/referenceDateAdapter.js\":\"e9566189aa81ee82\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/rescheduleAction.js\":\"c2ea7d205d6e158f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/schema.js\":\"118117b749ba9a51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadBlockDates.js\":\"e86f13db8d26a127\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadDatesAction.js\":\"d18adbebbea304b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/today.js\":\"78a672d8a6449cc4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d025a15f3f268659\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"fee2cb7adef2f1ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/audit.js\":\"95e1839cba9d0ccd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditAction.js\":\"12d45326eef8aeb1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditRanges.js\":\"787d432722d6c1f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/diagnosticsSource.js\":\"3d24189347d54d1d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/divergenceScan.js\":\"5bd1981113765c60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/index.js\":\"49a58bd0843fc765\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e436ee0c3cbbec66\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/referencesMirror.js\":\"e83d795d6992abc7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/rowJson.js\":\"2fc4d8b38aa55e2e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/schedule.js\":\"38f8d581273b5f7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/store.js\":\"bb8c86b94fce0b98\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/action.js\":\"2744ecd7a4daa014\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/index.js\":\"11c406cd091f98d1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/plugin.js\":\"5795d803ae0f6563\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e2df87be06737e4c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/actions.js\":\"15d36e73370913d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/changeMarker.js\":\"82674a79dfa93d6c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/diagnostics.js\":\"df3c5831edde3279\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/fileSystemAccess.js\":\"e7c7cef9d6a68d53\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/filenames.js\":\"983116a06ac9a14f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/index.js\":\"68119f6a1f260c00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/mirror.js\":\"60ff32b58d96999e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runLock.js\":\"36caace6567bfeec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runtimeHealth.js\":\"ca0b338833548a65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/schedule.js\":\"83e6318579bca5e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/store.js\":\"940d3c522bc1ec4d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/index.js\":\"95fd02e2642ff46b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/themes.js\":\"c4f6f20e4b3385f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/facet.js\":\"5e650370b1544fa5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/useDiagnostics.js\":\"a1a94e2a85cd8f47\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/dismissals.js\":\"5e1d9b1c2a75df7c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/index.js\":\"f9ce29c2250fa8bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/status.js\":\"d270ee726c7317fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/store.js\":\"1c39d818103e5fd7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"64cd8e81bd7e73db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5f2ea246a0e73178\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/actions.js\":\"11761e9a171c1e61\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/config.js\":\"442597010defd6dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/dataExtension.js\":\"95b94ef7198b44fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/effect.js\":\"c4b1d78a0860ead1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/index.js\":\"954a3dea0310bff1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9a7790eb79a6117f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/useToggleTree.js\":\"e99504183e276ea7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/ExtractTypeDialog.js\":\"ef5fc6f8e17d5ac6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"773cd2efc55c123a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/PropertyShapePicker.js\":\"af60bd870c184fdc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/action.js\":\"9a1bc4eca4130f58\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/index.js\":\"18f963841b6dfc17\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/FindReplaceDialog.js\":\"9f109158dfc0e1bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/HeaderItem.js\":\"3e3fe210eeeeebca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/dataExtension.js\":\"ec5c604535841a80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/index.js\":\"7b4cd715ea18bb4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/search.js\":\"0d1fe5c03e40383c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/toggleStore.js\":\"5fae0e8ad554f4f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/LocationPropertyEditor.js\":\"cb51c4581897eb93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/MapView.js\":\"c086f1bae1d8e660\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/blockTypes.js\":\"abb5e66f1deef503\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/codeMirrorExtensions.js\":\"e5d6cce7dcee2bb2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/createOrFindPlace.js\":\"64a57c1c9c32cc72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/currentLocation.js\":\"11e26c5dc13dbdd2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/dataExtension.js\":\"b4c7cc2ae886332a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/geoContentDecorator.js\":\"19ca22e7acad72bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/googlePlacesClient.js\":\"b91ce0a9774adfce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/index.js\":\"02426b2945669348\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/locationsPage.js\":\"48f2a47b1364119e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/mapViewport.js\":\"bf44db158b4a3214\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/pickCurrentLocation.js\":\"e41c95cb64797eec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeAutocomplete.js\":\"01a9177305d439a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeNameCollision.js\":\"b8b24949d5afb6a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/properties.js\":\"95142e8d3bd209ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/propertyEditorOverrides.js\":\"3831a63904b72733\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/query.js\":\"dfd866d8462e4536\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/usePlaceSearch.js\":\"ca666a6be9c69ea8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c41e456363dbcaa2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"50fc644327310222\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9eb8b9d70e48809e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/config.js\":\"f7f0959f58fe6b6c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/dataExtension.js\":\"68660cbe4509265f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/facet.js\":\"a11be53d0ca9f813\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/grouping.js\":\"e9060aa2774b3aed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/index.js\":\"770091ea655815ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"002573af44b39f6f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/query.js\":\"00d143e9ce6d3f0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/resolveConfig.js\":\"444e6e509274c1a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"54f61c897bb0786a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"80fa796d00d38f93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlDocumentContent.js\":\"70beeef2b5b91e0f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlFrame.js\":\"455fd7ac03916f31\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/actions.js\":\"22e3690893bda5bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/blockType.js\":\"11ee36a1ac39e282\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/confirmRunScripts.js\":\"1f233b66e5ee186d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/dataExtension.js\":\"06ea252194e8e608\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameAnnotations.js\":\"d151a6ab3ae5ccb2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameDocument.js\":\"dc157f9c48c08bd5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameTheme.js\":\"0840ac832aff524a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/index.js\":\"6aecf8083ed70407\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/scriptConsent.js\":\"7e0f07f7220f5662\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/sourceMap.js\":\"27f5b4ccfe548f46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/useDocumentScripts.js\":\"a1ab1839b08160a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/index.js\":\"d188195fe76c5f42\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/record.js\":\"cc924c1321f89a56\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/recordStore.js\":\"9e1f0ffc4f494b6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/responsiveness.js\":\"a0e40245b91d8182\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/schedule.js\":\"d5858e64d5be2cd2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/sessionContext.js\":\"4a10a45967f025ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6dd3afd0c4df20fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"769e100ebf448a0e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/actions.js\":\"a41829be3151f787\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/config.js\":\"d7e1dc27d3bda2e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/dataExtension.js\":\"d131a9487bf8bdbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/effect.js\":\"e2c406702ea0bac3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/index.js\":\"c2a244deed90cfd0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/keyCapture.js\":\"caeadf68ea60631f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/overrideStore.js\":\"c45703aea9c133df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d2d4a9f953c82df1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/HeaderItem.js\":\"975a40a621b1a25b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/LeftSidebar.js\":\"51415a8d9f271579\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/actions.js\":\"52901986771805b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/facet.js\":\"e68b81e8beb2ad09\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/index.js\":\"b6d2bf49a06dcfd3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/shortcuts.js\":\"7554579ef6a00930\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/toggleStore.js\":\"7e511180663b4d7f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/MergePicker.js\":\"976abe76bb9b1e3e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/index.js\":\"90fffeda281d3677\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/mergeAction.js\":\"84f2d927fa9f89ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/strategy.js\":\"83f15f7af2e56998\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/Button.js\":\"7b133762b26d330b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"67516a229312dd99\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9e17e408f19bb4a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/facet.js\":\"a950097eb8f95fd2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/index.js\":\"1065b1460eeb9b3f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"bcc609a9b34369f5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d7981cd8e4793861\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"76381ec82710b500\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/facet.js\":\"89ce2da4859c4162\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/index.js\":\"85ba88afb523cecf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/MoveDestinationPicker.js\":\"73d2e48c78840cca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3604fecf1a8fda9d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/contextMenuItem.js\":\"8dd35b99c0a55216\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/index.js\":\"0006ae6f66b71869\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveAction.js\":\"fa991e89435d9732\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveBlocks.js\":\"e5253a7149a1d905\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/selectionAfterMove.js\":\"87e8cd32d1c5bc31\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/TutorialBanner.js\":\"05672914c4facd34\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/action.js\":\"5a0c181bd0b887c5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/bannerDismissal.js\":\"a7272f1584cf8d15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/documents/cheatSheet.js\":\"f31793c0720bca62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/index.js\":\"60182ba1d7fdf39d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/keys.js\":\"d6f1cdfda82886c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/landing.js\":\"b5daae5babeb20ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/outline.js\":\"dabc3b742286dcd5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/seed.js\":\"964f31dbb374044a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/PerfTrendDialog.js\":\"81a9a82b89a0c5ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/analyze.js\":\"db98d575094f05a0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/diagnosticsSource.js\":\"746639b865d5d124\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/index.js\":\"3a75f917e94d4a5f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/load.js\":\"2512fdf99a27599d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/monitorRun.js\":\"e8547d6d4e063d44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/schedule.js\":\"0a7b1d97501c9d1c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/series.js\":\"1d06ca9804591d44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/store.js\":\"4df7766e67d3fa91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/trendAction.js\":\"ca071ada8b021dd4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/verdict.js\":\"0356cdab16d69d13\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/clickToEditAction.js\":\"a8af7c26955eaa93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/index.js\":\"bd4b56648cfa48a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/interactions.js\":\"a6d72d853780aa37\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b05b7c8531f819a9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGate.js\":\"898351b4f3ac9266\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGateDialog.js\":\"f90ecdda173c5024\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/action.js\":\"d480ed6206272dba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/index.js\":\"f585acd316d75321\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/localRunMessage.js\":\"ca6cd7c9a92f89ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/plugin.js\":\"add8edd3f47f0e92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/progressReport.js\":\"fa5758bf34555b8f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/sweepProgress.js\":\"1ba3e39d7d1430c3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/FieldRowRenderer.js\":\"60e1a7e030bda672\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/ValueRowRenderer.js\":\"cfb5b4a5632497e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/actions.js\":\"fbdc7814a4b67149\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/autocomplete.js\":\"ebe314b4d21c6d7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/fieldRow.js\":\"f5544408957f3554\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/index.js\":\"a2f428016a8c959c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/referenceWarning.js\":\"bb480b3f82e6ced4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueAutocomplete.js\":\"151d73e8e7e7733f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueSchema.js\":\"4a53ecc12ad72967\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/HeaderItem.js\":\"533b7b06fc833e4a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/QuickFind.js\":\"2b1a11c1473bfa29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/index.js\":\"fb68df6dbfb9c481\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/recents.js\":\"d303e7e3f9936a86\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/resultItems.js\":\"1c775a61e8edcc85\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/selection.js\":\"92c01ee2956d9dd7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/toggleStore.js\":\"ad3cb014e9c1f79f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/HeaderItem.js\":\"cb96528e345b076a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/RecentsPageBlockRenderer.js\":\"31c58c7a991c1796\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/grouping.js\":\"7c77841164e4991c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/index.js\":\"4fc620876113b1cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/target.js\":\"175c4adec3f28e38\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/codeMirrorExtensions.js\":\"afb6085ab6f8faba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/contentPrefill.js\":\"f2d9da169c90b9f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/dataExtension.js\":\"8bbf996f674e38d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/index.js\":\"8599318ca51fe180\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"447f3331fc618f5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/invalidation.js\":\"05ac5ad1b9acb58d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/localSchema.js\":\"f071757236c17876\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/index.js\":\"a715a61cd0e5c78c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"17993a1ed9a98caa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/index.js\":\"5779380d425a1c17\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/referenceNode.js\":\"8fa81e848dd6735f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7d64f428b812e5f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e25413cf089a4d03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/index.js\":\"dced7a929f4a6ed8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f69235a465adfe8c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"dbd0286bdad53401\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/mergeRetargetProcessor.js\":\"f3001f721a1126eb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/parseFence.js\":\"fa41ed61e40d099c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceParser.js\":\"acbb753c9e21a26e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceProjection.js\":\"939da46c1b08e19a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referencesProcessor.js\":\"16d489faf2d2756c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/renameProcessor.js\":\"d497cd7e9a663f19\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/spanReplacement.js\":\"27aff7362ae8d247\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/htmlToOutline.js\":\"f0fdeaded8b4dcce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/index.js\":\"9aa357d1a60c036d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/normalizeClipboardDom.js\":\"512e0fc5593cc99f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/pasteDecision.js\":\"5a0c0e6ebbb377b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/action.js\":\"a29e31b3d3b21570\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/blockIds.js\":\"864c52b2b3458845\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/content.js\":\"0f203c110ddb0a9d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/effect.js\":\"f58b19bfe8fd76ee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/ids.js\":\"1ab0df7db0018570\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/import.js\":\"db1f0c4048d7fb3b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/index.js\":\"1aa173eedf335d39\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plan.js\":\"f9f65054e379e31a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plugin.js\":\"dbcbd080d89f54b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/promotion.js\":\"316a9cddf5f320ce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/properties.js\":\"1ca45a1c64ce61a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/references.js\":\"b443928062d53f9a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/report.js\":\"a7f609ac3ea296d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/roamMemo.js\":\"1db8036b7ffc877e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/runtime.js\":\"5eb780df6f17c397\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/schemaReconciliation.js\":\"65985d04d922987a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/srsMarkers.js\":\"3a2ab41c631a96fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/todo.js\":\"7953b852fb958330\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/typeCandidates.js\":\"71138ff0a967a22d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/types.js\":\"679e9d9fee6c78b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/index.js\":\"92eb9997b66becc1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/store.js\":\"4676d3dc70a57344\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/HeaderItem.js\":\"78faf04996a04a03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2835c6fe0c9450e8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/index.js\":\"85db8a119c7dc6d8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/model.js\":\"ac5679302e113b23\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/toggleStore.js\":\"3494bde0ff8dcc9a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/useKeyInspector.js\":\"c8ce8d676d259d44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ef50cec8d1952532\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/ShellDecorator.js\":\"2406adecd97a4bce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/actions.js\":\"15bb09cf0f1ca206\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bb5c49f92491a54c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/index.js\":\"f8e9110dfeeffddd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/shell.js\":\"de681b45b8ecd468\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/surface.js\":\"fcc515f75ffba03f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/walker.js\":\"95efb5ddcc40dc4c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b68662ac3e61831e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/dataExtension.js\":\"c90787f8439baf72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/index.js\":\"1f98c27293c6870d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/indicator.js\":\"d7ee4accef2e4749\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/moveSrsState.js\":\"2330b29dec095279\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"aad10a34d7e6fc4a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/scheduler.js\":\"a2222c9d7186a865\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/schema.js\":\"e2dc747e7a82d28e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ae3af36189f35700\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsClipboard.js\":\"0f488dd4920f73e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a8857702c8bc4420\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DailyNoteReviewHint.js\":\"afe3fbf4c4f448e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DeckPicker.js\":\"f666955a9b22859d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewControls.js\":\"a776963d67c2cc9f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewDeckRenderer.js\":\"50844dcd36d6ede8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewSession.js\":\"5de130f7fe2617b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/actions.js\":\"7f1ac9adce48c8ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/archive.js\":\"4a9f9e3a5a50ab91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dataExtension.js\":\"932530f3ec6216d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/deck.js\":\"d3895aebe4ffbc7f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dueQuery.js\":\"e55a1eb73aeca6ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/gradeDecision.js\":\"b468bad53faae2ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/index.js\":\"67d0f62b23c6fcb3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/keyHints.js\":\"320ca6d47c435c4e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewCardLayout.js\":\"912cc78eed4a21ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewProgress.js\":\"aaa48d931d787bca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/schema.js\":\"3cea804caf21a1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/useDueCards.js\":\"24082e10db8df947\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/index.js\":\"623cc7519c66f6e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/record.js\":\"3ee1522367eae0f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/index.js\":\"3048aed6bcf63abf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/persistenceStatus.js\":\"a605e8c5ec73b424\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/requestAction.js\":\"cf68ad44cd2abaa7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/TypeChipsDecorator.js\":\"4e07c7149eda719d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/codeMirrorExtensions.js\":\"9e42c2c65f17b4a0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/index.js\":\"af9af49a57bc7c04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/typeAutocomplete.js\":\"0cce3e7d05b2e119\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"311b3033a2ff2e09\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/actions.js\":\"7e0b6ef3ac9b12c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/anchor.js\":\"0d8c4666627e90be\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/events.js\":\"d2c1316d310689bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/gestureActions.js\":\"ce0c442405e18875\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/index.js\":\"ca085f5bb548eeab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"14811a0e89941351\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/collect.js\":\"817c1235b7e9637f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/index.js\":\"c84c1fe39fa7b5f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/record.js\":\"1943435ecbde7b33\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/RejectionDialog.js\":\"6bcef35a6bf4ef5f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/SystemStatusHeaderItem.js\":\"19a58d889ecb6d6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/index.js\":\"0ab30965bfed89de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/model.js\":\"0dbb8f7c18d40366\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/queueCounts.js\":\"efcf927335cc6d46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rejectedHelpers.js\":\"2ccf980c837d9f3c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rematerializeAction.js\":\"7e0065c02f4e911e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/useHysteresis.js\":\"f8f03c8dc3146a57\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/ColumnHeaders.js\":\"48f1445eeb952da9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/QueryUi.js\":\"264925fcc90c9296\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/TableLayout.js\":\"2d95e9377475720a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/actions.js\":\"c19fca2848469321\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/cellEdits.js\":\"c1dcc29cb8aea777\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/columns.js\":\"6c7e9ad4b4ea05dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/controller.js\":\"772d77f09ffa8c70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/convert.js\":\"306892395e0074f5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/dataExtension.js\":\"1b2c17ca670066c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/index.js\":\"dd5f3677aef5c120\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/keys.js\":\"b766d5016fb46b38\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/model.js\":\"a06650bd7acceaa3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/backfill.js\":\"3948b26689b80b15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/format.js\":\"cdab71ea3bbc64a9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/parse.js\":\"3af6033703483758\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/queryValue.js\":\"adb45f4803372b13\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/source.js\":\"bd4824398ff5101a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/registry.js\":\"9cf0a41220557fad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowGutter.js\":\"572a7a5857e9aab4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowVerbs.js\":\"a488872e1dc7bbec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/schema.js\":\"3113a73f45f71bbd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/sort.js\":\"9bd6b6ec26f8746b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/effect.js\":\"0352b999fbaa3006\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/index.js\":\"e5d19faf39858004\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/theme.js\":\"d12d22d0c0697221\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/actions.js\":\"a7b21b652be11a55\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/dataExtension.js\":\"cae103d2073f3fac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/index.js\":\"134699edf9dad920\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/schema.js\":\"265673b77181348e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/TouchSelectionLayer.js\":\"265a27d64c78a581\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/actions.js\":\"d6d9e917ed42c577\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/defaultItems.js\":\"cbdd1497cda2ac09\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/facet.js\":\"b141d46a67541ee1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/holdRecognizer.js\":\"c80a91687a5c71c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/index.js\":\"147800f41417bde8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/UpdateIndicator.js\":\"3876e35b672d2b67\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/index.js\":\"49749e35f8a8e7b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/loadTimes.js\":\"3fa147507a731c05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoNotesRenderer.js\":\"190bf382daf891fe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoPlayerRenderer.js\":\"c1e4dc7563d1d1cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoTimeStamp.js\":\"7a1cc71dbbbbdbb7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/actions.js\":\"164eaad52ce338d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/index.js\":\"778f6cdee9a38802\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/markdown.js\":\"1efc5aedc810136b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/notes.js\":\"8d245bcc746e52f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/registry.js\":\"6b22a209e602df39\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/remark-timestamps.js\":\"9c16d8b546b1b902\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/view.js\":\"97c5eae08be0db6a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/LinkHints.js\":\"fbb4de327ad6a593\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/index.js\":\"d8128eb2041b22c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/model.js\":\"f7355438bf1dcbf0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/settings.js\":\"1799084d93341742\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/actions.js\":\"e1f006ba004ee3f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/index.js\":\"2e463a8108845307\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/interactions.js\":\"fa782d32293ba139\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/workspace-header/index.js\":\"2d70ab3374af7b6d\",\"/knowledge-medium/pr-preview/pr-1850/src/registerServiceWorker.js\":\"26e682ce384c4fff\",\"/knowledge-medium/pr-preview/pr-1850/src/requestPersistentStorage.js\":\"bc3d2a43fd868501\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authRequestDeadline.js\":\"6d055f672141ffa3\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authStorage.js\":\"a3a5388a285b0672\",\"/knowledge-medium/pr-preview/pr-1850/src/services/powersync.js\":\"7d2a1729bb3d9460\",\"/knowledge-medium/pr-preview/pr-1850/src/services/supabase.js\":\"b56a13e2d2a409df\",\"/knowledge-medium/pr-preview/pr-1850/src/services/uploadErrorClassifier.js\":\"7338121849c8c55d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/ActiveContexts.js\":\"2f0094607fdd97c2\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/HotkeyReconciler.js\":\"10bed0e97677bd58\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/WipeLocalDataDialog.js\":\"74e0fac30469aa33\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionDispatch.js\":\"fe3ac58f398b834f\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionRefItems.js\":\"70931e904fe267c7\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/applyKeybindingOverrides.js\":\"dfa188fe62660582\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockActions.js\":\"6c29c3c089c4e85a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockMergeGesture.js\":\"5cd1d8f686d7c10c\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/canonicalizeChord.js\":\"23b31f69cb8ace1f\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultContexts.js\":\"40223dd88cc7c216\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultShortcuts.js\":\"ec58491be5bd8169\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/effectiveActions.js\":\"7d581329fed3806f\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureAction.js\":\"119b69e016363182\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureBinding.js\":\"eb248d91e889127e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/holdRegistry.js\":\"b533ded2660dcec0\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingConflicts.js\":\"b55f91c813b9ad9e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingOverrides.js\":\"0baa9a4d089ad4a6\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/pointerAction.js\":\"e128ce7032755940\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/resolve.js\":\"61bc7545c18edc43\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/runAction.js\":\"fbdcbdf7d43bd288\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/sequenceMatcher.js\":\"6c80cfea7251c0a3\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/types.js\":\"43c5f534ce5f483b\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionContext.js\":\"76c2d6227a66fe92\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionDiscovery.js\":\"b2b66347c834c510\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/utils.js\":\"0321554fdd41f7af\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/bootStore.js\":\"900190466a889503\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/previewDatabases.js\":\"4121bdcd1b9f1eff\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/byteTransform.js\":\"292b59d5b079947a\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/attachmentCleaner.js\":\"7842acd8dc0352aa\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/attachmentParts.js\":\"e271c1cd70e43060\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleParts.js\":\"9a87e6aaaa2124d9\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleRecord.js\":\"4b1c060bf307dd3f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/manifest.js\":\"ff6df09cc3e8582c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/takeBundle.js\":\"4c055cd600e15438\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/verifyBundle.js\":\"552aa557a77ca5ff\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/cleaningStage.js\":\"e38a12c317b8c3dc\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionKey.js\":\"3e23b785d2b5878f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionServer.js\":\"6f0f807dc814c692\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flip.js\":\"de5c1f3ad11e3a53\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flipAttempts.js\":\"2c207b252a67399d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/pages.js\":\"69209efdf80759c9\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/preflight.js\":\"57ace353c866ab83\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/reseal.js\":\"85d3a43f1e4252e2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runConversion.js\":\"b8afbd64d7fdc0ae\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runLock.js\":\"469325e662d8d4f2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealing.js\":\"1a5ae65d14ed7333\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealingStage.js\":\"9c71552df8de0c93\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/stage.js\":\"c6c0b985dd4bc280\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/verifyReseal.js\":\"98a36a19a8d01c5d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aad.js\":\"0a1e89ac6e76d346\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aead.js\":\"a0b9c20ddda18d74\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base32.js\":\"4df94f0375211c9c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base64url.js\":\"42775e99920c50cd\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/binaryEnvelope.js\":\"ef7c597f95f0d192\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/byteAead.js\":\"b7cb868ea5e95f79\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/canary.js\":\"1ce07b646ed9da09\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentHash.js\":\"c83dcfe17662e77e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentKey.js\":\"67e13d29aba720ba\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/derivedIdNamespace.js\":\"6a615ff763b29b16\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/envelope.js\":\"95cb377dbe40379a\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/hex.js\":\"f16b67789aafb42d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/sha256Hex.js\":\"808cf78f9d3b38e6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/workspaceKey.js\":\"8ed8c5d296e99e1b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/conversionState.js\":\"6f7cd84cf3afff67\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/createEncryptedWorkspace.js\":\"8eb8b7ee1f789e87\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/pastedKey.js\":\"3274984d4c01a26c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"810e5c0c3c2ee25b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c5407ddd0cb21e7b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/keyStore.js\":\"fe466c2e57cf2522\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/mintWorkspaceKey.js\":\"07e59ba8c39406cb\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/modePin.js\":\"b95fb5ad0722e387\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/openWorkspaceKeys.js\":\"afda513d01bbe742\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolveWorkspaceEntry.js\":\"14620a748f5d1d05\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolver.js\":\"5fb147a3ff75d3eb\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/workspaceAccess.js\":\"f2f290186703b280\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/transform.js\":\"28a05a5d55c543e8\",\"/knowledge-medium/pr-preview/pr-1850/src/themeBootDefaults.js\":\"00513b448e71e185\",\"/knowledge-medium/pr-preview/pr-1850/src/types.js\":\"6407c00157896d34\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/ClientLocalSettings.js\":\"d00cc3c3442becd2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/abortableSleep.js\":\"2a452fa7dca5c988\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/array.js\":\"92de39c91b6ce007\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/backlinkAutocomplete.js\":\"1bd334b0d2efff15\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockCrumbs.js\":\"3e51216e293a8ba7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockrefAutocomplete.js\":\"925cd98f96549734\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/cadencedIdleJob.js\":\"8484c24e5954235b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/callbackSet.js\":\"abd06a92e531e3a7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/clientId.js\":\"c47a5bd9a5df1c10\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirror.js\":\"9061d3851c2f5352\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirrorCompletion.js\":\"cf41cb9950300ff6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/copy.js\":\"41d43880adecef76\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dailyPage.js\":\"764aeaa9aa323c2a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensics.js\":\"1c512137b2f64b58\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensicsHooks.js\":\"9669ff5d31d28835\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/deleteBlockThroughUi.js\":\"2feb14bd0e842e33\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dialogs.js\":\"a56ab7ae5ee93a0e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dom.js\":\"321531e2a41f06a1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/downloadBlob.js\":\"646b6829267a789d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/exportSqliteDb.js\":\"126639c05b93815e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fileSystemAccess.js\":\"7edbf675479c600f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/flipSlide.js\":\"72ac52b63795eaf3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fnv1a.js\":\"712fe51f94f60db7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/formatBytes.js\":\"f73adbd40f0b705b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fuzzyRank.js\":\"bc54cb999d8c8db4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idbKeyedStore.js\":\"a6e98b655cf89726\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idleCallbackPolyfill.js\":\"5cd9e6a8df25de9e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardAwareScroll.js\":\"2b2ebd6608941696\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardViewport.js\":\"25a3d67bca232cac\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/lastWorkspace.js\":\"d1120b1867084462\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutColumns.js\":\"3bc831167d442cc9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionDom.js\":\"ec7fcb1b4c370f10\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionId.js\":\"dbb63490f3428bcc\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkClickGestures.js\":\"ca9ea903002714ec\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkTargetAutocomplete.js\":\"844211206ed9a1b4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbCorruption.js\":\"d81c5bbd10952660\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbRecovery.js\":\"f2bb608d7b6a8c30\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/markdownParser.js\":\"797e9d800b86f377\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/memoize.js\":\"936989d77a84d52a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameFieldCommit.js\":\"b419cee0e585f74e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameList.js\":\"383cd7f704bf8aa8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/navigation.js\":\"c79d83c41b94c3ea\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/omnilinerNamespace.js\":\"5de112bac6a784f1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/opfsPageScan.js\":\"8286c676a437a935\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelClearance.js\":\"c1c3649eccc0deb3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelHistory.js\":\"7a4f9c8eff4c1aa6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLanes.js\":\"e7b58d9852381487\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLayoutProjection.js\":\"a1c9b731bab09dc9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelScrollAnchor.js\":\"27a27ea49dd2bf60\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelUrlFlags.js\":\"bf83ed090420b89a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/platform.js\":\"bdb80edb0c7b8b44\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/pluralize.js\":\"f04c09205ff77c62\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyCreation.js\":\"ecc66c6ed87efdec\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyNavigation.js\":\"fab09c5458532827\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyValueContext.js\":\"f9b4276c41794c95\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/react.js\":\"e53603cbda30d149\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeDate.js\":\"27ee710ac0fdaf7c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeTime.js\":\"70022b9708d853bd\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/renderScope.js\":\"33a1d038ae1be240\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/resolvedThenable.js\":\"b2fb5bcc582ff226\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/routing.js\":\"19b246b5d2e47885\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/safeMode.js\":\"394a8c0ab6f0ac16\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/scheduleIdle.js\":\"a92a86bb4796f180\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/screenWakeLock.js\":\"9053c4e30c76e902\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/selection.js\":\"0d0f7c7f3b8e593c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/softKeyboardGrab.js\":\"cbaace1ca86e0d9a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/startupTimeline.js\":\"07c9fd7e13fdebd1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/state.js\":\"4844df3033ac9e3a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/string.js\":\"fd09075ded337dab\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/surfaceZoom.js\":\"10384d4d59b651b1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/time.js\":\"1192e38e27c66b7d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toast.js\":\"80a208e566eab046\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toggleStore.js\":\"cd9d02eea1a3f614\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/untilStopped.js\":\"69bf626404fe4ac1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/userActivity.js\":\"17971be1031191b5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewTransition.js\":\"6a5ae400805ca766\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewport.js\":\"027d81f2b2061b61\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/webLock.js\":\"720ec12e61f7a2d3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceRecovery.js\":\"859a8f33ed70d9db\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceSnapshotStore.js\":\"5060b5af237c8cb9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-compiler-runtime.js\":\"35478274aa9232c1\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-client.js\":\"f951a42864ec28d3\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server-edge.js\":\"e6750859f9c8be6a\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server.js\":\"2897182f00b38cba\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static-edge.js\":\"4d4c357f034cb618\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static.js\":\"cb1f7ef5c9bb31d3\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-test-utils.js\":\"8ba5907af619bd11\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom.js\":\"71959ea68c108e90\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-runtime.js\":\"09bf70aa52bccbfa\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react.js\":\"9b213363d8792fbb\",\"/knowledge-medium/pr-preview/pr-1850/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
