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
		buildId: "e470edb757e9-f8df4e95",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/\":\"6419becdc8ae0ad4\",\"/knowledge-medium/pr-preview/pr-1850/index.html\":\"6419becdc8ae0ad4\",\"/knowledge-medium/pr-preview/pr-1850/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1850/assets/FacadeVFS-C3YaxVH5.js\":\"c0df8189857b81d6\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSCoopSyncVFS-B4MHOhJZ.js\":\"41a5843bf3786b10\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSWriteAheadVFS-Bnpvgrdn.js\":\"aaafb46dbe1fabd2\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-C0f-xGTU.js\":\"723f0a1c012357db\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-Djlkx6W6.js\":\"9574ac053ba011f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/worker-CDPWNcV9.js\":\"300a17428e4a5990\",\"/knowledge-medium/pr-preview/pr-1850/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1850/chunks/app-w4KX0ukw.js\":\"e0f1fb00f5307c90\",\"/knowledge-medium/pr-preview/pr-1850/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1850/index.js\":\"8d7b089b4c83a95d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1850/assets/AccessHandlePoolVFS-CjsnhIX7.js\":\"049857fa6c2c8ce7\",\"/knowledge-medium/pr-preview/pr-1850/assets/IDBBatchAtomicVFS-Bd8YX9nf.js\":\"b4044f5239497377\",\"/knowledge-medium/pr-preview/pr-1850/assets/MemoryVFS-B8T71J8j.js\":\"0dcdbc69f987e47b\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-DgeMTr2L.js\":\"c54753da65c0c565\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-DKE1_okS.js\":\"a8a5c5e8e98a84cb\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1850/chunks/AccessHandlePoolVFS-EQ59W4qu.js\":\"082222ff1bb61b5f\",\"/knowledge-medium/pr-preview/pr-1850/chunks/FacadeVFS-CUl-_KZ4.js\":\"3113e5f7c491bb8a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/IDBBatchAtomicVFS-CkeGkWCP.js\":\"e43ecf8d930315e3\",\"/knowledge-medium/pr-preview/pr-1850/chunks/MemoryVFS-DpqCpkTa.js\":\"f3db7832a54b64b1\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSCoopSyncVFS-DYOcTWDN.js\":\"38a8eee5c1d194b0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSWriteAheadVFS-B7AHuBSy.js\":\"b0d5e5e9be02973d\",\"/knowledge-medium/pr-preview/pr-1850/chunks/Preview-Br2uF3wG.js\":\"a09627d248445fbc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/card-Deyln2aa.js\":\"9a52e33fcc44f321\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-CIwbxi3Z.js\":\"23b1e548e43b1bec\",\"/knowledge-medium/pr-preview/pr-1850/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-3XaDUhkh.js\":\"bda9bc9ec18249b0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-async-CbRt5IV5.js\":\"924f2a0a8ccb7fb2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react--flHTQ2B.js\":\"6815d184424d985e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CSK8R0tq.js\":\"4161839a2c65d913\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CWQq3z__.js\":\"6b29695bc26ebe84\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CjAdzvdi.js\":\"cfd2e5017f38d21d\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CotV-wZ4.js\":\"a67d83e13e42a126\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-DI1KOY8s.js\":\"6aeb4f8943a589f3\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-OBBInXZE.js\":\"dd26b35522106048\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server-legacy.browser.production-V1TZRyyT.js\":\"36637d89225e948b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.browser.production-DSNE0ZTh.js\":\"5746614627b33d3b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.edge.production-7he_P7HT.js\":\"9d6b79aaaa9bc4a6\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-jGUdnB35.js\":\"fdfde9b96da00bd1\",\"/knowledge-medium/pr-preview/pr-1850/chunks/server.browser-CMB6XfbT.js\":\"34aa0aaed841a4d9\",\"/knowledge-medium/pr-preview/pr-1850/chunks/textarea-DWSx1X6f.js\":\"1cb9591d85ddc1f9\",\"/knowledge-medium/pr-preview/pr-1850/chunks/ui-31pVbSAj.js\":\"e8cccb406677dd56\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-CKYkn7lL.js\":\"61af9430e5900fcb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-async-CTvqRNLY.js\":\"4918cebd32c5c0df\",\"/knowledge-medium/pr-preview/pr-1850/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1850/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/src/App.js\":\"c9c44f620ccf8142\",\"/knowledge-medium/pr-preview/pr-1850/src/appUpdate.js\":\"b62b8201b7777ba2\",\"/knowledge-medium/pr-preview/pr-1850/src/appVersion.js\":\"0c2433c464239965\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/initialLayout.js\":\"065e1e92cd1d6538\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/openWorkspaceData.js\":\"40c8e601af4cc38b\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/resolveWorkspace.js\":\"0afe8ea4d20c8fcf\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/workspaceBootstrap.js\":\"3d3f46e944261d67\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockComponent.js\":\"a0ec9954a6e8ebf3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockCrumbs.js\":\"475d2499c7d97e44\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockEditor.js\":\"00ec9e7792e5e8ac\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockLoadingPlaceholder.js\":\"711251110bda0a7b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockProperties.js\":\"e03f9efeb27a2844\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockSearchPicker.js\":\"0f5295dd2aa2368c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ConfirmBulkDeleteDialog.js\":\"ba2e8b1f7eee78a8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DividerHandle.js\":\"917e02c978f9d56f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DraftEditor.js\":\"f92e6dbdc68e67af\",\"/knowledge-medium/pr-preview/pr-1850/src/components/GutterPill.js\":\"1c7a4108b6489c0b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Header.js\":\"d2e16c93f30eaea2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/LazyBlockComponent.js\":\"58f096281beb462d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Login.js\":\"e6978ca40ec7aed3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ZoomableSurface.js\":\"f64133ed079af98b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/editModeKeepalive.js\":\"74377349654ed55d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyDisplay/PropertyDisplayScope.js\":\"00abdb66a7aaddb7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f0e5f9a4ce23f3fd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefPropertyEditor.js\":\"bca023ae8711ac12\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefTargetTypePicker.js\":\"0ea5d1d79708d982\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/SelectPropertyEditor.js\":\"252a4565a864d43c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/TypesPropertyEditor.js\":\"8f86f31803a21614\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/defaults.js\":\"b41d71fb3fa1e4b7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/kernelValuePresets.js\":\"df66763bb23443ed\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/selectablePresets.js\":\"47cc07df3a12ceec\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/typesPropertyUi.js\":\"f6195cb38cd7c571\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/AddPropertyForm.js\":\"11c046e7ca258aee\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyPicker.js\":\"b975e71329cf3702\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyRow.js\":\"2b8a47931ccf029a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/Rows.js\":\"132c9687b9d6c853\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/actions.js\":\"9f5a34d985f4558a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/declarationOnly.js\":\"af93c4e50e96344e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/layout.js\":\"425e8559083c4f88\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/model.js\":\"ef77c8f8a41731d6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapeUi.js\":\"f02586982a232284\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapes.js\":\"e9ee29e1bb3a7690\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d0d5e6da6b7b4043\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/visibility.js\":\"40c51f007facb220\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanelSections.js\":\"f51430bda8fff699\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockEmbed.js\":\"852e8204907f8dd8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockLink.js\":\"25f33bf5c16d56bc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockRef.js\":\"b65a2ac9daca2004\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/ReferenceLink.js\":\"e0e0aef3da9b03fa\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuard.js\":\"7ba60b14b1921ae8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuardContext.js\":\"c89a2104afbcd6cd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/linkInteraction.js\":\"ddeb1567a273d267\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/referenceLayout.js\":\"2b114ba8ce927cea\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/useBlockRefAncestors.js\":\"4068ada24cda938b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockGutter.js\":\"70f7daed74fd3c4b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockInfoDialog.js\":\"02d5bd506458b1d6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockTypeBlockRenderer.js\":\"bad8d636c14b5df4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BulletHoverCard.js\":\"ef89ac3ccab8d413\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorContentRenderer.js\":\"13d88087c2e0cba4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"154db52035ffb986\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ColumnResizeHandles.js\":\"cbc1b48e2b5c65d5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9706608c8463ba98\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/DefaultBlockRenderer.js\":\"40ddc6b2ce9f628e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/LayoutRenderer.js\":\"889643509e2a410a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MarkdownContentRenderer.js\":\"940734e488cc422f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MissingDataRenderer.js\":\"e7db5a6e0d71079d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PanelRenderer.js\":\"0c9baf0620d3df4c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PropertySchemaBlockRenderer.js\":\"026982be2017129d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/TopLevelRenderer.js\":\"dee1fb73abb6a130\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockGutterMode.js\":\"83a43a3251caa077\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockTitleText.js\":\"dccec054b38707b1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/fieldCreationKeydown.js\":\"245972df056e122f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/layoutRootContext.js\":\"e5eead153d204d6e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/TypeChip.js\":\"845f1d6373818c9a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/chipStyle.js\":\"bb7b9a00387ef65e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/anchored-floating.js\":\"66813562a13059cd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/button.js\":\"0e09bad36fcb2d4e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/card.js\":\"e5a425f23c57149f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/checkbox.js\":\"9eeec9d05abacc3e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/collapsible.js\":\"9e46a09020425698\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/command.js\":\"2761c49638084c10\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/context-menu.js\":\"06ea672ab26a8c6b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dialog.js\":\"fd3884c91313073c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dropdown-menu.js\":\"6e24751f58be538f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/floating-listbox.js\":\"a78ea039969ca2af\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/index.js\":\"92c6ff4a4b26a0d4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/input.js\":\"678e172bb23e5636\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/kbd.js\":\"001faa3d36358477\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/label.js\":\"255889769b4d0ff1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/textarea.js\":\"ba85726931a12d4b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/useEditModeYieldKeepalive.js\":\"eec4d3bd16e26645\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/BootFallback.js\":\"cbe7bb7bbaaff432\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/FocusedRowLazyMount.js\":\"3c9cf4a5a9a1f41a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LazyViewportMount.js\":\"8bd47077e9024598\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LocalDbCorruptionFallback.js\":\"39e493f46f929a77\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/error.js\":\"335b842f2d3f9ffa\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/lazyMountRegistry.js\":\"ce4461c7712906f5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/suspense.js\":\"83a112fec23fdd0d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/CreateWorkspaceDialog.js\":\"f91579d65e707262\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/PendingInvitations.js\":\"17e7092db8eb19f5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/SyncProgress.js\":\"472ef9d202c1943d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/UnlockProgress.js\":\"a566897d8aca3b1e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceKeyGate.js\":\"f2ade1c54ba68f15\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSettingsDialog.js\":\"57a7c8893d513a0a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSwitcher.js\":\"6918fd1b243974b5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSyncGate.js\":\"15bb072b9e9e10c9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlow.js\":\"eb1f739d8eb52ac8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlowHost.js\":\"128385c8755894c2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/EncryptionSection.js\":\"e3dc7e476afedde4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/attachmentPrompts.js\":\"4fb0f7db05df81ce\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8f1429714d9ea043\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowDeps.js\":\"4785627c51e9350d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowStore.js\":\"cd3659541a580159\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/flowUi.js\":\"4f5655c3d2ff767b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/useConversionRun.js\":\"e2f421b09e595bde\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/keyUi.js\":\"271fbdcab9b7802f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnKeyLoss.js\":\"8cfe17310c35c2ad\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnServerE2ee.js\":\"14e7e437159d5f5a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/workspaceUnlocked.js\":\"cb435c7826bf50e4\",\"/knowledge-medium/pr-preview/pr-1850/src/context/backgroundSubtree.js\":\"68dd7ec744d5ec4e\",\"/knowledge-medium/pr-preview/pr-1850/src/context/block.js\":\"872a5a31649f1d6d\",\"/knowledge-medium/pr-preview/pr-1850/src/context/layoutWsContext.js\":\"ca9003411c0f5a72\",\"/knowledge-medium/pr-preview/pr-1850/src/context/propertyDisplay.js\":\"20f9ea4b72505b80\",\"/knowledge-medium/pr-preview/pr-1850/src/context/repo.js\":\"454074578ca86c29\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasClaim.js\":\"86c1c9efbc58c715\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasSeatNamespace.js\":\"e58a3fb152bd9186\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockData.js\":\"5b3eea81a81b888c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockType.js\":\"194168f4f002b109\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/changeScope.js\":\"188d362323f62443\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/codecs.js\":\"16c29894713d2a3d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/derivedData.js\":\"1d72d7381e493040\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/errors.js\":\"4d83ff69688f2e99\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/events.js\":\"4b8f1554883d4e26\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/handle.js\":\"714540ed0840b8c3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/index.js\":\"b3b9f0ad04ec31eb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/mutator.js\":\"8c41dc3d6a220c43\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/processor.js\":\"2d4cf6755d8b60be\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/propertySchema.js\":\"f5347ee8339e7633\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/query.js\":\"43f03cdfb97551b8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/sameTxProcessor.js\":\"01fd847bf03cfa58\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/schema.js\":\"714540ed0840b8c3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/tx.js\":\"714540ed0840b8c3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/typedBlockQuery.js\":\"dc78a3f8b88c6f3d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/user.js\":\"dbf7b8fbfa77016d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresetCore.js\":\"4930a3ce820929ea\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresets.js\":\"34f6c1f15445e079\",\"/knowledge-medium/pr-preview/pr-1850/src/data/attachmentCleanerIOVerb.js\":\"7ee1331d9eb3925a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/block.js\":\"f14f7669076d52a4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockCache.js\":\"01bdff8fc5c15f60\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockId.js\":\"0192c0c667097141\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockLiveness.js\":\"f3a0952b01d1619c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockMerge.js\":\"3bebb199f736f7ce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockSchema.js\":\"8d1b3dff4ef8ffd0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypeLookup.js\":\"d36ae70f3862cad5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypes.js\":\"06ce8575ebc6de8c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/clientContext.js\":\"2e4017bd177551d8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/dbFileSiblings.js\":\"e273fd07bce5b29e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/definitionSeeds.js\":\"eaf0879a99e7c068\",\"/knowledge-medium/pr-preview/pr-1850/src/data/derivedIds.js\":\"bdc404fca78fe203\",\"/knowledge-medium/pr-preview/pr-1850/src/data/drawnSubtree.js\":\"88cd00d898870f77\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facetBridge.js\":\"ffccc0c9fc8546ca\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facets.js\":\"2fed373884a78795\",\"/knowledge-medium/pr-preview/pr-1850/src/data/globalState.js\":\"ae5e79d6e8539240\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/aliasClaimRederiveProcessor.js\":\"8ebfdf03af1451b6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/ancestorBatch.js\":\"f408422a111c450d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/blockTypeTypeifyProcessor.js\":\"ef31e48794ea1436\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/clientSchema.js\":\"aaca51f78d2568ef\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/commitPipeline.js\":\"e8a49155d6bbc92f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/devAssertions.js\":\"d128eb05b25ee7a6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/firstSync.js\":\"ba2f9dda62b7cec8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/freshInitialLoad.js\":\"be12450cfa63a09c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/graphBackfillClaim.js\":\"397e4a35de93bf5c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/handleStore.js\":\"c2c8c27c03432bc9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/idleMarkerJobs.js\":\"34b0a4c8ae8964ce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initialDownload.js\":\"ae713a8a578b11bf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initializeClientDatabase.js\":\"bdc4d06bb6195179\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/jsonCanonical.js\":\"9a0cc3f4a1d124f4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelInvalidation.js\":\"cf9e319bd1fbf21b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelProcessors.js\":\"3e8be25af7cba69e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelQueries.js\":\"2ecaf539b5458e3c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/mergeTypeMembershipProcessor.js\":\"1cca04fcebf37748\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/normalizeReferencesProcessor.js\":\"69f9085f67ef36f3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/poolInstrumentation.js\":\"0acc0650c9ede441\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/processorRunner.js\":\"894d00eb0c65fcba\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyCellBackfill.js\":\"8df07e4f2b56638d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildMint.js\":\"d58c86c60acd9e10\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildrenProcessor.js\":\"c3e1dcace36bf0cf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7712696b979d3823\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionSynthesis.js\":\"6947db177b3dcfdf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyKeyScan.js\":\"6233509d94960ed8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertySchemaResolution.js\":\"f65b1e88087491a9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyValueEdits.js\":\"d8c1d95438b774ec\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/raiseProtocol.js\":\"c0b1d8c5b23c7354\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/readBatch.js\":\"7b81f885e6ee5800\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/refProjection.js\":\"ebb35d364e112572\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetLookups.js\":\"0944e19de48b03cb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetProcessor.js\":\"37dab0ad716dc2a3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/replayMerge.js\":\"e1ffd8369f1b71f7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/sqlBinds.js\":\"88fcef779eb98342\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"fef5cb02c17f8b49\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/arrivalProcessors.js\":\"88aeb0fe2f60900b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/invalidate.js\":\"b654a6743fe9a544\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/materialize.js\":\"ef20beaa182c589a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/observer.js\":\"99fab0a5f505db23\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/reconcile.js\":\"4dd013f77e0f1e99\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/timingMetrics.js\":\"14ca0388bb8044e1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/treeQueries.js\":\"0d9e0e5e553fc99a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txEngine.js\":\"35bf5d831c8c1904\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txSnapshots.js\":\"0cc077f7164d6078\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/typedBlockQuery.js\":\"667d17e807b6f051\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/undoManager.js\":\"9bc414379c8f9693\",\"/knowledge-medium/pr-preview/pr-1850/src/data/invalidation.js\":\"0dea9896a3ccc977\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelDataExtension.js\":\"2cbe7520db241040\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelPage.js\":\"35eb9d5044c17578\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelValuePresetCores.js\":\"bfe614a994a8b447\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbCorruptionSignal.js\":\"20f0344d85f2b2e1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbStorage.js\":\"eefb47e6dd1ebb09\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbVfs.js\":\"7f7df5a333f89c7c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localSchema.js\":\"62edd72b2dc47871\",\"/knowledge-medium/pr-preview/pr-1850/src/data/maintenance.js\":\"25abc5e641e8b1f4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mergeProperties.js\":\"c77a588b10511a48\",\"/knowledge-medium/pr-preview/pr-1850/src/data/metricsConsoleHook.js\":\"f80434d57146691b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/migrationsPage.js\":\"dff58a925c5bb1a4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mutators.js\":\"06cdc52fb5572e2f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKey.js\":\"34adff329eee4fbb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKeyPlacement.js\":\"a1088a89b56acd4b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/outlineSurface.js\":\"67e49b0f1f1bfd5a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingEditorContent.js\":\"cc23bce4d48c0cf0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingUploadsSql.js\":\"9266266192a22949\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pluginStateExtensions.js\":\"f0ac4d45c86de133\",\"/knowledge-medium/pr-preview/pr-1850/src/data/powerSyncLogger.js\":\"11ecd38931972c26\",\"/knowledge-medium/pr-preview/pr-1850/src/data/projectorRuntime.js\":\"37f03b5a4f245331\",\"/knowledge-medium/pr-preview/pr-1850/src/data/properties.js\":\"a6e395c014121a9f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertiesPage.js\":\"2404d4623e45ef08\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyChildren.js\":\"0b35978565c9139e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionFanout.js\":\"bbf553214df89182\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionMetadata.js\":\"22d7ee2358ecb69f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionRegistry.js\":\"5804d8441e294345\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDisplayMode.js\":\"3afc509570521d1f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyRowCreation.js\":\"9c4eae8e68f331f6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySchemaCreation.js\":\"759036e7b81c8c68\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySeeds.js\":\"7a5c5079886513bb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/recentsPage.js\":\"50b041792ac7e7d8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/referenceBlock.js\":\"b8c6b19160d1a4f6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rejectedUploads.js\":\"b1e349dea4d33906\",\"/knowledge-medium/pr-preview/pr-1850/src/data/releasePowerSyncConnection.js\":\"0ea635e04d77a29e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repo.js\":\"e74e0c97665c8b63\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repoProvider.js\":\"056f3c021036415d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rowProperty.js\":\"a223a13b86795634\",\"/knowledge-medium/pr-preview/pr-1850/src/data/searchFilter.js\":\"be05bd5b8f065959\",\"/knowledge-medium/pr-preview/pr-1850/src/data/seedIdentityLedger.js\":\"5841fb312223f516\",\"/knowledge-medium/pr-preview/pr-1850/src/data/stateBlocks.js\":\"5ac79273e542ca42\",\"/knowledge-medium/pr-preview/pr-1850/src/data/structuralEditPolicy.js\":\"d2e42dd068ce04fa\",\"/knowledge-medium/pr-preview/pr-1850/src/data/subtreeDelete.js\":\"f3fbb4308fcfbb8e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncStreamLock.js\":\"a0be335499751c81\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableSqlRecognizer.js\":\"fd6c62fb869fb0de\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableWriteGuard.js\":\"5f48c572c0aea7bb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/targets.js\":\"cb4e25e64f3a9e61\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeColors.js\":\"bb85e5c2263d5aad\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionMetadata.js\":\"0adf969f130d57a3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionRegistry.js\":\"04f44028533bc64e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeExtraction.js\":\"b2779a81a69fcddd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeInitialValues.js\":\"abc8a06b948795ee\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typePropertyGroups.js\":\"595dd485d8adf042\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeSeeds.js\":\"12a0cb1fa3d0c024\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeTagger.js\":\"7e54ee1d10b258f1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typedRecords.js\":\"b705dfab75de4f11\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typesPage.js\":\"9ec34c6a42d1c761\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userPrefs.js\":\"e4623e7d1cf479ef\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userSchemasService.js\":\"e31a467101ecd8c5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userTypesService.js\":\"06b083e77f319170\",\"/knowledge-medium/pr-preview/pr-1850/src/data/valuePresetRegistry.js\":\"095c6004eb4907f4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/visibleChildren.js\":\"3ee356e0233b7b0f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceConversion.js\":\"30fb85d79a62123a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceFirstSync.js\":\"5d79c55dc22f14e7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceIdNamespace.js\":\"dcf229d6cf6643df\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceSchema.js\":\"b0d25a6a927d2221\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaces.js\":\"f1282ee8e84db37f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadLog.js\":\"bfa5c467dfcfc399\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/BlockPasteShellDecorator.js\":\"3a032071ee036598\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/atTrigger.js\":\"1146d753c4b18da9\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/autocomplete.js\":\"de6dc237d730ca28\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/codeMirrorExtensions.js\":\"b291e06b5ada8f82\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/contentFlush.js\":\"3c63191c866aee33\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/defaultInteractions.js\":\"ec9db4e5532561df\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/editSettleSignal.js\":\"f6b6f1a6d8cf7562\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/insertImage.js\":\"6310fed6179369a7\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceCompletionRange.js\":\"c85b3c8e00791be4\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceTargetTypes.js\":\"014f43a856845f75\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/syntaxContext.js\":\"8a6ee71ee8f91348\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/triggerMatch.js\":\"5075e56ec68c1e4f\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/AppRuntimeProvider.js\":\"f27c29c405a07d09\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/BlockFocusShellDecorator.js\":\"9e8f26e578a22e12\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/ExtensionRenderBoundary.js\":\"99293865dfc0344f\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/PanelContentRecovery.js\":\"5faef06c60501cc1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/apiCatalog.js\":\"3fb8ea394fffcfae\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/approveExtensionHere.js\":\"f6704f14d14fc921\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/armedCutAppMount.js\":\"1e08bee196f77ced\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/batchableKeyedStore.js\":\"9cc6eaf2f1fd59cc\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockInteraction.js\":\"325426e1a1bc1bf1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockSelectionAction.js\":\"dbcb177bb2332722\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compileExtensionModule.js\":\"99dd90ece9482388\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compiledModuleCache.js\":\"f8192dc555141df8\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/continuousGestures.js\":\"60547821a08ebc3e\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/core.js\":\"72d274bced1e6571\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/defaultRenderers.js\":\"4f50f7491b0d4065\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/definitionFanoutAppMount.js\":\"49611bfe8a0e6d16\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dialogAppMount.js\":\"8a280180b3d54d66\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensionSeeds.js\":\"a8d8d9dd257a6133\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensions.js\":\"7b0664f0892eec85\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/exampleExtensions.js\":\"1072bc52bd74f62a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionApprovalStatus.js\":\"d1f545f5bcf754d1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrorToast.js\":\"87214f6f0e7c3ef7\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrors.js\":\"f7e7b9cf313e49fd\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLookup.js\":\"a656a8a3ed60d944\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionToggles.js\":\"7325cc57230a071c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionUtilitiesCss.js\":\"5d04cd42a8aba38b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/kernelPageDeletionGuard.js\":\"068042aa9736da0c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/liveRuntime.js\":\"c03f11464c03d562\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/openExtensionsSettings.js\":\"87c9131be14e2020\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/overridesCache.js\":\"e880fb2c12a7d972\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/pluginIds.js\":\"27a4aec6ac23a123\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/processorRejectionToast.js\":\"e5ddee4ba784b5b5\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeActions.js\":\"ab136ac4a4a8f52c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeContext.js\":\"0893881e6a5c120e\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticAppExtensions.js\":\"54f343281266c0e1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticDataExtensions.js\":\"1046d2edb1c19968\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/toastAppMount.js\":\"61b0fcc7287542c9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useOverrides.js\":\"22ffaaed14bb942a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useShortcutSurfaceActivations.js\":\"83a91bc4b081ee42\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/discoverToggleTree.js\":\"59b54ccd6f91416b\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/facet.js\":\"9ebeb62159c4ae5a\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/resolveAppRuntime.js\":\"2c857dbc44d4d422\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/runtimeEvents.js\":\"1f2179c5eb80ce44\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/togglable.js\":\"91e26eefc404630e\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/variantFacet.js\":\"a737e92c4c1af2a4\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/verbFacet.js\":\"24033d07c0bf9afb\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/block.js\":\"e3528f44e414832c\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/focusedChild.js\":\"c61d95b0bc06e1a0\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/propertySchemas.js\":\"b177b2a8767158e7\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/typeRegistry.js\":\"2529b521e634e0da\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAncestorCrumbs.js\":\"bf6a26f5e5512151\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAutocompleteListbox.js\":\"d8e55bba0065b780\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedSearch.js\":\"dd54fec7f1f84ae6\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedValue.js\":\"285f6c72bcb12def\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsFocalRender.js\":\"65d79157f36152ec\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsReadOnly.js\":\"fb05b709868e735c\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMaterializeBacklog.js\":\"e20677f369157cab\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMinuteClock.js\":\"3e05034eedb3603d\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePanelLayoutProjection.js\":\"af47440e52020f36\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePendingInvitations.js\":\"a704fb8f751902a5\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRendererRegistry.js\":\"33a96198707b78e8\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRetainedFieldRows.js\":\"c6f0b0208e6aff18\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useWorkspaces.js\":\"d7b2229e4759bd1f\",\"/knowledge-medium/pr-preview/pr-1850/src/lib/utils.js\":\"81c5c5054bd18445\",\"/knowledge-medium/pr-preview/pr-1850/src/main.js\":\"382f55353c60ab60\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/MarkdownImage.js\":\"0a1a67ff0f9a8871\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/blockSeparators.js\":\"a92765982ae9be7e\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/context.js\":\"2aafd942b91dc625\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/defaultMarkdownExtension.js\":\"fd776f9d37f48d57\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/extensions.js\":\"485b3c15a0e49259\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/renderMarkdownHtml.js\":\"493d7f7330b94b8c\",\"/knowledge-medium/pr-preview/pr-1850/src/minimal-editor.js\":\"a555dc11e0bece6e\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/armedCut.js\":\"f441fe609f4e16d9\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/captureMediaVerb.js\":\"7f9445b84c776eda\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/clipboard.js\":\"8999f1a14a4c590b\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/decision.js\":\"07ce98e18e31ae17\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/operations.js\":\"21321a4c5c2e8b2c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/AccountHeaderItem.js\":\"6712c244b34ddb7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/index.js\":\"9b78a1055808f863\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b1749f7ac907a097\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askAgent.js\":\"ac3ab1bda864290e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askedStore.js\":\"ad059e130c6633bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c1748f0d648d92c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/chipState.js\":\"59e510e411eed8fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/dataExtension.js\":\"bfc3f3a323c2a7b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/index.js\":\"f168fd23b71f2d80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"071d4e78fb556d25\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/schema.js\":\"81fb349ea8210a1f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/AgentTokensDialog.js\":\"edb33d4f845ddf7d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2c5f87335b7277e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/addMedia.js\":\"8c88629f30570b1f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/backlinks.js\":\"627e78a7ad7bd87e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/block.js\":\"70bf09cd6db5b282\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/context.js\":\"0e3892590f84388d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/displayIds.js\":\"245bba2260b31813\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/index.js\":\"90652f2447842b07\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/outline.js\":\"f1816367a7851498\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/properties.js\":\"61941a24bb8b4c49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/refs.js\":\"93eb9249e5e107e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e2a756ffb574936f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/search.js\":\"3d0c0f98aa124e61\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/shared.js\":\"4095bd345fac1001\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"273ba9a276b09462\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/text.js\":\"99c52fb128f0b1c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentWrites.js\":\"330520fa666f7be7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/authoringCatalog.js\":\"19bec55b62a0c2ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/blockRefTargets.js\":\"07e16553e4032bf6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridge.js\":\"40961f332f4fd4bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridgeLoop.js\":\"a42b9951f93a0a8d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/changeHistory.js\":\"1452a1da4392d514\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commands.js\":\"7d3e2148ae760b21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commentsCommands.js\":\"98c1b4a9e6b66ce1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataExtension.js\":\"a185624d031966a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataModelGuide.js\":\"f82333d8e4fa959f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/describeRuntime.js\":\"95efd24ad44a0bb9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/extensionLint.js\":\"eecb5619ddb58e5c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/grainAudit.js\":\"1194be9ced4280bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/healthCommand.js\":\"217a22ef9d3fcb53\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/index.js\":\"9fafac0263de7eae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/presetIdentity.js\":\"c3bb26c07a3c2ddc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"6dbc6fac7b4a1613\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/readMedia.js\":\"8725de3367327461\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/schema.js\":\"c617ae1cbaef2d50\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/serialization.js\":\"0d5027c1418af6e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/targets.js\":\"4e6f696c8dec1835\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/tokens.js\":\"cbba32c23474f209\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/watchEvents.js\":\"cdc9848d0f55b522\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/workspaceGuard.js\":\"32d077667c856a4c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/writeCommands.js\":\"3b6c08ea06d630a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/AliasCollisionToast.js\":\"f73bc3e0d4e4d801\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/DuplicateNameBanner.js\":\"ee3953dc15a7f036\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/collisionMerge.js\":\"efe3936223dcd06b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/dataExtension.js\":\"699763179e6db9a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/index.js\":\"10c5b4e6562676db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/mergeCollisionAction.js\":\"5b8177153bd47bb2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/pageStyling.js\":\"72a5ca8f33497a70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/rejectionToast.js\":\"721afb4d38cebb93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/syncProcessor.js\":\"99752b7fb4558c6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/actions.js\":\"1a408e60dc6098de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/addComment.js\":\"c2d34384413ac41b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchor.js\":\"ec43b42f20339919\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchorState.js\":\"74effb24028fc4c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/commentLinks.js\":\"f79bf682e04ea1aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/confirmThreadDeletion.js\":\"475ee8c9126a4ab8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/container.js\":\"a732340708cf814a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/dataExtension.js\":\"340b39c04dee02a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/deleteComment.js\":\"d792175fce77a7f2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/highlights.js\":\"8696cfc4943b5825\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/index.js\":\"70300b42c9420d03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/linkedCommentsPill.js\":\"d9411a21c8b290c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/margin.js\":\"ea40e3b74e94849f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/marginSchema.js\":\"5a8caad5223c3893\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/newComment.js\":\"2731bf17f1961e6c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ownThreadPicker.js\":\"ea6d491bc296776f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/placement.js\":\"ea6a4e5d1e76e3e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/queries.js\":\"442802d80dbe5c06\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotePosition.js\":\"05249d610475ebcc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedIn.js\":\"bd41284e37d571c3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedRange.js\":\"b433d9d8d259e364\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/rangeRefs.js\":\"a01fde63bf8401a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readHighlights.js\":\"6d06c69d83efbcfa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelection.js\":\"a6883619a4baf800\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelectionUi.js\":\"e87dc226a47b40ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/reanchor.js\":\"fd3f26c1823e5033\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/schema.js\":\"bb5a5134cb6a7339\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scope.js\":\"ac101774d9b3cf0e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scopeThreads.js\":\"9686751fcf121084\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/splitRetarget.js\":\"20942e47ac710f61\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestionCard.js\":\"69a8f131245c514c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestions.js\":\"4220111314caa53f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaries.js\":\"d6b75e6799fce573\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaryBatch.js\":\"6eb85c27736581f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/surface.js\":\"6255dd2992d705aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threadNavigation.js\":\"918effcd2bbe0eae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threads.js\":\"c10c2316cd6e010b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ui.js\":\"825653bbf8315658\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/uiStore.js\":\"ee4d169d2fa05ef4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/appIntents.js\":\"ed6fa4d5b68663b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/index.js\":\"b43a7068ed2e8450\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/index.js\":\"38ad1e12e9b8e734\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/status.js\":\"2296c0865e205751\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6b4e367baf759ad5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaBlockRenderer.js\":\"f0b1bc1be51ad9f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b7834b73fe0d0cbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaUploadReconciler.js\":\"ab8992f35f4f5737\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetDownLane.js\":\"9e79206e0df4aecc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetResolver.js\":\"514d368500308fe9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetUpload.js\":\"0ab3029d28bc1923\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/attachmentCleanerIO.js\":\"4c511a92c2907c00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/supabaseAuditIO.js\":\"7abb8f2dab2b9a18\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/blobStore.js\":\"6b5f851d56ee0073\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/byteStore.js\":\"c89e17521f5cbeb9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanerIO.js\":\"c17f5054dbb8d0bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanupAttachments.js\":\"a98810ea1088fc15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/dataExtension.js\":\"41a0ab7c06abdcda\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/downLane.js\":\"70112ee59705dced\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/index.js\":\"f10a937f13d8c026\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/insertImageContribution.js\":\"0e295d1b4aa62f15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneArming.js\":\"fc69aad233636457\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneLock.js\":\"af64c2ab77242ded\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaBlock.js\":\"d7d060af3fa1bfad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaCapture.js\":\"24268fbbee976b62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewers.js\":\"cce9b8db14ee7980\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewersFacet.js\":\"77fc4036a4a734eb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/pasteCapture.js\":\"6250b673da861df1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/resolver.js\":\"2141dd2328fb0ecc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/retryUploadsAction.js\":\"af989b4b4ae08fd5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/storagePaths.js\":\"e266c1cedf15c5de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadDrain.js\":\"aef9227501354369\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadLaneStatus.js\":\"8e43274b5295ec72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadReconcile.js\":\"2cc553025650b7b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadRecovery.js\":\"42e44a6d4055a09c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadStore.js\":\"f6414d4f7da00e2b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/useAssetObjectUrl.js\":\"cf6c650a6f19991f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"1c82f541bd006fd3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a02cdd15cae329df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/facet.js\":\"4a74bbfe9c38d0a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/index.js\":\"e25758a985bda9c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/prop.js\":\"7ad3fa20a595a3db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinkFilters.js\":\"2a4c295a749149fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"381e07174fb433b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BlockEntry.js\":\"35908d97b214c7fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/LinkedReferences.js\":\"1a31a21423b41905\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e1ffa07eee55aabf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dailyNoteDefaults.js\":\"2c6e3e3576362ff2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dataExtension.js\":\"4668a9d48ce19006\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/edgeExclusions.js\":\"df17463bd37ab371\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/filterProperty.js\":\"79be4cec863ba82c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/index.js\":\"90ae0f8c51a0f175\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4453d15ddd6ec44b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/applies.js\":\"614e282c475bccae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/countQuery.js\":\"6f4d661d9b55da94\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1ee823ee030dcf60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/index.js\":\"be16845701820092\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"dfd72d8ebe7818bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/presentationInvalidation.js\":\"77c6079440504588\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyEditorOverride.js\":\"72185db7167a3764\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyFilter.js\":\"fb3510b93fc571f0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/query.js\":\"00cff56033c89926\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/resolveFilter.js\":\"a2184c937e735586\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sourceBatch.js\":\"4ea7e5f6430bd742\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sources.js\":\"e1afe25a7e43eb48\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useBacklinks.js\":\"19d0e9f1ad9522d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2570e02222f890f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayCelebration.js\":\"d1d68b00031b5727\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayOverlay.js\":\"d71c5a86569ee1f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/gate.js\":\"91e6cc046c1bc9c3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/index.js\":\"acbd1190729e19b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/wolfTheme.js\":\"ea941398068ae3ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/BlockDragLayer.js\":\"c9ac0159a6e831b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dragController.js\":\"648193b6ad25ddf7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dropTarget.js\":\"9d3ac12f7dde98ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/index.js\":\"0fff70aefb9762c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/projection.js\":\"a99c95ae00ccb7e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/BlockMetaCard.js\":\"cbc8a70d366a098e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/index.js\":\"fbb890a4e3e6fb2e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/AddTagDialog.js\":\"750aa3e6f3d6d774\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"fe90b02cabfed0f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/TagNameIssueHint.js\":\"af1f4af63c5a7bc1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/addTagAction.js\":\"a2b8e39fb4d9b4a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/appendTag.js\":\"d711b4318061cd81\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/config.js\":\"81071bdc1ecdd88b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/dataExtension.js\":\"5be4d3eab83cec74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/index.js\":\"79494bc024d1c528\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/propertyEditorOverride.js\":\"010c53fcf805e915\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbList.js\":\"20883e96d9f6ea74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"79bd758823c6d6a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a1160a72e1621949\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ada8077840d560ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e9a2eb331d05b052\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/index.js\":\"dffcc083b7412acf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fae6677562e357e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/CharacterCountItem.js\":\"03aec781cd5886e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/ProfilePropertyEditor.js\":\"75fcb9c01c087b40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/actions.js\":\"c213107a521f1a76\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/blockType.js\":\"4cc2a78a2aaec3fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/charCount.js\":\"deece00c7ca68a0e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/dataExtension.js\":\"b0c044bdec18d225\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/index.js\":\"672af075eea6d71f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/profiles.js\":\"ff7bb58674b9e744\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/properties.js\":\"6766eac553ce07d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/textCounts.js\":\"2b7fb388fd96011c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/colemak-keybindings/index.js\":\"c2d9dfa2190c7a16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/CommandPalette.js\":\"ce38c04ee1851e99\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/HeaderItem.js\":\"13073bd0c3c5a0b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/context.js\":\"dc1ae7c0acdba40d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/index.js\":\"78bb8c416d67ef5b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/selection.js\":\"a6b8515f2295bc28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/toggleStore.js\":\"ea6bb61f10484fb6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/useCommandPaletteActions.js\":\"bce4a4fc8f6b328d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/ContributorBadges.js\":\"b70e0bba51181af2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/author.js\":\"e87a0928a8d1666f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/codeMirrorExtensions.js\":\"6b1c5288b5e9da50\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/dataExtension.js\":\"e4b24147d977ba9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/index.js\":\"3ee140fbe1ca8a59\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/mentionAutocomplete.js\":\"4fd0b9509a9e37dc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/processor.js\":\"66233ca7245fcd17\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/profiles.js\":\"911e7100fe0f85f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/queries.js\":\"c7b79041f35c0d9f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/schema.js\":\"eefe73ff1e7e0dc0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"10dacda2e89b0bbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/followOrigin.js\":\"52a8b8d887ee8c49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/index.js\":\"3711144d55d70524\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4467ba6622441698\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9961fd690dfe95b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/CalendarGrid.js\":\"ae1e395df5ecc8d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DailyNotePicker.js\":\"f0c721a60137dee4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"277417759ec6d14d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateNavDecorator.js\":\"6def72051a51be92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateScrubOverlay.js\":\"b9e7ad111025150e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/HeaderItem.js\":\"09b1adb414e612a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/ReschedulePicker.js\":\"6ea2dc06dac31c76\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4e5cc7db407a7890\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/actions.js\":\"195f6eabd2a513d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/blockDateAdapter.js\":\"6639a9112a6522f5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/calendar.js\":\"d59f6d6abe164065\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dailyNotes.js\":\"72b0a806207a290e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dataExtension.js\":\"7b2ae835e464237a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubActions.js\":\"608cc86b282c8b8f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGesture.js\":\"fcf1e146f4fe5434\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGestureActions.js\":\"462954d2fbc83127\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d87f33ecf1da4add\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/deletionGuard.js\":\"d1c222e36266c0fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dueQuery.js\":\"23650ddfc4fe12b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/index.js\":\"571460ac6022b84b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/landing.js\":\"38df24c17b8119af\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/localSchema.js\":\"bdfe5254152d70e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/referenceDateAdapter.js\":\"d82d763b1ad95f95\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/rescheduleAction.js\":\"4d2ebe18382abc14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/schema.js\":\"5cdb0b7744e46d8d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadBlockDates.js\":\"eeb904c79459eef9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadDatesAction.js\":\"b54d0d635b22c786\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/today.js\":\"7548976fa2053345\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9086ffe32e6d2e62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"55bacf1e53f7648d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/audit.js\":\"0471c9c3cb3bea47\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditAction.js\":\"5cdbbec542bcc01f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditRanges.js\":\"88e3c0096c08e0ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/diagnosticsSource.js\":\"357693b65ffb8a65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/divergenceScan.js\":\"bbd1beddc514a480\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/index.js\":\"72d39970fc198f4a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c7b8766d9b83e7d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/referencesMirror.js\":\"9520af3ad1225fce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/rowJson.js\":\"50f5da41b48a77ce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/schedule.js\":\"b9a7d085b6a06f5a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/store.js\":\"237c0d6af19aee3b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/action.js\":\"1145f355d783b97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/index.js\":\"a7e0389c71e1c548\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/plugin.js\":\"edc1a33a1dcd8694\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"be162647a63bbac3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/actions.js\":\"e68272634403c65d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/changeMarker.js\":\"239402d9725d41ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/diagnostics.js\":\"fcfee5a9271057bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/fileSystemAccess.js\":\"027a673f4da72130\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/filenames.js\":\"3414b3de425f6dbf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/index.js\":\"150a9473be07895b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/mirror.js\":\"8f023a2b001f8f85\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runLock.js\":\"4547640245bb43d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runtimeHealth.js\":\"26dd070a661e0a4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/schedule.js\":\"c2715bc1d8a961cd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/store.js\":\"eaf29c823703c9c5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/index.js\":\"f2863465dbf9d09d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/themes.js\":\"6ba7bccc8c7b53cc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/facet.js\":\"b8c5612166df0998\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/useDiagnostics.js\":\"150e5d643d04d16c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/dismissals.js\":\"283a31b2f9b11849\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/index.js\":\"19e34218784a5c33\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/status.js\":\"628a60895cc1666f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/store.js\":\"50636ecdfedd8207\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c82c27891ea59162\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f63920d307c537bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/actions.js\":\"2e0b043126fdb61a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/config.js\":\"78186ac0c16273a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/dataExtension.js\":\"aeedd6334fe72d9a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/effect.js\":\"453341f3cb1d6d67\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/index.js\":\"570e6cc00be97a32\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0653770e708ffb28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/useToggleTree.js\":\"1a14a5adea87b888\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/ExtractTypeDialog.js\":\"f756f867a8f96782\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d3b5d82289204ad7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/PropertyShapePicker.js\":\"6f6e718d9ca5a39a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/action.js\":\"452535ad4727330a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/index.js\":\"b0e346487eca66c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/FindReplaceDialog.js\":\"8156f3120a9b83dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/HeaderItem.js\":\"8e31ee8df3535bf2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/dataExtension.js\":\"43e230972b9335a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/index.js\":\"4c02adb14c6a4ec7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/search.js\":\"7fc655dd148068cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/toggleStore.js\":\"49d343d4007f4e28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/LocationPropertyEditor.js\":\"34af50db59235d09\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/MapView.js\":\"03a321f7b470d012\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/blockTypes.js\":\"4ed7005e9849b56a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/codeMirrorExtensions.js\":\"5c3a850f3828f2ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/createOrFindPlace.js\":\"5987fa29dd4183c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/currentLocation.js\":\"9fde0825fe1558ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/dataExtension.js\":\"a31ea565c27dca06\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/geoContentDecorator.js\":\"9fad96b4bad4d9e8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/googlePlacesClient.js\":\"d175444ee0431f0b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/index.js\":\"b07d0767db974b3b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/locationsPage.js\":\"ae6e9c30ee52caee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/mapViewport.js\":\"ce8dca3427b6f501\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/pickCurrentLocation.js\":\"07a854032f75103f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeAutocomplete.js\":\"3d5b94584542e98b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeNameCollision.js\":\"d4b55ce6a33d726f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/properties.js\":\"96317092073c9a34\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/propertyEditorOverrides.js\":\"1af048860bbc6360\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/query.js\":\"09c0e811971f0260\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/usePlaceSearch.js\":\"0ffbb440c47375bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"061aaa75c3f3c0fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"bb395a7d14c938a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b059390b70e126c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/config.js\":\"5f23eac4bb77d288\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/dataExtension.js\":\"f239b4eb268947fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/facet.js\":\"fa0f806c2dff3dbf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/grouping.js\":\"f0f62434a6787818\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/index.js\":\"74be90d19b0c99f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"556d0db01c45701d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/query.js\":\"a175a158146194a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/resolveConfig.js\":\"ff9c9fa28029f21a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"39d92f1726faa19e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e959f8fb0b3b6d00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlDocumentContent.js\":\"1e3b02422d5d5eac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlFrame.js\":\"d11f2e136e4e744e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/actions.js\":\"f613cf96e9dedb39\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/blockType.js\":\"bd38523c6c25c2fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/confirmRunScripts.js\":\"dfbdaafb40b63b7a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/dataExtension.js\":\"bf6813d0061fa5a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameAnnotations.js\":\"7ae5667c37c68ac3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameDocument.js\":\"f82c29c2c582fc00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameTheme.js\":\"845f48fb9bfa979f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/index.js\":\"c28796d485374063\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/scriptConsent.js\":\"fbb73e3c0f050167\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/sourceMap.js\":\"fab3df5b34dff84b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/useDocumentScripts.js\":\"382521dd221552e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/index.js\":\"ef4464c5dc8fd988\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/record.js\":\"ade21066eb4f44ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/recordStore.js\":\"bc80e9979e4f79ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/responsiveness.js\":\"440e6c792775a9b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/schedule.js\":\"8e84eec909368bea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/sessionContext.js\":\"d078dc3499130b9c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"56bf92b8e3e13422\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"99cb1e655d8d7786\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/actions.js\":\"6473fd28319b15da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/config.js\":\"001416da540cf6f0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/dataExtension.js\":\"eeba114e0c982a00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/effect.js\":\"a412c534cba5de4c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/index.js\":\"fe052d349a51e1f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/keyCapture.js\":\"a1ebeded8c561c34\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/overrideStore.js\":\"52ccf820385b2d3e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ae2e472dd6d3f814\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/HeaderItem.js\":\"c968ce542cb42cd4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/LeftSidebar.js\":\"e6959bbaece7f204\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/actions.js\":\"4bf53742005589d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/facet.js\":\"f33a950f4f88751b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/index.js\":\"b069e75cf40d5f63\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/shortcuts.js\":\"df1b68f8bd98a164\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/toggleStore.js\":\"060116131012ae1c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/MergePicker.js\":\"d71376ead4a541f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/index.js\":\"72c12d7dec31eaae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/mergeAction.js\":\"3d1278b9a6544ecf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/strategy.js\":\"8924f8039d853e9c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/Button.js\":\"ae4e643cd0b4aa77\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"8c057041ad86a04d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ae7ce1d74d1c5463\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/facet.js\":\"fd488e5d3d14c280\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/index.js\":\"39d9a85acfa8d873\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"09ac0781afa9a2ee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/actions.js\":\"23941d818553b935\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"78acbb4a7bd753ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6b338662d223ac01\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/index.js\":\"8166ff186df6697d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/MoveDestinationPicker.js\":\"54ca443f7818852e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/blockSubtreeMembership.js\":\"178701bbb697a57a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/contextMenuItem.js\":\"4591e15213d94193\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/index.js\":\"0cadac88440b15f0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveAction.js\":\"699bccbd3b5d0362\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveBlocks.js\":\"d5131edb5ac3ee7f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/selectionAfterMove.js\":\"c46e3ab1214ad8c5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/TutorialBanner.js\":\"eedf6c041b825f28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/action.js\":\"2f555f65f8ad8118\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/bannerDismissal.js\":\"3fab5e47e8cb2db3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/documents/cheatSheet.js\":\"a7c0d638a789acf3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/index.js\":\"81c86fcfa26c747d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/keys.js\":\"599030911fae86ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/landing.js\":\"c970e39747de9e2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/outline.js\":\"eb249058f9dd7d1d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/seed.js\":\"ae11698fff677cc8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1b09977b1968f070\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/analyze.js\":\"42729ccb61a1a9d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/diagnosticsSource.js\":\"91c8d64cdc6e85df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/index.js\":\"f193c00715b08d43\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/load.js\":\"59a9e228425cfc15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/monitorRun.js\":\"6ff29577296d4f5a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/schedule.js\":\"881879c048510770\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/series.js\":\"80ebc8fd9aa1e758\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/store.js\":\"08fc682bbcf7bc9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/trendAction.js\":\"ee462dd37ec570f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/verdict.js\":\"c4e7fee1e0c65907\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/clickToEditAction.js\":\"6d00c5efbe153ca4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/index.js\":\"a87ff96cfd34b450\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/interactions.js\":\"ceff8b071432268f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"59639c05172747ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGate.js\":\"a7978845c9d4995d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGateDialog.js\":\"633d5fa952f05b77\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/action.js\":\"01eee446e57a59d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/index.js\":\"db8c3b86500a859c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/localRunMessage.js\":\"5ca57c257ca5f03e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/plugin.js\":\"a237b604368dce16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/progressReport.js\":\"a0b3afb436137e51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/sweepProgress.js\":\"338100c2b9dc1063\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/FieldRowRenderer.js\":\"843c130138ea3fee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/ValueRowRenderer.js\":\"5b848a59ef0894a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/actions.js\":\"076a9b1d99429cf8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/autocomplete.js\":\"cad5b0085fb00e68\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/fieldRow.js\":\"8e97ff87816c747d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/index.js\":\"a2dc3970406eae90\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/referenceWarning.js\":\"d1eb7bda24fc8324\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueAutocomplete.js\":\"e802d7802a870a50\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueSchema.js\":\"16a46b5e78201c6f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/HeaderItem.js\":\"6d54ccc3f8f6a43c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/QuickFind.js\":\"8efda2199c59b7ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/index.js\":\"f837663cb1ee8275\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/recents.js\":\"e0887e23df4be04e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/resultItems.js\":\"70c69f843891864c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/selection.js\":\"4f0298f1577ee85d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/toggleStore.js\":\"8a1deff9456ed7b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/HeaderItem.js\":\"d1375b9714124f53\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a77c6606db039907\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/grouping.js\":\"cc79990b0b1d66b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/index.js\":\"47a1c87e22a3717e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/target.js\":\"ba6600349a262a4e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/codeMirrorExtensions.js\":\"db3747b70cccc002\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/contentPrefill.js\":\"dc7bf526ccf8e04a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/dataExtension.js\":\"3156fa3e7ef806e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/index.js\":\"af1972df342b115c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4513115d0176078c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/invalidation.js\":\"1c8da218a95176eb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/localSchema.js\":\"dfca08da5402b7b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/index.js\":\"44d4447e37992dd2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b08fbe1585cdb3ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/index.js\":\"ad5ee5025749cae3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/referenceNode.js\":\"26ad3bf557d3f5a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/remark-reference-occurrences.js\":\"db9501a7902c0178\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"1526b79a31baeeb7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/index.js\":\"38495be5b7328d10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"45ceee7512c4bffd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6d36f84393c9bc38\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/mergeRetargetProcessor.js\":\"204c02f8d6394283\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/parseFence.js\":\"f0b92b131b30ec59\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceParser.js\":\"13e8058d35179126\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceProjection.js\":\"3c3d0989adb2df42\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referencesProcessor.js\":\"7a121346a794d7a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/renameProcessor.js\":\"18a7558d15d51715\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/spanReplacement.js\":\"d5874282eb16faf0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/htmlToOutline.js\":\"e6a6b4eb0baae8b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/index.js\":\"746c902c6e21bdd6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3dbead5df3913700\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/pasteDecision.js\":\"810d6e2568679d99\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/action.js\":\"06e6a4b06f2cb202\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/blockIds.js\":\"d16c196f03460009\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/content.js\":\"c1e3e57518bd7cfa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/effect.js\":\"d307de52086ec257\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/ids.js\":\"a6a8210084c01c23\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/import.js\":\"3060cad748d1f0df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/index.js\":\"e5211b979b6aa47e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plan.js\":\"9598ef058dc6965d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plugin.js\":\"10d51f5c775378de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/promotion.js\":\"da811ed787dee2b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/properties.js\":\"718ad108f4dc6822\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/references.js\":\"be9f86cfd5b6e7a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/report.js\":\"3930d99136b761b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/roamMemo.js\":\"1bfee0f72c8b1222\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/runtime.js\":\"03c7f6a71a816e68\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/schemaReconciliation.js\":\"99e58e1870086d19\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/srsMarkers.js\":\"f71a0463f58f9625\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/todo.js\":\"cd79118065b281cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/typeCandidates.js\":\"bdafada461d0cc78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/types.js\":\"e064f7e910e9242f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/index.js\":\"48a2c7de4b9f23d1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/store.js\":\"69877b4884ad73ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/HeaderItem.js\":\"ba79a097ff783e64\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"570443ac70eb93a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/index.js\":\"9afe6c957b14fc83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/model.js\":\"11d2fff0006bdfbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/toggleStore.js\":\"c7ddff328bca2639\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/useKeyInspector.js\":\"e7d49219f1ead8f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"dca17204272669f0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/ShellDecorator.js\":\"2a69e7399bbad98f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/actions.js\":\"ca4c92639ae915fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4198d58da0415c81\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/index.js\":\"fc8523be7ca726c5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/shell.js\":\"a7379edc6b7fcb41\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/surface.js\":\"c63ef4c474631181\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/walker.js\":\"38736292247b81a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/RescheduleToast.js\":\"9758d98c71844b39\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/dataExtension.js\":\"fd39c2edff4015b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/index.js\":\"be457573ed149933\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/indicator.js\":\"e93b76eb020a5047\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/moveSrsState.js\":\"42ea52f057fd6375\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c82d1e2cc3fd482e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/scheduler.js\":\"92ba9816dc324b9f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/schema.js\":\"18298b2ceb7f3692\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"458270c880477f11\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsClipboard.js\":\"792b91d00c1688f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1cbb0ad8338819a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ad01161681230e7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DeckPicker.js\":\"678ae10b8e24b249\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewControls.js\":\"a227611ffdb11a8b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewDeckRenderer.js\":\"a3dcddd66dd10532\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewSession.js\":\"2356dd73b37583a9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/actions.js\":\"2c928f22de3bee1d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/archive.js\":\"2cfc6aee4733818b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dataExtension.js\":\"0c9627192a56bb5d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/deck.js\":\"756bb17c9ed2ecbe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dueQuery.js\":\"04aea66c047d5da8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/gradeDecision.js\":\"6df0810768989d13\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/index.js\":\"53d9ba217099a4f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/keyHints.js\":\"f3f070e290c78ff9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewCardLayout.js\":\"bc71cc89d334894c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewProgress.js\":\"72e6da6b24797a21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/schema.js\":\"dd2f067263d2ca04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/useDueCards.js\":\"700b7b68d0988a28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/index.js\":\"72329aea5ffdbe99\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/record.js\":\"12306b311ffdc426\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/index.js\":\"86202aef40cd033a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/persistenceStatus.js\":\"e696f8545dc738d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/requestAction.js\":\"b67ddc98dcfb402c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/TypeChipsDecorator.js\":\"11d1b9f461657c96\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/codeMirrorExtensions.js\":\"c5759549cca58a69\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/index.js\":\"9bab62ecfbf192ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/typeAutocomplete.js\":\"22e9f224e8e4c8ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8faf55deee80b271\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/actions.js\":\"aeb26565a00699d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/anchor.js\":\"32f0626e8ca4eb70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/events.js\":\"126fab5ae0632c8d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/gestureActions.js\":\"1244c5ab96b2bbbd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/index.js\":\"b0b7bab7be7693fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"91a5d05ffe35a937\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/collect.js\":\"cf61b723a073591a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/index.js\":\"42fc5e3f4b2af491\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/record.js\":\"b2346c5931db56b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/RejectionDialog.js\":\"a8dff06b52c4c303\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b3dfce5953aaedd2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/index.js\":\"5a5aae8f54a695a9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/model.js\":\"5a4e11bcbbc6c4f2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/queueCounts.js\":\"a9d71befc9127c0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rejectedHelpers.js\":\"ebfabf90179fe560\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rematerializeAction.js\":\"82a56b424c9cee2a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/useHysteresis.js\":\"52b2fa16d79554ee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/ColumnHeaders.js\":\"29f3fa4af26ade4d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/QueryUi.js\":\"69379b0f8dbadb38\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/TableLayout.js\":\"4ba9fe179fde68e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/actions.js\":\"7557738cacaae899\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/cellEdits.js\":\"07e42bb2b4be9a7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/columns.js\":\"71c14ae7cc5935c9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/controller.js\":\"32f0691db5d6a3bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/convert.js\":\"cbe80a8cca93dde6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/dataExtension.js\":\"01884d4c7340c002\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/index.js\":\"3a097f41a3505544\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/keys.js\":\"c511d64a09f7402d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/model.js\":\"446897dd9e360b6e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/backfill.js\":\"dadaeee2455434c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/format.js\":\"faa42bf4b39a796c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/parse.js\":\"31d35e1b811f1aa4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/queryValue.js\":\"c6f6c062d9bd3bcd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/source.js\":\"6edb610bbea53156\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/registry.js\":\"f98333be5bceb6d1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowGutter.js\":\"9b229eb4424d8b6b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowVerbs.js\":\"a2b87270f502579b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/schema.js\":\"ad05680aa40f8b82\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/sort.js\":\"40f56032f5ca1d7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/effect.js\":\"5d182d5edff377a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/index.js\":\"7393ef7cf636d941\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/theme.js\":\"2b8974119202d961\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/actions.js\":\"57f162cf53542453\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/dataExtension.js\":\"9c84acab52ad2050\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/index.js\":\"f9a6f37ec1d06ebb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/schema.js\":\"da4fb60ef3f6b3b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c9e1cce434053039\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/actions.js\":\"d070c00f826dc819\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/defaultItems.js\":\"16b5df7d5736b0ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/facet.js\":\"327f7ed1d012820c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/holdRecognizer.js\":\"23e69be385203ce9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/index.js\":\"78c25670ed1bafba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/UpdateIndicator.js\":\"480041bcc04dd922\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/index.js\":\"efc36ede3a1c8cab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/loadTimes.js\":\"d8a9fc6bbfcb542f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoNotesRenderer.js\":\"625f241e92df30a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoPlayerRenderer.js\":\"bcab08d7f5e56d7c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoTimeStamp.js\":\"ebf8eaed453bc81e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/actions.js\":\"019706ec6d0fc4f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/index.js\":\"c3975e6f7eb35442\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/markdown.js\":\"bbf9e36f494f054c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/notes.js\":\"da3234a8ca1d189d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/registry.js\":\"3874ec9d31eb2219\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/remark-timestamps.js\":\"a4e1124146a7b7cc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/view.js\":\"62d0205faad6942d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/LinkHints.js\":\"b6fa598414e07f45\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/index.js\":\"3f224aec7db2ef1d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/model.js\":\"d27f0c7a0ce0772e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/settings.js\":\"8c03c773fff63cdc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/actions.js\":\"2a261d8405abbb13\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/index.js\":\"84d197532c40709e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/interactions.js\":\"2e3d5a4239468c2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/workspace-header/index.js\":\"1fcb879b7771955f\",\"/knowledge-medium/pr-preview/pr-1850/src/registerServiceWorker.js\":\"d313601696ca6f33\",\"/knowledge-medium/pr-preview/pr-1850/src/requestPersistentStorage.js\":\"4fa6df4578dc2bea\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authRequestDeadline.js\":\"a847292049c12478\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authStorage.js\":\"963a0408650f892d\",\"/knowledge-medium/pr-preview/pr-1850/src/services/powersync.js\":\"cee9bcd67c913ed4\",\"/knowledge-medium/pr-preview/pr-1850/src/services/supabase.js\":\"91434a5a2320c71c\",\"/knowledge-medium/pr-preview/pr-1850/src/services/uploadErrorClassifier.js\":\"4e23276f62f33bc0\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/ActiveContexts.js\":\"db58467eb3adef5d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/HotkeyReconciler.js\":\"4fce67acc9b765fb\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/WipeLocalDataDialog.js\":\"ab6d60a274a174b2\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionDispatch.js\":\"d8f568afe2ba9831\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionRefItems.js\":\"fea433443b4c9ba8\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/applyKeybindingOverrides.js\":\"c9662b3e8b95f313\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockActions.js\":\"91ff818e6a9c5f38\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockMergeGesture.js\":\"4f27549a067b1853\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/canonicalizeChord.js\":\"0aab2bdfa1382cd9\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultContexts.js\":\"9d82a9f56bd52287\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultShortcuts.js\":\"ea29c32bf4fe3de2\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/effectiveActions.js\":\"e88ff5c4c9c780ff\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureAction.js\":\"18126d67fc66fa50\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureBinding.js\":\"7debabaaafed31d4\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/holdRegistry.js\":\"e0fa0792dd6a9309\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingConflicts.js\":\"f8a7a968e1ff2f04\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingOverrides.js\":\"d735255b687aab5d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/pointerAction.js\":\"db6398a93605af9d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/resolve.js\":\"8e2ee8f80e49136f\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/runAction.js\":\"cce511d43e389be6\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/sequenceMatcher.js\":\"9ba62f68ac97233b\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/types.js\":\"b3b904c02533e7f8\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionContext.js\":\"27caac438aa8ba0a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionDiscovery.js\":\"2a251c6030d0780b\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/utils.js\":\"58441298d081bd23\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/bootStore.js\":\"df1366b279b28e4b\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/previewDatabases.js\":\"14f52b5af220b36b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/byteTransform.js\":\"8e322240a13c9136\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/attachmentCleaner.js\":\"da266edd63ffc49e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/attachmentParts.js\":\"ce3198c385287c22\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleParts.js\":\"247071b0a6e4e85b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleRecord.js\":\"403b20f03654acd9\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/manifest.js\":\"ed2459d7afc5e246\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/takeBundle.js\":\"766bdaab855367b7\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/verifyBundle.js\":\"9ee6ec0a79b2f0a0\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/cleaningStage.js\":\"c9c49ae8764c4bae\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionKey.js\":\"2c0e71b64f829a8e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionServer.js\":\"8594415e7dbaf042\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flip.js\":\"78d7f05316fd5315\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flipAttempts.js\":\"3e026cf7fb9f107c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/pages.js\":\"8b3bc01e35a4cc33\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/preflight.js\":\"24dc7b51be78490c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/reseal.js\":\"b656639e4179b160\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runConversion.js\":\"504a3aa5d77baa56\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runLock.js\":\"5d487ce356a06a74\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealing.js\":\"d5cdf569dbf74ce0\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealingStage.js\":\"9e708a90332fe4e8\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/stage.js\":\"f8a1adabdda3095b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/verifyReseal.js\":\"ade19e627a00aeea\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aad.js\":\"e60cd3228ba83d04\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aead.js\":\"f958b8f237857598\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base32.js\":\"8578bc1d642f8887\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base64url.js\":\"b0f9a355d1dc747b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/binaryEnvelope.js\":\"28fc4dd16ba1c809\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/byteAead.js\":\"be59d99ca9aa7655\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/canary.js\":\"64f7affdccfab137\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentHash.js\":\"be370cf041c44dcd\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentKey.js\":\"fd30dcf1df21bc83\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/derivedIdNamespace.js\":\"71e2197eb58f76e8\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/envelope.js\":\"974154a97b704def\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/hex.js\":\"22828237020d5f50\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/sha256Hex.js\":\"915cfc2ba8b3d183\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/workspaceKey.js\":\"5bf7feb7c3956201\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/conversionState.js\":\"4a0f0ea45be43c7d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d74ca2f6d36499ca\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/pastedKey.js\":\"8e658bc80a5e6422\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"234f93d25b9b64af\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/upgradeWorkspacePin.js\":\"06b4518a97eee959\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/keyStore.js\":\"919c01aa8838cc81\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/mintWorkspaceKey.js\":\"1e5b01b95d0822df\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/modePin.js\":\"2cb6abd5788b1d09\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/openWorkspaceKeys.js\":\"a01f8fb8488cfbfa\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolveWorkspaceEntry.js\":\"3f7ddb7861a77537\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolver.js\":\"deed6f4bfda34c81\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/workspaceAccess.js\":\"fd97f36aa6c52adc\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/transform.js\":\"14ee14b576874925\",\"/knowledge-medium/pr-preview/pr-1850/src/themeBootDefaults.js\":\"6af9f05de5cbec4c\",\"/knowledge-medium/pr-preview/pr-1850/src/types.js\":\"0553c6a8794eca7d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/ClientLocalSettings.js\":\"615f103cc78f3625\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/abortableSleep.js\":\"e8cd86a3eb997b81\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/array.js\":\"2187723d611d0d0d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/backlinkAutocomplete.js\":\"1862159d999715d3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockCrumbs.js\":\"64d4a4a5396bc97f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockrefAutocomplete.js\":\"3ec932f7193bbbe8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/cadencedIdleJob.js\":\"dafe0d6f3c4d5cac\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/callbackSet.js\":\"f2b33109fa6a4fcd\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/clientId.js\":\"8d6d85ab75e77196\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirror.js\":\"fd65831133c8bc9f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirrorCompletion.js\":\"933bbfbd544646bc\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/copy.js\":\"9c813121e718a987\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dailyPage.js\":\"f7e524568a4d67de\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensics.js\":\"77a6b5b432ce3b07\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensicsHooks.js\":\"ccc18783c78f3004\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/deleteBlockThroughUi.js\":\"72bf6d3c2e1aaa75\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dialogs.js\":\"14ed90e764b64daf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dom.js\":\"cd9d8196d39e6a45\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/downloadBlob.js\":\"5b1e6427ff13cf46\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/exportSqliteDb.js\":\"eaf8697b991e3ad8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fileSystemAccess.js\":\"c9c1f67a2f74f850\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/flipSlide.js\":\"278dda22b8c5057a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fnv1a.js\":\"1e16d4720b1ad141\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/formatBytes.js\":\"73a62986bb6d1eb7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fuzzyRank.js\":\"e87be4ba3affe489\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idbKeyedStore.js\":\"b9cf9bfbc0891194\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idleCallbackPolyfill.js\":\"6b94070e08a311a5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardAwareScroll.js\":\"67ec5218514322ee\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardViewport.js\":\"0fb105bee26ed5f4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/lastWorkspace.js\":\"1ac59f817e0383be\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutColumns.js\":\"c996b1033cf3f007\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionDom.js\":\"540310e3e045f12d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionId.js\":\"d33095e13583a84a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkClickGestures.js\":\"760a43b92e66281b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkTargetAutocomplete.js\":\"f9569f86e584e2e3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbCorruption.js\":\"d8edf7b5b09774c3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbRecovery.js\":\"9c0df6929898f0af\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/markdownParser.js\":\"b5407fbf3b5cead9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/memoize.js\":\"80e84a0a889e2e44\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameFieldCommit.js\":\"c44459684886027f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameList.js\":\"8e47be88c157831b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/navigation.js\":\"7d9b058c1f1314cd\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/omnilinerNamespace.js\":\"710593ab9af79eed\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/opfsPageScan.js\":\"c41e0495d00fecf8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelClearance.js\":\"227fbeab297c90b8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelHistory.js\":\"15da12c082c056e7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLanes.js\":\"17ee99d6b1f9b6c1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLayoutProjection.js\":\"29230e83e30d5aed\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelScrollAnchor.js\":\"978af212a0a1faff\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelUrlFlags.js\":\"5d30e6cf465a21b7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/platform.js\":\"9ec48f82c56b5b70\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/pluralize.js\":\"d50e084899f88477\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyCreation.js\":\"3dcaeaee98b0fe55\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyNavigation.js\":\"4a46c98ce035c006\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyValueContext.js\":\"1f4129a6959ee30d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/react.js\":\"f59876d2a9f2e689\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeDate.js\":\"39cc6216609c8609\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeTime.js\":\"e90129e442160ccf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/renderScope.js\":\"89bd92b4f0f65399\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/resolvedThenable.js\":\"4424a893de923017\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/routing.js\":\"2ffd5959fcb44abf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/safeMode.js\":\"2710e64767c71b17\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/scheduleIdle.js\":\"55207450bc465ca3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/screenWakeLock.js\":\"5c1804cb2ed1d2f0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/selection.js\":\"262a5192e1d5e04a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/softKeyboardGrab.js\":\"352772cfb31d5fe7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/startupTimeline.js\":\"6c5db6ceb5c772bb\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/state.js\":\"070be2e9769f536a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/string.js\":\"da556ca997c35159\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/surfaceZoom.js\":\"fcdd8b3c4288c43a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/time.js\":\"a448792ab132557c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toast.js\":\"8edbf68fb51499f2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toggleStore.js\":\"757a7d8aa75ef217\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/untilStopped.js\":\"abe7f6304617907a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/userActivity.js\":\"3b058d75bd43fdfd\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewTransition.js\":\"ac4d5525f835f6c4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewport.js\":\"ded4092ce5fdce04\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/webLock.js\":\"29e027f8fdafc737\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceRecovery.js\":\"ad760634c310a54f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceSnapshotStore.js\":\"8ef6d4466618fa9c\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-compiler-runtime.js\":\"56502088a914baca\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-client.js\":\"3b4e4432479fd59c\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server-edge.js\":\"d36e7ad95d72f23a\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server.js\":\"8b5da8b314aa74c6\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static-edge.js\":\"180f01ba6758d699\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static.js\":\"762fdf4f2899fe63\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-test-utils.js\":\"d9883f7eef083507\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom.js\":\"d9293895b6fa4424\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-runtime.js\":\"e2e274195d45247e\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react.js\":\"8236f6376495046d\",\"/knowledge-medium/pr-preview/pr-1850/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
