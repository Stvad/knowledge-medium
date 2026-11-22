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
		buildId: "99038579aa0e-b02db176",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/\":\"020a575cb25b4365\",\"/knowledge-medium/pr-preview/pr-1850/index.html\":\"020a575cb25b4365\",\"/knowledge-medium/pr-preview/pr-1850/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1850/assets/FacadeVFS-C3YaxVH5.js\":\"c0df8189857b81d6\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSCoopSyncVFS-B4MHOhJZ.js\":\"41a5843bf3786b10\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSWriteAheadVFS-Bnpvgrdn.js\":\"aaafb46dbe1fabd2\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-C0f-xGTU.js\":\"723f0a1c012357db\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-Djlkx6W6.js\":\"9574ac053ba011f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/worker-CDPWNcV9.js\":\"300a17428e4a5990\",\"/knowledge-medium/pr-preview/pr-1850/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1850/chunks/app-CLDK726F.js\":\"d1264ab75c24626a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1850/index.js\":\"ec7d8ab7971c80a4\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1850/assets/AccessHandlePoolVFS-CjsnhIX7.js\":\"049857fa6c2c8ce7\",\"/knowledge-medium/pr-preview/pr-1850/assets/IDBBatchAtomicVFS-Bd8YX9nf.js\":\"b4044f5239497377\",\"/knowledge-medium/pr-preview/pr-1850/assets/MemoryVFS-B8T71J8j.js\":\"0dcdbc69f987e47b\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-DgeMTr2L.js\":\"c54753da65c0c565\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-DKE1_okS.js\":\"a8a5c5e8e98a84cb\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1850/chunks/AccessHandlePoolVFS-PBa4vhat.js\":\"173e013e2c959e8a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/FacadeVFS-rK2QJSOk.js\":\"5fbf6d2df7e7e599\",\"/knowledge-medium/pr-preview/pr-1850/chunks/IDBBatchAtomicVFS-F7eSflgL.js\":\"c7bbd10419c7e681\",\"/knowledge-medium/pr-preview/pr-1850/chunks/MemoryVFS-vfXW-i_M.js\":\"d1d015c0c636816a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSCoopSyncVFS-Di_SL8l_.js\":\"372c9052de6ebfa2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSWriteAheadVFS-gRLQKiLq.js\":\"e656e3feb2ed5e22\",\"/knowledge-medium/pr-preview/pr-1850/chunks/Preview-GiGiOKS6.js\":\"25c5769272036b10\",\"/knowledge-medium/pr-preview/pr-1850/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/card-BK6miqwa.js\":\"777808492de77a62\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-Dpp4JBHq.js\":\"65753aef4a5a3c0a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-3XaDUhkh.js\":\"bda9bc9ec18249b0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-async-CbRt5IV5.js\":\"924f2a0a8ccb7fb2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BKKr6UHc.js\":\"12d0ae24825e36d9\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BasolzaY.js\":\"c2da342a42efcc40\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BlV0obOe.js\":\"0a104d7a63ff72cf\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-DR5eCiTr.js\":\"a2bcff5042d40e25\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-Dg-wcm0S.js\":\"0b0f6ba01128f834\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-ENgOOWQC.js\":\"5bfad5186fb26c66\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-HPaLAzjX.js\":\"098e4bc904a5c4aa\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server-legacy.browser.production-LGyr8dV5.js\":\"c6a6ad03db1bfbcc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.browser.production-ChkWT_7j.js\":\"a0308683718655eb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.edge.production-Bp6dE8wX.js\":\"27b77cd7d6c9a4e4\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-ukVnak0V.js\":\"d11addbf1f9d96c8\",\"/knowledge-medium/pr-preview/pr-1850/chunks/server.browser-D3Ue8dhA.js\":\"a794d0cf262cfcef\",\"/knowledge-medium/pr-preview/pr-1850/chunks/textarea-zmH7WZLZ.js\":\"8426ba04d7806c62\",\"/knowledge-medium/pr-preview/pr-1850/chunks/ui-DHDFxZnq.js\":\"8b32e0abe4a60e96\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-CKYkn7lL.js\":\"61af9430e5900fcb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-async-CTvqRNLY.js\":\"4918cebd32c5c0df\",\"/knowledge-medium/pr-preview/pr-1850/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1850/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/src/App.js\":\"18acb7850aa1fe77\",\"/knowledge-medium/pr-preview/pr-1850/src/appUpdate.js\":\"b1d99ccf4d0641fc\",\"/knowledge-medium/pr-preview/pr-1850/src/appVersion.js\":\"0eb68db5f4010fd2\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/initialLayout.js\":\"bdfd1d5f88176980\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/openWorkspaceData.js\":\"ecd8a1ee7e610189\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/resolveWorkspace.js\":\"547b8e4a8e26cc5f\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/workspaceBootstrap.js\":\"b937c0cf62bed55d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockComponent.js\":\"e96148182c4bfa48\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockCrumbs.js\":\"66846ef7560ca4f2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockEditor.js\":\"1544e329eeee00c7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockLoadingPlaceholder.js\":\"9f098526efa74229\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockProperties.js\":\"d5b326f886e00d56\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockSearchPicker.js\":\"ecc7eb6698ff51d2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ConfirmBulkDeleteDialog.js\":\"3aeb5941d3a954f0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DividerHandle.js\":\"b339adbd3b3513c3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DraftEditor.js\":\"374f242af674b5f6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/GutterPill.js\":\"639fa3018d4b4e27\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Header.js\":\"b71b1a7835b3d98d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/LazyBlockComponent.js\":\"478853f6bd79d2e1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Login.js\":\"ad9b6dfd4c2c5134\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ZoomableSurface.js\":\"6abe030ac3305056\",\"/knowledge-medium/pr-preview/pr-1850/src/components/editModeKeepalive.js\":\"fdb5d7a4f8093979\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a502024169c654b4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a63f30098e08118e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefPropertyEditor.js\":\"1f584d164118adb4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefTargetTypePicker.js\":\"8735ade24dee395c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/SelectPropertyEditor.js\":\"67cd6facd3225b07\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/TypesPropertyEditor.js\":\"cc09e269bee16093\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/defaults.js\":\"f0784412bee99ee2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/kernelValuePresets.js\":\"7273e41b7742ff31\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/selectablePresets.js\":\"84b7a6ac6c7dc366\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/typesPropertyUi.js\":\"15e4faf624fca3db\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/AddPropertyForm.js\":\"26f4f47af1d920d5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyPicker.js\":\"2974670e38fe7d64\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyRow.js\":\"a2fab39be2b0283a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/Rows.js\":\"e81ed7ff819d32b8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/actions.js\":\"139ca819d7b41fc0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/declarationOnly.js\":\"70498107f5cf8a45\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/layout.js\":\"dce550cff3b1a288\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/model.js\":\"d9b19f9ea663cb78\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapeUi.js\":\"aa3a80c5e806c043\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapes.js\":\"772db580202197b5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c0313be161ea38c0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/visibility.js\":\"b4771b1446b1b1d4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanelSections.js\":\"c7db865cd1d96659\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockEmbed.js\":\"0d5d815b04a782f8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockLink.js\":\"0a1ceb448526a55c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockRef.js\":\"bd11d5657b0078cd\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/ReferenceLink.js\":\"95678f8827e41bf9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuard.js\":\"6598cf05a67a6f6c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuardContext.js\":\"be9d7a3cb03d7efe\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/linkInteraction.js\":\"1cb7318a5ac8c5b6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/referenceLayout.js\":\"2a9d1667d701efec\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/useBlockRefAncestors.js\":\"48ec65b3f438cce3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockGutter.js\":\"49881c4769f916c3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockInfoDialog.js\":\"11e9cf829c041f14\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockTypeBlockRenderer.js\":\"6eaace0e751e7695\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BulletHoverCard.js\":\"daf25662a4ffcf6d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorContentRenderer.js\":\"c8793b689a6b304e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d715c064b59b0794\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ColumnResizeHandles.js\":\"623c6fb3484abf1e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"014e93dc57acaba7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/DefaultBlockRenderer.js\":\"3620f4b7f5fb77a0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/LayoutRenderer.js\":\"85838b4c19f80fb5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MarkdownContentRenderer.js\":\"e2d4e2927dd464c1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MissingDataRenderer.js\":\"2371ea41926e4835\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PanelRenderer.js\":\"5e68f89d470f3dc7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0bd1f7253d46000a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/TopLevelRenderer.js\":\"1247ec5cf37a4c2f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockGutterMode.js\":\"9997a4ba9b90c445\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockTitleText.js\":\"2fedb9cac80b56de\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/fieldCreationKeydown.js\":\"348c123732eb8bc8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/layoutRootContext.js\":\"7c229a37656600bf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/TypeChip.js\":\"83df7852bccb97c4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/chipStyle.js\":\"10fd21f42118da9c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/anchored-floating.js\":\"5b59943b3fd10093\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/button.js\":\"858dc28281f52f74\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/card.js\":\"4fc8f6731a87ac0d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/checkbox.js\":\"2428a25d7ba11641\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/collapsible.js\":\"c97c900f698d2594\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/command.js\":\"2e939052f472d625\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/context-menu.js\":\"c56e3ba207a6ad29\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dialog.js\":\"3ae1c4e7e59a002d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dropdown-menu.js\":\"1adf1aeec1e533e7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/floating-listbox.js\":\"c4f2c2826cc8bf5f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/index.js\":\"8413e652c75a98e5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/input.js\":\"ff02318f6565890c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/kbd.js\":\"f89604e0fe6b8996\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/label.js\":\"0771e8fc75da1c63\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/textarea.js\":\"5569c557921f9d11\",\"/knowledge-medium/pr-preview/pr-1850/src/components/useEditModeYieldKeepalive.js\":\"92edecebdf92aab1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/BootFallback.js\":\"7e0294b949fe610e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/FocusedRowLazyMount.js\":\"4e3b599b900e291b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LazyViewportMount.js\":\"5662f04355bc4926\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LocalDbCorruptionFallback.js\":\"f3dd9f9209b26a89\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/error.js\":\"2035a7e8c45636ea\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/lazyMountRegistry.js\":\"f430e805a14008d5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/suspense.js\":\"86f349a9b7f381ae\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/CreateWorkspaceDialog.js\":\"78b9c87ae5d3b926\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/PendingInvitations.js\":\"0b6a3ddea8f4f625\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/SyncProgress.js\":\"fa470ebe499a6bb1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/UnlockProgress.js\":\"4e394771e1db7992\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceKeyGate.js\":\"d4a9f5bf5cbd49b9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSettingsDialog.js\":\"61da8274c0bbf724\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSwitcher.js\":\"91633f07c550797e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSyncGate.js\":\"af8792d0b3315d9c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlow.js\":\"28fc3e96b5134800\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlowHost.js\":\"02af5dbcc5d26b9c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/EncryptionSection.js\":\"2eb279ba3e0f155b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/attachmentPrompts.js\":\"54be8345af68d5e5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d82c36914f51f3ee\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowDeps.js\":\"44cb9b1c38a6f219\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowStore.js\":\"19a847969d6b6c08\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/flowUi.js\":\"520238ff292d9ce5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/useConversionRun.js\":\"3dbec82f72292c76\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/keyUi.js\":\"146cda465743fe1a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnKeyLoss.js\":\"53d543d38a627666\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnServerE2ee.js\":\"b032b386f4be5be4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/workspaceUnlocked.js\":\"2786186605cb192d\",\"/knowledge-medium/pr-preview/pr-1850/src/context/backgroundSubtree.js\":\"fd00659158eb8796\",\"/knowledge-medium/pr-preview/pr-1850/src/context/block.js\":\"0e5e402c21b7ba1d\",\"/knowledge-medium/pr-preview/pr-1850/src/context/layoutWsContext.js\":\"cc65ed419fed2459\",\"/knowledge-medium/pr-preview/pr-1850/src/context/propertyDisplay.js\":\"aada5944700392f8\",\"/knowledge-medium/pr-preview/pr-1850/src/context/repo.js\":\"aa21662eb5dc19b0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasClaim.js\":\"d86fb50230a6cb7b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasSeatNamespace.js\":\"3ea8db2c870c25ef\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockData.js\":\"ac34f97c794243fa\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockType.js\":\"9723172d35adba42\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/changeScope.js\":\"12a95cc5b0f89fab\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/codecs.js\":\"4b85d83f5ef73b57\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/derivedData.js\":\"8180caf350709980\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/errors.js\":\"be108c1cf571cca6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/events.js\":\"207fd2a255ceefd3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/handle.js\":\"6ae2e76f58da8223\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/index.js\":\"ab3a788cdf1980b9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/mutator.js\":\"2cab646e802dbc9a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/processor.js\":\"53c3f4c79555ca94\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/propertySchema.js\":\"44264e8c50350a92\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/query.js\":\"e65604122f41edd4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/sameTxProcessor.js\":\"01a2e859643f728d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/schema.js\":\"6ae2e76f58da8223\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/tx.js\":\"6ae2e76f58da8223\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/typedBlockQuery.js\":\"b50ff8b459cc00dc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/user.js\":\"d1c234b7a4cc3ce2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresetCore.js\":\"8f76e59ea9cbe08f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresets.js\":\"37db51b4ce922b8f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/attachmentCleanerIOVerb.js\":\"c42c055e3c0b92e6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/block.js\":\"8b027b9218079fe5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockCache.js\":\"b765b21923efef0a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockId.js\":\"d4ce3a069dd9febf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockLiveness.js\":\"9c5a23b6aac77e44\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockMerge.js\":\"fe0779d35499f636\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockSchema.js\":\"7cd12c8db72b8425\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypeLookup.js\":\"931219847fc8bf8b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypes.js\":\"caaa1bd88831e480\",\"/knowledge-medium/pr-preview/pr-1850/src/data/clientContext.js\":\"9f06238edebeb0db\",\"/knowledge-medium/pr-preview/pr-1850/src/data/dbFileSiblings.js\":\"d6c1de75f750d179\",\"/knowledge-medium/pr-preview/pr-1850/src/data/definitionSeeds.js\":\"1950faf7816d7df2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/derivedIds.js\":\"a152312d3bba1fa7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/drawnSubtree.js\":\"a234f6aaa8f98e0a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facetBridge.js\":\"5fc7f2b98369c694\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facets.js\":\"ce645bd1aa6755cc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/globalState.js\":\"44618e8dab38ad42\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/aliasClaimRederiveProcessor.js\":\"71b559daeb1d73b8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/ancestorBatch.js\":\"f587578b3d33cdc7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/blockTypeTypeifyProcessor.js\":\"29b9c92cbd8243f0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/clientSchema.js\":\"58169b656f6ed9bf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/commitPipeline.js\":\"a67f243e32ef711c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/devAssertions.js\":\"2024fe6e2800be4e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/firstSync.js\":\"924a22d1e4fc3b30\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/freshInitialLoad.js\":\"eeba578b45bd857d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/graphBackfillClaim.js\":\"0b6a2028e4bacb7a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/handleStore.js\":\"55066331ecc61e52\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/idleMarkerJobs.js\":\"d6dec82d9c18ad25\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initialDownload.js\":\"65f5a5656f5bfb4a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initializeClientDatabase.js\":\"493a581edd53dabb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/jsonCanonical.js\":\"20220043242a7bfd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelInvalidation.js\":\"181d15f79db9aeba\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelProcessors.js\":\"a64be45eedce5fb7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelQueries.js\":\"3a2eea8321b41eea\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/mergeTypeMembershipProcessor.js\":\"3957131cb16914f8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/normalizeReferencesProcessor.js\":\"6454334a09595c26\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/poolInstrumentation.js\":\"4176e2390d6e1ffb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/processorRunner.js\":\"77dd462507fe0dcb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyCellBackfill.js\":\"b8e1e0b9516a5e6e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildMint.js\":\"13289493bb7f738b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildrenProcessor.js\":\"a62efd0b133b15db\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionChangeProcessor.js\":\"fd7a944c6d755f9e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionSynthesis.js\":\"2cd3bec2640c9476\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyKeyScan.js\":\"d5f8c583e4b2edd1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertySchemaResolution.js\":\"77c6e93c5287befd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyValueEdits.js\":\"eefdc705f9cdc32a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/raiseProtocol.js\":\"267275f278d05ea7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/readBatch.js\":\"ae5cc88281683d95\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/refProjection.js\":\"5c47c747fb3fc652\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetLookups.js\":\"71795eddbd5abbe2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetProcessor.js\":\"29e490fedc799c6d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/replayMerge.js\":\"609200868f54455b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/sqlBinds.js\":\"38aa4c9ad81915ae\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"832a3c7ff62a2460\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/arrivalProcessors.js\":\"c0a3e774cc96caaa\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/invalidate.js\":\"ec0d8a749fbdbbe1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/materialize.js\":\"b4517db20c98dc06\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/observer.js\":\"88b91abcb006b288\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/reconcile.js\":\"b8ffc061df7ae207\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/timingMetrics.js\":\"a53c60ff8c8e6aba\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/treeQueries.js\":\"8975ad785bc1d0c8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txEngine.js\":\"d53f7db65c270cbe\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txSnapshots.js\":\"4b619bc776e31a5e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/typedBlockQuery.js\":\"0defb589e50de351\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/undoManager.js\":\"035db372714413f0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/invalidation.js\":\"764a52a402ae92ac\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelDataExtension.js\":\"f78b2da9110fe637\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelPage.js\":\"a2158a107cf4eec6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelValuePresetCores.js\":\"216214672194c708\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbCorruptionSignal.js\":\"0ca6fa1d4c4775c1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbStorage.js\":\"97b04543b77518d3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbVfs.js\":\"c1254bc743e6ac9e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localSchema.js\":\"45d16babeed5e3e9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/maintenance.js\":\"b9371742e0c6b244\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mergeProperties.js\":\"5375d9b4de5e2b23\",\"/knowledge-medium/pr-preview/pr-1850/src/data/metricsConsoleHook.js\":\"47e32a045de2240f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/migrationsPage.js\":\"7c89930e7b197c73\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mutators.js\":\"1caca3a4a13fae8f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKey.js\":\"dc95f2e9872a52df\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKeyPlacement.js\":\"b7e8bad3b345d01a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/outlineSurface.js\":\"755210581a6ce7c6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingEditorContent.js\":\"28e70727d39ee24d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingUploadsSql.js\":\"8c098b798f0a53ae\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pluginStateExtensions.js\":\"5de2f71189c369cd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/powerSyncLogger.js\":\"17f4b00ac52bfe56\",\"/knowledge-medium/pr-preview/pr-1850/src/data/projectorRuntime.js\":\"2ea7d3c5d965578b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/properties.js\":\"97674e9c4110e9c9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertiesPage.js\":\"cbec6d61a519e7fc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyChildren.js\":\"6363964ed48ce6c2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionFanout.js\":\"dfe6688a3d01e60b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionMetadata.js\":\"444e9c4b3e8e46ce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionRegistry.js\":\"91272fbdb887755c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDisplayMode.js\":\"a573a7b49bbcde27\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyRowCreation.js\":\"69e77c0b14b4aa67\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySchemaCreation.js\":\"80a7c7d292100fd6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySeeds.js\":\"ac875ea5daffad5b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/recentsPage.js\":\"585feaebb20f77bc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/referenceBlock.js\":\"d69fcda9b983bdf5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rejectedUploads.js\":\"badd3508515884bc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/releasePowerSyncConnection.js\":\"88669a03d79125b9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repo.js\":\"3610050bbb85b88f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repoProvider.js\":\"869bf8b34bb2e650\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rowProperty.js\":\"5942e821348b23a7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/searchFilter.js\":\"3004b62d60fee26d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/seedIdentityLedger.js\":\"cf59b340cd7f1293\",\"/knowledge-medium/pr-preview/pr-1850/src/data/stateBlocks.js\":\"49d0f8028cdba0d5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/structuralEditPolicy.js\":\"d05ae244d6bc1828\",\"/knowledge-medium/pr-preview/pr-1850/src/data/subtreeDelete.js\":\"be59dc956992ab54\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncStreamLock.js\":\"4e05009924c16299\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableSqlRecognizer.js\":\"0171c29310e0523a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableWriteGuard.js\":\"d504e40849f1498a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/targets.js\":\"2c18416f45e6503f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeColors.js\":\"cc722d20a82ec405\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionMetadata.js\":\"f657a232e739027f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionRegistry.js\":\"8a08c3ae444df336\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeExtraction.js\":\"d540f6e38a07b675\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeInitialValues.js\":\"815315934e07f939\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typePropertyGroups.js\":\"b2191044d907fd0d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeSeeds.js\":\"eba2d201bb0c6d28\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeTagger.js\":\"cb8286430ef0d1ae\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typedRecords.js\":\"8c49d9d63d62049e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typesPage.js\":\"53bb562d2c7f6874\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userPrefs.js\":\"4dd43b35437cdaa0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userSchemasService.js\":\"475dcec6a1d62422\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userTypesService.js\":\"c4fa54060bea3746\",\"/knowledge-medium/pr-preview/pr-1850/src/data/valuePresetRegistry.js\":\"c03bb9a27f596f8c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/visibleChildren.js\":\"dcacf76b55b4dedf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceConversion.js\":\"a27dbfc94f213a03\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceFirstSync.js\":\"3dbd889685276e67\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceIdNamespace.js\":\"826238789ec6f508\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceSchema.js\":\"afa785e135eb4561\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaces.js\":\"0bed759315e7573a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadLog.js\":\"b77845e8769b1aec\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/BlockPasteShellDecorator.js\":\"9ed7243a31e543f7\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/atTrigger.js\":\"fe6dbcce26367b56\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/autocomplete.js\":\"2290fc0ff165e74e\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/codeMirrorExtensions.js\":\"e32a65d9f3a30b82\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/contentFlush.js\":\"46cc9fee777b7708\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/defaultInteractions.js\":\"6c2d8502b1bfb44a\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/editSettleSignal.js\":\"b4f70e4a9be100e3\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/insertImage.js\":\"a7fc2d8a063764ef\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceCompletionRange.js\":\"ffee948107723248\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceTargetTypes.js\":\"d154682d718119ac\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/syntaxContext.js\":\"029b680ab942badf\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/triggerMatch.js\":\"8d69e0f550924fda\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/AppRuntimeProvider.js\":\"bfe56bb23fd31116\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/BlockFocusShellDecorator.js\":\"06de4e68b8bba4bb\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/ExtensionRenderBoundary.js\":\"9c4443cf41dfe191\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/PanelContentRecovery.js\":\"67037dfe0fb837d9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/apiCatalog.js\":\"8c554c0352ee801e\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/approveExtensionHere.js\":\"b38c016f3fb789bc\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/armedCutAppMount.js\":\"c568a28cdd041ccc\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/batchableKeyedStore.js\":\"51f043efacb4b1b7\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockInteraction.js\":\"6cef7a634b318d9d\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockSelectionAction.js\":\"b30b786a2aead2bd\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compileExtensionModule.js\":\"41fc9ad46c30eba4\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compiledModuleCache.js\":\"b7c4b2b95d5c668e\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/continuousGestures.js\":\"64b31f197d3b95a3\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/core.js\":\"1852f3204adab8ba\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/defaultRenderers.js\":\"d38ce99e8283e492\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/definitionFanoutAppMount.js\":\"ddbb1b8df1887362\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dialogAppMount.js\":\"9f8fa08800360c22\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensionSeeds.js\":\"b9b8d0fa4b247f5f\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensions.js\":\"c2d18b2a7fb5b13c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/exampleExtensions.js\":\"8c78ac1701686be7\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionApprovalStatus.js\":\"eaf64313dbc7d7a8\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrorToast.js\":\"b90a02a9f30d205a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrors.js\":\"72b808f1c9f2ca4b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLookup.js\":\"dacb5ce8e6f488f4\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionToggles.js\":\"1c6a2366770cea81\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionUtilitiesCss.js\":\"10d6b085ea73aa40\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/kernelPageDeletionGuard.js\":\"c0dee0a7d74289ab\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/liveRuntime.js\":\"88cce8e24991576f\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/openExtensionsSettings.js\":\"ba109f8346b251f0\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/overridesCache.js\":\"fde38bb98dd0b4bf\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/pluginIds.js\":\"e2e5aabddef33777\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/processorRejectionToast.js\":\"42331fd230816cd1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeActions.js\":\"8ba8fa958080e785\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeContext.js\":\"2a937ff7c2406b41\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticAppExtensions.js\":\"82685949ea76f2be\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticDataExtensions.js\":\"b9c2cb0c580e765f\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/toastAppMount.js\":\"e9ebf33b44121db1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useOverrides.js\":\"7d3b6dc468b7e113\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useShortcutSurfaceActivations.js\":\"2928f794e550d41c\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/discoverToggleTree.js\":\"4a741ddb431204ff\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/facet.js\":\"80af465e66004331\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/resolveAppRuntime.js\":\"469402673ea07e2d\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/runtimeEvents.js\":\"27161970eae7cdc3\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/togglable.js\":\"2ad5123461b25435\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/variantFacet.js\":\"91242faf8c261248\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/verbFacet.js\":\"ae82bf8d2a26e0fd\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/block.js\":\"8af5aa75472d9dfd\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/focusedChild.js\":\"d3522fb00e7cf9f6\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/propertySchemas.js\":\"8755837c21ed5972\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/typeRegistry.js\":\"ce9765ef2ed0b484\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAncestorCrumbs.js\":\"7ae3468802e15cd7\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAutocompleteListbox.js\":\"d5ae9388c8aaa1bb\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedSearch.js\":\"38a897ad6bdd6ea7\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedValue.js\":\"dd8718f46b128b5e\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsFocalRender.js\":\"5935c11c98701ff8\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsReadOnly.js\":\"7b4a243b62c48895\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMaterializeBacklog.js\":\"da1035ca7a852361\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMinuteClock.js\":\"ee4ea7585d926ea5\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePanelLayoutProjection.js\":\"6494568744abbd12\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePendingInvitations.js\":\"3e839563cb8e1fae\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRendererRegistry.js\":\"55806c321941b43b\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRetainedFieldRows.js\":\"58830caa751b7520\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useWorkspaces.js\":\"d10897bb0411e2f1\",\"/knowledge-medium/pr-preview/pr-1850/src/lib/utils.js\":\"4c7b58739e21c0fe\",\"/knowledge-medium/pr-preview/pr-1850/src/main.js\":\"385944176807cc29\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/MarkdownImage.js\":\"fdbf7be5406440de\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/blockSeparators.js\":\"c8ff18edf14978a0\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/context.js\":\"df92400c174bac76\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/defaultMarkdownExtension.js\":\"9c758feb36c7ede7\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/extensions.js\":\"215a2abcfc09d36b\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/renderMarkdownHtml.js\":\"a604fb1dee395aee\",\"/knowledge-medium/pr-preview/pr-1850/src/minimal-editor.js\":\"fc85ffe598966753\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/armedCut.js\":\"c2b543c02448f872\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/captureMediaVerb.js\":\"0c88168ae61d90ae\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/clipboard.js\":\"a58d8a447603f61a\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/decision.js\":\"c069e9709ee13f20\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/operations.js\":\"e64c518df7350c9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/AccountHeaderItem.js\":\"c43ffa51b0656d6f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/index.js\":\"e3b213d22ff62a23\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"988abe7ccb8100ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askAgent.js\":\"f0e8f5ce4a04142d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askedStore.js\":\"97542728917c753f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"430779341227c49c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/chipState.js\":\"b3a96e11d5813000\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ccd5a121e60e83fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/index.js\":\"f4482ecaf89cff40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8f52bc6571fc282d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/schema.js\":\"3ef1dfcee00c7167\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/AgentTokensDialog.js\":\"25f71383e2d89b6a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d652afe34c031ffb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/addMedia.js\":\"bc2c1f4142dfe81b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/backlinks.js\":\"45c9ff11e71c9918\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/block.js\":\"3f5dfde8217d7f45\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/context.js\":\"eb6f926decb2b7c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9ff85f7204852e25\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/index.js\":\"d533fe7d9566f0c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/outline.js\":\"cc26671da29a1729\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/properties.js\":\"8999042a598218a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/refs.js\":\"e507d09bdbd90736\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"c6612c95a43c068a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/search.js\":\"9df16042c3c28021\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/shared.js\":\"f82df5e7aa171b40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8707fa83c6dccb50\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/text.js\":\"5bc16e1d624820f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentWrites.js\":\"c73022f7219c389f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/authoringCatalog.js\":\"a43e218b62122ca7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/blockRefTargets.js\":\"7aacf587aeff940d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridge.js\":\"a869acbae295a473\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridgeLoop.js\":\"b9eee3a2e4c83292\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/changeHistory.js\":\"065c44c1cde25d79\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commands.js\":\"25b2d403bcbb436e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commentsCommands.js\":\"6896a3df5bf6d8b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataExtension.js\":\"9329d7c4b99e0dda\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataModelGuide.js\":\"73ac198f28ff5815\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/describeRuntime.js\":\"3baebd0a63bc7e16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/extensionLint.js\":\"dc356f892c098356\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/grainAudit.js\":\"9939d96912ff88d9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/healthCommand.js\":\"6200badbc50fbd14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/index.js\":\"231704bbd4b9b9dc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/presetIdentity.js\":\"4a90f3a0db8ae3ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5312b1ed5a6f7dcd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/readMedia.js\":\"3b112e90cc0e266d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/schema.js\":\"c7d9391eb13aec40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/serialization.js\":\"1dcc7d73477cdb53\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/targets.js\":\"178544fdf52d0988\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/tokens.js\":\"fcd4617a09f8de9f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/watchEvents.js\":\"55a690b06dec82bc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/workspaceGuard.js\":\"a9dd3f0cad0aa4ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/writeCommands.js\":\"1217330a91dacabe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/AliasCollisionToast.js\":\"64d0ec72c01f44a0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/DuplicateNameBanner.js\":\"5f6177ae07d70b49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/collisionMerge.js\":\"e1fc244a24cea619\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/dataExtension.js\":\"bcf19837fc85f764\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/index.js\":\"a62c3f79b71fbc5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/mergeCollisionAction.js\":\"ac04ce6dfbd57a2e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/pageStyling.js\":\"9c4e029fcbba4c76\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/rejectionToast.js\":\"7aabf76ffa20a6fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/syncProcessor.js\":\"a144997ea2327b6a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/actions.js\":\"bef398bc844e6d78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/addComment.js\":\"202432fb85b71f39\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchor.js\":\"e9a247fd72d033c3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchorState.js\":\"2e2f190506f781c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/commentLinks.js\":\"5832d5cb5f58a408\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/confirmThreadDeletion.js\":\"9b6fd10843f48fe0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/container.js\":\"dd921739e921b8a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/dataExtension.js\":\"2c250335f286a086\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/deleteComment.js\":\"1d34208297f137a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/highlights.js\":\"32b2ab0d11bcd6ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/index.js\":\"534846016cb473b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/linkedCommentsPill.js\":\"3411d6ddd56bd3e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/margin.js\":\"a3a606484732d863\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/marginSchema.js\":\"902e071c000e4fa0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/newComment.js\":\"9d20551ace2acd29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ownThreadPicker.js\":\"50bf654c9b0046f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/placement.js\":\"3e81980cda59a4fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/queries.js\":\"2e955f11cbec881d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotePosition.js\":\"230dd1178cde676a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedIn.js\":\"1845036ff26cbd78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedRange.js\":\"e9ac51de28968be9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/rangeRefs.js\":\"5d5b9f75a1806ca2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readHighlights.js\":\"a0e3784bafcdb077\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelection.js\":\"5d1ac46824c3443f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelectionUi.js\":\"7e34433d6ba2087d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/reanchor.js\":\"1a0f05c7b679d240\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/schema.js\":\"993e23f14f001971\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scope.js\":\"0389af5470614645\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scopeThreads.js\":\"7707b08adad61337\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/splitRetarget.js\":\"8347ff4818bc9a77\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestionCard.js\":\"120e9528d71f1a49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestions.js\":\"77ae1f9d2e80da14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaries.js\":\"a61b001aee38fd39\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaryBatch.js\":\"3db2e1fa7e227139\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/surface.js\":\"c139db931a72a9e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threadNavigation.js\":\"6534de9761741a52\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threads.js\":\"9c14f5bbdd17dd89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ui.js\":\"faed548a8791dc36\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/uiStore.js\":\"c6c3ecee23c9867e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/appIntents.js\":\"50ff7dcdd52da1cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/index.js\":\"d99b7357f545df45\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/index.js\":\"84da39c6a9f822f5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/status.js\":\"406a36fe7de42ffa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6a0eb7dc040df278\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaBlockRenderer.js\":\"c4fb11f11c9e0dc8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ab4a67b289d76eed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaUploadReconciler.js\":\"2941f4bda576afeb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetDownLane.js\":\"2e87a3c833e24137\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetResolver.js\":\"486c94649e028d87\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetUpload.js\":\"b5f3a20677ff8367\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/attachmentCleanerIO.js\":\"291453de818666d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d347d27b30349ddf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/blobStore.js\":\"c8131225f9fe50a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/byteStore.js\":\"7d330cd3cec0ff9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanerIO.js\":\"51e1ed4c270eb866\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanupAttachments.js\":\"0fa80dcbfb86e30c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/dataExtension.js\":\"2931ad5ea4f6c83a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/downLane.js\":\"420bbc386b41f2c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/index.js\":\"8764addc3543fc07\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/insertImageContribution.js\":\"6dc6ca52582b51d7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneArming.js\":\"e1531a6605776e69\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneLock.js\":\"fb8e591c2dc3df9a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaBlock.js\":\"db7c2075f8b510f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaCapture.js\":\"f4818f15a016eb11\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewers.js\":\"95bc540e40f68a08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewersFacet.js\":\"666c88100ef2a4d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/pasteCapture.js\":\"f868e799422b4a2b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/resolver.js\":\"ae18827499869a1a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/retryUploadsAction.js\":\"6752284a882b460c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/storagePaths.js\":\"83329671ab9af396\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadDrain.js\":\"217354b39f2dbac0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadLaneStatus.js\":\"776929e485b89406\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadReconcile.js\":\"0a7188b95f88d4fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadRecovery.js\":\"d0006c9c130b25a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadStore.js\":\"cd43559ca476f2a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/useAssetObjectUrl.js\":\"d7c6c16e31226aba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"83def0874339797b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksViewSection.js\":\"01c8c26cf88f05c9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/facet.js\":\"e0eae347df00040d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/index.js\":\"057eaef922d686c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/prop.js\":\"0a6523be5e6c7a44\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinkFilters.js\":\"be84d427e4e3a8d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"cb50460b1e1817bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BlockEntry.js\":\"78097af5b83d4c8b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/LinkedReferences.js\":\"8d4180c715bd13f5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ee81eaa6ec3e2423\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dailyNoteDefaults.js\":\"e1201b774e121008\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dataExtension.js\":\"83b5fbfd89fda103\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/edgeExclusions.js\":\"80e04d24d44fb130\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/filterProperty.js\":\"2f3bb8855ffe983d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/index.js\":\"7a9586b3f0c92a5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"fcc644769978bde9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/applies.js\":\"f6186ad579631c82\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/countQuery.js\":\"f58b4848990c1d21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4fbb1861691f99cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/index.js\":\"a7588680145c8d73\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"305ec975ade5f628\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/presentationInvalidation.js\":\"41da839f4c73cb6f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyEditorOverride.js\":\"3567fad97a4d32b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyFilter.js\":\"195e9736529a0e96\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/query.js\":\"b73b48a81d5fc925\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/resolveFilter.js\":\"010fc86a8be89f75\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sourceBatch.js\":\"1d409fd306068cfb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sources.js\":\"7a74f8ae5aa9eb31\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useBacklinks.js\":\"3d04dfeb489c04b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"565b31746cbac480\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayCelebration.js\":\"bbc11aa1f4fd2e21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayOverlay.js\":\"c6fc62aba74d5f1d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/gate.js\":\"ede2b197fdba8869\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/index.js\":\"a7e02d8a69e861af\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/wolfTheme.js\":\"ad09ec5167ee894a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/BlockDragLayer.js\":\"93d75e0e5010a35f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dragController.js\":\"9bc2f9730e2fda84\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dropTarget.js\":\"9cff302eb512b12f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/index.js\":\"f14335d7c717109b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/projection.js\":\"105fec391026b755\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/BlockMetaCard.js\":\"61ecd47cf43014ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/index.js\":\"9de04a2430e8a8e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/AddTagDialog.js\":\"1c7e0f13e63a2941\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4e228f8b87b33913\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/TagNameIssueHint.js\":\"f02ed32fd536f4a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/addTagAction.js\":\"00b528bf5287bf61\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/appendTag.js\":\"f0e5db07b6604b2d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/config.js\":\"0dd98a6999a8fb7c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/dataExtension.js\":\"f13c89664139a5ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/index.js\":\"dc2fa130b4454bff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/propertyEditorOverride.js\":\"e73bf7d9bcb44edc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbList.js\":\"3d87bdd5cc7bedb4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6e8206714bab1f04\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/Breadcrumbs.js\":\"55d4cd748622ae99\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9704caf9a2e7d858\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9fe0707d46c612b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/index.js\":\"9a690ec256307be9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cc9f9383737025e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/CharacterCountItem.js\":\"4586fb5068aeef35\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/ProfilePropertyEditor.js\":\"710b735c15dac62f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/actions.js\":\"b5ea0d390de9d68d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/blockType.js\":\"3ea935dda786646a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/charCount.js\":\"a45912ccc4b689a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/dataExtension.js\":\"cab399fe577e3783\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/index.js\":\"c72be2279ef1043f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/profiles.js\":\"bec607865336040a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/properties.js\":\"a23a2e8e59eab577\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/textCounts.js\":\"ba7ec48fd9d51c74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/colemak-keybindings/index.js\":\"d50637cbd55aef0b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/CommandPalette.js\":\"245089a0f93b8e82\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/HeaderItem.js\":\"231b2fecf43154b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/context.js\":\"145e35011a5098ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/index.js\":\"606845988028f54a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/selection.js\":\"d5d821ad1c6020aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/toggleStore.js\":\"05062d4e2f0b7122\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/useCommandPaletteActions.js\":\"112a490021b62b49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/ContributorBadges.js\":\"1e6c1717af6ff04d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/author.js\":\"2dddbd2017b9a26d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/codeMirrorExtensions.js\":\"fec606b55ef7a4bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/dataExtension.js\":\"0bb732005122c86c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/index.js\":\"4a88c892edc6aaca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/mentionAutocomplete.js\":\"5728435513c91d10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/processor.js\":\"1c79bf567a854700\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/profiles.js\":\"7830b3bcb2346865\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/queries.js\":\"dcb97a82c642baa3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/schema.js\":\"24495c725a091efd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b558755f58e4bd2c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7db3f20e2e407aa4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/index.js\":\"d0814be43d3e4900\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"de3cd1147590715c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"ad79f8274dd14a5b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/CalendarGrid.js\":\"838b3a4df2f39096\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DailyNotePicker.js\":\"61034dd180b2bba0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2cec9e0ae3fcd5e3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateNavDecorator.js\":\"cb08302f6d7bbeb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateScrubOverlay.js\":\"67b189729bc84229\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/HeaderItem.js\":\"77bfabe999e761ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/ReschedulePicker.js\":\"beaabe7641febe27\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/SpreadDatesDialog.js\":\"006595db0e8bea20\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/actions.js\":\"838006a3bf58f40d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/blockDateAdapter.js\":\"9df665e46a95d055\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/calendar.js\":\"aa5335bc9c33ce62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dailyNotes.js\":\"a62f1e6ad5b86465\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dataExtension.js\":\"22579cc5cd0d532a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubActions.js\":\"7285cf3d990089b0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGesture.js\":\"e6ca06a2fea08fad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGestureActions.js\":\"828d5e5988a993e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubRecognizer.js\":\"dac3a8b6f7f93bec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/deletionGuard.js\":\"bee4517acaa9f36e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dueQuery.js\":\"0b539d3eb8ed5790\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/index.js\":\"2b884a8468d540e8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/landing.js\":\"42e0cd1e83d25f3e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/localSchema.js\":\"2121029e45b22f8e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/referenceDateAdapter.js\":\"e1135d5076ff1558\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/rescheduleAction.js\":\"c16f8b69b48cdbfe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/schema.js\":\"bd70549c03290634\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadBlockDates.js\":\"274e3932c90b550a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadDatesAction.js\":\"2f4f77c52a3e8b0c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/today.js\":\"0e0aadadf13967b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"99ef17efcdb647ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3bd75c3cfc75f913\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/audit.js\":\"0e4659c9992fc518\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditAction.js\":\"a508a21de0300751\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditRanges.js\":\"8e53b6c2244c25c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/diagnosticsSource.js\":\"3e3ae4ad86ade531\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/divergenceScan.js\":\"0ebb947c1716e7cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/index.js\":\"1de2d35b8fc37ddc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/propertyChildrenChecks.js\":\"9f39231fd6a034d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/referencesMirror.js\":\"e0efeed9a15d2dfb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/rowJson.js\":\"bccfd29ad82da9f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/schedule.js\":\"7ab978741b0c12dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/store.js\":\"103026a37e38369d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/action.js\":\"25290f6745778f2e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/index.js\":\"20c0e13875a7117e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/plugin.js\":\"2d75aa3ac679adcf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f96a63527c9199dc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/actions.js\":\"e61fa02ee93b6382\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/changeMarker.js\":\"5902778739cb04e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/diagnostics.js\":\"21ab4cf5edfe9052\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/fileSystemAccess.js\":\"3ab07bfb3178e8fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/filenames.js\":\"2ee0b6863edb6330\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/index.js\":\"28f9b752b74f5a76\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/mirror.js\":\"124b28f3f92876a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runLock.js\":\"33e7ebf8008834ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runtimeHealth.js\":\"77e7878535867f77\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/schedule.js\":\"2194a297ede598d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/store.js\":\"ef9d0354a667542f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/index.js\":\"1c673c5ff8a0a354\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/themes.js\":\"d1a2b8bccc32e798\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/facet.js\":\"d95689c7a21ee00d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/useDiagnostics.js\":\"000211fa54e85fef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/dismissals.js\":\"db5cf9b25e622ff1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/index.js\":\"7e6d83136b201039\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/status.js\":\"0c8db780ab2c14b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/store.js\":\"35a5c68fdfd354a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d3cc86fbcc9c2781\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8611109d4acac440\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/actions.js\":\"4368dc1e1dca9717\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/config.js\":\"9fa6be798b65b512\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/dataExtension.js\":\"fa893478560bccd7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/effect.js\":\"7d9fbaad9437c0ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/index.js\":\"e27911509d419edd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9f4ad38a07581158\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/useToggleTree.js\":\"385118a4f3da3b7f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/ExtractTypeDialog.js\":\"a9c34bfffc2994cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"74eeb8ba7f5e97db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/PropertyShapePicker.js\":\"2bb624ff5b956017\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/action.js\":\"c33740a1d74337e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/index.js\":\"c736a641a15ece8b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/FindReplaceDialog.js\":\"88e9ca7ddfea1181\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/HeaderItem.js\":\"c773a83ea1be5fe3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/dataExtension.js\":\"1dbafe71720b3772\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/index.js\":\"f4c24d6428e9f63f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/search.js\":\"44e66296030c3db7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/toggleStore.js\":\"d2878d038342af79\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/LocationPropertyEditor.js\":\"983eb5aa7250d9d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/MapView.js\":\"dfb784b98966e1df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/blockTypes.js\":\"e29e96d47a27aa75\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/codeMirrorExtensions.js\":\"37a78334cf16a3b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/createOrFindPlace.js\":\"88ee51b0a8f4c0bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/currentLocation.js\":\"f6b2387ee5faa19e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/dataExtension.js\":\"ae99696db54e29c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/geoContentDecorator.js\":\"8da85c573d18dd2d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/googlePlacesClient.js\":\"62b95c220be8d690\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/index.js\":\"fe5c68fb9fcc0078\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/locationsPage.js\":\"b913983e35bc7a1c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/mapViewport.js\":\"6e10582c2fada37c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/pickCurrentLocation.js\":\"6a931c1133d7a20c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeAutocomplete.js\":\"e1380f9769e94c63\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeNameCollision.js\":\"f971b2451225676f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/properties.js\":\"300a2df277f01878\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/propertyEditorOverrides.js\":\"9720b7817c72b32d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/query.js\":\"187fbb3a7aba49e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/usePlaceSearch.js\":\"ff3611c92fd8871f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"62edea4c83c6675c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4d5a7bab958318cd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"46698dee38c27a1a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/config.js\":\"0c76277c72acbc3f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/dataExtension.js\":\"e488053280da6afd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/facet.js\":\"00e61f7dc3e5ad6e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/grouping.js\":\"b0bd26fc9e8311f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/index.js\":\"85c6cc001e7ea4e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"caf2b62ed6e5d6ee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/query.js\":\"4b66be1dae64bcfe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/resolveConfig.js\":\"8e9fbab2eace918a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1d5d258c0fdd9bb5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f6b38af92ddb9be1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlDocumentContent.js\":\"d289bd986872a071\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlFrame.js\":\"a4069d9fb2758011\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/actions.js\":\"f735f864940bab65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/blockType.js\":\"48200e5ec986c7c9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/confirmRunScripts.js\":\"48225c50ef8cb234\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/dataExtension.js\":\"6863a7f7987fc03b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameAnnotations.js\":\"67550143c2efed01\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameDocument.js\":\"d7bf40dce9f6d38a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameTheme.js\":\"9e3f8e5e6b5b97b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/index.js\":\"3b5b0604becec6c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/scriptConsent.js\":\"5ab1fbce5b1d9a47\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/sourceMap.js\":\"a979414a7eb83a03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/useDocumentScripts.js\":\"21c9f6278b3f6d28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/index.js\":\"60d3786931f6815e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/record.js\":\"04ac23084712b556\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/recordStore.js\":\"fd97931778d22f8a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/responsiveness.js\":\"5df35be91c397c4a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/schedule.js\":\"51ce03bdc64adb60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/sessionContext.js\":\"9fe0dab8fb83fee3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2d2118d076f48f1d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2338a17a01916621\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/actions.js\":\"06faa1dcd3af0489\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/config.js\":\"bf0128bb31e6e4cd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/dataExtension.js\":\"b2c305845e4cf2fd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/effect.js\":\"462b40b6876f38a1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/index.js\":\"7dae5e2ec250dc32\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/keyCapture.js\":\"e0ff90dc1d66c60b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/overrideStore.js\":\"eb4939fd6ce5f461\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"9d992bf30e376f18\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/HeaderItem.js\":\"8a9b970b5be49261\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/LeftSidebar.js\":\"54de01ce0e5a7abe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/actions.js\":\"c6e3b38c7b967dbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/facet.js\":\"bfa21a353166996c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/index.js\":\"d83b455cf3104803\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/shortcuts.js\":\"b3ff684a99f04987\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/toggleStore.js\":\"fe79d9f85d29cfe3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/MergePicker.js\":\"002d4f41210d525d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/index.js\":\"4f077e29a8862dbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/mergeAction.js\":\"d5504264766b74b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/strategy.js\":\"400487e2fd42291d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/Button.js\":\"635bd09973854a1d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"27b80d0a36d679e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/defaultItems.js\":\"279fa33ec96d5533\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/facet.js\":\"189f101f9808efef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/index.js\":\"ff145bfa0fe0818c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e618439672bf4ccd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/actions.js\":\"278610efa1927fae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0535736b645bd4c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e139a87a6ce53d00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/index.js\":\"41781d66450c92ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/MoveDestinationPicker.js\":\"724b675058acdbdd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8bce1074eac0f793\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/contextMenuItem.js\":\"30ac4c312c2e2185\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/index.js\":\"d22ce628eecf02ed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveAction.js\":\"316057b6236e957d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveBlocks.js\":\"dc765e2f8b281dff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/selectionAfterMove.js\":\"f0251a4e0e604df1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/TutorialBanner.js\":\"2b6d3c5aaa74db0e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/action.js\":\"4b1caffb4b1c0ca0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/bannerDismissal.js\":\"0ddd8297a26099f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/documents/cheatSheet.js\":\"5e295e1ec464c608\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/index.js\":\"667c1b5689fda26e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/keys.js\":\"588aeb7350d8c07f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/landing.js\":\"2863a11950f792b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/outline.js\":\"4002afe732473062\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/seed.js\":\"21808811ebef5180\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/PerfTrendDialog.js\":\"11ba7cade448ce89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/analyze.js\":\"aee14ce746b82d4b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/diagnosticsSource.js\":\"50f42be2f4cf27d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/index.js\":\"52ba84226619bae0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/load.js\":\"488d34110411a7a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/monitorRun.js\":\"fbe93a1aa1c44261\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/schedule.js\":\"2af925e480b4287d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/series.js\":\"73112f63dc9f2968\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/store.js\":\"ff6fb133c97b6408\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/trendAction.js\":\"e42846e7163549b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/verdict.js\":\"1b25c201eef240e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/clickToEditAction.js\":\"c60b0d556c73d814\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/index.js\":\"ca11f7bfbbccd15d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/interactions.js\":\"b3d72339c71d0bd1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5abd8c8aa991fbcd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGate.js\":\"ceb5cf2d14adc657\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGateDialog.js\":\"380f393915a996bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/action.js\":\"8c8ccbc948b1835b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/index.js\":\"b0dfdd710586160c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/localRunMessage.js\":\"7a03e1a45f3c22f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/plugin.js\":\"70caeb85778d2ab5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/progressReport.js\":\"c491d29a1ac8c33b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/sweepProgress.js\":\"ba5ce7c9996077e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/FieldRowRenderer.js\":\"b08d947d92b4ec9d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/ValueRowRenderer.js\":\"ee5c8d3c97823040\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/actions.js\":\"09e3f0d83c6197ce\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/autocomplete.js\":\"a139a65112d0632c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/fieldRow.js\":\"3446ed1cde97f283\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/index.js\":\"188ed9030f81d3bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/referenceWarning.js\":\"3ce667f8fe5a0b90\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueAutocomplete.js\":\"e33133afa3d3b730\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueSchema.js\":\"5e953f1f4d04f631\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/HeaderItem.js\":\"b3e50be29a8a025f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/QuickFind.js\":\"317084f0011bb99a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/index.js\":\"461b33b5b216338a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/recents.js\":\"6b274fe487f4e340\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/resultItems.js\":\"ea5da74ac7a84e87\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/selection.js\":\"4b92e7fa964369ba\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/toggleStore.js\":\"6bb3ee1aeebc477e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/HeaderItem.js\":\"99999ced75ed45ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2509005db28f1b14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/grouping.js\":\"bb171a9b0d7561c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/index.js\":\"7a68be204e15941f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/target.js\":\"091f66323407e8b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/codeMirrorExtensions.js\":\"98b35cfa98bd2a40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/contentPrefill.js\":\"8db1cb08519520f2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/dataExtension.js\":\"f847d78a2f1c4933\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/index.js\":\"14a8fcadd4ce0812\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7611bf80278d1cd6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/invalidation.js\":\"4992e7d7b5b800e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/localSchema.js\":\"a3d3de786daee03a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/index.js\":\"0c8ad911eb1ee0e2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"630a95bf6e059f3c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/index.js\":\"ed6a991adaafa9ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/referenceNode.js\":\"e85818ef8f4fd1c9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/remark-reference-occurrences.js\":\"06e3cf6bf870e450\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7b8308d272af7e72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/index.js\":\"b64422f787c9cbac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3989012920950e64\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"4aad6adb29540c05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/mergeRetargetProcessor.js\":\"a9f149cb4b297248\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/parseFence.js\":\"55407fb7647ef37e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceParser.js\":\"f14040f9e8b21a5d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceProjection.js\":\"5a7d88fd741bd9e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referencesProcessor.js\":\"acebbfef45461d85\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/renameProcessor.js\":\"f56689359cbe0aa7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/spanReplacement.js\":\"81154af701de465c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/htmlToOutline.js\":\"f99862256cb483fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/index.js\":\"d7ae42f8e9030222\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/normalizeClipboardDom.js\":\"38aa25e306e2e843\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/pasteDecision.js\":\"0296d6a8b26c43a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/action.js\":\"13a51ee54ca7b8ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/blockIds.js\":\"8ef88629b0b657d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/content.js\":\"0ef871a00c0e3d7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/effect.js\":\"cb0a9a3b50cf4c7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/ids.js\":\"aeaacae9b9161b36\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/import.js\":\"e20fb4b7c0fdf74f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/index.js\":\"3238634699505bbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plan.js\":\"54292237e97b8db6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plugin.js\":\"4d5cb82596d38abe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/promotion.js\":\"3875accf3c8f17a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/properties.js\":\"15954a544504ec4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/references.js\":\"aea7271333c1dbe5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/report.js\":\"b083b58b36e87ca6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/roamMemo.js\":\"e9e9bbf80d678d3f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/runtime.js\":\"6e05b6bf735e1d67\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/schemaReconciliation.js\":\"4a7bc146824323b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/srsMarkers.js\":\"180406961db82ff5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/todo.js\":\"22fb575bbae886ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/typeCandidates.js\":\"41ef26108aeafc5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/types.js\":\"ec3c661f3070f930\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/index.js\":\"058aea20ce27bc12\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/store.js\":\"b85dfee4228eed92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/HeaderItem.js\":\"f209a327c275e00d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5ab04d7ebc7e59df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/index.js\":\"5d85c3fd84064870\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/model.js\":\"7d45fc6bc6420650\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/toggleStore.js\":\"1910584fe40b3224\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/useKeyInspector.js\":\"eab310de92525118\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a20bdf19cf822abf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/ShellDecorator.js\":\"00f9b4d306c28bcb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/actions.js\":\"f7ba542138cc5324\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/exclusionsFacet.js\":\"772d5e22b046ebf5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/index.js\":\"9c5ad35b8c211c80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/shell.js\":\"e34717a757711070\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/surface.js\":\"25429f1810033ba8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/walker.js\":\"54228d0a5601352f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6aad22437bd876c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/dataExtension.js\":\"ba0cfd3b1fee68b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/index.js\":\"a35747b8749096cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/indicator.js\":\"5ff7e63157a2607d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/moveSrsState.js\":\"d636fedec2c8a9d4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"cc78221cfbf22d51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/scheduler.js\":\"35c36ee3efbfa397\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/schema.js\":\"d4f92dd97f2d5bda\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3be7dd0edff371e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsClipboard.js\":\"91e74d66860800ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"d0c1f40925dab421\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DailyNoteReviewHint.js\":\"77df73bd18f47d89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DeckPicker.js\":\"59d2f3f0adfe5411\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewControls.js\":\"fd6f01b4bee4ab43\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e86fa18dfb8f2095\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewSession.js\":\"f86af7b8684d9a54\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/actions.js\":\"3c544f200e310808\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/archive.js\":\"6811d2abde8dea83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dataExtension.js\":\"86e8251a14333110\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/deck.js\":\"505757b16a864f69\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dueQuery.js\":\"acd6dbe34defce59\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/gradeDecision.js\":\"f3dc5decfceb2fde\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/index.js\":\"2b1606658cfd37e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/keyHints.js\":\"c63240e5e1ff4071\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewCardLayout.js\":\"b5c12643f5d6ddcc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewProgress.js\":\"843aa739bf34dc3e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/schema.js\":\"b43dc22424007875\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/useDueCards.js\":\"217c12d39dcfddec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/index.js\":\"93abc9a885ea14b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/record.js\":\"a86e8344255445a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/index.js\":\"0b452f631d522f1b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/persistenceStatus.js\":\"02af32f1020aa571\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/requestAction.js\":\"07adbc974309c6ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/TypeChipsDecorator.js\":\"f0e74827471ac8dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/codeMirrorExtensions.js\":\"adb539f521430e45\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/index.js\":\"6873465ba78ecd52\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/typeAutocomplete.js\":\"81c3d2db8b069486\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8d2a2c968bbb522b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/actions.js\":\"75399d60b9ff4fca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/anchor.js\":\"43cd5901560b9cfa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/events.js\":\"250c0144786510ef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/gestureActions.js\":\"165345b7b606b011\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/index.js\":\"b97fd1d0baee5196\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d0a3407ec63735b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/collect.js\":\"d5c71287e394660b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/index.js\":\"7cf214c1b3b3f59c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/record.js\":\"f1e3055a513db620\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/RejectionDialog.js\":\"21834e57aca8b536\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/SystemStatusHeaderItem.js\":\"72aa82d11a77394a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/index.js\":\"82ea9d7f352e593d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/model.js\":\"4bef80d34eb2e3e8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/queueCounts.js\":\"f7f04cd6a2bd53c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rejectedHelpers.js\":\"7135470251371cc1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rematerializeAction.js\":\"b4ea677f6872fbbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/useHysteresis.js\":\"ca952f7d863a3d94\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/ColumnHeaders.js\":\"6f647584538eb6d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/QueryUi.js\":\"315aebf003bb4afb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/TableLayout.js\":\"45b0a9f7ca68ebab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/actions.js\":\"1eff4f52fa99e9bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/cellEdits.js\":\"bed48c8ce3c5cd66\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/columns.js\":\"e9f162899069d882\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/controller.js\":\"82ba987d8a254ca1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/convert.js\":\"59b93c5c72344cef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/dataExtension.js\":\"3cd869dc25900099\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/index.js\":\"85921df5f5e49feb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/keys.js\":\"58373151ead6e7e7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/model.js\":\"2051df0b5bd314a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/backfill.js\":\"812107a71fd8c01c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/format.js\":\"2b65840c68941238\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/parse.js\":\"a997e8686ae459c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/queryValue.js\":\"d7c6fb14d9cb7983\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/source.js\":\"a88532090da7f04d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/registry.js\":\"9a2099697f34c626\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowGutter.js\":\"97867c850a8830f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowVerbs.js\":\"d0c7d5942a5e183f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/schema.js\":\"c187385215e93f46\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/sort.js\":\"193d3c9b280060f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/effect.js\":\"129251434e3dbca1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/index.js\":\"9c4b25a3ae182127\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/theme.js\":\"e2d2901aca4b62ee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/actions.js\":\"7bf2dee8b22a82d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/dataExtension.js\":\"880c12bb827549c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/index.js\":\"63891beff28ebca9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/schema.js\":\"3e7b9e47b8d030df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7e793c326e044720\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/actions.js\":\"dbc9b62bcd96c371\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/defaultItems.js\":\"335c2d8d056df9f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/facet.js\":\"4ad9459631a38131\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/holdRecognizer.js\":\"40ab807a49ac3a73\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/index.js\":\"daa4e2db3d70ab4b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/UpdateIndicator.js\":\"de5ca22a61f3d247\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/index.js\":\"14b82f9b99286e5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/loadTimes.js\":\"9b915ef730164652\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoNotesRenderer.js\":\"ccc021bba873645f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoPlayerRenderer.js\":\"5c3a60f871eb8524\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoTimeStamp.js\":\"cac4e80535d65980\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/actions.js\":\"948dfd77112ddfad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/index.js\":\"78bfa0a2a5774e87\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/markdown.js\":\"69a0d38525c3cc8d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/notes.js\":\"e16b6b0d45d8e930\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/registry.js\":\"a75111691e49a866\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/remark-timestamps.js\":\"21f7362684143d2d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/view.js\":\"320d54f153008082\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/LinkHints.js\":\"ab9e29ce0a397d50\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/index.js\":\"b2ae32af84a5e3fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/model.js\":\"c60ae3316759358b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/settings.js\":\"71d47a338a8ae88c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/actions.js\":\"b0de9582e6e03d49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/index.js\":\"bd2c926ec480aa6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/interactions.js\":\"3c49e94538fe0fe5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/workspace-header/index.js\":\"2478536fb13ccd13\",\"/knowledge-medium/pr-preview/pr-1850/src/registerServiceWorker.js\":\"45420436ccd895f3\",\"/knowledge-medium/pr-preview/pr-1850/src/requestPersistentStorage.js\":\"9f55947b7235a4a4\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authRequestDeadline.js\":\"871a7c79b70c7816\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authStorage.js\":\"0e074d1b464d3fc4\",\"/knowledge-medium/pr-preview/pr-1850/src/services/powersync.js\":\"e7a167c01aa39c08\",\"/knowledge-medium/pr-preview/pr-1850/src/services/supabase.js\":\"4a52de598584aa1f\",\"/knowledge-medium/pr-preview/pr-1850/src/services/uploadErrorClassifier.js\":\"c85e415e834e1252\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/ActiveContexts.js\":\"add180ac54f4d933\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/HotkeyReconciler.js\":\"204033dd5ae72cd8\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/WipeLocalDataDialog.js\":\"1bc1fab11721ca25\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionDispatch.js\":\"555f89ea6c0cce2e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionRefItems.js\":\"9c92d1b3cfc478d6\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/applyKeybindingOverrides.js\":\"62f610032642422c\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockActions.js\":\"aa148e66964dd2fd\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockMergeGesture.js\":\"1310e5ce51ff9287\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/canonicalizeChord.js\":\"facd93605091fc1e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultContexts.js\":\"89f40a37d8fb295a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultShortcuts.js\":\"a705d7230b73e29e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/effectiveActions.js\":\"9aac99ddd4474a04\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureAction.js\":\"78e9212a567a67e5\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureBinding.js\":\"ca47ba9dde5135dd\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/holdRegistry.js\":\"5ee1dd72fe61aee7\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingConflicts.js\":\"e60568952941acd7\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingOverrides.js\":\"56414d7217675026\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/pointerAction.js\":\"6e7a6b92484c157a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/resolve.js\":\"28dd45b77fb587f7\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/runAction.js\":\"e5d62931db1f9d83\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/sequenceMatcher.js\":\"2a232b21bf6e0c2d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/types.js\":\"3ceb9ab1c98558b6\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionContext.js\":\"29f2961642c36d77\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionDiscovery.js\":\"086d8df28f66e621\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/utils.js\":\"a344c61643696815\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/bootStore.js\":\"d87d04431809e1c6\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/previewDatabases.js\":\"7ac0174313dda585\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/byteTransform.js\":\"c8c5a84d24181be7\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/attachmentCleaner.js\":\"d854efad1e9a3d3f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/attachmentParts.js\":\"58817467cf73e43c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleParts.js\":\"e9081a4a44b686c7\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleRecord.js\":\"ec833ea495824d84\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/manifest.js\":\"a0a6a3605304333b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/takeBundle.js\":\"23a4365d87bb4ad8\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/verifyBundle.js\":\"468abb79370ea29a\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/cleaningStage.js\":\"362c3544ea4a1fdf\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionKey.js\":\"d456d6544c6b030f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionServer.js\":\"0bd4a7da16103337\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flip.js\":\"6a85124f2b4df445\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flipAttempts.js\":\"cc698a6f49cdb757\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/pages.js\":\"0f28af234cdbad44\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/preflight.js\":\"d95565c155ea7fe5\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/reseal.js\":\"b9630c37345ab72d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runConversion.js\":\"eb16a273be059a99\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runLock.js\":\"d3607be6baa20a57\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealing.js\":\"e41ed9b563aa7b5c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealingStage.js\":\"5e546161ea18fc62\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/stage.js\":\"ab3afd29264fb1e4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/verifyReseal.js\":\"5c946d81794a597e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aad.js\":\"c2dca29faede40be\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aead.js\":\"1b5d28775dd4851d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base32.js\":\"6de735d2dd3ca91e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base64url.js\":\"1a7d607fcb0b350b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/binaryEnvelope.js\":\"acbd9f2294532bbb\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/byteAead.js\":\"d4cda932cf199ce6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/canary.js\":\"264c0f0456666b47\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentHash.js\":\"1635d9c324462b23\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentKey.js\":\"82299dd1c506229f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/derivedIdNamespace.js\":\"296888359768bd9c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/envelope.js\":\"d6909139a3a06ed9\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/hex.js\":\"c6bbc5de5524413d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/sha256Hex.js\":\"08e9cc73e6262604\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/workspaceKey.js\":\"f837454eb0786190\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/conversionState.js\":\"bd094e4145593709\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/createEncryptedWorkspace.js\":\"53972e59ed75f042\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/pastedKey.js\":\"199c73f3922d0cd1\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5240103c66e71f37\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9baf02ac906c3b26\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/keyStore.js\":\"cc63eb066c632ada\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/mintWorkspaceKey.js\":\"9e43a27d08d3882d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/modePin.js\":\"20433c9d31307354\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/openWorkspaceKeys.js\":\"48a67f52cad316d4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolveWorkspaceEntry.js\":\"3ca2be22df7f28a0\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolver.js\":\"c0e275aa7a0a87b6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/workspaceAccess.js\":\"a8bacede413f3ee9\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/transform.js\":\"af916a51f0cc6cdc\",\"/knowledge-medium/pr-preview/pr-1850/src/themeBootDefaults.js\":\"cf1bafa2d733512d\",\"/knowledge-medium/pr-preview/pr-1850/src/types.js\":\"d3a310fa8a4fdf51\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/ClientLocalSettings.js\":\"0ea39fd4657f5a63\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/abortableSleep.js\":\"6b2c90cb03a55da7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/array.js\":\"701bbbaf0eaf94f6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/backlinkAutocomplete.js\":\"e6e23a80f59011d6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockCrumbs.js\":\"1216de79c60ed41e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockrefAutocomplete.js\":\"baa6073d40faf32c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/cadencedIdleJob.js\":\"4392011b943fd399\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/callbackSet.js\":\"a3ad6dfab6563cd4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/clientId.js\":\"c65432b24d5cd538\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirror.js\":\"4e4353e10fcb3b3d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirrorCompletion.js\":\"653027ec7fa86753\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/copy.js\":\"ba565c0cf39d0c5d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dailyPage.js\":\"1754306744ac5b95\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensics.js\":\"b44f737592d38ca9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensicsHooks.js\":\"481ea49cef862149\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/deleteBlockThroughUi.js\":\"9fb9052abae37bd9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dialogs.js\":\"bbb7eb3fdf94d70e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dom.js\":\"ae324977cbd7bcda\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/downloadBlob.js\":\"b5fc05220a85851b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/exportSqliteDb.js\":\"fb10adb6c693c666\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fileSystemAccess.js\":\"ce0393b0d34d2750\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/flipSlide.js\":\"60f9c217172d263b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fnv1a.js\":\"2aef4555dadccb77\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/formatBytes.js\":\"fb0d9ca49ee08788\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fuzzyRank.js\":\"e68be46e857a01c9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idbKeyedStore.js\":\"670f7582315cdd65\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idleCallbackPolyfill.js\":\"dadaed8b446f99a7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardAwareScroll.js\":\"5ce6904f37bf2e62\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardViewport.js\":\"7f24c9dc45113fe3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/lastWorkspace.js\":\"596db165cab73f32\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutColumns.js\":\"6e73b19cce9502c2\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionDom.js\":\"cd99e755f7af31d5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionId.js\":\"2fb856a6870fa5b4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkClickGestures.js\":\"73a65a69ca76a4ee\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkTargetAutocomplete.js\":\"06051b98c43f7d4e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbCorruption.js\":\"b19f6b3432017358\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbRecovery.js\":\"52e6fcaf797e926e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/markdownParser.js\":\"44f451474a723233\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/memoize.js\":\"201093cd495ac1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameFieldCommit.js\":\"0d67522cf7c5f887\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameList.js\":\"19c59be1db786f86\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/navigation.js\":\"850cb7e5045dcc43\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/omnilinerNamespace.js\":\"7750262697562cd1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/opfsPageScan.js\":\"b6e2c7f84459ae1c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelClearance.js\":\"c6b6834fb9a15d70\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelHistory.js\":\"c575f250ca642403\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLanes.js\":\"d81723aceb862f8e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLayoutProjection.js\":\"df573a0907246f7f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelScrollAnchor.js\":\"6f3055422a3b3e25\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelUrlFlags.js\":\"0462f158a60dd741\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/platform.js\":\"a598a42708991636\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/pluralize.js\":\"d99908ab1ccb6163\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyCreation.js\":\"ed1ce56a7b9445cf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyNavigation.js\":\"ac677edd6c02d0e4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyValueContext.js\":\"a309e82ed16946d6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/react.js\":\"d8f39579cb636118\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeDate.js\":\"8b12e278833727c7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeTime.js\":\"74173e6c0be677e8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/renderScope.js\":\"b7db946c53ec3de9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/resolvedThenable.js\":\"eef2a0bafc97d5af\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/routing.js\":\"6896a84d8bcadaf0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/safeMode.js\":\"6ff38f6bdb51d755\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/scheduleIdle.js\":\"b68d76f62e25aef6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/screenWakeLock.js\":\"1a2d3b17ce3a090a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/selection.js\":\"edae208c36691670\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/softKeyboardGrab.js\":\"cacde71a52ce17b1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/startupTimeline.js\":\"21e4c9b415d22723\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/state.js\":\"6c9c3eb3f55b0ff4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/string.js\":\"5f34713159c5778d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/surfaceZoom.js\":\"140a3360f0dd3aa9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/time.js\":\"76374a7a3b45ab8c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toast.js\":\"7c3cb1177f07e498\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toggleStore.js\":\"0845f197f7d391a7\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/untilStopped.js\":\"c9dc450629c1f7ba\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/userActivity.js\":\"4a850795bd5c73bf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewTransition.js\":\"6933759e597c04ce\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewport.js\":\"3ec5a6059265dc57\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/webLock.js\":\"b38b2326cc97cdd9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceRecovery.js\":\"2766ccb32f42604a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceSnapshotStore.js\":\"79e199bbf890bc5a\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-compiler-runtime.js\":\"4cb6ab82f212c9f4\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-client.js\":\"cfbd195dfb275283\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server-edge.js\":\"8969d486c9e7aee5\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server.js\":\"4eab8cc8ba952bb0\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static-edge.js\":\"da94176a2af67171\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static.js\":\"b4752c6b0541483f\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-test-utils.js\":\"b92dc8027f55ad64\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom.js\":\"fd2b0070b0242a55\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-runtime.js\":\"87bfcb857fc48038\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react.js\":\"f9edd8116a286694\",\"/knowledge-medium/pr-preview/pr-1850/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
