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
		buildId: "33be2bf0a36e-39b6e9bf",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/\":\"171dda217b1937c9\",\"/knowledge-medium/pr-preview/pr-1850/index.html\":\"171dda217b1937c9\",\"/knowledge-medium/pr-preview/pr-1850/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/app.css\":\"590bdd4a53bb9f0b\",\"/knowledge-medium/pr-preview/pr-1850/assets/FacadeVFS-C3YaxVH5.js\":\"c0df8189857b81d6\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSCoopSyncVFS-B4MHOhJZ.js\":\"41a5843bf3786b10\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSWriteAheadVFS-Bnpvgrdn.js\":\"aaafb46dbe1fabd2\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-C0f-xGTU.js\":\"723f0a1c012357db\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-Djlkx6W6.js\":\"9574ac053ba011f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/worker-CDPWNcV9.js\":\"300a17428e4a5990\",\"/knowledge-medium/pr-preview/pr-1850/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1850/chunks/app-BZv-MOfY.js\":\"8e0bd7c0480524cc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1850/index.js\":\"d3c34ef84dab258f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1850/assets/AccessHandlePoolVFS-CjsnhIX7.js\":\"049857fa6c2c8ce7\",\"/knowledge-medium/pr-preview/pr-1850/assets/IDBBatchAtomicVFS-Bd8YX9nf.js\":\"b4044f5239497377\",\"/knowledge-medium/pr-preview/pr-1850/assets/MemoryVFS-B8T71J8j.js\":\"0dcdbc69f987e47b\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-DgeMTr2L.js\":\"c54753da65c0c565\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-DKE1_okS.js\":\"a8a5c5e8e98a84cb\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1850/chunks/AccessHandlePoolVFS-jd10WneA.js\":\"1b481eb54b868edc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/FacadeVFS-dh7L1hOx.js\":\"fa668b421c3bced1\",\"/knowledge-medium/pr-preview/pr-1850/chunks/IDBBatchAtomicVFS-BDtPReUV.js\":\"393347638cbd7fac\",\"/knowledge-medium/pr-preview/pr-1850/chunks/MemoryVFS-Dz24Dq0c.js\":\"940c4db5254947d2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSCoopSyncVFS-m_3rR9NJ.js\":\"f0f323c2a7fe9b82\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSWriteAheadVFS-L0hO4RR5.js\":\"b72e1c05cbf24a2b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/Preview-BsiRssdr.js\":\"85bd606dafd3a8ba\",\"/knowledge-medium/pr-preview/pr-1850/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/card-aV6ZJPsA.js\":\"e27c20eb14988f47\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-Bms9RdQF.js\":\"b38d7facfe703ae0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-3XaDUhkh.js\":\"bda9bc9ec18249b0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-async-CbRt5IV5.js\":\"924f2a0a8ccb7fb2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BUh4IrFF.js\":\"e1796bfa5cf8472e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-C_W0fBzu.js\":\"13f2da686af16c72\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CgJ5DaZ4.js\":\"db39ea6921e8e7f5\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-DmJbmEuP.js\":\"7cca3f1fb9c32a63\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-DnSBzXhU.js\":\"cf7c589f988139f1\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-UEBIxJVN.js\":\"b31fbbe1e29327ff\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server-legacy.browser.production-BpgY1OFN.js\":\"be0703ac4eb14cdd\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.browser.production-CzilfWIa.js\":\"bb530737890e712b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.edge.production-C0fcAVBT.js\":\"0d86bef7c0eb72e6\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-tp8NsnA8.js\":\"53c3af730ef3375b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-wMltQcG0.js\":\"30284131a7e519ec\",\"/knowledge-medium/pr-preview/pr-1850/chunks/server.browser-CCESVvDF.js\":\"378d860c2c7c182d\",\"/knowledge-medium/pr-preview/pr-1850/chunks/textarea-D1axL8pN.js\":\"cb33c41aefdaf1b6\",\"/knowledge-medium/pr-preview/pr-1850/chunks/ui-bD_VxpqN.js\":\"3e9c8ce1de7fb72f\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-CKYkn7lL.js\":\"61af9430e5900fcb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-async-CTvqRNLY.js\":\"4918cebd32c5c0df\",\"/knowledge-medium/pr-preview/pr-1850/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1850/extension-utilities.css\":\"04cea73dd0dd3a99\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/src/App.js\":\"9163c5ad8026cb3d\",\"/knowledge-medium/pr-preview/pr-1850/src/appUpdate.js\":\"21b70eefa246f754\",\"/knowledge-medium/pr-preview/pr-1850/src/appVersion.js\":\"dea61a9358bf0ac5\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/initialLayout.js\":\"fa5cf610beb87f24\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/openWorkspaceData.js\":\"dbe76308810030e7\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/resolveWorkspace.js\":\"d57cd57fec3a3902\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/workspaceBootstrap.js\":\"3b1975515a5dc0ad\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockComponent.js\":\"493016dc9402697a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockCrumbs.js\":\"8419eefc3f3c9ee7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockEditor.js\":\"cb54d03ced6e4c02\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockLoadingPlaceholder.js\":\"27556380e5f635dd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockProperties.js\":\"91b0e5584fabbff7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockSearchPicker.js\":\"064a03c7b193913c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ConfirmBulkDeleteDialog.js\":\"1b7793cc8a866d8e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DividerHandle.js\":\"fba4b1fc8274cb1a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DraftEditor.js\":\"a0113c24f92316f4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/GutterPill.js\":\"d8a994c729bfa1eb\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Header.js\":\"0527926111a3f01e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/LazyBlockComponent.js\":\"88a02a1dc9b53adf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Login.js\":\"9a213e78cc844bed\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ZoomableSurface.js\":\"4799eb806d1edfab\",\"/knowledge-medium/pr-preview/pr-1850/src/components/editModeKeepalive.js\":\"d3c856aad4200d19\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyDisplay/PropertyDisplayScope.js\":\"50265df1444b9fa7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d9aca92e43933f27\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefPropertyEditor.js\":\"bec9143fedb94d90\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefTargetTypePicker.js\":\"ad59bd88f42a1ef4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/SelectPropertyEditor.js\":\"076f6cc29e633e59\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/TypesPropertyEditor.js\":\"3b6da5d7ee52648d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/defaults.js\":\"f97a2b004aeb759a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/kernelValuePresets.js\":\"6b1a9100629a447f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/selectablePresets.js\":\"34f88d609af046db\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/typesPropertyUi.js\":\"2da29bdf76f35f86\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/AddPropertyForm.js\":\"05209afeea4d80bf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyPicker.js\":\"a1d6c371a689d93c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyRow.js\":\"f2e8e8f29aa17ed3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/Rows.js\":\"a98f82b1d51813d7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/actions.js\":\"f845c1c5d396470a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/declarationOnly.js\":\"209e60d74e6ac8e9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/layout.js\":\"31998550402eac5d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/model.js\":\"f6b0744e3429bbb6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapeUi.js\":\"b95b87dcf4899630\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapes.js\":\"3cd128dd773fc8c9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2078b798bd6f3d34\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/visibility.js\":\"6ac17eb62b1939f8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanelSections.js\":\"c7b9351c341998be\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockEmbed.js\":\"40a0c2071610648a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockLink.js\":\"d91fd331e3b42c0c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockRef.js\":\"49f862171027f9df\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/ReferenceLink.js\":\"d80350963db3e44a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuard.js\":\"1403906e3b4b9f83\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuardContext.js\":\"36d63115c133afb7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/linkInteraction.js\":\"e54715d82c70a89b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/referenceLayout.js\":\"b33d15f2b0539bd5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/useBlockRefAncestors.js\":\"42b9af51942f92d7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockGutter.js\":\"08ed6a26b37c4f05\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockInfoDialog.js\":\"fb51a53844911394\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockTypeBlockRenderer.js\":\"dfda9ad8ce462ec9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BulletHoverCard.js\":\"8a61dd703b9ce98b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorContentRenderer.js\":\"dcfdc2e025ec3ffa\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f77376fafad833c6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ColumnResizeHandles.js\":\"17eab96cc4237e8e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"285ab3941772d530\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/DefaultBlockRenderer.js\":\"66c3d9b823bec96c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/LayoutRenderer.js\":\"a8ecf818869900c6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MarkdownContentRenderer.js\":\"e9759941005fd5ef\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MissingDataRenderer.js\":\"00d02379d706a7cb\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PanelRenderer.js\":\"a9ba3f59e5fa71c5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ff08fc15d600b9fe\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/TopLevelRenderer.js\":\"42b03a8d27477768\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockGutterMode.js\":\"cdbe58a67a71f975\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockTitleText.js\":\"e59f7b779f0e039c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/fieldCreationKeydown.js\":\"2e72965349ba456f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/layoutRootContext.js\":\"65d3ab032c3d83e6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/TypeChip.js\":\"6ffde16bcdd5bbab\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/chipStyle.js\":\"186af7d25fdb1ec1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/anchored-floating.js\":\"05d5ad7d54c51298\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/button.js\":\"4ad3d01bc00475f1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/card.js\":\"e9160536ef6af528\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/checkbox.js\":\"4c65a7b748bf4121\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/collapsible.js\":\"a8c4e6f9ae264dbe\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/command.js\":\"ab48c0e54c76a49e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/context-menu.js\":\"1f7ee0d3e0717d14\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dialog.js\":\"6f5f90e0254340ad\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dropdown-menu.js\":\"2bc5e8cfa7547f2b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/floating-listbox.js\":\"5d38a02df997dbd3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/index.js\":\"aa41867e0a4970ae\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/input.js\":\"2c3d6a67617cf1cf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/kbd.js\":\"f490120fff975091\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/label.js\":\"4f0fa9e9ced87267\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/textarea.js\":\"062e1e5f92b471d3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/useEditModeYieldKeepalive.js\":\"be2b910908b5c4d2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/BootFallback.js\":\"8848827a2a17b929\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/FocusedRowLazyMount.js\":\"f2adcabd4c35b92e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LazyViewportMount.js\":\"14f71aff73fee6e0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LocalDbCorruptionFallback.js\":\"dd58e55bb0acc4af\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/error.js\":\"bb30fca4411b29d6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/lazyMountRegistry.js\":\"0e5b0201bb076214\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/suspense.js\":\"a4df1f8b3dd0a79a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/CreateWorkspaceDialog.js\":\"fe794cdead6a6c99\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/PendingInvitations.js\":\"76868b92b181d5c9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/SyncProgress.js\":\"39dccf2ec7530cbe\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/UnlockProgress.js\":\"9e4d499817f85342\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceKeyGate.js\":\"6cec7f6798323cf8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSettingsDialog.js\":\"172d4e022e166894\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSwitcher.js\":\"42888b9449828524\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSyncGate.js\":\"aa7ef055ad3b0d4c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlow.js\":\"a7d5b0c3a6d05ffc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlowHost.js\":\"4786bd24a7c0cc32\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/EncryptionSection.js\":\"37f332726e89be0c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/attachmentPrompts.js\":\"a26588ce267206cc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1285321d8f2d957c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowDeps.js\":\"7998e42acf0bef3a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowStore.js\":\"e4dd0cf29ff12e67\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/flowUi.js\":\"deab110533b9a358\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/useConversionRun.js\":\"d89005954422ddf6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/keyUi.js\":\"2933cfbbb0b90d38\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnKeyLoss.js\":\"7ece8481824adc3b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnServerE2ee.js\":\"f77e9231137069cf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/workspaceUnlocked.js\":\"be994163b858a9b5\",\"/knowledge-medium/pr-preview/pr-1850/src/context/backgroundSubtree.js\":\"ec1bfbd444ce1f83\",\"/knowledge-medium/pr-preview/pr-1850/src/context/block.js\":\"1f54c90032b1d846\",\"/knowledge-medium/pr-preview/pr-1850/src/context/layoutWsContext.js\":\"cf1c831bfdebc036\",\"/knowledge-medium/pr-preview/pr-1850/src/context/propertyDisplay.js\":\"abdd0e3cf8475cf5\",\"/knowledge-medium/pr-preview/pr-1850/src/context/repo.js\":\"7b6e032e23a80ddb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasClaim.js\":\"4496a0aae383e808\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasSeatNamespace.js\":\"b59c5fcba15e38e4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockData.js\":\"b974c37445c3de3b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockType.js\":\"866e06d53c261754\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/changeScope.js\":\"2ebacb4e85b37e83\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/codecs.js\":\"36fc4e9d11269e12\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/derivedData.js\":\"1d47592c2bdd1542\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/errors.js\":\"d8994e5fc8bdbd65\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/events.js\":\"28509c40dcc4d0f8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/handle.js\":\"61346b5670959fc9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/index.js\":\"8b381f80c5726bfd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/mutator.js\":\"17656cb03e863842\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/processor.js\":\"886a86886d300287\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/propertySchema.js\":\"b26485659887a197\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/query.js\":\"bf12a05c1259da96\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/sameTxProcessor.js\":\"3679d631c9094aa1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/schema.js\":\"61346b5670959fc9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/tx.js\":\"61346b5670959fc9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/typedBlockQuery.js\":\"3e621c8cf02bdd81\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/user.js\":\"ca60a5ca812b01fd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresetCore.js\":\"1a78418939198eb0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresets.js\":\"66d9cda0a43aa6b3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/attachmentCleanerIOVerb.js\":\"cf9a0fe5b65cab30\",\"/knowledge-medium/pr-preview/pr-1850/src/data/block.js\":\"52e3f6aa8727d825\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockCache.js\":\"d3cddf318731be66\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockId.js\":\"e60a4fd111213f1c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockLiveness.js\":\"686e44805464432a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockMerge.js\":\"aaf9ef87b00849ba\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockSchema.js\":\"eacf33847beeb2a3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypeLookup.js\":\"d80eced9d9d8c2a9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypes.js\":\"246d967b9f127dcd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/clientContext.js\":\"107a78cfd93994ad\",\"/knowledge-medium/pr-preview/pr-1850/src/data/dbFileSiblings.js\":\"6c41f0b078c3d8fd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/definitionSeeds.js\":\"94cdca0328f8a710\",\"/knowledge-medium/pr-preview/pr-1850/src/data/derivedIds.js\":\"e6a130fce1627325\",\"/knowledge-medium/pr-preview/pr-1850/src/data/drawnSubtree.js\":\"e636f39cf4a7e56f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facetBridge.js\":\"ca495438c576fa6e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facets.js\":\"23cabdaf8a1530a3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/globalState.js\":\"f84d93f9352853c5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/aliasClaimRederiveProcessor.js\":\"123647f693e7bb14\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/ancestorBatch.js\":\"b8a3baf7c47fe13c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/blockTypeTypeifyProcessor.js\":\"62c5b7cad72bd097\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/clientSchema.js\":\"5d90fece52be73ee\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/commitPipeline.js\":\"5db1f6ea3558b63d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/devAssertions.js\":\"0e81c4e5b234e9d8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/firstSync.js\":\"ba342639c8bf3665\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/freshInitialLoad.js\":\"50dc817d6dd13f63\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/graphBackfillClaim.js\":\"587d2ce7aaf28be9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/handleStore.js\":\"d703534bf66407d4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/idleMarkerJobs.js\":\"0a53f4532e655658\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initialDownload.js\":\"466c6e18af22b3ba\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initializeClientDatabase.js\":\"968be420c71d4f31\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/jsonCanonical.js\":\"9237c98c38027d13\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelInvalidation.js\":\"4013621df55eb278\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelProcessors.js\":\"96c52be2fb2433e6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelQueries.js\":\"a20db8c26a5e63de\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/mergeTypeMembershipProcessor.js\":\"a719ce4b51aee48b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/normalizeReferencesProcessor.js\":\"276cb3b1f02d4ff2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/poolInstrumentation.js\":\"563838133df481e3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/processorRunner.js\":\"8fc1fa34dd078a90\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyCellBackfill.js\":\"cf381a2aac919084\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildMint.js\":\"a804b79a4bdb33af\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildrenProcessor.js\":\"88c5cba3bea56b3b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0ff28140e4e63662\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionSynthesis.js\":\"eda243e52a6febe0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyKeyScan.js\":\"2ac7257636d61825\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertySchemaResolution.js\":\"7f55c6415cd21da8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyValueEdits.js\":\"337fcf1d7effda04\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/raiseProtocol.js\":\"bbec4abda47f9b04\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/readBatch.js\":\"121ea58e134625c5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/refProjection.js\":\"2bf8cb237edb0ffc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetLookups.js\":\"de4adad7889f29be\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetProcessor.js\":\"8cc5a18f5d69a531\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/replayMerge.js\":\"e252f41f95de8665\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/sqlBinds.js\":\"7507ee2d3f371d6f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c78bc30b32ad36aa\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/arrivalProcessors.js\":\"c567ea354e269e13\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/invalidate.js\":\"c59d3a51eee25fce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/materialize.js\":\"440d4495bf31159f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/observer.js\":\"aa2327d377da647b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/reconcile.js\":\"5f2fcc7986a76d0b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/timingMetrics.js\":\"38a7ff77bdbe6bb5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/treeQueries.js\":\"000d58b59f80e852\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txEngine.js\":\"30ba659ef95c6a24\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txSnapshots.js\":\"0c1ff6ffe415fc77\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/typedBlockQuery.js\":\"67ce833eb3b8798b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/undoManager.js\":\"444646cc55e34bb3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/invalidation.js\":\"5908f9a2f40b855b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelDataExtension.js\":\"b55d92c5c7c7a5d3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelPage.js\":\"029686c029d5e3a9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelValuePresetCores.js\":\"cd69f8094fb2ed67\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbCorruptionSignal.js\":\"ecc71792d61b0bcc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbStorage.js\":\"5cc886551a68d527\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbVfs.js\":\"5ff32310892a1984\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localSchema.js\":\"534df05efdd50fda\",\"/knowledge-medium/pr-preview/pr-1850/src/data/maintenance.js\":\"4f1638d631b95a9b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mergeProperties.js\":\"c1f1a1a2eec3b0c0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/metricsConsoleHook.js\":\"548954c78cf4dc47\",\"/knowledge-medium/pr-preview/pr-1850/src/data/migrationsPage.js\":\"ab9115a5f69eec00\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mutators.js\":\"2a73a8ff46e8da3a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKey.js\":\"cde2c2a38cb7f306\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKeyPlacement.js\":\"dcfbecdb207ecce9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/outlineSurface.js\":\"5c1f430bde4f9976\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingEditorContent.js\":\"1d78d05838fdb270\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingUploadsSql.js\":\"d17d2fd47f7c629c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pluginStateExtensions.js\":\"e2ea250a7a799618\",\"/knowledge-medium/pr-preview/pr-1850/src/data/powerSyncLogger.js\":\"335cd959c5a6a7b5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/projectorRuntime.js\":\"ab9971f24455941e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/properties.js\":\"23a36de15269a7ae\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertiesPage.js\":\"792c3156c68e5eec\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyChildren.js\":\"8bb3b120c8082dda\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionFanout.js\":\"f24c0de3ce1f2657\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionMetadata.js\":\"fbb93cdad031ba33\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionRegistry.js\":\"769f8ecbd6d5b9f8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDisplayMode.js\":\"8c9a1e03c17d6fcf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyRowCreation.js\":\"a5b846e6cd6ee942\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySchemaCreation.js\":\"aaf86a7037299eb2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySeeds.js\":\"95aea8fd4377149d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/recentsPage.js\":\"fd0f4544fc350b97\",\"/knowledge-medium/pr-preview/pr-1850/src/data/referenceBlock.js\":\"8797afce5155c268\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rejectedUploads.js\":\"226892c4fc480fdc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/releasePowerSyncConnection.js\":\"04271a8c40da7932\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repo.js\":\"cca141789d9ba88a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repoProvider.js\":\"68b00a64fa598567\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rowProperty.js\":\"a57f7e8179de1fa1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/searchFilter.js\":\"b23838611eff891a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/seedIdentityLedger.js\":\"48599b39ebc400a3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/stateBlocks.js\":\"ff3e7930a353335c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/structuralEditPolicy.js\":\"082b7d1123013937\",\"/knowledge-medium/pr-preview/pr-1850/src/data/subtreeDelete.js\":\"fc66f600b1294d3e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncStreamLock.js\":\"986b8b1ce279ace9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableSqlRecognizer.js\":\"fc0fb5668ee3929d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableWriteGuard.js\":\"7fe65e42470ac737\",\"/knowledge-medium/pr-preview/pr-1850/src/data/targets.js\":\"1765bab20e3e6d9c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeColors.js\":\"9629faf527ecb0ec\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionMetadata.js\":\"9fbc49aa178ab0e5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionRegistry.js\":\"7e99afb55a8e5d83\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeExtraction.js\":\"f9868ba34e3fbb7d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeInitialValues.js\":\"4d135c56992ec498\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typePropertyGroups.js\":\"5215908e6bb9f457\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeSeeds.js\":\"0c9fd966631bd0d9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeTagger.js\":\"37f980ca06d54979\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typedRecords.js\":\"d324f2dd0790dbdf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typesPage.js\":\"1ebebb4494399eaf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userPrefs.js\":\"f1ce79222d9f6079\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userSchemasService.js\":\"8c2b5e4eadefb25e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userTypesService.js\":\"3a54cf8cacadeea5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/valuePresetRegistry.js\":\"3520c37c05dda1e1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/visibleChildren.js\":\"b0802bffd8b98906\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceConversion.js\":\"1891f631c5bdc1ed\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceFirstSync.js\":\"6c5f805dd294bdba\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceIdNamespace.js\":\"06fe378d9e14d2a8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceSchema.js\":\"349831e17d94ba29\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaces.js\":\"204671c8935a6b1e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadLog.js\":\"ad80204b1ed7bd10\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/BlockPasteShellDecorator.js\":\"548efb6940f496e7\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/atTrigger.js\":\"79d5e72b52600aa2\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/autocomplete.js\":\"3b1e48500c410b30\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/codeMirrorExtensions.js\":\"7462fe5c324e8347\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/contentFlush.js\":\"351d8987d1290b14\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/defaultInteractions.js\":\"8a268355b301bc8b\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/editSettleSignal.js\":\"787a08ba2e8333e4\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/insertImage.js\":\"b5226c3d24bd0d20\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceCompletionRange.js\":\"5576563897b532c8\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceTargetTypes.js\":\"ebb28bbd587f0def\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/syntaxContext.js\":\"1dcedd06a7d5c26f\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/triggerMatch.js\":\"49c91e6c0cf1072d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/AppRuntimeProvider.js\":\"cd29dacd79322b2a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/BlockFocusShellDecorator.js\":\"4401fbe03e3846ee\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/ExtensionRenderBoundary.js\":\"5a7b4e05e8623d7c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/PanelContentRecovery.js\":\"664fd81da952fc4b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/apiCatalog.js\":\"03f8e3aefcdb4007\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/approveExtensionHere.js\":\"7efacf492a07f1ca\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/armedCutAppMount.js\":\"24977b177fb6ba40\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/batchableKeyedStore.js\":\"e7dc1b683e195f0d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockInteraction.js\":\"690bc1b6277e87fa\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockSelectionAction.js\":\"cfee81d9ed7e0300\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compileExtensionModule.js\":\"0d32508a90e77088\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compiledModuleCache.js\":\"6ae64ebddd90eb83\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/continuousGestures.js\":\"03441ada1f66fcad\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/core.js\":\"38add06dc4d80bb5\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/defaultRenderers.js\":\"ab8db57ef7a381f3\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/definitionFanoutAppMount.js\":\"5df0e9efbab00955\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dialogAppMount.js\":\"a12b19e95ada4a98\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensionSeeds.js\":\"c6cd4d9f092805cd\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensions.js\":\"112708f4bbf8385f\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/exampleExtensions.js\":\"7e3158bb29df9fe4\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionApprovalStatus.js\":\"648022a498d7eeaf\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrorToast.js\":\"ee77bffa7c60e2f0\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrors.js\":\"13f578b6f48a9c77\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLookup.js\":\"2d862fc6fdeb9fc7\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionToggles.js\":\"4e6e67dbad02e658\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionUtilitiesCss.js\":\"67781720fd0fba39\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/kernelPageDeletionGuard.js\":\"3ef783e507cea47e\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/liveRuntime.js\":\"42f689c3acfe4032\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/openExtensionsSettings.js\":\"c5130eeac06f23ad\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/overridesCache.js\":\"93e4c9e61ee9bb6a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/pluginIds.js\":\"7b9767b3586e91a0\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/processorRejectionToast.js\":\"aa9e9acf0dd6aa2b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeActions.js\":\"80f735f4f46bd424\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeContext.js\":\"8fb7e1175999d223\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticAppExtensions.js\":\"5e31ff7226a293ea\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticDataExtensions.js\":\"0dab937b85a619e9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/toastAppMount.js\":\"49bcee3f4eea7ac0\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useOverrides.js\":\"bf72c890addf83c8\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useShortcutSurfaceActivations.js\":\"4cb549fbbcd10ebb\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/discoverToggleTree.js\":\"13fceaa6be9c4f50\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/facet.js\":\"99e426b9c5ff923a\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/resolveAppRuntime.js\":\"aa5461ece09ef69d\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/runtimeEvents.js\":\"962391e0a53e6f3e\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/togglable.js\":\"c5e657f0c366a290\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/variantFacet.js\":\"4790e5c289d5c8e3\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/verbFacet.js\":\"0654ee2b10af9cb8\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/block.js\":\"c525b9c6bfe025d7\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/focusedChild.js\":\"787a565cdaddf52e\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/propertySchemas.js\":\"2a0c9309372f1eab\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/typeRegistry.js\":\"6e77b4db05a6eb02\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAncestorCrumbs.js\":\"fc5dfef4709039e5\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAutocompleteListbox.js\":\"876d4376216bd97d\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedSearch.js\":\"27ee8fb00c38b390\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedValue.js\":\"904e3399036e6466\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsFocalRender.js\":\"48c9ac0c574b7b20\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsReadOnly.js\":\"2f537222ca261f94\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMaterializeBacklog.js\":\"908dc52566b71b01\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMinuteClock.js\":\"6452804ca058b92d\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePanelLayoutProjection.js\":\"9db91c2d1013e2e7\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePendingInvitations.js\":\"614a47f988cb152a\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRendererRegistry.js\":\"a136a2c52347470b\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRetainedFieldRows.js\":\"e572542315db6aa3\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useWorkspaces.js\":\"47e0cc6729e5bbe8\",\"/knowledge-medium/pr-preview/pr-1850/src/lib/utils.js\":\"ce890b9d7603f3af\",\"/knowledge-medium/pr-preview/pr-1850/src/main.js\":\"4b5599bbc806840a\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/MarkdownImage.js\":\"7e6853c6a78f8d75\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/blockSeparators.js\":\"762760b83331e326\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/context.js\":\"759272e7b40ee725\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/defaultMarkdownExtension.js\":\"3121c92e414a7774\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/extensions.js\":\"6d965e00bcb6d975\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/renderMarkdownHtml.js\":\"abdaf8d19695ecf4\",\"/knowledge-medium/pr-preview/pr-1850/src/minimal-editor.js\":\"992da2a3c9225b17\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/armedCut.js\":\"aa76abf254337cf3\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/captureMediaVerb.js\":\"b80bec8f7276a364\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/clipboard.js\":\"308782bd52945aa6\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/decision.js\":\"e73fab9e1935b971\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/operations.js\":\"210a1d6584c3a715\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/AccountHeaderItem.js\":\"b0e12eea59547e93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/index.js\":\"7fff4a6af521338e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4fda54dc07bbcf90\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askAgent.js\":\"b294cb63fbd55e04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askedStore.js\":\"1d760280169b4941\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9f661e30bfc6a037\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/chipState.js\":\"d8ca9f421389835a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/dataExtension.js\":\"30d071ef83bbf997\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/index.js\":\"45f816cb769c4937\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ea32b6b07e021f26\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/schema.js\":\"ac240e92b532e1e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/AgentTokensDialog.js\":\"eb90ff94518ec655\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/BridgePairingDialog.js\":\"cc0ce0637986df0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/addMedia.js\":\"617e01d4ef343c24\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/backlinks.js\":\"41317f869c160aeb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/block.js\":\"24daa0f81961207c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/context.js\":\"7ce1700eb5357ccd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ed4bf13c2e3fed83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/index.js\":\"cae5d308b70c0c09\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/outline.js\":\"aaa33bbec7ec1c8a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/properties.js\":\"b7d999140f345f90\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/refs.js\":\"eb5fced593cc8c5c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"92eab4ff72ee6a40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/search.js\":\"a9b51b025801888e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/shared.js\":\"8260c03f9e3f0466\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c3bc4c74fd71090c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/text.js\":\"d21fd768edfd9818\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentWrites.js\":\"da2d1b94e91e28a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/authoringCatalog.js\":\"71f9f9272ca8cd18\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/blockRefTargets.js\":\"6b40ba320e6413e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridge.js\":\"2473ae3c7d41b497\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridgeLoop.js\":\"6647a7835b9f40d8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/changeHistory.js\":\"162b6c7fd8d86f68\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commands.js\":\"879db90c802fa907\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commentsCommands.js\":\"754d68a13fe184ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataExtension.js\":\"b25e49682f60e06e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataModelGuide.js\":\"5c56ec24a8e19e1a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/describeRuntime.js\":\"55bf4a18903d9fbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/extensionLint.js\":\"1409f3006753edb1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/grainAudit.js\":\"1fa0d5df549be40d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/healthCommand.js\":\"8e69cf5574e15736\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/index.js\":\"9e9f424a5b62d090\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/presetIdentity.js\":\"f2e09e606b7a595c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"88fd7fdd828d2340\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/readMedia.js\":\"f280eb20ec8226e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/schema.js\":\"b1c01931366c2f67\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/serialization.js\":\"8459aefd839f920c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/targets.js\":\"f5b3bd9ae2916225\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/tokens.js\":\"b510dc06ae3bc455\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/watchEvents.js\":\"5268a527efad2115\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/workspaceGuard.js\":\"a6380f5e40d90b64\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/writeCommands.js\":\"0201bc4a845541b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/AliasCollisionToast.js\":\"5fae85f4d339931d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/DuplicateNameBanner.js\":\"bd3e97a65aed423d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/collisionMerge.js\":\"4a87ce2d80937d58\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/dataExtension.js\":\"903072fdd0fb51c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/index.js\":\"9bb521c2654c238f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/mergeCollisionAction.js\":\"775f966e931fca09\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/pageStyling.js\":\"6ee47111f8542339\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/rejectionToast.js\":\"432d2a5afbe71684\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/syncProcessor.js\":\"6ae64067b409580d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/actions.js\":\"388ae04bf25564db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/addComment.js\":\"2676929a181db00d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchor.js\":\"12a773a2056cdc5d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchorState.js\":\"35f3f09404f1c6b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/commentLinks.js\":\"9721616247350743\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/confirmThreadDeletion.js\":\"02e4ffdba4035836\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/container.js\":\"bdbffb229f9fc9df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/dataExtension.js\":\"abe1d43e973c1217\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/deleteComment.js\":\"4258eb9d256d1d1e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/highlights.js\":\"9c7f9dda0a5faa31\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/index.js\":\"cf8ff8d186bacb05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/linkedCommentsPill.js\":\"ddaa137e68842919\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/margin.js\":\"e7fcee0b6bb344b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/marginSchema.js\":\"c77dc62c7db772e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/newComment.js\":\"d042112660abf263\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ownThreadPicker.js\":\"84c1b0ebd06e5266\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/placement.js\":\"189e13373b680c9c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/queries.js\":\"0ad86d404d7f1db1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotePosition.js\":\"aa4b7cb78633b7ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedIn.js\":\"d55d7306dd33f585\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedRange.js\":\"6e2a677040ccb4aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/rangeRefs.js\":\"a87c3b988c0fed2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readHighlights.js\":\"96f314ef1f6a2e93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelection.js\":\"e213c4dc3f3ed346\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelectionUi.js\":\"a713a61b17fec6cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/reanchor.js\":\"f4d89e6f5edd97ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/schema.js\":\"3dcbdf173c45f930\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scope.js\":\"33123be746e0ed5c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scopeThreads.js\":\"2b6e735fec5818d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/splitRetarget.js\":\"d5c6e358d1d4e57c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestionCard.js\":\"a354f5e5fd28711f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestions.js\":\"6c479e7524c647f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaries.js\":\"efefa397791723f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaryBatch.js\":\"71c8ccbe1ed43e5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/surface.js\":\"3d7854d539fb205c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threadNavigation.js\":\"253e1539ccf9fa08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threads.js\":\"b6df8f9d9f887bf8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ui.js\":\"b3fc57376fa052c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/uiStore.js\":\"294454f5ad78644f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/appIntents.js\":\"4ff5346b89779c46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/index.js\":\"76426eb39a53c076\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/index.js\":\"755e0757740c665d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/status.js\":\"f012107f85d282e8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"76bcd1e2ec4fc5c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaBlockRenderer.js\":\"e201f334e62cffd4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1a9da9c8006d6638\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaUploadReconciler.js\":\"04233fa340495e0d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetDownLane.js\":\"e0a1c2305bfe0caa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetResolver.js\":\"d5e9719b6ad6a059\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetUpload.js\":\"2d24cbcdbf457a7a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/attachmentCleanerIO.js\":\"1935a53d2d161e37\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/supabaseAuditIO.js\":\"296e0ef45ca4e974\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/blobStore.js\":\"d8c5096e46540dd6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/byteStore.js\":\"7ad0efa48c0e83cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanerIO.js\":\"8dff23707883b784\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanupAttachments.js\":\"7ee0d6489727c3d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/dataExtension.js\":\"930420f1729b37b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/downLane.js\":\"9c8c6f6090e62e60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/index.js\":\"af08157c689a82cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/insertImageContribution.js\":\"465217814118e973\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneArming.js\":\"3a9b1ccd67be9e21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneLock.js\":\"33b3775f4898bb78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaBlock.js\":\"ff4c955158243657\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaCapture.js\":\"b00bddf525e09fbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewers.js\":\"d03bb3d5be5f5383\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewersFacet.js\":\"756c84197b7b01ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/pasteCapture.js\":\"fa17506fc377ccbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/resolver.js\":\"c2d6466dd0e8e0d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/retryUploadsAction.js\":\"d0580edbca35fb40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/storagePaths.js\":\"662904b0878a997f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadDrain.js\":\"8ad4001d00ef172a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadLaneStatus.js\":\"a963ff769377c7fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadReconcile.js\":\"b8033b44b0dc2fee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadRecovery.js\":\"48433dc2a14e3d22\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadStore.js\":\"d6434e76e82bd6a9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/useAssetObjectUrl.js\":\"c76500b002badb12\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a1fcfe680cadd9db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5c6ffaa09db03b16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/facet.js\":\"ac732f261b7c5aa4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/index.js\":\"20a0a1f1f6e3a924\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/prop.js\":\"c01b524d3f710f46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinkFilters.js\":\"c89d538c7b27002d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"51f0528aec558c5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BlockEntry.js\":\"87cdaa7a07b230ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/LinkedReferences.js\":\"e109b7bfed487fcf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ee8ca0c7816dee2d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dailyNoteDefaults.js\":\"ce29bd323a8824e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dataExtension.js\":\"c5facc0508a5c5bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/edgeExclusions.js\":\"b8fbb70ffcb6511c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/filterProperty.js\":\"8709cd1d0f7c6952\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/index.js\":\"750a560861432195\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c1b460d7ade5570a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/applies.js\":\"ca09d47b16d438f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/countQuery.js\":\"927938b1b5f0c8c9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9a0523991fbcdd97\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/index.js\":\"31bdc2e65496a854\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ec160f66c9072cba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/presentationInvalidation.js\":\"ea8674e9e408a111\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyEditorOverride.js\":\"365abfb295fad993\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyFilter.js\":\"6680d49f4e8b5ac1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/query.js\":\"7e7e4f5c8b78c9a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/resolveFilter.js\":\"6acb0b72630eadc4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sourceBatch.js\":\"e8b2e279c112ebbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sources.js\":\"142cc8dbda0f2dcc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useBacklinks.js\":\"720db1df2a584a0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ce902eef2155fb48\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayCelebration.js\":\"1d71bd31b2ddf266\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayOverlay.js\":\"b7dc5213063fc36e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/gate.js\":\"602bb3d000e44415\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/index.js\":\"d00f37e710d10599\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/wolfTheme.js\":\"b2e3dc619495a831\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/BlockDragLayer.js\":\"34698d73ffd551c9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dragController.js\":\"b7b055d5209298e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dropTarget.js\":\"ef0c38facd1aea60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/index.js\":\"362a376399d17160\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/projection.js\":\"b704745b1ba45f97\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/BlockMetaCard.js\":\"9d1a67b0ebae1014\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/index.js\":\"11c8ee84b8c0c183\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/AddTagDialog.js\":\"71085b86d178e8a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"84d07f2d71fcd045\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/TagNameIssueHint.js\":\"077bc1d0e23ba3f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/addTagAction.js\":\"705f4bb5edda099a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/appendTag.js\":\"871c2b1159635fb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/config.js\":\"6c9d0e4cd9c8e66b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/dataExtension.js\":\"22e35edc896fd827\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/index.js\":\"c49b76e99836e370\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/propertyEditorOverride.js\":\"3ee5e2c6974c69de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b47f8b475d42d942\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"748c83314fc53111\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9c208ed8eb1c3a3d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"fa9d3e60623ab251\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"da1dc731394a13d8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/index.js\":\"ebc5b1551b791145\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5188a86f76e2202f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/CharacterCountItem.js\":\"0b71f0ad4dd65a62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/ProfilePropertyEditor.js\":\"98cba93d94123fba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/actions.js\":\"66f94c3e5e34206e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/blockType.js\":\"87e1ad94c53b3edd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/charCount.js\":\"11f2c5860249e5a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/dataExtension.js\":\"d96bfa05a2ac4258\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/index.js\":\"770688fd627a8a6a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/profiles.js\":\"4aaaf64757b2e4b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/properties.js\":\"ac4df825a117991e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/textCounts.js\":\"f1f9778fe28c49bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/colemak-keybindings/index.js\":\"eb704de120527101\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/CommandPalette.js\":\"4b4f832b1e7c67d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/HeaderItem.js\":\"5868ae4ccc44f322\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/context.js\":\"1ed25b358bb78c16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/index.js\":\"cbe80fdc910f126c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/selection.js\":\"3e98a01678291134\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/toggleStore.js\":\"d8aabe1e7fb99397\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/useCommandPaletteActions.js\":\"524dffabf2b46036\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/ContributorBadges.js\":\"12bcb600fa050523\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/author.js\":\"6b5b6c98f49cc5f0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/codeMirrorExtensions.js\":\"2a6027ec5eed28c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/dataExtension.js\":\"349f23d1d4392161\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/index.js\":\"1900e7b57c101dd4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/mentionAutocomplete.js\":\"a88fc43388ec8782\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/processor.js\":\"6673c10aca349d82\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/profiles.js\":\"89eaaf61b027469f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/queries.js\":\"873e52a51de75987\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/schema.js\":\"bf151194decde9ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4cc9f8f5e0f88212\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/followOrigin.js\":\"236b19aec1f164a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/index.js\":\"2a34d3f3e544c01a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"40f73efa32986810\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4c6ada154b9e0b74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/CalendarGrid.js\":\"0bd8d802dc29fec3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DailyNotePicker.js\":\"f0f3884675422cef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"fc0cee7a4bdeef9a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateNavDecorator.js\":\"4cea7f02ffc921b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateScrubOverlay.js\":\"0a9fecb2f9ca4bc4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/HeaderItem.js\":\"62417919c3e4ef1f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/ReschedulePicker.js\":\"037b94881144ada6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/SpreadDatesDialog.js\":\"292e2dbb564b73ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/actions.js\":\"71f184e591b655ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/blockDateAdapter.js\":\"7535abe64b2c8d46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/calendar.js\":\"f146e5c70a7ca387\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dailyNotes.js\":\"6cd940733a53f225\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dataExtension.js\":\"d85a47f121bf108a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubActions.js\":\"c1e155d999a4237c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGesture.js\":\"3175ba28db1d41cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3a11ec197a42d6fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4bf7d6d7036e507e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/deletionGuard.js\":\"4dd149f7766106ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dueQuery.js\":\"bba466a3500116bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/index.js\":\"5f4e8ec62fa39daf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/landing.js\":\"b4749580eebe969d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/localSchema.js\":\"64b824294922339e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/referenceDateAdapter.js\":\"976193e5b2bcc317\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/rescheduleAction.js\":\"227126fef4a660a9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/schema.js\":\"5ae4e71c020c0595\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadBlockDates.js\":\"96f2b40076e699d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadDatesAction.js\":\"886817d7e68e989a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/today.js\":\"ad6288fefdab9440\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"14e3b47c507cf3f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"733570bc9219042f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/audit.js\":\"fa5dcbb9822420d9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditAction.js\":\"eb4bd2ae197b09ce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditRanges.js\":\"388d80a8deb2860b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/diagnosticsSource.js\":\"1888aac1c985308c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/divergenceScan.js\":\"dd10355f6eeffe17\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/index.js\":\"55cdc2070274e8d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2f9918e31a8a204d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/referencesMirror.js\":\"f6223ac599c8bb71\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/rowJson.js\":\"08391ed587536209\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/schedule.js\":\"b223d0ba8b74b37e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/store.js\":\"73dbb2bf114caf08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/action.js\":\"6211b8794b9ff20c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/index.js\":\"c505f6ea6a704f48\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/plugin.js\":\"b463e140d0ee9fad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"cbc645f7713e9e7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/actions.js\":\"be4e53d5dc8f1adb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/changeMarker.js\":\"b2b24dcc7d948039\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/diagnostics.js\":\"264906ebc3aab027\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/fileSystemAccess.js\":\"ccf1bfceccfe86f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/filenames.js\":\"1f166f63e93669b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/index.js\":\"f899421059a26618\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/mirror.js\":\"038effe2a8385a28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runLock.js\":\"67657f202635c4dc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runtimeHealth.js\":\"415bd795a0516714\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/schedule.js\":\"3388735b9065c443\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/store.js\":\"5fd052abb38afcd0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/index.js\":\"e698d6099cd92a40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/themes.js\":\"7863f6d2e82c23c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/facet.js\":\"64bb1d2805fc3f2e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/useDiagnostics.js\":\"fd2a376e7f459b78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/dismissals.js\":\"52716522b86f7644\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/index.js\":\"0b81dbc118ce9e9c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/status.js\":\"75e7c26b1b9d0df9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/store.js\":\"908371f70c382ad1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5635b27e66758ca4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8f7a22f5636a48d8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/actions.js\":\"f94d345058019297\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/config.js\":\"fa00eef8a611c273\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/dataExtension.js\":\"832ca741d6af2e89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/effect.js\":\"189eb840a95b74df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/index.js\":\"3f28bacf80f0540a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/propertyEditorOverride.js\":\"25a20751bfcd999c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/useToggleTree.js\":\"44af51a6d75565f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/ExtractTypeDialog.js\":\"76c307e0be94f4af\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"05306da1fb559f73\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/PropertyShapePicker.js\":\"937e2fb92d1de5ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/action.js\":\"1f5f9659cd04fafa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/index.js\":\"ab823dbe23b6b536\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/FindReplaceDialog.js\":\"8e67bb7ebcfe316c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/HeaderItem.js\":\"481b8b7c3c01383a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/dataExtension.js\":\"93653235665a23c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/index.js\":\"5f3b074b5742bb02\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/search.js\":\"a3afcca02cc83a59\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/toggleStore.js\":\"094dd9b89cc4ae10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/LocationPropertyEditor.js\":\"7daef0b7ba5e8888\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/MapView.js\":\"25673dfc1b3b44fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/blockTypes.js\":\"61e55f8dc46e2da4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/codeMirrorExtensions.js\":\"90dea87a1ec5ea93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/createOrFindPlace.js\":\"bbc145ed5a81e3cc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/currentLocation.js\":\"0cc71d837c5f731c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/dataExtension.js\":\"57b685379dfcd5ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/geoContentDecorator.js\":\"ac1d1fd7503a561e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/googlePlacesClient.js\":\"e60f6eb59959232f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/index.js\":\"64356cbd44a1daf0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/locationsPage.js\":\"dba61e3f5b36fe05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/mapViewport.js\":\"c0a89c4414408dc3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/pickCurrentLocation.js\":\"9d09789c8bfd40a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeAutocomplete.js\":\"d57128d07f908d74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeNameCollision.js\":\"826ea65d872dc78e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/properties.js\":\"e70d3b0446883421\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/propertyEditorOverrides.js\":\"97c2f65bceedae66\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/query.js\":\"02c8158bf353fbde\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/usePlaceSearch.js\":\"8d03a13261c9e78e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a09ca0b00709ebbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7f434dea5a4bde1a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"eb7fb9a133e29ccb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/config.js\":\"11b699a81ad3337f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/dataExtension.js\":\"9ca6cb3ae1080032\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/facet.js\":\"ce41af2b7a880251\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/grouping.js\":\"0ee63ecae3f9f1cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/index.js\":\"0bdd4eaae068099d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"29a7446b5ea74c71\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/query.js\":\"cd4b2bfeccbd3379\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/resolveConfig.js\":\"7e6f62fbb51aa292\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a0e86feace6570c3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c7cfda01a9613a7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlDocumentContent.js\":\"04119e9f6d43ef5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlFrame.js\":\"5ecfb045cee824ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/actions.js\":\"f0753fb563988764\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/blockType.js\":\"7ce31ebefa94ef61\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/confirmRunScripts.js\":\"5c22e4ae5d436074\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/dataExtension.js\":\"c4b2453077fff921\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameAnnotations.js\":\"8c4e04090b5bd45c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameDocument.js\":\"2e8f9b46598b70ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameTheme.js\":\"2dd070aa8105a1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/index.js\":\"9b6c227966438b16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/scriptConsent.js\":\"b9a44090a54da75e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/sourceMap.js\":\"96bacfbec52389ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/useDocumentScripts.js\":\"6a4c7b264a98943d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/index.js\":\"2bf5e59dc2ac6864\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/record.js\":\"d98754a325a93349\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/recordStore.js\":\"81b580edcabd8f72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/responsiveness.js\":\"0c176f3e401c18b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/schedule.js\":\"d963d8df59cc635e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/sessionContext.js\":\"ab8f9af081a95ab6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"40d5bc64f0214bbd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"93935329f07e7fa7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/actions.js\":\"66961b95cd93c222\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/config.js\":\"9f82c8674581db58\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/dataExtension.js\":\"b5fd9e51c1ab9315\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/effect.js\":\"a2f2190b64e99f80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/index.js\":\"0bcf0ff947d63d08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/keyCapture.js\":\"4d39b8a4302e1f50\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/overrideStore.js\":\"ae8fbfc6cd038688\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"7e0d569884f53d59\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/HeaderItem.js\":\"b5982d8863acb01e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/LeftSidebar.js\":\"683a2e1f40eb9bd3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/actions.js\":\"5b22428fe07360cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/facet.js\":\"65178ccc4fa872fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/index.js\":\"73f6459eae42eb54\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/shortcuts.js\":\"52d86f4f6d4a1bbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/toggleStore.js\":\"f2ab73b973a5cc75\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/MergePicker.js\":\"402bc7f8027e2445\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/index.js\":\"ca0064d0f114c184\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/mergeAction.js\":\"d66571a726b9c94f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/strategy.js\":\"9ccdf06a8db9b650\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/Button.js\":\"770e783f773ce887\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"bc42d6bd886888ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4c77d775f389f9c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/facet.js\":\"f20c5f0ca315b500\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/index.js\":\"95733095137232b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e7eea6f8a34c9cb2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/actions.js\":\"74c5eb7944b738a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f5923134af1abb3a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d55d23794a8f91d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/index.js\":\"10e1104ad85bd279\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b98cf061aa3359bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4066511935b9b3ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/contextMenuItem.js\":\"85757f2eeef45fa3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/index.js\":\"94120a692b935d62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveAction.js\":\"918644153849e041\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveBlocks.js\":\"73de36dcec0ef408\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/selectionAfterMove.js\":\"f072b860fc96e78c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/TutorialBanner.js\":\"e81bb5cc8c9332a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/action.js\":\"ec132cb5b2d105b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/bannerDismissal.js\":\"5cb11827d33d1ccb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/documents/cheatSheet.js\":\"fe551bc0e03e6759\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/index.js\":\"7bfeddffde8c9ba7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/keys.js\":\"21886a8165cca0b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/landing.js\":\"7f9bf6da31905b02\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/outline.js\":\"0aa48e899163cd2e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/seed.js\":\"77ea3d08dcfc66a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1f008e2ea9a86cc0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/analyze.js\":\"c59cc7f218f21bd6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/diagnosticsSource.js\":\"b09c4f951972e379\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/index.js\":\"6a2474be25eb3139\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/load.js\":\"83c768d511d8fd06\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/monitorRun.js\":\"5bab5727a7f06ea1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/schedule.js\":\"7ea0820bf96c37cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/series.js\":\"971bdd4f8f3897ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/store.js\":\"1b0dc909fcbdfbd2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/trendAction.js\":\"b85e0a7d40b582dc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/verdict.js\":\"9b6da9750d526a74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/clickToEditAction.js\":\"5a2fc1f2373f837c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/index.js\":\"5b6caa469a0d75ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/interactions.js\":\"33d7501af7f85096\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4ceda0c391bfffe9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGate.js\":\"c7301dfa1df1276b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGateDialog.js\":\"a8e0ebdd93ad2a8d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/action.js\":\"440ced39f7be2f85\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/index.js\":\"ac801467e4f3d884\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/localRunMessage.js\":\"5d091279cfe394d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/plugin.js\":\"94173806131a1497\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/progressReport.js\":\"0a636d77c69e309b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/sweepProgress.js\":\"20b36e4533e5b03b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/FieldRowRenderer.js\":\"c7a9d492c7ad7cbe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/ValueRowRenderer.js\":\"46eb76f5b4ac9cb1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/actions.js\":\"9102d1ec8de56ea7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/autocomplete.js\":\"b2b821eb8c921538\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/fieldRow.js\":\"c1003aa244fa5c30\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/index.js\":\"c69adbb3c004a6e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/referenceWarning.js\":\"f3c6f7dba00a6c70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueAutocomplete.js\":\"c1f45e45d392e03b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueSchema.js\":\"6bf107d9940fab47\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/HeaderItem.js\":\"1175c85f886e9ccd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/QuickFind.js\":\"e02f30d8f1b8f1d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/index.js\":\"b41af4eea1619b84\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/recents.js\":\"68fcee24db2aade3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/resultItems.js\":\"a404a1d4bef74cc9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/selection.js\":\"2fb50e4a5471784d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/toggleStore.js\":\"82d6dd55bfd6ccc4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/HeaderItem.js\":\"bb39b798ec597ae1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/RecentsPageBlockRenderer.js\":\"88afdbfc6086fcce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/grouping.js\":\"40a3eeb9c872930f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/index.js\":\"6c4ff7a59c301460\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/target.js\":\"7830383bbc66f128\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/codeMirrorExtensions.js\":\"7657dbc4534a3853\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/contentPrefill.js\":\"e38555ea634ae9de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/dataExtension.js\":\"7a1b40a5f12c8e04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/index.js\":\"c14006c468ff880f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cbe3473001ba5a0f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/invalidation.js\":\"708cecc3268fb46f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/localSchema.js\":\"cd13d7b4816072f0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/index.js\":\"98a1a5387705f521\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ee4ec7f95d4b2955\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/index.js\":\"ecedad3b61012912\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/referenceNode.js\":\"986eb09e8dfad0ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/remark-reference-occurrences.js\":\"887331430ba8b792\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ee37998729d47e2c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/index.js\":\"c7af3bf32eeae4f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"af4c5d38c28aa9d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"0c6bf1637dda0a5c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/mergeRetargetProcessor.js\":\"c99486a77094dedd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/parseFence.js\":\"5219788bc845c08c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceParser.js\":\"303b6a688b5bc0b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceProjection.js\":\"438d7fccad29da76\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referencesProcessor.js\":\"4a49f697160ca3fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/renameProcessor.js\":\"7b08ae9419fc7df5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/spanReplacement.js\":\"d9125b123f18332a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/htmlToOutline.js\":\"bcc6792148e3b094\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/index.js\":\"ed001ab02e48d440\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7c06b7ec5143eb80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/pasteDecision.js\":\"fee3b9c938baa4a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/action.js\":\"ecf8f2ae68de639d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/blockIds.js\":\"ccece5bdaaf38b64\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/content.js\":\"ae75fccc7de27f51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/effect.js\":\"76c31cfe0993ffe6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/ids.js\":\"8ea9004d088bd778\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/import.js\":\"52fc8ba6a6582c10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/index.js\":\"56564712fcdb9bf1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plan.js\":\"712705358337cf6f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plugin.js\":\"93e1be9a757cb3d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/promotion.js\":\"a398c367afe1d83e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/properties.js\":\"cf7175a9e921f0b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/references.js\":\"6286426a5bbc94e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/report.js\":\"cd2ce407d6ba10ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/roamMemo.js\":\"f5324d6a89c34329\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/runtime.js\":\"374e25b5dbcea835\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/schemaReconciliation.js\":\"b460669aebf57c39\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/srsMarkers.js\":\"8a3ec866c0faa02f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/todo.js\":\"f05a40507c7b1d73\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/typeCandidates.js\":\"f1bd32437e9e0e60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/types.js\":\"57670e8153332629\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/index.js\":\"94cdb24afbfc5b26\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/store.js\":\"d90fb3f598de9e5b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/HeaderItem.js\":\"9453e8b2f2c9ad22\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3534f35bedcdd283\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/index.js\":\"fee7d61bfbc6cff7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/model.js\":\"8465ede168936126\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/toggleStore.js\":\"498958c0c6080ffb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/useKeyInspector.js\":\"ac9a0e8591d0402e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3351f5e005c974ce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/ShellDecorator.js\":\"6bbc1d755bcc8917\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/actions.js\":\"9c3e9b993f4fc0f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/exclusionsFacet.js\":\"297027e0152092ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/index.js\":\"025e28e5f8d1e572\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/shell.js\":\"0641e60fd4eca295\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/surface.js\":\"5d3e4f32f9f65615\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/walker.js\":\"09be0d7bbc11cb03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ad94399394fa154e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/dataExtension.js\":\"39c6548c27c0a63e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/index.js\":\"fe5a9fba325e7965\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/indicator.js\":\"e55d8dca245c15a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/moveSrsState.js\":\"838a08d6b603d0cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c76462255ad2cd91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/scheduler.js\":\"f7ddc2216411b322\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/schema.js\":\"aaf59fa35ba2b90f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"523515eca4ba82bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsClipboard.js\":\"d3763d9087ae3837\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bc6eefb9ed53db4a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f0d703cf383c32d9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DeckPicker.js\":\"9f7ba870f622c6df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewControls.js\":\"2caedb3519c122fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1e92631a781e145a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewSession.js\":\"7d770c885de32bb4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/actions.js\":\"4eabcb4511ab3fcc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/archive.js\":\"8f472cc7de83d00c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dataExtension.js\":\"8ea0947632e8a248\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/deck.js\":\"8dc2919bfc070fab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dueQuery.js\":\"f8707a164729ea86\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/gradeDecision.js\":\"f7660f1318d0bc75\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/index.js\":\"b8c5abc38d407666\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/keyHints.js\":\"a12158632fc59f05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewCardLayout.js\":\"8a14f132b7bbe7bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewProgress.js\":\"ba5450529907f935\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/schema.js\":\"e666d394e480ec59\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/useDueCards.js\":\"02736a49cc13c005\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/index.js\":\"860814b9d8f21554\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/record.js\":\"942143acd7baa0cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/index.js\":\"df4e21f79a4008fe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/persistenceStatus.js\":\"7e1c5a9b9c867b76\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/requestAction.js\":\"42ef77cbeee0ae1c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/TypeChipsDecorator.js\":\"6fb0a8df46fa79c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/codeMirrorExtensions.js\":\"53b51938117add46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/index.js\":\"cb7842c4ccf2a3c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/typeAutocomplete.js\":\"053ad49b8dc20311\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"5edc434e54e817c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/actions.js\":\"35d631321a24d66c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/anchor.js\":\"bfa9fc81de7ab973\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/events.js\":\"7aaf9939acb5811e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/gestureActions.js\":\"8b5c90e1a9c53f0b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/index.js\":\"6575de705fb64284\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"69012ea90495a4c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/collect.js\":\"0d1126c2d80fcaa1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/index.js\":\"9788cd3c42403094\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/record.js\":\"29b89a32707b9006\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/RejectionDialog.js\":\"b3190cd202dffc46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/SystemStatusHeaderItem.js\":\"395b256a2f48abb5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/index.js\":\"7f1e268e6519fc6a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/model.js\":\"a181448c85a22be6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/queueCounts.js\":\"4f1920ef7b1dca91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rejectedHelpers.js\":\"ac260cc9ec5085e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rematerializeAction.js\":\"5b82426fcd8d6a0f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/useHysteresis.js\":\"91f747df1405cbbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/ColumnHeaders.js\":\"ac6d751e0c9a3acf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/QueryUi.js\":\"b4be6accee52742f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/TableLayout.js\":\"ceb492871d7ca2da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/actions.js\":\"4177745eb855295b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/cellEdits.js\":\"d60b49647da2cf55\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/columns.js\":\"214c73f4ad201727\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/controller.js\":\"a44fc573421b6f91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/convert.js\":\"bbc1ce9454a65768\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/dataExtension.js\":\"d2eb5ef5cc8b95fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/index.js\":\"d57657ff5bc919b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/keys.js\":\"d5fff9a5621cab93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/model.js\":\"5bf5fa2bf1c8bc15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/backfill.js\":\"9b0b17d98ec22390\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/format.js\":\"fb0069f1df872e6b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/parse.js\":\"00be36e95f888321\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/queryValue.js\":\"852014dbd41bf2a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/source.js\":\"d9d0f1fa572c78a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/registry.js\":\"8d0d6751fe00f56c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowGutter.js\":\"c63ba4d3dfdcc2da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowVerbs.js\":\"6a1d2c2658400eda\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/schema.js\":\"51f8874aecfa1994\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/sort.js\":\"c5fb384219de8a42\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/effect.js\":\"87f1a7bf739e81de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/index.js\":\"bf20f07030fd2105\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/theme.js\":\"d8c78366e9f5762a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/actions.js\":\"fa31379a4300e210\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/dataExtension.js\":\"9fcd492fb4c87717\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/index.js\":\"8997216e8fc98908\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/schema.js\":\"a331ea922f1bb034\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/TouchSelectionLayer.js\":\"cffa7abb88e42f94\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/actions.js\":\"25363c548eebdae0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/defaultItems.js\":\"0840154680965369\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/facet.js\":\"9b0042b7f55bce51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/holdRecognizer.js\":\"5ddba7bbda060269\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/index.js\":\"e043199bb1aa0886\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/UpdateIndicator.js\":\"8e6bd1664d913e71\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/index.js\":\"a55e9b450dcf3e1b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/loadTimes.js\":\"14537ef0aa90eb7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoNotesRenderer.js\":\"79a932da72e83cd8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoPlayerRenderer.js\":\"a45d0b8eccc2a0e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoTimeStamp.js\":\"4fd094a9f3597e05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/actions.js\":\"a334bee9f0da3439\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/index.js\":\"264de5656de2dbe2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/markdown.js\":\"64311771dac39252\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/notes.js\":\"148c08fdfbece152\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/registry.js\":\"1a06c4b98643a2ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/remark-timestamps.js\":\"535688860fb3394b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/view.js\":\"12a9824e9106b14e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/LinkHints.js\":\"a2730332fff5d61e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/index.js\":\"d1cdd70b0c9697d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/model.js\":\"900df7db732f3c92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/settings.js\":\"4607f094c964be15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/actions.js\":\"e29f4605d61a530e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/index.js\":\"c261fae4a8611330\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/interactions.js\":\"bc39ce953df37837\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/workspace-header/index.js\":\"72f5d4abe2177fad\",\"/knowledge-medium/pr-preview/pr-1850/src/registerServiceWorker.js\":\"3f72f265fdda187b\",\"/knowledge-medium/pr-preview/pr-1850/src/requestPersistentStorage.js\":\"54892b9c5b9fe658\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authRequestDeadline.js\":\"264b9f0e1e30b4de\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authStorage.js\":\"dbdd42af126fde3c\",\"/knowledge-medium/pr-preview/pr-1850/src/services/powersync.js\":\"cf3b9d7ca5758211\",\"/knowledge-medium/pr-preview/pr-1850/src/services/supabase.js\":\"2847eec31871ed6e\",\"/knowledge-medium/pr-preview/pr-1850/src/services/uploadErrorClassifier.js\":\"22cae0c2c8c9c866\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/ActiveContexts.js\":\"d784041070d1fac5\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/HotkeyReconciler.js\":\"cbb796dcea3f1d6c\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/WipeLocalDataDialog.js\":\"2daa9e9ca5b97e94\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionDispatch.js\":\"e69ececa66cf9322\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionRefItems.js\":\"36f76da39615b12a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/applyKeybindingOverrides.js\":\"bb5a1ce6c90ef293\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockActions.js\":\"b017bcb134b78651\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/canonicalizeChord.js\":\"329529fff7d66c3a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultContexts.js\":\"dd7c91caaa5cf606\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultShortcuts.js\":\"8c2d7bbf45a983b5\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/effectiveActions.js\":\"39e8bcf30b3c4ac5\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureAction.js\":\"0fd922dfc8ea81d0\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureBinding.js\":\"39f12bfd237cf0f9\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/holdRegistry.js\":\"ca054d2d3cffb95d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingConflicts.js\":\"028f04fa28a3006a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingOverrides.js\":\"913dca48b440c2e3\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/pointerAction.js\":\"02110abce51ae287\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/resolve.js\":\"0a50dbdc49cbe502\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/runAction.js\":\"3f37808afd6dece3\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/sequenceMatcher.js\":\"ad924b46d33e2813\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/types.js\":\"619fb7f77af0c681\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionContext.js\":\"9427d5c116d39355\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionDiscovery.js\":\"90071a8094be1fe3\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/utils.js\":\"74123717ff30fdb3\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/bootStore.js\":\"9a57866a4469b67a\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/previewDatabases.js\":\"913cdd4307613fe4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/byteTransform.js\":\"5bc78618483b4d8c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/attachmentCleaner.js\":\"df58dc56b8e14684\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/attachmentParts.js\":\"ed2152e7654d5060\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleParts.js\":\"af515c0a78dca6ba\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleRecord.js\":\"276f884ac2337204\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/manifest.js\":\"9931e89bd226da97\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/takeBundle.js\":\"ac5295acc35ca5e5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/verifyBundle.js\":\"95ede624a4618563\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/cleaningStage.js\":\"e1a3c6a383b46343\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionKey.js\":\"bcdbd60b9be4ee28\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionServer.js\":\"10acb2130d908692\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flip.js\":\"6cf533c000a0f0c7\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flipAttempts.js\":\"7f768f0f05882e13\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/pages.js\":\"24667e5ec2c053b3\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/preflight.js\":\"7e68a1b5af1a6529\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/reseal.js\":\"080612e2b16edc63\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runConversion.js\":\"dee514818f4ae66a\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runLock.js\":\"166b61b393a727da\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealing.js\":\"da10cb9d49eb68c2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealingStage.js\":\"79e649641b42bfd2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/stage.js\":\"a78c3900848a40b6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/verifyReseal.js\":\"2965886c22bb110e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aad.js\":\"6c2a75f45139902f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aead.js\":\"c52dc293b611877d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base32.js\":\"df484748428417f0\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base64url.js\":\"946bb38e502018ef\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/binaryEnvelope.js\":\"35e1da217955a0e5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/byteAead.js\":\"c17b51521d39d221\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/canary.js\":\"97eead18252f421c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentHash.js\":\"5ec3017b2dcdd202\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentKey.js\":\"bc552aa4f9fbcb9b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/derivedIdNamespace.js\":\"692f47223954cd13\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/envelope.js\":\"7428c9a480330aef\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/hex.js\":\"ceefa3bfd5c31523\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/sha256Hex.js\":\"5ea2300f6abed1cd\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/workspaceKey.js\":\"2bede80eb7a98d8a\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/conversionState.js\":\"1cbc6f378ea8cda9\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9a1ac905e2547712\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/pastedKey.js\":\"be3cb61e59c2a692\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2e74ae0202974fed\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/upgradeWorkspacePin.js\":\"4129e8da9301d185\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/keyStore.js\":\"2f22aace066ba3d8\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/mintWorkspaceKey.js\":\"d76f16df364fefc6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/modePin.js\":\"9ca4dd5db950b829\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/openWorkspaceKeys.js\":\"ea71e7725acadbc4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolveWorkspaceEntry.js\":\"a0ddfe2eb5253194\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolver.js\":\"4d362dd36a255967\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/workspaceAccess.js\":\"4a5247da26defe98\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/transform.js\":\"dfb9d7a17a75dd83\",\"/knowledge-medium/pr-preview/pr-1850/src/themeBootDefaults.js\":\"78f1c9b21639a644\",\"/knowledge-medium/pr-preview/pr-1850/src/types.js\":\"b5d4b501cc403d0b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/ClientLocalSettings.js\":\"0d31ee256e7149f0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/abortableSleep.js\":\"e0c671a08b5fa0c7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/array.js\":\"803f754298fa8c16\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/backlinkAutocomplete.js\":\"cb72e61015b60da0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockCrumbs.js\":\"d091f3c3fe7188f1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockrefAutocomplete.js\":\"e2d4fb65759c1b7a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/cadencedIdleJob.js\":\"1889706cf819f491\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/callbackSet.js\":\"e3bf777b94babce9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/clientId.js\":\"c706c7e4bbb9b99e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirror.js\":\"bb159c1368dbdbf2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirrorCompletion.js\":\"e84ff3b954f9f26c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/copy.js\":\"638dd6190ae8329c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dailyPage.js\":\"5111548dd04a2853\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensics.js\":\"45b2f3f96d313fec\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensicsHooks.js\":\"f24b9784af4bf93d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/deleteBlockThroughUi.js\":\"4c871ac41dae9b80\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dialogs.js\":\"a58e67b667e0e8cf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dom.js\":\"cf9d6ac36f3d0108\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/downloadBlob.js\":\"16d90c510be5dbcc\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/exportSqliteDb.js\":\"301c16712511dc4d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fileSystemAccess.js\":\"df109bbe9d97c39d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/flipSlide.js\":\"d4d1f95c724895ca\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fnv1a.js\":\"4e5b56e715b3dc75\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/formatBytes.js\":\"1d87d9e208b2ce1e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fuzzyRank.js\":\"2505bdd18e4c66d6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idbKeyedStore.js\":\"bb9ea751304d2b00\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idleCallbackPolyfill.js\":\"13ea481d206621f4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardAwareScroll.js\":\"ba30f9bb24cef4fd\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardViewport.js\":\"a2a82361639a79de\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/lastWorkspace.js\":\"474ca3d6ffee0b3a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutColumns.js\":\"706089d1d7e0b634\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionDom.js\":\"1301f39455d5861d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionId.js\":\"177634317e79850a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkClickGestures.js\":\"ad6d061db1667d64\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkTargetAutocomplete.js\":\"3d91d803e62a244a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbCorruption.js\":\"bbba248872206bd8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbRecovery.js\":\"e764ffa06f588b1f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/markdownParser.js\":\"eb91cc4944c06ac4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/memoize.js\":\"23c46f891bf1075a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameFieldCommit.js\":\"962f1d6c9cda7d50\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameList.js\":\"c8f29ee42d02d4d5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/navigation.js\":\"b52a0299e982baa8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/omnilinerNamespace.js\":\"ce99b425787d873c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/opfsPageScan.js\":\"a4baa10d00e676f3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelClearance.js\":\"2c55d1463e060a2d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelHistory.js\":\"2bd54a978ae97ce2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLanes.js\":\"ef33349e579d639e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLayoutProjection.js\":\"1586dfd091df9a90\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelScrollAnchor.js\":\"b08e1c8b559a935a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelUrlFlags.js\":\"071884c554750d25\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/platform.js\":\"517430ab29a3a6ce\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/pluralize.js\":\"c3891a3d3e754700\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyCreation.js\":\"b15c5a409670a53a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyNavigation.js\":\"3dfdefb5db26680e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyValueContext.js\":\"ccfb92479e40e511\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/react.js\":\"e594f63c403cdf0a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeDate.js\":\"c49937ba1516221a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeTime.js\":\"56b7473d6fb1c7ad\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/renderScope.js\":\"177ae216f94dafd3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/resolvedThenable.js\":\"df7ce58d39bda834\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/routing.js\":\"375a0eb6a3e5ada8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/safeMode.js\":\"669b18a0ce9761c3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/scheduleIdle.js\":\"99df898eee375f07\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/screenWakeLock.js\":\"5fdbd76b655d85e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/selection.js\":\"30a66e487ba0f380\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/softKeyboardGrab.js\":\"179eae0e8d77a085\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/startupTimeline.js\":\"d5a7280f065e0aa6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/state.js\":\"aa807edf29fc1001\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/string.js\":\"39d5edfedbcb398d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/surfaceZoom.js\":\"3b79cf390edb12b4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/time.js\":\"abbcd9523959ae12\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toast.js\":\"d71a18e82799aea5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toggleStore.js\":\"40594a62e7e384cb\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/untilStopped.js\":\"aea535ed5cdf6978\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/userActivity.js\":\"e43e3836cf116e89\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewTransition.js\":\"7c48bc33fa16b250\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewport.js\":\"28e86421c301abbf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/webLock.js\":\"41cfbfd9fb129ab2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceRecovery.js\":\"d2f507bc550d09b4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceSnapshotStore.js\":\"9cb0c4b555a1ff5e\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-compiler-runtime.js\":\"5e464b26febae484\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-client.js\":\"0354f8422fd88c39\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server-edge.js\":\"5f7f3f674006c74b\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server.js\":\"f2627568409f67c8\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static-edge.js\":\"a443d5dc0bd6e008\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static.js\":\"3c1d05e35653282d\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-test-utils.js\":\"395b07a5f1218a3b\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom.js\":\"9ef1a77e0006eeab\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-runtime.js\":\"e0c7f2023bed864c\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react.js\":\"286340ba5f46d880\",\"/knowledge-medium/pr-preview/pr-1850/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
