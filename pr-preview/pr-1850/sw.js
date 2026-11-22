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
		buildId: "a351b2ae1a4e-254607d7",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/\":\"c8c45cefbb97da90\",\"/knowledge-medium/pr-preview/pr-1850/index.html\":\"c8c45cefbb97da90\",\"/knowledge-medium/pr-preview/pr-1850/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1850/assets/FacadeVFS-C3YaxVH5.js\":\"c0df8189857b81d6\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSCoopSyncVFS-B4MHOhJZ.js\":\"41a5843bf3786b10\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSWriteAheadVFS-Bnpvgrdn.js\":\"aaafb46dbe1fabd2\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-C0f-xGTU.js\":\"723f0a1c012357db\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-Djlkx6W6.js\":\"9574ac053ba011f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/worker-CDPWNcV9.js\":\"300a17428e4a5990\",\"/knowledge-medium/pr-preview/pr-1850/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1850/chunks/app-BJJy9Cyy.js\":\"ee09d5fb28e9758d\",\"/knowledge-medium/pr-preview/pr-1850/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1850/index.js\":\"9fd9cbec1fb0bb97\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1850/assets/AccessHandlePoolVFS-CjsnhIX7.js\":\"049857fa6c2c8ce7\",\"/knowledge-medium/pr-preview/pr-1850/assets/IDBBatchAtomicVFS-Bd8YX9nf.js\":\"b4044f5239497377\",\"/knowledge-medium/pr-preview/pr-1850/assets/MemoryVFS-B8T71J8j.js\":\"0dcdbc69f987e47b\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-DgeMTr2L.js\":\"c54753da65c0c565\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-DKE1_okS.js\":\"a8a5c5e8e98a84cb\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1850/chunks/AccessHandlePoolVFS-CQiDW28P.js\":\"5c0b884621134729\",\"/knowledge-medium/pr-preview/pr-1850/chunks/FacadeVFS-Dx4O4ggi.js\":\"6d33d55ed08b43df\",\"/knowledge-medium/pr-preview/pr-1850/chunks/IDBBatchAtomicVFS-25l0RS5F.js\":\"751dd8bc9e9161a9\",\"/knowledge-medium/pr-preview/pr-1850/chunks/MemoryVFS-D55RLrmX.js\":\"382aac0dfefe8a5e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSCoopSyncVFS-BDtQPqlC.js\":\"c01a485989fa4ea4\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSWriteAheadVFS-DtvRYo-A.js\":\"e7aa66cc06e92db7\",\"/knowledge-medium/pr-preview/pr-1850/chunks/Preview-CpsVzRvF.js\":\"0bfe970233fa6939\",\"/knowledge-medium/pr-preview/pr-1850/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/card-CSidq01H.js\":\"a180d30bc85cead1\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-YkMzEqmB.js\":\"668b298e5b3b5f9b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-3XaDUhkh.js\":\"bda9bc9ec18249b0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-async-CbRt5IV5.js\":\"924f2a0a8ccb7fb2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BKkIsf_i.js\":\"bda94e39b729daba\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CBbKheRk.js\":\"fd48a95d69058057\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-ChFoNIwV.js\":\"8cf4e4ecf545507a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-Cz4_pFuR.js\":\"7a931fa53d177319\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-Dt2KmUv_.js\":\"eab48626d020417c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-WKUxs6au.js\":\"fb084af9e456dccc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-Zb5muz6f.js\":\"541975e406054b34\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server-legacy.browser.production-CRcfGsVa.js\":\"9ddfddf40b9041fa\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.browser.production-mplNuLo7.js\":\"0d031fe287d65f91\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.edge.production-DDWR6brW.js\":\"95d7270f0fb03890\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-uuYr32oQ.js\":\"88108436a51d280b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/server.browser-y3y2Nwen.js\":\"aaca7f48424a3df9\",\"/knowledge-medium/pr-preview/pr-1850/chunks/textarea-BspYkSbb.js\":\"cdcc0001d132f07c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/ui-h0ELdPPb.js\":\"cffd68050c5b2d30\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-CKYkn7lL.js\":\"61af9430e5900fcb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-async-CTvqRNLY.js\":\"4918cebd32c5c0df\",\"/knowledge-medium/pr-preview/pr-1850/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1850/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/src/App.js\":\"c4434b75fb76fa62\",\"/knowledge-medium/pr-preview/pr-1850/src/appUpdate.js\":\"b7bd2b480a41b82b\",\"/knowledge-medium/pr-preview/pr-1850/src/appVersion.js\":\"f8581926713f6663\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/initialLayout.js\":\"e6de9f4d7a3a3236\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/openWorkspaceData.js\":\"3d444e940ae45405\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/resolveWorkspace.js\":\"9a6c5caa58a15978\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/workspaceBootstrap.js\":\"5483d5e5b779a3b8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockComponent.js\":\"377cc28052637773\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockCrumbs.js\":\"b523928ec9e98c1e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockEditor.js\":\"ffa1db6a4de25c00\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockLoadingPlaceholder.js\":\"3840d2d936ee1478\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockProperties.js\":\"d048c38d8be7dd47\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockSearchPicker.js\":\"a91c48e774aec118\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ConfirmBulkDeleteDialog.js\":\"1bcdf9a7ad9c7a95\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DividerHandle.js\":\"665daf89c3ff93f7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DraftEditor.js\":\"563e12d2a91aa90e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/GutterPill.js\":\"45512d5fc7f5ddf4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Header.js\":\"84b4221a61b83e16\",\"/knowledge-medium/pr-preview/pr-1850/src/components/LazyBlockComponent.js\":\"35c453fa39ff4b34\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Login.js\":\"2e19c69e76e8e082\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ZoomableSurface.js\":\"6a4bc599e39b11a4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/editModeKeepalive.js\":\"cfb72af9c2edc91d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyDisplay/PropertyDisplayScope.js\":\"19f6dcd727c0f235\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"71af71f1636bd014\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefPropertyEditor.js\":\"a915e933976d884b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefTargetTypePicker.js\":\"aff2929f74227545\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/SelectPropertyEditor.js\":\"af399c4062e61b52\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/TypesPropertyEditor.js\":\"6eb84bb602607b81\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/defaults.js\":\"28ca3b33bf4b7ecc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/kernelValuePresets.js\":\"d7f382cdd6ec2686\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/selectablePresets.js\":\"2201bd2003837884\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/typesPropertyUi.js\":\"bafdc3ff2edaba28\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/AddPropertyForm.js\":\"73cd4e9e275e61c8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyPicker.js\":\"cf38f9256b8f03ea\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyRow.js\":\"f91909a5f328fd0b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/Rows.js\":\"75c445a0d4fefa88\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/actions.js\":\"9b6368bcb8ccc31d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/declarationOnly.js\":\"37cc399e82e789d3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/layout.js\":\"7e46de4370cd72c1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/model.js\":\"f30bc06e44b4abc4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapeUi.js\":\"e4535748359b6396\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapes.js\":\"9bd7022b0de79434\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7ebb25e244387125\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/visibility.js\":\"7f0aa6b00c458195\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanelSections.js\":\"2f30cd9202c5eba9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockEmbed.js\":\"4f640266047e21d1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockLink.js\":\"49e1594d57d78fe2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockRef.js\":\"f38315218a970f00\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/ReferenceLink.js\":\"f66cf2c2f122d5cd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuard.js\":\"ed254b82d0f2c214\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuardContext.js\":\"657214af788a032b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/linkInteraction.js\":\"6bcd3b1ddc9bee6c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/referenceLayout.js\":\"51a1d6d7e569c92d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/useBlockRefAncestors.js\":\"f541a887a1778804\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockGutter.js\":\"fd8ca93e87018831\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockInfoDialog.js\":\"73cd2eeea97b30e7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockTypeBlockRenderer.js\":\"c7f25829c9f854a5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BulletHoverCard.js\":\"c64106a827424b62\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorContentRenderer.js\":\"e7404a2a770b662a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8f871bdd217bdad9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ColumnResizeHandles.js\":\"f6bb521517661c79\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a0a815fc8bdf20a2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/DefaultBlockRenderer.js\":\"43da9e01668ded25\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/LayoutRenderer.js\":\"63b6d340e8698bac\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MarkdownContentRenderer.js\":\"d0760dfc9e3bc575\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MissingDataRenderer.js\":\"01b395840186e40a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PanelRenderer.js\":\"6ade0fed78c9d80a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PropertySchemaBlockRenderer.js\":\"bc45597b7022c67f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/TopLevelRenderer.js\":\"1dabb70b62e5d6da\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockGutterMode.js\":\"a420d86a6b9cdd76\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockTitleText.js\":\"2469d726070ebb8a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/fieldCreationKeydown.js\":\"d4a16f6670641baf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/layoutRootContext.js\":\"b54341bc91145ff7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/TypeChip.js\":\"166677868c624edb\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/chipStyle.js\":\"fca78292cb038b7f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/anchored-floating.js\":\"749145b04ad085c9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/button.js\":\"7206dfc97107d91f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/card.js\":\"e07b23c3eb367bf8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/checkbox.js\":\"557055755ce91b86\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/collapsible.js\":\"56cc4b30d50482c3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/command.js\":\"3b6021c0b41712f5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/context-menu.js\":\"18aec381bc6f7e03\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dialog.js\":\"e1a684f9adb5dc1a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dropdown-menu.js\":\"bbd0c796edd3a7d0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/floating-listbox.js\":\"fbfdb40c7e21b237\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/index.js\":\"d9fe0b3d5f4b0bb0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/input.js\":\"bc32caa2a52171b5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/kbd.js\":\"dd8594e453472044\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/label.js\":\"c6655a8470012dd9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/textarea.js\":\"1c1674a1a879f9e0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/useEditModeYieldKeepalive.js\":\"80445500320d5f23\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/BootFallback.js\":\"2a9fc3b736e0d8e5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/FocusedRowLazyMount.js\":\"7c4c1f9fa1559500\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LazyViewportMount.js\":\"86deb9b33df8ffa4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LocalDbCorruptionFallback.js\":\"a4123d9cd1e55c86\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/error.js\":\"4ab33837e7215932\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/lazyMountRegistry.js\":\"c71999c81f891a2f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/suspense.js\":\"6eb4ab74612aac64\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/CreateWorkspaceDialog.js\":\"d7041f71f85ac6c2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/PendingInvitations.js\":\"b9d5bada93631b2b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/SyncProgress.js\":\"08fda885bac8e8a3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/UnlockProgress.js\":\"9b758750549d0819\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceKeyGate.js\":\"c235541e9fd4dae6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSettingsDialog.js\":\"ca1c9aac33a78c22\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSwitcher.js\":\"4de0b4fc0a4eaa7e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSyncGate.js\":\"19b9cbb826ec405e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlow.js\":\"02f756ab6524d02b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlowHost.js\":\"e12688c55932fbef\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/EncryptionSection.js\":\"9846c17cebf7133c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/attachmentPrompts.js\":\"b4571d9fe180cd3e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/bundleFolderPrompts.js\":\"09a44724f3333b37\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowDeps.js\":\"ca0aa4a22e24a56d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowStore.js\":\"4d23417b71ac1dd5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/flowUi.js\":\"8cfa20809acc8645\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/useConversionRun.js\":\"b59bf6fdb5fee567\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/keyUi.js\":\"6787ac662e4b5fa4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnKeyLoss.js\":\"4a1eb2eca2816453\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnServerE2ee.js\":\"4823efe13702ad07\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/workspaceUnlocked.js\":\"6d2f4f4a41707d72\",\"/knowledge-medium/pr-preview/pr-1850/src/context/backgroundSubtree.js\":\"4026a05457d933de\",\"/knowledge-medium/pr-preview/pr-1850/src/context/block.js\":\"7272de9f2332c23f\",\"/knowledge-medium/pr-preview/pr-1850/src/context/layoutWsContext.js\":\"08c1c3298ab94b4f\",\"/knowledge-medium/pr-preview/pr-1850/src/context/propertyDisplay.js\":\"a596f90322389671\",\"/knowledge-medium/pr-preview/pr-1850/src/context/repo.js\":\"cfe603d982fb9a95\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasClaim.js\":\"15e08e95a12d925b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasSeatNamespace.js\":\"ddb2e004123b9ba9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockData.js\":\"7a54f90e113809c0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockType.js\":\"00952e8af3dda30d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/changeScope.js\":\"6d68e5d72b1c8d9a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/codecs.js\":\"9808e30a4afe3751\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/derivedData.js\":\"0612000c7ab9d06a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/errors.js\":\"16e6685259b8c09d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/events.js\":\"b4ce11a7973a3de8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/handle.js\":\"34d54dca4afa63f4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/index.js\":\"114a421501bca6fd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/mutator.js\":\"1879d8e832a143de\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/processor.js\":\"348183ab6dd8b97f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/propertySchema.js\":\"a71d051eda87a945\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/query.js\":\"639d8eb8942d84f2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/sameTxProcessor.js\":\"131e0c973b4e97f4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/schema.js\":\"34d54dca4afa63f4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/tx.js\":\"34d54dca4afa63f4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/typedBlockQuery.js\":\"5df86d182c23db73\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/user.js\":\"d4cd9df76ac90b99\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresetCore.js\":\"19d3bec0c0e9edd8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresets.js\":\"2fbb2ecde15f13e4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/attachmentCleanerIOVerb.js\":\"3db44f152d6ced72\",\"/knowledge-medium/pr-preview/pr-1850/src/data/block.js\":\"c85587e19084790a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockCache.js\":\"f1a8d511df84e419\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockId.js\":\"e7f287b00921e8ff\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockLiveness.js\":\"1691c5b0fe92521b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockMerge.js\":\"ed75caa3f253b730\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockSchema.js\":\"b120a3faf0364009\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypeLookup.js\":\"d7786b8b8159d362\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypes.js\":\"23b18c784507f412\",\"/knowledge-medium/pr-preview/pr-1850/src/data/clientContext.js\":\"fe1c7f635f475f0b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/dbFileSiblings.js\":\"e920e04e61b7ae3a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/definitionSeeds.js\":\"a445782475367510\",\"/knowledge-medium/pr-preview/pr-1850/src/data/derivedIds.js\":\"d4c56edf9ccb9169\",\"/knowledge-medium/pr-preview/pr-1850/src/data/drawnSubtree.js\":\"b43847418879369e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facetBridge.js\":\"437e659c5872355b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facets.js\":\"b764231ba870c8ef\",\"/knowledge-medium/pr-preview/pr-1850/src/data/globalState.js\":\"841f78f7e4a6ba19\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/aliasClaimRederiveProcessor.js\":\"2900b15c421f97d5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/ancestorBatch.js\":\"4eea3f04e5c7e93b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/blockTypeTypeifyProcessor.js\":\"86de0d9a6192360d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/clientSchema.js\":\"50dffc0ad6115fcc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/commitPipeline.js\":\"3644089f74c3aebf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/devAssertions.js\":\"0c866d446c77b97b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/firstSync.js\":\"3e96c49b782fd4ed\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/freshInitialLoad.js\":\"83790d836302fd01\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/graphBackfillClaim.js\":\"f248795b08744d52\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/handleStore.js\":\"65be39d70649b0c4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/idleMarkerJobs.js\":\"09fc1438136ca222\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initialDownload.js\":\"c49b884a8f5b855c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initializeClientDatabase.js\":\"c71b06b336771b04\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/jsonCanonical.js\":\"7b843b5805c5f09d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelInvalidation.js\":\"c66c3a3ffcf727e6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelProcessors.js\":\"98733ef8e8b3c81f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelQueries.js\":\"c17215c2ee00ea91\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/mergeTypeMembershipProcessor.js\":\"67926c1b72df004f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/normalizeReferencesProcessor.js\":\"d94a72ad71d1c74c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/poolInstrumentation.js\":\"a4db512798a536a2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/processorRunner.js\":\"ff07dd68cd921a71\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyCellBackfill.js\":\"8f98ad8d551d6944\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildMint.js\":\"67ffa94d046e200f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildrenProcessor.js\":\"d0ab42c523d4d19f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3a1dac9607e65ff9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionSynthesis.js\":\"8535f5cf5e0e526a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyKeyScan.js\":\"b27f583db2fd8a8f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertySchemaResolution.js\":\"f923e41b792b71c7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyValueEdits.js\":\"50f68e9286c0d9af\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/raiseProtocol.js\":\"99cef21868bccaa5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/readBatch.js\":\"b3def2b5895c724e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/refProjection.js\":\"bea2509c6b3950e9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetLookups.js\":\"705f80ada9bc84de\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetProcessor.js\":\"c98ac6dcf551d70a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/replayMerge.js\":\"1fbe822df4122dce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/sqlBinds.js\":\"7ec3cbb98cb56796\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ea031c08c0eb9f48\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/arrivalProcessors.js\":\"0c67c0b70f08b6dc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/invalidate.js\":\"677e03364dbaa126\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/materialize.js\":\"ca204e00366db72a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/observer.js\":\"3b4e4188b8dc870a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/reconcile.js\":\"a319c7dab6d0d8f4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/timingMetrics.js\":\"cabf19de507f5ce7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/treeQueries.js\":\"3f0f17e8009e9f4c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txEngine.js\":\"fcb26b128e3e0bea\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txSnapshots.js\":\"5271919594a46a85\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/typedBlockQuery.js\":\"4f38e9d1f8700553\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/undoManager.js\":\"556cb5779f91ff7a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/invalidation.js\":\"222fa021957227c5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelDataExtension.js\":\"1c6c287381500d69\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelPage.js\":\"c06d1fe3c7f3ed20\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelValuePresetCores.js\":\"db5fce95caa82e8f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbCorruptionSignal.js\":\"e53e73e6b9623ecc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbStorage.js\":\"8cda886c626789c4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbVfs.js\":\"b536cba2e8133047\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localSchema.js\":\"87cbba9681b12bb0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/maintenance.js\":\"830c1f8bbd40e733\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mergeProperties.js\":\"f2dd2d521199317d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/metricsConsoleHook.js\":\"8b41f65aa8b61fd0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/migrationsPage.js\":\"e1c4497fe583d82c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mutators.js\":\"bf838bda9c1925a0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKey.js\":\"5d6a135b0c44f315\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKeyPlacement.js\":\"633271bbfdd1ef4a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/outlineSurface.js\":\"192b4a4a5009b25d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingEditorContent.js\":\"e285ef1c5323373c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingUploadsSql.js\":\"55b1428c7eea700b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pluginStateExtensions.js\":\"5f57b3ef046027e5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/powerSyncLogger.js\":\"80f26d108ce9fcde\",\"/knowledge-medium/pr-preview/pr-1850/src/data/projectorRuntime.js\":\"cf861a632e2a2f66\",\"/knowledge-medium/pr-preview/pr-1850/src/data/properties.js\":\"7f8268bf12936989\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertiesPage.js\":\"b8fd99e7a7d5da28\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyChildren.js\":\"276a82bed6a69c3c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionFanout.js\":\"52cae31a4d2ead65\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionMetadata.js\":\"8fd86edb74b7c884\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionRegistry.js\":\"8f571f7ed8b198a6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDisplayMode.js\":\"6cc347092a27017e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyRowCreation.js\":\"ebfa8ca53074ff2f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySchemaCreation.js\":\"6e231a27e02b20f5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySeeds.js\":\"0959113208447ffb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/recentsPage.js\":\"45915498344e6860\",\"/knowledge-medium/pr-preview/pr-1850/src/data/referenceBlock.js\":\"e3255a7cb8e2af0d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rejectedUploads.js\":\"c161948e2cc4fd29\",\"/knowledge-medium/pr-preview/pr-1850/src/data/releasePowerSyncConnection.js\":\"cede23f05782f4ec\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repo.js\":\"512466360c9384a4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repoProvider.js\":\"79d538149b1b7840\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rowProperty.js\":\"564178a52c0516d6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/searchFilter.js\":\"73938f733204484e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/seedIdentityLedger.js\":\"32df0f05b3cf37ef\",\"/knowledge-medium/pr-preview/pr-1850/src/data/stateBlocks.js\":\"40fa61df02bc46bc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/structuralEditPolicy.js\":\"9586b4dddafdde33\",\"/knowledge-medium/pr-preview/pr-1850/src/data/subtreeDelete.js\":\"2331ac2a634ffe1d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncStreamLock.js\":\"944c4cee87e54031\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableSqlRecognizer.js\":\"135b7f1cb3633344\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableWriteGuard.js\":\"25fac9e16eeea8b8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/targets.js\":\"d1ebec929463885c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeColors.js\":\"f8b5f3439555b0a9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionMetadata.js\":\"63fad4f4dbaed34e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionRegistry.js\":\"98e045e6b0f4ffe1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeExtraction.js\":\"0e2c793afef4f364\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeInitialValues.js\":\"06dd69ca07f7f750\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typePropertyGroups.js\":\"f81ccb65e202564a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeSeeds.js\":\"ddbe22af9982e269\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeTagger.js\":\"c7fe742c9775c2d5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typedRecords.js\":\"9f263c67599dd2d7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typesPage.js\":\"63c8265cedc91d7c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userPrefs.js\":\"e80862f5ce50803a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userSchemasService.js\":\"c612577ca52d4821\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userTypesService.js\":\"556372f4d15aa77a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/valuePresetRegistry.js\":\"a1d080fade7f1bab\",\"/knowledge-medium/pr-preview/pr-1850/src/data/visibleChildren.js\":\"9fbdbd0ea8d5ce5c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceConversion.js\":\"dda9a5f36a73c26d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceFirstSync.js\":\"f2184dff0ba8dbd4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceIdNamespace.js\":\"80eeea5e245c653a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceSchema.js\":\"3417491a22640e98\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaces.js\":\"488cce3f6ae5f784\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadLog.js\":\"8e8ec9ac32c92d43\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/BlockPasteShellDecorator.js\":\"3cac938d326191f7\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/atTrigger.js\":\"be028e1ffb556759\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/autocomplete.js\":\"48d093876925493d\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/codeMirrorExtensions.js\":\"b5b0bbc3f3a01994\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/contentFlush.js\":\"f7d766b7687e4090\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/defaultInteractions.js\":\"e0dff4c74aeaac61\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/editSettleSignal.js\":\"0373d05803694086\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/insertImage.js\":\"573405ff5538b5aa\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceCompletionRange.js\":\"4e4b921618c8d2b0\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceTargetTypes.js\":\"469b00597f9c796e\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/syntaxContext.js\":\"f195f525aa292677\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/triggerMatch.js\":\"14e8780a8c537fe3\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/AppRuntimeProvider.js\":\"3a5ae02a2878829a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/BlockFocusShellDecorator.js\":\"33b8ec22e0c4d941\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/ExtensionRenderBoundary.js\":\"bdd348c6698efcba\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/PanelContentRecovery.js\":\"38af73ca6a268328\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/apiCatalog.js\":\"78f06dc40a3f5518\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/approveExtensionHere.js\":\"19be9eefb932e651\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/armedCutAppMount.js\":\"1d4c0c72452185e3\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/batchableKeyedStore.js\":\"b487a4a25fb14f93\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockInteraction.js\":\"b990122861132812\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockSelectionAction.js\":\"4f03e217085628ad\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compileExtensionModule.js\":\"6a7f6b6ab4128d51\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compiledModuleCache.js\":\"ac837361bcc9eeee\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/continuousGestures.js\":\"5ca14ee2c9cebbae\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/core.js\":\"7d5d2c473989f128\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/defaultRenderers.js\":\"55cfbc1744e559a4\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/definitionFanoutAppMount.js\":\"d7e195707c574012\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dialogAppMount.js\":\"8cdf8104156feda8\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensionSeeds.js\":\"1febe63685d03bf1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensions.js\":\"58b4f36ece40fec7\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/exampleExtensions.js\":\"94c131255cdf5e71\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionApprovalStatus.js\":\"b3a9920bc874480d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrorToast.js\":\"b5073d1cfce9b2c3\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrors.js\":\"241f1ad8a76af3f9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLookup.js\":\"bb7e56879bc1cd95\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionToggles.js\":\"bd86ab0880651888\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionUtilitiesCss.js\":\"135581b90be03562\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/kernelPageDeletionGuard.js\":\"c43144c1f4bf5683\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/liveRuntime.js\":\"785dd810f2227179\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/openExtensionsSettings.js\":\"53558f741a7e006d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/overridesCache.js\":\"6ed701e6cc206373\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/pluginIds.js\":\"3716865fd51323a8\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/processorRejectionToast.js\":\"8f296422973b0ae1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeActions.js\":\"ea97fea9edafc9d5\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeContext.js\":\"e40ba4a5b527af30\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticAppExtensions.js\":\"83eb2daf04d8918b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticDataExtensions.js\":\"e70a7a412a2f30ee\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/toastAppMount.js\":\"ba6a1501b9285059\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useOverrides.js\":\"13ab93196087856f\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useShortcutSurfaceActivations.js\":\"a6d5401c37962de0\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/discoverToggleTree.js\":\"466e50a88205d448\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/facet.js\":\"6a5352fe00a6de29\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/resolveAppRuntime.js\":\"f78eaaa825aa4e52\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/runtimeEvents.js\":\"66a1f9bad2b6b79a\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/togglable.js\":\"9ec227939a8a4afc\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/variantFacet.js\":\"5e0d843695d6abfd\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/verbFacet.js\":\"5819ac54a896ed62\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/block.js\":\"ba12d5dcdbffbdad\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/focusedChild.js\":\"ed257d6ec7deb0e7\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/propertySchemas.js\":\"e5b72d3e2b3353ae\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/typeRegistry.js\":\"4c84bb8f9ba1c2b8\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAncestorCrumbs.js\":\"06bd68e03c9bbb9c\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAutocompleteListbox.js\":\"68730e6094d519e4\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedSearch.js\":\"050203aec18cb89d\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedValue.js\":\"1195416f7aead5c4\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsFocalRender.js\":\"ef73ead333029c34\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsReadOnly.js\":\"19f258a21c62851c\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMaterializeBacklog.js\":\"db170419ce7c185d\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMinuteClock.js\":\"38424d0adf7300d9\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePanelLayoutProjection.js\":\"c8b1115e192b854c\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePendingInvitations.js\":\"43e556d9635d81ee\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRendererRegistry.js\":\"f68afdbf96b5cfeb\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRetainedFieldRows.js\":\"f9dd211a95b8928b\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useWorkspaces.js\":\"333e6a12304a1bd9\",\"/knowledge-medium/pr-preview/pr-1850/src/lib/utils.js\":\"ec92f79fbe0802ab\",\"/knowledge-medium/pr-preview/pr-1850/src/main.js\":\"ed22e18772b497b2\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/MarkdownImage.js\":\"2b1749027294b38c\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/blockSeparators.js\":\"59b3b10bf9495324\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/context.js\":\"ecebc4ae71dd27de\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/defaultMarkdownExtension.js\":\"e66c86959d0abf09\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/extensions.js\":\"8a05bf17babd8ef0\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/renderMarkdownHtml.js\":\"c3640bb477a29003\",\"/knowledge-medium/pr-preview/pr-1850/src/minimal-editor.js\":\"14ef3b32b02bcc90\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/armedCut.js\":\"aad42ba901f4470a\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/captureMediaVerb.js\":\"58da054403a402dd\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/clipboard.js\":\"24784649cc428193\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/decision.js\":\"2dce097803a1d0c0\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/operations.js\":\"0a422da90144e6ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/AccountHeaderItem.js\":\"befee9364bc2043d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/index.js\":\"edd60f53a0f63589\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2c36651e967cc515\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askAgent.js\":\"b9a360b42dfe8c91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askedStore.js\":\"d101917e38198362\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5f3324889606cfe0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/chipState.js\":\"94aaac24f96047a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ec47c45cbf2d0493\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/index.js\":\"721e5a4540aa7ecb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c0d6b051a76da66f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/schema.js\":\"2841e40a4da7bc10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/AgentTokensDialog.js\":\"711c9524d3297387\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7c8ca673310d88bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/addMedia.js\":\"73f086f85d67ea5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b6f012c063d36185\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/block.js\":\"2ebacf2b7cc07382\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/context.js\":\"9e28ea2a703ec8ce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/displayIds.js\":\"106d972059210ec5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/index.js\":\"ac03b67e400c9207\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/outline.js\":\"e4d92bdd15dd36ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/properties.js\":\"88730e80d7b9844a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/refs.js\":\"2ec3990294c51547\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b5161225cdada34a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/search.js\":\"8d802b9ff9e516c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/shared.js\":\"7543fc956ad451f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c2edad0d07d81f0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/text.js\":\"37e7f81159c523de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentWrites.js\":\"0c82c0a7e4991330\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/authoringCatalog.js\":\"5c5400d4a648d53a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/blockRefTargets.js\":\"8a370cfdc6cde441\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridge.js\":\"af90219b5eb1d190\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridgeLoop.js\":\"67ff67c15d1fe893\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/changeHistory.js\":\"2548707bd14d2a6e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commands.js\":\"fff18a9ac82400b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commentsCommands.js\":\"3d7c60ae78f62649\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataExtension.js\":\"f4479f39d4a5d4e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataModelGuide.js\":\"92dc24d80d2f9a42\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/describeRuntime.js\":\"5630528879d2bebb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/extensionLint.js\":\"d912856f9759a162\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/grainAudit.js\":\"c451859669110ed5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/healthCommand.js\":\"0516ff66e85f0fdd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/index.js\":\"911368cd27bc4677\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/presetIdentity.js\":\"dce5453201654290\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1a713f3af0c7a678\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/readMedia.js\":\"549064bfb8351716\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/schema.js\":\"2efd7d0f1ec215fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/serialization.js\":\"4297716a598fab0e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/targets.js\":\"422c21650e3b3a3f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/tokens.js\":\"da4c83c075d18963\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/watchEvents.js\":\"4a7a0b1dd993613c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/workspaceGuard.js\":\"f11f76081d66f683\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/writeCommands.js\":\"65687f1193425c71\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/AliasCollisionToast.js\":\"364b1af7b26f38f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/DuplicateNameBanner.js\":\"4a11503b2d5792f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/collisionMerge.js\":\"48e7a1b823c15b5a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/dataExtension.js\":\"5810f084750bd655\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/index.js\":\"01e372264f80ebd5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/mergeCollisionAction.js\":\"3cf43739032215e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/pageStyling.js\":\"f8949296ed6582b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/rejectionToast.js\":\"089d418fed2b39fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/syncProcessor.js\":\"e97ec3e44543d24c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/actions.js\":\"0f4cb4f36befe2df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/addComment.js\":\"c56e778b57bff85b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchor.js\":\"10973c1a7d41033f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchorState.js\":\"79df4aa593de034a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/commentLinks.js\":\"c2a447eccb296dc7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/confirmThreadDeletion.js\":\"6f7c94947dbe1ca2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/container.js\":\"a24627ffa27e65ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/dataExtension.js\":\"7c3cf7ccfd9f6220\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/deleteComment.js\":\"c27572533b72f7fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/highlights.js\":\"7b0e0bea51897f18\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/index.js\":\"7c6f042b195a3057\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/linkedCommentsPill.js\":\"6193e3c8b215ef6f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/margin.js\":\"f2899192b7028583\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/marginSchema.js\":\"3a13fbabec70dd63\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/newComment.js\":\"49894845093786ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ownThreadPicker.js\":\"fca3526ab7d3b22f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/placement.js\":\"9066294729bdd3a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/queries.js\":\"716737ec35a4f825\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotePosition.js\":\"b0b3fada7bc6ea8a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedIn.js\":\"895f7c5a92857cfa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedRange.js\":\"00eabd50832d0056\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/rangeRefs.js\":\"5b020fa3a3542d60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readHighlights.js\":\"dd8998da3283d92e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelection.js\":\"a431d5996e14c062\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelectionUi.js\":\"29b8f5c90bb161b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/reanchor.js\":\"abcc308a152bb285\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/schema.js\":\"d47bace717432aae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scope.js\":\"12e421c58f59c5ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scopeThreads.js\":\"28dcdc8a65662391\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/splitRetarget.js\":\"2cce50d93ae9d89c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestionCard.js\":\"db08cea86a404fb7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestions.js\":\"429cb6563886312d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaries.js\":\"0e54c19b10893129\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaryBatch.js\":\"64fcfc779ab1be4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/surface.js\":\"4e2b7764371dcd16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threadNavigation.js\":\"e7fba363eb1acff3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threads.js\":\"9108ff77c648150c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ui.js\":\"4fbbf7acb38dbaa1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/uiStore.js\":\"8ec6b49745931a5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/appIntents.js\":\"77bb97eb82d50550\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/index.js\":\"6eb5d391dc4b9913\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/index.js\":\"78e4804c0a832f9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/status.js\":\"9a908c3786f518d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"3b766d58b8214ec5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaBlockRenderer.js\":\"f922eb59672ec595\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaDownLaneReplicator.js\":\"145e82888cdb6e53\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaUploadReconciler.js\":\"bf7060299f281a7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetDownLane.js\":\"cfe44c5e417e712e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetResolver.js\":\"57cd0893290831b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetUpload.js\":\"5fb21c1dbbcad13e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/attachmentCleanerIO.js\":\"4635df341e02c1db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/supabaseAuditIO.js\":\"7e89d25f6f57b100\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/blobStore.js\":\"c07bb45f5af60a00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/byteStore.js\":\"b0ca3494be07b42b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanerIO.js\":\"47fe032b93d2cce4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanupAttachments.js\":\"38f9aa09ec21acc5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/dataExtension.js\":\"b5c2b9da71fbd8a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/downLane.js\":\"6fd649abd6f6be5f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/index.js\":\"6a7038d9f13850cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/insertImageContribution.js\":\"33670248e9006576\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneArming.js\":\"48702bad2d21d3f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneLock.js\":\"473ec29470c1e1ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaBlock.js\":\"0ce11377a845fbe6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaCapture.js\":\"f191f42a5c11d117\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewers.js\":\"b3ef4e31b2e71582\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewersFacet.js\":\"0869577798ec8bbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/pasteCapture.js\":\"24ea4e201ade291e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/resolver.js\":\"1f8ae5c50b04aa02\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/retryUploadsAction.js\":\"69c04d6331fbd773\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/storagePaths.js\":\"3e0814eaa76ed525\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadDrain.js\":\"ce1904afe827c3cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadLaneStatus.js\":\"1443862d77d04b08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadReconcile.js\":\"6cca4b0bed57e678\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadRecovery.js\":\"ffe07879cb7aa5cd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadStore.js\":\"37dde4f7f152ddcf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/useAssetObjectUrl.js\":\"bd17b4dd2c88232e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"29ff33aff4267881\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5c25a47e237c76e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/facet.js\":\"7d7c99355ad5574c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/index.js\":\"d28cab7ef3e6d309\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/prop.js\":\"cd4347624d603d63\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinkFilters.js\":\"a78fd0010633692a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5ceb601cd60cc20c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BlockEntry.js\":\"d3b5230d87c0d165\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/LinkedReferences.js\":\"73da5b4fbcdede72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9df6a4c8538464c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dailyNoteDefaults.js\":\"034d41807071bf6a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dataExtension.js\":\"30e86524c21758c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/edgeExclusions.js\":\"3db488c1f209d3fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/filterProperty.js\":\"aae298e96f0c86aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/index.js\":\"6cda2f707d35db0b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c9e533d8a7c3eda6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/applies.js\":\"6feea7f0cd85c799\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/countQuery.js\":\"475d50e852d08cf6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ef695eff8c7172cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/index.js\":\"2d1640d1dd030137\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f70c5a756003c33c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/presentationInvalidation.js\":\"978f4b91d246c584\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyEditorOverride.js\":\"e12506df3d1b96eb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyFilter.js\":\"81e4b8d542deaca3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/query.js\":\"9a73e11b2eeac7bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/resolveFilter.js\":\"6ee8a1c9e249eb6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sourceBatch.js\":\"a4d15f3361343435\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sources.js\":\"34b5b34d149d272e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useBacklinks.js\":\"d3e03794e1c1cef9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"8c7413e96f4d5584\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayCelebration.js\":\"e37328466fa3f97a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayOverlay.js\":\"a745faebc03bfb0c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/gate.js\":\"37940d92ad88fe04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/index.js\":\"0069f337a880bf95\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/wolfTheme.js\":\"23c9e65ab9fbe6ce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/BlockDragLayer.js\":\"f2b629ee2f2b863a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dragController.js\":\"508614bca2764d90\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dropTarget.js\":\"7ccf07b8d9ebc6c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/index.js\":\"e051025522ead8ce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/projection.js\":\"5695c6a33440b105\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/BlockMetaCard.js\":\"2ec8bc66ed015166\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/index.js\":\"b171dbefaa201ce8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/AddTagDialog.js\":\"4a12be344e66b8d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"41a19e50cd0d031a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/TagNameIssueHint.js\":\"7bc4415a8913b40e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/addTagAction.js\":\"a3ecebcaf85c60bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/appendTag.js\":\"44824b66d9bb2568\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/config.js\":\"d567bf64e683c1f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/dataExtension.js\":\"8984a6538ad7c495\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/index.js\":\"d5acc1e663b76091\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/propertyEditorOverride.js\":\"176e4b17a449259a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbList.js\":\"cbed9f013dfa4a42\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6d0f9b3ca6ff9ec0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a6dd19a98a6ea503\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"198a6a2705beaf84\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"13d90d2fd6533d9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/index.js\":\"866e8512d3bd52f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"3b11aff32457eb20\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/CharacterCountItem.js\":\"5c357fdd19210f83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/ProfilePropertyEditor.js\":\"80f3b1e965b9a3c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/actions.js\":\"c68b53070d8a79db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/blockType.js\":\"09cc9e9248f5938f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/charCount.js\":\"849cb44810cde130\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/dataExtension.js\":\"3ef4ca88d08d7469\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/index.js\":\"839806695c34d5a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/profiles.js\":\"43b35bee2b2b33f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/properties.js\":\"22c8398a2fc9b90d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/textCounts.js\":\"0ac35faa3d7f4c42\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/colemak-keybindings/index.js\":\"70de51e34943d866\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/CommandPalette.js\":\"0a4f1dc2a4409fb7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/HeaderItem.js\":\"f572c46706a193bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/context.js\":\"9b83a6be5ff79e3f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/index.js\":\"cd3d00647d83bc82\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/selection.js\":\"2d6ae2ffcfcb06f2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/toggleStore.js\":\"f037fbb1221ca1f0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/useCommandPaletteActions.js\":\"7b419ab05395df81\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/ContributorBadges.js\":\"83deb6ed2614e695\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/author.js\":\"055110fcea981392\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/codeMirrorExtensions.js\":\"183eb27f8c736787\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/dataExtension.js\":\"06d27bc732d716c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/index.js\":\"4aa39a549cbf6554\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/mentionAutocomplete.js\":\"4271a0ce82589931\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/processor.js\":\"538cdd751348440e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/profiles.js\":\"5027fb4275f149f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/queries.js\":\"f4eff4e44c01ce71\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/schema.js\":\"fe45a33d7a091456\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d62d4e58ca9e2cda\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ce73007838f63f96\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/index.js\":\"9adcffa86a267999\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b2fc4458b9c9f1b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e97ccd74c2ccb3e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/CalendarGrid.js\":\"748a384255797a4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DailyNotePicker.js\":\"9a15a62f42061f4d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"27a4b1b055b3453d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateNavDecorator.js\":\"650a2e86cfee2acc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateScrubOverlay.js\":\"ed6478979712f8dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/HeaderItem.js\":\"4a4ef0535a6ff10f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/ReschedulePicker.js\":\"5a893c66e71ed75b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a01c81556f5ed89d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/actions.js\":\"eb478281f936fac5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/blockDateAdapter.js\":\"48fdde7318a1fbfa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/calendar.js\":\"ad3a5b9d8a6b4684\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dailyNotes.js\":\"38653d55779b671a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dataExtension.js\":\"6be3849f038bdc78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubActions.js\":\"6b65f25e1e39763d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGesture.js\":\"46b766ef5c94c99a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6d03d61ea1766472\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b15aa9a17d7c3897\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/deletionGuard.js\":\"fd29fb3f20aeac89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dueQuery.js\":\"bf49ca83033b0aca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/index.js\":\"8555beb5149569a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/landing.js\":\"329c700831b83935\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/localSchema.js\":\"e86d6116d7195641\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/referenceDateAdapter.js\":\"c230846d49720123\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/rescheduleAction.js\":\"9a534ad0357f4e4d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/schema.js\":\"8759643a22da4f58\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadBlockDates.js\":\"4bd9d6b6e7242f20\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadDatesAction.js\":\"60819c697fa8eb95\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/today.js\":\"e1d69e6eb60d30d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"60747234f88c4a05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a6a2d60c777b9667\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/audit.js\":\"2fea18eb755c40c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditAction.js\":\"fde8d8c417083c1c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditRanges.js\":\"6de2c38794503cc0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/diagnosticsSource.js\":\"da65d48ba3fcd3a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/divergenceScan.js\":\"5039d5d3cf489207\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/index.js\":\"40478244ef8de449\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/propertyChildrenChecks.js\":\"325d527ce0d8ce81\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/referencesMirror.js\":\"784d39514754f41d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/rowJson.js\":\"1e678f55ea58b835\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/schedule.js\":\"15004265f0768ca3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/store.js\":\"0976422c5d05f41f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/action.js\":\"64bbc7a4070300bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/index.js\":\"a100f2435ea5661e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/plugin.js\":\"7fb0fcdc0e31f4ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"18fda8faaf22151a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/actions.js\":\"020b0286e008ef89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/changeMarker.js\":\"ab0fd64b600b03ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/diagnostics.js\":\"99695fcc489ecc04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/fileSystemAccess.js\":\"3c1ad5593d97ede4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/filenames.js\":\"ad8260edf6c09c21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/index.js\":\"f388d57a6ee4baa1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/mirror.js\":\"dbb2e205f93c3895\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runLock.js\":\"70473196de357f7f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runtimeHealth.js\":\"90a2c7dcd28285f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/schedule.js\":\"79ddf5e2ca42d24f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/store.js\":\"f3e1983b790e0b28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/index.js\":\"3cef916ee62f79e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/themes.js\":\"58e6f8246f385bef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/facet.js\":\"565daa7b1db9977b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/useDiagnostics.js\":\"b0af3cefda898b00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/dismissals.js\":\"6d6ea9f5ac966f0d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/index.js\":\"8e39ec8def622ffa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/status.js\":\"b3015fb4096d7af7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/store.js\":\"2a4adb53d3172216\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9354dcf238ce92fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsSettings.js\":\"04c7e76fd75b57a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/actions.js\":\"f0e77423053c72dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/config.js\":\"75c690fd09e86989\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/dataExtension.js\":\"a9a14d0abb876d6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/effect.js\":\"38deeb0c98eb0232\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/index.js\":\"095526f8e966e896\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0ad09813a026c2db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/useToggleTree.js\":\"e1478113ef80b16b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/ExtractTypeDialog.js\":\"eed5a594f67bfca5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"907b54620f33e253\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/PropertyShapePicker.js\":\"9ba5166a41ca0d55\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/action.js\":\"cd17cc61440b229d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/index.js\":\"c008303f8988a8f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/FindReplaceDialog.js\":\"dc872e5bfac6ecde\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/HeaderItem.js\":\"acab4b57013eb468\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/dataExtension.js\":\"ebf143503612fe05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/index.js\":\"3405cd5a58acd724\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/search.js\":\"a8492ff0b6dd6a44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/toggleStore.js\":\"3a0d885cbf69eec6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/LocationPropertyEditor.js\":\"e7a414b6b4b972e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/MapView.js\":\"e5a74064433816bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/blockTypes.js\":\"6b8f1282f96a2cf1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/codeMirrorExtensions.js\":\"69cd85afc4574dd5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/createOrFindPlace.js\":\"4a133849d5f87b48\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/currentLocation.js\":\"0e816d51cbf0905c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/dataExtension.js\":\"428088c668490136\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/geoContentDecorator.js\":\"0bfd0d5aca3707ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/googlePlacesClient.js\":\"c875f1cd49ae3468\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/index.js\":\"74f922986cf81183\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/locationsPage.js\":\"db78022571078f1b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/mapViewport.js\":\"d2893455d41f50fe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/pickCurrentLocation.js\":\"afcfba1df354f1e3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeAutocomplete.js\":\"685e9511bbabc342\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeNameCollision.js\":\"aaee31281523136b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/properties.js\":\"0180c13ebe8df38d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/propertyEditorOverrides.js\":\"c7fecdb58f57ae41\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/query.js\":\"88f93dbfdf1a07b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/usePlaceSearch.js\":\"c90ae98f18b494b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9c601e0ba2f6bced\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e69356ad58cdce1b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b19783bed70d31db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/config.js\":\"3ae3ad1eaffe432b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/dataExtension.js\":\"af074b29d50efc68\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/facet.js\":\"0d44fd59d84666b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/grouping.js\":\"1462a70e868d7daf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/index.js\":\"95865e1516455b60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"bc9f97667b12381c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/query.js\":\"4562823c12b83189\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/resolveConfig.js\":\"50545c5e4c6f4ab5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"765f3ea416f615a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7391e6c867779836\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlDocumentContent.js\":\"eedd74cffd07bd9b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlFrame.js\":\"9436143649feb644\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/actions.js\":\"af2466e82bc5b003\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/blockType.js\":\"8b5e1068608c3ad8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/confirmRunScripts.js\":\"335e35ff7ea5cd8e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/dataExtension.js\":\"edb25879ff6ce05d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameAnnotations.js\":\"d1a3548d9bd6d9d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameDocument.js\":\"295e90113d9d0b04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameTheme.js\":\"7af29eb039aa326f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/index.js\":\"8ffc4a84f294f66f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/scriptConsent.js\":\"e492fd0e45bc7949\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/sourceMap.js\":\"041b2856b5c94ae7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/useDocumentScripts.js\":\"72f969f421ac0647\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/index.js\":\"0d8aefd0666a971d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/record.js\":\"d3bc247757e08a97\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/recordStore.js\":\"72a588ad845ae86f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/responsiveness.js\":\"7cc8bbeeeb69eafc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/schedule.js\":\"9987c0ea13acb677\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/sessionContext.js\":\"675b19753d4d0ebf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"cb4ec67ae7ab6116\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"73e2c6e75bbdf709\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/actions.js\":\"31f8c06511e39cce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/config.js\":\"61342cbec901c960\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/dataExtension.js\":\"7a16eba7326ed59c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/effect.js\":\"962325e60f44989e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/index.js\":\"3f152724cd12e8ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/keyCapture.js\":\"ac258872f1ad9592\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/overrideStore.js\":\"927239ecdec8048e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ba82fde1fa81a269\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/HeaderItem.js\":\"f0ab61d3c5e6f203\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/LeftSidebar.js\":\"4c7c9d0c2ee515fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/actions.js\":\"14a7e617f7891e38\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/facet.js\":\"04f6006dbfdb40cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/index.js\":\"ce0734d003ca6a58\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/shortcuts.js\":\"ad140bc9f8ec92e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/toggleStore.js\":\"ebb075d3b2fd4c76\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/MergePicker.js\":\"858bd1e16fe28863\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/index.js\":\"747ae027cc923ac5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/mergeAction.js\":\"c1f8c3c484aa6b01\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/strategy.js\":\"b91cc02749942a77\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/Button.js\":\"7acbe21ef6c569df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"146417c5d5d46966\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/defaultItems.js\":\"73edbb523ba6de9b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/facet.js\":\"2ba0a19d1857d951\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/index.js\":\"7f2a8fb05acfe157\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f0e7451fdc71702e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/actions.js\":\"54d472fe6e0e6613\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"4817e889aef1f7ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2fdc13c53851c541\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/index.js\":\"f4363438362b1b32\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/MoveDestinationPicker.js\":\"237e18ad662ab715\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/blockSubtreeMembership.js\":\"680e3337b3045b77\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/contextMenuItem.js\":\"af0a0f549d4cecd0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/index.js\":\"f169f5dd23a43fe7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveAction.js\":\"2333ceea25e4744a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveBlocks.js\":\"fcbe9834fb9bb6fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/selectionAfterMove.js\":\"1172974109e5188a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/TutorialBanner.js\":\"7b86b205622d0879\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/action.js\":\"5de24c58dd961340\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/bannerDismissal.js\":\"24add13325f68b10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/documents/cheatSheet.js\":\"0a3fff2ac24bc54b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/index.js\":\"ba6702cb01eb3df5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/keys.js\":\"ee46374e6f1854a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/landing.js\":\"8159528a6a999171\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/outline.js\":\"da6eda0d496c4003\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/seed.js\":\"c0980eb198e740c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4aca9b72ee7de567\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/analyze.js\":\"974a39be632f2c9b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/diagnosticsSource.js\":\"5747d14163d311fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/index.js\":\"25a2f9bc8df7ca31\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/load.js\":\"a5378d454de1823f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/monitorRun.js\":\"d60fa47f7c8ebd15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/schedule.js\":\"ba02b087d3fb63cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/series.js\":\"1503ee67d542af6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/store.js\":\"f46d693674a804d1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/trendAction.js\":\"4540e051cbccea8a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/verdict.js\":\"abac594df9d095f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/clickToEditAction.js\":\"472e4384a86ba72b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/index.js\":\"9c41cde445df89fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/interactions.js\":\"c98a16d49e372d81\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9a4da95d5d7e8c35\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGate.js\":\"5595f3c14f76272e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGateDialog.js\":\"7afa4469ff303c34\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/action.js\":\"c806f97906c1664e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/index.js\":\"5bcb88c2e6689c48\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/localRunMessage.js\":\"b7de511cb630a090\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/plugin.js\":\"7d807ab1b8d61409\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/progressReport.js\":\"67a88b3f02e223fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/sweepProgress.js\":\"7a6ed5339e53a762\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/FieldRowRenderer.js\":\"205e3d1e2f34e2fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/ValueRowRenderer.js\":\"1fa25ecd24ce699b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/actions.js\":\"1ba96f8b70277695\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/autocomplete.js\":\"eb2460624a8b0e0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/fieldRow.js\":\"478704b4a4435fce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/index.js\":\"c94a4a0186333385\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/referenceWarning.js\":\"fac344dac57ab92d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueAutocomplete.js\":\"0ae68eeae32072d1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueSchema.js\":\"f1da3fdea1c4d2e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/HeaderItem.js\":\"ef77bf3116676969\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/QuickFind.js\":\"ec2f154ade915a03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/index.js\":\"42ebf80f2adc5c8c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/recents.js\":\"1a1a4d3dd68eac57\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/resultItems.js\":\"66626867b144e01f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/selection.js\":\"5a767bf8876ba6f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/toggleStore.js\":\"af8af69b27a6e9cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/HeaderItem.js\":\"146e0adae7336a28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7a63f20f59651b58\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/grouping.js\":\"4f0f390d9f444e20\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/index.js\":\"41cc961075b4b128\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/target.js\":\"8aa7af5a53686df1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/codeMirrorExtensions.js\":\"a7904abbb1f4e304\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/contentPrefill.js\":\"bdd099bed4f2e871\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/dataExtension.js\":\"7d9d307d51de53d9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/index.js\":\"d870fcc4b3559bd7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8952f9c5d22c3013\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/invalidation.js\":\"c35e459ab9640b39\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/localSchema.js\":\"060a7d07bbd6fcc7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/index.js\":\"8a50247cfe45ba51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"97ab160b78d4dce1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/index.js\":\"5aea043af7c4a2e3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/referenceNode.js\":\"2d321a90e364045b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/remark-reference-occurrences.js\":\"39256c8002567f3c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3ff2a0dc5c829235\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/index.js\":\"fe9c2281b0d46c19\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a4951bae26594be5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"31513d3af573eb0c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/mergeRetargetProcessor.js\":\"43c985ae67c39d84\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/parseFence.js\":\"5dec67443f925a14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceParser.js\":\"088de4ee94fc9450\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceProjection.js\":\"53149288f9e8cb7a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referencesProcessor.js\":\"2f3211113acb7c16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/renameProcessor.js\":\"9e76ed3cb2913be1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/spanReplacement.js\":\"858b44b6bd1055d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/htmlToOutline.js\":\"7569b14cb3ed4521\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/index.js\":\"c17938f789dee492\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7cf99a9a7653dcf9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/pasteDecision.js\":\"63df32db8b2526a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/action.js\":\"ef7950ff031b7714\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/blockIds.js\":\"c1ab71b75856cfb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/content.js\":\"2709b8dac25e10d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/effect.js\":\"2b4f35dc322a7fc0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/ids.js\":\"e9b9d798ffc15bff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/import.js\":\"bfee79de2acf96ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/index.js\":\"0dfc25a233202a00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plan.js\":\"e6ecf4cf22e9f7b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plugin.js\":\"c81bcdcfe50ed40a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/promotion.js\":\"b35386ec5cb4f9eb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/properties.js\":\"fc075f56a2f50921\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/references.js\":\"9335fc5f9a0d08c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/report.js\":\"288088c30c9a3e75\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/roamMemo.js\":\"ed3269e4ae6b669c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/runtime.js\":\"4fc5c5013d6476a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/schemaReconciliation.js\":\"2794d2a3b245ca21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/srsMarkers.js\":\"7f0d7eb5b41bc096\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/todo.js\":\"d2abd2db489a7a41\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/typeCandidates.js\":\"54e5b9730d784728\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/types.js\":\"277052a8f84949f2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/index.js\":\"856e15280b66f7df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/store.js\":\"2e738c699f7c1060\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/HeaderItem.js\":\"25fa74deeffc807e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0b280f73b35c9d19\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/index.js\":\"6f3ee530c69b2abd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/model.js\":\"235ee6669c2578f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/toggleStore.js\":\"f5db53e38f1eb491\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/useKeyInspector.js\":\"d391421319c959a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3ac7b4f8e3fdc82c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/ShellDecorator.js\":\"1ab4146c6d1961ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/actions.js\":\"6b72718b347e78bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a59d6c7942ac6114\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/index.js\":\"0b8ca6e009a3a0c3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/shell.js\":\"b2870617f4418f9b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/surface.js\":\"22f4cab84cbb15a0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/walker.js\":\"a6f56d0263baa902\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8088189a261a49e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/dataExtension.js\":\"2122af735b5ffe4b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/index.js\":\"21a7837058059916\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/indicator.js\":\"2a7a08e6e2e5b6bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/moveSrsState.js\":\"c37a3484f1709a02\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"60acbf304fb24f0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/scheduler.js\":\"5f29c35d9eac385d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/schema.js\":\"a9933bee6ac0d848\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6db5bc1cafacb47c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsClipboard.js\":\"48acdeccb078ad99\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"143b33bf7f504d91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1f6984dbe23243ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DeckPicker.js\":\"fb181857f7343d5a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewControls.js\":\"0ad25db5fb47c4e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8d85cb7ee307bf35\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewSession.js\":\"13b6d9908e15bf86\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/actions.js\":\"f95242ef28b914f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/archive.js\":\"70b78ba8bb3a6f83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dataExtension.js\":\"9d19db2862a7f52e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/deck.js\":\"96fb684727292a30\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dueQuery.js\":\"fb2b685eeb2cc621\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/gradeDecision.js\":\"53433c1c4407fc0f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/index.js\":\"24555f0a19721800\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/keyHints.js\":\"9910193787d6558f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewCardLayout.js\":\"5148e155388d309e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewProgress.js\":\"69620c7b928014cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/schema.js\":\"6bd0126fdf8b9ad6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/useDueCards.js\":\"7206d4ac924f8fab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/index.js\":\"e8d884f9eed911d1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/record.js\":\"9cdb1eb067ae3ea4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/index.js\":\"8a57671f37804659\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/persistenceStatus.js\":\"75e93d2a1b0c7f90\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/requestAction.js\":\"2fe0e62b610c06c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/TypeChipsDecorator.js\":\"9d8f37e916bfcb93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/codeMirrorExtensions.js\":\"76c863616032104d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/index.js\":\"cf7ff8b834632cf8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/typeAutocomplete.js\":\"1221ea4ce2e13227\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c91033d21eadecb6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/actions.js\":\"6c85382ff6333cc2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/anchor.js\":\"f939579b9954cd16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/events.js\":\"53f83578d8e80c1e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/gestureActions.js\":\"5405cbccd6ba5dfd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/index.js\":\"206bfef8499f88b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d2c2e0f9d6838c58\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/collect.js\":\"f0260c689a4b698c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/index.js\":\"35d5e34c6cc448e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/record.js\":\"1a28266566555dee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/RejectionDialog.js\":\"dd8a0f78602e6c3e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0019257fd17934e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/index.js\":\"0a49f5aa49a6eaee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/model.js\":\"accadd7d4626f167\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/queueCounts.js\":\"b63feb713090f9e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rejectedHelpers.js\":\"679c4d30e8d026f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rematerializeAction.js\":\"a04c57cbb585ef44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/useHysteresis.js\":\"9eb54aef181479aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/ColumnHeaders.js\":\"10ea150bbf99a764\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/QueryUi.js\":\"a836f445d56f16a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/TableLayout.js\":\"c63bf1ef63879ae9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/actions.js\":\"05271514bdd37f4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/cellEdits.js\":\"f1ede2ca9d3c5b99\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/columns.js\":\"337b5b143142c146\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/controller.js\":\"dd896b3c57faaf96\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/convert.js\":\"ae3e0be5769d4edc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/dataExtension.js\":\"51657dd1a58f32c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/index.js\":\"87ffa18389da8dd8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/keys.js\":\"4ac3c939695762fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/model.js\":\"c2a25e48ffa7ac52\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/backfill.js\":\"7f5617e800d55712\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/format.js\":\"d8c52963796b24af\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/parse.js\":\"703d3c3214f1a7ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/queryValue.js\":\"30e7897d92df2ea1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/source.js\":\"bd7e73b4cc1922b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/registry.js\":\"28259a2c370ace93\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowGutter.js\":\"d61864dcf2b598b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowVerbs.js\":\"dd6788d3fe739e7f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/schema.js\":\"90f4df2b7e1b1094\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/sort.js\":\"e044a34908156dad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/effect.js\":\"381171ffabe8807c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/index.js\":\"2e574cb5f1611542\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/theme.js\":\"76170337262c2b15\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/actions.js\":\"1270c83189aa9189\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/dataExtension.js\":\"97716aa806dc9b3e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/index.js\":\"c9638e3e0f9078c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/schema.js\":\"1934286495c09981\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0ff944ecbfdfd44e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/actions.js\":\"56748a186447229f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/defaultItems.js\":\"938460106755eaf2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/facet.js\":\"654c4f24a1cd6cb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/holdRecognizer.js\":\"520ad4a7806959b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/index.js\":\"901e2021a7468f0f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/UpdateIndicator.js\":\"c2fc427b85e061c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/index.js\":\"12376041d752e7b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/loadTimes.js\":\"4757be33fa4048cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoNotesRenderer.js\":\"a4bba24b3b563f27\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoPlayerRenderer.js\":\"8647bf325e585a05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoTimeStamp.js\":\"60b6331f2584c08b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/actions.js\":\"8154d1f551105d1e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/index.js\":\"bc20f6002da0db72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/markdown.js\":\"0df05f7a354c4301\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/notes.js\":\"c07da245039336b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/registry.js\":\"d3301d937ee99c22\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/remark-timestamps.js\":\"7a24846c2eece2e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/view.js\":\"4303c07ea0aa77ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/LinkHints.js\":\"95264ad23939359e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/index.js\":\"f19d58ced684b906\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/model.js\":\"d9399fb4b074379f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/settings.js\":\"573f5b907ad8efb3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/actions.js\":\"1a730adffa05e1ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/index.js\":\"5672ac72daf3cb44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/interactions.js\":\"1fce727285e3eaf2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/workspace-header/index.js\":\"0b39f30ba0ee0f09\",\"/knowledge-medium/pr-preview/pr-1850/src/registerServiceWorker.js\":\"e8beeb180bb63876\",\"/knowledge-medium/pr-preview/pr-1850/src/requestPersistentStorage.js\":\"c2ae4675f20dea7c\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authRequestDeadline.js\":\"d874a969ee2b4af8\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authStorage.js\":\"d1a5852574e089b1\",\"/knowledge-medium/pr-preview/pr-1850/src/services/powersync.js\":\"2bf4fe00e4eecf81\",\"/knowledge-medium/pr-preview/pr-1850/src/services/supabase.js\":\"0760da4605e9dab1\",\"/knowledge-medium/pr-preview/pr-1850/src/services/uploadErrorClassifier.js\":\"3aae705851166f0d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/ActiveContexts.js\":\"30b3aec89dd2f9d0\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/HotkeyReconciler.js\":\"aa47c594e926ca52\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/WipeLocalDataDialog.js\":\"afbb92daa972c22c\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionDispatch.js\":\"026b8f7b6687c012\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionRefItems.js\":\"76eeb4b14bd4d8b3\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/applyKeybindingOverrides.js\":\"67c8a0311a86b539\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockActions.js\":\"09bd400ea70ed158\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockMergeGesture.js\":\"cb839b36a237cc10\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/canonicalizeChord.js\":\"66d0a98730be688f\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultContexts.js\":\"85827f0820ff9556\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultShortcuts.js\":\"03cb583b62c5be4c\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/effectiveActions.js\":\"c832f723baaba415\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureAction.js\":\"11dbab663da53774\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureBinding.js\":\"2a7379307073a036\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/holdRegistry.js\":\"15aea16e6ecf39ae\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingConflicts.js\":\"53fd706233c9d4db\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingOverrides.js\":\"419cdb06c569ca3c\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/pointerAction.js\":\"6529e02517352f03\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/resolve.js\":\"55f4e4cb8f0d7aac\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/runAction.js\":\"3021e38a93606155\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/sequenceMatcher.js\":\"78793c9710ab1fb6\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/types.js\":\"a1ec028419164e2e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionContext.js\":\"2e5a005ba66f6ceb\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionDiscovery.js\":\"62ca486c7bf1a7d6\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/utils.js\":\"314c4954eea19f62\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/bootStore.js\":\"e6ce87e3dcdb998f\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/previewDatabases.js\":\"77efbb5bc6207106\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/byteTransform.js\":\"3e36476f43e66db6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/attachmentCleaner.js\":\"f54b7440efe7e1ad\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/attachmentParts.js\":\"806b1b51e2af4f41\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleParts.js\":\"e4c79cc44cfcad20\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleRecord.js\":\"bb2922839361af8c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/manifest.js\":\"9d11e0c7b4bb2ae7\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/takeBundle.js\":\"03dfdfd233e9dbd5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/verifyBundle.js\":\"21fc2b7a5d5ca48b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/cleaningStage.js\":\"c0476e3c38649831\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionKey.js\":\"146d3f09e5ff2a31\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionServer.js\":\"3d0924a4e8c5de2c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flip.js\":\"8d31869f64f1e091\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flipAttempts.js\":\"11f87c60d0d39a63\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/pages.js\":\"152e0f4c0129fc88\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/preflight.js\":\"09fe47b3f432ecac\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/reseal.js\":\"b816bb699c8fe74d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runConversion.js\":\"87bbf44fbfb21303\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runLock.js\":\"b5523ec5903a5c3c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealing.js\":\"0da477355d3bb3cd\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealingStage.js\":\"d5627b65fd155851\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/stage.js\":\"6ead72e29942044a\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/verifyReseal.js\":\"3fadc496db8f5d3d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aad.js\":\"5391aa66305f3f91\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aead.js\":\"919ed0c941bccfff\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base32.js\":\"f05f996c70a71b1f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base64url.js\":\"fbf88dca66406292\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/binaryEnvelope.js\":\"a7a4d1cc3687c3c7\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/byteAead.js\":\"71cb8ab05b4ac21f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/canary.js\":\"133b3d6cd13ccae1\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentHash.js\":\"083a6bff69ae668f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentKey.js\":\"afae2f9f148952b6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/derivedIdNamespace.js\":\"5a5b5ca55b7aca85\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/envelope.js\":\"1b547e16a4bc4b09\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/hex.js\":\"1b9c4d8f336cfdc2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/sha256Hex.js\":\"21d074d5f17f06e2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/workspaceKey.js\":\"da451acf11f14a08\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/conversionState.js\":\"eadf4e4c03fca3ba\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/createEncryptedWorkspace.js\":\"697852175f7e6643\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/pastedKey.js\":\"0a16d4fd8e9199b4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ae4968074e4cee5f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c5215c7bf432de89\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/keyStore.js\":\"df073219868f15d2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/mintWorkspaceKey.js\":\"faade40c2aaf7206\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/modePin.js\":\"a8e20cab7930dac2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/openWorkspaceKeys.js\":\"49177649009f573a\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolveWorkspaceEntry.js\":\"e41c8916184918ec\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolver.js\":\"096a8e7d1c4a941c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/workspaceAccess.js\":\"a5170ca5e831a502\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/transform.js\":\"d804c0b1dc126477\",\"/knowledge-medium/pr-preview/pr-1850/src/themeBootDefaults.js\":\"ac260e6200d232cb\",\"/knowledge-medium/pr-preview/pr-1850/src/types.js\":\"ca3b997da8a77d06\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/ClientLocalSettings.js\":\"a8fd1fa5b983896c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/abortableSleep.js\":\"7d495b9f3c894e1f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/array.js\":\"c3fd181456546c24\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/backlinkAutocomplete.js\":\"ab3ef3052c48b551\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockCrumbs.js\":\"22e2019eca52f9f7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockrefAutocomplete.js\":\"e36112e4fca3112e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/cadencedIdleJob.js\":\"90b0ccaf8ee4fb8b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/callbackSet.js\":\"71529a7d4474aeaa\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/clientId.js\":\"4e5a97695cb7d4b6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirror.js\":\"38fe3f436d6cb42d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirrorCompletion.js\":\"0a9665445d79295b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/copy.js\":\"61c066bb5a7bc66f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dailyPage.js\":\"655969e8092ecb25\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensics.js\":\"481eb264af9a52ea\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensicsHooks.js\":\"b6d60fb5449d33e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/deleteBlockThroughUi.js\":\"c38f93541e2b27fe\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dialogs.js\":\"8ca2456e83bca31f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dom.js\":\"0ff472d4ad5164a4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/downloadBlob.js\":\"cf1012af54ccabc0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/exportSqliteDb.js\":\"54eca2e62822792b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fileSystemAccess.js\":\"df292168ede519d3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/flipSlide.js\":\"f708358e145ec226\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fnv1a.js\":\"05c6b874327ca243\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/formatBytes.js\":\"2cdd1a252615ab1d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fuzzyRank.js\":\"fd390d991e141101\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idbKeyedStore.js\":\"61b65e445f8b709d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idleCallbackPolyfill.js\":\"3cb4229fee97155c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardAwareScroll.js\":\"4f5b27df5ddd89da\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardViewport.js\":\"b92868907524e60c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/lastWorkspace.js\":\"3adda50c9d7a3726\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutColumns.js\":\"0684f3250b71ffd7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionDom.js\":\"db9c1f0503e41070\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionId.js\":\"4fbf166ed5aa52a5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkClickGestures.js\":\"46b4a9e1fbcd98bc\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkTargetAutocomplete.js\":\"370226ec9a2d6627\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbCorruption.js\":\"25901c8ca27bc968\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbRecovery.js\":\"fe54bc3ab4b0a6a5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/markdownParser.js\":\"2dee2c920fa0370f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/memoize.js\":\"6521048317aebd2b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameFieldCommit.js\":\"57beffb788305686\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameList.js\":\"b1ab382dc9243c50\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/navigation.js\":\"ef33ca776c5d9217\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/omnilinerNamespace.js\":\"319dc96f2d20bf4d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/opfsPageScan.js\":\"237c01a69a475331\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelClearance.js\":\"3044e28b4080f62b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelHistory.js\":\"892bc08704877dae\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLanes.js\":\"bbb8db113dc90e24\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLayoutProjection.js\":\"78a758d685f3003f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelScrollAnchor.js\":\"b42095c629abfd5c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelUrlFlags.js\":\"bbf3dd2e9f624e3e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/platform.js\":\"d2f391c918706785\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/pluralize.js\":\"1a689d61438749e9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyCreation.js\":\"e8d9d6e2564c0a5c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyNavigation.js\":\"15ae01cb10949aa7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyValueContext.js\":\"e23a9079eecf96ae\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/react.js\":\"64251debc35ef693\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeDate.js\":\"f36b121de523f19a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeTime.js\":\"8d5ae21e0fe88534\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/renderScope.js\":\"52fb9b9126c7458b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/resolvedThenable.js\":\"0c88c6524ddd8282\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/routing.js\":\"3a3a136fbdf36d49\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/safeMode.js\":\"068cc250a65847b5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/scheduleIdle.js\":\"db3aa35a98c90cda\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/screenWakeLock.js\":\"8bc393bb28cf04dc\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/selection.js\":\"08547da519522bbd\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/softKeyboardGrab.js\":\"f1e15bc5a9f515f5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/startupTimeline.js\":\"9fe7735e47dee353\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/state.js\":\"f087427c526503cb\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/string.js\":\"5ff1d1e2e4a7d0dc\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/surfaceZoom.js\":\"e1d3cb809d0fdcf1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/time.js\":\"9641740893ff0c9f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toast.js\":\"3ce5727b0efcda0a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toggleStore.js\":\"5a8a6002c2a55e93\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/untilStopped.js\":\"046f63fcb18a18b5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/userActivity.js\":\"c54925f4e08bbcb8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewTransition.js\":\"3f430c02951ce698\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewport.js\":\"8a49e5cd5e13df5e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/webLock.js\":\"87c1282eee30fb81\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceRecovery.js\":\"c7b0ebb31b22b028\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceSnapshotStore.js\":\"95c6f4403546aa66\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-compiler-runtime.js\":\"1e00cb1cab346f14\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-client.js\":\"7b01501a52ef5411\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server-edge.js\":\"06617ea5d79c21be\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server.js\":\"8bc6777138a7d075\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static-edge.js\":\"3aa09c686bfb7a9e\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static.js\":\"394dd651e6fe4e26\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-test-utils.js\":\"64536b287ff8fcec\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom.js\":\"56fe35249d2c30ef\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-runtime.js\":\"907d807310050e80\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react.js\":\"d74cc7d81d0c0d6a\",\"/knowledge-medium/pr-preview/pr-1850/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
