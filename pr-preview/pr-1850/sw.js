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
		buildId: "18c905cc9c75-093632e4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/\":\"989d047edc7944af\",\"/knowledge-medium/pr-preview/pr-1850/index.html\":\"989d047edc7944af\",\"/knowledge-medium/pr-preview/pr-1850/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1850/assets/FacadeVFS-C3YaxVH5.js\":\"c0df8189857b81d6\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSCoopSyncVFS-B4MHOhJZ.js\":\"41a5843bf3786b10\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSWriteAheadVFS-Bnpvgrdn.js\":\"aaafb46dbe1fabd2\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-C0f-xGTU.js\":\"723f0a1c012357db\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-Djlkx6W6.js\":\"9574ac053ba011f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/worker-CDPWNcV9.js\":\"300a17428e4a5990\",\"/knowledge-medium/pr-preview/pr-1850/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1850/chunks/app-DuNp8WQV.js\":\"313fd6400d10267a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1850/index.js\":\"217c22c8bbb0e840\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1850/assets/AccessHandlePoolVFS-CjsnhIX7.js\":\"049857fa6c2c8ce7\",\"/knowledge-medium/pr-preview/pr-1850/assets/IDBBatchAtomicVFS-Bd8YX9nf.js\":\"b4044f5239497377\",\"/knowledge-medium/pr-preview/pr-1850/assets/MemoryVFS-B8T71J8j.js\":\"0dcdbc69f987e47b\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-DgeMTr2L.js\":\"c54753da65c0c565\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-DKE1_okS.js\":\"a8a5c5e8e98a84cb\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1850/chunks/AccessHandlePoolVFS-DTE50U6h.js\":\"36c56ae85faad2cf\",\"/knowledge-medium/pr-preview/pr-1850/chunks/FacadeVFS-CDAAET5m.js\":\"7486193dc62b5c37\",\"/knowledge-medium/pr-preview/pr-1850/chunks/IDBBatchAtomicVFS-uJbDZD3m.js\":\"8b8677a8949773f0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/MemoryVFS-O6NSK86U.js\":\"548a1c9919c3650f\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSCoopSyncVFS-Bd65lNYW.js\":\"0289a85fd5f9cdaf\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSWriteAheadVFS-MiYkJofU.js\":\"305a21e7aebd3959\",\"/knowledge-medium/pr-preview/pr-1850/chunks/Preview-CP4qRf48.js\":\"2235bb93bcaf0283\",\"/knowledge-medium/pr-preview/pr-1850/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/card-CmGfNNhQ.js\":\"2755dee15089de4c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BqQny8Ii.js\":\"4327268b62850cf4\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-3XaDUhkh.js\":\"bda9bc9ec18249b0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-async-CbRt5IV5.js\":\"924f2a0a8ccb7fb2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-B6-m8-I0.js\":\"555d0abf40859936\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BDtky0h7.js\":\"e80f914154b28662\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BaDseOHp.js\":\"34d2348f5e428197\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-C7srb73B.js\":\"1d4d392c0761dba7\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CHBI3qUr.js\":\"359498d5b7f107fb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CKkslJ1Q.js\":\"35760dd7b7346e6a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-D-eC5kd1.js\":\"34b277c433ff5ca3\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-D-z01qEZ.js\":\"33dbf3f101d8828d\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server-legacy.browser.production-Zvzcfvyj.js\":\"c21c56f47e7d2aa2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.browser.production-DJSyilkB.js\":\"b04fafb91a19aa84\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.edge.production-DeJd7GxT.js\":\"687bdcd89efa48a9\",\"/knowledge-medium/pr-preview/pr-1850/chunks/server.browser-Cz1D4eJt.js\":\"ee6cace9bac85194\",\"/knowledge-medium/pr-preview/pr-1850/chunks/textarea-DJwGTlLC.js\":\"eb9b67a5ac038cef\",\"/knowledge-medium/pr-preview/pr-1850/chunks/ui-I6L2hSh8.js\":\"8987340bc2173523\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-CKYkn7lL.js\":\"61af9430e5900fcb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-async-CTvqRNLY.js\":\"4918cebd32c5c0df\",\"/knowledge-medium/pr-preview/pr-1850/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1850/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/src/App.js\":\"f3dd1af15990b8f8\",\"/knowledge-medium/pr-preview/pr-1850/src/appUpdate.js\":\"daf5b19676eedbcf\",\"/knowledge-medium/pr-preview/pr-1850/src/appVersion.js\":\"3650eef15bd1f1b1\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/initialLayout.js\":\"956bf4298e375ebb\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/openWorkspaceData.js\":\"08db99d3b892c565\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/resolveWorkspace.js\":\"fbd3d2330f4eff79\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/workspaceBootstrap.js\":\"8521b6f5d2ca7929\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockComponent.js\":\"cc56ae696ac027f3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockCrumbs.js\":\"8fed8cffb6481734\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockEditor.js\":\"1b8ce09a7e63f1cf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockLoadingPlaceholder.js\":\"30ed4a051ca8e0f5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockProperties.js\":\"0e61500ec9cbad6d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockSearchPicker.js\":\"2f7eae643d787d7b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ConfirmBulkDeleteDialog.js\":\"f45640e404745d55\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DividerHandle.js\":\"e0a9e252bc34ab48\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DraftEditor.js\":\"0a09bde6d58bb967\",\"/knowledge-medium/pr-preview/pr-1850/src/components/GutterPill.js\":\"8a68b32732c43fcd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Header.js\":\"21f17e62ff1fc898\",\"/knowledge-medium/pr-preview/pr-1850/src/components/LazyBlockComponent.js\":\"c90f6551012a2922\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Login.js\":\"f7a5390bb2148dc9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ZoomableSurface.js\":\"ff642f1e7f4612a0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/editModeKeepalive.js\":\"e89cd1492ffa8b5a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e2c50308b668bbd0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"227e64f455dd9d39\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefPropertyEditor.js\":\"e489ff614ff71958\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefTargetTypePicker.js\":\"726b056375aad069\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/SelectPropertyEditor.js\":\"efd74a6f9690ecda\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/TypesPropertyEditor.js\":\"9298f016e4b5d832\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/defaults.js\":\"ad1aedcee935c64f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/kernelValuePresets.js\":\"5f5d805213dd18c9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/selectablePresets.js\":\"9b7a687d8c1326da\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/typesPropertyUi.js\":\"f3c37db97b083d44\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/AddPropertyForm.js\":\"f0ef4f7dcb1c348c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyPicker.js\":\"ff4f2dc8d442a833\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyRow.js\":\"04bffa4b84602dca\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/Rows.js\":\"a804f6f1a19838e7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/actions.js\":\"9aedf6a1a72ad04b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/declarationOnly.js\":\"71ea8aa17a6431a6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/layout.js\":\"b1bc8558f65d9ed8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/model.js\":\"b32eb8336e90aacd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapeUi.js\":\"15086754135e485b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapes.js\":\"6cb92aeb3c640d4f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/usePropertyEditingActivation.js\":\"65ac0b2ba0ccb6e4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/visibility.js\":\"dfcaf613c2040975\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanelSections.js\":\"08d2f0075c0ebb3f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockEmbed.js\":\"7d1871b1bb2c405c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockLink.js\":\"a986519fcaaf42b7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockRef.js\":\"d9ef7f090c523c01\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/ReferenceLink.js\":\"df8196782232de30\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuard.js\":\"0ee938b13c90cae2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuardContext.js\":\"834c807ffbf70214\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/linkInteraction.js\":\"96892d777ae26f3e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/referenceLayout.js\":\"9ca2d9d83fcb0a61\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/useBlockRefAncestors.js\":\"c32493fbc0692a9f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockGutter.js\":\"6331125a2b58edc7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockInfoDialog.js\":\"c5b84d1d5e93d679\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockTypeBlockRenderer.js\":\"3c217b2d5248d93c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BulletHoverCard.js\":\"ff038a535cbe1825\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorContentRenderer.js\":\"4a85992e43c64237\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c2415b1a18fbc4f3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ColumnResizeHandles.js\":\"e0fa2ff2fcd6ecb2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b6a9179f6d1ddded\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/DefaultBlockRenderer.js\":\"f1365f4ec048a0d6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/LayoutRenderer.js\":\"bcda463a97b66c63\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MarkdownContentRenderer.js\":\"d8b5580963cca946\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MissingDataRenderer.js\":\"340e88ebea526744\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PanelRenderer.js\":\"0835910494f43124\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PropertySchemaBlockRenderer.js\":\"9e19e38956601065\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/TopLevelRenderer.js\":\"11b935efb6babf19\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockGutterMode.js\":\"78b58d7d5e0cce81\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockTitleText.js\":\"a017d02a83ce366e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/fieldCreationKeydown.js\":\"468c470015b9c536\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/layoutRootContext.js\":\"bf8128ea8972b13f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/TypeChip.js\":\"b2131abb7e9461b0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/chipStyle.js\":\"b5ce94be1ad8fdd4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/anchored-floating.js\":\"68e0e517b1593fbd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/button.js\":\"ac44eda3737c5047\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/card.js\":\"713207a0ba3f0887\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/checkbox.js\":\"1cd6214ec6f47d3a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/collapsible.js\":\"86de337c9958ca29\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/command.js\":\"7680edc2e17d1e38\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/context-menu.js\":\"a23d8fe517e806a0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dialog.js\":\"d46080cd84280e67\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dropdown-menu.js\":\"6bedcb4fc33af7a6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/floating-listbox.js\":\"616d04bf10db16a8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/index.js\":\"7a9864f866108389\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/input.js\":\"e3b6664e0bd9e905\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/kbd.js\":\"e8846bb2d9c2f597\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/label.js\":\"1939f81b73528b2c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/textarea.js\":\"aedfc659b7dcb4b6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/useEditModeYieldKeepalive.js\":\"6eb682a9aa5b29ed\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/BootFallback.js\":\"7b407ad8f1573148\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/FocusedRowLazyMount.js\":\"967913bf68e86cab\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LazyViewportMount.js\":\"8630be8f91a071f9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LocalDbCorruptionFallback.js\":\"5164e7500fabf7c2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/error.js\":\"b41db41546ccbb7c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/lazyMountRegistry.js\":\"93b7ed4304c4a587\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/suspense.js\":\"a5bda46d762138a7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/CreateWorkspaceDialog.js\":\"9207aaa1df51dabf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/PendingInvitations.js\":\"0a837b4ccaf5850c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/SyncProgress.js\":\"c0a301bade0b8abd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/UnlockProgress.js\":\"f665d66bafcf45e7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceKeyGate.js\":\"dab3f15080d2779d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSettingsDialog.js\":\"80f9a4c568196abd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSwitcher.js\":\"1ac5bc03410a1044\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSyncGate.js\":\"3e04ce6557765e90\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlow.js\":\"08a387d137b0f76d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlowHost.js\":\"cd750fc7e0ed577b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/EncryptionSection.js\":\"6dbb0339a332915f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/attachmentPrompts.js\":\"4f522eb035c26c1b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4a905b43466ad959\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowDeps.js\":\"984231cc14c7018a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowStore.js\":\"685666a412c0024f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/flowUi.js\":\"4cd397b088de7fa6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/useConversionRun.js\":\"dabc255bd62a3eb6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/keyUi.js\":\"6afcf0412a4c1c3b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnKeyLoss.js\":\"6a940d84449fd0ce\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnServerE2ee.js\":\"06d97a0deac518a5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/workspaceUnlocked.js\":\"ae19ef188721d06a\",\"/knowledge-medium/pr-preview/pr-1850/src/context/backgroundSubtree.js\":\"4502d42b92b0e47f\",\"/knowledge-medium/pr-preview/pr-1850/src/context/block.js\":\"0b5ec07baf9db9a9\",\"/knowledge-medium/pr-preview/pr-1850/src/context/layoutWsContext.js\":\"46a61569ddc9234b\",\"/knowledge-medium/pr-preview/pr-1850/src/context/propertyDisplay.js\":\"65e8d85d6e660041\",\"/knowledge-medium/pr-preview/pr-1850/src/context/repo.js\":\"5523d840b63b3de1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasClaim.js\":\"e5dfde24ec2bb65c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasSeatNamespace.js\":\"5e78c94ebabf6a75\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockData.js\":\"41b881c844267e58\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockType.js\":\"285fba3b8ae773f3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/changeScope.js\":\"1141bdadc1417a51\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/codecs.js\":\"c62d5f2cef172a9f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/derivedData.js\":\"bccb8cd32e971d9a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/errors.js\":\"2821d3018034116d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/events.js\":\"d6ea1040377788cc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/handle.js\":\"e91da334090e045b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/index.js\":\"1b9cda044a117333\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/mutator.js\":\"7203a714a9082a86\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/processor.js\":\"50956abad2be2344\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/propertySchema.js\":\"86136a7f0dc0360f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/query.js\":\"245cf4747ed9eeb8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/sameTxProcessor.js\":\"225cc3fde673c2d5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/schema.js\":\"e91da334090e045b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/tx.js\":\"e91da334090e045b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/typedBlockQuery.js\":\"843cb326a895bc49\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/user.js\":\"ee7e62c32a95cfc2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresetCore.js\":\"97b23325d80f7d4a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresets.js\":\"f58272b41ab2b9f6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/attachmentCleanerIOVerb.js\":\"627082d8503ba6e0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/block.js\":\"1d64beac0eb52651\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockCache.js\":\"f021ba0fb213acff\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockId.js\":\"28c1d132c67dd495\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockLiveness.js\":\"e0e4da11098eb194\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockMerge.js\":\"53c19887f61e2976\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockSchema.js\":\"f33fcc43e83c430d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypeLookup.js\":\"509485c962628a04\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypes.js\":\"4c5015897cb28a9f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/clientContext.js\":\"2490c46ec7518327\",\"/knowledge-medium/pr-preview/pr-1850/src/data/dbFileSiblings.js\":\"54883bc5d9b1c0ce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/definitionSeeds.js\":\"8eba5ebb5b3d4be1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/derivedIds.js\":\"94a3367e2b6b9bab\",\"/knowledge-medium/pr-preview/pr-1850/src/data/drawnSubtree.js\":\"7d254616bd389ba8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facetBridge.js\":\"eea7806a3a3f1bd9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facets.js\":\"b96f5f6ef2fba95d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/globalState.js\":\"722b60ef3e4cf728\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/aliasClaimRederiveProcessor.js\":\"2dd6ada3f5d86dca\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/ancestorBatch.js\":\"da9682be29581e5b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/blockTypeTypeifyProcessor.js\":\"8d6ad667d5e5dc53\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/clientSchema.js\":\"356723b31f195176\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/commitPipeline.js\":\"2df50ce4a74ca531\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/devAssertions.js\":\"05a211c05c26936b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/firstSync.js\":\"f5fad18129848bdb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/freshInitialLoad.js\":\"fdaa5484e9c20f54\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/graphBackfillClaim.js\":\"5991de1eb959f85c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/handleStore.js\":\"bcbebaa443ec2b65\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/idleMarkerJobs.js\":\"803432324d7bf494\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initialDownload.js\":\"cf4a7d3588e0de22\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initializeClientDatabase.js\":\"046ffb397efbaf13\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/jsonCanonical.js\":\"8e6624d48c1d3e0b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelInvalidation.js\":\"db9c680ee0b9cd88\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelProcessors.js\":\"cf23e06d4855ae26\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelQueries.js\":\"378f0789f4bec0a6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/mergeTypeMembershipProcessor.js\":\"6ef933e4735d8f85\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/normalizeReferencesProcessor.js\":\"608fb98e9d98d9e9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/poolInstrumentation.js\":\"c12ab2baff882430\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/processorRunner.js\":\"24eff5c4d3fbeb00\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyCellBackfill.js\":\"a2ab70f01508ccda\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildMint.js\":\"1fff8138e7d7a867\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildrenProcessor.js\":\"a893de2432ada378\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionChangeProcessor.js\":\"94f9d0875cd6b171\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionSynthesis.js\":\"1d86c1544a1f28a2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyKeyScan.js\":\"004a75613a0b8312\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertySchemaResolution.js\":\"8a84992024c86033\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyValueEdits.js\":\"fd70c9749e970be0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/raiseProtocol.js\":\"4e4285cd4a87e845\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/readBatch.js\":\"d35c33197723780e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/refProjection.js\":\"c6818e42836ec6ed\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetLookups.js\":\"d14513ca77f0a612\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetProcessor.js\":\"8cba9a662a7b9648\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/replayMerge.js\":\"245e594f86887336\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/sqlBinds.js\":\"be60d0b593934586\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7e5e9d715edf821d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/arrivalProcessors.js\":\"ff1a8d22daa5b5cb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/invalidate.js\":\"c729aaa98aedd7a6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/materialize.js\":\"6565a1e1eddf1b15\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/observer.js\":\"f05da96322318974\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/reconcile.js\":\"06147dc3959a883a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/timingMetrics.js\":\"1b7b0ef8d26741ec\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/treeQueries.js\":\"85adea680feff172\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txEngine.js\":\"7ae6add99239efcb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txSnapshots.js\":\"c634a3ca4a0a2854\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/typedBlockQuery.js\":\"f1343bab4a141ed5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/undoManager.js\":\"be806f53b035d8ab\",\"/knowledge-medium/pr-preview/pr-1850/src/data/invalidation.js\":\"caaf742b0d1ab84e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelDataExtension.js\":\"e100077c1a569b80\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelPage.js\":\"24ab028ba6f94be0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelValuePresetCores.js\":\"4e97a90a5b1e28f4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbCorruptionSignal.js\":\"9ea92878c0a70c25\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbStorage.js\":\"beab4b3d7f3c72aa\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbVfs.js\":\"e43e928e49cf246b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localSchema.js\":\"86aab95a24d244fd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/maintenance.js\":\"6450c509756e1bae\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mergeProperties.js\":\"b0edde02865843ce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/metricsConsoleHook.js\":\"6f37ee7c654e8a16\",\"/knowledge-medium/pr-preview/pr-1850/src/data/migrationsPage.js\":\"2683e94c9894066e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mutators.js\":\"d4eeca3605d459a8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKey.js\":\"47fd20d2f3ee189c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKeyPlacement.js\":\"13bf9ff6fa45a3a6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/outlineSurface.js\":\"a72469d26543397b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingEditorContent.js\":\"4f09598cbd5adf9e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingUploadsSql.js\":\"97f91b97016403e7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pluginStateExtensions.js\":\"dc618d24a54a1ca5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/powerSyncLogger.js\":\"ba3fdc1720b4f22d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/projectorRuntime.js\":\"59923882dd782c3b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/properties.js\":\"6c595dfd8db4b33a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertiesPage.js\":\"812db0130a0f7fa7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyChildren.js\":\"34e40876a355c285\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionFanout.js\":\"b34018e44c52f18e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionMetadata.js\":\"e4e2b507a637ed1e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionRegistry.js\":\"d64b73af21159bf4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDisplayMode.js\":\"ce1685d0b5ef5597\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyRowCreation.js\":\"04b4cc97feda8fe3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySchemaCreation.js\":\"89ba16f55ce44c07\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySeeds.js\":\"b11bd4868e752b62\",\"/knowledge-medium/pr-preview/pr-1850/src/data/recentsPage.js\":\"df3fa1bfa7690884\",\"/knowledge-medium/pr-preview/pr-1850/src/data/referenceBlock.js\":\"10c7ebab56bc7231\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rejectedUploads.js\":\"f1cc10d49a7b9444\",\"/knowledge-medium/pr-preview/pr-1850/src/data/releasePowerSyncConnection.js\":\"34ebef72a7c371fd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repo.js\":\"ea1cd4c01f1bd777\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repoProvider.js\":\"5d2c7f05f0c77074\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rowProperty.js\":\"47f0e7b4c72e2a6f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/searchFilter.js\":\"c18ef1be21cc53fb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/seedIdentityLedger.js\":\"a7ff5fee346cc277\",\"/knowledge-medium/pr-preview/pr-1850/src/data/stateBlocks.js\":\"dfea168d5792017f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/structuralEditPolicy.js\":\"ed11dbaa79ace5ad\",\"/knowledge-medium/pr-preview/pr-1850/src/data/subtreeDelete.js\":\"101267527b7ad4ec\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncStreamLock.js\":\"7630232d33a5a512\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableSqlRecognizer.js\":\"9cf4b4ff79740e94\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableWriteGuard.js\":\"0cdc68b1c6736fe3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/targets.js\":\"763c8e7d4d8ebfe9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeColors.js\":\"b314fb211fa87966\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionMetadata.js\":\"6f6c8cd9156d2ab0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionRegistry.js\":\"5515c396368fc336\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeExtraction.js\":\"24d0db7c98b7c4e3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeInitialValues.js\":\"de07743547c44b0c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typePropertyGroups.js\":\"27436c1c266930cf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeSeeds.js\":\"9848f33bb82c2fc9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeTagger.js\":\"16bd95e8b9129e08\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typedRecords.js\":\"2e62792321a2bdfb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typesPage.js\":\"95932450be6777a2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userPrefs.js\":\"efcdb4d267bca514\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userSchemasService.js\":\"f1c868a1dff5c583\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userTypesService.js\":\"8c226d82e8ccc3df\",\"/knowledge-medium/pr-preview/pr-1850/src/data/valuePresetRegistry.js\":\"79623f6b8a6de1e9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/visibleChildren.js\":\"efee1b5b39f227c0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceConversion.js\":\"1af1171dfadd9348\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceFirstSync.js\":\"1da621d03f24cb46\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceIdNamespace.js\":\"f32f7d730cc05763\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceSchema.js\":\"60fc436fff92c870\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaces.js\":\"c2bf3836d719e407\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadLog.js\":\"acd2f2f10abecd57\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/BlockPasteShellDecorator.js\":\"22296689d59ae7b7\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/atTrigger.js\":\"83e06fc6d280779d\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/autocomplete.js\":\"4d2ec5cf947e92f8\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/codeMirrorExtensions.js\":\"dd44b3123a46c720\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/contentFlush.js\":\"7bffa60e3ffb8fc2\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/defaultInteractions.js\":\"7b1416f1d62c558a\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/editSettleSignal.js\":\"5041f3a050928b2e\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/insertImage.js\":\"f36d79bc3023714b\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceCompletionRange.js\":\"79f791b12afd5121\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceTargetTypes.js\":\"1934c6caf589789c\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/syntaxContext.js\":\"a58a56c9bf294d8c\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/triggerMatch.js\":\"8d90837f35600e2d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/AppRuntimeProvider.js\":\"a6b97444bc0581e9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/BlockFocusShellDecorator.js\":\"ce0c58d25048ce3d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/ExtensionRenderBoundary.js\":\"3c5512be29c3069b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/PanelContentRecovery.js\":\"c009156a35e228b9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/apiCatalog.js\":\"5812e8026de70f4d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/approveExtensionHere.js\":\"c3f9aaf12e446a91\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/armedCutAppMount.js\":\"b943b20ed3af4503\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/batchableKeyedStore.js\":\"f283be6d883d8158\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockInteraction.js\":\"38a670226f04afbc\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockSelectionAction.js\":\"8a727fa9a5abe602\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compileExtensionModule.js\":\"b77f82b104be5d30\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compiledModuleCache.js\":\"aeda14e4f575a59b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/continuousGestures.js\":\"750c935be82335a8\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/core.js\":\"3def757ccb6e1d3c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/defaultRenderers.js\":\"17ac3affa1e4f9cb\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/definitionFanoutAppMount.js\":\"835a9575c2feee57\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dialogAppMount.js\":\"671de352625b4dfa\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensionSeeds.js\":\"7077b1f56b600bcd\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensions.js\":\"b3083f11c99ce5b1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/exampleExtensions.js\":\"b081440854d959c4\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionApprovalStatus.js\":\"5e80be7cbcf9e117\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrorToast.js\":\"c37404e72b34fabe\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrors.js\":\"4b283c0f97b1e7e6\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLookup.js\":\"e95a8ed5d995c789\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionToggles.js\":\"68acd91ef484e89c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionUtilitiesCss.js\":\"1dcb9fb7dbe279b2\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/kernelPageDeletionGuard.js\":\"ab73e5487a2f8dc7\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/liveRuntime.js\":\"4b586956101478ff\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/openExtensionsSettings.js\":\"25ec921b0d8735b2\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/overridesCache.js\":\"85961a82e29f81d9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/pluginIds.js\":\"8e65b1d059687863\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/processorRejectionToast.js\":\"cb5171c9724b4171\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeActions.js\":\"138fc96bdb250aca\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeContext.js\":\"c023d62c9342bd33\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticAppExtensions.js\":\"9ac93e8903965d63\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticDataExtensions.js\":\"c3944b8dbceee918\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/toastAppMount.js\":\"579edae9b9b99bca\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useOverrides.js\":\"ea3b02c891a05e38\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useShortcutSurfaceActivations.js\":\"8f4a7f3efbe2d33e\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/discoverToggleTree.js\":\"115ce3b346a036ba\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/facet.js\":\"5eb294c48e98173b\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/resolveAppRuntime.js\":\"32cd56f5a2a3b75e\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/runtimeEvents.js\":\"cce49f867302801d\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/togglable.js\":\"f90ca89c0be28017\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/variantFacet.js\":\"000e3f1b352b9b86\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/verbFacet.js\":\"04d5240d6136c991\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/block.js\":\"1b06801d9f5e6391\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/focusedChild.js\":\"bb53756563728f57\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/propertySchemas.js\":\"9adff3591df9ff54\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/typeRegistry.js\":\"cd99a45bbf5df7da\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAncestorCrumbs.js\":\"c6bbed5948b700bb\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAutocompleteListbox.js\":\"16cabd6fec2ae103\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedSearch.js\":\"d4665f55105fe3c3\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedValue.js\":\"be8c563b471df412\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsFocalRender.js\":\"3c980c75a36fddef\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsReadOnly.js\":\"919ec28e789076cb\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMaterializeBacklog.js\":\"1c1071b1569c3af3\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMinuteClock.js\":\"2b227b3d77965111\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePanelLayoutProjection.js\":\"cf43642ce9922d34\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePendingInvitations.js\":\"d868879464e213c3\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRendererRegistry.js\":\"0fac59b4a300a0bf\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRetainedFieldRows.js\":\"fde3e87ed96861a8\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useWorkspaces.js\":\"ad38624073c00fe2\",\"/knowledge-medium/pr-preview/pr-1850/src/lib/utils.js\":\"65515c0c66efa68f\",\"/knowledge-medium/pr-preview/pr-1850/src/main.js\":\"4e5a47cfcc064a7e\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/MarkdownImage.js\":\"437fd12156a054b7\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/blockSeparators.js\":\"59b12a8c16e848f2\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/context.js\":\"fb6981091d6842ed\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/defaultMarkdownExtension.js\":\"d74e1272fd4c1f28\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/extensions.js\":\"fb6a323d20e3f5c5\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/renderMarkdownHtml.js\":\"3261de1c87955da9\",\"/knowledge-medium/pr-preview/pr-1850/src/minimal-editor.js\":\"7831eab77da321a3\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/armedCut.js\":\"286ae51b34cd1622\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/captureMediaVerb.js\":\"0c7d17c0504dc57b\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/clipboard.js\":\"072cb0a702325ebe\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/decision.js\":\"0cf890ec34623c0c\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/operations.js\":\"a6936521b53b8f3a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/AccountHeaderItem.js\":\"be4631f912996133\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/index.js\":\"d8bd38be9296f277\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"fd93a7250a69a7b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askAgent.js\":\"f375314d68029c98\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askedStore.js\":\"637835f522450398\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"dd3ca50c54d18537\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/chipState.js\":\"7218109e8f996c22\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/dataExtension.js\":\"90ee6e3b1dcec817\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/index.js\":\"73f4a085f7e10cdc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8bb47e81efbda106\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/schema.js\":\"33c35c84fca7dd5b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0ba61e5c72686808\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/BridgePairingDialog.js\":\"36a650a606c308ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/addMedia.js\":\"d4147406efc1b28c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ee1065082cb5663f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/block.js\":\"6c8aca1114407645\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/context.js\":\"27ed1f23dd05add4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ced78e1bb353c26d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/index.js\":\"b66dff0fd1393054\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/outline.js\":\"5770828815ef66d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/properties.js\":\"2e658e49466ae6f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/refs.js\":\"095e3c264580bdd9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3b008591965d0a51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/search.js\":\"f6151686b0801060\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/shared.js\":\"60a288c4987e5ee5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"bce5789c73c96101\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/text.js\":\"45f2a40ada3919f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentWrites.js\":\"742ae627de85408b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/authoringCatalog.js\":\"725bf9be00081a06\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/blockRefTargets.js\":\"594b3f8950d4a0b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridge.js\":\"fb93939478f54df8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridgeLoop.js\":\"d8d2c6706e4f59aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/changeHistory.js\":\"33d38dd461a91903\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commands.js\":\"1c4157a0c85cf207\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commentsCommands.js\":\"11f1e7ff1ee252fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataExtension.js\":\"e26fbb0c69371dc8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataModelGuide.js\":\"f27ab8045877b9f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/describeRuntime.js\":\"9c88607f6e39d640\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/extensionLint.js\":\"bed49395af7316b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/grainAudit.js\":\"dc0fcd5d963b84a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/healthCommand.js\":\"12818b57ff134542\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/index.js\":\"66e38ef4095eda0d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/presetIdentity.js\":\"f34936185a04d832\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d263f78f71f6678c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/readMedia.js\":\"20763446f610ce41\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/schema.js\":\"2f62c93caebeed77\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/serialization.js\":\"b348eb8c7ff08349\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/targets.js\":\"834b5ed6d7974493\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/tokens.js\":\"4432664c89149fa0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/watchEvents.js\":\"01ccccfddfaa06f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/workspaceGuard.js\":\"7d64a45af2416a4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/writeCommands.js\":\"821f4d68ba85471f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/AliasCollisionToast.js\":\"34bd924ccd5a58df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/DuplicateNameBanner.js\":\"87a8672fd7707d51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/collisionMerge.js\":\"d4604c8ab9c25eca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/dataExtension.js\":\"ef256da3dbe7f171\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/index.js\":\"09b4da6eb392b1d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/mergeCollisionAction.js\":\"dd27f1c87c1dca34\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/pageStyling.js\":\"2620eb86b6c7e24f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/rejectionToast.js\":\"1c38ce600e74dd7c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/syncProcessor.js\":\"caddbfe2d2cedee4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/actions.js\":\"577ce5240bc32951\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/addComment.js\":\"c5a434b097b5a8ee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchor.js\":\"81288c7ae6c2f882\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchorState.js\":\"4f6902774346063c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/commentLinks.js\":\"1db516d0d24f2e23\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/confirmThreadDeletion.js\":\"a769e93753c2f10f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/container.js\":\"ccf27572731d6e5b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/dataExtension.js\":\"2a0c2567d5e7dd92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/deleteComment.js\":\"1caf593a4bc9290e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/highlights.js\":\"b3d8ac72ee6536ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/index.js\":\"4001697ca0e9253d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/linkedCommentsPill.js\":\"dfb16fd59ec3262a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/margin.js\":\"200654ac91031005\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/marginSchema.js\":\"99d6235c94ff6084\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/newComment.js\":\"7fa699d77a6ae629\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ownThreadPicker.js\":\"0afd245302dbc94a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/placement.js\":\"abb54d273da5140a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/queries.js\":\"a0e2a471a9aea3b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotePosition.js\":\"5af2ed6426141594\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedIn.js\":\"0f539e5af5c429be\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedRange.js\":\"db430b742f22cce3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/rangeRefs.js\":\"86b51c954679c317\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readHighlights.js\":\"aacf8e1c1ff1394b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelection.js\":\"f4eb995b9203f12b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelectionUi.js\":\"eb6d826ae9198aff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/reanchor.js\":\"769d090746f3839e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/schema.js\":\"49c8b91a1c00cbbe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scope.js\":\"24a5338894903e7c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scopeThreads.js\":\"c0fe035408148afb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/splitRetarget.js\":\"072d602d04d6e101\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestionCard.js\":\"17f2f1919d771de9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestions.js\":\"152a9378c77a401b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaries.js\":\"594c8cbfc9a55181\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaryBatch.js\":\"efa7ca48e60a4a52\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/surface.js\":\"00b1ebc6a6ccdbb9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threadNavigation.js\":\"05b72fa57460f5a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threads.js\":\"b321e41d9a9a83b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ui.js\":\"db84bb08fde07ebd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/uiStore.js\":\"e7e78222c7169e22\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/appIntents.js\":\"64be0c4bf73415cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/index.js\":\"bcdbd5ed53e48d41\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/index.js\":\"93e30a69ec0f42e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/status.js\":\"776c3aa60a75b960\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c22ef55a668e5b4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaBlockRenderer.js\":\"f2504afee1944f2a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8fe5f6239b4debfb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaUploadReconciler.js\":\"05e9898c554992d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetDownLane.js\":\"bb7e2cae1535f61f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetResolver.js\":\"1a979d1aa9a2933f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetUpload.js\":\"42b252e9831986f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/attachmentCleanerIO.js\":\"8360d36cf628fc8b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d6f41bc118a0aaee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/blobStore.js\":\"3f40fb34c015ae32\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/byteStore.js\":\"4ef461cbad4ccb05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanerIO.js\":\"f2a71df250fbe486\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanupAttachments.js\":\"b51ee64ab95134a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/dataExtension.js\":\"cad66171d8d5422a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/downLane.js\":\"61f7a4d799ec1a60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/index.js\":\"472460bb1beb7aa1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/insertImageContribution.js\":\"9c1e6e937dc6c26b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneArming.js\":\"5151c5d0bf8e48cd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneLock.js\":\"4b43967c8dafb71f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaBlock.js\":\"834de93934865d45\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaCapture.js\":\"14c941675ea587b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewers.js\":\"def185f4c55b5cfb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewersFacet.js\":\"02c8c4c5fa03273a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/pasteCapture.js\":\"ea52b32ee9c2c927\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/resolver.js\":\"71973cbd30f4e18f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/retryUploadsAction.js\":\"2c295384d1384c3a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/storagePaths.js\":\"0de12a13a6d675f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadDrain.js\":\"506ed88f982b8482\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadLaneStatus.js\":\"28cb6da184d5c013\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadReconcile.js\":\"0c3f831a8ffa90eb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadRecovery.js\":\"6fcd57dc5cb50257\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadStore.js\":\"b5cbb2658493ed6c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/useAssetObjectUrl.js\":\"2582922e3e3a09a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"37e6cae3f92255d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksViewSection.js\":\"1e29958eaf7653e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/facet.js\":\"840677261df165fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/index.js\":\"f729eb27f2696248\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/prop.js\":\"a68e187b52c19ab3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinkFilters.js\":\"683292e7eb03f7fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4bc41bc2c8dd49e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BlockEntry.js\":\"0ed205fa2c324a2a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/LinkedReferences.js\":\"6e7f10bc1de589be\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fde9b350dc74fc86\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dailyNoteDefaults.js\":\"93c812b45a404e4d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dataExtension.js\":\"3f1ba6722f8ad640\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/edgeExclusions.js\":\"15401c444d429a70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/filterProperty.js\":\"f89347b3f6c31d26\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/index.js\":\"5ad41bb14dca46e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ea91ab3c3d0e76e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/applies.js\":\"70f3668950e4fca4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/countQuery.js\":\"231ff2defc821580\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/expansionStore.js\":\"971b3279a1c02711\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/index.js\":\"b9fdabfe7e1f5438\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"192b6e67cfbcec26\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/presentationInvalidation.js\":\"77d37fe5a01ef658\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyEditorOverride.js\":\"c767bb073b78757b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyFilter.js\":\"7fdbc7ce2deb4de2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/query.js\":\"f0e6b015930d58e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/resolveFilter.js\":\"3b265b6530007262\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sourceBatch.js\":\"63c2e0d54d254a85\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sources.js\":\"313a7486f9410466\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useBacklinks.js\":\"c37009602b4f128a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"35485086dc69e7f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayCelebration.js\":\"69b2b48aaf49d22c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayOverlay.js\":\"6b31be9eac81aa88\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/gate.js\":\"ec0fbcae7a1da5a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/index.js\":\"55988d41fb2cfbce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/wolfTheme.js\":\"ae627ec9877d30e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/BlockDragLayer.js\":\"aa24fcbadcbe4133\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dragController.js\":\"cb3809344527c17c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dropTarget.js\":\"250cb35f6595cc6f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/index.js\":\"d64dc1e8c4ad8d40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/projection.js\":\"75da190092789f92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/BlockMetaCard.js\":\"7e7bbfef65054b5f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/index.js\":\"9d222291a4c994bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/AddTagDialog.js\":\"20b6d99624bc3665\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8ad791c4ab6057a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/TagNameIssueHint.js\":\"254121565f86e97f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/addTagAction.js\":\"756b50e7a026316e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/appendTag.js\":\"11cb77fc95ea2e04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/config.js\":\"f772a0cc5a89d8bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/dataExtension.js\":\"b5ee6ee06d9eb2d6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/index.js\":\"cd6b31d6b3f7434f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/propertyEditorOverride.js\":\"9c0c9e2526cbf27d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbList.js\":\"cb6b39635cb6f223\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5a18953618ce0935\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1b98c68d04d3ef54\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e60f6121765137c9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a5f3286c57e8b42e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/index.js\":\"6efb576bffa8714b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"922ec1f5ad023d86\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/CharacterCountItem.js\":\"3a6267c18c58e8d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/ProfilePropertyEditor.js\":\"91b4660df9195cfc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/actions.js\":\"6a2a8ec3f4378a37\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/blockType.js\":\"a3527692d94e669f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/charCount.js\":\"374dd06acfb105db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/dataExtension.js\":\"282f5024b75d5f85\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/index.js\":\"f4d112f4265c5d58\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/profiles.js\":\"6e45c705cb4fe68e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/properties.js\":\"8e0b2dee9aaf90a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/textCounts.js\":\"9c25aa3c99dbe0db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/colemak-keybindings/index.js\":\"f862eea227fd70ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/CommandPalette.js\":\"e4e6816784bf68b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/HeaderItem.js\":\"3a328e02587163f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/context.js\":\"cdc11e165dc25188\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/index.js\":\"645fb46d28968d50\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/selection.js\":\"bb2df74facd05536\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/toggleStore.js\":\"dc1d074534ec27d1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/useCommandPaletteActions.js\":\"29d5ff4182cad066\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/ContributorBadges.js\":\"e2198f17580a4936\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/author.js\":\"3e27e46f5cce16dc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/codeMirrorExtensions.js\":\"06cc832046455841\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/dataExtension.js\":\"f627595225a3cf11\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/index.js\":\"35531b32694d2dc1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/mentionAutocomplete.js\":\"1af4e8dde8944a65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/processor.js\":\"2b7a6588cffafd2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/profiles.js\":\"360e5c02b0188a50\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/queries.js\":\"872112c919d47e60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/schema.js\":\"c3c8b374903d7881\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"82019ae53054d292\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2c72b715db431511\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/index.js\":\"bf2e789df3b26efc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0dcd8dde28436d29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5f670b7d4af7a41c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/CalendarGrid.js\":\"db31568bf8256f38\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DailyNotePicker.js\":\"ab730b78646f0e7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c3a390b63738cc60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateNavDecorator.js\":\"384d439168d02f53\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateScrubOverlay.js\":\"aabb4e19e3f96bf1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/HeaderItem.js\":\"02349ba33bf2b37f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/ReschedulePicker.js\":\"62d267e2020bc887\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c2742a8c24039f6c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/actions.js\":\"7402050da96ed790\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/blockDateAdapter.js\":\"1ff344a7303c3d45\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/calendar.js\":\"54968e0690332f92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dailyNotes.js\":\"27bf6ffa7f9a5fb4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dataExtension.js\":\"60fda4f0501cba21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubActions.js\":\"1a1d76b3713ec1df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGesture.js\":\"54337b1a30295cee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGestureActions.js\":\"67c13023bd89b603\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ed446a6d96ca8ff4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/deletionGuard.js\":\"503502928c0da7fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dueQuery.js\":\"0506d4cbe0800b38\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/index.js\":\"4c260c63ed02aa31\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/landing.js\":\"7a2a6920d2ffc19f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/localSchema.js\":\"9636eac8874eae2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/referenceDateAdapter.js\":\"c8f3010b4ec999fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/rescheduleAction.js\":\"bac14546537a0b7a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/schema.js\":\"295a7acf1c982ec1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadBlockDates.js\":\"f1b7e7205f98bd63\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadDatesAction.js\":\"fa30672d52ec6827\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/today.js\":\"fa66b8cab4f6ae74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"1be950d45261748d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"222c05e99787d6b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/audit.js\":\"1657fca2445b9310\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditAction.js\":\"7e9c8b7171f1b04d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditRanges.js\":\"361f37c753e34e03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/diagnosticsSource.js\":\"90b5f82d5e4bac46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/divergenceScan.js\":\"1e164c65ec02f743\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/index.js\":\"9281ff969da61e08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/propertyChildrenChecks.js\":\"96504a92faf3b4d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/referencesMirror.js\":\"d2fdcc080a3adbb4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/rowJson.js\":\"4437a96a96040955\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/schedule.js\":\"99924a03bcc3e773\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/store.js\":\"6a7ea07accbee61b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/action.js\":\"8ea103a6b43fc7cc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/index.js\":\"2828849d5d0d7c03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/plugin.js\":\"e1e1cfba730d3ab2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8fe390ddb81d987d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/actions.js\":\"8eb2bc7ec4b1b865\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/changeMarker.js\":\"4d4b5a2af2f79a56\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/diagnostics.js\":\"f9e67acaf736e84c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/fileSystemAccess.js\":\"463d4149381b916e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/filenames.js\":\"793d9367b4c35446\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/index.js\":\"b55b9adc16b9c932\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/mirror.js\":\"0e7b342f55227893\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runLock.js\":\"d9752bedb5759c7f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runtimeHealth.js\":\"f7a6561a9014f7fe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/schedule.js\":\"8d068d38ecac6a06\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/store.js\":\"60cdadc88a644e34\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/index.js\":\"fd7310f53807afab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/themes.js\":\"7aa0a70de9df8556\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/facet.js\":\"fe943d2b1d17bc80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/useDiagnostics.js\":\"96b883b0f52984ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/dismissals.js\":\"27f5d14f001f8125\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/index.js\":\"20a7fb165e7b3b03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/status.js\":\"5bdd97ea5773ba79\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/store.js\":\"0663b749cd464aac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1a9ecef874a684bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5b845930cb608ffb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/actions.js\":\"b5577c01ccc9d6de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/config.js\":\"6afd030e08bd49c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/dataExtension.js\":\"5e88f33705bc3b73\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/effect.js\":\"a1d3ebd91a481f8f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/index.js\":\"6da845e9062853ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ffe24b2883537321\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/useToggleTree.js\":\"56d1658745eb615f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/ExtractTypeDialog.js\":\"9fd54544fb7d9070\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"44a8448eeae3d8a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/PropertyShapePicker.js\":\"1fccb2d6eeaa928a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/action.js\":\"2cea63ebd1d43e03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/index.js\":\"9b642b4c6125e3fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/FindReplaceDialog.js\":\"9bbe1cab99042c95\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/HeaderItem.js\":\"92db0d5f9ba43998\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/dataExtension.js\":\"095a527d37f10fea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/index.js\":\"0f45cd7612e4afc3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/search.js\":\"4770182a0022058d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/toggleStore.js\":\"2217ddccd58a1c6b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/LocationPropertyEditor.js\":\"fa0de77e408cbadd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/MapView.js\":\"ac5c05991fb14e86\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/blockTypes.js\":\"e1bfce4ec3bcb7a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/codeMirrorExtensions.js\":\"753bc964f115d13a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/createOrFindPlace.js\":\"6bbcae8cd4bae163\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/currentLocation.js\":\"413eae7b0c38debb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/dataExtension.js\":\"c3222487da104836\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/geoContentDecorator.js\":\"3af9307041ecc04c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/googlePlacesClient.js\":\"07fa1da1b4096079\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/index.js\":\"d1de8102aad3456b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/locationsPage.js\":\"2fc2f95645b8aa92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/mapViewport.js\":\"935ae17f51f23958\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/pickCurrentLocation.js\":\"2b706d701a1103fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeAutocomplete.js\":\"33d1e9ed3584e5b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeNameCollision.js\":\"975243ba0e77083b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/properties.js\":\"07407310b75197fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/propertyEditorOverrides.js\":\"041d1f27433b9b0c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/query.js\":\"772a4aed17642609\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/usePlaceSearch.js\":\"f25bc1dcaf9480dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5ca24fb9cf180fa1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"49c21c2af10201ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"0c980657e413e4b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/config.js\":\"6470adf56f2cd276\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/dataExtension.js\":\"583136e9660abbc3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/facet.js\":\"cbb901efdcbacaf9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/grouping.js\":\"512f94303890bb0c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/index.js\":\"de73f69411c60888\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4c7142da47f23c3c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/query.js\":\"70521a76305363a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/resolveConfig.js\":\"9efb6b98f4cf02ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"fa7296c1f6dcf57f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9fe706ecf0811880\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlDocumentContent.js\":\"771561b180f1bbef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlFrame.js\":\"57361cdc73008d9c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/actions.js\":\"0d0bfde6da3ce9b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/blockType.js\":\"f15a43359dec4055\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/confirmRunScripts.js\":\"2756039581ffd4ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/dataExtension.js\":\"3f6e3650bb18e56a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameAnnotations.js\":\"29ef3ff2b812e13b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameDocument.js\":\"1ae78879fa02c23b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameTheme.js\":\"8e845b83e2111e49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/index.js\":\"5fdb58ecd5e5e0d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/scriptConsent.js\":\"0d07e3a91fcfea83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/sourceMap.js\":\"aaa93f97d869bfb5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/useDocumentScripts.js\":\"a8f42a5b44bdcbee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/index.js\":\"e3a2cd0acbaaa7ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/record.js\":\"30161f6f4038d934\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/recordStore.js\":\"087eb079a95eff03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/responsiveness.js\":\"362f1a0eb60dd7a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/schedule.js\":\"5d1c54c7cf41776e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/sessionContext.js\":\"77945711f96b9af5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"16d3ec987c41ea75\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"73e187b2d66f81cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/actions.js\":\"28dc789e8debc625\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/config.js\":\"aaf313f4d3d7cba7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/dataExtension.js\":\"74d7f3b7d4dba98d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/effect.js\":\"72c0f9deb3d27344\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/index.js\":\"8d949197e466bdc0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/keyCapture.js\":\"5822837f5b0d1205\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/overrideStore.js\":\"f441e9336c25e98e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4327bc9f1f4cab2b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/HeaderItem.js\":\"b5ed2aac1c2e7776\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/LeftSidebar.js\":\"31137b6624b3b883\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/actions.js\":\"8bd916c8e73a2eb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/facet.js\":\"ea9f0e70693351be\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/index.js\":\"93f85083a237434b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/shortcuts.js\":\"f49a38ffc001d67c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/toggleStore.js\":\"93facd48f88ccc7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/MergePicker.js\":\"f2e3bcaaea38cfb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/index.js\":\"ba89bbf055aa387a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/mergeAction.js\":\"4b130c20755176cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/strategy.js\":\"2b589d87d10936ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/Button.js\":\"21227ac5a7c2f14d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"900267f68fc2be72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/defaultItems.js\":\"1ad620c9a295ee70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/facet.js\":\"62466a5a72568b9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/index.js\":\"e96b0f906093e7da\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f3fa265c8100b402\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5d91c23193b35dbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c6cbdb83a49c1889\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f19b6eafe72c698a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/index.js\":\"d9c6c88d4826d8aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/MoveDestinationPicker.js\":\"561b0e6bc8d1af49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/blockSubtreeMembership.js\":\"01240cd3ae8040e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/contextMenuItem.js\":\"a2af3b2ab0421656\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/index.js\":\"69dbc38cdef7dd4e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveAction.js\":\"0f65c9cc8b125c98\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveBlocks.js\":\"48c81f197d7f6f5b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/selectionAfterMove.js\":\"7153e88fb981adda\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/TutorialBanner.js\":\"d0289e4c0e669ac7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/action.js\":\"9df0369719b86f37\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/bannerDismissal.js\":\"e6ac90fe5fb8cbfe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/documents/cheatSheet.js\":\"0cd9c1c97e291222\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/index.js\":\"f55351058b961f4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/keys.js\":\"3539d051f8d96d68\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/landing.js\":\"a737e102242386b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/outline.js\":\"3f9532225246c777\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/seed.js\":\"ea740e01296be436\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3392e03fc4b23976\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/analyze.js\":\"472d82f15d8ec5ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/diagnosticsSource.js\":\"164041b45de6da60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/index.js\":\"8425f203dd8ea603\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/load.js\":\"d7fa3ebdc1ebbf7d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/monitorRun.js\":\"7d7af7a7ad38846e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/schedule.js\":\"4cb4f66211fbbc37\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/series.js\":\"f738549cffb0e213\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/store.js\":\"105c78dfb94b5686\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/trendAction.js\":\"857d060e6a08cd2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/verdict.js\":\"b42d6d843f8d29fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/clickToEditAction.js\":\"3dc0322274150b2b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/index.js\":\"bd1aa44ac6b4c246\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/interactions.js\":\"7e94d250a6d1d008\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8732c9bc2001c606\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGate.js\":\"044f750379cb2bfa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGateDialog.js\":\"b379ae129450062c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/action.js\":\"0473af5e2ccfb157\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/index.js\":\"4dea2c583f4d26fe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/localRunMessage.js\":\"80fdf1403fbbcb4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/plugin.js\":\"f2164c9116620043\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/progressReport.js\":\"4db505ffde07f2f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/sweepProgress.js\":\"3889a493dfaad9dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/FieldRowRenderer.js\":\"39bbf6ef1e3058bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/ValueRowRenderer.js\":\"a4247c3207982138\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/actions.js\":\"961a6a1d1d1838cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/autocomplete.js\":\"bb6434ca6651d6c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/fieldRow.js\":\"0f88dda79f76528b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/index.js\":\"d7883723fa96ec36\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/referenceWarning.js\":\"7106f5a683b130bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueAutocomplete.js\":\"d66a343586a6793d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueSchema.js\":\"0eed5fee0602ea6b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/HeaderItem.js\":\"59366327efd912f5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/QuickFind.js\":\"fc4f976642db6ef3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/index.js\":\"fb6bbe4b158921fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/recents.js\":\"67477ba3a2692d84\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/resultItems.js\":\"d92a3437a2f1e2e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/selection.js\":\"520a3e2eef7c780c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/toggleStore.js\":\"14e6894fdd4a45df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/HeaderItem.js\":\"3426549140f1c4d6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6a2bfac83412f565\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/grouping.js\":\"ef325328ceee0be1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/index.js\":\"d23026844d190e08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/target.js\":\"3aa3fb15ddde1367\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/codeMirrorExtensions.js\":\"f0af77b38e09c015\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/contentPrefill.js\":\"d2aa69c966c40a13\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/dataExtension.js\":\"d13e5d779b1f2d9d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/index.js\":\"051284ed26aabd04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"726a1012aa2b0efa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/invalidation.js\":\"da2c143c05576572\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/localSchema.js\":\"cdc18feb7224ef55\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/index.js\":\"e91b6a73a46be7b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"cdf5bc64a6490207\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/index.js\":\"38de4b030fe22c12\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/referenceNode.js\":\"fa7d3b2866bb27e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2599b8f0f0c5d82c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5ce8517ca29d28b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/index.js\":\"71d073c60658fcea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ee17e783b387c5ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7507fd48198f5c5c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/mergeRetargetProcessor.js\":\"b15a7bc71cea5aa6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/parseFence.js\":\"f24d15b45169e702\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceParser.js\":\"d9852ff793c74402\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceProjection.js\":\"bb568db16f506ede\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referencesProcessor.js\":\"1da85818b46c73ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/renameProcessor.js\":\"64527b65e08ddaa1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/spanReplacement.js\":\"b874c6b832d6a193\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/htmlToOutline.js\":\"6181bc40b4665e8a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/index.js\":\"9a7563e199695bdc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/normalizeClipboardDom.js\":\"00c110a9e6457848\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/pasteDecision.js\":\"54dd17b813401d7d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/action.js\":\"b788b7faeb7a39a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/blockIds.js\":\"c1c7dd435a0c7f87\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/content.js\":\"bf080e02fb7d9e4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/effect.js\":\"1b71281e16fb9dc4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/ids.js\":\"09a4efc305b24c9c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/import.js\":\"d2a3f0552fa65934\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/index.js\":\"73c352e9c105e79e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plan.js\":\"0bb1ecedddf35587\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plugin.js\":\"21100c1127ae48d6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/promotion.js\":\"9d7c4d383b8fb441\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/properties.js\":\"a528eed11ab15a25\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/references.js\":\"5e1b436a3d5376c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/report.js\":\"cceb29151d0bef0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/roamMemo.js\":\"c84e0f1bd2476934\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/runtime.js\":\"1646c7c4a0c22144\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/schemaReconciliation.js\":\"260145b6d5b72808\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/srsMarkers.js\":\"ce5c566a13060746\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/todo.js\":\"af04c1c94e155096\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/typeCandidates.js\":\"390250f699e0d191\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/types.js\":\"4dcc3eb61305e32f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/index.js\":\"14c8ccd0979011c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/store.js\":\"c97f360b02a4c88c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/HeaderItem.js\":\"0496095756575cf2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"314f57d7095c866d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/index.js\":\"3461e1d963f8a305\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/model.js\":\"07df2352dfc3cf9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/toggleStore.js\":\"cbcfffccb61a4f12\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/useKeyInspector.js\":\"ba6b3cb94a2bc2d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"cb7a68a2ed867ca3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/ShellDecorator.js\":\"6ffee62ad13dfb3b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/actions.js\":\"09ac8f3422a3c0e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/exclusionsFacet.js\":\"71ffef6f5832753b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/index.js\":\"bd8b1221f9b995e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/shell.js\":\"955bfcb5d975a9f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/surface.js\":\"0e16e122e774d77f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/walker.js\":\"8cce8831bd0ed8b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/RescheduleToast.js\":\"87ca4daca296ba9f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/dataExtension.js\":\"ee60b57b84b2dff0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/index.js\":\"dbcbfffdc94a6bbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/indicator.js\":\"c05a1ac659b447f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/moveSrsState.js\":\"f890428d3c355a0d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"854162284f4b2569\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/scheduler.js\":\"7bc875e14cc9bb5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/schema.js\":\"8f2a03cdace58718\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"40567b817bfd7584\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsClipboard.js\":\"503c648e5868a0a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"fa4baa1d9fb5b0b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DailyNoteReviewHint.js\":\"35832a6704545549\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DeckPicker.js\":\"75ddbbd794d29994\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewControls.js\":\"45e31b461f04df70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8b95e9724142633c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewSession.js\":\"a51d8287a5ca66f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/actions.js\":\"a94bcd846db6b5ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/archive.js\":\"85d0a7438f5caa2b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dataExtension.js\":\"b6a7ecbb06621331\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/deck.js\":\"a593287653458a6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dueQuery.js\":\"8fc9d8fe08d88525\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/gradeDecision.js\":\"b088736edd4684d8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/index.js\":\"ab037d1fd63b7976\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/keyHints.js\":\"ebc26d129466274b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewCardLayout.js\":\"2548b677a9e3acbb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewProgress.js\":\"1dedf71c75820d08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/schema.js\":\"885a1084c1b0e987\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/useDueCards.js\":\"e8d72908db3aa0dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/index.js\":\"ea73e243d49defaf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/record.js\":\"34f78e5872bee65e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/index.js\":\"f6475ad2617e29d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/persistenceStatus.js\":\"f157fb35111630c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/requestAction.js\":\"bd6d0f18b4639b58\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/TypeChipsDecorator.js\":\"6d8fc87a66d00c87\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/codeMirrorExtensions.js\":\"0ece44027cf8c9d1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/index.js\":\"0035cd4e72910aa6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/typeAutocomplete.js\":\"a6a23e1b34c48fa4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2d59bbb39087f77a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/actions.js\":\"59257bd8f8570715\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/anchor.js\":\"2a64f0301e519a1b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/events.js\":\"1bd605f86b0a7930\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/gestureActions.js\":\"ab3769d8b52d7a9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/index.js\":\"d66cd66abb59bb74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5ab5a555ebed9749\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/collect.js\":\"470e288bb5cc1129\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/index.js\":\"e8de8fa79ee4984b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/record.js\":\"2bb0a2558d0c07e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/RejectionDialog.js\":\"5bc6b574f9fe6e67\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/SystemStatusHeaderItem.js\":\"37c0a28a8044e1ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/index.js\":\"c344f02fc3e8c27f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/model.js\":\"916b21b5b3e9424e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/queueCounts.js\":\"8444cabf12c4e81d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rejectedHelpers.js\":\"3087f34756e2f2ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rematerializeAction.js\":\"517b558e83053531\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/useHysteresis.js\":\"b1cc003aaa748fe6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/ColumnHeaders.js\":\"6586f036db87d3b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/QueryUi.js\":\"d52548d6e31fb128\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/TableLayout.js\":\"570debbd3e6a1bcc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/actions.js\":\"1a46adb30f705e03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/cellEdits.js\":\"ec640d51f8124378\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/columns.js\":\"8a37fa702cbaf90e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/controller.js\":\"3b85911b4bb2bc80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/convert.js\":\"abe248d1429ef58a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/dataExtension.js\":\"19781cb70cca6c53\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/index.js\":\"f90b49a42ac56aaa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/keys.js\":\"0508051cd2d4c324\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/model.js\":\"b869e91174f9b64e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/backfill.js\":\"1ee634785487319c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/format.js\":\"a04734b45c405243\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/parse.js\":\"387157e433d02a7c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/queryValue.js\":\"6d5a2fefe9475289\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/source.js\":\"e1d04b969e83d20b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/registry.js\":\"4c5a10f5b478f2cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowGutter.js\":\"1c4f062ab00d68b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowVerbs.js\":\"b438f92a65713317\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/schema.js\":\"7331c7ff43f088d6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/sort.js\":\"f609c3721d929a54\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/effect.js\":\"5216bc447aaaa10c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/index.js\":\"c7e625e369e2e9b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/theme.js\":\"3549fa95eee8b46e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/actions.js\":\"03893566df13d1e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/dataExtension.js\":\"60a5352cad5b01ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/index.js\":\"3fe3efa02c24d9ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/schema.js\":\"923af2bca86c73de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/TouchSelectionLayer.js\":\"fae1dc254574f390\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/actions.js\":\"3790d1432a959f80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/defaultItems.js\":\"e8349828964be52c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/facet.js\":\"da8d99f28641e2f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/holdRecognizer.js\":\"fb796441133f7471\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/index.js\":\"6143e49f0396474a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/UpdateIndicator.js\":\"575661a6e0f5cba7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/index.js\":\"28f8287e982de597\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/loadTimes.js\":\"726c87b5debdeb91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoNotesRenderer.js\":\"e81e6a6c9f4ab970\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoPlayerRenderer.js\":\"4995affe0ee753e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoTimeStamp.js\":\"baf5facd6f3d46b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/actions.js\":\"8cf67d75310a82ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/index.js\":\"ab12524391a00ed9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/markdown.js\":\"6dcf0335c5b9cb0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/notes.js\":\"b870d3cbb544a284\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/registry.js\":\"2af9d8bc79002ea0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/remark-timestamps.js\":\"4ce7389db02d586c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/view.js\":\"23e05cfd44145d26\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/LinkHints.js\":\"fa4638c438c52432\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/index.js\":\"6ce3342f00158703\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/model.js\":\"cf6022f966198a6a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/settings.js\":\"1a32018791b8a494\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/actions.js\":\"43a8aec0273de9d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/index.js\":\"1785ebf22a924c63\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/interactions.js\":\"28f0f6cac3f4caae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/workspace-header/index.js\":\"9720d6262f227e26\",\"/knowledge-medium/pr-preview/pr-1850/src/registerServiceWorker.js\":\"2a521e83f9afe107\",\"/knowledge-medium/pr-preview/pr-1850/src/requestPersistentStorage.js\":\"506508599e8eb4c6\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authRequestDeadline.js\":\"70c8ed09f9c310fa\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authStorage.js\":\"ed4ac28f7eb9e403\",\"/knowledge-medium/pr-preview/pr-1850/src/services/powersync.js\":\"5fd59f3cbbe7f3cb\",\"/knowledge-medium/pr-preview/pr-1850/src/services/supabase.js\":\"45fea19dfd021469\",\"/knowledge-medium/pr-preview/pr-1850/src/services/uploadErrorClassifier.js\":\"e2da844c2cf7af6b\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/ActiveContexts.js\":\"4aa4af664b60f93a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/HotkeyReconciler.js\":\"4245c41f7d044bca\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/WipeLocalDataDialog.js\":\"2ce741c82154844e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionDispatch.js\":\"ad747e5cd2fe13cc\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionRefItems.js\":\"fdfcf42225e290c2\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/applyKeybindingOverrides.js\":\"42c5418cd0cd20b3\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockActions.js\":\"746944119a62e23b\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockMergeGesture.js\":\"c172c7378f6e0dba\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/canonicalizeChord.js\":\"3c549a23077a0671\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultContexts.js\":\"bb241b79edc30ae8\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultShortcuts.js\":\"f44ba922e86ae712\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/effectiveActions.js\":\"96d7ff81db6e5577\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureAction.js\":\"e00cdf83a8ba91ed\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureBinding.js\":\"9ebf17d7671a440f\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/holdRegistry.js\":\"a51892a796b8f9bd\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingConflicts.js\":\"cfe1b7c98d756061\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingOverrides.js\":\"8e8ff616c693a432\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/pointerAction.js\":\"7be336691b937749\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/resolve.js\":\"8cef2eaeab60b556\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/runAction.js\":\"728f0abe4b512e2c\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/sequenceMatcher.js\":\"be51b765564caf1d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/types.js\":\"b8befd8704bf2974\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionContext.js\":\"7fc6847823b6c703\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionDiscovery.js\":\"5995f968ea305473\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/utils.js\":\"41a9cb0924f2cfa6\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/bootStore.js\":\"1d07b38fe804ab75\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/previewDatabases.js\":\"d12928cbded3630d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/byteTransform.js\":\"d1d359956563a06e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/attachmentCleaner.js\":\"549b6370d5282662\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/attachmentParts.js\":\"6705f10687ba4129\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleParts.js\":\"be90ffa1aa537e7c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleRecord.js\":\"3dbb5af754473eb6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/manifest.js\":\"579a7d0b95f4e276\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/takeBundle.js\":\"02f9b5d8bb49f8c8\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/verifyBundle.js\":\"70c63e5b21c2708f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/cleaningStage.js\":\"ab3464902aca1b97\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionKey.js\":\"a1481a630d41821b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionServer.js\":\"ca0676f6062932d5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flip.js\":\"713de48c1065b2ce\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flipAttempts.js\":\"8b8875c5036ec62d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/pages.js\":\"7b0dda437cdcd4c4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/preflight.js\":\"bee7581d73499440\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/reseal.js\":\"032fe35e54b76a65\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runConversion.js\":\"ba3e72736aa4fe26\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runLock.js\":\"10ecb8c0d4c961c5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealing.js\":\"9694b1c12760df21\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealingStage.js\":\"e4b27f956ce9f2e5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/stage.js\":\"224c27ef10f096b3\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/verifyReseal.js\":\"d264fe9c41846cec\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aad.js\":\"a55ce457c7705c81\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aead.js\":\"3f173be87d5bf6b2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base32.js\":\"802759853a4801ba\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base64url.js\":\"89ce74f6b29a1b72\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/binaryEnvelope.js\":\"61abd8857ca8fe33\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/byteAead.js\":\"9ec63c582783d7f4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/canary.js\":\"348d7204402f4e8d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentHash.js\":\"3bff1c7f2c3595f5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentKey.js\":\"3783114cbf545758\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/derivedIdNamespace.js\":\"e293d0b0dd6bd3f7\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/envelope.js\":\"5fa864599af6a257\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/hex.js\":\"b58492e14434b0e1\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/sha256Hex.js\":\"1994fd9142183f18\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/workspaceKey.js\":\"1c930ae05419e64c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/conversionState.js\":\"4d220d4a83ff4970\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/createEncryptedWorkspace.js\":\"34786d7ece9a58aa\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/pastedKey.js\":\"ac729fcbd33d8674\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9a653c5948b4bbe9\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/upgradeWorkspacePin.js\":\"45efd81a0f6877e3\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/keyStore.js\":\"d9d22d1cdce14e16\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/mintWorkspaceKey.js\":\"f6ba6674c54714ca\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/modePin.js\":\"3021ae1d4cac99d4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/openWorkspaceKeys.js\":\"2bf2f223d7d61e21\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolveWorkspaceEntry.js\":\"96977f0a5d1e7b6c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolver.js\":\"17bcdf887677a019\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/workspaceAccess.js\":\"635a0e7754f77dac\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/transform.js\":\"6bcd7ca1a9ef2d69\",\"/knowledge-medium/pr-preview/pr-1850/src/themeBootDefaults.js\":\"a4cc57ff89293724\",\"/knowledge-medium/pr-preview/pr-1850/src/types.js\":\"f1ab0fc412041608\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/ClientLocalSettings.js\":\"372e6da00a37dd10\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/abortableSleep.js\":\"a88f8a58ebd4bcc5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/array.js\":\"881291e2d3da2a75\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/backlinkAutocomplete.js\":\"bb0d6575daa4bbe1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockCrumbs.js\":\"128f4f48521a9e6c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockrefAutocomplete.js\":\"c2584cb6f67fe90a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/cadencedIdleJob.js\":\"02430ab905d3a5ca\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/callbackSet.js\":\"17f0884280cb6127\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/clientId.js\":\"9773cc2472b8070c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirror.js\":\"9b7c3f01803ea1fe\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirrorCompletion.js\":\"71e1b9b23a6b48cc\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/copy.js\":\"c784e9feacdfdd40\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dailyPage.js\":\"bdbf1ec928116d40\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensics.js\":\"f3f9cff8b441536b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensicsHooks.js\":\"59871d11c2033953\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/deleteBlockThroughUi.js\":\"f2d82e10f63ac791\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dialogs.js\":\"353e78931c3522de\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dom.js\":\"8a40fa4413a29fb2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/downloadBlob.js\":\"bb970dffaba17db0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/exportSqliteDb.js\":\"cd2512ac235e8abd\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fileSystemAccess.js\":\"da8792f1ae4c9772\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/flipSlide.js\":\"7390751c03475bd0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fnv1a.js\":\"966a422b437b7c65\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/formatBytes.js\":\"a97f967ddf5633e4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fuzzyRank.js\":\"a16fd71192e90c6b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idbKeyedStore.js\":\"6c4b7c23c6c21394\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idleCallbackPolyfill.js\":\"9fd8c203d1f02b48\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardAwareScroll.js\":\"740baa36f9c6344a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardViewport.js\":\"ba515b7b618eb1be\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/lastWorkspace.js\":\"250ab30cdd09982e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutColumns.js\":\"b1ebcd885388b3ce\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionDom.js\":\"fc5e3af9491c2ff3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionId.js\":\"ab59602396a46745\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkClickGestures.js\":\"7586e736f5f21842\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkTargetAutocomplete.js\":\"e5ae56a88f078411\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbCorruption.js\":\"d734d33ecdde8d59\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbRecovery.js\":\"b59d009710abcaf9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/markdownParser.js\":\"b0a781aa595cf711\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/memoize.js\":\"2abdc38e0d153087\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameFieldCommit.js\":\"356d32f929a387b5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameList.js\":\"adc3f00acdde75bf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/navigation.js\":\"edd5a274362eba25\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/omnilinerNamespace.js\":\"f1bdaeb6fc405098\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/opfsPageScan.js\":\"3e178bc588252de4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelClearance.js\":\"2df500a656e3d9c2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelHistory.js\":\"36ce87880597ee61\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLanes.js\":\"b63539aa85d52911\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLayoutProjection.js\":\"c5bd67952ace708e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelScrollAnchor.js\":\"6da91b81b8d142c4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelUrlFlags.js\":\"d02c989176e833e1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/platform.js\":\"d8aac08a65b37c5c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/pluralize.js\":\"8fa7f7ae1dca1d05\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyCreation.js\":\"b294eb8b628f5e88\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyNavigation.js\":\"12d954a04b107bb2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyValueContext.js\":\"3185ce78d6dda977\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/react.js\":\"b363244bffa3bfbc\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeDate.js\":\"7a741db4c3d43472\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeTime.js\":\"b814d40506698f1e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/renderScope.js\":\"c6aa8e098c6e6f34\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/resolvedThenable.js\":\"24a2e69c5c82e75b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/routing.js\":\"b7b741e29460d9a0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/safeMode.js\":\"be1acb616b0d7a6a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/scheduleIdle.js\":\"a6bc3ff73ecb4559\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/screenWakeLock.js\":\"d64e8ffc0761fde0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/selection.js\":\"ae2beba2744a4890\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/softKeyboardGrab.js\":\"63e999e2aca828bc\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/startupTimeline.js\":\"33a580c38d952d70\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/state.js\":\"df06b766e4f3244f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/string.js\":\"f1e81e529e08da4f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/surfaceZoom.js\":\"d77e1742bba17ca1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/time.js\":\"5d89b0d0350eebb3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toast.js\":\"d96a0a7c1e073a4c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toggleStore.js\":\"941ee4f5f5133b47\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/untilStopped.js\":\"982b864f2a56aec6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/userActivity.js\":\"d066cee5d99ad2c7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewTransition.js\":\"b22bbaf46f7acc36\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewport.js\":\"44d61427d9694aac\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/webLock.js\":\"d22edb26ca323251\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceRecovery.js\":\"70708fa29a399be1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceSnapshotStore.js\":\"431dafd158773f81\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-compiler-runtime.js\":\"1b88058725748838\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-client.js\":\"4a74a55009228118\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server-edge.js\":\"c6b3068d8b3c8e4a\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server.js\":\"878cf4aa897e3b19\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static-edge.js\":\"a9a93a0640bb8798\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static.js\":\"f724c37e39db6cc3\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-test-utils.js\":\"2ef1251f25a683d6\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom.js\":\"e65d1a8e30c9da96\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-runtime.js\":\"4f84c886edce0be8\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react.js\":\"66481155b1b5003d\",\"/knowledge-medium/pr-preview/pr-1850/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
