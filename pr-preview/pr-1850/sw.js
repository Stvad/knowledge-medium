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
		buildId: "6cb54729b398-22d74758",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/\":\"7b9aca2121e1d139\",\"/knowledge-medium/pr-preview/pr-1850/index.html\":\"7b9aca2121e1d139\",\"/knowledge-medium/pr-preview/pr-1850/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/pr-preview/pr-1850/assets/FacadeVFS-C3YaxVH5.js\":\"c0df8189857b81d6\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSCoopSyncVFS-B4MHOhJZ.js\":\"41a5843bf3786b10\",\"/knowledge-medium/pr-preview/pr-1850/assets/OPFSWriteAheadVFS-Bnpvgrdn.js\":\"aaafb46dbe1fabd2\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-C0f-xGTU.js\":\"723f0a1c012357db\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/assets/wa-sqlite-async-Djlkx6W6.js\":\"9574ac053ba011f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/worker-CDPWNcV9.js\":\"300a17428e4a5990\",\"/knowledge-medium/pr-preview/pr-1850/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1850/chunks/app-CpoYG35o.js\":\"c86e2ac316e3df78\",\"/knowledge-medium/pr-preview/pr-1850/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1850/index.js\":\"412b42651fb3f4a2\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1850/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1850/assets/AccessHandlePoolVFS-CjsnhIX7.js\":\"049857fa6c2c8ce7\",\"/knowledge-medium/pr-preview/pr-1850/assets/IDBBatchAtomicVFS-Bd8YX9nf.js\":\"b4044f5239497377\",\"/knowledge-medium/pr-preview/pr-1850/assets/MemoryVFS-B8T71J8j.js\":\"0dcdbc69f987e47b\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-DgeMTr2L.js\":\"c54753da65c0c565\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-DKE1_okS.js\":\"a8a5c5e8e98a84cb\",\"/knowledge-medium/pr-preview/pr-1850/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1850/chunks/AccessHandlePoolVFS-Ct42kwOX.js\":\"da107558755eabff\",\"/knowledge-medium/pr-preview/pr-1850/chunks/FacadeVFS-BU9XENN8.js\":\"e8b42afa535bea02\",\"/knowledge-medium/pr-preview/pr-1850/chunks/IDBBatchAtomicVFS-Co0loLn9.js\":\"4b042b194aa61090\",\"/knowledge-medium/pr-preview/pr-1850/chunks/MemoryVFS-D0dqwS-u.js\":\"98fdec93b52d6a42\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSCoopSyncVFS-D-IFA0Ap.js\":\"7582998df1ec714a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/OPFSWriteAheadVFS-3nEj3k-o.js\":\"bbb9a5c32941d8d1\",\"/knowledge-medium/pr-preview/pr-1850/chunks/Preview-DJumCoOu.js\":\"ee10a3a6089977af\",\"/knowledge-medium/pr-preview/pr-1850/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/card-B2DUFZZb.js\":\"bef67cba560043e8\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1850/chunks/dist-C38ERD0l.js\":\"9211b433d1437300\",\"/knowledge-medium/pr-preview/pr-1850/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-3XaDUhkh.js\":\"bda9bc9ec18249b0\",\"/knowledge-medium/pr-preview/pr-1850/chunks/mc-wa-sqlite-async-CbRt5IV5.js\":\"924f2a0a8ccb7fb2\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-7lti0OVC.js\":\"e6d9d0b6aae8b52a\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-AGgyJWx7.js\":\"5464bdadee44f94b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BDwA3V2u.js\":\"444c230cfe73fff3\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-BmrPlMqu.js\":\"14c0ee161d91b38b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-CYTi8znM.js\":\"39c560bb07a8cc5e\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-DC0c_Rx8.js\":\"cf6748eb4ef9686b\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-DVEZMihu.js\":\"15502bd9f23f0765\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-DxoNOlXe.js\":\"29b7512e8f2f7629\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server-legacy.browser.production-BROIvtoM.js\":\"18cc558badb7f4ed\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.browser.production-CAdno9CJ.js\":\"873be7995e6d8c18\",\"/knowledge-medium/pr-preview/pr-1850/chunks/react-dom-server.edge.production-Xe6-pxZ5.js\":\"5b67587a5b446565\",\"/knowledge-medium/pr-preview/pr-1850/chunks/server.browser-DhxpWpV7.js\":\"a6b5d6458c0da3f9\",\"/knowledge-medium/pr-preview/pr-1850/chunks/textarea-npSohuT-.js\":\"7e86389a5548734c\",\"/knowledge-medium/pr-preview/pr-1850/chunks/ui-D2oydGBU.js\":\"cd00dfe5bf5a7216\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-CKYkn7lL.js\":\"61af9430e5900fcb\",\"/knowledge-medium/pr-preview/pr-1850/chunks/wa-sqlite-async-CTvqRNLY.js\":\"4918cebd32c5c0df\",\"/knowledge-medium/pr-preview/pr-1850/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1850/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/pr-preview/pr-1850/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1850/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1850/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1850/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1850/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1850/src/App.js\":\"1dcf65836733a6be\",\"/knowledge-medium/pr-preview/pr-1850/src/appUpdate.js\":\"5a7e46a4ef470de1\",\"/knowledge-medium/pr-preview/pr-1850/src/appVersion.js\":\"c70a79776d2e0924\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/initialLayout.js\":\"7d9198a2385580ac\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/openWorkspaceData.js\":\"eae2e78d62fb1db6\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/resolveWorkspace.js\":\"f39196177937ae8d\",\"/knowledge-medium/pr-preview/pr-1850/src/bootstrap/workspaceBootstrap.js\":\"0b0b022591b39f42\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockComponent.js\":\"0da2549c3c77f6aa\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockCrumbs.js\":\"f07723a41509b77e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockEditor.js\":\"303fe26c7001eb3f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockLoadingPlaceholder.js\":\"b2f6586529a28f72\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockProperties.js\":\"49afd84e096a2f37\",\"/knowledge-medium/pr-preview/pr-1850/src/components/BlockSearchPicker.js\":\"549d3bc088458eda\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ConfirmBulkDeleteDialog.js\":\"c4f0cec875a525c9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DividerHandle.js\":\"f96e2ff34bb05ab5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/DraftEditor.js\":\"33ef515334e3c8fb\",\"/knowledge-medium/pr-preview/pr-1850/src/components/GutterPill.js\":\"1964134f842922d1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Header.js\":\"e653a5b9d72ef48e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/LazyBlockComponent.js\":\"a4ed9ea16f16c69b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/Login.js\":\"409ef2be1bd17ad2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ZoomableSurface.js\":\"02eddf06c9f116e5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/editModeKeepalive.js\":\"7a6d656c0da1c99c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b1528635aba35329\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b74fa054de8c2f58\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefPropertyEditor.js\":\"56bf3912a2dff945\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/RefTargetTypePicker.js\":\"3f40c8077379d308\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/SelectPropertyEditor.js\":\"0677c2462ff5a068\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/TypesPropertyEditor.js\":\"10476f3fbc62e0dc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/defaults.js\":\"c1b8431098782db5\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/kernelValuePresets.js\":\"ff2a538d4d87064e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/selectablePresets.js\":\"adb2aefa45c14135\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyEditors/typesPropertyUi.js\":\"f1b3a8f066023711\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/AddPropertyForm.js\":\"6070e59f1ce11350\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyPicker.js\":\"7dadf8258aefab9b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/PropertyRow.js\":\"3309770b2f7b9564\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/Rows.js\":\"20fd8c412199e6ff\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/actions.js\":\"3b61247b69e523d9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/declarationOnly.js\":\"ae2ea1aab7ae2af4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/layout.js\":\"d82d16a2c69bccc0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/model.js\":\"072a60433a195495\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapeUi.js\":\"c59bf9b034e4ea83\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/shapes.js\":\"dd8c02f4459a9880\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/usePropertyEditingActivation.js\":\"69d2d27125d29b98\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanel/visibility.js\":\"be2ec3ad3e52203a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/propertyPanelSections.js\":\"d869cedf80aef0d0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockEmbed.js\":\"7c2e96393c25dc10\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockLink.js\":\"31591c43ec0b6071\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/BlockRef.js\":\"93a2f193f527a957\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/ReferenceLink.js\":\"76feee97905b6959\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuard.js\":\"46daa1c483a00bb1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/cycleGuardContext.js\":\"ba42e4a716b58a54\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/linkInteraction.js\":\"264004301583850b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/referenceLayout.js\":\"bb82d391aa583126\",\"/knowledge-medium/pr-preview/pr-1850/src/components/references/useBlockRefAncestors.js\":\"7df98e071cedfec9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockGutter.js\":\"55718df9f29993d0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockInfoDialog.js\":\"f076b8a6ea18a997\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BlockTypeBlockRenderer.js\":\"7fbcdb16fa36774b\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/BulletHoverCard.js\":\"a013348622321881\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorContentRenderer.js\":\"48bf3b7899dee5c9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d15bd95897631e7a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ColumnResizeHandles.js\":\"2516c490b732402f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"6ffd9f9426870a1d\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/DefaultBlockRenderer.js\":\"4c620f1620e24b8a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/LayoutRenderer.js\":\"e06a2f6e21952b41\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MarkdownContentRenderer.js\":\"3a242bcdf4c68cd6\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/MissingDataRenderer.js\":\"138277a3463e96a0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PanelRenderer.js\":\"4e6d9c39ceb53494\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/PropertySchemaBlockRenderer.js\":\"43be637b7de1dd26\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/TopLevelRenderer.js\":\"1884d5ed0f1062d4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockGutterMode.js\":\"9c291b4e3c97e251\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/blockTitleText.js\":\"5458470bbb6e3af8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/fieldCreationKeydown.js\":\"c58ff554f9b526ec\",\"/knowledge-medium/pr-preview/pr-1850/src/components/renderer/layoutRootContext.js\":\"afa55cdccb6f4bcb\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/TypeChip.js\":\"ba4d99fe5eb53d78\",\"/knowledge-medium/pr-preview/pr-1850/src/components/typeChip/chipStyle.js\":\"e21fc0edac325197\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/anchored-floating.js\":\"91549e7b5582c585\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/button.js\":\"2b1a8bbd875239a9\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/card.js\":\"e93e87f34b9c6d79\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/checkbox.js\":\"c864c67a39fb4a4a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/collapsible.js\":\"6e76325edffd8ad4\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/command.js\":\"d5372cbf43a3481a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/context-menu.js\":\"6ee690a2e1a28461\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dialog.js\":\"280e2eb9434a2611\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/dropdown-menu.js\":\"cb96579e6fa2d807\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/floating-listbox.js\":\"b4a31ce0f66ba71e\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/index.js\":\"80d275e41c095f2c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/input.js\":\"95eedf15e8987fa2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/kbd.js\":\"564feaed0a2422c3\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/label.js\":\"9270d960137c7865\",\"/knowledge-medium/pr-preview/pr-1850/src/components/ui/textarea.js\":\"2cff2dbd4db045cf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/useEditModeYieldKeepalive.js\":\"b017117ff6888c5c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/BootFallback.js\":\"fdffa1c1eed11bf1\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/FocusedRowLazyMount.js\":\"6c64bc6ca6c99504\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LazyViewportMount.js\":\"1d88773f9ff28dbf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/LocalDbCorruptionFallback.js\":\"a767c40ccd75f4ba\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/error.js\":\"db7f102b626f5238\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/lazyMountRegistry.js\":\"b1ef5e2f8704d8c8\",\"/knowledge-medium/pr-preview/pr-1850/src/components/util/suspense.js\":\"78b79cc0bfb6c4cc\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/CreateWorkspaceDialog.js\":\"bb8c2b9f49e51632\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/PendingInvitations.js\":\"943ce284ffed49ab\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/SyncProgress.js\":\"19f7b2e95d1b622f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/UnlockProgress.js\":\"a33100f18a86d0ca\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceKeyGate.js\":\"ff5cd470d93d9236\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSettingsDialog.js\":\"eb4fa9ce93f0c96c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSwitcher.js\":\"3c76349a7c960b93\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/WorkspaceSyncGate.js\":\"cf6a52c87516f5b7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlow.js\":\"a6d512948c393da7\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/ConversionFlowHost.js\":\"b696aeb49c3fc046\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/EncryptionSection.js\":\"b2c9274300244502\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/attachmentPrompts.js\":\"79df16b37978814c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/bundleFolderPrompts.js\":\"5e9f7d5950a1700f\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowDeps.js\":\"268acd9dba66a2f2\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/conversionFlowStore.js\":\"aa59e2be8257cf13\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/flowUi.js\":\"46da906cc6b6b5b0\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/conversion/useConversionRun.js\":\"0762c97e2ca2b57a\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/keyUi.js\":\"923ce6aad4a70397\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnKeyLoss.js\":\"8592798ad999aacf\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/useCloseOnServerE2ee.js\":\"40f80e30ba132b3c\",\"/knowledge-medium/pr-preview/pr-1850/src/components/workspace/workspaceUnlocked.js\":\"849b50eb8fa132d3\",\"/knowledge-medium/pr-preview/pr-1850/src/context/backgroundSubtree.js\":\"f953b833d9df0700\",\"/knowledge-medium/pr-preview/pr-1850/src/context/block.js\":\"c0167198b14cde35\",\"/knowledge-medium/pr-preview/pr-1850/src/context/layoutWsContext.js\":\"3f4a2990876c0fcb\",\"/knowledge-medium/pr-preview/pr-1850/src/context/propertyDisplay.js\":\"422870072c9e67c2\",\"/knowledge-medium/pr-preview/pr-1850/src/context/repo.js\":\"dbdd97b11b912a9a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasClaim.js\":\"dfd6f1f4b597ed65\",\"/knowledge-medium/pr-preview/pr-1850/src/data/aliasSeatNamespace.js\":\"678a4714783f3641\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockData.js\":\"ae8a089439444d7a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/blockType.js\":\"67e9678052c87e5e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/changeScope.js\":\"56dbcb3cba48f205\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/codecs.js\":\"c62fd9d9033f7304\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/derivedData.js\":\"678608672d6d42f2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/errors.js\":\"401a00c8b139f3b9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/events.js\":\"f26be8c6eda6f96e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/handle.js\":\"10d770046b0e3e01\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/index.js\":\"4da7bb12cba0a4a3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/mutator.js\":\"1b901856c2aa5420\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/processor.js\":\"e5a302d4d033454a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/propertySchema.js\":\"1636035e97bb0e4d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/query.js\":\"03b2b8bbe11c9430\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/sameTxProcessor.js\":\"2e749cdc83c8912b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/schema.js\":\"10d770046b0e3e01\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/tx.js\":\"10d770046b0e3e01\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/typedBlockQuery.js\":\"abfb3a3e056e445a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/user.js\":\"833b4422a2553d40\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresetCore.js\":\"e4eb34cc6c9ae678\",\"/knowledge-medium/pr-preview/pr-1850/src/data/api/valuePresets.js\":\"0c49ba1f14d70d85\",\"/knowledge-medium/pr-preview/pr-1850/src/data/attachmentCleanerIOVerb.js\":\"1a9145509709f462\",\"/knowledge-medium/pr-preview/pr-1850/src/data/block.js\":\"4fb0566e78d86410\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockCache.js\":\"473a7ff1a0901315\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockId.js\":\"7acb458d7631d8c1\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockLiveness.js\":\"11f0d7d5b66c133b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockMerge.js\":\"ccac7db14bbe4398\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockSchema.js\":\"6a8709bbf89de8b0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypeLookup.js\":\"f2b2bc204a2ee0d3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/blockTypes.js\":\"acb130b8bd86ac25\",\"/knowledge-medium/pr-preview/pr-1850/src/data/clientContext.js\":\"cd76c419bce029af\",\"/knowledge-medium/pr-preview/pr-1850/src/data/dbFileSiblings.js\":\"7cb380d8e49c281d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/definitionSeeds.js\":\"209611986eecab16\",\"/knowledge-medium/pr-preview/pr-1850/src/data/derivedIds.js\":\"41fbaebe6468c787\",\"/knowledge-medium/pr-preview/pr-1850/src/data/drawnSubtree.js\":\"06ef8e0c138caf68\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facetBridge.js\":\"ae2f50f925f71d79\",\"/knowledge-medium/pr-preview/pr-1850/src/data/facets.js\":\"570093a51832215b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/globalState.js\":\"e98240dc3ed63330\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/aliasClaimRederiveProcessor.js\":\"a8ff7fe2a3938a82\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/ancestorBatch.js\":\"3a8251a238747e50\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/blockTypeTypeifyProcessor.js\":\"e183d5dd70d2e7a5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/clientSchema.js\":\"c662a3493aa5a7ef\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/commitPipeline.js\":\"e0aae7b4bbaecfbf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/devAssertions.js\":\"eeae87f36005d576\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/firstSync.js\":\"739bb48a3f7e6eeb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/freshInitialLoad.js\":\"86472fc8d22dc95d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/graphBackfillClaim.js\":\"6aef5daa043430c3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/handleStore.js\":\"372eca383aaebd0a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/idleMarkerJobs.js\":\"8e434c12b6821c5e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initialDownload.js\":\"87b0e543e64851fb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/initializeClientDatabase.js\":\"c9ea6cc0f5232620\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/jsonCanonical.js\":\"aa5323772f7eed94\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelInvalidation.js\":\"982ef0d7e2d7e23d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelProcessors.js\":\"a2d71f2bdfdb4c52\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/kernelQueries.js\":\"d1d7f68530d1e089\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/mergeTypeMembershipProcessor.js\":\"fc22dcaa0b9f064e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/normalizeReferencesProcessor.js\":\"2ff50fe1046143ce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/poolInstrumentation.js\":\"7e182b29d10263ce\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/processorRunner.js\":\"f7aea8f70c0ecc6e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyCellBackfill.js\":\"fd12ed4777f2004c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildMint.js\":\"c48a0297c8265e0b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyChildrenProcessor.js\":\"125aa41298614d80\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionChangeProcessor.js\":\"411b21afb0cc36c9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyDefinitionSynthesis.js\":\"fee3ce2eb061f196\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyKeyScan.js\":\"26798a5a12f3688e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertySchemaResolution.js\":\"711814d7a0ae774c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/propertyValueEdits.js\":\"6dc03a9560d2ab83\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/raiseProtocol.js\":\"d9bdcafcfbd5a13f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/readBatch.js\":\"d5cb5b73166dd6d6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/refProjection.js\":\"98cb66a369a43cf8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetLookups.js\":\"0b2ecd7dfc3e921d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/referenceTargetProcessor.js\":\"41e3f69fc0242025\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/replayMerge.js\":\"56966c249c66cecb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/sqlBinds.js\":\"070e4c9debe5477f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c7326374de029618\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/arrivalProcessors.js\":\"5e3317a1a80c8522\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/invalidate.js\":\"b476b12cb0d83f8c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/materialize.js\":\"0700e505f1866414\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/observer.js\":\"a59a96dc91bb4ea5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/syncObserver/reconcile.js\":\"4de771bda7ad1308\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/timingMetrics.js\":\"e88604ee65a31a17\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/treeQueries.js\":\"2e08dde85517044d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txEngine.js\":\"99d8e2a2a902dd76\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/txSnapshots.js\":\"826f8fbe0de98e0c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/typedBlockQuery.js\":\"278e6074b97272bc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/internals/undoManager.js\":\"53419760b545cf28\",\"/knowledge-medium/pr-preview/pr-1850/src/data/invalidation.js\":\"071dc5ea1692e06a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelDataExtension.js\":\"6a76e973d66cb10c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelPage.js\":\"67525cd1a124a1b0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/kernelValuePresetCores.js\":\"f48432a39d776216\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbCorruptionSignal.js\":\"7f5a85209b046016\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbStorage.js\":\"5ed9f64c0f764fb7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localDbVfs.js\":\"66b2c83c5da007cf\",\"/knowledge-medium/pr-preview/pr-1850/src/data/localSchema.js\":\"c4adf2ac8c02ffc8\",\"/knowledge-medium/pr-preview/pr-1850/src/data/maintenance.js\":\"f2896611cdeaa268\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mergeProperties.js\":\"d0295dcb10c00bd3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/metricsConsoleHook.js\":\"0cddb6cecd15c125\",\"/knowledge-medium/pr-preview/pr-1850/src/data/migrationsPage.js\":\"99ff7f0205f96de5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/mutators.js\":\"56a410ba756eeeab\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKey.js\":\"db3975a152f9f6b9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/orderKeyPlacement.js\":\"aa437aa3f181fb2f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/outlineSurface.js\":\"b15b6942f3ebd9cc\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingEditorContent.js\":\"03408609527bbfad\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pendingUploadsSql.js\":\"a595cd6b64157efb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/pluginStateExtensions.js\":\"ae0a46723ca6b42a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/powerSyncLogger.js\":\"05a515f8ae33db0e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/projectorRuntime.js\":\"63990cfa54aadeb4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/properties.js\":\"8794c4ae8adc3887\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertiesPage.js\":\"385573eb532915ca\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyChildren.js\":\"93cd7fdc59316a0a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionFanout.js\":\"9c3ce5915e594484\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionMetadata.js\":\"f82b4c571325c1a9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDefinitionRegistry.js\":\"be56c7dc75ce37e2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyDisplayMode.js\":\"0bc3da63934639e5\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertyRowCreation.js\":\"34db8e4581909fcb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySchemaCreation.js\":\"eba2f73bd5ed592e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/propertySeeds.js\":\"1d02d974350ef82f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/recentsPage.js\":\"b0e22f2d031ffaf4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/referenceBlock.js\":\"a71a64a3bdcfcc45\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rejectedUploads.js\":\"7b8f66030d1f783c\",\"/knowledge-medium/pr-preview/pr-1850/src/data/releasePowerSyncConnection.js\":\"0479c5023735e73a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repo.js\":\"cae812248f0b0fd2\",\"/knowledge-medium/pr-preview/pr-1850/src/data/repoProvider.js\":\"cff8c07f3577ce50\",\"/knowledge-medium/pr-preview/pr-1850/src/data/rowProperty.js\":\"93f3bfd0e42e85ed\",\"/knowledge-medium/pr-preview/pr-1850/src/data/searchFilter.js\":\"7f0aaa06f83dad01\",\"/knowledge-medium/pr-preview/pr-1850/src/data/seedIdentityLedger.js\":\"ec7d2631939893f6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/stateBlocks.js\":\"72697c145ad97188\",\"/knowledge-medium/pr-preview/pr-1850/src/data/structuralEditPolicy.js\":\"0a55293dcb8e355b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/subtreeDelete.js\":\"8df76432268322c6\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncStreamLock.js\":\"43f48b3dd4f52cb0\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableSqlRecognizer.js\":\"bcf8e395f4d43047\",\"/knowledge-medium/pr-preview/pr-1850/src/data/syncedTableWriteGuard.js\":\"3ed3107abb7eabcb\",\"/knowledge-medium/pr-preview/pr-1850/src/data/targets.js\":\"660e7c488627013d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeColors.js\":\"7621a0de9e8a043e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionMetadata.js\":\"9be395c7c5ddcf4a\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeDefinitionRegistry.js\":\"6d17a20bb4aea672\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeExtraction.js\":\"91d9be44f38d1e8f\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeInitialValues.js\":\"b9a3a2a071bbaa60\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typePropertyGroups.js\":\"64621f4b1a4005c7\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeSeeds.js\":\"2f6b26a0b07cec0d\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typeTagger.js\":\"26ba662dd8a175da\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typedRecords.js\":\"ff79bc8514a3ea8b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/typesPage.js\":\"179c184053a580e9\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userPrefs.js\":\"dc52e00dda9766ea\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userSchemasService.js\":\"e33543e98a7e0102\",\"/knowledge-medium/pr-preview/pr-1850/src/data/userTypesService.js\":\"a75be4deae62427e\",\"/knowledge-medium/pr-preview/pr-1850/src/data/valuePresetRegistry.js\":\"ec22b081a86f3a4b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/visibleChildren.js\":\"14b0538aa51c8523\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceConversion.js\":\"c49dfb2d6314f6c4\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceFirstSync.js\":\"7e97b0b07ffaf84b\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceIdNamespace.js\":\"d60f408f51a561c3\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaceSchema.js\":\"f20de0831e96f693\",\"/knowledge-medium/pr-preview/pr-1850/src/data/workspaces.js\":\"be099762351c3b51\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadLog.js\":\"156e4d5ace2916bd\",\"/knowledge-medium/pr-preview/pr-1850/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/BlockPasteShellDecorator.js\":\"a7cef86e6356b379\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/atTrigger.js\":\"6ba032184ac4fcab\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/autocomplete.js\":\"dbe0a8befa0b895a\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/codeMirrorExtensions.js\":\"d04cd79cd920b264\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/contentFlush.js\":\"61b6f4664ef3b82f\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/defaultInteractions.js\":\"2ec563152a620e6d\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/editSettleSignal.js\":\"e3c14cb20224d127\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/insertImage.js\":\"29d5865755bcdb97\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceCompletionRange.js\":\"0845e8e26d957f7e\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/referenceTargetTypes.js\":\"f2885774d9cd8632\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/syntaxContext.js\":\"70336241d8c4a676\",\"/knowledge-medium/pr-preview/pr-1850/src/editor/triggerMatch.js\":\"1f72362a308315da\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/AppRuntimeProvider.js\":\"762e24e23475d046\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/BlockFocusShellDecorator.js\":\"930bfb975b7915d9\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/ExtensionRenderBoundary.js\":\"239a666b72b9db14\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/PanelContentRecovery.js\":\"b253bb026c11d7c8\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/apiCatalog.js\":\"7a9596800f351eba\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/approveExtensionHere.js\":\"e9c99a1446313629\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/armedCutAppMount.js\":\"80657004c31a3415\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/batchableKeyedStore.js\":\"20d2d9484139ebb6\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockInteraction.js\":\"bd4ed871b476e834\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/blockSelectionAction.js\":\"1db2d1ce4308901b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compileExtensionModule.js\":\"8c7896de7875f089\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/compiledModuleCache.js\":\"3a925c71addd8a00\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/continuousGestures.js\":\"726ce480661eaece\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/core.js\":\"47f39cda3da85846\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/defaultRenderers.js\":\"28e81166cac4cbf1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/definitionFanoutAppMount.js\":\"c55c645576225bd8\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dialogAppMount.js\":\"f9eb68d9fb8bd8d2\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensionSeeds.js\":\"8e87bb720f41389b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/dynamicExtensions.js\":\"d1ce68a9012ec7de\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/exampleExtensions.js\":\"094ad6af86837d0a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionApprovalStatus.js\":\"5316a0b3071f34c2\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrorToast.js\":\"07ad2a00b59671b8\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLoadErrors.js\":\"7f3c9e733846e754\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionLookup.js\":\"ea7e28acc9379c98\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionToggles.js\":\"38b453e1bb9c4d0c\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/extensionUtilitiesCss.js\":\"a0585d64dec75024\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/kernelPageDeletionGuard.js\":\"e51b148cd2261517\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/liveRuntime.js\":\"eccee1b3010fff44\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/openExtensionsSettings.js\":\"77b7f6a8d9487070\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/overridesCache.js\":\"bccc5913d9e6674a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/pluginIds.js\":\"5a94c2fb644fd4a1\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/processorRejectionToast.js\":\"7dbc2422e10f2868\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeActions.js\":\"9738862f4b2e66fc\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/runtimeContext.js\":\"2e5621dad690cf5a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticAppExtensions.js\":\"894f757aa4843737\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/staticDataExtensions.js\":\"44b9b3d688ad3a2a\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/toastAppMount.js\":\"a01ab485102a381b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useOverrides.js\":\"f6ce9e10eee2ff3b\",\"/knowledge-medium/pr-preview/pr-1850/src/extensions/useShortcutSurfaceActivations.js\":\"ffda16a134747b07\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/discoverToggleTree.js\":\"64e2cbd027ba67d2\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/facet.js\":\"be090649cc333207\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/resolveAppRuntime.js\":\"0cd7ea8162d718f0\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/runtimeEvents.js\":\"afcdd335d839b54d\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/togglable.js\":\"b0c64bee66c97d12\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/variantFacet.js\":\"6619896d13cb068d\",\"/knowledge-medium/pr-preview/pr-1850/src/facets/verbFacet.js\":\"ea51cb03a88ae003\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/block.js\":\"df287ca5bb67d0dd\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/focusedChild.js\":\"5b709f8edd603de6\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/propertySchemas.js\":\"284b2ecca642bc3c\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/typeRegistry.js\":\"33f6063a944f736e\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAncestorCrumbs.js\":\"d254c43c82e592da\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useAutocompleteListbox.js\":\"f8e8580548a905b2\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedSearch.js\":\"de3caad210096711\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useDebouncedValue.js\":\"7721c8e2f473c56b\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsFocalRender.js\":\"04e9c9265f02bdf7\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useIsReadOnly.js\":\"8a6fbe2965069342\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMaterializeBacklog.js\":\"e65fb73353a8da65\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useMinuteClock.js\":\"bd51db25920087c4\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePanelLayoutProjection.js\":\"cba910d57225d806\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/usePendingInvitations.js\":\"f92d08dd69507396\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRendererRegistry.js\":\"8d851837518f1665\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useRetainedFieldRows.js\":\"fa0bcebdb31b572d\",\"/knowledge-medium/pr-preview/pr-1850/src/hooks/useWorkspaces.js\":\"c5698d96d76165e7\",\"/knowledge-medium/pr-preview/pr-1850/src/lib/utils.js\":\"64aea7b94d050e35\",\"/knowledge-medium/pr-preview/pr-1850/src/main.js\":\"fb324d224743cf1f\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/MarkdownImage.js\":\"4e61f6c393d7eb45\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/blockSeparators.js\":\"9ffe5b4477f077ed\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/context.js\":\"a21c44c6ade2354c\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/defaultMarkdownExtension.js\":\"e017163a3be35ac7\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/extensions.js\":\"aac4e33a0d420530\",\"/knowledge-medium/pr-preview/pr-1850/src/markdown/renderMarkdownHtml.js\":\"1af082274ccab00a\",\"/knowledge-medium/pr-preview/pr-1850/src/minimal-editor.js\":\"02dd67bf6e0e6098\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/armedCut.js\":\"ec034c22260cf01e\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/captureMediaVerb.js\":\"f3d5814b7a194e62\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/clipboard.js\":\"4f4081241c0eb12a\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/decision.js\":\"b6a799fe0f97d05f\",\"/knowledge-medium/pr-preview/pr-1850/src/paste/operations.js\":\"a4ea51bdb2efec40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/AccountHeaderItem.js\":\"e002efa04092deae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/account-header/index.js\":\"7ac6b9c7534f3d57\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9009ed7bf8196439\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askAgent.js\":\"0cb2ccee3ab0afed\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/askedStore.js\":\"932c149694cf5eb1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a8a488e5d1fb3c28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/chipState.js\":\"a20935be3003d85f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b3835e0ab54aa0b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/index.js\":\"8051067218b06f7b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c760dc666fae09f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-dispatch-companion/schema.js\":\"84e11d123ab2dad4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ba46025783349e09\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/BridgePairingDialog.js\":\"f297291bc98b5e64\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/addMedia.js\":\"7ab7f662eebee1be\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/backlinks.js\":\"272168a04594bea0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/block.js\":\"b9768c36a60c9d99\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/context.js\":\"4133351cd2481c9d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a8bb226c85203114\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/index.js\":\"f0fac140e2612ed3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/outline.js\":\"3d2f082958a4c01a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/properties.js\":\"80025d0f1e3c31c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/refs.js\":\"e9241f23e1cc53ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f7e3fd520152d703\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/search.js\":\"5891b1b9294a3a84\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/shared.js\":\"94ec6b06bd01160c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"140aa193d2e0fe2d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentViews/text.js\":\"6a787f842ad1bdfd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/agentWrites.js\":\"82b3c75d0b56543b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/authoringCatalog.js\":\"c0ccc971a8fe6e8b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/blockRefTargets.js\":\"d5be1b17077b45fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridge.js\":\"8cfc09fd37659691\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/bridgeLoop.js\":\"97dc61f3a5e5c748\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/changeHistory.js\":\"b4a2b79dac89bd10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commands.js\":\"49eef292bcfdcf7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/commentsCommands.js\":\"2d82a92979a53896\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataExtension.js\":\"0876c2ded1871fb8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/dataModelGuide.js\":\"f853fb2b4e70f65b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/describeRuntime.js\":\"59cbfae6af08a202\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/extensionLint.js\":\"5c37337a458fcc92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/grainAudit.js\":\"bfc0dad8d1a6b024\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/healthCommand.js\":\"a5e258b36f932c12\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/index.js\":\"97a2522572c75ace\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/presetIdentity.js\":\"f99262af2c85b310\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"39b594b425b34d26\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/readMedia.js\":\"e06bc6fc21166d40\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/schema.js\":\"7e0e8598479ff8e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/serialization.js\":\"9b830268c0888b17\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/targets.js\":\"f86edad74d70f80a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/tokens.js\":\"017b643a892db4e3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/watchEvents.js\":\"8809ee41c4300fb0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/workspaceGuard.js\":\"5df5093c200be298\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/agent-runtime/writeCommands.js\":\"6978c8e188f9aeb6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/AliasCollisionToast.js\":\"98b2476f8c692751\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/DuplicateNameBanner.js\":\"37dc33771957bb05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/collisionMerge.js\":\"d946afb0bb95265a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/dataExtension.js\":\"3fb3fb23e456910d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/index.js\":\"b886c9c6230d5af9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/mergeCollisionAction.js\":\"396af244ada6d697\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/pageStyling.js\":\"d63cae796fb877e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/rejectionToast.js\":\"b90a5b52641b1a47\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/alias/syncProcessor.js\":\"6723d8b8c4bc021c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/actions.js\":\"ef9ae822c2db2855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/addComment.js\":\"7797de057b2d4aae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchor.js\":\"b55a1eb704e2f86f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/anchorState.js\":\"08516836a57ae076\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/commentLinks.js\":\"3f51dc4e7f3c4d00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/confirmThreadDeletion.js\":\"b8291b4d6fa06ef2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/container.js\":\"b9cf425479b081b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/dataExtension.js\":\"c11c92ad85745d26\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/deleteComment.js\":\"dc98df2a16e01c51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/highlights.js\":\"168bc9bf576de0f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/index.js\":\"12ae63231d063643\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/linkedCommentsPill.js\":\"953c396734bf2230\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/margin.js\":\"6b703b1ef70b8ad5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/marginSchema.js\":\"e0a0f9d13c20fc89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/newComment.js\":\"e50b8a33a6deb20a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ownThreadPicker.js\":\"6a29323eb0e5e919\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/placement.js\":\"8cf0323b12c39bc9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/queries.js\":\"bbc09225105d3dfb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotePosition.js\":\"70703f439a0b42ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedIn.js\":\"eb78436ba2aa4065\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/quotedRange.js\":\"fb00f783ae26fb9e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/rangeRefs.js\":\"8d42e3f46d7b7e79\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readHighlights.js\":\"a41a3a0584c40ce8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelection.js\":\"9ff66a17a7f7782d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/readSelectionUi.js\":\"5ce8051643501ce6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/reanchor.js\":\"6d4fa27a207617ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/schema.js\":\"59363cad9a06e8ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scope.js\":\"7254987e3202f051\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/scopeThreads.js\":\"ec5ac2adb55533d8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/splitRetarget.js\":\"9554e2f04eb51b97\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestionCard.js\":\"1235c2210bdcfe88\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/suggestions.js\":\"709d42fdfe02dcf3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaries.js\":\"9926be9ac3ec7a6d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/summaryBatch.js\":\"6f29d133ec87de57\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/surface.js\":\"73b4537eca65fabb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threadNavigation.js\":\"3b30acd08ecfbe92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/threads.js\":\"17157778f5d93586\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/ui.js\":\"b6a1e1b4faefd401\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/annotations/uiStore.js\":\"863df74695a9bff0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/appIntents.js\":\"0118a3bbe441976d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-intents/index.js\":\"e99dd01b7b4c77b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/index.js\":\"70b7fab4b67c9682\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/app-update-prompt/status.js\":\"94944cf584e095eb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"153ad14dd3df841e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaBlockRenderer.js\":\"d6c617463cf29729\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ef7ce9dbeaec3746\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/MediaUploadReconciler.js\":\"cafb516a6a8814de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetDownLane.js\":\"de7073ee693c4f28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetResolver.js\":\"d0dbf653ebcbce88\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/assetUpload.js\":\"e51a1aa012deb6fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/attachmentCleanerIO.js\":\"baa3fd09230fc794\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/supabaseAuditIO.js\":\"768fcc195f024082\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/blobStore.js\":\"f1d95bc7ef25606d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/byteStore.js\":\"6ef2c674dd3d157f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanerIO.js\":\"ad9ce0a2ad5494b4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/cleanupAttachments.js\":\"9ba90f98d983c0f5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/dataExtension.js\":\"33483521d340a652\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/downLane.js\":\"f1e026b84c7a52f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/index.js\":\"2c17b9aeb13d93b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/insertImageContribution.js\":\"3751529480d0a35b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneArming.js\":\"500196b3c6bce42b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/laneLock.js\":\"fd8aaca95747e8c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaBlock.js\":\"d61af7715260cd21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaCapture.js\":\"1b4b278036327728\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewers.js\":\"fecc974396309d4b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/mediaViewersFacet.js\":\"1bdc50151e430bae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/pasteCapture.js\":\"89fb32ed29de1423\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/resolver.js\":\"6502159fc4aacd0c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/retryUploadsAction.js\":\"7e98a02c588de70a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/storagePaths.js\":\"4c9c1df9e5b6e932\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadDrain.js\":\"e1f21ca301003681\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadLaneStatus.js\":\"a16b1e0411498827\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadReconcile.js\":\"21ee424bb1e71c02\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadRecovery.js\":\"9aea6d566913ad63\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/uploadStore.js\":\"896927284846669c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/attachments/useAssetObjectUrl.js\":\"3587620f9cac5617\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a5d6eda61d25c09a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b07f23577af0454e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/facet.js\":\"c6b28023d9958d29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/index.js\":\"c5c9a1dc125a43bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks-view/prop.js\":\"ef42c5e767a5c3c3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinkFilters.js\":\"98b0e2610749d7ad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"99bf16471d2fae1d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/BlockEntry.js\":\"9de3b7ceb425b903\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/LinkedReferences.js\":\"6399a3193f173b21\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a673811c2f98b93e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dailyNoteDefaults.js\":\"09124e3d2f04520c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/dataExtension.js\":\"d161da96c8ef3590\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/edgeExclusions.js\":\"a9ac95525ad02ac1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/filterProperty.js\":\"487f8c08cd53b169\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/index.js\":\"d6fc4214a3dcc769\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"803c9dbfd397079c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/applies.js\":\"9fdd34910f8015aa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/countQuery.js\":\"8229e162a531665a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5486ddbc6537689a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/index.js\":\"30d6ab9a4284b287\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"236e88b69f0bec5a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/presentationInvalidation.js\":\"3f44da25c6a724fe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyEditorOverride.js\":\"010d85ca37b25b2c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/propertyFilter.js\":\"ba9c77a93606622a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/query.js\":\"4f63d088a4456751\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/resolveFilter.js\":\"67317cd374773888\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sourceBatch.js\":\"eb4a734ce135ee3d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/sources.js\":\"cfdc0b9a56a8ec67\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useBacklinks.js\":\"fa1802da092d8921\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"814878d32ad98376\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayCelebration.js\":\"40fb3651492f334f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/BirthdayOverlay.js\":\"60ce4782daeb69b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/gate.js\":\"63dbba2064c13d57\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/index.js\":\"98454c268e96fcab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/birthday/wolfTheme.js\":\"ce06f716695a2622\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/BlockDragLayer.js\":\"1430a70a18e4fbfb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dragController.js\":\"12e90a0602934693\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/dropTarget.js\":\"c020b86593db6796\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/index.js\":\"02116fb1cd678844\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-drag/projection.js\":\"8e4ba8ff3098d6b6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/BlockMetaCard.js\":\"6ce734d73d894d0c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-info/index.js\":\"ba9e8f1a94566d28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/AddTagDialog.js\":\"4678b17edfb0110c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0ffcfd703a1fb98f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/TagNameIssueHint.js\":\"5812929a8e015e91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/addTagAction.js\":\"b7c30280dac77b71\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/appendTag.js\":\"875507cdb3dd57f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/config.js\":\"ab502d01d23b9b65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/dataExtension.js\":\"dc2c2959752ad1a0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/index.js\":\"0e0082a830816bf0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/block-tagging/propertyEditorOverride.js\":\"76b1a8e70e48c2a8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8da139a6dee03d5e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c8e1e88b7e86aeb7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6f52db1dc1368a60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7595abd79516d867\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b82963d5b42638a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/index.js\":\"593a601a54e87f05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bb07ee9317051b99\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/CharacterCountItem.js\":\"d67869d2c33e4b72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/ProfilePropertyEditor.js\":\"085e427978e96ee4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/actions.js\":\"d0c4d8493d69d3f0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/blockType.js\":\"417dc9c1c1244e0b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/charCount.js\":\"740d02906f94438d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/dataExtension.js\":\"cf27a382c0df96a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/index.js\":\"0ab1a5572fd6ef6e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/profiles.js\":\"09719dbe60fcca24\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/properties.js\":\"3a69c4a9739f516a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/character-counter/textCounts.js\":\"3304daafcbdfcc05\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/colemak-keybindings/index.js\":\"935ef912d81834ee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/CommandPalette.js\":\"eeed258db80229f1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/HeaderItem.js\":\"5098b63a05135bd5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/context.js\":\"e67d5b0cc6e2ccef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/index.js\":\"eb0f7bdc7a372bad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/selection.js\":\"05a5c94ecf4eed6e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/toggleStore.js\":\"f690d8e2a13d508b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/command-palette/useCommandPaletteActions.js\":\"acc8d58aac0c5d0b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/ContributorBadges.js\":\"e8118387a77f5a2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/author.js\":\"4cbf5b4e0bd2ddfa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/codeMirrorExtensions.js\":\"877dc00677168979\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/dataExtension.js\":\"b25aab7c696f0b53\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/index.js\":\"669dbbd960cc2a37\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/mentionAutocomplete.js\":\"f4909b02215d8ad1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/processor.js\":\"78f0d4107d23cfef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/profiles.js\":\"81a1ee7d9f362b09\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/queries.js\":\"f0b6e8d778aa5449\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/contributors/schema.js\":\"d8720758c09278c5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"6441d62c24266301\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/followOrigin.js\":\"360f8ae5f37ed800\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/index.js\":\"58c5e4942fdbaa7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"fcf360d49bf1699a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"44ae4cdcdcbee434\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/CalendarGrid.js\":\"a17eba5802fa174c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DailyNotePicker.js\":\"8282a895f98a8f62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ded9fa2ae4a367a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateNavDecorator.js\":\"5329359e727a8f4f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/DateScrubOverlay.js\":\"cc3be519fd26ed65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/HeaderItem.js\":\"9cacda42ec8500cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/ReschedulePicker.js\":\"82b730a5b883b4fa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0cfb767566f244cc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/actions.js\":\"fbe256c0045ba0ac\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/blockDateAdapter.js\":\"ca77be09be98315e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/calendar.js\":\"2fc4024419d39245\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dailyNotes.js\":\"5cc9d83b3ac8ca74\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dataExtension.js\":\"16086f5aa2ae5bb9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubActions.js\":\"65a3cf871099788a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGesture.js\":\"e0532b76516a059b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d1f3e58099194add\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dateScrubRecognizer.js\":\"111c8e220480c35c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/deletionGuard.js\":\"8fa4c03eb7811dd1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/dueQuery.js\":\"8d21c1dc118e7867\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/index.js\":\"d3d66cce223551f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/landing.js\":\"a6fe0e18b409c455\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/localSchema.js\":\"f1ee7a5db0987b51\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/referenceDateAdapter.js\":\"5267b3bb2491eaad\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/rescheduleAction.js\":\"63cc48c7e94954e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/schema.js\":\"56c7dfb5bb3eccb8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadBlockDates.js\":\"80b2a7ff5ecc772c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/spreadDatesAction.js\":\"d668d1d5d64bfb52\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/today.js\":\"b6ba542879b6c0f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5334660499260dc0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"061b55220addd5ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/audit.js\":\"0bb2f2a946c694a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditAction.js\":\"ce27b4b6964e4871\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/auditRanges.js\":\"30aad8ffb6b5760a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/diagnosticsSource.js\":\"b0e7113c4861913f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/divergenceScan.js\":\"c8c78ed592d29e65\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/index.js\":\"e79b137ec588f4df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c8729eba167d6e13\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/referencesMirror.js\":\"9339a953d10b13c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/rowJson.js\":\"ba2be6fd891d2b29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/schedule.js\":\"f21f4b0d9b02b2ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/data-integrity/store.js\":\"a4945173b51efc33\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/action.js\":\"ccc525048371b971\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/index.js\":\"f963c9128be4415d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-maintenance/plugin.js\":\"6230883899a438a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"571bfaf024089849\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/actions.js\":\"a3a2c78fc5eb1938\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/changeMarker.js\":\"6d4035c1f0188e7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/diagnostics.js\":\"5cdefca3f46bc31f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/fileSystemAccess.js\":\"ab454c11c0fbaa53\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/filenames.js\":\"131897e3a7c8a76c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/index.js\":\"6a1b5643b015df00\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/mirror.js\":\"8c4b61347e1c3930\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runLock.js\":\"3429d52075a1310e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/runtimeHealth.js\":\"93e35e9f78902db2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/schedule.js\":\"6444ad741cca3eab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/db-mirror/store.js\":\"efaa9f6cde838e10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/index.js\":\"5a4729d7208b9228\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/default-themes/themes.js\":\"b38fa5b604a69c25\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/facet.js\":\"b83fe719753758cd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/diagnostics/useDiagnostics.js\":\"8dcb39d3d52675db\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/dismissals.js\":\"d61b08ea2389c4a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/index.js\":\"67663e3a5a6e44df\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/status.js\":\"4d2e9d4885edfce9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extension-prompts/store.js\":\"51e051b669de8858\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b16754ab4f07f14b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d33bff9de7a81eb8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/actions.js\":\"625224172141a0c6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/config.js\":\"098de96df5572375\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/dataExtension.js\":\"7e4de20b59494486\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/effect.js\":\"c5bd01cfd5393ea7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/index.js\":\"a38bbec38d293267\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/propertyEditorOverride.js\":\"c27e0a55d7a5ff88\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extensions-settings/useToggleTree.js\":\"79e06856568234b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/ExtractTypeDialog.js\":\"02a06f5de4b645c2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6ebee8f8a48d6c89\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/PropertyShapePicker.js\":\"390f83c60d11204a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/action.js\":\"e209e50982ae395d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/extract-type/index.js\":\"ad7ab1a5460e82ab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/FindReplaceDialog.js\":\"5d79d5dcfb9f7eb6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/HeaderItem.js\":\"a943e01590cbc3b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/dataExtension.js\":\"24ca5a201dcffa84\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/index.js\":\"a37f44926b847851\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/search.js\":\"b74f3d046883a907\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/toggleStore.js\":\"56b58035f05960b7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/LocationPropertyEditor.js\":\"fd6a5d40a87cf0e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/MapView.js\":\"325d55706c79263c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/blockTypes.js\":\"0f36cc99a8fa88de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/codeMirrorExtensions.js\":\"2c86359e9ad4905b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/createOrFindPlace.js\":\"66f4d78bae1c296a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/currentLocation.js\":\"042f42e3fc2c55b3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/dataExtension.js\":\"b9250b04568a5310\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/geoContentDecorator.js\":\"1f45a9fa51082a18\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/googlePlacesClient.js\":\"61f743732a5ff06e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/index.js\":\"910fd7f8b76a3e73\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/locationsPage.js\":\"7b394a90d0a9f646\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/mapViewport.js\":\"ac51ceac79da9775\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/pickCurrentLocation.js\":\"ff9ef78135a1e1dd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeAutocomplete.js\":\"68d38422dc9f85f9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/placeNameCollision.js\":\"68fe67e08fcc1caa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/properties.js\":\"ee789b619e7a5197\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/propertyEditorOverrides.js\":\"be90c5c1a0d5800d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/query.js\":\"cb41b191b714ae98\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/geo/usePlaceSearch.js\":\"493590db98df83dc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b3637414a9381139\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"98f5651540998d30\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ac5ca085612e26bd\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/config.js\":\"6c989dd1a11485d2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/dataExtension.js\":\"51eff5539a95edb6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/facet.js\":\"36eef6571a1f369a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/grouping.js\":\"9692405d74e21e23\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/index.js\":\"9df380c520ee327a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a30085d5746758c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/query.js\":\"090d90cb91de7127\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/resolveConfig.js\":\"614dd31399128a08\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a1682cc6e40c6bab\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6db29663758567b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlDocumentContent.js\":\"8b5eecd8b248378e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/HtmlFrame.js\":\"d9d922a415462954\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/actions.js\":\"5bb657cc6dd354c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/blockType.js\":\"ec7caf7b2538fdfb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/confirmRunScripts.js\":\"2a8f0aaf63aca2d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/dataExtension.js\":\"57d7939b507183f4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameAnnotations.js\":\"90aa7c716c4e3a60\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameDocument.js\":\"3a7274b7b3bed48a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/frameTheme.js\":\"bdac93c84a7d4518\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/index.js\":\"f6b9e409bec515c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/scriptConsent.js\":\"57b13edc6eb8684e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/sourceMap.js\":\"f934f3ddadb2b502\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/html-document/useDocumentScripts.js\":\"655ddaf225f9c125\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/index.js\":\"9f2a9345bb360f7d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/record.js\":\"21d8dc085d386f5c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/recordStore.js\":\"276111347d76390e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/responsiveness.js\":\"2aec7fa1855f27f0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/schedule.js\":\"a768e4bd7afc41e6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/interaction-metrics/sessionContext.js\":\"1eec86eaaca7177e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5f4f6bb2e7610edf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"15ecbff35a033fa8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/actions.js\":\"10feb32d9182db70\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/config.js\":\"49bbce3c8fea773a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/dataExtension.js\":\"7459e0cecc2be997\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/effect.js\":\"54447c2fd0852582\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/index.js\":\"d2a977b025f975f6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/keyCapture.js\":\"5f0f2a3365b0846b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/overrideStore.js\":\"b188da7aa36c463c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"1d0d4b046a8a40c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/HeaderItem.js\":\"0bb264d681493ca6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/LeftSidebar.js\":\"c4768d99d9c5034c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/actions.js\":\"671394d9b33de281\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/facet.js\":\"239cb248195bfb98\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/index.js\":\"c482ec338cfcf418\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/shortcuts.js\":\"944c485476380f92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/left-sidebar/toggleStore.js\":\"8d1e3136c4a71fdc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/MergePicker.js\":\"9efcc6eb4fd15432\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/index.js\":\"640ca3fb56308926\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/mergeAction.js\":\"864ce6b9d1545e5c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/merge-blocks/strategy.js\":\"8a5a69fc51a4c51f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/Button.js\":\"07c2fe9ceb06f6e3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"197fa060a7d2b4c4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ba64034a080dea62\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/facet.js\":\"2201a27ad1e39c6f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-bottom-nav/index.js\":\"fe752e0bb9f70130\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4fe347743c874eb8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/actions.js\":\"dbb0df5078b55d28\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2b396327ce741da3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d2e6997c80362df2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/mobile-keyboard-toolbar/index.js\":\"83d60f7bb0a711b9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a96d86f2942f68e4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ae314a65380b32f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/contextMenuItem.js\":\"ed98839b904a3f88\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/index.js\":\"fe7c764d75e00b0c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveAction.js\":\"64c24138e1fb8606\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/moveBlocks.js\":\"284faedf249036b5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/move-blocks/selectionAfterMove.js\":\"c25b6c5c4435fed7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/TutorialBanner.js\":\"c2c5e6461192bdf1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/action.js\":\"0b02057555582cfb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/bannerDismissal.js\":\"d656a5dc4d69299d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/documents/cheatSheet.js\":\"432ac21f5f8fbfe0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/index.js\":\"c3ed4d8fb1ae3ce2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/keys.js\":\"93ec8051e9bf6287\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/landing.js\":\"938302fca3f66b8c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/outline.js\":\"9f042d42dd1f5c83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/onboarding/seed.js\":\"dbff7b7e412adcdf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/PerfTrendDialog.js\":\"08d26a1f52ad91bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/analyze.js\":\"74effea7a8c40c29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/diagnosticsSource.js\":\"f0285f1ddacde3f8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/index.js\":\"cb3721ac17750742\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/load.js\":\"e7c9f8db0273d021\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/monitorRun.js\":\"f1821b13f1bf2989\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/schedule.js\":\"3e1dfa80a298de83\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/series.js\":\"e9d78fc52029c65c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/store.js\":\"d67b3b825930af22\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/trendAction.js\":\"c4a22ae334ca2dbe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/perf-monitor/verdict.js\":\"85ba326b536b5cdf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/clickToEditAction.js\":\"06af2c3f911e437e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/index.js\":\"92e2586deff5287d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/plain-outliner/interactions.js\":\"a88877194354c526\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"629179635f88a873\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGate.js\":\"541e4cee6d5e9aa0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/MigrationGateDialog.js\":\"a756dfe757b5edda\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/action.js\":\"f09e2c7a2c4147b1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/index.js\":\"fb1e7083309c13f3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/localRunMessage.js\":\"df4726ea56bce118\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/plugin.js\":\"45c21a2003e977fc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/progressReport.js\":\"1821bbf3e7e6b703\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/properties-migration/sweepProgress.js\":\"cec0cc47c65cb8de\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/FieldRowRenderer.js\":\"40cff9350c10d592\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/ValueRowRenderer.js\":\"0ac8fdd1dab280a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/actions.js\":\"fe661b17d1169f24\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/autocomplete.js\":\"4571f618b533c1ec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/fieldRow.js\":\"168720412f29fe72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/index.js\":\"283d96adbc876c22\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/referenceWarning.js\":\"dc3e8946abc09aa1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueAutocomplete.js\":\"31cd48698d1b6bdc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/property-rows/valueSchema.js\":\"f3dfc43b4bf31771\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/HeaderItem.js\":\"aeeaec755b7f35ea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/QuickFind.js\":\"c14566bd6e6f3489\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/index.js\":\"d1a8e4d295269a2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/recents.js\":\"9061f5f2f97341c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/resultItems.js\":\"117f64a95f0de825\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/selection.js\":\"1f14fdcd6f028f2f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/quick-find/toggleStore.js\":\"02728fe8d2b359b2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/HeaderItem.js\":\"6954079078419f03\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/RecentsPageBlockRenderer.js\":\"09743d45ed7affe4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/grouping.js\":\"a04a29eaa35d5a84\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/index.js\":\"fd6bb81b86d9277f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/recents/target.js\":\"773a72f42b9875ee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/codeMirrorExtensions.js\":\"5081afa2aa76cb4d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/contentPrefill.js\":\"2180dbe3d2ee5ad7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/dataExtension.js\":\"4b100ebfcf72df24\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/index.js\":\"e3b7856e88516d31\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8a044c19f6a288c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/invalidation.js\":\"462c4efe5f4be03f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/localSchema.js\":\"61c5ae837a7e0dec\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/index.js\":\"baf9ce4d77bb0c92\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"21021e93b7e5b391\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/index.js\":\"39c3b9de4b07dd16\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/referenceNode.js\":\"9f16353c40a1d38c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/remark-reference-occurrences.js\":\"989b0ab6361382ee\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ac0ef3f211db8f72\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/index.js\":\"b9cf17770c64e873\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"59c21fbbe9f6c0a6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1bf6ddb14ed8a52a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/mergeRetargetProcessor.js\":\"a45667559edb9f64\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/parseFence.js\":\"8a4e6d3885c86aaa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceParser.js\":\"a2d8d63a526cc4cf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referenceProjection.js\":\"6e85a9f4130ad798\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/referencesProcessor.js\":\"94e65d727726019d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/renameProcessor.js\":\"83abffce560f302f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/references/spanReplacement.js\":\"b6d45d0086ef9321\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/htmlToOutline.js\":\"415b9f3f7abcf214\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/index.js\":\"c97d44b60668cbe7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/normalizeClipboardDom.js\":\"bb25be11e886a48e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/rich-paste/pasteDecision.js\":\"e129dc2e2fe7524a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/action.js\":\"e5ff7978fbb6aacc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/blockIds.js\":\"5e61371a4e576074\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/content.js\":\"7e178cd043b6d876\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/effect.js\":\"c3fac21bb0a74205\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/ids.js\":\"caccb7c4724ce514\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/import.js\":\"02b696122f5c7748\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/index.js\":\"be808c7a3d4dd42b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plan.js\":\"6de2e554f3e071ae\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/plugin.js\":\"c14d8a66318f56d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/promotion.js\":\"a2830a711573dee3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/properties.js\":\"c417fc447e477dff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/references.js\":\"9acce276a63010bb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/report.js\":\"eb74856242a778a3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/roamMemo.js\":\"6bb142b6c4e4f427\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/runtime.js\":\"44d86ff2c779f366\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/schemaReconciliation.js\":\"5acf41e1330b6842\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/srsMarkers.js\":\"b3986bb4a15f0dc2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/todo.js\":\"c7d5a388cab29ac3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/typeCandidates.js\":\"b1234c3b8c0930c5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/roam-import/types.js\":\"65ec912d15557285\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/index.js\":\"7eb6d40860efb7a7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/search-health/store.js\":\"c6fe2d4a77894513\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/HeaderItem.js\":\"13f77e881c09b30b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2e5f12f43424271f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/index.js\":\"7072db095c8c40cb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/model.js\":\"2dc333a0802b5717\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/toggleStore.js\":\"2ecf62b9a8e61473\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/shortcut-help/useKeyInspector.js\":\"22edfa98b284a295\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e15e1e45cb873099\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/ShellDecorator.js\":\"8461794e7f870ffa\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/actions.js\":\"6ab88ee4503e180a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/exclusionsFacet.js\":\"7631458e1c9ced78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/index.js\":\"b4d0c6fa4a8c53ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/shell.js\":\"692c2b97e6b72615\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/surface.js\":\"5390bf5b7154fe23\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/spatial-navigation/walker.js\":\"784cc104d94e902a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a8e3a445eb38abf7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/dataExtension.js\":\"242e819a5df26ce9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/index.js\":\"b319620c35dcdf7e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/indicator.js\":\"e98688ccd8cf5f35\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/moveSrsState.js\":\"38b95671c18a15fe\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"464b41d5ec995bb8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/scheduler.js\":\"f0c7722d291d4cb7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/schema.js\":\"72650dc5ff6f0094\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"fea56fd669e648a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/srsClipboard.js\":\"692258eab8d0d389\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"50b4dd614a2055ea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7c34272ef1eaade5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/DeckPicker.js\":\"4bd06c60ee3804e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewControls.js\":\"2a28e3dc4995f442\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d83863d47cc39297\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/ReviewSession.js\":\"49964047260a4d80\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/actions.js\":\"0e9728bdd6b5a2a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/archive.js\":\"9c92e8ef5b8102c0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dataExtension.js\":\"da231758e0770191\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/deck.js\":\"beb66371fbc360d6\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/dueQuery.js\":\"d10423d4a5bc9766\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/gradeDecision.js\":\"77d6508667081368\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/index.js\":\"7f7ff5f5c4de6cda\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/keyHints.js\":\"9f08252ca9f84635\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewCardLayout.js\":\"1c97b48d88b3dff7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/reviewProgress.js\":\"0490a4b7937a6fd8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/schema.js\":\"81ec1fd0054b35bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/srs-review/useDueCards.js\":\"1e0bb654658231e5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/index.js\":\"a5a785a1db817680\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/startup-metrics/record.js\":\"dd5ae0e2ac38750d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/index.js\":\"127decaaa68d48b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/persistenceStatus.js\":\"9d227013e366b420\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/storage-persistence/requestAction.js\":\"ec7f499dd60bc31c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/TypeChipsDecorator.js\":\"b79f073d1951e8c7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/codeMirrorExtensions.js\":\"394946975685825b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/index.js\":\"54ab9083d365b84c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/supertags/typeAutocomplete.js\":\"93fc0f0c49e6ea91\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"64f125bb851fd2bf\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/actions.js\":\"a738825d6b03b9ea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/anchor.js\":\"7560caaa48b71157\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/events.js\":\"d161aaa99ad1ce35\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/gestureActions.js\":\"41faebd5a8dc63c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/index.js\":\"3bc862ee184c6e0e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c908a1a06b796c29\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/collect.js\":\"8e5aaafa9d4fc71e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/index.js\":\"2eb3931f3ceb9164\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/sync-metrics/record.js\":\"94ea214b4a7d3b49\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/RejectionDialog.js\":\"3aff5f8affd69b4c\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0530e89af44a552f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/index.js\":\"120462458b5d3714\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/model.js\":\"4d1955f3fbbe1513\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/queueCounts.js\":\"d19989e378250716\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rejectedHelpers.js\":\"ef97f912d7834788\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/rematerializeAction.js\":\"a0941a5ddcebf9e9\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/system-status/useHysteresis.js\":\"269c841b2b136882\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/ColumnHeaders.js\":\"8f8d86c7ae0e4e47\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/QueryUi.js\":\"cd840711445a14d0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/TableLayout.js\":\"a087ac82610af9fb\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/actions.js\":\"db129a2d1b544812\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/cellEdits.js\":\"ac9b4f78f80b7387\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/columns.js\":\"a319f828192dd226\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/controller.js\":\"9edd4c21f601b7a2\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/convert.js\":\"72780f0157d76e90\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/dataExtension.js\":\"1179936d90f419c8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/index.js\":\"672dfb56e66ffd88\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/keys.js\":\"74eebfa25c6f7ae7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/model.js\":\"28d0eef6d5f2c3f7\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/navigation.js\":\"1c0b4fb2a3685b69\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/backfill.js\":\"526978a38af4acbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/format.js\":\"07811b2edc220564\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/parse.js\":\"3a31120a2b786d0b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/queryValue.js\":\"a28d9ee2da706172\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/query/source.js\":\"229fb95cf0b9066b\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/registry.js\":\"86fe139c33caa6e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowGutter.js\":\"f64d73744f00b0d5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/rowVerbs.js\":\"6d595250fe834cbc\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/schema.js\":\"819cca1728258952\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/tables/sort.js\":\"2b8847a4ba29c0e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/effect.js\":\"93eb2251e9ad226d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/index.js\":\"3fb534bbf7519ca5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/theme-toggle/theme.js\":\"cf6b07cb8b0d52a4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/actions.js\":\"b0bba6271ee3e945\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/dataExtension.js\":\"34e77fdacdf110ca\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/index.js\":\"2d9c053270b3f6c1\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/todo/schema.js\":\"06fd5596d349d8e0\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b664835bae1ae200\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/actions.js\":\"323c64e38f733931\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/defaultItems.js\":\"3a7c461492f18409\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/facet.js\":\"500d92b21211de78\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/holdRecognizer.js\":\"db6b2416bc661b10\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/touch-selection/index.js\":\"e5103d39e4bb6437\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/UpdateIndicator.js\":\"b09e19f1914e0d47\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/index.js\":\"d49070aa4629a230\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/update-indicator/loadTimes.js\":\"5183fff23859e60f\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoNotesRenderer.js\":\"fbd2abd5d27bea76\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoPlayerRenderer.js\":\"12ad2cde8a235818\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/VideoTimeStamp.js\":\"30e6aced37b7b0a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/actions.js\":\"8fde37aed4cf1376\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/index.js\":\"25661fb54dbf865e\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/markdown.js\":\"82799cacf8a4e8ea\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/notes.js\":\"521d35dd17debbef\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/registry.js\":\"90a1d3d2c6f7f2ff\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/remark-timestamps.js\":\"42056b65d5ca6fa4\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/video-player/view.js\":\"f1000a37ffd468b8\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/LinkHints.js\":\"2c5bfafdee3bbb5a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/index.js\":\"8a102366c82ef16d\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/model.js\":\"a1d4fd9724b327a5\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-link-hints/settings.js\":\"bc77582a1a76fc0a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/actions.js\":\"b3c932ed7e40b9d3\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/index.js\":\"e3995f79b5fab62a\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/vim-normal-mode/interactions.js\":\"c05dd3b753e38d63\",\"/knowledge-medium/pr-preview/pr-1850/src/plugins/workspace-header/index.js\":\"8d516b1e98503e3e\",\"/knowledge-medium/pr-preview/pr-1850/src/registerServiceWorker.js\":\"89791126e25a4800\",\"/knowledge-medium/pr-preview/pr-1850/src/requestPersistentStorage.js\":\"feda5736ff65ac5e\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authRequestDeadline.js\":\"09060ec380a49037\",\"/knowledge-medium/pr-preview/pr-1850/src/services/authStorage.js\":\"a959b5e7296c2c68\",\"/knowledge-medium/pr-preview/pr-1850/src/services/powersync.js\":\"ec3cdd4d8bec4c69\",\"/knowledge-medium/pr-preview/pr-1850/src/services/supabase.js\":\"7459d60d7160cd60\",\"/knowledge-medium/pr-preview/pr-1850/src/services/uploadErrorClassifier.js\":\"660fcf0c9e07091a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/ActiveContexts.js\":\"d1b06db33a865545\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/HotkeyReconciler.js\":\"0487b1780dfdbf20\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/WipeLocalDataDialog.js\":\"894d4e2dacf90b32\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionDispatch.js\":\"9bda0863696a1895\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/actionRefItems.js\":\"78a39c04344c0c44\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/applyKeybindingOverrides.js\":\"e9fb01b1b5d754c2\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockActions.js\":\"27755d3563aad7af\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/blockMergeGesture.js\":\"a02bf4b18eda69ae\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/canonicalizeChord.js\":\"32e3a96a93cba1da\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultContexts.js\":\"74f4484f5e0cff32\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/defaultShortcuts.js\":\"6e0aa4fcf8e9dfdd\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/effectiveActions.js\":\"900149a77f4c31f2\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureAction.js\":\"7b0a793b505698d8\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/gestureBinding.js\":\"22dd50e77fa866dc\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/holdRegistry.js\":\"cf48f96d94008654\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingConflicts.js\":\"b956b0f4f0c45e8d\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/keybindingOverrides.js\":\"129e439b17641e52\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/pointerAction.js\":\"9341485c3c787e23\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/resolve.js\":\"f1aa40dac5828fd4\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/runAction.js\":\"ee0e1e4a99b54e4e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/sequenceMatcher.js\":\"8afdfe40f626905e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/types.js\":\"999bd2e7cea3653e\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionContext.js\":\"1108aa3636abfe7a\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/useActionDiscovery.js\":\"fe236bd9c78fe523\",\"/knowledge-medium/pr-preview/pr-1850/src/shortcuts/utils.js\":\"08f9804202bbf398\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/bootStore.js\":\"209e3c9e6a81ab7c\",\"/knowledge-medium/pr-preview/pr-1850/src/sw/previewDatabases.js\":\"5eaedcdbd78e3df2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/byteTransform.js\":\"969f27758ffc77ec\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/attachmentCleaner.js\":\"04de8de91b7ac5fa\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/attachmentParts.js\":\"4a7d23ab192e72db\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleParts.js\":\"f1712ce051af7197\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/bundleRecord.js\":\"28fbdacb1981b640\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/manifest.js\":\"fd7270f3efcec0a7\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/takeBundle.js\":\"80eff307bfae8256\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/bundle/verifyBundle.js\":\"fcce5c9a6b875c91\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/cleaningStage.js\":\"3381b3059b52f902\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionKey.js\":\"b367d8a95822eb9c\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/conversionServer.js\":\"26115d42d7ece4cc\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flip.js\":\"8e445e245acaffed\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/flipAttempts.js\":\"339289b3890f9f71\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/pages.js\":\"1e3984fc1ae47b3d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/preflight.js\":\"99d30e4c7139724a\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/reseal.js\":\"5ec86b6ef44287d2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runConversion.js\":\"06cad08245410eaa\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/runLock.js\":\"7b4a6af3a5b23f54\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealing.js\":\"567f5e078039e5d9\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/sealingStage.js\":\"e96a4ba1f48082ba\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/stage.js\":\"4a94b9ad507df1e2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/conversion/verifyReseal.js\":\"809957ab65918747\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aad.js\":\"46be0c0ef54b6a38\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/aead.js\":\"716149da1a41d6d1\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base32.js\":\"651814d66d117230\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/base64url.js\":\"eb98ed765c3dc457\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/binaryEnvelope.js\":\"0d2e448119151ae4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/byteAead.js\":\"0465b2484a60ea27\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/canary.js\":\"f74eea751b25b449\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentHash.js\":\"83e653d059454f0b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/contentKey.js\":\"53fe38f6a05feeb6\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/derivedIdNamespace.js\":\"13498915ff75519e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/envelope.js\":\"3c4c5af80234cf58\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/hex.js\":\"aa1bf110a2181ec1\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/sha256Hex.js\":\"38aa9d2ddbacd73d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/crypto/workspaceKey.js\":\"677fd4d47683775e\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/conversionState.js\":\"849e98a9bdfe5df2\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5aaa202f7397ab33\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/pastedKey.js\":\"badbf8871a89d7d1\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"65cd563ca5cde79f\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/flows/upgradeWorkspacePin.js\":\"52e9bb1fdfdaad3d\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/keyStore.js\":\"091ea8356e16828b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/mintWorkspaceKey.js\":\"d865467c7786bfe3\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/modePin.js\":\"2199215bbadb35aa\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/openWorkspaceKeys.js\":\"78d0a54a2d48c2c4\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolveWorkspaceEntry.js\":\"b3d628cc6d3a83b1\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/resolver.js\":\"a5ab1acc5a74512b\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/keys/workspaceAccess.js\":\"20694a58d3714e23\",\"/knowledge-medium/pr-preview/pr-1850/src/sync/transform.js\":\"50ddbad8961868f3\",\"/knowledge-medium/pr-preview/pr-1850/src/themeBootDefaults.js\":\"3a92d407c4af8b06\",\"/knowledge-medium/pr-preview/pr-1850/src/types.js\":\"86e00d185a6f10f6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/ClientLocalSettings.js\":\"98c4be2d97204290\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/abortableSleep.js\":\"3d59b8f6926875aa\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/array.js\":\"41cf80a6795f8d0b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/backlinkAutocomplete.js\":\"82541f8d9af81416\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockCrumbs.js\":\"22d1ed100a750262\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/blockrefAutocomplete.js\":\"37a8e22911a79e8a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/cadencedIdleJob.js\":\"595a0d78a1e866c4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/callbackSet.js\":\"b719b4e87e2bc9af\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/clientId.js\":\"90e56a1c7469cab1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirror.js\":\"17ec65f6bd800d9d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/codemirrorCompletion.js\":\"5a6866b44a298c7d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/copy.js\":\"a5c656491f7cd54f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dailyPage.js\":\"c79354fa1ce52610\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensics.js\":\"2cb77209dbf9d54a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dbForensicsHooks.js\":\"44b5d4c36d001dd0\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/deleteBlockThroughUi.js\":\"14b36836c4634038\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dialogs.js\":\"d7400f7ee37021ba\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/dom.js\":\"995c737429ed755c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/downloadBlob.js\":\"4602ad5faeb631f5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/exportSqliteDb.js\":\"8233730b4c5e2594\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fileSystemAccess.js\":\"2d15d3ac33468ae1\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/flipSlide.js\":\"626ada7fd67c3d9b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fnv1a.js\":\"ca03e9a41d5c739b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/formatBytes.js\":\"ee40ae4c643366d4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/fuzzyRank.js\":\"eab7622c75c495dd\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idbKeyedStore.js\":\"c7ec3799c807f8d9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/idleCallbackPolyfill.js\":\"c536546eae43b7a8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardAwareScroll.js\":\"5b40a81c5a6f691a\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/keyboardViewport.js\":\"972ee96b27eea4e4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/lastWorkspace.js\":\"f53c760c4974732c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutColumns.js\":\"d0dabfb4b0132122\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionDom.js\":\"d7c8ec159196807d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/layoutSessionId.js\":\"3bb2b40e502c7a69\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkClickGestures.js\":\"79f148578e92daac\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/linkTargetAutocomplete.js\":\"3efe87d5614423fd\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbCorruption.js\":\"4a4709fd5d038363\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/localDbRecovery.js\":\"b289d5f4996e911f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/markdownParser.js\":\"3a7ca1d950279e1f\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/memoize.js\":\"5aac4ecb8b0e5156\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameFieldCommit.js\":\"0dddfcba3a432768\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/nameList.js\":\"439e3f72417283b3\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/navigation.js\":\"f181ba036b4aff48\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/omnilinerNamespace.js\":\"e00cf495a795fdd4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/opfsPageScan.js\":\"322d168d6c0a1cdf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelClearance.js\":\"46ac5e52310fc472\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelHistory.js\":\"8c2574e61a7a2935\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLanes.js\":\"5884a09a002a5f30\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelLayoutProjection.js\":\"a0a1c778d970febb\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelScrollAnchor.js\":\"bab0c0c268d82a76\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/panelUrlFlags.js\":\"b9f082ecdea2c2b8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/platform.js\":\"3fbab6e4a0f48f28\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/pluralize.js\":\"90ac2d53720695cb\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyCreation.js\":\"68df438a7927c314\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyNavigation.js\":\"a8db204c52fdb035\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/propertyValueContext.js\":\"12c2934bb9b4038e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/react.js\":\"8f30fcff6c52a47b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeDate.js\":\"efe25f8b3b6cef00\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/relativeTime.js\":\"440e59415ae6d5e9\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/renderScope.js\":\"a1900fd49d38f7bb\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/resolvedThenable.js\":\"62a8c3240da382d4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/routing.js\":\"7b14ffab5be5893b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/safeMode.js\":\"2708e48aa92a8fe5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/scheduleIdle.js\":\"180d970617e76b68\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/screenWakeLock.js\":\"7652f41d818f8eaa\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/selection.js\":\"61084395aea8301d\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/softKeyboardGrab.js\":\"a9b31de59bd73786\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/startupTimeline.js\":\"53f286a9b321461c\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/state.js\":\"f950d2af4e8a55a4\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/string.js\":\"e3123d2a97275179\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/surfaceZoom.js\":\"a10e7b2fab01cba5\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/time.js\":\"e7fb09edde0dffbe\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toast.js\":\"f254a77c0cf1c489\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/toggleStore.js\":\"f4b0135fd56ba7a8\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/untilStopped.js\":\"22bd845f879e6d70\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/userActivity.js\":\"3d11a1a6ec36b84e\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewTransition.js\":\"675a755bdabb1055\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/viewport.js\":\"becb7b3a6a61f56b\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/webLock.js\":\"f15b6eb4ecd4e144\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceRecovery.js\":\"99154bb4fbfd9caf\",\"/knowledge-medium/pr-preview/pr-1850/src/utils/workspaceSnapshotStore.js\":\"aad7e9a33e31898f\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-compiler-runtime.js\":\"40e097f95e7fe59e\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-client.js\":\"d300130d1aa3c13c\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server-edge.js\":\"33cca75ad0124c02\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-server.js\":\"7b92907b022ff7ea\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static-edge.js\":\"5acfac6eaac72558\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-static.js\":\"ecf3908e393cf882\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom-test-utils.js\":\"63125985bb5209f0\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-dom.js\":\"36d7b654e7bc8952\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react-jsx-runtime.js\":\"2bfb6ab27afb76a9\",\"/knowledge-medium/pr-preview/pr-1850/src/vendor/react.js\":\"89fbab1096dd6986\",\"/knowledge-medium/pr-preview/pr-1850/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1850/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
